import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { core, createSpace, FOREVER, Meter, PiSpaces, spaceDoc, spaces } from "../../src/index.ts";
import { abortBatch, boundedPreparation, finishBatch, reserveBatch } from "../server/social/batch.ts";
import type { SwarmPost } from "../server/social/swarm.ts";
import { SocialSwarmHub } from "../server/social/swarm.ts";

class CountingStorage extends MemoryStorage {
	commits = 0;
	fail = false;
	override async commit(...args: Parameters<MemoryStorage["commit"]>) {
		this.commits++;
		if (this.fail) throw new Error("injected storage failure");
		return super.commit(...args);
	}
}

async function fixture(n = 4) {
	const storage = new CountingStorage(), registry = createRegistry(); registry.install(spaces);
	const host = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const info = await host.commit(tx => createSpace(tx, "batch-test", Date.now()), ctx);
	const b = { host, spaceId: info.spaceId, ctx };
	await host.commit(async tx => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		core.setCompletionProfiles(s, [{ taskType: "SwarmTask", resultTypes: ["Post", "Like"], equalFields: ["taskId"], maxResultCount: 1, maxResultBytes: 64 * 1024, maxLeaseMs: 60_000 }], now);
		core.write(s, now, { type: "PostHistoryHead", fields: { key: "head", next: "", ready: true } }, null, FOREVER);
		for (let i = 0; i < n; i++) core.write(s, now, { type: "SwarmTask", fields: { taskId: `task-${i}` } }, null, FOREVER);
	}, ctx);
	const space = new PiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
	return { b, space, storage, close: () => host.close(ctx) };
}

function posts(tasks: Array<{ fields: core.Fields }>): SwarmPost[] {
	return tasks.map((t, i) => ({ postId: `post-${i}`, seq: i, taskId: String(t.fields.taskId), author: "a", handle: "a", name: "A", hue: 0, channel: i % 2 ? "b" : "a", text: "test", replyTo: null, replyToHandle: null, at: 1, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null }));
}

test("worker batches: four posts, history, counters and follow-ups use exactly two storage commits", async () => {
	const f = await fixture();
	try {
		const before = f.storage.commits, batch = (await reserveBatch(f.b))!;
		assert.equal(batch.tasks.length, 4);
		assert.equal(await reserveBatch(f.b), null);
		assert.equal(f.storage.commits - before, 1, "reserved tasks must not cause empty polling commits");
		const p = posts(batch.tasks);
		const counts = await finishBatch(f.b, batch.txn, p, [{ type: "SwarmTask", fields: { taskId: "follow-up" }, lease: 60_000 }]);
		assert.equal(f.storage.commits - before, 2);
		assert.deepEqual(counts, { a: 2, b: 2 });
		assert.equal(await f.space.count({ type: "Post" }), 4);
		assert.equal(await f.space.count({ type: "PostHistoryNode" }), 4);
		assert.equal(await f.space.count({ type: "PostHistoryHead" }), 1);
		assert.equal(await f.space.count({ type: "SwarmTask" }), 1);
		assert.deepEqual(p.map(p => p.at), [1, 2, 3, 4]);
	} finally { await f.close(); }
});

test("worker batches: storage rejection poisons the session, never publishes candidate results", async () => {
	const f = await fixture();
	try {
		const batch = (await reserveBatch(f.b))!;
		f.storage.fail = true;
		await assert.rejects(finishBatch(f.b, batch.txn, posts(batch.tasks), []), /injected storage failure/);
		await assert.rejects(abortBatch(f.b, batch.txn), /poisoned/);
		await assert.rejects(reserveBatch(f.b), /poisoned/);
	} finally { f.storage.fail = false; await f.close(); }
});

test("worker batches: a provider ignoring its deadline cannot hold the reservation indefinitely", async () => {
	assert.equal(await boundedPreparation(new Promise<string>(() => {}), 5), null);
	assert.equal(await boundedPreparation(Promise.resolve("ready"), 100), "ready");
});

test("worker batches: completion failure rolls back all results and abort releases every task", async () => {
	const f = await fixture();
	try {
		const batch = (await reserveBatch(f.b))!;
		await assert.rejects(finishBatch(f.b, batch.txn, posts(batch.tasks).slice(1), []), /matching results/);
		assert.equal(await f.space.count({ type: "Post" }), 0);
		assert.equal(await f.space.count({ type: "PostHistoryNode" }), 0);
		assert.equal(await f.space.count({ type: "ChannelCount" }), 0);
		await abortBatch(f.b, batch.txn);
		assert.equal(await f.space.count({ type: "SwarmTask" }), 4);
		const retry = (await reserveBatch(f.b))!;
		await finishBatch(f.b, retry.txn, posts(retry.tasks), []);
		assert.equal(await reserveBatch(f.b), null);
		assert.equal(await f.space.count({ type: "Post" }), 4);
	} finally { await f.close(); }
});

