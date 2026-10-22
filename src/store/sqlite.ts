// phi-spaces' own SQLite store (docs/umstellung-ohne-pi-durable.md, U2): one file, `node:sqlite`, WAL, and by default
// synchronous=FULL (every acknowledged commit survives a power loss, decision D3). Tables:
//
//   store_meta      format version, store id, commit counter
//   documents       one row per document: its whole value, or for a document with parts its head
//   parts           one row per record of a part (a Space's entries, claims, generations, stream batches)
//   migration_runs  imports of older stores (U5)
//
// Writes go to a writer thread (store/sqlite-writer.ts) in batches: whatever commits arrive while one batch is written
// go together into the next, one transaction and one sync for all of them. A store has one owner process: a lock file
// next to it is held exclusively while the store is open (a second process is refused; a crash releases it).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { headOf, joinParts, partChanges, type PartRow, type PartSpec } from "./parts.ts";
import { OwnStoreHost, type CommitSet, type Ledger, type StoreStats, type StoredDoc } from "./host.ts";
import type { WriteOp, WriterReply, WriterRequest } from "./sqlite-writer.ts";

/** The format of the file; a newer one is refused, an older one is migrated (none yet). */
export const FORMAT_VERSION = 1;

export type SqliteStoreOptions = {
	/** FULL (default): a commit is acknowledged once it is on the disk. NORMAL: faster, the last commits can be lost when
	 *  the system (not the process) fails. */
	synchronous?: "FULL" | "NORMAL";
};

