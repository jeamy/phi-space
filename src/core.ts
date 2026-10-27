import {assertMemberAdmission,initializeMemberTxn,assertMemberWrite,chargeMemberWrite,assertMemberTake,assertMemberRenew,type MemberAdmission,type CompletionAllowance} from "./member-admission.ts";
// Pure JavaSpaces semantics (Jini JavaSpaces spec v2.2) over a plain JSON state. No pi imports.
// Functions mutate `state` in place (it is a document draft inside a commit) and take `now` explicitly.
import { collect, record, touch as touchStream, revisionOf, seal as sealStream, type Batch, type Op, type StreamState } from "./stream.ts";
import { canonicalJson } from "./canonical.ts";
import { sweep as sweepClaims, decide as decideClaim, restoredBytes as restoredClaimBytes, type ClaimRec } from "./claims.ts";
import { bytePage } from "./paging.ts";
import { appendMail, assertMailboxCapacity, assertMailboxBatch, sweepMailboxes, type MailboxState } from "./mailbox.ts";
import type { Principal } from "./claims.ts";
import { jsonBytes, jsonCopy } from "./json.ts";
import { diskMapOf } from "./store/types.ts";

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
	maxEntries: number; // optional explicit count quota; FOREVER means no default count cap
	maxEntriesPerOwner: number; // optional explicit owner quota; FOREVER by default
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
export const DEFAULT_LIMITS: Limits = { maxEntryBytes: 64 * 1024, maxTypeChars: 128, maxTypes: 16, maxEntries: FOREVER, maxEntriesPerOwner: FOREVER, maxRegsPerOwner: 20, maxWaitersPerOwner: 20, maxTxnsPerOwner: 20, maxSpaceBytes: 64 * 1024 * 1024, notifyIntervalMs: 1000, claimResultMs: 24 * 3600 * 1000, generationAdmitMs: 3600 * 1000, maxClaimBytes: 32 * 1024 * 1024, maxOutboxBytes: 8 * 1024 * 1024, maxDocBytes: 128 * 1024 * 1024, maxCommitBytes: 192 * 1024, maxFrameBytes: 256 * 1024, maxEventBytes: 160 * 1024, maxLogBytes: 4 * 1024 * 1024, maxSnapshotBytes: 64 * 1024 * 1024, maxSnapshots: 16, snapshotTtlMs: 60_000, maxMailboxBytes: 8 * 1024 * 1024, mailboxTtlMs: 7 * 24 * 3600 * 1000, maxJobBytes: 16 * 1024 * 1024 };
export class LimitError extends Error {}
/** A limit would be exceeded; raised before anything changed (federation-plan-v3 4.2 `ResourceExhausted`). */
export class ResourceExhausted extends LimitError {}
/** The byte budget of a page cannot hold the next whole element; nothing advanced. Retry with at least `requiredBytes`. */
export class ResponseBudgetTooSmall extends Error {
	requiredBytes: number; // (no parameter property: the code runs under node's strip-only TypeScript mode)
	constructor(requiredBytes: number) { super(`the next element needs ${requiredBytes} bytes of budget`); this.requiredBytes = requiredBytes; }
}
export class IllegalArgumentError extends Error {}
/** A write with `unique` found another entry of its type with the same key fields (client.ts Req.unique). */
export class UniqueConflict extends IllegalArgumentError {}
/** A conversation tried to use or change something that is not its own. */
export class PermissionError extends Error {}
/** v3 5.3.1 step 5: a replicated Member refuses new work until the router routes under its current replica
 * configuration. Nothing was admitted, so the caller retries later; never a definitive refusal. */
export class ReplicaConfigPending extends PermissionError {}
/** A new operation delegated under an older policy version than the installed one; refused before admission. */
export class StalePolicyVersion extends PermissionError {}
export class TransactionError extends Error {}
export class CompletionViolation extends TransactionError {}
/** A RunGate command conflicts with the gate's revision history, its pending transition or its terminal state. */
export class RunGateConflict extends TransactionError {}
export class UnknownLeaseError extends Error {}

/** An entry: a typed group of fields. `types` is the type followed by its supertypes, fixed at write time. */
export type EntryDraft = { type: string; types?: string[]; fields: Fields };
/** A template: absent/null type and fields are wildcards. A null template (`null`) matches any entry. */
export type Template = { type?: string | null; fields?: Fields; id?: string | null } | null;

export type EntryRec = {
	restoredUnverified?: true;
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
export type TxnRec = { completion?: CompletionAllowance; completionDeadline?: number; originRequestKey?: string; id: string; expires: number; owner: Target | null; reserved?: number; takenTasks?: Array<{ id: string; types: string[]; fields: Fields }>; runs?: Record<string, number> };
/** `gateField`: tasks name their run in this field; they are takeable only while that run's RunGate is running. */
export type CompletionProfile = { taskType: string; resultTypes: string[]; equalFields: string[]; maxResultCount: number; maxResultBytes?: number; maxLeaseMs?: number; gateField?: string };
export type RunGateState = "preparing" | "running" | "paused" | "stopped";
export type RunGateKind = "prepare" | "release" | "pause" | "resume" | "stop";
/** `recoveryId`/`expect`: a decision under a recovery entry fence, applied only if the gate still shows `expect`. */
export type RunGateCommand = { runId: string; commandId: string; kind: RunGateKind; revision: number; recoveryId?: string; expect?: { revision: number; state: RunGateState } };
/** Compact evidence of a gate taken from a restored snapshot. */
export type RunGateEvidence = { revision: number; state: RunGateState; commandId: string; kind: RunGateKind; maxRevision: number; fence?: { revision: number; commandId: string; kind: "pause" | "stop" } };
/** Protected local control state of one run on this Member; not an entry, never written through Space RPC. */
export type RunGateRec = { runId: string; revision: number; state: RunGateState; commandId: string; kind: RunGateKind; at: number; fence?: { revision: number; commandId: string; kind: "pause" | "stop"; at: number; recoveryId?: string }; recovery?: { id: string; at: number }; historical?: true; restored?: RunGateEvidence; history: Array<{ revision: number; commandId: string; kind: RunGateKind; state: RunGateState }> };
export type RunGateAck = { runId: string; spaceId: string | null; incarnation: string | null; authorityId: string | null; revision: number; state: RunGateState; commandId: string; kind: RunGateKind; phase: "applied" | "fenced"; boundTxns: number };
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
export type WaiterRec = { originRequestKey?: string; id: string; template: Template; take: boolean; target: Target | null; deadline: number; txnLeaseMs: number; handback: Json; claimKey?: string; requestTxn?: string | null; ifExists?: boolean; consumer?: Principal; authorizedUntil?: number };
/** `owner`: who wrote it (a conversation id), or null for host code, so a reader can judge where content comes from. */
export type EntryView = { id: string; gid?: string; type: string; types: string[]; fields: Fields; owner: Target | null; restoredUnverified?: true };
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
	reason?: "expired" | "cancelled" | "transactionEnded" | "removing";
};
/** `returned`: entries given back by aborted or expired transactions, ever. Only changes in commits that change the
 * space anyway (a transaction ends), so keeping it durable wakes nobody. */
/**
 * `spaceId` (immutable) and `incarnation` (replaced by a restore) identify this space; both are set when the space is
 * registered (see `spaces.ts`), so a fresh document has neither. Local ids carry the incarnation: `e<incarnation>-<n>`.
 */
export type SpaceState = { erasureEpoch?:number; adminMaintenance?:{commandId:string;hash:string}; snapshotEpoch?:number; membership?: MemberAdmission; outboxBytes?: number; nextId: number; entries: EntryRec[]; txns: Record<string, TxnRec>; regs: RegRec[]; waiters: WaiterRec[]; outbox: SpaceEvent[]; returned: number ; limits?: Partial<Limits>; spaceId?: string; incarnation?: string; rpc?: import("./claims.ts").RpcState; stream?: StreamState; completionProfiles?: CompletionProfile[]; mailboxes?: MailboxState; jobs?: FanoutJob[]; releaseQueue?: string[]; maintenance?: { at: number; cursor: string }; primaryEpoch?: number; acceptedAuthorityId?: string; authorityTransition?: { recoveryId: string; authorityId: string; stage: "clearing" | "history" | "generations" | "completed"; /** claims on the disk: the key the history stage marked last */ claimCursor?: string; /** historical claims: likewise */ historyCursor?: string }; authorityCounters?: { routerEpoch: number; policyVersion: number }; restore?: import("./restore.ts").RestoreState; restoredClaims?: Record<string, import("./claims.ts").ClaimRec>; /** the tally of restoredClaims when they are on the disk (claims.ts restoredBytes) */ restoredBytes?: number; invalidGenerations?: Record<string, true>; runGates?: Record<string, RunGateRec>; archived?: { at: number; commandId: string } };

