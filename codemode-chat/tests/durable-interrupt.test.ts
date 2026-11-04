// A durable contribution interrupted between two model answers or after the last one, before its Space result: the
// model process dies with its call in the space, or only its agent worker dies. Scripted models (agent/test/durable-models.ts), no paid calls.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer, startStack, type Stack } from "./stack.ts";
import type { LlmCall, LlmResultEntry } from "../server/context.ts";

const call: LlmCall = {
	callId: "interrupted", session: "interrupted-room", kind: "contribute", agent: 1, gen: 1, lang: "en",
	model: "faux/faux-1", ts: Date.now(),
	task: { taskId: "custom", fn: "add", prompt: "Add the two numbers.", cases: [{ args: [1, 2], expect: 3 }, { args: [3, 4], expect: 7 }] },
};
const until = async (done: () => boolean, ms: number, what: string) => {
	for (const end = Date.now() + ms; !done();) { assert.ok(Date.now() < end, what); await new Promise((r) => setTimeout(r, 20)); }
};
const answer = async (stack: Stack, ms: number) => {
	for (const end = Date.now() + ms;;) {
		const entry = await stack.space.takeIfExists({ type: "LlmResult", fields: { callId: call.callId } }, 0);
		if (entry) return entry.fields as unknown as LlmResultEntry;
		assert.ok(Date.now() < end, "no result");
		await new Promise((r) => setTimeout(r, 50));
	}
};
/** The durable path as in production, with the scripted models and the variables of the case. */
async function withDurable(env: Record<string, string>, body: (dir: string, log: string) => Promise<void>) {
	const dir = mkdtempSync(join(tmpdir(), "codemode-interrupt-")), log = join(dir, "attempts");
	const values: Record<string, string | undefined> = { CODEMODE_DURABLE_AGENT: undefined, CODEMODE_DURABLE_STORE: join(dir, "agent.sqlite"), PHI_TEST_MODEL_LOG: log,
		CODEMODE_DURABLE_MODELS_MODULE: fileURLToPath(new URL("../../agent/test/durable-models.ts", import.meta.url)), ...Object.fromEntries(Object.entries(env).map(([k, v]) => [k, join(dir, v)])) };
	const previous = Object.keys(values).map((key) => [key, process.env[key]] as const);
	for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	try { await body(dir, log); } finally {
		for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
		rmSync(dir, { recursive: true, force: true });
	}
}
const attempts = (log: string) => readFileSync(log, "utf8").trim().split("\n");

test("a model process killed between two model answers resumes the same contribution from the queue", { timeout: 60_000 }, () => withDurable({ PHI_TEST_MODEL_PAUSE: "pause" }, async (dir, log) => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		const host = await stack.model({ fakes: ["faux/faux-1"] });
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		await until(() => existsSync(log) && attempts(log).includes("after-tool"), 20_000, "the second answer was not reached");
		await stack.kill(host, "SIGKILL");
		assert.equal(await stack.space.count({ type: "LlmResult", fields: { callId: call.callId } }), 0);
		writeFileSync(join(dir, "pause.go"), "go");
		await stack.model({ fakes: ["faux/faux-1"] });
		const result = await answer(stack, 45_000); // the dead process's call comes back when its 30 s lease ends
		assert.equal(result.ok, true, result.error ?? "the resumed contribution failed");
		assert.match(String(result.value?.source), /a \+ b/);
		assert.equal(attempts(log).filter((a) => a === "first").length, 1, "the answer before the kill is not asked for again");
		assert.equal(await stack.space.count({ type: "LlmCall", fields: { callId: call.callId } }), 0);
		assert.equal(await stack.space.count({ type: "LlmResult", fields: { callId: call.callId } }), 0, "exactly one result");
	} finally { await stack.close(); }
}));

test("an agent worker killed between two model answers ends the call with an error, and the next call of the same contribution resumes", { timeout: 40_000 }, () => withDurable({ PHI_TEST_MODEL_CRASH: "crashed" }, async (_dir, log) => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		await stack.model({ fakes: ["faux/faux-1"] });
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		const failed = await answer(stack, 20_000);
		assert.equal(failed.ok, false);
		assert.match(String(failed.error), /worker exited/i);
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		const result = await answer(stack, 20_000);
		assert.equal(result.ok, true, result.error ?? "the second call failed");
		assert.match(String(result.value?.source), /a \+ b/);
		assert.equal(attempts(log).filter((a) => a === "first").length, 1, "the answer before the crash is not asked for again");
	} finally { await stack.close(); }
}));

const usageOf = (r: LlmResultEntry) => r.value?.usage as { total: number; costUsd: number } | undefined;
const llmQuota = (stack: Stack) => stack.space.count({ type: "QuotaUse", fields: { key: "llm" } });
const answersAsked = (log: string) => attempts(log).filter((a) => a === "first" || a === "after-tool").length;

