//! The operations of src/core.ts on one space, as far as R1 has come (docs/rust-portierung.md, slices 1 to 3):
//! entries, templates, leases, `settle` and expiry, transactions, waiters and parked requests with their events in the
//! outbox (and fanout jobs when it is full), the change stream records, the commit budget, reads, counts, pages and
//! `changes`. Claims and generations are in `claims`.
//!
//! The statement order is the TypeScript one, also where it is not the obvious one: an operation that fails after
//! `settle` keeps what `settle` did (a store rolls the commit back; the core does not), so a check moved before or after
//! a mutation would be a different semantics.
//!
//! What a space keeps beside its document, as core.ts does in WeakMaps, is kept here beside `state`: the batch of the
//! running commit, its byte budget and the expiry watermark. The watermark is not only a speed-up: `nextExpiry` answers
//! from it, and it can be stale low.
//!
//! A space with anything not ported yet (registrations, mailboxes, consumers, membership, restore, completion
//! profiles, …) is refused with `NotPorted` before anything happens, and so is an argument outside the shapes
//! ported so far.
use crate::state::{EntryRec, SpaceState, TxnRec, WaiterRec};
use crate::stream::{self, Collected, Open};
use phi_json::{number_text, obj, Json, Object, FOREVER};

/// Lease.ANY: the space picks the duration.
pub const ANY: f64 = -1.0;
pub const DEFAULT_LEASE_MS: f64 = 3_600_000.0;
/// Kind, ids, sequence, target, count of an event.
const EVENT_OVERHEAD: f64 = 256.0;
/// Claim and result, batch envelope, bookkeeping of one commit.
const COMMIT_FIXED: f64 = 1024.0;
/// What expiring one entry may write.
const EXPIRE_COST: f64 = 128.0;

/// An error as core.ts throws it: the class name and the message.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CoreError {
	pub class: &'static str,
	pub message: String,
}
impl std::fmt::Display for CoreError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{}: {}", self.class, self.message) }
}
impl std::error::Error for CoreError {}

