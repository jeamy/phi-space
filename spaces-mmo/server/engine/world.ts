// What a world brings (docs/architektur.md, "Verzeichnisaufbau"): rooms, the tiles their grids use, the character
// skins and the help text. The engine loads exactly one world (SPACES_MMO_WORLD); a world adds data, never engine rules.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../env.ts";
import type { BeaconFields, ExitFields, HelpEntryFields, PrototypeFields } from "../model.ts";
import { parseLocks } from "./locks.ts";
import { typeChain } from "./typeclasses.ts";

/** A 32×32 cut of a sheet (pixel offsets); `walk`: characters may stand on it. `auto`: drawn as an autotile (RPG Maker
 *  VX layout, 2×3 tiles per block, composed from quarter tiles by its neighbours), one block per animation frame;
 *  `x`/`y` stay the flat fallback. */
export type TileDef = { sheet: string; x: number; y: number; walk: boolean; auto?: { blocks: Array<{ x: number; y: number }>; frameMs: number } };
/** A character sheet: 4 frames per row, rows down, left, right, up. */
export type SkinDef = { sheet: string; frameW: number; frameH: number };
/** `map`: where the room lies on the overview of the world (one unit per room; rooms of one island side by side),
 *  `island`: the island it belongs to (the overview groups and names them). */
export type RoomDef = { roomId: string; name: string; desc: string; ground: string[]; spawn: { x: number; y: number }; map?: { x: number; y: number }; island?: string };
export type ExitDef = Omit<ExitFields, "location" | "locks"> & { room: string; locks?: string };
/** An item the world places once: spawned only while no item with its itemId exists anywhere. */
export type PlacedDef = { itemId: string; proto: string; room: string; x: number; y: number };
export type WorldDef = {
	id: string; title: string; tileSize: number; tiles: Record<string, TileDef>; skins: SkinDef[]; rooms: RoomDef[]; start: string; guestName: string;
	/** Raised when the definition changes: a world worker loads a newer version (rooms, exits, prototypes, help). */
	version: number;
	/** The hour of day 0 a new world's clock starts at (default 8; docs/weltzeit.md). */
	startHour?: number;
	/** A daily `evening` event at this world hour (docs/weltzeit.md): the schedule is made with the world. */
	evening?: { hour: number };
	/** Typeclasses below the engine's (name → parent). */
	typeclasses: Record<string, string | null>;
	prototypes: PrototypeFields[];
	objects: PlacedDef[];
	exits: ExitDef[];
	/** Help topics beyond the command list; `help` without a topic starts with `intro`. */
	help: HelpEntryFields[];
	/** What a room dug by a builder looks like until it is shaped. */
	dig: { ground: string[]; spawn: { x: number; y: number }; desc: string };
	/** Phase 2. Where fires can burn and which rooms each keeps clear of fog. */
	beacons: Array<Omit<BeaconFields, "lit">>;
	/** Burn time each fuel prototype gives, and the most a fire can hold. */
	fire: { fuel: Record<string, number>; maxMs: number };
	/** Fog levels 0..max; every `stepMs` it rises by one in rooms without a burning fire and falls by one with. */
	fog: { max: number; start: number; stepMs: number };
	/** The tide: every `everyMs` one piece of flotsam per room (up to `max` lying there) on a cell of `tile`; a room
	 *  may wash up its own things (`protos`) instead of the world's. */
	flood: { everyMs: number; lifetimeMs: number; rooms: Array<{ room: string; tile: string; max: number; protos?: Array<{ proto: string; weight: number }> }>; protos: Array<{ proto: string; weight: number }> };
	/** A storm surge now and then: `count` things at once on a beach of one of `rooms`, announced on `channel`. */
	storm?: { everyMs: number; count: number; rooms: string[]; protos: Array<{ proto: string; weight: number }>; channel: string };
	/** Channels everyone hears, across rooms. */
	channels: string[];
	/** Characters played by scripts (the npc process), not by models. */
	npcs: NpcDef[];
	/** Phase 4. The prototype that counts as money (prices, rewards). */
	currency: string;
	/** Where market boards stand (each its own listings) and how long a listing stays. */
	market: { rooms: string[]; listMs: number };
	/** Recipes: what goes in (used up), which tool is needed (it wears by one), what comes out. */
	recipes: Array<{ key: string; name: string; needs: Array<{ proto: string; count: number }>; tool?: string; makes: string }>;
	/** The order board: jobs the world posts (up to `max` open), each lasting `leaseMs` once posted. */
	orders: { rooms: string[]; max: number; everyMs: number; leaseMs: number; kinds: Array<{ key: string; text: string; needs: Array<{ proto: string; count: number }>; reward: { proto: string; count: number }; rooms?: string[] }> };
};
export type NpcDef = {
	npcId: string; name: string; skin: number; room: string; x: number; y: number; script: string; beacon?: string;
	/** In world hours: the NPC is there from `presentFromHour` to `presentUntilHour` (over midnight too), else away. */
	plan?: { presentFromHour: number; presentUntilHour: number };
	/** A model role (docs/modell-npcs.md): who it is, which events wake it, its model calls per day. Without model calls
	 *  (SPACES_MMO_LLM unset) or with its budget used up it dozes and speaks script lines. */
	model?: { persona: string; wake: string[]; budgetDay: number; dozing: string[] };
	/** A wanderer: appears only through its event, at most once per `cooldownMs`, leaves after `stayMs` without being
	 *  spoken to (game time). */
	wanderer?: { event: string; cooldownMs: number; stayMs: number };
	/** The economy (server/npc/economy.ts): the rooms it works in, the market it sells at, the rooms a trader travels
	 *  between, what it pays at most and asks per prototype ([buy, sell], 0: not), the recipes it makes, what it
	 *  carries when the world creates it, and what it says now and then. */
	home?: string[]; market?: string; route?: string[]; prices?: Record<string, [number, number]>; crafts?: string[];
	carry?: Array<{ proto: string; count: number }>; lines?: string[];
};