test("a model process killed after the last model answer, before the LlmResult: the result arrives once and nothing is paid twice", { timeout: 80_000 }, () => withDurable({ PHI_TEST_RESULT_PAUSE: "held" }, async (dir, log) => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		const host = await stack.model({ fakes: ["faux/faux-1"] });
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		await until(() => existsSync(join(dir, "held")), 20_000, "the answered call was not held before its result");
		const asked = answersAsked(log), paid = await llmQuota(stack);
		assert.equal(asked, 2, "both answers came before the kill");
		await stack.kill(host, "SIGKILL");
		assert.equal(await stack.space.count({ type: "LlmResult", fields: { callId: call.callId } }), 0, "no result before the kill");
		await stack.model({ fakes: ["faux/faux-1"] });
		const result = await answer(stack, 50_000); // the call comes back when its 30 s lease ends
		assert.equal(result.ok, true, result.error ?? "the resumed contribution failed");
		assert.match(String(result.value?.source), /a \+ b/);
		assert.ok(Number(usageOf(result)?.total) > 0, "the usage of the answer before the kill is reported");
		assert.equal(answersAsked(log), asked, "no model was asked again");
		assert.equal(await llmQuota(stack), paid, "no attempt was admitted again");
		assert.equal(await stack.space.count({ type: "LlmCall", fields: { callId: call.callId } }), 0);
		assert.equal(await stack.space.count({ type: "LlmResult", fields: { callId: call.callId } }), 0, "exactly one result");
		// the same call once more: the stored answer with the same usage, as the agent of a lost result would get it
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		assert.deepEqual((await answer(stack, 20_000)).value, result.value);
		assert.equal(answersAsked(log), asked);
	} finally { await stack.close(); }
}));

test("an agent worker killed after the last model answer, before its stored answer: the next call gets it without paying again", { timeout: 40_000 }, () => withDurable({ PHI_TEST_MODEL_CRASH_BEFORE_ANSWER: "crashed" }, async (_dir, log) => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		await stack.model({ fakes: ["faux/faux-1"] });
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		const failed = await answer(stack, 20_000);
		assert.equal(failed.ok, false);
		assert.match(String(failed.error), /worker exited/i);
		const asked = answersAsked(log), paid = await llmQuota(stack);
		assert.equal(asked, 2, "both answers came before the kill");
		await stack.space.write({ type: "LlmCall", fields: call as never }, null, 120_000);
		const result = await answer(stack, 20_000);
		assert.equal(result.ok, true, result.error ?? "the second call failed");
		assert.match(String(result.value?.source), /a \+ b/);
		assert.ok(Number(usageOf(result)?.total) > 0, "the usage of the answers before the kill is reported");
		assert.equal(answersAsked(log), asked, "no model was asked again");
		assert.equal(await llmQuota(stack), paid, "no attempt was admitted again");
	} finally { await stack.close(); }
}));

test("two contributions at once keep their conversations apart on the durable path", { timeout: 30_000 }, () => withDurable({}, async () => {
	const stack = await startStack({ judges: [], agents: false, model: false });
	try {
		await stack.model({ fakes: ["faux/faux-1"] });
		for (const n of [1, 2]) await stack.space.write({ type: "LlmCall", fields: { ...call, callId: `both-${n}`, session: `room-${n}` } as never }, null, 120_000);
		for (const n of [1, 2]) {
			const end = Date.now() + 20_000;
			for (;;) {
				const entry = await stack.space.takeIfExists({ type: "LlmResult", fields: { callId: `both-${n}` } }, 0);
				if (entry) { const r = entry.fields as unknown as LlmResultEntry; assert.equal(r.ok, true, r.error ?? "failed"); assert.match(String(r.value?.source), /a \+ b/); break; }
				assert.ok(Date.now() < end, `no result for ${n}`);
				await new Promise((r) => setTimeout(r, 50));
			}
		}
	} finally { await stack.close(); }
}));

test("a whole run through web, agents, judge and model process uses the durable path and counts its tokens", { timeout: 60_000 }, () => withDurable({}, async (_dir, log) => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1", fakes: ["faux/faux-1"] });
	const session = `${srv.url}/api/sessions/link1`, post = (path: string, body: unknown) => fetch(`${session}/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	try {
		assert.equal((await post("task", { custom: { fn: "add", prompt: "Add the two numbers.", cases: [{ args: [1, 2], expect: 3 }, { args: [3, 4], expect: 7 }] } })).ok, true);
		const started = await post("run", { agents: 2, gens: 1, perAgent: 1, polish: 0, contenders: ["faux/faux-1"] });
		assert.equal(started.ok, true, await started.clone().text());
		let snap: any;
		for (const end = Date.now() + 45_000; !(snap?.run && !snap.run.active && snap.blocks?.at(-1)?.contributions?.length);) {
			assert.ok(Date.now() < end, JSON.stringify(snap?.run ?? null));
			await new Promise((r) => setTimeout(r, 100));
			snap = await (await fetch(session)).json();
		}
		const contributions = snap.blocks.at(-1).contributions;
		assert.ok(contributions.length >= 1);
		for (const c of contributions) { assert.match(String(c.source), /a \+ b/); assert.ok(c.usage.total > 0); }
		assert.ok(attempts(log).includes("after-tool"), "the sandbox tool ran between two model answers");
		assert.ok(snap.run.usage.tokens > 0);
	} finally { await srv.close(); }
}));
