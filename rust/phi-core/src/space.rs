//! The operations of src/core.ts on one space, as far as R1 has come (docs/rust-portierung.md, slice 1): entries,
//! templates, leases, `settle` and expiry, the change stream records, the commit budget, reads, counts, pages and
//! `changes`.
//!
//! The statement order is the TypeScript one, also where it is not the obvious one: an operation that fails after
//! `settle` keeps what `settle` did (a store rolls the commit back; the core does not), so a check moved before or after
//! a mutation would be a different semantics.
//!
//! What a space keeps beside its document, as core.ts does in WeakMaps, is kept here beside `state`: the batch of the
//! running commit, its byte budget and the expiry watermark. The watermark is not only a speed-up: `nextExpiry` answers
//! from it, and it can be stale low.
//!
//! A space with anything this slice does not port (transactions, registrations, waiters, claims, mailboxes, jobs,
//! membership, restore, …) is refused with `NotPorted` before anything happens, and so is an argument outside the shapes
//! ported so far.
use crate::state::{EntryRec, SpaceState};
use crate::stream::{self, Collected, Open};
use phi_json::{number_text, obj, Json, Object, FOREVER};

/// Lease.ANY: the space picks the duration.
pub const ANY: f64 = -1.0;
pub const DEFAULT_LEASE_MS: f64 = 3_600_000.0;
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

