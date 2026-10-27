// How the processes of spaces-mmo reach their spaces (docs/architektur.md): the world space, which every process
// shares, and the accounts space with the credentials and web sessions, which only the web process knows the address
// of. Both are served by the space process (space-host.ts), each from its own store on its own socket.
import { RemoteSpace, socketTransport, type ListenTarget, type SpaceLike, type Taken, type Template } from "phi-spaces";

/** Where the space host serves the world and every process connects (SPACES_MMO_SPACE). */
export const DEFAULT_SPACE = "unix:/tmp/spaces-mmo-world.sock";
/** Where the space host serves the accounts space; only the web process connects (SPACES_MMO_ACCOUNTS). */
export const DEFAULT_ACCOUNTS = "unix:/tmp/spaces-mmo-accounts.sock";

/** `tcp:host:port` or `unix:/path`, the notation of codemode-chat. */
export function parseTarget(spec: string): ListenTarget {
	if (spec.startsWith("tcp:")) {
		const [host, port] = spec.slice(4).split(":");
		if (!host || !Number.isSafeInteger(Number(port))) throw new Error(`tcp target expects host:port, got ${spec}`);
		return { host, port: Number(port) };
	}
	return { path: spec.replace(/^unix:/, "") };
}

/** A client of one space. A call may take `callTimeoutMs` (default 30 s); a blocking wait must stay below it. */
export function connectSpace(spec: string, o: { callTimeoutMs?: number } = {}): { space: SpaceLike; close: () => void } {
	const callTimeoutMs = o.callTimeoutMs ?? Number(process.env.SPACES_MMO_CALL_TIMEOUT ?? 30_000);
	const transport = socketTransport(parseTarget(spec), { connectTimeoutMs: 5_000, requestTimeoutMs: callTimeoutMs + 5_000 });
	const space = new RemoteSpace(transport, { callTimeoutMs, attempts: 3 });
	return { space: process.env.SPACES_MMO_TRACE ? traced(space) : space, close: () => transport.close() };
}

/** SPACES_MMO_TRACE=1: every ten seconds this process logs how many calls it made to the space, per method and the
 *  template's type, with their time (to find who keeps the space busy). */
function traced(space: SpaceLike): SpaceLike {
	const calls = new Map<string, { n: number; ms: number }>();
	const who = (process.argv[1] ?? "").split("/").pop();
	setInterval(() => {
		const top = [...calls].sort((a, b) => b[1].n - a[1].n).slice(0, 12).map(([k, v]) => `${k}:${v.n}/${Math.round(v.ms / Math.max(1, v.n))}ms`);
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

/** The first entry `tmpl` matches as the space stands now, or null: what readIfExists with NO_WAIT answers, as a snapshot
 *  read (readAll). A readIfExists is a request with a claim the space commits; a step reads several such entries. */
export async function peek(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}): Promise<Taken | null> {
	return (await space.readAll(tmpl, { limit: 1, ...(o.txn ? { txn: o.txn } : {}) }))[0] ?? null;
}

/** How long a check waits on an entry another transaction holds right now (see readExisting). */
export const HELD_WAIT_MS = 2_000;

/** An entry another transaction held for longer than the wait: it may still be there. */
export class StillHeld extends Error {}

/** readIfExists that tells a missing entry from a held one: null means gone; a null that came only when the wait ran
 *  out (a match stayed held all along, e.g. an account in the middle of its registration) throws StillHeld. */
export async function readExisting(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}, waitMs = HELD_WAIT_MS): Promise<Taken | null> {
	const t0 = Date.now();
	const e = await space.readIfExists(tmpl, waitMs, o);
	if (!e && Date.now() - t0 >= waitMs * 0.9) throw new StillHeld(`${String((tmpl as { type?: unknown }).type ?? "an entry")} stayed held for ${waitMs} ms`);
	return e;
}

/** Waits until an entry of `tmpl` is there, holding nothing (one blocking read). False when the wait ran out or `halt`
 *  ended it. */
export async function awaitWork(space: SpaceLike, tmpl: Template, halt: AbortSignal, waitMs = 20_000): Promise<boolean> {
	if (halt.aborted) return false;
	const read = space.read(tmpl, waitMs).then((e) => e !== null);
	read.catch(() => {});
	return Promise.race([read, new Promise<boolean>((r) => halt.addEventListener("abort", () => r(false), { once: true }))]);
}

/** A positive number of milliseconds from the environment, else the default. */
export function envMs(name: string, fallback: number): number {
	const v = Number(process.env[name]);
	return Number.isFinite(v) && v > 0 ? v : fallback;
}
