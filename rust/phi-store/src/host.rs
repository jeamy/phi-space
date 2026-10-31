//! The store host for one Space document (src/store/host.ts, as the service uses it): every operation is a commit of
//! its own on the document, rolled back when it fails, written as rows when it succeeds (the head whole, the parts by
//! what the commit changed: O(changes)), and acknowledged once those rows are durable.
use crate::files::{Result, StoreError};
use crate::ledger::{MemoryLedger, Ords, SqliteLedger, StoredDoc};
use crate::ops::WriteOp;
use crate::writer::{Compaction, Durable};
use crate::parts::{id_of, PartDef, SPACE_PARTS};
use phi_core::space::{Changes, CoreError, Random, Space};
use phi_core::state::{EntryUndo, SpaceState};
use phi_core::{ClaimSource, Claims, DiskClaims};
use std::collections::VecDeque;
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex};

fn claim_source(l: &SqliteLedger, kind: &str, key: Option<&str>) -> Result<Arc<dyn ClaimSource>> {
	Ok(Arc::new(crate::disk::SqliteClaims::open(l.path(), kind, key.unwrap_or(""), "rpc.claims")?))
}
use phi_json::Json;
use std::collections::{HashMap, HashSet};

/// The schema version of a Space document (src/doc.ts, src/spaces.ts).
pub const SPACE_VERSION: i64 = 5;

pub enum Ledger {
	Sqlite(Box<SqliteLedger>),
	Memory(MemoryLedger),
}

/// A ledger the documents of one store share; all of them live on the store's owner thread.
pub type SharedLedger = Rc<RefCell<Ledger>>;

pub struct SpaceHost {
	ledger: SharedLedger,
	kind: String,
	key: Option<String>,
	pub space: Space,
	/// The document is stored (a new one is written by its first commit, whatever that changes).
	exists: bool,
	/// The head as last written: a commit that changes neither it nor a part writes nothing.
	head_text: Option<String>,
	/// The highest order of each array part, kept beside its orders as parts.ts does (it only grows, so an order is
	/// never used twice while the document stays in memory).
	max_ord: HashMap<String, i64>,
	/// A write failed: the host takes no more work (its memory may hold what never reached the disk; reopen it).
	failure: Option<String>,
	/// Commits handed to the store, and those durable (their numbers: `Committed::seq`).
	handed: u64,
	durable: u64,
	/// Commits on their way to the disk, oldest first.
	unsettled: VecDeque<(u64, Durable)>,
	watches: Vec<Arc<Mutex<WatchSlot>>>,
	/// Rows of another document that belong to the next commit of this one (the registry).
	pub also: Vec<WriteOp>,
}

/// A commit run but perhaps not durable yet: the next commit builds on it at once; an acknowledgement waits for
/// `SpaceHost::durable(seq)`.
pub struct Committed<T> {
	pub value: T,
	pub seq: u64,
}

#[derive(Default)]
struct WatchSlot {
	pending: Option<u64>,
	closed: bool,
}
/// A watch of the document: it hears of durable commits only, and what comes while nobody looks is merged into one
/// (the latest commit number). The value is read through `SpaceHost::committed`.
pub struct Watch(Arc<Mutex<WatchSlot>>);
impl Watch {
	/// The newest durable commit since the last look.
	pub fn poll(&self) -> Option<u64> { self.0.lock().unwrap().pending.take() }
	/// The host was closed.
	pub fn closed(&self) -> bool { self.0.lock().unwrap().closed }
}

fn claim_index(v: &Json) -> (Option<f64>, Option<String>, Option<i64>) {
	(v.get("decidedAt").and_then(Json::as_f64), v.get("generation").and_then(Json::as_str).map(str::to_owned), Some(i64::from(phi_core::space::truthy(v.get("resultExpired")))))
}

