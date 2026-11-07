// R6b step 2: Spaces with a store of their own behind one transport (`ServeOptions::spaces`, `Owner::route`), as a federation
// host serves a primary/sync Space beside its own store (src/runtime.ts `pick`). A call naming the Space as `space` reaches its
// store; its replies wait for that store's disk; the host swaps it while serving: for an answer that stands for it, for
// another store, or back to its own. A primary whose standby is cut off answers the held reply with `CommitSealed` over the
// socket, and so does every later call, until the host takes the store out.
use phi_json::{obj, parse, Json};
use phi_service::{sealed_reply, Options, Service};
use phi_store::primary::{PrimaryOptions, SyncPeer};
use phi_store::sync::{JournalOptions, SyncError, SyncJournal};
use phi_store::{system_random, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, WriterOptions};
use phi_wire::{serve, Listen, Owner, Route, ServeOptions};
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("wire-{name}"));
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}

/// What the test asks of the host while it serves; `Done` carries what it was answered.
enum Ask {
	Route(Vec<String>, Option<Box<dyn FnOnce() -> Route + Send>>),
	Failed(String),
}
struct Server {
	path: PathBuf,
	asks: tokio::sync::mpsc::UnboundedSender<(Ask, mpsc::Sender<bool>)>,
	stop: Option<oneshot::Sender<()>>,
	thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Server {
	fn drop(&mut self) {
		let _ = self.stop.take().map(|s| s.send(()));
		let _ = self.thread.take().map(|t| t.join());
	}
}
impl Server {
	/// Routes `names` anew; true if a service came back (its store is closed by the host).
	fn route(&self, names: &[&str], to: Option<Box<dyn FnOnce() -> Route + Send>>) -> bool {
		let (tx, rx) = mpsc::channel();
		self.asks.send((Ask::Route(names.iter().map(|n| n.to_string()).collect(), to), tx)).unwrap();
		rx.recv_timeout(Duration::from_secs(10)).unwrap()
	}
	fn failed(&self, name: &str) -> bool {
		let (tx, rx) = mpsc::channel();
		self.asks.send((Ask::Failed(name.into()), tx)).unwrap();
		rx.recv_timeout(Duration::from_secs(10)).unwrap()
	}
}

/// The host's own store in memory, and `spaces` routed from the start (made on the server's thread).
fn start(d: &Path, spaces: impl FnOnce() -> Vec<(Vec<String>, Route)> + Send + 'static) -> Server {
	let path = d.join("s.sock");
	let (ready, up) = mpsc::channel();
	let (stop, stopped) = oneshot::channel::<()>();
	let (asks, mut asked) = tokio::sync::mpsc::unbounded_channel::<(Ask, mpsc::Sender<bool>)>();
	let at = path.clone();
	let thread = std::thread::spawn(move || {
		let store = Store::open(Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
		let mut o = ServeOptions::new(Listen::Unix(at), "local");
		o.spaces = spaces();
		o.tasks.push(Box::new(move |owner: Owner| {
			Box::pin(async move {
				while let Some((ask, done)) = asked.recv().await {
					match ask {
						Ask::Route(names, to) => {
							let back = owner.route(&names, to.map(|f| f()));
							let _ = done.send(!back.is_empty());
							for s in back { s.store.close(); }
						}
						Ask::Failed(name) => {
							let _ = done.send(tokio::time::timeout(Duration::from_secs(5), owner.failed(&name)).await.is_ok());
						}
					}
				}
			})
		}));
		let service = Service::new(store, Options::single_peer("local"));
		let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		let r = runtime.block_on(serve(service, o, move |_: Vec<String>| ready.send(()).unwrap(), async move { let _ = stopped.await; }));
		r.unwrap().store.close();
	});
	up.recv().unwrap();
	Server { path, asks, stop: Some(stop), thread: Some(thread) }
}

struct Client(UnixStream);
impl Client {
	fn new(s: &Server) -> Client {
		let c = UnixStream::connect(&s.path).unwrap();
		c.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
		Client(c)
	}
	fn send(&mut self, id: u32, text: &str) {
		let mut f = (text.len() as u32).to_be_bytes().to_vec();
		f.extend_from_slice(&id.to_be_bytes());
		f.extend_from_slice(text.as_bytes());
		self.0.write_all(&f).unwrap();
	}
	fn receive(&mut self) -> (u32, String) {
		let mut head = [0; 8];
		self.0.read_exact(&mut head).unwrap();
		let mut body = vec![0; u32::from_be_bytes(head[..4].try_into().unwrap()) as usize];
		self.0.read_exact(&mut body).unwrap();
		(u32::from_be_bytes(head[4..].try_into().unwrap()), String::from_utf8(body).unwrap())
	}
	fn call(&mut self, text: &str) -> String {
		self.send(1, text);
		self.receive().1
	}
	/// `space` as the call's own field: `None` is the host's default Space.
	fn generation(&mut self, space: Option<&str>) -> String {
		let r = parse(&self.call(&with_space(r#"{"method":"generation","args":{}}"#, space))).unwrap();
		r.get("result").and_then(|v| v.get("generation")).and_then(Json::as_str).unwrap_or_else(|| panic!("{r:?}")).to_owned()
	}
	fn count(&mut self, space: Option<&str>) -> String { self.call(&with_space(r#"{"method":"count","args":{"template":{"type":"Task"}}}"#, space)) }
}
fn with_space(call: &str, space: Option<&str>) -> String {
	let mut v = parse(call).unwrap();
	if let Some(s) = space { v.as_object_mut().unwrap().insert("space", s.into()); }
	v.to_json_text()
}
fn write_call(generation: &str, id: &str, space: Option<&str>) -> String {
	with_space(&format!(r#"{{"method":"write","args":{{"entry":{{"type":"Task","fields":{{"n":1}}}}}},"request":{{"generation":"{generation}","requestId":"{id}"}}}}"#), space)
}
fn counted(reply: &str) -> f64 { parse(reply).unwrap().get("result").and_then(|r| r.get("value")).and_then(Json::as_f64).unwrap_or_else(|| panic!("{reply}")) }

/// A store of its own with the Space `ledger` in it.
fn ledger_store(ledger: Ledger) -> Service { ledger_store_id(ledger).0 }
fn ledger_store_id(ledger: Ledger) -> (Service, String) {
	let mut store = Store::open(ledger, system_random).unwrap();
	let info = store.create_space("ledger", 1_000.0, system_random()).unwrap().unwrap();
	store.drain().unwrap();
	(Service::new(store, Options::single_peer("local")), info.get("spaceId").and_then(Json::as_str).unwrap().to_owned())
}

#[test]
fn a_space_with_a_store_of_its_own_is_reached_by_its_name_and_swapped_while_serving() {
	let d = dir("spaces");
	let file = d.join("ledger.sqlite");
	let first = file.clone();
	let (id_tx, id_rx) = mpsc::channel();
	let s = start(&d, move || {
		let (service, id) = ledger_store_id(SpaceHost::sqlite(SqliteLedger::open_with(&first, WriterOptions::default()).unwrap()));
		id_tx.send(id.clone()).unwrap();
		vec![(vec!["ledger".into(), id], Route::Served(Box::new(service)))]
	});
	let id = id_rx.recv().unwrap();
	let mut c = Client::new(&s);
	let g = c.generation(Some("ledger"));
	assert!(c.call(&write_call(&g, "r1", Some("ledger"))).contains(r#""ok":true"#));
	assert_eq!(counted(&c.count(Some("ledger"))), 1.0);
	assert_eq!(counted(&c.count(Some(id.as_str()))), 1.0, "every name of it reaches it");
	assert_eq!(counted(&c.count(None)), 0.0, "the host's own store is another");
	assert!(c.count(Some("other")).contains("UnknownSpace") || c.count(Some("other")).contains(r#""ok":false"#), "a name not routed is the host's own store's to answer");

	// an answer that stands for it: the store comes back, closed by the host, and every call gets the answer
	assert!(s.route(&["ledger", id.as_str()], Some(Box::new(|| Route::Answer(Rc::new(|_: &phi_service::Conn| r#"{"ok":false,"error":{"code":"Stand","message":"in"}}"#.to_owned()))))));
	assert_eq!(c.count(Some("ledger")), r#"{"ok":false,"error":{"code":"Stand","message":"in"}}"#);
	assert_eq!(counted(&c.count(None)), 0.0);
	// the same file opened again (it is closed now) and served anew
	let again = file.clone();
	assert!(!s.route(&["ledger", id.as_str()], Some(Box::new(move || Route::Served(Box::new(ledger_store(SpaceHost::sqlite(SqliteLedger::open_with(&again, WriterOptions::default()).unwrap()))))))));
	let g = c.generation(Some("ledger"));
	assert!(c.call(&write_call(&g, "r2", Some("ledger"))).contains(r#""ok":true"#));
	assert_eq!(counted(&c.count(Some("ledger"))), 2.0, "what was written before is there");
	// a Space taken out goes back to the host's own store, which has no such Space
	assert!(s.route(&["ledger", id.as_str()], None));
	assert!(c.count(Some("ledger")).contains(r#""ok":false"#));
}

/// A standby journal in this process; `cut` refuses every entry from then on.
struct Standby {
	journal: SyncJournal,
	cut: Arc<Mutex<bool>>,
}
impl SyncPeer for Standby {
	fn accept(&mut self, intent: &Json) -> Result<Json, SyncError> {
		if *self.cut.lock().unwrap() {
			return Err(SyncError::Blocked("the standby is cut off".into()));
		}
		self.journal.accept(intent, |_, _| Ok(()))
	}
}

#[test]
fn a_primary_whose_standby_is_cut_off_answers_commit_sealed_over_the_socket() {
	let d = dir("sealed");
	let genesis = obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => "b", "durability" => "sync" };
	let o = || JournalOptions { format: Some("own".into()), ..Default::default() };
	let cut = Arc::new(Mutex::new(false));
	let standby = Standby { journal: SyncJournal::open(&d.join("b.sqlite"), &genesis, JournalOptions { self_id: Some("b".into()), ..o() }).unwrap(), cut: Arc::clone(&cut) };
	let journal = SyncJournal::open(&d.join("a.sqlite"), &genesis, o()).unwrap();
	let store_file = d.join("a.store.sqlite");
	let (gate_tx, gate_rx) = mpsc::channel();
	let s = start(&d, move || {
		let p = PrimaryOptions { peer: Some(Box::new(standby)), assert_primary: Box::new(|| Ok(())), now: Box::new(|| 1_000.0) };
		let ledger = SqliteLedger::open_primary(&store_file, WriterOptions::default(), journal, p).unwrap();
		gate_tx.send(ledger.gate().cloned().unwrap()).unwrap();
		vec![(vec!["ledger".into()], Route::Served(Box::new(ledger_store(SpaceHost::sqlite(ledger)))))]
	});
	let gate = gate_rx.recv().unwrap();
	let mut c = Client::new(&s);
	let g = c.generation(Some("ledger"));
	assert!(c.call(&write_call(&g, "r1", Some("ledger"))).contains(r#""ok":true"#));

	// the standby cut off: the held reply leaves as CommitSealed, and so does every later call
	*cut.lock().unwrap() = true;
	let held = c.call(&write_call(&g, "r2", Some("ledger")));
	let (revision, _) = gate.sealed().expect("the store names its candidate");
	let sealed = sealed_reply(revision);
	assert_eq!(held, sealed, "the held reply over the socket");
	assert_eq!(c.count(Some("ledger")), sealed);
	assert!(s.failed("ledger"), "the host learns that the Space's store failed");
	assert_eq!(counted(&c.count(None)), 0.0, "the host's own store goes on");
	// the host takes it out to resolve the candidate; its calls get what the host answers meanwhile
	assert!(s.route(&["ledger"], Some(Box::new(move || Route::Answer(Rc::new(move |_: &phi_service::Conn| sealed_reply(revision)))))));
	assert_eq!(c.count(Some("ledger")), sealed);
	assert!(gate.into_journal().is_ok(), "the closed store let go of its journal");
}
