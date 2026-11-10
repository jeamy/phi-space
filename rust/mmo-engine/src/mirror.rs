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

#[derive(Default)]
struct Copy { by_id: HashMap<String, Json>, by_type: HashMap<String, HashSet<String>>, rev: f64, stream: String, ready: bool }

impl Copy {
	fn put(&mut self, e: Json) {
		let Some(id) = e.get("id").and_then(Json::as_str).map(str::to_owned) else { return };
		self.del(&id);
		for t in e.get("types").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) { self.by_type.entry(t.to_owned()).or_default().insert(id.clone()); }
		self.by_id.insert(id, e);
	}
	fn del(&mut self, id: &str) {
		let Some(e) = self.by_id.remove(id) else { return };
		for t in e.get("types").and_then(Json::as_array).into_iter().flatten().filter_map(Json::as_str) { if let Some(s) = self.by_type.get_mut(t) { s.remove(id); } }
	}
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

fn seq_of(id: &str) -> f64 {
	let digits: String = id.chars().rev().take_while(char::is_ascii_digit).collect::<Vec<_>>().into_iter().rev().collect();
	if digits.is_empty() { 0.0 } else { crate::js::to_number(&digits) }
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

	/// `readAll`: the matches in the order the space lists them (their ids count up), at most `limit`.
	pub fn read_all(&self, t: &Json, limit: Option<usize>) -> Vec<Json> {
		let c = self.copy.borrow();
		let now = real_now();
		let live = |e: &Json| e.get("expires").and_then(Json::as_f64).unwrap_or(f64::INFINITY) > now;
		let mut out: Vec<&Json> = match (t.get("id").filter(|v| !v.is_null()), t.get("type").and_then(Json::as_str)) {
			(Some(id), _) => id.as_str().and_then(|id| c.by_id.get(id)).into_iter().collect(),
			(None, Some(ty)) => c.by_type.get(ty).into_iter().flatten().filter_map(|id| c.by_id.get(id)).collect(),
			(None, None) => c.by_id.values().collect(),
		};
		out.retain(|e| live(e) && matches(t, e));
		out.sort_by(|a, b| seq_of(a.get("id").and_then(Json::as_str).unwrap_or("")).partial_cmp(&seq_of(b.get("id").and_then(Json::as_str).unwrap_or(""))).unwrap_or(std::cmp::Ordering::Equal));
		out.into_iter().take(limit.unwrap_or(usize::MAX)).map(|e| { let mut o = e.as_object().cloned().unwrap_or_default(); o.remove("expires"); Json::Object(o) }).collect()
	}

	/// `count`.
	pub fn count(&self, t: &Json) -> f64 { self.read_all(t, None).len() as f64 }
}
