//! Reading and building the JSON the engine works on (world definition, entry fields) the way the TypeScript code reads
//! its objects: a missing key is `undefined` (here `Json::Null` by reference, `None` for options), `{ ...a, ...b }` keeps
//! the first place of a key and the last value (phi-json's object order is JavaScript's).
use phi_json::{Json, Object};

static NULL: Json = Json::Null;
static EMPTY: Vec<Json> = Vec::new();

/// `v[k]`, `undefined` as null.
pub fn at<'a>(v: &'a Json, k: &str) -> &'a Json { v.get(k).unwrap_or(&NULL) }
/// `v[k]` when it is there and not null.
pub fn opt<'a>(v: &'a Json, k: &str) -> Option<&'a Json> { v.get(k).filter(|x| !x.is_null()) }
/// A string field ("" when missing).
pub fn s<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap_or("") }
/// A string field, `None` when missing.
pub fn so<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }
/// A number field (NaN when missing, as `undefined` turns into in arithmetic).
pub fn n(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
/// A number field, `None` when missing.
pub fn no(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
/// An array field (empty when missing: `?? []`).
pub fn a<'a>(v: &'a Json, k: &str) -> &'a [Json] { v.get(k).and_then(Json::as_array).map_or(&EMPTY[..], Vec::as_slice) }
/// An array field, `None` when missing.
pub fn ao<'a>(v: &'a Json, k: &str) -> Option<&'a [Json]> { v.get(k).and_then(Json::as_array).map(Vec::as_slice) }
/// A boolean field as `!!v[k]`.
pub fn b(v: &Json, k: &str) -> bool { v.get(k).is_some_and(truthy) }

/// JavaScript truthiness.
pub fn truthy(v: &Json) -> bool {
	match v {
		Json::Null => false,
		Json::Bool(b) => *b,
		Json::Number(n) => *n != 0.0 && !n.is_nan(),
		Json::String(s) => !s.is_empty(),
		Json::Array(_) | Json::Object(_) => true,
	}
}

/// `Number(v)` of a JSON value.
pub fn number(v: &Json) -> f64 {
	match v {
		Json::Null => 0.0,
		Json::Bool(b) => if *b { 1.0 } else { 0.0 },
		Json::Number(n) => *n,
		Json::String(s) => { let t = s.trim(); if t.is_empty() { 0.0 } else { t.parse().unwrap_or(f64::NAN) } }
		Json::Array(_) | Json::Object(_) => f64::NAN,
	}
}

/// The properties of an object (none for anything else).
pub fn entries(v: &Json) -> impl Iterator<Item = (&str, &Json)> { v.as_object().into_iter().flat_map(|o| o.iter()) }

/// `{ ...v }` as an object to add to.
pub fn object(v: &Json) -> Object { v.as_object().cloned().unwrap_or_default() }

/// `{ ...base, ...over }`.
pub fn spread(base: &Json, over: &Json) -> Json {
	let mut o = object(base);
	for (k, x) in entries(over) { o.insert(k, x.clone()); }
	Json::Object(o)
}

/// Sets `k` (a property of an object; a no-op on anything else).
pub fn set(v: &mut Json, k: &str, x: impl Into<Json>) { if let Json::Object(o) = v { o.insert(k, x.into()); } }

/// Takes `k` out (`const { k, ...rest } = v`).
pub fn without(v: &Json, k: &str) -> Json { let mut o = object(v); o.remove(k); Json::Object(o) }

/// A list of strings.
pub fn strs(v: &[Json]) -> Vec<&str> { v.iter().filter_map(Json::as_str).collect() }

/// Where `pred` holds first (`find`).
pub fn find(list: &[Json], pred: impl Fn(&Json) -> bool) -> Option<&Json> { list.iter().find(|x| pred(x)) }

/// The element of `list` whose `k` is `v`.
pub fn by<'a>(list: &'a [Json], k: &str, v: &str) -> Option<&'a Json> { list.iter().find(|x| s(x, k) == v) }
