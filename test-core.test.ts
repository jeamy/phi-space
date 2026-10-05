import { test } from "node:test";
import assert from "node:assert/strict";
import * as c from "./src/core.ts";

const job = (n: number, extra: c.Fields = {}): c.EntryDraft => ({ type: "Job", fields: { n, ...extra } });
const T = (type: string, fields: c.Fields = {}): c.Template => ({ type, fields });
const mk = () => c.initialState();

test("two takes never return the same entry", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const a = c.probe(s, 1, T("Job"), null, true), b = c.probe(s, 1, T("Job"), null, true);
	assert.equal(a.status, "found"); assert.equal(b.status, "none");
});
test("null template matches any; null field is wildcard; fields match exactly", () => {
	const s = mk(); c.write(s, 0, job(1, { k: "x" }), null, c.FOREVER);
	assert.equal(c.probe(s, 1, null, null, false).status, "found");
	assert.equal(c.probe(s, 1, T("Job", { n: null, k: "x" }), null, false).status, "found");
	assert.equal(c.probe(s, 1, T("Job", { k: "y" }), null, false).status, "none");
});
test("subtype matching", () => {
	const s = mk(); c.write(s, 0, { type: "Resize", types: ["Resize", "Job"], fields: {} }, null, c.FOREVER);
	assert.equal(c.probe(s, 1, T("Job"), null, false).status, "found");
	assert.equal(c.probe(s, 1, T("Other"), null, false).status, "none");
});
test("lease: expired entry is invisible; reduced lease; negative throws", () => {
	const s = mk(); const l = c.write(s, 0, job(1), null, 100);
	assert.equal(l.expires, 100);
	assert.equal(c.probe(s, 99, T("Job"), null, false).status, "found");
	assert.equal(c.probe(s, 100, T("Job"), null, false).status, "none");
	assert.equal(c.write(s, 0, job(2), null, c.FOREVER).expires, c.MAX_LEASE_MS);
	assert.throws(() => c.write(s, 0, job(3), null, -5), c.IllegalArgumentError);
});
test("lease renew and cancel", () => {
	const s = mk(); const l = c.write(s, 0, job(1), null, 100);
	c.renew(s, 50, l.id, 100);
	assert.equal(c.probe(s, 120, T("Job"), null, false).status, "found");
	c.cancel(s, 121, l.id);
	assert.equal(c.probe(s, 122, T("Job"), null, false).status, "none");
	assert.throws(() => c.renew(s, 123, l.id, 5), c.UnknownLeaseError);
});
test("entry written under txn is invisible outside until commit; abort discards", () => {
	const s = mk(); const t = c.createTxn(s, 0, 1000);
	c.write(s, 0, job(1), t.id, c.FOREVER);
	assert.equal(c.probe(s, 1, T("Job"), null, false).status, "none");
	assert.equal(c.probe(s, 1, T("Job"), t.id, false).status, "found");
	c.commitTxn(s, 2, t.id);
	assert.equal(c.probe(s, 3, T("Job"), null, false).status, "found");
	const u = c.createTxn(s, 4, 1000); c.write(s, 4, job(2), u.id, c.FOREVER); c.abortTxn(s, 5, u.id);
	assert.equal(c.probe(s, 6, T("Job", { n: 2 }), null, false).status, "none");
});
test("take under txn locks; abort restores; commit removes", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 1000);
	assert.equal(c.probe(s, 1, T("Job"), t.id, true).status, "found");
	assert.equal(c.probe(s, 1, T("Job"), null, false).status, "locked"); // conflict, not "none"
	c.abortTxn(s, 2, t.id);
	assert.equal(c.probe(s, 3, T("Job"), null, false).status, "found");
	const u = c.createTxn(s, 3, 1000); c.probe(s, 3, T("Job"), u.id, true); c.commitTxn(s, 4, u.id);
	assert.equal(c.probe(s, 5, T("Job"), null, false).status, "none");
});
test("crashed worker: txn lease expiry returns the taken entry", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 100); c.probe(s, 1, T("Job"), t.id, true);
	assert.equal(c.probe(s, 50, T("Job"), null, true).status, "locked");
	assert.equal(c.probe(s, 100, T("Job"), null, true).status, "found");
});
test("read lock: others may read but not take", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 1000); c.probe(s, 1, T("Job"), t.id, false);
	assert.equal(c.probe(s, 2, T("Job"), null, false).status, "found");
	assert.equal(c.probe(s, 2, T("Job"), null, true).status, "locked");
});
test("operation under unknown/expired txn throws TransactionError", () => {
	const s = mk(); const t = c.createTxn(s, 0, 10);
	assert.throws(() => c.write(s, 10, job(1), t.id, 100), c.TransactionError);
});
test("notify: seq strictly increases; fires on commit; not for written-and-taken in one txn", () => {
	const s = mk(); const r = c.notify(s, 0, T("Job"), null, c.FOREVER, "hb", "conv1");
	c.write(s, 1, job(1), null, c.FOREVER); c.write(s, 1, job(2), null, c.FOREVER);
	assert.deepEqual(s.outbox.map((e) => e.seq), [1, 2]);
	assert.equal(s.outbox[0]!.handback, "hb"); assert.equal(s.outbox[0]!.eventId, r.eventId);
	s.outbox = [];
	const t = c.createTxn(s, 2, 1000);
	c.write(s, 2, job(3), t.id, c.FOREVER);
	assert.equal(s.outbox.length, 0); // not before commit
	c.commitTxn(s, 3, t.id);
	assert.equal(s.outbox.length, 1); assert.equal(s.outbox[0]!.seq, 3);
	s.outbox = [];
	const u = c.createTxn(s, 4, 1000); c.write(s, 4, job(4), u.id, c.FOREVER); c.probe(s, 4, T("Job", { n: 4 }), u.id, true); c.commitTxn(s, 5, u.id);
	assert.equal(s.outbox.length, 0);
});
test("notify under txn also sees writes under that txn, dropped on completion", () => {
	const s = mk(); const t = c.createTxn(s, 0, 1000);
	c.notify(s, 0, T("Job"), t.id, c.FOREVER, null, null);
	c.write(s, 1, job(1), t.id, c.FOREVER);
	assert.equal(s.outbox.length, 1);
	c.commitTxn(s, 2, t.id); assert.equal(s.regs.length, 0);
});

