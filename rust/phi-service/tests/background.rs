// R3, slice 3: what `Service::background` decides on its own. The rounds themselves are held against TypeScript in the
// walk; here are the cases a walk cannot reach: events an agent host left in the file, and when to wake.
mod common;
use common::{RustSide, Setup};
use phi_json::{obj, Json, FOREVER};

const T0: f64 = 1_700_000_000_000.0;

fn side() -> RustSide { RustSide::start(&Setup { seed: "background".into(), now: T0, store: None, limits: None, max_calls: None, max_pending: None }) }
fn outbox(r: &mut RustSide, events: Vec<Json>) {
	let now = r.clock.get();
	r.service.store.commit(None, now, |s| { s.state.rest.insert("outbox", Json::Array(events)); s.state.outbox_bytes = None; Ok(()) }).unwrap().unwrap();
}
fn left(r: &mut RustSide) -> Vec<String> {
	let s = &r.service.store.reader(None).unwrap().space.state;
	s.rest.get("outbox").and_then(Json::as_array).unwrap().iter().map(|e| e.get("eventId").unwrap().as_str().unwrap().to_owned()).collect()
}
fn event(id: &str, target: Json) -> Json { obj! { "eventId" => id, "seq" => 1.0, "kind" => "notify", "target" => target, "handback" => Json::Null } }

#[test]
fn wakes_when_a_lease_ends_and_settles_it() {
	let mut r = side();
	assert_eq!(r.service.background(), FOREVER);
	let hello = phi_json::parse(&r.step(T0, "local", r#"{"method":"generation","args":{}}"#, None)).unwrap();
	let generation = hello.get("result").and_then(|v| v.get("generation")).unwrap().as_str().unwrap().to_owned();
	let call = format!(r#"{{"method":"write","args":{{"entry":{{"type":"Task","fields":{{"n":1}}}},"leaseMs":1000}},"request":{{"generation":"{generation}","requestId":"r1"}}}}"#);
	let reply = r.step(T0, "local", &call, None);
	assert!(reply.contains(r#""ok":true"#), "{reply}");
	assert_eq!(r.service.background(), T0 + 1000.0);
	r.clock.set(T0 + 999.0);
	let rev = r.service.store.reader(None).unwrap().space.state.stream.as_ref().map(|s| s.rev);
	r.service.background();
	assert_eq!(r.service.store.reader(None).unwrap().space.state.stream.as_ref().map(|s| s.rev), rev, "nothing due, no commit");
	r.clock.set(T0 + 1000.0);
	assert!(r.service.background() > T0 + 1000.0, "next the sweep of the generation");
	assert!(r.service.store.reader(None).unwrap().space.state.entries.is_empty());
}

#[test]
fn an_event_for_a_conversation_waits_and_one_for_nobody_leaves() {
	let mut r = side();
	r.service.background();
	outbox(&mut r, vec![event("waits", 7.0.into()), event("nobody", "peer".into())]);
	assert_eq!(r.service.background(), T0, "a run that dropped something looks again");
	assert_eq!(left(&mut r), ["waits"]);
	assert_eq!(r.service.background(), FOREVER);
	assert_eq!(left(&mut r), ["waits"]);
}

#[test]
fn a_transaction_gone_drops_its_event() {
	let mut r = side();
	r.service.background();
	let mut e = event("served", 7.0.into());
	if let Json::Object(o) = &mut e {
		o.insert("txn", "t-gone".into());
	}
	outbox(&mut r, vec![e]);
	r.service.background();
	assert!(left(&mut r).is_empty());
}

#[test]
fn a_poisoned_event_goes_with_the_next_commit_and_a_retry_is_waited_for() {
	let mut r = side();
	r.service.background();
	let with = |mut e: Json, k: &str, v: f64| {
		if let Json::Object(o) = &mut e {
			o.insert(k, v.into());
		}
		e
	};
	outbox(&mut r, vec![with(event("poisoned", 7.0.into()), "tries", 5.0), with(event("later", 7.0.into()), "retryAt", T0 + 500.0)]);
	assert_eq!(r.service.background(), T0 + 500.0, "no commit is due for the poisoned one alone, as in deliverEvents");
	assert_eq!(left(&mut r), ["poisoned", "later"]);
	outbox(&mut r, vec![with(event("poisoned", 7.0.into()), "tries", 5.0), with(event("nobody", "peer".into()), "retryAt", T0 + 500.0)]);
	assert_eq!(r.service.background(), T0 + 500.0, "an event still backing off is not looked at");
	assert_eq!(left(&mut r), ["poisoned", "nobody"]);
	r.clock.set(T0 + 500.0);
	r.service.background();
	assert!(left(&mut r).is_empty());
}
