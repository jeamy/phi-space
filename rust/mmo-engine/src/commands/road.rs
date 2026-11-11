//! Roads, planned (`server/engine/commands/road.ts`, docs/siedeln.en.md "Road"): a road runs from the middle of one room
//! through a door to the middle of the next room on the same island, along the cobble paths where it can. `straße plane
//! <ort>` draws the trace, the settlers of both rooms vote on it (`straße ja` / `straße nein`), and when more say yes than
//! no it becomes a site of its own that everyone builds with `liefere` and `arbeite` beside it; each work paves the next
//! stretch. A finished road links its two rooms for carts (cart.rs `road_links`) until it decays; `straße repariere`
//! mends it. Its cells stay walkable; nothing is built on them (build.rs `refusal`).
//!
//! One Route entry holds the whole road, a Road entry per room what the page draws (written with it, `road_save`). The
//! terms run on the decay clock; `road_tick` resolves votes and lets roads lapse.
use std::collections::{HashMap, HashSet};

use phi_json::{number_text as nt, obj, Json};

use super::build::{days, human, no_article, plural, rested, tire, SITE_REACH};
use super::epoch::{epoch_name, epoch_of, island_of};
use super::settlement::{huts_in, need_rank, settlement_in};
use crate::clock::decay_now_of;
use crate::context::{inventory, items_named, msg, msg_transient, room_of, to_player, Ctx, MsgOpts};
use crate::fire::key_text as txt;
use crate::j;
use crate::js;
use crate::occupancy::{blocked_in, cell_key};
use crate::room_growth::rows;
use crate::settings::setting;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;

const WORLD_DAY: f64 = 24.0 * 3_600_000.0;
const STEPS: [(f64, f64); 4] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];
type Cell = (f64, f64);

