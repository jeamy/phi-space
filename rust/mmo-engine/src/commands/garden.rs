//! Gardens (`server/engine/commands/garden.ts`): beds dug with a spade in the light of a fire, planted with seeds from the
//! wild flora, watered from a rain barrel, weeded and harvested; flowers side by side in a flower bed cross now and then
//! into a variety its breeder names. A bed carries its plants and one date, the earliest stage change; `garden_tick`
//! looks only at beds whose date has come.
use std::collections::HashSet;

use phi_json::{obj, Json};

use super::build::{besides, building_here, cells, free_cells, give_back, human, light_for, no_article, plural, put_back, refusal, release_light, take_near, use_light, Rect, SITE_REACH};
use super::field::{harvest_field, sow_on_field};
use super::settlement::need_rank;
use crate::clock::{decay_now_of, frozen_until, patience_of, world_now_of};
use crate::context::{inventory, items_named, msg, plural_of, room_of, Ctx, MsgOpts};
use crate::deeds::credit_deed;
use crate::fire::{fog_of, key_text};
use crate::j;
use crate::js;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::{hex, random, random_bytes, random_int};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
const STAGES: [&str; 4] = ["Saat", "Keim", "reif", "welk"];
/// The most plants one who did not dig a community bed takes from it at one harvest.
const COMMONS_TAKE: f64 = 2.0;
const KIND_WORD: &str = r"^(?:(zier(?:beet)?|blumen(?:beet)?|flowers?)|(gemeinschaft(?:sbeet)?|gemeinsam|gemein|community))(?:\s+|$)";

