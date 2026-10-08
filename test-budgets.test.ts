// AP 0.2: byte accounting per part of the document and the budgets that act before a mutation.
import test from "node:test";
import assert from "node:assert/strict";
import { core, claims } from "./src/index.ts";
import type { RpcState } from "./src/claims.ts";

const enc = new TextEncoder();
const bytes = (v: unknown) => enc.encode(JSON.stringify(v)).length;
const alice = { peerId: "peer-a", agentId: "w1" };
const exact = (r: RpcState) => Object.entries(r.claims).reduce((n, [k, v]) => n + bytes(k) + bytes(v) + 2, 0) + Object.entries(r.generations).reduce((n, [k, v]) => n + bytes(k) + bytes(v) + 2, 0);

function request(s: core.SpaceState, now: number, g: string, id: string, result: core.Json = null) {
	const a = claims.admit(s, now, { principal: alice, generation: g, requestId: id }, "write", { id }, now + 1000);
	if (a.kind === "fresh") claims.decide(s, now, a.key, { state: "done", result });
	return a;
}

test("stats reports bytes per part and the whole document", () => {
	const s = core.initialState();
	const empty = core.stats(s, 0).bytes!;
	assert.equal(empty.entries, 0);
	core.write(s, 0, { type: "Job", fields: { n: "x".repeat(500) } }, null, core.FOREVER);
	core.notify(s, 0, { type: "Job" }, null, core.FOREVER, { h: 1 }, "conv-1");
	core.addWaiter(s, 0, { template: { type: "Other" }, take: true, target: "conv-1", timeout: core.FOREVER });
	const b = core.stats(s, 0).bytes!;
	assert.ok(b.entries >= 500 && b.registrations > 0 && b.waiters > 0 && b.outbox > 0, JSON.stringify(b));
	assert.ok(b.total >= b.entries + b.registrations + b.waiters + b.outbox, "the whole is at least the sum of the parts' contents");
	assert.equal(b.total, bytes(s));
});

test("the claim tally equals the measured size through admit, decide, retention and removal", () => {
	const s = core.initialState();
	core.setLimits(s, { claimResultMs: 1000, generationAdmitMs: 5000 });
	const { generation } = claims.issueGeneration(s, 0, alice);
	for (let i = 0; i < 20; i++) request(s, 10 + i, generation, `r${i}`, { echo: "y".repeat(i * 7) });
	assert.equal(s.rpc!.bytes, exact(s.rpc!), "after admit and decide");
	claims.sweep(s, 1500); // results expire (hashes stay)
	assert.equal(s.rpc!.bytes, exact(s.rpc!), "after result retention");
	claims.sweep(s, 9000); // generation closed: claims and generation go
	assert.deepEqual(Object.keys(s.rpc!.claims), []);
	assert.equal(s.rpc!.bytes, exact(s.rpc!), "after removal");
	assert.equal(s.rpc!.bytes, 0);
});

test("a fresh request is refused above the claim budget; known requests stay answerable", () => {
	const s = core.initialState();
	const { generation } = claims.issueGeneration(s, 0, alice);
	request(s, 1, generation, "first", { v: 1 });
	core.setLimits(s, { maxClaimBytes: core.claimBytes(s) }); // exactly full
	assert.throws(() => request(s, 2, generation, "second"), core.LimitError);
	assert.equal(Object.keys(s.rpc!.claims).length, 1, "the refused request left no claim behind");
	const again = request(s, 3, generation, "first", { v: 1 });
	assert.equal(again.kind, "done", "a decided request is still answered from storage");
	assert.equal(s.rpc!.bytes, exact(s.rpc!));
});

test("undelivered events are backpressure: no new subscription or wait above the budget, no event is dropped", () => {
	const s = core.initialState();
	core.setLimits(s, { maxOutboxBytes: 1024 });
	core.notify(s, 0, { type: "Job" }, null, core.FOREVER, null, "conv-1");
	for (let i = 0; i < 20; i++) core.write(s, 0, { type: "Job", fields: { pad: "z".repeat(200), i } }, null, core.FOREVER);
	const queued = s.outbox.length;
	assert.ok(queued > 0 && bytes(s.outbox) > 1024, "events pile up past the budget");
	assert.throws(() => core.notify(s, 1, { type: "Job" }, null, core.FOREVER, null, "conv-2"), core.LimitError);
	assert.throws(() => core.addWaiter(s, 1, { template: { type: "Nothing" }, take: false, target: "conv-2", timeout: 1000 }), core.LimitError);
	assert.equal(s.outbox.length, queued, "nothing was dropped");
	s.outbox.length = 0; // delivered
	core.notify(s, 2, { type: "Job" }, null, core.FOREVER, null, "conv-2"); // works again
});

test("the document budget counts claims and queued events with the entries", () => {
	const s = core.initialState();
	core.write(s, 0, { type: "Job", fields: { a: "x".repeat(100) } }, null, core.FOREVER);
	const used = core.stats(s, 0).bytes!;
	core.setLimits(s, { maxDocBytes: used.entries + core.overheadBytes(s) + 50 });
	assert.throws(() => core.write(s, 1, { type: "Job", fields: { b: "y".repeat(100) } }, null, core.FOREVER), core.LimitError);
	core.setLimits(s, { maxDocBytes: 10_000 });
	core.write(s, 2, { type: "Job", fields: { b: "y".repeat(100) } }, null, core.FOREVER);
});

// ---- byte-bounded pages (AP 1.4, federation-plan-v3 4.2 / 6.2 "Seitengrößen")

