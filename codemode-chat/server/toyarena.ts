// The arena's JSON-line protocol (spaces-mmo/server/arena.ts) answered by the toy islands in the judge's own process
// (toyisland.ts), for a planning task whose episodes are islands made from a number (`bot.toy`, docs/codemode-planung
// .en.md, step 6). The judge plays such a task as it plays one in the arena (judge.ts judgeEpisodes); the task needs
// no arena, so every judge takes it. `open` takes the episode's island, start, setup and seed; `score` the goal
// `beacon:island` (the island's one fire), held `hold` world minutes; `path` the cells as the arena gives them; `map` a
// room's geometry. Subgoals are not watched here. With `rules: "tide"` (step 7) the world runs under TIDE_RULES: exits
// take time, the tide follows its law, washed-up wood goes back to the sea; `score` then also takes `feed:island:<n>`
// (the bot put n pieces into the island's fire), and `tides` gives the landings so far (the judge's log, step 7's data).
// With `rules: "chance"` (step 8) the tide is chance (CHANCE_RULES), `tides` gives the whole day (`day`), and `score`
// says how many pieces went into the fire (`count`).
import type { Arena, PathStep } from "./bottask.ts";
import { CHANCE_RULES, chanceDay, islandError, TIDE_RULES, toyCellError, toyRoomMap, ToyIsland, worldOf } from "./toyisland.ts";

const PATH_STEPS = 200;
/** The trail as the arena's `path` gives it: the start, the turns and room changes, the last cell; at most PATH_STEPS. */
export function toyPath(trail: PathStep[], max = PATH_STEPS): { path: PathStep[]; cut: boolean } {
	const turns: PathStep[] = [];
	for (let i = 0; i < trail.length; i++) {
		const s = trail[i]!, p = trail[i - 1], n = trail[i + 1];
		if (!p || !n || p[0] !== s[0] || n[0] !== s[0] || n[1] - s[1] !== s[1] - p[1] || n[2] - s[2] !== s[2] - p[2]) turns.push(s);
	}
	if (turns.length <= max) return { path: turns, cut: false };
	const every = Math.ceil(turns.length / (max - 1));
	return { path: [...turns.filter((_, i) => i % every === 0).slice(0, max - 1), turns.at(-1)!], cut: true };
}

/** An Arena (bottask.ts) over toy islands, for one judging. */
export function toyArena(): Arena {
	const worlds = new Map<string, ToyIsland>();
	let n = 0;
	const answer = (op: string, a: Record<string, unknown>): Record<string, unknown> => {
		if (op === "open") {
			const bad = islandError(a.island);
			if (bad) throw new Error(bad);
			const w = worldOf(a.island as number | undefined);
			const start = a.start ?? w.episode.start, setup = (a.setup ?? {}) as { items?: unknown[] };
			const err = toyCellError(start, "start", w) ?? (setup.items ?? []).map((i, k) => toyCellError(i, `setup item ${k + 1}`, w)).find(Boolean) ?? null;
			if (err) throw new Error(err);
			const cell = (c: unknown) => { const o = c as Record<string, unknown>; return { room: String(o.room), x: Number(o.x), y: Number(o.y) }; };
			const seed = a.seed === undefined ? 0 : Number(a.seed);
			const id = `t${++n}`;
			if (a.rules !== undefined && a.rules !== "tide" && a.rules !== "chance") throw new Error(`unknown rules ${String(a.rules)}`);
			worlds.set(id, new ToyIsland(cell(start), (setup.items ?? []).map(cell), Number.isInteger(seed) && seed >= 0 ? seed : 0, w, a.rules === "tide" ? TIDE_RULES : a.rules === "chance" ? CHANCE_RULES : null));
			return { world: id, charId: `c-${id}`, name: "Strandläufer-1" };
		}
		if (op === "map") { const m = toyRoomMap(String(a.room ?? "")); if (!m) throw new Error(`no room ${String(a.room)}`); return m as unknown as Record<string, unknown>; }
		const t = worlds.get(String(a.world));
		if (!t) throw new Error("no such world");
		switch (op) {
			case "look": return t.look();
			case "act": return t.act(String(a.line ?? ""));
			case "wait": return t.wait(a.minutes);
			case "path": return toyPath(t.trail);
			// step 7: the landings so far; step 8: the whole day of the chance tide (a pure function of island and seed)
			case "tides": return t.rules?.tide === "chance" ? { tides: [], day: chanceDay(t.world, t.seed) } : { tides: t.landed.map((l) => ({ ...l, exits: [...l.exits] })) };
			case "score": {
				const goal = String(a.goal ?? ""), hold = Number(a.hold ?? 0);
				const feed = /^feed:(?:island|[\w-]+):(\d+)$/.exec(goal);
				if (feed && (goal.startsWith("feed:island:") || goal.startsWith(`feed:${t.world.fire.beaconId}:`))) {
					const n = Number(feed[1]);
					return { done: t.feeds >= n, count: t.feeds, detail: `${t.feeds} of ${n} pieces in the fire of ${t.world.name}, ${t.waited} world minutes gone` };
				}
				if (goal !== "beacon:island" && goal !== `beacon:${t.world.fire.beaconId}`) throw new Error(`unknown goal ${goal}`);
				const done = t.reached(Number.isFinite(hold) && hold > 0 ? hold : 0);
				return { done, detail: `the fire of ${t.world.name} ${t.lit(t.waited) ? "burns" : "is out"}, ${t.fed ? "fed by the bot" : "not fed by the bot"}${hold > 0 && t.reached(0) && !done ? `; reached, but not held ${hold} world minutes` : hold > 0 && done ? `; held ${hold} world minutes` : ""}` };
			}
			case "close": worlds.delete(String(a.world)); return {};
			default: throw new Error(`unknown op ${op}`);
		}
	};
	return {
		ask: async (op, args = {}) => ({ ok: true, ...answer(op, args) }),
		close: () => worlds.clear(),
		broken: () => false,
	};
}
