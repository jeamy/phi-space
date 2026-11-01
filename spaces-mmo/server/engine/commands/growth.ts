// Full rooms gain land at an edge or at a safe seam before the coast. Geometry and positions commit together.
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, WORLD_LOCK, type ExitFields, type RoomFields, type RoomGrowthFields, type RoomGrowthStep } from "../../model.ts";
import { msgOptions } from "../context.ts";
import { PATH } from "./build.ts";
import { isPassage } from "../occupancy.ts";
import { grownPoint, insertStrip } from "../room-growth.ts";
import { walkable, type WorldDef } from "../world.ts";
export { grownGround, grownDecor } from "../room-growth.ts";

const POSITIONED = ["Character", "Spot", "Beacon", "Cart", "Site", "Building", "Ruin", "Bed", "Field", "Scenery", "MillLoad", "SiteOrder", "Plot", "Zone", "Motion", "Animal"];
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

function reachable(w: WorldDef, ground: string[], blocked: Set<string>, start: { x: number; y: number }): Set<string> {
	const seen = new Set<string>(), queue = [start];
	for (let i = 0; i < queue.length; i++) {
		const p = queue[i]!, key = `${p.x},${p.y}`;
		if (seen.has(key) || blocked.has(key) || !walkable(w, ground, p.x, p.y)) continue;
		seen.add(key);
		for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) queue.push({ x: p.x + dx!, y: p.y + dy! });
	}
	return seen;
}

