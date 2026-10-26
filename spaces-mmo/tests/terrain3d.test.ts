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
