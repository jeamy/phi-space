// The searches over a room on the shared grid (shared/grid.ts; plan section 3, "Performance strategy", phase 1): findPath,
// the reach of build.ts, freeCellNear and the road's trace give the same answers as the searches over cells keyed by
// "x,y" strings they replaced (tests/legacy-search.ts, kept as they were), over random rooms of the world's tiles with
// obstacles, blocked sets that also name cells outside the room, cut-offs at `max` and `radius`, blocked and
// unreachable targets and a start on its target. The neighbour order and the tie-break stay as they were, so the
// engine walks hold the Rust searches to the same answers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { closing, indexOf, reachIn, walkGrid } from "../shared/grid.ts";
import { findPath, loadWorld } from "../server/engine/world.ts";
import { freeCellNear } from "../server/engine/occupancy.ts";
import { trace } from "../server/engine/commands/road.ts";
import { key, legacyFindPath, legacyFreeCellNear, legacyReachable, legacyTrace, type Cell } from "./legacy-search.ts";

const w = await loadWorld();
let seed = 11;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
const int = (n: number) => Math.floor(rnd() * n);
const walk = Object.keys(w.tiles).filter((t) => w.tiles[t]!.walk), wet = Object.keys(w.tiles).filter((t) => !w.tiles[t]!.walk);

/** A room of the world's tiles: open ground with cobbles, water now and then and a wall of it across. */
function room(): { ground: string[]; blocked: Set<string>; cells: Cell[] } {
	const wd = 3 + int(40), h = 3 + int(26), water = rnd() * 0.45, cobble = rnd() * 0.5;
	const rows = Array.from({ length: h }, () => Array.from({ length: wd }, () => (rnd() < water ? wet[int(wet.length)]! : rnd() < cobble ? ":" : walk[int(walk.length)]!)));
	if (rnd() < 0.3) { const x = int(wd); for (let y = 0; y < h; y++) rows[y]![x] = wet[0]!; }
	const blocked = new Set<string>();
	for (let i = int(wd * h * 0.25); i > 0; i--) blocked.add(`${int(wd + 4) - 2},${int(h + 4) - 2}`); // some outside the room
	const cells: Cell[] = [];
	for (let y = -1; y <= h; y++) for (let x = -1; x <= wd; x++) cells.push({ x, y });
	return { ground: rows.map((r) => r.join("")), blocked, cells };
}
const pick = (r: { cells: Cell[] }) => r.cells[int(r.cells.length)]!;
const inside = (ground: string[]) => ({ x: int(ground[0]!.length), y: int(ground.length) });

test("findPath on the grid: the same way as over string keys, cut off at max, blocked or unreachable targets", () => {
	let found = 0, cut = 0;
	for (let i = 0; i < 600; i++) {
		const r = room(), from = rnd() < 0.1 ? pick(r) : inside(r.ground), to = rnd() < 0.1 ? from : pick(r);
		if (indexOf({ w: r.ground[0]!.length, h: r.ground.length }, from) < 0) continue; // a figure stands in its room
		const max = rnd() < 0.3 ? int(12) : 80, blocked = rnd() < 0.2 ? new Set<string>() : r.blocked;
		const before = legacyFindPath(w, r.ground, from, to, max, blocked), after = findPath(w, r.ground, from, to, max, blocked);
		assert.deepEqual(after, before, `#${i} ${r.ground[0]!.length}x${r.ground.length} ${key(from)} -> ${key(to)} max ${max}`);
		if (before?.length) found++;
		if (!before && legacyFindPath(w, r.ground, from, to, 10_000, blocked)) cut++;
	}
	assert.ok(found > 100 && cut > 10, `${found} ways found, ${cut} cut off at max`);
});

test("the reach of a building check on the grid: the same cells as over string keys", () => {
	for (let i = 0; i < 400; i++) {
		const r = room(), from = inside(r.ground);
		const before = legacyReachable(w, r.ground, from, r.blocked);
		const g = closing(walkGrid(w.tiles, r.ground), r.blocked), reach = reachIn(g, from);
		for (const c of r.cells) { const at = indexOf(g, c); assert.equal(at >= 0 && reach[at] === 1, before.has(key(c)), `#${i} ${key(c)} from ${key(from)}`); }
	}
});

test("freeCellNear on the grid: the same cell as over string keys, within the radius or none", () => {
	let none = 0;
	for (let i = 0; i < 600; i++) {
		const r = room(), at = pick(r), radius = rnd() < 0.3 ? int(4) : 8;
		const before = legacyFreeCellNear(w, r.ground, at, r.blocked, radius);
		assert.deepEqual(freeCellNear(w, r.ground, at, r.blocked, radius), before, `#${i} at ${key(at)} radius ${radius}`);
		assert.deepEqual(freeCellNear(w, r.ground, at, new Map([...r.blocked].map((k) => [k, 1])), radius), before, `#${i} with a map`);
		if (!before) none++;
	}
	assert.ok(none > 10, `${none} without a free cell`);
});

test("the road's trace on the grid: the same cheapest way as over string keys, over cobbles first", () => {
	let found = 0;
	for (let i = 0; i < 400; i++) {
		const r = room(), from = inside(r.ground), to = Array.from({ length: 1 + int(4) }, () => pick(r));
		const before = legacyTrace(w, r.ground, from, to, r.blocked);
		assert.deepEqual(trace(w, r.ground, from, to, r.blocked), before, `#${i} ${key(from)} -> ${to.map(key).join(" ")}`);
		if (before) found++;
	}
	assert.ok(found > 100, `${found} traces found`);
});
