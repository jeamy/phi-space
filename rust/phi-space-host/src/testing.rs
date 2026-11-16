//! The process tests' helpers of the binaries built on this crate (feature `testing`, from their dev-dependencies):
//! start a binary and read its ready line, call it over its unix socket, read a store file a server has left.
use phi_store::{system_random, SpaceHost, SqliteLedger, Store, Synchronous};
use std::io::{BufRead, BufReader, Read, Write};
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdout, Command, Stdio};

/// A started server, killed when it is dropped. Its stdout stays open, so what it prints after the ready line does not
/// end it.
pub struct Running(pub Child, BufReader<ChildStdout>);
impl Running {
	/// The next line it prints (empty when it has ended).
	pub fn line(&mut self) -> String {
		let mut line = String::new();
		self.1.read_line(&mut line).unwrap();
		line
	}
}
impl Drop for Running {
	fn drop(&mut self) {
		let _ = self.0.kill();
		let _ = self.0.wait();
	}
}

/// An empty directory `process-<name>` under `base` (a test's `CARGO_TARGET_TMPDIR`).
pub fn dir(base: &str, name: &str) -> PathBuf {
	let d = PathBuf::from(base).join(format!("process-{name}"));
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	d
}

/// `bin` with `args` and `env`, and the first line it prints (its ready line).
pub fn start(bin: &str, args: &[&str], env: &[(&str, &str)]) -> (Running, String) {
	let mut c = Command::new(bin).args(args).envs(env.iter().copied()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
	let out = BufReader::new(c.stdout.take().unwrap());
	let mut running = Running(c, out);
	let line = running.line();
	(running, line)
}

/// One call in a frame of the wire protocol, and its answer.
pub fn call(s: &mut UnixStream, text: &str) -> String {
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

/// The limits in a store file, from a server that has ended.
pub fn stored_limits(file: &Path) -> String {
	let mut store = Store::open(SpaceHost::sqlite(SqliteLedger::open(file, Synchronous::Full).unwrap()), system_random).unwrap();
	let limits = store.reader(None).unwrap().space.state.to_json_without_claims().get("limits").unwrap().to_json_text();
	store.close();
	limits
}

/// `readAll` of one type in the default space.
pub fn items(path: &Path, ty: &str) -> String {
	let mut s = UnixStream::connect(path).unwrap();
	call(&mut s, &format!(r#"{{"method":"readAll","args":{{"template":{{"type":"{ty}"}}}}}}"#))
}

/// `readAll` of one type in the space of an alias.
pub fn items_in(path: &Path, space: &str, ty: &str) -> String {
	let mut s = UnixStream::connect(path).unwrap();
	call(&mut s, &format!(r#"{{"method":"readAll","space":"{space}","args":{{"template":{{"type":"{ty}"}}}}}}"#))
}
