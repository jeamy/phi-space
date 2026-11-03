//! The replica transitions of a primary/sync Space (src/replica-control.ts), run by the operator on a host whose service for
//! the Space is stopped: `promote` on the fixed standby, `degradeToSingle` and `setStandby` on the primary. Each is a journal
//! transition (`begin`, then `locallyCommitted`, then `completed`) that a crash leaves resumable under the same ID; the
//! register's boot records follow it (`casBoot`), and the fenced host is proven fenced by a fencing adapter's proof.
use crate::register::{RegisterError, SqliteRegister};
use crate::replica_control::{assert_permit, standby_target};
use crate::replica_transport::SignedReplicaPeer;
use phi_json::{obj, text, Json, Object};
use phi_store::sync::{durability_of, SyncError, SyncJournal};
use phi_store::sync_store::{apply_config_transition, materialize_sync_history, recover_sealed_without_standby, SyncStoreFile};

/// `ReplicaTransitionBlocked`, or what the journal or the register refused.
pub type TR<T> = Result<T, String>;
fn refused<T>(m: impl Into<String>) -> TR<T> { Err(m.into()) }
fn sync<T>(r: phi_store::sync::Result<T>) -> TR<T> { r.map_err(|e| e.to_string()) }
fn as_sync<T>(r: TR<T>) -> phi_store::sync::Result<T> { r.map_err(SyncError::Blocked) }
fn canonical(v: &Json) -> String { v.canonical().unwrap_or_default() }
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn with(v: &Json, changes: &[(&str, Json)]) -> Json {
	let mut o = v.as_object().cloned().unwrap_or_default();
	for (k, x) in changes { o.insert(*k, x.clone()); }
	Json::Object(o)
}

/// The independent register as the transitions use it: records `{version, value}` (or `null`) and compare-and-set.
pub trait Boots {
	fn get(&self, key: &str) -> Result<Json, RegisterError>;
	fn compare_and_set(&self, key: &str, expected: Option<f64>, value: &Json) -> Result<Json, RegisterError>;
}
impl Boots for SqliteRegister {
	fn get(&self, key: &str) -> Result<Json, RegisterError> { SqliteRegister::get(self, key) }
	fn compare_and_set(&self, key: &str, expected: Option<f64>, value: &Json) -> Result<Json, RegisterError> { SqliteRegister::compare_and_set(self, key, expected, value) }
}
/// The TLS register from code that may block.
pub struct BlockingRegister<'a>(pub &'a tokio::runtime::Runtime, pub &'a crate::register::RegisterClient);
impl Boots for BlockingRegister<'_> {
	fn get(&self, key: &str) -> Result<Json, RegisterError> { self.0.block_on(self.1.get(key)) }
	fn compare_and_set(&self, key: &str, expected: Option<f64>, value: &Json) -> Result<Json, RegisterError> { self.0.block_on(self.1.compare_and_set(key, expected, value)) }
}

/// A fencing adapter (`FencingAdapter`): it fences a host with a restart lock and verifies such a proof.
pub trait Fencing {
	fn kind(&self) -> &str;
	fn fence(&self, host_id: &str, reason: &str) -> TR<Json>;
	fn verify(&self, proof: &Json) -> TR<bool>;
	/// Lifts the restart lock of a host released into quarantine.
	fn release(&self, host_id: &str) -> TR<()>;
}
/// `TlsFencing`: the fencing service over pinned mutual TLS, one JSON line each way.
pub struct TlsFencing<'a> {
	pub rt: &'a tokio::runtime::Runtime,
	pub line: crate::register::RegisterClient,
	pub kind: String,
}
fn valid_proof(p: &Json) -> bool { text(p, "hostId").is_some() && text(p, "kind").is_some() && p.get("observedAt").and_then(Json::as_f64).is_some() && p.get("restartLocked").and_then(Json::as_bool).is_some() }
impl Fencing for TlsFencing<'_> {
	fn kind(&self) -> &str { &self.kind }
	fn fence(&self, host_id: &str, reason: &str) -> TR<Json> {
		let p = self.rt.block_on(self.line.request(obj! { "method" => "fence", "hostId" => host_id, "reason" => reason })).map_err(|e| e.to_string())?;
		if !valid_proof(&p) || text(&p, "hostId") != Some(host_id) || text(&p, "kind") != Some(self.kind.as_str()) {
			return refused("invalid fencing proof");
		}
		Ok(p)
	}
	fn verify(&self, proof: &Json) -> TR<bool> {
		let r = self.rt.block_on(self.line.request(obj! { "method" => "verify", "hostId" => text(proof, "hostId").unwrap_or(""), "proof" => proof.clone() })).map_err(|e| e.to_string())?;
		Ok(r == Json::Bool(true))
	}
	fn release(&self, host_id: &str) -> TR<()> {
		self.rt.block_on(self.line.request(obj! { "method" => "release", "hostId" => host_id })).map(|_| ()).map_err(|e| e.to_string())
	}
}

