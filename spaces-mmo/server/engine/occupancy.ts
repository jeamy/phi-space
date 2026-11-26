// Who stands where (docs/evennia-abbildung.en.md, "Stand Phase 2"): two characters never share a cell. A character that is
// online holds its cell as a Spot entry (model.ts), written with the space's `unique` check on room and cell: the
// space refuses a second Spot on a cell even while the first is only written in an open transaction, so a step needs
// no lock on its room and steps in one room run side by side. Only online characters (a live Session) block a cell;
// the Spot of one that went offline is taken over by whoever steps there, and the world worker sweeps the rest.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type FootprintFields, type SessionFields, type SpotFields } from "../model.ts";
import { peek } from "../space.ts";
import { walkable, type WorldDef } from "./world.ts";
import { areaCells, distToArea, nearestOpen, type Area } from "../../shared/grid.ts";
import { PASSAGE } from "../../shared/rules.ts";

type Cell = { x: number; y: number };
export const cellKey = (c: Cell) => `${c.x},${c.y}`;

/** The characters that are online now (a live Session). */
export async function onlineIds(space: SpaceLike): Promise<Set<string>> {
	return new Set((await space.readAll({ type: "Session" })).map((s) => fieldsOf<SessionFields>(s).charId));
}

/** The cells of `room` that online characters other than `except` stand on, with their names. */
export async function occupiedIn(space: SpaceLike, room: string, except?: string): Promise<Map<string, string>> {
	const live = await onlineIds(space);
	const out = new Map<string, string>();
	for (const e of await space.readAll({ type: "Spot", fields: { room } })) {
		const s = fieldsOf<SpotFields>(e);
		if (s.charId !== except && live.has(s.charId)) out.set(cellKey(s), s.name);
	}
	return out;
}

/** A passage: an exit's cell (one of its area) or one next to it (where one arrives and from where one leaves). Nobody holds such a cell:
 *  several stand on it and walk through each other, so a crowd at a door does not close the way (arrow keys walk only
 *  cell by cell, they cannot go round). */
export function isPassage(exits: ReadonlyArray<Area>, cell: { x: number; y: number }): boolean {
	return exits.some((e) => distToArea(cell, e) <= PASSAGE);
}

/** Leaves the character's cell without taking another (it stands on a passage now). */
export async function releaseSpot(space: SpaceLike, txn: string, charId: string): Promise<void> {
	await space.takeIfExists({ type: "Spot", fields: { charId } }, NO_WAIT, { txn });
}

/** The Footprint entry of an object (model.ts FootprintFields). */
export const footprint = (room: string, of: string, r: { x: number; y: number; w?: number; h?: number }): FootprintFields => ({ room, of, x: r.x, y: r.y, w: r.w ?? 1, h: r.h ?? 1 });
/** The cells of a footprint, row by row. */
export function footprintCells(f: { x: number; y: number; w: number; h: number }): Cell[] {
	const out: Cell[] = [];
	for (let y = f.y; y < f.y + f.h; y++) for (let x = f.x; x < f.x + f.w; x++) out.push({ x, y });
	return out;
}
/** Writes an object's footprint, in a transaction that holds its room's lock (room-lock.ts; `unique` on room and `of`:
 *  an object has one). `moved`: its old one was taken in this transaction (a footprint taken there still holds its
 *  place for `unique` until the commit), so it is written without; the stack and walk checks hold one per object. */
export async function writeFootprint(space: SpaceLike, txn: string, f: FootprintFields, moved = false): Promise<void> {
	await space.write({ type: "Footprint", fields: f as never }, txn, FOREVER, moved ? {} : { unique: ["room", "of"] });
}
/** Takes an object's footprint, in a transaction that holds its room's lock; null: it has none. */
export async function takeFootprint(space: SpaceLike, txn: string, room: string, of: string): Promise<FootprintFields | null> {
	const e = await space.takeIfExists({ type: "Footprint", fields: { room, of } }, NO_WAIT, { txn });
	return e ? fieldsOf<FootprintFields>(e) : null;
}
/** The footprints of a room. `txn`: as the space holds them now, read inside a transaction that holds the room's lock;
 *  without, from the process's copy. */
