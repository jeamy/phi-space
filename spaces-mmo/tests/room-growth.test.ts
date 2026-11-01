import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER, PhiSpaces, openOwnMemoryHost, type SpaceLike } from "phi-spaces";
import { BACKGROUND_CONTEXT } from "phi-spaces/context";
import { fieldsOf, WORLD_LOCK, type RoomFields, type RoomGrowthFields, type ExitFields, type CharacterFields } from "../server/model.ts";
import { growthTick } from "../server/engine/commands/growth.ts";
import { grownGround, grownDecor, grownPoint, pinTerrain, spatialWorld } from "../server/engine/room-growth.ts";
import { loadWorld, walkable, type WorldDef } from "../server/engine/world.ts";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { arrive, type HandoverFields } from "../server/engine/handover.ts";
import { execute } from "../server/engine/commands.ts";
import { traverse } from "../server/engine/commands/default.ts";

const definition = await loadWorld();
const coast = (): RoomFields => ({ roomId: "r", name: "Coast", desc: "", ground: Array.from({ length: 8 }, (_, y) => y === 4 ? ":".repeat(12) : ",".repeat(9) + ".~~"), decor: Array.from({ length: 8 }, () => " ".repeat(9) + "T  "), spawn: { x: 2, y: 4 }, map: { x: 3, y: 2 }, island: "island" });
const exit: ExitFields = { exitId: "out", name: "door", desc: "", aliases: [], location: "r", destination: "q", x: 11, y: 4, arrive: { x: 1, y: 4 }, locks: "" };
const back: ExitFields = { ...exit, exitId: "back", location: "q", destination: "r", x: 0, arrive: { x: 10, y: 4 } };
const actor = (charId: string, x = 9, y = 3): CharacterFields => ({ charId, accountId: charId, name: charId, room: "r", x, y, skin: 0, guest: false });
const write = (s: SpaceLike, type: string, fields: object, types?: string[]) => s.write({ type, ...(types ? { types } : {}), fields: fields as never }, null, FOREVER);
const get = async <T>(s: SpaceLike, type: string, fields: Record<string, string> = {}) => fieldsOf<T>((await s.readAll({ type, fields }))[0]!);
const world = (): WorldDef => ({ ...definition, rooms: [{ ...coast(), spawn: { x: 2, y: 4 } }, { ...coast(), roomId: "q", spawn: { x: 2, y: 4 } }], exits: [exit, back].map(({ location, ...e }) => ({ ...e, room: location })), npcs: [], objects: [], scenery: [], beacons: [], growth: { strip: 2, maxW: 14, maxH: 8, fullShare: .01, tile: "," } });
async function fixture() {
	const host = openOwnMemoryHost(), s = new PhiSpaces(host, BACKGROUND_CONTEXT), w = world();
	await write(s, WORLD_LOCK.type, WORLD_LOCK.fields);
	await loadIntoSpace(s, w);
	await write(s, "Plot", { room: "r", x: 9, y: 2, of: "house" });
	return { host, s, w };
}

test("growth replay keeps legacy appends, interleaved insertions, decor and coordinate revisions", () => {
	const g: RoomGrowthFields = { roomId: "r", east: 3, south: 1, steps: [
		{ axis: "x", at: 1, size: 2, fill: [",", ":", ","] },
		{ axis: "y", at: 1, size: 1, fill: [",", ",", ",", ",", ","] },
	] };
	// One legacy eastern column precedes both recorded steps.
	assert.deepEqual(grownGround(["ab", "cd", "ef"], g, ","), ["a,,b,", ",,,,,", "c::d,", "e,,f,"]);
	assert.deepEqual(grownDecor(["ab", "cd", "ef"], g), ["a  b ", "     ", "c  d ", "e  f "]);
	assert.deepEqual(grownPoint({ x: 1, y: 1 }, g), { x: 3, y: 2 });
	assert.deepEqual(grownPoint({ x: 3, y: 1 }, g, 1), { x: 3, y: 2 });
	assert.throws(() => grownGround(["abc"], { ...g, baseWidth: 2, baseHeight: 3 }, ","), /base dimensions/);
});

