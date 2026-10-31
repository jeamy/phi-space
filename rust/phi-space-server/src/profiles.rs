// What a project's space process does beyond serving (spaces-mmo/server/space-host.ts, codemode-chat/server/space-host.ts),
// from the same environment and with the same ready line: limits before the first call, locks only when they are missing,
// a Process entry whose lease is renewed, the store file given back. All of this is host code, which writes as nobody, so
// it runs on the store's own thread, not through a call. One thread per store: a slow disk under one space holds back
// no other.
use crate::fail;
use phi_json::{obj, Json, FOREVER};
use phi_service::{Options, Service};
use phi_store::{system_random, Compaction, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous};
use phi_wire::{serve, Listen, Periodic, ServeOptions};
use std::cell::RefCell;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::Duration;
use tokio::signal::unix::{signal, SignalKind};
use tokio::sync::watch;

const MIB: f64 = 1024.0 * 1024.0;
const PROCESS_LEASE_MS: f64 = 30_000.0;
const PROCESS_BEAT_MS: u64 = 10_000;
/// Both projects: looked at for due work at most this often, however many commits come.
const WATCH_DEBOUNCE_MS: u64 = 50;

/// One store on one socket.
struct Instance {
	listen: String,
	file: Option<PathBuf>,
	peer: &'static str,
	wake_on_commit: bool,
	limits: Json,
	/// Written once, when the store is new.
	locks: Vec<&'static str>,
	/// The host-name variable of the project, when this store carries the process's Process entry.
	presence: Option<&'static str>,
	compact_ms: u64,
}

fn env(name: &str) -> Option<String> { std::env::var(name).ok().filter(|v| !v.is_empty()) }
fn positive(name: &str, fallback: f64) -> f64 { env(name).and_then(|v| v.parse().ok()).filter(|n: &f64| *n > 0.0).unwrap_or(fallback) }

