// R2, slices 2 and 4 (docs/rust-portierung.md): operating a store. Overlapping commits, watches that see durable state
// only, batching, closing with commits on their way; a backup under load and its restore, compaction between batches,
// a clean close; the checks of format, document version and what the store does not read yet; and a growing stock of
// claims, whose cost must not grow with it, in SQLite and in memory.
mod support;
use phi_core::driver::seeded;
use phi_json::{obj, Json, FOREVER};
use phi_store::{backup, Fault, Ledger, MemoryLedger, SpaceHost, SqliteLedger, StoreError, Synchronous, WriterOptions};
use rusqlite::Connection;
use std::collections::BTreeSet;
use std::path::Path;
use std::time::{Duration, Instant};
use support::{commit_pair, dir, survivors, KIND};

fn host(file: &Path, o: WriterOptions) -> SpaceHost { SpaceHost::open(SpaceHost::sqlite(SqliteLedger::open_with(file, o).unwrap()), KIND, None, seeded("ops")).unwrap() }
fn slow_first() -> WriterOptions { WriterOptions { fault: Some((1, Fault::Slow(Duration::from_millis(300)))), ..Default::default() } }
/// Starts the commit of the pair `i` without waiting; its number.
fn start_pair(h: &mut SpaceHost, i: u64) -> Result<u64, StoreError> {
	h.start_commit(|s| {
		for half in [0.0, 1.0] {
			let entry = obj! { "type" => "Pair", "fields" => obj! { "i" => i as f64, "half" => half } };
			s.write(1000.0, &entry, None, Some(&Json::Number(FOREVER)), None)?;
		}
		Ok(())
	})
	.map(|r| r.expect("admitted").seq)
}
fn meta(file: &Path, key: &str) -> String { Connection::open(file).unwrap().query_row("SELECT value FROM store_meta WHERE key = ?", [key], |r| r.get(0)).unwrap() }
fn integrity(file: &Path) -> String { Connection::open(file).unwrap().query_row("PRAGMA integrity_check", [], |r| r.get(0)).unwrap() }
/// Rows of the parts of the Space, as text.
fn rows(file: &Path) -> Vec<String> {
	let db = Connection::open(file).unwrap();
	let mut s = db.prepare("SELECT part, id, ord, value FROM parts ORDER BY part, id").unwrap();
	let out = s.query_map([], |r| Ok(format!("{} {} {} {}", r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, String>(3)?))).unwrap().map(Result::unwrap).collect();
	out
}

#[test]
fn overlapping_commits_build_on_each_other_and_readers_see_durable_state() {
	let d = dir("ops-overlap");
	let file = d.join("s.sqlite");
	let mut h = host(&file, slow_first());
	let watch = h.watch();
	let mut last = 0;
	for i in 0..20 {
		last = start_pair(&mut h, i).unwrap();
		assert_eq!(h.space.state.entries.len(), 2 * (i as usize + 1), "the next commit sees the one before it");
	}
	// the first batch takes 300 ms: nothing is acknowledged yet, and a watch has heard nothing
	h.pump().unwrap();
	assert_eq!(watch.poll(), None, "a watch sees durable state only");
	// a reader outside a commit waits for all of it
	assert_eq!(h.committed().unwrap().entries.len(), 40);
	assert_eq!(watch.poll(), Some(last), "what happened meanwhile comes as one");
	assert_eq!(watch.poll(), None);
	h.close();
	assert!(watch.closed());
	// the first commit alone, and what came while it was written in batches: how many depends on the writer thread's timing
	let batches: u32 = meta(&file, "commit_seq").parse().unwrap();
	assert!((2..20).contains(&batches), "20 commits in {batches} batches");
	assert_eq!(survivors(&file), (0..20).collect());
}

#[test]
fn claims_of_overlapping_commits_are_read_from_memory_until_they_are_durable() {
	let d = dir("ops-overlap-claims");
	let mut h = host(&d.join("s.sqlite"), WriterOptions::default());
	let principal = obj! { "peerId" => "p1" };
	let g = h.commit(|s| s.issue_generation(1000.0, Some(&principal), &obj! {})).unwrap().unwrap();
	let generation = g.get("generation").and_then(Json::as_str).unwrap().to_owned();
	let mut d2 = None;
	for i in 0..30 {
		let request = obj! { "principal" => principal.clone(), "generation" => generation.as_str(), "requestId" => format!("r{i}") };
		h.start_commit(|s| {
			let ad = s.admit(1000.0, Some(&request), &"m".into(), &Json::Null, &Json::Number(FOREVER), 1024.0)?;
			s.decide_line(1000.0, ad.get("key"), Some(&obj! { "state" => "done", "result" => i as f64 }))?;
			Ok(())
		})
		.unwrap()
		.unwrap();
		// at once the request is known, durable or not
		let seen = h.commit(|s| s.lookup(1000.0, Some(&request))).unwrap().unwrap();
		assert_eq!(seen.get("result").and_then(Json::as_f64), Some(i as f64));
		d2 = Some(request);
	}
	let r = d2.unwrap();
	assert_eq!(h.space.lookup(1000.0, Some(&r)).unwrap().get("result").and_then(Json::as_f64), Some(29.0));
	h.close();
}