test("coastal growth moves absolute positions and reciprocal exits atomically, persists on reload and permits movement", async () => {
	const { host, s, w } = await fixture();
	try {
		w.rooms[0]!.spawn = { x: 9, y: 4 };
		await loadIntoSpace(s, w, { replace: true });
		await write(s, "Character", actor("moved"));
		await write(s, "Spot", { room: "r", x: 9, y: 3, charId: "moved", name: "Moved" });
		await write(s, "Character", actor("walker", 8, 3));
		await write(s, "Coin", { itemId: "coin", location: "r", x: 9, y: 5, expiresWorldMs: 123 }, ["Item", "Object"]);
		await write(s, "Coin", { itemId: "carried", location: "moved", x: -1, y: -1 }, ["Item", "Object"]);
		await write(s, "Beacon", { beaconId: "fire", room: "r", x: 9, y: 6 });
		for (const type of ["Building", "Site", "Scenery", "Ruin", "Field", "MillLoad", "SiteOrder", "Zone"]) await write(s, type, { room: "r", x: 9, y: 2, w: 1, h: 1, marker: type });
		await write(s, "Bed", { room: "r", x: 9, y: 1, w: 1, h: 1, plants: [{ x: 0, y: 0 }] });
		await write(s, "Animal", { room: "r", x: 9, y: 0 });
		await write(s, "Motion", { room: "r", zone: { x: 9, y: 0, w: 1, h: 1 } });
		assert.equal(await growthTick(s, w, 60_000), 1);
		const r = await get<RoomFields>(s, "Room", { roomId: "r" }), g = await get<RoomGrowthFields>(s, "RoomGrowth");
		assert.equal(g.steps![0]!.at, 9, "inserts before the beach, not into the sea");
		assert.equal(r.ground[0], ",".repeat(11) + ".~~");
		assert.equal(r.ground[4], ":".repeat(14), "the exit path crosses the new strip");
		assert.deepEqual(r.map, coast().map);
		assert.deepEqual(r.spawn, { x: 11, y: 4 }, "the spawn moves with its ground");
		for (const type of ["Character", "Spot", "Beacon", "Building", "Site", "Scenery", "Ruin", "Field", "MillLoad", "SiteOrder", "Zone", "Bed", "Animal", "Plot"]) {
			const fields: Record<string, string> = type === "Character" ? { charId: "moved" } : {};
			assert.equal((await get<{ x: number }>(s, type, fields)).x, 11, type);
		}
		assert.deepEqual((await get<{ plants: object[] }>(s, "Bed")).plants, [{ x: 0, y: 0 }]);
		assert.equal((await get<{ zone: { x: number } }>(s, "Motion")).zone.x, 11);
		assert.equal((await get<{ x: number }>(s, "Item", { itemId: "coin" })).x, 11, "derived Item type moves too");
		assert.equal((await get<{ x: number }>(s, "Item", { itemId: "carried" })).x, -1);
		assert.equal((await get<ExitFields>(s, "Exit", { exitId: "out" })).x, 13);
		const incoming = await get<ExitFields>(s, "Exit", { exitId: "back" });
		assert.deepEqual(incoming.arrive, { x: 12, y: 4 });
		assert.equal(incoming.arriveGrowthRevision, 1);
		const live = await spatialWorld(s, { ...w, allRooms: w.rooms });
		assert.deepEqual(live.allRooms![0]!.spawn, r.spawn, "sailing uses the same spawn coordinates");
		assert.deepEqual(live.rooms[0]!.ground, r.ground);
		const txn = (await s.createTransaction(10_000)).id;
		await pinTerrain(s, txn);
		await execute({ space: s, txn, world: live, actor: actor("walker", 8, 3), account: null, cache: {}, msgLeaseMs: 60_000 }, "step 1 0");
		await s.commit(txn);
		assert.equal((await get<CharacterFields>(s, "Character", { charId: "walker" })).x, 9, "walking uses the expanded ground");
		await loadIntoSpace(s, w, { replace: true });
		assert.deepEqual((await get<RoomFields>(s, "Room", { roomId: "r" })).ground, r.ground);
		assert.deepEqual((await get<ExitFields>(s, "Exit", { exitId: "back" })).arrive, incoming.arrive, "reload does not transform twice");
		const travel = (await s.createTransaction(10_000)).id;
		await pinTerrain(s, travel);
		await traverse({ space: s, txn: travel, world: live, actor: { ...actor("walker", 0, 4), room: "q" }, account: null, cache: {}, msgLeaseMs: 60_000 }, await get<ExitFields>(s, "Exit", { exitId: "back" }));
		await s.commit(travel);
		assert.equal((await get<CharacterFields>(s, "Character", { charId: "walker" })).x, 12);
		await loadIntoSpace(s, { ...w,
			objects: [{ itemId: "new-object", proto: "ding", room: "r", x: 9, y: 5 }],
			npcs: [{ ...definition.npcs[0]!, npcId: "newborn", room: "r", x: 9, y: 3 }],
			beacons: [{ beaconId: "new-fire", name: "New fire", aliases: [], room: "r", x: 9, y: 6, covers: ["r"] }],
		}, { replace: true });
		assert.equal((await get<CharacterFields>(s, "Character", { charId: "npc-newborn" })).x, 11);
		assert.equal((await get<{ x: number }>(s, "Item", { itemId: "new-object" })).x, 11);
		assert.equal((await get<{ x: number }>(s, "Beacon", { beaconId: "new-fire" })).x, 11);
	} finally { await host.close(BACKGROUND_CONTEXT); }
});