/// `casBoot`: reads, changes and writes a host's boot record; a concurrent change is read again (eight tries).
fn cas_boot(r: &dyn Boots, host_id: &str, change: &dyn Fn(Option<Json>) -> TR<Option<Json>>) -> TR<Json> {
	let key = format!("boot:{host_id}");
	for attempt in 0.. {
		let current = r.get(&key).map_err(|e| e.to_string())?;
		let value = current.get("value").cloned().filter(|v| !v.is_null());
		let Some(next) = change(value.clone())? else { return Ok(value.unwrap_or(Json::Null)) };
		if value.as_ref().is_some_and(|v| canonical(v) == canonical(&next)) {
			return Ok(next);
		}
		match r.compare_and_set(&key, current.get("version").and_then(Json::as_f64), &next) {
			Ok(w) => return Ok(w.get("value").cloned().unwrap_or(next)),
			Err(RegisterError::Conflict(_)) if attempt < 7 => continue,
			Err(e) => return Err(e.to_string()),
		}
	}
	unreachable!("the eighth try returns")
}
fn spaces_of(b: &Json) -> Object { b.get("spaces").and_then(Json::as_object).cloned().unwrap_or_default() }

/// `fenceHostBoot`: the host `fenced`, every Space permit `revoked`.
pub fn fence_host_boot(r: &dyn Boots, host_id: &str, transition_id: &str) -> TR<Json> {
	cas_boot(r, host_id, &|b| {
		let b = b.ok_or_else(|| format!("no boot state for {host_id}"))?;
		let spaces: Object = spaces_of(&b).iter().map(|(id, p)| (id.to_owned(), with(p, &[("state", "revoked".into())]))).collect();
		Ok(Some(with(&b, &[("state", "fenced".into()), ("spaces", Json::Object(spaces)), ("transitionId", transition_id.into())])))
	})
}
/// `revokeSpacePermit`: only the permit of this Space is revoked.
pub fn revoke_space_permit(r: &dyn Boots, host_id: &str, space_id: &str, transition_id: &str) -> TR<Json> {
	cas_boot(r, host_id, &|b| {
		let b = b.filter(|b| b.get("spaces").and_then(|s| s.get(space_id)).is_some()).ok_or_else(|| format!("{host_id} has no permit for {space_id}"))?;
		let p = b.get("spaces").and_then(|s| s.get(space_id)).cloned().expect("checked");
		if text(&p, "state") == Some("revoked") {
			return Ok(None);
		}
		let mut spaces = spaces_of(&b);
		spaces.insert(space_id, with(&p, &[("state", "revoked".into())]));
		Ok(Some(with(&b, &[("spaces", Json::Object(spaces)), ("transitionId", transition_id.into())])))
	})
}
/// `releaseHostToQuarantine`: a fenced host is released only into quarantine; revoked permits stay revoked. The restart lock
/// is lifted after the boot record changed.
pub fn release_host_to_quarantine(r: &dyn Boots, host_id: &str, transition_id: &str, adapter: Option<&dyn Fencing>) -> TR<Json> {
	let boot = cas_boot(r, host_id, &|b| {
		let b = b.filter(|b| matches!(text(b, "state"), Some("fenced" | "quarantine"))).ok_or_else(|| format!("{host_id} is not fenced; release only leads into quarantine"))?;
		Ok(Some(with(&b, &[("state", "quarantine".into()), ("transitionId", transition_id.into())])))
	})?;
	if let Some(a) = adapter {
		a.release(host_id)?;
	}
	Ok(boot)
}
/// `readmitSpace`: after a fence, a Space other than the replicated one comes back with its permit unchanged but active.
pub fn readmit_space(r: &dyn Boots, host_id: &str, space_id: &str, transition_id: &str, expected_incarnation: &str) -> TR<Json> {
	cas_boot(r, host_id, &|b| {
		let b = b.filter(|b| text(b, "state") == Some("active")).ok_or_else(|| format!("{host_id} is not active; re-admit Spaces only after the host left quarantine"))?;
		let p = b.get("spaces").and_then(|s| s.get(space_id)).cloned().ok_or_else(|| format!("{host_id} has no permit for {space_id}"))?;
		if matches!(text(&p, "role"), Some("primary" | "standby")) {
			return refused("replicated Spaces return only through promote, degradeToSingle or setStandby");
		}
		let incarnation = text(&p, "dataIncarnation") == Some(expected_incarnation);
		if text(&p, "state") == Some("active") && incarnation {
			return Ok(None);
		}
		if text(&p, "state") != Some("revoked") || !incarnation {
			return refused(format!("permit of {space_id} is not a revoked permit of incarnation {expected_incarnation}"));
		}
		let mut spaces = spaces_of(&b);
		spaces.insert(space_id, with(&p, &[("state", "active".into()), ("transitionId", transition_id.into())]));
		Ok(Some(with(&b, &[("spaces", Json::Object(spaces)), ("transitionId", transition_id.into())])))
	})
}
fn assert_space_revoked(r: &dyn Boots, host_id: &str, space_id: &str) -> TR<()> {
	let rec = r.get(&format!("boot:{host_id}")).map_err(|e| e.to_string())?;
	let b = rec.get("value").filter(|v| !v.is_null());
	let revoked = b.is_some_and(|b| text(b, "state") != Some("active") || b.get("spaces").and_then(|s| s.get(space_id)).and_then(|p| text(p, "state")) == Some("revoked"));
	if !revoked { refused(format!("the standby permit of {host_id} for {space_id} is not revoked")) } else { Ok(()) }
}
fn permit_for(c: &Json, role: &str, data_incarnation: &str, transition_id: &str) -> Json {
	obj! { "state" => "active", "authorityId" => text(c, "authorityId").unwrap_or(""), "dataIncarnation" => data_incarnation, "role" => role, "primaryEpoch" => num(c, "primaryEpoch"), "replicaConfigVersion" => num(c, "replicaConfigVersion"), "durability" => durability_of(c), "transitionId" => transition_id }
}
fn set_permit(r: &dyn Boots, host_id: &str, space_id: &str, permit: &Json, host_state: Option<&str>, require: &[&str]) -> TR<Json> {
	cas_boot(r, host_id, &|b| {
		let b = b.ok_or_else(|| format!("no boot state for {host_id}"))?;
		let state = text(&b, "state").unwrap_or("").to_owned();
		if !require.is_empty() && !require.contains(&state.as_str()) {
			return refused(format!("{host_id} is {state}"));
		}
		let mut spaces = spaces_of(&b);
		spaces.insert(space_id, permit.clone());
		Ok(Some(with(&b, &[("state", host_state.unwrap_or(&state).into()), ("spaces", Json::Object(spaces)), ("transitionId", permit.get("transitionId").cloned().unwrap_or(Json::Null))])))
	})
}

