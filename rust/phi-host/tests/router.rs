// R6a: RouterController against TypeScript (test/support/router-driver.ts). A random walk of commands whose Members lose replies, refuse
// and answer wrongly, with restarts, crashes at the checkpoints and a lost authority. Each answer, the journal index and every command
// document must be the same, so either side can take over the other's journal. `PHI_ROUTER_STEPS` sets the length.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError};
use phi_host::router::{Reprepared, RouterController, RouterEnv, COMMANDS, DEFAULT_LIMITS, JOURNAL};
use phi_json::{digest_json, obj, text, Json, Object};
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

type Docs = HashMap<(String, String), Json>;
#[derive(Default)]
struct World {
	docs: RefCell<Docs>,
	plan: RefCell<VecDeque<Json>>,
	reprepares: RefCell<VecDeque<Json>>,
	crash: RefCell<Option<String>>,
	denied: Cell<bool>,
	clock: Cell<f64>,
}
#[derive(Clone)]
struct Env(Rc<World>);
impl Env {
	fn receipt(&self, s: Json) -> Result<Json, ()> {
		let next = self.0.plan.borrow_mut().pop_front().unwrap_or_else(|| obj! { "outcome" => "done", "result" => s.get("requestId").cloned().unwrap_or(Json::Null) });
		if next.as_str() == Some("throw") {
			return Err(());
		}
		let mut o = Object::new();
		for k in ["target", "principal", "method", "generation", "requestId", "argHash"] {
			o.insert(k, s.get(k).cloned().unwrap_or(Json::Null));
		}
		for (k, v) in next.as_object().unwrap().iter() {
			if k == "tamper" {
				o.insert("generation", "other".into());
			} else {
				o.insert(k, v.clone());
			}
		}
		Ok(Json::Object(o))
	}
}
impl RouterEnv for Env {
	fn read(&self, kind: &str, key: &str) -> Result<Option<Json>, CoreError> { Ok(self.0.docs.borrow().get(&(kind.to_owned(), key.to_owned())).cloned()) }
	fn commit(&self, writes: Vec<(String, String, Json)>) -> Result<(), CoreError> {
		for (kind, key, value) in writes {
			self.0.docs.borrow_mut().insert((kind, key), value);
		}
		Ok(())
	}
	fn assert_authority(&self) -> Local<Result<(), CoreError>> {
		let denied = self.0.denied.get();
		Box::pin(async move { if denied { Err(error("AuthorityLost", "no authority")) } else { Ok(()) } })
	}
	fn invoke(&self, step: Json) -> Local<Result<Json, ()>> { let r = self.receipt(step); Box::pin(async move { r }) }
	fn resolve(&self, step: Json) -> Local<Result<Json, ()>> { let r = self.receipt(step); Box::pin(async move { r }) }
	fn reprepare(&self, _: Json) -> Local<Result<Reprepared, ()>> {
		let next = self.0.reprepares.borrow_mut().pop_front();
		Box::pin(async move {
			match next.as_ref().and_then(Json::as_str) {
				Some("throw") => Err(()),
				Some("wait") => Ok(Reprepared::Wait),
				None | Some("refuse") => match next {
					Some(ref spec) if spec.as_str().is_none() => Ok(Reprepared::Spec(spec.clone())),
					_ => Ok(Reprepared::Refuse),
				},
				Some(_) => Ok(Reprepared::Refuse),
			}
		})
	}
	fn checkpoint(&self, point: &'static str, _: &Json) -> Local<Result<(), CoreError>> {
		let hit = self.0.crash.borrow().as_deref() == Some(point);
		if hit {
			*self.0.crash.borrow_mut() = None;
		}
		Box::pin(async move { if hit { Err(error("Crash", point)) } else { Ok(()) } })
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
	fn pick<T: Clone>(&mut self, v: &[T]) -> T { v[self.below(v.len() as u64) as usize].clone() }
}

fn target(epoch: f64) -> Json { obj! { "hostId" => "h", "spaceId" => "s", "authorityId" => "a", "dataIncarnation" => "i", "primaryEpoch" => epoch } }
fn step(r: &mut Rng) -> Json {
	let mut s = obj! { "target" => target(1.0), "principal" => obj! { "peerId" => "p" }, "generation" => "g", "method" => r.pick(&["write", "take", "read"]), "args" => obj! { "n" => r.below(4) as f64 } };
	let o = s.as_object_mut().unwrap();
	if r.below(4) == 0 {
		o.insert("policyVersion", Json::Number(1.0));
	}
	if r.below(4) == 0 {
		o.insert("resultBudgetBytes", Json::Number(r.pick(&[64.0, 128.0, 1024.0])));
	}
	if r.below(6) == 0 {
		o.insert("generationAdmitUntil", Json::Number(5000.0));
	}
	match r.below(24) {
		0 => o.insert("method", "exec".into()),
		1 => o.insert("target", target(0.0)),
		2 => o.insert("generation", "".into()),
		3 => o.insert("resultBudgetBytes", Json::Number(10.0)),
		_ => {}
	}
	s
}
fn outcome(r: &mut Rng) -> Json {
	match r.below(14) {
		0..=2 => "throw".into(),
		3 => obj! { "outcome" => "pending" },
		4 => obj! { "outcome" => "failed", "evidence" => "é".repeat(300) },
		5 => obj! { "outcome" => "cancelled" },
		6 => obj! { "outcome" => "notAdmitted" },
		7 => obj! { "outcome" => "notAdmitted", "evidence" => r.pick(&["ReplicaConfigPending", "StalePolicyVersion"]) },
		8 => obj! { "outcome" => "needsReview" },
		9 => obj! { "outcome" => "nonsense" },
		10 => obj! { "outcome" => "done", "tamper" => true },
		11 => obj! { "outcome" => "done", "result" => "x".repeat(20_000) },
		_ => obj! { "outcome" => "done", "result" => r.below(9) as f64 },
	}
}
fn spec_again() -> Json { obj! { "target" => target(2.0), "generation" => "g2", "policyVersion" => 2.0 } }
fn line(r: &mut Rng) -> Json {
	let id = format!("c{}", r.below(12));
	let mut l = match r.below(16) {
		0 => obj! { "op" => "open", "router" => "r1", "authority" => "a" },
		1 => obj! { "op" => "recover" },
		2..=5 => {
			let steps: Vec<Json> = (0..=r.below(3)).map(|_| step(r)).collect();
			let mut spec = obj! { "id" => id, "area" => format!("area{}", r.below(3)), "steps" => steps };
			if r.below(3) == 0 {
				spec.as_object_mut().unwrap().insert("blocksArea", Json::Bool(true));
			}
			let mut l = obj! { "op" => "submit", "spec" => spec };
			if r.below(5) == 0 {
				l.as_object_mut().unwrap().insert("future", format!("f{}", r.below(3)).into());
			}
			l
		}
		6..=10 => obj! { "op" => "advance", "id" => id },
		11 => obj! { "op" => "review", "id" => id, "admin" => "root", "note" => r.pick(&["", "looked at it", "ok"]), "release" => r.below(2) == 0 },
		12 => obj! { "op" => "reserve", "id" => format!("f{}", r.below(3)), "slots" => r.pick(&[1.0, 2.0, 0.0, 200.0]), "bytes" => r.pick(&[1024.0, 200_000.0, 2048.0, 1.0]) },
		13 => obj! { "op" => "release", "id" => format!("f{}", r.below(3)) },
		_ => obj! { "op" => "get", "id" => id },
	};
	let o = l.as_object_mut().unwrap();
	o.insert("plan", Json::Array((0..r.below(4)).map(|_| outcome(r)).collect()));
	o.insert("reprepares", Json::Array(vec![r.pick(&["throw".into(), "wait".into(), "refuse".into(), spec_again(), spec_again()])]));
	// a Member that refuses again after the step was prepared anew
	if r.below(6) == 0 {
		let refused = obj! { "outcome" => "notAdmitted", "evidence" => "StalePolicyVersion" };
		o.insert("plan", Json::Array(vec![refused.clone(), refused]));
		o.insert("reprepares", Json::Array(vec![spec_again(), spec_again()]));
	}
	if r.below(12) == 0 {
		o.insert("crash", r.pick(&["beforeSend", "afterReply"]).into());
	}
	if r.below(30) == 0 {
		o.insert("denied", Json::Bool(true));
	}
	l
}

async fn run(c: &mut Option<RouterController<Env>>, env: &Env, l: &Json) -> Result<Json, CoreError> {
	let w = &env.0;
	let list = |k: &str| l.get(k).and_then(Json::as_array).map_or(VecDeque::new(), |a| a.iter().cloned().collect());
	*w.plan.borrow_mut() = list("plan");
	*w.reprepares.borrow_mut() = list("reprepares");
	*w.crash.borrow_mut() = text(l, "crash").map(str::to_owned);
	w.denied.set(l.get("denied") == Some(&Json::Bool(true)));
	w.clock.set(w.clock.get() + 1.0);
	let id = text(l, "id").unwrap_or("");
	let number = |k: &str| l.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN);
	if text(l, "op") == Some("open") {
		*c = Some(RouterController::new(env.clone(), "r1", "a", DEFAULT_LIMITS)?);
		return Ok(Json::Null);
	}
	let r = c.as_mut().expect("opened");
	match text(l, "op").unwrap_or("") {
		"recover" => r.recover().await.map(|()| Json::Null),
		"submit" => r.submit(l.get("spec").unwrap(), text(l, "future"), None).await,
		"advance" => r.advance(id, None).await,
		"review" => r.review(id, text(l, "admin").unwrap(), text(l, "note").unwrap(), l.get("release") == Some(&Json::Bool(true))).await,
		"reserve" => r.reserve_future(id, number("slots"), Some(number("bytes"))).await.map(|()| Json::Null),
		"release" => r.release_future(id).await.map(|()| Json::Null),
		_ => r.get(id).await.map(|c| c.unwrap_or(Json::Null)),
	}
}

