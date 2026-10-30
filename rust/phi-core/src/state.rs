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

/// `RpcState`: request claims and generations (claims.ts). Claims and generations are kept as their JSON records,
/// keyed as in the document.
#[derive(Clone, Debug, PartialEq)]
pub struct RpcState {
	pub generations: Object,
	pub claims: Object,
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
			claims: f.object("claims", w)?,
			bytes: f.opt_number("bytes", w)?,
			reserved_bytes: f.opt_number("reservedBytes", w)?,
			signing_key: f.opt_string("signingKey", w)?,
			authority_id: f.opt_string("authorityId", w)?,
			sweep_at: f.opt_number("sweepAt", w)?,
			rest: f.rest(),
		})
	}
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("generations", Json::Object(self.generations.clone()));
		o.insert("claims", Json::Object(self.claims.clone()));
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
	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		o.insert("rev", Json::Number(self.rev));
		o.insert("floor", Json::Number(self.floor));
		o.insert("bytes", Json::Number(self.bytes));
		o.insert("log", Json::Array(self.log.iter().map(Batch::to_json).collect()));
		with_rest(o, &self.rest)
	}
}

/// The document of one space.
#[derive(Clone, Debug, PartialEq)]
pub struct SpaceState {
	pub next_id: f64,
	pub entries: Vec<EntryRec>,
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
		SpaceState { next_id: 1.0, entries: vec![], txns: vec![], regs: vec![], waiters: vec![], mailboxes: None, rpc: None, returned: 0.0, outbox_bytes: Some(2.0), space_id: None, incarnation: None, limits: None, stream: None, rest }
	}

	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "space";
		let mut f = Fields::of(v, w)?;
		let next_id = f.number("nextId", w)?;
		let entries = match f.need("entries", w)? { Json::Array(a) => a.iter().map(EntryRec::from_json).collect::<Result<_, _>>()?, _ => return Err(ShapeError("space.entries is not an array".into())) };
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
		for key in ["outbox"] {
			if !rest.contains_key(key) { return Err(ShapeError(format!("space.{key} is missing"))); }
		}
		Ok(SpaceState { next_id, entries, txns, regs, waiters, mailboxes, rpc, returned, outbox_bytes, space_id, incarnation, limits, stream, rest })
	}

	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		for key in HEAD {
			match key {
				"nextId" => o.insert(key, Json::Number(self.next_id)),
				"entries" => o.insert(key, Json::Array(self.entries.iter().map(EntryRec::to_json).collect())),
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
		if let Some(r) = &self.rpc { o.insert("rpc", r.to_json()); }
		if let Some(m) = &self.mailboxes { o.insert("mailboxes", obj_boxes(m)); }
		if let Some(s) = &self.stream { o.insert("stream", s.to_json()); }
		for (k, v) in self.rest.iter() { if !o.contains_key(k) { o.insert(k, v.clone()); } }
		Json::Object(o)
	}
}
