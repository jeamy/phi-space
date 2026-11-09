//! The town hall (`server/engine/commands/townhall.ts`), so far its zones as other commands ask about them.
use phi_json::{obj, Json};

use crate::context::Ctx;
use crate::j;
use crate::space::{fields, tmpl, Result, Space};

/// `hallIn`.
pub async fn hall_in(space: &Space, w: &Json, room: &str, txn: Option<&str>) -> Result<bool> {
	let Some(t) = j::opt(w, "townhall") else { return Ok(false) };
	Ok(space.count(&tmpl("Building", obj! { "room" => room, "plan" => j::at(t, "plan").clone() }), txn).await? > 0.0)
}

fn is_in(p: (f64, f64), r: &Json) -> bool { p.0 >= j::n(r, "x") && p.1 >= j::n(r, "y") && p.0 < j::n(r, "x") + j::n(r, "w") && p.1 < j::n(r, "y") + j::n(r, "h") }

/// `zoneRefusal`: why the room's zones forbid `cells` (`green`: a bed or a green plan, which a green zone admits).
pub async fn zone_refusal(c: &Ctx, room: &str, cells: &[(f64, f64)], green: bool) -> Result<Option<String>> {
	if j::opt(c.w(), "townhall").is_none() { return Ok(None); }
	for e in c.space.read_all(&tmpl("Zone", obj! { "room" => room }), None).await? {
		let z = fields(&e);
		if j::s(z, "kind") == "gruen" && green { continue; }
		if cells.iter().any(|p| is_in(*p, z)) { return Ok(Some(if j::s(z, "kind") == "weg" { "Dort liegt ein Wegerecht; das bleibt frei." } else { "Das ist Grünzone; dort gehen nur Beete und Parks." }.into())); }
	}
	Ok(None)
}

/// `zonesLine`.
pub async fn zones_line(space: &Space, room: &str) -> Result<String> {
	let n = |z: &Json, k: &str| crate::fire::key_text(j::at(z, k));
	Ok(space.read_all(&tmpl("Zone", obj! { "room" => room }), None).await?.iter().map(|e| { let z = fields(e); format!("{} {}×{} ab Feld {}, {}", if j::s(z, "kind") == "weg" { "Wegerecht" } else { "Grünzone" }, n(z, "w"), n(z, "h"), n(z, "x"), n(z, "y")) }).collect::<Vec<_>>().join("; "))
}
