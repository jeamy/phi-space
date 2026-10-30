// R2, slice 2 (docs/rust-portierung.md): what a store does when writing fails. A full disk (SQLITE_FULL), a fault before
// the commit point, an answer lost after it, and a writer thread that is gone: the failing commit is not acknowledged,
// the host takes no more work until it is reopened, and what was acknowledged stays (read by the Rust and the
// TypeScript store alike). A request whose answer was lost is retried under its original identity and has no second
// effect.
mod support;
use phi_core::driver::seeded;
use phi_json::{obj, Json, FOREVER};
use phi_store::{Fault, SpaceHost, SqliteLedger, StoreError, WriterOptions};
use std::collections::BTreeSet;
use std::path::Path;
use support::{commit_pair, dir, survivors, KIND};

fn host(file: &Path, o: WriterOptions) -> SpaceHost { SpaceHost::open(SpaceHost::sqlite(SqliteLedger::open_with(file, o).unwrap()), KIND, None, seeded("failures")).unwrap() }

/// Commits pairs until one fails: the acknowledged ones, and the error.
fn until_failure(h: &mut SpaceHost, pad: usize, limit: u64) -> (BTreeSet<u64>, StoreError) {
	let mut acked = BTreeSet::new();
	for i in 0..limit {
		match commit_pair(h, i, pad) {
			Ok(()) => {
				acked.insert(i);
			}
			Err(e) => return (acked, e),
		}
	}
	panic!("no commit failed in {limit}");
}

/// After a failure: the host refuses, and a reopened store holds exactly `want`.
fn locked_then_reopened(mut h: SpaceHost, file: &Path, want: &BTreeSet<u64>) {
	// the host takes no more work: it refuses before the operation runs (its memory may hold what is not on the disk)
	let mut ran = false;
	let r = h.commit(|_| {
		ran = true;
		Ok(())
	});
	assert!(matches!(r, Err(StoreError::Failed(_))) && !ran, "the host takes no more work");
	h.close();
	assert_eq!(&survivors(file), want);
	// and works again
	let mut again = host(file, WriterOptions::default());
	commit_pair(&mut again, 10_000, 1).unwrap();
	again.close();
}

#[test]
fn a_full_disk_fails_the_commit_and_locks_the_host() {
	let d = dir("fail-full");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { max_pages: Some(60), ..Default::default() });
	let (acked, e) = until_failure(&mut h, 3_000, 500);
	assert!(acked.len() >= 2, "{} commits fit", acked.len());
	assert!(e.to_string().contains("full"), "{e}");
	locked_then_reopened(h, &file, &acked);
}

#[test]
fn a_fault_before_the_commit_point_leaves_nothing_of_the_batch() {
	let d = dir("fail-before");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { fault: Some((3, Fault::FailBeforeCommit)), ..Default::default() });
	let (acked, _) = until_failure(&mut h, 10, 10);
	assert_eq!(acked, BTreeSet::from([0, 1]));
	locked_then_reopened(h, &file, &acked);
}

#[test]
fn an_answer_lost_after_the_commit_point_leaves_the_batch_unacknowledged() {
	let d = dir("fail-lost");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { fault: Some((3, Fault::LoseAnswer)), ..Default::default() });
	let (acked, _) = until_failure(&mut h, 10, 10);
	assert_eq!(acked, BTreeSet::from([0, 1]));
	locked_then_reopened(h, &file, &BTreeSet::from([0, 1, 2]));
}

#[test]
fn a_writer_that_is_gone_fails_every_commit_after_it() {
	let d = dir("fail-gone");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { fault: Some((3, Fault::WriterGone)), ..Default::default() });
	let (acked, e) = until_failure(&mut h, 10, 10);
	assert_eq!(acked, BTreeSet::from([0, 1]));
	assert!(e.to_string().contains("writer is gone"), "{e}");
	locked_then_reopened(h, &file, &acked);
}

#[test]
fn a_request_whose_answer_was_lost_is_retried_without_a_second_effect() {
	// as client.ts `mutate`: admit the request, perform it, decide its claim, all in one commit
	let d = dir("fail-retry");
	let file = d.join("s.sqlite");
	let mut h = host(&file, WriterOptions { fault: Some((3, Fault::LoseAnswer)), ..Default::default() });
	let principal = obj! { "peerId" => "p1" };
	let generation = h.commit(|s| s.issue_generation(1000.0, Some(&principal), &obj! {})).unwrap().unwrap();
	let generation = generation.get("generation").and_then(Json::as_str).unwrap().to_owned();
	commit_pair(&mut h, 0, 1).unwrap();
	let request = obj! { "principal" => principal.clone(), "generation" => generation.as_str(), "requestId" => "r1" };
	let args = obj! { "type" => "Task" };
	let mutate = |s: &mut phi_core::Space| {
		let ad = s.admit(1000.0, Some(&request), &"write".into(), &args, &Json::Number(FOREVER), 1024.0)?;
		if ad.get("kind").and_then(Json::as_str) == Some("done") {
			return Ok(ad.get("result").cloned().unwrap_or(Json::Null)); // the stored result, nothing executed
		}
		let key = ad.get("key").and_then(Json::as_str).unwrap().to_owned();
		let result = s.write(1000.0, &obj! { "type" => "Task", "fields" => obj! {} }, None, Some(&Json::Number(FOREVER)), None)?;
		s.decide_line(1000.0, Some(&key.into()), Some(&obj! { "state" => "done", "result" => result.clone() }))?;
		Ok(result)
	};
	assert!(matches!(h.commit(mutate), Err(StoreError::Failed(_))), "the third batch's answer is lost");
	h.close();
	let mut again = host(&file, WriterOptions::default());
	let retried = again.commit(mutate).unwrap().unwrap();
	assert_eq!(retried.get("id").and_then(Json::as_str), Some("e3"), "the stored result of the first attempt (the pair before has e1 and e2): {}", retried.to_json_text());
	let tasks = again.space.state.entries.iter().filter(|e| e.type_ == "Task").count();
	assert_eq!(tasks, 1, "one effect");
	again.close();
}
