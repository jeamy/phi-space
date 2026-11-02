//! The signed replica-sync transport between a primary and its standby (src/replica-transport.ts, plan 3.2/3.5). Every
//! request and answer is signed with the host's enrolled key under its own domain tag and checked against the pinned key
//! of the other host; an answer is bound to the request's nonce, so an ACK cannot be replayed onto another request. The
//! transport authenticates the peer; the journal still decides (configuration, chain, permits) and stays idempotent.
use crate::auth::{to_base64, verify_detached, Algorithm, Signer};
use phi_json::{digest_json, obj, parse, Json};
use phi_store::primary::SyncPeer;
use phi_store::sync::{SyncError, SyncJournal};
use std::collections::{HashMap, HashSet};
use std::future::Future;
use std::io::{Read, Write};
use std::net::{IpAddr, SocketAddr, TcpStream};
use std::pin::Pin;
use std::rc::Rc;
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

const REQUEST: &str = "phi-spaces/replica-sync/v1/request\n";
const RESPONSE: &str = "phi-spaces/replica-sync/v1/response\n";
/// A frame's header: its length and its id, both u32 big-endian.
const HEADER: usize = 8;
/// What a replica frame may hold, on both sides (`maxFrameBytes: 1 << 20` of src/sync-spaces.ts).
pub const MAX_FRAME_BYTES: usize = 1 << 20;
/// How long the primary waits for the standby's answer to one entry (`STANDBY_ANSWER_MS`); beyond it the commit counts as
/// not confirmed and the resolver takes over, instead of every write hanging for the life of a cut connection.
pub const STANDBY_ANSWER_MS: u64 = 15_000;
pub const CONNECT_MS: u64 = 8_000;
/// A replica listener serves this many connections at once.
pub const MAX_CONNECTIONS: usize = 4;
const IDLE_MS: u64 = 5 * 60_000;

/// The pinned key of the other replica.
#[derive(Clone, Debug, PartialEq)]
pub struct ReplicaPin {
	pub host_id: String,
	pub algorithm: Algorithm,
	pub public_key: String,
}
impl ReplicaPin {
	/// `{hostId, algorithm, publicKey}`.
	pub fn from_json(v: &Json) -> Option<ReplicaPin> {
		Some(ReplicaPin { host_id: v.get("hostId")?.as_str()?.to_owned(), algorithm: Algorithm::parse(v.get("algorithm")?.as_str()?)?, public_key: v.get("publicKey")?.as_str()?.to_owned() })
	}
}

/// Why a call to the other replica did not give its result.
#[derive(Debug, Clone, PartialEq)]
pub enum ReplicaError {
	/// `ReplicaTransportRefused`, or the line failed: the answer is not the other replica's, or there is none.
	Transport(String),
	/// `StandbyRefused`: the other replica answered with a signed refusal, which may be passing (its register unreachable).
	Refused(String),
}
impl std::fmt::Display for ReplicaError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { match self { ReplicaError::Transport(m) | ReplicaError::Refused(m) => f.write_str(m) } }
}
const UNAUTHENTICATED_RESPONSE: &str = "unauthenticated replica response";

fn signed_text(domain: &str, v: &Json) -> Option<String> { Some(format!("{domain}{}", v.canonical().ok()?)) }
fn sign(domain: &str, value: Json, signer: &Signer) -> Json {
	let text = signed_text(domain, &value).expect("a signed value is parsed JSON");
	obj! { "value" => value, "signature" => to_base64(&signer.sign(text.as_bytes())) }
}
fn verify(domain: &str, s: &Json, pin: &ReplicaPin) -> bool {
	let (Some(value), Some(signature)) = (s.get("value"), s.get("signature").and_then(Json::as_str)) else { return false };
	signed_text(domain, value).is_some_and(|t| verify_detached(pin.algorithm, &pin.public_key, t.as_bytes(), signature))
}
fn digest(v: &Json) -> String { digest_json(v).unwrap_or_default() }
fn str_of<'a>(v: &'a Json, key: &str) -> Option<&'a str> { v.get(key).and_then(Json::as_str) }
fn nonce() -> String {
	let mut n = [0u8; 16];
	getrandom::getrandom(&mut n).expect("the system gives random bytes");
	n.iter().map(|b| format!("{b:02x}")).collect()
}

/// One request and its answer over some line (`Transport` of src/remote.ts).
pub trait Transport: Send {
	fn request(&mut self, text: &str) -> Result<String, String>;
}

