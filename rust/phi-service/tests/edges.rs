// R3, slice 2: limits of the service at their exact edge, where a random walk does not land: both services, the same
// calls, each byte budget one below, at and one above it.
mod common;
use common::{RustSide, Setup, TsService};
use phi_json::{obj, parse, Json};

const T0: f64 = 1_700_000_000_000.0;

struct Both {
	ts: TsService,
	rust: RustSide,
	generations: Vec<(String, String)>,
	n: u64,
}
impl Both {
	fn start(limits: Option<Json>, max_pending: Option<f64>, max_peer: Option<f64>) -> Both {
		let mut ts = TsService::start();
		let mut line = obj! { "op" => "init", "seed" => "edges", "now" => T0 };
		if let Json::Object(o) = &mut line {
			if let Some(l) = &limits {
				o.insert("limits", l.clone());
			}
			if let Some(m) = max_pending {
				o.insert("maxPending", Json::Number(m));
			}
			if let Some(m) = max_peer {
				o.insert("maxPeer", Json::Number(m));
			}
		}
		ts.step(&line);
		Both { ts, rust: rust_side(limits, max_pending, max_peer), generations: vec![], n: 0 }
	}
	fn call(&mut self, peer: &str, text: &str, frame: Option<f64>) -> String {
		let mut l = obj! { "now" => T0, "peer" => peer, "text" => text };
		if let (Some(m), Json::Object(o)) = (frame, &mut l) {
			o.insert("maxFrame", Json::Number(m));
		}
		let t = self.ts.step(&l);
		let want = t.get("reply").and_then(Json::as_str).unwrap().to_owned();
		assert_eq!(self.rust.step(T0, peer, text, frame), want, "{text}");
		assert_eq!(self.rust.state(), t.get("state").and_then(Json::as_str).unwrap(), "{text}");
		want
	}
	fn request(&mut self, peer: &str) -> String {
		if !self.generations.iter().any(|(p, _)| p == peer) {
			let reply = parse(&self.call(peer, r#"{"method":"generation","args":{}}"#, None)).unwrap();
			self.generations.push((peer.to_owned(), reply.get("result").unwrap().get("generation").unwrap().as_str().unwrap().to_owned()));
		}
		self.n += 1;
		let generation = &self.generations.iter().find(|(p, _)| p == peer).unwrap().1;
		format!(r#"{{"generation":"{generation}","requestId":"r{}"}}"#, self.n)
	}
}
fn rust_side(limits: Option<Json>, max_pending: Option<f64>, max_peer: Option<f64>) -> RustSide { RustSide::start(&Setup { seed: "edges".into(), now: T0, store: None, limits, max_calls: None, max_pending, max_peer, authorized: false }) }

fn pending_take(request: &str) -> String { format!(r#"{{"method":"take","args":{{"template":{{"type":"Task"}},"timeoutMs":60000,"waitMs":0}},"request":{request}}}"#) }

#[test]
fn the_answer_of_a_take_fits_the_frame_to_the_byte() {
	let mut seen = std::collections::HashSet::new();
	let mut b = Both::start(None, None, None);
	for pad in 760..960 {
		let r = b.request("local");
		let fields = "x".repeat(pad);
		assert!(b.call("local", &format!(r#"{{"method":"write","args":{{"entry":{{"type":"T{pad}","fields":{{"p":"{fields}"}}}}}},"request":{r}}}"#), None).contains(r#""ok":true"#));
		let r = b.request("local");
		let reply = b.call("local", &format!(r#"{{"method":"take","args":{{"template":{{"type":"T{pad}"}},"waitMs":0}},"request":{r}}}"#), Some(1024.0));
		seen.insert(reply.contains(r#""state":"done""#));
	}
	assert_eq!(seen.len(), 2, "the pads must lie around the edge");
}

#[test]
fn pending_calls_end_at_the_peers_limit() {
	let mut b = Both::start(None, Some(4.0), Some(5.0));
	for _ in 0..4 {
		let r = b.request("local");
		assert!(b.call("local", &pending_take(&r), None).contains("pending"));
	}
	let r = b.request("agent");
	assert!(b.call("agent", &pending_take(&r), None).contains("pending"), "the fifth of the peer");
	let r = b.request("agent");
	assert!(b.call("agent", &pending_take(&r), None).contains("too many pending operations for this peer"));
}


#[test]
fn a_cancel_is_admitted_at_its_claim_budget_to_the_byte() {
	let refused = |text: &str| text.contains("maxClaimBytes");
	let on_rust = |limit: f64| {
		let mut r = rust_side(Some(obj! { "maxClaimBytes" => limit }), None, None);
		let reply = parse(&r.step(T0, "local", r#"{"method":"generation","args":{}}"#, None)).unwrap();
		let generation = reply.get("result").and_then(|x| x.get("generation")).and_then(Json::as_str).map(str::to_owned);
		let Some(generation) = generation else { return "maxClaimBytes".to_owned() };
		let (take, cancel) = (format!(r#"{{"generation":"{generation}","requestId":"r1"}}"#), format!(r#"{{"generation":"{generation}","requestId":"r2"}}"#));
		r.step(T0, "local", &pending_take(&take), None);
		r.step(T0, "local", &format!(r#"{{"method":"cancelOperation","args":{{"targetRequest":{take}}},"request":{cancel}}}"#), None)
	};
	// where it flips, on the Rust side; then both, around that
	let (mut low, mut high) = (1024.0, 64.0 * 1024.0 * 1024.0);
	assert!(!refused(&on_rust(high)), "{}", on_rust(high));
	while high - low > 1.0 {
		let mid = ((low + high) / 2.0_f64).floor();
		if refused(&on_rust(mid)) { low = mid } else { high = mid }
	}
	for limit in [high - 1.0, high, high + 1.0] {
		let mut b = Both::start(Some(obj! { "maxClaimBytes" => limit }), None, None);
		let (take, cancel) = (b.request("local"), b.request("local"));
		b.call("local", &pending_take(&take), None);
		let reply = b.call("local", &format!(r#"{{"method":"cancelOperation","args":{{"targetRequest":{take}}},"request":{cancel}}}"#), None);
		assert_eq!(refused(&reply), limit < high, "{limit}: {reply}");
	}
}
