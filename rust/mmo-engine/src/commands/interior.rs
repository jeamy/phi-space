//! A building's inside (`server/engine/commands/interior.ts`, docs/innenraeume.en.md): a room of its own per building
//! whose plan has an `interior`, with the id `in-<buildId>`. Its owner and the guests it invites go in (`betrete` beside
//! the building); inside stand the furnishings that do what the building does from outside: the hearth cooks its
//! recipes, the chest is its chest, the bed is for sleep. One exit „hinaus“ on its door cell leads out in front of it.
//!
//! The room is made when the site becomes the building (build.rs `settle`) and, for buildings that stood before, by the
//! sweep (`interior_sweep`). It goes with its building: whoever is inside stands in front of where it stood, what lies on
//! its floor goes to the owner's estate, and the room, its exit and its furnishings go.
use std::collections::HashSet;

use phi_json::{obj, Json};

use super::build::{dist_to, no_article, plan_of, Rect};
use super::default::{describe_room, drop_offers, place_in, relocate};
use crate::clock::world_now_of;
use crate::context::{msg, to_player, Ctx, MsgOpts};
use crate::fire::key_text as txt;
use crate::j;
use crate::js;
use crate::occupancy::{blocked_in, cell_key, free_cell_near, release_spot};
use crate::room_growth::rows;
use crate::source::time_now;
use crate::space::{fields, not_understood, refuse, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::typeclasses::draft_of;
use crate::world::walkable;

pub const INTERIOR: &str = "in-";
pub fn interior_of(build_id: &str) -> String { format!("{INTERIOR}{build_id}") }
pub fn is_interior(room: &str) -> bool { room.starts_with(INTERIOR) }
/// The building whose inside `room` is (None outside).
pub fn build_id_of(room: &str) -> Option<&str> { room.strip_prefix(INTERIOR) }
fn exit_id_of(build_id: &str) -> String { format!("x-{}", interior_of(build_id)) }
fn furnishing_id(build_id: &str, kind: &str) -> String { format!("f-{build_id}-{kind}") }
fn templ(room: Option<&str>) -> MsgOpts { MsgOpts { templ: true, room: room.map(str::to_owned), ..MsgOpts::default() } }
fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }
fn interior_def<'a>(w: &'a Json, plan: &str) -> Option<&'a Json> { plan_of(w, plan).and_then(|p| j::opt(p, "interior")) }

/// `frontOf`: a walkable, free cell in front of the building, where one stands coming out: below its middle first,
/// then the rest of its rim; None when it is walled in.
async fn front_of(space: &Space, w: &Json, b: &Json) -> Result<Option<(f64, f64)>> {
	let room = j::s(b, "room");
	let Some(room_e) = space.read_all(&tmpl("Room", obj! { "roomId" => room }), None).await?.into_iter().next() else { return Ok(None) };
	let ground = rows(j::at(fields(&room_e), "ground"));
	let blocked = blocked_in(space, room).await?;
	let exits: HashSet<String> = space.read_all(&tmpl("Exit", obj! { "location" => room }), None).await?.iter().map(|e| cell_key(j::n(fields(e), "x"), j::n(fields(e), "y"))).collect();
	let r = Rect::of(b);
	let mid = r.x + (r.w / 2.0).floor();
	let mut rim = vec![(mid, r.y + r.h)];
	let mut x = r.x - 1.0;
	while x <= r.x + r.w { rim.push((x, r.y + r.h)); x += 1.0; }
	let mut y = r.y + r.h - 1.0;
	while y >= r.y { rim.push((r.x - 1.0, y)); rim.push((r.x + r.w, y)); y -= 1.0; }
	let mut x = r.x - 1.0;
	while x <= r.x + r.w { rim.push((x, r.y - 1.0)); x += 1.0; }
	if let Some(p) = rim.into_iter().find(|p| walkable(w, &ground, p.0, p.1) && !blocked.contains(&cell_key(p.0, p.1)) && !exits.contains(&cell_key(p.0, p.1))) { return Ok(Some(p)); }
	Ok(free_cell_near(w, &ground, (mid, r.y + r.h), &|k| blocked.contains(k) || exits.contains(k), 8))
}

