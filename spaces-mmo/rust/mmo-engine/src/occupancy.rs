//! Who stands where (`server/engine/occupancy.ts`): an online character holds its cell as a Spot, written with the
//! space's unique check on room and cell; only online characters (a live Session) block a cell.
use std::collections::{HashMap, HashSet};

use phi_json::{obj, Json};

use crate::fire::key_text;
use crate::j;
use crate::space::{by_id, fields, tmpl, Error, Result, Space, FOREVER, NO_WAIT};
use crate::world::walkable;
use crate::rules::PASSAGE;

/// `cellKey`.
pub fn cell_key(x: f64, y: f64) -> String { format!("{},{}", phi_json::number_text(x), phi_json::number_text(y)) }
/// `cellKey` of an object's `x` and `y` as they are (`undefined` when one is missing).
pub fn cell_of(f: &Json) -> String { format!("{},{}", key_text(j::at(f, "x")), key_text(j::at(f, "y"))) }

/// `onlineIds`.
pub async fn online_ids(space: &Space) -> Result<HashSet<String>> {
	Ok(space.read_all(&obj! { "type" => "Session" }, None).await?.iter().map(|s| key_text(j::at(fields(s), "charId"))).collect())
}

/// `occupiedIn`: cell → the name of the online character other than `except` standing there, in the order the Spots
/// are listed (a second Spot on a cell keeps the first place and the last name, as a Map does).
pub async fn occupied_in(space: &Space, room: &str, except: Option<&str>) -> Result<Vec<(String, String)>> {
	let live = online_ids(space).await?;
	let mut out: Vec<(String, String)> = Vec::new();
	for e in space.read_all(&tmpl("Spot", obj! { "room" => room }), None).await? {
		let s = fields(&e);
		let id = key_text(j::at(s, "charId"));
		if Some(id.as_str()) != except && live.contains(&id) {
			let (k, name) = (cell_of(s), key_text(j::at(s, "name")));
			match out.iter_mut().find(|(x, _)| *x == k) { Some(slot) => slot.1 = name, None => out.push((k, name)) }
		}
	}
	Ok(out)
}

/// `isPassage`: an exit's cell or one next to it.
pub fn is_passage(exits: &[Json], x: f64, y: f64) -> bool { exits.iter().any(|e| (j::n(e, "x") - x).abs().max((j::n(e, "y") - y).abs()) <= PASSAGE) }

/// `releaseSpot`.
pub async fn release_spot(space: &Space, txn: &str, char_id: &str) -> Result<()> {
	space.take_if_exists(&tmpl("Spot", obj! { "charId" => char_id }), NO_WAIT, Some(txn)).await?;
	Ok(())
}

/// `footprint`: the Footprint entry's fields of an object (`w`/`h` 1 when missing).
pub fn footprint(room: &str, of: &str, r: &Json) -> Json {
	let num = |k: &str, d: f64| j::opt(r, k).and_then(Json::as_f64).unwrap_or(d);
	obj! { "room" => room, "of" => of, "x" => j::at(r, "x").clone(), "y" => j::at(r, "y").clone(), "w" => num("w", 1.0), "h" => num("h", 1.0) }
}
/// `footprintCells`: the cells of a footprint, row by row.
pub fn footprint_cells(f: &Json) -> Vec<(f64, f64)> {
	let (x0, y0, w, h) = (j::n(f, "x"), j::n(f, "y"), j::n(f, "w"), j::n(f, "h"));
	let mut out = Vec::new();
	let mut y = y0;
	while y < y0 + h { let mut x = x0; while x < x0 + w { out.push((x, y)); x += 1.0; } y += 1.0; }
	out
}
/// `writeFootprint`: in a transaction that holds the room's lock; `unique` on room and `of` unless `moved` (its old one
/// was taken in this transaction).
pub async fn write_footprint(space: &Space, txn: &str, f: Json, moved: bool) -> Result<()> {
	let e = obj! { "type" => "Footprint", "fields" => f };
	if moved { space.write(&e, Some(txn), FOREVER).await?; } else { space.write_unique(&e, Some(txn), FOREVER, &["room", "of"]).await?; }
	Ok(())
}
/// `takeFootprint`.
pub async fn take_footprint(space: &Space, txn: &str, room: &str, of: &str) -> Result<Option<Json>> {
	Ok(space.take_if_exists(&tmpl("Footprint", obj! { "room" => room, "of" => of }), NO_WAIT, Some(txn)).await?.map(|e| fields(&e).clone()))
}
/// `footprintsIn`: a room's footprints' fields (`txn`: as the space holds them now).
pub async fn footprints_in(space: &Space, room: &str, txn: Option<&str>) -> Result<Vec<Json>> {
	Ok(space.read_all(&tmpl("Footprint", obj! { "room" => room }), txn).await?.iter().map(|e| fields(e).clone()).collect())
}
/// `claimedIn`: cell → the object standing there (the first footprint keeps a cell).
pub async fn claimed_in(space: &Space, room: &str, txn: Option<&str>) -> Result<HashMap<String, String>> {
	let mut out = HashMap::new();
	for f in footprints_in(space, room, txn).await? { let of = key_text(j::at(&f, "of")); for (x, y) in footprint_cells(&f) { out.entry(cell_key(x, y)).or_insert_with(|| of.clone()); } }
	Ok(out)
}

