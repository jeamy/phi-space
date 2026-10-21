// The one space every process of the codemode chat shares (docs/codemode-space-architektur.md): how a process connects
// to it, how long a room's entries live, and the Process entry each process keeps there while it runs.
import os from "node:os";
import { randomBytes } from "node:crypto";
import { FOREVER, RemoteSpace, socketTransport, type ListenTarget, type SpaceLike } from "../../src/index.ts";

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

/** Renews a transaction's lease while long work runs in it (a model call, a judgement), so a process that dies lets
 *  it lapse within `leaseMs`. */
export function keepAlive(space: SpaceLike, txn: string, leaseMs: number): () => void {
	const timer = setInterval(() => void space.renew(txn, leaseMs).catch(() => {}), Math.max(1000, Math.floor(leaseMs / 3)));
	timer.unref?.();
	return () => clearInterval(timer);
}
