//! Building (`server/engine/commands/build.ts`): a player stakes out a site for a plan; everyone may deliver what it
//! needs and work on it; when nothing is missing it becomes the building, in the same transaction. Its chest, a
//! settlement's warehouse, repair, demolition and estates.
//!
use std::collections::HashSet;

use phi_json::{obj, Json, Object};

use super::chapel::blessed;
use super::default::{place_in, relocate};
use super::epoch::{epoch_name, epoch_of, island_of, need_epoch};
use super::food::sated_factor;
use super::settlement::{huts_in, need_rank, rank_of, settlement_in};
use super::siteorder::{close_orders, kept_until, order_line, orders_of_site, pay_for};
use super::townhall::zone_refusal;
use crate::clock::{decay_now_of, world_now_of};
use crate::context::{exits_here, inventory, items_named, msg, room_of, Ctx, MsgOpts};
use crate::deeds::credit_deed;
use crate::fire::{covers_of, flame_of, is_lit, key_text};
use crate::j;
use crate::js;
use crate::occupancy::{blocked_in, cell_key, cell_of, is_passage, occupied_in};
use crate::pack::{fmt_load, load_at, load_of, pack_max};
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::room_growth::rows;
use crate::settings::{setting, work_rest_ms};
use crate::source::{hex, random_bytes, time_now};
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;

pub const ARTICLE: &str = r"^(?:eine?n?|einem|der|die|das|den|dem|a|an|the)\s+";
pub fn no_article(s: &str) -> String { js::re(ARTICLE, "i").replace(s, "") }

/// A rectangle of cells.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect { pub x: f64, pub y: f64, pub w: f64, pub h: f64 }

impl Rect {
	pub fn of(f: &Json) -> Self { Self { x: j::n(f, "x"), y: j::n(f, "y"), w: j::n(f, "w"), h: j::n(f, "h") } }
	fn cell(p: (f64, f64)) -> Self { Self { x: p.0, y: p.1, w: 1.0, h: 1.0 } }
}

/// `cells`.
pub fn cells(r: Rect) -> Vec<(f64, f64)> {
	let mut out = Vec::new();
	let mut y = r.y;
	while y < r.y + r.h { let mut x = r.x; while x < r.x + r.w { out.push((x, y)); x += 1.0; } y += 1.0; }
	out
}
/// `distTo`: the Chebyshev distance from a cell to a rectangle (0 inside, 1 beside it).
pub fn dist_to(p: (f64, f64), r: Rect) -> f64 { (r.x - p.0).max(0.0).max(p.0 - (r.x + r.w - 1.0)).max((r.y - p.1).max(0.0).max(p.1 - (r.y + r.h - 1.0))) }
fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }
/// `plural`.
pub fn plural(n: f64, one: &str, many: &str) -> String { format!("{} {}", phi_json::number_text(n), if n == 1.0 { one } else { many }) }
/// `human`: a player, or a settler.
pub fn human(c: &Ctx) -> bool { c.account.as_ref().is_some_and(|a| j::b(a, "settler") || (!j::b(a, "npc") && !c.char_id().starts_with("npc-"))) }
/// `planOf`: the plan a name means ("hütte", "eine Hütte").
pub fn plan_of<'a>(w: &'a Json, name: &str) -> Option<&'a Json> {
	let n = no_article(&js::trim(name).to_lowercase());
	j::a(j::at(w, "building"), "plans").iter().find(|p| j::s(p, "key") == n || j::s(p, "name").to_lowercase() == n || j::a(p, "aliases").iter().any(|a| a.as_str() == Some(n.as_str())))
}
fn plan_has(w: &Json, plan: &Json, k: &str) -> bool { plan_of(w, &key_text(plan)).is_some_and(|p| j::b(p, k)) }
/// `missing`: what a site still lacks.
pub fn missing(s: &Json) -> Vec<String> {
	let mut out: Vec<String> = j::a(s, "needs").iter().filter(|n| j::n(n, "have") < j::n(n, "count")).map(|n| format!("{} {}", phi_json::number_text(j::n(n, "count") - j::n(n, "have")), key_text(j::at(n, "name")))).collect();
	if j::n(s, "work") < j::n(s, "workNeed") { out.push(format!("{} Arbeit", phi_json::number_text(j::n(s, "workNeed") - j::n(s, "work")))); }
	out
}
fn proto_name(w: &Json, proto: &str) -> String { j::a(w, "prototypes").iter().find(|p| j::s(p, "key") == proto).map_or_else(|| proto.to_owned(), |p| key_text(j::at(p, "name"))) }
fn room_name(w: &Json, id: &str) -> String { j::by(j::a(w, "rooms"), "roomId", id).map_or_else(|| id.to_owned(), |r| key_text(j::at(r, "name"))) }
fn all_rooms(w: &Json) -> &[Json] { j::ao(w, "allRooms").unwrap_or(j::a(w, "rooms")) }
fn all_room_name(w: &Json, id: &str) -> String { j::by(all_rooms(w), "roomId", id).map_or_else(|| id.to_owned(), |r| key_text(j::at(r, "name"))) }
fn mine(c: &Ctx, f: &Json) -> bool { c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(f, "accountId")) }
fn txt(v: &Json) -> String { key_text(v) }
fn nt(n: f64) -> String { phi_json::number_text(n) }
fn tile(ground: &[String], x: f64, y: f64) -> Option<String> {
	if x < 0.0 || y < 0.0 || x.fract() != 0.0 || y.fract() != 0.0 { return None; }
	let row = ground.get(y as usize)?;
	let t = js::slice16(row, x as isize, Some(x as isize + 1));
	(!t.is_empty() && (x as usize) < js::len16(row)).then(|| t.to_owned())
}
pub(crate) fn anew(e: &Json, f: Json) -> Json {
	let types: Vec<Json> = j::a(e, "types").iter().skip(1).cloned().collect();
	obj! { "type" => j::at(e, "type").clone(), "types" => Json::Array(types), "fields" => f }
}
fn fields_of(list: Vec<Json>) -> Vec<Json> { list.iter().map(|e| fields(e).clone()).collect() }
fn info() -> MsgOpts { MsgOpts::default() }

const DIRS: [(f64, f64); 4] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];

/// `reachable`: the cells reachable from `from` without passing `blocked`, as one walks.
fn reachable(w: &Json, ground: &[String], from: (f64, f64), blocked: &HashSet<String>) -> HashSet<String> {
	let mut seen: HashSet<String> = HashSet::from([cell_key(from.0, from.1)]);
	let mut ring = vec![from];
	while !ring.is_empty() {
		let mut next = Vec::new();
		for c in &ring {
			for (dx, dy) in DIRS {
				let n = (c.0 + dx, c.1 + dy);
				let k = cell_key(n.0, n.1);
				if seen.contains(&k) || blocked.contains(&k) || !walkable(w, ground, n.0, n.1) { continue; }
				seen.insert(k);
				next.push(n);
			}
		}
		ring = next;
	}
	seen
}

/// The cobbles of paths and plazas: nothing is built or dug on them.
pub const PATH: &str = ":";
/// How far from an exit a plan `atExit` may lie.
pub const EXIT_REACH: f64 = 2.0;

/// `refusal`: why `rect` cannot be built on (None: it can). `green`: a green plan or a bed; `on_people`: dug under
/// anyone's feet.
pub async fn refusal(c: &Ctx, room: &Json, rect: Rect, green: bool, on_people: bool) -> Result<Option<String>> {
	let ground = rows(j::at(room, "ground"));
	let (height, width) = (ground.len() as f64, ground.first().map_or(0, |r| js::len16(r)) as f64);
	if rect.x < 0.0 || rect.y < 0.0 || rect.x + rect.w > width || rect.y + rect.h > height { return Ok(Some("Dort ist der Raum zu Ende.".into())); }
	let room_id = j::s(room, "roomId");
	let cs = cells(rect);
	if let Some(z) = zone_refusal(c, room_id, &cs, green).await? { return Ok(Some(z)); }
	let exits = fields_of(exits_here(c, Some(room_id)).await?);
	let blocked = blocked_in(&c.space, room_id).await?;
	let people: HashSet<String> = occupied_in(&c.space, room_id, Some(c.char_id())).await?.into_iter().map(|(k, _)| k).collect();
	let things: HashSet<String> = c.space.read_all(&tmpl("Item", obj! { "location" => room_id }), None).await?.iter().map(|e| cell_of(fields(e))).collect();
	let fires: Vec<&Json> = j::a(c.w(), "beacons").iter().filter(|b| j::s(b, "room") == room_id).collect();
	let road = super::road::road_cells_in(&c.space, room_id, c.txn()).await?;
	for p in &cs {
		let k = cell_key(p.0, p.1);
		if road.contains(&k) { return Ok(Some("Dort führt eine Straße entlang; sie bleibt frei.".into())); }
		if !walkable(c.w(), &ground, p.0, p.1) { return Ok(Some("Dort ist kein fester Boden.".into())); }
		if tile(&ground, p.0, p.1).as_deref() == Some(PATH) { return Ok(Some("Das ist ein Weg; Wege und Plätze bleiben frei.".into())); }
		if is_passage(&exits, p.0, p.1) { return Ok(Some("Dort ist ein Weg hinaus; den baut niemand zu.".into())); }
		if fires.iter().any(|b| (j::n(b, "x") - p.0).abs().max((j::n(b, "y") - p.1).abs()) <= 1.0) { return Ok(Some("So nah am Feuer baut man nicht.".into())); }
		if blocked.contains(&k) {
			let scenery = fields_of(c.space.read_all(&tmpl("Scenery", obj! { "room" => room_id }), None).await?);
			let piece = scenery.iter().find(|s| dist_to(*p, Rect::of(s)) == 0.0);
			return Ok(Some(match piece { Some(s) if !j::b(s, "fixed") => format!("Dort steht {}; erst abräumen (räume).", txt(j::at(s, "name"))), _ => "Dort steht schon etwas oder wird gebaut.".into() }));
		}
		if !on_people && people.contains(&k) { return Ok(Some("Dort steht jemand.".into())); }
		if things.contains(&k) { return Ok(Some("Dort liegt etwas; räum es erst weg.".into())); }
	}
	let mut after = blocked.clone();
	after.extend(cs.iter().map(|p| cell_key(p.0, p.1)));
	let spawn = j::opt(room, "spawn").filter(|s| j::truthy(s));
	let start = match (spawn, exits.first()) {
		(Some(s), _) if !after.contains(&cell_of(s)) => xy(s),
		(_, Some(x)) => xy(x),
		_ => xy(&c.actor),
	};
	let reach = reachable(c.w(), &ground, start, &after);
	let ok = |p: (f64, f64)| reach.contains(&cell_key(p.0, p.1));
	if !exits.iter().all(|x| ok(xy(x))) || spawn.is_some_and(|s| !ok(xy(s))) || !(ok(xy(&c.actor)) || dist_to(xy(&c.actor), rect) == 0.0) { return Ok(Some("Damit wäre ein Weg zugebaut.".into())); }
	if !fires.iter().all(|b| DIRS.iter().any(|(dx, dy)| ok((j::n(b, "x") + dx, j::n(b, "y") + dy)))) { return Ok(Some("Damit käme niemand mehr ans Feuer.".into())); }
	Ok(None)
}

const DIRS4: [(f64, f64); 4] = [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)];

/// `waterRefusal`: why a jetty cannot go on `rect` (None: it can): it lies on water only, one of its cells beside the
/// land, free of other things built and of the large ship's berth in a bay.
async fn water_refusal(space: &Space, w: &Json, room: &Json, rect: Rect) -> Result<Option<String>> {
	let ground = rows(j::at(room, "ground"));
	let (height, width) = (ground.len() as f64, ground.first().map_or(0, |r| js::len16(r)) as f64);
	if rect.x < 0.0 || rect.y < 0.0 || rect.x + rect.w > width || rect.y + rect.h > height { return Ok(Some("Dort ist der Raum zu Ende.".into())); }
	let cs = cells(rect);
	let wet = |p: &(f64, f64)| tile(&ground, p.0, p.1).is_some() && !walkable(w, &ground, p.0, p.1);
	if !cs.iter().all(wet) { return Ok(Some("Ein Steg reicht ins Wasser: er liegt ganz auf dem Wasser, mit einem Ende am Ufer.".into())); }
	if !cs.iter().any(|p| DIRS4.iter().any(|(dx, dy)| walkable(w, &ground, p.0 + dx, p.1 + dy))) { return Ok(Some("Ein Steg beginnt am Ufer.".into())); }
	let room_id = j::s(room, "roomId");
	let blocked = blocked_in(space, room_id).await?;
	if cs.iter().any(|p| blocked.contains(&cell_key(p.0, p.1))) { return Ok(Some("Dort liegt schon ein Steg oder wird gebaut.".into())); }
	let island = j::by(j::a(w, "rooms"), "roomId", room_id).and_then(|r| j::so(r, "island")).filter(|i| !i.is_empty());
	let all = j::ao(w, "allRooms").unwrap_or_else(|| j::a(w, "rooms"));
	let spawn = j::opt(room, "spawn").filter(|s| j::truthy(s));
	let bay = match (island, spawn) {
		(Some(i), Some(sp)) if crate::liner::bays_of(all).iter().find(|(k, _)| k == i).is_some_and(|(_, r)| j::s(r, "roomId") == room_id) => crate::liner::berth(&ground, xy(sp), "~"),
		_ => None,
	};
	if let Some((bx, by, along_x)) = bay {
		let ship = Rect { x: bx - 1.0, y: by - 1.0, w: if along_x { crate::liner::SHIP_LENGTH } else { 1.0 } + 2.0, h: if along_x { 1.0 } else { crate::liner::SHIP_LENGTH } + 2.0 };
		if cs.iter().any(|p| dist_to(*p, ship) == 0.0) { return Ok(Some("Dort legt das große Schiff an.".into())); }
	}
	Ok(None)
}