/// Client side: the signed counterpart of a `PrimarySyncPeer` and `StandbyTarget` (`signedReplicaPeer`).
pub struct SignedReplicaPeer {
	pub transport: Box<dyn Transport>,
	pub signer: Signer,
	pub self_id: String,
	pub remote: ReplicaPin,
	pub now: Box<dyn FnMut() -> f64 + Send>,
}
impl SignedReplicaPeer {
	fn call(&mut self, method: &str, body: &Json) -> Result<Json, ReplicaError> {
		let req = obj! { "from" => self.self_id.as_str(), "to" => self.remote.host_id.as_str(), "method" => method, "nonce" => nonce(), "ts" => (self.now)().floor(), "bodyHash" => digest(body) };
		let nonce = str_of(&req, "nonce").unwrap_or_default().to_owned();
		let text = obj! { "request" => sign(REQUEST, req, &self.signer), "body" => body.clone() }.to_json_text();
		let reply = self.transport.request(&text).map_err(ReplicaError::Transport)?;
		let reply = parse(&reply).map_err(|_| ReplicaError::Transport(UNAUTHENTICATED_RESPONSE.into()))?;
		let v = reply.get("value").cloned().unwrap_or(Json::Null);
		let bound = str_of(&v, "from") == Some(&self.remote.host_id) && str_of(&v, "to") == Some(&self.self_id) && str_of(&v, "nonce") == Some(&nonce) && str_of(&v, "method") == Some(method);
		if !verify(RESPONSE, &reply, &self.remote) || !bound {
			return Err(ReplicaError::Transport(UNAUTHENTICATED_RESPONSE.into()));
		}
		if v.get("ok") != Some(&Json::Bool(true)) {
			let error = match v.get("error") { Some(Json::String(s)) => s.clone(), Some(e) => e.to_json_text(), None => "undefined".into() };
			return Err(ReplicaError::Refused(format!("standby refused: {}", error.chars().take(200).collect::<String>())));
		}
		Ok(v.get("result").cloned().unwrap_or(Json::Null))
	}
	pub fn head(&mut self) -> Result<Json, ReplicaError> { self.call("head", &Json::Null) }
	pub fn accept(&mut self, intent: &Json) -> Result<Json, ReplicaError> { self.call("accept", intent) }
	pub fn catch_up(&mut self, intent: &Json) -> Result<Json, ReplicaError> { self.call("catchUp", intent) }
}
/// The primary's writer waits on the standby through this; any failure leaves the entry sealed and not confirmed.
impl SyncPeer for SignedReplicaPeer {
	fn accept(&mut self, intent: &Json) -> phi_store::sync::Result<Json> { SignedReplicaPeer::accept(self, intent).map_err(|e| SyncError::Blocked(e.to_string())) }
}

