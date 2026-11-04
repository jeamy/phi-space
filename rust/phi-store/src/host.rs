//! The store host for one Space document (src/store/host.ts, as the service uses it): every operation is a commit of
//! its own on the document, rolled back when it fails, written as rows when it succeeds (the head whole, the parts by
//! what the commit changed: O(changes)), and acknowledged once those rows are durable.
use crate::files::{Result, StoreError};
use crate::ledger::{MemoryLedger, SqliteLedger, StoredDoc};
use crate::ops::WriteOp;
use crate::writer::{Compaction, Durable};
use crate::parts::{id_of, CLAIM_INDEX, SPACE_PARTS};
use phi_core::space::{Changes, CoreError, Random, Space};
use phi_core::state::{EntryUndo, SpaceState};
use phi_core::{ClaimSource, Claims, DiskClaims};
use std::collections::{HashMap, HashSet, VecDeque};
use std::cell::RefCell;
use std::rc::Rc;
use std::sync::{Arc, Mutex, Weak};

fn claim_source(l: &SqliteLedger, kind: &str, key: Option<&str>) -> Result<Arc<dyn ClaimSource>> {
	Ok(Arc::new(crate::disk::SqliteClaims::open(l.path(), kind, key.unwrap_or(""), "rpc.claims")?))
}

/// The schema version of a Space document (src/doc.ts, src/spaces.ts).
pub const SPACE_VERSION: i64 = 5;

pub enum Ledger {
	Sqlite(Box<SqliteLedger>),
	Memory(MemoryLedger),
}

/// A ledger the documents of one store share; all of them live on the store's owner thread.
pub type SharedLedger = Rc<RefCell<Ledger>>;

pub struct SpaceHost {
	pub(crate) ledger: SharedLedger,
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
	/// A write of this store failed, of this document or another: the host takes no more work (its memory may hold what
	/// never reached the disk; reopen it).
	failure: Option<String>,
	/// Commits handed to the store, and those durable (their numbers: `Committed::seq`).
	handed: u64,
	durable: u64,
	/// Commits on their way to the disk, oldest first.
	unsettled: VecDeque<(u64, Durable)>,
	watches: Vec<Weak<Mutex<WatchSlot>>>,
	/// Rows of another document that belong to the next commit of this one (the registry).
	pub also: Vec<WriteOp>,
}

