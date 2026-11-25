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
use crate::space::{fields, join_all, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::grid::Grid;
use crate::world::walkable;

const POSITIONED: [&str; 17] = ["Character", "Spot", "Beacon", "Cart", "Site", "Building", "Ruin", "Bed", "Field", "Scenery", "MillLoad", "SiteOrder", "Footprint", "Zone", "Motion", "Animal", "Tree"];
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

/// The cells of the footprints among `entries` (model.ts FootprintFields).
fn claimed(entries: &[Json]) -> Vec<String> {
	entries.iter().filter(|e| is(e, "Footprint")).flat_map(|e| crate::occupancy::footprint_cells(fields(e)).into_iter().map(|(x, y)| key(x, y))).collect()
}

/// `seamCheck`: the seams of one room against its free cells (walkable land without a plot or a fire). A seam is safe
/// when every run of the new strip that is building land (grass or path) joins the part of the room its start cell (the
/// spawn, else the first free cell) lies in. One labelling of the room's parts serves every seam; a seam looks only at
/// the cells beside it (plan section 3, growth step 1). Where both cells beside a seam were free the strip between them
/// is walkable (it takes grass or path where either has it, else the left one's land), so every way that crossed the
/// seam still crosses it: only the new land has to join. The tests below hold it against the two searches it replaced.
pub fn seam_check(w: &Json, room: &Json, ground: &[String], entries: &[Json]) -> impl Fn(&Json) -> bool {
	let mut blocked: HashSet<String> = entries.iter().filter(|e| is(e, "Beacon")).map(|e| key_of(fields(e))).collect();
	blocked.extend(claimed(entries));
	let free = |x: f64, y: f64| walkable(w, ground, x, y) && !blocked.contains(&key(x, y));
	let (width, height) = (ground.first().map_or(0, |r| js::len16(r)), ground.len());
	let grid = Grid::of(width, height, |x, y| free(x as f64, y as f64));
	let mut start = j::opt(room, "spawn").map(|p| (j::n(p, "x"), j::n(p, "y"))).filter(|&(x, y)| free(x, y)).map(|(x, y)| (x as usize, y as usize));
	if start.is_none() { start = grid.open.iter().position(|&o| o).map(|i| (i % width, i / width)); }
	let label = grid.components();
	let home = start.map(|(x, y)| label[y * width + x]);
	let (tiles, land, path) = (j::at(w, "tiles").clone(), j::s(j::at(w, "growth"), "tile").to_owned(), PATH.to_owned());
	move |s: &Json| {
		let Some(home) = home else { return false };
		let x_axis = j::s(s, "axis") == "x";
		let length = if x_axis { width } else { height };
		let at = j::n(s, "at") as isize;
		let lab = |along: isize, i: usize| -> i32 {
			if along < 0 || along as usize >= length { return -1; }
			let along = along as usize;
			if x_axis { label[i * width + along] } else { label[along * width + i] }
		};
		// the strip's walkable rows in runs; each run joins the parts on both sides of the seam beside it
		let mut runs: Vec<(Vec<i32>, bool)> = Vec::new();
		let mut open = false;
		for (i, f) in j::a(s, "fill").iter().enumerate() {
			let tile = f.as_str();
			let walks = tile.and_then(|t| tiles.get(t)).and_then(|t| t.get("walk")).is_some_and(j::truthy);
			if !walks { open = false; continue; }
			if !open { runs.push((Vec::new(), false)); open = true; }
			let run = runs.last_mut().expect("a run");
			if tile == Some(land.as_str()) || tile == Some(path.as_str()) { run.1 = true; }
			for l in [lab(at - 1, i), lab(at, i)] { if l >= 0 { run.0.push(l); } }
		}
		let mut parent: std::collections::HashMap<i32, i32> = std::collections::HashMap::new();
		fn find(parent: &std::collections::HashMap<i32, i32>, l: i32) -> i32 { let mut r = l; while let Some(&p) = parent.get(&r) { if p == r { break; } r = p; } r }
		for (labels, _) in &runs {
			for &l in labels.iter().skip(1) {
				let (a, b) = (find(&parent, labels[0]), find(&parent, l));
				if a != b { parent.insert(b, a); }
			}
		}
		let root = find(&parent, home);
		runs.iter().all(|(labels, land)| !*land || labels.iter().any(|&l| find(&parent, l) == root))
	}
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

/// `rectanglesOf`: the rectangles a seam may not cross (what has one in the room, and a Motion's zone).
fn rectangles_of(room_id: &str, entries: &[Json]) -> Vec<Json> {
	entries.iter().filter(|x| j::so(fields(x), "room") == Some(room_id)).filter_map(|x| {
		let f = fields(x);
		if is(x, "Motion") && j::opt(f, "zone").is_some_and(j::truthy) { Some(j::at(f, "zone").clone()) }
		else if j::no(f, "w").is_some() && j::no(f, "h").is_some() { Some(f.clone()) } else { None }
	}).collect()
}

/// `growthStep`: what growth decides for a room from its entries (its positioned entries and its exits): the step, or
/// None (too little land taken, no candidate, none that crosses no rectangle and keeps the room joined).
pub fn growth_step(w: &Json, room: &Json, entries: &[Json]) -> Option<Json> {
	let d = j::at(w, "growth");
	let room_id = j::s(room, "roomId");
	let ground = rows(j::at(room, "ground"));
	let exits: Vec<Json> = entries.iter().filter(|x| is(x, "Exit") && j::so(fields(x), "location") == Some(room_id)).map(|x| fields(x).clone()).collect();
	let mut land: HashSet<String> = HashSet::new();
	for (y, row) in ground.iter().enumerate() {
		for x in 0..js::len16(row) {
			let (xf, yf) = (x as f64, y as f64);
			if walkable(w, &ground, xf, yf) && js::slice16(row, x as isize, Some(x as isize + 1)) != PATH && !is_passage(&exits, xf, yf) { land.insert(key(xf, yf)); }
		}
	}
	let occupied: HashSet<String> = claimed(entries).into_iter().filter(|k| land.contains(k)).collect();
	if land.is_empty() || (occupied.len() as f64) < land.len() as f64 * j::n(d, "fullShare") { return None; }
	let rects = rectangles_of(room_id, entries);
	let safe = seam_check(w, room, &ground, entries);
	candidates(w, &ground, &exits).into_iter().find(|s| !rects.iter().any(|r| crosses(r, s)) && safe(s))
}

/// `growthKey`: everything `growth_step` reads of a room, as one text: the lock's version, the Room entry's id, and as
/// values every rectangle, the footprints, the fires and the exits. Equal texts give the same decision.
pub fn growth_key(room_entry: &Json, version: f64, entries: &[Json]) -> String {
	let room_id = j::s(fields(room_entry), "roomId");
	let mut parts: Vec<String> = Vec::new();
	for e in entries {
		let f = fields(e);
		let (x, y) = (key_text(j::at(f, "x")), key_text(j::at(f, "y")));
		if is(e, "Beacon") { parts.push(format!("b{x},{y}")); } else if is(e, "Exit") { parts.push(format!("e{x},{y}")); }
		if j::so(f, "room") != Some(room_id) { continue; }
		if is(e, "Motion") && j::opt(f, "zone").is_some_and(j::truthy) {
			let z = j::at(f, "zone");
			parts.push(format!("z{},{},{},{}", key_text(j::at(z, "x")), key_text(j::at(z, "y")), key_text(j::at(z, "w")), key_text(j::at(z, "h"))));
		} else if j::no(f, "w").is_some() && j::no(f, "h").is_some() {
			parts.push(format!("{}{x},{y},{},{}", if is(e, "Footprint") { "f" } else { "r" }, key_text(j::at(f, "w")), key_text(j::at(f, "h"))));
		}
	}
	parts.sort();
	format!("{} {} {}", phi_json::number_text(version), key_text(j::at(room_entry, "id")), parts.join(" "))
}

thread_local! {
	/// Per space (`Space::key`) and room, the key of the room whose last decision was no step.
	static NO_STEP: std::cell::RefCell<std::collections::HashMap<(usize, String), String>> = Default::default();
}

/// `growthTick`: a busy world defers growth; a room and every displaced position change in one transaction under the
/// world lock. How many rooms grew. A room is decided first on `view` (the world's copy, or the space outside a transaction), without a
/// lock: one held right now, one whose decision is kept and one with no step are passed over without taking anything.
/// Only a room with a step takes the locks; its lock's version must still be the one the view showed, and the decision
/// is made again on what the transaction reads.
pub async fn growth_tick(space: &Space, w: &Json, lease_ms: f64, view: &Space) -> Result<f64> {
	let Some(d) = j::opt(w, "growth") else { return Ok(0.0) };
	let strip = j::n(d, "strip");
	if strip.fract() != 0.0 || strip.is_nan() || strip < 1.0 { return Err(Error::Other("growth.strip must be a positive integer".into())); }
	view.fresh().await?;
	let mut grew = 0.0;
	for entry in view.read_all(&obj! { "type" => "Room" }, None).await? {
		if super::interior::is_interior(j::s(fields(&entry), "roomId")) { continue; } // a building's inside keeps its walls
		let rid = crate::fire::key_text(j::at(fields(&entry), "roomId"));
		let Some(lock) = view.read_all(&crate::room_lock::room_lock(&rid), None).await?.into_iter().next() else { continue }; // held right now
		let version = crate::room_lock::lock_version(fields(&lock));
		let mut templates: Vec<Json> = POSITIONED.iter().map(|ty| tmpl(ty, obj! { "room" => rid.as_str() })).collect();
		templates.push(tmpl("Exit", obj! { "location" => rid.as_str() }));
		let reads = templates.iter().map(|t| Box::pin(view.read_all(t, None)) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Json>>> + '_>>).collect();
		let mut seen: Vec<Json> = Vec::new();
		for group in join_all(reads).await { seen.extend(group?); }
		let k = growth_key(&entry, version, &seen);
		let slot = (space.key(), rid.clone());
		if NO_STEP.with(|m| m.borrow().get(&slot) == Some(&k)) { continue; }
		if growth_step(w, fields(&entry), &seen).is_none() { NO_STEP.with(|m| m.borrow_mut().insert(slot, k)); continue; }
		NO_STEP.with(|m| m.borrow_mut().remove(&slot));
		let txn = space.create_transaction(30_000.0).await?;
		let r: Result<Option<bool>> = async {
			if space.take_if_exists(&world_lock(), NO_WAIT, Some(&txn)).await?.is_none() { return Ok(None); }
			// the island's lock after WORLD_LOCK, then the room's (room_lock.rs): a job that holds only the room's lock and no
			// WORLD_LOCK would otherwise write a footprint where the room is shifting
			if let Some(island) = j::at(fields(&entry), "island").as_str() {
				if !crate::room_lock::hold_island(space, &txn, island, &[], NO_WAIT).await? { return Ok(Some(false)); }
			}
			if crate::room_lock::hold_room_version(space, &txn, &rid, NO_WAIT).await? != Some(version) { return Ok(Some(false)); }
			let Some(e) = space.take_if_exists(&obj! { "id" => j::at(&entry, "id").clone() }, NO_WAIT, Some(&txn)).await? else { return Ok(Some(false)) };
			let room = fields(&e).clone();
			let room_id = j::s(&room, "roomId").to_owned();
			let ground = rows(j::at(&room, "ground"));
			let mut entries: Vec<Json> = Vec::new();
			// the groups at once, as TypeScript's Promise.all, in the same order
			let mut templates: Vec<Json> = POSITIONED.iter().map(|ty| tmpl(ty, obj! { "room" => room_id.as_str() })).collect();
			templates.push(tmpl("Item", obj! { "location" => room_id.as_str() }));
			templates.push(obj! { "type" => "Exit" });
			let reads = templates.iter().map(|t| Box::pin(space.read_all(t, Some(&txn))) as std::pin::Pin<Box<dyn std::future::Future<Output = Result<Vec<Json>>> + '_>>).collect();
			for group in join_all(reads).await { entries.extend(group?); }
			let Some(step) = growth_step(w, &room, &entries) else { return Ok(Some(false)) };
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
				if is(&old, "Spot") { space.write_unique(&entry, Some(&txn), FOREVER, &["room", "x", "y"]).await?; } else { space.write(&entry, Some(&txn), FOREVER).await?; }
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

#[cfg(test)]
mod tests {
	//! `seam_check` against `connected`, the two searches over the grown room it replaced (kept here as it was), over
	//! random rooms, every seam on both axes and strips of 1 to 4 (as tests/growth-seams.test.ts does in TypeScript).
	use super::*;

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
	pub(super) fn connected(w: &Json, room: &Json, ground: &[String], s: &Json, entries: &[Json]) -> Result<bool> {
		let obstacles: Vec<&Json> = entries.iter().filter(|e| is(e, "Footprint") || is(e, "Beacon")).map(fields).collect();
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

	/// The fill a seam takes (`candidates`), without the condition of half grass.
	fn step(w: &Json, ground: &[String], axis: &str, at: usize, size: f64) -> Json {
		let (width, height) = (js::len16(&ground[0]), ground.len());
		let (length, across) = if axis == "x" { (width, height) } else { (height, width) };
		let tile = Json::from(j::s(j::at(w, "growth"), "tile"));
		let path = Json::from(PATH);
		let cell = |along: usize, cross: usize| if axis == "x" { cell_at(ground, cross, along) } else { cell_at(ground, along, cross) };
		let fill: Vec<Json> = (0..across).map(|i| {
			let a = cell(at - 1, i);
			let b = if at < length { cell(at, i) } else { a.clone() };
			if a == path || b == path { path.clone() } else if a == tile || b == tile { tile.clone() } else { a }
		}).collect();
		obj! { "axis" => axis, "at" => at as f64, "size" => size, "fill" => Json::Array(fill) }
	}

	#[test]
	fn seam_check_answers_as_the_two_searches() {
		let w = phi_json::parse(r##"{"tiles":{"~":{"walk":false},".":{"walk":true},",":{"walk":true},":":{"walk":true},"_":{"walk":true},"#":{"walk":false}},"growth":{"tile":","}}"##).unwrap();
		let mut seed: u64 = 11;
		let mut rnd = move || { seed = (seed.wrapping_mul(1103515245).wrapping_add(12345)) % (1 << 31); seed as f64 / (1u64 << 31) as f64 };
		let tiles = [",", ",", ",", ".", ":", "~", "#", "_"];
		let (mut seams, mut safe) = (0, 0);
		for n in 0..300 {
			let (width, height) = (3 + (rnd() * 34.0) as usize, 3 + (rnd() * 22.0) as usize);
			let (water, plots) = (rnd() * 0.25, rnd() * 0.25);
			let ground: Vec<String> = (0..height).map(|_| (0..width).map(|_| if rnd() < water { if rnd() < 0.7 { "~" } else { "#" } } else { tiles[(rnd() * tiles.len() as f64) as usize] }).collect()).collect();
			let mut entries = Vec::new();
			for y in 0..height { for x in 0..width { if rnd() < plots { let ty = if rnd() < 0.9 { "Footprint" } else { "Beacon" }; entries.push(obj! { "type" => ty, "types" => Json::Array(vec![Json::from(ty)]), "fields" => obj! { "x" => x as f64, "y" => y as f64, "w" => 1.0, "h" => 1.0 } }); } } }
			if rnd() < 0.3 { let x = (rnd() * width as f64) as usize; for y in 0..height { entries.push(obj! { "type" => "Footprint", "types" => Json::Array(vec![Json::from("Footprint")]), "fields" => obj! { "x" => x as f64, "y" => y as f64, "w" => 1.0, "h" => 1.0 } }); } }
			let mut room = obj! { "roomId" => "r", "ground" => Json::Array(ground.iter().map(|r| Json::from(r.as_str())).collect()) };
			if rnd() < 0.7 { j::set(&mut room, "spawn", obj! { "x" => (rnd() * width as f64).floor(), "y" => (rnd() * height as f64).floor() }); }
			let check = seam_check(&w, &room, &ground, &entries);
			for axis in ["x", "y"] {
				let length = if axis == "x" { width } else { height };
				for at in 1..=length {
					let s = step(&w, &ground, axis, at, 1.0 + (rnd() * 4.0).floor());
					let before = connected(&w, &room, &ground, &s, &entries).unwrap();
					assert_eq!(check(&s), before, "room {n} ({width}x{height}), {axis}@{at}: {ground:?}");
					seams += 1;
					if before { safe += 1; }
				}
			}
		}
		assert!(safe * 10 > seams && safe * 10 < seams * 9, "both answers occur: {safe} of {seams} safe");
	}

	/// `growth_key`: what is written without the room's lock or by hand changes the key (a fire, a zone, a footprint, an
	/// exit, the room's entry, the version); a rewrite that keeps every rectangle (a bed watered, a new id) does not.
	#[test]
	fn the_key_names_every_input() {
		let e = |id: &str, ty: &str, f: Json| obj! { "id" => id, "type" => ty, "types" => Json::Array(vec![Json::from(ty)]), "fields" => f };
		let room = e("r1", "Room", obj! { "roomId" => "r", "ground" => Json::Array(vec![]) });
		let bed = |id: &str| e(id, "Bed", obj! { "bedId" => "b", "room" => "r", "x" => 1.0, "y" => 2.0, "w" => 2.0, "h" => 2.0, "water" => if id == "e1" { 0.0 } else { 3.0 } });
		let base = vec![bed("e1"), e("e2", "Footprint", obj! { "room" => "r", "of" => "b", "x" => 1.0, "y" => 2.0, "w" => 2.0, "h" => 2.0 })];
		let key = |entries: &[Json]| growth_key(&room, 0.0, entries);
		let k = key(&base);
		assert_eq!(key(&[bed("e9"), base[1].clone()]), k, "a bed rewritten keeps its rectangle");
		let with = |x: Json| { let mut v = base.clone(); v.push(x); key(&v) };
		assert_ne!(with(e("e3", "Beacon", obj! { "beaconId" => "f", "room" => "r", "x" => 5.0, "y" => 5.0 })), k, "a fire");
		assert_ne!(with(e("e4", "Zone", obj! { "zoneId" => "z", "room" => "r", "x" => 5.0, "y" => 5.0, "w" => 2.0, "h" => 2.0 })), k, "a zone");
		assert_ne!(with(e("e5", "Motion", obj! { "motionId" => "m", "room" => "r", "zone" => obj! { "x" => 5.0, "y" => 5.0, "w" => 2.0, "h" => 2.0 } })), k, "a motion's zone");
		assert_ne!(with(e("e6", "Footprint", obj! { "room" => "r", "of" => "c", "x" => 7.0, "y" => 2.0, "w" => 1.0, "h" => 1.0 })), k, "a footprint");
		assert_ne!(with(e("e7", "Exit", obj! { "exitId" => "x", "location" => "r", "x" => 0.0, "y" => 3.0 })), k, "an exit");
		assert_ne!(growth_key(&room, 1.0, &base), k, "the lock's version");
		assert_ne!(growth_key(&e("r2", "Room", obj! { "roomId" => "r" }), 0.0, &base), k, "the room rewritten");
		assert_ne!(key(&base[..1]), k, "a footprint taken");
	}
}
