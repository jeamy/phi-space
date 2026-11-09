//! Scenery that stands in the way (`server/engine/commands/scenery.ts`): `räume` clears a piece beside one, work by work;
//! the last stroke frees its cells, gives what was in it and leaves a mark so that no new world version brings it back.
use phi_json::{obj, Json};

use super::build::{dist_to, free_cells, give_back, rested, tire, Rect, SITE_REACH};
use super::settlement::need_rank;
use crate::context::{msg, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::space::{fields, not_understood, refuse, tmpl, Result, FOREVER, NO_WAIT};

async fn nearby(c: &Ctx, arg: &str) -> Result<Json> {
	let at = js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(arg));
	let me = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let here: Vec<Json> = c.space.read_all(&tmpl("Scenery", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|s| !j::truthy(j::at(s, "through")) && dist_to(me, Rect::of(s)) <= SITE_REACH).collect();
	let hit = match at {
		Some(m) => { let p = (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[2].as_deref().unwrap_or(""))); here.iter().find(|s| dist_to(p, Rect::of(s)) == 0.0) }
		None => here.iter().find(|s| !j::truthy(j::at(s, "fixed"))).or(here.first()),
	};
	match hit { Some(h) => Ok(h.clone()), None => not_understood("Hier steht nichts zum Abräumen. Stell dich neben eine alte Hütte, ein Boot, ein Netzgestell oder Fässer.") }
}

/// `räume`.
pub async fn raeume(c: &mut Ctx, arg: &str) -> Result<()> {
	need_rank(c, "helfer", "Abräumen").await?;
	let (now, rest) = rested(c).await?;
	let s = nearby(c, arg).await?;
	let name = key_text(j::at(&s, "name"));
	if j::truthy(j::at(&s, "fixed")) { return refuse(format!("{name} gehört fest hierher und bleibt stehen.")); }
	if c.space.take_if_exists(&tmpl("Scenery", obj! { "sceneryId" => j::at(&s, "sceneryId").clone() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Daran arbeitet gerade jemand; gleich noch einmal."); }
	tire(c, now, rest.as_ref()).await?;
	let left = j::n(&s, "left") - 1.0;
	let actor = key_text(j::at(&c.actor, "name"));
	if left > 0.0 {
		let mut o = j::object(&s);
		o.insert("left", Json::from(left));
		c.space.write(&tmpl("Scenery", Json::Object(o)), c.txn(), FOREVER).await?;
		return msg(c, "*", "emote", &format!("{actor} räumt auf: {name}, noch {} Mal anpacken.", phi_json::number_text(left)), MsgOpts::default()).await;
	}
	free_cells(&c.space, &c.txn, j::s(&s, "room"), j::at(&s, "sceneryId")).await?;
	c.space.write(&tmpl("SceneryGone", obj! { "sceneryId" => j::at(&s, "sceneryId").clone() }), c.txn(), FOREVER).await?;
	let yields: Vec<(String, f64)> = j::a(&s, "yields").iter().map(|y| (key_text(j::at(y, "proto")), j::n(y, "count"))).collect();
	let got = give_back(c, &yields).await?;
	msg(c, "*", "info", &format!("{actor} hat {name} abgeräumt; das Land ist frei.{}", if got.is_empty() { String::new() } else { format!(" Für {actor}: {}.", got.join(", ")) }), MsgOpts::default()).await
}
