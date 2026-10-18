import {assertMemberAdmission,permitRoutedWrite} from "./member-admission.ts";
// The local phi-spaces client over the Session-scoped Space document. Host code, tasks and tools all use this.
// Everything here runs against one harness: the harness process is the "space service".
import type { DecisionAuthorization } from "./service.ts";
import type { Session, Tx } from "@earendil-works/pi-durable";
import { awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import * as core from "./core.ts";
import { Space } from "./doc.ts";
import { NamedSpace, Registry, spaceDoc, hostKey, UnknownSpaceError } from "./spaces.ts";
import * as claims from "./claims.ts";
import type { ClaimView, Principal, RequestRef } from "./claims.ts";
import { meter as defaultMeter, type Meter } from "./meter.ts";
import type { EntryDraft, Fields, Json, Lease, Template } from "./core.ts";
import { snapshotPage, type SnapshotPageOptions } from "./snapshot.ts";
import { mailboxPage, ackMailbox, type MailboxPage } from "./mailbox.ts";

export { NO_WAIT, ANY, FOREVER, DEFAULT_LIMITS, IllegalArgumentError, LimitError, PermissionError, ResourceExhausted, TransactionError, UnknownLeaseError } from "./core.ts";
export type { EntryDraft, Fields, Json, Lease, Limits, Template } from "./core.ts";
export { Space };

/** What the client needs; both `Harness` and a tool's `api` provide it. */
export type SpaceHost = Pick<Session, "commit" | "watchDoc" | "snapshot">;
/** `space`: alias or spaceId of a named space (see `createSpace`); omitted: the default space. */
export type PhiSpacesOptions = { space?: string; authorityId?: string; maxPending?: number; maxPendingPeer?: number; consumer?: Principal; authorization?: DecisionAuthorization };
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
	/** Transport response budget; a first immediate result is checked inside the deciding commit. Not hashed. */
	resultBudget?: number;
};
/** Request identity for an immediate mutation. */
export type Req = { request?: RequestRef; /** Atomically reject another physical entry of this type with these key fields, including reservations. */ unique?: string[] };

const view = core.view;
export type Taken = ReturnType<typeof view>;
/** Pause (plus up to as much again of jitter) between a change waking a blocked read/take and its next probe. */
export const WAKE_DEBOUNCE_MS = 20;

