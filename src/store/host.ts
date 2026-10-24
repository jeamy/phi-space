// phi-spaces' own store host (docs/umstellung-ohne-pi-durable.md, U2): commits run one after the other on drafts of
// the documents they touch (store/draft.ts), are published together or not at all, and wake the watches of what
// changed. Where committed values are kept is the host's `Ledger`: nowhere (memory) or a SQLite file (store/sqlite.ts).
//
// Contract (plan 4.1/4.2): a callback sees its own drafts and the committed state; a failure discards every draft of
// the commit; a draft is revoked when its commit ends, so a late write throws; a commit's result is detached from its
// drafts; snapshots are committed values; watches are woken only after a commit is published, never inline, and
// coalesce what happened while their listener ran.
import { AsyncLocalStorage } from "node:async_hooks";
import { awaitWithContext, type Context } from "../context.ts";
import { detach, draftOf, isDraft, type Draft, type PartChanges } from "./draft.ts";
import { diskMapOf } from "./types.ts";
import type { ClosableStoreHost, DocDef, DocFamilyDef, DocWatch, StoreTx, WatchEnd } from "./types.ts";

type AnyDef = DocDef<any> | DocFamilyDef<any, any>;
/** A committed document: its value and the schema version it was stored with. */
export type StoredDoc = { kind: string; key: string | null; version: number; value: unknown };
/** A document a commit changed. For one with parts: the parts, its value before, and the keys its map parts changed
 *  (store/parts.ts finds the rows from these). */
export type PutDoc = StoredDoc & { parts?: DocDef<unknown>["parts"]; before?: unknown; changes?: PartChanges };
/** One commit's effect on the documents: the new or changed ones, and the retired ones. */
export type CommitSet = { put: PutDoc[]; retired: Array<{ kind: string; key: string | null }> };

/** Where committed documents live. `load` reads one (null: none); `persist` stores a commit's effect durably and settles
 *  when it is (in the order commits were handed over). */
export interface Ledger {
	load(kind: string, key: string | null, parts?: DocDef<unknown>["parts"]): StoredDoc | null;
	/** Before a commit is published: may refuse it (throw), and nothing of it happened then (the host puts back what the
	 *  commit changed in place). What it returns goes to persist. */
	prepare?(set: CommitSet): unknown;
	persist(set: CommitSet, prepared?: unknown): void | Promise<void>;
	close(): void | Promise<void>;
	/** Tests: gives the store up as a killed process would. */
	abandon?(): void;
	/** The ledger can load again what it has stored, so the host may drop a document from memory: it is told to drop what
	 *  it kept for it too (order maps, disk map handles). A ledger without this keeps the only copy in the host. */
	forget?(kind: string, key: string | null): void;
	/** Why the ledger takes no more work, when that differs from the error of the commit that failed (a primary whose
	 *  sealed candidate failed refuses everything after it until it is reopened and resolved). */
	readonly failure?: Error | null;
	/** How writing goes (plan 5.2: queue, sync latency): batches written, commits in them, time spent writing. */
	stats?(): StoreStats;
}
export type StoreStats = { batches: number; commits: number; rows: number; writeMs: number; maxBatch: number; queued: number };

/** Set while a commit callback runs: a snapshot from inside a commit must not wait for that commit. */
const inCommit = new AsyncLocalStorage<true>();

/** The message a closed host refuses work with (callers recognise it, as they did pi-durable's). */
export const HOST_CLOSED = "Session is closed";

const addr = (kind: string, key: string | null) => (key === null ? kind : `${kind}\u0000${key}`);

