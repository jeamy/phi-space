//! Beaming (`server/engine/commands/beam.ts`): from wherever one stands to the room of a burning fire, for coins per field
//! of distance on the world map and with a pause after it, from the epoch the admin sets (beam.cost, beam.cooldown,
//! beam.epoch). A target in another region is reached by the handover, which comes with regions.
use std::cmp::Ordering;

use phi_json::{obj, Json};

use super::build::{human, plural};
use super::default::{crossing, describe_room, drop_offers, place_in, relocate};
use super::epoch::need_epoch;
use super::trade::consume;
use crate::clock::world_now_of;
use crate::context::{inventory, msg, room_of, Ctx, MsgOpts};
use crate::fire::{flame_of, is_lit, key_text};
use crate::j;
use crate::js;
use crate::settings::setting;
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, FOREVER, NO_WAIT};
use crate::travel::count_trip;

fn txt(v: &Json) -> String { key_text(v) }

struct Target { fire: Json, room: Json, cost: f64, lit: Option<bool> }

fn room_of_id<'a>(w: &'a Json, id: &str) -> Option<&'a Json> { j::by(j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")), "roomId", id) }
/// `fieldsBetween`: fields of distance on the world map between two rooms, at least one.
pub fn fields_between(a: Option<&Json>, b: Option<&Json>) -> f64 {
	match (a.map(|a| j::at(a, "map")).filter(|m| j::truthy(m)), b.map(|b| j::at(b, "map")).filter(|m| j::truthy(m))) {
		(Some(a), Some(b)) => 1f64.max((j::n(a, "x") - j::n(b, "x")).abs() + (j::n(a, "y") - j::n(b, "y")).abs()),
		_ => 1.0,
	}
}
fn norm(s: &str) -> String {
	let d: String = js::nfkd(&js::lower(s)).chars().filter(|c| !('\u{300}'..='\u{36f}').contains(c)).collect();
	js::trim(&js::re(r"[^a-z0-9]+", "g").replace(&d, " ")).to_owned()
}

/// `targets`: every other fire of the world with what it costs from here; `lit` is known for this region's fires only.
async fn targets(c: &Ctx, now: f64) -> Result<Vec<Target>> {
	let per = setting(&c.space, "beam.cost").await?;
	let from = room_of_id(c.w(), c.room()).cloned();
	let here: Vec<String> = j::a(c.w(), "beacons").iter().map(|b| txt(j::at(b, "beaconId"))).collect();
	let mut out = Vec::new();
	for fire in j::ao(c.w(), "allBeacons").unwrap_or(j::a(c.w(), "beacons")) {
		let Some(room) = room_of_id(c.w(), j::s(fire, "room")).cloned() else { continue };
		if j::s(fire, "room") == c.room() { continue; }
		let id = txt(j::at(fire, "beaconId"));
		let lit = if here.contains(&id) { Some(is_lit(flame_of(&c.space, &id, c.txn()).await?.as_ref(), now)) } else { None };
		out.push(Target { fire: fire.clone(), cost: per * fields_between(from.as_ref(), Some(&room)), room, lit });
	}
	out.sort_by(|a, b| a.cost.partial_cmp(&b.cost).unwrap_or(Ordering::Equal).then_with(|| js::locale_compare(j::s(&a.room, "name"), j::s(&b.room, "name"))));
	Ok(out)
}
fn place(t: &Target) -> String { let island = j::s(&t.room, "island"); format!("{}{}", txt(j::at(&t.room, "name")), if island.is_empty() { String::new() } else { format!(" ({island})") }) }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key { "beam" => beam(c, arg).await, k => Err(Error::Other(format!("unported: beam/{k}"))) }
}

