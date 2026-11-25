//! The rule values in cells (`shared/rules.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.4,
//! docs/raster-inventur-2026-11-24.en.md section 1): every distance, radius and path bound of the engine, written in
//! scale-1 cells and scaled to the grid this binary runs. A length × gridScale, an area × gridScale². The rows and their
//! places are those of the TypeScript table; tests/rules.test.ts holds the two together (each constant here is
//! `length(v)` or `area(v)` with the TypeScript row's value). Rows the engine does not use (the client's, the arena's)
//! are here too, so the tables stay one.
use crate::grid_format::SUPPORTED_SCALE;

const fn length(v: f64) -> f64 { v * SUPPORTED_SCALE }
#[allow(dead_code)]
const fn area(v: f64) -> f64 { v * SUPPORTED_SCALE * SUPPORTED_SCALE }

/// stand beside an object, distTo <= (30 places in the server: build, animals, interior, fishing, chapel, festival, mill, quarry, townhall, cart, wild; the refusing form > in sleep.ts and shop.ts); the ring beside, 1 to BESIDE (build.ts besideRects, npc/economy.ts stepBeside); the client's pre-checks
pub const BESIDE: f64 = length(1.0);
/// reach a point: pick up an item (default.ts take), the own cart (cart.ts), the client's fetch
pub const REACH_POINT: f64 = length(1.0);
/// close enough to feed a fire (default.ts put, > is too far; npc/settlers.ts, npc/economy.ts, npc/requests.ts; the client walks there first)
pub const FEED_FIRE: f64 = length(1.0);
/// no building this close to a fire (build.ts)
pub const FIRE_CLEARANCE: f64 = length(1.0);
/// the cells around an exit that stay free (occupancy.ts isPassage, the client's copy)
pub const PASSAGE: f64 = length(1.0);
/// reach to a site, tree, bed, scenery, mill load, road part (build.ts SITE_REACH and its uses)
pub const SITE_REACH: f64 = length(2.0);
/// belongs beside an exit (build.ts EXIT_REACH)
pub const EXIT_REACH: f64 = length(2.0);
/// a settler's new place keeps this far from exits and fires (npc/settlers.ts)
pub const SETTLER_CLEARANCE: f64 = length(2.0);
/// a building moves to a place within this of the old one (build.ts moveCandidates, > is too far)
pub const MOVE_BUILDING: f64 = length(3.0);
/// the window around the old place the move candidates are looked for in (build.ts moveCandidates)
pub const MOVE_WINDOW: f64 = length(2.0);
/// a flower crosses with a plant within this, Manhattan, not on its cell (garden.ts)
pub const FLOWER_NEIGHBOUR: f64 = length(1.0);
/// the nearest free cell is looked for within this (occupancy.ts freeCellNear and its callers)
pub const FREE_CELL_RADIUS: f64 = length(8.0);
/// the steps of a command-bound path (world.ts findPath: default.ts move, the step check, and the other callers)
pub const COMMAND_PATH: f64 = length(40.0);
/// a new character starts this far beside the spawn, across (accounts.ts)
pub const SPAWN_SCATTER_X: f64 = length(3.0);
/// the same, down (accounts.ts)
pub const SPAWN_SCATTER_Y: f64 = length(2.0);
/// an idle NPC wanders this far across (npc/economy.ts; its clamp to the base room's inner edge is not a length, inventory 1.3)
pub const NPC_WANDER_X: f64 = length(4.0);
/// the same, down (npc/economy.ts)
pub const NPC_WANDER_Y: f64 = length(3.0);
/// the path of a bot's drawn trail (arena.ts)
pub const ARENA_TRAIL_PATH: f64 = length(400.0);
/// a bot's subgoal is reached within this, Manhattan (arena.ts SUBGOAL_NEAR)
pub const ARENA_SUBGOAL_NEAR: f64 = length(3.0);
/// the trail steps an arena run keeps (arena.ts MAX_TRAIL; the same walk takes twice the steps at scale 2)
pub const ARENA_MAX_TRAIL: f64 = length(20_000.0);
/// the client's menu offers a road or the own figure within this (client/cellActions.ts, client/MapView.tsx)
pub const MENU_NEAR: f64 = length(2.0);
/// a tap on an occupied cell looks for a free one within this (client/walk.ts chooseTarget)
pub const TARGET_RINGS: f64 = length(6.0);

/// `onRing`: on the ring beside a footprint, not on it and within BESIDE (at scale 1 exactly 1).
pub fn on_ring(d: f64) -> bool { (1.0..=BESIDE).contains(&d) }
/// `flowerNeighbour`: within FLOWER_NEIGHBOUR, Manhattan, not on the same cell (at scale 1 exactly 1).
pub fn flower_neighbour(d: f64) -> bool { (1.0..=FLOWER_NEIGHBOUR).contains(&d) }
