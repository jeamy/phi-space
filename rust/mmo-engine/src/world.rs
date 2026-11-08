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
