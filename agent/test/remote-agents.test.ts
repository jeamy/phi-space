// The tools over a remote space through one agent host's connection (remoteSpaces, docs/m1-mobile.en.md): each
// conversation is its own agent there, and the event pump hands its mailbox's events to it exactly once. With
// PHI_SPACES_SERVER_CMD the space is that server (test/support/service-under-test.ts), e.g. the Rust phi-space-server.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, MemoryStorage, type ConversationId } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { FOREVER, RemoteSpace } from "../../src/index.ts";
import { principalKey } from "../../src/service.ts";
import { underTest, type Case } from "../../test/support/service-under-test.ts";
import { conversationAgent, createSpaces, eventPump, remoteSpaces } from "../src/agent.ts";

const IDENTITIES: Case["identities"] = {
	phone: { principal: { peerId: "phone" }, roles: ["member", "agentHost"] },
	other: { principal: { peerId: "other" }, roles: ["member"] },
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** An agent host (pi-durable in memory) whose conversations use a remote space as agents of the connection `phone`. */
async function fixture(t: TestContext, o: { wrap?: (h: Harness) => Pick<Harness, "conversation"> } = {}) {
	const u = await underTest({ identities: IDENTITIES, background: true });
	const transport = u.transport("phone");
	const open = (agent?: string) => new RemoteSpace(transport, agent === undefined ? {} : { agent });
	let watch = (_id: number) => {};
	const spaces = remoteSpaces(open, { peerId: "phone", onUse: (id) => watch(id) });
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const ext = createSpaces(spaces);
	const registry = createRegistry(); registry.install(ext);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	const errors: unknown[] = [];
	const pump = eventPump(open, o.wrap ? o.wrap(h) : h, { waitMs: 2_000, retryMs: 50, onError: (e) => errors.push(e) });
	watch = (id) => pump.watch(id);
	t.after(async () => { await pump.stop(); await h.close(ctx); await u.close(); });
	return { u, h, faux, pump, errors, open, other: new RemoteSpace(u.transport("other")),
		agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [ext] } };
}

/** The inputs a conversation got from the space, oldest first. */
async function spaceInputs(h: Harness, id: number): Promise<string[]> {
	const conv = await h.conversation(id as ConversationId, ctx);
	const page = await conv!.entries({}, 200, undefined, ctx);
	return [...page.items].reverse().map((e) => JSON.stringify(e)).filter((e) => e.includes("[space"));
}

test("remote agents: a conversation's wait is served to its own mailbox and handed to it once by the pump", async (t) => {
	const f = await fixture(t);
	const worker = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([
		fauxAssistantMessage(fauxToolCall("space_wait", { type: "Job", timeoutMs: 60_000 }), { stopReason: "toolUse" }),
		fauxAssistantMessage("waiting"),
	]);
	await (await worker.submit({ type: "input", content: "wait for a job" }, ctx)).wait(ctx);
	assert.deepEqual(f.pump.watched, [worker.id], "using the space started the pump for the conversation");
	f.faux.setResponses([fauxAssistantMessage("got it")]);
	await f.other.write({ type: "Job", fields: { n: 7 } }, null, FOREVER);
	let inputs: string[] = [];
	for (let i = 0; i < 100 && inputs.length === 0; i++) { await sleep(50); inputs = await spaceInputs(f.h, worker.id); }
	await worker.waitForIdle(ctx);
	assert.equal(inputs.length, 1, "one input");
	assert.match(inputs[0]!, /was served/);
	// the conversation's own principal holds the take, under a transaction only it can commit
	const mine = f.open(conversationAgent(worker.id));
	assert.equal((await mine.info()).principal, principalKey({ peerId: "phone", agentId: conversationAgent(worker.id) }));
	const txn = /transaction (\S+?):/.exec(inputs[0]!)?.[1];
	assert.ok(txn, inputs[0]);
	await assert.rejects(f.open(conversationAgent(worker.id + 1)).commit(txn!), "another agent of the host cannot commit it");
	await mine.commit(txn!);
	assert.equal(await f.other.takeIfExists({ type: "Job" }, 0), null, "the job is gone once its taker committed");
	assert.deepEqual(f.errors, []);
});

