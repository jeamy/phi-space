// The grid format of a world store and the class of every coordinate field (docs/3d-welt-und-raster-plan-2026-11-21.en.md
// sections 2.2 and 5, docs/raster-inventur-2026-11-24.en.md section 3). A store holds its format in one `GridFormat` entry;
// a store without one is the legacy format (scale 1, plots). A binary runs the formats it supports only and refuses
// every other store at start, before it writes anything (server/engine/grid-format.ts, the Rust engine's grid_format.rs).
// The Rust engine keeps this table as rust/mmo-engine/src/grid_classes.json (`npm run grid:classes` writes it,
// tests/grid-format.test.ts holds the two together).

/** Where an occupied cell is recorded: in single `Plot` entries (legacy) or in the objects' footprints. */
export type Occupancy = "plots" | "footprints";
/** What a `GridFormat` entry holds. `state` "running": a migration began and has not finished. */
export type GridFormatFields = { worldId: string; gridScale: number; derivedFrom?: number; occupancy: Occupancy; state: "complete" | "running" };

/** The format a store without a `GridFormat` entry has. */
export const LEGACY_FORMAT = { gridScale: 1, occupancy: "plots" as Occupancy };
/** The format this binary runs (until the cut: the legacy one). */
export const SUPPORTED_FORMAT = LEGACY_FORMAT;

/** How a coordinate field changes with the grid (plan section 2.2): `area` position and footprint × gridScale, `point`
 *  one exact cell, `path` an ordered list of cells (missing cells inserted), `growth` the growth history's own rule,
 *  `text` coordinates inside text, `fixed` a field with cells that keeps its value (atlas, inventory sentinel). */
export type GridClass = "area" | "point" | "path" | "growth" | "text" | "fixed";

/** Every entry type a world or region space holds, with its coordinate fields by path (`a.b` a nested field, `a[]`
 *  every element of a list); `{}`: no coordinates. Item typeclasses (WorldDef.typeclasses) are classed as `Item`. */
export const GRID_CLASSES: Record<string, Record<string, GridClass>> = {
	// areas
	Site: { "x,y,w,h": "area" },
	Building: { "x,y,w,h": "area" },
	Ruin: { "x,y,w,h": "area" },
	Scenery: { "x,y,w,h": "area" },
	Bed: { "x,y,w,h": "area", "plants[].x,y": "point" },
	Field: { "x,y,w,h": "area" },
	Tree: { "x,y,w,h": "area" },
	Zone: { "x,y,w,h": "area" },
	Motion: { "zone.x,y,w,h": "area" },
	MillLoad: { "x,y,w,h": "area" },
	SiteOrder: { "x,y,w,h": "area" },
	Beacon: { "x,y": "area" },
	Exit: { "x,y": "area", "arrive.x,y": "point" },
	Room: { "building.x,y,w,h": "area", "spawn.x,y": "point", "map.x,y": "fixed" },
	// cell points
	Character: { "x,y": "point", "aboard.spot.x,y": "point" },
	Handover: { "character.x,y": "point", "character.aboard.spot.x,y": "point" },
	Spot: { "x,y": "point" },
	Item: { "x,y": "point" },
	Animal: { "x,y": "point" },
	Cart: { "x,y": "point" },
	Plot: { "x,y": "point" },
	// paths and the growth history
	Route: { "cells[].x,y": "path" },
	Road: { "cells[].x,y": "path" },
	RoomGrowth: { "east,south,baseWidth,baseHeight,steps[].at,size,fill": "growth" },
	// coordinates in text
	Intent: { line: "text" },
	NpcMemory: { text: "text" },
	Msg: { text: "text" },
	Notice: { text: "text" },
	// no coordinates
	...Object.fromEntries([
		"Account", "ActorToken", "BeamRest", "BedCommons", "Blessing", "ChatBlock", "ChatGroup", "ChatInvite", "ChatKey", "ChatMember",
		"ChatMsg", "ChatReport", "ChatWait", "Contribution", "Courier", "Credential", "Deed", "Epoch", "Estate", "FireBuilder",
		"FireChain", "Flame", "Fog", "Freight", "GridFormat", "HelpEntry", "LightUse", "Listing", "LlmCount", "LlmStatus", "Loan",
		"IslandLock", "Lock", "Migrated", "ModelInfo", "NameAlias", "NpcAwake", "NpcBorn", "NpcOwner", "NpcVisit", "Offer", "Order", "ParkCare",
		"Passage", "Process", "Prototype", "Rested", "Restock", "RoomLock", "Sated", "SceneryGone", "Season", "SeedRest", "Session",
		"Setting", "Settlement", "SettlementName", "ShopOrder", "Show", "ShowEntry", "Sleep", "StoreLog", "Tag", "Think",
		"Thought", "Translate", "Travel", "Variety", "Vote", "Wanted", "WebSession", "Wind", "WorkRest", "WorldClock",
		"WorldEvent", "WorldLoaded", "WorldSchedule",
	].map((t) => [t, {}])),
};

/** The row of GRID_CLASSES an entry type is classed by: its own, or `Item` for a typeclass below Item; none: unknown. */
export function classRow(type: string, typeclasses: Record<string, string | null>): string | null {
	const seen = new Set<string>();
	for (let t: string | null | undefined = type; t && !seen.has(t); t = typeclasses[t]) {
		if (GRID_CLASSES[t]) return t;
		seen.add(t);
	}
	return null;
}

/** Why a store cannot be run by this binary, or null. `marker`: the store's GridFormat entries; `types`: the entry
 *  types it holds. */
export function gridRefusal(w: { id: string; gridScale?: number; derivedFrom?: number; typeclasses: Record<string, string | null> }, markers: GridFormatFields[], types: string[]): string | null {
	const scale = w.gridScale ?? 1;
	if (scale !== SUPPORTED_FORMAT.gridScale) return `the world definition has gridScale ${scale}; this binary runs gridScale ${SUPPORTED_FORMAT.gridScale} only`;
	if (markers.length > 1) return `the store holds ${markers.length} GridFormat entries; it is damaged, restore it from its backup`;
	const m = markers[0];
	if (m) {
		if (m.worldId !== w.id) return `the store's grid format is of the world ${m.worldId}, not ${w.id}`;
		if (m.state !== "complete") return `a grid migration of this store has not finished (GridFormat state ${m.state}): run the migration again from its backup`;
		if (m.gridScale !== SUPPORTED_FORMAT.gridScale || m.occupancy !== SUPPORTED_FORMAT.occupancy) return `the store is in the grid format gridScale ${m.gridScale}, occupancy ${m.occupancy}; this binary runs gridScale ${SUPPORTED_FORMAT.gridScale}, occupancy ${SUPPORTED_FORMAT.occupancy} only (a store migrated by the grid switch needs the binaries of its cut)`;
		if ((m.derivedFrom ?? null) !== (w.derivedFrom ?? null)) return `the store's geometry is derived from scale ${m.derivedFrom ?? "none"}, the world definition's from ${w.derivedFrom ?? "none"}`;
	}
	const unknown = types.filter((t) => classRow(t, w.typeclasses) === null).sort();
	if (unknown.length) return `the store holds entry types without a grid class: ${unknown.join(", ")} (shared/grid-format.ts GRID_CLASSES)`;
	return null;
}
