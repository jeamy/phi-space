// What the tests of the service share: the TypeScript service as a process (test/support/service-driver.ts), and the Rust
// service on the same clock and the same stream of randomness.
#![allow(dead_code)]
use phi_core::driver::seeded;
use phi_core::space::Random;
use phi_json::{obj, parse, Json};
use phi_service::{default_policy, Authorization, Conn, Identity, Options, Outcome, RolePolicy, Service, METHODS};
use phi_store::{Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::rc::Rc;
use std::sync::{Arc, Mutex};

pub struct TsService {
	child: Child,
	input: ChildStdin,
	output: BufReader<ChildStdout>,
}
impl TsService {
	pub fn start() -> TsService {
		let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
		let mut child = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "test/support/service-driver.ts"]).current_dir(root).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("node must be on PATH");
		let input = child.stdin.take().unwrap();
		let output = BufReader::new(child.stdout.take().unwrap());
		TsService { child, input, output }
	}
	pub fn step(&mut self, line: &Json) -> Json {
		writeln!(self.input, "{}", line.to_json_text()).unwrap();
		self.input.flush().unwrap();
		let mut text = String::new();
		self.output.read_line(&mut text).unwrap();
		parse(text.trim_end()).unwrap_or_else(|e| panic!("the driver answered {text:?}: {e}"))
	}
}
impl Drop for TsService {
	fn drop(&mut self) { let _ = self.child.kill(); }
}

/// One stream of randomness for every document, as the process-wide one in TypeScript.
fn stream(seed: &str) -> impl FnMut() -> Random {
	let shared = Arc::new(Mutex::new(seeded(seed)));
	move || {
		let shared = shared.clone();
		Box::new(move |n| (shared.lock().unwrap())(n))
	}
}

pub struct Setup {
	pub seed: String,
	pub now: f64,
	pub store: Option<std::path::PathBuf>,
	pub limits: Option<Json>,
	pub max_calls: Option<f64>,
	pub max_pending: Option<f64>,
	/// The peers' limit, when it is not twice `max_pending`.
	pub max_peer: Option<f64>,
	/// Every call goes through a host's authorization (`RustSide::auth`).
	pub authorized: bool,
}

/// What the driver's `auth` says of a call.
#[derive(Clone, Default)]
pub struct Decided { pub valid_until: f64, pub roles: Vec<String>, pub can: Vec<String>, pub expired: bool }
impl Authorization for Decided {
	fn roles(&self) -> Vec<String> { self.roles.clone() }
	fn valid_until(&self) -> f64 { self.valid_until }
	fn can_execute_pending(&self, method: &str, type_name: Option<&str>) -> bool {
		let m = if method.starts_with("take") { "take" } else if method.starts_with("read") { "read" } else { method };
		self.can.iter().any(|c| *c == format!("{m}:*") || type_name.is_some_and(|t| *c == format!("{m}:{t}")))
	}
	fn check(&self, _now: f64) -> Result<(), String> { if self.expired { Err("grant expired before commit".into()) } else { Ok(()) } }
}

pub struct RustSide {
	pub service: Service,
	pub clock: Rc<Cell<f64>>,
	pub auth: Rc<RefCell<Decided>>,
}
impl RustSide {
	pub fn start(o: &Setup) -> RustSide {
		let ledger = match &o.store {
			Some(f) => SpaceHost::sqlite(open(f)),
			None => Ledger::Memory(MemoryLedger::default()),
		};
		let store = Store::open(ledger, stream(&o.seed)).unwrap();
		let clock = Rc::new(Cell::new(o.now));
		let mut options = Options::single_peer("local");
		let c = clock.clone();
		options.now = Box::new(move || c.get());
		let id = |p: Json, role: &str| Identity { principal: p, roles: vec![role.into()] };
		options.identity = HashMap::from([
			("local".to_owned(), id(obj! { "peerId" => "local" }, "member")),
			("agent".to_owned(), id(obj! { "peerId" => "local", "agentId" => "a1" }, "member")),
			("watcher".to_owned(), id(obj! { "peerId" => "watcher" }, "observer")),
			("typed".to_owned(), id(obj! { "peerId" => "typed" }, "tasks")),
		]);
		options.policy = default_policy();
		options.policy.insert("tasks".into(), RolePolicy { methods: Some(METHODS.iter().map(|m| m.to_string()).collect()), types: Some(vec!["Task".into()]) });
		if let Some(m) = o.max_calls {
			options.max_calls_per_window = m;
		}
		if let Some(m) = o.max_pending {
			options.max_pending_per_principal = m;
			options.max_pending_per_peer = o.max_peer.unwrap_or(m * 2.0);
		}
		let auth = Rc::new(RefCell::new(Decided::default()));
		if o.authorized {
			let a = auth.clone();
			options.authorize = Some(Box::new(move |_, _, _| Ok(Rc::new(a.borrow().clone()) as Rc<dyn Authorization>)));
		}
		let mut service = Service::new(store, options);
		if let Some(l) = &o.limits {
			service.set_limits(l).unwrap();
		}
		RustSide { service, clock, auth }
	}
	/// The reply to a call that does not wait.
	pub fn step(&mut self, now: f64, peer: &str, text: &str, max_frame: Option<f64>) -> String {
		self.clock.set(now);
		let conn = Conn { peer_id: Some(peer.to_owned()) };
		match self.service.handle_text(text, &conn, max_frame.unwrap_or(phi_service::DEFAULT_MAX_FRAME_BYTES)) {
			Outcome::Done { text, .. } => {
				self.service.store.drain().unwrap();
				text
			}
			Outcome::Wait(_) => panic!("the call waits: {text}"),
		}
	}
	/// The document as `core.previewOf` shows it: claims on the disk are not read.
	pub fn state(&mut self) -> String {
		let s = &self.service.store.reader(None).unwrap().space.state;
		if !s.space_id.is_some() {
			return String::new();
		}
		let on_disk = s.rpc.as_ref().is_some_and(|r| r.claims.on_disk());
		phi_json::digest_json(&if on_disk { s.to_json_without_claims() } else { s.to_json() }).unwrap()
	}
	pub fn dump(&mut self) -> String { self.service.store.reader(None).unwrap().space.state.to_json_without_claims().to_json_text() }
}
fn open(f: &Path) -> SqliteLedger { SqliteLedger::open(f, Synchronous::Full).unwrap() }
