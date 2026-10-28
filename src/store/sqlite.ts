// phi-spaces' own SQLite store (docs/umstellung-ohne-pi-durable.md, U2): one file, `node:sqlite`, WAL, and by default
// synchronous=FULL (every acknowledged commit survives a power loss, decision D3). Tables:
//
//   store_meta      format version, store id, commit counter
//   documents       one row per document: its whole value, or for a document with parts its head
//   parts           one row per record of a part (a Space's entries, claims, generations, stream batches); a map part
//                   kept on the disk (PartDef.disk, store/disk-map.ts) fills the index columns at, grp, flag
//
// Writes go to a writer thread (store/sqlite-writer.ts) in batches: whatever commits arrive while one batch is written
// go together into the next, one transaction and one sync for all of them. A store has one owner process: a lock file
// next to it is held exclusively while the store is open (a second process is refused; a crash releases it).
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { Worker } from "node:worker_threads";
import { headOf, joinParts, partAt, partChanges, type PartRow, type PartSpec } from "./parts.ts";
import { OwnStoreHost, type CommitSet, type Ledger, type StoreStats, type StoredDoc } from "./host.ts";
import { DiskMap, isDiskMap, type DiskMapSource } from "./disk-map.ts";
import { deepFreeze } from "./types.ts";
import { writerSource, type WriteOp, type WriterReply, type WriterRequest } from "./sqlite-writer.ts";

/** The format of the file; a newer one is refused, an older one is migrated (1 to 2: the index columns of parts). */
export const FORMAT_VERSION = 2;

/** Records of the parts of the documents the host keeps in memory (a Space counts its entries twice here; RSS stays near 300 MB for 100 Spaces of 10 000 entries at 50 000). */
export const DEFAULT_MEMORY_BUDGET = 40_000;

export type SqliteStoreOptions = {
	/** Memory budget of the host in records (default DEFAULT_MEMORY_BUDGET): the documents untouched for longest are
	 *  dropped and read again from the file when needed; watched ones and ones being written are kept. */
	memoryBudget?: number;
	/** A document used within this many ms is not dropped, whatever the budget (default 250). */
	hotMs?: number;
	/** FULL (default): a commit is acknowledged once it is on the disk. NORMAL: faster, the last commits can be lost when
	 *  the system (not the process) fails. */
	synchronous?: "FULL" | "NORMAL";
	/** Tests: the store file may not grow beyond this many pages, as on a full disk (SQLITE_FULL). */
	maxPages?: number;
	/** Enumerating a map part on the disk throws instead of reading every key (tests: such a scan is a defect). */
	strictDiskMaps?: boolean;
	/** Checks every commit's rows before the commit is published; throwing refuses that commit, which then leaves no
	 *  trace and the store usable (the replicated store's journal budget). */
	gate?: (ops: readonly WriteOp[]) => void;
	/** Tests: what the next write of a batch does (test/support/persistent.ts) — fail before the data is written, or write
	 *  it and lose the answer. */
	faults?: StoreFaults;
	/** Primary/sync: the replication of every batch (store/sync-sqlite.ts). */
	replication?: LedgerReplication;
};
export type StoreFaults = { take(ops: readonly WriteOp[]): { fault: "failBeforeCommit" | "loseAnswer"; error: Error } | undefined;
	/** Every commit's rows as it is handed over (tests measure commit sizes). */
	observe?(ops: readonly WriteOp[]): void;
	/** The batch the last `take` saw is durable; its commits are not acknowledged yet (a crash test stops here). */
	written?(): void };

