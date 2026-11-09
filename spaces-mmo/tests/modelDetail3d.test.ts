import assert from "node:assert/strict";
import test from "node:test";
import * as t from "three";
import { buildingModel, linerGeometry, sceneryModel } from "../client/buildings3d.ts";
import { buildingGeometry, cropGeometry, fenceGeometry, fieldCropGeometry, fireGeometry, keeperGeometry, plantGeometry, prepareModelDetails, ruinGeometry, signGeometry, siteGeometry, type CropModel, type FieldModel, type Geo, type PlantModel } from "../client/props3d.ts";
import { atModelLevel, detailLevelAt, modelLevel, modelPrimitive, updateModelDetails, type ModelLevel } from "../client/modelDetail3d.ts";

const catalogue = new Map<string, () => Geo | null>();
for (const model of ["tree", "conifer", "bush", "berrybush", "flower", "herb", "grass", "fern"] as PlantModel[]) catalogue.set(`plant:${model}`, () => plantGeometry(t, model, 0));
for (const model of ["flower", "rose", "mist", "cabbage", "carrot", "hops"] as CropModel[]) for (let stage = 0; stage < 4; stage++) catalogue.set(`bed:${model}:${stage}`, () => cropGeometry(t, model, stage, 0xc08c6a));
for (const model of ["grain", "tuber", "beet", "flax"] as FieldModel[]) for (const grown of [0.4, 1]) for (const limp of [false, true]) catalogue.set(`field:${model}:${grown}:${limp}`, () => fieldCropGeometry(t, model, 2, 2, grown, 0xc9b968, limp));
for (const plan of ["huette", "regentonne", "vogelscheuche", "windmuehle", "backhaus", "huehnerstall", "bienenstock", "webstuhl", "steg"]) catalogue.set(plan, () => buildingGeometry(t, plan, 2, 2, 0x9a7a4a, 0));
for (const plan of ["lagerhaus", "steinbruch", "lehmgrube", "ziegelei", "kapelle", "park", "rathaus", "werkstatt", "raeucherei", "metzgerei", "gerberei", "kaufhaus", "kontor", "brauerei", "glashuette", "werft", "gewaechshaus", "leuchtturm", "bahnhof", "signalfeuer"]) catalogue.set(plan, () => buildingModel(t, plan, 2, 2, 0));
for (const model of ["boot", "faesser", "kisten", "stand", "becken", "rumpf", "felsen", "mauer", "turm", "meiler"]) catalogue.set(`scenery:${model}`, () => sceneryModel(t, model, 2, 2, 0));
for (const herd of ["schaf", "ziege", "rind", "schwein", "ente", "gans"]) catalogue.set(`pen:${herd}`, () => buildingGeometry(t, "gehege", 2, 2, 0x9a7a4a, 0, herd));
for (const kind of ["hund", "katze"]) catalogue.set(kind, () => keeperGeometry(t, kind, 0));
for (const progress of [0, 0.6, 1]) catalogue.set(`site:${progress}`, () => siteGeometry(t, "huette", 2, 2, 0x9a7a4a, progress));
catalogue.set("ruin", () => ruinGeometry(t, 2, 2, 0)); catalogue.set("sign", () => signGeometry(t)); catalogue.set("fire", () => fireGeometry(t)); catalogue.set("fence", () => fenceGeometry(t, 2, 2)); catalogue.set("liner", () => linerGeometry(t, 8));

function valid(g: Geo, name: string) {
	for (const attr of ["position", "normal", "color", "glow"]) {
		const values = g.getAttribute(attr);
		assert.ok(values?.count, `${name}: missing ${attr}`);
		for (const value of values.array) assert.ok(Number.isFinite(value), `${name}: invalid ${attr}`);
	}
	g.computeBoundingBox(); assert.ok(g.boundingBox && !g.boundingBox.isEmpty(), name);
	assert.equal(g.userData.shared, true, name);
}

test("every catalogue plant, crop, building and scenery has shared finite far/room/near variants", () => {
	assert.ok(catalogue.size >= 90);
	for (const [name, build] of catalogue) {
		const room = build(); assert.ok(room, `${name} has no model`);
		assert.equal(room, build(), `${name} is not cached`);
		const far = room.userData.modelVariant("far") as Geo, near = room.userData.modelVariant("near") as Geo;
		for (const [level, geometry] of [["far", far], ["room", room], ["near", near]] as const) valid(geometry, `${name}:${level}`);
		assert.notEqual(room, near, name); assert.notEqual(room, far, name);
		assert.ok(far.getAttribute("position").count <= room.getAttribute("position").count, `${name}: far is more costly than room`);
		assert.ok(near.getAttribute("position").count > far.getAttribute("position").count, `${name}: near adds no detail`);
		assert.equal(near.userData.modelVariant("room"), room, `${name}: variants are not shared`);
	}
	assert.equal(modelLevel(), "room");
});

