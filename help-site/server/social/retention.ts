// Retention for the test systems (local machine, big + nano): every shard keeps at most `cap` entries in its
// database. Commit and scan costs are O(live entries) per Space, so the limit is per Space/database. Above the cap the
// oldest posts go together with their history nodes and likes (ChannelCount totals stay lifetime counters).
import os from "node:os";
import { core, FOREVER, NamedSpace, spaceDoc } from "phi-spaces";
import type { BatchHost } from "./batch.ts";

export const DEFAULT_MAX_ENTRIES = 20_000;
const MIN_KEEP_POSTS = 20;
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
	const target = visible - cfg.low;
	const victims: Array<{ node: string; refs: Ref[]; postId: string }> = [];
	let planned = 0;
	for (let i = 0; i < oldest.length - MIN_KEEP_POSTS && planned < target; i++) {
		const node = oldest[i]!;
		let postId = "";
		try { postId = String(JSON.parse(String(node.fields.post)).postId ?? ""); } catch { /* node without a readable post: only the node goes */ }
		const refs: Ref[] = [{ id: node.id, type: "PostHistoryNode" }, ...(posts.has(postId) ? [posts.get(postId)!] : []), ...(likes.get(postId) ?? [])];
		victims.push({ node: node.id, refs, postId });
		planned += refs.length;
	}
	if (!victims.length) return null;

	let removed = 0;
	const postIds: string[] = [];
	for (let a = 0; a < victims.length; a += BATCH_POSTS) {
		const part = victims.slice(a, a + BATCH_POSTS), kept = oldest[a + part.length]!;
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
			const at = s.entries.findIndex((e) => e.id === kept.id), edge = s.entries[at];
			if (!edge || String(edge.fields.next ?? "") !== part[part.length - 1]!.node) throw new Error("history chain changed");
			s.entries[at] = { ...edge, fields: { ...edge.fields, next: "" } }; // records are values: replaced, never changed
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
