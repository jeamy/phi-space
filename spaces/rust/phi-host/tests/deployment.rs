// R6a: the control side of workers, Space commands and deployment against TypeScript (test/support/deployment-driver.ts). Worker
// specs at the edges of their checks, signed host lists, Space commands a scripted host answers or refuses, alias bindings, plans and
// applies of random configs (every validation error, the secret scan), fresh and stale hosts, worker starts and exports. Every answer
// and both journals must be the same text. `PHI_DEPLOYMENT_STEPS` sets the length, `PHI_DEPLOYMENT_SEED` the seed.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::{error, CoreError};
use phi_host::auth::{seal, Algorithm, Signer};
use phi_host::deployment::{capability_host_status, deployment_commands, DeploymentController, DeploymentPorts, DEPLOYMENT_COMMANDS};
use phi_host::router::RouterEnv;
use phi_host::run_member::Pin;
use phi_host::space_commands::{SpaceCommandPorts, SpaceCommands, SPACE_COMMANDS};
use phi_host::workers::{applied_workers, worker_commands, WorkerAssignments};
use phi_json::{obj, text, Json, Object};
use phi_service::{Options, Service};
use phi_store::{system_random, MemoryLedger, Store};
use phi_wire::Local;
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet, VecDeque};
use std::rc::Rc;

const SPACE: &str = "sp-00000000-0000-4000-8000-000000000001";
type R<T> = Result<T, CoreError>;

