// R1, slice 1: the byte budgets at their edges. A random walk rarely lands on the one byte where a limit flips, so each
// case here is a line sequence with a parameter (padding or a limit); the Rust core finds where its outcome flips, and
// both cores then run the sequence at that point and two either side, answer for answer and state hash for state hash.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{digest_json, obj, Json};

/// What a run looks like from outside: every answer, and the parts of the state the budgets move.
fn signature(lines: &[Json]) -> (Vec<String>, String) {
	let mut d = Driver::new();
	// answers by their shape (strings, which carry the padding, and messages, which carry the limits, left out)
	// (setLimits answers with the limits, which move with the parameter)
	let answers = lines.iter().map(|l| match d.step(l) { Ok(_) if l.get("op").and_then(Json::as_str) == Some("setLimits") => "ok".to_owned(), Ok(v) => shape(&v).canonical().unwrap(), Err(e) => e.class.to_owned() }).collect();
	let s = &d.space.state;
	// discrete outcomes only: the byte tally moves with every byte of padding
	let stream = s.stream.as_ref().map_or(String::new(), |st| format!("floor {} log {}", st.floor, st.log.len()));
	(answers, format!("{stream} maintenance {} entries {}", s.rest.contains_key("maintenance"), s.entries.len()))
}

fn shape(v: &Json) -> Json {
	match v {
		Json::String(_) => Json::Null,
		Json::Array(a) => Json::Array(a.iter().map(shape).collect()),
		Json::Object(o) => Json::Object(o.iter().map(|(k, v)| (k, shape(v))).collect()),
		other => other.clone(),
	}
}

fn compare(lines: &[Json], what: &str) {
	let mut rust = Driver::new();
	let mut ts = TsDriver::start();
	let answers = ts.run(lines);
	for (i, (l, t)) in lines.iter().zip(&answers).enumerate() {
		let got = match rust.step(l) { Ok(v) => (true, v.canonical().unwrap()), Err(e) => (false, format!("{}: {}", e.class, e.message)) };
		let want = if t.get("ok") == Some(&Json::Bool(true)) { (true, t.get("result").unwrap().canonical().unwrap()) } else { (false, format!("{}: {}", t.get("error").and_then(Json::as_str).unwrap(), t.get("message").and_then(Json::as_str).unwrap())) };
		assert_eq!(got, want, "{what}, step {i}: {}", l.to_json_text());
		assert_eq!(digest_json(&rust.space.state.to_json()).unwrap(), t.get("state").and_then(Json::as_str).unwrap(), "{what}, step {i}: state of {}", l.to_json_text());
	}
}

/// Finds where `make(x)` stops looking like `make(from)` and compares both cores around that point.
fn edge(what: &str, from: usize, to: usize, make: impl Fn(usize) -> Vec<Json>) {
	let first = signature(&make(from));
	let flip = (from..=to).find(|&x| signature(&make(x)) != first).unwrap_or_else(|| panic!("{what}: nothing flips in {from}..={to}"));
	assert!(flip > from + 1, "{what}: flips at once ({flip}); the case does not reach its edge");
	for x in flip.saturating_sub(2).max(from)..=(flip + 2).min(to) {
		compare(&make(x), &format!("{what} at {x} (flips at {flip})"));
	}
}

