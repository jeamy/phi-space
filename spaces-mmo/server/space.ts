// How the processes of spaces-mmo reach their spaces (docs/architektur.md): the world space, which every process
// shares, and the accounts space with the credentials and web sessions, which only the web process knows the address
// of. Both are served by the space process (space-host.ts), each from its own store on its own socket.
import os from "node:os";
import { randomBytes } from "node:crypto";
import { ANY, awaitWork as awaitWorkFor, connectSpace as connect, readExisting as readHeld, type BatchOp, type BatchResult, type SpaceLike, type Taken, type Template } from "phi-spaces";

export { parseTarget, peek, StillHeld } from "phi-spaces";

/** Where the space host serves the world and every process connects (SPACES_MMO_SPACE). */
export const DEFAULT_SPACE = "unix:/tmp/spaces-mmo-world.sock";
/** Where the space host serves the accounts space; only the web process connects (SPACES_MMO_ACCOUNTS). */
export const DEFAULT_ACCOUNTS = "unix:/tmp/spaces-mmo-accounts.sock";

/** A client of one space. A call may take `callTimeoutMs` (default 30 s); a blocking wait must stay below it. */
export function connectSpace(spec: string, o: { callTimeoutMs?: number } = {}): { space: SpaceLike; close: () => void } {
	const { space, close } = connect(spec, { callTimeoutMs: o.callTimeoutMs ?? Number(process.env.SPACES_MMO_CALL_TIMEOUT ?? 30_000) });
	return { space: process.env.SPACES_MMO_TRACE ? traced(space) : space, close };
}

/** A space that takes several steps in one call (RemoteSpace.batch); SPACES_MMO_BATCH=0 turns the use off. */
export type Batching = SpaceLike & { batch(ops: readonly BatchOp[]): Promise<BatchResult[]> };
export const batching = (space: SpaceLike): space is Batching =>
	process.env.SPACES_MMO_BATCH !== "0" && typeof (space as Partial<Batching>).batch === "function";

/**
 * The space as one command's transaction `txn` sees it. Its plain writes under `txn` (no `unique`: a taken cell must be
 * refused at once) wait in a buffer and go with the commit in one batch (`commit`), instead of one call and one commit
 * each; any other call that names `txn` sends them first, so it sees them. Reads of the snapshot (`readAll` and
 * `count` without `txn`) never see a transaction's writes anyway and go as they are. A buffered write answers a lease
 * without an id: the engine does not use the ids of what it writes in a command.
 */
export function bufferedTxn(space: Batching, txn: string): { space: SpaceLike; commit(more?: BatchOp[]): Promise<void> } {
	const waiting: BatchOp[] = [];
	const flush = async () => { if (waiting.length) await space.batch(waiting.splice(0)); };
	const plainRead = (prop: string | symbol, args: unknown[]) =>
		(prop === "readAll" && !(args[1] as { txn?: unknown } | undefined)?.txn) || (prop === "count" && (args[1] ?? null) === null);
	const view = new Proxy(space, {
		get(target, prop, receiver) {
			const v = Reflect.get(target, prop, receiver);
			if (prop === "write") return async (entry: never, t: string | null = null, lease: number = ANY, o: { unique?: string[]; request?: unknown; transient?: boolean } = {}) => {
				if (t === txn && !o.unique && !o.request) { waiting.push({ op: "write", entry, txn, lease, ...(o.transient ? { transient: true } : {}) }); return { id: "", expires: lease }; }
				await flush();
				return target.write(entry, t, lease, o as never);
			};
			if (typeof v !== "function") return v;
			return async (...args: unknown[]) => { if (!plainRead(prop, args)) await flush(); return v.apply(target, args); };
		},
	});
	return { space: view, async commit(more = []) { await space.batch([...waiting.splice(0), ...more, { op: "commit", txn }]); } };
}

/** SPACES_MMO_TRACE=1: every ten seconds this process logs how many calls it made to the space, per method and the
 *  template's type, with their time (to find who keeps the space busy). */
