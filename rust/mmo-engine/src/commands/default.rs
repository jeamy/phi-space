//! The commands every character has (`server/engine/commands/default.ts`), so far `step` and what it reaches: moving in
//! a room, taking an exit, describing the room one arrives in.
use phi_json::{obj, Json, Object};

use crate::context::{by_name, check, exits_here, inventory, items_here, items_named, msg, plural_of, reach, room_of, stem, where_to, Ctx, MsgOpts};
use crate::fire::{burn_text, covers_of, flame_of, fog_of, key_text};
use crate::j;
use crate::js::{self, JsRegex};
use crate::occupancy::{blocked_in, cell_key, cell_of, claim_spot, free_cell_near, is_passage, occupied_in, online_ids, release_spot};
use crate::room_growth::{grown_point, rows};
use crate::space::{by_id, fields, not_understood, refuse, tmpl, Error, Result, FOREVER, NO_WAIT};
use crate::world::{find_path, walkable, way_to};

fn xy(f: &Json) -> (f64, f64) { (j::n(f, "x"), j::n(f, "y")) }

/// `online`: characters with a live session (`room` None: all rooms).
pub async fn online(c: &Ctx, room: Option<&str>) -> Result<Vec<Json>> {
	let live = online_ids(&c.space).await?;
	let t = tmpl("Character", room.map_or_else(|| obj! {}, |r| obj! { "room" => r }));
	Ok(c.space.read_all(&t, None).await?.iter().map(|e| fields(e).clone()).filter(|ch| live.contains(&key_text(j::at(ch, "charId")))).collect())
}

/// `moveTo`: to a cell of the actor's room; an exit on it is taken at once. `path`: the whole walk must get around
/// whoever stands in the way.
pub async fn move_to(c: &mut Ctx, to: (f64, f64), path: bool, room: Option<Json>) -> Result<()> {
	let exits: Vec<Json> = exits_here(c, None).await?.iter().map(|x| fields(x).clone()).collect();
	if let Some(exit) = exits.iter().find(|x| xy(x) == to) { return traverse(c, exit).await; }
	let room = match room { Some(r) => r, None => room_of(c, None).await? };
	let room_id = j::s(&room, "roomId").to_owned();
	let solid = blocked_in(&c.space, &room_id).await?;
	let at = cell_key(to.0, to.1);
	let plots: Vec<Json> = if solid.contains(&at) { c.space.read_all(&tmpl("Plot", obj! { "room" => room_id.as_str() }), None).await?.iter().map(|e| fields(e).clone()).collect() } else { vec![] };
	let me = xy(&c.actor);
	let inside = plots.iter().find(|p| xy(p) == me).map(|p| j::at(p, "of").clone());
	let through = inside.as_ref().is_some_and(|i| j::truthy(i) && plots.iter().any(|p| j::at(p, "of") == i && xy(p) == to));
	if solid.contains(&at) && !through {
		let fire = j::a(c.w(), "beacons").iter().any(|b| j::s(b, "room") == room_id && xy(b) == to);
		return refuse(if fire { "Dort brennt das Leuchtfeuer; da läuft man nicht hinein." } else { "Dort steht ein Bau; da geht man außen herum." });
	}
	let passage = is_passage(&exits, to.0, to.1);
	if path {
		let occ = occupied_in(&c.space, &room_id, Some(c.char_id())).await?;
		if let Some((_, there)) = occ.iter().find(|(k, _)| *k == at) { if !passage { return refuse(format!("Dort steht schon {there}.")); } }
		let mut blocked: std::collections::HashSet<String> = occ.iter().filter(|(k, _)| { let mut p = k.split(',').map(js::to_number); let (x, y) = (p.next().unwrap_or(f64::NAN), p.next().unwrap_or(f64::NAN)); !is_passage(&exits, x, y) }).map(|(k, _)| k.clone()).collect();
		blocked.extend(solid.iter().cloned());
		if find_path(c.w(), &rows(j::at(&room, "ground")), me, to, 40, &|k| blocked.contains(k)).is_none() { return refuse("Dorthin führt kein freier Weg."); }
	}
	if passage { release_spot(&c.space, &c.txn, c.char_id()).await?; }
	relocate(c, &room_id, to, !passage, None).await
}

/// `relocate`: takes the actor's character and writes it at a new place; its Spot goes along unless `spot` is false.
pub async fn relocate(c: &mut Ctx, room: &str, to: (f64, f64), spot: bool, refused: Option<&str>) -> Result<()> {
	if spot {
		let name = j::at(&c.actor, "name").clone();
		if let Some(there) = claim_spot(&c.space, &c.txn, c.char_id(), &name, room, to.0, to.1).await? { return refuse(format!("Dort steht schon {there}.")); }
	}
	let Some(e) = c.space.take(&tmpl("Character", obj! { "charId" => c.char_id() }), 5_000.0, c.txn()).await? else { return refuse("Deine Figur ist gerade nicht greifbar; bitte noch einmal.") };
	let mut ch: Object = j::object(&j::without(fields(&e), "refused"));
	ch.insert("room", Json::from(room));
	ch.insert("x", Json::from(to.0));
	ch.insert("y", Json::from(to.1));
	if let Some(s) = &c.step { ch.insert("ack", s.clone()); }
	if let Some(r) = refused { ch.insert("refused", Json::from(r)); }
	c.space.write(&obj! { "type" => "Character", "fields" => Json::Object(ch) }, c.txn(), FOREVER).await?;
	Ok(())
}

