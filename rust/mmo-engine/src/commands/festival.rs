//! Festivals (`server/engine/commands/festival.ts`): settlers open a flower show, a harvest festival or a regatta at a
//! park; whoever likes shows a thing (`zeige`); the show ends in the epoch job (`show_tick`) with the winner's prize as an
//! estate; `pflege` sets a flower into the park once a day (the rank of the settlements counts who tended it).
use phi_json::{obj, Json};

use super::build::{dist_to, plan_of, Rect};
use super::settlement::{huts_in, rank_of, settlement_in};
use super::trade::consume;
use crate::clock::{decay_now_of, season_now, world_now_of};
use crate::context::{inventory, items_named, msg, msg_transient, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::{hex, random_bytes, random_int, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::worldtime::SEASONS;

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn name_of(kind: &str) -> &'static str { match kind { "blumen" => "Blumenschau", "ernte" => "Erntefest", _ => "Regatta" } }
/// The seasons of each festival, by `SEASONS`.
fn allowed(kind: &str) -> &'static [f64] { match kind { "blumen" => &[0.0, 1.0], "ernte" => &[2.0], _ => &[0.0, 1.0, 2.0] } }
/// A boat is worth twice its rower: the sailing boat over the rowing boat, then the wind and the crew.
const REGATTA_CREW: f64 = 2.0;
fn def_of(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "festival") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt gibt es keine Feste.") } }
/// `flowers`: what the garden's ornamental sorts yield.
pub fn flowers(w: &Json) -> Vec<String> { j::a(j::at(w, "garden"), "sorts").iter().filter(|s| j::s(s, "kind") == "zier").map(|s| txt(j::at(j::at(s, "yields"), "proto"))).collect() }
/// `crops`: what the fields yield, without seed.
pub fn crops(w: &Json) -> Vec<String> { j::a(j::at(w, "fields"), "crops").iter().flat_map(|x| j::a(x, "yields").iter().map(|y| txt(j::at(y, "proto")))).filter(|p| !p.starts_with("samen-")).collect() }
fn members(c: &Ctx) -> Result<Json> {
	match &c.account { Some(a) if !j::b(a, "guest") => Ok(a.clone()), _ => refuse("Gäste machen hier nicht mit; registriere dich dafür.") }
}
fn place_of(d: &Json, kind: &str) -> String { if kind == "regatta" { j::opt(d, "regatta").map_or_else(|| txt(j::at(d, "plan")), txt) } else { txt(j::at(d, "plan")) } }
async fn park_beside(c: &Ctx, plan: &str) -> Result<bool> {
	let at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	Ok(c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan }), c.txn()).await?.iter().any(|e| dist_to(at, Rect::of(fields(e))) <= 1.0))
}
fn at_park(c: &Ctx, plan: &str) -> String { format!("direkt neben {}", plan_of(c.w(), plan).and_then(|p| j::opt(p, "dative")).map_or_else(|| "einem Park".to_owned(), txt)) }
/// What a flower is worth at the show: a named sort over a bred one over a wild one.
fn bloom(f: &Json) -> f64 { match j::opt(f, "variety") { Some(v) if j::truthy(v) => if j::b(v, "name") { 3.0 } else { 2.0 }, _ => 1.0 } }
fn ending(d: &Json) -> String { format!("{} Tage", nt(js::round(j::n(d, "showWorldMs") / (24.0 * 3_600_000.0)))) }
async fn entries_of(space: &Space, show_id: &Json, txn: Option<&str>) -> Result<Vec<Json>> {
	Ok(space.read_all(&tmpl("ShowEntry", obj! { "showId" => show_id.clone() }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}
/// First by score, the earlier of equal ones ahead.
fn ranked(mut xs: Vec<Json>) -> Vec<Json> {
	let sign = |d: f64| if d > 0.0 { std::cmp::Ordering::Greater } else if d < 0.0 { std::cmp::Ordering::Less } else { std::cmp::Ordering::Equal };
	xs.sort_by(|a, b| { let d = j::n(b, "score") - j::n(a, "score"); if d != 0.0 && !d.is_nan() { sign(d) } else { sign(j::n(a, "at") - j::n(b, "at")) } });
	xs
}
fn score_of(s: &Json, x: &Json) -> String { if j::s(s, "kind") == "ernte" { format!(" ({})", txt(j::at(x, "score"))) } else { String::new() } }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"fest" => fest(c, arg).await,
		"zeige" => zeige(c, arg).await,
		"pflege" => pflege(c).await,
		k => Err(Error::Other(format!("unported: festival/{k}"))),
	}
}

async fn fest(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = def_of(c)?;
	let word = js::lower(js::trim(arg));
	let me = c.char_id().to_owned();
	let open = c.space.peek(&tmpl("Show", obj! { "room" => c.room() }), c.txn()).await?;
	if word.is_empty() {
		let Some(open) = open else { return msg(c, &me, "info", "Hier läuft kein Fest. Siedler eröffnen an einem Park eines mit „fest blumen“ oder „fest ernte“.", MsgOpts::default()).await };
		let s = fields(&open).clone();
		let first = ranked(entries_of(&c.space, j::at(&s, "showId"), c.txn()).await?);
		let shown = if first.is_empty() { "noch hat niemand etwas gezeigt".to_owned() } else { first.iter().map(|x| format!("{} mit {}{}", txt(j::at(x, "charName")), txt(j::at(x, "name")), score_of(&s, x))).collect::<Vec<_>>().join(", ") };
		return msg(c, &me, "info", &format!("{} von {}: {shown}. „zeige <ding>“ macht mit.", name_of(j::s(&s, "kind")), txt(j::at(&s, "settlementName"))), MsgOpts::default()).await;
	}
	let kind = if js::re(r"^(?:blumen|blumenschau|flowers)$", "").test(&word) { "blumen" } else if js::re(r"^(?:ernte|erntefest|harvest)$", "").test(&word) { "ernte" } else if j::b(&d, "regatta") && js::re(r"^(?:regatta|race)$", "").test(&word) { "regatta" } else { return not_understood("So eröffnest du eines: fest blumen, fest ernte oder fest regatta.") };
	let account = members(c)?;
	let place = place_of(&d, kind);
	if !park_beside(c, &place).await? { return refuse(format!("{} eröffnet man {}.", if kind == "regatta" { "Eine Regatta" } else { "Dieses Fest" }, at_park(c, &place))); }
	let season = season_now(&c.space, world_now_of(&c.space, c.txn()).await?).await?;
	if let Some(season) = season { if !allowed(kind).contains(&season) { return refuse(format!("{} ist nicht jetzt: {}.", name_of(kind), allowed(kind).iter().map(|i| SEASONS[*i as usize]).collect::<Vec<_>>().join(", "))); } }
	let Some(s) = settlement_in(&c.space, c.room(), c.txn()).await? else { return refuse("Feste feiert eine Siedlung; hier ist keine.") };
	if rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, Some(&account)) != "siedler" { return refuse(format!("Feste eröffnen die Siedler von {}.", txt(j::at(&s, "name")))); }
	if open.is_some() { return refuse("Hier läuft schon ein Fest."); }
	let now = decay_now_of(&c.space, c.txn()).await?;
	if j::no(&s, "showRestWorldMs").unwrap_or(0.0) > now { return refuse(format!("{} hat gerade erst gefeiert; das nächste Fest braucht noch etwas Zeit.", txt(j::at(&s, "name")))); }
	let show = obj! { "showId" => hex(&random_bytes(6)), "room" => j::at(&s, "room").clone(), "settlementId" => j::at(&s, "settlementId").clone(), "settlementName" => j::at(&s, "name").clone(), "kind" => kind, "byName" => j::at(&c.actor, "name").clone(), "endsWorldMs" => now + j::n(&d, "showWorldMs") };
	match c.space.write_unique(&tmpl("Show", show), c.txn(), FOREVER, &["room"]).await {
		Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Hier läuft schon ein Fest."),
		Err(e) => return Err(e),
		Ok(_) => {}
	}
	let what = match kind { "blumen" => "eine Blumenschau", "ernte" => "ein Erntefest", _ => "eine Regatta" };
	let how = if kind == "regatta" { "meldet am Steg, wer mag, sein Boot".to_owned() } else { format!("zeigt am Park, wer mag, {}", if kind == "blumen" { "seine schönste Blume" } else { "seine Ernte" }) };
	msg(c, "*", "world", &format!("{} eröffnet in {} {what}! {} lang {how} („zeige <ding>“).", txt(j::at(&c.actor, "name")), txt(j::at(&s, "name")), ending(&d)), MsgOpts::default()).await
}

