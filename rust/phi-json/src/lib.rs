//! JSON as phi-spaces' TypeScript code sees it (docs/wire-protokoll.md, section 6; test/vectors/canonical.json).
//!
//! - A value is what `JSON.parse` makes: numbers are IEEE-754 doubles, objects keep JavaScript's property order (array
//!   index keys first, ascending, then the others in insertion order; a repeated key keeps its first place and its last
//!   value).
//! - [`Json::to_json_text`] is `JSON.stringify`: that order, the ECMAScript number form, non-finite numbers as `null`.
//! - [`Json::canonical`] is `canonicalJson` (src/canonical.ts, RFC 8785): keys sorted by UTF-16 code units, non-finite
//!   numbers refused. [`digest_json`] is the hex SHA-256 of it.
//!
//! A string with an unpaired surrogate cannot be a Rust `String`. `parse` refuses it (a stored value); the text of a call
//! goes through `parse_repairing`, which writes U+FFFD for it as the service does (R-D10, docs/wire-protokoll.md).
use sha2::{Digest, Sha256};
use std::fmt::Write as _;

pub const FOREVER: f64 = 9_007_199_254_740_991.0; // Number.MAX_SAFE_INTEGER

#[derive(Clone, Debug, PartialEq)]
pub enum Json {
	Null,
	Bool(bool),
	Number(f64),
	String(String),
	Array(Vec<Json>),
	Object(Object),
}

/// An object's properties in JavaScript's order.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Object(Vec<(String, Json)>);

/// An array index as a property key: "0" or digits without a leading zero, at most 2^32 - 2.
fn index_of(key: &str) -> Option<u32> {
	if key.is_empty() || key.len() > 10 || !key.bytes().all(|b| b.is_ascii_digit()) || (key.len() > 1 && key.starts_with('0')) {
		return None;
	}
	let n: u64 = key.parse().ok()?;
	if n <= 4_294_967_294 { Some(n as u32) } else { None }
}

impl Object {
	pub fn new() -> Self { Object(Vec::new()) }
	pub fn len(&self) -> usize { self.0.len() }
	pub fn is_empty(&self) -> bool { self.0.is_empty() }
	pub fn get(&self, key: &str) -> Option<&Json> { self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v) }
	pub fn get_mut(&mut self, key: &str) -> Option<&mut Json> { self.0.iter_mut().find(|(k, _)| k == key).map(|(_, v)| v) }
	pub fn contains_key(&self, key: &str) -> bool { self.get(key).is_some() }
	pub fn iter(&self) -> impl Iterator<Item = (&str, &Json)> { self.0.iter().map(|(k, v)| (k.as_str(), v)) }
	pub fn keys(&self) -> impl Iterator<Item = &str> { self.0.iter().map(|(k, _)| k.as_str()) }
	/// Sets a property as JavaScript assignment does: an existing key keeps its place, a new index key goes among the
	/// index keys by value, any other new key goes last.
	pub fn insert(&mut self, key: impl Into<String>, value: Json) {
		let key = key.into();
		if let Some(slot) = self.get_mut(&key) {
			*slot = value;
			return;
		}
		match index_of(&key) {
			Some(n) => {
				let at = self.0.iter().position(|(k, _)| index_of(k).is_none_or(|m| m > n)).unwrap_or(self.0.len());
				self.0.insert(at, (key, value));
			}
			None => self.0.push((key, value)),
		}
	}
	/// The position of a key.
	pub fn position(&self, key: &str) -> Option<usize> { self.0.iter().position(|(k, _)| k == key) }
	/// Puts a key back where it was (an undo of `remove`: the place it had, not where JavaScript would add it).
	pub fn insert_at(&mut self, at: usize, key: impl Into<String>, value: Json) {
		let key = key.into();
		self.remove(&key);
		self.0.insert(at.min(self.0.len()), (key, value));
	}
	pub fn remove(&mut self, key: &str) -> Option<Json> {
		let at = self.0.iter().position(|(k, _)| k == key)?;
		Some(self.0.remove(at).1)
	}
}

impl<K: Into<String>> FromIterator<(K, Json)> for Object {
	fn from_iter<I: IntoIterator<Item = (K, Json)>>(iter: I) -> Self {
		let mut o = Object::new();
		for (k, v) in iter { o.insert(k, v); }
		o
	}
}

