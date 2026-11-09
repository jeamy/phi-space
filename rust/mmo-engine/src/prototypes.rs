//! Prototypes (`server/engine/prototypes.ts`): a chain of parents folded into one, and spawning an item of one.
use phi_json::{Json, Object};

use crate::j;
use crate::source;
use crate::space::{tmpl, Result, Space, FOREVER};
use crate::typeclasses::draft_of;

/// The engine's default locks of an item: anyone may pick it up and drop it, only registered players give it away.
pub const DEFAULT_ITEM_LOCKS: &str = "get:all();drop:all();give:not guest()";
const MAX_DEPTH: usize = 10;

/// A chain, root first, folded into one: the child's own values win over its parents' (an empty string is no value).
fn fold(chain: &[Json]) -> Json {
	let mut acc = Object::new();
	for p in chain {
		for (k, v) in j::entries(p) {
			if v.as_str() == Some("") { continue; }
			acc.insert(k, v.clone());
		}
	}
	Json::Object(acc)
}

/// `resolveFrom`: a prototype of the list with its parents' fields filled in; None when it or a parent is missing (or a
/// cycle).
pub fn resolve_from(list: &[Json], key: &str) -> Option<Json> {
	let mut chain: Vec<Json> = Vec::new();
	let mut k = Some(key.to_owned());
	while let Some(cur) = k.filter(|x| !x.is_empty()) {
		if chain.iter().any(|p| j::s(p, "key") == cur) || chain.len() >= MAX_DEPTH { return None; }
		let p = j::by(list, "key", &cur)?;
		k = j::so(p, "parent").map(str::to_owned);
		chain.insert(0, p.clone());
	}
	Some(fold(&chain))
}

/// `resolvePrototype`: the same from the space.
pub async fn resolve_prototype(space: &Space, key: &str) -> Result<Option<Json>> {
	let mut chain: Vec<Json> = Vec::new();
	let mut k = Some(key.to_owned());
	while let Some(cur) = k.filter(|x| !x.is_empty()) {
		if chain.iter().any(|p| j::s(p, "key") == cur) || chain.len() >= MAX_DEPTH { return Ok(None); }
		let Some(e) = space.peek(&tmpl("Prototype", phi_json::obj! { "key" => cur.as_str() }), None).await? else { return Ok(None) };
		let p = crate::space::fields(&e).clone();
		k = j::so(&p, "parent").map(str::to_owned);
		chain.insert(0, p);
	}
	Ok(Some(fold(&chain)))
}

/// `newItemId`.
pub fn new_item_id() -> String { format!("i-{}", source::hex(&source::random_bytes(6))) }

/// Where a spawned item goes and how long it stays.
#[derive(Default)]
pub struct At {
	pub item_id: Option<String>,
	pub location: String,
	pub x: f64,
	pub y: f64,
	pub flotsam: bool,
	pub lease: Option<f64>,
	pub expires_world_ms: Option<f64>,
}

/// `spawn`: writes an item of prototype `p` under `txn`; `own`: what this thing has of its own instead of its
/// prototype's (an object of name, aliases, desc, glyph, variety, or null).
pub async fn spawn(space: &Space, txn: Option<&str>, w: &Json, p: &Json, at: At, own: &Json) -> Result<Json> {
	let mut item = Object::new();
	// a thing that spoils or grows up carries the moment it turns, on the second clock (sweep.ts turns it); what the loader
	// hands out before the world has its clock (an NPC's stock) keeps
	if let Some(turns) = j::opt(p, "turns").filter(|t| j::truthy(t)) {
		if let Ok(kept) = crate::clock::decay_now_of(space, txn).await {
			item.insert("turns", Json::Bool(true));
			item.insert("turnsAtMs", Json::from(kept + j::n(turns, "afterMs")));
		}
	}
	item.insert("itemId", Json::from(at.item_id.unwrap_or_else(new_item_id)));
	item.insert("name", j::at(p, "name").clone());
	item.insert("aliases", j::opt(p, "aliases").cloned().unwrap_or(Json::Array(vec![])));
	item.insert("desc", j::opt(p, "desc").cloned().unwrap_or(Json::from("")));
	item.insert("location", Json::from(at.location));
	item.insert("x", Json::from(at.x));
	item.insert("y", Json::from(at.y));
	if let Some(g) = p.get("glyph") { item.insert("glyph", g.clone()); }
	item.insert("locks", if j::b(p, "locks") { j::at(p, "locks").clone() } else { Json::from(DEFAULT_ITEM_LOCKS) });
	item.insert("proto", j::at(p, "key").clone());
	if at.flotsam { item.insert("flotsam", Json::Bool(true)); }
	if let Some(e) = at.expires_world_ms { item.insert("expiresWorldMs", Json::from(e)); }
	if j::b(p, "wear") { item.insert("wear", j::at(p, "wear").clone()); }
	for (k, v) in j::entries(own) { item.insert(k, v.clone()); }
	let item = Json::Object(item);
	let tc = if j::b(p, "typeclass") { j::s(p, "typeclass") } else { "Item" };
	space.write(&draft_of(tc, j::at(w, "typeclasses"), item.clone())?, txn, at.lease.unwrap_or(FOREVER)).await?;
	Ok(item)
}
