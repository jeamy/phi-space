//! What the comparisons with the frozen TypeScript engine share: the oracle (the commit the port follows, unpacked into
//! the target folder once with `git archive`, its node_modules linked to the checkout's, `phi-spaces` pointing at the
//! archive's own root, so the oracle is the frozen library too) and the engine's environment, the same for this process
//! and the node processes it starts. `MMO_ORACLE` names another tree.
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

/// The commit the port follows (docs/rust-portierung.en.md, R8.2).
pub const FROZEN: &str = "947c0a9";

pub fn repo() -> PathBuf { Path::new(env!("CARGO_MANIFEST_DIR")).join("../..").canonicalize().expect("the checkout") }

/// The engine's environment: messages kept as entries, no model calls, the clock's default rate, the tick floors off, the settings read anew each time (their cache runs on the real clock),
/// the wind on. Set in this process (the Rust engine reads it) before any node process starts (they inherit it).
pub fn pin_env() {
	static ONCE: Once = Once::new();
	ONCE.call_once(|| {
		for (k, v) in std::env::vars() { if k.starts_with("SPACES_MMO_") { std::env::remove_var(&k); let _ = v; } }
		for (k, v) in [("SPACES_MMO_MSG_TRANSIENT", "0"), ("SPACES_MMO_LLM", ""), ("SPACES_MMO_TICK_FLOORS", "0"), ("SPACES_MMO_WORLD", "leuchtfeuer"), ("SPACES_MMO_SETTINGS_MS", "1")] { std::env::set_var(k, v); }
	});
}

fn link(from: &Path, to: &Path) { if !to.exists() && to.symlink_metadata().is_err() { std::os::unix::fs::symlink(from, to).unwrap_or_else(|e| panic!("link {}: {e}", to.display())); } }

/// The oracle's root.
pub fn oracle() -> PathBuf {
	pin_env();
	if let Ok(o) = std::env::var("MMO_ORACLE") { return PathBuf::from(o); }
	static ONCE: Once = Once::new();
	let root = Path::new(env!("CARGO_TARGET_TMPDIR")).join(format!("mmo-oracle-{FROZEN}"));
	ONCE.call_once(|| {
		let done = root.join(".unpacked");
		if !done.exists() {
			let _ = std::fs::remove_dir_all(&root);
			std::fs::create_dir_all(&root).unwrap();
			let st = Command::new("sh").arg("-c").arg(format!("git -C '{}' archive {FROZEN} | tar -x -C '{}'", repo().display(), root.display())).status().expect("git and tar");
			assert!(st.success(), "git archive {FROZEN} failed");
			let repo = repo();
			link(&repo.join("node_modules"), &root.join("node_modules"));
			link(&repo.join("agent/node_modules"), &root.join("agent/node_modules"));
			let nm = root.join("spaces-mmo/node_modules");
			std::fs::create_dir_all(&nm).unwrap();
			for e in std::fs::read_dir(repo.join("spaces-mmo/node_modules")).unwrap() {
				let e = e.unwrap();
				if e.file_name() == "phi-spaces" { continue; }
				link(&e.path(), &nm.join(e.file_name()));
			}
			link(Path::new("../.."), &nm.join("phi-spaces"));
			std::fs::write(&done, FROZEN).unwrap();
		}
	});
	root
}
