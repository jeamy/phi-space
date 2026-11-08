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
use mmo_engine::execute::Worker;
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
struct Walk { _servers: (Kill, Kill), ts: Driver, space: Space, clock: Rc<Cell<f64>>, w: Json, rt: tokio::runtime::Runtime, local: tokio::task::LocalSet, intents: usize }

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
		Self { _servers: (a, b), ts, space, clock, w, rt, local, intents: 0 }
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
	/// An account, its character and token (a Session when `online`), written alike on both sides.
	fn player(&mut self, n: usize, room: &str, at: (f64, f64), online: bool) -> String { self.player_as(n, room, at, online, true) }
	fn player_as(&mut self, n: usize, room: &str, at: (f64, f64), online: bool, guest: bool) -> String {
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
	/// One command line of `char_id` on both sides; what serve said (the same on both).
	fn cmd(&mut self, char_id: &str, line: &str, step: Option<Json>) -> String {
		self.intents += 1;
		let intent_id = format!("i-{}", self.intents);
		let t = self.ts.call(obj! { "op" => "cmd", "charId" => char_id, "intentId" => intent_id.as_str(), "line" => line, "step" => step.clone().unwrap_or(Json::Null) });
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "cmd {line}: {}", t.to_json_text());
		let mut f = obj! { "intentId" => intent_id.as_str(), "charId" => char_id, "line" => line, "at" => self.clock.get() };
		if let Some(s) = step { j_set(&mut f, "step", s); }
		let worker = Worker { space: self.space.clone(), w: Rc::new(self.w.clone()), msg_lease_ms: 600_000.0, txn_ms: 15_000.0 };
		let r = self.run(async {
			self.space.write(&obj! { "type" => "Intent", "fields" => f }, None, 30_000.0).await.expect("the intent");
			worker.serve(char_id).await
		}).unwrap_or_else(|e| format!("failed: {e}"));
		let ts = t.get("result").and_then(Json::as_str).unwrap_or("").to_owned();
		assert_eq!(ts, r, "{line}: what serve said");
		r
	}
	/// Where a character stands in the Rust space.
	fn where_is(&mut self, char_id: &str) -> (String, f64, f64) {
		let e = self.run(self.space.peek(&obj! { "type" => "Character", "fields" => obj! { "charId" => char_id } }, None)).unwrap().expect("the character");
		let f = e.get("fields").unwrap();
		(f.get("room").and_then(Json::as_str).unwrap().to_owned(), f.get("x").and_then(Json::as_f64).unwrap(), f.get("y").and_then(Json::as_f64).unwrap())
	}
	fn tick(&mut self, job: &str) {
		let t = self.ts.call(obj! { "op" => "tick", "world" => "leuchtfeuer", "job" => job });
		let r = self.run(run_job(&self.space, &self.w, job, 600_000.0));
		assert_eq!(t.get("ok") == Some(&Json::Bool(true)), r.is_ok(), "{job}: TypeScript {}, Rust {:?}", t.to_json_text(), r.err());
	}
}

fn j_set(v: &mut Json, k: &str, x: Json) { if let Json::Object(o) = v { o.insert(k, x); } }

/// A small generator of its own for the walk's choices (not the engine's source).
struct Dice(u64);
impl Dice { fn next(&mut self, n: u64) -> u64 { self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (self.0 >> 33) % n } }

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

