// R6a: FederatedSpace against TypeScript (test/support/federated-driver.ts). Writes, reads, transactions and races over two Members who lose
// replies, refuse and send events, with restarts, in one and in several journal partitions. Every answer, every call to a Member and every
// journal document must be the same. `PHI_FEDERATED_SEASONS` sets how many fresh stores the walk goes through.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::routing::{parent_journal_key, partition_router_id};
use phi_core::space::{error, CoreError};
use phi_host::federated_space::{FederatedSpace, FederationIo, LAYOUT, OPERATIONS};
use phi_host::router::{RouterController, RouterEnv, COMMANDS, DEFAULT_LIMITS, JOURNAL};
use phi_json::{digest_json, obj, text, Json, Object};
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

const ID: &str = "f1";
#[derive(Default)]
struct World {
	docs: RefCell<HashMap<(String, String), Json>>,
	plan: RefCell<VecDeque<Json>>,
	steps: RefCell<VecDeque<Json>>,
	events: RefCell<VecDeque<Json>>,
	snapshots: RefCell<VecDeque<Json>>,
	active: RefCell<VecDeque<Json>>,
	calls: RefCell<Vec<Json>>,
	state: RefCell<Option<Json>>,
	clock: Cell<f64>,
	generation: Cell<u64>,
	seq: Cell<f64>,
}
#[derive(Clone)]
struct Env(Rc<World>);
fn tail(s: &str) -> &str { &s[s.len() - 8..] }
impl Env {
	fn receipt(&self, s: Json) -> Result<Json, ()> {
		let request = text(&s, "requestId").unwrap().to_owned();
		let default = match text(&s, "method") {
			Some("wait") => format!("reg-{}", tail(&request)).into(),
			Some("txn") => obj! { "id" => format!("t-{}", tail(&request)) },
			Some("lease") => Json::Null,
			_ => obj! { "id" => format!("x-{}", tail(&request)) },
		};
		let next = self.0.plan.borrow_mut().pop_front().unwrap_or_else(|| obj! { "outcome" => "done", "result" => default });
		if next.as_str() == Some("throw") {
			return Err(());
		}
		let mut o = Object::new();
		for k in ["target", "principal", "method", "generation", "requestId", "argHash"] {
			o.insert(k, s.get(k).cloned().unwrap_or(Json::Null));
		}
		for (k, v) in next.as_object().unwrap().iter() {
			o.insert(k, v.clone());
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
	fn assert_authority(&self) -> Local<Result<(), CoreError>> { Box::pin(async { Ok(()) }) }
	fn invoke(&self, step: Json) -> Local<Result<Json, ()>> { let r = self.receipt(step); Box::pin(async move { r }) }
	fn resolve(&self, step: Json) -> Local<Result<Json, ()>> { let r = self.receipt(step); Box::pin(async move { r }) }
	fn now(&self) -> f64 { self.0.clock.get() }
}
fn or_null(v: Option<&Json>) -> Json { v.cloned().unwrap_or(Json::Null) }
impl FederationIo for Env {
	fn state(&self) -> Result<Json, CoreError> { Ok(self.0.state.borrow().clone().unwrap()) }
	fn step(&self, member: &str, principal: &Json, method: &str, args: &Json, policy_version: Option<&Json>, origin: Option<&Json>) -> Local<Result<Json, CoreError>> {
		let w = &self.0;
		w.calls.borrow_mut().push(Json::Array(vec!["step".into(), member.into(), method.into(), args.clone(), or_null(policy_version), origin.map_or(Json::Null, |o| or_null(o.get("requestId")))]));
		let how = w.steps.borrow_mut().pop_front();
		let answer = match how.as_ref().and_then(Json::as_str) {
			Some("transport") => Err(error("TransportFailure", "no line")),
			Some("pending") => Err(error("ReplicaConfigPending", "wait")),
			_ => {
				w.generation.set(w.generation.get() + 1);
				let state = self.state().unwrap();
				let version = policy_version.cloned().unwrap_or_else(|| or_null(state.get("policy").unwrap().get("policyVersion")));
				Ok(obj! { "target" => or_null(state.get("members").unwrap().get(member).unwrap().get("target")), "principal" => principal.clone(), "generation" => format!("g-{}", w.generation.get()), "method" => method, "args" => args.clone(), "policyVersion" => version })
			}
		};
		Box::pin(async move { answer })
	}
	fn snapshot(&self, member: &str, _: &Json, template: &Json, txn: Option<&Json>) -> Local<Result<Json, CoreError>> {
		self.0.calls.borrow_mut().push(Json::Array(vec!["snapshot".into(), member.into(), template.clone(), or_null(txn)]));
		let broken = self.0.snapshots.borrow_mut().pop_front().is_some_and(|s| s.as_str() == Some("throw"));
		let id = format!("e-{member}");
		Box::pin(async move { if broken { Err(error("Error", "no snapshot")) } else { Ok(obj! { "entries" => vec![obj! { "id" => id }], "revision" => 3.0 }) } })
	}
	fn events(&self, member: &str, _: &Json, registration: &Json) -> Local<Result<Json, CoreError>> {
		let w = &self.0;
		w.calls.borrow_mut().push(Json::Array(vec!["events".into(), member.into(), or_null(registration.get("requestId"))]));
		let page = w.events.borrow_mut().pop_front();
		let answer = match page {
			Some(p) if p.as_str() == Some("gap") => obj! { "epoch" => "ep", "events" => Vec::<Json>::new(), "gap" => true },
			None => obj! { "epoch" => "ep", "events" => Vec::<Json>::new() },
			Some(p) => {
				w.seq.set(w.seq.get() + 1.0);
				let event_id = if p.get("other").is_some() { "other".into() } else { or_null(registration.get("result")) };
				let mut e = obj! { "eventId" => event_id, "kind" => or_null(p.get("kind")) };
				for k in ["entry", "txn"] {
					if let Some(v) = p.get(k) {
						e.as_object_mut().unwrap().insert(k, v.clone());
					}
				}
				obj! { "epoch" => "ep", "events" => vec![obj! { "seq" => w.seq.get(), "event" => e }] }
			}
		};
		Box::pin(async move { Ok(answer) })
	}
	fn ack(&self, member: &str, _: &Json, epoch: &str, seq: f64) -> Local<Result<(), CoreError>> {
		self.0.calls.borrow_mut().push(Json::Array(vec!["ack".into(), member.into(), epoch.into(), seq.into()]));
		Box::pin(async { Ok(()) })
	}
	fn txn_active(&self, member: &str, _: &Json, txn: &str, _: Option<&Json>) -> Local<Result<bool, CoreError>> {
		self.0.calls.borrow_mut().push(Json::Array(vec!["txnActive".into(), member.into(), txn.into()]));
		let v = self.0.active.borrow_mut().pop_front().is_none_or(|a| a == Json::Bool(true));
		Box::pin(async move { Ok(v) })
	}
}

type Space = FederatedSpace<Env, Env>;
async fn open(env: &Env, partitions: u64) -> Space {
	let make = |id: &str| RouterController::new(env.clone(), id, "a", DEFAULT_LIMITS).unwrap();
	let parts = if partitions == 1 { vec![] } else { (0..partitions).map(|n| make(&partition_router_id(ID, n as f64).unwrap())).collect() };
	let mut s = FederatedSpace::new(env.clone(), env.clone(), ID, make(ID), parts, Some("ctl")).unwrap();
	s.initialize_journals().await.unwrap();
	s.recover_journals().await.unwrap();
	s
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
fn strings(l: &[&str]) -> Json { Json::Array(l.iter().map(|s| Json::from(*s)).collect()) }
fn state() -> Json {
	let target = |h: &str| obj! { "hostId" => h, "spaceId" => "s", "authorityId" => "a", "dataIncarnation" => "i", "primaryEpoch" => 1.0 };
	let mut table = Object::new();
	let wide: Vec<String> = (1..=9).map(|n| format!("m{n}")).collect();
	for id in &wide {
		table.insert(id, obj! { "id" => id.as_str(), "state" => "active", "target" => target(&format!("h{}", &id[1..])) });
	}
	let policy = obj! { "authorityId" => "a", "policyVersion" => 1.0, "completionProfiles" => Vec::<Json>::new(), "default" => obj! { "mode" => "local", "member" => "m1" }, "rules" => vec![
		obj! { "type" => "One", "mode" => "local", "member" => "m1" },
		obj! { "type" => "Two", "mode" => "local", "member" => "m2", "supertypes" => strings(&["One"]) },
		obj! { "type" => "Both", "mode" => "expand", "members" => strings(&["m1", "m2"]), "by" => obj! { "field" => "k" } },
		obj! { "type" => "Wide", "mode" => "expand", "members" => phi_json::strings(&wide), "by" => "capacity" },
		obj! { "type" => "Merged", "mode" => "sync", "variant" => "set", "members" => strings(&["m1", "m2"]), "semantics" => "facts" },
	] };
	obj! { "policy" => policy, "members" => table }
}
fn outcome(r: &mut Rng) -> Json {
	match r.below(12) {
		0 | 1 => "throw".into(),
		2 => obj! { "outcome" => "pending" },
		3 => obj! { "outcome" => "failed", "evidence" => r.pick(&["TransactionError", "UnknownLeaseError", "Boom"]) },
		4 => obj! { "outcome" => "needsReview" },
		5 => obj! { "outcome" => "notAdmitted" },
		6 => obj! { "outcome" => "done", "result" => Json::Null },
		7 => obj! { "outcome" => "done", "result" => obj! { "blob" => "x".repeat(14_000) } },
		_ => obj! { "outcome" => "done", "result" => obj! { "id" => "y" } },
	}
}
fn principal(r: &mut Rng) -> Json { r.pick(&[obj! { "peerId" => "p" }, obj! { "peerId" => "p" }, obj! { "peerId" => "q" }]) }
fn template(r: &mut Rng) -> Json {
	let t = r.pick(&["One", "Two", "Both", "Merged", "Other", "Wide"]);
	match r.below(5) {
		0 => Json::Null,
		1 => obj! { "type" => t, "fields" => obj! { "k" => "a" } },
		_ => obj! { "type" => t },
	}
}
/// A line of the walk; `late` in a season: a data restore may be reconciled, which sends its operations to review.
fn line(r: &mut Rng, ops: u64, late: bool) -> Json {
	let id = format!("o{}", r.below(ops));
	let who = principal(r);
	let mut l = match r.below(14) {
		0 if late => {
			let mut restore = obj! { "hostId" => r.pick(&["h1", "h2", "h9"]), "spaceId" => "s", "oldIncarnation" => r.pick(&["i", "i", "j"]), "recoveryId" => r.pick(&["rec-1", "rec-1", "rec-2", "bad id!"]) };
			if r.below(8) == 0 {
				restore.as_object_mut().unwrap().insert("extra", "x".into());
			}
			obj! { "op" => "reconcile", "restore" => restore }
		}
		0 => obj! { "op" => "restart" },
		1..=3 => {
			let type_ = r.pick(&["One", "Two", "Both", "Merged", "Other"]);
			let mut entry = obj! { "type" => type_, "fields" => obj! { "k" => r.pick(&["a", "b", "c"]) } };
			if r.below(4) == 0 {
				entry.as_object_mut().unwrap().insert("types", r.pick(&[strings(&["One"]), strings(&["Nope"])]));
			}
			obj! { "op" => "write", "id" => id, "principal" => who, "entry" => entry, "leaseMs" => r.pick(&[Json::Null, Json::Number(1000.0)]) }
		}
		4 => obj! { "op" => "read", "id" => id, "principal" => who, "template" => template(r) },
		5 => obj! { "op" => "take", "id" => id, "principal" => who, "template" => template(r) },
		6 => obj! { "op" => "begin", "id" => id, "principal" => who, "member" => r.pick(&["m1", "m2"]), "leaseMs" => r.pick(&[1000.0, 0.0]) },
		7 => obj! { "op" => "finish", "id" => id, "principal" => who, "origin" => format!("o{}", r.below(ops)), "action" => r.pick(&["commit", "abort"]) },
		8 | 9 => obj! { "op" => "takeWaiting", "id" => id, "principal" => who, "template" => template(r), "timeoutMs" => r.pick(&[1000.0, 0.0]), "txnLeaseMs" => 1000.0 },
		10 => obj! { "op" => "readWaiting", "id" => id, "principal" => who, "template" => template(r), "timeoutMs" => 1000.0 },
		11 | 12 => obj! { "op" => "resume", "id" => id },
		_ => obj! { "op" => r.pick(&["readAll", "count"]), "principal" => who, "template" => template(r), "partial" => r.below(2) == 0 },
	};
	let o = l.as_object_mut().unwrap();
	o.insert("plan", Json::Array((0..r.below(4)).map(|_| outcome(r)).collect()));
	o.insert("steps", Json::Array((0..r.below(2)).map(|_| r.pick(&["transport".into(), "pending".into(), "ok".into()])).collect()));
	o.insert("snapshots", Json::Array((0..r.below(2)).map(|_| r.pick(&["throw".into(), "ok".into()])).collect()));
	o.insert("active", Json::Array((0..r.below(2)).map(|_| Json::Bool(r.below(2) == 0)).collect()));
	// a race that timed out, whose registration the Member has dropped already
	if r.below(10) == 0 {
		o.insert("op", "takeWaiting".into());
		o.insert("id", format!("r{}", r.below(1000)).into());
		o.insert("principal", obj! { "peerId" => "p" });
		o.insert("template", obj! { "type" => "Two" });
		o.insert("timeoutMs", Json::Number(1000.0));
		o.insert("txnLeaseMs", Json::Number(1000.0));
		o.insert("plan", Json::Array(vec![obj! { "outcome" => "done", "result" => "reg" }, obj! { "outcome" => "failed", "evidence" => "TransactionError" }]));
		o.insert("steps", Json::Array(vec![]));
		o.insert("events", Json::Array(vec![obj! { "kind" => "timeout" }]));
		return l;
	}
	o.insert("events", Json::Array((0..r.below(5)).map(|_| match r.below(6) {
		0 => "gap".into(),
		1 => obj! { "kind" => "x", "other" => true },
		2 | 3 => obj! { "kind" => "timeout" },
		_ => obj! { "kind" => "match", "entry" => obj! { "id" => "w" }, "txn" => "t9" },
	}).collect()));
	l
}

fn dump(env: &Env, partitions: u64) -> Json {
	let docs = env.0.docs.borrow();
	let get = |kind: &str, key: &str| docs.get(&(kind.to_owned(), key.to_owned())).cloned().unwrap_or(Json::Null);
	let mut o = Object::new();
	o.insert("layout", get(LAYOUT, ID));
	for p in 0..partitions {
		o.insert(format!("ops:{p}"), get(OPERATIONS, &parent_journal_key(ID, partitions as f64, p as f64).unwrap()));
	}
	let mut routers = vec![ID.to_owned()];
	if partitions > 1 {
		routers.extend((0..partitions).map(|n| partition_router_id(ID, n as f64).unwrap()));
	}
	for r in routers {
		let index = get(JOURNAL, &r);
		o.insert(format!("journal:{r}"), index.clone());
		if let Some(refs) = index.get("refs").and_then(Json::as_object) {
			for (id, _) in refs.iter() {
				let key = digest_json(&Json::Array(vec![r.as_str().into(), id.into()])).unwrap();
				o.insert(format!("command:{r}:{id}"), or_null(get(COMMANDS, &key).get("command")));
			}
		}
	}
	Json::Object(o)
}

async fn run(s: &mut Space, l: &Json, env: &Env, partitions: u64) -> Result<Json, CoreError> {
	let null = Json::Null;
	let arg = |k: &str| l.get(k).unwrap_or(&null);
	let mut q = obj! { "id" => or_null(l.get("id")), "principal" => or_null(l.get("principal")) };
	if let Some(t) = l.get("txn") {
		q.as_object_mut().unwrap().insert("txn", t.clone());
	}
	let number = |k: &str| l.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN);
	let id = text(l, "id").unwrap_or("");
	let partial = l.get("partial") == Some(&Json::Bool(true));
	match text(l, "op").unwrap() {
		"restart" => {
			*s = open(env, partitions).await;
			Ok(Json::Null)
		}
		"write" => s.write(arg("entry"), &q, l.get("leaseMs").filter(|x| !x.is_null())).await,
		"read" => s.read(arg("template"), &q).await,
		"take" => s.take(arg("template"), &q).await,
		"begin" => s.create_transaction(text(l, "member").unwrap(), number("leaseMs"), &q).await,
		"finish" => s.finish_transaction(text(l, "origin").unwrap(), text(l, "action").unwrap(), &q).await,
		"takeWaiting" => s.take_waiting(arg("template"), number("timeoutMs"), number("txnLeaseMs"), &q).await,
		"readWaiting" => s.read_waiting(arg("template"), number("timeoutMs"), &q).await,
		"resume" => s.resume(id).await,
		"reconcile" => s.reconcile_data_restore(arg("restore")).await.map(|ids| Json::Array(ids.into_iter().map(Json::String).collect())),
		"readAll" => s.read_all(arg("template"), arg("principal"), partial, None, None).await,
		_ => s.count(arg("template"), arg("principal"), partial, None, None).await,
	}
}

#[test]
fn a_walk_of_operations_leaves_the_same_journals() {
	let seasons: u64 = std::env::var("PHI_FEDERATED_SEASONS").ok().and_then(|n| n.parse().ok()).unwrap_or(60);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/federated-driver.ts");
	let mut r = Rng(0xdead_beef_cafe_f00d);
	let mut seen: HashMap<String, usize> = HashMap::new();
	let mut clock = 1000.0;
	for season in 0..seasons {
		let partitions = r.pick(&[1, 1, 3]);
		let env = Env(Rc::new(World::default()));
		clock += 1.0;
		env.0.clock.set(clock);
		*env.0.state.borrow_mut() = Some(state());
		env.0.docs.borrow_mut().insert(("phi-spaces.federation-routing".to_owned(), "ctl".to_owned()), state());
		let t = ts.step(&obj! { "op" => "season", "partitions" => partitions as f64, "state" => state() });
		assert_eq!(t.get("ok"), Some(&Json::Bool(true)), "{}", t.to_json_text());
		let mut space = runtime.block_on(open(&env, partitions));
		assert_eq!(dump(&env, partitions).canonical(), t.get("docs").unwrap().canonical(), "after the opening of season {season}");
		let ops = r.pick(&[6, 12]);
		for n in 0..40 {
			let l = line(&mut r, ops, n >= 34);
			let w = &env.0;
			let list = |k: &str| -> VecDeque<Json> { l.get(k).and_then(Json::as_array).map_or(VecDeque::new(), |a| a.iter().cloned().collect()) };
			*w.plan.borrow_mut() = list("plan");
			*w.steps.borrow_mut() = list("steps");
			*w.events.borrow_mut() = list("events");
			*w.snapshots.borrow_mut() = list("snapshots");
			*w.active.borrow_mut() = list("active");
			w.calls.borrow_mut().clear();
			clock += 1.0;
			w.clock.set(clock);
			let got = runtime.block_on(run(&mut space, &l, &env, partitions));
			let t = ts.step(&l);
			let context = format!("season {season} step {n}: {}", l.to_json_text());
			match (&got, t.get("ok") == Some(&Json::Bool(true))) {
				(Ok(v), true) => {
					assert_eq!(v.canonical(), t.get("result").unwrap().canonical(), "answer, {context}");
					*seen.entry("answered".into()).or_default() += 1;
					if text(&l, "op") == Some("reconcile") && v.as_array().is_some_and(|a| !a.is_empty()) {
						*seen.entry("reconciled".into()).or_default() += 1;
					}
				}
				// a shape TypeScript stumbles over (a write retried under the id of a read) is refused here by name
				(Err(_), false) if text(&t, "error") == Some("TypeError") => {}
				(Err(e), false) => {
					assert_eq!(format!("{}: {}", e.class, e.message), format!("{}: {}", text(&t, "error").unwrap(), text(&t, "message").unwrap()), "refusal, {context}");
					*seen.entry(e.class.to_owned()).or_default() += 1;
				}
				_ => panic!("{got:?} against {} ON {context}", text(&t, "message").unwrap_or("an answer")),
			}
			assert_eq!(Json::Array(w.calls.borrow().clone()).canonical(), t.get("calls").unwrap().canonical(), "calls, {context}");
			assert_eq!(dump(&env, partitions).canonical(), t.get("docs").unwrap().canonical(), "documents, {context}");
		}
	}
	for wanted in ["answered", "FederationPending", "FederationUnavailable", "RoutingConflict", "MergeTypeNotExclusive", "reconciled"] {
		assert!(seen.contains_key(wanted), "never reached {wanted}: {seen:?}");
	}
}