/** Refused: another process owns the store, or the file is of an unknown format. */
export class StoreUnavailable extends Error {}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, key)) STRICT;
CREATE TABLE IF NOT EXISTS parts (kind TEXT NOT NULL, key TEXT NOT NULL, part TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, value TEXT NOT NULL, at INTEGER, grp TEXT, flag INTEGER, PRIMARY KEY (kind, key, part, id)) STRICT;
CREATE INDEX IF NOT EXISTS parts_order ON parts (kind, key, part, ord);
`;
// after a format 1 file got its index columns
const INDEXES = `
CREATE INDEX IF NOT EXISTS parts_at ON parts (kind, key, part, at) WHERE at IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_grp ON parts (kind, key, part, grp) WHERE grp IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_open ON parts (kind, key, part) WHERE at IS NULL;
`;

const docKey = (key: string | null) => key ?? "";

class SqliteLedger implements Ledger {
	readonly #read: DatabaseSync;
	readonly #lock: DatabaseSync;
	readonly #worker: Worker;
	/** Per document with parts: the order of each array part's records (store/parts.ts). */
	readonly #ords = new Map<string, Map<string, Map<string, number>>>();
	/** Parts kept inline in a document's head (written before its definition had parts): the next commit writes them whole. */
	readonly #inline = new Set<string>();
	/** Per document: its map parts on the disk, by part name. */
	readonly #diskMaps = new Map<string, Map<string, DiskMap>>();
	readonly #strict: boolean;
	/** Commits handed over (`persist`) and commits durable, counted alike: what a commit writes into a map part on the
	 *  disk is held in memory until the commit is durable. */
	#handed = 0;
	#durableCount = 0;
	#batch = 0;
	#writing: { batch: number; done: Waiting[]; lost: Error | null } | null = null;
	readonly #stmt = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
	#prep(sql: string): ReturnType<DatabaseSync["prepare"]> { let p = this.#stmt.get(sql); if (!p) this.#stmt.set(sql, (p = this.#read.prepare(sql))); return p; }
	/** Commits handed over and not yet sent, each with its rows. */
	#queued: Waiting[] = [];
	#failure: Error | null = null;
	/** Why the store takes no more work (absent: it does). After a sealed candidate failed this is not the candidate's
	 *  own error but the refusal of everything after it. */
	get failure(): Error | null { return this.#failure; }
	/** Tests: what the next write does (SqliteStoreOptions.faults). */
	faults?: StoreFaults;
	/** Primary/sync (store/sync-sqlite.ts): seals a batch, and waits for its standby, before it is written. */
	replication?: LedgerReplication;
	#closing: (() => void) | null = null;
	readonly #stats = { batches: 0, commits: 0, rows: 0, writeMs: 0, maxBatch: 0 };
	#sentAt = 0;

	stats(): StoreStats { return { ...this.#stats, queued: this.#queued.length }; }

	constructor(read: DatabaseSync, lock: DatabaseSync, worker: Worker, strict: boolean) {
		this.#read = read; this.#lock = lock; this.#worker = worker; this.#strict = strict;
		worker.on("message", (r: WriterReply) => this.#reply(r));
		worker.on("error", (e) => this.#fail(e instanceof Error ? e : new Error(String(e))));
	}

	/** The host dropped a document: what is kept for it here goes too (it is read again when it is next needed). */
	forget(kind: string, key: string | null): void {
		const id = `${kind}\u0000${docKey(key)}`;
		this.#ords.delete(id);
		this.#diskMaps.delete(id);
		for (const k of [...this.#inline]) if (k.startsWith(`${id}\u0000`)) this.#inline.delete(k);
	}

	load(kind: string, key: string | null, parts?: readonly PartSpec[]): StoredDoc | null {
		const row = this.#read.prepare("SELECT version, value FROM documents WHERE kind = ? AND key = ?").get(kind, docKey(key)) as { version: number; value: string } | undefined;
		if (!row) return null;
		let value = JSON.parse(row.value) as unknown;
		if (parts?.length) {
			const rows = new Map<string, PartRow[]>(), ords = new Map<string, Map<string, number>>();
			const onDisk = parts.filter((p) => p.disk && p.kind === "map");
			for (const r of this.#read.prepare(`SELECT part, id, ord, value FROM parts WHERE kind = ? AND key = ? AND part NOT IN (${onDisk.map(() => "?").join(", ")}) ORDER BY part, ord`).iterate(kind, docKey(key), ...onDisk.map((p) => p.path.join("."))) as Iterable<{ part: string; id: string; ord: number; value: string }>) {
				const v = JSON.parse(r.value);
				deepFreeze(v); // records of parts are values (the host freezes the ones commits write; these come from the file)
				if (!rows.has(r.part)) rows.set(r.part, []);
				rows.get(r.part)!.push({ part: r.part, id: r.id, ord: r.ord, value: v });
				if (!ords.has(r.part)) ords.set(r.part, new Map());
				ords.get(r.part)!.set(r.id, r.ord);
			}
			value = joinParts(value, parts.filter((p) => !onDisk.includes(p)), rows);
			this.#ords.set(`${kind}\u0000${docKey(key)}`, ords);
			// a part kept inline in the head (written before the definition had parts) is written as rows by the next commit
			const inline = (p: PartSpec) => { const v = partAt(value, p.path); return Array.isArray(v) ? v.length > 0 : v !== null && typeof v === "object" && Object.keys(v).length > 0; };
			for (const p of parts) if (!rows.has(p.path.join(".")) && inline(p) && (!onDisk.includes(p) || !this.#prep("SELECT 1 FROM parts WHERE kind = ? AND key = ? AND part = ? LIMIT 1").get(kind, docKey(key), p.path.join(".")))) this.#inline.add(`${kind}\u0000${docKey(key)}\u0000${p.path.join(".")}`);
			// a map part on the disk stays there: the document holds a DiskMap in its place
			for (const p of onDisk) {
				const parent = partAt(value, p.path.slice(0, -1));
				if (parent === null || typeof parent !== "object" || !(p.path.at(-1)! in parent)) continue;
				if (this.#inline.has(`${kind}\u0000${docKey(key)}\u0000${p.path.join(".")}`)) continue; // a plain map until it is written as rows
				this.#index(kind, docKey(key), p);
				const m = new DiskMap(this.#source(kind, docKey(key), p.path.join(".")), p.disk!, () => this.#handed + 1, this.#strict);
				(parent as Record<string, unknown>)[p.path.at(-1)!] = m.proxy;
				this.#diskMapsOf(kind, docKey(key)).set(p.path.join("."), m);
			}
		}
		return { kind, key, version: row.version, value };
	}

	#diskMapsOf(kind: string, key: string): Map<string, DiskMap> {
		const id = `${kind}\u0000${key}`;
		if (!this.#diskMaps.has(id)) this.#diskMaps.set(id, new Map());
		return this.#diskMaps.get(id)!;
	}

	/** Rows of a format 1 file have no index columns yet: filled once per part from their values. */
	#index(kind: string, key: string, p: PartSpec): void {
		const mark = `indexed\u0000${kind}\u0000${key}\u0000${p.path.join(".")}`;
		if (this.#prep("SELECT 1 FROM store_meta WHERE key = ?").get(mark)) return;
		const path = (f: string) => `$.${f}`;
		this.#read.prepare(`UPDATE parts SET at = json_extract(value, ?), grp = json_extract(value, ?), flag = CASE WHEN json_extract(value, ?) THEN 1 ELSE 0 END WHERE kind = ? AND key = ? AND part = ? AND grp IS NULL`)
			.run(path(p.disk!.at), path(p.disk!.group), path(p.disk!.flag), kind, key, p.path.join("."));
		this.#read.prepare("INSERT INTO store_meta (key, value) VALUES (?, '1')").run(mark);
	}

	/** The rows of one map part on the disk, as DiskMap asks for them (read connection: what is durable). */
	#source(kind: string, key: string, part: string): DiskMapSource {
		const base = "FROM parts WHERE kind = ? AND key = ? AND part = ?";
		const list = (n: number) => Array.from({ length: n }, () => "?").join(", ");
		return {
			get: (id) => (this.#prep(`SELECT value ${base} AND id = ?`).get(kind, key, part, id) as { value: string } | undefined)?.value,
			ids: () => (this.#prep(`SELECT id ${base}`).all(kind, key, part) as Array<{ id: string }>).map((r) => r.id),
			due: (t, limit, inGroups, known) => {
				const sql = `SELECT id, value ${base} AND at IS NOT NULL AND at <= ? AND (flag = 0${inGroups.length ? ` OR grp IN (${list(inGroups.length)})` : ""} OR grp NOT IN (${list(known.length)})) ORDER BY id LIMIT ?`;
				return (this.#prep(sql).all(kind, key, part, t, ...inGroups, ...known, limit) as Array<{ id: string; value: string }>).map((r) => [r.id, r.value] as [string, string]);
			},
			nextAt: (t) => (this.#prep(`SELECT min(at) AS at ${base} AND at IS NOT NULL AND at > ? AND flag = 0`).get(kind, key, part, t) as { at: number | null }).at ?? undefined,
			group: (g, limit) => (this.#prep(`SELECT id ${base} AND grp = ? LIMIT ?`).all(kind, key, part, g, limit) as Array<{ id: string }>).map((r) => r.id),
			unindexed: () => (this.#prep(`SELECT id, value ${base} AND at IS NULL`).all(kind, key, part) as Array<{ id: string; value: string }>).map((r) => [r.id, r.value] as [string, string]),
			after: (after, limit) => (this.#prep(`SELECT id, value ${base} AND id > ? ORDER BY id LIMIT ?`).all(kind, key, part, after ?? "", limit) as Array<{ id: string; value: string }>).map((r) => [r.id, r.value] as [string, string]),
			firstIds: (limit) => (this.#prep(`SELECT id ${base} ORDER BY id LIMIT ?`).all(kind, key, part, limit) as Array<{ id: string }>).map((r) => r.id),
		};
	}

	/** The row changes of a commit, before anything of it is published (OwnStoreHost). A store with a gate (a replicated
	 *  one: its journal's budget) may refuse them here; then the order bookkeeping is put back and nothing happened. */
	prepare(set: CommitSet): WriteOp[] {
		if (this.#failure) throw this.#failure;
		const undo: Array<() => void> = [];
		try { const ops = this.#ops(set, undo); this.gate?.(ops); return ops; }
		catch (e) { for (const u of undo.reverse()) u(); throw e; }
	}

	/** Checks a commit's rows before it is published; throwing refuses the commit (prepare). */
	gate?: (ops: readonly WriteOp[]) => void;

	#ops(set: CommitSet, undo?: Array<() => void>): WriteOp[] {
		const ops: WriteOp[] = [];
		for (const d of set.put) {
			const k = docKey(d.key);
			if (!d.parts?.length) { ops.push({ t: "doc", kind: d.kind, key: k, version: d.version, value: JSON.stringify(d.value) }); continue; }
			ops.push({ t: "doc", kind: d.kind, key: k, version: d.version, value: JSON.stringify(headOf(d.value, d.parts)) });
			const id = `${d.kind}\u0000${k}`;
			if (!this.#ords.has(id)) { this.#ords.set(id, new Map()); undo?.push(() => this.#ords.delete(id)); }
			const inline = d.parts.filter((p) => this.#inline.has(`${id}\u0000${p.path.join(".")}`));
			const c = partChanges(inline.length ? headOf(d.before, inline) : d.before, d.value, d.parts, d.changes ?? new Map(), this.#ords.get(id)!, undo);
			for (const part of c.clear) ops.push({ t: "partClear", kind: d.kind, key: k, part });
			const indexOf = new Map(d.parts.filter((p) => p.disk).map((p) => [p.path.join("."), p.disk!]));
			for (const r of c.put) {
				const ix = indexOf.get(r.part), v = r.value as Record<string, unknown> | null;
				const at = ix && typeof v?.[ix.at] === "number" ? (v[ix.at] as number) : null, grp = ix && typeof v?.[ix.group] === "string" ? (v[ix.group] as string) : null;
				ops.push({ t: "part", kind: d.kind, key: k, part: r.part, id: r.id, ord: r.ord, value: JSON.stringify(r.value), at, grp, flag: ix ? (v?.[ix.flag] ? 1 : 0) : null });
			}
			for (const r of c.del) ops.push({ t: "partDel", kind: d.kind, key: k, part: r.part, id: r.id });
		}
		for (const r of set.retired) ops.push({ t: "retire", kind: r.kind, key: docKey(r.key) });
		return ops;
	}

	persist(set: CommitSet, prepared?: unknown): Promise<void> {
		if (this.#failure) return Promise.reject(this.#failure);
		const written = ++this.#handed;
		const ops = (prepared as WriteOp[] | undefined) ?? this.#ops(set);
		this.faults?.observe?.(ops);
		for (const d of set.put) {
			// a map part still in memory (its document is new in this process) goes on the disk from now on
			for (const p of d.parts ?? []) {
				if (!p.disk || p.kind !== "map") continue;
				const k = docKey(d.key);
				const parent = partAt(d.value, p.path.slice(0, -1));
				const last = p.path.at(-1)!, m = parent !== null && typeof parent === "object" ? (parent as Record<string, unknown>)[last] : undefined;
				if (m === null || typeof m !== "object" || isDiskMap(m)) continue;
				const disk = DiskMap.adopt(this.#source(d.kind, k, p.path.join(".")), p.disk, () => this.#handed + 1, this.#strict, m as Record<string, unknown>, written);
				(parent as Record<string, unknown>)[last] = disk.proxy;
				this.#diskMapsOf(d.kind, k).set(p.path.join("."), disk);
			}
		}
		for (const r of set.retired) { this.#ords.delete(`${r.kind}\u0000${docKey(r.key)}`); this.#diskMaps.delete(`${r.kind}\u0000${docKey(r.key)}`); }
		for (const d of set.put) for (const p of d.parts ?? []) this.#inline.delete(`${d.kind}\u0000${docKey(d.key)}\u0000${p.path.join(".")}`);
		return new Promise((resolve, reject) => {
			this.#queued.push({ ops, bytes: this.replication ? Buffer.byteLength(JSON.stringify(ops)) : rowBytes(ops), resolve, reject });
			if (!this.#writing) this.#send();
		});
	}

	/** Sends what is queued as one batch: whatever came while the previous one was written, cut where a replicated
	 *  batch would outgrow its journal entry. One batch at a time (a primary has at most one unresolved candidate). */
	#send(): void {
		if (!this.#queued.length || this.#failure) return;
		const limit = this.replication?.maxBatchBytes ?? Infinity;
		let n = 0, bytes = 0;
		while (n < this.#queued.length && (n === 0 || bytes + this.#queued[n]!.bytes <= limit)) bytes += this.#queued[n++]!.bytes;
		const done = this.#queued.splice(0, n), batch = ++this.#batch;
		this.#writing = { batch, done, lost: null };
		this.#worker.ref(); // a write in flight keeps the process alive until it is durable
		this.#stats.batches++; this.#stats.commits += done.length; this.#stats.maxBatch = Math.max(this.#stats.maxBatch, done.length);
		void this.#write(batch, done.flatMap((d) => d.ops), bytes);
	}

	async #write(batch: number, rows: WriteOp[], bytes: number): Promise<void> {
		let ops = rows;
		try {
			// sealed (and confirmed by the standby) before the data is written; a failure after sealing poisons the store
			if (this.replication) ops = await this.replication.seal(rows, bytes);
			const f = this.faults?.take(ops);
			if (f?.fault === "failBeforeCommit") throw f.error;
			if (f && this.#writing?.batch === batch) this.#writing.lost = f.error;
		} catch (e) { const f = this.replication?.failed(e); this.#fail(f?.now ?? (e instanceof Error ? e : new Error(String(e))), f?.later); return; }
		if (this.#writing?.batch !== batch) return;
		this.#stats.rows += ops.length;
		this.#sentAt = performance.now();
		this.#worker.postMessage({ type: "write", batch, ops } satisfies WriterRequest);
	}

	#reply(r: WriterReply): void {
		if (r.type === "closed") { this.#closing?.(); return; }
		if (r.type === "written" && this.#writing?.batch === r.batch) {
			this.#stats.writeMs += performance.now() - this.#sentAt;
			const { done, lost } = this.#writing;
			this.#writing = null;
			this.faults?.written?.();
			// durable, but the answer is lost (a test's fault): as after a crash, the journal learns it when it is reopened
			if (lost) { const f = this.replication?.failed(lost); for (const d of done) d.reject(f?.now ?? lost); this.#fail(f?.now ?? lost, f?.later); return; }
			try { this.replication?.applied(); } catch (e) { this.#fail(e as Error); return; }
			// what these commits wrote into map parts on the disk is read from there from now on
			this.#durableCount += done.length;
			for (const maps of this.#diskMaps.values()) for (const m of maps.values()) m.settle(this.#durableCount);
			for (const d of done) d.resolve();
			for (const w of this.#idleWaiters.splice(0)) w();
			this.#send();
			if (!this.#writing) this.#worker.unref(); // idle: the store does not keep the process alive
			return;
		}
		if (r.type === "failed") { const e = new Error(`the store could not write: ${r.error}`), f = this.replication?.failed(e); this.#fail(f?.now ?? e, f?.later); }
	}

	/** A write failed: this batch and everything after it fails (with `later`, if given); the store takes no more (plan
	 *  4.1: reopen it). */
	#fail(e: Error, later?: Error): void {
		if (this.#failure) return;
		this.#failure = later ?? e;
		for (const d of this.#writing?.done ?? []) d.reject(e);
		for (const d of this.#queued) d.reject(later ?? e);
		this.#writing = null;
		this.#queued = [];
		for (const w of this.#idleWaiters.splice(0)) w();
	}

	/** Waits for everything queued to be written. */
	#idleWaiters: Array<() => void> = [];
	async drain(): Promise<void> {
		while ((this.#writing || this.#queued.length) && !this.#failure) await new Promise<void>((r) => this.#idleWaiters.push(r));
	}

	/** As a killed process would leave it: nothing more is written or flushed, the owner lock is free (tests). */
	abandon(): void {
		this.#fail(new Error("the store was abandoned"));
		void this.#worker.terminate();
		try { this.#read.close(); } catch { /* already closed */ }
		try { this.#lock.close(); } catch { /* already closed */ }
	}

	async close(): Promise<void> {
		await this.drain();
		// a failed store is reopened before more work: its writer may still wait in a batch that will never be answered
		// (a sealed candidate), so it is stopped as a killed process would be; what it wrote is atomic in the WAL
		if (this.#failure) {
			await this.#worker.terminate();
			try { this.#read.close(); } catch { /* already closed */ }
			try { this.#lock.exec("ROLLBACK"); } catch { /* the lock transaction ends with the connection */ }
			try { this.#lock.close(); } catch { /* already closed */ }
			return;
		}
		this.#worker.ref(); // waiting for the writer to close keeps the process alive
		await new Promise<void>((resolve) => { this.#closing = resolve; this.#worker.postMessage({ type: "close" } satisfies WriterRequest); });
		await this.#worker.terminate();
		this.#read.close();
		try { this.#lock.exec("ROLLBACK"); } catch { /* the lock transaction ends with the connection */ }
		this.#lock.close();
	}
}

type Waiting = { ops: WriteOp[]; bytes: number; resolve: () => void; reject: (e: Error) => void };
const rowBytes = (ops: readonly WriteOp[]) => ops.reduce((n, op) => n + ("value" in op ? op.value.length : 0) + 64, 0);

/** What a primary/sync replication does to the batches of a store (store/sync-sqlite.ts). */
export interface LedgerReplication {
	/** Rows one batch may carry (a journal entry's budget). */
	readonly maxBatchBytes: number;
	/** Seals a batch (`admitted`: the bytes its commits were admitted with), waits for its standby, and returns the rows
	 *  to write (the marker last). Throws CommitSealed when it fails after sealing. */
	seal(rows: WriteOp[], admitted: number): Promise<WriteOp[]>;
	/** The sealed batch is on the disk. */
	applied(): void;
	/** A batch failed: the error its commits get (CommitSealed once it was sealed) and the refusal of everything after. */
	failed(cause: unknown): { now: Error; later?: Error };
}

/** A store file opened by its owner: the read connection and the held owner lock. */
export type StoreFiles = { path: string; read: DatabaseSync; lock: DatabaseSync };

/** Opens (or creates) the store file at `path` for its owner. Refuses when another process owns the store or the file
 *  is of a newer format or of another program. */
export function openFiles(path: string): StoreFiles {
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
		if (tables.length && !tables.includes("store_meta")) throw new StoreUnavailable(`${path} is not a phi-spaces store (tables: ${tables.slice(0, 6).join(", ")}); move it aside: pi-durable stores are discarded, not taken over (decision D6, docs/umstellung-u0-bestand.md)`);
		read.exec(SCHEMA);
		const meta = new Map((read.prepare("SELECT key, value FROM store_meta WHERE key IN ('format_version', 'store_id', 'commit_seq')").all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
		if (!meta.has("format_version")) {
			const put = read.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)");
			put.run("format_version", String(FORMAT_VERSION)); put.run("store_id", randomUUID()); put.run("commit_seq", "0");
		} else if (Number(meta.get("format_version")) > FORMAT_VERSION) throw new StoreUnavailable(`the store ${path} has format ${meta.get("format_version")}; this version reads up to ${FORMAT_VERSION}`);
		else if (Number(meta.get("format_version")) < 2) {
			// format 1 to 2: the index columns of parts (filled per part when its document is first read, #index)
			read.exec("BEGIN IMMEDIATE");
			try {
				const cols = (read.prepare("PRAGMA table_info(parts)").all() as Array<{ name: string }>).map((c) => c.name);
				for (const [c, t] of [["at", "INTEGER"], ["grp", "TEXT"], ["flag", "INTEGER"]] as const) if (!cols.includes(c)) read.exec(`ALTER TABLE parts ADD COLUMN ${c} ${t}`);
				read.prepare("UPDATE store_meta SET value = '2' WHERE key = 'format_version'").run();
				read.exec("COMMIT");
			} catch (e) { read.exec("ROLLBACK"); throw e; }
		}
		read.exec(INDEXES);
		const mode = (read.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode;
		if (mode !== "wal") throw new StoreUnavailable(`the store ${path} is not in WAL mode (${mode})`);
	} catch (e) { read?.close(); lock.close(); throw e; }
	return { path, read, lock };
}

/** Opens (or creates) the store at `path` and the host over it. Refuses when another process owns the store or the
 *  file is of a newer format. */
export async function openSqliteHost(path: string, o: SqliteStoreOptions = {}): Promise<OwnStoreHost> {
	return hostOver(openFiles(path), o);
}

/** The host over opened store files (they belong to it from now on). */
export async function hostOver(files: StoreFiles, o: SqliteStoreOptions): Promise<OwnStoreHost> {
	const { path, read, lock } = files;
	const worker = new Worker(writerSource(), { eval: true });
	const opened = await new Promise<WriterReply>((resolve) => { worker.once("message", resolve); worker.postMessage({ type: "open", path, synchronous: o.synchronous ?? "FULL", ...(o.maxPages ? { maxPages: o.maxPages } : {}) } satisfies WriterRequest); });
	if (opened.type !== "opened") { await worker.terminate(); read.close(); lock.close(); throw new StoreUnavailable(`the store writer could not open ${path}: ${(opened as { error?: string }).error}`); }
	const ledger = new SqliteLedger(read, lock, worker, o.strictDiskMaps ?? process.env.PHI_SPACES_STRICT_DISK_MAPS === "1");
	if (o.gate) ledger.gate = o.gate;
	if (o.faults) ledger.faults = o.faults;
	if (o.replication) ledger.replication = o.replication;
	const host = new OwnStoreHost(ledger, { memoryBudget: o.memoryBudget ?? DEFAULT_MEMORY_BUDGET, ...(o.hotMs !== undefined ? { hotMs: o.hotMs } : {}) });
	// an idle writer does not keep the process alive (unref after its listeners: a listener refs it again)
	worker.unref();
	return host;
}