/// `placeIn`: onto a free cell of `room`, starting at `at` (`exits` false: exits are not avoided, nor is a passage
/// taken as it is); `avoid`: cells not to land on.
pub async fn place_in(c: &mut Ctx, room: &Json, at: (f64, f64), exits_too: bool, avoid: &[String]) -> Result<(f64, f64)> {
	let room_id = j::s(room, "roomId").to_owned();
	let ground = rows(j::at(room, "ground"));
	let exits: Vec<Json> = exits_here(c, Some(&room_id)).await?.iter().map(|x| fields(x).clone()).collect();
	let blocked = blocked_in(&c.space, &room_id).await?;
	let key = cell_key(at.0, at.1);
	if exits_too && !avoid.contains(&key) && is_passage(&exits, at.0, at.1) && !exits.iter().any(|x| xy(x) == at) && walkable(c.w(), &ground, at.0, at.1) && !blocked.contains(&key) {
		release_spot(&c.space, &c.txn, c.char_id()).await?;
		return Ok(at);
	}
	let mut keep: std::collections::HashSet<String> = occupied_in(&c.space, &room_id, Some(c.char_id())).await?.into_iter().map(|(k, _)| k).collect();
	keep.extend(blocked);
	if exits_too { for x in exits_here(c, Some(&room_id)).await? { keep.insert(cell_of(fields(&x))); } }
	keep.extend(avoid.iter().cloned());
	for _ in 0..4 {
		let Some(cell) = free_cell_near(c.w(), &ground, at, &|k| keep.contains(k), 8) else { break };
		let name = j::at(&c.actor, "name").clone();
		if claim_spot(&c.space, &c.txn, c.char_id(), &name, &room_id, cell.0, cell.1).await?.is_none() { return Ok(cell); }
		keep.insert(cell_key(cell.0, cell.1));
	}
	refuse(format!("In {} ist kein Platz mehr.", key_text(j::at(room, "name"))))
}

/// `dropOffers`: leaving a room ends the trade offers made there.
pub async fn drop_offers(c: &Ctx) -> Result<()> {
	for side in ["from", "to"] {
		let mut f = Object::new();
		f.insert(side, Json::from(c.char_id()));
		for e in c.space.read_all(&tmpl("Offer", Json::Object(f)), None).await? {
			let Some(taken) = c.space.take_if_exists(&by_id("Offer", &e), NO_WAIT, c.txn()).await? else { continue };
			let o = fields(&taken);
			let name = key_text(j::at(&c.actor, "name"));
			let (to, text) = if side == "from" { (key_text(j::at(o, "to")), format!("{name} ist gegangen; das Angebot gilt nicht mehr.")) } else { (key_text(j::at(o, "from")), format!("{name} ist gegangen und hat dein Angebot nicht angenommen.")) };
			msg(c, &to, "info", &text, MsgOpts::default()).await?;
		}
	}
	Ok(())
}

/// `throughFog`: dense fog hides every way but the one toward a fire that keeps this room clear.
async fn through_fog(c: &Ctx, exit: &Json) -> Result<()> {
	let cover = covers_of(&c.space, c.w(), c.txn()).await?;
	let room = c.room().to_owned();
	let fires: Vec<&Json> = j::a(c.w(), "beacons").iter().filter(|b| cover.iter().find(|(k, _)| k == j::s(b, "beaconId")).is_some_and(|(_, l)| l.contains(&room))).collect();
	let room_name = |id: &str| j::by(j::a(c.w(), "rooms"), "roomId", id).map_or_else(|| id.to_owned(), |r| j::s(r, "name").to_owned());
	let whereto = where_to(c.w(), exit);
	if let Some(here) = fires.iter().find(|b| j::s(b, "room") == room) {
		return refuse(format!("Der Nebel ist zu dicht; den Weg nach {whereto} findest du nicht. Entzünde das {} hier, dann lichtet er sich.", key_text(j::at(here, "name"))));
	}
	let ways: Vec<(&Json, String)> = fires.iter().filter_map(|b| way_to(c.w(), &room, j::s(b, "room")).filter(|w| !w.is_empty()).map(|w| (*b, w))).collect();
	if ways.iter().any(|(_, w)| w == j::s(exit, "name")) { return Ok(()); }
	refuse(match ways.first() {
		Some((b, way)) => format!("Der Nebel ist zu dicht; den Weg nach {whereto} findest du nicht. Das {} steht in {}; den Weg nach {way} dorthin findest du noch.", key_text(j::at(b, "name")), room_name(j::s(b, "room"))),
		None => format!("Der Nebel ist zu dicht; den Weg nach {whereto} findest du nicht. Ein Leuchtfeuer würde helfen."),
	})
}

/// `crossing`: the region a room of another region lies in; None when it is here or the world runs as one space.
pub fn crossing(w: &Json, room: &str) -> Result<Option<String>> {
	if !j::b(w, "region") || j::a(w, "rooms").iter().any(|r| j::s(r, "roomId") == room) { return Ok(None); }
	Err(Error::Other("unported: regions (crossing)".into()))
}

