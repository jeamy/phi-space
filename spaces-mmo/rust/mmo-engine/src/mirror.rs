//! The copy of the world a command reads its snapshot from (`Mirror` of `server/space.ts`): `readAll` and `count` without
//! a transaction are answered here, from the entries as committed, instead of a call each to the space. An entry another
//! transaction holds right now is still in the copy (the space would hide it), so this is what the commands of the
//! frozen engine see in production.
//!
//! The copy follows the change stream in the background (`follow`, run by the world host), as the TypeScript one does;
//! `fresh()` pulls whatever changes it still lacks up to the space's revision itself (the same contract: the copy holds
//! at least what was committed when the command began), so a walk without `follow` stays deterministic.
use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use phi_json::{obj, Json};
use phi_spaces_client::{Error as SpaceError, RemoteSpace};

use crate::space::{Error, Result};

#[derive(Clone, PartialEq, Eq, Hash)]
enum ScalarKey { Str(String), Num(u64), Bool(bool) }

impl ScalarKey {
	fn from_json(v: &Json) -> Option<Self> {
		match v {
			Json::String(s) => Some(Self::Str(s.clone())),
			Json::Number(n) if !n.is_nan() => Some(Self::Num(if *n == 0.0 { 0.0f64.to_bits() } else { n.to_bits() })),
			Json::Bool(b) => Some(Self::Bool(*b)),
			_ => None,
		}
	}
}

#[derive(Default)]
struct Copy {
	by_id: HashMap<String, Json>,
	by_type: HashMap<String, HashSet<String>>,
	/// A type's ids in the order the space lists them, once a read asked for them; kept in step with every write since.
	sorted_type: HashMap<String, Vec<String>>,
	/// Per type and field the ids by the field's value (in the same order), once a read asked by that field.
	by_type_field: HashMap<String, HashMap<String, HashMap<ScalarKey, Vec<String>>>>,
	rev: f64,
	stream: String,
	ready: bool,
}

/// `id` into `ids`, which are in the order of `seq_of`: after its equals (a new entry's id counts up, so mostly last).
fn insert_sorted(ids: &mut Vec<String>, id: &str) {
	let seq = seq_of(id);
	let at = if ids.last().is_none_or(|l| seq_of(l) <= seq) { ids.len() } else { ids.partition_point(|x| seq_of(x) <= seq) };
	ids.insert(at, id.to_owned());
}
fn remove_id(ids: &mut Vec<String>, id: &str) { if let Some(at) = ids.iter().position(|x| x == id) { ids.remove(at); } }

impl Copy {
	/// The indexes a read built for `ty` follow the entry in (`add`) or out: a write no longer throws them away, which
	/// made the next read of the type sort and index all its entries again.
	fn index(&mut self, ty: &str, id: &str, e: &Json, add: bool) {
		if let Some(ids) = self.sorted_type.get_mut(ty) { if add { insert_sorted(ids, id) } else { remove_id(ids, id) } }
		let Some(by_field) = self.by_type_field.get_mut(ty) else { return };
		for (field, map) in by_field.iter_mut() {
			let Some(sk) = e.get("fields").and_then(|f| f.get(field)).and_then(ScalarKey::from_json) else { continue };
			if add { insert_sorted(map.entry(sk).or_default(), id); }
			else if let Some(ids) = map.get_mut(&sk) { remove_id(ids, id); if ids.is_empty() { map.remove(&sk); } }
		}
	}
	fn put(&mut self, e: Json) {
		let Some(id) = e.get("id").and_then(Json::as_str).map(str::to_owned) else { return };
		self.del(&id);
		for t in e.get("types").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) {
			// an entry that names a type twice is in its indexes once
			if self.by_type.entry(t.to_owned()).or_default().insert(id.clone()) { self.index(t, &id, &e, true); }
		}
		self.by_id.insert(id, e);
	}
	fn del(&mut self, id: &str) {
		let Some(e) = self.by_id.remove(id) else { return };
		for t in e.get("types").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) {
			if self.by_type.get_mut(t).is_some_and(|s| s.remove(id)) { self.index(t, id, &e, false); }
		}
	}
	fn ensure_sorted_type(&mut self, ty: &str) {
		if self.sorted_type.contains_key(ty) { return; }
		let mut ids: Vec<(f64, String)> = self.by_type.get(ty).into_iter().flatten().map(|id| (seq_of(id), id.clone())).collect();
		ids.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
		self.sorted_type.insert(ty.to_owned(), ids.into_iter().map(|(_, id)| id).collect());
	}
	fn ensure_type_field(&mut self, ty: &str, field: &str) {
		if self.by_type_field.get(ty).is_some_and(|m| m.contains_key(field)) { return; }
		self.ensure_sorted_type(ty);
		let ids = self.sorted_type.get(ty).map(Vec::as_slice).unwrap_or(&[]);
		let mut map: HashMap<ScalarKey, Vec<String>> = HashMap::new();
		for id in ids {
			if let Some(sk) = self.by_id.get(id).and_then(|e| e.get("fields")).and_then(|f| f.get(field)).and_then(ScalarKey::from_json) {
				map.entry(sk).or_default().push(id.clone());
			}
		}
		self.by_type_field.entry(ty.to_owned()).or_default().insert(field.to_owned(), map);
	}
	fn ids_by(&self, ty: &str, field: &str, sk: &ScalarKey) -> &[String] { self.by_type_field.get(ty).and_then(|m| m.get(field)).and_then(|m| m.get(sk)).map_or(&[], Vec::as_slice) }
}

