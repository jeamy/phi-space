// npm run migrate:footprints -- --space <address> [--check] [--drop-orphans] [--follow-objects]: moves a store of the legacy occupancy
// (one Plot entry per cell, no GridFormat entry) to one Footprint entry per object (docs/3d-welt-und-raster-plan-2026-11-21.en.md
// section 5, docs/raster-inventur-2026-11-24.en.md section 7). Run it with the world (and every other writer of the space)
// stopped, on each region's space, from a backup: the binaries of the switch refuse the store until it has run
// (shared/grid-format.ts gridRefusal).
//
// `--check` reads only: what the plots and the objects say of every room, the plots of no object (orphans), the rooms
// and islands without their lock. Without it, a store whose plots differ from its objects is refused before anything is
// written; `--drop-orphans` takes plots of no object instead of refusing them (listed first); `--follow-objects` takes
// the objects' rectangles where their plots say otherwise (an object written by hand without its plots, a test bed's),
// refusing still where objects overlap or reach outside their room (no rule decides those: fix the store by hand). Then: the GridFormat entry
// with state "running"; the missing room and island locks; per object one transaction that holds its room's lock, writes
// its Footprint entry and takes its plots; the orphans, if asked; the check of the result (shared/footprints.ts, the
// locks); the GridFormat entry "complete". A run cut off is run again: it goes on where it stopped (an object with its
// footprint already has its plots taken in the same commit), and a migrated store is left as it is. Every road gets its
// RoadCells entries (a road's cells as builders read them, phase 1 step 10), also in a store whose footprints were
// migrated before them.
import { fileURLToPath } from "node:url";
import { FOREVER, NO_WAIT, peek, type SpaceLike } from "phi-spaces";
import { FOOTPRINTS, occupancyId, storeOccupancyReport, type FootprintType, type OccupancyEntry } from "../shared/footprints.ts";
import { SUPPORTED_FORMAT, type GridFormatFields } from "../shared/grid-format.ts";
import type { FootprintFields } from "../shared/model.ts";
import { footprintCells, takeFootprint, writeFootprint } from "../server/engine/occupancy.ts";
import { holdIsland, holdRoom, islandLock, lockReport, roomLock, writeIslandLock, writeRoomLock } from "../server/engine/room-lock.ts";
import { roadCellsEntries, roadReport } from "../server/engine/commands/road.ts";
import type { RouteFields } from "../shared/model.ts";

export type MigrationResult = {
	/** "migrated": done now; "already": the store had the footprints already; "refused": nothing written, see `report`. */
	outcome: "migrated" | "already" | "refused" | "checked";
	/** What differs (check, refusal) or what was dropped. */
	report: string[];
	orphans: number;
	objects: number;
	/** Locks written; in a check, the rooms and islands whose lock is missing. */
	locks: number;
	/** RoadCells entries written (a road's cells, inventory 7.8); in a check, the roads' rooms whose entry is missing or differs. */
	roads: number;
};

const is = (e: OccupancyEntry, t: string) => e.type === t || !!e.types?.includes(t);
const TXN_MS = 30_000;

/** The objects with cells of their own, with their footprint (shared/footprints.ts FOOTPRINTS; a Scenery with `through`
 *  has none), and the plots of no object of their room. */
function survey(entries: readonly OccupancyEntry[]) {
	const objects: FootprintFields[] = [], ids = new Set<string>();
	for (const e of entries) {
		const kind = (Object.keys(FOOTPRINTS) as FootprintType[]).find((t) => is(e, t));
		if (!kind || (kind === "Scenery" && e.fields.through)) continue;
		const f = e.fields, of = String(f[FOOTPRINTS[kind]]), room = String(f.room);
		objects.push({ room, of, x: Number(f.x), y: Number(f.y), w: typeof f.w === "number" ? f.w : 1, h: typeof f.h === "number" ? f.h : 1 });
		ids.add(`${room} ${of}`);
	}
	const orphans = entries.filter((e) => is(e, "Plot") && !ids.has(`${String(e.fields.room)} ${String(e.fields.of)}`));
	return { objects, orphans };
}

/** The store's entries with every Footprint entry as the plots it stands for: a store migrated half way is compared as
 *  one of plots (an object either has its footprint or its plots, never both: they change in one commit). */
function asPlots(entries: readonly OccupancyEntry[]): OccupancyEntry[] {
	return entries.flatMap((e) => is(e, "Footprint")
		? footprintCells(e.fields as unknown as FootprintFields).map((c) => ({ type: "Plot", fields: { room: e.fields.room, of: e.fields.of, x: c.x, y: c.y } }))
		: [e]);
}

/** The RoadCells entries a road of before them lacks (inventory 7.4: a builder reads a road's cells from them), one
 *  transaction a road holding its island's and both rooms' locks; a road that has them is left as it is. */
