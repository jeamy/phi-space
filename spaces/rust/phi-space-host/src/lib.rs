//! What an application's space process does beyond serving, the part every application shares: stores on sockets with
//! limits before the first call, locks only when they are missing, a Process entry whose lease is renewed, compaction,
//! host tasks, and one ready line once every store serves. All of this is host code, which writes as nobody, so it runs
//! on the store's own thread, not through a call. One thread per store: a slow disk under one space holds back no other.
//!
//! The applications' binaries (spaces-mmo's `mmo-space`, codemode-chat's `codemode-space`, the help site's
//! `help-space`) describe their stores from their own environment and call [`run`]. Nothing here names one of them.
use phi_json::{obj, Json, FOREVER};
use phi_service::{Options, Service};
use phi_store::{system_random, Compaction, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, ServeOptions};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use tokio::sync::watch;

pub use phi_wire::Periodic;

pub mod stopping;
#[cfg(feature = "testing")]
pub mod testing;

pub const MIB: f64 = 1024.0 * 1024.0;
const PROCESS_LEASE_MS: f64 = 30_000.0;
const PROCESS_BEAT_MS: u64 = 10_000;
/// Looked at for due work at most this often, however many commits come.
const WATCH_DEBOUNCE_MS: u64 = 50;

/// The reason on stderr, exit code 1: a process that cannot start says why.
pub fn fail(message: impl std::fmt::Display) -> ! {
	eprintln!("{message}");
	std::process::exit(1)
}

/// A panic ends the process: what was acknowledged is on the disk, and a half-done commit is not left running.
pub fn abort_on_panic() {
	let default = std::panic::take_hook();
	std::panic::set_hook(Box::new(move |info| {
		default(info);
		std::process::abort();
	}));
}

/// An environment variable that is set and not empty.
pub fn env(name: &str) -> Option<String> { std::env::var(name).ok().filter(|v| !v.is_empty()) }
/// `ROOT/.local`: the starters run the space process in the project's directory.
pub fn local() -> PathBuf { std::env::current_dir().unwrap_or_else(|e| fail(e)).join(".local") }
/// The directory of a store file, made when it is missing.
pub fn make_parent(file: &Path) {
	if let Some(d) = file.parent().filter(|d| !d.as_os_str().is_empty()) {
		std::fs::create_dir_all(d).unwrap_or_else(|e| fail(format!("{}: {e}", d.display())));
	}
}

/// Work of an application on one store's own thread: `prepare` once before the ready line, then `periodic` while it serves.
pub trait HostTask: Send {
	/// What the store needs before the first call (written as nobody). A failure ends the process (`fail`).
	fn prepare(&mut self, service: &mut Service);
	/// Work at intervals while the store serves.
	fn periodic(self: Box<Self>) -> Vec<Periodic>;
}

/// One store on one socket.
pub struct Instance {
	pub listen: String,
	/// None: in memory.
	pub file: Option<PathBuf>,
	pub peer: &'static str,
	pub wake_on_commit: bool,
	pub max_inflight: usize,
	pub limits: Json,
	/// Written once, when the store is new.
	pub locks: Vec<&'static str>,
	/// The host-name variable of the project, when this store carries the process's Process entry.
	pub presence: Option<&'static str>,
	/// 0: no compaction.
	pub compact_ms: u64,
	pub task: Option<Box<dyn HostTask>>,
}

fn text_of(file: &str) -> String { std::fs::read_to_string(file).unwrap_or_default() }

