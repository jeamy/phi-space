// Full rooms gain land at an edge or at a safe seam before the coast. Geometry and positions commit together.
import { holdIsland, holdRoomVersion, lockVersion, roomLock } from "../room-lock.ts";
import { FOREVER, NO_WAIT, type SpaceLike, type Taken, type Template } from "phi-spaces";
import { fieldsOf, WORLD_LOCK, type ExitFields, type FootprintFields, type RoomFields, type RoomGrowthFields, type RoomGrowthStep } from "../../model.ts";
import { msgOptions } from "../context.ts";
import { PATH } from "./build.ts";
import { footprintCells, isPassage } from "../occupancy.ts";
import { grownPoint, insertStrip } from "../room-growth.ts";
import { walkable, type WorldDef } from "../world.ts";
import { timeNow } from "../source.ts";
import { areaCells, components, gridOf, type Area } from "../../../shared/grid.ts";
import { isInterior } from "./interior.ts";
export { grownGround, grownDecor } from "../room-growth.ts";

const POSITIONED = ["Character", "Spot", "Beacon", "Cart", "Site", "Building", "Ruin", "Bed", "Field", "Scenery", "MillLoad", "SiteOrder", "Footprint", "Zone", "Motion", "Animal", "Tree"];
/** The cells of the footprints among `entries` (model.ts FootprintFields). */
const claimed = (entries: Taken[]) => entries.filter((e) => is(e, "Footprint")).flatMap((e) => footprintCells(e.fields as unknown as FootprintFields).map((c) => `${c.x},${c.y}`));
const is = (e: Taken, type: string) => e.types.includes(type);
type Rect = { x: number; y: number; w?: number; h?: number };
const crosses = (r: Rect, s: RoomGrowthStep) => r[s.axis] < s.at && r[s.axis] + (s.axis === "x" ? r.w ?? 1 : r.h ?? 1) > s.at;

/** Candidates prefer east, then south, and the outermost safe seam. The water and beach themselves are retained. */
function* candidates(w: WorldDef, room: RoomFields, exits: Array<{ x: number; y: number }>): Generator<RoomGrowthStep> {
	const d = w.growth!, width = room.ground[0]!.length, height = room.ground.length;
	for (const axis of ["x", "y"] as const) {
		const length = axis === "x" ? width : height, across = axis === "x" ? height : width;
		if (length + d.strip > (axis === "x" ? d.maxW : d.maxH)) continue;
		const cell = (along: number, cross: number) => axis === "x" ? room.ground[cross]![along]! : room.ground[along]![cross]!;
		const nearExit = exits.some((e) => e[axis] >= length - 2);
		for (let at = nearExit ? length - 2 : length; at >= Math.ceil(length / 2); at--) {
			// Appending requires a grassy edge. Insertion uses the land just before a coast or a boundary exit.
			const fill = Array.from({ length: across }, (_, i) => {
				const a = cell(at - 1, i), b = at < length ? cell(at, i) : a;
				if (a === PATH || b === PATH) return PATH;
				if (a === d.tile || b === d.tile) return d.tile;
				return a;
			});
			if (fill.filter((t) => t === d.tile).length * 2 < across) continue;
			yield { axis, at, size: d.strip, fill };
		}
	}
}

/** Geometry-only preview; growthTick also checks footprints and global reachability. */
export function freeSide(w: WorldDef, room: RoomFields, exits: Array<{ x: number; y: number }>): "east" | "south" | null {
	const s = candidates(w, room, exits).next().value;
	return s ? s.axis === "x" ? "east" : "south" : null;
}

/** The seams of one room, checked against its free cells (not walkable land, a plot or a fire is not free): a seam is safe
 *  when every row of the new strip that is building land (grass or path) joins the part of the room its start cell
 *  (the spawn, else the first free cell) lies in. One labelling of the room's parts serves every seam; a seam then looks
 *  only at the cells on both sides of it (plan section 3, growth step 1).
 *
 *  Why that is all: a strip row takes grass or path where either neighbour has it, else the left neighbour's land, so
 *  where both cells beside a seam were free the strip between them is walkable, and every way that crossed the seam still
 *  crosses it. What was reachable stays reachable; only the new land has to join it. tests/growth-seams.test.ts holds
 *  this against the two searches over the grown room it replaced. */