/// `blockedIn`: the cells of persisted fires and of footprints.
pub async fn blocked_in(space: &Space, room: &str) -> Result<HashSet<String>> { blocked_in_txn(space, room, None).await }
/// `blockedIn` with `txn`: the footprints read inside a transaction that holds the room's lock (the fires from the copy).
pub async fn blocked_in_txn(space: &Space, room: &str, txn: Option<&str>) -> Result<HashSet<String>> {
	let mut out: HashSet<String> = space.read_all(&tmpl("Beacon", obj! { "room" => room }), None).await?.iter().map(|e| cell_of(fields(e))).collect();
	out.extend(claimed_in(space, room, txn).await?.into_keys());
	Ok(out)
}

/// `freeCellNear`: the nearest walkable cell to `at` (itself first) not in `avoid`, ring by ring.
pub fn free_cell_near(w: &Json, ground: &[String], at: (f64, f64), avoid: &dyn Fn(&str) -> bool, radius: usize) -> Option<(f64, f64)> {
	let mut seen: HashSet<String> = HashSet::from([cell_key(at.0, at.1)]);
	let mut ring = vec![at];
	let width = ground.first().map_or(0, |r| crate::js::len16(r)) as f64;
	let mut r = 0;
	while r <= radius && !ring.is_empty() {
		for c in &ring { if walkable(w, ground, c.0, c.1) && !avoid(&cell_key(c.0, c.1)) { return Some(*c); } }
		let mut next = Vec::new();
		for c in &ring {
			for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
				let n = (c.0 + dx, c.1 + dy);
				let k = cell_key(n.0, n.1);
				if !seen.contains(&k) && n.1 >= 0.0 && n.1 < ground.len() as f64 && n.0 >= 0.0 && n.0 < width { seen.insert(k); next.push(n); }
			}
		}
		ring = next;
		r += 1;
	}
	None
}

const UNIQUE: [&str; 3] = ["room", "x", "y"];
fn is_taken(e: &Error) -> bool { e.to_string().contains("unique entry already exists") }

/// `claimSpot`: in `txn` the character stands on `to` from now on; None, or the name of who stands there (refused).
pub async fn claim_spot(space: &Space, txn: &str, char_id: &str, name: &Json, room: &str, x: f64, y: f64) -> Result<Option<String>> {
	let old = space.peek(&tmpl("Spot", obj! { "charId" => char_id }), Some(txn)).await?;
	if let Some(o) = &old {
		let f = fields(o);
		if j::at(f, "room").as_str() == Some(room) && j::no(f, "x") == Some(x) && j::no(f, "y") == Some(y) { return Ok(None); }
	}
	let spot = obj! { "type" => "Spot", "fields" => obj! { "room" => room, "x" => x, "y" => y, "charId" => char_id, "name" => name.clone() } };
	if let Err(e) = space.write_unique(&spot, Some(txn), FOREVER, &UNIQUE).await {
		if !is_taken(&e) { return Err(e); }
		let Some(there) = space.peek(&tmpl("Spot", obj! { "room" => room, "x" => x, "y" => y }), None).await? else { return Ok(Some("jemand".into())) };
		let s = fields(&there);
		if !space.read_all(&tmpl("Session", obj! { "charId" => j::at(s, "charId").clone() }), None).await?.is_empty() { return Ok(Some(key_text(j::at(s, "name")))); }
		if space.take_if_exists(&by_id("Spot", &there), NO_WAIT, Some(txn)).await?.is_none() { return Ok(Some("jemand".into())); }
		space.write(&spot, Some(txn), FOREVER).await?;
	}
	if let Some(o) = &old { space.take_if_exists(&by_id("Spot", o), NO_WAIT, Some(txn)).await?; }
	Ok(None)
}
