// Pure JavaSpaces semantics (Jini JavaSpaces spec v2.2) over a plain JSON state. No pi imports.
// Functions mutate `state` in place (it is a document draft inside a commit) and take `now` explicitly.
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
	notifyIntervalMs: number; // a conversation's subscription sends at most one event per interval (0: no limit)
};
export const DEFAULT_LIMITS: Limits = { maxEntryBytes: 64 * 1024, maxTypeChars: 128, maxTypes: 16, maxEntries: 10_000, maxEntriesPerOwner: 1_000, maxRegsPerOwner: 20, maxWaitersPerOwner: 20, maxTxnsPerOwner: 20, notifyIntervalMs: 1000 };
export class LimitError extends Error {}
export class IllegalArgumentError extends Error {}
/** A conversation tried to use or change something that is not its own. */
export class PermissionError extends Error {}
export class TransactionError extends Error {}
export class UnknownLeaseError extends Error {}

/** An entry: a typed group of fields. `types` is the type followed by its supertypes, fixed at write time. */
export type EntryDraft = { type: string; types?: string[]; fields: Fields };
/** A template: absent/null type and fields are wildcards. A null template (`null`) matches any entry. */
export type Template = { type?: string | null; fields?: Fields } | null;

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
};
/** `owner`: the only conversation that may use, commit, abort, renew or cancel it; null: host code only. */
export type TxnRec = { id: string; expires: number; owner: Target | null };
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
};
/** A parked read/take for a conversation: served by the space when a match appears, instead of a blocked call. */
export type WaiterRec = { id: string; template: Template; take: boolean; target: Target | null; deadline: number; txnLeaseMs: number; handback: Json };
/** `owner`: who wrote it (a conversation id), or null for host code, so a reader can judge where content comes from. */
export type EntryView = { id: string; type: string; types: string[]; fields: Fields; owner: Target | null };
export type SpaceEvent = {
	kind: "entry" | "waiter" | "timeout"; // entry: notify; waiter: a parked op was served; timeout: its deadline passed
	eventId: string;
	seq: number;
	handback: Json;
	target: Target | null;
	entry?: EntryView; // for a bundled event: the latest of `count` matching writes
	count?: number; // writes this notify event stands for (> 1: bundled by the rate limit)
	tries?: number; // failed deliveries so far
	retryAt?: number; // not before this time (backoff after a failed delivery)
	txn?: string; // a served take-waiter holds the entry under this transaction until committed or its lease lapses
};
/** `returned`: entries given back by aborted or expired transactions, ever. Only changes in commits that change the
 * space anyway (a transaction ends), so keeping it durable wakes nobody. */
export type SpaceState = { nextId: number; entries: EntryRec[]; txns: Record<string, TxnRec>; regs: RegRec[]; waiters: WaiterRec[]; outbox: SpaceEvent[]; returned: number ; limits?: Partial<Limits> };

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
		returned: v.returned ?? d.returned,
	};
};
export type Lease = { id: string; expires: number };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)); // draft proxies are not structured-cloneable
const encoder = new TextEncoder();
const jsonBytes = (v: unknown): number => encoder.encode(JSON.stringify(v) ?? "").length;
export const limitsOf = (s: Readonly<SpaceState>): Limits => ({ ...DEFAULT_LIMITS, ...(s.limits ?? {}) });
/** Override quotas for this space (host code). Values must be positive integers; omitted ones keep their value. */
export function setLimits(s: SpaceState, l: Partial<Limits>): Limits {
	for (const [k, v] of Object.entries(l)) {
		if (!(k in DEFAULT_LIMITS) || typeof v !== "number" || !Number.isInteger(v) || v < (k === "notifyIntervalMs" ? 0 : 1)) throw new IllegalArgumentError(`bad limit ${k}`);
	}
	s.limits = { ...(s.limits ?? {}), ...l };
	return limitsOf(s);
}
const ownedBy = (as: Target) => (o: { owner: Target | null }) => o.owner === as;
function checkSize(what: string, v: unknown, lim: Limits): void {
	const n = jsonBytes(v);
	if (n > lim.maxEntryBytes) throw new LimitError(`${what} is ${n} bytes; the limit is ${lim.maxEntryBytes}`);
}
const newId = (s: SpaceState, p: string) => `${p}${s.nextId++}`;

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

