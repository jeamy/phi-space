// The region spaces as the web process sees them (engine/regions.ts): one client per region, where an account and its
// character are (they cross together, engine/handover.ts), and where a new character starts. Without regions there is
// one, "world", and everything goes there as before.
import type { SpaceLike, Template } from "phi-spaces";
import { regionAddresses, regionsOf, WHOLE } from "./engine/regions.ts";
import type { WorldDef } from "./engine/world.ts";
import { connectSpace } from "./space.ts";

export class RegionSpaces {
	readonly w: WorldDef;
	readonly #spaces: Map<string, SpaceLike>;
	readonly #closers: Array<() => void> = [];
	#next = 0;
	/** The first region: the settings, the model's entries and the system bar live there. */
	readonly home: string;

	constructor(w: WorldDef, spaces: Map<string, SpaceLike>, closers: Array<() => void> = []) {
		if (!spaces.size) throw new Error("no region space");
		this.w = w; this.#spaces = spaces; this.#closers.push(...closers);
		this.home = [...spaces.keys()][0]!;
	}

	/** Clients of every region SPACES_MMO_REGIONS names, or of the one space `whole`. */
	static connect(w: WorldDef, whole: string): RegionSpaces {
		const spaces = new Map<string, SpaceLike>(), closers: Array<() => void> = [];
		for (const [id, address] of regionAddresses(w, whole)) { const c = connectSpace(address); spaces.set(id, c.space); closers.push(c.close); }
		return new RegionSpaces(w, spaces, closers);
	}

	/** One space as the whole world (tests, a single space). */
	static single(w: WorldDef, space: SpaceLike): RegionSpaces { return new RegionSpaces(w, new Map([[WHOLE, space]])); }

	get size(): number { return this.#spaces.size; }
	get homeSpace(): SpaceLike { return this.#spaces.get(this.home)!; }
	get(id: string): SpaceLike | undefined { return this.#spaces.get(id); }
	entries(): Array<[string, SpaceLike]> { return [...this.#spaces]; }

	/** The region whose space holds an entry `tmpl` matches; null when none does. A character on a ferry is in no
	 *  region for a moment: with `waitMs` it is looked for again until then. */
	async find(tmpl: Template, waitMs = 0): Promise<{ region: string; space: SpaceLike } | null> {
		const end = Date.now() + waitMs;
		for (;;) {
			for (const [region, space] of this.#spaces) if ((await space.readAll(tmpl, { limit: 1 })).length) return { region, space };
			if (Date.now() >= end || this.#spaces.size === 1) return null;
			await new Promise((r) => setTimeout(r, 100));
		}
	}

	/** Where a new character starts: the regions in turn (each has a bay of its own), so newcomers spread over the
	 *  spaces. Without regions: the world's start. */
	nextStart(): { region: string; space: SpaceLike; room: string } {
		if (this.#spaces.size === 1) { const [region, space] = [...this.#spaces][0]!; return { region, space, room: this.w.start }; }
		const regions = regionsOf(this.w).filter((g) => this.#spaces.has(g.regionId));
		const g = regions[this.#next++ % regions.length]!;
		return { region: g.regionId, space: this.#spaces.get(g.regionId)!, room: g.start };
	}

	close(): void { for (const c of this.#closers) c(); }
}
