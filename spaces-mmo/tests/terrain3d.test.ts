import assert from "node:assert/strict";
import test from "node:test";
import { stableHash, terrainHeight, tile3d, TERRAIN_RENDERER_VERSION } from "../client/terrain3d.ts";

test("3D terrain is deterministic, bounded and keeps water flat", () => {
	const ground = ["~.,", ":::"], tiles = { "~": { walk: false }, ".": { walk: true }, ",": { walk: true }, ":": { walk: true } };
	assert.equal(TERRAIN_RENDERER_VERSION, 2);
	assert.equal(stableHash("graue-bucht"), stableHash("graue-bucht"));
	assert.notEqual(stableHash("graue-bucht"), stableHash("klippenpfad"));
	assert.equal(terrainHeight("a", ground, tiles, 0, 0), tile3d("~", false).height);
	const a = terrainHeight("a", ground, tiles, 1, 0), again = terrainHeight("a", ground, tiles, 1, 0);
	assert.equal(a, again);
	assert.ok(Math.abs(a - tile3d(".", true).height) <= 0.0300001);
});

test("the zoom ladder: the elevation falls steadily from the island to close up, and the levels follow the zoom", async () => {
	const { clampZoom, elevationAt, levelAt, ZOOM_MAX, ZOOM_MIN } = await import("../client/camera3d.ts");
	const deg = (z: number) => (elevationAt(z) * 180) / Math.PI;
	assert.equal(Math.round(deg(ZOOM_MIN)), 60);
	assert.equal(Math.round(deg(0.6)), 52);
	assert.equal(Math.round(deg(ZOOM_MAX)), 22);
	for (let z = ZOOM_MIN; z < ZOOM_MAX; z *= 1.1) assert.ok(deg(z * 1.1) <= deg(z) + 1e-9, `elevation rises at zoom ${z}`);
	assert.equal(deg(100), deg(ZOOM_MAX));
	assert.equal(clampZoom(0.01), ZOOM_MIN);
	assert.equal(clampZoom(9), ZOOM_MAX);
	assert.deepEqual([0.2, 0.5, 1, 3].map(levelAt), ["island", "approach", "room", "close"]);
});

test("unknown tiles get a stable visual profile without changing their walk flag", () => {
	assert.deepEqual(tile3d("x", true), tile3d("x", true));
	assert.equal(tile3d("x", true).height, 0.3);
	assert.equal(tile3d("x", false).height, 0.12);
});

test("plants are models: every sort of the world has a form, each stage is its own, and a shape stays the same for its key", async () => {
	const t = await import("three");
	const { cropGeometry, fieldCropGeometry, plantGeometry } = await import("../client/props3d.ts");
	const { loadWorld } = await import("../server/engine/world.ts");
	const w = await loadWorld();
	for (const s of w.garden!.sorts) {
		assert.ok(s.model, s.key);
		const color = Number.parseInt(s.color.slice(1), 16), counts = [0, 1, 2, 3].map((stage) => cropGeometry(t, s.model!, stage, color).getAttribute("position").count);
		assert.ok(counts.every((n) => n > 0) && new Set(counts).size >= 3, `${s.key}: ${counts}`);
		assert.equal(cropGeometry(t, s.model!, 2, color), cropGeometry(t, s.model!, 2, color), "made once and shared");
	}
	for (const c of w.fields!.crops) {
		assert.ok(c.model, c.key);
		const g = fieldCropGeometry(t, c.model!, 4, 4, 1, 0xd9b44a, false);
		g.computeBoundingBox();
		assert.ok(g.boundingBox!.max.x <= 2.1 && g.boundingBox!.min.x >= -2.1 && g.boundingBox!.max.y > 0.1, c.key);
	}
	for (const d of Object.values(w.decor ?? {})) assert.ok(d.model, "every plant of the ground is a model");
	const flower = plantGeometry(t, "flower", 1, 0xffd54a);
	assert.notEqual(flower, plantGeometry(t, "flower", 1, 0xff9ec4), "a colour is its own shape");
	flower.computeBoundingBox();
	assert.ok(flower.boundingBox!.max.y < 0.5 && !Number.isNaN(flower.boundingBox!.max.y));
});

test("day and night: full light from 7 to 19, dark from 21 to 5, a smooth dawn and dusk; lamplit faces are marked", async () => {
	const { daylightAt } = await import("../client/camera3d.ts");
	assert.equal(daylightAt(12), 1); assert.equal(daylightAt(7), 1); assert.equal(daylightAt(19), 1);
	assert.equal(daylightAt(0), 0); assert.equal(daylightAt(3), 0); assert.equal(daylightAt(22), 0); assert.equal(daylightAt(24 + 12), 1);
	for (let h = 5; h < 7; h += 0.25) assert.ok(daylightAt(h) <= daylightAt(h + 0.25), `dawn ${h}`);
	for (let h = 19; h < 21; h += 0.25) assert.ok(daylightAt(h) >= daylightAt(h + 0.25), `dusk ${h}`);
	const t = await import("three");
	const { buildingModel } = await import("../client/buildings3d.ts");
	const g = buildingModel(t, "rathaus", 3, 3, 0)!, glow = g.getAttribute("glow");
	assert.equal(glow.count, g.getAttribute("position").count);
	const lit = Array.from(glow.array as Float32Array).filter((v) => v > 0).length;
	assert.ok(lit > 0 && lit < glow.count / 2, `the town hall's windows glow, its walls do not (${lit} of ${glow.count})`);
});

test("the room's block shows a seabed behind its sea sides and fish that stay inside it", async () => {
	const t = await import("three");
	const { BLOCK_DEPTH, fishFor, sides, swimFish } = await import("../client/block3d.ts");
	const ground = ["~~~~", "~..~", "~..,", "~~~~"];
	const { edges, bed } = sides(t, ground, (k) => k === "~", BLOCK_DEPTH);
	assert.equal(bed.getAttribute("position").count, edges.length * 12, "a slope and a back wall per sea edge");
	assert.equal(edges.length, 15, "every sea border cell but the grass one");
	assert.ok(edges.every((e) => Math.abs(e.ix) + Math.abs(e.iz) === 1));
	const fish = fishFor(t, edges, 4, 4, 7);
	assert.ok(fish.length >= 3);
	for (const time of [0, 3.3, 17, 99]) {
		swimFish(fish, time);
		for (const f of fish) assert.ok(Math.abs(f.mesh.position.x) <= 2 && Math.abs(f.mesh.position.z) <= 2 && f.mesh.position.y < 0, "inside the block, under the water");
	}
});