/// A commit run but perhaps not durable yet: the next commit builds on it at once; an acknowledgement waits for
/// `SpaceHost::durable(seq)`.
/// A commit's rows before they are handed to the store, and what the host learns from them once they are.
struct Plan {
	ops: Vec<WriteOp>,
	new_ords: Vec<(&'static str, String, i64)>,
	gone: Vec<(&'static str, String)>,
	max_ord: Vec<(&'static str, i64)>,
	head: String,
	admitted: usize,
}

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
		let mut on_disk = false;
		let (state, exists, head_text) = match stored {
			None => (SpaceState::initial(), false, None),
			Some(doc) => {
				if doc.version != SPACE_VERSION {
					// core.migrate brings older versions up to date in TypeScript; not ported
					return Err(StoreError::Unavailable(format!("the document {kind} has version {}; the Rust store reads version {SPACE_VERSION} only", doc.version)));
				}
				let mut state = SpaceState::from_value(doc.value).map_err(|e| StoreError::Unavailable(e.to_string()))?;
				on_disk = matches!(ledger, Ledger::Sqlite(_)) && state.rest.contains_key("restoredClaims");
				let head = state.to_json_head().to_json_text();
				// the claims stay on the disk: a map over their rows takes their place
				if let (Ledger::Sqlite(l), Some(r)) = (&ledger, state.rpc.as_mut()) {
					r.claims = Claims::Disk(DiskClaims::new(claim_source(l, kind, key)?));
				}
				(state, true, Some(head))
			}
		};
		drop(guard);
		let mut space = Space::new(state, random);
		space.restored_on_disk = on_disk;
		Ok(SpaceHost { ledger: shared, kind: kind.to_owned(), key: key.map(str::to_owned), space, exists, head_text, max_ord: HashMap::new(), failure: None, handed: 0, durable: 0, unsettled: VecDeque::new(), watches: vec![], also: vec![] })
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
		self.claim_failure(); // a look outside a commit answered for itself
		self.space.begin_tracked_commit();
		let done = op(&mut self.space);
		// what a failed read of the claims decided is not to be kept: this call fails, as in TS
		let done = match self.claim_failure() {
			Some(m) => Err(phi_core::space::error("Error", m)),
			None => done,
		};
		match done {
			Err(e) => {
				self.space.rollback();
				self.also.clear();
				self.space.doc_writes.clear();
				self.space.registry_incarnation = None;
				Ok(Err(e))
			}
			Ok(value) => {
				for (kind, key, version, value) in self.space.doc_writes.drain(..) {
					self.also.push(WriteOp::Doc { kind, key, version, value });
				}
				// a primary/sync primary checks its journal's budget before the commit is published: a refusal leaves no trace
				let gated = matches!(&*self.ledger.borrow(), Ledger::Sqlite(l) if l.gate().is_some());
				let written = if gated {
					let plan = self.plan(&self.space.pending_changes());
					let admitted = match &plan {
						None => Ok(0),
						Some(p) => match &*self.ledger.borrow() {
							Ledger::Sqlite(l) => l.admit(&p.ops),
							Ledger::Memory(_) => Ok(0),
						},
					};
					if let Err(e) = admitted {
						self.space.rollback();
						self.also.clear();
						return Ok(Err(phi_core::space::error(e.name(), e.message())));
					}
					self.space.end_commit();
					self.space.seal();
					self.apply(plan.map(|p| Plan { admitted: admitted.unwrap_or(0), ..p }))
				} else {
					let changes = self.space.end_commit();
					self.space.seal();
					self.write(changes)
				};
				if let Err(e) = written {
					self.fail(&e);
					return Err(e);
				}
				// handed over: a failure from here on is the answer of `durable(seq)`
				let _ = self.pump();
				Ok(Ok(Committed { value, seq: self.handed }))
			}
		}
	}

	/// A commit of documents beside the Spaces alone (`host.commit` of a step that touches no Space): its rows go to the
	/// store as one batch behind every commit handed before, without the Space's document. A primary's journal may refuse
	/// it before anything is written, as it refuses a commit of a Space.
	pub fn commit_documents(&mut self, ops: Vec<WriteOp>) -> Result<std::result::Result<u64, CoreError>> {
		self.pump()?;
		if ops.is_empty() {
			return Ok(Ok(self.handed));
		}
		let shared = self.ledger.clone();
		let mut guard = shared.borrow_mut();
		match &mut *guard {
			Ledger::Memory(l) => {
				l.write_documents(ops)?;
				self.handed += 1;
				self.durable = self.handed;
			}
			Ledger::Sqlite(l) => {
				let admitted = match l.admit(&ops) {
					Ok(n) => n,
					Err(e) => return Ok(Err(phi_core::space::error(e.name(), e.message()))),
				};
				let durable = l.persist_admitted(ops, admitted);
				self.handed += 1;
				self.unsettled.push_back((self.handed, durable));
			}
		}
		drop(guard);
		let _ = self.pump();
		Ok(Ok(self.handed))
	}

	fn claim_failure(&self) -> Option<String> {
		match self.space.state.rpc.as_ref().map(|r| &r.claims) {
			Some(Claims::Disk(d)) => d.take_failure(),
			_ => None,
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
	/// A primary/sync primary's sealed candidate that poisoned the store: `(revision, hash)`.
	pub fn sealed_candidate(&self) -> Option<(f64, String)> {
		match &*self.ledger.borrow() {
			Ledger::Sqlite(l) => l.gate().and_then(|g| g.sealed()),
			Ledger::Memory(_) => None,
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
			self.publish_watches();
		}
		let failed = failed.or_else(|| match &*self.ledger.borrow() {
			Ledger::Sqlite(l) => l.failure(),
			Ledger::Memory(_) => None,
		});
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

	fn publish_watches(&mut self) {
		self.watches.retain(|weak| {
			let Some(slot) = weak.upgrade() else { return false };
			slot.lock().unwrap().pending = Some(self.durable);
			true
		});
	}

	/// A watch from now on.
	pub fn watch(&mut self) -> Watch {
		self.watches.retain(|slot| slot.strong_count() > 0);
		let slot = Arc::new(Mutex::new(WatchSlot::default()));
		self.watches.push(Arc::downgrade(&slot));
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
		if self.failure.is_some() {
			return None;
		}
		match &*self.ledger.borrow() {
			Ledger::Sqlite(l) => l.compact_begin(),
			Ledger::Memory(_) => None,
		}
	}

	fn write(&mut self, c: Changes) -> Result<()> {
		let shared = self.ledger.clone();
		if let Ledger::Memory(ledger) = &mut *shared.borrow_mut() {
			ledger.write_documents(std::mem::take(&mut self.also))?;
			self.exists = true;
			self.handed += 1;
			self.durable = self.handed; // memory: the host holds the only copy
			self.publish_watches();
			return Ok(());
		}
		let plan = self.plan(&c);
		self.apply(plan)
	}

	/// The rows of a commit, without changing anything yet (a primary's store may still refuse them); `None`: nothing
	/// changed, nothing is written.
	fn plan(&mut self, c: &Changes) -> Option<Plan> {
		let shared = self.ledger.clone();
		let mut guard = shared.borrow_mut();
		let Ledger::Sqlite(ledger) = &mut *guard else { return None };
		let kind = self.kind.clone();
		let key = self.key.clone().unwrap_or_default();
		let ords = ledger.ords(&kind, self.key.as_deref());
		let mut parts: Vec<WriteOp> = vec![];
		let state = &self.space.state;
		let mut max_ord: Vec<(&'static str, i64)> = vec![];
		let mut new_ords: Vec<(&'static str, String, i64)> = vec![];
		let mut gone: Vec<(&'static str, String)> = vec![];
		let cleared = |part: &str| c.cleared.contains(&part);
		// parts replaced as a whole: all their rows go first, then every record they hold now is written (below)
		for part in &c.cleared {
			parts.push(WriteOp::PartClear { kind: kind.clone(), key: key.clone(), part: (*part).into() });
			if let Some(m) = ords.get(*part) {
				for id in m.keys() {
					gone.push((part, id.clone()));
				}
			}
		}
		let ords_now = |part: &str, ords: &HashMap<String, HashMap<String, i64>>| if cleared(part) { HashMap::new() } else { ords.get(part).cloned().unwrap_or_default() };

		// entries: what the log names, written as the final array has it
		let touched: HashSet<&str> = c
			.entries
			.iter()
			.map(|u| match u {
				EntryUndo::Pushed(id) => id.as_str(),
				EntryUndo::Removed(_, e) | EntryUndo::Set(_, e) => e.id.as_str(),
			})
			.collect();
		if !touched.is_empty() {
			let part = "entries";
			let empty = HashMap::new();
			let ord = ords.get(part).unwrap_or(&empty);
			let mut max = *self.max_ord.get(part).unwrap_or(&ord.values().copied().max().unwrap_or(-1));
			let mut present = HashSet::new();
			for e in state.entries.iter().filter(|e| touched.contains(e.id.as_str())) {
				present.insert(e.id.as_str());
				let o = match ord.get(&e.id) {
					Some(o) => *o,
					None => {
						max += 1;
						new_ords.push((part, e.id.clone(), max));
						max
					}
				};
				parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id: e.id.clone(), ord: o, value: e.to_json().to_json_text(), at: None, grp: None, flag: None });
			}
			for id in touched.iter().filter(|id| !present.contains(**id) && ord.contains_key(**id)) {
				parts.push(WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.to_string() });
				gone.push((part, id.to_string()));
			}
			max_ord.push((part, max));
		}
		// the stream log: batches after the revision the commit began with are new; dropped ones go
		if let Some(st) = &state.stream {
			let part = "stream.log";
			let fresh = c.log_replaced;
			let ord = &ords_now(part, ords);
			let mut max = *self.max_ord.get(part).unwrap_or(&ord.values().copied().max().unwrap_or(-1));
			if fresh {
				// replaced as a whole (a restore): compared with what the rows hold, as store/parts.ts compares an array
				let mut was: Vec<(&String, i64)> = ord.iter().map(|(k, o)| (k, *o)).collect();
				was.sort_by_key(|(_, o)| *o);
				let now: Vec<(String, phi_json::Json)> = st.log.iter().map(|b| { let v = b.to_json(); (id_of(&v), v) }).collect();
				let (mut j, mut changed, mut gone_ids) = (0usize, vec![], vec![]);
				for (id, _) in &was {
					if j < now.len() && now[j].0 == **id {
						changed.push(j);
						j += 1;
					} else {
						gone_ids.push((*id).clone());
					}
				}
				let added = &now[j..];
				let moved = added.iter().any(|(id, _)| ord.contains_key(id));
				if !moved {
					for id in gone_ids {
						parts.push(WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.clone() });
						gone.push((part, id));
					}
					for i in changed {
						parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id: now[i].0.clone(), ord: ord[&now[i].0], value: now[i].1.to_json_text(), at: None, grp: None, flag: None });
					}
					for (id, v) in added {
						max += 1;
						new_ords.push((part, id.clone(), max));
						parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.clone(), ord: max, value: v.to_json_text(), at: None, grp: None, flag: None });
					}
				} else {
					// a batch that only moved: the part is numbered anew
					for (id, _) in &was {
						if !now.iter().any(|(n, _)| n == *id) {
							parts.push(WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: part.into(), id: (*id).clone() });
							gone.push((part, (*id).clone()));
						}
					}
					for (i, (id, v)) in now.iter().enumerate() {
						new_ords.push((part, id.clone(), i as i64));
						parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id: id.clone(), ord: i as i64, value: v.to_json_text(), at: None, grp: None, flag: None });
					}
					max = now.len() as i64 - 1;
				}
			} else {
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
							max += 1;
							new_ords.push((part, id.clone(), max));
							max
						}
					};
					parts.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: part.into(), id, ord: o, value: value.to_json_text(), at: None, grp: None, flag: None });
				}
			}
			max_ord.push((part, max));
		}
		// claims and generations by key (all of a map replaced as a whole)
		if let Some(r) = &state.rpc {
			let claim_keys: Vec<String> = if cleared("rpc.claims") { r.claims.entries().keys().map(str::to_owned).collect() } else { c.claims.clone() };
			let generation_keys = c.generations.clone();
			for k in &claim_keys {
				parts.push(match r.claims.get(k) {
					Some(v) => {
						let (at, grp, flag) = CLAIM_INDEX.values(&v);
						WriteOp::Part { kind: kind.clone(), key: key.clone(), part: "rpc.claims".into(), id: k.clone(), ord: 0, value: v.to_json_text(), at, grp, flag }
					}
					None => WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: "rpc.claims".into(), id: k.clone() },
				});
			}
			for k in &generation_keys {
				parts.push(match r.generations.get(k) {
					Some(v) => WriteOp::Part { kind: kind.clone(), key: key.clone(), part: "rpc.generations".into(), id: k.clone(), ord: 0, value: v.to_json_text(), at: None, grp: None, flag: None },
					None => WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: "rpc.generations".into(), id: k.clone() },
				});
			}
		}
		// the historical claims a restore leaves, by key
		let restored = state.rest.get("restoredClaims").and_then(phi_json::Json::as_object);
		for k in &c.restored {
			parts.push(match restored.and_then(|m| m.get(k)) {
				Some(v) => {
					let (at, grp, flag) = CLAIM_INDEX.values(v);
					WriteOp::Part { kind: kind.clone(), key: key.clone(), part: "restoredClaims".into(), id: k.clone(), ord: 0, value: v.to_json_text(), at, grp, flag }
				}
				None => WriteOp::PartDel { kind: kind.clone(), key: key.clone(), part: "restoredClaims".into(), id: k.clone() },
			});
		}
		let head = state.to_json_head().to_json_text();
		if self.exists && parts.is_empty() && self.also.is_empty() && self.head_text.as_deref() == Some(head.as_str()) {
			return None; // nothing changed: nothing is written
		}
		let mut ops = vec![WriteOp::Doc { kind, key, version: SPACE_VERSION, value: head.clone() }];
		ops.extend(self.also.iter().cloned());
		ops.extend(parts);
		Some(Plan { ops, new_ords, gone, max_ord, head, admitted: 0 })
	}

	/// Hands a planned commit to the store; the orders it learnt are kept from now on.
	fn apply(&mut self, plan: Option<Plan>) -> Result<()> {
		self.also.clear();
		let Some(Plan { ops, new_ords, gone, max_ord, head, admitted }) = plan else { return Ok(()) };
		let shared = self.ledger.clone();
		let mut guard = shared.borrow_mut();
		let Ledger::Sqlite(ledger) = &mut *guard else { unreachable!("a plan is made for a SQLite store") };
		let kind = self.kind.clone();
		let ords = ledger.ords(&kind, self.key.as_deref());
		for (part, max) in max_ord {
			self.max_ord.insert(part.into(), max);
		}
		for (part, id, o) in new_ords {
			ords.entry(part.into()).or_default().insert(id, o);
		}
		for (part, id) in gone {
			if let Some(m) = ords.get_mut(part) {
				m.remove(&id);
			}
		}
		let durable = ledger.persist_admitted(ops, admitted);
		self.handed += 1;
		self.unsettled.push_back((self.handed, durable));
		self.head_text = Some(head);
		self.exists = true;
		// the historical claims are a map part on the disk from now on: their bytes are the tally (restoredBytes)
		if self.space.state.rest.contains_key("restoredClaims") {
			self.space.restored_on_disk = true;
		}
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
		for w in self.watches.iter().filter_map(Weak::upgrade) {
			w.lock().unwrap().closed = true;
		}
		drop(self.space); // its claims connection goes before the owner lock
		// the last document of the store closes it
		if let Ok(Ledger::Sqlite(l)) = Rc::try_unwrap(self.ledger).map(RefCell::into_inner) {
			(*l).close();
		}
	}
	/// Waits for everything handed over; the store's failure, if it failed.
	pub fn drain(&mut self) -> Result<()> { self.durable(self.handed) }
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn cancelled_watches_release_slots_and_do_not_accumulate() {
		let mut host = SpaceHost::open(Ledger::Memory(MemoryLedger::default()), "phi-spaces.space", None, phi_core::driver::seeded("watch")).unwrap();
		for _ in 0..1000 { drop(host.watch()); }
		let active = host.watch();
		assert_eq!(host.watches.len(), 1);
		host.commit(|_| Ok(())).unwrap().unwrap();
		assert_eq!(active.poll(), Some(host.durable_count()));
		drop(active);
		host.commit(|_| Ok(())).unwrap().unwrap();
		assert!(host.watches.is_empty());
		let last = host.watch();
		host.close();
		assert!(last.closed());
	}
}
