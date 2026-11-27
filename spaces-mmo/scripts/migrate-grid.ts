// npm run migrate:grid -- --space <address> [--check]: moves a world or region store from gridScale 1 to gridScale 2
// (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 5, the second step of the cut; phase 2 step 7). Run it with the
// world (and every other writer of the space) stopped, on each region's space, on a copy of the backup, after the
// footprint migration (scripts/migrate-footprints.ts): the binaries at scale 2 refuse the store until it has run
// (shared/grid-format.ts gridRefusal).
//
// Every entry is changed by the grid class of its fields (shared/grid-format.ts GRID_CLASSES, section 2.2): an area's
// position and size × 2, a fire's and an exit's cell an area of 2 × 2; a cell point × 2, once; the atlas and the carried
// sentinel (-1, -1) stay. Special rules: a room's ground and decor are resampled as the world definition is
// (shared/world-scale.ts); its growth history doubles (east, south, the base, each step's at and size, each element of a
// step's fill twice), and a room of the definition is reconstructed from the scale-2 definition and that history and
// compared; a road's cells double with the cell between two neighbours inserted (and the one between a fire and a road
// that began on its west or north side), and its Road and RoadCells entries are written anew from the Route (`paved`
// follows the work done, as the engine computes it at every write); a field's needs are computed anew from the scale-2
// definition and must equal the stored ones; NpcMemory is cleared (section 2.3); Msg and Notice texts stay.
//
// Refused, with nothing written: a store without the footprints (run migrate:footprints first), one with Plot, Handover
// or unexecuted Intent entries, an entry type without a grid class, a thing that lies in no room of this store, or
// anything the check of the result finds. The whole result is computed and checked at scale 2 before the first write;
// then: the GridFormat entry "running" at gridScale 2; the entries, a transaction a batch, each holding WORLD_LOCK; the
// store read back and compared with the result; the GridFormat entry "complete". There is no going on after a run cut
// off (a coordinate doubled twice has no repair): the store says "running" and is refused, by this script and by every
// binary, until it is restored from its backup (section 5, step 3). A migrated store is only checked.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { storeOccupancyReport, type OccupancyEntry } from "../shared/footprints.ts";
import { classRow, GRID_CLASSES, SUPPORTED_OCCUPANCY, type GridClass, type GridFormatFields } from "../shared/grid-format.ts";
import { besideArea, inArea, type Area } from "../shared/grid.ts";
import { WORLD_LOCK, type BedFields, type FieldFields, type RoomFields, type RoomGrowthFields, type RouteFields } from "../shared/model.ts";
import { bedCapacity, gridScale, useGridScale } from "../shared/rules.ts";
import { scaleDecor, scaleGround } from "../shared/world-scale.ts";
import { lockReport } from "../server/engine/room-lock.ts";
import { grownDecor, grownGround } from "../server/engine/room-growth.ts";
import { roadCellsEntries, roadEntries, roadReport } from "../server/engine/commands/road.ts";
import { worldFile } from "../server/engine/world.ts";
import type { WorldDef } from "../server/engine/world.ts";

/** The scale this migration goes from and to. */
export const FROM = 1, TO = 2;
const S = TO / FROM;

export type GridMigrationResult = {
	/** "migrated": done now; "already": the store was migrated before (`report`: what its check finds); "refused":
	 *  nothing written, see `report`; "checked": `--check`, nothing written. */
	outcome: "migrated" | "already" | "refused" | "checked";
	/** What refuses the migration (or would, in a check), or what the check of a migrated store finds. */
	report: string[];
	/** What differs from the definition already at scale 1 (a room's terrain, a field's needs): told, not refused. */
	notes: string[];
	/** Entries written anew (changed), entries taken without a successor (NpcMemory, the old Road parts). */
	changed: number;
	dropped: number;
};

type E = { id: string; type: string; types: string[]; fields: Record<string, unknown> };
/** A change: the entry taken (`from`) and what is written instead (`to`; none: it goes). */
type Change = { from: E; to: E | null };
type Defs = { one: WorldDef; two: WorldDef };

const TXN_MS = 60_000;
/** Bytes of new fields per transaction: well below the commit limit (maxCommitBytes 192 KiB) with the taken ones. */
const BATCH_BYTES = 64_000, BATCH_ENTRIES = 100;

