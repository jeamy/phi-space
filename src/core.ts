// Pure JavaSpaces semantics (Jini JavaSpaces spec v2.2) over a plain JSON state. No pi imports.
// Functions mutate `state` in place (it is a document draft inside a commit) and take `now` explicitly.
import { collect, record, touch as touchStream, revisionOf, seal as sealStream, type Batch, type Op, type StreamState } from "./stream.ts";
import { canonicalJson } from "./canonical.ts";
import { sweep as sweepClaims, decide as decideClaim, type ClaimRec } from "./claims.ts";
import { bytePage } from "./paging.ts";
import { appendMail, assertMailboxCapacity, assertMailboxBatch, sweepMailboxes, type MailboxState } from "./mailbox.ts";
import type { Principal } from "./claims.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Fields = { [k: string]: Json };
/** Who receives events: a conversation id (a number in pi-durable; strings are tolerated for pure-core use). */
export type Target = string | number;

export const NO_WAIT = 0;
export const ANY = -1; // Lease.ANY: the space picks the duration
/** As a duration: never expires. As an absolute time (`expires`, `deadline`): never. */
export const FOREVER = Number.MAX_SAFE_INTEGER;
export const DEFAULT_LEASE_MS = 3600 * 1000;
/** setTimeout fires after 1 ms for longer delays; long waits sleep in chunks of this and look again. */
export const MAX_TIMER_MS = 2 ** 31 - 1;

/** Absolute time `ms` after `now`; FOREVER (or anything reaching it) stays FOREVER instead of overflowing. */
export const until = (now: number, ms: number): number => (ms >= FOREVER - now ? FOREVER : now + ms);
/** A setTimeout delay that neither overflows nor spins: at least 1 ms, at most MAX_TIMER_MS. */
export const timerDelay = (ms: number): number => Math.min(Math.max(1, ms), MAX_TIMER_MS);

/**
 * Quotas for conversations (host code, `as` undefined, is not limited). The defaults can be overridden per space with
 * `setLimits`, which stores them in the state.
 */
export type Limits = {
	maxEntryBytes: number; // JSON size of an entry's fields (and of a handback)
	maxTypeChars: number; // longest type name
	maxTypes: number; // type plus supertypes
	maxEntries: number; // entries in the whole space, so one busy agent cannot fill it for the others
	maxEntriesPerOwner: number;
	maxRegsPerOwner: number;
	maxWaitersPerOwner: number;
	maxTxnsPerOwner: number;
	maxSpaceBytes: number; // JSON bytes of all entries' fields together (also for host writes)
	notifyIntervalMs: number; // a conversation's subscription sends at most one event per interval (0: no limit)
	claimResultMs: number; // how long a decided request keeps its result (federation-plan-v3 6.2: 24 h to 7 days)
	generationAdmitMs: number; // how long a request generation admits new request ids
	maxClaimBytes: number; // JSON bytes of all request claims and generations; a fresh request is refused above it (AP 0.2)
	maxOutboxBytes: number; // JSON bytes of undelivered events; new subscriptions and waits are refused above it, no event is dropped
	maxDocBytes: number; // JSON bytes of the whole space: entries plus claims, outbox, waiters, registrations and transactions
	maxCommitBytes: number; // largest batch one commit may write (entry deltas, events, claim); must fit a frame with its envelope
	maxFrameBytes: number; // largest protocol frame (federation-plan-v3 4.2); pages and events must fit it with their overhead
	maxLogBytes: number; // JSON bytes of the retained change batches (revisions, AP 1.3); older batches are dropped
	maxEventBytes: number; // largest event (entry plus handback plus metadata); a write whose event could exceed it is refused first
	maxSnapshotBytes: number;
	maxSnapshots: number;
	snapshotTtlMs: number;
	maxMailboxBytes: number;
	mailboxTtlMs: number;
	maxJobBytes: number;
};
export const DEFAULT_LIMITS: Limits = { maxEntryBytes: 64 * 1024, maxTypeChars: 128, maxTypes: 16, maxEntries: 10_000, maxEntriesPerOwner: 1_000, maxRegsPerOwner: 20, maxWaitersPerOwner: 20, maxTxnsPerOwner: 20, maxSpaceBytes: 64 * 1024 * 1024, notifyIntervalMs: 1000, claimResultMs: 24 * 3600 * 1000, generationAdmitMs: 3600 * 1000, maxClaimBytes: 32 * 1024 * 1024, maxOutboxBytes: 8 * 1024 * 1024, maxDocBytes: 128 * 1024 * 1024, maxCommitBytes: 192 * 1024, maxFrameBytes: 256 * 1024, maxEventBytes: 160 * 1024, maxLogBytes: 4 * 1024 * 1024, maxSnapshotBytes: 64 * 1024 * 1024, maxSnapshots: 16, snapshotTtlMs: 60_000, maxMailboxBytes: 8 * 1024 * 1024, mailboxTtlMs: 7 * 24 * 3600 * 1000, maxJobBytes: 16 * 1024 * 1024 };
export class LimitError extends Error {}
/** A limit would be exceeded; raised before anything changed (federation-plan-v3 4.2 `ResourceExhausted`). */
export class ResourceExhausted extends LimitError {}
/** The byte budget of a page cannot hold the next whole element; nothing advanced. Retry with at least `requiredBytes`. */
export class ResponseBudgetTooSmall extends Error {
	requiredBytes: number; // (no parameter property: the code runs under node's strip-only TypeScript mode)
	constructor(requiredBytes: number) { super(`the next element needs ${requiredBytes} bytes of budget`); this.requiredBytes = requiredBytes; }
}
export class IllegalArgumentError extends Error {}
/** A conversation tried to use or change something that is not its own. */
export class PermissionError extends Error {}
export class TransactionError extends Error {}
export class CompletionViolation extends TransactionError {}
export class UnknownLeaseError extends Error {}

/** An entry: a typed group of fields. `types` is the type followed by its supertypes, fixed at write time. */
export type EntryDraft = { type: string; types?: string[]; fields: Fields };
/** A template: absent/null type and fields are wildcards. A null template (`null`) matches any entry. */
export type Template = { type?: string | null; fields?: Fields; id?: string | null } | null;

export type EntryRec = {
	id: string;
	type: string;
	types: string[];
	fields: Fields;
	expires: number;
	writtenUnder: string | null; // invisible outside this transaction until it commits
	takenBy: string | null; // locked against every other operation
	readBy: string[]; // others may read, but not take
	owner: Target | null; // who may renew/cancel its lease; null: host code only
	size?: number; // JSON bytes of `fields`, for the space-wide limit
};
/** `owner`: the only conversation that may use, commit, abort, renew or cancel it; null: host code only. */
export type TxnRec = { id: string; expires: number; owner: Target | null; reserved?: number; takenTasks?: Array<{ id: string; types: string[]; fields: Fields }> };
export type CompletionProfile = { taskType: string; resultTypes: string[]; equalFields: string[]; maxResultCount: number };
export type FanoutJob = { id: string; at: number; cursor: number; retryAt?: number; events: Array<{ event: SpaceEvent; consumer?: Principal }> };
export type RegRec = {
	id: string; // event id
	template: Template;
	expires: number;
	txn: string | null;
	handback: Json;
	target: Target | null; // conversation to notify (the "listener")
	seq: number; // last sequence number issued; strictly increasing
	// Rate limit for conversations: at most one event per `minIntervalMs`; writes in between are counted and sent as one
	// bundled event (count > 1) when the interval is over.
	minIntervalMs?: number;
	lastEventAt?: number;
	pending?: number;
	pendingEntry?: EntryView;
	consumer?: Principal;
};
/** A parked read/take for a conversation: served by the space when a match appears, instead of a blocked call. */
export type WaiterRec = { id: string; template: Template; take: boolean; target: Target | null; deadline: number; txnLeaseMs: number; handback: Json; claimKey?: string; requestTxn?: string | null; ifExists?: boolean; consumer?: Principal };
/** `owner`: who wrote it (a conversation id), or null for host code, so a reader can judge where content comes from. */
export type EntryView = { id: string; gid?: string; type: string; types: string[]; fields: Fields; owner: Target | null };
export type SpaceEvent = {
	kind: "entry" | "waiter" | "timeout" | "registrationClosed";
	eventId: string;
	seq: number;
	handback: Json;
	target: Target | null;
	entry?: EntryView; // for a bundled event: the latest of `count` matching writes
	count?: number; // writes this notify event stands for (> 1: bundled by the rate limit)
	tries?: number; // failed deliveries so far
	retryAt?: number; // not before this time (backoff after a failed delivery)
	txn?: string; // a served take-waiter holds the entry under this transaction until committed or its lease lapses
	reason?: "expired" | "cancelled" | "transactionEnded";
};
/** `returned`: entries given back by aborted or expired transactions, ever. Only changes in commits that change the
 * space anyway (a transaction ends), so keeping it durable wakes nobody. */