class Watch<T> implements DocWatch<T> {
	value: Readonly<T> | null;
	readonly closed: Promise<WatchEnd>;
	#listener: ((value: Readonly<T> | null, ops: readonly unknown[], context: Context) => void | Promise<void>) | null = null;
	#pending = false;
	#running = false;
	#end: WatchEnd | null = null;
	#resolve!: (e: WatchEnd) => void;
	readonly #ctx: Context;
	readonly #drop: (w: Watch<T>) => void;
	constructor(value: Readonly<T> | null, ctx: Context, drop: (w: Watch<T>) => void) {
		this.value = value;
		this.#ctx = ctx;
		this.#drop = drop;
		this.closed = new Promise((r) => { this.#resolve = r; });
		ctx.abortSignal?.addEventListener("abort", () => this.finish({ reason: "cancelled" }), { once: true });
	}
	start(listener: (value: Readonly<T> | null, ops: readonly unknown[], context: Context) => void | Promise<void>): void {
		if (this.#listener) throw new Error("a watch has one listener");
		this.#listener = listener;
		if (this.#pending) this.#schedule();
	}
	/** A new committed value: delivered after the current delivery, merged with any other that comes meanwhile. */
	offer(value: Readonly<T> | null): void {
		if (this.#end) return;
		this.value = value;
		this.#pending = true;
		if (this.#listener && !this.#running) this.#schedule();
	}
	#schedule(): void {
		this.#running = true;
		setImmediate(async () => {
			while (this.#pending && !this.#end && this.#listener) {
				this.#pending = false;
				try { await this.#listener(this.value, [], this.#ctx); }
				catch (error) { this.finish({ reason: "listener_error", error: error instanceof Error ? error : new Error(String(error)) }); }
			}
			this.#running = false;
		});
	}
	finish(end: WatchEnd): void {
		if (this.#end) return;
		this.#end = end;
		this.#drop(this);
		this.#resolve(end);
	}
	async stop(): Promise<WatchEnd> { this.finish({ reason: "stopped" }); return this.closed; }
}

/** The own store host over a ledger. */
export class OwnStoreHost implements ClosableStoreHost {
	readonly #ledger: Ledger;
	readonly #docs = new Map<string, StoredDoc | null>(); // committed values read so far (null: known absent)
	readonly #watches = new Map<string, Set<Watch<any>>>();
	#tail: Promise<unknown> = Promise.resolve();
	#closed = false;
	/** Settles when everything handed to the ledger so far is durable. */
	#durable: Promise<void> = Promise.resolve();
	/** A write failed: the host takes no more work (plan 4.1: its memory may hold what never reached the disk). */
	#failure: Error | null = null;

	/** Memory budget: the records of the parts of the documents held (a document's weight is 1 plus its records). */
	readonly #budget: number;
	readonly #weights = new Map<string, number>();
	#weight = 0;
	/** Commits handed to the ledger and not yet durable, per document: those are not dropped. */
	readonly #unsettled = new Map<string, number>();
	#running = false;

	constructor(ledger: Ledger, o: { memoryBudget?: number } = {}) { this.#ledger = ledger; this.#budget = ledger.forget ? (o.memoryBudget ?? Infinity) : Infinity; }

	#weigh(a: string, doc: StoredDoc | null, parts?: AnyDef["parts"]): void {
		this.#weight -= this.#weights.get(a) ?? 0;
		let w = doc ? 1 : 0;
		for (const p of doc ? parts ?? [] : []) {
			const v = p.path.reduce<unknown>((x, k) => (x !== null && typeof x === "object" ? (x as Record<string, unknown>)[k] : undefined), doc!.value);
			if (Array.isArray(v)) w += v.length;
			else if (v !== null && typeof v === "object" && !diskMapOf(v)) w += Object.keys(v).length;
		}
		this.#weights.set(a, w);
		this.#weight += w;
	}
	/** Drops the documents untouched for longest while the budget is exceeded — never one that is watched, was changed
	 *  by a commit not yet durable, or is in use by the commit running. Between commits only. */
	#trim(): void {
		if (this.#weight <= this.#budget || this.#running) return;
		for (const a of [...this.#docs.keys()]) {
			if (this.#weight <= this.#budget) break;
			if (this.#watches.get(a)?.size || this.#unsettled.has(a)) continue;
			const d = this.#docs.get(a);
			this.#docs.delete(a);
			this.#weigh(a, null);
			this.#weights.delete(a);
			if (d) this.#ledger.forget!(d.kind, d.key);
		}
	}

	#usable(): void {
		if (this.#closed) throw new Error(HOST_CLOSED);
		if (this.#failure) throw new Error(`the store failed and must be reopened: ${this.#failure.message}`);
	}
	#committed(kind: string, key: string | null, parts?: AnyDef["parts"]): StoredDoc | null {
		const a = addr(kind, key);
		if (!this.#docs.has(a)) { const d = this.#ledger.load(kind, key, parts); this.#docs.set(a, d); this.#weigh(a, d, parts); }
		else if (this.#budget !== Infinity) { const d = this.#docs.get(a)!; this.#docs.delete(a); this.#docs.set(a, d); } // most recently used last
		return this.#docs.get(a)!;
	}
	/** The committed value of a definition, brought up to its version (a migration is not stored until a commit). */
	#current(def: AnyDef, key: string | null): unknown | undefined {
		const d = this.#committed(def.kind, key, def.parts);
		if (!d) return undefined;
		return d.version < def.version && def.migrate ? def.migrate(d.value as never, d.version) : d.value;
	}

	/** Commits run one after the other; the next one may start while the previous one is still being written (its
	 *  callback sees that state). A commit is acknowledged, and its watches woken, once it is durable. */
	commit<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<T> {
		try { this.#usable(); } catch (e) { return Promise.reject(e); }
		const phase = this.#tail.catch(() => {}).then(() => this.#run(change, context));
		this.#tail = phase;
		return awaitWithContext(phase.then(async (r) => { await r.durable; return r.out; }), context);
	}

	async #run<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<{ out: T; durable: Promise<void> }> {
		this.#usable();
		this.#trim();
		this.#running = true;
		try { return await this.#runChange(change, context); } finally { this.#running = false; }
	}

	async #runChange<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<{ out: T; durable: Promise<void> }> {
		context.abortSignal?.throwIfAborted();
		const drafts = new Map<string, { def: AnyDef; key: string | null; draft: Draft<unknown> }>();
		const retired = new Map<string, { kind: string; key: string | null }>();
		let open = true;
		const tx: StoreTx = {
			doc: (async (def: AnyDef, key?: string, seed?: unknown) => {
				if (!open) throw new TypeError("this commit is over");
				const k = def.family ? key! : null, a = addr(def.kind, k);
				const known = drafts.get(a);
				if (known) return known.draft.value;
				retired.delete(a);
				const cur = this.#current(def, k);
				const base = cur !== undefined ? cur : def.family ? (def as DocFamilyDef<any, any>).initial(seed) : (def as DocDef<any>).initial();
				const draft = draftOf(base, def.parts);
				drafts.set(a, { def, key: k, draft });
				return draft.value;
			}) as StoreTx["doc"],
			retireDoc: (async (def: AnyDef, key?: string) => {
				if (!open) throw new TypeError("this commit is over");
				const k = def.family ? key! : null, a = addr(def.kind, k);
				drafts.get(a)?.draft.discard();
				drafts.delete(a);
				retired.set(a, { kind: def.kind, key: k });
			}) as StoreTx["retireDoc"],
		};
		let result: T;
		try { result = await inCommit.run(true, () => change(tx)); }
		catch (e) { open = false; for (const d of drafts.values()) d.draft.discard(); throw e; }
		open = false;
		// the result leaves the commit detached from its drafts (a draft is revoked below)
		const out = holdsDraft(result) ? detach(result) : result;
		const set: CommitSet = { put: [], retired: [] };
		const changed: Array<[string, unknown]> = [];
		const records: unknown[] = [];
		// every draft is finished before any is revoked: a value of one document may have been put into another
		const finished = new Map<string, unknown>();
		for (const [a, { draft }] of drafts) finished.set(a, draft.finish());
		const revoke = () => { for (const d of drafts.values()) d.draft.revoke(); };
		for (const [a, { def, key, draft }] of drafts) {
			const before = this.#docs.get(a)?.value, value = finished.get(a);
			const fresh = this.#docs.get(a) == null, migrated = (this.#docs.get(a)?.version ?? def.version) !== def.version;
			if (value === before && !fresh && !migrated && draft.changes.size === 0) continue; // only read
			records.push(...draft.fresh);
			set.put.push({ kind: def.kind, key, version: def.version, value, ...(def.parts?.length ? { parts: def.parts, before, changes: draft.changes } : {}) });
			changed.push([a, value]);
		}
		for (const [a, r] of retired) if (this.#committed(r.kind, r.key)) { set.retired.push(r); changed.push([a, null]); }
		// a commit that only read may still depend on earlier commits that are not yet durable: it waits for them too
		if (!set.put.length && !set.retired.length) { revoke(); return { out, durable: this.#durable }; }
		// the store may refuse the commit before anything of it is published (a replicated store whose journal is full):
		// what the commit changed in place goes back, and the host goes on
		let prepared: unknown;
		try { prepared = this.#ledger.prepare?.(set); }
		catch (e) { for (const d of drafts.values()) d.draft.rollback(); revoke(); throw e; }
		revoke();
		// a record of a part is a value from now on: whoever still changes one in place gets an error, not a silent change
		for (const r of records) deepFreeze(r);
		// the next commit builds on this one at once; readers and watches see it once it is durable
		const touched: string[] = [];
		for (const d of set.put) { const a = addr(d.kind, d.key), doc = { kind: d.kind, key: d.key, version: d.version, value: d.value }; this.#docs.delete(a); this.#docs.set(a, doc); this.#weigh(a, doc, d.parts ?? drafts.get(a)?.def.parts); touched.push(a); }
		for (const r of set.retired) { const a = addr(r.kind, r.key); this.#docs.set(a, null); this.#weigh(a, null); touched.push(a); }
		for (const a of touched) this.#unsettled.set(a, (this.#unsettled.get(a) ?? 0) + 1);
		const settled = () => { for (const a of touched) { const n = this.#unsettled.get(a)! - 1; if (n > 0) this.#unsettled.set(a, n); else this.#unsettled.delete(a); } };
		const durable = Promise.resolve(this.#ledger.persist(set, prepared)).then(
			() => { settled(); for (const [a, value] of changed) for (const w of this.#watches.get(a) ?? []) value === null ? w.finish({ reason: "retired" }) : w.offer(value as never); },
			(e: unknown) => { settled(); this.#failure ??= this.#ledger.failure ?? (e instanceof Error ? e : new Error(String(e))); throw e; },
		);
		this.#durable = durable.catch(() => {});
		return { out, durable };
	}

	snapshot<T>(def: DocDef<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
	async snapshot(def: AnyDef, keyOrContext: string | Context): Promise<any> {
		this.#usable();
		// a map part changes in place while a commit runs, and what a commit wrote is not durable at once: a snapshot from
		// outside waits for the commits in progress and their writing
		if (!inCommit.getStore()) { await this.#tail.catch(() => {}); await this.#durable; this.#usable(); }
		const key = def.family ? (keyOrContext as string) : null;
		const value = this.#current(def, key);
		this.#trim();
		return value;
	}

	watchDoc<T>(def: DocDef<T>, context: Context): Promise<DocWatch<T> | undefined>;
	watchDoc<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<DocWatch<T> | undefined>;
	async watchDoc(def: AnyDef, keyOrContext: string | Context, context?: Context): Promise<any> {
		this.#usable();
		const key = def.family ? (keyOrContext as string) : null, ctx = (def.family ? context : keyOrContext) as Context;
		if (!inCommit.getStore()) { await this.#tail.catch(() => {}); await this.#durable; this.#usable(); }
		const value = this.#current(def, key);
		if (value === undefined) return undefined; // a watch does not create its document
		const a = addr(def.kind, key);
		const w = new Watch<any>(value, ctx, (x) => this.#watches.get(a)?.delete(x));
		if (!this.#watches.has(a)) this.#watches.set(a, new Set());
		this.#watches.get(a)!.add(w);
		this.#trim();
		return w;
	}

	/** What the host holds in memory: documents (known absent ones too) and their weight against the budget. */
	get cached(): { documents: number; weight: number } { return { documents: this.#docs.size, weight: this.#weight }; }

	/** Whether a write failed: the host takes no more work until its store is reopened. */
	get failed(): boolean { return this.#failure !== null; }

	/** Tests: drops the host as a killed process would (no close, no flush; the store's owner lock is free again). */
	abandon(): void {
		this.#closed = true;
		for (const set of this.#watches.values()) for (const w of [...set]) w.finish({ reason: "session_closed" });
		this.#watches.clear();
		this.#ledger.abandon?.();
	}

	/** How the ledger writes (absent for one that keeps nothing). */
	stats(): StoreStats | undefined { return this.#ledger.stats?.(); }

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail.catch(() => {});
		await this.#durable;
		for (const set of this.#watches.values()) for (const w of [...set]) w.finish({ reason: "session_closed" });
		this.#watches.clear();
		await this.#ledger.close();
	}
}

function deepFreeze(v: unknown): void {
	if (typeof v !== "object" || v === null || Object.isFrozen(v)) return;
	Object.freeze(v);
	for (const x of Object.values(v)) deepFreeze(x);
}

/** Whether a value holds a draft somewhere (results are usually plain data made in the commit). */
function holdsDraft(v: unknown, depth = 0): boolean {
	if (typeof v !== "object" || v === null || depth > 64) return false;
	if (isDraft(v)) return true;
	if (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) return false;
	for (const x of Object.values(v)) if (holdsDraft(x, depth + 1)) return true;
	return false;
}

/** A ledger that keeps nothing: the host's own map is all there is (tests, throwaway spaces). */
export const memoryLedger = (): Ledger => ({ load: () => null, persist: () => {}, close: () => {} });

/** A throwaway own host in memory. */
export function openOwnMemoryHost(): OwnStoreHost { return new OwnStoreHost(memoryLedger()); }
