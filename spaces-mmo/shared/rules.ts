// The rule values in cells (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.4, docs/raster-inventur-2026-11-24.en.md
// section 1): every distance, radius and path bound of the code in one table, written in scale-1 cells with its kind and
// its places. A `length` scales with gridScale, an `area` with its square; the constants below are the table at the
// scale of the world this process runs: 1 until `useGridScale` sets the loaded world's (server/engine/world.ts
// loadWorld; on the page the gateway's hello), so the cut changes one number in the world definition, not every literal.
// They are live bindings (`export let`): an importer reads the current value at each use, so no module may copy one
// into a constant of its own at load time.
// Values of the world definition (growth.*, field.*, wild.scareReach, …) are not here: world:json scales those, and a
// value is in one place only. The Rust engine keeps the same table as rust/mmo-engine/src/rules.rs
// (tests/rules.test.ts holds the two together). Distances are Chebyshev unless a row says otherwise.
import { SUPPORTED_SCALES } from "./grid-format.ts";

export type RuleKind = "length" | "area";
export type RuleRow = { value: number; kind: RuleKind; places: string };

export const RULE_TABLE = {
	BESIDE: { value: 1, kind: "length", places: "stand beside an object, distTo <= (30 places in the server: build, animals, interior, fishing, chapel, festival, mill, quarry, townhall, cart, wild; the refusing form > in sleep.ts and shop.ts); the ring beside, 1 to BESIDE (build.ts besideRects, npc/economy.ts stepBeside); the client's pre-checks" },
	REACH_POINT: { value: 1, kind: "length", places: "reach a point: pick up an item (default.ts take), the own cart (cart.ts), the client's fetch" },
	FEED_FIRE: { value: 1, kind: "length", places: "close enough to feed a fire (default.ts put, > is too far; npc/settlers.ts, npc/economy.ts, npc/requests.ts; the client walks there first)" },
	FIRE_CLEARANCE: { value: 1, kind: "length", places: "no building this close to a fire (build.ts)" },
	PASSAGE: { value: 1, kind: "length", places: "the cells around an exit that stay free (occupancy.ts isPassage, the client's copy)" },
	SITE_REACH: { value: 2, kind: "length", places: "reach to a site, tree, bed, scenery, mill load, road part (build.ts SITE_REACH and its uses)" },
	EXIT_REACH: { value: 2, kind: "length", places: "belongs beside an exit (build.ts EXIT_REACH)" },
	SETTLER_CLEARANCE: { value: 2, kind: "length", places: "a settler's new place keeps this far from exits and fires (npc/settlers.ts)" },
	MOVE_BUILDING: { value: 3, kind: "length", places: "a building moves to a place within this of the old one (build.ts moveCandidates, > is too far)" },
	MOVE_WINDOW: { value: 2, kind: "length", places: "the window around the old place the move candidates are looked for in (build.ts moveCandidates)" },
	FLOWER_NEIGHBOUR: { value: 1, kind: "length", places: "a flower crosses with a plant within this, Manhattan, not on its cell (garden.ts)" },
	FREE_CELL_RADIUS: { value: 8, kind: "length", places: "the nearest free cell is looked for within this (occupancy.ts freeCellNear and its callers)" },
	COMMAND_PATH: { value: 40, kind: "length", places: "the steps of a command-bound path (world.ts findPath: default.ts move, the step check, and the other callers)" },
	SPAWN_SCATTER_X: { value: 3, kind: "length", places: "a new character starts this far beside the spawn, across (accounts.ts)" },
	SPAWN_SCATTER_Y: { value: 2, kind: "length", places: "the same, down (accounts.ts)" },
	NPC_WANDER_X: { value: 4, kind: "length", places: "an idle NPC wanders this far across (npc/economy.ts; its clamp to the base room's inner edge is not a length, inventory 1.3)" },
	NPC_WANDER_Y: { value: 3, kind: "length", places: "the same, down (npc/economy.ts)" },
	ARENA_TRAIL_PATH: { value: 400, kind: "length", places: "the path of a bot's drawn trail (arena.ts)" },
	ARENA_SUBGOAL_NEAR: { value: 3, kind: "length", places: "a bot's subgoal is reached within this, Manhattan (arena.ts SUBGOAL_NEAR)" },
	ARENA_MAX_TRAIL: { value: 20_000, kind: "length", places: "the trail steps an arena run keeps (arena.ts MAX_TRAIL; the same walk takes twice the steps at scale 2)" },
	MENU_NEAR: { value: 2, kind: "length", places: "the client's menu offers a road or the own figure within this (client/cellActions.ts, client/MapView.tsx)" },
	TARGET_RINGS: { value: 6, kind: "length", places: "a tap on an occupied cell looks for a free one within this (client/walk.ts chooseTarget)" },
} as const satisfies Record<string, RuleRow>;

