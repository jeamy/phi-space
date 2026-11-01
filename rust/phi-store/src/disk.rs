//! The claims of a Space as a map part on the disk (src/store/sqlite.ts `#source`, store/disk-map.ts): the durable rows
//! of `rpc.claims`, asked through the index columns `at`, `grp` and `flag` on a read connection of their own.
use phi_core::ClaimSource;
use phi_json::{parse, Json};
use rusqlite::{params_from_iter, Connection};
use std::path::Path;
use std::sync::Mutex;

pub struct SqliteClaims {
	db: Mutex<Connection>,
	kind: String,
	key: String,
	part: String,
	/// The first read that failed since `take_failure` (SQLITE_BUSY after the timeout, I/O, a row that does not parse).
	failure: Mutex<Option<String>>,
}

const BASE: &str = "FROM parts WHERE kind = ? AND key = ? AND part = ?";
fn marks(n: usize) -> String { vec!["?"; n].join(", ") }

impl SqliteClaims {
	pub fn open(path: &Path, kind: &str, key: &str, part: &str) -> rusqlite::Result<SqliteClaims> {
		let db = Connection::open(path)?;
		db.busy_timeout(std::time::Duration::from_secs(10))?;
		Ok(SqliteClaims { db: Mutex::new(db), kind: kind.to_owned(), key: key.to_owned(), part: part.to_owned(), failure: Mutex::new(None) })
	}
	fn note(&self, m: String) { self.failure.lock().unwrap().get_or_insert(m); }
	fn query<T>(&self, sql: &str, extra: Vec<rusqlite::types::Value>, row: impl Fn(&rusqlite::Row) -> rusqlite::Result<T>) -> Vec<T> {
		let db = self.db.lock().unwrap();
		let mut args: Vec<rusqlite::types::Value> = vec![self.kind.clone().into(), self.key.clone().into(), self.part.clone().into()];
		args.extend(extra);
		let read = || -> rusqlite::Result<Vec<T>> { db.prepare_cached(sql)?.query_map(params_from_iter(args), row)?.collect() };
		read().unwrap_or_else(|e| {
			self.note(format!("reading the claims: {e}"));
			vec![]
		})
	}
	fn rows(&self, sql: &str, extra: Vec<rusqlite::types::Value>) -> Vec<(String, Json)> {
		let rows = self.query(sql, extra, |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)));
		rows.into_iter()
			.filter_map(|(k, v)| match parse(&v) {
				Ok(v) => Some((k, v)),
				Err(e) => {
					self.note(format!("claim {k}: {e}"));
					None
				}
			})
			.collect()
	}
	fn ids_of(&self, sql: &str, extra: Vec<rusqlite::types::Value>) -> Vec<String> { self.query(sql, extra, |r| r.get::<_, String>(0)) }
}

fn num(t: f64) -> rusqlite::types::Value { if t.fract() == 0.0 && t.abs() < 9.3e18 { rusqlite::types::Value::Integer(t as i64) } else { rusqlite::types::Value::Real(t) } }

impl ClaimSource for SqliteClaims {
	fn get(&self, key: &str) -> Option<Json> { self.rows(&format!("SELECT id, value {BASE} AND id = ?"), vec![key.to_owned().into()]).pop().map(|(_, v)| v) }
	fn due(&self, t: f64, limit: usize, in_groups: &[String], known: &[String]) -> Vec<(String, Json)> {
		let in_part = if in_groups.is_empty() { String::new() } else { format!(" OR grp IN ({})", marks(in_groups.len())) };
		let sql = format!("SELECT id, value {BASE} AND at IS NOT NULL AND at <= ? AND (flag = 0{in_part} OR grp NOT IN ({})) ORDER BY id LIMIT ?", marks(known.len()));
		let mut extra = vec![num(t)];
		extra.extend(in_groups.iter().map(|g| g.clone().into()));
		extra.extend(known.iter().map(|g| g.clone().into()));
		extra.push((limit as i64).into());
		self.rows(&sql, extra)
	}
	fn next_at(&self, t: f64) -> Option<f64> {
		self.query(&format!("SELECT min(at) {BASE} AND at IS NOT NULL AND at > ? AND flag = 0"), vec![num(t)], |r| r.get::<_, Option<f64>>(0)).pop().flatten()
	}
	fn group(&self, g: &str, limit: usize) -> Vec<String> { self.ids_of(&format!("SELECT id {BASE} AND grp = ? LIMIT ?"), vec![g.to_owned().into(), (limit as i64).into()]) }
	fn unindexed(&self) -> Vec<(String, Json)> { self.rows(&format!("SELECT id, value {BASE} AND at IS NULL"), vec![]) }
	fn first_ids(&self, limit: usize) -> Vec<String> { self.ids_of(&format!("SELECT id {BASE} ORDER BY id LIMIT ?"), vec![(limit as i64).into()]) }
	fn ids(&self) -> Vec<String> { self.ids_of(&format!("SELECT id {BASE}"), vec![]) }
	fn take_failure(&self) -> Option<String> { self.failure.lock().unwrap().take() }
}
