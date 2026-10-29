//! The space state as the TypeScript code stores it (`SpaceState` in src/core.ts, the document `phi-spaces.space`).
//!
//! Under decision R-D1 both implementations read and write the same documents, so a state read here must write back
//! exactly what was read: every field this crate does not model yet stays in `rest`, verbatim, and every field it
//! models keeps the difference between absent and `null` (the byte budgets count `JSON.stringify` output, where an
//! absent field costs nothing and a `null` one costs its key).
//!
//! Modelled so far (R1, slice 1): the scalars, the entries and the change stream. The rest of the document (txns,
//! regs, waiters, outbox, rpc, mailboxes, …) is carried as JSON until its slice is ported.
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
		rest.insert("txns", Json::Object(Object::new()));
		rest.insert("regs", Json::Array(vec![]));
		rest.insert("waiters", Json::Array(vec![]));
		rest.insert("outbox", Json::Array(vec![]));
		SpaceState { next_id: 1.0, entries: vec![], returned: 0.0, outbox_bytes: Some(2.0), space_id: None, incarnation: None, limits: None, stream: None, rest }
	}

	pub fn from_json(v: &Json) -> Result<Self, ShapeError> {
		let w = "space";
		let mut f = Fields::of(v, w)?;
		let next_id = f.number("nextId", w)?;
		let entries = match f.need("entries", w)? { Json::Array(a) => a.iter().map(EntryRec::from_json).collect::<Result<_, _>>()?, _ => return Err(ShapeError("space.entries is not an array".into())) };
		let returned = f.number("returned", w)?;
		let outbox_bytes = f.opt_number("outboxBytes", w)?;
		let space_id = f.opt_string("spaceId", w)?;
		let incarnation = f.opt_string("incarnation", w)?;
		let limits = match f.take("limits") { None => None, Some(Json::Object(o)) => Some(o), Some(_) => return Err(ShapeError("space.limits is not an object".into())) };
		let stream = f.take("stream").map(|s| StreamState::from_json(&s)).transpose()?;
		let rest = f.rest();
		for key in ["txns", "regs", "waiters", "outbox"] {
			if !rest.contains_key(key) { return Err(ShapeError(format!("space.{key} is missing"))); }
		}
		Ok(SpaceState { next_id, entries, returned, outbox_bytes, space_id, incarnation, limits, stream, rest })
	}

	pub fn to_json(&self) -> Json {
		let mut o = Object::new();
		for key in HEAD {
			match key {
				"nextId" => o.insert(key, Json::Number(self.next_id)),
				"entries" => o.insert(key, Json::Array(self.entries.iter().map(EntryRec::to_json).collect())),
				"outboxBytes" => if let Some(n) = self.outbox_bytes { o.insert(key, Json::Number(n)) },
				"returned" => o.insert(key, Json::Number(self.returned)),
				_ => if let Some(v) = self.rest.get(key) { o.insert(key, v.clone()) },
			}
		}
		if let Some(l) = &self.limits { o.insert("limits", Json::Object(l.clone())); }
		if let Some(s) = &self.space_id { o.insert("spaceId", s.as_str().into()); }
		if let Some(s) = &self.incarnation { o.insert("incarnation", s.as_str().into()); }
		if let Some(s) = &self.stream { o.insert("stream", s.to_json()); }
		for (k, v) in self.rest.iter() { if !o.contains_key(k) { o.insert(k, v.clone()); } }
		Json::Object(o)
	}
}