/// `hostFacts`: what the system bars show of this host (`name_var` names the host, else the kernel's hostname).
pub fn host_facts(name_var: &str, now: f64) -> Json {
	let name = env(name_var).unwrap_or_else(|| text_of("/proc/sys/kernel/hostname").trim().to_owned());
	let info = text_of("/proc/cpuinfo");
	let model = info.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split_once(':')).map(|(_, m)| m.split_whitespace().collect::<Vec<_>>().join(" "));
	let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
	let kib = text_of("/proc/meminfo").lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()).unwrap_or(0.0);
	let arch = match std::env::consts::ARCH { // process.arch
		"x86_64" => "x64",
		"aarch64" => "arm64",
		"x86" => "ia32",
		other => other,
	};
	obj! { "name" => name, "cpu" => model.unwrap_or_else(|| "unknown CPU".to_owned()), "cores" => cores as f64, "memGiB" => (kib * 1024.0 / 2f64.powi(30) * 10.0).round() / 10.0, "platform" => format!("Linux {arch}"), "startedAt" => now }
}

/// `announce`: a Process entry while this process runs; when it is gone (a lease that lapsed), it is written again.
struct Presence {
	fields: Json,
	lease: Option<Json>,
}
impl Presence {
	fn new(name_var: &str, now: f64) -> Presence {
		let mut fields = host_facts(name_var, now);
		let id = system_random()(6);
		if let Json::Object(o) = &mut fields {
			o.insert("procId", phi_json::hex(&id).into());
			o.insert("role", "space".into());
			o.insert("pid", Json::Number(std::process::id() as f64));
		}
		Presence { fields, lease: None }
	}
	fn beat(&mut self, service: &mut Service) {
		let now = service.now();
		let ms = Json::Number(PROCESS_LEASE_MS);
		if let Some(id) = &self.lease {
			if matches!(service.store.commit(None, now, |s| s.renew(now, Some(id), Some(&ms), None)), Ok(Ok(_))) {
				return;
			}
			self.lease = None;
		}
		let entry = obj! { "type" => "Process", "fields" => self.fields.clone() };
		if let Ok(Ok(c)) = service.store.commit(None, now, |s| s.write(now, &entry, None, Some(&ms), None)) {
			self.lease = c.value.get("id").cloned();
		}
	}
	fn stop(&mut self, service: &mut Service) {
		if let Some(id) = self.lease.take() {
			let now = service.now();
			let _ = service.store.commit(None, now, |s| s.cancel(now, Some(&id), None));
		}
	}
}

fn reported(when: &str, file: &Path, r: &Compaction) {
	if let Some(e) = &r.error {
		eprintln!("[space] compaction ({when}) of {}: {e}", file.display());
	} else if r.freed_pages != 0 || r.converted {
		println!("[space] compaction ({when}) of {}: {} free pages back{}", file.display(), r.freed_pages, if r.converted { ", switched to incremental auto-vacuum" } else { "" });
	}
}

fn lock_missing(service: &mut Service, name: &str) -> bool {
	let template = phi_core::space::Template::from_json(Some(&obj! { "type" => "Lock", "fields" => obj! { "name" => name } })).unwrap_or_else(|e| fail(e.message));
	let now = service.now();
	let held = service.store.reader(None).unwrap_or_else(|e| fail(e.message)).space.count(now, &template, None, None).unwrap_or_else(|e| fail(e.message));
	held.as_f64() == Some(0.0)
}