#[test]
fn a_claim_stays_in_memory_until_its_own_commit_is_durable() {
	// A is durable while B is still being written: what B wrote is not on the disk yet and must not be let go with A
	let d = dir("ops-stamps");
	let mut h = host(&d.join("s.sqlite"), WriterOptions { fault: Some((0, Fault::Slow(Duration::from_millis(200)))), ..Default::default() });
	let principal = obj! { "peerId" => "p1" };
	let g = h.commit(|s| s.issue_generation(1000.0, Some(&principal), &obj! {})).unwrap().unwrap();
	let request = |id: &str| obj! { "principal" => principal.clone(), "generation" => g.get("generation").unwrap().clone(), "requestId" => id };
	let (a, b) = (request("a"), request("b"));
	let decided = |h: &mut SpaceHost, r: &Json| {
		h.start_commit(|s| {
			let ad = s.admit(1000.0, Some(r), &"m".into(), &Json::Null, &Json::Number(FOREVER), 1024.0)?;
			s.decide_line(1000.0, ad.get("key"), Some(&obj! { "state" => "done", "result" => 1.0 }))
		})
		.unwrap()
		.unwrap()
		.seq
	};
	let first = decided(&mut h, &a);
	decided(&mut h, &b);
	h.durable(first).unwrap();
	assert!(h.space.lookup(1000.0, Some(&b)).is_ok(), "the claim of the commit still being written");
	assert!(h.space.lookup(1000.0, Some(&a)).is_ok(), "the claim read from the disk");
	h.close();
}

#[test]
fn a_failed_batch_fails_what_overlaps_it() {
	let d = dir("ops-overlap-fail");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { fault: Some((1, Fault::FailBeforeCommit)), ..Default::default() });
	let mut acked = BTreeSet::new();
	for i in 0..10 {
		match start_pair(&mut h, i) {
			Ok(seq) => {
				if h.durable(seq).is_ok() {
					acked.insert(i);
				}
			}
			Err(_) => break,
		}
	}
	assert!(acked.is_empty(), "nothing after the failure is acknowledged");
	assert!(matches!(h.committed(), Err(StoreError::Failed(_))), "a reader is refused too: memory may hold what never reached the disk");
	h.close();
	assert_eq!(survivors(&file), BTreeSet::new());
}

#[test]
fn closing_writes_the_commits_still_on_their_way() {
	let d = dir("ops-close-waiting");
	let file = d.join("s.sqlite");
	let mut h = host(&file, slow_first());
	for i in 0..20 {
		start_pair(&mut h, i).unwrap();
	}
	h.close();
	assert_eq!(survivors(&file), (0..20).collect());
}

#[test]
fn a_clean_close_leaves_one_whole_file_and_the_owner_lock_free() {
	let d = dir("ops-clean-close");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions::default());
	commit_pair(&mut h, 0, 1).unwrap();
	h.close();
	assert!(!d.join("s.sqlite-wal").exists(), "the last connection took the WAL into the file");
	assert_eq!(integrity(&file), "ok");
	let again = host(&file, WriterOptions::default());
	again.close();
}

#[test]
fn a_backup_taken_while_the_store_writes_is_a_consistent_state_that_restores() {
	let d = dir("ops-backup");
	let (file, copy, restored) = (d.join("s.sqlite"), d.join("backup.sqlite"), d.join("restored.sqlite"));
	let mut h = host(&file, WriterOptions::default());
	for i in 0..30 {
		commit_pair(&mut h, i, 300).unwrap();
	}
	let (from, to) = (file.clone(), copy.clone());
	let taker = std::thread::spawn(move || {
		std::thread::sleep(Duration::from_millis(30));
		backup(&from, &to).unwrap();
	});
	let mut written = 30;
	while !taker.is_finished() || written < 40 {
		commit_pair(&mut h, written, 300).unwrap();
		written += 1;
	}
	taker.join().unwrap();
	h.close();
	assert_eq!(integrity(&copy), "ok");
	let there = survivors(&copy);
	assert!(there.len() >= 30 && there.len() <= written as usize, "the backup holds {} of {written}", there.len());
	assert_eq!(there, (0..there.len() as u64).collect(), "a prefix of the commits, none torn");
	// the restore: the backup is the store of a new place, which goes on writing; the original is untouched
	std::fs::copy(&copy, &restored).unwrap();
	let mut r = host(&restored, WriterOptions::default());
	commit_pair(&mut r, there.len() as u64, 1).unwrap();
	r.close();
	assert_eq!(survivors(&restored).len(), there.len() + 1);
	assert_eq!(survivors(&file).len(), written as usize);
}

