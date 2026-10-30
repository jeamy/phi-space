// R2, slice 1 (docs/rust-portierung.md): the random walk of R1, each line a commit of a Space document, through the
// TypeScript store host (test/support/store-driver.ts, its own SQLite file) and through the Rust one (phi_store's
// SpaceHost over its file). Answers and state hashes are compared step for step, and at the end the rows of both files
// (documents and parts, values compared canonically). The host takes other branches than the core driver: every commit
// starts on a fresh draft, a failed one is rolled back, and the claims are a map part on the disk once stored.
//
// Steps: PHI_STORE_WALK_STEPS (all walks together, default 2 000); one walk: PHI_STORE_WALK_SEED.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::walk::{diff, observe, reply, ts_reply, Walk};
use common::TsDriver;
use phi_core::driver::{apply_line, seeded};
use phi_core::snapshot::Snapshots;
use phi_json::{digest_json, obj, parse, Json};
use phi_store::{SpaceHost, SqliteLedger, Synchronous};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

const KIND: &str = "phi-spaces.named-space";
const KEY: &str = "sp-walk";

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}

/// The Rust side of a walk: the host and what a line needs beside it.
struct RustSide {
	host: SpaceHost,
	snapshots: Snapshots,
	clock: f64,
}
impl RustSide {
	fn open(path: &Path, init: &Json) -> RustSide {
		let seed = init.get("seed").and_then(Json::as_str).unwrap_or("").to_owned();
		let ledger = SpaceHost::sqlite(SqliteLedger::open(path, Synchronous::Full).unwrap());
		let mut host = SpaceHost::open(ledger, KIND, Some(KEY), seeded(&seed)).unwrap();
		let clock = init.get("now").and_then(Json::as_f64).unwrap_or(0.0);
		host.commit(|s| {
			let text = |k: &str| init.get(k).and_then(Json::as_str).map(str::to_owned);
			if let Some(v) = text("spaceId") {
				s.state.space_id = Some(v);
			}
			if let Some(v) = text("incarnation") {
				s.state.incarnation = Some(v);
			}
			if let Some(l) = init.get("limits").and_then(Json::as_object) {
				s.state.limits = Some(l.clone());
			}
			Ok(())
		})
		.unwrap()
		.unwrap();
		RustSide { host, snapshots: Snapshots::new(), clock }
	}
	fn step(&mut self, l: &Json) -> Result<Json, phi_core::CoreError> {
		if let Some(now) = l.get("now").and_then(Json::as_f64) {
			self.clock = now;
		}
		let now = self.clock;
		let snapshots = &mut self.snapshots;
		self.host.commit(|s| {
			s.clock = now;
			apply_line(s, snapshots, now, l)
		})
		.expect("the Rust store writes")
	}
	fn hash(&self) -> String { digest_json(&self.host.space.state.to_json()).unwrap() }
}

