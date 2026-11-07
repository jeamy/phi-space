// R6a: RunController against TypeScript (test/support/run-controller-driver.ts). Runs started, paused, resumed, stopped,
// reconciled and resolved over real Member Spaces (every ACK and recovery view comes from phi_core's RunGates on both sides),
// with transport faults, altered ACKs, Members under a restore recovery, a changed control identity, schedules and the clock
// moved past them. Every answer, every Member call and the journal document must be the same, byte for byte.
// `PHI_RUN_STEPS` sets the length, `PHI_RUN_SEED` the seed.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError, Space};
use phi_core::state::SpaceState;
use phi_host::router::RouterEnv;
use phi_host::run_controller::{RunController, RunEnv, JOURNAL};
use phi_json::{obj, text, Json};
use phi_store::system_random;
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

/// The Members of test/support/run-controller-driver.ts: `[spaceId, incarnation]`.
const MEMBERS: [(&str, &str); 3] = [("sp-00000000-0000-4000-8000-00000000000a", "0000000a"), ("sp-00000000-0000-4000-8000-00000000000b", "0000000b"), ("sp-00000000-0000-4000-8000-00000000000c", "0000000c")];
fn job_profile() -> Json { obj! { "taskType" => "Job", "resultTypes" => vec![Json::from("Done")], "equalFields" => vec![Json::from("runId"), Json::from("n")], "maxResultCount" => 1.0, "maxLeaseMs" => 60_000.0, "gateField" => "runId" } }
fn default_identity() -> Json { obj! { "authorityId" => "authority", "incarnation" => "control-1" } }

