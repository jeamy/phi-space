// The worker's batch: reserve up to N tasks under one transaction, then publish the prepared results under it. Every
// step is a call of the Space, so the same code runs over a socket (a separate space process, TypeScript or Rust) and
// in-process. Visibility stays atomic: nothing of a batch is seen before its commit.
import type { BatchOp, BatchResult, SpaceLike } from "phi-spaces";
import { core, FOREVER } from "phi-spaces";
import type { SwarmPost } from "./swarm.ts";

/** A Space that also takes several steps in one call (PhiSpaces and RemoteSpace both do). */
export type SwarmSpace = SpaceLike & { batch(ops: readonly BatchOp[]): Promise<BatchResult[]> };
export type BatchWrite = { type: string; fields: core.Fields; lease?: number };

/** Bound the worker's wait even when a custom provider ignores its own deadline. */
export async function boundedPreparation<T>(work: Promise<T>, ms = 20_000): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
	finally { clearTimeout(timer); }
}

const entryOf = (r: BatchResult | undefined) => (r && typeof r === "object" && "entry" in r ? r.entry : null);

/**
 * A read first: an empty poll costs no transaction and leaves no request claim. Then one call opens the transaction and
 * takes up to `limit` tasks under it; a transaction that took none is given back.
 */
export async function reserveBatch(space: SwarmSpace, limit = 4): Promise<{ txn: string; tasks: Array<{ fields: core.Fields }> } | null> {
	if (!(await space.readIfExists({ type: "SwarmTask" }, 0))) return null;
	const steps: BatchOp[] = [{ op: "begin", lease: 45_000 }];
	for (let i = 0; i < limit; i++) steps.push({ op: "take", template: { type: "SwarmTask" }, txn: "$" });
	const [begun, ...taken] = await space.batch(steps);
	const txn = (begun as core.Lease).id;
	const tasks = taken.map(entryOf).filter((e): e is NonNullable<typeof e> => e !== null).map(e => ({ fields: e.fields }));
	if (!tasks.length) { await abortBatch(space, txn); return null; }
	return { txn, tasks };
}

/**
 * Posts, linked history, counters, likes and follow-ups become visible together, at the commit. The history head is
 * taken first (every writer of the head and the counters takes the head first, so they never wait on each other in a
 * circle); each node names the one written before it, so the nodes are written one by one, the rest in two calls.
 */
export async function finishBatch(space: SwarmSpace, txn: string, posts: SwarmPost[], writes: BatchWrite[]): Promise<Record<string, number>> {
	const counts: Record<string, number> = Object.create(null);
	const tail: BatchOp[] = [];
	if (posts.length) {
		const head = await space.take({ type: "PostHistoryHead" }, 10_000, { txn });
		if (!head) throw new Error("Post history head unavailable");
		let next = String(head.fields.next ?? ""), at = Number(head.fields.at ?? 0);
		for (const post of posts) {
			post.at = at = Math.max(post.at, at + 1);
			next = (await space.write({ type: "PostHistoryNode", fields: { post: JSON.stringify(post), next } }, txn, FOREVER)).id;
			tail.push({ op: "write", entry: { type: "Post", fields: { ...post } }, txn, lease: FOREVER });
			counts[post.channel] = (counts[post.channel] ?? 0) + 1;
		}
		const last = posts.at(-1)!;
		tail.push({ op: "write", entry: { type: "PostHistoryHead", fields: { ...head.fields, key: "head", next, at, lastAt: at, lastId: last.postId } }, txn, lease: FOREVER });
		const channels = Object.keys(counts);
		const current = await space.batch(channels.map((channel): BatchOp => ({ op: "take", template: { type: "ChannelCount", fields: { channel } }, txn })));
		channels.forEach((channel, i) => {
			const r = current[i] as { entry: { fields: core.Fields } | null; locked?: true };
			if (r?.locked) throw new Error("Channel counter reserved");
			counts[channel] += r?.entry ? Number(r.entry.fields.count ?? 0) : 0;
			tail.push({ op: "write", entry: { type: "ChannelCount", fields: { channel, count: counts[channel]! } }, txn, lease: FOREVER });
		});
	}
	for (const w of writes) tail.push({ op: "write", entry: { type: w.type, fields: w.fields }, txn, lease: w.lease ?? FOREVER });
	tail.push({ op: "commit", txn });
	await space.batch(tail);
	return { ...counts };
}

/** An expired reservation may already have been reaped: the abort of a transaction that is gone is no error. */
export async function abortBatch(space: SwarmSpace, txn: string): Promise<void> {
	await space.abort(txn).catch((e) => { if (!(e instanceof core.TransactionError || e instanceof core.UnknownLeaseError)) throw e; });
}
