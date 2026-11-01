// R6a: the Root's wire adapter against TypeScript (test/support/rpc-driver.ts). Scripted Members answer rightly, wrongly and not at all;
// every frame sent, with its grant, its signed delegation and its signature, and every receipt must be the same. `PHI_RPC_CASES` sets how many.
#[path = "../../phi-core/tests/common/mod.rs"]
mod common;
use common::TsDriver;
use phi_core::space::CoreError;
use phi_host::auth::Signer;
use phi_host::federation_rpc::{FederationRpc, MemberLine, RootIo};
use phi_host::router::Reprepared;
use phi_json::{obj, text, Json};
use phi_wire::Local;
use std::cell::RefCell;
use std::collections::VecDeque;
use std::rc::Rc;

struct Script {
	replies: RefCell<VecDeque<Json>>,
	sent: RefCell<Vec<Json>>,
	state: RefCell<Json>,
}
#[derive(Clone)]
struct Line(Rc<Script>);
impl MemberLine for Line {
	fn prove(&self) -> Local<Result<(), String>> { Box::pin(async { Ok(()) }) }
	fn reply(&self, call: Json) -> Local<Result<Json, String>> {
		self.0.sent.borrow_mut().push(call);
		let next = self.0.replies.borrow_mut().pop_front();
		Box::pin(async move { next.ok_or_else(|| "the line broke".to_owned()) })
	}
}
struct Io(Rc<Script>);
impl RootIo for Io {
	type Line = Line;
	fn state(&self) -> Result<Json, CoreError> { Ok(self.0.state.borrow().clone()) }
	fn line(&self, _: &str) -> Result<Line, CoreError> { Ok(Line(Rc::clone(&self.0))) }
	fn lease(&self) -> Local<Result<Json, CoreError>> { Box::pin(async { Ok(obj! { "lease" => obj! { "routerPeerId" => "root", "expiresAt" => 100_000.0 } }) }) }
	fn grant(&self, _: &Json) -> Local<Result<Json, CoreError>> { Box::pin(async { Ok(obj! { "grant" => obj! { "expiresAt" => 90_000.0 } }) }) }
	fn now(&self) -> f64 { 50_000.0 }
	fn request_id(&self) -> String { "fresh".into() }
}

struct Rng(u64);
impl Rng {
	fn next(&mut self) -> u64 {
		self.0 ^= self.0 << 13;
		self.0 ^= self.0 >> 7;
		self.0 ^= self.0 << 17;
		self.0
	}
	fn below(&mut self, n: u64) -> u64 { self.next() % n }
	fn pick<T: Clone>(&mut self, v: &[T]) -> T { v[self.below(v.len() as u64) as usize].clone() }
}

