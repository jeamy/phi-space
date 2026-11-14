// New islands (docs/codemode-planung.en.md, step 6): a planning task whose episodes are islands made from a number
// (toyisland.ts genIsland), played in the judge (toyarena.ts). The prompt names no map: the shown episodes are three
// islands, the hidden ones six others. A bot that knows a map, or the shown islands by heart, fails the hidden ones;
// one that explores what it sees, remembers it and plans over it, reaches them.
import type { BotEpisode } from "./bottask.ts";
import { genIsland, type ToyWorld } from "./toyisland.ts";
import { explorerBot, noWoodBot, surveyBot, wanderBot } from "./explorer.ts";

/** The islands of the shown and of the hidden episodes. */
export const NEULAND_SAMPLES = [1, 2, 3], NEULAND_HIDDEN = [4, 5, 6, 7, 8, 9];

const room = (w: ToyWorld, id: string) => `${w.rooms[id]!.name} (${id})`;
const ep = (id: string, kind: BotEpisode["kind"], n: number): BotEpisode => {
	const w = genIsland(n), { start, wood } = w.episode;
	return {
		id, kind, island: n, start,
		setup: { items: [{ proto: "treibholz", ...wood }] },
		text: {
			de: `${w.name}: Start ${room(w, start.room)} (${start.x},${start.y}), Treibholz ${room(w, wood.room)} (${wood.x},${wood.y})`,
			en: `${w.name}: start ${room(w, start.room)} (${start.x},${start.y}), driftwood ${room(w, wood.room)} (${wood.x},${wood.y})`,
		},
	};
};
export const NEULAND_EPISODES: BotEpisode[] = [
	...NEULAND_SAMPLES.map((n, i) => ep(`S${i + 1}`, "sample", n)),
	...NEULAND_HIDDEN.map((n, i) => ep(`H${i + 1}`, "holdout", n)),
];

// ---- the scripted bots --------------------------------------------------------------------------------------------
/** Knows the three shown islands by heart: for each its start room, the exits to the wood and on to the fire. */
function memorizerBot(): string {
	const way = (w: ToyWorld, a: string, b: string): string[] => {
		const prev: Record<string, [string, string] | null> = { [a]: null }, q = [a];
		while (q.length) { const r = q.shift()!; if (r === b) break; for (const [d, t] of Object.entries(w.rooms[r]!.exits)) if (!(t in prev)) { prev[t] = [r, d]; q.push(t); } }
		const out: string[] = [];
		for (let r = b; prev[r]; r = prev[r]![0]) out.unshift(prev[r]![1]);
		return out;
	};
	const plans = Object.fromEntries(NEULAND_SAMPLES.map((n) => {
		const w = genIsland(n), { start, wood } = w.episode;
		return [start.room, [...way(w, start.room, wood.room), `move ${wood.x} ${wood.y}`, "nimm treibholz", ...way(w, wood.room, w.fire.room), `move ${w.fire.x} ${w.fire.y - 1}`, "lege holz ins feuer"]];
	}));
	return `async function bot(){const PLANS=${JSON.stringify(plans)};const s=await tools.look();for(const line of PLANS[s.room.id]||[])await tools.act({line})}`;
}

/** The scripted contributions: two correct, four wrong. A bot with the Graue Insel's map is the island task's reference
 *  (`graueBot`, passed in: island.ts would import this module otherwise). */
export const neulandVariants = (graueBot: string): string[] => [
	// explores, remembers, plans as soon as it knows enough: correct everywhere
	explorerBot,
	// explores the whole island, then plans: correct, more points
	surveyBot,
	// wrong: the map of the Graue Insel (correct there, lost here)
	graueBot,
	// wrong: the shown islands by heart
	memorizerBot(),
	// wrong: walks without remembering
	wanderBot,
	// wrong: no wood
	noWoodBot,
];
