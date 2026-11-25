// Admission: per-tenant order, the queue bound, the gate that drains started operations and refuses queued ones,
// and the suspension of one tenant (docs/zanzibar-agent-filesystem-plan.en.md, section 6.1).
import test from "node:test";
import assert from "node:assert/strict";
import { Admission, Unavailable } from "../server/admission.ts";

const gate = () => { let open!: () => void; const p = new Promise<void>((r) => { open = r; }); return { p, open }; };

test("one tenant's operations run one at a time in arrival order", async () => {
	const a = new Admission();
	const log: string[] = [];
	const first = gate();
	const r1 = a.run("t1", async () => { log.push("1 start"); await first.p; log.push("1 end"); return 1; });
	const r2 = a.run("t1", async () => { log.push("2"); return 2; });
	await new Promise((r) => setImmediate(r));
	assert.deepEqual(log, ["1 start"]);
	first.open();
	assert.deepEqual(await Promise.all([r1, r2]), [1, 2]);
	assert.deepEqual(log, ["1 start", "1 end", "2"]);
});

test("different tenants run side by side", async () => {
	const a = new Admission();
	const held = gate();
	const slow = a.run("t1", () => held.p.then(() => "t1"));
	assert.equal(await a.run("t2", async () => "t2"), "t2");
	held.open();
	assert.equal(await slow, "t1");
});

test("a full queue refuses with unavailable", async () => {
	const a = new Admission({ maxQueuedPerTenant: 1, retryAfterMs: 250 });
	const held = gate();
	const running = a.run("t1", () => held.p);
	const queued = a.run("t1", async () => "queued");
	await assert.rejects(a.run("t1", async () => "too many"), (e: unknown) => e instanceof Unavailable && e.retryAfterMs === 250);
	held.open();
	await running;
	assert.equal(await queued, "queued");
});

test("an operation that throws does not block the queue", async () => {
	const a = new Admission();
	await assert.rejects(a.run("t1", async () => { throw new Error("boom"); }), /boom/);
	assert.equal(await a.run("t1", async () => "next"), "next");
});

test("closing refuses queued operations and waits for started ones", async () => {
	const a = new Admission();
	const held = gate();
	let finished = false;
	const started = a.run("t1", async () => { await held.p; finished = true; return "done"; });
	const queued = a.run("t1", async () => "never");
	const other = a.run("t2", async () => { await held.p; return "t2 done"; });
	await new Promise((r) => setImmediate(r));
	const closing = a.close();
	await assert.rejects(queued, Unavailable);
	await assert.rejects(a.run("t3", async () => "late"), Unavailable);
	let closed = false;
	void closing.then(() => { closed = true; });
	await new Promise((r) => setImmediate(r));
	assert.equal(closed, false, "close must wait for the started operations");
	held.open();
	await closing;
	assert.equal(finished, true);
	assert.equal(await started, "done");
	assert.equal(await other, "t2 done");
	a.reopen();
	assert.equal(await a.run("t1", async () => "again"), "again");
});

test("closing with nothing started resolves at once", async () => {
	const a = new Admission();
	await a.close();
	assert.equal(a.open, false);
});

test("a suspended tenant refuses alone until resumed", async () => {
	const a = new Admission();
	const held = gate();
	const running = a.run("t1", () => held.p.then(() => "ran"));
	const queued = a.run("t1", async () => "never");
	a.suspend("t1", "inconsistentState");
	await assert.rejects(queued, /suspended: inconsistentState/);
	await assert.rejects(a.run("t1", async () => "x"), Unavailable);
	assert.equal(await a.run("t2", async () => "t2"), "t2");
	held.open();
	assert.equal(await running, "ran", "a started operation reaches its outcome");
	a.resume("t1");
	assert.equal(await a.run("t1", async () => "back"), "back");
});
