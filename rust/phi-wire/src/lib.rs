//! The socket transport of the space service, ported from src/socket.ts. Frame: u32 length, u32 call id (big endian), then
//! `length` bytes of UTF-8 JSON. Calls on one connection run concurrently; a reply carries the id of its call. A frame
//! over the limit is a protocol violation and ends the connection.
//!
//! Everything here runs on one thread, the one that owns the store: a call is handled to its end before the next is
//! looked at, and only the disk is another thread. A reply leaves once the store has made durable what it rests on.
use phi_service::{Conn, Outcome, Parked, Service};
use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::future::Future;
use std::io;
use std::net::IpAddr;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;
use phi_json::{parse_repairing, Json};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixListener, UnixStream};
use tokio::sync::{watch, Notify};
use tokio::task::spawn_local;
use tokio::time::{sleep, timeout, Instant};

const HEADER: usize = 8;
/// The longest a timer runs at once (`core.timerDelay`); what is further off is reached in steps.
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
const ACCEPT_PAUSE_MS: u64 = 100;
/// Answers of one connection waiting for the disk; a client that outruns a stalled disk by more is refused.
const MAX_HELD_REPLIES: usize = 1024;
/// Includes replies already handed to a blocked socket writer.
const MAX_HELD_REPLY_BYTES: usize = 8 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq)]
pub enum Listen {
	Unix(PathBuf),
	Tcp { host: String, port: u16 },
}
impl Listen {
	/// `unix:/path` or `tcp:host:port` (space-client.ts parseTarget).
	pub fn parse(spec: &str) -> Result<Listen, String> {
		if let Some(rest) = spec.strip_prefix("tcp:") {
			let wrong = || format!("a tcp address is tcp:host:port, not {spec}");
			let (host, port) = rest.split_once(':').ok_or_else(wrong)?;
			if host.is_empty() {
				return Err(wrong());
			}
			return Ok(Listen::Tcp { host: host.to_owned(), port: port.parse().map_err(|_| wrong())? });
		}
		let path = spec.strip_prefix("unix:").unwrap_or(spec);
		if path.is_empty() {
			return Err(format!("an address is unix:/path or tcp:host:port, not {spec}"));
		}
		Ok(Listen::Unix(path.into()))
	}
}

/// Where connections come in, and who they are. `None`: nobody the service knows.
pub struct Endpoint {
	pub listen: Listen,
	pub peer: Option<String>,
}

/// Work on the owner thread that a front hands to the transport.
pub type Local<T> = Pin<Box<dyn Future<Output = T>>>;

/// One admitted connection of a front. Who it is may change while it is open, so each call asks.
pub trait Session {
	fn conn(&self) -> Conn;
	/// The answer to a call the front handles itself; `None` passes it to the service.
	fn call(&self, service: &mut Service, call: &Json) -> Option<String>;
	/// The answer to a call the front has to go away for; it comes back on the owner thread.
	fn later(self: Rc<Self>, _owner: Owner, _call: &Json) -> Option<Local<String>> { None }
	/// What has to be read before a call is looked at; the frames of the connection wait for it.
	fn prepare(&self, _owner: Owner, _call: Option<&Json>, _text: &str) -> Option<Local<()>> { None }
	/// What the client gets of the service's answer.
	fn reply(&self, text: String) -> String;
	/// Resolves when the front ends the connection.
	fn ended(&self) -> Local<()>;
	/// The connection is gone.
	fn closed(&self);
}

/// Decides who may talk to a listener (src/gate.ts). A connection waits for `admit` before a frame of it is read.
pub trait Front {
	/// `None` refuses the connection; it then closes.
	fn admit(self: Rc<Self>, ip: IpAddr) -> Local<Option<Rc<dyn Session>>>;
	/// Runs for as long as the server does.
	fn run(self: Rc<Self>, owner: Owner) -> Local<()>;
	/// A line of the test hooks this front answers.
	fn hook(self: Rc<Self>, _owner: Owner, _text: &str) -> Option<Local<String>> { None }
}

