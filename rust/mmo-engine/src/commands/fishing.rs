//! Fishing and the water (`server/engine/commands/fishing.ts`): `wirf netz` beside a jetty, rowing between the jetties of an
//! island, sailing to another island, a boat's hatch, sand from the beach, and the large ship's timetable with
//! `einschiffen`. Crossing into another region (sailing to a bay there) comes with regions.
use phi_json::{obj, Json};

use super::build::{amount, dist_to, give_back, plan_of, rested, tire, Rect};
use super::default::{crossing, place_in, relocate};
use super::passage::board;
use super::trade::{consume, move_item};
use crate::clock::world_now_of;
use crate::context::{inventory, items_named, msg, room_of, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::liner::{liner_of, ship_comes, ship_state};
use crate::source::random_int;
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result};
use crate::travel::count_trip;

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }
fn templ_in(room: &str) -> MsgOpts { MsgOpts { templ: true, room: Some(room.to_owned()), ..Default::default() } }
fn mins(ms: f64) -> String { nt(1f64.max((ms / 60_000.0).ceil())) }
fn rooms_of(w: &Json) -> &[Json] { j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")) }
fn dative(c: &Ctx, plan: &str) -> String { plan_of(c.w(), plan).and_then(|p| j::so(p, "dative")).unwrap_or("einem Steg").to_owned() }
fn proto_name(w: &Json, key: &str) -> String { j::by(j::a(w, "prototypes"), "key", key).map_or_else(|| key.to_owned(), |p| txt(j::at(p, "name"))) }

/// `weighted`: one of `xs` by its weight.
fn weighted(xs: &[Json]) -> Json {
	let mut r = random_int(0.0, xs.iter().fold(0.0, |n, x| n + j::n(x, "weight")));
	xs.iter().find(|x| { r -= j::n(x, "weight"); r < 0.0 }).cloned().unwrap_or(Json::Null)
}
/// Whether a building of `plan` stands right beside the actor in its room.
async fn beside(c: &Ctx, plan: &str) -> Result<bool> {
	let me = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	Ok(c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan }), None).await?.iter().any(|e| dist_to(me, Rect::of(fields(e))) <= 1.0))
}
async fn carries(c: &mut Ctx, proto: &Json) -> Result<bool> { Ok(inventory(c).await?.iter().any(|i| j::at(fields(i), "proto") == proto)) }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"wirf" => wirf(c, arg).await,
		"rudere" => rudere(c, arg).await,
		"segle" => segle(c, arg).await,
		"luke" => luke(c, arg).await,
		"fahrplan" => fahrplan(c).await,
		"einschiffen" => einschiffen(c, arg).await,
		"schaufle" => schaufle(c).await,
		k => Err(Error::Other(format!("unported: fishing/{k}"))),
	}
}

async fn wirf(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "fishing").cloned() else { return refuse("In dieser Welt wird nicht gefischt.") };
	if !js::trim(arg).is_empty() && !js::re(r"^(?:(?:das\s+)?netz|net)$", "i").test(js::trim(arg)) { return not_understood("So geht es: wirf netz"); }
	let plan = j::s(&d, "plan").to_owned();
	if !beside(c, &plan).await? { return refuse(format!("Das Netz wirft man direkt neben {} aus.", dative(c, &plan))); }
	if !carries(c, j::at(&d, "net")).await? { return refuse("Dafür brauchst du ein Netz."); }
	let (now, rest) = rested(c).await?;
	let got = weighted(j::a(&d, "catch"));
	let proto = txt(j::at(&got, "proto"));
	give_back(c, &[(proto.clone(), 1.0)]).await?;
	tire(c, now, rest.as_ref()).await?;
	msg(c, "*", "info", &format!("$you() $conj(ziehst|zieht) {} aus dem Wasser.", proto_name(c.w(), &proto)), templ()).await
}