/// `jettyToWater`: a jetty of old on the beach moved onto the water beside it, the nearest place within two cells that
/// lies on water with one end at the shore, the ones that stick out first; its plot moves with it. False when there is
/// no place.
async fn jetty_to_water(space: &Space, w: &Json, txn: &str, ty: &str, b: &Json) -> Result<bool> {
	let Some(room_e) = space.read_all(&tmpl("Room", obj! { "roomId" => j::at(b, "room").clone() }), Some(txn)).await?.into_iter().next() else { return Ok(false) };
	let room = fields(&room_e).clone();
	let ground = rows(j::at(&room, "ground"));
	let land = |x: f64, y: f64| walkable(w, &ground, x, y);
	let br = Rect::of(b);
	if !cells(br).iter().any(|p| land(p.0, p.1)) { return Ok(false); }
	let (long, short) = (br.w.max(br.h), br.w.min(br.h));
	let mut tries: Vec<Rect> = Vec::new();
	for (sw, sh) in [(long, short), (short, long)] {
		let mut y = br.y - 2.0 - sh;
		while y <= br.y + br.h + 2.0 {
			let mut x = br.x - 2.0 - sw;
			while x <= br.x + br.w + 2.0 {
				let r = Rect { x, y, w: sw, h: sh };
				if !cells(r).iter().all(|p| dist_to(*p, br) > 3.0) { tries.push(r); }
				x += 1.0;
			}
			y += 1.0;
		}
	}
	let touch = |r: &Rect| cells(*r).iter().filter(|p| DIRS4.iter().any(|(dx, dy)| land(p.0 + dx, p.1 + dy))).count();
	let far = |r: &Rect| cells(*r).iter().map(|p| dist_to(*p, br)).fold(f64::INFINITY, f64::min);
	tries.sort_by(|p, q| touch(p).cmp(&touch(q)).then(far(p).partial_cmp(&far(q)).unwrap_or(std::cmp::Ordering::Equal)));
	for r in tries {
		if water_refusal(space, w, &room, r).await?.is_some() { continue; }
		let Some(e) = space.take_if_exists(&tmpl(ty, obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(txn)).await? else { return Ok(false) };
		free_cells(space, txn, j::s(b, "room"), j::at(b, "buildId")).await?;
		for p in cells(r) { space.write_unique(&tmpl("Plot", obj! { "room" => j::at(b, "room").clone(), "x" => p.0, "y" => p.1, "of" => j::at(b, "buildId").clone() }), Some(txn), FOREVER, &["room", "x", "y"]).await?; }
		let mut f = fields(&e).clone();
		for (k, v) in [("x", r.x), ("y", r.y), ("w", r.w), ("h", r.h)] { j::set(&mut f, k, v); }
		space.write(&tmpl(ty, f), Some(txn), FOREVER).await?;
		return Ok(true);
	}
	Ok(false)
}

/// `jettyTries`: the rects for a jetty beside the actor: both ways round, the ones that point away from the actor first.
fn jetty_tries(c: &Ctx, pw: f64, ph: f64, at: Option<(f64, f64)>) -> Vec<Rect> {
	let (long, short) = (pw.max(ph), pw.min(ph));
	let shapes = [(long, short), (short, long)];
	// a cell named ("bau steg 20 4", the menu's cell): a jetty from that corner first, then one that covers it, then one
	// right beside it, so the shore one stands on names the jetty in the water before it
	if let Some(p) = at {
		let mut out: Vec<Rect> = shapes.iter().map(|&(w, h)| Rect { x: p.0, y: p.1, w, h }).collect();
		for &(w, h) in &shapes { let mut dy = 0.0; while dy < h { let mut dx = 0.0; while dx < w { if dx != 0.0 || dy != 0.0 { out.push(Rect { x: p.0 - dx, y: p.1 - dy, w, h }); } dx += 1.0; } dy += 1.0; } }
		for &(w, h) in &shapes { out.extend(besides_of(p, w, h)); }
		return out;
	}
	let mut all: Vec<Rect> = shapes.iter().flat_map(|&(w, h)| besides(c, w, h)).collect();
	let (ax, ay) = xy(&c.actor);
	let end = |r: &Rect| if r.w >= r.h { if ay >= r.y && ay < r.y + r.h { 0 } else { 1 } } else if ax >= r.x && ax < r.x + r.w { 0 } else { 1 };
	all.sort_by_key(end);
	all
}

/// `siteNear`: whether a site lies within reach of the actor (nothing taken).
async fn site_near(c: &Ctx) -> Result<bool> {
	let me = xy(&c.actor);
	Ok(c.space.read_all(&tmpl("Site", obj! { "room" => c.room() }), c.txn()).await?.iter().any(|e| dist_to(me, Rect::of(fields(e))) <= SITE_REACH))
}

/// `besides`: the rectangles beside the actor where a plan of `w`×`h` could go, nearest sides first.
pub fn besides(c: &Ctx, w: f64, h: f64) -> Vec<Rect> { besides_of(xy(&c.actor), w, h) }
/// The rects of size `w`×`h` right beside the cell `p`, in the order of `besides`.
fn besides_of(p: (f64, f64), w: f64, h: f64) -> Vec<Rect> {
	let (x, y) = p;
	let mut out = Vec::new();
	let mut ry = y - h;
	while ry <= y + 1.0 {
		let mut rx = x - w;
		while rx <= x + 1.0 { let r = Rect { x: rx, y: ry, w, h }; if dist_to((x, y), r) == 1.0 { out.push(r); } rx += 1.0; }
		ry += 1.0;
	}
	let side = |r: &Rect| (if r.y == y + 1.0 { 0.0 } else if r.x == x + 1.0 { 1.0 } else if r.x + r.w == x { 2.0 } else { 3.0 }) * 10.0 + (r.x + r.w / 2.0 - 0.5 - x).abs() + (r.y + r.h / 2.0 - 0.5 - y).abs();
	out.sort_by(|a, b| side(a).partial_cmp(&side(b)).unwrap_or(std::cmp::Ordering::Equal));
	out
}

async fn active_builders(c: &Ctx, beacon_id: &str, more: &Json) -> Result<f64> {
	let now = decay_now_of(&c.space, c.txn()).await?;
	Ok(c.space.read_all(&tmpl("FireBuilder", obj! { "beaconId" => beacon_id }), c.txn()).await?.iter().filter(|e| j::n(fields(e), "atWorldMs") + j::n(more, "activeMs") > now).count() as f64)
}

/// `lightBase`: a fire's own light (the setting light.base, else the world's), and what each epoch of its island above the
/// first adds (light.epoch).
async fn light_base(c: &Ctx, beacon_id: &str) -> Result<(f64, f64)> {
	let def = j::at(c.w(), "building");
	let base = match setting(&c.space, "light.base").await { Ok(v) => v, Err(_) => j::no(def, "lightPoints").unwrap_or(0.0) };
	let per = light_per_epoch(c).await;
	let room = j::by(j::a(c.w(), "beacons"), "beaconId", beacon_id).map_or_else(|| c.room().to_owned(), |b| j::s(b, "room").to_owned());
	let epoch = if per != 0.0 { per * (epoch_of(&c.space, island_of(c.w(), &room).as_deref(), c.txn()).await? - 1.0) } else { 0.0 };
	Ok((base, epoch))
}

async fn light_per_epoch(c: &Ctx) -> f64 {
	match setting(&c.space, "light.epoch").await { Ok(v) => v, Err(_) => j::no(j::at(c.w(), "building"), "lightPerEpoch").unwrap_or(0.0) }
}

/// `lightOf`: what a fire's light carries.
async fn light_of(c: &Ctx, beacon_id: &str) -> Result<f64> {
	let def = j::at(c.w(), "building");
	let (base, epoch) = light_base(c, beacon_id).await?;
	let mut bonus = epoch;
	for e in c.space.read_all(&tmpl("Building", obj! { "beaconId" => beacon_id }), c.txn()).await? { bonus += plan_of(c.w(), &txt(j::at(fields(&e), "plan"))).and_then(|p| j::no(p, "lightBonus")).unwrap_or(0.0); }
	let Some(more) = j::opt(def, "lightGrowth") else { return Ok(base + bonus) };
	let active = active_builders(c, beacon_id, more).await?;
	Ok(j::n(more, "max").max(base).min(base + active * j::n(more, "perPlayer")) + bonus)
}

/// `noteBuilder`: the actor counts as building at this fire.
async fn note_builder(c: &Ctx, beacon_id: &str) -> Result<()> {
	let Some(a) = &c.account else { return Ok(()) };
	if j::opt(j::at(c.w(), "building"), "lightGrowth").is_none() || j::b(a, "guest") || j::b(a, "settler") { return Ok(()); }
	let id = j::at(a, "accountId").clone();
	c.space.take_if_exists(&tmpl("FireBuilder", obj! { "beaconId" => beacon_id, "accountId" => id.clone() }), NO_WAIT, c.txn()).await?;
	let at = decay_now_of(&c.space, c.txn()).await?;
	c.space.write(&tmpl("FireBuilder", obj! { "beaconId" => beacon_id, "accountId" => id, "atWorldMs" => at }), c.txn(), FOREVER).await?;
	Ok(())
}

fn touches_water(w: &Json, ground: &[String], r: Rect) -> bool {
	cells(Rect { x: r.x - 1.0, y: r.y - 1.0, w: r.w + 2.0, h: r.h + 2.0 }).iter().any(|p| tile(ground, p.0, p.1).is_some() && !walkable(w, ground, p.0, p.1))
}

/// A fire's light for a site: the fire, its use (taken in the transaction) and whether it is its first.
pub struct Light { pub beacon_id: String, pub used: f64, pub fresh: bool }

const BUSY: &str = "Gerade baut jemand anderes im Licht dieses Feuers; bitte gleich noch einmal.";

/// `lightFor`: a burning fire that covers the room and has light left for `points`; Err with the reason.
pub async fn light_for(c: &Ctx, points: f64) -> Result<std::result::Result<Light, String>> {
	let now = world_now_of(&c.space, c.txn()).await?;
	let share = if c.account.as_ref().is_some_and(|a| j::b(a, "settler")) { 1.0 - j::no(j::at(c.w(), "settlers"), "reserve").unwrap_or(0.25) } else { 1.0 };
	let cover = covers_of(&c.space, c.w(), c.txn()).await?;
	let room = c.room().to_owned();
	let mut fires: Vec<&Json> = j::a(c.w(), "beacons").iter().filter(|b| cover.iter().find(|(k, _)| k == j::s(b, "beaconId")).is_some_and(|(_, l)| l.contains(&room))).collect();
	fires.sort_by_key(|b| j::s(b, "room") != room);
	if fires.is_empty() { return Ok(Err("Hier hält kein Feuer den Nebel fern; gebaut wird nur im Licht.".into())); }
	let mut lit: Option<String> = None;
	for b in fires {
		let id = j::s(b, "beaconId").to_owned();
		if !is_lit(flame_of(&c.space, &id, None).await?.as_ref(), now) { continue; }
		if lit.is_none() { lit = Some(id.clone()); }
		let t = tmpl("LightUse", obj! { "beaconId" => id.as_str() });
		let e = c.space.take_if_exists(&t, NO_WAIT, c.txn()).await?;
		if e.is_none() && c.space.count(&t, None).await? > 0.0 { return refuse(BUSY); }
		let used = e.as_ref().map_or(0.0, |e| j::n(fields(e), "used"));
		if used + points <= light_of(c, &id).await? * share { return Ok(Ok(Light { beacon_id: id, used, fresh: e.is_none() })); }
		if let Some(e) = &e { c.space.write(&tmpl("LightUse", fields(e).clone()), c.txn(), FOREVER).await?; }
	}
	Ok(Err(match lit { Some(id) => format!("Das Licht des Feuers reicht für keinen weiteren Bau.{}", more_light(c, &id).await?), None => "Das Feuer, das hier Licht gibt, ist aus; gebaut wird nur im Licht.".into() }))
}

/// `moreLight`: what would give the fire more light.
async fn more_light(c: &Ctx, beacon_id: &str) -> Result<String> {
	let def = j::at(c.w(), "building");
	let island = island_of(c.w(), c.room());
	let mut out = String::new();
	if let Some(more) = j::opt(def, "lightGrowth") {
		let active = active_builders(c, beacon_id, more).await?;
		let (base, _) = light_base(c, beacon_id).await?;
		if base + active * j::n(more, "perPlayer") < j::n(more, "max") { out += &format!(" Es wird heller mit jedem, der hier mitbaut (bis {} Punkte).", txt(j::at(more, "max"))); }
	}
	let per = light_per_epoch(c).await;
	if per != 0.0 && epoch_of(&c.space, island.as_deref(), c.txn()).await? < j::opt(j::at(c.w(), "epochs"), "names").and_then(Json::as_array).map_or(1.0, |n| n.len() as f64) { out += &format!(" Mit jeder Epoche der Insel trägt es {} Punkte mehr.", phi_json::number_text(per)); }
	if let Some(tower) = j::a(def, "plans").iter().find(|p| j::b(p, "lightBonus")) {
		if let Some(dative) = j::opt(tower, "dative").filter(|d| j::truthy(d)) {
			let need = j::no(tower, "epoch").unwrap_or(1.0);
			if need <= epoch_of(&c.space, island.as_deref(), c.txn()).await? { out += &format!(" Mit {} hätte es mehr Licht.", txt(dative)); }
			else {
				let a = j::a(j::at(c.w(), "epochs"), "a").get((need - 1.0) as usize).filter(|x| !x.is_null()).map_or_else(|| epoch_name(c.w(), need), txt);
				out += &format!(" Mit {} hätte es mehr Licht, aber der Bauplan öffnet sich erst, wenn die Insel {a} ist.", txt(dative));
			}
		}
	}
	if j::a(c.w(), "beacons").iter().any(|b| j::s(b, "beaconId") != beacon_id && island_of(c.w(), j::s(b, "room")) == island) { out += " Im Licht eines anderen Feuers der Insel ist vielleicht noch Platz."; }
	out += " Verfällt ein Bau oder wird er abgerissen, wird sein Licht wieder frei.";
	Ok(out)
}

/// `useLight`: writes the fire's light use back (its first with the unique check).
pub async fn use_light(c: &Ctx, l: &Light, delta: f64) -> Result<()> {
	let e = tmpl("LightUse", obj! { "beaconId" => l.beacon_id.as_str(), "used" => (l.used + delta).max(0.0) });
	let r = if l.fresh { c.space.write_unique(&e, c.txn(), FOREVER, &["beaconId"]).await } else { c.space.write(&e, c.txn(), FOREVER).await };
	match r { Err(e) if e.to_string().contains("unique entry already exists") => refuse(BUSY), Err(e) => Err(e), Ok(_) => Ok(()) }
}

/// How far from a site one still delivers and works on it.
pub const SITE_REACH: f64 = 2.0;

/// `takeNear`: the entry of `ty` within `reach` of the actor whose cells carry `id_key`, taken in the transaction;
/// Err(far): none within reach (`far`: one in the room).
pub async fn take_near(c: &Ctx, ty: &str, id_key: &str, reach: f64, named: &dyn Fn(&Json) -> bool) -> Result<std::result::Result<Json, bool>> {
	let all = fields_of(c.space.read_all(&tmpl(ty, obj! { "room" => c.room() }), None).await?);
	let me = xy(&c.actor);
	let mut near: Vec<&Json> = all.iter().filter(|f| dist_to(me, Rect::of(f)) <= reach && named(f)).collect();
	near.sort_by(|a, b| dist_to(me, Rect::of(a)).partial_cmp(&dist_to(me, Rect::of(b))).unwrap_or(std::cmp::Ordering::Equal));
	let key = |v: Json| { let mut o = Object::new(); o.insert(id_key, v); Json::Object(o) };
	if let Some(f) = near.first() {
		let Some(e) = c.space.take(&tmpl(ty, key(j::at(f, id_key).clone())), 5_000.0, c.txn()).await? else { return refuse("Das ist gerade nicht greifbar; bitte noch einmal.") };
		return Ok(Ok(fields(&e).clone()));
	}
	let plots = fields_of(c.space.read_all(&tmpl("Plot", obj! { "room" => c.room() }), None).await?);
	let mut held: Vec<Json> = Vec::new();
	for p in &plots {
		let of = j::at(p, "of");
		if dist_to(me, Rect::cell(xy(p))) <= reach && !all.iter().any(|f| txt(j::at(f, id_key)) == txt(of)) && !held.contains(of) { held.push(of.clone()); }
	}
	for id in held {
		let Some(e) = c.space.take_if_exists(&tmpl(ty, key(id)), 5_000.0, c.txn()).await? else { continue };
		let f = fields(&e).clone();
		if named(&f) { return Ok(Ok(f)); }
		c.space.write(&anew(&e, f), c.txn(), FOREVER).await?;
	}
	Ok(Err(!all.is_empty()))
}

/// `siteHere`: the site within SITE_REACH of the actor (by plan name when given), taken in the transaction.
pub async fn site_here(c: &Ctx, name: &str) -> Result<Json> {
	let w = c.world.clone();
	let named = |s: &Json| name.is_empty() || plan_of(&w, name).is_some_and(|p| j::at(p, "key") == j::at(s, "plan")) || txt(j::at(s, "name")).to_lowercase() == name.to_lowercase();
	match take_near(c, "Site", "buildId", SITE_REACH, &named).await? {
		Ok(s) => Ok(s),
		Err(far) => not_understood(if far { "Geh näher an die Baustelle heran (höchstens zwei Schritte entfernt)." } else { "Hier ist keine Baustelle. „bau <plan>“ steckt eine ab." }),
	}
}

const WORLD_DAY: f64 = 24.0 * 3_600_000.0;

/// `keepOf`: how long a plan stands after building or repair.
async fn keep_of(c: &Ctx, plan: Option<&Json>) -> Result<f64> {
	if let Some(k) = plan.and_then(|p| j::so(p, "keepSetting")).filter(|k| !k.is_empty()) { return Ok(setting(&c.space, k).await? * WORLD_DAY); }
	Ok(plan.and_then(|p| j::no(p, "keepWorldMs")).unwrap_or(7.0 * WORLD_DAY))
}

fn estate_ms(w: &Json) -> f64 { j::no(j::at(w, "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0) }

/// `settle`: writes the site back, or, when nothing is missing, the building in its place.
pub async fn settle(c: &Ctx, s: &Json) -> Result<()> {
	let now = world_now_of(&c.space, c.txn()).await?;
	let kept = decay_now_of(&c.space, c.txn()).await?;
	if j::a(s, "needs").iter().all(|n| j::n(n, "have") >= j::n(n, "count")) && j::n(s, "work") >= j::n(s, "workNeed") {
		let plan = plan_of(c.w(), &txt(j::at(s, "plan")));
		let mut b = Object::new();
		for k in ["buildId", "plan", "name", "room", "x", "y", "w", "h", "owner", "ownerName", "accountId", "beaconId", "points", "by"] { if let Some(v) = s.get(k) { b.insert(k, v.clone()); } }
		b.insert("untilWorldMs", Json::from(kept + keep_of(c, plan).await?));
		b.insert("builtAt", Json::from(now));
		let b = Json::Object(b);
		c.space.write(&tmpl("Building", b.clone()), c.txn(), FOREVER).await?;
		super::interior::make_interior(&c.space, &c.txn, c.w(), &b).await?; // its inside, when its plan has one
		close_orders(&c.space, &c.txn, s, kept + estate_ms(c.w())).await?;
		let mut by: Vec<(&str, f64)> = j::entries(j::at(s, "by")).map(|(k, v)| (k, j::number(v))).collect();
		by.sort_by(|a, b| (b.1 - a.1).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
		let helpers = by.iter().map(|(n, k)| format!("{n} ({})", nt(*k))).collect::<Vec<_>>().join(", ");
		return msg(c, "*", "world", &format!("Die {} von {} steht! Mitgebaut: {helpers}.", txt(j::at(s, "name")), txt(j::at(s, "ownerName"))), info()).await;
	}
	let mut f = j::object(s);
	f.insert("untilWorldMs", Json::from(kept + j::no(j::at(c.w(), "building"), "siteWorldMs").unwrap_or(2.0 * WORLD_DAY)));
	c.space.write(&tmpl("Site", Json::Object(f)), c.txn(), FOREVER).await?;
	Ok(())
}

/// `credit`: counts a contribution of `n` for the actor; NPCs and automata give at most half of what the site needs.
fn credit(c: &Ctx, s: &mut Json, n: f64) -> Result<f64> {
	let total = j::a(s, "needs").iter().map(|x| j::n(x, "count")).sum::<f64>() + j::n(s, "workNeed");
	let h = human(c);
	let n = if h { n } else { 0f64.max(n.min((total / 2.0).floor() - j::n(s, "other"))) };
	if n == 0.0 || n.is_nan() { return refuse("Diese Baustelle bauen Menschen; Helfer haben ihren Teil schon getan."); }
	let k = if h { "human" } else { "other" };
	let v = j::n(s, k) + n;
	j::set(s, k, v);
	let name = txt(j::at(&c.actor, "name"));
	let mut by = j::object(j::at(s, "by"));
	let had = by.get(&name).map_or(0.0, j::number);
	by.insert(name, Json::from(had + n));
	j::set(s, "by", Json::Object(by));
	Ok(n)
}

fn need_mut(s: &mut Json, i: usize) -> Option<&mut Json> {
	match s { Json::Object(o) => match o.get_mut("needs") { Some(Json::Array(a)) => a.get_mut(i), _ => None }, _ => None }
}

/// The commands of this module by key.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"bau" => bau(c, arg).await,
		"liefere" => liefere(c, arg).await,
		"arbeite" => arbeite(c, arg).await,
		"baustelle" => baustelle(c, arg).await,
		"truhe" => truhe(c).await,
		"lager" => lager(c, arg).await,
		"verstaue" => verstaue(c, arg).await,
		"entnimm" => entnimm(c, arg).await,
		"repariere" => repariere(c, arg).await,
		"abriss" => abriss(c, arg).await,
		"nachlass" => nachlass(c).await,
		k => Err(Error::Other(format!("unported: build/{k}"))),
	}
}

/// `bau`.
pub async fn bau(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = c.world.clone();
	let def = j::at(&w, "building");
	if j::a(def, "plans").is_empty() { return refuse("In dieser Welt wird nicht gebaut."); }
	let me = c.char_id().to_owned();
	let island = island_of(&w, c.room());
	if js::trim(arg).is_empty() {
		let epoch = epoch_of(&c.space, island.as_deref(), c.txn()).await?;
		let mut plans: Vec<&Json> = j::a(def, "plans").iter().collect();
		plans.sort_by(|a, b| js::locale_compare(j::s(a, "name"), j::s(b, "name")));
		let list: Vec<String> = plans.iter().map(|p| {
			let later = if j::no(p, "epoch").unwrap_or(1.0) > epoch { format!(" (erst ab {})", epoch_name(&w, j::n(p, "epoch"))) } else { String::new() };
			let needs = j::a(p, "needs").iter().map(|n| format!("{} {}", txt(j::at(n, "count")), proto_name(&w, j::s(n, "proto")))).collect::<Vec<_>>().join(", ");
			format!("{}{later} ({}×{}): {needs}, {} Arbeit", txt(j::at(p, "name")), txt(j::at(p, "w")), txt(j::at(p, "h")), txt(j::at(p, "work")))
		}).collect();
		return msg(c, &me, "info", &format!("Baupläne: {}. „bau <plan>“ steckt neben dir eine Baustelle ab; liefern und arbeiten können alle.", list.join("; ")), info()).await;
	}
	let m = js::caps(&js::re(r"^(\S+)(?:\s+(\d+)\s+(\d+))?$", ""), &no_article(js::trim(arg)));
	let Some(plan) = m.as_ref().and_then(|m| plan_of(&w, m[1].as_deref().unwrap_or(""))) else {
		return not_understood(format!("Einen Bauplan „{}“ gibt es nicht. „bau“ zeigt die Pläne.", js::slice16(arg, 0, Some(20))));
	};
	let m = m.unwrap_or_default();
	let Some(account) = c.account.clone().filter(|a| !j::b(a, "guest")) else { return refuse("Gäste können liefern und mitarbeiten, aber nichts besitzen; registriere dich, um selbst zu bauen.") };
	if !human(c) { return refuse("Baustellen stecken nur Menschen ab."); }
	let pname = txt(j::at(plan, "name"));
	need_epoch(c, j::no(plan, "epoch"), &format!("Der Bauplan „{pname}“")).await?;
	need_rank(c, "siedler", "Bauen").await?;
	let account_id = j::at(&account, "accountId").clone();
	let open = fields_of(c.space.read_all(&tmpl("Site", obj! { "accountId" => account_id.clone() }), c.txn()).await?);
	if open.len() as f64 >= j::n(def, "maxSites") {
		let place = open.iter().map(|s| format!("{} in {} ({} {})", txt(j::at(s, "name")), room_name(&w, j::s(s, "room")), txt(j::at(s, "x")), txt(j::at(s, "y")))).collect::<Vec<_>>().join(", ");
		return refuse(format!("Du hast schon eine offene Baustelle: {place}; bau sie erst fertig."));
	}
	let free: Vec<&str> = j::strs(j::a(def, "uncounted"));
	let key = j::s(plan, "key");
	if !free.contains(&key) {
		let epoch = epoch_of(&c.space, island.as_deref(), c.txn()).await?;
		let max = setting(&c.space, &format!("build.max{}", nt(4f64.min(1f64.max(epoch))))).await?;
		let built = c.space.read_all(&tmpl("Building", obj! { "accountId" => account_id.clone() }), c.txn()).await?;
		let held = open.iter().filter(|s| !free.contains(&j::s(s, "plan"))).count() + built.iter().filter(|e| !free.contains(&txt(j::at(fields(e), "plan")).as_str())).count();
		if held as f64 >= max { return refuse(format!("Mehr als {} Bauten hat hier niemand ({}); Regentonne, Vogelscheuche, Ställe, Gehege, Bienenstock und Signalfeuer zählen nicht mit.", nt(max), epoch_name(&w, epoch))); }
	}
	if let Some(herds) = j::opt(&w, "animals") {
		let houses = j::at(herds, "houses");
		if j::opt(houses, key).is_some_and(j::truthy) {
			let max_houses = setting(&c.space, "animals.houses").await?;
			let mut all = c.space.read_all(&tmpl("Building", obj! { "accountId" => account_id.clone() }), None).await?;
			all.extend(c.space.read_all(&tmpl("Site", obj! { "accountId" => account_id.clone() }), None).await?);
			if all.iter().filter(|e| j::opt(houses, &txt(j::at(fields(e), "plan"))).is_some_and(j::truthy)).count() as f64 >= max_houses { return refuse(format!("Mehr als {} Ställe, Gehege und Bienenstöcke hält niemand im Blick.", nt(max_houses))); }
		}
	}
	if j::b(plan, "onePerRoom") {
		let t = obj! { "room" => c.room(), "plan" => key };
		if c.space.count(&tmpl("Building", t.clone()), None).await? > 0.0 || c.space.count(&tmpl("Site", t), None).await? > 0.0 { return refuse(format!("Ein Raum hat höchstens einen Bau „{pname}“, und hier steht er schon (oder seine Baustelle).")); }
	}
	let points = j::n(plan, "points");
	let light = match light_for(c, points).await? { Ok(l) => l, Err(why) => return refuse(why) };
	note_builder(c, &light.beacon_id).await?;
	let room = room_of(c, None).await?;
	let ground = rows(j::at(&room, "ground"));
	let (pw, ph) = (j::n(plan, "w"), j::n(plan, "h"));
	let at = match (m.get(2).cloned().flatten(), m.get(3).cloned().flatten()) { (Some(x), Some(y)) => Some((js::to_number(&x), js::to_number(&y))), _ => None };
	let water = j::b(plan, "water");
	let tries = if water { jetty_tries(c, pw, ph, at) } else { match at { Some(p) => vec![Rect { x: p.0, y: p.1, w: pw, h: ph }], None => besides(c, pw, ph) } };
	let exits = if j::b(plan, "atExit") { fields_of(exits_here(c, None).await?) } else { vec![] };
	let (green, mut rect, mut why) = (j::b(plan, "green"), None, String::new());
	for r in tries {
		let no = if water { water_refusal(&c.space, &w, &room, r).await? } else { match refusal(c, &room, r, green, green).await? {
			Some(n) => Some(n),
			None if j::b(plan, "shore") && !touches_water(&w, &ground, r) => Some("Das muss ans Wasser grenzen.".to_owned()),
			None if j::b(plan, "atExit") && !exits.iter().any(|x| dist_to(xy(x), r) <= EXIT_REACH) => Some("Das gehört neben einen Ausgang.".to_owned()),
			None => None,
		} };
		match no { None => { rect = Some(r); break; } Some(n) => if why.is_empty() { why = n; } }
	}
	let Some(rect) = rect else { return refuse(format!("Hier passt {} {pname} hin: {why}", if j::s(plan, "dative").starts_with("einem ") { "kein" } else { "keine" })) };
	let build_id = hex(&random_bytes(6));
	let now = world_now_of(&c.space, c.txn()).await?;
	let room_id = j::s(&room, "roomId").to_owned();
	for p in cells(rect) {
		let e = tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => p.0, "y" => p.1, "of" => build_id.as_str() });
		match c.space.write_unique(&e, c.txn(), FOREVER, &["room", "x", "y"]).await {
			Err(e) if e.to_string().contains("unique entry already exists") => return refuse("Dort hat gerade jemand anderes abgesteckt."),
			Err(e) => return Err(e),
			Ok(_) => {}
		}
	}
	use_light(c, &light, points).await?;
	let needs: Vec<Json> = j::a(plan, "needs").iter().map(|n| obj! { "proto" => j::at(n, "proto").clone(), "name" => proto_name(&w, j::s(n, "proto")), "count" => j::at(n, "count").clone(), "have" => 0.0 }).collect();
	let until = decay_now_of(&c.space, c.txn()).await? + j::n(def, "siteWorldMs");
	let s = obj! {
		"buildId" => build_id.as_str(), "plan" => key, "name" => j::at(plan, "name").clone(), "room" => room_id.as_str(), "x" => rect.x, "y" => rect.y, "w" => rect.w, "h" => rect.h,
		"owner" => me.as_str(), "ownerName" => j::at(&c.actor, "name").clone(), "accountId" => account_id, "needs" => Json::Array(needs), "work" => 0.0, "workNeed" => j::at(plan, "work").clone(),
		"human" => 0.0, "other" => 0.0, "beaconId" => light.beacon_id.as_str(), "points" => j::at(plan, "points").clone(), "by" => obj! {}, "untilWorldMs" => until, "at" => now
	};
	c.space.write(&tmpl("Site", s.clone()), c.txn(), FOREVER).await?;
	if dist_to(xy(&c.actor), rect) == 0.0 {
		let avoid: Vec<String> = cells(rect).iter().map(|p| cell_key(p.0, p.1)).collect();
		let off = place_in(c, &room, xy(&c.actor), false, &avoid).await?;
		relocate(c, &room_id, off, false, None).await?;
	}
	msg(c, "*", "info", &format!("{} steckt eine Baustelle ab: {pname}. Es fehlen {} – liefern („liefere <ding>“) und mitarbeiten („arbeite“) können alle.", txt(j::at(&c.actor, "name")), missing(&s).join(", ")), info()).await
}

async fn liefere(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(m) = js::caps(&js::re(r"^(?:(\d+)\s+)?(.+?)(?:\s+(?:an|zur|zu|to|für|fuer)\s+(?:die\s+|der\s+)?(.+))?$", "i"), js::trim(arg)) else { return not_understood("Was lieferst du? Zum Beispiel: liefere 3 treibholz") };
	need_rank(c, "helfer", "Liefern").await?;
	let what = m[2].clone().unwrap_or_default();
	let inv = inventory(c).await?;
	let hits = items_named(c.w(), &inv, &no_article(&what), None);
	let Some(first) = hits.first().map(|e| fields(e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&what, 0, Some(30)))) };
	let proto = j::at(&first, "proto").clone();
	// no site in reach, or the road named: a road being built beside the actor takes it (road.rs)
	let to_road = m[3].as_deref().is_some_and(|t| !t.is_empty() && js::re(r"^(?:straße|strasse|road)$", "i").test(t));
	if to_road || !site_near(c).await? {
		if let Some(road) = super::road::route_near(c).await? { return super::road::route_deliver(c, road, &what, m[1].as_deref().map(js::to_number)).await; }
	}
	let to = m[3].clone().filter(|t| !t.is_empty() && !js::re(r"^baustelle$", "i").test(t)).unwrap_or_default();
	let mut s = site_here(c, &to).await?;
	let sname = txt(j::at(&s, "name"));
	let Some(i) = j::a(&s, "needs").iter().position(|n| j::at(n, "proto") == &proto) else {
		let left = missing(&s).join(", ");
		return refuse(format!("Die {sname} braucht kein {}. Es fehlen {}.", txt(j::at(&first, "name")), if left.is_empty() { "nur noch Hände".to_owned() } else { left }));
	};
	let need = j::a(&s, "needs")[i].clone();
	let open = j::n(&need, "count") - j::n(&need, "have");
	let nname = txt(j::at(&need, "name"));
	if open <= 0.0 { return refuse(format!("{nname} hat die Baustelle genug. Es fehlen {}.", missing(&s).join(", "))); }
	let mine: Vec<Json> = inventory(c).await?.into_iter().filter(|e| j::at(fields(e), "proto") == &proto).collect();
	let asked = m[1].as_deref().map(js::to_number);
	let n = asked.unwrap_or(open).min(open).min(mine.len() as f64);
	if n <= 0.0 { return refuse(format!("Du hast kein {nname}.")); }
	let n = credit(c, &mut s, n)?;
	for it in mine.iter().take(n as usize) {
		let f = fields(it);
		if c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(f, "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar; bitte noch einmal.", txt(j::at(f, "name")))); }
	}
	if let Some(nd) = need_mut(&mut s, i) { let h = j::n(nd, "have") + n; j::set(nd, "have", h); }
	let wage = if j::s(&s, "owner") == c.char_id() { 0.0 } else { pay_for(c, j::at(&s, "buildId"), &proto, n).await? };
	let piece = format!("Stück {nname}");
	let left = missing(&s);
	let text = format!("Du lieferst {} an die {sname}.{}{}{}", plural(n, &piece, &piece), if wage > 0.0 { format!(" Lohn: {}.", plural(wage, "Münze", "Münzen")) } else { String::new() },
		if mine.len() as f64 > n && asked.is_some_and(|a| a > n) { " Den Rest braucht sie nicht; er bleibt bei dir." } else { "" },
		if left.is_empty() { String::new() } else { format!(" Es fehlen noch {}.", left.join(", ")) });
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &text, info()).await?;
	settle(c, &s).await
}