/**
 * `spaceId` (immutable) and `incarnation` (replaced by a restore) identify this space; both are set when the space is
 * registered (see `spaces.ts`), so a fresh document has neither. Local ids carry the incarnation: `e<incarnation>-<n>`.
 */
export type SpaceState = { nextId: number; entries: EntryRec[]; txns: Record<string, TxnRec>; regs: RegRec[]; waiters: WaiterRec[]; outbox: SpaceEvent[]; returned: number ; limits?: Partial<Limits>; spaceId?: string; incarnation?: string; rpc?: import("./claims.ts").RpcState; stream?: StreamState; completionProfiles?: CompletionProfile[]; mailboxes?: MailboxState; jobs?: FanoutJob[]; releaseQueue?: string[]; maintenance?: { at: number; cursor: string } };

export const initialState = (): SpaceState => ({ nextId: 1, entries: [], txns: {}, regs: [], waiters: [], outbox: [], returned: 0 });
export const migrate = (v: any, _from: number): SpaceState => {
	const d = initialState();
	return {
		nextId: v.nextId ?? d.nextId,
		entries: (v.entries ?? d.entries).map((e: any) => ({ ...e, types: e.types ?? [e.type], readBy: e.readBy ?? [], writtenUnder: e.writtenUnder ?? null, takenBy: e.takenBy ?? null, owner: e.owner ?? null })),
		txns: Object.fromEntries(Object.entries(v.txns ?? d.txns).map(([k, t]: [string, any]) => [k, { ...t, owner: t.owner ?? null }])),
		regs: (v.regs ?? d.regs).map((r: any) => ({ ...r, seq: r.seq ?? 0 })),
		waiters: v.waiters ?? d.waiters,
		outbox: v.outbox ?? d.outbox,
		...(v.limits ? { limits: v.limits } : {}),
		...(typeof v.spaceId === "string" ? { spaceId: v.spaceId } : {}),
		...(typeof v.incarnation === "string" ? { incarnation: v.incarnation } : {}),
		...(v.rpc ? { rpc: v.rpc } : {}), // request claims (claims.ts)
		...(v.stream ? { stream: v.stream } : {}), // revisions and change batches (stream.ts)
		...(v.completionProfiles ? { completionProfiles: v.completionProfiles } : {}),
		...(v.mailboxes ? { mailboxes: v.mailboxes } : {}),
		...(v.jobs ? { jobs: v.jobs } : {}),
		...(v.releaseQueue ? { releaseQueue: v.releaseQueue } : {}),
		...(v.maintenance ? { maintenance: v.maintenance } : {}),
		returned: v.returned ?? d.returned,
	};
};
export type Lease = { id: string; expires: number };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)); // draft proxies are not structured-cloneable
/** A plain copy of a value read from a document draft. Drafts are unusable once their commit settles, so anything a
 * commit returns that came from the document (a stored claim, for one) must be copied out inside the commit. */
export const plain = <T>(v: T): T => (v === undefined ? v : clone(v));
const encoder = new TextEncoder();
const jsonBytes = (v: unknown): number => encoder.encode(JSON.stringify(v) ?? "").length;
const commitBudgets = new WeakMap<object, { used: number }>();
export function seal(s: object): void { sealStream(s); commitBudgets.delete(s); }
/** Called once per storage transaction; all subsequent operations share its byte budget and revision. */
export function beginCommit(s: SpaceState): void { seal(s); commitBudgets.set(s, { used: 0 }); }
export function touch(s: SpaceState, now: number): void { touchStream(s, now, limitsOf(s).maxLogBytes); }
function charge(s: SpaceState, cost: number): void {
	const budget = commitBudgets.get(s);
	if (!budget) return;
	if (budget.used + cost + COMMIT_FIXED > limitsOf(s).maxCommitBytes) throw new ResourceExhausted("the atomic commit exceeds maxCommitBytes");
	budget.used += cost;
}
function canCharge(s: SpaceState, cost: number): boolean {
	const budget = commitBudgets.get(s);
	return !budget || budget.used + cost + COMMIT_FIXED <= limitsOf(s).maxCommitBytes;
}
function deferMaintenance(s: SpaceState, at: number, cursor: string): void { s.maintenance = { at, cursor }; }
/** Reserve one bounded maintenance mutation; persist continuation when the transaction is full. */
export function maintenanceStep(s: SpaceState, cost: number, now: number, cursor: string): boolean {
	if (!canCharge(s, cost)) { deferMaintenance(s, now, cursor); return false; }
	charge(s, cost); return true;
}
export const limitsOf = (s: Readonly<SpaceState>): Limits => ({ ...DEFAULT_LIMITS, ...(s.limits ?? {}) });
/** Override quotas for this space (host code). Values must be positive integers; omitted ones keep their value. */
export function setLimits(s: SpaceState, l: Partial<Limits>, now = Date.now()): Limits {
	for (const [k, v] of Object.entries(l)) {
		if (!(k in DEFAULT_LIMITS) || typeof v !== "number" || !Number.isInteger(v) || v < (k === "notifyIntervalMs" ? 0 : 1)) throw new IllegalArgumentError(`bad limit ${k}`);
	}
	const merged = { ...limitsOf(s), ...l };
	if (merged.mailboxTtlMs > 7 * 24 * 3600 * 1000) throw new IllegalArgumentError("mailbox TTL cannot exceed seven days");
	if (merged.maxCommitBytes + CHANGES_OVERHEAD > merged.maxFrameBytes) throw new IllegalArgumentError(`maxCommitBytes ${merged.maxCommitBytes} plus the envelope must fit maxFrameBytes ${merged.maxFrameBytes}`);
	for (const t of Object.values(s.txns)) if ((t.reserved ?? 0) + COMMIT_FIXED > merged.maxCommitBytes) throw new ResourceExhausted("the new limit would invalidate an existing transaction's completion reservation");
	if (merged.maxCommitBytes < COMMIT_FIXED + 128) throw new IllegalArgumentError("maxCommitBytes must allow the commit envelope and one maintenance item");
	if (jsonBytes(s.jobs ?? []) + Object.values(s.txns).reduce((n, t) => n + (t.reserved ?? 0), 0) > merged.maxJobBytes) throw new ResourceExhausted("the new job budget would invalidate completion storage reservations");
	s.limits = { ...(s.limits ?? {}), ...l };
	touch(s, now);
	return limitsOf(s);
}
const ownedBy = (as: Target) => (o: { owner: Target | null }) => o.owner === as;
/** Bytes of the parts of the document that are not entries (claims by their running tally). */
export function overheadBytes(s: Readonly<SpaceState>): number {
	return claimBytes(s) + (s.stream?.bytes ?? 0) + jsonBytes(s.outbox) + jsonBytes(s.waiters) + jsonBytes(s.regs) + jsonBytes(s.txns) + jsonBytes(s.jobs ?? []) + jsonBytes(s.mailboxes ?? {});
}
/** Claim and generation bytes: a running tally kept by claims.ts, computed once for states that predate it. */
export function claimBytes(s: Readonly<SpaceState>): number {
	const r = s.rpc;
	if (!r) return 0;
	if (r.bytes === undefined) return jsonBytes(r.claims) + jsonBytes(r.generations);
	return r.bytes + (r.reservedBytes ?? 0);
}
/**
 * An event carries the entry, a handback and metadata. A conservative bound (the largest handback of any registration or
 * wait, whether or not it matches) is checked before the write is accepted, so no event can exceed `maxEventBytes`.
 */
