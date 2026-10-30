import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startStack } from "./stack.ts";
import type { LlmCall, LlmResultEntry } from "../server/context.ts";
import { PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { admitAgentAttempt } from "../server/run.ts";
import { durableContributionOptions } from "../server/durable-agent.ts";
import { ROOT } from "../server/env.ts";

test("durable contributions default on without enabling paid models and have a persistent default path", () => {
  const options = durableContributionOptions({ CODEMODE_CHAT_LLM: "1" });
  assert.equal(options?.store, join(ROOT, ".local", "codemode-agent.sqlite"));
  assert.equal(durableContributionOptions({ CODEMODE_CHAT_LLM: "1", CODEMODE_SQLITE: "/data/space.sqlite" })?.store, "/data/codemode-agent.sqlite");
  assert.equal(durableContributionOptions({}), null, "the paid-model switch remains off");
  for (const value of ["0", "false", "off"]) assert.equal(durableContributionOptions({ CODEMODE_CHAT_LLM: "1", CODEMODE_DURABLE_AGENT: value }), null);
  assert.equal(durableContributionOptions({ CODEMODE_TEST: "1" }), null, "test mode never falls through to live models");
});

test("default durable contributions use the real Space queue, sandbox and per-attempt quota, including after restart", { timeout: 30_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "codemode-durable-"));
  const keys = ["CODEMODE_DURABLE_AGENT", "CODEMODE_DURABLE_STORE", "CODEMODE_DURABLE_MODELS_MODULE"] as const;
  const previous = keys.map(key => process.env[key]);
  delete process.env.CODEMODE_DURABLE_AGENT;
  process.env.CODEMODE_DURABLE_STORE = join(dir, "agent.sqlite");
  process.env.CODEMODE_DURABLE_MODELS_MODULE = fileURLToPath(new URL("../../agent/test/durable-models.ts", import.meta.url));
  const stack = await startStack({ judges: [], agents: false, model: false });
  try {
    const call: LlmCall = {
      callId: "durable-job", session: "durable-room", kind: "contribute", agent: 1, gen: 1, lang: "en",
      model: "faux/faux-1", ts: Date.now(),
      task: { taskId: "custom", fn: "add", prompt: "Add the two numbers.", cases: [{ args: [1, 2], expect: 3 }, { args: [3, 4], expect: 7 }] },
    };
    let host = await stack.model({ fakes: ["faux/faux-1"] });
    const answer = async () => {
      const end = Date.now() + 10_000;
      for (;;) {
        const entry = await stack.space.takeIfExists({ type: "LlmResult", fields: { callId: call.callId } }, 0);
        if (entry) return entry.fields as unknown as LlmResultEntry;
        assert.ok(Date.now() < end, "durable contribution did not answer");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    };
    await stack.space.write({ type: "LlmCall", fields: call as never }, null, 60_000);
    const first = await answer();
    assert.equal(first.ok, true, first.error ?? "durable contribution failed");
    assert.match(String(first.value?.source), /a \+ b/);
    assert.equal(first.value?.note, "plain addition");
    assert.ok(Number((first.value?.usage as { total: number }).total) > 0);
    assert.equal(await stack.space.count({ type: "QuotaUse", fields: { key: "llm" } }), 2);
    await stack.kill(host);
    host = await stack.model({ fakes: ["faux/faux-1"] });
    await stack.space.write({ type: "LlmCall", fields: call as never }, null, 60_000);
    assert.deepEqual((await answer()).value, first.value);
    assert.equal(await stack.space.count({ type: "QuotaUse", fields: { key: "llm" } }), 2);
  } finally {
    await stack.close();
    keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    rmSync(dir, { recursive: true, force: true });
  }
});

test("additional agent attempts include unbooked spend and other work-item reservations", async () => {
  const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
  const call: LlmCall = { callId: "call", session: "s", runId: "r", itemId: "item", kind: "contribute", agent: 1, gen: 1, lang: "en", ts: 0 };
  try {
    await space.write({ type: "CodeRun", fields: {
      session: "s", runId: "r", info: { budget: { tokens: 10 }, usage: { tokens: 0, costUsd: 0 } },
      reserved: { item: { tokens: 4, usd: 0 }, other: { tokens: 3, usd: 0 } },
    } }, null, 60_000);
    const usage = { input: 3, output: 0, cacheRead: 0, cacheWrite: 0, total: 3, costUsd: 0 };
    await admitAgentAttempt(space, call, usage);
    await assert.rejects(admitAgentAttempt(space, call, { ...usage, total: 8 }), /budget is used up/);
    const entry = await space.readIfExists({ type: "CodeRun" }, 0);
    const fields = entry!.fields as { info: { usage: { tokens: number } }; reserved: Record<string, { tokens: number }> };
    assert.equal(fields.info.usage.tokens, 0, "the final result still books usage exactly once");
    assert.equal(fields.reserved.item!.tokens, 4003, "the reservation covers spent tokens plus one estimate");
    assert.equal(fields.reserved.other!.tokens, 3);
  } finally { await host.close(ctx); }
});
