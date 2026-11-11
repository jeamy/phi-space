//! Sleep (`server/engine/commands/sleep.ts`, docs/innenraeume.en.md "Sleep", step 2): `schlafe` beside the bed of a hut
//! one may go into lays the figure down. Asleep it does nothing: the next command it sends only wakes it. The sleep
//! gives rested works, one per `sleep.rate` world minutes slept, at most `sleep.max` (with what was left from before);
//! a rested work writes no rest after it (build.rs / field.rs `tire`), so sleep puts the tiredness off.
//!
//! - `Sleep` (one per figure): where it lies and since when; looked for only when the actor is in an interior.
//! - `Rested` (one per figure): how many rested works are left; gone when they are used up.
//! - Put out of the house (ausladen, the building gone: interior.rs) wakes the figure there.
use phi_json::obj;

use super::build::{dist_to, Rect};
use super::interior::{furnishing_for, is_interior, near_buildings};
use crate::clock::world_now_of;
use crate::context::{msg, to_player, Ctx, MsgOpts};
use crate::fire::key_text as txt;
use crate::j;
use crate::js;
use crate::settings::setting;
use crate::source::time_now;
use crate::space::{fields, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn nt(n: f64) -> String { phi_json::number_text(n) }
fn works(n: f64) -> String { if n == 1.0 { "eine Arbeit".to_owned() } else { format!("{} Arbeiten", nt(n)) } }

/// What a wake gives: how long it slept, the rested works it has now and how many it gained.
pub struct Woke { pub slept: f64, pub left: f64, pub gained: f64 }

/// `wake`: wakes `char_id` if it sleeps; its rested works grow by the time slept and its rest after the last work is
/// over. None when it did not sleep.
pub async fn wake(space: &Space, txn: &str, char_id: &str) -> Result<Option<Woke>> {
	let Some(e) = space.take_if_exists(&tmpl("Sleep", obj! { "charId" => char_id }), NO_WAIT, Some(txn)).await? else { return Ok(None) };
	let s = fields(&e).clone();
	let now = world_now_of(space, Some(txn)).await?;
	let rate = 1f64.max(setting(space, "sleep.rate").await?) * 60_000.0;
	let max = setting(space, "sleep.max").await?;
	let slept = 0f64.max(now - j::n(&s, "sinceWorldMs"));
	let gained = (slept / rate).floor();
	let held = space.take_if_exists(&tmpl("Rested", obj! { "charId" => char_id }), NO_WAIT, Some(txn)).await?;
	let before = held.as_ref().map_or(0.0, |h| j::n(fields(h), "left"));
	let left = before.max(max.min(before + gained));
	if left > 0.0 {
		space.write(&tmpl("Rested", obj! { "charId" => char_id, "left" => left }), Some(txn), FOREVER).await?;
		// whoever wakes rested is not tired from the work before it lay down
		if gained > 0.0 { space.take_if_exists(&tmpl("WorkRest", obj! { "charId" => char_id }), NO_WAIT, Some(txn)).await?; }
	}
	Ok(Some(Woke { slept, left, gained: left - before }))
}

/// `wokeText`.
fn woke_text(w: &Woke) -> String {
	let mins = js::round(w.slept / 60_000.0);
	let long = if mins >= 120.0 { format!("{} Stunden", nt(js::round(mins / 60.0))) } else { format!("{} Minuten", nt(mins)) };
	if w.left == 0.0 { return format!("Du wachst auf nach {long} Schlaf; das war zu kurz, um ausgeruht zu sein."); }
	format!("Du wachst auf nach {long} Schlaf. Ausgeruht: {} ohne Pause danach.", works(w.left))
}

/// `wakeOutside`: wakes a figure put out of a house, told as a notice; it stands outside already.
pub async fn wake_outside(space: &Space, txn: &str, char_id: &str, room: &str) -> Result<()> {
	if let Some(w) = wake(space, txn, char_id).await? {
		to_player(space, &obj! { "room" => room, "to" => char_id, "kind" => "info", "text" => woke_text(&w), "from" => "", "fromId" => "", "at" => time_now() }, Some(txn)).await?;
	}
	Ok(())
}


/// `wokenBy`: an actor asleep (only inside a house) is woken by whatever it sends, and nothing else is done; true when
/// it woke.
pub async fn woken_by(c: &mut Ctx, line: &str) -> Result<bool> {
	if !is_interior(c.room()) || js::re(r"^(schlafe|schlafen|sleep)\b", "i").test(line) { return Ok(false); }
	let txn = c.txn.clone();
	let me = c.char_id().to_owned();
	let Some(w) = wake(&c.space, &txn, &me).await? else { return Ok(false) };
	msg(c, &me, "info", &woke_text(&w), MsgOpts::default()).await?;
	Ok(true)
}

/// `spendRested`: a work point of a rested figure spends one rested work and writes no rest; true then.
pub async fn spend_rested(c: &Ctx) -> Result<bool> {
	let Some(e) = c.space.peek(&tmpl("Rested", obj! { "charId" => c.char_id() }), None).await? else { return Ok(false) };
	let Some(t) = c.space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, c.txn()).await? else { return Ok(false) };
	let left = j::n(fields(&t), "left") - 1.0;
	if left > 0.0 { c.space.write(&tmpl("Rested", obj! { "charId" => c.char_id(), "left" => left }), c.txn(), FOREVER).await?; }
	let me = c.char_id().to_owned();
	let text = if left > 0.0 { format!("Ausgeruht: noch {} ohne Pause.", works(left)) } else { "Das war die letzte Arbeit ohne Pause; nach der nächsten ruhst du wieder.".to_owned() };
	msg(c, &me, "info", &text, MsgOpts::default()).await?;
	Ok(true)
}