/// `rested`: refuses while the actor is tired from the last work; the world time and its rest entry.
pub async fn rested(c: &Ctx) -> Result<(f64, Option<Json>)> {
	let now = world_now_of(&c.space, c.txn()).await?;
	let rest = c.space.peek(&tmpl("WorkRest", obj! { "charId" => c.char_id() }), None).await?;
	let until = rest.as_ref().map_or(0.0, |e| j::n(fields(e), "untilWorldMs"));
	if until > now { return refuse(format!("Du bist noch müde von der letzten Arbeit; in etwa {} Minuten wieder.", nt(1f64.max(js::round((until - now) / 60_000.0))))); }
	Ok((now, rest))
}

/// `tire`: the actor worked; it rests for a while.
pub async fn tire(c: &Ctx, now: f64, rest: Option<&Json>) -> Result<()> {
	if let Some(r) = rest { c.space.take_if_exists(&obj! { "id" => j::at(r, "id").clone() }, NO_WAIT, c.txn()).await?; }
	if super::sleep::spend_rested(c).await? { return Ok(()); }
	let ms = work_rest_ms(&c.space).await? / (if blessed(c, now).await? { 2.0 } else { 1.0 }) / sated_factor(c, now).await?;
	c.space.write(&tmpl("WorkRest", obj! { "charId" => c.char_id(), "untilWorldMs" => now + ms }), c.txn(), FOREVER).await?;
	Ok(())
}

