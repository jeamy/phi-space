// R2, slice 2 (docs/rust-portierung.md): crash and reopen, as test/test-own-store.test.ts does for the TypeScript store.
// A child process (this test binary again, `crash_child`) commits pairs of entries until it is killed with SIGKILL, at a
// random moment or at a pause of its writer thread (PHI_SPACES_WRITER_PAUSE, the same switch as sqlite-writer.ts):
// every commit it acknowledged must be there, never half of one, and both the Rust and the TypeScript store read the
// crashed file alike. The other way round, a killed TypeScript child (test/support/store-crash-child.ts) leaves a file
// the Rust store reads as the TypeScript one does.
mod support;
use phi_core::driver::seeded;
use phi_json::{obj, Json, FOREVER};
use phi_store::{SpaceHost, SqliteLedger, Synchronous};
use std::collections::BTreeSet;
use support::{dir, root, survivors, KIND};
use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc::channel;
use std::time::Duration;

/// The child: commits pairs on the file in PHI_STORE_CRASH_FILE, counting from PHI_STORE_CRASH_FROM, until killed.
#[test]
#[ignore = "run by the crash tests as their child process"]
fn crash_child() {
	let Ok(file) = std::env::var("PHI_STORE_CRASH_FILE") else { return };
	let mut i: u64 = std::env::var("PHI_STORE_CRASH_FROM").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
	let ledger = SpaceHost::sqlite(SqliteLedger::open(Path::new(&file), Synchronous::Full).unwrap());
	let mut host = SpaceHost::open(ledger, KIND, None, seeded("crash")).unwrap();
	println!("OPEN");
	loop {
		let n = i;
		host.commit(|s| {
			for half in [0.0, 1.0] {
				let entry = obj! { "type" => "Pair", "fields" => obj! { "i" => n as f64, "half" => half } };
				s.write(1000.0, &entry, None, Some(&Json::Number(FOREVER)), None)?;
			}
			Ok(())
		})
		.unwrap()
		.unwrap();
		println!("ACK {n}");
		i += 1;
	}
}

/// Runs a child (`rust`: this binary, else the TypeScript one) on `file` until `when` says kill; the commits it
/// acknowledged before it died.
fn crash_run(rust: bool, file: &Path, env: &[(&str, String)], from: u64, when: impl FnOnce(&dyn Fn() -> usize)) -> BTreeSet<u64> {
	let mut cmd = if rust {
		let mut c = Command::new(std::env::current_exe().unwrap());
		c.args(["crash_child", "--exact", "--ignored", "--nocapture", "--test-threads=1"]).env("PHI_STORE_CRASH_FILE", file).env("PHI_STORE_CRASH_FROM", from.to_string());
		c
	} else {
		let mut c = Command::new("node");
		c.args(["--experimental-strip-types", "--no-warnings", "test/support/store-crash-child.ts", file.to_str().unwrap(), &from.to_string()]).current_dir(root());
		c
	};
	for (k, v) in env {
		cmd.env(k, v);
	}
	/// Kills the child also when the test fails on the way (a held writer would otherwise live on).
	struct Guard(std::process::Child);
	impl Drop for Guard {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}
	let mut child = Guard(cmd.stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap());
	let out = BufReader::new(child.0.stdout.take().unwrap());
	let (tx, rx) = channel::<String>();
	let reader = std::thread::spawn(move || {
		for l in out.lines().map_while(Result::ok) {
			if tx.send(l).is_err() {
				break;
			}
		}
	});
	let acks = std::sync::Mutex::new(BTreeSet::new());
	let collect = || {
		while let Ok(l) = rx.try_recv() {
			if let Some(n) = l.strip_prefix("ACK ") {
				acks.lock().unwrap().insert(n.parse::<u64>().unwrap());
			}
		}
		acks.lock().unwrap().len()
	};
	// opened
	loop {
		let l = rx.recv_timeout(Duration::from_secs(30)).expect("the child opens its store");
		if l.ends_with("OPEN") {
			// (a test binary's child: libtest prints "test crash_child ... " before it, on the same line)
			break;
		}
	}
	when(&collect);
	child.0.kill().unwrap(); // SIGKILL
	child.0.wait().unwrap();
	reader.join().unwrap();
	collect();
	acks.into_inner().unwrap()
}

fn wait_for(marker: &Path) {
	while !marker.exists() {
		std::thread::sleep(Duration::from_millis(5));
	}
}

#[test]
fn killed_at_any_moment_a_store_keeps_every_acknowledged_commit_and_no_half_of_one() {
	for rust in [true, false] {
		let d = dir(if rust { "crash-any-rust" } else { "crash-any-ts" });
		let file = d.join("s.sqlite");
		for (run, delay) in [0u64, 20, 60, 150, 300].into_iter().enumerate() {
			let acked = crash_run(rust, &file, &[], run as u64 * 1_000_000, |_| std::thread::sleep(Duration::from_millis(delay)));
			let there = survivors(&file);
			for i in &acked {
				assert!(there.contains(i), "acknowledged commit {i} is lost (killed after {delay} ms, {} child)", if rust { "Rust" } else { "TypeScript" });
			}
		}
	}
}

#[test]
fn killed_right_before_the_disk_transaction_commits_what_was_not_acknowledged_is_not_there() {
	let d = dir("crash-before");
	let (file, marker) = (d.join("s.sqlite"), d.join("paused"));
	let acked = crash_run(true, &file, &[("PHI_SPACES_WRITER_PAUSE", format!("before-commit:3:{}", marker.display()))], 0, |acks| {
		wait_for(&marker);
		std::thread::sleep(Duration::from_millis(300));
		acks();
	});
	let there = survivors(&file);
	assert_eq!(acked.len(), 2, "two batches written and acknowledged, the third held before its COMMIT");
	assert_eq!(there, acked, "exactly the acknowledged ones");
}

#[test]
fn killed_after_the_disk_transaction_committed_but_before_the_answer_the_commit_is_there_unacknowledged() {
	let d = dir("crash-after");
	let (file, marker) = (d.join("s.sqlite"), d.join("paused"));
	let acked = crash_run(true, &file, &[("PHI_SPACES_WRITER_PAUSE", format!("after-commit:3:{}", marker.display()))], 0, |acks| {
		wait_for(&marker);
		std::thread::sleep(Duration::from_millis(300));
		acks();
	});
	let there = survivors(&file);
	assert!(acked.iter().all(|i| there.contains(i)));
	assert_eq!(there.len(), acked.len() + 1, "the third batch is durable without an answer ({} on disk, {} acknowledged)", there.len(), acked.len());
}