fn garden(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "garden") { Some(g) => Ok(g.clone()), None => refuse("In dieser Welt wächst nichts in Beeten.") } }
fn sort_of<'a>(g: &'a Json, key: &str) -> Option<&'a Json> { j::by(j::a(g, "sorts"), "key", key) }
fn proto_name(c: &Ctx, key: &str) -> String { j::by(j::a(c.w(), "prototypes"), "key", key).map_or_else(|| key.to_owned(), |p| txt(j::at(p, "name"))) }
fn mine(c: &Ctx, b: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(b, "accountId")) }
fn kind(b: &Json) -> &str { j::s(b, "kind") }
/// `mayTend`: the owner, the sponsors, and everyone at a community bed.
pub fn may_tend(c: &Ctx, b: &Json) -> bool { kind(b) == "gemein" || mine(c, b) || j::a(b, "sponsors").iter().any(|s| j::s(s, "charId") == c.char_id()) }
fn may_plant(c: &Ctx, b: &Json) -> bool { mine(c, b) || (kind(b) == "gemein" && c.account.as_ref().is_some_and(|a| !j::b(a, "guest"))) }
/// `bedName`.
pub fn bed_name(b: &Json) -> String { if kind(b) == "gemein" { "Gemeinschaftsbeet".into() } else { format!("{} von {}", if kind(b) == "zier" { "Zierbeet" } else { "Beet" }, txt(j::at(b, "ownerName"))) } }
fn bed_word(b: &Json) -> &'static str { match kind(b) { "gemein" => "Gemeinschaftsbeet", "zier" => "Zierbeet", _ => "Beet" } }
fn variety(p: &Json) -> Option<&Json> { j::opt(p, "variety").filter(|v| j::truthy(v)) }
fn strain(p: &Json) -> Json { variety(p).map_or_else(|| j::at(p, "sort").clone(), |v| j::at(v, "id").clone()) }
fn sort_name(g: &Json, p: &Json) -> String { sort_of(g, j::s(p, "sort")).map_or_else(|| txt(j::at(p, "sort")), |s| txt(j::at(s, "name"))) }
fn plant_name(g: &Json, p: &Json) -> String {
	match variety(p) { Some(v) if j::b(v, "name") => txt(j::at(v, "name")), Some(_) => format!("Kreuzung ({})", sort_name(g, p)), None => sort_name(g, p) }
}
fn color_of(g: &Json, p: &Json) -> String {
	variety(p).and_then(|v| j::opt(v, "color")).or_else(|| sort_of(g, j::s(p, "sort")).and_then(|s| j::opt(s, "color"))).map_or_else(|| "#7fae6a".to_owned(), txt)
}
fn hours(ms: f64) -> String {
	let h = js::round(ms / 3_600_000.0);
	if h >= 1.0 { format!("{} {}", nt(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { format!("{} Minuten", nt(1f64.max(js::round(ms / 60_000.0)))) }
}

/// `growFactor`: how much slower things grow, by fog (0 to 3) and weeds.
pub fn grow_factor(fog: f64, weedy: bool) -> f64 { (1.0 + 0.5 * fog.max(0.0)) * if weedy { 1.5 } else { 1.0 } }
/// `nextDue`.
pub fn next_due(plants: &[Json]) -> f64 { plants.iter().fold(FOREVER, |m, p| m.min(j::n(p, "dueWorldMs"))) }

/// `advance`: the plants whose date has come move on (or wilt); true when anything changed.
pub fn advance(g: &Json, b: &mut Json, now: f64, fog: f64, patient: f64, frozen: Option<f64>) -> bool {
	let mut changed = false;
	let weedy = j::b(b, "weedy");
	let mut plants = j::a(b, "plants").to_vec();
	for p in plants.iter_mut() {
		if j::n(p, "dueWorldMs") > now { continue; }
		changed = true;
		if let Some(fr) = frozen { if j::n(p, "stage") < 3.0 { j::set(p, "dueWorldMs", fr); j::set(b, "wateredWorldMs", fr); } continue; }
		let sort = sort_of(g, j::s(p, "sort"));
		let Some(sort) = sort.filter(|_| !(j::n(p, "stage") >= 2.0 || now - j::n(b, "wateredWorldMs") > j::n(g, "thirstWorldMs") * patient)) else { j::set(p, "stage", 3.0); j::set(p, "dueWorldMs", FOREVER); continue; };
		let stage = j::n(p, "stage") + 1.0;
		j::set(p, "stage", stage);
		let grow = j::a(sort, "grow").get(1).map_or(f64::NAN, j::number);
		j::set(p, "dueWorldMs", now + if stage == 1.0 { grow * grow_factor(fog, weedy) } else { j::n(sort, "ripeWorldMs") * patient });
		if !j::b(b, "weedy") && random() < 0.2 { j::set(b, "weedy", true); }
	}
	let due = next_due(&plants);
	j::set(b, "plants", Json::Array(plants));
	j::set(b, "dueWorldMs", due);
	changed
}

/// `barrelWater`: a rain barrel's cans now, and from when they count.
pub fn barrel_water(g: &Json, b: &Json, now: f64) -> (f64, f64) {
	let at = j::no(b, "waterAtWorldMs").unwrap_or_else(|| j::n(b, "builtAt"));
	let have = j::no(b, "water").unwrap_or(1.0);
	let fill = j::n(g, "barrelFillWorldMs");
	let gained = (0f64.max(now - at) / fill).floor();
	if have + gained >= j::n(g, "barrelCap") { return (j::n(g, "barrelCap"), now); }
	(have + gained, at + gained * fill)
}

/// `bedHere`: a bed within reach (`own`: one's own; `may`: one this figure may do something at), taken in the transaction.
pub async fn bed_here(c: &Ctx, own: bool, may: Option<&dyn Fn(&Json) -> bool>, reach: Option<f64>) -> Result<Json> {
	let pick = |b: &Json| (!own || mine(c, b)) && may.is_none_or(|m| m(b));
	match take_near(c, "Bed", "bedId", reach.unwrap_or(SITE_REACH), &pick).await? {
		Ok(b) => Ok(b),
		Err(far) => not_understood(if far { if own { "Geh näher an dein Beet heran." } else { "Geh näher an das Beet heran (höchstens zwei Schritte entfernt)." } } else { "Hier ist kein Beet. „umgraben“ legt eins an (mit einem Spaten)." }),
	}
}
/// `tendedBed`: one near the actor may tend before any other; with none such, the nearest bed.
async fn tended_bed(c: &Ctx) -> Result<Json> {
	match bed_here(c, false, Some(&|b: &Json| may_tend(c, b)), None).await {
		Err(Error::NotUnderstood(_)) => bed_here(c, false, None, None).await,
		r => r,
	}
}
async fn write_bed(c: &Ctx, b: &Json) -> Result<()> { c.space.write(&tmpl("Bed", b.clone()), c.txn(), FOREVER).await?; Ok(()) }

async fn describe(c: &Ctx, g: &Json, b: &Json, now: f64) -> Result<String> {
	let mut count: Vec<(String, f64)> = Vec::new();
	for p in j::a(b, "plants") {
		let k = format!("{} ({})", plant_name(g, p), STAGES.get(j::n(p, "stage") as usize).copied().unwrap_or("undefined"));
		match count.iter_mut().find(|(x, _)| *x == k) { Some(s) => s.1 += 1.0, None => count.push((k, 1.0)) }
	}
	let plants = if count.is_empty() { "noch nichts gepflanzt".to_owned() } else { count.iter().map(|(k, n)| format!("{}× {k}", nt(*n))).collect::<Vec<_>>().join(", ") };
	let ago = now - j::n(b, "wateredWorldMs");
	let water = if ago > j::n(g, "thirstWorldMs") * 0.75 * patience_of(&c.space, c.txn()).await? { "braucht Wasser".to_owned() } else { format!("gegossen vor {}", hours(ago)) };
	let sponsors = j::a(b, "sponsors");
	Ok(format!("{}{} ({}×{}): {plants}; {water}{}{}.", bed_name(b), if kind(b) == "gemein" { format!(", angelegt von {}", txt(j::at(b, "ownerName"))) } else { String::new() }, txt(j::at(b, "w")), txt(j::at(b, "h")), if j::b(b, "weedy") { ", voller Unkraut" } else { "" },
		if sponsors.is_empty() { String::new() } else { format!("; Paten: {}", sponsors.iter().map(|s| txt(j::at(s, "name"))).collect::<Vec<_>>().join(", ")) }))
}

/// `freeBed`: a bed goes back to grass: its cells, its light and, for a community bed, the fire's place for one.
async fn free_bed(space: &Space, txn: &str, b: &Json) -> Result<()> {
	free_cells(space, txn, j::s(b, "room"), j::at(b, "bedId")).await?;
	release_light(space, txn, j::at(b, "beaconId"), j::n(b, "points")).await?;
	if kind(b) == "gemein" { space.take_if_exists(&tmpl("BedCommons", obj! { "bedId" => j::at(b, "bedId").clone() }), 5_000.0, Some(txn)).await?; }
	Ok(())
}

fn unique_or(e: Error, why: &str) -> Result<()> { if e.to_string().contains("unique entry already exists") { refuse(why) } else { Err(e) } }

/// `dig`: `[zier|gemeinschaft] [x y]`.
async fn dig(c: &mut Ctx, arg: &str) -> Result<()> {
	let g = garden(c)?;
	let trimmed = js::trim(arg);
	let k = js::re(KIND_WORD, "i").exec(trimmed);
	let kind = k.as_ref().and_then(|m| if m.group(trimmed, 1).is_some_and(|s| !s.is_empty()) { Some("zier") } else if m.group(trimmed, 2).is_some_and(|s| !s.is_empty()) { Some("gemein") } else { None });
	let at = k.as_ref().map_or(arg, |m| &trimmed[m.end..]).to_owned();
	let size = j::at(&g, if kind == Some("gemein") { "commons" } else { "bed" }).clone();
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste können als Pate gießen und ernten, aber kein eigenes Beet anlegen; registriere dich dafür.") };
	if !human(c) { return refuse("Beete legen nur Menschen an."); }
	need_rank(c, "siedler", "Beete anlegen").await?;
	let spade = j::s(&g, "spade").to_owned();
	if !inventory(c).await?.iter().any(|i| j::s(fields(i), "proto") == spade) { let n = proto_name(c, &spade); return refuse(format!("Zum Umgraben brauchst du einen {n} („craft {}“).", js::lower(&n))); }
	let acc = j::at(&account, "accountId").clone();
	if kind != Some("gemein") && c.space.count(&tmpl("Bed", obj! { "accountId" => acc.clone() }), None).await? - c.space.count(&tmpl("Bed", obj! { "accountId" => acc.clone(), "kind" => "gemein" }), None).await? >= j::n(&g, "maxBeds") {
		return refuse(format!("Mehr als {} Beete pflegt niemand (ein Gemeinschaftsbeet zählt nicht dazu).", txt(j::at(&g, "maxBeds"))));
	}
	let points = j::n(&size, "points");
	let light = match light_for(c, points).await? { Ok(l) => l, Err(why) => return refuse(why.replacen("gebaut wird", "gegärtnert wird", 1).replacen("Bau", "Beet", 1)) };
	if kind == Some("gemein") && c.space.peek(&tmpl("BedCommons", obj! { "beaconId" => light.beacon_id.as_str() }), None).await?.is_some() { return refuse("Im Licht dieses Feuers liegt schon ein Gemeinschaftsbeet; pflanze dort mit („beet“ zeigt es)."); }
	let room = room_of(c, None).await?;
	let (w, h) = (j::n(&size, "w"), j::n(&size, "h"));
	let tries = match js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(&at)) {
		Some(m) => vec![Rect { x: js::to_number(m[1].as_deref().unwrap_or("")), y: js::to_number(m[2].as_deref().unwrap_or("")), w, h }],
		None => besides(c, w, h),
	};
	let (mut rect, mut why) = (None, String::new());
	for r in tries { match refusal(c, &room, r, true, true).await? { None => { rect = Some(r); break; } Some(n) => if why.is_empty() { why = n; } } }
	let Some(rect) = rect else { return refuse(format!("Hier passt kein Beet hin: {why}")) };
	let bed_id = format!("bed-{}", hex(&random_bytes(6)));
	let now = world_now_of(&c.space, c.txn()).await?;
	let room_id = j::s(&room, "roomId").to_owned();
	for p in cells(rect) {
		if let Err(e) = c.space.write_unique(&tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => p.0, "y" => p.1, "of" => bed_id.as_str() }), c.txn(), FOREVER, &["room", "x", "y"]).await { unique_or(e, "Dort hat gerade jemand anderes umgegraben.")?; }
	}
	if kind == Some("gemein") {
		if let Err(e) = c.space.write_unique(&tmpl("BedCommons", obj! { "beaconId" => light.beacon_id.as_str(), "bedId" => bed_id.as_str() }), c.txn(), FOREVER, &["beaconId"]).await { unique_or(e, "Im Licht dieses Feuers hat gerade jemand ein Gemeinschaftsbeet angelegt.")?; }
	}
	use_light(c, &light, points).await?;
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(j::at(&g, "bed"), "keepWorldMs");
	let mut b = match kind { Some(k) => obj! { "kind" => k }, None => obj! {} };
	for (k, v) in [("bedId", Json::from(bed_id.as_str())), ("room", Json::from(room_id.as_str())), ("x", Json::from(rect.x)), ("y", Json::from(rect.y)), ("w", Json::from(rect.w)), ("h", Json::from(rect.h)), ("owner", Json::from(c.char_id())), ("ownerName", j::at(&c.actor, "name").clone()), ("accountId", acc), ("beaconId", Json::from(light.beacon_id.as_str())), ("points", Json::from(points)),
		("sponsors", Json::Array(vec![])), ("plants", Json::Array(vec![])), ("wateredWorldMs", Json::from(now)), ("weedy", Json::Bool(false)), ("dueWorldMs", Json::from(FOREVER)), ("untilWorldMs", Json::from(until)), ("at", Json::from(now))] { j::set(&mut b, k, v); }
	write_bed(c, &b).await?;
	let me = txt(j::at(&c.actor, "name"));
	let (rw, rh) = (nt(rect.w), nt(rect.h));
	msg(c, "*", "info", &match kind {
		Some("gemein") => format!("{me} legt ein Gemeinschaftsbeet an ({rw}×{rh}): pflanzen darf jeder mit Konto, gießen, jäten und ernten alle."),
		Some(_) => format!("{me} gräbt ein Zierbeet um ({rw}×{rh}): nur Blumen wachsen darin, und nebeneinander kreuzen sie sich manchmal."),
		None => format!("{me} gräbt ein Beet um ({rw}×{rh}). „pflanze <samen>“ setzt etwas hinein."),
	}, MsgOpts::default()).await
}

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"umgraben" => dig(c, arg).await,
		"beet" => beet(c, arg).await,
		"pflanze" => pflanze(c, arg).await,
		"gieße" => giesse(c).await,
		"jäte" => jaete(c).await,
		"ernte" => ernte(c, arg).await,
		"pate" => pate(c, arg).await,
		"sammle" => sammle(c, arg).await,
		"schöpfe" => schoepfe(c).await,
		"benenne" => benenne(c, arg).await,
		k => Err(Error::Other(format!("unported: garden/{k}"))),
	}
}