async fn arbeite(c: &mut Ctx, arg: &str) -> Result<()> {
	need_rank(c, "helfer", "Mitarbeiten").await?;
	let to_road = js::re(r"^(?:an\s+der\s+)?(?:straße|strasse|road)$", "i").test(js::trim(arg));
	if to_road || !site_near(c).await? {
		if let Some(road) = super::road::route_near(c).await? { return super::road::route_work(c, road).await; }
	}
	let (now, rest) = rested(c).await?;
	let name = js::re(r"^baustelle$", "i").replace(&js::re(r"^(?:an|auf)\s+(?:der\s+)?", "i").replace(arg, ""), "");
	let mut s = site_here(c, &name).await?;
	let sname = txt(j::at(&s, "name"));
	if j::n(&s, "work") >= j::n(&s, "workNeed") { return refuse(format!("An der {sname} ist die Arbeit getan; es fehlen nur noch {}.", missing(&s).join(", "))); }
	credit(c, &mut s, 1.0)?;
	let work = j::n(&s, "work") + 1.0;
	j::set(&mut s, "work", work);
	tire(c, now, rest.as_ref()).await?;
	let wage = if j::s(&s, "owner") == c.char_id() { 0.0 } else { pay_for(c, j::at(&s, "buildId"), &Json::from(""), 1.0).await? };
	msg(c, "*", "emote", &format!("{} arbeitet an der {sname} ({}/{}).", txt(j::at(&c.actor, "name")), nt(work), txt(j::at(&s, "workNeed"))), info()).await?;
	if wage > 0.0 { let me = c.char_id().to_owned(); msg(c, &me, "info", &format!("Lohn: {}.", plural(wage, "Münze", "Münzen")), info()).await?; }
	settle(c, &s).await
}

async fn baustelle(c: &mut Ctx, arg: &str) -> Result<()> {
	let at = js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(arg)).map(|m| (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[2].as_deref().unwrap_or(""))));
	let here = |all: Vec<Json>| -> Vec<Json> { match at { Some(p) => all.into_iter().filter(|r| dist_to(p, Rect::of(r)) == 0.0).collect(), None => all } };
	let room = c.room().to_owned();
	let sites = here(fields_of(c.space.read_all(&tmpl("Site", obj! { "room" => room.as_str() }), None).await?));
	let built = here(fields_of(c.space.read_all(&tmpl("Building", obj! { "room" => room.as_str() }), None).await?));
	let ruins = here(fields_of(c.space.read_all(&tmpl("Ruin", obj! { "room" => room.as_str() }), None).await?));
	let me = c.char_id().to_owned();
	if sites.is_empty() && built.is_empty() && ruins.is_empty() { return msg(c, &me, "info", "Hier wird nichts gebaut. „bau“ zeigt die Baupläne.", info()).await; }
	// a building's term is on the second clock (decayNowOf, as `repariere` and the sweep count it), not the world's
	let now = decay_now_of(&c.space, c.txn()).await?;
	let mut lines: Vec<String> = Vec::new();
	let mut wages: Vec<String> = Vec::new();
	for s in &sites { let o = orders_of_site(&c.space, j::at(s, "buildId"), None).await?; wages.push(if o.is_empty() { String::new() } else { format!(" Lohn: {}.", o.iter().map(order_line).collect::<Vec<_>>().join("; ")) }); }
	for (s, wage) in sites.iter().zip(&wages) {
		let who = if mine(c, s) { format!("Deine Baustelle {}", txt(j::at(s, "name"))) } else { format!("Baustelle {} von {}", txt(j::at(s, "name")), txt(j::at(s, "ownerName"))) };
		lines.push(format!("{who}: es fehlen {}.{wage}", missing(s).join(", ")));
	}
	for b in &built { lines.push(format!("{} von {}: hält noch {} („repariere“ bessert sie aus).", txt(j::at(b, "name")), txt(j::at(b, "ownerName")), days(j::n(b, "untilWorldMs") - now))); }
	for r in &ruins { lines.push(format!("Ruine einer {} von {}.", txt(j::at(r, "name")), txt(j::at(r, "ownerName")))); }
	msg(c, &me, "look", &lines.join("\n"), info()).await
}

