// AP 1.5: RPC claims and request generations (federation-plan-v3.md 6.2, 11 stage 1, 12.1 rows "1").
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	PiSpaces, FOREVER, Space, core, RequestConflict, RequestExpired, ResultExpired, IncarnationChanged, OperationCancelled,
	type Principal, type RequestRef,
} from "./src/index.ts";
import { forEachBackend, InjectedFault, ctx } from "./test/support/persistent.ts";

const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
const alice: Principal = { peerId: "peer-a", agentId: "worker-1" };
class Clock { t = 1_000_000; now = () => this.t; }
const client = (h: Harness, c: Clock) => new PiSpaces(h, ctx, c.now);
const req = (generation: string, requestId: string, principal = alice): RequestRef => ({ principal, generation, requestId });
const tick = () => new Promise((r) => setTimeout(r, 30));

test("take with lost answer: the retry returns the stored result after reopen, no second take, no plaintext args", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const s = new PiSpaces(h, ctx);
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await s.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "take-1");
		const tmpl = { type: "Job", fields: { secretMarker: null } };
		home.faults.arm("loseAnswer");
		await assert.rejects(s.take(tmpl, 0, { request: r }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const again = new PiSpaces(h, ctx);
		assert.equal(home.faults.fired, 1);
		assert.equal((await again.pollOperation(r)).state, "done", "the deciding commit was durable; only its answer was lost");
		const got = await again.take(tmpl, 0, { request: r });
		assert.equal(got?.fields.n, 1);
		assert.equal(await again.count({ type: "Job" }), 1, "exactly one take");
		assert.deepEqual(await again.pollOperation(r), { state: "done", deadline: (await again.pollOperation(r)).deadline, method: "take", result: got });
		const stored = JSON.stringify((await h.snapshot(Space, ctx))!.rpc);
		assert.ok(!stored.includes("secretMarker"), "claims keep a hash of the arguments, not the arguments");
	});
});

test("immediate mutations: write and txn begin replay their stored result, also after a lost answer", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const s = new PiSpaces(h, ctx);
		const { generation } = await s.issueGeneration(alice);
		home.faults.arm("loseAnswer");
		await assert.rejects(s.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const s2 = new PiSpaces(h, ctx);
		const l1 = await s2.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") });
		const l2 = await s2.write({ type: "J", fields: {} }, null, FOREVER, { request: req(generation, "w") });
		assert.deepEqual(l1, l2);
		assert.equal(await s2.count({ type: "J" }), 1);
		const t1 = await s2.createTransaction(10_000, { request: req(generation, "t") });
		const t2 = await s2.createTransaction(10_000, { request: req(generation, "t") });
		assert.equal(t1.id, t2.id);
		await s2.commit(t1.id, { request: req(generation, "c") });
		await s2.commit(t1.id, { request: req(generation, "c") }); // a replay, not a second commit of a gone txn
	});
});

test("same request id with different arguments or method is a RequestConflict", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		await s.write({ type: "A", fields: { v: 1 } }, null, FOREVER, { request: req(generation, "x") });
		await assert.rejects(s.write({ type: "A", fields: { v: 2 } }, null, FOREVER, { request: req(generation, "x") }), RequestConflict);
		await assert.rejects(s.take({ type: "A" }, 0, { request: req(generation, "x") }), RequestConflict);
		const bob = { peerId: "peer-b" };
		await assert.rejects(s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "y", bob) }), RequestExpired, "a generation belongs to one principal");
	} finally { await h.close(ctx); }
});

test("a pending request outlives its generation's admission; new ids in that generation are rejected", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		await s.setLimits({ generationAdmitMs: 50 });
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "wait-for-job");
		const pending = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		assert.equal((await s.pollOperation(r)).state, "pending");
		c.t += 10_000; // admission over
		await assert.rejects(s.write({ type: "X", fields: {} }, null, FOREVER, { request: req(generation, "new-id") }), RequestExpired);
		await s.write({ type: "Job", fields: { n: 7 } }, null, FOREVER);
		assert.equal((await pending)?.fields.n, 7, "the known request continued and was decided");
		assert.equal((await s.take({ type: "Job" }, FOREVER, { request: r }))?.fields.n, 7, "retry after the generation closed returns the result");
		await assert.rejects(s.take({ type: "Job" }, 0, { request: r }), RequestConflict, "a retry must repeat the arguments");
		assert.equal((await s.pollOperation(r)).state, "done");
	} finally { await h.close(ctx); }
});