async fn rudere(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = j::opt(c.w(), "boat").filter(|d| j::truthy(d)).cloned();
	let plan = j::opt(c.w(), "fishing").map(|f| txt(j::at(f, "plan")));
	let (Some(d), Some(plan)) = (d, plan) else { return refuse("In dieser Welt gibt es keine Boote.") };
	if !carries(c, j::at(&d, "proto")).await? { return refuse("Dafür brauchst du ein Ruderboot."); }
	let island = j::by(j::a(c.w(), "rooms"), "roomId", c.room()).map(|r| j::at(r, "island").clone());
	let jetties: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "plan" => plan.as_str() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let me = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if !jetties.iter().any(|b| j::s(b, "room") == c.room() && dist_to(me, Rect::of(b)) <= 1.0) { return refuse(format!("Abgelegt wird direkt neben {}.", dative(c, &plan))); }
	let there: Vec<Json> = j::a(c.w(), "rooms").iter().filter(|r| Some(j::at(r, "island").clone()) == island && j::s(r, "roomId") != c.room() && jetties.iter().any(|b| j::at(b, "room") == j::at(r, "roomId"))).cloned().collect();
	let list = there.iter().map(|r| txt(j::at(r, "name"))).collect::<Vec<_>>().join(", ");
	let word = js::lower(js::trim(arg));
	let me_id = c.char_id().to_owned();
	if word.is_empty() { return msg(c, &me_id, "info", &if there.is_empty() { "Auf dieser Insel gibt es keinen anderen Steg.".to_owned() } else { format!("Stege gibt es in: {list}.") }, MsgOpts::default()).await; }
	let Some(to) = there.iter().find(|r| js::lower(j::s(r, "name")) == word || j::s(r, "roomId") == word).cloned() else {
		return not_understood(format!("Dorthin führt kein Steg.{}", if there.is_empty() { String::new() } else { format!(" Stege gibt es in: {list}.") }));
	};
	let jetty = jetties.iter().find(|b| j::at(b, "room") == j::at(&to, "roomId")).cloned().unwrap_or(Json::Null);
	let dest = room_of(c, Some(j::s(&to, "roomId"))).await?;
	let at = place_in(c, &dest, (j::n(&jetty, "x"), j::n(&jetty, "y") + 1.0), false, &[]).await?;
	count_trip(c, "row").await?;
	msg(c, "*", "info", &format!("$you() $conj(ruderst|rudert) nach {}.", txt(j::at(&to, "name"))), templ()).await?;
	let dest_id = j::s(&dest, "roomId").to_owned();
	relocate(c, &dest_id, at, false, None).await?;
	msg(c, "*", "info", "$you() $conj(legst|legt) am Steg an.", templ_in(&dest_id)).await
}

async fn schaufle(c: &mut Ctx) -> Result<()> {
	let Some(d) = j::opt(c.w(), "sand").filter(|d| j::truthy(d)).cloned() else { return refuse("In dieser Welt gibt es keinen Sand.") };
	let room = room_of(c, None).await?;
	let (x, y) = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let row = j::a(&room, "ground").get(y as usize).filter(|_| y >= 0.0 && y.fract() == 0.0).map(txt);
	let cell = row.and_then(|r| if x >= 0.0 && x.fract() == 0.0 { js::slice16(&r, x as isize, Some(x as isize + 1)).to_owned().into() } else { None }).filter(|s: &String| !s.is_empty());
	if cell.as_deref() != Some(j::s(&d, "tile")) { return refuse("Sand gräbt man am Strand."); }
	if !carries(c, j::at(&d, "tool")).await? { return refuse("Dafür brauchst du einen Spaten."); }
	let (now, rest) = rested(c).await?;
	let count = j::n(&d, "count");
	give_back(c, &[(txt(j::at(&d, "makes")), count)]).await?;
	tire(c, now, rest.as_ref()).await?;
	msg(c, "*", "info", &format!("$you() $conj(gräbst|gräbt) {} Sand aus dem Strand.", nt(count)), templ()).await
}