fn words(arg: &str) -> (String, Vec<String>) {
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	(parts.first().cloned().unwrap_or_default(), parts.get(1..).unwrap_or(&[]).to_vec())
}

async fn beet(c: &mut Ctx, arg: &str) -> Result<()> {
	let g = garden(c)?;
	let (word, rest) = words(arg);
	let kw = js::re(KIND_WORD, "i").test(&word);
	if js::re(r"^(?:anlegen|neu|new|umgraben|\d+)$", "i").test(&word) || kw { let a = if js::re(r"^\d+$", "").test(&word) || kw { arg.to_owned() } else { rest.join(" ") }; return dig(c, &a).await; }
	if js::re(r"^(?:aufgeben|abreissen|abreißen|weg|remove)$", "i").test(&word) {
		let b = bed_here(c, true, None, Some(1.0)).await?;
		let txn = c.txn().unwrap_or("").to_owned();
		free_bed(&c.space, &txn, &b).await?;
		return msg(c, "*", "info", &format!("{} gibt das {} auf; dort wächst wieder Gras.", txt(j::at(&c.actor, "name")), bed_word(&b)), MsgOpts::default()).await;
	}
	let at: Option<(f64, f64)> = if js::re(r"^(?:ansehen|look)$", "i").test(&word) { match (rest.first(), rest.get(1)) { (Some(x), Some(y)) => Some((js::to_number(x), js::to_number(y))), _ => None } } else { None };
	let one = |b: &Json| at.is_none_or(|(x, y)| x >= j::n(b, "x") && y >= j::n(b, "y") && x < j::n(b, "x") + j::n(b, "w") && y < j::n(b, "y") + j::n(b, "h"));
	let beds: Vec<Json> = c.space.read_all(&tmpl("Bed", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|b| one(b)).collect();
	let me = c.char_id().to_owned();
	if beds.is_empty() { return msg(c, &me, "info", &format!("Hier ist kein Beet. Mit einem {} legt „umgraben“ eins an.", proto_name(c, j::s(&g, "spade"))), MsgOpts::default()).await; }
	let now = world_now_of(&c.space, c.txn()).await?;
	let mut out = Vec::new();
	for b in &beds { out.push(describe(c, &g, b, now).await?); }
	msg(c, &me, "look", &out.join("\n"), MsgOpts::default()).await
}

fn plants_of(b: &Json) -> Vec<Json> { j::a(b, "plants").to_vec() }

async fn pflanze(c: &mut Ctx, arg: &str) -> Result<()> {
	let g = garden(c)?;
	let counted = js::caps(&js::re(r"^(\d+)\s+(.+)$", ""), js::trim(arg));
	let want = counted.as_ref().map_or(1.0, |m| js::to_number(m[1].as_deref().unwrap_or("")));
	let rest = counted.as_ref().map_or_else(|| arg.to_owned(), |m| m[2].clone().unwrap_or_default());
	let line = js::re(r"\s+(?:in|ins)\s+(?:das\s+|mein\s+)?beet$", "i").replace(js::trim(&rest), "");
	let m = js::caps(&js::re(r"^(.+?)(?:\s+(\d+)\s+(\d+))?$", ""), &line);
	let Some(m) = m.filter(|m| m[1].as_deref().is_some_and(|s| !s.is_empty())) else { return not_understood("Was pflanzt du? Zum Beispiel: pflanze strandnelke") };
	let m1 = m[1].clone().unwrap_or_default();
	if want < 1.0 { return refuse("Wie viele? Zum Beispiel: pflanze 3 strandnelken"); }
	let sorts = j::a(&g, "sorts").to_vec();
	let seeds: Vec<Json> = inventory(c).await?.into_iter().filter(|i| sorts.iter().any(|s| j::at(s, "seed") == j::at(fields(i), "proto"))).collect();
	let said = js::lower(js::trim(&no_article(&m1)));
	let hits = items_named(c.w(), &seeds, &said, None);
	let names_said = |f: &Json| std::iter::once(j::s(f, "name")).chain(j::a(f, "aliases").iter().filter_map(Json::as_str)).any(|a| js::lower(a) == said);
	let hit = hits.iter().find(|i| { let f = fields(i); !j::b(f, "variety") || names_said(f) }).or(hits.first()).cloned();
	let Some(hit) = hit else {
		if sow_on_field(c, &said).await? { return Ok(()); }
		if seeds.is_empty() { return not_understood("Du trägst keine Samen. „sammle samen“ sucht welche in der wilden Flora."); }
		let mut names: Vec<String> = Vec::new();
		for s in &seeds { let n = txt(j::at(fields(s), "name")); if !names.contains(&n) { names.push(n); } }
		return not_understood(format!("Du hast keinen Samen, der „{}“ heißt. Du trägst: {}.", js::slice16(&m1, 0, Some(30)), names.join(", ")));
	};
	let hf = fields(&hit).clone();
	let sort = sorts.iter().find(|s| j::at(s, "seed") == j::at(&hf, "proto")).cloned().unwrap_or(Json::Null);
	let mut b = match bed_here(c, false, Some(&|x: &Json| may_plant(c, x)), None).await {
		Err(Error::NotUnderstood(t)) => {
			if c.account.as_ref().is_some_and(|a| j::b(a, "guest")) && c.space.count(&tmpl("Bed", obj! { "room" => c.room(), "kind" => "gemein" }), None).await? != 0.0 { return refuse("Gäste gießen, jäten und ernten am Gemeinschaftsbeet; pflanzen darf, wer sich registriert hat."); }
			return Err(Error::NotUnderstood(t));
		}
		r => r?,
	};
	if kind(&b) == "zier" && j::s(&sort, "kind") != "zier" { return refuse(format!("Ins Zierbeet kommen nur Blumen; {} gehört in ein Gartenbeet.", txt(j::at(&sort, "name")))); }
	let mut plants = plants_of(&b);
	let free: Vec<(f64, f64)> = cells(Rect::of(&b)).into_iter().filter(|p| !plants.iter().any(|q| j::n(q, "x") == p.0 && j::n(q, "y") == p.1)).collect();
	let first: isize = match (&m[2], &m[3]) {
		(Some(x), Some(y)) => { let (x, y) = (js::to_number(x), js::to_number(y)); free.iter().position(|p| p.0 == x && p.1 == y).map_or(-1, |i| i as isize) }
		_ => 0,
	};
	if first < 0 || free.is_empty() { return refuse(if !free.is_empty() { "Diese Zelle gehört nicht zum Beet oder ist schon bepflanzt." } else { "Das Beet ist voll; ernte erst oder jäte das Welke aus." }); }
	let first = first as usize;
	let targets: Vec<(f64, f64)> = free[first..].iter().chain(free[..first].iter()).take(want as usize).copied().collect();
	let hv = variety(&hf).cloned();
	// the oracle compares the variety objects themselves: a crossing's seed is the same only as itself
	let same: Vec<&Json> = hits.iter().filter(|i| { let f = fields(i); j::at(f, "proto") == j::at(&hf, "proto") && match (&hv, j::opt(f, "variety")) { (None, None) => true, (Some(_), Some(_)) => j::at(f, "itemId") == j::at(&hf, "itemId"), _ => false } }).collect();
	let hit_name = txt(j::at(&hf, "name"));
	let label = if want > 1.0 { format!("{} {}", nt(want), plural_of(&hit_name, Some(c.w()))) } else { hit_name.clone() };
	if (same.len() as f64) < want { return refuse(format!("Du trägst nur {}× {hit_name}.", same.len())); }
	let word = bed_word(&b);
	if (targets.len() as f64) < want { return refuse(if targets.len() == 1 { format!("Im {word} ist nur eine Zelle frei, nicht genug für {label}.") } else { format!("Im {word} sind nur {} Zellen frei, nicht genug für {label}.", targets.len()) }); }
	let me = c.char_id().to_owned();
	for seed in same.iter().take(want as usize) {
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(seed), "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Der Samen ist gerade nicht greifbar; bitte noch einmal."); }
	}
	let now = world_now_of(&c.space, c.txn()).await?;
	let factor = grow_factor(fog_of(&c.space, j::s(&b, "room")).await?, j::b(&b, "weedy"));
	let grow0 = j::a(&sort, "grow").first().map_or(f64::NAN, j::number);
	for cell in &targets {
		let mut p = obj! { "x" => cell.0, "y" => cell.1, "sort" => j::at(&sort, "key").clone(), "stage" => 0.0, "dueWorldMs" => now + grow0 * factor };
		if let Some(v) = &hv { j::set(&mut p, "variety", v.clone()); }
		plants.push(p);
	}
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(j::at(&g, "bed"), "keepWorldMs");
	let due = next_due(&plants);
	let what = if hv.is_some() { plant_name(&g, plants.last().unwrap_or(&Json::Null)) } else { txt(j::at(&sort, "name")) };
	for (k, v) in [("plants", Json::Array(plants)), ("wateredWorldMs", Json::from(now)), ("untilWorldMs", Json::from(until)), ("dueWorldMs", Json::from(due))] { j::set(&mut b, k, v); }
	write_bed(c, &b).await?;
	if kind(&b) == "gemein" { credit_deed(c, "beet").await?; }
	let said_what = if want > 1.0 { format!("{} {}", nt(want), plural_of(&what, Some(c.w()))) } else { what };
	msg(c, "*", "emote", &format!("{} setzt {said_what} ins {word}.", txt(j::at(&c.actor, "name"))), MsgOpts::default()).await
}

