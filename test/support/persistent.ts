// Persistent harnesses for crash/reopen tests (AP 0.1, docs/implementierungsplan-v3.md). MemoryStorage proves
// nothing about durability; every recovery acceptance case runs on JSONL and SQLite through these helpers.
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { createRegistry, Harness, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { OwnSyncStore, ReplicatedOwnStore } from "../../src/store/sync-sqlite.ts";
import type { StoreFaults } from "../../src/store/sqlite.ts";
import { OwnStoreHost } from "../../src/store/host.ts";

/** pi-durable's JSONL and SQLite storage, and phi-spaces' own SQLite store (docs/umstellung-ohne-pi-durable.md).
 *  PI_DURABLE_BACKENDS: for tests of pi-durable itself (its agent tools, its base checkpoints). */
export type Backend = "jsonl" | "sqlite" | "own-sqlite";
export const BACKENDS: readonly Backend[] = ["jsonl", "sqlite", "own-sqlite"];
export const PI_DURABLE_BACKENDS: readonly Backend[] = ["jsonl", "sqlite"];

/**
 * What the next matching storage commit does:
 * - `failBeforeCommit`: nothing is written and the commit throws (a crash before the commit point).
 * - `loseAnswer`: the writes are durable, but the caller sees an error (a crash after the commit, before the reply).
 */
export type Fault = "failBeforeCommit" | "loseAnswer";
export class InjectedFault extends Error {}

/** The own store's rows as the tests' fault predicates read pi-durable writes: a written document or record is a
 *  `document.change` whose content holds its new value (as `ops` and `value`), a deleted one a `document.retire`. */
function asWrites(ops: readonly import("../../src/store/sqlite-ops.ts").WriteOp[]): StorageWrite[] {
	return ops.map((op) => {
		if (op.t === "doc" || op.t === "part") {
			const value = JSON.parse(op.value), content = { kind: "delta", version: op.t === "doc" ? op.version : 1, ops: value };
			Object.defineProperty(content, "value", { value, enumerable: false }); // once in a stringified write, as on the disk
			return { type: "document.change", id: `${op.kind}/${op.key}${op.t === "part" ? `/${op.part}/${op.id}` : ""}`, content };
		}
		if (op.t === "meta") return { type: "meta", key: op.key };
		return { type: "document.retire", id: `${op.kind}/${op.key}${op.t === "partDel" ? `/${op.part}/${op.id}` : ""}` };
	}) as unknown as StorageWrite[];
}

/** Arms faults on a storage. `when` picks the commit (default: the next one); each armed fault fires once. */
export class FaultSwitch {
	#armed: { fault: Fault; when: (writes: readonly StorageWrite[]) => boolean } | undefined;
	fired = 0;
	arm(fault: Fault, when: (writes: readonly StorageWrite[]) => boolean = () => true): void { this.#armed = { fault, when }; }
	/** The same switch for the own store (its batches' rows go to `when`). */
	readonly own: StoreFaults = {
		take: (ops) => {
			const a = this.#armed;
			if (!a || !a.when(asWrites(ops))) return undefined;
			this.#armed = undefined;
			this.fired++;
			return { fault: a.fault, error: new InjectedFault(a.fault === "failBeforeCommit" ? "injected: crash before commit" : "injected: commit durable, answer lost") };
		},
	};
	disarm(): void { this.#armed = undefined; }
	/** A storage whose `commit` obeys this switch; every other method is the original. */
	wrap(storage: Storage): Storage {
		return new Proxy(storage, {
			get: (target, prop, receiver) => {
				if (prop !== "commit") {
					const v = Reflect.get(target, prop, receiver);
					return typeof v === "function" ? v.bind(target) : v;
				}
				return async (writes: readonly StorageWrite[], context: typeof ctx) => {
					const a = this.#armed;
					if (!a || !a.when(writes)) return target.commit(writes, context);
					this.#armed = undefined;
					this.fired++;
					if (a.fault === "failBeforeCommit") throw new InjectedFault("injected: crash before commit");
					await target.commit(writes, context);
					throw new InjectedFault("injected: commit durable, answer lost");
				};
			},
		});
	}
}

/**
 * A storage location that outlives harness instances. `open()` gives a new harness on the same files; `crash(h)`
 * abandons one without an orderly close (what a killed process leaves behind), `close(h)` shuts it down cleanly.
 */
export class PersistentHome {
	readonly backend: Backend;
	readonly dir: string;
	readonly faults = new FaultSwitch();
	#open = new Set<Harness>();
	#raw: OwnSyncStore[] = [];
	constructor(backend: Backend) {
		this.backend = backend;
		this.dir = mkdtempSync(join(tmpdir(), `phi-spaces-${backend}-`));
	}
	/** The raw store. For own-sqlite an OwnSyncStore (typed as pi-durable's Storage for the tests that pass it on to
	 *  the replication functions, which take either). */
	async storage(): Promise<Storage> {
		if (this.backend === "own-sqlite") {
			// a raw store left open (its recovery threw before a host took it) is gone as its process would be: its owner
			// lock must not keep the next one out (pi-durable's storage has no owner lock)
			for (const r of this.#raw) if (r.open) await r.close();
			// so is a host of this home whose store failed and that a test left open: it takes no more work anyway
			for (const h of [...this.#open]) if ((h as unknown) instanceof OwnStoreHost && (h as unknown as OwnStoreHost).failed) { (h as unknown as OwnStoreHost).abandon(); this.#open.delete(h); }
			const r = new OwnSyncStore(join(this.dir, "store.sqlite"), { faults: this.faults.own });
			this.#raw = [r];
			return r as unknown as Storage;
		}
		const s = this.backend === "jsonl" ? await openNodeJsonlStorage(this.dir, ctx) : await openNodeSqliteStorage(join(this.dir, "harness.sqlite"));
		return this.faults.wrap(s);
	}
	/** `o`: models and registry for agent tests (a faux provider, installed extensions); defaults are empty. */
	async open(o: { models?: ReturnType<typeof createModels>; registry?: ReturnType<typeof createRegistry> } = {}): Promise<Harness> {
		const s = await this.storage() as unknown;
		// the own store's host is a StoreHost, not a Harness: typed as one for the tests, which use what both have
		if (s instanceof OwnSyncStore || s instanceof ReplicatedOwnStore) {
			if (o.models || o.registry) throw new Error("agent tests need pi-durable's Harness, not the own store");
			const h = (await (s instanceof ReplicatedOwnStore ? s.open() : s.openHost())) as unknown as Harness;
			this.#open.add(h);
			return h;
		}
		const h = await Harness.open(s as Storage, { models: o.models ?? createModels(), registry: o.registry ?? createRegistry() }, ctx);
		this.#open.add(h);
		return h;
	}
	async close(h: Harness): Promise<void> {
		this.#open.delete(h);
		await h.close(ctx);
	}
	/** Abandon `h` as a crash would: no close, no flush beyond what was committed. The caller must not use it again. */
	crash(h: Harness): void {
		this.#open.delete(h);
		// a killed process leaves its store unlocked; pi-durable's storage has no owner lock to free
		if ((h as unknown) instanceof OwnStoreHost) (h as unknown as OwnStoreHost).abandon(); else this.abandoned.push(h);
	}
	readonly abandoned: Harness[] = [];
	/** Close what is still open (abandoned harnesses too, best effort, so file handles are released) and delete. */
	async dispose(): Promise<void> {
		for (const h of [...this.#open, ...this.abandoned]) await h.close(ctx).catch(() => {});
		for (const r of this.#raw) if (r.open) await r.close();
		this.#open.clear();
		this.abandoned.length = 0;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** The host over a raw store or a primary's store as tests get them (home.storage(), primarySyncStorage): pi-durable's
 *  Harness, or the own store's host (typed as a Harness for the tests). */
export async function openHost(storage: Storage): Promise<Harness> {
	const s = storage as unknown;
	if (s instanceof ReplicatedOwnStore) return (await s.open()) as unknown as Harness;
	if (s instanceof OwnSyncStore) return (await s.openHost()) as unknown as Harness;
	return Harness.open(storage, { models: createModels(), registry: createRegistry() }, ctx);
}

/** Run `f` once per persistent backend with a fresh home, disposing it afterwards. */
export async function forEachBackend(f: (home: PersistentHome) => Promise<void>, backends: readonly Backend[] = BACKENDS): Promise<void> {
	for (const b of backends) {
		const home = new PersistentHome(b);
		try { await f(home); }
		catch (e) { throw new Error(`[${b}] ${(e as Error).message}`, { cause: e }); }
		finally { await home.dispose(); }
	}
}

export { ctx };

/**
 * A currently-free TCP port (bound on 0.0.0.0, then released). Test fixtures use this instead of
 * hardcoded ports – parallel test files can no longer collide on e.g. 127.0.0.2/127.0.0.3:17561.
 */
export async function freePort(): Promise<number> {
	return await new Promise((resolve, reject) => {
		const srv = createServer();
		srv.once("error", reject);
		srv.listen(0, "0.0.0.0", () => {
			const port = (srv.address() as { port: number }).port;
			srv.close(() => resolve(port));
		});
	});
}
