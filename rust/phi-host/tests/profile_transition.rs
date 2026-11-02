// R6a: ProfileTransitionController against TypeScript (test/support/profile-driver.ts). Transitions that run through, fail on a lost
// line or a wrong proof and go on, policies a transition may not bring, work that is not settled, and targets or a policy that move
// under a frozen transition. Every answer, every signed instruction, the routing, the ledger and the counter must be the same.
// `PHI_PROFILE_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError};
use phi_host::auth::{seal, Algorithm, Signer};
use phi_host::federated_space::OPERATIONS;
use phi_host::membership_control::{MembershipEnv, JOURNAL, ROUTING};
use phi_host::profile_transition::{ProfileTransitionController, PROFILES};
use phi_host::router::RouterEnv;
use phi_host::run_member::Pin;
use phi_json::{obj, text, Json};
use phi_wire::Local;
use std::cell::RefCell;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

const SPACE: &str = "sp-00000000-0000-4000-8000-000000000001";
struct World {
	docs: RefCell<HashMap<(String, String), Json>>,
	plan: RefCell<VecDeque<Json>>,
	sent: RefCell<Vec<Json>>,
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
		let w = Rc::clone(&self.0);
		Box::pin(async move {
			if next.get("throws").is_some() {
				return Err(error("TransportFailure", "the line broke"));
			}
			let q = signed.get("value").unwrap();
			let action = text(q, "action").unwrap();
			let of = |k: &str, d: Json| next.get(k).cloned().unwrap_or(d);
			let proof = obj! { "id" => q.get("id").cloned().unwrap(), "authorityId" => q.get("authorityId").cloned().unwrap(), "memberId" => if next.get("wrong").is_some() { "other".into() } else { q.get("memberId").cloned().unwrap() }, "spaceId" => q.get("spaceId").cloned().unwrap(), "action" => of("action", action.into()), "state" => of("state", if action == "profileResume" { "active" } else { "profileFrozen" }.into()) };
			Ok(seal("value", proof, "membership-proof", text(&next, "issuer").unwrap_or("member-peer"), &w.key).unwrap())
		})
	}
	fn pin(&self, _: &Json) -> Local<Result<Pin, CoreError>> {
		let public = self.0.public.clone();
		Box::pin(async move { Ok(Pin { issuer: "member-peer".into(), algorithm: Algorithm::Ed25519, public_key: public }) })
	}
	fn authorize(&self) -> Local<Result<(), CoreError>> { Box::pin(async { Ok(()) }) }
	fn has_references(&self, _: &str, _: &str) -> Result<bool, CoreError> { Ok(false) }
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

