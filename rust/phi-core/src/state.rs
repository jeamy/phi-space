//! The space state as the TypeScript code stores it (`SpaceState` in src/core.ts, the document `phi-spaces.space`).
//!
//! Under decision R-D1 both implementations read and write the same documents, so a state read here must write back
//! exactly what was read: every field this crate does not model yet stays in `rest`, verbatim, and every field it
//! models keeps the difference between absent and `null` (the byte budgets count `JSON.stringify` output, where an
//! absent field costs nothing and a `null` one costs its key).
//!
//! Modelled so far (R1, slices 1 to 4): the scalars, the entries, the transactions, the registrations, the waiters, the
//! request claims and generations (`rpc`), the mailboxes and the change stream. The outbox and the fanout jobs are
//! carried as JSON arrays (the core only appends to them and walks them), and so is the rest of the document.
use phi_json::{Json, Object};

/// A state that is not the TypeScript document shape.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ShapeError(pub String);
impl std::fmt::Display for ShapeError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "not a space state: {}", self.0) }
}
impl std::error::Error for ShapeError {}

/// Reads the fields of one record; what is not taken stays for `rest`.
struct Fields(Object);
impl Fields {
	fn of(v: &Json, what: &str) -> Result<Self, ShapeError> {
		v.as_object().cloned().map(Fields).ok_or_else(|| ShapeError(format!("{what} is not an object")))
	}
	fn take(&mut self, key: &str) -> Option<Json> { self.0.remove(key) }
	fn need(&mut self, key: &str, what: &str) -> Result<Json, ShapeError> { self.take(key).ok_or_else(|| ShapeError(format!("{what}.{key} is missing"))) }
	fn string(&mut self, key: &str, what: &str) -> Result<String, ShapeError> {
		match self.need(key, what)? { Json::String(s) => Ok(s), _ => Err(ShapeError(format!("{what}.{key} is not a string"))) }
	}
	fn number(&mut self, key: &str, what: &str) -> Result<f64, ShapeError> {
		match self.need(key, what)? { Json::Number(n) => Ok(n), _ => Err(ShapeError(format!("{what}.{key} is not a number"))) }
	}
	fn opt_number(&mut self, key: &str, what: &str) -> Result<Option<f64>, ShapeError> {
		match self.take(key) { None => Ok(None), Some(Json::Number(n)) => Ok(Some(n)), Some(_) => Err(ShapeError(format!("{what}.{key} is not a number"))) }
	}
	fn opt_string(&mut self, key: &str, what: &str) -> Result<Option<String>, ShapeError> {
		match self.take(key) { None => Ok(None), Some(Json::String(s)) => Ok(Some(s)), Some(_) => Err(ShapeError(format!("{what}.{key} is not a string"))) }
	}
	/// A field that is a string or `null` (present either way in TypeScript's records).
	fn nullable_string(&mut self, key: &str, what: &str) -> Result<Option<String>, ShapeError> {
		match self.need(key, what)? { Json::Null => Ok(None), Json::String(s) => Ok(Some(s)), _ => Err(ShapeError(format!("{what}.{key} is not a string or null"))) }
	}
	fn strings(&mut self, key: &str, what: &str) -> Result<Vec<String>, ShapeError> {
		match self.need(key, what)? {
			Json::Array(a) => a.into_iter().map(|x| match x { Json::String(s) => Ok(s), _ => Err(ShapeError(format!("{what}.{key} holds a non-string"))) }).collect(),
			_ => Err(ShapeError(format!("{what}.{key} is not an array"))),
		}
	}
	fn object(&mut self, key: &str, what: &str) -> Result<Object, ShapeError> {
		match self.need(key, what)? { Json::Object(o) => Ok(o), _ => Err(ShapeError(format!("{what}.{key} is not an object"))) }
	}
	/// `true` or absent (TypeScript's `?: true` flags).
	fn flag(&mut self, key: &str, what: &str) -> Result<bool, ShapeError> {
		match self.take(key) { None => Ok(false), Some(Json::Bool(true)) => Ok(true), Some(_) => Err(ShapeError(format!("{what}.{key} is not true"))) }
	}
	fn rest(self) -> Object { self.0 }
}

fn strings(v: &[String]) -> Json { Json::Array(v.iter().map(|s| Json::String(s.clone())).collect()) }
fn nullable(v: &Option<String>) -> Json { v.as_ref().map_or(Json::Null, |s| Json::String(s.clone())) }
/// Appends `rest` after the modelled fields (an extra field written by a newer TypeScript keeps its value).
fn with_rest(mut o: Object, rest: &Object) -> Json { for (k, v) in rest.iter() { o.insert(k, v.clone()); } Json::Object(o) }

/// `EntryRec`: one entry with its lease and locks.
#[derive(Clone, Debug, PartialEq)]
pub struct EntryRec {
	pub id: String,
	pub type_: String,
	/// The type followed by its supertypes, fixed at write time.
	pub types: Vec<String>,
	pub fields: Object,
	pub expires: f64,
	/// Invisible outside this transaction until it commits.
	pub written_under: Option<String>,
	/// Locked against every other operation.
	pub taken_by: Option<String>,
	/// Others may read, but not take.
	pub read_by: Vec<String>,
	/// Who may renew or cancel its lease (`Target`: a string or a number); `null`: host code only.
	pub owner: Json,
	/// JSON bytes of `fields`, when recorded.
	pub size: Option<f64>,
	pub restored_unverified: bool,
	pub rest: Object,
}