/** Refused: another process owns the store, or the file is of an unknown format. */
export class StoreUnavailable extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, key)) STRICT;
CREATE TABLE IF NOT EXISTS parts (kind TEXT NOT NULL, key TEXT NOT NULL, part TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, key, part, id)) STRICT;
CREATE INDEX IF NOT EXISTS parts_order ON parts (kind, key, part, ord);
CREATE TABLE IF NOT EXISTS migration_runs (export_id TEXT PRIMARY KEY, manifest_hash TEXT NOT NULL, progress TEXT NOT NULL, state TEXT NOT NULL) STRICT;
`;

const docKey = (key: string | null) => key ?? "";
function deepFreeze(v: unknown): void {
	if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
	Object.freeze(v);
	for (const x of Object.values(v)) deepFreeze(x);
}

class SqliteLedger implements Ledger {
	readonly #read: DatabaseSync;
	readonly #lock: DatabaseSync;
	readonly #worker: Worker;
	/** Per document with parts: the order of each array part's records (store/parts.ts). */
	readonly #ords = new Map<string, Map<string, Map<string, number>>>();
	#batch = 0;
	#writing: { batch: number; done: Array<{ resolve: () => void; reject: (e: Error) => void }> } | null = null;
	#queued: { ops: WriteOp[]; done: Array<{ resolve: () => void; reject: (e: Error) => void }> } = { ops: [], done: [] };
	#failure: Error | null = null;
	#closing: (() => void) | null = null;
	readonly #stats = { batches: 0, commits: 0, rows: 0, writeMs: 0, maxBatch: 0 };
	#sentAt = 0;

	stats(): StoreStats { return { ...this.#stats, queued: this.#queued.done.length }; }

	constructor(read: DatabaseSync, lock: DatabaseSync, worker: Worker) {
		this.#read = read; this.#lock = lock; this.#worker = worker;
		worker.on("message", (r: WriterReply) => this.#reply(r));
		worker.on("error", (e) => this.#fail(e instanceof Error ? e : new Error(String(e))));
	}

	load(kind: string, key: string | null, parts?: readonly PartSpec[]): StoredDoc | null {
		const row = this.#read.prepare("SELECT version, value FROM documents WHERE kind = ? AND key = ?").get(kind, docKey(key)) as { version: number; value: string } | undefined;
		if (!row) return null;
		let value = JSON.parse(row.value) as unknown;
		if (parts?.length) {
			const rows = new Map<string, PartRow[]>(), ords = new Map<string, Map<string, number>>();
			for (const r of this.#read.prepare("SELECT part, id, ord, value FROM parts WHERE kind = ? AND key = ? ORDER BY part, ord").iterate(kind, docKey(key)) as Iterable<{ part: string; id: string; ord: number; value: string }>) {
				const v = JSON.parse(r.value);
				deepFreeze(v); // records of parts are values (the host freezes the ones commits write; these come from the file)
				if (!rows.has(r.part)) rows.set(r.part, []);
				rows.get(r.part)!.push({ part: r.part, id: r.id, ord: r.ord, value: v });
				if (!ords.has(r.part)) ords.set(r.part, new Map());
				ords.get(r.part)!.set(r.id, r.ord);
			}
			value = joinParts(value, parts, rows);
			this.#ords.set(`${kind}\u0000${docKey(key)}`, ords);
		}
		return { kind, key, version: row.version, value };
	}

	persist(set: CommitSet): Promise<void> {
		if (this.#failure) return Promise.reject(this.#failure);
		const ops: WriteOp[] = [];
		for (const d of set.put) {
			const k = docKey(d.key);
			if (!d.parts?.length) { ops.push({ t: "doc", kind: d.kind, key: k, version: d.version, value: JSON.stringify(d.value) }); continue; }
			ops.push({ t: "doc", kind: d.kind, key: k, version: d.version, value: JSON.stringify(headOf(d.value, d.parts)) });
			const id = `${d.kind}\u0000${k}`;
			if (!this.#ords.has(id)) this.#ords.set(id, new Map());
			const c = partChanges(d.before, d.value, d.parts, d.changes ?? new Map(), this.#ords.get(id)!);
			for (const r of c.put) ops.push({ t: "part", kind: d.kind, key: k, part: r.part, id: r.id, ord: r.ord, value: JSON.stringify(r.value) });
			for (const r of c.del) ops.push({ t: "partDel", kind: d.kind, key: k, part: r.part, id: r.id });
		}
		for (const r of set.retired) { ops.push({ t: "retire", kind: r.kind, key: docKey(r.key) }); this.#ords.delete(`${r.kind}\u0000${docKey(r.key)}`); }
		return new Promise((resolve, reject) => {
			this.#queued.ops.push(...ops);
			this.#queued.done.push({ resolve, reject });
			if (!this.#writing) this.#send();
		});
	}

	/** Sends what is queued as one batch. */
	#send(): void {
		if (!this.#queued.done.length) return;
		const next = this.#queued;
		this.#queued = { ops: [], done: [] };
		this.#writing = { batch: ++this.#batch, done: next.done };
		this.#worker.ref(); // a write in flight keeps the process alive until it is durable
		this.#stats.batches++; this.#stats.commits += next.done.length; this.#stats.rows += next.ops.length; this.#stats.maxBatch = Math.max(this.#stats.maxBatch, next.done.length);
		this.#sentAt = performance.now();
		this.#worker.postMessage({ type: "write", batch: this.#batch, ops: next.ops } satisfies WriterRequest);
	}

	#reply(r: WriterReply): void {
		if (r.type === "closed") { this.#closing?.(); return; }
		if (r.type === "written" && this.#writing?.batch === r.batch) {
			this.#stats.writeMs += performance.now() - this.#sentAt;
			const done = this.#writing.done;
			this.#writing = null;
			for (const d of done) d.resolve();
			this.#send();
			if (!this.#writing) this.#worker.unref(); // idle: the store does not keep the process alive
			return;
		}
		if (r.type === "failed") this.#fail(new Error(`the store could not write: ${r.error}`));
	}

	/** A write failed: this batch and everything after it fails; the store takes no more (plan 4.1: reopen it). */
	#fail(e: Error): void {
		if (this.#failure) return;
		this.#failure = e;
		for (const d of [...(this.#writing?.done ?? []), ...this.#queued.done]) d.reject(e);
		this.#writing = null;
		this.#queued = { ops: [], done: [] };
	}

	/** Waits for everything queued to be written. */
	async drain(): Promise<void> {
		while (this.#writing || this.#queued.done.length) {
			if (this.#failure) return;
			await new Promise<void>((r) => setTimeout(r, 1));
		}
	}

	async close(): Promise<void> {
		await this.drain();
		this.#worker.ref(); // waiting for the writer to close keeps the process alive
		await new Promise<void>((resolve) => { this.#closing = resolve; this.#worker.postMessage({ type: "close" } satisfies WriterRequest); });
		await this.#worker.terminate();
		this.#read.close();
		try { this.#lock.exec("ROLLBACK"); } catch { /* the lock transaction ends with the connection */ }
		this.#lock.close();
	}
}

/** Opens (or creates) the store at `path` and the host over it. Refuses when another process owns the store or the
 *  file is of a newer format. */
export async function openSqliteHost(path: string, o: SqliteStoreOptions = {}): Promise<OwnStoreHost> {
	mkdirSync(dirname(path), { recursive: true });
	// the owner lock: an exclusive lock on a file next to the store, held while it is open
	const lock = new DatabaseSync(`${path}.owner`, { timeout: 0 });
	try { lock.exec("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;"); }
	catch (e) { lock.close(); throw new StoreUnavailable(`another process owns the store ${path} (${(e as Error).message})`); }
	let read: DatabaseSync | null = null;
	try {
		read = new DatabaseSync(path, { timeout: 10_000 });
		read.exec("PRAGMA journal_mode = WAL;");
		// a file of another program (pi-durable has a `documents` table of its own) is refused, never taken over
		const tables = (read.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
		if (tables.length && !tables.includes("store_meta")) throw new StoreUnavailable(`${path} is not a phi-spaces store (tables: ${tables.slice(0, 6).join(", ")}); move it aside or import it (docs/umstellung-ohne-pi-durable.md, U5)`);
		read.exec(SCHEMA);
		const meta = new Map((read.prepare("SELECT key, value FROM store_meta").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
		if (!meta.has("format_version")) {
			const put = read.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)");
			put.run("format_version", String(FORMAT_VERSION)); put.run("store_id", randomUUID()); put.run("commit_seq", "0");
		} else if (Number(meta.get("format_version")) > FORMAT_VERSION) throw new StoreUnavailable(`the store ${path} has format ${meta.get("format_version")}; this version reads up to ${FORMAT_VERSION}`);
		const mode = (read.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
		if (mode !== "wal") throw new StoreUnavailable(`the store ${path} is not in WAL mode (${mode})`);
	} catch (e) { read?.close(); lock.close(); throw e; }
	const worker = new Worker(new URL("./sqlite-writer.ts", import.meta.url));
	const opened = await new Promise<WriterReply>((resolve) => { worker.once("message", resolve); worker.postMessage({ type: "open", path, synchronous: o.synchronous ?? "FULL" } satisfies WriterRequest); });
	if (opened.type !== "opened") { await worker.terminate(); read.close(); lock.close(); throw new StoreUnavailable(`the store writer could not open ${path}: ${(opened as { error?: string }).error}`); }
	const host = new OwnStoreHost(new SqliteLedger(read, lock, worker));
	// an idle writer does not keep the process alive (unref after its listeners: a listener refs it again)
	worker.unref();
	return host;
}