test("remote agents: a hand-over that fails is retried from the acknowledged prefix, and stays one input", async (t) => {
	let failures = 1;
	// the first hand-over reaches the conversation, then fails before the pump could acknowledge it
	const f = await fixture(t, { wrap: (h) => ({
		async conversation(id, c) {
			const conv = await h.conversation(id, c);
			return conv && Object.assign(Object.create(conv), { submit: async (input: any, cc: any) => { const r = await conv.submit(input, cc); if (failures-- > 0) throw new Error("lost after the hand-over"); return r; } });
		},
	}) });
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_notify", { type: "Job" }), { stopReason: "toolUse" }), fauxAssistantMessage("subscribed")]);
	await (await a.submit({ type: "input", content: "tell me about jobs" }, ctx)).wait(ctx);
	f.faux.setResponses([fauxAssistantMessage("saw it"), fauxAssistantMessage("saw it again")]);
	await f.other.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
	for (let i = 0; i < 100 && f.errors.length === 0; i++) await sleep(50);
	assert.equal(f.errors.length, 1, "the failed hand-over was reported");
	// acknowledged in the end: the mailbox has nothing left for the agent
	const mine = f.open(conversationAgent(a.id));
	let left = Infinity;
	for (let i = 0; i < 100 && left > 0; i++) { await sleep(50); left = (await mine.events({ waitMs: 0 })).events.length; }
	assert.equal(left, 0, "acknowledged after the retry");
	await a.waitForIdle(ctx);
	assert.equal((await spaceInputs(f.h, a.id)).length, 1, "handed over twice, one input");
});

test("remote agents: a conversation that is gone ends its loop, and a take it was handed goes back to the space", async (t) => {
	let gone = false;
	const f = await fixture(t, { wrap: (h) => ({ conversation: async (id, c) => (gone ? undefined : h.conversation(id, c)) }) });
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_wait", { type: "Job", timeoutMs: 60_000 }), { stopReason: "toolUse" }), fauxAssistantMessage("waiting")]);
	await (await a.submit({ type: "input", content: "wait" }, ctx)).wait(ctx);
	gone = true;
	await f.other.write({ type: "Job", fields: { n: 2 } }, null, FOREVER);
	for (let i = 0; i < 100 && f.pump.watched.length; i++) await sleep(50);
	assert.deepEqual(f.pump.watched, [], "the loop ended");
	assert.equal((await f.other.takeIfExists({ type: "Job" }, 2_000))?.fields.n, 2, "the take went back to the space");
});

test("remote agents: tool calls take their request identities from the conversation's own generation", async (t) => {
	const f = await fixture(t);
	const a = await f.h.root(ctx, { agent: f.agent });
	f.faux.setResponses([fauxAssistantMessage(fauxToolCall("space_write", { type: "Note", fields: { x: 1 } }), { stopReason: "toolUse" }), fauxAssistantMessage("written")]);
	await (await a.submit({ type: "input", content: "write" }, ctx)).wait(ctx);
	const [note] = await f.other.readAll({ type: "Note" });
	assert.ok(note, "written");
	assert.equal(note!.owner, JSON.stringify(["phone", conversationAgent(a.id)]), "owned by the conversation's agent, not the host");
});

test("remote agents: a space that cannot be reached leaves the turn running, the prompt says so", async () => {
	const down = new RemoteSpace({ request: async () => { throw new Error("connect ENOENT /nowhere.sock"); }, close() {} } as any, { attempts: 1 });
	const faux = fauxProvider(); const models = createModels(); models.setProvider(faux.provider);
	const ext = createSpaces(remoteSpaces(() => down, { peerId: "phone" }));
	const registry = createRegistry(); registry.install(ext);
	const h = await Harness.open(new MemoryStorage(), { models, registry }, ctx);
	try {
		const a = await h.root(ctx, { agent: { model: { provider: "faux", modelId: "faux-1" }, extensions: [ext] } });
		let system = "";
		faux.setResponses([(c: any) => { system = String(c.systemPrompt ?? JSON.stringify(c.messages)); return fauxAssistantMessage("fine"); }]);
		await (await a.submit({ type: "input", content: "hi" }, ctx)).wait(ctx);
		assert.match(system, /Shared space \(unreachable now: .*ENOENT/);
	} finally { await h.close(ctx); }
});