// ---- the rules by grid class -------------------------------------------------------------------------------------------

/** Entry types refused while they are there (section 5): a handover or a command not run yet carries cells of scale 1. */
const REFUSED: Record<string, string> = {
	Plot: "a Plot entry of the legacy occupancy: run the footprint migration first",
	Handover: "a region handover not completed: finish it with the world running at scale 1, then back up again",
	Intent: "a command line not run yet: let the world run it (or drop it) at scale 1, then back up again",
};
/** Text fields: NpcMemory is cleared at the cut (section 2.3), Msg and Notice keep their texts. */
const TEXT: Record<string, "drop" | "keep"> = { NpcMemory: "drop", Msg: "keep", Notice: "keep" };
/** Types whose `path` or `growth` fields, or whole entry, a rule of its own changes. */
const OWN = new Set(["Route", "Road", "RoadCells", "RoomGrowth", "Room", "Item"]);

// every class row is covered: a new path, growth or text field has no generic rule
for (const [type, row] of Object.entries(GRID_CLASSES)) for (const cls of Object.values(row)) {
	if ((cls === "path" || cls === "growth") && !OWN.has(type)) throw new Error(`migrate-grid: ${type} has a ${cls} field and no rule`);
	if (cls === "text" && !TEXT[type] && !REFUSED[type]) throw new Error(`migrate-grid: ${type} has a text field and no rule`);
}

/** Calls `f` on every object the path `parts` names in `o` (`a[]`: each element of the list `a`; a missing part: none). */
function visit(o: unknown, parts: string[], f: (o: Record<string, unknown>) => void): void {
	if (!o || typeof o !== "object") return;
	if (!parts.length) return f(o as Record<string, unknown>);
	const [p, ...rest] = parts as [string, ...string[]];
	const v = (o as Record<string, unknown>)[p.endsWith("[]") ? p.slice(0, -2) : p];
	if (p.endsWith("[]")) { if (Array.isArray(v)) for (const x of v) visit(x, rest, f); }
	else visit(v, rest, f);
}

/** The area and point fields of a class row × S: `x,y,w,h` of an area, `x,y` of a point; an area of `x,y` only (a fire,
 *  an exit: a cell at scale 1) gets `w` and `h` (one cell each before). */
function scaleByClass(fields: Record<string, unknown>, row: Record<string, GridClass>): void {
	for (const [key, cls] of Object.entries(row)) {
		if (cls !== "area" && cls !== "point") continue;
		const parts = key.split("."), names = parts.pop()!.split(",");
		visit(fields, parts, (o) => {
			for (const n of names) if (typeof o[n] === "number") o[n] = (o[n] as number) * S;
			if (cls === "area" && !names.includes("w")) { o.w = (typeof o.w === "number" ? o.w : 1) * S; o.h = (typeof o.h === "number" ? o.h : 1) * S; }
		});
	}
}

export function scaleGrowth(g: RoomGrowthFields): RoomGrowthFields {
	return {
		...g, east: g.east * S, south: g.south * S,
		...(g.baseWidth !== undefined ? { baseWidth: g.baseWidth * S } : {}), ...(g.baseHeight !== undefined ? { baseHeight: g.baseHeight * S } : {}),
		...(g.steps ? { steps: g.steps.map((s) => ({ ...s, at: s.at * S, size: s.size * S, fill: s.fill.flatMap((k) => Array<string>(S).fill(k)) })) } : {}),
	};
}

/** A road's cells at scale S: each cell doubled, the cell between two neighbours of one room inserted, and at an end
 *  beside a fire (`fires`: the rooms' fires at scale 1) the cell between it and the fire, where the doubled cell no
 *  longer touches the fire's area (a road that began on its west or north side). */