fn init(limits: Json) -> Json { obj! { "op" => "init", "seed" => "edge", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d", "limits" => limits } }
fn write(pad: usize, lease: f64, now: f64) -> Json {
	obj! { "op" => "write", "now" => now, "entry" => obj! { "type" => "Task", "fields" => obj! { "pad" => "x".repeat(pad) } }, "lease" => lease, "as" => "a" }
}

#[test]
fn the_commit_budget_of_a_write() {
	edge("maxCommitBytes of one write", 0, 2000, |pad| vec![init(obj! { "maxCommitBytes" => 2000.0 }), write(pad, 500.0, 1000.0)]);
	// padding moves the write's cost in steps of two bytes (the field is in the entry and in its put); the limit by one
	edge("maxCommitBytes against one write", 1100, 2500, |max| vec![init(obj! { "maxCommitBytes" => max as f64 }), write(100, 500.0, 1000.0)]);
	// expiry in the same commit charges first: the write gets what is left
	edge("a write after expiry in its commit", 0, 2000, |pad| {
		vec![init(obj! { "maxCommitBytes" => 2400.0 }), write(10, 100.0, 1000.0), write(10, 100.0, 1000.0), write(pad, 500.0, 1100.0)]
	});
}

#[test]
fn deferred_expiry_at_the_commit_budget() {
	// six entries written in commits of their own (from 1500 bytes on each write fits), then expiring together: a
	// commit expires (max - 1024) / 128 of them and defers the rest
	edge("entries expiring in one commit", 1500, 2200, |max| {
		let mut lines = vec![init(obj! { "maxCommitBytes" => max as f64 })];
		for _ in 0..6 {
			lines.push(write(1, 100.0, 1000.0));
		}
		lines.push(obj! { "op" => "settle", "now" => 1100.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 1100.0 });
		lines.push(obj! { "op" => "settle", "now" => 1100.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 1100.0 });
		lines
	});
}

#[test]
fn entry_space_and_document_bytes() {
	edge("maxEntryBytes", 0, 600, |pad| vec![init(obj! { "maxEntryBytes" => 300.0 }), write(pad, 500.0, 1000.0)]);
	edge("maxEntryBytes of an announce", 0, 600, |pad| {
		vec![init(obj! { "maxEntryBytes" => 300.0 }), obj! { "op" => "announce", "now" => 1000.0, "entry" => obj! { "type" => "Note", "fields" => obj! { "pad" => "x".repeat(pad) } } }]
	});
	// type names count UTF-16 units (JavaScript's length): neither bytes nor chars
	let typed = |type_: &str, supertype: &str, max: usize| {
		let entry = obj! { "type" => type_, "types" => Json::Array(vec![supertype.into()]), "fields" => obj! {} };
		vec![init(obj! { "maxTypeChars" => max as f64 }), obj! { "op" => "write", "now" => 1000.0, "entry" => entry, "lease" => 500.0, "as" => "a" }]
	};
	edge("maxTypeChars of a type", 1, 30, |max| typed("ä😀ä😀ä", "A", max));
	edge("maxTypeChars of a supertype", 1, 30, |max| typed("A", "😀😀😀ä", max));
	edge("maxEntryBytes against a write", 100, 400, |max| vec![init(obj! { "maxEntryBytes" => max as f64 }), write(200, 500.0, 1000.0)]);
	edge("maxSpaceBytes against a write", 300, 900, |max| vec![init(obj! { "maxSpaceBytes" => max as f64 }), write(200, 500.0, 1000.0), write(150, 500.0, 1000.0)]);
	edge("maxDocBytes against a write", 600, 3000, |max| vec![init(obj! { "maxDocBytes" => max as f64 }), write(200, 500.0, 1000.0), write(150, 500.0, 1000.0)]);
	edge("maxSpaceBytes", 0, 900, |pad| vec![init(obj! { "maxSpaceBytes" => 700.0 }), write(200, 500.0, 1000.0), write(pad, 500.0, 1000.0)]);
	edge("maxDocBytes", 0, 2000, |pad| vec![init(obj! { "maxDocBytes" => 2500.0 }), write(200, 500.0, 1000.0), write(pad, 500.0, 1000.0)]);
	edge("maxOutboxBytes", 0, 6, |max| vec![init(obj! { "maxOutboxBytes" => max as f64 }), write(1, 500.0, 1000.0)]);
}

#[test]
fn the_change_log_drops_at_max_log_bytes() {
	edge("maxLogBytes over several commits", 0, 1500, |pad| {
		let mut lines = vec![init(obj! { "maxLogBytes" => 1200.0 })];
		for i in 0..4 {
			lines.push(write(if i == 3 { pad } else { 100 }, 500.0, 1000.0 + i as f64));
		}
		lines.push(obj! { "op" => "changes", "now" => 1010.0, "afterRev" => 0.0 });
		lines.push(obj! { "op" => "changes", "now" => 1010.0, "afterRev" => 2.0 });
		lines
	});
	edge("maxLogBytes against several commits", 200, 1500, |max| {
		let mut lines = vec![init(obj! { "maxLogBytes" => max as f64 })];
		for i in 0..4 {
			lines.push(write(100, 500.0, 1000.0 + i as f64));
		}
		lines.push(obj! { "op" => "changes", "now" => 1010.0, "afterRev" => 0.0 });
		lines
	});
	edge("maxLogBytes inside one commit", 0, 1500, |pad| vec![init(obj! { "maxLogBytes" => 700.0 }), write(100, 500.0, 1000.0), write(pad, 500.0, 1001.0), obj! { "op" => "renew", "now" => 1001.0, "id" => "e0a0b0c0d-2", "ms" => 900.0 }]);
}

#[test]
fn pages_and_changes_at_their_byte_budgets() {
	let entries = || {
		let mut lines = vec![init(obj! {})];
		for i in 0..4 {
			lines.push(write(10 * i, 500.0, 1000.0));
		}
		lines
	};
	edge("listPage maxBytes", 1, 1500, |max| {
		let mut lines = entries();
		lines.push(obj! { "op" => "listPage", "now" => 1000.0, "o" => obj! { "maxBytes" => max as f64 } });
		lines.push(obj! { "op" => "listPage", "now" => 1000.0, "o" => obj! { "maxBytes" => max as f64, "after" => "2" } });
		lines
	});
	edge("listPage at maxFrameBytes", 1, 1500, |max| {
		let mut lines = entries();
		lines[0] = init(obj! { "maxFrameBytes" => max as f64 });
		lines.push(obj! { "op" => "listPage", "now" => 1000.0 });
		lines
	});
	edge("changes maxBytes", 1, 2000, |max| {
		let mut lines = entries();
		lines.push(obj! { "op" => "changes", "now" => 1000.0, "afterRev" => 0.0, "o" => obj! { "maxBytes" => max as f64 } });
		lines.push(obj! { "op" => "changes", "now" => 1000.0, "afterRev" => 2.0, "o" => obj! { "maxBytes" => max as f64 } });
		lines
	});
}

fn txn_write(pad: usize, lease: f64, now: f64, txn: &str) -> Json {
	obj! { "op" => "write", "now" => now, "entry" => obj! { "type" => "Task", "fields" => obj! { "pad" => "x".repeat(pad) } }, "lease" => lease, "as" => "a", "txn" => txn }
}

#[test]
fn transactions_at_the_commit_budget() {
	// ids under incarnation 0a0b0c0d: the transaction is t…-1, the entries follow
	let txn = "t0a0b0c0d-1";
	let open = |max: f64| vec![init(obj! { "maxCommitBytes" => max }), obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 60_000.0, "as" => "a" }];
	// what completing the transaction may write is reserved write by write, against one commit
	edge("the reservation of a transaction", 0, 1500, |pad| {
		let mut lines = open(3000.0);
		lines.push(txn_write(300, 5000.0, 1000.0, txn));
		lines.push(txn_write(pad, 5000.0, 1000.0, txn));
		lines.push(obj! { "op" => "commitTxn", "now" => 1000.0, "id" => txn, "as" => "a" });
		lines.push(obj! { "op" => "changes", "now" => 1000.0, "afterRev" => 0.0 });
		lines
	});
	edge("the reservation of a take", 0, 1500, |pad| {
		let mut lines = open(2600.0);
		lines.push(write(pad, 5000.0, 1000.0));
		lines.push(obj! { "op" => "probe", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" }, "take" => true, "txn" => txn, "as" => "a" });
		lines.push(obj! { "op" => "abortTxn", "now" => 1000.0, "id" => txn, "as" => "a" });
		lines.push(obj! { "op" => "count", "now" => 1000.0 });
		lines
	});
	// the commit's own settle expires entries first: the reservation may then no longer fit
	edge("a commit after expiry in its commit", 0, 1500, |pad| {
		let mut lines = open(2600.0);
		for _ in 0..4 {
			lines.push(write(1, 100.0, 1000.0));
		}
		lines.push(txn_write(pad, 5000.0, 1000.0, txn));
		lines.push(obj! { "op" => "commitTxn", "now" => 1100.0, "id" => txn, "as" => "a" });
		lines.push(obj! { "op" => "count", "now" => 1100.0 });
		lines
	});
	// a transaction that lapses is aborted by the next operation, after the entries that lapsed before it
	edge("a lapsed transaction at the commit budget", 1400, 3000, |max| {
		let mut lines = vec![init(obj! { "maxCommitBytes" => max as f64 }), obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 500.0 }];
		lines.push(write(1, 300.0, 1000.0));
		lines.push(obj! { "op" => "probe", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" }, "take" => true, "txn" => txn });
		for _ in 0..3 {
			lines.push(write(1, 200.0, 1000.0));
		}
		lines.push(obj! { "op" => "settle", "now" => 2000.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 2000.0 });
		lines.push(obj! { "op" => "settle", "now" => 2000.0 });
		lines.push(obj! { "op" => "stats", "now" => 2000.0 });
		lines
	});
}

#[test]
fn transactions_lapsing_together_and_their_joint_reservations() {
	// two transactions lapse at the same moment, each holding a take: they are aborted in the order they were opened,
	// and the returned entries enter the batch in that order
	let mut lines = vec![init(obj! {})];
	for _ in 0..2 {
		lines.push(write(1, 60_000.0, 1000.0));
	}
	for (i, txn) in ["t0a0b0c0d-3", "t0a0b0c0d-4"].iter().enumerate() {
		lines.push(obj! { "op" => "createTxn", "now" => 1000.0 + i as f64, "lease" => 500.0 - i as f64 });
		lines.push(obj! { "op" => "probe", "now" => 1001.0, "tmpl" => obj! { "type" => "Task" }, "take" => true, "txn" => *txn });
	}
	lines.push(obj! { "op" => "settle", "now" => 2000.0 });
	lines.push(obj! { "op" => "changes", "now" => 2000.0, "afterRev" => 0.0 });
	compare(&lines, "two transactions lapsing together");
	// every open transaction's reservation counts against maxJobBytes
	edge("maxJobBytes across transactions", 300, 1500, |max| {
		let mut lines = vec![init(obj! { "maxJobBytes" => max as f64 })];
		for (i, txn) in ["t0a0b0c0d-1", "t0a0b0c0d-3"].iter().enumerate() {
			lines.push(obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 60_000.0, "as" => "a" });
			lines.push(txn_write(100 + 50 * i, 5000.0, 1000.0, txn));
		}
		lines
	});
}

/// Lines with `$gen`, `$key` and `$next1`, `$next2`, … (the newest generation and claim key, and the snapshot cursors
/// in the order answers named them), resolved by running them.
fn resolve(lines: &[Json]) -> Vec<Json> {
	fn fill(v: &Json, g: &str, k: &str, next: &[String]) -> Json {
		match v {
			Json::String(s) if s == "$gen" => g.into(),
			Json::String(s) if s == "$key" => k.into(),
			Json::String(s) if s.starts_with("$next") => next.get(s[5..].parse::<usize>().unwrap() - 1).map_or("ssnone.0".into(), |n| n.as_str().into()),
			Json::Array(a) => Json::Array(a.iter().map(|x| fill(x, g, k, next)).collect()),
			Json::Object(o) => Json::Object(o.iter().map(|(n, x)| (n, fill(x, g, k, next))).collect()),
			other => other.clone(),
		}
	}
	let mut d = Driver::new();
	let (mut g, mut k, mut next) = (String::new(), String::new(), vec![]);
	lines
		.iter()
		.map(|l| {
			let l = fill(l, &g, &k, &next);
			if let Ok(v) = d.step(&l) {
				if let Some(x) = v.get("generation").and_then(Json::as_str) {
					g = x.to_owned();
				}
				if let Some(x) = v.get("key").and_then(Json::as_str) {
					k = x.to_owned();
				}
				if let Some(x) = v.get("next").and_then(Json::as_str).filter(|x| x.starts_with("ss")) {
					next.push(x.to_owned());
				}
			}
			l
		})
		.collect()
}
fn request(id: &str) -> Json { obj! { "principal" => obj! { "peerId" => "p1" }, "generation" => "$gen", "requestId" => id } }

#[test]
fn waiters_and_claims_at_the_commit_budget() {
	// waits lapsing together cost their handback and 256 each; the rest is deferred
	edge("waits lapsing in one commit", 1400, 3000, |max| {
		let mut lines = vec![init(obj! { "maxCommitBytes" => max as f64 })];
		for i in 0..5 {
			lines.push(obj! { "op" => "addWaiter", "now" => 1000.0, "w" => obj! { "template" => obj! { "type" => "None" }, "take" => false, "target" => "a", "timeout" => 100.0, "handback" => obj! { "h" => i as f64 } } });
		}
		lines.push(obj! { "op" => "settle", "now" => 1100.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 1100.0 });
		lines.push(obj! { "op" => "settle", "now" => 1100.0 });
		lines
	});
	// claims are swept in key order (not the order they came in), 128 bytes each
	edge("claims swept in one commit", 1100, 2000, |max| {
		let mut lines = vec![init(obj! { "maxCommitBytes" => max as f64, "claimResultMs" => 500.0, "generationAdmitMs" => 200.0 }), obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } }];
		for id in ["r5", "r3", "r4", "r1", "r2"] {
			lines.push(obj! { "op" => "admit", "now" => 1000.0, "request" => request(id), "method" => "take", "args" => obj! {} });
			lines.push(obj! { "op" => "decide", "now" => 1000.0, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => Json::Null } });
		}
		lines.push(obj! { "op" => "settle", "now" => 1600.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 1600.0 });
		lines.push(obj! { "op" => "settle", "now" => 1600.0 });
		lines.push(obj! { "op" => "lookup", "now" => 1600.0, "request" => request("r1") });
		lines.push(obj! { "op" => "lookup", "now" => 1600.0, "request" => request("r5") });
		resolve(&lines)
	});
}