fn def_of(w: &Json) -> Option<&Json> { j::opt(j::at(w, "cart"), "route") }
fn all_rooms(w: &Json) -> &[Json] { j::ao(w, "allRooms").unwrap_or_else(|| j::a(w, "rooms")) }
fn name_of(w: &Json, room: &str) -> String { j::by(all_rooms(w), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
fn island_of_room(w: &Json, room: &str) -> Option<String> { j::by(all_rooms(w), "roomId", room).and_then(|r| j::so(r, "island")).map(str::to_owned) }
fn pair_of(a: &str, b: &str) -> String { let mut p = [a.to_owned(), b.to_owned()]; js::utf16_sort(&mut p); p.join("|") }
fn info(room: Option<&str>) -> MsgOpts { MsgOpts { room: room.map(str::to_owned), ..MsgOpts::default() } }
fn at_of(ground: &[String], x: f64, y: f64) -> &str { ground.get(y as usize).map_or("", |r| js::slice16(r, x as isize, Some(x as isize + 1))) }

/// `middleOf`: the cells a road arrives at in a room: beside its fire, else the cobble cell nearest the room's centre,
/// else the walkable cell nearest it.
fn middle_of(w: &Json, ground: &[String], fire: Option<Cell>) -> Vec<Cell> {
	if let Some(f) = fire { return STEPS.iter().map(|(dx, dy)| (f.0 + dx, f.1 + dy)).filter(|p| walkable(w, ground, p.0, p.1)).collect(); }
	let (h, wd) = (ground.len(), ground.first().map_or(0, |r| js::len16(r)));
	let mid = ((wd as f64 - 1.0) / 2.0, (h as f64 - 1.0) / 2.0);
	let (mut best, mut best_d, mut best_cobble): (Option<Cell>, f64, bool) = (None, f64::INFINITY, false);
	for y in 0..h {
		for x in 0..wd {
			let (x, y) = (x as f64, y as f64);
			if !walkable(w, ground, x, y) { continue; }
			let cobble = at_of(ground, x, y) == ":";
			let d = js::hypot(&[x - mid.0, y - mid.1]);
			if (cobble && !best_cobble) || (cobble == best_cobble && d < best_d) { best = Some((x, y)); best_d = d; best_cobble = cobble; }
		}
	}
	best.into_iter().collect()
}

/// `trace`: the cheapest way over walkable, unblocked cells from `from` to one of `to` (cobbles cost less), both ends
/// included.
fn trace(w: &Json, ground: &[String], from: Cell, to: &[Cell], blocked: &HashSet<String>) -> Option<Vec<Cell>> {
	let (h, wd) = (ground.len() as f64, ground.first().map_or(0, |r| js::len16(r)) as f64);
	let goal: HashSet<String> = to.iter().map(|p| cell_key(p.0, p.1)).collect();
	let mut dist: HashMap<String, f64> = HashMap::from([(cell_key(from.0, from.1), 0.0)]);
	let mut before: HashMap<String, (String, Cell)> = HashMap::new();
	let mut open: Vec<(Cell, f64)> = vec![(from, 0.0)];
	while !open.is_empty() {
		// Array.prototype.sort is stable: equal distances keep the order they were pushed in
		open.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
		let (c, d) = open.remove(0);
		let k = cell_key(c.0, c.1);
		if d > dist.get(&k).copied().unwrap_or(f64::INFINITY) { continue; }
		if goal.contains(&k) {
			let mut out = vec![c];
			let mut at = k;
			while let Some((prev, cell)) = before.get(&at) { out.insert(0, *cell); at = prev.clone(); }
			return Some(out);
		}
		for (dx, dy) in STEPS {
			let n = (c.0 + dx, c.1 + dy);
			let nk = cell_key(n.0, n.1);
			if n.0 < 0.0 || n.1 < 0.0 || n.0 >= wd || n.1 >= h || !walkable(w, ground, n.0, n.1) || blocked.contains(&nk) { continue; }
			let nd = d + if at_of(ground, n.0, n.1) == ":" { 1.0 } else { 3.0 };
			if nd < dist.get(&nk).copied().unwrap_or(f64::INFINITY) { dist.insert(nk.clone(), nd); before.insert(nk, (k.clone(), c)); open.push((n, nd)); }
		}
	}
	None
}

/// `votersOf`: hut owners of these rooms and the settlers a settlement took in, who are registered people.
async fn voters_of(space: &Space, w: &Json, rooms: &[&str], txn: Option<&str>) -> Result<Vec<String>> {
	let mut out: Vec<String> = Vec::new();
	let mut add = |id: String| if !out.contains(&id) { out.push(id); };
	for room in rooms {
		for h in huts_in(space, w, room, txn).await? { add(txt(j::at(&h, "accountId"))); }
		if let Some(s) = settlement_in(space, room, txn).await? { for m in j::a(&s, "members") { if j::s(m, "rank") == "siedler" { add(txt(j::at(m, "accountId"))); } } }
	}
	let mut people: Vec<String> = Vec::new();
	for id in out {
		let a = space.read_all(&tmpl("Account", obj! { "accountId" => id.as_str() }), txn).await?.into_iter().next();
		if a.as_ref().is_some_and(|a| { let f = fields(a); !j::b(f, "guest") && !j::b(f, "npc") && !j::b(f, "settler") }) { people.push(id); }
	}
	js::utf16_sort(&mut people);
	Ok(people)
}

fn missing_of(r: &Json) -> Vec<String> {
	let mut out: Vec<String> = j::a(r, "needs").iter().filter(|n| j::n(n, "have") < j::n(n, "count")).map(|n| format!("{} {}", nt(j::n(n, "count") - j::n(n, "have")), txt(j::at(n, "name")))).collect();
	if j::n(r, "work") < j::n(r, "workNeed") { out.push(format!("{} Arbeit", nt(j::n(r, "workNeed") - j::n(r, "work")))); }
	out
}
fn votes_of(r: &Json) -> String { format!("{} ja, {} nein von {}", j::a(r, "yes").len(), j::a(r, "no").len(), j::a(r, "voters").len()) }
fn paved_of(r: &Json) -> f64 {
	let n = j::a(r, "cells").len() as f64;
	match j::s(r, "state") { "built" => n, "vote" => 0.0, _ => (n * j::n(r, "work").min(j::n(r, "workNeed")) / j::n(r, "workNeed").max(1.0)).floor() }
}
fn rooms_of(r: &Json) -> (String, String) { let a = j::a(r, "rooms"); (txt(&a[0]), txt(&a[1])) }
fn names_of(r: &Json) -> (String, String) { let a = j::a(r, "names"); (txt(&a[0]), txt(&a[1])) }
fn other_name(r: &Json, from: &str) -> String { let (a, _) = rooms_of(r); let (n0, n1) = names_of(r); if a == from { n1 } else { n0 } }

/// `roadSave`: the road written back with its two parts (the old ones taken in the transaction).
async fn road_save(space: &Space, txn: &str, r: &Json) -> Result<()> {
	space.write(&tmpl("Route", r.clone()), Some(txn), FOREVER).await?;
	let route_id = j::at(r, "routeId").clone();
	for e in space.read_all(&tmpl("Road", obj! { "routeId" => route_id.clone() }), Some(txn)).await? { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(txn)).await?; }
	let (paved, missing, votes) = (paved_of(r), missing_of(r).join(", "), votes_of(r));
	let (r0, r1) = rooms_of(r);
	let mut before = 0.0;
	for room in [&r0, &r1] {
		let cells: Vec<Json> = j::a(r, "cells").iter().filter(|c| j::s(c, "room") == room.as_str()).map(|c| obj! { "x" => j::at(c, "x").clone(), "y" => j::at(c, "y").clone() }).collect();
		let n = cells.len() as f64;
		let mut part = obj! {
			"roadId" => format!("{}:{room}", txt(&route_id)), "routeId" => route_id.clone(), "room" => room.as_str(), "to" => if &r0 == room { r1.as_str() } else { r0.as_str() },
			"name" => format!("Straße nach {}", other_name(r, room)), "cells" => Json::Array(cells), "paved" => 0f64.max(n.min(paved - before)), "state" => j::at(r, "state").clone(),
			"missing" => missing.as_str(), "votes" => votes.as_str()
		};
		if j::s(r, "state") == "vote" && !j::a(r, "votedBy").is_empty() { j::set(&mut part, "votedBy", j::at(r, "votedBy").clone()); }
		space.write(&tmpl("Road", part), Some(txn), FOREVER).await?;
		before += n;
	}
	Ok(())
}
/// `roadGone`: the road and its parts taken away.
async fn road_gone(space: &Space, txn: &str, route_id: &Json) -> Result<()> {
	space.take_if_exists(&tmpl("Route", obj! { "routeId" => route_id.clone() }), NO_WAIT, Some(txn)).await?;
	for e in space.read_all(&tmpl("Road", obj! { "routeId" => route_id.clone() }), Some(txn)).await? { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(txn)).await?; }
	Ok(())
}