export function scaleRouteCells(r: RouteFields, fires: ReadonlyMap<string, Area>, problems: string[]): RouteFields["cells"] {
	const out: RouteFields["cells"] = [];
	r.cells.forEach((c, i) => {
		const prev = r.cells[i - 1];
		if (prev && prev.room === c.room) {
			const dx = c.x - prev.x, dy = c.y - prev.y;
			if (Math.abs(dx) + Math.abs(dy) !== 1) problems.push(`road ${r.routeId}: ${prev.x},${prev.y} and ${c.x},${c.y} in ${c.room} are no neighbours`);
			else out.push({ room: c.room, x: prev.x * S + dx * (S - 1), y: prev.y * S + dy * (S - 1) });
		}
		out.push({ room: c.room, x: c.x * S, y: c.y * S });
	});
	const bridge = (old: RouteFields["cells"][number] | undefined, now: RouteFields["cells"][number] | undefined) => {
		const fire = old && fires.get(old.room);
		if (!old || !now || !fire || !besideArea(fire).some((p) => p.x === old.x && p.y === old.y)) return null;
		const big = scaledArea(fire);
		if (besideArea(big).some((p) => p.x === now.x && p.y === now.y)) return null;
		const dx = Math.sign(fire.x - old.x), dy = Math.sign(fire.y - old.y);
		const b = { room: old.room, x: now.x + dx, y: now.y + dy };
		if (!besideArea(big).some((p) => p.x === b.x && p.y === b.y)) { problems.push(`road ${r.routeId}: its end ${old.x},${old.y} in ${old.room} does not meet its fire at scale ${TO}`); return null; }
		return b;
	};
	const head = bridge(r.cells[0], out[0]), tail = bridge(r.cells.at(-1), out.at(-1));
	return [...(head ? [head] : []), ...out, ...(tail ? [tail] : [])];
}
const scaledArea = (a: Area): Area => ({ x: a.x * S, y: a.y * S, w: (a.w ?? 1) * S, h: (a.h ?? 1) * S });

/** A field's needs as the engine computes them (engine/commands/field.ts): sowing (`saat`) seed and work by its cells,
 *  a harvest (`reif`, `spaet`) work by its cells; null: none that follows from its size. */
function fieldNeeds(f: FieldFields, d: NonNullable<WorldDef["fields"]>): { seedNeed?: number; workNeed: number } | null {
	const n = f.w * f.h;
	if (f.stage === "saat") return { seedNeed: Math.ceil(n / d.seedPerCells), workNeed: Math.ceil(n / d.sowPerCells) };
	if (f.stage === "reif" || f.stage === "spaet") return { workNeed: Math.ceil(n / d.harvestPerCells) };
	return null;
}

const is = (e: { type: string; types?: readonly string[] }, t: string) => e.type === t || !!e.types?.includes(t);
const copy = <T>(v: T): T => structuredClone(v);