test("growth defers while a command pins coordinates and rolls back a failed commit", async () => {
	const { host, s, w } = await fixture();
	try {
		const txn = (await s.createTransaction(10_000)).id;
		await pinTerrain(s, txn);
		assert.equal(await growthTick(s, w, 60_000), 0);
		await s.abort(txn);
		const failing = new Proxy(s, { get(target, prop) { if (prop === "commit") return async () => { throw new Error("injected commit failure"); }; const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v; } });
		await assert.rejects(growthTick(failing, w, 60_000), /injected/);
		assert.deepEqual((await get<RoomFields>(s, "Room", { roomId: "r" })).ground, coast().ground);
		assert.equal((await get<{ x: number }>(s, "Plot")).x, 9);
		assert.equal((await get<ExitFields>(s, "Exit", { exitId: "out" })).x, 11);
		assert.equal(await s.count({ type: "RoomGrowth" }), 0);
		assert.equal(await growthTick(s, w, 60_000), 1);
	} finally { await host.close(BACKGROUND_CONTEXT); }
});

test("a strip never cuts a footprint or creates an unreachable island of building land", async () => {
	const { host, s, w } = await fixture();
	try {
		await write(s, "Building", { room: "r", x: 5, y: 0, w: 7, h: 8 });
		assert.equal(await growthTick(s, w, 60_000), 0, "all eligible eastern seams cross the building");
		for (const e of await s.readAll({ type: "Building" })) await s.takeIfExists({ id: e.id }, 0);
		for (let y = 0; y < 8; y++) await write(s, "Plot", { room: "r", x: 8, y, of: "wall" });
		assert.equal(await growthTick(s, w, 60_000), 1, "tries another seam when the outer strip is unreachable");
		assert.equal((await get<RoomGrowthFields>(s, "RoomGrowth")).steps![0]!.at, 8, "inserts before the blocking wall");
	} finally { await host.close(BACKGROUND_CONTEXT); }
});

