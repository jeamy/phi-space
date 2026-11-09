//! The chapel (`server/engine/commands/chapel.ts`): beside one, anyone's, `opfere` gives up a thing of worth for a blessing:
//! for a world day the rest after work is half as long.
use phi_json::obj;

use super::build::{dist_to, plan_of, Rect};
use super::food::proto_names;
use super::trade::consume;
use crate::clock::world_now_of;
use crate::context::{inventory, items_named, msg, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::space::{fields, not_understood, refuse, tmpl, Result, FOREVER, NO_WAIT};

/// `blessed`: whether the actor's blessing still holds.
pub async fn blessed(c: &Ctx, now: f64) -> Result<bool> {
	if j::opt(c.w(), "chapel").is_none() { return Ok(false); }
	Ok(c.space.peek(&tmpl("Blessing", obj! { "charId" => c.char_id() }), None).await?.is_some_and(|e| j::n(fields(&e), "untilWorldMs") > now))
}

/// `opfere`.
pub async fn opfere(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(ch) = j::opt(c.w(), "chapel").cloned() else { return refuse("In dieser Welt gibt es keine Kapellen.") };
	let plan = j::s(&ch, "plan").to_owned();
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let near = c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan.as_str() }), None).await?.iter().any(|e| dist_to(at, Rect::of(fields(e))) <= 1.0);
	if !near { return refuse(format!("Opfern kann man nur direkt neben {}.", plan_of(c.w(), &plan).and_then(|p| j::so(p, "dative")).unwrap_or("einer Kapelle"))); }
	let offerings = j::strs(j::a(&ch, "offerings"));
	let names = proto_names(c.w(), offerings.iter().copied());
	let a = js::trim(arg).to_owned();
	if a.is_empty() { return not_understood(format!("Was opferst du? Willkommen sind: {names}.")); }
	let inv = inventory(c).await?;
	let Some(it) = items_named(c.w(), &inv, &a, None).into_iter().next() else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&a, 0, Some(30)))) };
	let f = fields(&it).clone();
	if !offerings.contains(&j::s(&f, "proto")) { return refuse(format!("{} ist kein Opfer. Willkommen sind: {names}.", key_text(j::at(&f, "name")))); }
	let me = c.char_id().to_owned();
	consume(c, &f, &me).await?;
	let now = world_now_of(&c.space, c.txn()).await?;
	c.space.take_if_exists(&tmpl("Blessing", obj! { "charId" => me.as_str() }), NO_WAIT, c.txn()).await?;
	c.space.write(&tmpl("Blessing", obj! { "charId" => me.as_str(), "untilWorldMs" => now + j::n(&ch, "blessWorldMs") }), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(opferst|opfert) {}. Ein stiller Segen liegt nun auf $you().", key_text(j::at(&f, "name"))), MsgOpts { templ: true, ..Default::default() }).await
}
