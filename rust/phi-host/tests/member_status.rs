// R6a: MemberStatusDirectory against TypeScript (test/support/status-driver.ts). Members that answer, fail, answer nonsense or too late,
// that move or leave under a probe, and a lost authority. Every refusal, the routing and the directory entries must be the same.
// `PHI_STATUS_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError};
use phi_host::member_status::{record_on, refresh, Probed, StatusEnv};
use phi_json::{obj, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, MemoryLedger, Store};
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::rc::Rc;

const ROUTING: &str = "phi-spaces.federation-routing";
struct World {
	service: RefCell<Service>,
	space: String,
	routing: RefCell<Json>,
	clock: Rc<Cell<f64>>,
	plan: RefCell<VecDeque<Json>>,
	authority: RefCell<VecDeque<Json>>,
}
impl World {
	fn edit(&self, f: impl FnOnce(&mut Json)) {
		let mut next = self.routing.borrow().clone();
		f(&mut next);
		let text = next.to_json_text();
		self.service.borrow_mut().commit_on(Some(&self.space), |s, _| { s.doc_writes.push((ROUTING.to_owned(), self.space.clone(), 1, text)); Ok(()) }).unwrap();
		*self.routing.borrow_mut() = next;
	}
}
#[derive(Clone)]
struct Env(Rc<World>);
fn member<'a>(d: &'a mut Json, id: &str) -> &'a mut phi_json::Object {
	d.as_object_mut().unwrap().get_mut("members").unwrap().as_object_mut().unwrap().get_mut(id).unwrap().as_object_mut().unwrap()
}
impl StatusEnv for Env {
	fn authorized(&self) -> Result<(), CoreError> {
		if self.0.authority.borrow_mut().pop_front() == Some(Json::Bool(false)) { Err(error("Error", "no authority")) } else { Ok(()) }
	}
	fn routing(&self) -> Result<Json, CoreError> { Ok(self.0.routing.borrow().clone()) }
	fn probe(&self, id: &str, _: &Json) -> Local<Result<Probed, String>> {
		let (w, id) = (Rc::clone(&self.0), id.to_owned());
		Box::pin(async move {
			let next = w.plan.borrow_mut().pop_front().unwrap_or_else(|| obj! {});
			w.clock.set(w.clock.get() + next.get("takes").and_then(Json::as_f64).unwrap_or(0.0));
			if next.get("moves").is_some() {
				w.edit(|d| { let t = member(d, &id).get_mut("target").unwrap().as_object_mut().unwrap(); let e = t.get("primaryEpoch").and_then(Json::as_f64).unwrap(); t.insert("primaryEpoch", (e + 1.0).into()); });
			}
			if next.get("leaves").is_some() {
				w.edit(|d| { d.as_object_mut().unwrap().get_mut("members").unwrap().as_object_mut().unwrap().remove(&id); });
			}
			if next.get("fails").is_some() {
				return Err("no answer".into());
			}
			let of = |k: &str, d: Json| next.get(k).cloned().unwrap_or(d);
			Ok(Probed { revision: of("revision", Json::Number(5.0)), free: of("free", Json::Null), lag: of("lag", Json::Null) })
		})
	}
	fn record(&self, id: &str, target: &Json, status: Option<&Probed>, at: f64) -> Result<(), CoreError> {
		// TypeScript asks once more inside the commit; the owner thread leaves no gap for that, the walk counts it alike
		self.authorized()?;
		let routing = self.0.routing.borrow().clone();
		if let Some(next) = record_on(&mut self.0.service.borrow_mut(), &self.0.space, routing, id, target, status, at)? {
			*self.0.routing.borrow_mut() = next;
		}
		Ok(())
	}
	fn now(&self) -> f64 { self.0.clock.get() }
}

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

fn target(n: u64) -> Json { obj! { "authorityId" => "a", "hostId" => format!("h{n}"), "spaceId" => format!("s{n}"), "dataIncarnation" => "0a0b0c0d", "primaryEpoch" => 1.0 } }
fn table(r: &mut Rng) -> Json {
	let mut members = phi_json::Object::new();
	for n in 1..=3u64 {
		if r.below(5) == 0 { continue; }
		let state = ["active", "active", "active", "draining", "pending", "removed"][r.below(6) as usize];
		members.insert(format!("m{n}"), obj! { "id" => format!("m{n}"), "state" => state, "target" => target(n), "capacity" => obj! { "free" => 1.0, "at" => 1.0 } });
	}
	obj! { "members" => Json::Object(members) }
}
fn probe(r: &mut Rng) -> Json {
	match r.below(12) {
		0 | 1 => obj! { "fails" => true },
		2 => obj! { "revision" => -1.0 },
		3 => obj! { "revision" => 1.5 },
		4 => obj! { "free" => -2.0 },
		5 => obj! { "lag" => -1.0 },
		6 => obj! { "takes" => 31_000.0 },
		7 => obj! { "takes" => 29_999.0, "free" => 9.0, "lag" => 2.0 },
		8 => obj! { "moves" => true },
		9 => obj! { "leaves" => true },
		10 => obj! { "free" => 0.0, "revision" => 0.0 },
		_ => obj! { "free" => 3.5, "lag" => 0.0, "revision" => 8.0 },
	}
}
fn line(r: &mut Rng) -> Json {
	let mut o = phi_json::Object::new();
	if r.below(6) == 0 { o.insert("routing", table(r)); }
	if r.below(3) == 0 {
		let n = 1 + r.below(3);
		let names = |x: u64| Json::Array((0..x).map(|i| format!("t{i}").into()).collect());
		o.insert("capability", obj! { "hostId" => format!("h{n}"), "tools" => names(r.below(3)), "models" => names(r.below(2)), "at" => (r.below(5) as f64) * 1000.0, "resources" => obj! {}, "metrics" => obj! {} });
	}
	o.insert("tick", ((r.below(4) as f64) * 20_000.0).into());
	o.insert("refresh", (r.below(8) != 0).into());
	o.insert("plan", Json::Array((0..4).map(|_| probe(r)).collect()));
	if r.below(10) == 0 {
		let n = r.below(4) as usize;
		o.insert("authority", Json::Array((0..=n).map(|i| Json::Bool(i != n)).collect()));
	}
	Json::Object(o)
}

