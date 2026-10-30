// Agent-only storage policy. Acknowledgements follow file and namespace flushes.
import { mkdir, open } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import type { Context } from "@earendil-works/chord";
import { FileError, type FileSystem } from "@earendil-works/pi-durable/env";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { JsonlStorage } from "@earendil-works/pi-durable/storage/jsonl";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";

export async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, "r");
  try { await file.sync(); } finally { await file.close(); }
}

export async function ensureDurableDirectory(path: string): Promise<void> {
  const absolute = resolve(path);
  const first = await mkdir(absolute, { recursive: true });
  const boundary = dirname(first ?? absolute);
  for (let current = absolute;; current = dirname(current)) {
    await syncDirectory(current);
    if (current === boundary || current === dirname(current)) break;
  }
}

export async function openDurableSqliteDatabase(path: string) {
  await ensureDurableDirectory(dirname(resolve(path)));
  const database = await openNodeSqliteDatabase(path);
  try {
    await database.exec("PRAGMA synchronous = FULL");
    const setting = await database.get<{ synchronous: number }>("PRAGMA synchronous");
    if (setting?.synchronous !== 2) throw new Error("Agent SQLite requires synchronous=FULL");
    return database;
  } catch (error) { await database.close(); throw error; }
}

export async function openDurableSqliteStorage(path: string): Promise<SqliteStorage> {
  const database = await openDurableSqliteDatabase(path);
  try {
    const storage = await SqliteStorage.open(database);
    await syncDirectory(dirname(resolve(path)));
    return storage;
  } catch (error) { await database.close(); throw error; }
}

export function durableJsonlFileSystem(fs: FileSystem, syncDir = syncDirectory): FileSystem {
  return new Proxy(fs, {
    get(target, key) {
      if (key === "appendFile") return async (...args: Parameters<FileSystem["appendFile"]>) => {
        const [path, , context] = args;
        try {
          // Pi 1.4 flushes sidecars, but its main marker needs a separate durability barrier.
          const marker = basename(path) === "main.jsonl";
          if (marker) await syncDir(dirname(path));
          const result = await target.appendFile(...args);
          if (!result.ok || !marker) return result;
          const flushed = await target.flushFile(path, context);
          if (!flushed.ok) return flushed;
          await syncDir(dirname(path));
          return result;
        } catch (error) {
          return { ok: false as const, error: new FileError("unknown", "JSONL durability barrier failed", path, error instanceof Error ? error : undefined) };
        }
      };
      if (key === "renameFile") return async (...args: Parameters<FileSystem["renameFile"]>) => {
        try {
          const result = await target.renameFile(...args);
          if (result.ok) for (const path of new Set([dirname(args[0]), dirname(args[1])])) await syncDir(path);
          return result;
        } catch (error) {
          return { ok: false as const, error: new FileError("unknown", "JSONL rename barrier failed", args[1], error instanceof Error ? error : undefined) };
        }
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function openDurableJsonlStorage(directory: string, context: Context): Promise<JsonlStorage> {
  await ensureDurableDirectory(directory);
  return JsonlStorage.open(directory, durableJsonlFileSystem(new NodeExecutionEnv({ cwd: process.cwd() })), context, { fsync: true });
}
