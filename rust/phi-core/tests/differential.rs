// R1, slice 1 (docs/rust-portierung.md): random walks over entries, leases, expiry, the change stream and the commit
// budget, each line run by the Rust core and by the TypeScript one (test/support/core-driver.ts), answer for answer and
// state hash for state hash. Each walk has a seed of its own and small limits drawn from it, so the refusals, the deferred
// expiry and the dropped log batches are reached, not only the paths a default space takes; the test counts which
// outcomes occurred and fails when one never did.
//
// Steps: PHI_CORE_WALK_STEPS (all walks together, default 12 000); one walk: PHI_CORE_WALK_SEED.
// A seeded walk stands in for the proptest run of the acceptance (10⁶ steps) until that is set up.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{digest_json, obj, Json, Object, FOREVER};
use std::collections::BTreeMap;

/// splitmix64: a reproducible stream from the walk's seed.
struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
		let mut z = self.0;
		z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
		z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
		z ^ (z >> 31)
	}
	fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
	fn chance(&mut self, p: f64) -> bool { ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p }
	fn pick<T: Clone>(&mut self, xs: &[T]) -> T { xs[self.below(xs.len())].clone() }
}

/// One walk: the clock, the ids it has seen and the cursors it may continue from.
struct Walk {
	rng: Rng,
	now: f64,
	ids: Vec<String>,
	page_next: Option<Json>,
}

const TYPES: [&str; 3] = ["Task", "Job", "Note"];

impl Walk {
	fn init(&mut self) -> Json {
		let r = &mut self.rng;
		let mut limits = Object::new();
		// each limit small with some probability, so every walk mixes a few of them
		let mut small = |k: &str, v: f64, p: f64, r: &mut Rng| {
			if r.chance(p) {
				limits.insert(k, Json::Number(v));
			}
		};
		let v = 1300.0 + r.below(1500) as f64;
		small("maxCommitBytes", v, 0.4, r);
		let v = 250.0 + r.below(3000) as f64;
		small("maxLogBytes", v, 0.4, r);
		let v = 150.0 + r.below(400) as f64;
		small("maxEntryBytes", v, 0.2, r);
		let v = 800.0 + r.below(3000) as f64;
		small("maxSpaceBytes", v, 0.2, r);
		let v = 1500.0 + r.below(6000) as f64;
		small("maxDocBytes", v, 0.15, r);
		let v = 2.0 + r.below(8) as f64;
		small("maxEntries", v, 0.2, r);
		let v = 1.0 + r.below(4) as f64;
		small("maxEntriesPerOwner", v, 0.2, r);
		let v = 3.0 + r.below(6) as f64;
		small("maxTypeChars", v, 0.2, r);
		let v = 1.0 + r.below(3) as f64;
		small("maxTypes", v, 0.2, r);
		let v = 200.0 + r.below(1500) as f64;
		small("maxFrameBytes", v, 0.3, r);
		small("maxOutboxBytes", 1.0, 0.03, r);
		let v = 200.0 + r.below(400) as f64;
		small("maxJobBytes", v, 0.05, r);
		let mut line = obj! { "op" => "init", "seed" => "walk", "now" => self.now };
		let Json::Object(o) = &mut line else { unreachable!() };
		if !limits.is_empty() {
			o.insert("limits", Json::Object(limits));
		}
		match r.below(4) {
			0 => {}
			1 => o.insert("spaceId", "sp-1".into()),
			2 => o.insert("spaceId", "".into()),
			_ => {
				o.insert("spaceId", "sp-2".into());
				o.insert("incarnation", "0a0b0c0d".into());
			}
		}
		if r.chance(0.5) {
			o.insert("incarnation", "f00d".into());
		}
		line
	}

