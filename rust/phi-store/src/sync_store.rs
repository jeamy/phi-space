//! The own store under a primary/sync journal (src/store/sync-sqlite.ts `OwnSyncStore`, and the store side of src/primary-sync.ts): a
//! store file opened by its owner without a host (a stopped daemon), on which the journal applies, checks and captures, and
//! what is done there: a bootstrap, a standby materializing its history, a primary resolving its one sealed candidate,
//! a candidate completed under a fencing proof, a configuration change.
use crate::files::{open_files, StoreFiles};
use crate::ops::at_value;
use crate::sync::{blocked, canonical, copy, durability_of, hash, marker_of, num, own, sql, text, validate_config_transition, config_of, Result, SyncError, SyncJournal};
use phi_json::{digest_json, obj, parse, Json};
use rusqlite::{params, OptionalExtension};
use std::path::Path;

/// A store file opened by its owner.
pub struct SyncStoreFile {
	files: StoreFiles,
}

/// A number as node:sqlite binds it: an integral one as an integer, any other as a real.
fn number(v: Option<&Json>) -> rusqlite::types::Value {
	match v { Some(Json::Number(n)) => at_value(Some(*n)), Some(Json::String(s)) => rusqlite::types::Value::Text(s.clone()), _ => rusqlite::types::Value::Null }
}
fn string(v: Option<&Json>) -> rusqlite::types::Value {
	match v { Some(Json::String(s)) => rusqlite::types::Value::Text(s.clone()), Some(Json::Number(n)) => at_value(Some(*n)), _ => rusqlite::types::Value::Null }
}
fn column(v: rusqlite::types::ValueRef<'_>) -> Json {
	match v {
		rusqlite::types::ValueRef::Null => Json::Null,
		rusqlite::types::ValueRef::Integer(i) => Json::Number(i as f64),
		rusqlite::types::ValueRef::Real(r) => Json::Number(r),
		rusqlite::types::ValueRef::Text(t) => Json::String(String::from_utf8_lossy(t).into_owned()),
		rusqlite::types::ValueRef::Blob(b) => Json::String(String::from_utf8_lossy(b).into_owned()),
	}
}