fn profile(task: &str, bytes: f64) -> Json { obj! { "taskType" => task, "resultTypes" => vec![Json::from("Done")], "equalFields" => vec![Json::from("n")], "maxResultCount" => 1.0, "maxResultBytes" => bytes, "maxLeaseMs" => 60_000.0 } }
fn policy(version: f64) -> Json { obj! { "authorityId" => "a", "policyVersion" => version, "rules" => vec![obj! { "type" => "R", "mode" => "local", "member" => "m1" }], "completionProfiles" => vec![profile("T", 1024.0)], "default" => obj! { "mode" => "local", "member" => "m1" } } }
fn changed(p: &Json, k: &str, v: Json) -> Json {
	let mut c = p.clone();
	c.as_object_mut().unwrap().insert(k, v);
	c
}
/// What may be asked for; the first ones are good.
fn next(r: &mut Rng, version: f64) -> Json {
	let up = version + 1.0;
	let base = policy(version);
	let good = changed(&base, "policyVersion", up.into());
	match r.below(14) {
		0..=5 => changed(&good, "completionProfiles", vec![profile("T", 2048.0 + version)].into()),
		6 | 7 => changed(&good, "completionProfiles", vec![profile("T", 1024.0), profile("U", 512.0)].into()),
		8 => changed(&base, "policyVersion", (version + 2.0).into()),
		9 => changed(&good, "default", obj! { "mode" => "local", "member" => "m2" }),
		10 => changed(&good, "completionProfiles", vec![changed(&profile("T", 1.0), "resultTypes", Json::Array(vec![]))].into()),
		11 => changed(&good, "completionProfiles", vec![profile("R", 1024.0), profile("T", 1024.0)].into()),
		12 => changed(&good, "authorityId", "b".into()),
		_ => good,
	}
}
fn table(r: &mut Rng) -> Json {
	let mut members = phi_json::Object::new();
	for n in 1..=(1 + r.below(3)) {
		let state = if r.below(12) == 0 { "draining" } else { "active" };
		members.insert(format!("m{n}"), obj! { "id" => format!("m{n}"), "state" => state, "target" => obj! { "authorityId" => "a", "hostId" => format!("h{n}"), "spaceId" => format!("s{n}"), "dataIncarnation" => "0a0b0c0d", "primaryEpoch" => 1.0 } });
	}
	Json::Object(members)
}
fn seed(r: &mut Rng, version: f64) -> Json {
	let mut o = phi_json::Object::new();
	o.insert("reset", true.into());
	o.insert("routing", obj! { "policy" => policy(version), "members" => table(r) });
	if r.below(8) == 0 {
		o.insert("journal", obj! { "operations" => obj! { "x" => obj! { "phase" => ["completed", "failed", "drainWait"][r.below(3) as usize] } } });
	}
	if r.below(5) == 0 {
		let mut full = phi_json::Object::new();
		for n in 0..(30 + r.below(3)) {
			full.insert(format!("old{n}"), obj! { "phase" => "completed", "hash" => "x" });
		}
		o.insert("ledger", obj! { "operations" => Json::Object(full) });
	}
	if r.below(6) == 0 {
		let parent = match r.below(4) {
			0 => obj! { "p" => obj! { "id" => "p", "phase" => "open", "kind" => "write" } },
			1 => obj! { "p" => obj! { "id" => "p", "phase" => "done", "kind" => "txn", "args" => obj! { "action" => "begin" } } },
			2 => obj! { "p" => obj! { "id" => "p", "phase" => "done", "kind" => "txn", "args" => obj! { "action" => "begin" } }, "q" => obj! { "id" => "q", "phase" => "done", "kind" => "txn", "args" => obj! { "action" => "commit", "originId" => "p" } } },
			_ => obj! { "p" => obj! { "id" => "p", "phase" => "done", "kind" => "write" } },
		};
		o.insert("parents", obj! { "operations" => parent });
	}
	Json::Object(o)
}
fn fault(r: &mut Rng) -> Json {
	match r.below(5) {
		0 => obj! { "throws" => true },
		1 => obj! { "wrong" => true },
		2 => obj! { "state" => "removing" },
		3 => obj! { "action" => "profileInstall" },
		_ => obj! { "issuer" => "stranger" },
	}
}