/// `traverse`: through an exit.
pub async fn traverse(c: &mut Ctx, exit: &Json) -> Result<()> {
	let whereto = where_to(c.w(), exit);
	check(c, j::s(exit, "locks"), "traverse", &format!("Der Weg nach {whereto} ist dir versperrt.")).await?;
	if let Some(max) = exit.get("fogMax") { if fog_of(&c.space, c.room()).await? > j::number(max) { through_fog(c, exit).await?; } }
	if crossing(c.w(), j::s(exit, "destination"))?.is_some() { return Err(Error::Other("unported: handOff".into())); }
	let dest = room_of(c, Some(j::s(exit, "destination"))).await?;
	let dest_id = j::s(&dest, "roomId").to_owned();
	let growth = c.space.read_all(&tmpl("RoomGrowth", obj! { "roomId" => dest_id.as_str() }), c.txn()).await?.into_iter().next();
	let revision = j::no(exit, "arriveGrowthRevision").unwrap_or(0.0) as usize;
	let arrive = j::at(exit, "arrive");
	let arrival = match &growth { Some(g) => grown_point(arrive, fields(g), revision), None => arrive.clone() };
	let at = place_in(c, &dest, xy(&arrival), true, &[]).await?;
	relocate(c, &dest_id, at, false, None).await?;
	drop_offers(c).await?;
	msg(c, "*", "info", &format!("$you() $conj(gehst|geht) nach {whereto}."), MsgOpts { templ: true, ..Default::default() }).await?;
	msg(c, "*", "info", "$you() $conj(kommst|kommt) an.", MsgOpts { templ: true, room: Some(dest_id.clone()), ..Default::default() }).await?;
	let text = describe_room(c, &dest_id, true).await?;
	let me = c.char_id().to_owned();
	msg(c, &me, "look", &text, MsgOpts { room: Some(dest_id), ..Default::default() }).await
}

/// `beaconsIn`.
pub async fn beacons_in(c: &Ctx, room_id: &str) -> Result<Vec<Json>> { c.space.read_all(&tmpl("Beacon", obj! { "room" => room_id }), None).await }

/// `countedNames`: "3 Muscheln" for several of a kind, in collation order.
pub fn counted_names(names: &[String], w: &Json) -> Vec<String> {
	let mut kinds: Vec<(String, usize)> = Vec::new();
	for n in names { match kinds.iter_mut().find(|(k, _)| k == n) { Some(slot) => slot.1 += 1, None => kinds.push((n.clone(), 1)) } }
	kinds.sort_by(|a, b| js::locale_compare(&a.0, &b.0));
	kinds.into_iter().map(|(name, n)| if n > 1 { format!("{n} {}", crate::context::plural_of(&name, Some(w))) } else { name }).collect()
}

/// `describeRoom`.
pub async fn describe_room(c: &Ctx, room_id: &str, arriving: bool) -> Result<String> {
	let room = room_of(c, Some(room_id)).await?;
	let mut exits: Vec<String> = exits_here(c, Some(room_id)).await?.iter().map(|x| { let f = fields(x); let to = where_to(c.w(), f); if to == j::s(f, "name") { to } else { format!("{} ({to})", j::s(f, "name")) } }).collect();
	js::utf16_sort(&mut exits);
	let mut items: Vec<String> = c.space.read_all(&tmpl("Item", obj! { "location" => room_id }), None).await?.iter().map(|e| key_text(j::at(fields(e), "name"))).collect();
	js::utf16_sort(&mut items);
	let mut scenery: Vec<String> = c.space.read_all(&tmpl("Scenery", obj! { "room" => room_id }), None).await?.iter().map(|e| key_text(j::at(fields(e), "name"))).collect();
	js::utf16_sort(&mut scenery);
	let me = c.char_id().to_owned();
	let others: Vec<String> = online(c, Some(room_id)).await?.iter().filter(|ch| j::s(ch, "charId") != me).map(|ch| key_text(j::at(ch, "name"))).collect();
	let beacons = beacons_in(c, room_id).await?;
	let fog = fog_of(&c.space, room_id).await?;
	let settlement = super::settlement::settlement_in(&c.space, room_id, c.txn()).await?;
	let mut out: Vec<String> = vec![key_text(j::at(&room, "name")), key_text(j::at(&room, "desc"))];
	if let Some(s) = settlement { out.push(format!("Hier liegt die Siedlung {}.", key_text(j::at(&s, "name")))); }
	for b in &beacons {
		let f = fields(b);
		let flame = flame_of(&c.space, j::s(f, "beaconId"), None).await?;
		let now = crate::clock::world_now_of(&c.space, c.txn()).await?;
		out.push(format!("Das {} {}.", key_text(j::at(f, "name")), burn_text(flame.as_ref(), now)));
	}
	out.push(if fog == 0.0 || fog.is_nan() { "Die Luft ist klar.".into() } else { ["", "Leichter Nebel liegt über allem.", "Dichter Nebel; man sieht kaum zum Wasser.", "Undurchdringlicher Nebel verschluckt die Wege."][fog.min(3.0) as usize].into() });
	out.push(if exits.is_empty() { "Kein Weg führt hinaus.".into() } else { format!("Ausgänge: {}.", exits.join(", ")) });
	if !items.is_empty() { out.push(format!("Hier liegt: {}.", counted_names(&items, c.w()).join(", "))); }
	if !scenery.is_empty() { out.push(format!("Hier steht: {}.", counted_names(&scenery, c.w()).join(", "))); }
	out.push(if arriving && others.is_empty() { "Niemand ist hier.".into() } else if !others.is_empty() { format!("Hier sind: {}.", others.join(", ")) } else { "Niemand sonst ist hier.".into() });
	Ok(out.join("\n"))
}

