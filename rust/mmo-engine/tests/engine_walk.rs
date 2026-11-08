//! The Rust engine against the frozen TypeScript engine (docs/rust-portierung.en.md, R8.2): two space servers in memory
//! (`src/standalone.ts`), the TypeScript engine on one through `spaces-mmo/tests/r8/engine-driver.ts` (imported from the
//! oracle, `MMO_ORACLE`, default the worktree `../phi-oracle-2698bad`), this crate on the other, the same seed and clock;
//! after every step both spaces hold the same entries (type, types and fields; the ids are the servers' own).
use std::cell::Cell;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use mmo_engine::loader::{load_into_space, LoadOptions};
use mmo_engine::model::world_lock;
use mmo_engine::source::{set_source, Seeded};
use mmo_engine::space::{Space, FOREVER};
use phi_json::{obj, Json};
use phi_spaces_client::{connect_space, ConnectOptions};

fn repo() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("the checkout") }
fn oracle() -> PathBuf {
	let o = std::env::var("MMO_ORACLE").map(PathBuf::from).unwrap_or_else(|_| repo().join("../phi-oracle-2698bad"));
	assert!(o.join("spaces-mmo/server/engine").is_dir(), "no oracle at {} (git worktree add --detach ../phi-oracle-2698bad 2698bad, or MMO_ORACLE)", o.display());
	o
}

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

/// Every entry as the JSON text of [type, types, fields] with sorted keys, the list sorted (the driver's `dump`).
async fn dump(space: &Space) -> Vec<String> {
	let mut out: Vec<String> = space.read_all(&obj! {}, None).await.expect("readAll").iter().map(|e| {
		let row = Json::Array(vec![e.get("type").cloned().unwrap_or(Json::Null), e.get("types").cloned().unwrap_or(Json::Null), e.get("fields").cloned().unwrap_or(Json::Null)]);
		row.canonical().expect("finite")
	}).collect();
	out.sort_by(|a, b| phi_json::utf16_cmp(a, b));
	out
}

fn compare(step: &str, ts: &Json, rust: &[String]) {
	assert_eq!(ts.get("ok"), Some(&Json::Bool(true)), "{step}: TypeScript {}", ts.to_json_text());
	let ts: Vec<String> = ts.get("result").and_then(Json::as_array).expect("a dump").iter().map(|x| x.as_str().unwrap().to_owned()).collect();
	let only = |a: &[String], b: &[String]| -> Vec<String> { let bs: std::collections::HashSet<&String> = b.iter().collect(); a.iter().filter(|x| !bs.contains(x)).take(4).cloned().collect() };
	let (a, b) = (only(&ts, rust), only(rust, &ts));
	assert!(a.is_empty() && b.is_empty() && ts.len() == rust.len(), "{step}: {} entries in TypeScript, {} in Rust\nonly in TypeScript:\n  {}\nonly in Rust:\n  {}", ts.len(), rust.len(), a.join("\n  "), b.join("\n  "));
}

#[test]
fn loading_the_world() {
	let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join("engine-walk-load");
	std::fs::create_dir_all(&dir).unwrap();
	let (_a, addr_a) = space_server(&dir, "ts");
	let (_b, addr_b) = space_server(&dir, "rust");
	let (seed, start) = (7u32, 1_794_139_200_000.0); // 2026-11-08 12:00 UTC
	let mut ts = Driver::start(&addr_a, seed, start);
	let clock = Rc::new(Cell::new(start));
	let c = clock.clone();
	set_source(Some(Rc::new(Seeded::new(seed, move || c.get()))));
	let w = mmo_engine::world::load_world(&oracle().join("spaces-mmo"), "leuchtfeuer").expect("the world");
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	tokio::task::LocalSet::new().block_on(&rt, async {
		let (remote, _t) = connect_space(&addr_b, ConnectOptions::default()).expect("connect");
		let space = Space::new(remote);
		space.write(&world_lock(), None, FOREVER).await.expect("the lock");
		for (i, replace) in [false, false, true].into_iter().enumerate() {
			clock.set(start + i as f64 * 60_000.0);
			ts.call(obj! { "op" => "clock", "at" => clock.get() });
			let t = ts.call(obj! { "op" => "load", "world" => "leuchtfeuer", "replace" => replace });
			let r = load_into_space(&space, &w, LoadOptions { replace, txn_ms: None }).await.expect("the Rust load");
			assert_eq!(t.get("result"), Some(&r.to_json()), "load {i}: the result");
			compare(&format!("load {i} (replace {replace})"), &ts.call(obj! { "op" => "dump" }), &dump(&space).await);
		}
	});
}
