import assert from "node:assert/strict";
import test from "node:test";
import { stableHash, terrainHeight, tile3d, TERRAIN_RENDERER_VERSION } from "../client/terrain3d.ts";

test("3D terrain is deterministic, bounded and keeps water flat", () => {
	const ground = ["~.,", ":::"], tiles = { "~": { walk: false }, ".": { walk: true }, ",": { walk: true }, ":": { walk: true } };
	assert.equal(TERRAIN_RENDERER_VERSION, 1);
	assert.equal(stableHash("graue-bucht"), stableHash("graue-bucht"));
	assert.notEqual(stableHash("graue-bucht"), stableHash("klippenpfad"));
	assert.equal(terrainHeight("a", ground, tiles, 0, 0), tile3d("~", false).height);
	const a = terrainHeight("a", ground, tiles, 1, 0), again = terrainHeight("a", ground, tiles, 1, 0);
	assert.equal(a, again);
	assert.ok(Math.abs(a - tile3d(".", true).height) <= 0.0300001);
});

test("unknown tiles get a stable visual profile without changing their walk flag", () => {
	assert.deepEqual(tile3d("x", true), tile3d("x", true));
	assert.equal(tile3d("x", true).height, 0.24);
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
