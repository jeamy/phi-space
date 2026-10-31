// The binary as a process: no way to the test hooks without `--test-hooks`, and a server that cannot start says so.
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