export function seamCheck(w: WorldDef, room: RoomFields, entries: Taken[]): (s: RoomGrowthStep) => boolean {
	const ground = room.ground, width = ground[0]?.length ?? 0, height = ground.length;
	const blocked = new Set([...entries.filter((e) => is(e, "Beacon")).flatMap((e) => areaCells(e.fields as unknown as Area).map((c) => `${c.x},${c.y}`)), ...claimed(entries)]);
	const grid = gridOf(width, height, (x, y) => walkable(w, ground, x, y) && !blocked.has(`${x},${y}`));
	let start = room.spawn && walkable(w, ground, room.spawn.x, room.spawn.y) && !blocked.has(`${room.spawn.x},${room.spawn.y}`) ? room.spawn : undefined;
	if (!start) { const first = grid.open.indexOf(1); if (first >= 0) start = { x: first % width, y: Math.floor(first / width) }; }
	if (!start) return () => false;
	const label = components(grid), home = label[start.y * width + start.x]!;
	return (s) => {
		const length = s.axis === "x" ? width : height;
		const at = (along: number, i: number) => along < 0 || along >= length ? -1 : s.axis === "x" ? label[i * width + along]! : label[along * width + i]!;
		// the strip's walkable rows in runs; each run joins the parts on both sides of the seam beside it
		const parent = new Map<number, number>(), find = (l: number): number => { let r = l; while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!; return r; };
		const runs: Array<{ labels: number[]; land: boolean }> = [];
		let run: { labels: number[]; land: boolean } | null = null;
		for (let i = 0; i < s.fill.length; i++) {
			const tile = s.fill[i]!;
			if (!w.tiles[tile]?.walk) { run = null; continue; }
			if (!run) { run = { labels: [], land: false }; runs.push(run); }
			if (tile === w.growth!.tile || tile === PATH) run.land = true;
			for (const l of [at(s.at - 1, i), at(s.at, i)]) if (l >= 0) run.labels.push(l);
		}
		for (const r of runs) for (const l of r.labels.slice(1)) { const a = find(r.labels[0]!), b = find(l); if (a !== b) parent.set(b, a); }
		return runs.every((r) => !r.land || r.labels.some((l) => find(l) === find(home)));
	};
}

/** Changes only absolute coordinates. Bed plants, room overview slots and carried items keep their local coordinates. */
function moved(e: Taken, room: string, before: RoomGrowthFields, step: RoomGrowthStep): Taken["fields"] {
	const f = structuredClone(e.fields) as Taken["fields"] & { room?: string; location?: string; destination?: string; x?: number; y?: number; zone?: Rect; arrive?: { x: number; y: number }; arriveGrowthRevision?: number }, g = { east: 0, south: 0, steps: [step] };
	if ((f.room === room || (is(e, "Item") || is(e, "Exit")) && f.location === room) && typeof f.x === "number" && typeof f.y === "number") Object.assign(f, grownPoint({ x: f.x, y: f.y }, g));
	if (is(e, "Motion") && f.room === room && f.zone) f.zone = grownPoint(f.zone, g);
	if (is(e, "Exit") && f.destination === room && f.arrive) {
		f.arrive = grownPoint(grownPoint(f.arrive, before, f.arriveGrowthRevision ?? 0), g);
		f.arriveGrowthRevision = (before.steps?.length ?? 0) + 1;
	}
	return f as Taken["fields"];
}

/** The rectangles a seam may not cross: what has a rectangle in the room, and a Motion's zone. */
const rectanglesOf = (roomId: string, entries: Taken[]): Rect[] => entries.filter((x) => x.fields.room === roomId).flatMap((x) => is(x, "Motion") && x.fields.zone ? [x.fields.zone as unknown as Rect] : typeof x.fields.w === "number" && typeof x.fields.h === "number" ? [x.fields as unknown as Rect] : []);