#[test]
fn compaction_gives_free_pages_back_between_batches_and_changes_no_row() {
	let d = dir("ops-compact");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { synchronous: Synchronous::Normal, ..Default::default() });
	for i in 0..300 {
		commit_pair(&mut h, i, 2000).unwrap();
	}
	// most of it goes: the file keeps its pages until a compaction
	for _ in 0..560 {
		h.commit(|s| s.probe(1000.0, &phi_core::Template::Any, None, true, None)).unwrap().unwrap();
	}
	h.drain().unwrap();
	let grown = std::fs::metadata(&file).unwrap().len() + std::fs::metadata(d.join("s.sqlite-wal")).unwrap().len();
	let first = h.compact().unwrap().unwrap();
	assert!(first.error.is_none() && first.converted && first.freed_pages > 0, "{first:?}");
	// a commit started before a compaction is written before it; what comes after goes on
	let seq = start_pair(&mut h, 1000).unwrap();
	let second = h.compact().unwrap().unwrap();
	assert!(second.error.is_none() && !second.converted, "{second:?}");
	h.durable(seq).unwrap();
	commit_pair(&mut h, 1001, 1).unwrap();
	h.close();
	let before = rows(&file);
	let size = std::fs::metadata(&file).unwrap().len();
	assert!(size * 2 < grown, "the file gave its pages back: {size} of {grown} bytes");
	assert_eq!(integrity(&file), "ok");
	let there = survivors(&file);
	assert!(there.contains(&1000) && there.contains(&1001) && there.len() == 22, "{there:?}");
	assert_eq!(rows(&file), before);
}

#[test]
fn format_version_and_what_is_not_read_yet_are_checked() {
	let d = dir("ops-format");
	// a format 1 file: parts without index columns; opening migrates it, the first read fills them
	let file = d.join("old.sqlite");
	let mut h = host(&file, WriterOptions::default());
	let principal = obj! { "peerId" => "p1" };
	let g = h.commit(|s| s.issue_generation(1000.0, Some(&principal), &obj! {})).unwrap().unwrap();
	let request = obj! { "principal" => principal.clone(), "generation" => g.get("generation").unwrap().clone(), "requestId" => "r1" };
	h.commit(|s| {
		let ad = s.admit(1000.0, Some(&request), &"m".into(), &Json::Null, &Json::Number(FOREVER), 1024.0)?;
		s.decide_line(1000.0, ad.get("key"), Some(&obj! { "state" => "done", "result" => 7.0 }))
	})
	.unwrap()
	.unwrap();
	h.close();
	let want = rows(&file);
	Connection::open(&file)
		.unwrap()
		.execute_batch(
			"DROP INDEX parts_at; DROP INDEX parts_grp; DROP INDEX parts_open;
			 ALTER TABLE parts DROP COLUMN at; ALTER TABLE parts DROP COLUMN grp; ALTER TABLE parts DROP COLUMN flag;
			 UPDATE store_meta SET value = '1' WHERE key = 'format_version';",
		)
		.unwrap();
	let mut h = host(&file, WriterOptions::default());
	assert_eq!(h.commit(|s| s.lookup(1000.0, Some(&request))).unwrap().unwrap().get("result").and_then(Json::as_f64), Some(7.0));
	h.close();
	assert_eq!(meta(&file, "format_version"), "2");
	assert_eq!(rows(&file), want);
	let flag: (Option<i64>, Option<String>, i64) = Connection::open(&file).unwrap().query_row("SELECT at, grp, flag FROM parts WHERE part = 'rpc.claims'", [], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).unwrap();
	assert_eq!((flag.0, flag.1.is_some(), flag.2), (Some(1000), true, 0), "the index columns are filled");

	let refused = |file: &Path, what: &str| match SpaceHost::open(SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()), KIND, None, seeded("x")) {
		Err(StoreError::Unavailable(m)) => assert!(m.contains(what), "{m}"),
		Err(e) => panic!("{e}"),
		Ok(_) => panic!("{what}: not refused"),
	};
	// an older document (TypeScript migrates it), a part inline in the head, a negative claim: refused, never damaged
	let old = d.join("version.sqlite");
	host(&old, WriterOptions::default()).close();
	let mut h = host(&old, WriterOptions::default());
	commit_pair(&mut h, 0, 1).unwrap();
	h.close();
	Connection::open(&old).unwrap().execute("UPDATE documents SET version = 4", []).unwrap();
	refused(&old, "has version 4");
	Connection::open(&old).unwrap().execute_batch("UPDATE documents SET version = 5; DELETE FROM parts; UPDATE documents SET value = json_set(value, '$.entries', json('[{\"id\":\"e1\"}]'));").unwrap();
	refused(&old, "inline in its head");
	Connection::open(&file).unwrap().execute("UPDATE parts SET value = json_set(value, '$.notCommitted', json('{}')) WHERE part = 'rpc.claims'", []).unwrap();
	refused(&file, "claims of a kind");
}