/// `buildingHere`: a building beside the actor (by plan name when given; only one's own with `own`), taken in the
/// transaction.
pub async fn building_here(c: &Ctx, name: &str, own: bool) -> Result<Json> { building_here_for(c, name, own, None).await }
/// `buildingHere` with `use`: inside, beside the furnishing for it (interior.rs `near_buildings`).
pub async fn building_here_for(c: &Ctx, name: &str, own: bool, use_: Option<&str>) -> Result<Json> {
	let all = super::interior::near_buildings(c, use_).await?;
	let n = no_article(js::trim(name));
	let near: Vec<&Json> = all.iter().filter(|b| n.is_empty() || plan_of(c.w(), &n).is_some_and(|p| j::at(p, "key") == j::at(b, "plan")) || txt(j::at(b, "name")).to_lowercase() == n.to_lowercase()).collect();
	let mine_near: Vec<&Json> = near.iter().copied().filter(|b| mine(c, b)).collect();
	let pick = if own { mine_near.first() } else { mine_near.first().or(near.first()) };
	let Some(b) = pick else { return not_understood(if own { if near.is_empty() { "Geh direkt neben deinen Bau." } else { "Das ist nicht dein Bau." } } else { "Geh direkt neben den Bau." }) };
	let Some(e) = c.space.take(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), 5_000.0, c.txn()).await? else { return refuse("Der Bau ist gerade nicht greifbar; bitte noch einmal.") };
	Ok(fields(&e).clone())
}
/// `logGone`: one line in the world's log when a building goes, with why: an operator can tell later what took it.
pub fn log_gone(b: &Json, why: &str) {
	let t = |k: &str| crate::fire::key_text(j::at(b, k));
	let owner = j::so(b, "ownerName").unwrap_or("?");
	eprintln!("[world] building gone: {} {} of {owner} in {} at {},{}: {why}", t("buildId"), t("plan"), t("room"), t("x"), t("y"));
}
/// `putBack`.
pub async fn put_back(c: &Ctx, b: &Json) -> Result<()> { c.space.write(&tmpl("Building", b.clone()), c.txn(), FOREVER).await.map(|_| ()) }

/// `moveItem`: a thing (taken in the transaction) to `to`.
pub async fn move_item(space: &Space, txn: Option<&str>, item_id: &Json, from: &str, to: &str) -> Result<bool> {
	let Some(e) = space.take_if_exists(&tmpl("Item", obj! { "itemId" => item_id.clone(), "location" => from }), NO_WAIT, txn).await? else { return Ok(false) };
	let mut f = j::object(fields(&e));
	f.insert("location", Json::from(to));
	f.insert("x", Json::from(-1.0));
	f.insert("y", Json::from(-1.0));
	space.write(&anew(&e, Json::Object(f)), txn, FOREVER).await?;
	Ok(true)
}

/// `amount`: "3 holz", "alle muscheln", "tang": how many (None: all) and what.
pub fn amount(arg: &str) -> (Option<f64>, String) {
	let a = js::re(r"\s+(?:in|aus|from|into)\s+(?:die\s+|der\s+)?(?:truhe|kiste|chest|lager|lagerhaus|warehouse)$", "i").replace(js::trim(arg), "");
	let Some(m) = js::caps(&js::re(r"^(?:(\d+|alle?|all)\s+)?(.+)$", "i"), &a) else { return (Some(1.0), String::new()) };
	let n = match m[1].as_deref() { None | Some("") => Some(1.0), Some(d) if js::re(r"^\d+$", "").test(d) => Some(js::to_number(d)), Some(_) => None };
	(n, no_article(m[2].as_deref().unwrap_or("")))
}
/// `days`: "etwa 3 Tage", "etwa 5 Stunden".
pub fn days(ms: f64) -> String {
	let d = js::round(ms / WORLD_DAY);
	if d >= 1.0 { format!("etwa {} {}", nt(d), if d == 1.0 { "Tag" } else { "Tage" }) } else { format!("etwa {} Stunden", nt(1f64.max(js::round(ms / 3_600_000.0)))) }
}

fn keeper_proto(w: &Json, proto: &Json) -> bool { j::a(j::at(w, "wild"), "keepers").iter().any(|k| j::at(k, "proto") == proto) }
/// `chestOf`: what lies in a building's chest (without a dog or cat on guard).
async fn chest_of(c: &Ctx, build_id: &Json) -> Result<Vec<Json>> {
	Ok(c.space.read_all(&tmpl("Item", obj! { "location" => build_id.clone() }), None).await?.into_iter().filter(|e| !keeper_proto(c.w(), j::at(fields(e), "proto"))).collect())
}
fn no_chest(c: &Ctx, b: &Json) -> Error {
	let have: Vec<String> = j::a(j::at(c.w(), "building"), "plans").iter().filter(|p| j::b(p, "chest") && !j::b(p, "store")).map(|p| txt(j::at(p, "name"))).collect();
	let name = txt(j::at(b, "name"));
	Error::Command(if have.is_empty() { format!("Die {name} hat keine Truhe.") } else { format!("Die {name} hat keine Truhe (eine haben: {}).", have.join(", ")) })
}
/// `chestHere`: one's own chest beside the actor first, else a warehouse.
async fn chest_here(c: &Ctx) -> Result<Json> {
	let near = super::interior::near_buildings(c, Some("chest")).await?;
	let own = near.iter().find(|b| mine(c, b) && plan_has(c.w(), j::at(b, "plan"), "chest") && !plan_has(c.w(), j::at(b, "plan"), "store"));
	let store = near.iter().find(|b| plan_has(c.w(), j::at(b, "plan"), "store"));
	if near.is_empty() && super::interior::is_interior(c.room()) { return not_understood("Geh zur Truhe; an ihr legt man ab und nimmt heraus."); }
	match (own, store) {
		(Some(_), _) | (None, None) => building_here_for(c, &own.map_or_else(String::new, |b| txt(j::at(b, "plan"))), true, Some("chest")).await,
		(None, Some(s)) => building_here_for(c, &txt(j::at(s, "plan")), false, Some("chest")).await,
	}
}

/// `storeRight`: how much the actor may still take from a warehouse today (None: no quota).
async fn store_right(c: &Ctx, b: &Json) -> Result<(f64, Option<f64>)> {
	let d = j::opt(j::at(c.w(), "building"), "store");
	let s = settlement_in(&c.space, c.room(), c.txn()).await?;
	let (Some(d), Some(s)) = (d, s) else {
		if mine(c, b) { return Ok((f64::INFINITY, None)); }
		return refuse(format!("Dieses Lagerhaus gehört {}; allen dient es erst in einer Siedlung.", txt(j::at(b, "ownerName"))));
	};
	let rank = rank_of(&s, &huts_in(&c.space, c.w(), j::s(&s, "room"), c.txn()).await?, c.account.as_ref());
	if j::b(&s, "closed") && rank == "fremder" { return refuse(format!("{} ist geschlossen: an das Lager dürfen nur Helfer und Siedler.", txt(j::at(&s, "name")))); }
	let now = world_now_of(&c.space, c.txn()).await?;
	let account = c.account.as_ref().map_or(Json::from(""), |a| j::at(a, "accountId").clone());
	let lines = fields_of(c.space.read_all(&tmpl("StoreLog", obj! { "buildId" => j::at(b, "buildId").clone(), "accountId" => account, "kind" => "aus" }), None).await?);
	let taken: f64 = lines.iter().filter(|l| j::n(l, "worldMs") > now - WORLD_DAY).map(|l| j::n(l, "count")).sum();
	let quota = j::n(j::at(d, "quota"), &rank);
	Ok(((quota - taken).max(0.0), Some(quota)))
}
async fn log_store(c: &Ctx, b: &Json, kind: &str, item_name: &Json, count: f64) -> Result<()> {
	let log_id = hex(&random_bytes(6));
	let account = c.account.as_ref().map_or(Json::from(""), |a| j::at(a, "accountId").clone());
	let world_ms = world_now_of(&c.space, c.txn()).await?;
	let line = obj! { "logId" => log_id, "buildId" => j::at(b, "buildId").clone(), "accountId" => account, "name" => j::at(&c.actor, "name").clone(), "kind" => kind, "itemName" => item_name.clone(), "count" => count, "worldMs" => world_ms, "at" => time_now() };
	c.space.write(&tmpl("StoreLog", line), c.txn(), j::no(j::at(j::at(c.w(), "building"), "store"), "logKeepMs").unwrap_or(WORLD_DAY)).await.map(|_| ())
}

fn counted(items: &[Json]) -> String {
	let mut count: Vec<(String, usize)> = Vec::new();
	for i in items { let n = txt(j::at(fields(i), "name")); match count.iter_mut().find(|(k, _)| *k == n) { Some(s) => s.1 += 1, None => count.push((n, 1)) } }
	count.iter().map(|(n, k)| format!("{k} {n}")).collect::<Vec<_>>().join(", ")
}

async fn lager(c: &mut Ctx, arg: &str) -> Result<()> {
	let me = xy(&c.actor);
	let near = fields_of(c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?);
	let Some(b) = near.iter().find(|x| plan_has(c.w(), j::at(x, "plan"), "store") && dist_to(me, Rect::of(x)) <= 1.0).cloned() else { return not_understood("Geh direkt neben ein Lagerhaus.") };
	let right = store_right(c, &b).await?;
	let who = c.char_id().to_owned();
	let a = js::trim(arg);
	if js::re(r"^(?:log|protokoll|buch)$", "i").test(a) {
		let mut lines = fields_of(c.space.read_all(&tmpl("StoreLog", obj! { "buildId" => j::at(&b, "buildId").clone() }), None).await?);
		lines.sort_by(|x, y| { let d = j::n(y, "worldMs") - j::n(x, "worldMs"); let d = if d != 0.0 && !d.is_nan() { d } else { j::n(y, "at") - j::n(x, "at") }; d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal) });
		let show_n = j::no(j::at(j::at(c.w(), "building"), "store"), "logShow").unwrap_or(10.0) as usize;
		let show: Vec<String> = lines.iter().take(show_n).map(|l| format!("  {} {}: {} {}", txt(j::at(l, "name")), if j::s(l, "kind") == "aus" { "nimmt" } else { "legt ein" }, txt(j::at(l, "count")), txt(j::at(l, "itemName")))).collect();
		let text = if show.is_empty() { "Das Lagerbuch ist leer.".to_owned() } else { std::iter::once("Das Lagerbuch:".to_owned()).chain(show).collect::<Vec<_>>().join("\n") };
		return msg(c, &who, "look", &text, info()).await;
	}
	if !a.is_empty() { return not_understood("„lager“ zeigt das Lager, „lager log“ das Lagerbuch. Einlagern: verstaue <ding>, nehmen: entnimm <ding>."); }
	let inside = chest_of(c, j::at(&b, "buildId")).await?;
	let cap = cap_of(c.w(), &b);
	let head = if !inside.is_empty() { format!("Im Lager ({}): {}.", held_text(c.w(), &inside, cap), counted(&inside)) } else if cap == f64::INFINITY { "Das Lager ist leer.".to_owned() } else { format!("Das Lager ist leer (Platz für {}).", nt(cap)) };
	let quota = right.1.map_or_else(String::new, |q| format!(" Du darfst heute noch {} von {} Dingen nehmen.", nt(right.0), nt(q)));
	msg(c, &who, "look", &format!("{head}{quota}"), info()).await
}

async fn truhe(c: &mut Ctx) -> Result<()> {
	let b = chest_here(c).await?;
	put_back(c, &b).await?;
	if plan_has(c.w(), j::at(&b, "plan"), "store") { return lager(c, "").await; }
	if !plan_has(c.w(), j::at(&b, "plan"), "chest") { return Err(no_chest(c, &b)); }
	let cap = cap_of(c.w(), &b);
	let items = chest_of(c, j::at(&b, "buildId")).await?;
	let text = if !items.is_empty() { format!("In der Truhe ({}): {}.", held_text(c.w(), &items, cap), counted(&items)) } else if cap == f64::INFINITY { "Die Truhe ist leer.".to_owned() } else { format!("Die Truhe ist leer (Platz für {}).", nt(cap)) };
	let me = c.char_id().to_owned();
	msg(c, &me, "look", &text, info()).await
}

/// `OwnChest`: a chest of one's own, wherever it stands: here (`region` None) or in another region's space.
#[derive(Clone)]
pub struct OwnChest { pub b: Json, pub region: Option<String>, pub space: Space }

/// `ownChests`: one's chests in every region (a warehouse is not one's chest), in the order the lists number them
/// (`chestOrder`).
pub async fn own_chests(c: &Ctx) -> Result<Vec<OwnChest>> {
	let Some(a) = &c.account else { return Ok(vec![]) };
	let w = c.w();
	let t = tmpl("Building", obj! { "accountId" => j::at(a, "accountId").clone() });
	let chest = |b: &Json| plan_has(w, j::at(b, "plan"), "chest") && !plan_has(w, j::at(b, "plan"), "store");
	let mut all: Vec<OwnChest> = fields_of(c.space.read_all(&t, c.txn()).await?).into_iter().filter(|b| chest(b)).map(|b| OwnChest { b, region: None, space: c.space.clone() }).collect();
	for (region, space) in &c.elsewhere {
		let Ok(there) = space.read_all(&t, None).await else { continue };
		all.extend(fields_of(there).into_iter().filter(|b| chest(b)).map(|b| OwnChest { b, region: Some(region.clone()), space: space.clone() }));
	}
	all.sort_by(|x, y| js::locale_compare(&all_room_name(w, j::s(&x.b, "room")), &all_room_name(w, j::s(&y.b, "room"))).then_with(|| phi_json::utf16_cmp(j::s(&x.b, "buildId"), j::s(&y.b, "buildId"))));
	Ok(all)
}
fn chest_label(w: &Json, b: &Json) -> String { format!("{} ({})", txt(j::at(b, "name")), all_room_name(w, j::s(b, "room"))) }
fn numbered(w: &Json, list: &[OwnChest]) -> String { list.iter().enumerate().map(|(i, x)| format!("{} {}", i + 1, chest_label(w, &x.b))).collect::<Vec<_>>().join(", ") }

