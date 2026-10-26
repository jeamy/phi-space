// Retention for the test systems (local machine, big + nano): every shard keeps at most `cap` entries in its
// database. Commit and scan costs are O(live entries) per Space, so the limit is per Space/database. Above the cap the
// oldest posts go together with their history nodes and likes (ChannelCount totals stay lifetime counters).
import os from "node:os";
import { core, FOREVER, NamedSpace, spaceDoc } from "phi-spaces";
import type { BatchHost } from "./batch.ts";

export const DEFAULT_MAX_ENTRIES = 20_000;
/** How long the swarm spaces keep the result of a finished request (core.Limits.claimResultMs). */
export const SWARM_CLAIM_RESULT_MS = 15 * 60_000;
const MIN_KEEP_POSTS = 20;
/** The author id of the operator's own posts (SwarmTask kind user): never purged, nor are the replies under them. */
const HUMAN_AUTHOR = "agent-you";
const BATCH_POSTS = 50;

export interface RetentionConfig { cap: number; low: number }
export interface PurgeNotice { at: number; removed: number; posts: number; totalRemoved: number; cap: number; entries: number }
export interface PurgeResult extends PurgeNotice { postIds: string[] }
export interface HostFacts { name: string; cpu: string; cores: number; memGiB: number; platform: string; startedAt: number }

/** `SWARM_MAX_ENTRIES` (default 20000, 0 or off disables). The purge stops at `low`, so it runs in bursts, not on every post. */
export function retentionConfig(raw: string | number | undefined = process.env.SWARM_MAX_ENTRIES): RetentionConfig | null {
	if (raw === undefined || raw === "") return configFor(DEFAULT_MAX_ENTRIES);
	const cap = Number(raw);
	return Number.isInteger(cap) && cap >= 1 ? configFor(cap) : null;
}
const configFor = (cap: number): RetentionConfig => ({ cap, low: cap - Math.max(1, Math.floor(cap * 0.05)) });

export function hostFacts(): HostFacts {
	const cpus = os.cpus();
	return {
		name: process.env.SWARM_HOST_NAME || process.env.HELP_HOST_NAME || os.hostname(),
		cpu: (cpus[0]?.model ?? "unknown CPU").replace(/\s+/g, " ").trim(),
		cores: os.availableParallelism?.() ?? cpus.length,
		memGiB: Math.round((os.totalmem() / 2 ** 30) * 10) / 10,
		platform: `${os.type()} ${os.arch()}`,
		startedAt: Date.now(),
	};
}

/** One HostInfo entry per Space (replaced on every start): readable by the hub through the normal shard connection. */
export async function writeHostInfo(b: BatchHost, facts: HostFacts, cap: number | null): Promise<void> {
	await b.host.commit(async (tx) => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		// The swarm writes several calls a second, each with a request claim whose result is kept for `claimResultMs`: at the
		// default of 24 hours that fills maxClaimBytes within hours and new requests are refused. A repeat of a call comes
		// within seconds, so a few minutes of kept results is all the idempotence the swarm needs.
		// A claim's hash is kept until its generation stops admitting request ids (default 1 hour): with results kept only
		// minutes, thousands of claims would sit expired but kept, and the sweep of every commit would read them again.
		core.setLimits(s, { claimResultMs: SWARM_CLAIM_RESULT_MS, generationAdmitMs: SWARM_CLAIM_RESULT_MS }, now);
		while (core.probe(s, now, { type: "HostInfo" }, null, true).status === "found");
		core.write(s, now, { type: "HostInfo", fields: { ...facts, cap } }, null, FOREVER);
	}, b.ctx);
}

/**
 * Purges the oldest posts once the Space holds more than `cfg.cap` entries, down to `cfg.low`. Returns null when
 * nothing had to go (or the history index is not ready). Each batch is one atomic commit that also repoints the
 * oldest kept history node, so paging never meets a dangling pointer.
 */
