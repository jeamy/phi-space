// Atomic key/value operations over a durable Space: in this process (SpaceCache, on the store host), or over the RPC
// of a standalone service (RemoteCache, src/standalone.ts). This is not a replicated LWW cache.
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { defineDoc } from "../src/store/documents.ts";
import { openOwnMemoryHost } from "../src/store/host.ts";
import { parseListen } from "../src/standalone.ts";
import { core, Space, FOREVER, RemoteSpace, socketTransport, canonicalJson, readExisting, StillHeld, takeExisting, type SpaceHost, type SpaceLike } from "../src/index.ts";
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

/** How long a key another transaction holds is waited for; held longer, the call fails instead of taking it for absent. */
const HELD_WAIT_MS = 5_000;

/**
 * The same cache over the RPC, where only space operations are at hand. A set or delete is one transaction: the key's
 * entry is taken (a wait tells a held key from an absent one), the namespace's version counter is taken and written
 * back, the new entry written. A new key and a first counter are written `unique`, so two first sets of a key do not
 * both succeed; versions come from the counter, so a key deleted and set again never repeats an old version.
 */
export class RemoteCache {
  private space: SpaceLike;
  private namespace: string;
  constructor(space: SpaceLike, namespace = "default") {
    if (!namespace || namespace.length > 128) throw new Error("namespace must be 1..128 characters");
    this.space = space; this.namespace = namespace;
  }
  private template(key: string) {
    if (!key || key.length > 256) throw new Error("key must be 1..256 characters");
    return { type: "ExampleCacheEntry", fields: { namespace: this.namespace, key } };
  }
  /** takeIfExists/readIfExists that throws when a match stayed held for the whole wait (null then means nothing). */
  private async existing(take: boolean, tmpl: { type: string; fields: Record<string, Json> }, txn?: string) {
    try { return await (take ? takeExisting : readExisting)(this.space, tmpl, HELD_WAIT_MS, { txn: txn ?? null }); }
    catch (e) { if (e instanceof StillHeld) throw new Error("Cache key is locked by an external transaction"); throw e; }
  }
  async get(key: string): Promise<CacheHit | null> {
    const e = await this.existing(false, this.template(key));
    // an entry read over the RPC carries no lease: the entry keeps the expiry its writer was given
    return e ? { value: (e.fields as { value: Json }).value, version: (e.fields as { version: number }).version, expiresAt: (e.fields as { expiresAt: number }).expiresAt } : null;
  }
  private async inTxn<T>(fn: (txn: string) => Promise<T>): Promise<T> {
    const t = await this.space.createTransaction(30_000);
    try { const v = await fn(t.id); await this.space.commit(t.id); return v; }
    catch (e) { await this.space.abort(t.id).catch(() => {}); throw e; }
  }
  async set(key: string, value: Json, ttlMs = 60_000, expectedVersion?: number | null): Promise<CacheHit> {
    const template = this.template(key);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) throw new Error("TTL must be a non-negative safe integer");
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 60 * 1024) throw new Error("Cache value exceeds the 60 KiB example limit");
    const detached = JSON.parse(encoded) as Json;
    return this.inTxn(async (txn) => {
      const prior = await this.existing(true, template, txn);
      const version = prior ? (prior.fields as { version: number }).version : null;
      if (expectedVersion !== undefined && expectedVersion !== version) throw new Error("Cache version conflict");
      const counter = await this.existing(true, { type: "ExampleCacheCounter", fields: { namespace: this.namespace } }, txn);
      const next = counter ? (counter.fields as { next: number }).next : 1;
      if (!Number.isSafeInteger(next) || next >= Number.MAX_SAFE_INTEGER) throw new Error("Cache version counter exhausted");
      await this.space.write({ type: "ExampleCacheCounter", fields: { namespace: this.namespace, next: next + 1 } }, txn, FOREVER, counter ? {} : { unique: ["namespace"] });
      const expiresAt = ttlMs === FOREVER ? FOREVER : Date.now() + ttlMs;
      await this.space.write({ type: "ExampleCacheEntry", fields: { namespace: this.namespace, key, value: detached, version: next, expiresAt } }, txn, ttlMs, prior ? {} : { unique: ["namespace", "key"] });
      return { value: detached, version: next, expiresAt };
    });
  }
  async delete(key: string, expectedVersion?: number): Promise<boolean> {
    const template = this.template(key);
    return this.inTxn(async (txn) => {
      const prior = await this.existing(true, template, txn);
      if (expectedVersion !== undefined && (!prior || (prior.fields as { version: number }).version !== expectedVersion)) throw new Error("Cache version conflict");
      return prior !== null;
    });
  }
}

/** `remote`: the address of a standalone service (unix:/path or tcp:host:port); without it the space lives in this
 *  process, in memory. */
export async function runCacheDemo(o: { remote?: string } = {}) {
  if (o.remote) {
    const t = socketTransport(parseListen(o.remote), { requestTimeoutMs: 40_000 });
    try {
      const cache = new RemoteCache(new RemoteSpace(t));
      const initial = await cache.set("user:123", { name: "Alice" }, FOREVER);
      const replaced = await cache.set("user:123", { name: "Bob" }, FOREVER, initial.version);
      const hit = await cache.get("user:123");
      await cache.delete("user:123", replaced.version);
      return { hit, afterDelete: await cache.get("user:123") };
    } finally { t.close(); }
  }
  const h = openOwnMemoryHost();
  try {
    const cache = new SpaceCache(h);
    const initial = await cache.set("user:123", { name: "Alice" }, FOREVER);
    const replaced = await cache.set("user:123", { name: "Bob" }, FOREVER, initial.version);
    const hit = await cache.get("user:123");
    await cache.delete("user:123", replaced.version);
    return { hit, afterDelete: await cache.get("user:123") };
  } finally { await h.close(ctx); }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const i = process.argv.indexOf("--remote");
  console.log(JSON.stringify(await runCacheDemo(i > 0 ? { remote: process.argv[i + 1]! } : {}), null, 2));
}
