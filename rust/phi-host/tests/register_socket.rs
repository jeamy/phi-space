// The register over a private Unix endpoint (src/register-service.ts): TypeScript's `serveRegister` serves a register file
// on a read-only and on a writable socket, and the same calls go through `SocketRecoveryRegister` and through
// phi_host::register::SocketRegister: reads, writes, a conflict, a write on the read-only endpoint and one through a
// client that is not writable, an invalid key, an endpoint that is gone. Every answer agrees, each refusal by its kind and
// message.
use phi_host::register::{Register, RegisterError, SocketRegister};
use phi_json::{obj, parse, Json};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Command, Stdio};

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn answer(r: Result<Json, RegisterError>) -> Json {
	match r {
		Ok(v) => obj! { "ok" => v },
		Err(RegisterError::Conflict(m)) => obj! { "conflict" => m },
		Err(RegisterError::Failed(m)) => obj! { "failed" => m },
	}
}

#[test]
fn the_socket_register_answers_as_typescript_does() {
	let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("register-socket");
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(dir.join("sockets")).unwrap();
	std::fs::set_permissions(dir.join("sockets"), std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
	let (read, write) = (dir.join("sockets/read.sock"), dir.join("sockets/write.sock"));
	// TypeScript: the server, and its client's answers to the same calls, one JSON line each; then it keeps serving
	let code = format!(
		"import {{ SqliteRecoveryRegister, RegisterConflict }} from '{ROOT}/src/index.ts'; import {{ serveRegister, SocketRecoveryRegister }} from '{ROOT}/src/register-service.ts';\
		 const r = new SqliteRecoveryRegister({}); const a = await serveRegister(r, {}), b = await serveRegister(r, {}, {{ writable: true }});\
		 const ro = new SocketRecoveryRegister({}), rw = new SocketRecoveryRegister({}, {{ writable: true }}), gone = new SocketRecoveryRegister({}, {{ timeoutMs: 500 }});\
		 const say = async (p) => {{ try {{ console.log(JSON.stringify({{ ok: (await p) ?? null }})); }} catch (e) {{ console.log(JSON.stringify(e instanceof RegisterConflict ? {{ conflict: e.message }} : {{ failed: e.message }})); }} }};\
		 for (const step of JSON.parse(process.argv[1])) await say(step.via === 'ro' ? (step.op === 'get' ? ro.get(step.key) : ro.compareAndSet(step.key, step.expected, step.value)) : step.via === 'gone' ? gone.get(step.key) : (step.op === 'get' ? rw.get(step.key) : rw.compareAndSet(step.key, step.expected, step.value)));\
		 console.log('ready');",
		Json::from(dir.join("register.sqlite").to_str().unwrap()).to_json_text(),
		Json::from(read.to_str().unwrap()).to_json_text(),
		Json::from(write.to_str().unwrap()).to_json_text(),
		Json::from(read.to_str().unwrap()).to_json_text(),
		Json::from(write.to_str().unwrap()).to_json_text(),
		Json::from(dir.join("sockets/none.sock").to_str().unwrap()).to_json_text(),
	);
	let step = |via: &str, op: &str, key: &str, expected: Json, value: Json| obj! { "via" => via, "op" => op, "key" => key, "expected" => expected, "value" => value };
	let steps = vec![
		step("ro", "get", "boot:h", Json::Null, Json::Null),
		step("rw", "cas", "boot:h", Json::Null, obj! { "state" => "active" }),
		step("ro", "get", "boot:h", Json::Null, Json::Null),
		step("rw", "cas", "boot:h", Json::Null, obj! { "state" => "fenced" }),
		step("rw", "cas", "boot:h", Json::Number(1.0), obj! { "state" => "fenced" }),
		step("ro", "cas", "boot:h", Json::Number(2.0), obj! { "state" => "active" }),
		step("rw", "get", "", Json::Null, Json::Null),
		step("gone", "get", "boot:h", Json::Null, Json::Null),
		step("rw", "get", "boot:h", Json::Null, Json::Null),
	];
	let mut node = Killed(Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &code, &Json::Array(steps.clone()).to_json_text()]).current_dir(ROOT).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap());
	let mut lines = BufReader::new(node.0.stdout.take().unwrap()).lines();
	let mut want = vec![];
	for line in lines.by_ref() {
		let line = line.unwrap();
		if line == "ready" {
			break;
		}
		want.push(parse(&line).unwrap());
	}
	assert_eq!(want.len(), steps.len());
	// the TypeScript steps changed the file: Rust runs the same calls on a fresh key
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let client = |path: &PathBuf, writable: bool, timeout_ms: u64| SocketRegister { path: path.to_str().unwrap().to_owned(), writable, timeout_ms };
	let (ro, rw, gone) = (client(&read, false, 4000), client(&write, true, 4000), client(&dir.join("sockets/none.sock"), false, 500));
	let renamed = |k: &str| if k.is_empty() { String::new() } else { k.replace("boot:h", "boot:r") };
	for (i, (s, w)) in steps.iter().zip(&want).enumerate() {
		let key = renamed(s.get("key").and_then(Json::as_str).unwrap());
		let r = rt.block_on(async {
			let c = match s.get("via").and_then(Json::as_str).unwrap() { "ro" => &ro, "rw" => &rw, _ => &gone };
			if s.get("op").and_then(Json::as_str) == Some("get") { c.get(&key).await } else { c.compare_and_set(&key, s.get("expected").and_then(Json::as_f64), s.get("value").unwrap()).await }
		});
		let got = answer(r);
		// a record names its key: the renamed one on the Rust side
		let want = parse(&w.to_json_text().replace("boot:h", "boot:r")).unwrap();
		// an endpoint that is gone: each runtime says it in the words of its own system call
		if s.get("via").and_then(Json::as_str) == Some("gone") {
			assert!(got.get("failed").is_some() && want.get("failed").is_some(), "step {i}: {} against {}", got.to_json_text(), want.to_json_text());
			continue;
		}
		assert_eq!(got.canonical().unwrap(), want.canonical().unwrap(), "step {i}: {}", s.to_json_text());
	}
}

/// The TypeScript side ends with the test, also when an assertion fails.
struct Killed(std::process::Child);
impl Drop for Killed {
	fn drop(&mut self) { let _ = self.0.kill(); }
}