/// The rows of a store file: documents and parts in key order, values canonical.
fn rows(path: &Path) -> Vec<String> {
	let db = Connection::open(path).unwrap();
	let canon = |t: String| parse(&t).map(|v| v.canonical().unwrap()).unwrap_or(t);
	let mut out = vec![];
	let mut s = db.prepare("SELECT kind, key, version, value FROM documents ORDER BY kind, key").unwrap();
	out.extend(s.query_map([], |r| Ok(format!("doc {} {} {} {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, canon(r.get::<_, String>(3)?)))).unwrap().map(Result::unwrap));
	let mut s = db.prepare("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, id").unwrap();
	out.extend(
		s.query_map([], |r| {
			Ok(format!(
				"part {} {} {} {} ord {} at {:?} grp {:?} flag {:?} {}",
				r.get::<_, String>(0)?,
				r.get::<_, String>(1)?,
				r.get::<_, String>(2)?,
				r.get::<_, String>(3)?,
				r.get::<_, i64>(4)?,
				r.get::<_, Option<i64>>(6)?,
				r.get::<_, Option<String>>(7)?,
				r.get::<_, Option<i64>>(8)?,
				canon(r.get::<_, String>(5)?)
			))
		})
		.unwrap()
		.map(Result::unwrap),
	);
	out
}

fn walk(seed: u64, steps: usize, seen: &mut BTreeMap<&'static str, usize>) {
	let d = dir(&format!("store-walk-{seed}"));
	let (ts_file, rust_file) = (d.join("ts.sqlite"), d.join("rust.sqlite"));
	let mut w = Walk::new(seed);
	let init = w.init();
	let mut rust = RustSide::open(&rust_file, &init);
	let mut ts_init = init.clone();
	if let Json::Object(o) = &mut ts_init {
		o.insert("file", ts_file.to_str().unwrap().into());
	}
	let mut lines = vec![ts_init];
	let mut answers = vec![Ok(Json::Null)];
	let mut hashes = vec![rust.hash()];
	for _ in 0..steps {
		let rev = rust.host.space.state.stream.as_ref().map_or(0.0, |s| s.rev);
		let line = w.line(rev);
		let r = rust.step(&line);
		observe(&mut w, &line, &r, &rust.host.space, seen);
		hashes.push(rust.hash());
		answers.push(r);
		lines.push(line);
	}
	rust.host.close();
	let mut ts = TsDriver::script("test/support/store-driver.ts");
	let mut all = lines.clone();
	all.push(obj! { "op" => "close" });
	let ts_answers = ts.run(&all);
	for (i, (line, t)) in lines.iter().zip(&ts_answers).enumerate() {
		let want = ts_reply(t);
		let got = reply(&answers[i]);
		let state = t.get("state").and_then(Json::as_str).unwrap_or("");
		if (i == 0 || want == got) && state == hashes[i] {
			continue;
		}
		// post mortem: both states right after the diverging step
		let pm = dir(&format!("store-walk-{seed}-pm"));
		let mut replay: Vec<Json> = lines[..=i].to_vec();
		if let Json::Object(o) = &mut replay[0] {
			o.insert("file", pm.join("ts.sqlite").to_str().unwrap().into());
		}
		if let Json::Object(o) = &mut replay[i] {
			o.insert("dump", Json::Bool(true));
		}
		let mut ts = TsDriver::script("test/support/store-driver.ts");
		let dump = ts.run(&replay).pop().and_then(|r| r.get("dump").cloned()).unwrap_or(Json::Null);
		let mut again = RustSide::open(&pm.join("rust.sqlite"), &lines[0]);
		for l in &lines[1..=i] {
			let _ = again.step(l);
		}
		let mut paths = vec![];
		diff(&again.host.space.state.to_json(), &dump, "state", &mut paths);
		panic!("seed {seed}, step {i}: {}\n  Rust:       {got:?}\n  TypeScript: {want:?}\n  state differs: {}\n  {}", line.to_json_text(), state != hashes[i], paths.join("\n  "));
	}
	let (r, t) = (rows(&rust_file), rows(&ts_file));
	if let Some((a, b)) = r.iter().zip(&t).find(|(a, b)| a != b) {
		panic!("seed {seed}: the files differ\n  Rust:       {a}\n  TypeScript: {b}");
	}
	assert_eq!(r.len(), t.len(), "seed {seed}: row counts");
	*seen.entry("rows compared").or_default() += r.len();
}

#[test]
fn random_walks_agree_with_the_typescript_store() {
	let total: usize = std::env::var("PHI_STORE_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(2_000);
	let mut seen = BTreeMap::new();
	if let Some(seed) = std::env::var("PHI_STORE_WALK_SEED").ok().and_then(|s| s.parse().ok()) {
		walk(seed, total, &mut seen);
		return;
	}
	let per_walk = 400;
	for seed in 0..total.div_ceil(per_walk) as u64 {
		walk(seed, per_walk, &mut seen);
	}
	eprintln!("{seen:#?}");
}

/// Runs `lines` (after an init) through the Rust host, filling in `$gen` and `$key` from its answers, and returns the
/// lines as run.
fn resolved(path: &Path, init: &Json, lines: &[Json]) -> Vec<Json> {
	fn fill(v: &Json, g: &str, k: &str) -> Json {
		match v {
			Json::String(s) if s == "$gen" => g.into(),
			Json::String(s) if s == "$key" => k.into(),
			Json::Array(a) => Json::Array(a.iter().map(|x| fill(x, g, k)).collect()),
			Json::Object(o) => Json::Object(o.iter().map(|(n, x)| (n, fill(x, g, k))).collect()),
			other => other.clone(),
		}
	}
	let mut rust = RustSide::open(path, init);
	let (mut g, mut k) = (String::new(), String::new());
	let out = lines
		.iter()
		.map(|l| {
			let l = fill(l, &g, &k);
			if let Ok(v) = rust.step(&l) {
				if let Some(x) = v.get("generation").and_then(Json::as_str) {
					g = x.to_owned();
				}
				if let Some(x) = v.get("key").and_then(Json::as_str) {
					k = x.to_owned();
				}
			}
			l
		})
		.collect();
	rust.host.close();
	out
}

/// Both hosts over the same lines: the same answers, states and rows.
fn compare(name: &str, init: &Json, lines: &[Json]) {
	let d = dir(name);
	let lines = resolved(&d.join("first.sqlite"), init, lines);
	let mut rust = RustSide::open(&d.join("rust.sqlite"), init);
	let mut ts_init = init.clone();
	if let Json::Object(o) = &mut ts_init {
		o.insert("file", d.join("ts.sqlite").to_str().unwrap().into());
	}
	let mut all = vec![ts_init];
	all.extend(lines.iter().cloned());
	all.push(obj! { "op" => "close" });
	let ts = TsDriver::script("test/support/store-driver.ts").run(&all);
	for (i, l) in lines.iter().enumerate() {
		let got = reply(&rust.step(l));
		let t = &ts[i + 1];
		assert_eq!(got, ts_reply(t), "{name}, line {i}: {}", l.to_json_text());
		assert_eq!(rust.hash(), t.get("state").and_then(Json::as_str).unwrap(), "{name}, line {i}: state");
	}
	rust.host.close();
	assert_eq!(rows(&d.join("rust.sqlite")), rows(&d.join("ts.sqlite")), "{name}: rows");
}

#[test]
fn a_served_wait_with_its_claim_on_the_disk() {
	// The core driver gives the transaction of a served take the key of the `wait` request that parked it (it searches
	// the claims); with the claims on the disk the host does not search them, and the transaction has no such key.
	let init = obj! { "op" => "init", "seed" => "wait", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d" };
	let request = obj! { "principal" => obj! { "peerId" => "p1" }, "generation" => "$gen", "requestId" => "r1" };
	let lines = vec![
		obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } },
		obj! { "op" => "admit", "now" => 1000.0, "request" => request, "method" => "wait", "args" => obj! {} },
		obj! { "op" => "addWaiter", "now" => 1000.0, "w" => obj! { "template" => obj! { "type" => "Task" }, "take" => true, "target" => "a", "timeout" => 5000.0 } },
		obj! { "op" => "decide", "now" => 1000.0, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => "w0a0b0c0d-1" } },
		obj! { "op" => "write", "now" => 1100.0, "entry" => obj! { "type" => "Task", "fields" => obj! {} }, "lease" => 5000.0 },
		obj! { "op" => "stats", "now" => 1100.0 },
	];
	compare("store-served-wait", &init, &lines);
}
