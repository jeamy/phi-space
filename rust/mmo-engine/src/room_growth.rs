//! Rooms that grew (`server/engine/room-growth.ts`): strips added east and south, and the points of the definition moved
//! with them.
use phi_json::Json;

use crate::j;
use crate::model::world_lock;
use crate::space::{fields, tmpl, Error, Result, Space};

/// `grownPoint`: `point` moved by the steps after `revision`.
pub fn grown_point(point: &Json, g: &Json, revision: usize) -> Json {
	let mut out = j::object(point);
	for s in j::a(g, "steps").iter().skip(revision) {
		let axis = j::s(s, "axis");
		let v = out.get(axis).and_then(Json::as_f64).unwrap_or(f64::NAN);
		if v >= j::n(s, "at") { out.insert(axis, Json::from(v + j::n(s, "size"))); }
	}
	Json::Object(out)
}

fn repeat(s: &str, n: f64) -> String { s.repeat(n.max(0.0) as usize) }

/// `insertStrip`.
pub fn insert_strip(ground: &[String], s: &Json, decor: bool) -> Result<Vec<String>> {
	let width = ground.first().map_or(0, |r| crate::js::len16(r)) as f64;
	let height = ground.len() as f64;
	let axis = j::s(s, "axis");
	let length = if axis == "x" { width } else { height };
	let (at, size, fill) = (j::n(s, "at"), j::n(s, "size"), j::a(s, "fill"));
	let fits = at.fract() == 0.0 && at >= 0.0 && at <= length && size.fract() == 0.0 && size >= 1.0 && fill.len() as f64 == if axis == "x" { height } else { width };
	if !fits { return Err(Error::Other("room growth does not fit the terrain".into())); }
	if axis == "x" {
		return Ok(ground.iter().enumerate().map(|(y, row)| {
			let piece = if decor { " ".to_owned() } else { fill[y].as_str().unwrap_or("").to_owned() };
			format!("{}{}{}", crate::js::slice16(row, 0, Some(at as isize)), repeat(&piece, size), crate::js::slice16(row, at as isize, None))
		}).collect());
	}
	let row = if decor { " ".repeat(width as usize) } else { fill.iter().filter_map(Json::as_str).collect::<String>() };
	let at = at as usize;
	let mut out: Vec<String> = ground[..at].to_vec();
	out.extend(std::iter::repeat_n(row, size as usize));
	out.extend_from_slice(&ground[at..]);
	Ok(out)
}

/// `grownGround`.
pub fn grown_ground(ground: &[String], g: &Json, tile: &str, decor: bool) -> Result<Vec<String>> {
	if let Some(bw) = j::no(g, "baseWidth") {
		if ground.first().map(|r| crate::js::len16(r) as f64) != Some(bw) || Some(ground.len() as f64) != j::no(g, "baseHeight") {
			return Err(Error::Other("the world changed the base dimensions of a grown room; an explicit terrain migration is required".into()));
		}
	}
	let steps = j::a(g, "steps");
	let sum = |ax: &str| steps.iter().filter(|s| j::s(s, "axis") == ax).map(|s| j::n(s, "size")).sum::<f64>();
	let (east, south) = (j::n(g, "east") - sum("x"), j::n(g, "south") - sum("y"));
	if east < 0.0 || south < 0.0 { return Err(Error::Other("inconsistent room growth totals".into())); }
	let mut out: Vec<String> = ground.iter().map(|row| format!("{row}{}", repeat(tile, east))).collect();
	let w0 = out.first().map_or(0, |r| crate::js::len16(r));
	for _ in 0..south as usize { out.push(repeat(tile, w0 as f64)); }
	for step in steps { out = insert_strip(&out, step, decor)?; }
	Ok(out)
}

/// `grownDecor`: None for a room without decor.
pub fn grown_decor(decor: Option<&[String]>, g: &Json) -> Result<Option<Vec<String>>> {
	match decor { Some(d) => Ok(Some(grown_ground(d, g, " ", true)?)), None => Ok(None) }
}

