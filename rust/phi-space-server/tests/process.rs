// The binary as a process: no way to the test hooks without `--test-hooks`, and a server that cannot start says so.
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, Synchronous};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};

const BIN: &str = env!("CARGO_BIN_EXE_phi-space-server");

struct Running(Child);
impl Drop for Running {
	fn drop(&mut self) { let _ = self.0.kill(); let _ = self.0.wait(); }
}
fn dir(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(format!("process-{name}"));
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}
fn start(args: &[&str]) -> (Running, String) {
	let mut c = Command::new(BIN).args(args).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
	let mut line = String::new();
	BufReader::new(c.stdout.take().unwrap()).read_line(&mut line).unwrap();
	(Running(c), line)
}
fn call(s: &mut UnixStream, text: &str) -> String {
	let mut f = (text.len() as u32).to_be_bytes().to_vec();
	f.extend_from_slice(&1u32.to_be_bytes());
	f.extend_from_slice(text.as_bytes());
	s.write_all(&f).unwrap();
	let mut head = [0; 8];
	s.read_exact(&mut head).unwrap();
	let mut body = vec![0; u32::from_be_bytes(head[..4].try_into().unwrap()) as usize];
	s.read_exact(&mut body).unwrap();
	String::from_utf8(body).unwrap()
}

