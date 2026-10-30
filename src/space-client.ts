// What a process needs to use a space served elsewhere (src/socket.ts): the address notation, a connected client, and
// the small helpers every project built on phi-spaces wrote for itself (codemode-chat, spaces-mmo, the help system):
// telling a missing entry from a held one, waiting for work without holding anything, keeping a transaction alive,
// and taking every match. The values that differ between projects (wait times, timeouts) are parameters.
import { RemoteSpace, UnsupportedOperation, type RemoteOptions, type Transport } from "./remote.ts";
import { socketTransport, type ListenTarget } from "./socket.ts";
import { NO_WAIT, type SpaceLike, type Taken } from "./client.ts";
import type { Template } from "./core.ts";

/** `unix:/path`, `tcp:host:port`, or a bare path (a unix socket). */
export function parseTarget(spec: string): ListenTarget {
	if (spec.startsWith("tcp:")) {
		const m = /^tcp:([^:]+):(\d+)$/.exec(spec);
		if (!m || !Number.isSafeInteger(Number(m[2]))) throw new Error(`a tcp address is tcp:host:port, not ${spec}`);
		return { host: m[1]!, port: Number(m[2]) };
	}
	const path = spec.replace(/^unix:/, "");
	if (!path) throw new Error(`an address is unix:/path or tcp:host:port, not ${spec}`);
	return { path };
}

export type ConnectOptions = { callTimeoutMs?: number; connectTimeoutMs?: number; attempts?: number } & Omit<RemoteOptions, "callTimeoutMs" | "attempts">;

/** A client of the space at `spec` (parseTarget). One call may take `callTimeoutMs` (default 30 s); a blocking wait must
 *  stay below it, or it ends as "outcome unknown". `close()` frees the connection. */
export function connectSpace(spec: string, o: ConnectOptions = {}): { space: RemoteSpace; transport: Transport; close: () => void } {
	const { callTimeoutMs = 30_000, connectTimeoutMs = 5_000, attempts = 3, ...rest } = o;
	const transport = socketTransport(parseTarget(spec), { connectTimeoutMs, requestTimeoutMs: callTimeoutMs + 5_000 });
	return { space: new RemoteSpace(transport, { ...rest, callTimeoutMs, attempts }), transport, close: () => transport.close() };
}

/** A check ran out while a match stayed held by another transaction: the entry is not gone, it may come back. */
export class StillHeld extends Error {}

/** readIfExists that tells a missing entry from a held one: null means gone. A null that came only because matches
 *  stayed held for `waitMs` throws StillHeld instead; a holder that removes the entry ends the wait early. Without
 *  `probe` (a space older than the read.locked feature) a null after the wait counts as gone. */
export function readExisting(space: SpaceLike, tmpl: Template, waitMs: number, o: { txn?: string | null } = {}): Promise<Taken | null> {
	return existing(space, tmpl, waitMs, o, false);
}
/** takeIfExists with the same distinction (see readExisting). */
export function takeExisting(space: SpaceLike, tmpl: Template, waitMs: number, o: { txn?: string | null } = {}): Promise<Taken | null> {
	return existing(space, tmpl, waitMs, o, true);
}
async function existing(space: SpaceLike, tmpl: Template, waitMs: number, o: { txn?: string | null }, take: boolean): Promise<Taken | null> {
	const p = (space.probe ? await space.probe(tmpl, waitMs, { txn: o.txn ?? null, take }).catch((e) => { if (e instanceof UnsupportedOperation) return null; throw e; }) : null)
		?? { entry: await (take ? space.takeIfExists(tmpl, waitMs, o) : space.readIfExists(tmpl, waitMs, o)), locked: false };
	if (!p.entry && p.locked) throw new StillHeld(`${String((tmpl as { type?: unknown } | null)?.type ?? "an entry")} stayed held for ${waitMs} ms`);
	return p.entry;
}

/** The first entry `tmpl` matches as the space stands now, or null: a snapshot read (readAll), which holds nothing and
 *  leaves no claim behind, unlike readIfExists. */
export async function peek(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}): Promise<Taken | null> {
	return (await space.readAll(tmpl, { limit: 1, ...(o.txn ? { txn: o.txn } : {}) }))[0] ?? null;
}

/** Takes every entry `tmpl` matches now, one take each, and says how many. Held matches are left alone. */
export async function takeAll(space: SpaceLike, tmpl: Template, o: { txn?: string | null } = {}): Promise<number> {
	let n = 0;
	while (await space.take(tmpl, NO_WAIT, o.txn ? { txn: o.txn } : {})) n++;
	return n;
}

/** Waits until an entry of `tmpl` is there, holding nothing: one blocking read without a transaction (an idle role so
 *  costs one request per wait). True when one is there; false when the wait ran out or `halt` ended it (the read is
 *  then left to the space, which drops it at its deadline). */
export async function awaitWork(space: SpaceLike, tmpl: Template, waitMs: number, halt?: AbortSignal): Promise<boolean> {
	if (halt?.aborted) return false;
	const read = space.read(tmpl, waitMs).then((e) => e !== null);
	if (!halt) return read;
	read.catch(() => {}); // after a halt nobody waits for it
	return Promise.race([read, new Promise<boolean>((r) => halt.addEventListener("abort", () => r(false), { once: true }))]);
}

/** Renews a transaction's (or any lease's) lease every third of `leaseMs` while long work runs in it, so a process that
 *  dies lets it lapse within `leaseMs`. Returns the stop function. */
export function keepAlive(space: SpaceLike, lease: string, leaseMs: number): () => void {
	const timer = setInterval(() => void space.renew(lease, leaseMs).catch(() => {}), Math.max(1000, Math.floor(leaseMs / 3)));
	timer.unref?.();
	return () => clearInterval(timer);
}

/** The first `max` UTF-16 units of `text`, without half an emoji at the cut (the service would store U+FFFD for it). */
export const cutText = (text: string, max: number): string => {
	const cut = text.slice(0, max), last = cut.charCodeAt(cut.length - 1);
	return last >= 0xd800 && last <= 0xdbff && text.length > max ? cut.slice(0, -1) : cut;
};