/// "Drinnen in der Hütte", "Drinnen im Backhaus": by the plan's dative ("einer Hütte", "einem Backhaus").
fn inside_text(name: &str, dative: Option<&str>, def: &Json) -> String {
	let pre = if js::re(r"^einem\b", "").test(dative.unwrap_or("")) { "im" } else { "in der" };
	format!("Drinnen {pre} {name}: {}. „hinaus“ führt vor die Tür.", j::a(def, "furniture").iter().map(|f| txt(j::at(f, "name"))).collect::<Vec<_>>().join(", "))
}

/// `makeInterior`: the inside of `b`, written once (None when its room is there already, or its plan has none).
pub async fn make_interior(space: &Space, txn: &str, w: &Json, b: &Json) -> Result<Option<Json>> {
	let Some(plan) = plan_of(w, j::s(b, "plan")) else { return Ok(None) };
	let Some(def) = j::opt(plan, "interior") else { return Ok(None) };
	let build_id = txt(j::at(b, "buildId"));
	let room_id = interior_of(&build_id);
	if space.read_if_exists(&tmpl("Room", obj! { "roomId" => room_id.as_str() }), 1_000.0, Some(txn)).await?.is_some() { return Ok(None); }
	let Some(front) = front_of(space, w, b).await? else { return Ok(None) };
	let growth = space.read_all(&tmpl("RoomGrowth", obj! { "roomId" => j::at(b, "room").clone() }), Some(txn)).await?.into_iter().next();
	let revision = growth.map_or(0, |g| j::a(fields(&g), "steps").len());
	let pname = txt(j::at(plan, "name"));
	let mut building = obj! {};
	for k in ["buildId", "name", "room", "x", "y", "w", "h", "accountId", "ownerName"] { j::set(&mut building, k, j::at(b, k).clone()); }
	let room = obj! {
		"roomId" => room_id.as_str(), "name" => format!("{pname} von {}", txt(j::at(b, "ownerName"))), "desc" => inside_text(&pname, j::opt(plan, "dative").and_then(Json::as_str), def),
		"ground" => j::at(def, "ground").clone(), "spawn" => j::at(def, "spawn").clone(), "building" => building
	};
	space.write(&draft_of("Room", j::at(w, "typeclasses"), room.clone())?, Some(txn), FOREVER).await?;
	let outside = j::by(j::a(w, "rooms"), "roomId", j::s(b, "room")).map_or_else(|| "draußen".to_owned(), |r| txt(j::at(r, "name")));
	let door = j::at(def, "door");
	let mut exit = obj! {
		"exitId" => exit_id_of(&build_id), "name" => "hinaus", "aliases" => Json::Array(["raus", "tür", "tuer", "out"].into_iter().map(Json::from).collect()), "desc" => format!("Hinaus nach {outside}."),
		"location" => room_id.as_str(), "destination" => j::at(b, "room").clone(), "x" => j::at(door, "x").clone(), "y" => j::at(door, "y").clone(),
		"arrive" => obj! { "x" => front.0, "y" => front.1 }, "locks" => ""
	};
	if revision > 0 { j::set(&mut exit, "arriveGrowthRevision", revision as f64); }
	space.write(&draft_of("Exit", j::at(w, "typeclasses"), exit)?, Some(txn), FOREVER).await?;
	for f in j::a(def, "furniture") {
		let kind = txt(j::at(f, "kind"));
		let mut s = obj! {
			"sceneryId" => furnishing_id(&build_id, &kind), "room" => room_id.as_str(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "w" => 1.0, "h" => 1.0,
			"model" => kind.as_str(), "name" => j::at(f, "name").clone(), "fixed" => true, "work" => 0.0, "left" => 0.0, "yields" => Json::Array(vec![]),
			"of" => build_id.as_str(), "plan" => j::at(b, "plan").clone(), "owner" => j::at(b, "owner").clone()
		};
		if let Some(u) = j::opt(f, "use").filter(|u| j::truthy(u)) { j::set(&mut s, "use", u.clone()); }
		j::set(&mut s, "desc", j::at(f, "desc").clone());
		let sid = j::at(&s, "sceneryId").clone();
		space.write(&tmpl("Scenery", s), Some(txn), FOREVER).await?;
		space.write_unique(&tmpl("Plot", obj! { "room" => room_id.as_str(), "x" => j::at(f, "x").clone(), "y" => j::at(f, "y").clone(), "of" => sid }), Some(txn), FOREVER, &["room", "x", "y"]).await?;
	}
	Ok(Some(room))
}

/// An entry written again without its own type in `types` (`{ type, types: types.slice(1), fields }`).
fn again(t: &Json, f: Json) -> Json {
	obj! { "type" => j::at(t, "type").clone(), "types" => Json::Array(j::a(t, "types").iter().skip(1).cloned().collect()), "fields" => f }
}

/// `dropInterior`: the inside of a building that is gone, taken; whoever is in it stands in front of where it stood
/// (`at`), what lies on its floor goes to the owner's estate.
pub async fn drop_interior(space: &Space, txn: &str, w: &Json, room_id: &str, at: Option<&Json>) -> Result<()> {
	let build_id = build_id_of(room_id).unwrap_or("").to_owned();
	let front = match at { Some(a) => front_of(space, w, a).await?, None => None };
	let to = match (at, front) {
		(Some(a), Some(f)) => (txt(j::at(a, "room")), f.0, f.1),
		_ => {
			let start = j::by(j::a(w, "rooms"), "roomId", j::s(w, "start")).cloned().unwrap_or(Json::Null);
			(txt(j::at(&start, "roomId")), j::n(j::at(&start, "spawn"), "x"), j::n(j::at(&start, "spawn"), "y"))
		}
	};
	for e in space.read_all(&tmpl("Character", obj! { "room" => room_id }), Some(txn)).await? {
		let Some(t) = space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(txn)).await? else { continue };
		let char_id = txt(j::at(fields(&t), "charId"));
		release_spot(space, txn, &char_id).await?;
		let mut f = fields(&t).clone();
		j::set(&mut f, "room", to.0.as_str());
		j::set(&mut f, "x", to.1);
		j::set(&mut f, "y", to.2);
		space.write(&again(&t, f), Some(txn), FOREVER).await?;
		let name = at.map_or_else(|| "Der Bau".to_owned(), |a| txt(j::at(a, "name")));
		to_player(space, &obj! { "room" => to.0.as_str(), "to" => char_id.as_str(), "kind" => "info", "text" => format!("{name} steht nicht mehr; du stehst draußen."), "from" => "", "fromId" => "", "at" => time_now() }, Some(txn)).await?;
		super::sleep::wake_outside(space, txn, &char_id, &to.0).await?;
	}
	let floor = space.read_all(&tmpl("Item", obj! { "location" => room_id }), Some(txn)).await?;
	match at {
		Some(a) if !floor.is_empty() => {
			let estate_id = format!("est-{room_id}");
			let until = world_now_of(space, Some(txn)).await? + j::no(j::at(w, "building"), "estateWorldMs").unwrap_or(30.0 * 24.0 * 3_600_000.0);
			let est = obj! { "estateId" => estate_id.as_str(), "accountId" => j::at(a, "accountId").clone(), "ownerName" => j::at(a, "ownerName").clone(), "room" => j::at(a, "room").clone(), "name" => format!("{} (drinnen)", txt(j::at(a, "name"))), "untilWorldMs" => until };
			space.write(&tmpl("Estate", est), Some(txn), FOREVER).await?;
			for it in &floor {
				if let Some(t) = space.take_if_exists(&obj! { "id" => j::at(it, "id").clone() }, NO_WAIT, Some(txn)).await? {
					let mut f = fields(&t).clone();
					j::set(&mut f, "location", estate_id.as_str());
					space.write(&again(&t, f), Some(txn), FOREVER).await?;
				}
			}
		}
		_ => { for it in &floor { space.take_if_exists(&obj! { "id" => j::at(it, "id").clone() }, NO_WAIT, Some(txn)).await?; } }
	}
	for ty in ["Scenery", "Plot", "Spot"] {
		for e in space.read_all(&tmpl(ty, obj! { "room" => room_id }), Some(txn)).await? { space.take_if_exists(&obj! { "id" => j::at(&e, "id").clone() }, NO_WAIT, Some(txn)).await?; }
	}
	space.take_if_exists(&tmpl("Exit", obj! { "exitId" => exit_id_of(&build_id) }), NO_WAIT, Some(txn)).await?;
	space.take_if_exists(&tmpl("Room", obj! { "roomId" => room_id }), NO_WAIT, Some(txn)).await?;
	Ok(())
}

