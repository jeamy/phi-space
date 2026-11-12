//! The socket transport of the space service, ported from src/socket.ts. Frame: u32 length, u32 call id (big endian), then
//! `length` bytes of UTF-8 JSON. Calls on one connection run concurrently; a reply carries the id of its call. A frame
//! over the limit is a protocol violation and ends the connection.
//!
//! Everything here runs on one thread, the one that owns the store: a call is handled to its end before the next is
//! looked at, and only the disk is another thread. A reply leaves once the store has made durable what it rests on.
pub mod texts;

use phi_service::{Conn, Outcome, Parked, Service};
use std::cell::{Cell, RefCell, RefMut};
use std::collections::{HashMap, VecDeque};
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

pub(crate) const HEADER: usize = 8;
/// The longest a timer runs at once (`core.timerDelay`); what is further off is reached in steps.
const MAX_TIMER_MS: f64 = 2_147_483_647.0;
pub(crate) const ACCEPT_PAUSE_MS: u64 = 100;
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
	/// `unix:/path`, `tcp:host:port` or a bare path: the one parser of the client (space-client.ts parseTarget), so a
	/// server takes exactly the addresses its clients do.
	pub fn parse(spec: &str) -> Result<Listen, String> {
		Ok(match phi_spaces_client::parse_target(spec)? {
			phi_spaces_client::Target::Unix(path) => Listen::Unix(path),
			phi_spaces_client::Target::Tcp { host, port } => Listen::Tcp { host, port },
		})
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
	/// The host's own service.
	pub fn with<T>(&self, f: impl FnOnce(&mut Service) -> T) -> T {
		let out = f(&mut self.0.main.service());
		self.0.main.committed();
		out
	}
	/// Commits handed to the store so far.
	pub fn handed(&self) -> u64 { self.0.main.service().store.handed() }
	/// Resolves after the next commit.
	pub async fn commit(&self) { self.0.main.commits.notified().await }
	/// Resolves once every commit handed to the host's own store so far is durable (`await host.commit`); the answer of
	/// a failed store once it failed.
	pub async fn durable(&self) -> Result<(), String> {
		let main = &self.0.main;
		let handed = main.service().store.handed();
		let mut durable = main.durable.subscribe();
		loop {
			if main.failed.get() || main.gone.get() {
				return Err(main.lost.borrow().clone());
			}
			if *durable.borrow_and_update() >= handed {
				return Ok(());
			}
			if durable.changed().await.is_err() {
				return Err(main.lost.borrow().clone());
			}
		}
	}
	/// Routes the calls that name one of `names` as their `space` (`None`: to the host's own service again). The services it
	/// takes out are given back once what they made durable has left; their stores are the caller's to close.
	pub fn route(&self, names: &[String], to: Option<Route>) -> Vec<Service> { route(&self.0, names, to) }
	/// Resolves once the store of a routed Space has failed (a primary's sealed candidate), or the Space is no longer served.
	pub async fn failed(&self, name: &str) {
		let Some(Space::Served(served)) = self.0.spaces.borrow().get(name).cloned() else { return };
		let mut durable = served.durable.subscribe();
		while !served.failed.get() && !served.gone.get() {
			if durable.changed().await.is_err() { return; }
		}
	}
}

/// Where the calls naming a Space go: its own service over a store of its own, or an answer that stands for it (a
/// primary/sync Space whose sealed candidate is being resolved answers `CommitSealed`).
pub enum Route {
	Served(Box<Service>),
	Answer(Rc<dyn Fn(&Conn) -> String>),
}
#[derive(Clone)]
enum Space {
	Served(Rc<Served>),
	Answer(Rc<dyn Fn(&Conn) -> String>),
}

