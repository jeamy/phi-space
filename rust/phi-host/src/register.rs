//! The independent register (src/recovery-register.ts, src/tls-register.ts, src/erasure-register-policy.ts): compare-and-set
//! records in a SQLite file of their own, over pinned mutual TLS. A certificate reads; only an operator's, or one scoped to
//! the key, writes. Every request is one connection, so no authentication outlives its check.
use crate::tls::{server_name, TlsIdentity};
use phi_json::{hex, obj, parse, Json, Object};
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::cell::{Cell, RefCell};
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream, UnixStream};
use tokio::time::timeout;

const MAX_BYTES: usize = 256 * 1024;
const SAFE: f64 = 9_007_199_254_740_991.0;

#[derive(Clone, Debug, PartialEq)]
pub enum RegisterError {
	/// `RegisterConflict`: another version, or an update the rules refuse.
	Conflict(String),
	Failed(String),
}
impl std::fmt::Display for RegisterError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			RegisterError::Conflict(m) | RegisterError::Failed(m) => f.write_str(m),
		}
	}
}
type R<T> = Result<T, RegisterError>;
fn conflict(m: impl Into<String>) -> RegisterError { RegisterError::Conflict(m.into()) }
fn failed(e: impl std::fmt::Display) -> RegisterError { RegisterError::Failed(e.to_string()) }

fn integer(v: Option<&Json>) -> Option<f64> { v.and_then(Json::as_f64).filter(|n| n.fract() == 0.0 && n.abs() <= SAFE) }
fn digest(v: Option<&Json>) -> bool { v.and_then(Json::as_str).is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))) }
fn text<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }

fn barrier(v: &Json, space: &str) -> R<()> {
	let fine = v.as_object().is_some() && text(v, "spaceId") == Some(space) && integer(v.get("epoch")).is_some_and(|e| e >= 1.0) && matches!(text(v, "state"), Some("pending" | "sealed")) && digest(v.get("commandHash")) && integer(v.get("archiveDeadline")).is_some_and(|d| d >= 0.0) && v.get("archivesPending").and_then(Json::as_bool).is_some();
	if fine { Ok(()) } else { Err(conflict("invalid independent erasure barrier")) }
}

fn catalog(v: &Json, space: &str) -> R<()> {
	let list = v.get("artifacts").and_then(Json::as_array).filter(|a| v.as_object().is_some() && text(v, "spaceId") == Some(space) && a.len() <= 128).ok_or_else(|| conflict("invalid erasure archive catalog"))?;
	let mut ids = HashSet::new();
	for a in list {
		let id = text(a, "id").filter(|i| !i.is_empty() && i.encode_utf16().count() <= 128 && !ids.contains(*i));
		let fine = id.is_some() && digest(a.get("sha256")) && integer(a.get("epoch")).is_some_and(|e| e >= 0.0) && matches!(text(a, "kind"), Some("backup" | "backend-history")) && matches!(text(a, "state"), Some("retained" | "quarantined" | "destroyed")) && a.get("deleteBefore").is_none_or(|d| integer(Some(d)).is_some_and(|n| n >= 0.0));
		let Some(id) = id.filter(|_| fine) else { return Err(conflict("invalid erasure archive binding")) };
		ids.insert(id);
	}
	Ok(())
}