impl From<&str> for Json { fn from(s: &str) -> Self { Json::String(s.to_owned()) } }
impl From<String> for Json { fn from(s: String) -> Self { Json::String(s) } }
impl From<f64> for Json { fn from(n: f64) -> Self { Json::Number(n) } }
impl From<i64> for Json { fn from(n: i64) -> Self { Json::Number(n as f64) } }
impl From<bool> for Json { fn from(b: bool) -> Self { Json::Bool(b) } }
impl From<Object> for Json { fn from(o: Object) -> Self { Json::Object(o) } }
impl From<Vec<Json>> for Json { fn from(a: Vec<Json>) -> Self { Json::Array(a) } }

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
	/// Not JSON at this byte offset.
	Syntax(usize),
	/// A `\uD800`–`\uDFFF` escape without its partner: valid for `JSON.parse`, not representable here.
	UnpairedSurrogate(usize),
	/// Nested deeper than [`MAX_DEPTH`].
	TooDeep,
}
impl std::fmt::Display for ParseError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		match self {
			ParseError::Syntax(at) => write!(f, "not JSON at byte {at}"),
			ParseError::UnpairedSurrogate(at) => write!(f, "unpaired surrogate at byte {at}"),
			ParseError::TooDeep => write!(f, "JSON nested deeper than {MAX_DEPTH} levels"),
		}
	}
}
impl std::error::Error for ParseError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NonFinite;
impl std::fmt::Display for NonFinite {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str("canonical JSON: non-finite number") }
}
impl std::error::Error for NonFinite {}

/// Deeper input is refused instead of overflowing the stack (V8's own limit lies far above what phi-spaces sends).
pub const MAX_DEPTH: usize = 512;

/// `JSON.parse`: whitespace is space, tab, LF and CR; numbers become the nearest double.
pub fn parse(text: &str) -> Result<Json, ParseError> {
	Parser { s: text.as_bytes(), at: 0, repair: false }.document()
}

/// `parse`, with an unpaired surrogate replaced by U+FFFD (`wellFormed` in src/service.ts).
pub fn parse_repairing(text: &str) -> Result<Json, ParseError> { Parser { s: text.as_bytes(), at: 0, repair: true }.document() }

struct Parser<'a> { s: &'a [u8], at: usize, repair: bool }