fn state(env: &Env) -> (Json, Json) {
	let docs = env.0.docs.borrow();
	let index = docs.get(&(JOURNAL.to_owned(), "r1".to_owned())).cloned().unwrap_or(Json::Null);
	let mut commands = Object::new();
	if let Some(refs) = index.get("refs").and_then(Json::as_object) {
		for (id, _) in refs.iter() {
			let key = digest_json(&Json::Array(vec!["r1".into(), id.into()])).unwrap();
			commands.insert(id, docs.get(&(COMMANDS.to_owned(), key)).and_then(|d| d.get("command")).cloned().unwrap_or(Json::Null));
		}
	}
	(index, Json::Object(commands))
}

#[test]
fn a_walk_of_commands_leaves_the_same_journal() {
	let steps: u64 = std::env::var("PHI_ROUTER_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/router-driver.ts");
	let env = Env(Rc::new(World::default()));
	env.0.clock.set(1000.0);
	let (mut c, mut r) = (None, Rng(0x2545_f491_4f6c_dd1d));
	let mut counts: HashMap<String, usize> = HashMap::new();
	let first = [obj! { "op" => "open", "router" => "r1", "authority" => "a" }, obj! { "op" => "recover" }];
	for n in 0..steps as usize + 2 {
		let l = first.get(n).cloned().unwrap_or_else(|| line(&mut r));
		let got = runtime.block_on(run(&mut c, &env, &l));
		let t = ts.step(&l);
		let context = l.to_json_text();
		match (&got, t.get("ok") == Some(&Json::Bool(true))) {
			(Ok(v), true) => {
				assert_eq!(Some(v), t.get("result"), "answer of step {n}: {context}");
				*counts.entry(text(v, "state").unwrap_or("-").to_owned()).or_default() += 1;
			}
			(Err(e), false) => {
				assert_eq!((e.class, e.message.as_str()), (text(&t, "error").unwrap_or(""), text(&t, "message").unwrap_or("")), "refusal of step {n}: {context}");
				*counts.entry(e.class.to_owned()).or_default() += 1;
			}
			_ => panic!("step {n}: {got:?} against {} on {context}", t.to_json_text()),
		}
		env.0.denied.set(false);
		let (index, commands) = state(&env);
		assert_eq!(Some(&index), t.get("index"), "index after step {n}: {context}");
		assert_eq!(Some(&commands), t.get("commands"), "commands after step {n}: {context}");
	}
	for wanted in ["completed", "failed", "needsReview", "applying", "RouterBlocked", "RouterConflict", "RouterBudgetExceeded", "TypeError"] {
		assert!(counts.contains_key(wanted), "the walk never reached {wanted}: {counts:?}");
	}
}