impl EntryRec {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "entry";
		let mut f = Fields::of(v, w)?;
		Ok(EntryRec {
			restored_unverified: f.flag("restoredUnverified", w)?,
			id: f.string("id", w)?,
			type_: f.string("type", w)?,
			types: f.strings("types", w)?,
			fields: f.object("fields", w)?,
			expires: f.number("expires", w)?,
			written_under: f.nullable_string("writtenUnder", w)?,
			taken_by: f.nullable_string("takenBy", w)?,
			read_by: f.strings("readBy", w)?,
			owner: f.need("owner", w)?,
			size: f.opt_number("size", w)?,
			rest: f.rest(),
		})
	}
	/// The record as core.ts writes it (its key order: `restoredUnverified` first when set, then as in `write`).
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		if self.restored_unverified { o.insert("restoredUnverified", Json::Bool(true)); }
		o.insert("id", self.id.as_str().into());
		o.insert("type", self.type_.as_str().into());
		o.insert("types", strings(&self.types));
		o.insert("fields", Json::Object(self.fields.clone()));
		o.insert("expires", Json::Number(self.expires));
		o.insert("writtenUnder", nullable(&self.written_under));
		o.insert("takenBy", nullable(&self.taken_by));
		o.insert("readBy", strings(&self.read_by));
		o.insert("owner", self.owner.clone());
		if let Some(n) = self.size { o.insert("size", Json::Number(n)); }
		with_rest(o, &self.rest)
	}
}

/// The entries of a space, in their order. They change only through these methods, so a commit knows what it changed:
/// `track` starts an undo log, `untrack` hands it over (the host writes the changed rows from it, or undoes them).
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Entries {
	items: Vec<EntryRec>,
	log: Option<Vec<EntryUndo>>,
}

/// One change of the entries, with what undoes it.
#[derive(Clone, Debug, PartialEq)]
pub enum EntryUndo {
	/// A record was appended (its id).
	Pushed(String),
	/// The record at this position was removed.
	Removed(usize, EntryRec),
	/// The record at this position was changed; this is how it was.
	Set(usize, EntryRec),
}

impl Entries {
	pub fn push(&mut self, e: EntryRec) {
		if let Some(log) = &mut self.log {
			log.push(EntryUndo::Pushed(e.id.clone()));
		}
		self.items.push(e);
	}
	pub fn remove(&mut self, i: usize) -> EntryRec {
		let e = self.items.remove(i);
		if let Some(log) = &mut self.log {
			log.push(EntryUndo::Removed(i, e.clone()));
		}
		e
	}
	/// Keeps the records `keep` accepts, in order.
	pub fn retain(&mut self, mut keep: impl FnMut(&EntryRec) -> bool) {
		let mut i = 0;
		while i < self.items.len() {
			if keep(&self.items[i]) {
				i += 1;
			} else {
				self.remove(i);
			}
		}
	}
	/// The record at `i`, to change.
	pub fn get_mut(&mut self, i: usize) -> &mut EntryRec {
		if let Some(log) = &mut self.log {
			log.push(EntryUndo::Set(i, self.items[i].clone()));
		}
		&mut self.items[i]
	}
	pub fn track(&mut self) { self.log = Some(vec![]); }
	/// The changes since `track`, oldest first; tracking ends.
	pub fn untrack(&mut self) -> Vec<EntryUndo> { self.log.take().unwrap_or_default() }
	/// Undoes `changes` (as `untrack` handed them over).
	pub fn undo(&mut self, changes: Vec<EntryUndo>) {
		for c in changes.into_iter().rev() {
			match c {
				EntryUndo::Pushed(_) => {
					self.items.pop();
				}
				EntryUndo::Removed(i, e) => self.items.insert(i, e),
				EntryUndo::Set(i, e) => self.items[i] = e,
			}
		}
	}
	pub fn as_slice(&self) -> &[EntryRec] { &self.items }
}
impl std::ops::Deref for Entries {
	type Target = [EntryRec];
	fn deref(&self) -> &[EntryRec] { &self.items }
}
impl<'a> IntoIterator for &'a Entries {
	type Item = &'a EntryRec;
	type IntoIter = std::slice::Iter<'a, EntryRec>;
	fn into_iter(self) -> Self::IntoIter { self.items.iter() }
}
impl From<Vec<EntryRec>> for Entries {
	fn from(items: Vec<EntryRec>) -> Self { Entries { items, log: None } }
}

/// `TxnRec`: an open transaction. `owner`: the only conversation that may use, commit, abort, renew or cancel it.
#[derive(Clone, Debug, PartialEq)]
pub struct TxnRec {
	pub id: String,
	pub expires: f64,
	pub owner: Json,
	/// Bytes its completion may write, reserved when its writes and takes were admitted.
	pub reserved: Option<f64>,
	/// announce() under this transaction: put into the stream at its commit.
	pub announced: Option<Vec<EntryRec>>,
	/// Completion allowances, taken tasks, run bindings, …: carried as read.
	pub rest: Object,
}

