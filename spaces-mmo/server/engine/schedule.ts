// Dates in world time (docs/weltzeit.md, "Termine und Ablauf"). A WorldSchedule entry says when, by the world clock, a
// kind of event is due. Every world worker looks; the one that takes a due entry in a transaction runs its handler and
// writes the next date in the same transaction, so a date is served once however many workers there are, and a worker
// that dies before the commit lets the date come back. The wake-up from a real-time wait is only an estimate: whether a
// date is due is always decided by the world time.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type WorldClockFields, type WorldScheduleFields } from "../model.ts";
import { msUntilWorld, worldNow } from "./worldtime.ts";
import { peek, readExisting, StillHeld } from "../space.ts";

export type ScheduleContext = { space: SpaceLike; txn: string; clock: WorldClockFields; schedule: WorldScheduleFields; worldMs: number };
export type ScheduleHandler = {
	/** Serves one due date, inside its transaction (what it writes commits with the date). */
	run: (c: ScheduleContext) => Promise<void>;
	/** The next date strictly after `afterWorldMs`; absent: a date that happens once. */
	next?: (afterWorldMs: number, s: WorldScheduleFields, clock: WorldClockFields) => number;
};

/** Writes the date unless one with its id exists (inside `txn`: made under the world lock, so two workers cannot both).
 *  `refresh`: an existing date whose kind or payload differs from the definition (a period changed) takes the new ones and keeps
 *  its due time. True when something was written. */
export async function ensureSchedule(space: SpaceLike, txn: string | null, f: WorldScheduleFields, o: { refresh?: boolean } = {}): Promise<boolean> {
	if (f.missed === "replay-bounded") throw new RangeError("missed: replay-bounded is not implemented");
	// a date another worker holds right now (it serves it) exists: wait for it rather than write a second one
	let have;
	try { have = await readExisting(space, { type: "WorldSchedule", fields: { scheduleId: f.scheduleId } }, txn ? { txn } : {}, 5_000); }
	catch (e) { if (e instanceof StillHeld) return false; throw e; }
	if (have) {
		const h = fieldsOf<WorldScheduleFields>(have);
		if (!o.refresh || (h.kind === f.kind && JSON.stringify(h.payload) === JSON.stringify(f.payload) && h.missed === f.missed)) return false;
		if (!(await space.takeIfExists({ type: "WorldSchedule", id: have.id }, NO_WAIT, txn ? { txn } : {}))) return false;
		await space.write({ type: "WorldSchedule", fields: { ...f, dueWorldMs: h.dueWorldMs, clockEpoch: h.clockEpoch } as never }, txn, FOREVER);
		return true;
	}
	await space.write({ type: "WorldSchedule", fields: f as never }, txn, FOREVER);
	return true;
}

/** Fail-closed watch on the host's clock (docs/weltzeit.md, "Serverzeit"): a real clock that jumps back, or forward by more
 *  than `toleranceMs` between two looks, stops new world-time events for `holdMs` and says so; then it is trusted again from
 *  the new reading. Events already served are never taken back. */
export class ClockGuard {
	#last: number | null = null;
	#holdUntil = 0;
	readonly toleranceMs: number;
	readonly holdMs: number;
	readonly alarms: string[] = [];
	constructor(o: { toleranceMs?: number; holdMs?: number } = {}) { this.toleranceMs = o.toleranceMs ?? 5 * 60_000; this.holdMs = o.holdMs ?? 10_000; }

	/** May events be served at real time `now`? */
	ok(now: number): boolean {
		const last = this.#last; this.#last = now;
		if (last !== null && (now < last - 2_000 || now - last > this.toleranceMs)) {
			const what = now < last ? `went back ${last - now} ms` : `jumped ${now - last} ms ahead`;
			this.alarms.push(what);
			console.error(`[world] clock alarm: the host's clock ${what}; no world-time events for ${this.holdMs} ms`);
			this.#holdUntil = now + this.holdMs;
		}
		return now >= this.#holdUntil;
	}
}

/** Serves every due date. Returns the real milliseconds until the next one is due (at most `maxWaitMs`). */
export async function runSchedules(space: SpaceLike, handlers: Record<string, ScheduleHandler>, o: { txnMs: number; maxWaitMs: number; guard?: ClockGuard; now?: () => number }): Promise<number> {
	const now = o.now ?? Date.now;
	const clockEntry = await peek(space, { type: "WorldClock" });
	if (!clockEntry) return o.maxWaitMs;
	const clock = fieldsOf<WorldClockFields>(clockEntry);
	if (o.guard && !o.guard.ok(now())) return o.maxWaitMs;
	let next = o.maxWaitMs;
	for (const e of await space.readAll({ type: "WorldSchedule" })) {
		const s = fieldsOf<WorldScheduleFields>(e), handler = handlers[s.kind];
		if (!handler || s.clockEpoch !== clock.epoch) continue;
		const wait = msUntilWorld(clock, s.dueWorldMs, now());
		if (wait > 0) { next = Math.min(next, wait); continue; }
		const txn = (await space.createTransaction(o.txnMs)).id;
		try {
			if (!(await space.takeIfExists({ type: "WorldSchedule", id: e.id }, NO_WAIT, { txn }))) { await space.abort(txn); continue; } // another worker serves it
			const worldMs = worldNow(clock, now());
			try { await handler.run({ space, txn, clock, schedule: s, worldMs }); }
			catch (err) { console.error(`[world] schedule ${s.scheduleId}:`, (err as Error).message); await space.abort(txn).catch(() => {}); next = Math.min(next, 1000); continue; }
			if (handler.next) {
				// late: `once` goes on from the date it missed, `coalesce` from now (one event for all the periods missed)
				const after = s.missed === "coalesce" ? Math.max(s.dueWorldMs, worldMs) : s.dueWorldMs;
				await space.write({ type: "WorldSchedule", fields: { ...s, dueWorldMs: handler.next(after, s, clock) } as never }, txn, FOREVER);
			}
			await space.commit(txn);
			next = Math.min(next, 20);
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return Math.max(20, next);
}