/// `interiorSweep`: a building of a plan with an inside gets its room, an inside whose building is gone goes.
pub async fn interior_sweep(space: &Space, w: &Json) -> Result<()> {
	if !j::a(j::at(w, "building"), "plans").iter().any(|p| j::truthy(j::at(p, "interior"))) { return Ok(()); }
	let kept: Vec<Json> = space.read_all(&obj! { "type" => "Room" }, None).await?.iter().map(|e| fields(e).clone()).filter(|r| is_interior(j::s(r, "roomId"))).collect();
	// a Map by buildId: a later entry of the same building replaces the earlier one in its place
	let mut standing: Vec<(String, Json)> = Vec::new();
	for e in space.read_all(&obj! { "type" => "Building" }, None).await? {
		let b = fields(&e).clone();
		let id = txt(j::at(&b, "buildId"));
		match standing.iter_mut().find(|(k, _)| *k == id) { Some(x) => x.1 = b, None => standing.push((id, b)) }
	}
	let has = |id: &str| kept.iter().any(|r| j::s(r, "roomId") == interior_of(id));
	for (id, b) in &standing {
		if interior_def(w, j::s(b, "plan")).is_some() && !has(id) {
			super::build::in_txn(space, |txn| async move { Ok(make_interior(space, &txn, w, b).await?.is_some()) }).await?;
		}
	}
	for r in &kept {
		let room_id = j::s(r, "roomId");
		let bid = build_id_of(room_id).unwrap_or("");
		let b = standing.iter().find(|(k, _)| k == bid).map(|(_, b)| b);
		if b.is_some_and(|b| interior_def(w, j::s(b, "plan")).is_some()) { continue; }
		let ruin = space.read_all(&tmpl("Ruin", obj! { "buildId" => bid }), None).await?.into_iter().next().map(|e| fields(&e).clone());
		// without a ruin the building went by a way that logs itself (torn down, voted down, destroyed: "building gone"); a
		// line here without such a line before it is a building that went unaccounted for
		if b.is_none() && ruin.is_none() { eprintln!("[world] inside {room_id} taken: its building is gone without a ruin ({})", j::opt(r, "building").map_or_else(|| "null".to_owned(), |x| x.to_json_text())); }
		let at: Option<Json> = b.cloned().or(ruin).or_else(|| j::opt(r, "building").cloned());
		super::build::in_txn(space, |txn| { let at = at.as_ref(); async move { drop_interior(space, &txn, w, room_id, at).await?; Ok(true) } }).await?;
	}
	Ok(())
}

