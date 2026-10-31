// R3, slice 2: seeded random calls to both services, valid ones and refused ones, on the same clock and randomness. Each
// reply has to match byte for byte, the state of the default Space by its hash. Odd seeds run on a file (the claims stay
// on the disk), even ones in memory. PHI_SERVICE_WALK_STEPS, PHI_SERVICE_WALK_SEED.
mod common;
use common::{RustSide, Setup, TsService};
use phi_json::{obj, parse, Json, Object};
use std::collections::BTreeMap;

#[derive(Default)]
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

const PEERS: [&str; 4] = ["local", "agent", "watcher", "typed"];
const TYPES: [&str; 4] = ["Task", "Job", "Note", "Evt"];

#[derive(Default)]
struct Walk {
	rng: Rng,
	now: f64,
	generations: BTreeMap<String, String>,
	ids: Vec<String>,
	txns: Vec<String>,
	subs: Vec<String>,
	requests: Vec<(String, Json)>,
	sent: Vec<(String, String)>,
	mailbox: Option<(String, f64)>,
	tokens: Vec<(String, Option<String>)>,
	rev: f64,
	serial: u64,
}

impl Walk {
	fn weird(&mut self) -> Json {
		let r = &mut self.rng;
		r.pick(&[Json::Null, Json::Number(1.0), Json::Number(1.5), Json::Number(-1.0), Json::Number(0.0), "".into(), "x".into(), "forever".into(), Json::Bool(true), Json::Bool(false), Json::Array(vec![]), obj! {}, obj! { "a" => 1.0 }, Json::Array(vec![Json::Number(1.0)])])
	}
	fn fields(&mut self) -> Json {
		let r = &mut self.rng;
		let mut o = Object::new();
		o.insert("n", Json::Number(r.below(4) as f64));
		if r.chance(0.3) {
			o.insert("key", format!("k{}", r.below(3)).into());
		}
		if r.chance(0.2) {
			o.insert("pad", "é😀x".repeat(r.below(120)).into());
		}
		if r.chance(0.1) {
			o.insert("deep", obj! { "a" => Json::Array(vec![1.5.into(), Json::Null, true.into()]), "z" => 1e21 });
		}
		Json::Object(o)
	}
	fn entry(&mut self) -> Json {
		let f = self.fields();
		let r = &mut self.rng;
		let mut e = obj! { "type" => r.pick(&TYPES), "fields" => f };
		if r.chance(0.2) {
			if let Json::Object(o) = &mut e {
				o.insert("types", Json::Array(vec![r.pick(&TYPES).into()]));
			}
		}
		e
	}
	fn template(&mut self) -> Json {
		let r = &mut self.rng;
		match r.below(8) {
			0 => Json::Null,
			1 | 2 => obj! { "type" => r.pick(&TYPES), "fields" => obj! { "n" => r.below(4) as f64 } },
			3 => obj! { "fields" => obj! { "key" => format!("k{}", r.below(3)) } },
			_ => obj! { "type" => r.pick(&TYPES) },
		}
	}
	fn lease(&mut self, o: &mut Object, k: &str) {
		let r = &mut self.rng;
		match r.below(5) {
			0 => {}
			1 => o.insert(k, "forever".into()),
			2 => o.insert(k, Json::Number(r.pick(&[0.0, 50.0, 500.0]))),
			_ => o.insert(k, Json::Number(1000.0 * (1 + r.below(30)) as f64)),
		}
	}
	fn txn(&mut self, o: &mut Object) {
		if !self.txns.is_empty() && self.rng.chance(0.3) {
			let t = self.rng.pick(&self.txns);
			o.insert("txn", t.into());
		}
	}
	fn request(&mut self, peer: &str, method: &str, c: &mut Object) {
		// the id of an earlier call of this peer again: the same arguments are a retry, others a conflict
		if self.rng.chance(0.04) {
			if let Some((_, req)) = self.requests.iter().rev().find(|(p, _)| p == peer) {
				c.insert("request", req.clone());
				return;
			}
		}
		self.serial += 1;
		let gen = self.generations.get(peer).cloned().unwrap_or_else(|| "gnone.0".into());
		let id = format!("r{}", self.serial);
		c.insert("request", obj! { "generation" => gen, "requestId" => id });
		let req = c.get("request").cloned().unwrap();
		if matches!(method, "read" | "take" | "write" | "wait") {
			self.requests.push((peer.to_owned(), req));
		}
	}
	fn target(&mut self, peer: &str) -> Json {
		let mine: Vec<Json> = self.requests.iter().filter(|(p, _)| p == peer).map(|(_, r)| r.clone()).collect();
		if mine.is_empty() || self.rng.chance(0.1) { obj! { "generation" => self.generations.get(peer).cloned().unwrap_or_else(|| "gnone.0".into()), "requestId" => "unknown" } } else { let n = mine.len(); mine[n - 1 - self.rng.below(n.min(4))].clone() }
	}

