// R6a: `validateFederationPolicy` against TypeScript: policies a seeded random hand spoils, alone and as the successor of another,
// each verdict and each message compared. `PHI_POLICY_CASES` sets how many.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{obj, Json};

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: u64) -> u64 { self.next() % n }
	fn pick<T: Clone>(&mut self, v: &[T]) -> T { v[self.below(v.len() as u64) as usize].clone() }
}

fn strings(l: &[&str]) -> Json { Json::Array(l.iter().map(|s| Json::from(*s)).collect()) }
fn member(id: &str, state: &str) -> Json { obj! { "id" => id, "state" => state, "target" => obj! { "authorityId" => "a" } } }
fn table() -> Json {
	let mut o = phi_json::Object::new();
	for (id, state) in [("m1", "active"), ("m2", "active"), ("m3", "draining"), ("gone", "detached")] {
		o.insert(id, member(id, state));
	}
	let mut other = member("far", "active");
	if let Json::Object(m) = &mut other {
		m.insert("target", obj! { "authorityId" => "b" });
	}
	o.insert("far", other);
	let mut merge = member("mg", "active");
	if let Json::Object(m) = &mut merge {
		m.insert("entryReplication", obj! { "rules" => vec![obj! { "type" => "Merged", "variant" => "lww", "keyFields" => strings(&["k"]) }, obj! { "type" => "Facts", "variant" => "set" }] });
	}
	o.insert("mg", merge);
	let mut primary = member("pr", "active");
	if let Json::Object(m) = &mut primary {
		m.insert("replication", obj! { "primaryReplica" => "r1", "replicaConfigVersion" => 1.0, "durability" => "single" });
	}
	o.insert("pr", primary);
	Json::Object(o)
}
fn profile(task: &str) -> Json { obj! { "taskType" => task, "resultTypes" => strings(&["Done"]), "equalFields" => strings(&["n"]), "maxResultCount" => 1.0, "maxResultBytes" => 1024.0, "maxLeaseMs" => 60_000.0 } }
fn rules() -> Vec<Json> {
	vec![
		obj! { "type" => "Job", "mode" => "local", "member" => "m1" },
		obj! { "type" => "Far", "mode" => "local", "member" => "m2", "supertypes" => strings(&["Base"]) },
		obj! { "type" => "Base", "mode" => "local", "member" => "m2" },
		obj! { "type" => "Shard", "mode" => "expand", "by" => obj! { "field" => "k" }, "members" => strings(&["m1", "m2"]) },
		obj! { "type" => "Pool", "mode" => "expand", "by" => "capacity", "members" => strings(&["m1", "m2", "m3"]) },
		obj! { "type" => "Tool", "mode" => "expand", "by" => "capability", "capability" => "gpu", "members" => strings(&["m1", "m2"]) },
		obj! { "type" => "Merged", "mode" => "sync", "variant" => "lww", "semantics" => "state", "keyFields" => strings(&["k"]), "members" => strings(&["mg"]) },
		obj! { "type" => "Facts", "mode" => "sync", "variant" => "set", "semantics" => "facts", "members" => strings(&["mg"]) },
		obj! { "type" => "Prim", "mode" => "sync", "variant" => "primary", "member" => "pr", "primaryReplica" => "r1", "replicaConfigVersion" => 1.0, "durability" => "single" },
	]
}
fn policy(version: f64) -> Json { obj! { "authorityId" => "a", "policyVersion" => version, "rules" => rules(), "completionProfiles" => vec![profile("Job")], "default" => obj! { "mode" => "local", "member" => "m1" } } }

fn set(v: &mut Json, k: &str, x: Json) {
	if let Json::Object(o) = v {
		o.insert(k, x);
	}
}
fn drop_key(v: &mut Json, k: &str) {
	if let Json::Object(o) = v {
		o.remove(k);
	}
}