/** What tools and federated/remote implementations share. `PhiSpaces` is the local one. */
export interface SpaceLike {
	write(entry: EntryDraft, txn?: string | null, lease?: number, o?: Req): Promise<Lease>;
	read(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	readIfExists(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	take(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	takeIfExists(tmpl: Template, timeout: number, o?: OpOptions): Promise<Taken | null>;
	notify(tmpl: Template, o: { target: core.Target; txn?: string | null; lease?: number; handback?: Json } & Req): Promise<{ eventId: string; lease: Lease }>;
	wait(tmpl: Template, o: { take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json } & Req): Promise<string>;
	readAll(tmpl?: Template, o?: { limit?: number; txn?: string | null }): Promise<Taken[]>;
	/** One page limited by encoded bytes; continue with `next` (core.listPage). */
	readPage(tmpl?: Template, o?: SnapshotPageOptions): Promise<core.Page>;
	/** Commit batches after a revision (core.changes). */
	changes(afterRev: number, o?: { maxBytes?: number }): Promise<core.Changes>;
	count(tmpl?: Template, txn?: string | null): Promise<number>;
	stats(): Promise<core.SpaceStats>;
	createTransaction(lease?: number, o?: Req): Promise<Lease>;
	commit(txn: string, o?: Req): Promise<void>;
	abort(txn: string, o?: Req): Promise<void>;
	renew(leaseId: string, ms: number, o?: Req): Promise<number>;
	cancel(leaseId: string, o?: Req): Promise<void>;
}

export class PhiSpaces implements SpaceLike {
	private host: SpaceHost;
	private ctx: Context;
	private now: () => number;
	private meter: Meter;
	private as: core.Target | undefined;
	private space: string | undefined;
	private options: PhiSpacesOptions;
	/** `as`: the conversation acting (tools pass theirs). It owns what it creates and may only touch its own
	 * transactions and leases. Omitted (host code): unrestricted. */
	constructor(host: SpaceHost, ctx: Context, now: () => number = Date.now, meter: Meter = defaultMeter, as?: core.Target, o: PhiSpacesOptions = {}) {
		this.meter = meter;
		this.host = host;
		this.ctx = ctx;
		this.now = now;
		this.as = as;
		this.space = o.space === "default" ? undefined : o.space;
		this.options = o;
	}

	/** This client's space document inside a commit (registers the default space on first use). */
	private async doc(tx: Tx): Promise<core.SpaceState> { const s=await spaceDoc(tx, this.space, this.now()); await this.options.authorization?.checkTx?.(tx); permitRoutedWrite(s,!!this.options.authorization?.routerEpoch); return s; }
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
	async configuration(): Promise<{ spaceId?: string; limits: core.Limits }> { const s = await this.snap(); return { spaceId: s?.spaceId, limits: core.limitsOf(s ?? core.initialState()) }; }

	async write(entry: EntryDraft, txn: string | null = null, lease: number = core.ANY, o: Req = {}): Promise<Lease> {
		const r = await this.mutate("write", { entry, txn, lease, ...(o.unique ? { unique: o.unique } : {}) } as unknown as Json, o.request, (s, now) => {
			if (o.unique !== undefined) {
				if (!Array.isArray(o.unique) || !o.unique.length || o.unique.some(k => typeof k !== "string" || !Object.hasOwn(entry.fields, k))) throw new core.IllegalArgumentError("unique needs existing field names");
				core.settle(s, now);
				if (s.entries.some(e => e.type === entry.type && o.unique!.every(k => core.deepEqual(e.fields[k] ?? null, entry.fields[k]!)))) throw new core.IllegalArgumentError("unique entry already exists");
			}
			return core.write(s, now, entry, txn, lease, this.as);
		});
		if (r.fresh) this.meter.inc("writes");
		return r.value;
	}

	/**
	 * An immediate mutation, optionally under a request identity: claim check, effect and stored result in one commit.
	 * `fresh` is false for a replay (the stored result, nothing executed).
	 */
	private async mutate<T>(method: string, args: Json, request: RequestRef | undefined, fn: (s: core.SpaceState, now: number) => T): Promise<{ value: T; fresh: boolean }> {
		await this.maintain();
		return this.host.commit(async (tx) => {
			const s = await this.doc(tx);
			const now = this.now();
			this.options.authorization?.check();
			if (!request) return { value: fn(s, now), fresh: true };
			if(!s.rpc?.claims[claims.keyOf(s,request)])assertMemberAdmission(s,method);
			const limits = core.limitsOf(s);
			const resultBound = method === "cancelOperation" ? limits.maxEntryBytes + 4 * limits.maxTypeChars * limits.maxTypes + 8192 : 1024;
			const ad = claims.admit(s, now, request, method, core.plain(args), core.FOREVER, resultBound);
			if (ad.kind === "done") return { value: core.plain(ad.result) as T, fresh: false };
			if (ad.kind === "cancelled") throw new claims.OperationCancelled(`request ${request.requestId} was cancelled`);
			this.claimMetadata(s,ad.key);
			const value = fn(s, now);
			claims.decide(s, now, ad.key, { state: "done", result: core.plain((value ?? null) as Json) });
			return { value, fresh: true };
		}, this.ctx);
	}

	/** A new request generation for `principal`, in this space. Request ids are admitted while it is open. */
	issueGeneration(principal: Principal, options:{primaryEpoch?:number}={}): Promise<{ generation: string; admitUntil: number }> {
		return this.host.commit(async (tx) => { const s = await this.doc(tx), key = await hostKey(tx, this.now()); this.options.authorization?.check(); return claims.issueGeneration(s, this.now(), principal, { key, authorityId: this.options.authorityId, primaryEpoch:options.primaryEpoch }); }, this.ctx);
	}
	/** Resolve a journaled identity; a miss only authorizes retry of that same identity on this epoch. */
 async resolveOperation(target:RequestRef, method:string, argumentHash:string, primaryEpoch:number):Promise<claims.AdmissionResolution>{
  return (await this.resolveOperationRecord(target,method,argumentHash,primaryEpoch)).resolution;
 }
 /** v3 6.2 after a promotion: the durable negative claim for an unknown request of an earlier epoch (claims.decideNotCommitted). */
 async resolveNotCommitted(target:RequestRef,method:string,argumentHash:string,requestEpoch:number,primaryEpoch:number,proofHash:string):Promise<claims.ClaimView>{
  if(this.options.consumer&&canonicalPrincipal(target.principal)!==canonicalPrincipal(this.options.consumer))throw new core.PermissionError('another principal request');
  return this.host.commit(async tx=>{const s=await this.doc(tx);this.options.authorization?.check();return core.plain(claims.decideNotCommitted(s,this.now(),target,method,argumentHash,requestEpoch,primaryEpoch,proofHash) as unknown as Json) as unknown as claims.ClaimView;},this.ctx);
 }
 /** Resolve the SAME original claim and capture its space binding in one guarded storage commit. */
 async resolveOperationRecord(target:RequestRef,method:string,argumentHash:string,primaryEpoch:number){
  if(this.options.consumer&&canonicalPrincipal(target.principal)!==canonicalPrincipal(this.options.consumer))throw new core.PermissionError('another principal request');
  const record=await this.host.commit(async tx=>{const s=await this.doc(tx);this.options.authorization?.check();return core.plain({
   binding:{spaceId:s.spaceId??null,authorityId:this.options.authorityId??'local',dataIncarnation:s.incarnation??null,primaryEpoch:s.primaryEpoch??primaryEpoch,principal:target.principal,generation:target.generation,requestId:target.requestId,method,argumentHash},
   resolution:claims.resolveAdmission(s,this.now(),target,method,argumentHash,primaryEpoch)
  } as unknown as Json) as unknown as {binding:{spaceId:string|null;authorityId:string;dataIncarnation:string|null;primaryEpoch:number;principal:Principal;generation:string;requestId:string;method:string;argumentHash:string};resolution:claims.AdmissionResolution};},this.ctx);
  if(record.resolution.state==='pending'&&!record.resolution.restoredHistory)record.resolution=await this.pollOperation(target);
  return record;
 }

	/** State of a known request, read without a commit. An unknown id is RequestExpired, never a new operation. */
	async pollOperation(target: RequestRef): Promise<ClaimView> {
		const s = await this.snap();
		if (!s) throw new claims.RequestExpired(`request ${target.requestId} is unknown`);
		const v = claims.lookup(s, target, this.now());
		if (v.state !== "pending" || v.restoredHistory) return v;
		return this.host.commit(async tx => { const d = await this.doc(tx); this.options.authorization?.check(); this.authorizePending(d, target); core.settle(d, this.now()); return core.plain(claims.lookup(d, target, this.now())); }, this.ctx);
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
		return (await this.mutate("notify", args, o.request, (s, now) => core.notify(s, now, tmpl, o.txn ?? null, o.lease ?? core.ANY, o.handback ?? null, o.target, this.as, this.options.consumer))).value;
	}
	/** Park a read/take for a conversation. The space delivers the entry (or a timeout) to it as input later.
	 * `timeout` may be FOREVER: the wait stays until served or cancelled, across restarts. */
	async wait(tmpl: Template, o: { deadline?:number; take?: boolean; target: core.Target; timeout: number; txnLeaseMs?: number; handback?: Json } & Req): Promise<string> {
		if (o.target == null || o.target === "") throw new core.IllegalArgumentError("wait needs a target conversation");
		const w = { ...(o.deadline===undefined?{}:{deadline:o.deadline}), template: tmpl, take: o.take ?? true, target: o.target, timeout: o.timeout, ...(o.txnLeaseMs === undefined ? {} : { txnLeaseMs: o.txnLeaseMs }), handback: o.handback ?? null };
		return (await this.mutate("wait", w as unknown as Json, o.request, (s, now) => core.addWaiter(s, now, { ...w, ...(o.request?{originRequestKey:claims.keyOf(s,o.request)}:{}), ...(this.as === undefined ? {} : { as: this.as }), consumer: this.options.consumer, ...(this.options.authorization ? { authorizedUntil: this.options.authorization.validUntil } : {}) }))).value;
	}
	async events(principal: Principal, o: { mailboxEpoch?: string; after?: number; maxBytes?: number } = {}, validate?: (page: MailboxPage) => void): Promise<MailboxPage> {
		if (this.options.consumer && canonicalPrincipal(principal) !== canonicalPrincipal(this.options.consumer)) throw new core.PermissionError("another consumer's mailbox");
		await this.maintain();
		return this.host.commit(async tx => { const s = await this.doc(tx); this.options.authorization?.check();
			const authorization = this.options.authorization;
			if (authorization) for (const w of s.waiters) if ((authorization.renewalWaiterId === undefined || authorization.renewalWaiterId === w.id) && w.consumer && canonicalPrincipal(w.consumer) === canonicalPrincipal(principal) && authorization.canExecutePending(w.take ? "take" : "read", w.template)) { w.authorizedUntil = authorization.validUntil; core.touch(s, this.now()); }
			core.settle(s, this.now()); const p = mailboxPage(s, principal, this.now(), o); validate?.(p); return p; }, this.ctx);
	}
	async ack(principal: Principal, mailboxEpoch: string, upTo: number, o: Req = {}): Promise<{ mailboxEpoch: string; acked: number }> {
		if (this.options.consumer && canonicalPrincipal(principal) !== canonicalPrincipal(this.options.consumer)) throw new core.PermissionError("another consumer's mailbox");
		return (await this.mutate("ack", { mailboxEpoch, upTo, principal } as unknown as Json, o.request, s => ackMailbox(s, principal, mailboxEpoch, upTo))).value;
	}
	/** Quotas for conversations in this space (host code only; stored in the document). */
	setLimits(l: Partial<core.Limits>): Promise<core.Limits> {
		if (this.as !== undefined) throw new core.IllegalArgumentError("only host code may change limits");
		return this.host.commit(async (tx) => core.setLimits(await this.doc(tx), l, this.now()), this.ctx);
	}
	/**
	 * Every entry a `read` with this template would currently see (oldest first, at most `limit`,
	 * unbounded unless a limit is supplied). A snapshot read: no commit, no lock, nothing is removed and nobody is woken, so it suits dashboards.
	 */
	async readAll(tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}): Promise<Taken[]> {
		const s = await this.snap();
		const out = s ? core.list(s, this.now(), tmpl, o.txn ?? null, o.limit, this.as) : [];
		this.meter.inc("reads");
		return out;
	}
	/** Like `readAll`, one page limited by encoded bytes (core.listPage). Pass `next` of a page as `after` to continue. */
	async readPage(tmpl: Template = null, o: SnapshotPageOptions = {}): Promise<core.Page> {
		if (!(await this.snap())?.spaceId) await this.host.commit(async tx => { await this.doc(tx); }, this.ctx);
		const s = await this.snap();
		const page = snapshotPage(this.host, s ?? core.initialState(), this.now(), tmpl, o, this.as);
		this.meter.inc("reads");
		return page;
	}
	/** The commit batches after `afterRev` (core.changes): limited by bytes, ends between batches, `more` says if there is newer. */
	async changes(afterRev: number, o: { maxBytes?: number } = {}): Promise<core.Changes> {
		const s = await this.snap();
		return core.changes(s ?? core.initialState(), afterRev, o);
	}
	/** Revision of the newest domain or internal-state commit (0: none yet), with the stream it belongs to. */
	async revision(): Promise<{ rev: number; streamId: string }> {
		const s = (await this.snap()) ?? core.initialState();
		return { rev: core.revision(s), streamId: core.streamIdOf(s) };
	}
	/** Number of entries a `read` with this template would currently see. No commit, no waiting. */
	async count(tmpl: Template = null, txn: string | null = null): Promise<number> {
		const s = await this.snap();
		return s ? core.count(s, this.now(), tmpl, txn, this.as) : 0;
	}
	/** Point-in-time gauges: visible entries (total and per type), locked, uncommitted, transactions, waiters, ... */
	async stats(): Promise<core.SpaceStats> {
		const s = await this.snap();
		return core.stats(s ?? core.initialState(), this.now());
	}
	/** Service gauges and revision from one immutable storage snapshot. */
	async countWithRevision(tmpl: Template = null, txn: string | null = null) {
		const s = (await this.snap()) ?? core.initialState();
		return { value: core.count(s, this.now(), tmpl, txn, this.as), rev: core.revision(s), streamId: core.streamIdOf(s) };
	}
	async statsWithRevision() {
		const s = (await this.snap()) ?? core.initialState();
		return { stats: core.stats(s, this.now()), rev: core.revision(s), streamId: core.streamIdOf(s) };
	}
	/** A frozen canonical copy. JavaSpaces' snapshot is a serialization cache; this keeps the contract only. */
	snapshot(entry: EntryDraft): Snapshot { return { entry: Object.freeze(structuredClone(entry)) }; }

	async createTransaction(lease: number = core.ANY, o: Req = {}) { return (await this.mutate("txn.begin", { lease }, o.request, (s, now) => core.createTxn(s, now, lease, this.as))).value; }
	setCompletionProfiles(profiles: core.CompletionProfile[]): Promise<void> {
		if (this.as !== undefined) throw new core.PermissionError("only host code may configure completion profiles");
		return this.host.commit(async tx => {
			const s = await this.doc(tx);
			if (!core.deepEqual((s.completionProfiles ?? []) as unknown as Json, profiles as unknown as Json)) core.setCompletionProfiles(s, profiles, this.now());
		}, this.ctx);
	}
	private checkTransactionRights(s: core.SpaceState, txn: string): void {
		const authorization = this.options.authorization;
		if (!authorization) return;
		for (const e of s.entries) {
			const methods = [...(e.writtenUnder === txn ? ["write"] : []), ...(e.takenBy === txn ? ["take"] : []), ...(e.readBy.includes(txn) ? ["read"] : [])];
			for (const method of methods) if (!e.types.some(type => authorization.canExecutePending(method, { type }))) throw new core.PermissionError(`current grant cannot ${method} transaction entry ${e.id}`);
		}
	}
	async transactionState(id:string):Promise<{state:"active"|"inactive";expires?:number}>{return this.host.commit(async tx=>{const s=await this.doc(tx);this.options.authorization?.check();core.settle(s,this.now());const t=s.txns[id];if(t&&this.as!==undefined&&t.owner!==this.as)throw new core.PermissionError("another principal's transaction");return t?{state:"active",expires:t.expires}:{state:"inactive"};},this.ctx);}

	async commit(txn: string, o: Req = {}) { await this.mutate("txn.commit", { txn }, o.request, (s, now) => { this.checkTransactionRights(s, txn); core.commitTxn(s, now, txn, this.as); }); }
	async abort(txn: string, o: Req = {}) { await this.mutate("txn.abort", { txn }, o.request, (s, now) => core.abortTxn(s, now, txn, this.as)); }
	async renew(leaseId: string, ms: number, o: Req = {}) { return (await this.mutate("lease.renew", { leaseId, ms }, o.request, (s, now) => {
		const authorization = this.options.authorization;
		if (authorization) {
			if (s.txns[leaseId]) this.checkTransactionRights(s, leaseId);
			const entry = s.entries.find(e => e.id === leaseId), registration = s.regs.find(r => r.id === leaseId), waiter = s.waiters.find(w => w.id === leaseId);
			if (entry && !entry.types.some(type => authorization.canExecutePending("write", { type })) || registration && !authorization.canExecutePending("notify", registration.template) || waiter && !authorization.canExecutePending(waiter.take ? "take" : "read", waiter.template)) throw new core.PermissionError("current grant cannot renew the original lease operation");
		}
		return core.renew(s, now, leaseId, ms, this.as);
	})).value; }
	async cancel(leaseId: string, o: Req = {}) { await this.mutate("lease.cancel", { leaseId }, o.request, (s, now) => (()=>{try{core.cancel(s,now,leaseId,this.as);}catch(e){if(!(e instanceof core.UnknownLeaseError)||!this.options.authorization?.allowClosedWaiter)throw e;}})()); }

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
		if (o.request) return this.durableOperation(tmpl, timeout, o, take, ifExists);
		let deadline = o.deadline ?? core.deadlineOf(this.now(), timeout);
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
					const dl = deadline;
					const p = core.probe(s, now, tmpl, txn, take, this.as);
					// readIfExists/takeIfExists wait only while matches are locked by other transactions.
					const miss = p.status !== "found" && ((p.status === "none" && ifExists) || dl <= now);
					const outcome = p.status === "found" ? (view(p.entry, s.spaceId) as unknown as Json) : null;
					if (o.once && (p.status === "found" || miss)) await o.once.set(tx, outcome);
					return { ...p, miss, next: core.nextExpiry(s), spaceId: s.spaceId, deadline: dl }; // one commit per round: probe, outcome and next wake-up
				}, this.ctx);
				if (r.status === "replay") return r.value; // a replayed call was counted the first time
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

