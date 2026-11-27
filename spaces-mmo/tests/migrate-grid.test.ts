// The grid migration from scale 1 to scale 2 (scripts/migrate-grid.ts, plan section 5, phase 2 step 7): a world loaded at
// scale 1 with a room grown by two steps, a bent road half built that begins west of a fire, a bed with plants, a field
// being sown and one ripe, a tree, a passenger on board, a thing on the ground and things carried, a motion's zone and an
// NPC's memory is checked, migrated and then loaded by the scale-2 definition; a second run only checks; Handover, Intent
// and Plot entries, an unknown entry type and a run cut off are refused before anything is written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { loadWorld, walkable, type WorldDef } from "../server/engine/world.ts";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { checkGridFormat, GridFormatRefused } from "../server/engine/grid-format.ts";
import { claimedIn, footprint, writeFootprint } from "../server/engine/occupancy.ts";
import { grownGround, grownDecor } from "../server/engine/room-growth.ts";
import { roadCellsEntries, roadEntries } from "../server/engine/commands/road.ts";
import { besideArea } from "../shared/grid.ts";
import { useGridScale } from "../shared/rules.ts";
import { WORLD_LOCK, type BedFields, type CharacterFields, type FieldFields, type ItemFields, type RoomFields, type RoomGrowthFields, type RouteFields, type TreeFields } from "../shared/model.ts";
import { migrateGrid, scaleGrowth } from "../scripts/migrate-grid.ts";

const one = await loadWorld();
process.env.SPACES_MMO_GRID_SCALE = "2";
const two = await loadWorld();
delete process.env.SPACES_MMO_GRID_SCALE;
useGridScale(1);
const defs = { one, two };

async function withSpace(f: (space: PhiSpaces) => Promise<void>): Promise<void> {
	const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
	try { await f(space); } finally { await host.close(ctx); useGridScale(1); }
}
const fieldsOf = async <T>(space: PhiSpaces, type: string, key: Record<string, string>): Promise<T> => (await space.readAll({ type, fields: key }))[0]!.fields as unknown as T;

/** A free `w`×`h` rect of walkable cells in `room`, away from `avoid`, as the store holds it. */
async function freeRect(space: PhiSpaces, w: WorldDef, room: string, size: { w: number; h: number }, avoid: Set<string>): Promise<{ x: number; y: number; w: number; h: number }> {
	const ground = (await fieldsOf<RoomFields>(space, "Room", { roomId: room })).ground, claimed = await claimedIn(space, room);
	for (let y = 1; y + size.h < ground.length - 1; y++) for (let x = 1; x + size.w < ground[0]!.length - 1; x++) {
		let ok = true;
		for (let dy = -1; dy <= size.h && ok; dy++) for (let dx = -1; dx <= size.w && ok; dx++) {
			const k = `${x + dx},${y + dy}`;
			if (claimed.has(k) || avoid.has(k) || !walkable(w, ground, x + dx, y + dy)) ok = false;
		}
		if (ok) { for (let dy = 0; dy < size.h; dy++) for (let dx = 0; dx < size.w; dx++) avoid.add(`${x + dx},${y + dy}`); return { x, y, ...size }; }
	}
	throw new Error(`no free ${size.w}×${size.h} in ${room}`);
}

const FIRE = one.beacons.find((b) => b.beaconId === "feuer-bucht")!, ROOM = FIRE.room, EXIT = one.exits.find((e) => e.room === ROOM && e.destination === "klippenpfad")!;
const GROWN = "klippenpfad";