async fn segle(c: &mut Ctx, arg: &str) -> Result<()> {
	let sail = j::opt(c.w(), "boat").and_then(|b| j::opt(b, "sail")).filter(|s| j::truthy(s)).cloned();
	let plan = j::opt(c.w(), "fishing").map(|f| txt(j::at(f, "plan")));
	let (Some(sail), Some(plan)) = (sail, plan) else { return refuse("In dieser Welt gibt es keine Segelboote.") };
	if !carries(c, &sail).await? { return refuse("Dafür brauchst du ein Segelboot."); }
	if !beside(c, &plan).await? { return refuse(format!("Abgelegt wird direkt neben {}.", dative(c, &plan))); }
	let rooms = rooms_of(c.w()).to_vec();
	let mine = j::by(&rooms, "roomId", c.room()).map(|r| j::s(r, "island").to_owned());
	let mut islands: Vec<String> = Vec::new();
	for r in &rooms { let i = j::s(r, "island"); if !i.is_empty() && Some(i) != mine.as_deref() && !islands.iter().any(|x| x == i) { islands.push(i.to_owned()); } }
	let word = js::lower(js::trim(arg));
	let Some(to) = islands.iter().find(|i| js::lower(i) == word).cloned() else {
		if !word.is_empty() { return not_understood(format!("Eine Insel „{}“ kennt niemand. Es gibt: {}.", js::slice16(js::trim(arg), 0, Some(30)), islands.join(", "))); }
		let me = c.char_id().to_owned();
		return msg(c, &me, "info", &format!("Du kannst segeln nach: {}.", islands.join(", ")), MsgOpts::default()).await;
	};
	// the first room of the island that has a spawn: a bay; the world's bays are written first
	let bay = rooms.iter().find(|r| j::s(r, "island") == to && j::truthy(j::at(r, "spawn"))).cloned().unwrap_or(Json::Null);
	let spawn = (j::n(j::at(&bay, "spawn"), "x"), j::n(j::at(&bay, "spawn"), "y"));
	count_trip(c, "sail").await?;
	msg(c, "*", "info", &format!("$you() $conj(setzt|setzt) Segel nach {to}."), templ()).await?;
	let (now, rest) = rested(c).await?;
	tire(c, now, rest.as_ref()).await?;
	let bay_id = j::s(&bay, "roomId").to_owned();
	if crossing(c.w(), &bay_id)?.is_some() { return Err(Error::Other("unported: handOff".into())); }
	let dest = room_of(c, Some(&bay_id)).await?;
	let cell = place_in(c, &dest, spawn, false, &[]).await?;
	let dest_id = j::s(&dest, "roomId").to_owned();
	relocate(c, &dest_id, cell, false, None).await?;
	msg(c, "*", "info", &format!("$you() $conj(legst|legt) in {to} an."), templ_in(&dest_id)).await
}

