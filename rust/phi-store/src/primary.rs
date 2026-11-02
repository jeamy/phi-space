//! A primary's store under its primary/sync journal (src/store/sync-sqlite.ts `primaryReplication`): every writer batch is
//! sealed in the journal, confirmed by the standby, and only then written, its rows and the marker in one transaction.
//! The journal's budget is checked per commit on the owner thread before the commit is published (`PrimaryGate::admit`),
//! so a refusal leaves no trace; the writer's thread seals (`Replication`). A batch that fails after sealing poisons the
//! store: its commits fail as `CommitSealed`, everything after with the poisoned refusal, and the candidate stays named
//! (`PrimaryGate::sealed`) until the store is reopened and the candidate resolved (`sync_store::recover_primary_sync`).
use crate::ops::{deltas, delta_bytes, WriteOp};
use crate::sync::{canonical, copy, durability_of, hash, num, own, text, SyncError, SyncJournal};
use crate::writer::Replication;
use phi_json::{obj, parse, Json};
use rusqlite::{Connection, OptionalExtension};
use std::sync::{Arc, Mutex, MutexGuard};

pub const POISONED: &str = "poisoned by a sealed candidate: restart and resolve sealed history before more work";

/// The standby of a primary: it accepts a sealed entry and answers its ACK (`PrimarySyncPeer.accept`).
pub trait SyncPeer: Send {
	fn accept(&mut self, intent: &Json) -> crate::sync::Result<Json>;
}

/// What a primary is given besides its journal: the standby, the checks of its role and the clock.
pub struct PrimaryOptions {
	pub peer: Option<Box<dyn SyncPeer>>,
	/// `assertPrimary`: this host holds the primary's permit (and is not fenced).
	pub assert_primary: Box<dyn FnMut() -> crate::sync::Result<()> + Send>,
	pub now: Box<dyn FnMut() -> f64 + Send>,
}

struct Shared {
	journal: SyncJournal,
	/// Bytes admitted and not yet sealed, twice (an entry encodes its rows once more).
	pending: usize,
	/// The candidate that poisoned the store.
	poisoned: Option<(f64, String)>,
}

/// The owner thread's side: the budget, and the candidate that poisoned the store.
#[derive(Clone)]
pub struct PrimaryGate(Arc<Mutex<Shared>>);

fn lock(s: &Mutex<Shared>) -> MutexGuard<'_, Shared> { s.lock().unwrap_or_else(std::sync::PoisonError::into_inner) }
/// An entry carries its rows, the marker and its frame; a commit must fit one entry with room for that.
fn max_batch(journal: &SyncJournal) -> usize { journal.max_intent_bytes.saturating_sub(16 * 1024) }

impl PrimaryGate {
	/// Per commit, before it is published: it must fit one journal entry, and the history must hold it. The bytes it is
	/// admitted with go to the writer with it.
	pub fn admit(&self, ops: &[WriteOp]) -> crate::sync::Result<usize> {
		let mut s = lock(&self.0);
		let bytes = delta_bytes(ops);
		let (most, max) = (max_batch(&s.journal), s.journal.max_intent_bytes);
		if bytes > most {
			return Err(SyncError::Full(format!("the commit's rows ({bytes} bytes) do not fit one sync journal entry (at most {max} bytes)")));
		}
		if s.journal.history_bytes()? + s.pending + bytes * 2 > s.journal.max_history_bytes {
			return Err(SyncError::Full("sync history is full; no committed result was discarded".into()));
		}
		s.pending += bytes * 2;
		Ok(bytes)
	}
	/// The sealed candidate that poisoned the store: `{revision, hash}`.
	pub fn sealed(&self) -> Option<(f64, String)> { lock(&self.0).poisoned.clone() }
	/// The journal, for what the owner reads of it while the store is open (its head, the promotion evidence).
	pub fn journal<T>(&self, f: impl FnOnce(&mut SyncJournal) -> T) -> T { f(&mut lock(&self.0).journal) }
	/// The journal back, once the store is closed.
	pub fn into_journal(self) -> Result<SyncJournal, PrimaryGate> {
		Arc::try_unwrap(self.0).map(|m| m.into_inner().unwrap_or_else(std::sync::PoisonError::into_inner).journal).map_err(PrimaryGate)
	}
}

/// The writer's side (`Replication`) and the owner's (`PrimaryGate`) of a primary over `journal`.
pub fn primary_replication(journal: SyncJournal, o: PrimaryOptions) -> (Box<dyn Replication>, PrimaryGate) {
	let shared = Arc::new(Mutex::new(Shared { journal, pending: 0, poisoned: None }));
	let max_batch_bytes = max_batch(&lock(&shared).journal);
	(Box::new(Primary { shared: Arc::clone(&shared), o, sealed: None, max_batch_bytes }), PrimaryGate(shared))
}

