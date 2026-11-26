// A world definition at a finer grid (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.4, "Definition values in
// cells"; docs/raster-inventur-2026-11-24.en.md section 1.1): the generator's output at scale 1, resampled to scale `s`
// with `derivedFrom: 1`. `world.ts` stays written in scale-1 cells; `npm run world:json` writes this beside the scale-1
// definition (worlds/<id>/world-scale<s>.json), so every loader start and every fresh world at scale `s` has the same
// geometry as the migration of a scale-1 store (section 5), which scales a room's terrain with the same function.
//
// What changes, by its class (section 2.2):
// - ground: every cell becomes s×s cells of its tile; decor: each symbol once, at (s·x, s·y), the other cells empty;
// - areas: position and footprint × s (scenery, plans' footprints, beds, fields, interior beds); exits and fires,
//   points in the definition, become areas of s×s (`w = h = s`);
// - cell points: × s, once (spawn, placed things, an exit's arrival, NPCs, an interior's spawn, door and furnishings);
// - lengths of the definition × s (growth.strip/maxW/maxH, the road's stonePer/workPer, wild.scareReach,
//   wild.scarecrowReach, garden.greenhouse.reach, townhall.zoneRadius); areas × s² (field.seedPerCells/sowPerCells/
//   harvestPerCells and the crops' perCell, a divisor); growth.fullShare is a ratio and stays;
// - unchanged: the atlas (`map`), times, counts, prices. The code's rule values are not here: shared/rules.ts scales them
//   by the world's gridScale, so no value is scaled twice.
import type { InteriorDef, RoomDef, WorldDef } from "./world-def.ts";

/** `ground` at scale `s`: every cell s×s cells of its tile. */
export function scaleGround(ground: readonly string[], s: number): string[] {
	return ground.flatMap((row) => { const wide = [...row].map((k) => k.repeat(s)).join(""); return Array.from({ length: s }, () => wide); });
}

/** `decor` at scale `s`: each symbol once, at the top-left cell of its s×s cells, the others empty (" "). */
export function scaleDecor(decor: readonly string[], s: number): string[] {
	return decor.flatMap((row) => { const top = [...row].map((k) => k + " ".repeat(s - 1)).join(""), rest = " ".repeat(top.length); return [top, ...Array.from({ length: s - 1 }, () => rest)]; });
}

const pt = <T extends { x: number; y: number }>(p: T, s: number): T => ({ ...p, x: p.x * s, y: p.y * s });
const area = <T extends { x: number; y: number; w: number; h: number }>(a: T, s: number): T => ({ ...a, x: a.x * s, y: a.y * s, w: a.w * s, h: a.h * s });
const size = <T extends { w: number; h: number }>(a: T, s: number): T => ({ ...a, w: a.w * s, h: a.h * s });

function scaleRoom(r: RoomDef, s: number): RoomDef {
	return { ...r, ground: scaleGround(r.ground, s), ...(r.decor ? { decor: scaleDecor(r.decor, s) } : {}), spawn: pt(r.spawn, s) };
}

function scaleInterior(i: InteriorDef, s: number): InteriorDef {
	return { ...i, ground: scaleGround(i.ground, s), spawn: pt(i.spawn, s), door: pt(i.door, s), furniture: i.furniture.map((f) => pt(f, s)), ...(i.beds ? { beds: i.beds.map((b) => area(b, s)) } : {}) };
}

/** The definition `w` (written at scale 1) at scale `s`, derived from scale 1. */
export function scaleWorld(w: WorldDef, s: number): WorldDef {
	if ((w.gridScale ?? 1) !== 1) throw new Error(`scaleWorld: the definition is at gridScale ${w.gridScale}, not 1`);
	if (!Number.isInteger(s) || s < 1) throw new Error(`scaleWorld: gridScale ${s}`);
	const out: WorldDef = {
		...w, gridScale: s, derivedFrom: 1,
		rooms: w.rooms.map((r) => scaleRoom(r, s)),
		objects: w.objects.map((o) => pt(o, s)),
		exits: w.exits.map((e) => ({ ...pt(e, s), w: s, h: s, arrive: pt(e.arrive, s) })),
		dig: { ...w.dig, ground: scaleGround(w.dig.ground, s), spawn: pt(w.dig.spawn, s) },
		beacons: w.beacons.map((b) => ({ ...pt(b, s), w: s, h: s })),
		npcs: w.npcs.map((n) => pt(n, s)),
	};
	if (w.scenery) out.scenery = w.scenery.map((x) => area(x, s));
	if (w.building) out.building = { ...w.building, plans: w.building.plans.map((p) => ({ ...size(p, s), ...(p.interior ? { interior: scaleInterior(p.interior, s) } : {}) })) };
	if (w.garden) out.garden = { ...w.garden, bed: size(w.garden.bed, s), commons: size(w.garden.commons, s), ...(w.garden.greenhouse ? { greenhouse: { ...w.garden.greenhouse, reach: w.garden.greenhouse.reach * s } } : {}) };
	if (w.wild) out.wild = { ...w.wild, scareReach: w.wild.scareReach * s, scarecrowReach: w.wild.scarecrowReach * s };
	if (w.townhall) out.townhall = { ...w.townhall, zoneRadius: w.townhall.zoneRadius * s };
	if (w.growth) out.growth = { ...w.growth, strip: w.growth.strip * s, maxW: w.growth.maxW * s, maxH: w.growth.maxH * s };
	if (w.fields) {
		const a = s * s;
		out.fields = { ...size(w.fields, s), seedPerCells: w.fields.seedPerCells * a, sowPerCells: w.fields.sowPerCells * a, harvestPerCells: w.fields.harvestPerCells * a, crops: w.fields.crops.map((c) => ({ ...c, yields: c.yields.map((y) => ({ ...y, perCell: y.perCell / a })) })) };
	}
	if (w.cart?.route) out.cart = { ...w.cart, route: { ...w.cart.route, stonePer: w.cart.route.stonePer * s, workPer: w.cart.route.workPer * s } };
	return out;
}