thread_local! { static BLANKS: JsRegex = JsRegex::new(r"\s+", "").expect("the blanks pattern"); }

/// `arg.split(/\s+/)`.
pub fn words(arg: &str) -> Vec<String> { BLANKS.with(|b| b.split(arg).into_iter().map(|p| p.unwrap_or("").to_owned()).collect()) }

fn is_integer(n: f64) -> bool { n.is_finite() && n.fract() == 0.0 }

/// `step <dx> <dy>`: one step; a numbered step of a page that cannot be taken is still answered.
pub async fn step(c: &mut Ctx, arg: &str) -> Result<()> {
	let d: Vec<f64> = words(arg).iter().map(|s| js::to_number(s)).collect();
	let (dx, dy) = (d.first().copied().unwrap_or(f64::NAN), d.get(1).copied().unwrap_or(f64::NAN));
	if !is_integer(dx) || !is_integer(dy) || dx.abs() + dy.abs() != 1.0 { return refuse("So geht es: step <dx> <dy> mit einem Schritt, z. B. step 1 0"); }
	let me = xy(&c.actor);
	let to = (me.0 + dx, me.1 + dy);
	let tried: Result<()> = async {
		let room = room_of(c, None).await?;
		if !walkable(c.w(), &rows(j::at(&room, "ground")), to.0, to.1) { return refuse("Da geht es nicht weiter."); }
		move_to(c, to, false, Some(room)).await
	}.await;
	let Err(e) = tried else { return Ok(()) };
	if !e.is_command() || c.step.is_none() { return Err(e); }
	let text = e.to_string();
	if j::at(&c.actor, "refused").as_str() != Some(text.as_str()) { let me = c.char_id().to_owned(); msg(c, &me, "error", &text, MsgOpts::default()).await?; }
	let room = c.room().to_owned();
	relocate(c, &room, me, false, Some(&text)).await
}

const MAX_SAY: usize = 300;

fn me(c: &Ctx) -> String { c.char_id().to_owned() }
fn name_of(e: &Json) -> String { key_text(j::at(fields(e), "name")) }
fn templ() -> MsgOpts { MsgOpts { templ: true, ..Default::default() } }
/// An entry written anew from a taken one (`{ type: e.type, types: e.types.slice(1), fields }`).
fn anew(e: &Json, f: Json) -> Json {
	let types: Vec<Json> = j::a(e, "types").iter().skip(1).cloned().collect();
	obj! { "type" => j::at(e, "type").clone(), "types" => Json::Array(types), "fields" => f }
}

/// The commands of this module by key.
pub async fn run(c: &mut Ctx, key: &str, arg: &str) -> Result<()> {
	match key {
		"look" => look(c, arg).await,
		"say" => say(c, arg).await,
		"emote" => emote(c, arg).await,
		"who" => who(c).await,
		"move" => walk_to(c, arg).await,
		"step" => step(c, arg).await,
		"arrive" => arrive(c).await,
		"go" => go(c, arg).await,
		"get" => get(c, arg).await,
		"drop" => drop(c, arg).await,
		"put" => put(c, arg).await,
		"give" => give(c, arg).await,
		"inventory" => inv(c).await,
		"channel" => channel(c, arg).await,
		k => Err(Error::Other(format!("unported: default/{k}"))),
	}
}

