// R6b step 4: the ssh paths of the recovery tools (src/ssh-register.ts, src/ssh-recovery.ts) through a stand-in for ssh on
// PATH (test/support/ssh-stand-in.ts) that answers the provisioned forced commands on this machine. The operator's register
// reads and writes, a conflict arrives as one, the read-only login refuses a write, a refused login and an invalid target
// fail; each answer as TypeScript's SshRecoveryRegister gives it through the same stand-in. A recovery call over ssh reaches
// the endpoint behind the forced command and comes back with its answer.
use phi_host::auth::Signer;
use phi_host::recovery_rpc::*;
use phi_host::register::{Register, RegisterError, SshRegister};
use phi_json::{obj, parse, Json};
use std::path::PathBuf;
use std::rc::Rc;

const ROOT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../..");

fn setup() -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("recovery-ssh");
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(d.join("bin")).unwrap();
	std::fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
	let ssh = d.join("bin/ssh");
	std::fs::write(&ssh, format!("#!/bin/sh\nexec node --experimental-strip-types --no-warnings {ROOT}/test/support/ssh-stand-in.ts \"$@\"\n")).unwrap();
	std::fs::set_permissions(&ssh, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();
	for t in ["operator@register", "reader@register", "recovery@target"] {
		std::fs::write(d.join(format!("target-{t}")), "").unwrap();
	}
	std::env::set_var("PATH", format!("{}:{}", d.join("bin").display(), std::env::var("PATH").unwrap_or_default()));
	std::env::set_var("SSH_STAND_IN_DIR", &d);
	d
}

/// The same calls through TypeScript's SshRecoveryRegister: each answer, or the class and message of its refusal.
fn typescript(calls: &[Json]) -> Vec<Json> {
	let code = format!(
		"import {{ SshRecoveryRegister }} from '{ROOT}/src/ssh-register.ts';\
		 const calls = {};\
		 for (const c of calls) {{ try {{ const r = new SshRecoveryRegister(c.target, 10000, {{ operator: c.operator }}); const v = c.method === 'get' ? await r.get(c.key) : await r.compareAndSet(c.key, c.expected, c.value); console.log(JSON.stringify({{ ok: v }})); }} catch (e) {{ console.log(JSON.stringify({{ refused: e.constructor.name, message: e.message }})); }} }}",
		Json::Array(calls.to_vec()).to_json_text()
	);
	let out = std::process::Command::new("node").args(["--experimental-strip-types", "--no-warnings", "--input-type=module", "-e", &code]).current_dir(ROOT).output().unwrap();
	assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
	String::from_utf8_lossy(&out.stdout).lines().map(|l| parse(l).unwrap()).collect()
}

fn rust(rt: &tokio::runtime::Runtime, c: &Json) -> Json {
	let target = c.get("target").and_then(Json::as_str).unwrap();
	let r = match SshRegister::new(target, 10_000, c.get("operator") == Some(&Json::Bool(true))) {
		Err(e) => Err(e),
		Ok(reg) => rt.block_on(async {
			let key = c.get("key").and_then(Json::as_str).unwrap();
			if c.get("method").and_then(Json::as_str) == Some("get") { reg.get(key).await } else { reg.compare_and_set(key, c.get("expected").and_then(Json::as_f64), c.get("value").unwrap()).await }
		}),
	};
	match r {
		Ok(v) => obj! { "ok" => v },
		Err(RegisterError::Conflict(m)) => obj! { "refused" => "RegisterConflict", "message" => m },
		Err(RegisterError::Failed(m)) => obj! { "refused" => "Error", "message" => m },
	}
}

#[test]
fn the_ssh_paths_answer_as_typescript_does() {
	let d = setup();
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let op = |target: &str, operator: bool, method: &str, key: &str, expected: Option<f64>, value: Json| obj! { "target" => target, "operator" => operator, "method" => method, "key" => key, "expected" => expected.map_or(Json::Null, Json::Number), "value" => value };
	let calls = [
		op("operator@register", true, "get", "boot:a", None, Json::Null),
		op("operator@register", true, "compareAndSet", "boot:a", None, obj! { "hostId" => "a", "state" => "active" }),
		op("operator@register", true, "get", "boot:a", None, Json::Null),
		op("operator@register", true, "compareAndSet", "boot:a", None, obj! { "hostId" => "a", "state" => "fenced" }),
		op("reader@register", false, "get", "boot:a", None, Json::Null),
		op("reader@register", false, "compareAndSet", "boot:a", Some(1.0), obj! { "hostId" => "a", "state" => "fenced" }),
		op("stranger@register", true, "get", "boot:a", None, Json::Null),
		op("-oProxyCommand=x", true, "get", "boot:a", None, Json::Null),
	];
	// each side on a register of its own, the same calls in the same order
	let mut want = vec![];
	for c in &calls {
		want.extend(typescript(std::slice::from_ref(c)));
	}
	std::fs::remove_file(d.join("register.sqlite")).unwrap();
	for (c, w) in calls.iter().zip(&want) {
		let got = rust(&rt, c);
		// a refusal that is not a conflict is `Error` to Rust; TypeScript names its class
		let same = got == *w || (got.get("refused") == Some(&Json::from("Error")) && w.get("refused") != Some(&Json::from("RegisterConflict")) && w.get("message") == got.get("message"));
		assert!(same, "{}\n  Rust:       {}\n  TypeScript: {}", c.to_json_text(), got.to_json_text(), w.to_json_text());
	}

	// a recovery call over the forced command reaches the endpoint behind it
	tokio::task::LocalSet::new().block_on(&rt, async {
		let operator = Rc::new(Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[9; 32])));
		let pin = KeyPin::of(&operator, &operator.public_key());
		let server = serve_recovery(RecoveryServe {
			path: d.join("recovery.sock"),
			host_id: "target".into(),
			operator: pin,
			supervisor: None,
			host_key: None,
			handle: Rc::new(|call: Json, _| Box::pin(async move { Ok(obj! { "echo" => call.get("args").cloned().unwrap() }) }) as Fut<RR<Json>>),
			now: Rc::new(now_ms),
		})
		.await
		.unwrap();
		let client = RecoveryClient::new(RecoveryLine::Ssh("recovery@target".into()), "target", Rc::clone(&operator));
		assert_eq!(client.call("restoreStatus", obj! { "recoveryId" => "r" }, None).await, Ok(obj! { "echo" => obj! { "recoveryId" => "r" } }));
		let refused = RecoveryClient::new(RecoveryLine::Ssh("nobody@target".into()), "target", Rc::clone(&operator));
		assert_eq!(refused.call("restoreStatus", obj! {}, None).await, Err(blocked("recovery forced command failed")));
		let invalid = RecoveryClient::new(RecoveryLine::Ssh("-oProxyCommand=x".into()), "target", operator);
		assert_eq!(invalid.call("restoreStatus", obj! {}, None).await, Err(blocked("invalid recovery SSH target")));
		drop(server);
	});
}
