//! Lock strings (`server/engine/locks.ts`, Evennia's locks): `access:expr;access:expr`, an expression of `all()`,
//! `none()`, `guest()`, `perm(Level)`, `id(charId)`, `holds(key)` with `and`, `or`, `not` and parentheses.
use crate::js::JsRegex;

/// Permission levels, lowest first.
pub const LEVELS: [&str; 4] = ["Guest", "Player", "Builder", "Admin"];

/// `levelIndex`: -1 for no level.
pub fn level_index(l: &str) -> i32 { LEVELS.iter().position(|x| x.to_lowercase() == l.to_lowercase()).map_or(-1, |i| i as i32) }

/// What a lock asks about the one who tries.
pub struct LockCtx<'a> { pub level: &'a str, pub guest: bool, pub char_id: &'a str, pub holds: &'a dyn Fn(&str) -> bool }

#[derive(Debug, Clone)]
pub enum Node { Or(Box<Node>, Box<Node>), And(Box<Node>, Box<Node>), Not(Box<Node>), Fn(String, String) }

const FUNCS: [(&str, u8); 6] = [("all", 0), ("none", 0), ("guest", 0), ("perm", 1), ("id", 1), ("holds", 1)];
const MAX_LOCK: usize = 500;

fn tokens(src: &str) -> Vec<String> {
	thread_local! { static T: JsRegex = JsRegex::new(r"\(|\)|[A-Za-z_][\w-]*|[^\s()]+", "g").expect("the token pattern"); }
	T.with(|t| t.match_all(src).iter().map(|m| src[m.start..m.end].to_owned()).collect())
}

struct Parser { t: Vec<String>, i: usize }

impl Parser {
	fn peek(&self) -> Option<String> { self.t.get(self.i).map(|x| x.to_lowercase()) }
	fn next(&mut self) -> Option<String> { let v = self.t.get(self.i).cloned(); self.i += 1; v }
	fn or(&mut self) -> Result<Node, String> { let mut a = self.and()?; while self.peek().as_deref() == Some("or") { self.next(); a = Node::Or(Box::new(a), Box::new(self.and()?)); } Ok(a) }
	fn and(&mut self) -> Result<Node, String> { let mut a = self.not()?; while self.peek().as_deref() == Some("and") { self.next(); a = Node::And(Box::new(a), Box::new(self.not()?)); } Ok(a) }
	fn not(&mut self) -> Result<Node, String> { if self.peek().as_deref() == Some("not") { self.next(); Ok(Node::Not(Box::new(self.not()?))) } else { self.atom() } }
	fn atom(&mut self) -> Result<Node, String> {
		let Some(t) = self.next() else { return Err("Ausdruck endet zu früh".into()) };
		if t == "(" { let e = self.or()?; if self.next().as_deref() != Some(")") { return Err("„)“ fehlt".into()); } return Ok(e); }
		let lower = t.to_lowercase();
		let Some((_, args)) = FUNCS.iter().find(|(k, _)| *k == lower) else {
			return Err(format!("unbekannte Funktion „{}“ (erlaubt: {})", crate::js::slice16(&t, 0, Some(20)), FUNCS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")));
		};
		if self.next().as_deref() != Some("(") { return Err(format!("„(“ fehlt nach {t}")); }
		let mut arg = String::new();
		if self.peek().as_deref() != Some(")") { arg = self.next().unwrap_or_default(); }
		if self.next().as_deref() != Some(")") { return Err(format!("{t}() nimmt {}", if *args == 1 { "ein Argument" } else { "keine Argumente" })); }
		if *args == 1 && arg.is_empty() { return Err(format!("{t}() braucht ein Argument")); }
		if *args == 0 && !arg.is_empty() { return Err(format!("{t}() nimmt keine Argumente")); }
		if lower == "perm" && level_index(&arg) < 0 { return Err(format!("perm(): eine dieser Stufen: {}", LEVELS.join(", "))); }
		Ok(Node::Fn(lower, arg))
	}
}

fn parse_expr(src: &str) -> Result<Node, String> {
	let mut p = Parser { t: tokens(src), i: 0 };
	let e = p.or()?;
	if p.i < p.t.len() { return Err(format!("unerwartet: „{}“", crate::js::slice16(&p.t[p.i], 0, Some(20)))); }
	Ok(e)
}

/// `parseLocks`: access type → expression, in the order given (a repeated access keeps its first place, the last
/// expression); a `LockError` text when it does not parse.
pub fn parse_locks(s: &str) -> Result<Vec<(String, Node)>, String> {
	if crate::js::len16(s) > MAX_LOCK { return Err(format!("höchstens {MAX_LOCK} Zeichen")); }
	let mut out: Vec<(String, Node)> = Vec::new();
	for part in s.split(';').map(crate::js::trim).filter(|p| !p.is_empty()) {
		let colon = part.find(':');
		let access = colon.map_or_else(String::new, |c| crate::js::trim(&part[..c]).to_lowercase());
		let ok = colon.is_some_and(|c| c > 0) && !access.is_empty() && access.len() <= 20 && access.bytes().all(|b| b.is_ascii_lowercase());
		if !ok { return Err(format!("„{}“: erwartet zugriff:ausdruck", crate::js::slice16(part, 0, Some(30)))); }
		let node = parse_expr(&part[colon.unwrap() + 1..])?;
		match out.iter_mut().find(|(k, _)| *k == access) { Some(slot) => slot.1 = node, None => out.push((access, node)) }
	}
	Ok(out)
}

fn run(n: &Node, c: &LockCtx) -> bool {
	match n {
		Node::Or(a, b) => run(a, c) || run(b, c),
		Node::And(a, b) => run(a, c) && run(b, c),
		Node::Not(a) => !run(a, c),
		Node::Fn(name, arg) => match name.as_str() {
			"all" => true,
			"none" => false,
			"guest" => c.guest,
			"perm" => level_index(c.level) >= level_index(arg),
			"id" => c.char_id == arg,
			"holds" => (c.holds)(arg),
			_ => false,
		},
	}
}

/// `allowed`: whether `access` is granted; a lock string that does not parse denies.
pub fn allowed(locks: &str, access: &str, c: &LockCtx) -> bool {
	let Ok(parsed) = parse_locks(locks) else { return false };
	parsed.iter().find(|(k, _)| *k == access.to_lowercase()).is_none_or(|(_, n)| run(n, c))
}
