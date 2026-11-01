//! Boot fencing (src/boot.ts): a host serves a Space only with the external authorization, the matching local installation and
//! the Space's own identity agreeing. TypeScript asks the register around each commit; here the service runs on the owner
//! thread and must not wait, so the gate reads the register before a call and the commit checks against what that read
//! found. A read that fails or has grown old blocks the host: nothing is served on an authorization that cannot be seen.
//! A primary/sync or standby permit stays blocked: replication is not served here (R6).
use crate::register::{RegisterClient, RegisterError, SqliteRegister};
use phi_core::space::{error, CoreError, Space};
use phi_json::Json;
use phi_service::Guard;
use std::cell::{Cell, RefCell};
use std::collections::HashMap;

type R<T> = Result<T, CoreError>;
fn blocked(m: impl Into<String>) -> CoreError { error("BootBlocked", m) }
fn text<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }

/// Where the external authorization is read.
pub enum External {
	Tls(Box<RegisterClient>),
	/// A register on this machine: tests.
	File(SqliteRegister),
}

impl External {
	async fn read(&self, keys: &[String]) -> Result<Json, RegisterError> {
		let mut all = phi_json::Object::new();
		for batch in keys.chunks(32) {
			let part = match self {
				External::Tls(c) => c.get_many(batch).await?,
				External::File(f) => f.get_many(batch)?,
			};
			for (k, v) in part.as_object().into_iter().flat_map(|o| o.iter()) {
				all.insert(k, v.clone());
			}
		}
		Ok(Json::Object(all))
	}
}

#[derive(Clone)]
struct Seen {
	boot: Json,
	authority: Option<Json>,
	erasure: HashMap<String, Json>,
	at: f64,
}

pub struct BootGuard {
	host_id: String,
	authority_id: String,
	external: External,
	installed: SqliteRegister,
	now: crate::gate::Now,
	/// How long a read of the register counts.
	max_age_ms: f64,
	seen: RefCell<Option<Seen>>,
	/// Reads begun, and the newest that has answered: calls overlap, and an older read must not replace a newer one.
	reads: Cell<(u64, u64)>,
	/// The control authority this host follows: its space, host and key, read with the rest.
	pub authority: Option<(String, String, String)>,
}

/// `validateErasureBarrier`, on a record read just now.
fn check_barrier(record: &Json, id: &str, s: &Space, now: f64) -> R<()> {
	let epoch = s.state.rest.get("erasureEpoch").and_then(Json::as_f64).unwrap_or(0.0);
	if record.is_null() {
		return if epoch != 0.0 { Err(blocked("independent erasure barrier is missing")) } else { Ok(()) };
	}
	let v = record.get("value").unwrap_or(&Json::Null);
	let e = v.get("epoch").and_then(Json::as_f64).unwrap_or(0.0);
	let hash = text(v, "commandHash").is_some_and(|h| h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
	if text(v, "spaceId") != Some(id) || e < 1.0 || e.fract() != 0.0 || text(v, "state") != Some("sealed") || !hash || epoch != e {
		return Err(blocked("erasure barrier requires completed deletion at its current epoch"));
	}
	if v.get("archivesPending") == Some(&Json::Bool(true)) && !v.get("archiveDeadline").and_then(Json::as_f64).is_some_and(|d| d.fract() == 0.0 && now < d) {
		return Err(blocked("archive deletion deadline expired; normal service remains fenced"));
	}
	Ok(())
}

impl BootGuard {
	pub fn new(host_id: &str, authority_id: &str, external: External, installed: SqliteRegister, now: crate::gate::Now, max_age_ms: f64) -> BootGuard {
		BootGuard { host_id: host_id.to_owned(), authority_id: authority_id.to_owned(), external, installed, now, max_age_ms, seen: RefCell::new(None), reads: Cell::new((0, 0)), authority: None }
	}

	/// Reads the register for these Spaces. A failed read forgets the last one. What was read stays while another call's
	/// read is under way: emptied before the answer, it would block a call that overlaps this one.
	pub async fn refresh(&self, spaces: Vec<String>) {
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
		let local = self.installed.get(&format!("installed:{}:{id}", self.host_id)).map_err(|e| blocked(e.to_string()))?;
		let local = local.get("value").ok_or_else(lacks)?;
		let marker = permit.get("authorityMarker").and_then(Json::as_bool) == Some(true);
		let accepted = s.state.rest.get("acceptedAuthorityId").and_then(Json::as_str);
		if text(permit, "state") != Some("active") || text(local, "state") != Some("active") || text(permit, "authorityId") != Some(&self.authority_id) || (marker && accepted != Some(&self.authority_id)) || text(permit, "dataIncarnation") != s.state.incarnation.as_deref() || permit.canonical().ok() != local.canonical().ok() {
			return Err(lacks());
		}
		match text(permit, "role") {
			Some("local") => {}
			Some("standby") => return Err(blocked(format!("space {id}: a standby permit admits no business work"))),
			Some("primary") => return Err(blocked(format!("space {id}: primary/sync is not served by this host"))),
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
