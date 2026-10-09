import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { PiSpaces, FOREVER } from "../../src/index.ts";
import { segmentedSieve, prepareSieveRun, processSieveTask, collectSieveResults, runSieve, type SieveConfig } from "../../examples/sieve.ts";

const config: SieveConfig = { runId: "test-sieve", start: 1, end: 1001, blockSize: 128 };
async function memory() {
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  return { h, space: new PiSpaces(h, ctx) };
}
// Independent reference: trial division, deliberately not a second copy of the sieve.
const reference = (start: number, end: number) => Array.from({ length: end - start }, (_, i) => start + i)
  .filter(n => { if (n < 2) return false; for (let d = 2; d * d <= n; d++) if (n % d === 0) return false; return true; });

test("Segmented sieve matches trial division, including prime-square and block boundaries", () => {
  for (const [start, end] of [[0, 2], [2, 3], [1, 1001], [47, 130], [997, 1200], [4096, 8192]]) {
    assert.deepEqual(segmentedSieve(start, end), reference(start, end));
  }
  assert.throws(() => segmentedSieve(-1, 10), /Sieve needs/);
  assert.throws(() => segmentedSieve(0, 4097), /Sieve needs/);
});

test("Actual multi-worker sieve finds all 168 primes without duplicate results", async () => {
  const { primes } = await runSieve({ end: 1001, blockSize: 111, workers: 6 });
  assert.equal(primes.length, 168);
  assert.deepEqual(primes, reference(1, 1001));
  assert.equal(new Set(primes).size, primes.length);
});

test("Sieve seeding is resumable and idempotent even with concurrent coordinators", async () => {
  const { h, space } = await memory();
  try {
    await Promise.all([prepareSieveRun(h, config), prepareSieveRun(h, config)]);
    assert.equal(await space.count({ type: "SieveTask" }), 8);
    await assert.rejects(prepareSieveRun(h, { ...config, blockSize: 256 }), /configuration changed/);
    assert.equal(await space.count({ type: "SieveTask" }), 8);
    await prepareSieveRun(h, { ...config, runId: "__proto__", start: 0, end: 2 });
    await prepareSieveRun(h, { ...config, runId: "__proto__", start: 0, end: 2 });
    assert.equal(await space.count({ type: "SieveTask", fields: { runId: "__proto__" } }), 1);
  } finally { await h.close(ctx); }
});

test("Sieve commit failure returns task and discards staged result", async () => {
  const { h, space } = await memory();
  try {
    await prepareSieveRun(h, config);
    const worker = new PiSpaces(h, ctx, Date.now, undefined, 1);
    await assert.rejects(processSieveTask(worker, config.runId, { beforeCommit: async () => { throw new Error("injected failure"); } }), /injected/);
    assert.equal(await space.count({ type: "SieveTask" }), 8);
    assert.equal(await space.count({ type: "SieveResult" }), 0);
    assert.equal(await processSieveTask(worker, config.runId), true);
    assert.equal(await space.count({ type: "SieveTask" }), 7);
    assert.equal(await space.count({ type: "SieveResult" }), 1);
  } finally { await h.close(ctx); }
});

test("Sieve reservation returns at lease expiry and completed work survives JSONL reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sieve-reopen-"));
  let now = 1000;
  // JSONL open is asynchronous; keep the storage contract explicit.
  const openStore = async () => Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry: createRegistry() }, ctx);
  try {
    let h = await openStore();
    const worker = new PiSpaces(h, ctx, () => now, undefined, 1);
    await prepareSieveRun(h, config);
    assert.equal(await processSieveTask(worker, config.runId, { leaseMs: 10, crashAfterTake: true }), false);
    assert.equal(await worker.count({ type: "SieveTask" }), 7);
    now = 1010;
    assert.equal(await worker.count({ type: "SieveTask" }), 8);
    await processSieveTask(worker, config.runId);
    await h.close(ctx);
    h = await openStore();
    const resumed = new PiSpaces(h, ctx, () => now);
    try {
      await prepareSieveRun(h, config);
      assert.equal(await resumed.count({ type: "SieveResult" }), 1);
      while (await processSieveTask(resumed, config.runId)) { /* finish outstanding tasks */ }
      assert.deepEqual(await collectSieveResults(resumed, config), reference(1, 1001));
    } finally { await h.close(ctx); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Sieve collector refuses missing, duplicated or mismatched blocks", async () => {
  const { h, space } = await memory();
  const small = { ...config, end: 10, blockSize: 10 };
  try {
    await prepareSieveRun(h, small);
    await assert.rejects(collectSieveResults(space, small), /exactly one/);
    await processSieveTask(space, small.runId);
    const [result] = await space.readAll({ type: "SieveResult" });
    await space.write({ type: "SieveResult", fields: result.fields }, null, FOREVER);
    await assert.rejects(collectSieveResults(space, small), /got 2/);
    await space.take({ type: "SieveResult" }, 0);
    await space.take({ type: "SieveResult" }, 0);
    await space.write({ type: "SieveResult", fields: { ...result.fields, rangeEnd: 11 } }, null, FOREVER);
    await assert.rejects(collectSieveResults(space, small), /range mismatch/);
  } finally { await h.close(ctx); }
});

test("Sieve run creation keeps a resumable prefix when the byte budget is exceeded", async () => {
  const { h, space } = await memory();
  try {
    await space.setLimits({ maxSpaceBytes: 200 });
    await assert.rejects(prepareSieveRun(h, config), /exceed/);
    assert.equal(await space.count({ type: "SieveTask" }), 1, "accepted seeds and their cursor remain durable");
    await space.setLimits({ maxSpaceBytes: 1_000_000 });
    await prepareSieveRun(h, config);
    assert.equal(await space.count({ type: "SieveTask" }), 8);
  } finally { await h.close(ctx); }
});