/// What the test hooks do with a line (`--test-hooks`): the service, how many connections are open, the text.
pub(crate) type Hook = Box<dyn FnMut(&mut Service, usize, &str) -> String>;

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
	/// Spaces with a store of their own, reached by naming one of the names as `space` (`Owner::route`).
	pub spaces: Vec<(Vec<String>, Route)>,
	/// Host work that runs for as long as the server does, on the owner thread.
	pub tasks: Vec<Box<dyn FnOnce(Owner) -> Local<()>>>,
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
		ServeOptions { periodic: vec![], endpoints: vec![Endpoint { listen, peer: Some(peer.to_owned()) }], gates: vec![], hooks: None, spaces: vec![], tasks: vec![], max_frame_bytes: 256 * 1024, max_connections: 64, max_inflight_per_connection: 32, idle_ms: 5 * 60_000, watch_debounce_ms: 20 }
	}
}

/// What all connections of a server share. It stays on the owner thread.
struct Hub {
	main: Rc<Served>,
	spaces: RefCell<HashMap<String, Space>>,
	open: Cell<usize>,
	stop: Notify,
	hook: RefCell<Option<Hook>>,
	o: ServeOptions,
}

/// One store behind the transport and what waits on it: the host's own, or a routed Space's.
struct Served {
	service: RefCell<Option<Service>>,
	/// Commits handed to the store so far, as last seen.
	handed: Cell<u64>,
	commits: Notify,
	due: Notify,
	durable: watch::Sender<u64>,
	/// The store failed: what was not durable by then never will be, and gets `lost`.
	failed: Cell<bool>,
	lost: RefCell<String>,
	/// Taken out of service: its background work is stopped, a waiting call gets `lost`.
	gone: Cell<bool>,
	retired: Notify,
	tasks: RefCell<Vec<tokio::task::JoinHandle<()>>>,
}
impl Served {
	fn new(service: Service) -> Rc<Served> {
		let (durable, handed) = (service.store.durable(), service.store.handed());
		Rc::new(Served { service: RefCell::new(Some(service)), handed: Cell::new(handed), commits: Notify::new(), due: Notify::new(), durable: watch::channel(durable).0, failed: Cell::new(false), lost: RefCell::new(String::new()), gone: Cell::new(false), retired: Notify::new(), tasks: RefCell::new(vec![]) })
	}
	fn service(&self) -> RefMut<'_, Service> { RefMut::map(self.service.borrow_mut(), |s| s.as_mut().expect("a service taken out is not called")) }
	/// After anything that may have committed: long polls look again, due work is asked for, a store in memory is durable.
	fn committed(&self) {
		if self.gone.get() { return; }
		let mut service = self.service();
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
				*self.lost.borrow_mut() = service.failed_reply();
				self.durable.send_modify(|_| ()); // once: a writer looks at `failed` on every turn
			}
		}
		let durable = service.store.durable();
		self.durable.send_if_modified(|d| std::mem::replace(d, durable) != durable);
	}
}

/// Its durable marks reach the writers, and its reaper and delivery run.
fn start_served(served: &Rc<Served>, debounce_ms: u64) {
	let wake = Arc::new(Notify::new());
	let woken = Arc::clone(&wake);
	served.service().store.set_waker(Arc::new(move || woken.notify_one()));
	let s = Rc::clone(served);
	let waker = spawn_local(async move {
		loop {
			wake.notified().await;
			if s.gone.get() { return; }
			s.take_durable(&mut s.service());
		}
	});
	let background = spawn_local(background(Rc::clone(served), debounce_ms));
	served.tasks.borrow_mut().extend([waker, background]);
}

/// Takes a Space's store out of service: what it made durable leaves first; its tasks stop.
fn retire(served: &Rc<Served>) -> Option<Service> {
	if served.gone.get() { return None; }
	{
		let mut service = served.service();
		let _ = service.store.drain();
		served.take_durable(&mut service);
	}
	served.gone.set(true);
	served.tasks.borrow_mut().drain(..).for_each(|t| t.abort());
	if !served.failed.get() {
		// what was not durable by now is not, as for a failed store
		served.failed.set(true);
		*served.lost.borrow_mut() = served.service().failed_reply();
	}
	served.durable.send_modify(|_| ());
	served.retired.notify_waiters();
	served.service.borrow_mut().take()
}

