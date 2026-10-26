// The world's clock (docs/weltzeit.md): a persisted anchor and a rate, the world time derived from them, a calendar of
// 24-hour days without time zones, and the plans of NPCs in world hours. Pure: no space, no process, so the browser
// can use it too (it only shows; the server decides).
import type { WorldClockFields } from "../model.ts";

export const WORLD_MINUTE_MS = 60_000;
export const WORLD_HOUR_MS = 60 * WORLD_MINUTE_MS;
export const WORLD_DAY_MS = 24 * WORLD_HOUR_MS;
/** Version of the calculation and the calendar format (not of the running day). */
export const CLOCK_VERSION = 1;
/** The hour a new world starts at, when its definition names none. */
export const DEFAULT_START_HOUR = 8;
/** World milliseconds per real millisecond: 0.001 (a day in 11 real days) to 100 000 (a day in under a second). */
export const MIN_RATE = 0.001, MAX_RATE = 100_000;

/** The world time in milliseconds since day 0, 00:00. */
export function worldNow(clock: Pick<WorldClockFields, "paused" | "worldAnchorMs" | "realAnchorMs" | "rate">, realNow = Date.now()): number {
	if (clock.paused) return clock.worldAnchorMs;
	return clock.worldAnchorMs + (realNow - clock.realAnchorMs) * clock.rate;
}

export type CalendarTime = { day: number; hour: number; minute: number; millisOfDay: number };

/** Day, hour and minute of a world time; day 0 is the world's first. */
export function calendar(worldMs: number): CalendarTime {
	const day = Math.floor(worldMs / WORLD_DAY_MS);
	const millisOfDay = worldMs - day * WORLD_DAY_MS;
	return { day, hour: Math.floor(millisOfDay / WORLD_HOUR_MS), minute: Math.floor((millisOfDay % WORLD_HOUR_MS) / WORLD_MINUTE_MS), millisOfDay };
}

/** "Tag 4, 08:12" (days count from 1 for people). */
export function formatWorldTime(worldMs: number): string {
	const t = calendar(worldMs);
	return `Tag ${t.day + 1}, ${String(t.hour).padStart(2, "0")}:${String(t.minute).padStart(2, "0")}`;
}

/** The clock of a new world: starts at `startHour` of day 0, at `rate = 1 / timeScale` (SPACES_MMO_TIME_SCALE is real
 *  time per game time: 0.002 lets an hour pass in 7.2 seconds). */
export function initialClock(worldId: string, startHour: number, realNow: number, timeScale: number): WorldClockFields {
	return { worldId, epoch: 1, realAnchorMs: realNow, worldAnchorMs: startHour * WORLD_HOUR_MS, rate: clampRate(1 / timeScale), paused: false, version: CLOCK_VERSION };
}

const clampRate = (rate: number) => Math.min(MAX_RATE, Math.max(MIN_RATE, rate));

/** The clock with both anchors moved to `realNow`: the same world time, a fresh starting point for a change. */
export function materialize(clock: WorldClockFields, realNow: number): WorldClockFields {
	return { ...clock, worldAnchorMs: worldNow(clock, realNow), realAnchorMs: realNow };
}

/** A new rate without a jump. Throws a RangeError unless 0.001 ≤ rate ≤ 100 000 (a pause is `paused`, never rate 0). */
export function withRate(clock: WorldClockFields, rate: number, realNow: number): WorldClockFields {
	if (!Number.isFinite(rate) || rate < MIN_RATE || rate > MAX_RATE) throw new RangeError(`rate must be between ${MIN_RATE} and ${MAX_RATE}`);
	return { ...materialize(clock, realNow), rate };
}
export const paused = (clock: WorldClockFields, realNow: number): WorldClockFields => ({ ...materialize(clock, realNow), paused: true });
export const resumed = (clock: WorldClockFields, realNow: number): WorldClockFields => ({ ...materialize(clock, realNow), paused: false });

/** What the gateway tells a browser; the browser interpolates between two of these, and decides nothing by it. */
export type WorldTimeView = { epoch: number; worldMs: number; rate: number; paused: boolean; serverNowMs: number };
export const viewOf = (clock: WorldClockFields, serverNowMs: number): WorldTimeView => ({ epoch: clock.epoch, worldMs: worldNow(clock, serverNowMs), rate: clock.rate, paused: clock.paused, serverNowMs });
/** The world time a browser shows `now`, from the view it received at `receivedAtMs` (its own clock). */
export const shownWorldMs = (v: WorldTimeView, receivedAtMs: number, now: number): number => (v.paused ? v.worldMs : v.worldMs + Math.max(0, now - receivedAtMs) * v.rate);

/** A plan in world hours: present from `presentFromHour` (inclusive) to `presentUntilHour` (exclusive). A plan may run
 *  over midnight (20 to 2); from = until means all day. */
export type Plan = { presentFromHour: number; presentUntilHour: number };
export function presentAt(plan: Plan, worldMs: number): boolean {
	const h = calendar(worldMs).millisOfDay / WORLD_HOUR_MS;
	const { presentFromHour: from, presentUntilHour: until } = plan;
	if (from === until) return true;
	return from < until ? h >= from && h < until : h >= from || h < until;
}

/** The first world time strictly after `afterMs` at which the clock shows `hour` o'clock (a daily date). */
export function nextAtHour(afterMs: number, hour: number): number {
	const day = Math.floor(afterMs / WORLD_DAY_MS);
	for (const d of [day, day + 1]) { const at = d * WORLD_DAY_MS + hour * WORLD_HOUR_MS; if (at > afterMs) return at; }
	return (day + 2) * WORLD_DAY_MS + hour * WORLD_HOUR_MS;
}

/** Real milliseconds until the world time reaches `dueWorldMs` (0 when it has; Infinity while the clock is paused). */
export function msUntilWorld(clock: Pick<WorldClockFields, "paused" | "worldAnchorMs" | "realAnchorMs" | "rate">, dueWorldMs: number, realNow: number): number {
	const left = dueWorldMs - worldNow(clock, realNow);
	return left <= 0 ? 0 : clock.paused ? Infinity : Math.ceil(left / clock.rate);
}