fn artifacts(v: Option<&Json>) -> &[Json] { v.and_then(|c| c.get("artifacts")).and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn number(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn flag(v: &Json, k: &str) -> bool { v.get(k) == Some(&Json::Bool(true)) }
fn rank(a: &Json) -> u8 {
	match text(a, "state") {
		Some("retained") => 0,
		Some("quarantined") => 1,
		_ => 2,
	}
}

/// `validateErasureRegisterUpdate`: operator permission does not lower a floor or bring back a retired archive.
pub fn validate_erasure_update(key: &str, next: &Json, prior: Option<&Json>, read: &dyn Fn(&str) -> R<Option<Json>>) -> R<()> {
	let space_of = |s: &str| if s.is_empty() || s.encode_utf16().count() > 128 { Err(conflict("invalid erasure space")) } else { Ok(s.to_owned()) };
	if let Some(space) = key.strip_prefix("erasure:") {
		let space = space_of(space)?;
		barrier(next, &space)?;
		match prior {
			Some(p) => {
				barrier(p, &space)?;
				if number(next, "epoch") == number(p, "epoch") {
					let same = next.get("commandHash") == p.get("commandHash") && next.get("archiveDeadline") == p.get("archiveDeadline");
					if !same || (text(p, "state") == Some("sealed") && text(next, "state") != Some("sealed")) || (!flag(p, "archivesPending") && flag(next, "archivesPending")) {
						return Err(conflict("erasure barrier cannot regress or change its binding"));
					}
				} else if number(next, "epoch") != number(p, "epoch") + 1.0 || text(p, "state") != Some("sealed") || flag(p, "archivesPending") || text(next, "state") != Some("pending") || !flag(next, "archivesPending") || next.get("commandHash") == p.get("commandHash") {
					return Err(conflict("erasure epoch requires completed preceding deletion and archives"));
				}
			}
			None if number(next, "epoch") != 1.0 || text(next, "state") != Some("pending") || !flag(next, "archivesPending") => return Err(conflict("first erasure epoch must start pending at one")),
			None => {}
		}
		let list = read(&format!("erasure-archives:{space}"))?;
		if let Some(c) = &list {
			catalog(c, &space)?;
		}
		let remaining: Vec<&Json> = artifacts(list.as_ref()).iter().filter(|a| number(a, "epoch") < number(next, "epoch") && text(a, "state") != Some("destroyed")).collect();
		if text(next, "state") == Some("sealed") && (remaining.iter().any(|a| text(a, "state") != Some("quarantined")) || flag(next, "archivesPending") != !remaining.is_empty()) {
			return Err(conflict("erasure seal does not match archive retirement"));
		}
		if text(next, "state") == Some("pending") && !flag(next, "archivesPending") {
			return Err(conflict("pending erasure must retain archive barrier"));
		}
	} else if let Some(space) = key.strip_prefix("erasure-archives:") {
		let space = space_of(space)?;
		catalog(next, &space)?;
		if let Some(p) = prior {
			catalog(p, &space)?;
		}
		let floor = read(&format!("erasure:{space}"))?;
		if let Some(f) = &floor {
			barrier(f, &space)?;
		}
		let mut previous: HashMap<&str, &Json> = artifacts(prior).iter().filter_map(|a| Some((text(a, "id")?, a))).collect();
		for a in artifacts(Some(next)) {
			let Some(old) = text(a, "id").and_then(|id| previous.remove(id)) else {
				let matches_floor = floor.as_ref().map_or(number(a, "epoch") == 0.0, |f| text(f, "state") == Some("sealed") && number(a, "epoch") == number(f, "epoch"));
				if text(a, "state") != Some("retained") || a.get("deleteBefore").is_some() || !matches_floor {
					return Err(conflict("new archive must match completed deletion epoch"));
				}
				continue;
			};
			if old.get("sha256") != a.get("sha256") || old.get("epoch") != a.get("epoch") || old.get("kind") != a.get("kind") || rank(a) < rank(old) || old.get("deleteBefore").is_some_and(|d| a.get("deleteBefore") != Some(d)) {
				return Err(conflict("archive binding or retirement cannot regress"));
			}
			if text(a, "state") == Some("quarantined") && !floor.as_ref().is_some_and(|f| number(a, "epoch") < number(f, "epoch") && a.get("deleteBefore") == f.get("archiveDeadline") && a.get("deleteBefore").is_some()) {
				return Err(conflict("archive quarantine requires current deletion deadline"));
			}
		}
		if !previous.is_empty() {
			return Err(conflict("archive retirement records cannot be removed"));
		}
	}
	Ok(())
}

fn record(version: f64, value: Json) -> Json { obj! { "version" => version, "value" => value } }

pub fn validate_read_keys(keys: &[String]) -> R<()> {
	let unique = keys.iter().collect::<HashSet<_>>().len() == keys.len();
	if keys.is_empty() || keys.len() > 32 || !unique || keys.iter().any(|k| k.is_empty() || k.encode_utf16().count() > 512) {
		return Err(conflict("invalid bounded register read keys"));
	}
	Ok(())
}

/// `SqliteRecoveryRegister`, on the same file format. Deploy it outside host and Space snapshots.
pub struct SqliteRegister {
	db: Connection,
}

impl SqliteRegister {
	pub fn open(path: &Path) -> R<SqliteRegister> {
		use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
		if let Some(dir) = path.parent() {
			std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir).map_err(failed)?;
		}
		if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
			return Err(failed("register must not be a symlink"));
		}
		let db = Connection::open(path).map_err(failed)?;
		std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(failed)?;
		db.busy_timeout(Duration::from_secs(5)).map_err(failed)?;
		db.execute_batch("PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS records (key TEXT PRIMARY KEY, version INTEGER NOT NULL, value TEXT NOT NULL)").map_err(failed)?;
		Ok(SqliteRegister { db })
	}

	fn row(&self, key: &str) -> R<Option<(f64, Json)>> {
		let row: Option<(i64, String)> = self.db.query_row("SELECT version,value FROM records WHERE key=?", [key], |r| Ok((r.get(0)?, r.get(1)?))).optional().map_err(failed)?;
		row.map(|(v, text)| Ok((v as f64, parse(&text).map_err(failed)?))).transpose()
	}

	pub fn get(&self, key: &str) -> R<Json> { Ok(self.row(key)?.map_or(Json::Null, |(v, value)| record(v, value))) }

	pub fn get_many(&self, keys: &[String]) -> R<Json> {
		validate_read_keys(keys)?;
		self.db.execute_batch("BEGIN").map_err(failed)?;
		let mut out = Object::new();
		for k in keys {
			match self.get(k) {
				Ok(v) => out.insert(k.as_str(), v),
				Err(e) => {
					let _ = self.db.execute_batch("ROLLBACK");
					return Err(e);
				}
			}
		}
		self.db.execute_batch("COMMIT").map_err(failed)?;
		Ok(Json::Object(out))
	}

	pub fn compare_and_set(&self, key: &str, expected: Option<f64>, value: &Json) -> R<Json> {
		if key.is_empty() || expected.is_some_and(|e| e.fract() != 0.0 || !(1.0..=SAFE).contains(&e)) {
			return Err(conflict("invalid register key/version"));
		}
		let encoded = value.canonical().map_err(failed)?;
		self.db.execute_batch("BEGIN IMMEDIATE").map_err(failed)?;
		let done = (|| {
			let prior = self.row(key)?;
			if prior.as_ref().map(|p| p.0) != expected {
				return Err(conflict("register version changed"));
			}
			validate_erasure_update(key, value, prior.as_ref().map(|p| &p.1), &|k| Ok(self.row(k)?.map(|r| r.1)))?;
			let version = expected.unwrap_or(0.0) + 1.0;
			self.db.execute("INSERT INTO records(key,version,value) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET version=excluded.version,value=excluded.value", params![key, version as i64, encoded]).map_err(failed)?;
			self.db.execute_batch("COMMIT").map_err(failed)?;
			Ok(record(version, parse(&encoded).map_err(failed)?))
		})();
		if done.is_err() {
			let _ = self.db.execute_batch("ROLLBACK");
		}
		done
	}
}