async fn zeige(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = def_of(c)?;
	let account = members(c)?;
	let Some(open) = c.space.peek(&tmpl("Show", obj! { "room" => c.room() }), c.txn()).await? else { return refuse("Hier läuft kein Fest.") };
	let s = fields(&open).clone();
	let kind = j::s(&s, "kind").to_owned();
	let boat = j::at(c.w(), "boat");
	let boats: Vec<String> = [j::at(boat, "proto"), j::at(boat, "sail")].into_iter().filter(|b| j::truthy(b)).map(txt).collect();
	let ok: Vec<String> = match kind.as_str() { "blumen" => flowers(c.w()), "ernte" => crops(c.w()), _ => boats.clone() };
	let place = place_of(&d, &kind);
	if !park_beside(c, &place).await? { return refuse(format!("Gezeigt wird {}.", at_park(c, &place))); }
	let thing = js::trim(arg).to_owned();
	if thing.is_empty() { return not_understood(format!("Was zeigst du? {}", match kind.as_str() { "blumen" => "Eine Blume.", "ernte" => "Etwas von deiner Ernte.", _ => "Dein Boot." })); }
	let inv = inventory(c).await?;
	let Some(it) = items_named(c.w(), &inv, &thing, None).into_iter().next() else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&thing, 0, Some(30)))) };
	let f = fields(&it).clone();
	let proto = j::s(&f, "proto").to_owned();
	if !ok.contains(&proto) { return refuse(format!("{} gehört nicht {}.", txt(j::at(&f, "name")), match kind.as_str() { "blumen" => "zur Blumenschau", "ernte" => "zum Erntefest", _ => "zur Regatta" })); }
	let show_id = j::at(&s, "showId").clone();
	let mine = c.space.take_if_exists(&tmpl("ShowEntry", obj! { "showId" => show_id.clone(), "accountId" => j::at(&account, "accountId").clone() }), NO_WAIT, c.txn()).await?;
	let had = mine.map(|e| fields(&e).clone());
	if let Some(h) = &had { if kind != "ernte" { return refuse(format!("Du zeigst schon {}.", txt(j::at(h, "name")))); } }
	let me = c.char_id().to_owned();
	if kind != "regatta" { consume(c, &f, &me).await?; } // a boat stays with its owner
	let name = match &had { Some(h) if j::opt(h, "name").is_some() => j::at(h, "name").clone(), _ => {
		let v = j::at(j::at(&f, "variety"), "name");
		if j::truthy(v) { v.clone() } else { j::at(&f, "name").clone() }
	} };
	let score = match kind.as_str() {
		"blumen" => bloom(&f),
		"regatta" => (boats.iter().position(|b| *b == proto).map_or(-1.0, |i| i as f64) + 1.0) * REGATTA_CREW + random_int(0.0, REGATTA_CREW + 1.0),
		_ => had.as_ref().and_then(|h| j::no(h, "score")).unwrap_or(0.0) + 1.0,
	};
	let mut entry = obj! { "showId" => show_id, "accountId" => j::at(&account, "accountId").clone(), "charName" => j::at(&c.actor, "name").clone(), "name" => name.clone() };
	if j::b(&account, "settler") { j::set(&mut entry, "figure", true); }
	j::set(&mut entry, "score", score);
	j::set(&mut entry, "at", had.as_ref().and_then(|h| j::opt(h, "at").cloned()).unwrap_or_else(|| Json::from(time_now())));
	c.space.write(&tmpl("ShowEntry", entry), c.txn(), FOREVER).await?;
	let text = match kind.as_str() {
		"regatta" => format!("$you() $conj(meldest|meldet) {} zur Regatta.", txt(&name)),
		"blumen" => format!("$you() $conj(zeigst|zeigt) {} auf der Blumenschau.", txt(&name)),
		_ => format!("$you() $conj(legst|legt) {} zum Erntefest ({}).", txt(j::at(&f, "name")), nt(score)),
	};
	msg(c, "*", "info", &text, MsgOpts { templ: true, ..Default::default() }).await
}

