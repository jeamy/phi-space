// R6b step 5: the merge types of a Space with entry replication on the wire (`SpaceService.mergeCall`). The service
// driver runs with an EntryReplicationController on its store (`merge` on init), the Rust service with
// phi_service::Merge on the same configuration; seeded random calls write, read, count, take and wait on the lww type
// Sensor and the set type Tag and on a plain type beside them, renew and cancel the leases of merged entries, retry
// and reuse request IDs, and try what a merge type does not take (a transaction, supertypes, batch, other roles). Every
// reply agrees byte for byte, and the Space's state by its hash.
//
//   PHI_MERGE_WALK_STEPS (default 2000), PHI_MERGE_WALK_SEED (default 1).
mod common;
use common::{RustSide, Setup, TsService};
use phi_core::driver::seeded;
use phi_json::{obj, parse, Json};
use phi_service::entry::{EntryOptions, EntryReplication};
use phi_service::Merge;
use std::collections::BTreeMap;
use std::rc::Rc;

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: usize) -> usize { (self.next() % n as u64) as usize }
	fn chance(&mut self, p: f64) -> bool { ((self.next() >> 11) as f64 / (1u64 << 53) as f64) < p }
	fn pick<T: Clone>(&mut self, xs: &[T]) -> T { xs[self.below(xs.len())].clone() }
}

fn merge(side: &RustSide) -> Merge {
	let clock = side.clock.clone();
	let config = obj! {
		"spaceId" => "board", "authorityId" => "local", "replicaId" => "a", "incarnation" => "i-a",
		"members" => vec![obj! { "replicaId" => "a", "incarnation" => "i-a" }, obj! { "replicaId" => "b", "incarnation" => "i-b" }],
		"rules" => vec![obj! { "type" => "Sensor", "variant" => "lww", "keyFields" => vec![Json::from("sensorId")] }, obj! { "type" => "Tag", "variant" => "set" }],
	};
	let controller = EntryReplication::new(EntryOptions { config, space: None, check: Rc::new(|_| Ok(())), now: Rc::new(move || clock.get()), clock_uncertainty_ms: Rc::new(|| 0.0), random: seeded("merge"), max_history_bytes: None, max_batch_bytes: None, request_retention_ms: None }).unwrap();
	Merge { controller, alias: "default".into(), space_id: "no-such-space".into() }
}