/** The store's entries at scale S, or what refuses it. Pure: reads `entries`, writes nothing. */
export function planGridMigration(entries: readonly E[], defs: Defs): { changes: Change[]; refusals: string[]; notes: string[] } {
	const refusals: string[] = [], notes: string[] = [], changes: Change[] = [];
	const rooms = new Map(entries.filter((e) => is(e, "Room")).map((e) => [String(e.fields.roomId), e] as const));
	const growth = new Map(entries.filter((e) => is(e, "RoomGrowth")).map((e) => [String(e.fields.roomId), e.fields as unknown as RoomGrowthFields] as const));
	const fires = new Map(entries.filter((e) => is(e, "Beacon")).map((e) => [String(e.fields.room), { x: Number(e.fields.x), y: Number(e.fields.y), w: e.fields.w as number | undefined, h: e.fields.h as number | undefined }] as const));
	const defRoom = (w: WorldDef, id: string) => (w.allRooms ?? w.rooms).find((r) => r.roomId === id);
	const tile = (w: WorldDef) => w.growth?.tile ?? ",";
	const roadParts = new Set<string>();

	for (const e of entries) {
		const row = classRow(e.type, defs.one.typeclasses);
		if (row === null) { refusals.push(`${e.type} ${e.id}: an entry type without a grid class (shared/grid-format.ts GRID_CLASSES)`); continue; }
		if (REFUSED[row]) { refusals.push(`${row} ${e.id}${row === "Handover" ? ` (${String((e.fields.character as { name?: unknown } | undefined)?.name ?? "")})` : row === "Intent" ? ` (${String(e.fields.charId)}: ${String(e.fields.line)})` : ""}: ${REFUSED[row]}`); continue; }
		if (TEXT[row] === "drop") { changes.push({ from: e, to: null }); continue; }
		const classes = GRID_CLASSES[row]!;
		if (!Object.keys(classes).length || TEXT[row] === "keep") continue;
		if (row === "Road" || row === "RoadCells") { roadParts.add(e.id); continue; } // written anew from their Route below
		const f = copy(e.fields);
		if (row === "Item") {
			const x = Number(f.x), y = Number(f.y), at = String(f.location);
			if (x === -1 && y === -1) continue; // carried, in a chest: the sentinel stays
			if (!rooms.has(at)) { refusals.push(`Item ${String(f.itemId)}: at ${x},${y} of ${at}, which is no room of this store`); continue; }
			f.x = x * S; f.y = y * S;
		} else if (row === "RoomGrowth") Object.assign(f, scaleGrowth(f as unknown as RoomGrowthFields));
		else if (row === "Route") {
			const r = f as unknown as RouteFields;
			r.cells = scaleRouteCells(e.fields as unknown as RouteFields, fires, refusals);
		} else {
			scaleByClass(f, classes);
			if (row === "Room") {
				const r = f as unknown as RoomFields;
				r.ground = scaleGround(r.ground, S);
				if (r.decor) r.decor = scaleDecor(r.decor, S);
			}
		}
		changes.push({ from: e, to: { ...e, fields: f } });
	}

	// a room of the definition: its terrain at scale S is the scale-S definition grown by the scaled history
	for (const [id, e] of rooms) {
		const one = defRoom(defs.one, id), two = defRoom(defs.two, id);
		if (!one || !two) continue; // dug, an inside: its own terrain, resampled
		const r = e.fields as unknown as RoomFields, g = growth.get(id) ?? { roomId: id, east: 0, south: 0 }, g2 = scaleGrowth(g);
		const same = (a: readonly string[] | undefined, b: readonly string[] | undefined) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
		let atOne: boolean;
		try { atOne = same(grownGround(one.ground, g, tile(defs.one)), r.ground) && same(grownDecor(one.decor, g), r.decor); } catch { atOne = false; }
		if (!atOne) { notes.push(`${id}: its terrain differs from the definition's at scale ${FROM} grown by its history (it keeps its own, resampled)`); continue; }
		let atTwo = false;
		try { atTwo = same(grownGround(two.ground, g2, tile(defs.two)), scaleGround(r.ground, S)) && same(grownDecor(two.decor, g2), r.decor ? scaleDecor(r.decor, S) : undefined); } catch (err) { refusals.push(`${id}: the history at scale ${TO} does not fit the definition's base (${(err as Error).message})`); continue; }
		if (!atTwo) refusals.push(`${id}: the definition at scale ${TO} grown by the scaled history is not the resampled terrain`);
	}

	// the roads: the Route at scale S, and its Road and RoadCells entries written anew from it
	const routes = changes.filter((c) => c.to && is(c.from, "Route"));
	const byRoute = new Map<string, E[]>();
	for (const e of entries) if (roadParts.has(e.id)) { const k = String(e.fields.routeId); byRoute.set(k, [...byRoute.get(k) ?? [], e]); }
	for (const c of routes) {
		const r = c.to!.fields as unknown as RouteFields;
		const old = byRoute.get(r.routeId) ?? [];
		byRoute.delete(r.routeId);
		const fresh = [...roadEntries(r).slice(1), ...roadCellsEntries(r)];
		for (const e of old) changes.push({ from: e, to: null });
		for (const part of fresh) changes.push({ from: { id: "", type: part.type, types: [], fields: {} }, to: { id: "", type: part.type, types: [], fields: part.fields as unknown as Record<string, unknown> } });
	}
	for (const [routeId, parts] of byRoute) refusals.push(`${parts.map((p) => p.type).join(", ")} of the road ${routeId}, which has no Route`);

	// a field's needs follow from its size: computed anew at scale S they are the stored ones
	if (defs.one.fields && defs.two.fields) for (const c of changes) {
		if (!c.to || !is(c.from, "Field")) continue;
		const before = c.from.fields as unknown as FieldFields, after = c.to.fields as unknown as FieldFields;
		const n1 = fieldNeeds(before, defs.one.fields), n2 = fieldNeeds(after, defs.two.fields);
		if (!n1 || !n2) continue;
		const stored = { ...(n1.seedNeed !== undefined ? { seedNeed: before.seedNeed } : {}), workNeed: before.workNeed };
		if (JSON.stringify(n1) !== JSON.stringify(stored)) { notes.push(`field ${before.fieldId}: its needs ${JSON.stringify(stored)} are not the definition's ${JSON.stringify(n1)} at scale ${FROM} (kept)`); continue; }
		if (JSON.stringify(n2) !== JSON.stringify(stored)) refusals.push(`field ${before.fieldId}: its needs at scale ${TO} would be ${JSON.stringify(n2)}, not ${JSON.stringify(stored)}`);
	}
	return { changes, refusals, notes };
}

