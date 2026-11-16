// R6a: the supervisor's views against TypeScript (test/support/alerts-driver.ts): host reports and command results over time; both
// lists must be the same in order and text. `PHI_ALERT_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_host::alerts::{audit_log, collect_alerts_with};
use phi_json::{obj, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, MemoryLedger, Store};

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: u64) -> u64 { self.next() % n }
}

const HOSTS: [&str; 6] = ["a", "a-b", "a:b", "B", "ä", "a1"];
const ASSIGNMENTS: [&str; 4] = ["w1", "w2", "W", "w-ä"];

/// What a host's worker supervisor reports: its generation, a block, and per assignment its state.
fn workers(r: &mut Rng) -> Json {
	let mut w = obj! { "generation" => r.below(4) as f64 };
	let o = w.as_object_mut().unwrap();
	if r.below(4) == 0 { o.insert("fetchError", "nein".into()); }
	if r.below(5) == 0 { o.insert("blocked", "Kontrolle gewechselt".into()); }
	let mut a = phi_json::Object::new();
	for id in ASSIGNMENTS {
		if r.below(2) == 0 { continue; }
		let mut x = obj! { "errors" => r.below(3) as f64 };
		let xo = x.as_object_mut().unwrap();
		if r.below(2) == 0 { xo.insert("lastError", "kaputt".into()); }
		if r.below(5) == 0 { xo.insert("rejected", format!("no registered worker kind {id}").into()); }
		a.insert(id, x);
	}
	o.insert("assignments", Json::Object(a));
	w
}

/// Run views as `RunController.list` gives them, in every state an alert names.
fn runs(r: &mut Rng) -> Json {
	let states = ["running", "pauseIncomplete", "needsReview", "reconciling", "paused", "preparing"];
	Json::Array((0..r.below(4)).map(|i| {
		let mut v = obj! { "runId" => format!("r{}", r.below(5)), "kind" => "tasks", "members" => Json::Array(vec!["sp-1".into()]), "revision" => i as f64, "state" => states[r.below(6) as usize] };
		let o = v.as_object_mut().unwrap();
		if r.below(2) == 0 {
			let mut errors = phi_json::Object::new();
			for m in ["sp-1", "sp-2"] { if r.below(2) == 0 { errors.insert(m, if r.below(3) == 0 { "x".repeat(200) } else { "unreachable".into() }.into()); } }
			let missing: Vec<Json> = ["sp-2", "sp-3"].into_iter().filter(|_| r.below(2) == 0).map(Json::from).collect();
			o.insert("pending", obj! { "commandId" => "c", "kind" => "pause", "revision" => (i + 1) as f64, "errors" => Json::Object(errors), "applied" => Json::Array(vec![]), "fenced" => Json::Array(vec![]), "missing" => Json::Array(missing) });
		}
		if r.below(2) == 0 { o.insert("recovery", obj! { "id" => "rec-1", "stage" => "review", "errors" => obj! {}, "views" => obj! {} }); }
		v
	}).collect())
}

fn assignments(r: &mut Rng) -> Json {
	let mut out = vec![];
	for id in ASSIGNMENTS {
		if r.below(2) == 0 { continue; }
		out.push(obj! { "assignmentId" => id, "hostId" => HOSTS[r.below(6) as usize], "kind" => "sieve", "targetSpace" => "sp-1", "count" => r.below(3) as f64, "generation" => r.below(5) as f64 });
	}
	Json::Array(out)
}

fn write(r: &mut Rng, now: f64, n: u64) -> Json {
	if r.below(2) == 0 {
		let host = HOSTS[r.below(6) as usize];
		let metrics = match r.below(3) { 0 => obj! { "workers" => obj! { "fetchError" => "nein" } }, 1 => obj! { "workers" => workers(r) }, _ => obj! {} };
		let at = now - (r.below(8) as f64) * 50_000.0 - r.below(1000) as f64;
		return Json::Array(vec!["Capability".into(), obj! { "hostId" => host, "metrics" => metrics, "at" => at }, ((1 + r.below(4)) as f64 * 100_000.0).into()]);
	}
	let mut f = obj! { "commandId" => format!("c{n}"), "kind" => "drain", "state" => "completed", "requestedBy" => "boss", "at" => now - r.below(3) as f64 };
	let o = f.as_object_mut().unwrap();
	match r.below(5) {
		0 => o.insert("error", "x".repeat(350).into()),
		1 => o.insert("result", obj! { "error" => "ü".repeat(320) }),
		2 => o.insert("result", obj! { "phase" => "failed" }),
		3 => { o.remove("requestedBy"); }
		_ => {}
	}
	Json::Array(vec!["Result".into(), f, 1_000_000.0.into()])
}

#[test]
fn the_views_are_the_same() {
	let steps: u64 = std::env::var("PHI_ALERT_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(800);
	let mut ts = TsDriver::script("test/support/alerts-driver.ts");
	let store = Store::open(phi_store::Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
	let mut service = Service::new(store, Options::single_peer("p"));
	let space = service.create_space_with("control", system_random(), |_, _| Ok(())).unwrap().get("spaceId").and_then(Json::as_str).unwrap().to_owned();
	let (mut r, mut now) = (Rng(0x1234_5678_9abc_def1), 1_000_000.0);
	let mut alerts = 0;
	for n in 0..steps {
		now += (r.below(4) as f64) * 10_000.0;
		let writes: Vec<Json> = (0..r.below(3)).map(|i| write(&mut r, now, n * 10 + i)).collect();
		let limit = [1.0, 3.0, 100.0, 1000.0, 0.0, 2.5][r.below(6) as usize];
		let (run_views, wanted) = (runs(&mut r), assignments(&mut r));
		let t = ts.step(&obj! { "now" => now, "write" => Json::Array(writes.clone()), "limit" => limit, "runs" => run_views.clone(), "assignments" => wanted.clone() });
		let (a, b) = service.commit_on(Some(&space), |s, _| {
			for w in &writes {
				let w = w.as_array().unwrap();
				s.write(now, &obj! { "type" => w[0].clone(), "fields" => w[1].clone() }, None, Some(&w[2]), None)?;
			}
			Ok((collect_alerts_with(s, now, run_views.as_array().unwrap(), wanted.as_array().unwrap())?, audit_log(s, now, limit)?))
		}).unwrap();
		assert_eq!(a.to_json_text(), t.get("alerts").unwrap().to_json_text(), "alerts at {n}");
		assert_eq!(b.to_json_text(), t.get("audit").unwrap().to_json_text(), "audit at {n}");
		alerts += a.as_array().unwrap().len();
	}
	assert!(alerts > 50, "too few alerts: {alerts}");
}