async fn look(c: &mut Ctx, arg: &str) -> Result<()> {
	let m = me(c);
	if arg.is_empty() { let room = c.room().to_owned(); let t = describe_room(c, &room, false).await?; return msg(c, &m, "look", &t, MsgOpts::default()).await; }
	let mut list = inventory(c).await?;
	list.extend(items_here(c).await?);
	if let Some(item) = items_named(c.w(), &list, arg, Some(xy(&c.actor))).into_iter().next() {
		let f = fields(&item);
		let desc = j::s(f, "desc");
		return msg(c, &m, "look", &format!("{}\n{}", key_text(j::at(f, "name")), if desc.is_empty() { "Nichts Besonderes." } else { desc }), MsgOpts::default()).await;
	}
	let room = c.room().to_owned();
	if let Some(beacon) = by_name(&beacons_in(c, &room).await?, arg, None).into_iter().next() {
		let b = fields(&beacon);
		let mut top: Vec<Json> = c.space.read_all(&tmpl("Contribution", obj! { "beaconId" => j::at(b, "beaconId").clone() }), None).await?.iter().map(|e| fields(e).clone()).collect();
		top.sort_by(|x, y| (j::n(y, "pieces") - j::n(x, "pieces")).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
		top.truncate(3);
		let flame = flame_of(&c.space, j::s(b, "beaconId"), None).await?;
		let now = crate::clock::world_now_of(&c.space, c.txn()).await?;
		let tail = if top.is_empty() { "\nNoch hat niemand nachgelegt.".to_owned() } else { format!("\nAm meisten nachgelegt: {}.", top.iter().map(|t| format!("{} ({})", key_text(j::at(t, "name")), key_text(j::at(t, "pieces")))).collect::<Vec<_>>().join(", ")) };
		return msg(c, &m, "look", &format!("{}: Es {}.{tail}", key_text(j::at(b, "name")), burn_text(flame.as_ref(), now)), MsgOpts::default()).await;
	}
	if let Some(exit) = by_name(&exits_here(c, None).await?, arg, None).into_iter().next() {
		let f = fields(&exit);
		let desc = j::s(f, "desc");
		return msg(c, &m, "look", &format!("{}: {}", key_text(j::at(f, "name")), if desc.is_empty() { "ein Weg" } else { desc }), MsgOpts::default()).await;
	}
	let low = arg.to_lowercase();
	if let Some(p) = online(c, Some(&room)).await?.into_iter().find(|ch| j::s(ch, "name").to_lowercase().starts_with(&low)) {
		return msg(c, &m, "look", &format!("{} steht hier.", key_text(j::at(&p, "name"))), MsgOpts::default()).await;
	}
	let want = js::trim(arg).to_lowercase();
	if let Some(piece) = c.space.read_all(&tmpl("Scenery", obj! { "room" => room.as_str() }), None).await?.iter().map(|e| fields(e).clone()).find(|s| j::s(s, "name").to_lowercase() == want) {
		return msg(c, &m, "look", &format!("{}\n{}", key_text(j::at(&piece, "name")), crate::world::scenery_text(c.w(), &piece)), MsgOpts::default()).await;
	}
	not_understood(format!("Hier ist nichts, was „{}“ heißt.", js::slice16(arg, 0, Some(30))))
}

async fn say(c: &mut Ctx, text: &str) -> Result<()> {
	if text.is_empty() { return refuse("Was möchtest du sagen? Zum Beispiel: say Hallo"); }
	msg(c, "*", "say", &format!("{}: {}", key_text(j::at(&c.actor, "name")), phi_spaces_client::cut_text(text, MAX_SAY)), MsgOpts::default()).await
}

async fn emote(c: &mut Ctx, text: &str) -> Result<()> {
	if text.is_empty() { return refuse("Was tust du? Zum Beispiel: emote winkt"); }
	msg(c, "*", "emote", &format!("{} {}", key_text(j::at(&c.actor, "name")), phi_spaces_client::cut_text(text, MAX_SAY)), MsgOpts::default()).await
}

async fn who(c: &mut Ctx) -> Result<()> {
	let rooms: Vec<(String, String)> = c.space.read_all(&obj! { "type" => "Room" }, None).await?.iter().map(|e| { let f = fields(e); (key_text(j::at(f, "roomId")), key_text(j::at(f, "name"))) }).collect();
	let mut list: Vec<String> = online(c, None).await?.iter().map(|ch| {
		let room = key_text(j::at(ch, "room"));
		let shown = rooms.iter().rev().find(|(k, _)| *k == room).map_or(room.clone(), |(_, n)| n.clone());
		format!("{}{} ({shown})", key_text(j::at(ch, "name")), if j::s(ch, "charId").starts_with("npc-siedler-") { ", Siedler" } else { "" })
	}).collect();
	js::utf16_sort(&mut list);
	let m = me(c);
	msg(c, &m, "who", &format!("Gerade spielen {}: {}", list.len(), list.join(", ")), MsgOpts::default()).await
}

/// `move <x> <y>`.
async fn walk_to(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = words(arg);
	let (x, y) = (w.first().map_or(f64::NAN, |s| js::to_number(s)), w.get(1).map_or(f64::NAN, |s| js::to_number(s)));
	if !is_integer(x) || !is_integer(y) || w.len() != 2 { return refuse("So geht es: move <x> <y>, zum Beispiel move 10 8"); }
	let room = room_of(c, None).await?;
	let Some(path) = find_path(c.w(), &rows(j::at(&room, "ground")), xy(&c.actor), (x, y), 40, &|_| false) else { return refuse("Dorthin führt kein Weg.") };
	if !path.is_empty() { move_to(c, (x, y), true, None).await?; }
	Ok(())
}

async fn arrive(c: &mut Ctx) -> Result<()> {
	let room = room_of(c, None).await?;
	let at = place_in(c, &room, xy(&c.actor), false, &[]).await?;
	if at != xy(&c.actor) { let id = j::s(&room, "roomId").to_owned(); relocate(c, &id, at, false, None).await?; }
	Ok(())
}

async fn go(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(exit) = by_name(&exits_here(c, None).await?, arg, None).into_iter().next() else {
		return not_understood(if arg.is_empty() { "Wohin? Zum Beispiel: go ost".to_owned() } else { format!("Hier gibt es keinen Ausgang „{}“.", js::slice16(arg, 0, Some(20))) });
	};
	let f = fields(&exit).clone();
	traverse(c, &f).await
}

async fn get(c: &mut Ctx, arg: &str) -> Result<()> {
	if arg.is_empty() { return not_understood("Was möchtest du aufheben? Zum Beispiel: get treibholz"); }
	let here = items_here(c).await?;
	let found = items_named(c.w(), &here, arg, Some(xy(&c.actor)));
	let Some(item) = found.iter().find(|i| reach(fields(i), &c.actor) <= 1.0).cloned() else {
		return match found.first() { Some(f) => refuse(format!("{} liegt zu weit weg; geh näher heran.", name_of(f))), None => not_understood(format!("Hier liegt nichts, was „{}“ heißt.", js::slice16(arg, 0, Some(30)))) };
	};
	let f = fields(&item).clone();
	check(c, j::s(&f, "locks"), "get", &format!("{} lässt sich nicht aufheben.", name_of(&item))).await?;
	let Some(e) = c.space.take(&tmpl("Item", obj! { "itemId" => j::at(&f, "itemId").clone(), "location" => c.room() }), NO_WAIT, c.txn()).await? else { return refuse("Zu spät – jemand anderes war schneller.") };
	let mut kept = j::object(&j::without(fields(&e), "expiresWorldMs"));
	kept.insert("location", Json::from(c.char_id()));
	kept.insert("x", Json::from(-1.0));
	kept.insert("y", Json::from(-1.0));
	c.space.write(&anew(&e, Json::Object(kept)), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(hebst|hebt) {} auf.", name_of(&item)), templ()).await
}

async fn drop(c: &mut Ctx, arg: &str) -> Result<()> {
	if js::re(r"\s(in|ins|into)\s", "i").test(arg) { return put(c, arg).await; }
	let inv = inventory(c).await?;
	let Some(item) = items_named(c.w(), &inv, arg, None).into_iter().next() else {
		return not_understood(if arg.is_empty() { "Was möchtest du ablegen?".to_owned() } else { format!("Du trägst nichts, was „{}“ heißt.", js::slice16(arg, 0, Some(30))) });
	};
	let f = fields(&item).clone();
	check(c, j::s(&f, "locks"), "drop", &format!("{} lässt sich nicht ablegen.", name_of(&item))).await?;
	let Some(e) = c.space.take(&tmpl("Item", obj! { "itemId" => j::at(&f, "itemId").clone(), "location" => c.char_id() }), NO_WAIT, c.txn()).await? else { return refuse(format!("{} ist gerade nicht greifbar.", name_of(&item))) };
	let mut g = j::object(fields(&e));
	g.insert("location", Json::from(c.room()));
	g.insert("x", j::at(&c.actor, "x").clone());
	g.insert("y", j::at(&c.actor, "y").clone());
	c.space.write(&anew(&e, Json::Object(g)), c.txn(), FOREVER).await?;
	msg(c, "*", "info", &format!("$you() $conj(legst|legt) {} ab.", name_of(&item)), templ()).await
}

const NUMBERS: [(&str, f64); 18] = [("ein", 1.0), ("eine", 1.0), ("einen", 1.0), ("zwei", 2.0), ("drei", 3.0), ("vier", 4.0), ("fünf", 5.0), ("fuenf", 5.0), ("sechs", 6.0), ("sieben", 7.0), ("acht", 8.0), ("neun", 9.0), ("zehn", 10.0), ("one", 1.0), ("two", 2.0), ("three", 3.0), ("four", 4.0), ("five", 5.0)];

/// `countOf`: "5 holz" → 5 and "holz", "alle hölzer" → all; without a number None and the words as they are.
fn count_of(words: &str) -> (Option<f64>, String) {
	let t = js::trim(words);
	let Some(m) = js::caps(&js::re(r"^(\d+|alle|alles|all|[a-zäöü]+)\s+(.+)$", "i"), t) else { return (None, t.to_owned()) };
	let w = m[1].clone().unwrap_or_default().to_lowercase();
	let what = js::re(r"^(?:stück|stücke|stueck|stuecke|pieces? of)\s+", "i").replace(js::trim(&m[2].clone().unwrap_or_default()), "");
	if js::re(r"^\d+$", "").test(&w) { return (Some(1f64.max(50f64.min(js::to_number(&w)))), what); }
	if w == "alle" || w == "alles" || w == "all" { return (Some(f64::INFINITY), what); }
	if let Some((_, n)) = NUMBERS.iter().find(|(k, _)| *k == w) { return (Some(*n), what); }
	(None, t.to_owned())
}

async fn put(c: &mut Ctx, arg: &str) -> Result<()> {
	let m = js::caps(&js::re(r"^(.+?)\s+(?:in|ins|into)\s+(.+)$", "i"), arg);
	let place = m.as_ref().map_or("feuer".to_owned(), |m| m[2].clone().unwrap_or_default());
	let (count, what) = count_of(&m.as_ref().map_or(arg.to_owned(), |m| m[1].clone().unwrap_or_default()));
	let inv = inventory(c).await?;
	let found = items_named(c.w(), &inv, &what, None);
	if found.is_empty() { return not_understood(if what.is_empty() { "Was möchtest du nachlegen? Zum Beispiel: put treibholz in feuer".to_owned() } else { format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&what, 0, Some(30))) }); }
	let room = c.room().to_owned();
	let Some(beacon) = by_name(&beacons_in(c, &room).await?, &place, Some(xy(&c.actor))).into_iter().next() else { return not_understood(format!("Hier ist kein {}.", js::slice16(&place, 0, Some(30)))) };
	let b = fields(&beacon).clone();
	if reach(&b, &c.actor) > 1.0 { return refuse(format!("Das {} ist zu weit weg; geh näher heran.", key_text(j::at(&b, "name")))); }
	let wl = what.to_lowercase();
	let plural = count.is_none() && !found.iter().any(|i| { let f = fields(i); std::iter::once(j::s(f, "name")).chain(j::strs(j::a(f, "aliases"))).any(|n| n.to_lowercase() == wl) }) && stem(&what) != wl;
	let want = count.unwrap_or(if plural { f64::INFINITY } else { 1.0 });
	if want == 1.0 { crate::fire::feed(c, &found[0], &b, false).await?; return Ok(()); }
	let fuel: Vec<&Json> = found.iter().filter(|i| j::truthy(j::at(j::at(j::at(c.w(), "fire"), "fuel"), j::s(fields(i), "proto")))).collect();
	if fuel.is_empty() { return refuse(format!("{} brennt nicht.", name_of(&found[0]))); }
	let pieces: Vec<&Json> = fuel.into_iter().take(if want.is_finite() { want as usize } else { usize::MAX }).collect();
	let mut last = (0.0, 0.0);
	for i in &pieces { last = crate::fire::feed(c, i, &b, true).await?; }
	let names = crate::fire::uniq(&pieces.iter().map(|i| name_of(i)).collect::<Vec<_>>()).join(", ");
	let short = if want.is_finite() && (pieces.len() as f64) < want { " (mehr hast du nicht dabei)" } else { "" };
	let text = format!("$you() $conj(legst|legt) {} {names} ins {}{short}. Es {}.", pieces.len(), key_text(j::at(&b, "name")), burn_text(Some(&obj! { "beaconId" => j::at(&b, "beaconId").clone(), "until" => last.0, "litAt" => last.1 }), last.1));
	msg(c, "*", "info", &text, templ()).await
}

