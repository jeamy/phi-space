//! The start check of the grid format (`shared/grid-format.ts`, `server/engine/grid-format.ts`;
//! docs/3d-welt-und-raster-plan-2026-11-21.en.md section 5): before a process writes to a world or region space it reads
//! the store's GridFormat entry and the entry types it holds and refuses a store this binary cannot run. It only reads.
//! The class table is `grid_classes.json`, written from the TypeScript one by `npm run grid:classes`.
use std::sync::OnceLock;

use phi_json::{obj, Json};

use crate::j;
use crate::space::{Error, Result, Space};

/// `SUPPORTED_OCCUPANCY`: the occupancy this binary runs, in Footprint entries (phase 1, step 6). A store without a
/// GridFormat entry that holds a world is of the legacy format (scale 1, plots) and refused; an empty one gets its entry
/// from the loader's first transaction, at the world definition's scale.
pub const SUPPORTED_OCCUPANCY: &str = "footprints";
/// `SUPPORTED_SCALES`: the scales this binary runs; the store's marker must have the world definition's.
pub const SUPPORTED_SCALES: [f64; 2] = [1.0, 2.0];
/// `GRID_MIGRATION`: how the migration of the grid is run, named in a refusal (phase 2).
pub const GRID_MIGRATION: &str = "npm --prefix spaces-mmo run migrate:grid -- --space <address>";
/// `LEGACY_FORMAT`: its scale and occupancy.
pub const LEGACY_SCALE: f64 = 1.0;
pub const LEGACY_OCCUPANCY: &str = "plots";
/// `FOOTPRINTS_MIGRATION`: how the migration from plots to footprints is run, named in a refusal.
pub const FOOTPRINTS_MIGRATION: &str = "npm --prefix spaces-mmo run migrate:footprints -- --space <address>";

/// `GRID_CLASSES`: every entry type a world or region space holds, with its coordinate fields.
pub fn grid_classes() -> &'static Json {
	static TABLE: OnceLock<Json> = OnceLock::new();
	TABLE.get_or_init(|| phi_json::parse(include_str!("grid_classes.json")).expect("grid_classes.json"))
}

/// `classRow`: the row an entry type is classed by, its own or that of a typeclass above it (`Item`); none: unknown.
pub fn class_row(kind: &str, typeclasses: &Json) -> Option<String> {
	let mut seen: Vec<String> = Vec::new();
	let mut t = Some(kind.to_string());
	while let Some(k) = t {
		if seen.contains(&k) { break; }
		if grid_classes().get(&k).is_some() { return Some(k); }
		t = typeclasses.get(&k).and_then(Json::as_str).map(str::to_string);
		seen.push(k);
	}
	None
}

fn scale_text(v: Option<f64>) -> String { v.map_or("none".into(), phi_json::number_text) }

/// `gridRefusal`: why a store cannot be run by this binary, or none.
pub fn grid_refusal(w: &Json, markers: &[Json], types: &[String]) -> Option<String> {
	let scale = j::opt(w, "gridScale").and_then(Json::as_f64).unwrap_or(1.0);
	if !SUPPORTED_SCALES.contains(&scale) { return Some(format!("the world definition has gridScale {}; this binary runs gridScale 1 or 2 only", phi_json::number_text(scale))); }
	if markers.len() > 1 { return Some(format!("the store holds {} GridFormat entries; it is damaged, restore it from its backup", markers.len())); }
	if let Some(m) = markers.first() {
		let id = j::s(w, "id");
		if j::s(m, "worldId") != id { return Some(format!("the store's grid format is of the world {}, not {id}", j::s(m, "worldId"))); }
		if j::s(m, "state") != "complete" { return Some(format!("a grid migration of this store has not finished (GridFormat state {}): run the migration again from its backup", j::s(m, "state"))); }
		let (ms, mo) = (j::n(m, "gridScale"), j::s(m, "occupancy"));
		if mo != SUPPORTED_OCCUPANCY { return Some(format!("the store is in the grid format gridScale {}, occupancy {mo}; this binary runs occupancy {SUPPORTED_OCCUPANCY} only", phi_json::number_text(ms))); }
		if ms != scale { return Some(format!("the store is in the grid format gridScale {}, the world definition has gridScale {}{}", phi_json::number_text(ms), phi_json::number_text(scale), if ms < scale { format!(": migrate the grid first ({GRID_MIGRATION})") } else { String::new() })); }
		let (md, wd) = (j::opt(m, "derivedFrom").and_then(Json::as_f64), j::opt(w, "derivedFrom").and_then(Json::as_f64));
		if md != wd { return Some(format!("the store's geometry is derived from scale {}, the world definition's from {}", scale_text(md), scale_text(wd))); }
	} else if types.iter().any(|t| t == "WorldLoaded") {
		// no marker: an empty store (the loader writes the marker with the world) or one of the legacy format
		return Some(format!("the store is in the legacy grid format (gridScale {}, occupancy {LEGACY_OCCUPANCY}, no GridFormat entry); this binary runs occupancy {SUPPORTED_OCCUPANCY} only: migrate it first ({FOOTPRINTS_MIGRATION})", phi_json::number_text(LEGACY_SCALE)));
	}
	if types.iter().any(|t| t == "Route") && !types.iter().any(|t| t == "RoadCells") { return Some(format!("the store's roads have no RoadCells entries (from before phase 1 step 10 of the grid switch); this binary reads a road's cells from them only: migrate it first ({FOOTPRINTS_MIGRATION})")); }
	if types.iter().any(|t| t == "Plot") { return Some(format!("the store holds Plot entries of the legacy occupancy; this binary reads {SUPPORTED_OCCUPANCY} only: migrate it first ({FOOTPRINTS_MIGRATION})")); }
	let typeclasses = j::at(w, "typeclasses");
	let mut unknown: Vec<&String> = types.iter().filter(|t| class_row(t, typeclasses).is_none()).collect();
	unknown.sort();
	if !unknown.is_empty() { return Some(format!("the store holds entry types without a grid class: {} (shared/grid-format.ts GRID_CLASSES)", unknown.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(", "))); }
	None
}