impl SyncStoreFile {
	pub fn open(path: &Path) -> std::result::Result<SyncStoreFile, String> {
		let files = open_files(path).map_err(|e| e.to_string())?;
		files.read.execute_batch("PRAGMA synchronous = FULL;").map_err(|e| e.to_string())?;
		Ok(SyncStoreFile { files })
	}
	/// The marker of `space_id`: `{configHash, revision, batchHash, previousHash}`.
	pub fn marker(&self, space_id: &str) -> Result<Option<Json>> {
		let v: Option<String> = sql(self.files.read.query_row("SELECT value FROM store_meta WHERE key = ?", [own::marker_key(space_id)], |r| r.get(0)).optional())?;
		Ok(v.map(|t| parse(&t).unwrap_or(Json::Null)))
	}
	/// Applies `deltas` atomically, as one commit (`commit_seq`).
	pub fn commit(&mut self, deltas: &[Json]) -> Result<()> {
		let db = &self.files.read;
		sql(db.execute_batch("BEGIN IMMEDIATE"))?;
		let r = (|| -> rusqlite::Result<()> {
			for op in deltas {
				let g = |k: &str| op.get(k);
				match op.get("t").and_then(Json::as_str) {
					Some("doc") => { db.prepare_cached(crate::ops::DOC)?.execute(params![string(g("kind")), string(g("key")), number(g("version")), string(g("value"))])?; }
					Some("retire") => { db.prepare_cached(crate::ops::RETIRE)?.execute(params![string(g("kind")), string(g("key"))])?; db.prepare_cached(crate::ops::RETIRE_PARTS)?.execute(params![string(g("kind")), string(g("key"))])?; }
					Some("part") => { db.prepare_cached(crate::ops::PART)?.execute(params![string(g("kind")), string(g("key")), string(g("part")), string(g("id")), number(g("ord")), string(g("value")), number(g("at")), string(g("grp")), number(g("flag"))])?; }
					Some("partDel") => { db.prepare_cached(crate::ops::PART_DEL)?.execute(params![string(g("kind")), string(g("key")), string(g("part")), string(g("id"))])?; }
					Some("partClear") => { db.prepare_cached("DELETE FROM parts WHERE kind = ? AND key = ? AND part = ?")?.execute(params![string(g("kind")), string(g("key")), string(g("part"))])?; }
					_ => { db.prepare_cached("INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")?.execute(params![string(g("key")), string(g("value"))])?; }
				}
			}
			db.prepare_cached(crate::ops::SEQ)?.execute([])?;
			Ok(())
		})();
		match r {
			Ok(()) => sql(db.execute_batch("COMMIT")),
			Err(e) => { let _ = db.execute_batch("ROLLBACK"); Err(SyncError::Blocked(e.to_string())) }
		}
	}
	/// Every document and part row as creates, in key order (the marker and the store's bookkeeping excluded), and its digest.
	pub fn capture(&self) -> Result<(Vec<Json>, String)> {
		let db = &self.files.read;
		let mut writes = vec![];
		let mut st = sql(db.prepare("SELECT kind, key, version, value FROM documents ORDER BY kind, key"))?;
		let mut rows = sql(st.query([]))?;
		while let Some(r) = sql(rows.next())? {
			writes.push(obj! { "t" => "doc", "kind" => column(sql(r.get_ref(0))?), "key" => column(sql(r.get_ref(1))?), "version" => column(sql(r.get_ref(2))?), "value" => column(sql(r.get_ref(3))?) });
		}
		let mut st = sql(db.prepare("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, ord, id"))?;
		let mut rows = sql(st.query([]))?;
		while let Some(r) = sql(rows.next())? {
			let c = |i: usize| -> Result<Json> { Ok(column(sql(r.get_ref(i))?)) };
			writes.push(obj! { "t" => "part", "kind" => c(0)?, "key" => c(1)?, "part" => c(2)?, "id" => c(3)?, "ord" => c(4)?, "value" => c(5)?, "at" => c(6)?, "grp" => c(7)?, "flag" => c(8)? });
		}
		let digest = digest_json(&Json::Array(writes.clone())).map_err(|_| SyncError::Blocked("a stored number is not finite".into()))?;
		Ok((writes.iter().map(copy).collect(), digest))
	}
	/// No data at all.
	pub fn is_empty(&self) -> Result<bool> {
		let db = &self.files.read;
		let doc = sql(db.query_row("SELECT 1 FROM documents LIMIT 1", [], |_| Ok(())).optional())?;
		let part = sql(db.query_row("SELECT 1 FROM parts LIMIT 1", [], |_| Ok(())).optional())?;
		Ok(doc.is_none() && part.is_none())
	}
}

/// The store's marker against the configuration in force at `revision`.
fn marker(store: &SyncStoreFile, journal: &SyncJournal, revision: u64) -> Result<Option<Json>> { store.marker(text(&journal.config_at(revision as usize)?, "spaceId")) }
fn binds(m: &Option<Json>, i: &Json) -> bool { m.as_ref().is_some_and(|m| canonical(m) == canonical(&marker_of(i))) }
fn store_for(journal: &mut SyncJournal) -> Result<()> { journal.bind_format(own::FORMAT) }

/// Applies one accepted entry to the store (or recognises it applied), and records it in the journal.
fn apply(store: &mut SyncStoreFile, journal: &mut SyncJournal, intent: &Json, recovered: bool) -> Result<()> {
	let revision = num(intent, "revision") as u64;
	let m = marker(store, journal, revision)?;
	if binds(&m, intent) { return journal.mark_applied(intent, recovered); }
	let previous = if revision > 1 { journal.intent((revision - 1) as f64)? } else { None };
	let agrees = match &m {
		None => revision == 1,
		Some(m) => revision != 1 && text(m, "configHash") == journal.config_hash_at((revision - 1) as usize)? && num(m, "revision") == (revision - 1) as f64 && Some(text(m, "batchHash")) == previous.as_ref().map(|p| text(p, "batchHash")) && Some(text(m, "previousHash")) == previous.as_ref().map(|p| text(p, "previousHash")),
	};
	if !agrees { return blocked("data marker disagrees with the complete journal prefix"); }
	store.commit(&copy(intent.get("deltas").unwrap_or(&Json::Null)).as_array().cloned().unwrap_or_default())?;
	if num(intent, "version") == 3.0 {
		let b = intent.get("bootstrap").unwrap_or(&Json::Null);
		if num(b, "index") == num(b, "total") - 1.0 && store.capture()?.1 != text(b, "storeHash") { return blocked("the bootstrapped replica differs from the captured store"); }
	}
	journal.mark_applied(intent, recovered)
}

