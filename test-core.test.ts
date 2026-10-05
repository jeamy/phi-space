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
	assert.equal(c.write(s, 0, job(2), null, c.FOREVER).expires, c.FOREVER);
	assert.throws(() => c.write(s, 0, job(3), null, -5), c.IllegalArgumentError);
	assert.throws(() => c.write(s, 0, job(3), null, NaN), c.IllegalArgumentError);
});
test("FOREVER is forever and long leases are granted as asked, without overflow", () => {
	const s = mk(); const now = 1_700_000_000_000; const year = 365 * 24 * 3600 * 1000;
	const forever = c.write(s, now, job(1), null, c.FOREVER);
	const months = c.write(s, now, job(2), null, 90 * 24 * 3600 * 1000);
	assert.equal(forever.expires, c.FOREVER); assert.equal(months.expires, now + 90 * 24 * 3600 * 1000);
	assert.equal(c.write(s, now, job(3), null, Infinity).expires, c.FOREVER);
	assert.equal(c.probe(s, now + 100 * year, T("Job", { n: 1 }), null, false).status, "found");
	assert.equal(c.probe(s, now + 100 * year, T("Job", { n: 2 }), null, false).status, "none");
	const t = c.createTxn(s, now, c.FOREVER); assert.equal(t.expires, c.FOREVER);
	assert.equal(c.renew(s, now, forever.id, c.FOREVER), c.FOREVER);
	const w = c.addWaiter(s, now, { template: T("Never"), take: true, target: 1, timeout: c.FOREVER, txnLeaseMs: c.FOREVER });
	c.settle(s, now + 100 * year);
	assert.equal(s.waiters.find((x) => x.id === w)?.deadline, c.FOREVER); assert.equal(s.outbox.length, 0); // never times out
	c.write(s, now + 100 * year, { type: "Never", fields: {} }, null, c.ANY);
	assert.equal(s.outbox[0]!.kind, "waiter"); assert.equal(s.txns[s.outbox[0]!.txn!]!.expires, c.FOREVER); // held forever, too
	assert.equal(c.nextExpiry(mk()), c.FOREVER);
});
test("bad timeouts and entries are rejected instead of silently dropped", () => {
	const s = mk();
	assert.throws(() => c.addWaiter(s, 0, { template: null, take: true, target: 1, timeout: NaN }), c.IllegalArgumentError);
	assert.throws(() => c.addWaiter(s, 0, { template: null, take: true, target: 1, timeout: -1 }), c.IllegalArgumentError);
	assert.throws(() => c.write(s, 0, { type: "J" } as any, null, 100), c.IllegalArgumentError);
	assert.throws(() => c.write(s, 0, { type: "", fields: {} }, null, 100), c.IllegalArgumentError);
	assert.equal(s.waiters.length, 0); assert.equal(s.entries.length, 0);
});
test("lazy settle replays lapses in time order: a txn expiring before a waiter's deadline serves the waiter", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 5); c.probe(s, 0, T("Job"), t.id, true);
	c.addWaiter(s, 0, { template: T("Job"), take: true, target: 1, timeout: 10 });
	c.settle(s, 20); // nobody looked between 5 and 20
	assert.deepEqual(s.outbox.map((e) => e.kind), ["waiter"]);
	const held = s.txns[s.outbox[0]!.txn!]!; assert.equal(held.expires, 5 + c.DEFAULT_LEASE_MS); // granted at 5, not at 20
});
test("ownership: a conversation uses only its own transactions and leases (never ownerless ones); host code may do anything", () => {
	const s = mk();
	const t = c.createTxn(s, 0, 1000, "A");
	assert.throws(() => c.commitTxn(s, 1, t.id, "B"), c.PermissionError);
	assert.throws(() => c.abortTxn(s, 1, t.id, "B"), c.PermissionError);
	assert.throws(() => c.write(s, 1, job(1), t.id, 100, "B"), c.PermissionError);
	assert.throws(() => c.probe(s, 1, T("Job"), t.id, true, "B"), c.PermissionError);
	assert.throws(() => c.cancel(s, 1, t.id, "B"), c.PermissionError);
	const e = c.write(s, 1, job(1), null, c.FOREVER, "A");
	assert.throws(() => c.cancel(s, 2, e.id, "B"), c.PermissionError);
	assert.throws(() => c.renew(s, 2, e.id, 5, "B"), c.PermissionError);
	c.renew(s, 2, e.id, 500, "A");
	const w = c.addWaiter(s, 2, { template: T("X"), take: true, target: "A", timeout: 100 });
	assert.throws(() => c.cancel(s, 3, w, "B"), c.PermissionError);
	const n = c.notify(s, 3, T("Job"), null, 100, null, "A", "A");
	assert.throws(() => c.cancel(s, 3, n.eventId, "B"), c.PermissionError);
	const open = c.createTxn(s, 3, 1000); // host-created: ownerless, so only the host may use it
	assert.throws(() => c.write(s, 3, job(2), open.id, 100, "B"), c.PermissionError);
	assert.throws(() => c.commitTxn(s, 4, open.id, "C"), c.PermissionError);
	c.write(s, 3, job(2), open.id, 100); c.commitTxn(s, 4, open.id); // host
	c.commitTxn(s, 4, t.id); // host
	c.cancel(s, 5, w); // host
	assert.equal(s.waiters.length, 0);
});
test("a served take-waiter's transaction belongs to the waiting conversation", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	c.addWaiter(s, 1, { template: T("Job"), take: true, target: "A", timeout: 1000 });
	const txn = s.outbox[0]!.txn!;
	assert.throws(() => c.commitTxn(s, 2, txn, "B"), c.PermissionError);
	c.commitTxn(s, 2, txn, "A");
	assert.equal(c.probe(s, 3, T("Job"), null, false).status, "none");
});
test("releaseTxn aborts an active transaction and serves the returned entry; a finished one is ignored", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER);
	c.addWaiter(s, 1, { template: T("Job"), take: true, target: "A", timeout: 1000 });
	c.addWaiter(s, 1, { template: T("Job"), take: true, target: "B", timeout: 1000 });
	const first = s.outbox[0]!;
	assert.equal(c.releaseTxn(s, 2, first.txn!), true);
	assert.deepEqual(s.outbox.map((e) => e.target), ["A", "B"]); // back in the space, handed to the next waiter
	assert.equal(c.releaseTxn(s, 3, first.txn!), false);
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
	for (let i = 0; i < 200_000; i++) s.entries.push({ id: `e${i}`, type: "J", types: ["J"], fields: {}, expires: 1000 + i, writtenUnder: null, takenBy: null, readBy: [], owner: null });
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
	const m = c.migrate({ entries: [{ id: "e1", type: "J", fields: {}, expires: 5 }], txns: { t2: { id: "t2", expires: 9 } }, regs: [{ id: "n3", expires: 9 }], outbox: undefined }, 2);
	assert.deepEqual(m.outbox, []); assert.deepEqual(m.entries[0]!.types, ["J"]); assert.deepEqual(m.entries[0]!.readBy, []);
	assert.equal(m.entries[0]!.owner, null); assert.equal(m.txns.t2!.owner, null); assert.equal(m.regs[0]!.seq, 0);
});

