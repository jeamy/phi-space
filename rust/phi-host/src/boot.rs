//! Boot fencing (src/boot.ts): a host serves a Space only with the external authorization, the matching local installation and
//! the Space's own identity agreeing. TypeScript asks the register around each commit; here the service runs on the owner
//! thread and must not wait, so the gate reads the register before a call and the commit checks against what that read
//! found. A read that fails or has grown old blocks the host: nothing is served on an authorization that cannot be seen.
//! A standby permit admits no business work; a primary permit only for a primary/sync Space this host serves from its
//! journal (`replica`), and only as the primary of the journal's configuration.
use phi_json::text;
use crate::register::{RegisterClient, RegisterError, SqliteRegister};
use phi_core::space::{error, CoreError, Space};
use phi_json::Json;
use phi_service::Guard;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
fn blocked(m: impl Into<String>) -> CoreError { error("BootBlocked", m) }

/// Where the external authorization is read.
pub enum External {
	Tls(Box<RegisterClient>),
	/// `registerSshTarget`: read-only over a pinned ssh forced command.
	Ssh(crate::register::SshRegister),
	/// `registerReadSocket`: read-only over a private Unix endpoint.
	Socket(crate::register::SocketRegister),
	/// A register on this machine: tests.
	File(SqliteRegister),
}

impl External {
	/// One record (`null` if there is none).
	pub async fn get(&self, key: &str) -> Result<Json, RegisterError> {
		match self {
			External::Tls(c) => c.get(key).await,
			External::Ssh(r) => crate::register::Register::get(r, key).await,
			External::Socket(r) => crate::register::Register::get(r, key).await,
			External::File(f) => f.get(key),
		}
	}
	async fn read(&self, keys: &[String]) -> Result<Json, RegisterError> {
		let mut all = phi_json::Object::new();
		for batch in keys.chunks(32) {
			let part = match self {
				External::Tls(c) => c.get_many(batch).await?,
				External::File(f) => f.get_many(batch)?,
				// without a batch read: key by key (`readRegisterRecords`)
				_ => {
					let mut one = phi_json::Object::new();
					for k in batch {
						one.insert(k.as_str(), self.get(k).await?);
					}
					Json::Object(one)
				}
			};
			for (k, v) in part.as_object().into_iter().flat_map(|o| o.iter()) {
				all.insert(k, v.clone());
			}
		}
		Ok(Json::Object(all))
	}
}

impl crate::register::Register for External {
	fn get<'a>(&'a self, key: &'a str) -> crate::register::Ahead<'a, Json> { Box::pin(External::get(self, key)) }
	fn compare_and_set<'a>(&'a self, key: &'a str, expected: Option<f64>, value: &'a Json) -> crate::register::Ahead<'a, Json> {
		match self {
			External::Tls(c) => crate::register::Register::compare_and_set(c.as_ref(), key, expected, value),
			External::Ssh(r) => r.compare_and_set(key, expected, value),
			External::Socket(r) => r.compare_and_set(key, expected, value),
			External::File(f) => crate::register::Register::compare_and_set(f, key, expected, value),
		}
	}
}

#[derive(Clone)]
struct Seen {
	boot: Json,
	authority: Option<Json>,
	erasure: HashMap<String, Json>,
	at: f64,
}

/// An installed permit and its canonical text.
type Installed = Rc<(Json, Option<String>)>;

pub struct BootGuard {
	host_id: String,
	authority_id: String,
	external: External,
	installed: SqliteRegister,
	now: crate::gate::Now,
	/// How long a read of the register counts.
	max_age_ms: f64,
	seen: RefCell<Option<Seen>>,
	/// The installed permits read so far, with their canonical text, while the file's `data_version` stays: every call's
	/// check of its Space reads them (`space`), the file changes only by a boot admission or another process.
	installed_read: RefCell<(Option<i64>, HashMap<String, Installed>)>,
	/// Reads begun, and the newest that has answered: calls overlap, and an older read must not replace a newer one.
	reads: Cell<(u64, u64)>,
	/// The control authority this host follows: its space, host and key, read with the rest.
	pub authority: Option<(String, String, String)>,
	/// The primary/sync Spaces this host serves from stores of their own: their IDs, read with the rest, and the
	/// configuration of each one's journal now (`replicaConfig` of `installBootGuard`).
	pub replica: RefCell<HashMap<String, Box<dyn Fn() -> Json>>>,
}

/// `replicaMismatch`: a primary/sync Space admits work only as the primary of its current configuration.
fn replica_mismatch(host_id: &str, permit: &Json, config: &Json) -> Option<&'static str> {
	if text(permit, "role") != Some("primary") || text(config, "primaryReplica") != Some(host_id) {
		return Some("this host is not the primary of the replica configuration");
	}
	let same = |k: &str| permit.get(k).and_then(Json::as_f64) == config.get(k).and_then(Json::as_f64);
	if text(permit, "authorityId") != text(config, "authorityId") || !same("primaryEpoch") || !same("replicaConfigVersion") || text(permit, "durability") != Some(phi_store::sync::durability_of(config)) {
		return Some("boot permit disagrees with the local replica configuration");
	}
	None
}

