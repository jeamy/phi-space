// R2, slice 0 (docs/rust-portierung.md): the store file of test/vectors (store.sql, written by the TypeScript store) is
// opened and read by the Rust store, every document written into a new file by it, and the two files hold the same
// rows; the TypeScript store then opens the Rust file and its read-only session answers exactly as store.expected.json.
use phi_json::{parse, Json};
use phi_store::{whole_ops, PartDef, SqliteLedger, StoreError, Synchronous, SPACE_PARTS};
use rusqlite::Connection;
use std::path::{Path, PathBuf};
use std::process::Command;

fn root() -> PathBuf { PathBuf::from(format!("{}/../..", env!("CARGO_MANIFEST_DIR"))) }
fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn parts_of(kind: &str) -> &'static [PartDef] { if kind == "phi-spaces.space" || kind == "phi-spaces.named-space" { SPACE_PARTS } else { &[] } }

/// The rows of a store file, as text: documents and parts in key order.
fn rows(path: &Path) -> (Vec<String>, Vec<String>, Vec<String>) {
	let db = Connection::open(path).unwrap();
	let q = |sql: &str| -> Vec<String> {
		let mut s = db.prepare(sql).unwrap();
		let n = s.column_count();
		let cell = |v: rusqlite::types::ValueRef| match v {
			rusqlite::types::ValueRef::Null => "NULL".to_owned(),
			rusqlite::types::ValueRef::Integer(i) => format!("int {i}"),
			rusqlite::types::ValueRef::Real(x) => format!("real {x}"),
			rusqlite::types::ValueRef::Text(t) => format!("{:?}", String::from_utf8_lossy(t)),
			rusqlite::types::ValueRef::Blob(b) => format!("blob {b:?}"),
		};
		s.query_map([], |r| Ok((0..n).map(|i| cell(r.get_ref(i).unwrap())).collect::<Vec<_>>().join(" | "))).unwrap().map(Result::unwrap).collect()
	};
	(
		q("SELECT kind, key, version, value FROM documents ORDER BY kind, key"),
		q("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, id"),
		q("SELECT key, value FROM store_meta WHERE key NOT IN ('store_id', 'commit_seq') AND key NOT LIKE 'indexed%' ORDER BY key"),
	)
}

/// A copy of the vector store: store.sql into a fresh file.
fn vector_store(d: &Path) -> PathBuf {
	let path = d.join("ts.sqlite");
	let sql = std::fs::read_to_string(root().join("test/vectors/store.sql")).unwrap();
	Connection::open(&path).unwrap().execute_batch(&sql).unwrap();
	path
}

#[test]
fn the_rust_store_reads_and_writes_the_typescript_file() {
	let d = dir("store-vectors");
	let ts = vector_store(&d);
	let mut a = SqliteLedger::open(&ts, Synchronous::Full).unwrap();
	let rust = d.join("rust.sqlite");
	let mut b = SqliteLedger::open(&rust, Synchronous::Full).unwrap();
	let docs = a.documents().unwrap();
	assert!(docs.iter().any(|(k, _)| k == "phi-spaces.space"), "the vector holds a space: {docs:?}");
	for (kind, key) in &docs {
		let parts = parts_of(kind);
		let doc = a.load(kind, key.as_deref(), parts).unwrap().unwrap();
		if kind == "phi-spaces.space" {
			let entries = doc.value.get("entries").and_then(Json::as_array).map_or(0, Vec::len);
			let claims = doc.value.get("rpc").and_then(|r| r.get("claims")).and_then(Json::as_object).map_or(0, |c| c.len());
			assert!(entries > 0 && claims > 0, "the space came back with its parts ({entries} entries, {claims} claims)");
		}
		// the same orders as the file it came from
		let mut ords = a.ords(kind, key.as_deref()).clone();
		let ops = whole_ops(&doc, parts, &mut ords);
		b.persist(ops).recv().unwrap().unwrap();
	}
	a.close();
	b.close();
	let (got, want) = (rows(&rust), rows(&ts));
	for (g, w, what) in [(&got.0, &want.0, "documents"), (&got.1, &want.1, "parts"), (&got.2, &want.2, "store_meta")] {
		assert_eq!(g.len(), w.len(), "{what}: row count");
		if let Some((x, y)) = g.iter().zip(w).find(|(x, y)| x != y) {
			panic!("{what} differ:\n  Rust:       {x}\n  TypeScript: {y}");
		}
	}

	// the TypeScript store opens the Rust file and answers as from its own
	let script = format!(
		"const {{ readStore }} = await import({:?}); process.stdout.write(JSON.stringify(await readStore({:?})));",
		root().join("test/vectors/build.ts").to_str().unwrap(),
		rust.to_str().unwrap()
	);
	let out = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &script]).current_dir(root()).output().expect("node on PATH");
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	let got = parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap();
	let want = parse(&std::fs::read_to_string(root().join("test/vectors/store.expected.json")).unwrap()).unwrap();
	assert_eq!(got.canonical().unwrap(), want.get("steps").unwrap().canonical().unwrap(), "the read-only session on the Rust file");
}

