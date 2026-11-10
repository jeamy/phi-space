//! What a command runs with (`server/engine/context.ts`): the space and its transaction, the world, the actor, its
//! account; messages to rooms and players; looking up things by name.
use phi_json::{obj, Json, Object};

use crate::j;
use crate::source::{hex, random_bytes, time_now};
use crate::space::{Result, Space};

/// `CommandCtx`.
pub struct Ctx {
	pub space: Space,
	pub txn: String,
	pub world: std::rc::Rc<Json>,
	pub actor: Json,
	pub account: Option<Json>,
	/// The account is read when a lock asks (`loadAccount`; a step).
	pub load_account: bool,
	pub msg_lease_ms: f64,
	pub asked: Option<String>,
	pub lang: Option<String>,
	pub step: Option<Json>,
	/// The actor's inventory for this command (read once, outside the transaction).
	pub inventory: Option<Vec<Json>>,
	/// The other regions' spaces (`elsewhere`): one's chests there, one's deeds.
	pub elsewhere: Vec<(String, Space)>,
}

impl Ctx {
	pub fn txn(&self) -> Option<&str> { Some(self.txn.as_str()) }
	pub fn char_id(&self) -> &str { j::s(&self.actor, "charId") }
	pub fn room(&self) -> &str { j::s(&self.actor, "room") }
	pub fn w(&self) -> &Json { &self.world }
}

/// Who writes a message: the space, the transaction (None: at once), the actor, how long it stays, its language.
pub struct Sender<'a> { pub space: &'a Space, pub txn: Option<&'a str>, pub actor: &'a Json, pub msg_lease_ms: f64, pub lang: Option<&'a str> }

impl Ctx {
	pub fn sender(&self) -> Sender<'_> { Sender { space: &self.space, txn: Some(&self.txn), actor: &self.actor, msg_lease_ms: self.msg_lease_ms, lang: self.lang.as_deref() } }
}

/// Options of a message: `$you()`/`$conj()` rendered per reader, another room, the parts of `help`.
#[derive(Default)]
pub struct MsgOpts { pub templ: bool, pub room: Option<String>, pub help: Option<Json> }

/// `msgOptions`: whether a message is a transient write (only what nobody reads later is).
pub async fn msg_transient(space: &Space, to: &str, kind: &str) -> bool {
	if std::env::var("SPACES_MMO_MSG_TRANSIENT").as_deref() == Ok("0") || kind == "say" || to.starts_with('#') || to.starts_with("npc-") { return false; }
	space.supports("write.transient").await
}

/// How long a message to a player waits for it (real time).
pub const NOTICE_MS: f64 = 14.0 * 24.0 * 3_600_000.0;
/// Whether a message to `to` goes to one player.
pub fn to_one_player(to: &str) -> bool { to != "*" && !to.starts_with('#') && !to.starts_with("npc-") }

/// `toPlayer`: a message to one player as a Notice, kept 14 days.
pub async fn to_player(space: &Space, m: &Json, txn: Option<&str>) -> Result<()> {
	let mut n = j::object(m);
	n.insert("noticeId", Json::from(format!("n-{}", hex(&random_bytes(6)))));
	n.insert("charId", j::at(m, "to").clone());
	space.write(&obj! { "type" => "Notice", "fields" => Json::Object(n) }, txn, NOTICE_MS).await?;
	Ok(())
}

/// `msg`: a message from the actor in its room (or `o.room`).
pub async fn msg_from(c: &Sender<'_>, to: &str, kind: &str, text: &str, o: MsgOpts) -> Result<()> {
	let mut m = Object::new();
	m.insert("room", Json::from(o.room.unwrap_or_else(|| j::s(c.actor, "room").to_owned())));
	m.insert("to", Json::from(to));
	m.insert("kind", Json::from(kind));
	m.insert("text", Json::from(text));
	m.insert("from", j::at(c.actor, "name").clone());
	m.insert("fromId", j::at(c.actor, "charId").clone());
	m.insert("at", Json::from(time_now()));
	if let Some(l) = c.lang { m.insert("lang", Json::from(l)); }
	if o.templ { m.insert("actor", j::at(c.actor, "charId").clone()); }
	if let Some(h) = o.help { m.insert("help", h); }
	let m = Json::Object(m);
	if to != j::s(c.actor, "charId") && to_one_player(to) { return to_player(c.space, &m, c.txn).await; }
	let transient = msg_transient(c.space, to, kind).await;
	c.space.write_with(&obj! { "type" => "Msg", "fields" => m }, c.txn, c.msg_lease_ms, transient).await?;
	Ok(())
}