pub(crate) fn error(class: &'static str, message: impl Into<String>) -> CoreError { CoreError { class, message: message.into() } }
fn limit(m: impl Into<String>) -> CoreError { error("LimitError", m) }
fn exhausted(m: impl Into<String>) -> CoreError { error("ResourceExhausted", m) }
fn illegal(m: impl Into<String>) -> CoreError { error("IllegalArgumentError", m) }
fn permission(m: impl Into<String>) -> CoreError { error("PermissionError", m) }
fn too_small(required: f64) -> CoreError { error("ResponseBudgetTooSmall", format!("the next element needs {} bytes of budget", n(required))) }
/// The space or an argument is outside what the Rust core does so far.
pub fn not_ported(m: impl Into<String>) -> CoreError { error("NotPorted", m) }

pub type Result<T> = std::result::Result<T, CoreError>;

/// A number as a JavaScript template literal writes it.
fn n(x: f64) -> String { number_text(x) }
/// A value as `${v}` writes it (ids and transaction ids in messages).
pub(crate) fn js_string(v: &Json) -> String {
	match v {
		Json::String(s) => s.clone(),
		Json::Number(x) => n(*x),
		Json::Bool(b) => b.to_string(),
		Json::Null => "null".into(),
		other => other.to_json_text(),
	}
}
pub(crate) fn bytes(v: &Json) -> f64 { v.json_bytes() as f64 }
/// JavaScript's default string order (`Array.prototype.sort`): by UTF-16 code units.
pub(crate) fn js_cmp(a: &str, b: &str) -> std::cmp::Ordering { a.encode_utf16().cmp(b.encode_utf16()) }
/// `Number.isInteger`.
fn is_integer(v: Option<&Json>) -> Option<f64> {
	match v {
		Some(Json::Number(x)) if x.is_finite() && x.trunc() == *x => Some(*x),
		_ => None,
	}
}
/// JavaScript's `.length` of a string: UTF-16 code units.
fn js_len(s: &str) -> f64 { s.encode_utf16().count() as f64 }
/// JavaScript truthiness.
pub fn truthy(v: Option<&Json>) -> bool {
	match v {
		None | Some(Json::Null) | Some(Json::Bool(false)) => false,
		Some(Json::Number(x)) => *x != 0.0 && !x.is_nan(),
		Some(Json::String(s)) => !s.is_empty(),
		Some(_) => true,
	}
}

macro_rules! limits {
	($($field:ident $key:literal = $default:expr),* $(,)?) => {
		/// Quotas of a space (`Limits` in core.ts): the defaults, overridden by the space's own `limits`.
		#[derive(Clone, Debug, PartialEq)]
		pub struct Limits { $(pub $field: f64),* }
		pub const DEFAULT_LIMITS: Limits = Limits { $($field: $default),* };
		impl Limits {
			pub fn of(own: Option<&Object>) -> Limits {
				let mut l = DEFAULT_LIMITS;
				if let Some(o) = own { $(if let Some(Json::Number(x)) = o.get($key) { l.$field = *x; })* }
				l
			}
		}
	};
}
const KIB: f64 = 1024.0;
const MIB: f64 = 1024.0 * 1024.0;
const HOUR: f64 = 3_600_000.0;
limits! {
	max_entry_bytes "maxEntryBytes" = 64.0 * KIB,
	max_type_chars "maxTypeChars" = 128.0,
	max_types "maxTypes" = 16.0,
	max_entries "maxEntries" = FOREVER,
	max_entries_per_owner "maxEntriesPerOwner" = FOREVER,
	max_regs_per_owner "maxRegsPerOwner" = 20.0,
	max_waiters_per_owner "maxWaitersPerOwner" = 20.0,
	max_txns_per_owner "maxTxnsPerOwner" = 20.0,
	max_space_bytes "maxSpaceBytes" = 64.0 * MIB,
	notify_interval_ms "notifyIntervalMs" = 1000.0,
	claim_result_ms "claimResultMs" = 24.0 * HOUR,
	generation_admit_ms "generationAdmitMs" = HOUR,
	max_claim_bytes "maxClaimBytes" = 32.0 * MIB,
	max_outbox_bytes "maxOutboxBytes" = 8.0 * MIB,
	max_doc_bytes "maxDocBytes" = 128.0 * MIB,
	max_commit_bytes "maxCommitBytes" = 192.0 * KIB,
	max_frame_bytes "maxFrameBytes" = 256.0 * KIB,
	max_event_bytes "maxEventBytes" = 160.0 * KIB,
	max_log_bytes "maxLogBytes" = 4.0 * MIB,
	max_snapshot_bytes "maxSnapshotBytes" = 64.0 * MIB,
	max_snapshots "maxSnapshots" = 16.0,
	snapshot_ttl_ms "snapshotTtlMs" = 60_000.0,
	max_mailbox_bytes "maxMailboxBytes" = 8.0 * MIB,
	mailbox_ttl_ms "mailboxTtlMs" = 7.0 * 24.0 * HOUR,
	max_job_bytes "maxJobBytes" = 16.0 * MIB,
}

/// Absolute time `ms` after `now`; FOREVER (or anything reaching it) stays FOREVER instead of overflowing.
pub fn until(now: f64, ms: f64) -> f64 { if ms >= FOREVER - now { FOREVER } else { now + ms } }

/// A timeout (duration) into an absolute deadline; FOREVER never passes.
fn deadline_of(now: f64, timeout: Option<&Json>) -> Result<f64> {
	let Some(Json::Number(t)) = timeout else { return Err(illegal("bad timeout")) };
	if *t < 0.0 {
		return Err(illegal("negative timeout"));
	}
	Ok(until(now, *t))
}
fn num_of(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
/// A stored wait's template (`assert_ported` checked that it parses).
fn waiter_template(w: &WaiterRec) -> Template { Template::from_json(Some(&w.template)).unwrap_or(Template::Any) }

/// Leases are granted as requested: FOREVER never expires, ANY gets the default.
fn grant(requested: Option<&Json>, now: f64) -> Result<f64> {
	let Some(Json::Number(r)) = requested else { return Err(illegal("bad lease")) };
	if *r < 0.0 && *r != ANY {
		return Err(illegal("negative lease"));
	}
	Ok(until(now, if *r == ANY { DEFAULT_LEASE_MS } else { *r }))
}

/// `===` on JSON values: objects and arrays are never the same value here (each comes from its own parse).
fn strict_eq(a: &Json, b: &Json) -> bool {
	match (a, b) {
		(Json::Null, Json::Null) => true,
		(Json::Bool(x), Json::Bool(y)) => x == y,
		(Json::Number(x), Json::Number(y)) => x == y,
		(Json::String(x), Json::String(y)) => x == y,
		_ => false,
	}
}

/// core.ts `deepEqual`: structural, objects by their keys in any order.
pub fn deep_equal(a: &Json, b: &Json) -> bool {
	match (a, b) {
		(Json::Array(x), Json::Array(y)) => x.len() == y.len() && x.iter().zip(y).all(|(p, q)| deep_equal(p, q)),
		(Json::Object(x), Json::Object(y)) => x.len() == y.len() && x.iter().all(|(k, v)| y.get(k).is_some_and(|w| deep_equal(v, w))),
		_ => strict_eq(a, b),
	}
}

/// A template: absent or null type, id and fields are wildcards, and so is a null field; `Any` (a null template) matches
/// every entry.
#[derive(Clone, Debug, PartialEq)]
pub enum Template {
	Any,
	Of { id: Option<Json>, type_: Option<Json>, fields: Vec<(String, Json)> },
}

impl Template {
	/// The template of a request; shapes core.ts would read through JavaScript's coercions are refused.
	pub fn from_json(v: Option<&Json>) -> Result<Template> {
		match v {
			None | Some(Json::Null) => Ok(Template::Any),
			Some(Json::Object(o)) => {
				let set = |k: &str| o.get(k).filter(|v| !v.is_null()).cloned();
				let fields = match o.get("fields") {
					None | Some(Json::Null) => vec![],
					Some(Json::Object(f)) => f.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect(),
					Some(_) => return Err(not_ported("template fields that are not an object")),
				};
				Ok(Template::Of { id: set("id"), type_: set("type"), fields })
			}
			Some(_) => Err(not_ported("a template that is not an object")),
		}
	}
	pub fn matches(&self, e: &EntryRec) -> bool {
		let Template::Of { id, type_, fields } = self else { return true };
		if id.as_ref().is_some_and(|id| !strict_eq(id, &Json::String(e.id.clone()))) {
			return false; // exact entry id
		}
		if type_.as_ref().is_some_and(|t| !t.as_str().is_some_and(|t| e.types.iter().any(|x| x == t))) {
			return false; // subtype matching
		}
		// a null field is a wildcard: you cannot search for a null field (as in Jini)
		fields.iter().filter(|(_, v)| !v.is_null()).all(|(k, v)| e.fields.get(k).is_some_and(|w| deep_equal(v, w)))
	}
}

/// `directoryEntry`: Capability and MemberStatus entries are published by trusted host code only.
fn directory_draft(entry: &Json) -> bool {
	let is = |t: &Json| matches!(t.as_str(), Some("Capability" | "MemberStatus"));
	entry.get("type").is_some_and(is) || entry.get("types").and_then(Json::as_array).is_some_and(|a| a.iter().any(is))
}
fn directory_rec(e: &EntryRec) -> bool { [&e.type_].into_iter().chain(&e.types).any(|t| t == "Capability" || t == "MemberStatus") }

/// The supertypes of an entry draft (`entry.types ?? []`); other shapes are read by JavaScript's coercions and refused.
fn draft_types(entry: &Json) -> Result<Vec<String>> {
	match entry.get("types") {
		None | Some(Json::Null) => Ok(vec![]),
		Some(Json::Array(a)) => a.iter().map(|t| t.as_str().map(str::to_owned).ok_or_else(|| not_ported("a supertype that is not a string"))).collect(),
		Some(_) => Err(not_ported("entry types that are not an array")),
	}
}
fn draft_parts(entry: &Json) -> Result<(String, Object)> {
	let type_ = match entry.get("type") {
		Some(Json::String(t)) if !t.is_empty() => t.clone(),
		_ => return Err(illegal("entry needs a type")),
	};
	match entry.get("fields") {
		Some(Json::Object(f)) => Ok((type_, f.clone())),
		_ => Err(illegal("entry fields must be an object")),
	}
}

/// Host code (`as` absent) may touch anything; a conversation only what it owns.
fn may_use(owner: &Json, as_: Option<&Json>) -> bool { as_.is_none_or(|a| !owner.is_null() && strict_eq(owner, a)) }

/// What callers see of an entry; with the space's id it also carries the global id.
pub fn view(e: &EntryRec, space_id: Option<&str>) -> Json {
	let mut o = Object::new();
	o.insert("id", e.id.as_str().into());
	if let Some(s) = space_id.filter(|s| !s.is_empty()) {
		o.insert("gid", format!("{s}/{}", e.id).into());
	}
	o.insert("type", e.type_.as_str().into());
	o.insert("types", Json::Array(e.types.iter().map(|t| t.as_str().into()).collect()));
	o.insert("fields", Json::Object(e.fields.clone()));
	o.insert("owner", e.owner.clone());
	if e.restored_unverified {
		o.insert("restoredUnverified", Json::Bool(true));
	}
	Json::Object(o)
}
fn put_op(e: &EntryRec) -> Json {
	let mut o = Object::new();
	o.insert("op", "put".into());
	o.insert("id", e.id.as_str().into());
	o.insert("type", e.type_.as_str().into());
	o.insert("types", Json::Array(e.types.iter().map(|t| t.as_str().into()).collect()));
	o.insert("fields", Json::Object(e.fields.clone()));
	o.insert("expires", Json::Number(e.expires));
	o.insert("owner", e.owner.clone());
	if e.restored_unverified {
		o.insert("restoredUnverified", Json::Bool(true));
	}
	Json::Object(o)
}
fn transient_op(e: &EntryRec) -> Json {
	let Json::Object(mut o) = put_op(e) else { unreachable!() };
	o.insert("transient", Json::Bool(true));
	Json::Object(o)
}
fn lease(id: &str, expires: f64) -> Json { obj! { "id" => id, "expires" => expires } }

/// `seqOf`: the trailing number of an id (the page cursor).
fn seq_of(id: &str) -> f64 {
	let digits = id.len() - id.bytes().rev().take_while(u8::is_ascii_digit).count();
	id[digits..].parse().unwrap_or(0.0)
}

/// `bytePage`: as many whole elements as fit `cap` encoded bytes together with what `make` adds; at least one.
fn byte_page(source: &[Json], cap: f64, make: impl Fn(Vec<Json>, Option<usize>) -> Json) -> Result<Json> {
	let mut items = vec![];
	let mut contents = 0.0;
	for i in 0..source.len() {
		let next = (i + 1 < source.len()).then_some(i + 1);
		let size = bytes(&source[i]);
		let required = bytes(&make(vec![], next)) + contents + size + items.len() as f64;
		if required > cap {
			if items.is_empty() {
				return Err(too_small(required));
			}
			return Ok(make(items, Some(i)));
		}
		items.push(source[i].clone());
		contents += size;
	}
	let result = make(items, None);
	let total = bytes(&result);
	if total > cap { Err(too_small(total)) } else { Ok(result) }
}

/// How a count or a list sees an entry on a snapshot that may not be settled.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Standing {
	Expired,
	Locked,
	Uncommitted,
	Visible,
}

#[derive(Clone, Copy)]
enum Leased {
	Waiter(usize),
	Entry(usize),
	Txn(usize),
}

enum Found {
	At(usize),
	None,
	Locked,
}

/// A source of random bytes (generation nonces and the signing key).
pub type Random = Box<dyn FnMut(usize) -> Vec<u8> + Send>;

/// One space: its document and what core.ts keeps beside it.
pub struct Space {
	pub state: SpaceState,
	random: Random,
	/// The batch of the running commit (stream.ts `open`).
	open: Option<Open>,
	/// Bytes the running commit has charged (core.ts `commitBudgets`); none outside a commit.
	budget: Option<f64>,
	/// The smallest `expires` of the entries that stayed at the last full sweep (core.ts `expiryWatermarks`); can only
	/// be stale low. `None`: not swept yet. Infinity is a value of its own (nothing stayed).
	watermark: Option<f64>,
}

impl Space {
	pub fn new(state: SpaceState, random: Random) -> Space { Space { state, random, open: None, budget: None, watermark: None } }
	pub(crate) fn random_bytes(&mut self, n: usize) -> Vec<u8> { (self.random)(n) }

	pub fn limits(&self) -> Limits { Limits::of(self.state.limits.as_ref()) }

	/// Called once per storage transaction: what follows shares its byte budget and revision.
	pub fn begin_commit(&mut self) {
		self.open = None;
		self.budget = Some(0.0);
	}
	/// Ends the running commit's batch and budget.
	pub fn seal(&mut self) {
		self.open = None;
		self.budget = None;
	}

	/// Refuses a space with parts the Rust core does not port yet. An allowlist: what is not named here is refused.
	pub fn assert_ported(&self) -> Result<()> {
		let local = |events: &[Json]| events.iter().all(|e| e.get("consumer").is_none());
		for (k, v) in self.state.rest.iter() {
			let fine = match k {
				"regs" => v.as_array().is_some_and(Vec::is_empty),
				"outbox" => v.as_array().is_some(),
				// fanout jobs for the local outbox (consumers' mailboxes come with slice 4)
				"jobs" => v.as_array().is_some_and(|jobs| jobs.iter().all(|j| j.get("events").and_then(Json::as_array).is_some_and(|e| local(e)))),
				"maintenance" => v.get("at").and_then(Json::as_f64).is_some(),
				_ => false,
			};
			if !fine {
				return Err(not_ported(format!("the space's {k} (R1 ports entries, transactions, waiters and claims so far, no registrations)")));
			}
		}
		if let Some(t) = self.state.txns.iter().find(|t| t.rest.keys().any(|k| k != "originRequestKey")) {
			let keys: Vec<&str> = t.rest.keys().collect();
			return Err(not_ported(format!("transaction {} carries {}", t.id, keys.join(", "))));
		}
		for w in &self.state.waiters {
			if !w.rest.is_empty() || Template::from_json(Some(&w.template)).is_err() || w.request_txn.as_ref().is_some_and(|t| !t.is_null() && t.as_str().is_none()) {
				return Err(not_ported(format!("waiter {} (consumers come with slice 4)", w.id)));
			}
		}
		if let Some(r) = &self.state.rpc {
			if r.rest.keys().any(|k| k != "sweepCursor") || r.claims.iter().any(|(_, c)| c.get("notCommitted").is_some() || c.as_object().is_none()) {
				return Err(not_ported("claims of a kind not ported yet (negative claims)"));
			}
		}
		if self.state.limits.as_ref().is_some_and(|l| l.iter().any(|(_, v)| v.as_f64().is_none())) {
			return Err(not_ported("a limit that is not a number"));
		}
		Ok(())
	}

	pub(crate) fn touch(&mut self, now: f64) {
		let max = self.limits().max_log_bytes;
		stream::touch(&mut self.state.stream, &mut self.open, now, max);
	}
	fn record(&mut self, now: f64, id: &str, op: Json) {
		let max = self.limits().max_log_bytes;
		stream::record(&mut self.state.stream, &mut self.open, now, id, op, max);
	}
	fn log_put(&mut self, now: f64, i: usize) {
		let e = self.state.entries[i].clone();
		self.log_put_rec(now, &e);
	}
	fn log_put_rec(&mut self, now: f64, e: &EntryRec) { self.record(now, &e.id, put_op(e)); }
	fn log_del(&mut self, now: f64, id: &str) { self.record(now, id, obj! { "op" => "del", "id" => id }); }

	fn charge(&mut self, cost: f64) -> Result<()> {
		let max = self.limits().max_commit_bytes;
		let Some(used) = self.budget.as_mut() else { return Ok(()) };
		if *used + cost + COMMIT_FIXED > max {
			return Err(exhausted("the atomic commit exceeds maxCommitBytes"));
		}
		*used += cost;
		Ok(())
	}
	fn can_charge(&self, cost: f64) -> bool { self.budget.is_none_or(|used| used + cost + COMMIT_FIXED <= self.limits().max_commit_bytes) }
	fn defer_maintenance(&mut self, at: f64, cursor: &str) { self.state.rest.insert("maintenance", obj! { "at" => at, "cursor" => cursor }); }
	/// Reserve one bounded maintenance mutation; persist where to go on when the commit is full.
	pub(crate) fn maintenance_step(&mut self, cost: f64, now: f64, cursor: &str) -> bool {
		if !self.can_charge(cost) {
			self.defer_maintenance(now, cursor);
			return false;
		}
		self.charge(cost).expect("checked");
		true
	}
	fn new_id(&mut self, p: &str) -> String {
		let id = self.peek_id(p);
		self.state.next_id += 1.0;
		id
	}

	/// Ids of an incarnation never repeat; ids from before the space had an incarnation keep the form `e<n>`.
	fn peek_id(&self, p: &str) -> String {
		match self.state.incarnation.as_deref().filter(|s| !s.is_empty()) {
			Some(inc) => format!("{p}{inc}-{}", n(self.state.next_id)),
			None => format!("{p}{}", n(self.state.next_id)),
		}
	}
	fn note_expiry(&mut self, expires: f64) {
		if let Some(known) = self.watermark {
			if expires < known {
				self.watermark = Some(expires);
			}
		}
	}

	/// Bytes of all entries' fields.
	fn entry_bytes(&self) -> f64 { self.state.entries.iter().map(|e| e.size.unwrap_or_else(|| bytes(&Json::Object(e.fields.clone())))).sum() }
	fn rest_bytes(&self, key: &str, absent: f64) -> f64 { self.state.rest.get(key).map_or(absent, bytes) }
	fn outbox_bytes(&self) -> f64 { self.state.outbox_bytes.unwrap_or_else(|| self.rest_bytes("outbox", 2.0)) }
	fn outbox_len(&self) -> usize { self.state.rest.get("outbox").and_then(Json::as_array).map_or(0, Vec::len) }
	/// An event joins the outbox: it and its JSON separator are counted at once.
	fn push_outbox(&mut self, event: Json) {
		self.state.outbox_bytes = Some(self.outbox_bytes() + bytes(&event) + 1.0);
		if let Some(Json::Array(a)) = self.state.rest.get_mut("outbox") {
			a.push(event);
		}
	}
	fn waiters_bytes(&self) -> f64 { bytes(&Json::Array(self.state.waiters.iter().map(WaiterRec::to_json).collect())) }
	fn jobs(&self) -> Vec<Json> { self.state.rest.get("jobs").and_then(Json::as_array).cloned().unwrap_or_default() }
	fn jobs_bytes(&self) -> f64 { self.rest_bytes("jobs", 2.0) }
	fn waiter_at(&self, id: &str) -> Option<usize> { self.state.waiters.iter().position(|w| w.id == id) }
	fn drop_waiter(&mut self, id: &str) {
		if let Some(i) = self.waiter_at(id) {
			self.state.waiters.remove(i);
		}
	}
	/// `overheadBytes`: the parts of the document that are not entries. Term by term as core.ts adds them; the parts
	/// `assert_ported` refuses are their empty values (`{}` or `[]`, 2 bytes), claims and restore none.
	fn overhead_bytes(&self) -> f64 {
		let admin_maintenance = 2.0;
		let membership = 2.0;
		let completion = 0.0;
		let authority_transition = 2.0;
		let authority_counters = 2.0;
		let restore = 0.0;
		let claims = self.claim_bytes();
		let stream = self.state.stream.as_ref().map_or(0.0, |s| s.bytes);
		let jobs = self.jobs_bytes();
		let mailboxes = 2.0;
		let run_gates = 2.0;
		admin_maintenance + membership + completion + authority_transition + authority_counters + restore + claims + stream + self.outbox_bytes() + self.waiters_bytes() + self.rest_bytes("regs", 2.0) + self.txns_bytes() + jobs + mailboxes + run_gates
	}

	fn txns_bytes(&self) -> f64 { bytes(&Json::Object(self.state.txns.iter().map(|t| (t.id.clone(), t.to_json())).collect())) }
	fn txn_at(&self, id: &str) -> Option<usize> { self.state.txns.iter().position(|t| t.id == id) }
	/// `requireTxn`: the transaction exists and `as` may use it; its index.
	fn require_txn(&self, id: &Json, as_: Option<&Json>) -> Result<usize> {
		let Some(i) = id.as_str().and_then(|id| self.txn_at(id)) else { return Err(error("TransactionError", format!("transaction {} is not active", js_string(id)))) };
		if !may_use(&self.state.txns[i].owner, as_) {
			return Err(permission(format!("transaction {} belongs to another conversation", js_string(id))));
		}
		Ok(i)
	}
	/// A transaction past its lease is as good as aborted (the next operation aborts it).
	fn active(&self, id: Option<&str>, now: f64) -> bool { id.and_then(|id| self.txn_at(id)).is_some_and(|i| self.state.txns[i].expires > now) }

	/// Reserve room for the commit that makes an entry visible (`txn` none: this very commit) or for completing `txn`
	/// either way, before the mutation; over the budget nothing has changed.
	fn reserve(&mut self, txn: Option<usize>, cost: f64, lim: &Limits) -> Result<()> {
		let have = txn.and_then(|i| self.state.txns[i].reserved).unwrap_or(0.0);
		if have + cost + COMMIT_FIXED > lim.max_commit_bytes {
			let what = match txn { None => "this commit".to_owned(), Some(i) => format!("completing transaction {}", self.state.txns[i].id) };
			return Err(exhausted(format!("{what} could write {} bytes; the limit is {}", n(have + cost + COMMIT_FIXED), n(lim.max_commit_bytes))));
		}
		let jobs = self.jobs_bytes();
		let obligations: f64 = self.state.txns.iter().map(|t| t.reserved.unwrap_or(0.0)).sum();
		if jobs + obligations + cost > lim.max_job_bytes {
			return Err(exhausted("the durable completion backlog is full"));
		}
		match txn {
			Some(i) => {
				self.state.txns[i].reserved = Some(have + cost);
				Ok(())
			}
			None => self.charge(cost),
		}
	}

	/// `publishCost`: a bound of what making `e` visible writes, its put and an event for every wait that matches it
	/// now (registrations: none yet). `extra`: a wait about to be added.
	fn publish_cost(&self, e: &EntryRec, extra: Option<&WaiterRec>) -> f64 {
		let v = bytes(&view(e, self.state.space_id.as_deref()));
		let mut cost = bytes(&put_op(e)) + 1.0;
		for w in self.state.waiters.iter().chain(extra) {
			if waiter_template(w).matches(e) {
				cost += v + bytes(&w.handback) + EVENT_OVERHEAD;
			}
		}
		cost
	}

	// ---- events

	/// Whether a fanout job still holds an undelivered event for this outbox target.
	fn pending_fanout(&self, target: &Json) -> bool {
		self.jobs().iter().any(|j| {
			let cursor = num_of(j, "cursor").unwrap_or(0.0) as usize;
			j.get("events").and_then(Json::as_array).is_some_and(|ev| ev.iter().skip(cursor).any(|x| x.get("consumer").is_none() && x.get("event").and_then(|e| e.get("target")).is_some_and(|t| strict_eq(t, target))))
		})
	}
	/// `queueEvent` for the local outbox (consumers' mailboxes come with slice 4). `completing`: the event of something
	/// that must not fail (a timeout); when the outbox is full it waits in a fanout job.
	fn queue_event(&mut self, now: f64, event: Json, completing: bool) -> Result<()> {
		let lim = self.limits();
		let size = bytes(&event);
		if size > lim.max_event_bytes {
			return Err(exhausted("the event exceeds maxEventBytes"));
		}
		let target = event.get("target").cloned().unwrap_or(Json::Null);
		if !completing {
			if self.pending_fanout(&target) {
				return Err(exhausted("the consumer has a pending durable fanout backlog"));
			}
			if self.outbox_bytes() + size + 1.0 > lim.max_outbox_bytes {
				return Err(exhausted("the local outbox is full"));
			}
			self.push_outbox(event);
			self.touch(now);
			return Ok(());
		}
		if self.outbox_bytes() + size + 1.0 <= lim.max_outbox_bytes && !self.pending_fanout(&target) {
			self.push_outbox(event);
			self.touch(now);
			return Ok(());
		}
		let id = self.new_id("j");
		let job = obj! { "id" => id, "at" => now, "cursor" => 0.0, "events" => Json::Array(vec![obj! { "event" => event }]) };
		match self.state.rest.get_mut("jobs") {
			Some(Json::Array(a)) => a.push(job),
			_ => self.state.rest.insert("jobs", Json::Array(vec![job])),
		}
		self.touch(now);
		Ok(())
	}
	/// Resume fanout from the jobs' cursors into the outbox as it has room.
	fn run_jobs(&mut self, now: f64) {
		let Some(Json::Array(mut jobs)) = self.state.rest.get("jobs").cloned() else { return };
		let lim = self.limits();
		let mut stopped = false;
		'jobs: for job in jobs.iter_mut() {
			if num_of(job, "retryAt").unwrap_or(0.0) > now {
				continue;
			}
			let Json::Object(o) = job else { continue };
			let events = o.get("events").and_then(Json::as_array).cloned().unwrap_or_default();
			let mut cursor = o.get("cursor").and_then(Json::as_f64).unwrap_or(0.0) as usize;
			while cursor < events.len() {
				let event = events[cursor].get("event").cloned().unwrap_or(Json::Null);
				let size = bytes(&event);
				if self.outbox_bytes() + size + 1.0 > lim.max_outbox_bytes {
					o.insert("retryAt", Json::Number(until(now, 1000.0)));
					break;
				}
				if !self.can_charge(size + EVENT_OVERHEAD) {
					let id = o.get("id").and_then(Json::as_str).unwrap_or("").to_owned();
					o.insert("cursor", Json::Number(cursor as f64));
					self.defer_maintenance(now, &id);
					stopped = true;
					break 'jobs;
				}
				self.charge(size + EVENT_OVERHEAD).expect("checked");
				self.push_outbox(event);
				self.touch(now);
				o.remove("retryAt");
				cursor += 1;
				o.insert("cursor", Json::Number(cursor as f64));
			}
		}
		if !stopped {
			jobs.retain(|j| num_of(j, "cursor").unwrap_or(0.0) as usize != j.get("events").and_then(Json::as_array).map_or(0, Vec::len));
		}
		self.state.rest.insert("jobs", Json::Array(jobs));
	}

	// ---- waiters

	/// A served or lapsed parked request: its claim is decided.
	fn decide_done(&mut self, now: f64, key: &str, result: Json, locked: bool, err: Option<Json>) -> Result<()> { self.decide(now, key, &"done".into(), Some(result), locked, err) }
	fn claim_pending(&self, key: &str) -> bool { self.state.rpc.as_ref().and_then(|r| r.claims.get(key)).and_then(|c| c.get("state")).and_then(Json::as_str) == Some("pending") }

	/// Serve waiters whose match appeared. A take-waiter takes its entry under a fresh transaction, so a lost delivery
	/// is not a lost job: the entry returns when that transaction lapses unless the receiver commits it.
	fn serve(&mut self, now: f64) -> Result<()> {
		let ids: Vec<String> = self.state.waiters.iter().map(|w| w.id.clone()).collect();
		for id in ids {
			let Some(wi) = self.waiter_at(&id) else { continue };
			let w = self.state.waiters[wi].clone();
			let tmpl = waiter_template(&w);
			if let Some(key) = &w.claim_key {
				if !self.claim_pending(key) {
					self.drop_waiter(&id);
					continue;
				}
				if w.authorized_until.is_some_and(|u| now >= u) {
					if w.deadline <= now {
						self.decide_done(now, key, Json::Null, false, None)?;
						self.drop_waiter(&id);
					}
					continue;
				}
				let txn = w.request_txn.as_ref().and_then(Json::as_str).map(str::to_owned);
				if txn.is_some() && !self.active(txn.as_deref(), now) {
					let message = format!("transaction {} is not active", txn.as_deref().unwrap_or(""));
					self.decide_done(now, key, Json::Null, false, Some(obj! { "code" => "TransactionError", "message" => message }))?;
					self.drop_waiter(&id);
					continue;
				}
				let found = self.find(&tmpl, txn.as_deref(), w.take);
				let miss = !matches!(found, Found::At(_)) && (w.deadline <= now || (w.if_exists == Some(true) && matches!(found, Found::None)));
				match found {
					Found::At(i) => {
						let e = &self.state.entries[i];
						if directory_rec(e) && !w.target.is_null() && (w.take || txn.is_some()) {
							let err = obj! { "code" => "PermissionDenied", "message" => "directory entries cannot be consumed or locked" };
							self.decide_done(now, key, Json::Null, false, Some(err))?;
							self.drop_waiter(&id);
							continue;
						}
						let cost = bytes(&view(e, self.state.space_id.as_deref())) + 256.0;
						if !self.can_charge(cost) {
							self.defer_maintenance(now, &id);
							continue;
						}
						// the request's transaction may not be able to reserve the publication of an abort: the waiter
						// stays and is looked at again (the caller's unrelated operation must not fail)
						if w.take && txn.is_some() && e.written_under != txn {
							let c = self.publish_cost(e, None);
							let lim = self.limits();
							let t = self.txn_at(txn.as_deref().expect("some"));
							match self.reserve(t, c, &lim) {
								Err(e) if e.class == "ResourceExhausted" => continue,
								other => other?,
							}
						}
						self.charge(cost)?;
						let copy = self.apply(now, i, txn.as_deref(), w.take);
						let result = view(&copy, self.state.space_id.as_deref());
						self.decide_done(now, key, result, false, None)?;
					}
					_ if miss => self.decide_done(now, key, Json::Null, matches!(found, Found::Locked), None)?,
					_ => continue,
				}
				self.drop_waiter(&id);
				continue;
			}
			if w.authorized_until.is_some_and(|u| now >= u) {
				continue;
			}
			let Found::At(i) = self.find(&tmpl, None, w.take) else { continue };
			if directory_rec(&self.state.entries[i]) && !w.target.is_null() && w.take {
				continue;
			}
			let entry = view(&self.state.entries[i], self.state.space_id.as_deref());
			let event = obj! { "kind" => "waiter", "eventId" => w.id.as_str(), "seq" => 1.0, "handback" => w.handback.clone(), "target" => w.target.clone(), "entry" => entry };
			let cost = bytes(&event) + 256.0;
			if !self.can_charge(cost) {
				self.defer_maintenance(now, &id);
				continue;
			}
			if self.outbox_bytes() + bytes(&event) + 1.0 > self.limits().max_outbox_bytes {
				continue;
			}
			if !w.take {
				self.charge(cost)?;
				self.drop_waiter(&id);
				self.queue_event(now, event, false)?;
				continue;
			}
			let txn = self.new_id("t"); // the receiver commits it
			let mut t = TxnRec { id: txn.clone(), expires: until(now, w.txn_lease_ms), owner: w.target.clone(), reserved: None, announced: None, rest: Object::new() };
			let origin = w.origin_request_key.clone().or_else(|| {
				let claims = &self.state.rpc.as_ref()?.claims;
				claims.iter().find(|(_, c)| c.get("method").and_then(Json::as_str) == Some("wait") && c.get("result").and_then(Json::as_str) == Some(w.id.as_str())).map(|(k, _)| k.to_owned())
			});
			if let Some(k) = origin {
				t.rest.insert("originRequestKey", k.into());
			}
			self.state.txns.push(t);
			// the reservation of the abort's publication may be refused: the fresh transaction goes, the waiter stays
			let c = self.publish_cost(&self.state.entries[i], None);
			let lim = self.limits();
			if let Err(e) = self.reserve(Some(self.state.txns.len() - 1), c, &lim) {
				self.state.txns.pop();
				if e.class == "ResourceExhausted" {
					continue;
				}
				return Err(e);
			}
			self.charge(cost)?;
			self.drop_waiter(&id);
			let copy = self.apply(now, i, Some(&txn), true);
			let Json::Object(mut o) = event else { unreachable!() };
			o.insert("entry", view(&copy, self.state.space_id.as_deref()));
			o.insert("txn", txn.as_str().into());
			self.queue_event(now, Json::Object(o), false)?;
		}
		Ok(())
	}

	/// Re-counts what completing each transaction may write once the wait `extra` exists (`refreshReservations`):
	/// transactions without a reservation, and those whose entries the new wait matches.
	fn refresh_reservations(&self, extra: &WaiterRec) -> Result<Vec<(usize, f64)>> {
		let lim = self.limits();
		let tmpl = waiter_template(extra);
		let mut recount: std::collections::HashSet<String> = self.state.txns.iter().filter(|t| t.reserved.is_none()).map(|t| t.id.clone()).collect();
		for e in &self.state.entries {
			if e.written_under != e.taken_by && tmpl.matches(e) {
				recount.extend(e.written_under.iter().chain(&e.taken_by).cloned());
			}
		}
		let mut published: std::collections::HashMap<String, f64> = Default::default();
		if !recount.is_empty() {
			for e in &self.state.entries {
				if e.written_under == e.taken_by {
					continue; // written and taken in one transaction (or neither): nothing to publish
				}
				if !e.written_under.as_ref().is_some_and(|t| recount.contains(t)) && !e.taken_by.as_ref().is_some_and(|t| recount.contains(t)) {
					continue;
				}
				let cost = self.publish_cost(e, Some(extra));
				for id in e.written_under.iter().chain(&e.taken_by) {
					*published.entry(id.clone()).or_default() += cost;
				}
			}
		}
		let mut updated = vec![];
		for (i, t) in self.state.txns.iter().enumerate() {
			let mut cost = t.reserved.unwrap_or(0.0);
			if recount.contains(&t.id) {
				let full = published.get(&t.id).copied().unwrap_or(0.0); // registrations under it: none yet
				cost = full.max(cost);
			}
			if cost + COMMIT_FIXED > lim.max_commit_bytes {
				return Err(exhausted("the new subscription would invalidate a transaction's completion reservation"));
			}
			updated.push((i, cost));
		}
		if self.jobs_bytes() + updated.iter().map(|(_, c)| c).sum::<f64>() > lim.max_job_bytes {
			return Err(exhausted("the new subscription exceeds reserved completion storage"));
		}
		Ok(updated)
	}

	/// Park a read or take for `target`; the space serves it later (or reports a timeout) through the outbox.
	pub fn add_waiter(&mut self, now: f64, w: &Json) -> Result<Json> {
		self.assert_ported()?;
		if w.get("consumer").is_some() {
			return Err(not_ported("a wait for a consumer (mailboxes come with slice 4)"));
		}
		let Some(template) = w.get("template") else { return Err(not_ported("a wait without a template")) };
		let tmpl = Template::from_json(Some(template))?;
		let (Some(Json::Bool(take)), Some(target)) = (w.get("take"), w.get("target")) else { return Err(not_ported("a wait without a boolean take and a target")) };
		let authorized_until = match w.get("authorizedUntil") {
			None => None,
			Some(Json::Number(x)) => Some(*x),
			Some(_) => return Err(not_ported("authorizedUntil that is not a number")),
		};
		let origin = match w.get("originRequestKey") {
			None | Some(Json::Null) => None,
			Some(Json::String(k)) if !k.is_empty() => Some(k.clone()),
			Some(Json::String(_)) => None,
			Some(_) => return Err(not_ported("originRequestKey that is not a string")),
		};
		let deadline = match w.get("deadline") {
			None | Some(Json::Null) => deadline_of(now, w.get("timeout"))?,
			Some(Json::Number(d)) => *d,
			Some(_) => f64::NAN,
		};
		if (!deadline.is_finite() && deadline != FOREVER) || deadline < 0.0 || deadline.is_nan() {
			return Err(illegal("invalid waiter deadline")); // FOREVER: waits until served or cancelled
		}
		self.settle(now)?;
		let lim = self.limits();
		let handback = w.get("handback").filter(|h| !h.is_null()).cloned().unwrap_or(Json::Null);
		if let Some(as_) = w.get("as") {
			if self.state.waiters.iter().filter(|x| strict_eq(&x.target, as_)).count() as f64 >= lim.max_waiters_per_owner {
				return Err(limit(format!("you already have {} waits", n(lim.max_waiters_per_owner))));
			}
			check_json_size("handback", &handback, &lim)?;
		}
		if self.outbox_len() > 0 && self.outbox_bytes() > lim.max_outbox_bytes {
			return Err(limit(format!("{} bytes of events wait for delivery; try again later", n(lim.max_outbox_bytes))));
		}
		if bytes(&handback) + EVENT_OVERHEAD > lim.max_event_bytes {
			return Err(exhausted("the wait's metadata exceeds maxEventBytes"));
		}
		let lease = w.get("txnLeaseMs").filter(|l| !l.is_null()).cloned().unwrap_or(Json::Number(ANY));
		let txn_lease_ms = grant(Some(&lease), now)? - now; // the same rules as every other lease
		let rec = WaiterRec {
			origin_request_key: origin,
			id: self.new_id("w"),
			template: template.clone(),
			take: *take,
			target: target.clone(),
			deadline,
			txn_lease_ms,
			handback: handback.clone(),
			claim_key: None,
			request_txn: None,
			if_exists: None,
			authorized_until,
			rest: Object::new(),
		};
		let updated = self.refresh_reservations(&rec)?;
		for e in &self.state.entries {
			if tmpl.matches(e) && bytes(&view(e, self.state.space_id.as_deref())) + bytes(&handback) + EVENT_OVERHEAD > lim.max_event_bytes {
				return Err(exhausted("the wait would create an oversized event"));
			}
		}
		let id = rec.id.clone();
		self.state.waiters.push(rec);
		self.touch(now);
		for (i, cost) in updated {
			self.state.txns[i].reserved = Some(cost);
		}
		self.serve(now)?;
		Ok(id.into())
	}

	/// Cancels a wait (no timeout event); a parked request's claim is cancelled with it.
	pub fn cancel_waiter(&mut self, now: f64, id: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let id = id.and_then(Json::as_str).unwrap_or("");
		let Some(i) = self.waiter_at(id) else { return Ok(Json::Bool(false)) };
		if let Some(key) = self.state.waiters[i].claim_key.clone() {
			if self.claim_pending(&key) {
				self.decide(now, &key, &"cancelled".into(), None, false, None)?;
			}
		}
		self.touch(now);
		self.drop_waiter(id);
		Ok(Json::Bool(true))
	}

	/// The durable execution state of a blocking request (`parkOperation`): an ordinary waiter carrying its claim.
	#[allow(clippy::too_many_arguments)]
	pub fn park(&mut self, now: f64, key: &str, tmpl: &Json, take: bool, txn: &Json, deadline: f64, if_exists: bool, owner: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		Template::from_json(Some(tmpl))?;
		if !txn.is_null() && txn.as_str().is_none() {
			return Err(not_ported("a parked request's transaction that is not a string"));
		}
		if self.state.waiters.iter().any(|w| w.claim_key.as_deref() == Some(key)) {
			return Ok(Json::Null);
		}
		let rec = WaiterRec {
			origin_request_key: None,
			id: self.new_id("w"),
			template: tmpl.clone(),
			take,
			target: owner.cloned().filter(|o| !o.is_null()).unwrap_or(Json::Null),
			deadline,
			txn_lease_ms: 0.0,
			handback: Json::Null,
			claim_key: Some(key.to_owned()),
			request_txn: Some(txn.clone()),
			if_exists: Some(if_exists),
			authorized_until: None,
			rest: Object::new(),
		};
		self.state.waiters.push(rec);
		self.touch(now);
		Ok(Json::Null)
	}

	// ---- settle and expiry

	/// Drop expired entries (in time order). Every operation starts with this.
	pub fn settle(&mut self, now: f64) -> Result<()> {
		let own = self.budget.is_none();
		if own {
			self.budget = Some(0.0);
		}
		let r = self.settle_batch(now);
		if own {
			self.budget = None;
		}
		r
	}
	fn settle_batch(&mut self, now: f64) -> Result<()> {
		self.state.rest.remove("maintenance");
		self.sweep(now);
		// mailboxes and the release queue: none in a space R1 runs so far
		loop {
			// the transaction that lapsed first (the first of equals, in the order they were opened)
			let mut t: Option<usize> = None;
			for (i, x) in self.state.txns.iter().enumerate() {
				if x.expires <= now && t.is_none_or(|t| x.expires < self.state.txns[t].expires) {
					t = Some(i);
				}
			}
			let Some(t) = t else { break };
			let (at, reserved, id) = (self.state.txns[t].expires, self.state.txns[t].reserved.unwrap_or(0.0), self.state.txns[t].id.clone());
			if !self.expire(at)? {
				return Ok(());
			}
			if !self.can_charge(reserved) {
				self.defer_maintenance(now, &id);
				return Ok(());
			}
			self.charge(reserved).expect("checked");
			self.finish(&id, false, at);
			self.serve(at)?; // the abort may have returned entries that a waiter is waiting for
		}
		if !self.expire(now)? {
			return Ok(());
		}
		self.serve(now)?;
		// bundled notify events: none yet
		self.run_jobs(now);
		Ok(())
	}

	/// Ends transaction `id`: a commit makes its writes visible and its takes final, an abort the other way round.
	fn finish(&mut self, id: &str, commit: bool, now: f64) {
		self.touch(now);
		let Some(at) = self.txn_at(id) else { return };
		let t = self.state.txns.remove(at);
		// run fences and registrations under the transaction: none yet
		let mut published: Vec<EntryRec> = vec![];
		for i in (0..self.state.entries.len()).rev() {
			// backwards: removals do not shift what is still to visit
			let e = &mut self.state.entries[i];
			e.read_by.retain(|r| r != id);
			if commit {
				if e.taken_by.as_deref() == Some(id) {
					self.state.entries.remove(i); // removal commits (also covers written-and-taken)
					continue;
				}
				if e.written_under.as_deref() == Some(id) {
					e.written_under = None;
					published.push(e.clone());
				}
			} else {
				if e.written_under.as_deref() == Some(id) {
					self.state.entries.remove(i); // aborted writes are discarded
					continue;
				}
				if e.taken_by.as_deref() == Some(id) {
					e.taken_by = None; // takes are undone: the entry is back
					self.state.returned += 1.0;
					if e.written_under.is_none() {
						let e = e.clone();
						self.log_put_rec(now, &e);
					}
				}
			}
		}
		published.reverse(); // announced in write order
		for e in &published {
			self.log_put_rec(now, e);
		}
		if commit {
			for e in t.announced.unwrap_or_default() {
				self.record(now, &e.id, transient_op(&e));
			}
		}
	}
	/// Expires what lapsed at `at`; false when the commit budget ran out and the rest was deferred.
	fn expire(&mut self, at: f64) -> Result<bool> {
		// A reopened document has no watermark: its entries must be scanned once.
		if self.watermark.unwrap_or(f64::NEG_INFINITY) <= at {
			let mut min = f64::INFINITY;
			let mut dead: Vec<usize> = vec![];
			for (i, e) in self.state.entries.iter().enumerate() {
				if e.expires <= at {
					dead.push(i);
				} else if e.expires < min {
					min = e.expires;
				}
			}
			self.watermark = Some(min);
			// core.ts orders ids with localeCompare; for ids of one incarnation (hex, a dash, digits) that is byte order
			let entries = &self.state.entries;
			dead.sort_by(|&a, &b| entries[a].expires.total_cmp(&entries[b].expires).then_with(|| entries[a].id.cmp(&entries[b].id)));
			let mut removed = vec![false; self.state.entries.len()];
			let mut deferred = false;
			for i in dead {
				if !self.can_charge(EXPIRE_COST) {
					// the rest stays: the watermark is their earliest expiry, so the next sweep cannot skip them
					let e = &self.state.entries[i];
					self.watermark = Some(min.min(e.expires));
					let id = e.id.clone();
					self.defer_maintenance(at, &id);
					deferred = true;
					break;
				}
				self.charge(EXPIRE_COST).expect("checked");
				let e = &self.state.entries[i];
				if e.written_under.is_none() && e.taken_by.is_none() {
					let id = e.id.clone();
					self.log_del(at, &id);
				}
				removed[i] = true;
			}
			if removed.contains(&true) {
				let mut i = 0;
				self.state.entries.retain(|_| {
					i += 1;
					!removed[i - 1]
				});
				self.touch(at);
			}
			if deferred {
				return Ok(false);
			}
		}
		// registrations past their time: none yet
		let mut lapsed: Vec<(f64, String)> = self.state.waiters.iter().filter(|w| w.deadline <= at).map(|w| (w.deadline, w.id.clone())).collect();
		lapsed.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
		for (_, id) in lapsed {
			let Some(i) = self.waiter_at(&id) else { continue };
			let w = self.state.waiters[i].clone();
			let cost = bytes(&w.handback) + 256.0;
			if !self.can_charge(cost) {
				self.defer_maintenance(at, &id);
				return Ok(false);
			}
			self.charge(cost).expect("checked");
			match &w.claim_key {
				Some(key) => {
					if self.claim_pending(key) {
						let txn = w.request_txn.as_ref().and_then(Json::as_str).map(str::to_owned);
						let locked = matches!(self.find(&waiter_template(&w), txn.as_deref(), w.take), Found::Locked);
						self.decide_done(at, key, Json::Null, locked, None)?;
					}
				}
				None => {
					let event = obj! { "kind" => "timeout", "eventId" => id.as_str(), "seq" => 1.0, "handback" => w.handback.clone(), "target" => w.target.clone() };
					self.queue_event(at, event, true)?;
				}
			}
			self.drop_waiter(&id);
			self.touch(at);
		}
		Ok(true)
	}

	/// Earliest time something can change without a commit. Initialises the watermark when there is none.
	pub fn next_expiry(&mut self) -> Result<f64> {
		self.assert_ported()?;
		let mut min = match self.watermark {
			Some(known) => known,
			None => {
				let mut min = FOREVER;
				for e in &self.state.entries {
					if e.expires < min {
						min = e.expires;
					}
				}
				self.watermark = Some(min);
				min
			}
		};
		for t in &self.state.txns {
			if t.expires < min {
				min = t.expires;
			}
		}
		for w in &self.state.waiters {
			if w.deadline < min {
				min = w.deadline;
			}
		}
		for j in self.jobs() {
			min = min.min(num_of(&j, "retryAt").unwrap_or(0.0));
		}
		if let Some(at) = self.claims_due() {
			min = min.min(at);
		}
		// registrations, mailboxes and the release queue: none yet
		if let Some(at) = self.state.rest.get("maintenance").and_then(|m| m.get("at")).and_then(Json::as_f64) {
			min = min.min(at);
		}
		Ok(min)
	}

	// ---- entries

	/// Writes an entry under a lease: visible at once, or under `txn` when it commits.
	pub fn write(&mut self, now: f64, entry: &Json, txn: Option<&Json>, lease_ms: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let supertypes = draft_types(entry)?;
		if directory_draft(entry) && (as_.is_some() || txn.is_some()) {
			return Err(permission("directory entries require trusted publication"));
		}
		self.settle(now)?;
		let (type_, fields) = draft_parts(entry)?;
		let txn = txn.map(|t| self.require_txn(t, as_)).transpose()?;
		// run gates: no completion profiles yet
		let expires = grant(lease_ms, now)?;
		let lim = self.limits();
		if let Some(as_) = as_ {
			if js_len(&type_) > lim.max_type_chars {
				return Err(limit(format!("type name longer than {} characters", n(lim.max_type_chars))));
			}
			if supertypes.len() as f64 + 1.0 > lim.max_types {
				return Err(limit(format!("more than {} types", n(lim.max_types))));
			}
			if supertypes.iter().any(|t| js_len(t) > lim.max_type_chars) {
				return Err(limit("bad or too long supertype name"));
			}
			check_size("entry", &fields, &lim)?;
			if self.state.entries.len() as f64 >= lim.max_entries {
				return Err(limit(format!("the space holds {} entries already", n(lim.max_entries))));
			}
			if lim.max_entries_per_owner != FOREVER && self.state.entries.iter().filter(|e| strict_eq(&e.owner, as_)).count() as f64 >= lim.max_entries_per_owner {
				return Err(limit(format!("you already have {} entries in the space", n(lim.max_entries_per_owner))));
			}
		}
		let mut types = vec![type_.clone()]; // the type first, no duplicates
		for t in supertypes {
			if !types.contains(&t) {
				types.push(t);
			}
		}
		let size = bytes(&Json::Object(fields.clone()));
		let rec = EntryRec {
			id: self.peek_id("e"),
			type_,
			types,
			fields,
			expires,
			written_under: txn.map(|t| self.state.txns[t].id.clone()),
			taken_by: None,
			read_by: vec![],
			owner: as_.cloned().unwrap_or(Json::Null),
			size: Some(size),
			restored_unverified: false,
			rest: Object::new(),
		};
		let used = size + self.entry_bytes();
		if used > lim.max_space_bytes {
			return Err(limit(format!("the space would exceed {} bytes", n(lim.max_space_bytes))));
		}
		if used + self.overhead_bytes() > lim.max_doc_bytes {
			return Err(limit(format!("the space document would exceed {} bytes", n(lim.max_doc_bytes))));
		}
		if expires <= now {
			self.state.next_id += 1.0;
			self.touch(now);
			return Ok(lease(&rec.id, expires));
		}
		let view_bytes = bytes(&view(&rec, self.state.space_id.as_deref()));
		self.check_event_size(view_bytes, &lim)?;
		self.preflight_fanout(&rec, txn.is_some(), &lim)?;
		let cost = self.publish_cost(&rec, None);
		let rec_bytes = bytes(&rec.to_json());
		if !self.can_charge(rec_bytes + if txn.is_none() { cost } else { 0.0 }) {
			return Err(exhausted("the write exceeds the remaining commit budget"));
		}
		self.reserve(txn, cost, &lim)?; // before any change: a refusal leaves everything as it was
		self.charge(rec_bytes)?;
		self.state.next_id += 1.0;
		let id = rec.id.clone();
		self.state.entries.push(rec);
		self.note_expiry(expires);
		self.touch(now);
		if txn.is_none() {
			self.log_put(now, self.state.entries.len() - 1); // visible at once; under a transaction it appears at commit
		}
		// notify: no registrations yet
		if txn.is_none() {
			self.serve(now)?;
		}
		Ok(lease(&id, expires))
	}

	/// An event carries the entry, a handback and metadata: a bound with the largest handback of any wait is checked
	/// before a write is accepted, so no event can exceed `maxEventBytes`.
	fn check_event_size(&self, view_bytes: f64, lim: &Limits) -> Result<()> {
		if self.state.waiters.is_empty() {
			return Ok(()); // registrations: none yet
		}
		let handback = self.state.waiters.iter().map(|w| bytes(&w.handback)).fold(0.0, f64::max);
		let bound = view_bytes + handback + EVENT_OVERHEAD;
		if bound > lim.max_event_bytes {
			return Err(exhausted(format!("an event for this entry could take {} bytes; the limit is {}", n(bound), n(lim.max_event_bytes))));
		}
		Ok(())
	}
	/// The events a visible write would send now must fit the event limit and the outbox.
	fn preflight_fanout(&self, rec: &EntryRec, under_txn: bool, lim: &Limits) -> Result<()> {
		let entry = view(rec, self.state.space_id.as_deref());
		let mut local = 0.0;
		if !under_txn {
			for w in &self.state.waiters {
				if w.claim_key.is_none() && waiter_template(w).matches(rec) {
					let event = obj! { "kind" => "waiter", "eventId" => w.id.as_str(), "seq" => 1.0, "handback" => w.handback.clone(), "target" => w.target.clone(), "entry" => entry.clone() };
					if bytes(&event) > lim.max_event_bytes {
						return Err(exhausted("the event exceeds maxEventBytes"));
					}
					local += bytes(&event) + 1.0;
				}
			}
		}
		if self.outbox_bytes() + local > lim.max_outbox_bytes {
			return Err(exhausted("the local outbox cannot hold this fanout"));
		}
		Ok(())
	}

	/// A write that is announced, not kept: the change stream carries it as a transient put.
	pub fn announce(&mut self, now: f64, entry: &Json, txn: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let supertypes = draft_types(entry)?;
		self.settle(now)?;
		let (type_, fields) = draft_parts(entry)?;
		if directory_draft(entry) {
			return Err(permission("directory entries require trusted publication"));
		}
		let txn = txn.map(|t| self.require_txn(t, as_)).transpose()?;
		let lim = self.limits();
		if as_.is_some() {
			if js_len(&type_) > lim.max_type_chars {
				return Err(limit(format!("type name longer than {} characters", n(lim.max_type_chars))));
			}
			if supertypes.len() as f64 + 1.0 > lim.max_types {
				return Err(limit(format!("more than {} types", n(lim.max_types))));
			}
			if supertypes.iter().any(|t| js_len(t) > lim.max_type_chars) {
				return Err(limit("bad or too long supertype name"));
			}
		}
		check_size("entry", &fields, &lim)?;
		let mut types = vec![type_.clone()];
		for t in supertypes {
			if !types.contains(&t) {
				types.push(t);
			}
		}
		let rec = EntryRec { id: self.peek_id("e"), type_, types, fields, expires: now, written_under: None, taken_by: None, read_by: vec![], owner: as_.cloned().unwrap_or(Json::Null), size: None, restored_unverified: false, rest: Object::new() };
		self.state.next_id += 1.0;
		self.touch(now);
		let id = rec.id.clone();
		match txn {
			None => self.record(now, &rec.id, transient_op(&rec)),
			Some(t) => self.state.txns[t].announced.get_or_insert_with(Vec::new).push(rec),
		}
		Ok(lease(&id, now))
	}

	/// One non-waiting read or take.
	pub fn probe(&mut self, now: f64, tmpl: &Template, txn: Option<&Json>, take: bool, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now)?;
		let at = txn.map(|t| self.require_txn(t, as_)).transpose()?;
		let id = at.map(|t| self.state.txns[t].id.clone());
		let txn = id.as_deref();
		match self.find(tmpl, txn, take) {
			Found::At(i) => {
				if as_.is_some() && directory_rec(&self.state.entries[i]) && (take || txn.is_some()) {
					return Err(permission("directory entries cannot be consumed or locked"));
				}
				if take && txn.is_some() && self.state.entries[i].written_under.as_deref() != txn {
					let cost = self.publish_cost(&self.state.entries[i], None); // an abort puts it back
					let lim = self.limits();
					self.reserve(at, cost, &lim)?;
				}
				let copy = self.apply(now, i, txn, take);
				let space_id = self.state.space_id.clone();
				Ok(obj! { "status" => "found", "entry" => view(&copy, space_id.as_deref()) })
			}
			Found::None => Ok(obj! { "status" => "none" }),
			Found::Locked => Ok(obj! { "status" => "locked" }),
		}
	}

	fn find(&self, tmpl: &Template, txn: Option<&str>, take: bool) -> Found {
		let mut locked = false;
		for (i, e) in self.state.entries.iter().enumerate() {
			if !tmpl.matches(e) || (e.restored_unverified && (take || txn.is_some())) {
				continue;
			}
			// run gates: no completion profiles in this slice
			let mine = txn.is_some() && e.written_under.as_deref() == txn;
			if e.written_under.is_some() && !mine {
				continue; // not yet committed elsewhere: invisible, not a conflict
			}
			if let Some(by) = &e.taken_by {
				if Some(by.as_str()) != txn {
					locked = true; // taken by another txn: may come back on abort
				}
				continue;
			}
			if take && e.read_by.iter().any(|t| Some(t.as_str()) != txn) {
				locked = true;
				continue;
			}
			return Found::At(i);
		}
		if locked { Found::Locked } else { Found::None }
	}

	fn apply(&mut self, now: f64, i: usize, txn: Option<&str>, take: bool) -> EntryRec {
		let copy = self.state.entries[i].clone();
		if take {
			// completion profiles: none in this slice
			if copy.written_under.is_none() {
				self.log_del(now, &copy.id); // it stops being visible (taken, or locked by a transaction)
			}
			self.touch(now);
			if txn.is_none() || copy.written_under.as_deref() == txn {
				self.state.entries.remove(i); // gone, or never visible outside
			} else {
				self.state.entries[i].taken_by = txn.map(str::to_owned);
			}
		} else if let Some(t) = txn {
			if !copy.read_by.iter().any(|r| r == t) {
				self.state.entries[i].read_by.push(t.to_owned());
				self.touch(now);
			}
		}
		copy
	}

	fn standing(&self, e: &EntryRec, now: f64) -> Standing {
		if e.expires <= now {
			return Standing::Expired;
		}
		if let Some(t) = &e.written_under {
			return if self.active(Some(t), now) { Standing::Uncommitted } else { Standing::Expired }; // an aborted write lapses with it
		}
		if e.taken_by.as_deref().is_some_and(|t| self.active(Some(t), now)) {
			return Standing::Locked;
		}
		Standing::Visible
	}
	/// Whether a read under `txn` would see `e`.
	fn readable(&self, e: &EntryRec, now: f64, txn: Option<&str>, mine: bool) -> bool {
		let st = self.standing(e, now); // what `txn` itself took is "locked": a transaction does not see its own takes
		st == Standing::Visible || (st == Standing::Uncommitted && mine && e.written_under.as_deref() == txn)
	}

	/// How many entries match, as a read would see them. Changes nothing.
	pub fn count(&self, now: f64, tmpl: &Template, txn: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let id = txn.map(|t| self.require_txn(t, as_)).transpose()?.map(|t| self.state.txns[t].id.clone());
		let txn = id.as_deref();
		let mine = self.active(txn, now);
		let mut count = 0.0;
		for e in &self.state.entries {
			if e.restored_unverified && txn.is_some() {
				continue;
			}
			if self.readable(e, now, txn, mine) && tmpl.matches(e) {
				count += 1.0;
			}
		}
		Ok(Json::Number(count))
	}

	/// All entries a read could see, oldest first, up to `limit`.
	pub fn list(&self, now: f64, tmpl: &Template, txn: Option<&Json>, limit: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let limit = match limit {
			None => FOREVER,
			l => is_integer(l).filter(|&l| l >= 1.0).ok_or_else(|| illegal("limit must be a positive integer"))?,
		};
		let id = txn.map(|t| self.require_txn(t, as_)).transpose()?.map(|t| self.state.txns[t].id.clone());
		let txn = id.as_deref();
		let mine = self.active(txn, now);
		let mut out = vec![];
		for e in &self.state.entries {
			if e.restored_unverified && txn.is_some() {
				continue;
			}
			if out.len() as f64 >= limit {
				break;
			}
			if self.readable(e, now, txn, mine) && tmpl.matches(e) {
				out.push(view(e, self.state.space_id.as_deref()));
			}
		}
		Ok(Json::Array(out))
	}

	/// One page of what `list` returns, limited by encoded bytes; `after` is the `next` of the page before.
	pub fn list_page(&self, now: f64, tmpl: &Template, txn: Option<&Json>, o: &Json, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let frame = self.limits().max_frame_bytes;
		let budget = match o.get("maxBytes") {
			None => frame,
			b => is_integer(b).filter(|&b| b > 0.0).ok_or_else(|| illegal("maxBytes must be a positive integer"))?,
		};
		let cap = budget.min(frame);
		let after = match o.get("after") {
			None | Some(Json::Null) => 0.0,
			Some(a) => {
				let text = match a {
					Json::String(s) => s.clone(),
					Json::Number(x) => n(*x),
					_ => return Err(illegal("bad cursor")),
				};
				if text.is_empty() || !text.bytes().all(|c| c.is_ascii_digit()) {
					return Err(illegal("bad cursor"));
				}
				text.parse::<f64>().expect("digits")
			}
		};
		let id = txn.map(|t| self.require_txn(t, as_)).transpose()?.map(|t| self.state.txns[t].id.clone());
		let txn = id.as_deref();
		let mine = self.active(txn, now);
		let mut eligible = vec![];
		let mut seqs = vec![];
		for e in &self.state.entries {
			if seq_of(&e.id) <= after || (e.restored_unverified && txn.is_some()) {
				continue;
			}
			if self.readable(e, now, txn, mine) && tmpl.matches(e) {
				eligible.push(view(e, self.state.space_id.as_deref()));
				seqs.push(seq_of(&e.id));
			}
		}
		let (rev, stream_id) = (stream::revision_of(&self.state.stream), self.stream_id());
		byte_page(&eligible, cap, |items, next| {
			obj! { "items" => items, "next" => next.map_or(Json::Null, |k| Json::String(n(seqs[k - 1]))), "rev" => rev, "streamId" => stream_id.as_str() }
		})
	}

	/// The leased thing behind `id`, checked against `as` (`leased` in core.ts; waiters and registrations, the other
	/// leased things, are none yet).
	fn leased(&self, id: Option<&Json>, as_: Option<&Json>) -> Result<Leased> {
		let id = match id {
			Some(Json::String(s)) => s.as_str(),
			_ => return Err(not_ported("a lease id that is not a string")),
		};
		let e = self.state.entries.iter().position(|e| e.id == id);
		if e.is_some_and(|i| directory_rec(&self.state.entries[i])) && as_.is_some() {
			return Err(permission("directory leases require trusted publication"));
		}
		let (l, owner) = match (self.waiter_at(id), e, self.txn_at(id)) {
			(Some(w), _, _) => (Leased::Waiter(w), &self.state.waiters[w].target), // a wait's deadline behaves like a lease
			(None, Some(i), _) => (Leased::Entry(i), &self.state.entries[i].owner),
			(None, None, Some(t)) => (Leased::Txn(t), &self.state.txns[t].owner),
			(None, None, None) => return Err(error("UnknownLeaseError", id)),
		};
		if !may_use(owner, as_) {
			return Err(permission(format!("lease {id} belongs to another conversation")));
		}
		Ok(l)
	}
	fn set_lease(&mut self, l: Leased, v: f64) {
		match l {
			Leased::Entry(i) => {
				self.state.entries[i].expires = v;
				self.note_expiry(v);
			}
			Leased::Txn(t) => self.state.txns[t].expires = v,
			Leased::Waiter(w) => self.state.waiters[w].deadline = v,
		}
	}

	pub fn renew(&mut self, now: f64, id: Option<&Json>, ms: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now)?;
		let l = self.leased(id, as_)?;
		let v = grant(ms, now)?;
		// completion deadlines and run fences: none yet
		self.set_lease(l, v);
		self.touch(now);
		if let Leased::Entry(i) = l {
			let e = &self.state.entries[i];
			if e.written_under.is_none() && e.taken_by.is_none() {
				self.log_put(now, i); // the lease is part of the visible state
			}
		}
		Ok(Json::Number(v))
	}

	pub fn cancel(&mut self, now: f64, id: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now)?;
		let l = self.leased(id, as_)?;
		if let Leased::Waiter(_) = l {
			return self.cancel_waiter(now, id).map(|_| Json::Null); // cancelled waits send no timeout event
		}
		self.set_lease(l, now); // settle removes it; a cancelled txn lease aborts the transaction
		self.settle(now)?;
		Ok(Json::Null)
	}

	// ---- transactions

	pub fn create_txn(&mut self, now: f64, lease_ms: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now)?;
		let lim = self.limits();
		if let Some(as_) = as_ {
			if self.state.txns.iter().filter(|t| strict_eq(&t.owner, as_)).count() as f64 >= lim.max_txns_per_owner {
				return Err(limit(format!("you already have {} open transactions", n(lim.max_txns_per_owner))));
			}
		}
		// the id is drawn before the lease is granted: a bad lease still uses it up
		let id = self.peek_id("t");
		self.state.next_id += 1.0;
		let expires = grant(lease_ms, now)?;
		self.state.txns.push(TxnRec { id: id.clone(), expires, owner: as_.cloned().unwrap_or(Json::Null), reserved: None, announced: None, rest: Object::new() });
		self.touch(now);
		Ok(lease(&id, expires))
	}

	pub fn commit_txn(&mut self, now: f64, id: Option<&Json>, as_: Option<&Json>) -> Result<Json> { self.complete_txn(now, id, as_, true) }
	pub fn abort_txn(&mut self, now: f64, id: Option<&Json>, as_: Option<&Json>) -> Result<Json> { self.complete_txn(now, id, as_, false) }
	fn complete_txn(&mut self, now: f64, id: Option<&Json>, as_: Option<&Json>, commit: bool) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now)?;
		let t = self.require_txn(id.unwrap_or(&Json::Null), as_)?;
		// completion profiles and run bindings: none yet
		let (reserved, id) = (self.state.txns[t].reserved.unwrap_or(0.0), self.state.txns[t].id.clone());
		self.charge(reserved)?;
		self.finish(&id, commit, now);
		self.serve(now)?;
		Ok(Json::Null)
	}

	// ---- the change stream

	/// The stream this revision belongs to.
	pub fn stream_id(&self) -> String { format!("{}:{}", self.state.space_id.as_deref().unwrap_or("local"), self.state.incarnation.as_deref().unwrap_or("0")) }
	pub fn revision(&self) -> Result<Json> {
		self.assert_ported()?;
		Ok(Json::Number(stream::revision_of(&self.state.stream)))
	}

	/// The commit batches after `after_rev`, limited by encoded bytes like every page.
	pub fn changes(&self, after_rev: Option<&Json>, o: &Json) -> Result<Json> {
		self.assert_ported()?;
		let frame = self.limits().max_frame_bytes;
		let budget = match o.get("maxBytes") {
			None => frame,
			b => is_integer(b).filter(|&b| b > 0.0).ok_or_else(|| illegal("maxBytes must be a positive integer"))?,
		};
		let after_rev = is_integer(after_rev).filter(|&r| r >= 0.0).ok_or_else(|| illegal("afterRev must be a non-negative integer"))?;
		let batches = match stream::collect(&self.state.stream, after_rev, FOREVER, 0.0) {
			Collected::Ahead { rev } => return Err(error("RevisionAhead", format!("revision {} is ahead of this stream (at {})", n(after_rev), n(rev)))),
			Collected::Expired { floor } => return Err(error("SnapshotExpired", format!("batches up to revision {} are no longer kept", n(floor)))),
			Collected::TooSmall(required) => return Err(too_small(required)),
			Collected::Batches { batches, .. } => batches,
		};
		let rev = stream::revision_of(&self.state.stream);
		let stream_id = self.stream_id();
		let batches: Vec<Json> = batches.iter().map(|b| b.to_json()).collect();
		byte_page(&batches, budget.min(frame), |items, next| {
			let last = items.last().and_then(|b| b.get("rev")).and_then(Json::as_f64).unwrap_or(after_rev);
			obj! { "streamId" => stream_id.as_str(), "batches" => items, "next" => last, "rev" => rev, "more" => next.is_some() }
		})
	}

	/// A point-in-time summary of the space, as an operation would see it after settling. Changes nothing.
	pub fn stats(&self, now: f64) -> Result<Json> {
		self.assert_ported()?;
		let (mut entries, mut locked, mut uncommitted, mut expired) = (0.0, 0.0, 0.0, 0.0);
		let mut returned = self.state.returned;
		let mut by_type = Object::new();
		let mut entry_bytes = 0.0;
		for e in &self.state.entries {
			entry_bytes += e.size.unwrap_or_else(|| bytes(&Json::Object(e.fields.clone())));
			match self.standing(e, now) {
				Standing::Visible => {
					entries += 1.0;
					let k = by_type.get(&e.type_).and_then(Json::as_f64).unwrap_or(0.0);
					by_type.insert(e.type_.clone(), Json::Number(k + 1.0));
					if e.taken_by.is_some() {
						returned += 1.0; // taken by a lapsed transaction: back once settled
					}
				}
				Standing::Locked => locked += 1.0,
				Standing::Uncommitted => uncommitted += 1.0,
				Standing::Expired => expired += 1.0,
			}
		}
		let txns = self.state.txns.iter().filter(|t| t.expires > now).count() as f64;
		let waiters = self.state.waiters.iter().filter(|w| w.deadline > now).count() as f64;
		// registrations: none yet
		let outbox = self.outbox_len() as f64;
		let parts = obj! {
			"entries" => entry_bytes,
			"outbox" => self.outbox_bytes(),
			"claims" => self.claim_bytes(),
			"waiters" => self.waiters_bytes(),
			"registrations" => self.rest_bytes("regs", 2.0),
			"txns" => self.txns_bytes(),
			"total" => bytes(&self.state.to_json()),
		};
		Ok(obj! {
			"entries" => entries, "byType" => by_type, "locked" => locked, "uncommitted" => uncommitted, "expired" => expired,
			"txns" => txns, "waiters" => waiters, "registrations" => 0.0, "outbox" => outbox, "returned" => returned, "bytes" => parts,
		})
	}
}

fn check_size(what: &str, fields: &Object, lim: &Limits) -> Result<()> { check_json_size(what, &Json::Object(fields.clone()), lim) }
fn check_json_size(what: &str, v: &Json, lim: &Limits) -> Result<()> {
	let size = bytes(v);
	if size > lim.max_entry_bytes {
		return Err(limit(format!("{what} is {} bytes; the limit is {}", n(size), n(lim.max_entry_bytes))));
	}
	Ok(())
}
