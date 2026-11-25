// The seam check of room growth (server/engine/commands/growth.ts seamCheck): one labelling of the room's parts and a
// look at the cells beside each seam give the same answer as the two searches over the grown room it replaced
// (`legacyConnected`, kept here as it was), over random rooms, every seam on both axes and strips of 1 to 4.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Taken } from "phi-spaces";
import { seamCheck } from "../server/engine/commands/growth.ts";
import { PATH } from "../server/engine/commands/build.ts";
import { grownPoint, insertStrip } from "../server/engine/room-growth.ts";
import { loadWorld, walkable, type WorldDef } from "../server/engine/world.ts";
import type { RoomFields, RoomGrowthStep } from "../server/model.ts";

const w = await loadWorld();
const is = (e: Taken, type: string) => e.types.includes(type);

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

/** growth.ts `connected` before 2026-11-24. */
function legacyConnected(w: WorldDef, room: RoomFields, s: RoomGrowthStep, entries: Taken[]): boolean {
	const obstacles = entries.filter((e) => is(e, "Footprint") || is(e, "Beacon")).map((e) => e.fields as unknown as { x: number; y: number });
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

/** The fill a seam takes (growth.ts candidates), without the condition of half grass. */
function step(ground: string[], axis: "x" | "y", at: number, size: number): RoomGrowthStep {
	const width = ground[0]!.length, height = ground.length, length = axis === "x" ? width : height, across = axis === "x" ? height : width;
	const cell = (along: number, cross: number) => axis === "x" ? ground[cross]![along]! : ground[along]![cross]!;
	const fill = Array.from({ length: across }, (_, i) => {
		const a = cell(at - 1, i), b = at < length ? cell(at, i) : a;
		if (a === PATH || b === PATH) return PATH;
		if (a === w.growth!.tile || b === w.growth!.tile) return w.growth!.tile;
		return a;
	});
	return { axis, at, size, fill };
}

test("the seam check gives the answer of the two searches over the grown room, on every seam of random rooms", () => {
	let seed = 11;
	const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
	const tiles = [",", ",", ",", ".", ":", "~", "#", "_"];
	let seams = 0, safe = 0;
	for (let n = 0; n < 300; n++) {
		const width = 3 + Math.floor(rnd() * 34), height = 3 + Math.floor(rnd() * 22), water = rnd() * 0.25;
		const ground = Array.from({ length: height }, () => Array.from({ length: width }, () => (rnd() < water ? (rnd() < 0.7 ? "~" : "#") : tiles[Math.floor(rnd() * tiles.length)]!)).join(""));
		// now and then a line of water or footprints across the room
		const entries: Taken[] = [];
		const plots = rnd() * 0.25;
		for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (rnd() < plots) entries.push({ id: `${x},${y}`, type: rnd() < 0.9 ? "Footprint" : "Beacon", types: [rnd() < 0.9 ? "Footprint" : "Beacon"], fields: { x, y, w: 1, h: 1 } } as unknown as Taken);
		if (rnd() < 0.3) { const x = Math.floor(rnd() * width); for (let y = 0; y < height; y++) entries.push({ id: `l${y}`, type: "Footprint", types: ["Footprint"], fields: { x, y, w: 1, h: 1 } } as unknown as Taken); }
		const room: RoomFields = { roomId: "r", name: "r", desc: "", ground, ...(rnd() < 0.7 ? { spawn: { x: Math.floor(rnd() * width), y: Math.floor(rnd() * height) } } : {}) };
		const check = seamCheck(w, room, entries);
		for (const axis of ["x", "y"] as const) {
			const length = axis === "x" ? width : height;
			for (let at = 1; at <= length; at++) {
				const s = step(ground, axis, at, 1 + Math.floor(rnd() * 4));
				const before = legacyConnected(w, room, s, entries), after = check(s);
				assert.equal(after, before, `room ${n} (${width}x${height}), ${axis}@${at}+${s.size}: ${JSON.stringify({ ground, spawn: room.spawn, blocked: entries.map((e) => e.id) })}`);
				seams++; if (after) safe++;
			}
		}
	}
	assert.ok(safe > seams / 10 && safe < seams * 0.9, `both answers occur: ${safe} of ${seams} safe`);
});
