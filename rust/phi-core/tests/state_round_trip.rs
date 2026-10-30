// The first gate of R1 (docs/rust-portierung.md): states the TypeScript core wrote come back unchanged from the Rust
// model: the same canonical form and the same JSON.stringify byte count (what every budget is computed from).
mod common;
use common::TsDriver;
use phi_core::SpaceState;
use phi_json::{digest_json, obj, parse, Json};

fn check(state: &Json, what: &str) {
	let s = SpaceState::from_json(state).unwrap_or_else(|e| panic!("{what}: {e}"));
	let back = s.to_json();
	assert_eq!(back.canonical().unwrap(), state.canonical().unwrap(), "{what}: canonical form");
	assert_eq!(back.json_bytes(), state.json_bytes(), "{what}: JSON bytes");
}

#[test]
fn the_initial_state_is_the_typescript_one() {
	let mut d = TsDriver::start();
	let r = d.step(&obj! { "op" => "init", "seed" => "x", "dump" => true });
	let ts = r.get("dump").unwrap();
	assert_eq!(SpaceState::initial().to_json().to_json_text(), ts.to_json_text(), "same fields in the same order");
}

#[test]
fn states_of_a_scripted_run_round_trip() {
	let mut d = TsDriver::start();
	let lines = [
		r#"{"op":"init","seed":"rt","spaceId":"sp-1","incarnation":"0a0b0c0d","now":1000,"dump":true}"#,
		r#"{"op":"write","now":1000,"entry":{"type":"Task","types":["Job"],"fields":{"n":1,"s":"ä","z":[1.5,null]}},"lease":5000,"as":"local","dump":true}"#,
		r#"{"op":"write","now":1000,"entry":{"type":"Task","fields":{"n":2}},"dump":true}"#,
		r#"{"op":"createTxn","now":1100,"lease":10000,"as":"local","dump":true}"#,
		r#"{"op":"write","now":1100,"entry":{"type":"Task","fields":{"n":3}},"txn":"t0a0b0c0d-3","as":"local","dump":true}"#,
		r#"{"op":"probe","now":1200,"tmpl":{"type":"Task","fields":{"n":1}},"take":true,"txn":"t0a0b0c0d-3","as":"local","dump":true}"#,
		r#"{"op":"probe","now":1200,"tmpl":{"type":"Job"},"take":false,"dump":true}"#,
		r#"{"op":"notify","now":1300,"tmpl":{"type":"Task"},"lease":60000,"handback":{"h":1},"target":"local","dump":true}"#,
		r#"{"op":"addWaiter","now":1300,"w":{"template":{"type":"Task","fields":{"n":9}},"take":true,"target":"local","timeout":5000},"dump":true}"#,
		r#"{"op":"issueGeneration","now":1400,"principal":{"peerId":"local"},"dump":true}"#,
		r#"{"op":"commitTxn","now":1500,"id":"t0a0b0c0d-3","as":"local","dump":true}"#,
		r#"{"op":"renew","now":1600,"id":"e0a0b0c0d-2","ms":100,"dump":true}"#,
		r#"{"op":"settle","now":9000,"dump":true}"#,
		r#"{"op":"write","now":9000,"entry":{"type":"Task","fields":{"n":9}},"dump":true}"#,
		r#"{"op":"settle","now":20000,"dump":true}"#,
	];
	let mut seen = std::collections::HashSet::new();
	for (i, line) in lines.iter().enumerate() {
		let r = d.step(&parse(line).unwrap());
		assert_eq!(r.get("ok"), Some(&Json::Bool(true)), "step {i} ({line}) failed in TypeScript: {}", r.to_json_text());
		let dump = r.get("dump").unwrap_or_else(|| panic!("step {i}: {r:?}"));
		assert_eq!(digest_json(dump).unwrap(), r.get("state").and_then(Json::as_str).unwrap(), "step {i}: the driver's hash is of its dump");
		check(dump, &format!("step {i} ({line})"));
		seen.insert(r.get("state").and_then(Json::as_str).unwrap().to_owned());
	}
	assert!(seen.len() > 10, "the steps changed the state");
}
