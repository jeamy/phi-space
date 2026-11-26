//! The rule values in cells (`shared/rules.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 2.4,
//! docs/raster-inventur-2026-11-24.en.md section 1): every distance, radius and path bound of the engine, written in
//! scale-1 cells and scaled to the grid of the world this process runs. A length × gridScale, an area × gridScale². The
//! rows and their places are those of the TypeScript table; tests/rules.test.ts holds the two together (each row here
//! is a function `name() -> f64 { length(v) }` or `area(v)`, the TypeScript name in snake case, with its row's value).
//! Rows the engine does not use (the client's, the arena's) are here too, so the tables stay one.
//!
//! The scale is one per process, as in TypeScript (`useGridScale`): `load_world` sets the loaded world's. Until then it
//! is 1. A test binary whose tests run worlds of both scales runs them in processes of their own.
use std::sync::atomic::{AtomicU64, Ordering};

use crate::grid_format::SUPPORTED_SCALES;

static SCALE: AtomicU64 = AtomicU64::new(0x3FF0_0000_0000_0000); // 1.0

/// The scale the rule values are at (`gridScale()`).
pub fn grid_scale() -> f64 { f64::from_bits(SCALE.load(Ordering::Relaxed)) }

/// `useGridScale`: the rule values at `s`, the scale of the world this process runs; a scale this code does not run is
/// refused.
pub fn use_grid_scale(s: f64) -> Result<(), String> {
	if !SUPPORTED_SCALES.contains(&s) { return Err(format!("gridScale {}: this code runs gridScale 1 or 2 only", phi_json::number_text(s))); }
	SCALE.store(s.to_bits(), Ordering::Relaxed);
	Ok(())
}

fn length(v: f64) -> f64 { v * grid_scale() }
#[allow(dead_code)]
fn area(v: f64) -> f64 { v * grid_scale() * grid_scale() }

/// stand beside an object, distTo <= (30 places in the server: build, animals, interior, fishing, chapel, festival, mill, quarry, townhall, cart, wild; the refusing form > in sleep.ts and shop.ts); the ring beside, 1 to BESIDE (build.ts besideRects, npc/economy.ts stepBeside); the client's pre-checks
pub fn beside() -> f64 { length(1.0) }
/// reach a point: pick up an item (default.ts take), the own cart (cart.ts), the client's fetch
pub fn reach_point() -> f64 { length(1.0) }
/// close enough to feed a fire (default.ts put, > is too far; npc/settlers.ts, npc/economy.ts, npc/requests.ts; the client walks there first)
pub fn feed_fire() -> f64 { length(1.0) }
/// no building this close to a fire (build.ts)
pub fn fire_clearance() -> f64 { length(1.0) }
/// the cells around an exit that stay free (occupancy.ts isPassage, the client's copy)
pub fn passage() -> f64 { length(1.0) }
/// reach to a site, tree, bed, scenery, mill load, road part (build.ts SITE_REACH and its uses)
pub fn site_reach() -> f64 { length(2.0) }
/// belongs beside an exit (build.ts EXIT_REACH)
pub fn exit_reach() -> f64 { length(2.0) }
/// a settler's new place keeps this far from exits and fires (npc/settlers.ts)
pub fn settler_clearance() -> f64 { length(2.0) }
/// a building moves to a place within this of the old one (build.ts moveCandidates, > is too far)
pub fn move_building() -> f64 { length(3.0) }
/// the window around the old place the move candidates are looked for in (build.ts moveCandidates)
pub fn move_window() -> f64 { length(2.0) }
/// a flower crosses with a plant within this, Manhattan, not on its cell (garden.ts)
pub fn flower_neighbour() -> f64 { length(1.0) }
/// the nearest free cell is looked for within this (occupancy.ts freeCellNear and its callers)
pub fn free_cell_radius() -> f64 { length(8.0) }
/// the steps of a command-bound path (world.ts findPath: default.ts move, the step check, and the other callers)
pub fn command_path() -> f64 { length(40.0) }
/// a new character starts this far beside the spawn, across (accounts.ts)
pub fn spawn_scatter_x() -> f64 { length(3.0) }
/// the same, down (accounts.ts)
pub fn spawn_scatter_y() -> f64 { length(2.0) }
/// an idle NPC wanders this far across (npc/economy.ts; its clamp to the base room's inner edge is not a length, inventory 1.3)
pub fn npc_wander_x() -> f64 { length(4.0) }
/// the same, down (npc/economy.ts)
pub fn npc_wander_y() -> f64 { length(3.0) }
/// the path of a bot's drawn trail (arena.ts)
pub fn arena_trail_path() -> f64 { length(400.0) }
/// a bot's subgoal is reached within this, Manhattan (arena.ts SUBGOAL_NEAR)
pub fn arena_subgoal_near() -> f64 { length(3.0) }
/// the trail steps an arena run keeps (arena.ts MAX_TRAIL; the same walk takes twice the steps at scale 2)
pub fn arena_max_trail() -> f64 { length(20_000.0) }
/// the client's menu offers a road or the own figure within this (client/cellActions.ts, client/MapView.tsx)
pub fn menu_near() -> f64 { length(2.0) }
/// a tap on an occupied cell looks for a free one within this (client/walk.ts chooseTarget)
pub fn target_rings() -> f64 { length(6.0) }
/// the cells one numbered step covers, on one axis (default.ts step and the gateways' step check): at scale 2 two consecutive cells, the same physical step
pub fn step_length() -> f64 { length(1.0) }

/// `onRing`: on the ring beside a footprint, not on it and within BESIDE (at scale 1 exactly 1).
pub fn on_ring(d: f64) -> bool { (1.0..=beside()).contains(&d) }
/// `flowerNeighbour`: within FLOWER_NEIGHBOUR, Manhattan, not on the same cell (at scale 1 exactly 1).
pub fn is_flower_neighbour(d: f64) -> bool { (1.0..=flower_neighbour()).contains(&d) }
/// `bedCapacity`: the plants a bed of `w` × `h` cells holds, as many as the same physical bed at scale 1 (`w·h / gridScale²`).
pub fn bed_capacity(w: f64, h: f64) -> f64 { let s = grid_scale(); (w * h / (s * s)).floor() }