/** What growth decides for a room from its entries (the room's positioned entries and its exits): the step, or null
 *  (too little land taken, no candidate, none that crosses no rectangle and keeps the room joined). */
export function growthStep(w: WorldDef, room: RoomFields, entries: Taken[]): RoomGrowthStep | null {
	const d = w.growth!, exits = entries.filter((x) => is(x, "Exit") && x.fields.location === room.roomId).map(fieldsOf<ExitFields>);
	const land = new Set<string>();
	room.ground.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (walkable(w, room.ground, x, y) && row[x] !== PATH && !isPassage(exits, { x, y })) land.add(`${x},${y}`); });
	const occupied = new Set(claimed(entries).filter((key) => land.has(key)));
	if (!land.size || occupied.size < land.size * d.fullShare) return null;
	const rectangles = rectanglesOf(room.roomId, entries);
	const safe = seamCheck(w, room, entries);
	return [...candidates(w, room, exits)].find((s) => !rectangles.some((r) => crosses(r, s)) && safe(s)) ?? null;
}

/** Everything growthStep reads of a room, as one text (plan section 3, growth step 2): the room's lock version (every
 *  holder counts it up), the Room entry (rewritten whenever its ground or spawn changes), and, as values, what is
 *  written without the lock and what a test may write by hand: every rectangle, the footprints, the fires and the
 *  exits. Equal texts give the same decision, so a room that grew no step keeps its text and costs a comparison. */
export function growthKey(roomEntry: Taken, version: number, entries: Taken[]): string {
	const roomId = String(roomEntry.fields.roomId), parts: string[] = [];
	for (const e of entries) {
		const f = e.fields;
		if (is(e, "Beacon")) parts.push(`b${f.x},${f.y}`);
		else if (is(e, "Exit")) parts.push(`e${f.x},${f.y}`);
		if (f.room === roomId && is(e, "Motion") && f.zone) { const z = f.zone as unknown as Rect; parts.push(`z${z.x},${z.y},${z.w},${z.h}`); }
		else if (f.room === roomId && typeof f.w === "number" && typeof f.h === "number") parts.push(`${is(e, "Footprint") ? "f" : "r"}${f.x},${f.y},${f.w},${f.h}`);
	}
	return `${version} ${roomEntry.id} ${parts.sort().join(" ")}`;
}

/** What growth reads before it takes a lock: the process's copy of the world (server/space.ts Mirror; `fresh` waits
 *  until it holds what the space has committed), or the space outside a transaction. */
export type GrowthView = { readAll(tmpl: Template): Taken[] | Promise<Taken[]>; fresh?(): Promise<void> };
/** Per space, the key (growthKey) of each room whose last decision was no step. */
const noStep = new WeakMap<object, Map<string, string>>();

/** A busy world defers growth; a room and every displaced position change in one transaction under the world lock.
 *  A room is decided first on `view`, without a lock (plan section 3, growth step 3): one held by another transaction
 *  (its lock not visible), one whose decision is kept (growthKey) and one with no step are passed over without taking
 *  anything. Only a room with a step takes the locks; there its lock's version must still be the one the view showed
 *  (else it changed since: left to the next run), and the decision is made again on what the transaction reads. */
