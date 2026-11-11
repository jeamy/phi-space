//! Roads and carts (`server/engine/commands/cart.ts`): a road beside an exit links the two rooms of that exit; a cart
//! stands in a room with its cargo at `cartId`, its owner loads it and sends it along the roads a room at a time on the
//! world clock (`cart_tick`), or on a standing route between two of the owner's chests. And the island railway (`zug`):
//! rides between stations and freight.
use phi_json::{obj, Json};

use super::build::{amount, dist_to, give_back, move_item as shift_item, plan_of, Rect, ARTICLE};
use super::default::{place_in, relocate};
use super::trade::{consume, move_item};
use crate::clock::world_now_of;
use crate::context::{inventory, items_named, msg, room_of, to_player, Ctx, MsgOpts};
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::travel::count_trip;

fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }

/// Room to rooms the roads join, in the order a Map of Sets keeps them.
pub type Links = Vec<(String, Vec<String>)>;

/// `roadLinks`: a finished road links the two rooms it runs between, both ways.
pub async fn road_links(space: &Space, w: &Json, txn: Option<&str>) -> Result<Links> {
	let mut links: Links = Vec::new();
	if j::opt(w, "cart").is_none() { return Ok(links) }
	let mut link = |a: &str, b: &str| {
		let i = match links.iter().position(|(r, _)| r == a) { Some(i) => i, None => { links.push((a.to_owned(), Vec::new())); links.len() - 1 } };
		if !links[i].1.iter().any(|x| x == b) { links[i].1.push(b.to_owned()); }
	};
	// a finished road (road.rs) links the two rooms it runs between
	for (a, b) in super::road::route_links(space, txn).await? { link(&a, &b); link(&b, &a); }
	Ok(links)
}
/// `roadPath`: the rooms from `from` to `to` by road, without `from`; None when no road goes there.
pub fn road_path(links: &Links, from: &str, to: &str) -> Option<Vec<String>> {
	let mut before: Vec<(String, String)> = vec![(from.to_owned(), from.to_owned())];
	let get = |b: &[(String, String)], k: &str| b.iter().find(|(x, _)| x == k).map(|(_, v)| v.clone());
	let mut queue = vec![from.to_owned()];
	let mut i = 0;
	while i < queue.len() {
		let q = queue[i].clone();
		for n in links.iter().find(|(r, _)| *r == q).map_or(&[][..], |(_, v)| &v[..]) {
			if get(&before, n).is_some() { continue; }
			before.push((n.clone(), q.clone()));
			queue.push(n.clone());
			if n == to {
				let mut path = vec![to.to_owned()];
				let mut at = to.to_owned();
				while get(&before, &at).as_deref() != Some(from) { let b = get(&before, &at).unwrap_or_default(); path.insert(0, b.clone()); at = b; }
				return Some(path);
			}
		}
		i += 1;
	}
	None
}

/// `trainIn` (shared/rail.ts): the first half of every period the train stands at the stations; the time to it.
pub fn train_in(now: f64, every: Option<f64>) -> f64 {
	let Some(e) = every.filter(|e| *e != 0.0 && !e.is_nan()) else { return 0.0 };
	let at = now % e;
	if at < e / 2.0 { 0.0 } else { e - at }
}