export type RuleName = keyof typeof RULE_TABLE;

/** A rule's value at `scale` (plan section 2.4): a length × scale, an area × scale². */
export function ruleAt(name: RuleName, scale: number): number {
	const r: RuleRow = RULE_TABLE[name];
	return r.value * (r.kind === "area" ? scale * scale : scale);
}

let scale = 1;
const at = (name: RuleName) => ruleAt(name, scale);

export let BESIDE = at("BESIDE"), REACH_POINT = at("REACH_POINT"), FEED_FIRE = at("FEED_FIRE");
export let FIRE_CLEARANCE = at("FIRE_CLEARANCE"), PASSAGE = at("PASSAGE");
export let SITE_REACH = at("SITE_REACH"), EXIT_REACH = at("EXIT_REACH"), SETTLER_CLEARANCE = at("SETTLER_CLEARANCE");
export let MOVE_BUILDING = at("MOVE_BUILDING"), MOVE_WINDOW = at("MOVE_WINDOW"), FLOWER_NEIGHBOUR = at("FLOWER_NEIGHBOUR");
export let FREE_CELL_RADIUS = at("FREE_CELL_RADIUS"), COMMAND_PATH = at("COMMAND_PATH");
export let SPAWN_SCATTER_X = at("SPAWN_SCATTER_X"), SPAWN_SCATTER_Y = at("SPAWN_SCATTER_Y"), NPC_WANDER_X = at("NPC_WANDER_X"), NPC_WANDER_Y = at("NPC_WANDER_Y");
export let ARENA_TRAIL_PATH = at("ARENA_TRAIL_PATH"), ARENA_SUBGOAL_NEAR = at("ARENA_SUBGOAL_NEAR"), ARENA_MAX_TRAIL = at("ARENA_MAX_TRAIL");
export let MENU_NEAR = at("MENU_NEAR"), TARGET_RINGS = at("TARGET_RINGS");

/** The scale the constants above are at. */
export const gridScale = (): number => scale;

/** Sets the constants above to the table at `s`, the scale of the world this process runs (one per process: a server
 *  loads one world, the page talks to one gateway). A scale this code does not support is refused. */
export function useGridScale(s: number): void {
	if (!SUPPORTED_SCALES.includes(s)) throw new Error(`gridScale ${s}: this code runs gridScale ${SUPPORTED_SCALES.join(" or ")} only`);
	scale = s;
	BESIDE = at("BESIDE"); REACH_POINT = at("REACH_POINT"); FEED_FIRE = at("FEED_FIRE");
	FIRE_CLEARANCE = at("FIRE_CLEARANCE"); PASSAGE = at("PASSAGE");
	SITE_REACH = at("SITE_REACH"); EXIT_REACH = at("EXIT_REACH"); SETTLER_CLEARANCE = at("SETTLER_CLEARANCE");
	MOVE_BUILDING = at("MOVE_BUILDING"); MOVE_WINDOW = at("MOVE_WINDOW"); FLOWER_NEIGHBOUR = at("FLOWER_NEIGHBOUR");
	FREE_CELL_RADIUS = at("FREE_CELL_RADIUS"); COMMAND_PATH = at("COMMAND_PATH");
	SPAWN_SCATTER_X = at("SPAWN_SCATTER_X"); SPAWN_SCATTER_Y = at("SPAWN_SCATTER_Y"); NPC_WANDER_X = at("NPC_WANDER_X"); NPC_WANDER_Y = at("NPC_WANDER_Y");
	ARENA_TRAIL_PATH = at("ARENA_TRAIL_PATH"); ARENA_SUBGOAL_NEAR = at("ARENA_SUBGOAL_NEAR"); ARENA_MAX_TRAIL = at("ARENA_MAX_TRAIL");
	MENU_NEAR = at("MENU_NEAR"); TARGET_RINGS = at("TARGET_RINGS");
}

/** On the ring beside a footprint: not on it, within BESIDE (at scale 1 exactly 1; inventory 1.3, decision for phase 1). */
export const onRing = (d: number) => d >= 1 && d <= BESIDE;
/** A flower's neighbour: within FLOWER_NEIGHBOUR, Manhattan, not on its cell (at scale 1 exactly 1; inventory 1.3). */
export const flowerNeighbour = (d: number) => d >= 1 && d <= FLOWER_NEIGHBOUR;
