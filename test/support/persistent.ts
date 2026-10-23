// Persistent stores for crash/reopen tests (AP 0.1, docs/implementierungsplan-v3.md): phi-spaces' own SQLite store
// (store/sqlite.ts) in a directory that outlives its hosts. A store in memory proves nothing about durability; every
// recovery acceptance case runs through these helpers. pi-durable's storage is gone (decision D6,
// docs/umstellung-u0-bestand.md).
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { OwnSyncStore, ReplicatedOwnStore } from "../../src/store/sync-sqlite.ts";
import type { StoreFaults } from "../../src/store/sqlite.ts";
import type { WriteOp } from "../../src/store/sqlite-ops.ts";
import { OwnStoreHost } from "../../src/store/host.ts";

/** The persistent store kind the suites run on (one now; the name stays in the test titles). */
export type Backend = "own-sqlite";
export const BACKENDS: readonly Backend[] = ["own-sqlite"];

/**
 * What the next matching batch write does:
 * - `failBeforeCommit`: nothing is written and the write throws (a crash before the commit point).
 * - `loseAnswer`: the rows are durable, but the caller sees an error (a crash after the commit, before the reply).
 */
export type Fault = "failBeforeCommit" | "loseAnswer";
export class InjectedFault extends Error {}

/** What a batch changed, as fault predicates ask it: per document (`kind`, `key`) its head's top-level fields that
 *  changed since the head this switch saw last (all of them for a new document), per part record (`part`, `id`) the
 *  record; `deleted` for a removed document or record. `text` is the JSON of `fields`, for `includes` tests. */
export type Change = { kind: string; key: string; part?: string; id?: string; deleted?: true; fields: Record<string, unknown>; text: string };
export type FaultBatch = { ops: readonly WriteOp[]; changes: readonly Change[] };

function changesOf(ops: readonly WriteOp[], heads: Map<string, Record<string, unknown>>): Change[] {
	const out: Change[] = [];
	for (const op of ops) {
		if (op.t === "doc") {
			const id = `${op.kind}\u0000${op.key}`, value = JSON.parse(op.value) as Record<string, unknown>, prev = heads.get(id);
			heads.set(id, value);
			const fields: Record<string, unknown> = {};
			for (const k of new Set([...Object.keys(value), ...Object.keys(prev ?? {})])) if (!prev || JSON.stringify(prev[k]) !== JSON.stringify(value[k])) fields[k] = value[k] ?? null;
			out.push({ kind: op.kind, key: op.key, fields, text: JSON.stringify(fields) });
		} else if (op.t === "part") {
			const fields = JSON.parse(op.value) as Record<string, unknown>;
			out.push({ kind: op.kind, key: op.key, part: op.part, id: op.id, fields, text: op.value });
		} else if (op.t === "partDel") out.push({ kind: op.kind, key: op.key, part: op.part, id: op.id, deleted: true, fields: {}, text: "{}" });
		else if (op.t === "retire") out.push({ kind: op.kind, key: op.key, deleted: true, fields: {}, text: "{}" });
	}
	return out;
}

/** FAULT_LOG=1: what the batch a fault fires at changed (documents and their changed fields). */
const logFired = (changes: readonly Change[]) => {
	if (process.env.FAULT_LOG !== "1") return;
	const what = changes.filter((c) => !c.deleted).map((c) => `${c.kind}${c.part ? `.${c.part}` : ""}:${Object.keys(c.fields).slice(0, 8).join("|")}`);
	console.error(`FAULT fired at: ${[...new Set(what)].join(" ; ")}`);
};

/** Arms faults on a store. `when` picks the batch (default: the next one); each armed fault fires once. */
export class FaultSwitch {
	#armed: { fault: Fault; when: (batch: FaultBatch) => boolean } | undefined;
	#heads = new Map<string, Record<string, unknown>>();
	fired = 0;
	arm(fault: Fault, when: (batch: FaultBatch) => boolean = () => true): void { this.#armed = { fault, when }; }
	#observer: ((ops: readonly WriteOp[]) => void) | undefined;
	/** Sees every commit's rows as the host hands it over (a batch may hold several commits); null stops it. */
	observe(f: ((ops: readonly WriteOp[]) => void) | null): void { this.#observer = f ?? undefined; }
	disarm(): void { this.#armed = undefined; }
	/** The switch as the store asks it, for every batch (so the heads stay current). */
	readonly store: StoreFaults = {
		take: (ops) => {
			const a = this.#armed, changes = changesOf(ops, this.#heads);
			if (!a || !a.when({ ops, changes })) return undefined;
			logFired(changes);
			this.#armed = undefined;
			this.fired++;
			return { fault: a.fault, error: new InjectedFault(a.fault === "failBeforeCommit" ? "injected: crash before commit" : "injected: commit durable, answer lost") };
		},
		observe: (ops) => this.#observer?.(ops),
	};
}

/**
 * A store location that outlives its hosts. `open()` gives a new host on the same files; `crash(h)` drops one as a
 * killed process would (no close, no flush, the owner lock free), `close(h)` shuts it down cleanly.
 */
export class PersistentHome {
	readonly backend: Backend;
	readonly dir: string;
	readonly faults = new FaultSwitch();
	#open = new Set<OwnStoreHost>();
	#raw: OwnSyncStore[] = [];
	constructor(backend: Backend = "own-sqlite") {
		this.backend = backend;
		this.dir = mkdtempSync(join(tmpdir(), `phi-spaces-${backend}-`));
	}
	/** The store without a host (a stopped daemon): the replication applies, recovers and checks it there. */
	async storage(): Promise<OwnSyncStore | ReplicatedOwnStore> {
		// a raw store left open (its recovery threw before a host took it) is gone as its process would be: its owner lock
		// must not keep the next one out; so is a host whose store failed and that a test left open
		for (const r of this.#raw) if (r.open) await r.close();
		for (const h of [...this.#open]) if (h.failed) { h.abandon(); this.#open.delete(h); }
		const r = new OwnSyncStore(join(this.dir, "store.sqlite"), { faults: this.faults.store });
		this.#raw = [r];
		return r;
	}
	async open(): Promise<OwnStoreHost> {
		const h = await openHost(await this.storage());
		this.#open.add(h);
		return h;
	}
	async close(h: OwnStoreHost): Promise<void> {
		this.#open.delete(h);
		await h.close(ctx);
	}
	/** Abandon `h` as a crash would. The caller must not use it again. */
	crash(h: OwnStoreHost): void {
		this.#open.delete(h);
		h.abandon();
	}
	/** Close what is still open and delete. */
	async dispose(): Promise<void> {
		for (const h of this.#open) await h.close(ctx).catch(() => {});
		for (const r of this.#raw) if (r.open) await r.close();
		this.#open.clear();
		rmSync(this.dir, { recursive: true, force: true });
	}
}

/** The host over a raw store or a primary's store as tests get them (home.storage(), primarySyncStorage). */
export async function openHost(storage: OwnSyncStore | ReplicatedOwnStore): Promise<OwnStoreHost> {
	return storage instanceof ReplicatedOwnStore ? storage.open() : storage.openHost();
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
