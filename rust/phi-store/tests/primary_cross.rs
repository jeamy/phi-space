// R6b step 1, the commit path of a primary (docs/rust-portierung.en.md): a Rust primary seals every writer batch through
// phi_store::primary, and its standby is the TypeScript journal (test/support/journal-driver.ts). The commits are the
// random walk of R1 through a SpaceHost over the primary's store; the standby accepts each entry as it is sealed, and at
// the end the TypeScript store materializes the standby's history. Both stores must hold the same rows, the marker and
// the commit count included, and both journals the same head. Some walks overlap their commits, so batches carry several
// and are cut at the entry's budget; small budgets refuse commits, which must leave the Space as it was; and some walks
// cut the standby off once, so a batch is sealed and not confirmed: the store is poisoned, names its candidate, and the
// candidate is resolved with the standby (recover_primary_sync) before the walk goes on.
//
// Steps: PHI_PRIMARY_CROSS_STEPS (all walks together, default 1 200); one walk: PHI_PRIMARY_CROSS_SEED.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::walk::{observe, Walk};
use common::TsDriver;
use phi_core::driver::{apply_line, seeded};
use phi_core::snapshot::Snapshots;
use phi_json::{digest_json, obj, parse, Json};
use phi_store::ops::{delta_bytes, deltas};
use phi_store::primary::{PrimaryGate, PrimaryOptions, SyncPeer};
use phi_store::sync::{JournalOptions, SyncError, SyncJournal, SEALED};
use phi_store::sync_store::{recover_primary_sync, SyncStoreFile};
use phi_store::{SpaceHost, SqliteLedger, WriteOp, WriterOptions};
use rusqlite::Connection;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

const KIND: &str = "phi-spaces.named-space";
const KEY: &str = "sp-walk";
const SPACE: &str = "sp-6f1c2b3a-4d5e-4f60-8a71-92b3c4d5e6f7";

fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn genesis() -> Json {
	obj! { "spaceId" => SPACE, "authorityId" => "authority", "primaryEpoch" => 1.0, "replicaConfigVersion" => 1.0, "primaryReplica" => "a", "standbyReplica" => "b", "durability" => "sync" }
}
fn ok(r: Json) -> Result<Json, SyncError> {
	match r.get("ok") {
		Some(Json::Bool(true)) => Ok(r.get("result").cloned().unwrap_or(Json::Null)),
		_ => Err(SyncError::Blocked(r.get("error").and_then(|e| e.get("message")).and_then(Json::as_str).unwrap_or("?").to_owned())),
	}
}

/// The TypeScript standby journal `b`; `cut` refuses the next entry, as a standby cut off would.
#[derive(Clone)]
struct Standby {
	ts: Arc<Mutex<TsDriver>>,
	cut: Arc<Mutex<bool>>,
}
impl Standby {
	fn accept(&self, intent: &Json) -> Result<Json, SyncError> {
		let cut = std::mem::take(&mut *self.cut.lock().unwrap());
		let q = if cut { obj! { "op" => "acceptRefused", "name" => "b", "intent" => intent.clone(), "why" => "the standby is cut off" } } else { obj! { "op" => "accept", "name" => "b", "intent" => intent.clone() } };
		ok(self.ts.lock().unwrap().step(&q))
	}
}
impl SyncPeer for Standby {
	fn accept(&mut self, intent: &Json) -> Result<Json, SyncError> { Standby::accept(self, intent) }
}

