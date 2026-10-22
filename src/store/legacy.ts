// The transitional store (docs/umstellung-ohne-pi-durable.md, U1): pi-durable behind phi-spaces' storage types. The one
// place in src that opens a pi-durable host; the rest sees a StoreHost. It goes with the own store (U2/U3); the
// storage-level replication (primary-sync, replica-control) keeps `LegacyStorage` until U4.
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage, type Storage } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Context } from "../context.ts";
import type { ClosableStoreHost } from "./types.ts";

/** pi-durable's storage, for the storage-level replication only (U4 replaces it). */
export type LegacyStorage = Storage;

/** A host over pi-durable storage. A space host needs no models; pi-durable asks for a model registry all the same. */
export async function openLegacyHost(storage: LegacyStorage, ctx: Context): Promise<ClosableStoreHost> {
	return Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
}

/** A throwaway host in memory (tests, examples). */
export function openMemoryStore(ctx: Context): Promise<ClosableStoreHost> { return openLegacyHost(new MemoryStorage(), ctx); }

/** A host over a SQLite file. */
export async function openSqliteStore(path: string, ctx: Context): Promise<ClosableStoreHost> { return openLegacyHost(await openNodeSqliteStorage(path), ctx); }

/** A host over a JSONL directory (the older format; read by the migration in U5). */
export async function openJsonlStore(dir: string, ctx: Context): Promise<ClosableStoreHost> { return openLegacyHost(await openNodeJsonlStorage(dir, ctx), ctx); }

/** pi-durable SQLite storage for the primary/sync Spaces (their journal replicates its writes until U4). */
export function openLegacySqliteStorage(path: string): Promise<LegacyStorage> { return openNodeSqliteStorage(path); }
