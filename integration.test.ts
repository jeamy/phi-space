import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { JavaSpace, NO_WAIT, FOREVER, Space, deliverEvents, spaces, core, startMaintenance, startService, startDelivery } from "./src/index.ts";

const open = (storage: any, models = createModels()) => Harness.open(storage, { models, registry: createRegistry() }, ctx);
const job = (n: number) => ({ type: "Job", fields: { n } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("blocking take wakes when a matching entry is written", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	const t0 = Date.now();
	const p = s.take({ type: "Job" }, 5000);
	await sleep(150); await s.write(job(1), null, FOREVER);
	const got = await p;
	assert.equal(got?.fields.n, 1); assert.ok(Date.now() - t0 < 2000);
	assert.equal(await s.take({ type: "Job" }, 100), null); // timeout
	await h.close(ctx);
});

test("readIfExists returns at once when nothing matches, read waits", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	let t = Date.now(); assert.equal(await s.readIfExists({ type: "Job" }, 2000), null); assert.ok(Date.now() - t < 500);
	t = Date.now(); assert.equal(await s.read({ type: "Job" }, 300), null); assert.ok(Date.now() - t >= 280);
	await h.close(ctx);
});

test("concurrency: 3 workers, 12 jobs, each taken exactly once", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	for (let i = 0; i < 12; i++) await s.write(job(i), null, FOREVER);
	const worker = async () => {
		const mine: number[] = [];
		for (;;) { const e = await s.takeIfExists({ type: "Job" }, NO_WAIT); if (!e) return mine; mine.push(e.fields.n as number); }
	};
	const all = (await Promise.all([worker(), worker(), worker()])).flat().sort((a, b) => a - b);
	assert.deepEqual(all, [...Array(12).keys()]);
	await h.close(ctx);
});

test("crash: job taken under a txn reappears after reopen once the txn lease expires", async () => {
	const dir = mkdtempSync(join(tmpdir(), "pi-spaces-"));
	let h = await open(await openNodeJsonlStorage(dir, ctx)); let s = new JavaSpace(h, ctx);
	await s.write(job(7), null, FOREVER);
	const t = await s.createTransaction(400);
	assert.equal((await s.take({ type: "Job" }, NO_WAIT, { txn: t.id }))?.fields.n, 7);
	assert.equal(await s.takeIfExists({ type: "Job" }, 50), null); // locked by the open txn
	await h.close(ctx); // "crash": worker never commits
	h = await open(await openNodeJsonlStorage(dir, ctx)); s = new JavaSpace(h, ctx);
	h.resume();
	assert.equal((await s.take({ type: "Job" }, 3000))?.fields.n, 7); // blocks until the lease lapses
	await h.close(ctx);
});

test("tools + notify delivery run end to end with the faux provider", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(spaces);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const agent = { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] };
	const boss = await h.root(ctx, { agent });
	const s = new JavaSpace(h, ctx);
	await s.notify({ type: "Job" }, { lease: FOREVER, handback: "jobs", target: boss.id as unknown as string });
	faux.setResponses([fauxAssistantMessage("saw the event")]);
	await s.write(job(1), null, FOREVER);
	assert.equal(await deliverEvents(h, ctx), 1);
	await boss.waitForIdle(ctx);
	const snap = await h.snapshot(Space, ctx);
	assert.equal(snap?.outbox.length, 0);
	assert.equal(await deliverEvents(h, ctx), 0);
	await h.close(ctx);
});

test("reaper: expired entries are removed and waiters time out without any operation", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	const stop = await startMaintenance(h, ctx);
	await s.write(job(1), null, 150);
	await s.wait({ type: "Never" }, { target: "nobody", timeout: 200 });
	assert.equal((await h.snapshot(Space, ctx))!.entries.length, 1);
	await sleep(450);
	const snap = await h.snapshot(Space, ctx)!; // nobody called an operation: the reaper did it
	assert.equal(snap!.entries.length, 0); assert.equal(snap!.waiters.length, 0);
	assert.equal(snap!.outbox[0]!.kind, "timeout");
	await stop(); await h.close(ctx);
});

test("space_wait: tool returns at once; entry arrives later as a message and is committed by the agent", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(spaces);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const agent = { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] };
	const worker = await h.root(ctx, { agent }); const s = new JavaSpace(h, ctx);
	const stop = await startService(h, ctx);
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_wait", { type: "Job", timeoutMs: 60_000 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("waiting"), // turn ends immediately: no blocked call
	]);
	const t0 = Date.now();
	await (await worker.submit({ type: "input", content: "wait for a job" }, ctx)).wait(ctx);
	assert.ok(Date.now() - t0 < 3000);
	assert.equal((await h.snapshot(Space, ctx))!.waiters.length, 1);
	// A job arrives: the space takes it for the waiter (under a txn) and wakes the worker conversation.
	faux.setResponses([
		(ctxm: any) => fauxAssistantMessage("got it"),
	] as any);
	await s.write(job(9), null, FOREVER);
	for (let i = 0; i < 50 && (await h.snapshot(Space, ctx))!.outbox.length; i++) await sleep(50);
	await worker.waitForIdle(ctx);
	const snap = (await h.snapshot(Space, ctx))!;
	assert.equal(snap.waiters.length, 0); assert.equal(snap.outbox.length, 0);
	assert.equal(Object.keys(snap.txns).length, 1); // held until the worker commits
	const txn = Object.keys(snap.txns)[0]!;
	await s.commit(txn);
	assert.equal(await s.takeIfExists({ type: "Job" }, 50), null);
	await stop(); await h.close(ctx);
});

