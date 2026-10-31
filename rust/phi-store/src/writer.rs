//! The writer of the SQLite store (src/store/sqlite-writer.ts), on a thread of its own: a synchronous COMMIT with
//! synchronous=FULL waits for the disk. It takes the commits handed to it and writes whatever came while the previous
//! batch was written as one batch, in one transaction; each commit is acknowledged once its batch is durable.
use crate::ops::{apply_ops, WriteOp};
use rusqlite::Connection;
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

/// When a commit's batch is durable (or why it is not).
pub type Durable = Receiver<std::result::Result<(), String>>;

enum Msg {
	Write(Vec<WriteOp>, Sender<std::result::Result<(), String>>),
	Compact(Sender<Compaction>),
	Close(Sender<()>),
}

/// What a compaction did: the free pages given back to the file system, and whether the file was first switched to
/// incremental auto-vacuum (one full VACUUM). A failed compaction changes nothing and the store goes on (`error`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Compaction {
	pub freed_pages: i64,
	pub converted: bool,
	pub error: Option<String>,
}

/// `synchronous`: FULL (default) acknowledges a commit once it is on the disk; NORMAL may lose the last commits when the
/// system (not the process) fails.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Synchronous {
	Full,
	Normal,
}

/// Tests: what the writer does at one batch (sqlite.ts `StoreFaults`), as a failing disk or process would.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Fault {
	/// Nothing of the batch is written, and its commits fail (a crash before the commit point).
	FailBeforeCommit,
	/// The batch is durable, but its commits fail (a crash after the commit, before the answer).
	LoseAnswer,
	/// The writer thread ends without answering (it died).
	WriterGone,
	/// The batch takes this long to write (what arrives meanwhile goes together into the next one).
	Slow(Duration),
}

/// How the writer opens its connection.
#[derive(Clone, Copy, Debug)]
pub struct WriterOptions {
	pub synchronous: Synchronous,
	/// Tests: the file may not grow beyond this many pages, as on a full disk (SQLITE_FULL).
	pub max_pages: Option<u64>,
	/// Tests: what happens at this batch (0: at every batch).
	pub fault: Option<(u64, Fault)>,
}
impl Default for WriterOptions {
	fn default() -> Self { WriterOptions { synchronous: Synchronous::Full, max_pages: None, fault: None } }
}

/// Called on the writer's thread after each batch has been answered: the owner has something to `pump`.
pub type Waker = Arc<dyn Fn() + Send + Sync>;

pub struct Writer {
	tx: Sender<Msg>,
	thread: Option<JoinHandle<()>>,
	waker: Arc<Mutex<Option<Waker>>>,
}

/// Tests (crash tests): `PHI_SPACES_WRITER_PAUSE=<before-commit|after-commit>:<batch>:<file>` stops the writer at that
/// point of that batch for good, after writing <file>, so a test can kill the process there (as sqlite-writer.ts).
fn pause_point() -> Option<(String, u64, String)> {
	let v = std::env::var("PHI_SPACES_WRITER_PAUSE").ok()?;
	let mut it = v.splitn(3, ':');
	let (at, batch, file) = (it.next()?.to_owned(), it.next()?.parse().ok()?, it.next()?.to_owned());
	(!at.is_empty() && !file.is_empty()).then_some((at, batch, file))
}

impl Writer {
	pub fn open(path: &Path, o: WriterOptions) -> std::result::Result<Writer, String> {
		let db = Connection::open(path).map_err(|e| e.to_string())?;
		db.busy_timeout(Duration::from_secs(10)).map_err(|e| e.to_string())?;
		let _: String = db.query_row("PRAGMA journal_mode = WAL", [], |r| r.get(0)).map_err(|e| e.to_string())?;
		db.execute_batch(match o.synchronous {
			Synchronous::Full => "PRAGMA synchronous = FULL;",
			Synchronous::Normal => "PRAGMA synchronous = NORMAL;",
		})
		.map_err(|e| e.to_string())?;
		if let Some(pages) = o.max_pages {
			let _: i64 = db.query_row(&format!("PRAGMA max_page_count = {pages}"), [], |r| r.get(0)).map_err(|e| e.to_string())?;
		}
		let (tx, rx) = channel::<Msg>();
		let fault = o.fault;
		let waker = Arc::new(Mutex::new(None));
		let wakes = Arc::clone(&waker);
		let thread = std::thread::Builder::new().name("phi-store-writer".into()).spawn(move || run(db, rx, fault, wakes)).map_err(|e| e.to_string())?;
		Ok(Writer { tx, thread: Some(thread), waker })
	}
	pub fn set_waker(&self, waker: Waker) { *self.waker.lock().expect("the writer does not panic holding it") = Some(waker); }
	/// Hands a commit's rows over; the receiver settles when they are durable.
	pub fn write(&self, ops: Vec<WriteOp>) -> Durable {
		let (done, rx) = channel();
		if self.tx.send(Msg::Write(ops, done.clone())).is_err() {
			let _ = done.send(Err("the store is closed".into()));
		}
		rx
	}
	/// Gives the file's free pages back, between two batches: what was handed over before it is written first, what comes
	/// after it waits.
	pub fn compact(&self) -> Option<Receiver<Compaction>> {
		let (done, rx) = channel();
		self.tx.send(Msg::Compact(done)).ok()?;
		Some(rx)
	}
	/// Writes what was handed over, then closes the connection.
	pub fn close(mut self) {
		let (done, rx) = channel();
		if self.tx.send(Msg::Close(done)).is_ok() {
			let _ = rx.recv();
		}
		if let Some(t) = self.thread.take() {
			let _ = t.join();
		}
	}
}