/// What every transition is given (`Common`).
pub struct Common<'a> {
	pub storage: &'a mut SyncStoreFile,
	pub journal: &'a mut SyncJournal,
	pub register: &'a dyn Boots,
	pub installed: Option<&'a SqliteRegister>,
	pub host_id: &'a str,
	pub data_incarnation: &'a str,
	pub now: f64,
	/// Other Spaces in the same replicated store (a host's main store): their permits follow on this host. Empty for a
	/// primary/sync Space, which has a store of its own.
	pub sibling_spaces: &'a [String],
}

fn assert_shared_incarnation(o: &Common, space_id: &str) -> TR<()> {
	let rec = o.register.get(&format!("boot:{}", o.host_id)).map_err(|e| e.to_string())?;
	let p = rec.get("value").and_then(|v| v.get("spaces")).and_then(|s| s.get(space_id));
	if p.and_then(|p| text(p, "dataIncarnation")) != Some(o.data_incarnation) {
		return refused("the data incarnation of a replicated Space is shared by its replicas and stays unchanged");
	}
	Ok(())
}
fn check_proof(adapter: &dyn Fencing, proof: &Json, host_id: &str, allow_simulator: bool) -> TR<()> {
	if adapter.kind() == "simulator" && !allow_simulator {
		return refused("a simulator fencing claim is no evidence for promotion or degradeToSingle");
	}
	if text(proof, "hostId") != Some(host_id) || text(proof, "kind") != Some(adapter.kind()) || proof.get("restartLocked") != Some(&Json::Bool(true)) || !adapter.verify(proof)? {
		return refused(format!("no verified fencing proof for {host_id}"));
	}
	Ok(())
}
fn begin(journal: &mut SyncJournal, id: &str, kind: &str, args: &Json) -> TR<Json> {
	let hash = canonical(args);
	let rec = sync(journal.begin_transition(id, &obj! { "kind" => kind, "phase" => "started", "hash" => hash.as_str() }))?;
	if text(&rec, "kind") != Some(kind) || text(&rec, "hash") != Some(hash.as_str()) {
		return refused("transition ID was used for another transition");
	}
	if text(&rec, "phase") == Some("abandoned") {
		return refused("transition was abandoned; use a new ID");
	}
	Ok(rec)
}
fn save(journal: &mut SyncJournal, id: &str, rec: &mut Json, phase: &str, config: Option<&Json>) -> TR<()> {
	let mut changes = vec![("phase", Json::String(phase.into()))];
	if let Some(c) = config { changes.push(("config", c.clone())); }
	*rec = with(rec, &changes);
	sync(journal.save_transition(id, rec))
}
/// The standby's confirmation of a resumed entry, where one takes part.
type Accept<'a> = Option<&'a mut dyn FnMut(&Json) -> TR<Json>>;
/// `resumeSealed`: a configuration entry of this transition sealed before a crash is applied once; its configuration.
fn resume_sealed(o: &mut Common, id: &str, assert: &dyn Fn() -> phi_store::sync::Result<()>, accept: Accept) -> TR<Option<Json>> {
	let head = sync(o.journal.head_revision())?;
	let Some(i) = (if head > 0 { sync(o.journal.intent(head as f64))? } else { None }) else { return Ok(None) };
	if num(&i, "version") != 2.0 || text(&i, "reason") != Some(id) {
		return Ok(None);
	}
	if sync(o.journal.applied_revision())? != head {
		if let Some(accept) = accept {
			let ack = accept(&i)?;
			if num(&ack, "revision") != num(&i, "revision") || text(&ack, "hash") != text(&i, "hash") {
				return refused("standby ACK does not match the replica transition");
			}
		}
		sync(recover_sealed_without_standby(o.storage, o.journal, assert))?;
	}
	Ok(i.get("config").cloned())
}
/// `alignPermit` of `(host, its data incarnation)`: the host's permit follows the configuration.
fn align_permit(o: &Common, c: &Json, role: &str, id: &str, (host_state, require): (Option<&str>, &[&str]), (host_id, data_incarnation): (&str, &str)) -> TR<()> {
	let permit = permit_for(c, role, data_incarnation, id);
	// sibling Spaces of a replicated main store keep their own data incarnation and follow role and versions; another host
	// (the setStandby target) holds the same store, so it gets their permits with the incarnations of this host
	for sibling in o.sibling_spaces.iter().filter(|s| Some(s.as_str()) != text(c, "spaceId")) {
		let own = if host_id == o.host_id { None } else { o.register.get(&format!("boot:{}", o.host_id)).map_err(|e| e.to_string())?.get("value").and_then(|v| v.get("spaces")).and_then(|s| s.get(sibling)).filter(|p| !p.is_null()).cloned() };
		if host_id != o.host_id && own.is_none() {
			return refused(format!("{} has no permit for sibling Space {sibling}", o.host_id));
		}
		cas_boot(o.register, host_id, &|b| {
			let held = b.as_ref().and_then(|b| b.get("spaces")).and_then(|s| s.get(sibling)).filter(|p| !p.is_null()).cloned();
			let (Some(b), Some(p)) = (b, own.clone().or(held.clone())) else { return refused(format!("{host_id} has no permit for sibling Space {sibling}")) };
			let next = with(&p, &[("state", "active".into()), ("role", role.into()), ("authorityId", c.get("authorityId").cloned().unwrap_or(Json::Null)), ("primaryEpoch", c.get("primaryEpoch").cloned().unwrap_or(Json::Null)), ("replicaConfigVersion", c.get("replicaConfigVersion").cloned().unwrap_or(Json::Null)), ("durability", durability_of(c).into()), ("transitionId", id.into())]);
			if held.as_ref().is_some_and(|h| canonical(h) == canonical(&next)) {
				return Ok(None);
			}
			let mut spaces = spaces_of(&b);
			spaces.insert(sibling, next);
			Ok(Some(with(&b, &[("spaces", Json::Object(spaces)), ("transitionId", id.into())])))
		})?;
	}
	set_permit(o.register, host_id, text(c, "spaceId").unwrap_or(""), &permit, host_state, require)?;
	if let (Some(installed), true) = (o.installed, host_id == o.host_id) {
		let key = format!("installed:{host_id}:{}", text(c, "spaceId").unwrap_or(""));
		let cur = installed.get(&key).map_err(|e| e.to_string())?;
		if cur.get("value").map(canonical) != Some(canonical(&permit)) {
			installed.compare_and_set(&key, cur.get("version").and_then(Json::as_f64), &permit).map_err(|e| e.to_string())?;
		}
	}
	Ok(())
}
fn permit_check(r: &dyn Boots, host_id: &str, c: &Json, role: &str) -> TR<()> {
	let rec = r.get(&format!("boot:{host_id}")).map_err(|e| e.to_string())?;
	assert_permit(&rec, host_id, c, role).map_err(|e| e.to_string())
}

