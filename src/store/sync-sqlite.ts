// The own SQLite store under primary/sync replication (docs/federation-plan-v3.md 5.3, docs/umstellung-ohne-pi-durable.md
// U4). Two sides:
//
//   - OwnSyncStore: a store file opened by its owner without a host (a stopped daemon). The journal applies, checks and
//     captures it there: a standby materializing its history, a primary recovering its sealed candidate, a bootstrap.
//   - its host as a primary (`replicated`): every batch of commits is sealed in the journal, confirmed by the standby
//     (sync durability), and only then written, its rows and the marker in one SQLite transaction. A batch is
//     acknowledged once it is written; one that fails after sealing poisons the store until it is reopened and its
//     candidate resolved (recoverPrimarySync). The journal's budget is checked per commit before the commit is
//     published, so a refusal leaves no trace and the host usable.
import { randomUUID } from "node:crypto";
import type { Context } from "../context.ts";
import { canonicalJson, digestJson } from "../canonical.ts";
import { canonicalCopy } from "../json.ts";
import type { Json } from "../core.ts";
import { CommitSealed, markSyncBudgetExceeded } from "../commit-sealed.ts";
import { PrimarySyncBlocked, SyncJournalFull, durabilityOf, type PrimaryIntent, type PrimarySyncJournal, type PrimarySyncPeer } from "../primary-sync.ts";
import type { OwnStoreHost } from "./host.ts";
import { OWN_CODEC, markerKey } from "./own-sync-codec.ts";
import { applyOps, prepareOps, type WriteOp } from "./sqlite-ops.ts";
import { hostOver, openFiles, type LedgerReplication, type SqliteStoreOptions, type StoreFaults, type StoreFiles } from "./sqlite.ts";
import type { SyncMarker, SyncStore } from "./sync-store.ts";

const canonical = (v: unknown) => canonicalJson(v as Json);

/** What a primary's host is given besides its store: the journal, the standby, and the checks of its role. */
export type PrimaryOptions = { assertPrimary: () => Promise<void>; now?: () => number; onPoisoned?: (sealed: { revision: number; hash: string }) => void };

/** A store file opened by its owner, without a host. */
export class OwnSyncStore implements SyncStore<WriteOp> {
	readonly codec = OWN_CODEC;
	#files: StoreFiles | null;
	/** The host the files went to: it writes them and closes them; this store only reads its marker then. */
	#host = false;
	/** Tests: what the next commit does (as in a host, SqliteStoreOptions.faults). */
	faults?: StoreFaults;

