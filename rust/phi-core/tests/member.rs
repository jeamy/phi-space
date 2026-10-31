// R5b: member admission, line for line against the TypeScript core: what a random walk rarely reaches of drain and placement.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{digest_json, obj, Json};

struct Both {
	rust: Driver,
	ts: TsDriver,
	now: f64,
	first: bool,
}

fn strings(l: &[&str]) -> Json { Json::Array(l.iter().map(|s| Json::from(*s)).collect()) }
fn profile(max_count: f64) -> Json { obj! { "taskType" => "Task", "resultTypes" => strings(&["Result"]), "equalFields" => strings(&["n"]), "maxResultCount" => max_count, "maxResultBytes" => 300.0, "maxLeaseMs" => 5000.0 } }
fn policy() -> Json {
	let rules = vec![
		obj! { "type" => "Task", "mode" => "local", "member" => "m1" },
		obj! { "type" => "Result", "mode" => "local", "member" => "m1" },
		obj! { "type" => "Far", "mode" => "local", "member" => "m2" },
		obj! { "type" => "Shard", "mode" => "expand", "by" => obj! { "field" => "k" }, "members" => strings(&["m1", "m2", "m3"]) },
		obj! { "type" => "Pool", "mode" => "expand", "by" => "type", "members" => strings(&["m1", "m2", "m3"]) },
		obj! { "type" => "Pick", "mode" => "expand", "by" => "selection", "members" => strings(&["m1", "m2"]) },
		obj! { "type" => "Merged", "mode" => "sync", "variant" => "lww", "member" => "m1" },
		obj! { "type" => "Child", "mode" => "local", "member" => "m1", "supertypes" => strings(&["Parent"]) },
		obj! { "type" => "Parent", "mode" => "local", "member" => "m1", "supertypes" => strings(&["Root"]) },
		obj! { "type" => "A", "mode" => "local", "member" => "m1", "supertypes" => strings(&["B"]) },
		obj! { "type" => "B", "mode" => "local", "member" => "m1", "supertypes" => strings(&["A"]) },
	];
	obj! { "authorityId" => "a", "policyVersion" => 1.0, "rules" => rules, "completionProfiles" => vec![profile(1.0)], "default" => obj! { "mode" => "local", "member" => "m1" } }
}
fn member(state: &str) -> Json { obj! { "op" => "setMembership", "membership" => obj! { "memberId" => "m1", "authorityId" => "a", "policy" => policy(), "state" => state, "admissionVersion" => 3.0, "transitionId" => "t" } } }
fn entry(t: &str, fields: Json) -> Json { obj! { "type" => t, "fields" => fields } }

