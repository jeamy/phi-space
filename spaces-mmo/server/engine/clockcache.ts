// The world clock as a process reads it: the entry is fetched at most every `ttlMs` and the world time is calculated from
// it in between (that is what the anchors and the rate are for), so a role that looks at the hour every round costs the
// space nothing. A change by the operator reaches the process within `ttlMs`.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type WorldClockFields } from "../model.ts";
import { worldNow } from "./worldtime.ts";

export class ClockCache {
	#clock: WorldClockFields | null = null;
	#at = 0;
	readonly #space: SpaceLike;
	readonly #worldId: string;
	readonly #ttlMs: number;
	constructor(space: SpaceLike, worldId: string, ttlMs = 15_000) { this.#space = space; this.#worldId = worldId; this.#ttlMs = ttlMs; }

	/** The world time now, or null while the world has no clock. */
	async now(realNow = Date.now()): Promise<number | null> {
		if (!this.#clock || realNow - this.#at > this.#ttlMs) {
			const e = await this.#space.readIfExists({ type: "WorldClock", fields: { worldId: this.#worldId } }, NO_WAIT).catch(() => null);
			if (e) { this.#clock = fieldsOf<WorldClockFields>(e); this.#at = realNow; }
			else if (!this.#clock) return null;
		}
		return worldNow(this.#clock!, realNow);
	}
}
