// A JavaSpace-shaped client over the Session-scoped Space document. Host code, tasks and tools all use this.
// Everything here runs against one harness: the harness process is the "space service".
import { defineDoc, type Session, type Tx } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import type { EntryDraft, Fields, Json, Lease, SpaceState, Template } from "./core.ts";

export { NO_WAIT, ANY, FOREVER, IllegalArgumentError, TransactionError, UnknownLeaseError } from "./core.ts";
export type { EntryDraft, Fields, Json, Lease, Template } from "./core.ts";

export const Space = defineDoc<SpaceState & Record<string, any>>({
	kind: "pi-spaces.space",
	version: 3,
	scope: "session",
	initial: () => core.initialState() as SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as SpaceState & Record<string, any>,
});

/** What the client needs; both `Harness` and a tool's `api` provide it. */
export type SpaceHost = Pick<Session, "commit" | "watchDoc" | "snapshot">;
export type Once = { get(tx: Tx): Promise<Json | undefined>; set(tx: Tx, v: Json): Promise<void> };
export type Snapshot = { readonly entry: Readonly<EntryDraft> };
export type OpOptions = {
	txn?: string | null;
	/** Absolute deadline (ms). Overrides `timeout`; lets a durable caller keep the clock across a restart. */
	deadline?: number;
	/** Exactly-once hook for `take`: the taken entry is recorded in the same commit that removes it. */
	once?: Once;
};

const view = (e: core.EntryRec) => ({ id: e.id, type: e.type, fields: e.fields });
export type Taken = ReturnType<typeof view>;

export class JavaSpace {
	private host: SpaceHost;
	private ctx: Context;
	private now: () => number;
	constructor(host: SpaceHost, ctx: Context, now: () => number = Date.now) {
		this.host = host;
		this.ctx = ctx;
		this.now = now;
	}

	write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY): Promise<Lease> {
		return this.host.commit(async (tx) => core.write(await tx.doc(Space), this.now(), entry, txn, lease), this.ctx);
	}
	read(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, false); }
	readIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, true); }
	take(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, false); }
	takeIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, true); }

	notify(tmpl: Template, o: { txn?: string | null; lease?: number; handback?: Json; target?: string | null } = {}) {
		return this.host.commit(async (tx) => core.notify(await tx.doc(Space), this.now(), tmpl, o.txn ?? null, o.lease ?? core.ANY, o.handback ?? null, o.target ?? null), this.ctx);
	}
	/** Park a read/take for a conversation. The space delivers the entry (or a timeout) to it as input later. */
	wait(tmpl: Template, o: { take?: boolean; target: string; timeout: number; txnLeaseMs?: number; handback?: Json }): Promise<string> {
		return this.host.commit(async (tx) => core.addWaiter(await tx.doc(Space), this.now(), { template: tmpl, take: o.take ?? true, target: o.target, timeout: o.timeout, ...(o.txnLeaseMs === undefined ? {} : { txnLeaseMs: o.txnLeaseMs }), handback: o.handback ?? null }), this.ctx);
	}
	/** A frozen canonical copy. JavaSpaces' snapshot is a serialization cache; this keeps the contract only. */
	snapshot(entry: EntryDraft): Snapshot { return { entry: Object.freeze(structuredClone(entry)) }; }

	createTransaction(lease: number = core.ANY) { return this.host.commit(async (tx) => core.createTxn(await tx.doc(Space), this.now(), lease), this.ctx); }
	commit(txn: string) { return this.host.commit(async (tx) => core.commitTxn(await tx.doc(Space), this.now(), txn), this.ctx); }
	abort(txn: string) { return this.host.commit(async (tx) => core.abortTxn(await tx.doc(Space), this.now(), txn), this.ctx); }
	renew(leaseId: string, ms: number) { return this.host.commit(async (tx) => core.renew(await tx.doc(Space), this.now(), leaseId, ms), this.ctx); }
	cancel(leaseId: string) { return this.host.commit(async (tx) => core.cancel(await tx.doc(Space), this.now(), leaseId), this.ctx); }

	private async op(tmpl: Template, timeout: number, o: OpOptions, take: boolean, ifExists: boolean): Promise<Taken | null> {
		if (timeout < 0) throw new core.IllegalArgumentError("negative timeout");
		const deadline = o.deadline ?? this.now() + timeout;
		const txn = o.txn ?? null;
		for (;;) {
			// Watch before probing, so a write that lands between the probe and the wait still wakes us.
			await this.host.commit(async (tx) => { await tx.doc(Space); }, this.ctx); // the watch needs the doc to exist
			const watch = await this.host.watchDoc(Space, this.ctx);
			let woke!: () => void;
			const changed = new Promise<void>((r) => (woke = r));
			watch?.start(async () => woke());
			try {
				const r = await this.host.commit(async (tx) => {
					const prior = take && o.once ? await o.once.get(tx) : undefined;
					if (prior !== undefined) return { status: "replay" as const, value: prior as Taken | null };
					const s = await tx.doc(Space);
					const p = core.probe(s, this.now(), tmpl, txn, take);
					if (p.status === "found" && take && o.once) await o.once.set(tx, view(p.entry) as unknown as Json);
					return p;
				}, this.ctx);
				if (r.status === "replay") return r.value;
				if (r.status === "found") return view(r.entry);
				// readIfExists/takeIfExists wait only while matches are locked by other transactions.
				if (r.status === "none" && ifExists) return null;
				const left = deadline - this.now();
				if (left <= 0) return null;
				const next = await this.host.commit(async (tx) => core.nextExpiry(await tx.doc(Space)), this.ctx);
				const wake = Math.max(1, Math.min(left, next - this.now()));
				await awaitWithContext(Promise.race([changed, new Promise<void>((r) => setTimeout(r, wake))]), this.ctx);
			} finally {
				await watch?.stop();
			}
		}
	}
}
