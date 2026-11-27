// The worst case of room growth (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3 "Performance strategy",
// acceptance case 6): every room of the largest region at the largest size that still has seams to try, full enough to
// grow, and no seam valid, so the search under the world lock runs every candidate to its end and grows nothing.
//
// A room is all grass, (maxW − strip) × (maxH − strip) cells. Only its upper left part below half its width and height
// is free (the spawn in its corner); everything else is occupied, one 1×1 footprint a cell (the plots of old). Every
// seam lies at or beyond half the room, so the cells on both sides of it are occupied: the strip would be cut off from
// the free part, and `connected` runs both of its searches before it says no. Nothing crosses a seam, so no candidate is dropped before that check.
//
// The sizes follow the world definition (w.growth), so the same fixture serves the finer grid after the switch.
import { FOREVER, type SpaceLike } from "phi-spaces";
import type { WorldDef } from "../server/engine/world.ts";
import { WORLD_LOCK } from "../server/model.ts";
import { regionsOf, regionWorld } from "../server/engine/regions.ts";
import { writeRoomLock } from "../server/engine/room-lock.ts";

/** The ID of the worst case's object on a cell. */
export const worstOf = (x: number, y: number) => `worst-${x}-${y}`;

export type WorstGrowth = { rooms: string[]; width: number; height: number; free: number; plots: number; candidates: number };

/** The rooms of the largest region (all rooms of a world without regions). */
export function largestRegionRooms(w: WorldDef): number {
	const regions = regionsOf(w);
	return regions.length ? Math.max(...regions.map((r) => regionWorld(w, r.regionId).rooms.length)) : w.rooms.length;
}

/** Writes `rooms` worst-case rooms (ids `worst-<i>`) and their plots into `space`. */
export async function writeWorstGrowth(space: SpaceLike, w: WorldDef, rooms = largestRegionRooms(w), prefix = "worst"): Promise<WorstGrowth> {
	const d = w.growth;
	if (!d) throw new Error(`the world ${w.id} does not grow`);
	const width = d.maxW - d.strip, height = d.maxH - d.strip;
	const freeW = Math.ceil(width / 2) - 1, freeH = Math.ceil(height / 2) - 1; // left of and above every seam's cells
	const ground = Array.from({ length: height }, () => d.tile.repeat(width));
	const ids: string[] = [];
	let plots = 0;
	for (let i = 0; i < rooms; i++) {
		const roomId = `${prefix}-${i}`;
		ids.push(roomId);
		await space.write({ type: "Room", fields: { roomId, name: `Engpass ${i}`, desc: "", ground, spawn: { x: 0, y: 0 } } as never }, null, FOREVER);
		await writeRoomLock(space, null, roomId);
		const batch: Promise<unknown>[] = [];
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
			if (x < freeW && y < freeH) continue;
			// one object a cell (the cells of old, one Plot each): a footprint crosses no seam, only the ways decide
			batch.push(space.write({ type: "Footprint", fields: { room: roomId, of: worstOf(x, y), x, y, w: 1, h: 1 } as never }, null, FOREVER));
			if (batch.length >= 256) await Promise.all(batch.splice(0));
		}
		await Promise.all(batch);
		plots = width * height - freeW * freeH;
	}
	// x seams from width down to ceil(width/2), y seams likewise (growth.ts candidates; no exits in these rooms)
	const candidates = (width - Math.ceil(width / 2) + 1) + (height - Math.ceil(height / 2) + 1);
	if (plots < width * height * d.fullShare) throw new Error("the worst case must be full enough to grow");
	return { rooms: ids, width, height, free: freeW * freeH, plots, candidates };
}

/** The space with every hold of the world lock timed: from the take inside a transaction to its commit or abort. */
export function timedLock(space: SpaceLike, holds: number[], refused?: Record<string, number>): SpaceLike {
	const since = new Map<string, number>();
	const end = (txn: string) => { const t = since.get(txn); if (t !== undefined) { holds.push(performance.now() - t); since.delete(txn); } };
	return new Proxy(space, {
		get(target, key, receiver) {
			const f = Reflect.get(target, key, receiver);
			if (typeof f !== "function") return f;
			if (key === "takeIfExists") return async (template: { type?: string }, ms: number, o?: { txn?: string }) => {
				// the hold from when the lock is held: a take that waits (GROWTH_LOCK_WAIT_MS) does not hold it while it waits
				const got = await f.call(target, template, ms, o);
				if (got && o?.txn && template.type === WORLD_LOCK.type) since.set(o.txn, performance.now());
				if (!got && o?.txn && refused) { const k = template.type ?? "entry by id"; refused[k] = (refused[k] ?? 0) + 1; }
				return got;
			};
			if (key === "commit" || key === "abort") return async (txn: string, ...rest: unknown[]) => { try { return await f.call(target, txn, ...rest); } finally { end(txn); } };
			return f.bind(target);
		},
	});
}