test("waiter: served by a later write, entry taken under a txn that returns on lease expiry", () => {
	const s = mk();
	c.addWaiter(s, 0, { template: T("Job"), take: true, target: "c1", timeout: 10_000, txnLeaseMs: 500, handback: "h" });
	assert.equal(s.outbox.length, 0);
	c.write(s, 1, job(1), null, c.FOREVER);
	assert.equal(s.outbox.length, 1);
	const ev = s.outbox[0]!;
	assert.equal(ev.kind, "waiter"); assert.equal(ev.entry!.fields.n, 1); assert.ok(ev.txn);
	assert.equal(s.waiters.length, 0);
	assert.equal(c.probe(s, 2, T("Job"), null, true).status, "locked"); // held for the waiter
	assert.equal(c.probe(s, 600, T("Job"), null, true).status, "found"); // lease lapsed: back in the space
});
test("waiter: commit of the held txn makes the take permanent", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	c.addWaiter(s, 1, { template: T("Job"), take: true, target: "c1", timeout: 1000 }); // served at once
	c.commitTxn(s, 2, s.outbox[0]!.txn!);
	assert.equal(c.probe(s, 3, T("Job"), null, false).status, "none");
});
test("waiter: read-waiter does not remove; timeout event when nothing arrives", () => {
	const s = mk();
	c.addWaiter(s, 0, { template: T("A"), take: false, target: "c1", timeout: 100 });
	c.addWaiter(s, 0, { template: T("B"), take: true, target: "c2", timeout: 100 });
	c.write(s, 10, { type: "A", fields: {} }, null, c.FOREVER);
	assert.equal(s.outbox[0]!.kind, "waiter"); assert.equal(c.probe(s, 11, T("A"), null, false).status, "found");
	c.settle(s, 100);
	assert.deepEqual(s.outbox.slice(1).map((e) => [e.kind, e.target]), [["timeout", "c2"]]);
});
test("waiter: entry returned by an aborted txn serves a waiting taker; two waiters get distinct entries", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 1000); c.probe(s, 1, T("Job"), t.id, true);
	c.addWaiter(s, 2, { template: T("Job"), take: true, target: "c1", timeout: 10_000 });
	assert.equal(s.outbox.length, 0);
	c.abortTxn(s, 3, t.id);
	assert.equal(s.outbox.length, 1);
	c.addWaiter(s, 4, { template: T("Job"), take: true, target: "c2", timeout: 10_000 });
	c.write(s, 5, job(2), null, c.FOREVER);
	assert.deepEqual(s.outbox.map((e) => e.entry!.fields.n), [1, 2]);
});