struct Walk {
	rng: Rng,
	serial: usize,
	ids: Vec<String>,
	requests: Vec<(String, Json, Json)>,
	generations: BTreeMap<String, String>,
}
impl Walk {
	fn fields(&mut self, t: &str) -> Json {
		match t {
			"Sensor" => obj! { "sensorId" => self.rng.pick(&["s1", "s2", "s3"]), "v" => self.rng.below(5) as f64 },
			"Tag" => obj! { "tag" => self.rng.pick(&["t1", "t2", "t3"]) },
			_ => obj! { "n" => self.rng.below(5) as f64 },
		}
	}
	fn lease(&mut self) -> Option<Json> {
		match self.rng.below(6) {
			0 => Some(Json::from("forever")),
			1 => Some(Json::Null),
			2 => Some(Json::Number(1000.0 + self.rng.below(20_000) as f64)),
			3 if self.rng.chance(0.2) => Some(Json::from("soon")),
			_ => None,
		}
	}
	fn template(&mut self) -> Json {
		let t = self.rng.pick(&["Sensor", "Tag", "Task", "Sensor", "Tag"]);
		let mut o = obj! { "type" => t };
		if self.rng.chance(0.4) {
			let f = match t {
				"Sensor" => obj! { "sensorId" => self.rng.pick(&["s1", "s2"]) },
				"Tag" => obj! { "tag" => self.rng.pick(&["t1", "t2"]) },
				_ => obj! { "n" => 1.0 },
			};
			o.as_object_mut().unwrap().insert("fields", f);
		}
		if self.rng.chance(0.05) {
			return Json::Null;
		}
		o
	}
	/// One call: the peer and its text.
	fn call(&mut self) -> (String, String) {
		let peer = match self.rng.below(12) {
			0 => "watcher",
			1 => "typed",
			2..=3 => "agent",
			_ => "local",
		};
		let method = self.rng.pick(&["write", "write", "write", "read", "readAll", "readAll", "count", "take", "wait", "lease", "lease", "batch"]);
		let mut args = phi_json::Object::new();
		match method {
			"write" => {
				let t = self.rng.pick(&["Sensor", "Tag", "Task"]);
				let mut e = obj! { "type" => t, "fields" => self.fields(t) };
				if self.rng.chance(0.03) {
					e.as_object_mut().unwrap().insert("fields", Json::from("x"));
				}
				if self.rng.chance(0.03) {
					e.as_object_mut().unwrap().insert("types", Json::Array(vec![Json::from("Thing")]));
				}
				args.insert("entry", e);
				if let Some(l) = self.lease() {
					args.insert("leaseMs", l);
				}
				if self.rng.chance(0.03) {
					args.insert("txn", Json::from("t-1"));
				}
			}
			"read" | "readAll" | "count" | "take" | "wait" => {
				let t = self.template();
				// a plain type waits where a merge type is refused: only merge types for a waiting call
				let t = if matches!(method, "wait" | "take") && t.get("type").and_then(Json::as_str).is_none_or(|x| x == "Task") { obj! { "type" => "Tag" } } else { t };
				args.insert("template", t);
				if self.rng.chance(0.03) {
					args.insert("txn", Json::from("t-1"));
				}
				if method == "wait" {
					args.insert("timeoutMs", Json::Number(0.0));
				}
			}
			"lease" => {
				let id = match self.rng.below(8) {
					0 => "[\"x\"]".to_owned(),
					1 => "plain-lease".to_owned(),
					_ => self.ids.get(self.rng.below(self.ids.len().max(1))).cloned().unwrap_or_else(|| "[\"none\"]".into()),
				};
				args.insert("id", Json::String(id));
				args.insert("action", Json::from(self.rng.pick(&["renew", "renew", "cancel", "cancel", "bogus"])));
				if let Some(l) = self.lease() {
					args.insert("ms", l);
				}
			}
			_ => {
				args.insert("ops", Json::Array(vec![obj! { "op" => "write", "entry" => obj! { "type" => "Task", "fields" => obj! {} } }]));
			}
		}
		let mut call = obj! { "method" => method, "args" => Json::Object(args.clone()) };
		let o = call.as_object_mut().unwrap();
		if matches!(method, "write" | "read" | "take" | "wait" | "lease" | "batch") {
			// a request ID again: the same arguments are a retry, other arguments a conflict
			let earlier = self.requests.iter().rev().find(|(p, m, _)| p == peer && m.get("method").and_then(Json::as_str) == Some(method)).cloned();
			let request = match earlier {
				Some((_, c, r)) if self.rng.chance(if method == "lease" { 0.3 } else { 0.08 }) => {
					if self.rng.chance(0.6) {
						o.insert("args", c.get("args").cloned().unwrap());
					}
					r
				}
				_ => {
					self.serial += 1;
					obj! { "generation" => self.generations.get(peer).cloned().unwrap_or_else(|| "g1.0".into()), "requestId" => format!("r{}", self.serial) }
				}
			};
			o.insert("request", request.clone());
			self.requests.push((peer.to_owned(), Json::Object(o.clone()), request));
		}
		match self.rng.below(10) {
			0 => o.insert("space", Json::from("default")),
			1 if self.rng.chance(0.2) => o.insert("space", Json::from("elsewhere")),
			_ => {}
		}
		(peer.to_owned(), call.to_json_text())
	}
	fn learn(&mut self, reply: &str) {
		let Ok(v) = parse(reply) else { return };
		let r = v.get("result");
		let mut add = |id: Option<&str>| {
			if let Some(id) = id.filter(|i| i.starts_with('[')) {
				if !self.ids.iter().any(|x| x == id) {
					self.ids.push(id.to_owned());
				}
			}
		};
		add(r.and_then(|r| r.get("id")).and_then(Json::as_str));
		add(r.and_then(|r| r.get("entry")).and_then(|e| e.get("id")).and_then(Json::as_str));
		for item in r.and_then(|r| r.get("items")).and_then(Json::as_array).into_iter().flatten() {
			add(item.get("id").and_then(Json::as_str));
		}
	}
}

