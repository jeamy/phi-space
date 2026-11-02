// R6a: the supervisor's views against TypeScript (test/support/alerts-driver.ts): host reports and command results over time; both
// lists must be the same in order and text. `PHI_ALERT_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_host::alerts::{audit_log, collect_alerts};
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

fn write(r: &mut Rng, now: f64, n: u64) -> Json {
	let hosts = ["a", "a-b", "a:b", "B", "ä", "a1"];
	if r.below(2) == 0 {
		let host = hosts[r.below(6) as usize];
		let metrics = if r.below(3) == 0 { obj! { "workers" => obj! { "fetchError" => "nein" } } } else { obj! {} };
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
		let t = ts.step(&obj! { "now" => now, "write" => Json::Array(writes.clone()), "limit" => limit });
		let (a, b) = service.commit_on(Some(&space), |s, _| {
			for w in &writes {
				let w = w.as_array().unwrap();
				s.write(now, &obj! { "type" => w[0].clone(), "fields" => w[1].clone() }, None, Some(&w[2]), None)?;
			}
			Ok((collect_alerts(s, now)?, audit_log(s, now, limit)?))
		}).unwrap();
		assert_eq!(a.to_json_text(), t.get("alerts").unwrap().to_json_text(), "alerts at {n}");
		assert_eq!(b.to_json_text(), t.get("audit").unwrap().to_json_text(), "audit at {n}");
		alerts += a.as_array().unwrap().len();
	}
	assert!(alerts > 50, "too few alerts: {alerts}");
}
