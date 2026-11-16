//! The settlers (`server/npc/settlers.ts`, docs/siedeln.en.md "Wenige Spieler: die Welt packt mit an"): script figures
//! that play like people where too few people play. Each lives on one fire's island and plays through the commands a
//! player types: it gathers, builds a hut, a rain barrel and a coop, helps at the sites of others, digs beds and tends
//! them, sells at its island's market, repairs, joins its rooms by road and feeds its fire. One command a round.
use std::collections::HashMap;

use phi_json::{obj, Json};

use super::economy::{beacon_of, dist_to, first_alias, fuels, gather, homes_of, look, min_fuel, next_to, rest, step_beside, tile, travel, Look, Rect, Social};
use super::Npc;
use crate::commands::build::PATH;
use crate::commands::cart::{road_links, road_path};
use crate::commands::epoch::epoch_of;
use crate::commands::festival::{crops, flowers};
use crate::commands::settlement::{enough_huts, settlement_in};
use crate::fire::{flame_of, key_text as txt};
use crate::j;
use crate::regions::region_world;
use crate::settings::setting;
use crate::source::random_int;
use crate::space::{fields, tmpl, Result};

fn nt(n: f64) -> String { phi_json::number_text(n) }
fn name_of(w: &Json, proto: &str) -> String { j::by(j::a(w, "prototypes"), "key", proto).map_or_else(|| proto.to_owned(), |p| txt(j::at(p, "name"))) }
fn room_name(w: &Json, room: &str) -> String { j::by(j::a(w, "rooms"), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
fn has(list: &[String], x: &str) -> bool { list.iter().any(|y| y == x) }
fn all_of(f: &[Json]) -> Vec<Json> { f.iter().map(|e| fields(e).clone()).collect() }
fn at_rect(f: &Json) -> (Rect, String) { (Rect::of(f), j::s(f, "room").to_owned()) }

const RAW: [&str; 3] = ["treibholz", "tang", "muschel"];
const PLANS: [&str; 3] = ["huette", "regentonne", "huehnerstall"];
const CART_FROM: usize = 6;
const RAW_MAX: usize = 8;

thread_local! { static REGION_SETTLERS: std::cell::RefCell<Option<Vec<String>>> = const { std::cell::RefCell::new(None) }; }
/// The settlers of the region this process plays (all without regions), in their fixed order, by npcId.
fn region_settlers(w: &Json) -> Vec<String> {
	if let Some(v) = REGION_SETTLERS.with(|c| c.borrow().clone()) { return v; }
	let region = std::env::var("SPACES_MMO_REGION").unwrap_or_default();
	let rooms: Vec<String> = if !region.is_empty() && !j::a(w, "regions").is_empty() {
		region_world(w, &region).map(|rw| j::a(&rw, "rooms").iter().map(|r| j::s(r, "roomId").to_owned()).collect()).unwrap_or_default()
	} else { j::a(w, "rooms").iter().map(|r| j::s(r, "roomId").to_owned()).collect() };
	let v: Vec<String> = j::a(w, "npcs").iter().filter(|n| j::truthy(j::at(n, "settler")) && has(&rooms, j::s(n, "room"))).map(|n| j::s(n, "npcId").to_owned()).collect();
	REGION_SETTLERS.with(|c| *c.borrow_mut() = Some(v.clone()));
	v
}

/// `wanted`: whether this settler should play now.
pub async fn wanted(n: &Npc) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	let all = j::a(&w, "npcs").iter().filter(|x| j::truthy(j::at(x, "settler"))).count() as f64;
	let mine = region_settlers(&w);
	let Some(rank) = mine.iter().position(|x| x == j::s(&def, "npcId")) else { return Ok(false) };
	if all == 0.0 { return Ok(false); }
	let people = n.space.read_all(&obj! { "type" => "Session" }, None).await?.iter().filter(|e| !j::s(fields(e), "charId").starts_with("npc-")).count() as f64;
	let target = crate::js::round(setting(&n.space, "settlers.min").await? * mine.len() as f64 / all) - people;
	Ok((rank as f64) < target)
}

/// `besideOf`: walks to a free cell beside `r`; false when it stands there already.
async fn beside_of(n: &Npc, l: &Look, r: &Rect, room: &str, reach: f64) -> Result<bool> {
	if !travel(n, l, room).await? { return Ok(true); }
	step_beside(n, l, r, reach).await
}

fn on_path(w: &Json, f: &Json) -> bool {
	let (r, room) = at_rect(f);
	let ground: Vec<String> = j::by(j::a(w, "rooms"), "roomId", &room).map(|x| j::a(x, "ground").iter().filter_map(Json::as_str).map(str::to_owned).collect()).unwrap_or_default();
	let mut y = r.y;
	while y < r.y + r.h { let mut x = r.x; while x < r.x + r.w { if tile(&ground, x, y) == PATH { return true; } x += 1.0; } y += 1.0; }
	false
}

/// `freeGround`: a free place of w×h in the room on grass (else sand), off paths, doors and fires; picked at random.
async fn free_ground(n: &Npc, room: &str, w: f64, h: f64) -> Result<Option<(f64, f64)>> {
	let world = n.w();
	let ground: Vec<String> = j::by(j::a(&world, "rooms"), "roomId", room).map(|x| j::a(x, "ground").iter().filter_map(Json::as_str).map(str::to_owned).collect()).unwrap_or_default();
	let mut busy: Vec<String> = Vec::new();
	for t in [tmpl("Plot", obj! { "room" => room }), tmpl("Item", obj! { "location" => room }), tmpl("Character", obj! { "room" => room })] {
		busy.extend(n.space.read_all(&t, None).await?.iter().map(|e| format!("{},{}", nt(j::n(fields(e), "x")), nt(j::n(fields(e), "y")))));
	}
	let near: Vec<(f64, f64)> = j::a(&world, "exits").iter().filter(|e| j::s(e, "room") == room).chain(j::a(&world, "beacons").iter().filter(|b| j::s(b, "room") == room)).map(|e| (j::n(e, "x"), j::n(e, "y"))).collect();
	let fits = |x0: f64, y0: f64, t: &str| {
		let mut y = y0;
		while y < y0 + h {
			let mut x = x0;
			while x < x0 + w {
				if tile(&ground, x, y) != t || busy.contains(&format!("{},{}", nt(x), nt(y))) || near.iter().any(|e| (e.0 - x).abs().max((e.1 - y).abs()) <= 2.0) { return false; }
				x += 1.0;
			}
			y += 1.0;
		}
		true
	};
	let rows = ground.len() as f64;
	let cols = ground.first().map_or(0, |r| r.encode_utf16().count()) as f64;
	for t in [",", "."] {
		let mut all: Vec<(f64, f64)> = Vec::new();
		let mut y = 1.0;
		while y < rows - h { let mut x = 1.0; while x < cols - w { if fits(x, y, t) { all.push((x, y)); } x += 1.0; } y += 1.0; }
		if !all.is_empty() { return Ok(Some(all[random_int(0.0, all.len() as f64) as usize])); }
	}
	Ok(None)
}

/// The fire first (`siedler` and `dorfbewohner`): low means less than `pieces` of the smallest fuel.
async fn fire_low(n: &Npc, w: &Json, fire: &Json, now: f64, pieces: f64) -> Result<bool> {
	let f = flame_of(&n.space, j::s(fire, "beaconId"), None).await?;
	let piece = min_fuel(w) * n.clock.patience();
	Ok(f.as_ref().is_none_or(|f| j::n(f, "until") - now < piece * pieces))
}

/// `siedler`.
#[derive(Default)]
pub struct Siedler { backoff: HashMap<String, u64>, round: u64, home_at: usize }

impl Siedler {
	fn may(&self, what: &str) -> bool { self.backoff.get(what).copied().unwrap_or(0) <= self.round }
	fn later(&mut self, what: &str, rounds: u64) { self.backoff.insert(what.to_owned(), self.round + rounds); }

	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		self.round += 1;
		if !wanted(n).await? {
			if n.is_online() { n.act("emote macht für heute Schluss.").await?; n.set_online(false).await?; }
			n.sleep(n.pace(10.0 * 60_000.0, 20_000.0)).await;
			return Ok(());
		}
		if !n.is_online() { n.set_online(true).await?; }
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let def = n.def();
		let homes = homes_of(&def, j::s(&def, "room"));
		if !has(&homes, l.room()) { travel(n, &l, j::s(&def, "room")).await?; n.sleep(rest(n, l.room()).await?).await; return Ok(()); }
		self.act(n, &l, &homes).await?;
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}

	async fn act(&mut self, n: &Npc, l: &Look, homes: &[String]) -> Result<()> {
		let w = n.w();
		let def = n.def();
		let me = &l.me;
		let me_id = j::s(me, "charId").to_owned();
		let now = n.clock.now().await.unwrap_or(0.0);
		let g = j::opt(&w, "garden").cloned();
		let fs = fuels(&w);
		let fuel: Vec<&Json> = l.pack.iter().filter(|i| has(&fs, j::s(i, "proto"))).collect();
		if let (Some(fire), false) = (beacon_of(&w, &def), fuel.is_empty()) {
			if fire_low(n, &w, fire, now, 2.0).await? {
				if !travel(n, l, j::s(fire, "room")).await? { return Ok(()); }
				let fxy = (j::n(fire, "x"), j::n(fire, "y"));
				let (mx, my) = l.xy();
				if (mx - fxy.0).abs().max((my - fxy.1).abs()) <= 1.0 { n.act(&format!("put {} in {}", j::s(fuel[0], "name"), first_alias(fire))).await?; } else { next_to(n, l, fxy).await?; }
				return Ok(());
			}
		}
		if self.festive(n, l, &w, homes).await? { return Ok(()); }
		let meal = l.pack.iter().find(|i| j::opt(j::at(j::at(&w, "food"), "foods"), j::s(i, "proto")).is_some_and(j::truthy));
		if let (Some(meal), true) = (meal, self.may("essen")) { self.later("essen", 40); return n.act(&format!("iss {}", j::s(meal, "name"))).await; }
		let rested = match n.space.read_if_exists(&tmpl("WorkRest", obj! { "charId" => me_id.as_str() }), 0.0, None).await { Ok(Some(e)) => j::n(fields(&e), "untilWorldMs"), _ => 0.0 };
		let tired = rested > now;
		let sites: Vec<Json> = if homes.is_empty() { vec![] } else { all_of(&n.space.read_all(&obj! { "type" => "Site" }, None).await?).into_iter().filter(|s| has(homes, j::s(s, "room"))).collect() };
		let own = sites.iter().find(|s| j::s(s, "accountId") == me_id).cloned();
		let mut mine_built: Vec<Json> = all_of(&n.space.read_all(&tmpl("Building", obj! { "accountId" => me_id.as_str() }), None).await?);
		let astray = own.iter().map(|o| (o.clone(), true)).chain(mine_built.drain(..).map(|b| (b, false))).find(|(r, _)| on_path(&w, r));
		if let Some((a, is_own)) = astray {
			let (r, room) = at_rect(&a);
			if !beside_of(n, l, &r, &room, 1.0).await? { n.act(&format!("abriss {}", if is_own { "baustelle" } else { j::s(&a, "name") })).await?; }
			return Ok(());
		}
		if let Some(o) = &own { if self.at_site(n, l, o, tired).await? { return Ok(()); } }
		for s in sites.iter().filter(|x| own.as_ref() != Some(*x)) { if self.at_site(n, l, s, tired || !self.round.is_multiple_of(3)).await? { return Ok(()); } }

		let buildings: Vec<Json> = all_of(&n.space.read_all(&obj! { "type" => "Building" }, None).await?).into_iter().filter(|b| j::s(b, "accountId") == me_id).collect();
		for b in &buildings {
			let plan = j::a(j::at(&w, "building"), "plans").iter().find(|p| j::at(p, "key") == j::at(b, "plan")).cloned();
			let cost: Vec<Json> = plan.as_ref().map(|p| j::a(p, "repair").to_vec()).unwrap_or_default();
			let decay = n.clock.decay_now().await.unwrap_or(0.0);
			if j::n(b, "untilWorldMs") - decay > 2.0 * 24.0 * 3_600_000.0 || !cost.iter().all(|r| l.count(j::s(r, "proto")) as f64 >= j::n(r, "count")) { continue; }
			let (r, room) = at_rect(b);
			if !beside_of(n, l, &r, &room, 1.0).await? { n.act(&format!("repariere {}", j::s(b, "name"))).await?; }
			return Ok(());
		}
		let beds: Vec<Json> = if g.is_some() { all_of(&n.space.read_all(&obj! { "type" => "Bed" }, None).await?).into_iter().filter(|b| j::s(b, "accountId") == me_id).collect() } else { vec![] };
		for b in &beds { if self.tend(n, l, b, &buildings, now).await? { return Ok(()); } }

		let built = |plan: &str| buildings.iter().any(|b| j::s(b, "plan") == plan);
		if own.is_none() {
			for plan in PLANS {
				let plans = j::a(j::at(&w, "building"), "plans");
				if built(plan) || !self.may(plan) || !plans.iter().any(|p| j::s(p, "key") == plan) { continue; }
				if !has(homes, l.room()) || !j::a(&w, "beacons").iter().any(|b| j::a(b, "covers").iter().any(|c| c.as_str() == Some(l.room()))) { continue; }
				let d = plans.iter().find(|p| j::s(p, "key") == plan).cloned().unwrap_or(Json::Null);
				let at = free_ground(n, l.room(), j::n(&d, "w"), j::n(&d, "h")).await?;
				self.later(plan, 20);
				if let Some((x, y)) = at { return n.act(&format!("bau {} {} {}", j::s(&d, "name").to_lowercase(), nt(x), nt(y))).await; }
			}
		}
		if own.is_none() && PLANS.iter().all(|p| built(p)) && self.road(n, l, &w, homes).await? { return Ok(()); }
		if built("huette") && j::truthy(j::at(&w, "settlement")) && self.may("siedlung") {
			self.later("siedlung", 40);
			if let Some(hut) = buildings.iter().find(|b| j::s(b, "plan") == "huette") {
				let room = j::s(hut, "room");
				let huts = all_of(&n.space.read_all(&tmpl("Building", obj! { "room" => room, "plan" => j::at(j::at(&w, "settlement"), "plan").clone() }), None).await?);
				if l.room() == room && enough_huts(&w, &huts) && settlement_in(&n.space, room, None).await?.is_none() {
					let name = j::by(j::a(&w, "rooms"), "roomId", room).map_or_else(|| j::s(me, "name").to_owned(), |r| txt(j::at(r, "name")));
					return n.act(&format!("siedlung gründen {name}")).await;
				}
			}
		}
		if let Some(g) = &g {
			let max_beds = j::no(j::at(&w, "settlers"), "maxBeds").unwrap_or(1.0);
			if (beds.len() as f64) < max_beds && built("huette") {
				let spade = j::s(g, "spade");
				if l.count(spade) == 0 { if self.craft(n, l, &w, spade).await? { return Ok(()); } }
				else if self.may("beet") {
					self.later("beet", 15);
					let bed = j::at(g, "bed");
					if let Some((x, y)) = free_ground(n, l.room(), j::n(bed, "w"), j::n(bed, "h")).await? { return n.act(&format!("umgraben {} {}", nt(x), nt(y))).await; }
				}
			}
		}
		if l.count("tang") >= 3 && l.count("tangseil") < 2 { return n.act("craft tangseil").await; }
		let route = j::at(j::at(&w, "cart"), "route");
		let road_needs: Vec<String> = if route.as_object().is_some() { vec![j::s(route, "stone").to_owned(), j::s(route, "woodProto").to_owned()] } else { vec![] };
		let spade = g.as_ref().map(|g| j::s(g, "spade").to_owned());
		let can = g.as_ref().map(|g| j::s(g, "can").to_owned());
		let cart_proto = j::so(j::at(&w, "cart"), "proto").map(str::to_owned);
		let heap: Vec<Json> = l.pack.iter().filter(|i| {
			let p = j::s(i, "proto");
			!RAW.contains(&p) && !has(&road_needs, p) && p != "tangseil" && spade.as_deref() != Some(p) && can.as_deref() != Some(p) && cart_proto.as_deref() != Some(p) && p != j::s(&w, "currency")
				&& j::by(j::a(&w, "prototypes"), "key", p).is_none_or(|x| j::s(x, "typeclass") != "Seed")
		}).cloned().collect();
		if self.haul(n, l, &w, homes, &heap).await? { return Ok(()); }
		if self.trade(n, l, &w, homes, &heap, own.as_ref()).await? { return Ok(()); }
		if let Some(hut) = buildings.iter().find(|b| j::s(b, "plan") == "huette") {
			if heap.len() > 6 && self.may("chest") {
				self.later("chest", 10);
				let (r, room) = at_rect(hut);
				if !beside_of(n, l, &r, &room, 1.0).await? { n.act(&format!("verstaue alle {}", j::s(&heap[0], "name"))).await?; }
				return Ok(());
			}
		}
		let building: Vec<Json> = all_of(&n.space.read_all(&obj! { "type" => "Route" }, None).await?).into_iter().filter(|r| j::s(r, "state") == "build" && j::a(r, "rooms").iter().any(|x| x.as_str().is_some_and(|x| has(homes, x)))).collect();
		let short: Vec<String> = sites.iter().chain(building.iter()).flat_map(|s| j::a(s, "needs").iter().filter(|x| j::n(x, "have") < j::n(x, "count") && !RAW.contains(&j::s(x, "proto"))).map(|x| j::s(x, "proto").to_owned()).collect::<Vec<_>>()).collect();
		let mut want: Vec<String> = RAW.iter().filter(|p| l.count(p) < RAW_MAX).map(|p| (*p).to_owned()).collect();
		want.extend(short);
		if gather(n, l, &want).await? { return Ok(()); }
		self.home_at = (self.home_at + 1) % homes.len().max(1);
		if homes.len() > 1 && self.round.is_multiple_of(4) { travel(n, l, &homes[self.home_at]).await?; }
		Ok(())
	}

	/// `road`: helps build a road of its home, or plans one to the first room of its home no road joins yet.
	async fn road(&mut self, n: &Npc, l: &Look, w: &Json, homes: &[String]) -> Result<bool> {
		let def = j::at(j::at(w, "cart"), "route");
		if !def.as_object().is_some() || !self.may("road") { return Ok(false); }
		let isl = j::by(j::a(w, "rooms"), "roomId", l.room()).and_then(|r| j::so(r, "island")).map(str::to_owned);
		if epoch_of(&n.space, isl.as_deref(), None).await? < j::n(def, "epoch") { self.later("road", 30); return Ok(false); }
		let routes: Vec<Json> = all_of(&n.space.read_all(&obj! { "type" => "Route" }, None).await?).into_iter().filter(|r| j::a(r, "rooms").iter().all(|x| x.as_str().is_some_and(|x| has(homes, x)))).collect();
		if let Some(open) = routes.iter().find(|r| j::s(r, "state") == "build") {
			let give = j::a(open, "needs").iter().find(|x| j::n(x, "have") < j::n(x, "count") && l.count(j::s(x, "proto")) > 0).cloned();
			if give.is_none() && j::n(open, "work") >= j::n(open, "workNeed") { return Ok(false); }
			let cells = j::a(open, "cells");
			let Some(cell) = cells.iter().find(|c| j::s(c, "room") == l.room()).or(cells.first()) else { return Ok(false) };
			if beside_of(n, l, &Rect::cell(j::n(cell, "x"), j::n(cell, "y")), j::s(cell, "room"), 2.0).await? { return Ok(true); }
			self.later("road", 2);
			n.act(&give.map_or_else(|| "arbeite an der straße".to_owned(), |g| format!("liefere {} an die straße", j::s(&g, "name")))).await?;
			return Ok(true);
		}
		let pair = |a: &str, b: &str| { let mut v = [a, b]; v.sort(); v.join("|") };
		let exit = if routes.iter().any(|r| j::s(r, "state") == "vote") { None } else {
			j::a(w, "exits").iter().find(|e| has(homes, j::s(e, "room")) && has(homes, j::s(e, "destination")) && !routes.iter().any(|r| j::s(r, "pair") == pair(j::s(e, "room"), j::s(e, "destination")))).cloned()
		};
		let Some(exit) = exit else { self.later("road", 30); return Ok(false) };
		if !travel(n, l, j::s(&exit, "room")).await? { return Ok(true); }
		self.later("road", 20);
		n.act(&format!("straße plane {}", room_name(w, j::s(&exit, "destination")))).await?;
		Ok(true)
	}

	/// `haul`: a cart to the market by road.
	async fn haul(&mut self, n: &Npc, l: &Look, w: &Json, homes: &[String], heap: &[Json]) -> Result<bool> {
		let d = j::at(w, "cart");
		let Some(market) = homes.iter().find(|r| j::a(j::at(w, "market"), "rooms").iter().any(|m| m.as_str() == Some(r.as_str()))).cloned() else { return Ok(false) };
		if !d.as_object().is_some() { return Ok(false); }
		let me = j::s(&l.me, "charId");
		let mine = all_of(&n.space.read_all(&obj! { "type" => "Cart" }, None).await?).into_iter().find(|c| j::s(c, "accountId") == me);
		if let Some(c) = &mine {
			if !j::a(c, "path").is_empty() { return Ok(false); }
			let croom = j::s(c, "room").to_owned();
			let at = Rect::cell(j::n(c, "x"), j::n(c, "y"));
			let cargo = n.space.count(&tmpl("Item", obj! { "location" => j::at(c, "cartId").clone() }), None).await?;
			let loading = croom == l.room() && croom != market && cargo < j::n(d, "capacity") && !heap.is_empty() && self.may("karren");
			if cargo == 0.0 && !loading {
				if !travel(n, l, &croom).await? { return Ok(true); }
				if !beside_of(n, l, &at, &croom, 1.0).await? { n.act("karren nimm").await?; }
				return Ok(true);
			}
			if croom != l.room() { travel(n, l, &croom).await?; return Ok(true); }
			if beside_of(n, l, &at, &croom, 1.0).await? { return Ok(true); }
			if croom == market { n.act("karren entlade").await?; self.later("karren", 30); return Ok(true); }
			if loading { n.act(&format!("karren lade {}", j::s(&heap[0], "name"))).await?; return Ok(true); }
			if road_path(&road_links(&n.space, w, None).await?, &croom, &market).is_none() { n.act("karren entlade").await?; self.later("karren", 20); return Ok(true); }
			n.act(&format!("karren fahre {market}")).await?;
			return Ok(true);
		}
		if heap.len() < CART_FROM || l.room() == market || !self.may("karren") || !l.pack.iter().any(|i| j::at(i, "proto") == j::at(d, "proto")) { return Ok(false); }
		if road_path(&road_links(&n.space, w, None).await?, l.room(), &market).is_none() { self.later("karren", 20); return Ok(false); }
		n.act("karren stelle").await?;
		Ok(true)
	}

	/// `trade`: at the island's market, one thing it does not need on the board, or the first thing its site lacks.
	async fn trade(&mut self, n: &Npc, l: &Look, w: &Json, homes: &[String], heap: &[Json], site: Option<&Json>) -> Result<bool> {
		let Some(market) = homes.iter().find(|r| j::a(j::at(w, "market"), "rooms").iter().any(|m| m.as_str() == Some(r.as_str()))).cloned() else { return Ok(false) };
		if !self.may("market") { return Ok(false); }
		let coins = l.count(j::s(w, "currency")) as f64;
		let lacks: Vec<String> = site.map(|s| j::a(s, "needs").iter().filter(|x| j::n(x, "have") < j::n(x, "count") && l.count(j::s(x, "proto")) == 0).map(|x| j::s(x, "name").to_owned()).collect()).unwrap_or_default();
		if heap.len() < 2 && !(coins > 0.0 && !lacks.is_empty()) { return Ok(false); }
		if !travel(n, l, &market).await? { return Ok(true); }
		self.later("market", 12);
		let mut board = all_of(&n.space.read_all(&tmpl("Listing", obj! { "room" => market.as_str() }), None).await?);
		board.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")).then_with(|| crate::js::locale_compare(j::s(a, "listingId"), j::s(b, "listingId"))));
		let me = j::at(&l.me, "charId");
		if let Some(i) = board.iter().position(|x| j::at(x, "seller") != me && j::n(x, "price") <= coins && has(&lacks, j::s(x, "itemName"))) { n.act(&format!("market kaufe {}", i + 1)).await?; return Ok(true); }
		if heap.len() >= 2 && board.iter().filter(|x| j::at(x, "seller") == me).count() < 3 { n.act(&format!("market biete {} für {}", j::s(&heap[0], "name"), 2 + self.round % 3)).await?; return Ok(true); }
		Ok(false)
	}

	/// `atSite`: deliver what it carries of what is missing, or work (`no_work`: not this round).
	async fn at_site(&mut self, n: &Npc, l: &Look, s: &Json, no_work: bool) -> Result<bool> {
		let give = j::a(s, "needs").iter().find(|x| j::n(x, "have") < j::n(x, "count") && l.count(j::s(x, "proto")) > 0).cloned();
		let work = !no_work && j::n(s, "work") < j::n(s, "workNeed");
		if give.is_none() && !work {
			if j::at(s, "accountId") == j::at(&l.me, "charId") {
				let rope = j::a(s, "needs").iter().any(|x| j::s(x, "proto") == "tangseil" && j::n(x, "have") < j::n(x, "count"));
				if rope && l.count("tang") >= 3 { n.act("craft tangseil").await?; return Ok(true); }
			}
			return Ok(false);
		}
		let (r, room) = at_rect(s);
		if beside_of(n, l, &r, &room, 2.0).await? { return Ok(true); }
		n.act(&give.map_or_else(|| "arbeite".to_owned(), |g| format!("liefere {}", j::s(&g, "name")))).await?;
		Ok(true)
	}

	/// `craft`: makes a thing by its recipe, or gathers what it needs.
	async fn craft(&mut self, n: &Npc, l: &Look, w: &Json, proto: &str) -> Result<bool> {
		let Some(r) = j::a(w, "recipes").iter().find(|x| j::s(x, "makes") == proto) else { return Ok(false) };
		let Some(lack) = j::a(r, "needs").iter().find(|x| (l.count(j::s(x, "proto")) as f64) < j::n(x, "count")) else { n.act(&format!("craft {}", j::s(r, "key"))).await?; return Ok(true) };
		let lp = j::s(lack, "proto");
		if lp == "tangseil" && l.count("tang") >= 3 { n.act("craft tangseil").await?; return Ok(true); }
		let mut what = vec![lp.to_owned()];
		if lp == "tangseil" { what.push("tang".into()); }
		gather(n, l, &what).await
	}

	/// `festive`: a festival at home: it shows what it carries; a park it tends now and then.
	async fn festive(&mut self, n: &Npc, l: &Look, w: &Json, homes: &[String]) -> Result<bool> {
		let d = j::at(w, "festival");
		if !d.as_object().is_some() { return Ok(false); }
		let parks: Vec<Json> = all_of(&n.space.read_all(&tmpl("Building", obj! { "plan" => j::at(d, "plan").clone() }), None).await?).into_iter().filter(|b| has(homes, j::s(b, "room"))).collect();
		let fl = flowers(w);
		let cr = crops(w);
		for park in &parks {
			let room = j::s(park, "room").to_owned();
			let show = match n.space.read_if_exists(&tmpl("Show", obj! { "room" => room.as_str() }), 0.0, None).await { Ok(Some(e)) => Some(fields(&e).clone()), _ => None };
			let flower = l.pack.iter().find(|i| has(&fl, j::s(i, "proto")));
			let (r, _) = at_rect(park);
			if let Some(show) = &show {
				let key = format!("fest-{}", txt(j::at(show, "showId")));
				if self.may(&key) {
					let blumen = j::s(show, "kind") == "blumen";
					let thing = if blumen { flower } else { l.pack.iter().find(|i| has(&cr, j::s(i, "proto"))) };
					if let Some(t) = thing {
						if !travel(n, l, &room).await? { return Ok(true); }
						if !beside_of(n, l, &r, &room, 1.0).await? { n.act(&format!("zeige {}", j::s(t, "name"))).await?; if blumen { self.later(&key, 100_000); } }
						return Ok(true);
					}
				}
			}
			if flower.is_some() && self.may("pflege") {
				if !travel(n, l, &room).await? { return Ok(true); }
				if !beside_of(n, l, &r, &room, 1.0).await? { n.act("pflege").await?; self.later("pflege", 60); }
				return Ok(true);
			}
		}
		Ok(false)
	}

	/// `tend`: harvest, weed, water (a can from its barrel), plant a seed it carries, look for seeds.
	async fn tend(&mut self, n: &Npc, l: &Look, b: &Json, buildings: &[Json], now: f64) -> Result<bool> {
		let w = n.w();
		let g = j::at(&w, "garden").clone();
		let (r, room) = at_rect(b);
		let plants = j::a(b, "plants");
		let near = |line: String| { let room = room.clone(); async move { if !beside_of(n, l, &r, &room, 1.0).await? { n.act(&line).await?; } Ok::<bool, crate::space::Error>(true) } };
		if plants.iter().any(|p| j::n(p, "stage") == 2.0) { return near("ernte".into()).await; }
		if j::truthy(j::at(b, "weedy")) || plants.iter().any(|p| j::n(p, "stage") == 3.0) { return near("jäte".into()).await; }
		let growing = plants.iter().any(|p| j::n(p, "stage") < 2.0);
		if growing && now - j::n(b, "wateredWorldMs") > j::n(&g, "thirstWorldMs") * 0.6 * n.clock.patience() {
			if l.count(j::s(&g, "can")) > 0 { return near("gieße".into()).await; }
			if let Some(barrel) = buildings.iter().find(|x| j::at(x, "plan") == j::at(&g, "barrel")) {
				if self.may("schoepfe") {
					self.later("schoepfe", 6);
					let (br, broom) = at_rect(barrel);
					if !beside_of(n, l, &br, &broom, 1.0).await? { n.act("schöpfe").await?; }
					return Ok(true);
				}
			}
		}
		let zier = j::s(b, "kind") == "zier";
		let seed = l.pack.iter().find(|i| j::a(&g, "sorts").iter().any(|s| j::at(s, "seed") == j::at(i, "proto") && (!zier || j::s(s, "kind") == "zier")));
		if (plants.len() as f64) < j::n(b, "w") * j::n(b, "h") {
			if let Some(s) = seed { return near(format!("pflanze {}", j::s(s, "name"))).await; }
			if self.may("samen") { self.later("samen", 8); n.act("sammle samen").await?; return Ok(true); }
		}
		Ok(false)
	}
}