/// The copy of one space.
pub struct Mirror { space: Rc<RemoteSpace>, copy: RefCell<Copy> }

/// `deepEqual` of the core: JSON values, objects by their keys whatever their order.
fn deep_equal(a: &Json, b: &Json) -> bool {
	match (a, b) {
		(Json::Object(x), Json::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w))),
		(Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(v, w)| deep_equal(v, w)),
		_ => a == b,
	}
}

/// `matches` of the core: the id, the type among the entry's types, every field that is not null deep-equal.
pub fn matches(t: &Json, e: &Json) -> bool {
	if t.is_null() { return true; }
	if let Some(id) = t.get("id").filter(|v| !v.is_null()) { if e.get("id") != Some(id) { return false; } }
	if let Some(ty) = t.get("type").filter(|v| !v.is_null()) {
		if !e.get("types").and_then(Json::as_array).is_some_and(|a| a.iter().any(|x| x == ty)) { return false; }
	}
	let ef = e.get("fields");
	t.get("fields").and_then(Json::as_object).into_iter().flat_map(|o| o.iter()).filter(|(_, v)| !v.is_null()).all(|(k, v)| ef.and_then(|f| f.get(k)).is_some_and(|w| deep_equal(v, w)))
}

/// The number an id ends in (its digits are ASCII, so the tail is cut at a character's edge).
fn seq_of(id: &str) -> f64 {
	let digits = &id[id.len() - id.bytes().rev().take_while(u8::is_ascii_digit).count()..];
	if digits.is_empty() { 0.0 } else { crate::js::to_number(digits) }
}

fn real_now() -> f64 { std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0.0, |d| d.as_secs_f64() * 1000.0) }

fn head_of(p: &Json) -> (f64, String) { (p.get("rev").and_then(Json::as_f64).unwrap_or(0.0), p.get("streamId").and_then(Json::as_str).unwrap_or("").to_owned()) }

impl Mirror {
	pub fn new(space: Rc<RemoteSpace>) -> Self { Self { space, copy: RefCell::new(Copy::default()) } }

	/// A new copy, page by page (without `gid`, as the change stream carries none).
	async fn copy_all(&self) -> Result<()> {
		let head = self.space.read_page(&obj! { "type" => "-" }, None, None, None, None, None).await?;
		let mut copy = Copy::default();
		let mut after: Option<String> = None;
		loop {
			let p = self.space.read_page(&Json::Null, None, after.as_deref(), None, None, None).await?;
			for e in p.get("items").and_then(Json::as_array).into_iter().flatten() {
				let mut o = e.as_object().cloned().unwrap_or_default();
				o.remove("gid");
				copy.put(Json::Object(o));
			}
			after = p.get("next").and_then(Json::as_str).map(str::to_owned);
			if after.is_none() { break; }
		}
		(copy.rev, copy.stream) = head_of(&head);
		copy.ready = true;
		*self.copy.borrow_mut() = copy;
		Ok(())
	}

	/// `fresh`: the copy holds at least what the space had committed when this was called.
	pub async fn fresh(&self) -> Result<()> {
		let (rev, stream) = head_of(&self.space.read_page(&obj! { "type" => "-" }, None, None, None, None, None).await?);
		let mut idle = 0;
		loop {
			let (ready, at, own) = { let c = self.copy.borrow(); (c.ready, c.rev, c.stream.clone()) };
			if ready && own == stream && at >= rev { return Ok(()); }
			if !ready || own != stream { self.copy_all().await?; continue; }
			let ch = match self.space.changes(at, None, Some(0.0), Some(&own)).await {
				Ok(ch) => ch,
				Err(e @ SpaceError::Remote { .. }) if matches!(e.code(), Some("SnapshotExpired" | "RevisionAhead")) => { self.copy.borrow_mut().ready = false; continue; }
				Err(e) => return Err(e.into()),
			};
			let next = self.apply(at, &own, &ch);
			if next.is_none_or(|n| n <= at) { idle += 1; if idle > 100 { return Err(Error::Other(format!("the copy of the world is behind (revision {at} of {rev})"))); } }
		}
	}