impl TxnRec {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "txn";
		let mut f = Fields::of(v, w)?;
		let id = f.string("id", w)?;
		let expires = f.number("expires", w)?;
		let owner = f.need("owner", w)?;
		let reserved = f.opt_number("reserved", w)?;
		let announced = match f.take("announced") {
			None => None,
			Some(Json::Array(a)) => Some(a.iter().map(EntryRec::from_json).collect::<Result<_, _>>()?),
			Some(_) => return Err(ShapeError("txn.announced is not an array".into())),
		};
		Ok(TxnRec { id, expires, owner, reserved, announced, rest: f.rest() })
	}
	/// The record in core.ts's order (`createTxn`; `reserved` and `announced` are added later, in either order: the
	/// order here is one of them, the same bytes).
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("id", self.id.as_str().into());
		o.insert("expires", Json::Number(self.expires));
		o.insert("owner", self.owner.clone());
		if let Some(n) = self.reserved { o.insert("reserved", Json::Number(n)); }
		if let Some(a) = &self.announced { o.insert("announced", Json::Array(a.iter().map(EntryRec::to_json).collect())); }
		with_rest(o, &self.rest)
	}
}

/// `WaiterRec`: a parked read or take, served by the space when a match appears. With `claimKey` it is the durable
/// state of a blocking request (parkOperation); without, its outcome is an event for `target`.
#[derive(Clone, Debug, PartialEq)]
pub struct WaiterRec {
	pub origin_request_key: Option<String>,
	pub id: String,
	pub template: Json,
	pub take: bool,
	pub target: Json,
	pub deadline: f64,
	pub txn_lease_ms: f64,
	pub handback: Json,
	pub claim_key: Option<String>,
	/// The transaction of a parked request: absent, `null` or its id.
	pub request_txn: Option<Json>,
	pub if_exists: Option<bool>,
	pub authorized_until: Option<f64>,
	/// The principal whose mailbox gets the wait's event (instead of the outbox).
	pub consumer: Option<Json>,
	pub rest: Object,
}

impl WaiterRec {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "waiter";
		let mut f = Fields::of(v, w)?;
		let origin_request_key = f.opt_string("originRequestKey", w)?;
		let id = f.string("id", w)?;
		let template = f.need("template", w)?;
		let take = match f.need("take", w)? { Json::Bool(b) => b, _ => return Err(ShapeError("waiter.take is not a boolean".into())) };
		let target = f.need("target", w)?;
		let deadline = f.number("deadline", w)?;
		let txn_lease_ms = f.number("txnLeaseMs", w)?;
		let handback = f.need("handback", w)?;
		let claim_key = f.opt_string("claimKey", w)?;
		let request_txn = f.take("requestTxn");
		let if_exists = match f.take("ifExists") { None => None, Some(Json::Bool(b)) => Some(b), Some(_) => return Err(ShapeError("waiter.ifExists is not a boolean".into())) };
		let authorized_until = f.opt_number("authorizedUntil", w)?;
		let consumer = f.take("consumer");
		Ok(WaiterRec { origin_request_key, id, template, take, target, deadline, txn_lease_ms, handback, claim_key, request_txn, if_exists, authorized_until, consumer, rest: f.rest() })
	}
	/// The record in the order addWaiter (or parkOperation, for the claim fields) writes it.
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		if let Some(k) = &self.origin_request_key { o.insert("originRequestKey", k.as_str().into()); }
		o.insert("id", self.id.as_str().into());
		o.insert("template", self.template.clone());
		o.insert("take", Json::Bool(self.take));
		o.insert("target", self.target.clone());
		o.insert("deadline", Json::Number(self.deadline));
		o.insert("txnLeaseMs", Json::Number(self.txn_lease_ms));
		o.insert("handback", self.handback.clone());
		if let Some(c) = &self.consumer { o.insert("consumer", c.clone()); }
		if let Some(k) = &self.claim_key { o.insert("claimKey", k.as_str().into()); }
		if let Some(t) = &self.request_txn { o.insert("requestTxn", t.clone()); }
		if let Some(b) = self.if_exists { o.insert("ifExists", Json::Bool(b)); }
		if let Some(t) = self.authorized_until { o.insert("authorizedUntil", Json::Number(t)); }
		with_rest(o, &self.rest)
	}
}

/// `RegRec`: a subscription (notify). Conversations are rate limited: writes within `minIntervalMs` of the last event
/// are counted (`pending`) and sent bundled with the latest of them (`pendingEntry`).
#[derive(Clone, Debug, PartialEq)]
pub struct RegRec {
	pub id: String,
	pub template: Json,
	pub expires: f64,
	/// The transaction it was made under (`null`: none).
	pub txn: Json,
	pub handback: Json,
	pub target: Json,
	/// The last sequence number issued.
	pub seq: f64,
	pub consumer: Option<Json>,
	pub min_interval_ms: Option<f64>,
	pub last_event_at: Option<f64>,
	pub pending: Option<f64>,
	pub pending_entry: Option<Json>,
	pub rest: Object,
}

