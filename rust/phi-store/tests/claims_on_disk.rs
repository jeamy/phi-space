// R2, slice 3 (docs/rust-portierung.md): the claims of a Space stay on the disk. A growing stock of claims is admitted
// and decided; memory holds none of the decided ones, no operation reads the whole map, and the sweep drops them in
// bounded steps through the store's indexes. The same lines through the TypeScript store give the same states and rows.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::driver::{apply_line, seeded};
use phi_core::snapshot::Snapshots;
use phi_core::Claims;
use phi_json::{digest_json, obj, Json};
use phi_store::{SpaceHost, SqliteLedger, Synchronous};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}

#[test]
fn a_growing_stock_of_claims_stays_on_the_disk() {
	let d = dir("claims-on-disk");
	let init = obj! { "op" => "init", "seed" => "claims", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d", "limits" => obj! { "claimResultMs" => 1000.0, "generationAdmitMs" => 60_000.0, "maxCommitBytes" => 1024.0 + 128.0 * 40.0 } };
	let ledger = SpaceHost::sqlite(SqliteLedger::open(&d.join("rust.sqlite"), Synchronous::Full).unwrap());
	let mut host = SpaceHost::open(ledger, "phi-spaces.named-space", Some("sp-walk"), seeded("claims")).unwrap();
	host.commit(|s| {
		s.state.space_id = Some("sp-1".into());
		s.state.incarnation = Some("0a0b0c0d".into());
		s.state.limits = init.get("limits").and_then(Json::as_object).cloned();
		Ok(())
	})
	.unwrap()
	.unwrap();
	let mut snapshots = Snapshots::new();
	let mut lines: Vec<Json> = vec![];
	let mut hashes = vec![];
	let mut step = |host: &mut SpaceHost, l: Json, lines: &mut Vec<Json>| -> Json {
		let now = l.get("now").and_then(Json::as_f64).unwrap();
		let r = host.commit(|s| {
			s.clock = now;
			apply_line(s, &mut snapshots, now, &l)
		});
		let r = r.unwrap().unwrap_or_else(|e| panic!("{}: {e}", l.to_json_text()));
		lines.push(l);
		hashes.push(digest_json(&host.space.state.to_json()).unwrap()); // (reads the whole map: the test's own look)
		r
	};
	let g = step(&mut host, obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } }, &mut lines);
	let generation = g.get("generation").and_then(Json::as_str).unwrap().to_owned();
	let disk = |host: &SpaceHost| match &host.space.state.rpc.as_ref().unwrap().claims {
		Claims::Disk(d) => (d.held(), d.enumerations.clone()),
		Claims::Memory(_) => panic!("the claims are a map part on the disk once stored"),
	};
	let n: usize = std::env::var("N").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
	for i in 0..n {
		let request = obj! { "principal" => obj! { "peerId" => "p1" }, "generation" => generation.as_str(), "requestId" => format!("r{i}") };
		let ad = step(&mut host, obj! { "op" => "admit", "now" => 1000.0 + i as f64, "request" => request, "method" => "write", "args" => obj! { "i" => i as f64 } }, &mut lines);
		let key = ad.get("key").and_then(Json::as_str).unwrap().to_owned();
		step(&mut host, obj! { "op" => "decide", "now" => 1000.0 + i as f64, "key" => key, "outcome" => obj! { "state" => "done", "result" => i as f64 } }, &mut lines);
	}
	let (held, enumerations) = disk(&host);
	assert!(held <= 1, "memory holds {held} claims (the decided ones are on the disk)");
	let scans_before = enumerations.load(Ordering::Relaxed);
	// the results expire; sweeps drop the claims in steps of what a commit may write (40 records)
	let mut sweeps = 0;
	let mut now = 1000.0 + n as f64 + 61_000.0;
	loop {
		step(&mut host, obj! { "op" => "settle", "now" => now }, &mut lines);
		let stats = step(&mut host, obj! { "op" => "stats", "now" => now }, &mut lines);
		sweeps += 1;
		let claims = host.space.state.rpc.as_ref().unwrap().bytes.unwrap();
		if std::env::var("SHOW").is_ok() { eprintln!("sweep {sweeps}: bytes {claims} sweepAt {:?} maintenance {:?} gens {}", host.space.state.rpc.as_ref().unwrap().sweep_at, host.space.state.rest.get("maintenance").map(|m| m.to_json_text()), host.space.state.rpc.as_ref().unwrap().generations.len()); }
		if sweeps > 1 && stats.get("bytes").and_then(|b| b.get("claims")).and_then(Json::as_f64) == Some(claims) && claims < 1.0 {
			break;
		}
		assert!(sweeps < 200, "the sweep does not finish");
		now += 1.0;
	}
	// the counter counts the test's own whole reads (one per step for its hash): the operations added none
	assert_eq!(enumerations.load(Ordering::Relaxed) - scans_before, 2 * sweeps, "no operation read the whole map");
	assert!(sweeps > n * 2 / 40 / 2, "{sweeps} sweeps: bounded steps");
	host.close();

	let mut ts_init = init.clone();
	if let Json::Object(o) = &mut ts_init {
		o.insert("file", d.join("ts.sqlite").to_str().unwrap().into());
	}
	let mut all = vec![ts_init];
	all.extend(lines.iter().cloned());
	all.push(obj! { "op" => "close" });
	let ts = TsDriver::script("test/support/store-driver.ts").run(&all);
	for (i, l) in lines.iter().enumerate() {
		let t = &ts[i + 1];
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "{}: {}", l.to_json_text(), t.to_json_text());
		assert_eq!(t.get("state").and_then(Json::as_str).unwrap(), hashes[i], "state after {}", l.to_json_text());
	}
}