fn mmo() -> (Vec<Instance>, String) {
	let mem = env("SPACES_MMO_MEM").as_deref() == Some("1");
	let data = (!mem).then(|| env("SPACES_MMO_DATA").map_or_else(|| PathBuf::from(".local"), PathBuf::from));
	let region = env("SPACES_MMO_REGION");
	let serves = env("SPACES_MMO_SPACES").unwrap_or_else(|| "world,accounts".to_owned());
	let list: Vec<&str> = serves.split(',').map(str::trim).filter(|x| !x.is_empty()).collect();
	if list.is_empty() || list.iter().any(|x| !matches!(*x, "world" | "accounts")) {
		fail(format!("SPACES_MMO_SPACES is world, accounts or both, not {serves}"));
	}
	if let Some(d) = &data {
		std::fs::create_dir_all(d).unwrap_or_else(|e| fail(format!("{}: {e}", d.display())));
	}
	let claim_result = positive("SPACES_MMO_CLAIM_RESULT_MS", 600_000.0);
	let limits = || {
		let mut l = obj! { "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0, "claimResultMs" => claim_result, "generationAdmitMs" => claim_result, "maxLogBytes" => positive("SPACES_MMO_LOG_BYTES", 512.0 * 1024.0) };
		if let (Json::Object(o), true) = (&mut l, data.is_some()) {
			o.insert("maxClaimBytes", Json::Number(512.0 * MIB));
			o.insert("maxDocBytes", Json::Number(640.0 * MIB));
		}
		l
	};
	let compact_ms = env("SPACES_MMO_COMPACT_MS").and_then(|v| v.parse().ok()).unwrap_or(600_000);
	let world_listen = env("SPACES_MMO_LISTEN").unwrap_or_else(|| "unix:/tmp/spaces-mmo-world.sock".to_owned());
	let accounts_listen = env("SPACES_MMO_ACCOUNTS_LISTEN").unwrap_or_else(|| "unix:/tmp/spaces-mmo-accounts.sock".to_owned());
	let (world, accounts) = (list.contains(&"world"), list.contains(&"accounts"));
	let mut all = vec![];
	if world {
		let name = region.map_or_else(|| "world.sqlite".to_owned(), |r| format!("world-{r}.sqlite"));
		all.push(Instance { listen: world_listen.clone(), file: data.as_ref().map(|d| d.join(name)), peer: "peer-mmo-world", wake_on_commit: true, limits: limits(), locks: vec!["world", "npc"], presence: Some("SPACES_MMO_HOST_NAME"), compact_ms });
	}
	if accounts {
		all.push(Instance { listen: accounts_listen.clone(), file: data.as_ref().map(|d| d.join("accounts.sqlite")), peer: "peer-mmo-web", wake_on_commit: true, limits: limits(), locks: vec!["names"], presence: (!world).then_some("SPACES_MMO_HOST_NAME"), compact_ms });
	}
	let shown = |served: bool, l: &str| if served { l.to_owned() } else { "-".to_owned() };
	let line = format!("[space] ready: world on {}, accounts on {} ({})", shown(world, &world_listen), shown(accounts, &accounts_listen), data.as_ref().map_or_else(|| "memory".to_owned(), |d| d.display().to_string()));
	(all, line)
}

/// `persistentSpaceLimits`.
fn codemode_capacity() -> Result<(f64, f64), String> {
	let bytes = |name: &str, fallback: f64| -> Result<f64, String> {
		let value = match std::env::var(name).ok().map(|v| v.trim().to_owned()).filter(|v| !v.is_empty()) {
			Some(raw) => raw.parse::<f64>().unwrap_or(f64::NAN),
			None => fallback,
		};
		if !(value >= 1.0 && value.trunc() == value && value * MIB <= FOREVER) {
			return Err(format!("{name} must be a positive safe integer in MiB"));
		}
		Ok(value * MIB)
	};
	let (claim, doc) = (bytes("CODEMODE_MAX_CLAIM_MIB", 1024.0)?, bytes("CODEMODE_MAX_DOC_MIB", 1280.0)?);
	if doc <= claim {
		return Err("CODEMODE_MAX_DOC_MIB must exceed CODEMODE_MAX_CLAIM_MIB".to_owned());
	}
	Ok((claim, doc))
}

fn codemode() -> (Vec<Instance>, String) {
	let mem = env("CODEMODE_MEM").as_deref() == Some("1");
	let file = (!mem).then(|| env("CODEMODE_SQLITE").map_or_else(|| Path::new(".local").join("codemode-space.sqlite"), PathBuf::from));
	let mut limits = obj! { "maxTxnsPerOwner" => 1000.0, "maxWaitersPerOwner" => 1000.0, "maxRegsPerOwner" => 1000.0 };
	if let Some(f) = &file {
		let (claim, doc) = codemode_capacity().unwrap_or_else(|e| fail(e));
		if let Json::Object(o) = &mut limits {
			o.insert("maxClaimBytes", Json::Number(claim));
			o.insert("maxDocBytes", Json::Number(doc));
		}
		if let Some(d) = f.parent().filter(|d| !d.as_os_str().is_empty()) {
			std::fs::create_dir_all(d).unwrap_or_else(|e| fail(format!("{}: {e}", d.display())));
		}
	}
	let listen = env("CODEMODE_LISTEN").unwrap_or_else(|| "unix:/tmp/codemode-space.sock".to_owned());
	let line = format!("[space] ready on {listen} (db {})", file.as_ref().map_or_else(|| "memory".to_owned(), |f| f.display().to_string()));
	(vec![Instance { listen, file, peer: "peer-codemode", wake_on_commit: false, limits, locks: vec![], presence: Some("CODEMODE_HOST_NAME"), compact_ms: 0 }], line)
}

fn text_of(file: &str) -> String { std::fs::read_to_string(file).unwrap_or_default() }

/// `hostFacts`: what the system bars show of this host.
fn host_facts(name_var: &str, now: f64) -> Json {
	let name = env(name_var).unwrap_or_else(|| text_of("/proc/sys/kernel/hostname").trim().to_owned());
	let info = text_of("/proc/cpuinfo");
	let model = info.lines().find(|l| l.starts_with("model name")).and_then(|l| l.split_once(':')).map(|(_, m)| m.split_whitespace().collect::<Vec<_>>().join(" "));
	let cores = std::thread::available_parallelism().map_or(1, |n| n.get());
	let kib = text_of("/proc/meminfo").lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| l.split_whitespace().nth(1)?.parse::<f64>().ok()).unwrap_or(0.0);
	let arch = if std::env::consts::ARCH == "x86_64" { "x64" } else { std::env::consts::ARCH };
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
		let mut id = vec![0; 6];
		std::io::Read::read_exact(&mut std::fs::File::open("/dev/urandom").expect("the system has /dev/urandom"), &mut id).expect("/dev/urandom does not end");
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
fn run_instance(i: Instance, ready: mpsc::Sender<()>, mut stop: watch::Receiver<bool>) {
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
	let presence = i.presence.map(|name_var| Rc::new(RefCell::new(Presence::new(name_var, service.now()))));
	if let Some(p) = &presence {
		p.borrow_mut().beat(&mut service);
	}
	service.store.drain().unwrap_or_else(|e| fail(e)); // ready means what was set up is on the disk
	let listen = Listen::parse(&i.listen).unwrap_or_else(|e| fail(e));
	let mut serving = ServeOptions::new(listen, i.peer);
	serving.watch_debounce_ms = WATCH_DEBOUNCE_MS;
	if let Some(p) = &presence {
		let p = Rc::clone(p);
		serving.periodic.push(Periodic { every_ms: PROCESS_BEAT_MS, run: Box::new(move |s| p.borrow_mut().beat(s)) });
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

pub fn run(profile: &str) {
	let (instances, line) = match profile {
		"mmo" => mmo(),
		"codemode" => codemode(),
		other => fail(format!("no profile {other}: mmo or codemode")),
	};
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
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap_or_else(|e| fail(e));
	runtime.block_on(async {
		let mut term = signal(SignalKind::terminate()).unwrap_or_else(|e| fail(e));
		let mut int = signal(SignalKind::interrupt()).unwrap_or_else(|e| fail(e));
		// the starter and the tests wait for this line
		let announced = tokio::task::spawn_blocking(move || {
			for _ in 0..count {
				if up.recv().is_err() {
					return;
				}
			}
			println!("{line}");
		});
		tokio::select! {
			_ = term.recv() => {}
			_ = int.recv() => {}
		}
		drop(announced);
	});
	// what closing does not finish in this time is not waited for
	std::thread::spawn(|| {
		std::thread::sleep(Duration::from_secs(3));
		std::process::exit(0);
	});
	let _ = stop.send(true);
	for t in threads {
		let _ = t.join();
	}
	std::process::exit(0);
}