export async function footprintsIn(space: SpaceLike, room: string, txn: string | null = null): Promise<FootprintFields[]> {
	return (await space.readAll({ type: "Footprint", fields: { room } }, txn ? { txn } : {})).map((e) => fieldsOf<FootprintFields>(e));
}
/** Every cell of a room an object stands on, with the object's ID (the first footprint keeps a cell). */
export async function claimedIn(space: SpaceLike, room: string, txn: string | null = null): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (const f of await footprintsIn(space, room, txn)) for (const c of footprintCells(f)) if (!out.has(cellKey(c))) out.set(cellKey(c), f.of);
	return out;
}

/** Cells nobody walks onto: persisted fires (their areas) and the cells objects stand on. `txn`: the footprints as the space holds
 *  them now, read inside a transaction that holds the room's lock (room-lock.ts; the fires stay read from the copy: a
 *  read in the transaction would keep their own changes waiting). */
export async function blockedIn(space: SpaceLike, _w: WorldDef, room: string, txn: string | null = null): Promise<Set<string>> {
	const out = new Set((await space.readAll({ type: "Beacon", fields: { room } })).flatMap((e) => areaCells(e.fields as unknown as Area).map(cellKey)));
	for (const k of (await claimedIn(space, room, txn)).keys()) out.add(k);
	return out;
}

/** The nearest walkable cell to `at` (itself first) that is not in `avoid`, searching outwards; null when there is
 *  none within `radius`. */
export function freeCellNear(w: WorldDef, ground: string[], at: Cell, avoid: ReadonlySet<string> | ReadonlyMap<string, unknown>, radius: number): Cell | null {
	// it ends after a few rings as a rule, so it looks only at the cells it reaches, not at the whole room's grid: those
	// marked by their index (shared/grid.ts), each checked as it comes
	return nearestOpen({ w: ground[0]?.length ?? 0, h: ground.length }, at, radius, (c) => walkable(w, ground, c.x, c.y) && !avoid.has(cellKey(c)));
}

const UNIQUE = ["room", "x", "y"];
const isTaken = (e: unknown) => /unique entry already exists/.test((e as Error)?.message ?? "");

/** In `txn`: `who` stands on `to` from now on. Its Spot moves there (its old one, if any, is taken). Returns null, or
 *  the name of the one who stands there (refused; nothing changed): an online character, or one whose move onto the
 *  cell is not committed yet ("jemand"). The Spot of an offline character there is taken over. */
export async function claimSpot(space: SpaceLike, txn: string, who: { charId: string; name: string }, to: { room: string; x: number; y: number }): Promise<string | null> {
	const old = await peek(space, { type: "Spot", fields: { charId: who.charId } }, { txn });
	if (old && old.fields.room === to.room && old.fields.x === to.x && old.fields.y === to.y) return null; // already there
	const spot: SpotFields = { room: to.room, x: to.x, y: to.y, charId: who.charId, name: who.name };
	try {
		await space.write({ type: "Spot", fields: spot as never }, txn, FOREVER, { unique: UNIQUE });
	} catch (e) {
		if (!isTaken(e)) throw e;
		const there = await peek(space, { type: "Spot", fields: { room: to.room, x: to.x, y: to.y } });
		if (!there) return "jemand"; // held by an open transaction: someone is stepping there right now
		const s = fieldsOf<SpotFields>(there);
		if ((await space.readAll({ type: "Session", fields: { charId: s.charId } }, { limit: 1 })).length) return s.name;
		// offline: the cell is free; its old Spot is taken here, and the new one replaces it (a reserved entry keeps
		// every other unique write off the cell until this transaction ends)
		if (!(await space.takeIfExists({ type: "Spot", id: there.id }, NO_WAIT, { txn }))) return "jemand";
		await space.write({ type: "Spot", fields: spot as never }, txn, FOREVER);
	}
	if (old) await space.takeIfExists({ type: "Spot", id: old.id }, NO_WAIT, { txn });
	return null;
}

/** Takes the Spots of characters that are not online (the world worker, now and then): they block nobody, but every
 *  read of a room's Spots would read them. */
export async function sweepSpots(space: SpaceLike): Promise<number> {
	const live = await onlineIds(space);
	let n = 0;
	for (const e of await space.readAll({ type: "Spot" })) if (!live.has(String(e.fields.charId)) && (await space.takeIfExists({ type: "Spot", id: e.id }, NO_WAIT))) n++;
	return n;
}