async fn giesse(c: &mut Ctx) -> Result<()> {
	let g = garden(c)?;
	let can_proto = j::s(&g, "can").to_owned();
	let Some(can) = inventory(c).await?.into_iter().find(|i| j::s(fields(i), "proto") == can_proto) else { return refuse(format!("Du hast keine {}. An einer Regentonne füllt „schöpfe“ eine.", proto_name(c, &can_proto))) };
	let mut b = tended_bed(c).await?;
	if !may_tend(c, &b) { return refuse(format!("Das ist das {}; gießen dürfen der Besitzer und seine Paten.", bed_name(&b))); }
	if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(&can), "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Die Kanne ist gerade nicht greifbar; bitte noch einmal."); }
	let now = world_now_of(&c.space, c.txn()).await?;
	j::set(&mut b, "wateredWorldMs", now);
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(j::at(&g, "bed"), "keepWorldMs");
	j::set(&mut b, "untilWorldMs", until);
	write_bed(c, &b).await?;
	if kind(&b) == "gemein" { credit_deed(c, "beet").await?; }
	let me = txt(j::at(&c.actor, "name"));
	msg(c, "*", "emote", &if mine(c, &b) { format!("{me} gießt das {}.", if kind(&b) == "gemein" { "Gemeinschaftsbeet" } else { "Beet" }) } else { format!("{me} gießt das {}.", bed_name(&b)) }, MsgOpts::default()).await
}

async fn jaete(c: &mut Ctx) -> Result<()> {
	let g = garden(c)?;
	let mut b = tended_bed(c).await?;
	if !may_tend(c, &b) { return refuse(format!("Das ist das {}; jäten dürfen der Besitzer und seine Paten.", bed_name(&b))); }
	let wilted = j::a(&b, "plants").iter().filter(|p| j::n(p, "stage") == 3.0).count() as f64;
	if !j::b(&b, "weedy") && wilted == 0.0 { return refuse("Das Beet ist sauber; hier gibt es nichts zu jäten."); }
	let _now = world_now_of(&c.space, c.txn()).await?;
	let plants: Vec<Json> = j::a(&b, "plants").iter().filter(|p| j::n(p, "stage") != 3.0).cloned().collect();
	let due = next_due(&plants);
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(j::at(&g, "bed"), "keepWorldMs");
	for (k, v) in [("weedy", Json::Bool(false)), ("plants", Json::Array(plants)), ("dueWorldMs", Json::from(due)), ("untilWorldMs", Json::from(until))] { j::set(&mut b, k, v); }
	write_bed(c, &b).await?;
	if kind(&b) == "gemein" { credit_deed(c, "beet").await?; }
	msg(c, "*", "emote", &format!("{} jätet das Beet{}.", txt(j::at(&c.actor, "name")), if wilted != 0.0 { format!(" und zieht {} heraus", plural(wilted, "welke Pflanze", "welke Pflanzen")) } else { String::new() }), MsgOpts::default()).await
}