impl Both {
	fn new(limits: Json) -> Both {
		let mut b = Both { rust: Driver::new(), ts: TsDriver::start(), now: 1000.0, first: true };
		let _ = b.step(obj! { "op" => "init", "seed" => "member", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d", "limits" => limits });
		b
	}
	fn step(&mut self, mut line: Json) -> Result<Json, String> {
		self.now += 10.0;
		if let (Json::Object(o), false) = (&mut line, self.first) {
			o.insert("now", Json::Number(self.now));
		}
		self.first = false;
		let got = self.rust.step(&line).map_err(|e| format!("{}: {}", e.class, e.message));
		let t = self.ts.step(&line);
		let text = |k: &str| t.get(k).and_then(Json::as_str).unwrap_or("").to_owned();
		let want = if t.get("ok") == Some(&Json::Bool(true)) { Ok(t.get("result").cloned().unwrap_or(Json::Null)) } else { Err(format!("{}: {}", text("error"), text("message"))) };
		assert_eq!(got.as_ref().map(|v| v.canonical().unwrap()), want.as_ref().map(|v| v.canonical().unwrap()), "{}", line.to_json_text());
		assert_eq!(digest_json(&self.rust.space.state.to_json()).unwrap(), t.get("state").and_then(Json::as_str).unwrap(), "state after {}", line.to_json_text());
		got
	}
	fn write(&mut self, e: Json, txn: Option<&str>) -> Result<Json, String> {
		let mut l = obj! { "op" => "write", "entry" => e, "lease" => 50_000.0 };
		if let (Json::Object(o), Some(t)) = (&mut l, txn) {
			o.insert("txn", t.into());
		}
		self.step(l)
	}
	fn txn(&mut self, lease: f64) -> String {
		let t = self.step(obj! { "op" => "createTxn", "lease" => lease }).unwrap();
		t.as_str().map(str::to_owned).or_else(|| t.get("id").and_then(Json::as_str).map(str::to_owned)).unwrap()
	}
	fn take(&mut self, tmpl: Json, txn: Option<&str>) -> Result<Json, String> {
		let mut l = obj! { "op" => "probe", "tmpl" => tmpl, "take" => true };
		if let (Json::Object(o), Some(t)) = (&mut l, txn) {
			o.insert("txn", t.into());
		}
		self.step(l)
	}
}
fn refused(r: Result<Json, String>, part: &str) {
	let e = r.expect_err(part);
	assert!(e.contains(part), "{e}");
}

#[test]
fn a_write_goes_where_the_policy_places_it() {
	let mut b = Both::new(obj! {});
	b.step(member("active")).unwrap();
	b.write(entry("Task", obj! { "n" => 1.0 }), None).unwrap();
	b.write(entry("Unknown", obj! {}), None).unwrap();
	refused(b.write(entry("Far", obj! {}), None), "another Member");
	refused(b.write(entry("Shard", obj! {}), None), "HRW field absent");
	for k in 0..12 {
		let _ = b.write(entry("Shard", obj! { "k" => k as f64 }), None);
	}
	let _ = b.write(entry("Pool", obj! {}), None);
	refused(b.write(entry("Merged", obj! {}), None), "unsupported replicated mode");
	refused(b.write(entry("Pick", obj! {}), None), "proven Router placement");
	b.step(obj! { "op" => "permitRoutedWrite", "proven" => true }).unwrap();
	b.write(entry("Pick", obj! {}), None).unwrap();
	let t = b.txn(10_000.0);
	b.step(obj! { "op" => "permitRoutedWrite", "proven" => false }).unwrap();
	b.write(entry("Pick", obj! {}), Some(&t)).unwrap();
	refused(b.write(entry("Child", obj! {}), None), "complete declared supertypes");
	b.write(obj! { "type" => "Child", "types" => strings(&["Root", "Parent"]), "fields" => obj! {} }, None).unwrap();
	refused(b.write(obj! { "type" => "Child", "types" => strings(&["Parent"]), "fields" => obj! {} }, None), "complete declared supertypes");
	refused(b.write(entry("A", obj! {}), None), "cyclic type hierarchy");
	let mut no_policy = obj! { "memberId" => "m1", "authorityId" => "a", "policy" => Json::Null, "state" => "active", "admissionVersion" => 1.0, "transitionId" => "t" };
	if let Json::Object(o) = &mut no_policy {
		o.remove("x");
	}
	b.step(obj! { "op" => "setMembership", "membership" => no_policy }).unwrap();
	refused(b.write(entry("Task", obj! {}), None), "policy is not installed");
}

#[test]
fn a_stopped_member_refuses_new_work_but_lets_go() {
	for state in ["adding", "removing", "detached", "recoveryBlocked", "profileFrozen"] {
		let mut b = Both::new(obj! {});
		b.step(member("active")).unwrap();
		b.write(entry("Note", obj! { "n" => 1.0 }), None).unwrap();
		let t = b.txn(10_000.0);
		b.step(member(state)).unwrap();
		refused(b.write(entry("Note", obj! {}), None), "Member admission is");
		refused(b.take(obj! { "type" => "Note" }, None), "Member admission is");
		refused(b.step(obj! { "op" => "probe", "tmpl" => obj! {}, "take" => false }), "Member admission is");
		refused(b.step(obj! { "op" => "createTxn", "lease" => 1000.0 }), "Member admission is");
		refused(b.step(obj! { "op" => "commitTxn", "id" => t.as_str() }), "Member admission is");
		refused(b.step(obj! { "op" => "renew", "id" => t.as_str(), "ms" => 1000.0 }), "Member admission is");
		refused(b.step(obj! { "op" => "announce", "entry" => entry("Note", obj! {}) }), "Member admission is");
		b.step(obj! { "op" => "abortTxn", "id" => t.as_str() }).unwrap();
	}
}

#[test]
fn a_draining_member_finishes_within_its_allowance() {
	let mut b = Both::new(obj! {});
	b.step(member("active")).unwrap();
	b.step(obj! { "op" => "setCompletionProfiles", "profiles" => vec![profile(2.0)] }).unwrap();
	for n in 0..3 {
		b.write(entry("Task", obj! { "n" => n as f64 }), None).unwrap();
	}
	b.write(entry("Note", obj! { "n" => 1.0 }), None).unwrap();
	let before = b.txn(200_000.0);
	assert!(b.rust.space.state.txns[0].rest.get("completion").is_some());
	b.step(member("draining")).unwrap();
	refused(b.write(entry("Task", obj! {}), None), "no new Task writes");
	refused(b.write(entry("Note", obj! {}), None), "no bounded completion allowance");
	b.write(entry("Note", obj! {}), Some(&before)).unwrap();
	assert!(b.step(obj! { "op" => "renew", "id" => before.as_str(), "ms" => 500_000.0 }).is_err());
	let during = b.txn(200_000.0);
	refused(b.write(entry("Note", obj! {}), Some(&during)), "only bound results");
	let found = b.take(obj! { "type" => "Task", "fields" => obj! { "n" => 1.0 } }, Some(&during)).unwrap();
	assert_eq!(found.get("status").and_then(Json::as_str), Some("found"));
	refused(b.take(obj! { "type" => "Task" }, Some(&during)), "one completion task");
	refused(b.write(entry("Result", obj! { "n" => 2.0 }), Some(&during)), "only bound results");
	b.write(entry("Result", obj! { "n" => 1.0 }), Some(&during)).unwrap();
	refused(b.write(entry("Result", obj! { "n" => 1.0 }), Some(&during)), "no bounded completion allowance");
	b.step(obj! { "op" => "commitTxn", "id" => during.as_str() }).unwrap();
	let plain = b.txn(10_000.0);
	refused(b.take(obj! { "type" => "Note" }, Some(&plain)), "no completion profile");
	refused(b.step(obj! { "op" => "renew", "id" => "e-none", "ms" => 1000.0 }), "");
}

#[test]
fn a_draining_member_shortens_leases_and_serves_only_completion_takes() {
	let mut b = Both::new(obj! {});
	b.step(member("active")).unwrap();
	let id = b.write(entry("Note", obj! { "n" => 1.0 }), None).unwrap();
	let id = id.get("id").and_then(Json::as_str).unwrap().to_owned();
	b.step(member("draining")).unwrap();
	refused(b.step(obj! { "op" => "renew", "id" => id.as_str(), "ms" => 900_000.0 }), "cannot be extended");
	b.step(obj! { "op" => "renew", "id" => id.as_str(), "ms" => 100.0 }).unwrap();
	b.step(member("active")).unwrap();
	b.write(entry("Task", obj! { "n" => 1.0 }), None).unwrap();
	b.write(entry("Note", obj! { "n" => 2.0 }), None).unwrap();
	b.step(member("draining")).unwrap();
	let wait = |t: &str| obj! { "op" => "addWaiter", "w" => obj! { "take" => true, "template" => obj! { "type" => t }, "timeout" => 90_000.0, "txnLeaseMs" => 20_000.0, "handback" => "h", "target" => obj! { "peerId" => "a" } } };
	b.step(wait("Note")).unwrap();
	assert_eq!(b.rust.space.state.txns.len(), 0, "a Note has no completion profile");
	b.step(wait("Task")).unwrap();
	assert_eq!(b.rust.space.state.txns.len(), 1, "the Task is completion work");
	b.step(member("removing")).unwrap();
	b.step(obj! { "op" => "settle" }).unwrap();
}

#[test]
fn a_directory_entry_needs_an_active_member() {
	let mut b = Both::new(obj! {});
	b.step(member("draining")).unwrap();
	refused(b.write(entry("Capability", obj! {}), None), "requires active Member");
	b.step(member("active")).unwrap();
	b.write(entry("Capability", obj! {}), None).unwrap();
}

#[test]
fn the_allowance_counts_against_the_document() {
	let mut seen = vec![];
	for max in (66_000..67_000).step_by(50) {
		let mut b = Both::new(obj! { "maxDocBytes" => max as f64 });
		b.step(member("active")).unwrap();
		seen.push(b.step(obj! { "op" => "createTxn", "lease" => 1000.0 }).is_ok());
	}
	assert!(seen.contains(&true) && seen.contains(&false), "{seen:?}");
}

#[test]
fn the_allowance_ends_with_its_time() {
	let mut b = Both::new(obj! {});
	b.step(member("active")).unwrap();
	let t = b.txn(500_000.0);
	b.step(member("draining")).unwrap();
	b.write(entry("Note", obj! {}), Some(&t)).unwrap();
	b.now += 70_000.0;
	refused(b.write(entry("Note", obj! {}), Some(&t)), "no bounded completion allowance");
}

#[test]
fn what_one_transaction_reserves_counts_for_the_next() {
	let mut seen = vec![];
	for max in (131_000..134_000).step_by(100) {
		let mut b = Both::new(obj! { "maxDocBytes" => max as f64 });
		b.step(member("active")).unwrap();
		let first = b.step(obj! { "op" => "createTxn", "lease" => 1000.0 }).is_ok();
		seen.push((first, b.step(obj! { "op" => "createTxn", "lease" => 1000.0 }).is_ok()));
	}
	assert!(seen.contains(&(true, true)) && seen.contains(&(true, false)), "{seen:?}");
}

#[test]
fn a_member_blocked_for_recovery_cannot_say_a_request_never_came() {
	let mut b = Both::new(obj! {});
	b.step(member("active")).unwrap();
	let principal = obj! { "peerId" => "p" };
	let g = b.step(obj! { "op" => "issueGeneration", "principal" => principal.clone(), "options" => obj! { "key" => "fixed-key", "authorityId" => "a", "primaryEpoch" => 1.0 } }).unwrap();
	let generation = g.get("generation").and_then(Json::as_str).unwrap();
	let ask = obj! { "op" => "resolveAdmission", "request" => obj! { "principal" => principal, "generation" => generation, "requestId" => "never" }, "method" => "write", "argumentHash" => "a".repeat(64), "primaryEpoch" => 1.0 };
	assert_eq!(b.step(ask.clone()).unwrap().get("state").and_then(Json::as_str), Some("notAdmitted"));
	b.step(member("recoveryBlocked")).unwrap();
	refused(b.step(ask), "uninterrupted current history");
}