/// 5.3 on the fixed standby: with a verified proof that the old primary is fenced, the accepted history is materialized and
/// this host becomes primary under a new epoch; the old primary stays the standby of the new configuration.
pub fn promote(o: &mut Common, recovery_id: &str, expected_epoch: f64, expected_version: f64, adapter: &dyn Fencing, proof: &Json) -> TR<Json> {
	let mut rec = begin(o.journal, recovery_id, "promote", &obj! { "e" => expected_epoch, "v" => expected_version, "old" => proof.get("hostId").cloned().unwrap_or(Json::Null) })?;
	let old = text(proof, "hostId").unwrap_or("").to_owned();
	let fenced = || as_sync(check_proof(adapter, proof, &old, false));
	if text(&rec, "phase") == Some("started") {
		if let Some(c) = resume_sealed(o, recovery_id, &fenced, None)? {
			save(o.journal, recovery_id, &mut rec, "locallyCommitted", Some(&c))?;
		}
	}
	if text(&rec, "phase") == Some("started") {
		let c = o.journal.config();
		if text(&c, "standbyReplica") != Some(o.host_id) || durability_of(&c) != "sync" || num(&c, "primaryEpoch") != expected_epoch || num(&c, "replicaConfigVersion") != expected_version {
			return refused("only the fixed synchronous standby of the expected configuration is promoted");
		}
		let primary = text(&c, "primaryReplica").unwrap_or("").to_owned();
		check_proof(adapter, proof, &primary, false)?;
		permit_check(o.register, o.host_id, &c, "standby")?;
		assert_shared_incarnation(o, text(&c, "spaceId").unwrap_or(""))?;
		fence_host_boot(o.register, &primary, recovery_id)?;
		sync(materialize_sync_history(o.storage, o.journal, None))?;
		let next = with(&c, &[("primaryReplica", o.host_id.into()), ("standbyReplica", primary.as_str().into()), ("primaryEpoch", (num(&c, "primaryEpoch") + 1.0).into()), ("replicaConfigVersion", (num(&c, "replicaConfigVersion") + 1.0).into())]);
		let assert = || as_sync(check_proof(adapter, proof, &primary, false));
		sync(apply_config_transition(o.storage, o.journal, &next, recovery_id, None, &assert, o.now))?;
		save(o.journal, recovery_id, &mut rec, "locallyCommitted", Some(&next))?;
	}
	if text(&rec, "phase") == Some("locallyCommitted") {
		let c = rec.get("config").cloned().unwrap_or(Json::Null);
		align_permit(o, &c, "primary", recovery_id, (None, &["active"]), (o.host_id, o.data_incarnation))?;
		save(o.journal, recovery_id, &mut rec, "completed", None)?;
	}
	Ok(obj! { "recoveryId" => recovery_id, "config" => o.journal.config() })
}

