// What the crash and failure tests of phi-store share: scratch directories, and the pairs a store file holds as the Rust
// and the TypeScript store read it.
#![allow(dead_code)]
use phi_core::driver::seeded;
use phi_json::{obj, parse, Json, FOREVER};
use phi_store::{SpaceHost, SqliteLedger, Synchronous};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Command;

/// The document the tests write (the default Space, as store-crash-child.ts).
pub const KIND: &str = "phi-spaces.space";

pub fn root() -> PathBuf { PathBuf::from(format!("{}/../..", env!("CARGO_MANIFEST_DIR"))) }
pub fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}

/// One commit writing the pair `i` (two entries, halves 0 and 1).
pub fn commit_pair(host: &mut SpaceHost, i: u64, pad: usize) -> Result<(), phi_store::StoreError> {
	host.commit(|s| {
		for half in [0.0, 1.0] {
			let entry = obj! { "type" => "Pair", "fields" => obj! { "i" => i as f64, "half" => half, "pad" => "x".repeat(pad) } };
			s.write(1000.0, &entry, None, Some(&Json::Number(FOREVER)), None)?;
		}
		Ok(())
	})
	.map(|r| r.expect("the write is admitted"))
}

/// The pairs on the file as the Rust store reads it: every commit's two halves or none.
pub fn survivors_rust(file: &Path) -> BTreeSet<u64> {
	let ledger = SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()); // the dead owner's lock is free
	let host = SpaceHost::open(ledger, KIND, None, seeded("read")).unwrap();
	let mut halves: BTreeMap<u64, u32> = BTreeMap::new();
	for e in host.space.state.entries.iter().filter(|e| e.type_ == "Pair") {
		*halves.entry(e.fields.get("i").and_then(Json::as_f64).unwrap() as u64).or_default() += 1;
	}
	host.close();
	for (i, n) in &halves {
		assert_eq!(*n, 2, "commit {i} is there only in part");
	}
	halves.into_keys().collect()
}
/// The same as the TypeScript store reads it.
pub fn survivors_ts(file: &Path) -> BTreeSet<u64> {
	let script = format!(
		"const {{ openSqliteHost }} = await import({:?}); const {{ Space }} = await import({:?}); const {{ BACKGROUND_CONTEXT: ctx }} = await import({:?}); const h = await openSqliteHost({:?}); const s = await h.snapshot(Space, ctx); await h.close(ctx); process.stdout.write(JSON.stringify((s?.entries ?? []).filter(e => e.type === 'Pair').map(e => e.fields.i)));",
		root().join("src/store/sqlite.ts").to_str().unwrap(),
		root().join("src/doc.ts").to_str().unwrap(),
		root().join("src/context.ts").to_str().unwrap(),
		file.to_str().unwrap()
	);
	let out = Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &script]).current_dir(root()).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	let mut halves: BTreeMap<u64, u32> = BTreeMap::new();
	for i in parse(std::str::from_utf8(&out.stdout).unwrap()).unwrap().as_array().unwrap() {
		*halves.entry(i.as_f64().unwrap() as u64).or_default() += 1;
	}
	for (i, n) in &halves {
		assert_eq!(*n, 2, "commit {i} is there only in part (TypeScript)");
	}
	halves.into_keys().collect()
}
pub fn survivors(file: &Path) -> BTreeSet<u64> {
	let r = survivors_rust(file);
	assert_eq!(survivors_ts(file), r, "the Rust and the TypeScript store read the crashed file alike");
	r
}

