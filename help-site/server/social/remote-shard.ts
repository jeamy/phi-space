// The swarm hub's second shard on another host (SWARM_REMOTE, e.g. nano): its space, whether it is reachable, the
// revision the hub follows its changes from, and its channel totals. Taken out of SocialSwarmHub (swarm.ts), which
// decides what the shard's posts mean (indexes, reply counts, the broadcast); this class only talks to the shard.
import type { SpaceLike } from "phi-spaces";
import { RevisionAhead, SnapshotExpired } from "phi-spaces/core";
import type { SwarmPost } from "./swarm.ts";

/** Posts kept when the hub (re)joins the shard (the newest): the newest 300 of them go into the index, all count replies. */
const SYNC_POSTS = 4_000;
/** A shard holds at most its entry cap, so this covers every like of a shard with the default cap. */
const SYNC_LIKES = 20_000;
/** A page of the join read: frames stay bounded even when posts carry large bodies. */
const SYNC_PAGE_BYTES = 256 * 1024;
/** How long a lost shard is left alone before the next try. */
const DOWN_MS = 5_000;

type Batches = Awaited<ReturnType<SpaceLike["changes"]>>["batches"];

export class RemoteShard {
	readonly space: SpaceLike;
	/** Post ids of this shard start with it, so routing a post needs no lookup. */
	readonly prefix: string;
	readonly #label: string | null;
	readonly #warn: (msg: string, err: unknown) => void;
	/** The revision the hub has merged the shard's changes up to; 0: not joined yet (sync() first). */
	rev = 0;
	/** ChannelCount entries of the shard (its per-channel post totals). */
	readonly channelTotals = new Map<string, number>();
	#downUntil = 0;
	#connected = false;
	#syncing = false;

	constructor(space: SpaceLike, prefix: string, label: string | null, warn: (msg: string, err: unknown) => void) {
		this.space = space; this.prefix = prefix; this.#label = label; this.#warn = warn;
	}

	owns(postId: string): boolean { return postId.startsWith(this.prefix); }

	/** Lost a moment ago: callers skip it until the back-off is over. */
	down(): boolean { return Date.now() < this.#downUntil; }

	/** The shard answered: log the connect once per up-transition. */
	markUp(detail?: string): void {
		this.#downUntil = 0;
		if (this.#connected) return;
		this.#connected = true;
		console.log(`[swarm] remote shard connected${this.#label ? ` ${this.#label}` : ""}${detail ? ` — ${detail}` : ""}`);
	}

	/** The shard failed: back off and log the loss once per down-transition. */
	markDown(): void {
		this.#downUntil = Date.now() + DOWN_MS;
		if (!this.#connected) return;
		this.#connected = false;
		console.warn(`[swarm] remote shard lost${this.#label ? ` ${this.#label}` : ""} — retrying`);
	}

	/** A call with a hard limit on its whole time. RemoteSpace bounds each attempt (callTimeoutMs) but retries; a dead or
	 *  half-open shard would hold a query for all attempts and their back-off, so the hub's calls are capped here. */
	async call<T>(p: Promise<T>, ms = 15_000): Promise<T> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([p, new Promise<never>((_r, rej) => { timer = setTimeout(() => rej(new Error(`remote shard timeout after ${ms}ms`)), ms); })]);
		} finally {
			clearTimeout(timer);
		}
	}

	/** readAll on the shard, capped in time; a failure marks it down. */
	async readAll(tmpl: Parameters<SpaceLike["readAll"]>[0], opts?: { limit?: number }) {
		try {
			const out = await this.call(this.space.readAll(tmpl, opts), 20_000);
			this.markUp();
			return out;
		} catch (e) {
			this.markDown();
			this.#warn("remote readAll failed", e);
			throw e;
		}
	}

	/** Joins the shard: its newest posts (the last SYNC_POSTS in entry order, oldest first to `onPosts`) and its channel
	 *  totals. Pages come oldest first, so all of them are read (each of bounded size) and only the tail is kept. `rev`
	 *  becomes the revision of that snapshot, so the changes after it complete the picture. */
	async sync(onPosts: (posts: SwarmPost[], likes: Array<{ postId: string; agentId: string }>) => void): Promise<void> {
		if (this.#syncing) return;
		this.#syncing = true;
		try {
			const posts: SwarmPost[] = [];
			let after: string | null = null, token: string | undefined, rev: number | null = null;
			do {
				const page: Awaited<ReturnType<SpaceLike["readPage"]>> = await this.space.readPage({ type: "Post" }, { after, token, maxBytes: SYNC_PAGE_BYTES });
				rev ??= page.rev;
				for (const e of page.items) posts.push(e.fields as unknown as SwarmPost);
				if (posts.length > SYNC_POSTS) posts.splice(0, posts.length - SYNC_POSTS);
				after = page.next; token = page.token;
			} while (after !== null);
			// the totals after the snapshot: a ChannelCount that changes later comes again with the changes
			for (const e of await this.space.readAll({ type: "ChannelCount" }, { limit: 500 }).catch(() => [])) {
				const f = e.fields as { channel?: string; count?: number };
				if (f.channel) this.channelTotals.set(f.channel, Number(f.count) || 0);
			}
			const likes = (await this.space.readAll({ type: "Like" }, { limit: SYNC_LIKES }).catch(() => []))
				.filter((e) => !e.fields.dedup).map((e) => ({ postId: String(e.fields.postId), agentId: String(e.fields.agentId) }));
			onPosts(posts.sort((a, b) => a.at - b.at), likes);
			this.rev = rev;
			this.markUp(`${posts.length} posts, rev ${this.rev}`);
		} catch (e) {
			this.markDown();
			this.#warn("remote shard sync failed", e);
		} finally {
			this.#syncing = false;
		}
	}

	/** The shard's committed batches since `rev` (and `rev` moves past them); null when it failed. A lost history (the
	 *  shard restarted or dropped it) calls `onGone`, which joins again. */
	async pull(onGone: () => void): Promise<Batches | null> {
		try {
			const page = await this.space.changes(this.rev, { maxBytes: 300_000 });
			this.rev = page.next;
			this.markUp();
			for (const b of page.batches) for (const op of b.ops) if (op.op === "put" && op.type === "ChannelCount") this.channelTotals.set(String(op.fields.channel), Number(op.fields.count) || 0);
			return page.batches;
		} catch (e) {
			this.markDown();
			if (e instanceof SnapshotExpired || e instanceof RevisionAhead) onGone();
			return null;
		}
	}
}
