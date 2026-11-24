// What a tap's target choice costs the client (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 6): the
// cells it looks at and the time, in the largest room (w.growth maxW × maxH), for a reachable target, an unreachable one
// and an occupied target whose surroundings are unreachable. No space, no browser: the search of client/walk.ts
// (`nextStep`) with a counting `free`, and the choice of client/App.tsx `walkTo` copied here: the goal when it is free,
// else the first of the cells in rings 1 to 6 around it that is free and has a way (App.tsx; keep the two alike until
// phase 1 replaces the choice by one search).
//
//   node --no-warnings --experimental-strip-types tests/perf/target-choice.ts
//
// Prints one JSON line per case: the room, the candidates tried, the searches run, the cells looked at (calls of `free`)
// and the median time of TARGET_RUNS choices (default 20) on this machine. The phone's time is recorded on the phone.
import { nextStep } from "../../client/walk.ts";
import { loadWorld } from "../../server/engine/world.ts";

type Cell = { x: number; y: number };
const RUNS = Number(process.env.TARGET_RUNS ?? 20);
const w = await loadWorld();
const W = w.growth!.maxW, H = w.growth!.maxH;
const water = Object.entries(w.tiles).find(([, t]) => !t.walk)![0], grass = w.growth!.tile;

/** App.tsx walkTo: where a tap at `goal` leads, and whether there is a way to it (`way`). */
function choose(free: (x: number, y: number) => boolean, start: Cell, goal: Cell, search = nextStep): { end: Cell | undefined; way: boolean; candidates: number } {
	const cells: Cell[] = [goal];
	for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push({ x: goal.x + dx, y: goal.y + dy });
	const here = (c: Cell) => c.x === start.x && c.y === start.y;
	let candidates = 0;
	const end = free(goal.x, goal.y) ? goal : cells.find((c) => { candidates++; return (free(c.x, c.y) || here(c)) && (here(c) || search(free, start, c)); });
	const way = !!end && (here(end) || !!search(free, start, end));
	return { end, way, candidates };
}

/** A room of grass with a column of water at `wall` (none: -1) and the cells of `taken` occupied. */
function room(wall: number, taken: Array<Cell & { w: number; h: number }>) {
	const ground = Array.from({ length: H }, () => Array.from({ length: W }, (_, x) => (x === wall ? water : grass)).join(""));
	const blocked = new Set<string>();
	for (const t of taken) for (let y = t.y; y < t.y + t.h; y++) for (let x = t.x; x < t.x + t.w; x++) blocked.add(`${x},${y}`);
	const counter = { looks: 0 };
	const free = (x: number, y: number) => { counter.looks++; return !!w.tiles[ground[y]?.[x] ?? ""]?.walk && !blocked.has(`${x},${y}`); };
	return { free, counter };
}

const middle = { x: Math.floor(W / 2) + 3, y: Math.floor(H / 2) };
const cases: Array<{ name: string; wall: number; taken: Array<Cell & { w: number; h: number }>; start: Cell; goal: Cell }> = [
	{ name: "reachable", wall: -1, taken: [], start: { x: 1, y: 1 }, goal: middle },
	// the figure on a strip of land behind water: the tapped cell is free, there is no way
	{ name: "unreachable", wall: 5, taken: [], start: { x: 1, y: 1 }, goal: middle },
	// the tapped cell is a building's, every cell around it beyond the water: each candidate searches the far side
	{ name: "occupied-enclosed", wall: 5, taken: [{ x: middle.x - 1, y: middle.y - 1, w: 3, h: 3 }], start: { x: 1, y: 1 }, goal: middle },
];

for (const c of cases) {
	const { free, counter } = room(c.wall, c.taken);
	let searches = 0;
	const result = choose(free, c.start, c.goal, (f, from, to) => { searches++; return nextStep(f, from, to); });
	const looks = counter.looks, times: number[] = [];
	for (let i = 0; i < RUNS; i++) { const t = performance.now(); choose(free, c.start, c.goal); times.push(performance.now() - t); }
	times.sort((a, b) => a - b);
	console.log(JSON.stringify({ case: c.name, room: `${W}x${H}`, cells: W * H, end: result.end ?? null, way: result.way, candidates: result.candidates, searches, looks, medianMs: Math.round(times[Math.floor(times.length / 2)]! * 1000) / 1000 }));
}
