// The space tools of a pi-durable agent over a separate space host (the own store): what they do, how events reach the
// conversations, and that a call replayed after an agent crash gets its first outcome.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { BACKGROUND_CONTEXT as ctx, createContextKey } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT as spaceContext, withAbortSignal, withContextValue } from "../../src/context.ts";
import { FOREVER, Meter, PhiSpaces, Space, deliverEvents, openOwnMemoryHost, openSqliteHost, startService, type SpaceLike } from "../../src/index.ts";
import { agentContext, createSpaces, localSpaces, withAgentEventSink as withEventSink, type AgentSpaces } from "../src/agent.ts";

const job = (n: number) => ({ type: "Job", fields: { n } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An agent host (pi-durable, in memory) and its space (the own store, a separate host). */
async function fixture(o: { meter?: Meter; spaces?: (s: AgentSpaces) => AgentSpaces } = {}) {
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const space = openOwnMemoryHost();
	const local = localSpaces(space, o.meter ? { meter: o.meter } : {});
	const ext = createSpaces(o.spaces ? o.spaces(local) : local);
	const registry = createRegistry(); registry.install(ext);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	return {
		faux, h, space, ext,
		agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [ext] },
		/** The space with the agents' conversations as its event sink. */
		service: withEventSink(space, h),
		host: new PhiSpaces(space, ctx),
		snapshot: async () => (await space.snapshot(Space, ctx))!,
		close: async () => { await h.close(ctx); await space.close(ctx); },
	};
}

test("tools + notify delivery run end to end with the faux provider", async () => {
	const f = await fixture();
	const boss = await f.h.root(ctx, { agent: f.agent });
	await f.host.notify({ type: "Job" }, { lease: FOREVER, handback: "jobs", target: boss.id });
	f.faux.setResponses([fauxAssistantMessage("saw the event")]);
	await f.host.write(job(1), null, FOREVER);
	assert.equal(await deliverEvents(f.service, spaceContext), 1);
	await boss.waitForIdle(ctx);
	assert.equal((await f.snapshot()).outbox.length, 0);
	assert.equal(await deliverEvents(f.service, spaceContext), 0);
	await f.close();
});

test("the 1.4 agent context bridge preserves values, cancellation and existing telemetry", () => {
	const key = createContextKey<string>("test.agent-context");
	const abort = new AbortController();
	const original = withAbortSignal(abort.signal, withContextValue(key, "kept", spaceContext));
	const adapted = agentContext(original);
	assert.equal(adapted.value(key), "kept");
	assert.equal(adapted.abortSignal, abort.signal);
	assert.equal(adapted.telemetry, ctx.telemetry);
	assert.equal(agentContext(ctx), ctx);
	abort.abort();
	assert.equal(adapted.abortSignal?.aborted, true);
});

test("space tool output reaches the model through pi-durable 1.4's output channel", async t => {
	const f = await fixture();
	t.after(() => f.close());
	await f.host.write(job(42), null, FOREVER);
	const root = await f.h.root(ctx, { agent: f.agent });
	let output = "";
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_list", { type: "Job" }), { stopReason: "toolUse" }),
		context => {
			const result = context.messages.filter(m => m.role === "toolResult").at(-1);
			output = result?.content.filter(c => c.type === "text").map(c => c.text).join("") ?? "";
			return fauxAssistantMessage("read the result");
		},
	]);
	const result = await (await root.submit({ type: "input", content: "list jobs" }, ctx)).wait(ctx);
	assert.equal(result.status, "done");
	assert.equal(JSON.parse(output)[0].fields.n, 42);
});