/// `chestNamed`: the chest `target` names ("2", "hütte", "die hütte in den dünen"); none named: the one beside, else the
/// only one.
async fn chest_named(c: &Ctx, target: &str) -> Result<OwnChest> {
	let all = own_chests(c).await?;
	if all.is_empty() { return refuse("Du hast keine Truhe: eine Hütte hat eine („bau hütte“)."); }
	let w = c.w();
	let t = js::re(r"^(?:meine[nm]?|my)\s+", "").replace(&no_article(&js::trim(target).to_lowercase()), "");
	let me = xy(&c.actor);
	let beside = |list: &[&OwnChest]| list.iter().find(|x| x.region.is_none() && j::s(&x.b, "room") == c.room() && dist_to(me, Rect::of(&x.b)) <= 1.0).map(|x| (*x).clone());
	if t.is_empty() || js::re(r"^(?:truhe|kiste|chest)$", "").test(&t) {
		// inside one's hut: its chest
		let inside = all.iter().find(|x| x.region.is_none() && if j::s(&x.b, "room") == c.room() { dist_to(me, Rect::of(&x.b)) <= 1.0 } else { c.room() == super::interior::interior_of(j::s(&x.b, "buildId")) });
		if let Some(b) = inside { return Ok(b.clone()); }
		if all.len() == 1 { return Ok(all[0].clone()); }
		return refuse(format!("In welche Truhe? {}. Sag zum Beispiel „verstaue 3 muscheln in 2“.", numbered(w, &all)));
	}
	if let Some(nr) = js::caps(&js::re(r"^(?:(?:truhe|kiste|chest|nr\.?)\s*)?(\d+)$", ""), &t) {
		let k = nr[1].clone().unwrap_or_default();
		let i = js::to_number(&k);
		return match all.get((i - 1.0) as usize).filter(|_| i >= 1.0) { Some(b) => Ok(b.clone()), None => refuse(format!("Eine Truhe {k} hast du nicht (1 bis {}).", all.len())) };
	}
	let stop = js::re(r"^(?:in|im|am|an|auf|bei|der|die|das|den|dem|des|von|truhe|kiste)$", "");
	let words: Vec<String> = js::re(r"\s+", "").split(&t).into_iter().map(|p| p.unwrap_or("").to_owned()).filter(|x| js::len16(x) > 2 && !stop.test(x)).collect();
	let names = |b: &Json| {
		let mut v = vec![txt(j::at(b, "name"))];
		if let Some(p) = plan_of(w, &txt(j::at(b, "plan"))) { v.extend(j::strs(j::a(p, "aliases")).into_iter().map(str::to_owned)); }
		v.push(all_room_name(w, j::s(b, "room")));
		v.join(" ").to_lowercase()
	};
	let fits: Vec<&OwnChest> = all.iter().filter(|x| !words.is_empty() && words.iter().all(|k| names(&x.b).contains(k.as_str()))).collect();
	if fits.len() == 1 { return Ok(fits[0].clone()); }
	let index = |b: &OwnChest| all.iter().position(|x| std::ptr::eq(x, b)).map_or(0, |i| i + 1);
	if fits.len() > 1 {
		if let Some(b) = beside(&fits) { return Ok(b); }
		return refuse(format!("Das passt auf mehrere Truhen: {}. Sag die Nummer, etwa „verstaue 3 muscheln in {}“.", fits.iter().map(|x| format!("{} {}", index(x), chest_label(w, &x.b))).collect::<Vec<_>>().join(", "), index(fits[0])));
	}
	refuse(format!("Eine Truhe „{}“ hast du nicht. Deine Truhen: {}.", js::slice16(js::trim(target), 0, Some(30)), numbered(w, &all)))
}

/// `chestForSale`: what a chest of one's own holds, for the market.
pub async fn chest_for_sale(c: &Ctx, target: &str) -> Result<(Json, Vec<Json>)> {
	let chest = chest_named(c, target).await?;
	if chest.region.is_some() { return refuse(format!("Die Truhe deiner {} steht in einer anderen Gegend; was darin liegt, hängst du an ein Marktbrett dort.", chest_label(c.w(), &chest.b))); }
	let b = chest.b;
	let items = chest_of(c, j::at(&b, "buildId")).await?;
	Ok((b, items))
}

fn held_in(w: &Json, items: &[Json]) -> f64 { if j::opt(w, "pack").is_some() { items.iter().map(|i| load_of(w, j::so(fields(i), "proto"))).sum() } else { items.len() as f64 } }
fn weight(w: &Json, proto: &Json) -> f64 { if j::opt(w, "pack").is_some() { load_of(w, proto.as_str()) } else { 1.0 } }
fn cap_of(w: &Json, b: &Json) -> f64 { if j::opt(w, "pack").is_some() { f64::INFINITY } else { plan_of(w, &txt(j::at(b, "plan"))).and_then(|p| j::no(p, "chest")).unwrap_or(0.0) } }
fn held_text(w: &Json, items: &[Json], cap: f64) -> String { if cap == f64::INFINITY { format!("Last {}", fmt_load(held_in(w, items))) } else { format!("{}/{}", nt(held_in(w, items)), nt(cap)) } }
fn store_arg(arg: &str) -> (String, String) {
	match js::caps(&js::re(r"^(.+?)\s+(?:in|ins|nach|into|to)\s+(.+)$", "i"), js::trim(arg)) { Some(m) => (m[1].clone().unwrap_or_default(), m[2].clone().unwrap_or_default()), None => (arg.to_owned(), String::new()) }
}

/// At most this many things move in one command; more follows as the same command again.
pub const MOVES_PER_COMMAND: f64 = 100.0;
/// `goOn`: the rest of a command that moved MOVES_PER_COMMAND things, as the character's next intent.
async fn go_on(c: &Ctx, line: &str) -> Result<()> {
	let id = hex(&random_bytes(8));
	let mut f = obj! { "intentId" => id, "charId" => c.char_id(), "line" => line, "at" => time_now() };
	if let Some(l) = &c.lang { j::set(&mut f, "lang", l.as_str()); }
	c.space.write(&tmpl("Intent", f), c.txn(), 30_000.0).await.map(|_| ())
}
fn rest_of(n: Option<f64>, left: f64) -> String { n.map_or_else(|| "alle".to_owned(), |_| nt(left)) }
const GOING_ON: &str = " Den Rest legst du gleich nach.";
fn fit_of(n: Option<f64>, all: usize, room: f64, each: f64) -> f64 { let all = all as f64; n.unwrap_or(all).min(all).min(if each != 0.0 { (room / each + 1e-9).floor() } else { all }) }

async fn verstaue(c: &mut Ctx, arg: &str) -> Result<()> {
	let (what, target) = store_arg(arg);
	let (n, name) = amount(&what);
	let inv = inventory(c).await?;
	let hits = items_named(c.w(), &inv, &name, None);
	let Some(first) = hits.first().map(|e| fields(e).clone()) else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&name, 0, Some(30)))) };
	// a dog or cat is no thing for a chest: in it, neither „truhe“ nor „entnimm“ would see it (chest_of), it guards instead
	if let Some(kp) = j::a(j::at(c.w(), "wild"), "keepers").iter().find(|k| j::at(k, "proto") == j::at(&first, "proto")) {
		return refuse(format!("{} kommt nicht in die Truhe; neben deinem Bau lässt „einstallen {}“ {} dort wachen.", j::s(kp, "name"), j::s(kp, "key"), j::s(kp, "acc")));
	}
	let me = xy(&c.actor);
	let near: Vec<Json> = fields_of(c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?).into_iter().filter(|b| dist_to(me, Rect::of(b)) <= 1.0).collect();
	let own_beside = near.iter().any(|b| mine(c, b) && plan_has(c.w(), j::at(b, "plan"), "chest") && !plan_has(c.w(), j::at(b, "plan"), "store"));
	let store_beside = near.iter().find(|b| plan_has(c.w(), j::at(b, "plan"), "store")).cloned();
	let proto = j::at(&first, "proto").clone();
	let all: Vec<Json> = inventory(c).await?.into_iter().filter(|i| j::at(fields(i), "proto") == &proto).collect();
	let each = weight(c.w(), &proto);
	let iname = txt(j::at(&first, "name"));
	let who = c.char_id().to_owned();
	let more_of = |target: &str, rest: String| format!("verstaue {rest} {name}{}", if target.is_empty() { String::new() } else { format!(" in {target}") });
	let wanted = n.unwrap_or(all.len() as f64).min(all.len() as f64);
	if let Some(sb) = store_beside.filter(|_| !own_beside && (target.is_empty() || js::re(r"^(?:das\s+)?(?:lager|lagerhaus|warehouse)$", "i").test(js::trim(&target)))) {
		let b = building_here(c, &txt(j::at(&sb, "plan")), false).await?;
		store_right(c, &b).await?;
		let cap = cap_of(c.w(), &b);
		let room = if cap == f64::INFINITY { f64::INFINITY } else { cap - held_in(c.w(), &chest_of(c, j::at(&b, "buildId")).await?) };
		let fit = fit_of(n, all.len(), room, each);
		let k = fit.min(MOVES_PER_COMMAND);
		if k <= 0.0 { return refuse(format!("Das Lager ist voll ({}).", nt(cap))); }
		let mut moved = 0.0;
		let bid = txt(j::at(&b, "buildId"));
		for it in all.iter().take(k as usize) { if move_item(&c.space, c.txn(), j::at(fields(it), "itemId"), &who, &bid).await? { moved += 1.0; } }
		put_back(c, &b).await?;
		log_store(c, &b, "ein", j::at(&first, "name"), moved).await?;
		let later = k < fit && moved == k;
		if later { go_on(c, &more_of(&target, rest_of(n, fit - k))).await?; }
		return msg(c, &who, "info", &format!("Du legst {} {iname} in das Lager.{}", nt(moved), if later { GOING_ON } else if fit < wanted { " Mehr passt nicht hinein." } else { "" }), info()).await;
	}
	let own = chest_named(c, &target).await?;
	let chest = own.b.clone();
	let cap = cap_of(c.w(), &chest);
	let bid = txt(j::at(&chest, "buildId"));
	let mut room = f64::INFINITY;
	if cap != f64::INFINITY {
		let txn = if own.region.is_none() { c.txn() } else { None };
		let inside: Vec<Json> = own.space.read_all(&tmpl("Item", obj! { "location" => bid.as_str() }), txn).await?.into_iter().filter(|e| !keeper_proto(c.w(), j::at(fields(e), "proto"))).collect();
		// what is on its way there by courier counts as in it
		let coming: f64 = if own.region.is_none() { 0.0 } else { c.space.read_all(&tmpl("Courier", obj! { "buildId" => bid.as_str() }), c.txn()).await?.iter().map(|e| j::number(j::at(fields(e), "count"))).sum() };
		room = cap - held_in(c.w(), &inside) - coming;
	}
	let fit = fit_of(n, all.len(), room, each);
	let k = fit.min(MOVES_PER_COMMAND);
	let label = chest_label(c.w(), &chest);
	if k <= 0.0 { return refuse(format!("Die Truhe deiner {label} ist voll ({}).", nt(cap))); }
	let beside = own.region.is_none() && j::s(&chest, "room") == c.room() && dist_to(me, Rect::of(&chest)) <= 1.0;
	let mut moved = 0.0;
	if let Some(region) = &own.region {
		// another region: a courier carries them (courier.rs); until then they lie with it, out of anyone's reach
		let courier_id = format!("cou-{}", hex(&random_bytes(6)));
		for it in all.iter().take(k as usize) { if move_item(&c.space, c.txn(), j::at(fields(it), "itemId"), &who, &courier_id).await? { moved += 1.0; } }
		let f = obj! { "courierId" => courier_id.as_str(), "to" => region.as_str(), "buildId" => bid.as_str(), "accountId" => j::at(&chest, "accountId").clone(), "ownerName" => j::at(&chest, "ownerName").clone(), "room" => j::at(&chest, "room").clone(), "name" => j::at(&chest, "name").clone(), "proto" => proto.clone(), "count" => moved, "at" => time_now() };
		c.space.write(&tmpl("Courier", f), c.txn(), FOREVER).await?;
	} else {
		for it in all.iter().take(k as usize) { if move_item(&c.space, c.txn(), j::at(fields(it), "itemId"), &who, &bid).await? { moved += 1.0; } }
	}
	let later = k < fit && moved == k;
	if later { go_on(c, &more_of(&target, rest_of(n, fit - k))).await?; }
	let more = if later { GOING_ON } else if fit < wanted { " Mehr passt nicht hinein." } else { "" };
	let text = if beside { format!("Du legst {} {iname} in die Truhe.{more}", nt(moved)) } else if own.region.is_none() { format!("Du legst {} {iname} in die Truhe deiner {label}.{more}", nt(moved)) } else { format!("Ein Bote bringt {} {iname} in die Truhe deiner {label}.{more}", nt(moved)) };
	msg(c, &who, "info", &text, info()).await
}

