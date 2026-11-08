//! The JavaScript primitives the engine's text and numbers depend on, with JavaScript's results (docs/rust-portierung.en.md,
//! R8.2): regular expressions (`JsRegex`: the source and flags of a JS literal, translated to `regex`; indices in UTF-16
//! code units, scans, `replace` and `split` as the ECMAScript algorithms do them), `localeCompare` (ICU root collation;
//! the engine's German order is the same), `Math.round`, the UTF-16 length and slices. `tests/primitives.rs` holds them
//! against the frozen TypeScript engine.
//!
//! The translation: `\d`, `\w`, `\b` are ASCII as in JS, `\s` is JS's set, `.` stops at the four JS line terminators
//! (unless `s`). With `i` and `u` the case folding is `regex`'s simple Unicode folding, as in JS; with `i` alone JS
//! compares `toUpperCase` of single code units (never a non-ASCII letter with an ASCII one: `ſ` is not `s`, `ß` is not
//! `ẞ`), so every literal and every class member is spelled out as the set of letters JS takes for it. Not translated
//! (an error): lookaround, backreferences, named groups. Known difference: without `u` JS sees a character above the
//! basic plane as two code units (`.` matches half of it); the Rust side always sees one character.
use std::cmp::Ordering;
use std::collections::{BTreeSet, HashMap};
use std::sync::OnceLock;

use icu_collator::{options::CollatorOptions, Collator, CollatorBorrowed};

// ---------------------------------------------------------------- numbers

/// `Math.round`: halves go up (−2.5 to −2), −0 stays, so does a result in (−0.5, 0).
pub fn round(x: f64) -> f64 {
	if !x.is_finite() { return x; }
	let f = x.floor();
	let r = if x - f >= 0.5 { f + 1.0 } else { f };
	if r == 0.0 && (x < 0.0 || (x == 0.0 && x.is_sign_negative())) { -0.0 } else { r }
}

/// `String(n)` for any number (NaN, ±Infinity, −0 as `"0"`).
pub fn number_text(n: f64) -> String {
	if n.is_nan() { "NaN".into() } else if n.is_infinite() { if n > 0.0 { "Infinity".into() } else { "-Infinity".into() } } else { phi_json::number_text(n) }
}

/// `Number(s)` of a string (ECMAScript StringToNumber): JS's blanks trimmed, "" is 0, `Infinity` with a sign, `0x`,
/// `0o`, `0b` integers without one, else a decimal literal; anything else NaN (`inf`, `nan`, `1_000`, `5e`).
pub fn to_number(s: &str) -> f64 {
	let t = s.trim_matches(is_js_space);
	if t.is_empty() { return 0.0; }
	match t { "Infinity" | "+Infinity" => return f64::INFINITY, "-Infinity" => return f64::NEG_INFINITY, _ => {} }
	let b = t.as_bytes();
	if b.len() > 2 && b[0] == b'0' {
		let radix = match b[1] { b'x' | b'X' => 16, b'o' | b'O' => 8, b'b' | b'B' => 2, _ => 0 };
		if radix > 0 {
			let digits = &t[2..];
			if digits.chars().all(|c| c.is_digit(radix)) { return digits.chars().fold(0.0, |n, c| n * radix as f64 + c.to_digit(radix).unwrap() as f64); }
			return f64::NAN;
		}
	}
	// [+-] (digits [. digits?] | . digits) ([eE] [+-] digits)?
	let mut i = 0;
	if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
	let int = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
	i += int;
	let mut frac = 0;
	if i < b.len() && b[i] == b'.' { i += 1; frac = b[i..].iter().take_while(|c| c.is_ascii_digit()).count(); i += frac; }
	if int == 0 && frac == 0 { return f64::NAN; }
	if i < b.len() && (b[i] == b'e' || b[i] == b'E') {
		i += 1;
		if i < b.len() && (b[i] == b'+' || b[i] == b'-') { i += 1; }
		let e = b[i..].iter().take_while(|c| c.is_ascii_digit()).count();
		if e == 0 { return f64::NAN; }
		i += e;
	}
	if i != b.len() { return f64::NAN; }
	t.parse().unwrap_or(f64::NAN)
}

