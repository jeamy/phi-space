// The world definition at grid scale 2 (shared/world-scale.ts; plan section 2.4): derived from the scale-1 one, with the
// same geometry on twice the cells. Every room's ground is its scale-1 ground with each cell as 2×2 of its tile, every
// decor symbol once at (2x, 2y); spawns, arrivals and NPCs stand on the cell their scale-1 cell becomes and stay
// walkable; exits and fires are 2×2 areas in their room; footprints, the definition's lengths and areas are scaled, so a
// field yields as much per physical area and a road costs as much per physical length; loadWorld at scale 2 sets the rule
// values to scale 2.
import { test } from "node:test";
import assert from "node:assert/strict";
import { scaleDecor, scaleGround, scaleWorld } from "../shared/world-scale.ts";
import type { WorldDef } from "../shared/world-def.ts";
import { walkable } from "../server/engine/world.ts";
import { harvestOf } from "../server/engine/commands/field.ts";

const { world: one } = (await import("../worlds/leuchtfeuer/world.ts")) as { world: WorldDef };
const two = scaleWorld(one, 2);

test("ground and decor: each cell 2×2 of its tile, each decor symbol once at its converted cell", () => {
	assert.deepEqual(scaleGround(["ab", "cd"], 2), ["aabb", "aabb", "ccdd", "ccdd"]);
	assert.deepEqual(scaleDecor(["x ", " y"], 2), ["x   ", "    ", "  y ", "    "]);
	for (const [r1, r2] of one.rooms.map((r, i) => [r, two.rooms[i]!] as const)) {
		assert.equal(r2.roomId, r1.roomId);
		assert.deepEqual([r2.ground[0]!.length, r2.ground.length], [r1.ground[0]!.length * 2, r1.ground.length * 2], r1.roomId);
		for (let y = 0; y < r2.ground.length; y++) for (let x = 0; x < r2.ground[0]!.length; x++) assert.equal(r2.ground[y]![x], r1.ground[y >> 1]![x >> 1], `${r1.roomId} ${x},${y}`);
		if (!r1.decor) continue;
		const symbols = (d: string[]) => d.join("").replaceAll(" ", "").length;
		assert.equal(symbols(r2.decor!), symbols(r1.decor), `${r1.roomId}: every decor symbol once`);
		for (let y = 0; y < r1.decor.length; y++) for (let x = 0; x < r1.decor[0]!.length; x++) assert.equal(r2.decor![2 * y]![2 * x], r1.decor[y]![x]);
	}
});

test("points land on their converted cell and stay walkable; exits and fires are 2×2 areas inside their room", () => {
	const room = (w: WorldDef, id: string) => w.rooms.find((r) => r.roomId === id)!;
	for (const r of two.rooms) { assert.deepEqual(r.spawn, { x: 2 * room(one, r.roomId).spawn.x, y: 2 * room(one, r.roomId).spawn.y }); assert.ok(walkable(two, r.ground, r.spawn.x, r.spawn.y), `${r.roomId} spawn`); }
	for (const [e1, e2] of one.exits.map((e, i) => [e, two.exits[i]!] as const)) {
		assert.deepEqual([e2.x, e2.y, e2.w, e2.h, e2.arrive.x, e2.arrive.y], [2 * e1.x, 2 * e1.y, 2, 2, 2 * e1.arrive.x, 2 * e1.arrive.y], e1.exitId);
		const here = room(two, e2.room), there = room(two, e2.destination);
		if (here && there) {
			assert.ok(e2.x + 2 <= here.ground[0]!.length && e2.y + 2 <= here.ground.length, `${e1.exitId} inside its room`);
			assert.equal(walkable(two, there.ground, e2.arrive.x, e2.arrive.y), walkable(one, room(one, e1.destination).ground, e1.arrive.x, e1.arrive.y), `${e1.exitId} arrival`);
		}
	}
	for (const [b1, b2] of one.beacons.map((b, i) => [b, two.beacons[i]!] as const)) assert.deepEqual([b2.x, b2.y, b2.w, b2.h], [2 * b1.x, 2 * b1.y, 2, 2]);
	for (const [n1, n2] of one.npcs.map((n, i) => [n, two.npcs[i]!] as const)) assert.deepEqual([n2.x, n2.y], [2 * n1.x, 2 * n1.y]);
	for (const [o1, o2] of one.objects.map((o, i) => [o, two.objects[i]!] as const)) assert.deepEqual([o2.x, o2.y], [2 * o1.x, 2 * o1.y]);
	for (const [s1, s2] of (one.scenery ?? []).map((s, i) => [s, two.scenery![i]!] as const)) assert.deepEqual([s2.x, s2.y, s2.w, s2.h], [2 * s1.x, 2 * s1.y, 2 * s1.w, 2 * s1.h]);
});

