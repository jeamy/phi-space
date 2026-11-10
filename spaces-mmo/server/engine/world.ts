// What a world brings (docs/architektur.en.md, "Verzeichnisaufbau"): rooms, the tiles their grids use, the character
// skins and the help text. The engine loads exactly one world (SPACES_MMO_WORLD); a world adds data, never engine rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import type { SceneryFields } from "../model.ts";
import type { WorldDef } from "../../shared/world-def.ts";
import { parseLocks } from "./locks.ts";
import { typeChain } from "./typeclasses.ts";

// the types of the definition live in shared/world-def.ts (the browser reads them too)
export type * from "../../shared/world-def.ts";

/** What `look` and the map say about a piece of scenery: what it is, and whether and how it can be cleared. */
export function sceneryText(w: WorldDef, s: Pick<SceneryFields, "name" | "fixed" | "yields" | "desc"> & { left: number }): string {
	if (s.desc) return s.desc; // a furnishing says what it is for (engine/commands/interior.ts)
	const about = w.sceneryAbout?.[s.name] ?? "";
	if (s.fixed) return `${about} Das bleibt stehen.`.trim();
	const gain = s.yields.map((y) => `${y.count} ${w.prototypes.find((p) => p.key === y.proto)?.name ?? y.proto}`).join(", ");
	return `${about} Lässt sich abräumen („räume“, noch ${s.left} Arbeit)${gain ? `, das bringt ${gain}` : ""}.`.trim();
}


const WORLD_ID = /^[a-z0-9-]{1,40}$/;

/** The world named by SPACES_MMO_WORLD (default leuchtfeuer), checked: every row as wide as the first, every tile key
 *  known, every spawn walkable. */
