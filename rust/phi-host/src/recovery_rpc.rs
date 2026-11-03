//! Out-of-band recovery RPC (src/recovery-service.ts, src/ssh-recovery.ts): a private Unix socket and pinned operator,
//! supervisor and host signatures. A call is a signed envelope valid for at most a minute; a replayed envelope gets the
//! first reply (the handler, with its fencing, snapshot loads and register writes, runs once), a retry signs a new call.
use crate::auth::{to_base64, verify_detached, Algorithm, Signer};
use crate::register::RegisterError;
use phi_json::{digest_json, obj, parse, text, Json};
use std::cell::RefCell;
use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::AsyncWriteExt;

const DOMAIN: &str = "phi-spaces/recovery-rpc/v1\n";
const MAX_FRAME: usize = 256 * 1024;
const SUPERVISOR: [&str; 5] = ["restoreDataSpace", "advanceRestore", "restoreStatus", "releaseRestored", "controlAck"];
const MAX_REMEMBERED: usize = 4096;

/// What a recovery step answers when it refuses: `RegisterConflict` (the code `RequestConflict`), or anything else
/// (`RecoveryBlocked` and every other error, the code `PermissionDenied`), with its message.
#[derive(Clone, Debug, PartialEq)]
pub enum RecoveryError {
	Conflict(String),
	Blocked(String),
}
impl RecoveryError {
	pub fn message(&self) -> &str {
		match self {
			RecoveryError::Conflict(m) | RecoveryError::Blocked(m) => m,
		}
	}
}
impl std::fmt::Display for RecoveryError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message()) }
}
impl From<RegisterError> for RecoveryError {
	fn from(e: RegisterError) -> Self {
		match e {
			RegisterError::Conflict(m) => RecoveryError::Conflict(m),
			RegisterError::Failed(m) => RecoveryError::Blocked(m),
		}
	}
}
impl From<phi_core::CoreError> for RecoveryError {
	fn from(e: phi_core::CoreError) -> Self {
		if e.class == "RegisterConflict" { RecoveryError::Conflict(e.message) } else { RecoveryError::Blocked(e.message) }
	}
}
pub type RR<T> = Result<T, RecoveryError>;
pub fn blocked(m: impl Into<String>) -> RecoveryError { RecoveryError::Blocked(m.into()) }
pub fn conflict(m: impl Into<String>) -> RecoveryError { RecoveryError::Conflict(m.into()) }

/// The bytes a recovery call is signed over (test/vectors/replication.json `recoveryCall`).
pub fn recovery_bytes(call: &Json) -> Vec<u8> { format!("{DOMAIN}{}", call.canonical().expect("a call is parsed JSON")).into_bytes() }

pub fn now_ms() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_millis() as f64) }

/// A pinned public key: the operator's, the supervisor's, a host's.
#[derive(Clone, Debug, PartialEq)]
pub struct KeyPin {
	pub algorithm: Algorithm,
	pub public_key: String,
}
impl KeyPin {
	pub fn from_json(v: &Json) -> Option<KeyPin> { Some(KeyPin { algorithm: Algorithm::parse(text(v, "algorithm")?)?, public_key: text(v, "publicKey")?.to_owned() }) }
	pub fn of(signer: &Signer, public_key: &str) -> KeyPin { KeyPin { algorithm: signer.algorithm(), public_key: public_key.to_owned() } }
	fn verifies(&self, algorithm: &str, message: &[u8], signature: &str) -> bool { algorithm == self.algorithm.name() && verify_detached(self.algorithm, &self.public_key, message, signature) }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
	Operator,
	Supervisor,
	Host,
}

pub type Fut<T> = Pin<Box<dyn Future<Output = T>>>;
/// Reads a provisioned snapshot by its reference.
pub type LoadSnapshot = Rc<dyn Fn(&str) -> RR<Json>>;
/// The key a host signs `controlAck` with, from the call's arguments.
pub type HostKeyOf = Rc<dyn Fn(Json) -> Fut<RR<Option<KeyPin>>>>;
/// What a host does with a verified call.
pub type RecoveryHandler = Rc<dyn Fn(Json, Role) -> Fut<RR<Json>>>;