impl RegRec {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "registration";
		let mut f = Fields::of(v, w)?;
		Ok(RegRec {
			id: f.string("id", w)?,
			template: f.need("template", w)?,
			expires: f.number("expires", w)?,
			txn: f.need("txn", w)?,
			handback: f.need("handback", w)?,
			target: f.need("target", w)?,
			seq: f.number("seq", w)?,
			consumer: f.take("consumer"),
			min_interval_ms: f.opt_number("minIntervalMs", w)?,
			last_event_at: f.opt_number("lastEventAt", w)?,
			pending: f.opt_number("pending", w)?,
			pending_entry: f.take("pendingEntry"),
			rest: f.rest(),
		})
	}
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("id", self.id.as_str().into());
		o.insert("template", self.template.clone());
		o.insert("expires", Json::Number(self.expires));
		o.insert("txn", self.txn.clone());
		o.insert("handback", self.handback.clone());
		o.insert("target", self.target.clone());
		o.insert("seq", Json::Number(self.seq));
		if let Some(c) = &self.consumer { o.insert("consumer", c.clone()); }
		if let Some(n) = self.min_interval_ms { o.insert("minIntervalMs", Json::Number(n)); }
		if let Some(n) = self.last_event_at { o.insert("lastEventAt", Json::Number(n)); }
		if let Some(n) = self.pending { o.insert("pending", Json::Number(n)); }
		if let Some(e) = &self.pending_entry { o.insert("pendingEntry", e.clone()); }
		with_rest(o, &self.rest)
	}
}

/// One principal's durable mailbox (mailbox.ts): events by sequence number, acknowledged as a delivered prefix.
#[derive(Clone, Debug, PartialEq)]
pub struct Mailbox {
	pub principal: Json,
	pub epoch: String,
	pub next: f64,
	pub acked: f64,
	pub delivered: f64,
	/// Running tally of the JSON bytes of `events`.
	pub bytes: f64,
	/// `{seq, at, event}` items.
	pub events: Vec<Json>,
	/// What expiry dropped before it was acknowledged.
	pub gap: Option<Json>,
	pub rest: Object,
}

impl Mailbox {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "mailbox";
		let mut f = Fields::of(v, w)?;
		Ok(Mailbox {
			principal: f.need("principal", w)?,
			epoch: f.string("epoch", w)?,
			next: f.number("next", w)?,
			acked: f.number("acked", w)?,
			delivered: f.number("delivered", w)?,
			bytes: f.number("bytes", w)?,
			events: match f.need("events", w)? { Json::Array(a) => a, _ => return Err(ShapeError("mailbox.events is not an array".into())) },
			gap: f.take("gap"),
			rest: f.rest(),
		})
	}
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("principal", self.principal.clone());
		o.insert("epoch", self.epoch.as_str().into());
		o.insert("next", Json::Number(self.next));
		o.insert("acked", Json::Number(self.acked));
		o.insert("delivered", Json::Number(self.delivered));
		o.insert("bytes", Json::Number(self.bytes));
		o.insert("events", Json::Array(self.events.clone()));
		if let Some(g) = &self.gap { o.insert("gap", g.clone()); }
		with_rest(o, &self.rest)
	}
}

/// `{boxes: {...}}` of the mailboxes.
pub fn obj_boxes(m: &[(String, Mailbox)]) -> Json {
	let mut boxes = Object::new();
	for (k, b) in m {
		boxes.insert(k.clone(), b.to_json());
	}
	let mut o = Object::new();
	o.insert("boxes", Json::Object(boxes));
	Json::Object(o)
}

/// What a store answers about the claims it keeps on its disk (store/disk-map.ts `DiskMapSource`): the durable rows,
/// asked through the indexes on `at` (decidedAt), `grp` (generation) and `flag` (resultExpired).
pub trait ClaimSource: Send + Sync {
	fn get(&self, key: &str) -> Option<Json>;
	/// Rows with `at <= t` and no flag, or a flag and a group in `in_groups` or none of `known`; by key, at most `limit`.
	fn due(&self, t: f64, limit: usize, in_groups: &[String], known: &[String]) -> Vec<(String, Json)>;
	/// The smallest `at` above `t` among rows without flag.
	fn next_at(&self, t: f64) -> Option<f64>;
	/// Keys of rows of group `g`, at most `limit`.
	fn group(&self, g: &str, limit: usize) -> Vec<String>;
	/// Rows without `at` (the open requests).
	fn unindexed(&self) -> Vec<(String, Json)>;
	/// The first keys in key order, at most `limit`.
	fn first_ids(&self, limit: usize) -> Vec<String>;
	/// Every key: reads the whole map (only what asks for all of it on purpose).
	fn ids(&self) -> Vec<String>;
}

/// The claims of a space: a map in memory, or a map part on the disk (store/disk-map.ts `DiskMap`). The core takes the
/// branches core.ts takes for each (`diskMapOf`).
#[derive(Clone, Debug)]
pub enum Claims {
	Memory(MemoryClaims),
	Disk(DiskClaims),
}