	/// One call: who makes it and its text.
	fn call(&mut self) -> (String, String, Option<f64>) {
		self.now += self.rng.pick(&[0.0, 0.0, 0.0, 100.0, 100.0, 300.0, 1000.0, 5000.0, 700_000.0]);
		if self.rng.chance(0.006) {
			let (p, t) = self.rng.pick(&self.sent.clone().into_iter().chain([("local".to_owned(), "{}".to_owned())]).collect::<Vec<_>>());
			return (p, t, None); // a repeat, byte for byte
		}
		if self.rng.chance(0.004) {
			let bad = ["", "nonsense", "[]", "null", "1", "{\"method\":1}", "{\"method\":\"nosuch\"}", "{\"method\":\"hello\",\"args\":[]}", "{\"method\":\"write\",\"request\":1}", "{\"method\":\"hello\",\"frame\":1,\"args\":{\"protocol\":1}}", "{\"method\":\"count\",\"space\":\"\"}", "{\"method\":\"count\",\"space\":\"nope\"}", "{\"method\":\"count\",\"space\":\"default\"}"];
			return ("local".into(), self.rng.pick(&bad).to_owned(), None);
		}
		let peer = if self.rng.chance(0.8) { "local".to_owned() } else if self.rng.chance(0.02) { "nobody".to_owned() } else { self.rng.pick(&PEERS).to_owned() };
		let mut a = Object::new();
		let method = match self.rng.below(100) {
			0..=4 => "generation",
			5..=24 => "write",
			25..=34 => "take",
			35..=42 => "read",
			43..=46 => "count",
			47..=52 => "readAll",
			53..=56 => "stats",
			57..=64 => "txn",
			65..=69 => "lease",
			70..=73 => "notify",
			74..=77 => "wait",
			78..=81 => "events",
			82..=84 => "ack",
			85..=88 => "batch",
			89..=91 => "changes",
			92..=93 => "pollOperation",
			94..=95 => "cancelOperation",
			96 => "resolveOperation",
			97 => "spaces",
			98 => "hello",
			_ => "readChain",
		};
		let mut c = Object::new();
		let name = if method == "readChain" { "readAll" } else { method };
		c.insert("method", name.into());
		match method {
			"hello" => a.insert("protocol", Json::Number(if self.rng.chance(0.9) { 1.0 } else { 2.0 })),
			"write" => {
				a.insert("entry", self.entry());
				self.lease(&mut a, "leaseMs");
				self.txn(&mut a);
				let r = &mut self.rng;
				if r.chance(0.1) {
					a.insert("unique", Json::Array(vec![r.pick(&["key", "n", "none"]).into()]));
				}
				if r.chance(0.05) {
					a.insert("transient", Json::Bool(true));
				}
			}
			"take" | "read" => {
				a.insert("template", self.template());
				self.txn(&mut a);
				a.insert("waitMs", Json::Number(0.0));
				let r = &mut self.rng;
				match r.below(4) {
					0 => a.insert("timeoutMs", Json::Number(r.pick(&[0.0, 100.0, 2000.0]))),
					1 => a.insert("ifExists", Json::Bool(true)),
					2 => a.insert("deadline", Json::Number(self.now + r.pick(&[-100.0, 0.0, 1000.0]))),
					_ => {}
				}
			}
			"count" => {
				a.insert("template", self.template());
				self.txn(&mut a);
			}
			"readAll" => {
				a.insert("template", self.template());
				self.txn(&mut a);
				let r = &mut self.rng;
				if r.chance(0.4) {
					a.insert("maxBytes", Json::Number(r.pick(&[1.0, 50.0, 200.0, 700.0, 3000.0])));
				}
				if r.chance(0.3) {
					a.insert("limit", Json::Number((1 + r.below(4)) as f64));
				}
				if !self.tokens.is_empty() && r.chance(0.5) {
					let (t, n) = r.pick(&self.tokens);
					a.insert("token", t.into());
					if let Some(n) = n {
						a.insert("cursor", n.into());
					}
				}
			}
			"readChain" => {
				let r = &mut self.rng;
				let mut q = Object::new();
				if r.chance(0.5) {
					q.insert("head", obj! { "type" => r.pick(&TYPES) });
				}
				if !self.ids.is_empty() && r.chance(0.5) {
					q.insert("cursor", r.pick(&self.ids).into());
				}
				q.insert("nextField", r.pick(&["next", "key"]).into());
				a.insert("chain", Json::Object(q));
				a.insert("template", Json::Null);
			}
			"txn" => {
				let r = &mut self.rng;
				let action = r.pick(&["begin", "begin", "commit", "abort", "status", "nosuch"]);
				a.insert("action", action.into());
				if action == "begin" {
					self.lease(&mut a, "leaseMs");
				} else {
					let t = if self.txns.is_empty() { "t-bogus".to_owned() } else { self.rng.pick(&self.txns) };
					a.insert("id", t.into());
				}
			}
			"lease" => {
				let r = &mut self.rng;
				a.insert("action", r.pick(&["renew", "renew", "cancel", "nosuch"]).into());
				let pool: Vec<String> = self.ids.iter().chain(&self.txns).chain(&self.subs).cloned().collect();
				a.insert("id", if pool.is_empty() { "e-bogus".to_owned() } else { self.rng.pick(&pool) }.into());
				self.lease(&mut a, "ms");
			}
			"notify" | "wait" => {
				a.insert("template", self.template());
				if self.rng.chance(0.3) {
					a.insert("handback", obj! { "tag" => self.serial as f64 });
				}
				if method == "wait" {
					let r = &mut self.rng;
					a.insert("timeoutMs", Json::Number(r.pick(&[0.0, 1000.0, 50_000.0])));
					if r.chance(0.3) {
						a.insert("take", Json::Bool(false));
					}
					if r.chance(0.2) {
						a.insert("txnLeaseMs", Json::Number(5000.0));
					}
				} else {
					self.lease(&mut a, "leaseMs");
				}
			}
			"events" => {
				a.insert("waitMs", Json::Number(0.0));
				let r = &mut self.rng;
				if let Some((e, n)) = &self.mailbox {
					if r.chance(0.5) {
						a.insert("after", Json::Number(*n));
					}
					if r.chance(0.3) {
						a.insert("mailboxEpoch", e.as_str().into());
					}
				}
				if r.chance(0.3) {
					a.insert("maxBytes", Json::Number(r.pick(&[1.0, 80.0, 400.0, 2000.0])));
				}
			}
			"ack" => {
				let (e, n) = self.mailbox.clone().unwrap_or(("mbnone".into(), 0.0));
				a.insert("mailboxEpoch", e.into());
				a.insert("upTo", Json::Number(n + self.rng.pick(&[0.0, 0.0, 1.0])));
			}
			"batch" => {
				let n = 1 + self.rng.below(4);
				let mut ops = vec![];
				if self.rng.chance(0.4) {
					ops.push(obj! { "op" => "begin", "leaseMs" => 5000.0 });
				}
				for _ in 0..n {
					let e = self.entry();
					let t = self.template();
					let r = &mut self.rng;
					let mut s = match r.below(3) {
						0 => obj! { "op" => "write", "entry" => e },
						1 => obj! { "op" => "take", "template" => t },
						_ => obj! { "op" => "read", "template" => t },
					};
					if !ops.is_empty() && r.chance(0.3) {
						if let Json::Object(o) = &mut s {
							o.insert("txn", "$".into());
						}
					}
					ops.push(s);
				}
				if self.rng.chance(0.3) {
					ops.push(obj! { "op" => self.rng.pick(&["commit", "abort"]), "txn" => "$" });
				}
				a.insert("ops", Json::Array(ops));
			}
			"changes" => {
				let r = &mut self.rng;
				a.insert("afterRev", Json::Number(r.pick(&[0.0, (self.rev - 3.0).max(0.0), self.rev, self.rev + 5.0])));
				if r.chance(0.4) {
					a.insert("maxBytes", Json::Number(r.pick(&[1.0, 300.0, 3000.0])));
				}
				if r.chance(0.2) {
					a.insert("streamId", r.pick(&["other", "local:0"]).into());
				}
			}
			"pollOperation" | "cancelOperation" => {
				let t = self.target(&peer);
				a.insert("targetRequest", t);
				if method == "pollOperation" {
					a.insert("waitMs", Json::Number(0.0));
				}
			}
			"resolveOperation" => {
				let t = self.target(&peer);
				a.insert("targetRequest", t);
				a.insert("method", self.rng.pick(&["take", "read", "write"]).into());
				a.insert("argumentHash", self.rng.pick(&["0".repeat(64), "abc".to_owned()]).into());
				a.insert("primaryEpoch", Json::Number(self.rng.pick(&[0.0, 0.0, 1.0])));
			}
			_ => {}
		};
		// a field of the call replaced by something odd, or removed
		if self.rng.chance(0.08) && !a.is_empty() {
			let keys: Vec<String> = a.iter().map(|(k, _)| k.to_owned()).collect();
			let k = self.rng.pick(&keys);
			if k == "waitMs" {
				// never one that waits: the clock stands still between calls
				a.insert(&k, self.rng.pick(&["x".into(), Json::Number(-1.0), Json::Number(1.5)]));
			} else if self.rng.chance(0.3) {
				a.remove(&k);
			} else {
				let w = self.weird();
				a.insert(&k, w);
			}
		}
		c.insert("args", Json::Object(a));
		if matches!(name, "write" | "read" | "take" | "cancelOperation" | "txn" | "lease" | "wait" | "notify" | "ack" | "batch") {
			self.request(&peer, method, &mut c);
			if self.rng.chance(0.03) {
				let w = self.weird();
				c.insert("request", w);
			}
		}
		let r = &mut self.rng;
		match r.below(40) {
			0 => c.insert("frame", obj! { "authorityId" => r.pick(&["local", "other"]) }),
			1 => c.insert("frame", obj! { "primaryEpoch" => r.pick(&[0.0, 1.0, -1.0]) }),
			2 => c.insert("frame", obj! { "claimReceipt" => r.pick(&[Json::Bool(true), Json::Bool(false), "x".into()]) }),
			3 => c.insert("space", r.pick(&["default", "nope"]).into()),
			_ => {}
		}
		let frame = if r.chance(0.03) { Some(r.pick(&[60.0, 200.0, 500.0, 2000.0])) } else { None };
		let text = Json::Object(c).to_json_text();
		if self.sent.len() < 50 || r.chance(0.02) {
			self.sent.push((peer.clone(), text.clone()));
		}
		(peer, text, frame)
	}