struct World {
	docs: RefCell<HashMap<(String, String), Json>>,
	plan: RefCell<VecDeque<Json>>,
	sent: RefCell<Vec<Json>>,
	identity: RefCell<Option<Json>>,
	clock: Cell<f64>,
	members: RefCell<HashMap<String, SpaceState>>,
}
impl World {
	fn reset(&self) {
		self.docs.borrow_mut().clear();
		*self.identity.borrow_mut() = Some(default_identity());
		let mut members = HashMap::new();
		for (space_id, incarnation) in MEMBERS {
			let mut state = SpaceState::initial();
			state.space_id = Some(space_id.into());
			state.incarnation = Some(incarnation.into());
			let mut s = Space::new(state, system_random());
			s.begin_commit();
			s.touch(self.clock.get());
			s.seal();
			s.begin_commit();
			s.set_completion_profiles(self.clock.get(), Some(&Json::Array(vec![job_profile()]))).unwrap();
			s.seal();
			members.insert(space_id.to_owned(), s.state);
		}
		*self.members.borrow_mut() = members;
	}
	/// One Member call as the driver makes it: the scripted fault, else the genuine answer of the Member's Space (its own commit).
	fn call(&self, space_id: &str, run_id: &str, f: impl FnOnce(&mut Space) -> Result<Json, CoreError>) -> Result<Json, CoreError> {
		let next = self.plan.borrow_mut().pop_front().unwrap_or(Json::Null);
		match next.as_str() {
			Some("throw") => return Err(error("Error", "the line broke")),
			Some("underRecovery") => return Err(error("Error", format!("run {run_id} is under recovery rec-1; only its decision applies"))),
			_ => {}
		}
		if let Some(id) = text(&next, "underRecovery") {
			return Err(error("Error", format!("run {run_id} is under recovery {id}; only its decision applies")));
		}
		if let Some(m) = text(&next, "throw") {
			return Err(error("Error", m));
		}
		let state = self.members.borrow().get(space_id).cloned().ok_or_else(|| error("Error", "unknown Member"))?;
		let mut s = Space::new(state, system_random());
		s.begin_commit();
		let r = f(&mut s);
		s.seal();
		let mut v = r?;
		self.members.borrow_mut().insert(space_id.to_owned(), s.state);
		if let Json::Object(o) = &mut v {
			match next.as_str() {
				Some("wrongSpace") => o.insert("spaceId", "other".into()),
				Some("tuple") => o.insert("incarnation", "ffffffff".into()),
				_ => {}
			}
		}
		Ok(v)
	}
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
	fn assert_authority(&self) -> Local<Result<(), CoreError>> { Box::pin(async { Ok(()) }) }
	fn invoke(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn resolve(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn now(&self) -> f64 { self.0.clock.get() }
}
impl RunEnv for Env {
	fn prepare(&self, space_id: &str, spec: &Json, command: &Json) -> Local<Result<Json, CoreError>> {
		self.0.sent.borrow_mut().push(Json::Array(vec![space_id.into(), "prepare".into(), command.clone(), spec.clone()]));
		let now = self.0.clock.get();
		let r = self.0.call(space_id, text(command, "runId").unwrap_or(""), |s| s.apply_run_gate(now, command));
		Box::pin(async move { r })
	}
	fn gate(&self, space_id: &str, command: &Json) -> Local<Result<Json, CoreError>> {
		self.0.sent.borrow_mut().push(Json::Array(vec![space_id.into(), "gate".into(), command.clone()]));
		let now = self.0.clock.get();
		let r = self.0.call(space_id, text(command, "runId").unwrap_or(""), |s| s.apply_run_gate(now, command));
		Box::pin(async move { r })
	}
	fn recover(&self, space_id: &str, run_id: &str, recovery_id: &str) -> Local<Result<Json, CoreError>> {
		let o = obj! { "runId" => run_id, "recoveryId" => recovery_id };
		self.0.sent.borrow_mut().push(Json::Array(vec![space_id.into(), "recover".into(), o.clone()]));
		let now = self.0.clock.get();
		let r = self.0.call(space_id, run_id, |s| s.recover_run_gate(now, &o));
		Box::pin(async move { r })
	}
	fn identity(&self) -> Local<Result<Option<Json>, CoreError>> {
		let i = self.0.identity.borrow().clone();
		Box::pin(async move { Ok(i) })
	}
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
const RUNS: [&str; 7] = ["r1", "r1", "r2", "r2", "r3", "r3", "constructor"];
fn members(r: &mut Rng) -> Json {
	let mut ids: Vec<Json> = MEMBERS.iter().map(|(id, _)| Json::from(*id)).collect();
	match r.below(40) {
		0 => Json::Array((0..65).map(|n| Json::from(format!("m{n}"))).collect()),
		1 => Json::Array(vec![ids[0].clone(), ids[0].clone()]),
		2 => Json::Array(vec![Json::from("-x")]),
		3 => Json::Array(vec![]),
		4 => Json::from("not a list"),
		_ => {
			for i in (1..ids.len()).rev() {
				ids.swap(i, r.below(i as u64 + 1) as usize);
			}
			ids.truncate(1 + r.below(3) as usize);
			Json::Array(ids)
		}
	}
}
fn plan(r: &mut Rng) -> Json {
	if r.below(10) < 5 {
		return Json::Array(vec![]);
	}
	Json::Array((0..r.below(4)).map(|_| match r.below(10) {
		0 | 1 => "throw".into(),
		2 => "wrongSpace".into(),
		3 => "tuple".into(),
		4 => "underRecovery".into(),
		_ => obj! {},
	}).collect())
}
/// One command line; `hashes` holds the last view hash seen per run.
fn line(r: &mut Rng, cmd: &mut u64, now: f64, hashes: &HashMap<String, String>) -> Json {
	*cmd += 1;
	let id = if r.below(40) == 0 { r.pick(&["toString", "constructor", "valueOf", "bad id!"]).to_owned() } else { format!("c{}", *cmd) };
	let run = r.pick(&RUNS);
	let dry = r.below(10) == 0;
	let (op, mut args) = match r.below(100) {
		0..=17 => {
			let kind = match r.below(20) { 0 => Json::from("bad kind!"), 1 => Json::Null, 2 => Json::from(7.0), _ => Json::from("jobs") };
			let config = match r.below(30) { 0 => Json::from("x".repeat(17_000)), 1 => obj! { "n" => 1.0, "tasks" => vec![Json::from("a")] }, 2 => Json::from(1.0), _ => Json::Null };
			("startRun", obj! { "runId" => run, "kind" => kind, "config" => config, "members" => members(r) })
		}
		18..=29 => ("pauseRun", obj! { "runId" => run }),
		30..=41 => ("resumeRun", obj! { "runId" => run }),
		42..=53 => ("stopRun", obj! { "runId" => run }),
		54..=61 => {
			let mut a = obj! { "runId" => run, "recoveryId" => r.pick(&["rec-1", "rec-2", "rec-3", "bad id!"]) };
			if r.below(2) == 0 {
				a.as_object_mut().unwrap().insert("kind", r.pick(&["jobs", "jobs", "other"]).into());
				a.as_object_mut().unwrap().insert("members", members(r));
			}
			("reconcileRun", a)
		}
		62..=69 => {
			let hash = if r.below(5) == 0 { "0".repeat(64) } else { hashes.get(run).cloned().unwrap_or_else(|| "0".repeat(64)) };
			("resolveRunRecovery", obj! { "runId" => run, "expectedViewHash" => hash, "decision" => r.pick(&[Json::from("pause"), "stop".into(), "resume".into(), "resume".into(), "bogus".into(), Json::Null]) })
		}
		70..=72 => {
			let mut a = obj! {};
			if r.below(4) != 0 {
				a.as_object_mut().unwrap().insert("limit", r.pick(&[Json::from(1.0), 2.0.into(), 50.0.into(), "abc".into(), 0.0.into(), (-1.0).into(), 2.5.into(), "2".into(), Json::Null, "Infinity".into(), "+1".into(), "2.".into(), "0x2".into(), "0b1".into(), "INF".into(), " 3 ".into(), Json::Array(vec![Json::from("2")]), Json::Bool(true)]));
			}
			("listRuns", a)
		}
		73..=74 => ("runStatus", obj! { "runId" => run }),
		75..=84 => {
			let later = now + r.below(4) as f64;
			let mut a = obj! { "runId" => run, "kind" => r.pick(&[Json::from("pause"), "resume".into(), "stop".into()]), "at" => r.pick(&[Json::from(later), later.into(), later.into(), "abc".into(), (now + 1.5).into(), "Infinity".into(), number_text_of(later).into(), format!("{}.", number_text_of(later)).into()]) };
			if r.below(2) == 0 {
				a.as_object_mut().unwrap().insert("scheduleId", format!("s{}", r.below(6)).into());
			}
			if r.below(4) == 0 {
				a.as_object_mut().unwrap().insert("cancel", Json::Bool(true));
			}
			("scheduleRun", a)
		}
		85..=86 => ("exportRun", obj! { "runId" => run }),
		87..=95 => return obj! { "op" => "advance", "runId" => run, "plan" => plan(r) },
		96..=97 => return obj! { "op" => "pending" },
		_ => {
			(if r.below(2) == 0 { "pauseRun" } else { "stopRun" }, obj! { "runId" => run })
		}
	};
	if dry {
		args.as_object_mut().unwrap().insert("dryRun", Json::Bool(true));
	}
	obj! { "op" => op, "id" => id, "args" => args, "plan" => plan(r) }
}
fn number_text_of(n: f64) -> String { phi_json::number_text(n) }
/// The limits and cuts a random walk never reaches: the command history and the issued list of one run, the schedules of a
/// run, the resolved list, the auto-reconcile ids of long and odd incarnations and recoveries, and long Member errors.
fn prelude() -> VecDeque<Json> {
	let (a, b, c, d) = (MEMBERS[0].0, MEMBERS[1].0, MEMBERS[2].0, MEMBERS[0].0);
	let cmd = |op: &str, id: String, args: Json, plan: Vec<Json>| obj! { "op" => op, "id" => id, "args" => args, "plan" => Json::Array(plan) };
	let start = |id: &str, run: &str, m: &str| cmd("startRun", id.into(), obj! { "runId" => run, "kind" => "jobs", "config" => Json::Null, "members" => vec![Json::from(m)] }, vec![]);
	let mut l = VecDeque::new();
	l.push_back(start("p-start", "cap", a));
	for n in 0..260 {
		l.push_back(cmd(if n % 2 == 0 { "pauseRun" } else { "resumeRun" }, format!("p{n}"), obj! { "runId" => "cap" }, vec![]));
	}
	for n in 0..17 {
		l.push_back(cmd("scheduleRun", format!("q{n}"), obj! { "runId" => "cap", "kind" => "pause", "at" => 1e12 + f64::from(17 - n) }, vec![]));
	}
	l.push_back(start("res-start", "res", b));
	l.push_back(cmd("pauseRun", "res-pause".into(), obj! { "runId" => "res" }, vec![]));
	for n in 0..34 {
		l.push_back(cmd("reconcileRun", format!("res-rec{n}"), obj! { "runId" => "res", "recoveryId" => format!("rec-p{n}") }, vec![]));
	}
	// a transition that waits, then control identities whose recovery ids are cut and replaced
	l.push_back(cmd("resumeRun", "res-resume".into(), obj! { "runId" => "res" }, vec!["throw".into()]));
	for i in [Json::from("x".repeat(100)), Json::from("control-\u{1F600}-\u{e9}-ok"), Json::Null, Json::from("control-1")] {
		l.push_back(obj! { "identity" => obj! { "authorityId" => "authority", "incarnation" => i } });
		l.push_back(obj! { "op" => "advance", "runId" => "res", "plan" => Vec::<Json>::new() });
	}
	l.push_back(obj! { "identity" => false });
	l.push_back(start("fen-start", "fen", c));
	l.push_back(cmd("pauseRun", "fen-pause".into(), obj! { "runId" => "fen" }, vec![obj! { "underRecovery" => "r".repeat(95) }]));
	l.push_back(start("long-start", "long", d));
	let long = format!("{}{}tail", "x".repeat(250), "\u{1F600}".repeat(3));
	l.push_back(cmd("pauseRun", "long-pause".into(), obj! { "runId" => "long" }, vec![obj! { "throw" => long.as_str() }]));
	l.push_back(obj! { "op" => "advance", "runId" => "long", "plan" => vec![obj! { "throw" => format!("{}\u{1F600}", "y".repeat(254)) }] });
	l.push_back(obj! { "identity" => default_identity() });
	l.push_back(obj! { "op" => "listRuns", "id" => "list", "args" => obj! { "limit" => "Infinity" }, "plan" => Vec::<Json>::new() });
	l
}
/// The view hashes an answer shows, by run.
fn learn(v: &Json, hashes: &mut HashMap<String, String>) {
	let views: Vec<&Json> = match v {
		Json::Array(a) => a.iter().collect(),
		other => vec![other],
	};
	for v in views {
		if let (Some(run), Some(h)) = (text(v, "runId"), v.get("recovery").and_then(|q| text(q, "viewHash"))) {
			hashes.insert(run.to_owned(), h.to_owned());
		}
	}
}

#[test]
fn a_walk_of_runs_leaves_the_same_journal() {
	let steps: u64 = std::env::var("PHI_RUN_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(300) + prelude().len() as u64;
	let seed: u64 = std::env::var("PHI_RUN_SEED").ok().and_then(|n| n.parse().ok()).unwrap_or(0x5eed_0fa1_2a1d);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/run-controller-driver.ts");
	let world = Rc::new(World { docs: RefCell::default(), plan: RefCell::default(), sent: RefCell::default(), identity: RefCell::new(Some(default_identity())), clock: Cell::new(0.0), members: RefCell::default() });
	world.reset();
	let m = RunController::new(Env(Rc::clone(&world)));
	let (mut r, mut cmd, mut now) = (Rng(seed | 1), 0u64, 0.0);
	let mut hashes: HashMap<String, String> = HashMap::new();
	let mut earlier: Vec<Json> = vec![];
	let mut seen: HashMap<String, usize> = HashMap::new();
	let mut scheduled: std::collections::HashSet<String> = Default::default();
	let mut queued: VecDeque<Json> = prelude();
	for n in 0..steps {
		if n % 80 == 0 && queued.is_empty() && n > 0 {
			ts.step(&obj! { "reset" => true });
			world.reset();
			hashes.clear();
			earlier.clear();
		}
		// now and then the clock moves, the control identity changes, or an earlier command comes again (same or other arguments)
		let l = if let Some(next) = queued.pop_front() { next } else { match r.below(100) {
			0..=5 => {
				now += 1.0 + r.below(3) as f64;
				obj! { "now" => now }
			}
			10..=11 => obj! { "identity" => if r.below(6) == 0 { Json::Bool(false) } else if r.below(3) == 0 { obj! { "authorityId" => "authority", "incarnation" => r.pick(&["control-2", "control 3", "control-\u{e9}"]) } } else { default_identity() } },
			12..=18 if !earlier.is_empty() => {
				let mut again = r.pick(&earlier);
				if r.below(3) == 0 {
					let other = line(&mut r, &mut cmd, now, &hashes);
					if let Some(id) = text(&again, "id").map(str::to_owned) {
						again = other;
						again.as_object_mut().unwrap().insert("id", id.into());
					}
				}
				again.as_object_mut().unwrap().insert("plan", plan(&mut r));
				again
			}
			_ => line(&mut r, &mut cmd, now, &hashes),
		} };
		if let Some(c) = l.get("now").and_then(Json::as_f64) {
			now = now.max(c);
		}
		let t = ts.step(&l);
		let context = format!("step {n}: {}", l.to_json_text());
		if let Some(c) = l.get("now").and_then(Json::as_f64) {
			world.clock.set(c);
		}
		if let Some(i) = l.get("identity") {
			*world.identity.borrow_mut() = (i != &Json::Bool(false)).then(|| i.clone());
		}
		let Some(op) = text(&l, "op") else {
			assert_eq!(t.to_json_text(), "{}", "{context}");
			continue;
		};
		if l.get("id").is_some() && earlier.len() < 64 {
			let mut kept = l.clone();
			kept.as_object_mut().unwrap().remove("plan");
			earlier.push(kept);
		}
		*world.plan.borrow_mut() = l.get("plan").and_then(Json::as_array).map_or(VecDeque::new(), |p| p.iter().cloned().collect());
		world.sent.borrow_mut().clear();
		let empty = obj! {};
		let got = match op {
			"advance" => runtime.block_on(m.advance(text(&l, "runId").unwrap_or(""))),
			"pending" => m.pending(),
			_ => runtime.block_on(m.run_command(op, text(&l, "id").unwrap_or(""), l.get("args").unwrap_or(&empty))),
		};
		match (&got, t.get("ok") == Some(&Json::Bool(true))) {
			(Ok(v), true) => {
				assert_eq!(v.to_json_text(), t.get("result").unwrap().to_json_text(), "answer, {context}");
				learn(v, &mut hashes);
				for x in v.get("schedules").and_then(Json::as_array).map_or(&[][..], Vec::as_slice) {
					scheduled.insert(text(x, "id").unwrap_or("").to_owned());
				}
				// a schedule's time comes now and then, and the server loop advances the run
				if let Some(at) = v.get("schedules").and_then(Json::as_array).and_then(|s| s.last()).and_then(|x| x.get("at")).and_then(Json::as_f64).filter(|_| r.below(2) == 0) {
					now = now.max(at);
					queued.extend([obj! { "now" => now }, obj! { "op" => "advance", "runId" => text(v, "runId").unwrap_or(""), "plan" => Json::Array(vec![]) }]);
				}
				let key = match (text(v, "state"), text(v, "phase"), text(v, "error")) {
					(Some(s), _, _) => format!("state {s}"),
					(_, Some("failed"), Some(e)) => format!("failed {}", e.split(' ').take(3).collect::<Vec<_>>().join(" ")),
					_ => format!("op {op}"),
				};
				*seen.entry(key).or_default() += 1;
			}
			(Err(e), false) => {
				assert_eq!(format!("{}: {}", e.class, e.message), format!("{}: {}", text(&t, "error").unwrap(), text(&t, "message").unwrap()), "refusal, {context}");
				*seen.entry(format!("thrown {}", e.class)).or_default() += 1;
			}
			_ => panic!("{got:?} against {} ON {context}", t.get("result").or(t.get("message")).map_or("an answer".to_owned(), Json::to_json_text)),
		}
		assert_eq!(Json::Array(world.sent.borrow().clone()).to_json_text(), t.get("sent").unwrap().to_json_text(), "Member calls, {context}");
		let journal = world.docs.borrow().get(&(JOURNAL.to_owned(), String::new())).cloned().unwrap_or(Json::Null);
		if l.get("id").and_then(Json::as_str) == Some("list") {
			// the end of the prelude: its caps were reached
			let run = |id: &str, k: &str| journal.get("runs").and_then(|r| r.get(id)).and_then(|r| r.get(k)).cloned().unwrap_or(Json::Null);
			let len = |v: Json| v.as_array().map_or(0, Vec::len) + v.as_object().map_or(0, phi_json::Object::len);
			assert_eq!((len(run("cap", "issued")), len(run("cap", "commands")), len(run("cap", "schedules")), len(run("res", "resolved"))), (128, 256, 16, 32), "the prelude's caps");
		}
		assert_eq!(journal.to_json_text(), t.get("journal").unwrap().to_json_text(), "journal, {context}");
		if let Some(runs) = journal.get("runs").and_then(Json::as_object) {
			for (_, run) in runs.iter() {
				for (id, c) in run.get("commands").and_then(Json::as_object).map(|c| c.iter().collect::<Vec<_>>()).unwrap_or_default() {
					if let Some(rest) = id.strip_prefix("auto-") {
						*seen.entry(format!("auto {}", rest.split('-').next().unwrap_or(""))).or_default() += 1;
						*seen.entry(format!("auto {rest}")).or_default() += 1;
					}
					if scheduled.contains(id) && matches!(text(c, "kind"), Some("pause" | "resume")) && op == "advance" {
						*seen.entry("schedule issued".into()).or_default() += 1;
					}
				}
			}
		}
	}
	// the default length reaches the common paths; a schedule that comes due on an idle run takes a longer walk
	let wanted: &[&str] = if steps >= 2000 { &["state running", "state paused", "state stopped", "state needsReview", "state reconciling", "state pauseIncomplete", "failed run", "auto control", "auto rec", "schedule issued"] } else if steps >= 300 { &["state running", "state stopped", "state needsReview", "failed run"] } else { &[] };
	{
		for wanted in wanted.iter().chain(&["failed run command", "failed at most 16", "auto control-x", "auto rrrr"]) {
			assert!(seen.keys().any(|k| k.starts_with(wanted)), "never reached {wanted}: {seen:?}");
		}
	}
	eprintln!("{seen:?}");
}