/// JS's `\s` and what `trim` strips: blanks and line terminators.
pub fn is_js_space(c: char) -> bool {
	matches!(c, '\t' | '\n' | '\u{B}' | '\u{C}' | '\r' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

/// `s.trim()`.
pub fn trim(s: &str) -> &str { s.trim_matches(is_js_space) }

// ---------------------------------------------------------------- strings

/// `s.length`.
pub fn len16(s: &str) -> usize { s.chars().map(char::len_utf16).sum() }

/// The byte offset of UTF-16 offset `i` (clamped to the end; inside a pair it is the pair's start).
pub fn byte_at16(s: &str, i: usize) -> usize {
	let mut n = 0;
	for (b, c) in s.char_indices() {
		if n >= i { return b; }
		n += c.len_utf16();
		if n > i { return b; }
	}
	s.len()
}

/// The UTF-16 offset of byte offset `b`.
pub fn index16(s: &str, b: usize) -> usize { len16(&s[..b]) }

/// `s.slice(start, end)` with JS's negative and clamped indices (UTF-16 units; a cut through a pair keeps the whole pair
/// out, as Rust strings cannot hold half of one).
pub fn slice16(s: &str, start: isize, end: Option<isize>) -> &str {
	let len = len16(s) as isize;
	let at = |i: isize| if i < 0 { (len + i).max(0) } else { i.min(len) } as usize;
	let (a, e) = (at(start), end.map_or(len as usize, at));
	if a >= e { return ""; }
	&s[byte_at16(s, a)..byte_at16(s, e)]
}

/// `s.toLowerCase()` (full mappings, final sigma).
pub fn lower(s: &str) -> String { s.to_lowercase() }
/// `s.toUpperCase()` (full mappings: `ß` is `SS`).
pub fn upper(s: &str) -> String { s.to_uppercase() }

/// `s.normalize("NFKD")`.
pub fn nfkd(s: &str) -> String { unicode_normalization::UnicodeNormalization::nfkd(s).collect() }

fn collator() -> &'static CollatorBorrowed<'static> {
	static C: OnceLock<CollatorBorrowed<'static>> = OnceLock::new();
	C.get_or_init(|| Collator::try_new(Default::default(), CollatorOptions::default()).expect("the root collation"))
}

/// `a.localeCompare(b)` and `a.localeCompare(b, "de")`: ICU's root collation, tertiary strength (the same order for
/// German).
pub fn locale_compare(a: &str, b: &str) -> Ordering { collator().compare(a, b) }

// ---------------------------------------------------------------- regular expressions

/// A JavaScript regular expression.
#[derive(Clone, Debug)]
pub struct JsRegex {
	re: regex::Regex,
	pub source: String,
	pub flags: String,
	global: bool,
	unicode: bool,
}

/// One match: its UTF-16 index, its byte range and the groups (group 0 the whole match; `None` for a group that took no
/// part), as byte ranges of the subject.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct JsMatch {
	pub index16: usize,
	pub start: usize,
	pub end: usize,
	pub groups: Vec<Option<(usize, usize)>>,
}

impl JsMatch {
	/// Group `i`'s text in `s`.
	pub fn group<'s>(&self, s: &'s str, i: usize) -> Option<&'s str> { self.groups.get(i).copied().flatten().map(|(a, b)| &s[a..b]) }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RegexError(pub String);

impl std::fmt::Display for RegexError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(&self.0) }
}

impl JsRegex {
	/// The literal `/source/flags`.
	pub fn new(source: &str, flags: &str) -> Result<Self, RegexError> {
		let pattern = REWRITES.iter().find(|(js, _)| *js == source).map_or(source, |(_, same)| same);
		let translated = translate(pattern, flags)?;
		let re = regex::Regex::new(&translated).map_err(|e| RegexError(format!("/{source}/{flags} as {translated}: {e}")))?;
		Ok(Self { re, source: source.into(), flags: flags.into(), global: flags.contains('g'), unicode: flags.contains('u') })
	}

