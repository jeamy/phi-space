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
	let w = phi_json::parse(&text).map_err(|e| Error::Other(format!("world {id}: {e:?}")))?;
	// the rule values of this process are the world's scale (rules.rs): one world per process
	crate::rules::use_grid_scale(j::opt(&w, "gridScale").and_then(Json::as_f64).unwrap_or(1.0)).map_err(|e| Error::Other(format!("world {id}: {e}")))?;
	Ok(w)
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

/// `findPath`: the cells from `from` (not included) to `to` over walkable cells not in `blocked` ("x,y"), at most `max`
/// steps; empty when they are the same cell, None when there is no way. On the room's grid (`grid::Grid::path`).
pub fn find_path<'a>(w: &Json, ground: &[String], from: (f64, f64), to: (f64, f64), max: usize, blocked: impl IntoIterator<Item = &'a String>) -> Option<Vec<(f64, f64)>> {
	crate::grid::Grid::walk(w, ground).closing(blocked).path(from, to, max)
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
	// a furnishing says what it is for (commands/interior.rs)
	if let Some(d) = j::so(s, "desc").filter(|d| !d.is_empty()) { return d.to_owned(); }
	let about = j::at(j::at(w, "sceneryAbout"), j::s(s, "name")).as_str().unwrap_or("").to_owned();
	if j::b(s, "fixed") { return crate::js::trim(&format!("{about} Das bleibt stehen.")).to_owned(); }
	let gain: Vec<String> = j::a(s, "yields").iter().map(|y| format!("{} {}", crate::fire::key_text(j::at(y, "count")), j::by(j::a(w, "prototypes"), "key", j::s(y, "proto")).map_or_else(|| crate::fire::key_text(j::at(y, "proto")), |p| j::s(p, "name").to_owned()))).collect();
	let gain = gain.join(", ");
	crate::js::trim(&format!("{about} Lässt sich abräumen („räume“, noch {} Arbeit){}.", crate::fire::key_text(j::at(s, "left")), if gain.is_empty() { String::new() } else { format!(", das bringt {gain}") })).to_owned()
}