/// How the client reaches the register; a unix socket needs a pinned server name.
#[derive(Clone, Debug)]
pub struct RegisterClient {
	pub identity: TlsIdentity,
	pub host: String,
	pub port: u16,
	pub server_name: Option<String>,
	pub timeout_ms: u64,
	pub batch_reads: bool,
	pub unix_path: Option<String>,
}

async fn over<S: AsyncRead + AsyncWrite + Unpin>(mut tls: S, body: &str) -> R<Vec<u8>> {
	tls.write_all(body.as_bytes()).await.map_err(failed)?;
	tls.flush().await.map_err(failed)?;
	let (mut input, mut chunk) = (vec![], [0u8; 16 * 1024]);
	loop {
		if input.contains(&b'\n') {
			return Ok(input);
		}
		if input.len() > MAX_BYTES {
			return Err(failed("register response exceeds budget"));
		}
		match tls.read(&mut chunk).await.map_err(failed)? {
			0 => return Err(failed("register disconnected")),
			n => input.extend_from_slice(&chunk[..n]),
		}
	}
}

impl RegisterClient {
	pub fn new(o: RegisterClient) -> R<RegisterClient> {
		if o.unix_path.as_ref().is_some_and(|p| !p.starts_with('/') || o.server_name.is_none()) {
			return Err(failed("Unix register transport requires an absolute socket path and pinned TLS server name"));
		}
		Ok(o)
	}