export async function loadWorld(id = process.env.SPACES_MMO_WORLD || "leuchtfeuer"): Promise<WorldDef> {
	if (!WORLD_ID.test(id)) throw new Error(`SPACES_MMO_WORLD: a-z, 0-9 and -, got ${id}`);
	// the definition is data (worlds/<id>/world.json, written by npm run world:json from the world's world.ts); the engine
	// runs nothing a world brings
	const w = JSON.parse(readFileSync(join(ROOT, "worlds", id, "world.json"), "utf8")) as WorldDef;
	const grid = (what: string, ground: string[], spawn: { x: number; y: number }) => {
		const width = ground[0]?.length ?? 0;
		if (!width || ground.some((row) => row.length !== width)) throw new Error(`${what}: rows of different width`);
		for (const row of ground) for (const k of row) if (!w.tiles[k]) throw new Error(`${what}: unknown tile ${k}`);
		if (!walkable(w, ground, spawn.x, spawn.y)) throw new Error(`${what}: spawn is not walkable`);
	};
	for (const r of w.rooms) {
		grid(`room ${r.roomId}`, r.ground, r.spawn);
		if (!r.decor) continue;
		if (r.decor.length !== r.ground.length || r.decor.some((row) => row.length !== r.ground[0]!.length)) throw new Error(`room ${r.roomId}: decor not the size of the ground`);
		for (const row of r.decor) for (const k of row) if (k !== " " && !w.decor?.[k]) throw new Error(`room ${r.roomId}: unknown decor ${k}`);
	}
	grid("dig template", w.dig.ground, w.dig.spawn);
	const room = (roomId: string) => w.rooms.find((r) => r.roomId === roomId);
	if (!room(w.start)) throw new Error(`world ${id}: unknown start room ${w.start}`);
	for (const p of w.prototypes) {
		typeChain(p.typeclass, w.typeclasses);
		if (p.parent && !w.prototypes.some((q) => q.key === p.parent)) throw new Error(`prototype ${p.key}: unknown parent ${p.parent}`);
		parseLocks(p.locks);
		if (p.icon && !worldAsset(id, p.icon)?.type.startsWith("image/")) throw new Error(`prototype ${p.key}: icon ${p.icon} is no picture in worlds/${id}/assets`);
	}
	for (const e of w.exits) {
		const from = room(e.room), to = room(e.destination);
		if (!from || !to) throw new Error(`exit ${e.exitId}: unknown room`);
		if (!walkable(w, from.ground, e.x, e.y) || !walkable(w, to.ground, e.arrive.x, e.arrive.y)) throw new Error(`exit ${e.exitId}: cell or arrival not walkable`);
		if (w.exits.some((o) => o.room === e.destination && o.x === e.arrive.x && o.y === e.arrive.y)) throw new Error(`exit ${e.exitId}: arrives on another exit`);
		parseLocks(e.locks ?? "");
	}
	for (const b of w.beacons) {
		const r = room(b.room);
		if (!r || !walkable(w, r.ground, b.x, b.y) || b.covers.some((c) => !room(c))) throw new Error(`beacon ${b.beaconId}: unknown room or not walkable`);
	}
	for (const p of Object.keys(w.fire.fuel)) if (!w.prototypes.some((q) => q.key === p)) throw new Error(`fire fuel: unknown prototype ${p}`);
	for (const f of w.flood.rooms) if (!room(f.room)) throw new Error(`flood: unknown room ${f.room}`);
	for (const p of w.flood.protos) if (!w.prototypes.some((q) => q.key === p.proto)) throw new Error(`flood: unknown prototype ${p.proto}`);
	for (const n of w.npcs) {
		const r = room(n.room);
		if (!r || !walkable(w, r.ground, n.x, n.y)) throw new Error(`npc ${n.npcId}: unknown room or not walkable`);
		if (n.beacon && !w.beacons.some((b) => b.beaconId === n.beacon)) throw new Error(`npc ${n.npcId}: unknown beacon`);
		for (const r of [...(n.home ?? []), ...(n.route ?? []), ...(n.market ? [n.market] : [])]) if (!room(r)) throw new Error(`npc ${n.npcId}: unknown room ${r}`);
		for (const p of [...Object.keys(n.prices ?? {}), ...(n.carry ?? []).map((c) => c.proto)]) if (!w.prototypes.some((q) => q.key === p)) throw new Error(`npc ${n.npcId}: unknown prototype ${p}`);
		for (const k of n.crafts ?? []) if (!w.recipes.some((r) => r.key === k)) throw new Error(`npc ${n.npcId}: unknown recipe ${k}`);
	}
	// the overview: no two rooms on one place
	const placed = new Map<string, string>();
	for (const r of w.rooms) if (r.map) {
		const k = `${r.map.x},${r.map.y}`;
		if (placed.has(k)) throw new Error(`rooms ${placed.get(k)} and ${r.roomId} on one place of the overview`);
		placed.set(k, r.roomId);
	}
	const proto = (k: string, what: string) => { if (!w.prototypes.some((q) => q.key === k)) throw new Error(`${what}: unknown prototype ${k}`); };
	proto(w.currency, "currency");
	for (const r of [...w.market.rooms, ...w.orders.rooms, ...w.orders.kinds.flatMap((k) => k.rooms ?? [])]) if (!room(r)) throw new Error(`market or order board: unknown room ${r}`);
	for (const p of [...w.flood.rooms.flatMap((r) => r.protos ?? []), ...(w.storm?.protos ?? [])]) proto(p.proto, "flood or storm");
	for (const r of w.storm?.rooms ?? []) if (!room(r)) throw new Error(`storm: unknown room ${r}`);
	for (const r of w.recipes) {
		r.needs.forEach((n) => proto(n.proto, `recipe ${r.key}`)); proto(r.makes, `recipe ${r.key}`); if (r.tool) proto(r.tool, `recipe ${r.key}`);
		if (r.at && !w.building?.plans.some((p) => p.key === r.at)) throw new Error(`recipe ${r.key}: unknown plan ${r.at}`);
	}
	if (w.mill) {
		if (!w.building?.plans.some((p) => p.key === w.mill!.plan)) throw new Error(`mill: unknown plan ${w.mill.plan}`);
		for (const g of w.mill.grinds) { proto(g.from, "mill"); proto(g.to, "mill"); }
	}
	for (const p of w.building?.plans ?? []) if (p.interior) {
		const i = p.interior;
		grid(`plan ${p.key}: interior`, i.ground, i.spawn);
		if (!walkable(w, i.ground, i.door.x, i.door.y)) throw new Error(`plan ${p.key}: interior door is not walkable`);
		for (const f of i.furniture) if (!walkable(w, i.ground, f.x, f.y) || (f.x === i.spawn.x && f.y === i.spawn.y) || (f.x === i.door.x && f.y === i.door.y)) throw new Error(`plan ${p.key}: furnishing ${f.kind} not on a free floor cell`);
		if (i.furniture.some((f) => f.use === "chest") && !p.chest) throw new Error(`plan ${p.key}: a chest inside, but the plan has none`);
	}
	for (const p of w.building?.plans ?? []) if (p.epoch !== undefined && (!w.epochs || p.epoch < 1 || p.epoch > w.epochs.names.length)) throw new Error(`plan ${p.key}: no epoch ${p.epoch}`);
	if (w.wild) {
		const wd = w.wild;
		for (const n of [...wd.fence, ...(wd.fieldFence ?? []), ...(wd.coopFence ?? [])]) proto(n.proto, "fence");
		for (const p of wd.prey ?? []) {
			[...(p.eats ?? []), ...(p.trap ? [p.trap] : [])].forEach((x) => proto(x, `wild ${p.key}`));
			// a fox's houses are animal houses, a gull's plans with a chest (the smokehouse's rack)
			for (const h of p.houses ?? []) if (p.key === "moewe" ? !w.building?.plans.find((x) => x.key === h)?.chest : !w.animals?.houses[h]) throw new Error(`wild ${p.key}: no ${p.key === "moewe" ? "plan with a chest" : "animal house"} ${h}`);
		}
		for (const k of wd.keepers ?? []) [k.proto, ...k.feed].forEach((x) => proto(x, `keeper ${k.key}`));
		for (const g of wd.guards ?? []) if (!w.animals?.kinds.some((k) => k.key === g.by) && !wd.keepers?.some((k) => k.key === g.by)) throw new Error(`wild guard: unknown animal ${g.by}`);
	}
	for (const k of w.animals?.kinds ?? []) {
		[k.proto, k.yields, ...k.feed].forEach((p) => proto(p, `animal ${k.key}`));
		if (!w.animals!.houses[k.plan] || !w.building?.plans.some((p) => p.key === k.plan)) throw new Error(`animal ${k.key}: no house ${k.plan}`);
	}
	for (const k of w.orders.kinds) { k.needs.forEach((n) => proto(n.proto, `order ${k.key}`)); proto(k.reward.proto, `order ${k.key}`); }
	for (const o of w.objects) {
		const r = room(o.room);
		if (!r || !walkable(w, r.ground, o.x, o.y) || !w.prototypes.some((p) => p.key === o.proto)) throw new Error(`object ${o.itemId}: unknown room or prototype, or not on a walkable cell`);
	}
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

/** The shortest walk from one cell to another over walkable cells (4 directions) that are not `blocked` ("x,y"), at
 *  most `max` steps; null when there is none. The cells after the start, the target last. */
export function findPath(w: WorldDef, ground: string[], from: { x: number; y: number }, to: { x: number; y: number }, max = 40, blocked: ReadonlySet<string> = new Set()): Array<{ x: number; y: number }> | null {
	if (!walkable(w, ground, to.x, to.y) || blocked.has(`${to.x},${to.y}`)) return null;
	if (from.x === to.x && from.y === to.y) return [];
	const width = ground[0]!.length, key = (x: number, y: number) => y * width + x;
	const prev = new Map<number, number>([[key(from.x, from.y), -1]]);
	let frontier = [from];
	for (let step = 0; step < max && frontier.length; step++) {
		const next: Array<{ x: number; y: number }> = [];
		for (const c of frontier) for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
			const x = c.x + dx, y = c.y + dy, k = key(x, y);
			if (prev.has(k) || !walkable(w, ground, x, y) || blocked.has(`${x},${y}`)) continue;
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

/** The name of the first exit on the shortest way from one room to another (over the world's exits), or null. */
export function wayTo(w: WorldDef, from: string, to: string): string | null {
	if (from === to) return null;
	const first = new Map<string, string>([[from, ""]]);
	let frontier = [from];
	while (frontier.length) {
		const next: string[] = [];
		for (const r of frontier) for (const e of w.exits.filter((x) => x.room === r)) {
			if (first.has(e.destination)) continue;
			first.set(e.destination, first.get(r) || e.name);
			if (e.destination === to) return first.get(to)!;
			next.push(e.destination);
		}
		frontier = next;
	}
	return null;
}
