//! The entries the engine shares with the other processes (`shared/model.ts`): the ones it names by a fixed template.
use phi_json::{obj, Json};

/// The lock under which the world is loaded and its definition changed (`WORLD_LOCK`).
pub fn world_lock() -> Json { obj! { "type" => "Lock", "fields" => obj! { "name" => "world" } } }
/// The token a worker holds while it runs a command of a character (`actorToken`).
pub fn actor_token(char_id: &str) -> Json { obj! { "type" => "ActorToken", "fields" => obj! { "charId" => char_id } } }