	/// What a reply teaches the walk.
	fn learn(&mut self, peer: &str, text: &str, call: &str, seen: &mut BTreeMap<String, usize>) {
		let Ok(reply) = parse(text) else { panic!("not JSON: {text}") };
		let method = parse(call).ok().and_then(|c| c.get("method").and_then(Json::as_str).map(str::to_owned)).unwrap_or_else(|| "garbage".into());
		let key = match reply.get("error") {
			Some(e) => format!("{method} {}", e.get("code").and_then(Json::as_str).unwrap_or("?")),
			None => format!("{method} ok"),
		};
		*seen.entry(key).or_default() += 1;
		let Some(r) = reply.get("result") else { return };
		if let Some(g) = r.get("generation").and_then(Json::as_str) {
			self.generations.insert(peer.to_owned(), g.to_owned());
		}
		if let Some(id) = r.get("id").and_then(Json::as_str) {
			if id.starts_with('t') { self.txns.push(id.to_owned()) } else { self.ids.push(id.to_owned()) }
		}
		if let Some(id) = r.get("lease").and_then(|l| l.get("id")).and_then(Json::as_str) {
			self.subs.push(id.to_owned());
		}
		if let Some(e) = r.get("mailboxEpoch").and_then(Json::as_str) {
			self.mailbox = Some((e.to_owned(), r.get("next").and_then(Json::as_f64).unwrap_or(0.0)));
		}
		if let Some(t) = r.get("token").and_then(Json::as_str) {
			self.tokens.push((t.to_owned(), r.get("next").and_then(Json::as_str).map(str::to_owned)));
		}
		if let Some(v) = r.get("rev").and_then(Json::as_f64) {
			self.rev = v;
		}
		for l in [&mut self.ids, &mut self.txns, &mut self.subs] {
			if l.len() > 30 {
				l.drain(0..10);
			}
		}
		if self.tokens.len() > 8 {
			self.tokens.remove(0);
		}
		if self.requests.len() > 60 {
			self.requests.drain(0..20);
		}
	}
}

