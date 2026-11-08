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
use phi_json::{obj, Json};

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

/// The helpers every command uses, against the oracle's own functions.
#[test]
fn helpers() {
	use mmo_engine::{context, funcparser, locks};
	let h = vectors().get("helpers").unwrap();
	let world = mmo_engine::world::load_world(&common::oracle().join("spaces-mmo"), "leuchtfeuer").expect("the world");
	let mut bad: Vec<String> = Vec::new();
	let mut out = |what: &str, ok: bool, detail: String| if !ok && bad.len() < 20 { bad.push(format!("{what}: {detail}")); };
	for r in arr(h, "stem") { let r = r.as_array().unwrap(); let got = context::stem(st(&r[0])); out("stem", got == st(&r[1]), format!("{:?} -> {got:?}, oracle {:?}", st(&r[0]), st(&r[1]))); }
	for r in arr(h, "plural") {
		let r = r.as_array().unwrap();
		let (a, b) = (context::plural_of(st(&r[0]), Some(&world)), context::plural_of(st(&r[0]), None));
		out("pluralOf", a == st(&r[1]) && b == st(&r[2]), format!("{:?} -> {a:?}/{b:?}, oracle {:?}/{:?}", st(&r[0]), st(&r[1]), st(&r[2])));
	}
	for r in arr(h, "typos") {
		let r = r.as_array().unwrap();
		let got = context::typos(st(&r[0]), st(&r[1]), r[2].as_f64().unwrap());
		out("typos", got == r[3].as_f64().unwrap(), format!("{:?} {:?} {} -> {got}, oracle {}", st(&r[0]), st(&r[1]), r[2].to_json_text(), r[3].to_json_text()));
	}
	for r in arr(h, "renders") {
		let r = r.as_array().unwrap();
		let me = r[1] == Json::Bool(true);
		let got = funcparser::render(st(&r[0]), &funcparser::View { viewer: if me { "c1" } else { "c2" }, actor: "c1", actor_name: "Ines" });
		out("render", got == st(&r[2]), format!("{:?} ({me}) -> {got:?}, oracle {:?}", st(&r[0]), st(&r[2])));
	}
	let access: Vec<&str> = arr(h, "access").iter().map(st).collect();
	for r in arr(h, "locks") {
		let l = st(r.get("l").unwrap());
		let parsed = match locks::parse_locks(l) { Ok(p) => Json::Array(p.into_iter().map(|(k, _)| Json::from(k)).collect()), Err(e) => Json::from(e) };
		out("parseLocks", Some(&parsed) == r.get("parsed"), format!("{l:?} -> {}, oracle {}", parsed.to_json_text(), r.get("parsed").unwrap().to_json_text()));
		for (c, row) in arr(h, "lockCtx").iter().zip(arr(r, "allowed")) {
			let held: Vec<&str> = arr(c, "holds").iter().map(st).collect();
			let holds = |k: &str| held.contains(&k);
			let lc = locks::LockCtx { level: st(c.get("level").unwrap()), guest: c.get("guest") == Some(&Json::Bool(true)), char_id: st(c.get("charId").unwrap()), holds: &holds };
			for (a, want) in access.iter().zip(row.as_array().unwrap()) {
				let got = locks::allowed(l, a, &lc);
				out("allowed", Json::Bool(got) == *want, format!("{l:?} {a} {} -> {got}", c.to_json_text()));
			}
		}
	}
	let list: Vec<Json> = arr(h, "things").iter().enumerate().map(|(i, f)| obj! { "fields" => f.clone(), "i" => i as f64 }).collect();
	let idx = |r: Vec<Json>| Json::Array(r.iter().map(|e| e.get("i").cloned().unwrap()).collect());
	for r in arr(h, "lookups") {
		let r = r.as_array().unwrap();
		let q = st(&r[0]);
		let got = [idx(context::by_name(&list, q, None)), idx(context::by_name(&list, q, Some((4.0, 2.0)))), idx(context::items_named(&world, &list, q, None)), idx(context::items_named(&world, &list, q, Some((9.0, 7.0))))];
		for (k, (g, want)) in got.iter().zip(&r[1..]).enumerate() { out(["byName", "byName near", "itemsNamed", "itemsNamed near"][k], g == want, format!("{q:?} -> {}, oracle {}", g.to_json_text(), want.to_json_text())); }
	}
	let views: Vec<mmo_engine::translate::View> = arr(h, "views").iter().map(|v| mmo_engine::translate::View {
		exits: arr(v, "exits").iter().map(|e| (st(e.get("name").unwrap()).to_owned(), arr(e, "aliases").iter().map(|a| st(a).to_owned()).collect())).collect(),
		listings: arr(v, "listings").iter().map(|l| st(l.get("itemName").unwrap()).to_owned()).collect(),
		carried: arr(v, "carried").iter().map(|x| st(x).to_owned()).collect(),
		people: arr(v, "people").iter().map(|x| st(x).to_owned()).collect(),
	}).collect();
	for r in arr(h, "translations") {
		let r = r.as_array().unwrap();
		for (k, v) in views.iter().enumerate() {
			let got = mmo_engine::translate::translate_rules(st(&r[0]), v).map_or(Json::Null, Json::from);
			out("translateRules", got == r[k + 1], format!("{:?} (view {k}) -> {}, oracle {}", st(&r[0]), got.to_json_text(), r[k + 1].to_json_text()));
		}
	}
	assert!(bad.is_empty(), "{} differences:\n  {}", bad.len(), bad.join("\n  "));
}

/// The command tables the engine keeps (src/commands.json) are the oracle's.
#[test]
fn command_table() {
	let out = Path::new(env!("CARGO_TARGET_TMPDIR")).join("commands.json");
	let st = Command::new("node").args(["--no-warnings", "--experimental-strip-types"]).arg(repo().join("spaces-mmo/tests/r8/commands.ts")).arg(oracle()).arg(&out).status().expect("node on PATH");
	assert!(st.success(), "the command table generator failed");
	let (now, kept) = (std::fs::read_to_string(&out).unwrap(), std::fs::read_to_string(repo().join("rust/mmo-engine/src/commands.json")).unwrap());
	assert!(now == kept, "src/commands.json is not the oracle's: run spaces-mmo/tests/r8/commands.ts <oracle> rust/mmo-engine/src/commands.json");
}