function checkEventSize(s: Readonly<SpaceState>, rec: EntryRec, lim: Limits): void {
	if (s.regs.length === 0 && s.waiters.length === 0) return;
	let handback = 0;
	for (const r of s.regs) handback = Math.max(handback, jsonBytes(r.handback));
	for (const w of s.waiters) handback = Math.max(handback, jsonBytes(w.handback));
	const bound = jsonBytes(view(rec, s.spaceId)) + handback + EVENT_OVERHEAD;
	if (bound > lim.maxEventBytes) throw new ResourceExhausted(`an event for this entry could take ${bound} bytes; the limit is ${lim.maxEventBytes}`);
}
const EVENT_OVERHEAD = 256; // kind, ids, sequence, target, count
const COMMIT_FIXED = 1024; // claim and result, batch envelope, bookkeeping of one commit

/**
 * A conservative bound of what making `e` visible writes: its stream operation plus one event for every registration and
 * wait that matches it now (subscriptions made later are not counted).
 */
function publishCost(s: Readonly<SpaceState>, e: EntryRec): number {
	const v = jsonBytes(view(e, s.spaceId));
	let n = jsonBytes(putOp(e)) + 1;
	for (const r of s.regs) if (matches(r.template, e)) n += v + jsonBytes(r.handback) + EVENT_OVERHEAD;
	for (const w of s.waiters) if (matches(w.template, e)) n += v + jsonBytes(w.handback) + EVENT_OVERHEAD;
	return n;
}
function refreshReservations(s: SpaceState, extra: { reg?: RegRec; waiter?: WaiterRec } = {}): Map<string, number> {
	const preview = { ...s, regs: extra.reg ? [...s.regs, extra.reg] : s.regs, waiters: extra.waiter ? [...s.waiters, extra.waiter] : s.waiters };
	const updated = new Map<string, number>();
	for (const t of Object.values(s.txns)) {
		let cost = 0;
		for (const e of s.entries) if ((e.writtenUnder === t.id && e.takenBy !== t.id) || (e.takenBy === t.id && e.writtenUnder !== t.id)) cost += publishCost(preview, e);
		for (const r of preview.regs) if (r.txn === t.id) cost += jsonBytes(r.handback) + 512;
		cost = Math.max(cost, t.reserved ?? 0);
		if (cost + COMMIT_FIXED > limitsOf(s).maxCommitBytes) throw new ResourceExhausted("the new subscription would invalidate a transaction's completion reservation");
		updated.set(t.id, cost);
	}
	if (jsonBytes(s.jobs ?? []) + [...updated.values()].reduce((n, cost) => n + cost, 0) > limitsOf(s).maxJobBytes) throw new ResourceExhausted("the new subscription exceeds reserved completion storage");
	return updated;
}
function queueEvent(s: SpaceState, now: number, event: SpaceEvent, consumer?: Principal, completing = false): void {
	if (jsonBytes(event) > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the event exceeds maxEventBytes");
	if (!completing) {
		if (s.jobs?.some(j => j.events.slice(j.cursor).some(x => consumer ? x.consumer && canonicalJson(x.consumer as unknown as Json) === canonicalJson(consumer as unknown as Json) : !x.consumer && x.event.target === event.target))) throw new ResourceExhausted("the consumer has a pending durable fanout backlog");
		if (consumer) appendMail(s, consumer, event, now);
		else {
			if (jsonBytes(s.outbox) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) throw new ResourceExhausted("the local outbox is full");
			s.outbox.push(event);
			touch(s, now);
		}
		return;
	}
	// Completion must not fail when a consumer is slow. Admission reserves durable storage for this captured event.
	if (!consumer && jsonBytes(s.outbox) + jsonBytes(event) + 1 <= limitsOf(s).maxOutboxBytes && !s.jobs?.some(j => j.events.slice(j.cursor).some(x => !x.consumer && x.event.target === event.target))) { s.outbox.push(clone(event)); touch(s, now); return; }
	s.jobs ??= [];
	s.jobs.push({ id: newId(s, "j"), at: now, cursor: 0, events: [{ event: clone(event), ...(consumer ? { consumer: { ...consumer } } : {}) }] });
	touch(s, now);
}
/** Resume fanout from durable cursors; a full consumer never loses an active take's result. */
function runJobs(s: SpaceState, now: number): void {
	for (const job of s.jobs ?? []) {
		if ((job.retryAt ?? 0) > now) continue;
		for (; job.cursor < job.events.length; job.cursor++) {
			const { event, consumer } = job.events[job.cursor]!;
			try {
				if (consumer) assertMailboxCapacity(s, consumer, event, now);
				else if (jsonBytes(s.outbox) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) { job.retryAt = coreJobRetry(now); break; }
				if (!canCharge(s, jsonBytes(event) + EVENT_OVERHEAD)) { deferMaintenance(s, now, job.id); return; }
				charge(s, jsonBytes(event) + EVENT_OVERHEAD);
				if (consumer) appendMail(s, consumer, event, now); else s.outbox.push(clone(event));
				touch(s, now);
				delete job.retryAt;
			} catch (e) { if (e instanceof ResourceExhausted) { job.retryAt = coreJobRetry(now); break; } throw e; }
		}
	}
	if (s.jobs) prune(s.jobs, j => j.cursor === j.events.length);
}
const coreJobRetry = (now: number) => until(now, 1000);
/**
 * Reserve room for the commit that makes an entry visible (txn null: this very commit) or for completing `txn` either
 * way, before the mutation. Over the budget the request fails with ResourceExhausted and nothing has changed, so what a
 * transaction already holds can always still be committed or aborted: completion itself never checks a limit.
 */
function reserve(s: SpaceState, txn: string | null, cost: number, lim: Limits): void {
	const t = txn === null ? undefined : s.txns[txn];
	const have = t?.reserved ?? 0;
	if (have + cost + COMMIT_FIXED > lim.maxCommitBytes) throw new ResourceExhausted(`${txn === null ? "this commit" : `completing transaction ${txn}`} could write ${have + cost + COMMIT_FIXED} bytes; the limit is ${lim.maxCommitBytes}`);
	const obligations = Object.values(s.txns).reduce((n, t) => n + (t.reserved ?? 0), 0);
	if (jsonBytes(s.jobs ?? []) + obligations + cost > lim.maxJobBytes) throw new ResourceExhausted("the durable completion backlog is full");
	if (t) t.reserved = have + cost;
	else charge(s, cost);
}

/** Backpressure: while undelivered events exceed the budget, nothing new is subscribed (no event is ever dropped). */
function checkOutbox(s: Readonly<SpaceState>): void {
	const lim = limitsOf(s);
	if (s.outbox.length > 0 && jsonBytes(s.outbox) > lim.maxOutboxBytes) throw new LimitError(`${lim.maxOutboxBytes} bytes of events wait for delivery; try again later`);
}

function checkSize(what: string, v: unknown, lim: Limits): void {
	const n = jsonBytes(v);
	if (n > lim.maxEntryBytes) throw new LimitError(`${what} is ${n} bytes; the limit is ${lim.maxEntryBytes}`);
}
// Ids of an incarnation never repeat (the counter only grows) and never collide with another incarnation's. Ids written
// before the space had an incarnation keep their old form `e<n>`.
const peekId = (s: SpaceState, p: string) => (s.incarnation ? `${p}${s.incarnation}-${s.nextId}` : `${p}${s.nextId}`);
const newId = (s: SpaceState, p: string) => { const id = peekId(s, p); s.nextId++; return id; };
/** Global id of a local entry id in space `spaceId`: `<spaceId>/<localId>`. */
export const gidOf = (spaceId: string, id: string): string => `${spaceId}/${id}`;

/** Leases are granted as requested: FOREVER (or Infinity) never expires, ANY gets the default. */
function grant(requested: number, now: number): number {
	if (typeof requested !== "number" || Number.isNaN(requested)) throw new IllegalArgumentError("bad lease");
	if (requested < 0 && requested !== ANY) throw new IllegalArgumentError("negative lease");
	return until(now, requested === ANY ? DEFAULT_LEASE_MS : requested);
}
/** A timeout (duration) into an absolute deadline; FOREVER (or Infinity) never passes. */
export function deadlineOf(now: number, timeout: number): number {
	if (typeof timeout !== "number" || Number.isNaN(timeout)) throw new IllegalArgumentError("bad timeout");
	if (timeout < 0) throw new IllegalArgumentError("negative timeout");
	return until(now, timeout);
}

export function deepEqual(a: Json, b: Json): boolean {
	if (a === b) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]!));
	const ka = Object.keys(a);
	const kb = Object.keys(b as object);
	return ka.length === kb.length && ka.every((k) => k in (b as object) && deepEqual((a as Fields)[k]!, (b as Fields)[k]!));
}