test("worker batches: byte-budget overflow rolls back and the same tasks complete in smaller batches", async () => {
	const f = await fixture();
	try {
		const batch = (await reserveBatch(f.b))!;
		const large = (tasks: typeof batch.tasks) => posts(tasks).map(p => ({ ...p, postId: String(p.taskId), text: "x".repeat(40_000) }));
		await assert.rejects(finishBatch(f.b, batch.txn, large(batch.tasks), []), core.ResourceExhausted);
		assert.equal(await f.space.count({ type: "Post" }), 0);
		await abortBatch(f.b, batch.txn);
		for (let i = 0; i < 4; i++) {
			const retry = (await reserveBatch(f.b, 1))!;
			await finishBatch(f.b, retry.txn, large(retry.tasks), []);
		}
		assert.equal(await f.space.count({ type: "Post" }), 4);
		assert.equal(await f.space.count({ type: "PostHistoryNode" }), 4);
		assert.equal(await reserveBatch(f.b), null);
	} finally { await f.close(); }
});

test("worker batches: mixed post/like completion and successive batches preserve totals", async () => {
	const f = await fixture(8);
	try {
		for (let i = 0; i < 2; i++) {
			const batch = (await reserveBatch(f.b))!;
			const p = posts(batch.tasks).map(p => ({ ...p, postId: `${i}-${p.postId}` }));
			const like = p.pop()!;
			await finishBatch(f.b, batch.txn, p, [{ type: "Like", fields: { taskId: like.taskId, dedup: true }, lease: 60_000 }]);
		}
		assert.equal(await f.space.count({ type: "SwarmTask" }), 0);
		assert.equal(await f.space.count({ type: "Like" }), 2);
		const counters = await f.space.readAll({ type: "ChannelCount" });
		assert.equal(counters.reduce((n, e) => n + Number(e.fields.count), 0), 6);
	} finally { await f.close(); }
});

test("worker batches: actual hub dispatcher publishes four queued posts in two commits", async () => {
	const storage = new CountingStorage(), registry = createRegistry(); registry.install(spaces);
	const host = await Harness.open(storage, { models: createModels(), registry }, ctx);
	const hub = new SocialSwarmHub(host, ctx, new Meter(), { produce: false, pulses: false, seedContent: false });
	try {
		await hub.init();
		const deadline = Date.now() + 5_000;
		while ((await hub.space.readAll({ type: "PostHistoryHead" }))[0]?.fields.ready !== true) {
			assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
		}
		const before = storage.commits;
		await host.commit(async tx => {
			const now = Date.now(), s = await spaceDoc(tx, hub.spaceId, now);
			for (let n = 0; n < 4; n++) core.write(s, now, { type: "SwarmTask", fields: { taskId: `hub-${n}`, kind: "post", agentId: "agent-you", channel: "home", userText: "Batch test", replyTo: null } }, null, FOREVER);
		}, ctx);
		while (await hub.space.count({ type: "Post" }) !== 4) {
			assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
		}
		assert.equal(storage.commits - before, 3, "one test enqueue commit plus two actual worker commits");
		assert.equal(hub.snapshot().posts.length, 4);
		assert.equal(await hub.space.count({ type: "PostEffect" }), 0);
	} finally { await hub.close(); await host.close(ctx); }
});

test("worker batches: SQLite reopen retains reservations and completed results without replay duplicates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-swarm-batch-"));
	const open = async () => {
		const registry = createRegistry(); registry.install(spaces);
		return Harness.open(await openNodeSqliteStorage(join(dir, "store.sqlite")), { models: createModels(), registry }, ctx);
	};
	let host = await open();
	try {
		const info = await host.commit(tx => createSpace(tx, "batch-reopen", Date.now()), ctx);
		let b = { host, spaceId: info.spaceId, ctx };
		await host.commit(async tx => {
			const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
			core.setCompletionProfiles(s, [{ taskType: "SwarmTask", resultTypes: ["Post"], equalFields: ["taskId"], maxResultCount: 1 }], now);
			core.write(s, now, { type: "PostHistoryHead", fields: { key: "head", next: "", ready: true } }, null, FOREVER);
			core.write(s, now, { type: "SwarmTask", fields: { taskId: "reopen" } }, null, FOREVER);
		}, ctx);
		const abandoned = (await reserveBatch(b))!;
		await host.close(ctx); host = await open(); b = { ...b, host };
		assert.equal(await reserveBatch(b), null, "live reservations survive reopen");
		await abortBatch(b, abandoned.txn);
		const retry = (await reserveBatch(b))!;
		await finishBatch(b, retry.txn, posts(retry.tasks), []);
		await host.close(ctx); host = await open(); b = { ...b, host };
		assert.equal(await reserveBatch(b), null, "completed tasks cannot produce another post after reopen");
		const space = new PiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
		assert.equal(await space.count({ type: "Post" }), 1);
		assert.equal(await space.count({ type: "PostHistoryNode" }), 1);
		assert.equal(await space.count({ type: "PostHistoryHead" }), 1);
	} finally { await host.close(ctx); await rm(dir, { recursive: true, force: true }); }
});