/// Server side for a replica journal (`replicaSyncHandler`): verifies the pinned sender, a fresh timestamp and an unused
/// nonce; then the journal decides. Its refusals are signed answers too, so the caller can tell a refusal from a forged
/// reply. A request it does not take is refused unsigned (`Err`), which the line answers as an internal error.
pub struct ReplicaSyncHandler {
	pub signer: Signer,
	pub self_id: String,
	pub remotes: Vec<ReplicaPin>,
	pub window_ms: f64,
	seen: HashMap<String, f64>,
}
impl ReplicaSyncHandler {
	pub fn new(signer: Signer, self_id: &str, remotes: Vec<ReplicaPin>) -> ReplicaSyncHandler {
		ReplicaSyncHandler { signer, self_id: self_id.to_owned(), remotes, window_ms: 60_000.0, seen: HashMap::new() }
	}
	/// The request's method and body, once it is authentic, fresh and new; `answer` then signs the journal's result.
	pub fn admit(&mut self, text: &str, now: f64) -> Result<Admitted, String> {
		let q = parse(text).map_err(|_| "unauthenticated replica request".to_owned())?;
		let signed = q.get("request").cloned().unwrap_or(Json::Null);
		let req = signed.get("value").cloned().unwrap_or(Json::Null);
		let pin = self.remotes.iter().find(|p| str_of(&req, "from") == Some(p.host_id.as_str()));
		if req.as_object().is_none() || str_of(&req, "to") != Some(&self.self_id) || !pin.is_some_and(|p| verify(REQUEST, &signed, p)) {
			return Err("unauthenticated replica request".into());
		}
		let body = q.get("body").cloned().unwrap_or(Json::Null);
		let ts = req.get("ts").and_then(Json::as_f64);
		let fresh = ts.is_some_and(|t| t.fract() == 0.0 && t.abs() <= 9_007_199_254_740_991.0 && (now - t).abs() <= self.window_ms);
		let nonce = str_of(&req, "nonce").filter(|n| n.len() == 32 && n.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
		let (Some(nonce), true) = (nonce, fresh && str_of(&req, "bodyHash") == Some(digest(&body).as_str())) else { return Err("stale or altered replica request".into()) };
		let window = self.window_ms;
		self.seen.retain(|_, at| now - *at <= 2.0 * window);
		if self.seen.contains_key(nonce) {
			return Err("replayed replica request".into());
		}
		self.seen.insert(nonce.to_owned(), now);
		let method = str_of(&req, "method").map(str::to_owned);
		Ok(Admitted { from: str_of(&req, "from").unwrap_or_default().to_owned(), nonce: nonce.to_owned(), method, body })
	}
	/// The signed answer to an admitted request: its result, or the journal's refusal.
	pub fn answer(&self, a: &Admitted, outcome: Result<Json, String>) -> String {
		let (ok, result, error) = match outcome { Ok(r) => (true, r, Json::Null), Err(e) => (false, Json::Null, Json::String(e)) };
		let method = a.method.clone().map_or(Json::Null, Json::String);
		sign(RESPONSE, obj! { "from" => self.self_id.as_str(), "to" => a.from.as_str(), "nonce" => a.nonce.as_str(), "method" => method, "ok" => ok, "result" => result, "error" => error }, &self.signer).to_json_text()
	}
}
/// An authentic request: what it asks of the journal.
pub struct Admitted {
	pub from: String,
	pub nonce: String,
	pub method: Option<String>,
	pub body: Json,
}

/// What a replica's journal answers to an admitted request; `assert_standby` and `assert_quarantine` are the permit checks
/// of `accept` and `catchUp`.
pub fn journal_answer(journal: &mut SyncJournal, a: &Admitted, assert_standby: impl FnOnce(&Json, f64) -> phi_store::sync::Result<()>, assert_quarantine: impl FnOnce() -> phi_store::sync::Result<()>) -> Result<Json, String> {
	let r = match a.method.as_deref() {
		Some("head") => journal.head(),
		Some("accept") => journal.accept(&a.body, assert_standby),
		Some("catchUp") => journal.catch_up(&a.body, assert_quarantine),
		_ => Err(SyncError::Blocked("unknown replica method".into())),
	};
	r.map_err(|e| e.to_string())
}

/// The client's line (`socketTransport` with `localAddress`, `connectTimeoutMs` and `requestTimeoutMs`): one connection,
/// opened when needed from `local`, dropped after any failure; a request that is not answered in time is not repeated.
pub struct SocketTransport {
	pub target: (String, u16),
	pub local: Option<IpAddr>,
	pub connect_ms: u64,
	pub request_ms: u64,
	line: Option<TcpStream>,
	next_id: u32,
}
impl SocketTransport {
	pub fn new(target: (String, u16), local: Option<IpAddr>) -> SocketTransport {
		SocketTransport { target, local, connect_ms: CONNECT_MS, request_ms: STANDBY_ANSWER_MS, line: None, next_id: 1 }
	}
	/// A connection from `local`; std cannot bind before connecting, tokio can, on a runtime of its own off this thread
	/// (the caller may be on a runtime).
	fn connect(&self) -> Result<TcpStream, String> {
		let (target, local, ms) = (self.target.clone(), self.local, self.connect_ms);
		let open = move || -> Result<TcpStream, String> {
			let rt = tokio::runtime::Builder::new_current_thread().enable_io().enable_time().build().map_err(|e| e.to_string())?;
			rt.block_on(async {
				let go = async {
					let to = tokio::net::lookup_host((target.0.as_str(), target.1)).await.map_err(|e| e.to_string())?.next().ok_or("no address")?;
					let socket = if to.is_ipv4() { tokio::net::TcpSocket::new_v4() } else { tokio::net::TcpSocket::new_v6() }.map_err(|e| e.to_string())?;
					if let Some(from) = local {
						socket.bind(SocketAddr::new(from, 0)).map_err(|e| e.to_string())?;
					}
					let s = socket.connect(to).await.map_err(|e| e.to_string())?;
					s.into_std().map_err(|e| e.to_string())
				};
				tokio::time::timeout(Duration::from_millis(ms), go).await.map_err(|_| "connect timed out".to_owned())?
			})
		};
		let s = std::thread::spawn(open).join().map_err(|_| "connect failed".to_owned())??;
		s.set_nonblocking(false).map_err(|e| e.to_string())?;
		s.set_nodelay(true).map_err(|e| e.to_string())?;
		Ok(s)
	}
	fn exchange(s: &mut TcpStream, id: u32, text: &str, deadline: Instant) -> Result<String, String> {
		let mut out = Vec::with_capacity(HEADER + text.len());
		phi_wire::put(&mut out, id, text);
		s.set_write_timeout(Some(deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(1)))).map_err(|e| e.to_string())?;
		s.write_all(&out).map_err(|e| e.to_string())?;
		loop {
			let mut head = [0u8; HEADER];
			read_by(s, &mut head, deadline)?;
			let n = u32::from_be_bytes(head[..4].try_into().expect("four bytes")) as usize;
			if n + HEADER > MAX_FRAME_BYTES {
				return Err("a frame over the limit".into());
			}
			let mut body = vec![0u8; n];
			read_by(s, &mut body, deadline)?;
			// an answer to an earlier request that timed out is not this one's
			if u32::from_be_bytes(head[4..].try_into().expect("four bytes")) == id {
				return String::from_utf8(body).map_err(|_| "an answer that is not text".to_owned());
			}
		}
	}
}
fn read_by(s: &mut TcpStream, buf: &mut [u8], deadline: Instant) -> Result<(), String> {
	let mut at = 0;
	while at < buf.len() {
		let left = deadline.saturating_duration_since(Instant::now());
		if left.is_zero() {
			return Err("request timed out".into());
		}
		s.set_read_timeout(Some(left)).map_err(|e| e.to_string())?;
		match s.read(&mut buf[at..]) {
			Ok(0) => return Err("connection lost".into()),
			Ok(n) => at += n,
			Err(e) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => return Err("request timed out".into()),
			Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
			Err(e) => return Err(e.to_string()),
		}
	}
	Ok(())
}
impl Transport for SocketTransport {
	fn request(&mut self, text: &str) -> Result<String, String> {
		if text.len() + HEADER > MAX_FRAME_BYTES {
			return Err("request exceeds maxFrameBytes".into());
		}
		let mut s = match self.line.take() { Some(s) => s, None => self.connect()? };
		let id = self.next_id;
		self.next_id = if self.next_id == u32::MAX { 1 } else { self.next_id + 1 }; // 0 is none
		let r = SocketTransport::exchange(&mut s, id, text, Instant::now() + Duration::from_millis(self.request_ms));
		if r.is_ok() {
			self.line = Some(s);
		}
		r
	}
}