/// `crossings`: the ripe flowers (indices into the bed's plants) that cross at this harvest, each with its neighbour.
pub fn crossings(g: &Json, plants: &[Json], ripe: &[usize]) -> Vec<(usize, usize)> {
	let mut out = Vec::new();
	let zier = |p: &Json| sort_of(g, j::s(p, "sort")).is_some_and(|s| j::s(s, "kind") == "zier");
	for &i in ripe {
		let p = &plants[i];
		if !zier(p) { continue; }
		let beside: Vec<usize> = (0..plants.len()).filter(|&k| { let q = &plants[k]; k != i && j::n(q, "stage") < 3.0 && zier(q) && (j::n(q, "x") - j::n(p, "x")).abs() + (j::n(q, "y") - j::n(p, "y")).abs() == 1.0 && strain(q) != strain(p) }).collect();
		if !beside.is_empty() && random() < j::n(g, "crossChance") { let k = (random() * beside.len() as f64).floor() as usize % beside.len(); out.push((i, beside[k])); }
	}
	out
}
fn parse_hex_prefix(s: &str) -> f64 {
	let d: String = s.chars().take_while(char::is_ascii_hexdigit).collect();
	if d.is_empty() { 0.0 } else { i64::from_str_radix(&d, 16).map_or(0.0, |v| v as f64) }
}
/// `mixColor`: between two colours, a little off to one side.
pub fn mix_color(a: &str, b: &str) -> String {
	let ch = |h: &str, i: isize| parse_hex_prefix(js::slice16(h, 1 + 2 * i, Some(3 + 2 * i)));
	let mut out = String::from("#");
	for i in 0..3 { let v = 0f64.max(255f64.min(js::round((ch(a, i) + ch(b, i)) / 2.0 + (random() - 0.5) * 48.0))); out.push_str(&format!("{:02x}", v as i64)); }
	out
}
/// `namesOf`: a variety named after its plant was set gets its name at the harvest.
async fn names_of(c: &Ctx, plants: &mut [Json], ripe: &[usize]) -> Result<()> {
	let mut ids: Vec<Json> = Vec::new();
	for &i in ripe { if let Some(v) = variety(&plants[i]) { if !j::b(v, "name") { let id = j::at(v, "id").clone(); if !ids.contains(&id) { ids.push(id); } } } }
	for id in ids {
		let Some(e) = c.space.peek(&tmpl("Variety", obj! { "varietyId" => id.clone() }), None).await? else { continue };
		let name = j::at(fields(&e), "name").clone();
		for &i in ripe {
			if variety(&plants[i]).is_some_and(|v| j::at(v, "id") == &id) { let mut v = j::at(&plants[i], "variety").clone(); j::set(&mut v, "name", name.clone()); j::set(&mut plants[i], "variety", v); }
		}
	}
	Ok(())
}
/// `varietyOwn`: what a thing of a variety is called and looks like.
fn variety_own(proto: &Json, v: &Json, seed: bool) -> Json {
	let vn = txt(j::at(v, "name"));
	let n = js::lower(&vn);
	let named = j::b(v, "name");
	let pname = txt(j::at(proto, "name"));
	let breeder = txt(j::at(v, "breederName"));
	let pdesc = txt(j::at(proto, "desc"));
	let mut glyph = j::object(j::at(proto, "glyph"));
	glyph.insert("color".to_owned(), j::at(v, "color").clone());
	obj! {
		"name" => if named { if seed { format!("{vn}-Samen") } else { vn.clone() } } else if seed { "Kreuzungssamen".to_owned() } else { pname },
		"aliases" => if named { if seed { Json::Array(vec![Json::from(format!("{n}-samen")), Json::from(format!("{n}samen")), Json::from(n.clone())]) } else { Json::Array(vec![Json::from(n.clone())]) } } else if seed { Json::Array(vec![Json::from("kreuzung"), Json::from("kreuzungssamen")]) } else { j::at(proto, "aliases").clone() },
		"desc" => if seed { format!("Samen einer Kreuzung{}, gezogen von {breeder}. {pdesc}", if named { format!(" namens {vn}") } else { String::new() }) } else { format!("{pdesc} Eine Züchtung von {breeder}.") },
		"glyph" => Json::Object(glyph),
		"variety" => v.clone(),
	}
}
/// What a harvest gives: prototype, count and the variety it keeps.
type Gift = (String, f64, Option<Json>);
/// `giveOwn`: like giveBack, and a thing of a variety keeps it.
async fn give_own(c: &Ctx, g: &Json, what: Vec<Gift>) -> Result<Vec<String>> {
	let mut sum: Vec<(String, Gift)> = Vec::new();
	for x in what {
		let k = format!("{}|{}", x.0, x.2.as_ref().map_or_else(String::new, |v| txt(j::at(v, "id"))));
		match sum.iter_mut().find(|(s, _)| *s == k) { Some(slot) => slot.1 = (x.0, slot.1 .1 + x.1, x.2), None => sum.push((k, x)) }
	}
	let mut out = Vec::new();
	for (_, (proto, count, v)) in sum {
		if count <= 0.0 { continue; }
		let Some(v) = v else { out.extend(give_back(c, &[(proto, count)]).await?); continue };
		let Some(p) = resolve_prototype(&c.space, &proto).await? else { continue };
		let own = variety_own(&p, &v, j::a(g, "sorts").iter().any(|s| j::s(s, "seed") == proto));
		for _ in 0..count as usize { spawn(&c.space, c.txn(), c.w(), &p, At { location: c.char_id().to_owned(), x: -1.0, y: -1.0, ..Default::default() }, &own).await?; }
		out.push(format!("{} {}", nt(count), txt(j::at(&own, "name"))));
	}
	Ok(out)
}