export async function purgeOldest(b: BatchHost, cfg: RetentionConfig): Promise<PurgeResult | null> {
	const snap = await b.host.snapshot(NamedSpace, b.spaceId, b.ctx);
	if (!snap) return null;
	const visible = core.stats(snap, Date.now()).entries;
	if (visible <= cfg.cap) return null;
	const head = snap.entries.find((e) => e.type === "PostHistoryHead");
	if (!head || head.fields.ready === false) return null;

	type Ref = { id: string; type: string };
	const nodes = new Map<string, core.EntryRec>(), posts = new Map<string, Ref>(), likes = new Map<string, Ref[]>();
	for (const e of snap.entries) {
		if (e.writtenUnder !== null || e.takenBy !== null) continue;
		if (e.type === "PostHistoryNode") nodes.set(e.id, e);
		else if (e.type === "Post") posts.set(String(e.fields.postId), { id: e.id, type: "Post" });
		else if (e.type === "Like") { const k = String(e.fields.postId); (likes.get(k) ?? likes.set(k, []).get(k)!).push({ id: e.id, type: "Like" }); }
	}
	const newestFirst: core.EntryRec[] = [];
	for (let id = String(head.fields.next ?? ""), seen = new Set<string>(); id && !seen.has(id);) {
		const n = nodes.get(id);
		if (!n) break;
		seen.add(id); newestFirst.push(n); id = String(n.fields.next ?? "");
	}
	const oldest = newestFirst.reverse();
	// What stays: posts of people (the operator's own) and every reply under them, however deep the thread: the swarm's
	// own posts are what the cap is for.
	const info = oldest.map((n) => { try { const p = JSON.parse(String(n.fields.post)); return { id: String(p.postId ?? ""), author: String(p.author ?? ""), replyTo: p.replyTo ? String(p.replyTo) : "" }; } catch { return { id: "", author: "", replyTo: "" }; } });
	const children = new Map<string, string[]>();
	for (const i of info) if (i.replyTo) (children.get(i.replyTo) ?? children.set(i.replyTo, []).get(i.replyTo)!).push(i.id);
	const keep = new Set<string>();
	const todo = info.filter((i) => i.author === HUMAN_AUTHOR && i.id).map((i) => i.id);
	for (let id = todo.pop(); id !== undefined; id = todo.pop()) if (!keep.has(id)) { keep.add(id); todo.push(...(children.get(id) ?? [])); }
	const target = visible - cfg.low;
	const victims: Array<{ node: string; refs: Ref[]; postId: string }> = [];
	let planned = 0;
	for (let i = 0; i < oldest.length - MIN_KEEP_POSTS && planned < target; i++) {
		const node = oldest[i]!, postId = info[i]!.id;
		if (postId && keep.has(postId)) continue;
		const refs: Ref[] = [{ id: node.id, type: "PostHistoryNode" }, ...(posts.has(postId) ? [posts.get(postId)!] : []), ...(likes.get(postId) ?? [])];
		victims.push({ node: node.id, refs, postId });
		planned += refs.length;
	}
	if (!victims.length) return null;

	// The history chain runs from the newest node to the oldest (`next` points to the older one). A node that goes is
	// unlinked: the next newer node takes over its `next`, so survivors in the middle (the kept threads) stay chained.
	const olderOf = new Map<string, string>(), newerOf = new Map<string, string>();
	oldest.forEach((n, i) => { olderOf.set(n.id, String(n.fields.next ?? "")); if (i + 1 < oldest.length) newerOf.set(n.id, oldest[i + 1]!.id); });
	let removed = 0;
	const postIds: string[] = [];
	for (let a = 0; a < victims.length; a += BATCH_POSTS) {
		const part = victims.slice(a, a + BATCH_POSTS);
		const links = part.map((v) => { const l = { node: v.node, newer: newerOf.get(v.node) ?? "", older: olderOf.get(v.node) ?? "" }; if (l.newer) olderOf.set(l.newer, l.older); if (l.older) newerOf.set(l.older, l.newer); return l; });
		removed += await b.host.commit(async (tx) => {
			const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
			let n = 0;
			for (const v of part) {
				for (const r of v.refs) {
					const p = core.probe(s, now, { type: r.type, id: r.id }, null, true);
					if (p.status === "found") n++;
					else if (r.id === v.node) throw new Error("history node unavailable");
				}
			}
			const going = new Set(part.map((v) => v.node));
			for (const l of links) {
				if (!l.newer || going.has(l.newer)) continue; // the newest node never goes (MIN_KEEP_POSTS); a neighbour that goes too is not relinked
				const at = s.entries.findIndex((e) => e.id === l.newer), edge = s.entries[at];
				if (!edge) throw new Error("history chain changed");
				s.entries[at] = { ...edge, fields: { ...edge.fields, next: l.older } }; // records are values: replaced, never changed
			}
			core.touch(s, now);
			return n;
		}, b.ctx);
		for (const v of part) if (v.postId) postIds.push(v.postId);
		await new Promise((r) => setTimeout(r, 25));
	}

	const at = Date.now();
	const notice = await b.host.commit(async (tx) => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		const old = core.probe(s, now, { type: "PurgeNotice" }, null, true);
		const total = Number(old.status === "found" ? old.entry.fields.totalRemoved : 0) || 0;
		const n: PurgeNotice = { at, removed, posts: postIds.length, totalRemoved: total + removed, cap: cfg.cap, entries: core.stats(s, now).entries };
		core.write(s, now, { type: "PurgeNotice", fields: { ...n } }, null, FOREVER);
		return n;
	}, b.ctx);
	return { ...notice, postIds };
}