struct Primary {
	shared: Arc<Mutex<Shared>>,
	o: PrimaryOptions,
	/// The sealed entry of the batch being written.
	sealed: Option<Json>,
	max_batch_bytes: usize,
}

fn marker(db: &Connection, space_id: &str) -> crate::sync::Result<Option<Json>> {
	let v: Option<String> = crate::sync::sql(db.query_row("SELECT value FROM store_meta WHERE key = ?", [own::marker_key(space_id)], |r| r.get(0)).optional())?;
	Ok(v.and_then(|v| parse(&v).ok()))
}

impl Primary {
	fn seal_batch(&mut self, db: &Connection, rows: &[WriteOp], admitted: usize) -> crate::sync::Result<Vec<WriteOp>> {
		let mut s = lock(&self.shared);
		s.pending = s.pending.saturating_sub(admitted * 2); // exactly what admit counted for this batch's commits
		if s.poisoned.is_some() || s.journal.head_revision()? != s.journal.applied_revision()? {
			return Err(SyncError::Blocked(POISONED.into()));
		}
		drop(s);
		(self.o.assert_primary)()?;
		let mut s = lock(&self.shared);
		let j = &mut s.journal;
		let config = j.config();
		let space_id = text(&config, "spaceId").to_owned();
		let head = j.head()?;
		let revision = num(&head, "revision");
		let m = marker(db, &space_id)?;
		// the file's marker is the journal's head: nothing was written past the journal, nothing is missing
		let fits = match (&m, revision == 0.0) {
			(None, true) => true,
			(Some(_), true) => false,
			(None, false) => false,
			(Some(m), false) => num(m, "revision") == revision && text(m, "configHash") == j.config_hash() && j.intent(revision)?.is_some_and(|i| text(&i, "batchHash") == text(m, "batchHash")),
		};
		if !fits {
			return Err(SyncError::Blocked("replication data marker differs from local history".into()));
		}
		let sync = durability_of(&config) == "sync";
		if sync && self.o.peer.is_none() {
			return Err(SyncError::Blocked("sync writes need a confirming standby".into()));
		}
		let rows = deltas(rows);
		let value = obj! { "configHash" => j.config_hash(), "revision" => revision + 1.0, "batchHash" => hash(&rows), "previousHash" => text(&head, "hash") };
		let mark = own::marker_write(&space_id, &value);
		drop(s);
		let now = (self.o.now)();
		(self.o.assert_primary)()?;
		let mut s = lock(&self.shared);
		let mut all = rows.as_array().cloned().unwrap_or_default();
		all.push(mark.clone());
		let sealed = s.journal.seal(&all, now)?;
		let config_hash = s.journal.config_hash();
		drop(s); // the standby is waited for without the journal: the owner reads it meanwhile
		self.sealed = Some(sealed.clone());
		if sync {
			let ack = self.o.peer.as_mut().expect("checked above").accept(&copy(&sealed))?;
			if canonical(&ack) != canonical(&obj! { "revision" => num(&sealed, "revision"), "hash" => text(&sealed, "hash"), "configHash" => config_hash }) {
				return Err(SyncError::Blocked("standby ACK does not match sealed intent".into()));
			}
		}
		(self.o.assert_primary)()?;
		Ok(vec![WriteOp::Meta { key: text(&mark, "key").to_owned(), value: text(&mark, "value").to_owned() }])
	}
}

impl Replication for Primary {
	fn max_batch_bytes(&self) -> usize { self.max_batch_bytes }
	fn seal(&mut self, db: &Connection, rows: &[WriteOp], admitted: usize) -> Result<Vec<WriteOp>, String> { self.seal_batch(db, rows, admitted).map_err(|e| e.to_string()) }
	fn applied(&mut self) -> Result<(), String> {
		let Some(i) = self.sealed.take() else { return Err("no sealed batch to apply".into()) };
		lock(&self.shared).journal.mark_applied(&i, false).map_err(|e| e.to_string())
	}
	fn failed(&mut self, cause: String) -> (String, Option<String>) {
		let Some(i) = self.sealed.take() else { return (cause, None) };
		// sealed and not confirmed or not written: its commits are CommitSealed, everything after waits for recovery
		lock(&self.shared).poisoned = Some((num(&i, "revision"), text(&i, "hash").to_owned()));
		(SyncError::sealed(&i).to_string(), Some(POISONED.into()))
	}
}
