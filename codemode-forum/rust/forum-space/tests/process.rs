// The binary as a process: its capacities from the environment, and the values it refuses.
use phi_space_host::testing::{dir as tmp, start, stored_limits, Running};
use std::path::PathBuf;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_forum-space");

fn dir(name: &str) -> PathBuf { tmp(env!("CARGO_TARGET_TMPDIR"), name) }
fn serve(env: &[(&str, &str)]) -> (Running, String) { start(BIN, &[], env) }

#[test]
fn it_takes_its_capacities_from_the_environment() {
	let d = dir("forum");
	let (path, file) = (d.join("c.sock"), d.join("data/c.sqlite"));
	let listen = format!("unix:{}", path.display());
	let env = [("FORUM_LISTEN", listen.as_str()), ("FORUM_SQLITE", file.to_str().unwrap()), ("FORUM_MEM", "")];
	let (server, line) = serve(&env);
	assert_eq!(line.trim(), format!("[space] ready on {listen} (db {})", file.display()));
	drop(server);
	let limits = stored_limits(&file);
	assert!(limits.contains(r#""maxClaimBytes":1073741824"#) && limits.contains(r#""maxDocBytes":1342177280"#) && limits.contains(r#""maxRegsPerOwner":1000"#), "{limits}");
	for (value, reason) in [("0", "must be a positive safe integer"), ("1.5", "must be a positive safe integer"), ("x", "must be a positive safe integer"), ("2000", "must exceed")] {
		let out = Command::new(BIN).envs(env).env("FORUM_MAX_CLAIM_MIB", value).output().unwrap();
		assert_eq!(out.status.code(), Some(1), "{value}");
		assert!(String::from_utf8_lossy(&out.stderr).contains(reason), "{value}");
	}
}