export function matches(t: Template, e: { id?: string; types: string[]; fields: Fields }): boolean {
	if (t === null) return true;
	if (t.id != null && t.id !== e.id) return false; // exact entry id
	if (t.type != null && !e.types.includes(t.type)) return false; // subtype matching
	for (const [k, v] of Object.entries(t.fields ?? {})) {
		if (v == null) continue; // wildcard (null or undefined); you cannot search for a null field (as in Jini)
		if (!(k in e.fields) || !deepEqual(v, e.fields[k]!)) return false;
	}
	return true;
}

/**
 * Drop expired entries and registrations, abort expired transactions and time out waiters. Every operation starts with
 * this. Lapses are replayed in time order, so when nobody looked for a while the outcome is still what it would have
 * been at each moment: an entry returned by a transaction that expired before a waiter's deadline serves that waiter.
 */
export function settle(s: SpaceState, now: number): void {
	const ownBudget = !commitBudgets.has(s);
	if (ownBudget) commitBudgets.set(s, { used: 0 });
	try { settleBatch(s, now); } finally { if (ownBudget) commitBudgets.delete(s); }
}
function settleBatch(s: SpaceState, now: number): void {
	delete s.maintenance;
	sweepClaims(s, now);
	sweepMailboxes(s, now);
	for (const id of [...(s.releaseQueue ?? [])]) {
		const t = s.txns[id];
		if (t) {
			if (!canCharge(s, t.reserved ?? 0)) { deferMaintenance(s, now, id); return; }
			charge(s, t.reserved ?? 0); finish(s, id, false, now);
		}
		prune(s.releaseQueue!, x => x === id);
	}
	for (;;) {
		let t: TxnRec | undefined;
		for (const x of Object.values(s.txns)) if (x.expires <= now && (t === undefined || x.expires < t.expires)) t = x;
		if (t === undefined) break;
		const at = t.expires;
		if (!expire(s, at)) return;
		if (!canCharge(s, t.reserved ?? 0)) { deferMaintenance(s, now, t.id); return; }
		charge(s, t.reserved ?? 0);
		finish(s, t.id, false, at);
		serve(s, at); // the abort may have returned entries that a waiter is waiting for
	}
	if (!expire(s, now)) return;
	serve(s, now);
	flushRegs(s, now);
	runJobs(s, now);
}
/**
 * Remove the items `drop` selects, in place and only where there are any. Assigning a new array to a document draft
 * records the whole array as the commit's change: with many entries every commit would store the entire space.
 */
function prune<T>(a: T[], drop: (x: T) => boolean): number {
	let n = 0;
	for (let i = a.length - 1; i >= 0; i--) if (drop(a[i]!)) { a.splice(i, 1); n++; }
	return n;
}
function expire(s: SpaceState, at: number): boolean {
	for (const e of [...s.entries].filter(e => e.expires <= at).sort((a, b) => a.expires - b.expires || a.id.localeCompare(b.id))) {
		if (!canCharge(s, 128)) { deferMaintenance(s, at, e.id); return false; }
		charge(s, 128);
		if (e.writtenUnder === null && e.takenBy === null) logDel(s, at, e.id);
		s.entries.splice(s.entries.indexOf(e), 1);
		touch(s, at);
	}
	for (const r of [...s.regs].filter(r => r.expires <= at).sort((a, b) => a.expires - b.expires || a.id.localeCompare(b.id))) {
		const cost = jsonBytes(r.handback) + (r.pendingEntry ? jsonBytes(r.pendingEntry) : 0) + 512;
		if (!canCharge(s, cost)) { deferMaintenance(s, at, r.id); return false; }
		charge(s, cost);
		if (r.pending && r.pendingEntry) emit(s, r, r.pendingEntry, r.pending, at, true);
		if (r.consumer) queueEvent(s, at, { kind: "registrationClosed", eventId: r.id, seq: ++r.seq, handback: r.handback, target: r.target, reason: "expired" }, r.consumer, true);
		s.regs.splice(s.regs.indexOf(r), 1);
		touch(s, at);
	}
	for (const w of [...s.waiters].filter(w => w.deadline <= at).sort((a, b) => a.deadline - b.deadline || a.id.localeCompare(b.id))) {
		const cost = jsonBytes(w.handback) + 256;
		if (!canCharge(s, cost)) { deferMaintenance(s, at, w.id); return false; }
		charge(s, cost);
		if (w.claimKey) { if (s.rpc?.claims[w.claimKey]?.state === "pending") decideClaim(s, at, w.claimKey, { state: "done", result: null }); }
		else queueEvent(s, at, { kind: "timeout", eventId: w.id, seq: 1, handback: w.handback, target: w.target }, w.consumer, true);
		s.waiters.splice(s.waiters.indexOf(w), 1);
		touch(s, at);
	}
	return true;
}

/**
 * `as` is the conversation acting. Omitted (host code), nothing is checked. Given, it may only use transactions and
 * leases it owns (never ownerless ones: those are the host's), it owns what it creates, and the limits apply.
 */
export function write(s: SpaceState, now: number, entry: EntryDraft, txn: string | null, lease: number, as?: Target): Lease {
	settle(s, now);
	if (typeof entry?.type !== "string" || entry.type === "") throw new IllegalArgumentError("entry needs a type");
	if (entry.fields === null || typeof entry.fields !== "object" || Array.isArray(entry.fields)) throw new IllegalArgumentError("entry fields must be an object");
	if (txn !== null) requireTxn(s, txn, as);
	const expires = grant(lease, now);
	if (as !== undefined) {
		const lim = limitsOf(s);
		if (entry.type.length > lim.maxTypeChars) throw new LimitError(`type name longer than ${lim.maxTypeChars} characters`);
		if ((entry.types?.length ?? 0) + 1 > lim.maxTypes) throw new LimitError(`more than ${lim.maxTypes} types`);
		for (const t of entry.types ?? []) if (typeof t !== "string" || t.length > lim.maxTypeChars) throw new LimitError("bad or too long supertype name");
		checkSize("entry", entry.fields, lim);
		if (s.entries.length >= lim.maxEntries) throw new LimitError(`the space holds ${lim.maxEntries} entries already`);
		if (s.entries.filter(ownedBy(as)).length >= lim.maxEntriesPerOwner) throw new LimitError(`you already have ${lim.maxEntriesPerOwner} entries in the space`);
	}
	const types = [...new Set([entry.type, ...(entry.types ?? [])])]; // the type first, no duplicates
	const rec: EntryRec = {
		id: peekId(s, "e"),
		type: entry.type,
		types,
		fields: clone(entry.fields),
		expires,
		writtenUnder: txn,
		takenBy: null,
		readBy: [],
		owner: as ?? null,
	};
	rec.size = jsonBytes(entry.fields);
	const lim = limitsOf(s);
	let used = rec.size;
	for (const e of s.entries) used += e.size ?? jsonBytes(e.fields);
	if (used > lim.maxSpaceBytes) throw new LimitError(`the space would exceed ${lim.maxSpaceBytes} bytes`);
	if (used + overheadBytes(s) > lim.maxDocBytes) throw new LimitError(`the space document would exceed ${lim.maxDocBytes} bytes`);
	if (expires <= now) { s.nextId++; touch(s, now); return { id: rec.id, expires }; }
	checkEventSize(s, rec, lim);
	preflightFanout(s, rec, txn, now);
	if (!canCharge(s, jsonBytes(rec) + (txn === null ? publishCost(s, rec) : 0))) throw new ResourceExhausted("the write exceeds the remaining commit budget");
	reserve(s, txn, publishCost(s, rec), lim); // before any change: a refusal leaves everything as it was
	charge(s, jsonBytes(rec));
	s.nextId++;
	s.entries.push(rec);
	touch(s, now);
	if (txn === null) logPut(s, now, rec); // visible at once; under a transaction it appears at commit
	notifyWrite(s, rec, txn, now);
	if (txn === null) serve(s, now);
	return { id: rec.id, expires };
}

