//! The Rust engine against the frozen TypeScript engine (docs/rust-portierung.en.md, R8.2): two space servers in memory
//! (`src/standalone.ts`), the TypeScript engine on one through `spaces-mmo/tests/r8/engine-driver.ts` (imported from the
//! oracle of tests/common), this crate on the other, the same seed and clock; after every step both spaces hold the
//! same entries in the same order (type, types and fields; the ids are the servers' own).
use std::cell::Cell;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use mmo_engine::loader::{load_into_space, LoadOptions};
use mmo_engine::model::world_lock;
use mmo_engine::source::{set_source, Seeded};
use mmo_engine::worker::run_job;
use mmo_engine::space::{Space, FOREVER};
use phi_json::{obj, Json};
use phi_spaces_client::{connect_space, ConnectOptions};

mod common;
use common::{oracle, repo};

struct Kill(Child);
impl Drop for Kill { fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); } }

/// A space server in memory on a unix socket of its own.
fn space_server(dir: &Path, name: &str) -> (Kill, String) {
	let sock = dir.join(format!("{name}.sock"));
	let _ = std::fs::remove_file(&sock);
	let child = Command::new("node").current_dir(repo()).args(["--experimental-strip-types", "--no-warnings", "src/standalone.ts", "--store", "memory", "--listen"]).arg(format!("unix:{}", sock.display()))
		.stdout(Stdio::null()).spawn().expect("node on PATH");
	let t0 = Instant::now();
	while !sock.exists() { assert!(t0.elapsed() < Duration::from_secs(30), "the space server did not start"); std::thread::sleep(Duration::from_millis(50)); }
	(Kill(child), format!("unix:{}", sock.display()))
}

/// The TypeScript engine.
struct Driver { _child: Kill, stdin: ChildStdin, stdout: BufReader<ChildStdout> }

impl Driver {
	fn start(address: &str, seed: u32, clock: f64) -> Self {
		let mut child = Command::new("node").current_dir(repo().join("spaces-mmo")).args(["--experimental-strip-types", "--no-warnings", "tests/r8/engine-driver.ts"]).arg(oracle()).arg(address).arg(seed.to_string()).arg(phi_json::number_text(clock))
			.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("node on PATH");
		let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
		Self { _child: Kill(child), stdin, stdout }
	}
	fn call(&mut self, line: Json) -> Json {
		writeln!(self.stdin, "{}", line.to_json_text()).unwrap();
		let mut text = String::new();
		self.stdout.read_line(&mut text).unwrap();
		assert!(!text.is_empty(), "the TypeScript driver ended");
		phi_json::parse(text.trim()).expect("a JSON line")
	}
}

/// Every entry as the JSON text of [type, types, fields] with sorted keys, in the space's order (the driver's `dump`).
async fn dump(space: &Space) -> Vec<String> {
	let out: Vec<String> = space.read_all(&obj! {}, None).await.expect("readAll").iter().map(|e| {
		let row = Json::Array(vec![e.get("type").cloned().unwrap_or(Json::Null), e.get("types").cloned().unwrap_or(Json::Null), e.get("fields").cloned().unwrap_or(Json::Null)]);
		row.canonical().expect("finite")
	}).collect();
	out
}

fn compare(step: &str, ts: &Json, rust: &[String]) {
	assert_eq!(ts.get("ok"), Some(&Json::Bool(true)), "{step}: TypeScript {}", ts.to_json_text());
	let ts: Vec<String> = ts.get("result").and_then(Json::as_array).expect("a dump").iter().map(|x| x.as_str().unwrap().to_owned()).collect();
	let only = |a: &[String], b: &[String]| -> Vec<String> { let bs: std::collections::HashSet<&String> = b.iter().collect(); a.iter().filter(|x| !bs.contains(x)).take(4).cloned().collect() };
	let (a, b) = (only(&ts, rust), only(rust, &ts));
	assert!(a.is_empty() && b.is_empty() && ts.len() == rust.len(), "{step}: {} entries in TypeScript, {} in Rust\nonly in TypeScript:\n  {}\nonly in Rust:\n  {}", ts.len(), rust.len(), a.join("\n  "), b.join("\n  "));
	// the same order too: what a command finds first (peek, a take of one of several) is the first the space lists
	if let Some(i) = ts.iter().zip(rust).position(|(x, y)| x != y) { panic!("{step}: the same entries in another order, from entry {i}:\n  TypeScript {}\n  Rust       {}", ts[i], rust[i]); }
}