#[test]
fn a_walk_of_transitions_leaves_the_same_documents() {
	let steps: u64 = std::env::var("PHI_PROFILE_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/profile-driver.ts");
	let member_key = ed25519_dalek::SigningKey::from_bytes(&[6; 32]);
	let public = phi_host::auth::to_base64(member_key.verifying_key().as_bytes());
	let world = Rc::new(World { docs: RefCell::default(), plan: RefCell::default(), sent: RefCell::default(), version: RefCell::new(Json::Null), key: Signer::Ed25519(member_key), public });
	let c = ProfileTransitionController { env: Env(Rc::clone(&world)), control_space: SPACE.into(), authority_id: "a".into(), federation_id: "root".into(), partitions: 1.0, peer_id: "control-peer".into(), signer: Rc::new(Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[5; 32]))) };
	let mut r = Rng(0x7ab1_e5ee_d0ff_1357);
	let mut seen: HashMap<String, usize> = HashMap::new();
	let (mut n, mut id, mut version, mut open) = (0u64, 0u64, 1.0, false);
	while n < steps {
		if n % 25 == 0 || (!open && r.below(6) == 0) {
			version = 1.0 + r.below(4) as f64;
			let s = seed(&mut r, version);
			ts.step(&s);
			world.docs.borrow_mut().clear();
			world.docs.borrow_mut().insert((ROUTING.to_owned(), SPACE.to_owned()), s.get("routing").cloned().unwrap());
			if let Some(j) = s.get("journal") {
				world.docs.borrow_mut().insert((JOURNAL.to_owned(), SPACE.to_owned()), j.clone());
			}
			if let Some(p) = s.get("ledger") {
				world.docs.borrow_mut().insert((PROFILES.to_owned(), SPACE.to_owned()), p.clone());
			}
			if let Some(p) = s.get("parents") {
				world.docs.borrow_mut().insert((OPERATIONS.to_owned(), phi_core::routing::parent_journal_key("root", 1.0, 0.0).unwrap()), p.clone());
			}
			*world.version.borrow_mut() = Json::Null;
			open = false;
		}
		n += 1;
		let mut l = phi_json::Object::new();
		if !open {
			id += 1;
		}
		let op = if open && r.below(4) != 0 { "advance" } else { ["start", "execute"][r.below(2) as usize] };
		// advance is only called on an id that start took; TypeScript stumbles over any other
		let other = op != "advance" && r.below(20) == 0;
		l.insert("id", if other { ["__proto__", "another"][r.below(2) as usize].into() } else { format!("t{id}").into() });
		l.insert("op", op.into());
		l.insert("next", next(&mut r, version));
		let bad = r.below(3) == 0;
		l.insert("plan", Json::Array((0..4).map(|i| if bad && i == r.below(3) { fault(&mut r) } else { obj! {} }).collect()));
		if open && r.below(30) == 0 {
			let moved = world.docs.borrow().get(&(ROUTING.to_owned(), SPACE.to_owned())).unwrap().get("members").unwrap().as_object().unwrap().keys().next().unwrap().to_owned();
			let edit = if r.below(2) == 0 { obj! { "target" => moved.as_str() } } else { obj! { "policy" => changed(&policy(version), "rules", Json::Array(vec![])) } };
			let mut d = world.docs.borrow().get(&(ROUTING.to_owned(), SPACE.to_owned())).cloned().unwrap();
			if edit.get("target").is_some() {
				let t = d.as_object_mut().unwrap().get_mut("members").unwrap().as_object_mut().unwrap().get_mut(&moved).unwrap().as_object_mut().unwrap().get_mut("target").unwrap().as_object_mut().unwrap();
				let e = t.get("primaryEpoch").and_then(Json::as_f64).unwrap();
				t.insert("primaryEpoch", (e + 1.0).into());
			} else {
				d.as_object_mut().unwrap().insert("policy", edit.get("policy").cloned().unwrap());
			}
			world.docs.borrow_mut().insert((ROUTING.to_owned(), SPACE.to_owned()), d);
			l.insert("edit", edit);
		}
		let l = Json::Object(l);
		*world.plan.borrow_mut() = l.get("plan").unwrap().as_array().unwrap().iter().cloned().collect();
		world.sent.borrow_mut().clear();
		let (id_now, next_policy) = (text(&l, "id").unwrap(), l.get("next").unwrap());
		let got = runtime.block_on(async { match op { "start" => c.start(id_now, next_policy).await, "advance" => c.advance(id_now).await, _ => c.execute(id_now, next_policy).await } });
		let t = ts.step(&l);
		let context = format!("step {n}: {}", l.to_json_text());
		match (&got, t.get("ok") == Some(&Json::Bool(true))) {
			(Ok(v), true) => {
				assert_eq!(v.canonical(), t.get("result").unwrap().canonical(), "answer, {context}");
				*seen.entry(text(v, "phase").unwrap().to_owned()).or_default() += 1;
				open = text(v, "phase") != Some("completed");
			}
			(Err(e), false) => {
				assert_eq!(e.message, text(&t, "message").unwrap(), "refusal, {context}");
				if e.class == "RoutingConflict" {
					assert_eq!(text(&t, "error"), Some("RoutingConflict"), "class, {context}");
				}
				*seen.entry(e.message.chars().take(40).collect()).or_default() += 1;
				if world.docs.borrow().get(&(PROFILES.to_owned(), SPACE.to_owned())).is_some_and(|d| d.get("operations").and_then(|o| o.get(&format!("t{id}"))).is_some_and(|o| text(o, "phase") != Some("completed"))) {
					open = true;
				}
			}
			_ => panic!("{got:?} against {} ON {context}", text(&t, "message").unwrap_or("an answer")),
		}
		assert_eq!(Json::Array(world.sent.borrow().clone()).canonical(), t.get("sent").unwrap().canonical(), "instructions, {context}");
		let doc = |kind: &str| world.docs.borrow().get(&(kind.to_owned(), SPACE.to_owned())).cloned().unwrap_or(Json::Null);
		assert_eq!(doc(ROUTING).canonical(), t.get("routing").unwrap().canonical(), "routing, {context}");
		assert_eq!(doc(PROFILES).canonical(), t.get("ledger").unwrap().canonical(), "ledger, {context}");
		assert_eq!(Some(&*world.version.borrow()), t.get("version"), "counter, {context}");
	}
	eprintln!("{seen:?}");
	assert!(seen.get("completed").is_some_and(|n| *n > 20) && seen.get("resuming").is_some_and(|n| *n > 0), "{seen:?}");
}
