// R5b: the paths of the RunGates a random walk rarely meets, line for line against the TypeScript core.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{digest_json, obj, Json};

struct Both {
	rust: Driver,
	ts: TsDriver,
	now: f64,
	steps: usize,
}

impl Both {
	fn new(limits: Json) -> Both {
		let mut b = Both { rust: Driver::new(), ts: TsDriver::start(), now: 1000.0, steps: 0 };
		let _ = b.step(obj! { "op" => "init", "seed" => "gates", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d", "limits" => limits });
		b
	}
	/// One line on both: same answer, same state. The answer, or the refusal as `Class: message`.
	fn step(&mut self, mut line: Json) -> Result<Json, String> {
		self.now += 10.0;
		self.steps += 1;
		if let (Json::Object(o), false) = (&mut line, self.steps == 1) {
			o.insert("now", Json::Number(self.now));
		}
		let got = self.rust.step(&line).map_err(|e| format!("{}: {}", e.class, e.message));
		let t = self.ts.step(&line);
		let want = if t.get("ok") == Some(&Json::Bool(true)) {
			Ok(t.get("result").cloned().unwrap_or(Json::Null))
		} else {
			let text = |k: &str| t.get(k).and_then(Json::as_str).unwrap_or("").to_owned();
			Err(format!("{}: {}", text("error"), text("message")))
		};
		assert_eq!(got.as_ref().map(|v| v.canonical().unwrap()), want.as_ref().map(|v| v.canonical().unwrap()), "{}", line.to_json_text());
		assert_eq!(digest_json(&self.rust.space.state.to_json()).unwrap(), t.get("state").and_then(Json::as_str).unwrap(), "state after {}", line.to_json_text());
		got
	}
	fn gate(&mut self, run: &str, command: &str, kind: &str, revision: f64) -> Result<Json, String> {
		self.step(obj! { "op" => "applyRunGate", "command" => obj! { "runId" => run, "commandId" => command, "kind" => kind, "revision" => revision } })
	}
	fn profile(&mut self) -> Result<Json, String> { self.step(obj! { "op" => "setCompletionProfiles", "profiles" => vec![gated()] }) }
	fn task(&mut self, run: &str) -> Result<Json, String> { self.step(obj! { "op" => "write", "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => 1.0, "run" => run } }, "lease" => 50_000.0 }) }
	/// A transaction that took a task of a running run.
	fn bound(&mut self) -> String {
		let t = self.step(obj! { "op" => "createTxn", "lease" => 40_000.0 }).unwrap();
		let id = t.as_str().map(str::to_owned).or_else(|| t.get("id").and_then(Json::as_str).map(str::to_owned)).unwrap();
		let got = self.step(obj! { "op" => "probe", "tmpl" => obj! { "type" => "Task" }, "take" => true, "txn" => id.as_str() }).unwrap();
		assert_eq!(got.get("status").and_then(Json::as_str), Some("found"), "{}", got.to_json_text());
		id
	}
}

fn gated() -> Json { obj! { "taskType" => "Task", "resultTypes" => vec![Json::from("Result")], "equalFields" => vec![Json::from("n"), Json::from("run")], "maxResultCount" => 1.0, "maxLeaseMs" => 30_000.0, "gateField" => "run" } }
fn refused(r: Result<Json, String>, part: &str) {
	let e = r.expect_err("a refusal");
	assert!(e.contains(part), "{e}");
}
fn phase(r: Result<Json, String>) -> String { r.unwrap().get("phase").and_then(Json::as_str).unwrap().to_owned() }

#[test]
fn a_barrier_lets_bound_work_finish_but_not_grow() {
	let mut b = Both::new(obj! {});
	refused(b.gate("r", "c1", "prepare", 1.0), "no gated completion profile");
	b.profile().unwrap();
	b.gate("r", "c1", "prepare", 1.0).unwrap();
	b.task("r").unwrap();
	b.gate("r", "c2", "release", 2.0).unwrap();
	let t = b.bound();
	assert_eq!(phase(b.gate("r", "c3", "pause", 3.0)), "fenced");
	refused(b.step(obj! { "op" => "renew", "id" => t.as_str(), "ms" => 1000.0 }), "is pausing");
	assert_eq!(phase(b.gate("r", "c3", "pause", 3.0)), "fenced", "the same command again");
	refused(b.gate("r", "other", "pause", 3.0), "belongs to another command");
	refused(b.gate("r", "c3", "stop", 3.0), "belongs to another command");
	refused(b.gate("r", "c4", "stop", 4.0), "unfinished pause");
	assert_eq!(b.gate("r", "c1", "prepare", 1.0).unwrap().get("state").and_then(Json::as_str), Some("preparing"), "an old command gets its stored answer");
	b.step(obj! { "op" => "write", "entry" => obj! { "type" => "Result", "fields" => obj! { "n" => 1.0, "run" => "r" } }, "txn" => t.as_str() }).unwrap();
	b.step(obj! { "op" => "commitTxn", "id" => t.as_str() }).unwrap();
	assert_eq!(phase(b.gate("r", "c3", "pause", 3.0)), "applied", "the commit ended the barrier");
	refused(b.gate("r", "x", "pause", 2.0), "belongs to another command");
	b.gate("r", "c5", "resume", 7.0).unwrap();
	refused(b.gate("r", "gap", "pause", 5.0), "older than the gate");
	assert_eq!(phase(b.gate("r", "c6", "stop", 8.0)), "applied", "nothing is bound");
	refused(b.gate("r", "c7", "resume", 9.0), "is stopped");
}

#[test]
fn a_stop_without_a_gate_is_terminal_and_gates_keep_their_profiles() {
	let mut b = Both::new(obj! {});
	b.profile().unwrap();
	b.gate("late", "c1", "stop", 1.0).unwrap();
	refused(b.gate("late", "c2", "prepare", 2.0), "is stopped");
	refused(b.gate("none", "c1", "release", 1.0), "has no gate");
	b.step(obj! { "op" => "setCompletionProfiles", "profiles" => Vec::<Json>::new() }).unwrap();
	b.profile().unwrap();
	b.gate("r", "c1", "prepare", 1.0).unwrap();
	refused(b.step(obj! { "op" => "setCompletionProfiles", "profiles" => Vec::<Json>::new() }), "gated profiles cannot change");
	b.gate("r", "c2", "stop", 2.0).unwrap();
	b.step(obj! { "op" => "setCompletionProfiles", "profiles" => Vec::<Json>::new() }).unwrap();
	refused(b.step(obj! { "op" => "applyRunGate", "command" => obj! { "runId" => "-bad", "commandId" => "c", "kind" => "stop", "revision" => 1.0 } }), "invalid RunGate command");
	refused(b.step(obj! { "op" => "applyRunGate", "command" => obj! { "runId" => "r", "commandId" => "c", "kind" => "stop", "revision" => 0.0 } }), "invalid RunGate command");
}

#[test]
fn the_history_keeps_its_last_entries() {
	let mut b = Both::new(obj! {});
	b.profile().unwrap();
	b.gate("r", "c1", "prepare", 1.0).unwrap();
	b.gate("r", "c2", "release", 2.0).unwrap();
	let mut revision = 2.0;
	for i in 0..20 {
		revision += 1.0;
		b.gate("r", &format!("p{i}"), "pause", revision).unwrap();
		revision += 1.0;
		b.gate("r", &format!("r{i}"), "resume", revision).unwrap();
	}
	assert_eq!(b.rust.space.state.rest.get("runGates").and_then(|g| g.get("r")).and_then(|g| g.get("history")).and_then(Json::as_array).unwrap().len(), 32);
	refused(b.gate("r", "c1", "prepare", 1.0), "older than the gate");
}

#[test]
fn a_release_serves_a_waiting_take() {
	let mut b = Both::new(obj! {});
	b.profile().unwrap();
	b.gate("r", "c1", "prepare", 1.0).unwrap();
	b.task("r").unwrap();
	let w = obj! { "op" => "addWaiter", "w" => obj! { "take" => true, "template" => obj! { "type" => "Task" }, "txn" => Json::Null, "deadline" => 900_000.0, "txnLeaseMs" => 20_000.0, "handback" => "h", "target" => obj! { "peerId" => "a" } } };
	b.step(w).unwrap();
	b.gate("r", "c2", "release", 2.0).unwrap();
	assert_eq!(b.rust.space.state.txns.len(), 1, "the waiter took it and opened its transaction");
}

/// Runs a sequence for each `maxDocBytes`; it has to be refused somewhere, and both cores agree on every step at each.
#[test]
fn a_gate_is_charged_to_the_document() {
	let mut flips = vec![];
	for max in (900..3700).step_by(40) {
		let mut b = Both::new(obj! { "maxDocBytes" => max as f64 });
		let _ = b.profile();
		let mut seen = String::new();
		let _ = b.gate("r", "c1", "prepare", 1.0).map_err(|e| seen = e);
		let _ = b.gate("q", "c1", "prepare", 1.0).map_err(|e| seen = e);
		let _ = b.gate("r", "c2", "release", 2.0).map_err(|e| seen = e);
		let _ = b.step(obj! { "op" => "write", "entry" => obj! { "type" => "Note", "fields" => obj! { "pad" => "x".repeat(200) } }, "lease" => 5000.0, "as" => "a" }).map_err(|e| seen = e);
		flips.push(seen);
	}
	assert!(flips.iter().any(|s| s.contains("exceeds maxDocBytes")), "{flips:?}");
	assert!(flips.iter().any(String::is_empty), "{flips:?}");
}