/// The rows of a store file: documents, parts and the store's meta, values canonical. The store's id and the marks a
/// reader leaves when it indexes a part's rows (`indexed…`) are the file's own, not replicated.
fn rows(path: &Path) -> Vec<String> {
	let db = Connection::open(path).unwrap();
	let canon = |t: String| parse(&t).map(|v| v.canonical().unwrap()).unwrap_or(t);
	let mut out = vec![];
	let mut s = db.prepare("SELECT kind, key, version, value FROM documents ORDER BY kind, key").unwrap();
	out.extend(s.query_map([], |r| Ok(format!("doc {} {} {} {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, canon(r.get::<_, String>(3)?)))).unwrap().map(Result::unwrap));
	let mut s = db.prepare("SELECT kind, key, part, id, ord, value, at, grp, flag FROM parts ORDER BY kind, key, part, id").unwrap();
	out.extend(
		s.query_map([], |r| {
			let at = match r.get_ref(6)? {
				rusqlite::types::ValueRef::Integer(x) => format!("{x}"),
				rusqlite::types::ValueRef::Real(x) => format!("{x}r"),
				_ => "null".into(),
			};
			Ok(format!("part {} {} {} {} ord {} at {at} grp {:?} flag {:?} {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, String>(3)?, r.get::<_, i64>(4)?, r.get::<_, Option<String>>(7)?, r.get::<_, Option<i64>>(8)?, canon(r.get::<_, String>(5)?)))
		})
		.unwrap()
		.map(Result::unwrap),
	);
	let mut s = db.prepare("SELECT key, value FROM store_meta WHERE key <> 'store_id' AND key NOT LIKE 'indexed%' ORDER BY key").unwrap();
	out.extend(s.query_map([], |r| Ok(format!("meta {} {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?))).unwrap().map(Result::unwrap));
	out
}

struct Primary {
	host: SpaceHost,
	gate: PrimaryGate,
}
fn open_primary(path: &Path, journal: SyncJournal, standby: &Standby, init: Option<&Json>, seed: u64) -> Primary {
	let p = PrimaryOptions { peer: Some(Box::new(standby.clone())), assert_primary: Box::new(|| Ok(())), now: Box::new(|| 1_000.0) };
	let ledger = SqliteLedger::open_primary(path, WriterOptions::default(), journal, p).unwrap();
	let gate = ledger.gate().cloned().unwrap();
	let mut host = SpaceHost::open(SpaceHost::sqlite(ledger), KIND, Some(KEY), seeded(&format!("cross-{seed}"))).unwrap();
	if let Some(init) = init {
		host.commit(|s| {
			let text = |k: &str| init.get(k).and_then(Json::as_str).map(str::to_owned);
			s.state.space_id = text("spaceId");
			s.state.incarnation = text("incarnation");
			if let Some(l) = init.get("limits").and_then(Json::as_object) {
				s.state.limits = Some(l.clone());
			}
			Ok(())
		})
		.unwrap()
		.unwrap();
	}
	Primary { host, gate }
}

fn walk(seed: u64, steps: usize, seen: &mut BTreeMap<&'static str, usize>) {
	let (d, t) = (dir(&format!("primary-cross-{seed}")), dir(&format!("primary-cross-{seed}-ts")));
	let store = d.join("a.store.sqlite");
	let ts = Arc::new(Mutex::new(TsDriver::script("test/support/journal-driver.ts")));
	let standby = Standby { ts: Arc::clone(&ts), cut: Arc::new(Mutex::new(false)) };
	let small = seed.is_multiple_of(3);
	let bounds = if small { (Some(32_768.0), Some(if seed.is_multiple_of(2) { 400_000.0 } else { 4_000_000.0 })) } else { (None, None) };
	let options = || JournalOptions { max_intent_bytes: bounds.0, max_history_bytes: bounds.1, format: Some("own".into()), ..Default::default() };
	let opened = ts.lock().unwrap().step(&obj! { "op" => "open", "name" => "b", "path" => t.join("b.sqlite").to_string_lossy().to_string(), "genesis" => genesis(), "self" => "b", "format" => "own", "maxIntentBytes" => bounds.0.map_or(Json::Null, Json::Number), "maxHistoryBytes" => bounds.1.map_or(Json::Null, Json::Number) });
	ok(opened).unwrap();
	let journal = SyncJournal::open(&d.join("a.sqlite"), &genesis(), options()).unwrap();
	let mut w = Walk::new(seed);
	w.without_restores = true; // the store does not keep restored history yet (R6b step 3)
	let init = w.init();
	let mut p = open_primary(&store, journal, &standby, Some(&init), seed);
	let overlap = seed % 2 == 1;
	// the step at which the standby refuses once (walks that do not overlap: the commit's answer is its batch's)
	let cut_at = (seed % 4 == 2).then_some(steps / 3 + (seed as usize % 17));
	let mut snapshots = Snapshots::new();
	let mut clock = init.get("now").and_then(Json::as_f64).unwrap_or(0.0);
	for step in 0..steps {
		let rev = p.host.space.state.stream.as_ref().map_or(0.0, |s| s.rev);
		// small budgets: now and then a commit too large for one entry
		let line = if small && step % 40 == 39 { obj! { "op" => "write", "entry" => obj! { "type" => "Task", "fields" => obj! { "n" => step as f64, "pad" => "x".repeat(17_000) } }, "lease" => 60_000.0 } } else { w.line(rev) };
		if let Some(now) = line.get("now").and_then(Json::as_f64) {
			clock = now;
		}
		let now = clock;
		let before = digest_json(&p.host.space.state.to_json()).unwrap();
		let op = |s: &mut phi_core::Space| {
			s.clock = now;
			apply_line(s, &mut snapshots, now, &line)
		};
		if cut_at == Some(step) {
			*standby.cut.lock().unwrap() = true;
		}
		let r = if overlap { p.host.start_commit(op).map(|r| r.map(|c| c.value)) } else { p.host.commit(op) };
		let r = match r {
			Ok(r) => r,
			Err(e) => {
				// the batch was sealed and not confirmed: its commit fails, the store names the candidate and takes no more
				// (a commit that changes nothing writes no batch: the cut waits for the next one)
				assert!(cut_at.is_some_and(|c| step >= c) && !*standby.cut.lock().unwrap(), "seed {seed} step {step}: the store failed: {e}");
				assert!(e.to_string().contains(SEALED), "seed {seed}: {e}");
				let (revision, hash) = p.gate.sealed().expect("a poisoned store names its candidate");
				let later = p.host.commit(|_| Ok(()));
				assert!(later.is_err(), "seed {seed}: a poisoned store took a commit");
				let head = p.gate.journal(|j| j.head().unwrap());
				assert_eq!((revision, hash.as_str()), (head.get("revision").and_then(Json::as_f64).unwrap(), head.get("hash").and_then(Json::as_str).unwrap()));
				*seen.entry("poisoned and resolved").or_default() += 1;
				// resolved with the standby, then the primary is opened anew on what its store holds
				let Primary { host, gate } = p;
				host.close();
				let mut journal = gate.into_journal().ok().expect("the writer is gone");
				let mut file = SyncStoreFile::open(&store).unwrap();
				let s = standby.clone();
				let mut accept = |i: &Json| s.accept(i);
				recover_primary_sync(&mut file, &mut journal, Some(&mut accept), &|| Ok(())).unwrap();
				drop(file);
				p = open_primary(&store, journal, &standby, None, seed);
				continue;
			}
		};
		match &r {
			Err(e) if e.class == "SyncJournalFull" => {
				// refused before it was published: nothing of it is kept
				assert_eq!(before, digest_json(&p.host.space.state.to_json()).unwrap(), "seed {seed} step {step}: a refused commit left a trace");
				*seen.entry(if e.message.starts_with("sync history is full") { "refused: history full" } else { "refused: entry budget" }).or_default() += 1;
			}
			_ => {}
		}
		observe(&mut w, &line, &r, &p.host.space, seen);
	}
	p.host.drain().unwrap();
	let Primary { host, gate } = p;
	host.close();
	let journal = gate.into_journal().ok().expect("the writer is gone");
	let head = journal.head().unwrap();
	assert_eq!(journal.applied_revision().unwrap() as f64, head.get("revision").and_then(Json::as_f64).unwrap(), "seed {seed}: every sealed batch is applied");
	*seen.entry("entries sealed").or_default() += journal.head_revision().unwrap() as usize;
	// the standby's history, materialized by TypeScript, is the primary's store
	let mut ts = ts.lock().unwrap();
	let state = ok(ts.step(&obj! { "op" => "state", "name" => "b" })).unwrap();
	assert_eq!(state.get("head").unwrap().canonical().unwrap(), head.canonical().unwrap(), "seed {seed}: the journals' heads");
	let sb = t.join("b.store.sqlite");
	ok(ts.step(&obj! { "op" => "storeOpen", "store" => "b", "path" => sb.to_string_lossy().to_string() })).unwrap();
	ok(ts.step(&obj! { "op" => "materialize", "name" => "b", "store" => "b" })).unwrap();
	ok(ts.step(&obj! { "op" => "storeClose", "store" => "b" })).unwrap();
	ok(ts.step(&obj! { "op" => "close", "name" => "b" })).unwrap();
	let (r, t) = (rows(&store), rows(&sb));
	if let Some((a, b)) = r.iter().zip(&t).find(|(a, b)| a != b) {
		panic!("seed {seed}: the stores differ\n  Rust primary:       {a}\n  TypeScript standby: {b}");
	}
	assert_eq!(r.len(), t.len(), "seed {seed}: row counts");
	*seen.entry("rows compared").or_default() += r.len();
}

#[test]
fn a_rust_primary_replicates_to_a_typescript_standby() {
	let total: usize = std::env::var("PHI_PRIMARY_CROSS_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(1_200);
	let mut seen = BTreeMap::new();
	if let Some(seed) = std::env::var("PHI_PRIMARY_CROSS_SEED").ok().and_then(|s| s.parse().ok()) {
		walk(seed, total, &mut seen);
		eprintln!("{seen:#?}");
		return;
	}
	let per_walk = 200;
	for seed in 0..total.div_ceil(per_walk).max(6) as u64 {
		walk(seed, per_walk, &mut seen);
	}
	eprintln!("{seen:#?}");
	for k in ["poisoned and resolved", "refused: entry budget", "entries sealed"] {
		assert!(seen.get(k).is_some_and(|n| *n > 0), "the walks never reached: {k}");
	}
}

/// What the budget counts is `Buffer.byteLength(JSON.stringify(rows))` of the TypeScript rows.
#[test]
fn the_budget_counts_the_bytes_typescript_counts() {
	let ops = vec![
		WriteOp::Doc { kind: "k\u{e4}".into(), key: "\"quoted\"\n".into(), version: 3, value: "{\"a\":\"\u{1f600}\\u0001\"}".into() },
		WriteOp::Retire { kind: "k".into(), key: "".into() },
		WriteOp::Part { kind: "k".into(), key: "x".into(), part: "rpc.claims".into(), id: "\u{1}id\t".into(), ord: 0, value: "{}".into(), at: Some(1_700_000_000_123.5), grp: Some("g\u{2028}".into()), flag: Some(1) },
		WriteOp::Part { kind: "k".into(), key: "x".into(), part: "entries".into(), id: "e1".into(), ord: 12, value: "1e21".into(), at: Some(1e21), grp: None, flag: None },
		WriteOp::Part { kind: "k".into(), key: "x".into(), part: "entries".into(), id: "e2".into(), ord: -1, value: "0".into(), at: Some(0.1 + 0.2), grp: None, flag: Some(0) },
		WriteOp::PartDel { kind: "k".into(), key: "x".into(), part: "p".into(), id: "\\".into() },
		WriteOp::Meta { key: "sync-marker:x".into(), value: "{\"revision\":1}".into() },
	];
	let mut ts = TsDriver::script("test/support/journal-driver.ts");
	let t = ts.step(&obj! { "op" => "bytes", "value" => deltas(&ops) });
	assert_eq!(t.get("result").and_then(Json::as_f64), Some(delta_bytes(&ops) as f64), "{}", deltas(&ops).to_json_text());
}

/// Commits admitted and not yet sealed count against the history twice their bytes, as `admit` counts them in
/// TypeScript: a burst cannot overfill the history before its batches reach the journal.
#[test]
fn admitted_commits_count_against_the_history_before_they_are_sealed() {
	let d = dir("primary-admit");
	let o = JournalOptions { max_intent_bytes: Some(32_768.0), max_history_bytes: Some(32_768.0), format: Some("own".into()), ..Default::default() };
	let journal = SyncJournal::open(&d.join("a.sqlite"), &genesis(), o).unwrap();
	let (_writer_side, gate) = phi_store::primary::primary_replication(journal.into(), PrimaryOptions { peer: None, assert_primary: Box::new(|| Ok(())), now: Box::new(|| 0.0) });
	let ops = vec![WriteOp::Doc { kind: "k".into(), key: "x".into(), version: 1, value: "y".repeat(6_000) }];
	let bytes = delta_bytes(&ops);
	assert_eq!(gate.admit(&ops), Ok(bytes));
	assert_eq!(gate.admit(&ops), Ok(bytes));
	assert_eq!(gate.admit(&ops), Err(SyncError::Full("sync history is full; no committed result was discarded".into())));
	let big = vec![WriteOp::Doc { kind: "k".into(), key: "x".into(), version: 1, value: "y".repeat(17_000) }];
	assert_eq!(gate.admit(&big), Err(SyncError::Full(format!("the commit's rows ({} bytes) do not fit one sync journal entry (at most 32768 bytes)", delta_bytes(&big)))));
}