test("a ferry resolves old arrival coordinates against destination growth, once, including retries", async () => {
	const { host, s, w } = await fixture();
	try {
		assert.equal(await growthTick(s, w, 60_000), 1);
		const h: HandoverFields = { handoverId: "h", charId: "ferry", from: "a", to: "b", character: actor("ferry", 10, 4), account: null, at: 0 };
		assert.equal(await arrive(s, w, h), true);
		assert.equal((await get<CharacterFields>(s, "Character", { charId: "ferry" })).x, 12);
		assert.equal(await arrive(s, w, h), false);
		const current: HandoverFields = { ...h, charId: "current", character: actor("current", 12, 4), arrivalGrowthRevision: 1 };
		assert.equal(await arrive(s, w, current), true);
		assert.equal((await get<CharacterFields>(s, "Character", { charId: "current" })).x, 12);
	} finally { await host.close(BACKGROUND_CONTEXT); }
});


test("southern growth extends its boundary exit and survives a second axis and reload", async () => {
	const { host, s, w } = await fixture();
	try {
		assert.equal(await growthTick(s, w, 60_000), 1);
		const before = await get<RoomFields>(s, "Room", { roomId: "r" });
		// A southern door forces insertion before the last two rows.
		await write(s, "Exit", { ...exit, exitId: "south", x: 3, y: 7 });
		const taller = { ...w, growth: { ...w.growth!, maxH: 10 } };
		assert.equal(await growthTick(s, taller, 60_000), 1);
		const g = await get<RoomGrowthFields>(s, "RoomGrowth");
		assert.equal(g.steps!.length, 2);
		assert.deepEqual(g.steps!.map((s) => s.axis), ["x", "y"]);
		assert.equal((await get<ExitFields>(s, "Exit", { exitId: "south" })).y, 9);
		const after = await get<RoomFields>(s, "Room", { roomId: "r" });
		assert.equal(after.ground.length, before.ground.length + 2);
		assert.deepEqual(grownGround(coast().ground, g, ","), after.ground);
		await loadIntoSpace(s, taller, { replace: true });
		assert.deepEqual((await get<RoomFields>(s, "Room", { roomId: "r" })).ground, after.ground);
		await assert.rejects(loadIntoSpace(s, { ...taller, rooms: taller.rooms.map((r) => r.roomId === "r" ? { ...r, ground: r.ground.map((row) => row + ",") } : r) }, { replace: true }), /base dimensions/);
	} finally { await host.close(BACKGROUND_CONTEXT); }
});


test("every Leuchtfeuer room can gain its first strip without breaking an exit or a spawn", async () => {
	const host = openOwnMemoryHost(), s = new PhiSpaces(host, BACKGROUND_CONTEXT);
	try {
		await write(s, WORLD_LOCK.type, WORLD_LOCK.fields);
		await loadIntoSpace(s, definition);
		// Force only the fullness threshold; terrain, exits, scenery and characters are the real world definition.
		const full = { ...definition, growth: { ...definition.growth!, fullShare: 0 } };
		assert.equal(await growthTick(s, full, 60_000), definition.rooms.length);
		const rooms = new Map((await s.readAll({ type: "Room" })).map((e) => { const r = fieldsOf<RoomFields>(e); return [r.roomId, r] as const; }));
		for (const e of await s.readAll({ type: "Exit" })) {
			const exit = fieldsOf<ExitFields>(e);
			assert.ok(walkable(full, rooms.get(exit.location)!.ground, exit.x, exit.y), `${exit.exitId}: source`);
			assert.ok(walkable(full, rooms.get(exit.destination)!.ground, exit.arrive.x, exit.arrive.y), `${exit.exitId}: arrival`);
		}
		for (const r of rooms.values()) {
			assert.ok(walkable(full, r.ground, r.spawn!.x, r.spawn!.y), `${r.roomId}: spawn`);
			assert.ok(r.ground[0]!.length <= full.growth.maxW && r.ground.length <= full.growth.maxH);
		}
	} finally { await host.close(BACKGROUND_CONTEXT); }
});
