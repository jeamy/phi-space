// What the primary/sync journal (src/primary-sync.ts) needs of a store (docs/umstellung-ohne-pi-durable.md, U4). The
// journal itself (hash chain, configuration steps, fencing, the one unresolved candidate) does not depend on the store;
// a store brings the shape of its writes (a codec) and a few operations on its stopped or exclusively opened files.
// The own SQLite store (store/sqlite.ts) is the one such store; pi-durable's is gone (decision D6).
import type { Context } from "../context.ts";

/** What the replication marker of a store says: the configuration, revision and batch of the last applied entry. */
export type SyncMarker = { configHash: string; revision: number; batchHash: string; previousHash: string };

/** The writes of one store kind, as the journal checks them. `W` is the store's own write type. */
export interface SyncCodec<W = unknown> {
	/** Stored with a journal: a journal of one format is refused by a store of another. */
	readonly format: "own";
	/** The write that sets the marker of `spaceId` to `value`: a change of `existing` (its ref), or a new marker `newId`. */
	markerWrite(spaceId: string, value: SyncMarker, existing: unknown | null, newId: unknown): W;
	/** If `w` is the marker write of `spaceId`: its value and the marker's ref (for `touches`); else null. */
	markerOf(w: W, spaceId: string): { value: unknown; ref: unknown } | null;
	/** Whether a business write touches the marker `ref` (forbidden). */
	touches(w: W, ref: unknown): boolean;
	/** Whether `w` may be part of a bootstrap chunk (it only creates). */
	bootstrapWrite(w: W): boolean;
}

/** A store the journal writes and checks: exclusively opened (a stopped daemon), or the one under a primary's host. */
export interface SyncStore<W = unknown> {
	readonly codec: SyncCodec<W>;
	marker(spaceId: string, ctx: Context): Promise<{ ref: unknown; value: SyncMarker } | null>;
	/** Applies `writes` atomically (the marker write is the last of them). */
	commit(writes: readonly W[], ctx: Context): Promise<unknown>;
	/** Every live record as creates, in an order that applies, without the marker; and its digest. */
	capture(ctx: Context): Promise<{ writes: W[]; digest: string }>;
	/** No data at all (a replica starts from an empty store). */
	isEmpty(ctx: Context): Promise<boolean>;
	/** A fresh id for a new marker. */
	mintId(): Promise<unknown>;
	/** Releases the store (its owner lock). */
	close(ctx?: Context): Promise<void>;
	/** The store as a primary under a journal (primarySyncStorage); absent where the caller wraps the store itself. */
	replicated?(journal: any, peer: any, o: any): unknown;
}

export const isSyncStore = (v: unknown): v is SyncStore => typeof v === "object" && v !== null && "codec" in v && typeof (v as SyncStore).capture === "function";