/** The world at scale 1 (footprints, marker complete) with the things the migration has rules for. */
async function scaleOne(space: PhiSpaces): Promise<void> {
	await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER); // the space process writes it
	await loadIntoSpace(space, one);
	// a room grown by two steps at its edges (nothing stands there to be moved), as growth.ts writes it
	const room = await space.take({ type: "Room", fields: { roomId: GROWN } }, NO_WAIT);
	const r = room!.fields as unknown as RoomFields, W = r.ground[0]!.length, H = r.ground.length;
	const g: RoomGrowthFields = { roomId: GROWN, east: 4, south: 4, baseWidth: W, baseHeight: H, steps: [
		{ axis: "x", at: W, size: 4, fill: r.ground.map((_, y) => (y % 2 ? "," : ".")) },
		{ axis: "y", at: H, size: 4, fill: Array.from({ length: W + 4 }, (_, x) => (x % 3 ? "," : ".")) },
	] };
	const def = one.rooms.find((x) => x.roomId === GROWN)!;
	await space.write({ type: "Room", fields: { ...r, ground: grownGround(def.ground, g, ","), ...(def.decor ? { decor: grownDecor(def.decor, g) } : {}) } as never }, null, FOREVER);
	await space.write({ type: "RoomGrowth", fields: g as never }, null, FOREVER);
	// a road from beside the fire (its west side) bent to the exit, and on from the arrival: built a third
	const cells = [{ room: ROOM, x: FIRE.x - 1, y: FIRE.y }, { room: ROOM, x: FIRE.x - 2, y: FIRE.y }, { room: ROOM, x: FIRE.x - 2, y: FIRE.y - 1 },
		{ room: GROWN, x: EXIT.arrive.x, y: EXIT.arrive.y }, { room: GROWN, x: EXIT.arrive.x + 1, y: EXIT.arrive.y }];
	const route: RouteFields = { routeId: "road-test", pair: [ROOM, GROWN].sort().join("|"), island: one.rooms.find((x) => x.roomId === ROOM)!.island!, rooms: [ROOM, GROWN], names: ["Graue Bucht", "Klippenpfad"], cells,
		state: "build", planner: "c1", plannerName: "Ada", accountId: "a1", voters: [], yes: [], no: [], voteUntil: 0, needs: [{ proto: "stein", name: "Stein", count: 2, have: 1 }], work: 1, workNeed: 3, by: { a1: 1 }, untilWorldMs: 9e12, at: 1, points: 1 };
	for (const e of [...roadEntries(route), ...roadCellsEntries(route)]) await space.write(e as never, null, FOREVER);
	const avoid = new Set(cells.map((c) => `${c.x},${c.y}`));
	// a bed with two plants, a field being sown, one ripe, a tree: each with its footprint
	const bed = await freeRect(space, one, GROWN, one.garden!.bed, avoid), seed = await freeRect(space, one, GROWN, one.fields!, avoid), ripe = await freeRect(space, one, GROWN, one.fields!, avoid), tree = await freeRect(space, one, GROWN, { w: 1, h: 1 }, avoid);
	const owner = { owner: "c1", ownerName: "Ada", accountId: "a1", beaconId: FIRE.beaconId, points: 1 };
	const b: BedFields = { bedId: "bed-1", room: GROWN, ...bed, ...owner, sponsors: [], plants: [{ x: bed.x, y: bed.y, sort: "kohl", stage: 1, dueWorldMs: 5 }, { x: bed.x + 1, y: bed.y + 1, sort: "kohl", stage: 0, dueWorldMs: 6 }], wateredWorldMs: 0, weedy: false, dueWorldMs: 5, untilWorldMs: 9e12, at: 1 };
	const field = (fieldId: string, r: typeof seed, stage: FieldFields["stage"], seedNeed: number, workNeed: number): FieldFields => ({ fieldId, room: GROWN, ...r, ...owner, stage, crop: "roggen", seeds: 1, seedNeed, work: 1, workNeed, yields: [], soil: 1, by: {}, human: 0, other: 0, lastGroup: null, tired: 0, lastHarvestWorldMs: 0, dueWorldMs: 9, untilWorldMs: 9e12, at: 1 });
	const n = one.fields!.w * one.fields!.h;
	const t: TreeFields = { treeId: "tree-1", sort: "apfel", room: GROWN, ...tree, ...owner, stage: 1, dueWorldMs: 9, at: 1 };
	const txn = (await space.createTransaction(30_000)).id;
	for (const [type, f, id] of [["Bed", b, b.bedId], ["Field", field("field-1", seed, "saat", Math.ceil(n / one.fields!.seedPerCells), Math.ceil(n / one.fields!.sowPerCells)), "field-1"], ["Field", field("field-2", ripe, "reif", 0, Math.ceil(n / one.fields!.harvestPerCells)), "field-2"], ["Tree", t, t.treeId]] as const) {
		await space.write({ type, fields: f as never }, txn, FOREVER);
		await writeFootprint(space, txn, footprint(GROWN, id, f));
	}
	await space.commit(txn);
	// a passenger on board, landing at a spot; a thing on the ground; a motion's zone; an NPC's memory
	await space.write({ type: "Character", fields: { charId: "c1", accountId: "a1", name: "Ada", room: ROOM, x: 5, y: 6, skin: 0, guest: false, aboard: { to: GROWN, island: route.island, spot: { x: 3, y: 4 }, arriveWorldMs: 77 } } satisfies CharacterFields as never }, null, FOREVER);
	await space.write({ type: "Motion", fields: { motionId: "m1", room: ROOM, settlementId: "s1", settlementName: "S", by: "c1", byName: "Ada", kind: "gruen", text: "", endsWorldMs: 9e12, zone: { x: 2, y: 3, w: 4, h: 2 } } as never }, null, FOREVER);
	await space.write({ type: "NpcMemory", fields: { npcId: "npc-x", text: "bei 4 5 lag ein Stein" } as never }, null, FOREVER);
}

