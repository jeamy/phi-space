// Pure JavaSpaces semantics (Jini JavaSpaces spec v2.2) over a plain JSON state. No pi imports.
// Functions mutate `state` in place (it is a document draft inside a commit) and take `now` explicitly.
export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Fields = { [k: string]: Json };

export const NO_WAIT = 0;
export const ANY = -1; // Lease.ANY: the space picks the duration
export const FOREVER = Number.MAX_SAFE_INTEGER;
export const MAX_LEASE_MS = 24 * 3600 * 1000;
export const DEFAULT_LEASE_MS = 3600 * 1000;

export class IllegalArgumentError extends Error {}
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
};
export type TxnRec = { id: string; expires: number };
export type RegRec = {
	id: string; // event id
	template: Template;
	expires: number;
	txn: string | null;
	handback: Json;
	target: string | null; // conversation to notify (the "listener")
	seq: number; // last sequence number issued; strictly increasing
};
/** A parked read/take for a conversation: served by the space when a match appears, instead of a blocked call. */
export type WaiterRec = { id: string; template: Template; take: boolean; target: string | null; deadline: number; txnLeaseMs: number; handback: Json };
export type EntryView = { id: string; type: string; types: string[]; fields: Fields };
export type SpaceEvent = {
	kind: "entry" | "waiter" | "timeout"; // entry: notify; waiter: a parked op was served; timeout: its deadline passed
	eventId: string;
	seq: number;
	handback: Json;
	target: string | null;
	entry?: EntryView;
	tries?: number; // failed deliveries so far
	txn?: string; // a served take-waiter holds the entry under this transaction until committed or its lease lapses
};
export type SpaceState = { nextId: number; entries: EntryRec[]; txns: Record<string, TxnRec>; regs: RegRec[]; waiters: WaiterRec[]; outbox: SpaceEvent[] };

export const initialState = (): SpaceState => ({ nextId: 1, entries: [], txns: {}, regs: [], waiters: [], outbox: [] });
export const migrate = (v: any, _from: number): SpaceState => {
	const d = initialState();
	return {
		nextId: v.nextId ?? d.nextId,
		entries: (v.entries ?? d.entries).map((e: any) => ({ ...e, types: e.types ?? [e.type], readBy: e.readBy ?? [], writtenUnder: e.writtenUnder ?? null, takenBy: e.takenBy ?? null })),
		txns: v.txns ?? d.txns,
		regs: v.regs ?? d.regs,
		waiters: v.waiters ?? d.waiters,
		outbox: v.outbox ?? d.outbox,
	};
};
export type Lease = { id: string; expires: number };

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)); // draft proxies are not structured-cloneable
const newId = (s: SpaceState, p: string) => `${p}${s.nextId++}`;

function grant(requested: number, now: number): number {
	if (!Number.isFinite(requested) && requested !== FOREVER) throw new IllegalArgumentError("bad lease");
	if (requested < 0 && requested !== ANY) throw new IllegalArgumentError("negative lease");
	const ms = requested === ANY ? DEFAULT_LEASE_MS : Math.min(requested, MAX_LEASE_MS);
	return now + ms;
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

/** Drop expired entries and registrations, and abort expired transactions. Every operation starts with this. */
export function settle(s: SpaceState, now: number): void {
	for (const t of Object.values(s.txns)) if (t.expires <= now) finish(s, t.id, false, now);
	s.entries = s.entries.filter((e) => e.expires > now);
	s.regs = s.regs.filter((r) => r.expires > now);
	for (const w of s.waiters.filter((w) => w.deadline <= now)) {
		s.outbox.push({ kind: "timeout", eventId: w.id, seq: 1, handback: w.handback, target: w.target });
	}
	s.waiters = s.waiters.filter((w) => w.deadline > now);
	serve(s, now); // aborts and expiries may have returned entries that a waiter is waiting for
}

export function write(s: SpaceState, now: number, entry: EntryDraft, txn: string | null, lease: number): Lease {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn);
	const expires = grant(lease, now);
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
	};
	s.entries.push(rec);
	notifyWrite(s, rec, txn);
	if (txn === null) serve(s, now);
	return { id: rec.id, expires };
}

// Registrations fire for committed writes (null-txn registrations) and, for a registration made under transaction
// T, also for writes under T. A null-txn registration does not see an entry written and taken inside one transaction.
function notifyWrite(s: SpaceState, e: EntryRec, txn: string | null): void {
	for (const r of s.regs) {
		const applies = txn === null ? r.txn === null : r.txn === txn; // txn writes reach only regs of that txn now
		if (!applies || !matches(r.template, e)) continue;
		r.seq++;
		s.outbox.push({ kind: "entry", eventId: r.id, seq: r.seq, handback: r.handback, target: r.target, entry: view(e) });
	}
}

