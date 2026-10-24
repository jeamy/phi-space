// The one space every process of the codemode chat shares (docs/codemode-space-architektur.md): how a process connects
// to it, how long a room's entries live, and the Process entry each process keeps there while it runs.
import os from "node:os";
import { randomBytes } from "node:crypto";
import { FOREVER, RemoteSpace, socketTransport, type ListenTarget, type SpaceLike, type Taken, type Template } from "phi-spaces";

/** Where the space host listens and every other process connects, unless CODEMODE_LISTEN / CODEMODE_SPACE say else. */
export const DEFAULT_SPACE = "unix:/tmp/codemode-space.sock";

/** How long the entries of a room (blocks, contributions, verdicts, log lines) live: CODEMODE_TTL_HOURS, default 24;
 *  0 keeps them until their block is deleted. The room caps (blocks, contributions, lines) bound them either way. */
export function entryLeaseMs(raw = process.env.CODEMODE_TTL_HOURS): number {
	const hours = raw === undefined || raw.trim() === "" ? 24 : Number(raw);
	if (!Number.isFinite(hours) || hours < 0) throw new Error(`CODEMODE_TTL_HOURS must be a number of hours >= 0, got ${raw}`);
	return hours === 0 ? FOREVER : Math.max(60_000, Math.round(hours * 3600_000));
}

/** `tcp:host:port` or `unix:/path` (the same notation as SWARM_REMOTE / SWARM_LISTEN in the help system). */
export function parseTarget(spec: string): ListenTarget {
	if (spec.startsWith("tcp:")) {
		const [host, port] = spec.slice(4).split(":");
		if (!host || !Number.isSafeInteger(Number(port))) throw new Error(`tcp target expects host:port, got ${spec}`);
		return { host, port: Number(port) };
	}
	return { path: spec.replace(/^unix:/, "") };
}

/** A client of the shared space (CODEMODE_SPACE). One call may take `callTimeoutMs` (default 30 s); a blocking wait
 *  must stay below it, or it ends as "outcome unknown". `close()` frees the connection. */
export function connectSpace(spec = process.env.CODEMODE_SPACE || DEFAULT_SPACE, o: { callTimeoutMs?: number } = {}): { space: SpaceLike; close: () => void } {
	const callTimeoutMs = o.callTimeoutMs ?? Number(process.env.CODEMODE_SPACE_CALL_TIMEOUT ?? 30_000);
	const transport = socketTransport(parseTarget(spec), { connectTimeoutMs: Number(process.env.CODEMODE_SPACE_CONNECT_TIMEOUT ?? 5_000), requestTimeoutMs: callTimeoutMs + 5_000 });
	return { space: new RemoteSpace(transport, { callTimeoutMs, attempts: 3 }), close: () => transport.close() };
}

export type HostFacts = { name: string; cpu: string; cores: number; memGiB: number; platform: string; startedAt: number };
export function hostFacts(): HostFacts {
	const cpus = os.cpus();
	return {
		name: process.env.CODEMODE_HOST_NAME || os.hostname(),
		cpu: (cpus[0]?.model ?? "unknown CPU").replace(/\s+/g, " ").trim(),
		cores: os.availableParallelism?.() ?? cpus.length,
		memGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
		platform: `${os.type()} ${os.arch()}`,
		startedAt: Date.now(),
	};
}

/** The roles of the codemode chat's processes. */
export type ProcessRole = "space" | "web" | "judge" | "agents" | "model";
/** What a Process entry says: the role, the host it runs on, its pid. */
export type ProcessInfo = HostFacts & { procId: string; role: ProcessRole; pid: number };
const PROCESS_LEASE_MS = 30_000, PROCESS_BEAT_MS = 10_000;

/** Keeps a Process entry for this process in the space while it runs: its lease is renewed every 10 s (a process that
 *  dies drops out within 30 s); when the entry is gone (the space restarted) it is written again. */
