// What a search over a room costs on the shared grid (shared/grid.ts) against the searches over "x,y" strings it replaced
// (tests/legacy-search.ts), in the TypeScript engine (plan section 3, "Performance strategy", phase 1). Two rooms of the
// world's tiles: one of the largest size at scale 1 (36 × 24) and one of the maximal size at scale 2 (72 × 48), each
// with a sixth of its cells blocked and a wall of water across with one gap; per room the four searches as the
// commands use them: findPath corner to corner with the command-bound limit (COMMAND_PATH) and without one, the reach
// of a building check from a corner, freeCellNear in the middle of an occupied block, the road's trace corner to corner.
//
//   node --no-warnings --experimental-strip-types --import ./tests/test-env.ts tests/perf/search-cost.ts
//
// Prints one JSON line: per room and search the median in microseconds of SEARCH_RUNS runs (default 200), old and new,
// and whether both gave the same answer.
import { closing, indexOf, reachIn, walkGrid } from "../../shared/grid.ts";
import { COMMAND_PATH } from "../../shared/rules.ts";
import { findPath, loadWorld } from "../../server/engine/world.ts";
import { freeCellNear } from "../../server/engine/occupancy.ts";
import { trace } from "../../server/engine/commands/road.ts";
import { legacyFindPath, legacyFreeCellNear, legacyReachable, legacyTrace } from "../legacy-search.ts";

const RUNS = Number(process.env.SEARCH_RUNS ?? 200);
const w = await loadWorld();
let seed = 5;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };

function room(wd: number, h: number): { ground: string[]; blocked: Set<string> } {
	const rows: string[][] = Array.from({ length: h }, () => Array.from({ length: wd }, () => (rnd() < 0.2 ? ":" : ",")));
	const wall = Math.floor(wd / 2), gap = Math.floor(h * 0.8);
	for (let y = 0; y < h; y++) if (y !== gap) rows[y]![wall] = "~";
	const blocked = new Set<string>();
	for (let y = 0; y < h; y++) for (let x = 0; x < wd; x++) if (rnd() < 1 / 6 && !(x < 2 && y < 2) && !(x >= wd - 2 && y >= h - 2) && !(x === wall - 1 || x === wall + 1)) blocked.add(`${x},${y}`);
	// an occupied block in the middle, for freeCellNear
	for (let y = Math.floor(h / 2) - 3; y <= Math.floor(h / 2) + 3; y++) for (let x = wall - 5; x <= wall - 2; x++) blocked.add(`${x},${y}`);
	return { ground: rows.map((r) => r.join("")), blocked };
}

const median = (f: () => unknown): number => {
	const t: number[] = [];
	for (let i = 0; i < RUNS; i++) { const s = performance.now(); f(); t.push(performance.now() - s); }
	t.sort((a, b) => a - b);
	return Math.round(t[Math.floor(t.length / 2)]! * 1000);
};

const out: Record<string, Record<string, { old: number; new: number; same: boolean }>> = {};
for (const [name, wd, h] of [["scale 1, 36x24", 36, 24], ["scale 2, 72x48", 72, 48]] as const) {
	const r = room(wd, h), from = { x: 0, y: 0 }, to = { x: wd - 1, y: h - 1 }, mid = { x: Math.floor(wd / 2) - 3, y: Math.floor(h / 2) };
	const reachNew = () => { const g = closing(walkGrid(w.tiles, r.ground), r.blocked), s = reachIn(g, from); return [...r.blocked].filter((k) => { const [x, y] = k.split(",").map(Number); const i = indexOf(g, { x: x!, y: y! }); return i >= 0 && s[i] === 1; }).length + s.reduce((a, b) => a + b, 0); };
	const reachOld = () => { const s = legacyReachable(w, r.ground, from, r.blocked); return [...r.blocked].filter((k) => s.has(k)).length + s.size; };
	const cases: Record<string, [() => unknown, () => unknown]> = {
		[`findPath, max ${COMMAND_PATH}`]: [() => legacyFindPath(w, r.ground, from, to, COMMAND_PATH, r.blocked), () => findPath(w, r.ground, from, to, COMMAND_PATH, r.blocked)],
		"findPath, room-wide": [() => legacyFindPath(w, r.ground, from, to, wd * h, r.blocked), () => findPath(w, r.ground, from, to, wd * h, r.blocked)],
		"reach of a building check": [reachOld, reachNew],
		"freeCellNear, radius 8": [() => legacyFreeCellNear(w, r.ground, mid, r.blocked, 8), () => freeCellNear(w, r.ground, mid, r.blocked, 8)],
		"road trace": [() => legacyTrace(w, r.ground, from, [to], r.blocked), () => trace(w, r.ground, from, [to], r.blocked)],
	};
	out[name] = {};
	for (const [c, [old, now]] of Object.entries(cases)) {
		for (let i = 0; i < 20; i++) { old(); now(); } // warm up
		out[name]![c] = { old: median(old), new: median(now), same: JSON.stringify(old()) === JSON.stringify(now()) };
	}
	if (!legacyFindPath(w, r.ground, from, to, wd * h, r.blocked)) throw new Error(`no way across ${name}`);
}
console.log(JSON.stringify({ runs: RUNS, unit: "µs (median)", rooms: out }));