/** What `entries` (a store at scale S, or the plan's result) has that a store at scale S must not: the occupancy, the
 *  locks and the roads (as the engine checks them), and the grid's own rules. Runs the rule values at scale S. */
export function checkAtScale(entries: readonly OccupancyEntry[]): string[] {
	const was = gridScale();
	useGridScale(TO);
	try {
		const out = [...storeOccupancyReport(entries, { rooms: "required" }), ...lockReport(entries), ...roadReport(entries as never)];
		const size = new Map(entries.filter((e) => is(e, "Room")).map((e) => { const g = e.fields.ground as string[]; return [String(e.fields.roomId), { w: g[0]?.length ?? 0, h: g.length }] as const; }));
		const inRoom = (room: unknown, x: unknown, y: unknown) => { const s = size.get(String(room)); return !s || (Number(x) >= 0 && Number(y) >= 0 && Number(x) < s.w && Number(y) < s.h); };
		for (const e of entries) {
			const f = e.fields;
			if (is(e, "Tree") && (f.w !== TO || f.h !== TO)) out.push(`tree ${String(f.treeId)}: ${String(f.w)}×${String(f.h)}, not ${TO}×${TO}`);
			if ((is(e, "Beacon") || is(e, "Exit")) && (f.w !== TO || f.h !== TO)) out.push(`${e.type} ${String(f.beaconId ?? f.exitId)}: an area of ${String(f.w)}×${String(f.h)}, not ${TO}×${TO}`);
			if (is(e, "Exit")) { const a = f.arrive as { x: number; y: number }; if (!inRoom(f.destination, a.x, a.y)) out.push(`exit ${String(f.exitId)}: its arrival ${a.x},${a.y} is outside ${String(f.destination)}`); }
			if ((is(e, "Character") || is(e, "Spot") || is(e, "Animal") || is(e, "Cart")) && !inRoom(f.room, f.x, f.y)) out.push(`${e.type} ${String(f.charId ?? f.animalId ?? f.cartId ?? "")}: ${String(f.x)},${String(f.y)} outside ${String(f.room)}`);
			if (is(e, "Item") && !(f.x === -1 && f.y === -1) && !inRoom(f.location, f.x, f.y)) out.push(`item ${String(f.itemId)}: ${String(f.x)},${String(f.y)} outside ${String(f.location)}`);
			if (is(e, "Bed")) {
				const b = f as unknown as BedFields, seen = new Set<string>();
				for (const p of b.plants) {
					if (!inArea(b, p)) out.push(`bed ${b.bedId}: a plant at ${p.x},${p.y} outside it`);
					if (seen.has(`${p.x},${p.y}`)) out.push(`bed ${b.bedId}: two plants at ${p.x},${p.y}`);
					seen.add(`${p.x},${p.y}`);
				}
				if (b.plants.length > bedCapacity(b)) out.push(`bed ${b.bedId}: ${b.plants.length} plants, room for ${bedCapacity(b)}`);
			}
			if (is(e, "Route")) {
				const r = f as unknown as RouteFields;
				r.cells.forEach((c, i) => { const p = r.cells[i - 1]; if (p && p.room === c.room && Math.abs(c.x - p.x) + Math.abs(c.y - p.y) !== 1) out.push(`road ${r.routeId}: ${p.x},${p.y} and ${c.x},${c.y} in ${c.room} are no neighbours`); });
			}
		}
		return out;
	} finally { useGridScale(was); }
}

/** The definitions at both scales of the world `id` (worlds/<id>/world.json and world-scale2.json, as world:json writes them). */
export function definitions(id = process.env.SPACES_MMO_WORLD || "leuchtfeuer"): Defs {
	const read = (s: number) => JSON.parse(readFileSync(join(import.meta.dirname, "..", "worlds", id, worldFile(s)), "utf8")) as WorldDef;
	return { one: read(FROM), two: read(TO) };
}