fn is_owner(c: &Ctx, b: &Json) -> bool { c.account.as_ref().is_some_and(|a| !j::b(a, "guest") && j::at(b, "accountId") == j::at(a, "accountId")) }
/// `mayEnter`: its owner, and whom the owner invited.
pub fn may_enter(c: &Ctx, b: &Json) -> bool { is_owner(c, b) || j::a(b, "guests").iter().any(|g| j::s(g, "charId") == c.char_id()) }

/// `nearBuildings`: outside, the buildings the actor stands beside; inside, its building when it stands beside the
/// furnishing that does `use` (no furnishing needed without one).
pub async fn near_buildings(c: &Ctx, use_: Option<&str>) -> Result<Vec<Json>> {
	let me = xy(&c.actor);
	let Some(inside) = build_id_of(c.room()) else {
		return Ok(c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|b| dist_to(me, Rect::of(b)) <= 1.0).collect());
	};
	let Some(b) = c.space.read_all(&tmpl("Building", obj! { "buildId" => inside }), None).await?.into_iter().next() else { return Ok(vec![]) };
	if let Some(u) = use_ {
		let pieces = c.space.read_all(&tmpl("Scenery", obj! { "room" => c.room() }), None).await?;
		if !pieces.iter().map(fields).filter(|s| j::s(s, "use") == u).any(|s| dist_to(me, Rect::of(s)) <= 1.0) { return Ok(vec![]); }
	}
	Ok(vec![fields(&b).clone()])
}
/// `furnishingFor`: inside a building, its furnishing for `use`.
pub async fn furnishing_for(c: &Ctx, use_: &str) -> Result<Option<Json>> {
	if !is_interior(c.room()) { return Ok(None); }
	Ok(c.space.read_all(&tmpl("Scenery", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).find(|s| j::s(s, "use") == use_))
}

/// `enterable`: the building one means: at x y, or beside one (one's own first, then one invited into).
async fn enterable(c: &Ctx, arg: &str) -> Result<Json> {
	let at = js::caps(&js::re(r"^(\d+)\s+(\d+)$", ""), js::trim(arg)).map(|m| (js::to_number(m[1].as_deref().unwrap_or("")), js::to_number(m[2].as_deref().unwrap_or(""))));
	let n = no_article(js::trim(arg)).to_lowercase();
	let me = xy(&c.actor);
	let near: Vec<Json> = c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone())
		.filter(|b| dist_to(me, Rect::of(b)) <= 1.0 && match at { Some(p) => dist_to(p, Rect::of(b)) == 0.0, None => n.is_empty() || plan_of(c.w(), &n).is_some_and(|p| j::at(p, "key") == j::at(b, "plan")) || txt(j::at(b, "name")).to_lowercase() == n }).collect();
	let houses: Vec<&Json> = near.iter().filter(|b| interior_def(c.w(), j::s(b, "plan")).is_some()).collect();
	if houses.is_empty() {
		return match near.first() {
			Some(b) => refuse(format!("In {} geht man nicht hinein.", plan_of(c.w(), j::s(b, "plan")).and_then(|p| j::so(p, "dative")).map_or_else(|| txt(j::at(b, "name")), str::to_owned))),
			None => not_understood("Geh direkt neben eine Hütte (ein Backhaus, eine Metzgerei), in die du darfst."),
		};
	}
	Ok(houses.iter().find(|b| is_owner(c, b)).or_else(|| houses.iter().find(|b| may_enter(c, b))).unwrap_or(&houses[0]).to_owned().clone())
}

