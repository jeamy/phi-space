// Durable newest-first linked index. Nodes are committed with their Post; cursors visit bounded nodes.
import type { Context } from "@earendil-works/chord";
import { core, FOREVER, ResourceExhausted, spaceDoc, type SpaceHost, type SpaceLike } from "../../../src/index.ts";
import type { SwarmPost } from "./swarm.ts";
import { UnsupportedOperation } from "../../../src/remote.ts";

/** Stop a traversal on deadline/disconnect; an already sent read may finish, but no next read is issued. */
export async function historyRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation;
	let abort: () => void = () => {};
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => {
			abort = () => reject(signal.reason ?? new Error("History read aborted"));
			if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
		})]);
	} finally { signal.removeEventListener("abort", abort); }
}

export async function appendHistory(space: SpaceLike, post: SwarmPost, txn: string, normalizeTime = true): Promise<void> {
	let head = await space.take({ type: "PostHistoryHead" }, 5_000, { txn });
	if (!head) throw new Error("Post history not initialized");
	if (normalizeTime) post.at = Math.max(post.at, Number(head.fields.at ?? 0) + 1);
	const node = await space.write({ type: "PostHistoryNode", fields: { post: JSON.stringify(post), next: String(head.fields.next ?? "") } }, txn, FOREVER);
	await space.write({ type: "PostHistoryHead", fields: { ...head.fields, key: "head", next: node.id, at: post.at, lastAt: post.at, lastId: post.postId } }, txn, FOREVER);
}

/** Idempotently creates the history head. Awaited before workers so appendHistory never misses it. */
export async function ensureHistoryHead(space: SpaceLike, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	let head = await space.read({ type: "PostHistoryHead" }, 0);
	if (head) return;
	try {
		await space.write({ type: "PostHistoryHead", fields: { key: "head", next: "", ready: false, lastAt: -1, lastId: "" } }, null, FOREVER, { unique: ["key"] });
	} catch (e) {
		// A crashed migration can hold the head under a still-live transaction: an immediate
		// probe sees "no head", the unique write then hits the invisible entry. The abort
		// brings it back — probe until its lease lapses (60s) instead of killing init.
		const deadline = Date.now() + 90_000;
		while (!head && Date.now() < deadline) {
			signal?.throwIfAborted();
			await new Promise((r) => setTimeout(r, 2_000));
			head = await space.read({ type: "PostHistoryHead" }, 0);
		}
		if (!head) throw e;
	}
}

/**
 * Rebuilds the index for posts that predate it. With `bulk` each batch runs in ONE durable
 * commit (head take once, N node writes, head write once) instead of ~3 commits per post –
 * on a 30k-entry store that is the difference between minutes and hours.
 */
export async function initializeHistory(space: SpaceLike, bulk?: { host: SpaceHost; spaceId: string; ctx: Context; signal?: AbortSignal }): Promise<void> {
	bulk?.signal?.throwIfAborted();
	let head = await space.read({ type: "PostHistoryHead" }, 0);
	if (head && head.fields.ready !== false) return;
	if (!head) {
		await ensureHistoryHead(space, bulk?.signal);
		head = await space.read({ type: "PostHistoryHead" }, 0);
	}
	// One-time migration before workers start. Snapshot pages bound transport; only this migration sorts all historical posts.
	const posts: SwarmPost[] = [];
	let after: string | null = null, token: string | undefined;
	do {
		bulk?.signal?.throwIfAborted();
		const page = await space.readPage({ type: "Post" }, { after, token, maxBytes: 64_000 });
		posts.push(...page.items.map(e => e.fields as unknown as SwarmPost)); after = page.next; token = page.token;
	} while (after !== null);
	posts.sort((a, b) => a.at - b.at || a.postId.localeCompare(b.postId));
	const pending = posts.filter(p => p.at > Number(head!.fields.lastAt) || (p.at === Number(head!.fields.lastAt) && p.postId.localeCompare(String(head!.fields.lastId)) > 0));
	// Each appendHistory is take+write head plus the node: reserve cost exceeds the raw post
	// JSON several-fold and large posts (e.g. embedded image data) can overflow the commit
	// budget. On ResourceExhausted the batch shrinks and the same window is retried.
	let maxBatch = bulk ? 128 : 8;
	const retryDeadline = Date.now() + 120_000;
	for (let i = 0; i < pending.length;) {
		bulk?.signal?.throwIfAborted();
		const start = i;
		try {
			if (bulk) {
				await bulk.host.commit(async (tx) => {
					const now = Date.now();
					const s = await spaceDoc(tx, bulk.spaceId, now);
					const head = core.list(s, now, { type: "PostHistoryHead" }, null, 1)[0];
					if (!head) throw new Error("Post history not initialized");
					if (core.probe(s, now, { id: head.id }, null, true).status !== "found") throw new Error("Post history head is reserved");
					let next = String(head.fields.next ?? "");
					let last: SwarmPost | null = null;
					for (let n = 0; n < maxBatch && i < pending.length; n++, i++) {
						const post = pending[i]!;
						next = core.write(s, now, { type: "PostHistoryNode", fields: { post: JSON.stringify(post), next } }, null, FOREVER).id;
						last = post;
					}
					core.write(s, now, { type: "PostHistoryHead", fields: { ...head.fields, key: "head", next, at: last!.at, lastAt: last!.at, lastId: last!.postId } }, null, FOREVER);
				}, bulk.ctx);
				// Breathing room for the event loop: each bulk commit is a heavy synchronous
				// doc load/serialize on large spaces; yield keeps HTTP/WS responsive.
				await new Promise((r) => setTimeout(r, 25));
				continue;
			}
			const txn = await space.createTransaction(60_000);
			try {
				let bytes = 0, n = 0;
				while (i < pending.length && n < maxBatch && (n === 0 || bytes + JSON.stringify(pending[i]).length < 32_000)) {
					const post = pending[i]!; bytes += JSON.stringify(post).length;
					await appendHistory(space, post, txn.id, false);
					i++; n++;
				}
				await space.commit(txn.id);
			} catch (e) { await space.abort(txn.id).catch(() => {}); throw e; }
		} catch (e) {
			bulk?.signal?.throwIfAborted();
			i = start;
			if (e instanceof ResourceExhausted && maxBatch > 1) { maxBatch >>= 1; continue; }
			// Contention with live appends (the head is a hot entry): bounded retry, then fail.
			if (Date.now() < retryDeadline) { await new Promise((r) => setTimeout(r, 150)); continue; }
			throw e;
		}
	}
	bulk?.signal?.throwIfAborted();
	const txn = await space.createTransaction(10_000);
	try {
		const last = await space.take({ type: "PostHistoryHead" }, 5_000, { txn: txn.id });
		if (!last) throw new Error("Migration head missing");
		await space.write({ type: "PostHistoryHead", fields: { ...last.fields, ready: true } }, txn.id, FOREVER);
		await space.commit(txn.id);
	} catch (e) { await space.abort(txn.id).catch(() => {}); throw e; }
}