test("lease 0: the entry is born expired and is never announced, served or held", () => {
	const s = mk();
	c.notify(s, 0, T("J"), null, c.FOREVER, null, 1);
	c.addWaiter(s, 0, { template: T("J"), take: true, target: 2, timeout: 1000 });
	const l = c.write(s, 5, { type: "J", fields: {} }, null, 0);
	assert.equal(l.expires, 5);
	assert.equal(s.outbox.length, 0); assert.equal(s.waiters.length, 1); assert.equal(Object.keys(s.txns).length, 0);
	assert.equal(c.probe(s, 5, T("J"), null, false).status, "none");
});
test("a registration under txn T also receives plain committed writes (spec: in addition)", () => {
	const s = mk(); const t = c.createTxn(s, 0, 1000);
	c.notify(s, 0, T("J"), t.id, c.FOREVER, null, 1);
	c.write(s, 1, { type: "J", fields: {} }, null, c.FOREVER);
	assert.equal(s.outbox.length, 1);
	c.write(s, 2, { type: "J", fields: {} }, t.id, c.FOREVER); // under T: also seen
	assert.equal(s.outbox.length, 2);
	const u = c.createTxn(s, 3, 1000); c.write(s, 3, { type: "J", fields: {} }, u.id, c.FOREVER); // other txn: not yet
	assert.equal(s.outbox.length, 2);
	c.commitTxn(s, 4, u.id); assert.equal(s.outbox.length, 3); // published: committed write reaches T's registration
});

