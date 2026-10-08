// The local pi-spaces client over the Session-scoped Space document. Host code, tasks and tools all use this.
// Everything here runs against one harness: the harness process is the "space service".
import type { Session, Tx } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import { Space } from "./doc.ts";
import { NamedSpace, Registry, spaceDoc, UnknownSpaceError } from "./spaces.ts";
import * as claims from "./claims.ts";
import type { ClaimView, Principal, RequestRef } from "./claims.ts";
import { meter as defaultMeter, type Meter } from "./meter.ts";
import type { EntryDraft, Fields, Json, Lease, Template } from "./core.ts";

export { NO_WAIT, ANY, FOREVER, DEFAULT_LIMITS, IllegalArgumentError, LimitError, PermissionError, TransactionError, UnknownLeaseError } from "./core.ts";
export type { EntryDraft, Fields, Json, Lease, Limits, Template } from "./core.ts";
export { Space };

/** What the client needs; both `Harness` and a tool's `api` provide it. */
export type SpaceHost = Pick<Session, "commit" | "watchDoc" | "snapshot">;
/** `space`: alias or spaceId of a named space (see `createSpace`); omitted: the default space. */
export type PiSpacesOptions = { space?: string };
export type Once = { get(tx: Tx): Promise<Json | undefined>; set(tx: Tx, v: Json): Promise<void> };
export type Snapshot = { readonly entry: Readonly<EntryDraft> };
export type OpOptions = {
	txn?: string | null;
	/** Absolute deadline (ms). Overrides `timeout`; lets a durable caller keep the clock across a restart. */
	deadline?: number;
	/** Exactly-once hook: the outcome (the entry, or null for a miss) is recorded in the same commit that decides it
	 * (for a take, the one that removes the entry). A replay returns it unchanged, and is not counted again. */
	once?: Once;
	/** Durable request identity (claims.ts): the outcome is stored with the operation; a retry with the same identity
	 * and arguments returns it (also after a restart), a pending one continues with its first deadline. */
	request?: RequestRef;
};
/** Request identity for an immediate mutation. */
export type Req = { request?: RequestRef };

const view = core.view;
export type Taken = ReturnType<typeof view>;
/** Pause (plus up to as much again of jitter) between a change waking a blocked read/take and its next probe. */
export const WAKE_DEBOUNCE_MS = 20;