/// How degradeToSingle excludes the standby: a verified fencing proof of its host, or its revoked permit for this Space.
pub enum Excluded<'a> {
	Fenced(&'a dyn Fencing, &'a Json),
	Revoked,
}
/// 5.3.1 on the primary: the standby is lost. The at most one sealed candidate is completed locally, the configuration
/// becomes single under a new epoch, and the primary's permit follows.
pub fn degrade_to_single(o: &mut Common, recovery_id: &str, expected_epoch: f64, expected_version: f64, how: Excluded) -> TR<Json> {
	let args = match &how {
		Excluded::Revoked => obj! { "e" => expected_epoch, "v" => expected_version, "revokeStandbySpace" => true },
		Excluded::Fenced(_, proof) => obj! { "e" => expected_epoch, "v" => expected_version, "standby" => proof.get("hostId").cloned().unwrap_or(Json::Null) },
	};
	let mut rec = begin(o.journal, recovery_id, "degradeToSingle", &args)?;
	let space = text(&o.journal.config(), "spaceId").unwrap_or("").to_owned();
	let register = o.register;
	let excluded = |standby: &str| -> TR<()> {
		match &how {
			Excluded::Revoked => assert_space_revoked(register, standby, &space),
			Excluded::Fenced(adapter, proof) => check_proof(*adapter, proof, standby, false),
		}
	};
	if text(&rec, "phase") == Some("started") {
		let before = match &how {
			Excluded::Revoked => {
				let head = sync(o.journal.head_revision())? as usize;
				sync(o.journal.config_at(head.saturating_sub(1)))?.get("standbyReplica").and_then(Json::as_str).unwrap_or("").to_owned()
			}
			Excluded::Fenced(_, proof) => text(proof, "hostId").unwrap_or("").to_owned(),
		};
		let assert = || as_sync(excluded(&before));
		if let Some(c) = resume_sealed(o, recovery_id, &assert, None)? {
			save(o.journal, recovery_id, &mut rec, "locallyCommitted", Some(&c))?;
		}
	}
	if text(&rec, "phase") == Some("started") {
		let c = o.journal.config();
		if text(&c, "primaryReplica") != Some(o.host_id) || durability_of(&c) != "sync" || num(&c, "primaryEpoch") != expected_epoch || num(&c, "replicaConfigVersion") != expected_version {
			return refused("replica configuration differs from the expected versions");
		}
		let standby = text(&c, "standbyReplica").unwrap_or("").to_owned();
		if let Excluded::Fenced(adapter, proof) = &how {
			check_proof(*adapter, proof, &standby, false)?;
		}
		assert_shared_incarnation(o, &space)?;
		match &how {
			Excluded::Revoked => revoke_space_permit(o.register, &standby, &space, recovery_id)?,
			Excluded::Fenced(..) => fence_host_boot(o.register, &standby, recovery_id)?,
		};
		let fenced = || as_sync(excluded(&standby));
		sync(recover_sealed_without_standby(o.storage, o.journal, &fenced))?;
		let next = with(&c, &[("standbyReplica", Json::Null), ("durability", "single".into()), ("primaryEpoch", (num(&c, "primaryEpoch") + 1.0).into()), ("replicaConfigVersion", (num(&c, "replicaConfigVersion") + 1.0).into())]);
		sync(apply_config_transition(o.storage, o.journal, &next, recovery_id, None, &fenced, o.now))?;
		save(o.journal, recovery_id, &mut rec, "locallyCommitted", Some(&next))?;
	}
	if text(&rec, "phase") == Some("locallyCommitted") {
		let c = rec.get("config").cloned().unwrap_or(Json::Null);
		align_permit(o, &c, "primary", recovery_id, (None, &["active"]), (o.host_id, o.data_incarnation))?;
		save(o.journal, recovery_id, &mut rec, "completed", None)?;
	}
	Ok(obj! { "recoveryId" => recovery_id, "config" => o.journal.config(), "recoveredCommitted" => sync(o.journal.recovered_committed())? })
}