/// Claims in memory: by key in O(1) however many a day brings (an `Object` is a list), in the order of a JavaScript
/// object (assigning keeps a key's place, a deleted key that comes back goes last).
#[derive(Clone, Debug, Default)]
pub struct MemoryClaims {
	map: std::collections::HashMap<String, (u64, Json)>,
	order: std::collections::BTreeMap<u64, String>,
	next: u64,
}
impl MemoryClaims {
	pub fn get(&self, k: &str) -> Option<&Json> { self.map.get(k).map(|(_, v)| v) }
	pub fn insert(&mut self, k: String, v: Json) {
		if let Some(slot) = self.map.get_mut(&k) {
			slot.1 = v;
			return;
		}
		self.next += 1;
		self.order.insert(self.next, k.clone());
		self.map.insert(k, (self.next, v));
	}
	pub fn remove(&mut self, k: &str) {
		if let Some((at, _)) = self.map.remove(k) {
			self.order.remove(&at);
		}
	}
	pub fn len(&self) -> usize { self.map.len() }
	pub fn is_empty(&self) -> bool { self.map.is_empty() }
	pub fn iter(&self) -> impl Iterator<Item = (&str, &Json)> { self.order.values().map(|k| (k.as_str(), &self.map[k].1)) }
	pub fn to_object(&self) -> Object { self.iter().map(|(k, v)| (k, v.clone())).collect() }
}
impl From<Object> for MemoryClaims {
	fn from(o: Object) -> Self {
		let mut m = MemoryClaims::default();
		for (k, v) in o.iter() {
			m.insert(k.to_owned(), v.clone());
		}
		m
	}
}
impl PartialEq for MemoryClaims {
	fn eq(&self, other: &Self) -> bool { self.len() == other.len() && self.iter().zip(other.iter()).all(|(a, b)| a == b) }
}
impl Default for Claims {
	fn default() -> Self { Claims::Memory(MemoryClaims::default()) }
}
impl PartialEq for Claims {
	fn eq(&self, other: &Claims) -> bool {
		match (self, other) {
			(Claims::Memory(a), Claims::Memory(b)) => a == b,
			(Claims::Disk(a), Claims::Disk(b)) => std::sync::Arc::ptr_eq(&a.source, &b.source) && a.held == b.held,
			_ => false,
		}
	}
}

/// A map part on the disk: memory holds what commits wrote that is not durable yet (`None`: deleted), with the number of
/// the commit that wrote it, and the records without `at` (open requests); everything else is read from the store when
/// asked for.
#[derive(Clone)]
pub struct DiskClaims {
	source: std::sync::Arc<dyn ClaimSource>,
	held: Vec<(String, Option<Json>, u64)>,
	/// The number of the commit that writes now (a host sets it; several commits may be on their way to the disk).
	pub stamp: u64,
	/// How often the whole map was read (`entries`): code that scans a day of claims shows here.
	pub enumerations: std::sync::Arc<std::sync::atomic::AtomicUsize>,
}
impl std::fmt::Debug for DiskClaims {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "DiskClaims {{ held: {} }}", self.held.len()) }
}

fn claim_at(v: &Json) -> Option<f64> { v.get("decidedAt").and_then(Json::as_f64) }
fn claim_flag(v: &Json) -> bool {
	match v.get("resultExpired") {
		None | Some(Json::Null) | Some(Json::Bool(false)) => false,
		Some(Json::Number(x)) => *x != 0.0 && !x.is_nan(),
		Some(Json::String(s)) => !s.is_empty(),
		Some(_) => true,
	}
}
/// `String(v.generation)`, as disk-map.ts compares groups of held records.
fn claim_group(v: &Json) -> String {
	match v.get("generation") {
		None => "undefined".into(),
		Some(Json::String(s)) => s.clone(),
		Some(other) => other.to_json_text(),
	}
}
/// JavaScript's default string order (UTF-16 code units).
fn js_order(a: &str, b: &str) -> std::cmp::Ordering { a.encode_utf16().cmp(b.encode_utf16()) }

