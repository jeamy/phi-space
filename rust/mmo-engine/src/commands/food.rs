//! Food (`server/engine/commands/food.ts`), so far how much shorter a sated figure rests.
use phi_json::obj;

use crate::context::Ctx;
use crate::j;
use crate::space::{fields, tmpl, Result};

/// `satedFactor`: 1 when the actor is not sated.
pub async fn sated_factor(c: &Ctx, now: f64) -> Result<f64> {
	let Some(d) = j::opt(c.w(), "food") else { return Ok(1.0) };
	let e = c.space.peek(&tmpl("Sated", obj! { "charId" => c.char_id() }), None).await?;
	Ok(if e.is_some_and(|e| j::n(fields(&e), "untilWorldMs") > now) { j::n(d, "restFactor") } else { 1.0 })
}