#[test]
fn without_the_flag_there_are_no_hooks() {
	let d = dir("plain");
	let path = d.join("s.sock");
	let listen = format!("unix:{}", path.display());
	let (_server, line) = start(&["--store", "memory", "--listen", &listen]);
	assert_eq!(line.trim(), format!("[phi-spaces] ready on {listen} (store memory)"));
	assert_eq!(std::fs::read_dir(&d).unwrap().count(), 1, "the service's socket and nothing else");
	let mut s = UnixStream::connect(&path).unwrap();
	for hook in [r#"{"hook":"clock","now":1}"#, r#"{"hook":"state"}"#, r#"{"hook":"setLimits","limits":{"maxEntries":0}}"#, r#"{"method":"clock","now":1}"#] {
		assert!(call(&mut s, hook).contains(r#""ok":false"#), "{hook}");
	}
	let hello = call(&mut s, r#"{"method":"hello","args":{"protocol":1}}"#);
	assert!(hello.contains(r#""ok":true"#), "{hello}");
}

#[test]
fn a_store_it_cannot_open_or_a_bad_config_ends_the_process_with_the_reason() {
	let d = dir("bad");
	let listen = format!("unix:{}", d.join("s.sock").display());
	std::fs::write(d.join("broken.sqlite"), "not a store").unwrap();
	let store = d.join("broken.sqlite");
	let out = Command::new(BIN).args(["--store", store.to_str().unwrap(), "--listen", &listen]).output().unwrap();
	assert_eq!(out.status.code(), Some(1));
	assert!(!out.stderr.is_empty());
	let out = Command::new(BIN).args(["--store", "memory", "--listen", &listen, "--test-hooks", "/nonexistent.json"]).output().unwrap();
	assert_eq!(out.status.code(), Some(1));
	assert!(String::from_utf8_lossy(&out.stderr).contains("nonexistent"));
	assert_eq!(Command::new(BIN).output().unwrap().status.code(), Some(2));
}

fn profile(name: &str, env: &[(&str, &str)]) -> (Running, String) {
	let mut c = Command::new(BIN).args(["--profile", name]).envs(env.iter().copied()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
	let mut line = String::new();
	BufReader::new(c.stdout.take().unwrap()).read_line(&mut line).unwrap();
	(Running(c), line)
}
/// The limits in a store file, from a server that has ended.
fn stored_limits(file: &std::path::Path) -> String {
	let mut store = Store::open(SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()), system_random).unwrap();
	let limits = store.reader(None).unwrap().space.state.to_json_without_claims().get("limits").unwrap().to_json_text();
	store.close();
	limits
}
fn items(path: &std::path::Path, ty: &str) -> String {
	let mut s = UnixStream::connect(path).unwrap();
	call(&mut s, &format!(r#"{{"method":"readAll","args":{{"template":{{"type":"{ty}"}}}}}}"#))
}

#[test]
fn the_mmo_profile_serves_both_spaces_with_their_locks_once() {
	let d = dir("mmo");
	let (world, accounts) = (d.join("w.sock"), d.join("a.sock"));
	let (w, a) = (format!("unix:{}", world.display()), format!("unix:{}", accounts.display()));
	let data = d.join("data");
	let env = [("SPACES_MMO_LISTEN", w.as_str()), ("SPACES_MMO_ACCOUNTS_LISTEN", a.as_str()), ("SPACES_MMO_DATA", data.to_str().unwrap()), ("SPACES_MMO_COMPACT_MS", "0"), ("SPACES_MMO_MEM", ""), ("SPACES_MMO_SPACES", "")];
	let (server, line) = profile("mmo", &env);
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

	let (_server, _) = profile("mmo", &env);
	assert_eq!(items(&world, "Lock").matches(r#""name":"world""#).count(), 1, "written once, when the store is new");
}

#[test]
fn the_mmo_profile_serves_one_space_or_a_region() {
	let d = dir("region");
	let (world, accounts) = (d.join("w.sock"), d.join("a.sock"));
	let (w, a) = (format!("unix:{}", world.display()), format!("unix:{}", accounts.display()));
	let data = d.join("data");
	let (_a, line) = profile("mmo", &[("SPACES_MMO_SPACES", "accounts"), ("SPACES_MMO_ACCOUNTS_LISTEN", a.as_str()), ("SPACES_MMO_MEM", "1")]);
	assert_eq!(line.trim(), format!("[space] ready: world on -, accounts on {a} (memory)"));
	assert!(items(&accounts, "Process").contains(r#""role":"space""#), "only the accounts here: the entry goes there");
	let (_w, _) = profile("mmo", &[("SPACES_MMO_SPACES", "world"), ("SPACES_MMO_LISTEN", w.as_str()), ("SPACES_MMO_REGION", "west"), ("SPACES_MMO_DATA", data.to_str().unwrap()), ("SPACES_MMO_MEM", "")]);
	assert!(data.join("world-west.sqlite").exists());
	let out = Command::new(BIN).args(["--profile", "mmo"]).env("SPACES_MMO_SPACES", "moon").output().unwrap();
	assert_eq!(out.status.code(), Some(1));
	assert!(String::from_utf8_lossy(&out.stderr).contains("SPACES_MMO_SPACES is world, accounts or both"));
}

#[test]
fn the_codemode_profile_takes_its_capacities_from_the_environment() {
	let d = dir("codemode");
	let (path, file) = (d.join("c.sock"), d.join("data/c.sqlite"));
	let listen = format!("unix:{}", path.display());
	let env = [("CODEMODE_LISTEN", listen.as_str()), ("CODEMODE_SQLITE", file.to_str().unwrap()), ("CODEMODE_MEM", "")];
	let (server, line) = profile("codemode", &env);
	assert_eq!(line.trim(), format!("[space] ready on {listen} (db {})", file.display()));
	drop(server);
	let limits = stored_limits(&file);
	assert!(limits.contains(r#""maxClaimBytes":1073741824"#) && limits.contains(r#""maxDocBytes":1342177280"#) && limits.contains(r#""maxRegsPerOwner":1000"#), "{limits}");
	for (value, reason) in [("0", "must be a positive safe integer"), ("1.5", "must be a positive safe integer"), ("x", "must be a positive safe integer"), ("2000", "must exceed")] {
		let out = Command::new(BIN).args(["--profile", "codemode"]).envs(env).env("CODEMODE_MAX_CLAIM_MIB", value).output().unwrap();
		assert_eq!(out.status.code(), Some(1), "{value}");
		assert!(String::from_utf8_lossy(&out.stderr).contains(reason), "{value}");
	}
	let out = Command::new(BIN).args(["--profile", "nothing"]).output().unwrap();
	assert_eq!(out.status.code(), Some(1));
}