/// The rows of a ground or decor field.
pub fn rows(v: &Json) -> Vec<String> { v.as_array().map(|a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()).unwrap_or_default() }
pub fn rows_json(r: &[String]) -> Json { Json::Array(r.iter().map(|x| Json::from(x.as_str())).collect()) }

/// `pinTerrain`.
pub async fn pin_terrain(space: &Space, txn: &str) -> Result<()> {
	if space.read_if_exists(&world_lock(), 2_000.0, Some(txn)).await?.is_none() { return Err(Error::Other("the terrain is being changed; retry this operation".into())); }
	Ok(())
}

/// `spatialWorld`: the definition in the coordinates of the rooms as they grew.
pub async fn spatial_world(space: &Space, w: &Json) -> Result<Json> {
	let all = space.read_all(&phi_json::obj! { "type" => "RoomGrowth" }, None).await?;
	if all.is_empty() { return Ok(w.clone()); }
	let mut growth: Vec<(String, Json)> = Vec::new();
	for e in &all {
		let g = fields(e).clone();
		let id = j::s(&g, "roomId").to_owned();
		if let Some(slot) = growth.iter_mut().find(|(k, _)| *k == id) { slot.1 = g; } else { growth.push((id, g)); }
	}
	let get = |room: &str| growth.iter().find(|(k, _)| k == room).map(|(_, g)| g);
	let point = |room: &str, p: &Json| get(room).map_or_else(|| p.clone(), |g| grown_point(p, g, 0));
	let tile = j::so(j::at(w, "growth"), "tile").unwrap_or(",").to_owned();
	let room = |r: &Json| -> Result<Json> {
		let Some(g) = get(j::s(r, "roomId")) else { return Ok(r.clone()) };
		let mut o = j::object(r);
		o.insert("ground", rows_json(&grown_ground(&rows(j::at(r, "ground")), g, &tile, false)?));
		match grown_decor(j::opt(r, "decor").map(rows).as_deref(), g)? { Some(d) => o.insert("decor", rows_json(&d)), None => { o.remove("decor"); } }
		o.insert("spawn", grown_point(j::at(r, "spawn"), g, 0));
		Ok(Json::Object(o))
	};
	let mut out = j::object(w);
	out.insert("rooms", Json::Array(j::a(w, "rooms").iter().map(room).collect::<Result<_>>()?));
	if let Some(all) = j::ao(w, "allRooms") { out.insert("allRooms", Json::Array(all.iter().map(room).collect::<Result<_>>()?)); }
	if let Some(all) = j::ao(w, "allBeacons") { out.insert("allBeacons", Json::Array(all.iter().map(|b| point(j::s(b, "room"), b)).collect())); }
	out.insert("exits", Json::Array(j::a(w, "exits").iter().map(|e| { let mut x = j::object(&point(j::s(e, "room"), e)); x.insert("arrive", point(j::s(e, "destination"), j::at(e, "arrive"))); Json::Object(x) }).collect()));
	out.insert("beacons", Json::Array(j::a(w, "beacons").iter().map(|b| point(j::s(b, "room"), b)).collect()));
	out.insert("npcs", Json::Array(j::a(w, "npcs").iter().map(|n| point(j::s(n, "room"), n)).collect()));
	out.insert("objects", Json::Array(j::a(w, "objects").iter().map(|o| point(j::s(o, "room"), o)).collect()));
	match j::ao(w, "scenery") { Some(sc) => out.insert("scenery", Json::Array(sc.iter().map(|s| point(j::s(s, "room"), s)).collect())), None => { out.remove("scenery"); } }
	Ok(Json::Object(out))
}

/// A room's growth as the loader reads it (`{ roomId, east: 0, south: 0 }` when it has none).
pub async fn growth_at(space: &Space, txn: Option<&str>, room_id: &str) -> Result<Json> {
	Ok(match space.peek(&tmpl("RoomGrowth", phi_json::obj! { "roomId" => room_id }), txn).await? {
		Some(e) => fields(&e).clone(),
		None => phi_json::obj! { "roomId" => room_id, "east" => 0.0, "south" => 0.0 },
	})
}
