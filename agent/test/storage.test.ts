import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { FileError, type FileSystem } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { createRegistry, defineDoc, Harness } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { durableJsonlFileSystem, openDurableJsonlStorage, openDurableSqliteDatabase } from "../src/storage.ts";

const Counter = defineDoc<{ n: number }>({
  kind: "phi-spaces.sync-test", version: 1, scope: "session",
  initial: () => ({ n: 0 }), checkpointWhen: () => true,
});

test("every agent SQLite connection uses WAL/FULL rather than the upstream NORMAL default", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-full-"));
  try {
    for (let i = 0; i < 2; i++) {
      const db = await openDurableSqliteDatabase(join(dir, "nested", "agent.sqlite"));
      try {
        assert.equal((await db.get<{ synchronous: number }>("PRAGMA synchronous"))?.synchronous, 2);
        assert.equal((await db.get<{ journal_mode: string }>("PRAGMA journal_mode"))?.journal_mode, "wal");
      } finally { await db.close(); }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("JSONL marker and namespace barriers precede acknowledgement; a file-cache-loss model retains the document", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-jsonl-sync-"));
  const recovered = mkdtempSync(join(tmpdir(), "agent-jsonl-image-"));
  const image = new Map<string, Buffer>(), events: string[] = [];
  let fail = false;
  const fs: FileSystem = new Proxy(new NodeExecutionEnv({ cwd: dir }), {
    get(target, key) {
      if (key === "appendFile") return async (...args: Parameters<FileSystem["appendFile"]>) => {
        events.push(`append:${basename(args[0])}`);
        return target.appendFile(...args);
      };
      if (key === "flushFile") return async (...args: Parameters<FileSystem["flushFile"]>) => {
        const name = basename(args[0]);
        if (fail && name === "main.jsonl") return { ok: false as const, error: new FileError("unknown", "injected flush failure") };
        const result = await target.flushFile(...args);
        if (result.ok) { image.set(name, readFileSync(args[0])); events.push(`flush:${name}`); }
        return result;
      };
      if (key === "renameFile") return async (...args: Parameters<FileSystem["renameFile"]>) => {
        const result = await target.renameFile(...args);
        if (result.ok && image.has(basename(args[0]))) {
          image.set(basename(args[1]), image.get(basename(args[0]))!);
          image.delete(basename(args[0]));
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const storage = await JsonlStorage.open(dir, durableJsonlFileSystem(fs, async () => { events.push("directory"); }), ctx, { fsync: true });
  let harness: Harness | undefined;
  try {
    harness = await Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
    const root = await harness.root(ctx);
    events.length = 0;
    await root.commit(async tx => { (await tx.doc(Counter)).n = 7; }, ctx);
    events.push("ack");
    const marker = events.indexOf("append:main.jsonl"), flush = events.indexOf("flush:main.jsonl");
    assert.ok(marker > 0 && flush > marker && flush < events.indexOf("ack"), events.join(","));
    assert.equal(events[marker - 1], "directory");
    assert.equal(events[flush + 1], "directory");
    // Only file contents that passed flush survive this deliberately limited cache-loss model.
    for (const [name, content] of image) writeFileSync(join(recovered, name), content);
    const copy = await Harness.open(await openDurableJsonlStorage(recovered, ctx), { models: createModels(), registry: createRegistry() }, ctx);
    try { assert.equal((await copy.snapshot(Counter, ctx))?.n, 7); }
    finally { await copy.close(ctx); }
    fail = true;
    await assert.rejects(root.commit(async tx => { (await tx.doc(Counter)).n = 8; }, ctx), /flush|poison|barrier/i);
    await assert.rejects(storage.commit([], ctx), /poison/i);
  } finally {
    try { await harness?.close(ctx); } catch { /* The injected barrier failure poisons this store. */ }
    rmSync(dir, { recursive: true, force: true });
    rmSync(recovered, { recursive: true, force: true });
  }
});

test("upstream JSONL fsync alone does not flush a marker-only commit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-jsonl-control-"));
  let flushed = false;
  const fs = new NodeExecutionEnv({ cwd: dir });
  const original = fs.flushFile.bind(fs);
  fs.flushFile = async (path, context) => { if (basename(path) === "main.jsonl") flushed = true; return original(path, context); };
  const storage = await JsonlStorage.open(dir, fs, ctx, { fsync: true });
  try { await storage.commit([], ctx); assert.equal(flushed, false); }
  finally { await storage.close(ctx); rmSync(dir, { recursive: true, force: true }); }
});