const GIVE_MAX: f64 = 50.0;

async fn give(c: &mut Ctx, arg: &str) -> Result<()> {
	let Some(m) = js::caps(&js::re(r"^(.+?)\s+(?:an|to|zu)\s+(.+)$", "i"), arg).or_else(|| js::caps(&js::re(r"^(.+)\s+(\S+)$", ""), arg)) else { return not_understood("So geht es: give [anzahl] <ding> an <person>") };
	let (m1, m2) = (m[1].clone().unwrap_or_default(), m[2].clone().unwrap_or_default());
	let cm = js::caps(&js::re(r"^(\d+)\s+(.+)$", ""), js::trim(&m1));
	let want = cm.as_ref().map_or(1.0, |x| js::to_number(x[1].as_deref().unwrap_or("")));
	let what = cm.as_ref().map_or(m1.clone(), |x| x[2].clone().unwrap_or_default());
	if !(1.0..=GIVE_MAX).contains(&want) { return refuse(format!("Du kannst 1 bis {} Stück auf einmal geben.", GIVE_MAX)); }
	let inv = inventory(c).await?;
	let hits = items_named(c.w(), &inv, &what, None);
	let Some(item) = hits.first().cloned() else { return not_understood(format!("Du trägst nichts, was „{}“ heißt.", js::slice16(&what, 0, Some(30)))) };
	let proto = j::at(fields(&item), "proto").clone();
	let same: Vec<&Json> = hits.iter().filter(|i| *j::at(fields(i), "proto") == proto).collect();
	if (same.len() as f64) < want { return refuse(format!("Du trägst nur {}× {}.", same.len(), name_of(&item))); }
	let target = js::trim(&m2).to_lowercase();
	let room = c.room().to_owned();
	let mine = me(c);
	let Some(who) = c.space.read_all(&tmpl("Character", obj! { "room" => room.as_str() }), None).await?.iter().map(|e| fields(e).clone()).filter(|ch| j::s(ch, "charId") != mine && !j::truthy(j::at(ch, "aboard"))).find(|ch| j::s(ch, "name").to_lowercase() == target) else {
		return not_understood(format!("Hier ist niemand namens „{}“.", js::slice16(&m2, 0, Some(30))));
	};
	let refusal = if c.account.as_ref().is_some_and(|a| j::b(a, "guest")) { "Gäste können nichts weitergeben; registriere dich dafür.".to_owned() } else { format!("{} lässt sich nicht weitergeben.", name_of(&item)) };
	check(c, j::s(fields(&item), "locks"), "give", &refusal).await?;
	let mut taken = Vec::new();
	for one in same.iter().take(want as usize) {
		let Some(e) = c.space.take(&tmpl("Item", obj! { "itemId" => j::at(fields(one), "itemId").clone(), "location" => mine.as_str() }), NO_WAIT, c.txn()).await? else { return refuse(format!("{} ist gerade nicht greifbar.", name_of(&item))) };
		taken.push(e);
	}
	for e in &taken {
		let mut g = j::object(fields(e));
		g.insert("location", j::at(&who, "charId").clone());
		g.insert("x", Json::from(-1.0));
		g.insert("y", Json::from(-1.0));
		c.space.write(&anew(e, Json::Object(g)), c.txn(), FOREVER).await?;
	}
	let what = if want > 1.0 { format!("{} {}", phi_json::number_text(want), plural_of(&name_of(&item), Some(c.w()))) } else { name_of(&item) };
	msg(c, "*", "info", &format!("$you() $conj(gibst|gibt) {} {what}.", key_text(j::at(&who, "name"))), templ()).await
}