/// `checkGridFormat`: an error when `space` holds a store in a grid format this binary does not run.
pub async fn check_grid_format(space: &Space, w: &Json) -> Result<()> {
	let markers: Vec<Json> = space.read_all(&obj! { "type" => "GridFormat" }, None).await?.iter().map(|e| j::at(e, "fields").clone()).collect();
	let stats = space.stats().await?;
	let types: Vec<String> = j::at(&stats, "byType").as_object().map(|o| o.keys().map(str::to_string).collect()).unwrap_or_default();
	match grid_refusal(w, &markers, &types) { Some(why) => Err(Error::Other(format!("grid format: {why}"))), None => Ok(()) }
}

/// `awaitGridFormat`: the check until the space answers (a process may start before its space). A refusal ends it at
/// once, a failed call to the space is tried again after `retry_ms`, `tries` times.
pub async fn await_grid_format(space: &Space, w: &Json, tries: usize, retry_ms: u64) -> Result<()> {
	let mut i = 1;
	loop {
		match check_grid_format(space, w).await {
			Err(Error::Space(_)) if i < tries => { tokio::time::sleep(std::time::Duration::from_millis(retry_ms)).await; i += 1; }
			other => return other,
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use phi_json::parse;

	fn world() -> Json { parse(r#"{"id":"leuchtfeuer","typeclasses":{"Driftwood":"Item","Bundle":"Driftwood"}}"#).unwrap() }
	fn marker(f: &str) -> Json { parse(&format!(r#"{{"worldId":"leuchtfeuer","gridScale":1,"occupancy":"footprints","state":"complete"{f}}}"#)).unwrap() }

	#[test]
	fn an_empty_store_starts_and_others_are_refused() {
		let w = world();
		assert_eq!(grid_refusal(&w, &[], &["Character".into(), "Bundle".into()]), None);
		assert_eq!(grid_refusal(&w, &[marker("")], &[]), None);
		// a world of before the switch (no marker), and plots beside a marker
		assert!(grid_refusal(&w, &[], &["WorldLoaded".into()]).unwrap().contains(FOOTPRINTS_MIGRATION));
		assert!(grid_refusal(&w, &[marker("")], &["Plot".into()]).unwrap().contains("Plot entries"));
		// roads of before their RoadCells entries (phase 1 step 10)
		assert!(grid_refusal(&w, &[marker("")], &["Route".into(), "Road".into()]).unwrap().contains("no RoadCells entries"));
		assert_eq!(grid_refusal(&w, &[marker("")], &["Route".into(), "Road".into(), "RoadCells".into()]), None);
		for f in [r#","gridScale":2"#, r#","occupancy":"plots""#, r#","state":"running""#, r#","worldId":"x""#, r#","derivedFrom":1"#] {
			assert!(grid_refusal(&w, &[marker(f)], &[]).is_some(), "{f}");
		}
		assert!(grid_refusal(&w, &[marker(""), marker("")], &[]).unwrap().contains("2 GridFormat entries"));
		// a definition of a scale this binary does not run; a store at its definition's scale, an empty one at either
		let at = |s: f64| { let mut w = world(); w.as_object_mut().unwrap().insert("gridScale", Json::Number(s)); w.as_object_mut().unwrap().insert("derivedFrom", Json::Number(1.0)); w };
		assert!(grid_refusal(&at(3.0), &[], &[]).unwrap().contains("gridScale 3; this binary runs gridScale 1 or 2 only"));
		assert_eq!(grid_refusal(&at(2.0), &[], &[]), None);
		assert_eq!(grid_refusal(&at(2.0), &[marker(r#","gridScale":2,"derivedFrom":1"#)], &["Room".into()]), None);
		assert!(grid_refusal(&at(2.0), &[marker(r#","derivedFrom":1"#)], &["Room".into()]).unwrap().ends_with(&format!("gridScale 1, the world definition has gridScale 2: migrate the grid first ({GRID_MIGRATION})")));
		assert!(grid_refusal(&w, &[marker(r#","gridScale":2"#)], &["Room".into()]).unwrap().ends_with("gridScale 2, the world definition has gridScale 1"));
		assert!(grid_refusal(&w, &[], &["Hovercraft".into()]).unwrap().contains("without a grid class: Hovercraft"));
		assert_eq!(class_row("Bundle", j::at(&w, "typeclasses")).as_deref(), Some("Item"));
	}
}
