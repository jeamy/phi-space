//! Where committed documents live (src/store/host.ts `Ledger`): a SQLite file (src/store/sqlite.ts) or memory.
use crate::files::{open_files, Result, StoreError, StoreFiles};
use crate::ops::WriteOp;
use crate::parts::{head_of, id_of, join_parts, part_at, PartDef, PartKind, PartRow};
use crate::writer::{Compaction, Durable, Synchronous, Writer, WriterOptions};
use phi_json::{parse, Json};
use rusqlite::params;
use std::collections::HashMap;
use std::path::Path;

/// A committed document: its value and the schema version it was stored with. `key`: `None` for a single document.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredDoc {
	pub kind: String,
	pub key: Option<String>,
	pub version: i64,
	pub value: Json,
}

/// The order of each array part's records of one document, by part and record id.
pub type Ords = HashMap<String, HashMap<String, i64>>;

fn doc_key(key: Option<&str>) -> &str { key.unwrap_or("") }
fn doc_id(kind: &str, key: Option<&str>) -> String { format!("{kind}\u{0}{}", doc_key(key)) }

/// The index columns of a record of a map part on the disk.
fn index_of(p: &PartDef, v: &Json) -> (Option<f64>, Option<String>, Option<i64>) {
	match &p.disk {
		None => (None, None, None),
		Some(ix) => (v.get(ix.at).and_then(Json::as_f64), v.get(ix.group).and_then(Json::as_str).map(str::to_owned), Some(i64::from(phi_core_truthy(v.get(ix.flag))))),
	}
}
fn phi_core_truthy(v: Option<&Json>) -> bool {
	match v {
		None | Some(Json::Null) | Some(Json::Bool(false)) => false,
		Some(Json::Number(x)) => *x != 0.0 && !x.is_nan(),
		Some(Json::String(s)) => !s.is_empty(),
		Some(_) => true,
	}
}

/// The rows of a whole document: its head and every record of its parts. Array records keep the order they have in
/// `ords` and new ones follow (`ords` learns them).
pub fn whole_ops(doc: &StoredDoc, parts: &[PartDef], ords: &mut Ords) -> Vec<WriteOp> {
	let (kind, key) = (doc.kind.clone(), doc_key(doc.key.as_deref()).to_owned());
	if parts.is_empty() {
		return vec![WriteOp::Doc { kind, key, version: doc.version, value: doc.value.to_json_text() }];
	}
	let mut ops = vec![WriteOp::Doc { kind: kind.clone(), key: key.clone(), version: doc.version, value: head_of(&doc.value, parts).to_json_text() }];
	for p in parts {
		let name = p.name();
		let Some(v) = part_at(&doc.value, p.path) else { continue };
		let mut put = |id: String, ord: i64, value: &Json| {
			let (at, grp, flag) = index_of(p, value);
			ops.push(WriteOp::Part { kind: kind.clone(), key: key.clone(), part: name.clone(), id, ord, value: value.to_json_text(), at, grp, flag });
		};
		match (p.kind, v) {
			(PartKind::Map, Json::Object(m)) => {
				for (id, value) in m.iter() {
					put(id.to_owned(), 0, value);
				}
			}
			(PartKind::Array, Json::Array(a)) => {
				let ord = ords.entry(name.clone()).or_default();
				let mut max = ord.values().copied().max().unwrap_or(-1);
				for value in a {
					let id = id_of(value);
					let o = *ord.entry(id.clone()).or_insert_with(|| {
						max += 1;
						max
					});
					put(id, o, value);
				}
			}
			_ => {}
		}
	}
	ops
}

/// A backup of the store at `path`, taken while it writes (`VACUUM INTO`, on a read-only connection of its own): one
/// consistent state of its commits. Restored by copying it to where a store is opened.
pub fn backup(path: &Path, to: &Path) -> Result<()> {
	let db = rusqlite::Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)?;
	db.busy_timeout(std::time::Duration::from_secs(10))?;
	db.execute("VACUUM INTO ?", [to.to_string_lossy()])?;
	Ok(())
}

/// The SQLite ledger: the read connection, the owner lock and the writer thread.
pub struct SqliteLedger {
	files: StoreFiles,
	writer: Option<Writer>,
	/// Per document with parts: the order of each array part's records.
	ords: HashMap<String, Ords>,
}

