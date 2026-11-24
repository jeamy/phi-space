//! What one growth run costs the Rust engine (docs/3d-welt-und-raster-plan-2026-11-21.en.md acceptance case 6): run by
//! `tests/perf/growth-lock.ts`, which writes the worst case (`tests/growth-worst.ts`) into a space and names it in
//! `GROWTH_COST_SPACE`; `GROWTH_COST_RUNS` growth runs (default 5) on the world of this checkout, each timed
//! (`GROWTH_COST_READS_ONLY=1`: no room counts as full, so a run is the reads under the lock alone). Prints one
//! line `growth_cost {"runs":[ms…],"grew":n}`. Without `GROWTH_COST_SPACE` it does nothing.
use std::path::Path;
use std::time::Instant;

use mmo_engine::commands::growth::growth_tick;
use mmo_engine::j;
use mmo_engine::space::Space;
use phi_json::{obj, Json};
use phi_spaces_client::{connect_space, ConnectOptions};

#[test]
#[ignore = "a measurement, run by tests/perf/growth-lock.ts"]
fn growth_cost() {
	let Ok(addr) = std::env::var("GROWTH_COST_SPACE") else { return };
	let runs: usize = std::env::var("GROWTH_COST_RUNS").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
	let mut w = mmo_engine::world::load_world(&root, "leuchtfeuer").expect("the world");
	// GROWTH_COST_READS_ONLY=1: no room counts as full, each stops after its reads (what the search adds is the rest)
	if std::env::var("GROWTH_COST_READS_ONLY").as_deref() == Ok("1") { let mut g = j::at(&w, "growth").clone(); phi_json::set(&mut g, "fullShare", 2.0); phi_json::set(&mut w, "growth", g); }
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let local = tokio::task::LocalSet::new();
	local.block_on(&rt, async {
		let (remote, _t) = connect_space(&addr, ConnectOptions::default()).expect("connect");
		let space = Space::new(remote);
		let (mut times, mut grew) = (Vec::new(), 0.0);
		for _ in 0..runs {
			let t = Instant::now();
			grew += growth_tick(&space, &w, 60_000.0).await.expect("growth");
			times.push(Json::Number(t.elapsed().as_secs_f64() * 1000.0));
		}
		println!("growth_cost {}", obj! { "runs" => Json::Array(times), "grew" => grew }.canonical().expect("finite"));
	});
}