test("the deadline is fixed by the first accepted call, not by a retry", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "short");
		const first = s.take({ type: "Job" }, 100, { request: r });
		await tick();
		const dl = (await s.pollOperation(r)).deadline;
		assert.equal(dl, c.t + 100);
		c.t += 60;
		const second = client(h, c).take({ type: "Job" }, 100, { request: r }); // same arguments, later
		await tick();
		assert.equal((await s.pollOperation(r)).deadline, dl);
		c.t += 41;
		await s.write({ type: "Other", fields: {} }); // wakes both
		assert.equal(await first, null);
		assert.equal(await second, null);
		assert.deepEqual(await s.pollOperation(r), { state: "done", deadline: dl, method: "take", result: null });
	} finally { await h.close(ctx); }
});

test("results are kept from their decision; then ResultExpired; after admission and retention RequestExpired", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		await s.setLimits({ claimResultMs: 1000, generationAdmitMs: 5000 });
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "late");
		const p = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		c.t += 3000; // pending longer than the retention: that does not count
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		assert.equal((await p)?.fields.n, 1);
		c.t += 900;
		assert.equal((await s.take({ type: "Job" }, FOREVER, { request: r }))?.fields.n, 1, "retention counts from the decision");
		c.t += 200;
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), ResultExpired);
		assert.equal((await s.pollOperation(r)).resultExpired, true);
		c.t += 10_000; // admission and retention over: the claim goes
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), RequestExpired);
		assert.equal(await s.count({ type: "Job" }), 0, "never a second take");
	} finally { await h.close(ctx); }
});

test("cancelOperation ends a pending take; a decided request stays decided", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		const r = req(generation, "cancel-me");
		const blocked = s.take({ type: "Job" }, FOREVER, { request: r });
		await tick();
		assert.equal((await client(h, c).cancelOperation(r, { request: req(generation, "the-cancel") })).state, "cancelled");
		await assert.rejects(blocked, OperationCancelled);
		await s.write({ type: "Job", fields: {} }, null, FOREVER);
		await assert.rejects(s.take({ type: "Job" }, FOREVER, { request: r }), OperationCancelled);
		assert.equal(await s.count({ type: "Job" }), 1, "a cancelled take takes nothing");
		const d = req(generation, "decided");
		await s.take({ type: "Job" }, 0, { request: d });
		assert.equal((await s.cancelOperation(d)).state, "done");
		await assert.rejects(s.pollOperation(req(generation, "never-seen")), RequestExpired);
	} finally { await h.close(ctx); }
});

test("a generation of an earlier incarnation admits no new ids (IncarnationChanged)", async () => {
	const h = await memory();
	try {
		const c = new Clock(), s = client(h, c);
		const { generation } = await s.issueGeneration(alice);
		await s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "before") });
		await h.commit(async (tx) => { (await tx.doc(Space)).incarnation = "restored"; }, ctx); // what a restore does
		await assert.rejects(s.write({ type: "A", fields: {} }, null, FOREVER, { request: req(generation, "after") }), IncarnationChanged);
		assert.equal((await s.pollOperation(req(generation, "before"))).state, "done", "known results stay readable");
	} finally { await h.close(ctx); }
});

test("claims and generations survive the v4 -> v5 migration path", () => {
	const m = core.migrate({ entries: [], spaceId: "sp-1", incarnation: "abcd0123", rpc: { generations: { g1: {} }, claims: {} } }, 4);
	assert.equal(m.spaceId, "sp-1");
	assert.equal(m.incarnation, "abcd0123");
	assert.ok(m.rpc?.generations.g1);
});