impl Parser<'_> {
	fn document(mut self) -> Result<Json, ParseError> {
		self.ws();
		let v = self.value(0)?;
		self.ws();
		if self.at != self.s.len() { return Err(ParseError::Syntax(self.at)); }
		Ok(v)
	}
	fn ws(&mut self) { while let Some(b' ' | b'\t' | b'\n' | b'\r') = self.s.get(self.at) { self.at += 1; } }
	fn peek(&self) -> Option<u8> { self.s.get(self.at).copied() }
	fn eat(&mut self, b: u8) -> Result<(), ParseError> {
		if self.peek() == Some(b) { self.at += 1; Ok(()) } else { Err(ParseError::Syntax(self.at)) }
	}
	fn word(&mut self, w: &str, v: Json) -> Result<Json, ParseError> {
		if self.s[self.at..].starts_with(w.as_bytes()) { self.at += w.len(); Ok(v) } else { Err(ParseError::Syntax(self.at)) }
	}
	fn value(&mut self, depth: usize) -> Result<Json, ParseError> {
		if depth > MAX_DEPTH { return Err(ParseError::TooDeep); }
		match self.peek() {
			Some(b'n') => self.word("null", Json::Null),
			Some(b't') => self.word("true", Json::Bool(true)),
			Some(b'f') => self.word("false", Json::Bool(false)),
			Some(b'"') => Ok(Json::String(self.string()?)),
			Some(b'[') => {
				self.at += 1;
				let mut items = Vec::new();
				self.ws();
				if self.peek() == Some(b']') { self.at += 1; return Ok(Json::Array(items)); }
				loop {
					self.ws();
					items.push(self.value(depth + 1)?);
					self.ws();
					match self.peek() {
						Some(b',') => self.at += 1,
						Some(b']') => { self.at += 1; return Ok(Json::Array(items)); }
						_ => return Err(ParseError::Syntax(self.at)),
					}
				}
			}
			Some(b'{') => {
				self.at += 1;
				let mut o = Object::new();
				self.ws();
				if self.peek() == Some(b'}') { self.at += 1; return Ok(Json::Object(o)); }
				loop {
					self.ws();
					if self.peek() != Some(b'"') { return Err(ParseError::Syntax(self.at)); }
					let k = self.string()?;
					self.ws();
					self.eat(b':')?;
					self.ws();
					let v = self.value(depth + 1)?;
					o.insert(k, v);
					self.ws();
					match self.peek() {
						Some(b',') => self.at += 1,
						Some(b'}') => { self.at += 1; return Ok(Json::Object(o)); }
						_ => return Err(ParseError::Syntax(self.at)),
					}
				}
			}
			Some(b'-' | b'0'..=b'9') => self.number(),
			_ => Err(ParseError::Syntax(self.at)),
		}
	}
	fn digits(&mut self) -> usize { let from = self.at; while matches!(self.peek(), Some(b'0'..=b'9')) { self.at += 1; } self.at - from }
	fn number(&mut self) -> Result<Json, ParseError> {
		let from = self.at;
		if self.peek() == Some(b'-') { self.at += 1; }
		match self.peek() {
			Some(b'0') => self.at += 1,
			Some(b'1'..=b'9') => { self.digits(); }
			_ => return Err(ParseError::Syntax(self.at)),
		}
		if self.peek() == Some(b'.') { self.at += 1; if self.digits() == 0 { return Err(ParseError::Syntax(self.at)); } }
		if let Some(b'e' | b'E') = self.peek() {
			self.at += 1;
			if let Some(b'+' | b'-') = self.peek() { self.at += 1; }
			if self.digits() == 0 { return Err(ParseError::Syntax(self.at)); }
		}
		// the grammar above is a subset of what f64's parser takes, and it rounds to nearest as JSON.parse does
		let text = std::str::from_utf8(&self.s[from..self.at]).map_err(|_| ParseError::Syntax(from))?;
		text.parse::<f64>().map(Json::Number).map_err(|_| ParseError::Syntax(from))
	}
	fn hex4(&mut self) -> Result<u32, ParseError> {
		let h = self.s.get(self.at..self.at + 4).ok_or(ParseError::Syntax(self.at))?;
		let h = std::str::from_utf8(h).map_err(|_| ParseError::Syntax(self.at))?;
		if !h.bytes().all(|b| b.is_ascii_hexdigit()) { return Err(ParseError::Syntax(self.at)); }
		self.at += 4;
		Ok(u32::from_str_radix(h, 16).unwrap())
	}
	fn string(&mut self) -> Result<String, ParseError> {
		self.eat(b'"')?;
		let mut out = String::new();
		loop {
			let start = self.at;
			while let Some(b) = self.peek() { if b == b'"' || b == b'\\' || b < 0x20 { break; } self.at += 1; }
			out.push_str(std::str::from_utf8(&self.s[start..self.at]).map_err(|_| ParseError::Syntax(start))?);
			match self.peek() {
				Some(b'"') => { self.at += 1; return Ok(out); }
				Some(b'\\') => {
					let esc = self.at;
					self.at += 1;
					let c = self.peek().ok_or(ParseError::Syntax(self.at))?;
					self.at += 1;
					match c {
						b'"' => out.push('"'), b'\\' => out.push('\\'), b'/' => out.push('/'),
						b'b' => out.push('\u{8}'), b'f' => out.push('\u{c}'), b'n' => out.push('\n'), b'r' => out.push('\r'), b't' => out.push('\t'),
						b'u' => {
							let u = self.hex4()?;
							let ch = match u {
								0xD800..=0xDBFF => {
									let after = self.at;
									let lo = if self.s.get(after..after + 2) == Some(b"\\u") {
										self.at += 2;
										self.hex4()?
									} else {
										0
									};
									if (0xDC00..=0xDFFF).contains(&lo) {
										0x10000 + ((u - 0xD800) << 10) + (lo - 0xDC00)
									} else if self.repair {
										self.at = after; // what follows is looked at on its own
										0xFFFD
									} else {
										return Err(ParseError::UnpairedSurrogate(esc));
									}
								}
								0xDC00..=0xDFFF if self.repair => 0xFFFD,
								0xDC00..=0xDFFF => return Err(ParseError::UnpairedSurrogate(esc)),
								_ => u,
							};
							out.push(char::from_u32(ch).ok_or(ParseError::Syntax(esc))?);
						}
						_ => return Err(ParseError::Syntax(esc)),
					}
				}
				_ => return Err(ParseError::Syntax(self.at)), // an unescaped control character, or the end
			}
		}
	}
}

/// `String(n)` for a finite double: the ECMAScript Number::toString form (`-0` is `"0"`).
pub fn number_text(n: f64) -> String {
	if n == 0.0 { return "0".to_owned(); }
	ryu_js::Buffer::new().format_finite(n).to_owned()
}

/// A string as `JSON.stringify` writes it.
fn quote(s: &str, out: &mut String) {
	out.push('"');
	for c in s.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			c if (c as u32) < 0x20 => { let _ = write!(out, "\\u{:04x}", c as u32); }
			c => out.push(c),
		}
	}
	out.push('"');
}

/// Orders keys by their UTF-16 code units, as JavaScript's default sort does.
fn utf16_cmp(a: &str, b: &str) -> std::cmp::Ordering { a.encode_utf16().cmp(b.encode_utf16()) }

