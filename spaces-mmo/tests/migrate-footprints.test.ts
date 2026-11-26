// The migration from the legacy Plot entries to one Footprint entry per object (scripts/migrate-footprints.ts): a world
// loaded and turned back into the legacy store (its plots per cell, no GridFormat entry, locks missing) is checked,
// refused while a plot of no object is there, migrated with --drop-orphans, and then starts (the grid format check) with
// the same occupancy; a run cut off goes on; a migrated store is left as it is, but for the RoadCells entries of its roads
// (phase 1 step 10), which a store migrated before them gets.
import { test } from "node:test";
import assert from "node:assert/strict";
import { FOREVER, NO_WAIT, PhiSpaces, openOwnMemoryHost } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { loadWorld } from "../server/engine/world.ts";
import { loadIntoSpace } from "../server/engine/loader.ts";
import { checkGridFormat, GridFormatRefused } from "../server/engine/grid-format.ts";
import { footprintCells } from "../server/engine/occupancy.ts";
import { islandLock, lockReport, roomLock } from "../server/engine/room-lock.ts";
import { storeOccupancyReport, type OccupancyEntry } from "../shared/footprints.ts";
import { WORLD_LOCK, type FootprintFields } from "../shared/model.ts";
import { migrateFootprints } from "../scripts/migrate-footprints.ts";
import { roadEntries, roadReport } from "../server/engine/commands/road.ts";
import type { RouteFields } from "../shared/model.ts";

const w = await loadWorld();

/** A loaded world as a binary of before the switch left it: plots per cell, no marker, a room's and an island's lock
 *  missing. `keep`: footprints left as they are (a migration cut off after them). */
async function legacy(space: PhiSpaces, keep = 0): Promise<string[]> {
	await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER); // the space process writes it
	await loadIntoSpace(space, w);
	assert.ok(await space.takeIfExists({ type: "GridFormat" }, 0));
	const prints = await space.readAll({ type: "Footprint" });
	assert.ok(prints.length > 10, "the world has objects with footprints");
	for (const e of prints.slice(keep)) {
		await space.take({ id: e.id }, NO_WAIT);
		for (const c of footprintCells(e.fields as unknown as FootprintFields)) await space.write({ type: "Plot", fields: { room: e.fields.room, of: e.fields.of, x: c.x, y: c.y } }, null, FOREVER);
	}
	const island = w.rooms.find((r) => r.island)!;
	assert.ok(await space.takeIfExists(roomLock(island.roomId), 0));
	assert.ok(await space.takeIfExists(islandLock(island.island!), 0));
	return prints.map((e) => `${String(e.fields.room)} ${String(e.fields.of)}`).sort();
}

async function withSpace(f: (space: PhiSpaces) => Promise<void>): Promise<void> {
	const host = openOwnMemoryHost(), space = new PhiSpaces(host, ctx);
	try { await f(space); } finally { await host.close(ctx); }
}

async function migrated(space: PhiSpaces, prints: string[]): Promise<void> {
	const entries = (await space.readAll({})) as unknown as OccupancyEntry[];
	assert.equal(entries.filter((e) => e.type === "Plot").length, 0);
	assert.deepEqual(entries.filter((e) => e.type === "Footprint").map((e) => `${String(e.fields.room)} ${String(e.fields.of)}`).sort(), prints);
	assert.deepEqual(storeOccupancyReport(entries, { rooms: "required" }), []);
	assert.deepEqual(lockReport(entries), []);
	const [m] = await space.readAll({ type: "GridFormat" });
	assert.deepEqual(m?.fields, { worldId: w.id, gridScale: 1, occupancy: "footprints", state: "complete" });
	await checkGridFormat(space, w);
}

test("a legacy store: the check lists an orphan plot and the missing locks; refused without --drop-orphans; migrated, it starts", { timeout: 120_000 }, async () => {
	await withSpace(async (space) => {
		const prints = await legacy(space);
		await space.write({ type: "Plot", fields: { room: "graue-bucht", of: "b-gone", x: 1, y: 1 } }, null, FOREVER);
		await assert.rejects(checkGridFormat(space, w), (e: Error) => e instanceof GridFormatRefused && /legacy grid format/.test(e.message));
		const before = (await space.stats()).entries;

		const check = await migrateFootprints(space, { check: true });
		assert.equal(check.outcome, "checked");
		assert.equal(check.orphans, 1);
		assert.ok(check.report.some((l) => l === "graue-bucht 1,1: plot of b-gone, which is not there"), check.report.join("\n"));
		assert.equal(check.report.filter((l) => / locks$/.test(l)).length, 2, check.report.join("\n"));
		assert.equal(check.locks, 2, "the check counts the missing locks");
		assert.equal((await space.stats()).entries, before, "the check writes nothing");

		const refused = await migrateFootprints(space);
		assert.equal(refused.outcome, "refused");
		assert.match(refused.report.join("\n"), /--drop-orphans/);
		assert.equal((await space.stats()).entries, before, "a refusal writes nothing");

		const done = await migrateFootprints(space, { dropOrphans: true });
		assert.equal(done.outcome, "migrated");
		assert.equal(done.orphans, 1);
		assert.equal(done.locks, 2);
		await migrated(space, prints);
		assert.equal((await migrateFootprints(space)).outcome, "already");
	});
});