	fn fields(&mut self) -> Json {
		let r = &mut self.rng;
		let mut f = Object::new();
		if r.chance(0.8) {
			f.insert("n", Json::Number(r.below(4) as f64));
		}
		if r.chance(0.4) {
			f.insert("s", r.pick(&["a", "ä", "x y", "", "\u{1F600}"]).into());
		}
		if r.chance(0.2) {
			f.insert("z", Json::Array(vec![Json::Number(1.5), Json::Null]));
		}
		if r.chance(0.2) {
			f.insert("o", obj! { "k" => r.below(2) as f64, "l" => "m" });
		}
		if r.chance(0.08) {
			f.insert("big", "x".repeat(r.below(2500)).into());
		}
		Json::Object(f)
	}
	fn type_(&mut self) -> Json {
		let r = &mut self.rng;
		match r.below(40) {
			0 => "Capability".into(),
			1 => "T".repeat(1 + r.below(12)).into(),
			// UTF-16 length is not bytes, nor chars: ä is one unit and two bytes, 😀 two units and one char
			4 => "ä😀".repeat(1 + r.below(4)).into(),
			2 => "".into(),
			3 => Json::Number(5.0),
			_ => r.pick(&TYPES).into(),
		}
	}
	fn entry(&mut self) -> Json {
		let mut e = Object::new();
		e.insert("type", self.type_());
		let r = &mut self.rng;
		match r.below(12) {
			0 => e.insert("types", Json::Array(vec!["Job".into()])),
			1 => e.insert("types", Json::Array(vec!["Task".into(), "Job".into()])),
			2 => e.insert("types", Json::Array(["A", "B", "C", "D"].map(Json::from).to_vec())),
			3 => e.insert("types", Json::Array(vec!["LongSupertypeName".into()])),
			5 => e.insert("types", Json::Array(vec!["😀😀ä".into()])),
			4 => e.insert("types", Json::Null),
			_ => {}
		}
		match r.below(40) {
			0 => {}
			1 => e.insert("fields", Json::Array(vec![])),
			2 => e.insert("fields", "text".into()),
			_ => {
				let f = self.fields();
				e.insert("fields", f);
			}
		}
		Json::Object(e)
	}
	/// A lease or renewal: on the step grid (so `expires == now` happens), the special values and bad ones.
	fn lease(&mut self) -> Option<Json> {
		let r = &mut self.rng;
		Some(match r.below(16) {
			0 => return None,
			1 => Json::Number(-1.0),
			2 => Json::Number(0.0),
			3 => Json::Number(FOREVER),
			4 => Json::Number(FOREVER - 1.0),
			5 => Json::Number(1e300),
			6 => Json::Number(-5.0),
			7 => "x".into(),
			8 => Json::Null,
			9 => Json::Number(3_600_000.0),
			_ => Json::Number(100.0 * (1 + r.below(10)) as f64),
		})
	}
	fn as_(&mut self) -> Option<Json> {
		let r = &mut self.rng;
		// conversation ids are numbers in pi-durable: 1 and "1" are different owners
		match r.below(5) {
			0 => None,
			1 => Some("a".into()),
			2 => Some("b".into()),
			3 => Some(Json::Number(1.0)),
			_ => Some("1".into()),
		}
	}
	fn id(&mut self) -> Json {
		let r = &mut self.rng;
		if self.ids.is_empty() || r.chance(0.1) {
			return r.pick(&["e999", "e0a0b0c0d-999", "nope"]).into();
		}
		let i = self.ids.len() - 1 - r.below(self.ids.len().min(8)); // mostly recent ones
		self.ids[i].as_str().into()
	}
	fn template(&mut self) -> Option<Json> {
		let r = &mut self.rng;
		Some(match r.below(9) {
			0 => return None,
			1 => Json::Null,
			2 => obj! { "type" => r.pick(&TYPES) },
			3 => obj! { "fields" => obj! { "n" => r.below(4) as f64 } },
			4 => obj! { "type" => "Job", "fields" => obj! { "n" => Json::Null } },
			5 => obj! { "fields" => obj! { "o" => obj! { "l" => "m", "k" => r.below(2) as f64 } } },
			6 => obj! { "fields" => obj! { "z" => Json::Array(vec![Json::Number(1.5), Json::Null]) } },
			7 => {
				let id = self.id();
				obj! { "id" => id }
			}
			_ => obj! { "type" => r.pick(&TYPES), "fields" => obj! { "s" => "a" } },
		})
	}