fn verify_data_prefix(store: &SyncStoreFile, journal: &SyncJournal) -> Result<()> {
	let applied = journal.applied_revision()?;
	let m = marker(store, journal, applied)?;
	if applied == 0 {
		if m.is_some() { return blocked("untracked replicated data marker"); }
		if !store.is_empty()? { return blocked("bootstrap requires an empty dedicated storage domain"); }
	} else {
		let i = journal.intent(applied as f64)?.expect("an applied entry is stored");
		if !binds(&m, &i) { return blocked("materialized data does not match applied journal prefix"); }
	}
	Ok(())
}

/// Brings an existing, exclusively opened store under primary/sync (an empty journal with a single genesis). Resumable.
pub fn bootstrap_primary_sync(store: &mut SyncStoreFile, journal: &mut SyncJournal, now: f64, chunk_bytes: Option<usize>) -> Result<Json> {
	store_for(journal)?;
	let head = journal.head_revision()?;
	let first = if head > 0 { journal.intent(1.0)? } else { None };
	if head == 0 {
		if durability_of(&journal.config()) != "single" { return blocked("a bootstrap starts single; add the standby afterwards with setStandby"); }
		if marker(store, journal, 0)?.is_some() { return blocked("the store already carries a replication marker"); }
		let (writes, digest) = store.capture()?;
		let limit = chunk_bytes.unwrap_or(journal.max_intent_bytes - 16384).min(journal.max_intent_bytes - 16384);
		let mut chunks: Vec<Vec<Json>> = vec![vec![]];
		let mut size = 0;
		for w in writes {
			let n = canonical(&w).len();
			if n > limit { return blocked(format!("a single record of {n} bytes exceeds the bootstrap chunk budget")); }
			if size + n > limit && !chunks.last().expect("one chunk").is_empty() { chunks.push(vec![]); size = 0; }
			chunks.last_mut().expect("one chunk").push(w);
			size += n;
		}
		if now.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&now) { return blocked("invalid validation timestamp"); }
		journal.seal_bootstrap(&chunks, &digest, now)?;
	} else if first.as_ref().is_none_or(|f| num(f, "version") != 3.0) {
		return blocked("this journal did not start with a bootstrap");
	}
	let first = journal.intent(1.0)?.expect("a bootstrap");
	let b = first.get("bootstrap").cloned().unwrap_or(Json::Null);
	let total = num(&b, "total") as u64;
	if journal.applied_revision()? < total {
		if store.capture()?.1 != text(&b, "storeHash") { return blocked("the store changed since the bootstrap was sealed"); }
		for r in journal.applied_revision()? + 1..=total {
			let i = journal.intent(r as f64)?.expect("a sealed chunk");
			if binds(&marker(store, journal, r)?, &i) { journal.mark_applied(&i, false)?; continue; }
			let deltas = i.get("deltas").and_then(Json::as_array).expect("a chunk has deltas");
			store.commit(&[copy(deltas.last().expect("a marker"))])?;
			journal.mark_applied(&i, false)?;
		}
	}
	Ok(obj! { "revisions" => total as f64, "storeHash" => text(&b, "storeHash"), "writes" => store.capture()?.0.len() as f64 })
}

/// Materializes all accepted decisions on a stopped standby. No promotion permission is implied.
pub fn materialize_sync_history(store: &mut SyncStoreFile, journal: &mut SyncJournal, assert_replica: Option<&dyn Fn() -> Result<()>>) -> Result<()> {
	store_for(journal)?;
	if let Some(a) = assert_replica { a()?; }
	let applied = journal.applied_revision()?;
	let next = if applied < journal.head_revision()? { journal.intent((applied + 1) as f64)? } else { None };
	let current = marker(store, journal, applied)?;
	// a durable data commit can precede the local journal receipt after an interrupted apply
	let interrupted = next.as_ref().is_some_and(|n| current.as_ref().is_some_and(|c| num(c, "revision") == num(n, "revision") && text(c, "batchHash") == text(n, "batchHash")));
	if !interrupted { verify_data_prefix(store, journal)?; }
	let mut r = journal.applied_revision()? + 1;
	while r <= journal.head_revision()? {
		let Some(i) = journal.intent(r as f64)? else { return blocked("missing accepted prefix") };
		apply(store, journal, &i, false)?;
		r += 1;
	}
	Ok(())
}

