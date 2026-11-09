//! The chapel (`server/engine/commands/chapel.ts`), so far the blessing other commands ask about.
use phi_json::obj;

use crate::context::Ctx;
use crate::j;
use crate::space::{fields, tmpl, Result};

/// `blessed`: whether the actor's blessing still holds.
pub async fn blessed(c: &Ctx, now: f64) -> Result<bool> {
	if j::opt(c.w(), "chapel").is_none() { return Ok(false); }
	Ok(c.space.peek(&tmpl("Blessing", obj! { "charId" => c.char_id() }), None).await?.is_some_and(|e| j::n(fields(&e), "untilWorldMs") > now))
}