/// `paidJobs`: sites of the NPC's rooms that pay for something and have room for NPC help.
async fn paid_jobs(n: &Npc, homes: &[String], tried: &HashMap<String, u64>, turn: u64) -> Result<Vec<(Json, Json)>> {
	let orders: Vec<Json> = all_of(&n.space.read_all(&obj! { "type" => "SiteOrder" }, None).await?).into_iter().filter(|o| has(homes, j::s(o, "room")) && tried.get(j::s(o, "orderId")).copied().unwrap_or(0) <= turn).collect();
	if orders.is_empty() { return Ok(vec![]); }
	let sites = all_of(&n.space.read_all(&obj! { "type" => "Site" }, None).await?);
	let open = |s: &Json| j::n(s, "other") < ((j::a(s, "needs").iter().map(|x| j::n(x, "count")).sum::<f64>() + j::n(s, "workNeed")) / 2.0).floor();
	Ok(orders.into_iter().filter_map(|o| sites.iter().rev().find(|s| j::at(s, "buildId") == j::at(&o, "buildId")).filter(|s| open(s)).cloned().map(|s| (o, s))).collect())
}

/// `deliverer`: one step towards a site that pays for what the NPC carries.
#[derive(Default)]
pub struct Deliverer { tried: HashMap<String, u64>, turn: u64 }
impl Deliverer {
	pub async fn run(&mut self, n: &Npc, l: &Look, homes: &[String]) -> Result<bool> {
		self.turn += 1;
		let jobs = paid_jobs(n, homes, &self.tried, self.turn).await?;
		let Some((o, s)) = jobs.into_iter().find(|(o, _)| { let p = j::s(o, "proto"); !p.is_empty() && l.count(p) > 0 }) else { return Ok(false) };
		let (r, room) = at_rect(&s);
		if beside_of(n, l, &r, &room, 1.0).await? { return Ok(true); }
		self.tried.insert(j::s(&o, "orderId").to_owned(), self.turn + 10);
		n.act(&format!("liefere {} {}", nt(j::n(&o, "left").min(l.count(j::s(&o, "proto")) as f64)), j::s(&o, "name"))).await?;
		Ok(true)
	}
}

