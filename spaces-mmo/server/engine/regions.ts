// Regions (docs/welt-aufteilen.md): the world split into spaces, each served by its own space process (a core of its
// own), with its own world worker and npc process. A region is a group of islands; its space holds those islands' rooms,
// exits, fires, things and the characters standing there. A ferry to an island of another region hands the character
// over (handover.ts). Without `regions` in the world definition the whole world is one region, "world".
import type { RoomDef, WorldDef } from "./world.ts";

export type RegionDef = {
	regionId: string;
	/** The islands (RoomDef.island) of this region. */
	islands: string[];
	/** Where a new character of this region starts (a room of the region). */
	start: string;
};

/** The region of a world that has none. */
export const WHOLE = "world";

/** The regions the world defines (also when it runs as one space: see regionAddresses). */
export function regionsOf(w: WorldDef): RegionDef[] {
	return w.regions?.length ? w.regions : [{ regionId: WHOLE, islands: [...new Set(w.rooms.map((r) => r.island ?? ""))], start: w.start }];
}

/** The region a room lies in, or null for a room the world definition does not know (dug by a builder: it stays where
 *  it was dug, see roomRegion in the space). */
export function regionOfRoom(w: WorldDef, roomId: string): string | null {
	const room = w.rooms.find((r) => r.roomId === roomId);
	if (!room) return null;
	return regionsOf(w).find((g) => g.islands.includes(room.island ?? ""))?.regionId ?? null;
}

/**
 * The part of the world one region's processes run: its rooms, the exits that leave them (also a ferry to another
 * region: its destination is a room of that region), its things, fires, tides, storms, markets and boards. What every
 * region needs is kept whole: prototypes, recipes, help, typeclasses, tiles, skins, the clock's start, and the NPCs (an
 * NPC walks where its script takes it, also into another region; the loader creates it only in the region it starts in).
 * `allRooms` is the whole world's (names of rooms elsewhere, the overview).
 */
export function regionWorld(w: WorldDef, regionId: string): WorldDef & { region: string; allRooms: RoomDef[] } {
	const region = regionsOf(w).find((g) => g.regionId === regionId);
	if (!region) throw new Error(`the world ${w.id} has no region ${regionId} (it has ${regionsOf(w).map((g) => g.regionId).join(", ")})`);
	const rooms = w.rooms.filter((r) => region.islands.includes(r.island ?? ""));
	const here = new Set(rooms.map((r) => r.roomId));
	const inHere = (room: string) => here.has(room);
	return {
		...w,
		region: regionId,
		allRooms: w.rooms,
		rooms,
		start: region.start,
		exits: w.exits.filter((e) => inHere(e.room)),
		objects: w.objects.filter((o) => inHere(o.room)),
		beacons: w.beacons.filter((b) => inHere(b.room)),
		flood: { ...w.flood, rooms: w.flood.rooms.filter((f) => inHere(f.room)) },
		...(w.storm ? { storm: { ...w.storm, rooms: w.storm.rooms.filter(inHere) } } : {}),
		market: { ...w.market, rooms: w.market.rooms.filter(inHere) },
		orders: { ...w.orders, rooms: w.orders.rooms.filter(inHere), kinds: w.orders.kinds.filter((k) => !k.rooms || k.rooms.some(inHere)) },
	};
}

/** Checks the regions of a world: every island in exactly one, every start a room of its region, ids unique. */
export function checkRegions(w: WorldDef): void {
	if (!w.regions?.length) return;
	const ids = new Set<string>(), islands = new Map<string, string>();
	for (const g of w.regions) {
		if (!/^[a-z0-9-]{1,20}$/.test(g.regionId) || ids.has(g.regionId)) throw new Error(`region id ${g.regionId}: unique, a-z0-9-`);
		ids.add(g.regionId);
		for (const i of g.islands) { if (islands.has(i)) throw new Error(`island ${i} is in ${islands.get(i)} and ${g.regionId}`); islands.set(i, g.regionId); }
		if (regionOfRoom(w, g.start) !== g.regionId) throw new Error(`region ${g.regionId}: its start ${g.start} is not one of its rooms`);
	}
	for (const r of w.rooms) if (!islands.has(r.island ?? "")) throw new Error(`room ${r.roomId}: its island ${r.island} is in no region`);
}

/** Region addresses: SPACES_MMO_REGIONS "west=tcp:big:3950,nord=unix:/tmp/nord.sock" (every region the world has),
 *  or, without it, the one space at `whole` for the whole world as one region ("world"). */
export function regionAddresses(w: WorldDef, whole: string, raw = process.env.SPACES_MMO_REGIONS ?? ""): Map<string, string> {
	const out = new Map<string, string>();
	if (!raw.trim()) { out.set(WHOLE, whole); return out; }
	for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
		const i = part.indexOf("=");
		if (i < 1) throw new Error(`SPACES_MMO_REGIONS: "${part}" is not region=address`);
		out.set(part.slice(0, i), part.slice(i + 1));
	}
	for (const g of regionsOf(w)) if (!out.has(g.regionId)) throw new Error(`SPACES_MMO_REGIONS names no address for the region ${g.regionId}`);
	return out;
}