async fn inv(c: &mut Ctx) -> Result<()> {
	let names: Vec<String> = inventory(c).await?.iter().map(name_of).collect();
	let list = counted_names(&names, c.w());
	let m = me(c);
	msg(c, &m, "info", &if list.is_empty() { "Du trägst nichts.".to_owned() } else { format!("Du trägst: {}.", list.join(", ")) }, MsgOpts::default()).await
}

async fn channel(c: &mut Ctx, arg: &str) -> Result<()> {
	let w = words(arg);
	let name = w.first().cloned().unwrap_or_default();
	let text = js::trim(&w.iter().skip(1).cloned().collect::<Vec<_>>().join(" ")).to_owned();
	let channels: Vec<String> = j::a(c.w(), "channels").iter().map(key_text).collect();
	let m = me(c);
	if name.is_empty() { return msg(c, &m, "info", &format!("Kanäle: {} (kanal <name> <text>)", channels.join(", ")), MsgOpts::default()).await; }
	let low = name.to_lowercase();
	let Some(ch) = channels.iter().find(|x| **x == low).cloned() else { return not_understood(format!("Einen Kanal „{}“ gibt es nicht. Kanäle: {}", js::slice16(&name, 0, Some(20)), channels.join(", "))) };
	if text.is_empty() { return refuse(format!("Was möchtest du auf {ch} sagen?")); }
	msg(c, &format!("#{ch}"), "channel", &format!("[{ch}] {}: {}", key_text(j::at(&c.actor, "name")), js::slice16(&text, 0, Some(MAX_SAY as isize))), MsgOpts::default()).await
}

