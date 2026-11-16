//! Entry replication between hosts (`EntryReplicationPump` of src/entry-replication-stream.ts and what
//! `startConfiguredFederation` runs beside it): one pump per pinned peer pulls that peer's entry stream over its gate
//! (`entryDescribe`, `entryChanges`), records the vector it advertises and imports each page into this host's replica;
//! the compaction timer runs `compact` every `compactEveryMs`. A failure of the line is temporary and retried with a
//! growing pause; anything else stops the pump, is logged, and it starts again after five seconds.
use crate::boot::BootGuard;
use crate::remote::ControlClient;
use phi_json::{obj, Json};
use phi_service::entry::EntryError;
use phi_wire::Owner;
use std::rc::Rc;
use std::time::Duration;
use tokio::time::{sleep, timeout};

/// A pinned peer of the replication.
pub struct EntryPeer {
	pub replica_id: String,
	pub peer_id: String,
	/// Its gate, proven as its host.
	pub client: Rc<ControlClient>,
}

enum Fail {
	/// `EntryReplicationUnavailable`: the line failed or the read timed out.
	Unavailable,
	/// Anything else: the pump stops with this message.
	Stop(String),
}
#[derive(PartialEq)]
enum Status {
	Applied,
	Idle,
	Raced,
}

const RETRY_MS: u64 = 100;
const MAX_RETRY_MS: u64 = 5000;
const CALL_TIMEOUT_MS: u64 = 5000;
const RESTART_MS: u64 = 5000;

/// One read of the peer's stream, bounded as the pump bounds it.
async fn read(client: &ControlClient, call: Json) -> Result<Json, Fail> {
	match timeout(Duration::from_millis(CALL_TIMEOUT_MS), client.reply(&call)).await {
		Err(_) | Ok(Err(_)) => Err(Fail::Unavailable),
		Ok(Ok(reply)) if reply.get("ok") == Some(&Json::Bool(true)) => Ok(reply.get("result").cloned().unwrap_or(Json::Null)),
		Ok(Ok(reply)) => Err(Fail::Stop(reply.get("error").and_then(|e| e.get("message")).and_then(Json::as_str).unwrap_or("the peer refused").to_owned())),
	}
}
fn stop(e: EntryError) -> Fail { Fail::Stop(e.message()) }
/// A fresh read of the register for the controller's checks, with every Space of the store, as the gate reads it before
/// a call: the guard's last read is shared with the calls it guards, and their erasure barriers are part of it.
async fn refresh(owner: &Owner, boot: &BootGuard) {
	let spaces = owner.with(|s| s.store.spaces().iter().filter_map(|i| i.get("spaceId")?.as_str().map(str::to_owned)).collect());
	boot.refresh(spaces).await;
}
/// The controller of this host's replica, on the owner thread.
fn on<T>(owner: &Owner, f: impl FnOnce(&phi_service::entry::EntryReplication, &mut phi_store::Store) -> Result<T, EntryError>) -> Result<T, Fail> {
	owner.with(|s| match s.merge.as_ref() {
		None => Err(Fail::Stop("entry replication not configured".into())),
		Some(m) => f(&m.controller, &mut s.store).map_err(stop),
	})
}