const WORLD_ID = /^[a-z0-9-]{1,40}$/;

/** The world named by SPACES_MMO_WORLD (default leuchtfeuer), checked: every row as wide as the first, every tile key
 *  known, every spawn walkable. */
export async function loadWorld(id = process.env.SPACES_MMO_WORLD || "leuchtfeuer"): Promise<WorldDef> {
	if (!WORLD_ID.test(id)) throw new Error(`SPACES_MMO_WORLD: a-z, 0-9 and -, got ${id}`);
	const w = (await import(join(ROOT, "worlds", id, "world.ts"))).world as WorldDef;
	const grid = (what: string, ground: string[], spawn: { x: number; y: number }) => {
		const width = ground[0]?.length ?? 0;
		if (!width || ground.some((row) => row.length !== width)) throw new Error(`${what}: rows of different width`);
		for (const row of ground) for (const k of row) if (!w.tiles[k]) throw new Error(`${what}: unknown tile ${k}`);
		if (!walkable(w, ground, spawn.x, spawn.y)) throw new Error(`${what}: spawn is not walkable`);
	};
	for (const r of w.rooms) grid(`room ${r.roomId}`, r.ground, r.spawn);
	grid("dig template", w.dig.ground, w.dig.spawn);
	const room = (roomId: string) => w.rooms.find((r) => r.roomId === roomId);
	if (!room(w.start)) throw new Error(`world ${id}: unknown start room ${w.start}`);
	for (const p of w.prototypes) {
		typeChain(p.typeclass, w.typeclasses);
		if (p.parent && !w.prototypes.some((q) => q.key === p.parent)) throw new Error(`prototype ${p.key}: unknown parent ${p.parent}`);
		parseLocks(p.locks);
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
	for (const r of w.recipes) { r.needs.forEach((n) => proto(n.proto, `recipe ${r.key}`)); proto(r.makes, `recipe ${r.key}`); if (r.tool) proto(r.tool, `recipe ${r.key}`); }
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
