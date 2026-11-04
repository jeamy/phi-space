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

test("manual tilt is bounded and Alt-wheel never changes zoom", async () => {
	const { cameraElevation, clampTilt, elevationAt, wheelView } = await import("../client/camera3d.ts");
	assert.equal(clampTilt(100), 25); assert.equal(clampTilt(-100), -25); assert.equal(clampTilt(NaN), 0);
	for (const zoom of [0.2, 0.6, 1.4, 5]) {
		assert.equal(cameraElevation(zoom, 0), elevationAt(zoom));
		for (const tilt of [-100, -25, 25, 100]) assert.ok(cameraElevation(zoom, tilt) >= 14 * Math.PI / 180 && cameraElevation(zoom, tilt) <= 75 * Math.PI / 180);
	}
	assert.deepEqual(wheelView(-100, true), { zoomFactor: 1, tiltDelta: 3 });
	assert.deepEqual(wheelView(100, true), { zoomFactor: 1, tiltDelta: -3 });
	assert.equal(wheelView(-100, false).tiltDelta, 0); assert.ok(wheelView(-100, false).zoomFactor > 1);
	assert.deepEqual(wheelView(0, true), { zoomFactor: 1, tiltDelta: 0 });
});

test("new arrivals start in the frontal 3D room overview; returning players keep their mode", async () => {
	const { readMapMode, resetStartView, START_VIEW } = await import("../client/viewPreferences.ts");
	const values = new Map<string, string>(), storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
	assert.equal(readMapMode(storage), "3d");
	for (const mode of ["text", "2d", "3d"] as const) { values.set("mmo.renderer", mode); assert.equal(readMapMode(storage), mode); }
	values.delete("mmo.renderer"); values.set("mmo.textOnly", "1"); assert.equal(readMapMode(storage), "text");
	values.set("mmo.3d.zoom", "5"); values.set("mmo.3d.angle", "0"); values.set("mmo.3d.tilt", "-12"); values.set("mmo.renderer", "2d");
	assert.equal(readMapMode(storage), "2d"); assert.equal(values.get("mmo.3d.tilt"), "-12");
	resetStartView(storage);
	assert.equal(readMapMode(storage), "3d");
	assert.equal(Number(values.get("mmo.3d.zoom")), 1.4);
	assert.equal(Number(values.get("mmo.3d.angle")), Math.PI / 2);
	assert.equal(Number(values.get("mmo.3d.tilt")), 15);
	assert.deepEqual(START_VIEW, { zoom: 1.4, angle: Math.PI / 2, tilt: 15 });
	const denied = { getItem: () => { throw new Error("storage denied"); }, setItem: () => { throw new Error("storage denied"); } };
	assert.equal(readMapMode(denied), "3d"); assert.doesNotThrow(() => resetStartView(denied));
});

test("close-up detail has hysteresis, turns off outside close zoom and caps paving work", async () => {
	const { closeBlur, nearDetail, detailCells, frameSummary } = await import("../client/closeup3d.ts");
	assert.equal(closeBlur(1.9), 0); assert.equal(closeBlur(2), 0); assert.equal(closeBlur(5), 1);
	assert.equal(nearDetail(1, 3, true), false);
	assert.equal(nearDetail(3, 15, false), true);
	assert.equal(nearDetail(3, 17, true), true);
	assert.equal(nearDetail(3, 17, false), false);
	assert.equal(nearDetail(3, 19, true), false);
	const ground = Array.from({ length: 20 }, () => ":".repeat(20));
	const cells = detailCells(ground, 10, 10);
	assert.equal(cells.length, 24); assert.deepEqual(cells[0], { x: 10, y: 10 });
	assert.deepEqual(detailCells(["~~~", "~:~"], 1, 1), [{ x: 1, y: 1 }]);
	const report = frameSummary([10, 20, 30, 40], [2, 4, 6, 8], 100, 9);
	assert.equal(report.fps, 40); assert.equal(report.p95Ms, 40); assert.equal(report.drawCalls, 5);
	assert.equal(report.frames, 4); assert.equal(report.triangles, 100); assert.equal(report.geometries, 9);
});

test("postprocessing is not allocated in the island and room views", async () => {
	const t = await import("three"), { createClosePost } = await import("../client/closeuppost3d.ts");
	const scene = new t.Scene(), camera = new t.PerspectiveCamera();
	let renders = 0;
	const renderer = { render: (s: unknown, c: unknown) => { assert.equal(s, scene); assert.equal(c, camera); renders++; } } as unknown as import("three").WebGLRenderer;
	const post = createClosePost(renderer, scene, camera);
	post.resize(390, 844); post.render(0); post.dispose(); post.dispose();
	assert.equal(renders, 1);
});

test("near barrel geometry is cached separately, with more detail and the same footprint", async () => {
	const t = await import("three"), { barrel } = await import("../client/props3d.ts");
	const far = barrel(t), near = barrel(t, true);
	assert.equal(near, barrel(t, true)); assert.notEqual(far, near);
	assert.ok(near.getAttribute("position").count > far.getAttribute("position").count);
	for (const geometry of [near, far]) {
		geometry.computeBoundingBox();
		assert.ok(geometry.boundingBox!.max.x <= 0.39 && geometry.boundingBox!.min.x >= -0.39);
		assert.ok(geometry.boundingBox!.max.y <= 0.75);
	}
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