async fn betrete(c: &mut Ctx, arg: &str) -> Result<()> {
	if is_interior(c.room()) { return refuse("Du bist schon drinnen; „hinaus“ führt vor die Tür."); }
	let b = enterable(c, arg).await?;
	if !may_enter(c, &b) { return refuse(format!("Die Tür ist zu. Hinein dürfen nur {} und wer eingeladen ist.", txt(j::at(&b, "ownerName")))); }
	let room_id = interior_of(j::s(&b, "buildId"));
	let was = c.space.read_all(&tmpl("Room", obj! { "roomId" => room_id.as_str() }), None).await?.into_iter().next().map(|e| fields(&e).clone());
	let txn = c.txn.clone();
	let made = if was.is_some() { None } else { make_interior(&c.space, &txn, &c.world.clone(), &b).await? };
	let Some(room) = was.clone().or_else(|| made.clone()) else { return refuse("Vor der Tür ist kein Platz; so kommt man nicht hinein.") };
	let spawn = j::opt(&room, "spawn").cloned().or_else(|| interior_def(c.w(), j::s(&b, "plan")).map(|d| j::at(d, "spawn").clone())).unwrap_or(Json::Null);
	let at = place_in(c, &room, xy(&spawn), true, &[]).await?;
	relocate(c, &room_id, at, false, None).await?;
	drop_offers(c).await?;
	msg(c, "*", "info", &format!("$you() $conj(gehst|geht) in die {} von {}.", txt(j::at(&b, "name")), txt(j::at(&b, "ownerName"))), templ(None)).await?;
	msg(c, "*", "info", "$you() $conj(kommst|kommt) herein.", templ(Some(&room_id))).await?;
	let look = match &made { Some(m) => format!("{}\n{}", txt(j::at(m, "name")), txt(j::at(m, "desc"))), None => describe_room(c, &room_id, true).await? };
	let me = c.char_id().to_owned();
	msg(c, &me, "look", &look, MsgOpts { room: Some(room_id), ..MsgOpts::default() }).await
}

