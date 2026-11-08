//! The JavaScript primitives against the frozen TypeScript engine (docs/rust-portierung.en.md, R8.2): node writes the
//! vectors with `spaces-mmo/tests/r8/primitives.ts` from the oracle (tests/common: the frozen commit unpacked into the
//! target folder) into the target folder, and every pattern, collation, case mapping and
//! number must come out as JavaScript made it.
use std::path::Path;
use std::process::Command;
use std::sync::OnceLock;

mod common;
use common::{oracle, repo};

use mmo_engine::js::{self, JsRegex};
use phi_json::Json;

fn vectors() -> &'static Json {
	static V: OnceLock<Json> = OnceLock::new();
	V.get_or_init(|| {
		let oracle = oracle();
		let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("primitives.json");
		let st = Command::new("node").args(["--no-warnings", "--experimental-strip-types"]).arg(repo().join("spaces-mmo/tests/r8/primitives.ts")).arg(&oracle).arg(&out).status().expect("node on PATH");
		assert!(st.success(), "the vector generator failed");
		phi_json::parse(&std::fs::read_to_string(&out).expect("the vectors")).expect("JSON")
	})
}

fn arr<'a>(v: &'a Json, k: &str) -> &'a Vec<Json> { v.get(k).and_then(Json::as_array).unwrap_or_else(|| panic!("{k}")) }
fn st(v: &Json) -> &str { v.as_str().expect("a string") }

#[test]
fn patterns() {
	let v = vectors();
	let inputs: Vec<&str> = arr(v, "inputs").iter().map(st).collect();
	let (mut bad, mut untranslated, mut n) = (Vec::new(), Vec::new(), 0);
	for p in arr(v, "patterns") {
		let (source, flags) = (st(p.get("source").unwrap()), st(p.get("flags").unwrap()));
		let at = arr(p, "at").iter().map(st).collect::<Vec<_>>().join(", ");
		let re = match JsRegex::new(source, flags) { Ok(r) => r, Err(e) => { untranslated.push(format!("{at}: {e}")); continue; } };
		let hits: std::collections::HashMap<usize, Vec<Json>> = arr(p, "hits").iter().map(|h| { let h = h.as_array().unwrap(); (h[0].as_f64().unwrap() as usize, h[1..].to_vec()) }).collect();
		let mut wrong = 0;
		for (i, s) in inputs.iter().enumerate() {
			n += 1;
			let got: Vec<Json> = re.match_all(s).iter().map(|m| {
				let mut row = vec![Json::Number(m.index16 as f64)];
				row.extend((0..m.groups.len()).map(|g| m.group(s, g).map_or(Json::Null, |t| Json::String(t.into()))));
				Json::Array(row)
			}).collect();
			let expect = hits.get(&i).cloned().unwrap_or_default();
			if got != expect {
				wrong += 1;
				if wrong <= 3 { bad.push(format!("{at} /{source}/{flags} on {s:?}: JS {} Rust {}", Json::Array(expect).to_json_text(), Json::Array(got).to_json_text())); }
			}
		}
		if wrong > 3 { bad.push(format!("{at}: … {} inputs in all", wrong)); }
	}
	assert!(untranslated.is_empty(), "{} patterns without translation:\n{}", untranslated.len(), untranslated.join("\n"));
	assert!(bad.is_empty(), "{} differences ({n} runs):\n{}", bad.len(), bad.join("\n"));
}

#[test]
fn collation() {
	let c = vectors().get("collation").unwrap();
	let mut words: Vec<&str> = arr(c, "words").iter().map(st).collect();
	words.sort_by(|a, b| js::locale_compare(a, b));
	let want: Vec<&str> = arr(c, "root").iter().map(st).collect();
	let first = words.iter().zip(&want).position(|(a, b)| a != b);
	assert!(first.is_none(), "the order differs from {:?}: Rust {:?}, JS {:?}", first, &words[first.unwrap()..(first.unwrap() + 5).min(words.len())], &want[first.unwrap()..(first.unwrap() + 5).min(want.len())]);
	let signs: Vec<i32> = want.windows(2).map(|w| js::locale_compare(w[0], w[1]) as i32).collect();
	let js_signs: Vec<i32> = arr(c, "rootSigns").iter().map(|x| x.as_f64().unwrap() as i32).collect();
	assert_eq!(signs, js_signs);
}

#[test]
fn strings() {
	let v = vectors();
	let mut bad = Vec::new();
	for (s, w) in arr(v, "inputs").iter().map(st).zip(arr(v, "strings")) {
		let (lo, up, l16, nf) = (st(w.get("lower").unwrap()), st(w.get("upper").unwrap()), w.get("len16").unwrap().as_f64().unwrap() as usize, st(w.get("nfkd").unwrap()));
		if js::lower(s) != lo { bad.push(format!("lower {s:?}: JS {lo:?} Rust {:?}", js::lower(s))); }
		if js::upper(s) != up { bad.push(format!("upper {s:?}: JS {up:?} Rust {:?}", js::upper(s))); }
		if js::len16(s) != l16 { bad.push(format!("length {s:?}: JS {l16} Rust {}", js::len16(s))); }
		if js::nfkd(s) != nf { bad.push(format!("nfkd {s:?}: JS {nf:?} Rust {:?}", js::nfkd(s))); }
		let n = js::to_number(s);
		let got = if n.is_nan() { "NaN".to_owned() } else if n == 0.0 && n.is_sign_negative() { "-0".to_owned() } else { js::number_text(n) };
		if got != st(w.get("number").unwrap()) { bad.push(format!("Number({s:?}): JS {} Rust {got}", st(w.get("number").unwrap()))); }
	}
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}

#[test]
fn numbers() {
	let text = |n: f64| if n == 0.0 && n.is_sign_negative() { "-0".to_owned() } else { js::number_text(n) };
	let num = |s: &str| match s { "NaN" => f64::NAN, "Infinity" => f64::INFINITY, "-Infinity" => f64::NEG_INFINITY, "-0" => -0.0, s => s.parse().unwrap() };
	let mut bad = Vec::new();
	for w in arr(vectors(), "numbers") {
		let n = num(st(w.get("n").unwrap()));
		for (k, got) in [("round", text(js::round(n))), ("floor", text(n.floor())), ("ceil", text(n.ceil())), ("trunc", text(n.trunc()))] {
			if got != st(w.get(k).unwrap()) { bad.push(format!("{k}({n}): JS {} Rust {got}", st(w.get(k).unwrap()))); }
		}
		if js::number_text(n) != st(w.get("text").unwrap()) { bad.push(format!("String({n}): JS {} Rust {}", st(w.get("text").unwrap()), js::number_text(n))); }
	}
	assert!(bad.is_empty(), "{}", bad.join("\n"));
}