export function matches(t: Template, e: { types: string[]; fields: Fields }): boolean {
	if (t === null) return true;
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
	for (;;) {
		let t: TxnRec | undefined;
		for (const x of Object.values(s.txns)) if (x.expires <= now && (t === undefined || x.expires < t.expires)) t = x;
		if (t === undefined) break;
		const at = t.expires;
		expire(s, at); // what lapsed up to the abort
		finish(s, t.id, false, at);
		serve(s, at); // the abort may have returned entries that a waiter is waiting for
	}
	expire(s, now);
	serve(s, now);
	flushRegs(s, now);
}
function expire(s: SpaceState, at: number): void {
	for (const r of s.regs) if (r.expires <= at && r.pending && r.pendingEntry) emit(s, r, r.pendingEntry, r.pending, at); // do not lose a bundle
	s.entries = s.entries.filter((e) => e.expires > at);
	s.regs = s.regs.filter((r) => r.expires > at);
	for (const w of s.waiters) if (w.deadline <= at) s.outbox.push({ kind: "timeout", eventId: w.id, seq: 1, handback: w.handback, target: w.target });
	s.waiters = s.waiters.filter((w) => w.deadline > at);
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
		id: newId(s, "e"),
		type: entry.type,
		types,
		fields: clone(entry.fields),
		expires,
		writtenUnder: txn,
		takenBy: null,
		readBy: [],
		owner: as ?? null,
	};
	if (expires <= now) return { id: rec.id, expires }; // born expired (lease 0): never visible, so never announced or served
	s.entries.push(rec);
	notifyWrite(s, rec, txn, now);
	if (txn === null) serve(s, now);
	return { id: rec.id, expires };
}

// Registrations fire for committed writes (null-txn registrations) and, for a registration made under transaction
// T, also for writes under T. A null-txn registration does not see an entry written and taken inside one transaction.
function emit(s: SpaceState, r: RegRec, e: EntryView, count: number, now: number): void {
	r.seq++;
	r.lastEventAt = now;
	r.pending = 0;
	delete r.pendingEntry;
	s.outbox.push({ kind: "entry", eventId: r.id, seq: r.seq, handback: r.handback, target: r.target, entry: e, ...(count > 1 ? { count } : {}) });
}
function notifyWrite(s: SpaceState, e: EntryRec, txn: string | null, now: number): void {
	for (const r of s.regs) {
		// Spec: a registration under T is notified of writes under T *in addition to* those a null-txn registration gets.
		const applies = txn === null ? true : r.txn === txn;
		if (!applies || !matches(r.template, e)) continue;
		if (r.minIntervalMs && r.lastEventAt !== undefined && now < r.lastEventAt + r.minIntervalMs) {
			r.pending = (r.pending ?? 0) + 1; // too soon after the last event: counted, sent bundled later
			r.pendingEntry = view(e);
			continue;
		}
		emit(s, r, view(e), 1 + (r.pending ?? 0), now); // pending writes (if any) ride along with this one
	}
}
/** Send the bundled event for registrations whose interval is over. */
function flushRegs(s: SpaceState, now: number): void {
	for (const r of s.regs) {
		if (r.pending && r.pendingEntry && r.lastEventAt !== undefined && now >= r.lastEventAt + (r.minIntervalMs ?? 0)) emit(s, r, r.pendingEntry, r.pending, now);
	}
}

export type Probe = { status: "found"; entry: EntryRec } | { status: "none" } | { status: "locked" };

/** One non-waiting attempt. `locked` means matches exist, but every one conflicts with another transaction. */
export function probe(s: SpaceState, now: number, tmpl: Template, txn: string | null, take: boolean, as?: Target): Probe {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn, as);
	const f = find(s, tmpl, txn, take);
	return f.status === "found" ? { status: "found", entry: apply(s, f.rec, txn, take) } : f;
}

export const view = (e: EntryRec): EntryView => ({ id: e.id, type: e.type, types: [...e.types], fields: clone(e.fields), owner: e.owner });

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

function apply(s: SpaceState, e: EntryRec, txn: string | null, take: boolean): EntryRec {
	const copy = clone(e);
	if (take) {
		if (txn === null || e.writtenUnder === txn) s.entries.splice(s.entries.indexOf(e), 1); // gone, or never visible outside
		else e.takenBy = txn;
	} else if (txn !== null && !e.readBy.includes(txn)) e.readBy.push(txn);
	return copy;
}

