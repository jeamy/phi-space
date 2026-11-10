//! The large ship (`server/engine/commands/passage.ts`), so far what a figure aboard is refused and the tick that lands
//! the figures whose time has come by an intent, `board` and `ausschiffen`.
use phi_json::{obj, Json};

use crate::clock::world_now_of;
use super::default::{crossing, place_in, relocate};
use crate::context::{msg, room_of, Ctx, MsgOpts};
use crate::js;
use crate::liner::{liner_of, next_stop};
use crate::occupancy::release_spot;
use crate::travel::count_trip;
use crate::j;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

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

/// `board`: goes aboard; the figure is hidden from the room and walks no more until the ship has reached `to`.
pub async fn board(c: &mut Ctx, to: &str, island: &str, spot: &Json, arrive: f64, from: Option<&str>) -> Result<()> {
	count_trip(c, "ship").await?;
	let now = world_now_of(&c.space, c.txn()).await?;
	msg(c, "*", "info", &format!("$you() $conj(gehst|geht) an Bord, nach {island}."), MsgOpts { templ: true, ..Default::default() }).await?;
	let Some(e) = c.space.take(&tmpl("Character", obj! { "charId" => c.char_id() }), 5_000.0, c.txn()).await? else { return refuse("Deine Figur ist gerade nicht greifbar; bitte noch einmal.") };
	let mut ch = fields(&e).clone();
	let mut aboard = obj! { "to" => to, "island" => island, "spot" => spot.clone(), "arriveWorldMs" => arrive };
	if let Some(f) = from { j::set(&mut aboard, "from", Json::from(f)); }
	j::set(&mut ch, "aboard", aboard);
	if let Some(s) = &c.step { j::set(&mut ch, "ack", s.clone()); }
	c.space.write(&tmpl("Character", ch), c.txn(), FOREVER).await?;
	let me = c.char_id().to_owned();
	release_spot(&c.space, &c.txn, &me).await?;
	c.space.write(&tmpl("Passage", obj! { "charId" => me.as_str(), "to" => to, "arriveWorldMs" => arrive }), c.txn(), FOREVER).await?;
	msg(c, &me, "info", &format!("Das Schiff legt ab. Du fährst nach {island}, Ankunft in etwa {} Weltminuten.", phi_json::number_text(mins(arrive - now))), MsgOpts::default()).await
}

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"ausschiffen" => ausschiffen(c, arg).await,
		k => Err(Error::Other(format!("unported: passage/{k}"))),
	}
}

/// `toNextStop`: a passenger leaves at the next stop on the way instead; its destination becomes that stop.
async fn to_next_stop(c: &mut Ctx, a: &Json, now: f64) -> Result<Json> {
	let Some(t) = liner_of(c.w()) else { return refuse("In dieser Welt gibt es keinen Fahrplan.") };
	let Some((_, stop, in_ms)) = next_stop(&t, now, j::so(a, "from"), j::s(a, "to")) else {
		return refuse(format!("Der nächste Halt ist schon dein Ziel: {}, in etwa {} Weltminuten.", crate::fire::key_text(j::at(a, "island")), phi_json::number_text(mins(j::n(a, "arriveWorldMs") - now))));
	};
	let bay = j::by(j::ao(c.w(), "allRooms").unwrap_or(j::a(c.w(), "rooms")), "roomId", &stop.room).cloned();
	let mut to = a.clone();
	j::set(&mut to, "to", Json::from(stop.room.as_str()));
	j::set(&mut to, "island", Json::from(stop.island.as_str()));
	let spot = bay.as_ref().and_then(|b| j::opt(b, "spawn")).filter(|s| !s.is_null()).cloned().unwrap_or_else(|| j::at(a, "spot").clone());
	j::set(&mut to, "spot", spot);
	j::set(&mut to, "arriveWorldMs", Json::from(now + in_ms));
	if in_ms > 0.0 {
		let Some(e) = c.space.take(&tmpl("Character", obj! { "charId" => c.char_id() }), 5_000.0, c.txn()).await? else { return refuse("Deine Figur ist gerade nicht greifbar; bitte noch einmal.") };
		let mut ch = fields(&e).clone();
		j::set(&mut ch, "aboard", to.clone());
		c.space.write(&tmpl("Character", ch), c.txn(), FOREVER).await?;
		let me = c.char_id().to_owned();
		c.space.take_if_exists(&tmpl("Passage", obj! { "charId" => me.as_str() }), NO_WAIT, c.txn()).await?;
		c.space.write(&tmpl("Passage", obj! { "charId" => me.as_str(), "to" => j::at(&to, "to").clone(), "arriveWorldMs" => j::at(&to, "arriveWorldMs").clone() }), c.txn(), FOREVER).await?;
		msg(c, &me, "info", &format!("Du steigst beim nächsten Halt aus: {}, in etwa {} Weltminuten.", stop.island, phi_json::number_text(mins(in_ms))), MsgOpts::default()).await?;
	}
	Ok(to)
}

