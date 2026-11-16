//! Beacons, fog and the tide (`server/engine/fire.ts`), in world time: a fire is a Flame entry that says until which world
//! time it burns; the fire tick notices a fire that went out or came back, the fog tick moves each covered room's fog one
//! step, the tide and the storm bring flotsam.
use phi_json::{obj, Json, Object};

use crate::clock::{patience_of, world_now_of};
use crate::context::{msg, msg_transient, Ctx, MsgOpts};
use crate::j;
use crate::js::utf16_sort;
use crate::prototypes::{resolve_prototype, spawn, At};
use crate::source::{random_int, time_now};
use crate::space::{by_id, fields, refuse, tmpl, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;

/// `flameOf`: the flame of a beacon, or None when it is out.
pub async fn flame_of(space: &Space, beacon_id: &str, txn: Option<&str>) -> Result<Option<Json>> {
	Ok(space.peek(&tmpl("Flame", obj! { "beaconId" => beacon_id }), txn).await?.map(|e| fields(&e).clone()))
}

/// `isLit`.
pub fn is_lit(f: Option<&Json>, world_ms: f64) -> bool { f.is_some_and(|f| j::n(f, "until") > world_ms) }

/// `burnText`: "brennt noch etwa 12 Minuten" / "ist erloschen".
pub fn burn_text(f: Option<&Json>, world_ms: f64) -> String {
	let Some(f) = f.filter(|f| j::n(f, "until") > world_ms) else { return "ist erloschen".into() };
	let min = 1f64.max(crate::js::round((j::n(f, "until") - world_ms) / 60_000.0));
	format!("brennt noch etwa {} Minute{}", crate::js::number_text(min), if min == 1.0 { "" } else { "n" })
}

/// `feed`: a carried fuel item into a beacon next to the actor, in the command's transaction.
pub async fn feed(c: &Ctx, item: &Json, beacon: &Json, quiet: bool) -> Result<(f64, f64)> {
	let f = fields(item);
	let fuel = j::at(j::at(j::at(c.w(), "fire"), "fuel"), j::s(f, "proto")).as_f64().unwrap_or(0.0);
	if fuel == 0.0 || fuel.is_nan() { return refuse(format!("{} brennt nicht.", j::s(f, "name"))); }
	let bid = j::s(beacon, "beaconId");
	let Some(b) = c.space.take(&tmpl("Beacon", obj! { "beaconId" => bid }), 5_000.0, c.txn()).await? else { return refuse("Gerade legt jemand anderes nach; einen Moment.") };
	if c.space.take(&by_id(j::s(item, "type"), item), NO_WAIT, c.txn()).await?.is_none() { return refuse(format!("{} ist gerade nicht greifbar.", j::s(f, "name"))); }
	let now = world_now_of(&c.space, c.txn()).await?;
	let patient = patience_of(&c.space, c.txn()).await?;
	let (add, max) = (fuel * patient, j::n(j::at(c.w(), "fire"), "maxMs") * patient);
	let old = c.space.take(&tmpl("Flame", obj! { "beaconId" => bid }), NO_WAIT, c.txn()).await?;
	let was = old.as_ref().map(|e| fields(e).clone());
	let left = was.as_ref().filter(|w| j::n(w, "until") > now).map_or(0.0, |w| j::n(w, "until") - now);
	let until = now + max.min(left + add);
	let lit_at = was.as_ref().and_then(|w| j::opt(w, "litAt").cloned()).unwrap_or(Json::from(now));
	c.space.write(&obj! { "type" => "Flame", "fields" => obj! { "beaconId" => bid, "until" => until, "litAt" => lit_at } }, c.txn(), FOREVER).await?;
	let mut bf = j::object(fields(&b));
	bf.insert("lit", Json::Bool(true));
	c.space.write(&obj! { "type" => "Beacon", "fields" => Json::Object(bf) }, c.txn(), FOREVER).await?;
	let mine = c.space.take(&tmpl("Contribution", obj! { "beaconId" => bid, "charId" => c.char_id() }), NO_WAIT, c.txn()).await?;
	let had = mine.map_or_else(|| obj! { "beaconId" => bid, "charId" => c.char_id(), "name" => j::at(&c.actor, "name").clone(), "pieces" => 0.0, "ms" => 0.0 }, |e| fields(&e).clone());
	let mut h = j::object(&had);
	h.insert("name", j::at(&c.actor, "name").clone());
	h.insert("pieces", Json::from(j::n(&had, "pieces") + 1.0));
	h.insert("ms", Json::from(j::n(&had, "ms") + fuel));
	c.space.write(&obj! { "type" => "Contribution", "fields" => Json::Object(h) }, c.txn(), FOREVER).await?;
	if !quiet {
		let text = format!("$you() $conj(legst|legt) {} ins {}. Es {}.", j::s(f, "name"), j::s(beacon, "name"), burn_text(Some(&obj! { "beaconId" => bid, "until" => until, "litAt" => now }), now));
		msg(c, "*", "info", &text, MsgOpts { templ: true, ..MsgOpts::default() }).await?;
	}
	if left == 0.0 { say(&c.space, c.msg_lease_ms, &j::strs(j::a(beacon, "covers")), "world", &format!("Das {} flammt auf.", j::s(beacon, "name")), c.txn()).await?; }
	Ok((until, now))
}

/// A message from the world itself to everyone in `rooms`.
pub async fn say(space: &Space, lease_ms: f64, rooms: &[&str], kind: &str, text: &str, txn: Option<&str>) -> Result<()> {
	let transient = msg_transient(space, "*", kind).await;
	for room in rooms {
		space.write_with(&obj! { "type" => "Msg", "fields" => obj! { "room" => *room, "to" => "*", "kind" => kind, "text" => text, "from" => "", "at" => time_now() } }, txn, lease_ms, transient).await?;
	}
	Ok(())
}

/// `fireTick`: a beacon whose flame lapsed (or came back) is marked so, and its rooms hear it.
pub async fn fire_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<()> {
	for def in j::a(w, "beacons") {
		let bid = j::s(def, "beaconId");
		let Some(seen) = space.peek(&tmpl("Beacon", obj! { "beaconId" => bid }), None).await? else { continue };
		if is_lit(flame_of(space, bid, None).await?.as_ref(), world_now_of(space, None).await?) == j::b(fields(&seen), "lit") { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<()> = async {
			let Some(b) = space.take_if_exists(&tmpl("Beacon", obj! { "beaconId" => bid }), NO_WAIT, Some(&txn)).await? else { space.abort(&txn).await?; return Ok(()) };
			let beacon = fields(&b).clone();
			let lit = is_lit(flame_of(space, bid, Some(&txn)).await?.as_ref(), world_now_of(space, Some(&txn)).await?);
			let mut f = j::object(&beacon);
			f.insert("lit", Json::Bool(lit));
			space.write(&obj! { "type" => "Beacon", "fields" => Json::Object(f) }, Some(&txn), FOREVER).await?;
			if lit != j::b(&beacon, "lit") {
				let text = if lit { format!("Das {} brennt.", j::s(&beacon, "name")) } else { format!("Das {} ist erloschen. Der Nebel kriecht heran.", j::s(&beacon, "name")) };
				say(space, lease_ms, &j::strs(j::a(&beacon, "covers")), "world", &text, Some(&txn)).await?;
			}
			space.commit(&txn).await
		}.await;
		if let Err(e) = r { let _ = space.abort(&txn).await; return Err(e); }
	}
	Ok(())
}

/// `coversOf`: the rooms each fire covers (by beaconId), in the order of the world's beacons.
pub async fn covers_of(space: &Space, w: &Json, txn: Option<&str>) -> Result<Vec<(String, Vec<String>)>> {
	let mut out: Vec<(String, Vec<String>)> = j::a(w, "beacons").iter().map(|b| (j::s(b, "beaconId").to_owned(), j::strs(j::a(b, "covers")).into_iter().map(str::to_owned).collect())).collect();
	for p in j::a(j::at(w, "building"), "plans").iter().filter(|x| j::b(x, "lightRooms")) {
		for e in space.read_all(&tmpl("Building", obj! { "plan" => j::at(p, "key").clone() }), txn).await? {
			let b = fields(&e);
			let around = rooms_around(w, j::s(b, "room"), j::n(p, "lightRooms"));
			if let Some((_, list)) = out.iter_mut().find(|(k, _)| k == j::s(b, "beaconId")) {
				for room in around { if !list.contains(&room) { list.push(room); } }
			}
		}
	}
	for chain in chains_of(space, w, txn).await? {
		if !chain.lit { continue; }
		let mut all: Vec<String> = Vec::new();
		for id in &chain.fires { if let Some((_, l)) = out.iter().find(|(k, _)| k == id) { for r in l { if !all.contains(r) { all.push(r.clone()); } } } }
		for id in &chain.fires {
			match out.iter_mut().find(|(k, _)| k == id) { Some(slot) => slot.1 = all.clone(), None => out.push((id.clone(), all.clone())) }
		}
	}
	Ok(out)
}

/// A signal fire chain (`Chain`).
#[derive(Debug, Clone)]
pub struct Chain { pub rooms: Vec<String>, pub islands: Vec<String>, pub fires: Vec<String>, pub lit: bool, pub out: Vec<(String, f64)> }

/// `chainsOf`.
pub async fn chains_of(space: &Space, w: &Json, txn: Option<&str>) -> Result<Vec<Chain>> {
	let rooms_def = j::a(w, "rooms");
	let here: Vec<&str> = rooms_def.iter().map(|r| j::s(r, "roomId")).collect();
	let mut fire_in: Vec<(String, Vec<String>)> = Vec::new();
	for p in j::a(j::at(w, "building"), "plans").iter().filter(|x| j::b(x, "signal")) {
		for e in space.read_all(&tmpl("Building", obj! { "plan" => j::at(p, "key").clone() }), txn).await? {
			let b = fields(&e);
			let (room, bid) = (j::s(b, "room"), j::s(b, "beaconId"));
			if here.contains(&room) && j::a(w, "beacons").iter().any(|x| j::s(x, "beaconId") == bid) {
				match fire_in.iter_mut().find(|(k, _)| k == room) { Some((_, s)) => { if !s.iter().any(|x| x == bid) { s.push(bid.to_owned()); } } None => fire_in.push((room.to_owned(), vec![bid.to_owned()])) }
			}
		}
	}
	let has = |room: &str| fire_in.iter().any(|(k, _)| k == room);
	let mut chains = Vec::new();
	let mut seen: Vec<String> = Vec::new();
	let mut now: Option<f64> = None;
	let mut starts: Vec<String> = fire_in.iter().map(|(k, _)| k.clone()).collect();
	utf16_sort(&mut starts);
	for start in starts {
		if seen.contains(&start) { continue; }
		let mut rooms = vec![start.clone()];
		seen.push(start);
		let mut i = 0;
		while i < rooms.len() {
			for x in j::a(w, "exits") {
				let dest = j::s(x, "destination");
				if j::s(x, "room") == rooms[i] && has(dest) && !seen.iter().any(|s| s == dest) { seen.push(dest.to_owned()); rooms.push(dest.to_owned()); }
			}
			i += 1;
		}
		let mut fires: Vec<String> = Vec::new();
		for r in &rooms { for id in &fire_in.iter().find(|(k, _)| k == r).expect("a fire").1 { if !fires.contains(id) { fires.push(id.clone()); } } }
		utf16_sort(&mut fires);
		if fires.len() < 2 { continue; }
		if now.is_none() { now = Some(world_now_of(space, txn).await?); }
		let n = now.unwrap();
		let mut out = Vec::new();
		for id in &fires {
			let f = flame_of(space, id, txn).await?;
			if !is_lit(f.as_ref(), n) { out.push((id.clone(), f.as_ref().map_or(0.0, |f| j::n(f, "until")))); }
		}
		let mut islands: Vec<String> = Vec::new();
		for r in &rooms {
			let isl = j::by(rooms_def, "roomId", r).and_then(|x| j::so(x, "island")).unwrap_or(j::s(w, "title")).to_owned();
			if !islands.contains(&isl) { islands.push(isl); }
		}
		utf16_sort(&mut islands);
		utf16_sort(&mut rooms);
		chains.push(Chain { rooms, islands, fires, lit: out.is_empty(), out });
	}
	Ok(chains)
}

/// `chainTick`: an island is alight while a burning chain links it; when that ends the run counts for its longest.
pub async fn chain_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<()> {
	let chains = chains_of(space, w, None).await?;
	let title = j::s(w, "title");
	let mut islands: Vec<&str> = Vec::new();
	for r in j::a(w, "rooms") { let i = j::so(r, "island").unwrap_or(title); if !islands.contains(&i) { islands.push(i); } }
	for island in islands {
		let mine: Vec<&Chain> = chains.iter().filter(|c| c.islands.iter().any(|x| x == island)).collect();
		let lit = mine.iter().any(|c| c.lit);
		let seen = space.peek(&tmpl("FireChain", obj! { "island" => island }), None).await?;
		let was_since = seen.as_ref().is_some_and(|e| j::truthy(j::at(fields(e), "since")));
		if lit == was_since { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<()> = async {
			let e = space.take_if_exists(&tmpl("FireChain", obj! { "island" => island }), NO_WAIT, Some(&txn)).await?;
			if seen.is_some() && e.is_none() { space.abort(&txn).await?; return Ok(()); }
			let f = e.as_ref().map_or_else(|| obj! { "island" => island, "since" => 0.0, "best" => 0.0, "bestAt" => 0.0 }, |e| fields(e).clone());
			let now = world_now_of(space, Some(&txn)).await?;
			let rooms: Vec<&str> = j::a(w, "rooms").iter().filter(|r| j::so(r, "island").unwrap_or(title) == island).map(|r| j::s(r, "roomId")).collect();
			let since = j::n(&f, "since");
			if lit && !j::truthy(j::at(&f, "since")) {
				let mut g = j::object(&f);
				g.insert("since", Json::from(now));
				let entry = obj! { "type" => "FireChain", "fields" => Json::Object(g) };
				if e.is_some() { space.write(&entry, Some(&txn), FOREVER).await?; } else { space.write_unique(&entry, Some(&txn), FOREVER, &["island"]).await?; }
				say(space, lease_ms, &rooms, "world", "Die Signalfeuer sehen einander; ihre Feuer teilen ihr Licht.", Some(&txn)).await?;
			} else if !lit && j::truthy(j::at(&f, "since")) {
				let ends: Vec<f64> = mine.iter().flat_map(|c| c.out.iter().map(|o| o.1)).filter(|t| *t >= since).collect();
				let end = ends.iter().fold(now, |a, b| a.min(*b));
				let run = end - since;
				let mut g = j::object(&f);
				g.insert("since", Json::from(0.0));
				if run > j::n(&f, "best") { g.insert("best", Json::from(run)); g.insert("bestAt", Json::from(end)); }
				space.write(&obj! { "type" => "FireChain", "fields" => Json::Object(g) }, Some(&txn), FOREVER).await?;
				say(space, lease_ms, &rooms, "world", "Die Kette der Signalfeuer ist unterbrochen; jedes Feuer leuchtet wieder für sich.", Some(&txn)).await?;
			} else { space.abort(&txn).await?; return Ok(()); }
			space.commit(&txn).await
		}.await;
		if let Err(e) = r { let _ = space.abort(&txn).await; return Err(e); }
	}
	Ok(())
}

/// `roomsAround`: the rooms up to `ways` exits from `room` on its island.
pub fn rooms_around(w: &Json, room: &str, ways: f64) -> Vec<String> {
	let island = |id: &str| j::by(j::a(w, "rooms"), "roomId", id).and_then(|r| j::so(r, "island")).map(str::to_owned);
	let home = island(room);
	let mut seen = vec![room.to_owned()];
	let mut ring = vec![room.to_owned()];
	let mut i = 0.0;
	while i < ways {
		ring = j::a(w, "exits").iter().filter(|x| ring.iter().any(|r| r == j::s(x, "room")) && !seen.iter().any(|s| s == j::s(x, "destination")) && island(j::s(x, "destination")) == home && home.is_some()).map(|x| j::s(x, "destination").to_owned()).collect();
		for r in &ring { if !seen.contains(r) { seen.push(r.clone()); } }
		i += 1.0;
	}
	seen
}

/// `fogTick`: each covered room one step clearer while a fire that covers it burns, one step denser while none does.
pub async fn fog_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<()> {
	let cover = covers_of(space, w, None).await?;
	let mut rooms: Vec<(String, bool)> = Vec::new();
	for def in j::a(w, "beacons") {
		let bid = j::s(def, "beaconId");
		let lit = is_lit(flame_of(space, bid, None).await?.as_ref(), world_now_of(space, None).await?);
		let list: Vec<String> = cover.iter().find(|(k, _)| k == bid).map_or_else(|| j::strs(j::a(def, "covers")).into_iter().map(str::to_owned).collect(), |(_, l)| l.clone());
		for room in list { match rooms.iter_mut().find(|(k, _)| *k == room) { Some(slot) => slot.1 = slot.1 || lit, None => rooms.push((room, lit)) } }
	}
	let max = j::n(j::at(w, "fog"), "max");
	for (room, lit) in rooms {
		let seen = space.peek(&tmpl("Fog", obj! { "room" => room.as_str() }), None).await?;
		if seen.as_ref().is_some_and(|e| j::n(fields(e), "level") == if lit { 0.0 } else { max }) { continue; }
		let txn = space.create_transaction(10_000.0).await?;
		let r: Result<()> = async {
			let Some(e) = space.take_if_exists(&tmpl("Fog", obj! { "room" => room.as_str() }), NO_WAIT, Some(&txn)).await? else { space.abort(&txn).await?; return Ok(()) };
			let was = j::n(fields(&e), "level");
			let level = 0f64.max(max.min(was + if lit { -1.0 } else { 1.0 }));
			space.write(&obj! { "type" => "Fog", "fields" => obj! { "room" => room.as_str(), "level" => level } }, Some(&txn), FOREVER).await?;
			if level != was { say(space, lease_ms, &[room.as_str()], "world", fog_text(level, level > was), Some(&txn)).await?; }
			space.commit(&txn).await
		}.await;
		if let Err(e) = r { let _ = space.abort(&txn).await; return Err(e); }
	}
	Ok(())
}

/// `fogText`.
pub fn fog_text(level: f64, denser: bool) -> &'static str {
	match 3f64.min(level) as i64 {
		0 => "Der Nebel reißt auf; die See liegt klar.",
		1 => if denser { "Nebel zieht auf." } else { "Der Nebel lichtet sich." },
		2 => if denser { "Der Nebel wird dicht; man sieht kaum zum Wasser." } else { "Der Nebel wird dünner; die Wege sind wieder zu erkennen." },
		_ => "Dichter Nebel verschluckt die Wege.",
	}
}

/// `fogOf`.
pub async fn fog_of(space: &Space, room: &str) -> Result<f64> {
	Ok(space.peek(&tmpl("Fog", obj! { "room" => room }), None).await?.map_or(0.0, |e| j::n(fields(&e), "level")))
}

/// Free cells of `tile` in a room (no thing, exit, fire or plot on them).
async fn free_cells(space: &Space, w: &Json, room_id: &str, tile: &str) -> Result<Vec<(f64, f64)>> {
	let room = j::by(j::a(w, "rooms"), "roomId", room_id).expect("a room of the world");
	let mut taken: std::collections::HashSet<String> = std::collections::HashSet::new();
	for (ty, key) in [("Item", "location"), ("Exit", "location"), ("Beacon", "room"), ("Plot", "room")] {
		for e in space.read_all(&tmpl(ty, obj! { key => room_id }), None).await? {
			let f = fields(&e);
			taken.insert(format!("{},{}", key_text(j::at(f, "x")), key_text(j::at(f, "y"))));
		}
	}
	let ground = crate::room_growth::rows(j::at(room, "ground"));
	let mut cells = Vec::new();
	for (y, row) in ground.iter().enumerate() {
		for (x, t) in row.chars().enumerate() {
			if t.to_string() == tile && walkable(w, &ground, x as f64, y as f64) && !taken.contains(&format!("{x},{y}")) { cells.push((x as f64, y as f64)); }
		}
	}
	Ok(cells)
}

/// A value as it reads in a template string (`${v}`).
pub fn key_text(v: &Json) -> String {
	match v { Json::Null => "undefined".into(), Json::String(s) => s.clone(), Json::Number(n) => crate::js::number_text(*n), Json::Bool(b) => b.to_string(), other => other.to_json_text() }
}

/// `weighted`: one proto by its weight.
fn weighted(protos: &[Json]) -> String {
	let total: f64 = protos.iter().map(|p| j::n(p, "weight")).sum();
	let mut r = random_int(0.0, total);
	for p in protos { r -= j::n(p, "weight"); if r < 0.0 { return j::s(p, "proto").to_owned(); } }
	unreachable!("weighted: no proto")
}

/// `floodTick`: in each flood room below its maximum, flotsam on free cells of the room's tile.
pub async fn flood_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<()> {
	let flood = j::at(w, "flood");
	let people = people_by_island(space, w).await?;
	let per = 1f64.max(j::no(flood, "perPlayers").unwrap_or(3.0));
	let count_of = |island: &str| people.iter().find(|(k, _)| k == island).map_or(0.0, |(_, n)| *n);
	for fr in j::a(flood, "rooms") {
		let froom = j::s(fr, "room");
		let island = j::by(j::a(w, "rooms"), "roomId", froom).and_then(|r| j::so(r, "island")).unwrap_or("");
		let extra = (count_of(island) / per).floor();
		let lying = space.count(&tmpl("Item", obj! { "location" => froom, "flotsam" => true }), None).await?;
		let n = (j::n(fr, "max") + extra - lying).min(1.0 + extra);
		if n <= 0.0 { continue; }
		let mut cells = free_cells(space, w, froom, j::s(fr, "tile")).await?;
		let mut names: Vec<String> = Vec::new();
		let protos = j::ao(fr, "protos").unwrap_or(j::a(flood, "protos"));
		let mut i = 0.0;
		while i < n && !cells.is_empty() {
			i += 1.0;
			let Some(proto) = resolve_prototype(space, &weighted(protos)).await? else { continue };
			let at = cells.remove(random_int(0.0, cells.len() as f64) as usize);
			let expires = world_now_of(space, None).await? + patience_of(space, None).await? * j::n(flood, "lifetimeMs");
			let item = spawn(space, None, w, &proto, At { location: froom.to_owned(), x: at.0, y: at.1, flotsam: true, expires_world_ms: Some(expires), ..At::default() }, &Json::Null).await?;
			names.push(j::s(&item, "name").to_owned());
		}
		if !names.is_empty() {
			let text = if names.len() == 1 { format!("Die Flut spült {} an.", names[0]) } else { format!("Die Flut spült {} Dinge an: {}.", names.len(), uniq(&names).join(", ")) };
			say(space, lease_ms, &[froom], "info", &text, None).await?;
		}
	}
	bring_staples(space, w, &people).await
}

/// `[...new Set(list)]`.
pub fn uniq(list: &[String]) -> Vec<String> { let mut out: Vec<String> = Vec::new(); for x in list { if !out.contains(x) { out.push(x.clone()); } } out }

/// `bringStaples`: an island with too little of a staple on its beaches gets more with each tide, quietly.
async fn bring_staples(space: &Space, w: &Json, people: &[(String, f64)]) -> Result<()> {
	let flood = j::at(w, "flood");
	let Some(st) = j::opt(flood, "staples") else { return Ok(()) };
	if std::env::var("SPACES_MMO_STAPLES").as_deref() == Ok("0") { return Ok(()); }
	let mut islands: Vec<(String, Vec<&Json>)> = Vec::new();
	for fr in j::a(flood, "rooms") {
		let Some(island) = j::by(j::a(w, "rooms"), "roomId", j::s(fr, "room")).and_then(|r| j::so(r, "island")) else { continue };
		match islands.iter_mut().find(|(k, _)| k == island) { Some((_, l)) => l.push(fr), None => islands.push((island.to_owned(), vec![fr])) }
	}
	for (island, rooms) in &islands {
		for t in j::a(st, "things") {
			let proto_key = j::s(t, "proto");
			let mut lying = 0.0;
			for fr in rooms { lying += space.count(&tmpl("Item", obj! { "location" => j::s(fr, "room"), "proto" => proto_key, "flotsam" => true }), None).await?; }
			let here = people.iter().find(|(k, _)| k == island).map_or(0.0, |(_, n)| *n);
			let n = (j::n(t, "perIsland") + here - lying).min(j::n(st, "perTide"));
			if n <= 0.0 { continue; }
			let Some(proto) = resolve_prototype(space, proto_key).await? else { continue };
			let mut i = 0.0;
			while i < n {
				i += 1.0;
				let fr = rooms[random_int(0.0, rooms.len() as f64) as usize];
				let cells = free_cells(space, w, j::s(fr, "room"), j::s(fr, "tile")).await?;
				if cells.is_empty() { continue; }
				let at = cells[random_int(0.0, cells.len() as f64) as usize];
				let expires = world_now_of(space, None).await? + patience_of(space, None).await? * j::n(st, "lifetimeMs");
				spawn(space, None, w, &proto, At { location: j::s(fr, "room").to_owned(), x: at.0, y: at.1, flotsam: true, expires_world_ms: Some(expires), ..At::default() }, &Json::Null).await?;
			}
		}
	}
	Ok(())
}

/// `peopleByIsland`: people online (and the settlers), by the island they stand on.
async fn people_by_island(space: &Space, w: &Json) -> Result<Vec<(String, f64)>> {
	let live: Vec<String> = space.read_all(&obj! { "type" => "Session" }, None).await?.iter().map(|s| key_text(j::at(fields(s), "charId"))).filter(|id| !id.starts_with("npc-") || id.starts_with("npc-siedler-")).collect();
	let mut out: Vec<(String, f64)> = Vec::new();
	if live.is_empty() { return Ok(out); }
	for c in space.read_all(&obj! { "type" => "Character" }, None).await? {
		let f = fields(&c);
		if !live.contains(&key_text(j::at(f, "charId"))) { continue; }
		let island = j::by(j::a(w, "rooms"), "roomId", j::s(f, "room")).and_then(|r| j::so(r, "island")).unwrap_or("").to_owned();
		match out.iter_mut().find(|(k, _)| *k == island) { Some(slot) => slot.1 += 1.0, None => out.push((island, 1.0)) }
	}
	Ok(out)
}

/// `stormTick`: a storm surge on the beach of one of the storm's rooms; everyone hears on the channel where.
pub async fn storm_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<Option<String>> {
	let Some(storm) = j::opt(w, "storm") else { return Ok(None) };
	let srooms = j::a(storm, "rooms");
	if srooms.is_empty() { return Ok(None); }
	let room_id = srooms[random_int(0.0, srooms.len() as f64) as usize].as_str().unwrap_or("").to_owned();
	let mut cells = free_cells(space, w, &room_id, ".").await?;
	let mut names: Vec<String> = Vec::new();
	let mut i = 0.0;
	while i < j::n(storm, "count") && !cells.is_empty() {
		i += 1.0;
		let Some(proto) = resolve_prototype(space, &weighted(j::a(storm, "protos"))).await? else { continue };
		let at = cells.remove(random_int(0.0, cells.len() as f64) as usize);
		let expires = world_now_of(space, None).await? + patience_of(space, None).await? * j::n(j::at(w, "flood"), "lifetimeMs") * 2.0;
		let item = spawn(space, None, w, &proto, At { location: room_id.clone(), x: at.0, y: at.1, flotsam: true, expires_world_ms: Some(expires), ..At::default() }, &Json::Null).await?;
		names.push(j::s(&item, "name").to_owned());
	}
	if names.is_empty() { return Ok(None); }
	let room = j::by(j::a(w, "rooms"), "roomId", &room_id).expect("a storm room");
	let channel = j::s(storm, "channel");
	let mut m = Object::new();
	for (k, v) in [("room", Json::from(room_id.as_str())), ("to", Json::from(format!("#{channel}"))), ("kind", Json::from("channel")), ("text", Json::from(format!("[{channel}] Sturmflut in {} ({})! Das Meer wirft Strandgut aus.", j::s(room, "name"), j::so(room, "island").unwrap_or(j::s(w, "title"))))), ("from", Json::from("")), ("at", Json::from(time_now()))] { m.insert(k, v); }
	space.write(&obj! { "type" => "Msg", "fields" => Json::Object(m) }, None, lease_ms).await?;
	say(space, lease_ms, &[room_id.as_str()], "world", &format!("Eine Sturmflut rollt heran und lässt {} Dinge am Strand zurück: {}.", names.len(), uniq(&names).join(", ")), None).await?;
	Ok(Some(room_id))
}
