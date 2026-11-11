//! Rooms that grow (`server/engine/commands/growth.ts`): a full room gains land at an edge or at a safe seam before the
//! coast; the room's geometry and every position it displaces commit together, under the world lock.
use std::collections::HashSet;

use phi_json::{obj, Json};

use super::build::PATH;
use crate::context::msg_transient;
use crate::fire::key_text;
use crate::j;
use crate::js;
use crate::model::world_lock;
use crate::occupancy::is_passage;
use crate::room_growth::{grown_point, insert_strip, rows, rows_json};
use crate::source::time_now;
use crate::space::{fields, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;

const POSITIONED: [&str; 16] = ["Character", "Spot", "Beacon", "Cart", "Site", "Building", "Ruin", "Bed", "Field", "Scenery", "MillLoad", "SiteOrder", "Plot", "Zone", "Motion", "Animal"];
fn is(e: &Json, ty: &str) -> bool { j::a(e, "types").iter().any(|t| t.as_str() == Some(ty)) }
fn key(x: f64, y: f64) -> String { format!("{},{}", phi_json::number_text(x), phi_json::number_text(y)) }
fn key_of(p: &Json) -> String { format!("{},{}", key_text(j::at(p, "x")), key_text(j::at(p, "y"))) }
fn pt(x: f64, y: f64) -> Json { obj! { "x" => x, "y" => y } }
/// `crosses`: a rectangle the seam `s` would cut.
fn crosses(r: &Json, s: &Json) -> bool {
	let axis = j::s(s, "axis");
	let at = j::n(s, "at");
	let v = j::n(r, axis);
	let ext = j::no(r, if axis == "x" { "w" } else { "h" }).unwrap_or(1.0);
	v < at && v + ext > at
}
/// A cell of the ground as JavaScript indexes a row (a UTF-16 unit), null outside.
fn cell_at(ground: &[String], row: usize, col: usize) -> Json {
	match ground.get(row) { Some(r) if col < js::len16(r) => Json::from(js::slice16(r, col as isize, Some(col as isize + 1))), _ => Json::Null }
}

/// `candidates`: the steps a room could grow by, east first, then south, the outermost safe seam first.
fn candidates(w: &Json, ground: &[String], exits: &[Json]) -> Vec<Json> {
	let d = j::at(w, "growth");
	let tile = Json::from(j::s(d, "tile"));
	let path = Json::from(PATH);
	let width = ground.first().map_or(0, |r| js::len16(r));
	let height = ground.len();
	let mut out = Vec::new();
	for axis in ["x", "y"] {
		let (length, across) = if axis == "x" { (width, height) } else { (height, width) };
		if length as f64 + j::n(d, "strip") > j::n(d, if axis == "x" { "maxW" } else { "maxH" }) { continue; }
		let cell = |along: usize, cross: usize| if axis == "x" { cell_at(ground, cross, along) } else { cell_at(ground, along, cross) };
		let near_exit = exits.iter().any(|e| j::n(e, axis) >= length as f64 - 2.0);
		let first = if near_exit { length as isize - 2 } else { length as isize };
		let last = length.div_ceil(2) as isize;
		let mut at = first;
		while at >= last {
			let fill: Vec<Json> = (0..across).map(|i| {
				let a = if at >= 1 { cell(at as usize - 1, i) } else { Json::Null };
				let b = if (at as usize) < length { cell(at as usize, i) } else { a.clone() };
				if a == path || b == path { path.clone() } else if a == tile || b == tile { tile.clone() } else { a }
			}).collect();
			if fill.iter().filter(|t| **t == tile).count() * 2 >= across {
				out.push(obj! { "axis" => axis, "at" => at as f64, "size" => j::at(d, "strip").clone(), "fill" => Json::Array(fill) });
			}
			at -= 1;
		}
	}
	out
}

/// `freeSide`: where a room would grow, by its geometry alone.
pub fn free_side(w: &Json, room: &Json, exits: &[Json]) -> Option<&'static str> {
	candidates(w, &rows(j::at(room, "ground")), exits).first().map(|s| if j::s(s, "axis") == "x" { "east" } else { "south" })
}