fn route(hub: &Rc<Hub>, names: &[String], to: Option<Route>) -> Vec<Service> {
	let mut spaces = hub.spaces.borrow_mut();
	let old: Vec<Rc<Served>> = names.iter().filter_map(|n| spaces.remove(n)).filter_map(|s| match s { Space::Served(s) => Some(s), Space::Answer(_) => None }).collect();
	let next = to.map(|to| match to {
		Route::Served(service) => {
			let served = Served::new(*service);
			start_served(&served, hub.o.watch_debounce_ms);
			Space::Served(served)
		}
		Route::Answer(f) => Space::Answer(f),
	});
	if let Some(next) = next {
		for n in names { spaces.insert(n.clone(), next.clone()); }
	}
	drop(spaces);
	let mut out = vec![];
	for s in old {
		if hub.spaces.borrow().values().any(|v| matches!(v, Space::Served(o) if Rc::ptr_eq(o, &s))) { continue; }
		if let Some(service) = retire(&s) { out.push(service); }
	}
	out
}

struct Reply {
	/// The store it rests on, and its commits there.
	served: Rc<Served>,
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
	let main = Rc::try_unwrap(hub.main).map_err(|_| io::Error::other("a task outlived the server"))?;
	Ok(main.service.into_inner().expect("the host's own service is never taken out"))
}