test("a store at scale 1: checked, migrated, loaded at scale 2; a second run only checks", { timeout: 120_000 }, async () => {
	await withSpace(async (space) => {
		await scaleOne(space);
		await assert.rejects(checkGridFormat(space, two), (e: Error) => e instanceof GridFormatRefused && /migrate the grid first/.test(e.message));
		const old = new Map((await space.readAll({})).map((e) => [e.id, e] as const));
		const items = (await space.readAll({ type: "Item" })).map((e) => e.fields as unknown as ItemFields);
		const onGround = items.find((i) => i.x >= 0 && one.rooms.some((r) => r.roomId === i.location))!, carried = items.find((i) => i.x === -1)!;
		assert.ok(onGround && carried, "the world has a thing on the ground and one carried");
		const before = (await space.stats()).entries;

		const check = await migrateGrid(space, { check: true, defs });
		assert.equal(check.outcome, "checked");
		assert.deepEqual(check.report, []);
		assert.deepEqual(check.notes, []);
		assert.equal((await space.stats()).entries, before, "the check writes nothing");

		const done = await migrateGrid(space, { defs });
		assert.equal(done.outcome, "migrated", done.report.join("\n"));
		const [m] = await space.readAll({ type: "GridFormat" });
		assert.deepEqual(m?.fields, { worldId: one.id, gridScale: 2, derivedFrom: 1, occupancy: "footprints", state: "complete" });
		await checkGridFormat(space, two);

		// cell points once, areas with their size, the sentinel kept
		const ch = await fieldsOf<CharacterFields>(space, "Character", { charId: "c1" });
		assert.deepEqual([ch.x, ch.y, ch.aboard?.spot, ch.aboard?.arriveWorldMs], [10, 12, { x: 6, y: 8 }, 77]);
		assert.deepEqual(await fieldsOf<ItemFields>(space, "Item", { itemId: onGround.itemId }).then((i) => [i.x, i.y]), [onGround.x * 2, onGround.y * 2]);
		assert.deepEqual(await fieldsOf<ItemFields>(space, "Item", { itemId: carried.itemId }).then((i) => [i.x, i.y]), [-1, -1]);
		const fire = await fieldsOf<{ x: number; y: number; w: number; h: number }>(space, "Beacon", { beaconId: FIRE.beaconId });
		assert.deepEqual(fire, { ...fire, x: FIRE.x * 2, y: FIRE.y * 2, w: 2, h: 2 });
		const exit = await fieldsOf<{ x: number; y: number; w: number; h: number; arrive: { x: number; y: number } }>(space, "Exit", { exitId: EXIT.exitId });
		assert.deepEqual([exit.x, exit.y, exit.w, exit.h, exit.arrive], [EXIT.x * 2, EXIT.y * 2, 2, 2, { x: EXIT.arrive.x * 2, y: EXIT.arrive.y * 2 }]);
		const t = await fieldsOf<TreeFields>(space, "Tree", { treeId: "tree-1" });
		assert.deepEqual([t.w, t.h], [2, 2]);
		const b = await fieldsOf<BedFields>(space, "Bed", { bedId: "bed-1" });
		const oldBed = [...old.values()].find((e) => e.type === "Bed")!.fields as unknown as BedFields;
		assert.deepEqual(b.plants.map((p) => [p.x, p.y, p.stage]), oldBed.plants.map((p) => [p.x * 2, p.y * 2, p.stage]));
		assert.deepEqual([b.x, b.y, b.w, b.h], [oldBed.x * 2, oldBed.y * 2, oldBed.w * 2, oldBed.h * 2]);
		for (const id of ["field-1", "field-2"]) {
			const f = await fieldsOf<FieldFields>(space, "Field", { fieldId: id }), was = [...old.values()].find((e) => e.fields.fieldId === id)!.fields as unknown as FieldFields;
			assert.deepEqual([f.w, f.h, f.seedNeed, f.workNeed, f.work], [was.w * 2, was.h * 2, was.seedNeed, was.workNeed, was.work]);
		}
		const zone = (await fieldsOf<{ zone: unknown }>(space, "Motion", { motionId: "m1" })).zone;
		assert.deepEqual(zone, { x: 4, y: 6, w: 8, h: 4 });
		assert.equal((await space.readAll({ type: "NpcMemory" })).length, 0);

		// the grown room: its history doubled, its terrain the scale-2 definition grown by it
		const g = await fieldsOf<RoomGrowthFields>(space, "RoomGrowth", { roomId: GROWN });
		const def2 = two.rooms.find((r) => r.roomId === GROWN)!;
		assert.deepEqual([g.east, g.south, g.baseWidth, g.baseHeight, g.steps!.map((s) => [s.axis, s.at, s.size])], [8, 8, def2.ground[0]!.length, def2.ground.length, [["x", def2.ground[0]!.length, 8], ["y", def2.ground.length, 8]]]);
		assert.deepEqual(g.steps![0]!.fill.slice(0, 4), [".", ".", ",", ","], "each element of a fill twice, in order");
		const room = await fieldsOf<RoomFields>(space, "Room", { roomId: GROWN });
		assert.deepEqual(room.ground, grownGround(def2.ground, g, ","));

		// the road: doubled, the cells between inserted, the end beside the fire bridged to its area, paved by the work
		const r = await fieldsOf<RouteFields>(space, "Route", { routeId: "road-test" });
		const a = r.cells.filter((c) => c.room === ROOM), bb = r.cells.filter((c) => c.room === GROWN);
		assert.deepEqual(a.map((c) => [c.x, c.y]), [[FIRE.x * 2 - 1, FIRE.y * 2], [FIRE.x * 2 - 2, FIRE.y * 2], [FIRE.x * 2 - 3, FIRE.y * 2], [FIRE.x * 2 - 4, FIRE.y * 2], [FIRE.x * 2 - 4, FIRE.y * 2 - 1], [FIRE.x * 2 - 4, FIRE.y * 2 - 2]]);
		assert.ok(besideArea(fire).some((p) => p.x === a[0]!.x && p.y === a[0]!.y), "the road meets the fire's area");
		assert.deepEqual(bb.map((c) => [c.x, c.y]), [[EXIT.arrive.x * 2, EXIT.arrive.y * 2], [EXIT.arrive.x * 2 + 1, EXIT.arrive.y * 2], [EXIT.arrive.x * 2 + 2, EXIT.arrive.y * 2]]);
		assert.deepEqual([r.work, r.workNeed, r.needs, r.by], [1, 3, [{ proto: "stein", name: "Stein", count: 2, have: 1 }], { a1: 1 }]);
		const parts = (await space.readAll({ type: "Road", fields: { routeId: "road-test" } })).map((e) => e.fields as { room: string; cells: unknown[]; paved: number });
		assert.deepEqual(parts.map((p) => [p.room, p.cells.length]).sort(), [[GROWN, 3], [ROOM, 6]].sort());
		assert.equal(parts.reduce((n, p) => n + p.paved, 0), 3, "paved: a third of the nine cells, as the engine computes it");
		assert.deepEqual((await space.readAll({ type: "RoadCells", fields: { routeId: "road-test", room: ROOM } }))[0]!.fields.cells, a.map((c) => ({ x: c.x, y: c.y })));

		// the scale-2 definition loads on it and keeps what the store has
		const rooms = JSON.stringify((await space.readAll({ type: "Room" })).map((e) => e.fields).sort((x, y) => String(x.roomId).localeCompare(String(y.roomId))));
		useGridScale(2);
		await loadIntoSpace(space, two);
		assert.equal(JSON.stringify((await space.readAll({ type: "Room" })).map((e) => e.fields).sort((x, y) => String(x.roomId).localeCompare(String(y.roomId)))), rooms);
		useGridScale(1);

		const again = await migrateGrid(space, { defs });
		assert.equal(again.outcome, "already");
		assert.deepEqual(again.report, []);
		assert.deepEqual(scaleGrowth({ roomId: "x", east: 1, south: 0, steps: [{ axis: "x", at: 3, size: 1, fill: ["a", "b"] }] }).steps![0]!.fill, ["a", "a", "b", "b"]);
	});
});

