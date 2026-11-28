// What a tap's target choice costs the client (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 6): the
// cells it looks at and the time, in the largest room (w.growth maxW × maxH), for a reachable target, an unreachable one
// and an occupied target whose surroundings are unreachable. No space, no browser: the search of client/walk.ts
// (`nextStep`) with a counting `free`, and the choice App.tsx `walkTo` made before 2026-11-24 copied here (`legacy`: the
// goal when it is free, else the first cell of the rings 1 to 6 that is free and has a way, a search per candidate),
// beside the one search of client/walk.ts `chooseTarget` that replaced it (`oneSearch`), and the whole tap as App.tsx
// `walkTo` does it since phase 2 step 5 (`tap`): `chooseTarget`, then the first move of the way there by `nextMove`, a
// search over the whole room (its area the budget). `legacy` keeps the `nextStep` of before with its limit of 1024
// cells, so at scale 2 it finds no way across the largest room; `tap` is what case 6 measures.
//
//   node --no-warnings --experimental-strip-types tests/perf/target-choice.ts
//
// Prints one JSON line per case: the room, the rings (TARGET_RINGS at the world's scale), the candidates tried, the
// searches run, the cells looked at (calls of `free`) and the median time of TARGET_RUNS choices (default 20) on this
// machine; for `tap` the bound of case 6, the room's cells plus the candidates of the rings. The phone's time is recorded on the phone.
import { chooseTarget, nextMove, nextStep } from "../../client/walk.ts";
import { loadWorld } from "../../server/engine/world.ts";
import { STEP_LENGTH, TARGET_RINGS } from "../../shared/rules.ts";

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
	const { free: f2, counter: c2 } = room(c.wall, c.taken);
	const end2 = chooseTarget(f2, c.start, c.goal, W, H, TARGET_RINGS), looks2 = c2.looks, times2: number[] = [];
	for (let i = 0; i < RUNS; i++) { const t = performance.now(); chooseTarget(f2, c.start, c.goal, W, H, TARGET_RINGS); times2.push(performance.now() - t); }
	times2.sort((a, b) => a - b);
	if (JSON.stringify(end2) !== JSON.stringify(result.end ?? null)) throw new Error(`${c.name}: the one search chose ${JSON.stringify(end2)}, the legacy choice ${JSON.stringify(result.end)}`);
	const ms = (t: number[]) => Math.round(t[Math.floor(t.length / 2)]! * 1000) / 1000;
	// the whole tap: the choice, then the first move of the way to it
	const { free: f3, counter: c3 } = room(c.wall, c.taken);
	const tap = () => { const end = chooseTarget(f3, c.start, c.goal, W, H, TARGET_RINGS); return end ? nextMove(f3, c.start, end, W, H, STEP_LENGTH, null) : null; };
	const move = tap(), looks3 = c3.looks, times3: number[] = [];
	for (let i = 0; i < RUNS; i++) { const t = performance.now(); tap(); times3.push(performance.now() - t); }
	times3.sort((a, b) => a - b);
	const candidates = (2 * TARGET_RINGS + 1) ** 2 - 1;
	console.log(JSON.stringify({ case: c.name, room: `${W}x${H}`, cells: W * H, rings: TARGET_RINGS, end: result.end ?? null, way: result.way, legacy: { candidates: result.candidates, searches, looks, medianMs: ms(times) }, oneSearch: { looks: looks2, medianMs: ms(times2) }, tap: { end: end2, way: !!move, looks: looks3, bound: W * H + candidates, medianMs: ms(times3) } }));
}