	pub fn is_global(&self) -> bool { self.global }

	/// The first match at or after byte offset `at`.
	pub fn exec_at(&self, s: &str, at: usize) -> Option<JsMatch> {
		let c = self.re.captures_at(s, at)?;
		let m = c.get(0).expect("group 0");
		Some(JsMatch { index16: index16(s, m.start()), start: m.start(), end: m.end(), groups: (0..c.len()).map(|i| c.get(i).map(|g| (g.start(), g.end()))).collect() })
	}

	/// `re.exec(s)` of a regex whose lastIndex is 0 (and `s.match(re)` without `g`).
	pub fn exec(&self, s: &str) -> Option<JsMatch> { self.exec_at(s, 0) }

	/// `re.test(s)` with lastIndex 0.
	pub fn test(&self, s: &str) -> bool { self.re.is_match(s) }

	/// Where a scan goes on after an empty match at byte `at`: one code point (with or without `u`; see the module text).
	fn advance(&self, s: &str, at: usize) -> usize { let _ = self.unicode; s[at..].chars().next().map_or(at + 1, |c| at + c.len_utf8()) }

	/// `s.matchAll(re)` (and `s.match(re)` with `g`): from lastIndex 0, past an empty match by one character.
	pub fn match_all(&self, s: &str) -> Vec<JsMatch> {
		let mut out = Vec::new();
		let mut at = 0;
		while at <= s.len() {
			let Some(m) = self.exec_at(s, at) else { break };
			at = if m.end == m.start { self.advance(s, m.end) } else { m.end };
			out.push(m);
		}
		out
	}

	/// `s.replace(re, f)`: every match with `g`, else the first; `f` gives the replacement.
	pub fn replace_with(&self, s: &str, mut f: impl FnMut(&str, &JsMatch) -> String) -> String {
		let ms = if self.global { self.match_all(s) } else { self.exec(s).into_iter().collect() };
		let mut out = String::with_capacity(s.len());
		let mut last = 0;
		for m in &ms {
			out.push_str(&s[last..m.start]);
			out.push_str(&f(s, m));
			last = m.end;
		}
		out.push_str(&s[last..]);
		out
	}

	/// `s.replace(re, replacement)` with JS's `$$`, `$&`, `` $` ``, `$'`, `$n` and `$nn`.
	pub fn replace(&self, s: &str, replacement: &str) -> String { self.replace_with(s, |s, m| expand(replacement, s, m)) }

	/// `s.split(re)`: the pieces between matches and the groups of each (`None` for a group that took no part), as the
	/// ECMAScript algorithm does it (no piece for an empty match at the end of the last one, none at the end of `s`).
	pub fn split<'s>(&self, s: &'s str) -> Vec<Option<&'s str>> {
		if s.is_empty() { return if self.exec(s).is_some() { vec![] } else { vec![Some(s)] }; }
		// the spec tries a sticky match at every q from p on; the leftmost match at or after q is the first q where one
		// holds, and the same match
		let (mut out, mut p, mut q) = (Vec::new(), 0usize, 0usize);
		while q < s.len() {
			let Some(m) = self.exec_at(s, q) else { break };
			if m.start >= s.len() { break; }
			q = m.start;
			if m.end == p { q = self.advance(s, q); continue; }
			out.push(Some(&s[p..q]));
			for g in &m.groups[1..] { out.push(g.map(|(a, b)| &s[a..b])); }
			p = m.end;
			q = p;
		}
		out.push(Some(&s[p..]));
		out
	}
}

