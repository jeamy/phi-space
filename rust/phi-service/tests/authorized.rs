// R5, slice 3: what a host's authorization changes in the service, where a random walk rarely lands: both services, the
// same calls and the same decisions (`auth` of test/support/service-driver.ts), each reply and state compared.
mod common;
use common::{Decided, RustSide, Setup, TsService};
use phi_json::{obj, parse, Json};

const T0: f64 = 1_700_000_000_000.0;

struct Both { ts: TsService, rust: RustSide, generation: String, n: u64 }
fn rights(until: f64, can: &[&str], expired: bool) -> Decided {
	Decided { valid_until: until, roles: vec!["member".into()], can: can.iter().map(|c| c.to_string()).collect(), expired }
}
const ALL: [&str; 4] = ["read:*", "take:*", "write:*", "notify:*"];
impl Both {
	fn start() -> Both {
		let mut ts = TsService::start();
		ts.step(&obj! { "op" => "init", "seed" => "authorized", "now" => T0, "authorized" => true });
		let rust = RustSide::start(&Setup { seed: "authorized".into(), now: T0, store: None, limits: None, max_calls: None, max_pending: None, max_peer: None, authorized: true });
		let mut b = Both { ts, rust, generation: String::new(), n: 0 };
		let r = parse(&b.call(r#"{"method":"generation","args":{}}"#, &rights(T0 + 60_000.0, &ALL, false))).unwrap();
		b.generation = r.get("result").unwrap().get("generation").unwrap().as_str().unwrap().to_owned();
		b
	}
	fn call(&mut self, text: &str, d: &Decided) -> String {
		let auth = obj! { "validUntil" => d.valid_until, "roles" => Json::Array(d.roles.iter().map(|r| r.as_str().into()).collect()), "can" => Json::Array(d.can.iter().map(|c| c.as_str().into()).collect()), "expired" => d.expired };
		let t = self.ts.step(&obj! { "now" => T0, "peer" => "local", "text" => text, "auth" => auth });
		*self.rust.auth.borrow_mut() = d.clone();
		let want = t.get("reply").and_then(Json::as_str).unwrap().to_owned();
		assert_eq!(self.rust.step(T0, "local", text, None), want, "{text}");
		assert_eq!(self.rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "{text}: {}", self.rust.dump());
		want
	}
	fn request(&mut self) -> String {
		self.n += 1;
		format!(r#"{{"generation":"{}","requestId":"r{}"}}"#, self.generation, self.n)
	}
	fn begin(&mut self, d: &Decided) -> String {
		let r = self.request();
		let reply = parse(&self.call(&format!(r#"{{"method":"txn","args":{{"action":"begin","leaseMs":60000}},"request":{r}}}"#), d)).unwrap();
		reply.get("result").unwrap().get("id").unwrap().as_str().unwrap().to_owned()
	}
	fn write(&mut self, txn: Option<&str>, d: &Decided) -> String {
		let r = self.request();
		let t = txn.map_or(String::new(), |t| format!(r#","txn":"{t}""#));
		self.call(&format!(r#"{{"method":"write","args":{{"entry":{{"type":"Note","fields":{{}}}},"leaseMs":60000{t}}},"request":{r}}}"#), d)
	}
}
fn parked(r: &str) -> String { format!(r#"{{"method":"take","args":{{"template":{{"type":"Task"}},"timeoutMs":60000,"waitMs":0}},"request":{r}}}"#) }
fn poll(r: &str) -> String { format!(r#"{{"method":"pollOperation","args":{{"targetRequest":{r},"waitMs":0}}}}"#) }
fn refused(reply: &str, part: &str) { assert!(reply.contains(r#""ok":false"#) && reply.contains(part), "{reply}"); }

#[test]
fn a_retried_call_renews_its_waiter_and_only_with_the_right() {
	let mut b = Both::start();
	let r = b.request();
	b.call(&parked(&r), &rights(T0 + 10_000.0, &ALL, false));
	b.call(&parked(&r), &rights(T0 + 20_000.0, &ALL, false));
	assert!(b.rust.dump().contains(&format!(r#""authorizedUntil":{}"#, T0 + 20_000.0)), "{}", b.rust.dump());
	b.call(&parked(&r), &rights(T0 + 30_000.0, &[], false));
	assert!(!b.rust.dump().contains(&format!(r#""authorizedUntil":{}"#, T0 + 30_000.0)));
}

#[test]
fn a_poll_renews_its_waiter_or_stops_at_an_ended_grant() {
	let mut b = Both::start();
	let r = b.request();
	b.call(&parked(&r), &rights(T0 + 10_000.0, &ALL, false));
	b.call(&poll(&r), &rights(T0 + 20_000.0, &ALL, false));
	assert!(b.rust.dump().contains(&format!(r#""authorizedUntil":{}"#, T0 + 20_000.0)), "{}", b.rust.dump());
	b.call(&poll(&r), &rights(T0 + 20_000.0, &ALL, false));
	refused(&b.call(&poll(&r), &rights(T0 + 20_000.0, &ALL, true)), "grant expired before commit");
	refused(&b.call(&poll(&r), &rights(T0 + 25_000.0, &ALL, true)), "grant expired before commit");
}

#[test]
fn a_commit_rechecks_the_rights_on_its_entries() {
	let mut b = Both::start();
	let all = rights(T0 + 60_000.0, &ALL, false);
	let t = b.begin(&all);
	b.write(Some(&t), &all);
	let r = b.request();
	let commit = format!(r#"{{"method":"txn","args":{{"action":"commit","id":"{t}"}},"request":{r}}}"#);
	refused(&b.call(&commit, &rights(T0 + 60_000.0, &[], false)), "current grant cannot write transaction entry");
	let r = b.request();
	let commit = format!(r#"{{"method":"txn","args":{{"action":"commit","id":"{t}"}},"request":{r}}}"#);
	assert!(b.call(&commit, &all).contains(r#""ok":true"#));
}

#[test]
fn a_renewal_needs_the_right_of_the_original_operation() {
	let mut b = Both::start();
	let all = rights(T0 + 60_000.0, &ALL, false);
	let none = rights(T0 + 60_000.0, &[], false);
	let t = b.begin(&all);
	b.write(Some(&t), &all);
	let renew = |b: &mut Both, id: &str, d: &Decided| {
		let r = b.request();
		b.call(&format!(r#"{{"method":"lease","args":{{"action":"renew","id":"{id}","ms":30000}},"request":{r}}}"#), d)
	};
	refused(&renew(&mut b, &t, &none), "current grant cannot write transaction entry");
	let written = parse(&b.write(None, &all)).unwrap();
	let id = written.get("result").unwrap().get("id").unwrap().as_str().unwrap().to_owned();
	refused(&renew(&mut b, &id, &none), "current grant cannot renew the original lease operation");
	assert!(renew(&mut b, &id, &all).contains(r#""ok":true"#));
	let r = b.request();
	let wait = parse(&b.call(&format!(r#"{{"method":"wait","args":{{"template":{{"type":"Evt"}},"timeoutMs":60000}},"request":{r}}}"#), &all)).unwrap();
	let id = wait.get("result").unwrap().get("id").unwrap().as_str().unwrap().to_owned();
	refused(&renew(&mut b, &id, &none), "current grant cannot renew the original lease operation");
	let r = b.request();
	let reg = parse(&b.call(&format!(r#"{{"method":"notify","args":{{"template":{{"type":"Evt"}},"leaseMs":60000}},"request":{r}}}"#), &all)).unwrap();
	let id = reg.get("result").unwrap().get("eventId").unwrap().as_str().unwrap().to_owned();
	refused(&renew(&mut b, &id, &none), "current grant cannot renew the original lease operation");
}

#[test]
fn reading_the_mailbox_renews_the_waits_that_may_still_run() {
	let mut b = Both::start();
	let r = b.request();
	b.call(&format!(r#"{{"method":"wait","args":{{"template":{{"type":"Evt"}},"timeoutMs":60000}},"request":{r}}}"#), &rights(T0 + 10_000.0, &ALL, false));
	b.call(r#"{"method":"events","args":{}}"#, &rights(T0 + 20_000.0, &ALL, false));
	assert!(b.rust.dump().contains(&format!(r#""authorizedUntil":{}"#, T0 + 20_000.0)), "{}", b.rust.dump());
	b.call(r#"{"method":"events","args":{}}"#, &rights(T0 + 30_000.0, &[], false));
	assert!(!b.rust.dump().contains(&format!(r#""authorizedUntil":{}"#, T0 + 30_000.0)));
}
