//! The windmill (`server/engine/commands/mill.ts`): grain brought to a mill becomes flour in the mill's own time, for
//! whoever brought it. `mahle` takes the mill's Building in the command's transaction, so loads brought at once queue
//! one after the other; each load is its own MillLoad with the time it is ready; `abholen` takes one's own loads that
//! are ready. A storm surge on the mill's island grinds ahead (`storm_turns_mills`). `backe` names the oven's recipes.
use std::collections::HashSet;

use phi_json::{obj, Json};

use super::build::{dist_to, give_back, no_article, plan_of, plural, put_back, take_near, Rect, SITE_REACH};
use super::trade::craft;
use super::wind::wind_factor;
use crate::clock::{decay_now_of, patience_of, world_now_of};
use crate::context::{inventory, items_named, msg, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::source::{hex, random_bytes};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }

fn hours(ms: f64) -> String {
	let h = js::round(ms / 3_600_000.0);
	if h >= 1.0 { format!("{} {}", nt(h), if h == 1.0 { "Stunde" } else { "Stunden" }) } else { format!("{} Minuten", nt(1f64.max(js::round(ms / 60_000.0)))) }
}
fn mill_of(c: &Ctx) -> Result<Json> {
	match j::opt(c.w(), "mill") { Some(m) => Ok(m.clone()), None => refuse("In dieser Welt mahlt keine Mühle.") }
}
fn mill_name(c: &Ctx, m: &Json) -> String { plan_of(c.w(), j::s(m, "plan")).map_or_else(|| j::s(m, "plan").to_owned(), |p| txt(j::at(p, "name"))) }
/// `protoName` (garden.ts): a prototype's name as the world calls it.
pub fn proto_name(w: &Json, key: &str) -> String { j::by(j::a(w, "prototypes"), "key", key).map_or_else(|| key.to_owned(), |p| txt(j::at(p, "name"))) }
/// `millHere`: the mill beside the actor, taken in the transaction (one another `mahle` holds is waited for).
async fn mill_here(c: &Ctx, m: &Json) -> Result<Json> {
	let plan = j::at(m, "plan").clone();
	match take_near(c, "Building", "buildId", 1.0, &|b: &Json| j::at(b, "plan") == &plan).await? {
		Ok(f) => Ok(f),
		Err(_) => not_understood(format!("Geh direkt neben eine {}.", mill_name(c, m))),
	}
}
fn grain_names(c: &Ctx, m: &Json) -> String { j::a(m, "grinds").iter().map(|g| proto_name(c.w(), j::s(g, "from"))).collect::<Vec<_>>().join(", ") }
fn info() -> MsgOpts { MsgOpts::default() }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"mahle" => mahle(c, arg).await,
		"abholen" => abholen(c).await,
		"backe" => backe(c, arg).await,
		k => Err(Error::Other(format!("unported: mill/{k}"))),
	}
}

