// Persistent coordinate transforms for room growth. Legacy east/south totals remain readable.
import { type SpaceLike } from "phi-spaces";
import { fieldsOf, WORLD_LOCK, type RoomGrowthFields, type RoomGrowthStep } from "../model.ts";
import type { WorldDef } from "./world.ts";

type Growth = Pick<RoomGrowthFields, "east" | "south" | "steps" | "baseWidth" | "baseHeight">;
type Point = { x: number; y: number };

export function grownPoint<T extends Point>(point: T, g: Growth, revision = 0): T {
	const out = { ...point };
	for (const s of (g.steps ?? []).slice(revision)) if (out[s.axis] >= s.at) out[s.axis] += s.size;
	return out;
}

export function insertStrip(ground: string[], s: RoomGrowthStep, decor = false): string[] {
	const width = ground[0]?.length ?? 0, height = ground.length;
	const length = s.axis === "x" ? width : height;
	if (!Number.isInteger(s.at) || s.at < 0 || s.at > length || !Number.isInteger(s.size) || s.size < 1 || s.fill.length !== (s.axis === "x" ? height : width)) throw new Error("room growth does not fit the terrain");
	if (s.axis === "x") return ground.map((row, y) => row.slice(0, s.at) + (decor ? " " : s.fill[y]!).repeat(s.size) + row.slice(s.at));
	const row = decor ? " ".repeat(width) : s.fill.join("");
	return [...ground.slice(0, s.at), ...Array.from({ length: s.size }, () => row), ...ground.slice(s.at)];
}

export function grownGround(ground: string[], g: Growth, tile: string, decor = false): string[] {
	if (g.baseWidth !== undefined && (ground[0]?.length !== g.baseWidth || ground.length !== g.baseHeight)) throw new Error("the world changed the base dimensions of a grown room; an explicit terrain migration is required");
	const east = g.east - (g.steps ?? []).filter((s) => s.axis === "x").reduce((n, s) => n + s.size, 0);
	const south = g.south - (g.steps ?? []).filter((s) => s.axis === "y").reduce((n, s) => n + s.size, 0);
	if (east < 0 || south < 0) throw new Error("inconsistent room growth totals");
	let out = ground.map((row) => row + tile.repeat(east));
	out.push(...Array.from({ length: south }, () => tile.repeat(out[0]!.length)));
	for (const step of g.steps ?? []) out = insertStrip(out, step, decor);
	return out;
}
export const grownDecor = (decor: string[] | undefined, g: Growth) => decor && grownGround(decor, g, " ", true);

/** Shared pin: commands, spawns and jobs may run together, while a coordinate migration needs the exclusive lock. */
export async function pinTerrain(space: SpaceLike, txn: string): Promise<void> {
	if (!(await space.readIfExists(WORLD_LOCK, 2_000, { txn }))) throw new Error("the terrain is being changed; retry this operation");
}

/** Long jobs have transactions of their own; this separate read pin covers all their coordinate reads and commits. */
export async function stableTerrain<T>(space: SpaceLike, fn: () => Promise<T>): Promise<T> {
	const txn = (await space.createTransaction(120_000)).id;
	try { await pinTerrain(space, txn); return await fn(); }
	finally { await space.abort(txn); }
}

/** Definitions used for navigation/spawning must use the same coordinate frame as the persisted rooms. */
export async function spatialWorld(space: SpaceLike, w: WorldDef): Promise<WorldDef> {
	const growth = new Map((await space.readAll({ type: "RoomGrowth" })).map((e) => { const g = fieldsOf<RoomGrowthFields>(e); return [g.roomId, g] as const; }));
	if (!growth.size) return w;
	const point = <T extends Point>(room: string, p: T) => growth.has(room) ? grownPoint(p, growth.get(room)!) : p;
	const room = (r: WorldDef["rooms"][number]) => { const g = growth.get(r.roomId); return g ? { ...r, ground: grownGround(r.ground, g, w.growth?.tile ?? ","), decor: grownDecor(r.decor, g), spawn: grownPoint(r.spawn, g) } : r; };
	return { ...w,
		rooms: w.rooms.map(room),
		...(w.allRooms ? { allRooms: w.allRooms.map(room) } : {}),
		...(w.allBeacons ? { allBeacons: w.allBeacons.map((b) => point(b.room, b)) } : {}),
		exits: w.exits.map((e) => ({ ...point(e.room, e), arrive: point(e.destination, e.arrive) })),
		beacons: w.beacons.map((b) => point(b.room, b)),
		npcs: w.npcs.map((n) => point(n.room, n)),
		objects: w.objects.map((o) => point(o.room, o)),
		scenery: w.scenery?.map((s) => point(s.room, s)),
	};
}