function traced(space: SpaceLike): SpaceLike {
	const calls = new Map<string, { n: number; ms: number }>();
	const who = (process.argv[1] ?? "").split("/").pop();
	setInterval(() => {
		const top = [...calls].sort((a, b) => b[1].n - a[1].n).slice(0, Number(process.env.SPACES_MMO_TRACE_TOP) || 12).map(([k, v]) => `${k}:${v.n}/${Math.round(v.ms / Math.max(1, v.n))}ms`);
		console.error(`[trace] ${who} ${[...calls.values()].reduce((s, v) => s + v.n, 0)} calls in 10 s: ${top.join(" ")}`);
		calls.clear();
	}, 10_000).unref();
	return new Proxy(space, {
		get(target, prop, receiver) {
			const v = Reflect.get(target, prop, receiver);
			if (typeof v !== "function") return v;
			return (...args: unknown[]) => {
				const t = Date.now(), k = `${String(prop)}(${String((args[0] as { type?: unknown } | undefined)?.type ?? "")})`;
				const done = () => { const c = calls.get(k) ?? { n: 0, ms: 0 }; c.n++; c.ms += Date.now() - t; calls.set(k, c); };
				const r = v.apply(target, args);
				if (r && typeof (r as Promise<unknown>).then === "function") (r as Promise<unknown>).then(done, done);
				else done();
				return r;
			};
		},
	});
}

/** How long a check waits on an entry another transaction holds right now (see readExisting). */
export const HELD_WAIT_MS = 2_000;

/** readIfExists that tells a missing entry from a held one (phi-spaces readExisting): null means gone; a match held for
 *  all of `waitMs` (e.g. an account in the middle of its registration) throws StillHeld. */
export function readExisting(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}, waitMs = HELD_WAIT_MS): Promise<Taken | null> {
	return readHeld(space, tmpl, waitMs, o);
}

/** Waits until an entry of `tmpl` is there, holding nothing (one blocking read). False when the wait ran out or `halt`
 *  ended it. */
export function awaitWork(space: SpaceLike, tmpl: Template, halt: AbortSignal, waitMs = 20_000): Promise<boolean> {
	return awaitWorkFor(space, tmpl, waitMs, halt);
}

/** A positive number of milliseconds from the environment, else the default. */
export function envMs(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}

/** The machine a process runs on, as the system bar at the bottom of the page shows it (like codemode-chat). */
export type HostFacts = { name: string; cpu: string; cores: number; memGiB: number; platform: string; startedAt: number };
export function hostFacts(): HostFacts {
	const cpus = os.cpus();
	return {
		name: process.env.SPACES_MMO_HOST_NAME || os.hostname(),
		cpu: (cpus[0]?.model ?? "unknown CPU").replace(/\s+/g, " ").trim(),
		cores: os.availableParallelism?.() ?? cpus.length,
		memGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
		platform: `${os.type()} ${os.arch()}`,
		startedAt: Date.now(),
	};
}

/** The roles of the game's processes (launch.ts). */
export type ProcessRole = "space" | "world" | "npc" | "model" | "web";
/** What a Process entry in the world space says: the role, the host it runs on, its pid. */
export type ProcessInfo = HostFacts & { procId: string; role: ProcessRole; pid: number };
const PROCESS_LEASE_MS = 30_000, PROCESS_BEAT_MS = 10_000;

/** Keeps a Process entry for this process in the world space while it runs: its lease is renewed every 10 s (a process
 *  that dies drops out within 30 s); when the entry is gone (the space restarted) it is written again. */
export function announce(space: Pick<SpaceLike, "write" | "renew" | "cancel">, role: ProcessRole): { stop: () => Promise<void> } {
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

const ROLE_ORDER: ProcessRole[] = ["space", "world", "npc", "model", "web"];
export type SystemHost = { name: string; roles: ProcessRole[]; host: ProcessInfo };

/** The hosts the game runs on, from the Process entries: one per host name, its roles in launch order. A snapshot read
 *  (readAll), which holds nothing and leaves no claim. */
export async function systemInfo(space: SpaceLike): Promise<{ hosts: SystemHost[]; entries: number }> {
	const procs = (await space.readAll({ type: "Process" }, { limit: 200 })).map((e) => e.fields as unknown as ProcessInfo);
	const hosts = new Map<string, { host: ProcessInfo; roles: Set<ProcessRole> }>();
	for (const p of procs.sort((a, b) => a.startedAt - b.startedAt)) {
		const h = hosts.get(p.name) ?? { host: p, roles: new Set<ProcessRole>() };
		h.roles.add(p.role); hosts.set(p.name, h);
	}
	return {
		hosts: [...hosts.values()].map(({ host, roles }) => ({ name: host.name, roles: ROLE_ORDER.filter((r) => roles.has(r)), host })),
		entries: await space.count(null),
	};
}