async fn mahle(c: &mut Ctx, arg: &str) -> Result<()> {
	let m = mill_of(c)?;
	let now = world_now_of(&c.space, c.txn()).await?;
	let plan = j::s(&m, "plan").to_owned();
	let line = js::re(r"^(?:mein|meine|meinen|das|den|die)\s+", "i").replace(js::trim(arg), "");
	let Some(a) = js::caps(&js::re(r"^(?:(\d+|alle?|all)\s+)?(.*)$", "i"), &line) else { return Err(Error::Other("Cannot read properties of null (reading '2')".into())) };
	let what = a[2].clone().unwrap_or_default();
	let count = a[1].clone().filter(|d| js::re(r"^\d+$", "").test(d)).map(|d| js::to_number(&d));
	let me = c.char_id().to_owned();
	let at = xy(&c.actor);
	if what.is_empty() {
		// only a look: read, not taken (unless another command holds it right now)
		let seen = c.space.read_all(&tmpl("Building", obj! { "room" => c.room(), "plan" => plan.as_str() }), None).await?.iter().map(|e| fields(e).clone()).find(|b| dist_to(at, Rect::of(b)) <= 1.0);
		let b = match seen.clone() { Some(b) => b, None => mill_here(c, &m).await? };
		if seen.is_none() { put_back(c, &b).await?; }
		let mine: Vec<Json> = c.space.read_all(&tmpl("MillLoad", obj! { "buildId" => j::at(&b, "buildId").clone(), "charId" => me.as_str() }), None).await?.iter().map(|e| fields(e).clone()).collect();
		let busy = 0f64.max(j::no(&b, "busyUntilWorldMs").unwrap_or(0.0) - now);
		let mut lines = vec![if busy != 0.0 { format!("Die {} hat noch {} zu mahlen.", txt(j::at(&b, "name")), hours(busy)) } else { format!("Die {} steht still; sie mahlt, was man ihr bringt ({}), {} je Handvoll.", txt(j::at(&b, "name")), grain_names(c, &m), hours(j::n(&m, "unitWorldMs"))) }];
		for l in &mine {
			lines.push(if j::n(l, "readyWorldMs") <= now { format!("Fertig für dich: {} {} („abholen“).", txt(j::at(l, "count")), proto_name(c.w(), j::s(l, "to"))) } else { format!("Dein {} ({}): fertig in etwa {}.", proto_name(c.w(), j::s(l, "from")), txt(j::at(l, "count")), hours(j::n(l, "readyWorldMs") - now)) });
		}
		return msg(c, &me, "info", &lines.join("\n"), info()).await;
	}
	let inv = inventory(c).await?;
	let hits = items_named(c.w(), &inv, &no_article(&what), None);
	let Some(hit) = hits.first() else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&what, 0, Some(30)))) };
	let proto = j::at(fields(hit), "proto").clone();
	let Some(grind) = j::a(&m, "grinds").iter().find(|g| j::at(g, "from") == &proto).cloned() else { return refuse(format!("Die Mühle mahlt nur Korn: {}.", grain_names(c, &m))) };
	let (from, to) = (j::s(&grind, "from").to_owned(), j::s(&grind, "to").to_owned());
	let b = mill_here(c, &m).await?;
	let build_id = j::at(&b, "buildId").clone();
	let waiting = c.space.count(&tmpl("MillLoad", obj! { "buildId" => build_id.clone(), "charId" => me.as_str() }), None).await?;
	if waiting >= j::n(&m, "maxLoads") { return refuse(format!("Bei der {} liegen schon {} Säcke von dir; hol erst dein Mehl ab („abholen“).", txt(j::at(&b, "name")), nt(waiting))); }
	let have: Vec<Json> = inventory(c).await?.into_iter().filter(|i| j::s(fields(i), "proto") == from).collect();
	let max_load = j::n(&m, "maxLoad");
	let n = count.unwrap_or(have.len() as f64).min(have.len() as f64).min(max_load);
	if n <= 0.0 { return refuse(format!("Du hast kein {}.", proto_name(c.w(), &from))); }
	for it in have.iter().take(n as usize) {
		let f = fields(it);
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(f, "itemId").clone(), "location" => me.as_str() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(f, "name")))); }
	}
	let room = j::s(&b, "room").to_owned();
	let ready = now.max(j::no(&b, "busyUntilWorldMs").unwrap_or(0.0)) + (n * j::n(&m, "unitWorldMs")) / wind_factor(&c.space, c.w(), &room, c.txn()).await?;
	let mut nb = b.clone();
	j::set(&mut nb, "busyUntilWorldMs", ready);
	put_back(c, &nb).await?;
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(&m, "keepWorldMs") + (ready - now) / patience_of(&c.space, c.txn()).await?;
	let load = obj! { "loadId" => hex(&random_bytes(6)), "buildId" => build_id, "room" => room.as_str(), "x" => j::at(&b, "x").clone(), "y" => j::at(&b, "y").clone(), "w" => j::at(&b, "w").clone(), "h" => j::at(&b, "h").clone(), "charId" => me.as_str(), "name" => j::at(&c.actor, "name").clone(),
		"from" => from.as_str(), "to" => to.as_str(), "count" => n, "readyWorldMs" => ready, "untilWorldMs" => until };
	c.space.write(&tmpl("MillLoad", load), c.txn(), FOREVER).await?;
	let more = if count.is_some_and(|k| k > n) && n == max_load { format!(" Mehr als {} nimmt sie auf einmal nicht.", nt(max_load)) } else { String::new() };
	let grain = format!("Handvoll {}", proto_name(c.w(), &from));
	msg(c, "*", "emote", &format!("{} schüttet {} in die {}.", txt(j::at(&c.actor, "name")), plural(n, &grain, &grain), txt(j::at(&b, "name"))), info()).await?;
	msg(c, &me, "info", &format!("Dein {} ist in etwa {} fertig; hol es dann hier ab („abholen“).{more}", proto_name(c.w(), &to), hours(ready - now)), info()).await
}