async fn schlafe(c: &mut Ctx) -> Result<()> {
	let Some(bed) = furnishing_for(c, "sleep").await? else { return refuse("Schlafen kann man im Bett einer Hütte; geh hinein („betrete“ neben ihr).") };
	let bname = txt(j::at(&bed, "name"));
	if near_buildings(c, Some("sleep")).await?.is_empty() || dist_to((j::n(&c.actor, "x"), j::n(&c.actor, "y")), Rect::of(&bed)) > 1.0 { return refuse(format!("Geh zum {bname}.")); }
	if c.space.peek(&tmpl("Sleep", obj! { "charId" => c.char_id() }), None).await?.is_some() { return refuse("Du schläfst schon."); }
	if let Some(other) = c.space.read_all(&tmpl("Sleep", obj! { "bed" => j::at(&bed, "sceneryId").clone() }), None).await?.first() {
		return refuse(format!("Im {bname} schläft schon {}.", txt(j::at(fields(other), "name"))));
	}
	let now = world_now_of(&c.space, c.txn()).await?;
	let rate = 1f64.max(setting(&c.space, "sleep.rate").await?);
	let max = setting(&c.space, "sleep.max").await?;
	let f = obj! { "charId" => c.char_id(), "name" => j::at(&c.actor, "name").clone(), "room" => c.room(), "bed" => j::at(&bed, "sceneryId").clone(), "sinceWorldMs" => now };
	c.space.write(&tmpl("Sleep", f), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(legst|legt) $conj(dich|sich) ins {bname} und $conj(schläfst|schläft) ein."), MsgOpts { templ: true, ..MsgOpts::default() }).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("Je {} Minuten Schlaf arbeitest du danach einmal ohne Pause, bis {}; jeder Befehl weckt dich.", nt(rate), nt(max)), MsgOpts::default()).await
}

pub async fn run(c: &mut Ctx, key: &str, _arg: &str) -> Result<()> {
	match key {
		"schlafe" => schlafe(c).await,
		k => Err(Error::Other(format!("unported: sleep/{k}"))),
	}
}

