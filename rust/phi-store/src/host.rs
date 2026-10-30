//! The store host for one Space document (src/store/host.ts, as the service uses it): every operation is a commit of
//! its own on the document, rolled back when it fails, written as rows when it succeeds (the head whole, the parts by
//! what the commit changed: O(changes)), and acknowledged once those rows are durable.
use crate::files::{Result, StoreError};
use crate::ledger::{MemoryLedger, Ords, SqliteLedger, StoredDoc};
use crate::ops::WriteOp;
use crate::parts::{id_of, PartDef, SPACE_PARTS};
use phi_core::space::{Changes, CoreError, Random, Space};
use phi_core::state::{EntryUndo, SpaceState};
use phi_json::Json;
use std::collections::{HashMap, HashSet};

/// The schema version of a Space document (src/doc.ts, src/spaces.ts).
pub const SPACE_VERSION: i64 = 5;

pub enum Ledger {
	Sqlite(Box<SqliteLedger>),
	Memory(MemoryLedger),
}

pub struct SpaceHost {
	ledger: Ledger,
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
}

fn claim_index(v: &Json) -> (Option<f64>, Option<String>, Option<i64>) {
	(v.get("decidedAt").and_then(Json::as_f64), v.get("generation").and_then(Json::as_str).map(str::to_owned), Some(i64::from(phi_core::space::truthy(v.get("resultExpired")))))
}

impl SpaceHost {
	/// The host over `ledger` for the Space document `kind`/`key`: read from the store, or a new one.
	pub fn sqlite(l: SqliteLedger) -> Ledger { Ledger::Sqlite(Box::new(l)) }
	pub fn open(mut ledger: Ledger, kind: &str, key: Option<&str>, random: Random) -> Result<SpaceHost> {
		let stored = match &mut ledger {
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
				let state = SpaceState::from_json(&doc.value).map_err(|e| StoreError::Unavailable(e.to_string()))?;
				let head = state.to_json_head().to_json_text();
				(state, true, Some(head))
			}
		};
		Ok(SpaceHost { ledger, kind: kind.to_owned(), key: key.map(str::to_owned), space: Space::new(state, random), exists, head_text, max_ord: HashMap::new() })
	}

	/// Runs `op` as one commit: its result, or its error with nothing of it kept. A store that fails to write fails this
	/// commit and takes no more.
	pub fn commit<T>(&mut self, op: impl FnOnce(&mut Space) -> std::result::Result<T, CoreError>) -> Result<std::result::Result<T, CoreError>> {
		let on_disk = matches!(self.ledger, Ledger::Sqlite(_)) && self.exists && self.space.state.rpc.is_some();
		self.space.begin_tracked_commit(on_disk);
		match op(&mut self.space) {
			Err(e) => {
				self.space.rollback();
				Ok(Err(e))
			}
			Ok(v) => {
				let changes = self.space.end_commit();
				self.space.seal();
				self.write(changes)?;
				Ok(Ok(v))
			}
		}
	}

	fn write(&mut self, c: Changes) -> Result<()> {
		let Ledger::Sqlite(ledger) = &mut self.ledger else {
			self.exists = true;
			return Ok(()); // memory: the host holds the only copy
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
						let (at, grp, flag) = claim_index(v);
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
		if self.exists && parts.is_empty() && self.head_text.as_deref() == Some(head.as_str()) {
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
		let mut ops = vec![WriteOp::Doc { kind, key, version: SPACE_VERSION, value: head.clone() }];
		ops.extend(parts);
		ledger.persist(ops).recv().map_err(|_| StoreError::Failed("the writer is gone".into()))?.map_err(StoreError::Failed)?;
		self.head_text = Some(head);
		self.exists = true;
		Ok(())
	}

	/// The committed document, as a store reads it back.
	pub fn stored(&self) -> StoredDoc { StoredDoc { kind: self.kind.clone(), key: self.key.clone(), version: SPACE_VERSION, value: self.space.state.to_json() } }

	/// Writes what is pending and closes the store.
	pub fn close(self) {
		if let Ledger::Sqlite(l) = self.ledger {
			(*l).close();
		}
	}
	pub fn parts() -> &'static [PartDef] { SPACE_PARTS }
	#[doc(hidden)]
	pub fn ords_of(&mut self) -> Option<&mut Ords> {
		match &mut self.ledger {
			Ledger::Sqlite(l) => Some(l.ords(&self.kind, self.key.as_deref())),
			Ledger::Memory(_) => None,
		}
	}
}