#[test]
fn claim_retention_at_its_edges() {
	// the result goes at decidedAt + claimResultMs; the hash stays while the generation admits (to admitUntil
	// inclusive), then claim and generation go
	let mut lines = vec![init(obj! { "claimResultMs" => 500.0, "generationAdmitMs" => 1000.0 }), obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } }];
	lines.push(obj! { "op" => "admit", "now" => 1000.0, "request" => request("r1"), "method" => "take", "args" => obj! {} });
	lines.push(obj! { "op" => "decide", "now" => 1000.0, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => obj! { "v" => 1.0 } } });
	// a second claim whose result expires exactly when its generation stops admitting
	lines.push(obj! { "op" => "admit", "now" => 1000.0, "request" => request("r2"), "method" => "take", "args" => obj! {} });
	for now in [1499.0, 1500.0, 1999.0, 2000.0, 2001.0, 2002.0] {
		lines.push(obj! { "op" => "settle", "now" => now });
		if now == 1500.0 {
			lines.push(obj! { "op" => "decide", "now" => now, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => obj! { "v" => 2.0 } } });
		}
		for id in ["r1", "r2"] {
			lines.push(obj! { "op" => "lookup", "now" => now, "request" => request(id) });
			lines.push(obj! { "op" => "admit", "now" => now, "request" => request(id), "method" => "take", "args" => obj! {} });
		}
		lines.push(obj! { "op" => "nextExpiry", "now" => now });
	}
	compare(&resolve(&lines), "claim retention");
}