test("footprints, interiors and the definition's lengths and areas: the same physical sizes, yields and costs", () => {
	for (const [p1, p2] of one.building!.plans.map((p, i) => [p, two.building!.plans[i]!] as const)) {
		assert.deepEqual([p2.w, p2.h], [2 * p1.w, 2 * p1.h], p1.key);
		if (!p1.interior) continue;
		const i1 = p1.interior, i2 = p2.interior!;
		assert.deepEqual([i2.ground[0]!.length, i2.ground.length, i2.spawn, i2.door], [2 * i1.ground[0]!.length, 2 * i1.ground.length, { x: 2 * i1.spawn.x, y: 2 * i1.spawn.y }, { x: 2 * i1.door.x, y: 2 * i1.door.y }], p1.key);
		assert.deepEqual(i2.furniture.map((f) => [f.x, f.y]), i1.furniture.map((f) => [2 * f.x, 2 * f.y]));
	}
	assert.deepEqual([two.garden!.bed.w, two.garden!.bed.h, two.garden!.commons.w, two.garden!.greenhouse?.reach], [2 * one.garden!.bed.w, 2 * one.garden!.bed.h, 2 * one.garden!.commons.w, one.garden!.greenhouse && 2 * one.garden!.greenhouse.reach]);
	assert.deepEqual([two.growth!.strip, two.growth!.maxW, two.growth!.maxH, two.growth!.fullShare], [2 * one.growth!.strip, 2 * one.growth!.maxW, 2 * one.growth!.maxH, one.growth!.fullShare]);
	assert.deepEqual([two.wild!.scareReach, two.wild!.scarecrowReach, two.townhall!.zoneRadius], [2 * one.wild!.scareReach, 2 * one.wild!.scarecrowReach, 2 * one.townhall!.zoneRadius]);
	assert.deepEqual([two.cart!.route!.stonePer, two.cart!.route!.workPer], [2 * one.cart!.route!.stonePer, 2 * one.cart!.route!.workPer]);
	// a field of the same physical area: the same seeds, work and harvest
	const f1 = one.fields!, f2 = two.fields!, cells1 = f1.w * f1.h, cells2 = f2.w * f2.h;
	assert.equal(cells2, 4 * cells1);
	assert.deepEqual([cells2 / f2.seedPerCells, cells2 / f2.sowPerCells, cells2 / f2.harvestPerCells], [cells1 / f1.seedPerCells, cells1 / f1.sowPerCells, cells1 / f1.harvestPerCells]);
	for (const [c1, c2] of f1.crops.map((c, i) => [c, f2.crops[i]!] as const)) assert.deepEqual(harvestOf(c2, cells2, 1), harvestOf(c1, cells1, 1), c1.key);
	// the rest is the same definition
	assert.deepEqual([two.version, two.id, two.prototypes, two.help, two.tiles], [one.version, one.id, one.prototypes, one.help, one.tiles]);
	assert.throws(() => scaleWorld(two, 2), /gridScale 2, not 1/);
});
