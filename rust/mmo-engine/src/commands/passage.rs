//! The large ship (`server/engine/commands/passage.ts`), so far what a figure aboard is refused.
use crate::context::Ctx;
use crate::j;
use crate::space::Result;

const ABOARD: [&str; 12] = ["look", "inventory", "who", "time", "reputation", "help", "fahrplan", "ausschiffen", "say", "emote", "epoche", "wetter"];
/// `mayAboard`.
pub fn may_aboard(key: &str) -> bool { ABOARD.contains(&key) }

fn mins(ms: f64) -> f64 { 1f64.max((ms / 60_000.0).ceil()) }

/// `aboardText`.
pub async fn aboard_text(c: &Ctx) -> Result<String> {
	let a = j::at(&c.actor, "aboard");
	let now = crate::clock::world_now_of(&c.space, c.txn()).await?;
	Ok(format!("Du bist an Bord und fährst nach {}, Ankunft in etwa {} Weltminuten.", crate::fire::key_text(j::at(a, "island")), phi_json::number_text(mins(j::n(a, "arriveWorldMs") - now))))
}
