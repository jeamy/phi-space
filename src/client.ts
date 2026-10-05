// A JavaSpace-shaped client over the Session-scoped Space document. Host code, tasks and tools all use this.
// Everything here runs against one harness: the harness process is the "space service".
import type { Session, Tx } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import { Space } from "./doc.ts";
import { meter as defaultMeter, type Meter } from "./meter.ts";
import type { EntryDraft, Fields, Json, Lease, Template } from "./core.ts";

export { NO_WAIT, ANY, FOREVER, DEFAULT_LIMITS, IllegalArgumentError, LimitError, PermissionError, TransactionError, UnknownLeaseError } from "./core.ts";
export type { EntryDraft, Fields, Json, Lease, Limits, Template } from "./core.ts";
export { Space };

/** What the client needs; both `Harness` and a tool's `api` provide it. */
export type SpaceHost = Pick<Session, "commit" | "watchDoc" | "snapshot">;
export type Once = { get(tx: Tx): Promise<Json | undefined>; set(tx: Tx, v: Json): Promise<void> };
export type Snapshot = { readonly entry: Readonly<EntryDraft> };
export type OpOptions = {
	txn?: string | null;
	/** Absolute deadline (ms). Overrides `timeout`; lets a durable caller keep the clock across a restart. */
	deadline?: number;
	/** Exactly-once hook: the outcome (the entry, or null for a miss) is recorded in the same commit that decides it
	 * (for a take, the one that removes the entry). A replay returns it unchanged, and is not counted again. */
	once?: Once;
};

const view = core.view;
export type Taken = ReturnType<typeof view>;
/** Pause (plus up to as much again of jitter) between a change waking a blocked read/take and its next probe. */
export const WAKE_DEBOUNCE_MS = 20;

export class JavaSpace {
	private host: SpaceHost;
	private ctx: Context;
	private now: () => number;
	private meter: Meter;
	private as: core.Target | undefined;
	/** `as`: the conversation acting (tools pass theirs). It owns what it creates and may only touch its own or
	 * ownerless transactions and leases. Omitted (host code): unrestricted. */
	constructor(host: SpaceHost, ctx: Context, now: () => number = Date.now, meter: Meter = defaultMeter, as?: core.Target) {
		this.meter = meter;
		this.host = host;
		this.ctx = ctx;
		this.now = now;
		this.as = as;
	}

