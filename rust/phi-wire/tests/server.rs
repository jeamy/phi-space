// R3, slice 4: what the transport itself decides. The server runs on a thread of its own as in the process, the client is
// plain blocking sockets. The protocol above it is held against TypeScript in phi-service's walk and by
// test/test-standalone.test.ts with PHI_SPACES_SERVER_CMD.
use phi_json::{parse, Json};
use phi_service::{Options, Service};
use phi_store::{system_random, Fault, Ledger, MemoryLedger, SpaceHost, SqliteLedger, Store, Synchronous, WriterOptions};
use phi_wire::{serve, Listen, ServeOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::unix::fs::PermissionsExt;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

struct Server {
	path: PathBuf,
	stop: Option<oneshot::Sender<()>>,
	thread: Option<std::thread::JoinHandle<()>>,
}
impl Drop for Server {
	fn drop(&mut self) {
		let _ = self.stop.take().map(|s| s.send(()));
		let _ = self.thread.take().map(|t| t.join());
	}
}

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("wire-{name}"));
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn memory() -> Ledger { Ledger::Memory(MemoryLedger::default()) }

fn try_start(d: &Path, ledger: impl FnOnce() -> Ledger + Send + 'static, tune: impl FnOnce(&mut ServeOptions, &mut Options) + Send + 'static) -> Result<Server, String> {
	let path = d.join("s.sock");
	let (ready, up) = mpsc::channel();
	let (stop, stopped) = oneshot::channel::<()>();
	let at = path.clone();
	let thread = std::thread::spawn(move || {
		let store = Store::open(ledger(), system_random).unwrap();
		let mut o = ServeOptions::new(Listen::Unix(at), "local");
		let mut options = Options::single_peer("local");
		tune(&mut o, &mut options);
		let service = Service::new(store, options);
		let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
		let told = ready.clone();
		let r = runtime.block_on(serve(service, o, move |_| told.send(Ok(())).unwrap(), async move { let _ = stopped.await; }));
		match r {
			Ok(service) => service.store.close(),
			Err(e) => { let _ = ready.send(Err(e.to_string())); }
		}
	});
	up.recv().unwrap().map(|()| Server { path, stop: Some(stop), thread: Some(thread) })
}
fn start(d: &Path) -> Server { try_start(d, memory, |_, _| {}).unwrap() }

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
	fn generation(&mut self) -> String {
		let r = parse(&self.call(r#"{"method":"generation","args":{}}"#)).unwrap();
		r.get("result").and_then(|v| v.get("generation")).and_then(Json::as_str).unwrap_or_else(|| panic!("{r:?}")).to_owned()
	}
	fn ended(&mut self) -> bool {
		let mut b = [0; 1];
		matches!(self.0.read(&mut b), Ok(0)) || matches!(self.0.read(&mut b), Err(e) if e.kind() == ErrorKind::ConnectionReset)
	}
}
fn write_call(generation: &str, id: &str) -> String { format!(r#"{{"method":"write","args":{{"entry":{{"type":"Task","fields":{{"n":1}}}}}},"request":{{"generation":"{generation}","requestId":"{id}"}}}}"#) }
fn take_call(generation: &str, id: &str, wait: u64) -> String { format!(r#"{{"method":"take","args":{{"template":{{"type":"Task"}},"timeoutMs":60000,"waitMs":{wait}}},"request":{{"generation":"{generation}","requestId":"{id}"}}}}"#) }
const COUNT: &str = r#"{"method":"count","args":{}}"#;

#[test]
fn a_reply_waits_for_the_disk_and_a_read_for_what_it_saw() {
	let d = dir("durable");
	let file = d.join("s.sqlite");
	let slow = WriterOptions { synchronous: Synchronous::Normal, fault: Some((0, Fault::Slow(Duration::from_millis(300)))), ..Default::default() };
	let s = try_start(&d, move || SpaceHost::sqlite(SqliteLedger::open_with(&file, slow).unwrap()), |_, _| {}).unwrap();
	let (mut a, mut b) = (Client::new(&s), Client::new(&s));
	let start = Instant::now();
	let generation = a.generation();
	assert!(start.elapsed() >= Duration::from_millis(280), "{:?}", start.elapsed());
	let start = Instant::now();
	a.send(7, &write_call(&generation, "r1"));
	std::thread::sleep(Duration::from_millis(100));
	let seen = b.call(COUNT);
	assert!(seen.contains(r#""value":1"#), "the read sees the commit: {seen}");
	assert!(start.elapsed() >= Duration::from_millis(280), "and is not answered before it is durable: {:?}", start.elapsed());
	assert_eq!(a.receive().0, 7);
}

#[test]
fn a_store_that_fails_answers_internal_and_goes_on_answering() {
	let d = dir("failed");
	let file = d.join("s.sqlite");
	let bad = WriterOptions { fault: Some((2, Fault::FailBeforeCommit)), ..Default::default() };
	let s = try_start(&d, move || SpaceHost::sqlite(SqliteLedger::open_with(&file, bad).unwrap()), |_, _| {}).unwrap();
	let mut a = Client::new(&s);
	let generation = a.generation();
	let reply = a.call(&write_call(&generation, "r1"));
	assert_eq!(reply, r#"{"ok":false,"error":{"code":"Internal","message":"internal error"}}"#);
	let next = a.call(&write_call(&generation, "r1"));
	assert!(next.contains(r#""ok":false"#), "{next}");
}

#[test]
fn a_frame_over_the_limit_ends_the_connection() {
	let d = dir("frame");
	let s = try_start(&d, memory, |o, _| o.max_frame_bytes = 1024).unwrap();
	let mut a = Client::new(&s);
	a.0.write_all(&[0, 0, 4, 0, 0, 0, 0, 1]).unwrap();
	assert!(a.ended());
	let mut ok = Client::new(&s);
	ok.0.write_all(&[0, 0, 3, 248]).unwrap(); // the largest frame, its header in two writes
	ok.0.write_all(&[0, 0, 0, 2]).unwrap();
	ok.0.write_all(&vec![b' '; 1016]).unwrap();
	assert!(ok.receive().1.contains(r#""ok":false"#));
}

#[test]
fn calls_at_once_are_limited_per_connection() {
	let d = dir("inflight");
	let s = try_start(&d, memory, |o, _| o.max_inflight_per_connection = 1).unwrap();
	let mut a = Client::new(&s);
	let generation = a.generation();
	a.send(1, &take_call(&generation, "r1", 500));
	a.send(2, COUNT);
	let (id, text) = a.receive();
	assert_eq!((id, text.as_str()), (2, r#"{"ok":false,"error":{"code":"ResourceExhausted","message":"at most 1 calls at once per connection"}}"#));
	assert_eq!(a.receive().0, 1);
	assert!(a.call(COUNT).contains(r#""ok":true"#), "the place is free again");
}

#[test]
fn connections_are_limited_and_idle_ones_closed() {
	let d = dir("conns");
	let s = try_start(&d, memory, |o, _| { o.max_connections = 1; o.idle_ms = 200; }).unwrap();
	let mut a = Client::new(&s);
	assert!(a.call(COUNT).contains(r#""ok":true"#));
	let mut over = Client::new(&s);
	assert!(over.ended());
	assert!(a.ended(), "no traffic for the idle limit");
	std::thread::sleep(Duration::from_millis(50));
	let mut b = Client::new(&s);
	assert!(b.call(COUNT).contains(r#""ok":true"#), "its place is free");
}

#[test]
fn a_commit_wakes_a_long_poll_at_once_where_the_service_says_so() {
	let d = dir("wake");
	let s = try_start(&d, memory, |_, o| o.wake_on_commit = true).unwrap();
	let (mut a, mut b) = (Client::new(&s), Client::new(&s));
	let generation = a.generation();
	let other = b.generation();
	a.send(1, &take_call(&generation, "r1", 5000));
	std::thread::sleep(Duration::from_millis(100));
	let start = Instant::now();
	assert!(b.call(&write_call(&other, "r2")).contains(r#""ok":true"#));
	let (_, text) = a.receive();
	assert!(text.contains(r#""state":"done""#), "{text}");
	assert!(start.elapsed() < Duration::from_millis(45), "{:?}", start.elapsed());
}

#[test]
fn the_socket_file_is_private_and_its_own() {
	let d = dir("path");
	let s = start(&d);
	assert_eq!(std::fs::metadata(&s.path).unwrap().permissions().mode() & 0o777, 0o600);
	assert!(try_start(&d, memory, |_, _| {}).err().unwrap().contains("already listening"));
	let path = s.path.clone();
	drop(s);
	assert!(!path.exists(), "closing takes it away");

	// a dead server's file is replaced
	let stale = UnixListener::bind(&path).unwrap();
	drop(stale);
	assert!(path.exists());
	let s = start(&d);
	assert!(Client::new(&s).call(COUNT).contains(r#""ok":true"#));
	drop(s);

	std::fs::write(&path, "mine").unwrap();
	assert!(try_start(&d, memory, |_, _| {}).err().unwrap().contains("non-socket"));
	assert_eq!(std::fs::read_to_string(&path).unwrap(), "mine");
}

#[test]
fn addresses() {
	assert_eq!(Listen::parse("tcp:127.0.0.1:80"), Ok(Listen::Tcp { host: "127.0.0.1".into(), port: 80 }));
	assert_eq!(Listen::parse("unix:/a"), Ok(Listen::Unix("/a".into())));
	assert_eq!(Listen::parse("/a"), Ok(Listen::Unix("/a".into())));
	assert!(Listen::parse("tcp:a").is_err());
	assert!(Listen::parse("unix:").is_err());
}
