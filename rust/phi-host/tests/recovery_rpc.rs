// R6b step 4: the private recovery endpoint (src/recovery-service.ts) on a real socket. A call is admitted only signed by
// the pinned operator, by the supervisor for its methods, or by a host for `controlAck`; only for this host and within
// its minute; a replayed envelope gets the first reply without running the handler again; a register conflict arrives
// as `RequestConflict`, anything else as `PermissionDenied`. The client is the Rust one, the envelope the vector's form.
use phi_host::auth::{to_base64, Signer};
use phi_host::recovery_rpc::*;
use phi_json::{obj, parse, text, Json};
use std::cell::Cell;
use std::path::PathBuf;
use std::rc::Rc;
use tokio::io::AsyncWriteExt;

fn key(seed: u8) -> (Rc<Signer>, KeyPin) {
	let s = Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[seed; 32]));
	let pin = KeyPin::of(&s, &s.public_key());
	(Rc::new(s), pin)
}
fn socket(name: &str) -> PathBuf {
	let d = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join(name);
	let _ = std::fs::remove_dir_all(&d);
	std::fs::create_dir_all(&d).unwrap();
	std::fs::set_permissions(&d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
	d.join("recovery.sock")
}
async fn raw(path: &PathBuf, text_: &str) -> Json {
	let mut s = tokio::net::UnixStream::connect(path).await.unwrap();
	let mut out = vec![];
	phi_wire::put(&mut out, 7, text_);
	s.write_all(&out).await.unwrap();
	parse(&String::from_utf8_lossy(&phi_wire::read_frame(&mut s).await.unwrap())).unwrap()
}
fn envelope(signer: &Signer, call: &Json) -> String { obj! { "call" => call.clone(), "algorithm" => "ed25519", "signature" => to_base64(&signer.sign(&recovery_bytes(call))) }.to_json_text() }

#[test]
fn the_endpoint_admits_only_pinned_fresh_calls_and_answers_a_replay_once() {
	let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	tokio::task::LocalSet::new().block_on(&rt, async {
		let path = socket("recovery-rpc");
		let ((operator, operator_pin), (supervisor, supervisor_pin), (host, host_pin), (stranger, _)) = (key(1), key(2), key(3), key(4));
		let runs = Rc::new(Cell::new(0));
		let r = Rc::clone(&runs);
		let server = serve_recovery(RecoveryServe {
			path: path.clone(),
			host_id: "target".into(),
			operator: operator_pin,
			supervisor: Some(Rc::new(move || {
				let p = supervisor_pin.clone();
				Box::pin(async move { Ok(p) }) as Fut<RR<KeyPin>>
			})),
			host_key: Some(Rc::new(move |_args| {
				let p = host_pin.clone();
				Box::pin(async move { Ok(Some(p)) }) as Fut<RR<Option<KeyPin>>>
			})),
			handle: Rc::new(move |call: Json, role: Role| {
				r.set(r.get() + 1);
				Box::pin(async move {
					match text(&call, "method") {
						Some("conflict") => Err(conflict("register version changed")),
						Some("blocked") => Err(blocked("not now")),
						_ => Ok(obj! { "role" => format!("{role:?}"), "method" => call.get("method").cloned().unwrap() }),
					}
				}) as Fut<RR<Json>>
			}),
			now: Rc::new(now_ms),
		})
		.await
		.unwrap();
		let client = |s: &Rc<Signer>| RecoveryClient::new(RecoveryLine::Socket(path.clone()), "target", Rc::clone(s));
		assert_eq!(client(&operator).call("restoreStatus", obj! {}, None).await, Ok(obj! { "role" => "Operator", "method" => "restoreStatus" }));
		assert_eq!(client(&supervisor).call("advanceRestore", obj! {}, None).await, Ok(obj! { "role" => "Supervisor", "method" => "advanceRestore" }));
		let refused = Err(blocked("recovery signature or method is not authorized"));
		assert_eq!(client(&supervisor).call("restoreControlSpace", obj! {}, None).await, refused, "a supervisor only for its methods");
		assert_eq!(client(&host).call("controlAck", obj! {}, None).await, Ok(obj! { "role" => "Host", "method" => "controlAck" }));
		assert_eq!(client(&host).call("advanceRestore", obj! {}, None).await, refused, "a host only for controlAck");
		assert_eq!(client(&stranger).call("restoreStatus", obj! {}, None).await, refused);
		assert_eq!(client(&operator).call("conflict", obj! {}, None).await, Err(conflict("register version changed")));
		assert_eq!(client(&operator).call("blocked", obj! {}, None).await, Err(blocked("not now")));
		let mut other = client(&operator);
		other.host_id = "elsewhere".into();
		let window = Err(blocked("invalid recovery target, request identity or validity window"));
		assert_eq!(other.call("restoreStatus", obj! {}, None).await, window, "another host's call");
		let mut stale = client(&operator);
		stale.now = Rc::new(|| now_ms() - 59_000.0);
		assert_eq!(stale.call("restoreStatus", obj! {}, None).await, window, "a call about to expire");
		// the same envelope twice: the handler runs once, both get its reply
		let before = runs.get();
		let t = now_ms();
		let call = obj! { "hostId" => "target", "requestId" => "r-1", "method" => "restoreStatus", "args" => obj! {}, "issuedAt" => t, "expiresAt" => t + 60_000.0 };
		let first = raw(&path, &envelope(&operator, &call)).await;
		assert_eq!(raw(&path, &envelope(&operator, &call)).await, first);
		assert_eq!(runs.get(), before + 1, "a replay does not run the handler again");
		let long = obj! { "hostId" => "target", "requestId" => "r-2", "method" => "restoreStatus", "args" => obj! {}, "issuedAt" => t, "expiresAt" => t + 60_001.0 };
		assert_eq!(text(raw(&path, &envelope(&operator, &long)).await.get("error").unwrap(), "code"), Some("PermissionDenied"), "a window over a minute");
		drop(server);
		assert!(!path.exists(), "the socket goes with the server");
	});
}