async fn ernte(c: &mut Ctx, arg: &str) -> Result<()> {
	let g = garden(c)?;
	if js::re(r"^(?:die\s+|der\s+|das\s+)?(?:flur|acker|feld|field)$", "i").test(js::trim(arg)) {
		if harvest_field(c).await? { return Ok(()); }
		return not_understood("Hier ist kein Acker. „flur anlegen“ legt eine an (mit einem Spaten, im Licht eines Feuers).");
	}
	let mut b = match tended_bed(c).await {
		Err(Error::NotUnderstood(t)) => { if harvest_field(c).await? { return Ok(()); } return Err(Error::NotUnderstood(t)); }
		r => r?,
	};
	if !may_tend(c, &b) { return refuse(format!("Das ist das {}; ernten dürfen der Besitzer und seine Paten.", bed_name(&b))); }
	let mut plants = plants_of(&b);
	let all_ripe: Vec<usize> = (0..plants.len()).filter(|&i| j::n(&plants[i], "stage") == 2.0).collect();
	if all_ripe.is_empty() { return refuse("Im Beet ist noch nichts reif."); }
	let n = all_ripe.len() as f64;
	let share = if kind(&b) != "gemein" { n } else if mine(c, &b) { 1f64.max((n * 2.0 / 3.0).floor()) } else { COMMONS_TAKE.min(1f64.max((n / 2.0).floor())) };
	let ripe: Vec<usize> = all_ripe.iter().take(share as usize).copied().collect();
	let left = all_ripe.len() - ripe.len();
	let _now = world_now_of(&c.space, c.txn()).await?;
	names_of(c, &mut plants, &ripe).await?;
	let crossed = if kind(&b) == "zier" { crossings(&g, &plants, &ripe) } else { Vec::new() };
	let mut got: Vec<Gift> = Vec::new();
	let mut news: Vec<String> = Vec::new();
	for &i in &ripe {
		let p = &plants[i];
		let Some(sort) = sort_of(&g, j::s(p, "sort")) else { continue };
		let seeds = 1.0 + if random_int(0.0, 10.0) < 3.0 { 1.0 } else { 0.0 };
		let other = crossed.iter().find(|(a, _)| *a == i).map(|(_, o)| *o);
		let v = variety(p).cloned();
		let y = j::at(sort, "yields");
		got.push((txt(j::at(y, "proto")), j::n(y, "count"), v.clone()));
		got.push((txt(j::at(sort, "seed")), if other.is_some() { seeds - 1.0 } else { seeds }, v));
		if let Some(o) = other {
			let id = format!("var-{}", hex(&random_bytes(6)));
			let color = mix_color(&color_of(&g, p), &color_of(&g, &plants[o]));
			got.push((txt(j::at(sort, "seed")), 1.0, Some(obj! { "id" => id, "name" => "", "color" => color, "breeder" => c.char_id(), "breederName" => j::at(&c.actor, "name").clone() })));
			news.push(format!("{} und {}", plant_name(&g, p), plant_name(&g, &plants[o])));
		}
	}
	let names = give_own(c, &g, got).await?;
	let kept: Vec<Json> = plants.into_iter().enumerate().filter(|(i, _)| !ripe.contains(i)).map(|(_, p)| p).collect();
	let due = next_due(&kept);
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(j::at(&g, "bed"), "keepWorldMs");
	for (k, v) in [("plants", Json::Array(kept)), ("dueWorldMs", Json::from(due)), ("untilWorldMs", Json::from(until))] { j::set(&mut b, k, v); }
	write_bed(c, &b).await?;
	if kind(&b) == "gemein" { credit_deed(c, "beet").await?; }
	let which = if mine(c, &b) && kind(&b) != "gemein" { format!("das {}", if kind(&b) == "zier" { "Zierbeet" } else { "Beet" }) } else { format!("das {}", bed_name(&b)) };
	msg(c, "*", "emote", &format!("{} erntet {which}: {}.", txt(j::at(&c.actor, "name")), names.join(", ")), MsgOpts::default()).await?;
	let me = c.char_id().to_owned();
	if left != 0 { msg(c, &me, "info", &format!("Am Gemeinschaftsbeet nimmt jeder nur einen Teil: {} für die anderen.", if left == 1 { "eine reife Pflanze bleibt".to_owned() } else { format!("{left} reife Pflanzen bleiben") }), MsgOpts::default()).await?; }
	if !news.is_empty() { msg(c, &me, "info", &format!("Unter den Samen {} aus {}! Was daraus wächst, hat eine eigene Farbe; „benenne <name>“ gibt der neuen Sorte einen Namen.", if news.len() == 1 { "ist eine Kreuzung" } else { "sind Kreuzungen" }, news.join("; aus ")), MsgOpts::default()).await?; }
	Ok(())
}

async fn pate(c: &mut Ctx, arg: &str) -> Result<()> {
	let (first, rest) = words(arg);
	let remove = js::re(r"^(?:weg|ende|kündige|kuendige|stop|remove)$", "i").test(&first);
	let name = js::trim(&if remove { rest.join(" ") } else { arg.to_owned() }).to_owned();
	let mut b = bed_here(c, true, Some(&|x: &Json| kind(x) != "gemein"), Some(SITE_REACH)).await?;
	let me = c.char_id().to_owned();
	let sponsors = j::a(&b, "sponsors").to_vec();
	if name.is_empty() {
		write_bed(c, &b).await?;
		return msg(c, &me, "info", &if sponsors.is_empty() { "Dein Beet hat keinen Paten. „pate <name>“ lässt jemanden gießen, jäten und ernten.".to_owned() } else { format!("Paten deines Beets: {}.", sponsors.iter().map(|s| txt(j::at(s, "name"))).collect::<Vec<_>>().join(", ")) }, MsgOpts::default()).await;
	}
	let lname = js::lower(&name);
	if remove {
		let left: Vec<Json> = sponsors.iter().filter(|s| js::lower(&txt(j::at(s, "name"))) != lname).cloned().collect();
		let unchanged = left.len() == sponsors.len();
		j::set(&mut b, "sponsors", Json::Array(left));
		write_bed(c, &b).await?;
		if unchanged { return refuse(format!("{} ist kein Pate deines Beets.", js::slice16(&name, 0, Some(30)))); }
		return msg(c, "*", "info", &format!("{} beendet die Patenschaft von {name} für das Beet.", txt(j::at(&c.actor, "name"))), MsgOpts::default()).await;
	}
	let who = c.space.read_all(&obj! { "type" => "Character" }, None).await?.iter().map(|e| fields(e).clone()).find(|x| js::lower(&txt(j::at(x, "name"))) == lname);
	let Some(who) = who else { return refuse(format!("Eine Figur „{}“ ist auf dieser Insel nicht bekannt.", js::slice16(&name, 0, Some(30)))) };
	let who_name = txt(j::at(&who, "name"));
	if j::s(&who, "charId") == me { return refuse("Dein eigenes Beet pflegst du ohnehin."); }
	if sponsors.iter().any(|s| j::at(s, "charId") == j::at(&who, "charId")) { return refuse(format!("{who_name} ist schon Pate.")); }
	if sponsors.len() >= 5 { return refuse("Mehr als fünf Paten hat kein Beet."); }
	let mut all = sponsors;
	all.push(obj! { "charId" => j::at(&who, "charId").clone(), "name" => j::at(&who, "name").clone() });
	j::set(&mut b, "sponsors", Json::Array(all));
	write_bed(c, &b).await?;
	msg(c, "*", "info", &format!("{} macht {who_name} zum Paten des Beets: gießen, jäten und ernten darf {who_name} jetzt auch.", txt(j::at(&c.actor, "name"))), MsgOpts::default()).await
}

/// `meansYield` (animals.ts): whether "sammle <arg>" means a yield of the animals.
pub fn means_yield(c: &Ctx, arg: &str) -> bool {
	let n = no_article(&js::lower(js::trim(arg)));
	!n.is_empty() && j::opt(c.w(), "animals").map_or(&[][..], |a| j::a(a, "kinds")).iter().any(|k| {
		j::by(j::a(c.w(), "prototypes"), "key", j::s(k, "yields")).is_some_and(|p| std::iter::once(j::s(p, "key")).chain(std::iter::once(j::s(p, "name"))).chain(j::a(p, "aliases").iter().filter_map(Json::as_str)).any(|a| js::lower(a) == n))
	})
}

