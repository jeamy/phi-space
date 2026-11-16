// v3 6.2 on the wire: after a promotion, `resolveOperation` answers an unknown request of an earlier epoch NotCommitted
// only with promotion evidence, by a durable negative claim that a late original call meets. The service driver runs with
// `epochs` (its epoch and evidence set line by line), the Rust service with `epoch_for_space` and `promotion_proof` on
// the same values: a confirmed request keeps its result, an unknown one without evidence stays IncarnationChanged and
// with it becomes NotCommitted, again the same, other arguments a conflict, the late original call, its poll and its
// retry with an old frame meet the claim, a request of the current epoch is notAdmitted, an epoch ahead and a generation
// of a later epoch are refused, and once the claim's retention is over the request is unknown. Every reply agrees byte
// for byte, the Space's state by its hash; once in memory and once on a store file, through the default Space and by
// its alias.
mod common;
use common::{RustSide, Setup, TsService};
use phi_json::{digest_json, obj, parse, Json};
use phi_service::rpc_domain;
use std::cell::{Cell, RefCell};
use std::path::PathBuf;
use std::rc::Rc;

struct Pair {
	ts: TsService,
	rust: RustSide,
	epoch: Rc<Cell<f64>>,
	proof: Rc<RefCell<Option<Json>>>,
	now: f64,
	space: Option<&'static str>,
	replies: Vec<Json>,
}
impl Pair {
	fn start(store: Option<(PathBuf, PathBuf)>, space: Option<&'static str>) -> Pair {
		let now = 1_700_000_000_000.0;
		let mut ts = TsService::start();
		let mut init = obj! { "op" => "init", "seed" => "nc", "now" => now, "epochs" => true };
		if let Some((t, _)) = &store {
			init.as_object_mut().unwrap().insert("store", Json::from(t.to_str().unwrap()));
		}
		ts.step(&init);
		let (epoch, proof) = (Rc::new(Cell::new(1.0)), Rc::new(RefCell::new(None::<Json>)));
		let setup = Setup { seed: "nc".into(), now, store: store.map(|(_, r)| r), limits: None, max_calls: None, max_pending: None, max_peer: None, authorized: false };
		let (e, p) = (epoch.clone(), proof.clone());
		let rust = RustSide::start_with(&setup, move |o| {
			o.epoch_for_space = Some(Rc::new(move |_, _| e.get()));
			o.promotion_proof = Some(Rc::new(move |_, _| p.borrow().clone().map(|h| obj! { "hash" => h })));
		});
		Pair { ts, rust, epoch, proof, now, space, replies: vec![] }
	}
	/// The host's epoch and its evidence (`None`: none can be shown).
	fn promote(&mut self, epoch: f64, proof: Option<&str>) {
		self.epoch.set(epoch);
		*self.proof.borrow_mut() = proof.map(Json::from);
		self.ts.step(&obj! { "op" => "epoch", "epoch" => epoch, "proof" => proof.map_or(Json::Null, Json::from) });
	}
	/// One call through both: the reply, after both agreed on it and on the state.
	fn call(&mut self, mut call: Json) -> Json {
		self.now += 100.0;
		if let (Some(s), Json::Object(o)) = (self.space, &mut call) {
			o.insert("space", Json::from(s));
		}
		let text = call.to_json_text();
		let t = self.ts.step(&obj! { "now" => self.now, "peer" => "local", "text" => text.as_str() });
		let want = t.get("reply").and_then(Json::as_str).unwrap().to_owned();
		let got = self.rust.step(self.now, "local", &text, None);
		assert_eq!(got, want, "{text}");
		assert_eq!(self.rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "the state after {text}");
		let reply = parse(&got).unwrap();
		self.replies.push(reply.clone());
		reply
	}
}

fn code(r: &Json) -> &str { r.get("error").and_then(|e| e.get("code")).and_then(Json::as_str).unwrap_or("ok") }
fn view_code(r: &Json) -> Option<&str> { r.get("result")?.get("error")?.get("code")?.as_str() }