/// `bauhelfer`: the day labourer, working and fetching for a wage at the sites of its rooms.
#[derive(Default)]
pub struct Bauhelfer { carry: Deliverer, tried: HashMap<String, u64>, turn: u64, home: usize }
impl Bauhelfer {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		self.turn += 1;
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let def = n.def();
		let homes = homes_of(&def, j::s(&def, "room"));
		let jobs = paid_jobs(n, &homes, &self.tried, self.turn).await?;
		if !self.carry.run(n, &l, &homes).await? {
			let now = n.clock.now().await.unwrap_or(0.0);
			let rest0 = n.space.read_all(&tmpl("WorkRest", obj! { "charId" => j::at(&l.me, "charId").clone() }), None).await?.first().map(|e| fields(e).clone());
			let free = rest0.as_ref().is_none_or(|r| j::n(r, "untilWorldMs") <= now);
			let work = if free { jobs.iter().find(|(o, _)| j::s(o, "proto").is_empty()).cloned() } else { None };
			if let Some((o, s)) = work {
				let (r, room) = at_rect(&s);
				if !beside_of(n, &l, &r, &room, 1.0).await? { self.tried.insert(j::s(&o, "orderId").to_owned(), self.turn + 5); n.act("arbeite").await?; }
			} else if jobs.iter().any(|(o, _)| !j::s(o, "proto").is_empty()) {
				let protos: Vec<String> = jobs.iter().map(|(o, _)| j::s(o, "proto").to_owned()).collect();
				if !gather(n, &l, &protos).await? { self.home = (self.home + 1) % homes.len(); travel(n, &l, &homes[self.home]).await?; }
			} else if !has(&homes, l.room()) { travel(n, &l, &homes[self.home]).await?; }
		}
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

const PER_VILLAGER: f64 = 5.0;
/// `villageOf`: the room of a settlement in the NPC's rooms with enough buildings for it.
async fn village_of(n: &Npc, homes: &[String]) -> Result<Option<String>> {
	let villager = j::no(&n.def(), "villager").filter(|v| *v != 0.0).unwrap_or(1.0);
	for e in n.space.read_all(&obj! { "type" => "Settlement" }, None).await? {
		let room = txt(j::at(fields(&e), "room"));
		if has(homes, &room) && n.space.count(&tmpl("Building", obj! { "room" => room.as_str() }), None).await? >= PER_VILLAGER * villager { return Ok(Some(room)); }
	}
	Ok(None)
}

/// `dorfbewohner`: the villager, living on its settlement's square once it has grown.
#[derive(Default)]
pub struct Dorfbewohner { talk: Social, round: u64 }
impl Dorfbewohner {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		self.round += 1;
		let def = n.def();
		let homes = homes_of(&def, j::s(&def, "room"));
		let Some(room) = village_of(n, &homes).await? else {
			if n.is_online() { n.act("emote zieht sich zurück.").await?; n.set_online(false).await?; }
			n.sleep(n.pace(60_000.0, 5_000.0)).await;
			return Ok(());
		};
		if !n.is_online() { n.set_online(true).await?; n.act("emote zieht ins Dorf.").await?; }
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		if !self.talk.run(n, &l).await? && !chores(n, &l, &room).await? && self.round.is_multiple_of(6) {
			let lines = j::a(&def, "lines");
			let line = lines.get((self.round as usize) % lines.len().max(1)).and_then(Json::as_str).unwrap_or("Schön, wie das Dorf wächst.");
			n.act(&format!("say {line}")).await?;
		}
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

async fn chores(n: &Npc, l: &Look, room: &str) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	let now = n.clock.now().await.unwrap_or(0.0);
	let fs = fuels(&w);
	let fuel = l.pack.iter().find(|i| has(&fs, j::s(i, "proto")));
	if let Some(fire) = beacon_of(&w, &def) {
		if fire_low(n, &w, fire, now, 2.0).await? {
			match fuel {
				None => { if gather(n, l, &fs).await? { return Ok(true); } }
				Some(f) => {
					if !travel(n, l, j::s(fire, "room")).await? { return Ok(true); }
					let fxy = (j::n(fire, "x"), j::n(fire, "y"));
					if dist_to(l.xy(), &Rect::cell(fxy.0, fxy.1)) <= 1.0 { n.act(&format!("put {} in {}", j::s(f, "name"), first_alias(fire))).await?; } else { next_to(n, l, fxy).await?; }
					return Ok(true);
				}
			}
		}
	}
	if !travel(n, l, room).await? { return Ok(true); }
	let Some(g) = j::opt(&w, "garden").cloned() else { return Ok(false) };
	let dry = all_of(&n.space.read_all(&tmpl("Bed", obj! { "room" => room, "kind" => "gemein" }), None).await?).into_iter()
		.find(|b| j::a(b, "plants").iter().any(|p| j::n(p, "stage") < 2.0) && now - j::n(b, "wateredWorldMs") > j::n(&g, "thirstWorldMs") * 0.6 * n.clock.patience());
	let Some(dry) = dry else { return Ok(false) };
	if l.count(j::s(&g, "can")) > 0 {
		let (r, broom) = at_rect(&dry);
		if !beside_of(n, l, &r, &broom, 1.0).await? { n.act("gieße").await?; }
		return Ok(true);
	}
	let Some(barrel) = n.space.read_all(&tmpl("Building", obj! { "room" => room, "plan" => j::at(&g, "barrel").clone() }), None).await?.first().map(|e| fields(e).clone()) else { return Ok(false) };
	let (r, broom) = at_rect(&barrel);
	if !beside_of(n, l, &r, &broom, 1.0).await? { n.act("schöpfe").await?; }
	Ok(true)
}

/// For `name_of` users elsewhere.
pub fn proto_label(w: &Json, proto: &str) -> String { name_of(w, proto) }