/// 5.3.1 step 7 on a single primary: the quarantined, empty target replays the whole history, confirms the new sync
/// configuration, and both permits follow; the target leaves quarantine only then.
pub fn set_standby(o: &mut Common, transition_id: &str, target: &mut SignedReplicaPeer, target_incarnation: &str) -> TR<Json> {
	let target_id = target.remote.host_id.clone();
	let mut rec = begin(o.journal, transition_id, "setStandby", &obj! { "target" => target_id.as_str() })?;
	if text(&rec, "phase") == Some("started") {
		let head = sync(o.journal.head_revision())? as usize;
		let before = if head > 0 { sync(o.journal.config_at(head - 1))? } else { Json::Null };
		let (register, host) = (o.register, o.host_id.to_owned());
		let assert = || as_sync(permit_check(register, &host, &before, "primary"));
		let mut accept = |i: &Json| target.accept(i).map_err(|e| e.to_string());
		if let Some(c) = resume_sealed(o, transition_id, &assert, Some(&mut accept))? {
			save(o.journal, transition_id, &mut rec, "locallyCommitted", Some(&c))?;
		}
	}
	if text(&rec, "phase") == Some("started") {
		let c = o.journal.config();
		if text(&c, "primaryReplica") != Some(o.host_id) || durability_of(&c) != "single" {
			return refused("setStandby starts from a single primary");
		}
		if target_incarnation != o.data_incarnation {
			return refused("the standby carries the shared data incarnation of the Space");
		}
		let space = text(&c, "spaceId").unwrap_or("").to_owned();
		assert_shared_incarnation(o, &space)?;
		if !standby_target(&o.register.get(&format!("boot:{target_id}")).map_err(|e| e.to_string())?, Some(&space)) {
			return refused("the target must be in quarantine or active without an active permit for this Space");
		}
		if sync(o.journal.head_revision())? != sync(o.journal.applied_revision())? {
			return refused("resolve the sealed candidate first");
		}
		permit_check(o.register, o.host_id, &c, "primary")?;
		// an empty target only; a retry of the same transition may continue its own interrupted catch-up
		let th = target.head().map_err(|e| e.to_string())?;
		let resumable = rec.get("catchingUp") == Some(&Json::Bool(true)) && sync(o.journal.intent(num(&th, "revision")))?.is_some_and(|i| text(&i, "hash") == text(&th, "hash"));
		if num(&th, "revision") != 0.0 && !resumable {
			return refused("setStandby needs an empty target; a used replica is reinstalled first");
		}
		rec = with(&rec, &[("catchingUp", Json::Bool(true))]);
		sync(o.journal.save_transition(transition_id, &rec))?;
		for r in 1..=sync(o.journal.head_revision())? {
			let i = sync(o.journal.intent(r as f64))?.expect("a complete chain");
			let ack = target.catch_up(&i).map_err(|e| e.to_string())?;
			if num(&ack, "revision") != num(&i, "revision") || text(&ack, "hash") != text(&i, "hash") {
				return refused("target history differs; only an empty target is supported");
			}
		}
		let next = with(&c, &[("standbyReplica", target_id.as_str().into()), ("durability", "sync".into()), ("replicaConfigVersion", (num(&c, "replicaConfigVersion") + 1.0).into())]);
		let (register, host) = (o.register, o.host_id.to_owned());
		let assert = || as_sync(permit_check(register, &host, &c, "primary"));
		let mut peer = |i: &Json| target.accept(i).map_err(|e| SyncError::Blocked(e.to_string()));
		sync(apply_config_transition(o.storage, o.journal, &next, transition_id, Some(&mut peer), &assert, o.now))?;
		save(o.journal, transition_id, &mut rec, "locallyCommitted", Some(&next))?;
	}
	if text(&rec, "phase") == Some("locallyCommitted") {
		let state = o.register.get(&format!("boot:{}", o.host_id)).map_err(|e| e.to_string())?;
		if state.get("value").and_then(|v| text(v, "state")) != Some("active") {
			return refused(format!("{} is no longer active", o.host_id));
		}
		let c = rec.get("config").cloned().unwrap_or(Json::Null);
		align_permit(o, &c, "standby", transition_id, (Some("active"), &["quarantine", "active"]), (&target_id, target_incarnation))?;
		align_permit(o, &c, "primary", transition_id, (None, &["active"]), (o.host_id, o.data_incarnation))?;
		save(o.journal, transition_id, &mut rec, "completed", None)?;
	}
	Ok(obj! { "transitionId" => transition_id, "config" => o.journal.config() })
}