export function announce(space: SpaceLike, role: ProcessRole): { stop: () => Promise<void> } {
	const info: ProcessInfo = { ...hostFacts(), procId: randomBytes(6).toString("hex"), role, pid: process.pid };
	let lease: string | null = null, stopped = false;
	const beat = async () => {
		try {
			if (lease) { try { await space.renew(lease, PROCESS_LEASE_MS); return; } catch { lease = null; } }
			lease = (await space.write({ type: "Process", fields: info as never }, null, PROCESS_LEASE_MS)).id;
		} catch { /* the space is not reachable now: the next beat tries again */ }
	};
	void beat();
	const timer = setInterval(() => { if (!stopped) void beat(); }, PROCESS_BEAT_MS);
	timer.unref?.();
	return {
		async stop() {
			stopped = true; clearInterval(timer);
			if (lease) await space.cancel(lease).catch(() => {});
		},
	};
}

/** How long a check waits on an entry another transaction holds right now. A held entry is invisible to a plain read
 *  (it may come back), so whether something still exists is asked with readIfExists and this timeout: it answers at
 *  once when there is none, and waits while one is held. Only a definite null means gone. */
export const HELD_WAIT_MS = 10_000;

/** How long an idle role waits for work in one request. The client polls a blocking call, so this is not bounded by
 *  the call timeout (CODEMODE_IDLE_WAIT_MS). */
export const IDLE_WAIT_MS = Math.max(1000, Number(process.env.CODEMODE_IDLE_WAIT_MS ?? 60_000));

/** Waits until an entry of `tmpl` is there, holding nothing: a read without a transaction. An idle role so costs one
 *  request (one claim, kept for a day) per wait, not a transaction begun, a take and an abort every few seconds
 *  (docs/umstellung-ohne-pi-durable.md, U2d). True when one is there to take; false when the wait ran out or `halt`
 *  ended it (a role that stops does not wait for the read; the space drops it at its deadline). */
export async function awaitWork(space: SpaceLike, tmpl: Template, halt?: AbortSignal, waitMs = IDLE_WAIT_MS): Promise<boolean> {
	if (halt?.aborted) return false;
	const read = space.read(tmpl, waitMs).then((e) => e !== null);
	if (!halt) return read;
	read.catch(() => {}); // after a halt nobody waits for it
	return Promise.race([read, new Promise<boolean>((r) => halt.addEventListener("abort", () => r(false), { once: true }))]);
}

/** An entry another transaction held for longer than the wait: it may still be there. */
export class StillHeld extends Error {}

/** readIfExists that tells a missing entry from a held one: null means gone. A null that came only when the wait ran
 *  out (a match stayed held all along) throws StillHeld instead; a holder that removes the entry ends the wait early. */
export function readExisting(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}, waitMs = HELD_WAIT_MS): Promise<Taken | null> {
	return existing(space, tmpl, o, waitMs, false);
}
/** takeIfExists with the same distinction (see readExisting). */
export function takeExisting(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}, waitMs = HELD_WAIT_MS): Promise<Taken | null> {
	return existing(space, tmpl, o, waitMs, true);
}
async function existing(space: SpaceLike, tmpl: Template, o: { txn?: string | null }, waitMs: number, take: boolean): Promise<Taken | null> {
	const t0 = Date.now();
	const e = await (take ? space.takeIfExists(tmpl, waitMs, o) : space.readIfExists(tmpl, waitMs, o));
	if (!e && Date.now() - t0 >= waitMs * 0.9) throw new StillHeld(`${String((tmpl as { type?: unknown }).type ?? "an entry")} stayed held for ${waitMs} ms`);
	return e;
}

/** Renews a transaction's lease while long work runs in it (a model call, a judgement), so a process that dies lets
 *  it lapse within `leaseMs`. */
export function keepAlive(space: SpaceLike, txn: string, leaseMs: number): () => void {
	const timer = setInterval(() => void space.renew(txn, leaseMs).catch(() => {}), Math.max(1000, Math.floor(leaseMs / 3)));
	timer.unref?.();
	return () => clearInterval(timer);
}