export const initialState = (): SpaceState => ({ nextId: 1, entries: [], txns: {}, regs: [], waiters: [], outbox: [], outboxBytes: 2, returned: 0 });
export const migrate = (v: any, _from: number): SpaceState => {
	const d = initialState();
	return {
		nextId: v.nextId ?? d.nextId,
		entries: (v.entries ?? d.entries).map((e: any) => ({ ...e, types: e.types ?? [e.type], readBy: e.readBy ?? [], writtenUnder: e.writtenUnder ?? null, takenBy: e.takenBy ?? null, owner: e.owner ?? null })),
		txns: Object.fromEntries(Object.entries(v.txns ?? d.txns).map(([k, t]: [string, any]) => [k, { ...t, owner: t.owner ?? null }])),
		regs: (v.regs ?? d.regs).map((r: any) => ({ ...r, seq: r.seq ?? 0 })),
		waiters: v.waiters ?? d.waiters,
		outbox: v.outbox ?? d.outbox,
		...(v.outboxBytes !== undefined ? { outboxBytes: v.outboxBytes } : {}),
		...(v.limits ? { limits: v.limits } : {}),
		...(typeof v.spaceId === "string" ? { spaceId: v.spaceId } : {}),
		...(typeof v.incarnation === "string" ? { incarnation: v.incarnation } : {}),
		...(v.rpc ? { rpc: v.rpc } : {}), // request claims (claims.ts)
		...(v.stream ? { stream: v.stream } : {}), // revisions and change batches (stream.ts)
		...(v.membership ? { membership: v.membership } : {}),
		...(v.adminMaintenance?{adminMaintenance:v.adminMaintenance}:{}),
		...(v.erasureEpoch===undefined?{}:{erasureEpoch:v.erasureEpoch}),
		...(v.snapshotEpoch===undefined?{}:{snapshotEpoch:v.snapshotEpoch}),
		...(v.completionProfiles ? { completionProfiles: v.completionProfiles } : {}),
		...(v.mailboxes ? { mailboxes: v.mailboxes } : {}),
		...(v.jobs ? { jobs: v.jobs } : {}),
		...(v.releaseQueue ? { releaseQueue: v.releaseQueue } : {}),
		...(v.maintenance ? { maintenance: v.maintenance } : {}),
		...(v.primaryEpoch !== undefined ? { primaryEpoch: v.primaryEpoch } : {}),
		...(v.acceptedAuthorityId ? { acceptedAuthorityId: v.acceptedAuthorityId } : {}),
		...(v.authorityTransition ? { authorityTransition: v.authorityTransition } : {}),
		...(v.authorityCounters ? { authorityCounters: v.authorityCounters } : {}),
		...(v.restore ? { restore: v.restore } : {}),
		...(v.restoredClaims ? { restoredClaims: v.restoredClaims } : {}),
		...(v.restoredBytes !== undefined ? { restoredBytes: v.restoredBytes } : {}),
		...(v.invalidGenerations ? { invalidGenerations: v.invalidGenerations } : {}),
		...(v.runGates ? { runGates: v.runGates } : {}),
		...(v.archived ? { archived: v.archived } : {}),
		returned: v.returned ?? d.returned,
	};
};
export type Lease = { id: string; expires: number };

const clone = jsonCopy; // draft proxies are not structured-cloneable
/** A plain copy of a value read from a document draft. Drafts are unusable once their commit settles, so anything a
 * commit returns that came from the document (a stored claim, for one) must be copied out inside the commit. */
export const plain = <T>(v: T): T => (v === undefined ? v : clone(v));
/** A detached copy of a space for a dry run. Claims a store keeps on its disk are left out (a dry run of a command does
 *  not read a day of them); with claims in memory it is `plain(s)`. */
export function previewOf(s: Readonly<SpaceState>): SpaceState {
	return s.rpc && diskMapOf(s.rpc.claims) ? plain({ ...s, rpc: { ...s.rpc, claims: {} } }) as SpaceState : plain(s) as SpaceState;
}
/** JSON bytes of a whole space as stored; claims on the disk by their running tally (they are not read for this). */
export function docBytes(s: Readonly<SpaceState>): number {
	return s.rpc && diskMapOf(s.rpc.claims) ? jsonBytes({ ...s, rpc: { ...s.rpc, claims: {} } }) + Math.max(0, (s.rpc.bytes ?? 0) - jsonBytes(s.rpc.generations)) : jsonBytes(s);
}
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
const FROZEN_DEFAULTS: Limits = Object.freeze({ ...DEFAULT_LIMITS });
const mergedLimits = new WeakMap<object, Limits>();
/** The space's limits over the defaults. Asked several times by every operation, so the merge is kept per limits object
 *  (a change of limits assigns a new one); the result is frozen. */
export const limitsOf = (s: Readonly<SpaceState>): Limits => {
	const own = s.limits;
	if (!own) return FROZEN_DEFAULTS;
	let m = mergedLimits.get(own);
	if (!m) { m = Object.freeze({ ...DEFAULT_LIMITS, ...own }); mergedLimits.set(own, m); }
	return m;
};
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
	// Completion events (registrationClosed, timeout, publishing a commit) must not fail later: a lower event limit has
	// to fit every event the existing registrations and waits can still produce (the check at notify/addWaiter time).
	if (merged.maxEventBytes < limitsOf(s).maxEventBytes) for (const x of [...s.regs, ...s.waiters]) {
		const meta = jsonBytes(x.handback ?? null) + EVENT_OVERHEAD;
		if (meta > merged.maxEventBytes || s.entries.some(e => matches(x.template, e) && jsonBytes(view(e, s.spaceId)) + meta > merged.maxEventBytes)) throw new ResourceExhausted("the new event limit would make an existing subscription's or wait's events fail");
	}
	s.limits = { ...(s.limits ?? {}), ...l };
	// another retention moves every claim's due time: the next sweep scans them all
	if (l.claimResultMs !== undefined && s.rpc) delete s.rpc.sweepAt;
	touch(s, now);
	return limitsOf(s);
}
const ownedBy = (as: Target) => (o: { owner: Target | null }) => o.owner === as;
/** Bytes of the parts of the document that are not entries (claims by their running tally). */
export function overheadBytes(s: Readonly<SpaceState>): number {
	return jsonBytes(s.adminMaintenance ?? {}) + jsonBytes(s.membership ?? {}) + Object.values(s.txns).reduce((n,t)=>n+(t.completion?.remainingBytes??0),0) + jsonBytes(s.authorityTransition ?? {}) + jsonBytes(s.authorityCounters ?? {}) + (s.restore ? jsonBytes(s.restore) : 0) + claimBytes(s) + (s.stream?.bytes ?? 0) + outboxBytes(s) + jsonBytes(s.waiters) + jsonBytes(s.regs) + jsonBytes(s.txns) + jsonBytes(s.jobs ?? []) + mailboxesBytes(s) + jsonBytes(s.runGates ?? {});
}
/** Encoded bytes of the outbox as a running tally (kept on the document); states that predate it are counted once. */
export function outboxBytes(s: Readonly<SpaceState>): number { return s.outboxBytes ?? jsonBytes(s.outbox); }
/** An event joins the outbox: it and its JSON separator are counted at once. */
function pushOutbox(s: SpaceState, event: SpaceEvent): void { s.outboxBytes = outboxBytes(s) + jsonBytes(event) + 1; s.outbox.push(event); }
/** Bytes of all entries' fields (the space-wide limits count these). */
const entryBytes = (s: Readonly<SpaceState>): number => s.entries.reduce((n, e) => n + (e.size ?? jsonBytes(e.fields)), 0);
/** The waiter leaves the array in place (document drafts track changes in place). */
const dropWaiter = (s: SpaceState, w: WaiterRec): void => { s.waiters.splice(s.waiters.indexOf(w), 1); };
/**
 * `jsonBytes(s.mailboxes)` without encoding every event: each box keeps the encoded size of its event array as
 * `bytes` (mailbox.ts), so the box costs its metadata with an empty array plus that tally. Exact, and O(boxes).
 */
function mailboxesBytes(s: Readonly<SpaceState>): number {
	if (!s.mailboxes) return 2;
	let tally = 0;
	const boxes: Record<string, unknown> = {};
	for (const [id, b] of Object.entries(s.mailboxes.boxes)) {
		boxes[id] = { ...b, events: [] };
		tally += (Number.isSafeInteger(b.bytes) ? b.bytes : jsonBytes(b.events)) - 2;
	}
	return jsonBytes({ ...s.mailboxes, boxes }) + tally;
}
/** Claim and generation bytes: a running tally kept by claims.ts, computed once for states that predate it. */
export function claimBytes(s: Readonly<SpaceState>): number {
	const r = s.rpc;
	const history = restoredClaimBytes(s) + (s.invalidGenerations ? jsonBytes(s.invalidGenerations) : 0);
	if (!r) return history;
	if (r.bytes === undefined) return history + jsonBytes(r.claims) + jsonBytes(r.generations);
	return history + r.bytes + (r.reservedBytes ?? 0);
}
/**
 * An event carries the entry, a handback and metadata. A conservative bound (the largest handback of any registration or
 * wait, whether or not it matches) is checked before the write is accepted, so no event can exceed `maxEventBytes`.
 */
function checkEventSize(s: Readonly<SpaceState>, rec: EntryRec, lim: Limits, viewBytes = jsonBytes(view(rec, s.spaceId))): void {
	if (s.regs.length === 0 && s.waiters.length === 0) return;
	let handback = 0;
	for (const r of s.regs) handback = Math.max(handback, jsonBytes(r.handback));
	for (const w of s.waiters) handback = Math.max(handback, jsonBytes(w.handback));
	const bound = viewBytes + handback + EVENT_OVERHEAD;
	if (bound > lim.maxEventBytes) throw new ResourceExhausted(`an event for this entry could take ${bound} bytes; the limit is ${lim.maxEventBytes}`);
}
const EVENT_OVERHEAD = 256; // kind, ids, sequence, target, count
const COMMIT_FIXED = 1024; // claim and result, batch envelope, bookkeeping of one commit