/** What tools and federated/remote implementations share. `PiSpaces` is the local one. */
export interface SpaceLike {
	write(entry: EntryDraft, txn?: string | null, lease?: number, o?: Req): Promise<Lease>;
	read(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	readIfExists(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	take(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	takeIfExists(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	notify(tmpl: Template, o: { target: core.Target; txn?: string | null; lease?: number; handback?: Json } & Req): Promise<{ eventId: string; lease: Lease }>;
	wait(tmpl: Template, o: { take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json } & Req): Promise<string>;
	readAll(tmpl?: Template, o?: { limit?: number; txn?: string | null }): Promise<Taken[]>;
	count(tmpl?: Template, txn?: string | null): Promise<number>;
	stats(): Promise<core.SpaceStats>;
	createTransaction(lease?: number, o?: Req): Promise<Lease>;
	commit(txn: string, o?: Req): Promise<void>;
	abort(txn: string, o?: Req): Promise<void>;
	renew(leaseId: string, ms: number, o?: Req): Promise<number>;
	cancel(leaseId: string, o?: Req): Promise<void>;
}

export class PiSpaces implements SpaceLike {
	private host: SpaceHost;
	private ctx: Context;
	private now: () => number;
	private meter: Meter;
	private as: core.Target | undefined;
	private space: string | undefined;
	/** `as`: the conversation acting (tools pass theirs). It owns what it creates and may only touch its own or
	 * ownerless transactions and leases. Omitted (host code): unrestricted. */
	constructor(host: SpaceHost, ctx: Context, now: () => number = Date.now, meter: Meter = defaultMeter, as?: core.Target, o: PiSpacesOptions = {}) {
		this.meter = meter;
		this.host = host;
		this.ctx = ctx;
		this.now = now;
		this.as = as;
		this.space = o.space;
	}

	/** This client's space document inside a commit (registers the default space on first use). */
	private doc(tx: Tx): Promise<core.SpaceState> { return spaceDoc(tx, this.space, this.now()); }
	/** Committed state for snapshot reads. The default space reads its document directly, even before registration. */
	private async snap(): Promise<Readonly<core.SpaceState> | undefined> {
		if (this.space === undefined) return this.host.snapshot(Space, this.ctx);
		const id = await this.idOf();
		const r = await this.host.snapshot(Registry, this.ctx);
		return id === r?.defaultSpaceId ? this.host.snapshot(Space, this.ctx) : this.host.snapshot(NamedSpace, id, this.ctx);
	}
	private async idOf(): Promise<string> {
		const r = await this.host.snapshot(Registry, this.ctx);
		const id = r && this.space !== undefined ? r.aliases[this.space] ?? (r.spaces[this.space] ? this.space : undefined) : undefined;
		if (id === undefined) throw new UnknownSpaceError(`unknown space: ${this.space}`);
		return id;
	}
	private async watch() {
		if (this.space === undefined) return this.host.watchDoc(Space, this.ctx);
		const r = await this.host.snapshot(Registry, this.ctx);
		const id = await this.idOf();
		return id === r?.defaultSpaceId ? this.host.watchDoc(Space, this.ctx) : this.host.watchDoc(NamedSpace, id, this.ctx);
	}

	async write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY, o: Req = {}): Promise<Lease> {
		const r = await this.mutate("write", { entry, txn, lease } as unknown as Json, o.request, (s, now) => core.write(s, now, entry, txn, lease, this.as));
		if (r.fresh) this.meter.inc("writes");
		return r.value;
	}

	/**
	 * An immediate mutation, optionally under a request identity: claim check, effect and stored result in one commit.
	 * `fresh` is false for a replay (the stored result, nothing executed).
	 */
	private async mutate<T>(method: string, args: Json, request: RequestRef | undefined, fn: (s: core.SpaceState, now: number) => T): Promise<{ value: T; fresh: boolean }> {
		return this.host.commit(async (tx) => {
			const s = await this.doc(tx);
			const now = this.now();
			if (!request) return { value: fn(s, now), fresh: true };
			const ad = claims.admit(s, now, request, method, core.plain(args), core.FOREVER);
			if (ad.kind === "done") return { value: core.plain(ad.result) as T, fresh: false };
			if (ad.kind === "cancelled") throw new claims.OperationCancelled(`request ${request.requestId} was cancelled`);
			const value = fn(s, now);
			claims.decide(s, now, ad.key, { state: "done", result: core.plain((value ?? null) as Json) });
			return { value, fresh: true };
		}, this.ctx);
	}

	/** A new request generation for `principal`, in this space. Request ids are admitted while it is open. */
	issueGeneration(principal: Principal): Promise<{ generation: string; admitUntil: number }> {
		return this.host.commit(async (tx) => claims.issueGeneration(await this.doc(tx), this.now(), principal), this.ctx);
	}
	/** State of a known request, read without a commit. An unknown id is RequestExpired, never a new operation. */
	async pollOperation(target: RequestRef): Promise<ClaimView> {
		const s = await this.snap();
		if (!s) throw new claims.RequestExpired(`request ${target.requestId} is unknown`);
		return claims.lookup(s, target, this.now());
	}
	/** Cancel a pending request (a blocked call then ends with OperationCancelled); a decided one is returned as is. */
	async cancelOperation(target: RequestRef, o: Req = {}): Promise<ClaimView> {
		const r = await this.mutate("cancelOperation", { target } as unknown as Json, o.request, (s, now) => claims.cancelRequest(s, now, target) as unknown as Json);
		return r.value as unknown as ClaimView;
	}
	read(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, false); }
	readIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, false, true); }
	take(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, false); }
	takeIfExists(tmpl: Template, timeout: number, o: OpOptions = {}) { return this.op(tmpl, timeout, o, true, true); }

	/** `target` is the conversation that receives the events; without one they would have nobody to go to. */
	async notify(tmpl: Template, o: { target: core.Target; txn?: string | null; lease?: number; handback?: Json } & Req) {
		if (o.target == null || o.target === "") throw new core.IllegalArgumentError("notify needs a target conversation");
		const args = { tmpl, target: o.target, txn: o.txn ?? null, lease: o.lease ?? core.ANY, handback: o.handback ?? null } as unknown as Json;
		return (await this.mutate("notify", args, o.request, (s, now) => core.notify(s, now, tmpl, o.txn ?? null, o.lease ?? core.ANY, o.handback ?? null, o.target, this.as))).value;
	}
	/** Park a read/take for a conversation. The space delivers the entry (or a timeout) to it as input later.
	 * `timeout` may be FOREVER: the wait stays until served or cancelled, across restarts. */
	async wait(tmpl: Template, o: { take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json } & Req): Promise<string> {
		if (o.target == null || o.target === "") throw new core.IllegalArgumentError("wait needs a target conversation");
		const w = { template: tmpl, take: o.take ?? true, target: o.target, timeout: o.timeout, ...(o.txnLeaseMs === undefined ? {} : { txnLeaseMs: o.txnLeaseMs }), handback: o.handback ?? null };
		return (await this.mutate("wait", w as unknown as Json, o.request, (s, now) => core.addWaiter(s, now, { ...w, ...(this.as === undefined ? {} : { as: this.as }) }))).value;
	}
	/** Quotas for conversations in this space (host code only; stored in the document). */
	setLimits(l: Partial<core.Limits>): Promise<core.Limits> {
		if (this.as !== undefined) throw new core.IllegalArgumentError("only host code may change limits");
		return this.host.commit(async (tx) => core.setLimits(await this.doc(tx), l), this.ctx);
	}
	/**
	 * Every entry a `read` with this template would currently see (oldest first, at most `limit`, default and maximum
	 * 1000). A snapshot read: no commit, no lock, nothing is removed and nobody is woken, so it suits dashboards.
	 */
	async readAll(tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}): Promise<Taken[]> {
		const s = await this.snap();
		const out = s ? core.list(s, this.now(), tmpl, o.txn ?? null, o.limit, this.as) : [];
		this.meter.inc("reads");
		return out;
	}
	/** Number of entries a `read` with this template would currently see. No commit, no waiting. */
	async count(tmpl: Template = null, txn: string | null = null): Promise<number> {
		const s = await this.snap();
		return s ? core.count(s, this.now(), tmpl, txn) : 0;
	}
	/** Point-in-time gauges: visible entries (total and per type), locked, uncommitted, transactions, waiters, ... */
	async stats(): Promise<core.SpaceStats> {
		const s = await this.snap();
		return core.stats(s ?? core.initialState(), this.now());
	}
	/** A frozen canonical copy. JavaSpaces' snapshot is a serialization cache; this keeps the contract only. */
	snapshot(entry: EntryDraft): Snapshot { return { entry: Object.freeze(structuredClone(entry)) }; }

	async createTransaction(lease: number = core.ANY, o: Req = {}) { return (await this.mutate("txn.begin", { lease }, o.request, (s, now) => core.createTxn(s, now, lease, this.as))).value; }
	async commit(txn: string, o: Req = {}) { await this.mutate("txn.commit", { txn }, o.request, (s, now) => core.commitTxn(s, now, txn, this.as)); }
	async abort(txn: string, o: Req = {}) { await this.mutate("txn.abort", { txn }, o.request, (s, now) => core.abortTxn(s, now, txn, this.as)); }
	async renew(leaseId: string, ms: number, o: Req = {}) { return (await this.mutate("lease.renew", { leaseId, ms }, o.request, (s, now) => core.renew(s, now, leaseId, ms, this.as))).value; }
	async cancel(leaseId: string, o: Req = {}) { await this.mutate("lease.cancel", { leaseId }, o.request, (s, now) => core.cancel(s, now, leaseId, this.as)); }

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
		let deadline = o.deadline ?? core.deadlineOf(this.now(), timeout);
		const method = `${take ? "take" : "read"}${ifExists ? "IfExists" : ""}`;
		const args = { tmpl, timeout, deadline: o.deadline ?? null, txn: o.txn ?? null } as unknown as Json;
		const txn = o.txn ?? null;
		await this.host.commit(async (tx) => { await this.doc(tx); }, this.ctx); // the watch needs the doc to exist
		// One watch for the whole wait. It is acquired before the first probe and flags every change, so a write that
		// lands between a probe and the wait is never missed: `dirty` is cleared before each probe and checked after.
		const watch = await this.watch();
		let dirty = false;
		let poke: () => void = () => {};
		watch?.start(async () => { dirty = true; poke(); });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (;;) {
				dirty = false;
				const r = await this.host.commit(async (tx) => {
					const prior = o.once ? await o.once.get(tx) : undefined;
					if (prior !== undefined) return { status: "replay" as const, value: core.plain(prior) as Taken | null };
					const s = await this.doc(tx);
					const now = this.now();
					// A known request continues with the deadline it got first; a decided or cancelled one is answered.
					let key: string | undefined;
					let dl = deadline;
					if (o.request) {
						const ad = claims.admit(s, now, o.request, method, core.plain(args), deadline);
						if (ad.kind === "done") return { status: "replay" as const, value: core.plain(ad.result) as Taken | null };
						if (ad.kind === "cancelled") return { status: "cancelled" as const };
						key = ad.key;
						dl = ad.deadline;
					}
					const p = core.probe(s, now, tmpl, txn, take, this.as);
					// readIfExists/takeIfExists wait only while matches are locked by other transactions.
					const miss = p.status !== "found" && ((p.status === "none" && ifExists) || dl <= now);
					const outcome = p.status === "found" ? (view(p.entry, s.spaceId) as unknown as Json) : null;
					if (o.once && (p.status === "found" || miss)) await o.once.set(tx, outcome);
					if (key && (p.status === "found" || miss)) claims.decide(s, now, key, { state: "done", result: outcome });
					return { ...p, miss, next: core.nextExpiry(s), spaceId: s.spaceId, deadline: dl }; // one commit per round: probe, outcome and next wake-up
				}, this.ctx);
				if (r.status === "replay") return r.value; // a replayed call was counted the first time
				if (r.status === "cancelled") throw new claims.OperationCancelled(`request ${o.request?.requestId} was cancelled`);
				deadline = r.deadline;
				if (r.status === "found") { this.meter.inc(take ? "takes" : "reads"); return view(r.entry, r.spaceId); }
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
