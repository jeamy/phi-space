//! Opening a store file (src/store/sqlite.ts `openFiles`): the owner lock next to it, WAL, the schema and its format.
use rusqlite::{Connection, OpenFlags};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// The format of the file; a newer one is refused, an older one is migrated (1 to 2: the index columns of parts).
pub const FORMAT_VERSION: i64 = 2;

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS documents (kind TEXT NOT NULL, key TEXT NOT NULL, version INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, key)) STRICT;
CREATE TABLE IF NOT EXISTS parts (kind TEXT NOT NULL, key TEXT NOT NULL, part TEXT NOT NULL, id TEXT NOT NULL, ord INTEGER NOT NULL, value TEXT NOT NULL, at INTEGER, grp TEXT, flag INTEGER, PRIMARY KEY (kind, key, part, id)) STRICT;
CREATE INDEX IF NOT EXISTS parts_order ON parts (kind, key, part, ord);
";
pub const INDEXES: &str = "
CREATE INDEX IF NOT EXISTS parts_at ON parts (kind, key, part, at) WHERE at IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_grp ON parts (kind, key, part, grp) WHERE grp IS NOT NULL;
CREATE INDEX IF NOT EXISTS parts_open ON parts (kind, key, part) WHERE at IS NULL;
";

/// Refused: another process owns the store, or the file is of an unknown format.
#[derive(Debug)]
pub enum StoreError {
	Unavailable(String),
	Sqlite(rusqlite::Error),
	/// A write failed: the store takes no more work until it is reopened.
	Failed(String),
}
impl std::fmt::Display for StoreError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			StoreError::Unavailable(m) => write!(f, "{m}"),
			StoreError::Sqlite(e) => write!(f, "{e}"),
			StoreError::Failed(m) => write!(f, "the store could not write: {m}"),
		}
	}
}
impl std::error::Error for StoreError {}
impl From<rusqlite::Error> for StoreError {
	fn from(e: rusqlite::Error) -> Self { StoreError::Sqlite(e) }
}
pub type Result<T> = std::result::Result<T, StoreError>;

/// A store file opened by its owner: the read connection and the held owner lock.
pub struct StoreFiles {
	pub path: PathBuf,
	pub read: Connection,
	pub lock: Connection,
}

fn lock_path(path: &Path) -> PathBuf {
	let mut p = path.as_os_str().to_owned();
	p.push(".owner");
	PathBuf::from(p)
}

/// Opens (or creates) the store file at `path` for its owner. Refuses when another process owns the store (the same
/// lock as the TypeScript store: an exclusive SQLite lock on `<path>.owner`, so either refuses the other), or the file is
/// of a newer format or of another program.
pub fn open_files(path: &Path) -> Result<StoreFiles> {
	if let Some(dir) = path.parent().filter(|d| !d.as_os_str().is_empty()) {
		std::fs::create_dir_all(dir).map_err(|e| StoreError::Unavailable(format!("{}: {e}", dir.display())))?;
	}
	let lock = Connection::open(lock_path(path))?;
	lock.busy_timeout(Duration::ZERO)?;
	if let Err(e) = lock.execute_batch("PRAGMA locking_mode = EXCLUSIVE; BEGIN EXCLUSIVE;") {
		return Err(StoreError::Unavailable(format!("another process owns the store {} ({e})", path.display())));
	}
	let read = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_CREATE)?;
	read.busy_timeout(Duration::from_secs(10))?;
	let _: String = read.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0))?;
	// a file of another program is refused, never taken over
	let tables: Vec<String> = read.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")?.query_map([], |r| r.get(0))?.collect::<rusqlite::Result<_>>()?;
	if !tables.is_empty() && !tables.iter().any(|t| t == "store_meta") {
		let some: Vec<&str> = tables.iter().take(6).map(String::as_str).collect();
		return Err(StoreError::Unavailable(format!("{} is not a phi-spaces store (tables: {}); move it aside: pi-durable stores are discarded, not taken over (decision D6, docs/umstellung-u0-bestand.md)", path.display(), some.join(", "))));
	}
	read.execute_batch(SCHEMA)?;
	let format: Option<String> = read.query_row("SELECT value FROM store_meta WHERE key = 'format_version'", [], |r| r.get(0)).ok();
	match format.as_deref().map(|f| f.parse::<f64>().unwrap_or(f64::NAN)) {
		None => {
			// randomUUID's form: 8-4-4-4-12 hex digits, version 4
			let id: String = read.query_row(
				"SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))), 2) || '-' || substr('89ab', 1 + (abs(random()) % 4), 1) || substr(lower(hex(randomblob(2))), 2) || '-' || lower(hex(randomblob(6)))",
				[],
				|r| r.get(0),
			)?;
			let mut put = read.prepare("INSERT INTO store_meta (key, value) VALUES (?, ?)")?;
			put.execute(["format_version", &FORMAT_VERSION.to_string()])?;
			put.execute(["store_id", &id])?;
			put.execute(["commit_seq", "0"])?;
		}
		Some(v) if v > FORMAT_VERSION as f64 => {
			return Err(StoreError::Unavailable(format!("the store {} has format {}; this version reads up to {FORMAT_VERSION}", path.display(), format.unwrap_or_default())));
		}
		Some(v) if v < 2.0 => {
			// format 1 to 2: the index columns of parts
			read.execute_batch("BEGIN IMMEDIATE")?;
			let r = (|| -> rusqlite::Result<()> {
				let cols: Vec<String> = read.prepare("PRAGMA table_info(parts)")?.query_map([], |r| r.get(1))?.collect::<rusqlite::Result<_>>()?;
				for (c, t) in [("at", "INTEGER"), ("grp", "TEXT"), ("flag", "INTEGER")] {
					if !cols.iter().any(|x| x == c) {
						read.execute_batch(&format!("ALTER TABLE parts ADD COLUMN {c} {t}"))?;
					}
				}
				read.execute("UPDATE store_meta SET value = '2' WHERE key = 'format_version'", [])?;
				Ok(())
			})();
			match r {
				Ok(()) => read.execute_batch("COMMIT")?,
				Err(e) => {
					let _ = read.execute_batch("ROLLBACK");
					return Err(e.into());
				}
			}
		}
		Some(_) => {}
	}
	read.execute_batch(INDEXES)?;
	let mode: String = read.query_row("PRAGMA journal_mode", [], |r| r.get(0))?;
	if mode != "wal" {
		return Err(StoreError::Unavailable(format!("the store {} is not in WAL mode ({mode})", path.display())));
	}
	Ok(StoreFiles { path: path.to_owned(), read, lock })
}