fn error(class: &'static str, message: impl Into<String>) -> CoreError { CoreError { class, message: message.into() } }
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
fn js_string(v: &Json) -> String {
	match v {
		Json::String(s) => s.clone(),
		Json::Number(x) => n(*x),
		Json::Bool(b) => b.to_string(),
		Json::Null => "null".into(),
		other => other.to_json_text(),
	}
}
fn bytes(v: &Json) -> f64 { v.json_bytes() as f64 }
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

enum Found {
	At(usize),
	None,
	Locked,
}

/// One space: its document and what core.ts keeps beside it.
#[derive(Clone, Debug)]
pub struct Space {
	pub state: SpaceState,
	/// The batch of the running commit (stream.ts `open`).
	open: Option<Open>,
	/// Bytes the running commit has charged (core.ts `commitBudgets`); none outside a commit.
	budget: Option<f64>,
	/// The smallest `expires` of the entries that stayed at the last full sweep (core.ts `expiryWatermarks`); can only
	/// be stale low. `None`: not swept yet. Infinity is a value of its own (nothing stayed).
	watermark: Option<f64>,
}

impl Space {
	pub fn new(state: SpaceState) -> Space { Space { state, open: None, budget: None, watermark: None } }

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
		for (k, v) in self.state.rest.iter() {
			let fine = match k {
				"txns" => v.as_object().is_some_and(Object::is_empty),
				"regs" | "waiters" | "outbox" => v.as_array().is_some_and(Vec::is_empty),
				"maintenance" => v.get("at").and_then(Json::as_f64).is_some(),
				_ => false,
			};
			if !fine {
				return Err(not_ported(format!("the space's {k} (R1 slice 1 ports entries without transactions, registrations or waiters)")));
			}
		}
		if self.state.limits.as_ref().is_some_and(|l| l.iter().any(|(_, v)| v.as_f64().is_none())) {
			return Err(not_ported("a limit that is not a number"));
		}
		Ok(())
	}

	fn touch(&mut self, now: f64) {
		let max = self.limits().max_log_bytes;
		stream::touch(&mut self.state.stream, &mut self.open, now, max);
	}
	fn record(&mut self, now: f64, id: &str, op: Json) {
		let max = self.limits().max_log_bytes;
		stream::record(&mut self.state.stream, &mut self.open, now, id, op, max);
	}
	fn log_put(&mut self, now: f64, i: usize) {
		let op = put_op(&self.state.entries[i]);
		let id = self.state.entries[i].id.clone();
		self.record(now, &id, op);
	}
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
	/// `overheadBytes`: the parts of the document that are not entries. Term by term as core.ts adds them; the parts
	/// `assert_ported` refuses are their empty values (`{}` or `[]`, 2 bytes), claims and restore none.
	fn overhead_bytes(&self) -> f64 {
		let admin_maintenance = 2.0;
		let membership = 2.0;
		let completion = 0.0;
		let authority_transition = 2.0;
		let authority_counters = 2.0;
		let restore = 0.0;
		let claims = 0.0;
		let stream = self.state.stream.as_ref().map_or(0.0, |s| s.bytes);
		let jobs = 2.0;
		let mailboxes = 2.0;
		let run_gates = 2.0;
		admin_maintenance + membership + completion + authority_transition + authority_counters + restore + claims + stream + self.outbox_bytes() + self.rest_bytes("waiters", 2.0) + self.rest_bytes("regs", 2.0) + self.rest_bytes("txns", 2.0) + jobs + mailboxes + run_gates
	}

	/// `requireTxn`. No transaction is open in a space this slice runs (`assert_ported`), so every id is not active.
	fn require_txn(&self, id: &Json, _as: Option<&Json>) -> Result<()> { Err(error("TransactionError", format!("transaction {} is not active", js_string(id)))) }
	/// Whether transaction `id` is active at `now`; none is (see `require_txn`).
	fn active(&self, _id: Option<&str>, _now: f64) -> bool { false }

	/// Reserve room for the commit that makes an entry visible in this very commit (`reserve` with txn null).
	fn reserve_now(&mut self, cost: f64, lim: &Limits) -> Result<()> {
		let have = 0.0;
		if have + cost + COMMIT_FIXED > lim.max_commit_bytes {
			return Err(exhausted(format!("this commit could write {} bytes; the limit is {}", n(have + cost + COMMIT_FIXED), n(lim.max_commit_bytes))));
		}
		let jobs = 2.0;
		let obligations = 0.0;
		if jobs + obligations + cost > lim.max_job_bytes {
			return Err(exhausted("the durable completion backlog is full"));
		}
		self.charge(cost)
	}

	// ---- settle and expiry

	/// Drop expired entries (in time order). Every operation starts with this.
	pub fn settle(&mut self, now: f64) {
		let own = self.budget.is_none();
		if own {
			self.budget = Some(0.0);
		}
		self.settle_batch(now);
		if own {
			self.budget = None;
		}
	}
	fn settle_batch(&mut self, now: f64) {
		self.state.rest.remove("maintenance");
		// claims, mailboxes, the release queue and expiring transactions: none in a space this slice runs
		self.expire(now);
		// serving waiters, bundled notify events and fanout jobs: none either
	}
	/// Expires what lapsed at `at`; false when the commit budget ran out and the rest was deferred.
	fn expire(&mut self, at: f64) -> bool {
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
				return false;
			}
		}
		// registrations and waiters past their time: none in a space this slice runs
		true
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
		// registrations, transactions, waiters, mailboxes, jobs, claims and the release queue: none in this slice
		if let Some(at) = self.state.rest.get("maintenance").and_then(|m| m.get("at")).and_then(Json::as_f64) {
			min = min.min(at);
		}
		Ok(min)
	}

	// ---- entries

	/// Writes an entry under a lease; visible at once (transactions come with slice 2).
	pub fn write(&mut self, now: f64, entry: &Json, txn: Option<&Json>, lease_ms: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let supertypes = draft_types(entry)?;
		if directory_draft(entry) && (as_.is_some() || txn.is_some()) {
			return Err(permission("directory entries require trusted publication"));
		}
		self.settle(now);
		let (type_, fields) = draft_parts(entry)?;
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
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
			written_under: None,
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
		// events for registrations and waiters: none in this slice; what is left of preflightFanout is the outbox check
		if self.outbox_bytes() > lim.max_outbox_bytes {
			return Err(exhausted("the local outbox cannot hold this fanout"));
		}
		let cost = bytes(&put_op(&rec)) + 1.0;
		let rec_bytes = bytes(&rec.to_json());
		if !self.can_charge(rec_bytes + cost) {
			return Err(exhausted("the write exceeds the remaining commit budget"));
		}
		self.reserve_now(cost, &lim)?; // before any change: a refusal leaves everything as it was
		self.charge(rec_bytes)?;
		self.state.next_id += 1.0;
		let id = rec.id.clone();
		self.state.entries.push(rec);
		self.note_expiry(expires);
		self.touch(now);
		self.log_put(now, self.state.entries.len() - 1);
		Ok(lease(&id, expires))
	}

	/// A write that is announced, not kept: the change stream carries it as a transient put.
	pub fn announce(&mut self, now: f64, entry: &Json, txn: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let supertypes = draft_types(entry)?;
		self.settle(now);
		let (type_, fields) = draft_parts(entry)?;
		if directory_draft(entry) {
			return Err(permission("directory entries require trusted publication"));
		}
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
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
		self.record(now, &rec.id, transient_op(&rec));
		Ok(lease(&rec.id, now))
	}

	/// One non-waiting read or take.
	pub fn probe(&mut self, now: f64, tmpl: &Template, txn: Option<&Json>, take: bool, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now);
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
		let txn: Option<&str> = None;
		match self.find(tmpl, txn, take) {
			Found::At(i) => {
				if as_.is_some() && directory_rec(&self.state.entries[i]) && (take || txn.is_some()) {
					return Err(permission("directory entries cannot be consumed or locked"));
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
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
		let (txn, mine) = (None, false);
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
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
		let (txn, mine) = (None, false);
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
		if let Some(t) = txn {
			self.require_txn(t, as_)?;
		}
		let (txn, mine) = (None, false);
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

	/// The lease of entry `id`, checked against `as` (`leased` in core.ts: waiters, transactions and registrations,
	/// the other leased things, are none in this slice).
	fn leased(&self, id: Option<&Json>, as_: Option<&Json>) -> Result<usize> {
		let id = match id {
			Some(Json::String(s)) => s.as_str(),
			_ => return Err(not_ported("a lease id that is not a string")),
		};
		let i = self.state.entries.iter().position(|e| e.id == id);
		if let Some(i) = i {
			if directory_rec(&self.state.entries[i]) && as_.is_some() {
				return Err(permission("directory leases require trusted publication"));
			}
		}
		let Some(i) = i else { return Err(error("UnknownLeaseError", id)) };
		if !may_use(&self.state.entries[i].owner, as_) {
			return Err(permission(format!("lease {id} belongs to another conversation")));
		}
		Ok(i)
	}

	pub fn renew(&mut self, now: f64, id: Option<&Json>, ms: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now);
		let i = self.leased(id, as_)?;
		let v = grant(ms, now)?;
		self.state.entries[i].expires = v;
		self.note_expiry(v);
		self.touch(now);
		let e = &self.state.entries[i];
		if e.written_under.is_none() && e.taken_by.is_none() {
			self.log_put(now, i); // the lease is part of the visible state
		}
		Ok(Json::Number(v))
	}

	pub fn cancel(&mut self, now: f64, id: Option<&Json>, as_: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.settle(now);
		let i = self.leased(id, as_)?;
		self.state.entries[i].expires = now; // settle removes it
		self.note_expiry(now);
		self.settle(now);
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
		// transactions, waiters and registrations: none in this slice; the outbox is empty
		let outbox = self.state.rest.get("outbox").and_then(Json::as_array).map_or(0, Vec::len) as f64;
		let parts = obj! {
			"entries" => entry_bytes,
			"outbox" => self.outbox_bytes(),
			"claims" => 0.0,
			"waiters" => self.rest_bytes("waiters", 2.0),
			"registrations" => self.rest_bytes("regs", 2.0),
			"txns" => self.rest_bytes("txns", 2.0),
			"total" => bytes(&self.state.to_json()),
		};
		Ok(obj! {
			"entries" => entries, "byType" => by_type, "locked" => locked, "uncommitted" => uncommitted, "expired" => expired,
			"txns" => 0.0, "waiters" => 0.0, "registrations" => 0.0, "outbox" => outbox, "returned" => returned, "bytes" => parts,
		})
	}
}

fn check_size(what: &str, fields: &Object, lim: &Limits) -> Result<()> {
	let size = bytes(&Json::Object(fields.clone()));
	if size > lim.max_entry_bytes {
		return Err(limit(format!("{what} is {} bytes; the limit is {}", n(size), n(lim.max_entry_bytes))));
	}
	Ok(())
}