fn entries(w: &World) -> Json {
	let now = w.clock.get();
	let mut service = w.service.borrow_mut();
	let host = service.store.reader(Some(&w.space)).unwrap();
	let listed = host.space.state.entries.iter().filter(|e| ["MemberStatus", "Capability"].contains(&e.type_.as_str()) && e.expires > now);
	Json::Array(listed.map(|e| Json::Array(vec![e.type_.as_str().into(), Json::Object(e.fields.clone()), e.expires.into()])).collect())
}
fn sorted(v: &Json) -> Vec<String> {
	let mut l: Vec<String> = v.as_array().unwrap().iter().map(|e| e.canonical().unwrap()).collect();
	l.sort();
	l
}

#[test]
fn status_is_the_same_as_typescript() {
	let steps: u64 = std::env::var("PHI_STATUS_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(1500);
	let mut driver = TsDriver::script("test/support/status-driver.ts");
	let clock = Rc::new(Cell::new(10_000.0));
	let mut options = Options::single_peer("p");
	let at = Rc::clone(&clock);
	options.now = Box::new(move || at.get());
	let store = Store::open(phi_store::Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
	let mut service = Service::new(store, options);
	let info = service.create_space_with("control", system_random(), |_, _| Ok(())).unwrap();
	let space = info.get("spaceId").and_then(Json::as_str).unwrap().to_owned();
	let world = Rc::new(World { service: RefCell::new(service), space, routing: RefCell::new(obj! { "policy" => Json::Null, "members" => phi_json::Object::new() }), clock, plan: RefCell::default(), authority: RefCell::default() });
	let env = Env(Rc::clone(&world));
	let mut r = Rng(0x9E37_79B9_7F4A_7C15);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut seen = [0u32; 3];
	for step in 0..steps {
		let l = line(&mut r);
		let theirs = driver.step(&l);
		if let Some(t) = l.get("routing") {
			let t = t.clone();
			world.edit(|d| { d.as_object_mut().unwrap().insert("members", t.get("members").cloned().unwrap()); });
		}
		if let Some(c) = l.get("capability") {
			let now = world.clock.get();
			world.service.borrow_mut().commit_on(Some(&world.space), |s, _| s.write(now, &obj! { "type" => "Capability", "fields" => c.clone() }, None, Some(&Json::Number(120_000.0)), None)).unwrap();
		}
		world.clock.set(world.clock.get() + l.get("tick").and_then(Json::as_f64).unwrap());
		*world.plan.borrow_mut() = l.get("plan").and_then(Json::as_array).unwrap().iter().cloned().collect();
		*world.authority.borrow_mut() = l.get("authority").and_then(Json::as_array).map_or(VecDeque::new(), |a| a.iter().cloned().collect());
		let refused = if l.get("refresh") == Some(&Json::Bool(true)) { runtime.block_on(refresh(&env)).err().map(|e| e.message) } else { None };
		assert_eq!(theirs.get("refused").and_then(Json::as_str), refused.as_deref(), "step {step}: {}", l.to_json_text());
		let (mine, want) = (world.routing.borrow().clone(), theirs.get("routing").cloned().unwrap());
		assert_eq!(mine.get("members").unwrap().canonical().unwrap(), want.get("members").unwrap().canonical().unwrap(), "step {step}: {}", l.to_json_text());
		let es = entries(&world);
		assert_eq!(sorted(&es), sorted(theirs.get("entries").unwrap()), "step {step}: {}", l.to_json_text());
		let text = es.to_json_text();
		seen[0] += text.contains("\"reachable\":true") as u32;
		seen[1] += text.contains("\"reachable\":false") as u32;
		seen[2] += mine.to_json_text().contains("capabilities") as u32;
	}
	assert!(seen.iter().all(|n| *n > 20), "the walk reached too little: {seen:?}");
}
