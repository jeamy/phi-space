// Who stands where (docs/evennia-abbildung.md, "Stand Phase 2"): two characters never share a cell. A character that is
// online holds its cell as a Spot entry (model.ts), written with the space's `unique` check on room and cell: the
// space refuses a second Spot on a cell even while the first is only written in an open transaction, so a step needs
// no lock on its room and steps in one room run side by side. Only online characters (a live Session) block a cell;
// the Spot of one that went offline is taken over by whoever steps there, and the world worker sweeps the rest.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type SessionFields, type SpotFields } from "../model.ts";
import { peek } from "../space.ts";
import { walkable, type WorldDef } from "./world.ts";

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

/** Cells nobody may stand on, whoever is online: the beacons of `room` (one does not walk into a fire). Beacons stand
 *  where the world definition puts them. */
export function solidIn(w: WorldDef, room: string): Set<string> {
	return new Set(w.beacons.filter((b) => b.room === room).map((b) => cellKey(b)));
}

/** The nearest walkable cell to `at` (itself first) that is not in `avoid`, searching outwards; null when there is
 *  none within `radius`. */
export function freeCellNear(w: WorldDef, ground: string[], at: Cell, avoid: ReadonlySet<string> | ReadonlyMap<string, unknown>, radius = 8): Cell | null {
	const seen = new Set<string>([cellKey(at)]);
	let ring: Cell[] = [at];
	for (let r = 0; r <= radius && ring.length; r++) {
		for (const c of ring) if (walkable(w, ground, c.x, c.y) && !avoid.has(cellKey(c))) return c;
		const next: Cell[] = [];
		for (const c of ring) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const n = { x: c.x + dx, y: c.y + dy };
			if (!seen.has(cellKey(n)) && n.y >= 0 && n.y < ground.length && n.x >= 0 && n.x < (ground[0]?.length ?? 0)) { seen.add(cellKey(n)); next.push(n); }
		}
		ring = next;
	}
	return null;
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