async fn ausschiffen(c: &mut Ctx, arg: &str) -> Result<()> {
	let mut a = j::at(&c.actor, "aboard").clone();
	if !j::truthy(&a) { return refuse("Du bist nicht an Bord eines Schiffs."); }
	let now = world_now_of(&c.space, c.txn()).await?;
	// the next stop on the way: the destination moves there; lying there now, the figure lands at once
	if js::re(r"^(n(ä|ae|a)chste[rnm]?|next|halt|hier)\b", "i").test(js::trim(arg)) { a = to_next_stop(c, &a, now).await?; if now < j::n(&a, "arriveWorldMs") { return Ok(()); } }
	if now < j::n(&a, "arriveWorldMs") { return refuse(aboard_text(c).await?); }
	// the figure is free again: no longer aboard, the passage entry gone, then to the bay
	let Some(e) = c.space.take(&tmpl("Character", obj! { "charId" => c.char_id() }), 5_000.0, c.txn()).await? else { return refuse("Deine Figur ist gerade nicht greifbar; bitte noch einmal.") };
	c.space.write(&tmpl("Character", j::without(fields(&e), "aboard")), c.txn(), FOREVER).await?;
	let me = c.char_id().to_owned();
	c.space.take_if_exists(&tmpl("Passage", obj! { "charId" => me.as_str() }), NO_WAIT, c.txn()).await?;
	let to = j::s(&a, "to").to_owned();
	if crossing(c.w(), &to)?.is_some() { return Err(Error::Other("unported: handOff".into())); }
	let dest = room_of(c, Some(&to)).await?;
	let spot = j::at(&a, "spot");
	let cell = place_in(c, &dest, (j::n(spot, "x"), j::n(spot, "y")), false, &[]).await?;
	let dest_id = j::s(&dest, "roomId").to_owned();
	relocate(c, &dest_id, cell, false, None).await?;
	msg(c, "*", "info", &format!("$you() $conj(kommst|kommt) in {} an.", crate::fire::key_text(j::at(&a, "island"))), MsgOpts { templ: true, room: Some(dest_id), ..Default::default() }).await
}

/// `passageTick` : the landings whose time has come, as intents of the figures. How many were sent.
pub async fn passage_tick(space: &Space, _lease_ms: f64) -> Result<f64> {
	let passages = space.read_all(&obj! { "type" => "Passage" }, None).await?;
	if passages.is_empty() { return Ok(0.0); }
	let now = world_now_of(space, None).await?;
	let mut sent = 0.0;
	for e in &passages {
		let p = fields(e);
		if j::n(p, "arriveWorldMs") > now || space.count(&tmpl("Intent", obj! { "charId" => j::at(p, "charId").clone() }), None).await? != 0.0 { continue; }
		space.write(&tmpl("Intent", obj! { "intentId" => hex(&random_bytes(8)), "charId" => j::at(p, "charId").clone(), "line" => "ausschiffen", "at" => time_now() }), None, 30_000.0).await?;
		sent += 1.0;
	}
	Ok(sent)
}