test("space_wait: tool returns at once; entry arrives later as a message and is committed by the agent", async () => {
	const f = await fixture();
	const worker = await f.h.root(ctx, { agent: f.agent });
	const stop = await startService(f.service, ctx);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_wait", { type: "Job", timeoutMs: 60_000 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("waiting"), // turn ends immediately: no blocked call
	]);
	const t0 = Date.now();
	await (await worker.submit({ type: "input", content: "wait for a job" }, ctx)).wait(ctx);
	assert.ok(Date.now() - t0 < 3000);
	assert.equal((await f.snapshot()).waiters.length, 1);
	// A job arrives: the space takes it for the waiter (under a txn) and wakes the worker conversation.
	f.faux.setResponses([fauxAssistantMessage("got it")]);
	await f.host.write(job(9), null, FOREVER);
	for (let i = 0; i < 50 && (await f.snapshot()).outbox.length; i++) await sleep(50);
	await worker.waitForIdle(ctx);
	const snap = await f.snapshot();
	assert.equal(snap.waiters.length, 0); assert.equal(snap.outbox.length, 0);
	assert.equal(Object.keys(snap.txns).length, 1); // held until the worker commits
	await f.host.commit(Object.keys(snap.txns)[0]!);
	assert.equal(await f.host.takeIfExists({ type: "Job" }, 50), null);
	await stop(); await f.close();
});

test("space_notify tool subscribes the calling conversation", async () => {
	const f = await fixture();
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_notify", { type: "Job" }), { stopReason: "toolUse" }), fauxAssistantMessage("subscribed")]);
	await (await a.submit({ type: "input", content: "tell me about jobs" }, ctx)).wait(ctx);
	const regs = (await f.snapshot()).regs;
	assert.equal(regs.length, 1); assert.equal(regs[0]!.target, a.id);
	f.faux.setResponses([fauxAssistantMessage("saw it")]);
	await f.host.write(job(1), null, FOREVER);
	assert.equal(await deliverEvents(f.service, ctx), 1);
	await a.waitForIdle(ctx);
	await f.close();
});

test("tools act as their conversation: another conversation cannot commit a transaction it did not begin", async () => {
	const f = await fixture();
	const a = await f.h.root(ctx, { agent: f.agent });
	const b = await f.h.createConversation({ ownership: { kind: "ownerless" }, agent: f.agent }, ctx);
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_txn", { action: "begin", leaseMs: "forever" }), { stopReason: "toolUse" }), fauxAssistantMessage("begun")]);
	await (await a.submit({ type: "input", content: "begin" }, ctx)).wait(ctx);
	const [txn] = Object.values((await f.snapshot()).txns);
	assert.equal(txn!.owner, a.id); assert.equal(txn!.expires, FOREVER);
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_txn", { action: "commit", txn: txn!.id }), { stopReason: "toolUse" }), fauxAssistantMessage("tried")]);
	await (await b.submit({ type: "input", content: "commit theirs" }, ctx)).wait(ctx);
	assert.ok((await f.snapshot()).txns[txn!.id], "b must not be able to commit a's transaction");
	await f.close();
});

test("tool traffic is counted once, into the meter of the space", async () => {
	const mine = new Meter();
	const f = await fixture({ meter: mine });
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_write", { type: "Job", fields: { n: 1 } }), { stopReason: "toolUse" }), fauxAssistantMessage("written")]);
	await (await a.submit({ type: "input", content: "write" }, ctx)).wait(ctx);
	assert.equal(mine.total("writes"), 1);
	await f.close();
});

test("space_list lists entries without removing them", async () => {
	const f = await fixture();
	for (let i = 0; i < 3; i++) await f.host.write(job(i), null, FOREVER);
	const root = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_list", { type: "Job" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await (await root.submit({ type: "input", content: "list" }, ctx)).wait(ctx);
	const all = JSON.stringify((await root.entries({}, 20, undefined, ctx)).items);
	assert.ok(all.includes('\\"n\\":2') || all.includes('"n":2'));
	assert.equal(await f.host.count(), 3);
	await f.close();
});

test("space_txn and space_lease act once per call; space_read finds an entry by id", async () => {
	const f = await fixture();
	const conv = await f.h.root(ctx, { agent: f.agent });
	const e = await f.host.write(job(5), null, FOREVER); await f.host.write(job(5), null, FOREVER);
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_txn", { action: "begin" }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("space_read", { id: e.id }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("space_lease", { action: "renew", id: e.id, ms: "forever" }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await (await conv.submit({ type: "input", content: "go" }, ctx)).wait(ctx);
	assert.equal((await f.host.stats()).txns, 1);
	const all = JSON.stringify((await conv.entries({}, 20, undefined, ctx)).items);
	assert.ok(all.includes(e.id));
	await f.close();
});