fn rooms_of(w: &Json) -> &[Json] { j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")) }
fn name_of(c: &Ctx, room: &str) -> String { j::by(rooms_of(c.w()), "roomId", room).map_or_else(|| room.to_owned(), |r| txt(j::at(r, "name"))) }
async fn cargo_of(c: &Ctx, cart_id: &Json) -> Result<Vec<Json>> { Ok(c.space.read_all(&tmpl("Item", obj! { "location" => cart_id.clone() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect()) }
fn account_id(c: &Ctx) -> Json { c.account.as_ref().map_or(Json::Null, |a| j::at(a, "accountId").clone()) }

/// `mine`: the actor's cart here, taken in the transaction.
async fn mine(c: &Ctx) -> Result<Json> {
	let all = c.space.read_all(&tmpl("Cart", obj! { "room" => c.room() }), c.txn()).await?;
	let acc = account_id(c);
	let (ax, ay) = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	let Some(f) = all.iter().map(fields).find(|x| *j::at(x, "accountId") == acc && (j::n(x, "x") - ax).abs().max((j::n(x, "y") - ay).abs()) <= 1.0).cloned() else { return refuse("Neben dir steht kein Karren von dir.") };
	if c.space.take_if_exists(&tmpl("Cart", obj! { "cartId" => j::at(&f, "cartId").clone() }), NO_WAIT, c.txn()).await?.is_none() { return refuse("Der Karren ist gerade nicht greifbar; bitte noch einmal."); }
	Ok(f)
}
async fn put(c: &Ctx, f: &Json) -> Result<()> { c.space.write(&tmpl("Cart", f.clone()), c.txn(), FOREVER).await?; Ok(()) }
fn room_named<'a>(w: &'a Json, name: &str) -> Option<&'a Json> { j::a(w, "rooms").iter().find(|r| js::lower(j::s(r, "name")) == js::lower(name) || j::s(r, "roomId") == name) }

/// Runs a command of the module.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"karren" => karren(c, arg).await,
		"zug" => zug(c, arg).await,
		"straße" => super::road::strasse(c, arg).await,
		k => Err(Error::Other(format!("unported: cart/{k}"))),
	}
}

async fn karren(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "cart").cloned() else { return refuse("In dieser Welt gibt es keine Karren.") };
	if c.account.as_ref().is_none_or(|a| j::b(a, "guest")) { return refuse("Gäste haben keine Karren; registriere dich dafür."); }
	let parts: Vec<String> = js::re(r"\s+", "").split(js::trim(arg)).into_iter().map(|p| p.unwrap_or("").to_owned()).collect();
	let word = parts.first().cloned().unwrap_or_default();
	let tail = js::re(ARTICLE, "i").replace(&parts.iter().skip(1).cloned().collect::<Vec<_>>().join(" "), "");
	let cap = j::n(&d, "capacity");
	let acc = account_id(c);
	let me = c.char_id().to_owned();
	if word.is_empty() {
		let carts: Vec<Json> = c.space.read_all(&obj! { "type" => "Cart" }, c.txn()).await?.iter().map(|e| fields(e).clone()).filter(|x| *j::at(x, "accountId") == acc).collect();
		let mut lines = Vec::new();
		for x in &carts {
			let path = j::a(x, "path");
			let on = path.last().map_or_else(String::new, |p| format!(", unterwegs nach {}", name_of(c, &txt(p))));
			let route = j::opt(x, "route").filter(|r| j::truthy(r)).map_or_else(String::new, |r| format!(", pendelt zwischen {} und {}", name_of(c, j::s(r, "from")), name_of(c, j::s(r, "to"))));
			lines.push(format!("in {}{on}{route}, {} von {} Stück geladen", name_of(c, j::s(x, "room")), cargo_of(c, j::at(x, "cartId")).await?.len(), nt(cap)));
		}
		let text = if lines.is_empty() { "Du hast keinen Karren draußen. „karren stelle“ stellt einen ab, den du trägst.".to_owned() } else { format!("Deine Karren: {}.", lines.join("; ")) };
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	if js::re(r"^(?:stelle|abstellen|place)$", "i").test(&word) {
		let Some(it) = inventory(c).await?.iter().map(fields).find(|i| j::at(i, "proto") == j::at(&d, "proto")).cloned() else { return refuse("Du trägst keinen Karren.") };
		consume(c, &it, &me).await?;
		let f = obj! { "cartId" => format!("cart-{}", hex(&random_bytes(6))), "accountId" => acc.clone(), "charId" => me.as_str(), "ownerName" => j::at(&c.actor, "name").clone(), "room" => c.room(), "x" => j::at(&c.actor, "x").clone(), "y" => j::at(&c.actor, "y").clone(), "path" => Json::Array(vec![]), "dueWorldMs" => FOREVER };
		put(c, &f).await?;
		return msg(c, "*", "info", "$you() $conj(stellst|stellt) einen Karren ab.", templ()).await;
	}
	// a standing route ends wherever its cart is: it finishes the way it is on and stays
	if js::re(r"^(?:halt|stopp?|stop)$", "i").test(&word) {
		let mut n = 0;
		for e in c.space.read_all(&obj! { "type" => "Cart" }, c.txn()).await? {
			let x = fields(&e);
			if *j::at(x, "accountId") != acc || !j::b(x, "route") || c.space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, c.txn()).await?.is_none() { continue; }
			let mut rest = j::without(x, "route");
			let due = if j::a(&rest, "path").is_empty() { Json::from(FOREVER) } else { j::at(&rest, "dueWorldMs").clone() };
			j::set(&mut rest, "dueWorldMs", due);
			put(c, &rest).await?;
			n += 1;
		}
		if n == 0 { return refuse("Kein Karren von dir pendelt."); }
		return msg(c, &me, "info", &if n == 1 { "Dein Karren pendelt nicht mehr; er bleibt, wo er als Nächstes ankommt.".to_owned() } else { format!("{n} Karren pendeln nicht mehr.") }, MsgOpts::default()).await;
	}
	let f = mine(c).await?;
	if !j::a(&f, "path").is_empty() { return refuse("Der Karren ist unterwegs."); }
	let cart_id = j::s(&f, "cartId").to_owned();
	let cargo = cargo_of(c, j::at(&f, "cartId")).await?;
	if js::re(r"^(?:lade|load)$", "i").test(&word) {
		let inv = inventory(c).await?;
		let it = items_named(c.w(), &inv, &tail, None).into_iter().next();
		let Some(it) = it.filter(|_| !tail.is_empty()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&tail, 0, Some(30)))) };
		let it = fields(&it).clone();
		if j::at(&it, "proto") == j::at(&d, "proto") { return refuse("Ein Karren passt nicht auf einen Karren."); }
		if cargo.len() as f64 >= cap { return refuse(format!("Mehr als {} Stück trägt er nicht.", nt(cap))); }
		move_item(c, &it, &me, &cart_id, &[]).await?;
		put(c, &f).await?;
		return msg(c, &me, "info", &format!("{} liegt auf dem Karren ({} von {}).", txt(j::at(&it, "name")), cargo.len() + 1, nt(cap)), MsgOpts::default()).await;
	}
	if js::re(r"^(?:entlade|unload)$", "i").test(&word) {
		for it in &cargo { move_item(c, it, &cart_id, &me, &[]).await?; }
		put(c, &f).await?;
		return msg(c, &me, "info", &if cargo.is_empty() { "Der Karren ist leer.".to_owned() } else { format!("Du nimmst {} Stück vom Karren.", cargo.len()) }, MsgOpts::default()).await;
	}
	if js::re(r"^(?:nimm|take)$", "i").test(&word) {
		if !cargo.is_empty() { return refuse("Erst entladen."); }
		give_back(c, &[(txt(j::at(&d, "proto")), 1.0)]).await?;
		return msg(c, &me, "info", "Du nimmst den Karren wieder mit.", MsgOpts::default()).await;
	}
	if js::re(r"^(?:fahre|drive|go)$", "i").test(&word) {
		let Some(room) = room_named(c.w(), &tail).cloned() else { return not_understood(format!("Einen Ort „{}“ kennt der Karren nicht.", js::slice16(&tail, 0, Some(30)))) };
		let links = road_links(&c.space, c.w(), c.txn()).await?;
		let Some(path) = road_path(&links, j::s(&f, "room"), j::s(&room, "roomId")) else { return refuse(format!("Nach {} führt keine Straße.", txt(j::at(&room, "name")))) };
		let mut nf = f.clone();
		j::set(&mut nf, "path", Json::Array(path.into_iter().map(Json::from).collect()));
		j::set(&mut nf, "dueWorldMs", world_now_of(&c.space, c.txn()).await? + j::n(&d, "hopWorldMs"));
		put(c, &nf).await?;
		return msg(c, "*", "info", &format!("$you() $conj(schickst|schickt) den Karren nach {}.", txt(j::at(&room, "name"))), templ()).await;
	}
	if js::re(r"^(?:pendel|pendle|pendeln|route|shuttle)$", "i").test(&word) {
		let Some(m) = js::caps(&js::re(r"^(.+?)(?:\s+mit\s+(.+))?$", "i"), &tail) else { return Err(Error::Other("Cannot read properties of null (reading '1')".into())) };
		let place = m[1].clone().unwrap_or_default();
		let Some(room) = room_named(c.w(), js::trim(&place)).cloned() else { return not_understood(format!("Einen Ort „{}“ kennt der Karren nicht.", js::slice16(&place, 0, Some(30)))) };
		let rid = j::s(&room, "roomId").to_owned();
		let rname = txt(j::at(&room, "name"));
		if rid == j::s(&f, "room") { return refuse("Er pendelt zwischen zwei Orten; nenn den anderen."); }
		if road_path(&road_links(&c.space, c.w(), c.txn()).await?, j::s(&f, "room"), &rid).is_none() { return refuse(format!("Nach {rname} führt keine Straße.")); }
		let mut proto: Option<Json> = None;
		if let Some(what) = &m[2] {
			let want = js::lower(js::trim(&js::re(ARTICLE, "i").replace(what, "")));
			let Some(p) = j::a(c.w(), "prototypes").iter().find(|x| [j::s(x, "key"), j::s(x, "name")].into_iter().map(str::to_owned).chain(j::a(x, "aliases").iter().map(txt)).any(|n| js::lower(&n) == want)) else { return not_understood(format!("„{}“ kennt der Karren nicht.", js::slice16(what, 0, Some(30)))) };
			proto = Some(j::at(p, "key").clone());
		}
		for r in [j::s(&f, "room").to_owned(), rid.clone()] {
			let xs = c.space.read_all(&tmpl("Building", obj! { "room" => r.as_str(), "accountId" => acc.clone() }), c.txn()).await?;
			if !xs.iter().any(|e| plan_of(c.w(), j::s(fields(e), "plan")).is_some_and(|p| j::b(p, "chest") && !j::b(p, "store"))) { return refuse(format!("Zum Pendeln brauchst du an beiden Enden einen Bau mit Truhe: hier und in {rname}.")); }
		}
		let mut route = obj! { "from" => j::at(&f, "room").clone(), "to" => rid.as_str() };
		if let Some(p) = &proto { j::set(&mut route, "proto", p.clone()); }
		let mut nf = f.clone();
		j::set(&mut nf, "route", route);
		j::set(&mut nf, "dueWorldMs", world_now_of(&c.space, c.txn()).await?);
		put(c, &nf).await?;
		let what = proto.map_or_else(String::new, |p| format!("{} ", j::by(j::a(c.w(), "prototypes"), "key", &txt(&p)).map_or_else(String::new, |x| txt(j::at(x, "name")))));
		return msg(c, &me, "info", &format!("Dein Karren pendelt jetzt zwischen {} und {rname}: hier lädt er {what}aus deiner Truhe, dort legt er es in deine Truhe und kommt zurück. Leer fährt er nicht. „karren halt“ beendet es.", name_of(c, j::s(&f, "room"))), MsgOpts::default()).await;
	}
	not_understood("So geht es: karren, karren stelle, karren lade <ding>, karren entlade, karren fahre <ort>, karren pendel <ort> [mit <ding>], karren halt, karren nimm.")
}

