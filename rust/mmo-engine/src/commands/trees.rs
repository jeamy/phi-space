//! Trees (`server/engine/commands/trees.ts`): a tree's seed planted with a spade in the light of a fire grows over days of
//! the second clock and stands until it is felled; felled with an axe it gives logs (driftwood under their own name), a
//! birch and a willow sprout again from the stump, a fruit tree bears and is picked by its owner. A tree carries one date;
//! `tree_tick` writes it only when that date has come.
use phi_json::{obj, Json};

use super::build::{besides, dist_to, free_cells, give_back, human, light_for, no_article, refusal, release_light, rested, take_near, tire, use_light, Rect, SITE_REACH};
use super::garden::{grow_factor, proto_name};
use super::settlement::need_rank;
use super::trade::{consume, move_item};
use crate::clock::{frozen_until, patience_of, world_now_of};
use crate::context::{ensure_account, inventory, items_named, level_of, msg, room_of, Ctx, MsgOpts};
use crate::fire::{fog_of, key_text};
use crate::j;
use crate::js;
use crate::source::{hex, random_bytes, random_int};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
const STAGES: [&str; 3] = ["Setzling", "junger Baum", "ausgewachsen"];

/// `sortOfTree`.
pub fn sort_of_tree<'a>(d: &'a Json, key: &str) -> Option<&'a Json> { j::by(j::a(d, "sorts"), "key", key) }
fn sort_name(d: &Json, t: &Json) -> String { sort_of_tree(d, j::s(t, "sort")).map_or_else(|| txt(j::at(t, "sort")), |s| txt(j::at(s, "name"))) }
fn mine(c: &Ctx, t: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(t, "accountId") == j::at(a, "accountId")) }
fn crop(s: &Json) -> Option<&Json> { j::opt(s, "crop").filter(|x| j::truthy(x)) }
/// `span`: minutes, hours, from two days on days.
fn span(ms: f64) -> String {
	let h = js::round(ms / 3_600_000.0);
	if h >= 48.0 { return format!("{} Tagen", nt(js::round(h / 24.0))); }
	if h >= 1.0 { format!("{} {}", nt(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { format!("{} Minuten", nt(1f64.max(js::round(ms / 60_000.0)))) }
}

/// `nextDate`: when a tree in `stage` next changes: grows on (seedling, young tree) or bears (grown); FOREVER when nothing comes.
pub fn next_date(s: &Json, stage: f64, now: f64, fog: f64, patient: f64) -> f64 {
	if stage < 2.0 { return now + j::a(s, "grow").get(stage as usize).map_or(f64::NAN, j::number) * patient * grow_factor(fog, false); }
	crop(s).map_or(FOREVER, |cr| now + j::n(cr, "everyWorldMs") * patient)
}

/// `advanceTree`: a tree whose date has come grows on or bears; true when anything changed. In winter it waits for the spring.
pub fn advance_tree(d: &Json, t: &mut Json, now: f64, fog: f64, patient: f64, frozen: Option<f64>) -> bool {
	if j::n(t, "dueWorldMs") > now { return false; }
	let s = sort_of_tree(d, j::s(t, "sort")).cloned();
	let stage = j::n(t, "stage");
	if let Some(fr) = frozen { j::set(t, "dueWorldMs", fr); }
	else if let Some(s) = s {
		if stage < 2.0 { j::set(t, "stage", stage + 1.0); j::set(t, "dueWorldMs", next_date(&s, stage + 1.0, now, fog, patient)); }
		else if crop(&s).is_some() { j::set(t, "ripe", true); j::set(t, "dueWorldMs", FOREVER); }
		else { j::set(t, "dueWorldMs", FOREVER); }
	} else { j::set(t, "dueWorldMs", FOREVER); }
	true
}

fn trees(c: &Ctx) -> Result<Json> { match j::opt(c.w(), "trees") { Some(d) => Ok(d.clone()), None => refuse("In dieser Welt pflanzt niemand Bäume.") } }
fn unique_or(e: Error, why: &str) -> Result<()> { if e.to_string().contains("unique entry already exists") { refuse(why) } else { Err(e) } }

/// `plantTree`: `pflanze <samen> [x y]` with a tree's seed; false when the line names no tree seed one carries.
pub async fn plant_tree(c: &mut Ctx, arg: &str) -> Result<bool> {
	let Some(d) = j::opt(c.w(), "trees").cloned() else { return Ok(false) };
	let line = js::re(r"\s+(?:in\s+die\s+erde|ein)$", "i").replace(js::trim(arg), "");
	let Some(m) = js::caps(&js::re(r"^(.+?)(?:\s+(\d+)\s+(\d+))?$", ""), &line).filter(|m| m[1].as_deref().is_some_and(|s| !s.is_empty())) else { return Ok(false) };
	// among all the seeds one carries, so a near name of a garden seed stays the garden's
	let w = c.world.clone();
	let is_tree_seed = |proto: &str| j::a(&d, "sorts").iter().any(|s| j::s(s, "seed") == proto);
	let seed = |proto: &str| is_tree_seed(proto)
		|| j::opt(&w, "garden").is_some_and(|g| j::a(g, "sorts").iter().any(|s| j::s(s, "seed") == proto))
		|| j::opt(&w, "fields").is_some_and(|f| j::a(f, "crops").iter().any(|s| j::s(s, "seed") == proto));
	let seeds: Vec<Json> = inventory(c).await?.into_iter().filter(|i| seed(j::s(fields(i), "proto"))).collect();
	let said = js::lower(js::trim(&no_article(m[1].as_deref().unwrap_or(""))));
	let Some(hit) = items_named(&w, &seeds, &said, None).into_iter().next() else { return Ok(false) };
	let hf = fields(&hit).clone();
	if !is_tree_seed(j::s(&hf, "proto")) { return Ok(false); }
	let sort = j::a(&d, "sorts").iter().find(|s| j::at(s, "seed") == j::at(&hf, "proto")).cloned().unwrap_or(Json::Null);
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste pflanzen keine Bäume; registriere dich dafür.") };
	if !human(c) { return refuse("Bäume pflanzen nur Menschen."); }
	need_rank(c, "siedler", "Bäume pflanzen").await?;
	let spade = j::s(&d, "spade").to_owned();
	if !inventory(c).await?.iter().any(|i| j::s(fields(i), "proto") == spade) { let n = proto_name(c, &spade); return refuse(format!("Zum Pflanzen brauchst du einen {n} („craft {}“).", js::lower(&n))); }
	let acc = j::at(&account, "accountId").clone();
	if c.space.count(&tmpl("Tree", obj! { "accountId" => acc.clone() }), None).await? >= j::n(&d, "maxTrees") { return refuse(format!("Mehr als {} Bäume pflanzt niemand; fälle erst einen.", txt(j::at(&d, "maxTrees")))); }
	let points = j::n(&d, "points");
	let light = match light_for(c, points).await? { Ok(l) => l, Err(why) => return refuse(why.replacen("gebaut wird", "gepflanzt wird", 1).replacen("Bau", "Baum", 1)) };
	let room = room_of(c, None).await?;
	let tries = match (&m[2], &m[3]) {
		(Some(x), Some(y)) => vec![Rect { x: js::to_number(x), y: js::to_number(y), w: 1.0, h: 1.0 }],
		_ => besides(c, 1.0, 1.0),
	};
	let (mut rect, mut why) = (None, String::new());
	for r in tries { match refusal(c, &room, r, true, true).await? { None => { rect = Some(r); break; } Some(n) => if why.is_empty() { why = n; } } }
	let Some(rect) = rect else { return refuse(format!("Hier passt kein Baum hin: {why}")) };
	let me = c.char_id().to_owned();
	if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(&hf, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Der Samen ist gerade nicht greifbar; bitte noch einmal."); }
	let tree_id = format!("tree-{}", hex(&random_bytes(6)));
	let now = world_now_of(&c.space, c.txn()).await?;
	let room_id = j::s(&room, "roomId").to_owned();
	if let Err(e) = c.space.write_unique(&tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => rect.x, "y" => rect.y, "of" => tree_id.as_str() }), c.txn(), FOREVER, &["room", "x", "y"]).await { unique_or(e, "Dort hat gerade jemand anderes gegraben.")?; }
	use_light(c, &light, points).await?;
	let due = next_date(&sort, 0.0, now, fog_of(&c.space, &room_id).await?, patience_of(&c.space, c.txn()).await?);
	let mut t = obj! {};
	for (k, v) in [("treeId", Json::from(tree_id.as_str())), ("sort", j::at(&sort, "key").clone()), ("room", Json::from(room_id.as_str())), ("x", Json::from(rect.x)), ("y", Json::from(rect.y)), ("w", Json::from(1.0)), ("h", Json::from(1.0)),
		("owner", Json::from(me.as_str())), ("ownerName", j::at(&c.actor, "name").clone()), ("accountId", acc), ("beaconId", Json::from(light.beacon_id.as_str())), ("points", Json::from(points)), ("stage", Json::from(0.0)), ("dueWorldMs", Json::from(due)), ("at", Json::from(now))] { j::set(&mut t, k, v); }
	c.space.write(&tmpl("Tree", t), c.txn(), FOREVER).await?;
	msg(c, "*", "emote", &format!("{} pflanzt {} ein: Hier wächst bald {}. „baum“ zeigt, wie weit er ist.", txt(j::at(&c.actor, "name")), txt(j::at(&hf, "name")), txt(j::at(&sort, "a"))), MsgOpts::default()).await?;
	Ok(true)
}

/// `describe`: what one tree is now, for `baum`.
fn describe(d: &Json, t: &Json, now: f64) -> String {
	let s = sort_of_tree(d, j::s(t, "sort"));
	let due = j::n(t, "dueWorldMs");
	let left = if due < FOREVER { span(0f64.max(due - now)) } else { String::new() };
	let stage = j::n(t, "stage");
	let cr = s.and_then(crop);
	let cut = cr.is_some_and(|x| j::b(x, "cut"));
	let fruit = s.and_then(|s| j::so(s, "fruit")).filter(|f| !f.is_empty());
	let state = if stage == 0.0 { format!("{}, ein junger Baum in etwa {left}", STAGES[0]) }
		else if stage == 1.0 { format!("{}, ausgewachsen in etwa {left}", STAGES[1]) }
		else if j::b(t, "ripe") { format!("ausgewachsen; {}", if cut { "die Ruten sind lang genug zum Schneiden".to_owned() } else { format!("{} hängen reif daran", fruit.unwrap_or("die Früchte")) }) }
		else if cr.is_some() { format!("ausgewachsen; {} in etwa {left}", if cut { "die Ruten wachsen nach".to_owned() } else { format!("trägt wieder {}", fruit.unwrap_or("Früchte")) }) }
		else { "ausgewachsen".to_owned() };
	format!("{} von {} ({} {}): {state}.", sort_name(d, t), txt(j::at(t, "ownerName")), txt(j::at(t, "x")), txt(j::at(t, "y")))
}

async fn baum(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = trees(c)?;
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = parts.first().cloned().unwrap_or_default();
	let at: Option<(f64, f64)> = if js::re(r"^(?:ansehen|look)$", "i").test(&word) { match (parts.get(1), parts.get(2)) { (Some(x), Some(y)) => Some((js::to_number(x), js::to_number(y))), _ => None } } else { None };
	let here: Vec<Json> = c.space.read_all(&tmpl("Tree", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|t| at.is_none_or(|(x, y)| j::n(t, "x") == x && j::n(t, "y") == y)).collect();
	let me = c.char_id().to_owned();
	if here.is_empty() {
		let first_seed = j::a(&d, "sorts").first().map_or_else(String::new, |s| j::s(s, "seed").to_owned());
		let text = format!("Hier steht kein gepflanzter Baum. Mit einem {} pflanzt „pflanze {}“ einen (im Licht eines Feuers).", proto_name(c, j::s(&d, "spade")), js::lower(&proto_name(c, &first_seed)));
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	let now = world_now_of(&c.space, c.txn()).await?;
	msg(c, &me, "look", &here.iter().map(|t| describe(&d, t, now)).collect::<Vec<_>>().join("\n"), MsgOpts::default()).await
}

/// `treeHere`: the tree within reach the actor may fell (its own; an admin's any; `x y`: the one on that cell), taken in the transaction.
async fn tree_here(c: &Ctx, d: &Json, arg: &str, admin: bool) -> Result<Json> {
	let at = js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(arg)).map(|m| (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[2].as_deref().unwrap_or(""))));
	let place = |t: &Json| at.is_none_or(|(x, y)| j::n(t, "x") == x && j::n(t, "y") == y);
	let r = take_near(c, "Tree", "treeId", SITE_REACH, &|t: &Json| place(t) && (admin || mine(c, t))).await?;
	let far = match r { Ok(t) => return Ok(t), Err(far) => far };
	let me = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let other = c.space.read_all(&tmpl("Tree", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).find(|t| place(t) && dist_to(me, Rect::of(t)) <= SITE_REACH);
	if let Some(o) = other { return refuse(format!("Dieser Baum ({}) gehört {}; fällen darf ihn nur, wer ihn gepflanzt hat.", sort_name(d, &o), txt(j::at(&o, "ownerName")))); }
	not_understood(if far { "Geh näher an deinen Baum heran (höchstens zwei Schritte entfernt)." } else { "Hier steht kein Baum, den du gepflanzt hast." })
}

async fn faelle(c: &mut Ctx, arg: &str) -> Result<()> {
	let d = trees(c)?;
	ensure_account(c).await?;
	let axe_key = j::s(&d, "axe").to_owned();
	let Some(axe) = inventory(c).await?.into_iter().find(|i| j::s(fields(i), "proto") == axe_key).map(|i| fields(&i).clone()) else { let n = proto_name(c, &axe_key); return refuse(format!("Zum Fällen brauchst du eine {n} („craft {}“).", js::lower(&n))) };
	let (now, rest) = rested(c).await?;
	let admin = level_of(c.account.as_ref()) == "Admin";
	let t = tree_here(c, &d, arg, admin).await?;
	let Some(s) = sort_of_tree(&d, j::s(&t, "sort")).cloned() else { return refuse("Diesen Baum kennt die Welt nicht mehr.") };
	if j::n(&t, "stage") < 2.0 { return refuse(format!("{}: noch zu jung zum Fällen; ausgewachsen in etwa {}.", txt(j::at(&s, "name")), span(0f64.max(j::n(&t, "dueWorldMs") - now)))); }
	let wear = axe.get("wear").map(j::number);
	let left = wear.map_or(1.0, |w| w - 1.0);
	let me = c.char_id().to_owned();
	if left <= 0.0 { consume(c, &axe, &me).await?; }
	else if wear.is_some() { move_item(c, &axe, &me, &me, &[("wear", Json::from(left))]).await?; }
	let fell: Vec<(String, f64)> = j::a(&s, "fell").iter().map(|y| (txt(j::at(y, "proto")), j::n(y, "count"))).collect();
	let got = give_back(c, &fell).await?;
	let sprouts = j::b(&s, "sprouts");
	if sprouts {
		let mut o = j::object(&t);
		o.remove("ripe");
		let mut young = Json::Object(o);
		let due = next_date(&s, 1.0, now, fog_of(&c.space, j::s(&t, "room")).await?, patience_of(&c.space, c.txn()).await?);
		j::set(&mut young, "stage", 1.0);
		j::set(&mut young, "dueWorldMs", due);
		c.space.write(&tmpl("Tree", young), c.txn(), FOREVER).await?;
	} else {
		let txn = c.txn().unwrap_or("").to_owned();
		free_cells(&c.space, &txn, j::s(&t, "room"), j::at(&t, "treeId")).await?;
		release_light(&c.space, &txn, j::at(&t, "beaconId"), j::n(&t, "points")).await?;
	}
	tire(c, now, rest.as_ref()).await?;
	let name = txt(j::at(&c.actor, "name"));
	if j::s(&t, "owner") != me {
		let room = room_of(c, None).await?;
		msg(c, j::s(&t, "owner"), "info", &format!("{name} hat {} von dir in {} gefällt.", txt(j::at(&s, "the")), txt(j::at(&room, "name"))), MsgOpts::default()).await?;
	}
	let broke = if left <= 0.0 { format!(" Die {} zerbricht dabei.", txt(j::at(&axe, "name"))) } else { String::new() };
	msg(c, "*", "info", &format!("{name} fällt {}: {}.{}{broke}", txt(j::at(&s, "the")), got.join(", "), if sprouts { " Aus dem Stumpf treibt ein neuer Baum aus." } else { " Das Land ist wieder frei." }), MsgOpts::default()).await
}

/// `harvestTree`: the crop of one's tree within reach; false when no tree that bears stands within reach and `named` is false.
pub async fn harvest_tree(c: &mut Ctx, named: bool) -> Result<bool> {
	let Some(d) = j::opt(c.w(), "trees").cloned() else { return Ok(false) };
	let me_at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let bears = |t: &Json| sort_of_tree(&d, j::s(t, "sort")).and_then(crop).is_some();
	let near: Vec<Json> = c.space.read_all(&tmpl("Tree", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|t| bears(t) && dist_to(me_at, Rect::of(t)) <= SITE_REACH).collect();
	if near.is_empty() { if named { return not_understood("Hier steht kein Baum, der etwas trägt (höchstens zwei Schritte entfernt)."); } return Ok(false); }
	let own: Vec<&Json> = near.iter().filter(|t| mine(c, t)).collect();
	if own.is_empty() { return refuse(format!("Dieser Baum ({}) gehört {}; ernten darf nur, wer ihn gepflanzt hat.", sort_name(&d, &near[0]), txt(j::at(&near[0], "ownerName")))); }
	if !own.iter().any(|t| j::b(t, "ripe")) {
		let now = world_now_of(&c.space, c.txn()).await?;
		let next = own.iter().skip(1).fold(own[0], |a, t| if j::n(t, "dueWorldMs") < j::n(a, "dueWorldMs") { t } else { a });
		let name = sort_of_tree(&d, j::s(next, "sort")).map_or_else(String::new, |s| txt(j::at(s, "name")));
		let left = span(0f64.max(j::n(next, "dueWorldMs") - now));
		return refuse(if j::n(next, "stage") < 2.0 { format!("{name}: noch zu jung zum Tragen; ausgewachsen in etwa {left}.") } else { format!("{name}: noch nichts reif; in etwa {left} wieder.") });
	}
	let Ok(t) = take_near(c, "Tree", "treeId", SITE_REACH, &|t: &Json| mine(c, t) && j::b(t, "ripe")).await? else { return refuse("Der Baum ist gerade nicht greifbar; bitte noch einmal.") };
	let s = sort_of_tree(&d, j::s(&t, "sort")).cloned().unwrap_or(Json::Null);
	let cr = crop(&s).cloned().unwrap_or(Json::Null);
	let now = world_now_of(&c.space, c.txn()).await?;
	let mut what: Vec<(String, f64)> = j::a(&cr, "yields").iter().map(|y| (txt(j::at(y, "proto")), j::n(y, "count"))).collect();
	if let Some(chance) = j::no(&cr, "seedChance").filter(|x| *x != 0.0) { if random_int(0.0, 100.0) < chance * 100.0 { what.push((txt(j::at(&s, "seed")), 1.0)); } }
	let got = give_back(c, &what).await?;
	let mut o = j::object(&t);
	o.remove("ripe");
	let mut picked = Json::Object(o);
	let due = next_date(&s, 2.0, now, 0.0, patience_of(&c.space, c.txn()).await?);
	j::set(&mut picked, "dueWorldMs", due);
	c.space.write(&tmpl("Tree", picked), c.txn(), FOREVER).await?;
	msg(c, "*", "emote", &format!("{} {} {}: {}.", txt(j::at(&c.actor, "name")), if j::b(&cr, "cut") { "schneidet" } else { "erntet" }, txt(j::at(&s, "the")), got.join(", ")), MsgOpts::default()).await?;
	Ok(true)
}

/// `meansTree`: a line of `ernte` that means a tree: "baum", "obst", a sort or what it bears.
pub fn means_tree(w: &Json, arg: &str) -> bool {
	let Some(d) = j::opt(w, "trees") else { return false };
	let said = js::lower(js::trim(&no_article(js::trim(arg))));
	if said.is_empty() { return false; }
	if js::re(r"^(?:baum|bäume|baeume|obst|früchte|fruechte|ruten|tree|trees|fruit)$", "").test(&said) { return true; }
	j::a(d, "sorts").iter().any(|s| {
		let names = [j::s(s, "key"), j::s(s, "name")].into_iter().chain(j::strs(j::a(s, "aliases"))).chain(j::so(s, "fruit").filter(|f| !f.is_empty()));
		names.into_iter().any(|n| js::lower(n) == said)
	})
}

/// `treeTick`: trees whose date has come grow on or bear, each in a transaction of its own. How many were written.
pub async fn tree_tick(space: &Space, w: &Json) -> Result<f64> {
	let Some(d) = j::opt(w, "trees") else { return Ok(0.0) };
	let now = world_now_of(space, None).await?;
	let due: Vec<Json> = space.read_all(&obj! { "type" => "Tree" }, None).await?.iter().map(|e| fields(e).clone()).filter(|t| j::n(t, "dueWorldMs") <= now).collect();
	if due.is_empty() { return Ok(0.0); }
	let patient = patience_of(space, None).await?;
	let winter = frozen_until(space, now).await?;
	let mut written = 0.0;
	for t in &due {
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(e) = space.take_if_exists(&tmpl("Tree", obj! { "treeId" => j::at(t, "treeId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let mut tree = fields(&e).clone();
			let fog = fog_of(space, j::s(&tree, "room")).await?;
			if !advance_tree(d, &mut tree, now, fog, patient, winter) { return Ok(false); }
			space.write(&tmpl("Tree", tree), Some(&txn), FOREVER).await?;
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; written += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(written)
}

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"baum" => baum(c, arg).await,
		"fälle" => faelle(c, arg).await,
		_ => Err(Error::Other(format!("unported: trees/{key}"))),
	}
}