fn scenario(store: Option<(PathBuf, PathBuf)>, space: Option<&'static str>) {
	let mut p = Pair::start(store, space);
	let local = obj! { "peerId" => "local" };
	let write = |n: f64| obj! { "entry" => obj! { "type" => "Work", "fields" => obj! { "n" => n } } };
	let hash = |n: f64| {
		let (m, a) = rpc_domain("write", write(n).as_object().unwrap(), &local);
		digest_json(&obj! { "method" => m, "args" => a }).unwrap()
	};
	// epoch 1: r1 is confirmed, r3 too; r2 never arrived
	let g1 = p.call(obj! { "method" => "generation", "args" => obj! {} }).get("result").and_then(|r| r.get("generation")).cloned().unwrap();
	let request = |id: &str| obj! { "generation" => g1.clone(), "requestId" => id };
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r1"), "args" => write(1.0) })), "ok");
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r3"), "args" => write(3.0) })), "ok");
	let resolve = |id: &str, n: f64, epoch: f64| obj! { "method" => "resolveOperation", "args" => obj! { "targetRequest" => request(id), "method" => "write", "argumentHash" => hash(n), "primaryEpoch" => epoch } };
	// promoted to epoch 3; without evidence the outcome stays unknown
	p.promote(3.0, None);
	assert_eq!(code(&p.call(resolve("r2", 2.0, 1.0))), "IncarnationChanged");
	p.promote(3.0, Some(&"b".repeat(64)));
	let r1 = p.call(resolve("r1", 1.0, 1.0));
	assert_eq!((code(&r1), view_code(&r1)), ("ok", None), "the confirmed request keeps its result");
	let r2 = p.call(resolve("r2", 2.0, 1.0));
	assert_eq!(view_code(&r2), Some("NotCommitted"));
	assert_eq!(p.call(resolve("r2", 2.0, 1.0)), r2, "repeatable");
	assert_eq!(code(&p.call(resolve("r2", 9.0, 1.0))), "RequestConflict");
	assert_eq!(view_code(&p.call(resolve("r2", 2.0, 3.0))), Some("NotCommitted"), "known at the current epoch too");
	// the late original call, its poll, and its retry with the old frame
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r2"), "args" => write(2.0) })), "NotCommitted");
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r2"), "args" => write(2.0), "frame" => obj! { "primaryEpoch" => 1.0 } })), "StaleEpoch");
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r2"), "args" => write(2.0), "frame" => obj! { "primaryEpoch" => 3.0 } })), "NotCommitted");
	assert_eq!(view_code(&p.call(obj! { "method" => "pollOperation", "args" => obj! { "targetRequest" => request("r2") } })), Some("NotCommitted"));
	assert_eq!(code(&p.call(obj! { "method" => "count", "args" => obj! { "template" => obj! { "type" => "Work" } } })), "ok");
	// a resolution with the frame of its epoch is let through; one ahead of the Member is refused
	assert_eq!(view_code(&p.call(obj! { "method" => "resolveOperation", "frame" => obj! { "primaryEpoch" => 1.0 }, "args" => resolve("r2", 2.0, 1.0).get("args").cloned().unwrap() })), Some("NotCommitted"));
	assert_eq!(code(&p.call(resolve("r2", 2.0, 4.0))), "IncarnationChanged");
	// an unknown request of epoch 2 under evidence of another hash
	p.promote(3.0, Some(&"c".repeat(64)));
	assert_eq!(view_code(&p.call(resolve("r5", 5.0, 2.0))), Some("NotCommitted"));
	// the current epoch: a miss is notAdmitted, and a generation of it cannot claim an earlier one
	let g3 = p.call(obj! { "method" => "generation", "args" => obj! {} }).get("result").and_then(|r| r.get("generation")).cloned().unwrap();
	let current = |id: &str, epoch: f64| obj! { "method" => "resolveOperation", "args" => obj! { "targetRequest" => obj! { "generation" => g3.clone(), "requestId" => id }, "method" => "write", "argumentHash" => hash(8.0), "primaryEpoch" => epoch } };
	assert_eq!(p.call(current("r9", 3.0)).get("result").and_then(|r| r.get("state")).and_then(Json::as_str), Some("notAdmitted"));
	assert_eq!(code(&p.call(current("r8", 1.0))), "IncarnationChanged");
	assert_eq!(p.call(obj! { "method" => "hello", "args" => obj! { "protocol" => 1.0 } }).get("result").and_then(|r| r.get("primaryEpoch")).and_then(Json::as_f64), Some(3.0));
	// a malformed resolution and one in a Space this host does not hold
	assert_eq!(code(&p.call(obj! { "method" => "resolveOperation", "args" => obj! { "targetRequest" => request("r6"), "method" => "write", "argumentHash" => "x", "primaryEpoch" => 1.0 } })), "BadRequest");
	assert_eq!(code(&p.call(obj! { "method" => "resolveOperation", "args" => obj! { "targetRequest" => request("r6"), "method" => "write", "argumentHash" => hash(6.0), "primaryEpoch" => 1.5 } })), "BadRequest");
	// once retention and admission are over: unknown, never NotCommitted and never a new effect
	p.now += 25.0 * 3_600_000.0;
	p.call(obj! { "method" => "generation", "args" => obj! {} });
	assert_eq!(code(&p.call(resolve("r2", 2.0, 1.0))), "RequestExpired");
	assert_eq!(code(&p.call(obj! { "method" => "write", "request" => request("r2"), "args" => write(2.0) })), "RequestExpired");
	assert!(p.replies.iter().all(|r| code(r) != "Internal"), "no internal error");
}

#[test]
fn not_committed_after_a_promotion_agrees_with_the_typescript_service() {
	scenario(None, None);
	scenario(None, Some("default"));
	let dir = PathBuf::from(env!("CARGO_TARGET_TMPDIR")).join("not-committed");
	let _ = std::fs::remove_dir_all(&dir);
	std::fs::create_dir_all(&dir).unwrap();
	scenario(Some((dir.join("ts.sqlite"), dir.join("rust.sqlite"))), None);
}