/// `shift`: moves what lies at `from` to `to` in the tick's transaction; how many.
async fn shift(space: &Space, txn: &str, items: &[Json], from: &str, to: &str) -> Result<usize> {
	let mut n = 0;
	for it in items { if shift_item(space, Some(txn), j::at(it, "itemId"), from, to).await? { n += 1; } }
	Ok(n)
}
/// `routeStop`: a cart on its route at one of its ends unloads (at `to`) or loads (at `from`); the way it goes on, or []
/// to wait a while.
async fn route_stop(space: &Space, w: &Json, txn: &str, f: &Json) -> Result<Vec<String>> {
	let d = j::at(w, "cart");
	let r = j::at(f, "route");
	let keepers: Vec<&Json> = j::a(j::at(w, "wild"), "keepers").iter().map(|k| j::at(k, "proto")).collect();
	let chest_plan = |b: &Json| plan_of(w, j::s(b, "plan")).filter(|p| j::b(p, "chest") && !j::b(p, "store")).cloned();
	let chests: Vec<Json> = space.read_all(&tmpl("Building", obj! { "room" => j::at(f, "room").clone(), "accountId" => j::at(f, "accountId").clone() }), Some(txn)).await?.iter().map(|e| fields(e).clone()).filter(|b| chest_plan(b).is_some()).collect();
	let inside = |id: Json| async move { Ok::<_, Error>(space.read_all(&tmpl("Item", obj! { "location" => id }), Some(txn)).await?.iter().map(|e| fields(e).clone()).collect::<Vec<Json>>()) };
	let cart_id = j::s(f, "cartId");
	let mut cargo = inside(j::at(f, "cartId").clone()).await?;
	let room = j::s(f, "room");
	let way = |to: &str| { let to = to.to_owned(); async move { Ok::<_, Error>(road_path(&road_links(space, w, Some(txn)).await?, room, &to).unwrap_or_default()) } };
	if room == j::s(r, "to") {
		for b in &chests {
			// a chest has no limit where the world has loads (pack.ts), else it holds its things
			let space_left = if j::b(w, "pack") { f64::INFINITY } else { j::n(&chest_plan(b).unwrap_or(Json::Null), "chest") - inside(j::at(b, "buildId").clone()).await?.iter().filter(|i| !keepers.contains(&j::at(i, "proto"))).count() as f64 };
			let fit = (cargo.len() as f64).min(space_left);
			if fit > 0.0 { let k = shift(space, txn, &cargo[..fit as usize], cart_id, j::s(b, "buildId")).await?; cargo = cargo[k..].to_vec(); }
		}
		return if cargo.is_empty() { way(j::s(r, "from")).await } else { Ok(Vec::new()) };
	}
	if room == j::s(r, "from") {
		for b in &chests {
			let free = j::n(d, "capacity") - cargo.len() as f64;
			if free <= 0.0 { break; }
			let goods: Vec<Json> = inside(j::at(b, "buildId").clone()).await?.into_iter().filter(|i| { let p = j::at(i, "proto"); p != j::at(w, "currency") && p != j::at(d, "proto") && !keepers.contains(&p) && (!j::b(r, "proto") || p == j::at(r, "proto")) }).collect();
			let take = goods.len().min(free as usize);
			let n = shift(space, txn, &goods[..take], j::s(b, "buildId"), cart_id).await?;
			cargo.extend(goods[..n].iter().cloned());
		}
		return if cargo.is_empty() { Ok(Vec::new()) } else { way(j::s(r, "to")).await };
	}
	// left its route (driven elsewhere before): back to where it loads
	way(j::s(r, "from")).await
}

