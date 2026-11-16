// R6a: placement against TypeScript. Random entries and templates over a policy with every kind of rule, and a Member table whose
// states, capacities and capabilities change; each answer and each refusal compared. `PHI_ROUTING_CASES` sets how many.
mod common;
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{obj, Json, Object};

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

const NOW: f64 = 1_000_000.0;
const TYPES: [&str; 11] = ["Local", "Child", "Parent", "ByType", "ByField", "ByCapacity", "ByCapability", "Primary", "Lww", "Set", "Unknown"];
const IDS: [&str; 5] = ["m1", "m2", "m3", "m4", "m5"];

fn strings(l: &[&str]) -> Json { Json::Array(l.iter().map(|s| Json::from(*s)).collect()) }

fn policy() -> Json {
	let members = strings(&["m1", "m2", "m3"]);
	obj! {
		"authorityId" => "a", "policyVersion" => 1.0, "completionProfiles" => Vec::<Json>::new(),
		"default" => obj! { "mode" => "local", "member" => "m4" },
		"rules" => vec![
			obj! { "type" => "Local", "mode" => "local", "member" => "m1" },
			obj! { "type" => "Parent", "mode" => "local", "member" => "m2" },
			obj! { "type" => "Child", "mode" => "local", "member" => "m3", "supertypes" => strings(&["Parent"]) },
			obj! { "type" => "ByType", "mode" => "expand", "members" => members.clone(), "by" => "type" },
			obj! { "type" => "ByField", "mode" => "expand", "members" => members.clone(), "by" => obj! { "field" => "k" } },
			obj! { "type" => "ByCapacity", "mode" => "expand", "members" => members.clone(), "by" => "capacity" },
			obj! { "type" => "ByCapability", "mode" => "expand", "members" => members.clone(), "by" => "capability", "capability" => "gpu" },
			obj! { "type" => "Primary", "mode" => "sync", "variant" => "primary", "member" => "m5", "primaryReplica" => "r1", "replicaConfigVersion" => 1.0, "durability" => "single" },
			obj! { "type" => "Lww", "mode" => "sync", "variant" => "lww", "members" => members.clone(), "semantics" => "state", "keyFields" => strings(&["k", "l"]) },
			obj! { "type" => "Set", "mode" => "sync", "variant" => "set", "members" => members, "semantics" => "facts" },
		],
	}
}

fn table(r: &mut Rng) -> Json {
	let mut o = Object::new();
	for id in IDS {
		let state = if r.below(4) == 0 { r.pick(&["draining", "detached", "recoveryBlocked", "adding", "removing"]) } else { "active" };
		let mut m = Object::new();
		m.insert("id", id.into());
		m.insert("state", state.into());
		if r.below(5) != 0 {
			let at = NOW - r.pick(&[0.0, 1000.0, 60_000.0, 60_001.0, -2000.0, -2001.0]);
			m.insert("capacity", obj! { "free" => r.pick(&[0.0, 1.0, 5.0, 5.0, -1.0, 2.5]), "at" => r.pick(&[at, at + 0.5]) });
		}
		if r.below(5) != 0 {
			let at = NOW - r.pick(&[0.0, 60_000.0, 60_001.0, -2000.0, -2001.0]);
			m.insert("capabilities", obj! { "at" => at, "names" => r.pick(&[strings(&["gpu"]), strings(&["cpu"]), strings(&[])]) });
		}
		o.insert(id, Json::Object(m));
	}
	Json::Object(o)
}

fn fields(r: &mut Rng) -> Json {
	let mut o = Object::new();
	for k in ["k", "l", "z"] {
		if r.below(3) != 0 {
			o.insert(k, r.pick(&["a".into(), "ü".into(), Json::Number(1.0), Json::Null, Json::Array(vec![Json::Number(2.0)])]));
		}
	}
	Json::Object(o)
}

fn line(r: &mut Rng, p: &Json) -> Json {
	let type_ = r.pick(&TYPES);
	match r.below(7) {
		0 => {
			let mut e = obj! { "type" => type_, "fields" => fields(r) };
			if let (0, Json::Object(o)) = (r.below(2), &mut e) {
				o.insert("types", r.pick(&[strings(&["Parent"]), strings(&[type_]), strings(&["Other"])]));
			}
			obj! { "op" => "routing", "fn" => "normalize", "policy" => p.clone(), "entry" => e }
		}
		1 => obj! { "op" => "routing", "fn" => "isMerge", "policy" => p.clone(), "type" => type_ },
		2 | 3 => obj! { "op" => "routing", "fn" => "write", "policy" => p.clone(), "table" => table(r), "now" => NOW, "entry" => obj! { "type" => type_, "fields" => fields(r) } },
		4 => {
			let template = match r.below(4) {
				0 => Json::Null,
				1 => obj! { "type" => type_ },
				2 => obj! { "fields" => fields(r) },
				_ => obj! { "type" => type_, "fields" => fields(r) },
			};
			obj! { "op" => "routing", "fn" => "search", "policy" => p.clone(), "template" => template }
		}
		5 => obj! { "op" => "routing", "fn" => "partition", "id" => format!("op-{}", r.below(1000)), "n" => r.pick(&[1.0, 2.0, 7.0, 1024.0, 0.0, 1025.0, 1.5]) },
		_ => {
			let (n, partition) = (r.pick(&[1.0, 2.0, 7.0, 0.0]), r.pick(&[0.0, 1.0, 6.0, 7.0, -1.0, 0.5]));
			obj! { "op" => "routing", "fn" => r.pick(&["parent", "router"]), "id" => format!("f-{}", r.below(50)), "n" => n, "partition" => partition }
		}
	}
}

#[test]
fn placement_answers_as_typescript_does() {
	let cases: u64 = std::env::var("PHI_ROUTING_CASES").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let (mut rust, mut ts) = (Driver::new(), TsDriver::start());
	let init = obj! { "op" => "init", "seed" => "routing", "now" => 1000.0, "spaceId" => "sp-1", "incarnation" => "0a0b0c0d", "generation" => "g1" };
	let _ = rust.step(&init);
	ts.step(&init);
	let (mut r, p) = (Rng(0x9e37_79b9_7f4a_7c15), policy());
	let (mut fine, mut refused) = (0, 0);
	for case in 0..cases {
		let l = line(&mut r, &p);
		let got = rust.step(&l).map_err(|e| format!("{}: {}", e.class, e.message));
		let t = ts.step(&l);
		let text = |k: &str| t.get(k).and_then(Json::as_str).unwrap_or("").to_owned();
		let want = if t.get("ok") == Some(&Json::Bool(true)) { Ok(t.get("result").cloned().unwrap_or(Json::Null)) } else { Err(format!("{}: {}", text("error"), text("message"))) };
		if got.is_ok() { fine += 1 } else { refused += 1 }
		assert_eq!(got, want, "case {case}: {}", l.to_json_text());
	}
	assert!(fine > cases / 4 && refused > cases / 20, "{fine} answered, {refused} refused");
}