impl SqliteLedger {
	pub fn open(path: &Path, synchronous: Synchronous) -> Result<SqliteLedger> { SqliteLedger::open_with(path, WriterOptions { synchronous, ..Default::default() }) }
	pub fn open_with(path: &Path, o: WriterOptions) -> Result<SqliteLedger> {
		let files = open_files(path)?;
		let writer = Writer::open(path, o).map_err(|e| StoreError::Unavailable(format!("the store writer could not open {}: {e}", path.display())))?;
		Ok(SqliteLedger { files, writer: Some(writer), ords: HashMap::new() })
	}

	/// The orders this ledger knows of a document's array parts (from its load or its writes).
	pub fn ords(&mut self, kind: &str, key: Option<&str>) -> &mut Ords { self.ords.entry(doc_id(kind, key)).or_default() }

	/// Reads a committed document: its head with the rows of its parts. A map part kept on the disk is not read: the head
	/// holds an empty map for it, and the caller asks its rows through a `SqliteClaims`.
	pub fn load(&mut self, kind: &str, key: Option<&str>, parts: &[PartDef]) -> Result<Option<StoredDoc>> {
		let db = &self.files.read;
		let row: Option<(i64, String)> = db.query_row("SELECT version, value FROM documents WHERE kind = ? AND key = ?", params![kind, doc_key(key)], |r| Ok((r.get(0)?, r.get(1)?))).ok();
		let Some((version, text)) = row else { return Ok(None) };
		let mut value = parse(&text).map_err(|e| StoreError::Unavailable(format!("document {kind}: {e}")))?;
		if !parts.is_empty() {
			let on_disk: Vec<String> = parts.iter().filter(|p| p.disk.is_some() && p.kind == PartKind::Map).map(PartDef::name).collect();
			let marks = vec!["?"; on_disk.len()].join(", ");
			let sql = format!("SELECT part, id, ord, value FROM parts WHERE kind = ? AND key = ? AND part NOT IN ({marks}) ORDER BY part, ord");
			let k = doc_key(key);
			let mut args: Vec<&dyn rusqlite::ToSql> = vec![&kind, &k];
			for p in &on_disk {
				args.push(p);
			}
			let mut rows: HashMap<String, Vec<PartRow>> = HashMap::new();
			let mut ords = Ords::new();
			let mut stmt = db.prepare(&sql)?;
			let mut it = stmt.query(args.as_slice())?;
			while let Some(r) = it.next()? {
				let (part, id, ord, v): (String, String, i64, String) = (r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?);
				let v = parse(&v).map_err(|e| StoreError::Unavailable(format!("a row of {kind}: {e}")))?;
				ords.entry(part.clone()).or_default().insert(id.clone(), ord);
				rows.entry(part.clone()).or_default().push(PartRow { part, id, ord, value: v });
			}
			// a map part on the disk stays there: the caller puts a map over its rows in its place (SpaceHost)
			for p in parts.iter().filter(|p| p.disk.is_some() && p.kind == PartKind::Map) {
				self.index(kind, doc_key(key), p)?;
			}
			// a part kept inline in the head (written before its definition had parts): the TypeScript store moves it to rows
			// with its next commit; not ported, and a head written without it would lose it
			for p in parts {
				let inline = match part_at(&value, p.path) {
					Some(Json::Array(a)) => !a.is_empty(),
					Some(Json::Object(o)) => !o.is_empty(),
					_ => false,
				};
				if inline {
					return Err(StoreError::Unavailable(format!("the document {kind} keeps {} inline in its head; the Rust store reads parts as rows only", p.name())));
				}
			}
			join_parts(&mut value, parts, &rows);
			self.ords.insert(doc_id(kind, key), ords);
		}
		Ok(Some(StoredDoc { kind: kind.to_owned(), key: key.map(str::to_owned), version, value }))
	}

	/// Rows of a format 1 file have no index columns yet: filled once per part from their values.
	fn index(&self, kind: &str, key: &str, p: &PartDef) -> Result<()> {
		let db = &self.files.read;
		let mark = format!("indexed\u{0}{kind}\u{0}{key}\u{0}{}", p.name());
		if db.query_row("SELECT 1 FROM store_meta WHERE key = ?", [&mark], |_| Ok(())).is_ok() {
			return Ok(());
		}
		let ix = p.disk.as_ref().expect("a part on the disk");
		db.execute(
			"UPDATE parts SET at = json_extract(value, ?), grp = json_extract(value, ?), flag = CASE WHEN json_extract(value, ?) THEN 1 ELSE 0 END WHERE kind = ? AND key = ? AND part = ? AND grp IS NULL",
			params![format!("$.{}", ix.at), format!("$.{}", ix.group), format!("$.{}", ix.flag), kind, key, p.name()],
		)?;
		db.execute("INSERT INTO store_meta (key, value) VALUES (?, '1')", [&mark])?;
		Ok(())
	}

