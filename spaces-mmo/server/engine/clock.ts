// The world clock as the engine reads it inside a command or a job: the world time now (docs/weltzeit.en.md). Processes that
// look often use ClockCache (clockcache.ts); a command reads the entry in its transaction, so the time it works with is
// the one its transaction sees.
import { fieldsOf, type WorldClockFields } from "../model.ts";
import { decayNow, nextSpring, patience, seasonIndex, withDecayRate, withRate, worldNow, MIN_RATE, MAX_RATE } from "./worldtime.ts";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { setting } from "../settings.ts";
import { peek } from "../space.ts";
import { random, timeNow } from "./source.ts";

export async function readClock(space: SpaceLike, txn?: string | null): Promise<WorldClockFields> {
	const e = await peek(space, { type: "WorldClock" }, txn ? { txn } : {});
	if (!e) throw new Error("the world has no clock");
	return fieldsOf<WorldClockFields>(e);
}

/** The world time now, in world milliseconds. */
export async function worldNowOf(space: SpaceLike, txn?: string | null, realNow = timeNow()): Promise<number> {
	return worldNow(await readClock(space, txn), realNow);
}

/** The time of the second clock now: what waits for people who are away lapses in it. */
export async function decayNowOf(space: SpaceLike, txn?: string | null, realNow = timeNow()): Promise<number> {
	return decayNow(await readClock(space, txn), realNow);
}
/** World milliseconds per millisecond of the second clock, for spans inside a date of the world time. */
export async function patienceOf(space: SpaceLike, txn?: string | null): Promise<number> {
	return patience(await readClock(space, txn));
}

/** The admin's two rates reach the clock of this region (the settings are written to every region); -1 leaves it alone. */
export async function syncRates(space: SpaceLike): Promise<void> {
	const life = await setting(space, "clock.life"), decay = await setting(space, "clock.decay");
	const valid = (r: number) => r >= MIN_RATE && r <= MAX_RATE, now = await readClock(space);
	const changeLife = valid(life) && life !== now.rate, changeDecay = valid(decay) && decay !== (now.decayRate ?? now.rate);
	if (!changeLife && !changeDecay) return;
	const realNow = timeNow();
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const t = await space.takeIfExists({ type: "WorldClock" }, NO_WAIT, { txn });
		if (!t) { await space.abort(txn); return; }
		let next = fieldsOf<WorldClockFields>(t);
		if (changeLife) next = withRate(next, life, realNow);
		if (changeDecay) next = withDecayRate(next, decay, realNow);
		await space.write({ type: "WorldClock", fields: next as never }, txn, FOREVER);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** For a job that serves people, not the life of the world: the tide and the surge bring what people fetch and burn, and what
 *  they bring lies by the second rate, so they come about as often as at that rate, however fast the world lives. */
export const byPeoplesPace = async (space: SpaceLike): Promise<boolean> => random() * (await patienceOf(space)) < 1;

/** Until when things out of doors stand still: the next spring in winter, else null. */
export async function frozenUntil(space: SpaceLike, now: number): Promise<number | null> {
	const yearDays = await setting(space, "year.days");
	return seasonIndex(now, yearDays) === 3 ? nextSpring(now, yearDays) : null;
}
/** The season now, for a word: null in a world without seasons. */
export const seasonNow = async (space: SpaceLike, now: number) => seasonIndex(now, await setting(space, "year.days"));

/** A new season is told in every room of the region, once (in the job of the epochs). */
export async function seasonTick(space: SpaceLike, w: { rooms: Array<{ roomId: string }> }, leaseMs: number): Promise<boolean> {
	const season = await seasonNow(space, await worldNowOf(space));
	if (season === null) return false;
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const was = await space.takeIfExists({ type: "Season" }, NO_WAIT, { txn });
		if (was && Number(was.fields.season) === season) { await space.abort(txn); return false; }
		await space.write({ type: "Season", fields: { season } as never }, txn, FOREVER);
		if (was) for (const r of w.rooms) await space.write({ type: "Msg", fields: { room: r.roomId, to: "*", kind: "world", text: SEASON_TEXT[season]!, from: "", at: timeNow() } as never }, txn, leaseMs);
		await space.commit(txn);
		return !!was;
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}
const SEASON_TEXT = ["Der Frühling kommt: Was im Winter stand, wächst weiter.", "Es wird Sommer.", "Der Herbst beginnt: Zeit für das Erntefest.", "Der Winter kommt: Draußen wächst nichts mehr, bis es Frühling wird."];