test("nextExpiry covers registrations and waiters, and survives huge states", () => {
	const s = mk(); c.notify(s, 0, null, null, 500, null, null);
	assert.equal(c.nextExpiry(s), 500);
	c.addWaiter(s, 0, { template: null, take: true, target: "x", timeout: 100 });
	assert.equal(c.nextExpiry(s), 100);
	for (let i = 0; i < 200_000; i++) s.entries.push({ id: `e${i}`, type: "J", types: ["J"], fields: {}, expires: 1000 + i, writtenUnder: null, takenBy: null, readBy: [] });
	assert.equal(c.nextExpiry(s), 100);
});
test("waiters can be cancelled and renewed through the lease API; cancel sends no timeout", () => {
	const s = mk(); const w = c.addWaiter(s, 0, { template: T("A"), take: true, target: "x", timeout: 100 });
	assert.equal(c.renew(s, 10, w, 500), 510);
	c.cancel(s, 20, w);
	assert.equal(s.waiters.length, 0); c.settle(s, 1000); assert.equal(s.outbox.length, 0);
	assert.throws(() => c.cancel(s, 21, w), c.UnknownLeaseError);
});
test("waiter txn lease follows lease rules: ANY gets the default, negatives throw", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	c.addWaiter(s, 1, { template: T("Job"), take: true, target: "x", timeout: 100, txnLeaseMs: c.ANY });
	assert.equal(Object.values(s.txns)[0]!.expires, 1 + c.DEFAULT_LEASE_MS);
	assert.throws(() => c.addWaiter(s, 2, { template: null, take: true, target: "x", timeout: 1, txnLeaseMs: -5 }), c.IllegalArgumentError);
});
test("undefined template fields are wildcards like null", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	assert.equal(c.probe(s, 1, T("Job", { n: 1, status: undefined as any }), null, false).status, "found");
});
test("types are preserved in what read/take return and deduplicated on write", () => {
	const s = mk(); c.write(s, 0, { type: "MyType", types: ["Base", "MyType"], fields: {} }, null, c.FOREVER);
	assert.deepEqual(s.entries[0]!.types, ["MyType", "Base"]);
	assert.deepEqual(c.view((c.probe(s, 1, null, null, true) as any).entry).types, ["MyType", "Base"]);
});
test("migrate normalizes old documents", () => {
	const m = c.migrate({ entries: [{ id: "e1", type: "J", fields: {}, expires: 5 }], outbox: undefined }, 2);
	assert.deepEqual(m.outbox, []); assert.deepEqual(m.entries[0]!.types, ["J"]); assert.deepEqual(m.entries[0]!.readBy, []);
});