/// The replacement text of `$…` patterns for one match.
fn expand(rep: &str, s: &str, m: &JsMatch) -> String {
	let (b, n) = (rep.as_bytes(), m.groups.len() - 1);
	let mut out = String::new();
	let mut i = 0;
	while i < b.len() {
		if b[i] == b'$' && i + 1 < b.len() {
			match b[i + 1] {
				b'$' => { out.push('$'); i += 2; continue; }
				b'&' => { out.push_str(&s[m.start..m.end]); i += 2; continue; }
				b'`' => { out.push_str(&s[..m.start]); i += 2; continue; }
				b'\'' => { out.push_str(&s[m.end..]); i += 2; continue; }
				d1 @ b'0'..=b'9' => {
					let one = (d1 - b'0') as usize;
					if i + 2 < b.len() && b[i + 2].is_ascii_digit() {
						let two = one * 10 + (b[i + 2] - b'0') as usize;
						if two >= 1 && two <= n { out.push_str(m.group(s, two).unwrap_or("")); i += 3; continue; }
					}
					if one >= 1 && one <= n { out.push_str(m.group(s, one).unwrap_or("")); i += 2; continue; }
				}
				_ => {}
			}
		}
		let c = rep[i..].chars().next().expect("a char");
		out.push(c);
		i += c.len_utf8();
	}
	out
}

/// The engine's patterns `regex` cannot take as they are, each with one that matches the same strings the same way:
/// `translate.ts` GREETED forbids a word character right after the greeting with a lookahead; of what may follow, only
/// the branch with the addressed name could start with one, so that branch starts with a blank or a comma instead.
const REWRITES: &[(&str, &str)] = &[(
	r"^(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))(?![\p{L}\p{N}_-])(?:\s*[.!?]*|\s*,?\s*[\p{L}\p{N}_-]+\s*(?:[.!?]*|[,:]\s*\S.*))$",
	r"^(?:hallo|hi|hey|moin|servus|hello|guten (?:tag|morgen|abend))(?:\s*[.!?]*|(?:\s+,?\s*|,\s*)[\p{L}\p{N}_-]+\s*(?:[.!?]*|[,:]\s*\S.*))$",
)];

/// JS's `\s`.
const SPACE: &str = r"\t\n\x0B\x0C\r \xA0\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// What JS compares a code unit as under `i` without `u` (ECMAScript Canonicalize): its `toUpperCase` when that is one
/// code unit and not an ASCII one for a non-ASCII letter.
fn canonicalize(c: char) -> char {
	if (c as u32) > 0xFFFF { return c; }
	let mut u = c.to_uppercase();
	match (u.next(), u.next()) {
		(Some(x), None) if (x as u32) <= 0xFFFF && !((c as u32) >= 128 && (x as u32) < 128) => x,
		_ => c,
	}
}

/// Every code unit JS takes for `c` under `i` without `u`.
fn case_set(c: char) -> &'static [char] {
	static T: OnceLock<HashMap<char, Vec<char>>> = OnceLock::new();
	let t = T.get_or_init(|| {
		let mut t: HashMap<char, Vec<char>> = HashMap::new();
		for u in 0u32..=0xFFFF { if let Some(c) = char::from_u32(u) { t.entry(canonicalize(c)).or_default().push(c); } }
		t
	});
	t.get(&canonicalize(c)).map_or(&[], Vec::as_slice)
}

fn class_char(c: char, out: &mut String) {
	if c.is_ascii_alphanumeric() { out.push(c); } else { out.push_str(&format!("\\x{{{:X}}}", c as u32)); }
}

/// A set of characters as the inside of a Rust class.
fn class_of(set: &BTreeSet<char>, out: &mut String) {
	let v: Vec<char> = set.iter().copied().collect();
	let mut i = 0;
	while i < v.len() {
		let mut j = i;
		while j + 1 < v.len() && (v[j + 1] as u32) == (v[j] as u32) + 1 { j += 1; }
		class_char(v[i], out);
		if j > i { out.push('-'); class_char(v[j], out); }
		i = j + 1;
	}
}

