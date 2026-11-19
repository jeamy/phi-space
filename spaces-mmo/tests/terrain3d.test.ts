import assert from "node:assert/strict";
import test from "node:test";
import { stableHash, terrainHeight, tile3d, TERRAIN_RENDERER_VERSION } from "../client/terrain3d.ts";

test("3D terrain is deterministic, bounded and keeps water flat", () => {
	const ground = ["~.,", ":::"], tiles = { "~": { walk: false }, ".": { walk: true }, ",": { walk: true }, ":": { walk: true } };
	assert.equal(TERRAIN_RENDERER_VERSION, 3);
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

test("the sun and the moon cross the sky with the world's clock, and one of them always lights the room", async () => {
	const { shadowLightAt, skyAt } = await import("../client/camera3d.ts");
	const deg = (r: number) => (r * 180) / Math.PI, len = (v: readonly number[]) => Math.hypot(v[0]!, v[1]!, v[2]!);
	const noon = skyAt(13);
	assert.equal(Math.round(deg(noon.sunElevation)), 58); assert.ok(noon.sun[2] > 0.5 && Math.abs(noon.sun[0]) < 1e-9, "the sun stands in the south at 13:00");
	assert.ok(skyAt(7).sun[0] > 0 && skyAt(19).sun[0] < 0, "east in the morning, west in the evening");
	assert.ok(Math.abs(skyAt(5.5).sunElevation) < 1e-9 && Math.abs(skyAt(20.5).sunElevation) < 1e-9);
	assert.ok(skyAt(1).sunElevation < 0 && skyAt(1).moonElevation > 0);
	for (let h = 0; h < 24; h += 0.25) {
		const sky = skyAt(h), light = shadowLightAt(h);
		assert.ok(Math.abs(len(sky.sun) - 1) < 1e-9 && Math.abs(len(sky.moon) - 1) < 1e-9 && Math.abs(len(light.dir) - 1) < 1e-9);
		assert.ok(deg(Math.asin(light.dir[1])) >= 12 - 1e-9, `the light lies too flat at ${h}`);
		assert.equal(light.body, sky.sunElevation > 0 ? "sun" : "moon");
		assert.ok(light.strength >= 0 && light.strength <= 1 && light.warm >= 0 && light.warm <= 1);
	}
	// the change from the sun to the moon happens in the dark of neither
	for (const h of [20.49, 20.51, 5.49, 5.51]) assert.ok(shadowLightAt(h).strength < 0.02, `a jump of the light at ${h}`);
	assert.equal(shadowLightAt(13).strength, 1); assert.equal(shadowLightAt(13).warm, 0);
	assert.ok(shadowLightAt(0.5).strength > 0.9, "the moon is high at midnight");
});

test("the water knows how far the shore is: 0 on land, a cell more with every step out, never beyond its reach", async () => {
	const { SHORE_REACH, shoreDistances } = await import("../client/water3d.ts");
	const water = (key: string) => key === "~";
	const ground = ["~~~~~~~", "~~~~~~~", "~~~.~~~", "~~~~~~~", "~~~~~~~"], d = shoreDistances(ground, water), at = (x: number, y: number) => d[y * 7 + x]!;
	assert.equal(at(3, 2), 0);
	assert.equal(at(4, 2), 1); assert.equal(at(3, 0), 2); assert.equal(at(0, 2), 3);
	assert.ok(Math.abs(at(4, 3) - Math.SQRT2) < 1e-6 && Math.abs(at(5, 4) - 2 * Math.SQRT2) < 1e-6, "a diagonal step counts √2");
	assert.equal(SHORE_REACH, 4);
	const far = shoreDistances(["~".repeat(12) + "."], water);
	assert.equal(far[0], SHORE_REACH); assert.equal(far[11], 1); assert.equal(far[12], 0);
	assert.deepEqual([...shoreDistances(["~~", "~~"], water)], [4, 4, 4, 4], "no land: open water everywhere");
	assert.deepEqual([...shoreDistances([], water)], []);
});

test("every ground material of the 3D view has its three pictures and its line in the credits", async () => {
	const { existsSync, readFileSync, statSync } = await import("node:fs");
	const { GROUND } = await import("../client/ground3d.ts");
	const root = new URL("../", import.meta.url).pathname, credits = readFileSync(`${root}worlds/leuchtfeuer/assets/CREDITS.md`, "utf8");
	const names = new Set([...Object.values(GROUND).map((g) => g.name), "rock"]);
	assert.deepEqual(Object.keys(GROUND).sort(), ["#", ",", ".", ":", "_"].sort());
	for (const name of names) {
		for (const file of ["color", "normal", "arm"]) {
			const path = `${root}public/materials/${name}/${file}.jpg`;
			assert.ok(existsSync(path), `${path} is missing`);
			assert.ok(statSync(path).size < 700_000, `${path} is larger than 700 kB`);
		}
		assert.ok(credits.includes(`\`public/materials/${name}/\``), `no credit for ${name}`);
	}
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
		assert.ok(g.boundingBox!.max.x <= 2.15 && g.boundingBox!.min.x >= -2.15 && g.boundingBox!.max.y > 0.1, c.key);
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
		for (const f of fish) assert.ok(Math.abs(f.group.position.x) <= 2 && Math.abs(f.group.position.z) <= 2 && f.group.position.y < 0, "inside the block, under the water");
	}
});

test("fish: three kinds with a body and a tail at every detail level, finer up close; fish items lie as models", async () => {
	const t = await import("three");
	const { FISH_KINDS, fishBody, fishTail, fishItem } = await import("../client/fish3d.ts");
	const { atModelLevel } = await import("../client/modelDetail3d.ts");
	const tris = (g: import("three").BufferGeometry) => g.getAttribute("position").count / 3;
	for (const kind of FISH_KINDS) for (const smoked of [false, true]) {
		const [far, room, near] = (["far", "room", "near"] as const).map((level) => atModelLevel(level, () => fishBody(t, kind, smoked)));
		assert.ok(tris(far!) < tris(room!) && tris(room!) < tris(near!), `${kind} ${smoked}: ${tris(far!)} < ${tris(room!)} < ${tris(near!)}`);
		assert.equal(fishBody(t, kind, smoked), fishBody(t, kind, smoked), "made once and shared");
		const tail = fishTail(t, kind, smoked);
		tail.computeBoundingBox();
		assert.ok(tail.boundingBox!.max.x <= 0.0125 && tail.boundingBox!.min.x < -0.04, `${kind}: the tail reaches back from its root`);
		room!.computeBoundingBox();
		assert.ok(room!.boundingBox!.max.x > 0.1 && room!.boundingBox!.max.x < 0.2, `${kind}: nose towards +x`);
	}
	assert.deepEqual(fishItem("/assets/leuchtfeuer/items/fisch.png"), { kind: "dorsch", smoked: false });
	assert.deepEqual(fishItem("items/raeucherfisch.png"), { kind: "hering", smoked: true });
	assert.equal(fishItem("items/brot.png"), null);
	assert.equal(fishItem(undefined), null);
});

test("a model's normals are smooth across a shallow edge and sharp across a steep one (3D v3)", async () => {
	const { creaseNormals } = await import("../client/props3d.ts");
	// two triangles sharing the edge from (0,0,0) to (0,0,1): one flat on the ground, the other tilted up by `angle`
	const pair = (angle: number) => {
		const c = Math.cos(angle), s = Math.sin(angle);
		const pos = [0, 0, 0, 0, 0, 1, 1, 0, 0, /* second */ 0, 0, 1, 0, 0, 0, -c, s, 0];
		return creaseNormals(pos, [0, 1, 0, s, c, 0]);
	};
	const shallow = pair(30 * Math.PI / 180), steep = pair(80 * Math.PI / 180);
	// the shared corner (0,0,0) of the first face: leaning towards the second face's normal, or straight up
	assert.ok(shallow[0]! > 0.2 && Math.abs(Math.hypot(shallow[0]!, shallow[1]!, shallow[2]!) - 1) < 1e-9, "a shallow edge shares its normal");
	assert.deepEqual(steep.slice(0, 3), [0, 1, 0], "a steep edge keeps the face's own normal");
	// the corner no other face touches keeps its face's normal
	assert.deepEqual(shallow.slice(6, 9), [0, 1, 0]);
});

test("the models' surfaces: a part's colour chooses one, each has its two pictures and its credit (3D v3)", async () => {
	const { existsSync, readFileSync, statSync } = await import("node:fs");
	const t = await import("three");
	const { SURFACES, surfaceLayer } = await import("../client/surfaces3d.ts");
	const { BARK, WOOD, STONE, THATCH, barrel, plantGeometry } = await import("../client/props3d.ts");
	const root = new URL("../", import.meta.url).pathname, credits = readFileSync(`${root}worlds/leuchtfeuer/assets/CREDITS.md`, "utf8");
	for (const s of SURFACES) {
		for (const file of ["color", "arm"]) {
			const path = `${root}public/materials/${s.name}/${file}.jpg`;
			assert.ok(existsSync(path), `${path} is missing`);
			assert.ok(statSync(path).size < 700_000, `${path} is larger than 700 kB`);
		}
		assert.ok(credits.includes(`\`public/materials/${s.name}/\``), `no credit for ${s.name}`);
	}
	const layer = (name: string) => SURFACES.findIndex((s) => s.name === name) + 1;
	assert.equal(surfaceLayer(BARK), layer("bark")); assert.equal(surfaceLayer(WOOD), layer("wood")); assert.equal(surfaceLayer(STONE), layer("rock"));
	for (const c of THATCH) assert.equal(surfaceLayer(c), layer("thatch"));
	assert.equal(surfaceLayer(0x123456), 0, "an unknown colour has no surface");
	assert.equal(surfaceLayer(WOOD, "bark"), layer("bark")); assert.equal(surfaceLayer(WOOD, "none"), 0);
	// a model carries the layer per corner: a barrel is wood somewhere, a palm's trunk bark and never planks
	const layers = (g: import("three").BufferGeometry) => new Set(Array.from(g.getAttribute("surface").array as Float32Array));
	assert.ok(layers(barrel(t)).has(layer("wood")));
	const palm = layers(plantGeometry(t, "palm", 0));
	assert.ok(palm.has(layer("bark")) && !palm.has(layer("wood")));
});

test("leaves: a crown, a palm and a conifer carry leaves near and in the room, none far away (3D v3)", async () => {
	const t = await import("three");
	const { plantGeometry } = await import("../client/props3d.ts");
	const { LEAF_LAYER } = await import("../client/surfaces3d.ts");
	const { atModelLevel } = await import("../client/modelDetail3d.ts");
	const leafCorners = (g: import("three").BufferGeometry) => Array.from(g.getAttribute("surface").array as Float32Array).filter((v) => v === LEAF_LAYER).length;
	for (const model of ["tree", "bush", "berrybush", "conifer", "palm"] as const) {
		const [far, room, near] = (["far", "room", "near"] as const).map((level) => atModelLevel(level, () => plantGeometry(t, model, 1)));
		// a leaf is four triangles
		assert.equal(leafCorners(room!) % 12, 0, model);
		assert.ok(leafCorners(room!) >= 12 * 60, `${model}: ${leafCorners(room!) / 12} leaves in the room`);
		assert.ok(leafCorners(near!) > leafCorners(room!), `${model}: more leaves near`);
		if (model !== "palm") assert.equal(leafCorners(far!), 0, `${model}: plain far away`);
		assert.ok(room!.getAttribute("position").count / 3 < 6000, `${model}: ${room!.getAttribute("position").count / 3} triangles in the room`);
		room!.computeBoundingBox();
		assert.ok(room!.boundingBox!.min.y > -0.2 && room!.boundingBox!.max.y < 2.6, `${model}: stands on the ground`);
	}
});