test("all wild animal variants are distinct, finite and shared", async () => {
	const { wildGeometry } = await import("../client/props3d.ts");
	for (const kind of ["hase", "reh", "fuchs", "maus", "moewe"]) for (let variant = 0; variant < 3; variant++) {
		const room = wildGeometry(t, kind, variant), far = room.userData.modelVariant("far"), near = room.userData.modelVariant("near");
		valid(far, kind); valid(room, kind); valid(near, kind);
		assert.ok(near.getAttribute("position").count > far.getAttribute("position").count, kind);
	}
});

test("detail scopes restore after nested builders and failures", () => {
	assert.equal(modelLevel(), "room");
	assert.throws(() => atModelLevel("near", () => atModelLevel("far", () => { throw new Error("builder failed"); })));
	assert.equal(modelLevel(), "room");
});

test("box bevels and capsule variants preserve dimensions", () => {
	for (const level of ["far", "room", "near"] as ModelLevel[]) atModelLevel(level, () => {
		const box = modelPrimitive(t, new t.BoxGeometry(2, 3, 4)); box.computeBoundingBox();
		assert.ok(box.boundingBox!.getSize(new t.Vector3()).distanceTo(new t.Vector3(2, 3, 4)) < 0.00001);
		const capsule = modelPrimitive(t, new t.CapsuleGeometry(0.052, 0.27, 4, 8)); capsule.computeBoundingBox();
		assert.ok(Math.abs(capsule.boundingBox!.getSize(new t.Vector3()).y - 0.374) < 0.00001);
		box.dispose(); capsule.dispose();
	});
});

test("LOD has distance and zoom hysteresis and caps close-up meshes and instanced work", () => {
	assert.equal(detailLevelAt(0.6, 10, "far"), "far"); assert.equal(detailLevelAt(0.6, 10, "room"), "room");
	assert.equal(detailLevelAt(3, 17, "near"), "near"); assert.equal(detailLevelAt(3, 17, "room"), "room");
	assert.equal(detailLevelAt(1, 1, "near"), "room");
	const scene = new t.Scene(), camera = new t.PerspectiveCamera(); camera.position.set(0, 1, 10);
	for (let i = 0; i < 3; i++) { const mesh = new t.Mesh(new t.BoxGeometry(1, 1, 1), new t.MeshStandardMaterial()); mesh.position.x = i; scene.add(mesh); }
	prepareModelDetails(t, scene); updateModelDetails(t, scene, camera, 3, 1);
	assert.equal(scene.children.filter(o => o.userData.modelLevel === "near").length, 1);
	updateModelDetails(t, scene, camera, 0.2); assert.ok(scene.children.every(o => o.userData.modelLevel === "far"));
	const batch = new t.InstancedMesh(plantGeometry(t, "tree", 0), new t.MeshStandardMaterial(), 1000); scene.clear(); scene.add(batch); batch.computeBoundingSphere();
	updateModelDetails(t, scene, camera, 3); assert.equal(batch.userData.modelLevel, "room");
	const fern = new t.InstancedMesh(plantGeometry(t, "fern", 0), new t.MeshStandardMaterial(), 128); scene.clear(); scene.add(fern); fern.computeBoundingSphere();
	updateModelDetails(t, scene, camera, 3); assert.equal(fern.userData.modelLevel, "room", "actual leaflet triangles must fit the budget, not just the base-model estimate");
});

test("figures retain their animated parts and only reveal fine face and clothing details close up", async () => {
	const previous = Object.getOwnPropertyDescriptor(globalThis, "document");
	Object.defineProperty(globalThis, "document", { configurable: true, value: { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) } });
	try {
		const { makeFigure, animateFigure } = await import("../client/figure3d.ts");
		const figure = makeFigure(t, { id: "catalogue", skin: 0, own: true, ai: false }), scene = new t.Scene(), camera = new t.PerspectiveCamera(); scene.add(figure.group); camera.position.set(0, 1, 5);
		const details: t.Object3D[] = []; figure.group.traverse(o => { if (o.userData.detailOnly) details.push(o); });
		assert.ok(details.length >= 6); updateModelDetails(t, scene, camera, 3); assert.ok(details.every(o => o.visible));
		updateModelDetails(t, scene, camera, 1); assert.ok(details.every(o => !o.visible));
		animateFigure(figure, 0.1, 0, 0.016, 1); assert.notEqual(figure.legL.rotation.x, 0);
	} finally { if (previous) Object.defineProperty(globalThis, "document", previous); else Reflect.deleteProperty(globalThis, "document"); }
});