/// Walking: a character steps about the world (toward the exits of its room mostly, into walls, onto another one, with
/// and without a page's step number, a few malformed steps), now and then the fog thickens; every step on both sides.
#[test]
fn walking() {
	let mut w = Walk::new("walking", 13, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let b = w.player(2, "graue-bucht", (11.0, 8.0), true);
	w.compare("players");
	let mut dice = Dice(5);
	let (mut said, mut rooms) = (std::collections::BTreeMap::<String, usize>::new(), std::collections::BTreeSet::<String>::new());
	for i in 0..320 {
		w.at(START + i as f64 * 7_000.0);
		if i % 90 == 60 { w.tick("fog"); w.compare(&format!("fog before step {i}")); }
		let (room, x, y) = w.where_is(&a);
		rooms.insert(room.clone());
		let exits: Vec<(f64, f64)> = w.w.get("exits").and_then(Json::as_array).unwrap().iter().filter(|e| e.get("room").and_then(Json::as_str) == Some(room.as_str())).map(|e| (e.get("x").and_then(Json::as_f64).unwrap(), e.get("y").and_then(Json::as_f64).unwrap())).collect();
		let line = match dice.next(20) {
			0 => "step 1 1".to_owned(),
			1 => "step x".to_owned(),
			2 => "step  0   -1".to_owned(),
			n if n < 14 && !exits.is_empty() => {
				// the first cell of the way to one of the room's exits
				let target = exits[(i / 45) % exits.len()];
				let def = w.w.get("rooms").and_then(Json::as_array).unwrap().iter().find(|r| r.get("roomId").and_then(Json::as_str) == Some(room.as_str())).unwrap();
				let ground = mmo_engine::room_growth::rows(def.get("ground").unwrap());
				match mmo_engine::world::find_path(&w.w, &ground, (x, y), target, 200, &|_| false).and_then(|p| p.first().copied()) {
					Some((nx, ny)) => format!("step {} {}", nx - x, ny - y),
					None => "step 1 0".to_owned(),
				}
			}
			_ => ["step 1 0", "step -1 0", "step 0 1", "step 0 -1"][dice.next(4) as usize].to_owned(),
		};
		let step = (dice.next(3) > 0).then(|| obj! { "conn" => "k1", "seq" => i as f64 });
		let who = if dice.next(6) == 0 { &b } else { &a };
		let r = w.cmd(who, &line, step);
		*said.entry(js_cut(&r)).or_default() += 1;
		w.compare(&format!("step {i}: {line} -> {r}"));
	}
	eprintln!("walking: {said:?}, rooms {rooms:?}");
	assert!(rooms.len() > 1, "the walk never left its room");
}

fn js_cut(r: &str) -> String { r.chars().take(70).collect() }

/// The commands of default.ts and what every line goes through (the command sets, the exits as commands, help, the
/// translation rules, the pack): a guest and a registered player look, talk, pick up, put into the fire, drop, give,
/// walk out and back, and type what is not a command.
#[test]
fn talking() {
	let mut w = Walk::new("talking", 17, START);
	w.load(false);
	let a = w.player(1, "graue-bucht", (10.0, 8.0), true);
	let b = w.player_as(2, "graue-bucht", (11.0, 8.0), true, false);
	w.compare("players");
	let script: &[(&str, &str)] = &[
		("a", "look"), ("a", "schau"), ("a", "l leuchtfeuer"), ("a", "look muschel"), ("a", "look ost"), ("a", "look wander"), ("a", "look niemand"), ("a", "schau dich um"),
		("a", "say hallo"), ("a", "'moin"), ("a", ":winkt"), ("a", "emote"), ("a", "say"), ("a", "hallo Wanderer2, wie geht's?"), ("a", "moin"), ("b", "Strandläufer-1001: komm her"),
		("a", "who"), ("a", "wer"), ("a", "wer ist da"), ("a", "help"), ("b", "hilfe"), ("a", "help step"), ("a", "help geh"), ("a", "help gibtsnicht"), ("a", "?"), ("a", "help intro"),
		("a", "inventory"), ("a", "i"), ("a", "was trage ich"),
		("a", "move 5 7"), ("a", "get treibholz"), ("a", "nimm das treibholz auf"), ("a", "get muschel"), ("a", "move 14 5"), ("a", "heb muschel"), ("a", "inventar"),
		("a", "move 9 9"), ("a", "put treibholz in feuer"), ("a", "lege muschel ins feuer"), ("a", "wirf alle hölzer ins feuer"), ("a", "look leuchtfeuer"),
		("a", "drop muschel"), ("a", "get muschel"), ("a", "give muschel an Wanderer2"), ("a", "move 10 9"), ("b", "move 9 8"),
		("b", "move 17 9"), ("b", "get treibholz"), ("b", "move 10 8"), ("b", "give treibholz an Strandläufer-1001"), ("b", "gib Strandläufer-1001 das treibholz"), ("a", "give 2 treibholz an Wanderer2"), ("a", "give 99 treibholz an Wanderer2"), ("a", "give treibholz an niemand"), ("a", "give treibholz"),
		("a", "channel"), ("a", "kanal hafen hallo alle"), ("a", "kanal welt x"), ("a", "kanal hafen"), ("a", "chan HAFEN laut"),
		("a", "tanze"), ("a", "Tanze wild"), ("a", "step"), ("a", "schritt 1 0"), ("a", "move 99 99"), ("a", "move a b"), ("a", "move 1"), ("a", "arrive"),
		("a", "gehe nach osten"), ("a", "look"), ("a", "west"), ("a", "go"), ("a", "go nirgendwo"), ("a", "geh süd"), ("a", "nord"), ("a", "lauf richtung klippenpfad"),
		("b", "inventory"), ("b", "drop treibholz"), ("b", "look treibholz"),
	];
	let mut refused = 0;
	for (i, (who, line)) in script.iter().enumerate() {
		w.at(START + i as f64 * 11_000.0);
		let id = if *who == "a" { a.clone() } else { b.clone() };
		let r = w.cmd(&id, line, None);
		if r.starts_with("refused") { refused += 1; }
		eprintln!("{who}: {line} -> {r}");
		w.compare(&format!("{i}: {who} {line} -> {r}"));
	}
	assert!(refused > 5 && refused < script.len() / 2, "{refused} of {} refused", script.len());
}
