// R6a: MembershipController against TypeScript (test/support/membership-driver.ts). Members added, drained and removed, with lost replies,
// wrong proofs, stock that does not fit and references that hold a removal. Every answer, every signed instruction, the routing, the
// journal and the policy counter must be the same. `PHI_MEMBERSHIP_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError};
use phi_host::auth::{seal, Algorithm, Signer};
use phi_host::membership_control::{MembershipController, MembershipEnv, JOURNAL, ROUTING};
use phi_host::router::RouterEnv;
use phi_host::run_member::Pin;
use phi_json::{obj, text, Json};
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

const SPACE: &str = "sp-00000000-0000-4000-8000-000000000001";
struct World {
	docs: RefCell<HashMap<(String, String), Json>>,
	plan: RefCell<VecDeque<Json>>,
	sent: RefCell<Vec<Json>>,
	refs: Cell<bool>,
	version: RefCell<Json>,
	key: Signer,
	public: String,
}
#[derive(Clone)]
struct Env(Rc<World>);
impl RouterEnv for Env {
	fn read(&self, kind: &str, key: &str) -> Result<Option<Json>, CoreError> { Ok(self.0.docs.borrow().get(&(kind.to_owned(), key.to_owned())).cloned()) }
	fn commit(&self, writes: Vec<(String, String, Json)>) -> Result<(), CoreError> {
		for (kind, key, value) in writes {
			self.0.docs.borrow_mut().insert((kind, key), value);
		}
		Ok(())
	}
	fn commit_policy(&self, writes: Vec<(String, String, Json)>, version: f64) -> Result<(), CoreError> {
		*self.0.version.borrow_mut() = Json::Number(version);
		self.commit(writes)
	}
	fn assert_authority(&self) -> Local<Result<(), CoreError>> { Box::pin(async { Ok(()) }) }
	fn invoke(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn resolve(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn now(&self) -> f64 { 0.0 }
}
impl MembershipEnv for Env {
	fn apply(&self, member: &Json, signed: Json) -> Local<Result<Json, CoreError>> {
		self.0.sent.borrow_mut().push(Json::Array(vec![member.get("id").cloned().unwrap(), signed.clone()]));
		let next = self.0.plan.borrow_mut().pop_front().unwrap_or_else(|| obj! {});
		let answer = if next.as_str() == Some("throw") {
			Err(error("Error", "the line broke"))
		} else {
			let q = signed.get("value").unwrap();
			let or = |k: &str, d: Json| next.get(k).cloned().unwrap_or(d);
			let action = text(q, "action").unwrap();
			let proof = obj! { "id" => q.get("id").cloned().unwrap(), "authorityId" => q.get("authorityId").cloned().unwrap(), "memberId" => if next.get("wrong").is_some() { "other".into() } else { q.get("memberId").cloned().unwrap() }, "spaceId" => q.get("spaceId").cloned().unwrap(), "action" => action, "state" => if action == "freeze" { "removing" } else { "active" }, "stock" => or("stock", Json::Array(vec![])), "empty" => or("empty", Json::Bool(true)) };
			Ok(seal("value", proof, "membership-proof", text(&next, "issuer").unwrap_or("member-peer"), &self.0.key).unwrap())
		};
		Box::pin(async move { answer })
	}
	fn pin(&self, _: &Json) -> Local<Result<Pin, CoreError>> {
		let pin = Pin { issuer: "member-peer".into(), algorithm: Algorithm::Ed25519, public_key: self.0.public.clone() };
		Box::pin(async move { Ok(pin) })
	}
	fn authorize(&self) -> Local<Result<(), CoreError>> { Box::pin(async { Ok(()) }) }
	fn has_references(&self, _: &str, _: &str) -> Result<bool, CoreError> { Ok(self.0.refs.get()) }
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
	fn pick<T: Clone>(&mut self, v: &[T]) -> T { v[self.below(v.len() as u64) as usize].clone() }
}
fn member(n: u64) -> Json { obj! { "id" => format!("m{n}"), "state" => "adding", "target" => obj! { "hostId" => format!("h{n}"), "spaceId" => format!("s{n}"), "authorityId" => "a", "dataIncarnation" => "i", "primaryEpoch" => 1.0 } } }
fn step(r: &mut Rng) -> Json {
	match r.below(12) {
		0 | 1 => "throw".into(),
		2 => obj! { "wrong" => true },
		3 => obj! { "issuer" => "someone" },
		4 => obj! { "empty" => false },
		5 => obj! { "stock" => vec![obj! { "type" => r.pick(&["Task", "Note"]), "fields" => obj! { "n" => 1.0 } }] },
		6 => obj! { "stock" => vec![obj! { "type" => "Child", "types" => vec![Json::from("Child"), Json::from("Parent")], "fields" => obj! {} }] },
		7 => obj! { "stock" => vec![obj! { "type" => "Child", "types" => vec![Json::from("Parent")], "fields" => obj! {} }, obj! { "type" => "Child", "fields" => obj! {} }] },
		_ => obj! {},
	}
}
/// The transitions of a season, in an order that gets somewhere; what the plan breaks is tried again.
fn course(r: &mut Rng) -> VecDeque<(&'static str, u64, Option<u64>)> {
	let mut c = VecDeque::from([("add", 0, None), ("add", 1, None), ("add", 2, None), ("drain", 1, None), ("remove", 1, None)]);
	if r.below(2) == 0 {
		c.extend([("drain", 0, None), ("remove", 0, Some(9)), ("remove", 0, Some(2))]);
	}
	c
}
/// A table with an hrw rule on a Member, which cannot shrink.
fn routing() -> Json {
	let target = |n: u64| member(n).get("target").cloned().unwrap();
	let mut table = phi_json::Object::new();
	table.insert("m1", obj! { "id" => "m1", "state" => "draining", "target" => target(1) });
	table.insert("m2", obj! { "id" => "m2", "state" => "active", "target" => target(2) });
	let policy = obj! { "authorityId" => "a", "policyVersion" => 1.0, "completionProfiles" => Vec::<Json>::new(), "default" => obj! { "mode" => "local", "member" => "m2" }, "rules" => vec![obj! { "type" => "H", "mode" => "expand", "members" => vec![Json::from("m1"), Json::from("m2")], "by" => "type" }] };
	obj! { "policy" => policy, "members" => table }
}
fn line(r: &mut Rng, cmd: &mut u64) -> Json {
	*cmd += 1;
	let kind = r.pick(&["add", "add", "add", "drain", "remove"]);
	let m = r.below(4);
	let mut l = obj! { "id" => format!("c{}", *cmd), "kind" => kind, "member" => member(m), "refs" => r.below(5) == 0, "plan" => Json::Array((0..r.below(3)).map(|_| step(r)).collect()) };
	if r.below(3) == 0 {
		l.as_object_mut().unwrap().insert("newDefault", format!("m{}", r.below(4)).into());
	}
	l
}

#[test]
fn a_walk_of_transitions_leaves_the_same_documents() {
	let steps: u64 = std::env::var("PHI_MEMBERSHIP_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/membership-driver.ts");
	let member_key = ed25519_dalek::SigningKey::from_bytes(&[6; 32]);
	let public = phi_host::auth::to_base64(member_key.verifying_key().as_bytes());
	let world = Rc::new(World { docs: RefCell::default(), plan: RefCell::default(), sent: RefCell::default(), refs: Cell::new(false), version: RefCell::new(Json::Number(0.0)), key: Signer::Ed25519(member_key), public });
	let m = MembershipController { env: Env(Rc::clone(&world)), control_space: SPACE.into(), authority_id: "a".into(), peer_id: "control-peer".into(), signer: Rc::new(Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[5; 32]))) };
	let (mut r, mut cmd) = (Rng(0x51de_c0de_1357_9bdf), 0);
	let mut seen: HashMap<String, usize> = HashMap::new();
	let mut last: Option<Json> = None;
	let mut plan = VecDeque::new();
	let mut outcome: Option<String> = None;
	for n in 0..steps {
		// a stuck transition holds every other: a new store now and then, and the same command again as an admin would
		if n % 30 == 0 {
			let seeded = (r.below(4) == 0).then(routing);
			ts.step(&obj! { "reset" => true, "routing" => seeded.clone().unwrap_or(Json::Null) });
			world.docs.borrow_mut().clear();
			if let Some(d) = seeded {
				world.docs.borrow_mut().insert((ROUTING.to_owned(), SPACE.to_owned()), d);
			}
			*world.version.borrow_mut() = Json::Number(0.0);
			last = None;
			plan = course(&mut r);
		}
		let done = last.as_ref().is_none_or(|l: &Json| outcome == Some(text(l, "id").unwrap().to_owned()));
		if done {
			last = None;
			if let Some((kind, m, default)) = plan.pop_front() {
				cmd += 1;
				let plan_now = if kind == "remove" && r.below(3) == 0 { vec![obj! { "empty" => false }] } else { vec![] };
				let mut x = obj! { "id" => format!("c{cmd}"), "kind" => kind, "member" => member(m), "refs" => false, "plan" => Json::Array(plan_now) };
				if let Some(d) = default {
					x.as_object_mut().unwrap().insert("newDefault", format!("m{d}").into());
				}
				last = Some(x);
			}
		}
		let fresh = last.as_ref().is_some_and(|x| x.get("plan").and_then(Json::as_array).is_some_and(|p| !p.is_empty()));
		let l = match last.take().filter(|_| r.below(10) < 8) {
			Some(again) if fresh => again,
			Some(mut again) => {
				again.as_object_mut().unwrap().insert("plan", Json::Array((0..r.below(2)).map(|_| step(&mut r)).collect()));
				again.as_object_mut().unwrap().insert("refs", Json::Bool(r.below(8) == 0));
				again
			}
			None => line(&mut r, &mut cmd),
		};
		let mut kept = l.clone();
		kept.as_object_mut().unwrap().insert("plan", Json::Array(vec![]));
		last = Some(kept);
		*world.plan.borrow_mut() = l.get("plan").unwrap().as_array().unwrap().iter().cloned().collect();
		world.refs.set(l.get("refs") == Some(&Json::Bool(true)));
		world.sent.borrow_mut().clear();
		let got = runtime.block_on(m.execute(text(&l, "id").unwrap(), text(&l, "kind").unwrap(), l.get("member").unwrap(), text(&l, "newDefault")));
		let t = ts.step(&l);
		let context = format!("step {n}: {}", l.to_json_text());
		match (&got, t.get("ok") == Some(&Json::Bool(true))) {
			(Ok(v), true) => {
				assert_eq!(v.canonical(), t.get("result").unwrap().canonical(), "answer, {context}");
				*seen.entry(format!("{} {}", text(v, "kind").unwrap(), text(v, "phase").unwrap())).or_default() += 1;
				outcome = Some(text(&l, "id").unwrap().to_owned());
			}
			(Err(e), false) => {
				assert_eq!(format!("{}: {}", e.class, e.message), format!("{}: {}", text(&t, "error").unwrap(), text(&t, "message").unwrap()), "refusal, {context}");
				*seen.entry(e.class.to_owned()).or_default() += 1;
			}
			_ => panic!("{got:?} against {} ON {context}", text(&t, "message").unwrap_or("an answer")),
		}
		assert_eq!(Json::Array(world.sent.borrow().clone()).canonical(), t.get("sent").unwrap().canonical(), "instructions, {context}");
		let doc = |kind: &str| world.docs.borrow().get(&(kind.to_owned(), SPACE.to_owned())).cloned().unwrap_or(Json::Null);
		assert_eq!(doc(ROUTING).canonical(), t.get("routing").unwrap().canonical(), "routing, {context}");
		assert_eq!(doc(JOURNAL).canonical(), t.get("journal").unwrap().canonical(), "journal, {context}");
		if t.get("version").is_some_and(|v| !v.is_null()) {
			assert_eq!(Some(&*world.version.borrow()), t.get("version"), "counter, {context}");
		}
	}
	for wanted in ["add completed", "add failed", "drain completed", "remove completed", "RoutingConflict", "MigrationRequired"] {
		assert!(seen.contains_key(wanted), "never reached {wanted}: {seen:?}");
	}
}