	fn line(&mut self, rev: f64) -> Json {
		self.now += self.rng.pick(&[0.0, 0.0, 100.0, 100.0, 200.0, 500.0, 1000.0, 3_600_000.0]);
		let mut o = Object::new();
		let mut set = |k: &str, v: Option<Json>| {
			if let Some(v) = v {
				o.insert(k, v);
			}
		};
		let op = match self.rng.below(100) {
			0..=29 => {
				set("entry", Some(self.entry()));
				set("lease", self.lease());
				set("as", self.as_());
				if self.rng.chance(0.03) {
					set("txn", Some("t-bogus".into()));
				}
				"write"
			}
			30..=34 => {
				set("entry", Some(self.entry()));
				set("as", self.as_());
				"announce"
			}
			35..=49 => {
				set("tmpl", self.template());
				set("take", Some(Json::Bool(self.rng.chance(0.5))));
				set("as", self.as_());
				if self.rng.chance(0.03) {
					set("txn", Some("t-bogus".into()));
				}
				"probe"
			}
			50..=53 => {
				set("tmpl", self.template());
				"count"
			}
			54..=58 => {
				set("tmpl", self.template());
				let limit = match self.rng.below(5) {
					0 => Some(Json::Number(1.0)),
					1 => Some(Json::Number(2.0)),
					2 => Some(Json::Number(0.0)),
					_ => None,
				};
				set("limit", limit);
				"list"
			}
			59..=66 => {
				set("tmpl", self.template());
				let mut p = Object::new();
				match self.rng.below(5) {
					0 => p.insert("maxBytes", Json::Number(150.0 + self.rng.below(600) as f64)),
					1 => p.insert("maxBytes", Json::Number(0.0)),
					_ => {}
				}
				match self.rng.below(5) {
					0 | 1 => {
						if let Some(n) = self.page_next.clone() {
							p.insert("after", n);
						}
					}
					2 => p.insert("after", "abc".into()),
					3 => p.insert("after", Json::Number(2.0)),
					_ => {}
				}
				set("o", Some(Json::Object(p)));
				"listPage"
			}
			67..=74 => {
				set("id", Some(self.id()));
				set("ms", self.lease());
				set("as", self.as_());
				"renew"
			}
			75..=79 => {
				set("id", Some(self.id()));
				set("as", self.as_());
				"cancel"
			}
			80..=84 => "settle",
			85..=88 => "nextExpiry",
			89..=91 => "stats",
			92..=98 => {
				let after = match self.rng.below(6) {
					0 => Json::Number(rev + 1.0),
					1 => Json::Number(-1.0),
					2 => Json::Number(0.0),
					_ => Json::Number((rev - self.rng.below(4) as f64).max(0.0)),
				};
				set("afterRev", Some(after));
				if self.rng.chance(0.4) {
					set("o", Some(obj! { "maxBytes" => (60 + self.rng.below(800)) as f64 }));
				}
				"changes"
			}
			_ => "revision",
		};
		o.insert("op", op.into());
		o.insert("now", Json::Number(self.now));
		Json::Object(o)
	}
}

/// The driver's answer for a Rust result.
fn reply(r: &Result<Json, phi_core::CoreError>) -> (bool, String) {
	match r {
		Ok(v) => (true, v.canonical().unwrap()),
		Err(e) => (false, format!("{}: {}", e.class, e.message)),
	}
}
fn ts_reply(r: &Json) -> (bool, String) {
	if r.get("ok") == Some(&Json::Bool(true)) {
		(true, r.get("result").unwrap().canonical().unwrap())
	} else {
		(false, format!("{}: {}", r.get("error").and_then(Json::as_str).unwrap_or("?"), r.get("message").and_then(Json::as_str).unwrap_or("")))
	}
}

/// Paths where two JSON values differ (the first few).
fn diff(a: &Json, b: &Json, path: &str, out: &mut Vec<String>) {
	if out.len() >= 12 {
		return;
	}
	match (a, b) {
		(Json::Object(x), Json::Object(y)) => {
			for (k, v) in x.iter() {
				match y.get(k) {
					Some(w) => diff(v, w, &format!("{path}.{k}"), out),
					None => out.push(format!("{path}.{k}: only in Rust ({})", v.to_json_text())),
				}
			}
			for (k, w) in y.iter() {
				if !x.contains_key(k) {
					out.push(format!("{path}.{k}: only in TypeScript ({})", w.to_json_text()));
				}
			}
		}
		(Json::Array(x), Json::Array(y)) if x.len() == y.len() => {
			for (i, (v, w)) in x.iter().zip(y).enumerate() {
				diff(v, w, &format!("{path}[{i}]"), out);
			}
		}
		_ => {
			if a.canonical().unwrap() != b.canonical().unwrap() {
				out.push(format!("{path}: Rust {} / TypeScript {}", a.to_json_text(), b.to_json_text()));
			}
		}
	}
}

