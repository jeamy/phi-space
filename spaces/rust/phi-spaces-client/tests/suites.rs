//! The TypeScript client suites with this crate's client (docs/rust-portierung.en.md, R8.1): test-remote, test-socket,
//! test-space-client and test-commit-sealed, every RemoteSpace of them the Rust one through `phi-client-driver`
//! (test/support/client-under-test.ts), against the TypeScript service. Against the Rust server as well:
//! `PHI_SPACES_SERVER_CMD=rust/target/release/phi-space-server` in the environment of `cargo test`.
use std::process::Command;

#[test]
fn the_typescript_client_suites_pass_with_the_rust_client() {
	let root = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");
	let out = Command::new("node")
		.current_dir(root)
		.env("PHI_SPACES_CLIENT_CMD", env!("CARGO_BIN_EXE_phi-client-driver"))
		.args(["--experimental-strip-types", "--no-warnings", "--test", "test/test-remote.test.ts", "test/test-socket.test.ts", "test/test-space-client.test.ts", "test/test-commit-sealed.test.ts"])
		.output()
		.expect("node on PATH");
	let text = String::from_utf8_lossy(&out.stdout);
	let failed: Vec<&str> = text.lines().filter(|l| l.starts_with("not ok")).collect();
	assert!(out.status.success() && failed.is_empty(), "{failed:#?}\n{text}");
	assert!(text.lines().any(|l| l.starts_with("# pass") && l != "# pass 0"), "nothing ran:\n{text}");
}