/// `cartTick`: the carts whose date has come go a room on; a cart on a route at one of its ends loads or unloads and
/// sets off, or waits a hop's time. How many moved or worked.
pub async fn cart_tick(space: &Space, w: &Json, _lease_ms: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "cart") else { return Ok(0.0) };
	let hop = j::n(d, "hopWorldMs");
	let now = world_now_of(space, None).await?;
	let mut moved = 0.0;
	for e in space.read_all(&obj! { "type" => "Cart" }, None).await? {
		if j::n(fields(&e), "dueWorldMs") > now { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<bool> = async {
			let Some(t) = space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(&txn)).await? else { return Ok(false) };
			let f = fields(&t).clone();
			let route = j::b(&f, "route");
			let path: Vec<Json> = j::a(&f, "path").to_vec();
			if path.is_empty() && route {
				let way = route_stop(space, w, &txn, &f).await?;
				let mut nf = f.clone();
				j::set(&mut nf, "path", Json::Array(way.into_iter().map(Json::from).collect()));
				j::set(&mut nf, "dueWorldMs", now + hop);
				space.write(&tmpl("Cart", nf), Some(&txn), FOREVER).await?;
				return Ok(true);
			}
			let rest: Vec<Json> = path.iter().skip(1).cloned().collect();
			let target = path.first().and_then(|n| j::by(j::a(w, "rooms"), "roomId", &txt(n))).cloned();
			let mut nf = f.clone();
			if let Some(t) = &target {
				j::set(&mut nf, "room", j::at(t, "roomId").clone());
				let sp = j::at(t, "spawn");
				j::set(&mut nf, "x", j::opt(sp, "x").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| j::at(&f, "x").clone()));
				j::set(&mut nf, "y", j::opt(sp, "y").filter(|v| !v.is_null()).cloned().unwrap_or_else(|| j::at(&f, "y").clone()));
			}
			let last = rest.is_empty();
			j::set(&mut nf, "path", Json::Array(rest));
			j::set(&mut nf, "dueWorldMs", if !last || route { now + hop } else { FOREVER });
			space.write(&tmpl("Cart", nf), Some(&txn), FOREVER).await?;
			if let (true, Some(t), false) = (last, &target, route) {
				to_player(space, &obj! { "room" => j::at(t, "roomId").clone(), "to" => j::at(&f, "charId").clone(), "kind" => "info", "text" => format!("Dein Karren ist in {} angekommen.", txt(j::at(t, "name"))), "from" => "", "at" => time_now() }, Some(&txn)).await?;
			}
			Ok(true)
		}.await;
		match r {
			Ok(true) => { space.commit(&txn).await?; moved += 1.0; }
			Ok(false) => space.abort(&txn).await?,
			Err(err) => { let _ = space.abort(&txn).await; return Err(err); }
		}
	}
	Ok(moved)
}

