// Revisions and the change stream of a space (federation-plan-v3.md 6.1, AP 1.3). Pure helpers over the space state.
//
// Every commit that changes what a plain reader can see gets the next revision and one batch in a bounded log inside the
// space document. A batch holds idempotent, state-based operations on *visible* entries: `put` (an entry became visible
// or its lease changed) and `del` (it stopped being visible). The last operation per entry in a batch wins. Replaying
// `put`/`del` in order, in any prefix, converges to the same visible set, which lets a client combine a (live) page read
// with `changes` after the revision it saw first.
//
// The batch of a commit is found through the identity of the document draft: drafts are new in every commit, so the
// first change of a commit opens the batch and the later ones in the same commit join it. A plain state object (unit
// tests) is one "commit" until `seal` is called.
import type { Fields, Json, Target } from "./core.ts";

export type Op =
	| { op: "put"; id: string; type: string; types: string[]; fields: Fields; expires: number; owner: Target | null }
	| { op: "del"; id: string };
export type Batch = { rev: number; at: number; ops: Op[] };
export type StreamState = {
	rev: number; // revision of the newest batch (0: nothing yet)
	floor: number; // batches up to and including this revision were dropped from the log
	bytes: number; // JSON bytes of the retained batches (running tally)
	log: Batch[];
};

const encoder = new TextEncoder();
const bytesOf = (v: unknown): number => encoder.encode(JSON.stringify(v) ?? "").length;
const opBytes = (o: Op): number => bytesOf(o) + 1;

type Open = { rev: number; at: Map<string, number> }; // `at`: position of an entry's operation inside the batch
const open = new WeakMap<object, Open>();

/** End the current batch of a draft or plain state: the next change gets a new revision. */
export const seal = (s: object): void => { open.delete(s); };

/**
 * Record one operation in the batch of the running commit; drops the oldest batches beyond `maxLogBytes`.
 * `s` may be a document draft: values assigned into a draft are copied, so everything after an assignment goes
 * through `s.stream` again instead of through the object that was assigned.
 */
export function record(s: { stream?: StreamState }, now: number, op: Op, maxLogBytes: number): void {
	if (!s.stream) s.stream = { rev: 0, floor: 0, bytes: 0, log: [] };
	let o = open.get(s);
	if (!o) {
		const rev = s.stream.rev + 1;
		s.stream.rev = rev;
		s.stream.log.push({ rev, at: now, ops: [] });
		s.stream.bytes += bytesOf({ rev, at: now, ops: [] }) + 1; // the envelope and the separator; operations add their own
		o = { rev, at: new Map() };
		open.set(s, o);
	}
	const st = s.stream;
	const batch = st.log[o.rev - st.log[0]!.rev]!; // revisions in the log are consecutive
	const prev = o.at.get(op.id);
	if (prev !== undefined) { // the last operation per entry wins; position keeps the order of first touch
		st.bytes += opBytes(op) - opBytes(batch.ops[prev]!);
		batch.ops[prev] = op;
	} else {
		o.at.set(op.id, batch.ops.length);
		batch.ops.push(op);
		st.bytes += opBytes(op);
	}
	let drop = 0;
	while (st.bytes > maxLogBytes && drop < st.log.length - 1) { // the batch being written stays
		const b = st.log[drop]!;
		st.bytes -= bytesOf(b) + 1;
		st.floor = b.rev;
		drop++;
	}
	if (drop > 0) st.log.splice(0, drop);
}

export type Collected = { batches: Batch[]; next: number } | { expired: true; floor: number } | { tooSmall: number } | { ahead: true; rev: number };

/**
 * Batches after `afterRev` as long as they fit `cap` bytes with `overhead` for the envelope. Ends between batches and
 * returns at least one when any exist; `tooSmall` carries what the next batch needs.
 */
export function collect(s: Readonly<{ stream?: StreamState }>, afterRev: number, cap: number, overhead: number): Collected {
	const st = s.stream ?? { rev: 0, floor: 0, bytes: 0, log: [] };
	if (afterRev > st.rev) return { ahead: true, rev: st.rev };
	if (afterRev < st.floor) return { expired: true, floor: st.floor };
	const batches: Batch[] = [];
	let used = overhead;
	for (const b of st.log) {
		if (b.rev <= afterRev) continue;
		const n = bytesOf(b) + 1;
		if (used + n > cap) {
			if (batches.length === 0) return { tooSmall: overhead + n };
			break;
		}
		batches.push(b);
		used += n;
	}
	return { batches, next: batches.length ? batches[batches.length - 1]!.rev : afterRev };
}

export const revisionOf = (s: Readonly<{ stream?: StreamState }>): number => s.stream?.rev ?? 0;
export type { Json };
