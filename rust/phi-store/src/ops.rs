//! The row changes of the store (src/store/sqlite-ops.ts) and how they are applied, inside the caller's transaction,
//! as one commit (`commit_seq`).
use rusqlite::{params, Connection};

/// A row change: a document (whole value or head), a retired document, a part row, a deleted part row, a cleared part,
/// a `store_meta` value.
#[derive(Clone, Debug, PartialEq)]
pub enum WriteOp {
	Doc { kind: String, key: String, version: i64, value: String },
	Retire { kind: String, key: String },
	Part { kind: String, key: String, part: String, id: String, ord: i64, value: String, at: Option<f64>, grp: Option<String>, flag: Option<i64> },
	PartDel { kind: String, key: String, part: String, id: String },
	PartClear { kind: String, key: String, part: String },
	Meta { key: String, value: String },
}

pub const DOC: &str = "INSERT INTO documents (kind, key, version, value) VALUES (?, ?, ?, ?) ON CONFLICT (kind, key) DO UPDATE SET version = excluded.version, value = excluded.value";
pub const RETIRE: &str = "DELETE FROM documents WHERE kind = ? AND key = ?";
pub const RETIRE_PARTS: &str = "DELETE FROM parts WHERE kind = ? AND key = ?";
pub const PART: &str = "INSERT INTO parts (kind, key, part, id, ord, value, at, grp, flag) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (kind, key, part, id) DO UPDATE SET ord = excluded.ord, value = excluded.value, at = excluded.at, grp = excluded.grp, flag = excluded.flag";
pub const PART_DEL: &str = "DELETE FROM parts WHERE kind = ? AND key = ? AND part = ? AND id = ?";
pub const PART_CLEAR: &str = "DELETE FROM parts WHERE kind = ? AND key = ? AND part = ?";
pub const META: &str = "INSERT INTO store_meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value";
pub const SEQ: &str = "UPDATE store_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'commit_seq'";

/// `at` as node:sqlite binds a number: an integral one as an integer, any other as a real (which the STRICT INTEGER
/// column refuses, as it does for the TypeScript store).
fn at_value(at: Option<f64>) -> rusqlite::types::Value {
	match at {
		None => rusqlite::types::Value::Null,
		Some(x) if x.fract() == 0.0 && x.abs() < 9.3e18 => rusqlite::types::Value::Integer(x as i64),
		Some(x) => rusqlite::types::Value::Real(x),
	}
}

/// Applies `ops` inside the caller's transaction and counts it as one commit.
pub fn apply_ops(db: &Connection, ops: &[WriteOp]) -> rusqlite::Result<()> {
	for op in ops {
		match op {
			WriteOp::Doc { kind, key, version, value } => {
				db.prepare_cached(DOC)?.execute(params![kind, key, version, value])?;
			}
			WriteOp::Retire { kind, key } => {
				db.prepare_cached(RETIRE)?.execute(params![kind, key])?;
				db.prepare_cached(RETIRE_PARTS)?.execute(params![kind, key])?;
			}
			WriteOp::Part { kind, key, part, id, ord, value, at, grp, flag } => {
				db.prepare_cached(PART)?.execute(params![kind, key, part, id, ord, value, at_value(*at), grp, flag])?;
			}
			WriteOp::PartDel { kind, key, part, id } => {
				db.prepare_cached(PART_DEL)?.execute(params![kind, key, part, id])?;
			}
			WriteOp::PartClear { kind, key, part } => {
				db.prepare_cached(PART_CLEAR)?.execute(params![kind, key, part])?;
			}
			WriteOp::Meta { key, value } => {
				db.prepare_cached(META)?.execute(params![key, value])?;
			}
		}
	}
	db.prepare_cached(SEQ)?.execute([])?;
	Ok(())
}
