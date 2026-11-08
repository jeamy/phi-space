// The outlines of the 3D ground's terraces (client/terrace.ts): loops round the cells, holes, corners that touch, rounding.
import assert from "node:assert/strict";
import test from "node:test";
import { area, edgeSides, outlineLoops, rounded, terraces, withHoles } from "../client/terrace.ts";

const grid = (rows: string[]) => (x: number, y: number) => rows[y]?.[x] === "#";
const sizes = (rows: string[]) => outlineLoops(rows[0]!.length, rows.length, grid(rows)).map((l) => [l.outer, Math.abs(area(l.pts)) / 2, l.pts.length]);

test("a rectangle and an L are one outer loop each, with only their corners", () => {
	assert.deepEqual(sizes(["....", ".##.", ".##.", "...."]), [[true, 4, 4]]);
	assert.deepEqual(sizes(["#..", "#..", "###"]), [[true, 5, 6]]);
});

test("a ring is an outer loop and a hole, and the hole belongs to it", () => {
	const rows = ["#####", "#...#", "#...#", "#####"];
	assert.deepEqual(sizes(rows), [[true, 20, 4], [false, 6, 4]]);
	const [one] = withHoles(outlineLoops(5, 4, grid(rows)));
	assert.equal(one!.holes.length, 1);
});

test("cells that touch at a corner stay two loops", () => {
	assert.deepEqual(sizes(["#.", ".#"]), [[true, 1, 4], [true, 1, 4]]);
	// a ring round one cell: an outer loop and a hole
	assert.deepEqual(sizes(["###", "#.#", "###"]).map(([o]) => o), [true, false]);
});

test("a hole goes to the smallest outer loop round it: an island in a lake in an island", () => {
	const rows = ["#######", "#.....#", "#.###.#", "#.#.#.#", "#.###.#", "#.....#", "#######"];
	const parts = withHoles(outlineLoops(7, 7, grid(rows))).map((p) => [Math.abs(area(p.outer)) / 2, p.holes.map((q) => Math.abs(area(q)) / 2)]);
	assert.deepEqual(parts.sort((a, b) => Number(a[0]) - Number(b[0])), [[9, [1]], [49, [25]]]);
});

test("rounding replaces each corner by a quarter circle, keeps sharp ones, and never cuts more than half a side", () => {
	const square = outlineLoops(1, 1, () => true)[0]!.pts;
	const round = rounded(square, 0.42, 6);
	assert.equal(round.length, 4 * 7);
	// a circle-cornered unit square: its area is 1 - (4 - π) r²
	assert.ok(Math.abs(Math.abs(area(round)) / 2 - (1 - (4 - Math.PI) * 0.42 ** 2)) < 0.01);
	assert.ok(round.every(([x, y]) => x >= -1e-9 && y >= -1e-9 && x <= 1 + 1e-9 && y <= 1 + 1e-9));
	assert.equal(rounded(square, 0.42, 6, (p) => p[0] === 0 && p[1] === 0).length, 3 * 7 + 1);
	const big = rounded(square, 0.9, 4);
	assert.ok(big.every(([x, y]) => x >= -1e-9 && y >= -1e-9 && x <= 1 + 1e-9 && y <= 1 + 1e-9));
});

test("terraces: one per land kind, holding the higher ones; the edge rounds by the step it meets, the wall starts under the one below", () => {
	const KIND: Record<string, { height: number; water: boolean }> = { "~": { height: 0.06, water: true }, ".": { height: 0.2, water: false }, ":": { height: 0.36, water: false }, ",": { height: 0.5, water: false } };
	const ground = ["~~~~~", "~.:,~", "~.,,~", "~~~~~"];
	const ts = terraces(ground, (k) => KIND[k]!);
	assert.deepEqual(ts.map((t) => t.key), [".", ":", ","]);
	const sand = ts[0]!, paving = ts[1]!, grass = ts[2]!;
	// the sand terrace holds every land cell, the paving one paving and grass, the grass one grass only
	assert.deepEqual([sand.at(1, 1), sand.at(3, 2), sand.at(0, 0)], [true, true, false]);
	assert.deepEqual([paving.at(1, 1), paving.at(2, 1), paving.at(3, 1)], [false, true, true]);
	assert.deepEqual([grass.at(2, 1), grass.at(2, 2)], [false, true]);
	// the sand meets water (0.14 down), the grass meets sand (0.3 down); all within a cell's band, none higher than its step
	for (const t of ts) assert.ok(t.thick <= t.height - 0.06 && t.size < 0.5 && t.height - t.thick > t.bottom, t.key);
	assert.ok(Math.abs(sand.thick - 0.14 * 0.85) < 1e-9 && sand.bottom === 0);
	assert.ok(Math.abs(grass.thick - 0.26) < 1e-9);
	// each wall starts where the terrace below begins to round, so no groove shows at its foot
	assert.ok(Math.abs(paving.bottom - (0.2 - sand.thick)) < 1e-9 && Math.abs(grass.bottom - (0.36 - paving.thick)) < 1e-9);
	assert.deepEqual(edgeSides(ground, (k) => KIND[k]!.height, 2, 1), { n: true, e: false, s: false, w: true });
});