impl DiskClaims {
	/// Over the rows of `source`: the open requests are held from the start.
	pub fn new(source: std::sync::Arc<dyn ClaimSource>) -> DiskClaims {
		let held = source.unindexed().into_iter().map(|(k, v)| (k, Some(v), 0)).collect();
		DiskClaims { source, held, stamp: 0, enumerations: Default::default() }
	}
	/// From a map in memory that commit `written` is writing to the disk now (`DiskMap.adopt`): every record held until
	/// that commit is durable.
	pub fn adopt(source: std::sync::Arc<dyn ClaimSource>, from: &MemoryClaims, written: u64) -> DiskClaims {
		let mut d = DiskClaims::new(source);
		d.stamp = written;
		for (k, v) in from.iter() {
			d.write(k, Some(v.clone()));
		}
		d
	}
	fn held_at(&self, k: &str) -> Option<&Option<Json>> { self.held.iter().find(|(x, _, _)| x == k).map(|(_, v, _)| v) }
	pub fn get(&self, k: &str) -> Option<Json> {
		match self.held_at(k) {
			Some(v) => v.clone(),
			None => self.source.get(k),
		}
	}
	pub fn write(&mut self, k: &str, v: Option<Json>) {
		let stamp = self.stamp;
		match self.held.iter_mut().find(|(x, _, _)| x == k) {
			Some(slot) => {
				slot.1 = v;
				slot.2 = stamp;
			}
			None => self.held.push((k.to_owned(), v, stamp)),
		}
	}
	/// The commits up to `durable` are on the disk: what they wrote is read from there from now on (open requests stay held).
	pub fn settle(&mut self, durable: u64) { self.held.retain(|(_, v, stamp)| *stamp > durable || v.as_ref().is_some_and(|v| claim_at(v).is_none())); }
	/// `unindexed`: the records memory holds without a decision time, which are the open requests.
	pub fn unindexed(&self) -> Vec<(String, Json)> { self.held.iter().filter_map(|(k, v, _)| v.as_ref().filter(|v| claim_at(v).is_none()).map(|v| (k.clone(), v.clone()))).collect() }
	/// How many records memory holds.
	pub fn held(&self) -> usize { self.held.len() }
	/// Every record: reads the whole map (counted in `enumerations`).
	pub fn entries(&self) -> Object {
		self.enumerations.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
		let mut out = Object::new();
		for k in self.source.ids() {
			if self.held_at(&k).is_none() {
				if let Some(v) = self.source.get(&k) {
					out.insert(k, v);
				}
			}
		}
		for (k, v, _) in &self.held {
			if let Some(v) = v {
				out.insert(k.clone(), v.clone());
			}
		}
		out
	}
	/// `due`: keys of records with `at <= t` that `pick` accepts, flagged ones only of a group in `in_groups` or none of
	/// `known`; in JavaScript's string order, at most `limit`.
	pub fn due(&self, t: f64, limit: usize, in_groups: &[String], known: &[String], pick: impl Fn(&Json) -> bool) -> Vec<String> {
		let mut out: Vec<String> = vec![];
		for (k, v) in self.source.due(t, limit + self.held.len(), in_groups, known) {
			if self.held_at(&k).is_none() && pick(&v) && !out.contains(&k) {
				out.push(k);
			}
		}
		for (k, v, _) in &self.held {
			let Some(v) = v else { continue };
			let Some(at) = claim_at(v) else { continue };
			if at > t {
				continue;
			}
			let g = claim_group(v);
			if claim_flag(v) && !in_groups.contains(&g) && known.contains(&g) {
				continue;
			}
			if pick(v) && !out.contains(k) {
				out.push(k.clone());
			}
		}
		out.sort_by(|a, b| js_order(a, b));
		out.truncate(limit);
		out
	}
	/// `nextAt`: the smallest `at` above `t` among records without flag.
	pub fn next_at(&self, t: f64) -> Option<f64> {
		let mut min = self.source.next_at(t);
		for v in self.held.iter().filter_map(|(_, v, _)| v.as_ref()) {
			if claim_flag(v) {
				continue;
			}
			if let Some(at) = claim_at(v).filter(|&a| a > t) {
				if min.is_none_or(|m| at < m) {
					min = Some(at);
				}
			}
		}
		min
	}
	/// `hasGroup`: whether a record of generation `g` exists.
	pub fn has_group(&self, g: &str) -> bool {
		if self.held.iter().any(|(_, v, _)| v.as_ref().is_some_and(|v| v.get("generation").and_then(Json::as_str) == Some(g))) {
			return true;
		}
		self.source.group(g, self.held.len() + 1).iter().any(|k| self.held_at(k).is_none())
	}
}

impl Claims {
	pub fn get(&self, k: &str) -> Option<Json> {
		match self {
			Claims::Memory(o) => o.get(k).cloned(),
			Claims::Disk(d) => d.get(k),
		}
	}
	/// Sets or deletes a record (in memory: as JavaScript assigns, an existing key keeps its place).
	pub fn put(&mut self, k: &str, v: Option<Json>) {
		match (self, v) {
			(Claims::Memory(o), Some(v)) => o.insert(k.to_owned(), v),
			(Claims::Memory(o), None) => o.remove(k),
			(Claims::Disk(d), v) => d.write(k, v),
		}
	}
	pub fn on_disk(&self) -> bool { matches!(self, Claims::Disk(_)) }
	/// Every record (a map on the disk is read whole: only for what asks for all of it).
	pub fn entries(&self) -> Object {
		match self {
			Claims::Memory(o) => o.to_object(),
			Claims::Disk(d) => d.entries(),
		}
	}
	/// The map in memory, for the branches that scan it (none for one on the disk).
	pub fn memory(&self) -> Option<&MemoryClaims> {
		match self {
			Claims::Memory(o) => Some(o),
			Claims::Disk(_) => None,
		}
	}
}

/// `RpcState`: request claims and generations (claims.ts). Claims and generations are kept as their JSON records,
/// keyed as in the document.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcState {
	pub generations: Object,
	pub claims: Claims,
	/// Running tally of claim and generation bytes; absent in states that predate it.
	pub bytes: Option<f64>,
	/// Result bytes reserved by pending claims.
	pub reserved_bytes: Option<f64>,
	pub signing_key: Option<String>,
	pub authority_id: Option<String>,
	/// The earliest time a sweep can find something to drop.
	pub sweep_at: Option<f64>,
	pub rest: Object,
}

