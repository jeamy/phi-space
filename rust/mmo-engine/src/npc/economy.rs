//! The people of the archipelago (`server/npc/economy.ts`, docs/welt.en.md): script NPCs that gather, keep fires, craft,
//! trade and talk. They act only by typing the commands a player types, so every exchange of theirs is a player's
//! exchange. A round looks at the world once, types at most one or two commands and rests a few game seconds.
//!
//!   sammler     gathers what washes up in its home rooms and sells it at its market
//!   huter       keeps its island's fire burning; gathers or buys wood for it
//!   haendler    travels between the markets of its route; buys cheap, sells dear
//!   handwerker  gathers and buys the inputs of its recipes, crafts, sells what it made
//!   plauderer   walks about, tells what it knows: prices, fires, orders, stories
//!   gaertnerin  looks for seeds in the wild flora of its rooms, sells them at its market
use std::collections::HashMap;

use phi_json::{obj, Json};

use super::scripts::{by_person, humans_in, pick_line, self_of, Heard};
use super::settlers::Deliverer;
use super::{lot_ask, pick, stock_prices, Npc};
use crate::commands::cart::train_in;
use crate::context::stem;
use crate::fire::{flame_of, key_text as txt};
use crate::j;
use crate::js;
use crate::liner::{bays_of, liner_of, ship_comes};
use crate::regions::region_of_room;
use crate::source::random_int;
use crate::space::{fields, tmpl, Result};
use crate::world::way_to;

fn nt(n: f64) -> String { phi_json::number_text(n) }
fn plural(n: f64, one: &str, many: &str) -> String { format!("{} {}", nt(n), if n == 1.0 { one } else { many }) }
fn rand(n: f64) -> f64 { random_int(0.0, n) }
fn rooms_has(list: &[Json], room: &str) -> bool { list.iter().any(|r| r.as_str() == Some(room)) }
fn by_at(a: &Json, b: &Json, id: &str) -> std::cmp::Ordering { j::n(a, "at").total_cmp(&j::n(b, "at")).then_with(|| js::locale_compare(j::s(a, id), j::s(b, id))) }

/// The smallest fuel's burn time (`Math.min(...Object.values(w.fire.fuel))`).
pub fn min_fuel(w: &Json) -> f64 { j::entries(j::at(j::at(w, "fire"), "fuel")).map(|(_, v)| v.as_f64().unwrap_or(f64::NAN)).fold(f64::INFINITY, f64::min) }
/// The fuels' prototypes.
pub fn fuels(w: &Json) -> Vec<String> { j::entries(j::at(j::at(w, "fire"), "fuel")).map(|(k, _)| k.to_owned()).collect() }
pub fn beacon_of<'a>(w: &'a Json, def: &Json) -> Option<&'a Json> { j::a(w, "beacons").iter().find(|b| j::at(b, "beaconId") == j::at(def, "beacon")) }
pub fn first_alias(b: &Json) -> String { j::a(b, "aliases").first().and_then(Json::as_str).unwrap_or("feuer").to_owned() }
fn island(w: &Json, room: &str) -> Option<String> { j::by(j::a(w, "rooms"), "roomId", room).and_then(|r| j::so(r, "island")).map(str::to_owned) }
fn ground_of(w: &Json, room: &str) -> Vec<String> { j::by(j::a(w, "rooms"), "roomId", room).map(|r| j::a(r, "ground").iter().filter_map(Json::as_str).map(str::to_owned).collect()).unwrap_or_default() }
/// The tile at x, y ("~" outside).
pub fn tile(ground: &[String], x: f64, y: f64) -> String {
	if x < 0.0 || y < 0.0 { return "~".into(); }
	ground.get(y as usize).and_then(|row| row.encode_utf16().nth(x as usize)).map_or_else(|| "~".into(), |u| String::from_utf16_lossy(&[u]))
}
pub fn homes_of(def: &Json, fallback: &str) -> Vec<String> { j::ao(def, "home").map_or_else(|| vec![fallback.to_owned()], |h| j::strs(h).into_iter().map(str::to_owned).collect()) }

/// One round of a trader or a worker.
fn round(n: &Npc) -> f64 { n.pace(8_000.0, 200.0) }
/// `rest`: the pace above while a person is on the NPC's island, almost four times longer while nobody is.
pub async fn rest(n: &Npc, room: &str) -> Result<f64> {
	let w = n.w();
	let live: Vec<String> = n.space.read_all(&obj! { "type" => "Session" }, None).await?.iter().map(|e| txt(j::at(fields(e), "charId"))).filter(|id| !id.starts_with("npc-")).collect();
	if !live.is_empty() {
		let here = island(&w, room);
		if n.space.read_all(&obj! { "type" => "Character" }, None).await?.iter().map(fields).any(|c| live.iter().any(|l| l == j::s(c, "charId")) && island(&w, j::s(c, "room")) == here) { return Ok(round(n)); }
	}
	Ok(n.pace(30_000.0, 800.0))
}

