//! Animals on the farm (`server/engine/commands/animals.ts`): an animal is a thing put into its owner's coop or pen
//! (location: the buildId); the house carries its herd (kind, how long it is fed, the yields and young counted on
//! lazily: whenever a command takes the house, `settle_herd` brings it up to now). Dogs and cats keep watch at a
//! building of one's own. No tick writes for animals.
use phi_json::{obj, Json};

use super::build::{dist_to, give_back, no_article, plan_of, put_back, take_near, Rect};
use super::epoch::need_epoch;
use super::garden::proto_name;
use super::trade::{consume, move_item};
use crate::clock::{patience_of, world_now_of};
use crate::context::{inventory, items_named, msg, plural_of, Ctx, MsgOpts};
use crate::deeds::credit_deed;
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::random_int;
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn hours(ms: f64) -> String {
	let h = js::round(ms / 3_600_000.0);
	if h >= 48.0 { return format!("{} Tage", nt(js::round(h / 24.0))); } // from two days on in days ("satt noch 5 Tage")
	if h >= 1.0 { format!("{} {}", nt(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { format!("{} Minuten", nt(1f64.max(js::round(ms / 60_000.0)))) }
}
fn few(k: &Json, n: f64) -> String { format!("{} {}", nt(n), txt(j::at(k, if n == 1.0 { "name" } else { "plural" }))) }
fn young_word(n: f64) -> &'static str { if n == 1.0 { "Jungtier" } else { "Jungtiere" } }
fn animals_of(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "animals") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt hält niemand Tiere.") } }
fn house_names(c: &Ctx, d: &Json) -> String { j::entries(j::at(d, "houses")).map(|(p, _)| plan_of(c.w(), p).map_or_else(|| p.to_owned(), |x| txt(j::at(x, "name")))).collect::<Vec<_>>().join(" oder ") }
fn house_max(d: &Json, plan: &str) -> f64 { j::no(j::at(d, "houses"), plan).unwrap_or(0.0) }
fn is_house(d: &Json, b: &Json) -> bool { j::b(j::at(d, "houses"), j::s(b, "plan")) }
fn kind_by<'a>(d: &'a Json, key: &Json) -> Option<&'a Json> { j::a(d, "kinds").iter().find(|x| j::at(x, "key") == key) }
fn feeds(c: &Ctx, feed: &[Json]) -> String { feed.iter().map(|p| proto_name(c, &txt(p))).collect::<Vec<_>>().join(", ") }
fn me_xy(c: &Ctx) -> (f64, f64) { (j::n(&c.actor, "x"), j::n(&c.actor, "y")) }
fn herd_of(b: &Json) -> Option<&Json> { j::opt(b, "herd").filter(|h| j::truthy(h)) }

/// `herdNow`: the herd brought up to `now`, and the young born (at most up to `max`).
pub fn herd_now(k: &Json, d: &Json, h: &Json, n: f64, max: f64, now: f64) -> (Json, f64) {
	let at = j::n(h, "atWorldMs");
	let dt = 0f64.max(now.min(j::n(h, "fedUntilWorldMs")) - at);
	let goods = (n * j::n(d, "nestMax")).min(j::n(h, "goods") + (dt * n) / j::n(k, "everyWorldMs"));
	let mut bred = if n >= 2.0 && n < max { j::n(h, "bred") + dt / j::n(k, "breedWorldMs") } else { 0.0 };
	let born = 0f64.max(bred.floor().min(max - n));
	bred -= born;
	if n + born >= max { bred = 0.0; }
	let mut out = h.clone();
	j::set(&mut out, "goods", goods);
	j::set(&mut out, "bred", bred);
	j::set(&mut out, "atWorldMs", at.max(now));
	(out, born)
}

/// A coop or pen with its herd brought up to now.
pub struct House { pub b: Json, pub k: Option<Json>, pub n: f64, pub max: f64, pub now: f64, pub small: f64, pub born: f64 }

/// `settleHerd`: a coop or pen `b` (taken in `txn`) with its herd brought up to `now`; the young born meanwhile are put in it.
pub async fn settle_herd(space: &Space, txn: &str, w: &Json, b: &Json, now: f64) -> Result<House> {
	let d = j::at(w, "animals");
	let max = house_max(d, j::s(b, "plan"));
	let inside: Vec<Json> = space.read_all(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let herd = herd_of(b);
	let k = herd.and_then(|h| kind_by(d, j::at(h, "kind"))).or_else(|| j::a(d, "kinds").iter().find(|x| inside.iter().any(|i| j::at(i, "proto") == j::at(x, "proto") || (j::opt(x, "young").is_some() && j::at(i, "proto") == j::at(x, "young"))))).cloned();
	let n = k.as_ref().map_or(0.0, |k| inside.iter().filter(|i| j::at(i, "proto") == j::at(k, "proto")).count() as f64);
	let small = k.as_ref().and_then(|k| j::opt(k, "young")).map_or(0.0, |y| inside.iter().filter(|i| j::at(i, "proto") == y).count() as f64);
	let (Some(kk), Some(h)) = (&k, herd) else { return Ok(House { b: b.clone(), k, n, max, now, small, born: 0.0 }) };
	let (h, born) = herd_now(kk, d, h, n, max - small, now);
	if born > 0.0 {
		if let Some(p) = resolve_prototype(space, j::s(kk, "proto")).await? {
			for _ in 0..born as usize { spawn(space, Some(txn), w, &p, At { location: j::s(b, "buildId").to_owned(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
		}
	}
	let mut nb = b.clone();
	j::set(&mut nb, "herd", h);
	Ok(House { b: nb, k, n: n + born, max, now, small, born })
}

/// `houseHere`: the coop or pen beside the actor, taken in the transaction, its herd brought up to now.
async fn house_here(c: &Ctx, d: &Json, prefer: &dyn Fn(&Json) -> bool) -> Result<House> {
	let me = me_xy(c);
	let fit = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().any(|e| { let f = fields(e); is_house(d, f) && dist_to(me, Rect::of(f)) <= 1.0 && prefer(f) });
	let pick = |b: &Json| is_house(d, b) && (!fit || prefer(b));
	let Ok(b) = take_near(c, "Building", "buildId", 1.0, &pick).await? else { return not_understood(format!("Geh direkt neben einen Stall ({}).", house_names(c, d))) };
	let now = world_now_of(&c.space, c.txn()).await?;
	let h = settle_herd(&c.space, c.txn().unwrap_or(""), c.w(), &b, now).await?;
	if h.born > 0.0 {
		if let Some(k) = &h.k {
			msg(c, "*", "emote", &format!("Im Stall von {} {} dazugekommen.", txt(j::at(&h.b, "ownerName")), if h.born == 1.0 { format!("ist ein junges {}", txt(j::at(k, "name"))) } else { format!("sind {} junge {}", nt(h.born), txt(j::at(k, "plural"))) }), MsgOpts::default()).await?;
		}
	}
	Ok(h)
}
fn mine(c: &Ctx, b: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(b, "accountId")) }
fn fed_text(h: Option<&Json>, now: f64) -> String {
	match h { Some(h) if j::n(h, "fedUntilWorldMs") > now => format!("satt noch {}", hours(j::n(h, "fedUntilWorldMs") - now)), _ => "hungrig („füttere“)".into() }
}
const EMPTY_HINT: &str = "„einstallen <tier>“ bringt ein Tier hinein; Tiere verkauft Gesa am Markt von Kupferhafen.";

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"stall" => stall(c).await,
		"einstallen" => einstallen(c, arg).await,
		"ausstallen" => ausstallen(c, arg).await,
		"füttere" => fuettere(c, arg).await,
		"einsammeln" => collect(c).await,
		"wache" => wache(c).await,
		"schlachte" => schlachte(c, arg).await,
		k => Err(Error::Other(format!("unported: animals/{k}"))),
	}
}

async fn stall(c: &mut Ctx) -> Result<()> {
	let d = animals_of(c)?;
	let House { b, k, n, max, now, small, .. } = house_here(c, &d, &|h| herd_of(h).is_some()).await?;
	put_back(c, &b).await?;
	let me = c.char_id().to_owned();
	let head = format!("{} von {}", txt(j::at(&b, "name")), txt(j::at(&b, "ownerName")));
	if let (Some(k), true) = (&k, small != 0.0 && n == 0.0) {
		return msg(c, &me, "info", &format!("{head}: {} {} ({}), die heranwachsen (Platz für {}), {}.", nt(small), young_word(small), proto_name(c, j::s(k, "young")), nt(max), fed_text(herd_of(&b), now)), MsgOpts::default()).await;
	}
	let Some(k) = k.filter(|_| n != 0.0) else {
		return msg(c, &me, "info", js::trim(&format!("{head}: leer (Platz für {}). {}", nt(max), if mine(c, &b) { EMPTY_HINT } else { "" })), MsgOpts::default()).await;
	};
	let ready = herd_of(&b).and_then(|h| j::no(h, "goods")).unwrap_or(0.0).floor();
	let y = proto_name(c, j::s(&k, "yields"));
	let text = format!("{head}: {}{} (Platz für {}), {}. {} Sie fressen {}.", few(&k, n), if small != 0.0 { format!(" und {} {}", nt(small), young_word(small)) } else { String::new() }, nt(max), fed_text(herd_of(&b), now),
		if ready != 0.0 { format!("Bereit: {} {y} („einsammeln“).", nt(ready)) } else { format!("Noch kein {y} bereit.") }, feeds(c, j::a(&k, "feed")));
	msg(c, &me, "info", &text, MsgOpts::default()).await
}

fn keepers(c: &Ctx) -> Vec<Json> { j::opt(c.w(), "wild").map_or_else(Vec::new, |w| j::a(w, "keepers").to_vec()) }
fn cap(t: &str) -> String { let mut ch = t.chars(); ch.next().map_or_else(String::new, |f| f.to_uppercase().collect::<String>() + ch.as_str()) }
/// `keeperNamed`: the dog or cat an argument begins with, and the rest of it.
fn keeper_named(c: &Ctx, arg: &str) -> Option<(Json, String)> {
	let line = no_article(js::trim(arg));
	let m = js::caps(&js::re(r"^(\S+)\s*(.*)$", ""), &line)?;
	let word = js::lower(m[1].as_deref().unwrap_or(""));
	for kp in keepers(c) {
		let p = j::by(j::a(c.w(), "prototypes"), "key", j::s(&kp, "proto"));
		let names = [txt(j::at(&kp, "key")), txt(j::at(&kp, "name"))].into_iter().chain(p.map_or(&[][..], |p| j::a(p, "aliases")).iter().map(txt));
		if names.into_iter().any(|a| js::lower(&a) == word) { return Some((kp, js::re(r"^mit\s+", "i").replace(m[2].as_deref().unwrap_or(""), ""))); }
	}
	None
}
fn keeper_of(c: &Ctx, b: &Json) -> Option<Json> { let kind = j::at(j::at(b, "keeper"), "kind"); keepers(c).into_iter().find(|k| j::at(k, "key") == kind) }
fn anew_at(e: &Json, to: &str) -> Json {
	let types: Vec<Json> = j::a(e, "types").iter().skip(1).cloned().collect();
	let mut f = fields(e).clone();
	j::set(&mut f, "location", to);
	j::set(&mut f, "x", -1.0);
	j::set(&mut f, "y", -1.0);
	obj! { "type" => j::at(e, "type").clone(), "types" => Json::Array(types), "fields" => f }
}

async fn einstallen(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = animals_of(c)?;
	let kps = keepers(c);
	let carried: Vec<Json> = inventory(c).await?.into_iter().filter(|i| { let p = j::at(fields(i), "proto"); j::a(&d, "kinds").iter().any(|k| j::at(k, "proto") == p || (j::opt(k, "young").is_some() && j::at(k, "young") == p)) || kps.iter().any(|k| j::at(k, "proto") == p) }).collect();
	let hits = if js::trim(arg).is_empty() { carried.clone() } else { items_named(c.w(), &carried, &no_article(arg), None) };
	let Some(first) = hits.first() else { return not_understood(if carried.is_empty() { "Du trägst kein Tier. Hühner, Schafe, Ziegen, Hunde und Katzen verkauft Gesa am Markt von Kupferhafen.".to_owned() } else { format!("Du trägst kein Tier, das „{}“ heißt.", js::slice16(arg, 0, Some(30))) }) };
	let it = fields(first).clone();
	if let Some(kp) = kps.iter().find(|x| j::at(x, "proto") == j::at(&it, "proto")) { return keep_at(c, &it, kp).await; }
	let k = j::a(&d, "kinds").iter().find(|x| j::at(x, "proto") == j::at(&it, "proto") || (j::opt(x, "young").is_some() && j::at(x, "young") == j::at(&it, "proto"))).cloned().unwrap_or(Json::Null);
	let young = j::opt(&k, "young").is_some() && j::at(&k, "young") == j::at(&it, "proto");
	let House { b, k: has, n, max, now, small, .. } = house_here(c, &d, &|h| mine(c, h) && j::at(h, "plan") == j::at(&k, "plan") && herd_of(h).is_none_or(|x| j::at(x, "kind") == j::at(&k, "key"))).await?;
	if !mine(c, &b) { return refuse(format!("Der Stall gehört {}; einstallen darf nur der Besitzer.", txt(j::at(&b, "ownerName")))); }
	need_epoch(c, j::no(&k, "epoch"), &txt(j::at(&k, "plural"))).await?;
	if j::at(&b, "plan") != j::at(&k, "plan") { return refuse(format!("{} wohnen im {}, nicht im {}.", txt(j::at(&k, "plural")), plan_of(c.w(), j::s(&k, "plan")).map_or_else(|| txt(j::at(&k, "plan")), |p| txt(j::at(p, "name"))), txt(j::at(&b, "name")))); }
	if let Some(has) = has.as_ref().filter(|h| n != 0.0 && j::at(h, "key") != j::at(&k, "key")) { return refuse(format!("Hier stehen schon {}; eine Art je Stall.", txt(j::at(has, "plural")))); }
	if n + small >= max { return refuse(format!("Der Stall ist voll ({}).", nt(max))); }
	let me = c.char_id().to_owned();
	let Some(e) = c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(&it, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await? else { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(&it, "name")))) };
	c.space.write(&anew_at(&e, j::s(&b, "buildId")), c.txn(), FOREVER).await?;
	let herd = match herd_of(&b) { Some(h) if n != 0.0 || small != 0.0 => { let mut h = h.clone(); j::set(&mut h, "kind", j::at(&k, "key").clone()); h } _ => obj! { "kind" => j::at(&k, "key").clone(), "fedUntilWorldMs" => now, "atWorldMs" => now, "goods" => 0.0, "bred" => 0.0 } };
	let mut nb = b.clone();
	j::set(&mut nb, "herd", herd.clone());
	put_back(c, &nb).await?;
	let name = txt(j::at(&c.actor, "name"));
	if young { msg(c, "*", "emote", &format!("{name} bringt {} in den Stall ({}, {} {}); es wächst dort heran.", txt(j::at(&it, "name")), few(&k, n), nt(small + 1.0), if small != 0.0 { "Jungtiere" } else { "Jungtier" }), MsgOpts::default()).await?; }
	else { msg(c, "*", "emote", &format!("{name} bringt {} in den Stall ({}{}).", one_of(&k), few(&k, n + 1.0), if small != 0.0 { format!(", {} {}", nt(small), young_word(small)) } else { String::new() }), MsgOpts::default()).await?; }
	if j::n(&herd, "fedUntilWorldMs") <= now { msg(c, &me, "info", &format!("Sie sind hungrig: „füttere“ mit {}.", feeds(c, j::a(&k, "feed"))), MsgOpts::default()).await?; }
	Ok(())
}

async fn ausstallen(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = animals_of(c)?;
	if let Some((kp, _)) = keeper_named(c, arg) { return keeper_out(c, &kp).await; }
	let House { b, k, n, small, .. } = house_here(c, &d, &|h| mine(c, h) && herd_of(h).is_some()).await?;
	if !mine(c, &b) { return refuse(format!("Der Stall gehört {}.", txt(j::at(&b, "ownerName")))); }
	let Some(k) = k.filter(|_| n + small != 0.0) else { return refuse("Im Stall ist kein Tier.") };
	// a grown one first; a young one when there is none (or when it is named)
	let wants_young = j::opt(&k, "young").is_some() && (n == 0.0 || {
		let y = j::s(&k, "young");
		let p = j::by(j::a(c.w(), "prototypes"), "key", y);
		let one = obj! { "fields" => obj! { "name" => proto_name(c, y), "aliases" => p.map_or(Json::Array(vec![]), |p| j::at(p, "aliases").clone()), "proto" => y } };
		!items_named(c.w(), &[one], &no_article(arg), None).is_empty() && !js::trim(arg).is_empty()
	});
	let proto = if wants_young { j::at(&k, "young").clone() } else { j::at(&k, "proto").clone() };
	let one = c.space.read_all(&tmpl("Item", obj! { "location" => j::at(&b, "buildId").clone(), "proto" => proto }), None).await?.into_iter().next();
	let e = match &one { Some(o) => c.space.take_if_exists(&obj! { "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?, None => None };
	let Some(e) = e else { return refuse("Das Tier ist gerade nicht greifbar; bitte noch einmal.") };
	let me = c.char_id().to_owned();
	c.space.write(&anew_at(&e, &me), c.txn(), FOREVER).await?;
	// the last one out: the house is empty again
	if n + small == 1.0 { put_back(c, &j::without(&b, "herd")).await?; } else { put_back(c, &b).await?; }
	msg(c, "*", "emote", &format!("{} nimmt {} aus dem Stall.", txt(j::at(&c.actor, "name")), if wants_young { txt(j::at(fields(&e), "name")) } else { one_of(&k) }), MsgOpts::default()).await
}

/// `(\d+|alle?)` as a count, else no limit.
fn count_of(m1: Option<&str>) -> f64 { match m1 { Some(x) if js::re(r"^\d+$", "").test(x) => js::to_number(x), _ => f64::INFINITY } }

async fn fuettere(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = animals_of(c)?;
	if let Some((kp, rest)) = keeper_named(c, arg) { return feed_keeper(c, Some(&kp), &rest).await; }
	// no coop or pen beside, but a dog or cat on guard: it is the one to feed
	let me_at = me_xy(c);
	let near: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|b| dist_to(me_at, Rect::of(b)) <= 1.0).collect();
	if !near.iter().any(|b| is_house(&d, b)) && near.iter().any(|b| j::b(b, "keeper")) { return feed_keeper(c, None, arg).await; }
	let line = js::re(r"^mit\s+", "i").replace(&js::re(r"^(?:die|den)\s+(?:tiere|hühner|huehner|schafe|ziegen)(?:\s+mit)?\s*", "i").replace(js::trim(arg), ""), "");
	let m = js::caps(&js::re(r"^(?:(\d+|alle?)\s+)?(.*)$", "i"), &line).unwrap_or_default();
	let m1 = m.get(1).cloned().flatten();
	let m2 = m.get(2).cloned().flatten().unwrap_or_default();
	let House { b, k, n, max, now, .. } = house_here(c, &d, &|h| herd_of(h).is_some()).await?;
	let (Some(k), Some(herd)) = (k.filter(|_| n != 0.0), herd_of(&b).cloned()) else {
		return refuse(js::trim(&format!("{} von {} ist leer (Platz für {}), da ist nichts zu füttern. {}", txt(j::at(&b, "name")), txt(j::at(&b, "ownerName")), nt(max), if mine(c, &b) { EMPTY_HINT } else { "" })).to_owned());
	};
	let kf = j::a(&k, "feed").to_vec();
	let inv = inventory(c).await?;
	let feed: Vec<Json> = inv.iter().filter(|i| kf.contains(j::at(fields(i), "proto"))).cloned().collect();
	let named = if m2.is_empty() { feed.clone() } else { items_named(c.w(), &inv, &no_article(&m2), None) };
	if !m2.is_empty() { if let Some(f0) = named.first() { if !kf.contains(j::at(fields(f0), "proto")) { return refuse(format!("{} mögen {} nicht; sie fressen {}.", txt(j::at(fields(f0), "name")), txt(j::at(&k, "plural")), feeds(c, &kf))); } } }
	let offer: Vec<Json> = if m2.is_empty() { feed } else { let p0 = named.first().map(|x| j::at(fields(x), "proto").clone()); named.iter().filter(|i| Some(j::at(fields(i), "proto")) == p0.as_ref()).cloned().collect() };
	if offer.is_empty() { return refuse(format!("Du hast kein Futter. {} fressen {}.", txt(j::at(&k, "plural")), feeds(c, &kf))); }
	let per = j::n(&d, "feedWorldMs") / n;
	let from = now.max(j::n(&herd, "fedUntilWorldMs"));
	// a food is a world day for one animal (they eat by the life rate); fed ahead as far as a dog, for people who are away
	let room = now + j::n(&d, "fedMaxWorldMs") * patience_of(&c.space, c.txn()).await? - from;
	if room < per { return refuse(format!("Die {} sind satt (noch {}).", txt(j::at(&k, "plural")), hours(from - now))); }
	let want = (room / per).floor().min(offer.len() as f64).min(count_of(m1.as_deref()));
	let mut used: Vec<(String, f64)> = Vec::new();
	let me = c.char_id().to_owned();
	for it in offer.iter().take(want as usize) {
		let f = fields(it);
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(f, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { continue; }
		let nm = txt(j::at(f, "name"));
		match used.iter_mut().find(|(x, _)| *x == nm) { Some(s) => s.1 += 1.0, None => used.push((nm, 1.0)) }
	}
	let count: f64 = used.iter().map(|(_, x)| x).sum();
	if count == 0.0 { return refuse("Das Futter ist gerade nicht greifbar; bitte noch einmal."); }
	let until = from + count * per;
	let mut h = herd.clone();
	j::set(&mut h, "fedUntilWorldMs", until);
	let mut nb = b.clone();
	j::set(&mut nb, "herd", h);
	put_back(c, &nb).await?;
	if !mine(c, &b) { credit_deed(c, "tiere").await?; }
	msg(c, "*", "emote", &format!("{} füttert die {} von {} mit {}; satt für etwa {}.", txt(j::at(&c.actor, "name")), txt(j::at(&k, "plural")), txt(j::at(&b, "ownerName")), used.iter().map(|(nm, x)| format!("{} {nm}", nt(*x))).collect::<Vec<_>>().join(" und "), hours(until - now)), MsgOpts::default()).await
}

async fn keep_at(c: &mut Ctx, it: &Json, kp: &Json) -> Result<()> {
	let Ok(b) = take_near(c, "Building", "buildId", 1.0, &|b: &Json| mine(c, b) && !j::b(b, "keeper")).await? else { return not_understood(format!("Geh direkt neben einen Bau von dir, an dem noch niemand wacht; dort bleibt {}.", txt(j::at(kp, "acc")))) };
	let now = world_now_of(&c.space, c.txn()).await?;
	let me = c.char_id().to_owned();
	let Some(e) = c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(it, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await? else { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(it, "name")))) };
	c.space.write(&anew_at(&e, j::s(&b, "buildId")), c.txn(), FOREVER).await?;
	let mut nb = b.clone();
	j::set(&mut nb, "keeper", obj! { "kind" => j::at(kp, "key").clone(), "fedUntilWorldMs" => now });
	put_back(c, &nb).await?;
	msg(c, "*", "emote", &format!("{} lässt {} am Bau ({}) wachen.", txt(j::at(&c.actor, "name")), txt(j::at(kp, "acc")), txt(j::at(&b, "name"))), MsgOpts::default()).await?;
	msg(c, &me, "info", &format!("Hungrig wacht {} nicht: „füttere {}“ mit {}.", txt(j::at(kp, "the")), txt(j::at(kp, "key")), feeds(c, j::a(kp, "feed"))), MsgOpts::default()).await
}

async fn keeper_out(c: &mut Ctx, kp: &Json) -> Result<()> {
	let kind = j::at(kp, "key").clone();
	let Ok(b) = take_near(c, "Building", "buildId", 1.0, &|b: &Json| mine(c, b) && *j::at(j::at(b, "keeper"), "kind") == kind).await? else { return refuse(format!("Neben dir wacht {} von dir.", txt(j::at(kp, "none")))) };
	let one = c.space.read_all(&tmpl("Item", obj! { "location" => j::at(&b, "buildId").clone(), "proto" => j::at(kp, "proto").clone() }), None).await?.into_iter().next();
	let e = match &one { Some(o) => c.space.take_if_exists(&obj! { "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?, None => None };
	let Some(e) = e else { return refuse("Das Tier ist gerade nicht greifbar; bitte noch einmal.") };
	let me = c.char_id().to_owned();
	c.space.write(&anew_at(&e, &me), c.txn(), FOREVER).await?;
	put_back(c, &j::without(&b, "keeper")).await?;
	msg(c, "*", "emote", &format!("{} nimmt {} wieder mit.", txt(j::at(&c.actor, "name")), txt(j::at(kp, "acc"))), MsgOpts::default()).await
}

async fn feed_keeper(c: &mut Ctx, kp: Option<&Json>, arg: &str) -> Result<()> {
	let d = animals_of(c)?;
	let want_kind = kp.map(|k| j::at(k, "key").clone());
	let Ok(b) = take_near(c, "Building", "buildId", 1.0, &|b: &Json| j::b(b, "keeper") && want_kind.as_ref().is_none_or(|k| j::at(j::at(b, "keeper"), "kind") == k)).await? else {
		return not_understood(kp.map_or_else(|| "Neben dir ist kein Tier zu füttern.".to_owned(), |k| format!("Neben dir wacht {}.", txt(j::at(k, "none")))));
	};
	let k = keeper_of(c, &b);
	let now = world_now_of(&c.space, c.txn()).await?;
	let (Some(k), Some(keeper)) = (k, j::opt(&b, "keeper").filter(|x| j::truthy(x)).cloned()) else { return refuse("Neben dir ist kein Tier zu füttern.") };
	let line = js::re(r"^mit\s+", "i").replace(js::trim(arg), "");
	let m = js::caps(&js::re(r"^(?:(\d+|alle?)\s+)?(.*)$", "i"), &line).unwrap_or_default();
	let m1 = m.get(1).cloned().flatten();
	let m2 = m.get(2).cloned().flatten().unwrap_or_default();
	let kf = j::a(&k, "feed").to_vec();
	let inv = inventory(c).await?;
	let named = if m2.is_empty() { inv.iter().filter(|i| kf.contains(j::at(fields(i), "proto"))).cloned().collect() } else { items_named(c.w(), &inv, &no_article(&m2), None) };
	let the = txt(j::at(&k, "the"));
	if !m2.is_empty() { if let Some(f0) = named.first() { if !kf.contains(j::at(fields(f0), "proto")) { return refuse(format!("{} mag {} nicht; {} frisst {}.", cap(&the), txt(j::at(fields(f0), "name")), if the.starts_with("die ") { "sie" } else { "er" }, feeds(c, &kf))); } } }
	let offer: Vec<Json> = if m2.is_empty() { named } else { let p0 = named.first().map(|x| j::at(fields(x), "proto").clone()); named.iter().filter(|i| Some(j::at(fields(i), "proto")) == p0.as_ref()).cloned().collect() };
	if offer.is_empty() { return refuse(format!("Du hast kein Futter für {}: {}.", txt(j::at(&k, "acc")), feeds(c, &kf))); }
	let patient = patience_of(&c.space, c.txn()).await?;
	let feed_ms = j::n(&d, "feedWorldMs") * patient;
	let from = now.max(j::n(&keeper, "fedUntilWorldMs"));
	let room = now + j::n(&d, "fedMaxWorldMs") * patient - from;
	if room < feed_ms { return refuse(format!("{} ist satt (noch {}).", cap(&the), hours((from - now) / patient))); }
	let want = (room / feed_ms).floor().min(offer.len() as f64).min(count_of(m1.as_deref()));
	let me = c.char_id().to_owned();
	let mut count = 0.0;
	for it in offer.iter().take(want as usize) {
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(it), "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_some() { count += 1.0; }
	}
	if count == 0.0 { return refuse("Das Futter ist gerade nicht greifbar; bitte noch einmal."); }
	let until = from + count * feed_ms;
	let mut kpr = keeper.clone();
	j::set(&mut kpr, "fedUntilWorldMs", until);
	let mut nb = b.clone();
	j::set(&mut nb, "keeper", kpr);
	put_back(c, &nb).await?;
	msg(c, "*", "emote", &format!("{} füttert {} von {} mit {} {}; satt für etwa {}.", txt(j::at(&c.actor, "name")), txt(j::at(&k, "acc")), txt(j::at(&b, "ownerName")), nt(count), txt(j::at(fields(&offer[0]), "name")), hours((until - now) / patient)), MsgOpts::default()).await
}

async fn wache(c: &mut Ctx) -> Result<()> {
	let now = world_now_of(&c.space, c.txn()).await?;
	let all: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let guards = j::opt(c.w(), "wild").map_or(&[][..], |w| j::a(w, "guards")).to_vec();
	let mut out: Vec<String> = Vec::new();
	let patient = patience_of(&c.space, c.txn()).await?;
	let fed = |until: f64, per: f64| if until > now { format!("satt noch {}", hours((until - now) / per)) } else { "hungrig".to_owned() };
	for b in &all {
		if let (Some(kp), Some(kr)) = (keeper_of(c, b), j::opt(b, "keeper").filter(|x| j::truthy(x))) {
			out.push(format!("{} von {} am Bau ({}), {}", txt(j::at(&kp, "the")), txt(j::at(b, "ownerName")), txt(j::at(b, "name")), fed(j::n(kr, "fedUntilWorldMs"), patient)));
		}
		let hk = herd_of(b).map(|h| j::at(h, "kind").clone()).unwrap_or(Json::Null);
		let g = guards.iter().find(|x| *j::at(x, "by") == hk);
		let k = g.and_then(|g| j::opt(c.w(), "animals").and_then(|a| kind_by(a, j::at(g, "by"))));
		if let (Some(_), Some(k), Some(h)) = (g, k, herd_of(b)) { out.push(format!("die {} von {}, {}", txt(j::at(k, "plural")), txt(j::at(b, "ownerName")), fed(j::n(h, "fedUntilWorldMs"), 1.0))); }
	}
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &if out.is_empty() { "Hier wacht niemand. Hunde und Katzen verkauft Gesa am Markt von Kupferhafen („einstallen hund“ an einem deiner Bauten).".to_owned() } else { format!("Hier wachen: {}. Nur satt halten sie das Wild fern.", out.join("; ")) }, MsgOpts::default()).await
}

/// `collect`: what the herd beside the actor gave (the owner only); also reached from "sammle eier" (garden.rs).
pub async fn collect(c: &mut Ctx) -> Result<()> {
	let d = animals_of(c)?;
	let House { b, k, n, now, .. } = house_here(c, &d, &|h| mine(c, h) && herd_of(h).is_some()).await?;
	if !mine(c, &b) { let o = txt(j::at(&b, "ownerName")); return refuse(format!("Was die Tiere von {o} geben, sammelt {o}.")); }
	let (Some(k), Some(herd)) = (k.filter(|_| n != 0.0), herd_of(&b).cloned()) else { return refuse("Im Stall ist kein Tier.") };
	let goods = j::n(&herd, "goods");
	let whole = goods.floor();
	let y = proto_name(c, j::s(&k, "yields"));
	if whole == 0.0 {
		let next = if j::n(&herd, "fedUntilWorldMs") <= now { "sie sind hungrig („füttere“)".to_owned() } else { format!("das nächste in etwa {}", hours(((1.0 - goods % 1.0) * j::n(&k, "everyWorldMs")) / n)) };
		return refuse(format!("Noch kein {y} bereit; {next}."));
	}
	let mut h = herd.clone();
	j::set(&mut h, "goods", goods - whole);
	let mut nb = b.clone();
	j::set(&mut nb, "herd", h);
	put_back(c, &nb).await?;
	let also = j::opt(&k, "also").filter(|a| j::truthy(a)).cloned();
	let extra = also.as_ref().map_or(0.0, |a| { let per = j::n(a, "per"); (whole / per).floor() + if random_int(0.0, per) < whole % per { 1.0 } else { 0.0 } });
	let mut what = vec![(txt(j::at(&k, "yields")), whole)];
	if let Some(a) = also.as_ref().filter(|_| extra != 0.0) { what.push((txt(j::at(a, "proto")), extra)); }
	let got = give_back(c, &what).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("Du sammelst {} im Stall.", got.join(", ")), MsgOpts::default()).await
}

/// `meansYield`: whether "sammle <arg>" means a yield of the animals.
pub fn means_yield(c: &Ctx, arg: &str) -> bool {
	let n = no_article(&js::lower(js::trim(arg)));
	!n.is_empty() && j::opt(c.w(), "animals").map_or(&[][..], |a| j::a(a, "kinds")).iter().any(|k| {
		j::by(j::a(c.w(), "prototypes"), "key", j::s(k, "yields")).is_some_and(|p| std::iter::once(j::s(p, "key")).chain(std::iter::once(j::s(p, "name"))).chain(j::a(p, "aliases").iter().filter_map(Json::as_str)).any(|a| js::lower(a) == n))
	})
}

/// `oneOf`: "ein Schwein", "eine Ziege", "eine Gans".
fn one_of(k: &Json) -> String { let name = txt(j::at(k, "name")); format!("{} {name}", if js::re(r"e$|^Gans$", "").test(&name) { "eine" } else { "ein" }) }
fn kind_named(c: &Ctx, k: &Json, said: &str) -> bool {
	let p = j::by(j::a(c.w(), "prototypes"), "key", j::s(k, "proto"));
	[txt(j::at(k, "key")), txt(j::at(k, "name")), txt(j::at(k, "plural"))].into_iter().chain(p.map_or(&[][..], |p| j::a(p, "aliases")).iter().map(txt)).any(|a| js::lower(&a) == said)
}

async fn schlachte(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = animals_of(c)?;
	let Some(bt) = j::opt(&d, "butcher").filter(|b| !j::a(b, "tools").is_empty()).cloned() else { return refuse("In dieser Welt wird nicht geschlachtet.") };
	if keeper_named(c, arg).is_some() { return refuse("Hund und Katze wachen über den Hof; sie werden nicht geschlachtet."); }
	let inv = inventory(c).await?;
	// the best tool carried: the butcher's knife before the shell knife
	let tools = j::a(&bt, "tools");
	let Some(tool) = tools.iter().find_map(|t| inv.iter().find(|i| j::at(fields(i), "proto") == t)).map(|i| fields(i).clone()) else {
		return refuse(format!("Zum Schlachten brauchst du {} („craft {}“).", tools.iter().map(|t| proto_name(c, &txt(t))).collect::<Vec<_>>().join(" oder "), js::lower(&proto_name(c, &txt(tools.last().unwrap_or(&Json::Null))))));
	};
	let said = js::trim(&no_article(&js::lower(js::trim(arg)))).to_owned();
	let shop = j::opt(&bt, "shop").filter(|s| j::truthy(s)).cloned();
	let me_at = me_xy(c);
	// (outside beside it, or inside at its block: interior.rs)
	let shop_plan = shop.as_ref().map(|s| txt(j::at(s, "plan"))).filter(|p| !p.is_empty());
	let near_shop = match &shop_plan { Some(p) => super::interior::near_buildings(c, Some("cook")).await?.iter().any(|b| j::s(b, "plan") == p), None => false };
	let near_house = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().any(|e| { let f = fields(e); is_house(&d, f) && dist_to(me_at, Rect::of(f)) <= 1.0 });
	let me = c.char_id().to_owned();
	if near_shop && !near_house {
		let kinds: Vec<&Json> = j::a(&d, "kinds").iter().filter(|x| !j::a(x, "slaughter").is_empty()).collect();
		let carried = inv.iter().map(fields).find(|i| kinds.iter().any(|x| j::at(x, "proto") == j::at(i, "proto") && (said.is_empty() || kind_named(c, x, &said)))).cloned();
		let Some(carried) = carried else { return refuse(if said.is_empty() { "Du trägst kein Tier zum Schlachten. Hol eins aus deinem Stall („ausstallen“) oder schlachte direkt am Stall.".to_owned() } else { format!("Du trägst kein Tier, das „{}“ heißt und geschlachtet wird.", js::slice16(&said, 0, Some(30))) }) };
		let k = kinds.iter().find(|x| j::at(x, "proto") == j::at(&carried, "proto")).copied().cloned().unwrap_or(Json::Null);
		consume(c, &carried, &me).await?;
		return butchered(c, &tool, &k, j::n(shop.as_ref().unwrap_or(&Json::Null), "bonus"), true).await;
	}
	let House { b, k, n, .. } = house_here(c, &d, &|h| mine(c, h) && herd_of(h).and_then(|x| kind_by(&d, j::at(x, "kind"))).is_some_and(|x| !j::a(x, "slaughter").is_empty())).await?;
	if !mine(c, &b) { return refuse(format!("Die Tiere gehören {}; schlachten darf nur, wem der Stall gehört.", txt(j::at(&b, "ownerName")))); }
	let Some(k) = k.filter(|_| n != 0.0) else { return refuse("Im Stall ist kein Tier.") };
	if !said.is_empty() && !kind_named(c, &k, &said) { return refuse(format!("Im Stall leben {}.", txt(j::at(&k, "plural")))); }
	if j::a(&k, "slaughter").is_empty() { return refuse(format!("{} werden nicht geschlachtet; sie geben, was sie sammeln.", txt(j::at(&k, "plural")))); }
	let keep = j::n(&bt, "keep");
	if n <= keep { return refuse(format!("{} im Stall; {}, damit die Herde weiterlebt. Warte, bis ein Junges dazukommt.", if n == 1.0 { format!("Es lebt nur {}", one_of(&k)) } else { format!("Es leben nur {}", few(&k, n)) }, if keep == 2.0 { "das letzte Paar bleibt".to_owned() } else { format!("{} bleiben", nt(keep)) })); }
	let one = c.space.read_all(&tmpl("Item", obj! { "location" => j::at(&b, "buildId").clone(), "proto" => j::at(&k, "proto").clone() }), None).await?.into_iter().next();
	let e = match &one { Some(o) => c.space.take_if_exists(&obj! { "id" => j::at(o, "id").clone() }, NO_WAIT, c.txn()).await?, None => None };
	if e.is_none() { return refuse("Das Tier ist gerade nicht greifbar; bitte noch einmal."); }
	put_back(c, &b).await?;
	// a butcher's shop in the room: more of the first thing (the meat), cut by one who knows how
	let bonus = match &shop { Some(s) if c.space.count(&tmpl("Building", obj! { "room" => c.room(), "plan" => j::at(s, "plan").clone() }), c.txn()).await? != 0.0 => j::n(s, "bonus"), _ => 0.0 };
	butchered(c, &tool, &k, bonus, false).await
}

/// `butchered`: the knife wears, the yields (the first `bonus` more) come into the pack, both are told.
async fn butchered(c: &mut Ctx, tool: &Json, k: &Json, bonus: f64, at_shop: bool) -> Result<()> {
	let me = c.char_id().to_owned();
	let left = j::no(tool, "wear").unwrap_or(1.0) - 1.0;
	if left <= 0.0 { consume(c, tool, &me).await?; } else { move_item(c, tool, &me, &me, &[("wear", Json::from(left))]).await?; }
	let gives: Vec<(String, f64)> = j::a(k, "slaughter").iter().enumerate().map(|(i, x)| (txt(j::at(x, "proto")), j::n(x, "count") + if i == 0 { bonus } else { 0.0 })).collect();
	give_back(c, &gives).await?;
	let got: Vec<String> = gives.iter().map(|(p, n)| { let name = proto_name(c, p); format!("{} {}", nt(*n), if *n == 1.0 { name } else { plural_of(&name, Some(c.w())) }) }).collect();
	let name = txt(j::at(&c.actor, "name"));
	msg(c, "*", "emote", &if at_shop { format!("{name} schlachtet in der Metzgerei {}.", one_of(k)) } else { format!("{name} schlachtet im Stall {}.", one_of(k)) }, MsgOpts::default()).await?;
	let shop_name = j::opt(c.w(), "animals").and_then(|a| j::opt(a, "butcher")).and_then(|b| j::opt(b, "shop")).and_then(|s| plan_of(c.w(), j::s(s, "plan"))).map_or_else(|| "Metzgerei".to_owned(), |p| txt(j::at(p, "name")));
	msg(c, &me, "info", &format!("Du bekommst {}.{}{}", got.join(", "), if bonus != 0.0 { format!(" Die {shop_name} im Ort zerlegt es gut.") } else { String::new() }, if left <= 0.0 { format!(" Dein {} ist stumpf geworden und zerbrochen.", txt(j::at(tool, "name"))) } else { String::new() }), MsgOpts::default()).await
}