fn run(seed: u64, steps: usize, seen: &mut BTreeMap<String, usize>) {
	let mut init = Rng(seed);
	let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("service-walk-{seed}"));
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(dir.join("r")).unwrap();
	std::fs::create_dir_all(dir.join("t")).unwrap();
	let file = seed % 2 == 1;
	let limits = match init.below(4) {
		0 => Some(obj! { "maxCommitBytes" => 4000.0, "maxEntryBytes" => 1500.0, "maxEventBytes" => 3000.0 }),
		1 => Some(obj! { "claimResultMs" => 2000.0, "generationAdmitMs" => 30_000.0, "maxLogBytes" => 3000.0 }),
		2 => Some(obj! { "maxTxnsPerOwner" => 3.0, "maxWaitersPerOwner" => 2.0, "maxRegsPerOwner" => 2.0, "maxFrameBytes" => 4096.0, "maxCommitBytes" => 3000.0, "maxEventBytes" => 2000.0, "maxEntryBytes" => 1000.0 }),
		_ => None,
	};
	let max_calls = init.chance(0.2).then_some(40.0);
	let max_pending = init.chance(0.3).then_some(3.0);
	let now = 1_700_000_000_000.0;
	let seed_text = format!("walk{seed}");
	let mut ts = TsService::start();
	let mut line = obj! { "op" => "init", "seed" => seed_text.as_str(), "now" => now };
	if let Json::Object(o) = &mut line {
		if file {
			o.insert("store", dir.join("t/s.sqlite").to_str().unwrap().into());
		}
		if let Some(l) = &limits {
			o.insert("limits", l.clone());
		}
		if let Some(m) = max_calls {
			o.insert("maxCallsPerWindow", Json::Number(m));
		}
		if let Some(m) = max_pending {
			o.insert("maxPending", Json::Number(m));
		}
	}
	ts.step(&line);
	let mut rust = RustSide::start(&Setup { seed: seed_text, now, store: file.then(|| dir.join("r/s.sqlite")), limits, max_calls, max_pending, max_peer: None });
	let mut w = Walk { rng: Rng(seed ^ 0xabcdef), now, ..Default::default() };
	for step in 0..steps {
		// what an agent host would have left in the file: the wire alone only ever fills mailboxes
		if w.rng.chance(0.03) {
			w.serial += 1;
			let mut event = obj! { "eventId" => format!("x{}", w.serial), "seq" => 1.0, "kind" => "notify", "handback" => Json::Null };
			if let Json::Object(o) = &mut event {
				o.insert("target", if w.rng.chance(0.5) { "somebody".into() } else { Json::Number(7.0) });
				if w.rng.chance(0.5) {
					let txn = w.txns.last().cloned().filter(|_| w.rng.chance(0.7)).unwrap_or_else(|| "t-gone".to_owned());
					o.insert("txn", txn.into());
				}
				if w.rng.chance(0.2) {
					o.insert("tries", Json::Number(w.rng.below(7) as f64));
				}
				if w.rng.chance(0.2) {
					o.insert("retryAt", Json::Number(w.now + w.rng.pick(&[-1.0, 0.0, 1.0, 5000.0])));
				}
			}
			let t = ts.step(&obj! { "op" => "event", "now" => w.now, "event" => event.clone() });
			rust.clock.set(w.now);
			rust.service.store.commit(None, w.now, |s| {
				if let Some(Json::Array(a)) = s.state.rest.get_mut("outbox") {
					a.push(event);
				}
				s.state.outbox_bytes = None;
				Ok(())
			}).unwrap().unwrap();
			rust.service.store.drain().unwrap();
			assert_eq!(rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "seed {seed}, step {step}: state after an event: {}", rust.dump());
		}
		// what runs between calls: a round of the reaper, a run of delivery
		if w.rng.chance(0.08) {
			let reaper = w.rng.chance(0.5);
			let t = ts.step(&obj! { "op" => if reaper { "maintain" } else { "deliver" }, "now" => w.now });
			let want = t.get("reply").and_then(Json::as_str).unwrap();
			rust.clock.set(w.now);
			let got = if reaper {
				// the server commits a round only when something is due; TypeScript's reaper always does, and that
				// has to leave no trace in the state either
				let next = if rust.service.store.reader(None).unwrap().space.needs_maintenance(w.now).unwrap() || step == 0 {
					rust.service.maintenance_round(None).unwrap()
				} else {
					rust.service.store.reader(None).unwrap().space.next_expiry().unwrap()
				};
				if next >= phi_json::FOREVER { "forever".to_owned() } else { phi_json::number_text(next) }
			} else {
				let txns = rust.service.store.reader(None).unwrap().space.state.txns.len();
				let n = rust.service.deliver_events(None).unwrap();
				if n > 0 {
					*seen.entry("deliver dropped".to_owned()).or_default() += 1;
				}
				if rust.service.store.reader(None).unwrap().space.state.txns.len() < txns {
					*seen.entry("deliver released".to_owned()).or_default() += 1;
				}
				n.to_string()
			};
			rust.service.store.drain().unwrap();
			assert_eq!(got, want, "seed {seed}, step {step}: reaper {reaper}");
			assert_eq!(rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "seed {seed}, step {step}: state after the reaper ({reaper}): {}", rust.dump());
		}
		let (peer, text, frame) = w.call();
		let mut l = obj! { "now" => w.now, "peer" => peer.as_str(), "text" => text.as_str() };
		if let (Some(m), Json::Object(o)) = (frame, &mut l) {
			o.insert("maxFrame", Json::Number(m));
		}
		let t = ts.step(&l);
		let want = t.get("reply").and_then(Json::as_str).unwrap();
		let got = rust.step(w.now, &peer, &text, frame);
		let masked = |s: &str| if s.contains("\"process\":") { s.split("\"process\":").next().unwrap().to_owned() } else { s.to_owned() };
		assert_eq!(masked(&got), masked(want), "seed {seed}, step {step}, peer {peer}: {text}");
		if rust.state() != t.get("state").and_then(Json::as_str).unwrap() {
			panic!("seed {seed}, step {step}: state after {text}: {}", rust.dump());
		}
		w.learn(&peer, want, &text, seen);
	}
	ts.step(&obj! { "op" => "close" });
}