/// `ownHouse`: one's own building with an inside, the one one is in or beside, taken in the transaction.
async fn own_house(c: &Ctx) -> Result<Json> {
	let me = xy(&c.actor);
	let all: Vec<Json> = match build_id_of(c.room()) {
		Some(inside) => c.space.read_all(&tmpl("Building", obj! { "buildId" => inside }), None).await?.iter().map(|e| fields(e).clone()).collect(),
		None => c.space.read_all(&tmpl("Building", obj! { "room" => c.room() }), None).await?.iter().map(|e| fields(e).clone()).filter(|b| dist_to(me, Rect::of(b)) <= 1.0).collect(),
	};
	let house = |x: &Json| interior_def(c.w(), j::s(x, "plan")).is_some();
	let Some(b) = all.iter().find(|x| house(x) && is_owner(c, x)) else {
		return refuse(if all.iter().any(house) { "Einladen kann nur, wem der Bau gehört." } else { "Stell dich neben deine Hütte (oder dein Backhaus, deine Metzgerei) oder geh hinein." });
	};
	let Some(e) = c.space.take(&tmpl("Building", obj! { "buildId" => j::at(b, "buildId").clone() }), 5_000.0, c.txn()).await? else { return refuse("Der Bau ist gerade nicht greifbar; bitte noch einmal.") };
	Ok(fields(&e).clone())
}
const GUESTS_MAX: usize = 12;

async fn einladen(c: &mut Ctx, arg: &str) -> Result<()> {
	let b = own_house(c).await?;
	let n = js::re(r"\s+ein$", "i").replace(js::trim(arg), "");
	let me = c.char_id().to_owned();
	let bname = txt(j::at(&b, "name"));
	let guests = j::a(&b, "guests").to_vec();
	if n.is_empty() {
		c.space.write(&tmpl("Building", b.clone()), c.txn(), FOREVER).await?;
		let text = if guests.is_empty() { format!("In deine {bname} hast du niemanden eingeladen. „einladen <name>“ lädt jemanden ein.") } else { format!("In deine {bname} dürfen: {}. „ausladen <name>“ nimmt es zurück.", guests.iter().map(|g| txt(j::at(g, "name"))).collect::<Vec<_>>().join(", ")) };
		return msg(c, &me, "info", &text, MsgOpts::default()).await;
	}
	let Some(who) = c.space.read_all(&obj! { "type" => "Character" }, None).await?.iter().map(|e| fields(e).clone()).find(|ch| txt(j::at(ch, "name")).to_lowercase() == n.to_lowercase()) else {
		return refuse(format!("Eine Figur „{}“ gibt es hier nicht.", js::slice16(&n, 0, Some(30))));
	};
	let wname = txt(j::at(&who, "name"));
	if j::s(&who, "charId") == me { return refuse("In deinen eigenen Bau darfst du ohnehin."); }
	if guests.iter().any(|g| j::at(g, "charId") == j::at(&who, "charId")) { return refuse(format!("{wname} ist schon eingeladen.")); }
	if guests.len() >= GUESTS_MAX { return refuse(format!("Mehr als {GUESTS_MAX} Gäste lädt man nicht ein; „ausladen <name>“ macht Platz.")); }
	let mut more = guests;
	more.push(obj! { "charId" => j::at(&who, "charId").clone(), "name" => j::at(&who, "name").clone() });
	let mut nb = b.clone();
	j::set(&mut nb, "guests", Json::Array(more));
	c.space.write(&tmpl("Building", nb), c.txn(), FOREVER).await?;
	msg(c, &me, "info", &format!("{wname} darf jetzt in deine {bname}."), MsgOpts::default()).await?;
	msg(c, j::s(&who, "charId"), "info", &format!("{} lädt dich in die {bname} ein („betrete“ neben ihr).", txt(j::at(&c.actor, "name"))), MsgOpts { room: Some(txt(j::at(&who, "room"))), ..MsgOpts::default() }).await
}

