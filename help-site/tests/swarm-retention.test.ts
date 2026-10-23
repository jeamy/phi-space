import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { FOREVER, Meter, openOwnMemoryHost } from "../../src/index.ts";
import { SocialSwarmHub, type SwarmPost } from "../server/social/swarm.ts";
import { appendHistory, historyPage } from "../server/social/history.ts";
import { purgeOldest, retentionConfig } from "../server/social/retention.ts";

async function fixture(maxEntries: number | null) {
	const host = openOwnMemoryHost();
	const hub = new SocialSwarmHub(host, ctx, new Meter(), { produce: false, pulses: false, seedContent: false, maxEntries });
	await hub.init();
	const deadline = Date.now() + 5_000;
	while ((await hub.space.readAll({ type: "PostHistoryHead" }))[0]?.fields.ready !== true) {
		assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10));
	}
	return { host, hub, b: { host, spaceId: hub.spaceId, ctx }, close: async () => { await hub.close(); await host.close(ctx); } };
}

async function addPost(hub: SocialSwarmHub, i: number, likes = 1) {
	const post: SwarmPost = { postId: `post-${i}`, seq: i, taskId: `t-${i}`, author: "a", handle: "a", name: "A", hue: 0, channel: "home", text: `post ${i}`, replyTo: null, replyToHandle: null, at: 1_000 + i, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null };
	const txn = await hub.space.createTransaction(30_000);
	await appendHistory(hub.space, post, txn.id);
	await hub.space.write({ type: "Post", fields: { ...post } }, txn.id, FOREVER);
	for (let l = 0; l < likes; l++) await hub.space.write({ type: "Like", fields: { likeId: `l-${i}-${l}`, postId: post.postId, agentId: `ag-${l}`, at: post.at } }, txn.id, FOREVER);
	await hub.space.commit(txn.id);
}

test("retention config: default 20000 entries per database, 0/off disables, low-water mark below the cap", () => {
	assert.deepEqual(retentionConfig(undefined) && { cap: retentionConfig(undefined)!.cap }, { cap: 20_000 });
	assert.equal(retentionConfig(undefined)!.low, 19_000);
	assert.equal(retentionConfig("0"), null);
	assert.equal(retentionConfig("off"), null);
	assert.deepEqual(retentionConfig(100), { cap: 100, low: 95 });
});

test("retention: the oldest posts leave with their history nodes and likes, and the history chain stays whole", async () => {
	const f = await fixture(null);
	try {
		for (let i = 1; i <= 60; i++) await addPost(f.hub, i, i % 2);
		const before = await f.hub.space.count();
		assert.equal(before, 60 + 60 + 30 + 1 + 1, "posts + nodes + likes + head + host info");
		assert.equal(await purgeOldest(f.b, { cap: before, low: before - 10 }), null, "at the cap nothing goes");

		const r = (await purgeOldest(f.b, { cap: 150, low: 120 }))!;
		assert.ok(r, "above the cap the purge runs");
		const after = await f.hub.space.count();
		assert.ok(after <= 120 + 1, `down to the low-water mark (PurgeNotice included), got ${after}`);
		assert.equal(r.removed, before - (after - 1));
		assert.equal(r.cap, 150);
		assert.equal(r.totalRemoved, r.removed);

		const remaining = (await f.hub.space.readAll({ type: "Post" }, { limit: 1000 })).map((e) => String(e.fields.postId));
		assert.ok(!remaining.includes("post-1") && remaining.includes("post-60"), "oldest gone, newest kept");
		assert.equal(r.postIds.length, 60 - remaining.length);
		assert.equal(await f.hub.space.count({ type: "PostHistoryNode" }), remaining.length);
		for (const id of r.postIds) assert.equal((await f.hub.space.readAll({ type: "Like", fields: { postId: id } })).length, 0, "likes of purged posts are gone");

		const page = await historyPage(f.hub.space, { beforeAt: Infinity, beforeId: "", limit: 512 });
		assert.equal(page.candidates.length, remaining.length, "paging walks the whole kept chain");
		assert.equal(page.next, "", "and ends cleanly instead of meeting a dangling node");
		assert.equal(page.candidates[0]!.post.postId, "post-60");

		const notice = (await f.hub.space.readAll({ type: "PurgeNotice" }))[0]!.fields;
		assert.equal(notice.removed, r.removed);
		assert.equal(await purgeOldest(f.b, { cap: 150, low: 120 }), null, "below the cap again: nothing to do");

		await addPost(f.hub, 61, 0);
		const again = await historyPage(f.hub.space, { beforeAt: Infinity, beforeId: "", limit: 512 });
		assert.equal(again.candidates[0]!.post.postId, "post-61");
		assert.equal(again.candidates.length, remaining.length + 1);
		assert.equal(again.next, "");
	} finally { await f.close(); }
});

