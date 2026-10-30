//! The lines of test/support/core-driver.ts, run on the Rust core: `{"op": "<name>", "now": <ms>, ...arguments}` in, the
//! result or the error out. Every line but `init` is a commit of its own; the clock is the line's `now`. The differential
//! tests send the same lines to both and compare answers and state hashes.
//!
//! Operations this crate does not port yet answer `NotPorted`.
use crate::space::{js_string, not_ported, truthy, CoreError, Random, Space, Template, ANY};
use crate::state::SpaceState;
use phi_json::{Json, Object, FOREVER};
use sha2::{Digest, Sha256};

/// The driver's randomness: the next bytes of SHA-256("phi-spaces/driver/v1\n<seed>\n<block>") blocks, as
/// core-driver.ts hands them to `crypto.randomBytes`.
pub fn seeded(seed: &str) -> Random {
	let seed = seed.to_owned();
	let (mut block, mut pool) = (0u64, Vec::<u8>::new());
	Box::new(move |n| {
		while pool.len() < n {
			pool.extend(Sha256::digest(format!("phi-spaces/driver/v1\n{seed}\n{block}")));
			block += 1;
		}
		pool.drain(..n).collect()
	})
}

pub struct Driver {
	pub space: Space,
	/// The host's entry snapshots (a new host with every init).
	pub snapshots: crate::snapshot::Snapshots,
	clock: f64,
}

impl Default for Driver {
	fn default() -> Self { Driver { space: Space::new(SpaceState::initial(), seeded("")), snapshots: Default::default(), clock: 0.0 } }
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

fn o_options(l: &Json) -> &Json {
	static EMPTY: std::sync::OnceLock<Json> = std::sync::OnceLock::new();
	l.get("options").filter(|o| !o.is_null()).unwrap_or_else(|| EMPTY.get_or_init(|| Json::Object(Object::new())))
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
			let seed = l.get("seed").map_or_else(String::new, js_string);
			self.space = Space::new(s, seeded(&seed));
			self.space.clock = self.clock;
			self.snapshots = Default::default();
			return Ok(Json::Null);
		}
		if let Some(now) = l.get("now").and_then(Json::as_f64) {
			self.clock = now;
		}
		let now = self.clock;
		self.space.clock = now; // Date.now() in the TypeScript driver
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
			"settle" => s.assert_ported().and_then(|_| s.settle(now)).map(|_| Json::Null),
			"addWaiter" => s.add_waiter(now, l.get("w").unwrap_or(&Json::Null)),
			"cancelWaiter" => s.cancel_waiter(now, l.get("id")),
			"park" => {
				let key = l.get("key").and_then(Json::as_str).unwrap_or("");
				let deadline = l.get("deadline").and_then(Json::as_f64).unwrap_or(FOREVER);
				s.park(now, key, l.get("tmpl").unwrap_or(&Json::Null), truthy(l.get("take")), l.get("txn").unwrap_or(&Json::Null), deadline, truthy(l.get("ifExists")), l.get("owner"))
			}
			"issueGeneration" => s.issue_generation(now, l.get("principal"), o_options(l)),
			"admit" => {
				let deadline = l.get("deadline").cloned().unwrap_or(Json::Number(FOREVER));
				let bound = l.get("resultBound").and_then(Json::as_f64).unwrap_or(1024.0);
				s.admit(now, l.get("request"), l.get("method").unwrap_or(&Json::Null), l.get("args").unwrap_or(&Json::Null), &deadline, bound)
			}
			"decide" => s.decide_line(now, l.get("key"), l.get("outcome")),
			"lookup" => s.lookup(now, l.get("request")),
			"notify" => {
				let or_null = |k: &str| l.get(k).unwrap_or(&Json::Null);
				s.notify(now, or_null("tmpl"), txn, l.get("lease").unwrap_or(&Json::Number(ANY)), or_null("handback"), or_null("target"), as_, l.get("consumer"))
			}
			"events" => s.mailbox_page(now, l.get("principal"), o),
			"appendMail" => s.append_mail_line(now, l.get("principal"), l.get("event")),
			"snapshotPage" => self.snapshots.page(s, now, l.get("tmpl").unwrap_or(&Json::Null), o, as_),
			"ack" => s.ack_mailbox(l.get("principal"), l.get("mailboxEpoch"), l.get("upTo")),
			"nextExpiry" => s.next_expiry().map(Json::Number),
			"stats" => s.stats(now),
			"changes" => s.changes(l.get("afterRev"), o),
			"revision" => s.revision(),
			other => Err(not_ported(format!("op {other}"))),
		};
		result.map(plain)
	}
}