/// The standby's side of a sealed entry: confirms it (`{revision, hash, configHash}`) or refuses.
pub type Peer<'a> = &'a mut dyn FnMut(&Json) -> Result<Json>;
fn confirms(ack: &Json, i: &Json) -> bool { canonical(ack) == canonical(&obj! { "revision" => num(i, "revision"), "hash" => text(i, "hash"), "configHash" => hash(i.get("config").unwrap_or(&Json::Null)) }) }

/// Resolves the one sealed primary candidate before the host opens. Does not reauthorize its business decision.
pub fn recover_primary_sync(store: &mut SyncStoreFile, journal: &mut SyncJournal, peer: Option<Peer<'_>>, assert_primary: &dyn Fn() -> Result<()>) -> Result<()> {
	store_for(journal)?;
	let (head, applied) = (journal.head_revision()?, journal.applied_revision()?);
	if head.saturating_sub(applied) > 1 { return blocked("primary has more than one unresolved candidate"); }
	if head == applied { return verify_data_prefix(store, journal); }
	let i = journal.intent(head as f64)?.expect("the candidate");
	if !binds(&marker(store, journal, head)?, &i) { verify_data_prefix(store, journal)?; }
	assert_primary()?;
	// a candidate sealed under single durability needs no ACK; under sync only the standby decides it
	if durability_of(&journal.config_at((head - 1) as usize)?) == "sync" {
		let Some(peer) = peer else { return blocked("a sync candidate needs its standby or a fenced degradeToSingle") };
		if !confirms(&peer(&copy(&i))?, &i) { return blocked("standby ACK does not match sealed intent"); }
	}
	assert_primary()?;
	apply(store, journal, &i, false)
}

/// Completes the at most one sealed candidate locally, exactly once, without a standby ACK, after `assert_fenced`.
pub fn recover_sealed_without_standby(store: &mut SyncStoreFile, journal: &mut SyncJournal, assert_fenced: &dyn Fn() -> Result<()>) -> Result<Option<f64>> {
	store_for(journal)?;
	let (head, applied) = (journal.head_revision()?, journal.applied_revision()?);
	if head.saturating_sub(applied) > 1 { return blocked("primary has more than one unresolved candidate"); }
	if head == applied { verify_data_prefix(store, journal)?; return Ok(None); }
	let i = journal.intent(head as f64)?.expect("the candidate");
	if !binds(&marker(store, journal, head)?, &i) { verify_data_prefix(store, journal)?; }
	assert_fenced()?;
	apply(store, journal, &i, true)?;
	Ok(Some(head as f64))
}

/// Seals and applies one configuration change; `peer` confirms it when the new configuration's standby takes part.
/// After sealing, a failure is `CommitSealed`.
pub fn apply_config_transition(store: &mut SyncStoreFile, journal: &mut SyncJournal, next: &Json, reason: &str, peer: Option<Peer<'_>>, assert: &dyn Fn() -> Result<()>, now: f64) -> Result<Json> {
	store_for(journal)?;
	if journal.head_revision()? != journal.applied_revision()? { return blocked("resolve the sealed candidate before a replica transition"); }
	verify_data_prefix(store, journal)?;
	validate_config_transition(&journal.config(), next)?;
	let head = journal.head()?;
	let value = obj! { "configHash" => hash(&config_of(next)?), "revision" => num(&head, "revision") + 1.0, "batchHash" => hash(&Json::Array(vec![])), "previousHash" => text(&head, "hash") };
	let mark = own::marker_write(text(next, "spaceId"), &value);
	if now.fract() != 0.0 || !(0.0..=9_007_199_254_740_991.0).contains(&now) { return blocked("invalid validation timestamp"); }
	assert()?;
	let sealed = journal.seal_transition(next, reason, &mark, now)?;
	let rest = (|| -> Result<()> {
		if let Some(peer) = peer {
			if !confirms(&peer(&copy(&sealed))?, &sealed) { return blocked("standby ACK does not match the replica transition"); }
		}
		assert()?;
		apply(store, journal, &sealed, false)
	})();
	rest.map(|_| sealed.clone()).map_err(|_| SyncError::sealed(&sealed))
}