impl Json {
	/// `JSON.stringify(v)`.
	pub fn to_json_text(&self) -> String { let mut out = String::new(); self.write_text(&mut out); out }
	fn write_text(&self, out: &mut String) {
		match self {
			Json::Null => out.push_str("null"),
			Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
			Json::Number(n) => if n.is_finite() { out.push_str(&number_text(*n)) } else { out.push_str("null") },
			Json::String(s) => quote(s, out),
			Json::Array(a) => {
				out.push('[');
				for (i, v) in a.iter().enumerate() { if i > 0 { out.push(','); } v.write_text(out); }
				out.push(']');
			}
			Json::Object(o) => {
				out.push('{');
				for (i, (k, v)) in o.0.iter().enumerate() { if i > 0 { out.push(','); } quote(k, out); out.push(':'); v.write_text(out); }
				out.push('}');
			}
		}
	}
	/// `canonicalJson(v)` (RFC 8785).
	pub fn canonical(&self) -> Result<String, NonFinite> { let mut out = String::new(); self.write_canonical(&mut out)?; Ok(out) }
	fn write_canonical(&self, out: &mut String) -> Result<(), NonFinite> {
		match self {
			Json::Number(n) if !n.is_finite() => return Err(NonFinite),
			Json::Array(a) => {
				out.push('[');
				for (i, v) in a.iter().enumerate() { if i > 0 { out.push(','); } v.write_canonical(out)?; }
				out.push(']');
			}
			Json::Object(o) => {
				let mut props: Vec<&(String, Json)> = o.0.iter().collect();
				props.sort_by(|a, b| utf16_cmp(&a.0, &b.0));
				out.push('{');
				for (i, (k, v)) in props.into_iter().enumerate() { if i > 0 { out.push(','); } quote(k, out); out.push(':'); v.write_canonical(out)?; }
				out.push('}');
			}
			other => other.write_text(out),
		}
		Ok(())
	}
	/// `jsonBytes(v)` (src/json.ts): the UTF-8 bytes of `JSON.stringify(v)`.
	pub fn json_bytes(&self) -> usize { self.to_json_text().len() }

	pub fn as_str(&self) -> Option<&str> { if let Json::String(s) = self { Some(s) } else { None } }
	pub fn as_f64(&self) -> Option<f64> { if let Json::Number(n) = self { Some(*n) } else { None } }
	pub fn as_bool(&self) -> Option<bool> { if let Json::Bool(b) = self { Some(*b) } else { None } }
	pub fn as_array(&self) -> Option<&Vec<Json>> { if let Json::Array(a) = self { Some(a) } else { None } }
	pub fn as_object(&self) -> Option<&Object> { if let Json::Object(o) = self { Some(o) } else { None } }
	pub fn as_object_mut(&mut self) -> Option<&mut Object> { if let Json::Object(o) = self { Some(o) } else { None } }
	pub fn is_null(&self) -> bool { matches!(self, Json::Null) }
	/// `v[key]` of an object (None for anything else or a missing key).
	pub fn get(&self, key: &str) -> Option<&Json> { self.as_object()?.get(key) }
}

/// Lowercase hex of bytes.
pub fn hex(bytes: &[u8]) -> String { let mut s = String::with_capacity(bytes.len() * 2); for b in bytes { let _ = write!(s, "{b:02x}"); } s }

/// `digestJson(v)` (src/canonical.ts): the hex SHA-256 of the canonical form.
pub fn digest_json(v: &Json) -> Result<String, NonFinite> { Ok(hex(&Sha256::digest(v.canonical()?.as_bytes()))) }

/// Builds a [`Json::Object`] from `key => value` pairs in the order given (JavaScript's ordering rule applies).
#[macro_export]
macro_rules! obj {
	($($k:expr => $v:expr),* $(,)?) => {{ let mut o = $crate::Object::new(); $(o.insert($k, $crate::Json::from($v));)* $crate::Json::Object(o) }};
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn index_keys_go_first_and_repeated_keys_keep_their_place() {
		let v = parse(r#"{"b":1,"2":2,"1":3,"a":4,"01":5,"4294967295":6,"4294967294":7,"-1":8,"0":9}"#).unwrap();
		assert_eq!(v.to_json_text(), r#"{"0":9,"1":3,"2":2,"4294967294":7,"b":1,"a":4,"01":5,"4294967295":6,"-1":8}"#);
		assert_eq!(parse(r#"{"a":1,"b":2,"a":3}"#).unwrap().to_json_text(), r#"{"a":3,"b":2}"#);
	}
	#[test]
	fn refuses_what_json_parse_refuses() {
		for bad in ["", "01", "1.", ".5", "+1", "[1,]", "{\"a\":1,}", "'a'", "\"\t\"", "nul", "1 2", "{1:2}", "\"\\x\""] {
			assert!(parse(bad).is_err(), "{bad:?} was accepted");
		}
		assert_eq!(parse("\"\\udc00\""), Err(ParseError::UnpairedSurrogate(1)));
	}
	#[test]
	fn forever_round_trips() {
		assert_eq!(number_text(FOREVER), "9007199254740991");
		assert_eq!(parse("9007199254740991").unwrap(), Json::Number(FOREVER));
	}
}
