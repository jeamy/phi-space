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