async fn zug(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(d) = j::opt(c.w(), "rail").cloned() else { return refuse("In dieser Welt fährt keine Bahn.") };
	let island_of = |w: &Json, room: &str| j::by(j::a(w, "rooms"), "roomId", room).map(|r| j::at(r, "island").clone());
	let island = island_of(c.w(), c.room());
	let stations: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "plan" => j::at(&d, "plan").clone() }), c.txn()).await?.iter().map(|e| fields(e).clone()).filter(|b| island_of(c.w(), j::s(b, "room")) == island).collect();
	let me_at = (j::n(&c.actor, "x"), j::n(&c.actor, "y"));
	if !stations.iter().any(|b| j::s(b, "room") == c.room() && dist_to(me_at, Rect::of(b)) <= 1.0) { return refuse("Der Zug hält nur an Bahnhöfen; stell dich neben einen."); }
	// one stop a room, however many stations stand in it
	let others: Vec<Json> = stations.iter().enumerate().filter(|(i, b)| j::s(b, "room") != c.room() && stations.iter().position(|x| j::at(x, "room") == j::at(b, "room")) == Some(*i)).map(|(_, b)| b.clone()).collect();
	let names = others.iter().map(|b| name_of(c, j::s(b, "room"))).collect::<Vec<_>>().join(", ");
	let fare = j::n(&d, "fare");
	let coins = format!("{} Münze{}", nt(fare), if fare == 1.0 { "" } else { "n" });
	let wait = train_in(world_now_of(&c.space, c.txn()).await?, j::no(&d, "everyWorldMs"));
	let mins = |w: f64| nt((w / 60_000.0).ceil());
	let when = if wait != 0.0 { format!(" Der Zug kommt in etwa {} Weltminuten.", mins(wait)) } else { " Der Zug steht am Bahnsteig.".to_owned() };
	let freight = j::opt(&d, "freight").filter(|f| j::truthy(f)).cloned();
	let mine: Vec<Json> = match (&freight, &c.account) { (Some(_), Some(a)) => c.space.read_all(&tmpl("Freight", obj! { "room" => c.room(), "accountId" => j::at(a, "accountId").clone() }), c.txn()).await?.iter().map(|e| fields(e).clone()).collect(), _ => Vec::new() };
	let stop_at = |name: &str| { let n = js::lower(js::trim(name)); others.iter().find(|b| js::lower(&name_of(c, j::s(b, "room"))) == n || j::s(b, "room") == n).cloned() };
	let word = js::lower(js::trim(arg));
	let send = js::caps(&js::re(r"^(?:sende|schicke|send)\s+(.+?)\s+nach\s+(.+)$", "i"), js::trim(arg));
	let me = c.char_id().to_owned();
	let they_go = if names.is_empty() { String::new() } else { format!(" Er fährt nach: {names}.") };
	if word.is_empty() {
		let mut waiting = 0.0;
		for f in &mine { waiting += c.space.count(&tmpl("Item", obj! { "location" => j::at(f, "freightId").clone() }), c.txn()).await?; }
		let text = format!("{}{}", if names.is_empty() { "Auf dieser Insel gibt es keinen anderen Bahnhof.".to_owned() } else { format!("Der Zug fährt nach: {names}, für {coins}.{when}") }, if waiting != 0.0 { format!(" Hier wartet Fracht für dich: {} Stück („zug abholen“).", nt(waiting)) } else { String::new() });
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	// what the railway carried for the actor to this station: all of it into the pack
	if js::re(r"^(?:abholen|hole|holen|fetch)$", "").test(&word) {
		if mine.is_empty() { return refuse("Hier wartet keine Fracht für dich."); }
		let mut n = 0;
		for f in &mine {
			let fid = j::s(f, "freightId").to_owned();
			if c.space.take_if_exists(&tmpl("Freight", obj! { "freightId" => fid.as_str() }), NO_WAIT, c.txn()).await?.is_none() { continue; }
			for e in c.space.read_all(&tmpl("Item", obj! { "location" => fid.as_str() }), c.txn()).await? { move_item(c, fields(&e), &fid, &me, &[]).await?; n += 1; }
		}
		if n == 0 { return refuse("Die Fracht ist gerade nicht greifbar; bitte noch einmal."); }
		return msg(c, "*", "info", &format!("$you() $conj(holst|holt) {n} Stück Fracht vom Bahnsteig."), templ()).await;
	}
	let currency = j::at(c.w(), "currency").clone();
	if let Some(send) = send {
		let Some(fr) = freight else { return refuse("Diese Bahn fährt keine Fracht.") };
		if c.account.as_ref().is_none_or(|a| j::b(a, "guest")) { return refuse("Fracht schicken nur Registrierte; registriere dich dafür."); }
		let Some(dest) = stop_at(send[2].as_deref().unwrap_or("")) else { return not_understood(format!("Dorthin fährt kein Zug.{they_go}")) };
		if wait != 0.0 { return refuse(format!("Der Zug kommt erst in etwa {} Weltminuten.", mins(wait))); }
		let pack: Vec<Json> = inventory(c).await?;
		let what = js::re(ARTICLE, "i").replace(send[1].as_deref().unwrap_or(""), "");
		let everything = js::re(r"^(?:alle?|all)$", "i").test(&what);
		let (n, name) = if everything { (None, String::new()) } else { amount(&what) };
		let goods: Vec<Json> = pack.iter().filter(|i| *j::at(fields(i), "proto") != currency).cloned().collect();
		let hits: Vec<Json> = if everything { goods.clone() } else { let h = items_named(c.w(), &goods, &name, None); match h.first() { Some(h0) => goods.iter().filter(|i| j::at(fields(i), "proto") == j::at(fields(h0), "proto")).cloned().collect(), None => Vec::new() } };
		if hits.is_empty() { return not_understood(format!("Du trägst nichts, was „{}“ heißt (Münzen schickt man nicht).", js::slice16(if name.is_empty() { &what } else { &name }, 0, Some(30)))); }
		let purse: Vec<Json> = pack.iter().filter(|i| *j::at(fields(i), "proto") == currency).cloned().collect();
		if (purse.len() as f64) < fare { return refuse(format!("Eine Fracht kostet {coins}.")); }
		let fcap = j::n(&fr, "capacity");
		let want = n.unwrap_or(hits.len() as f64);
		let k = want.min(hits.len() as f64).min(fcap) as usize;
		for m in purse.iter().take(fare as usize) { consume(c, fields(m), &me).await?; }
		let fid = format!("freight-{}", hex(&random_bytes(6)));
		let f = obj! { "freightId" => fid.as_str(), "accountId" => account_id(c), "charId" => me.as_str(), "ownerName" => j::at(&c.actor, "name").clone(), "room" => j::at(&dest, "room").clone(), "buildId" => j::at(&dest, "buildId").clone(), "untilWorldMs" => world_now_of(&c.space, c.txn()).await? + j::n(&fr, "keepWorldMs") };
		c.space.write(&tmpl("Freight", f), c.txn(), FOREVER).await?;
		for i in hits.iter().take(k) { move_item(c, fields(i), &me, &fid, &[]).await?; }
		let mut kinds: Vec<String> = Vec::new();
		for i in hits.iter().take(k) { let nm = txt(j::at(fields(i), "name")); if !kinds.contains(&nm) { kinds.push(nm); } }
		let more = if want > k as f64 { format!(" Mehr als {} Stück nimmt der Zug auf einmal nicht.", nt(fcap)) } else { String::new() };
		return msg(c, &me, "info", &format!("Du gibst {k}× {} als Fracht nach {} auf; dort holst du sie mit „zug abholen“.{more}", kinds.join(", "), name_of(c, j::s(&dest, "room"))), MsgOpts::default()).await;
	}
	let Some(to) = stop_at(&word) else { return not_understood(format!("Dorthin fährt kein Zug.{they_go}")) };
	if wait != 0.0 { return refuse(format!("Der Zug kommt erst in etwa {} Weltminuten.", mins(wait))); }
	let purse: Vec<Json> = inventory(c).await?.into_iter().filter(|i| *j::at(fields(i), "proto") == currency).collect();
	if (purse.len() as f64) < fare { return refuse(format!("Die Fahrt kostet {coins}.")); }
	for m in purse.iter().take(fare as usize) { consume(c, fields(m), &me).await?; }
	count_trip(c, "train").await?;
	msg(c, "*", "info", &format!("$you() $conj(steigst|steigt) in den Zug nach {}.", name_of(c, j::s(&to, "room"))), templ()).await?;
	let dest = room_of(c, Some(j::s(&to, "room"))).await?;
	let at = place_in(c, &dest, (j::n(&to, "x"), j::n(&to, "y") + j::n(&to, "h")), false, &[]).await?;
	relocate(c, j::s(&dest, "roomId"), at, false, None).await?;
	msg(c, "*", "info", "$you() $conj(steigst|steigt) aus dem Zug.", MsgOpts { templ: true, room: Some(j::s(&dest, "roomId").to_owned()), ..Default::default() }).await
}