/// The time of `block` admitted and decided requests, the best of three (a single round may meet a scheduler's pause).
fn round(h: &mut SpaceHost, generation: &str, from: &mut u64, block: u64) -> Duration {
	let mut best = Duration::MAX;
	for _ in 0..3 {
		let t = Instant::now();
		fill(h, generation, from, block);
		best = best.min(t.elapsed());
	}
	best
}
fn fill(h: &mut SpaceHost, generation: &str, from: &mut u64, n: u64) {
	for _ in 0..n {
		let request = obj! { "principal" => obj! { "peerId" => "p1" }, "generation" => generation, "requestId" => format!("r{from}") };
		*from += 1;
		h.commit(|s| {
			let ad = s.admit(1000.0, Some(&request), &"m".into(), &Json::Null, &Json::Number(FOREVER), 64.0)?;
			s.decide_line(1000.0, ad.get("key"), Some(&obj! { "state" => "done", "result" => 1.0 }))
		})
		.unwrap()
		.unwrap();
	}
}
/// What R0 found in the TypeScript memory store (docs/rust-portierung.md): a call costs more the more claims a day has
/// brought. Here a request costs the same with 20 times the claims.
fn claims_do_not_slow_it_down(mut h: SpaceHost, what: &str, n: u64) {
	h.commit(|s| {
		s.state.limits = obj! { "maxClaimBytes" => 8e9, "maxDocBytes" => 8e9, "generationAdmitMs" => 8e9, "claimResultMs" => 8e9, "maxLogBytes" => 65536.0 }.as_object().cloned();
		Ok(())
	})
	.unwrap()
	.unwrap();
	let g = h.commit(|s| s.issue_generation(1000.0, Some(&obj! { "peerId" => "p1" }), &obj! {})).unwrap().unwrap();
	let generation = g.get("generation").and_then(Json::as_str).unwrap().to_owned();
	let mut next = 0;
	fill(&mut h, &generation, &mut next, n / 20);
	let early = round(&mut h, &generation, &mut next, 200);
	fill(&mut h, &generation, &mut next, n);
	let late = round(&mut h, &generation, &mut next, 200);
	eprintln!("{what}: 200 requests take {early:?} at {} claims, {late:?} at {next}", n / 20);
	assert!(late < early * 3, "{what}: {early:?} became {late:?} with {next} claims");
	h.close();
}

#[test]
fn a_growing_stock_of_claims_costs_nothing_per_request_in_memory() {
	let n = std::env::var("PHI_STORE_CLAIMS").ok().and_then(|s| s.parse().ok()).unwrap_or(20_000);
	claims_do_not_slow_it_down(SpaceHost::open(Ledger::Memory(MemoryLedger::default()), KIND, None, seeded("mem")).unwrap(), "memory", n);
}

#[test]
fn a_growing_stock_of_claims_costs_nothing_per_request_in_sqlite() {
	// the system's temp directory: what the store itself costs. PHI_STORE_GROW_DIR measures a disk of choice, whose
	// checkpoints write more scattered pages the larger the file is
	let base = std::env::var("PHI_STORE_GROW_DIR").map(std::path::PathBuf::from).unwrap_or_else(|_| std::env::temp_dir());
	let d = base.join(format!("phi-store-grow-{}", std::process::id()));
	std::fs::create_dir_all(&d).unwrap();
	let n = std::env::var("PHI_STORE_CLAIMS").ok().and_then(|s| s.parse().ok()).unwrap_or(20_000);
	claims_do_not_slow_it_down(host(&d.join("s.sqlite"), WriterOptions { synchronous: Synchronous::Normal, ..Default::default() }), "sqlite", n);
	let _ = std::fs::remove_dir_all(&d);
}