/// A front's way to the service, between two calls on the owner thread.
#[derive(Clone)]
pub struct Owner(Rc<Hub>);
impl Owner {
	pub fn with<T>(&self, f: impl FnOnce(&mut Service) -> T) -> T {
		let out = f(&mut self.0.service.borrow_mut());
		self.0.committed();
		out
	}
	/// Commits handed to the store so far.
	pub fn handed(&self) -> u64 { self.0.service.borrow().store.handed() }
	/// Resolves after the next commit.
	pub async fn commit(&self) { self.0.commits.notified().await }
}

/// What the test hooks do with a line (`--test-hooks`): the service, how many connections are open, the text.
pub type Hook = Box<dyn FnMut(&mut Service, usize, &str) -> String>;

/// Host work at a regular interval, on the owner thread between two calls.
pub struct Periodic {
	pub every_ms: u64,
	pub run: Box<dyn FnMut(&mut Service)>,
}

pub struct ServeOptions {
	pub periodic: Vec<Periodic>,
	pub endpoints: Vec<Endpoint>,
	/// TCP listeners behind a front; their addresses follow those of the endpoints.
	pub gates: Vec<(Listen, Rc<dyn Front>)>,
	/// A socket apart from the service's own, for tests only.
	pub hooks: Option<(PathBuf, Hook)>,
	pub max_frame_bytes: usize,
	pub max_connections: usize,
	pub max_inflight_per_connection: usize,
	/// A connection with no traffic for this long is closed.
	pub idle_ms: u64,
	/// Commits are looked at for due work at most this often.
	pub watch_debounce_ms: u64,
}
impl ServeOptions {
	pub fn new(listen: Listen, peer: &str) -> ServeOptions {
		ServeOptions { periodic: vec![], endpoints: vec![Endpoint { listen, peer: Some(peer.to_owned()) }], gates: vec![], hooks: None, max_frame_bytes: 256 * 1024, max_connections: 64, max_inflight_per_connection: 32, idle_ms: 5 * 60_000, watch_debounce_ms: 20 }
	}
}

/// What all connections of a server share. It stays on the owner thread.
struct Hub {
	service: RefCell<Service>,
	/// Commits handed to the store so far, as last seen.
	handed: Cell<u64>,
	commits: Notify,
	due: Notify,
	durable: watch::Sender<u64>,
	/// The store failed: what was not durable by then never will be.
	failed: Cell<bool>,
	open: Cell<usize>,
	stop: Notify,
	hook: RefCell<Option<Hook>>,
	o: ServeOptions,
}
impl Hub {
	/// After anything that may have committed: long polls look again, due work is asked for, a store in memory is durable.
	fn committed(&self) {
		let mut service = self.service.borrow_mut();
		let handed = service.store.handed();
		if handed != self.handed.replace(handed) {
			self.commits.notify_waiters();
			self.due.notify_one();
		}
		self.take_durable(&mut service);
	}
	fn take_durable(&self, service: &mut Service) {
		if let Err(e) = service.store.pump() {
			if !self.failed.replace(true) {
				eprintln!("phi-spaces socket: store failed: {e}");
				self.durable.send_modify(|_| ()); // once: a writer looks at `failed` on every turn
			}
		}
		let durable = service.store.durable();
		self.durable.send_if_modified(|d| std::mem::replace(d, durable) != durable);
	}
}

struct Reply {
	/// The commits it rests on.
	mark: u64,
	id: u32,
	text: String,
	/// It ends a call that holds a place among the connection's calls at once.
	counted: bool,
}