async fn routes_of(space: &Space, txn: Option<&str>) -> Result<Vec<Json>> { Ok(space.read_all(&obj! { "type" => "Route" }, txn).await?.iter().map(|e| fields(e).clone()).collect()) }
/// `roadCellsIn`: the cells of roads in a room.
pub async fn road_cells_in(space: &Space, room: &str, txn: Option<&str>) -> Result<HashSet<String>> {
	let mut out = HashSet::new();
	for e in space.read_all(&tmpl("Road", obj! { "room" => room }), txn).await? { for c in j::a(fields(&e), "cells") { out.insert(cell_key(j::n(c, "x"), j::n(c, "y"))); } }
	Ok(out)
}
/// `routeLinks`: the two rooms of each finished road.
pub async fn route_links(space: &Space, txn: Option<&str>) -> Result<Vec<(String, String)>> {
	Ok(routes_of(space, txn).await?.iter().filter(|r| j::s(r, "state") == "built").map(rooms_of).collect())
}
/// `routePoints`: the points the finished roads add to each island (epoch.rs `island_points`).
pub async fn route_points(space: &Space) -> Result<Vec<(String, f64)>> {
	let mut out: Vec<(String, f64)> = Vec::new();
	for r in routes_of(space, None).await? {
		if j::s(&r, "state") != "built" { continue; }
		let island = txt(j::at(&r, "island"));
		match out.iter_mut().find(|(k, _)| *k == island) { Some((_, p)) => *p += j::n(&r, "points"), None => out.push((island, j::n(&r, "points"))) }
	}
	Ok(out)
}

/// `askVoters`: the voters who are not the actor hear that a road waits for their vote.
async fn ask_voters(c: &Ctx, r: &Json) -> Result<()> {
	let (n0, n1) = names_of(r);
	for account_id in j::a(r, "voters") {
		if c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == account_id) { continue; }
		for e in c.space.read_all(&tmpl("Character", obj! { "accountId" => account_id.clone() }), c.txn()).await? {
			let ch = fields(&e);
			let left = days(j::n(r, "voteUntil") - decay_now_of(&c.space, c.txn()).await?);
			let text = format!("{} plant eine Straße zwischen {n0} und {n1}. Als Siedler dort stimmst du mit „straße ja“ oder „straße nein“ ab, in {n0} oder {n1}; noch {left}.", txt(j::at(r, "plannerName")));
			to_player(&c.space, &obj! { "room" => j::at(ch, "room").clone(), "to" => j::at(ch, "charId").clone(), "kind" => "info", "text" => text, "from" => j::at(&c.actor, "name").clone(), "at" => time_now() }, c.txn()).await?;
		}
	}
	Ok(())
}

/// How a decision is told in a room.
enum Say<'a> { Ctx(&'a Ctx), Tick(f64) }
impl Say<'_> {
	async fn say(&self, space: &Space, txn: &str, room: &str, text: &str) -> Result<()> {
		match self {
			Say::Ctx(c) => msg(c, "*", "world", text, info(Some(room))).await,
			Say::Tick(lease) => {
				let m = obj! { "room" => room, "to" => "*", "kind" => "world", "text" => text, "from" => "", "at" => time_now() };
				space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(txn), *lease, msg_transient(space, "*", "world").await).await?;
				Ok(())
			}
		}
	}
}

/// `decide`: more yes than no makes the road a site, else it is dropped; false when it is not decided yet.
async fn decide(space: &Space, w: &Json, txn: &str, r: &mut Json, now: f64, early: bool, say: &Say<'_>) -> Result<bool> {
	let (yes, no) = (j::a(r, "yes").len(), j::a(r, "no").len());
	if early && yes + no < j::a(r, "voters").len() { return Ok(false); }
	let (n0, n1) = names_of(r);
	let (r0, r1) = rooms_of(r);
	if yes > no {
		j::set(r, "state", "build");
		j::set(r, "untilWorldMs", now + def_of(w).and_then(|d| j::no(d, "siteWorldMs")).unwrap_or(14.0 * WORLD_DAY));
		road_save(space, txn, r).await?;
		let text = format!("Die Straße zwischen {n0} und {n1} ist beschlossen ({}). Jetzt wird gebaut: liefern („liefere stein“) und mitarbeiten („arbeite“) neben der Trasse; es fehlen {}.", votes_of(r), missing_of(r).join(", "));
		for room in [&r0, &r1] { say.say(space, txn, room, &text).await?; }
	} else {
		road_gone(space, txn, j::at(r, "routeId")).await?;
		let text = format!("Die Straße zwischen {n0} und {n1} wird nicht gebaut ({}).", votes_of(r));
		for room in [&r0, &r1] { say.say(space, txn, room, &text).await?; }
	}
	Ok(true)
}

