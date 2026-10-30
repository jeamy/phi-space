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
	txns: Vec<String>,
	burst: usize,
	waiters: Vec<String>,
	/// A request's life in a few lines (`$gen` and `$key` stand for the newest generation and claim key).
	episode: std::collections::VecDeque<Json>,
	/// Issued generations and their principals.
	generations: Vec<(String, Json)>,
	keys: Vec<String>,
	/// The mailboxes as the last step left them: principal, epoch, acked, delivered, next.
	boxes: Vec<(Json, String, f64, f64, f64)>,
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
		// from about 1400 bytes a small write fits; up to 2200 a commit expires only a few entries and defers the rest
		let v = if r.chance(0.5) { 1300.0 + r.below(1500) as f64 } else { 1400.0 + r.below(800) as f64 };
		small("maxCommitBytes", v, 0.5, r);
		let v = 1.0 + r.below(3) as f64;
		small("maxTxnsPerOwner", v, 0.3, r);
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
		let v = 300.0 + r.below(3000) as f64;
		small("maxOutboxBytes", v, 0.25, r);
		let v = 300.0 + r.below(500) as f64;
		small("maxEventBytes", v, 0.2, r);
		let v = 1.0 + r.below(3) as f64;
		small("maxWaitersPerOwner", v, 0.2, r);
		let v = 600.0 + r.below(3000) as f64;
		small("maxClaimBytes", v, 0.25, r);
		let v = 100.0 * (1 + r.below(40)) as f64;
		small("claimResultMs", v, 0.5, r);
		let v = 100.0 * (1 + r.below(80)) as f64;
		small("generationAdmitMs", v, 0.5, r);
		let v = 300.0 + r.below(3000) as f64;
		small("maxMailboxBytes", v, 0.3, r);
		let v = 100.0 * (5 + r.below(100)) as f64;
		small("mailboxTtlMs", v, 0.4, r);
		let v = 100.0 * r.below(20) as f64;
		small("notifyIntervalMs", v, 0.4, r);
		let v = 1.0 + r.below(3) as f64;
		small("maxRegsPerOwner", v, 0.2, r);
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
	/// A transaction for an operation: mostly none, else a recent one or one that never was.
	fn txn(&mut self) -> Option<Json> {
		let r = &mut self.rng;
		if self.txns.is_empty() || r.chance(0.5) {
			return None;
		}
		if r.chance(0.05) {
			return Some("t-bogus".into());
		}
		let i = self.txns.len() - 1 - r.below(self.txns.len().min(4));
		Some(self.txns[i].as_str().into())
	}
	fn txn_id(&mut self) -> Json { self.txn().unwrap_or_else(|| "t-bogus".into()) }
	fn id(&mut self) -> Json {
		if !self.txns.is_empty() && self.rng.chance(0.2) {
			return self.txn_id();
		}
		if !self.waiters.is_empty() && self.rng.chance(0.2) {
			return self.waiter_id();
		}
		let r = &mut self.rng;
		if self.ids.is_empty() || r.chance(0.1) {
			return r.pick(&["e999", "e0a0b0c0d-999", "nope"]).into();
		}
		let i = self.ids.len() - 1 - r.below(self.ids.len().min(8)); // mostly recent ones
		self.ids[i].as_str().into()
	}
	fn waiter_id(&mut self) -> Json {
		let r = &mut self.rng;
		if self.waiters.is_empty() || r.chance(0.1) {
			return "w999".into();
		}
		let i = self.waiters.len() - 1 - r.below(self.waiters.len().min(6));
		self.waiters[i].as_str().into()
	}
	/// A consumer for a subscription or wait: mostly none (the outbox), sometimes a principal, rarely a bad one.
	fn consumer(&mut self) -> Option<Json> {
		match self.rng.below(20) {
			0..=10 => None,
			11 => Some(obj! { "peerId" => "" }),
			12..=15 => Some(obj! { "peerId" => "p1" }),
			_ => Some(obj! { "peerId" => "p2", "agentId" => "x" }),
		}
	}
	/// A mailbox's principal and what the walk knows of it.
	fn a_box(&mut self) -> (Json, Option<(String, f64, f64, f64)>) {
		if !self.boxes.is_empty() && self.rng.chance(0.85) {
			let b = self.boxes[self.rng.below(self.boxes.len())].clone();
			return (b.0, Some((b.1, b.2, b.3, b.4)));
		}
		(self.consumer().unwrap_or(obj! { "peerId" => "p3" }), None)
	}
	fn principal(&mut self) -> Json {
		match self.rng.below(12) {
			0 => obj! { "peerId" => "" },
			1..=5 => obj! { "peerId" => "p1" },
			_ => obj! { "peerId" => "p2", "agentId" => "x" },
		}
	}
	fn request(&mut self) -> Json {
		let mut principal = self.principal();
		let r = &mut self.rng;
		let generation: Json = if self.generations.is_empty() || r.chance(0.08) {
			"gbogus.0".into()
		} else {
			let i = self.generations.len() - 1 - if r.chance(0.7) { 0 } else { r.below(self.generations.len().min(3)) };
			if r.chance(0.85) {
				principal = self.generations[i].1.clone(); // mostly the one it was issued to
			}
			self.generations[i].0.as_str().into()
		};
		let request_id = r.pick(&["r1", "r2", "r3", "r1", "r2", ""]);
		obj! { "principal" => principal, "generation" => generation, "requestId" => request_id }
	}
	fn key(&mut self) -> Json {
		let r = &mut self.rng;
		if self.keys.is_empty() || r.chance(0.08) {
			return "[\"no\"]".into();
		}
		let i = self.keys.len() - 1 - r.below(self.keys.len().min(5));
		self.keys[i].as_str().into()
	}
	fn handback(&mut self) -> Option<Json> {
		let r = &mut self.rng;
		match r.below(6) {
			0 => None,
			1 => Some(Json::Null),
			2 => Some(obj! { "h" => r.below(5) as f64 }),
			3 => Some("x".repeat(r.below(600)).into()),
			_ => Some(Json::Number(r.below(3) as f64)),
		}
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

	/// A conversation's subscription and a run of matching writes: the rate limit counts them and sends them bundled.
	fn subscription(&mut self) {
		let consumer = self.consumer();
		let r = &mut self.rng;
		let mut sub = obj! { "op" => "notify", "tmpl" => obj! { "type" => "Task" }, "lease" => 60_000.0, "handback" => obj! { "s" => 1.0 }, "target" => "a", "as" => "a" };
		if let (Some(c), Json::Object(o)) = (consumer, &mut sub) {
			o.insert("consumer", c);
		}
		let mut lines = vec![sub];
		for i in 0..2 + r.below(4) {
			lines.push(obj! { "op" => "write", "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => i as f64 } }, "lease" => 5000.0 });
		}
		lines.push(obj! { "op" => "settle" });
		self.episode.extend(lines);
	}
	fn episode(&mut self) {
		let p = self.principal();
		let r = &mut self.rng;
		let request = obj! { "principal" => p.clone(), "generation" => "$gen", "requestId" => r.pick(&["e1", "e2"]) };
		let method = r.pick(&["take", "read"]);
		let admit = |args: f64| obj! { "op" => "admit", "request" => request.clone(), "method" => method, "args" => obj! { "a" => args }, "resultBound" => 300.0 };
		let mut lines = vec![obj! { "op" => "issueGeneration", "principal" => p }, admit(1.0)];
		lines.push(match r.below(4) {
			3 => obj! { "op" => "decide", "key" => "$key", "outcome" => obj! { "state" => "done", "result" => obj! { "x" => "y".repeat(250 + r.below(100)) } } }, // around its 300-byte reservation
			0 => obj! { "op" => "park", "key" => "$key", "tmpl" => obj! { "type" => r.pick(&TYPES) }, "take" => method == "take", "txn" => Json::Null, "deadline" => self.now + 100.0 * r.below(20) as f64, "ifExists" => r.chance(0.3) },
			1 => obj! { "op" => "decide", "key" => "$key", "outcome" => obj! { "state" => "done", "result" => obj! { "v" => r.below(3) as f64 } } },
			_ => obj! { "op" => "decide", "key" => "$key", "outcome" => obj! { "state" => "cancelled" } },
		});
		if r.chance(0.5) {
			lines.push(obj! { "op" => "write", "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => 1.0 } }, "lease" => 5000.0 });
		}
		lines.push(obj! { "op" => "lookup", "request" => request.clone() });
		lines.push(admit(if r.chance(0.8) { 1.0 } else { 2.0 }));
		lines.push(obj! { "op" => "settle" });
		lines.push(obj! { "op" => "lookup", "request" => request.clone() });
		lines.push(admit(1.0));
		self.episode.extend(lines);
	}
	/// Fills in `$gen` and `$key` from what the walk has seen.
	fn fill(&self, v: &Json) -> Json {
		match v {
			Json::String(s) if s == "$gen" => self.generations.last().map_or("gnone.0".into(), |g| g.0.as_str().into()),
			Json::String(s) if s == "$key" => self.keys.last().map_or("[]".into(), |k| k.as_str().into()),
			Json::Array(a) => Json::Array(a.iter().map(|x| self.fill(x)).collect()),
			Json::Object(o) => Json::Object(o.iter().map(|(k, x)| (k, self.fill(x))).collect()),
			other => other.clone(),
		}
	}

	fn line(&mut self, rev: f64) -> Json {
		if let Some(l) = self.episode.pop_front() {
			self.now += self.rng.pick(&[0.0, 100.0, 300.0]);
			let Json::Object(mut o) = self.fill(&l) else { unreachable!() };
			o.insert("now", Json::Number(self.now));
			return Json::Object(o);
		}
		if self.rng.chance(0.02) {
			self.episode();
		} else if self.rng.chance(0.01) {
			self.subscription();
		}
		if self.burst > 0 {
			// several entries with the same lease at the same time: they expire together
			self.burst -= 1;
			let entry = obj! { "type" => "Task", "fields" => obj! { "n" => self.burst as f64 } };
			return obj! { "op" => "write", "now" => self.now, "entry" => entry, "lease" => 300.0 };
		}
		if self.rng.chance(0.01) {
			self.burst = 4 + self.rng.below(8);
		}
		self.now += self.rng.pick(&[0.0, 0.0, 0.0, 100.0, 100.0, 200.0, 500.0, 1000.0, 3_600_000.0]);
		let mut o = Object::new();
		let mut set = |k: &str, v: Option<Json>| {
			if let Some(v) = v {
				o.insert(k, v);
			}
		};
		let op = match self.rng.below(184) {
			0..=29 => {
				set("entry", Some(self.entry()));
				set("lease", self.lease());
				set("as", self.as_());
				set("txn", self.txn());
				"write"
			}
			30..=34 => {
				set("entry", Some(self.entry()));
				set("as", self.as_());
				set("txn", self.txn());
				"announce"
			}
			35..=49 => {
				set("tmpl", self.template());
				set("take", Some(Json::Bool(self.rng.chance(0.5))));
				set("as", self.as_());
				set("txn", self.txn());
				"probe"
			}
			50..=53 => {
				set("tmpl", self.template());
				set("txn", self.txn());
				set("as", self.as_());
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
				set("txn", self.txn());
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
				set("txn", self.txn());
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
			99 => "revision",
			100..=105 => {
				// transactions mostly live long enough to be used
				let lease = match self.rng.below(4) {
					0 => self.lease(),
					1 => Some(Json::Number(3_600_000.0 * 2.0)),
					_ => Some(Json::Number(1000.0 * (1 + self.rng.below(20)) as f64)),
				};
				set("lease", lease);
				set("as", self.as_());
				"createTxn"
			}
			106..=110 => {
				set("id", Some(self.txn_id()));
				set("as", self.as_());
				"commitTxn"
			}
			114..=123 => {
				let mut w = Object::new();
				w.insert("template", self.template().unwrap_or(Json::Null));
				w.insert("take", Json::Bool(self.rng.chance(0.5)));
				let target = self.rng.pick(&[Json::from("a"), Json::from("b"), Json::Null, Json::Number(1.0)]);
				w.insert("target", target.clone());
				match self.rng.below(8) {
					0 => w.insert("deadline", Json::Number(self.now + 100.0 * self.rng.below(20) as f64)),
					1 => w.insert("timeout", Json::Number(-1.0)),
					2 => w.insert("timeout", Json::Number(FOREVER)),
					3 => w.insert("deadline", Json::Number(-3.0)),
					_ => w.insert("timeout", Json::Number(100.0 * self.rng.below(30) as f64)),
				}
				if let Some(h) = self.handback() {
					w.insert("handback", h);
				}
				if self.rng.chance(0.2) {
					let l = self.lease().unwrap_or(Json::Null);
					w.insert("txnLeaseMs", l);
				}
				if self.rng.chance(0.4) && !target.is_null() {
					w.insert("as", target);
				}
				if self.rng.chance(0.1) {
					w.insert("authorizedUntil", Json::Number(self.now + 100.0 * self.rng.below(10) as f64));
				}
				if let Some(c) = self.consumer() {
					w.insert("consumer", c);
				}
				set("w", Some(Json::Object(w)));
				"addWaiter"
			}
			124..=126 => {
				set("id", Some(self.waiter_id()));
				"cancelWaiter"
			}
			127..=130 | 150..=153 => {
				set("principal", Some(self.principal()));
				if self.rng.chance(0.1) {
					set("options", Some(obj! { "key" => "fixed-key", "authorityId" => "auth-1" }));
				}
				"issueGeneration"
			}
			131..=138 => {
				set("request", Some(self.request()));
				set("method", Some(self.rng.pick(&["take", "read", "wait"]).into()));
				set("args", Some(obj! { "t" => self.rng.below(2) as f64 }));
				if self.rng.chance(0.3) {
					set("deadline", Some(Json::Number(self.now + 100.0 * self.rng.below(20) as f64)));
				}
				if self.rng.chance(0.3) {
					set("resultBound", Some(Json::Number(self.rng.pick(&[2.0, 100.0, 300.0]))));
				}
				"admit"
			}
			139..=141 => {
				set("key", Some(self.key()));
				let outcome = match self.rng.below(5) {
					0 => obj! { "state" => "cancelled" },
					1 => obj! { "state" => "done", "result" => obj! { "x" => "y".repeat(self.rng.below(600)) } },
					2 => obj! { "state" => "done", "result" => Json::Null, "locked" => true },
					3 => obj! { "state" => "done", "result" => Json::Null, "error" => obj! { "code" => "TransactionError", "message" => "m" } },
					_ => obj! { "state" => "done", "result" => Json::Number(1.0) },
				};
				set("outcome", Some(outcome));
				"decide"
			}
			142..=143 => {
				set("request", Some(self.request()));
				"lookup"
			}
			144..=149 => {
				set("key", Some(self.key()));
				set("tmpl", self.template());
				set("take", Some(Json::Bool(self.rng.chance(0.5))));
				set("txn", Some(self.txn().unwrap_or(Json::Null)));
				let deadline = if self.rng.chance(0.2) { FOREVER } else { self.now + 100.0 * self.rng.below(30) as f64 };
				set("deadline", Some(Json::Number(deadline)));
				set("ifExists", Some(Json::Bool(self.rng.chance(0.3))));
				let owner = self.as_();
				set("owner", owner);
				"park"
			}
			154..=163 => {
				set("tmpl", self.template());
				set("txn", self.txn());
				set("lease", self.lease());
				if let Some(h) = self.handback() {
					set("handback", Some(h));
				}
				let target = self.rng.pick(&[Json::from("a"), Json::from("b"), Json::Null]);
				set("target", Some(target.clone()));
				if self.rng.chance(0.5) && !target.is_null() {
					set("as", Some(target));
				}
				set("consumer", self.consumer());
				"notify"
			}
			164..=171 => {
				let (p, known) = self.a_box();
				set("principal", Some(p));
				let mut q = Object::new();
				if let Some((epoch, acked, delivered, next)) = known {
					match self.rng.below(6) {
						0 => q.insert("after", Json::Number(delivered)),
						1 => q.insert("after", Json::Number(if self.rng.chance(0.5) { next + 1.0 } else { delivered + 1.0 })),
						2 => q.insert("after", Json::Number(acked)),
						_ => {}
					}
					match self.rng.below(5) {
						0 => q.insert("mailboxEpoch", "mbstale".into()),
						1 | 2 => q.insert("mailboxEpoch", epoch.into()),
						_ => {}
					}
				}
				if self.rng.chance(0.3) {
					q.insert("maxBytes", Json::Number(50.0 + self.rng.below(500) as f64));
				}
				set("o", Some(Json::Object(q)));
				"events"
			}
			172..=175 => {
				let (p, _) = self.a_box();
				set("principal", Some(p));
				let mut e = obj! { "kind" => "entry", "eventId" => "nx", "seq" => 1.0, "handback" => Json::Null, "target" => "a", "entry" => obj! { "id" => "e1", "type" => "Task", "types" => Json::Array(vec!["Task".into()]), "fields" => obj! { "pad" => "x".repeat(self.rng.below(300)) }, "owner" => Json::Null } };
				if let (Some(t), Json::Object(o)) = (self.txn(), &mut e) {
					o.insert("txn", t); // an expired take event releases its transaction
				}
				set("event", Some(e));
				"appendMail"
			}
			176..=181 => {
				let (p, known) = self.a_box();
				set("principal", Some(p));
				let (epoch, acked, delivered) = known.map_or(("mbnone".to_owned(), 0.0, 0.0), |k| (k.0, k.1, k.2));
				set("mailboxEpoch", Some(if self.rng.chance(0.9) { epoch.into() } else { "mbstale".into() }));
				let up_to = match self.rng.below(5) {
					0 => acked,
					1 => delivered + 1.0,
					2 => acked + 1.0,
					_ => delivered,
				};
				set("upTo", Some(Json::Number(up_to)));
				"ack"
			}
			_ => {
				set("id", Some(self.txn_id()));
				set("as", self.as_());
				"abortTxn"
			}
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
	let mut w = Walk { rng: Rng(seed), now: 1000.0, ids: vec![], txns: vec![], burst: 0, episode: Default::default(), waiters: vec![], generations: vec![], keys: vec![], boxes: vec![], page_next: None };
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
					if id.starts_with('t') { w.txns.push(id.to_owned()) } else { w.ids.push(id.to_owned()) }
				}
				if let Some(g) = v.get("generation").and_then(Json::as_str) {
					w.generations.push((g.to_owned(), line.get("principal").cloned().unwrap_or(Json::Null)));
				}
				if let Some(k) = v.get("key").and_then(Json::as_str) {
					if !w.keys.iter().any(|x| x == k) {
						w.keys.push(k.to_owned());
					}
					note(Box::leak(format!("admit {}", v.get("kind").and_then(Json::as_str).unwrap_or("?")).into_boxed_str()), seen);
				}
				if op == "lookup" {
					note(Box::leak(format!("lookup {}", v.get("state").and_then(Json::as_str).unwrap_or("?")).into_boxed_str()), seen);
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
				if op == "probe" && v.get("status").and_then(Json::as_str) == Some("locked") {
					note("probe locked", seen);
				}
				if line.get("txn").is_some() && op != "probe" {
					note("ok under a transaction", seen);
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
		w.boxes = s.mailboxes.iter().flatten().map(|(_, b)| (b.principal.clone(), b.epoch.clone(), b.acked, b.delivered, b.next)).collect();
		for (_, b) in s.mailboxes.iter().flatten() {
			if !b.events.is_empty() {
				note("events in a mailbox", seen);
			}
			if b.gap.is_some() {
				note("a mailbox with a gap", seen);
			}
			if b.acked > 0.0 {
				note("a mailbox acknowledged", seen);
			}
			for e in &b.events {
				match e.get("event").and_then(|x| x.get("kind")).and_then(Json::as_str) {
					Some("registrationClosed") => note("a registration closed in a mailbox", seen),
					Some("timeout") => note("a timeout in a mailbox", seen),
					_ => {}
				}
			}
		}
		for x in &s.regs {
			if x.pending.is_some_and(|p| p > 0.0) {
				note("a bundled event pending", seen);
			}
		}
		if let Some(Json::Array(out)) = s.rest.get("outbox") {
			if out.iter().any(|e| e.get("count").is_some()) {
				note("a bundled event sent", seen);
			}
		}
		if s.rest.get("releaseQueue").is_some() {
			note("a release queue", seen);
		}
		if s.rest.get("jobs").and_then(Json::as_array).is_some_and(|j| j.iter().any(|j| j.get("events").and_then(Json::as_array).is_some_and(|e| e.iter().any(|x| x.get("consumer").is_some())))) {
			note("a fanout job for a consumer", seen);
		}
		for x in &s.waiters {
			if !w.waiters.contains(&x.id) {
				w.waiters.push(x.id.clone());
			}
			note(if x.claim_key.is_some() { "a parked request waits" } else { "a waiter waits" }, seen);
		}
		for t in &s.txns {
			if !w.txns.contains(&t.id) {
				w.txns.push(t.id.clone()); // opened by a served take
			}
		}
		if s.rest.get("jobs").and_then(Json::as_array).is_some_and(|j| !j.is_empty()) {
			note("a fanout job waits", seen);
		}
		if let Some(r) = &s.rpc {
			for (_, c) in r.claims.iter() {
				if c.get("resultExpired").is_some() {
					note("a claim's result expired", seen);
				}
				if c.get("state").and_then(Json::as_str) == Some("done") && c.get("method").and_then(Json::as_str).is_some() && c.get("result").is_some_and(|r| r.as_object().is_some()) {
					note("a claim decided with a result", seen);
				}
			}
		}
		if s.outbox_bytes.is_some_and(|b| b > 2.0) {
			note("events in the outbox", seen);
		}
		if s.returned > 0.0 {
			note("entries returned by an abort", seen);
		}
		if s.entries.iter().any(|e| e.written_under.is_some()) {
			note("entries written under a transaction", seen);
		}
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
	let missing = [
		"write ResourceExhausted",
		"write LimitError",
		"write IllegalArgumentError",
		"write PermissionError",
		"write TransactionError",
		"write with a lease of 0",
		"expiry deferred",
		"log dropped batches",
		"nextExpiry null",
		"probe took",
		"probe read",
		"probe TransactionError",
		"renew UnknownLeaseError",
		"renew PermissionError",
		"renew IllegalArgumentError",
		"cancel PermissionError",
		"listPage IllegalArgumentError",
		"list IllegalArgumentError",
		"changes RevisionAhead",
		"changes SnapshotExpired",
		"changes IllegalArgumentError",
		"changes ResponseBudgetTooSmall",
		"changes with more",
		"announce LimitError",
		"createTxn LimitError",
		"createTxn IllegalArgumentError",
		"commitTxn TransactionError",
		"commitTxn PermissionError",
		"abortTxn PermissionError",
		"probe locked",
		"probe PermissionError",
		"ok under a transaction",
		"entries returned by an abort",
		"entries written under a transaction",
		"list TransactionError",
		"notify LimitError",
		"notify IllegalArgumentError",
		"notify ResourceExhausted",
		"events IllegalArgumentError",
		"events ResponseBudgetTooSmall",
		"ack InvalidAck",
		"ack MailboxEpochMismatch",
		"appendMail ResourceExhausted",
		"events in a mailbox",
		"a mailbox with a gap",
		"a mailbox acknowledged",
		"a registration closed in a mailbox",
		"a timeout in a mailbox",
		"a bundled event pending",
		"a bundled event sent",
		"a release queue",
		"a fanout job for a consumer",
		"addWaiter LimitError",
		"addWaiter IllegalArgumentError",
		"addWaiter ResourceExhausted",
		"a waiter waits",
		"a parked request waits",
		"a fanout job waits",
		"events in the outbox",
		"a claim's result expired",
		"a claim decided with a result",
		"admit fresh",
		"admit pending",
		"admit done",
		"admit cancelled",
		"admit RequestConflict",
		"admit RequestExpired",
		"admit ResultExpired",
		"admit LimitError",
		"admit TypeError",
		"issueGeneration TypeError",
		"issueGeneration LimitError",
		"decide LimitError",
		"decide Error",
		"lookup RequestExpired",
		"lookup pending",
		"lookup done",
	]
	.into_iter()
	.filter(|k| !seen.contains_key(k))
	.collect::<Vec<_>>();
	assert!(missing.is_empty(), "no walk reached {missing:?}; seen: {seen:#?}");
}
