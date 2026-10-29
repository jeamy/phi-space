// The TypeScript core as a process (test/support/core-driver.ts): one JSON line out, one back.
use phi_json::{parse, Json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct Driver { child: Child, input: ChildStdin, output: BufReader<ChildStdout> }

impl Driver {
	pub fn start() -> Driver {
		let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
		let mut child = Command::new("node")
			.args(["--experimental-strip-types", "--no-warnings", "test/support/core-driver.ts"])
			.current_dir(root)
			.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
			.spawn().expect("node must be on PATH for the differential tests");
		let input = child.stdin.take().unwrap();
		let output = BufReader::new(child.stdout.take().unwrap());
		Driver { child, input, output }
	}
	/// Sends one operation and returns the driver's answer.
	pub fn step(&mut self, line: &Json) -> Json {
		writeln!(self.input, "{}", line.to_json_text()).unwrap();
		self.input.flush().unwrap();
		let mut text = String::new();
		self.output.read_line(&mut text).unwrap();
		parse(text.trim_end()).unwrap_or_else(|e| panic!("driver answered {text:?}: {e}"))
	}
}
impl Drop for Driver { fn drop(&mut self) { let _ = self.child.kill(); } }