pub struct RecoveryServe {
	pub path: std::path::PathBuf,
	pub host_id: String,
	pub operator: KeyPin,
	/// The control supervisor's key, read when a call asks for it (only for the methods a supervisor may call).
	pub supervisor: Option<Rc<dyn Fn() -> Fut<RR<KeyPin>>>>,
	/// A Member host's key for `controlAck`, from the call's arguments.
	pub host_key: Option<HostKeyOf>,
	pub handle: RecoveryHandler,
	pub now: Rc<dyn Fn() -> f64>,
}

fn safe_integer(v: Option<&Json>) -> Option<f64> { v.and_then(Json::as_f64).filter(|n| phi_json::safe_integer(*n)) }

/// Serves the recovery endpoint at its socket: the directory must be private to this user.
pub async fn serve_recovery(o: RecoveryServe) -> std::io::Result<phi_wire::texts::TextServer> {
	use std::os::unix::fs::{DirBuilderExt, MetadataExt};
	let dir = o.path.parent().unwrap_or(std::path::Path::new("/"));
	std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
	let parent = std::fs::symlink_metadata(dir)?;
	if !parent.is_dir() || parent.file_type().is_symlink() || parent.mode() & 0o077 != 0 {
		return Err(std::io::Error::other("recovery socket directory must be private"));
	}
	let listen = phi_wire::Listen::Unix(o.path.clone());
	let replies: Replies = Rc::new(RefCell::new(HashMap::new()));
	let o = Rc::new(o);
	let handle: phi_wire::texts::TextHandle = Rc::new(move |text| {
		let (o, replies) = (Rc::clone(&o), Rc::clone(&replies));
		Box::pin(async move { answer(&o, &replies, &text).await.unwrap_or_else(|e| refusal(&e)) })
	});
	phi_wire::texts::serve_texts(phi_wire::texts::TextServe { listen, max_frame_bytes: MAX_FRAME, max_connections: 8, max_inflight: 4, idle_ms: 5 * 60_000 }, handle).await
}

type Replies = Rc<RefCell<HashMap<String, (f64, tokio::sync::watch::Receiver<Option<String>>)>>>;

fn refusal(e: &RecoveryError) -> String {
	let code = match e { RecoveryError::Conflict(_) => "RequestConflict", RecoveryError::Blocked(_) => "PermissionDenied" };
	obj! { "ok" => false, "error" => obj! { "code" => code, "message" => e.message() } }.to_json_text()
}