async fn beam(c: &mut Ctx, arg: &str) -> Result<()> {
	if !human(c) { return refuse("Beamen können nur Menschen."); }
	need_epoch(c, Some(setting(&c.space, "beam.epoch").await?), "Das Beamen").await?;
	let now = world_now_of(&c.space, c.txn()).await?;
	let all = targets(c, now).await?;
	let currency = j::at(c.w(), "currency").clone();
	let coins: Vec<Json> = inventory(c).await?.into_iter().filter(|i| *j::at(fields(i), "proto") == currency).collect();
	let me = c.char_id().to_owned();
	let rest = c.space.peek(&tmpl("BeamRest", obj! { "charId" => me.as_str() }), None).await?;
	let until = rest.as_ref().map_or(0.0, |r| j::n(fields(r), "untilWorldMs"));
	let minutes = || phi_json::number_text(1f64.max(js::round((until - now) / 60_000.0)));
	let have = coins.len() as f64;
	if js::trim(arg).is_empty() {
		let mut lines = vec![format!("Hierhin kannst du beamen (zu einem brennenden Feuer; du trägst {}{}):", plural(have, "Münze", "Münzen"), if until > now { format!("; die Pause dauert noch etwa {} Minuten", minutes()) } else { String::new() })];
		for t in &all { lines.push(format!("  {}: {}{}  – beam {}", place(t), plural(t.cost, "Münze", "Münzen"), if t.lit == Some(false) { " (das Feuer ist aus)" } else { "" }, txt(j::at(&t.room, "name")))); }
		return msg(c, &me, "info", &lines.join("\n"), MsgOpts::default()).await;
	}
	let want = norm(arg);
	let mut found: Vec<&Target> = all.iter().filter(|t| [txt(j::at(&t.fire, "beaconId")), txt(j::at(&t.room, "roomId")), txt(j::at(&t.room, "name")), txt(j::at(&t.fire, "name"))].iter().any(|n| norm(n) == want)).collect();
	if found.is_empty() { found = all.iter().filter(|t| [txt(j::at(&t.room, "name")), txt(j::at(&t.fire, "name")), j::s(&t.room, "island").to_owned()].iter().any(|n| norm(n).contains(&want))).collect(); }
	if found.is_empty() { return not_understood(format!("Dorthin führt kein Feuer: „{}“. „beam“ zeigt die Ziele.", js::slice16(js::trim(arg), 0, Some(30)))); }
	if found.len() > 1 { return refuse(format!("Meinst du {}? Schreib den Ort genauer.", found.iter().take(5).map(|t| place(t)).collect::<Vec<_>>().join(" oder "))); }
	let t = found[0];
	let name = txt(j::at(&t.room, "name"));
	if until > now { return refuse(format!("Du hast eben erst gebeamt; in etwa {} Minuten wieder.", minutes())); }
	if t.lit == Some(false) { return refuse(format!("Das Feuer in {name} ist aus; beamen kann man nur zu einem brennenden Feuer.")); }
	if have < t.cost { return refuse(format!("Nach {name} zu beamen kostet {}, du hast {}.", plural(t.cost, "Münze", "Münzen"), phi_json::number_text(have))); }
	for coin in coins.iter().take(t.cost as usize) { consume(c, fields(coin), &me).await?; }
	let pause = setting(&c.space, "beam.cooldown").await? * 60_000.0;
	if let Some(r) = &rest { c.space.take_if_exists(&obj! { "id" => j::at(r, "id").clone() }, NO_WAIT, c.txn()).await?; }
	if pause > 0.0 { c.space.write(&tmpl("BeamRest", obj! { "charId" => me.as_str(), "untilWorldMs" => now + pause }), c.txn(), FOREVER).await?; }
	count_trip(c, "beam").await?;
	msg(c, "*", "info", "$you() $conj(löst|löst) $conj(dich|sich) auf.", MsgOpts { templ: true, ..Default::default() }).await?;
	let landing = (j::n(&t.fire, "x"), j::n(&t.fire, "y") + 1.0);
	let room_id = j::s(&t.room, "roomId").to_owned();
	let to_region = crossing(c.w(), &room_id)?;
	drop_offers(c).await?;
	if to_region.is_some() { return Err(Error::Other("unported: handOff".into())); }
	let dest = room_of(c, Some(&room_id)).await?;
	let at = place_in(c, &dest, landing, false, &[]).await?;
	let dest_id = j::s(&dest, "roomId").to_owned();
	relocate(c, &dest_id, at, false, None).await?;
	msg(c, "*", "info", "$you() $conj(erscheinst|erscheint) im Licht des Feuers.", MsgOpts { templ: true, room: Some(dest_id.clone()), ..Default::default() }).await?;
	let text = describe_room(c, &dest_id, true).await?;
	msg(c, &me, "look", &text, MsgOpts { room: Some(dest_id), ..Default::default() }).await
}
