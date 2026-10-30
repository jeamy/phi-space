//! Where committed documents live (src/store/host.ts `Ledger`): a SQLite file (src/store/sqlite.ts) or memory.
use crate::files::{open_files, Result, StoreError, StoreFiles};
use crate::ops::WriteOp;
use crate::parts::{head_of, id_of, join_parts, part_at, PartDef, PartKind, PartRow};
use crate::writer::{Durable, Synchronous, Writer};
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

/// The SQLite ledger: the read connection, the owner lock and the writer thread.
pub struct SqliteLedger {
	files: StoreFiles,
	writer: Option<Writer>,
	/// Per document with parts: the order of each array part's records.
	ords: HashMap<String, Ords>,
}

impl SqliteLedger {
	pub fn open(path: &Path, synchronous: Synchronous) -> Result<SqliteLedger> {
		let files = open_files(path)?;
		let writer = Writer::open(path, synchronous).map_err(|e| StoreError::Unavailable(format!("the store writer could not open {}: {e}", path.display())))?;
		Ok(SqliteLedger { files, writer: Some(writer), ords: HashMap::new() })
	}

	/// The orders this ledger knows of a document's array parts (from its load or its writes).
	pub fn ords(&mut self, kind: &str, key: Option<&str>) -> &mut Ords { self.ords.entry(doc_id(kind, key)).or_default() }

	/// Reads a committed document: its head with the rows of its parts. A map part kept on the disk is read whole for
	/// now (claims are queried on the disk with a later slice of R2).
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
			for p in parts.iter().filter(|p| p.disk.is_some() && p.kind == PartKind::Map) {
				self.index(kind, doc_key(key), p)?;
				let db = &self.files.read;
				let mut stmt = db.prepare("SELECT id, value FROM parts WHERE kind = ? AND key = ? AND part = ? ORDER BY id")?;
				let mut it = stmt.query(params![kind, doc_key(key), p.name()])?;
				while let Some(r) = it.next()? {
					let (id, v): (String, String) = (r.get(0)?, r.get(1)?);
					let v = parse(&v).map_err(|e| StoreError::Unavailable(format!("a row of {kind}: {e}")))?;
					rows.entry(p.name()).or_default().push(PartRow { part: p.name(), id, ord: 0, value: v });
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

	/// The kinds and keys of every stored document.
	pub fn documents(&self) -> Result<Vec<(String, Option<String>)>> {
		let mut stmt = self.files.read.prepare("SELECT kind, key FROM documents ORDER BY kind, key")?;
		let out = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
		Ok(out.into_iter().map(|(k, key)| (k, Some(key).filter(|s| !s.is_empty()))).collect())
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
