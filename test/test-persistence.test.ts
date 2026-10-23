// AP 0.1: the persistent test harness itself, and the first recovery regression on top of it.
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, type Tx } from "@earendil-works/pi-durable";
import { defineDoc } from "../src/store/documents.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { PhiSpaces, FOREVER, Space, type Once } from "../src/index.ts";
import { spaces } from "../src/agent.ts";
import { forEachBackend, InjectedFault, ctx, PI_DURABLE_BACKENDS, type PersistentHome } from "./support/persistent.ts";

/** Tests of pi-durable itself (its agent tools, its base checkpoints): not the own store. */
const forEachPiDurable = (f: (home: PersistentHome) => Promise<void>) => forEachBackend(f, PI_DURABLE_BACKENDS);

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
		home.faults.arm("loseAnswer", (writes) => writes.length > 0);
		await assert.rejects(s.take({ type: "Job" }, 0, { once }), InjectedFault);
		home.crash(h);
		h = await home.open();
		const retry = await new PhiSpaces(h, ctx).take({ type: "Job" }, 0, { once });
		assert.equal(retry?.fields.n, 1);
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Job" }), 1, "exactly one entry was taken");
	});
});

// Regression: a tool whose commit was durable but whose task did not finish runs again after the restart and finds
// its claim. It used to return the claim's draft from the commit, unreadable afterwards ("settled overlay"), so the
// model got a tool error instead of the transaction it had begun.
test("tool replay after a crash returns the stored result, not an error, and begins no second transaction", async () => {
	await forEachPiDurable(async (home) => {
		const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
		const registry = createRegistry(); registry.install(spaces);
		const agent = { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] };
		faux.setResponses([fauxAssistantMessage(fauxToolCall("space_txn", { action: "begin", leaseMs: "forever" }), { stopReason: "toolUse" }), fauxAssistantMessage("begun"), fauxAssistantMessage("begun")]);
		let h = await home.open({ models, registry });
		const a = await h.root(ctx, { agent });
		home.faults.arm("loseAnswer", (w) => JSON.stringify(w).includes("phi-spaces.claim"));
		const sub = await a.submit({ type: "input", content: "begin" }, ctx);
		void sub.wait(ctx).catch(() => {}); // the crashed harness never settles it
		for (let i = 0; i < 100 && home.faults.fired === 0; i++) await new Promise((r) => setTimeout(r, 20));
		assert.equal(home.faults.fired, 1);
		home.crash(h);
		h = await home.open({ models, registry });
		const root = await h.root(ctx, { agent });
		await root.waitForIdle(ctx);
		const txns = Object.values((await h.snapshot(Space, ctx))!.txns);
		assert.equal(txns.length, 1);
		const page: any = await h.commit((tx) => tx.scanEntries({ conversationId: root.id } as any, 100), ctx);
		const results = JSON.stringify(page.items ?? page.entries ?? []);
		assert.ok(results.includes(txns[0]!.id), "the replayed tool result names the transaction");
		assert.ok(!results.includes("settled overlay"));
	});
});

// Without a primary/sync storage in the process, Space bases are written every 500 deltas, whatever their size.
test("a Space gets a base every 500 deltas", async () => {
	await forEachPiDurable(async (home) => {
		let h = await home.open();
		for (let n = 0; n < 510; n++) await new PhiSpaces(h, ctx).write({ type: "Small", fields: { n } }, null, FOREVER);
		await home.close(h);
		const st = await home.storage(), d = await st.findDocument({ kind: "phi-spaces.space", scope: { kind: "session" } } as any, "current", ctx);
		try { assert.ok(d && (await st.document(d.id, "current", ctx))!.deltasSinceBase < 500, "a base was written"); } finally { await st.close(ctx); }
	});
});