export type Probe = { status: "found"; entry: EntryRec } | { status: "none" } | { status: "locked" };

/** One non-waiting attempt. `locked` means matches exist, but every one conflicts with another transaction. */
export function probe(s: SpaceState, now: number, tmpl: Template, txn: string | null, take: boolean): Probe {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn);
	const f = find(s, tmpl, txn, take);
	return f.status === "found" ? { status: "found", entry: apply(s, f.rec, txn, take) } : f;
}

export const view = (e: EntryRec): EntryView => ({ id: e.id, type: e.type, types: [...e.types], fields: clone(e.fields) });

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

export function createTxn(s: SpaceState, now: number, lease: number): Lease {
	settle(s, now);
	const t = { id: newId(s, "t"), expires: grant(lease, now) };
	s.txns[t.id] = t;
	return { ...t };
}
const requireTxn = (s: SpaceState, id: string) => {
	if (!s.txns[id]) throw new TransactionError(`transaction ${id} is not active`);
};
export const commitTxn = (s: SpaceState, now: number, id: string) => { settle(s, now); requireTxn(s, id); finish(s, id, true, now); serve(s, now); };
export const abortTxn = (s: SpaceState, now: number, id: string) => { settle(s, now); requireTxn(s, id); finish(s, id, false, now); serve(s, now); };

/** Park a read/take for `target`; the space serves it later (or reports a timeout) through the outbox. */
export function addWaiter(s: SpaceState, now: number, w: { template: Template; take: boolean; target: string | null; timeout: number; txnLeaseMs?: number; handback?: Json }): string {
	if (w.timeout < 0) throw new IllegalArgumentError("negative timeout");
	settle(s, now);
	const txnLeaseMs = grant(w.txnLeaseMs ?? ANY, now) - now; // same rules as every other lease: ANY, cap, no negatives
	const rec: WaiterRec = { id: newId(s, "w"), template: w.template, take: w.take, target: w.target, deadline: now + w.timeout, txnLeaseMs, handback: w.handback ?? null };
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
		const t = { id: newId(s, "t"), expires: now + w.txnLeaseMs };
		s.txns[t.id] = t;
		s.outbox.push({ kind: "waiter", eventId: w.id, seq: 1, handback: w.handback, target: w.target, entry: view(apply(s, f.rec, t.id, true)), txn: t.id });
	}
}

function finish(s: SpaceState, id: string, commit: boolean, _now: number): void {
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
			if (e.takenBy === id) e.takenBy = null; // takes are undone: the entry is back
		}
		keep.push(e);
	}
	s.entries = keep;
	for (const e of published) notifyWrite(s, e, null);
}

export function notify(s: SpaceState, now: number, tmpl: Template, txn: string | null, lease: number, handback: Json, target: string | null): { eventId: string; lease: Lease } {
	settle(s, now);
	if (txn !== null) requireTxn(s, txn);
	const r: RegRec = { id: newId(s, "n"), template: tmpl, expires: grant(lease, now), txn, handback, target, seq: 0 };
	s.regs.push(r);
	return { eventId: r.id, lease: { id: r.id, expires: r.expires } };
}

function leaseObj(s: SpaceState, id: string): { expires: number } | undefined {
	return s.entries.find((e) => e.id === id) ?? s.regs.find((r) => r.id === id) ?? s.txns[id];
}
export function renew(s: SpaceState, now: number, id: string, ms: number): number {
	settle(s, now);
	const w = s.waiters.find((x) => x.id === id); // a wait's deadline behaves like a lease
	if (w) return (w.deadline = grant(ms, now));
	const o = leaseObj(s, id);
	if (!o) throw new UnknownLeaseError(id);
	return (o.expires = grant(ms, now));
}
export function cancel(s: SpaceState, now: number, id: string): void {
	settle(s, now);
	if (cancelWaiter(s, id)) return; // cancelled waits send no timeout event
	const o = leaseObj(s, id);
	if (!o) throw new UnknownLeaseError(id);
	o.expires = now; // settle() removes it; a cancelled txn lease aborts the transaction
	settle(s, now);
}

/** Earliest time something can change without a commit (lease expiry); the waiter must wake then. */
export function nextExpiry(s: SpaceState): number {
	let min = FOREVER; // loops, not Math.min(...spread): spreading a large array overflows the stack
	for (const e of s.entries) if (e.expires < min) min = e.expires;
	for (const r of s.regs) if (r.expires < min) min = r.expires;
	for (const t of Object.values(s.txns)) if (t.expires < min) min = t.expires;
	for (const w of s.waiters) if (w.deadline < min) min = w.deadline;
	return min;
}