/// `msg(c, to, kind, text, o)` of a command.
pub async fn msg(c: &Ctx, to: &str, kind: &str, text: &str, o: MsgOpts) -> Result<()> { msg_from(&c.sender(), to, kind, text, o).await }

// ---------------------------------------------------------------- the actor, its things, names

/// `levelOf`: an admin has every level; `perms` adds Builder; a guest is a guest.
pub fn level_of(a: Option<&Json>) -> &'static str {
	let Some(a) = a else { return "Guest" };
	if j::b(a, "admin") { return "Admin"; }
	if j::a(a, "perms").iter().any(|p| p.as_str() == Some("Builder")) { return "Builder"; }
	if j::b(a, "guest") { "Guest" } else { "Player" }
}

/// `inventory`: what the actor carries (read once per command, outside the transaction).
pub async fn inventory(c: &mut Ctx) -> Result<Vec<Json>> {
	if c.inventory.is_none() {
		let items = c.space.read_all(&crate::space::tmpl("Item", obj! { "location" => c.char_id() }), None).await?;
		c.inventory = Some(items);
	}
	Ok(c.inventory.clone().unwrap_or_default())
}

/// The account when a lock asks (`loadAccount`, as the world worker's `one`: the snapshot, else a read that waits 2 s).
pub async fn ensure_account(c: &mut Ctx) -> Result<()> {
	if c.account.is_none() && c.load_account {
		c.load_account = false;
		let t = crate::space::tmpl("Account", obj! { "accountId" => j::at(&c.actor, "accountId").clone() });
		let e = match c.space.peek(&t, None).await? { Some(e) => Some(e), None => c.space.read_if_exists(&t, 2_000.0, None).await? };
		c.account = e.map(|e| crate::space::fields(&e).clone());
	}
	Ok(())
}