function fill(s: core.SpaceState, n: number, pad = (i: number) => (i * 37) % 300) {
	for (let i = 0; i < n; i++) core.write(s, 0, { type: "Job", fields: { i, pad: "p".repeat(pad(i)) } }, null, core.FOREVER);
}
function pages(s: core.SpaceState, maxBytes: number, tmpl: core.Template = null) {
	const out: core.EntryView[][] = [];
	let after: string | null = null;
	for (let guard = 0; guard < 10_000; guard++) {
		const p = core.listPage(s, 1, tmpl, null, { maxBytes, after });
		assert.ok(bytes(p) <= maxBytes, `a page of ${bytes(p)} bytes exceeds its budget ${maxBytes}`);
		if (p.items.length === 0) { assert.equal(p.next, null); break; }
		out.push(p.items);
		if (p.next === null) break;
		after = p.next;
	}
	return out;
}

test("pages are limited by encoded bytes and add up to the whole list, in order, without gaps or repeats", () => {
	const s = core.initialState();
	fill(s, 200);
	const all = core.list(s, 1);
	for (const budget of [2_000, 5_000, 40_000]) {
		const ps = pages(s, budget);
		assert.deepEqual(ps.flat().map((e) => e.id), all.map((e) => e.id), `budget ${budget}`);
		assert.ok(ps.length > 1 || budget > 30_000);
	}
});

test("paging is not capped by the 1000 entries of readAll", () => {
	const s = core.initialState();
	fill(s, 1500, () => 0);
	const got = pages(s, 64_000).flat();
	assert.equal(got.length, 1500);
	assert.equal(core.list(s, 1).length, 1000, "readAll keeps its own cap");
});

test("a budget too small for the next entry: ResponseBudgetTooSmall with requiredBytes, nothing advances, the retry fits", () => {
	const s = core.initialState();
	fill(s, 5, () => 200);
	let err: unknown;
	try { core.listPage(s, 1, null, null, { maxBytes: 100 }); } catch (e) { err = e; }
	assert.ok(err instanceof core.ResponseBudgetTooSmall);
	const need = (err as core.ResponseBudgetTooSmall).requiredBytes;
	assert.ok(need > 100 && need <= core.DEFAULT_LIMITS.maxFrameBytes);
	const p = core.listPage(s, 1, null, null, { maxBytes: need });
	assert.equal(p.items.length, 1, "at least one entry, exactly the one that was announced");
	assert.deepEqual(core.listPage(s, 1, null, null, { maxBytes: need }), p, "same call, same page: no state moved");
	// the next entry is where the cursor says
	const nextNeed = (() => { try { core.listPage(s, 1, null, null, { maxBytes: 100, after: p.next }); } catch (e) { return (e as core.ResponseBudgetTooSmall).requiredBytes; } return 0; })();
	assert.ok(nextNeed > 0);
});

test("entries removed while paging neither break the cursor nor repeat others", () => {
	const s = core.initialState();
	fill(s, 60, () => 100);
	const first = core.listPage(s, 1, null, null, { maxBytes: 3_000 });
	assert.ok(first.next);
	for (const e of [...first.items.slice(0, 2), ...core.list(s, 1).slice(30, 33)]) core.cancel(s, 1, e.id); // already delivered ones and ones still ahead
	const rest = pages(s, 3_000).flat();
	assert.equal(new Set(rest.map((e) => e.id)).size, rest.length, "no repeats");
	const seen = new Set(first.items.map((e) => e.id));
	const stillThere = core.list(s, 1).map((e) => e.id);
	const cont: string[] = [];
	let after: string | null = first.next;
	while (after !== null) { const p = core.listPage(s, 1, null, null, { maxBytes: 3_000, after }); cont.push(...p.items.map((e) => e.id)); after = p.next; }
	assert.deepEqual([...seen, ...cont].filter((id) => stillThere.includes(id)).sort(), stillThere.slice().sort(), "everything that remains was delivered once");
});

test("bad budgets and cursors are rejected, an entry past the frame is a configuration error", () => {
	const s = core.initialState();
	fill(s, 3);
	for (const maxBytes of [0, -5, 1.5, Number.NaN]) assert.throws(() => core.listPage(s, 1, null, null, { maxBytes }), core.IllegalArgumentError);
	assert.throws(() => core.listPage(s, 1, null, null, { after: "abc" }), core.IllegalArgumentError);
	core.setLimits(s, { maxFrameBytes: 500 });
	assert.ok(core.listPage(s, 1, null, null, { maxBytes: 10_000_000 }).items.length >= 1, "the frame caps a larger request");
});

test("a write whose event could exceed maxEventBytes is refused before it changes anything", () => {
	const s = core.initialState();
	core.write(s, 0, { type: "Job", fields: { ok: 1 } }, null, core.FOREVER); // no registration: no event, fine at any size
	core.notify(s, 0, { type: "Job" }, null, core.FOREVER, { tag: "h".repeat(300) }, "conv-1");
	core.setLimits(s, { maxEventBytes: 1_000 });
	const before = s.entries.length;
	assert.throws(() => core.write(s, 1, { type: "Job", fields: { big: "b".repeat(900) } }, null, core.FOREVER), core.ResourceExhausted);
	assert.equal(s.entries.length, before, "the refused write left no entry");
	assert.ok(core.write(s, 1, { type: "Job", fields: { small: 1 } }, null, core.FOREVER).id, "a small one still works");
});