	async write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY): Promise<Lease> {
		const l = await this.host.commit(async (tx) => core.write(await tx.doc(Space), this.now(), entry, txn, lease, this.as), this.ctx);
		this.meter.inc("writes");
		return l;
	}
	read(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, false); }
	readIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, true); }
	take(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, false); }
	takeIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, true); }

	/** `target` is the conversation that receives the events; without one they would have nobody to go to. */
	async notify(tmpl: Template, o: { target: core.Target; txn?: string | null; lease?: number; handback?: Json }) {
		if (o.target == null || o.target === "") throw new core.IllegalArgumentError("notify needs a target conversation");
		return this.host.commit(async (tx) => core.notify(await tx.doc(Space), this.now(), tmpl, o.txn ?? null, o.lease ?? core.ANY, o.handback ?? null, o.target, this.as), this.ctx);
	}
	/** Park a read/take for a conversation. The space delivers the entry (or a timeout) to it as input later.
	 * `timeout` may be FOREVER: the wait stays until served or cancelled, across restarts. */
	async wait(tmpl: Template, o: { take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json }): Promise<string> {
		if (o.target == null || o.target === "") throw new core.IllegalArgumentError("wait needs a target conversation");
		return this.host.commit(async (tx) => core.addWaiter(await tx.doc(Space), this.now(), { template: tmpl, take: o.take ?? true, target: o.target, timeout: o.timeout, ...(o.txnLeaseMs === undefined ? {} : { txnLeaseMs: o.txnLeaseMs }), handback: o.handback ?? null, ...(this.as === undefined ? {} : { as: this.as }) }), this.ctx);
	}
	/** Quotas for conversations in this space (host code only; stored in the document). */
	setLimits(l: Partial<core.Limits>): Promise<core.Limits> {
		if (this.as !== undefined) throw new core.IllegalArgumentError("only host code may change limits");
		return this.host.commit(async (tx) => core.setLimits(await tx.doc(Space), l), this.ctx);
	}
	/**
	 * Every entry a `read` with this template would currently see (oldest first, at most `limit`, default and maximum
	 * 1000). A snapshot read: no commit, no lock, nothing is removed and nobody is woken, so it suits dashboards.
	 */
	async readAll(tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}): Promise<Taken[]> {
		const s = await this.host.snapshot(Space, this.ctx);
		const out = s ? core.list(s, this.now(), tmpl, o.txn ?? null, o.limit, this.as) : [];
		this.meter.inc("reads");
		return out;
	}
	/** Number of entries a `read` with this template would currently see. No commit, no waiting. */
	async count(tmpl: Template = null, txn: string | null = null): Promise<number> {
		const s = await this.host.snapshot(Space, this.ctx);
		return s ? core.count(s, this.now(), tmpl, txn) : 0;
	}
	/** Point-in-time gauges: visible entries (total and per type), locked, uncommitted, transactions, waiters, ... */
	async stats(): Promise<core.SpaceStats> {
		const s = await this.host.snapshot(Space, this.ctx);
		return core.stats(s ?? core.initialState(), this.now());
	}
	/** A frozen canonical copy. JavaSpaces' snapshot is a serialization cache; this keeps the contract only. */
	snapshot(entry: EntryDraft): Snapshot { return { entry: Object.freeze(structuredClone(entry)) }; }

	createTransaction(lease: number = core.ANY) { return this.host.commit(async (tx) => core.createTxn(await tx.doc(Space), this.now(), lease, this.as), this.ctx); }
	commit(txn: string) { return this.host.commit(async (tx) => core.commitTxn(await tx.doc(Space), this.now(), txn, this.as), this.ctx); }
	abort(txn: string) { return this.host.commit(async (tx) => core.abortTxn(await tx.doc(Space), this.now(), txn, this.as), this.ctx); }
	renew(leaseId: string, ms: number) { return this.host.commit(async (tx) => core.renew(await tx.doc(Space), this.now(), leaseId, ms, this.as), this.ctx); }
	cancel(leaseId: string) { return this.host.commit(async (tx) => core.cancel(await tx.doc(Space), this.now(), leaseId, this.as), this.ctx); }

	/**
	 * Debounce: after a change wakes a blocked op, wait a moment (jittered) before probing again, so a burst of writes
	 * costs one round instead of one per write and many waiters do not all probe in the same instant.
	 */
	private calmDown(): Promise<void> {
		const ms = WAKE_DEBOUNCE_MS + Math.random() * WAKE_DEBOUNCE_MS;
		let t: ReturnType<typeof setTimeout> | undefined;
		return awaitWithContext(new Promise<void>((res) => { t = setTimeout(res, ms); }), this.ctx).finally(() => clearTimeout(t));
	}

	/** `timeout` may be FOREVER. Long waits sleep in timer-sized chunks; every wake-up re-probes, so nothing is lost. */
	private async op(tmpl: Template, timeout: number, o: OpOptions, take: boolean, ifExists: boolean): Promise<Taken | null> {
		const deadline = o.deadline ?? core.deadlineOf(this.now(), timeout);
		const txn = o.txn ?? null;
		await this.host.commit(async (tx) => { await tx.doc(Space); }, this.ctx); // the watch needs the doc to exist
		// One watch for the whole wait. It is acquired before the first probe and flags every change, so a write that
		// lands between a probe and the wait is never missed: `dirty` is cleared before each probe and checked after.
		const watch = await this.host.watchDoc(Space, this.ctx);
		let dirty = false;
		let poke: () => void = () => {};
		watch?.start(async () => { dirty = true; poke(); });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (;;) {
				dirty = false;
				const r = await this.host.commit(async (tx) => {
					const prior = o.once ? await o.once.get(tx) : undefined;
					if (prior !== undefined) return { status: "replay" as const, value: prior as Taken | null };
					const s = await tx.doc(Space);
					const now = this.now();
					const p = core.probe(s, now, tmpl, txn, take, this.as);
					// readIfExists/takeIfExists wait only while matches are locked by other transactions.
					const miss = p.status !== "found" && ((p.status === "none" && ifExists) || deadline <= now);
					if (o.once && (p.status === "found" || miss)) await o.once.set(tx, p.status === "found" ? (view(p.entry) as unknown as Json) : null);
					return { ...p, miss, next: core.nextExpiry(s) }; // one commit per round: probe, outcome and next wake-up
				}, this.ctx);
				if (r.status === "replay") return r.value; // a replayed call was counted the first time
				if (r.status === "found") { this.meter.inc(take ? "takes" : "reads"); return view(r.entry); }
				if (r.miss) { this.meter.inc("misses"); return null; }
				const left = deadline - this.now();
				if (left <= 0) continue; // the deadline passed after the probe: the next round records the miss
				if (dirty) { await this.calmDown(); continue; } // something changed during the probe: look again before sleeping
				const wake = core.timerDelay(Math.min(left, r.next - this.now()));
				await awaitWithContext(new Promise<void>((res) => { poke = res; timer = setTimeout(res, wake); }), this.ctx);
				clearTimeout(timer);
				if (dirty) await this.calmDown(); // woken by a change, not by the clock
			}
		} finally {
			clearTimeout(timer);
			await watch?.stop();
		}
	}
}