async fn serve_here(service: Service, mut o: ServeOptions, ready: impl FnOnce(Vec<String>), stop: impl Future<Output = ()>) -> io::Result<Rc<Hub>> {
	assert!(o.max_frame_bytes >= 256, "maxFrameBytes must be at least 256");
	let periodic = std::mem::take(&mut o.periodic);
	let (spaces, tasks) = (std::mem::take(&mut o.spaces), std::mem::take(&mut o.tasks));
	let (hooks, hook) = o.hooks.take().map_or((None, None), |(path, hook)| (Some(path), Some(hook)));
	let hub = Rc::new(Hub { main: Served::new(service), spaces: RefCell::new(HashMap::new()), open: Cell::new(0), stop: Notify::new(), hook: RefCell::new(hook), o });
	start_served(&hub.main, hub.o.watch_debounce_ms);
	for (names, to) in spaces {
		route(&hub, &names, Some(to));
	}
	let mut running = vec![];
	for mut p in periodic {
		let hub = Rc::clone(&hub);
		running.push(spawn_local(async move {
			loop {
				sleep(Duration::from_millis(p.every_ms)).await;
				(p.run)(&mut hub.main.service());
				hub.main.committed();
			}
		}));
	}
	for t in tasks {
		running.push(spawn_local(t(Owner(Rc::clone(&hub)))));
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
	running.iter().for_each(|t| t.abort());
	hub.stop.notify_waiters();
	bound.iter().for_each(|(b, _)| b.close());
	tokio::task::yield_now().await;
	let _ = hub.main.service().store.drain();
	// the routed Spaces' stores are closed here; only the host's own goes back
	let names: Vec<String> = hub.spaces.borrow().keys().cloned().collect();
	for service in route(&hub, &names, None) { service.store.close(); }
	hub.main.tasks.borrow_mut().drain(..).for_each(|t| t.abort());
	tokio::task::yield_now().await;
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
async fn background(served: Rc<Served>, debounce_ms: u64) {
	loop {
		if served.gone.get() { return; }
		let wake = served.service().background();
		served.committed();
		let ms = (wake - served.service().now()).clamp(1.0, MAX_TIMER_MS);
		tokio::select! {
			_ = sleep(Duration::from_millis(ms as u64)) => {}
			_ = served.due.notified() => sleep(Duration::from_millis(debounce_ms)).await,
		}
	}
}

pub(crate) enum Bound {
	Unix(UnixListener, PathBuf, (u64, u64)),
	Tcp(TcpListener, String),
}
impl Bound {
	pub(crate) async fn bind(l: &Listen) -> io::Result<Bound> {
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
	pub(crate) fn address(&self) -> String {
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
	pub(crate) fn close(&self) {
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
			spawn_local(replies(Rc::clone(&link), write));
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
				let mark = hub.main.service().store.handed();
				link.reply(Reply { served: Rc::clone(&hub.main), mark, id, text, counted: false });
			});
			return;
		}
	}
	let text = {
		let mut hook = hub.hook.borrow_mut();
		let hook = hook.as_mut().expect("the socket exists only with hooks");
		hook(&mut hub.main.service(), hub.open.get(), text)
	};
	hub.main.committed();
	let mark = hub.main.service().store.handed();
	link.reply(Reply { served: Rc::clone(&hub.main), mark, id, text, counted: false });
}

/// `parsed`: the frame as JSON, read once for all who look at it.
fn call(hub: &Rc<Hub>, link: &Rc<Link>, conn: &Conn, id: u32, text: &str, parsed: Option<&Json>) {
	let most = hub.o.max_inflight_per_connection;
	if link.inflight.get() >= most {
		let text = format!(r#"{{"ok":false,"error":{{"code":"ResourceExhausted","message":"at most {most} calls at once per connection"}}}}"#);
		link.reply(Reply { served: Rc::clone(&hub.main), mark: 0, id, text, counted: false });
		return;
	}
	if let Some(answer) = link.session.as_ref().zip(parsed).and_then(|(s, c)| Rc::clone(s).later(Owner(Rc::clone(hub)), c)) {
		link.inflight.set(link.inflight.get() + 1);
		let (hub, link) = (Rc::clone(hub), Rc::clone(link));
		spawn_local(async move {
			let text = answer.await;
			let mark = hub.main.service().store.handed();
			link.reply(Reply { served: Rc::clone(&hub.main), mark, id, text, counted: true });
		});
		return;
	}
	let answer = link.session.as_ref().zip(parsed).and_then(|(s, c)| s.call(&mut hub.main.service(), c));
	if let Some(text) = answer {
		hub.main.committed();
		let mark = hub.main.service().store.handed();
		link.reply(Reply { served: Rc::clone(&hub.main), mark, id, text, counted: false });
		return;
	}
	// a Space with a store of its own, named as the call's `space`
	let routed = parsed.and_then(|c| c.get("space")).and_then(Json::as_str).and_then(|n| hub.spaces.borrow().get(n).cloned());
	let served = match routed {
		Some(Space::Answer(f)) => {
			let text = f(conn);
			link.reply(Reply { served: Rc::clone(&hub.main), mark: 0, id, text: link.outgoing(text), counted: false });
			return;
		}
		Some(Space::Served(s)) => s,
		None => Rc::clone(&hub.main),
	};
	link.inflight.set(link.inflight.get() + 1);
	let outcome = served.service().handle_call(parsed, text.len() as f64, conn, (hub.o.max_frame_bytes - HEADER) as f64);
	let seen = served.handed.get();
	served.committed();
	match outcome {
		// A call that has its answer is over, only the disk holds that back. On one thread a burst is handled to its end at
		// once, and what waits for a fsync must not fill the places of the calls that wait for work.
		Outcome::Done { text, mark } => {
			link.inflight.set(link.inflight.get() - 1);
			link.reply(Reply { served, mark, id, text: link.outgoing(text), counted: false });
		}
		Outcome::Wait(parked) => {
			spawn_local(wait(served, Rc::clone(link), id, parked, seen));
		}
	}
}

/// A call that waits: looked at again when the clock or, where the service wakes on commits, a commit gives a reason.
async fn wait(served: Rc<Served>, link: Rc<Link>, id: u32, mut parked: Box<Parked>, mut seen: u64) {
	let wakes = served.service().options().wake_on_commit;
	let mut last = None; // the first look after the call's own has no gap to keep, as commitSignal
	loop {
		if link.closed.get() { return; }
		if served.gone.get() {
			// its store was taken out of service: the call ends with what such a store answers
			let text = served.lost.borrow().clone();
			return link.reply(Reply { served: Rc::clone(&served), mark: 0, id, text: link.outgoing(text), counted: true });
		}
		let ms = parked.sleep_ms(served.service().now(), wakes);
		let pause = || sleep(Duration::from_millis(ms.min(MAX_TIMER_MS) as u64));
		if wakes {
			if served.handed.get() == seen {
				tokio::select! {
					_ = pause() => {}
					_ = served.commits.notified() => {}
					_ = served.retired.notified() => {}
					_ = link.closing.notified() => return,
				}
			}
			if let Some(last) = last {
				tokio::time::sleep_until(last + Duration::from_millis(parked.gap_ms() as u64)).await;
			}
		} else {
			tokio::select! {
				_ = pause() => {}
				_ = served.retired.notified() => {}
				_ = link.closing.notified() => return,
			}
		}
		if link.closed.get() {
			return;
		}
		if served.gone.get() { continue; } // answered at the top
		seen = served.handed.get();
		last = Some(Instant::now());
		let looked = served.service().resume(parked);
		served.committed();
		match looked {
			Ok((text, mark)) => return link.reply(Reply { served, mark, id, text: link.outgoing(text), counted: true }),
			Err(p) => parked = p,
		}
	}
}

/// Sends what is durable, in the order the calls ended. Marks of one connection only grow.
async fn replies<W: AsyncWrite + Unpin>(link: Rc<Link>, mut write: W) {
	let mut out = Vec::with_capacity(16 * 1024);
	loop {
		if link.closed.get() { return; }
		let (mut sent, mut charged) = (0, 0);
		// the store the first reply waits on: a change of its durable mark is looked at below
		let mut durable = link.queue.borrow().front().map(|r| r.served.durable.subscribe());
		{
			let mut queue = link.queue.borrow_mut();
			while let Some(r) = queue.front() {
				let upto = *r.served.durable.borrow();
				// a reply whose commit will not become durable: CommitSealed while a primary's candidate is unresolved
				let failed = r.served.failed.get();
				if r.mark > upto && !failed { break; }
				let r = queue.pop_front().expect("looked at");
				sent += 1;
				charged += HEADER + r.text.len();
				if r.mark > upto { put(&mut out, r.id, &r.served.lost.borrow()); } else { put(&mut out, r.id, &r.text); }
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
		match durable.as_mut() {
			Some(d) => tokio::select! {
				_ = link.ready.notified() => {}
				_ = d.changed() => {}
			},
			None => link.ready.notified().await,
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
		Rc::new(Hub { main: Served::new(Service::new(store, Options::single_peer("local"))), spaces: RefCell::new(HashMap::new()), open: Cell::new(0), stop: Notify::new(), hook: RefCell::new(None), o: ServeOptions::new(Listen::Unix("unused".into()), "local") })
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
			link.reply(Reply { served: Rc::clone(&hub.main), mark: 0, id: 0, text: "x".repeat(64 * 1024), counted: false });
			let writer = spawn_local(replies(Rc::clone(&link), write));
			tokio::task::yield_now().await;
			assert!(link.queue.borrow().is_empty(), "the first reply is now held by the blocked writer");
			assert!(link.held_bytes.get() > 0);
			for id in 1..MAX_HELD_REPLIES as u32 {
				link.reply(Reply { served: Rc::clone(&hub.main), mark: 0, id, text: "x".repeat(64 * 1024), counted: false });
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
			let mut service = hub.main.service();
			let Outcome::Done { text, .. } = service.handle_text(r#"{"method":"generation"}"#, &conn, 262136.0) else { panic!("generation waits") };
			let value = phi_json::parse(&text).unwrap();
			let generation = value.get("result").unwrap().get("generation").unwrap().to_json_text();
			let call = format!(r#"{{"method":"take","request":{{"generation":{generation},"requestId":"parked"}},"args":{{"timeoutMs":60000,"waitMs":25000}}}}"#);
			let Outcome::Wait(parked) = service.handle_text(&call, &conn, 262136.0) else { panic!("take did not park") };
			parked
		};
		hub.main.committed();
		let seen = hub.main.handed.get();
		let link = Rc::new(Link::default());
		link.close();
		timeout(Duration::from_secs(1), wait(Rc::clone(&hub.main), link, 1, parked, seen)).await.unwrap();
	}

}