/// One connection's replies on their way out.
#[derive(Default)]
struct Link {
	queue: RefCell<VecDeque<Reply>>,
	held_replies: Cell<usize>,
	held_bytes: Cell<usize>,
	ready: Notify,
	inflight: Cell<usize>,
	closed: Cell<bool>,
	closing: Notify,
	last: Cell<Option<Instant>>,
	session: Option<Rc<dyn Session>>,
}
impl Link {
	fn reply(&self, r: Reply) {
		if self.closed.get() { return; }
		let bytes = r.text.len().saturating_add(HEADER);
		if self.held_replies.get() >= MAX_HELD_REPLIES || bytes > MAX_HELD_REPLY_BYTES.saturating_sub(self.held_bytes.get()) {
			self.close();
			return;
		}
		self.held_replies.set(self.held_replies.get() + 1);
		self.held_bytes.set(self.held_bytes.get() + bytes);
		self.queue.borrow_mut().push_back(r);
		self.ready.notify_one();
	}
	fn close(&self) {
		if self.closed.replace(true) { return; }
		self.queue.borrow_mut().clear();
		self.closing.notify_waiters();
		self.ready.notify_one();
	}
	fn touch(&self) { self.last.set(Some(Instant::now())); }
	/// A service answer on its way to the client.
	fn outgoing(&self, text: String) -> String {
		match &self.session {
			Some(s) => s.reply(text),
			None => text,
		}
	}
}

pub fn put(out: &mut Vec<u8>, id: u32, text: &str) {
	out.extend_from_slice(&(text.len() as u32).to_be_bytes());
	out.extend_from_slice(&id.to_be_bytes());
	out.extend_from_slice(text.as_bytes());
}

/// One frame's body from a line that answers in turn: the client's side of `frames`.
pub async fn read_frame<R: AsyncRead + Unpin>(read: &mut R) -> io::Result<Vec<u8>> {
	let mut head = [0u8; HEADER];
	read.read_exact(&mut head).await?;
	let n = u32::from_be_bytes(head[..4].try_into().expect("four bytes")) as usize;
	if (n + HEADER) as f64 > phi_service::DEFAULT_MAX_FRAME_BYTES {
		return Err(io::Error::other("a frame over the limit"));
	}
	let mut text = vec![0u8; n];
	read.read_exact(&mut text).await?;
	Ok(text)
}

/// Serves until `stop` resolves, then gives the service back with nothing left in flight on its side. `ready` is told the
/// address once the server listens.
pub async fn serve(service: Service, o: ServeOptions, ready: impl FnOnce(Vec<String>), stop: impl Future<Output = ()>) -> io::Result<Service> {
	let local = tokio::task::LocalSet::new();
	let hub = local.run_until(serve_here(service, o, ready, stop)).await?;
	drop(local); // the tasks go, and what they hold of the hub
	let hub = Rc::try_unwrap(hub).map_err(|_| io::Error::other("a task outlived the server"))?;
	Ok(hub.service.into_inner())
}