fn target() -> Json { obj! { "hostId" => "h1", "spaceId" => "s1", "authorityId" => "a", "dataIncarnation" => "i", "primaryEpoch" => 3.0 } }
fn state() -> Json {
	let mut m = phi_json::Object::new();
	m.insert("m1", obj! { "id" => "m1", "state" => "active", "target" => target() });
	obj! { "policy" => obj! { "policyVersion" => 4.0 }, "members" => m }
}
fn principal() -> Json { obj! { "peerId" => "p", "agentId" => "x" } }
fn step(r: &mut Rng) -> Json {
	let method = r.pick(&["write", "take", "read", "txn"]);
	let args = match method {
		"write" => obj! { "entry" => obj! { "type" => "T", "fields" => obj! { "n" => 1.0 } }, "leaseMs" => "forever" },
		"txn" => obj! { "action" => "commit", "id" => "t1" },
		_ => obj! { "template" => obj! { "type" => "T" }, "timeoutMs" => 0.0 },
	};
	let mut s = obj! { "target" => if r.below(12) == 0 { obj! { "hostId" => "h9", "spaceId" => "s1" } } else { target() }, "principal" => principal(), "generation" => "g1", "method" => method, "args" => args, "policyVersion" => r.pick(&[4.0, 4.0, 3.0]), "requestId" => "router-1", "argHash" => "hash", "state" => "prepared" };
	if r.below(8) == 0 {
		s.as_object_mut().unwrap().insert("evidence", r.pick(&["ReplicaConfigPending", "StalePolicyVersion"]).into());
	}
	s
}
fn claim(r: &mut Rng, s: &Json) -> Json {
	let reference = phi_host::federation_rpc::reference(s).unwrap();
	let mut v = obj! { "state" => r.pick(&["done", "pending", "cancelled", "notAdmitted", "strange"]), "method" => reference.get("method").cloned().unwrap(), "argumentHash" => reference.get("argumentHash").cloned().unwrap(), "spaceId" => "s1", "authorityId" => "a", "incarnation" => "i", "primaryEpoch" => 3.0, "generation" => "g1", "requestId" => "router-1", "result" => 7.0 };
	let o = v.as_object_mut().unwrap();
	match r.below(10) {
		0 => { o.insert("resultExpired", Json::Bool(true)); }
		1 => { o.insert("error", obj! { "code" => "Boom" }); }
		2 => { o.insert("method", "other".into()); }
		3 => { o.insert("primaryEpoch", Json::Number(9.0)); }
		4 => { o.insert("argumentHash", "other".into()); }
		_ => {}
	}
	v
}
fn reply(r: &mut Rng, s: &Json) -> Json {
	match r.below(9) {
		0 => obj! { "ok" => false, "error" => obj! { "code" => r.pick(&["NotCommitted", "ReplicaConfigPending", "StalePolicyVersion", "RequestConflict", "PermissionDenied", "TransactionError", "UnsupportedMethod", "Busy"]), "message" => "no" } },
		1 => obj! { "nonsense" => true },
		2..=4 => {
			let c = claim(r, s);
			let reference = phi_host::federation_rpc::reference(s).unwrap();
			let mut b = obj! { "principal" => principal(), "spaceId" => "s1", "authorityId" => "a", "dataIncarnation" => "i", "primaryEpoch" => 3.0, "generation" => "g1", "requestId" => "router-1", "method" => reference.get("method").cloned().unwrap(), "argumentHash" => reference.get("argumentHash").cloned().unwrap() };
			if r.below(5) == 0 {
				b.as_object_mut().unwrap().insert("generation", "g2".into());
			}
			obj! { "ok" => true, "result" => 1.0, "claimReceipt" => obj! { "protocol" => "phi-spaces-claim-receipt-v1", "hostId" => "h1", "binding" => b, "resolution" => c } }
		}
		5 => obj! { "ok" => true, "result" => obj! { "generation" => "g7", "admitUntil" => 70_000.0 } },
		_ => obj! { "ok" => true, "result" => claim(r, s) },
	}
}
fn line(r: &mut Rng) -> Json {
	let s = step(r);
	let replies: Vec<Json> = (0..r.below(4)).map(|_| reply(r, &s)).collect();
	let mut l = match r.below(8) {
		0..=2 => obj! { "op" => "invoke", "step" => s.clone() },
		3 | 4 => obj! { "op" => "resolve", "step" => s.clone() },
		5 => obj! { "op" => "reprepare", "step" => s.clone() },
		6 => obj! { "op" => "txnActive", "id" => "m1", "principal" => principal(), "txn" => "t1", "step" => s.clone() },
		_ => {
			let mut origin = s.clone();
			let o = origin.as_object_mut().unwrap();
			o.insert("method", "txn".into());
			o.insert("args", obj! { "action" => "begin", "leaseMs" => 1000.0 });
			o.insert("state", "done".into());
			o.insert("result", obj! { "id" => "t1" });
			o.insert("generationAdmitUntil", Json::Number(r.pick(&[70_000.0, 51_000.0])));
			let (method, args) = r.pick(&[("read", obj! { "template" => Json::Null, "txn" => "t1" }), ("txn", obj! { "action" => "commit", "id" => "t1" }), ("txn", obj! { "action" => "abort", "id" => "t2" })]);
			obj! { "op" => "step", "id" => "m1", "principal" => principal(), "method" => method, "args" => args, "origin" => origin }
		}
	};
	let o = l.as_object_mut().unwrap();
	o.insert("replies", Json::Array(replies));
	o.insert("state", state());
	l
}

