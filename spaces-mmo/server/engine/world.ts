// What a world brings (docs/architektur.md, "Verzeichnisaufbau"): rooms, the tiles their grids use, the character
// skins and the help text. The engine loads exactly one world (SPACES_MMO_WORLD); a world adds data, never engine rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.ts";

/** A 32×32 cut of a sheet (pixel offsets); `walk`: characters may stand on it. */
export type TileDef = { sheet: string; x: number; y: number; walk: boolean };
/** A character sheet: 4 frames per row, rows down, left, right, up. */
export type SkinDef = { sheet: string; frameW: number; frameH: number };
export type RoomDef = { roomId: string; name: string; desc: string; ground: string[]; spawn: { x: number; y: number } };
export type WorldDef = { id: string; title: string; tileSize: number; tiles: Record<string, TileDef>; skins: SkinDef[]; rooms: RoomDef[]; start: string; help: string[]; guestName: string };

const WORLD_ID = /^[a-z0-9-]{1,40}$/;

/** The world named by SPACES_MMO_WORLD (default leuchtfeuer), checked: every row as wide as the first, every tile key
 *  known, every spawn walkable. */
export async function loadWorld(id = process.env.SPACES_MMO_WORLD || "leuchtfeuer"): Promise<WorldDef> {
	if (!WORLD_ID.test(id)) throw new Error(`SPACES_MMO_WORLD: a-z, 0-9 and -, got ${id}`);
	const w = (await import(join(ROOT, "worlds", id, "world.ts"))).world as WorldDef;
	for (const r of w.rooms) {
		const width = r.ground[0]?.length ?? 0;
		if (!width || r.ground.some((row) => row.length !== width)) throw new Error(`room ${r.roomId}: rows of different width`);
		for (const row of r.ground) for (const k of row) if (!w.tiles[k]) throw new Error(`room ${r.roomId}: unknown tile ${k}`);
		if (!w.tiles[r.ground[r.spawn.y]?.[r.spawn.x] ?? ""]?.walk) throw new Error(`room ${r.roomId}: spawn is not walkable`);
	}
	if (!w.rooms.some((r) => r.roomId === w.start)) throw new Error(`world ${id}: unknown start room ${w.start}`);
	return w;
}

/** A world's asset file (png or md below worlds/<id>/assets), or null for anything else. */
export function worldAsset(id: string, path: string): { body: Buffer; type: string } | null {
	if (!WORLD_ID.test(id) || !/^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*\.(png|md)$/.test(path)) return null;
	try { return { body: readFileSync(join(ROOT, "worlds", id, "assets", path)), type: path.endsWith(".png") ? "image/png" : "text/markdown; charset=utf-8" }; }
	catch { return null; }
}

export const walkable = (w: WorldDef, ground: string[], x: number, y: number): boolean =>
	Number.isInteger(x) && Number.isInteger(y) && y >= 0 && y < ground.length && x >= 0 && x < (ground[0]?.length ?? 0) && !!w.tiles[ground[y]![x]!]?.walk;

/** The shortest walk from one cell to another over walkable cells (4 directions), at most `max` steps; null when there
 *  is none. The cells after the start, the target last. */
export function findPath(w: WorldDef, ground: string[], from: { x: number; y: number }, to: { x: number; y: number }, max = 40): Array<{ x: number; y: number }> | null {
	if (!walkable(w, ground, to.x, to.y)) return null;
	if (from.x === to.x && from.y === to.y) return [];
	const width = ground[0]!.length, key = (x: number, y: number) => y * width + x;
	const prev = new Map<number, number>([[key(from.x, from.y), -1]]);
	let frontier = [from];
	for (let step = 0; step < max && frontier.length; step++) {
		const next: Array<{ x: number; y: number }> = [];
		for (const c of frontier) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const x = c.x + dx, y = c.y + dy, k = key(x, y);
			if (prev.has(k) || !walkable(w, ground, x, y)) continue;
			prev.set(k, key(c.x, c.y));
			if (x === to.x && y === to.y) {
				const path: Array<{ x: number; y: number }> = [];
				for (let at = k; at !== key(from.x, from.y); at = prev.get(at)!) path.unshift({ x: at % width, y: Math.floor(at / width) });
				return path;
			}
			next.push({ x, y });
		}
		frontier = next;
	}
	return null;
}