async fn step(owner: &Owner, peer: &EntryPeer, identity: &Json, boot: &BootGuard) -> Result<(Status, bool), Fail> {
	let description = read(&peer.client, obj! { "method" => "entryDescribe", "args" => obj! {} }).await?;
	let revision = description.get("revision").and_then(Json::as_f64);
	if description.get("source").map(Json::key_text) != Some(identity.key_text()) || !revision.is_some_and(|r| phi_json::safe_integer(r) && r >= 0.0) {
		return Err(Fail::Stop("replication source identity changed".into()));
	}
	refresh(owner, boot).await;
	if description.get("vector").is_some() {
		on(owner, |c, st| c.record_peer_vector(st, &description))?;
	}
	let checkpoint = on(owner, |c, st| c.start_stream_import(st, identity, None))?;
	let cursor = checkpoint.get("cursor").cloned().unwrap_or(Json::Null);
	let page_bytes = on(owner, |c, _| Ok(((c.max_batch_bytes - 16384.0) / 2.0).floor()))?;
	let page = read(&peer.client, obj! { "method" => "entryChanges", "args" => obj! { "after" => cursor.clone(), "maxBytes" => page_bytes } }).await?;
	if page.get("after") != Some(&cursor) || page.get("source").map(Json::key_text) != Some(identity.key_text()) {
		return Err(Fail::Stop("replication page does not match requested source or cursor".into()));
	}
	let more = page.get("more") == Some(&Json::Bool(true));
	let events = page.get("events").and_then(Json::as_array).map_or(0, Vec::len);
	match owner.with(|s| s.merge.as_ref().map(|m| m.controller.import_stream_page(&mut s.store, &page))) {
		None => Err(Fail::Stop("entry replication not configured".into())),
		Some(Ok(_)) => Ok((if events > 0 { Status::Applied } else { Status::Idle }, more)),
		Some(Err(EntryError::Cursor(_))) => {
			let current = on(owner, |c, st| c.stream_import_status(st, identity))?;
			if current.is_null() {
				return Err(Fail::Stop(EntryError::Cursor(0.0).message()));
			}
			Ok((Status::Raced, true))
		}
		Some(Err(e)) => Err(stop(e)),
	}
}

/// `EntryReplicationPump.run`: only a temporary failure is retried; anything else ends it.
async fn run(owner: &Owner, peer: &EntryPeer, identity: &Json, poll_ms: u64, boot: &BootGuard) -> String {
	let mut retry = RETRY_MS;
	loop {
		match step(owner, peer, identity, boot).await {
			Ok((status, more)) => {
				retry = RETRY_MS;
				if status != Status::Applied || !more {
					sleep(Duration::from_millis(if status == Status::Raced { RETRY_MS } else { poll_ms })).await;
				}
			}
			Err(Fail::Unavailable) => {
				sleep(Duration::from_millis(retry)).await;
				retry = (retry * 2).min(MAX_RETRY_MS);
			}
			Err(Fail::Stop(m)) => return m,
		}
	}
}

/// Pulls one peer's stream for as long as the host runs.
pub async fn pump(owner: Owner, peer: EntryPeer, poll_ms: u64, boot: Rc<BootGuard>) {
	loop {
		let stopped = match read(&peer.client, obj! { "method" => "entryDescribe", "args" => obj! {} }).await {
			Err(Fail::Unavailable) => None,
			Err(Fail::Stop(m)) => Some(m),
			Ok(d) => {
				let source = d.get("source").cloned().unwrap_or(Json::Null);
				let serves = source.get("replicaId").and_then(Json::as_str).unwrap_or("");
				if serves != peer.replica_id {
					Some(format!("peer {} serves replica {serves}, not {}", peer.peer_id, peer.replica_id))
				} else {
					Some(run(&owner, &peer, &source, poll_ms, &boot).await)
				}
			}
		};
		if let Some(m) = stopped {
			eprintln!("Entry replication from {}: {m}", peer.replica_id);
		}
		sleep(Duration::from_millis(RESTART_MS)).await;
	}
}

/// Compaction every `every_ms`: it needs a recorded vector from every member, and does nothing until then.
pub async fn compact(owner: Owner, every_ms: u64, boot: Rc<BootGuard>, now: crate::gate::Now) {
	loop {
		sleep(Duration::from_millis(every_ms)).await;
		refresh(&owner, &boot).await;
		let request = Json::String(format!("compact-{}", phi_json::number_text(now())));
		match on(&owner, |c, st| c.compact(st, &request)) {
			Ok(r) => {
				let dropped = r.get("dropped").and_then(Json::as_f64).unwrap_or(0.0);
				if dropped > 0.0 {
					println!("Entry replication compacted {} changes", phi_json::number_text(dropped));
				}
			}
			Err(Fail::Stop(m)) => eprintln!("Entry replication compaction: {m}"),
			Err(Fail::Unavailable) => {}
		}
	}
}

/// `Number(v)` of JavaScript (one implementation, `workers.rs`).
pub use crate::workers::js_number;
