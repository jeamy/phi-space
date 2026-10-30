//! The lines of test/support/core-driver.ts, run on the Rust core: `{"op": "<name>", "now": <ms>, ...arguments}` in, the
//! result or the error out. Every line but `init` is a commit of its own; the clock is the line's `now`. The differential
//! tests send the same lines to both and compare answers and state hashes.
//!
//! Operations this crate does not port yet answer `NotPorted`.
use crate::space::{not_ported, truthy, CoreError, Space, Template, ANY};
use crate::state::SpaceState;
use phi_json::{Json, Object};

pub struct Driver {
	pub space: Space,
	clock: f64,
}

impl Default for Driver {
	fn default() -> Self { Driver { space: Space::new(SpaceState::initial()), clock: 0.0 } }
}

/// What the TypeScript driver's `core.plain` makes of a result: a JSON copy, where a number that is not finite is `null`.
fn plain(v: Json) -> Json {
	match v {
		Json::Number(x) if !x.is_finite() => Json::Null,
		Json::Array(a) => Json::Array(a.into_iter().map(plain).collect()),
		Json::Object(o) => Json::Object(o.iter().map(|(k, v)| (k, plain(v.clone()))).collect()),
		other => other,
	}
}

impl Driver {
	pub fn new() -> Driver { Driver::default() }

	/// One line; its result as plain JSON.
	pub fn step(&mut self, l: &Json) -> Result<Json, CoreError> {
		let op = l.get("op").and_then(Json::as_str).unwrap_or("");
		if op == "init" {
			self.clock = l.get("now").and_then(Json::as_f64).unwrap_or(0.0);
			let mut s = SpaceState::initial();
			let text = |k: &str| match l.get(k) {
				None => Ok(None),
				Some(Json::String(v)) => Ok(Some(v.clone())),
				Some(_) => Err(not_ported(format!("init {k} that is not a string"))),
			};
			s.space_id = text("spaceId")?;
			s.incarnation = text("incarnation")?;
			match l.get("limits") {
				None | Some(Json::Null) => {}
				Some(Json::Object(o)) => s.limits = Some(o.clone()),
				Some(_) => return Err(not_ported("init limits that are not an object")),
			}
			self.space = Space::new(s);
			return Ok(Json::Null);
		}
		if let Some(now) = l.get("now").and_then(Json::as_f64) {
			self.clock = now;
		}
		let now = self.clock;
		self.space.begin_commit();
		let s = &mut self.space;
		// `opt(v, null)` in the TypeScript driver: absent is null, and null is no transaction
		let txn = l.get("txn").filter(|t| !t.is_null());
		let as_ = l.get("as");
		let empty = Json::Object(Object::new());
		let o = l.get("o").filter(|o| !o.is_null()).unwrap_or(&empty);
		let result = match op {
			"write" => s.write(now, l.get("entry").unwrap_or(&Json::Null), txn, Some(l.get("lease").unwrap_or(&Json::Number(ANY))), as_),
			"announce" => s.announce(now, l.get("entry").unwrap_or(&Json::Null), txn, as_),
			"probe" => s.probe(now, &Template::from_json(l.get("tmpl"))?, txn, truthy(l.get("take")), as_),
			"count" => s.count(now, &Template::from_json(l.get("tmpl"))?, txn, as_),
			"list" => s.list(now, &Template::from_json(l.get("tmpl"))?, txn, l.get("limit"), as_),
			"listPage" => s.list_page(now, &Template::from_json(l.get("tmpl"))?, txn, o, as_),
			"renew" => s.renew(now, l.get("id"), l.get("ms"), as_),
			"cancel" => s.cancel(now, l.get("id"), as_),
			"createTxn" => s.create_txn(now, Some(l.get("lease").unwrap_or(&Json::Number(ANY))), as_),
			"commitTxn" => s.commit_txn(now, l.get("id"), as_),
			"abortTxn" => s.abort_txn(now, l.get("id"), as_),
			"settle" => s.assert_ported().map(|_| {
				s.settle(now);
				Json::Null
			}),
			"nextExpiry" => s.next_expiry().map(Json::Number),
			"stats" => s.stats(now),
			"changes" => s.changes(l.get("afterRev"), o),
			"revision" => s.revision(),
			other => Err(not_ported(format!("op {other}"))),
		};
		result.map(plain)
	}
}