/**
 * A conservative bound of what making `e` visible writes: its stream operation plus one event for every registration and
 * wait that matches it now (subscriptions made later are not counted).
 */
function publishCost(s: Readonly<SpaceState>, e: EntryRec, v = jsonBytes(view(e, s.spaceId))): number {
	let n = jsonBytes(putOp(e)) + 1;
	for (const r of s.regs) if (matches(r.template, e)) n += v + jsonBytes(r.handback) + EVENT_OVERHEAD;
	for (const w of s.waiters) if (matches(w.template, e)) n += v + jsonBytes(w.handback) + EVENT_OVERHEAD;
	return n;
}
function refreshReservations(s: SpaceState, extra: { reg?: RegRec; waiter?: WaiterRec } = {}): Map<string, number> {
	const preview = { ...s, regs: extra.reg ? [...s.regs, extra.reg] : s.regs, waiters: extra.waiter ? [...s.waiters, extra.waiter] : s.waiters };
	const updated = new Map<string, number>();
	// Every rise of a transaction's cost goes through `reserve` (its writes and takes) or through here (subscriptions),
	// so `reserved` never falls below the full recount. A transaction the new subscription cannot touch therefore keeps
	// exactly `reserved`; only the touched ones (and any without a reservation) are recounted, over their own entries.
	const added = extra.reg ?? extra.waiter, recount = new Set<string>();
	for (const t of Object.values(s.txns)) if (added === undefined || t.reserved === undefined || extra.reg?.txn === t.id) recount.add(t.id);
	if (added !== undefined) for (const e of s.entries) if (e.writtenUnder !== e.takenBy && matches(added.template, e)) for (const id of [e.writtenUnder, e.takenBy]) if (id !== null) recount.add(id);
	// One pass over the entries for all recounted transactions (an entry belongs to at most two).
	const published = new Map<string, number>();
	if (recount.size) for (const e of s.entries) {
		if (e.writtenUnder === e.takenBy) continue; // written and taken in one transaction (or neither): nothing to publish
		if (!(e.writtenUnder !== null && recount.has(e.writtenUnder)) && !(e.takenBy !== null && recount.has(e.takenBy))) continue;
		const cost = publishCost(preview, e);
		for (const id of [e.writtenUnder, e.takenBy]) if (id !== null) published.set(id, (published.get(id) ?? 0) + cost);
	}
	for (const t of Object.values(s.txns)) {
		let cost = t.reserved ?? 0;
		if (recount.has(t.id)) {
			let full = published.get(t.id) ?? 0;
			for (const r of preview.regs) if (r.txn === t.id) full += jsonBytes(r.handback) + 512;
			cost = Math.max(full, cost);
		}
		if (cost + COMMIT_FIXED > limitsOf(s).maxCommitBytes) throw new ResourceExhausted("the new subscription would invalidate a transaction's completion reservation");
		updated.set(t.id, cost);
	}
	if (jsonBytes(s.jobs ?? []) + [...updated.values()].reduce((n, cost) => n + cost, 0) > limitsOf(s).maxJobBytes) throw new ResourceExhausted("the new subscription exceeds reserved completion storage");
	return updated;
}
/** Whether a durable fanout job still holds an undelivered event for this consumer (or, without one, for this outbox target). */
function pendingFanout(s: Readonly<SpaceState>, consumer: Principal | undefined, target: Target | null): boolean {
	if (!s.jobs?.length) return false;
	const key = consumer ? canonicalJson(consumer as unknown as Json) : undefined; // once, not per compared event
	for (const j of s.jobs) for (let i = j.cursor; i < j.events.length; i++) {
		const x = j.events[i]!;
		if (key !== undefined ? !!x.consumer && canonicalJson(x.consumer as unknown as Json) === key : !x.consumer && x.event.target === target) return true;
	}
	return false;
}
function queueEvent(s: SpaceState, now: number, event: SpaceEvent, consumer?: Principal, completing = false): void {
	if (jsonBytes(event) > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the event exceeds maxEventBytes");
	if (!completing) {
		if (pendingFanout(s, consumer, event.target)) throw new ResourceExhausted("the consumer has a pending durable fanout backlog");
		if (consumer) appendMail(s, consumer, event, now);
		else {
			if (outboxBytes(s) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) throw new ResourceExhausted("the local outbox is full");
			pushOutbox(s, event);
			touch(s, now);
		}
		return;
	}
	// Completion must not fail when a consumer is slow. Admission reserves durable storage for this captured event.
	if (!consumer && outboxBytes(s) + jsonBytes(event) + 1 <= limitsOf(s).maxOutboxBytes && !pendingFanout(s, undefined, event.target)) { pushOutbox(s, clone(event)); touch(s, now); return; }
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
				else if (outboxBytes(s) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) { job.retryAt = coreJobRetry(now); break; }
				if (!canCharge(s, jsonBytes(event) + EVENT_OVERHEAD)) { deferMaintenance(s, now, job.id); return; }
				charge(s, jsonBytes(event) + EVENT_OVERHEAD);
				if (consumer) appendMail(s, consumer, event, now); else pushOutbox(s, clone(event));
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
	if (s.outbox.length > 0 && outboxBytes(s) > lim.maxOutboxBytes) throw new LimitError(`${lim.maxOutboxBytes} bytes of events wait for delivery; try again later`);
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
/** An archived Space keeps its data readable but takes no new work (space-lifecycle.ts). */
export function assertNotArchived(s: Readonly<SpaceState>): void { if (s.archived) throw new PermissionError("the Space is archived; reactivate it first"); }
export function assertAdminIdle(s: Readonly<SpaceState>):void {if(s.adminMaintenance)throw new PermissionError("Space has a pending administrative deletion");}
export function settle(s: SpaceState, now: number): void {
	if(s.adminMaintenance)return;
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
/**
 * Fast expiry bookkeeping: `settle` sweeps entries on EVERY operation, and in large durable
 * spaces almost every sweep expires nothing — the `[...entries].filter` copy per operation
 * dominated CPU. The watermark holds the smallest `expires` seen on the last full sweep;
 * above it the entry sweep is provably a no-op (reg/waiter deadlines are still checked).
 * It lives outside the document (nothing persisted or migrated). It can only ever be stale
 * LOW — removals leave it behind, which costs one extra scan; anything that shrinks an
 * entry's expiry pushes it down eagerly, so a stale HIGH watermark cannot occur.
 */
const expiryWatermarks = new WeakMap<SpaceState, number>();
const noteExpiry = (s: SpaceState, expires: number): void => {
	// An unknown document may contain older deadlines than the newly imported entry.
	const known = expiryWatermarks.get(s);
	if (known !== undefined && expires < known) expiryWatermarks.set(s, expires);
};
function expire(s: SpaceState, at: number): boolean {
	// A reopened document has no watermark: its persisted entries must be scanned once.
	if ((expiryWatermarks.get(s) ?? -Infinity) <= at) {
		let min = Infinity;
		const dead: EntryRec[] = [];
		for (const e of s.entries) {
			if (e.expires <= at) dead.push(e);
			else if (e.expires < min) min = e.expires;
		}
		expiryWatermarks.set(s, min);
		dead.sort((a, b) => a.expires - b.expires || a.id.localeCompare(b.id));
		const removed = new Set<EntryRec>();
		let deferred = false;
		for (const e of dead) {
			// The rest stays: the watermark is their (sorted) earliest expiry, so the next sweep cannot skip them.
			if (!canCharge(s, 128)) { expiryWatermarks.set(s, Math.min(min, e.expires)); deferMaintenance(s, at, e.id); deferred = true; break; }
			charge(s, 128);
			if (e.writtenUnder === null && e.takenBy === null) logDel(s, at, e.id);
			removed.add(e);
		}
		// One pass instead of indexOf per dead entry (quadratic when many expire at once).
		if (removed.size) { prune(s.entries, e => removed.has(e)); touch(s, at); }
		if (deferred) return false;
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
		if (w.claimKey) { if (s.rpc?.claims[w.claimKey]?.state === "pending") decideClaim(s, at, w.claimKey, { state: "done", result: null, ...(find(s, w.template, w.requestTxn ?? null, w.take).status === "locked" ? { locked: true } : {}) }); }
		else queueEvent(s, at, { kind: "timeout", eventId: w.id, seq: 1, handback: w.handback, target: w.target }, w.consumer, true);
		dropWaiter(s, w);
		touch(s, at);
	}
	return true;
}

/**
 * `as` is the conversation acting. Omitted (host code), nothing is checked. Given, it may only use transactions and
 * leases it owns (never ownerless ones: those are the host's), it owns what it creates, and the limits apply.
 */
const directoryEntry = (e: {types?:string[];type:string}) => [e?.type,...(Array.isArray(e?.types)?e.types:[])].some(t=>t==="Capability"||t==="MemberStatus");
export function write(s: SpaceState, now: number, entry: EntryDraft, txn: string | null, lease: number, as?: Target): Lease {
	assertNotArchived(s);
	if (directoryEntry(entry)) { if(as!==undefined || txn!==null) throw new PermissionError("directory entries require trusted publication"); assertMemberAdmission(s,"write"); if(s.membership && s.membership.state!=="active") throw new PermissionError("directory publication requires active Member"); } else assertMemberWrite(s, entry, txn, now);
	settle(s, now);
	if (typeof entry?.type !== "string" || entry.type === "") throw new IllegalArgumentError("entry needs a type");
	if (entry.fields === null || typeof entry.fields !== "object" || Array.isArray(entry.fields)) throw new IllegalArgumentError("entry fields must be an object");
	if (txn !== null) requireTxn(s, txn, as);
	assertRunWrite(s, entry, txn);
	const expires = grant(lease, now);
	if (as !== undefined) {
		const lim = limitsOf(s);
		if (entry.type.length > lim.maxTypeChars) throw new LimitError(`type name longer than ${lim.maxTypeChars} characters`);
		if ((entry.types?.length ?? 0) + 1 > lim.maxTypes) throw new LimitError(`more than ${lim.maxTypes} types`);
		for (const t of entry.types ?? []) if (typeof t !== "string" || t.length > lim.maxTypeChars) throw new LimitError("bad or too long supertype name");
		checkSize("entry", entry.fields, lim);
		if (s.entries.length >= lim.maxEntries) throw new LimitError(`the space holds ${lim.maxEntries} entries already`);
		if (lim.maxEntriesPerOwner !== FOREVER && s.entries.filter(ownedBy(as)).length >= lim.maxEntriesPerOwner) throw new LimitError(`you already have ${lim.maxEntriesPerOwner} entries in the space`);
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
	const used = rec.size + entryBytes(s);
	if (used > lim.maxSpaceBytes) throw new LimitError(`the space would exceed ${lim.maxSpaceBytes} bytes`);
	if (used + overheadBytes(s) > lim.maxDocBytes) throw new LimitError(`the space document would exceed ${lim.maxDocBytes} bytes`);
	if (expires <= now) { s.nextId++; touch(s, now); return { id: rec.id, expires }; }
	// The entry's view is measured once for every bound below (it was serialized again for each).
	const viewBytes = jsonBytes(view(rec, s.spaceId));
	checkEventSize(s, rec, lim, viewBytes);
	preflightFanout(s, rec, txn, now);
	const cost = publishCost(s, rec, viewBytes);
	if (!canCharge(s, jsonBytes(rec) + (txn === null ? cost : 0))) throw new ResourceExhausted("the write exceeds the remaining commit budget");
	reserve(s, txn, cost, lim); // before any change: a refusal leaves everything as it was
	charge(s, jsonBytes(rec));
	s.nextId++;
	s.entries.push(rec);
	noteExpiry(s, expires);
	chargeMemberWrite(s, entry, txn);
	touch(s, now);
	if (txn === null) logPut(s, now, rec); // visible at once; under a transaction it appears at commit
	notifyWrite(s, rec, txn, now);
	if (txn === null) serve(s, now);
	return { id: rec.id, expires };
}

function preflightFanout(s: SpaceState, rec: EntryRec, txn: string | null, now: number): void {
	const consumers = new Map<string, { principal: Principal; events: SpaceEvent[] }>();
	const local: SpaceEvent[] = [];
	const entry = view(rec, s.spaceId); // only measured here, never stored: one view serves every candidate event
	const add = (event: SpaceEvent, consumer?: Principal) => {
		if (jsonBytes(event) > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the event exceeds maxEventBytes");
		if (consumer) { const key = canonicalJson(consumer as unknown as Json); let group = consumers.get(key); if (!group) { group = { principal: consumer, events: [] }; consumers.set(key, group); } group.events.push(event); }
		else local.push(event);
	};
	for (const r of s.regs) if ((txn === null || r.txn === txn) && matches(r.template, rec)) add({ kind: "entry", eventId: r.id, seq: r.seq + 1, handback: r.handback, target: r.target, entry }, r.consumer);
	if (txn === null) for (const w of s.waiters) if (!w.claimKey && matches(w.template, rec)) add({ kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry }, w.consumer);
	for (const group of consumers.values()) assertMailboxBatch(s, group.principal, group.events, now);
	if (outboxBytes(s) + local.reduce((n, e) => n + jsonBytes(e) + 1, 0) > limitsOf(s).maxOutboxBytes) throw new ResourceExhausted("the local outbox cannot hold this fanout");
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
	assertMemberAdmission(s, take ? "take" : "read");
	if (take) assertNotArchived(s);
	settle(s, now);
	if (txn !== null) requireTxn(s, txn, as);
	const f = find(s, tmpl, txn, take);
	if (f.status === "found" && as !== undefined && directoryEntry(f.rec) && (take || txn !== null)) throw new PermissionError("directory entries cannot be consumed or locked");
	if (f.status === "found" && take) assertMemberTake(s,f.rec,txn,now);
	if (f.status === "found" && take && txn === null && (s.completionProfiles ?? []).some(p => f.rec.types.includes(p.taskType))) throw new CompletionViolation("profiled tasks must be taken under a transaction");
	if (f.status === "found" && take && txn !== null && f.rec.writtenUnder !== txn) reserve(s, txn, publishCost(s, f.rec), limitsOf(s)); // an abort puts it back
	return f.status === "found" ? { status: "found", entry: apply(s, now, f.rec, txn, take) } : f;
}

/** What callers see of an entry. With the space's id it also carries the global id. */
export const view = (e: EntryRec, spaceId?: string): EntryView => ({ id: e.id, ...(spaceId ? { gid: gidOf(spaceId, e.id) } : {}), type: e.type, types: [...e.types], fields: clone(e.fields), owner: e.owner, ...(e.restoredUnverified ? { restoredUnverified: true as const } : {}) });

function find(s: SpaceState, tmpl: Template, txn: string | null, take: boolean): { status: "found"; rec: EntryRec } | { status: "none" } | { status: "locked" } {
	let locked = false;
	for (const e of s.entries) {
		if (!matches(tmpl, e) || (e.restoredUnverified && (take || txn !== null))) continue;
		if (take) { const run = runOf(s, e.types, e.fields); if (run !== undefined && !takeableRun(s, run)) continue; } // gated: invisible to takes, not a conflict
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
			const deadline = Math.min(...profiles.map(p => p.maxLeaseMs === undefined ? FOREVER : now + p.maxLeaseMs));
			const t = s.txns[txn]!;
			t.completionDeadline = Math.min(t.completionDeadline ?? FOREVER, deadline);
			t.expires = Math.min(t.expires, t.completionDeadline);
			reserve(s, txn, jsonBytes(capture) + 64, limitsOf(s));
			s.txns[txn]!.takenTasks ??= []; s.txns[txn]!.takenTasks!.push(capture);
			const run = runOf(s, e.types, e.fields);
			if (run) { t.runs ??= {}; t.runs[run] = s.runGates![run]!.revision; } // find admitted it: the gate is running
		}
		if (e.writtenUnder === null) logDel(s, now, e.id); // it stops being visible (taken, or locked by a transaction)
		touch(s, now);
		if (txn === null || e.writtenUnder === txn) s.entries.splice(s.entries.indexOf(e), 1); // gone, or never visible outside
		else setEntry(s, e, { takenBy: txn });
	} else if (txn !== null && !e.readBy.includes(txn)) { setEntry(s, e, { readBy: [...e.readBy, txn] }); touch(s, now); }
	return copy;
}

/** Changes an entry. Entries are values (a store may share and freeze them between commits): a change replaces the
 *  record in `s.entries` with a changed copy and returns that copy; the old record stays as it was. */
function setEntry(s: SpaceState, e: EntryRec, change: Partial<EntryRec>, drop: readonly (keyof EntryRec)[] = []): EntryRec {
	const i = s.entries.indexOf(e);
	if (i < 0) throw new Error(`entry ${e.id} is not in the space`);
	const next = { ...e, ...change } as EntryRec;
	for (const k of drop) delete next[k];
	s.entries[i] = next;
	return next;
}

export function createTxn(s: SpaceState, now: number, lease: number, as?: Target): Lease {
	assertAdminIdle(s);
	assertNotArchived(s);
	settle(s, now);
	if (as !== undefined && Object.values(s.txns).filter(ownedBy(as)).length >= limitsOf(s).maxTxnsPerOwner) throw new LimitError(`you already have ${limitsOf(s).maxTxnsPerOwner} open transactions`);
	const t: TxnRec = { id: newId(s, "t"), expires: grant(lease, now), owner: as ?? null };
	initializeMemberTxn(s,t,now);
	if(t.completion && entryBytes(s)+overheadBytes(s)+t.completion.remainingBytes+jsonBytes(t)>limitsOf(s).maxDocBytes)throw new ResourceExhausted("completion reservation exceeds Member document budget");
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
		if (p.gateField !== undefined && (typeof p.gateField !== "string" || !p.gateField || !p.equalFields.includes(p.gateField) || p.maxLeaseMs === undefined)) throw new IllegalArgumentError("a gate field must be one of the equal fields, with a finite maxLeaseMs");
		if ((p.maxResultBytes !== undefined && (!Number.isSafeInteger(p.maxResultBytes) || p.maxResultBytes < 1)) || (p.maxLeaseMs !== undefined && (!Number.isSafeInteger(p.maxLeaseMs) || p.maxLeaseMs < 1))) throw new IllegalArgumentError("invalid completion budget");
		seen.add(p.taskType);
	}
	assertGatedProfilesKept(s, profiles);
	s.completionProfiles = clone(profiles);
	touch(s, now);
}
/** Every path that replaces completion profiles (also a federation policy) must keep the gates of unstopped runs. */
export function assertGatedProfilesKept(s: Readonly<SpaceState>, profiles: readonly CompletionProfile[]): void {
	const active = Object.values(s.runGates ?? {}).some(g => g.state !== "stopped");
	if (active && (s.completionProfiles ?? []).some(o => o.gateField !== undefined && !profiles.some(p => p.taskType === o.taskType && p.gateField === o.gateField))) throw new RunGateConflict("gated profiles cannot change while a run is not stopped");
}
function checkCompletion(s: SpaceState, id: string): void {
	for (const p of s.completionProfiles ?? []) {
		const tasks = (s.txns[id]?.takenTasks ?? s.entries.filter(e => e.takenBy === id)).filter(e => e.types.includes(p.taskType));
		const assigned = new Set<string>();
		for (const task of tasks) {
			const results = s.entries.filter(e => e.writtenUnder === id && e.takenBy === null && !assigned.has(e.id) && e.types.some(t => p.resultTypes.includes(t)) && p.equalFields.every(f => Object.hasOwn(task.fields, f) && Object.hasOwn(e.fields, f) && canonicalJson(task.fields[f]!) === canonicalJson(e.fields[f]!)));
			if (!results.length || results.length > p.maxResultCount) throw new CompletionViolation(`task ${task.id} needs 1..${p.maxResultCount} matching results in transaction ${id}`);
			if (p.maxResultBytes !== undefined && results.reduce((n,r) => n + jsonBytes({type:r.type,types:r.types,fields:r.fields}), 0) > p.maxResultBytes) throw new CompletionViolation("completion results exceed maxResultBytes");
			for (const r of results) assigned.add(r.id);
		}
		if (tasks.length && s.entries.some(e => e.writtenUnder === id && e.takenBy === null && e.types.some(t => p.resultTypes.includes(t)) && !assigned.has(e.id))) throw new CompletionViolation("unmatched completion result");
	}
}
export const commitTxn = (s: SpaceState, now: number, id: string, as?: Target) => { assertMemberAdmission(s,"txn.commit"); settle(s, now); requireTxn(s, id, as); checkCompletion(s, id); checkRunBindings(s, id); charge(s, s.txns[id]!.reserved ?? 0); finish(s, id, true, now); serve(s, now); };
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
export function addWaiter(s: SpaceState, now: number, w: { template: Template; take: boolean; target: Target | null; timeout: number; deadline?:number; txnLeaseMs?: number; handback?: Json; as?: Target; consumer?: Principal; authorizedUntil?: number; originRequestKey?:string }): string {
	if (w.take) assertNotArchived(s);
	assertMemberAdmission(s,"wait");
	const deadline = w.deadline ?? deadlineOf(now, w.timeout);if(!Number.isFinite(deadline)&&deadline!==FOREVER||deadline<0)throw new IllegalArgumentError("invalid waiter deadline"); // FOREVER: waits until served or cancelled
	settle(s, now);
	if (w.as !== undefined) {
		const lim = limitsOf(s);
		if (s.waiters.filter((x) => x.target === w.as).length >= lim.maxWaitersPerOwner) throw new LimitError(`you already have ${lim.maxWaitersPerOwner} waits`);
		checkSize("handback", w.handback ?? null, lim);
	}
	checkOutbox(s);
	if (jsonBytes(w.handback ?? null) + EVENT_OVERHEAD > limitsOf(s).maxEventBytes) throw new ResourceExhausted("the wait's metadata exceeds maxEventBytes");
	const txnLeaseMs = grant(w.txnLeaseMs ?? ANY, now) - now; // same rules as every other lease: ANY, FOREVER, no negatives
	const rec: WaiterRec = { ...(w.originRequestKey?{originRequestKey:w.originRequestKey}:{}), id: newId(s, "w"), template: w.template, take: w.take, target: w.target, deadline, txnLeaseMs, handback: w.handback ?? null, ...(w.consumer ? { consumer: { ...w.consumer } } : {}), ...(w.authorizedUntil === undefined ? {} : { authorizedUntil: w.authorizedUntil }) };
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
	if(s.adminMaintenance)return;
	if(s.membership && ["adding","removing","detached","recoveryBlocked"].includes(s.membership.state))return;
	for (const w of [...s.waiters]) {
		if (w.claimKey) {
			const claim = s.rpc?.claims[w.claimKey];
			if (!claim || claim.state !== "pending") { dropWaiter(s, w); continue; }
			if (w.authorizedUntil !== undefined && now >= w.authorizedUntil) {
				if (w.deadline <= now) { decideClaim(s, now, w.claimKey, { state: "done", result: null }); dropWaiter(s, w); }
				continue;
			}
			const txn = w.requestTxn ?? null;
			if (txn !== null && !active(s, txn, now)) {
				decideClaim(s, now, w.claimKey, { state: "done", result: null, error: { code: "TransactionError", message: `transaction ${txn} is not active` } });
				dropWaiter(s, w); continue;
			}
			const found = find(s, w.template, txn, w.take);
			const miss = found.status !== "found" && (w.deadline <= now || (w.ifExists && found.status === "none"));
			if (found.status === "found") {
				if (directoryEntry(found.rec) && w.target !== null && (w.take || txn !== null)) { decideClaim(s,now,w.claimKey,{state:"done",result:null,error:{code:"PermissionDenied",message:"directory entries cannot be consumed or locked"}}); s.waiters.splice(s.waiters.indexOf(w),1); continue; }
				if(w.take) {try{assertMemberTake(s,found.rec,txn,now);}catch(e){if(s.membership?.state!=="draining")throw e;continue;}}
				if (w.take && txn === null && (s.completionProfiles ?? []).some(p => found.rec.types.includes(p.taskType))) {
					decideClaim(s, now, w.claimKey, { state: "done", result: null, error: { code: "CompletionViolation", message: "profiled tasks require a transaction" } });
					dropWaiter(s, w); continue;
				}
				const cost = jsonBytes(view(found.rec, s.spaceId)) + 256;
				if (!canCharge(s, cost)) { deferMaintenance(s, now, w.id); continue; }
				// the request's transaction may not be able to reserve the publication of an abort: the waiter stays and is
				// looked at again (serve runs inside every operation, so the caller's unrelated operation must not fail)
				if (w.take && txn !== null && found.rec.writtenUnder !== txn) { try { reserve(s, txn, publishCost(s, found.rec), limitsOf(s)); } catch (e) { if (e instanceof ResourceExhausted) continue; throw e; } }
				charge(s, cost);
				decideClaim(s, now, w.claimKey, { state: "done", result: view(apply(s, now, found.rec, txn, w.take), s.spaceId) as unknown as Json });
			} else if (miss) decideClaim(s, now, w.claimKey, { state: "done", result: null, ...(found.status === "locked" ? { locked: true } : {}) });
			else continue;
			dropWaiter(s, w); continue;
		}
		if (w.authorizedUntil !== undefined && now >= w.authorizedUntil) continue;
		const f = find(s, w.template, null, w.take);
		if (f.status !== "found") continue;
		if (directoryEntry(f.rec) && w.target !== null && w.take) continue;
		if(s.membership?.state==="draining" && w.take && !s.membership.policy?.completionProfiles.some(p=>f.rec.types.includes(p.taskType)))continue;
		const event: SpaceEvent = { kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(f.rec, s.spaceId) };
		if (!canCharge(s, jsonBytes(event) + 256)) { deferMaintenance(s, now, w.id); continue; }
		try {
			if (w.consumer) assertMailboxCapacity(s, w.consumer, event, now);
			else if (outboxBytes(s) + jsonBytes(event) + 1 > limitsOf(s).maxOutboxBytes) continue;
		} catch (e) { if (e instanceof ResourceExhausted) continue; throw e; }
		if (!w.take) { charge(s, jsonBytes(event) + 256); dropWaiter(s, w); queueEvent(s, now, event, w.consumer); continue; }
		const t: TxnRec = { id: newId(s, "t"), expires: until(now, w.txnLeaseMs), owner: w.target }; // the receiver commits it
		initializeMemberTxn(s,t,now);
		// waiters of requests carry their key; the search is for states from before that (claims on the disk are newer)
		const originRequestKey=w.originRequestKey ?? (diskMapOf(s.rpc?.claims) ? undefined : Object.entries(s.rpc?.claims??{}).find(([,c])=>c.method==="wait"&&c.result===w.id)?.[0]);if(originRequestKey!==undefined)t.originRequestKey=originRequestKey;
		s.txns[t.id] = t;
		// admission or the reservation of the abort's publication may be refused: the fresh transaction goes, the waiter
		// stays for a later serve (the caller's operation, which only settled, must not fail for it)
		try { assertMemberTake(s,f.rec,t.id,now); reserve(s, t.id, publishCost(s, f.rec), limitsOf(s)); }
		catch (e) { delete s.txns[t.id]; if (e instanceof ResourceExhausted) continue; throw e; }
		charge(s, jsonBytes(event) + 256);
		dropWaiter(s, w);
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
	const runs = s.txns[id]?.runs;
	delete s.txns[id];
	for (const run of Object.keys(runs ?? {})) completeFence(s, run, now);
	for (const r of s.regs) if (r.txn === id && r.consumer) queueEvent(s, now, { kind: "registrationClosed", eventId: r.id, seq: ++r.seq, handback: r.handback, target: r.target, reason: "transactionEnded" }, r.consumer, true);
	prune(s.regs, (r) => r.txn === id); // registrations under a txn are dropped when it completes
	const published: EntryRec[] = [];
	for (let i = s.entries.length - 1; i >= 0; i--) { // backwards: removals do not shift what is still to visit
		let e = s.entries[i]!;
		if (e.readBy.includes(id)) e = setEntry(s, e, { readBy: e.readBy.filter((t) => t !== id) });
		if (commit) {
			if (e.takenBy === id) { s.entries.splice(i, 1); continue; } // removal commits (also covers written-and-taken)
			if (e.writtenUnder === id) published.push(setEntry(s, e, { writtenUnder: null }));
		} else {
			if (e.writtenUnder === id) { s.entries.splice(i, 1); continue; } // aborted writes are discarded
			if (e.takenBy === id) { e = setEntry(s, e, { takenBy: null }); s.returned = (s.returned ?? 0) + 1; if (e.writtenUnder === null) logPut(s, now, e); } // takes are undone: the entry is back
		}
	}
	published.reverse(); // announced in write order
	for (const e of published) { logPut(s, now, e); notifyWrite(s, e, null, now, true); }
}

export function notify(s: SpaceState, now: number, tmpl: Template, txn: string | null, lease: number, handback: Json, target: Target | null, as?: Target, consumer?: Principal): { eventId: string; lease: Lease } {
	assertNotArchived(s);
	assertMemberAdmission(s,"notify");
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
	if(e && directoryEntry(e) && as !== undefined) throw new PermissionError("directory leases require trusted publication");
	const t = s.txns[id] as TxnRec | undefined;
	const r = s.regs.find((x) => x.id === id);
	const l = w ? { owner: w.target, set: (v: number) => { w.deadline = v; }, waiter: true }
		: e ? { owner: e.owner, set: (v: number) => { const cur = s.entries.find((x) => x.id === id); if (cur) setEntry(s, cur, { expires: v }); noteExpiry(s, v); }, waiter: false }
		: t ? { owner: t.owner, set: (v: number) => { t.expires = v; }, waiter: false }
		: r ? { owner: r.target, set: (v: number) => { r.expires = v; }, waiter: false }
		: undefined;
	if (!l) throw new UnknownLeaseError(id);
	if (!mayUse(l.owner, as)) throw new PermissionError(`lease ${id} belongs to another conversation`);
	return l;
}
export function renew(s: SpaceState, now: number, id: string, ms: number, as?: Target): number {
	assertAdminIdle(s);
	settle(s, now);
	const l = leased(s, id, as);
	const v = grant(ms, now);
	assertMemberRenew(s,id,v);
	if (s.txns[id]?.completionDeadline !== undefined && v > s.txns[id]!.completionDeadline!) throw new CompletionViolation("lease exceeds task completion boundary");
	for (const run of Object.keys(s.txns[id]?.runs ?? {})) if (s.runGates?.[run]?.fence || s.runGates?.[run]?.recovery) throw new RunGateConflict(`run ${run} is ${s.runGates[run]!.recovery ? "under recovery" : s.runGates[run]!.fence!.kind === "pause" ? "pausing" : "stopping"}; bound transactions may finish but not extend their lease`);
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
	// The watermark replaces the O(entries) sweep: `maintain` asks this before EVERY mutation,
	// so a full scan per operation was the dominant cost on large durable spaces.
	// loops, not Math.min(...spread): spreading a large array overflows the stack
	const knownMin = expiryWatermarks.get(s as SpaceState);
	let min = knownMin ?? FOREVER;
	if (knownMin === undefined) { for (const e of s.entries) if (e.expires < min) min = e.expires; expiryWatermarks.set(s as SpaceState, min); }
	for (const r of s.regs) {
		if (r.expires < min) min = r.expires;
		if (r.pending && r.lastEventAt !== undefined) min = Math.min(min, r.lastEventAt + intervalOf(s, r)); // bundled event due
	}
	for (const t of Object.values(s.txns)) if (t.expires < min) min = t.expires;
	for (const w of s.waiters) if (w.deadline < min) min = w.deadline;
	for (const b of Object.values(s.mailboxes?.boxes ?? {})) if (b.events.length) min = Math.min(min, b.events[0]!.seq <= b.acked ? 0 : b.events[0]!.at + limitsOf(s).mailboxTtlMs);
	for (const j of s.jobs ?? []) min = Math.min(min, j.retryAt ?? 0);
	// claims and generations: the last sweep left when the next one is due (claims.ts lowers it as records come), so
	// only a space that was not swept completely yet scans them; with 24 h of claims the scan cost ~60 ms per operation
	const sweepAt = s.rpc?.sweepAt;
	if (sweepAt !== undefined) min = Math.min(min, sweepAt);
	else if (s.rpc && diskMapOf(s.rpc.claims)) min = 0; // claims on the disk are never scanned: a sweep now sets sweepAt
	else if (s.rpc) {
		const keep = limitsOf(s).claimResultMs;
		for (const c of Object.values(s.rpc.claims)) if (c.state !== "pending" && c.decidedAt !== undefined) {
			const at = c.decidedAt + keep;
			min = Math.min(min, c.resultExpired ? Math.max(at, (s.rpc.generations[c.generation]?.admitUntil ?? 0) + 1) : at);
		}
		const usedGenerations = new Set(Object.values(s.rpc.claims).map(c => c.generation));
		for (const [id, g] of Object.entries(s.rpc.generations)) if (!usedGenerations.has(id)) min = Math.min(min, g.admitUntil + 1);
	}
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
	assertAdminIdle(s);
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	let n = 0;
	for (const e of s.entries) {
		if (e.restoredUnverified && txn !== null) continue;
		const st = standing(s, e, now); // what `txn` itself took is "locked": a transaction does not see its own takes
		if ((st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)) n++;
	}
	return n;
}

/** The largest `limit` the agent tool `space_list` accepts (its schema, index.ts); `list` itself has no cap for host code. */
export const MAX_LIST = 1000;
/**
 * All entries a `read` could see, oldest first, up to the optional `limit` (all matches by default). Does not lock or modify
 * anything, so it is safe for dashboards. `as` is checked against `txn` like for any other use of a transaction.
 */
export function list(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null, limit = Number.MAX_SAFE_INTEGER, as?: Target): EntryView[] {
	assertAdminIdle(s);
	if (!Number.isInteger(limit) || limit < 1) throw new IllegalArgumentError("limit must be a positive integer");
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	const out: EntryView[] = [];
	for (const e of s.entries) {
		if (e.restoredUnverified && txn !== null) continue;
		if (out.length >= limit) break;
		const st = standing(s, e, now); // the same view of the space as count() has
		if ((st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)) out.push(view(e, s.spaceId));
	}
	return out;
}

/** Bytes a page needs besides its items: the envelope, the cursor and separators. */
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
	const eligible: EntryView[] = [];
	for (const e of s.entries) {
		if (seqOf(e.id) <= after || (e.restoredUnverified && txn !== null)) continue;
		const st = standing(s, e, now);
		if (st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) if (matches(tmpl, e)) eligible.push(view(e, s.spaceId));
	}
	return bytePage(eligible, 0, cap, (items, next) => ({ items, next: next === null ? null : String(seqOf(eligible[next - 1]!.id)), rev: revisionOf(s), streamId: streamIdOf(s) }));
}

// ---- revisions and the change stream (src/stream.ts)

const putOp = (e: EntryRec): Op => ({ op: "put", id: e.id, type: e.type, types: [...e.types], fields: clone(e.fields), expires: e.expires, owner: e.owner, ...(e.restoredUnverified ? { restoredUnverified: true as const } : {}) });
function logPut(s: SpaceState, now: number, e: EntryRec): void { record(s, now, putOp(e), limitsOf(s).maxLogBytes); }
export function importRestoredEntry(s: SpaceState, now: number, e: EntryRec): boolean {
	const cost = jsonBytes(e) + jsonBytes(putOp(e)) + 256;
	const lim = limitsOf(s), used = entryBytes(s) + jsonBytes(e.fields);
	if (s.entries.some(x => x.id === e.id) || s.entries.length >= lim.maxEntries || jsonBytes(e.fields) > lim.maxEntryBytes || used > lim.maxSpaceBytes || used + overheadBytes(s) + cost > lim.maxDocBytes) throw new ResourceExhausted("restored entry violates current space limits or has a duplicate id");
	if (cost + 1024 > lim.maxCommitBytes) throw new ResourceExhausted("restored entry cannot fit the commit budget");
	if (!maintenanceStep(s, cost, now, `restore-entry:${e.id}`)) return false;
	s.entries.push(clone(e)); noteExpiry(s, e.expires); logPut(s, now, e); return true;
}
export function releaseRestoredEntry(s: SpaceState, now: number, e: EntryRec): boolean {
	const lim = limitsOf(s), preview = clone(e); delete preview.restoredUnverified;
	checkEventSize(s, preview, lim);
	const publication = publishCost(s, preview), update = jsonBytes(preview) + 256;
	if (publication + update + COMMIT_FIXED > lim.maxCommitBytes) throw new ResourceExhausted("restored release and fanout cannot fit the commit budget");
	if (!canCharge(s, publication + update)) { deferMaintenance(s, now, `release:${e.id}`); return false; }
	reserve(s, null, publication, lim); charge(s, update);
	const released = setEntry(s, e, {}, ["restoredUnverified"]); logPut(s, now, released); notifyWrite(s, released, null, now, true); return true;
}

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
	assertAdminIdle(s);
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
	const r: SpaceStats = { entries: 0, byType: {}, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: s.outbox.length, returned: s.returned ?? 0, bytes: { entries: 0, outbox: outboxBytes(s), claims: claimBytes(s), waiters: jsonBytes(s.waiters), registrations: jsonBytes(s.regs), txns: jsonBytes(s.txns), total: 0 } };
	for (const e of s.entries) {
		r.bytes!.entries += e.size ?? jsonBytes(e.fields);
		const st = standing(s, e, now);
		if (st === "visible") { r.entries++; r.byType[e.type] = (r.byType[e.type] ?? 0) + 1; } else r[st]++;
		if (st === "visible" && e.takenBy !== null) r.returned++; // taken by a lapsed transaction: back once settled
	}
	for (const t of Object.values(s.txns)) if (t.expires > now) r.txns++;
	for (const w of s.waiters) if (w.deadline > now) r.waiters++;
	for (const g of s.regs) if (g.expires > now) r.registrations++;
	// the whole document as stored; claims on the disk by their running tally (they are not read for this)
	r.bytes!.total = docBytes(s);
	return r;
}

/** Host lifecycle action; each closing event uses the existing bounded mailbox/fanout path. */
export function closeRegistrationsForRemoval(s:SpaceState,now:number):void {for(const r of [...s.regs]){queueEvent(s,now,{kind:"registrationClosed",eventId:r.id,seq:++r.seq,handback:r.handback,target:r.target,reason:"removing"},r.consumer,true);s.regs.splice(s.regs.indexOf(r),1);}touch(s,now);}

/** Trusted administrative purge only; the caller must commit a separately scoped audit atomically. */
export function purgeTasks(s:SpaceState,now:number,template:Template):number {
	assertAdminIdle(s);
 settle(s,now);
 const tasks=s.entries.filter(e=>matches(template,e));
 if(tasks.some(e=>!(s.completionProfiles??[]).some(p=>e.types.includes(p.taskType))))throw new PermissionError("purgeTasks accepts only profiled tasks");
 if(tasks.some(e=>e.takenBy!==null||e.writtenUnder!==null||e.readBy.length))throw new TransactionError("purgeTasks cannot erase reserved work");
 const cost=tasks.reduce((n,e)=>n+publishCost(s,e),0);charge(s,cost);
 for(const e of tasks){logDel(s,now,e.id);s.entries.splice(s.entries.indexOf(e),1);}
 touch(s,now);return tasks.length;
}

// RunGates (docs/betrieb-und-mobile-steuerung.md §6): per-run control state that the core enforces on every take,
// so direct, waiting and host takes cannot bypass a pause. A take binds its transaction to the gate's revision.
const MAX_RUN_GATES = 256, MAX_GATE_HISTORY = 32, GATE_COST = 1024;
const validId = (v: unknown): v is string => typeof v === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(v);
/** The run a gated task belongs to: undefined if the type is not gated, null if the gate field is missing. */
function runOf(s: Readonly<SpaceState>, types: readonly string[], fields: Fields): string | null | undefined {
	for (const p of s.completionProfiles ?? []) if (p.gateField !== undefined && types.includes(p.taskType)) { const v = fields[p.gateField]; return typeof v === "string" ? v : null; }
	return undefined;
}
function takeableRun(s: Readonly<SpaceState>, run: string | null): boolean {
	const g = run === null ? undefined : s.runGates?.[run];
	return g !== undefined && g.state === "running" && !g.fence && !g.recovery;
}
function assertRunWrite(s: Readonly<SpaceState>, entry: EntryDraft, txn: string | null): void {
	const types = [entry.type, ...(entry.types ?? [])];
	for (const p of s.completionProfiles ?? []) {
		if (p.gateField === undefined) continue;
		const run = entry.fields[p.gateField];
		if (types.includes(p.taskType)) {
			const g = typeof run === "string" ? s.runGates?.[run] : undefined;
			if (!g || g.state !== "preparing" || g.fence || g.recovery) throw new RunGateConflict(`${p.taskType} entries are written only while their run is preparing`);
		}
		if (types.some(t => p.resultTypes.includes(t)) && (txn === null || typeof run !== "string" || s.txns[txn]?.runs?.[run] === undefined)) throw new CompletionViolation(`${entry.type} needs a transaction bound to its run`);
	}
}
function checkRunBindings(s: Readonly<SpaceState>, id: string): void {
	for (const [run, revision] of Object.entries(s.txns[id]?.runs ?? {})) {
		const g = s.runGates?.[run];
		if (!g || g.revision !== revision || g.state !== "running") throw new RunGateConflict(`run ${run} changed while transaction ${id} was bound to it`);
	}
}
const boundTxns = (s: Readonly<SpaceState>, run: string): number => Object.values(s.txns).filter(t => t.runs?.[run] !== undefined).length;
function recordGate(g: RunGateRec, c: { revision: number; commandId: string; kind: RunGateKind }, state: RunGateState, now: number): void {
	Object.assign(g, { revision: c.revision, commandId: c.commandId, kind: c.kind, state, at: now });
	g.history.push({ revision: c.revision, commandId: c.commandId, kind: c.kind, state });
	if (g.history.length > MAX_GATE_HISTORY) g.history.splice(0, g.history.length - MAX_GATE_HISTORY);
}
/** Ends a pause/stop barrier once no transaction is bound to the run any more. */
function completeFence(s: SpaceState, run: string, now: number): void {
	const g = s.runGates?.[run];
	if (!g?.fence || boundTxns(s, run) > 0) return;
	const f = g.fence;
	delete g.fence;
	recordGate(g, f, f.kind === "pause" ? "paused" : "stopped", now);
	if (f.recoveryId !== undefined && g.recovery?.id === f.recoveryId) { delete g.recovery; delete g.historical; } // the decision's barrier is confirmed
	touch(s, now);
}
function gateAck(s: Readonly<SpaceState>, g: RunGateRec, c: RunGateCommand, state: RunGateState, phase: RunGateAck["phase"]): RunGateAck {
	return { runId: g.runId, spaceId: s.spaceId ?? null, incarnation: s.incarnation ?? null, authorityId: s.acceptedAuthorityId ?? s.membership?.authorityId ?? null, revision: c.revision, state, commandId: c.commandId, kind: c.kind, phase, boundTxns: boundTxns(s, g.runId) };
}
/**
 * Applies one controller command to a run's gate (trusted host code only). The same revision with the same command
 * returns the stored confirmation; with another command it is a RunGateConflict and changes nothing. Older revisions
 * are refused. Pause and stop first fence the run (no new binding, no lease extension) and change the gate only
 * when no bound transaction is left: until then the ack's phase is "fenced".
 * Under a recovery entry fence only a decision of that recovery applies: its history replays (progress of the same
 * decision), then its expected gate state is compared and set; old commands never complete a restored barrier.
 */
export function applyRunGate(s: SpaceState, now: number, c: RunGateCommand): RunGateAck {
	if (!c || !validId(c.runId) || !validId(c.commandId) || !Number.isSafeInteger(c.revision) || c.revision < 1 || !["prepare", "release", "pause", "resume", "stop"].includes(c.kind) || (c.recoveryId !== undefined && !validId(c.recoveryId)) || (c.expect !== undefined && (!c.expect || !Number.isSafeInteger(c.expect.revision) || !["preparing", "running", "paused", "stopped"].includes(c.expect.state)))) throw new IllegalArgumentError("invalid RunGate command");
	assertAdminIdle(s);
	settle(s, now);
	const spend = () => { // every gate mutation is bounded metadata, charged like other maintenance
		if (!canCharge(s, GATE_COST)) throw new ResourceExhausted("the RunGate change exceeds the remaining commit budget");
		if (overheadBytes(s) + GATE_COST + entryBytes(s) > limitsOf(s).maxDocBytes) throw new ResourceExhausted("the RunGate change exceeds maxDocBytes");
		charge(s, GATE_COST);
	};
	s.runGates ??= {};
	const gates = s.runGates; // re-read: durable documents track changes through the stored object, not the literal
	let g = Object.hasOwn(gates, c.runId) ? gates[c.runId] : undefined;
	if (!g) {
		// stop without a gate leaves a terminal gate, so a late prepare of this run is refused
		if (c.kind !== "prepare" && c.kind !== "stop") throw new RunGateConflict(`run ${c.runId} has no gate on this Member`);
		if (c.kind === "prepare" && c.recoveryId !== undefined) throw new RunGateConflict("a recovery decision cannot prepare a run");
		if (c.kind === "prepare" && !(s.completionProfiles ?? []).some(p => p.gateField !== undefined)) throw new RunGateConflict("this Space has no gated completion profile; a gate would not stop any take");
		if (c.expect !== undefined) throw new RunGateConflict(`run ${c.runId} has no gate on this Member, but the decision expected one`);
		if (Object.keys(gates).length >= MAX_RUN_GATES) throw new ResourceExhausted(`at most ${MAX_RUN_GATES} run gates per Space`);
		spend();
		const state = c.kind === "prepare" ? "preparing" : "stopped";
		gates[c.runId] = { runId: c.runId, revision: 0, state, commandId: c.commandId, kind: c.kind, at: now, history: [] };
		g = gates[c.runId]!;
		recordGate(g, c, state, now);
		touch(s, now);
		return gateAck(s, g, c, state, "applied");
	}
	const same = (x: { commandId: string; kind: RunGateKind }) => x.commandId === c.commandId && x.kind === c.kind;
	const conflict = () => new RunGateConflict(`revision ${c.revision} of run ${c.runId} belongs to another command`);
	if (g.recovery && c.recoveryId !== g.recovery.id) throw new RunGateConflict(`run ${c.runId} is under recovery ${g.recovery.id}; only its decision applies`);
	const done = g.history.find(h => h.revision === c.revision);
	if (done) { if (!same(done)) throw conflict(); return gateAck(s, g, c, done.state, "applied"); }
	if (g.fence && g.fence.revision === c.revision) {
		if (!same(g.fence) || g.fence.recoveryId !== c.recoveryId) throw conflict();
		completeFence(s, c.runId, now);
		return g.fence ? gateAck(s, g, c, g.state, "fenced") : gateAck(s, g, c, g.state, "applied");
	}
	if (c.recoveryId !== undefined && !g.recovery) throw new RunGateConflict(`run ${c.runId} is not under recovery ${c.recoveryId}`);
	const recovering = g.recovery !== undefined;
	if (recovering) {
		if (c.expect && (g.revision !== c.expect.revision || g.state !== c.expect.state)) throw new RunGateConflict(`run ${c.runId} changed since the reviewed view (${g.state}/${g.revision}); review again`);
		if (g.fence) {
			if (boundTxns(s, c.runId) > 0) throw new RunGateConflict(`run ${c.runId} still has bound transactions under an unfinished ${g.fence.kind}`);
			delete g.fence; // an unfinished barrier of the old history: the reviewed decision replaces it
		}
	}
	if (c.revision <= Math.max(g.revision, g.fence?.revision ?? 0, g.restored?.maxRevision ?? 0)) throw new RunGateConflict(`revision ${c.revision} of run ${c.runId} is older than the gate`);
	if (g.fence) throw new RunGateConflict(`run ${c.runId} has an unfinished ${g.fence.kind} at revision ${g.fence.revision}`);
	if (g.state === "stopped" && !(recovering && c.kind === "stop")) throw new RunGateConflict(`run ${c.runId} is stopped`);
	if (recovering && (g.restored?.state === "stopped") && c.kind !== "stop") throw new RunGateConflict(`run ${c.runId} was stopped in the restored history`);
	// Under recovery a decision ends in paused or stopped; a resume follows only after that barrier.
	const from: Record<RunGateKind, RunGateState[]> = recovering
		? { prepare: [], release: [], resume: [], pause: ["running", "paused"], stop: ["preparing", "running", "paused", "stopped"] }
		: { prepare: [], release: ["preparing"], resume: ["paused"], pause: ["running"], stop: ["preparing", "running", "paused"] };
	if (!from[c.kind].includes(g.state)) throw new RunGateConflict(`cannot ${c.kind} run ${c.runId} while it is ${g.state}${recovering ? " under recovery" : ""}`);
	spend();
	if (c.kind === "release" || c.kind === "resume") {
		recordGate(g, c, "running", now);
		touch(s, now);
		serve(s, now); // waiting takes may now match
		return gateAck(s, g, c, "running", "applied");
	}
	if (g.state !== "running") { // nothing can be bound: confirm or stop at once
		recordGate(g, c, c.kind === "pause" ? "paused" : "stopped", now);
		if (recovering) { delete g.recovery; delete g.historical; }
		touch(s, now);
		return gateAck(s, g, c, g.state, "applied");
	}
	g.fence = { revision: c.revision, commandId: c.commandId, kind: c.kind as "pause" | "stop", at: now, ...(recovering ? { recoveryId: c.recoveryId! } : {}) };
	touch(s, now);
	completeFence(s, c.runId, now);
	return g.fence ? gateAck(s, g, c, g.state, "fenced") : gateAck(s, g, c, g.state, "applied");
}
export type RunRecoveryView = {
	runId: string; spaceId: string | null; incarnation: string | null; authorityId: string | null; recoveryId: string; present: boolean;
	gate: { revision: number; state: RunGateState; commandId: string; kind: RunGateKind } | null;
	fence: { revision: number; commandId: string; kind: "pause" | "stop" } | null;
	restored: RunGateEvidence | null; historical: boolean; stopped: boolean; maxRevision: number; boundTxns: number; stable: boolean;
};
function recoveryView(s: Readonly<SpaceState>, runId: string, recoveryId: string): RunRecoveryView {
	const g = Object.hasOwn(s.runGates ?? {}, runId) ? s.runGates![runId] : undefined;
	const bound = g ? boundTxns(s, runId) : 0;
	const base = { runId, spaceId: s.spaceId ?? null, incarnation: s.incarnation ?? null, authorityId: s.acceptedAuthorityId ?? s.membership?.authorityId ?? null, recoveryId };
	if (!g) return { ...base, present: false, gate: null, fence: null, restored: null, historical: false, stopped: false, maxRevision: 0, boundTxns: 0, stable: true };
	const fence = g.fence ? { revision: g.fence.revision, commandId: g.fence.commandId, kind: g.fence.kind } : null;
	return { ...base, present: true, gate: { revision: g.revision, state: g.state, commandId: g.commandId, kind: g.kind }, fence, restored: g.restored ? clone(g.restored) : null, historical: !!g.historical,
		stopped: g.state === "stopped" || g.restored?.state === "stopped" || g.history.some(h => h.state === "stopped"),
		maxRevision: Math.max(g.revision, fence?.revision ?? 0, g.restored?.maxRevision ?? 0, ...g.history.map(h => h.revision)), boundTxns: bound, stable: bound === 0 };
}
/**
 * Installs the recovery entry fence of `recoveryId` (no new binding, no lease extension, no task writes) and returns
 * the run's recovery view. Bound transactions may still finish; the view is `stable` once none is left. A newer
 * recovery replaces an older one. Missing gates are reported, not invented.
 */
export function recoverRunGate(s: SpaceState, now: number, o: { runId: string; recoveryId: string }): RunRecoveryView {
	if (!o || !validId(o.runId) || !validId(o.recoveryId)) throw new IllegalArgumentError("invalid run recovery request");
	assertAdminIdle(s);
	settle(s, now);
	const g = Object.hasOwn(s.runGates ?? {}, o.runId) ? s.runGates![o.runId] : undefined;
	if (g && g.recovery?.id !== o.recoveryId) {
		if (!canCharge(s, GATE_COST)) throw new ResourceExhausted("the recovery fence exceeds the remaining commit budget");
		charge(s, GATE_COST);
		g.recovery = { id: o.recoveryId, at: now };
		touch(s, now);
	}
	return recoveryView(s, o.runId, o.recoveryId);
}
/** Restore support: every gate of the replaced data becomes historical evidence under the restore's recovery fence. */
export function fenceGatesForRestore(s: SpaceState, now: number, recoveryId: string): void {
	for (const g of Object.values(s.runGates ?? {})) { g.recovery = { id: recoveryId, at: now }; g.historical = true; }
	if (s.runGates) touch(s, now);
}
/** Restore support: compact evidence of one snapshot gate; installs a fenced historical gate if the run is unknown here. */
export function importRestoredGate(s: SpaceState, now: number, source: RunGateRec, recoveryId: string): void {
	const ev: RunGateEvidence = { revision: source.revision, state: source.state, commandId: source.commandId, kind: source.kind, maxRevision: Math.max(source.revision, source.fence?.revision ?? 0, ...source.history.map(h => h.revision)), ...(source.fence ? { fence: { revision: source.fence.revision, commandId: source.fence.commandId, kind: source.fence.kind } } : {}) };
	s.runGates ??= {};
	const gates = s.runGates;
	const local = Object.hasOwn(gates, source.runId) ? gates[source.runId] : undefined;
	if (local) { local.restored = ev; local.recovery = { id: recoveryId, at: now }; local.historical = true; touch(s, now); return; }
	if (Object.keys(gates).length >= MAX_RUN_GATES) throw new ResourceExhausted(`at most ${MAX_RUN_GATES} run gates per Space`);
	gates[source.runId] = { runId: source.runId, revision: source.revision, state: source.state, commandId: source.commandId, kind: source.kind, at: now, history: [{ revision: source.revision, commandId: source.commandId, kind: source.kind, state: source.state }], recovery: { id: recoveryId, at: now }, historical: true, restored: ev, ...(source.fence ? { fence: { revision: source.fence.revision, commandId: source.fence.commandId, kind: source.fence.kind, at: now } } : {}) };
	touch(s, now);
}
/** Read-only view of a run's gate, for workers, monitors and controllers. */
export function runGateView(s: Readonly<SpaceState>, runId: string): (Omit<RunGateRec, "history"> & { boundTxns: number }) | null {
	const g = Object.hasOwn(s.runGates ?? {}, runId) ? s.runGates![runId] : undefined;
	if (!g) return null;
	const { history: _h, ...rest } = clone(g);
	return { ...rest, boundTxns: boundTxns(s, runId) };
}