/// `helpParts`: every word a command answers to, its arguments and what it does.
pub fn help_parts(cmd: &super::Command) -> (Vec<String>, String, String) {
	let mut names = vec![cmd.key.clone()];
	names.extend(cmd.aliases.iter().flatten().filter(|a| js::re(r"^\p{L}{2,}$", "u").test(a)).cloned());
	let rest = if cmd.help.starts_with(&cmd.key) { cmd.help[cmd.key.len()..].to_owned() } else { format!(" – {}", cmd.help) };
	match rest.find(" – ") {
		None => (names, String::new(), js::trim(&rest).to_owned()),
		Some(d) => (names, js::trim(&rest[..d]).to_owned(), js::trim(&rest[d + " – ".len()..]).to_owned()),
	}
}

/// `helpLine`.
pub fn help_line(cmd: &super::Command) -> String {
	let (names, usage, text) = help_parts(cmd);
	format!("{}{} – {text}", names.join("/"), if usage.is_empty() { String::new() } else { format!(" {usage}") })
}

/// `help [befehl|thema]`: `commands` are the actor's, without the exits.
pub async fn help(c: &mut Ctx, arg: &str, commands: &[std::rc::Rc<super::Command>]) -> Result<()> {
	let topics: Vec<Json> = c.space.read_all(&obj! { "type" => "HelpEntry" }, None).await?.iter().map(|e| fields(e).clone()).collect();
	let m = me(c);
	if arg.is_empty() {
		let intro = topics.iter().find(|t| j::s(t, "key") == "intro").and_then(|t| j::opt(t, "text").cloned()).unwrap_or(Json::from(""));
		let shown: Vec<&std::rc::Rc<super::Command>> = commands.iter().filter(|x| !x.hidden).collect();
		let mut more: Vec<String> = topics.iter().filter(|t| j::s(t, "key") != "intro").map(|t| key_text(j::at(t, "key"))).collect();
		js::utf16_sort(&mut more);
		let mut lines: Vec<String> = vec![key_text(&intro), "Befehle:".into()];
		lines.extend(shown.iter().map(|x| format!("  {}", help_line(x))));
		if !more.is_empty() { lines.push(format!("Themen: {} (help <thema>)", more.join(", "))); }
		let text = lines.into_iter().filter(|l| !l.is_empty()).collect::<Vec<_>>().join("\n");
		let parts: Vec<Json> = shown.iter().map(|x| { let (names, usage, text) = help_parts(x); obj! { "names" => Json::Array(names.into_iter().map(Json::from).collect()), "usage" => usage, "text" => text } }).collect();
		let h = obj! { "intro" => intro, "commands" => Json::Array(parts), "topics" => Json::Array(more.into_iter().map(Json::from).collect()) };
		return msg(c, &m, "help", &text, MsgOpts { help: Some(h), ..Default::default() }).await;
	}
	let a = arg.to_lowercase();
	if let Some(cmd) = commands.iter().find(|x| x.key == a || x.aliases.as_ref().is_some_and(|al| al.contains(&a))) { return msg(c, &m, "help", &help_line(cmd), MsgOpts::default()).await; }
	if let Some(t) = topics.iter().find(|x| j::s(x, "key") == a) {
		let h = obj! { "topic" => obj! { "key" => j::at(t, "key").clone(), "category" => j::at(t, "category").clone(), "text" => j::at(t, "text").clone() } };
		return msg(c, &m, "help", &format!("{} ({})\n{}", key_text(j::at(t, "key")), key_text(j::at(t, "category")), key_text(j::at(t, "text"))), MsgOpts { help: Some(h), ..Default::default() }).await;
	}
	not_understood(format!("Zu „{}“ gibt es keine Hilfe. „help“ zeigt alles.", js::slice16(arg, 0, Some(20))))
}