#[test]
fn a_store_has_one_owner_and_a_known_format() {
	let d = dir("store-owner");
	let path = d.join("s.sqlite");
	let first = SqliteLedger::open(&path, Synchronous::Full).unwrap();
	assert!(matches!(SqliteLedger::open(&path, Synchronous::Full), Err(StoreError::Unavailable(m)) if m.contains("another process owns")));
	first.close();
	let again = SqliteLedger::open(&path, Synchronous::Full).unwrap();
	again.close();
	// a newer format is refused, a file of another program too
	Connection::open(&path).unwrap().execute("UPDATE store_meta SET value = '3' WHERE key = 'format_version'", []).unwrap();
	assert!(matches!(SqliteLedger::open(&path, Synchronous::Full), Err(StoreError::Unavailable(m)) if m.contains("has format 3")));
	let other = d.join("other.sqlite");
	Connection::open(&other).unwrap().execute_batch("CREATE TABLE documents (x TEXT);").unwrap();
	assert!(matches!(SqliteLedger::open(&other, Synchronous::Full), Err(StoreError::Unavailable(m)) if m.contains("is not a phi-spaces store")));
}

#[test]
fn the_typescript_store_and_the_rust_store_refuse_each_other() {
	let d = dir("store-cross-owner");
	let path = d.join("s.sqlite");
	let rust = SqliteLedger::open(&path, Synchronous::Full).unwrap();
	let script = format!(
		"const {{ openSqliteHost }} = await import({:?}); try {{ await openSqliteHost({:?}); console.log('opened'); }} catch (e) {{ console.log(e.constructor.name); }}",
		root().join("src/store/sqlite.ts").to_str().unwrap(),
		path.to_str().unwrap()
	);
	let out = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &script]).current_dir(root()).output().unwrap();
	assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "StoreUnavailable", "{}", String::from_utf8_lossy(&out.stderr));
	rust.close();
}

#[test]
fn claims_fill_the_index_columns_and_each_batch_counts_once() {
	// sqlite.ts: at = the record's decidedAt when a number, grp = its generation when a string, flag = resultExpired
	// truthy (1) or not (0); a pending claim has no at (it stays in memory)
	let d = dir("store-index");
	let path = d.join("s.sqlite");
	let mut l = SqliteLedger::open(&path, Synchronous::Full).unwrap();
	let value = parse(r#"{"nextId":1,"entries":[],"txns":{},"regs":[],"waiters":[],"outbox":[],"returned":0,"rpc":{"generations":{"g1":{"admitUntil":5}},"claims":{"k-done":{"state":"done","decidedAt":1700,"generation":"g1"},"k-gone":{"state":"done","decidedAt":1600,"generation":"g1","resultExpired":true},"k-open":{"state":"pending","generation":"g2"}},"bytes":0}}"#).unwrap();
	let doc = phi_store::StoredDoc { kind: "phi-spaces.named-space".into(), key: Some("sp-x".into()), version: 5, value };
	for _ in 0..3 {
		l.persist(whole_ops(&doc, SPACE_PARTS, &mut Default::default())).recv().unwrap().unwrap();
	}
	l.close();
	let db = Connection::open(&path).unwrap();
	let mut s = db.prepare("SELECT id, at, grp, flag FROM parts WHERE part = 'rpc.claims' ORDER BY id").unwrap();
	type Row = (String, Option<i64>, Option<String>, Option<i64>);
	let got: Vec<Row> = s.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))).unwrap().map(Result::unwrap).collect();
	assert_eq!(
		got,
		vec![("k-done".into(), Some(1700), Some("g1".into()), Some(0)), ("k-gone".into(), Some(1600), Some("g1".into()), Some(1)), ("k-open".into(), None, Some("g2".into()), Some(0))]
	);
	let generations: Option<i64> = db.query_row("SELECT flag FROM parts WHERE part = 'rpc.generations'", [], |r| r.get(0)).unwrap();
	assert_eq!(generations, None, "a part in memory has no index columns");
	let seq: String = db.query_row("SELECT value FROM store_meta WHERE key = 'commit_seq'", [], |r| r.get(0)).unwrap();
	assert_eq!(seq, "3", "three commits, each waited for: three batches");
}