export function createTxn(s: SpaceState, now: number, lease: number, as?: Target): Lease {
	settle(s, now);
	if (as !== undefined && Object.values(s.txns).filter(ownedBy(as)).length >= limitsOf(s).maxTxnsPerOwner) throw new LimitError(`you already have ${limitsOf(s).maxTxnsPerOwner} open transactions`);
	const t: TxnRec = { id: newId(s, "t"), expires: grant(lease, now), owner: as ?? null };
	s.txns[t.id] = t;
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
export const commitTxn = (s: SpaceState, now: number, id: string, as?: Target) => { settle(s, now); requireTxn(s, id, as); finish(s, id, true, now); serve(s, now); };
export const abortTxn = (s: SpaceState, now: number, id: string, as?: Target) => { settle(s, now); requireTxn(s, id, as); finish(s, id, false, now); serve(s, now); };
/** Abort `id` if it is still active (host side, e.g. when the holder of a served take can no longer be reached). */
export function releaseTxn(s: SpaceState, now: number, id: string): boolean {
	settle(s, now);
	if (!s.txns[id]) return false;
	finish(s, id, false, now);
	serve(s, now);
	return true;
}

/** Park a read/take for `target`; the space serves it later (or reports a timeout) through the outbox. */
export function addWaiter(s: SpaceState, now: number, w: { template: Template; take: boolean; target: Target | null; timeout: number; txnLeaseMs?: number; handback?: Json; as?: Target }): string {
	const deadline = deadlineOf(now, w.timeout); // FOREVER: waits until served or cancelled
	settle(s, now);
	if (w.as !== undefined) {
		const lim = limitsOf(s);
		if (s.waiters.filter((x) => x.target === w.as).length >= lim.maxWaitersPerOwner) throw new LimitError(`you already have ${lim.maxWaitersPerOwner} waits`);
		checkSize("handback", w.handback ?? null, lim);
	}
	const txnLeaseMs = grant(w.txnLeaseMs ?? ANY, now) - now; // same rules as every other lease: ANY, FOREVER, no negatives
	const rec: WaiterRec = { id: newId(s, "w"), template: w.template, take: w.take, target: w.target, deadline, txnLeaseMs, handback: w.handback ?? null };
	s.waiters.push(rec);
	serve(s, now);
	return rec.id;
}
export function cancelWaiter(s: SpaceState, id: string): boolean {
	const n = s.waiters.length;
	s.waiters = s.waiters.filter((w) => w.id !== id);
	return s.waiters.length < n;
}

// A take-waiter takes its entry under a fresh transaction, so a lost delivery is not a lost job: the entry returns
// when that transaction's lease lapses unless the receiver commits it.
function serve(s: SpaceState, now: number): void {
	for (const w of [...s.waiters]) {
		const f = find(s, w.template, null, w.take);
		if (f.status !== "found") continue;
		s.waiters.splice(s.waiters.indexOf(w), 1);
		if (!w.take) { s.outbox.push({ kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(apply(s, f.rec, null, false)) }); continue; }
		const t: TxnRec = { id: newId(s, "t"), expires: until(now, w.txnLeaseMs), owner: w.target }; // the receiver commits it
		s.txns[t.id] = t;
		s.outbox.push({ kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(apply(s, f.rec, t.id, true)), txn: t.id });
	}
}

function finish(s: SpaceState, id: string, commit: boolean, now: number): void {
	delete s.txns[id];
	s.regs = s.regs.filter((r) => r.txn !== id); // registrations under a txn are dropped when it completes
	const keep: EntryRec[] = [];
	const published: EntryRec[] = [];
	for (const e of s.entries) {
		e.readBy = e.readBy.filter((t) => t !== id);
		if (commit) {
			if (e.takenBy === id) continue; // removal commits (also covers written-and-taken)
			if (e.writtenUnder === id) { e.writtenUnder = null; published.push(e); }
		} else {
			if (e.writtenUnder === id) continue; // aborted writes are discarded
			if (e.takenBy === id) { e.takenBy = null; s.returned = (s.returned ?? 0) + 1; } // takes are undone: the entry is back
		}
		keep.push(e);
	}
	s.entries = keep;
	for (const e of published) notifyWrite(s, e, null, now);
}

export function notify(s: SpaceState, now: number, tmpl: Template, txn: string | null, lease: number, handback: Json, target: Target | null, as?: Target): { eventId: string; lease: Lease } {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn, as);
	if (as !== undefined) {
		const lim = limitsOf(s);
		if (s.regs.filter((x) => x.target === as).length >= lim.maxRegsPerOwner) throw new LimitError(`you already have ${lim.maxRegsPerOwner} subscriptions`);
		checkSize("handback", handback, lim);
		// "Everything" is a firehose: every write anywhere would wake this conversation.
		if (tmpl === null || (tmpl.type == null && !Object.values(tmpl.fields ?? {}).some((v) => v != null))) throw new IllegalArgumentError("a subscription needs a type or at least one field");
	}
	const r: RegRec = { id: newId(s, "n"), template: tmpl, expires: grant(lease, now), txn, handback, target, seq: 0 };
	if (as !== undefined && limitsOf(s).notifyIntervalMs > 0) r.minIntervalMs = limitsOf(s).notifyIntervalMs;
	s.regs.push(r);
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
	return v;
}
export function cancel(s: SpaceState, now: number, id: string, as?: Target): void {
	settle(s, now);
	const l = leased(s, id, as);
	if (l.waiter) { cancelWaiter(s, id); return; } // cancelled waits send no timeout event
	l.set(now); // settle() removes it; a cancelled txn lease aborts the transaction
	settle(s, now);
}