async fn sammle(c: &mut Ctx, arg: &str) -> Result<()> {
	if means_yield(c, arg) { return Err(Error::Other("unported: animals/collect".into())); }
	let g = garden(c)?;
	let t = js::trim(arg);
	if !t.is_empty() && !js::re(r"^(?:samen|seeds?|saatgut)$", "i").test(&no_article(t)) { return not_understood("Gesammelt werden hier Samen („sammle samen“) und im Stall, was die Tiere geben („sammle eier“); Dinge am Strand hebst du mit „get“ auf."); }
	let now = world_now_of(&c.space, c.txn()).await?;
	let rest = c.space.peek(&tmpl("SeedRest", obj! { "charId" => c.char_id(), "room" => c.room() }), None).await?;
	let until = rest.as_ref().map_or(0.0, |e| j::n(fields(e), "untilWorldMs"));
	if until > now { return refuse(format!("Du hast hier eben erst gesucht; in etwa {} wieder.", hours(until - now))); }
	let room = j::by(j::a(c.w(), "rooms"), "roomId", c.room()).cloned();
	let decor: HashSet<String> = room.as_ref().map(|r| j::strs(j::a(r, "decor")).concat()).unwrap_or_default().chars().map(String::from).collect();
	let island = room.as_ref().map_or_else(String::new, |r| j::s(r, "island").to_owned());
	let gd = j::at(&g, "decor");
	let grows = |s: &Json| j::opt(s, "wild").filter(|w| j::truthy(w)).is_some_and(|w| j::a(gd, j::s(w, "decor")).iter().any(|k| k.as_str().is_some_and(|k| decor.contains(k))) && j::ao(w, "islands").is_none_or(|is| is.iter().any(|i| i.as_str() == Some(island.as_str()))));
	let crops = j::opt(c.w(), "fields").map_or(&[][..], |f| j::a(f, "crops"));
	let wild: Vec<Json> = j::a(&g, "sorts").iter().chain(crops.iter()).filter(|s| grows(s)).cloned().collect();
	if wild.is_empty() { return refuse("Hier wächst nichts Wildes, das Samen trägt."); }
	if let Some(r) = &rest { c.space.take_if_exists(&obj! { "id" => j::at(r, "id").clone() }, NO_WAIT, c.txn()).await?; }
	c.space.write(&tmpl("SeedRest", obj! { "charId" => c.char_id(), "room" => c.room(), "untilWorldMs" => now + j::n(&g, "seedRestWorldMs") }), c.txn(), FOREVER).await?;
	let me = c.char_id().to_owned();
	if random_int(0.0, 1000.0) >= j::n(&g, "seedChance") * 1000.0 { return msg(c, &me, "info", "Du suchst zwischen den Pflanzen, findest aber keine reifen Samen.", MsgOpts::default()).await; }
	let sort = &wild[random_int(0.0, wild.len() as f64) as usize];
	let got = give_back(c, &[(txt(j::at(sort, "seed")), 1.0)]).await?;
	msg(c, &me, "info", &format!("Du findest {}.", got.join(", ")), MsgOpts::default()).await
}

async fn schoepfe(c: &mut Ctx) -> Result<()> {
	let g = garden(c)?;
	let barrel_key = j::s(&g, "barrel").to_owned();
	let barrel = j::opt(c.w(), "building").and_then(|b| j::by(j::a(b, "plans"), "key", &barrel_key)).cloned();
	let near = format!("Geh direkt neben eine {}.", barrel.as_ref().map_or_else(|| "Regentonne".to_owned(), |p| txt(j::at(p, "name"))));
	let b = match building_here(c, &barrel.as_ref().map_or_else(|| barrel_key.clone(), |p| txt(j::at(p, "name"))), false).await {
		Err(Error::NotUnderstood(_)) => return not_understood(near),
		r => r?,
	};
	if j::s(&b, "plan") != barrel_key { put_back(c, &b).await?; return not_understood(near); }
	let now = world_now_of(&c.space, c.txn()).await?;
	let (cans, at) = barrel_water(&g, &b, now);
	if cans < 1.0 { put_back(c, &b).await?; return refuse(format!("Die {} ist leer; in etwa {} hat sie wieder eine Kanne (bei Sturmflut ist sie voll).", txt(j::at(&b, "name")), hours(at + j::n(&g, "barrelFillWorldMs") - now))); }
	let mut nb = b.clone();
	j::set(&mut nb, "water", cans - 1.0);
	j::set(&mut nb, "waterAtWorldMs", at);
	put_back(c, &nb).await?;
	let can = j::s(&g, "can").to_owned();
	give_back(c, &[(can.clone(), 1.0)]).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("Du füllst eine {} (noch {} in der Tonne).", proto_name(c, &can), nt(cans - 1.0)), MsgOpts::default()).await
}

/// `nameRefused`: a name a variety may have.
async fn name_refused(c: &mut Ctx, g: &Json, name: &str) -> Result<Option<String>> {
	let len = js::len16(name);
	if !(3..=24).contains(&len) || !js::re(r"^\p{L}[\p{L}' -]*\p{L}$", "u").test(name) { return Ok(Some("Ein Sortenname hat 3 bis 24 Buchstaben (Leerzeichen und Bindestrich dazwischen gehen).".into())); }
	let n = js::lower(name);
	let names = |list: &[Json]| -> Vec<String> { list.iter().flat_map(|p| [txt(j::at(p, "key")), txt(j::at(p, "name"))].into_iter().chain(j::a(p, "aliases").iter().map(txt))).collect() };
	let mut taken = names(j::a(c.w(), "prototypes"));
	taken.extend(names(j::a(g, "sorts")));
	if let Some(f) = j::opt(c.w(), "fields") { taken.extend(names(j::a(f, "crops"))); }
	taken.extend(["kreuzung", "kreuzungssamen", "samen"].map(String::from));
	if taken.iter().any(|t| js::lower(t) == n) { return Ok(Some(format!("„{name}“ heißt schon etwas in dieser Welt; wähle einen eigenen Namen."))); }
	let head = js::re(r"\s+", "").split(&n).first().copied().flatten().unwrap_or("").to_owned();
	let has = |k: &str, m: &super::Merged| m.iter().any(|(x, _)| x == k);
	if has(&n, &super::commands_of(c).await?.0) || has(&head, &super::commands_of(c).await?.0) { return Ok(Some(format!("„{name}“ ist ein Befehl; wähle einen anderen Namen."))); }
	Ok(None)
}

fn anew(e: &Json, f: Json) -> Json {
	let types: Vec<Json> = j::a(e, "types").iter().skip(1).cloned().collect();
	obj! { "type" => j::at(e, "type").clone(), "types" => Json::Array(types), "fields" => f }
}