/// `validateErasureBarrier`, on a record read just now.
fn check_barrier(record: &Json, id: &str, s: &Space, now: f64) -> R<()> {
	let epoch = s.state.rest.get("erasureEpoch").and_then(Json::as_f64).unwrap_or(0.0);
	if record.is_null() {
		return if epoch != 0.0 { Err(blocked("independent erasure barrier is missing")) } else { Ok(()) };
	}
	let v = record.get("value").unwrap_or(&Json::Null);
	let e = v.get("epoch").and_then(Json::as_f64).unwrap_or(0.0);
	let hash = text(v, "commandHash").is_some_and(phi_json::is_sha256_hex);
	if text(v, "spaceId") != Some(id) || e < 1.0 || e.fract() != 0.0 || text(v, "state") != Some("sealed") || !hash || epoch != e {
		return Err(blocked("erasure barrier requires completed deletion at its current epoch"));
	}
	if v.get("archivesPending") == Some(&Json::Bool(true)) && !v.get("archiveDeadline").and_then(Json::as_f64).is_some_and(|d| d.fract() == 0.0 && now < d) {
		return Err(blocked("archive deletion deadline expired; normal service remains fenced"));
	}
	Ok(())
}

impl BootGuard {
	/// The external register this guard reads (a Root reads boot permits of other hosts from it).
	pub fn external(&self) -> &External { &self.external }
	pub fn new(host_id: &str, authority_id: &str, external: External, installed: SqliteRegister, now: crate::gate::Now, max_age_ms: f64) -> BootGuard {
		BootGuard { host_id: host_id.to_owned(), authority_id: authority_id.to_owned(), external, installed, now, max_age_ms, seen: RefCell::new(None), installed_read: RefCell::new((None, HashMap::new())), reads: Cell::new((0, 0)), authority: None, replica: RefCell::new(HashMap::new()) }
	}

	/// Reads the register for these Spaces. A failed read forgets the last one. What was read stays while another call's
	/// read is under way: emptied before the answer, it would block a call that overlaps this one.
	pub async fn refresh(&self, mut spaces: Vec<String>) {
		spaces.extend(self.replica.borrow().keys().cloned());
		let boot = format!("boot:{}", self.host_id);
		let mut keys = vec![boot.clone()];
		keys.extend(spaces.iter().map(|s| format!("erasure:{s}")));
		let authority = self.authority.as_ref().map(|(space, ..)| format!("authority:{space}"));
		keys.extend(authority.clone());
		let (begun, answered) = self.reads.get();
		self.reads.set((begun + 1, answered));
		let ticket = begun + 1;
		let read = self.external.read(&keys).await;
		let (begun, answered) = self.reads.get();
		if ticket < answered {
			return;
		}
		self.reads.set((begun, ticket));
		let Ok(read) = read else {
			*self.seen.borrow_mut() = None;
			return;
		};
		let erasure = spaces.iter().map(|s| (s.clone(), read.get(&format!("erasure:{s}")).cloned().unwrap_or(Json::Null))).collect();
		*self.seen.borrow_mut() = Some(Seen { boot: read.get(&boot).cloned().unwrap_or(Json::Null), authority: authority.and_then(|k| read.get(&k).cloned()), erasure, at: (self.now)() });
	}

	fn seen(&self) -> R<Seen> {
		let now = (self.now)();
		let inactive = || blocked("external host boot authorization is absent or inactive");
		let seen = self.seen.borrow().clone().filter(|s| now - s.at <= self.max_age_ms).ok_or_else(inactive)?;
		let v = seen.boot.get("value").ok_or_else(inactive)?;
		if text(v, "state") != Some("active") || text(v, "hostId") != Some(&self.host_id) {
			return Err(inactive());
		}
		if let Some((_, host, key)) = &self.authority {
			let a = seen.authority.as_ref().and_then(|a| a.get("value")).filter(|a| text(a, "state") == Some("active") && text(a, "authorityId") == Some(&self.authority_id) && text(a, "hostId") == Some(host) && text(a, "supervisorKey") == Some(key));
			if a.is_none() {
				return Err(blocked("the control authority is not the installed one"));
			}
		}
		Ok(seen)
	}