/** Earliest time something can change without a commit (lease expiry); the waiter must wake then. */
export function nextExpiry(s: SpaceState): number {
	let min = FOREVER; // loops, not Math.min(...spread): spreading a large array overflows the stack
	for (const e of s.entries) if (e.expires < min) min = e.expires;
	for (const r of s.regs) {
		if (r.expires < min) min = r.expires;
		if (r.pending && r.lastEventAt !== undefined) min = Math.min(min, r.lastEventAt + (r.minIntervalMs ?? 0)); // bundled event due
	}
	for (const t of Object.values(s.txns)) if (t.expires < min) min = t.expires;
	for (const w of s.waiters) if (w.deadline < min) min = w.deadline;
	return min;
}

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
export function count(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null): number {
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
 * All entries a `read` could see, oldest first, up to `limit` (default and maximum MAX_LIST). Does not lock or modify
 * anything, so it is safe for dashboards. `as` is checked against `txn` like for any other use of a transaction.
 */
export function list(s: Readonly<SpaceState>, now: number, tmpl: Template = null, txn: string | null = null, limit = MAX_LIST, as?: Target): EntryView[] {
	if (!Number.isInteger(limit) || limit < 1) throw new IllegalArgumentError("limit must be a positive integer");
	if (txn !== null) requireTxn(s as SpaceState, txn, as);
	const mine = active(s, txn, now);
	const out: EntryView[] = [];
	for (const e of s.entries) {
		if (out.length >= Math.min(limit, MAX_LIST)) break;
		const st = standing(s, e, now); // the same view of the space as count() has
		if ((st === "visible" || (st === "uncommitted" && mine && e.writtenUnder === txn)) && matches(tmpl, e)) out.push(view(e));
	}
	return out;
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
	returned: number; // entries given back by aborted or expired transactions, ever (durable)
};

/** A point-in-time summary of the space, as an operation would see it after settling; pure, so it runs on any snapshot. */
export function stats(s: Readonly<SpaceState>, now: number): SpaceStats {
	const r: SpaceStats = { entries: 0, byType: {}, locked: 0, uncommitted: 0, expired: 0, txns: 0, waiters: 0, registrations: 0, outbox: s.outbox.length, returned: s.returned ?? 0 };
	for (const e of s.entries) {
		const st = standing(s, e, now);
		if (st === "visible") { r.entries++; r.byType[e.type] = (r.byType[e.type] ?? 0) + 1; } else r[st]++;
		if (st === "visible" && e.takenBy !== null) r.returned++; // taken by a lapsed transaction: back once settled
	}
	for (const t of Object.values(s.txns)) if (t.expires > now) r.txns++;
	for (const w of s.waiters) if (w.deadline > now) r.waiters++;
	for (const g of s.regs) if (g.expires > now) r.registrations++;
	return r;
}