/// Serves one store until `stop`; starting fails the process, as a project's space host does.
fn run_instance(mut i: Instance, ready: mpsc::Sender<()>, mut stop: watch::Receiver<bool>) {
	let ledger = match &i.file {
		Some(f) => SpaceHost::sqlite(SqliteLedger::open(f, Synchronous::Full).unwrap_or_else(|e| fail(format!("{}: {e}", f.display())))),
		None => Ledger::Memory(MemoryLedger::default()),
	};
	let mut store = Store::open(ledger, system_random).unwrap_or_else(|e| fail(e));
	if let (Some(f), true) = (&i.file, i.compact_ms > 0) {
		match store.reader(None).map(SpaceHost::compact) {
			Ok(Ok(Some(r))) => reported("start", f, &r),
			Ok(Err(e)) => eprintln!("[space] compaction (start) of {}: {e}", f.display()),
			_ => {}
		}
	}
	let mut options = Options::single_peer(i.peer);
	options.max_calls_per_window = 50_000.0;
	options.max_pending_per_principal = 4096.0;
	options.max_pending_per_peer = 4096.0;
	options.wake_on_commit = i.wake_on_commit;
	let mut service = Service::new(store, options);
	service.start_background().unwrap_or_else(|e| fail(e.message));
	service.set_limits(&i.limits).unwrap_or_else(|e| fail(e.message));
	for name in &i.locks {
		if lock_missing(&mut service, name) {
			let now = service.now();
			let entry = obj! { "type" => "Lock", "fields" => obj! { "name" => *name } };
			match service.store.commit(None, now, |s| s.write(now, &entry, None, Some(&FOREVER.into()), None)) {
				Ok(Ok(_)) => {}
				Ok(Err(e)) => fail(e.message),
				Err(e) => fail(e),
			}
		}
	}
	if let Some(task) = &mut i.task {
		task.prepare(&mut service);
	}
	let presence = i.presence.map(|name_var| Rc::new(RefCell::new(Presence::new(name_var, service.now()))));
	if let Some(p) = &presence {
		p.borrow_mut().beat(&mut service);
	}
	service.store.drain().unwrap_or_else(|e| fail(e)); // ready means what was set up is on the disk
	let listen = Listen::parse(&i.listen).unwrap_or_else(|e| fail(e));
	let mut serving = ServeOptions::new(listen, i.peer);
	serving.watch_debounce_ms = WATCH_DEBOUNCE_MS;
	serving.max_inflight_per_connection = i.max_inflight;
	if let Some(p) = &presence {
		let p = Rc::clone(p);
		serving.periodic.push(Periodic { every_ms: PROCESS_BEAT_MS, run: Box::new(move |s| p.borrow_mut().beat(s)) });
	}
	if let Some(task) = i.task.take() {
		serving.periodic.extend(task.periodic());
	}
	if let (Some(f), true) = (i.file.clone(), i.compact_ms > 0) {
		serving.periodic.push(Periodic {
			every_ms: i.compact_ms,
			run: Box::new(move |s| {
				if let Some(rx) = s.store.compact_begin() {
					let f = f.clone();
					std::thread::spawn(move || {
						if let Ok(r) = rx.recv() {
							reported("interval", &f, &r);
						}
					});
				}
			}),
		});
	}
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
	let told = move |_: Vec<String>| {
		let _ = ready.send(());
	};
	let stopped = async move {
		let _ = stop.wait_for(|s| *s).await;
	};
	let mut service = runtime.block_on(serve(service, serving, told, stopped)).unwrap_or_else(|e| fail(e));
	if let Some(p) = &presence {
		p.borrow_mut().stop(&mut service);
	}
	service.store.close();
}

/// Serves every store on its own thread, prints `line` once all of them serve (the starters and the tests wait for it),
/// and on SIGTERM or SIGINT closes them and ends the process.
pub fn run(instances: Vec<Instance>, line: String) -> ! {
	let (stop, stopping) = watch::channel(false);
	let (ready, up) = mpsc::channel();
	let count = instances.len();
	let threads: Vec<_> = instances
		.into_iter()
		.map(|i| {
			let (ready, stopping) = (ready.clone(), stopping.clone());
			std::thread::Builder::new().name(format!("space-{}", i.peer)).spawn(move || run_instance(i, ready, stopping)).unwrap_or_else(|e| fail(e))
		})
		.collect();
	drop(ready);
	let runtime = stopping::runtime();
	runtime.block_on(async {
		let stopped = stopping::signalled();
		let announced = tokio::task::spawn_blocking(move || {
			for _ in 0..count {
				if up.recv().is_err() {
					return;
				}
			}
			println!("{line}");
		});
		stopped.await;
		drop(announced);
	});
	stopping::limit_closing();
	let _ = stop.send(true);
	for t in threads {
		let _ = t.join();
	}
	std::process::exit(0);
}
