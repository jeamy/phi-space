import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableAgentClient } from "../src/durable-client.ts";
import type { AgentRequest } from "../src/durable-protocol.ts";

const modelsModule = fileURLToPath(new URL("./durable-models.ts", import.meta.url));
const request = (patch: Partial<AgentRequest> = {}): AgentRequest => ({
  session: "test", requestId: "first", model: "faux/faux-1", system: "Scripted offline agent.", prompt: "hello", ...patch,
});

test("durable bridge verifies code, preserves usage and reuses the result without a new model admission", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-code-"));
  const file = join(dir, "agent.sqlite");
  let client = new DurableAgentClient(file, { modelsModule }), permits = 0, verifications = 0;
  const callbacks = {
    permit: async () => { permits++; },
    verify: async (source: string) => { verifications++; assert.equal(source, "(a, b) => a + b"); return { ok: true }; },
  };
  try {
    const job = request({ mode: "code", prompt: "repair" });
    const answer = await client.run(job, callbacks);
    assert.match(answer.text, /a \+ b/);
    assert.equal(permits, 2); assert.equal(verifications, 1);
    assert.ok(answer.usage.total > 0); assert.ok(answer.usage.costUsd >= 0);
    await client.close();
    client = new DurableAgentClient(file, { modelsModule });
    assert.deepEqual(await client.run(job, callbacks), answer);
    assert.equal(permits, 2);
    await assert.rejects(client.run({ ...job, prompt: "different" }, callbacks), /identity conflicts/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("durable dialogue keeps its own context after reopen, isolated from other sessions", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-dialogue-"));
  const file = join(dir, "agent.sqlite");
  let client = new DurableAgentClient(file, { modelsModule });
  const callbacks = { permit: async () => {} };
  try {
    await client.run(request(), callbacks);
    await client.close(); client = new DurableAgentClient(file, { modelsModule });
    const answer = await client.run(request({ requestId: "second", prompt: "again" }), callbacks);
    assert.match(answer.text, /hello\|again/);
    const other = await client.run(request({ session: "other", prompt: "separate" }), callbacks);
    assert.doesNotMatch(other.text, /hello|again/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("durable bridge resumes a killed model attempt, but enforces per-job model and parent admission limits", { timeout: 20_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-limits-"));
  const file = join(dir, "agent.sqlite");
  let client = new DurableAgentClient(file, { modelsModule }), calls = 0;
  const callbacks = { permit: async () => { calls++; }, verify: async () => ({ ok: false }) };
  try {
    const job = request({ prompt: `crash:${join(dir, "once")}` });
    await assert.rejects(client.run(job, callbacks), /worker exited/);
    await client.close(); client = new DurableAgentClient(file, { modelsModule });
    assert.match((await client.run(job, callbacks)).text, /answer:crash/);
    calls = 0;
    const log = join(dir, "calls");
    await assert.rejects(client.run(request({ session: "loop", mode: "code", prompt: `loop:${log}`, maxRequests: 2 }), callbacks), /submission|budget/i);
    assert.equal(calls, 2);
    assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 2, "the provider itself stops, not just the admission callback");
    const refused = join(dir, "refused");
    await assert.rejects(client.run(request({ session: "refused", prompt: `deny:${refused}` }), { permit: async () => { throw new Error("admin disabled"); } }), /submission|disabled/i);
    assert.equal(existsSync(refused), false, "a refused admission never calls the provider");
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("cancellation while a sandbox tool waits admits no later model attempt", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-cancel-"));
  const client = new DurableAgentClient(join(dir, "agent.sqlite"), { modelsModule });
  const controller = new AbortController();
  let entered!: () => void, release!: () => void, calls = 0;
  const toolEntered = new Promise<void>(resolve => { entered = resolve; });
  const toolRelease = new Promise<void>(resolve => { release = resolve; });
  try {
    const running = client.run(request({ mode: "code", prompt: "repair" }), {
      permit: async () => { calls++; },
      verify: async () => { entered(); await toolRelease; return { ok: true }; },
    }, controller.signal);
    await toolEntered;
    controller.abort();
    await assert.rejects(running, /cancel|aborted/i);
    release();
    assert.equal(calls, 1);
  } finally { release?.(); await client.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("the provider receives the smaller of request and worker output-token ceilings", { timeout: 15_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "durable-tokens-"));
  const client = new DurableAgentClient(join(dir, "agent.sqlite"), { modelsModule, maxTokens: 40 });
  try {
    for (const [limit, expected] of [[23, 23], [80, 40]]) {
      const log = join(dir, `tokens-${limit}`);
      await client.run(request({ session: `limit-${limit}`, prompt: `tokens:${log}`, maxTokens: limit }), { permit: async () => {} });
      assert.equal(Number(readFileSync(log, "utf8")), expected);
    }
    await assert.rejects(client.run(request({ maxTokens: 0 }), { permit: async () => {} }), /Invalid durable agent request/);
  } finally { await client.close(); rmSync(dir, { recursive: true, force: true }); }
});