async fn abholen(c: &mut Ctx) -> Result<()> {
	let m = mill_of(c)?;
	let now = world_now_of(&c.space, c.txn()).await?;
	let me = c.char_id().to_owned();
	let mine: Vec<Json> = c.space.read_all(&tmpl("MillLoad", obj! { "room" => c.room(), "charId" => me.as_str() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let at = xy(&c.actor);
	let near: Vec<&Json> = mine.iter().filter(|l| dist_to(at, Rect::of(l)) <= SITE_REACH).collect();
	if near.is_empty() { return refuse(if mine.is_empty() { "Hier wartet kein Mehl auf dich.".to_owned() } else { format!("Geh näher an die {}.", plan_of(c.w(), j::s(&m, "plan")).map_or_else(|| "Mühle".to_owned(), |p| txt(j::at(p, "name")))) }); }
	let ready: Vec<&Json> = near.iter().copied().filter(|l| j::n(l, "readyWorldMs") <= now).collect();
	if ready.is_empty() { return refuse(format!("Dein Korn ist noch nicht gemahlen; in etwa {}.", hours(near.iter().map(|l| j::n(l, "readyWorldMs")).fold(f64::INFINITY, f64::min) - now))); }
	let mut got: Vec<(String, f64)> = Vec::new();
	for l in &ready {
		if c.space.take_if_exists(&tmpl("MillLoad", obj! { "loadId" => j::at(l, "loadId").clone() }), NO_WAIT, c.txn()).await?.is_none() { continue; }
		let (to, count) = (j::s(l, "to").to_owned(), j::n(l, "count"));
		give_back(c, &[(to.clone(), count)]).await?;
		match got.iter_mut().find(|(p, _)| *p == to) { Some(g) => g.1 += count, None => got.push((to, count)) }
	}
	if got.is_empty() { return refuse("Das ist gerade nicht greifbar; bitte noch einmal."); }
	let left = near.len() - ready.len();
	let what = got.iter().map(|(p, n)| format!("{} {}", nt(*n), proto_name(c.w(), p))).collect::<Vec<_>>().join(" und ");
	msg(c, &me, "info", &format!("Du holst {what} ab.{}", if left > 0 { format!(" {left} {}", if left == 1 { "Sack mahlt noch." } else { "Säcke mahlen noch." }) } else { String::new() }), info()).await
}

/// `backe`: the oven's recipes (at a building, giving food), those beside the actor first, made with craft.
async fn backe(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = c.world.clone();
	let protos = j::a(&w, "prototypes");
	let proto = |k: &Json| protos.iter().find(|p| j::at(p, "key") == k);
	let food: Vec<&Json> = j::a(&w, "recipes").iter().filter(|r| j::b(r, "at") && proto(j::at(r, "makes")).is_some_and(|p| j::s(p, "typeclass") == "Produce")).collect();
	let beside: HashSet<String> = super::interior::near_buildings(c, None).await?.iter().map(|b| txt(j::at(b, "plan"))).collect();
	let here = |r: &Json| beside.contains(&txt(j::at(r, "at")));
	let ovens: Vec<&Json> = food.iter().copied().filter(|r| here(r)).chain(food.iter().copied().filter(|r| !here(r))).collect();
	let n = no_article(&js::lower(js::trim(arg)));
	let r = if n.is_empty() { ovens.first().copied() } else {
		ovens.iter().copied().find(|x| j::s(x, "key") == n || js::lower(&txt(j::at(x, "name"))) == n || proto(j::at(x, "makes")).is_some_and(|p| j::a(p, "aliases").iter().any(|a| a.as_str() == Some(n.as_str()))))
	};
	let Some(r) = r else { return not_understood(if ovens.is_empty() { "In dieser Welt bäckt niemand.".to_owned() } else { format!("Backen kann man hier: {}.", ovens.iter().map(|x| txt(j::at(x, "name"))).collect::<Vec<_>>().join(", ")) }) };
	let key = j::s(r, "key").to_owned();
	craft(c, &key).await
}

/// `stormTurnsMills`: a storm surge grinds the mills of its island ahead: the loads still waiting and the mill's queue
/// move forward by `stormWorldMs`, never before now.
pub async fn storm_turns_mills(space: &Space, w: &Json, room_id: Option<&str>) -> Result<()> {
	let (Some(m), Some(room_id)) = (j::opt(w, "mill"), room_id) else { return Ok(()) };
	let rooms = j::a(w, "rooms");
	let island = j::by(rooms, "roomId", room_id).map(|r| j::at(r, "island").clone()).unwrap_or(Json::Null);
	let ids: HashSet<&str> = rooms.iter().filter(|r| j::at(r, "island") == &island).map(|r| j::s(r, "roomId")).collect();
	let storm = j::n(m, "stormWorldMs");
	let now = world_now_of(space, None).await?;
	for e in space.read_all(&tmpl("Building", obj! { "plan" => j::at(m, "plan").clone() }), None).await? {
		let b = fields(&e);
		if !ids.contains(j::s(b, "room")) || j::no(b, "busyUntilWorldMs").unwrap_or(0.0) <= now { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let mut mill = fields(&t).clone();
			let busy = now.max(j::no(&mill, "busyUntilWorldMs").unwrap_or(0.0) - storm);
			j::set(&mut mill, "busyUntilWorldMs", busy);
			space.write(&tmpl("Building", mill), Some(&txn), FOREVER).await?;
			for le in space.read_all(&tmpl("MillLoad", obj! { "buildId" => j::at(b, "buildId").clone() }), None).await? {
				let mut l = fields(&le).clone();
				if j::n(&l, "readyWorldMs") <= now || space.take_if_exists(&tmpl("MillLoad", obj! { "loadId" => j::at(&l, "loadId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { continue; }
				let ready = now.max(j::n(&l, "readyWorldMs") - storm);
				j::set(&mut l, "readyWorldMs", ready);
				space.write(&tmpl("MillLoad", l), Some(&txn), FOREVER).await?;
			}
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