test("every call has its own request; the conversation's generation is reused", async () => {
	const requests: string[] = [], generations: number[] = [];
	const f = await fixture({ spaces: (s) => ({ ...s, generation: async (id, c) => { generations.push(id); return s.generation(id, c); }, request: (id, g, r) => { requests.push(`${g}/${r}`); return s.request(id, g, r); } }) });
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_write", { type: "Job", fields: { n: 1 } }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("space_write", { type: "Job", fields: { n: 2 } }), { stopReason: "toolUse" }),
		fauxAssistantMessage("done"),
	]);
	await (await a.submit({ type: "input", content: "write twice" }, ctx)).wait(ctx);
	assert.equal(generations.length, 1, "one generation for the conversation");
	assert.equal(new Set(requests).size, 2, "a request per call");
	assert.equal(new Set(requests.map((r) => r.split("/")[0])).size, 1);
	assert.equal(await f.host.count({ type: "Job" }), 2);
	await f.close();
});

// Regression (agent crash between the space operation and the tool result): the replayed call meets its request in
// the space and returns the first outcome, not a second transaction. The agent's store is a JSONL directory; the
// space is a SQLite file; a crash abandons the agent host and opens another on the same directory.
test("a call replayed after an agent crash returns the stored outcome and begins no second transaction", async () => {
	const dir = mkdtempSync(join(tmpdir(), "phi-spaces-agent-crash-"));
	const space = await openSqliteHost(join(dir, "space.sqlite"));
	let hold = true, release!: () => void;
	const held = new Promise<void>((r) => { release = r; });
	/** The first run's call stops after its space operation, as an agent process killed right there would. */
	const holding = (s: SpaceLike): SpaceLike => new Proxy(s, { get: (t: any, k) => k === "createTransaction" ? async (...a: unknown[]) => { const r = await t.createTransaction(...a); if (hold) await held; return r; } : typeof t[k] === "function" ? t[k].bind(t) : t[k] });
	const local = localSpaces(space), ext = createSpaces({ ...local, space: (id, c) => holding(local.space(id, c)) });
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const registry = createRegistry(); registry.install(ext);
	const agent = { model: { provider: "faux", modelId: "faux-1" }, extensions: [ext] };
	faux.setResponses([fauxAssistantMessage(fauxToolCall("space_txn", { action: "begin", leaseMs: "forever" }), { stopReason: "toolUse" }), fauxAssistantMessage("begun"), fauxAssistantMessage("begun")]);
	const first = await Harness.open(await openNodeJsonlStorage(join(dir, "agent"), ctx), { models, registry }, ctx);
	let second: Harness | undefined;
	try {
		const a = await first.root(ctx, { agent });
		const sub = await a.submit({ type: "input", content: "begin" }, ctx);
		void sub.wait(ctx).catch(() => {}); // the crashed host never settles it
		const txnsNow = async () => Object.keys((await space.snapshot(Space, ctx))?.txns ?? {}).length;
		for (let i = 0; i < 100 && !(await txnsNow()); i++) await sleep(20);
		assert.equal(await txnsNow(), 1, "the space operation took place");
		// crash: the first agent host is left as it is; another opens the same directory and replays the call
		hold = false;
		second = await Harness.open(await openNodeJsonlStorage(join(dir, "agent"), ctx), { models, registry }, ctx);
		const root = await second.root(ctx, { agent });
		await root.waitForIdle(ctx);
		const txns = Object.values((await space.snapshot(Space, ctx))!.txns);
		assert.equal(txns.length, 1, "no second transaction");
		const results = JSON.stringify((await root.entries({}, 100, undefined, ctx)).items);
		assert.ok(results.includes(txns[0]!.id), "the replayed tool result names the transaction");
	} finally {
		release();
		await second?.close(ctx); await first.close(ctx).catch(() => {}); await space.close(ctx);
		rmSync(dir, { recursive: true, force: true });
	}
});