#[test]
fn random_calls_agree_with_the_typescript_service() {
	let var = |k: &str, d: u64| std::env::var(k).ok().and_then(|v| v.parse().ok()).unwrap_or(d);
	let steps = var("PHI_SERVICE_WALK_STEPS", 6000) as usize;
	let first = var("PHI_SERVICE_WALK_SEED", 1);
	let mut seen = BTreeMap::new();
	for seed in first..first + 8 {
		run(seed, steps / 8, &mut seen);
	}
	eprintln!("{seen:#?}");
	let must = ["deliver dropped", "deliver released", "write ok", "take ok", "read ok", "batch ok", "txn ok", "lease ok", "notify ok", "wait ok", "events ok", "ack ok", "changes ok", "readAll ok", "cancelOperation ok", "pollOperation ok", "resolveOperation ok", "generation ok", "hello ok", "spaces ok", "stats ok", "count ok", "write BadRequest", "write PermissionDenied", "write RequestExpired", "write TransactionError", "write ResourceExhausted", "write UniqueConflict", "write RequestConflict", "take ResourceExhausted", "readAll ResponseBudgetTooSmall", "events ResponseBudgetTooSmall", "changes ResponseBudgetTooSmall"];
	let missing: Vec<&&str> = must.iter().filter(|k| !seen.contains_key(**k)).collect();
	assert!(missing.is_empty() || steps < 6000, "no walk reached {missing:?}");
}