async fn serve_here(service: Service, mut o: ServeOptions, ready: impl FnOnce(Vec<String>), stop: impl Future<Output = ()>) -> io::Result<Rc<Hub>> {
	assert!(o.max_frame_bytes >= 256, "maxFrameBytes must be at least 256");
	let wake = Arc::new(Notify::new());
	let woken = Arc::clone(&wake);
	service.store.set_waker(Arc::new(move || woken.notify_one()));
	let durable = service.store.durable();
	let handed = service.store.handed();
	let periodic = std::mem::take(&mut o.periodic);
	let (hooks, hook) = o.hooks.take().map_or((None, None), |(path, hook)| (Some(path), Some(hook)));
	let hub = Rc::new(Hub { service: RefCell::new(service), handed: Cell::new(handed), commits: Notify::new(), due: Notify::new(), durable: watch::channel(durable).0, failed: Cell::new(false), open: Cell::new(0), stop: Notify::new(), hook: RefCell::new(hook), o });

	spawn_local({
		let hub = Rc::clone(&hub);
		async move {
			loop {
				wake.notified().await;
				hub.take_durable(&mut hub.service.borrow_mut());
			}
		}
	});
	spawn_local(background(Rc::clone(&hub)));
	for mut p in periodic {
		let hub = Rc::clone(&hub);
		spawn_local(async move {
			loop {
				sleep(Duration::from_millis(p.every_ms)).await;
				(p.run)(&mut hub.service.borrow_mut());
				hub.committed();
			}
		});
	}

	let mut bound = vec![];
	let binding: io::Result<()> = async {
		for e in &hub.o.endpoints {
			bound.push((Bound::bind(&e.listen).await?, Who::Peer(e.peer.clone())));
		}
		for (listen, front) in &hub.o.gates {
			bound.push((Bound::bind(listen).await?, Who::Gate(Rc::clone(front))));
			spawn_local(Rc::clone(front).run(Owner(Rc::clone(&hub))));
		}
		if let Some(path) = hooks {
			bound.push((Bound::bind(&Listen::Unix(path)).await?, Who::Hooks));
		}
		Ok(())
	}
	.await;
	if let Err(e) = binding {
		bound.iter().for_each(|(b, _)| b.close());
		return Err(e);
	}
	ready(bound.iter().map(|(b, _)| b.address()).collect());
	let bound = Rc::new(bound);
	tokio::pin!(stop);
	let mut accepting = tokio::task::JoinSet::new();
	for (i, _) in bound.iter().enumerate() {
		let (hub, bound) = (Rc::clone(&hub), Rc::clone(&bound));
		accepting.spawn_local(async move { accepts(&hub, &bound[i].0, &bound[i].1).await });
	}
	let ended = tokio::select! {
		_ = &mut stop => Ok(()),
		Some(r) = accepting.join_next() => r.map_err(io::Error::other).and_then(|r| r),
	};
	accepting.abort_all();
	hub.stop.notify_waiters();
	bound.iter().for_each(|(b, _)| b.close());
	tokio::task::yield_now().await;
	let _ = hub.service.borrow_mut().store.drain();
	ended.map(|()| hub)
}

/// What one accept can run into while the listener stands: out of descriptors or memory, a peer that went already.
fn passing(e: &io::Error) -> bool {
	const LINUX: [i32; 4] = [23, 24, 71, 105]; // ENFILE, EMFILE, EPROTO, ENOBUFS
	matches!(e.kind(), io::ErrorKind::ConnectionAborted | io::ErrorKind::ConnectionReset | io::ErrorKind::Interrupted | io::ErrorKind::OutOfMemory) || e.raw_os_error().is_some_and(|c| LINUX.contains(&c))
}

/// Connections of one listener, until accepting fails for good. A passing failure pauses it: the queue is not lost, and
/// without descriptors the next accept fails at once.
async fn accepts(hub: &Rc<Hub>, bound: &Bound, who: &Who) -> io::Result<()> {
	loop {
		if let Err(e) = bound.accept(hub, who).await {
			if !passing(&e) {
				return Err(e);
			}
			sleep(Duration::from_millis(ACCEPT_PAUSE_MS)).await;
		}
	}
}

/// The reaper and delivery: at the next due time, and looked at again after commits, which may bring an earlier one.
async fn background(hub: Rc<Hub>) {
	loop {
		let wake = hub.service.borrow_mut().background();
		hub.committed();
		let ms = (wake - hub.service.borrow().now()).clamp(1.0, MAX_TIMER_MS);
		tokio::select! {
			_ = sleep(Duration::from_millis(ms as u64)) => {}
			_ = hub.due.notified() => sleep(Duration::from_millis(hub.o.watch_debounce_ms)).await,
		}
	}
}