function preflightFanout(s: SpaceState, rec: EntryRec, txn: string | null, now: number): void {
	const consumers = new Map<string, { principal: Principal; events: SpaceEvent[] }>();
	const local: SpaceEvent[] = [];
	const add = (event: SpaceEvent, consumer?: Principal) => {
		if (jsonBytes(event) > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the event exceeds maxEventBytes");
		if (consumer) { const key = canonicalJson(consumer as unknown as Json); let group = consumers.get(key); if (!group) { group = { principal: consumer, events: [] }; consumers.set(key, group); } group.events.push(event); }
		else local.push(event);
	};
	for (const r of s.regs) if ((txn === null || r.txn === txn) && matches(r.template, rec)) add({ kind: "entry", eventId: r.id, seq: r.seq + 1, handback: r.handback, target: r.target, entry: view(rec, s.spaceId) }, r.consumer);
	if (txn === null) for (const w of s.waiters) if (!w.claimKey && matches(w.template, rec)) add({ kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(rec, s.spaceId) }, w.consumer);
	for (const group of consumers.values()) assertMailboxBatch(s, group.principal, group.events, now);
	if (jsonBytes(s.outbox) + local.reduce((n, e) => n + jsonBytes(e) + 1, 0) > limitsOf(s).maxOutboxBytes) throw new ResourceExhausted("the local outbox cannot hold this fanout");
}

// Registrations fire for committed writes (null-txn registrations) and, for a registration made under transaction
// T, also for writes under T. A null-txn registration does not see an entry written and taken inside one transaction.
function emit(s: SpaceState, r: RegRec, e: EntryView, count: number, now: number, completing = false): void {
	r.seq++;
	r.lastEventAt = now;
	r.pending = 0;
	delete r.pendingEntry;
	queueEvent(s, now, { kind: "entry", eventId: r.id, seq: r.seq, handback: r.handback, target: r.target, entry: e, ...(count > 1 ? { count } : {}) }, r.consumer, completing);
}
// The interval is read from the limits when needed, so changing it also affects existing subscriptions.
const intervalOf = (s: Readonly<SpaceState>, r: RegRec): number => (r.minIntervalMs ? limitsOf(s).notifyIntervalMs : 0);
function notifyWrite(s: SpaceState, e: EntryRec, txn: string | null, now: number, completing = false): void {
	for (const r of s.regs) {
		// Spec: a registration under T is notified of writes under T *in addition to* those a null-txn registration gets.
		const applies = txn === null ? true : r.txn === txn;
		if (!applies || !matches(r.template, e)) continue;
		if (intervalOf(s, r) && r.lastEventAt !== undefined && now < r.lastEventAt + intervalOf(s, r)) {
			r.pending = (r.pending ?? 0) + 1; // too soon after the last event: counted, sent bundled later
			r.pendingEntry = view(e, s.spaceId);
			continue;
		}
		emit(s, r, view(e, s.spaceId), 1 + (r.pending ?? 0), now, completing); // pending writes (if any) ride along with this one
	}
}
/** Send the bundled event for registrations whose interval is over. */
function flushRegs(s: SpaceState, now: number): void {
	for (const r of s.regs) {
		if (r.pending && r.pendingEntry && r.lastEventAt !== undefined && now >= r.lastEventAt + intervalOf(s, r)) emit(s, r, r.pendingEntry, r.pending, now);
	}
}

export type Probe = { status: "found"; entry: EntryRec } | { status: "none" } | { status: "locked" };

/** One non-waiting attempt. `locked` means matches exist, but every one conflicts with another transaction. */
export function probe(s: SpaceState, now: number, tmpl: Template, txn: string | null, take: boolean, as?: Target): Probe {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn, as);
	const f = find(s, tmpl, txn, take);
	if (f.status === "found" && take && txn === null && (s.completionProfiles ?? []).some(p => f.rec.types.includes(p.taskType))) throw new CompletionViolation("profiled tasks must be taken under a transaction");
	if (f.status === "found" && take && txn !== null && f.rec.writtenUnder !== txn) reserve(s, txn, publishCost(s, f.rec), limitsOf(s)); // an abort puts it back
	return f.status === "found" ? { status: "found", entry: apply(s, now, f.rec, txn, take) } : f;
}

/** What callers see of an entry. With the space's id it also carries the global id. */
export const view = (e: EntryRec, spaceId?: string): EntryView => ({ id: e.id, ...(spaceId ? { gid: gidOf(spaceId, e.id) } : {}), type: e.type, types: [...e.types], fields: clone(e.fields), owner: e.owner });

function find(s: SpaceState, tmpl: Template, txn: string | null, take: boolean): { status: "found"; rec: EntryRec } | { status: "none" } | { status: "locked" } {
	let locked = false;
	for (const e of s.entries) {
		if (!matches(tmpl, e)) continue;
		const mine = txn !== null && e.writtenUnder === txn;
		if (e.writtenUnder !== null && !mine) continue; // not yet committed elsewhere: invisible, not a conflict
		if (e.takenBy !== null) {
			if (e.takenBy !== txn) locked = true; // taken by another txn: may come back on abort
			continue;
		}
		if (take && e.readBy.some((t) => t !== txn)) { locked = true; continue; }
		return { status: "found", rec: e };
	}
	return locked ? { status: "locked" } : { status: "none" };
}

function apply(s: SpaceState, now: number, e: EntryRec, txn: string | null, take: boolean): EntryRec {
	const copy = clone(e);
	if (take) {
		const profiles = (s.completionProfiles ?? []).filter(p => e.types.includes(p.taskType));
		if (profiles.length) {
			if (txn === null) throw new CompletionViolation("profiled tasks must be taken under a transaction");
			const fields: Fields = {};
			for (const p of profiles) for (const name of p.equalFields) if (Object.hasOwn(e.fields, name)) fields[name] = clone(e.fields[name]!);
			const capture = { id: e.id, types: [...e.types], fields };
			reserve(s, txn, jsonBytes(capture) + 64, limitsOf(s));
			s.txns[txn]!.takenTasks ??= []; s.txns[txn]!.takenTasks!.push(capture);
		}
		if (e.writtenUnder === null) logDel(s, now, e.id); // it stops being visible (taken, or locked by a transaction)
		touch(s, now);
		if (txn === null || e.writtenUnder === txn) s.entries.splice(s.entries.indexOf(e), 1); // gone, or never visible outside
		else e.takenBy = txn;
	} else if (txn !== null && !e.readBy.includes(txn)) { e.readBy.push(txn); touch(s, now); }
	return copy;
}

