use phi_core::driver::seeded;
use phi_core::space::error;
use phi_json::{obj, Json};
use phi_store::{Ledger, MemoryLedger, SqliteLedger, Store, Synchronous, SPACE_PARTS};

#[test]
fn a_sql_read_failure_is_not_an_absent_space() {
	let dir = std::path::PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("audit-read-failure");
	std::fs::create_dir_all(&dir).unwrap();
	let file = dir.join("store.sqlite");
	let mut ledger = SqliteLedger::open(&file, Synchronous::Full).unwrap();
	rusqlite::Connection::open(&file).unwrap().execute_batch("DROP TABLE documents").unwrap();
	assert!(ledger.load("phi-spaces.space", None, SPACE_PARTS).is_err());
	ledger.close();
}

#[test]
fn side_documents_commit_and_roll_back_with_the_space_in_memory() {
	let mut store = Store::open(Ledger::Memory(MemoryLedger::default()), || seeded("side-documents")).unwrap();
	let value = obj! { "epoch" => 7.0 };
	store.commit(None, 1000.0, |s| {
		s.doc_writes.push(("phi-spaces.test-journal".into(), "proof".into(), 1, value.to_json_text()));
		Ok(())
	}).unwrap().unwrap();
	assert_eq!(store.stored_document("phi-spaces.test-journal", Some("proof")).unwrap(), Some(value));
	let failed = store.commit(None, 1001.0, |s| {
		s.doc_writes.push(("phi-spaces.test-journal".into(), "proof".into(), 1, Json::Null.to_json_text()));
		Err::<(), _>(error("IllegalArgumentError", "rollback"))
	}).unwrap();
	assert!(failed.is_err());
	assert_eq!(store.stored_document("phi-spaces.test-journal", Some("proof")).unwrap(), Some(obj! { "epoch" => 7.0 }));
}