enum Bound {
	Unix(UnixListener, PathBuf, (u64, u64)),
	Tcp(TcpListener, String),
}
impl Bound {
	async fn bind(l: &Listen) -> io::Result<Bound> {
		match l {
			Listen::Unix(path) => {
				prepare_socket_path(path).await?;
				let listener = UnixListener::bind(path)?;
				std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
				let m = std::fs::symlink_metadata(path)?;
				Ok(Bound::Unix(listener, path.clone(), (m.dev(), m.ino())))
			}
			Listen::Tcp { host, port } => {
				let listener = TcpListener::bind((host.as_str(), *port)).await?;
				let port = listener.local_addr()?.port();
				Ok(Bound::Tcp(listener, format!("tcp:{host}:{port}")))
			}
		}
	}
	fn address(&self) -> String {
		match self {
			Bound::Unix(_, path, _) => format!("unix:{}", path.display()),
			Bound::Tcp(_, a) => a.clone(),
		}
	}
	async fn accept(&self, hub: &Rc<Hub>, who: &Who) -> io::Result<()> {
		match self {
			Bound::Unix(l, ..) => {
				let (socket, _): (UnixStream, _) = l.accept().await?;
				let (r, w) = socket.into_split();
				connection(hub, who.clone(), None, r, w);
			}
			Bound::Tcp(l, _) => {
				let (socket, from): (TcpStream, _) = l.accept().await?;
				let _ = socket.set_nodelay(true); // Node does not end a server for it either
				let (r, w) = socket.into_split();
				connection(hub, who.clone(), Some(from.ip()), r, w);
			}
		}
		Ok(())
	}
	/// The socket file goes, unless someone else's stands there by now.
	fn close(&self) {
		if let Bound::Unix(_, path, (dev, ino)) = self {
			if std::fs::symlink_metadata(path).is_ok_and(|m| m.dev() == *dev && m.ino() == *ino) {
				let _ = std::fs::remove_file(path);
			}
		}
	}
}

/// A socket file left behind by a dead server is replaced; a live server, or anything else at that path, is not.
async fn prepare_socket_path(path: &Path) -> io::Result<()> {
	let old = match std::fs::symlink_metadata(path) {
		Ok(m) => m,
		Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(e) => return Err(e),
	};
	if !old.file_type().is_socket() {
		return Err(io::Error::other(format!("refusing to replace a non-socket path: {}", path.display())));
	}
	match timeout(Duration::from_millis(250), UnixStream::connect(path)).await {
		Err(_) => return Err(io::Error::other(format!("socket is busy or unresponsive: {}", path.display()))),
		Ok(Ok(_)) => return Err(io::Error::other(format!("a server is already listening at {}", path.display()))),
		Ok(Err(e)) if matches!(e.kind(), io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound) => {}
		Ok(Err(e)) => return Err(e),
	}
	match std::fs::symlink_metadata(path) {
		Ok(m) if m.file_type().is_socket() && m.ino() == old.ino() && m.dev() == old.dev() => std::fs::remove_file(path).or_else(|e| if e.kind() == io::ErrorKind::NotFound { Ok(()) } else { Err(e) }),
		Ok(_) => Err(io::Error::other("socket path changed during stale-file check")),
		Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(e) => Err(e),
	}
}

fn connection<R, W>(hub: &Rc<Hub>, who: Who, from: Option<IpAddr>, read: R, write: W)
where
	R: AsyncRead + Unpin + 'static,
	W: AsyncWrite + Unpin + 'static,
{
	let counted = !matches!(who, Who::Hooks);
	if counted && hub.open.get() >= hub.o.max_connections {
		return; // dropping the halves closes the socket
	}
	hub.open.set(hub.open.get() + usize::from(counted));
	let hub = Rc::clone(hub);
	spawn_local(async move {
		let session = match (&who, from) {
			(Who::Gate(front), Some(ip)) => {
				tokio::select! {
					s = Rc::clone(front).admit(ip) => s,
					_ = hub.stop.notified() => None,
				}
			}
			_ => None,
		};
		if !matches!(who, Who::Gate(_)) || session.is_some() {
			let link = Rc::new(Link { session: session.clone(), ..Link::default() });
			link.touch();
			spawn_local(replies(Rc::clone(&hub), Rc::clone(&link), write));
			tokio::select! {
				_ = frames(&hub, &link, &who, read) => {}
				_ = link.closing.notified() => {}
				_ = idle(&hub, &link), if counted => {} // the test hooks are no client: a case's short limit is not theirs
				_ = hub.stop.notified() => {}
				_ = ended(session.as_ref()) => {}
			}
			link.close();
		}
		if let Some(s) = session {
			s.closed();
		}
		hub.open.set(hub.open.get() - usize::from(counted));
	});
}

