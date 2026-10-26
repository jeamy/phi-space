// The world clock as the engine reads it inside a command or a job: the world time now (docs/weltzeit.md). Processes that
// look often use ClockCache (clockcache.ts); a command reads the entry in its transaction, so the time it works with is
// the one its transaction sees.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type WorldClockFields } from "../model.ts";
import { worldNow } from "./worldtime.ts";

export async function readClock(space: SpaceLike, txn?: string | null): Promise<WorldClockFields> {
	const e = await space.readIfExists({ type: "WorldClock" }, NO_WAIT, txn ? { txn } : {});
	if (!e) throw new Error("the world has no clock");
	return fieldsOf<WorldClockFields>(e);
}

/** The world time now, in world milliseconds. */
export async function worldNowOf(space: SpaceLike, txn?: string | null, realNow = Date.now()): Promise<number> {
	return worldNow(await readClock(space, txn), realNow);
}
