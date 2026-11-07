import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { core, createSpace, FOREVER, Meter, PhiSpaces, spaceDoc, OwnStoreHost, openSqliteHost } from "phi-spaces";
import { abortBatch, boundedPreparation, finishBatch, reserveBatch } from "../server/social/batch.ts";
import type { SwarmPost } from "../server/social/swarm.ts";
import { SocialSwarmHub } from "../server/social/swarm.ts";
import { swarmSpace } from "./swarm-space.ts";

/** The own host over a ledger that keeps nothing (memory) and counts the commits it is handed; `fail` makes a write
 *  fail, after which the host takes no more work (it must be reopened). */
class CountingStorage {
	commits = 0;
	fail = false;
	host(): OwnStoreHost {
		return new OwnStoreHost({ load: () => null, persist: async () => { this.commits++; if (this.fail) throw new Error("injected storage failure"); }, close: () => {} });
	}
}

async function fixture(n = 4) {
	const storage = new CountingStorage(), host = storage.host();
	const info = await host.commit(tx => createSpace(tx, "batch-test", Date.now()), ctx);
	const b = { host, spaceId: info.spaceId, ctx };
	await host.commit(async tx => {
		const now = Date.now(), s = await spaceDoc(tx, b.spaceId, now);
		core.setCompletionProfiles(s, [{ taskType: "SwarmTask", resultTypes: ["Post", "Like"], equalFields: ["taskId"], maxResultCount: 1, maxResultBytes: 64 * 1024, maxLeaseMs: 60_000 }], now);
		core.write(s, now, { type: "PostHistoryHead", fields: { key: "head", next: "", ready: true } }, null, FOREVER);
		for (let i = 0; i < n; i++) core.write(s, now, { type: "SwarmTask", fields: { taskId: `task-${i}` } }, null, FOREVER);
	}, ctx);
	const space = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
	return { b: space, space, storage, close: () => host.close(ctx) };
}

function posts(tasks: Array<{ fields: core.Fields }>): SwarmPost[] {
	return tasks.map((t, i) => ({ postId: `post-${i}`, seq: i, taskId: String(t.fields.taskId), author: "a", handle: "a", name: "A", hue: 0, channel: i % 2 ? "b" : "a", text: "test", replyTo: null, replyToHandle: null, at: 1, likes: 0, replies: 0, imageSeed: null, imageAlt: null, imageUrl: null }));
}

test("worker batches: four posts, history, counters and follow-ups appear together at the commit", async () => {
	const f = await fixture();
	try {
		const before = f.storage.commits, batch = (await reserveBatch(f.b))!;
		assert.equal(batch.tasks.length, 4);
		assert.equal(f.storage.commits - before, 1, "one call reserves the batch");
		assert.equal(await reserveBatch(f.b), null);
		assert.equal(f.storage.commits - before, 1, "reserved tasks must not cause empty polling commits");
		const p = posts(batch.tasks);
		const counts = await finishBatch(f.b, batch.txn, p, [{ type: "SwarmTask", fields: { taskId: "follow-up" }, lease: 60_000 }]);
		assert.deepEqual(counts, { a: 2, b: 2 });
		assert.equal(await f.space.count({ type: "Post" }), 4);
		assert.equal(await f.space.count({ type: "PostHistoryNode" }), 4);
		assert.equal(await f.space.count({ type: "PostHistoryHead" }), 1);
		assert.equal(await f.space.count({ type: "SwarmTask" }), 1);
		assert.deepEqual(p.map(p => p.at), [1, 2, 3, 4]);
	} finally { await f.close(); }
});

test("worker batches: a failed write stops the host, never publishes candidate results", async () => {
	const f = await fixture();
	try {
		const batch = (await reserveBatch(f.b))!;
		f.storage.fail = true;
		await assert.rejects(finishBatch(f.b, batch.txn, posts(batch.tasks), []), /injected storage failure/);
		await assert.rejects(abortBatch(f.b, batch.txn), /must be reopened|injected storage failure/);
		await assert.rejects(reserveBatch(f.b), /must be reopened/);
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
		// Four posts of 60 KB: each node is a call of its own, the posts go together and pass the commit's byte budget.
		const large = (tasks: typeof batch.tasks) => posts(tasks).map(p => ({ ...p, postId: String(p.taskId), text: "x".repeat(60_000) }));
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

test("worker batches: the hub's dispatcher publishes four queued posts", async () => {
	const t = await swarmSpace();
	const hub = new SocialSwarmHub(t.space, new Meter(), { produce: false, pulses: false, seedContent: false });
	try {
		await hub.init();
		const deadline = Date.now() + 10_000;
		while ((await hub.space.readAll({ type: "PostHistoryHead" }))[0]?.fields.ready !== true) {
			assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
		}
		const txn = await hub.space.createTransaction(10_000);
		for (let n = 0; n < 4; n++) await hub.space.write({ type: "SwarmTask", fields: { taskId: `hub-${n}`, kind: "post", agentId: "agent-you", channel: "home", userText: "Batch test", replyTo: null } }, txn.id, FOREVER);
		await hub.space.commit(txn.id);
		while (await hub.space.count({ type: "Post" }) !== 4) {
			assert.ok(Date.now() < deadline); await new Promise(r => setTimeout(r, 10));
		}
		assert.equal(await hub.space.count({ type: "PostHistoryNode" }), 4);
		assert.equal(hub.snapshot().posts.length, 4);
		assert.equal(await hub.space.count({ type: "PostEffect" }), 0);
	} finally { await hub.close(); await t.close(); }
});

test("worker batches: SQLite reopen retains reservations and completed results without replay duplicates", async () => {
	const dir = await mkdtemp(join(tmpdir(), "pi-swarm-batch-"));
	const open = async () => {
		return openSqliteHost(join(dir, "store.sqlite"));
	};
	let host = await open();
	try {
		const info = await host.commit(tx => createSpace(tx, "batch-reopen", Date.now()), ctx);
		const client = () => new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
		let b = client();
		await host.commit(async tx => {
			const now = Date.now(), s = await spaceDoc(tx, info.spaceId, now);
			core.setCompletionProfiles(s, [{ taskType: "SwarmTask", resultTypes: ["Post"], equalFields: ["taskId"], maxResultCount: 1 }], now);
			core.write(s, now, { type: "PostHistoryHead", fields: { key: "head", next: "", ready: true } }, null, FOREVER);
			core.write(s, now, { type: "SwarmTask", fields: { taskId: "reopen" } }, null, FOREVER);
		}, ctx);
		const abandoned = (await reserveBatch(b))!;
		await host.close(ctx); host = await open(); b = client();
		assert.equal(await reserveBatch(b), null, "live reservations survive reopen");
		await abortBatch(b, abandoned.txn);
		const retry = (await reserveBatch(b))!;
		await finishBatch(b, retry.txn, posts(retry.tasks), []);
		await host.close(ctx); host = await open(); b = client();
		assert.equal(await reserveBatch(b), null, "completed tasks cannot produce another post after reopen");
		const space = new PhiSpaces(host, ctx, Date.now, undefined, undefined, { space: info.spaceId });
		assert.equal(await space.count({ type: "Post" }), 1);
		assert.equal(await space.count({ type: "PostHistoryNode" }), 1);
		assert.equal(await space.count({ type: "PostHistoryHead" }), 1);
	} finally { await host.close(ctx); await rm(dir, { recursive: true, force: true }); }
});