async fn benenne(c: &mut Ctx, arg: &str) -> Result<()> {
	let g = garden(c)?;
	let line = js::re(r"^(?:die\s+)?(?:kreuzung|sorte)\s+(?:als\s+)?", "i").replace(js::trim(arg), "");
	let Some(m) = js::caps(&js::re(r"^(?:(\d+)\s+)?(.+)$", ""), &line) else { return not_understood("Wie soll die neue Sorte heißen? Zum Beispiel: benenne Abendrot") };
	let m2 = m[2].clone().unwrap_or_default();
	let me = c.char_id().to_owned();
	let held: Vec<Json> = inventory(c).await?.into_iter().filter(|i| variety(fields(i)).is_some_and(|v| !j::b(v, "name") && j::s(v, "breeder") == me)).collect();
	let vid = |i: &Json| j::at(j::at(fields(i), "variety"), "id").clone();
	let mut ids: Vec<Json> = Vec::new();
	for i in &held { let id = vid(i); if !ids.contains(&id) { ids.push(id); } }
	if ids.is_empty() { return refuse("Du trägst keine unbenannte Kreuzung, die du gezogen hast. Kreuzungen entstehen im Zierbeet, wenn verschiedene Blumen nebeneinander reifen."); }
	let sort_for = |id: &Json| j::a(&g, "sorts").iter().find(|s| held.iter().any(|i| vid(i) == *id && (j::at(fields(i), "proto") == j::at(s, "seed") || j::at(fields(i), "proto") == j::at(j::at(s, "yields"), "proto")))).cloned();
	if ids.len() > 1 && m[1].is_none() {
		let list = ids.iter().enumerate().map(|(k, id)| format!("{}: aus {} ({})", k + 1, sort_for(id).map_or_else(|| "?".to_owned(), |s| txt(j::at(&s, "name"))), held.iter().find(|x| vid(x) == *id).map_or_else(String::new, |x| txt(j::at(j::at(fields(x), "variety"), "color"))))).collect::<Vec<_>>().join(", ");
		return not_understood(format!("Du trägst mehrere Kreuzungen; welche? {list}. Zum Beispiel: benenne 1 {}", js::slice16(&m2, 0, Some(24))));
	}
	let idx = m[1].as_deref().map_or(0.0, |d| js::to_number(d) - 1.0);
	let Some(id) = (if idx >= 0.0 { ids.get(idx as usize).cloned() } else { None }).filter(j::truthy) else { return not_understood(format!("So viele Kreuzungen trägst du nicht ({}).", ids.len())) };
	let spaced = js::re(r"\s+", "g").replace(js::trim(&m2), " ");
	let name = js::re(r"^\p{Ll}", "u").replace_with(&spaced, |s, m| js::upper(&s[m.start..m.end]));
	if let Some(no) = name_refused(c, &g, &name).await? { return refuse(no); }
	if c.space.peek(&tmpl("Variety", obj! { "varietyId" => id.clone() }), None).await?.is_some() { return refuse("Diese Kreuzung hat schon einen Namen."); }
	let mut v = j::at(fields(held.iter().find(|i| vid(i) == id).unwrap_or(&Json::Null)), "variety").clone();
	j::set(&mut v, "name", name.as_str());
	let sort = sort_for(&id);
	let now = world_now_of(&c.space, c.txn()).await?;
	let vf = obj! { "varietyId" => id.clone(), "name" => name.as_str(), "nameKey" => js::lower(&name), "sort" => sort.as_ref().map_or(Json::from(""), |s| j::at(s, "key").clone()), "color" => j::at(&v, "color").clone(), "breeder" => j::at(&v, "breeder").clone(), "breederName" => j::at(&v, "breederName").clone(), "at" => now };
	if let Err(e) = c.space.write_unique(&tmpl("Variety", vf), c.txn(), FOREVER, &["nameKey"]).await { unique_or(e, &format!("Eine Sorte namens „{name}“ gibt es schon; wähle einen anderen Namen."))?; }
	// what one carries of it takes the name now; plants of it in beds take it at their harvest
	for i in held.iter().filter(|x| vid(x) == id) {
		let f = fields(i);
		let Some(p) = resolve_prototype(&c.space, j::s(f, "proto")).await? else { continue };
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(f, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { continue; }
		let own = variety_own(&p, &v, j::a(&g, "sorts").iter().any(|s| j::at(s, "seed") == j::at(f, "proto")));
		c.space.write(&anew(i, j::spread(f, &own)), c.txn(), FOREVER).await?;
	}
	msg(c, "*", "info", &format!("{} nennt die neue Sorte aus {} „{name}“.", txt(j::at(&c.actor, "name")), sort.map_or_else(|| "dem Zierbeet".to_owned(), |s| txt(j::at(&s, "name")))), MsgOpts::default()).await
}

/// `gardenTick`: beds whose date has come move their plants on, each in a transaction of its own; a bed nobody tended
/// for its time goes back to grass; seed rests that are over go. How many beds were written.
pub async fn garden_tick(space: &Space, w: &Json) -> Result<f64> {
	let Some(g) = j::opt(w, "garden") else { return Ok(0.0) };
	let now = world_now_of(space, None).await?;
	let kept = decay_now_of(space, None).await?;
	let patient = patience_of(space, None).await?;
	let winter = frozen_until(space, now).await?;
	let glass = j::opt(g, "greenhouse");
	let houses: Vec<Json> = match (winter, glass) { (Some(_), Some(gl)) => space.read_all(&tmpl("Building", obj! { "plan" => j::at(gl, "plan").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect(), _ => Vec::new() };
	let mut written = 0.0;
	for e in space.read_all(&obj! { "type" => "Bed" }, None).await? {
		let b = fields(&e);
		if j::n(b, "dueWorldMs") > now && j::n(b, "untilWorldMs") > kept { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&tmpl("Bed", obj! { "bedId" => j::at(b, "bedId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let mut bed = fields(&t).clone();
			if j::n(&bed, "dueWorldMs") > now && j::n(&bed, "untilWorldMs") > kept { return Ok(false); }
			if j::n(&bed, "untilWorldMs") <= kept { free_bed(space, &txn, &bed).await?; } else {
				let fog = fog_of(space, j::s(&bed, "room")).await?;
				let reach = glass.map_or(f64::NAN, |gl| j::n(gl, "reach"));
				let (bx, by, bw, bh) = (j::n(&bed, "x"), j::n(&bed, "y"), j::n(&bed, "w"), j::n(&bed, "h"));
				let sheltered = houses.iter().any(|h| j::at(h, "room") == j::at(&bed, "room") && (j::n(h, "x") - (bx + bw - 1.0)).max(bx - (j::n(h, "x") + j::n(h, "w") - 1.0)).max(j::n(h, "y") - (by + bh - 1.0)).max(by - (j::n(h, "y") + j::n(h, "h") - 1.0)) <= reach);
				advance(g, &mut bed, now, fog, patient, if sheltered { None } else { winter });
				space.write(&tmpl("Bed", bed), Some(&txn), FOREVER).await?;
			}
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; written += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	for e in space.read_all(&obj! { "type" => "SeedRest" }, None).await? {
		if j::number(j::at(fields(&e), "untilWorldMs")) <= now { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, None).await?; }
	}
	Ok(written)
}

/// `stormFillsBarrels`: a storm surge fills the rain barrels of its island.
pub async fn storm_fills_barrels(space: &Space, w: &Json, room_id: Option<&str>) -> Result<()> {
	let (Some(g), Some(room_id)) = (j::opt(w, "garden"), room_id) else { return Ok(()) };
	let island = j::by(j::a(w, "rooms"), "roomId", room_id).map(|r| j::at(r, "island").clone()).unwrap_or(Json::Null);
	let rooms: Vec<&str> = j::a(w, "rooms").iter().filter(|r| *j::at(r, "island") == island).map(|r| j::s(r, "roomId")).collect();
	let now = world_now_of(space, None).await?;
	let cap = j::n(g, "barrelCap");
	for e in space.read_all(&tmpl("Building", obj! { "plan" => j::at(g, "barrel").clone() }), None).await? {
		let b = fields(&e);
		if !rooms.contains(&j::s(b, "room")) || j::no(b, "water").unwrap_or(0.0) >= cap { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let mut nb = fields(&t).clone();
			j::set(&mut nb, "water", cap);
			j::set(&mut nb, "waterAtWorldMs", now);
			space.write(&tmpl("Building", nb), Some(&txn), FOREVER).await?;
			Ok(true)
		}.await;
		match r {
			Ok(true) => space.commit(&txn).await?,
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(())
}