async fn entnimm(c: &mut Ctx, arg: &str) -> Result<()> {
	// „entnimm 5 käse aus der truhe“ (also mistyped „true“): the place is the chest beside one anyway
	let (n, name) = amount(&js::re(r"\s+aus\s+(?:der\s+|dem\s+)?(?:truhe|true|kiste|lager)\b.*$", "i").replace(arg, ""));
	let b = chest_here(c).await?;
	let shared = plan_has(c.w(), j::at(&b, "plan"), "store");
	let left = if shared { store_right(c, &b).await?.0 } else { f64::INFINITY };
	if left <= 0.0 { return refuse("Für heute hast du aus dem Lager genommen, was dir zusteht."); }
	let bid = txt(j::at(&b, "buildId"));
	let inside = chest_of(c, j::at(&b, "buildId")).await?;
	let hits = items_named(c.w(), &inside, &name, None);
	let Some(first) = hits.first().map(|e| fields(e).clone()) else { return not_understood(format!("In der Truhe ist nichts, was „{}“ heißt.", js::slice16(&name, 0, Some(30)))) };
	let proto = j::at(&first, "proto").clone();
	let all: Vec<&Json> = inside.iter().filter(|i| j::at(fields(i), "proto") == &proto).collect();
	let want = n.unwrap_or(all.len() as f64).min(all.len() as f64);
	let currency = j::at(c.w(), "currency").clone();
	let tax = if shared && proto != currency { settlement_in(&c.space, c.room(), c.txn()).await?.and_then(|s| j::no(&s, "tax")).unwrap_or(0.0) } else { 0.0 };
	let coins: Vec<Json> = if tax != 0.0 { inventory(c).await?.into_iter().filter(|i| j::at(fields(i), "proto") == &currency).collect() } else { vec![] };
	let payable = if tax != 0.0 { (coins.len() as f64 / tax).floor() } else { f64::INFINITY };
	if payable == 0.0 { return refuse(format!("Das Lager nimmt {} Münzen Steuer je Stück; so viele hast du nicht.", nt(tax))); }
	let who = c.char_id().to_owned();
	let each = if j::opt(c.w(), "pack").is_some() { load_of(c.w(), proto.as_str()) } else { 0.0 };
	let free = if each != 0.0 { pack_max(&c.space, c.w(), Some(&who), c.txn()).await? - load_at(&c.space, c.w(), &who, c.txn()).await? } else { f64::INFINITY };
	let fits = if each != 0.0 { 0f64.max((free / each + 1e-9).floor()) } else { f64::INFINITY };
	if fits == 0.0 { return refuse(format!("Das trägst du nicht mehr: dein Gepäck ist voll ({} von {} Last).", fmt_load(load_at(&c.space, c.w(), &who, c.txn()).await?), fmt_load(pack_max(&c.space, c.w(), Some(&who), c.txn()).await?))); }
	let take = want.min(left).min(payable).min(fits);
	let k = take.min(1f64.max((MOVES_PER_COMMAND / (1.0 + tax)).floor()));
	let mut moved = 0.0;
	for it in all.iter().take(k as usize) { if move_item(&c.space, c.txn(), j::at(fields(it), "itemId"), &bid, &who).await? { moved += 1.0; } }
	for coin in coins.iter().take((moved * tax) as usize) {
		if !move_item(&c.space, c.txn(), j::at(fields(coin), "itemId"), &who, &bid).await? { return refuse("Die Münzen sind gerade nicht greifbar; bitte noch einmal."); }
	}
	put_back(c, &b).await?;
	if shared { log_store(c, &b, "aus", j::at(&first, "name"), moved).await?; }
	let later = k < take && moved == k;
	if later { go_on(c, &format!("entnimm {} {name}", rest_of(n, take - k))).await?; }
	let why = if later { " Den Rest nimmst du gleich nach." } else if want > take { if fits < left.min(payable) { " Mehr trägst du nicht." } else if payable < left { " Für mehr reichen deine Münzen nicht." } else { " Mehr steht dir heute nicht zu." } } else { "" };
	let text = format!("Du nimmst {} {} aus {}.{}{why}", nt(moved), txt(j::at(&first, "name")), if shared { "dem Lager" } else { "der Truhe" }, if tax != 0.0 { format!(" {} Münzen Steuer bleiben im Lager.", nt(moved * tax)) } else { String::new() });
	msg(c, &who, "info", &text, info()).await
}