impl RpcState {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "rpc";
		let mut f = Fields::of(v, w)?;
		Ok(RpcState {
			generations: f.object("generations", w)?,
			claims: Claims::Memory(f.object("claims", w)?.into()),
			bytes: f.opt_number("bytes", w)?,
			reserved_bytes: f.opt_number("reservedBytes", w)?,
			signing_key: f.opt_string("signingKey", w)?,
			authority_id: f.opt_string("authorityId", w)?,
			sweep_at: f.opt_number("sweepAt", w)?,
			rest: f.rest(),
		})
	}
	pub fn to_json(&self) -> Json { self.to_json_with(false) }
	/// `head`: with empty claims and generations (rows of their own in a store).
	pub fn to_json_with(&self, head: bool) -> Json { self.to_json_parts(head, head) }
	fn to_json_parts(&self, no_generations: bool, no_claims: bool) -> Json {
		let mut o = Object::new();
		o.insert("generations", Json::Object(if no_generations { Object::new() } else { self.generations.clone() }));
		o.insert("claims", Json::Object(if no_claims { Object::new() } else { self.claims.entries() }));
		if let Some(n) = self.bytes { o.insert("bytes", Json::Number(n)); }
		if let Some(n) = self.sweep_at { o.insert("sweepAt", Json::Number(n)); }
		if let Some(n) = self.reserved_bytes { o.insert("reservedBytes", Json::Number(n)); }
		if let Some(k) = &self.signing_key { o.insert("signingKey", k.as_str().into()); }
		if let Some(k) = &self.authority_id { o.insert("authorityId", k.as_str().into()); }
		with_rest(o, &self.rest)
	}
}

/// One operation of a change batch (stream.ts `Op`). Kept as its JSON: it is written once and only ever read back.
pub type StreamOp = Json;

/// A batch of the change stream: one per commit that changed what a plain reader sees.
#[derive(Clone, Debug, PartialEq)]
pub struct Batch { pub rev: f64, pub at: f64, pub ops: Vec<StreamOp>, pub rest: Object }

impl Batch {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "stream batch";
		let mut f = Fields::of(v, w)?;
		let rev = f.number("rev", w)?;
		let at = f.number("at", w)?;
		let ops = match f.need("ops", w)? { Json::Array(a) => a, _ => return Err(ShapeError("stream batch.ops is not an array".into())) };
		Ok(Batch { rev, at, ops, rest: f.rest() })
	}
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("rev", Json::Number(self.rev));
		o.insert("at", Json::Number(self.at));
		o.insert("ops", Json::Array(self.ops.clone()));
		with_rest(o, &self.rest)
	}
}

/// `StreamState`: revisions and the bounded log of change batches.
#[derive(Clone, Debug, PartialEq)]
pub struct StreamState {
	/// Revision of the newest batch (0: nothing yet).
	pub rev: f64,
	/// Batches up to and including this revision were dropped from the log.
	pub floor: f64,
	/// JSON bytes of the retained batches (running tally).
	pub bytes: f64,
	pub log: Vec<Batch>,
	pub rest: Object,
}

impl StreamState {
	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "stream";
		let mut f = Fields::of(v, w)?;
		let rev = f.number("rev", w)?;
		let floor = f.number("floor", w)?;
		let bytes = f.number("bytes", w)?;
		let log = match f.need("log", w)? { Json::Array(a) => a.iter().map(Batch::from_json).collect::<Result<_, _>>()?, _ => return Err(ShapeError("stream.log is not an array".into())) };
		Ok(StreamState { rev, floor, bytes, log, rest: f.rest() })
	}
	pub fn to_json(&self) -> Json { self.to_json_with(false) }
	/// `head`: with an empty log (the batches are rows of their own in a store).
	pub fn to_json_with(&self, head: bool) -> Json {
		let mut o = Object::new();
		o.insert("rev", Json::Number(self.rev));
		o.insert("floor", Json::Number(self.floor));
		o.insert("bytes", Json::Number(self.bytes));
		o.insert("log", Json::Array(if head { vec![] } else { self.log.iter().map(Batch::to_json).collect() }));
		with_rest(o, &self.rest)
	}
}

/// The document of one space.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceState {
	pub next_id: f64,
	pub entries: Entries,
	/// The open transactions in the order they were opened (the document keys them by id).
	pub txns: Vec<TxnRec>,
	pub regs: Vec<RegRec>,
	pub waiters: Vec<WaiterRec>,
	/// Mailboxes by principal id, in the order they were made; created by the first one.
	pub mailboxes: Option<Vec<(String, Mailbox)>>,
	/// Request claims and generations; created by the first request.
	pub rpc: Option<RpcState>,
	/// Entries given back by aborted or expired transactions, ever.
	pub returned: f64,
	/// Running tally of the outbox's JSON bytes; absent in states that predate it.
	pub outbox_bytes: Option<f64>,
	/// Immutable id of the space, set when it is registered.
	pub space_id: Option<String>,
	/// Replaced by a restore; local ids carry it.
	pub incarnation: Option<String>,
	/// Own quotas over the defaults (`Partial<Limits>`).
	pub limits: Option<Object>,
	pub stream: Option<StreamState>,
	/// Every other field of the document, as read.
	pub rest: Object,
}

/// The fields core.ts puts first in a fresh state (`initialState`), in its order; the rest follow as read.
const HEAD: [&str; 8] = ["nextId", "entries", "txns", "regs", "waiters", "outbox", "outboxBytes", "returned"];

