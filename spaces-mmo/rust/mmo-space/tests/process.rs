// The binary as a process: both spaces with their locks and the Process entry, one space or a region, a bad list refused.
use phi_space_host::testing::{call, dir as tmp, items, start, stored_limits, Running};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::Command;

const BIN: &str = env!("CARGO_BIN_EXE_mmo-space");

fn dir(name: &str) -> PathBuf { tmp(env!("CARGO_TARGET_TMPDIR"), name) }
fn serve(env: &[(&str, &str)]) -> (Running, String) { start(BIN, &[], env) }

#[test]
fn it_serves_both_spaces_with_their_locks_once() {
	let d = dir("mmo");
	let (world, accounts) = (d.join("w.sock"), d.join("a.sock"));
	let (w, a) = (format!("unix:{}", world.display()), format!("unix:{}", accounts.display()));
	let data = d.join("data");
	let env = [("SPACES_MMO_LISTEN", w.as_str()), ("SPACES_MMO_ACCOUNTS_LISTEN", a.as_str()), ("SPACES_MMO_DATA", data.to_str().unwrap()), ("SPACES_MMO_COMPACT_MS", "0"), ("SPACES_MMO_MEM", ""), ("SPACES_MMO_SPACES", "")];
	let (server, line) = serve(&env);
	assert_eq!(line.trim(), format!("[space] ready: world on {w}, accounts on {a} ({})", data.display()));
	let locks = items(&world, "Lock");
	assert!(locks.contains(r#""name":"world""#) && locks.contains(r#""name":"npc""#) && !locks.contains(r#""name":"names""#), "{locks}");
	assert!(items(&accounts, "Lock").contains(r#""name":"names""#));
	let process = items(&world, "Process");
	for field in ["\"role\":\"space\"", "\"procId\"", "\"pid\"", "\"cores\"", "\"memGiB\"", "\"platform\":\"Linux", "\"startedAt\"", "\"cpu\""] {
		assert!(process.contains(field), "{field}: {process}");
	}
	assert!(items(&accounts, "Process").contains(r#""items":[]"#), "the world's store carries the entry");
	let mut s = UnixStream::connect(&world).unwrap();
	let hello = call(&mut s, r#"{"method":"hello","args":{"protocol":1}}"#);
	assert!(hello.contains(r#""principal":"peer-mmo-world""#), "{hello}");
	drop((s, server));
	let limits = stored_limits(&data.join("world.sqlite"));
	assert!(limits.contains(r#""maxTxnsPerOwner":1000"#) && limits.contains(r#""maxLogBytes":524288"#) && limits.contains(r#""maxClaimBytes":536870912"#) && limits.contains(r#""claimResultMs":600000"#), "{limits}");

	let (_server, _) = serve(&env);
	assert_eq!(items(&world, "Lock").matches(r#""name":"world""#).count(), 1, "written once, when the store is new");
}

#[test]
fn it_serves_one_space_or_a_region() {
	let d = dir("region");
	let (world, accounts) = (d.join("w.sock"), d.join("a.sock"));
	let (w, a) = (format!("unix:{}", world.display()), format!("unix:{}", accounts.display()));
	let data = d.join("data");
	let (_a, line) = serve(&[("SPACES_MMO_SPACES", "accounts"), ("SPACES_MMO_ACCOUNTS_LISTEN", a.as_str()), ("SPACES_MMO_MEM", "1")]);
	assert_eq!(line.trim(), format!("[space] ready: world on -, accounts on {a} (memory)"));
	assert!(items(&accounts, "Process").contains(r#""role":"space""#), "only the accounts here: the entry goes there");
	let (_w, _) = serve(&[("SPACES_MMO_SPACES", "world"), ("SPACES_MMO_LISTEN", w.as_str()), ("SPACES_MMO_REGION", "west"), ("SPACES_MMO_DATA", data.to_str().unwrap()), ("SPACES_MMO_MEM", "")]);
	assert!(data.join("world-west.sqlite").exists());
	let out = Command::new(BIN).env("SPACES_MMO_SPACES", "moon").output().unwrap();
	assert_eq!(out.status.code(), Some(1));
	assert!(String::from_utf8_lossy(&out.stderr).contains("SPACES_MMO_SPACES is world, accounts or both"));
}