export type HistoryCandidate = { post: SwarmPost; cursor: string; next: string };
export async function historyPage(space: SpaceLike, input: { cursor?: string; beforeAt: number; beforeId: string; limit: number; channel?: string; handle?: string; ai?: boolean; signal?: AbortSignal }): Promise<{ candidates: HistoryCandidate[]; next: string }> {
	input.signal?.throwIfAborted();
	if (space.readChain) {
		try {
			let cursor = input.cursor, scanned = 0;
			const candidates: HistoryCandidate[] = [];
			do {
				input.signal?.throwIfAborted();
				const page = await historyRead(space.readChain({ type: "PostHistoryNode" }, {
					...(cursor === undefined ? { head: { type: "PostHistoryHead" } } : { cursor }),
					limit: Math.min(input.limit - candidates.length, 512 - scanned), maxBytes: 128 * 1024,
				}), input.signal);
				if (!page.ready) throw new Error("Shard history index unavailable or migration incomplete");
				for (const node of page.items) {
					const post = JSON.parse(String(node.fields.post)) as SwarmPost;
					scanned++;
					if (post.at > input.beforeAt || (post.at === input.beforeAt && post.postId.localeCompare(input.beforeId) >= 0)) continue;
					if (input.channel && post.channel !== input.channel || input.handle && post.handle !== input.handle || input.ai && !post.viaLlm) continue;
					candidates.push({ post, cursor: node.id, next: String(node.fields.next ?? "") });
				}
				cursor = page.next;
			} while (cursor && scanned < 512 && candidates.length < input.limit);
			return { candidates, next: cursor ?? "" };
		} catch (error) {
			if (!(error instanceof UnsupportedOperation)) throw error;
			// Older peers still use the sequential compatibility path.
		}
	}
	let cursor = input.cursor;
	if (cursor === undefined) {
		const head = await historyRead(space.read({ type: "PostHistoryHead" }, 0), input.signal);
		if (!head || head.fields.ready === false) throw new Error("Shard history index unavailable or migration incomplete");
		cursor = String(head.fields.next ?? "");
	}
	const candidates: HistoryCandidate[] = [];
	for (let scanned = 0; cursor && scanned < 512 && candidates.length < input.limit; scanned++) {
		input.signal?.throwIfAborted();
		const node: Awaited<ReturnType<SpaceLike["read"]>> = await historyRead(space.read({ type: "PostHistoryNode", id: cursor }, 0), input.signal);
		if (!node) throw new Error("History cursor no longer available");
		const post = JSON.parse(String(node.fields.post)) as SwarmPost;
		const current = cursor; cursor = String(node.fields.next ?? "");
		if (post.at > input.beforeAt || (post.at === input.beforeAt && post.postId.localeCompare(input.beforeId) >= 0)) continue;
		if (input.channel && post.channel !== input.channel || input.handle && post.handle !== input.handle || input.ai && !post.viaLlm) continue;
		candidates.push({ post, cursor: current, next: cursor });
	}
	return { candidates, next: cursor ?? "" };
}

export async function mergedHistory(spaces: SpaceLike[], input: { cursors?: string[]; beforeAt: number; beforeId: string; limit: number; channel?: string; handle?: string; ai?: boolean; signal?: AbortSignal }) {
	// A missing shard fails the page as a whole: callers retain all cursors and may retry safely.
	const stop = new AbortController();
	const signal = input.signal ? AbortSignal.any([input.signal, stop.signal]) : stop.signal;
	let pages: Awaited<ReturnType<typeof historyPage>>[];
	try { pages = await Promise.all(spaces.map((space, i) => historyPage(space, { ...input, signal, cursor: input.cursors?.[i] }))); }
	finally { stop.abort(); }
	const selected = pages.flatMap((p, shard) => p.candidates.map(c => ({ ...c, shard })))
		.sort((a, b) => b.post.at - a.post.at || b.post.postId.localeCompare(a.post.postId)).slice(0, input.limit);
	const consumed = new Set(selected.map(c => c.shard + ":" + c.cursor));
	const cursors = pages.map((p, shard) => p.candidates.find(c => !consumed.has(shard + ":" + c.cursor))?.cursor ?? p.next);
	return { posts: selected.map(c => c.post), cursors, complete: true, exhausted: cursors.every(c => c === "") };
}