impl SpaceState {
	/// `initialState()`.
	pub fn initial() -> Self {
		let mut rest = Object::new();
		rest.insert("outbox", Json::Array(vec![]));
		SpaceState { next_id: 1.0, entries: Entries::default(), txns: vec![], regs: vec![], waiters: vec![], mailboxes: None, rpc: None, returned: 0.0, outbox_bytes: Some(2.0), space_id: None, incarnation: None, limits: None, stream: None, rest }
	}

	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "space";
		let mut f = Fields::of(v, w)?;
		let next_id = f.number("nextId", w)?;
		let entries = match f.need("entries", w)? { Json::Array(a) => Entries::from(a.iter().map(EntryRec::from_json).collect::<Result<Vec<_>, _>>()?), _ => return Err(ShapeError("space.entries is not an array".into())) };
		let txns = match f.need("txns", w)? {
			Json::Object(o) => o.iter().map(|(_, t)| TxnRec::from_json(t)).collect::<Result<_, _>>()?,
			_ => return Err(ShapeError("space.txns is not an object".into())),
		};
		let regs = match f.need("regs", w)? {
			Json::Array(a) => a.iter().map(RegRec::from_json).collect::<Result<_, _>>()?,
			_ => return Err(ShapeError("space.regs is not an array".into())),
		};
		let mailboxes = match f.take("mailboxes") {
			None => None,
			Some(m) => {
				let boxes = m.get("boxes").and_then(Json::as_object).filter(|_| m.as_object().is_some_and(|o| o.len() == 1)).ok_or_else(|| ShapeError("space.mailboxes is not {boxes}".into()))?;
				Some(boxes.iter().map(|(k, b)| Mailbox::from_json(b).map(|b| (k.to_owned(), b))).collect::<Result<_, _>>()?)
			}
		};
		let waiters = match f.need("waiters", w)? {
			Json::Array(a) => a.iter().map(WaiterRec::from_json).collect::<Result<_, _>>()?,
			_ => return Err(ShapeError("space.waiters is not an array".into())),
		};
		let rpc = f.take("rpc").map(|r| RpcState::from_json(&r)).transpose()?;
		let returned = f.number("returned", w)?;
		let outbox_bytes = f.opt_number("outboxBytes", w)?;
		let space_id = f.opt_string("spaceId", w)?;
		let incarnation = f.opt_string("incarnation", w)?;
		let limits = match f.take("limits") { None => None, Some(Json::Object(o)) => Some(o), Some(_) => return Err(ShapeError("space.limits is not an object".into())) };
		let stream = f.take("stream").map(|s| StreamState::from_json(&s)).transpose()?;
		let rest = f.rest();
		if !rest.contains_key("outbox") { return Err(ShapeError("space.outbox is missing".into())); }
		Ok(SpaceState { next_id, entries, txns, regs, waiters, mailboxes, rpc, returned, outbox_bytes, space_id, incarnation, limits, stream, rest })
	}

	pub fn to_json(&self) -> Json { self.to_json_with(false, false) }
	/// The head of the document as a store keeps it (store/parts.ts `headOf` with the parts of a Space): entries, the
	/// stream log, claims and generations empty. Never serializes the parts.
	pub fn to_json_head(&self) -> Json { self.to_json_with(true, false) }
	/// The whole document but its claims (core.ts docBytes for claims on the disk: they are not read for it).
	pub fn to_json_without_claims(&self) -> Json { self.to_json_with(false, true) }
	fn to_json_with(&self, head: bool, no_claims: bool) -> Json {
		let mut o = Object::new();
		for key in HEAD {
			match key {
				"nextId" => o.insert(key, Json::Number(self.next_id)),
				"entries" => o.insert(key, Json::Array(if head { vec![] } else { self.entries.iter().map(EntryRec::to_json).collect() })),
				"outboxBytes" => if let Some(n) = self.outbox_bytes { o.insert(key, Json::Number(n)) },
				"returned" => o.insert(key, Json::Number(self.returned)),
				"txns" => o.insert(key, Json::Object(self.txns.iter().map(|t| (t.id.clone(), t.to_json())).collect())),
				"waiters" => o.insert(key, Json::Array(self.waiters.iter().map(WaiterRec::to_json).collect())),
				"regs" => o.insert(key, Json::Array(self.regs.iter().map(RegRec::to_json).collect())),
				_ => if let Some(v) = self.rest.get(key) { o.insert(key, v.clone()) },
			}
		}
		if let Some(l) = &self.limits { o.insert("limits", Json::Object(l.clone())); }
		if let Some(s) = &self.space_id { o.insert("spaceId", s.as_str().into()); }
		if let Some(s) = &self.incarnation { o.insert("incarnation", s.as_str().into()); }
		if let Some(r) = &self.rpc { o.insert("rpc", r.to_json_parts(head, head || no_claims)); }
		if let Some(m) = &self.mailboxes { o.insert("mailboxes", obj_boxes(m)); }
		if let Some(s) = &self.stream { o.insert("stream", s.to_json_with(head)); }
		for (k, v) in self.rest.iter() { if !o.contains_key(k) { o.insert(k, v.clone()); } }
		Json::Object(o)
	}
}