export function createTxn(s: SpaceState, now: number, lease: number, as?: Target): Lease {
	settle(s, now);
	if (as !== undefined && Object.values(s.txns).filter(ownedBy(as)).length >= limitsOf(s).maxTxnsPerOwner) throw new LimitError(`you already have ${limitsOf(s).maxTxnsPerOwner} open transactions`);
	const t: TxnRec = { id: newId(s, "t"), expires: grant(lease, now), owner: as ?? null };
	s.txns[t.id] = t;
	touch(s, now);
	return { id: t.id, expires: t.expires };
}
// Host code (`as` undefined) may touch anything. A conversation only what it owns: ownerless things (written or
// created by host code) are the host's, so an agent can use neither their leases nor their transactions.
const mayUse = (owner: Target | null, as: Target | undefined) => as === undefined || (owner !== null && owner === as);
const requireTxn = (s: SpaceState, id: string, as?: Target) => {
	const t = s.txns[id];
	if (!t) throw new TransactionError(`transaction ${id} is not active`);
	if (!mayUse(t.owner, as)) throw new PermissionError(`transaction ${id} belongs to another conversation`);
};
export function setCompletionProfiles(s: SpaceState, profiles: CompletionProfile[], now = Date.now()): void {
	if (Object.keys(s.txns).length) throw new TransactionError("configure completion profiles before opening transactions");
	const seen = new Set<string>();
	for (const p of profiles) {
		if (!p || typeof p.taskType !== "string" || !p.taskType || seen.has(p.taskType) || !Array.isArray(p.resultTypes) || !p.resultTypes.length || !p.resultTypes.every(t => typeof t === "string" && t.length > 0) || !Array.isArray(p.equalFields) || !p.equalFields.every(f => typeof f === "string" && f.length > 0) || !Number.isSafeInteger(p.maxResultCount) || p.maxResultCount < 1) throw new IllegalArgumentError("invalid completion profile");
		seen.add(p.taskType);
	}
	s.completionProfiles = clone(profiles);
	touch(s, now);
}
function checkCompletion(s: SpaceState, id: string): void {
	for (const p of s.completionProfiles ?? []) {
		const tasks = (s.txns[id]?.takenTasks ?? s.entries.filter(e => e.takenBy === id)).filter(e => e.types.includes(p.taskType));
		const assigned = new Set<string>();
		for (const task of tasks) {
			const results = s.entries.filter(e => e.writtenUnder === id && e.takenBy === null && !assigned.has(e.id) && e.types.some(t => p.resultTypes.includes(t)) && p.equalFields.every(f => Object.hasOwn(task.fields, f) && Object.hasOwn(e.fields, f) && canonicalJson(task.fields[f]!) === canonicalJson(e.fields[f]!)));
			if (!results.length || results.length > p.maxResultCount) throw new CompletionViolation(`task ${task.id} needs 1..${p.maxResultCount} matching results in transaction ${id}`);
			for (const r of results) assigned.add(r.id);
		}
	}
}
export const commitTxn = (s: SpaceState, now: number, id: string, as?: Target) => { settle(s, now); requireTxn(s, id, as); checkCompletion(s, id); charge(s, s.txns[id]!.reserved ?? 0); finish(s, id, true, now); serve(s, now); };
export const abortTxn = (s: SpaceState, now: number, id: string, as?: Target) => { settle(s, now); requireTxn(s, id, as); charge(s, s.txns[id]!.reserved ?? 0); finish(s, id, false, now); serve(s, now); };
/** Abort `id` if it is still active (host side, e.g. when the holder of a served take can no longer be reached). */
export function releaseTxn(s: SpaceState, now: number, id: string): boolean {
	settle(s, now);
	if (!s.txns[id]) return false;
	if (!canCharge(s, s.txns[id]!.reserved ?? 0)) {
		s.releaseQueue ??= []; if (!s.releaseQueue.includes(id)) s.releaseQueue.push(id);
		deferMaintenance(s, now, id); touch(s, now); return true;
	}
	charge(s, s.txns[id]!.reserved ?? 0);
	finish(s, id, false, now);
	serve(s, now);
	return true;
}

