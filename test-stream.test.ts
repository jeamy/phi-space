// AP 1.3: revisions and the change stream (federation-plan-v3.md 6.1).
import test from "node:test";
import assert from "node:assert/strict";
import { PiSpaces, FOREVER, core } from "./src/index.ts";
import { forEachBackend, ctx } from "./test/support/persistent.ts";

const apply = (visible: Map<string, string>, batches: core.Changes["batches"]) => {
	for (const b of batches) for (const o of b.ops) { if (o.op === "put") visible.set(o.id, JSON.stringify(o.fields)); else visible.delete(o.id); }
};
const truth = (s: core.SpaceState, now = 1) => new Map(core.list(s, now).map((e) => [e.id, JSON.stringify(e.fields)] as const));

test("each commit gets its own revision, several changes in one commit share one batch, no change means no revision", async () => {
	await forEachBackend(async (home) => {
		const h = await home.open();
		const s = new PiSpaces(h, ctx);
		assert.equal((await s.changes(0)).rev, 0);
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await s.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		let c = await s.changes(0);
		assert.equal(c.rev, 2, "two commits, two revisions");
		assert.deepEqual(c.batches.map((b) => b.rev), [1, 2]);
		await s.count({ type: "Job" }); // a read: no commit
		const t = await s.createTransaction(60_000);
		await s.write({ type: "Job", fields: { n: 3 } }, t.id, FOREVER);
		await s.write({ type: "Job", fields: { n: 5 } }, t.id, FOREVER);
		assert.equal((await s.changes(0)).rev, 2, "writes under a transaction are not visible yet: no revision");
		await s.commit(t.id);
		c = await s.changes(2);
		assert.equal(c.rev, 3, "one commit, one revision");
		assert.deepEqual(c.batches[0]!.ops.map((o) => o.op), ["put", "put"], "both entries appear at commit, in one batch");
		home.crash(h);
		const again = new PiSpaces(await home.open(), ctx);
		assert.equal((await again.changes(0)).rev, 3, "revisions survive a restart");
		await again.write({ type: "Job", fields: { n: 4 } }, null, FOREVER);
		assert.equal((await again.changes(0)).rev, 4);
	});
});

test("replaying the batches reproduces the visible set: write, take, lock, abort, expiry, renew, cancel", () => {
	const s = core.initialState();
	const seen = new Map<string, string>();
	let rev = 0;
	const sync = () => { const c = core.changes(s, rev); apply(seen, c.batches); rev = c.next; core.seal(s); assert.deepEqual([...seen].sort(), [...truth(s, now)].sort()); };
	let now = 1;
	const a = core.write(s, now, { type: "Job", fields: { n: 1 } }, null, 1_000).id; sync();
	const b = core.write(s, now, { type: "Job", fields: { n: 2 } }, null, core.FOREVER).id;
	core.write(s, now, { type: "Job", fields: { n: 3 } }, null, core.FOREVER); sync();
	const t = core.createTxn(s, now, 10_000);
	assert.equal(core.probe(s, now, { id: b }, t.id, true).status, "found"); sync(); // locked: not visible any more
	core.abortTxn(s, now, t.id); sync(); // back
	core.renew(s, now, a, 50_000); sync(); // lease is part of the state
	assert.equal(core.probe(s, now, { type: "Job", fields: { n: 3 } }, null, true).status, "found"); sync(); // plain take
	now = 100_000; core.settle(s, now); sync(); // `a` renewed to 51_001: still there
	now = 200_000; core.settle(s, now); sync(); // expired
	core.cancel(s, now, b); sync();
	assert.equal(seen.size, 0);
});

test("paging a live read and then changes after its first revision converges", async () => {
	await forEachBackend(async (home) => {
		const h = await home.open();
		const s = new PiSpaces(h, ctx);
		for (let i = 0; i < 30; i++) await s.write({ type: "Job", fields: { i, pad: "x".repeat(100) } }, null, FOREVER);
		const first = await s.readPage(null, { maxBytes: 1_500 });
		const startRev = first.rev;
		assert.ok(first.next, "more pages follow");
		// the space moves while the client pages
		await s.take({ type: "Job", fields: { i: 25 } }, 0);
		await s.write({ type: "Job", fields: { i: 99, pad: "late" } }, null, FOREVER);
		const seen = new Map<string, string>();
		for (const e of first.items) seen.set(e.id, JSON.stringify(e.fields));
		for (let p: core.Page = first; p.next; ) { p = await s.readPage(null, { maxBytes: 1_500, after: p.next }); for (const e of p.items) seen.set(e.id, JSON.stringify(e.fields)); }
		for (let c = await s.changes(startRev), more = true; more; more = c.more) { apply(seen, c.batches); if (c.more) c = await s.changes(c.next); }
		const live = new Map((await s.readAll(null, { limit: 1000 })).map((e) => [e.id, JSON.stringify(e.fields)] as const));
		assert.deepEqual([...seen].sort(), [...live].sort());
		assert.equal(first.streamId, (await s.changes(0)).streamId);
	});
});

