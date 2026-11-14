// The arena's JSON-line protocol (spaces-mmo/server/arena.ts) answered by the toy islands in the judge's own process
// (toyisland.ts), for a planning task whose episodes are islands made from a number (`bot.toy`, docs/codemode-planung
// .en.md, step 6). The judge plays such a task as it plays one in the arena (judge.ts judgeEpisodes); the task needs
// no arena, so every judge takes it. `open` takes the episode's island, start, setup and seed; `score` the goal
// `beacon:island` (the island's one fire), held `hold` world minutes; `path` the cells as the arena gives them; `map` a
// room's geometry. Subgoals are not watched here.
import type { Arena, PathStep } from "./bottask.ts";
import { islandError, toyCellError, toyRoomMap, ToyIsland, worldOf } from "./toyisland.ts";

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
			worlds.set(id, new ToyIsland(cell(start), (setup.items ?? []).map(cell), Number.isInteger(seed) && seed >= 0 ? seed : 0, w));
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
			case "score": {
				const goal = String(a.goal ?? ""), hold = Number(a.hold ?? 0);
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