	/// The start of a configured host: only an active authorization boots it, and the permit of a re-admitted Space
	/// (`installAdmittedPermit`) comes into the local installation when it names the data this host holds.
	pub async fn admit_at_start(&self, spaces: &[Json]) -> Result<(), String> {
		let boot = format!("boot:{}", self.host_id);
		let read = self.external.read(std::slice::from_ref(&boot)).await.map_err(|e| e.to_string())?;
		let v = read.get(&boot).and_then(|r| r.get("value")).filter(|v| text(v, "hostId") == Some(&self.host_id) && text(v, "state") == Some("active")).ok_or("configured host is not authorized for normal boot")?;
		for info in spaces {
			let (id, incarnation) = (text(info, "spaceId").unwrap_or(""), text(info, "incarnation"));
			let Some(permit) = v.get("spaces").and_then(|p| p.get(id)).filter(|p| text(p, "state") == Some("active") && text(p, "dataIncarnation") == incarnation) else { continue };
			let key = format!("installed:{}:{id}", self.host_id);
			let local = self.installed.get(&key).map_err(|e| e.to_string())?;
			if local.get("value").and_then(|l| l.canonical().ok()) != permit.canonical().ok() {
				self.installed.compare_and_set(&key, local.get("version").and_then(Json::as_f64), permit).map_err(|e| e.to_string())?;
				self.installed_read.borrow_mut().1.clear(); // this connection's own write leaves data_version as it is
			}
		}
		Ok(())
	}

	/// The installed permit of Space `id` (`installed:{host}:{id}`'s value) and its canonical text; read again once the
	/// register file changed.
	fn installed_permit(&self, id: &str) -> Result<Option<Installed>, String> {
		let version = self.installed.data_version().map_err(|e| e.to_string())?;
		let mut read = self.installed_read.borrow_mut();
		if read.0 != Some(version) {
			*read = (Some(version), HashMap::new());
		}
		if let Some(known) = read.1.get(id) {
			return Ok(Some(Rc::clone(known)));
		}
		let local = self.installed.get(&format!("installed:{}:{id}", self.host_id)).map_err(|e| e.to_string())?;
		let Some(value) = local.get("value").cloned() else { return Ok(None) };
		let canonical = value.canonical().ok();
		let entry = Rc::new((value, canonical));
		read.1.insert(id.to_owned(), Rc::clone(&entry));
		Ok(Some(entry))
	}

	/// `assertActive` of a host's entry replication: the host's boot record, read last, is active and admits the Space.
	pub fn space_active(&self, id: &str) -> bool {
		let Ok(seen) = self.seen() else { return false };
		seen.boot.get("value").and_then(|v| v.get("spaces")).and_then(|p| p.get(id)).and_then(|p| text(p, "state")) == Some("active")
	}

	/// `assertAuthority` of a host with this guard.
	pub fn assert_active(&self) -> R<()> { self.seen().map(|_| ()) }
}

impl Guard for BootGuard {
	fn host(&self) -> R<()> { self.assert_active() }

	fn space(&self, s: &Space) -> R<()> {
		let seen = self.seen()?;
		let id = s.state.space_id.as_deref().unwrap_or("");
		let lacks = || blocked(format!("space {id} lacks matching external/local boot permission"));
		let permit = seen.boot.get("value").and_then(|v| v.get("spaces")).and_then(|p| p.get(id)).ok_or_else(lacks)?;
		let installed = self.installed_permit(id).map_err(blocked)?.ok_or_else(lacks)?;
		let (local, local_canonical) = (&installed.0, &installed.1);
		let marker = permit.get("authorityMarker").and_then(Json::as_bool) == Some(true);
		let accepted = s.state.rest.get("acceptedAuthorityId").and_then(Json::as_str);
		if text(permit, "state") != Some("active") || text(local, "state") != Some("active") || text(permit, "authorityId") != Some(&self.authority_id) || (marker && accepted != Some(&self.authority_id)) || text(permit, "dataIncarnation") != s.state.incarnation.as_deref() || permit.canonical().ok() != *local_canonical {
			return Err(lacks());
		}
		match text(permit, "role") {
			Some("local") => {}
			Some("standby") => return Err(blocked(format!("space {id}: a standby permit admits no business work"))),
			Some("primary") => match self.replica.borrow().get(id) {
				Some(config) => {
					if let Some(why) = replica_mismatch(&self.host_id, permit, &config()) {
						return Err(blocked(format!("space {id}: {why}")));
					}
				}
				None => return Err(blocked(format!("space {id}: primary/sync is not served by this host"))),
			},
			_ => return Err(lacks()),
		}
		let number = |v: Option<&Json>| v.and_then(Json::as_f64).unwrap_or(0.0);
		if number(permit.get("erasureEpoch")) != number(s.state.rest.get("erasureEpoch")) {
			return Err(blocked("space deletion epoch disagrees with boot permission"));
		}
		check_barrier(seen.erasure.get(id).unwrap_or(&Json::Null), id, s, (self.now)())?;
		if let Some(e) = s.state.rest.get("primaryEpoch") {
			if permit.get("primaryEpoch") != Some(e) {
				return Err(blocked("space epoch disagrees with boot permission"));
			}
		}
		Ok(())
	}
}