/// Runs one walk; counts what happened into `seen`.
fn walk(seed: u64, steps: usize, seen: &mut BTreeMap<&'static str, usize>) {
	let mut w = Walk { rng: Rng(seed), now: 1000.0, ids: vec![], page_next: None };
	let mut rust = Driver::new();
	let mut lines = vec![w.init()];
	let mut answers = vec![rust.step(&lines[0])];
	let mut hashes = vec![digest_json(&rust.space.state.to_json()).unwrap()];
	let note = |k: &'static str, seen: &mut BTreeMap<&'static str, usize>| *seen.entry(k).or_default() += 1;
	for _ in 0..steps {
		let rev = rust.space.state.stream.as_ref().map_or(0.0, |s| s.rev);
		let line = w.line(rev);
		let r = rust.step(&line);
		let op = line.get("op").and_then(Json::as_str).unwrap().to_owned();
		match &r {
			Ok(v) => {
				note("ok", seen);
				if let Some(id) = v.get("id").and_then(Json::as_str) {
					w.ids.push(id.to_owned());
				}
				if op == "write" && v.get("expires").and_then(Json::as_f64) == Some(w.now) {
					note("write with a lease of 0", seen);
				}
				if op == "probe" && v.get("status").and_then(Json::as_str) == Some("found") {
					note(if line.get("take") == Some(&Json::Bool(true)) { "probe took" } else { "probe read" }, seen);
				}
				if op == "nextExpiry" && v.is_null() {
					note("nextExpiry null", seen);
				}
				if op == "listPage" {
					w.page_next = v.get("next").cloned().filter(|n| !n.is_null());
					if w.page_next.is_some() {
						note("page with a next", seen);
					}
				}
				if op == "changes" && v.get("more") == Some(&Json::Bool(true)) {
					note("changes with more", seen);
				}
			}
			Err(e) => {
				assert_ne!(e.class, "NotPorted", "seed {seed}: the walk made a line the Rust core does not port: {}", line.to_json_text());
				note(Box::leak(format!("{op} {}", e.class).into_boxed_str()), seen);
			}
		}
		let s = &rust.space.state;
		if s.rest.contains_key("maintenance") {
			note("expiry deferred", seen);
		}
		if let Some(st) = &s.stream {
			if st.floor > 0.0 {
				note("log dropped batches", seen);
			}
			if st.log.len() == 1 && st.bytes > rust.space.limits().max_log_bytes {
				note("one batch over maxLogBytes", seen);
			}
		}
		hashes.push(digest_json(&s.to_json()).unwrap());
		answers.push(r);
		lines.push(line);
	}
	let mut ts = TsDriver::start();
	let ts_answers = ts.run(&lines);
	for (i, (line, t)) in lines.iter().zip(&ts_answers).enumerate() {
		let want = ts_reply(t);
		let got = reply(&answers[i]);
		let state = t.get("state").and_then(Json::as_str).unwrap();
		if want == got && state == hashes[i] {
			continue;
		}
		// post mortem: both states right after the diverging step
		let mut ts = TsDriver::start();
		ts.run(&lines[..=i]);
		let dump = ts.step(&obj! { "op" => "revision", "dump" => true });
		let mut rust = Driver::new();
		for l in &lines[..=i] {
			let _ = rust.step(l);
		}
		let mut paths = vec![];
		diff(&rust.space.state.to_json(), dump.get("dump").unwrap(), "state", &mut paths);
		panic!(
			"seed {seed}, step {i}: {}\n  Rust:       {got:?}\n  TypeScript: {want:?}\n  state differs: {}\n  {}",
			line.to_json_text(),
			state != hashes[i],
			paths.join("\n  ")
		);
	}
}

#[test]
fn random_walks_agree_with_the_typescript_core() {
	let total: usize = std::env::var("PHI_CORE_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(12_000);
	let mut seen = BTreeMap::new();
	if let Some(seed) = std::env::var("PHI_CORE_WALK_SEED").ok().and_then(|s| s.parse().ok()) {
		walk(seed, total, &mut seen);
		return;
	}
	let per_walk = 400;
	let walks = total.div_ceil(per_walk);
	for seed in 0..walks as u64 {
		walk(seed, per_walk, &mut seen);
	}
	eprintln!("{seen:#?}");
	if total < 12_000 {
		return; // too short to reach every outcome
	}
	for k in [
		"write ResourceExhausted",
		"write LimitError",
		"write IllegalArgumentError",
		"write PermissionError",
		"write TransactionError",
		"write with a lease of 0",
		"expiry deferred",
		"log dropped batches",
		"one batch over maxLogBytes",
		"nextExpiry null",
		"probe took",
		"probe read",
		"probe TransactionError",
		"renew UnknownLeaseError",
		"renew PermissionError",
		"renew IllegalArgumentError",
		"cancel PermissionError",
		"listPage ResponseBudgetTooSmall",
		"listPage IllegalArgumentError",
		"page with a next",
		"list IllegalArgumentError",
		"changes RevisionAhead",
		"changes SnapshotExpired",
		"changes IllegalArgumentError",
		"changes ResponseBudgetTooSmall",
		"changes with more",
		"announce LimitError",
	] {
		assert!(seen.contains_key(k), "no walk reached {k:?}; seen: {seen:#?}");
	}
}