	async fn exchange(&self, call: Json) -> R<Json> {
		let body = format!("{}\n", call.to_json_text());
		if body.len() > MAX_BYTES {
			return Err(failed("register request exceeds budget"));
		}
		let connector = self.identity.client().map_err(failed)?;
		let name = server_name(self.server_name.as_deref().unwrap_or(&self.host)).map_err(failed)?;
		let raw = match &self.unix_path {
			Some(path) => over(connector.connect(name, UnixStream::connect(path).await.map_err(failed)?).await.map_err(failed)?, &body).await?,
			None => over(connector.connect(name, TcpStream::connect((self.host.as_str(), self.port)).await.map_err(failed)?).await.map_err(failed)?, &body).await?,
		};
		let end = raw.iter().position(|b| *b == b'\n').unwrap_or(raw.len());
		let r = parse(&String::from_utf8_lossy(&raw[..end])).map_err(failed)?;
		if r.get("ok").and_then(Json::as_bool) == Some(true) {
			return Ok(r.get("result").cloned().unwrap_or(Json::Null));
		}
		let message = r.get("error").and_then(|e| e.get("message")).and_then(Json::as_str).unwrap_or("register refused request").to_owned();
		Err(if r.get("error").and_then(|e| e.get("code")).and_then(Json::as_str) == Some("RequestConflict") { conflict(message) } else { failed(message) })
	}

	async fn call(&self, call: Json) -> R<Json> { timeout(Duration::from_millis(self.timeout_ms), self.exchange(call)).await.map_err(|_| failed("independent TLS register timed out"))? }

	pub async fn get(&self, key: &str) -> R<Json> { self.call(obj! { "method" => "get", "key" => key }).await }

	pub async fn compare_and_set(&self, key: &str, expected: Option<f64>, value: &Json) -> R<Json> {
		self.call(obj! { "method" => "compareAndSet", "key" => key, "expectedVersion" => expected.map_or(Json::Null, Json::Number), "value" => value.clone() }).await
	}

	pub async fn get_many(&self, keys: &[String]) -> R<Json> {
		validate_read_keys(keys)?;
		if !self.batch_reads {
			let mut out = Object::new();
			for k in keys {
				out.insert(k.as_str(), self.get(k).await?);
			}
			return Ok(Json::Object(out));
		}
		let records = self.call(obj! { "method" => "getMany", "keys" => Json::Array(keys.iter().map(|k| k.as_str().into()).collect()) }).await?;
		let fine = records.as_object().is_some_and(|o| o.iter().count() == keys.len() && keys.iter().all(|k| o.get(k).is_some_and(|r| r.is_null() || (integer(r.get("version")).is_some_and(|v| v >= 1.0) && r.get("value").is_some()))));
		if fine { Ok(records) } else { Err(failed("invalid register batch response")) }
	}
}

/// What a certificate may do, by the SHA-256 of its DER.
#[derive(Clone, Debug, Default)]
pub struct PeerPolicy {
	pub operator: bool,
	pub write_keys: Vec<String>,
}
pub type Peers = dyn Fn() -> HashMap<String, PeerPolicy>;