/** A canonical text of an entry's fields (keys sorted), to compare what was written with the plan. */
function canon(v: unknown): string {
	if (Array.isArray(v)) return `[${v.map(canon).join(",")}]`;
	if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Record<string, unknown>)[k])}`).join(",")}}`;
	return JSON.stringify(v);
}

async function inTxn<T>(space: SpaceLike, f: (txn: string) => Promise<T>): Promise<T> {
	const txn = (await space.createTransaction(TXN_MS)).id;
	try {
		// the coordinate migration's lock (room-growth.ts pinTerrain): no command or job runs beside it
		if (!(await space.takeIfExists(WORLD_LOCK, NO_WAIT, { txn }))) throw new Error("WORLD_LOCK is held or not there: is the world (or another writer) running? stop it and run the migration again from the backup");
		const v = await f(txn);
		await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, txn, FOREVER);
		await space.commit(txn);
		return v;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

export async function migrateGrid(space: SpaceLike, o: { check?: boolean; defs?: Defs; log?: (line: string) => void } = {}): Promise<GridMigrationResult> {
	const log = o.log ?? (() => {});
	const defs = o.defs ?? definitions();
	const result = (outcome: GridMigrationResult["outcome"], report: string[], more: Partial<GridMigrationResult> = {}): GridMigrationResult => ({ outcome, report, notes: [], changed: 0, dropped: 0, ...more });
	if ((defs.one.gridScale ?? 1) !== FROM || (defs.two.gridScale ?? 1) !== TO || defs.two.derivedFrom !== FROM || defs.one.id !== defs.two.id) return result("refused", [`the definitions are not of one world at gridScale ${FROM} and ${TO} derived from it`]);
	const entries = (await space.readAll({})) as unknown as E[];
	const markers = entries.filter((e) => is(e, "GridFormat")).map((e) => e.fields as unknown as GridFormatFields);
	if (markers.length > 1) return result("refused", [`the store holds ${markers.length} GridFormat entries; it is damaged, restore it from its backup`]);
	const m = markers[0];
	if (!m) return result("refused", ["the store has no GridFormat entry (the legacy format): run the footprint migration first (npm --prefix spaces-mmo run migrate:footprints)"]);
	if (m.worldId !== defs.one.id) return result("refused", [`the store's grid format is of the world ${m.worldId}, not ${defs.one.id}`]);
	if (m.occupancy !== SUPPORTED_OCCUPANCY) return result("refused", [`the store is in occupancy ${m.occupancy}: run the footprint migration first`]);
	if (m.gridScale === TO && m.state === "running") return result("refused", [`a grid migration of this store was cut off (GridFormat gridScale ${TO} running): restore the store from its backup and run the migration again`]);
	if (m.gridScale === TO) return result("already", checkAtScale(entries));
	if (m.gridScale !== FROM) return result("refused", [`the store is at gridScale ${m.gridScale}: this migration goes from ${FROM} to ${TO}`]);
	if (m.state !== "complete") return result("refused", ["the footprint migration of this store has not finished (GridFormat running): restore it from its backup and run both again"]);

	const before = storeOccupancyReport(entries, { rooms: "required" });
	const plan = planGridMigration(entries, defs);
	const changed = new Map(plan.changes.filter((c) => c.from.id).map((c) => [c.from.id, c.to] as const));
	const after = [...entries.filter((e) => !changed.has(e.id)), ...plan.changes.flatMap((c) => (c.to ? [c.to] : []))];
	const found = [...before.map((l) => `at scale ${FROM}: ${l}`), ...plan.refusals, ...checkAtScale(after)];
	const counts = { notes: plan.notes, changed: plan.changes.filter((c) => c.to).length, dropped: plan.changes.filter((c) => !c.to).length };
	if (o.check) return result("checked", found, counts);
	if (found.length) return result("refused", found, counts);

	// the marker first: from here on the store is refused by every binary until the last step has written "complete"
	await inTxn(space, async (txn) => {
		const e = await space.takeIfExists({ type: "GridFormat" }, NO_WAIT, { txn });
		if (!e) throw new Error("the GridFormat entry is gone or held: is another migration running?");
		await space.write({ type: "GridFormat", fields: { ...m, gridScale: TO, derivedFrom: FROM, state: "running" } satisfies GridFormatFields as never }, txn, FOREVER);
	});
	log(`[migrate-grid] ${m.worldId}: GridFormat gridScale ${TO} running`);

	// a room on its own (its terrain is the largest entry), a road with its parts, the rest in batches
	const groups: Change[][] = [];
	let batch: Change[] = [], bytes = 0;
	const flush = () => { if (batch.length) groups.push(batch); batch = []; bytes = 0; };
	const roads = new Map<string, Change[]>();
	for (const c of plan.changes) {
		const routeId = is(c.from, "Route") || is(c.from, "Road") || is(c.from, "RoadCells") ? String((c.to ?? c.from).fields.routeId) : null;
		if (routeId) { roads.set(routeId, [...roads.get(routeId) ?? [], c]); continue; }
		if (is(c.from, "Room")) { groups.push([c]); continue; }
		const n = c.to ? JSON.stringify(c.to.fields).length : 0;
		if (batch.length >= BATCH_ENTRIES || bytes + n > BATCH_BYTES) flush();
		batch.push(c); bytes += n;
	}
	flush();
	groups.push(...roads.values());
	let written = 0;
	for (const g of groups) await inTxn(space, async (txn) => {
		for (const c of g) if (c.from.id && !(await space.takeIfExists({ id: c.from.id }, NO_WAIT, { txn }))) throw new Error(`${c.from.type} ${c.from.id} is gone or held: is a writer running? restore the backup and run the migration again`);
		for (const c of g) {
			if (!c.to) continue;
			const types = c.from.id ? c.to.types.slice(1) : [];
			await space.write({ type: c.to.type, ...(types.length ? { types } : {}), fields: c.to.fields as never }, txn, FOREVER, is(c.to, "Spot") ? { unique: ["room", "x", "y"] } : {});
			written++;
		}
	});
	log(`[migrate-grid] ${written} entries written in ${groups.length} transactions, ${counts.dropped} taken`);

	// read back: every entry with cells is what the plan says, and the store passes the check at scale S
	const now = (await space.readAll({})) as unknown as E[];
	const kinds = (es: readonly E[]) => es.filter((e) => { const row = classRow(e.type, defs.one.typeclasses); return row && Object.keys(GRID_CLASSES[row] ?? {}).length && !TEXT[row]; }).map((e) => `${e.type} ${canon(e.fields)}`).sort();
	const want = kinds(after), got = kinds(now);
	const differ = [...want.filter((x, i) => got[i] !== x).slice(0, 5).map((x) => `expected ${x.slice(0, 200)}`), ...(want.length !== got.length ? [`${want.length} entries with cells expected, ${got.length} found`] : [])];
	if (now.some((e) => is(e, "NpcMemory"))) differ.push("NpcMemory entries left");
	const left = checkAtScale(now);
	if (differ.length || left.length) throw new Error(`the migrated store differs (the GridFormat entry stays "running"; restore the backup):\n  ${[...differ, ...left].slice(0, 40).join("\n  ")}`);
	await inTxn(space, async (txn) => {
		const e = await space.takeIfExists({ type: "GridFormat" }, NO_WAIT, { txn });
		if (!e) throw new Error("the GridFormat entry is gone or held: is another migration running?");
		await space.write({ type: "GridFormat", fields: { ...(e.fields as unknown as GridFormatFields), state: "complete" } as never }, txn, FOREVER);
	});
	log(`[migrate-grid] ${m.worldId}: GridFormat gridScale ${TO} complete`);
	return result("migrated", [], counts);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const args = process.argv.slice(2), flag = (n: string) => args.includes(n);
	const at = args.indexOf("--space"), address = at >= 0 ? args[at + 1] : undefined;
	if (!address) { console.error("usage: npm run migrate:grid -- --space <address> [--check]"); process.exit(2); }
	const { connectSpace } = await import("../server/space.ts");
	const { space, close } = connectSpace(address, { callTimeoutMs: 120_000 });
	try {
		const r = await migrateGrid(space, { check: flag("--check"), log: (l) => console.log(l) });
		console.log(`[migrate-grid] ${r.outcome}: ${r.changed} entries changed, ${r.dropped} taken`);
		for (const l of r.notes.slice(0, 50)) console.log(`  note: ${l}`);
		for (const l of r.report.slice(0, 200)) console.log(`  ${l}`);
		if (r.report.length > 200) console.log(`  … ${r.report.length - 200} more`);
		process.exitCode = r.outcome === "refused" || r.report.length ? 1 : 0;
	} finally { close(); }
}