#[test]
fn a_served_wait_remembers_its_request() {
	// a wait admitted as a request ("wait", decided with the waiter's id) gives the transaction of its served take the
	// request's key
	let lines = vec![
		init(obj! {}),
		obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } },
		obj! { "op" => "admit", "now" => 1000.0, "request" => request("r1"), "method" => "wait", "args" => obj! {} },
		obj! { "op" => "addWaiter", "now" => 1000.0, "w" => obj! { "template" => obj! { "type" => "Task" }, "take" => true, "target" => "a", "timeout" => 5000.0 } },
		obj! { "op" => "decide", "now" => 1000.0, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => "w0a0b0c0d-1" } },
		write(1, 5000.0, 1100.0),
		obj! { "op" => "stats", "now" => 1100.0, "dump" => true },
	];
	let lines = resolve(&lines);
	compare(&lines, "a served wait");
	let mut d = Driver::new();
	for l in &lines {
		let _ = d.step(l);
	}
	assert!(d.space.state.txns.iter().any(|t| t.rest.get("originRequestKey").is_some()), "the served take's transaction carries the request's key");
}

fn notify_line(now: f64, extra: Json) -> Json {
	let mut l = obj! { "op" => "notify", "now" => now, "tmpl" => obj! { "type" => "Task" }, "lease" => 60_000.0, "handback" => obj! { "s" => 1.0 }, "target" => "a", "as" => "a" };
	if let (Json::Object(o), Json::Object(x)) = (&mut l, extra) {
		for (k, v) in x.iter() {
			o.insert(k, v.clone());
		}
	}
	l
}
fn mail(now: f64, pad: usize) -> Json {
	let event = obj! { "kind" => "entry", "eventId" => "nx", "seq" => 1.0, "handback" => Json::Null, "target" => "a", "entry" => obj! { "pad" => "x".repeat(pad) } };
	obj! { "op" => "appendMail", "now" => now, "principal" => obj! { "peerId" => "p1" }, "event" => event }
}