/// What a replica listener does with one request text: the signed answer, or `Err` for one it does not take.
pub type Handle = Rc<dyn Fn(String) -> Pin<Box<dyn Future<Output = Result<String, String>>>>>;
const INTERNAL: &str = r#"{"ok":false,"error":{"code":"Internal","message":"internal error"}}"#;

/// The replica listener (`serveSpace` with `maxConnections: 4`, `maxFrameBytes: 1 << 20` and the peers' addresses as
/// its connection filter): a connection from another address is closed unanswered; a request the handler does not take
/// is answered as an internal error, as src/socket.ts answers a handler that throws. Runs on a `LocalSet` until dropped.
pub async fn serve_replica(listener: tokio::net::TcpListener, peers: HashSet<IpAddr>, handle: Handle) {
	let open = Rc::new(std::cell::Cell::new(0usize));
	let peers = Rc::new(peers);
	loop {
		let Ok((mut s, from)) = listener.accept().await else { continue };
		let ip = match from.ip() { IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(IpAddr::V6(v6), IpAddr::V4), ip => ip };
		if open.get() >= MAX_CONNECTIONS || !peers.contains(&ip) {
			drop(s);
			continue;
		}
		let _ = s.set_nodelay(true);
		open.set(open.get() + 1);
		let (open, handle) = (Rc::clone(&open), Rc::clone(&handle));
		tokio::task::spawn_local(async move {
			// one request after the other: the journal takes them in order anyway
			loop {
				let mut head = [0u8; HEADER];
				let Ok(Ok(_)) = tokio::time::timeout(Duration::from_millis(IDLE_MS), s.read_exact(&mut head)).await else { break };
				let n = u32::from_be_bytes(head[..4].try_into().expect("four bytes")) as usize;
				let id = u32::from_be_bytes(head[4..].try_into().expect("four bytes"));
				if n + HEADER > MAX_FRAME_BYTES {
					break; // a protocol violation
				}
				let mut body = vec![0u8; n];
				if s.read_exact(&mut body).await.is_err() {
					break;
				}
				let answer = handle(String::from_utf8_lossy(&body).into_owned()).await.unwrap_or_else(|_| INTERNAL.to_owned());
				let mut out = Vec::new();
				phi_wire::put(&mut out, id, &answer);
				if s.write_all(&out).await.is_err() {
					break;
				}
			}
			open.set(open.get() - 1);
		});
	}
}