/// What the NPC sees this round: itself, its pack, what lies in its room and its lots on the boards.
pub struct Look { pub me: Json, pub pack: Vec<Json>, pub ground: Vec<Json>, pub listed: HashMap<String, f64> }
impl Look {
	pub fn room(&self) -> &str { j::s(&self.me, "room") }
	pub fn xy(&self) -> (f64, f64) { (j::n(&self.me, "x"), j::n(&self.me, "y")) }
	pub fn count(&self, proto: &str) -> usize { self.pack.iter().filter(|i| j::s(i, "proto") == proto).count() }
}
pub async fn look(n: &Npc) -> Result<Option<Look>> {
	let Some(me) = self_of(n).await? else { return Ok(None) };
	if j::truthy(j::at(&me, "aboard")) { return Ok(None); }
	let pack = n.space.read_all(&tmpl("Item", obj! { "location" => j::at(&me, "charId").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let ground = n.space.read_all(&tmpl("Item", obj! { "location" => j::at(&me, "room").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	let mut listed: HashMap<String, f64> = HashMap::new();
	let w = n.w();
	for x in n.space.read_all(&tmpl("Listing", obj! { "seller" => j::at(&me, "charId").clone() }), None).await? {
		let x = fields(&x);
		if let Some(p) = proto_of(&w, j::s(x, "itemName")) { *listed.entry(p).or_insert(0.0) += j::no(x, "count").unwrap_or(1.0); }
	}
	Ok(Some(Look { me, pack, ground, listed }))
}

fn base_price(def: &Json, proto: &str) -> (f64, f64) {
	let p = j::a(j::at(def, "prices"), proto);
	if p.is_empty() { return (0.0, 0.0); }
	(p.first().and_then(Json::as_f64).unwrap_or(0.0), p.get(1).and_then(Json::as_f64).unwrap_or(0.0))
}
fn has_price(def: &Json, proto: &str) -> bool { j::opt(j::at(def, "prices"), proto).is_some() }
fn keep_of(def: &Json, proto: &str) -> f64 { j::a(def, "carry").iter().find(|c| j::s(c, "proto") == proto).map_or(2.0, |c| j::n(c, "count")) }
fn stock(l: &Look, proto: &str) -> f64 { l.count(proto) as f64 + l.listed.get(proto).copied().unwrap_or(0.0) }
/// `pricesOf`: its prices for `proto` by its list, and with what it carries by its stock.
fn prices_of(def: &Json, proto: &str, l: Option<&Look>) -> (f64, f64) {
	let base = base_price(def, proto);
	let Some(l) = l else { return base };
	stock_prices(base, stock(l, proto), keep_of(def, proto))
}
fn currency(w: &Json) -> &str { j::s(w, "currency") }
fn buy_price(w: &Json, def: &Json, proto: &str, l: Option<&Look>) -> f64 { if proto == currency(w) { 1.0 } else { prices_of(def, proto, l).0 } }
/// `lotBid`: what it pays for a lot of `count` at once, each piece at the price its stock would have with the ones before it.
fn lot_bid(w: &Json, def: &Json, proto: &str, l: &Look, count: f64) -> f64 {
	if proto == currency(w) { return count; }
	let (base, keep, s) = (base_price(def, proto), keep_of(def, proto), stock(l, proto));
	let mut sum = 0.0;
	let mut i = 0.0;
	while i < count { sum += stock_prices(base, s + i, keep).0; i += 1.0; }
	sum
}
fn sell_price(w: &Json, def: &Json, proto: &str, l: Option<&Look>) -> f64 { if proto == currency(w) { 1.0 } else { prices_of(def, proto, l).1 } }
fn coins_of(w: &Json, l: &Look) -> usize { l.count(currency(w)) }
fn proto_name(w: &Json, proto: &str) -> String { j::by(j::a(w, "prototypes"), "key", proto).map_or_else(|| proto.to_owned(), |p| txt(j::at(p, "name"))) }
/// `protoOf`: the prototype a player means by a name (also another form: "münzen").
pub fn proto_of(w: &Json, name: &str) -> Option<String> {
	let n = js::trim(name).to_lowercase();
	let all = |p: &Json| -> Vec<String> { let mut v = vec![j::s(p, "key").to_owned(), j::s(p, "name").to_lowercase()]; v.extend(j::strs(j::a(p, "aliases")).into_iter().map(str::to_owned)); v };
	let ps = j::a(w, "prototypes");
	ps.iter().find(|p| all(p).contains(&n)).or_else(|| { let sn = stem(&n); ps.iter().find(|p| all(p).iter().any(|s| stem(s) == sn)) }).map(|p| j::s(p, "key").to_owned())
}
fn room_name(w: &Json, room: &str) -> String { j::by(j::a(w, "rooms"), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
fn island_of(w: &Json, room: &str) -> String { island(w, room).unwrap_or_else(|| j::s(w, "title").to_owned()) }

/// `travel`: one step of the way to `room`; true when the NPC is there already.
pub async fn travel(n: &Npc, l: &Look, room: &str) -> Result<bool> {
	if l.room() == room { return Ok(true); }
	if by_ship(n, l, room).await? || by_train(n, l, room).await? { return Ok(false); }
	let exit = way_to(&n.w(), l.room(), room);
	if let Some(e) = &exit { n.act(&format!("go {e}")).await?; }
	Ok(exit.is_none())
}

const SHIP_SAVES: f64 = 2.0;
const SHIP_PURSE: f64 = 3.0;
const TRAIN_FROM: f64 = 2.0;

fn tried_here(n: &Npc, room: &str) -> Option<u32> {
	let mut b = n.boarding.borrow_mut();
	if b.as_ref().is_some_and(|(r, _)| r != room) { *b = None; }
	b.as_ref().map(|(_, t)| *t)
}
fn tried_once_more(n: &Npc, room: &str) { let mut b = n.boarding.borrow_mut(); let t = b.as_ref().map_or(0, |(_, t)| *t); *b = Some((room.to_owned(), t + 1)); }

/// `byShip`: the large ship on a way to another island, when it saves SHIP_SAVES rooms; it never waits for the ship.
async fn by_ship(n: &Npc, l: &Look, room: &str) -> Result<bool> {
	let w = n.w();
	let Some(d) = j::opt(&w, "liner").filter(|d| j::truthy(d)) else { return Ok(false) };
	let here_island = island(&w, l.room());
	if here_island == island(&w, room) || (coins_of(&w, l) as f64) < j::n(d, "fare") + SHIP_PURSE { return Ok(false); }
	let bays = bays_of(j::a(&w, "rooms"));
	let to = island(&w, room);
	let Some(bay) = to.as_ref().and_then(|t| bays.iter().find(|(i, _)| i == t)).map(|(_, r)| j::s(r, "roomId").to_owned()) else { return Ok(false) };
	if bays.iter().find(|(i, _)| Some(i) == here_island.as_ref()).map(|(_, r)| j::s(r, "roomId")) != Some(l.room()) { return Ok(false); }
	let tried = tried_here(n, l.room());
	if tried.is_some_and(|t| t >= 2) { return Ok(false); }
	let Some(t) = liner_of(&w) else { return Ok(false) };
	let Some(here) = t.stops.iter().position(|x| x.room == l.room()) else { return Ok(false) };
	if ship_comes(&t, n.clock.now().await.unwrap_or(0.0), here) != 0.0 || hops(&w, &bay, room) + SHIP_SAVES > hops(&w, l.room(), room) { return Ok(false); }
	tried_once_more(n, l.room());
	n.act(&format!("einschiffen {}", to.unwrap_or_default())).await?;
	Ok(true)
}

/// `hops`: rooms on the shortest way over the exits, or Infinity.
pub fn hops(w: &Json, from: &str, to: &str) -> f64 {
	let mut at = from.to_owned();
	let mut k = 0.0;
	let rooms = j::a(w, "rooms").len() as f64;
	while at != to {
		let Some(name) = way_to(w, &at, to) else { return f64::INFINITY };
		let Some(e) = j::a(w, "exits").iter().find(|x| j::s(x, "room") == at && j::s(x, "name") == name) else { return f64::INFINITY };
		k += 1.0;
		if k > rooms { return f64::INFINITY; }
		at = j::s(e, "destination").to_owned();
	}
	k
}

/// `byTrain`: the island railway on a long way; it never waits for the train.
async fn by_train(n: &Npc, l: &Look, room: &str) -> Result<bool> {
	let w = n.w();
	let d = j::opt(&w, "rail").filter(|d| j::truthy(d)).cloned();
	let tried = tried_here(n, l.room());
	let Some(d) = d else { return Ok(false) };
	if tried.is_some_and(|t| t >= 2) || island(&w, l.room()) != island(&w, room) || (coins_of(&w, l) as f64) < j::n(&d, "fare") || hops(&w, l.room(), room) < TRAIN_FROM { return Ok(false); }
	if train_in(n.clock.now().await.unwrap_or(0.0), j::no(&d, "everyWorldMs")) != 0.0 { return Ok(false); }
	let station = |r: String| { let plan = j::at(&d, "plan").clone(); async move { Ok::<_, crate::space::Error>(n.space.read_all(&tmpl("Building", obj! { "plan" => plan, "room" => r }), None).await?.first().map(|e| fields(e).clone())) } };
	let Some(here) = station(l.room().to_owned()).await? else { return Ok(false) };
	if station(room.to_owned()).await?.is_none() { return Ok(false); }
	if step_beside(n, l, &Rect::of(&here), 1.0).await? { return Ok(true); }
	tried_once_more(n, l.room());
	n.act(&format!("zug {}", room_name(&w, room))).await?;
	Ok(true)
}

#[derive(Clone, Copy, Debug)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }
impl Rect {
	pub fn of(f: &Json) -> Self { Self { x: j::n(f, "x"), y: j::n(f, "y"), w: j::n(f, "w"), h: j::n(f, "h") } }
	pub fn cell(x: f64, y: f64) -> Self { Self { x, y, w: 1.0, h: 1.0 } }
}
/// `distTo`: cells from `p` to the nearest cell of `r` (0 inside it).
pub fn dist_to(p: (f64, f64), r: &Rect) -> f64 { (r.x - p.0).max(0.0).max(p.0 - (r.x + r.w - 1.0)).max((r.y - p.1).max(0.0).max(p.1 - (r.y + r.h - 1.0))) }

/// `stepBeside`: walks to a free cell right beside `r`; false when it stands within `reach` already (or finds none).
pub async fn step_beside(n: &Npc, l: &Look, r: &Rect, reach: f64) -> Result<bool> {
	let d = dist_to(l.xy(), r);
	if d <= reach && d > 0.0 { return Ok(false); }
	let w = n.w();
	let ground = ground_of(&w, l.room());
	let mut busy: Vec<String> = n.space.read_all(&tmpl("Character", obj! { "room" => l.room() }), None).await?.iter().map(|e| format!("{},{}", nt(j::n(fields(e), "x")), nt(j::n(fields(e), "y")))).collect();
	busy.extend(n.space.read_all(&tmpl("Plot", obj! { "room" => l.room() }), None).await?.iter().map(|e| format!("{},{}", nt(j::n(fields(e), "x")), nt(j::n(fields(e), "y")))));
	let mut y = r.y - 1.0;
	while y <= r.y + r.h {
		let mut x = r.x - 1.0;
		while x <= r.x + r.w {
			if dist_to((x, y), r) == 1.0 && !busy.contains(&format!("{},{}", nt(x), nt(y))) && ",.:".contains(tile(&ground, x, y).as_str()) {
				n.act(&format!("move {} {}", nt(x), nt(y))).await?;
				return Ok(true);
			}
			x += 1.0;
		}
		y += 1.0;
	}
	Ok(false)
}

/// `gather`: picks up the nearest thing of `protos` lying here (walks to it first); true when it did something.
pub async fn gather(n: &Npc, l: &Look, protos: &[String]) -> Result<bool> {
	let me = l.xy();
	let d = |i: &Json| (j::n(i, "x") - me.0).abs().max((j::n(i, "y") - me.1).abs());
	let mut there: Vec<&Json> = l.ground.iter().filter(|i| protos.iter().any(|p| p == j::s(i, "proto"))).collect();
	there.sort_by(|a, b| d(a).total_cmp(&d(b)));
	let Some(t) = there.first() else { return Ok(false) };
	if d(t) <= 1.0 { n.act(&format!("get {}", j::s(t, "name"))).await?; } else { n.act(&format!("move {} {}", nt(j::n(t, "x")), nt(j::n(t, "y")))).await?; }
	Ok(true)
}

fn at_market(w: &Json, room: &str) -> bool { rooms_has(j::a(j::at(w, "market"), "rooms"), room) }
async fn board(n: &Npc, room: &str) -> Result<Vec<Json>> {
	let mut b: Vec<Json> = n.space.read_all(&tmpl("Listing", obj! { "room" => room }), None).await?.iter().map(|e| fields(e).clone()).collect();
	b.sort_by(|a, b| by_at(a, b, "listingId"));
	Ok(b)
}

/// `sell`: at a market, one carried thing it sells on the board (at most three of its own hang there).
async fn sell(n: &Npc, l: &Look, except: &[String]) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	if !at_market(&w, l.room()) { return Ok(false); }
	let listings = n.space.read_all(&tmpl("Listing", obj! { "room" => l.room() }), None).await?;
	if listings.iter().filter(|x| j::at(fields(x), "seller") == j::at(&l.me, "charId")).count() >= 3 { return Ok(false); }
	let Some(item) = l.pack.iter().find(|i| { let p = j::s(i, "proto"); p != currency(&w) && sell_price(&w, &def, p, Some(l)) > 0.0 && !except.iter().any(|x| x == p) }) else { return Ok(false) };
	n.act(&format!("market biete {} für {}", j::s(item, "name"), nt(sell_price(&w, &def, j::s(item, "proto"), Some(l))))).await?;
	Ok(true)
}

/// `buy`: at a market, the first thing on the board it pays at least the price for, unless it holds four of it.
async fn buy(n: &Npc, l: &Look, only: Option<&[String]>) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	if !at_market(&w, l.room()) { return Ok(false); }
	let listings = board(n, l.room()).await?;
	let coins = coins_of(&w, l) as f64;
	let i = listings.iter().position(|x| {
		let Some(p) = proto_of(&w, j::s(x, "itemName")) else { return false };
		let price = j::n(x, "price");
		j::at(x, "seller") != j::at(&l.me, "charId") && only.is_none_or(|o| o.contains(&p)) && price <= lot_bid(&w, &def, &p, l, j::no(x, "count").unwrap_or(1.0)) && price <= coins && l.count(&p) < 4
	});
	let Some(i) = i else { return Ok(false) };
	n.act(&format!("market kaufe {}", i + 1)).await?;
	Ok(true)
}

/// `answerWanted`: at a market, answers the wanted notices of what it sells: delivers when they pay its price and it
/// carries enough (its own lot taken back first), else says once it has none; one that pays less it answers once with
/// its price.
pub async fn answer_wanted(n: &Npc, l: &Look) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	if !at_market(&w, l.room()) { return Ok(false); }
	let mut sought: Vec<Json> = n.space.read_all(&tmpl("Wanted", obj! { "room" => l.room() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	sought.sort_by(|a, b| by_at(a, b, "wantedId"));
	let me = j::at(&l.me, "charId").clone();
	for (i, wd) in sought.iter().enumerate() {
		if j::at(wd, "buyer") == &me { continue; }
		let proto = j::s(wd, "proto");
		let each = if proto == currency(&w) { 0.0 } else { sell_price(&w, &def, proto, Some(l)) };
		if each == 0.0 { continue; }
		let count = j::no(wd, "count").unwrap_or(1.0);
		let ask = lot_ask(&w, proto, has_price(&def, proto).then(|| prices_of(&def, proto, Some(l))).or(Some(prices_of(&def, proto, Some(l)))), count);
		let replies = j::a(wd, "replies");
		if j::n(wd, "price") >= ask {
			let carried = l.count(proto) as f64;
			if carried < count {
				let b = board(n, l.room()).await?;
				if let Some(own) = b.iter().position(|x| j::at(x, "seller") == &me && proto_of(&w, j::s(x, "itemName")).as_deref() == Some(proto) && carried + j::no(x, "count").unwrap_or(1.0) >= count) {
					n.act(&format!("market zurück {}", own + 1)).await?;
					return Ok(true);
				}
				if replies.iter().any(|r| j::at(r, "charId") == &me && j::n(r, "ask") == 0.0) { continue; }
				n.act(&format!("market antworte {} keins", i + 1)).await?;
				return Ok(true);
			}
			n.act(&format!("market liefere {} für {}", i + 1, nt(ask))).await?;
			return Ok(true);
		}
		if replies.iter().any(|r| j::at(r, "charId") == &me) { continue; }
		n.act(&format!("market antworte {} ab {}", i + 1, nt(ask))).await?;
		return Ok(true);
	}
	Ok(false)
}

fn capital(s: &str) -> String { let mut c = s.chars(); c.next().map_or_else(String::new, |f| f.to_uppercase().chain(c).collect()) }

/// `answerOffers`: the oldest trade offer made to it, by its price list; a gift it takes with thanks.
async fn answer_offers(n: &Npc, l: &Look) -> Result<bool> {
	let w = n.w();
	let def = n.def();
	let mut all: Vec<Json> = n.space.read_all(&tmpl("Offer", obj! { "to" => j::at(&l.me, "charId").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
	all.sort_by(|a, b| j::n(a, "at").total_cmp(&j::n(b, "at")));
	let Some(o) = all.into_iter().next() else { return Ok(false) };
	let mut gets: Vec<Json> = Vec::new();
	for id in j::a(&o, "give") { if let Some(e) = n.space.read_if_exists(&tmpl("Item", obj! { "itemId" => id.clone() }), 1_000.0, None).await? { gets.push(fields(&e).clone()); } }
	let from = j::s(&o, "fromName").to_owned();
	let want = j::a(&o, "want");
	if want.is_empty() {
		n.act(&format!("accept {from}")).await?;
		n.act(&format!("say Danke, {from}! Das kann ich gut brauchen.")).await?;
		return Ok(true);
	}
	let mut kinds: Vec<(String, f64)> = Vec::new();
	for i in &gets { let p = j::s(i, "proto"); match kinds.iter_mut().find(|(k, _)| k == p) { Some(x) => x.1 += 1.0, None => kinds.push((p.to_owned(), 1.0)) } }
	let worth: f64 = kinds.iter().map(|(p, k)| lot_bid(&w, &def, p, l, *k)).sum();
	let (mut asked, mut missing, mut not_mine) = (0.0, String::new(), String::new());
	for x in want {
		let p = proto_of(&w, j::s(x, "name"));
		let price = p.as_deref().map_or(0.0, |p| sell_price(&w, &def, p, Some(l)));
		let Some(p) = p.filter(|p| p == currency(&w) || price != 0.0) else { if not_mine.is_empty() { not_mine = j::s(x, "name").to_owned(); } continue };
		let k = j::n(x, "count");
		if (l.count(&p) as f64) < k && missing.is_empty() { missing = proto_name(&w, &p); }
		asked += if p == currency(&w) { k } else { lot_ask(&w, &p, Some(prices_of(&def, &p, Some(l))), k) };
	}
	if !not_mine.is_empty() { n.act(&format!("decline {from}")).await?; n.act(&format!("say {from}, {not_mine} gebe ich nicht her.")).await?; return Ok(true); }
	if !missing.is_empty() { n.act(&format!("decline {from}")).await?; n.act(&format!("say {from}, {missing} habe ich gerade nicht.")).await?; return Ok(true); }
	if worth >= asked && worth > 0.0 {
		n.act(&format!("accept {from}")).await?;
		n.act(&format!("say Abgemacht, {from}.")).await?;
		return Ok(true);
	}
	n.act(&format!("decline {from}")).await?;
	let names: Vec<(String, f64)> = gets.iter().map(|i| (j::s(i, "name").to_owned(), 1.0)).collect();
	let wants: Vec<(String, f64)> = want.iter().map(|x| (capital(j::s(x, "name")), j::n(x, "count"))).collect();
	let coins_asked = want.iter().all(|x| proto_of(&w, j::s(x, "name")).as_deref() == Some(currency(&w)));
	let fair = if gets.is_empty() { "Davon halte ich nichts".to_owned() }
		else if coins_asked { format!("Für {} gebe ich höchstens {}", crate::commands::trade::counted(&names), plural(worth, "Münze", "Münzen")) }
		else {
			let offered = if gets.iter().all(|i| j::s(i, "proto") == currency(&w)) { plural(worth, "Münze", "Münzen") } else { format!("{}, mir höchstens {} wert", crate::commands::trade::counted(&names), plural(worth, "Münze", "Münzen")) };
			format!("Für {} verlange ich {}, du bietest {offered}", crate::commands::trade::counted(&wants), plural(asked, "Münze", "Münzen"))
		};
	n.act(&format!("say {from}, das ist mir zu wenig. {fair}.")).await?;
	Ok(true)
}

/// `tradeTalk`: what it buys and sells, said to someone who asked.
fn trade_talk(w: &Json, def: &Json, to: &str, l: Option<&Look>) -> String {
	let prices: Vec<(String, (f64, f64))> = j::entries(j::at(def, "prices")).map(|(p, _)| (p.to_owned(), prices_of(def, p, l))).collect();
	let buys: Vec<String> = prices.iter().filter(|(_, (b, _))| *b > 0.0).map(|(p, (b, _))| format!("{} (bis {})", proto_name(w, p), nt(*b))).collect();
	let sells: Vec<String> = prices.iter().filter(|(_, (_, s))| *s > 0.0).map(|(p, (_, s))| format!("{} ({})", proto_name(w, p), nt(*s))).collect();
	let lots = prices.iter().any(|(p, (_, s))| *s > 1.0 && lot_ask(w, p, has_price(def, p).then(|| base_price(def, p)), 2.0) < 2.0 * s);
	if buys.is_empty() && sells.is_empty() { return format!("{to}, {}", pick_line(def).unwrap_or_else(|| "schön, dich zu sehen.".into())); }
	let parts = [
		format!("{to},"),
		if buys.is_empty() { String::new() } else { format!("ich kaufe {}", buys.join(", ")) },
		if !buys.is_empty() && !sells.is_empty() { "und".into() } else { String::new() },
		if sells.is_empty() { String::new() } else { format!("verkaufe {}{}", sells.join(", "), if lots { " (bei Tieren kostet jedes weitere eine Münze weniger)" } else { "" }) },
		format!("– in Münzen, je nach Vorrat. Biete mir etwas an: offer <ding> an {} für <n> münze.", j::s(def, "name")),
	];
	parts.into_iter().filter(|p| !p.is_empty()).collect::<Vec<_>>().join(" ")
}

/// What one say carries (MAX_SAY of the say command; it cuts the rest).
const SAY_MAX: usize = 300;

/// `sayParts`: a text longer than one say, cut at spaces into says of at most `max` UTF-16 units; each part after the
/// first begins with `lead` (whom it is said to) and "…" (a word longer than a say on its own, which a trade list never
/// has, is cut by the say command).
pub fn say_parts(text: &str, max: usize, lead: &str) -> Vec<String> {
	let len = |t: &str| t.encode_utf16().count();
	if len(text) <= max { return vec![text.to_owned()]; }
	let more = if lead.is_empty() { "…".to_owned() } else { format!("{lead} …") };
	let mut parts: Vec<String> = vec![];
	let mut cur = String::new();
	for word in text.split(' ').filter(|w| !w.is_empty()) {
		if !cur.is_empty() && cur != more && len(&cur) + 1 + len(word) > max {
			parts.push(std::mem::replace(&mut cur, more.clone()));
		}
		if !cur.is_empty() { cur.push(' '); }
		cur.push_str(word);
	}
	if !cur.is_empty() && cur != more { parts.push(cur); }
	parts
}

/// `social`: offers first, then whoever spoke to it. True when it did something.
#[derive(Default)]
pub struct Social { heard: Heard, greeted: HashMap<String, f64> }
impl Social {
	pub async fn run(&mut self, n: &Npc, l: &Look) -> Result<bool> {
		if answer_offers(n, l).await? { return Ok(true); }
		let def = n.def();
		let w = n.w();
		let said: Vec<Json> = self.heard.since(n, &l.me).await?.into_iter().filter(by_person).collect();
		let name = j::s(&def, "name").to_lowercase();
		if let Some(m) = said.iter().find(|m| j::s(m, "text").to_lowercase().contains(&name)) {
			let from = j::s(m, "from");
			let text = if j::s(&def, "script") == "plauderer" { format!("{from}, {}", pick_line(&def).unwrap_or_else(|| "ja?".into())) } else { trade_talk(&w, &def, from, Some(l)) };
			for part in say_parts(&text, SAY_MAX, &format!("{from},")) {
				n.act(&format!("say {part}")).await?;
			}
			return Ok(true);
		}
		let wnow = n.now().await;
		let hello = said.iter().find(|m| js::re(r"\b(hallo|hi|moin|servus|hello|hey)\b", "i").test(j::s(m, "text")) && wnow - self.greeted.get(j::s(m, "from")).copied().unwrap_or(f64::NEG_INFINITY) > 10.0 * 60_000.0);
		if let Some(h) = hello {
			if rand(3.0) == 0.0 {
				let from = j::s(h, "from").to_owned();
				self.greeted.insert(from.clone(), wnow);
				n.act(&format!("say Moin, {from}.")).await?;
				return Ok(true);
			}
		}
		Ok(false)
	}
}

/// `pitcher`: offers a person here coins for something it buys and they carry.
#[derive(Default)]
pub struct Pitcher { pitched: HashMap<String, f64> }
impl Pitcher {
	pub async fn run(&mut self, n: &Npc, l: &Look, protos: Option<&[String]>) -> Result<bool> {
		if n.space.count(&tmpl("Offer", obj! { "from" => j::at(&l.me, "charId").clone() }), None).await? > 0.0 { return Ok(false); }
		let people = humans_in(n, l.room()).await?;
		if people.is_empty() { return Ok(false); }
		let w = n.w();
		let def = n.def();
		let coins = coins_of(&w, l) as f64;
		let wnow = n.now().await;
		for ch in n.space.read_all(&tmpl("Character", obj! { "room" => l.room() }), None).await?.iter().map(fields).filter(|c| people.iter().any(|p| p == j::s(c, "name"))) {
			let cid = j::s(ch, "charId");
			let theirs = n.space.read_all(&tmpl("Item", obj! { "location" => cid }), None).await?;
			let want = theirs.iter().map(fields).find(|i| {
				let p = j::s(i, "proto");
				let price = buy_price(&w, &def, p, Some(l));
				protos.is_none_or(|ps| ps.iter().any(|x| x == p)) && price > 0.0 && p != currency(&w) && price <= coins && wnow - self.pitched.get(&format!("{cid}:{p}")).copied().unwrap_or(f64::NEG_INFINITY) > 10.0 * 60_000.0
			});
			let Some(want) = want else { continue };
			let p = j::s(want, "proto");
			self.pitched.insert(format!("{cid}:{p}"), wnow);
			let price = buy_price(&w, &def, p, Some(l));
			let cname = j::s(ch, "name");
			n.act(&format!("offer {} münze an {cname} für {}", nt(price), j::s(want, "name").to_lowercase())).await?;
			n.act(&format!("say {cname}, für dein {} zahle ich {}. „accept {}“, wenn du einverstanden bist.", j::s(want, "name"), plural(price, "Münze", "Münzen"), j::s(&def, "name"))).await?;
			return Ok(true);
		}
		Ok(false)
	}
}

/// `chatter`: now and then a line of its own, while people are there to hear it.
pub struct Chatter { every: f64, last: Option<f64> }
impl Chatter {
	pub fn new(every: f64) -> Self { Self { every, last: None } }
	pub async fn run(&mut self, n: &Npc, l: &Look) -> Result<bool> {
		let wnow = n.now().await;
		let every = self.every;
		let last = *self.last.get_or_insert_with(|| wnow - rand(every));
		let def = n.def();
		if wnow - last < every || j::a(&def, "lines").is_empty() { return Ok(false); }
		self.last = Some(wnow);
		if humans_in(n, l.room()).await?.is_empty() { return Ok(false); }
		n.act(&format!("say {}", pick_line(&def).unwrap_or_default())).await?;
		Ok(true)
	}
}

fn goods_sold(def: &Json) -> Vec<String> { j::entries(j::at(def, "prices")).filter(|(_, v)| v.as_array().and_then(|a| a.get(1)).and_then(Json::as_f64).unwrap_or(0.0) > 0.0).map(|(p, _)| p.to_owned()).collect() }

/// `sammler`.
pub struct Sammler { talk: Social, say: Chatter, carry: Deliverer, home: usize }
impl Default for Sammler { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(3.0 * 60_000.0), carry: Deliverer::default(), home: 0 } } }
impl Sammler {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let def = n.def();
		let goods = goods_sold(&def);
		let homes = homes_of(&def, l.room());
		let carried = l.pack.iter().filter(|i| goods.iter().any(|g| g == j::s(i, "proto"))).count();
		let market = j::so(&def, "market").map(str::to_owned);
		let done = self.talk.run(n, &l).await? || self.say.run(n, &l).await? || self.carry.run(n, &l, &homes).await?;
		if !done {
			let here = homes.iter().any(|h| h == l.room());
			let to_sell = carried >= 3 || (carried > 0 && !l.ground.iter().any(|i| goods.iter().any(|g| g == j::s(i, "proto"))) && !here);
			if let (true, Some(m)) = (to_sell, &market) {
				if travel(n, &l, m).await? && !sell(n, &l, &[]).await? { self.home = (self.home + 1) % homes.len(); travel(n, &l, &homes[self.home]).await?; }
			} else if !here { travel(n, &l, &homes[self.home]).await?; }
			else if !gather(n, &l, &goods).await? {
				if let (true, Some(m)) = (carried > 0, &market) { travel(n, &l, m).await?; }
				else { self.home = (self.home + 1) % homes.len(); travel(n, &l, &homes[self.home]).await?; }
			}
		}
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

/// `nextTo`: walks to a free cell next to `at` (a fire).
pub async fn next_to(n: &Npc, l: &Look, at: (f64, f64)) -> Result<()> {
	let ground = ground_of(&n.w(), l.room());
	let busy: Vec<String> = n.space.read_all(&tmpl("Character", obj! { "room" => l.room() }), None).await?.iter().map(|e| format!("{},{}", nt(j::n(fields(e), "x")), nt(j::n(fields(e), "y")))).collect();
	for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0), (1.0, 1.0), (-1.0, 1.0), (1.0, -1.0), (-1.0, -1.0)] {
		let (x, y) = (at.0 + dx, at.1 + dy);
		if busy.contains(&format!("{},{}", nt(x), nt(y))) || !",.:".contains(tile(&ground, x, y).as_str()) { continue; }
		n.act(&format!("move {} {}", nt(x), nt(y))).await?;
		return Ok(());
	}
	Ok(())
}

/// `huter`.
pub struct Huter { talk: Social, say: Chatter, offer: Pitcher, home: usize }
impl Default for Huter { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(4.0 * 60_000.0), offer: Pitcher::default(), home: 0 } } }
impl Huter {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let w = n.w();
		let def = n.def();
		let Some(beacon) = beacon_of(&w, &def).cloned() else { n.sleep(n.pace(60_000.0, 50.0)).await; return Ok(()) };
		let fs = fuels(&w);
		let fuel: Vec<&Json> = l.pack.iter().filter(|i| fs.iter().any(|f| f == j::s(i, "proto"))).collect();
		let f = flame_of(&n.space, j::s(&beacon, "beaconId"), None).await?;
		let now = n.clock.now().await.unwrap_or(0.0);
		let piece = min_fuel(&w) * n.clock.patience();
		let weak = f.as_ref().is_none_or(|f| j::n(f, "until") - now < piece * 3.0);
		let broom = j::s(&beacon, "room").to_owned();
		let homes = homes_of(&def, &broom);
		let bxy = (j::n(&beacon, "x"), j::n(&beacon, "y"));
		let mut acted = self.talk.run(n, &l).await?;
		if !acted && weak && !fuel.is_empty() {
			if travel(n, &l, &broom).await? {
				let me = l.xy();
				if (me.0 - bxy.0).abs().max((me.1 - bxy.1).abs()) <= 1.0 { n.act(&format!("put {} in {}", j::s(fuel[0], "name"), first_alias(&beacon))).await?; }
				else { next_to(n, &l, bxy).await?; }
			}
			acted = true;
		}
		if !acted && fuel.len() < 3 {
			acted = (homes.iter().any(|h| h == l.room()) && gather(n, &l, &fs).await?) || buy(n, &l, Some(&fs)).await? || self.offer.run(n, &l, Some(&fs)).await?;
			if !acted && fuel.is_empty() && homes.len() > 1 { self.home = (self.home + 1) % homes.len(); acted = !travel(n, &l, &homes[self.home]).await?; }
		}
		if !acted { acted = self.offer.run(n, &l, Some(&fs)).await? || self.say.run(n, &l).await?; }
		if !acted && l.room() != broom { travel(n, &l, &broom).await?; }
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

const LINGER: u32 = 3;

/// `stopFor`: the stop of its route a trader heads for when a process takes it up.
pub fn stop_for(w: &Json, route: &[String], room: &str) -> usize {
	if let Some(i) = route.iter().position(|r| r == room) { return i; }
	let here = region_of_room(w, room);
	let mine: Vec<(usize, &String)> = route.iter().enumerate().filter(|(_, r)| region_of_room(w, r) == here).collect();
	let mut all = if mine.is_empty() { route.iter().enumerate().collect() } else { mine };
	all.sort_by(|a, b| hops(w, room, a.1).total_cmp(&hops(w, room, b.1)));
	all.first().map_or(0, |x| x.0)
}

/// `haendler`.
pub struct Haendler { talk: Social, say: Chatter, offer: Pitcher, at: Option<usize>, rounds: u32, stay: (String, u32) }
impl Default for Haendler { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(3.0 * 60_000.0), offer: Pitcher::default(), at: None, rounds: 0, stay: (String::new(), 0) } } }
impl Haendler {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { self.at = None; n.sleep(1000.0).await; return Ok(()) };
		let def = n.def();
		let route: Vec<String> = j::ao(&def, "route").map_or_else(|| vec![l.room().to_owned()], |r| j::strs(r).into_iter().map(str::to_owned).collect());
		if self.at.is_none() { self.at = Some(stop_for(&n.w(), &route, l.room())); self.rounds = 0; }
		let at = self.at.unwrap_or(0);
		let target = route[at % route.len()].clone();
		if l.room() != target {
			if self.stay.0 != l.room() { self.stay = (l.room().to_owned(), 0); }
			if self.talk.run(n, &l).await? { self.stay.1 = 0; }
			else {
				let people = !humans_in(n, l.room()).await?.is_empty();
				let linger = people && { let r = self.stay.1 < LINGER; self.stay.1 += 1; r };
				if !linger { travel(n, &l, &target).await?; }
			}
			n.sleep(rest(n, l.room()).await?).await;
			return Ok(());
		}
		let acted = self.talk.run(n, &l).await? || answer_wanted(n, &l).await? || buy(n, &l, None).await? || sell(n, &l, &[]).await? || self.offer.run(n, &l, None).await? || self.say.run(n, &l).await?;
		self.rounds += 1;
		if route.len() > 1 && (self.rounds > 12 || (!acted && self.rounds > 4)) { self.at = Some(at + 1); self.rounds = 0; }
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

/// `handwerker`.
pub struct Handwerker { talk: Social, say: Chatter, offer: Pitcher }
impl Default for Handwerker { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(3.0 * 60_000.0), offer: Pitcher::default() } } }
impl Handwerker {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let w = n.w();
		let def = n.def();
		let crafts: Vec<&str> = j::strs(j::a(&def, "crafts"));
		let recipes: Vec<&Json> = j::a(&w, "recipes").iter().filter(|r| crafts.contains(&j::s(r, "key"))).collect();
		let has = |proto: &str, count: f64| l.count(proto) as f64 >= count;
		let can = recipes.iter().find(|r| j::a(r, "needs").iter().all(|x| has(j::s(x, "proto"), j::n(x, "count"))) && j::so(r, "tool").is_none_or(|t| t.is_empty() || has(t, 1.0)));
		let mut inputs: Vec<String> = Vec::new();
		for r in &recipes { for x in j::a(r, "needs") { let p = j::s(x, "proto").to_owned(); if !inputs.contains(&p) { inputs.push(p); } } }
		let products = l.pack.iter().filter(|i| recipes.iter().any(|r| j::at(r, "makes") == j::at(i, "proto")) && sell_price(&w, &def, j::s(i, "proto"), None) > 0.0).count();
		let homes = homes_of(&def, l.room());
		let market = j::so(&def, "market").map(str::to_owned);
		let mut acted = self.talk.run(n, &l).await?;
		let toolless = recipes.iter().find(|r| j::so(r, "tool").is_some_and(|t| !t.is_empty() && !has(t, 1.0)));
		let tool_recipe = toolless.and_then(|t| recipes.iter().find(|r| j::at(r, "makes") == j::at(t, "tool") && j::a(r, "needs").iter().all(|x| has(j::s(x, "proto"), j::n(x, "count")))));
		if !acted { if let Some(r) = tool_recipe.or(can) { n.act(&format!("craft {}", j::s(r, "key"))).await?; acted = true; } }
		let keep: Vec<String> = recipes.iter().filter_map(|r| j::so(r, "tool").filter(|t| !t.is_empty() && !has(t, 2.0)).map(str::to_owned)).collect();
		if !acted && market.as_deref() == Some(l.room()) { acted = answer_wanted(n, &l).await?; }
		if !acted && products >= 2 { if let Some(m) = &market { acted = if travel(n, &l, m).await? { sell(n, &l, &keep).await? } else { true }; } }
		if !acted { acted = buy(n, &l, Some(&inputs)).await? || self.offer.run(n, &l, Some(&inputs)).await?; }
		let home = homes.iter().any(|h| h == l.room());
		if !acted && home { acted = gather(n, &l, &inputs).await?; }
		if !acted && !home && !(products > 0 && market.as_deref() == Some(l.room())) { acted = !travel(n, &l, &homes[0]).await?; }
		if !acted { self.say.run(n, &l).await?; }
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

/// `gaertnerin`.
pub struct Gaertnerin { talk: Social, say: Chatter, offer: Pitcher, home: usize }
impl Default for Gaertnerin { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(3.0 * 60_000.0), offer: Pitcher::default(), home: 0 } } }
impl Gaertnerin {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let def = n.def();
		let homes = homes_of(&def, l.room());
		let market = j::so(&def, "market").map(str::to_owned);
		let mut acted = self.talk.run(n, &l).await? || (market.as_deref() == Some(l.room()) && (answer_wanted(n, &l).await? || buy(n, &l, None).await? || sell(n, &l, &[]).await?));
		if !acted {
			let resting = n.space.read_if_exists(&tmpl("SeedRest", obj! { "charId" => j::at(&l.me, "charId").clone() }), 1_000.0, None).await?.is_some();
			let pos = homes.iter().position(|h| h == l.room());
			if !resting && pos.is_some() { n.act("sammle samen").await?; self.home = (pos.unwrap_or(0) + 1) % homes.len(); acted = true; }
			else if !resting { acted = !travel(n, &l, &homes[self.home]).await?; }
			else if let Some(m) = market.as_deref().filter(|m| *m != l.room()) { acted = !travel(n, &l, m).await?; }
		}
		if !acted { acted = self.offer.run(n, &l, None).await?; }
		if !acted { self.say.run(n, &l).await?; }
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

/// `plauderer`.
pub struct Plauderer { talk: Social, say: Chatter, last_gossip: Option<f64>, home: usize }
impl Default for Plauderer { fn default() -> Self { Self { talk: Social::default(), say: Chatter::new(2.0 * 60_000.0), last_gossip: None, home: 0 } } }
impl Plauderer {
	pub async fn round(&mut self, n: &Npc) -> Result<()> {
		let Some(l) = look(n).await? else { n.sleep(1000.0).await; return Ok(()) };
		let w = n.w();
		let def = n.def();
		let wnow = n.now().await;
		let last = *self.last_gossip.get_or_insert_with(|| wnow - rand(8.0 * 60_000.0));
		let mut acted = self.talk.run(n, &l).await? || self.say.run(n, &l).await?;
		if !acted && wnow - last > 8.0 * 60_000.0 {
			self.last_gossip = Some(wnow);
			if let Some(g) = gossip(n).await? {
				let aloud = rand(2.0) != 0.0 && !humans_in(n, l.room()).await?.is_empty();
				let channel = j::a(&w, "channels").first().and_then(Json::as_str).unwrap_or("hafen").to_owned();
				n.act(&if aloud { format!("say {g}") } else { format!("kanal {channel} {g}") }).await?;
				acted = true;
			}
		}
		if !acted {
			let homes = homes_of(&def, l.room());
			if !homes.iter().any(|h| h == l.room()) { travel(n, &l, &homes[self.home]).await?; }
			else if rand(6.0) == 0.0 && homes.len() > 1 { self.home = (self.home + 1) % homes.len(); travel(n, &l, &homes[self.home]).await?; }
			else if rand(3.0) == 0.0 {
				let ground = ground_of(&w, l.room());
				let (mx, my) = l.xy();
				let x = 22f64.min(1f64.max(mx + random_int(-4.0, 5.0)));
				let y = 14f64.min(1f64.max(my + random_int(-3.0, 4.0)));
				if ",.".contains(tile(&ground, x, y).as_str()) { n.act(&format!("move {} {}", nt(x), nt(y))).await?; }
			}
		}
		n.sleep(rest(n, l.room()).await?).await;
		Ok(())
	}
}

/// `gossip`: something true about the world, told like news.
async fn gossip(n: &Npc) -> Result<Option<String>> {
	let w = n.w();
	let mut told: Vec<String> = Vec::new();
	let listings: Vec<Json> = n.space.read_all(&obj! { "type" => "Listing" }, None).await?.iter().map(|e| fields(e).clone()).collect();
	if let Some(x) = pick(&listings) {
		let c = j::no(&x, "count").unwrap_or(1.0);
		told.push(format!("Am Marktbrett in {} gibt es {}{} für {}.", room_name(&w, j::s(&x, "room")), if c > 1.0 { format!("{}× ", nt(c)) } else { String::new() }, j::s(&x, "itemName"), plural(j::n(&x, "price"), "Münze", "Münzen")));
	}
	for b in j::a(&w, "beacons") {
		let f = flame_of(&n.space, j::s(b, "beaconId"), None).await?;
		let now = n.clock.now().await.unwrap_or(0.0);
		if f.as_ref().is_none_or(|f| j::n(f, "until") <= now) { told.push(format!("Das {} auf {} ist aus – dort steigt der Nebel.", j::s(b, "name"), island_of(&w, j::s(b, "room")))); }
	}
	let orders: Vec<Json> = n.space.read_all(&obj! { "type" => "Order" }, None).await?.iter().map(|e| fields(e).clone()).filter(|o| !j::truthy(j::at(o, "takenBy"))).collect();
	if let Some(o) = pick(&orders) { told.push(format!("An der Tafel in {}: {} {} Lohn.", room_name(&w, j::s(&o, "room")), j::s(&o, "text"), plural(j::n(j::at(&o, "reward"), "count"), "Münze", "Münzen"))); }
	Ok(pick(&told))
}

#[cfg(test)]
mod tests {
	use super::say_parts;

	#[test]
	fn a_long_text_goes_in_several_says() {
		assert_eq!(say_parts("Fischerin, ich kaufe Treibholz (bis 2).", 300, "Fischerin,"), vec!["Fischerin, ich kaufe Treibholz (bis 2)."]);
		let items: Vec<String> = (0..60).map(|i| format!("Ding{i} (bis {i})")).collect();
		let text = format!("Fischerin, ich kaufe {} – in Münzen.", items.join(", "));
		let parts = say_parts(&text, 300, "Fischerin,");
		assert!(parts.len() > 1);
		assert!(parts.iter().all(|p| p.encode_utf16().count() <= 300));
		assert!(parts[1..].iter().all(|p| p.starts_with("Fischerin, … ")));
		let rest: Vec<&str> = parts[1..].iter().map(|p| &p["Fischerin, … ".len()..]).collect();
		assert_eq!([vec![parts[0].as_str()], rest].concat().join(" "), text);
	}
}
