// The occupancy of a room from the objects' footprints (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
// "Occupancy"): one query that gives per cell the object on it and what it does there (blocks a step, blocks building,
// counts for the growth share), in the form of the shared grid (shared/grid.ts: index y·w + x). The game reads the
// objects' Footprint entries (one per object, model.ts FootprintFields; `footprintOccupancy`), which stay readable while
// another transaction holds the object; the objects' own rectangles give the same (`occupancyOf`), and the two are
// compared cell by cell (`occupancyDiff`) by every test stack and walk. The migration from the legacy Plot entries
// (scripts/migrate-footprints.ts) compares the plots with the objects in the same way (`plotOccupancy`). The Rust engine
// has the same (rust/mmo-engine/src/footprints.rs).

/** A step onto the cell is refused. */
export const MOVE = 1;
/** Nothing is built on the cell. */
export const BUILD = 2;
/** The cell counts for the growth share where it is land (growth.ts: the plots, not the fires). */
export const SHARE = 4;

/** The ID an occupancy gives an entry (its object's for a footprint, `of` for a plot, the fire's), or null. */
export function occupancyId(e: OccupancyEntry): string | null {
	if (typeOf(e, "Plot") || typeOf(e, "Footprint")) return String(e.fields.of);
	if (typeOf(e, "Beacon")) return String(e.fields.beaconId);
	const kind = (Object.keys(FOOTPRINTS) as FootprintType[]).find((t) => typeOf(e, t));
	return kind ? String(e.fields[FOOTPRINTS[kind]]) : null;
}

/** The objects that stand on cells of their own, with the field that names them: what has a Plot per cell today. A
 *  Scenery with `through` has none; a furnishing of an inside and a greenhouse's bed are a Scenery and a Bed of the
 *  inside's room. MillLoad, Zone and Motion have a rectangle but no cells of their own. */
export const FOOTPRINTS = { Site: "buildId", Building: "buildId", Ruin: "buildId", Bed: "bedId", Field: "fieldId", Tree: "treeId", Scenery: "sceneryId" } as const;
export type FootprintType = keyof typeof FOOTPRINTS;

export type OccupancyEntry = { type: string; types?: readonly string[]; fields: Record<string, unknown> };

/** A room's occupancy: `at[y·w + x]` the index of the object in `ids` (-1: none), `flags` its MOVE, BUILD and SHARE.
 *  `overlaps`: cells a second object claims (the first keeps the cell); `outside`: cells of an object beyond the room. */
export type Occupancy = { w: number; h: number; ids: string[]; at: Int32Array; flags: Uint8Array; overlaps: Array<{ x: number; y: number; first: string; second: string }>; outside: Array<{ x: number; y: number; id: string }> };

const typeOf = (e: OccupancyEntry, t: string) => e.type === t || !!e.types?.includes(t);

function empty(w: number, h: number): Occupancy {
	return { w, h, ids: [], at: new Int32Array(w * h).fill(-1), flags: new Uint8Array(w * h), overlaps: [], outside: [] };
}

function claim(o: Occupancy, index: Map<string, number>, id: string, x: number, y: number, flags: number): void {
	if (!(x >= 0 && y >= 0 && x < o.w && y < o.h && Number.isInteger(x) && Number.isInteger(y))) { o.outside.push({ x, y, id }); return; }
	const i = y * o.w + x;
	let k = index.get(id);
	if (k === undefined) { k = o.ids.push(id) - 1; index.set(id, k); }
	if (o.at[i] !== -1 && o.ids[o.at[i]!] !== id) { o.overlaps.push({ x, y, first: o.ids[o.at[i]!]!, second: id }); o.flags[i]! |= flags; return; }
	o.at[i] = k;
	o.flags[i]! |= flags;
}

const num = (v: unknown, d: number) => (typeof v === "number" ? v : d);

/** The occupancy of a room of `w` × `h` from its entries (the room's Site, Building, Ruin, Bed, Field, Tree, Scenery and
 *  Beacon; others are passed over): an object claims its rectangle, a fire its cell (or its footprint, `w`/`h`). */