#[test]
fn merge_types_on_the_wire_agree_with_the_typescript_service() {
	let var = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
	let (steps, seed) = (var("PHI_MERGE_WALK_STEPS", 2000) as usize, var("PHI_MERGE_WALK_SEED", 1));
	let mut now = 1_700_000_000_000.0;
	let mut ts = TsService::start();
	ts.step(&obj! { "op" => "init", "seed" => "merge", "now" => now, "merge" => true });
	let mut rust = RustSide::start(&Setup { seed: "merge".into(), now, store: None, limits: None, max_calls: None, max_pending: None, max_peer: None, authorized: false });
	rust.service.merge = Some(merge(&rust));
	let mut w = Walk { rng: Rng(seed.wrapping_mul(0x2545_F491_4F6C_DD1D) | 1), serial: 0, ids: vec![], requests: vec![], generations: BTreeMap::new() };
	let mut seen: BTreeMap<String, usize> = BTreeMap::new();
	// each peer's generation, so that a plain write is admitted beside the merged ones
	for peer in ["local", "agent", "typed", "watcher"] {
		let text = obj! { "method" => "generation", "args" => obj! {} }.to_json_text();
		let t = ts.step(&obj! { "now" => now, "peer" => peer, "text" => text.as_str() });
		let want = t.get("reply").and_then(Json::as_str).unwrap();
		assert_eq!(rust.step(now, peer, &text, None), want);
		if let Some(g) = parse(want).unwrap().get("result").and_then(|r| r.get("generation")).and_then(Json::as_str) {
			w.generations.insert(peer.to_owned(), g.to_owned());
		}
	}
	for step in 0..steps {
		now += w.rng.below(4000) as f64;
		let (peer, text) = w.call();
		let t = ts.step(&obj! { "now" => now, "peer" => peer.as_str(), "text" => text.as_str() });
		let want = t.get("reply").and_then(Json::as_str).unwrap();
		let got = rust.step(now, &peer, &text, None);
		assert_eq!(got, want, "step {step}, peer {peer}: {text}");
		assert_eq!(rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "step {step}: state after {text}");
		let v = parse(want).unwrap();
		let method = parse(&text).unwrap().get("method").and_then(Json::as_str).unwrap().to_owned();
		let outcome = if v.get("ok") == Some(&Json::Bool(true)) { if v.get("result").and_then(|r| r.get("replicated")).is_some() { "replicated" } else { "ok" }.to_owned() } else { v.get("error").and_then(|e| e.get("code")).and_then(Json::as_str).unwrap_or("").to_owned() };
		*seen.entry(format!("{method} {outcome}")).or_default() += 1;
		w.learn(want);
	}
	eprintln!("{seen:#?}");
	let must = ["write replicated", "write ok", "read replicated", "readAll replicated", "count replicated", "take MergeTypeNotExclusive", "wait MergeTypeNotExclusive", "write MergeTypeNotExclusive", "lease replicated", "lease TransactionError", "lease BadRequest", "lease RequestConflict", "batch BadRequest", "write BadRequest", "write PermissionDenied", "write RequestConflict"];
	let missing: Vec<&&str> = must.iter().filter(|k| !seen.contains_key(**k)).collect();
	assert!(missing.is_empty() || steps < 2000, "the walk reached no {missing:?}");
}
