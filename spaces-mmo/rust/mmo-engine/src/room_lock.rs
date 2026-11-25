//! The room and island locks (`server/engine/room-lock.ts`; docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3,
//! "Locks"): whoever changes the static occupancy of a room takes the room's lock in its transaction and writes it back
//! with the commit; a command that meets a taken lock is refused, a job waits. Roads across rooms and growth take the
//! island's lock first. Order: WORLD_LOCK, the island lock, the room locks in the order of their IDs. A room's lock
//! carries its occupancy version (`version`), counted up by every holder.
use std::collections::{BTreeMap, BTreeSet};

use phi_json::{obj, Json};

use crate::j;
use crate::space::{fields, refuse, tmpl, Result, Space, FOREVER};

/// `roomLock`.
pub fn room_lock(room: &str) -> Json { tmpl("RoomLock", obj! { "room" => room }) }
/// `islandLock`.
pub fn island_lock(island: &str) -> Json { tmpl("IslandLock", obj! { "island" => island }) }

/// `LOCK_WAIT_MS`: how long a job waits for a lock before it leaves the change to its next run.
pub const LOCK_WAIT_MS: f64 = 5_000.0;
/// `COMMAND_LOCK_WAIT_MS`: how long a command waits for a taken lock before it refuses (below one tick).
pub const COMMAND_LOCK_WAIT_MS: f64 = 100.0;
/// `LOCK_HELD`.
pub const LOCK_HELD: &str = "Hier wird gerade gebaut oder abgeräumt; bitte gleich noch einmal.";

/// `writeRoomLock`.
pub async fn write_room_lock(space: &Space, txn: Option<&str>, room: &str) -> Result<()> { space.write_unique(&room_lock(room), txn, FOREVER, &["room"]).await.map(|_| ()) }
/// `writeIslandLock`.
pub async fn write_island_lock(space: &Space, txn: Option<&str>, island: &str) -> Result<()> { space.write_unique(&island_lock(island), txn, FOREVER, &["island"]).await.map(|_| ()) }
/// `dropRoomLock`: taken away with its room, waiting for a holder up to LOCK_WAIT_MS; false: still held (or not there),
/// the room stays for the next run.
pub async fn drop_room_lock(space: &Space, txn: &str, room: &str) -> Result<bool> { Ok(space.take_if_exists(&room_lock(room), LOCK_WAIT_MS, Some(txn)).await?.is_some()) }

async fn hold(space: &Space, txn: &str, t: &Json, wait_ms: f64) -> Result<bool> {
	let Some(e) = space.take_if_exists(t, wait_ms, Some(txn)).await? else { return Ok(false) };
	space.write(&obj! { "type" => j::at(&e, "type").clone(), "fields" => fields(&e).clone() }, Some(txn), FOREVER).await?;
	Ok(true)
}

/// `lockVersion`: the occupancy version a room's lock carries (absent: 0).
pub fn lock_version(f: &Json) -> f64 { j::no(f, "version").unwrap_or(0.0) }
/// `holdRoomVersion`: the room's lock taken and written back with its version counted up; the version it had, or None
/// when it is taken by another transaction now (or not there) within `wait_ms`.
pub async fn hold_room_version(space: &Space, txn: &str, room: &str, wait_ms: f64) -> Result<Option<f64>> {
	let Some(e) = space.take_if_exists(&room_lock(room), wait_ms, Some(txn)).await? else { return Ok(None) };
	let version = lock_version(fields(&e));
	let mut f = fields(&e).clone();
	j::set(&mut f, "version", Json::from(version + 1.0));
	space.write(&obj! { "type" => j::at(&e, "type").clone(), "fields" => f }, Some(txn), FOREVER).await?;
	Ok(Some(version))
}
/// `holdRoom`: a job's take of the room's lock (`wait_ms`, LOCK_WAIT_MS by default).
pub async fn hold_room(space: &Space, txn: &str, room: &str, wait_ms: f64) -> Result<bool> { Ok(hold_room_version(space, txn, room, wait_ms).await?.is_some()) }
/// `holdIsland`: the island's lock, then its rooms' in the order of their IDs.
pub async fn hold_island(space: &Space, txn: &str, island: &str, rooms: &[&str], wait_ms: f64) -> Result<bool> {
	if !hold(space, txn, &island_lock(island), wait_ms).await? { return Ok(false); }
	let sorted: BTreeSet<&str> = rooms.iter().copied().collect();
	for room in sorted { if !hold_room(space, txn, room, wait_ms).await? { return Ok(false); } }
	Ok(true)
}
/// `holdRoomOrRefuse`.
pub async fn hold_room_or_refuse(space: &Space, txn: &str, room: &str) -> Result<()> { if hold_room(space, txn, room, COMMAND_LOCK_WAIT_MS).await? { Ok(()) } else { refuse(LOCK_HELD) } }
/// `holdIslandOrRefuse`.
pub async fn hold_island_or_refuse(space: &Space, txn: &str, island: &str, rooms: &[&str]) -> Result<()> { if hold_island(space, txn, island, rooms, COMMAND_LOCK_WAIT_MS).await? { Ok(()) } else { refuse(LOCK_HELD) } }

/// `lockReport`: a room without its lock or with two, a lock without its room, the same for islands (`skip_room`: rooms
/// a test wrote by hand; an island only such rooms are on is left out with them).
pub fn lock_report(entries: &[Json], skip_room: &dyn Fn(&str) -> bool) -> Vec<String> {
	let is = |e: &Json, t: &str| j::s(e, "type") == t || j::a(e, "types").iter().any(|x| x.as_str() == Some(t));
	let text = |v: &Json| match v { Json::String(s) => s.clone(), Json::Null => "undefined".to_owned(), o => o.to_json_text() };
	let (mut rooms, mut islands, mut skipped) = (BTreeSet::new(), BTreeSet::new(), BTreeSet::new());
	let (mut room_locks, mut island_locks): (BTreeMap<String, usize>, BTreeMap<String, usize>) = (BTreeMap::new(), BTreeMap::new());
	for e in entries {
		let f = fields(e);
		if is(e, "Room") {
			let r = text(j::at(f, "roomId"));
			if skip_room(&r) { if let Some(i) = j::so(f, "island") { skipped.insert(i.to_owned()); } continue; }
			if let Some(i) = j::so(f, "island") { islands.insert(i.to_owned()); }
			rooms.insert(r);
		} else if is(e, "RoomLock") { *room_locks.entry(text(j::at(f, "room"))).or_default() += 1; }
		else if is(e, "IslandLock") { *island_locks.entry(text(j::at(f, "island"))).or_default() += 1; }
	}
	let mut out = Vec::new();
	let all: BTreeSet<String> = rooms.iter().cloned().chain(room_locks.keys().cloned()).collect();
	for r in all {
		if skip_room(&r) { continue; }
		let n = room_locks.get(&r).copied().unwrap_or(0);
		if !rooms.contains(&r) { out.push(format!("room lock of {r}, a room that is not there")); } else if n != 1 { out.push(format!("room {r}: {n} locks")); }
	}
	let all: BTreeSet<String> = islands.iter().cloned().chain(island_locks.keys().cloned()).collect();
	for i in all {
		let n = island_locks.get(&i).copied().unwrap_or(0);
		if !islands.contains(&i) && skipped.contains(&i) { continue; }
		if !islands.contains(&i) { out.push(format!("island lock of {i}, an island no room is on")); } else if n != 1 { out.push(format!("island {i}: {n} locks")); }
	}
	out
}