impl SpaceHost {
	/// The host over `ledger` for the Space document `kind`/`key`: read from the store, or a new one.
	pub fn sqlite(l: SqliteLedger) -> Ledger { Ledger::Sqlite(Box::new(l)) }
	pub fn open(ledger: Ledger, kind: &str, key: Option<&str>, random: Random) -> Result<SpaceHost> { SpaceHost::open_shared(Rc::new(RefCell::new(ledger)), kind, key, random) }
	/// The same over a ledger other documents use too.
	pub fn open_shared(shared: SharedLedger, kind: &str, key: Option<&str>, random: Random) -> Result<SpaceHost> {
		let mut guard = shared.borrow_mut();
		let ledger = &mut *guard;
		let stored = match &mut *ledger {
			Ledger::Sqlite(l) => l.load(kind, key, SPACE_PARTS)?,
			Ledger::Memory(l) => l.load(kind, key),
		};
		let (state, exists, head_text) = match stored {
			None => (SpaceState::initial(), false, None),
			Some(doc) => {
				if doc.version != SPACE_VERSION {
					// core.migrate brings older versions up to date in TypeScript; not ported
					return Err(StoreError::Unavailable(format!("the document {kind} has version {}; the Rust store reads version {SPACE_VERSION} only", doc.version)));
				}
				let mut state = SpaceState::from_json(&doc.value).map_err(|e| StoreError::Unavailable(e.to_string()))?;
				let head = state.to_json_head().to_json_text();
				// the claims stay on the disk: a map over their rows takes their place
				if let (Ledger::Sqlite(l), Some(r)) = (&ledger, state.rpc.as_mut()) {
					if l.unported_claims(kind, key)? {
						return Err(StoreError::Unavailable(format!("the document {kind} holds claims of a kind the Rust store does not read yet")));
					}
					r.claims = Claims::Disk(DiskClaims::new(claim_source(l, kind, key)?));
				}
				(state, true, Some(head))
			}
		};
		drop(guard);
		Ok(SpaceHost { ledger: shared, kind: kind.to_owned(), key: key.map(str::to_owned), space: Space::new(state, random), exists, head_text, max_ord: HashMap::new(), failure: None, handed: 0, durable: 0, unsettled: VecDeque::new(), watches: vec![], also: vec![] })
	}