test("count and stats see only what a read would see, and break the rest down", () => {
	const s = mk();
	c.write(s, 0, job(1), null, c.FOREVER); c.write(s, 0, job(2), null, c.FOREVER);
	c.write(s, 0, { type: "Other", fields: {} }, null, c.FOREVER);
	c.write(s, 0, job(3), null, 50); // expires at 50
	const t = c.createTxn(s, 0, 1000);
	c.probe(s, 1, T("Job", { n: 1 }), t.id, true); // locked by t
	c.write(s, 1, job(4), t.id, c.FOREVER); // uncommitted
	c.notify(s, 1, null, null, c.FOREVER, null, 1);
	c.addWaiter(s, 1, { template: T("Never"), take: true, target: 1, timeout: 1000 });
	assert.equal(c.count(s, 10), 3); // job2, job3 (not yet expired), Other
	assert.equal(c.count(s, 10, T("Job")), 2);
	assert.equal(c.count(s, 10, T("Job"), t.id), 3); // t also sees its own uncommitted write
	assert.equal(c.count(s, 100), 2); // job3 expired
	assert.deepEqual(c.stats(s, 10), { entries: 3, byType: { Job: 2, Other: 1 }, locked: 1, uncommitted: 1, expired: 0, txns: 1, waiters: 1, registrations: 1, outbox: 0, returned: 0 });
	assert.equal(c.stats(s, 100).expired, 1);
	assert.equal(c.count(s, 10, { type: "Nope" }), 0);
});
test("count and stats on an unsettled snapshot agree with what a read would see after settling", () => {
	const s = mk();
	c.write(s, 0, job(1), null, c.FOREVER);
	const t = c.createTxn(s, 0, 5);
	c.probe(s, 0, T("Job"), t.id, true); // taken under t, which lapses at 5
	c.write(s, 0, job(2), t.id, c.FOREVER); // written under t: discarded when it lapses
	c.addWaiter(s, 0, { template: T("Never"), take: true, target: 1, timeout: 5 });
	const snap = structuredClone(s); // nobody settles before 10
	assert.equal(c.count(snap, 10), 1);
	assert.equal(c.count(snap, 10, T("Job"), t.id), 1); // a lapsed txn sees no uncommitted writes of its own
	assert.deepEqual(c.stats(snap, 10), { entries: 1, byType: { Job: 1 }, locked: 0, uncommitted: 0, expired: 1, txns: 0, waiters: 0, registrations: 0, outbox: 0, returned: 1 });
	assert.equal(c.probe(s, 10, T("Job"), null, false).status, "found"); // what a read sees
	assert.deepEqual(c.stats(s, 10), { ...c.stats(snap, 10), expired: 0, outbox: 1 }); // settled: gone, timeout queued
});
test("returned counts entries given back by aborted and expired transactions, durably", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER); c.write(s, 0, job(2), null, c.FOREVER);
	const a = c.createTxn(s, 0, 1000); c.probe(s, 0, T("Job", { n: 1 }), a.id, true); c.abortTxn(s, 1, a.id);
	const b = c.createTxn(s, 1, 5); c.probe(s, 1, T("Job", { n: 2 }), b.id, true); c.settle(s, 10);
	const d = c.createTxn(s, 10, 1000); c.probe(s, 10, T("Job", { n: 1 }), d.id, true); c.commitTxn(s, 11, d.id); // committed: not returned
	assert.equal(s.returned, 2); assert.equal(c.stats(s, 12).returned, 2);
	assert.equal(c.migrate({}, 3).returned, 0);
});

