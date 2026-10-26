// The world clock as a process reads it: the entry is fetched at most every `ttlMs` and the world time is calculated from
// it in between (that is what the anchors and the rate are for), so a role that looks at the hour every round costs the
// space nothing. A change by the operator reaches the process within `ttlMs`.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type WorldClockFields } from "../model.ts";
import { calendar, worldNow } from "./worldtime.ts";

export class ClockCache {
	#clock: WorldClockFields | null = null;
	#at = 0;
	readonly #space: SpaceLike;
	readonly #worldId: string | undefined;
	readonly #ttlMs: number;
	/** `worldId` absent: the space's one clock. */
	constructor(space: SpaceLike, worldId?: string, ttlMs = 15_000) { this.#space = space; this.#worldId = worldId; this.#ttlMs = ttlMs; }

	/** The clock as last read (null while the world has none). */
	async clock(realNow = Date.now()): Promise<WorldClockFields | null> {
		if (!this.#clock || realNow - this.#at > this.#ttlMs) {
			const e = await this.#space.readIfExists({ type: "WorldClock", ...(this.#worldId ? { fields: { worldId: this.#worldId } } : {}) }, NO_WAIT).catch(() => null);
			if (e) { this.#clock = fieldsOf<WorldClockFields>(e); this.#at = realNow; }
		}
		return this.#clock;
	}

	/** World milliseconds per real millisecond as last read (1 before the first read). */
	rate(): number { return this.#clock?.rate ?? 1; }

	/** The world time now, or null while the world has no clock. */
	async now(realNow = Date.now()): Promise<number | null> {
		const c = await this.clock(realNow);
		return c ? worldNow(c, realNow) : null;
	}
}

const caches = new WeakMap<SpaceLike, ClockCache>();
/** The cache of a space's clock, shared by whoever in this process asks. */
export const clockOf = (space: SpaceLike): ClockCache => { let c = caches.get(space); if (!c) { c = new ClockCache(space); caches.set(space, c); } return c; };

/** The world time now (real time while the world has no clock): what an NPC's own timers count in. */
export const worldNowMs = async (space: SpaceLike, realNow = Date.now()): Promise<number> => (await clockOf(space).now(realNow)) ?? realNow;

/** Real milliseconds for a rhythm of `worldMs` of the world's time (at least `minMs`): how often a role looks around.
 *  A rhythm follows the clock's rate, so a world that runs fast has quick roles; it does not stop with a pause (a role still
 *  hears what is said in a world that stands still). */
export const paceMs = (space: SpaceLike, worldMs: number, minMs = 50): number => Math.max(minMs, Math.round(worldMs / clockOf(space).rate()));

/** The key of the world day, `e1:d183` (clock epoch and day), or null while the world has no clock: what a narrative
 *  budget "per day" counts by (docs/weltzeit.md, "Modellbudgets"). */
export async function worldDayKey(space: SpaceLike, realNow = Date.now()): Promise<string | null> {
	const c = await clockOf(space).clock(realNow);
	return c ? `e${c.epoch}:d${calendar(worldNow(c, realNow)).day}` : null;
}
