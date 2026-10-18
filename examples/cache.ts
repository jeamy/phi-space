// Atomic key/value operations over a local durable Space. This is not a replicated LWW cache.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { core, Space, FOREVER, canonicalJson, type SpaceHost } from "../src/index.ts";
import type { Json, SpaceState } from "../src/core.ts";

const Versions = defineDoc<{ next: number }>({
  kind: "phi-spaces.example-cache-version", version: 1, scope: "session", initial: () => ({ next: 1 })
});
export type CacheHit = { value: Json; version: number; expiresAt: number };

export class SpaceCache {
  private host: SpaceHost;
  private namespace: string;
  private now: () => number;
  constructor(host: SpaceHost, namespace = "default", now: () => number = Date.now) {
    if (!namespace || namespace.length > 128) throw new Error("namespace must be 1..128 characters");
    this.host = host; this.namespace = namespace; this.now = now;
  }
  private template(key: string) {
    if (!key || key.length > 256) throw new Error("key must be 1..256 characters");
    return { type: "ExampleCacheEntry", fields: { namespace: this.namespace, key } };
  }
  private checkIntegrity(space: SpaceState, key: string) {
    const matches = space.entries.filter(e => e.type === "ExampleCacheEntry" && e.fields.namespace === this.namespace && e.fields.key === key);
    if (matches.some(e => e.writtenUnder !== null)) throw new Error("Cache key has an uncommitted external write");
    if (matches.length > 1) throw new Error("Duplicate cache key");
  }
  async get(key: string): Promise<CacheHit | null> {
    const template = this.template(key);
    return this.host.commit(async tx => {
      const space = await tx.doc(Space), now = this.now();
      core.settle(space, now); this.checkIntegrity(space, key);
      const result = core.probe(space, now, template, null, false);
      if (result.status === "locked") throw new Error("Cache key is locked by an external transaction");
      if (result.status !== "found") return null;
      return { value: structuredClone(result.entry.fields.value), version: result.entry.fields.version as number, expiresAt: result.entry.expires };
    }, ctx);
  }
  /** expectedVersion=null means insert only if absent. Omitted means unconditional atomic replacement. */
  async set(key: string, value: Json, ttlMs = 60_000, expectedVersion?: number | null): Promise<CacheHit> {
    const template = this.template(key);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("TTL must be a non-negative safe integer");
    // Canonical JSON rejects non-finite/unsupported primitives; roundtrip gives a detached JSON value.
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 60 * 1024) throw new Error("Cache value exceeds the 60 KiB example limit");
    const detached = JSON.parse(encoded) as Json;
    return this.host.commit(async tx => {
      const space = await tx.doc(Space), now = this.now();
      const versions = await tx.doc(Versions);
      core.settle(space, now); this.checkIntegrity(space, key);
      const prior = core.probe(space, now, template, null, true);
      if (prior.status === "locked") throw new Error("Cache key is locked by an external transaction");
      const version = prior.status === "found" ? prior.entry.fields.version : null;
      if (expectedVersion !== undefined && expectedVersion !== version) throw new Error("Cache version conflict");
      if (core.probe(space, now, template, null, false).status !== "none") throw new Error("Duplicate or locked cache key");
      if (!Number.isSafeInteger(versions.next) || versions.next >= Number.MAX_SAFE_INTEGER) throw new Error("Cache version counter exhausted");
      const next = versions.next++;
      const lease = core.write(space, now, { type: "ExampleCacheEntry", fields: { namespace: this.namespace, key, value: detached, version: next } }, null, ttlMs);
      return { value: detached, version: next, expiresAt: lease.expires };
    }, ctx);
  }
  async delete(key: string, expectedVersion?: number): Promise<boolean> {
    const template = this.template(key);
    return this.host.commit(async tx => {
      const space = await tx.doc(Space);
      const now = this.now();
      core.settle(space, now); this.checkIntegrity(space, key);
      const result = core.probe(space, now, template, null, true);
      if (result.status === "locked") throw new Error("Cache key is locked by an external transaction");
      if (expectedVersion !== undefined && (result.status !== "found" || result.entry.fields.version !== expectedVersion)) throw new Error("Cache version conflict");
      if (core.probe(space, now, template, null, false).status !== "none") throw new Error("Duplicate or locked cache key");
      return result.status === "found";
    }, ctx);
  }
}

export async function runCacheDemo() {
  const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
  try {
    const cache = new SpaceCache(h);
    const initial = await cache.set("user:123", { name: "Alice" }, FOREVER);
    const replaced = await cache.set("user:123", { name: "Bob" }, FOREVER, initial.version);
    const hit = await cache.get("user:123");
    await cache.delete("user:123", replaced.version);
    return { hit, afterDelete: await cache.get("user:123") };
  } finally { await h.close(ctx); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) console.log(JSON.stringify(await runCacheDemo(), null, 2));