fn reachable(w: &Json, ground: &[String], blocked: &HashSet<String>, start: (f64, f64)) -> HashSet<String> {
	let mut seen = HashSet::new();
	let mut queue = vec![start];
	let mut i = 0;
	while i < queue.len() {
		let (x, y) = queue[i];
		i += 1;
		let k = key(x, y);
		if seen.contains(&k) || blocked.contains(&k) || !walkable(w, ground, x, y) { continue; }
		seen.insert(k);
		for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] { queue.push((x + dx, y + dy)); }
	}
	seen
}

/// `connected`: all reachable free cells stay reachable, and the new building land connects to them.
fn connected(w: &Json, room: &Json, ground: &[String], s: &Json, entries: &[Json]) -> Result<bool> {
	let obstacles: Vec<&Json> = entries.iter().filter(|e| is(e, "Plot") || is(e, "Beacon")).map(fields).collect();
	let blocked: HashSet<String> = obstacles.iter().map(|p| key_of(p)).collect();
	let free = |x: f64, y: f64| walkable(w, ground, x, y) && !blocked.contains(&key(x, y));
	let mut start = j::opt(room, "spawn").map(|p| (j::n(p, "x"), j::n(p, "y")));
	if start.is_none_or(|(x, y)| !free(x, y)) {
		start = None;
		'rows: for (y, row) in ground.iter().enumerate() { for x in 0..js::len16(row) { if free(x as f64, y as f64) { start = Some((x as f64, y as f64)); break 'rows; } } }
	}
	let Some(start) = start else { return Ok(false) };
	let g = obj! { "east" => 0.0, "south" => 0.0, "steps" => Json::Array(vec![s.clone()]) };
	let grown = insert_strip(ground, s, false)?;
	let moved = |x: f64, y: f64| { let q = grown_point(&pt(x, y), &g, 0); (j::n(&q, "x"), j::n(&q, "y")) };
	let gs = moved(start.0, start.1);
	let after = reachable(w, &grown, &obstacles.iter().map(|p| { let q = grown_point(&pt(j::n(p, "x"), j::n(p, "y")), &g, 0); key_of(&q) }).collect(), gs);
	for k in reachable(w, ground, &blocked, start) {
		let mut it = k.split(',').map(js::to_number);
		let (x, y) = (it.next().unwrap_or(f64::NAN), it.next().unwrap_or(f64::NAN));
		let q = moved(x, y);
		if !after.contains(&key(q.0, q.1)) { return Ok(false); }
	}
	let tile = j::s(j::at(w, "growth"), "tile");
	let (at, size) = (j::n(s, "at"), j::n(s, "size"));
	for (i, f) in j::a(s, "fill").iter().enumerate() {
		if f.as_str() != Some(tile) && f.as_str() != Some(PATH) { continue; }
		let mut jj = 0.0;
		while jj < size {
			let p = if j::s(s, "axis") == "x" { (at + jj, i as f64) } else { (i as f64, at + jj) };
			if !after.contains(&key(p.0, p.1)) { return Ok(false); }
			jj += 1.0;
		}
	}
	Ok(true)
}

/// `moved`: an entry's fields with its absolute coordinates in the grown room (things carried, bed plants and overview
/// slots keep their local ones).
fn moved(e: &Json, room: &str, before: &Json, step: &Json) -> Json {
	let mut f = fields(e).clone();
	let g = obj! { "east" => 0.0, "south" => 0.0, "steps" => Json::Array(vec![step.clone()]) };
	let here = j::so(&f, "room") == Some(room) || ((is(e, "Item") || is(e, "Exit")) && j::so(&f, "location") == Some(room));
	if here && j::no(&f, "x").is_some() && j::no(&f, "y").is_some() {
		let q = grown_point(&pt(j::n(&f, "x"), j::n(&f, "y")), &g, 0);
		j::set(&mut f, "x", j::at(&q, "x").clone());
		j::set(&mut f, "y", j::at(&q, "y").clone());
	}
	if is(e, "Motion") && j::so(&f, "room") == Some(room) && j::opt(&f, "zone").is_some_and(j::truthy) {
		let z = grown_point(j::at(&f, "zone"), &g, 0);
		j::set(&mut f, "zone", z);
	}
	if is(e, "Exit") && j::so(&f, "destination") == Some(room) && j::opt(&f, "arrive").is_some_and(j::truthy) {
		let rev = j::no(&f, "arriveGrowthRevision").unwrap_or(0.0) as usize;
		let a = grown_point(&grown_point(j::at(&f, "arrive"), before, rev), &g, 0);
		j::set(&mut f, "arrive", a);
		j::set(&mut f, "arriveGrowthRevision", j::a(before, "steps").len() as f64 + 1.0);
	}
	f
}