test("retention: stats report the cap, the shard entry count and the last purge", async () => {
	const f = await fixture(50);
	try {
		for (let i = 1; i <= 30; i++) await addPost(f.hub, i, 1);
		const r = (await purgeOldest(f.b, { cap: 50, low: 40 }))!;
		assert.ok(r);
		const stats = await f.hub.stats();
		assert.equal(stats.retention.cap, 50);
		assert.equal(stats.retention.shards.length, 1);
		const shard = stats.retention.shards[0]!;
		assert.equal(shard.shard, "a");
		assert.equal(shard.up, true);
		assert.equal(shard.lastRemoved, r.removed);
		assert.ok(shard.lastPurgeAt && Math.abs(shard.lastPurgeAt - Date.now()) < 10_000);
		const sys = await f.hub.systemInfo();
		assert.equal(sys.cap, 50);
		assert.ok(sys.shards[0]!.host!.cores >= 1 && sys.shards[0]!.host!.memGiB > 0, "the shard describes its host");
	} finally { await f.close(); }
});

test("retention: disabled hub reports no cap", async () => {
	const f = await fixture(null);
	try {
		assert.equal((await f.hub.stats()).retention.cap, null);
	} finally { await f.close(); }
});

test("shard down: history queries and thread fetches answer from the local shard, the bar reports the shard unreachable", async () => {
	const host = openOwnMemoryHost();
	const hub = new SocialSwarmHub(host, ctx, new Meter(), { produce: false, pulses: false, seedContent: false, maxEntries: null });
	const dead = new Proxy({}, { get: () => () => Promise.reject(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })) }) as any;
	hub.attachRemoteShard(dead, "b-", "tcp:nano:3600");
	try {
		await hub.init();
		const deadline = Date.now() + 5_000;
		while ((await hub.space.readAll({ type: "PostHistoryHead" }))[0]?.fields.ready !== true) {
			assert.ok(Date.now() < deadline); await new Promise((r) => setTimeout(r, 10));
		}
		await addPost(hub, 1, 0);
		const sent: any[] = []; let handler: (t: string) => Promise<void> | void = () => {};
		await hub.attachWebSocket({ id: "t", send: (d: any) => sent.push(d), close() {}, onMessage: (h: (t: string) => Promise<void> | void) => { handler = h; }, onClose() {} } as any);
		for (const type of ["feed.more", "ai.posts", "agent.posts"]) {
			sent.length = 0;
			await handler(JSON.stringify({ type, channel: "all", handle: "a" }));
			const r = sent.find((m) => m.type === type)!;
			assert.ok(r, `${type} answered`);
			assert.notEqual(r.complete, false, `${type} is not reported as failed`);
			assert.equal(r.error, undefined);
		}
		sent.length = 0;
		await handler(JSON.stringify({ type: "thread.fetch", postId: "b-post-9" }));
		assert.ok(sent.some((m) => m.type === "thread"), "thread of the dead shard answers empty");
		assert.ok(!sent.some((m) => m.type === "feed.error"), "no error frame reaches the client");
		const sys = await hub.systemInfo();
		assert.deepEqual(sys.shards.map((s) => [s.shard, s.up]), [["a", true], ["b", false]]);
	} finally { await hub.close(); await host.close(ctx); }
});