/// One comparison: the two spaces, the TypeScript driver, the Rust engine's space and clock.
struct Walk { _servers: (Kill, Kill), ts: Driver, space: Space, clock: Rc<Cell<f64>>, w: Json, rt: tokio::runtime::Runtime, local: tokio::task::LocalSet }

impl Walk {
	fn new(name: &str, seed: u32, start: f64) -> Self {
		let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("engine-walk-{name}"));
		std::fs::create_dir_all(&dir).unwrap();
		let (a, addr_a) = space_server(&dir, "ts");
		let (b, addr_b) = space_server(&dir, "rust");
		let ts = Driver::start(&addr_a, seed, start);
		let clock = Rc::new(Cell::new(start));
		let c = clock.clone();
		set_source(Some(Rc::new(Seeded::new(seed, move || c.get()))));
		let w = mmo_engine::world::load_world(&oracle().join("spaces-mmo"), "leuchtfeuer").expect("the world");
		let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		let local = tokio::task::LocalSet::new();
		let space = local.block_on(&rt, async {
			let (remote, _t) = connect_space(&addr_b, ConnectOptions::default()).expect("connect");
			let space = Space::new(remote);
			space.write(&world_lock(), None, FOREVER).await.expect("the lock");
			space
		});
		Self { _servers: (a, b), ts, space, clock, w, rt, local }
	}
	fn run<T>(&self, f: impl std::future::Future<Output = T>) -> T { self.local.block_on(&self.rt, f) }
	fn at(&mut self, ms: f64) { self.clock.set(ms); self.ts.call(obj! { "op" => "clock", "at" => ms }); }
	fn compare(&mut self, step: &str) {
		let ts = self.ts.call(obj! { "op" => "dump" });
		let rust = self.run(dump(&self.space));
		compare(step, &ts, &rust);
	}
	fn load(&mut self, replace: bool) {
		let t = self.ts.call(obj! { "op" => "load", "world" => "leuchtfeuer", "replace" => replace });
		let r = self.run(load_into_space(&self.space, &self.w, LoadOptions { replace, txn_ms: None })).expect("the Rust load");
		assert_eq!(t.get("result"), Some(&r.to_json()), "load: the result");
	}
	/// How many entries of the Rust space contain `text` (a walk shows that it did something).
	fn entries_with(&mut self, text: &str) -> usize { self.run(dump(&self.space)).iter().filter(|e| e.contains(text)).count() }
	fn tick(&mut self, job: &str) {
		let t = self.ts.call(obj! { "op" => "tick", "world" => "leuchtfeuer", "job" => job });
		let r = self.run(run_job(&self.space, &self.w, job, 600_000.0));
		assert_eq!(t.get("ok") == Some(&Json::Bool(true)), r.is_ok(), "{job}: TypeScript {}, Rust {:?}", t.to_json_text(), r.err());
	}
}

const START: f64 = 1_794_139_200_000.0; // 2026-11-08 12:00 UTC

#[test]
fn loading_the_world() {
	let mut w = Walk::new("load", 7, START);
	for (i, replace) in [false, false, true].into_iter().enumerate() {
		w.at(START + i as f64 * 60_000.0);
		w.load(replace);
		w.compare(&format!("load {i} (replace {replace})"));
	}
}

#[test]
fn the_weather() {
	let mut w = Walk::new("weather", 11, START);
	w.load(false);
	for round in 0..8 {
		w.at(START + (round + 1) as f64 * 20.0 * 60_000.0);
		for job in ["fire", "fog", "flood"] {
			w.tick(job);
			w.compare(&format!("round {round}, {job}"));
		}
	}
	let (flotsam, fog, washed) = (w.entries_with(r#""flotsam":true"#), w.entries_with("Nebel"), w.entries_with("Die Flut spült"));
	eprintln!("the weather: {flotsam} pieces of flotsam, {fog} fog messages, {washed} tide messages");
	assert!(flotsam > 0 && fog > 0 && washed > 0, "the walk did nothing");
}
