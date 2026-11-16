//! A host's role in a primary/sync Space, as the independent register states it (src/replica-control.ts): the checks of a
//! primary's writer (`assertSyncPrimary`), of a standby's journal (`assertSyncStandby`), of a setStandby target's catch-up
//! (`assertQuarantine`), and the local installation of an admitted permit (`installAdmittedPermit`). The checks decide on
//! a boot record read just before; `RegisterLine` reads it for code that must not wait on the owner thread's runtime (the
//! writer's thread) and for the owner thread alike.
use crate::boot::External;
use crate::register::SqliteRegister;
use phi_json::{text, Json};
use phi_store::sync::{durability_of, SyncError};

fn blocked<T>(m: impl Into<String>) -> phi_store::sync::Result<T> { Err(SyncError::Blocked(m.into())) }
fn number(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
/// The value of a `boot:<host>` record, if there is one.
fn boot(record: &Json) -> Option<&Json> { record.get("value").filter(|v| !v.is_null()) }

/// `permitMatches`: an active permit of this role for exactly this configuration.
pub fn permit_matches(p: Option<&Json>, role: &str, c: &Json, durability: &str) -> bool {
	p.is_some_and(|p| {
		text(p, "state") == Some("active") && text(p, "role") == Some(role) && text(p, "authorityId") == text(c, "authorityId") && number(p, "primaryEpoch") == number(c, "primaryEpoch") && number(p, "replicaConfigVersion") == number(c, "replicaConfigVersion") && text(p, "durability") == Some(durability)
	})
}

/// `assertPermit`: the host is this role of the configuration, active, with a permit for exactly it.
pub fn assert_permit(record: &Json, host_id: &str, c: &Json, role: &str) -> phi_store::sync::Result<()> {
	let b = boot(record);
	let named = if role == "primary" { text(c, "primaryReplica") } else { text(c, "standbyReplica") };
	if named != Some(host_id) {
		return blocked(format!("{host_id} is not the {role} of this configuration"));
	}
	let p = b.and_then(|b| b.get("spaces")).and_then(|s| s.get(text(c, "spaceId").unwrap_or("")));
	if !b.is_some_and(|b| text(b, "state") == Some("active")) || !permit_matches(p, role, c, durability_of(c)) {
		return blocked(if role == "primary" { "external boot permit does not match the local replica configuration" } else { "standby boot permit does not match the expected configuration" });
	}
	Ok(())
}

/// A setStandby target for `space_id`: a quarantined host, or an active host without an active permit for this Space.
pub fn standby_target(record: &Json, space_id: Option<&str>) -> bool {
	let Some(b) = boot(record) else { return false };
	text(b, "state") == Some("quarantine") || space_id.is_some_and(|id| text(b, "state") == Some("active") && b.get("spaces").and_then(|s| s.get(id)).and_then(|p| text(p, "state")) != Some("active"))
}

/// `assertSyncStandby`: only the setStandby configuration entry naming this host is confirmed while it is still a target.
pub fn assert_sync_standby(record: &Json, host_id: &str, c: &Json, version: f64) -> phi_store::sync::Result<()> {
	if version == 2.0 && text(c, "standbyReplica") == Some(host_id) && standby_target(record, text(c, "spaceId")) {
		return Ok(());
	}
	assert_permit(record, host_id, c, "standby")
}

/// `assertQuarantine`: catch-up of a setStandby target (without `space_id` only a quarantined host).
pub fn assert_quarantine(record: &Json, host_id: &str, space_id: Option<&str>) -> phi_store::sync::Result<()> {
	if standby_target(record, space_id) {
		return Ok(());
	}
	blocked(format!("{host_id} is not in quarantine{}", space_id.map_or(String::new(), |id| format!(" and still holds an active permit for {id}"))))
}

/// `installAdmittedPermit`: the active external permit of one Space goes into the local installation if it names the data
/// this host holds; the permit, or why there is none (`ReplicaTransitionBlocked`).
pub fn install_admitted_permit(record: &Json, installed: &SqliteRegister, host_id: &str, space_id: &str, local_incarnation: &str) -> Result<Json, String> {
	let b = boot(record).filter(|b| text(b, "state") == Some("active"));
	let Some(p) = b.and_then(|b| b.get("spaces")).and_then(|s| s.get(space_id)).filter(|p| text(p, "state") == Some("active")) else {
		return Err(format!("no active external permit for {space_id}"));
	};
	if text(p, "dataIncarnation") != Some(local_incarnation) {
		return Err("external permit names another data incarnation than the local Space".into());
	}
	let key = format!("installed:{host_id}:{space_id}");
	let cur = installed.get(&key).map_err(|e| e.to_string())?;
	if cur.get("value").and_then(|v| v.canonical().ok()) != p.canonical().ok() {
		installed.compare_and_set(&key, cur.get("version").and_then(Json::as_f64), p).map_err(|e| e.to_string())?;
	}
	Ok(p.clone())
}

type Asked = (String, tokio::sync::oneshot::Sender<Result<Json, String>>);
/// Reads of the independent register on a thread of its own, for the owner thread (`get`) and for a thread that may
/// block (`get_blocking`: a primary's writer checks its permit around every seal).
#[derive(Clone)]
pub struct RegisterLine(tokio::sync::mpsc::UnboundedSender<Asked>);
impl RegisterLine {
	pub fn spawn(make: impl FnOnce() -> External + Send + 'static) -> RegisterLine {
		let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<Asked>();
		std::thread::spawn(move || {
			let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("a runtime for the register line");
			let external = make();
			rt.block_on(async move {
				while let Some((key, answer)) = rx.recv().await {
					let _ = answer.send(external.get(&key).await.map_err(|e| e.to_string()));
				}
			});
		});
		RegisterLine(tx)
	}
	/// The record of `key` (`null` if there is none).
	pub async fn get(&self, key: &str) -> Result<Json, String> {
		let (tx, rx) = tokio::sync::oneshot::channel();
		self.0.send((key.to_owned(), tx)).map_err(|_| "the register line is closed".to_owned())?;
		rx.await.map_err(|_| "the register line is closed".to_owned())?
	}
	pub fn get_blocking(&self, key: &str) -> Result<Json, String> {
		let (tx, rx) = tokio::sync::oneshot::channel();
		self.0.send((key.to_owned(), tx)).map_err(|_| "the register line is closed".to_owned())?;
		rx.blocking_recv().map_err(|_| "the register line is closed".to_owned())?
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use phi_json::obj;

	fn config(primary: &str, standby: &str) -> Json {
		obj! { "spaceId" => "s", "authorityId" => "a", "primaryEpoch" => 2.0, "replicaConfigVersion" => 3.0, "primaryReplica" => primary, "standbyReplica" => standby, "durability" => "sync" }
	}
	fn permit(role: &str, state: &str, epoch: f64) -> Json {
		obj! { "state" => state, "authorityId" => "a", "dataIncarnation" => "i1", "role" => role, "primaryEpoch" => epoch, "replicaConfigVersion" => 3.0, "durability" => "sync", "transitionId" => "t" }
	}
	fn record(host_state: &str, spaces: Json) -> Json { obj! { "version" => 1.0, "value" => obj! { "hostId" => "h", "state" => host_state, "spaces" => spaces } } }
	fn message<T>(r: phi_store::sync::Result<T>) -> String { r.err().map(|e| e.to_string()).unwrap_or_default() }

	#[test]
	fn a_primary_needs_its_role_an_active_host_and_a_permit_for_exactly_the_configuration() {
		let good = record("active", obj! { "s" => permit("primary", "active", 2.0) });
		assert!(assert_permit(&good, "h", &config("h", "o"), "primary").is_ok());
		assert_eq!(message(assert_permit(&good, "h", &config("o", "h"), "primary")), "h is not the primary of this configuration");
		let mismatch = "external boot permit does not match the local replica configuration";
		assert_eq!(message(assert_permit(&record("fenced", obj! { "s" => permit("primary", "active", 2.0) }), "h", &config("h", "o"), "primary")), mismatch);
		assert_eq!(message(assert_permit(&record("active", obj! { "s" => permit("primary", "revoked", 2.0) }), "h", &config("h", "o"), "primary")), mismatch);
		assert_eq!(message(assert_permit(&record("active", obj! { "s" => permit("primary", "active", 1.0) }), "h", &config("h", "o"), "primary")), mismatch);
		assert_eq!(message(assert_permit(&Json::Null, "h", &config("h", "o"), "primary")), mismatch);
		assert_eq!(message(assert_permit(&good, "h", &config("o", "h"), "standby")), "standby boot permit does not match the expected configuration");
	}

	#[test]
	fn only_the_set_standby_entry_naming_a_target_passes_without_a_permit() {
		let quarantined = record("quarantine", obj! {});
		assert!(assert_sync_standby(&quarantined, "h", &config("o", "h"), 2.0).is_ok());
		assert!(assert_sync_standby(&quarantined, "h", &config("o", "h"), 1.0).is_err(), "a commit needs the permit");
		let without = record("active", obj! { "s" => permit("standby", "revoked", 2.0) });
		assert!(assert_sync_standby(&without, "h", &config("o", "h"), 2.0).is_ok(), "an active host without an active permit is a target");
		let holding = record("active", obj! { "s" => permit("standby", "active", 2.0) });
		assert!(assert_sync_standby(&holding, "h", &config("o", "h"), 1.0).is_ok());
		assert_eq!(message(assert_quarantine(&holding, "h", Some("s"))), "h is not in quarantine and still holds an active permit for s");
		assert_eq!(message(assert_quarantine(&without, "h", None)), "h is not in quarantine");
		assert!(assert_quarantine(&quarantined, "h", None).is_ok());
	}

	#[test]
	fn an_admitted_permit_is_installed_once_when_it_names_the_data_held_here() {
		let d = std::env::temp_dir().join(format!("replica-control-{}", std::process::id()));
		let _ = std::fs::remove_file(&d);
		let installed = SqliteRegister::open(&d).unwrap();
		let r = record("active", obj! { "s" => permit("primary", "active", 2.0) });
		assert_eq!(install_admitted_permit(&record("active", obj! {}), &installed, "h", "s", "i1"), Err("no active external permit for s".into()));
		assert_eq!(install_admitted_permit(&r, &installed, "h", "s", "i2"), Err("external permit names another data incarnation than the local Space".into()));
		assert_eq!(install_admitted_permit(&r, &installed, "h", "s", "i1").unwrap(), permit("primary", "active", 2.0));
		let v = installed.get("installed:h:s").unwrap().get("version").cloned();
		install_admitted_permit(&r, &installed, "h", "s", "i1").unwrap();
		assert_eq!(installed.get("installed:h:s").unwrap().get("version").cloned(), v, "the same permit is not written again");
		let _ = std::fs::remove_file(&d);
	}
}
