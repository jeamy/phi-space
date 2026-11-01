mod common;
use common::{RustSide, Setup, TsService};
use phi_json::{obj, parse};

#[test]
fn raw_overflow_writes_and_snapshot_errors_match_typescript_without_ending_the_service() {
	let now = 1_700_000_000_000.0;
	let mut ts = TsService::start();
	ts.step(&obj! { "op" => "init", "seed" => "overflow", "now" => now });
	let mut rust = RustSide::start(&Setup { seed: "overflow".into(), now, store: None, limits: None, max_calls: None, max_pending: None, max_peer: None, authorized: false });
	let mut call = |text: &str| {
		let answer = rust.step(now, "local", text, None);
		let expected = ts.step(&obj! { "now" => now, "text" => text });
		assert_eq!(Some(answer.as_str()), expected.get("reply").and_then(|v| v.as_str()), "{text}");
		assert_eq!(Some(rust.state().as_str()), expected.get("state").and_then(|v| v.as_str()));
		parse(&answer).unwrap()
	};
	let generation = call(r#"{"method":"generation"}"#).get("result").unwrap().get("generation").unwrap().to_json_text();
	let write = format!(r#"{{"method":"write","request":{{"generation":{generation},"requestId":"overflow"}},"args":{{"entry":{{"type":"Task","fields":{{"x":1e309,"nested":[-1e309]}}}}}}}}"#);
	let result = call(&write);
	assert_eq!(result.get("ok"), Some(&true.into()));
	assert_eq!(call(&write.replace("1e309", "null").replace("-null", "null")), result, "normalized retries have the same request hash");
	let page = call(r#"{"method":"readAll","args":{}}"#);
	assert!(page.to_json_text().contains(r#""fields":{"x":null,"nested":[null]}"#));
	let error = call(r#"{"method":"readAll","args":{"template":{"fields":{"x":1e309}}}}"#);
	assert_eq!(error.get("error").unwrap().get("code").and_then(|v| v.as_str()), Some("BadRequest"));
	assert_eq!(call(r#"{"method":"count"}"#).get("ok"), Some(&true.into()));
}