test("refused before anything is written: a handover, a command not run, a plot, an unknown type, a migration cut off, a store without footprints", { timeout: 120_000 }, async () => {
	await withSpace(async (space) => {
		await scaleOne(space);
		const refuse = async (draft: { type: string; fields: Record<string, unknown> }, why: RegExp) => {
			const e = await space.write(draft as never, null, FOREVER);
			const n = (await space.stats()).entries;
			const r = await migrateGrid(space, { defs });
			assert.equal(r.outcome, "refused");
			assert.match(r.report.join("\n"), why);
			assert.equal((await space.stats()).entries, n, "a refusal writes nothing");
			await space.take({ id: e.id }, NO_WAIT);
		};
		await refuse({ type: "Handover", fields: { handoverId: "h1", character: { name: "Bo", x: 1, y: 1 } } }, /Handover .*\(Bo\): a region handover not completed/);
		await refuse({ type: "Intent", fields: { intentId: "i1", charId: "c1", line: "geh 4 5", at: 1 } }, /Intent .*\(c1: geh 4 5\): a command line not run yet/);
		await refuse({ type: "Plot", fields: { room: ROOM, x: 1, y: 1, of: "b1" } }, /Plot .*footprint migration first/);
		await refuse({ type: "Gadget", fields: { x: 1 } }, /Gadget .*without a grid class/);
		await refuse({ type: "Item", fields: { itemId: "lost", location: "nowhere", x: 3, y: 3 } }, /Item lost: at 3,3 of nowhere, which is no room of this store/);
		// a run cut off after its marker: restore the backup
		const m = await space.take({ type: "GridFormat" }, NO_WAIT);
		await space.write({ type: "GridFormat", fields: { ...m!.fields, gridScale: 2, derivedFrom: 1, state: "running" } }, null, FOREVER);
		assert.match((await migrateGrid(space, { defs })).report.join("\n"), /was cut off.*restore the store from its backup/);
		await assert.rejects(checkGridFormat(space, two), /has not finished/);
		await space.take({ type: "GridFormat" }, NO_WAIT);
		assert.match((await migrateGrid(space, { defs })).report.join("\n"), /run the footprint migration first/);
	});
});
