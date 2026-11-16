// R3, slice 2: the scripted session of test/vectors/wire.json, call by call, with random values replaced by the
// placeholders the vector uses for them.
mod common;
use common::{RustSide, Setup};
use phi_json::{parse_repairing, Json, Object};
use std::collections::BTreeMap;

/// The random values seen so far and their placeholders, by first appearance (test/vectors/build.ts `normalize`).
#[derive(Default)]
struct Names {
	names: BTreeMap<String, String>,
	counters: BTreeMap<&'static str, usize>,
}
impl Names {
	fn name(&mut self, kind: &'static str, v: &str) {
		if !self.names.contains_key(v) {
			let c = self.counters.entry(kind).or_default();
			*c += 1;
			self.names.insert(v.to_owned(), format!("<{kind}{c}>"));
		}
	}
	fn words(&mut self, s: &str, kind: &'static str, prefix: &str, len: usize, fine: impl Fn(u8) -> bool) {
		for (i, _) in s.match_indices(prefix) {
			if let Some(w) = s.get(i..i + len) {
				if w[prefix.len()..].bytes().all(&fine) {
					self.name(kind, w);
				}
			}
		}
	}
	fn scan(&mut self, v: &Json, key: Option<&str>) {
		let hexish = |b: u8| b.is_ascii_digit() || (b'a'..=b'f').contains(&b);
		match v {
			Json::String(s) => {
				for (i, _) in s.match_indices('g') {
					if let Some(w) = s.get(i..i + 98) {
						if w.as_bytes()[33] == b'.' && w[1..33].bytes().all(hexish) && w[34..].bytes().all(hexish) {
							self.name("generation", w);
						}
					}
				}
				self.words(s, "host", "host-", 41, |b| hexish(b) || b == b'-');
				self.words(s, "space", "sp-", 39, |b| hexish(b) || b == b'-');
				self.words(s, "mailbox", "mb", 34, hexish);
				if key == Some("incarnation") {
					self.name("incarnation", s);
				}
			}
			Json::Array(a) => a.iter().for_each(|x| self.scan(x, None)),
			Json::Object(o) => o.iter().for_each(|(k, x)| self.scan(x, Some(k))),
			_ => {}
		}
	}
	fn order(&self) -> Vec<(&String, &String)> {
		let mut all: Vec<_> = self.names.iter().collect();
		all.sort_by_key(|(k, _)| std::cmp::Reverse(k.len()));
		all
	}
	fn rewrite(&self, v: &Json) -> Json {
		match v {
			Json::String(s) => {
				let mut out = s.clone();
				for (k, p) in self.order() {
					out = out.replace(k.as_str(), p);
				}
				out.into()
			}
			Json::Array(a) => Json::Array(a.iter().map(|x| self.rewrite(x)).collect()),
			Json::Object(o) => Json::Object(o.iter().map(|(k, x)| (k, self.rewrite(x))).collect::<Object>()),
			other => other.clone(),
		}
	}
	/// A call of the vector with its placeholders back to the values of this run.
	fn fill(&self, v: &Json) -> Json {
		match v {
			Json::String(s) => {
				let mut out = s.clone();
				for (k, p) in self.order() {
					out = out.replace(p.as_str(), k);
				}
				out.into()
			}
			Json::Array(a) => Json::Array(a.iter().map(|x| self.fill(x)).collect()),
			Json::Object(o) => Json::Object(o.iter().map(|(k, x)| (k, self.fill(x))).collect::<Object>()),
			other => other.clone(),
		}
	}
}

#[test]
fn the_scripted_session() {
	let root = format!("{}/../../test/vectors/wire.json", env!("CARGO_MANIFEST_DIR"));
	let vector = parse_repairing(&std::fs::read_to_string(root).unwrap()).unwrap();
	let steps = vector.get("steps").and_then(Json::as_array).unwrap();
	let mut side = RustSide::start(&Setup { seed: "wire".into(), now: vector.get("t0").and_then(Json::as_f64).unwrap(), store: None, limits: None, max_calls: None, max_pending: None, max_peer: None, authorized: false });
	let mut names = Names::default();
	for (i, s) in steps.iter().enumerate() {
		let call = names.fill(s.get("call").unwrap());
		let text = side.step(s.get("now").and_then(Json::as_f64).unwrap(), "local", &call.to_json_text(), None);
		let reply = parse_repairing(&text).unwrap();
		names.scan(&reply, None);
		let got = names.rewrite(&reply);
		assert_eq!(got.to_json_text(), s.get("reply").unwrap().to_json_text(), "step {i}: {}", call.to_json_text());
	}
}
