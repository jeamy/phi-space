import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { FOREVER, PiSpaces } from "../../src/index.ts";
import { SpaceCache, runCacheDemo } from "../../examples/cache.ts";

async function memory() {
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  return { h, cache: new SpaceCache(h), space: new PiSpaces(h, ctx) };
}

test("Cache distinguishes a cached null from a miss and isolates namespaces", async () => {
  const { h, cache } = await memory();
  try {
    assert.equal(await cache.get("k"), null);
    await cache.set("k", null);
    assert.equal((await cache.get("k"))?.value, null);
    assert.notEqual(await cache.get("k"), null);
    const other = new SpaceCache(h, "other");
    assert.equal(await other.get("k"), null);
    await other.set("k", 42);
    assert.equal((await other.get("k"))?.value, 42);
    assert.equal((await cache.get("k"))?.value, null);
  } finally { await h.close(ctx); }
});

test("Cache concurrent replacements leave one key and increasing persistent versions", async () => {
  const { h, cache, space } = await memory();
  try {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => cache.set("k", i, FOREVER)));
    assert.equal(new Set(results.map(r => r.version)).size, 20);
    assert.equal(await space.count({ type: "ExampleCacheEntry" }), 1);
    assert.equal((await cache.get("k"))?.version, Math.max(...results.map(r => r.version)));
  } finally { await h.close(ctx); }
});

test("Cache compare-and-set has one winner and failed CAS preserves the current value", async () => {
  const { h, cache } = await memory();
  try {
    const initial = await cache.set("k", "old");
    const writes = await Promise.allSettled([cache.set("k", "a", FOREVER, initial.version), cache.set("k", "b", FOREVER, initial.version)]);
    assert.equal(writes.filter(w => w.status === "fulfilled").length, 1);
    const current = await cache.get("k");
    await assert.rejects(cache.set("k", "stale", FOREVER, initial.version), /version conflict/);
    assert.deepEqual(await cache.get("k"), current);
    await assert.rejects(cache.delete("k", initial.version), /version conflict/);
    assert.deepEqual(await cache.get("k"), current);
  } finally { await h.close(ctx); }
});

test("Cache TTL, renewal, zero TTL and stale delete use a deterministic clock", async () => {
  const { h } = await memory(); let now = 1000;
  const cache = new SpaceCache(h, "clock", () => now);
  try {
    const old = await cache.set("k", "old", 10);
    now = 1009; assert.equal((await cache.get("k"))?.value, "old");
    const renewed = await cache.set("k", "renewed", 20, old.version);
    now = 1010; assert.equal((await cache.get("k"))?.value, "renewed");
    await assert.rejects(cache.delete("k", old.version), /version conflict/);
    now = 1029; assert.equal(await cache.get("k"), null);
    const fresh = await cache.set("k", "fresh", FOREVER, null);
    assert.ok(fresh.version > renewed.version);
    await cache.set("k", "immediately expired", 0);
    assert.equal(await cache.get("k"), null);
    assert.equal(await cache.delete("k"), false);
  } finally { await h.close(ctx); }
});

test("Cache byte-limit failure rolls replacement back, and values are detached", async () => {
  const { h, cache, space } = await memory();
  try {
    const value = { nested: [1, 2] };
    await cache.set("k", value);
    value.nested.push(3);
    assert.deepEqual((await cache.get("k"))?.value, { nested: [1, 2] });
    await space.setLimits({ maxSpaceBytes: 100 });
    await assert.rejects(cache.set("k", "x".repeat(1000)), /exceed/);
    assert.deepEqual((await cache.get("k"))?.value, { nested: [1, 2] });
    await assert.rejects(cache.set("k", Number.NaN), /non-finite/);
    await assert.rejects(cache.set("k", 1, -1), /TTL/);
  } finally { await h.close(ctx); }
});

test("Cache external transaction conflicts do not overwrite a reservation", async () => {
  const { h, cache, space } = await memory();
  try {
    await cache.set("k", "original");
    const txn = await space.createTransaction();
    await space.take({ type: "ExampleCacheEntry", fields: { namespace: "default", key: "k" } }, 0, { txn: txn.id });
    await assert.rejects(cache.set("k", "bad"), /locked/);
    await space.abort(txn.id);
    assert.equal((await cache.get("k"))?.value, "original");
    const pending = await space.createTransaction();
    await space.write({ type: "ExampleCacheEntry", fields: { namespace: "default", key: "k", value: "pending", version: 99 } }, pending.id);
    await assert.rejects(cache.set("k", "bad"), /uncommitted/);
    await space.abort(pending.id);
    assert.equal((await cache.get("k"))?.value, "original");
  } finally { await h.close(ctx); }
});

test("Cache survives JSONL reopen without reusing old versions after delete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cache-reopen-"));
  const open = async () => Harness.open(await openNodeJsonlStorage(dir, ctx), { models: createModels(), registry: createRegistry() }, ctx);
  try {
    let h = await open(); let cache = new SpaceCache(h);
    const initial = await cache.set("k", { persisted: true }, FOREVER);
    await h.close(ctx);
    h = await open(); cache = new SpaceCache(h);
    try {
      assert.deepEqual((await cache.get("k"))?.value, { persisted: true });
      await cache.delete("k");
      const next = await cache.set("k", "new", FOREVER, null);
      assert.ok(next.version > initial.version);
      await assert.rejects(cache.set("k", "old", FOREVER, initial.version), /version conflict/);
    } finally { await h.close(ctx); }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Actual cache demo replaces and deletes its value", async () => {
  const result = await runCacheDemo();
  assert.deepEqual(result.hit?.value, { name: "Bob" });
  assert.equal(result.afterDelete, null);
});