async function roadCells(space: SpaceLike, entries: readonly OccupancyEntry[]): Promise<number> {
	let written = 0;
	for (const r of entries.filter((e) => is(e, "Route")).map((e) => e.fields as unknown as RouteFields)) await inTxn(space, async (txn) => {
		if (!(await holdIsland(space, txn, r.island, r.rooms, NO_WAIT))) throw new Error(`the locks of ${r.rooms.join(", ")} are held: is the world (or another writer) running? stop it and run the migration again`);
		for (const e of roadCellsEntries(r)) if (!(await peek(space, { type: "RoadCells", fields: { routeId: r.routeId, room: e.fields.room } }, { txn }))) { await space.write(e as never, txn, FOREVER, { unique: ["routeId", "room"] }); written++; }
	});
	return written;
}

async function inTxn<T>(space: SpaceLike, f: (txn: string) => Promise<T>): Promise<T> {
	const txn = (await space.createTransaction(TXN_MS)).id;
	try {
		const v = await f(txn);
		await space.commit(txn);
		return v;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

export async function migrateFootprints(space: SpaceLike, o: { check?: boolean; dropOrphans?: boolean; followObjects?: boolean; log?: (line: string) => void } = {}): Promise<MigrationResult> {
	const log = o.log ?? (() => {});
	let entries = (await space.readAll({})) as unknown as OccupancyEntry[];
	const markers = entries.filter((e) => is(e, "GridFormat")).map((e) => e.fields as unknown as GridFormatFields);
	const plots = entries.filter((e) => is(e, "Plot")).length;
	const result = (outcome: MigrationResult["outcome"], report: string[], more: Partial<MigrationResult> = {}): MigrationResult => ({ outcome, report, orphans: 0, objects: 0, locks: 0, roads: 0, ...more });
	if (markers.length > 1) return result("refused", [`the store holds ${markers.length} GridFormat entries; it is damaged, restore it from its backup`]);
	const marker = markers[0];
	if (marker && (marker.gridScale !== SUPPORTED_FORMAT.gridScale || marker.occupancy !== SUPPORTED_FORMAT.occupancy)) return result("refused", [`the store is in the grid format gridScale ${marker.gridScale}, occupancy ${marker.occupancy}: not one this migration takes`]);
	if (marker?.state === "complete" && !plots && !o.check) {
		// a store migrated before the roads' cells had entries of their own (phase 1 step 10): those are written now
		const roads = roadReport(entries);
		if (!roads.length) return result("already", []);
		const n = await roadCells(space, entries);
		const after = roadReport((await space.readAll({})) as unknown as OccupancyEntry[]);
		if (after.length) throw new Error(`the roads and their cells differ (restore the backup):\n  ${after.slice(0, 40).join("\n  ")}`);
		log(`[migrate] ${n} RoadCells entries written: the store's footprints were migrated before`);
		return result("migrated", [], { roads: n });
	}
	if (marker?.state === "complete" && !plots) { const roads = roadReport(entries); return result("checked", roads, { roads: roads.length }); }
	if (marker?.state === "complete") return result("refused", [`the store says it is migrated but holds ${plots} Plot entries; it is damaged, restore it from its backup`]);
	const worlds = [...new Set(entries.filter((e) => is(e, "WorldLoaded")).map((e) => String(e.fields.worldId)))];
	if (!marker && worlds.length !== 1) return result("refused", [worlds.length ? `the store holds the worlds ${worlds.join(", ")}: one is expected` : "the store holds no WorldLoaded entry: nothing to migrate (an empty store is started by the world itself)"]);

	const { objects, orphans } = survey(entries);
	const orphanLines = orphans.map((e) => `${String(e.fields.room)} ${String(e.fields.x)},${String(e.fields.y)}: plot of ${String(e.fields.of)}, which is not there`);
	const orphaned = new Set(orphans.map((e) => String(e.fields.of)));
	const diffs = storeOccupancyReport(asPlots(entries), { rooms: "required", against: "plots", skip: (id) => orphaned.has(id) && !objects.some((f) => f.of === id) });
	const locks = lockReport(entries);
	// what the objects say among themselves (their rectangles as footprints, the plots left out): an overlap, a cell
	// outside the room, a room that is not there
	const clashes = storeOccupancyReport([...entries.filter((e) => !is(e, "Plot") && !is(e, "Footprint")), ...objects.map((f) => ({ type: "Footprint", fields: f }))], { rooms: "required" });
	// in a check the counts are of what is missing: the locks and the roads' cells a migration would write
	if (o.check) { const roads = roadReport(entries); return result("checked", [...diffs, ...orphanLines, ...locks, ...roads], { orphans: orphans.length, objects: objects.length, locks: locks.length, roads: roads.length }); }
	if (o.followObjects ? clashes.length : diffs.length) return result("refused", [...(o.followObjects ? clashes : diffs), ...(!o.followObjects && !clashes.length ? ["the plots differ from their objects only: run with --follow-objects to take the objects' rectangles (after a --check)"] : [])], { orphans: orphans.length, objects: objects.length });
	if (orphans.length && !o.dropOrphans) return result("refused", [...orphanLines, "plots of no object: run with --drop-orphans to take them (after a --check)"], { orphans: orphans.length, objects: objects.length });

	// the marker first: a binary of the switch refuses the store until the last step has written "complete"
	if (!marker) {
		const format: GridFormatFields = { worldId: worlds[0]!, gridScale: SUPPORTED_FORMAT.gridScale, occupancy: SUPPORTED_FORMAT.occupancy, state: "running" };
		await space.write({ type: "GridFormat", fields: format as never }, null, FOREVER);
		log(`[migrate] ${format.worldId}: GridFormat running`);
	} else log(`[migrate] ${marker.worldId}: GridFormat running already, going on`);

	// the locks a store of before them lacks (the loader writes them too; the objects' transactions need them first)
	let written = 0;
	const rooms = entries.filter((e) => is(e, "Room"));
	for (const r of rooms) {
		const room = String(r.fields.roomId), island = typeof r.fields.island === "string" ? r.fields.island : null;
		await inTxn(space, async (txn) => {
			if (!(await peek(space, roomLock(room), { txn }))) { await writeRoomLock(space, txn, room); written++; }
			if (island && !(await peek(space, islandLock(island), { txn }))) { await writeIslandLock(space, txn, island); written++; }
		});
	}

	// one object a transaction: its room's lock, its footprint, its plots taken
	let moved = 0;
	for (const f of objects) await inTxn(space, async (txn) => {
		if (!(await holdRoom(space, txn, f.room, NO_WAIT))) throw new Error(`the lock of ${f.room} is held: is the world (or another writer) running? stop it and run the migration again`);
		const old = await takeFootprint(space, txn, f.room, f.of);
		await writeFootprint(space, txn, old ?? f, !!old);
		let n = 0;
		while (await space.takeIfExists({ type: "Plot", fields: { room: f.room, of: f.of } }, NO_WAIT, { txn })) n++;
		if (n || !old) moved++;
	});
	// what is left of the plots: those of no object (taken only when asked, listed above)
	let dropped = 0;
	if (o.dropOrphans) for (const e of orphans) await inTxn(space, async (txn) => {
		const room = String(e.fields.room);
		if (rooms.some((r) => r.fields.roomId === room) && !(await holdRoom(space, txn, room, NO_WAIT))) throw new Error(`the lock of ${room} is held: is the world running?`);
		if (await space.takeIfExists({ id: (e as unknown as { id: string }).id }, NO_WAIT, { txn })) dropped++;
	});

	const roads = await roadCells(space, entries);

	// the result: no plot left, every object's footprint, one lock per room and island, every road's cells
	entries = (await space.readAll({})) as unknown as OccupancyEntry[];
	const left = entries.filter((e) => is(e, "Plot")).length;
	const after = [...(left ? [`${left} Plot entries left`] : []), ...storeOccupancyReport(entries, { rooms: "required" }), ...lockReport(entries), ...roadReport(entries)];
	const ids = new Set(entries.filter((e) => is(e, "Footprint")).map((e) => `${String(e.fields.room)} ${String(e.fields.of)}`));
	for (const f of survey(entries).objects) if (!ids.has(`${f.room} ${f.of}`)) after.push(`${f.room} ${f.of}: no footprint`);
	if (after.length) throw new Error(`the migrated store differs (the GridFormat entry stays "running"; restore the backup):\n  ${after.slice(0, 40).join("\n  ")}`);
	await inTxn(space, async (txn) => {
		const m = await space.takeIfExists({ type: "GridFormat" }, NO_WAIT, { txn });
		if (!m) throw new Error("the GridFormat entry is gone or held: is another migration running?");
		await space.write({ type: "GridFormat", fields: { ...(m.fields as unknown as GridFormatFields), state: "complete" } as never }, txn, FOREVER);
	});
	log(`[migrate] ${objects.length} objects (${moved} moved now), ${written} locks written, ${dropped} orphan plots taken, ${roads} RoadCells entries written: GridFormat complete`);
	return result("migrated", orphanLines.slice(0, dropped ? orphanLines.length : 0), { orphans: dropped, objects: moved, locks: written, roads });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2), flag = (n: string) => args.includes(n);
	const at = args.indexOf("--space"), address = at >= 0 ? args[at + 1] : undefined;
	if (!address) { console.error("usage: npm run migrate:footprints -- --space <address> [--check] [--drop-orphans] [--follow-objects]"); process.exit(2); }
	const { connectSpace } = await import("../server/space.ts");
	const { space, close } = connectSpace(address, { callTimeoutMs: 120_000 });
	try {
		const r = await migrateFootprints(space, { check: flag("--check"), dropOrphans: flag("--drop-orphans"), followObjects: flag("--follow-objects"), log: (l) => console.log(l) });
		console.log(`[migrate] ${r.outcome}: ${r.objects} objects, ${r.orphans} orphan plots, ${r.locks} locks, ${r.roads} road cells`);
		for (const l of r.report.slice(0, 200)) console.log(`  ${l}`);
		if (r.report.length > 200) console.log(`  … ${r.report.length - 200} more`);
		process.exitCode = r.outcome === "refused" || (r.outcome === "checked" && r.report.length) ? 1 : 0;
	} finally { close(); }
}