async fn ausladen(c: &mut Ctx, arg: &str) -> Result<()> {
	let b = own_house(c).await?;
	let n = js::trim(arg).to_lowercase();
	let bname = txt(j::at(&b, "name"));
	let Some(g) = j::a(&b, "guests").iter().find(|x| txt(j::at(x, "name")).to_lowercase() == n).cloned() else {
		c.space.write(&tmpl("Building", b.clone()), c.txn(), FOREVER).await?;
		return refuse(if n.is_empty() { "Wen? Zum Beispiel: ausladen Mira".to_owned() } else { format!("{} ist nicht eingeladen.", js::slice16(js::trim(arg), 0, Some(30))) });
	};
	let gid = txt(j::at(&g, "charId"));
	let guests: Vec<Json> = j::a(&b, "guests").iter().filter(|x| j::s(x, "charId") != gid).cloned().collect();
	// `{ guests, ...rest }`, and the guests left after the rest
	let mut rest = j::without(&b, "guests");
	if !guests.is_empty() { j::set(&mut rest, "guests", Json::Array(guests)); }
	c.space.write(&tmpl("Building", rest), c.txn(), FOREVER).await?;
	let room_id = interior_of(j::s(&b, "buildId"));
	let me_name = txt(j::at(&c.actor, "name"));
	if let Some(inside) = c.space.read_all(&tmpl("Character", obj! { "charId" => gid.as_str(), "room" => room_id.as_str() }), c.txn()).await?.into_iter().next() {
		if let Some(front) = front_of(&c.space, c.w(), &b).await? {
			if let Some(t) = c.space.take_if_exists(&obj! { "id" => j::at(&inside, "id").clone() }, 5_000.0, c.txn()).await? {
				let txn = c.txn.clone();
				release_spot(&c.space, &txn, &gid).await?;
				let mut f = fields(&t).clone();
				j::set(&mut f, "room", j::at(&b, "room").clone());
				j::set(&mut f, "x", front.0);
				j::set(&mut f, "y", front.1);
				c.space.write(&again(&t, f), c.txn(), FOREVER).await?;
				msg(c, &gid, "info", &format!("{me_name} hat dich ausgeladen; du stehst vor der {bname}."), MsgOpts { room: Some(txt(j::at(&b, "room"))), ..MsgOpts::default() }).await?;
				let txn = c.txn.clone();
				super::sleep::wake_outside(&c.space, &txn, &gid, &txt(j::at(&b, "room"))).await?;
			}
		}
	}
	let me = c.char_id().to_owned();
	msg(c, &me, "info", &format!("{} darf nicht mehr in deine {bname}.", txt(j::at(&g, "name"))), MsgOpts::default()).await?;
	msg(c, &gid, "info", &format!("{me_name} hat die Einladung in die {bname} zurückgenommen."), MsgOpts::default()).await
}

pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"betrete" => betrete(c, arg).await,
		"einladen" => einladen(c, arg).await,
		"ausladen" => ausladen(c, arg).await,
		k => Err(Error::Other(format!("unported: interior/{k}"))),
	}
}