test("agents cannot renew, cancel or abort what the host created", () => {
	const s = mk();
	const e = c.write(s, 0, job(1), null, c.FOREVER); // host entry
	const t = c.createTxn(s, 0, 1000); // host transaction
	const n = c.notify(s, 0, null, null, c.FOREVER, null, "A"); // host-made subscription for A: A owns it as the target
	assert.throws(() => c.cancel(s, 1, e.id, "A"), c.PermissionError);
	assert.throws(() => c.renew(s, 1, e.id, 5, "A"), c.PermissionError);
	assert.throws(() => c.abortTxn(s, 1, t.id, "A"), c.PermissionError);
	assert.throws(() => c.cancel(s, 1, t.id, "A"), c.PermissionError);
	assert.equal(c.probe(s, 1, T("Job"), null, false, "A").status, "found"); // reading host entries is fine
	c.cancel(s, 1, n.eventId, "A"); // its own target: allowed
	c.cancel(s, 1, e.id); // host
	assert.equal(c.count(s, 2), 0);
});
test("limits: entry size, types, counts per owner and in total; host code is not limited", () => {
	const s = mk();
	c.setLimits(s, { maxEntryBytes: 100, maxEntries: 5, maxEntriesPerOwner: 3, maxRegsPerOwner: 2, maxWaitersPerOwner: 2, maxTxnsPerOwner: 2, maxTypes: 3, maxTypeChars: 10 });
	assert.throws(() => c.write(s, 0, { type: "J", fields: { big: "x".repeat(200) } }, null, 1000, "A"), c.LimitError);
	assert.throws(() => c.write(s, 0, { type: "a-very-long-type-name", fields: {} }, null, 1000, "A"), c.LimitError);
	assert.throws(() => c.write(s, 0, { type: "J", types: ["J", "B", "C"], fields: {} }, null, 1000, "A"), c.LimitError);
	for (let i = 0; i < 3; i++) c.write(s, 0, job(i), null, 1000, "A");
	assert.throws(() => c.write(s, 0, job(9), null, 1000, "A"), c.LimitError); // A's own cap
	c.write(s, 0, job(4), null, 1000, "B"); c.write(s, 0, job(5), null, 1000, "B");
	assert.throws(() => c.write(s, 0, job(6), null, 1000, "C"), c.LimitError); // the space is full
	for (let i = 0; i < 10; i++) c.write(s, 0, job(i), null, 1000); // host: no limit
	c.notify(s, 0, T("J"), null, 1000, null, "A", "A"); c.notify(s, 0, T("J"), null, 1000, null, "A", "A");
	assert.throws(() => c.notify(s, 0, T("J"), null, 1000, null, "A", "A"), c.LimitError);
	assert.throws(() => c.notify(s, 0, T("J"), null, 1000, "x".repeat(200), "B", "B"), c.LimitError); // handback size
	c.addWaiter(s, 0, { template: T("Never"), take: true, target: "A", timeout: 1000, as: "A" }); c.addWaiter(s, 0, { template: T("Never"), take: true, target: "A", timeout: 1000, as: "A" });
	assert.throws(() => c.addWaiter(s, 0, { template: T("Never"), take: true, target: "A", timeout: 1000, as: "A" }), c.LimitError);
	c.createTxn(s, 0, 1000, "A"); c.createTxn(s, 0, 1000, "A");
	assert.throws(() => c.createTxn(s, 0, 1000, "A"), c.LimitError);
	assert.throws(() => c.setLimits(s, { maxEntries: 0 }), c.IllegalArgumentError);
	assert.throws(() => c.setLimits(s, { nope: 5 } as any), c.IllegalArgumentError);
});
test("limits free up when entries are taken or expire", () => {
	const s = mk(); c.setLimits(s, { maxEntriesPerOwner: 1 });
	c.write(s, 0, job(1), null, 100, "A");
	assert.throws(() => c.write(s, 1, job(2), null, 100, "A"), c.LimitError);
	c.probe(s, 2, T("Job"), null, true); // taken
	c.write(s, 3, job(3), null, 100, "A");
	c.settle(s, 500); // expired
	c.write(s, 501, job(4), null, 100, "A");
});