async fn run(rpc: &FederationRpc<Io>, l: &Json) -> Result<Json, ()> {
	let null = Json::Null;
	let s = || l.get("step").cloned().unwrap_or(Json::Null);
	let principal = l.get("principal").unwrap_or(&null);
	let id = text(l, "id").unwrap_or("");
	match text(l, "op").unwrap() {
		"invoke" => rpc.invoke(s()).await,
		"resolve" => rpc.resolve(s()).await,
		"reprepare" => match rpc.reprepare(s()).await? {
			Reprepared::Wait => Ok("wait".into()),
			Reprepared::Refuse => Ok("refuse".into()),
			Reprepared::Spec(x) => Ok(x),
		},
		"txnActive" => rpc.txn_active(id, principal, text(l, "txn").unwrap(), l.get("step")).await.map(Json::Bool).map_err(|_| ()),
		_ => rpc.step(id, principal, text(l, "method").unwrap(), l.get("args").unwrap(), None, l.get("origin")).await.map_err(|_| ()),
	}
}

/// The fresh id of a non-mutating delegation is random on the TypeScript side, and with it the signature.
fn plain(sent: &Json) -> Json {
	let mut v = sent.clone();
	for call in v.as_array_mut().unwrap() {
		let Some(t) = call.as_object_mut().and_then(|o| o.get_mut("frame")).and_then(|f| f.as_object_mut()).and_then(|f| f.get_mut("delegation")) else { continue };
		let t = t.as_object_mut().unwrap();
		if t.get("delegation").and_then(|d| text(d, "requestGeneration")) == Some("non-mutating") {
			t.insert("signature", "".into());
			t.get_mut("delegation").unwrap().as_object_mut().unwrap().insert("requestId", "".into());
		}
	}
	v
}

#[test]
fn frames_and_receipts_are_the_same() {
	let cases: u64 = std::env::var("PHI_RPC_CASES").ok().and_then(|n| n.parse().ok()).unwrap_or(3000);
	let runtime = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
	let mut ts = TsDriver::script("test/support/rpc-driver.ts");
	let script = Rc::new(Script { replies: RefCell::default(), sent: RefCell::default(), state: RefCell::new(Json::Null) });
	let signer = Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[7; 32]));
	let rpc = FederationRpc { io: Io(Rc::clone(&script)), signer, key_id: "router-key".into() };
	let mut r = Rng(0x1234_5678_9abc_def1);
	let mut outcomes = std::collections::HashMap::<String, usize>::new();
	for n in 0..cases {
		let l = line(&mut r);
		*script.replies.borrow_mut() = l.get("replies").unwrap().as_array().unwrap().iter().cloned().collect();
		*script.state.borrow_mut() = l.get("state").unwrap().clone();
		script.sent.borrow_mut().clear();
		let got = runtime.block_on(run(&rpc, &l));
		let t = ts.step(&l);
		let context = l.to_json_text();
		let sent = Json::Array(script.sent.borrow().clone());
		assert_eq!(plain(&sent).canonical().unwrap(), plain(t.get("sent").unwrap()).canonical().unwrap(), "frames of case {n}: {context}");
		match (got, t.get("ok") == Some(&Json::Bool(true))) {
			(Ok(v), true) => {
				assert_eq!(v.canonical().unwrap(), t.get("result").unwrap().canonical().unwrap(), "answer of case {n}: {context}");
				*outcomes.entry(v.get("outcome").and_then(Json::as_str).unwrap_or("-").to_owned()).or_default() += 1;
			}
			(Err(()), false) => *outcomes.entry("unknown".into()).or_default() += 1,
			(got, _) => panic!("case {n}: {got:?} against {} on {context}", t.to_json_text()),
		}
	}
	for wanted in ["done", "pending", "failed", "cancelled", "notAdmitted", "needsReview", "unknown"] {
		assert!(outcomes.contains_key(wanted), "never reached {wanted}: {outcomes:?}");
	}
}