async fn answer(o: &RecoveryServe, replies: &Replies, text_: &str) -> RR<String> {
	let signed = parse(text_).map_err(|e| blocked(e.to_string()))?;
	let c = signed.get("call").cloned().unwrap_or(Json::Null);
	let now = (o.now)();
	let request_id = text(&c, "requestId").filter(|r| !r.is_empty() && r.encode_utf16().count() <= 256);
	let (issued, expires) = (safe_integer(c.get("issuedAt")), safe_integer(c.get("expiresAt")));
	let window = matches!((issued, expires), (Some(i), Some(e)) if e > i && e - i <= 60_000.0 && i <= now + 2000.0 && now + 2000.0 < e);
	if c.as_object().is_none() || text(&c, "hostId") != Some(o.host_id.as_str()) || request_id.is_none() || text(&c, "method").is_none() || !window {
		return Err(blocked("invalid recovery target, request identity or validity window"));
	}
	let method = text(&c, "method").expect("checked");
	let (algorithm, signature) = (text(&signed, "algorithm").unwrap_or(""), text(&signed, "signature").unwrap_or(""));
	let bytes = recovery_bytes(&c);
	let mut role = None;
	if o.operator.verifies(algorithm, &bytes, signature) {
		role = Some(Role::Operator);
	} else if let (Some(supervisor), true) = (&o.supervisor, SUPERVISOR.contains(&method)) {
		if supervisor().await?.verifies(algorithm, &bytes, signature) {
			role = Some(Role::Supervisor);
		}
	}
	if role.is_none() && method == "controlAck" {
		if let Some(host_key) = &o.host_key {
			if host_key(c.get("args").cloned().unwrap_or(Json::Null)).await?.is_some_and(|k| k.verifies(algorithm, &bytes, signature)) {
				role = Some(Role::Host);
			}
		}
	}
	let Some(role) = role else { return Err(blocked("recovery signature or method is not authorized")) };
	let key = digest_json(&Json::Array(vec![algorithm.into(), signature.into(), c.clone()])).expect("parsed JSON is finite");
	let mut waiting = {
		let mut table = replies.borrow_mut();
		table.retain(|_, (expires_at, _)| *expires_at > now);
		match table.get(&key) {
			Some((_, rx)) => rx.clone(),
			None => {
				if table.len() >= MAX_REMEMBERED {
					return Err(blocked("too many recovery calls in the validity window"));
				}
				let (tx, rx) = tokio::sync::watch::channel(None);
				table.insert(key, (expires.expect("checked"), rx.clone()));
				let reply = (o.handle)(c.clone(), role);
				tokio::task::spawn_local(async move {
					let r = match reply.await {
						Ok(result) => obj! { "ok" => true, "result" => result }.to_json_text(),
						Err(e) => refusal(&e),
					};
					let _ = tx.send(Some(r));
				});
				rx
			}
		}
	};
	let reply = waiting.wait_for(Option::is_some).await.map_err(|_| blocked("recovery handler ended without a reply"))?.clone();
	Ok(reply.expect("waited for"))
}

/// How a client reaches a recovery endpoint: its socket, or a provisioned ssh forced command (`sshRecoveryTransport`).
#[derive(Clone, Debug)]
pub enum RecoveryLine {
	Socket(std::path::PathBuf),
	Ssh(String),
}

/// `RecoveryClient`: signs each call for `host_id` with `signer` and answers its result or its refusal.
pub struct RecoveryClient {
	pub line: RecoveryLine,
	pub host_id: String,
	pub signer: Rc<Signer>,
	pub timeout_ms: u64,
	pub now: Rc<dyn Fn() -> f64>,
}
impl RecoveryClient {
	pub fn new(line: RecoveryLine, host_id: &str, signer: Rc<Signer>) -> RecoveryClient { RecoveryClient { line, host_id: host_id.to_owned(), signer, timeout_ms: 10_000, now: Rc::new(now_ms) } }
	pub async fn call(&self, method: &str, args: Json, request_id: Option<&str>) -> RR<Json> {
		let now = (self.now)();
		let request_id = request_id.map_or_else(|| phi_store::store::random_uuid(&mut phi_store::store::system_random()), str::to_owned);
		let call = obj! { "hostId" => self.host_id.as_str(), "requestId" => request_id, "method" => method, "args" => args, "issuedAt" => now, "expiresAt" => now + 60_000.0 };
		let envelope = obj! { "call" => call.clone(), "algorithm" => self.signer.algorithm().name(), "signature" => to_base64(&self.signer.sign(&recovery_bytes(&call))) };
		let text_ = envelope.to_json_text();
		let exchange = async {
			match &self.line {
				RecoveryLine::Socket(path) => over_socket(path, &text_).await,
				RecoveryLine::Ssh(target) => over_ssh(target, &text_, self.timeout_ms).await,
			}
		};
		let raw = tokio::time::timeout(Duration::from_millis(self.timeout_ms), exchange).await.map_err(|_| blocked("recovery endpoint timed out; query the same recovery id"))??;
		let reply = parse(&raw).map_err(|e| blocked(e.to_string()))?;
		if reply.get("ok") == Some(&Json::Bool(true)) {
			return Ok(reply.get("result").cloned().unwrap_or(Json::Null));
		}
		let error = reply.get("error").cloned().unwrap_or(Json::Null);
		let message = text(&error, "message").unwrap_or("recovery endpoint refused the request").to_owned();
		Err(if text(&error, "code") == Some("RequestConflict") { conflict(message) } else { blocked(message) })
	}
}