export function occupancyOf(w: number, h: number, entries: Iterable<OccupancyEntry>): Occupancy {
	const o = empty(w, h), index = new Map<string, number>();
	for (const e of entries) {
		const f = e.fields;
		const kind = (Object.keys(FOOTPRINTS) as FootprintType[]).find((t) => typeOf(e, t));
		if (kind) {
			if (kind === "Scenery" && f.through) continue;
			const id = String(f[FOOTPRINTS[kind]]), x0 = num(f.x, NaN), y0 = num(f.y, NaN), fw = num(f.w, 1), fh = num(f.h, 1);
			for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) claim(o, index, id, x, y, MOVE | BUILD | SHARE);
		} else if (typeOf(e, "Beacon")) {
			const x0 = num(f.x, NaN), y0 = num(f.y, NaN), fw = num(f.w, 1), fh = num(f.h, 1);
			for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) claim(o, index, String(f.beaconId), x, y, MOVE | BUILD);
		}
	}
	return o;
}

/** The same from the Footprint entries (`of` the object, the rectangle) and the Beacons. */
export function footprintOccupancy(w: number, h: number, entries: Iterable<OccupancyEntry>): Occupancy {
	const o = empty(w, h), index = new Map<string, number>();
	for (const e of entries) {
		const f = e.fields;
		if (typeOf(e, "Footprint")) {
			const x0 = num(f.x, NaN), y0 = num(f.y, NaN), fw = num(f.w, 1), fh = num(f.h, 1);
			for (let y = y0; y < y0 + fh; y++) for (let x = x0; x < x0 + fw; x++) claim(o, index, String(f.of), x, y, MOVE | BUILD | SHARE);
		} else if (typeOf(e, "Beacon")) claim(o, index, String(f.beaconId), num(f.x, NaN), num(f.y, NaN), MOVE | BUILD);
	}
	return o;
}

/** The same from the legacy cells: a room's Plot entries (`of` the object) and its Beacons. */
export function plotOccupancy(w: number, h: number, entries: Iterable<OccupancyEntry>): Occupancy {
	const o = empty(w, h), index = new Map<string, number>();
	for (const e of entries) {
		const f = e.fields;
		if (typeOf(e, "Plot")) claim(o, index, String(f.of), num(f.x, NaN), num(f.y, NaN), MOVE | BUILD | SHARE);
		else if (typeOf(e, "Beacon")) claim(o, index, String(f.beaconId), num(f.x, NaN), num(f.y, NaN), MOVE | BUILD);
	}
	return o;
}

/** A cell where the two occupancies differ: the object each puts there (null: none) and its flags. */
export type OccupancyDiff = { x: number; y: number; plots: string | null; footprints: string | null; plotFlags: number; footprintFlags: number };

/** The cells where `plots` and `footprints` (of one room, the same size) differ, row by row. */
export function occupancyDiff(plots: Occupancy, footprints: Occupancy): OccupancyDiff[] {
	const out: OccupancyDiff[] = [];
	for (let i = 0; i < plots.at.length; i++) {
		const a = plots.at[i]! < 0 ? null : plots.ids[plots.at[i]!]!, b = footprints.at[i]! < 0 ? null : footprints.ids[footprints.at[i]!]!;
		if (a !== b || plots.flags[i] !== footprints.flags[i]) out.push({ x: i % plots.w, y: Math.floor(i / plots.w), plots: a, footprints: b, plotFlags: plots.flags[i]!, footprintFlags: footprints.flags[i]! });
	}
	return out;
}

/** What differs in a room, as lines for a report (room, cell, the objects): the overlaps and cells outside of both, then
 *  the cells where they differ. Empty: the footprints give the plots' occupancy. */
