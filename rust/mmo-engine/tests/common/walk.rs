//! The walk both engines take (docs/rust-portierung.en.md, R8.2): two space servers in memory (`src/standalone.ts`), the
//! TypeScript engine on one through `spaces-mmo/tests/r8/engine-driver.ts` (imported from the oracle of tests/common), this
//! crate on the other, the same seed and clock; after every step both spaces hold the same entries in the same order.
//! A test file takes it with `#[path = "common/walk.rs"] mod walk;` (after `mod common;`).
#![allow(dead_code)]
use std::cell::Cell;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::rc::Rc;
use std::time::{Duration, Instant};

use mmo_engine::loader::{load_into_space, LoadOptions};
use mmo_engine::model::world_lock;
use mmo_engine::source::{set_source, Seeded};
use mmo_engine::execute::Worker;
use mmo_engine::worker::run_job;
use mmo_engine::space::{Space, FOREVER};
use phi_json::{obj, Json};
use phi_spaces_client::{connect_space, ConnectOptions};

use crate::common::{oracle, repo};

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

/// The TypeScript engine. Its V8 coverage goes to target/tmp/coverage/<walk> (`spaces-mmo/tests/r8/uncovered.ts` lists
/// what no walk reached); dropped, it is let end by itself first, so that the coverage is written.
struct Driver { child: Option<Child>, stdin: Option<ChildStdin>, stdout: BufReader<ChildStdout> }

impl Drop for Driver {
	fn drop(&mut self) {
		drop(self.stdin.take());
		let Some(mut child) = self.child.take() else { return };
		let t0 = Instant::now();
		while t0.elapsed() < Duration::from_secs(10) { if let Ok(Some(_)) = child.try_wait() { return; } std::thread::sleep(Duration::from_millis(20)); }
		let _ = child.kill();
		let _ = child.wait();
	}
}