fn run(db: Connection, rx: Receiver<Msg>, fault: Option<(u64, Fault)>, waker: Arc<Mutex<Option<Waker>>>) {
	let pause = pause_point();
	let hold = |at: &str, batch: u64| {
		if let Some((p, b, file)) = &pause {
			if p == at && *b == batch {
				let _ = std::fs::write(file, at);
				loop {
					std::thread::park(); // until the process is killed
				}
			}
		}
	};
	let mut batch = 0u64;
	let mut failed: Option<String> = None;
	loop {
		let Ok(first) = rx.recv() else { return };
		// the batch: this commit and whatever else is waiting, up to a compaction or the close
		let mut commits = vec![];
		let mut other = None;
		let mut m = Some(first);
		while let Some(msg) = m {
			match msg {
				Msg::Write(ops, done) => commits.push((ops, done)),
				stop => {
					other = Some(stop);
					break;
				}
			}
			m = rx.try_recv().ok();
		}
		if !commits.is_empty() {
			batch += 1;
			let fault = fault.filter(|(b, _)| *b == batch || *b == 0).map(|(_, f)| f);
			if fault == Some(Fault::WriterGone) {
				return; // the commits' answers are dropped with the thread
			}
			if let Some(Fault::Slow(d)) = fault {
				std::thread::sleep(d);
			}
			let result = match (&failed, fault) {
				(Some(e), _) => Err(e.clone()),
				(None, Some(Fault::FailBeforeCommit)) => {
					failed = Some("an injected fault before the commit".into());
					Err("an injected fault before the commit".into())
				}
				(None, _) => {
					let ops: Vec<WriteOp> = commits.iter().flat_map(|(ops, _)| ops.iter().cloned()).collect();
					let r = (|| -> rusqlite::Result<()> {
						db.execute_batch("BEGIN IMMEDIATE")?;
						apply_ops(&db, &ops)?;
						hold("before-commit", batch);
						db.execute_batch("COMMIT")?;
						hold("after-commit", batch);
						Ok(())
					})();
					let r = r.map_err(|e| {
						let _ = db.execute_batch("ROLLBACK");
						let m = e.to_string();
						failed = Some(m.clone()); // a failed write: everything after it fails too (reopen the store)
						m
					});
					match (r, fault) {
						(Ok(()), Some(Fault::LoseAnswer)) => {
							failed = Some("the answer was lost (an injected fault)".into());
							Err("the answer was lost (an injected fault)".into())
						}
						(r, _) => r,
					}
				}
			};
			for (_, done) in commits {
				let _ = done.send(result.clone());
			}
			if let Some(wake) = waker.lock().expect("set_waker does not panic holding it").as_ref() {
				wake();
			}
		}
		match other {
			Some(Msg::Compact(done)) => {
				let _ = done.send(compact(&db));
			}
			Some(Msg::Close(done)) => {
				drop(db);
				let _ = done.send(());
				return;
			}
			_ => {}
		}
	}
}

/// The pages that expired claims and removed entries left free go back to the file system. The first time the file is
/// switched to incremental auto-vacuum (a VACUUM rewrites it once); from then on only the free pages are cut off.
fn compact(db: &Connection) -> Compaction {
	let run = || -> rusqlite::Result<Compaction> {
		let freed_pages: i64 = db.query_row("PRAGMA freelist_count", [], |r| r.get(0))?;
		let mode: i64 = db.query_row("PRAGMA auto_vacuum", [], |r| r.get(0))?;
		let converted = mode != 2;
		if converted {
			db.execute_batch("PRAGMA auto_vacuum = INCREMENTAL; VACUUM;")?;
		} else {
			db.execute_batch("PRAGMA incremental_vacuum;")?;
		}
		// a reader holding the WAL: the next checkpoint
		let _ = db.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()));
		Ok(Compaction { freed_pages, converted, error: None })
	};
	run().unwrap_or_else(|e| Compaction { error: Some(e.to_string()), ..Default::default() })
}