async fn ended(session: Option<&Rc<dyn Session>>) {
	match session {
		Some(s) => s.ended().await,
		None => std::future::pending().await,
	}
}

/// Returns when the connection has had no traffic for the idle limit.
async fn idle(hub: &Hub, link: &Link) {
	let limit = Duration::from_millis(hub.o.idle_ms);
	loop {
		let last = link.last.get().expect("set at the start");
		if last.elapsed() >= limit {
			return;
		}
		tokio::time::sleep_until(last + limit).await;
	}
}

/// Reads frames until the peer leaves, a read fails or a frame is over the limit.
async fn frames<R: AsyncRead + Unpin>(hub: &Rc<Hub>, link: &Rc<Link>, who: &Who, mut read: R) {
	let max = hub.o.max_frame_bytes - HEADER;
	let mut buf: Vec<u8> = Vec::with_capacity(16 * 1024);
	let mut at = 0;
	loop {
		while buf.len() - at >= HEADER {
			let n = u32::from_be_bytes(buf[at..at + 4].try_into().expect("four bytes")) as usize;
			if n > max {
				return;
			}
			if buf.len() - at < HEADER + n {
				break;
			}
			let id = u32::from_be_bytes(buf[at + 4..at + 8].try_into().expect("four bytes"));
			let text = String::from_utf8_lossy(&buf[at + HEADER..at + HEADER + n]);
			match who {
				Who::Peer(peer) => call(hub, link, &Conn { peer_id: peer.clone(), identity: None, proof_key: None }, id, &text, parse_repairing(&text).ok().as_ref()),
				Who::Gate(_) => {
					let session = link.session.as_ref().expect("a gate's connection has its session");
					let parsed = parse_repairing(&text).ok();
					if let Some(ready) = session.prepare(Owner(Rc::clone(hub)), parsed.as_ref(), &text) {
						ready.await;
					}
					let conn = session.conn();
					call(hub, link, &conn, id, &text, parsed.as_ref());
				}
				Who::Hooks => hooked(hub, link, id, &text),
			}
			if link.closed.get() { return; }
			at += HEADER + n;
		}
		buf.drain(..at);
		at = 0;
		match read.read_buf(&mut buf).await {
			Ok(n) if n > 0 => link.touch(),
			_ => return,
		}
	}
}

#[derive(Clone)]
enum Who {
	Peer(Option<String>),
	Gate(Rc<dyn Front>),
	Hooks,
}

fn hooked(hub: &Rc<Hub>, link: &Rc<Link>, id: u32, text: &str) {
	for (_, front) in &hub.o.gates {
		if let Some(answer) = Rc::clone(front).hook(Owner(Rc::clone(hub)), text) {
			let (hub, link) = (Rc::clone(hub), Rc::clone(link));
			spawn_local(async move {
				let text = answer.await;
				let mark = hub.service.borrow().store.handed();
				link.reply(Reply { mark, id, text, counted: false });
			});
			return;
		}
	}
	let text = {
		let mut hook = hub.hook.borrow_mut();
		let hook = hook.as_mut().expect("the socket exists only with hooks");
		hook(&mut hub.service.borrow_mut(), hub.open.get(), text)
	};
	hub.committed();
	let mark = hub.service.borrow().store.handed();
	link.reply(Reply { mark, id, text, counted: false });
}