/** All previously reachable free cells stay reachable, and the new building land connects to that component. */
function connected(w: WorldDef, room: RoomFields, s: RoomGrowthStep, entries: Taken[]): boolean {
	const obstacles = entries.filter((e) => is(e, "Plot") || is(e, "Beacon")).map((e) => e.fields as unknown as Rect);
	const blocked = new Set(obstacles.map((p) => `${p.x},${p.y}`));
	const free = (p: { x: number; y: number }) => walkable(w, room.ground, p.x, p.y) && !blocked.has(`${p.x},${p.y}`);
	let start = room.spawn;
	if (!start || !free(start)) {
		start = undefined;
		for (let y = 0; y < room.ground.length && !start; y++) for (let x = 0; x < room.ground[y]!.length; x++) if (free({ x, y })) { start = { x, y }; break; }
	}
	if (!start) return false;
	const g = { east: 0, south: 0, steps: [s] }, ground = insertStrip(room.ground, s);
	const after = reachable(w, ground, new Set(obstacles.map((p) => { const q = grownPoint(p, g); return `${q.x},${q.y}`; })), grownPoint(start, g));
	for (const key of reachable(w, room.ground, blocked, start)) {
		const [x, y] = key.split(",").map(Number), q = grownPoint({ x: x!, y: y! }, g);
		if (!after.has(`${q.x},${q.y}`)) return false;
	}
	for (let i = 0; i < s.fill.length; i++) if (s.fill[i] === w.growth!.tile || s.fill[i] === PATH) for (let j = 0; j < s.size; j++) {
		const p = s.axis === "x" ? { x: s.at + j, y: i } : { x: i, y: s.at + j };
		if (!after.has(`${p.x},${p.y}`)) return false;
	}
	return true;
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

/** A busy world defers growth; a room and every displaced position change in one transaction under the world lock. */
export async function growthTick(space: SpaceLike, w: WorldDef, leaseMs: number): Promise<number> {
	const d = w.growth;
	if (!d) return 0;
	if (!Number.isInteger(d.strip) || d.strip < 1) throw new RangeError("growth.strip must be a positive integer");
	let grew = 0;
	for (const entry of await space.readAll({ type: "Room" })) {
		const txn = (await space.createTransaction(30_000)).id;
		try {
			if (!(await space.takeIfExists(WORLD_LOCK, NO_WAIT, { txn }))) { await space.abort(txn); break; }
			const e = await space.takeIfExists({ id: entry.id }, NO_WAIT, { txn });
			if (!e) { await space.abort(txn); continue; }
			const room = fieldsOf<RoomFields>(e);
			const groups = await Promise.all([
				...POSITIONED.map((type) => space.readAll({ type, fields: { room: room.roomId } }, { txn })),
				space.readAll({ type: "Item", fields: { location: room.roomId } }, { txn }),
				space.readAll({ type: "Exit" }, { txn }),
			]);
			const entries = groups.flat(), exits = entries.filter((x) => is(x, "Exit") && x.fields.location === room.roomId).map(fieldsOf<ExitFields>);
			const land = new Set<string>();
			room.ground.forEach((row, y) => { for (let x = 0; x < row.length; x++) if (walkable(w, room.ground, x, y) && row[x] !== PATH && !isPassage(exits, { x, y })) land.add(`${x},${y}`); });
			const occupied = new Set(entries.filter((x) => is(x, "Plot")).map((x) => `${x.fields.x},${x.fields.y}`).filter((key) => land.has(key)));
			if (!land.size || occupied.size < land.size * d.fullShare) { await space.abort(txn); continue; }
			const rectangles = entries.filter((x) => x.fields.room === room.roomId).flatMap((x) => is(x, "Motion") && x.fields.zone ? [x.fields.zone as unknown as Rect] : typeof x.fields.w === "number" && typeof x.fields.h === "number" ? [x.fields as unknown as Rect] : []);
			const step = [...candidates(w, room, exits)].find((s) => !rectangles.some((r) => crosses(r, s)) && connected(w, room, s, entries));
			if (!step) { await space.abort(txn); continue; }
			const was = await space.takeIfExists({ type: "RoomGrowth", fields: { roomId: room.roomId } }, NO_WAIT, { txn });
			const before: RoomGrowthFields = was ? fieldsOf<RoomGrowthFields>(was) : { roomId: room.roomId, east: 0, south: 0 };
			const after: RoomGrowthFields = { ...before, east: before.east + (step.axis === "x" ? step.size : 0), south: before.south + (step.axis === "y" ? step.size : 0), steps: [...before.steps ?? [], step], baseWidth: before.baseWidth ?? room.ground[0]!.length - before.east, baseHeight: before.baseHeight ?? room.ground.length - before.south };
			const changes = entries.map((x) => ({ e: x, fields: moved(x, room.roomId, before, step) })).filter((x) => JSON.stringify(x.fields) !== JSON.stringify(x.e.fields));
			let busy = false;
			for (const change of changes) if (!(await space.takeIfExists({ id: change.e.id }, NO_WAIT, { txn }))) { busy = true; break; }
			if (busy) { await space.abort(txn); continue; }
			for (const { e: old, fields } of changes) await space.write({ type: old.type, types: old.types.slice(1), fields }, txn, FOREVER, (is(old, "Plot") || is(old, "Spot")) ? { unique: ["room", "x", "y"] } : {});
			await space.write({ type: "RoomGrowth", fields: after as never }, txn, FOREVER);
			const g = { east: 0, south: 0, steps: [step] };
			await space.write({ type: e.type, types: e.types.slice(1), fields: { ...e.fields, ground: insertStrip(room.ground, step), ...(room.decor ? { decor: insertStrip(room.decor, step, true) } : {}), ...(room.spawn ? { spawn: grownPoint(room.spawn, g) } : {}) } as never }, txn, FOREVER);
			await space.write({ type: "Msg", fields: { room: room.roomId, to: "*", kind: "world", text: `${room.name} wächst: Im ${step.axis === "x" ? "Osten" : "Süden"} ist neues Land frei.`, from: "", at: Date.now() } as never }, txn, leaseMs, await msgOptions(space, { to: "*", kind: "world" }));
			await space.write({ type: WORLD_LOCK.type, fields: { ...WORLD_LOCK.fields } }, txn, FOREVER);
			await space.commit(txn);
			grew++;
		} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
	}
	return grew;
}