	/** Admit, probe and persist pending work before acknowledging it. Replays always check the original domain hash. */
	async beginOperation(tmpl: Template, timeout: number, o: OpOptions & { request: RequestRef }, take: boolean, ifExists: boolean): Promise<ClaimView> {
		const method = `${take ? "take" : "read"}${ifExists ? "IfExists" : ""}`;
		const args = { tmpl, timeout, deadline: o.deadline ?? null, txn: o.txn ?? null } as unknown as Json;
		await this.maintain();
		return this.host.commit(async tx => {
			const s = await this.doc(tx), now = this.now();
			this.options.authorization?.check();
			const existing = s.rpc?.claims[claims.keyOf(s, o.request)];
			if (!existing) {
				assertMemberAdmission(s,method);
				const n = Object.values(s.rpc?.claims ?? {}).filter(c => c.state === "pending" && canonicalPrincipal(c.principal) === canonicalPrincipal(o.request.principal)).length;
				if (n >= (this.options.maxPending ?? 32)) throw new core.ResourceExhausted("too many pending operations for this principal");
				const peerCount = Object.values(s.rpc?.claims ?? {}).filter(c => c.state === "pending" && (c.principal.peerId === o.request.principal.peerId || (!!this.options.authorization?.transportPeerId && c.transportPeerId===this.options.authorization.transportPeerId))).length;
				if (peerCount >= (this.options.maxPendingPeer ?? 128)) throw new core.ResourceExhausted("too many pending operations for this peer");
			}
			const lim = core.limitsOf(s);
			const bound = lim.maxEntryBytes + 4 * lim.maxTypeChars * lim.maxTypes + 4096;
			const ad = claims.admit(s, now, o.request, method, core.plain(args), o.deadline ?? core.deadlineOf(now, timeout), bound);
			if (ad.kind === "pending") { this.authorizePending(s, o.request); core.settle(s, now); return core.plain(claims.lookup(s, o.request, now)); }
			if (ad.kind === "fresh") {
				this.claimMetadata(s,ad.key);
				if (o.deadline !== undefined && o.deadline < now) { claims.decide(s, now, ad.key, { state: "done", result: null }); return core.plain(claims.lookup(s, o.request, now)); }
				const p = core.probe(s, now, tmpl, o.txn ?? null, take, this.as);
				const miss = p.status !== "found" && (ad.deadline <= now || (ifExists && p.status === "none"));
				const result = p.status === "found" ? core.view(p.entry, s.spaceId) as unknown as Json : null;
				if (p.status === "found" || miss) {
					if (o.resultBudget !== undefined && Buffer.byteLength(JSON.stringify(result)) > o.resultBudget) throw new core.ResponseBudgetTooSmall(Buffer.byteLength(JSON.stringify(result)));
					claims.decide(s, now, ad.key, { state: "done", result });
				} else { core.parkOperation(s, ad.key, tmpl, take, o.txn ?? null, ad.deadline, ifExists, this.as); this.authorizePending(s, o.request); }
			}
			return core.plain(claims.lookup(s, o.request, now));
		}, this.ctx);
	}
	private claimMetadata(s:core.SpaceState,key:string):void { const a=this.options.authorization;if(a)claims.setMetadata(s,key,{policyVersion:a.policyVersion,transportPeerId:a.transportPeerId,routerEpoch:a.routerEpoch,controlPrimaryEpoch:a.controlPrimaryEpoch}); }

