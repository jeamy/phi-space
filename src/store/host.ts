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
import { detach, draftOf, isDraft, type Draft } from "./draft.ts";
import type { ClosableStoreHost, DocDef, DocFamilyDef, DocWatch, StoreTx, WatchEnd } from "./types.ts";

type AnyDef = DocDef<any> | DocFamilyDef<any, any>;
/** A committed document: its value and the schema version it was stored with. */
export type StoredDoc = { kind: string; key: string | null; version: number; value: unknown };
/** One commit's effect on the documents: the new or changed ones, and the retired ones. */
export type CommitSet = { put: StoredDoc[]; retired: Array<{ kind: string; key: string | null }> };

/** Where committed documents live. `load` reads one (null: none); `persist` stores a commit's effect durably. */
export interface Ledger {
	load(kind: string, key: string | null): StoredDoc | null;
	persist(set: CommitSet): void | Promise<void>;
	close(): void | Promise<void>;
}

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

	constructor(ledger: Ledger) { this.#ledger = ledger; }

	#committed(kind: string, key: string | null): StoredDoc | null {
		const a = addr(kind, key);
		if (!this.#docs.has(a)) this.#docs.set(a, this.#ledger.load(kind, key));
		return this.#docs.get(a)!;
	}
	/** The committed value of a definition, brought up to its version (a migration is not stored until a commit). */
	#current(def: AnyDef, key: string | null): unknown | undefined {
		const d = this.#committed(def.kind, key);
		if (!d) return undefined;
		return d.version < def.version && def.migrate ? def.migrate(d.value as never, d.version) : d.value;
	}

	commit<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<T> {
		if (this.#closed) return Promise.reject(new Error(HOST_CLOSED));
		const run = this.#tail.catch(() => {}).then(() => this.#run(change, context));
		this.#tail = run;
		return awaitWithContext(run, context);
	}

	async #run<T>(change: (tx: StoreTx) => T | Promise<T>, context: Context): Promise<T> {
		if (this.#closed) throw new Error(HOST_CLOSED);
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
		for (const [a, { def, key, draft }] of drafts) {
			const before = this.#docs.get(a)?.value, value = draft.finish();
			const fresh = this.#docs.get(a) == null, migrated = (this.#docs.get(a)?.version ?? def.version) !== def.version;
			if (value === before && !fresh && !migrated && draft.changes.size === 0) continue; // only read
			records.push(...draft.fresh);
			set.put.push({ kind: def.kind, key, version: def.version, value });
			changed.push([a, value]);
		}
		for (const [a, r] of retired) if (this.#committed(r.kind, r.key)) { set.retired.push(r); changed.push([a, null]); }
		if (set.put.length || set.retired.length) {
			// a record of a part is a value from now on: whoever still changes one in place gets an error, not a silent change
			for (const r of records) deepFreeze(r);
			await this.#ledger.persist(set);
			for (const d of set.put) this.#docs.set(addr(d.kind, d.key), d);
			for (const r of set.retired) this.#docs.set(addr(r.kind, r.key), null);
			for (const [a, value] of changed) for (const w of this.#watches.get(a) ?? []) value === null ? w.finish({ reason: "retired" }) : w.offer(value as never);
		}
		return out;
	}

	snapshot<T>(def: DocDef<T>, context: Context): Promise<Readonly<T> | undefined>;
	snapshot<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<Readonly<T> | undefined>;
	async snapshot(def: AnyDef, keyOrContext: string | Context): Promise<any> {
		if (this.#closed) throw new Error(HOST_CLOSED);
		// a map part changes in place while a commit runs: a snapshot from outside waits for the commits in progress
		if (!inCommit.getStore()) await this.#tail.catch(() => {});
		const key = def.family ? (keyOrContext as string) : null;
		return this.#current(def, key);
	}

	watchDoc<T>(def: DocDef<T>, context: Context): Promise<DocWatch<T> | undefined>;
	watchDoc<T, I>(def: DocFamilyDef<T, I>, key: string, context: Context): Promise<DocWatch<T> | undefined>;
	async watchDoc(def: AnyDef, keyOrContext: string | Context, context?: Context): Promise<any> {
		if (this.#closed) throw new Error(HOST_CLOSED);
		const key = def.family ? (keyOrContext as string) : null, ctx = (def.family ? context : keyOrContext) as Context;
		const value = this.#current(def, key);
		if (value === undefined) return undefined; // a watch does not create its document
		const a = addr(def.kind, key);
		const w = new Watch<any>(value, ctx, (x) => this.#watches.get(a)?.delete(x));
		if (!this.#watches.has(a)) this.#watches.set(a, new Set());
		this.#watches.get(a)!.add(w);
		return w;
	}

	async close(_context: Context): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		await this.#tail.catch(() => {});
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