struct World {
	docs: RefCell<HashMap<(String, String), Json>>,
	service: RefCell<Service>,
	control: RefCell<String>,
	now: Cell<f64>,
	incarnation: RefCell<Option<String>>,
	plan: RefCell<VecDeque<Json>>,
	status: RefCell<Json>,
	sent: RefCell<Vec<Json>>,
	member: Signer,
	other: Signer,
}
fn fresh_service() -> (Service, String) {
	let store = Store::open(phi_store::Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
	let mut service = Service::new(store, Options::single_peer("p"));
	let space = service.create_space_with("control", system_random(), |_, _| Ok(())).unwrap().get("spaceId").and_then(Json::as_str).unwrap().to_owned();
	(service, space)
}
impl World {
	fn on_control<T>(&self, f: impl FnOnce(&mut phi_core::space::Space, f64) -> R<T>) -> R<T> {
		let id = self.control.borrow().clone();
		let now = self.now.get();
		self.service.borrow_mut().commit_on(Some(&id), |s, _| f(s, now))
	}
}

#[derive(Clone)]
struct Env(Rc<World>);
impl RouterEnv for Env {
	fn read(&self, kind: &str, key: &str) -> R<Option<Json>> { Ok(self.0.docs.borrow().get(&(kind.to_owned(), key.to_owned())).cloned()) }
	fn commit(&self, writes: Vec<(String, String, Json)>) -> R<()> {
		for (kind, key, value) in writes {
			self.0.docs.borrow_mut().insert((kind, key), value);
		}
		Ok(())
	}
	fn assert_authority(&self) -> Local<R<()>> { Box::pin(async { Ok(()) }) }
	fn invoke(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn resolve(&self, _: Json) -> Local<Result<Json, ()>> { Box::pin(async { Err(()) }) }
	fn now(&self) -> f64 { self.0.now.get() }
}

/// The scripted host: the driver's `send`, field for field.
struct Wire(Rc<World>);
impl SpaceCommandPorts for Wire {
	fn send(&self, host_id: &str, signed: Json) -> Local<R<Json>> {
		let w = &self.0;
		w.sent.borrow_mut().push(Json::Array(vec![host_id.into(), signed.clone()]));
		let next = w.plan.borrow_mut().pop_front().unwrap_or_else(|| obj! {});
		let answer = if next.as_str() == Some("throw") {
			Err(error("Error", "the line broke"))
		} else if let Some(m) = text(&next, "refuse") {
			Err(error("Error", m))
		} else {
			let q = signed.get("value").unwrap();
			let action = text(q, "action").unwrap();
			let mut r = Object::new();
			r.insert("commandId", if next.get("wrongId").is_some() { "other".into() } else { q.get("commandId").cloned().unwrap() });
			r.insert("action", if next.get("wrongAction").is_some() { "archive".into() } else { action.into() });
			if next.get("noSpaceId").is_none() {
				let id = next.get("spaceId").cloned().unwrap_or_else(|| if action == "create" { format!("sp-{host_id}-{}", text(q, "alias").unwrap()).into() } else { q.get("spaceId").cloned().unwrap() });
				r.insert("spaceId", id);
			}
			r.insert("alias", q.get("alias").cloned().unwrap_or_else(|| format!("al-{}", text(q, "spaceId").unwrap()).into()));
			r.insert("state", match action { "archive" => "archived", "delete" => "deleted", _ => "active" }.into());
			if next.get("existed").is_some() {
				r.insert("existed", true.into());
			}
			let key = if next.get("badKey").is_some() { &w.other } else { &w.member };
			Ok(seal("value", Json::Object(r), "space-lifecycle-result", text(&next, "issuer").unwrap_or("member-peer"), key).unwrap())
		};
		Box::pin(async move { answer })
	}
	fn host_pin(&self, _: &str) -> Local<R<Pin>> {
		let pin = Pin { issuer: "member-peer".into(), algorithm: Algorithm::Ed25519, public_key: self.0.member.public_key() };
		Box::pin(async move { Ok(pin) })
	}
}

struct Ports(Rc<World>, Rc<SpaceCommands<Wire>>);
impl DeploymentPorts for Ports {
	fn host_status(&self, host_id: &str) -> Local<R<Json>> {
		let w = &self.0;
		let s = w.status.borrow().get(host_id).and_then(Json::as_str).map(str::to_owned);
		let now = w.now.get();
		let answer = match s.as_deref() {
			Some("throw") => Err(error("Error", "status unavailable")),
			Some(s @ ("fresh" | "stale")) => Ok(obj! { "fresh" => s == "fresh", "at" => now - 5.0 }),
			_ => w.on_control(|c, now| capability_host_status(c, now, host_id)),
		};
		Box::pin(async move { answer })
	}
	fn create_space(&self, command_id: &str, args: Json) -> Local<R<Json>> {
		let (spaces, id) = (Rc::clone(&self.1), command_id.to_owned());
		Box::pin(async move { spaces.run("create", &id, &args).await })
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
	fn chance(&mut self, n: u64) -> bool { self.below(n) == 0 }
}
fn put(v: &mut Json, k: &str, x: impl Into<Json>) {
	if let Some(o) = v.as_object_mut() {
		o.insert(k, x.into());
	}
}

const HOST_IDS: [&str; 6] = ["H1", "H2", "H3", "10", "2", "H9"];
const HOST_ALIASES: [&str; 5] = ["h1", "h2", "h3", "2", "x.y"];
const SPACE_ALIASES: [&str; 5] = ["d1", "d2", "d3", "5", "d-x"];
const DEPLOYMENTS: [&str; 4] = ["dep", "d-2", "7", "prod"];
const REFUSALS: [&str; 12] = [
	"cannot archive: it has open transactions",
	"cannot delete: archive the Space first",
	"IllegalArgumentError: no",
	"invalid Space lifecycle request",
	"no Space sp-1 on this host",
	"Space d1 exists with other limits or profiles; it is reused only unchanged",
	"alias d1 names an archived Space; reactivate it instead",
	"the default and the control Space have no lifecycle",
	"Space lifecycle instruction belongs to another authority or host",
	"command ID was used for another lifecycle request",
	"the boot permission refuses it",
	"connection reset",
];

fn id_edge(r: &mut Rng) -> Json {
	match r.below(14) {
		0 => "A".repeat(96).into(),
		1 => "A".repeat(97).into(),
		2 => "-a".into(),
		3 => "a_b".into(),
		4 => "".into(),
		5 => 5.0.into(),
		6 => Json::Null,
		7 => "9".into(),
		8 => "a:b.c-d".into(),
		_ => r.pick(&["w1", "w2", "w3", "1", "10"]).into(),
	}
}
fn count(r: &mut Rng) -> Option<Json> {
	Some(match r.below(16) {
		0 => 0.0.into(),
		1 => 64.0.into(),
		2 => 65.0.into(),
		3 => "x".into(),
		4 => (-1.0).into(),
		5 => "5".into(),
		6 => 2.5.into(),
		7 => Json::Null,
		8 => return None,
		9 => true.into(),
		10 => "0x10".into(),
		11 => " 7 ".into(),
		_ => (r.below(5) as f64).into(),
	})
}
fn worker_args(r: &mut Rng) -> Json {
	let mut a = obj! {};
	let assignment = if r.chance(4) { id_edge(r) } else { r.pick(&["w1", "w2", "w3", "1", "10", "a.b"]).into() };
	put(&mut a, "assignmentId", assignment);
	put(&mut a, "hostId", if r.chance(10) { id_edge(r) } else { r.pick(&HOST_IDS).into() });
	put(&mut a, "kind", if r.chance(10) { "bad kind" } else { r.pick(&["k", "k2"]) });
	put(&mut a, "targetSpace", if r.chance(12) { "" } else { r.pick(&["s1", "s2", "sp-H1-d1"]) });
	if let Some(c) = count(r) {
		put(&mut a, "count", c);
	}
	match r.below(6) {
		0 => put(&mut a, "runId", "r1"),
		1 => put(&mut a, "runId", Json::Null),
		2 => put(&mut a, "runId", 5.0),
		3 => put(&mut a, "runId", "bad id"),
		_ => {}
	}
	a
}
fn send_plan(r: &mut Rng) -> Json {
	match r.below(22) {
		0 => "throw".into(),
		1..=5 => obj! { "refuse" => r.pick(&REFUSALS) },
		6 => obj! { "refuse" => format!("invalid {}", "ü".repeat(600)) },
		7 => obj! { "existed" => true },
		8 => obj! { "noSpaceId" => true },
		9 => obj! { "wrongId" => true },
		10 => obj! { "wrongAction" => true },
		11 => obj! { "badKey" => true },
		12 => obj! { "issuer" => "someone" },
		13 => obj! { "spaceId" => "sp-other" },
		14 => obj! { "spaceId" => "bad id!" },
		_ => obj! {},
	}
}

/// A valid config, or one with mutations that each hit a validation error.
fn config(r: &mut Rng) -> Json {
	let n_hosts = 1 + r.below(3) as usize;
	let mut aliases: Vec<&str> = HOST_ALIASES.to_vec();
	let mut hosts = vec![];
	for i in 0..n_hosts {
		let a = aliases.remove(r.below(aliases.len() as u64) as usize);
		let mut h = obj! { "alias" => a, "role" => if i == 0 { "coordinator" } else { "member-host" } };
		if r.chance(4) {
			put(&mut h, "ssh", format!("root@{a}"));
		}
		hosts.push(h);
	}
	let host_of = |r: &mut Rng, hosts: &[Json]| text(&hosts[r.below(hosts.len() as u64) as usize], "alias").unwrap().to_owned();
	let coordinator = text(&hosts[0], "alias").unwrap().to_owned();
	let mut spaces = vec![obj! { "alias" => "ctl", "host" => coordinator.as_str(), "purpose" => "control" }];
	let mut names: Vec<&str> = SPACE_ALIASES.to_vec();
	for _ in 0..1 + r.below(3) {
		let a = names.remove(r.below(names.len() as u64) as usize);
		let mut s = obj! { "alias" => a, "host" => host_of(r, &hosts), "purpose" => "data" };
		match r.below(6) {
			0 => put(&mut s, "maxSpaceBytes", 4096.0),
			1 => put(&mut s, "limits", obj! { "maxEntries" => 100.0 }),
			2 => {
				put(&mut s, "limits", obj! { "maxSpaceBytes" => 9999.0, "maxEntries" => 7.0 });
				put(&mut s, "maxSpaceBytes", 2048.0);
			}
			3 => put(&mut s, "profiles", vec![obj! { "name" => "p" }]),
			4 => put(&mut s, "limits", Json::Null),
			_ => {}
		}
		spaces.push(s);
	}
	let data: Vec<Json> = spaces[1..].to_vec();
	let mut workers = vec![];
	for i in 0..r.below(4) {
		let t = &data[r.below(data.len() as u64) as usize];
		let mut w = obj! { "alias" => ["w1", "w2", "3"][i as usize % 3], "host" => t.get("host").cloned().unwrap(), "kind" => r.pick(&["k", "k2"]), "targetSpace" => t.get("alias").cloned().unwrap(), "count" => r.pick(&[0.0, 1.0, 3.0, 64.0]) };
		match r.below(5) {
			0 => put(&mut w, "runId", "r1"),
			1 => put(&mut w, "runId", Json::Null),
			_ => {}
		}
		workers.push(w);
	}
	let workers: Vec<Json> = { let mut seen = HashSet::new(); workers.into_iter().filter(|w| seen.insert(text(w, "alias").unwrap().to_owned())).collect() };
	let mut c = obj! { "schemaVersion" => 1.0, "deployment" => r.pick(&DEPLOYMENTS), "coordinator" => coordinator.as_str(), "hosts" => hosts, "spaces" => spaces };
	if r.chance(3) {
		put(&mut c, "configRevision", (1 + r.below(3)) as f64);
	}
	if !workers.is_empty() || r.chance(3) {
		put(&mut c, "workers", workers);
	}
	match r.below(5) {
		0 => put(&mut c, "routing", obj! { "profile" => "single-member-sieve", "member" => data[0].get("alias").cloned().unwrap() }),
		1 if data.len() >= 2 => put(&mut c, "routing", obj! { "profile" => "sieve-hrw-by-taskid", "members" => data.iter().map(|d| d.get("alias").cloned().unwrap()).collect::<Vec<_>>() }),
		_ => {}
	}
	if r.chance(4) {
		put(&mut c, "mobile", obj! { "access" => "native-overlay", "enrollmentRole" => "admin" });
	}
	if r.chance(4) {
		put(&mut c, "credentials", obj! { "source" => "host-secret-store" });
	}
	if r.chance(5) {
		return c;
	}
	for _ in 0..r.below(4) {
		mutate(r, &mut c);
	}
	c
}
fn at<'a>(c: &'a mut Json, k: &str) -> &'a mut Vec<Json> {
	let o = c.as_object_mut().unwrap();
	if !matches!(o.get(k), Some(Json::Array(_))) {
		o.insert(k, Json::Array(vec![]));
	}
	o.get_mut(k).unwrap().as_array_mut().unwrap()
}
fn mutate(r: &mut Rng, c: &mut Json) {
	let token = |r: &mut Rng| format!("{}{}{}", r.pick(&["sk", "pk", "ghp", "xoxb", "xoxp", "xoxa"]), r.pick(&["-", "_"]), "Ab3".repeat(r.pick(&[5usize, 6])));
	match r.below(52) {
		0 => put(c, "mobile", obj! { "note" => "-----BEGIN RSA PRIVATE KEY-----\nMII" }),
		1 => put(c, "mobile", obj! { "note" => "x -----BEGIN PRIVATE KEY----- y" }),
		2 => {
			let t = token(r);
			if let Some(h) = at(c, "hosts").first_mut() {
				put(h, "ssh", t);
			}
		}
		3 => {
			let k = r.pick(&["token", "Secret", "password", "passwd", "privateKey", "apiKey", "api_key", "Bearer", "seed", "mnemonic", "SEEDS"]);
			put(c, "mobile", obj! { "access" => "native-overlay", "nested" => obj! { k => "x" } });
		}
		4 => put(c, "token", "x"),
		5 => { put(c, "unknown", 1.0); }
		6 => put(c, "schemaVersion", r.pick(&[Json::from(2.0), Json::from("1")])),
		7 => put(c, "deployment", r.pick(&[Json::from("Bad"), Json::Null, Json::from(""), Json::from("a".repeat(65))])),
		8 => put(c, "configRevision", r.pick(&[Json::from(0.0), Json::from(1.5), Json::from("2")])),
		9 => put(c, "hosts", obj! {}),
		10 => put(c, "spaces", "x"),
		11 => put(c, "workers", obj! {}),
		12 => {
			let hosts = at(c, "hosts");
			for i in 0..65 {
				hosts.push(obj! { "alias" => format!("m{i}"), "role" => "member-host" });
			}
		}
		13 => at(c, "hosts").push(obj! { "alias" => r.pick(&["Bad", "", "a b"]), "role" => "member-host" }),
		14 => at(c, "spaces").push(obj! { "alias" => 5.0, "host" => "h1", "purpose" => "data" }),
		15 => at(c, "workers").push(obj! { "kind" => "k" }),
		16 => {
			let h = at(c, "hosts").first().cloned();
			if let Some(h) = h {
				at(c, "hosts").push(h);
			}
		}
		17 => {
			let s = at(c, "spaces").last().cloned();
			if let Some(s) = s {
				at(c, "spaces").push(s);
			}
		}
		18 => at(c, "hosts").push(obj! { "alias" => "q1", "role" => "boss" }),
		19 => put(c, "coordinator", r.pick(&[Json::from("nobody"), Json::Null])),
		20 => at(c, "hosts").push(obj! { "alias" => "q2", "role" => "coordinator" }),
		21 => {
			if let Some(h) = at(c, "hosts").get_mut(1) {
				let a = h.get("alias").cloned().unwrap();
				put(c, "coordinator", a);
			}
		}
		22 => at(c, "spaces").push(obj! { "alias" => "q3", "host" => "nowhere", "purpose" => "data" }),
		23 => at(c, "spaces").push(obj! { "alias" => "q4", "host" => "h1", "purpose" => "archive" }),
		24 => at(c, "spaces").push(obj! { "alias" => "q5", "host" => "nowhere", "purpose" => "control" }),
		25 => at(c, "spaces").push(obj! { "alias" => "q6", "host" => "h1", "purpose" => "data", "maxSpaceBytes" => r.pick(&[Json::from(1000.0), Json::from("4096"), Json::from(1024.5)]) }),
		26 => at(c, "spaces").push(obj! { "alias" => "q7", "host" => "h1", "purpose" => "data", "limits" => r.pick(&[Json::Array(vec![]), Json::from("x"), Json::from(3.0)]) }),
		27 => at(c, "spaces").retain(|s| text(s, "purpose") != Some("control")),
		28 => put(c, "routing", obj! { "profile" => "single-member-sieve", "member" => r.pick(&[Json::from("ctl"), Json::from("nope"), Json::Null]) }),
		29 => put(c, "routing", obj! { "profile" => "sieve-hrw-by-taskid", "members" => r.pick(&[Json::Array(vec!["d1".into()]), Json::from("d1"), Json::Array(vec!["ctl".into(), "d1".into()])]) }),
		30 => put(c, "routing", obj! { "profile" => r.pick(&["other", ""]) }),
		31 => put(c, "routing", Json::Null),
		32 => at(c, "workers").push(obj! { "alias" => "q8", "host" => "nowhere", "kind" => "k", "targetSpace" => "ctl", "count" => 1.0 }),
		33 => {
			let t = at(c, "spaces").last().cloned().unwrap_or(Json::Null);
			let other = at(c, "hosts").iter().filter_map(|h| text(h, "alias")).find(|a| Some(*a) != text(&t, "host")).map(str::to_owned);
			if let (Some(a), Some(o)) = (text(&t, "alias"), other) {
				let a = a.to_owned();
				at(c, "workers").push(obj! { "alias" => "q9", "host" => o, "kind" => "k", "targetSpace" => a, "count" => 1.0 });
			}
		}
		34 => at(c, "workers").push(obj! { "alias" => "q10", "host" => "h1", "kind" => r.pick(&[Json::from("bad kind"), Json::from(5.0)]), "targetSpace" => "d1", "count" => r.pick(&[Json::from(65.0), Json::from(-1.0), Json::from("3"), Json::from(1.0)]) }),
		35 => at(c, "workers").push(obj! { "alias" => "q11", "host" => "h1", "kind" => "k", "targetSpace" => "d1", "count" => 1.0, "runId" => r.pick(&[Json::from("bad id"), Json::from(""), Json::from(7.0), Json::Array(vec!["r".into()])]) }),
		36 => put(c, "credentials", obj! { "source" => "env" }),
		37 => put(c, "credentials", Json::Null),
		38 => at(c, "hosts").insert(0, Json::Null),
		39 => at(c, "hosts").push(Json::Null),
		40 => at(c, "spaces").push(Json::Null),
		41 => at(c, "workers").push(Json::Null),
		42 => at(c, "spaces").push(5.0.into()),
		43 => at(c, "workers").push(obj! { "alias" => "q12", "host" => "h1", "kind" => "k", "count" => 1.0 }),
		44 => at(c, "hosts").push(Json::from("h9")),
		45 => put(c, "mobile", obj! { "access" => token(r) }),
		46 => put(c, "mobile", obj! { "access" => "sk-short123" }),
		47 => put(c, "credentials", 5.0),
		48 => put(c, "routing", 5.0),
		49 => at(c, "hosts").push(obj! { "alias" => 7.0, "role" => "member-host" }),
		_ => {
			let s = at(c, "spaces").iter().find(|s| text(s, "purpose") == Some("data")).and_then(|s| text(s, "alias")).map(str::to_owned);
			if let Some(s) = s {
				at(c, "workers").push(obj! { "alias" => "q13", "host" => "h1", "kind" => "k", "targetSpace" => s, "count" => 0.0 });
			}
		}
	}
}
fn raw_config(r: &mut Rng, recent: &mut Vec<Json>) -> Option<Json> {
	match r.below(30) {
		0 => return None,
		1 => return Some(r.pick(&[Json::Array(vec![]), Json::from("x"), Json::Null, Json::from(5.0)])),
		_ => {}
	}
	if !recent.is_empty() && r.chance(3) {
		return Some(r.pick(recent));
	}
	let c = config(r);
	recent.push(c.clone());
	if recent.len() > 6 {
		recent.remove(0);
	}
	Some(c)
}
fn capability(r: &mut Rng, now: f64) -> Json {
	let mut f = obj! { "hostId" => r.pick(&HOST_IDS) };
	match r.below(6) {
		0 => {}
		1 => put(&mut f, "at", "123"),
		_ => put(&mut f, "at", now - (r.below(4) as f64) * 50_000.0 - r.below(100) as f64),
	}
	let workers = match r.below(6) {
		0 => None,
		1 => Some(Json::Array(vec![])),
		2 => Some("str".into()),
		_ => Some(obj! { "generation" => r.below(5) as f64, "assignments" => obj! {} }),
	};
	if let Some(w) = workers {
		put(&mut f, "metrics", obj! { "workers" => w });
	}
	Json::Array(vec!["Capability".into(), f, ((1 + r.below(4)) as f64 * 100_000.0).into()])
}

const NEEDLES: [&str; 76] = [
	"no worker assignment directory configured", "reading 'set'",
	"looks like a secret", "secret fields are not allowed", "config must be a JSON object", "unknown field", "schemaVersion must be 1",
	"deployment: lower-case alias required", "configRevision must be a positive integer", "hosts must be a list", "spaces must be a list",
	"workers must be a list", "at most 64 hosts", "hosts: invalid alias", "spaces: invalid alias", "workers: invalid alias", "duplicate alias",
	"role must be coordinator", "coordinator must name a host", "exactly the coordinator host", ": unknown host", "purpose must be",
	"the control Space lives on the coordinator", "maxSpaceBytes must be", "limits must be an object", "exactly one control Space",
	"routing.member must", "routing.members must", "routing.profile must", "targetSpace must name a data Space", "workers run on the host",
	"invalid kind", "count must be 0..64", "invalid runId", "credentials.source must", "reading 'alias'", "reading 'role'", "reading 'profile'",
	"reading 'source'",
	"\"status\":\"ok\"", "\"status\":\"blocked\"", "\"status\":\"conflict\"", "\"status\":\"reuse\"", "\"status\":\"create\"", "\"status\":\"skip\"",
	"cannot archive", "cannot delete", "IllegalArgumentError: no", "no Space sp-1", "exists with other", "names an archived", "have no lifecycle",
	"another authority", "was used for another lifecycle", "boot permission", "connection reset", "the line broke",
	"invalid Space lifecycle result signature", "does not match the command", "\"existed\":true", "no spaceId",
	"an assignment keeps its host", "worker assignment directory is full", "command ID was used for another worker assignment",
	"a worker assignment needs IDs", "already has another alias", "is bound to H", "Space alias", "still applying another config",
	"is not completed", "invalid command ID", "bindHost needs", "\"state\":\"completed\"", "\"status\":\"skipped\"", "\"fresh\":true", "\"fresh\":false",
];

#[test]
fn workers_space_commands_and_deployments_are_the_same() {
	let steps: u64 = std::env::var("PHI_DEPLOYMENT_STEPS").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let seed: u64 = std::env::var("PHI_DEPLOYMENT_SEED").ok().and_then(|n| n.parse().ok()).unwrap_or(0xde91_0e7e_5eed_1234);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/deployment-driver.ts");
	let (service, control) = fresh_service();
	let world = Rc::new(World {
		docs: RefCell::default(), service: RefCell::new(service), control: RefCell::new(control), now: Cell::new(1_000_000.0), incarnation: RefCell::new(None),
		plan: RefCell::default(), status: RefCell::new(obj! {}), sent: RefCell::default(),
		member: Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[6; 32])), other: Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[7; 32])),
	});
	let control_key = Rc::new(Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[5; 32])));
	let w2 = Rc::clone(&world);
	let identity: phi_host::workers::Identity = Box::new(move || {
		let i = w2.incarnation.borrow().clone();
		Box::pin(async move { Ok(i) })
	});
	let workers = Rc::new(WorkerAssignments::new(Env(Rc::clone(&world)), "a", "control-peer", Rc::clone(&control_key), Some(identity)));
	let spaces = Rc::new(SpaceCommands::new(Wire(Rc::clone(&world)), "a", "control-peer", Rc::clone(&control_key)));
	let deployment = DeploymentController::new(Env(Rc::clone(&world)), Ports(Rc::clone(&world), Rc::clone(&spaces)), Some(Rc::clone(&workers)), SPACE);
	let bare = DeploymentController::new(Env(Rc::clone(&world)), Ports(Rc::clone(&world), Rc::clone(&spaces)), None, SPACE);
	let mut r = Rng(seed);
	let mut recent: Vec<Json> = vec![];
	let mut script: VecDeque<Json> = VecDeque::new();
	let mut last_set: Option<Json> = None;
	let mut seen: HashSet<&str> = HashSet::new();
	let (mut cmd, mut now) = (0u64, 1_000_000.0);
	for n in 0..steps {
		if n % 150 == 0 {
			ts.step(&obj! { "reset" => true });
			world.docs.borrow_mut().clear();
			let (service, control) = fresh_service();
			*world.service.borrow_mut() = service;
			*world.control.borrow_mut() = control;
			recent.clear();
			last_set = None;
			script.clear();
			let binds = [("h1", "H1"), ("h2", "H2"), ("h3", "H3"), ("2", "10")];
			for (a, h) in binds.iter().take(1 + r.below(4) as usize) {
				script.push_back(obj! { "op" => "bindHostAlias", "args" => obj! { "alias" => *a, "hostId" => *h } });
			}
			if r.chance(3) {
				// a host's directory full: 32 assignments, then a 33rd; and an assignment that moves its host
				for i in 0..33 {
					script.push_back(obj! { "op" => "setWorkers", "args" => obj! { "assignmentId" => format!("f{i}"), "hostId" => "H9", "kind" => "k", "targetSpace" => "s1", "count" => 1.0 } });
				}
				script.push_back(obj! { "op" => "setWorkers", "args" => obj! { "assignmentId" => "f0", "hostId" => "H1", "kind" => "k", "targetSpace" => "s1", "count" => 1.0 } });
			}
		}
		now += r.below(3) as f64 * 20_000.0;
		cmd += 1;
		let scripted = !script.is_empty();
		let mut l = match script.pop_front() {
			Some(l) => l,
			None => match r.below(27) {
				0..=2 => {
					let again = last_set.clone().filter(|_| r.chance(3));
					let mut l = again.unwrap_or_else(|| obj! { "op" => "setWorkers", "args" => worker_args(&mut r) });
					if r.chance(2) {
						put(&mut l, "args", worker_args(&mut r));
					}
					l
				}
				3 => obj! { "op" => "listWorkers", "args" => obj! {} },
				4 => obj! { "op" => "forHost", "args" => obj! { "hostId" => r.pick(&HOST_IDS) } },
				5 | 6 | 24..=26 => {
					let kind = r.pick(&SPACE_COMMANDS);
					let mut a = obj! { "hostId" => r.pick(&HOST_IDS) };
					if r.chance(2) {
						put(&mut a, "alias", r.pick(&SPACE_ALIASES));
					}
					if r.chance(2) {
						put(&mut a, "spaceId", r.pick(&["sp-1", "sp-2"]));
					}
					match r.below(5) {
						0 => put(&mut a, "limits", obj! { "maxEntries" => 3.0 }),
						1 => put(&mut a, "limits", 0.0),
						2 => put(&mut a, "profiles", vec![obj! { "name" => "p" }]),
						_ => {}
					}
					obj! { "op" => kind, "args" => a, "plan" => vec![send_plan(&mut r)] }
				}
				7 => obj! { "op" => "bindHostAlias", "args" => obj! { "alias" => r.pick(&["h1", "h2", "h3", "2", "x.y", "Bad", ""]), "hostId" => r.pick(&["H1", "H2", "H3", "10", "2", "bad id", ""]) } },
				8 | 9 => obj! { "op" => "planDeployment", "args" => raw_config(&mut r, &mut recent).map_or_else(|| obj! {}, |c| obj! { "config" => c }) },
				10..=16 => {
					let plan: Vec<Json> = (0..4).map(|_| if r.chance(10) { obj! { "noSpaceId" => true } } else if r.chance(3) { send_plan(&mut r) } else { obj! {} }).collect();
					obj! { "op" => "applyDeployment", "args" => raw_config(&mut r, &mut recent).map_or_else(|| obj! {}, |c| obj! { "config" => c }), "plan" => plan }
				}
				17 | 18 => obj! { "op" => "startWorkers", "args" => obj! { "deployment" => r.pick(&DEPLOYMENTS) } },
				19 => obj! { "op" => "exportDeployment", "args" => obj! { "deployment" => r.pick(&DEPLOYMENTS) } },
				20 => obj! { "op" => "hostStatus", "args" => obj! { "hostId" => r.pick(&HOST_IDS) } },
				_ => obj! { "op" => "listWorkers", "args" => obj! {}, "write" => (0..1 + r.below(3)).map(|_| capability(&mut r, now)).collect::<Vec<_>>() },
			},
		};
		let id: Json = if let Some(id) = l.get("id").filter(|_| !scripted) { id.clone() } else if scripted { format!("c{cmd}").into() } else if text(&l, "op") == Some("startWorkers") && r.chance(10) { "bad id".into() } else if text(&l, "op") == Some("setWorkers") && r.chance(8) { id_edge(&mut r) } else { format!("c{cmd}").into() };
		put(&mut l, "id", id);
		if text(&l, "op") == Some("setWorkers") {
			last_set = Some(l.clone());
		}
		if DEPLOYMENT_COMMANDS.contains(&text(&l, "op").unwrap()) && r.chance(if text(&l, "op") == Some("startWorkers") { 3 } else { 8 }) {
			put(&mut l, "noWorkers", true);
		}
		put(&mut l, "now", now);
		let incarnation = r.pick(&[Json::Null, Json::from("inc-1"), Json::from("inc-2")]);
		put(&mut l, "incarnation", incarnation.clone());
		let mut status = Object::new();
		for h in HOST_IDS {
			match r.below(8) {
				0 => status.insert(h, "stale".into()),
				1 => status.insert(h, "throw".into()),
				2 => {}
				_ => status.insert(h, "fresh".into()),
			}
		}
		put(&mut l, "status", Json::Object(status.clone()));

		world.now.set(now);
		*world.incarnation.borrow_mut() = incarnation.as_str().map(str::to_owned);
		*world.plan.borrow_mut() = l.get("plan").and_then(Json::as_array).cloned().unwrap_or_default().into();
		*world.status.borrow_mut() = Json::Object(status);
		world.sent.borrow_mut().clear();
		if let Some(writes) = l.get("write").and_then(Json::as_array) {
			world.on_control(|s, now| {
				for w in writes {
					let w = w.as_array().unwrap();
					s.write(now, &obj! { "type" => w[0].clone(), "fields" => w[1].clone() }, None, Some(&w[2]), None)?;
				}
				Ok(())
			}).unwrap();
		}
		let op = text(&l, "op").unwrap().to_owned();
		let args = l.get("args").cloned().unwrap_or_else(|| obj! {});
		let id_text = command_id(&l);
		let got = runtime.block_on(async {
			let host = || phi_json::text(&args, "hostId").map(str::to_owned).unwrap_or_default();
			match op.as_str() {
				"forHost" => workers.for_host(&host()).await,
				"hostStatus" => world.on_control(|c, now| capability_host_status(c, now, &host())),
				"setWorkers" | "listWorkers" => {
					let applied = || world.on_control(|s, now| applied_workers(s, now));
					worker_commands(&workers, Some(&applied), &op, &id_text, &args)
				}
				k if SPACE_COMMANDS.contains(&k) => spaces.command(k, &id_text, &args).await,
				k if DEPLOYMENT_COMMANDS.contains(&k) && l.get("noWorkers").is_some() => deployment_commands(&bare, k, &id_text, &args).await,
				k if DEPLOYMENT_COMMANDS.contains(&k) => deployment_commands(&deployment, k, &id_text, &args).await,
				k => panic!("no op {k}"),
			}
		});
		let t = ts.step(&l);
		let mut mine = match &got {
			Ok(v) => obj! { "ok" => true, "result" => v.clone() },
			Err(e) => obj! { "ok" => false, "error" => e.class, "message" => e.message.as_str() },
		};
		put(&mut mine, "sent", Json::Array(world.sent.borrow().clone()));
		let doc = |kind: &str| world.docs.borrow().get(&(kind.to_owned(), String::new())).cloned().unwrap_or(Json::Null);
		put(&mut mine, "docs", obj! { "workers" => doc("phi-spaces.worker-assignments"), "deployment" => doc("phi-spaces.deployment") });
		let (a, b) = (mine.to_json_text(), t.to_json_text());
		if a != b {
			let first = a.bytes().zip(b.bytes()).position(|(x, y)| x != y).unwrap_or(a.len().min(b.len()));
			let from = first.saturating_sub(300);
			panic!("step {n}: {}\n rust: …{}\n   ts: …{}", l.to_json_text(), &a[from.min(a.len())..(first + 300).min(a.len())], &b[from.min(b.len())..(first + 300).min(b.len())]);
		}
		let answer = [t.get("result").map(Json::to_json_text), t.get("message").map(Json::to_json_text)].into_iter().flatten().collect::<String>();
		for needle in NEEDLES {
			if answer.contains(needle) {
				seen.insert(needle);
			}
		}
	}
	let missing: Vec<&&str> = NEEDLES.iter().filter(|n| !seen.contains(*n)).collect();
	// coverage is a property of the default seed at the default length or more; other seeds only hold the equality
	let default_seed = std::env::var("PHI_DEPLOYMENT_SEED").is_err();
	assert!(missing.is_empty() || steps < 3000 || !default_seed, "outcomes never reached: {missing:?}");
}

/// The command ID the driver passes: the line's `id` as it is (a number or null stays one, and `ID.test` coerces it).
fn command_id(l: &Json) -> String {
	match l.get("id") {
		Some(Json::Null) => "null".into(),
		Some(Json::Number(n)) => phi_json::number_text(*n),
		Some(v) => v.as_str().map_or_else(|| v.to_json_text(), str::to_owned),
		None => "undefined".into(),
	}
}