/// `parsed`: the frame as JSON, read once for all who look at it.
fn call(hub: &Rc<Hub>, link: &Rc<Link>, conn: &Conn, id: u32, text: &str, parsed: Option<&Json>) {
	let most = hub.o.max_inflight_per_connection;
	if link.inflight.get() >= most {
		let text = format!(r#"{{"ok":false,"error":{{"code":"ResourceExhausted","message":"at most {most} calls at once per connection"}}}}"#);
		link.reply(Reply { mark: 0, id, text, counted: false });
		return;
	}
	if let Some(answer) = link.session.as_ref().zip(parsed).and_then(|(s, c)| Rc::clone(s).later(Owner(Rc::clone(hub)), c)) {
		link.inflight.set(link.inflight.get() + 1);
		let (hub, link) = (Rc::clone(hub), Rc::clone(link));
		spawn_local(async move {
			let text = answer.await;
			let mark = hub.service.borrow().store.handed();
			link.reply(Reply { mark, id, text, counted: true });
		});
		return;
	}
	let answer = link.session.as_ref().zip(parsed).and_then(|(s, c)| s.call(&mut hub.service.borrow_mut(), c));
	if let Some(text) = answer {
		hub.committed();
		let mark = hub.service.borrow().store.handed();
		link.reply(Reply { mark, id, text, counted: false });
		return;
	}
	link.inflight.set(link.inflight.get() + 1);
	let outcome = hub.service.borrow_mut().handle_call(parsed, text.len() as f64, conn, (hub.o.max_frame_bytes - HEADER) as f64);
	let seen = hub.handed.get();
	hub.committed();
	match outcome {
		// A call that has its answer is over, only the disk holds that back. On one thread a burst is handled to its end at
		// once, and what waits for a fsync must not fill the places of the calls that wait for work.
		Outcome::Done { text, mark } => {
			link.inflight.set(link.inflight.get() - 1);
			link.reply(Reply { mark, id, text: link.outgoing(text), counted: false });
		}
		Outcome::Wait(parked) => {
			spawn_local(wait(Rc::clone(hub), Rc::clone(link), id, parked, seen));
		}
	}
}

/// A call that waits: looked at again when the clock or, where the service wakes on commits, a commit gives a reason.
async fn wait(hub: Rc<Hub>, link: Rc<Link>, id: u32, mut parked: Box<Parked>, mut seen: u64) {
	let wakes = hub.service.borrow().options().wake_on_commit;
	let mut last = None; // the first look after the call's own has no gap to keep, as commitSignal
	loop {
		if link.closed.get() { return; }
		let ms = parked.sleep_ms(hub.service.borrow().now(), wakes);
		let pause = sleep(Duration::from_millis(ms.min(MAX_TIMER_MS) as u64));
		if wakes {
			if hub.handed.get() == seen {
				tokio::select! {
					_ = pause => {}
					_ = hub.commits.notified() => {}
					_ = link.closing.notified() => return,
				}
			}
			if let Some(last) = last {
				tokio::time::sleep_until(last + Duration::from_millis(parked.gap_ms() as u64)).await;
			}
		} else {
			tokio::select! {
				_ = pause => {}
				_ = link.closing.notified() => return,
			}
		}
		if link.closed.get() {
			return;
		}
		seen = hub.handed.get();
		last = Some(Instant::now());
		let looked = hub.service.borrow_mut().resume(parked);
		hub.committed();
		match looked {
			Ok((text, mark)) => return link.reply(Reply { mark, id, text: link.outgoing(text), counted: true }),
			Err(p) => parked = p,
		}
	}
}

/// Sends what is durable, in the order the calls ended. Marks of one connection only grow.
async fn replies<W: AsyncWrite + Unpin>(hub: Rc<Hub>, link: Rc<Link>, mut write: W) {
	let mut durable = hub.durable.subscribe();
	let mut out = Vec::with_capacity(16 * 1024);
	loop {
		if link.closed.get() { return; }
		let (mut sent, mut charged) = (0, 0);
		let upto = *durable.borrow_and_update();
		let failed = hub.failed.get();
		// a reply whose commit will not become durable: CommitSealed while a primary's candidate is unresolved
		let lost = if failed { hub.service.borrow().failed_reply() } else { String::new() };
		{
			let mut queue = link.queue.borrow_mut();
			while queue.front().is_some_and(|r| r.mark <= upto || failed) {
				let r = queue.pop_front().expect("looked at");
				sent += 1;
				charged += HEADER + r.text.len();
				put(&mut out, r.id, if r.mark > upto { &lost } else { &r.text });
				if r.counted {
					link.inflight.set(link.inflight.get() - 1);
				}
			}
		}
		if !out.is_empty() {
			let written = tokio::select! {
				biased;
				_ = link.closing.notified() => return,
				r = write.write_all(&out) => r,
			};
			if written.is_err() { return link.close(); }
			link.held_replies.set(link.held_replies.get() - sent);
			link.held_bytes.set(link.held_bytes.get() - charged);
			out.clear();
			link.touch();
			continue;
		}
		if link.closed.get() {
			return;
		}
		tokio::select! {
			_ = link.ready.notified() => {}
			_ = durable.changed() => {}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use phi_service::Options;
	use phi_store::{system_random, Ledger, MemoryLedger, Store};

	fn memory_hub() -> Rc<Hub> {
		let store = Store::open(Ledger::Memory(MemoryLedger::default()), system_random).unwrap();
		Rc::new(Hub { service: RefCell::new(Service::new(store, Options::single_peer("local"))), handed: Cell::new(0), commits: Notify::new(), due: Notify::new(), durable: watch::channel(0).0, failed: Cell::new(false), open: Cell::new(0), stop: Notify::new(), hook: RefCell::new(None), o: ServeOptions::new(Listen::Unix("unused".into()), "local") })
	}

	#[test]
	fn a_listener_outlives_what_one_accept_runs_into() {
		for code in [23, 24, 71, 103, 104, 105, 12] { assert!(passing(&io::Error::from_raw_os_error(code)), "{code}"); }
		for code in [9, 22, 88] { assert!(!passing(&io::Error::from_raw_os_error(code)), "{code}"); }
	}

	#[tokio::test(flavor = "current_thread")]
	async fn the_reply_budget_includes_a_blocked_write_and_closing_cancels_it() {
		tokio::task::LocalSet::new().run_until(async {
			let hub = memory_hub();
			let link = Rc::new(Link::default());
			let (_read, write) = tokio::io::duplex(1);
			link.reply(Reply { mark: 0, id: 0, text: "x".repeat(64 * 1024), counted: false });
			let writer = spawn_local(replies(hub, Rc::clone(&link), write));
			tokio::task::yield_now().await;
			assert!(link.queue.borrow().is_empty(), "the first reply is now held by the blocked writer");
			assert!(link.held_bytes.get() > 0);
			for id in 1..MAX_HELD_REPLIES as u32 {
				link.reply(Reply { mark: 0, id, text: "x".repeat(64 * 1024), counted: false });
				if link.closed.get() { break; }
			}
			assert!(link.closed.get(), "the byte budget closes the connection before the reply-count limit");
			assert!(link.held_bytes.get() <= MAX_HELD_REPLY_BYTES);
			assert!(link.queue.borrow().is_empty());
			timeout(Duration::from_secs(1), writer).await.unwrap().unwrap();
		}).await;
	}
	#[tokio::test(flavor = "current_thread")]
	async fn closing_before_a_parked_task_starts_does_not_lose_its_cancellation() {
		let hub = memory_hub();
		let conn = Conn { peer_id: Some("local".into()), identity: None, proof_key: None };
		let parked = {
			let mut service = hub.service.borrow_mut();
			let Outcome::Done { text, .. } = service.handle_text(r#"{"method":"generation"}"#, &conn, 262136.0) else { panic!("generation waits") };
			let value = phi_json::parse(&text).unwrap();
			let generation = value.get("result").unwrap().get("generation").unwrap().to_json_text();
			let call = format!(r#"{{"method":"take","request":{{"generation":{generation},"requestId":"parked"}},"args":{{"timeoutMs":60000,"waitMs":25000}}}}"#);
			let Outcome::Wait(parked) = service.handle_text(&call, &conn, 262136.0) else { panic!("take did not park") };
			parked
		};
		hub.committed();
		let seen = hub.handed.get();
		let link = Rc::new(Link::default());
		link.close();
		timeout(Duration::from_secs(1), wait(hub, link, 1, parked, seen)).await.unwrap();
	}

}