/// One item of a JS class: a character, a range, or a class escape already in Rust form.
enum Item { Char(char), Range(char, char), Class(String) }

struct Translator<'a> { p: Vec<char>, i: usize, fold: bool, unicode: bool, dotall: bool, src: &'a str }

/// The Rust form of the JS pattern `source` with `flags`.
pub fn translate(source: &str, flags: &str) -> Result<String, RegexError> {
	let mut t = Translator { p: source.chars().collect(), i: 0, fold: flags.contains('i') && !flags.contains('u'), unicode: flags.contains('u'), dotall: flags.contains('s'), src: source };
	let mut out = String::new();
	if flags.contains('i') && t.unicode { out.push_str("(?i)"); }
	if flags.contains('m') { return Err(t.err("the m flag")); }
	while t.i < t.p.len() { t.atom(&mut out)?; }
	Ok(out)
}

impl Translator<'_> {
	fn err(&self, what: &str) -> RegexError { RegexError(format!("/{}/: {what} has no translation", self.src)) }

	fn peek(&self, k: usize) -> Option<char> { self.p.get(self.i + k).copied() }

	fn literal(&self, c: char, out: &mut String) {
		if self.fold {
			let set = case_set(c);
			if set.len() > 1 { out.push('['); class_of(&set.iter().copied().collect(), out); out.push(']'); return; }
		}
		let mut buf = [0u8; 4];
		out.push_str(&regex::escape(c.encode_utf8(&mut buf)));
	}

	/// `\…` outside a class; `self.i` at the backslash.
	fn escape(&mut self, out: &mut String) -> Result<(), RegexError> {
		let c = self.peek(1).ok_or_else(|| self.err("a trailing backslash"))?;
		self.i += 2;
		match c {
			'd' => out.push_str("[0-9]"),
			'D' => out.push_str("[^0-9]"),
			'w' => out.push_str("[A-Za-z0-9_]"),
			'W' => out.push_str("[^A-Za-z0-9_]"),
			's' => { out.push('['); out.push_str(SPACE); out.push(']'); }
			'S' => { out.push_str("[^"); out.push_str(SPACE); out.push(']'); }
			'b' => out.push_str(r"(?-u:\b)"),
			'B' => out.push_str(r"(?-u:\B)"),
			'p' | 'P' if self.unicode => { let p = self.property(c)?; out.push_str(&p); }
			'1'..='9' | 'k' => return Err(self.err("a backreference")),
			_ => { self.i -= 2; let ch = self.escaped_char()?; self.literal(ch, out); }
		}
		Ok(())
	}

	/// `\p{…}` / `\P{…}`; `self.i` after the letter.
	fn property(&mut self, c: char) -> Result<String, RegexError> {
		if self.peek(0) != Some('{') { return Err(self.err("a \\p without braces")); }
		let end = self.p[self.i..].iter().position(|&x| x == '}').ok_or_else(|| self.err("an open \\p{"))? + self.i;
		let name: String = self.p[self.i + 1..end].iter().collect();
		self.i = end + 1;
		Ok(format!("\\{c}{{{name}}}"))
	}

	/// A character escape (`\n`, `\x41`, `\u00e4`, `\u{1F600}`, `\cJ`, an identity escape); `self.i` at the backslash.
	fn escaped_char(&mut self) -> Result<char, RegexError> {
		let c = self.peek(1).ok_or_else(|| self.err("a trailing backslash"))?;
		self.i += 2;
		let hex = |t: &mut Self, n: usize| -> Option<u32> {
			let s: String = t.p.get(t.i..t.i + n)?.iter().collect();
			let v = u32::from_str_radix(&s, 16).ok()?;
			t.i += n;
			Some(v)
		};
		Ok(match c {
			'n' => '\n', 'r' => '\r', 't' => '\t', 'v' => '\u{B}', 'f' => '\u{C}',
			'0' if !self.peek(0).is_some_and(|d| d.is_ascii_digit()) => '\0',
			'c' => { let l = self.peek(0).filter(char::is_ascii_alphabetic).ok_or_else(|| self.err("\\c"))?; self.i += 1; char::from_u32(l as u32 % 32).expect("control") }
			'x' => char::from_u32(hex(self, 2).ok_or_else(|| self.err("\\x"))?).expect("byte"),
			'u' if self.unicode && self.peek(0) == Some('{') => {
				let end = self.p[self.i..].iter().position(|&x| x == '}').ok_or_else(|| self.err("\\u{"))? + self.i;
				let s: String = self.p[self.i + 1..end].iter().collect();
				self.i = end + 1;
				char::from_u32(u32::from_str_radix(&s, 16).map_err(|_| self.err("\\u{"))?).ok_or_else(|| self.err("\\u{"))?
			}
			'u' => {
				let hi = hex(self, 4).ok_or_else(|| self.err("\\u"))?;
				if (0xD800..0xDC00).contains(&hi) && self.peek(0) == Some('\\') && self.peek(1) == Some('u') {
					let save = self.i;
					self.i += 2;
					match hex(self, 4) {
						Some(lo) if (0xDC00..0xE000).contains(&lo) => return char::from_u32(0x10000 + ((hi - 0xD800) << 10) + (lo - 0xDC00)).ok_or_else(|| self.err("a pair")),
						_ => self.i = save,
					}
				}
				char::from_u32(hi).ok_or_else(|| self.err("a lone surrogate"))?
			}
			other => other,
		})
	}

	fn atom(&mut self, out: &mut String) -> Result<(), RegexError> {
		let c = self.p[self.i];
		match c {
			'\\' => self.escape(out)?,
			'[' => self.class(out)?,
			'.' => { self.i += 1; out.push_str(if self.dotall { "(?s:.)" } else { r"[^\n\r\x{2028}\x{2029}]" }); }
			'(' => {
				if self.peek(1) == Some('?') {
					match self.peek(2) {
						Some(':') => { out.push_str("(?:"); self.i += 3; }
						Some('=' | '!') => return Err(self.err("a lookahead")),
						Some('<') => return Err(self.err(if matches!(self.peek(3), Some('=' | '!')) { "a lookbehind" } else { "a named group" })),
						_ => return Err(self.err("a group form")),
					}
				} else { out.push('('); self.i += 1; }
			}
			'{' => {
				// a quantifier {n}, {n,}, {n,m}; else a literal brace
				let rest: String = self.p[self.i..].iter().take_while(|&&x| x != '}').collect();
				let body = &rest[1..];
				let quant = self.p.get(self.i + rest.chars().count()) == Some(&'}') && !body.is_empty() && {
					let mut parts = body.splitn(2, ',');
					let a = parts.next().unwrap_or("");
					!a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()) && parts.next().is_none_or(|b| b.bytes().all(|x| x.is_ascii_digit()))
				};
				if quant { out.push_str(&rest); out.push('}'); self.i += rest.chars().count() + 1; } else { out.push_str(r"\{"); self.i += 1; }
			}
			'}' => { out.push_str(r"\}"); self.i += 1; }
			')' | '|' | '^' | '$' | '*' | '+' | '?' => { out.push(c); self.i += 1; }
			_ => { self.literal(c, out); self.i += 1; }
		}
		Ok(())
	}

	/// `[…]`; `self.i` at the bracket.
	fn class(&mut self, out: &mut String) -> Result<(), RegexError> {
		self.i += 1;
		let neg = self.peek(0) == Some('^');
		if neg { self.i += 1; }
		let mut items: Vec<Item> = Vec::new();
		loop {
			let c = self.peek(0).ok_or_else(|| self.err("an open class"))?;
			if c == ']' { self.i += 1; break; }
			let item = self.class_atom()?;
			// a range a-b (a dash first, last or next to a class escape is itself)
			if let Item::Char(a) = item {
				if self.peek(0) == Some('-') && self.peek(1).is_some_and(|x| x != ']') {
					let save = self.i;
					self.i += 1;
					match self.class_atom()? {
						Item::Char(b) => { if b < a { return Err(self.err("a range out of order")); } items.push(Item::Range(a, b)); continue; }
						_ => { self.i = save; }
					}
				}
			}
			items.push(item);
		}
		if items.is_empty() { out.push_str(if neg { "(?s:.)" } else { r"[^\x{0}-\x{10FFFF}]" }); return Ok(()); }
		out.push('[');
		if neg { out.push('^'); }
		let mut set = BTreeSet::new();
		for it in &items {
			match it {
				Item::Char(c) => { if self.fold { set.extend(case_set(*c).iter().copied()); } set.insert(*c); }
				Item::Range(a, b) => for u in *a as u32..=*b as u32 {
					if let Some(c) = char::from_u32(u) { if self.fold { set.extend(case_set(c).iter().copied()); } set.insert(c); }
				},
				Item::Class(k) => out.push_str(k),
			}
		}
		class_of(&set, out);
		out.push(']');
		Ok(())
	}

	fn class_atom(&mut self) -> Result<Item, RegexError> {
		let c = self.p[self.i];
		if c != '\\' { self.i += 1; return Ok(Item::Char(c)); }
		let e = self.peek(1).ok_or_else(|| self.err("a trailing backslash"))?;
		let k = |s: &str| Item::Class(s.to_owned());
		Ok(match e {
			'd' => { self.i += 2; k("[0-9]") }
			'D' => { self.i += 2; k("[^0-9]") }
			'w' => { self.i += 2; k("[A-Za-z0-9_]") }
			'W' => { self.i += 2; k("[^A-Za-z0-9_]") }
			's' => { self.i += 2; Item::Class(format!("[{SPACE}]")) }
			'S' => { self.i += 2; Item::Class(format!("[^{SPACE}]")) }
			'b' => { self.i += 2; Item::Char('\u{8}') }
			'p' | 'P' if self.unicode => { self.i += 2; Item::Class(self.property(e)?) }
			_ => Item::Char(self.escaped_char()?),
		})
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn rounds_as_js() {
		for (x, r) in [(2.5, 3.0), (-2.5, -2.0), (0.49999999999999994, 0.0), (-0.5, -0.0), (1.5, 2.0), (-1.5, -1.0)] {
			let got = round(x);
			assert!(got == r && got.is_sign_negative() == r.is_sign_negative(), "{x} -> {got}");
		}
	}

	#[test]
	fn case_without_u() {
		let r = JsRegex::new("^stra(ß|ss)e$", "i").unwrap();
		assert!(r.test("STRASSE") && r.test("Straße") && !r.test("STRAẞE"));
		assert!(!JsRegex::new("s", "i").unwrap().test("ſ"));
		assert!(JsRegex::new("s", "iu").unwrap().test("ſ"));
	}

	#[test]
	fn utf16() {
		assert_eq!(len16("a😀b"), 4);
		assert_eq!(slice16("Hallo Welt", 0, Some(5)), "Hallo");
		assert_eq!(slice16("Hallo", -2, None), "lo");
		let m = JsRegex::new("b", "").unwrap().exec("😀b").unwrap();
		assert_eq!(m.index16, 2);
	}

	#[test]
	fn replace_and_split() {
		let r = JsRegex::new(r"\s+", "g").unwrap();
		assert_eq!(r.replace("a  b c", "_"), "a_b_c");
		assert_eq!(JsRegex::new("(o)", "").unwrap().replace("foo", "[$1$&$$]"), "f[oo$]o");
		let s: Vec<_> = JsRegex::new(",", "").unwrap().split("a,b,,c").into_iter().map(Option::unwrap).collect();
		assert_eq!(s, ["a", "b", "", "c"]);
		let s: Vec<_> = JsRegex::new("", "").unwrap().split("abc").into_iter().map(Option::unwrap).collect();
		assert_eq!(s, ["a", "b", "c"]);
	}
}
