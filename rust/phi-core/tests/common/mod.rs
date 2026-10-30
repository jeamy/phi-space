// The TypeScript core as a process (test/support/core-driver.ts): one JSON line out, one back.
#![allow(dead_code)] // each test file uses its own part
pub mod walk;
use phi_json::{parse, Json};
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct TsDriver { child: Child, input: ChildStdin, output: BufReader<ChildStdout> }

impl TsDriver {
	pub fn start() -> TsDriver { TsDriver::script("test/support/core-driver.ts") }
	/// Another driver of the same protocol (test/support/store-driver.ts).
	pub fn script(script: &str) -> TsDriver {
		let root = format!("{}/../..", env!("CARGO_MANIFEST_DIR"));
		let mut child = Command::new("node")
			.args(["--experimental-strip-types", "--no-warnings", script])
			.current_dir(root)
			.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit())
			.spawn().expect("node must be on PATH for the differential tests");
		let input = child.stdin.take().unwrap();
		let output = BufReader::new(child.stdout.take().unwrap());
		TsDriver { child, input, output }
	}
	/// Sends one operation and returns the driver's answer.
	pub fn step(&mut self, line: &Json) -> Json {
		writeln!(self.input, "{}", line.to_json_text()).unwrap();
		self.input.flush().unwrap();
		answer(&mut self.output)
	}
	/// Sends all lines at once (written from a thread of their own, so neither pipe fills up) and returns the answers.
	pub fn run(&mut self, lines: &[Json]) -> Vec<Json> {
		let text: String = lines.iter().map(|l| l.to_json_text() + "\n").collect();
		let TsDriver { input, output, .. } = self;
		std::thread::scope(|scope| {
			scope.spawn(move || {
				input.write_all(text.as_bytes()).unwrap();
				input.flush().unwrap();
			});
			(0..lines.len()).map(|_| answer(output)).collect()
		})
	}
}
fn answer(output: &mut BufReader<ChildStdout>) -> Json {
	let mut text = String::new();
	output.read_line(&mut text).unwrap();
	parse(text.trim_end()).unwrap_or_else(|e| panic!("driver answered {text:?}: {e}"))
}
impl Drop for TsDriver { fn drop(&mut self) { let _ = self.child.kill(); } }
