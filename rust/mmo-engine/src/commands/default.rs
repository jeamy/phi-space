//! The commands every character has (`server/engine/commands/default.ts`), so far `step` and what it reaches: moving in
//! a room, taking an exit, describing the room one arrives in.
use phi_json::{obj, Json, Object};

use crate::context::{check, exits_here, msg, room_of, where_to, Ctx, MsgOpts};
use crate::fire::{burn_text, covers_of, flame_of, fog_of, key_text};
use crate::j;
use crate::js::{self, JsRegex};
use crate::occupancy::{blocked_in, cell_key, cell_of, claim_spot, free_cell_near, is_passage, occupied_in, online_ids, release_spot};
use crate::room_growth::{grown_point, rows};
use crate::space::{by_id, fields, refuse, tmpl, Error, Result, FOREVER, NO_WAIT};
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