test("changes are limited by bytes: a batch is never split, one is always returned, a too small budget says what is needed", () => {
	const s = core.initialState();
	for (let i = 0; i < 20; i++) { core.write(s, 1, { type: "Job", fields: { i, pad: "p".repeat(150) } }, null, core.FOREVER); core.seal(s); }
	const all = core.changes(s, 0).batches;
	assert.equal(all.length, 20);
	const size = JSON.stringify(all[0]).length;
	const got: number[] = [];
	for (let after = 0, more = true; more; ) {
		const c = core.changes(s, after, { maxBytes: core.CHANGES_OVERHEAD + size * 3 + 10 });
		assert.ok(c.batches.length >= 1 && c.batches.length <= 3);
		assert.ok(JSON.stringify(c).length <= core.CHANGES_OVERHEAD + size * 3 + 10 + 60, "within the budget (the envelope estimate is generous)");
		got.push(...c.batches.map((b) => b.rev)); after = c.next; more = c.more;
	}
	assert.deepEqual(got, all.map((b) => b.rev), "no gaps, no repeats");
	let err: unknown;
	try { core.changes(s, 0, { maxBytes: 100 }); } catch (e) { err = e; }
	assert.ok(err instanceof core.ResponseBudgetTooSmall);
	const need = (err as core.ResponseBudgetTooSmall).requiredBytes;
	assert.equal(core.changes(s, 0, { maxBytes: need }).batches.length, 1);
	assert.throws(() => core.changes(s, 0, { maxBytes: 0 }), core.IllegalArgumentError);
	assert.throws(() => core.changes(s, -1), core.IllegalArgumentError);
});

test("the log is bounded: old batches are dropped, an older cursor gets SnapshotExpired, newer ones keep working", () => {
	const s = core.initialState();
	core.setLimits(s, { maxLogBytes: 4_000 });
	for (let i = 0; i < 60; i++) { core.write(s, 1, { type: "Job", fields: { i, pad: "p".repeat(100) } }, null, core.FOREVER); core.seal(s); }
	const st = s.stream!;
	assert.ok(st.bytes <= 4_000 + 400, `tally ${st.bytes}`);
	assert.ok(st.floor > 0 && st.log.length < 60);
	assert.equal(st.rev, 60);
	assert.throws(() => core.changes(s, 0), core.SnapshotExpired);
	assert.throws(() => core.changes(s, st.floor - 1), core.SnapshotExpired);
	assert.equal(core.changes(s, st.floor).batches.length, st.log.length, "everything after the floor is there");
	assert.equal(core.changes(s, 60).batches.length, 0, "caught up: an empty answer");
	assert.throws(() => core.changes(s, 61), core.RevisionAhead);
	const measured = st.log.reduce((n, b) => n + new TextEncoder().encode(JSON.stringify(b)).length + 1, 0);
	assert.ok(Math.abs(measured - st.bytes) <= st.log.length * 8, `tally ${st.bytes} vs measured ${measured}`);
});

test("the stream counts toward the document budget and survives migration of a state", () => {
	const s = core.initialState();
	core.write(s, 1, { type: "Job", fields: { a: 1 } }, null, core.FOREVER);
	assert.ok(core.overheadBytes(s) >= s.stream!.bytes && s.stream!.bytes > 0);
	const m = core.migrate(JSON.parse(JSON.stringify(s)), 5);
	assert.equal(core.revision(m), 1);
	assert.equal(core.streamIdOf(m), "local:0");
});

test("on a real storage the log is bounded and keeps counting after a restart", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		let s = new PiSpaces(h, ctx);
		await s.setLimits({ maxLogBytes: 3_000 });
		for (let i = 0; i < 40; i++) await s.write({ type: "Job", fields: { i, pad: "p".repeat(120) } }, null, FOREVER);
		const c = await s.changes(39);
		assert.ok(c.rev === 40 && c.batches.length === 1);
		await assert.rejects(s.changes(0), core.SnapshotExpired);
		home.crash(h);
		h = await home.open();
		s = new PiSpaces(h, ctx);
		await s.write({ type: "Job", fields: { i: 41 } }, null, FOREVER);
		assert.equal((await s.changes(40)).rev, 41);
		await assert.rejects(s.changes(0), core.SnapshotExpired, "the floor survived the restart");
	});
});