impl Driver {
	fn start(name: &str, address: &str, seed: u32, clock: f64) -> Self {
		let coverage = Path::new(env!("CARGO_TARGET_TMPDIR")).join("coverage").join(name);
		let _ = std::fs::remove_dir_all(&coverage);
		let mut child = Command::new("node").env("NODE_V8_COVERAGE", &coverage).current_dir(repo().join("spaces-mmo")).args(["--experimental-strip-types", "--no-warnings", "tests/r8/engine-driver.ts"]).arg(oracle()).arg(address).arg(seed.to_string()).arg(phi_json::number_text(clock))
			.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().expect("node on PATH");
		let (stdin, stdout) = (child.stdin.take().unwrap(), BufReader::new(child.stdout.take().unwrap()));
		Self { child: Some(child), stdin: Some(stdin), stdout }
	}
	fn call(&mut self, line: Json) -> Json {
		writeln!(self.stdin.as_mut().unwrap(), "{}", line.to_json_text()).unwrap();
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
pub struct Walk { ts: Driver, _servers: (Kill, Kill), pub space: Space, pub clock: Rc<Cell<f64>>, pub w: Json, rt: tokio::runtime::Runtime, local: tokio::task::LocalSet, intents: usize, mirror: Option<Rc<mmo_engine::mirror::Mirror>> }

impl Walk {
	pub fn new(name: &str, seed: u32, start: f64) -> Self {
		let dir = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("engine-walk-{name}"));
		std::fs::create_dir_all(&dir).unwrap();
		let (a, addr_a) = space_server(&dir, "ts");
		let (b, addr_b) = space_server(&dir, "rust");
		let ts = Driver::start(name, &addr_a, seed, start);
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
		// the copy the commands read their snapshot from, as the driver's (R8_SERVE: mirror by default, as in production)
		let mirror = matches!(std::env::var("R8_SERVE").as_deref(), Err(_) | Ok("mirror")).then(|| Rc::new(mmo_engine::mirror::Mirror::new(space.remote().clone())));
		if let Some(m) = &mirror { local.block_on(&rt, m.fresh()).expect("the first copy"); }
		Self { ts, _servers: (a, b), space, clock, w, rt, local, intents: 0, mirror }
	}
	pub fn run<T>(&self, f: impl std::future::Future<Output = T>) -> T { self.local.block_on(&self.rt, f) }
	pub fn at(&mut self, ms: f64) { self.clock.set(ms); self.ts.call(obj! { "op" => "clock", "at" => ms }); }
	pub fn compare(&mut self, step: &str) {
		let ts = self.ts.call(obj! { "op" => "dump" });
		let rust = self.run(dump(&self.space));
		compare(step, &ts, &rust);
	}
	pub fn load(&mut self, replace: bool) {
		let t = self.ts.call(obj! { "op" => "load", "world" => "leuchtfeuer", "replace" => replace });
		let r = self.run(load_into_space(&self.space, &self.w, LoadOptions { replace, txn_ms: None })).expect("the Rust load");
		assert_eq!(t.get("result"), Some(&r.to_json()), "load: the result");
	}
	/// How many entries of the Rust space contain `text` (a walk shows that it did something).
	pub fn entries_with(&mut self, text: &str) -> usize { self.run(dump(&self.space)).iter().filter(|e| e.contains(text)).count() }
	/// An account, its character and token (a Session when `online`), written alike on both sides.
	pub fn player(&mut self, n: usize, room: &str, at: (f64, f64), online: bool) -> String { self.player_as(n, room, at, online, true) }
	pub fn player_as(&mut self, n: usize, room: &str, at: (f64, f64), online: bool, guest: bool) -> String {
		let (account_id, char_id) = (format!("a-walk{n}"), format!("c-walk{n}"));
		let name = if guest { format!("Strandläufer-{}", 1000 + n) } else { format!("Wanderer{n}") };
		let account = obj! { "accountId" => account_id.as_str(), "name" => name.as_str(), "guest" => guest, "admin" => false, "createdAt" => START, "touchedAt" => START };
		let ch = obj! { "charId" => char_id.as_str(), "accountId" => account_id.as_str(), "name" => name.as_str(), "room" => room, "x" => at.0, "y" => at.1, "skin" => (n % 4) as f64, "guest" => guest };
		let session = online.then(|| format!("s-walk{n}"));
		let t = self.ts.call(obj! { "op" => "player", "account" => account.clone(), "char" => ch.clone(), "session" => session.clone().map_or(Json::Null, Json::from) });
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "player: {}", t.to_json_text());
		self.run(async {
			let txn = self.space.create_transaction(10_000.0).await.unwrap();
			mmo_engine::room_growth::pin_terrain(&self.space, &txn).await.unwrap();
			self.space.write(&obj! { "type" => "Account", "fields" => account }, Some(&txn), FOREVER).await.unwrap();
			self.space.write(&obj! { "type" => "Character", "fields" => ch }, Some(&txn), FOREVER).await.unwrap();
			self.space.write(&mmo_engine::model::actor_token(&char_id), Some(&txn), FOREVER).await.unwrap();
			self.space.commit(&txn).await.unwrap();
			if let Some(s) = session { self.space.write(&obj! { "type" => "Session", "fields" => obj! { "sessionId" => s, "charId" => char_id.as_str(), "accountId" => account_id.as_str() } }, None, FOREVER).await.unwrap(); }
		});
		char_id
	}
	/// An entry written alike on both sides (FOREVER).
	pub fn write(&mut self, entry: Json) {
		let t = self.ts.call(obj! { "op" => "write", "entry" => entry.clone() });
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "write: {}", t.to_json_text());
		self.run(self.space.write(&entry, None, FOREVER)).expect("the write");
	}
	/// One entry taken away alike on both sides (whether there was one).
	pub fn take(&mut self, template: Json) -> bool {
		let t = self.ts.call(obj! { "op" => "take", "template" => template.clone() });
		let r = self.run(self.space.take_if_exists(&template, mmo_engine::space::NO_WAIT, None)).expect("the take").is_some();
		assert_eq!(t.get("result"), Some(&Json::Bool(r)), "take: {}", t.to_json_text());
		r
	}
	/// One command line of `char_id` on both sides; what serve said (the same on both).
	pub fn cmd(&mut self, char_id: &str, line: &str, step: Option<Json>) -> String { self.cmd_as(char_id, line, step, None, None) }
	/// `cmd` with what the model process sets: the sentence it translated, the player's language.
	pub fn cmd_as(&mut self, char_id: &str, line: &str, step: Option<Json>, asked: Option<&str>, lang: Option<&str>) -> String {
		self.intents += 1;
		let intent_id = format!("i-{}", self.intents);
		let t = self.ts.call(obj! { "op" => "cmd", "charId" => char_id, "intentId" => intent_id.as_str(), "line" => line, "step" => step.clone().unwrap_or(Json::Null), "asked" => asked.map_or(Json::Null, Json::from), "lang" => lang.map_or(Json::Null, Json::from) });
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "cmd {line}: {}", t.to_json_text());
		let mut f = obj! { "intentId" => intent_id.as_str(), "charId" => char_id, "line" => line, "at" => self.clock.get() };
		if let Some(s) = step { j_set(&mut f, "step", s); }
		if let Some(a) = asked { j_set(&mut f, "asked", Json::from(a)); }
		if let Some(l) = lang { j_set(&mut f, "lang", Json::from(l)); }
		let worker = Worker { space: self.space.clone(), w: Rc::new(self.w.clone()), msg_lease_ms: 600_000.0, txn_ms: 15_000.0, mirror: self.mirror.clone() };
		let r = self.run(async {
			self.space.write(&obj! { "type" => "Intent", "fields" => f }, None, 30_000.0).await.expect("the intent");
			worker.serve(char_id).await
		}).unwrap_or_else(|e| format!("failed: {e}"));
		let ts = t.get("result").and_then(Json::as_str).unwrap_or("").to_owned();
		assert_eq!(ts, r, "{line}: what serve said");
		r
	}
	/// Where a character stands in the Rust space.
	pub fn where_is(&mut self, char_id: &str) -> (String, f64, f64) {
		let e = self.run(self.space.peek(&obj! { "type" => "Character", "fields" => obj! { "charId" => char_id } }, None)).unwrap().expect("the character");
		let f = e.get("fields").unwrap();
		(f.get("room").and_then(Json::as_str).unwrap().to_owned(), f.get("x").and_then(Json::as_f64).unwrap(), f.get("y").and_then(Json::as_f64).unwrap())
	}
	pub fn tick(&mut self, job: &str) {
		let t = self.ts.call(obj! { "op" => "tick", "world" => "leuchtfeuer", "job" => job });
		let r = self.run(run_job(&self.space, &self.w, job, 600_000.0));
		assert_eq!(t.get("ok") == Some(&Json::Bool(true)), r.is_ok(), "{job}: TypeScript {}, Rust {:?}", t.to_json_text(), r.err());
	}
}

pub fn j_set(v: &mut Json, k: &str, x: Json) { if let Json::Object(o) = v { o.insert(k, x); } }

/// A small generator of its own for the walk's choices (not the engine's source).
pub struct Dice(pub u64);
impl Dice { pub fn next(&mut self, n: u64) -> u64 { self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (self.0 >> 33) % n } }

pub const START: f64 = 1_794_139_200_000.0; // 2026-11-08 12:00 UTC