	/// Runs `op` as one commit and waits until it is durable: its result, or its error with nothing of it kept. A store
	/// that fails to write fails this commit and takes no more.
	pub fn commit<T>(&mut self, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<T, CoreError>> {
		match self.start_commit(op)? {
			Err(e) => {
				self.durable(self.handed)?; // it may have read what is not durable yet
				Ok(Err(e))
			}
			Ok(c) => {
				self.durable(c.seq)?;
				Ok(Ok(c.value))
			}
		}
	}

	/// Runs `op` as one commit and hands its rows to the store without waiting: the next commit sees it at once
	/// (`Space::state` is ahead of the disk until then); `durable`, `committed` and watches see it once it is written.
	pub fn start_commit<T>(&mut self, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<Committed<T>, CoreError>> {
		self.pump()?;
		let stamp = self.handed + 1;
		if let Some(Claims::Disk(d)) = self.space.state.rpc.as_mut().map(|r| &mut r.claims) {
			d.stamp = stamp;
		}
		self.space.begin_tracked_commit();
		match op(&mut self.space) {
			Err(e) => {
				self.space.rollback();
				self.also.clear();
				Ok(Err(e))
			}
			Ok(value) => {
				let changes = self.space.end_commit();
				self.space.seal();
				if let Err(e) = self.write(changes) {
					self.fail(&e);
					return Err(e);
				}
				self.pump()?;
				Ok(Ok(Committed { value, seq: self.handed }))
			}
		}
	}

	fn fail(&mut self, e: &StoreError) {
		self.failure.get_or_insert_with(|| match e {
			StoreError::Failed(m) => m.clone(),
			other => other.to_string(),
		});
	}

	pub(crate) fn set_waker(&self, waker: crate::writer::Waker) {
		if let Ledger::Sqlite(l) = &*self.ledger.borrow() {
			l.set_waker(waker);
		}
	}
	pub fn handed_count(&self) -> u64 { self.handed }
	pub fn durable_count(&self) -> u64 { self.durable }

	/// Takes in what the store has made durable: claims it wrote are read from the disk from now on, watches hear of it.
	pub fn pump(&mut self) -> Result<()> { self.settle(0) }

	/// Waits until commit `seq` is durable.
	pub fn durable(&mut self, seq: u64) -> Result<()> { self.settle(seq) }

	fn settle(&mut self, until: u64) -> Result<()> {
		if let Some(f) = &self.failure {
			return Err(StoreError::Failed(f.clone()));
		}
		let before = self.durable;
		let mut failed = None;
		while let Some((seq, rx)) = self.unsettled.front() {
			let seq = *seq;
			let r = if seq <= until {
				rx.recv().map_err(|_| "the writer is gone".to_owned())
			} else {
				match rx.try_recv() {
					Ok(r) => Ok(r),
					Err(std::sync::mpsc::TryRecvError::Empty) => break,
					Err(std::sync::mpsc::TryRecvError::Disconnected) => Err("the writer is gone".to_owned()),
				}
			};
			match r.and_then(|r| r) {
				Ok(()) => {
					self.unsettled.pop_front();
					self.durable = seq;
				}
				Err(m) => {
					failed = Some(m);
					break;
				}
			}
		}
		if self.durable != before {
			if let Some(Claims::Disk(d)) = self.space.state.rpc.as_mut().map(|r| &mut r.claims) {
				d.settle(self.durable);
			}
			for w in &self.watches {
				w.lock().unwrap().pending = Some(self.durable);
			}
		}
		if let Some(m) = failed {
			let e = StoreError::Failed(m);
			self.fail(&e);
			return Err(e);
		}
		Ok(())
	}

	/// The committed state as a reader outside a commit sees it: waits for what is on its way to the disk.
	pub fn committed(&mut self) -> Result<&SpaceState> {
		self.durable(self.handed)?;
		Ok(&self.space.state)
	}

	/// A watch from now on.
	pub fn watch(&mut self) -> Watch {
		let slot = Arc::new(Mutex::new(WatchSlot::default()));
		self.watches.push(slot.clone());
		Watch(slot)
	}

	/// Gives the file's free pages back between two batches; the commits that come meanwhile wait for it.
	pub fn compact(&mut self) -> Result<Option<Compaction>> {
		if let Some(f) = &self.failure {
			return Err(StoreError::Failed(f.clone()));
		}
		match &*self.ledger.borrow() {
			Ledger::Sqlite(l) => l.compact().map(Some),
			Ledger::Memory(_) => Ok(None),
		}
	}

	/// `compact`, for a host that serves meanwhile: nothing in memory, and no waiting for the answer.
	pub fn compact_begin(&self) -> Option<std::sync::mpsc::Receiver<Compaction>> {
		match &*self.ledger.borrow() {
			Ledger::Sqlite(l) => l.compact_begin(),
			Ledger::Memory(_) => None,
		}
	}

	fn write(&mut self, c: Changes) -> Result<()> {
		let shared = self.ledger.clone();
		let mut guard = shared.borrow_mut();
		let Ledger::Sqlite(ledger) = &mut *guard else {
			self.also.clear();
			self.exists = true;
			self.handed += 1;
			self.durable = self.handed; // memory: the host holds the only copy
			for w in &self.watches {
				w.lock().unwrap().pending = Some(self.durable);
			}
			return Ok(());
		};
		let kind = self.kind.clone();
		let key = self.key.clone().unwrap_or_default();
		let ords = ledger.ords(&kind, self.key.as_deref());
		let mut parts: Vec<WriteOp> = vec![];
		let state = &self.space.state;

		// entries: what the log names, written as the final array has it
		let touched: HashSet<&str> = c
			.entries
			.iter()
			.map(|u| match u {
				EntryUndo::Pushed(id) => id.as_str(),
				EntryUndo::Removed(_, e) | EntryUndo::Set(_, e) => e.id.as_str(),
			})
			.collect();
		let mut new_ords: Vec<(&str, String, i64)> = vec![];
		let mut gone: Vec<(&str, String)> = vec![];
		if !touched.is_empty() {
			let part = "entries";
			let ord = ords.entry(part.into()).or_default();
			let max = self.max_ord.entry(part.into()).or_insert_with(|| ord.values().copied().max().unwrap_or(-1));
			let mut present = HashSet::new();
			for e in state.entries.iter().filter(|e| touched.contains(e.id.as_str())) {
				present.insert(e.id.as_str());
				let o = match ord.get(&e.id) {
					Some(o) => *o,
					None => {
						*max += 1;
						new_ords.push((part, e.id.clone(), *max));
						*max
					}
				};
				parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id: e.id.clone(), ord: o, value: e.to_json().to_json_text(), at: None, grp: None, flag: None });
			}
			for id in touched.iter().filter(|id| !present.contains(**id) && ord.contains_key(**id)) {
				parts.push(WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.to_string() });
				gone.push((part, id.to_string()));
			}
		}
		// the stream log: batches after the revision the commit began with are new; dropped ones go
		if let Some(st) = &state.stream {
			let part = "stream.log";
			let ord = ords.entry(part.into()).or_default();
			let max = self.max_ord.entry(part.into()).or_insert_with(|| ord.values().copied().max().unwrap_or(-1));
			for rev in &c.dropped_revs {
				let id = id_of(&phi_json::obj! { "rev" => *rev });
				if ord.contains_key(&id) {
					parts.push(WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.clone() });
					gone.push((part, id));
				}
			}
			for b in st.log.iter().filter(|b| b.rev > c.stream_rev) {
				let value = b.to_json();
				let id = id_of(&value);
				let o = match ord.get(&id) {
					Some(o) => *o,
					None => {
						*max += 1;
						new_ords.push((part, id.clone(), *max));
						*max
					}
				};
				parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id, ord: o, value: value.to_json_text(), at: None, grp: None, flag: None });
			}
		}
		// claims and generations by key
		if let Some(r) = &state.rpc {
			for k in &c.claims {
				parts.push(match r.claims.get(k) {
					Some(v) => {
						let (at, grp, flag) = claim_index(&v);
						WriteOp::Part { kind: kind.clone(), key: key.clone(), part: "rpc.claims".into(), id: k.clone(), ord: 0, value: v.to_json_text(), at, grp, flag }
					}
					None => WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: "rpc.claims".into(), id: k.clone() },
				});
			}
			for k in &c.generations {
				parts.push(match r.generations.get(k) {
					Some(v) => WriteOp::Part { kind: kind.clone(), key: key.clone(), part: "rpc.generations".into(), id: k.clone(), ord: 0, value: v.to_json_text(), at: None, grp: None, flag: None },
					None => WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: "rpc.generations".into(), id: k.clone() },
				});
			}
		}
		let head = state.to_json_head().to_json_text();
		if self.exists && parts.is_empty() && self.also.is_empty() && self.head_text.as_deref() == Some(head.as_str()) {
			return Ok(()); // nothing changed: nothing is written
		}
		for (part, id, o) in new_ords {
			ords.entry(part.into()).or_default().insert(id, o);
		}
		for (part, id) in gone {
			if let Some(m) = ords.get_mut(part) {
				m.remove(&id);
			}
		}
		let mut ops = vec![WriteOp::Doc { kind: kind.clone(), key, version: SPACE_VERSION, value: head.clone() }];
		ops.append(&mut self.also);
		ops.extend(parts);
		let durable = ledger.persist(ops);
		self.handed += 1;
		self.unsettled.push_back((self.handed, durable));
		self.head_text = Some(head);
		self.exists = true;
		// a map still in memory goes on the disk from now on (DiskMap.adopt): held until this commit is durable
		if let Some(Claims::Memory(m)) = self.space.state.rpc.as_ref().map(|r| &r.claims) {
			let adopted = DiskClaims::adopt(claim_source(ledger, &kind, self.key.as_deref())?, m, self.handed);
			self.space.state.rpc.as_mut().expect("just seen").claims = Claims::Disk(adopted);
		}
		Ok(())
	}

	/// The committed document, as a store reads it back.
	pub fn stored(&self) -> StoredDoc { StoredDoc { kind: self.kind.clone(), key: self.key.clone(), version: SPACE_VERSION, value: self.space.state.to_json() } }

	/// Writes what is pending and closes the store: commits still on their way are written first (`drain` says whether
	/// they were), watches end.
	pub fn close(self) {
		for w in &self.watches {
			w.lock().unwrap().closed = true;
		}
		// the last document of the store closes it
		if let Ok(Ledger::Sqlite(l)) = Rc::try_unwrap(self.ledger).map(RefCell::into_inner) {
			(*l).close();
		}
	}
	/// Waits for everything handed over; the store's failure, if it failed.
	pub fn drain(&mut self) -> Result<()> { self.durable(self.handed) }
	pub fn parts() -> &'static [PartDef] { SPACE_PARTS }
	#[doc(hidden)]
	pub fn ords_of(&mut self) -> Option<Ords> {
		match &mut *self.ledger.borrow_mut() {
			Ledger::Sqlite(l) => Some(l.ords(&self.kind, self.key.as_deref()).clone()),
			Ledger::Memory(_) => None,
		}
	}
}