export function occupancyReport(room: string, plots: Occupancy, footprints: Occupancy, skip: (id: string) => boolean = () => false, kept = "plots"): string[] {
	const name = (id: string | null) => id ?? "nothing";
	const any = (...ids: Array<string | null>) => ids.some((id) => id !== null && skip(id));
	// a cell an overlap of a left-out object lies on is left out too (its flags are the two objects')
	const passed = new Set([...plots.overlaps, ...footprints.overlaps].filter((c) => any(c.first, c.second)).map((c) => c.y * plots.w + c.x));
	return [
		...plots.overlaps.filter((c) => !any(c.first, c.second)).map((c) => `${room} ${c.x},${c.y}: ${kept} of ${c.first} and ${c.second}`),
		...plots.outside.filter((c) => !any(c.id)).map((c) => `${room} ${c.x},${c.y}: ${kept} of ${c.id} outside the room`),
		...footprints.overlaps.filter((c) => !any(c.first, c.second)).map((c) => `${room} ${c.x},${c.y}: objects ${c.first} and ${c.second} overlap`),
		...footprints.outside.filter((c) => !any(c.id)).map((c) => `${room} ${c.x},${c.y}: object ${c.id} reaches outside the room`),
		...occupancyDiff(plots, footprints).filter((d) => !any(d.plots, d.footprints) && !passed.has(d.y * plots.w + d.x)).map((d) => `${room} ${d.x},${d.y}: ${kept} say ${name(d.plots)}, objects ${name(d.footprints)}${d.plots === d.footprints ? ` (flags ${d.plotFlags} and ${d.footprintFlags})` : ""}`),
	];
}

/** The rooms' sizes and the report over a whole store's entries (the check of the tests and the walks, and of the
 *  migration, plan section 5): every room by its `ground`, every room's Footprint entries (`against: "plots"`: its
 *  legacy plots) against its objects' footprints. A room without its Room entry (a test that loads no world) is compared
 *  on a grid as large as what lies in it; `rooms: "required"` reports it instead. `skip`: objects whose differences are
 *  not reported (what a test placed or took by hand, tests/stack.ts). */
export function storeOccupancyReport(entries: readonly OccupancyEntry[], o: { rooms?: "required"; skip?: (id: string) => boolean; against?: "plots" | "footprints" } = {}): string[] {
	const plots = o.against === "plots", kept = plots ? "Plot" : "Footprint";
	const rooms = new Map<string, OccupancyEntry[]>(), size = new Map<string, { w: number; h: number }>();
	for (const e of entries) {
		if (typeOf(e, "Room")) { const g = e.fields.ground as string[] | undefined; size.set(String(e.fields.roomId), { w: g?.[0]?.length ?? 0, h: g?.length ?? 0 }); continue; }
		if (!typeOf(e, kept) && !typeOf(e, "Beacon") && !(Object.keys(FOOTPRINTS) as FootprintType[]).some((t) => typeOf(e, t))) continue;
		const room = String(e.fields.room);
		let list = rooms.get(room);
		if (!list) rooms.set(room, (list = []));
		list.push(e);
	}
	const out: string[] = [];
	// an object has one Footprint entry (a move writes it without `unique`, occupancy.ts writeFootprint)
	if (!plots) {
		const seen = new Map<string, number>();
		for (const e of entries) if (typeOf(e, "Footprint")) { const k = `${String(e.fields.room)} ${String(e.fields.of)}`; seen.set(k, (seen.get(k) ?? 0) + 1); }
		for (const [k, n] of [...seen].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) if (n > 1 && !o.skip?.(k.slice(k.indexOf(" ") + 1))) out.push(`${k}: ${n} footprint entries`);
	}
	for (const [room, list] of [...rooms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
		let s = size.get(room);
		if (!s && o.rooms === "required") { out.push(`${room}: occupied cells in a room that is not there`); continue; }
		s ??= list.reduce((m, e) => ({ w: Math.max(m.w, num(e.fields.x, 0) + num(e.fields.w, 1)), h: Math.max(m.h, num(e.fields.y, 0) + num(e.fields.h, 1)) }), { w: 0, h: 0 });
		out.push(...occupancyReport(room, (plots ? plotOccupancy : footprintOccupancy)(s.w, s.h, list), occupancyOf(s.w, s.h, list), o.skip, plots ? "plots" : "footprint entries"));
	}
	return out;
}