export async function growthTick(space: SpaceLike, w: WorldDef, leaseMs: number, view: GrowthView = space): Promise<number> {
	const d = w.growth;
	if (!d) return 0;
	if (!Number.isInteger(d.strip) || d.strip < 1) throw new RangeError("growth.strip must be a positive integer");
	let kept = noStep.get(space);
	if (!kept) noStep.set(space, (kept = new Map()));
	await view.fresh?.();
	let grew = 0;
	for (const entry of await view.readAll({ type: "Room" })) {
		if (isInterior(String(entry.fields.roomId))) continue; // a building's inside keeps its walls
		const roomId = String(entry.fields.roomId);
		const lock = (await view.readAll(roomLock(roomId)))[0];
		if (!lock) continue; // held right now
		const seen = (await Promise.all([...POSITIONED.map((type) => view.readAll({ type, fields: { room: roomId } })), view.readAll({ type: "Exit", fields: { location: roomId } })])).flat();
		const key = growthKey(entry, lockVersion(lock.fields), seen);
		if (kept.get(roomId) === key) continue;
		if (!growthStep(w, fieldsOf<RoomFields>(entry), seen)) { kept.set(roomId, key); continue; }
		kept.delete(roomId);
		const txn = (await space.createTransaction(30_000)).id;
		try {
			if (!(await space.takeIfExists(WORLD_LOCK, NO_WAIT, { txn }))) { await space.abort(txn); break; }
			// the island's lock after WORLD_LOCK, then the room's (room-lock.ts): a job that holds only the room's lock (a
			// jetty moved, a sweep) and no WORLD_LOCK would otherwise write a footprint where the room is shifting
			const island = entry.fields.island;
			if (typeof island === "string" && !(await holdIsland(space, txn, island, [], NO_WAIT))) { await space.abort(txn); continue; }
			if ((await holdRoomVersion(space, txn, roomId, NO_WAIT)) !== lockVersion(lock.fields)) { await space.abort(txn); continue; }
			const e = await space.takeIfExists({ id: entry.id }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); continue; }
			const room = fieldsOf<RoomFields>(e);
			const groups = await Promise.all([
				...POSITIONED.map((type) => space.readAll({ type, fields: { room: room.roomId } }, { txn })),
				space.readAll({ type: "Item", fields: { location: room.roomId } }, { txn }),
				space.readAll({ type: "Exit" }, { txn }),
			]);
			const entries = groups.flat();
			const step = growthStep(w, room, entries);
			if (!step) { await space.abort(txn); continue; }
			const was = await space.takeIfExists({ type: "RoomGrowth", fields: { roomId: room.roomId } }, NO_WAIT, { txn });
			const before: RoomGrowthFields = was ? fieldsOf<RoomGrowthFields>(was) : { roomId: room.roomId, east: 0, south: 0 };
			const after: RoomGrowthFields = { ...before, east: before.east + (step.axis === "x" ? step.size : 0), south: before.south + (step.axis === "y" ? step.size : 0), steps: [...before.steps ?? [], step], baseWidth: before.baseWidth ?? room.ground[0]!.length - before.east, baseHeight: before.baseHeight ?? room.ground.length - before.south };
			const changes = entries.map((x) => ({ e: x, fields: moved(x, room.roomId, before, step) })).filter((x) => JSON.stringify(x.fields) !== JSON.stringify(x.e.fields));
			let busy = false;
			for (const change of changes) if (!(await space.takeIfExists({ id: change.e.id }, NO_WAIT, { txn }))) { busy = true; break; }
			if (busy) { await space.abort(txn); continue; }
			for (const { e: old, fields } of changes) await space.write({ type: old.type, types: old.types.slice(1), fields }, txn, FOREVER, is(old, "Spot") ? { unique: ["room", "x", "y"] } : {});
			await space.write({ type: "RoomGrowth", fields: after as never }, txn, FOREVER);
			const g = { east: 0, south: 0, steps: [step] };
			await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, ground: insertStrip(room.ground, step), ...(room.decor ? { decor: insertStrip(room.decor, step, true) } : {}), ...(room.spawn ? { spawn: grownPoint(room.spawn, g) } : {}) } as never }, txn, FOREVER);
			await space.write({ type: "Msg", fields: { room: room.roomId, to: "*", kind: "world", text: `${room.name} wächst: Im ${step.axis === "x" ? "Osten" : "Süden"} ist neues Land frei.`, from: "", at: timeNow() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, txn, FOREVER);
			await space.commit(txn);
			grew++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return grew;
}

/** Forgets the decisions growth kept for `space` (tests: the same runs without what was kept). */
export const forgetGrowth = (space: SpaceLike): void => { noStep.delete(space); };