/// `routeNear`: the road under construction with a cell within reach of the actor, taken in the transaction.
pub async fn route_near(c: &Ctx) -> Result<Option<Json>> {
	let (ax, ay) = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let parts: Vec<Json> = c.space.read_all(&tmpl("Road", obj! { "room" => c.room() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect();
	let Some(near) = parts.iter().find(|p| j::s(p, "state") == "build" && j::a(p, "cells").iter().any(|q| (j::n(q, "x") - ax).abs().max((j::n(q, "y") - ay).abs()) <= SITE_REACH)) else { return Ok(None) };
	Ok(c.space.take_if_exists(&tmpl("Route", obj! { "routeId" => j::at(near, "routeId").clone() }), NO_WAIT, c.txn()).await?.map(|e| fields(&e).clone()))
}

/// `credit`: NPCs and figures may give at most half (as at a site).
fn credit(c: &Ctx, r: &mut Json, n: f64) -> Result<f64> {
	let total = j::a(r, "needs").iter().map(|x| j::n(x, "count")).sum::<f64>() + j::n(r, "workNeed");
	let others: f64 = j::entries(j::at(r, "by")).filter(|(k, _)| k.starts_with('~')).map(|(_, v)| j::number(v)).sum();
	let n = if human(c) { n } else { 0f64.max(n.min((total / 2.0).floor() - others)) };
	if n == 0.0 || n.is_nan() { return refuse("Diese Straße bauen Menschen; Helfer haben ihren Teil schon getan."); }
	let key = if human(c) { txt(j::at(&c.actor, "name")) } else { format!("~{}", txt(j::at(&c.actor, "name"))) };
	let mut by = j::object(j::at(r, "by"));
	let was = by.get(&key).map_or(0.0, j::number);
	by.insert(key.as_str(), Json::from(was + n));
	j::set(r, "by", Json::Object(by));
	Ok(n)
}

async fn keep_ms(space: &Space, def: &Json) -> f64 {
	match j::so(def, "keepSetting") {
		Some(k) => setting(space, k).await.ok().unwrap_or(j::n(def, "keepWorldMs") / WORLD_DAY) * WORLD_DAY,
		None => j::n(def, "keepWorldMs"),
	}
}

/// `settleRoute`: the road written back after a delivery or work; when nothing is missing it stands.
async fn settle_route(c: &Ctx, r: &mut Json) -> Result<()> {
	let txn = c.txn().unwrap_or("").to_owned();
	if j::a(r, "needs").iter().all(|n| j::n(n, "have") >= j::n(n, "count")) && j::n(r, "work") >= j::n(r, "workNeed") {
		let def = def_of(c.w()).cloned().unwrap_or(Json::Null);
		let keep = keep_ms(&c.space, &def).await;
		j::set(r, "state", "built");
		j::set(r, "untilWorldMs", decay_now_of(&c.space, c.txn()).await? + keep);
		road_save(&c.space, &txn, r).await?;
		let (n0, n1) = names_of(r);
		let (r0, r1) = rooms_of(r);
		for room in [&r0, &r1] { msg(c, "*", "world", &format!("Die Straße zwischen {n0} und {n1} ist fertig. Karren fahren jetzt auf ihr."), info(Some(room))).await?; }
		return Ok(());
	}
	road_save(&c.space, &txn, r).await
}

/// `routeDeliver`: `liefere` beside a road under construction.
pub async fn route_deliver(c: &mut Ctx, mut r: Json, what: &str, count: Option<f64>) -> Result<()> {
	let inv = inventory(c).await?;
	let hits = items_named(c.w(), &inv, &no_article(what), None);
	let Some(first) = hits.first().map(|e| fields(e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(what, 0, Some(30)))) };
	let proto = j::at(&first, "proto").clone();
	let Some(i) = j::a(&r, "needs").iter().position(|n| j::at(n, "proto") == &proto) else {
		let left = missing_of(&r).join(", ");
		return refuse(format!("Die Straße braucht kein {}. Es fehlen {}.", txt(j::at(&first, "name")), if left.is_empty() { "nur noch Hände".to_owned() } else { left }));
	};
	let need = j::a(&r, "needs")[i].clone();
	let nname = txt(j::at(&need, "name"));
	let open = j::n(&need, "count") - j::n(&need, "have");
	if open <= 0.0 { return refuse(format!("{nname} hat die Straße genug. Es fehlen {}.", missing_of(&r).join(", "))); }
	let mine: Vec<Json> = inventory(c).await?.into_iter().filter(|e| j::at(fields(e), "proto") == &proto).collect();
	let n = count.unwrap_or(open).min(open).min(mine.len() as f64);
	if n <= 0.0 { return refuse(format!("Du hast kein {nname}.")); }
	let n = credit(c, &mut r, n)?;
	for it in mine.iter().take(n as usize) {
		let f = fields(it);
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(f, "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(f, "name")))); }
	}
	if let Some(Json::Array(needs)) = r.as_object_mut().and_then(|o| o.get_mut("needs")) { let have = j::n(&needs[i], "have") + n; j::set(&mut needs[i], "have", have); }
	let piece = format!("Stück {nname}");
	let (n0, n1) = names_of(&r);
	let left = missing_of(&r);
	let text = format!("Du lieferst {} an die Straße zwischen {n0} und {n1}.{}", plural(n, &piece, &piece), if left.is_empty() { String::new() } else { format!(" Es fehlen noch {}.", left.join(", ")) });
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &text, MsgOpts::default()).await?;
	settle_route(c, &mut r).await
}

/// `routeWork`: `arbeite` beside a road under construction: one work, which paves the next stretch.
pub async fn route_work(c: &mut Ctx, mut r: Json) -> Result<()> {
	let (now, rest) = rested(c).await?;
	if j::n(&r, "work") >= j::n(&r, "workNeed") { return refuse(format!("An der Straße ist die Arbeit getan; es fehlen nur noch {}.", missing_of(&r).join(", "))); }
	credit(c, &mut r, 1.0)?;
	let work = j::n(&r, "work") + 1.0;
	j::set(&mut r, "work", work);
	tire(c, now, rest.as_ref()).await?;
	let (n0, n1) = names_of(&r);
	msg(c, "*", "emote", &format!("{} pflastert an der Straße zwischen {n0} und {n1} ({}/{}).", txt(j::at(&c.actor, "name")), nt(work), txt(j::at(&r, "workNeed"))), MsgOpts::default()).await?;
	settle_route(c, &mut r).await
}

/// `neighbours`: the rooms one door away on the same island (exit, room, name).
async fn neighbours(c: &Ctx) -> Result<Vec<(Json, String, String)>> {
	let island = island_of_room(c.w(), c.room());
	let mut out: Vec<(Json, String, String)> = Vec::new();
	for e in c.space.read_all(&tmpl("Exit", obj! { "location" => c.room() }), c.txn()).await? {
		let x = fields(&e).clone();
		let dest = j::s(&x, "destination").to_owned();
		if out.iter().any(|(_, r, _)| *r == dest) || island_of_room(c.w(), &dest) != island || dest == c.room() { continue; }
		let name = name_of(c.w(), &dest);
		out.push((x, dest, name));
	}
	Ok(out)
}

fn fire_of(w: &Json, room: &str) -> Option<Cell> { j::by(j::a(w, "beacons"), "room", room).map(|b| (j::n(b, "x"), j::n(b, "y"))) }
fn proto_name(w: &Json, key: &str) -> String { j::by(j::a(w, "prototypes"), "key", key).map_or_else(|| key.to_owned(), |p| txt(j::at(p, "name"))) }
fn strip_to(word: &str) -> String { js::re(r"^(?:nach|zu|zum|zur|to)\s+", "").replace(js::trim(word), "") }

async fn plan(c: &mut Ctx, word: &str) -> Result<()> {
	let def = def_of(c.w()).cloned().unwrap_or(Json::Null);
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Straßen planen registrierte Spieler; registriere dich.") };
	let Some(island) = island_of_room(c.w(), c.room()) else { return refuse("Hier wird keine Straße gebaut.") };
	let epoch = epoch_of(&c.space, island_of(c.w(), c.room()).as_deref(), c.txn()).await?;
	if epoch < j::n(&def, "epoch") { return refuse(format!("Straßen gibt es erst ab {}; diese Insel ist noch {}.", epoch_name(c.w(), j::n(&def, "epoch")), epoch_name(c.w(), epoch))); }
	need_rank(c, "siedler", "Straßen planen").await?;
	let near = neighbours(c).await?;
	let w = strip_to(&no_article(&js::trim(word).to_lowercase()));
	let names = || near.iter().map(|(_, _, n)| n.as_str()).collect::<Vec<_>>().join(", ");
	if w.is_empty() { return not_understood(if near.is_empty() { "Von hier führt kein Weg zu einem anderen Ort dieser Insel.".to_owned() } else { format!("Wohin? Von hier geht es nach {}: „straße plane <ort>“.", names()) }); }
	let Some((exit, to_room, to_name)) = near.iter().find(|(_, r, n)| n.to_lowercase() == w || *r == w || n.to_lowercase().starts_with(&w)).cloned() else {
		return not_understood(format!("Dorthin führt von hier kein Weg auf dieser Insel.{}", if near.is_empty() { String::new() } else { format!(" Von hier geht es nach {}.", names()) }));
	};
	let pair = pair_of(c.room(), &to_room);
	if let Some(old) = routes_of(&c.space, c.txn()).await?.into_iter().find(|r| j::s(r, "pair") == pair) {
		return refuse(match j::s(&old, "state") {
			"vote" => format!("Über eine Straße nach {to_name} wird schon abgestimmt ({}).", votes_of(&old)),
			"build" => format!("Eine Straße nach {to_name} wird schon gebaut; es fehlen {}.", missing_of(&old).join(", ")),
			_ => format!("Nach {to_name} führt schon eine Straße."),
		});
	}
	let here = room_of(c, None).await?;
	let there = room_of(c, Some(&to_room)).await?;
	let (here_id, there_id) = (txt(j::at(&here, "roomId")), txt(j::at(&there, "roomId")));
	let (ga, gb) = (rows(j::at(&here, "ground")), rows(j::at(&there, "ground")));
	let blocked_a = blocked_in(&c.space, &here_id).await?;
	let blocked_b = blocked_in(&c.space, &there_id).await?;
	let start_a = middle_of(c.w(), &ga, fire_of(c.w(), &here_id)).into_iter().find(|p| !blocked_a.contains(&cell_key(p.0, p.1)));
	let leg_a = start_a.and_then(|s| trace(c.w(), &ga, s, &[(j::n(&exit, "x"), j::n(&exit, "y"))], &blocked_a));
	let arrive = j::at(&exit, "arrive");
	let ends_b: Vec<Cell> = middle_of(c.w(), &gb, fire_of(c.w(), &there_id)).into_iter().filter(|p| !blocked_b.contains(&cell_key(p.0, p.1))).collect();
	let leg_b = trace(c.w(), &gb, (j::n(arrive, "x"), j::n(arrive, "y")), &ends_b, &blocked_b);
	let (Some(leg_a), Some(leg_b)) = (leg_a, leg_b) else { return refuse(format!("Zwischen hier und {to_name} ist kein freier Weg für eine Straße; etwas ist zugebaut.")) };
	let cells: Vec<Json> = leg_a.iter().map(|p| obj! { "room" => here_id.as_str(), "x" => p.0, "y" => p.1 }).chain(leg_b.iter().map(|p| obj! { "room" => there_id.as_str(), "x" => p.0, "y" => p.1 })).collect();
	let n_cells = cells.len() as f64;
	let stone = proto_name(c.w(), j::s(&def, "stone"));
	let wood = proto_name(c.w(), j::s(&def, "woodProto"));
	let voters = voters_of(&c.space, c.w(), &[&here_id, &there_id], c.txn()).await?;
	let now = decay_now_of(&c.space, c.txn()).await?;
	let me = txt(j::at(&account, "accountId"));
	let others = voters.iter().filter(|v| **v != me).count();
	let mine = voters.contains(&me);
	let mut needs = vec![obj! { "proto" => j::at(&def, "stone").clone(), "name" => stone, "count" => (n_cells / j::n(&def, "stonePer")).ceil(), "have" => 0.0 }];
	if j::truthy(j::at(&def, "wood")) { needs.push(obj! { "proto" => j::at(&def, "woodProto").clone(), "name" => wood, "count" => j::at(&def, "wood").clone(), "have" => 0.0 }); }
	let mut r = obj! {
		"routeId" => format!("road-{}", hex(&random_bytes(6))), "pair" => pair.as_str(), "island" => island.as_str(),
		"rooms" => Json::Array(vec![Json::from(here_id.as_str()), Json::from(there_id.as_str())]),
		"names" => Json::Array(vec![j::at(&here, "name").clone(), j::at(&there, "name").clone()]), "cells" => Json::Array(cells),
		"state" => if others > 0 { "vote" } else { "build" }, "planner" => c.char_id(), "plannerName" => j::at(&c.actor, "name").clone(), "accountId" => me.as_str(),
		"voters" => Json::Array(voters.iter().map(|v| Json::from(v.as_str())).collect()), "yes" => Json::Array(if mine { vec![Json::from(me.as_str())] } else { vec![] }), "no" => Json::Array(vec![])
	};
	if mine { j::set(&mut r, "votedBy", Json::Array(vec![Json::from(c.char_id())])); }
	let vote_ms = j::n(&def, "voteWorldMs");
	for (k, v) in [
		("voteUntil", Json::from(now + vote_ms)), ("needs", Json::Array(needs)), ("work", Json::from(0.0)),
		("workNeed", Json::from(j::n(&def, "minWork").max((n_cells / j::n(&def, "workPer")).ceil()))), ("by", obj! {}),
		("untilWorldMs", Json::from(if others > 0 { now + vote_ms } else { now + j::n(&def, "siteWorldMs") })), ("at", Json::from(now)), ("points", j::at(&def, "points").clone()),
	] { j::set(&mut r, k, v); }
	let txn = c.txn().unwrap_or("").to_owned();
	road_save(&c.space, &txn, &r).await?;
	let cost = format!("{} Felder; es braucht {}", nt(n_cells), missing_of(&r).join(", "));
	let (n0, n1) = names_of(&r);
	let me_name = txt(j::at(&c.actor, "name"));
	if j::s(&r, "state") == "vote" {
		for room in [&here_id, &there_id] { msg(c, "*", "world", &format!("{me_name} plant eine Straße zwischen {n0} und {n1} ({cost}). Die Siedler beider Orte stimmen mit „straße ja“ oder „straße nein“ ab, {} lang.", days(vote_ms)), info(Some(room))).await?; }
		ask_voters(c, &r).await
	} else {
		for room in [&here_id, &there_id] { msg(c, "*", "world", &format!("{me_name} plant eine Straße zwischen {n0} und {n1} ({cost}); hier wohnt sonst niemand, der abstimmt, also wird gleich gebaut: liefern und mitarbeiten neben der Trasse."), info(Some(room))).await?; }
		Ok(())
	}
}

async fn vote(c: &mut Ctx, yes: bool, word: &str) -> Result<()> {
	let room = c.room().to_owned();
	let all: Vec<Json> = routes_of(&c.space, c.txn()).await?.into_iter().filter(|r| j::s(r, "state") == "vote" && j::a(r, "rooms").iter().any(|x| x.as_str() == Some(room.as_str()))).collect();
	if all.is_empty() { return refuse("Hier wird über keine Straße abgestimmt."); }
	let w = strip_to(&js::trim(word).to_lowercase());
	let pick: Vec<&Json> = if w.is_empty() { all.iter().collect() } else { all.iter().filter(|r| j::a(r, "names").iter().any(|n| txt(n).to_lowercase().starts_with(&w))).collect() };
	if pick.len() != 1 { return not_understood(format!("Über welche Straße? {}.", all.iter().map(|r| format!("„straße {} {}“", if yes { "ja" } else { "nein" }, other_name(r, &room))).collect::<Vec<_>>().join(", "))); }
	let Some(e) = c.space.take_if_exists(&tmpl("Route", obj! { "routeId" => j::at(pick[0], "routeId").clone() }), NO_WAIT, c.txn()).await? else { return refuse("Die Abstimmung ist gerade vorbei; „straße“ zeigt, wie es steht.") };
	let mut r = fields(&e).clone();
	let me = c.account.as_ref().map_or_else(String::new, |a| txt(j::at(a, "accountId")));
	let (n0, n1) = names_of(&r);
	let has = |k: &str, r: &Json| j::a(r, k).iter().any(|x| x.as_str() == Some(me.as_str()));
	if !has("voters", &r) { return refuse(format!("Über diese Straße stimmen die Siedler von {n0} und {n1} ab (wer dort eine Hütte hat oder als Siedler aufgenommen ist).")); }
	if has("yes", &r) || has("no", &r) { return refuse(format!("Du hast schon {} diese Straße gestimmt; jeder stimmt nur einmal ({}).", if has("yes", &r) { "für" } else { "gegen" }, votes_of(&r))); }
	let key = if yes { "yes" } else { "no" };
	let mut list = j::a(&r, key).to_vec();
	list.push(Json::from(me.as_str()));
	j::set(&mut r, key, Json::Array(list));
	let mut by = j::a(&r, "votedBy").to_vec();
	by.push(Json::from(c.char_id()));
	j::set(&mut r, "votedBy", Json::Array(by));
	let mine = c.char_id().to_owned();
	msg(c, &mine, "info", &format!("Du stimmst {} die Straße zwischen {n0} und {n1} ({}).", if yes { "für" } else { "gegen" }, votes_of(&r)), MsgOpts::default()).await?;
	let now = decay_now_of(&c.space, c.txn()).await?;
	let txn = c.txn().unwrap_or("").to_owned();
	let space = c.space.clone();
	if !decide(&space, &c.world.clone(), &txn, &mut r, now, true, &Say::Ctx(c)).await? { road_save(&space, &txn, &r).await?; }
	Ok(())
}

async fn mend(c: &mut Ctx) -> Result<()> {
	let def = def_of(c.w()).cloned().unwrap_or(Json::Null);
	let (ax, ay) = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let parts: Vec<Json> = c.space.read_all(&tmpl("Road", obj! { "room" => c.room() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect();
	let Some(near) = parts.iter().find(|p| j::s(p, "state") == "built" && j::a(p, "cells").iter().any(|q| (j::n(q, "x") - ax).abs().max((j::n(q, "y") - ay).abs()) <= SITE_REACH)) else { return refuse("Neben dir ist keine fertige Straße.") };
	let Some(e) = c.space.take_if_exists(&tmpl("Route", obj! { "routeId" => j::at(near, "routeId").clone() }), NO_WAIT, c.txn()).await? else { return refuse("Die Straße ist gerade nicht greifbar; bitte noch einmal.") };
	let mut r = fields(&e).clone();
	let pack = inventory(c).await?;
	let of = |proto: &Json| pack.iter().filter(|i| j::at(fields(i), "proto") == proto).collect::<Vec<_>>();
	for n in j::a(&def, "repair") {
		if (of(j::at(n, "proto")).len() as f64) < j::n(n, "count") {
			return refuse(format!("Zum Ausbessern brauchst du {}.", j::a(&def, "repair").iter().map(|x| format!("{} {}", txt(j::at(x, "count")), proto_name(c.w(), j::s(x, "proto")))).collect::<Vec<_>>().join(", ")));
		}
	}
	for n in j::a(&def, "repair") {
		for it in of(j::at(n, "proto")).into_iter().take(j::n(n, "count") as usize) {
			c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(it), "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await?;
		}
	}
	let keep = keep_ms(&c.space, &def).await;
	j::set(&mut r, "untilWorldMs", decay_now_of(&c.space, c.txn()).await? + keep);
	let txn = c.txn().unwrap_or("").to_owned();
	road_save(&c.space, &txn, &r).await?;
	let (n0, n1) = names_of(&r);
	msg(c, "*", "info", &format!("{} bessert die Straße zwischen {n0} und {n1} aus; sie hält wieder {}.", txt(j::at(&c.actor, "name")), days(keep)), MsgOpts::default()).await
}

async fn show(c: &mut Ctx) -> Result<()> {
	let room = c.room().to_owned();
	let all: Vec<Json> = routes_of(&c.space, c.txn()).await?.into_iter().filter(|r| j::a(r, "rooms").iter().any(|x| x.as_str() == Some(room.as_str()))).collect();
	let now = decay_now_of(&c.space, c.txn()).await?;
	let near: Vec<String> = neighbours(c).await?.into_iter().filter(|(_, r, _)| !all.iter().any(|x| j::a(x, "rooms").iter().any(|y| y.as_str() == Some(r.as_str())))).map(|(_, _, n)| n).collect();
	let mut lines: Vec<String> = all.iter().map(|r| {
		let to = other_name(r, &room);
		match j::s(r, "state") {
			"vote" => format!("Straße nach {to}: Abstimmung ({}), noch {}; geplant von {}. „straße ja“ oder „straße nein“.", votes_of(r), days(j::n(r, "voteUntil") - now), txt(j::at(r, "plannerName"))),
			"build" => format!("Straße nach {to}: wird gebaut, es fehlen {}; noch {} Zeit. Neben der Trasse „liefere stein“ und „arbeite“.", missing_of(r).join(", "), days(j::n(r, "untilWorldMs") - now)),
			_ => format!("Straße nach {to}: fertig, hält noch {} („straße repariere“ bessert sie aus).", days(j::n(r, "untilWorldMs") - now)),
		}
	}).collect();
	if !near.is_empty() && def_of(c.w()).is_some() { lines.push(format!("Ohne Straße: {} („straße plane <ort>“).", near.join(", "))); }
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &if lines.is_empty() { "Von hier führt kein Weg zu einem anderen Ort dieser Insel.".to_owned() } else { lines.join("\n") }, MsgOpts::default()).await
}

/// `straße`.
pub async fn strasse(c: &mut Ctx, arg: &str) -> Result<()> {
	if def_of(c.w()).is_none() { return refuse("In dieser Welt gibt es keine Straßen."); }
	let m = js::caps(&js::re(r"^(\S+)\s*(.*)$", ""), js::trim(arg));
	let verb = m.as_ref().and_then(|m| m[1].clone()).unwrap_or_default().to_lowercase();
	let rest = m.as_ref().and_then(|m| m[2].clone()).unwrap_or_default();
	if verb.is_empty() { return show(c).await; }
	match verb.as_str() {
		"plane" | "plan" | "planen" => plan(c, &rest).await,
		"ja" | "yes" | "dafür" | "dafuer" | "für" | "fuer" => vote(c, true, &rest).await,
		"nein" | "no" | "dagegen" | "gegen" => vote(c, false, &rest).await,
		"repariere" | "repair" | "ausbessern" | "bessere" => mend(c).await,
		_ => not_understood("So geht es: straße, straße plane <ort>, straße ja, straße nein, straße repariere"),
	}
}

/// `roadTick`: votes whose time is up are decided; a road not built in time and a road that decayed go.
pub async fn road_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<()> {
	if def_of(w).is_none() { return Ok(()); }
	let now = decay_now_of(space, None).await?;
	for old in routes_of(space, None).await? {
		let due = if j::s(&old, "state") == "vote" { j::n(&old, "voteUntil") <= now } else { j::n(&old, "untilWorldMs") <= now };
		if !due { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(e) = space.take_if_exists(&tmpl("Route", obj! { "routeId" => j::at(&old, "routeId").clone() }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let mut r = fields(&e).clone();
			let say = Say::Tick(lease_ms);
			if j::s(&r, "state") == "vote" { decide(space, w, &txn, &mut r, now, false, &say).await?; } else {
				road_gone(space, &txn, j::at(&r, "routeId")).await?;
				let (n0, n1) = names_of(&r);
				let (r0, r1) = rooms_of(&r);
				let text = if j::s(&r, "state") == "build" { format!("Die Straße zwischen {n0} und {n1} wurde nicht rechtzeitig fertig; die Trasse ist aufgegeben.") } else { format!("Die Straße zwischen {n0} und {n1} ist verfallen; Karren fahren dort nicht mehr.") };
				for room in [&r0, &r1] { say.say(space, &txn, room, &text).await?; }
			}
			Ok(true)
		}.await;
		match r { Ok(true) => space.commit(&txn).await?, Ok(false) => space.abort(&txn).await?, Err(err) => { let _ = space.abort(&txn).await; return Err(err); } }
	}
	Ok(())
}
