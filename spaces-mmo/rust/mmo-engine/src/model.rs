//! The entries the engine shares with the other processes (`shared/model.ts`): the ones it names by a fixed template.
use phi_json::{obj, Json};

/// The lock under which the world is loaded and its definition changed (`WORLD_LOCK`).
pub fn world_lock() -> Json { obj! { "type" => "Lock", "fields" => obj! { "name" => "world" } } }
/// A growth run's turn before new commands (`GROWTH_TURN`): while one is visible the world workers start no command.
pub fn growth_turn() -> Json { obj! { "type" => "GrowthTurn" } }
/// The token a worker holds while it runs a command of a character (`actorToken`).
pub fn actor_token(char_id: &str) -> Json { obj! { "type" => "ActorToken", "fields" => obj! { "charId" => char_id } } }