/** Park a read/take for `target`; the space serves it later (or reports a timeout) through the outbox. */
export function addWaiter(s: SpaceState, now: number, w: { template: Template; take: boolean; target: Target | null; timeout: number; txnLeaseMs?: number; handback?: Json; as?: Target; consumer?: Principal }): string {
	const deadline = deadlineOf(now, w.timeout); // FOREVER: waits until served or cancelled
	settle(s, now);
	if (w.as !== undefined) {
		const lim = limitsOf(s);
		if (s.waiters.filter((x) => x.target === w.as).length >= lim.maxWaitersPerOwner) throw new LimitError(`you already have ${lim.maxWaitersPerOwner} waits`);
		checkSize("handback", w.handback ?? null, lim);
	}
	checkOutbox(s);
	if (jsonBytes(w.handback ?? null) + EVENT_OVERHEAD > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the wait's metadata exceeds maxEventBytes");
	const txnLeaseMs = grant(w.txnLeaseMs ?? ANY, now) - now; // same rules as every other lease: ANY, FOREVER, no negatives
	const rec: WaiterRec = { id: newId(s, "w"), template: w.template, take: w.take, target: w.target, deadline, txnLeaseMs, handback: w.handback ?? null, ...(w.consumer ? { consumer: { ...w.consumer } } : {}) };
	const updated = refreshReservations(s, { waiter: rec });
	for (const e of s.entries) if (matches(rec.template, e) && jsonBytes(view(e, s.spaceId)) + jsonBytes(rec.handback) + EVENT_OVERHEAD > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the wait would create an oversized event");
	s.waiters.push(rec);
	touch(s, now);
	for (const [id, cost] of updated) s.txns[id]!.reserved = cost;
	serve(s, now);
	return rec.id;
}
export function cancelWaiter(s: SpaceState, id: string, now = Date.now()): boolean {
	const w = s.waiters.find(w => w.id === id);
	if (w?.claimKey && s.rpc?.claims[w.claimKey]?.state === "pending") decideClaim(s, now, w.claimKey, { state: "cancelled" });
	if (w) touch(s, now);
	return prune(s.waiters, (w) => w.id === id) > 0;
}

// A take-waiter takes its entry under a fresh transaction, so a lost delivery is not a lost job: the entry returns
// when that transaction's lease lapses unless the receiver commits it.
function serve(s: SpaceState, now: number): void {
	for (const w of [...s.waiters]) {
		if (w.claimKey) {
			const claim = s.rpc?.claims[w.claimKey];
			if (!claim || claim.state !== "pending") { s.waiters.splice(s.waiters.indexOf(w), 1); continue; }
			const txn = w.requestTxn ?? null;
			if (txn !== null && !active(s, txn, now)) {
				decideClaim(s, now, w.claimKey, { state: "done", result: null, error: { code: "TransactionError", message: `transaction ${txn} is not active` } });
				s.waiters.splice(s.waiters.indexOf(w), 1); continue;
			}
			const found = find(s, w.template, txn, w.take);
			const miss = found.status !== "found" && (w.deadline <= now || (w.ifExists && found.status === "none"));
			if (found.status === "found") {
				if (w.take && txn === null && (s.completionProfiles ?? []).some(p => found.rec.types.includes(p.taskType))) {
					decideClaim(s, now, w.claimKey, { state: "done", result: null, error: { code: "CompletionViolation", message: "profiled tasks require a transaction" } });
					s.waiters.splice(s.waiters.indexOf(w), 1); continue;
				}
				const cost = jsonBytes(view(found.rec, s.spaceId)) + 256;
				if (!canCharge(s, cost)) { deferMaintenance(s, now, w.id); continue; }
				charge(s, cost);
				if (w.take && txn !== null && found.rec.writtenUnder !== txn) reserve(s, txn, publishCost(s, found.rec), limitsOf(s));
				decideClaim(s, now, w.claimKey, { state: "done", result: view(apply(s, now, found.rec, txn, w.take), s.spaceId) as unknown as Json });
			} else if (miss) decideClaim(s, now, w.claimKey, { state: "done", result: null });
			else continue;
			s.waiters.splice(s.waiters.indexOf(w), 1); continue;
		}
		const f = find(s, w.template, null, w.take);
		if (f.status !== "found") continue;
		const event: SpaceEvent = { kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(f.rec, s.spaceId) };
		if (!canCharge(s, jsonBytes(event) + 256)) { deferMaintenance(s, now, w.id); continue; }
		try {
			if (w.consumer) assertMailboxCapacity(s, w.consumer, event, now);
			else if (jsonBytes(s.outbox) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) continue;
		} catch (e) { if (e instanceof ResourceExhausted) continue; throw e; }
		charge(s, jsonBytes(event) + 256);
		s.waiters.splice(s.waiters.indexOf(w), 1);
		if (!w.take) { queueEvent(s, now, event, w.consumer); continue; }
		const t: TxnRec = { id: newId(s, "t"), expires: until(now, w.txnLeaseMs), owner: w.target }; // the receiver commits it
		s.txns[t.id] = t;
		reserve(s, t.id, publishCost(s, f.rec), limitsOf(s));
		queueEvent(s, now, { ...event, entry: view(apply(s, now, f.rec, t.id, true), s.spaceId), txn: t.id }, w.consumer);
	}
}

/** Durable execution state for a blocking RPC. Its claim stores only the argument hash; this is an ordinary waiter. */
export function parkOperation(s: SpaceState, key: string, tmpl: Template, take: boolean, txn: string | null, deadline: number, ifExists: boolean, owner?: Target): void {
	if (s.waiters.some(w => w.claimKey === key)) return;
	s.waiters.push({ id: newId(s, "w"), template: clone(tmpl), take, target: owner ?? null, deadline, txnLeaseMs: 0, handback: null, claimKey: key, requestTxn: txn, ifExists });
	touch(s, Date.now());
}

function finish(s: SpaceState, id: string, commit: boolean, now: number): void {
	touch(s, now);
	delete s.txns[id];
	for (const r of s.regs) if (r.txn === id && r.consumer) queueEvent(s, now, { kind: "registrationClosed", eventId: r.id, seq: ++r.seq, handback: r.handback, target: r.target, reason: "transactionEnded" }, r.consumer, true);
	prune(s.regs, (r) => r.txn === id); // registrations under a txn are dropped when it completes
	const published: EntryRec[] = [];
	for (let i = s.entries.length - 1; i >= 0; i--) { // backwards: removals do not shift what is still to visit
		const e = s.entries[i]!;
		if (e.readBy.includes(id)) prune(e.readBy, (t) => t === id);
		if (commit) {
			if (e.takenBy === id) { s.entries.splice(i, 1); continue; } // removal commits (also covers written-and-taken)
			if (e.writtenUnder === id) { e.writtenUnder = null; published.push(e); }
		} else {
			if (e.writtenUnder === id) { s.entries.splice(i, 1); continue; } // aborted writes are discarded
			if (e.takenBy === id) { e.takenBy = null; s.returned = (s.returned ?? 0) + 1; if (e.writtenUnder === null) logPut(s, now, e); } // takes are undone: the entry is back
		}
	}
	published.reverse(); // announced in write order
	for (const e of published) { logPut(s, now, e); notifyWrite(s, e, null, now, true); }
}

export function notify(s: SpaceState, now: number, tmpl: Template, txn: string | null, lease: number, handback: Json, target: Target | null, as?: Target, consumer?: Principal): { eventId: string; lease: Lease } {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn, as);
	if (as !== undefined) {
		const lim = limitsOf(s);
		if (s.regs.filter((x) => x.target === as).length >= lim.maxRegsPerOwner) throw new LimitError(`you already have ${lim.maxRegsPerOwner} subscriptions`);
		checkSize("handback", handback, lim);
		// "Everything" is a firehose: every write anywhere would wake this conversation.
		if (tmpl === null || (tmpl.type == null && !Object.values(tmpl.fields ?? {}).some((v) => v != null))) throw new IllegalArgumentError("a subscription needs a type or at least one field");
	}
	checkOutbox(s);
	if (jsonBytes(handback) + EVENT_OVERHEAD > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the subscription's metadata exceeds maxEventBytes");
	const r: RegRec = { id: newId(s, "n"), template: tmpl, expires: grant(lease, now), txn, handback, target, seq: 0, ...(consumer ? { consumer: { ...consumer } } : {}) };
	const updated = refreshReservations(s, { reg: r });
	for (const e of s.entries) if (matches(tmpl, e) && jsonBytes(view(e, s.spaceId)) + jsonBytes(handback) + EVENT_OVERHEAD > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the subscription would create an oversized event");
	if (as !== undefined && limitsOf(s).notifyIntervalMs > 0) r.minIntervalMs = limitsOf(s).notifyIntervalMs;
	s.regs.push(r);
	touch(s, now);
	for (const [id, cost] of updated) s.txns[id]!.reserved = cost;
	return { eventId: r.id, lease: { id: r.id, expires: r.expires } };
}

/** The leased thing behind `id` (a wait's deadline behaves like a lease), checked against `as`. */
function leased(s: SpaceState, id: string, as: Target | undefined): { set(v: number): void; waiter: boolean } {
	const w = s.waiters.find((x) => x.id === id);
	const e = s.entries.find((x) => x.id === id);
	const t = s.txns[id] as TxnRec | undefined;
	const r = s.regs.find((x) => x.id === id);
	const l = w ? { owner: w.target, set: (v: number) => { w.deadline = v; }, waiter: true }
		: e ? { owner: e.owner, set: (v: number) => { e.expires = v; }, waiter: false }
		: t ? { owner: t.owner, set: (v: number) => { t.expires = v; }, waiter: false }
		: r ? { owner: r.target, set: (v: number) => { r.expires = v; }, waiter: false }
		: undefined;
	if (!l) throw new UnknownLeaseError(id);
	if (!mayUse(l.owner, as)) throw new PermissionError(`lease ${id} belongs to another conversation`);
	return l;
}
export function renew(s: SpaceState, now: number, id: string, ms: number, as?: Target): number {
	settle(s, now);
	const l = leased(s, id, as);
	const v = grant(ms, now);
	l.set(v);
	touch(s, now);
	const e = s.entries.find((x) => x.id === id);
	if (e && e.writtenUnder === null && e.takenBy === null) logPut(s, now, e); // the lease is part of the visible state
	return v;
}
export function cancel(s: SpaceState, now: number, id: string, as?: Target): void {
	settle(s, now);
	const l = leased(s, id, as);
	if (l.waiter) { cancelWaiter(s, id, now); return; } // cancelled waits send no timeout event
	const reg = s.regs.find((x) => x.id === id);
	if (reg) {
		reg.pending = 0; delete reg.pendingEntry;
		if (reg.consumer) queueEvent(s, now, { kind: "registrationClosed", eventId: reg.id, seq: ++reg.seq, handback: reg.handback, target: reg.target, reason: "cancelled" }, reg.consumer, true);
		prune(s.regs, r => r.id === id); return;
	}
	l.set(now); // settle() removes it; a cancelled txn lease aborts the transaction
	settle(s, now);
}

/** Earliest time something can change without a commit (lease expiry); the waiter must wake then. */
export function nextExpiry(s: Readonly<SpaceState>): number {
	let min = FOREVER; // loops, not Math.min(...spread): spreading a large array overflows the stack
	for (const e of s.entries) if (e.expires < min) min = e.expires;
	for (const r of s.regs) {
		if (r.expires < min) min = r.expires;
		if (r.pending && r.lastEventAt !== undefined) min = Math.min(min, r.lastEventAt + intervalOf(s, r)); // bundled event due
	}
	for (const t of Object.values(s.txns)) if (t.expires < min) min = t.expires;
	for (const w of s.waiters) if (w.deadline < min) min = w.deadline;
	for (const b of Object.values(s.mailboxes?.boxes ?? {})) if (b.events.length) min = Math.min(min, b.events[0]!.seq <= b.acked ? 0 : b.events[0]!.at + limitsOf(s).mailboxTtlMs);
	for (const j of s.jobs ?? []) min = Math.min(min, j.retryAt ?? 0);
	for (const c of Object.values(s.rpc?.claims ?? {})) if (c.state !== "pending" && c.decidedAt !== undefined) {
		const at = c.decidedAt + limitsOf(s).claimResultMs;
		min = Math.min(min, c.resultExpired ? Math.max(at, (s.rpc?.generations[c.generation]?.admitUntil ?? 0) + 1) : at);
	}
	const usedGenerations = new Set(Object.values(s.rpc?.claims ?? {}).map(c => c.generation));
	for (const [id, g] of Object.entries(s.rpc?.generations ?? {})) if (!usedGenerations.has(id)) min = Math.min(min, g.admitUntil + 1);
	if (s.releaseQueue?.length) min = 0;
	if (s.maintenance) min = Math.min(min, s.maintenance.at);
	return min;
}

export function needsMaintenance(s: Readonly<SpaceState>, now: number): boolean { return nextExpiry(s) <= now; }

// count/stats run on snapshots that may not be settled. A transaction past its lease is as good as aborted (the next
// operation aborts it), so they judge entries the way a read would after settling: its takes are back, its writes gone.
const active = (s: Readonly<SpaceState>, id: string | null, now: number) => id !== null && (s.txns[id]?.expires ?? -Infinity) > now;
type Standing = "expired" | "locked" | "uncommitted" | "visible";
function standing(s: Readonly<SpaceState>, e: EntryRec, now: number): Standing {
	if (e.expires <= now) return "expired";
	if (e.writtenUnder !== null) return active(s, e.writtenUnder, now) ? "uncommitted" : "expired"; // an aborted write lapses with it
	if (e.takenBy !== null && active(s, e.takenBy, now)) return "locked";
	return "visible";
}

/** How many entries match, as `read` would see them (under `txn`, if given). Does not modify anything. */
export function count(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null, as?: Target): number {
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	let n = 0;
	for (const e of s.entries) {
		const st = standing(s, e, now); // what `txn` itself took is "locked": a transaction does not see its own takes
		if ((st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)) n++;
	}
	return n;
}

export const MAX_LIST = 1000;
/**
 * All entries a `read` could see, oldest first, up to the optional `limit` (all matches by default). Does not lock or modify
 * anything, so it is safe for dashboards. `as` is checked against `txn` like for any other use of a transaction.
 */
export function list(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null, limit = Number.MAX_SAFE_INTEGER, as?: Target): EntryView[] {
	if (!Number.isInteger(limit) || limit < 1) throw new IllegalArgumentError("limit must be a positive integer");
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	const out: EntryView[] = [];
	for (const e of s.entries) {
		if (out.length >= limit) break;
		const st = standing(s, e, now); // the same view of the space as count() has
		if ((st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)) out.push(view(e, s.spaceId));
	}
	return out;
}

/** Bytes a page needs besides its items: the envelope, the cursor and separators. */
export const PAGE_OVERHEAD = 96;
export type Page = { items: EntryView[]; next: string | null; rev: number; streamId: string; token?: string }; // rev: revision when the page was read; `changes` after the first page's rev completes the picture

const seqOf = (id: string): number => { const m = /(\d+)$/.exec(id); return m ? Number(m[1]) : 0; };

/**
 * One page of what `list` would return, limited by encoded bytes: `maxBytes` (default and cap: the frame budget) covers
 * the items, the cursor and the envelope. A page ends between whole entries; `after` is the `next` of the page before and
 * continues behind its last entry, so paging neither skips nor repeats entries that stay. A non-empty page holds at
 * least one entry; if the next one does not fit, `ResponseBudgetTooSmall` says what is needed and nothing advances.
 * (Entries written or removed while paging are seen or not by their position; a snapshot token needs revisions, AP 1.3.)
 */
export function listPage(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null, o: { maxBytes?: number; after?: string | null } = {}, as?: Target): Page {
	const frame = limitsOf(s).maxFrameBytes;
	const budget = o.maxBytes === undefined ? frame : o.maxBytes;
	if (!Number.isInteger(budget) || budget <= 0) throw new IllegalArgumentError("maxBytes must be a positive integer");
	const cap = Math.min(budget, frame);
	if (o.after != null && !/^\d+$/.test(o.after)) throw new IllegalArgumentError("bad cursor");
	const after = o.after == null ? 0 : Number(o.after);
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	const eligible = s.entries.filter(e => seqOf(e.id) > after && (standing(s, e, now) === "visible" || (standing(s, e, now) === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)).map(e => view(e, s.spaceId));
	return bytePage(eligible, 0, cap, (items, next) => ({ items, next: next === null ? null : String(seqOf(eligible[next - 1]!.id)), rev: revisionOf(s), streamId: streamIdOf(s) }));
}

// ---- revisions and the change stream (src/stream.ts)

const putOp = (e: EntryRec): Op => ({ op: "put", id: e.id, type: e.type, types: [...e.types], fields: clone(e.fields), expires: e.expires, owner: e.owner });
function logPut(s: SpaceState, now: number, e: EntryRec): void { record(s, now, putOp(e), limitsOf(s).maxLogBytes); }
function logDel(s: SpaceState, now: number, id: string): void { record(s, now, { op: "del", id }, limitsOf(s).maxLogBytes); }

/** The stream this revision belongs to: revisions of different streams (spaces, incarnations) are not comparable. */
export const streamIdOf = (s: Readonly<SpaceState>): string => `${s.spaceId ?? "local"}:${s.incarnation ?? "0"}`;
/** Revision of the newest commit that changed what a plain reader sees (0: none yet). */
export const revision = (s: Readonly<SpaceState>): number => revisionOf(s);

/** The batches the log has dropped no longer answer `changes`: take a fresh page read and continue from its revision. */
export class SnapshotExpired extends Error {}
/** The revision is newer than anything this stream has produced: another stream, or a space restored to an earlier state. */
export class RevisionAhead extends Error {}
export const CHANGES_OVERHEAD = 160; // envelope: stream id, revisions, flags

export type Changes = { streamId: string; batches: Batch[]; next: number; rev: number; more: boolean };

/**
 * The commit batches after `afterRev`, limited by encoded bytes like every page: the budget (default and cap: the frame)
 * ends an answer between batches and at least one batch is returned. `next` is the revision to continue after; `more`
 * says whether the stream has newer batches. A budget below the next batch is `ResponseBudgetTooSmall`, a dropped
 * history `SnapshotExpired`. Pure, so it runs on any snapshot.
 */
export function changes(s: Readonly<SpaceState>, afterRev: number, o: { maxBytes?: number } = {}): Changes {
	const lim = limitsOf(s);
	const budget = o.maxBytes === undefined ? lim.maxFrameBytes : o.maxBytes;
	if (!Number.isInteger(budget) || budget <= 0) throw new IllegalArgumentError("maxBytes must be a positive integer");
	if (!Number.isInteger(afterRev) || afterRev < 0) throw new IllegalArgumentError("afterRev must be a non-negative integer");
	const r = collect(s, afterRev, Number.MAX_SAFE_INTEGER, 0);
	if ("ahead" in r) throw new RevisionAhead(`revision ${afterRev} is ahead of this stream (at ${r.rev})`);
	if ("expired" in r) throw new SnapshotExpired(`batches up to revision ${r.floor} are no longer kept`);
	if ("tooSmall" in r) throw new ResponseBudgetTooSmall(r.tooSmall);
	const rev = revisionOf(s);
	return bytePage(r.batches, 0, Math.min(budget, lim.maxFrameBytes), (batches, next) => ({ streamId: streamIdOf(s), batches, next: batches.length ? batches[batches.length - 1]!.rev : afterRev, rev, more: next !== null }));
}

export type SpaceStats = {
	entries: number; // visible to a plain read
	byType: Record<string, number>;
	locked: number; // taken inside an open transaction, may come back
	uncommitted: number; // written inside an open transaction, not yet visible
	expired: number; // lapsed (or written under a lapsed transaction) but not yet removed by the reaper or an operation
	txns: number; // active only
	waiters: number; // still waiting (deadline not passed)
	registrations: number;
	outbox: number; // events waiting for delivery
	bytes?: { entries: number; outbox: number; claims: number; waiters: number; registrations: number; txns: number; total: number }; // JSON bytes per part; always set by stats()
	returned: number; // entries given back by aborted or expired transactions, ever (durable)
};

/** A point-in-time summary of the space, as an operation would see it after settling; pure, so it runs on any snapshot. */
export function stats(s: Readonly<SpaceState>, now: number): SpaceStats {
	const r: SpaceStats = { entries: 0, byType: {}, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: s.outbox.length, returned: s.returned ?? 0, bytes: { entries: 0, outbox: jsonBytes(s.outbox), claims: claimBytes(s), waiters: jsonBytes(s.waiters), registrations: jsonBytes(s.regs), txns: jsonBytes(s.txns), total: 0 } };
	for (const e of s.entries) {
		r.bytes!.entries += e.size ?? jsonBytes(e.fields);
		const st = standing(s, e, now);
		if (st === "visible") { r.entries++; r.byType[e.type] = (r.byType[e.type] ?? 0) + 1; } else r[st]++;
		if (st === "visible" && e.takenBy !== null) r.returned++; // taken by a lapsed transaction: back once settled
	}
	for (const t of Object.values(s.txns)) if (t.expires > now) r.txns++;
	for (const w of s.waiters) if (w.deadline > now) r.waiters++;
	for (const g of s.regs) if (g.expires > now) r.registrations++;
	r.bytes!.total = jsonBytes(s); // the whole document as stored
	return r;
}
