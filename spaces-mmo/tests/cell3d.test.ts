// The 3D view at the actual cell (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "3D"; client/cell3d.ts): a
// cell's edge is 1 / gridScale world units, the forward and the inverse transform agree at every cell and at the room's
// border, scale 1 keeps its old numbers to the bit, and a room at scale 2 (every cell of scale 1 as two by two) covers
// the same ground with its terraces, its block and its shore as at scale 1.
import assert from "node:assert/strict";
import test from "node:test";
import { useGridScale } from "../shared/rules.ts";
import { borderWorld, cellEdge, cornerCells, edgeSize, toCell, toWorld } from "../client/cell3d.ts";

/** A ground of scale 1 at scale 2: every cell two by two. */
const doubled = (ground: string[]) => ground.flatMap((row) => { const d = [...row].map((c) => c + c).join(""); return [d, d]; });
const atScale = async <T>(g: number, fn: () => T | Promise<T>): Promise<T> => { useGridScale(g); try { return await fn(); } finally { useGridScale(1); } };

test("the cell transform: its inverse at every cell and at the border, scale 1 unchanged to the bit", async () => {
	for (const g of [1, 2]) await atScale(g, () => {
		const e = cellEdge(), w = 24 * g;
		assert.equal(e, 1 / g);
		for (let x = 0; x < w; x++) {
			assert.equal(toCell(toWorld(x, w), w), x, `cell ${x} at scale ${g}`);
			// a hair inside either border of the cell is still that cell
			assert.equal(toCell(borderWorld(x, w) + 1e-6, w), x);
			assert.equal(toCell(borderWorld(x + 1, w) - 1e-6, w), x);
		}
		assert.equal(borderWorld(0, w), -12, "the room covers the same ground at both scales");
		assert.equal(borderWorld(w, w), 12);
		assert.equal(toCell(borderWorld(0, w) - 1e-6, w), -1, "beyond the edge is outside the room");
		assert.equal(toCell(borderWorld(w, w), w), w);
	});
	for (const w of [1, 7, 24, 36]) for (let x = -1; x <= w; x += 0.25) assert.ok(Object.is(toWorld(x, w), x - w / 2 + 0.5), `${x} of ${w}`);
	assert.deepEqual([cornerCells(1), cornerCells(0.5)], [0.42, 0.45], "0.42 world units, at most 0.45 of a cell");
	assert.deepEqual([edgeSize(0.34, 1), edgeSize(0.34, 0.5), edgeSize(0.1, 0.5)], [0.34, 0.225, 0.1]);
});

test("a room at scale 2 covers the ground of scale 1: terraces, block sides, fish and shore", async () => {
	const t = await import("three");
	const { terraceMeshes } = await import("../client/terraces3d.ts");
	const { BLOCK_DEPTH, fishFor, sides } = await import("../client/block3d.ts");
	const { shoreDistances, SHORE_REACH, waterLine } = await import("../client/water3d.ts");
	const ground = ["~~~~~~", "~..,,~", "~.,,,.", "~~..~~", "~~~~~~"];
	const kind = (key: string) => ({ height: key === "~" ? 0.1 : key === "." ? 0.25 : 0.4, water: key === "~" });
	const look = () => { const m = new t.MeshBasicMaterial(); return { top: m, flank: m, wall: m }; };
	const measure = (g: number) => atScale(g, () => {
		const grid = g === 1 ? ground : doubled(ground);
		const box = new t.Box3();
		for (const mesh of terraceMeshes(t, grid, kind, look)) { mesh.geometry.computeBoundingBox(); box.union(mesh.geometry.boundingBox!); }
		const { edges } = sides(t, grid, (k) => k === "~", BLOCK_DEPTH);
		const length = edges.reduce((n, x) => n + Math.hypot(x.bx - x.ax, x.bz - x.az), 0);
		const far = Math.max(...edges.flatMap((x) => [Math.abs(x.ax), Math.abs(x.bx)]));
		const fish = fishFor(edges, ground[0]!.length, ground.length, 7);
		// the shore: how far (world units) the water cell two world units west of the east land cell lies from the land
		const cells = (x: number, y: number) => shoreDistances(grid, (k) => k === "~", SHORE_REACH / cellEdge())[y * grid[0]!.length + x]! * cellEdge();
		return { box: [box.min.x, box.max.x, box.min.z, box.max.z, +box.max.y.toFixed(6)], length, far, fish: fish.length, edges: edges.length, shore: g === 1 ? cells(3, 0) : cells(6, 0), line: waterLine() };
	});
	const one = await measure(1), two = await measure(2);
	assert.deepEqual(two.box, one.box, "the terraces reach as far and as high");
	assert.deepEqual([two.length, two.far], [one.length, one.far], "the block's sea sides are as long and reach as far");
	assert.equal(two.edges, one.edges * 2, "a quad per border cell");
	assert.equal(two.fish, one.fish, "as many fish: their number goes by the sides' length");
	assert.equal(two.shore, one.shore, "the shore as far out in world units");
	assert.deepEqual([one.line, two.line], [0.125, 0.0625], "the waterline half a cell out");
});