test("a conversation's subscription needs a type or a field; host code may subscribe to everything", () => {
	const s = mk();
	assert.throws(() => c.notify(s, 0, null, null, 1000, null, "A", "A"), c.IllegalArgumentError);
	assert.throws(() => c.notify(s, 0, { type: null, fields: { x: null } }, null, 1000, null, "A", "A"), c.IllegalArgumentError);
	c.notify(s, 0, { type: null, fields: { x: 1 } }, null, 1000, null, "A", "A");
	c.notify(s, 0, null, null, 1000, null, "A"); // host
});
test("notify rate limit: bursts are bundled into one event with a count, sent when the interval is over", () => {
	const s = mk(); c.setLimits(s, { notifyIntervalMs: 1000 });
	const n = c.notify(s, 0, T("J"), null, c.FOREVER, "hb", "A", "A");
	const w = (at: number) => c.write(s, at, { type: "J", fields: {} }, null, c.FOREVER);
	w(10); // first event goes out at once
	assert.deepEqual(s.outbox.map((e) => [e.seq, e.count]), [[1, undefined]]);
	w(100); w(200); w(300); // inside the interval: only counted
	assert.equal(s.outbox.length, 1);
	assert.equal(c.nextExpiry(s), 1010); // the bundle is due when the interval ends
	c.settle(s, 1009); assert.equal(s.outbox.length, 1);
	c.settle(s, 1010);
	assert.deepEqual(s.outbox.map((e) => [e.seq, e.count]), [[1, undefined], [2, 3]]); // 3 writes, one event, seq still strictly increasing
	assert.equal(s.outbox[1]!.eventId, n.eventId);
	w(1500); assert.equal(s.outbox.length, 2); // a new interval started at 1010: this one waits
	w(2100); // its interval is over: the waiting one goes out first (a single write: no count), the new one waits in turn
	assert.equal(s.outbox.length, 3); assert.equal(s.outbox[2]!.count, undefined); assert.equal(s.outbox[2]!.seq, 3);
	w(2200); c.settle(s, 3200);
	assert.deepEqual(s.outbox[3]!.count, 2); // 2100 and 2200 bundled
	c.setLimits(s, { notifyIntervalMs: 0 });
	const m = c.notify(s, 2200, T("K"), null, c.FOREVER, null, "A", "A"); // no limit
	c.write(s, 2200, { type: "K", fields: {} }, null, c.FOREVER); c.write(s, 2201, { type: "K", fields: {} }, null, c.FOREVER);
	assert.equal(s.outbox.filter((e) => e.eventId === m.eventId).length, 2);
});
test("a pending bundle is sent when its subscription expires; host subscriptions are not limited", () => {
	const s = mk();
	c.notify(s, 0, T("J"), null, 500, null, "A", "A");
	c.notify(s, 0, T("J"), null, c.FOREVER, null, "H"); // host: no interval
	c.write(s, 10, { type: "J", fields: {} }, null, c.FOREVER); c.write(s, 20, { type: "J", fields: {} }, null, c.FOREVER);
	assert.equal(s.outbox.filter((e) => e.target === "H").length, 2);
	assert.equal(s.outbox.filter((e) => e.target === "A").length, 1);
	c.settle(s, 600); // A's registration expired at 500 with one pending write
	const a = s.outbox.filter((e) => e.target === "A");
	assert.equal(a.length, 2); assert.equal(a[1]!.count, undefined);
});
test("entry views carry the owner so readers can judge where content comes from", () => {
	const s = mk(); c.write(s, 0, job(1), null, c.FOREVER, "A"); c.write(s, 0, job(2), null, c.FOREVER);
	const owners = [c.probe(s, 1, T("Job", { n: 1 }), null, false), c.probe(s, 1, T("Job", { n: 2 }), null, false)].map((p) => c.view((p as any).entry).owner);
	assert.deepEqual(owners, ["A", null]);
});

test("list returns what a read could see, oldest first, capped, without locking anything", () => {
	const s = mk();
	for (let i = 0; i < 5; i++) c.write(s, 0, job(i), null, i === 4 ? 50 : c.FOREVER);
	c.write(s, 0, { type: "Other", fields: {} }, null, c.FOREVER);
	const t = c.createTxn(s, 0, 1000); c.write(s, 0, job(9), t.id, c.FOREVER);
	assert.deepEqual(c.list(s, 10, T("Job")).map((e) => e.fields.n), [0, 1, 2, 3, 4]); // 9 is uncommitted
	assert.deepEqual(c.list(s, 10, T("Job"), t.id).map((e) => e.fields.n), [0, 1, 2, 3, 4, 9]); // its own write is visible
	assert.deepEqual(c.list(s, 100, T("Job")).map((e) => e.fields.n), [0, 1, 2, 3]); // 4 expired
	assert.equal(c.list(s, 10, T("Job"), null, 2).length, 2);
	assert.equal(c.list(s, 10).length, 6); // null template: everything visible
	assert.throws(() => c.list(s, 10, null, null, 0), c.IllegalArgumentError);
	assert.throws(() => c.list(s, 10, null, t.id, 5, "A"), c.PermissionError); // not A's transaction
	assert.equal(s.entries.every((e) => e.readBy.length === 0 && e.takenBy === null), true); // nothing locked
});
