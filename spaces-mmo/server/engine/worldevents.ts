// What the world's dates (engine/schedule.ts) do when they are due.
import { NO_WAIT } from "phi-spaces";
import type { WorldEventFields, WorldScheduleFields } from "../model.ts";
import type { ScheduleHandler } from "./schedule.ts";
import { calendar, nextAtHour } from "./worldtime.ts";

/** How long a world event stays for the processes that watch (real time: they look every few seconds). */
export const EVENT_LEASE_MS = 5 * 60_000;

/** `evening`: every world day at `payload.hour` an event `evening:e<epoch>:d<day>`, once per day and clock epoch. */
const evening: ScheduleHandler = {
	async run({ space, txn, clock, schedule }) {
		const day = calendar(schedule.dueWorldMs).day;
		const eventId = `evening:e${clock.epoch}:d${day}`;
		if (await space.readIfExists({ type: "WorldEvent", fields: { eventId } }, NO_WAIT, { txn })) return; // the key keeps it single
		await space.write({ type: "WorldEvent", fields: { eventId, kind: "evening", worldMs: schedule.dueWorldMs, epoch: clock.epoch, day } satisfies WorldEventFields as never }, txn, EVENT_LEASE_MS);
	},
	next: (after, s) => nextAtHour(after, Number(s.payload.hour)),
};

export const SCHEDULE_HANDLERS: Record<string, ScheduleHandler> = { evening };

/** The dates a world defines: made once, under the world lock (engine/loader.ts). */
export function worldSchedules(w: { evening?: { hour: number } }, epoch: number, afterWorldMs: number): WorldScheduleFields[] {
	return w.evening ? [{ scheduleId: "evening", clockEpoch: epoch, dueWorldMs: nextAtHour(afterWorldMs, w.evening.hour), kind: "evening", payload: { hour: w.evening.hour }, missed: "coalesce" }] : [];
}