	constructor(path: string, o: { faults?: StoreFaults } = {}) {
		this.#files = openFiles(path);
		this.#files.read.exec("PRAGMA synchronous = FULL;");
		if (o.faults) this.faults = o.faults;
	}
	get path(): string { return this.#db().path; }
	#db(): StoreFiles { if (!this.#files) throw new Error("this store was closed"); return this.#files; }
	#writable(): StoreFiles { if (this.#host) throw new Error("this store was handed to its host, which writes it"); return this.#db(); }

	async marker(spaceId: string): Promise<{ ref: unknown; value: SyncMarker } | null> {
		const row = this.#db().read.prepare("SELECT value FROM store_meta WHERE key = ?").get(markerKey(spaceId)) as { value: string } | undefined;
		return row ? { ref: markerKey(spaceId), value: JSON.parse(row.value) as SyncMarker } : null;
	}

	async commit(writes: readonly WriteOp[]): Promise<void> {
		const { read } = this.#writable(), f = this.faults?.take(writes);
		if (f?.fault === "failBeforeCommit") throw f.error;
		read.exec("BEGIN IMMEDIATE");
		try { applyOps(prepareOps(read), writes); read.exec("COMMIT"); }
		catch (e) { read.exec("ROLLBACK"); throw e; }
		if (f) throw f.error; // written, the answer lost
	}

	/** Every document and part row as creates, in key order (the marker and the store's own bookkeeping excluded). */
	async capture(): Promise<{ writes: WriteOp[]; digest: string }> {
		const { read } = this.#db(), writes: WriteOp[] = [];
		for (const r of read.prepare("SELECT kind, key, version, value FROM documents ORDER BY kind, key").all() as Array<{ kind: string; key: string; version: number; value: string }>)
			writes.push({ t: "doc", kind: r.kind, key: r.key, version: r.version, value: r.value });
		for (const r of read.prepare("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, ord, id").all() as Array<{ kind: string; key: string; part: string; id: string; ord: number; value: string; at: number | null; grp: string | null; flag: number | null }>)
			writes.push({ t: "part", kind: r.kind, key: r.key, part: r.part, id: r.id, ord: r.ord, value: r.value, at: r.at, grp: r.grp, flag: r.flag });
		return { writes: canonicalCopy(writes), digest: digestJson(writes) };
	}

	async isEmpty(): Promise<boolean> {
		const { read } = this.#db();
		return !read.prepare("SELECT 1 FROM documents LIMIT 1").get() && !read.prepare("SELECT 1 FROM parts LIMIT 1").get();
	}

	async mintId(): Promise<string> { return randomUUID(); }

	/** The host over this store; its files belong to the host from now on. */
	openHost(o: SqliteStoreOptions = {}): Promise<OwnStoreHost> {
		const files = this.#writable();
		this.#host = true; // the host closes the files; the replication reads the marker through them meanwhile
		return hostOver(files, { ...(this.faults ? { faults: this.faults } : {}), ...o });
	}

	/** This store as a primary under `journal` (primarySyncStorage): `open()` gives its host. */
	replicated(journal: PrimarySyncJournal, peer: PrimarySyncPeer | null, o: PrimaryOptions): ReplicatedOwnStore {
		return new ReplicatedOwnStore(this, journal, peer, o);
	}

	async close(_ctx?: Context): Promise<void> {
		if (!this.#files || this.#host) return;
		const { read, lock } = this.#files;
		this.#files = null;
		read.close();
		try { lock.exec("ROLLBACK"); } catch { /* ends with the connection */ }
		lock.close();
	}
}

/** A primary's store, before its host is opened (`open`). */
export class ReplicatedOwnStore {
	readonly store: OwnSyncStore;
	readonly #journal: PrimarySyncJournal;
	readonly #peer: PrimarySyncPeer | null;
	readonly #o: PrimaryOptions;
	constructor(store: OwnSyncStore, journal: PrimarySyncJournal, peer: PrimarySyncPeer | null, o: PrimaryOptions) {
		this.store = store; this.#journal = journal; this.#peer = peer; this.#o = o;
	}
	/** The primary's host: every batch goes through the journal (and the standby) before it is written. */
	open(o: SqliteStoreOptions = {}): Promise<OwnStoreHost> {
		const r = primaryReplication(this.store, this.#journal, this.#peer, this.#o);
		return this.store.openHost({ ...o, replication: r, gate: (ops) => { o.gate?.(ops); r.admit(ops); } });
	}
}

const POISONED = "poisoned by a sealed candidate: restart and resolve sealed history before more work";

function primaryReplication(store: OwnSyncStore, journal: PrimarySyncJournal, peer: PrimarySyncPeer | null, o: PrimaryOptions): LedgerReplication & { admit(ops: readonly WriteOp[]): void } {
	const spaceId = journal.config.spaceId;
	let poisoned = false, sealed: PrimaryIntent | null = null, pending = 0;
	// an entry carries its rows, the marker and its frame; a commit must fit one entry with room for that
	const maxBatchBytes = journal.maxIntentBytes - 16 * 1024;
	return {
		maxBatchBytes,
		/** Per commit, before it is published: it must fit one journal entry, and the history must hold it. */
		admit(ops) {
			const bytes = Buffer.byteLength(JSON.stringify(ops));
			if (bytes > maxBatchBytes) throw markSyncBudgetExceeded(new SyncJournalFull(`the commit's rows (${bytes} bytes) do not fit one sync journal entry (at most ${journal.maxIntentBytes} bytes)`));
			if (journal.historyBytes + pending + bytes * 2 > journal.maxHistoryBytes) throw markSyncBudgetExceeded(new SyncJournalFull("sync history is full; no committed result was discarded"));
			pending += bytes * 2; // an entry encodes its rows once more (canonical JSON of the JSON strings)
		},
		async seal(rows) {
			pending = Math.max(0, pending - Buffer.byteLength(JSON.stringify(rows)) * 2); // admitted, now in this batch
			if (poisoned || journal.head().revision !== journal.appliedRevision) throw new PrimarySyncBlocked(POISONED);
			await o.assertPrimary();
			const head = journal.head(), m = await store.marker(spaceId);
			// the file's marker is the journal's head: nothing was written past the journal, nothing is missing
			if (head.revision === 0 ? m !== null : !m || m.value.revision !== head.revision || m.value.configHash !== journal.configHash || m.value.batchHash !== journal.intent(head.revision)?.batchHash)
				throw new PrimarySyncBlocked("replication data marker differs from local history");
			const sync = durabilityOf(journal.config) === "sync";
			if (sync && !peer) throw new PrimarySyncBlocked("sync writes need a confirming standby");
			const value: SyncMarker = { configHash: journal.configHash, revision: head.revision + 1, batchHash: digestJson(rows), previousHash: head.hash };
			const mark = OWN_CODEC.markerWrite(spaceId, value, m?.ref ?? null, null);
			const now = (o.now ?? Date.now)();
			await o.assertPrimary();
			const s = journal.seal([...rows, mark], now);
			sealed = s;
			if (sync) {
				const ack = await peer!.accept(canonicalCopy(s));
				if (canonical(ack) !== canonical({ revision: s.revision, hash: s.hash, configHash: journal.configHash })) throw new PrimarySyncBlocked("standby ACK does not match sealed intent");
			}
			await o.assertPrimary();
			return [...rows, mark];
		},
		applied() { if (!sealed) throw new PrimarySyncBlocked("no sealed batch to apply"); journal.markApplied(sealed); sealed = null; },
		failed(cause) {
			const e = cause instanceof Error ? cause : new Error(String(cause));
			if (!sealed) return { now: e };
			// sealed and not confirmed or not written: its commits are CommitSealed, everything after waits for recovery
			const s = sealed;
			sealed = null;
			poisoned = true;
			try { o.onPoisoned?.({ revision: s.revision, hash: s.hash }); } catch { /* a listener does not change the outcome */ }
			return { now: e instanceof CommitSealed ? e : new CommitSealed(s, e), later: new PrimarySyncBlocked(POISONED) };
		},
	};
}
