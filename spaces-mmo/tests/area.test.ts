// An exit's or a fire's area (shared/grid.ts `Area`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.2): one cell
// without `w`/`h`, as the scale-1 definition writes them, so every rule keeps its answer there; an area of `w` × `h` at
// a finer grid. rust/mmo-engine/src/grid.rs `Area` has the same answers (its tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import { areaCells, besideArea, distToArea, inArea } from "../shared/grid.ts";

test("one cell: the point's distance, the four and eight neighbours in the old order", () => {
	const p = { x: 5, y: 7 };
	assert.deepEqual(areaCells(p), [p]);
	for (const c of [{ x: 5, y: 7 }, { x: 8, y: 6 }, { x: 2, y: 11 }, { x: 4, y: 7 }]) assert.equal(distToArea(c, p), Math.max(Math.abs(c.x - p.x), Math.abs(c.y - p.y)));
	assert.ok(inArea(p, p) && !inArea(p, { x: 6, y: 7 }));
	const near = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]].map(([dx, dy]) => ({ x: p.x + dx!, y: p.y + dy! }));
	assert.deepEqual(besideArea(p), near.slice(0, 4));
	assert.deepEqual(besideArea(p, true), near);
});

test("an area of 2 × 2: its cells, the distance to its nearest cell, its sides and corners", () => {
	const a = { x: 10, y: 4, w: 2, h: 2 };
	assert.deepEqual(areaCells(a), [{ x: 10, y: 4 }, { x: 11, y: 4 }, { x: 10, y: 5 }, { x: 11, y: 5 }]);
	assert.ok(inArea(a, { x: 11, y: 5 }) && !inArea(a, { x: 12, y: 5 }) && !inArea(a, { x: 10, y: 6 }));
	assert.equal(distToArea({ x: 11, y: 5 }, a), 0);
	assert.equal(distToArea({ x: 12, y: 4 }, a), 1);
	assert.equal(distToArea({ x: 13, y: 7 }, a), 2);
	assert.equal(distToArea({ x: 8, y: 4 }, a), 2);
	assert.deepEqual(besideArea(a), [{ x: 12, y: 4 }, { x: 12, y: 5 }, { x: 9, y: 4 }, { x: 9, y: 5 }, { x: 10, y: 6 }, { x: 11, y: 6 }, { x: 10, y: 3 }, { x: 11, y: 3 }]);
	assert.deepEqual(besideArea(a, true).slice(8), [{ x: 12, y: 6 }, { x: 9, y: 6 }, { x: 12, y: 3 }, { x: 9, y: 3 }]);
	for (const c of besideArea(a, true)) assert.equal(distToArea(c, a), 1);
});