async fn luke(c: &mut Ctx, arg: &str) -> Result<()> {
	let hatch = j::opt(c.w(), "boat").and_then(|b| j::opt(b, "hatch")).filter(|h| j::truthy(h)).cloned();
	let plan = j::opt(c.w(), "fishing").map(|f| txt(j::at(f, "plan")));
	let (Some(hatch), Some(plan)) = (hatch, plan) else { return refuse("In dieser Welt haben Boote keine Luke.") };
	let size = |p: &Json| j::no(&hatch, &txt(p)).filter(|n| *n != 0.0);
	let pack: Vec<Json> = inventory(c).await?.iter().map(|e| fields(e).clone()).collect();
	// the larger hatch first: a sailing boat before a rowing boat
	let mut boats: Vec<&Json> = pack.iter().filter(|i| size(j::at(i, "proto")).is_some()).collect();
	boats.sort_by(|a, b| size(j::at(b, "proto")).unwrap_or(0.0).partial_cmp(&size(j::at(a, "proto")).unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
	let Some(boat) = boats.first().map(|b| (*b).clone()) else { return refuse("Dafür brauchst du ein Boot.") };
	let cap = size(j::at(&boat, "proto")).unwrap_or(0.0);
	let boat_id = j::s(&boat, "itemId").to_owned();
	let boat_name = txt(j::at(&boat, "name"));
	let held: Vec<Json> = c.space.read_all(&tmpl("Item", obj! { "location" => boat_id.as_str() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect();
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = parts.first().cloned().unwrap_or_default();
	let what = parts.iter().skip(1).cloned().collect::<Vec<_>>().join(" ");
	let me = c.char_id().to_owned();
	if word.is_empty() {
		let mut names: Vec<(String, usize)> = Vec::new();
		for i in &held { let n = txt(j::at(i, "name")); match names.iter_mut().find(|(x, _)| *x == n) { Some(e) => e.1 += 1, None => names.push((n, 1)) } }
		let list = if held.is_empty() { "nichts".to_owned() } else { names.iter().map(|(n, k)| if *k > 1 { format!("{k}× {n}") } else { n.clone() }).collect::<Vec<_>>().join(", ") };
		return msg(c, &me, "info", &format!("In der Luke von {boat_name} ({}/{}): {list}.", held.len(), nt(cap)), MsgOpts::default()).await;
	}
	let load = js::re(r"^(?:lade|laden|load)$", "i").test(&word);
	if load && what.is_empty() { return not_understood("Was soll in die Luke? luke lade [n|alle] <ding>"); }
	if !load && !js::re(r"^(?:entlade|entladen|unload)$", "i").test(&word) { return not_understood("So geht es: luke, luke lade <ding>, luke entlade <ding>."); }
	if !beside(c, &plan).await? { return refuse(format!("Be- und entladen wird direkt neben {}.", dative(c, &plan))); }
	// „alle“ alone: everything (unloading, also without a word); else as with a chest: [n|alle] <ding>
	let everything = js::re(r"^(?:alle?|all)$", "i").test(&what) || (!load && what.is_empty());
	let (n, name) = if everything { (None, String::new()) } else { amount(&what) };
	let entries: Vec<Json> = if load { inventory(c).await?.into_iter().filter(|e| size(j::at(fields(e), "proto")).is_none()).collect() } else { held.iter().map(|f| obj! { "fields" => f.clone() }).collect() };
	let hits: Vec<Json> = if everything { entries.clone() } else { let h = items_named(c.w(), &entries, &name, None); match h.first() { Some(h0) => entries.iter().filter(|i| j::at(fields(i), "proto") == j::at(fields(h0), "proto")).cloned().collect(), None => Vec::new() } };
	if hits.is_empty() { return not_understood(if load { format!("Du trägst nichts, was „{}“ heißt (ein Boot passt in keine Luke).", js::slice16(&name, 0, Some(30))) } else { format!("In der Luke ist nichts, was „{}“ heißt.", js::slice16(&name, 0, Some(30))) }); }
	let want = n.unwrap_or(hits.len() as f64);
	let k = want.min(hits.len() as f64).min(if load { cap - held.len() as f64 } else { hits.len() as f64 });
	if k <= 0.0 { return refuse(format!("Die Luke ist voll ({}).", nt(cap))); }
	let k = k as usize;
	for i in hits.iter().take(k) { if load { move_item(c, fields(i), &me, &boat_id, &[]).await?; } else { move_item(c, fields(i), &boat_id, &me, &[]).await?; } }
	let mut kinds: Vec<String> = Vec::new();
	for i in hits.iter().take(k) { let nm = txt(j::at(fields(i), "name")); if !kinds.contains(&nm) { kinds.push(nm); } }
	let kinds = kinds.join(", ");
	let text = if load { format!("Du lädst {k}× {kinds} in die Luke von {boat_name}.{}", if want > k as f64 { " Mehr passt nicht hinein." } else { "" }) } else { format!("Du holst {k}× {kinds} aus der Luke von {boat_name}.") };
	msg(c, &me, "info", &text, MsgOpts::default()).await
}

async fn fahrplan(c: &mut Ctx) -> Result<()> {
	let d = j::opt(c.w(), "liner").filter(|d| j::truthy(d)).cloned();
	let (Some(d), Some(t)) = (d, liner_of(c.w())) else { return refuse("In dieser Welt gibt es keinen Fahrplan.") };
	let now = world_now_of(&c.space, c.txn()).await?;
	let s = ship_state(&t, now);
	let here = t.stops.iter().position(|x| x.room == c.room());
	let where_ = match s.lies { Some(l) => format!("Das große Schiff liegt in {}, noch etwa {} Weltminuten.", t.stops[l].island, mins(s.left_ms)), None => format!("Das große Schiff fährt von {} nach {} und kommt in etwa {} Weltminuten an.", t.stops[s.from].island, t.stops[s.to].island, mins(s.left_ms)) };
	let mine = match here { None => String::new(), Some(h) if s.lies == Some(h) => " Hier legt es gerade an: „einschiffen <insel>“ fährt mit.".to_owned(), Some(h) => format!(" Hier liegt es in etwa {} Weltminuten.", mins(ship_comes(&t, now, h))) };
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{where_}{mine} Es läuft an: {} und wieder von vorn, die Fahrt kostet {} Münzen; die Fähren fahren jederzeit.", t.stops.iter().map(|x| x.island.clone()).collect::<Vec<_>>().join(" → "), txt(j::at(&d, "fare"))), MsgOpts::default()).await
}

async fn einschiffen(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = j::opt(c.w(), "liner").filter(|d| j::truthy(d)).cloned();
	let (Some(d), Some(t)) = (d, liner_of(c.w())) else { return refuse("In dieser Welt gibt es keinen Fahrplan.") };
	let word = js::lower(js::trim(arg));
	let Some(here) = t.stops.iter().position(|x| x.room == c.room()) else { return refuse("Das Schiff legt nur in den Buchten an.") };
	let now = world_now_of(&c.space, c.txn()).await?;
	let wait = ship_comes(&t, now, here);
	if wait != 0.0 { return refuse(format!("Das Schiff liegt nicht hier; es kommt erst in etwa {} Weltminuten.", mins(wait))); }
	let Some(to) = t.stops.iter().enumerate().position(|(i, x)| i != here && js::lower(&x.island) == word) else {
		return not_understood(format!("Das Schiff fährt nach: {}.", t.stops.iter().enumerate().filter(|(i, _)| *i != here).map(|(_, x)| x.island.clone()).collect::<Vec<_>>().join(", ")));
	};
	let fare = j::n(&d, "fare");
	let currency = j::at(c.w(), "currency").clone();
	let purse: Vec<Json> = inventory(c).await?.into_iter().filter(|i| *j::at(fields(i), "proto") == currency).collect();
	if (purse.len() as f64) < fare { return refuse(format!("Die Fahrt kostet {} Münzen.", nt(fare))); }
	let me = c.char_id().to_owned();
	for m in purse.iter().take(fare as usize) { consume(c, fields(m), &me).await?; }
	let stop = t.stops[to].clone();
	let rooms = rooms_of(c.w()).to_vec();
	let bay = j::by(&rooms, "roomId", &stop.room).cloned().unwrap_or(Json::Null);
	let spawn = j::at(&bay, "spawn").clone();
	// the passenger stays aboard until the ship lies at the island: it is the time of the loop, not a jump
	let from = c.room().to_owned();
	board(c, &stop.room, &stop.island, &spawn, now + ship_comes(&t, now, to), Some(&from)).await
}
