// AP 0.1: the persistent test harness itself, and the first recovery regression on top of it.
import test from "node:test";
import assert from "node:assert/strict";
import type { StoreTx as Tx } from "../src/store/types.ts";
import { defineDoc } from "../src/store/documents.ts";
import { PhiSpaces, FOREVER, type Once } from "../src/index.ts";
import { forEachBackend, InjectedFault, ctx } from "./support/persistent.ts";

test("persistent home: committed writes survive close and crash", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		await new PhiSpaces(h, ctx).write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await home.close(h);
		h = await home.open();
		await new PhiSpaces(h, ctx).write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		home.crash(h);
		h = await home.open();
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 2);
	});
});

test("fault switch: failBeforeCommit writes nothing, loseAnswer is durable but reported as failed", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		home.faults.arm("failBeforeCommit");
		await assert.rejects(new PhiSpaces(h, ctx).write({ type: "Job", fields: { n: 1 } }, null, FOREVER), InjectedFault);
		home.crash(h);
		h = await home.open();
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 0);
		home.faults.arm("loseAnswer");
		await assert.rejects(new PhiSpaces(h, ctx).write({ type: "Job", fields: { n: 2 } }, null, FOREVER), InjectedFault);
		home.crash(h);
		h = await home.open();
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 1);
		assert.equal(home.faults.fired, 2);
	});
});

// The exactly-once hook a durable caller uses today: the outcome is recorded in the commit that decides it. A take
// whose answer is lost returns the same entry after a restart instead of taking a second one.
const Outcome = defineDoc<{ done: boolean; value: any }>({ kind: "test.outcome", version: 1, scope: "session", initial: () => ({ done: false, value: null }) });
const once: Once = {
	get: async (tx: Tx) => { const d = await tx.doc(Outcome); return d.done ? d.value : undefined; },
	set: async (tx: Tx, v) => { const d = await tx.doc(Outcome); d.done = true; d.value = v; },
};

test("take with lost answer: after reopen the retry returns the same entry, no second take", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const s = new PhiSpaces(h, ctx);
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		await s.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
		home.faults.arm("loseAnswer", (b) => b.ops.length > 0);
		await assert.rejects(s.take({ type: "Job" }, 0, { once }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const retry = await new PhiSpaces(h, ctx).take({ type: "Job" }, 0, { once });
		assert.equal(retry?.fields.n, 1);
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 1, "exactly one entry was taken");
	});
});