	private authorizePending(s: core.SpaceState, request: RequestRef): void {
		const a = this.options.authorization;
		if (!a) return;
		const key = claims.keyOf(s, request);
		for (const w of s.waiters) if (w.claimKey === key && a.canExecutePending(w.take ? "take" : "read", w.template)) { this.claimMetadata(s,key); w.authorizedUntil = a.validUntil; core.touch(s, this.now()); }
	}

	private async durableOperation(tmpl: Template, timeout: number, o: OpOptions, take: boolean, ifExists: boolean): Promise<Taken | null> {
		let value = await this.beginOperation(tmpl, timeout, o as OpOptions & { request: RequestRef }, take, ifExists);
		const watch = await this.watch();
		let wake: () => void = () => {}, dirty = false;
		watch?.start(async () => { dirty = true; wake(); });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			for (;;) {
				if (value.resultExpired) throw new claims.ResultExpired("the operation's retained result expired");
				if (value.error) throw value.error.code === "CompletionViolation" ? new core.CompletionViolation(value.error.message) : new core.TransactionError(value.error.message);
				if (value.state === "cancelled") throw new claims.OperationCancelled("the operation was cancelled");
				if (value.state === "done") { this.meter.inc(value.result === null ? "misses" : take ? "takes" : "reads"); return (value.result ?? null) as unknown as Taken | null; }
				if (!dirty) await awaitWithContext(new Promise<void>(res => { wake = res; timer = setTimeout(res, core.timerDelay(Math.min(1000, value.deadline - this.now()))); }), this.ctx);
				clearTimeout(timer); dirty = false;
				value = await this.pollOperation(o.request!);
			}
		} finally { clearTimeout(timer); await watch?.stop(); }
	}

	/** Drain due work in separate bounded commits before admitting another domain mutation. */
	private async maintain(): Promise<void> {
		for (;;) {
			const prior = await this.snap();
			if (!prior || !core.needsMaintenance(prior, this.now())) return;
			const signature = maintenanceSignature(prior);
			const outcome = await this.host.commit(async tx => {
				const s = await this.doc(tx); core.settle(s, this.now());
				return { more: core.needsMaintenance(s, this.now()), signature: maintenanceSignature(s) };
			}, this.ctx);
			if (outcome.more && outcome.signature === signature) throw new core.ResourceExhausted("a maintenance item cannot fit the configured commit budget");
		}
	}
}

const canonicalPrincipal = (p: Principal): string => JSON.stringify([p.peerId, p.agentId ?? null]);
const maintenanceSignature = (s: Readonly<core.SpaceState>): string => JSON.stringify([s.entries.length, Object.keys(s.txns).length, s.regs.length, s.waiters.length, core.revision(s), s.jobs?.map(j => [j.id, j.cursor, j.retryAt ?? 0]), s.releaseQueue, Object.values(s.mailboxes?.boxes ?? {}).map(b => [b.epoch, b.next, b.acked])]);
