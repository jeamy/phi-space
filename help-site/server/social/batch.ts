// Trusted, local worker path: Space semantics inside actual Durable commit boundaries.
import type { Context } from "phi-spaces/context";
import { core, FOREVER, NamedSpace, spaceDoc, type SpaceHost } from "phi-spaces";
import type { SwarmPost } from "./swarm.ts";

export type BatchHost = { host: SpaceHost; spaceId: string; ctx: Context };
export type BatchWrite = { type: string; fields: core.Fields; lease?: number };

/** Bound the worker's wait even when a custom provider ignores its own deadline. */
export async function boundedPreparation<T>(work: Promise<T>, ms = 20_000): Promise<T | null> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try { return await Promise.race([work, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); })]); }
	finally { clearTimeout(timer); }
}

/** Snapshot preflight avoids empty polling commits. The probe still arbitrates reservations. */
export async function reserveBatch(b: BatchHost, limit = 4) {
	const snapshot = await b.host.snapshot(NamedSpace, b.spaceId, b.ctx);
	const now = Date.now();
	if (!snapshot?.entries.some(e => e.types.includes("SwarmTask") && e.writtenUnder === null &&
		(e.expires === FOREVER || e.expires > now) &&
		(e.takenBy === null || (snapshot.txns[e.takenBy]?.expires ?? 0) <= now))) return null;
	return b.host.commit(async tx => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		const txn = core.createTxn(s, now, 45_000).id;
		const tasks: Array<{ fields: core.Fields }> = [];
		for (let i = 0; i < limit; i++) {
			const p = core.probe(s, now, { type: "SwarmTask" }, txn, true);
			if (p.status !== "found") break;
			tasks.push({ fields: core.plain(p.entry.fields) });
		}
		if (!tasks.length) { core.abortTxn(s, now, txn); return null; }
		return { txn, tasks };
	}, b.ctx);
}

/** Posts, linked history, counters, likes and follow-ups become visible together. */
export async function finishBatch(b: BatchHost, txn: string, posts: SwarmPost[], writes: BatchWrite[]) {
	return b.host.commit(async tx => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		const counts: Record<string, number> = Object.create(null);
		if (posts.length) {
			const p = core.probe(s, now, { type: "PostHistoryHead" }, txn, true);
			if (p.status !== "found") throw new Error("Post history head unavailable");
			const head = p.entry.fields;
			let next = String(head.next ?? ""), at = Number(head.at ?? 0);
			for (const post of posts) {
				post.at = at = Math.max(post.at, at + 1);
				next = core.write(s, now, { type: "PostHistoryNode", fields: { post: JSON.stringify(post), next } }, txn, FOREVER).id;
				core.write(s, now, { type: "Post", fields: { ...post } }, txn, FOREVER);
				counts[post.channel] = (counts[post.channel] ?? 0) + 1;
			}
			const last = posts.at(-1)!;
			core.write(s, now, { type: "PostHistoryHead", fields: { ...head, key: "head", next, at, lastAt: at, lastId: last.postId } }, txn, FOREVER);
			for (const channel of Object.keys(counts)) {
				const count = core.probe(s, now, { type: "ChannelCount", fields: { channel } }, txn, true);
				if (count.status === "locked") throw new Error("Channel counter reserved");
				counts[channel] += count.status === "found" ? Number(count.entry.fields.count ?? 0) : 0;
				core.write(s, now, { type: "ChannelCount", fields: { channel, count: counts[channel]! } }, txn, FOREVER);
			}
		}
		for (const w of writes) core.write(s, now, { type: w.type, fields: w.fields }, txn, w.lease ?? FOREVER);
		core.commitTxn(s, now, txn);
		return { ...counts };
	}, b.ctx);
}

export async function abortBatch(b: BatchHost, txn: string): Promise<void> {
	await b.host.commit(async tx => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		// An expired reservation may already have been reaped; never abort somebody else's work.
		if (s.txns[txn]) core.abortTxn(s, now, txn);
	}, b.ctx);
}
