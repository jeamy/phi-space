// What the world's dates (engine/schedule.ts) do when they are due.
import { NO_WAIT } from "phi-spaces";
import type { WorldEventFields, WorldScheduleFields } from "../model.ts";
import type { ScheduleHandler } from "./schedule.ts";
import { calendar, nextAtHour } from "./worldtime.ts";
import { peek } from "../space.ts";

/** How long a world event stays for the processes that watch (real time: they look every few seconds). */
export const EVENT_LEASE_MS = 5 * 60_000;

/** `evening`: every world day at `payload.hour` an event `evening:e<epoch>:d<day>`, once per day and clock epoch. */
const evening: ScheduleHandler = {
	async run({ space, txn, clock, schedule }) {
		const day = calendar(schedule.dueWorldMs).day;
		const eventId = `evening:e${clock.epoch}:d${day}`;
		if (await peek(space, { type: "WorldEvent", fields: { eventId } }, { txn })) return; // the key keeps it single
		await space.write({ type: "WorldEvent", fields: { eventId, kind: "evening", worldMs: schedule.dueWorldMs, epoch: clock.epoch, day } satisfies WorldEventFields as never }, txn, EVENT_LEASE_MS);
	},
	next: (after, s) => nextAtHour(after, Number(s.payload.hour)),
};

export const SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = { evening };

/** The world's recurring jobs (the weather and the markets), in world milliseconds: what Phase 2 ran on real-time tickers.
 *  `fire` notices a fire that went out or came back, `fog` moves the fog a step, `flood` brings the tide's flotsam, `sweep`
 *  takes away what has lapsed (flotsam), `orders` and `market` keep the boards. */
export function tickJobs(w: { fog: { stepMs: number }; flood: { everyMs: number }; orders: { everyMs: number }; storm?: { everyMs: number }; garden?: unknown }): Array<{ job: string; everyMs: number }> {
	return [
		{ job: "fire", everyMs: 15_000 }, { job: "fog", everyMs: w.fog.stepMs }, { job: "flood", everyMs: w.flood.everyMs },
		{ job: "sweep", everyMs: 10_000 }, { job: "orders", everyMs: w.orders.everyMs }, { job: "market", everyMs: 60_000 },
		...(w.storm ? [{ job: "storm", everyMs: w.storm.everyMs }] : []),
		// the beds whose date has come (engine/commands/garden.ts)
		...(w.garden ? [{ job: "garden", everyMs: 60_000 }] : []),
	];
}

/** The least real time between two runs of a recurring job: a world that runs fast does not turn every job into a busy loop. */
export const MIN_TICK_REAL_MS = 100;

/** The handler of the recurring jobs: `kind: "tick"`, `payload: { job, everyMs }`; the next date is one period after the
 *  one that was served (after now, for a date served late: `coalesce`), a period of at least MIN_TICK_REAL_MS of real time. */
export const tickHandler = (runs: Record<string, () => Promise<void>>): ScheduleHandler => ({
	run: async ({ schedule }) => { await runs[String(schedule.payload.job)]?.(); },
	next: (after, s, clock) => after + Math.max(Number(s.payload.everyMs), MIN_TICK_REAL_MS * clock.rate),
});

/** The dates a world defines: made once, under the world lock (engine/loader.ts); `refresh` names those whose period may
 *  have changed with the definition (the recurring jobs). */
export function worldSchedules(w: Parameters<typeof tickJobs>[0] & { evening?: { hour: number } }, epoch: number, afterWorldMs: number): Array<{ f: WorldScheduleFields; refresh: boolean }> {
	return [
		...(w.evening ? [{ f: { scheduleId: "evening", clockEpoch: epoch, dueWorldMs: nextAtHour(afterWorldMs, w.evening.hour), kind: "evening", payload: { hour: w.evening.hour }, missed: "coalesce" as const }, refresh: true }] : []),
		// a fresh world does not take a fog step the moment it starts: the first date is one period away
		...tickJobs(w).map((t) => ({ f: { scheduleId: `tick.${t.job}`, clockEpoch: epoch, dueWorldMs: afterWorldMs + t.everyMs, kind: "tick", payload: { job: t.job, everyMs: t.everyMs }, missed: "coalesce" as const }, refresh: true })),
	];
}
