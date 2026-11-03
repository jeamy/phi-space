// R6b step 2: a primary/sync Space on two hosts in this process (src/sync-spaces.ts), over loopback and a register in a
// file. Host a serves the Space beside its own store, host b is its standby with only the listener. A write is confirmed
// by b; with b cut off, the held reply and every later call answer CommitSealed; with b back, the resolver confirms the
// candidate with b and serves the Space again, the write included; with a's primary permit revoked, the resolver stops
// and the Space keeps answering CommitSealed.
use phi_host::boot::External;
use phi_host::register::SqliteRegister;
use phi_host::replica_control::RegisterLine;
use phi_host::sync_space::{resolver, start, MakeService, Started, SyncContext, SyncSpace, SyncSpaceConfig};
use phi_json::{obj, parse, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, Ledger, MemoryLedger, Store};
use phi_wire::{serve, Listen, Owner, Route, ServeOptions};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

const SPACE: &str = "sp-0d7f3a52-6c1e-4b8a-9f21-3e5a7c9b1d04";
const INCARNATION: &str = "1ed6e700";
const PORT: u16 = 47_311;

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64 }
/// A key file as `provisionFileSigner` writes it: PKCS#8 of an ed25519 seed.
fn key_file(seed: u8) -> (Json, String) {
	let mut der = vec![0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20];
	der.extend([seed; 32]);
	let pem = format!("-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n", phi_host::auth::to_base64(&der));
	let public = phi_host::auth::to_base64(ed25519_dalek::SigningKey::from_bytes(&[seed; 32]).verifying_key().as_bytes());
	(obj! { "algorithm" => "ed25519", "privateKey" => pem }, public)
}
fn genesis() -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => "b", "durability" => "sync" }
}
fn permit(role: &str, state: &str) -> Json {
	obj! { "state" => state, "authorityId" => "authority", "dataIncarnation" => INCARNATION, "role" => role, "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "durability" => "sync", "transitionId" => "setup" }
}
fn set_boot(register: &Path, host: &str, role: &str, state: &str) {
	let r = SqliteRegister::open(register).unwrap();
	let cur = r.get(&format!("boot:{host}")).unwrap();
	r.compare_and_set(&format!("boot:{host}"), cur.get("version").and_then(Json::as_f64), &obj! { "hostId" => host, "state" => "active", "spaces" => obj! { SPACE => permit(role, state) } }).unwrap();
}

fn config(d: &Path, host: &str) -> SyncSpaceConfig {
	let (other, ip) = if host == "a" { ("b", "127.0.0.2") } else { ("a", "127.0.0.1") };
	let (_, public) = key_file(if other == "a" { 1 } else { 2 });
	SyncSpaceConfig::from_json(&obj! {
		"alias" => "ledger", "spaceId" => SPACE, "incarnation" => INCARNATION, "dir" => d.join(format!("sync-{host}")).to_string_lossy().as_ref(), "genesis" => genesis(), "port" => PORT as f64,
		"peers" => Json::Array(vec![obj! { "hostId" => other, "algorithm" => "ed25519", "publicKey" => public, "ip" => ip }])
	})
	.unwrap()
}
fn context(d: &Path, host: &str) -> Rc<SyncContext> {
	let register = d.join("external.sqlite");
	let line = RegisterLine::spawn(move || External::File(SqliteRegister::open(&register).unwrap()));
	Rc::new(SyncContext { host_id: host.into(), authority_id: "authority".into(), bind_ip: if host == "a" { "127.0.0.1" } else { "127.0.0.2" }.parse().unwrap(), key: key_file(if host == "a" { 1 } else { 2 }).0, register: line, installed: Rc::new(SqliteRegister::open(&d.join(format!("installed-{host}.sqlite"))).unwrap()), now: Rc::new(now) })
}

/// The standby b on a thread of its own; `cut` stops its listener, `back` opens it again.
struct Standby {
	asks: tokio::sync::mpsc::UnboundedSender<(bool, mpsc::Sender<()>)>,
}
impl Standby {
	fn start(d: &Path) -> Standby {
		let (asks, mut asked) = tokio::sync::mpsc::unbounded_channel::<(bool, mpsc::Sender<()>)>();
		let d = d.to_owned();
		let (ready, up) = mpsc::channel();
		std::thread::spawn(move || {
			let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
			tokio::task::LocalSet::new().block_on(&rt, async move {
				let cx = context(&d, "b");
				let mut sp = Some(SyncSpace::open(config(&d, "b"), Rc::clone(&cx), false).await.unwrap());
				assert!(matches!(start(sp.as_ref().unwrap()).await.unwrap(), Started::Listening), "a standby only listens");
				ready.send(()).unwrap();
				while let Some((back, done)) = asked.recv().await {
					if let Some(s) = sp.take() { s.close(); }
					tokio::task::yield_now().await;
					if back { sp = Some(SyncSpace::open(config(&d, "b"), Rc::clone(&cx), false).await.unwrap()); }
					let _ = done.send(());
				}
			});
		});
		up.recv().unwrap();
		Standby { asks }
	}
	fn set(&self, back: bool) {
		let (tx, rx) = mpsc::channel();
		self.asks.send((back, tx)).unwrap();
		rx.recv_timeout(Duration::from_secs(10)).unwrap();
	}
}

/// Host a: its own store in memory, the Space served beside it and followed by the resolver.
struct Primary {
	path: PathBuf,
	stop: Option<oneshot::Sender<()>>,
	thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Primary {
	fn drop(&mut self) {
		let _ = self.stop.take().map(|s| s.send(()));
		let _ = self.thread.take().map(|t| t.join());
	}
}
fn primary(d: &Path) -> Primary {
	let path = d.join("a.sock");
	let (ready, up) = mpsc::channel();
	let (stop, stopped) = oneshot::channel::<()>();
	let (at, d) = (path.clone(), d.to_owned());
	let thread = std::thread::spawn(move || {
		let store = Store::open(Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
		let mut o = ServeOptions::new(Listen::Unix(at), "local");
		o.tasks.push(Box::new(move |owner: Owner| {
			Box::pin(async move {
				let sp = SyncSpace::open(config(&d, "a"), context(&d, "a"), false).await.unwrap();
				let make: MakeService = Rc::new(|store, sp| {
					let mut o = Options::single_peer("local");
					sp.serve_options(&mut o);
					Service::new(store, o)
				});
				let unresolved = match start(&sp).await.unwrap() {
					Started::Served(store) => {
						owner.route(&sp.names(), Some(Route::Served(Box::new(make(*store, &sp)))));
						false
					}
					_ => true,
				};
				ready.send(()).unwrap();
				resolver(owner, sp, make, unresolved).await;
			})
		}));
		let service = Service::new(store, Options::single_peer("local"));
		let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		runtime.block_on(serve(service, o, |_: Vec<String>| {}, async move { let _ = stopped.await; })).unwrap().store.close();
	});
	up.recv_timeout(Duration::from_secs(30)).unwrap();
	Primary { path, stop: Some(stop), thread: Some(thread) }
}

struct Client(UnixStream);
impl Client {
	fn call(&mut self, text: &str) -> String {
		let mut f = (text.len() as u32).to_be_bytes().to_vec();
		f.extend_from_slice(&1u32.to_be_bytes());
		f.extend_from_slice(text.as_bytes());
		self.0.write_all(&f).unwrap();
		let mut head = [0; 8];
		self.0.read_exact(&mut head).unwrap();
		let mut body = vec![0; u32::from_be_bytes(head[..4].try_into().unwrap()) as usize];
		self.0.read_exact(&mut body).unwrap();
		String::from_utf8(body).unwrap()
	}
	fn generation(&mut self) -> String {
		let r = parse(&self.call(r#"{"method":"generation","space":"ledger","args":{}}"#)).unwrap();
		r.get("result").and_then(|v| v.get("generation")).and_then(Json::as_str).unwrap_or_else(|| panic!("{r:?}")).to_owned()
	}
	fn write(&mut self, g: &str, id: &str) -> String { self.call(&format!(r#"{{"method":"write","space":"ledger","args":{{"entry":{{"type":"Ledger","fields":{{"id":"{id}"}}}}}},"request":{{"generation":"{g}","requestId":"{id}"}}}}"#)) }
	fn count(&mut self) -> String { self.call(r#"{"method":"count","space":"ledger","args":{"template":{"type":"Ledger"}}}"#) }
}
fn counted(reply: &str) -> Option<f64> { parse(reply).ok()?.get("result")?.get("value")?.as_f64() }
fn code(reply: &str) -> Option<String> { parse(reply).ok()?.get("error")?.get("code")?.as_str().map(str::to_owned) }
fn until(what: &str, ms: u64, mut f: impl FnMut() -> bool) {
	let end = Instant::now() + Duration::from_millis(ms);
	while !f() {
		assert!(Instant::now() < end, "{what}");
		std::thread::sleep(Duration::from_millis(200));
	}
}
fn standby_head(d: &Path) -> i64 { rusqlite::Connection::open(d.join("sync-b/journal.sqlite")).unwrap().query_row("SELECT COALESCE(MAX(revision), 0) FROM sync_intents", [], |r| r.get(0)).unwrap() }

#[test]
fn a_sealed_candidate_is_resolved_with_the_standby_while_the_host_runs() {
	let d = dir("sync-space");
	set_boot(&d.join("external.sqlite"), "a", "primary", "active");
	set_boot(&d.join("external.sqlite"), "b", "standby", "active");
	let standby = Standby::start(&d);
	let a = primary(&d);
	let mut c = Client(UnixStream::connect(&a.path).unwrap());
	c.0.set_read_timeout(Some(Duration::from_secs(40))).unwrap();
	let g = c.generation();
	for n in 0..3 {
		assert!(c.write(&g, &format!("w{n}")).contains(r#""ok":true"#));
	}
	assert_eq!(counted(&c.count()), Some(3.0));
	let confirmed = standby_head(&d);
	assert!(confirmed >= 4, "the standby holds the Space's creation and every write: {confirmed}");

	// the standby cut off: the held reply and every later call are CommitSealed
	standby.set(false);
	assert_eq!(code(&c.write(&g, "cut")).as_deref(), Some("CommitSealed"));
	assert_eq!(code(&c.count()).as_deref(), Some("CommitSealed"));
	// back: the resolver confirms the candidate with it and serves the Space again, the write included
	standby.set(true);
	until("the Space is served again", 20_000, || counted(&c.count()).is_some());
	assert_eq!(counted(&c.count()), Some(4.0), "the confirmed candidate is applied");
	assert_eq!(standby_head(&d), confirmed + 1);
	let g = c.generation(); // a new session's registration is a commit of its own
	assert!(c.write(&g, "after").contains(r#""ok":true"#));
	let before = standby_head(&d);
	assert_eq!(before, confirmed + 3);

	// this host's primary permit revoked: the next batch fails before it is sealed, the resolver finds the host is no longer
	// the primary and stops; the Space answers CommitSealed from then on and is never served here again
	set_boot(&d.join("external.sqlite"), "a", "primary", "revoked");
	let r = c.write(&g, "excluded");
	assert_eq!(code(&r).as_deref(), Some("Internal"), "{r}");
	until("the Space answers CommitSealed", 10_000, || code(&c.count()).as_deref() == Some("CommitSealed"));
	std::thread::sleep(Duration::from_millis(3_500));
	assert_eq!(code(&c.count()).as_deref(), Some("CommitSealed"), "never served again here");
	assert_eq!(standby_head(&d), before, "nothing was sealed after the revocation");
}
