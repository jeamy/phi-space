import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER, Meter, openOwnMemoryHost, SnapshotExpired } from "phi-spaces";
import { SocialSwarmHub, type SwarmPost } from "../server/social/swarm.ts";
import { appendHistory, historyPage } from "../server/social/history.ts";
import { purgeOldest, retentionConfig, SWARM_CLAIM_RESULT_MS } from "../server/social/retention.ts";
import { core, NamedSpace } from "phi-spaces";

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

test("retention: likes without a post on this shard go first, oldest first, and the posts stay", async () => {
	const f = await fixture(null);
	try {
		for (let i = 1; i <= 40; i++) await addPost(f.hub, i, 0);
		for (let i = 0; i < 300; i++) await f.hub.space.write({ type: "Like", fields: { likeId: `s-${i}`, postId: "b-post-1", agentId: `ag-${i}`, at: 1_000 + i } }, null, FOREVER);
		const before = await f.hub.space.count();
		const r = (await purgeOldest(f.b, { cap: 200, low: 190 }))!;
		assert.equal(r.posts, 0, "the strays alone reach the mark");
		assert.equal(await f.hub.space.count({ type: "Post" }), 40);
		assert.equal(r.removed, before - 190);
		const left = (await f.hub.space.readAll({ type: "Like" }, { limit: 1000 })).map((e) => Number(e.fields.at));
		assert.equal(Math.min(...left), 1_000 + r.removed, "the oldest went");
		await purgeOldest(f.b, { cap: 60, low: 50 });
		assert.equal(await f.hub.space.count({ type: "Like" }), 0);
		assert.ok(await f.hub.space.count() <= 51, "the posts go only after the strays are gone");
	} finally { await f.close(); }
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

test("the feed goes on when the change history has moved past the hub's cursor: it starts again from now and sends the state", async () => {
	const f = await fixture(null);
	try {
		const sent: any[] = [];
		await f.hub.attachWebSocket({ id: "t", send: (d: any) => sent.push(typeof d === "string" ? JSON.parse(d) : d), close() {}, onMessage() {}, onClose() {} } as any);
		await addPost(f.hub, 1);
		const floor = (await f.hub.space.readPage(null, { maxBytes: 1_000 })).rev;
		const changes = f.hub.space.changes.bind(f.hub.space);
		// the retained history now starts at `floor`: asking for anything older fails, as a trimmed log does
		(f.hub.space as any).changes = async (rev: number, o: any) => { if (rev < floor) throw new SnapshotExpired("history dropped"); return changes(rev, o); };
		const inits = () => sent.filter((m) => m.type === "feed.init").length;
		const deadline = Date.now() + 8_000;
		while (inits() < 2) { assert.ok(Date.now() < deadline, "the hub sent the state again"); await new Promise((r) => setTimeout(r, 50)); }
		await addPost(f.hub, 2);
		while (!sent.some((m) => m.type === "feed.delta" && m.likes?.some((l: any) => l.postId === "post-2"))) { assert.ok(Date.now() < deadline + 8_000, "deltas flow again"); await new Promise((r) => setTimeout(r, 50)); }
	} finally { await f.close(); }
});

test("a channel's posts are found however far back they lie (a busy feed): feed.more with a channel asks the shard's own filter", async () => {
	const f = await fixture(null);
	try {
		const add = async (i: number, channel: string) => {
			const post: SwarmPost = { postId: `p-${i}`, seq: i, taskId: `t-${i}`, author: "a", handle: "a", name: "A", hue: 0, channel, text: `post ${i}`, replyTo: null, replyToHandle: null, at: 1_000 + i, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null };
			const txn = await f.hub.space.createTransaction(30_000);
			await appendHistory(f.hub.space, post, txn.id);
			await f.hub.space.write({ type: "Post", fields: { ...post } }, txn.id, FOREVER);
			await f.hub.space.commit(txn.id);
		};
		for (let i = 1; i <= 7; i++) await add(i, "meins");
		for (let i = 8; i <= 620; i++) await add(i, "home"); // 613 newer posts of other channels: more than one chain round looks at
		const sent: any[] = [];
		let say!: (raw: string) => Promise<void> | void;
		await f.hub.attachWebSocket({ id: "t", send: (d: any) => sent.push(typeof d === "string" ? JSON.parse(d) : d), close() {}, onMessage: (h: typeof say) => { say = h; }, onClose() {} } as any);
		await say(JSON.stringify({ type: "feed.more", channel: "meins", limit: 50 }));
		const deadline = Date.now() + 8_000;
		while (!sent.some((m) => m.type === "feed.more")) { assert.ok(Date.now() < deadline, "answered"); await new Promise((r) => setTimeout(r, 20)); }
		const m = sent.find((x) => x.type === "feed.more");
		assert.deepEqual(m.posts.map((p: SwarmPost) => p.postId), ["p-7", "p-6", "p-5", "p-4", "p-3", "p-2", "p-1"]);
		assert.equal(m.exhausted, true);
	} finally { await f.close(); }
});

test("the swarm space keeps request results for minutes, not the default day (claims would fill maxClaimBytes)", async () => {
	const f = await fixture(null);
	try {
		const s = await f.host.snapshot(NamedSpace, f.hub.spaceId, ctx);
		assert.equal(core.limitsOf(s!).claimResultMs, SWARM_CLAIM_RESULT_MS);
		assert.equal(core.limitsOf(s!).generationAdmitMs, SWARM_CLAIM_RESULT_MS, "a generation admits no longer than the results are kept: no expired claims wait for it");
		assert.ok(SWARM_CLAIM_RESULT_MS < core.DEFAULT_LIMITS.claimResultMs);
	} finally { await f.close(); }
});

test("retention keeps the operator's own posts and every reply under them; the history chain stays whole around them", async () => {
	const f = await fixture(null);
	try {
		const add = async (i: number, over: Partial<SwarmPost> = {}) => {
			const post: SwarmPost = { postId: `post-${i}`, seq: i, taskId: `t-${i}`, author: "agent-9", handle: "a", name: "A", hue: 0, channel: "home", text: `post ${i}`, replyTo: null, replyToHandle: null, at: 1_000 + i, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null, ...over };
			const txn = await f.hub.space.createTransaction(30_000);
			await appendHistory(f.hub.space, post, txn.id);
			await f.hub.space.write({ type: "Post", fields: { ...post } }, txn.id, FOREVER);
			await f.hub.space.commit(txn.id);
		};
		await add(1);
		await add(2, { author: "agent-you", channel: "meins" });          // the operator's post
		await add(3, { replyTo: "post-2" });                              // an AI reply under it
		await add(4, { replyTo: "post-3" });                              // a reply under the reply
		for (let i = 5; i <= 80; i++) await add(i);
		const r = (await purgeOldest(f.b, { cap: 60, low: 40 }))!;
		assert.ok(r && r.removed > 0);
		const left = (await f.hub.space.readAll({ type: "Post" }, { limit: 1000 })).map((e) => String(e.fields.postId));
		for (const id of ["post-2", "post-3", "post-4"]) assert.ok(left.includes(id), `${id} stays`);
		assert.ok(!left.includes("post-1") && !left.includes("post-5"), "the swarm's own old posts go");
		const page = await historyPage(f.hub.space, { beforeAt: Infinity, beforeId: "", limit: 512 });
		assert.equal(page.candidates.length, left.length, "paging walks the whole kept chain");
		assert.equal(page.next, "", "and ends cleanly");
		assert.deepEqual(page.candidates.slice(-3).map((c) => c.post.postId), ["post-4", "post-3", "post-2"], "the kept thread sits at the old end, newest first");
		const own = await historyPage(f.hub.space, { beforeAt: Infinity, beforeId: "", limit: 50, channel: "meins" });
		assert.deepEqual(own.candidates.map((c) => c.post.postId), ["post-2"]);
	} finally { await f.close(); }
});

test("like tasks run on the shard of their post, and a joining hub sees that shard's likes", async () => {
	const rate = process.env.SWARM_RATE;
	process.env.SWARM_RATE = "40";
	const hostA = openOwnMemoryHost(), hostB = openOwnMemoryHost();
	const shard = new SocialSwarmHub(hostB, ctx, new Meter(), { produce: false, pulses: false, seedContent: false, shardTag: "b-", maxEntries: null });
	const hub = new SocialSwarmHub(hostA, ctx, new Meter(), { pulses: false, maxEntries: null });
	try {
		await shard.init();
		for (let i = 1; i <= 40; i++) await shard.space.write({ type: "Post", fields: { postId: `b-post-${i}`, seq: i, at: Date.now(), handle: "b", name: "B", hue: 0, channel: "home", text: "b", likes: 0, replies: 0 } }, null, FOREVER);
		await shard.space.write({ type: "Like", fields: { likeId: "held", postId: "b-post-2", agentId: "ag-held", at: Date.now() } }, null, FOREVER);
		hub.attachRemoteShard(shard.space, "b-");
		await hub.init();
		const seen = () => hub.snapshot().posts.find((p) => p.postId === "b-post-2");
		for (let i = 0; i < 200 && !seen(); i++) await new Promise((r) => setTimeout(r, 25));
		assert.equal(seen()?.likes, 1, "the shard's own like is counted after the join");

		const isRemote = (id: unknown) => String(id).startsWith("b-");
		const moved = () => shard.space.count({ type: "Like" });
		for (let i = 0; i < 400 && await moved() < 4; i++) await new Promise((r) => setTimeout(r, 25));
		assert.ok(await moved() >= 4, "like tasks reach the shard of their post");
		for (const e of await shard.space.readAll({ type: "Like" }, { limit: 5000 })) assert.ok(isRemote(e.fields.postId), "a shard holds only likes of its own posts");
		for (const e of await hub.space.readAll({ type: "Like" }, { limit: 5000 })) assert.ok(!isRemote(e.fields.postId), "no like on the hub for a post of the shard");
	} finally {
		await hub.close(); await shard.close(); await hostA.close(ctx); await hostB.close(ctx);
		if (rate === undefined) delete process.env.SWARM_RATE; else process.env.SWARM_RATE = rate;
	}
});
