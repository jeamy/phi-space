//! The world definition (`server/engine/world.ts`): `worlds/<id>/world.json` as JSON. The checks of `loadWorld` (every
//! row as wide as the first, every tile and prototype known, every spawn walkable) are not ported yet: the definition the
//! TypeScript engine accepted is what this one reads.
use std::path::Path;

use phi_json::Json;

use crate::j;
use crate::space::{Error, Result};

/// `loadWorld(id)` below `root` (the spaces-mmo folder).
pub fn load_world(root: &Path, id: &str) -> Result<Json> {
	if id.is_empty() || id.len() > 40 || !id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-') {
		return Err(Error::Other(format!("SPACES_MMO_WORLD: a-z, 0-9 and -, got {id}")));
	}
	let text = std::fs::read_to_string(root.join("worlds").join(id).join("world.json")).map_err(|e| Error::Other(format!("world {id}: {e}")))?;
	phi_json::parse(&text).map_err(|e| Error::Other(format!("world {id}: {e:?}")))
}

/// `walkable(w, ground, x, y)`.
pub fn walkable(w: &Json, ground: &[String], x: f64, y: f64) -> bool {
	if x.fract() != 0.0 || y.fract() != 0.0 || !x.is_finite() || !y.is_finite() || y < 0.0 || x < 0.0 { return false; }
	let (xi, yi) = (x as usize, y as usize);
	let Some(row) = ground.get(yi) else { return false };
	if xi >= ground.first().map_or(0, |r| crate::js::len16(r)) { return false; }
	let Some(k) = crate::js::slice16(row, xi as isize, Some(xi as isize + 1)).chars().next() else { return false };
	j::b(j::at(j::at(w, "tiles"), &k.to_string()), "walk")
}

/// `findPath`: the cells from `from` (not included) to `to` over walkable cells, at most `max` steps; empty when they are
/// the same cell, None when there is no way.
pub fn find_path(w: &Json, ground: &[String], from: (f64, f64), to: (f64, f64), max: usize, blocked: &dyn Fn(&str) -> bool) -> Option<Vec<(f64, f64)>> {
	let cell = |x: f64, y: f64| format!("{},{}", phi_json::number_text(x), phi_json::number_text(y));
	if !walkable(w, ground, to.0, to.1) || blocked(&cell(to.0, to.1)) { return None; }
	if from == to { return Some(vec![]); }
	let width = crate::js::len16(&ground[0]) as f64;
	let key = |x: f64, y: f64| y * width + x;
	let k0 = key(from.0, from.1);
	let mut prev: std::collections::HashMap<u64, f64> = std::collections::HashMap::from([(k0.to_bits(), -1.0)]);
	let mut frontier = vec![from];
	let mut step = 0;
	while step < max && !frontier.is_empty() {
		let mut next = Vec::new();
		for c in &frontier {
			for (dx, dy) in [(1.0, 0.0), (-1.0, 0.0), (0.0, 1.0), (0.0, -1.0)] {
				let (x, y) = (c.0 + dx, c.1 + dy);
				let k = key(x, y);
				if prev.contains_key(&(k + 0.0).to_bits()) || !walkable(w, ground, x, y) || blocked(&cell(x, y)) { continue; }
				prev.insert((k + 0.0).to_bits(), key(c.0, c.1));
				if x == to.0 && y == to.1 {
					let mut path = Vec::new();
					let mut at = k;
					while at != k0 { path.insert(0, (at % width, (at / width).floor())); at = prev[&(at + 0.0).to_bits()]; }
					return Some(path);
				}
				next.push((x, y));
			}
		}
		frontier = next;
		step += 1;
	}
	None
}

/// `wayTo`: the name of the first exit on the shortest way between two rooms.
pub fn way_to(w: &Json, from: &str, to: &str) -> Option<String> {
	if from == to { return None; }
	let mut first: Vec<(String, String)> = vec![(from.to_owned(), String::new())];
	let mut frontier = vec![from.to_owned()];
	while !frontier.is_empty() {
		let mut next = Vec::new();
		for r in &frontier {
			for e in j::a(w, "exits").iter().filter(|x| j::s(x, "room") == r) {
				let dest = j::s(e, "destination");
				if first.iter().any(|(k, _)| k == dest) { continue; }
				let via = first.iter().find(|(k, _)| k == r).map(|(_, v)| v.clone()).unwrap_or_default();
				first.push((dest.to_owned(), if via.is_empty() { j::s(e, "name").to_owned() } else { via }));
				if dest == to { return first.last().map(|(_, v)| v.clone()); }
				next.push(dest.to_owned());
			}
		}
		frontier = next;
	}
	None
}

/// `sceneryText`.
pub fn scenery_text(w: &Json, s: &Json) -> String {
	let about = j::at(j::at(w, "sceneryAbout"), j::s(s, "name")).as_str().unwrap_or("").to_owned();
	if j::b(s, "fixed") { return crate::js::trim(&format!("{about} Das bleibt stehen.")).to_owned(); }
	let gain: Vec<String> = j::a(s, "yields").iter().map(|y| format!("{} {}", crate::fire::key_text(j::at(y, "count")), j::by(j::a(w, "prototypes"), "key", j::s(y, "proto")).map_or_else(|| crate::fire::key_text(j::at(y, "proto")), |p| j::s(p, "name").to_owned()))).collect();
	let gain = gain.join(", ");
	crate::js::trim(&format!("{about} Lässt sich abräumen („räume“, noch {} Arbeit){}.", crate::fire::key_text(j::at(s, "left")), if gain.is_empty() { String::new() } else { format!(", das bringt {gain}") })).to_owned()
}