/// `growthTick`: a busy world defers growth; a room and every displaced position change in one transaction under the
/// world lock. How many rooms grew.
pub async fn growth_tick(space: &Space, w: &Json, lease_ms: f64) -> Result<f64> {
	let Some(d) = j::opt(w, "growth") else { return Ok(0.0) };
	let strip = j::n(d, "strip");
	if strip.fract() != 0.0 || strip.is_nan() || strip < 1.0 { return Err(Error::Other("growth.strip must be a positive integer".into())); }
	let mut grew = 0.0;
	for entry in space.read_all(&obj! { "type" => "Room" }, None).await? {
		if super::interior::is_interior(j::s(fields(&entry), "roomId")) { continue; } // a building's inside keeps its walls
		let txn = space.create_transaction(30_000.0).await?;
		let r: Result<Option<bool>> = async {
			if space.take_if_exists(&world_lock(), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(None); }
			let Some(e) = space.take_if_exists(&obj! { "id" => j::at(&entry, "id").clone() }, NO_WAIT, Some(&txn)).await? else { return Ok(Some(false)) };
			let room = fields(&e).clone();
			let room_id = j::s(&room, "roomId").to_owned();
			let ground = rows(j::at(&room, "ground"));
			let mut entries: Vec<Json> = Vec::new();
			for ty in POSITIONED { entries.extend(space.read_all(&tmpl(ty, obj! { "room" => room_id.as_str() }), Some(&txn)).await?); }
			entries.extend(space.read_all(&tmpl("Item", obj! { "location" => room_id.as_str() }), Some(&txn)).await?);
			entries.extend(space.read_all(&obj! { "type" => "Exit" }, Some(&txn)).await?);
			let exits: Vec<Json> = entries.iter().filter(|x| is(x, "Exit") && j::so(fields(x), "location") == Some(room_id.as_str())).map(|x| fields(x).clone()).collect();
			let mut land: HashSet<String> = HashSet::new();
			for (y, row) in ground.iter().enumerate() {
				for x in 0..js::len16(row) {
					let (xf, yf) = (x as f64, y as f64);
					if walkable(w, &ground, xf, yf) && js::slice16(row, x as isize, Some(x as isize + 1)) != PATH && !is_passage(&exits, xf, yf) { land.insert(key(xf, yf)); }
				}
			}
			let occupied: HashSet<String> = entries.iter().filter(|x| is(x, "Plot")).map(|x| key_of(fields(x))).filter(|k| land.contains(k)).collect();
			if land.is_empty() || (occupied.len() as f64) < land.len() as f64 * j::n(d, "fullShare") { return Ok(Some(false)); }
			let rects: Vec<Json> = entries.iter().filter(|x| j::so(fields(x), "room") == Some(room_id.as_str())).filter_map(|x| {
				let f = fields(x);
				if is(x, "Motion") && j::opt(f, "zone").is_some_and(j::truthy) { Some(j::at(f, "zone").clone()) }
				else if j::no(f, "w").is_some() && j::no(f, "h").is_some() { Some(f.clone()) } else { None }
			}).collect();
			let mut step = None;
			for s in candidates(w, &ground, &exits) {
				if rects.iter().any(|r| crosses(r, &s)) { continue; }
				if connected(w, &room, &ground, &s, &entries)? { step = Some(s); break; }
			}
			let Some(step) = step else { return Ok(Some(false)) };
			let was = space.take_if_exists(&tmpl("RoomGrowth", obj! { "roomId" => room_id.as_str() }), NO_WAIT, Some(&txn)).await?;
			let before = was.map_or_else(|| obj! { "roomId" => room_id.as_str(), "east" => 0.0, "south" => 0.0 }, |x| fields(&x).clone());
			let size = j::n(&step, "size");
			let x_axis = j::s(&step, "axis") == "x";
			let mut after = before.clone();
			j::set(&mut after, "east", j::n(&before, "east") + if x_axis { size } else { 0.0 });
			j::set(&mut after, "south", j::n(&before, "south") + if x_axis { 0.0 } else { size });
			let mut steps: Vec<Json> = j::a(&before, "steps").to_vec();
			steps.push(step.clone());
			j::set(&mut after, "steps", Json::Array(steps));
			let width = ground.first().map_or(0, |r| js::len16(r)) as f64;
			j::set(&mut after, "baseWidth", j::opt(&before, "baseWidth").cloned().unwrap_or_else(|| Json::from(width - j::n(&before, "east"))));
			j::set(&mut after, "baseHeight", j::opt(&before, "baseHeight").cloned().unwrap_or_else(|| Json::from(ground.len() as f64 - j::n(&before, "south"))));
			let changes: Vec<(Json, Json)> = entries.iter().map(|x| (x.clone(), moved(x, &room_id, &before, &step))).filter(|(x, f)| f.to_json_text() != fields(x).to_json_text()).collect();
			for (old, _) in &changes {
				if space.take_if_exists(&obj! { "id" => j::at(old, "id").clone() }, NO_WAIT, Some(&txn)).await?.is_none() { return Ok(Some(false)); }
			}
			for (old, f) in changes {
				let types: Vec<Json> = j::a(&old, "types").iter().skip(1).cloned().collect();
				let entry = obj! { "type" => j::at(&old, "type").clone(), "types" => Json::Array(types), "fields" => f };
				if is(&old, "Plot") || is(&old, "Spot") { space.write_unique(&entry, Some(&txn), FOREVER, &["room", "x", "y"]).await?; } else { space.write(&entry, Some(&txn), FOREVER).await?; }
			}
			space.write(&tmpl("RoomGrowth", after), Some(&txn), FOREVER).await?;
			let g = obj! { "east" => 0.0, "south" => 0.0, "steps" => Json::Array(vec![step.clone()]) };
			let mut rf = room.clone();
			j::set(&mut rf, "ground", rows_json(&insert_strip(&ground, &step, false)?));
			if j::opt(&room, "decor").is_some_and(j::truthy) { j::set(&mut rf, "decor", rows_json(&insert_strip(&rows(j::at(&room, "decor")), &step, true)?)); }
			if j::opt(&room, "spawn").is_some_and(j::truthy) { j::set(&mut rf, "spawn", grown_point(j::at(&room, "spawn"), &g, 0)); }
			let types: Vec<Json> = j::a(&e, "types").iter().skip(1).cloned().collect();
			space.write(&obj! { "type" => j::at(&e, "type").clone(), "types" => Json::Array(types), "fields" => rf }, Some(&txn), FOREVER).await?;
			let text = format!("{} wächst: Im {} ist neues Land frei.", key_text(j::at(&room, "name")), if x_axis { "Osten" } else { "Süden" });
			let m = obj! { "room" => room_id.as_str(), "to" => "*", "kind" => "world", "text" => text.as_str(), "from" => "", "at" => time_now() };
			space.write_with(&obj! { "type" => "Msg", "fields" => m }, Some(&txn), lease_ms, msg_transient(space, "*", "world").await).await?;
			space.write(&world_lock(), Some(&txn), FOREVER).await?;
			Ok(Some(true))
		}.await;
		match r {
			Ok(Some(true)) => { space.commit(&txn).await?; grew += 1.0; }
			Ok(Some(false)) => space.abort(&txn).await?,
			Ok(None) => { space.abort(&txn).await?; break; }
			Err(e) => { let _ = space.abort(&txn).await; return Err(e); }
		}
	}
	Ok(grew)
}
