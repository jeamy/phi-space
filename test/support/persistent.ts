// Persistent harnesses for crash/reopen tests (AP 0.1, docs/implementierungsplan-v3.md). MemoryStorage proves
// nothing about durability; every recovery acceptance case runs on JSONL and SQLite through these helpers.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createRegistry, Harness, type Storage, type StorageWrite } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";

export type Backend = "jsonl" | "sqlite";
export const BACKENDS: readonly Backend[] = ["jsonl", "sqlite"];

/**
 * What the next matching storage commit does:
 * - `failBeforeCommit`: nothing is written and the commit throws (a crash before the commit point).
 * - `loseAnswer`: the writes are durable, but the caller sees an error (a crash after the commit, before the reply).
 */
export type Fault = "failBeforeCommit" | "loseAnswer";
export class InjectedFault extends Error {}

/** Arms faults on a storage. `when` picks the commit (default: the next one); each armed fault fires once. */
export class FaultSwitch {
	#armed: { fault: Fault; when: (writes: readonly StorageWrite[]) => boolean } | undefined;
	fired = 0;
	arm(fault: Fault, when: (writes: readonly StorageWrite[]) => boolean = () => true): void { this.#armed = { fault, when }; }
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
	constructor(backend: Backend) {
		this.backend = backend;
		this.dir = mkdtempSync(join(tmpdir(), `pi-spaces-${backend}-`));
	}
	async storage(): Promise<Storage> {
		const s = this.backend === "jsonl" ? await openNodeJsonlStorage(this.dir, ctx) : await openNodeSqliteStorage(join(this.dir, "harness.sqlite"));
		return this.faults.wrap(s);
	}
	/** `o`: models and registry for agent tests (a faux provider, installed extensions); defaults are empty. */
	async open(o: { models?: ReturnType<typeof createModels>; registry?: ReturnType<typeof createRegistry> } = {}): Promise<Harness> {
		const h = await Harness.open(await this.storage(), { models: o.models ?? createModels(), registry: o.registry ?? createRegistry() }, ctx);
		this.#open.add(h);
		return h;
	}
	async close(h: Harness): Promise<void> {
		this.#open.delete(h);
		await h.close(ctx);
	}
	/** Abandon `h` as a crash would: no close, no flush beyond what was committed. The caller must not use it again. */
	crash(h: Harness): void { this.#open.delete(h); this.abandoned.push(h); }
	readonly abandoned: Harness[] = [];
	/** Close what is still open (abandoned harnesses too, best effort, so file handles are released) and delete. */
	async dispose(): Promise<void> {
		for (const h of [...this.#open, ...this.abandoned]) await h.close(ctx).catch(() => {});
		this.#open.clear();
		this.abandoned.length = 0;
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** Run `f` once per persistent backend with a fresh home, disposing it afterwards. */
export async function forEachBackend(f: (home: PersistentHome) => Promise<void>): Promise<void> {
	for (const b of BACKENDS) {
		const home = new PersistentHome(b);
		try { await f(home); }
		catch (e) { throw new Error(`[${b}] ${(e as Error).message}`, { cause: e }); }
		finally { await home.dispose(); }
	}
}

export { ctx };