/// One spoilt thing, in the shapes the types of a policy allow.
fn spoil(p: &mut Json, r: &mut Rng) {
	let mut rules = p.get("rules").and_then(Json::as_array).cloned().unwrap_or_default();
	let mut profiles = p.get("completionProfiles").and_then(Json::as_array).cloned().unwrap_or_default();
	let at = r.below(rules.len().max(1) as u64) as usize;
	match r.below(30) {
		0 => set(p, "authorityId", r.pick(&["".into(), "__proto__".into(), "b".into(), "x".repeat(129).into()])),
		1 => set(p, "policyVersion", r.pick(&[0.0, 1.5, 2.0, 3.0, 9e15].map(Json::Number))),
		2 => set(p, "default", obj! { "mode" => r.pick(&["local", "expand"]), "member" => r.pick(&["m1", "gone", "none", "m2", ""]) }),
		3 => set(&mut rules[at], "type", r.pick(&["Job", "Capability", "MemberStatus", "constructor", ""]).into()),
		4 => set(&mut rules[at], "supertypes", r.pick(&[strings(&["Job"]), strings(&["Capability"]), strings(&["A", "A"]), strings(&[""]), strings(&["Base", "Other"])])),
		5 => set(&mut rules[at], "member", r.pick(&["m1", "m2", "gone", "far", "none"]).into()),
		6 => {
			drop_key(&mut rules[at], "member");
			set(&mut rules[at], "members", r.pick(&[strings(&[]), strings(&["m1", "m1"]), strings(&["gone"]), strings(&["far"]), strings(&["m2", "m3"]), strings(&["pr"])]));
		}
		7 => set(&mut rules[at], "mode", r.pick(&["local", "expand", "sync", "other"]).into()),
		8 => set(&mut rules[at], "by", r.pick(&["type".into(), "capacity".into(), "capability".into(), "nonsense".into(), obj! { "field" => "" }, obj! { "field" => "n" }])),
		9 => drop_key(&mut rules[at], "capability"),
		10 => set(&mut rules[at], "variant", r.pick(&["primary", "lww", "set", "other"]).into()),
		11 => set(&mut rules[at], "durability", r.pick(&["sync", "single"]).into()),
		12 => set(&mut rules[at], "standbyReplica", r.pick(&["s1", ""]).into()),
		13 => set(&mut rules[at], "replicaConfigVersion", Json::Number(r.pick(&[0.0, 2.0, 1.5]))),
		14 => set(&mut rules[at], "primaryReplica", r.pick(&["r2", ""]).into()),
		15 => set(&mut rules[at], "semantics", r.pick(&["state", "facts", "other"]).into()),
		16 => set(&mut rules[at], "keyFields", r.pick(&[strings(&[]), strings(&["k"]), strings(&["other"])])),
		17 => {
			rules.remove(at);
		}
		18 => {
			let c = rules[at].clone();
			rules.push(c);
		}
		19 => rules.push(obj! { "type" => "New", "mode" => "local", "member" => r.pick(&["m1", "m2", "m3"]) }),
		20 => rules.push(obj! { "type" => "Cycle", "mode" => "local", "member" => "m1", "supertypes" => strings(&["Cycle2"]) }),
		21 => rules.push(obj! { "type" => "Cycle2", "mode" => "local", "member" => "m1", "supertypes" => strings(&["Cycle"]) }),
		22 => profiles.clear(),
		23 => {
			let c = profiles.first().cloned().unwrap_or(profile("Job"));
			profiles.push(c);
		}
		24 => profiles.push(profile(r.pick(&["Far", "Unruled", ""]))),
		25 => {
			if let Some(f) = profiles.first_mut() {
				set(f, r.pick(&["maxResultBytes", "maxResultCount", "maxLeaseMs"]), Json::Number(r.pick(&[0.0, 1.5, -1.0, 2048.0])));
			}
		}
		26 => {
			if let Some(f) = profiles.first_mut() {
				set(f, r.pick(&["resultTypes", "equalFields"]), r.pick(&[strings(&[]), strings(&[""]), strings(&["x"])]));
			}
		}
		27 => {
			if let Some(f) = profiles.first_mut() {
				set(f, "gateField", r.pick(&["n", "other"]).into());
			}
		}
		28 => {
			for _ in 0..200 {
				rules.push(obj! { "type" => format!("T{}", rules.len()), "mode" => "local", "member" => "m1" });
			}
		}
		_ => {
			let deep: Vec<String> = (0..20).map(|i| format!("S{i}")).collect();
			for w in deep.windows(2) {
				rules.push(obj! { "type" => w[0].as_str(), "mode" => "local", "member" => "m1", "supertypes" => vec![Json::from(w[1].as_str())] });
			}
		}
	}
	set(p, "rules", Json::Array(rules));
	set(p, "completionProfiles", Json::Array(profiles));
}

#[test]
fn random_policies_get_the_same_verdict() {
	let cases: u64 = std::env::var("PHI_POLICY_CASES").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let (mut rust, mut ts) = (Driver::new(), TsDriver::start());
	let init = obj! { "op" => "init", "seed" => "policy", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d" };
	let _ = rust.step(&init);
	ts.step(&init);
	let mut r = Rng(0x9e37_79b9_7f4a_7c15);
	let mut seen = std::collections::BTreeMap::<String, u32>::new();
	for _ in 0..cases {
		let with_old = r.below(2) == 0;
		let mut p = policy(if with_old { 2.0 } else { 1.0 });
		for _ in 0..1 + r.below(3) {
			spoil(&mut p, &mut r);
		}
		let allow = r.pick(&[strings(&[]), strings(&["m1"]), strings(&["m1", "m2", "m3"])]);
		let line = obj! { "op" => "validatePolicy", "policy" => p, "table" => table(), "old" => if with_old { policy(1.0) } else { Json::Null }, "allow" => allow, "future" => r.below(3) == 0 };
		let got = rust.step(&line).map(|_| ()).map_err(|e| format!("{}: {}", e.class, e.message));
		let t = ts.step(&line);
		let text = |k: &str| t.get(k).and_then(Json::as_str).unwrap_or("").to_owned();
		let want = if t.get("ok") == Some(&Json::Bool(true)) { Ok(()) } else { Err(format!("{}: {}", text("error"), text("message"))) };
		// a shape TypeScript stumbles over is refused here by name: refused all the same
		if want.as_ref().is_err_and(|m| m.starts_with("TypeError")) {
			assert!(got.is_err(), "{}", line.to_json_text());
		} else {
			assert_eq!(got, want, "{}", line.to_json_text());
		}
		*seen.entry(got.err().unwrap_or_else(|| "accepted".into())).or_default() += 1;
	}
	assert!(seen.len() >= 25, "the walk reaches too little: {seen:#?}");
	assert!(seen.contains_key("accepted"), "{seen:#?}");
}
