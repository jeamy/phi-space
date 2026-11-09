//! Food (`server/engine/commands/food.ts`): `iss` eats a thing and keeps the figure sated for a while, the better food the
//! longer; whoever is sated rests less after work.
use phi_json::{obj, Json};

use super::trade::consume;
use crate::clock::world_now_of;
use crate::context::{inventory, items_named, msg, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::space::{fields, not_understood, refuse, tmpl, Result, FOREVER, NO_WAIT};

/// `satedFactor`: 1 when the actor is not sated.
pub async fn sated_factor(c: &Ctx, now: f64) -> Result<f64> {
	let Some(d) = j::opt(c.w(), "food") else { return Ok(1.0) };
	let e = c.space.peek(&tmpl("Sated", obj! { "charId" => c.char_id() }), None).await?;
	Ok(if e.is_some_and(|e| j::n(fields(&e), "untilWorldMs") > now) { j::n(d, "restFactor") } else { 1.0 })
}

/// The names of `protos` as the world calls them.
pub fn proto_names<'a>(w: &Json, protos: impl Iterator<Item = &'a str>) -> String {
	protos.map(|p| j::a(w, "prototypes").iter().find(|x| j::s(x, "key") == p).map_or_else(|| p.to_owned(), |x| key_text(j::at(x, "name")))).collect::<Vec<_>>().join(", ")
}

/// `iss`.
pub async fn iss(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "food").cloned() else { return refuse("In dieser Welt isst man nicht.") };
	let foods = j::object(j::at(&d, "foods"));
	let names = proto_names(c.w(), foods.keys());
	let a = js::trim(arg).to_owned();
	if a.is_empty() { return not_understood(format!("Was isst du? Satt machen: {names}.")); }
	let inv = inventory(c).await?;
	let Some(it) = items_named(c.w(), &inv, &a, None).into_iter().next() else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&a, 0, Some(30)))) };
	let f = fields(&it).clone();
	let ms = foods.get(j::s(&f, "proto")).and_then(Json::as_f64).unwrap_or(0.0);
	if ms == 0.0 || ms.is_nan() { return refuse(format!("{} macht nicht satt. Das tun: {names}.", key_text(j::at(&f, "name")))); }
	let me = c.char_id().to_owned();
	consume(c, &f, &me).await?;
	let now = world_now_of(&c.space, c.txn()).await?;
	let held = c.space.take_if_exists(&tmpl("Sated", obj! { "charId" => me.as_str() }), NO_WAIT, c.txn()).await?;
	let from = held.map_or(now, |h| now.max(j::n(fields(&h), "untilWorldMs")));
	c.space.write(&tmpl("Sated", obj! { "charId" => me.as_str(), "untilWorldMs" => (now + j::n(&d, "maxWorldMs")).min(from + ms) }), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(isst|isst) {}.", key_text(j::at(&f, "name"))), MsgOpts { templ: true, ..Default::default() }).await
}
