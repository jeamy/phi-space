// Who stands where (docs/evennia-abbildung.md, "Stand Phase 2"): two characters never share a cell. Only characters
// that are online (a live Session) occupy their cell; an offline one is not on the map and blocks nobody. Every change
// of a position happens under the room's token (model.ts, roomToken), so the check and the step cannot interleave
// with another worker's.
import { FOREVER, type SpaceLike } from "phi-spaces";
import { fieldsOf, roomToken, type CharacterFields, type SessionFields } from "../model.ts";
import { walkable, type WorldDef } from "./world.ts";

type Cell = { x: number; y: number };
export const cellKey = (c: Cell) => `${c.x},${c.y}`;

/** The cells of `room` that online characters other than `except` stand on, with their names. */
export async function occupiedIn(space: SpaceLike, room: string, except?: string): Promise<Map<string, string>> {
	const live = new Set((await space.readAll({ type: "Session" })).map((s) => fieldsOf<SessionFields>(s).charId));
	const out = new Map<string, string>();
	for (const e of await space.readAll({ type: "Character", fields: { room } })) {
		const ch = fieldsOf<CharacterFields>(e);
		if (ch.charId !== except && live.has(ch.charId)) out.set(cellKey(ch), ch.name);
	}
	return out;
}

/** Cells nobody may stand on, whoever is online: the beacons of `room` (one does not walk into a fire). */
export async function solidIn(space: SpaceLike, room: string): Promise<Set<string>> {
	return new Set((await space.readAll({ type: "Beacon", fields: { room } })).map((e) => cellKey({ x: Number(e.fields.x), y: Number(e.fields.y) })));
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

/** Takes the room's token in `txn` (waiting up to `ms` while another command holds it). The caller writes it back
 *  (`release`) before committing. Null when it stayed taken. */
export async function holdRoom(space: SpaceLike, txn: string, room: string, ms = 5_000): Promise<{ release: () => Promise<void> } | null> {
	const t = await space.take(roomToken(room), ms, { txn });
	if (!t) return null;
	return { release: async () => { await space.write(roomToken(room), txn, FOREVER); } };
}