test("a migration cut off goes on; plots that differ from their object are refused before anything is written, unless the objects are followed; objects that overlap are refused", { timeout: 120_000 }, async () => {
	await withSpace(async (space) => {
		const prints = await legacy(space, 5);
		await space.write({ type: "GridFormat", fields: { worldId: w.id, gridScale: 1, occupancy: "footprints", state: "running" } }, null, FOREVER);
		await assert.rejects(checkGridFormat(space, w), (e: Error) => e instanceof GridFormatRefused && /has not finished/.test(e.message));
		const done = await migrateFootprints(space);
		assert.equal(done.outcome, "migrated");
		assert.equal(done.objects, prints.length - 5);
		await migrated(space, prints);
	});
	await withSpace(async (space) => {
		await legacy(space);
		// one cell of an object's plots gone: the plots say nothing there, the object something
		const p = (await space.readAll({ type: "Plot" }))[0]!;
		await space.take({ id: p.id }, NO_WAIT);
		const before = (await space.stats()).entries;
		const r = await migrateFootprints(space);
		assert.equal(r.outcome, "refused");
		assert.ok(r.report.some((l) => l.startsWith(`${String(p.fields.room)} ${String(p.fields.x)},${String(p.fields.y)}: plots say nothing, objects ${String(p.fields.of)}`)), r.report.join("\n"));
		assert.equal((await space.stats()).entries, before);
		assert.match(r.report.join("\n"), /--follow-objects/);
		// the objects followed: the cell is the object's again
		const done = await migrateFootprints(space, { followObjects: true });
		assert.equal(done.outcome, "migrated");
		assert.deepEqual(storeOccupancyReport((await space.readAll({})) as unknown as OccupancyEntry[], { rooms: "required" }), []);
	});
	// two objects on the same cells (a test bed's building written by hand): refused, objects followed or not
	await withSpace(async (space) => {
		await legacy(space);
		const p = (await space.readAll({ type: "Plot" }))[0]!;
		await space.write({ type: "Building", fields: { buildId: "test-bau", plan: "huette", name: "Hütte", room: p.fields.room, x: p.fields.x, y: p.fields.y, w: 1, h: 1 } }, null, FOREVER);
		const before = (await space.stats()).entries;
		const r = await migrateFootprints(space, { followObjects: true, dropOrphans: true });
		assert.equal(r.outcome, "refused");
		assert.ok(r.report.some((l) => / overlap$/.test(l) && l.includes("test-bau")), r.report.join("\n"));
		assert.equal((await space.stats()).entries, before);
	});
});

test("a store migrated before the roads' cells had entries of their own: refused at start; the migration writes them, then it starts", { timeout: 120_000 }, async () => {
	await withSpace(async (space) => {
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, null, FOREVER);
		await loadIntoSpace(space, w);
		const room = w.rooms.find((r) => r.roomId === "graue-bucht")!;
		const road: RouteFields = { routeId: "r-old", pair: "graue-bucht|klippenpfad", island: room.island!, rooms: ["graue-bucht", "klippenpfad"], names: ["Graue Bucht", "Klippenpfad"], cells: [{ room: "graue-bucht", x: 3, y: 4 }, { room: "graue-bucht", x: 4, y: 4 }, { room: "klippenpfad", x: 1, y: 2 }], state: "built", planner: "o", plannerName: "O", accountId: "o", voters: [], yes: [], no: [], voteUntil: 0, needs: [], work: 0, workNeed: 0, by: {}, untilWorldMs: FOREVER, at: 0, points: 2 };
		for (const e of roadEntries(road)) await space.write(e as never, null, FOREVER);
		await assert.rejects(checkGridFormat(space, w), (e: Error) => e instanceof GridFormatRefused && /no RoadCells entries/.test(e.message));
		const before = (await space.stats()).entries;
		const check = await migrateFootprints(space, { check: true });
		assert.deepEqual(check.report, ["r-old graue-bucht: 0 RoadCells entries", "r-old klippenpfad: 0 RoadCells entries"]);
		assert.equal(check.roads, 2, "the check counts the roads' missing cells");
		assert.equal((await space.stats()).entries, before, "the check writes nothing");
		const done = await migrateFootprints(space);
		assert.equal(done.outcome, "migrated");
		assert.equal(done.roads, 2);
		const kept = (await space.readAll({ type: "RoadCells", fields: { routeId: "r-old" } })).map((e) => e.fields).sort((a, b) => String(a.room).localeCompare(String(b.room)));
		assert.deepEqual(kept, [{ routeId: "r-old", room: "graue-bucht", cells: [{ x: 3, y: 4 }, { x: 4, y: 4 }] }, { routeId: "r-old", room: "klippenpfad", cells: [{ x: 1, y: 2 }] }]);
		assert.deepEqual(roadReport((await space.readAll({})) as unknown as OccupancyEntry[]), []);
		await checkGridFormat(space, w);
		assert.equal((await migrateFootprints(space)).outcome, "already");
	});
});