	/// A document without parts as it is stored.
	pub fn document(&self, kind: &str, key: Option<&str>) -> Result<Option<StoredDoc>> {
		let row: Option<(i64, String)> = match self.files.read.query_row("SELECT version, value FROM documents WHERE kind = ? AND key = ?", params![kind, doc_key(key)], |r| Ok((r.get(0)?, r.get(1)?))) {
			Ok(r) => Some(r),
			Err(rusqlite::Error::QueryReturnedNoRows) => None,
			Err(e) => return Err(e.into()),
		};
		let Some((version, text)) = row else { return Ok(None) };
		let value = parse(&text).map_err(|e| StoreError::Unavailable(format!("document {kind}: {e}")))?;
		Ok(Some(StoredDoc { kind: kind.to_owned(), key: key.map(str::to_owned), version, value }))
	}

	/// The kinds and keys of every stored document.
	/// The store file.
	pub fn path(&self) -> &Path { &self.files.path }
	/// Every row of one part of a document, by key (what a map part on the disk holds, read on purpose).
	pub fn part_rows(&self, kind: &str, key: Option<&str>, part: &str) -> Result<Vec<(String, Json)>> {
		let mut stmt = self.files.read.prepare("SELECT id, value FROM parts WHERE kind = ? AND key = ? AND part = ? ORDER BY id")?;
		let rows = stmt.query_map(params![kind, doc_key(key), part], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
		rows.into_iter().map(|(k, v)| parse(&v).map(|v| (k, v)).map_err(|e| StoreError::Unavailable(format!("a row of {kind}: {e}")))).collect()
	}
	pub fn documents(&self) -> Result<Vec<(String, Option<String>)>> {
		let mut stmt = self.files.read.prepare("SELECT kind, key FROM documents ORDER BY kind, key")?;
		let out = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
		Ok(out.into_iter().map(|(k, key)| (k, Some(key).filter(|s| !s.is_empty()))).collect())
	}

	/// Whether a stored claim is of a kind not ported (a negative claim, a claim from a restore).
	pub fn unported_claims(&self, kind: &str, key: Option<&str>) -> Result<bool> {
		let sql = "SELECT 1 FROM parts WHERE kind = ? AND key = ? AND ((part = 'rpc.claims' AND json_extract(value, '$.notCommitted') IS NOT NULL) OR part = 'restoredClaims') LIMIT 1";
		match self.files.read.query_row(sql, params![kind, doc_key(key)], |_| Ok(())) {
			Ok(()) => Ok(true),
			Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
			Err(e) => Err(e.into()),
		}
	}
	/// Gives the file's free pages back, in the writer's order between two batches.
	pub fn compact(&self) -> Result<Compaction> {
		let rx = self.writer.as_ref().expect("open").compact().ok_or_else(|| StoreError::Failed("the writer is gone".into()))?;
		rx.recv().map_err(|_| StoreError::Failed("the writer is gone".into()))
	}
	/// Hands a commit's rows to the writer; the receiver settles when they are durable.
	pub fn persist(&mut self, ops: Vec<WriteOp>) -> Durable { self.writer.as_ref().expect("open").write(ops) }

	/// Writes what was handed over, closes the writer and releases the owner lock.
	pub fn close(mut self) {
		if let Some(w) = self.writer.take() {
			w.close();
		}
		let _ = self.files.lock.execute_batch("ROLLBACK");
	}
}

/// The ledger of a store in memory: committed documents kept in the host only.
#[derive(Default)]
pub struct MemoryLedger {
	docs: HashMap<String, StoredDoc>,
}
impl MemoryLedger {
	pub fn load(&self, kind: &str, key: Option<&str>) -> Option<StoredDoc> { self.docs.get(&doc_id(kind, key)).cloned() }
	pub fn put(&mut self, doc: StoredDoc) { self.docs.insert(doc_id(&doc.kind, doc.key.as_deref()), doc); }
	pub fn retire(&mut self, kind: &str, key: Option<&str>) { self.docs.remove(&doc_id(kind, key)); }
}