async fn repariere(c: &mut Ctx, arg: &str) -> Result<()> {
	let b = building_here(c, arg, false).await?;
	let w = c.world.clone();
	let plan = plan_of(&w, &txt(j::at(&b, "plan")));
	let cost: Vec<Json> = plan.map(|p| j::a(p, "repair").to_vec()).unwrap_or_default();
	let inv = inventory(c).await?;
	let of = |proto: &Json| -> Vec<&Json> { inv.iter().filter(|i| j::at(fields(i), "proto") == proto).collect() };
	for r in &cost { if (of(j::at(r, "proto")).len() as f64) < j::n(r, "count") { return refuse(format!("Zum Ausbessern brauchst du {} {}.", txt(j::at(r, "count")), proto_name(&w, j::s(r, "proto")))); } }
	for r in &cost {
		for it in of(j::at(r, "proto")).into_iter().take(j::n(r, "count") as usize) { c.space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(it), "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await?; }
	}
	let now = decay_now_of(&c.space, c.txn()).await?;
	let until = now + keep_of(c, plan).await?;
	let mut nb = b.clone();
	j::set(&mut nb, "untilWorldMs", until);
	put_back(c, &nb).await?;
	if !mine(c, &b) { credit_deed(c, "bau").await?; }
	msg(c, "*", "emote", &format!("{} bessert die {} von {} aus; sie hält wieder {}.", txt(j::at(&c.actor, "name")), txt(j::at(&b, "name")), txt(j::at(&b, "ownerName")), days(until - now)), info()).await
}

/// `giveBack`: `count` of each prototype into the actor's pack.
pub async fn give_back(c: &Ctx, what: &[(String, f64)]) -> Result<Vec<String>> {
	let mut out = Vec::new();
	for (proto, count) in what {
		if *count <= 0.0 { continue; }
		let Some(p) = resolve_prototype(&c.space, proto).await? else { continue };
		for _ in 0..(*count as usize) { spawn(&c.space, c.txn(), c.w(), &p, At { location: c.char_id().to_owned(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
		out.push(format!("{} {}", nt(*count), txt(j::at(&p, "name"))));
	}
	Ok(out)
}
/// `releaseLight`: gives a fire back the light a site or building took.
pub async fn release_light(space: &Space, txn: &str, beacon_id: &Json, points: f64) -> Result<()> {
	if let Some(l) = space.take_if_exists(&tmpl("LightUse", obj! { "beaconId" => beacon_id.clone() }), 5_000.0, Some(txn)).await? {
		space.write(&tmpl("LightUse", obj! { "beaconId" => beacon_id.clone(), "used" => (j::n(fields(&l), "used") - points).max(0.0) }), Some(txn), FOREVER).await?;
	}
	Ok(())
}
fn points_of(f: &Json) -> f64 { j::no(f, "points").unwrap_or(1.0) }

async fn abriss(c: &mut Ctx, arg: &str) -> Result<()> {
	let name = js::re(r"^baustelle$", "i").replace(&js::re(r"^(?:die|den|das|meine?n?)\s+", "i").replace(&js::re(r"\s+ab$", "i").replace(arg, ""), ""), "");
	let me = xy(&c.actor);
	let actor = txt(j::at(&c.actor, "name"));
	let sites = fields_of(c.space.read_all(&tmpl("Site", obj! { "room" => c.room() }), None).await?);
	let site = sites.iter().find(|s| dist_to(me, Rect::of(s)) <= 1.0 && mine(c, s));
	if let Some(site) = site.filter(|s| name.is_empty() || js::re("baustelle", "i").test(arg) || plan_of(c.w(), &name).is_some_and(|p| j::at(p, "key") == j::at(s, "plan"))) {
		if c.space.take_if_exists(&tmpl("Site", obj! { "buildId" => j::at(site, "buildId").clone() }), 5_000.0, c.txn()).await?.is_none() { return refuse("Die Baustelle ist gerade nicht greifbar; bitte noch einmal."); }
		let back = give_back(c, &j::a(site, "needs").iter().map(|n| (txt(j::at(n, "proto")), j::n(n, "have"))).collect::<Vec<_>>()).await?;
		let until = kept_until(c).await?;
		close_orders(&c.space, &c.txn, site, until).await?;
		free_cells(&c.space, &c.txn, j::s(site, "room"), j::at(site, "buildId")).await?;
		release_light(&c.space, &c.txn, j::at(site, "beaconId"), points_of(site)).await?;
		return msg(c, "*", "info", &format!("{actor} gibt die Baustelle {} auf.{}", txt(j::at(site, "name")), if back.is_empty() { String::new() } else { format!(" Zurück an {actor}: {}.", back.join(", ")) }), info()).await;
	}
	let ruin_name = js::re(r"^ruine?\s*(?:(?:der|des|einer|eines|von|of the|of)\s+)?", "i").replace(&name, "");
	let own_near = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().any(|e| { let b = fields(e); mine(c, b) && dist_to(me, Rect::of(b)) <= 1.0 });
	let ruins: Vec<Json> = fields_of(c.space.read_all(&tmpl("Ruin", obj! { "room" => c.room() }), None).await?).into_iter().filter(|r| dist_to(me, Rect::of(r)) <= 1.0 && (ruin_name.is_empty() || plan_of(c.w(), &ruin_name).is_some_and(|p| j::at(p, "key") == j::at(r, "plan")) || txt(j::at(r, "name")).to_lowercase() == ruin_name.to_lowercase())).collect();
	let ruin = if js::re(r"^ruine?\b", "i").test(&name) || !own_near { ruins.iter().find(|r| mine(c, r)).or(ruins.first()).cloned() } else { None };
	if let Some(ruin) = ruin {
		if c.account.as_ref().is_none_or(|a| j::b(a, "guest")) { return refuse("Ruinen räumen nur registrierte Spieler."); }
		if c.space.take_if_exists(&tmpl("Ruin", obj! { "buildId" => j::at(&ruin, "buildId").clone() }), 5_000.0, c.txn()).await?.is_none() { return refuse("Die Ruine ist gerade nicht greifbar; bitte noch einmal."); }
		free_cells(&c.space, &c.txn, j::s(&ruin, "room"), j::at(&ruin, "buildId")).await?;
		let estate = c.space.read_if_exists(&tmpl("Estate", obj! { "estateId" => format!("est-{}", txt(j::at(&ruin, "buildId"))) }), NO_WAIT, c.txn()).await?;
		let owner = txt(j::at(&ruin, "ownerName"));
		return msg(c, "*", "info", &format!("{actor} räumt die Ruine ab ({} von {owner}); die Fläche ist frei.{}", txt(j::at(&ruin, "name")), if estate.is_some() { format!(" Der Nachlass wartet hier weiter auf {owner} („nachlass“).") } else { String::new() }), info()).await;
	}
	let b = building_here(c, &name, true).await?;
	let w = c.world.clone();
	let plan = plan_of(&w, &txt(j::at(&b, "plan")));
	if plan.is_some_and(|p| j::b(p, "store")) && settlement_in(&c.space, c.room(), c.txn()).await?.is_some() && !chest_of(c, j::at(&b, "buildId")).await?.is_empty() { return refuse("Im Lager liegt noch, was der Siedlung gehört. Erst wenn es leer ist, kann es weg."); }
	let back = give_back(c, &plan.map(|p| j::a(p, "needs").iter().map(|n| (txt(j::at(n, "proto")), (j::n(n, "count") / 2.0).floor())).collect::<Vec<_>>()).unwrap_or_default()).await?;
	let bid = txt(j::at(&b, "buildId"));
	let who = c.char_id().to_owned();
	let mut kept = 0;
	for it in c.space.read_all(&tmpl("Item", obj! { "location" => bid.as_str() }), None).await? { if move_item(&c.space, c.txn(), j::at(fields(&it), "itemId"), &bid, &who).await? { kept += 1; } }
	free_cells(&c.space, &c.txn, j::s(&b, "room"), j::at(&b, "buildId")).await?;
	release_light(&c.space, &c.txn, j::at(&b, "beaconId"), points_of(&b)).await?;
	let now = world_now_of(&c.space, c.txn()).await?;
	let stopped = stop_loads(&c.space, &c.txn, j::at(&b, "buildId"), now).await?;
	log_gone(&b, &format!("torn down by {actor}"));
	let text = format!("{actor} reißt die {} ab; die Fläche ist frei.{}{}{}", txt(j::at(&b, "name")), if back.is_empty() { String::new() } else { format!(" Zurück: {}.", back.join(", ")) }, if kept > 0 { format!(" Aus der Truhe: {kept} Dinge.") } else { String::new() }, if stopped > 0 { " Das Korn, das noch nicht gemahlen war, holen die, die es brachten, hier ab („abholen“)." } else { "" });
	msg(c, "*", "info", &text, info()).await
}

async fn nachlass(c: &mut Ctx) -> Result<()> {
	let all = c.space.read_all(&tmpl("Estate", obj! { "room" => c.room() }), None).await?;
	let mine_e: Vec<&Json> = all.iter().filter(|e| c.account.as_ref().is_some_and(|a| j::at(a, "accountId") == j::at(fields(e), "accountId"))).collect();
	if mine_e.is_empty() { return refuse("Hier liegt kein Nachlass von dir."); }
	let who = c.char_id().to_owned();
	let (mut got, mut left) = (0, 0);
	let pack = j::opt(c.w(), "pack").is_some();
	let mut free = if pack { pack_max(&c.space, c.w(), Some(&who), c.txn()).await? - load_at(&c.space, c.w(), &who, c.txn()).await? } else { f64::INFINITY };
	for e in mine_e {
		let Some(est) = c.space.take_if_exists(&obj! { "id" => j::at(e, "id").clone() }, NO_WAIT, c.txn()).await? else { continue };
		let eid = txt(j::at(fields(&est), "estateId"));
		let mut rest = 0;
		for it in c.space.read_all(&tmpl("Item", obj! { "location" => eid.as_str() }), None).await? {
			let each = if pack { load_of(c.w(), j::so(fields(&it), "proto")) } else { 0.0 };
			if each > free + 1e-9 { rest += 1; continue; }
			if move_item(&c.space, c.txn(), j::at(fields(&it), "itemId"), &eid, &who).await? { got += 1; free -= each; }
		}
		if rest > 0 { left += rest; c.space.write(&tmpl("Estate", fields(&est).clone()), c.txn(), FOREVER).await?; }
	}
	let text = if got > 0 { format!("Du holst deinen Nachlass ab: {got} Dinge.{}", if left > 0 { format!(" {left} Dinge bleiben hier, mehr trägst du nicht.") } else { String::new() }) } else if left > 0 { format!("Das trägst du nicht mehr: {left} Dinge warten hier weiter im Nachlass.") } else { "Der Nachlass war leer.".to_owned() };
	msg(c, &who, "info", &text, info()).await
}

/// `stopLoads`: a mill that falls stops grinding; its loads not yet ground give their grain back, ready now. How many.
pub async fn stop_loads(space: &Space, txn: &str, build_id: &Json, now: f64) -> Result<usize> {
	let mut n = 0;
	for e in space.read_all(&tmpl("MillLoad", obj! { "buildId" => build_id.clone() }), None).await? {
		let l = fields(&e);
		if j::n(l, "readyWorldMs") <= now || space.take_if_exists(&tmpl("MillLoad", obj! { "loadId" => j::at(l, "loadId").clone() }), 5_000.0, Some(txn)).await?.is_none() { continue; }
		let mut f = j::object(l);
		f.insert("to", j::at(l, "from").clone());
		f.insert("readyWorldMs", Json::from(now));
		space.write(&tmpl("MillLoad", Json::Object(f)), Some(txn), FOREVER).await?;
		n += 1;
	}
	Ok(n)
}
/// `demolishByVote`: a building a motion took down (its cells free, its light back, its loads stopped); half its material
/// and what lay in its chest wait for the owner as an estate.
pub async fn demolish_by_vote(space: &Space, txn: &str, w: &Json, b: &Json, now: f64) -> Result<()> {
	free_cells(space, txn, j::s(b, "room"), j::at(b, "buildId")).await?;
	release_light(space, txn, j::at(b, "beaconId"), j::no(b, "points").unwrap_or(1.0)).await?;
	stop_loads(space, txn, j::at(b, "buildId"), world_now_of(space, None).await?).await?;
	let estate_id = format!("est-{}", key_text(j::at(b, "buildId")));
	let est = obj! { "estateId" => estate_id.as_str(), "accountId" => j::at(b, "accountId").clone(), "ownerName" => j::at(b, "ownerName").clone(), "room" => j::at(b, "room").clone(), "name" => j::at(b, "name").clone(), "untilWorldMs" => now + j::no(j::at(w, "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0) };
	space.write(&tmpl("Estate", est), Some(txn), FOREVER).await?;
	for it in space.read_all(&tmpl("Item", obj! { "location" => j::at(b, "buildId").clone() }), None).await? {
		move_item(space, Some(txn), &Json::from(key_text(j::at(fields(&it), "itemId"))), &key_text(j::at(b, "buildId")), &estate_id).await?;
	}
	for n in plan_of(w, j::s(b, "plan")).map(|p| j::a(p, "needs")).unwrap_or(&[]) {
		let Some(proto) = resolve_prototype(space, j::s(n, "proto")).await? else { continue };
		for _ in 0..(j::n(n, "count") / 2.0).floor().max(0.0) as usize { spawn(space, Some(txn), w, &proto, At { location: estate_id.clone(), x: -1.0, y: -1.0, ..Default::default() }, &Json::Null).await?; }
	}
	Ok(())
}
/// One step of the sweep in a transaction of its own: committed when `run` says so, else aborted.
pub(crate) async fn in_txn<'a, F, Fut>(space: &'a Space, run: F) -> Result<()> where F: FnOnce(String) -> Fut, Fut: std::future::Future<Output = Result<bool>> + 'a {
	let txn = space.create_transaction(10_000.0).await?;
	match run(txn.clone()).await {
		Ok(true) => space.commit(&txn).await,
		Ok(false) => space.abort(&txn).await,
		Err(e) => { let _ = space.abort(&txn).await; Err(e) }
	}
}
/// `Number(e.fields.untilWorldMs)`: NaN when missing.
fn until_of(e: &Json) -> f64 { fields(e).get("untilWorldMs").map_or(f64::NAN, j::number) }
fn all_of(es: Vec<Json>) -> Vec<(Json, Json)> { es.into_iter().map(|e| { let f = fields(&e).clone(); (e, f) }).collect() }

thread_local! {
	/// The spaces whose jetties of old were looked at since the start (`jettiesMoved`).
	static JETTIES_MOVED: std::cell::RefCell<HashSet<usize>> = std::cell::RefCell::new(HashSet::new());
}

/// `buildSweep`: sites without progress, buildings not kept (a ruin, what lay inside an estate), freight nobody fetched,
/// ruins and estates whose time is up, and the rests and loads that lapsed.
pub async fn build_sweep(space: &Space, w: &Json) -> Result<()> {
	let now = decay_now_of(space, None).await?;
	let life = world_now_of(space, None).await?;
	let estate = now + estate_ms(w);
	// the single road cells of old (and their sites) go: a road is planned from room to room now (road.rs)
	let road = j::s(j::at(w, "cart"), "road");
	let old_road = (!road.is_empty() && plan_of(w, road).is_none()).then_some(road);
	// the jetties of old on the beach go onto the water (where there is no place they stay; tried once a run)
	let water: Vec<&str> = j::a(j::at(w, "building"), "plans").iter().filter(|p| j::b(p, "water")).map(|p| j::s(p, "key")).collect();
	if !water.is_empty() && JETTIES_MOVED.with(|m| m.borrow_mut().insert(space.key())) {
		for ty in ["Building", "Site"] {
			for (_, b) in all_of(space.read_all(&obj! { "type" => ty }, None).await?) {
				if water.contains(&j::s(&b, "plan")) { in_txn(space, |txn| { let b = &b; async move { jetty_to_water(space, w, &txn, ty, b).await } }).await?; }
			}
		}
	}
	for (_, s) in all_of(space.read_all(&obj! { "type" => "Site" }, None).await?) {
		if j::n(&s, "untilWorldMs") > now && old_road != Some(j::s(&s, "plan")) { continue; }
		in_txn(space, |txn| { let s = &s; async move {
			if space.take_if_exists(&tmpl("Site", obj! { "buildId" => j::at(s, "buildId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			close_orders(space, &txn, s, estate).await?;
			free_cells(space, &txn, j::s(s, "room"), j::at(s, "buildId")).await?;
			release_light(space, &txn, j::at(s, "beaconId"), j::no(s, "points").unwrap_or(1.0)).await?;
			Ok(true)
		} }).await?;
	}
	for (_, b) in all_of(space.read_all(&obj! { "type" => "Building" }, None).await?) {
		if old_road == Some(j::s(&b, "plan")) {
			in_txn(space, |txn| { let b = &b; async move {
				if space.take_if_exists(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
				log_gone(b, "a road of the old kind");
				free_cells(space, &txn, j::s(b, "room"), j::at(b, "buildId")).await?;
				release_light(space, &txn, j::at(b, "beaconId"), j::no(b, "points").unwrap_or(1.0)).await?;
				Ok(true)
			} }).await?;
			continue;
		}
		if j::n(&b, "untilWorldMs") > now { continue; }
		// shutters in its chest are used up and hold it a while longer (BuildingDef.shutters)
		if let Some(shut) = j::opt(j::at(w, "building"), "shutters").filter(|s| j::truthy(s)) {
			let held = std::cell::Cell::new(false);
			in_txn(space, |txn| { let (b, held) = (&b, &held); async move {
				let id = j::at(b, "buildId").clone();
				let Some(s) = space.read_all(&tmpl("Item", obj! { "location" => id.clone(), "proto" => j::at(shut, "proto").clone() }), Some(&txn)).await?.into_iter().next() else { return Ok(false) };
				if space.take_if_exists(&tmpl("Item", obj! { "itemId" => j::at(fields(&s), "itemId").clone(), "location" => id.clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
				let Some(e) = space.take_if_exists(&tmpl("Building", obj! { "buildId" => id }), NO_WAIT, Some(&txn)).await? else { return Ok(false) };
				let plan = plan_of(w, j::s(b, "plan"));
				let keep = match plan.and_then(|p| j::so(p, "keepSetting")).filter(|k| !k.is_empty()) { Some(k) => setting(space, k).await? * WORLD_DAY, None => plan.and_then(|p| j::no(p, "keepWorldMs")).unwrap_or(7.0 * WORLD_DAY) };
				let mut f = j::object(fields(&e));
				f.insert("untilWorldMs", Json::from(now + js::round(keep * j::n(shut, "share"))));
				space.write(&anew(&e, Json::Object(f)), Some(&txn), FOREVER).await?;
				held.set(true);
				Ok(true)
			} }).await?;
			if held.get() { continue; }
		}
		in_txn(space, |txn| { let b = &b; async move {
			if space.take_if_exists(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			log_gone(b, "fell to a ruin (its term ran out)");
			let mut ruin = Object::new();
			for k in ["buildId", "plan", "name", "room", "x", "y", "w", "h", "owner", "ownerName", "accountId"] { if let Some(v) = b.get(k) { ruin.insert(k, v.clone()); } }
			ruin.insert("untilWorldMs", Json::from(now + j::no(j::at(w, "building"), "ruinWorldMs").unwrap_or(10.0 * 24.0 * 3_600_000.0)));
			space.write(&tmpl("Ruin", Json::Object(ruin)), Some(&txn), FOREVER).await?;
			release_light(space, &txn, j::at(b, "beaconId"), j::no(b, "points").unwrap_or(1.0)).await?;
			stop_loads(space, &txn, j::at(b, "buildId"), life).await?;
			let id = key_text(j::at(b, "buildId"));
			let inside = space.read_all(&tmpl("Item", obj! { "location" => id.as_str() }), None).await?;
			if !inside.is_empty() {
				let estate_id = format!("est-{id}");
				space.write(&tmpl("Estate", obj! { "estateId" => estate_id.as_str(), "accountId" => j::at(b, "accountId").clone(), "ownerName" => j::at(b, "ownerName").clone(), "room" => j::at(b, "room").clone(), "name" => j::at(b, "name").clone(), "untilWorldMs" => estate }), Some(&txn), FOREVER).await?;
				for it in &inside { move_item(space, Some(&txn), &Json::from(key_text(j::at(fields(it), "itemId"))), &id, &estate_id).await?; }
			}
			Ok(true)
		} }).await?;
	}
	// the insides: made for buildings that stood before them, taken with buildings that are gone (interior.rs)
	super::interior::interior_sweep(space, w).await?;
	// freight the railway carried and nobody fetched, or whose station fell: the sender's estate on the spot
	for (_, f) in all_of(space.read_all(&obj! { "type" => "Freight" }, None).await?) {
		if j::n(&f, "untilWorldMs") > life && space.read_if_exists(&tmpl("Building", obj! { "buildId" => j::at(&f, "buildId").clone() }), 1_000.0, None).await?.is_some() { continue; }
		in_txn(space, |txn| { let f = &f; async move {
			let id = key_text(j::at(f, "freightId"));
			if space.take_if_exists(&tmpl("Freight", obj! { "freightId" => id.as_str() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			let estate_id = format!("est-{id}");
			space.write(&tmpl("Estate", obj! { "estateId" => estate_id.as_str(), "accountId" => j::at(f, "accountId").clone(), "ownerName" => j::at(f, "ownerName").clone(), "room" => j::at(f, "room").clone(), "name" => "Fracht", "untilWorldMs" => estate }), Some(&txn), FOREVER).await?;
			for it in space.read_all(&tmpl("Item", obj! { "location" => id.as_str() }), Some(&txn)).await? { move_item(space, Some(&txn), &Json::from(key_text(j::at(fields(&it), "itemId"))), &id, &estate_id).await?; }
			Ok(true)
		} }).await?;
	}
	for (_, r) in all_of(space.read_all(&obj! { "type" => "Ruin" }, None).await?) {
		if j::n(&r, "untilWorldMs") > now { continue; }
		in_txn(space, |txn| { let r = &r; async move {
			if space.take_if_exists(&tmpl("Ruin", obj! { "buildId" => j::at(r, "buildId").clone() }), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			free_cells(space, &txn, j::s(r, "room"), j::at(r, "buildId")).await?;
			Ok(true)
		} }).await?;
	}
	for (e, est) in all_of(space.read_all(&obj! { "type" => "Estate" }, None).await?) {
		if j::n(&est, "untilWorldMs") > now { continue; }
		in_txn(space, |txn| { let (e, est) = (&e, &est); async move {
			if space.take_if_exists(&obj! { "id" => j::at(e, "id").clone() }, NO_WAIT, Some(&txn)).await?.is_none() { return Ok(false); }
			for it in space.read_all(&tmpl("Item", obj! { "location" => j::at(est, "estateId").clone() }), None).await? { space.take_if_exists(&obj! { "id" => j::at(&it, "id").clone() }, NO_WAIT, Some(&txn)).await?; }
			Ok(true)
		} }).await?;
	}
	for ty in ["WorkRest", "Blessing", "BeamRest"] {
		for e in space.read_all(&obj! { "type" => ty }, None).await? { if until_of(&e) <= now { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, None).await?; } }
	}
	// flour (or grain back) nobody fetched
	for e in space.read_all(&obj! { "type" => "MillLoad" }, None).await? { if until_of(&e) <= now { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, None).await?; } }
	Ok(())
}
/// `freeCells`: takes the cells of a site or building.
pub async fn free_cells(space: &Space, txn: &str, room: &str, of: &Json) -> Result<()> {
	for p in space.read_all(&tmpl("Plot", obj! { "room" => room, "of" => of.clone() }), None).await? { space.take_if_exists(&obj! { "id" => j::at(&p, "id").clone() }, NO_WAIT, Some(txn)).await?; }
	Ok(())
}