test("deliverEvents: a failing event does not block the others and is dropped after repeated failures", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(spaces);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const good = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] } });
	faux.setResponses([fauxAssistantMessage("ok")]);
	const s = new JavaSpace(h, ctx);
	await h.commit(async (tx) => { // an event whose conversation lookup throws (malformed id), then a good one
		const d = await tx.doc(Space);
		d.outbox.push({ kind: "timeout", eventId: "bad", seq: 1, handback: null, target: "bad" });
		d.outbox.push({ kind: "timeout", eventId: "good", seq: 1, handback: null, target: good.id as unknown as string });
	}, ctx);
	// The conversation lookup for target "bad" fails, as a temporary storage or submit error would.
	const flaky: any = new Proxy(h, { get: (t: any, k) => k === "conversation" ? (id: any, c: any) => id === "bad" ? Promise.reject(new Error("boom")) : t.conversation(id, c) : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	let clock = Date.now(); const o = { now: () => clock, retryMs: 10 };
	assert.equal(await deliverEvents(flaky, ctx, o), 1); // the good one was delivered despite the bad one before it
	const left = (await h.snapshot(Space, ctx))!.outbox;
	assert.deepEqual(left.map((e) => e.eventId), ["bad"]);
	await deliverEvents(flaky, ctx, o); // too early: backoff, not retried
	assert.equal((await h.snapshot(Space, ctx))!.outbox[0]!.tries, 1);
	for (let i = 0; i < 6; i++) { clock += 1000; await deliverEvents(flaky, ctx, o); }
	assert.equal((await h.snapshot(Space, ctx))!.outbox.length, 0); // poisoned event dropped
	void s; await h.close(ctx);
});

test("blocking take leaves no timers behind when woken early", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	const before = (process as any).getActiveResourcesInfo().filter((x: string) => x === "Timeout").length;
	const p = s.take({ type: "Job" }, 60_000); await sleep(100);
	await s.write(job(1), null, FOREVER); await p;
	await sleep(50);
	const after = (process as any).getActiveResourcesInfo().filter((x: string) => x === "Timeout").length;
	assert.ok(after <= before, `timers before ${before}, after ${after}`);
	await h.close(ctx);
});

test("deliverEvents: events without a target are dropped explicitly and not counted as delivered", async () => {
	const h = await open(new MemoryStorage());
	await h.commit(async (tx) => {
		const d = await tx.doc(Space);
		d.outbox.push({ kind: "timeout", eventId: "n1", seq: 1, handback: null, target: null });
		d.outbox.push({ kind: "timeout", eventId: "n2", seq: 1, handback: null, target: "" });
	}, ctx);
	assert.equal(await deliverEvents(h, ctx), 0);
	assert.equal((await h.snapshot(Space, ctx))!.outbox.length, 0);
	await assert.rejects(() => new JavaSpace(h, ctx).notify(null, { target: "" }), /target/);
	await h.close(ctx);
});

test("reaper survives a failing commit: logs, retries, and keeps cleaning up", async () => {
	const h = await open(new MemoryStorage()); const s = new JavaSpace(h, ctx);
	let fail = false; const errors: unknown[] = [];
	const flaky: any = new Proxy(h, { get: (t: any, k) => k === "commit" ? (f: any, c: any) => fail ? Promise.reject(new Error("disk")) : t.commit(f, c) : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	const stop = await startMaintenance(flaky, ctx, { retryMs: 50, onError: (e) => errors.push(e) });
	await s.write(job(1), null, 120);
	fail = true; await sleep(250); // the expiry tick fails
	assert.ok(errors.length > 0); assert.equal((await h.snapshot(Space, ctx))!.entries.length, 1);
	fail = false; await sleep(200); // the retry succeeds
	assert.equal((await h.snapshot(Space, ctx))!.entries.length, 0);
	await stop(); await h.close(ctx);
});

test("delivery retries a failed event on a timer", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(spaces);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const conv = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] } });
	faux.setResponses([fauxAssistantMessage("ok")]);
	let fail = true;
	const flaky: any = new Proxy(h, { get: (t: any, k) => k === "conversation" ? (id: any, c: any) => fail ? Promise.reject(new Error("temp")) : t.conversation(id, c) : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	const stop = await startDelivery(flaky, ctx, { retryMs: 60, onError: () => {} });
	await new JavaSpace(h, ctx).notify({ type: "Job" }, { target: conv.id as unknown as string, lease: FOREVER });
	await new JavaSpace(h, ctx).write(job(1), null, FOREVER);
	await sleep(200); assert.equal((await h.snapshot(Space, ctx))!.outbox.length, 1); // still queued
	fail = false;
	for (let i = 0; i < 40 && (await h.snapshot(Space, ctx))!.outbox.length; i++) await sleep(50);
	assert.equal((await h.snapshot(Space, ctx))!.outbox.length, 0);
	await stop(); await h.close(ctx);
});

test("space_notify tool subscribes the calling conversation", async () => {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(spaces);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const a = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [spaces] } });
	faux.setResponses([fauxAssistantMessage(fauxToolCall("space_notify", { type: "Job" }), { stopReason: "toolUse" }), fauxAssistantMessage("subscribed")]);
	await (await a.submit({ type: "input", content: "tell me about jobs" }, ctx)).wait(ctx);
	const regs = (await h.snapshot(Space, ctx))!.regs;
	assert.equal(regs.length, 1); assert.equal(regs[0]!.target, a.id as unknown as string);
	faux.setResponses([fauxAssistantMessage("saw it")]);
	await new JavaSpace(h, ctx).write(job(1), null, FOREVER);
	assert.equal(await deliverEvents(h, ctx), 1);
	await h.close(ctx);
});