/// What `lockCtx` gives: the level, whether a guest, and what the actor carries.
pub struct Who { pub level: &'static str, pub guest: bool, pub char_id: String, pub inv: Vec<Json> }

impl Who {
	pub fn holds(&self, k: &str) -> bool { self.inv.iter().any(|i| { let f = crate::space::fields(i); j::s(f, "itemId") == k || j::s(f, "proto") == k }) }
	pub fn allowed(&self, locks: &str, access: &str) -> bool {
		let holds = |k: &str| self.holds(k);
		crate::locks::allowed(locks, access, &crate::locks::LockCtx { level: self.level, guest: self.guest, char_id: &self.char_id, holds: &holds })
	}
}

/// `lockCtx`.
pub async fn lock_ctx(c: &mut Ctx) -> Result<Who> {
	ensure_account(c).await?;
	let inv = inventory(c).await?;
	Ok(Who { level: level_of(c.account.as_ref()), guest: c.account.as_ref().is_none_or(|a| j::opt(a, "guest").is_none_or(j::truthy)), char_id: c.char_id().to_owned(), inv })
}

/// `check`: the actor passes `access` on `locks`, else a refusal.
pub async fn check(c: &mut Ctx, locks: &str, access: &str, refusal: &str) -> Result<()> {
	if !lock_ctx(c).await?.allowed(locks, access) { return crate::space::refuse(refusal); }
	Ok(())
}

/// `roomOf`.
pub async fn room_of(c: &Ctx, room_id: Option<&str>) -> Result<Json> {
	let id = room_id.unwrap_or(c.room());
	match c.space.peek(&crate::space::tmpl("Room", obj! { "roomId" => id }), None).await? { Some(r) => Ok(crate::space::fields(&r).clone()), None => crate::space::refuse("Dieser Ort ist verschwunden.") }
}

/// `typos`: edits between two words (a letter missing, added, changed, or two swapped), counted up to `max` + 1; on
/// UTF-16 code units as JavaScript indexes a string.
pub fn typos(a: &str, b: &str, max: f64) -> f64 {
	let (a, b): (Vec<u16>, Vec<u16>) = (a.encode_utf16().collect(), b.encode_utf16().collect());
	if (a.len() as f64 - b.len() as f64).abs() > max { return max + 1.0; }
	let mut prev2: Vec<usize> = Vec::new();
	let mut prev: Vec<usize> = (0..=b.len()).collect();
	for i in 1..=a.len() {
		let mut row = vec![i];
		for jj in 1..=b.len() {
			let mut d = (prev[jj] + 1).min(row[jj - 1] + 1).min(prev[jj - 1] + usize::from(a[i - 1] != b[jj - 1]));
			if i > 1 && jj > 1 && a[i - 1] == b[jj - 2] && a[i - 2] == b[jj - 1] { d = d.min(prev2[jj - 2] + 1); }
			row.push(d);
		}
		prev2 = prev;
		prev = row;
	}
	prev[b.len()] as f64
}

/// How many typos a word of this length may have and still mean a name.
fn tolerance(n: &str) -> f64 { let l = crate::js::len16(n); if l < 4 { 0.0 } else if l < 8 { 1.0 } else { 2.0 } }

/// `whereTo`: where an exit leads, as players know the place.
pub fn where_to(w: &Json, exit: &Json) -> String {
	j::by(j::a(w, "rooms"), "roomId", j::s(exit, "destination")).map_or_else(|| j::s(exit, "name").to_owned(), |r| j::s(r, "name").to_owned())
}

const PLURALS: [(&str, &str); 8] = [("Ei", "Eier"), ("Brot", "Brote"), ("Hund", "Hunde"), ("Netz", "Netze"), ("Stein", "Steine"), ("Tangseil", "Tangseile"), ("Tuch", "Tücher"), ("Kanne Wasser", "Kannen Wasser")];
const SAME: [&str; 6] = ["Wolle", "Gerste", "Käse", "Gehäuse", "Ziegel", "Holzbündel"];

/// `pluralOf`: a thing's name for several of it.
pub fn plural_of(name: &str, world: Option<&Json>) -> String {
	if let Some(p) = world.and_then(|w| j::a(j::at(w, "animals"), "kinds").iter().find(|k| j::s(k, "name") == name)).and_then(|k| j::so(k, "plural")) { return p.to_owned(); }
	if let Some((_, p)) = PLURALS.iter().find(|(k, _)| *k == name) { return (*p).to_owned(); }
	// the table is an object literal: "constructor" finds Object's (the oracle's text of it)
	if let Some(t) = crate::js::object_prototype_text(name) { return t.to_owned(); }
	if !SAME.contains(&name) && (name.ends_with('e') || name.ends_with("el")) { format!("{name}n") } else { name.to_owned() }
}

/// `stem`: a word without its German plural or case ending and with plain vowels.
pub fn stem(word: &str) -> String {
	thread_local! { static PIECES: crate::js::JsRegex = crate::js::JsRegex::new("^(.{3,}?)(?:stuckchen|stucke?n?|scheite?n?)$", "").expect("the pieces pattern"); }
	let w = word.to_lowercase().replace('ä', "a").replace('ö', "o").replace('ü', "u").replace('ß', "ss");
	// every ending of the pattern holds "stuck" or "scheit": without one it cannot match
	let mut w = if w.contains("stuck") || w.contains("scheit") { PIECES.with(|p| p.replace(&w, "$1")) } else { w };
	for end in ["ern", "er", "en", "e", "n", "s"] {
		if crate::js::len16(&w) as isize - end.len() as isize >= 3 && w.ends_with(end) { w.truncate(w.len() - end.len()); break; }
	}
	w
}

fn names_of(f: &Json) -> Vec<String> {
	let mut v = vec![j::s(f, "name").to_lowercase()];
	v.extend(j::a(f, "aliases").iter().filter_map(Json::as_str).map(crate::js::lower));
	v
}

/// `byName`: things named `name` (name or alias, case-insensitive; exact matches first, then prefixes, then another form
/// of the word, then a typo or two), nearest first. `list` holds taken entries; their fields are what is compared.
pub fn by_name(list: &[Json], name: &str, near: Option<(f64, f64)>) -> Vec<Json> {
	let n = crate::js::trim(name).to_lowercase();
	if n.is_empty() { return vec![]; }
	let names: Vec<Vec<String>> = list.iter().map(|e| names_of(crate::space::fields(e))).collect();
	let pick = |ok: &dyn Fn(&[String]) -> bool| -> Vec<usize> { (0..list.len()).filter(|&i| ok(&names[i])).collect() };
	let exact = pick(&|ns| ns.contains(&n));
	let prefix = if !exact.is_empty() { exact } else { pick(&|ns| ns.iter().any(|s| s.starts_with(&n))) };
	let sn = stem(&n);
	let stems: Vec<Vec<String>> = if prefix.is_empty() { names.iter().map(|ns| ns.iter().map(|s| stem(s)).collect()).collect() } else { vec![] };
	let forms: Vec<usize> = if !prefix.is_empty() { prefix } else { (0..list.len()).filter(|&i| stems[i].contains(&sn)).collect() };
	let st = if crate::js::len16(&sn) < 3 { 0.0 } else { 1f64.max(tolerance(&sn)) };
	let tn = tolerance(&n);
	let near1 = |s: &str, ss: &str| typos(&n, s, tn) <= tn || (st > 0.0 && typos(&sn, ss, st) <= st);
	let hits = if !forms.is_empty() || tn == 0.0 { forms } else { (0..list.len()).filter(|&i| names[i].iter().zip(&stems[i]).any(|(s, ss)| near1(s, ss))).collect() };
	let mut hits: Vec<Json> = hits.into_iter().map(|i| list[i].clone()).collect();
	if let Some((x, y)) = near {
		let d = |e: &Json| { let g = crate::space::fields(e); if g.get("x").is_some() { (j::number(j::at(g, "x")) - x).abs().max((j::number(j::at(g, "y")) - y).abs()) } else { 0.0 } };
		hits.sort_by(|a, b| d(a).partial_cmp(&d(b)).unwrap_or(std::cmp::Ordering::Equal));
	}
	hits
}

/// `itemsNamed`: as `byName`, except that a name which is exactly a thing of the world means that thing only.
pub fn items_named(world: &Json, list: &[Json], name: &str, near: Option<(f64, f64)>) -> Vec<Json> {
	let n = crate::js::trim(name).to_lowercase();
	let protos: Vec<&str> = j::a(world, "prototypes").iter().filter(|p| j::s(p, "key") == n || std::iter::once(j::s(p, "name")).chain(j::a(p, "aliases").iter().filter_map(Json::as_str)).any(|a| a.to_lowercase() == n)).map(|p| j::s(p, "key")).collect();
	let hits = by_name(list, name, near);
	if protos.is_empty() { return hits; }
	let named: Vec<Json> = hits.iter().filter(|e| { let f = crate::space::fields(e); protos.contains(&j::s(f, "proto")) || names_of(f).contains(&n) }).cloned().collect();
	if !named.is_empty() { named } else { list.iter().filter(|e| protos.contains(&j::s(crate::space::fields(e), "proto"))).cloned().collect() }
}

/// `itemsHere`.
pub async fn items_here(c: &Ctx) -> Result<Vec<Json>> { c.space.read_all(&crate::space::tmpl("Item", obj! { "location" => c.room() }), None).await }
/// `exitsHere`.
pub async fn exits_here(c: &Ctx, room_id: Option<&str>) -> Result<Vec<Json>> { c.space.read_all(&crate::space::tmpl("Exit", obj! { "location" => room_id.unwrap_or(c.room()) }), None).await }

/// `reach`: Chebyshev distance.
pub fn reach(a: &Json, b: &Json) -> f64 { (j::n(a, "x") - j::n(b, "x")).abs().max((j::n(a, "y") - j::n(b, "y")).abs()) }