async fn over_socket(path: &std::path::Path, text_: &str) -> RR<String> {
	if text_.len() + 8 > MAX_FRAME {
		return Err(blocked("request exceeds maxFrameBytes"));
	}
	let mut s = tokio::net::UnixStream::connect(path).await.map_err(|e| blocked(e.to_string()))?;
	let mut out = Vec::new();
	phi_wire::put(&mut out, 1, text_);
	s.write_all(&out).await.map_err(|e| blocked(e.to_string()))?;
	let body = phi_wire::read_frame(&mut s).await.map_err(|e| blocked(e.to_string()))?;
	Ok(String::from_utf8_lossy(&body).into_owned())
}

async fn over_ssh(target: &str, text_: &str, timeout_ms: u64) -> RR<String> {
	if !ssh_target(target) {
		return Err(blocked("invalid recovery SSH target"));
	}
	if text_.len() > MAX_FRAME {
		return Err(blocked("recovery transport is closed or request exceeds budget"));
	}
	let out = run_ssh(target, "phi-spaces-recovery", text_.as_bytes().to_vec(), timeout_ms, MAX_FRAME).await.map_err(|e| blocked(e.replace("SSH command", "recovery forced command")))?;
	Ok(String::from_utf8_lossy(&out).into_owned())
}

/// A provisioned ssh target: `user@host` and the like, never an option.
pub fn ssh_target(target: &str) -> bool { !target.is_empty() && !target.starts_with('-') && target.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.@:-".contains(&b)) }

/// `ssh -T -oBatchMode=yes -oStrictHostKeyChecking=yes TARGET COMMAND` with `input` on its stdin: its stdout, if it
/// exits 0 within `timeout_ms` and says at most `max_out` bytes. Runs on a thread of its own.
pub async fn run_ssh(target: &str, command: &str, input: Vec<u8>, timeout_ms: u64, max_out: usize) -> Result<Vec<u8>, String> {
	use std::io::{Read, Write};
	use std::process::{Command, Stdio};
	let mut child = Command::new("ssh").args(["-T", "-oBatchMode=yes", "-oStrictHostKeyChecking=yes", target, command]).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
	let (mut stdin, mut stdout) = (child.stdin.take().expect("piped"), child.stdout.take().expect("piped"));
	let child = std::sync::Arc::new(std::sync::Mutex::new(child));
	let (tx, rx) = tokio::sync::oneshot::channel();
	let waited = std::sync::Arc::clone(&child);
	std::thread::spawn(move || {
		let _ = stdin.write_all(&input);
		drop(stdin);
		let mut out = Vec::new();
		let mut chunk = [0u8; 16 * 1024];
		let r = loop {
			match stdout.read(&mut chunk) {
				Ok(0) => break Ok(()),
				Ok(n) => {
					out.extend_from_slice(&chunk[..n]);
					if out.len() > max_out {
						break Err("response exceeds budget".to_owned());
					}
				}
				Err(e) => break Err(e.to_string()),
			}
		};
		let code = r.and_then(|()| waited.lock().expect("child").wait().map_err(|e| e.to_string()));
		let _ = tx.send(code.and_then(|c| if c.success() { Ok(out) } else { Err("SSH command failed".to_owned()) }));
	});
	match tokio::time::timeout(Duration::from_millis(timeout_ms), rx).await {
		Ok(Ok(r)) => r,
		Ok(Err(_)) => Err("SSH command failed".to_owned()),
		Err(_) => {
			let _ = child.lock().expect("child").kill();
			Err("SSH command timed out".to_owned())
		}
	}
}