	/// The changes after `at` of stream `own`, applied when the copy still stands there (`fresh` and `follow` may both
	/// have asked); the revision they lead to, or None when the copy had moved on.
	fn apply(&self, at: f64, own: &str, ch: &Json) -> Option<f64> {
		let mut c = self.copy.borrow_mut();
		if !c.ready || c.rev != at || c.stream != own { return None; }
		// the space follows another stream (restarted) or dropped the history: copy everything again
		if ch.get("resync").is_some_and(|r| r.as_bool() == Some(true)) { c.ready = false; return None; }
		for b in ch.get("batches").and_then(Json::as_array).into_iter().flatten() {
			for op in b.get("ops").and_then(Json::as_array).into_iter().flatten() {
				if op.get("op").and_then(Json::as_str) == Some("del") { if let Some(id) = op.get("id").and_then(Json::as_str) { c.del(id); } continue; }
				if op.get("transient").is_some_and(|t| t.as_bool() == Some(true)) { continue; }
				let mut e = obj! { "id" => op.get("id").cloned().unwrap_or(Json::Null), "type" => op.get("type").cloned().unwrap_or(Json::Null), "types" => op.get("types").cloned().unwrap_or(Json::Null), "fields" => op.get("fields").cloned().unwrap_or(Json::Null), "owner" => op.get("owner").cloned().unwrap_or(Json::Null) };
				if let (Json::Object(o), Some(x)) = (&mut e, op.get("expires")) { o.insert("expires", x.clone()); }
				c.put(e);
			}
		}
		let next = ch.get("next").and_then(Json::as_f64).unwrap_or(at);
		c.rev = next;
		Some(next)
	}

	/// The copy following the change stream in the background, as the TypeScript one does, so `fresh` mostly finds it
	/// there already (the world host runs it; a walk does not, its `fresh` pulls). Ends when `halt` turns true.
	pub async fn follow(&self, mut halt: tokio::sync::watch::Receiver<bool>, wait_ms: f64) {
		while !*halt.borrow() {
			let (ready, at, own) = { let c = self.copy.borrow(); (c.ready, c.rev, c.stream.clone()) };
			let step: Result<()> = async {
				if !ready { return self.copy_all().await; }
				match self.space.changes(at, None, Some(wait_ms), Some(&own)).await {
					Ok(ch) => { self.apply(at, &own, &ch); Ok(()) }
					Err(e @ SpaceError::Remote { .. }) if matches!(e.code(), Some("SnapshotExpired" | "RevisionAhead")) => { self.copy.borrow_mut().ready = false; Ok(()) }
					Err(e) => Err(e.into()),
				}
			}.await;
			if let Err(e) = step {
				eprintln!("[world] the copy of the world: {e}");
				tokio::select! { _ = tokio::time::sleep(std::time::Duration::from_secs(1)) => {}, _ = halt.changed() => {} }
			}
		}
	}

	/// The matches of `t` in the order the space lists them (their ids count up), at most `limit`, each handed to `each`.
	fn matching(&self, t: &Json, limit: Option<usize>, mut each: impl FnMut(&Json)) {
		let mut c = self.copy.borrow_mut();
		let now = real_now();
		let max = limit.unwrap_or(usize::MAX);
		let live = |e: &Json| e.get("expires").and_then(Json::as_f64).unwrap_or(f64::INFINITY) > now;
		if let Some(id) = t.get("id").filter(|v| !v.is_null()) {
			return id.as_str().and_then(|id| c.by_id.get(id)).filter(|e| live(e) && matches(t, e)).into_iter().take(max).for_each(each);
		}
		if let Some(ty) = t.get("type").and_then(Json::as_str) {
			let mut best_field: Option<(String, ScalarKey, usize)> = None;
			if let Some(fields) = t.get("fields").and_then(Json::as_object) {
				for (k, v) in fields.iter() {
					if v.is_null() { continue; }
					if let Some(sk) = ScalarKey::from_json(v) {
						c.ensure_type_field(ty, k);
						let len = c.ids_by(ty, k, &sk).len();
						if len == 0 { return; }
						if best_field.as_ref().is_none_or(|b| len < b.2) { best_field = Some((k.to_owned(), sk, len)); }
					}
				}
			}
			let ids: &[String] = match best_field {
				Some((ref k, ref sk, _)) => c.ids_by(ty, k, sk),
				None => { c.ensure_sorted_type(ty); c.sorted_type.get(ty).map_or(&[], Vec::as_slice) }
			};
			return ids.iter().filter_map(|id| c.by_id.get(id)).filter(|e| live(e) && matches(t, e)).take(max).for_each(each);
		}
		let mut out: Vec<(f64, &Json)> = c.by_id.values().filter(|e| live(e) && matches(t, e)).map(|e| (seq_of(e.get("id").and_then(Json::as_str).unwrap_or("")), e)).collect();
		out.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
		out.into_iter().take(max).for_each(|(_, e)| each(e));
	}

	/// `readAll`: the matches in the order the space lists them (their ids count up), at most `limit`.
	pub fn read_all(&self, t: &Json, limit: Option<usize>) -> Vec<Json> {
		let mut out = Vec::new();
		self.matching(t, limit, |e| { let mut o = e.as_object().cloned().unwrap_or_default(); o.remove("expires"); out.push(Json::Object(o)); });
		out
	}

	/// `count`: the matches counted where they lie (no copy of any of them).
	pub fn count(&self, t: &Json) -> f64 {
		let mut n = 0usize;
		self.matching(t, None, |_| n += 1);
		n as f64
	}
}