fn answer(register: &SqliteRegister, policy: &PeerPolicy, line: &[u8]) -> Json {
	let done = (|| {
		let c = parse(&String::from_utf8_lossy(line)).map_err(failed)?;
		let method = c.get("method").and_then(Json::as_str).unwrap_or("");
		if method == "getMany" {
			let keys: Option<Vec<String>> = c.get("keys").and_then(Json::as_array).and_then(|a| a.iter().map(|k| k.as_str().map(str::to_owned)).collect());
			return register.get_many(&keys.ok_or_else(|| conflict("invalid bounded register read keys"))?);
		}
		let key = c.get("key").and_then(Json::as_str).filter(|k| !k.is_empty() && k.encode_utf16().count() <= 512).ok_or_else(|| failed("invalid register key"))?;
		match method {
			"get" => register.get(key),
			"compareAndSet" if policy.operator || policy.write_keys.iter().any(|k| k == key) => {
				let expected = match c.get("expectedVersion") {
					Some(Json::Null) => None,
					other => Some(other.and_then(Json::as_f64).unwrap_or(f64::NAN)),
				};
				register.compare_and_set(key, expected, c.get("value").unwrap_or(&Json::Null))
			}
			_ => Err(failed("certificate has no CAS permission for this register key")),
		}
	})();
	match done {
		Ok(result) => obj! { "ok" => true, "result" => result },
		Err(e) => obj! { "ok" => false, "error" => obj! { "code" => if matches!(e, RegisterError::Conflict(_)) { "RequestConflict" } else { "PermissionDenied" }, "message" => e.to_string() } },
	}
}

async fn serve_one(register: Rc<RefCell<SqliteRegister>>, peers: Rc<Peers>, open: Rc<Cell<usize>>, acceptor: tokio_rustls::TlsAcceptor, socket: TcpStream) {
	let Ok(Ok(mut tls)) = timeout(Duration::from_secs(4), acceptor.accept(socket)).await else { return };
	let print = tls.get_ref().1.peer_certificates().and_then(|c| c.first()).map(|c| hex(&Sha256::digest(c.as_ref())));
	let Some(policy) = print.and_then(|p| peers().remove(&p)) else { return };
	if open.get() >= 32 {
		return;
	}
	open.set(open.get() + 1);
	let _ = timeout(Duration::from_secs(8), async {
		let (mut input, mut chunk) = (vec![], [0u8; 16 * 1024]);
		let end = loop {
			if let Some(end) = input.iter().position(|b| *b == b'\n') {
				break end;
			}
			if input.len() > MAX_BYTES {
				return;
			}
			match tls.read(&mut chunk).await {
				Ok(n) if n > 0 => input.extend_from_slice(&chunk[..n]),
				_ => return,
			}
		};
		let reply = answer(&register.borrow(), &policy, &input[..end]);
		let _ = tls.write_all(format!("{}\n", reply.to_json_text()).as_bytes()).await;
		let _ = tls.shutdown().await;
	})
	.await;
	open.set(open.get() - 1);
}

/// `serveTlsRegister`: serves until the task ends. `peers` is asked at each connection, so a removed certificate is out at once.
pub async fn serve_register(register: SqliteRegister, identity: &TlsIdentity, listener: TcpListener, peers: Rc<Peers>) -> R<()> {
	let acceptor = identity.server().map_err(failed)?;
	let (register, open) = (Rc::new(RefCell::new(register)), Rc::new(Cell::new(0)));
	let live = Rc::new(Cell::new(0usize));
	loop {
		let (socket, _) = listener.accept().await.map_err(failed)?;
		if live.get() >= 64 {
			continue;
		}
		live.set(live.get() + 1);
		let (register, peers, open, acceptor, live) = (Rc::clone(&register), Rc::clone(&peers), Rc::clone(&open), acceptor.clone(), Rc::clone(&live));
		tokio::task::spawn_local(async move {
			serve_one(register, peers, open, acceptor, socket).await;
			live.set(live.get() - 1);
		});
	}
}