#[test]
fn subscriptions_at_their_edges() {
	// a write exactly one interval after the last event is sent, not counted
	let mut lines = vec![init(obj! { "notifyIntervalMs" => 500.0 }), notify_line(1000.0, obj! {})];
	for now in [1000.0, 1200.0, 1499.0, 1500.0, 1700.0, 2000.0, 2001.0] {
		lines.push(write(1, 60_000.0, now));
	}
	lines.push(obj! { "op" => "nextExpiry", "now" => 2001.0 });
	lines.push(obj! { "op" => "settle", "now" => 2600.0 });
	compare(&lines, "the rate limit at its edge");
	// a subscription lapsing with a bundled event pending costs its handback, the pending entry and 512
	edge("a subscription lapsing at the commit budget", 1400, 3000, |max| {
		let mut lines = vec![init(obj! { "maxCommitBytes" => max as f64, "notifyIntervalMs" => 5000.0 })];
		for i in 0..3 {
			lines.push(notify_line(1000.0, obj! { "lease" => 2000.0, "handback" => obj! { "s" => i as f64 } }));
		}
		lines.push(write(10, 60_000.0, 1000.0));
		lines.push(write(200, 60_000.0, 1100.0));
		lines.push(obj! { "op" => "settle", "now" => 3000.0 });
		lines.push(obj! { "op" => "nextExpiry", "now" => 3000.0 });
		lines.push(obj! { "op" => "settle", "now" => 3000.0 });
		lines
	});
	// a subscription made under a transaction sees the writes under it, and they must fit the outbox
	edge("a transaction's subscription and the outbox", 2, 1500, |max| {
		vec![
			init(obj! { "maxOutboxBytes" => max as f64 }),
			obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 60_000.0 },
			obj! { "op" => "notify", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" }, "txn" => "t0a0b0c0d-1", "lease" => 60_000.0, "target" => "a" },
			obj! { "op" => "write", "now" => 1000.0, "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => 1.0 } }, "lease" => 5000.0, "txn" => "t0a0b0c0d-1" },
			obj! { "op" => "write", "now" => 1000.0, "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => 2.0 } }, "lease" => 5000.0, "txn" => "t0a0b0c0d-1" },
			obj! { "op" => "commitTxn", "now" => 1000.0, "id" => "t0a0b0c0d-1" },
		]
	});
}

#[test]
fn mailboxes_at_their_edges() {
	edge("maxMailboxBytes", 100, 1500, |max| {
		let mut lines = vec![init(obj! { "maxMailboxBytes" => max as f64 })];
		for i in 0..4 {
			lines.push(mail(1000.0, 20 * i));
		}
		lines.push(obj! { "op" => "events", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } });
		lines
	});
	// the mailboxes count with their tally in the document's bytes
	edge("maxDocBytes with mailboxes", 900, 4000, |max| {
		vec![init(obj! { "maxDocBytes" => max as f64 }), mail(1000.0, 100), obj! { "op" => "appendMail", "now" => 1000.0, "principal" => obj! { "peerId" => "p2" }, "event" => obj! { "kind" => "x" } }, write(300, 5000.0, 1000.0)]
	});
	// a completing event that does not fit the mailbox waits in a job; an ack makes the job due at once
	let w = obj! { "template" => obj! { "type" => "None" }, "take" => false, "target" => "a", "timeout" => 100.0, "handback" => obj! { "h" => "x".repeat(200) }, "consumer" => obj! { "peerId" => "p1" } };
	let p1 = || obj! { "peerId" => "p1" };
	let mut lines = vec![init(obj! { "maxMailboxBytes" => 700.0 }), mail(1000.0, 300), obj! { "op" => "addWaiter", "now" => 1000.0, "w" => w }];
	lines.push(obj! { "op" => "settle", "now" => 1100.0 });
	lines.push(obj! { "op" => "nextExpiry", "now" => 1100.0 });
	lines.push(obj! { "op" => "events", "now" => 1100.0, "principal" => p1() });
	lines.push(obj! { "op" => "settle", "now" => 1200.0 });
	compare(&lines, "a job for a full mailbox");
	// the ack needs the epoch the mailbox has now: read it from the Rust side, then replay both
	let mut d = Driver::new();
	for l in &lines {
		let _ = d.step(l);
	}
	let (_, b) = &d.space.state.mailboxes.as_ref().unwrap()[0];
	lines.push(obj! { "op" => "ack", "now" => 1300.0, "principal" => p1(), "mailboxEpoch" => b.epoch.as_str(), "upTo" => b.delivered });
	lines.push(obj! { "op" => "nextExpiry", "now" => 1300.0 });
	lines.push(obj! { "op" => "settle", "now" => 1300.0 });
	lines.push(obj! { "op" => "events", "now" => 1300.0, "principal" => p1() });
	compare(&lines, "an ack resumes the job");
	assert!(d.space.state.rest.get("jobs").and_then(Json::as_array).is_some_and(|j| !j.is_empty()), "the case makes a job");
}

fn snap(now: f64, tmpl: &str, max: f64, after: Option<&str>) -> Json {
	let mut o = obj! { "maxBytes" => max };
	if let (Some(a), Json::Object(m)) = (after, &mut o) {
		m.insert("after", a.into());
	}
	obj! { "op" => "snapshotPage", "now" => now, "tmpl" => obj! { "type" => tmpl }, "o" => o }
}
fn typed_write(type_: &str, pad: usize) -> Json { obj! { "op" => "write", "now" => 1000.0, "entry" => obj! { "type" => type_, "fields" => obj! { "pad" => "x".repeat(pad) } }, "lease" => 60_000.0 } }

#[test]
fn entry_snapshots_at_their_edges() {
	// a read that fits one page makes no snapshot
	edge("a whole read or a snapshot", 100, 1500, |max| {
		let mut lines = vec![init(obj! {})];
		for i in 0..3 {
			lines.push(typed_write("Task", 50 * i));
		}
		lines.push(snap(1000.0, "Task", max as f64, None));
		lines
	});
	// a snapshot lives snapshotTtlMs: at its expiry it is gone
	for at in [1999.0, 2000.0] {
		let mut lines = vec![init(obj! { "snapshotTtlMs" => 1000.0 })];
		for _ in 0..4 {
			lines.push(typed_write("Task", 100));
		}
		lines.push(snap(1000.0, "Task", 500.0, None));
		lines.push(snap(at, "Task", 500.0, Some("$next1")));
		let lines = resolve(&lines);
		assert_paged(&lines);
		compare(&lines, &format!("a snapshot read at {at}"));
	}
	// eviction: snapshots read to their end go first, then the least recently used
	let mut lines = vec![init(obj! { "maxSnapshots" => 2.0 })];
	for t in ["A", "B", "C"] {
		for _ in 0..3 {
			lines.push(typed_write(t, 120));
		}
	}
	lines.push(snap(1000.0, "A", 500.0, None)); // A: page 1
	lines.push(snap(1001.0, "B", 500.0, None)); // B: page 1
	lines.push(snap(1002.0, "A", 500.0, Some("$next1"))); // A used again
	lines.push(snap(1003.0, "B", 2000.0, Some("$next2"))); // B read to its end
	lines.push(snap(1004.0, "C", 500.0, None)); // C evicts B (read), not A
	lines.push(snap(1005.0, "A", 500.0, Some("$next3")));
	lines.push(snap(1006.0, "B", 500.0, Some("$next2")));
	lines.push(snap(1007.0, "C", 500.0, Some("$next4")));
	let lines = resolve(&lines);
	assert_paged(&lines);
	compare(&lines, "snapshot eviction");
	// without one read to its end, the least recently used goes: a page read moves its snapshot to the end
	let mut lines = vec![init(obj! { "maxSnapshots" => 2.0 })];
	for t in ["A", "B", "C"] {
		for _ in 0..3 {
			lines.push(typed_write(t, 120));
		}
	}
	lines.push(snap(1000.0, "A", 500.0, None)); // A: page 1 of 3
	lines.push(snap(1001.0, "B", 500.0, None)); // B: page 1 of 3
	lines.push(snap(1002.0, "A", 500.0, Some("$next1"))); // A: page 2, now the most recently used
	lines.push(snap(1003.0, "C", 500.0, None)); // C evicts B
	lines.push(snap(1004.0, "B", 500.0, Some("$next2")));
	lines.push(snap(1005.0, "A", 500.0, Some("$next3")));
	let lines = resolve(&lines);
	assert_paged(&lines);
	compare(&lines, "least recently used snapshot evicted");
	// the bytes of all snapshots of a stream are bounded: an older one is evicted, a too large one refused
	edge("maxSnapshotBytes", 300, 3000, |max| {
		let mut lines = vec![init(obj! { "maxSnapshotBytes" => max as f64 })];
		for t in ["A", "B"] {
			for _ in 0..3 {
				lines.push(typed_write(t, 120));
			}
		}
		lines.push(snap(1000.0, "A", 500.0, None));
		lines.push(snap(1001.0, "B", 500.0, None));
		lines.push(snap(1002.0, "A", 500.0, Some("$next1")));
		resolve(&lines)
	});
}

/// The case really pages: some snapshot page names a next page.
fn assert_paged(lines: &[Json]) {
	let mut d = Driver::new();
	let paged = lines.iter().any(|l| d.step(l).is_ok_and(|v| v.get("next").and_then(Json::as_str).is_some_and(|n| n.starts_with("ss"))));
	assert!(paged, "the case never pages through a snapshot");
}

const MIB: f64 = 1024.0 * 1024.0;
fn profile(max_count: f64) -> Json { obj! { "taskType" => "Task", "resultTypes" => vec![Json::from("Result")], "equalFields" => vec![Json::from("n")], "maxResultCount" => max_count } }
fn set_profile(max_count: f64) -> Json { obj! { "op" => "setCompletionProfiles", "now" => 1000.0, "profiles" => vec![profile(max_count)] } }
fn task(n: f64, pad: usize) -> Json { obj! { "op" => "write", "now" => 1000.0, "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => n, "pad" => "x".repeat(pad) } }, "lease" => 90_000.0 } }
fn begin() -> Json { obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 60_000.0 } }
const TXN: &str = "t0a0b0c0d-2"; // the task took the first id
fn take_under(txn: &str) -> Json { obj! { "op" => "probe", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" }, "take" => true, "txn" => txn } }
fn result(n: f64, txn: &str) -> Json { obj! { "op" => "write", "now" => 1000.0, "entry" => obj! { "type" => "Result", "fields" => obj! { "n" => n } }, "lease" => 90_000.0, "txn" => txn } }
fn commit(txn: &str) -> Json { obj! { "op" => "commitTxn", "now" => 1000.0, "id" => txn } }

#[test]
fn the_limits_of_the_project_hosts() {
	// spaces-mmo/server/space-host.ts and codemode-chat/server/space-host.ts, on a new space and over limits already set
	let owner = obj! { "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0, "maxClaimBytes" => 512.0 * MIB, "maxDocBytes" => 640.0 * MIB };
	let Json::Object(mut mmo) = owner.clone() else { unreachable!() };
	for (k, v) in [("claimResultMs", 600_000.0), ("generationAdmitMs", 600_000.0), ("maxLogBytes", 512.0 * 1024.0)] {
		mmo.insert(k, Json::Number(v));
	}
	for limits in [owner, Json::Object(mmo)] {
		let line = obj! { "op" => "setLimits", "now" => 1000.0, "limits" => limits };
		compare(&[init(obj! {}), line.clone(), task(1.0, 0), line.clone()], "a project's limits");
		compare(&[init(obj! { "maxEntries" => 5.0 }), obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } }, line], "over limits and claims");
	}
}

#[test]
fn set_limits_at_what_already_stands() {
	let set = |limits: Json| obj! { "op" => "setLimits", "now" => 1000.0, "limits" => limits };
	let mine = obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 60_000.0, "as" => "a" };
	edge("a commit limit under a reservation", 1200, 4000, |max| vec![init(obj! {}), mine.clone(), txn_write(600, 5000.0, 1000.0, "t0a0b0c0d-1"), set(obj! { "maxCommitBytes" => max as f64 })]);
	edge("a job limit under a reservation", 100, 4000, |max| vec![init(obj! {}), mine.clone(), txn_write(600, 5000.0, 1000.0, "t0a0b0c0d-1"), set(obj! { "maxJobBytes" => max as f64 })]);
	edge("an event limit under a subscription", 100, 3000, |max| {
		let wait = obj! { "op" => "addWaiter", "now" => 1000.0, "w" => obj! { "template" => obj! { "type" => "Task" }, "take" => false, "target" => "a", "timeout" => 100_000.0, "handback" => obj! { "h" => 1.0 } } };
		vec![init(obj! {}), obj! { "op" => "probe", "now" => 1000.0, "tmpl" => obj! { "type" => "None" } }, wait, set(obj! { "maxEventBytes" => max as f64 })]
	});
	compare(&[init(obj! {}), set(obj! { "maxFrameBytes" => 1000.0, "maxCommitBytes" => 900.0 }), set(obj! { "maxCommitBytes" => 1100.0, "maxFrameBytes" => 1200.0 }), set(obj! { "mailboxTtlMs" => 604_800_001.0 }), set(obj! { "maxEntries" => 1.5 })], "refused limits");
}

#[test]
fn a_task_and_its_results() {
	let flow = |results: Vec<Json>, max: f64| {
		let mut l = vec![init(obj! {}), set_profile(max), task(1.0, 0), begin(), take_under(TXN)];
		l.extend(results);
		l.push(commit(TXN));
		l.push(obj! { "op" => "commitTxn", "now" => 1000.0, "id" => TXN });
		l
	};
	compare(&flow(vec![result(1.0, TXN)], 1.0), "one result");
	compare(&flow(vec![], 1.0), "no result");
	compare(&flow(vec![result(2.0, TXN)], 1.0), "the wrong result");
	compare(&flow(vec![result(1.0, TXN), result(1.0, TXN)], 1.0), "too many");
	compare(&flow(vec![result(1.0, TXN), result(1.0, TXN)], 2.0), "two allowed");
	compare(&flow(vec![result(1.0, TXN), result(2.0, TXN)], 2.0), "one unmatched");
	compare(&[init(obj! {}), set_profile(1.0), task(1.0, 0), take_under("t-none"), obj! { "op" => "probe", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" }, "take" => true }], "a take without a transaction");
	compare(&[init(obj! {}), begin(), set_profile(1.0)], "profiles after a transaction opened");
	let gated_elsewhere = obj! { "op" => "setCompletionProfiles", "now" => 1000.0, "profiles" => vec![obj! { "taskType" => "", "resultTypes" => Vec::<Json>::new(), "equalFields" => Vec::<Json>::new(), "maxResultCount" => 1.0 }] };
	compare(&[init(obj! {}), gated_elsewhere], "an invalid profile");
	// the deadline a task sets binds the lease of its transaction
	let bound = obj! { "op" => "setCompletionProfiles", "now" => 1000.0, "profiles" => vec![obj! { "taskType" => "Task", "resultTypes" => vec![Json::from("Result")], "equalFields" => vec![Json::from("n")], "maxResultCount" => 1.0, "maxLeaseMs" => 500.0, "maxResultBytes" => 40.0 }] };
	compare(&[init(obj! {}), bound.clone(), task(1.0, 0), begin(), take_under(TXN), obj! { "op" => "renew", "now" => 1000.0, "id" => TXN, "ms" => 501.0 }, obj! { "op" => "renew", "now" => 1000.0, "id" => TXN, "ms" => 500.0 }, result(1.0, TXN), commit(TXN)], "a lease at the boundary");
	compare(&[init(obj! {}), bound, task(1.0, 0), begin(), take_under(TXN), obj! { "op" => "settle", "now" => 1500.0 }, obj! { "op" => "count", "now" => 1500.0 }], "the boundary ends the transaction");
	// the results of a task at maxResultBytes
	edge("maxResultBytes", 20, 120, |max| {
		let p = obj! { "taskType" => "Task", "resultTypes" => vec![Json::from("Result")], "equalFields" => vec![Json::from("n")], "maxResultCount" => 1.0, "maxResultBytes" => max as f64 };
		vec![init(obj! {}), obj! { "op" => "setCompletionProfiles", "now" => 1000.0, "profiles" => vec![p] }, task(1.0, 0), begin(), take_under(TXN), result(1.0, TXN), commit(TXN)]
	});
	// a captured task needs room in the commit budget
	edge("the capture of a task", 1200, 6000, |max| vec![init(obj! { "maxCommitBytes" => max as f64 }), set_profile(1.0), task(1.0, 900), begin(), take_under(TXN), result(1.0, TXN), commit(TXN)]);
}

#[test]
fn waits_on_profiled_tasks() {
	let wait = |id: &str| obj! { "op" => "park", "now" => 1000.0, "key" => id, "tmpl" => obj! { "type" => "Task" }, "take" => true, "deadline" => 50_000.0 };
	let lines = vec![
		init(obj! {}),
		set_profile(1.0),
		obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } },
		obj! { "op" => "admit", "now" => 1000.0, "request" => request("r1"), "method" => "take", "args" => obj! {} },
		wait("$key"),
		task(1.0, 0),
		obj! { "op" => "lookup", "now" => 1000.0, "request" => request("r1") },
		obj! { "op" => "count", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" } },
	];
	compare(&resolve(&lines), "a request without a transaction");
	// a wait takes under a fresh transaction, which then owes the result
	let waiter = obj! { "op" => "addWaiter", "now" => 1000.0, "w" => obj! { "template" => obj! { "type" => "Task" }, "take" => true, "target" => "a", "timeout" => 100_000.0, "txnLeaseMs" => 30_000.0 } };
	compare(&[init(obj! {}), set_profile(1.0), waiter, task(1.0, 0), commit("t0a0b0c0d-3"), result(1.0, "t0a0b0c0d-3"), commit("t0a0b0c0d-3")], "a served wait");
}

#[test]
fn cancelling_a_request() {
	let cancel = |id: &str| obj! { "op" => "cancelRequest", "now" => 1000.0, "target" => request(id) };
	let lines = vec![
		init(obj! {}),
		obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } },
		cancel("r0"),
		obj! { "op" => "admit", "now" => 1000.0, "request" => request("r1"), "method" => "take", "args" => obj! {} },
		obj! { "op" => "park", "now" => 1000.0, "key" => "$key", "tmpl" => obj! { "type" => "Task" }, "take" => true, "deadline" => 50_000.0 },
		cancel("r1"),
		cancel("r1"),
		task(1.0, 0),
		obj! { "op" => "count", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" } },
		obj! { "op" => "admit", "now" => 1000.0, "request" => request("r2"), "method" => "take", "args" => obj! {} },
		obj! { "op" => "decide", "now" => 1000.0, "key" => "$key", "outcome" => obj! { "state" => "done", "result" => 7.0 } },
		cancel("r2"),
	];
	compare(&resolve(&lines), "a cancelled request");
}

#[test]
fn releasing_a_transaction() {
	let release = |id: &str, now: f64| obj! { "op" => "releaseTxn", "now" => now, "id" => id };
	compare(&[init(obj! {}), release("t-none", 1000.0), begin(), task(1.0, 0), take_under("t0a0b0c0d-1"), release("t0a0b0c0d-1", 1000.0), release("t0a0b0c0d-1", 1000.0), obj! { "op" => "count", "now" => 1000.0, "tmpl" => obj! { "type" => "Task" } }], "a release");
	// the entry goes back and serves who waits for it
	let waiting = vec![
		init(obj! {}),
		begin(),
		task(1.0, 0),
		take_under("t0a0b0c0d-1"),
		obj! { "op" => "issueGeneration", "now" => 1000.0, "principal" => obj! { "peerId" => "p1" } },
		obj! { "op" => "admit", "now" => 1000.0, "request" => request("r1"), "method" => "take", "args" => obj! {} },
		obj! { "op" => "park", "now" => 1000.0, "key" => "$key", "tmpl" => obj! { "type" => "Task" }, "take" => true, "deadline" => 50_000.0 },
		release("t0a0b0c0d-1", 1000.0),
		obj! { "op" => "lookup", "now" => 1000.0, "request" => request("r1") },
	];
	compare(&resolve(&waiting), "a release serves a wait");
	// a transaction whose reservation just fits, and one expiry before it in the same commit: it waits in the queue
	let queued = |max: f64| {
		let mut l = vec![init(obj! { "maxCommitBytes" => max }), obj! { "op" => "createTxn", "now" => 1000.0, "lease" => 90_000.0, "as" => "a" }, txn_write(300, 90_000.0, 1000.0, "t0a0b0c0d-1")];
		l.extend((0..6).map(|_| write(0, 100.0, 1000.0)));
		l.extend([release("t0a0b0c0d-1", 2000.0), obj! { "op" => "nextExpiry", "now" => 2000.0 }, obj! { "op" => "settle", "now" => 2000.0 }, obj! { "op" => "settle", "now" => 2000.0 }]);
		l
	};
	let in_queue = |max: f64| {
		let mut d = Driver::new();
		queued(max).iter().any(|l| { let _ = d.step(l); d.space.state.rest.get("releaseQueue").and_then(Json::as_array).is_some_and(|q| !q.is_empty()) })
	};
	let max = (1300..4000).map(f64::from).find(|m| in_queue(*m)).expect("some budget queues the release");
	compare(&queued(max), "a queued release");
	// entries lapsing in the same commit leave too little: the release is queued for later
	edge("a release under the commit budget", 1300, 4000, |max| {
		let mut l = vec![init(obj! { "maxCommitBytes" => max as f64 }), begin(), txn_write(300, 90_000.0, 1000.0, "t0a0b0c0d-1")];
		l.extend((0..6).map(|_| write(0, 100.0, 1000.0)));
		l.extend([release("t0a0b0c0d-1", 2000.0), obj! { "op" => "stats", "now" => 2000.0 }, obj! { "op" => "settle", "now" => 2000.0 }, obj! { "op" => "nextExpiry", "now" => 2000.0 }, obj! { "op" => "settle", "now" => 2000.0 }]);
		l
	});
}