async fn pflege(c: &mut Ctx) -> Result<()> {
	let d = def_of(c)?;
	let account = members(c)?;
	let plan = txt(j::at(&d, "plan"));
	if !park_beside(c, &plan).await? { return refuse(format!("Pflegen kann man nur {}.", at_park(c, &plan))); }
	let now = decay_now_of(&c.space, c.txn()).await?;
	let key = obj! { "room" => c.room(), "accountId" => j::at(&account, "accountId").clone() };
	let held = c.space.take_if_exists(&tmpl("ParkCare", key.clone()), NO_WAIT, c.txn()).await?;
	let had = held.map(|e| fields(&e).clone());
	if had.as_ref().is_some_and(|h| j::n(h, "lastWorldMs") + j::n(&d, "careWorldMs") > now) { return refuse("Der Park ist für heute gepflegt; morgen wieder."); }
	let fl = flowers(c.w());
	let Some(it) = inventory(c).await?.into_iter().find(|i| fl.contains(&txt(j::at(fields(i), "proto")))) else { return refuse("Zum Pflegen brauchst du eine Blume.") };
	let f = fields(&it).clone();
	let me = c.char_id().to_owned();
	consume(c, &f, &me).await?;
	let mut care = key;
	j::set(&mut care, "charName", j::at(&c.actor, "name").clone());
	j::set(&mut care, "points", had.as_ref().and_then(|h| j::no(h, "points")).unwrap_or(0.0) + 1.0);
	j::set(&mut care, "lastWorldMs", now);
	c.space.write(&tmpl("ParkCare", care), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(pflanzt|pflanzt) {} in den Park.", txt(j::at(&f, "name"))), MsgOpts { templ: true, ..Default::default() }).await
}

/// `showTick`: the shows whose time is over end (in the job of the epochs): the entries go, the winner's prize waits as an
/// estate, and the settlement rests. Without its settlement a show lapses. How many ended.
pub async fn show_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "festival") else { return Ok(0.0) };
	let now = decay_now_of(space, None).await?;
	let mut ended = 0.0;
	for e in space.read_all(&obj! { "type" => "Show" }, None).await? {
		if j::n(fields(&e), "endsWorldMs") > now { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(taken) = space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(&txn)).await? else { return Ok(false) }; // another worker came first
			let s = fields(&taken).clone();
			let all = ranked(entries_of(space, j::at(&s, "showId"), Some(&txn)).await?);
			for x in space.read_all(&tmpl("ShowEntry", obj! { "showId" => j::at(&s, "showId").clone() }), Some(&txn)).await? { space.take_if_exists(&obj! { "id" => j::at(&x, "id").clone() }, NO_WAIT, Some(&txn)).await?; }
			if let Some(held) = space.take_if_exists(&tmpl("Settlement", obj! { "settlementId" => j::at(&s, "settlementId").clone() }), NO_WAIT, Some(&txn)).await? {
				let mut st = fields(&held).clone();
				j::set(&mut st, "showRestWorldMs", now + j::n(d, "restWorldMs"));
				space.write(&tmpl("Settlement", st), Some(&txn), FOREVER).await?;
				let won = if all.len() >= 2 { all.first() } else { None };
				let kind = j::s(&s, "kind");
				if let Some(won) = won.filter(|x| !j::b(x, "figure")) {
					let coin = resolve_prototype(space, j::s(w, "currency")).await?;
					let estate_id = format!("est-{}", txt(j::at(&s, "showId")));
					let est = obj! { "estateId" => estate_id.as_str(), "accountId" => j::at(won, "accountId").clone(), "ownerName" => j::at(won, "charName").clone(), "room" => j::at(&s, "room").clone(), "name" => name_of(kind), "untilWorldMs" => now + j::no(j::at(w, "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0) };
					space.write(&tmpl("Estate", est), Some(&txn), FOREVER).await?;
					if let Some(coin) = coin { let mut i = 0.0; while i < j::n(d, "prize") { spawn(space, Some(&txn), w, &coin, At { location: estate_id.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; i += 1.0; } }
				}
				let score = |x: &Json| if kind == "ernte" { format!(" ({})", txt(j::at(x, "score"))) } else { String::new() };
				let tail = match won {
					Some(x) if j::b(x, "figure") => format!("Es gewinnt {} mit {}{}, zur Ehre der Siedlung.", txt(j::at(x, "charName")), txt(j::at(x, "name")), score(x)),
					Some(x) => format!("{} gewinnt mit {}{} {} Münzen; abzuholen hier mit „nachlass“.", txt(j::at(x, "charName")), txt(j::at(x, "name")), score(x), txt(j::at(d, "prize"))),
					None => "zu wenige haben mitgemacht, einen Preis gibt es nicht.".to_owned(),
				};
				let text = format!("{} von {} ist zu Ende: {tail}", name_of(kind), txt(j::at(&s, "settlementName")));
				let m = obj! { "room" => j::at(&s, "room").clone(), "to" => "*", "kind" => "world", "text" => text.as_str(), "from" => "", "at" => time_now() };
				space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(&txn), lease_ms, msg_transient(space, "*", "world").await).await?;
			}
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; ended += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(ended)
}
