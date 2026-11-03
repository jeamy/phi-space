//! Entry replication (`src/entry-replication.ts`, `src/entry-replication-stream.ts`, `src/entry-replication-transfer.ts`,
//! `src/replication-clock.ts`): the lww and set types of one Space, merged between replicas by hybrid clocks, held in
//! six document families beside the Spaces. Every validation, refusal and stored value is TypeScript's; the walk of
//! `phi-service/tests/entry_walk.rs` holds them against `test/support/entry-driver.ts`.
//!
//! The controller is synchronous: a step reads its documents and commits them in one call on the owner thread, so
//! nothing commits between. What it wrote is kept here until the file has it (`stored_document` reads only what is
//! durable), so the next step reads its own writes as `tx.doc` does.
use phi_json::{canonical_key, digest_json, obj, parse, safe_integer, utf16_cmp, Json, Object};
use phi_store::{Store, WriteOp};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

// ---- errors

/// The classes TypeScript throws, by name.
#[derive(Clone, Debug, PartialEq)]
pub enum EntryError {
	/// `ReplicationConflict`
	Conflict(String),
	/// `ReplicationClockError`
	Clock(String),
	/// `ResourceExhausted`
	Exhausted(String),
	/// `SnapshotExpired`
	Expired(String),
	/// `RequestConflict`
	Request(String),
	/// `EntryStreamCursorConflict`: the durable cursor.
	Cursor(f64),
	/// What a check or the store refused with.
	Other { class: String, message: String },
}
impl EntryError {
	pub fn class(&self) -> &str {
		match self {
			EntryError::Conflict(_) => "ReplicationConflict",
			EntryError::Clock(_) => "ReplicationClockError",
			EntryError::Exhausted(_) => "ResourceExhausted",
			EntryError::Expired(_) => "SnapshotExpired",
			EntryError::Request(_) => "RequestConflict",
			EntryError::Cursor(_) => "EntryStreamCursorConflict",
			EntryError::Other { class, .. } => class,
		}
	}
	pub fn message(&self) -> String {
		match self {
			EntryError::Conflict(m) | EntryError::Clock(m) | EntryError::Exhausted(m) | EntryError::Expired(m) | EntryError::Request(m) => m.clone(),
			EntryError::Cursor(_) => "source cursor changed; reload the durable checkpoint".into(),
			EntryError::Other { message, .. } => message.clone(),
		}
	}
}
pub type ER<T> = Result<T, EntryError>;
fn conflict<T>(m: &str) -> ER<T> { Err(EntryError::Conflict(m.into())) }
fn exhausted<T>(m: &str) -> ER<T> { Err(EntryError::Exhausted(m.into())) }
fn clock_error<T>(m: &str) -> ER<T> { Err(EntryError::Clock(m.into())) }

// ---- JSON as TypeScript sees it

fn canonical(v: &Json) -> String { canonical_key(v).unwrap_or_default() }
fn bytes(v: &Json) -> usize { canonical(v).len() }
fn hash(v: &Json) -> String { digest_json(v).unwrap_or_default() }
fn id_text(s: &str) -> bool {
	let b = s.as_bytes();
	!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-'))
}
fn id(v: Option<&Json>) -> bool { v.and_then(Json::as_str).is_some_and(id_text) }
fn number(v: Option<&Json>) -> bool { v.and_then(Json::as_f64).is_some_and(|n| safe_integer(n) && n >= 0.0) }
fn sha(v: Option<&Json>) -> bool { v.and_then(Json::as_str).is_some_and(phi_json::is_sha256_hex) }
fn safe(n: f64) -> bool { safe_integer(n) }
/// `Object.keys(v)`.
fn keys_of(v: &Json) -> Vec<String> {
	match v {
		Json::Object(o) => o.keys().map(str::to_owned).collect(),
		Json::Array(a) => (0..a.len()).map(|i| i.to_string()).collect(),
		Json::String(s) => (0..s.encode_utf16().count()).map(|i| i.to_string()).collect(),
		_ => vec![],
	}
}
/// `exact(v, keys)`: the sorted keys, joined, are the sorted names, joined.
fn exact(v: &Json, names: &[&str]) -> bool {
	let mut a = keys_of(v);
	a.sort_by(|x, y| utf16_cmp(x, y));
	let mut b: Vec<&str> = names.to_vec();
	b.sort_by(|x, y| utf16_cmp(x, y));
	a.join(",") == b.join(",")
}
/// JavaScript truthiness.
fn truthy(v: Option<&Json>) -> bool {
	match v {
		None | Some(Json::Null) | Some(Json::Bool(false)) => false,
		Some(Json::Number(n)) => *n != 0.0 && !n.is_nan(),
		Some(Json::String(s)) => !s.is_empty(),
		_ => true,
	}
}
/// `String(v)`.
fn js_string(v: &Json) -> String {
	match v {
		Json::String(s) => s.clone(),
		Json::Null => "null".into(),
		Json::Bool(b) => b.to_string(),
		Json::Number(n) => phi_json::number_text(*n),
		Json::Array(a) => a.iter().map(|x| if x.is_null() { String::new() } else { js_string(x) }).collect::<Vec<_>>().join(","),
		Json::Object(_) => "[object Object]".into(),
	}
}
/// `JSON.parse(v)` of what `String(v)` makes of it.
fn js_parse(v: &Json) -> Option<Json> { parse(&js_string(v)).ok() }
/// `strictJsonCopy`: plain JSON no deeper than 64 levels.
fn copy(v: &Json) -> ER<Json> {
	fn depth(v: &Json, d: usize) -> bool {
		if d > 64 {
			return false;
		}
		match v {
			Json::Array(a) => a.iter().all(|x| depth(x, d + 1)),
			Json::Object(o) => o.iter().all(|(_, x)| depth(x, d + 1)),
			_ => true,
		}
	}
	if !depth(v, 0) {
		return conflict("JSON nesting exceeds 64 levels");
	}
	Ok(v.json_copy())
}
fn s<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap_or("") }
fn n(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn list<'a>(v: &'a Json, k: &str) -> &'a [Json] { v.get(k).and_then(Json::as_array).map_or(&[], |a| a) }
fn put(v: &mut Json, k: &str, x: Json) {
	if let Some(o) = v.as_object_mut() {
		o.insert(k, x);
	}
}
fn bump(v: &mut Json, k: &str, by: f64) {
	let x = n(v, k) + by;
	put(v, k, num(x));
}
fn obj_mut<'a>(v: &'a mut Json, k: &str) -> &'a mut Object {
	if !matches!(v.get(k), Some(Json::Object(_))) {
		put(v, k, Json::Object(Object::new()));
	}
	v.as_object_mut().and_then(|o| o.get_mut(k)).and_then(Json::as_object_mut).expect("an object")
}
fn arr_mut<'a>(v: &'a mut Json, k: &str) -> &'a mut Vec<Json> {
	if !matches!(v.get(k), Some(Json::Array(_))) {
		put(v, k, Json::Array(vec![]));
	}
	v.as_object_mut().and_then(|o| o.get_mut(k)).and_then(Json::as_array_mut).expect("an array")
}
fn without(v: &Json, drop: &[&str]) -> Json { Json::Object(v.as_object().map(|o| o.iter().filter(|(k, _)| !drop.contains(k)).map(|(k, x)| (k, x.clone())).collect()).unwrap_or_default()) }
fn is_object(v: &Json) -> bool { matches!(v, Json::Object(_)) }
fn is_string(v: &Json) -> bool { matches!(v, Json::String(_)) }
fn lt(a: &str, b: &str) -> bool { utf16_cmp(a, b) == Ordering::Less }
fn num(x: f64) -> Json { Json::Number(x) }
fn hex(b: &[u8]) -> String { phi_json::hex(b) }

// ---- the hybrid clock (src/replication-clock.ts)

pub fn validate_clock(v: Option<&Json>) -> ER<()> {
	let Some(v) = v else { return clock_error("invalid hybrid clock") };
	let mut k = keys_of(v);
	k.sort_by(|x, y| utf16_cmp(x, y));
	let ok = |key| v.get(key).and_then(Json::as_f64).is_some_and(|x| safe(x) && x >= 0.0);
	if matches!(v, Json::Null) || k.join(",") != "logical,physical" || !ok("physical") || !ok("logical") {
		return clock_error("invalid hybrid clock");
	}
	Ok(())
}
pub fn compare_clock(a: &Json, b: &Json) -> Ordering {
	let (ap, al, bp, bl) = (n(a, "physical"), n(a, "logical"), n(b, "physical"), n(b, "logical"));
	if ap < bp {
		Ordering::Less
	} else if ap > bp {
		Ordering::Greater
	} else if al < bl {
		Ordering::Less
	} else if al > bl {
		Ordering::Greater
	} else {
		Ordering::Equal
	}
}
pub fn advance_clock(local: &Json, now: f64, remote: Option<&Json>) -> ER<Json> {
	validate_clock(Some(local))?;
	if !safe(now) || now < 0.0 {
		return clock_error("invalid clock time or future bound");
	}
	if let Some(r) = remote {
		validate_clock(Some(r))?;
		if n(r, "physical") - now > 60_000.0 {
			return clock_error("remote clock exceeds future bound");
		}
	}
	let (lp, ll) = (n(local, "physical"), n(local, "logical"));
	let rp = remote.map(|r| n(r, "physical"));
	let physical = now.max(lp).max(rp.unwrap_or(0.0));
	let logical = if physical == lp && Some(physical) == rp {
		ll.max(n(remote.unwrap(), "logical")) + 1.0
	} else if physical == lp {
		ll + 1.0
	} else if Some(physical) == rp {
		n(remote.unwrap(), "logical") + 1.0
	} else {
		0.0
	};
	if !safe(logical) {
		return clock_error("hybrid clock exhausted");
	}
	Ok(obj! { "physical" => physical, "logical" => logical })
}

// ---- the documents

struct Def {
	kind: &'static str,
	version: i64,
	initial: fn() -> Json,
}
pub const REPLICAS: &str = "phi-spaces.entry-replica";
const STATE: Def = Def { kind: REPLICAS, version: 2, initial: || obj! { "config" => Json::Null, "configHash" => "", "clock" => obj! { "physical" => 0.0, "logical" => 0.0 }, "lastWallTime" => 0.0, "seq" => 0.0, "events" => Json::Array(vec![]), "segments" => Json::Array(vec![]) } };
const PEERS: Def = Def { kind: "phi-spaces.entry-replica-peers", version: 1, initial: || obj! { "peers" => Object::new() } };
const TRANSFERS: Def = Def { kind: "phi-spaces.entry-snapshot-transfers", version: 1, initial: || obj! { "retainedBytes" => 0.0, "transfers" => Object::new() } };
const CHUNKS: Def = Def { kind: "phi-spaces.entry-snapshot-chunk", version: 1, initial: || obj! { "page" => Json::Null } };
const MAINTENANCE: Def = Def { kind: "phi-spaces.entry-snapshot-maintenance", version: 1, initial: || obj! { "job" => Json::Null } };
const CHECKPOINTS: Def = Def { kind: "phi-spaces.entry-stream-checkpoints", version: 1, initial: || obj! { "links" => Object::new() } };
/// The six kinds this controller keeps.
pub const KINDS: [&str; 6] = [REPLICAS, "phi-spaces.entry-replica-peers", "phi-spaces.entry-snapshot-transfers", "phi-spaces.entry-snapshot-chunk", "phi-spaces.entry-snapshot-maintenance", "phi-spaces.entry-stream-checkpoints"];

fn migrate(def: &Def, version: i64, mut v: Json) -> Json {
	if def.kind == REPLICAS && version < 2 && !matches!(v.get("segments"), Some(x) if !x.is_null()) {
		put(&mut v, "segments", Json::Array(vec![]));
	}
	v
}

/// What the file holds of a document, or what this controller last committed of it (`None`: none, or retired).
type Cache = HashMap<(String, String), Option<(i64, Json)>>;

fn stored(store: &Store, cache: &RefCell<Cache>, kind: &str, key: &str) -> ER<Option<(i64, Json)>> {
	let k = (kind.to_owned(), key.to_owned());
	if let Some(v) = cache.borrow().get(&k) {
		return Ok(v.clone());
	}
	let v = store.stored_document_versioned(kind, Some(key)).map_err(|e| EntryError::Other { class: "Error".into(), message: e.to_string() })?;
	cache.borrow_mut().insert(k, v.clone());
	Ok(v)
}

struct Draft {
	kind: &'static str,
	version: i64,
	key: String,
	value: Json,
	before: Option<String>,
	fresh: bool,
	migrated: bool,
}
/// One commit's documents (`StoreTx`): a document read is written when it was absent, migrated or changed.
pub struct Tx<'a> {
	store: &'a Store,
	cache: &'a RefCell<Cache>,
	docs: Vec<Draft>,
	retired: Vec<(&'static str, String)>,
}
impl<'a> Tx<'a> {
	fn doc(&mut self, def: &Def, key: &str) -> ER<(usize, Json)> {
		if let Some(i) = self.docs.iter().position(|d| d.kind == def.kind && d.key == key) {
			return Ok((i, self.docs[i].value.clone()));
		}
		let (value, fresh, migrated) = match stored(self.store, self.cache, def.kind, key)? {
			None => ((def.initial)(), true, false),
			Some((version, v)) => (migrate(def, version, v), false, version != def.version),
		};
		self.docs.push(Draft { kind: def.kind, version: def.version, key: key.to_owned(), before: (!fresh).then(|| canonical(&value)), value: value.clone(), fresh, migrated });
		self.retired.retain(|(k, x)| !(*k == def.kind && x == key));
		Ok((self.docs.len() - 1, value))
	}
	fn set(&mut self, i: usize, v: Json) { self.docs[i].value = v; }
	fn retire(&mut self, def: &Def, key: &str) {
		self.docs.retain(|d| !(d.kind == def.kind && d.key == key));
		self.retired.push((def.kind, key.to_owned()));
	}
}

// ---- configuration

fn rule_of<'a>(config: &'a Json, type_: &str) -> Option<&'a Json> { list(config, "rules").iter().find(|r| s(r, "type") == type_) }
fn member_key(m: &Json) -> String { canonical(&Json::Array(vec![m.get("replicaId").cloned().unwrap_or(Json::Null), m.get("incarnation").cloned().unwrap_or(Json::Null)])) }
pub fn entry_change_id(e: &Json) -> String { canonical(&Json::Array(vec![e.get("originReplicaId").cloned().unwrap_or(Json::Null), e.get("incarnation").cloned().unwrap_or(Json::Null), e.get("seq").cloned().unwrap_or(Json::Null)])) }
fn origin(e: &Json) -> String { canonical(&Json::Array(vec![e.get("originReplicaId").cloned().unwrap_or(Json::Null), e.get("incarnation").cloned().unwrap_or(Json::Null)])) }
fn lww_key(rule: &Json, fields: &Json) -> ER<String> {
	let mut out = vec![];
	for k in list(rule, "keyFields") {
		match fields.as_object().and_then(|f| f.get(k.as_str().unwrap_or(""))) {
			Some(v) => out.push(v.clone()),
			None => return conflict("missing lww key field"),
		}
	}
	Ok(canonical(&Json::Array(vec![rule.get("type").cloned().unwrap_or(Json::Null), Json::Array(out)])))
}

fn config_of(input: &Json) -> ER<Json> {
	let mut c = copy(input)?;
	let ids = ["spaceId", "authorityId", "replicaId", "incarnation"].iter().all(|k| id(c.get(k)));
	let members = c.get("members").and_then(Json::as_array).cloned();
	let rules = c.get("rules").and_then(Json::as_array).cloned();
	if !truthy(Some(&c)) || !exact(&c, &["spaceId", "authorityId", "replicaId", "incarnation", "members", "rules"]) || !ids || members.as_ref().is_none_or(|m| m.is_empty() || m.len() > 32) || rules.as_ref().is_none_or(|r| r.is_empty() || r.len() > 64) {
		return conflict("invalid replication configuration");
	}
	let (members, rules) = (members.unwrap(), rules.unwrap());
	let distinct = members.iter().map(|m| s(m, "replicaId").to_owned()).collect::<HashSet<_>>().len() == members.len();
	if members.iter().any(|m| !is_object(m) || !exact(m, &["replicaId", "incarnation"]) || !id(m.get("replicaId")) || !id(m.get("incarnation"))) || !distinct || !members.iter().any(|m| m.get("replicaId") == c.get("replicaId") && m.get("incarnation") == c.get("incarnation")) {
		return conflict("invalid or missing replica membership");
	}
	let types = rules.iter().map(|r| r.get("type").map(canonical).unwrap_or_default()).collect::<HashSet<_>>().len();
	let bad = |r: &Json| {
		if !is_object(r) || !id(r.get("type")) || !matches!(r.get("variant").and_then(Json::as_str), Some("lww" | "set")) {
			return true;
		}
		if s(r, "variant") == "lww" {
			let k = r.get("keyFields").and_then(Json::as_array);
			!exact(r, &["type", "variant", "keyFields"]) || k.is_none_or(|k| k.is_empty() || k.len() > 16 || k.iter().map(canonical).collect::<HashSet<_>>().len() != k.len() || k.iter().any(|x| !id(Some(x))))
		} else {
			!exact(r, &["type", "variant"])
		}
	};
	if types != rules.len() || rules.iter().any(bad) {
		return conflict("invalid replication rules");
	}
	let mut members = members;
	members.sort_by(|a, b| if lt(s(a, "replicaId"), s(b, "replicaId")) { Ordering::Less } else { Ordering::Greater });
	let mut rules = rules;
	rules.sort_by(|a, b| if lt(s(a, "type"), s(b, "type")) { Ordering::Less } else { Ordering::Greater });
	put(&mut c, "members", Json::Array(members));
	put(&mut c, "rules", Json::Array(rules));
	if bytes(&c) > 8192 {
		return exhausted("replica configuration exceeds 8 KiB");
	}
	Ok(c)
}

// ---- positions and runs

fn runs_of_json(v: Option<&Json>) -> Vec<(f64, f64)> { v.and_then(Json::as_array).map_or(vec![], |a| a.iter().map(|r| (r.as_array().and_then(|x| x.first()).and_then(Json::as_f64).unwrap_or(0.0), r.as_array().and_then(|x| x.get(1)).and_then(Json::as_f64).unwrap_or(0.0))).collect()) }
fn runs_json(runs: &[(f64, f64)]) -> Json { Json::Array(runs.iter().map(|(a, b)| Json::Array(vec![num(*a), num(*b)])).collect()) }
fn dropped_count(runs: &[(f64, f64)]) -> f64 { runs.iter().map(|(a, b)| b - a + 1.0).sum() }
/// `positionsOf`: the stream position of each retained event, in logical order.
pub fn positions_of(count: usize, runs: &[(f64, f64)]) -> Vec<f64> {
	let (mut out, mut p, mut r) = (Vec::with_capacity(count), 0.0, 0);
	while out.len() < count {
		p += 1.0;
		while r < runs.len() && runs[r].1 < p {
			r += 1;
		}
		if r < runs.len() && runs[r].0 <= p {
			continue;
		}
		out.push(p);
	}
	out
}
fn head_of(st: &Json) -> f64 { list(st, "events").len() as f64 + dropped_count(&runs_of_json(st.get("dropped"))) }
fn contiguous(after: f64, positions: &[f64]) -> bool { positions.iter().enumerate().all(|(i, p)| *p == after + i as f64 + 1.0) }
/// `mergeRuns`: the sorted, merged union of position runs.
pub fn merge_runs(lists: &[&[(f64, f64)]]) -> Vec<(f64, f64)> {
	let mut all: Vec<(f64, f64)> = lists.iter().flat_map(|l| l.iter().copied()).collect();
	all.sort_by(|x, y| x.0.partial_cmp(&y.0).unwrap_or(Ordering::Equal));
	let mut out: Vec<(f64, f64)> = vec![];
	for r in all {
		match out.last_mut() {
			Some(last) if r.0 <= last.1 + 1.0 => last.1 = last.1.max(r.1),
			_ => out.push(r),
		}
	}
	out
}
fn in_runs(p: f64, runs: &[(f64, f64)]) -> bool { runs.iter().any(|(a, b)| *a <= p && p <= *b) }

fn manifest_seed(m: &Json) -> String { hash(&without(m, &["seedHash", "rootHash"])) }
fn page_hash(p: &Json) -> String { hash(&without(p, &["sha256"])) }
fn chunk_key(document_key: &str, snapshot_id: &str, index: f64) -> String { hash(&Json::Array(vec![document_key.into(), snapshot_id.into(), num(index)])) }
fn kind_of(m: &Json) -> &str { s(m, "kind") }
fn mutation(e: &Json) -> &Json { e.get("mutation").unwrap_or(&Json::Null) }

/// An exported snapshot of this host: its manifest and pages.
struct Exported {
	manifest: Json,
	pages: Vec<Json>,
}

/// `authorize(action)` and `assertActive()` of a step.
pub type Check = Rc<dyn Fn(&str) -> ER<()>>;
/// A page's frame for its events, their positions, `next` and `more`, as `pageAfter` measures it.
type Frame<'a> = &'a dyn Fn(&[Json], &[f64], f64, bool) -> Json;

pub struct EntryOptions {
	pub config: Json,
	/// The Space whose commits carry the documents (`None`: the default).
	pub space: Option<String>,
	/// `authorize(action)` and `assertActive()` in one, at every place TypeScript calls them.
	pub check: Check,
	pub now: Rc<dyn Fn() -> f64>,
	pub clock_uncertainty_ms: Rc<dyn Fn() -> f64>,
	/// Snapshot ids (`randomBytes(16)`).
	pub random: Box<dyn FnMut(usize) -> Vec<u8>>,
	pub max_history_bytes: Option<f64>,
	pub max_batch_bytes: Option<f64>,
	pub request_retention_ms: Option<f64>,
}

/// `EntryReplicationController`.
pub struct EntryReplication {
	config: Json,
	config_hash: String,
	pub document_key: String,
	pub max_history_bytes: f64,
	pub max_batch_bytes: f64,
	space: Option<String>,
	check_fn: Check,
	now_fn: Rc<dyn Fn() -> f64>,
	uncertainty: Rc<dyn Fn() -> f64>,
	random: RefCell<Box<dyn FnMut(usize) -> Vec<u8>>>,
	retention: Option<f64>,
	cache: RefCell<Cache>,
	exports: RefCell<Vec<(String, Exported)>>,
}

const ENTRY_EXPIRY_GRACE_MS: f64 = 60_000.0;
const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";

impl EntryReplication {
	pub fn new(o: EntryOptions) -> ER<EntryReplication> {
		let config = config_of(&o.config)?;
		let config_hash = hash(&obj! { "spaceId" => config.get("spaceId").cloned().unwrap(), "authorityId" => config.get("authorityId").cloned().unwrap(), "members" => config.get("members").cloned().unwrap(), "rules" => config.get("rules").cloned().unwrap() });
		let document_key = canonical(&Json::Array(vec![config.get("spaceId").cloned().unwrap(), config.get("replicaId").cloned().unwrap(), config.get("incarnation").cloned().unwrap()]));
		let (h, b) = (o.max_history_bytes.unwrap_or(16.0 * 1024.0 * 1024.0), o.max_batch_bytes.unwrap_or(192.0 * 1024.0));
		if !safe(h) || h < 16384.0 || h > 64.0 * 1024.0 * 1024.0 || !safe(b) || b < 32768.0 || b > 192.0 * 1024.0 {
			return conflict("invalid replication byte limits");
		}
		Ok(EntryReplication { config, config_hash, document_key, max_history_bytes: h, max_batch_bytes: b, space: o.space, check_fn: o.check, now_fn: o.now, uncertainty: o.clock_uncertainty_ms, random: RefCell::new(o.random), retention: o.request_retention_ms, cache: RefCell::new(HashMap::new()), exports: RefCell::new(vec![]) })
	}
	pub fn config(&self) -> &Json { &self.config }
	pub fn rules(&self) -> &[Json] { list(&self.config, "rules") }
	pub fn rule(&self, type_: &str) -> Option<&Json> { rule_of(&self.config, type_) }
	/// The source of snapshot ids from now on (a walk seeds it for every line).
	pub fn set_random(&self, r: Box<dyn FnMut(usize) -> Vec<u8>>) { *self.random.borrow_mut() = r; }
	/// Forgets what was kept of the documents: the next step reads the file.
	pub fn forget(&self) { self.cache.borrow_mut().clear(); }
	fn replica_id(&self) -> &str { s(&self.config, "replicaId") }
	fn incarnation(&self) -> &str { s(&self.config, "incarnation") }
	fn own(&self, e: &Json) -> bool { s(e, "originReplicaId") == self.replica_id() && s(e, "incarnation") == self.incarnation() && e.get("originReplicaId").is_some_and(is_string) && e.get("incarnation").is_some_and(is_string) }
	fn members(&self) -> &[Json] { list(&self.config, "members") }
	fn member(&self, replica: Option<&Json>, incarnation: Option<&Json>) -> bool { self.members().iter().any(|m| m.get("replicaId") == replica && m.get("incarnation") == incarnation) }
	fn now(&self) -> ER<f64> {
		let n = (self.now_fn)();
		if !(safe(n) && n >= 0.0) {
			return clock_error("invalid wall clock");
		}
		Ok(n)
	}
	fn clock_safe(&self, last_wall_time: f64, now: f64) -> ER<()> {
		let u = (self.uncertainty)();
		if !u.is_finite() || u < 0.0 || u >= 5000.0 || last_wall_time - now > 5000.0 {
			return clock_error("clock uncertainty or backward jump blocks timed operations");
		}
		Ok(())
	}
	fn check(&self, action: &str) -> ER<()> { (self.check_fn)(action) }
	fn bind(&self, st: &Json) -> ER<()> {
		if truthy(st.get("config")) && (s(st, "configHash") != self.config_hash || st.get("configHash").is_none_or(|h| !is_string(h)) || canonical(st.get("config").unwrap()) != canonical(&self.config)) {
			return conflict("stored replica configuration changed; explicit rebuild required");
		}
		Ok(())
	}
	fn tag_ok(&self, tag: Option<&Json>) -> bool {
		let Some(t @ Json::String(text)) = tag else { return false };
		let Some(v) = js_parse(t) else { return false };
		self.tag_value_ok(&v) && canonical(&v) == *text
	}
	fn tag_value_ok(&self, v: &Json) -> bool {
		let Some(a) = v.as_array() else { return false };
		a.len() == 3 && number(a.get(2)) && a[2].as_f64().unwrap_or(0.0) >= 1.0 && self.member(a.first(), a.get(1))
	}
	fn principal_ok(p: Option<&Json>) -> bool {
		let Some(p) = p.filter(|p| is_object(p)) else { return false };
		exact(p, if p.get("agentId").is_none() { &["peerId"] } else { &["peerId", "agentId"] }) && id(p.get("peerId")) && (p.get("agentId").is_none() || id(p.get("agentId")))
	}
	fn validate_mutation(&self, m: &Json) -> ER<()> {
		if kind_of(m) == "erase" && m.get("kind").is_some_and(is_string) {
			if !exact(m, &["kind", "principal", "owner"]) || !Self::principal_ok(m.get("principal")) || !Self::principal_ok(m.get("owner")) {
				return conflict("invalid erase");
			}
			return Ok(());
		}
		if !truthy(Some(m)) || !id(m.get("type")) || !truthy(m.get("owner")) || !Self::principal_ok(m.get("owner")) {
			return conflict("invalid mutation identity");
		}
		let Some(r) = self.rule(s(m, "type")) else { return conflict("type has no replication rule") };
		let lww = s(r, "variant") == "lww";
		let kind = m.get("kind").and_then(Json::as_str);
		if kind == Some("redacted") {
			let mut keys = vec!["kind", "type", "owner", "was", "erase"];
			if lww {
				keys.push("keyHash");
			}
			let was = m.get("was").and_then(Json::as_str);
			if was == Some("renew") {
				keys.push("tag");
			}
			let was_ok = if lww { matches!(was, Some("put" | "delete")) } else { matches!(was, Some("add" | "renew")) };
			if !exact(m, &keys) || !was_ok || !self.tag_ok(m.get("erase")) || lww && !sha(m.get("keyHash")) || was == Some("renew") && !self.tag_ok(m.get("tag")) {
				return conflict("invalid redacted change");
			}
			return Ok(());
		}
		if kind == Some("remove") {
			let tags = m.get("tags").and_then(Json::as_array);
			let distinct = |t: &Vec<Json>| {
				let mut seen = HashSet::new();
				t.iter().all(|x| match x {
					Json::Array(_) | Json::Object(_) => true,
					other => seen.insert(canonical(other) + if is_string(other) { "s" } else { "" }),
				})
			};
			if lww || !exact(m, &["kind", "type", "tags", "owner"]) || tags.is_none_or(|t| t.len() > 256 || !distinct(t)) {
				return conflict("invalid observed remove");
			}
			for tag in tags.unwrap() {
				let Some(v) = js_parse(tag) else { return conflict("invalid observed tag") };
				if !self.tag_value_ok(&v) || Some(canonical(&v).as_str()) != tag.as_str() {
					return conflict("unknown tag origin");
				}
			}
		} else {
			let has_lease = matches!(kind, Some("put" | "add" | "renew"));
			let keys: &[&str] = if kind == Some("renew") { &["kind", "type", "tag", "fields", "owner", "expiresAt"] } else if has_lease { &["kind", "type", "fields", "owner", "expiresAt"] } else { &["kind", "type", "fields", "owner"] };
			let kind_ok = if lww { matches!(kind, Some("put" | "delete")) } else { matches!(kind, Some("add" | "renew")) };
			let expires = m.get("expiresAt");
			if !exact(m, keys) || !kind_ok || !matches!(m.get("fields"), Some(Json::Object(_))) || has_lease && !matches!(expires, Some(Json::Null)) && !number(expires) {
				return conflict("invalid replicated mutation");
			}
			if kind == Some("renew") {
				let Some(v) = js_parse(m.get("tag").unwrap_or(&Json::Null)) else { return conflict("invalid renewal tag") };
				if !self.tag_value_ok(&v) || Some(canonical(&v).as_str()) != m.get("tag").and_then(Json::as_str) {
					return conflict("unknown renewal tag");
				}
			}
			if bytes(m.get("fields").unwrap()) > 64 * 1024 {
				return exhausted("entry fields exceed 64 KiB");
			}
			if lww {
				lww_key(r, m.get("fields").unwrap())?;
			}
		}
		Ok(())
	}
	fn validate_event(&self, e: &Json, now: f64) -> ER<()> {
		let ah = e.get("argumentHash").and_then(Json::as_str);
		if !is_object(e) || !exact(e, &["originReplicaId", "incarnation", "seq", "clock", "requestId", "argumentHash", "mutation"]) || !self.member(e.get("originReplicaId"), e.get("incarnation")) || !number(e.get("seq")) || n(e, "seq") < 1.0 || !id(e.get("requestId")) || ah.is_none_or(|h| !phi_json::is_sha256_hex(h)) {
			return conflict("invalid change identity or retired origin");
		}
		validate_clock(e.get("clock"))?;
		if n(e.get("clock").unwrap(), "physical") - now > 60_000.0 {
			return clock_error("remote clock exceeds future bound");
		}
		self.validate_mutation(mutation(e))?;
		if kind_of(mutation(e)) != "redacted" && ah != Some(hash(mutation(e)).as_str()) {
			return conflict("changed mutation argument hash");
		}
		Ok(())
	}
	/// The same change in original and redacted form.
	fn equivalent(&self, local: &Json, incoming: &Json) -> Equivalence {
		if canonical(local) == canonical(incoming) {
			return Equivalence::Same;
		}
		let (a, b) = (mutation(local), mutation(incoming));
		if canonical(&without(local, &["mutation"])) != canonical(&without(incoming, &["mutation"])) || kind_of(a) != "redacted" && kind_of(b) != "redacted" {
			return Equivalence::Conflict;
		}
		let type_owner = |m: &Json| if kind_of(m) == "erase" { String::new() } else { canonical(&Json::Array(vec![m.get("type").cloned().unwrap_or(Json::Null), m.get("owner").cloned().unwrap_or(Json::Null)])) };
		if type_owner(a) != type_owner(b) {
			return Equivalence::Conflict;
		}
		if kind_of(a) == "redacted" && kind_of(b) == "redacted" {
			return if lt(s(b, "erase"), s(a, "erase")) { Equivalence::Replace } else { Equivalence::Same };
		}
		if kind_of(a) == "redacted" {
			return if Some(hash(b).as_str()) == local.get("argumentHash").and_then(Json::as_str) { Equivalence::Same } else { Equivalence::Conflict };
		}
		if Some(hash(a).as_str()) == incoming.get("argumentHash").and_then(Json::as_str) {
			Equivalence::Replace
		} else {
			Equivalence::Conflict
		}
	}
	fn redact(&self, e: &Json, erase: &str) -> ER<Json> {
		let m = mutation(e);
		let r = self.rule(s(m, "type")).expect("a validated type");
		let mut red = obj! { "kind" => "redacted", "type" => m.get("type").cloned().unwrap(), "owner" => m.get("owner").cloned().unwrap(), "was" => m.get("kind").cloned().unwrap(), "erase" => erase };
		if s(r, "variant") == "lww" {
			put(&mut red, "keyHash", Json::String(hash(&Json::String(lww_key(r, m.get("fields").unwrap_or(&Json::Null))?))));
		}
		if kind_of(m) == "renew" {
			put(&mut red, "tag", m.get("tag").cloned().unwrap());
		}
		let mut out = e.clone();
		put(&mut out, "mutation", red);
		Ok(out)
	}
	/// Redacts, in place, every change owned by an erased principal with a clock before the erase (smallest erase ID wins).
	fn apply_erasures(&self, events: &mut [Json]) -> ER<usize> {
		let keyed: Vec<(String, Json, String)> = events.iter().filter(|e| kind_of(mutation(e)) == "erase").map(|x| (canonical(mutation(x).get("principal").unwrap_or(&Json::Null)), x.get("clock").cloned().unwrap_or(Json::Null), entry_change_id(x))).collect();
		if keyed.is_empty() {
			return Ok(0);
		}
		let mut count = 0;
		for e in events.iter_mut() {
			let m = mutation(e);
			if matches!(kind_of(m), "erase" | "remove") {
				continue;
			}
			let owner = canonical(m.get("owner").unwrap_or(&Json::Null));
			let mut best: Option<&str> = None;
			for (principal, clock, xid) in &keyed {
				if *principal != owner || compare_clock(e.get("clock").unwrap_or(&Json::Null), clock) != Ordering::Less {
					continue;
				}
				if best.is_none_or(|b| lt(xid, b)) {
					best = Some(xid);
				}
			}
			let Some(best) = best else { continue };
			if kind_of(m) == "redacted" {
				if !lt(best, s(m, "erase")) {
					continue;
				}
				let mut next = m.clone();
				put(&mut next, "erase", best.into());
				put(e, "mutation", next);
				count += 1;
				continue;
			}
			*e = self.redact(e, best)?;
			count += 1;
		}
		// a renewal copies its tag's fields: whatever its clock, it is redacted with an erased tag (chains to a fixpoint)
		let mut changed = true;
		while changed {
			changed = false;
			let at: HashMap<String, usize> = events.iter().enumerate().map(|(i, e)| (entry_change_id(e), i)).collect();
			for i in 0..events.len() {
				let m = mutation(&events[i]);
				if kind_of(m) != "renew" {
					continue;
				}
				let t = at.get(s(m, "tag")).map(|j| mutation(&events[*j]));
				if let Some(t) = t.filter(|t| kind_of(t) == "redacted") {
					let erase = s(t, "erase").to_owned();
					events[i] = self.redact(&events[i], &erase)?;
					count += 1;
					changed = true;
				}
			}
		}
		Ok(count)
	}
	fn budget(&self, events: &Json) -> ER<()> {
		if 2.0 * bytes(events) as f64 + 16384.0 > self.max_batch_bytes {
			return exhausted("replication batch exceeds atomic import budget");
		}
		Ok(())
	}
	fn append(&self, st: &mut Json, incoming: &[Json], now: f64) -> ER<usize> {
		let floor = st.get("floor").cloned();
		let events = list(st, "events").to_vec();
		let mut order: Vec<String> = vec![];
		let mut known: HashMap<String, Json> = HashMap::new();
		for e in &events {
			let k = entry_change_id(e);
			if known.insert(k.clone(), e.clone()).is_none() {
				order.push(k);
			}
		}
		let request_of = |e: &Json| canonical(&Json::Array(vec![e.get("originReplicaId").cloned().unwrap_or(Json::Null), e.get("incarnation").cloned().unwrap_or(Json::Null), e.get("requestId").cloned().unwrap_or(Json::Null)]));
		let mut requests: HashSet<String> = events.iter().map(request_of).collect();
		let (mut accepted, mut replaced): (Vec<Json>, usize) = (vec![], 0);
		for event in incoming {
			self.validate_event(event, now)?;
			let k = entry_change_id(event);
			if let Some(old) = known.get(&k) {
				match self.equivalent(old, event) {
					Equivalence::Conflict => return conflict("immutable change ID reused"),
					Equivalence::Replace => {
						known.insert(k, event.clone());
						replaced += 1;
					}
					Equivalence::Same => {}
				}
				continue;
			}
			// below the floor every change was held here: an unknown one was compacted away and must not come back
			if n(event, "seq") <= floor.as_ref().and_then(|f| f.get(&origin(event))).and_then(Json::as_f64).unwrap_or(0.0) {
				continue;
			}
			let request = request_of(event);
			if requests.contains(&request) {
				return conflict("origin request ID reused");
			}
			known.insert(k.clone(), event.clone());
			order.push(k);
			requests.insert(request);
			accepted.push(event.clone());
		}
		let mut origins: Vec<(String, Vec<&Json>)> = vec![];
		for k in &order {
			let e = &known[k];
			let o = origin(e);
			match origins.iter_mut().find(|(x, _)| *x == o) {
				Some((_, items)) => items.push(e),
				None => origins.push((o, vec![e])),
			}
		}
		for (_, items) in &mut origins {
			items.sort_by(|a, b| n(a, "seq").partial_cmp(&n(b, "seq")).unwrap_or(Ordering::Equal));
			for w in items.windows(2) {
				if compare_clock(w[0].get("clock").unwrap(), w[1].get("clock").unwrap()) != Ordering::Less {
					return conflict("origin clock is not strictly monotonic");
				}
			}
		}
		for k in &order {
			let event = &known[k];
			let m = mutation(event);
			if kind_of(m) != "remove" {
				continue;
			}
			for tag in list(m, "tags") {
				let Some(observed) = tag.as_str().and_then(|t| known.get(t)) else { continue };
				let om = mutation(observed);
				let kind = if kind_of(om) == "redacted" { s(om, "was") } else { kind_of(om) };
				if !matches!(kind, "add" | "renew") || om.get("type") != m.get("type") {
					return conflict("remove references another type or a non-add");
				}
			}
		}
		for k in &order {
			let event = &known[k];
			let m = mutation(event);
			if kind_of(m) != "renew" {
				continue;
			}
			if Some(entry_change_id(event).as_str()) == m.get("tag").and_then(Json::as_str) {
				return conflict("renewal cannot reference itself");
			}
			let Some(observed) = known.get(s(m, "tag")) else { continue };
			let old = mutation(observed);
			if kind_of(old) == "redacted" {
				continue;
			}
			if !matches!(kind_of(old), "add" | "renew") || old.get("type") != m.get("type") || canonical(old.get("owner").unwrap_or(&Json::Null)) != canonical(m.get("owner").unwrap_or(&Json::Null)) || old.get("fields").is_none() || canonical(old.get("fields").unwrap()) != canonical(m.get("fields").unwrap_or(&Json::Null)) || compare_clock(observed.get("clock").unwrap(), event.get("clock").unwrap()) != Ordering::Less {
				return conflict("renewal must preserve an earlier tag fields and owner");
			}
		}
		let mut events = events;
		if replaced > 0 {
			for e in &mut events {
				*e = known[&entry_change_id(e)].clone();
			}
		}
		let mut clock = st.get("clock").cloned().unwrap_or(Json::Null);
		let mut seq = n(st, "seq");
		for event in &accepted {
			events.push(event.clone());
			clock = advance_clock(&clock, now, event.get("clock"))?;
			if self.own(event) {
				seq = seq.max(n(event, "seq"));
			}
		}
		self.apply_erasures(&mut events)?;
		put(st, "events", Json::Array(events));
		put(st, "clock", clock);
		put(st, "seq", num(seq));
		if !accepted.is_empty() {
			let last = n(st, "lastWallTime").max(now);
			put(st, "lastWallTime", num(last));
			if bytes(st) as f64 > self.max_history_bytes {
				return exhausted("replica history is full; no tombstone or dedup record was discarded");
			}
		}
		Ok(accepted.len())
	}

	// ---- reads and writes

	/// Loads a document as `host.snapshot` does: none when absent.
	fn snapshot_doc(&self, store: &Store, def: &Def, key: &str) -> ER<Option<Json>> { Ok(stored(store, &self.cache, def.kind, key)?.map(|(v, x)| migrate(def, v, x))) }
	fn commit<T>(&self, store: &mut Store, f: impl FnOnce(&mut Tx) -> ER<T>) -> ER<T> {
		let (out, writes, retires) = {
			let mut tx = Tx { store, cache: &self.cache, docs: vec![], retired: vec![] };
			let out = f(&mut tx)?;
			let retires: Vec<(&'static str, String)> = tx.retired.iter().filter(|(k, key)| stored(tx.store, tx.cache, k, key).is_ok_and(|v| v.is_some())).cloned().collect();
			let writes: Vec<Draft> = tx.docs.into_iter().filter(|d| d.fresh || d.migrated || d.before.as_deref() != Some(canonical(&d.value).as_str())).collect();
			(out, writes, retires)
		};
		if writes.is_empty() && retires.is_empty() {
			return Ok(out);
		}
		let mut ops: Vec<WriteOp> = writes.iter().map(|d| WriteOp::Doc { kind: d.kind.to_owned(), key: d.key.clone(), version: d.version, value: d.value.to_json_text() }).collect();
		ops.extend(retires.iter().map(|(k, key)| WriteOp::Retire { kind: (*k).to_owned(), key: key.clone() }));
		match store.commit_documents(self.space.as_deref(), ops) {
			Err(e) => return Err(EntryError::Other { class: "Error".into(), message: e.to_string() }),
			Ok(Err(e)) => return Err(EntryError::Other { class: e.class.into(), message: e.message }),
			Ok(Ok(_)) => {}
		}
		let mut cache = self.cache.borrow_mut();
		for d in writes {
			cache.insert((d.kind.to_owned(), d.key), Some((d.version, d.value)));
		}
		for (k, key) in retires {
			cache.insert((k.to_owned(), key), None);
		}
		Ok(out)
	}

	/// The logical history; redacted unless `raw`.
	fn materialize(&self, base: &Json, load: &mut dyn FnMut(&str) -> ER<Option<Json>>, raw: bool) -> ER<Json> {
		let mut result = base.clone();
		let floor = base.get("floor").cloned();
		let base_events = list(base, "events");
		let mut events: Vec<Json> = vec![];
		let mut seen: HashMap<String, String> = HashMap::new();
		let mut at: HashMap<String, usize> = HashMap::new();
		let mut floor_active = false;
		let mut add = |items: &[Json], floor_active: bool, events: &mut Vec<Json>| -> ER<()> {
			for e in items {
				let (k, h) = (entry_change_id(e), hash(e));
				let old = seen.get(&k).cloned();
				if old.is_none() && floor_active && n(e, "seq") <= floor.as_ref().and_then(|f| f.get(&origin(e))).and_then(Json::as_f64).unwrap_or(0.0) {
					continue;
				}
				if let Some(old) = old {
					if old != h {
						let i = at[&k];
						match self.equivalent(&events[i], e) {
							Equivalence::Conflict => return conflict("stored change ID conflict"),
							Equivalence::Replace => {
								events[i] = e.clone();
								seen.insert(k, h);
							}
							Equivalence::Same => {}
						}
					}
					continue;
				}
				at.insert(k.clone(), events.len());
				events.push(e.clone());
				seen.insert(k, h);
			}
			Ok(())
		};
		let mut through = 0usize;
		for segment in list(base, "segments") {
			let ot = n(segment, "overlayThrough");
			if !(ot >= through as f64 && ot <= base_events.len() as f64) {
				return conflict("invalid stored overlay boundary");
			}
			let ot = ot as usize;
			add(&base_events[through..ot], floor_active, &mut events)?;
			through = ot;
			let pages = self.staged_events(segment.get("manifest").unwrap_or(&Json::Null), load, None, None)?;
			add(&pages, floor_active, &mut events)?;
			floor_active = true;
		}
		add(&base_events[through..], floor_active, &mut events)?;
		if !raw {
			self.apply_erasures(&mut events)?;
		}
		put(&mut result, "events", Json::Array(events));
		Ok(result)
	}
	fn materialize_in(&self, tx: &mut Tx, base: &Json) -> ER<Json> {
		self.materialize(base, &mut |key| tx.doc(&CHUNKS, key).map(|(_, v)| Some(v)), false)
	}
	fn persist_overlay(&self, base: &mut Json, logical: &Json, previous: usize) {
		let current: HashMap<String, &Json> = list(logical, "events").iter().map(|e| (entry_change_id(e), e)).collect();
		let events = arr_mut(base, "events");
		for e in events.iter_mut() {
			if let Some(now) = current.get(&entry_change_id(e)) {
				if canonical(now) != canonical(e) {
					*e = (*now).clone();
				}
			}
		}
		events.extend(list(logical, "events")[previous..].iter().cloned());
		put(base, "clock", logical.get("clock").cloned().unwrap_or(Json::Null));
		put(base, "seq", logical.get("seq").cloned().unwrap_or(Json::Null));
		put(base, "lastWallTime", logical.get("lastWallTime").cloned().unwrap_or(Json::Null));
	}
	fn state(&self, store: &Store, action: &str) -> ER<Option<Json>> {
		self.check(action)?;
		let base = self.snapshot_doc(store, &STATE, &self.document_key)?;
		if let Some(b) = &base {
			self.bind(b)?;
		}
		let st = match &base {
			Some(b) => Some(self.materialize(b, &mut |key| self.snapshot_doc(store, &CHUNKS, key), false)?),
			None => None,
		};
		self.check(action)?;
		Ok(st)
	}

	pub fn mutate(&self, store: &mut Store, request_id: &Json, mutation_in: &Json) -> ER<Json> {
		let m = copy(mutation_in)?;
		if !id(Some(request_id)) {
			return conflict("invalid request ID");
		}
		if kind_of(&m) == "redacted" {
			return conflict("a redacted change only arrives by replication");
		}
		self.validate_mutation(&m)?;
		let argument_hash = hash(&m);
		let request_id = request_id.as_str().unwrap().to_owned();
		self.check("local")?;
		self.commit(store, |tx| {
			self.check("local")?;
			let (bi, mut st) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&st)?;
			let mut logical = self.materialize_in(tx, &st)?;
			let previous = list(&logical, "events").len();
			if let Some(old) = list(&logical, "events").iter().find(|e| self.own(e) && s(e, "requestId") == request_id) {
				if s(old, "argumentHash") != argument_hash {
					return Err(EntryError::Request("replication request changed arguments".into()));
				}
				self.check("local")?;
				return Ok(old.clone());
			}
			let now = self.now()?;
			self.clock_safe(n(&st, "lastWallTime"), now)?;
			let events = list(&logical, "events");
			let find = |tag: &str| events.iter().find(|e| entry_change_id(e) == tag);
			if kind_of(&m) == "remove" {
				for tag in list(&m, "tags") {
					let e = find(tag.as_str().unwrap_or(""));
					if e.is_none_or(|e| !matches!(kind_of(mutation(e)), "add" | "renew") || mutation(e).get("type") != m.get("type")) {
						return conflict("local remove can only remove observed adds of its type");
					}
				}
			}
			if kind_of(&m) == "renew" {
				let tag = s(&m, "tag");
				let old = find(tag).map(mutation);
				let removed = events.iter().any(|e| {
					let x = mutation(e);
					kind_of(x) == "remove" && list(x, "tags").iter().any(|t| t.as_str() == Some(tag)) || kind_of(x) == "renew" && s(x, "tag") == tag && x.get("tag").is_some_and(is_string)
				});
				let expires = m.get("expiresAt");
				let bad = match old {
					None => true,
					Some(old) => {
						let oe = old.get("expiresAt");
						!matches!(kind_of(old), "add" | "renew") || old.get("type") != m.get("type") || oe.is_none() || !oe.unwrap().is_null() && oe.unwrap().as_f64().is_some_and(|x| x <= now) || removed || canonical(old.get("owner").unwrap_or(&Json::Null)) != canonical(m.get("owner").unwrap_or(&Json::Null)) || old.get("fields").is_none() || canonical(old.get("fields").unwrap()) != canonical(m.get("fields").unwrap_or(&Json::Null)) || expires.is_some_and(|x| !x.is_null() && x.as_f64().is_some_and(|x| x <= now))
					}
				};
				if bad {
					return conflict("renewal requires a live observed tag with unchanged fields and owner");
				}
			}
			if !safe(n(&st, "seq") + 1.0) {
				return conflict("origin sequence exhausted");
			}
			let event = obj! { "originReplicaId" => self.replica_id(), "incarnation" => self.incarnation(), "seq" => n(&st, "seq") + 1.0, "clock" => advance_clock(st.get("clock").unwrap_or(&Json::Null), now, None)?, "requestId" => request_id.as_str(), "argumentHash" => argument_hash.as_str(), "mutation" => m.clone() };
			self.budget(&Json::Array(vec![event.clone()]))?;
			if st.get("config").is_none_or(Json::is_null) {
				put(&mut st, "config", self.config.clone());
			}
			put(&mut st, "configHash", self.config_hash.as_str().into());
			put(&mut logical, "config", self.config.clone());
			put(&mut logical, "configHash", self.config_hash.as_str().into());
			self.append(&mut logical, std::slice::from_ref(&event), now)?;
			self.persist_overlay(&mut st, &logical, previous);
			tx.set(bi, st);
			self.check("local")?;
			Ok(event)
		})
	}
	fn import_in(&self, tx: &mut Tx, events: &[Json]) -> ER<Json> {
		let (bi, mut st) = tx.doc(&STATE, &self.document_key)?;
		self.bind(&st)?;
		let now = self.now()?;
		if st.get("config").is_none_or(Json::is_null) {
			put(&mut st, "config", self.config.clone());
		}
		put(&mut st, "configHash", self.config_hash.as_str().into());
		let mut logical = self.materialize_in(tx, &st)?;
		let previous = list(&logical, "events").len();
		let added = self.append(&mut logical, events, now)?;
		self.persist_overlay(&mut st, &logical, previous);
		tx.set(bi, st);
		Ok(obj! { "added" => added as f64, "revision" => head_of(&logical) })
	}
	pub fn import_changes(&self, store: &mut Store, input: &Json) -> ER<Json> {
		let events = copy(input)?;
		let Some(list_) = events.as_array().filter(|a| a.len() <= 1024) else { return exhausted("bounded event array required") };
		self.budget(&events)?;
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let r = self.import_in(tx, list_)?;
			self.check("import")?;
			Ok(r)
		})
	}
	/// This replica's own change for a local request ID, or null.
	pub fn change_for_request(&self, store: &Store, request_id: &str) -> ER<Json> {
		let st = self.state(store, "read")?;
		Ok(st.and_then(|st| list(&st, "events").iter().find(|e| self.own(e) && s(e, "requestId") == request_id).cloned()).unwrap_or(Json::Null))
	}
	/// The visible entries, sorted by id.
	pub fn read(&self, store: &Store) -> ER<Vec<Json>> {
		let st = self.state(store, "read")?;
		let now = self.now()?;
		self.clock_safe(st.as_ref().map_or(0.0, |s| n(s, "lastWallTime")), now)?;
		let Some(st) = st else { return Ok(vec![]) };
		let events = list(&st, "events");
		let mut winners: Vec<(String, usize)> = vec![];
		let (mut removed, mut redacted): (HashSet<String>, HashSet<String>) = (HashSet::new(), HashSet::new());
		for (i, e) in events.iter().enumerate() {
			let m = mutation(e);
			if kind_of(m) == "erase" {
				continue;
			}
			let r = self.rule(s(m, "type")).expect("a validated type");
			if kind_of(m) == "redacted" {
				redacted.insert(entry_change_id(e));
			}
			if s(r, "variant") == "lww" && kind_of(m) != "remove" {
				let k = if kind_of(m) == "redacted" { s(m, "keyHash").to_owned() } else { hash(&Json::String(lww_key(r, m.get("fields").unwrap_or(&Json::Null))?)) };
				match winners.iter_mut().find(|(x, _)| *x == k) {
					None => winners.push((k, i)),
					Some((_, w)) => {
						let old = &events[*w];
						let cmp = compare_clock(e.get("clock").unwrap(), old.get("clock").unwrap());
						if cmp == Ordering::Greater || cmp == Ordering::Equal && lt(s(old, "originReplicaId"), s(e, "originReplicaId")) {
							*w = i;
						}
					}
				}
			} else if kind_of(m) == "remove" {
				for t in list(m, "tags") {
					removed.insert(t.as_str().unwrap_or("").to_owned());
				}
			} else if kind_of(m) == "renew" || kind_of(m) == "redacted" && s(m, "was") == "renew" {
				removed.insert(s(m, "tag").to_owned());
			}
		}
		let mut visible: Vec<&Json> = winners.iter().map(|(_, i)| &events[*i]).filter(|e| kind_of(mutation(e)) == "put").collect();
		visible.extend(events.iter().filter(|e| {
			let m = mutation(e);
			matches!(kind_of(m), "add" | "renew") && !removed.contains(&entry_change_id(e)) && !(kind_of(m) == "renew" && redacted.contains(s(m, "tag")))
		}));
		let mut out: Vec<Json> = visible
			.into_iter()
			.filter(|e| mutation(e).get("expiresAt").is_none_or(|x| x.is_null() || n(mutation(e), "expiresAt") > now))
			.map(|e| {
				let m = mutation(e);
				obj! { "id" => entry_change_id(e), "type" => m.get("type").cloned().unwrap(), "fields" => m.get("fields").cloned().unwrap(), "owner" => m.get("owner").cloned().unwrap(), "expiresAt" => m.get("expiresAt").cloned().unwrap_or(Json::Null), "clock" => e.get("clock").cloned().unwrap(), "originReplicaId" => e.get("originReplicaId").cloned().unwrap() }
			})
			.collect();
		out.sort_by(|a, b| if lt(s(a, "id"), s(b, "id")) { Ordering::Less } else { Ordering::Greater });
		Ok(out)
	}
	/// Byte-bounded changes after stream position `afterRevision`; `positions` only when they are not contiguous.
	pub fn changes(&self, store: &Store, after: Option<&Json>, max_bytes: Option<&Json>) -> ER<Json> {
		let st = self.state(store, "export")?;
		let (after, max_bytes) = (after.cloned().unwrap_or(num(0.0)), max_bytes.cloned().unwrap_or(num(256.0 * 1024.0)));
		let head = st.as_ref().map_or(0.0, head_of);
		if !number(Some(&after)) || after.as_f64().unwrap() > head || !max_bytes.as_f64().is_some_and(safe) || max_bytes.as_f64().unwrap() < 256.0 || max_bytes.as_f64().unwrap() > 256.0 * 1024.0 {
			return conflict("invalid revision or page budget");
		}
		let a = after.as_f64().unwrap();
		let frame = |events: &[Json], positions: &[f64], next: f64, more: bool| {
			let mut f = obj! { "events" => events.to_vec(), "next" => next, "more" => more };
			if !contiguous(a, positions) {
				put(&mut f, "positions", Json::Array(positions.iter().map(|p| num(*p)).collect()));
			}
			f
		};
		let (events, positions, next, more) = self.page_after(st.as_ref(), a, max_bytes.as_f64().unwrap(), &frame, "next change does not fit page")?;
		Ok(frame(&events, &positions, next, more))
	}
	fn page_after(&self, st: Option<&Json>, after: f64, max_bytes: f64, frame: Frame, too_large: &str) -> ER<(Vec<Json>, Vec<f64>, f64, bool)> {
		let all = st.map_or(&[][..], |s| list(s, "events"));
		let at = positions_of(all.len(), &runs_of_json(st.and_then(|s| s.get("dropped"))));
		let head = st.map_or(0.0, head_of);
		let mut i = 0;
		while i < at.len() && at[i] <= after {
			i += 1;
		}
		let (mut events, mut positions): (Vec<Json>, Vec<f64>) = (vec![], vec![]);
		let (mut page_next, mut page_more) = (if i < at.len() { after } else { head }, i < at.len());
		let mut listed = 14usize;
		while i < all.len() && events.len() < 1024 {
			let event = all[i].clone();
			let position = at[i];
			let more = i + 1 < all.len();
			let next = if more { position } else { head };
			let item = bytes(&event) + 1 + phi_json::number_text(position).len() + 1;
			events.push(event);
			positions.push(position);
			if bytes(&frame(&[], &[], next, more)) + listed + item > max_bytes as usize && bytes(&frame(&events, &positions, next, more)) as f64 > max_bytes {
				events.pop();
				positions.pop();
				if events.is_empty() {
					return exhausted(too_large);
				}
				break;
			}
			listed += item;
			page_next = next;
			page_more = more;
			i += 1;
		}
		Ok((events, positions, page_next, page_more))
	}
	pub fn snapshot(&self, store: &Store) -> ER<Json> {
		let st = self.state(store, "export")?;
		let events = Json::Array(st.map_or(vec![], |s| list(&s, "events").to_vec()));
		self.budget(&events)?;
		let mut body = obj! { "version" => 1.0, "spaceId" => self.config.get("spaceId").cloned().unwrap(), "authorityId" => self.config.get("authorityId").cloned().unwrap(), "configHash" => self.config_hash.as_str(), "events" => events };
		let h = hash(&body);
		put(&mut body, "sha256", h.into());
		Ok(body)
	}
	pub fn install_snapshot(&self, store: &mut Store, snapshot: &Json) -> ER<Json> {
		let v = copy(snapshot)?;
		self.check("import")?;
		if !truthy(Some(&v)) || !exact(&v, &["version", "spaceId", "authorityId", "configHash", "events", "sha256"]) || v.get("version") != Some(&num(1.0)) || v.get("spaceId") != self.config.get("spaceId") || v.get("authorityId") != self.config.get("authorityId") || v.get("configHash") != Some(&Json::String(self.config_hash.clone())) {
			return conflict("snapshot binding changed");
		}
		if v.get("sha256") != Some(&Json::String(hash(&without(&v, &["sha256"])))) {
			return conflict("snapshot hash mismatch");
		}
		self.import_changes(store, v.get("events").unwrap())
	}

	// ---- snapshot transfer

	fn snapshot_id(v: Option<&Json>) -> ER<String> {
		match v.and_then(Json::as_str) {
			Some(t) if t.len() == 34 && t.starts_with("ss") && t[2..].bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')) => Ok(t.to_owned()),
			_ => conflict("invalid snapshot ID"),
		}
	}
	fn bind_manifest(&self, m: &Json) -> ER<()> {
		if m.get("spaceId") != self.config.get("spaceId") || m.get("authorityId") != self.config.get("authorityId") || m.get("configHash") != Some(&Json::String(self.config_hash.clone())) || !self.member(m.get("sourceReplicaId"), m.get("sourceIncarnation")) {
			return conflict("snapshot binding changed");
		}
		Ok(())
	}
	fn validate_manifest(&self, m: &Json) -> ER<()> {
		let keys = ["version", "id", "spaceId", "authorityId", "configHash", "sourceReplicaId", "sourceIncarnation", "revision", "eventCount", "bytes", "pageBytes", "pageCount", "expiresAt", "seedHash", "rootHash"];
		let id_ok = Self::snapshot_id(m.get("id")).is_ok();
		let ok = truthy(Some(m))
			&& exact(m, &keys)
			&& m.get("version") == Some(&num(1.0))
			&& id_ok
			&& self.bind_manifest(m).is_ok()
			&& number(m.get("revision"))
			&& number(m.get("eventCount"))
			&& n(m, "revision") >= n(m, "eventCount")
			&& number(m.get("bytes"))
			&& n(m, "bytes") >= 2.0
			&& n(m, "bytes") <= self.max_history_bytes
			&& number(m.get("pageBytes"))
			&& n(m, "pageBytes") >= 1024.0
			&& 2.0 * n(m, "pageBytes") + 16384.0 <= self.max_batch_bytes
			&& number(m.get("pageCount"))
			&& n(m, "pageCount") >= 1.0
			&& n(m, "pageCount") <= 2048.0
			&& number(m.get("expiresAt"))
			&& sha(m.get("seedHash"))
			&& sha(m.get("rootHash"))
			&& manifest_seed(m) == s(m, "seedHash");
		if !ok {
			return conflict("invalid snapshot manifest or binding");
		}
		Ok(())
	}
	fn validate_page(&self, m: &Json, p: &Json, index: f64, offset: f64, previous_hash: &str) -> ER<()> {
		let events = p.get("events").and_then(Json::as_array);
		let ok = truthy(Some(p))
			&& exact(p, &["snapshotId", "index", "offset", "next", "events", "previousHash", "sha256"])
			&& p.get("snapshotId") == m.get("id")
			&& p.get("index") == Some(&num(index))
			&& p.get("offset") == Some(&num(offset))
			&& p.get("next") == Some(&num(index + 1.0))
			&& p.get("previousHash").and_then(Json::as_str) == Some(previous_hash)
			&& events.is_some_and(|e| e.len() <= 1024 && (!e.is_empty() || n(m, "eventCount") == 0.0))
			&& sha(p.get("sha256"))
			&& page_hash(p) == s(p, "sha256")
			&& bytes(p) as f64 <= n(m, "pageBytes")
			&& offset + events.map_or(0, Vec::len) as f64 <= n(m, "eventCount");
		if !ok {
			return conflict("snapshot page changed, is out of order or exceeds budget");
		}
		Ok(())
	}
	/// `stagedEvents`: the events of a manifest's pages up to `count`; `verified` rechecks only the linkage.
	fn staged_events(&self, m: &Json, load: &mut dyn FnMut(&str) -> ER<Option<Json>>, count: Option<f64>, verified: Option<(&str, f64)>) -> ER<Vec<Json>> {
		let count = count.unwrap_or(n(m, "pageCount"));
		let mut events: Vec<Json> = vec![];
		let mut chain = s(m, "seedHash").to_owned();
		let mut i = 0.0;
		while i < count {
			let chunk = load(&chunk_key(&self.document_key, s(m, "id"), i))?;
			let page = chunk.as_ref().and_then(|c| c.get("page")).filter(|p| truthy(Some(p))).cloned();
			let Some(page) = page else { return conflict("snapshot page is missing") };
			if verified.is_some() {
				if page.get("index") != Some(&num(i)) || page.get("offset") != Some(&num(events.len() as f64)) || page.get("previousHash").and_then(Json::as_str) != Some(chain.as_str()) {
					return conflict("staged snapshot page changed");
				}
			} else {
				self.validate_page(m, &page, i, events.len() as f64, &chain)?;
			}
			events.extend(list(&page, "events").iter().cloned());
			chain = s(&page, "sha256").to_owned();
			i += 1.0;
		}
		if let Some((chain_hash, next_offset)) = verified {
			if chain != chain_hash || events.len() as f64 != next_offset {
				return conflict("staged snapshot pages disagree with the import ledger");
			}
		}
		if count == n(m, "pageCount") && (chain != s(m, "rootHash") || events.len() as f64 != n(m, "eventCount") || bytes(&Json::Array(events.clone())) as f64 != n(m, "bytes")) {
			return conflict("snapshot is incomplete or its final hash changed");
		}
		Ok(events)
	}
	fn pack_snapshot(&self, events: &[Json], template: &Json) -> ER<(Json, Vec<Json>)> {
		let mut manifest = template.clone();
		let page_bytes = n(&manifest, "pageBytes") as usize;
		let mut pages: Vec<Json> = vec![];
		let mut offset = 0;
		loop {
			let mut page = obj! { "snapshotId" => manifest.get("id").cloned().unwrap(), "index" => pages.len() as f64, "offset" => offset as f64, "next" => (pages.len() + 1) as f64, "events" => Json::Array(vec![]), "previousHash" => ZERO, "sha256" => ZERO };
			// the page's bytes grow by each event and its comma: measured whole only near the bound
			let mut size = bytes(&page);
			while offset < events.len() && list(&page, "events").len() < 1024 {
				let e = &events[offset];
				let grow = bytes(e) + usize::from(!list(&page, "events").is_empty());
				arr_mut(&mut page, "events").push(e.clone());
				if size + grow > page_bytes {
					arr_mut(&mut page, "events").pop();
					if list(&page, "events").is_empty() {
						return exhausted("one change does not fit snapshot page");
					}
					break;
				}
				size += grow;
				offset += 1;
			}
			pages.push(page);
			if pages.len() > 2048 {
				return exhausted("snapshot exceeds 2048 pages");
			}
			if offset >= events.len() {
				break;
			}
		}
		put(&mut manifest, "pageCount", num(pages.len() as f64));
		let seed = manifest_seed(&manifest);
		put(&mut manifest, "seedHash", seed.as_str().into());
		let mut chain = seed;
		for page in &mut pages {
			put(page, "previousHash", chain.as_str().into());
			let h = page_hash(page);
			put(page, "sha256", h.as_str().into());
			chain = h;
		}
		put(&mut manifest, "rootHash", chain.into());
		Ok((manifest, pages))
	}
	fn new_snapshot_id(&self) -> String { format!("ss{}", hex(&(self.random.borrow_mut())(16))) }
	fn template(&self, id: String, revision: f64, events: &[Json], page_bytes: f64, now: f64) -> Json {
		obj! { "version" => 1.0, "id" => id, "spaceId" => self.config.get("spaceId").cloned().unwrap(), "authorityId" => self.config.get("authorityId").cloned().unwrap(), "configHash" => self.config_hash.as_str(), "sourceReplicaId" => self.replica_id(), "sourceIncarnation" => self.incarnation(), "revision" => revision, "eventCount" => events.len() as f64, "bytes" => bytes(&Json::Array(events.to_vec())) as f64, "pageBytes" => page_bytes, "pageCount" => 0.0, "expiresAt" => now + 60_000.0, "seedHash" => "", "rootHash" => "" }
	}
	fn default_page_bytes(&self) -> f64 { ((self.max_batch_bytes - 16384.0) / 2.0).floor() }
	pub fn start_snapshot(&self, store: &Store, page_bytes: Option<&Json>) -> ER<Json> {
		let pb = page_bytes.cloned().unwrap_or(num(self.default_page_bytes()));
		if !number(Some(&pb)) || pb.as_f64().unwrap() < 1024.0 || 2.0 * pb.as_f64().unwrap() + 16384.0 > self.max_batch_bytes {
			return conflict("invalid snapshot page budget");
		}
		let pb = pb.as_f64().unwrap();
		let st = self.state(store, "export")?;
		let events = st.as_ref().map_or(vec![], |s| list(s, "events").to_vec());
		let now = self.now()?;
		self.exports.borrow_mut().retain(|(_, v)| n(&v.manifest, "expiresAt") > now);
		let template = self.template(self.new_snapshot_id(), st.as_ref().map_or(0.0, head_of), &events, pb, now);
		if !safe(n(&template, "expiresAt")) || n(&template, "bytes") > 64.0 * 1024.0 * 1024.0 {
			return exhausted("snapshot cache byte bound exceeded");
		}
		let (manifest, pages) = self.pack_snapshot(&events, &template)?;
		let mut cache = self.exports.borrow_mut();
		while cache.len() >= 16 || cache.iter().map(|(_, v)| n(&v.manifest, "bytes")).sum::<f64>() + n(&manifest, "bytes") > 64.0 * 1024.0 * 1024.0 {
			if cache.is_empty() {
				return exhausted("snapshot cache is full");
			}
			cache.remove(0);
		}
		cache.push((s(&manifest, "id").to_owned(), Exported { manifest: manifest.clone(), pages }));
		Ok(manifest)
	}
	pub fn snapshot_page(&self, snapshot_id: Option<&Json>, index: Option<&Json>) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		self.check("export")?;
		let now = self.now()?;
		let found = self.exports.borrow().iter().position(|(k, _)| *k == sid);
		let Some(at) = found.filter(|i| n(&self.exports.borrow()[*i].1.manifest, "expiresAt") > now) else {
			if let Some(i) = found {
				self.exports.borrow_mut().remove(i);
			}
			return Err(EntryError::Expired("snapshot token expired; start a new snapshot".into()));
		};
		let (manifest, count) = {
			let c = self.exports.borrow();
			(c[at].1.manifest.clone(), c[at].1.pages.len())
		};
		self.bind_manifest(&manifest)?;
		if !number(index) || index.and_then(Json::as_f64).unwrap() >= count as f64 {
			return conflict("invalid snapshot page index");
		}
		self.check("export")?;
		if n(&manifest, "expiresAt") <= self.now()? {
			return Err(EntryError::Expired("snapshot token expired".into()));
		}
		Ok(self.exports.borrow()[at].1.pages[index.unwrap().as_f64().unwrap() as usize].clone())
	}
	pub fn begin_snapshot_import(&self, store: &mut Store, input: &Json) -> ER<Json> {
		let manifest = copy(input)?;
		self.validate_manifest(&manifest)?;
		self.check("import")?;
		let mid = s(&manifest, "id").to_owned();
		self.commit(store, |tx| {
			self.check("import")?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			if let Some(old) = ledger.get("transfers").and_then(|t| t.get(&mid)) {
				if canonical(old.get("manifest").unwrap_or(&Json::Null)) != canonical(&manifest) {
					return conflict("snapshot ID changed manifest");
				}
				self.check("import")?;
				return Ok(old.clone());
			}
			if self.now()? >= n(&manifest, "expiresAt") {
				return Err(EntryError::Expired("snapshot expired before import".into()));
			}
			let (_, base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let (_, maintenance) = tx.doc(&MAINTENANCE, &self.document_key)?;
			if maintenance.get("job").is_some_and(|j| truthy(Some(j)) && s(j, "phase") != "completed") {
				return conflict("snapshot maintenance is active");
			}
			let reserved = n(&manifest, "bytes") + n(&manifest, "pageCount") * 1024.0;
			let transfers = ledger.get("transfers").and_then(Json::as_object).cloned().unwrap_or_default();
			if transfers.iter().any(|(_, t)| matches!(s(t, "phase"), "receiving" | "aborting")) || transfers.len() >= 16 || list(&base, "segments").len() >= 16 || n(&ledger, "retainedBytes") + reserved > 2.0 * self.max_history_bytes {
				return exhausted("snapshot transfer or retained staging capacity exhausted");
			}
			let transfer = obj! { "manifest" => manifest.clone(), "phase" => "receiving", "nextPage" => 0.0, "nextOffset" => 0.0, "chainHash" => manifest.get("seedHash").cloned().unwrap(), "receivedBytes" => 2.0, "reservedBytes" => reserved, "cleanupCursor" => 0.0 };
			obj_mut(&mut ledger, "transfers").insert(mid.clone(), transfer.clone());
			let r = n(&ledger, "retainedBytes") + reserved;
			put(&mut ledger, "retainedBytes", num(r));
			tx.set(li, ledger);
			self.check("import")?;
			if self.now()? >= n(&manifest, "expiresAt") {
				return Err(EntryError::Expired("snapshot expired during import admission".into()));
			}
			Ok(transfer)
		})
	}
	pub fn snapshot_import_status(&self, store: &Store, snapshot_id: Option<&Json>) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		self.check("import")?;
		let ledger = self.snapshot_doc(store, &TRANSFERS, &self.document_key)?;
		let Some(t) = ledger.as_ref().and_then(|l| l.get("transfers")).and_then(|t| t.get(&sid)).cloned() else { return conflict("unknown snapshot import") };
		self.bind_manifest(t.get("manifest").unwrap_or(&Json::Null))?;
		self.check("import")?;
		Ok(t)
	}
	pub fn import_snapshot_page(&self, store: &mut Store, snapshot_id: Option<&Json>, input: &Json) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		let page = copy(input)?;
		if bytes(&page) as f64 > self.default_page_bytes() {
			return exhausted("snapshot page exceeds atomic staging budget");
		}
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let Some(mut t) = ledger.get("transfers").and_then(|x| x.get(&sid)).cloned() else { return conflict("unknown snapshot import") };
			let m = t.get("manifest").cloned().unwrap_or(Json::Null);
			self.bind_manifest(&m)?;
			if page.get("snapshotId").and_then(Json::as_str) != Some(sid.as_str()) || !number(page.get("index")) || n(&page, "index") >= n(&m, "pageCount") {
				return conflict("page belongs to another import");
			}
			let index = n(&page, "index");
			if index < n(&t, "nextPage") {
				let (_, prior) = tx.doc(&CHUNKS, &chunk_key(&self.document_key, &sid, index))?;
				if !matches!(s(&t, "phase"), "receiving" | "completed") || canonical(prior.get("page").unwrap_or(&Json::Null)) != canonical(&page) {
					return conflict("duplicate page changed content");
				}
				self.check("import")?;
				return Ok(t);
			}
			if s(&t, "phase") != "receiving" || self.now()? >= n(&m, "expiresAt") {
				return Err(EntryError::Expired("snapshot no longer accepts pages".into()));
			}
			self.validate_page(&m, &page, n(&t, "nextPage"), n(&t, "nextOffset"), s(&t, "chainHash"))?;
			self.budget(page.get("events").unwrap())?;
			let (bi, mut base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let mut logical = self.materialize_in(tx, &base)?;
			let mut staged = self.staged_events(&m, &mut |key| tx.doc(&CHUNKS, key).map(|(_, v)| Some(v)), Some(n(&t, "nextPage")), Some((s(&t, "chainHash"), n(&t, "nextOffset"))))?;
			staged.extend(list(&page, "events").iter().cloned());
			self.append(&mut logical, &staged, self.now()?)?;
			// receipt is causal even while payloads remain hidden: subsequent local writes must have a newer HLC
			let mut observed = base.get("clock").cloned().unwrap_or(Json::Null);
			let mut seq = n(&base, "seq");
			for event in list(&page, "events") {
				observed = advance_clock(&observed, self.now()?, event.get("clock"))?;
				if self.own(event) {
					seq = seq.max(n(event, "seq"));
				}
			}
			put(&mut base, "seq", num(seq));
			put(&mut base, "clock", observed);
			let last = n(&base, "lastWallTime").max(self.now()?);
			put(&mut base, "lastWallTime", num(last));
			tx.set(bi, base);
			let (ci, mut chunk) = tx.doc(&CHUNKS, &chunk_key(&self.document_key, &sid, index))?;
			if !chunk.get("page").is_some_and(Json::is_null) {
				return conflict("staging page is already occupied");
			}
			put(&mut chunk, "page", page.clone());
			tx.set(ci, chunk);
			let pe = list(&page, "events");
			let received = n(&t, "receivedBytes") + bytes(page.get("events").unwrap()) as f64 - 2.0 + if n(&t, "nextOffset") > 0.0 && !pe.is_empty() { 1.0 } else { 0.0 };
			put(&mut t, "receivedBytes", num(received));
			bump(&mut t, "nextPage", 1.0);
			bump(&mut t, "nextOffset", pe.len() as f64);
			put(&mut t, "chainHash", page.get("sha256").cloned().unwrap());
			obj_mut(&mut ledger, "transfers").insert(sid.clone(), t.clone());
			tx.set(li, ledger);
			if n(&t, "nextPage") == n(&m, "pageCount") && (n(&t, "nextOffset") != n(&m, "eventCount") || n(&t, "receivedBytes") != n(&m, "bytes") || s(&t, "chainHash") != s(&m, "rootHash")) {
				return conflict("final snapshot page does not match manifest");
			}
			self.check("import")?;
			if self.now()? >= n(&m, "expiresAt") {
				return Err(EntryError::Expired("snapshot expired during page admission".into()));
			}
			Ok(t)
		})
	}
	pub fn finish_snapshot_import(&self, store: &mut Store, snapshot_id: Option<&Json>) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let Some(mut t) = ledger.get("transfers").and_then(|x| x.get(&sid)).cloned() else { return conflict("unknown snapshot import") };
			let m = t.get("manifest").cloned().unwrap_or(Json::Null);
			self.bind_manifest(&m)?;
			if matches!(s(&t, "phase"), "completed" | "retiring" | "retired") {
				self.check("import")?;
				return Ok(t.get("result").cloned().unwrap_or(Json::Null));
			}
			if s(&t, "phase") != "receiving" || n(&t, "nextPage") != n(&m, "pageCount") {
				return conflict("snapshot import is incomplete");
			}
			let (bi, mut base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let mut logical = self.materialize_in(tx, &base)?;
			let events = self.staged_events(&m, &mut |key| tx.doc(&CHUNKS, key).map(|(_, v)| Some(v)), None, None)?;
			let now = self.now()?;
			self.clock_safe(n(&logical, "lastWallTime"), now)?;
			let added = self.append(&mut logical, &events, now)?;
			let mut segments = list(&base, "segments").to_vec();
			segments.push(obj! { "manifest" => m.clone(), "overlayThrough" => list(&base, "events").len() as f64 });
			let mut probe = logical.clone();
			put(&mut probe, "segments", Json::Array(segments.clone()));
			put(&mut probe, "config", self.config.clone());
			put(&mut probe, "configHash", self.config_hash.as_str().into());
			if segments.len() > 16 || bytes(&probe) as f64 > self.max_history_bytes {
				return exhausted("published snapshot exceeds retained history budget");
			}
			// only this small head update makes the previously hidden immutable pages visible
			if base.get("config").is_none_or(Json::is_null) {
				put(&mut base, "config", self.config.clone());
			}
			put(&mut base, "configHash", self.config_hash.as_str().into());
			put(&mut base, "segments", Json::Array(segments));
			put(&mut base, "clock", logical.get("clock").cloned().unwrap());
			put(&mut base, "seq", logical.get("seq").cloned().unwrap());
			put(&mut base, "lastWallTime", logical.get("lastWallTime").cloned().unwrap());
			tx.set(bi, base);
			let result = obj! { "added" => added as f64, "revision" => head_of(&logical), "sourceRevision" => m.get("revision").cloned().unwrap() };
			put(&mut t, "phase", "completed".into());
			put(&mut t, "result", result.clone());
			obj_mut(&mut ledger, "transfers").insert(sid.clone(), t);
			tx.set(li, ledger);
			self.check("import")?;
			Ok(result)
		})
	}
	pub fn abort_snapshot_import(&self, store: &mut Store, snapshot_id: Option<&Json>) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let Some(mut t) = ledger.get("transfers").and_then(|x| x.get(&sid)).cloned() else { return conflict("unknown snapshot import") };
			self.bind_manifest(t.get("manifest").unwrap_or(&Json::Null))?;
			if matches!(s(&t, "phase"), "completed" | "retiring" | "retired" | "consolidating") {
				return conflict("published or maintenance generation cannot be aborted");
			}
			if s(&t, "phase") == "aborted" {
				self.check("import")?;
				return Ok(t);
			}
			put(&mut t, "phase", "aborting".into());
			if n(&t, "cleanupCursor") < n(&t, "nextPage") {
				let (ci, mut chunk) = tx.doc(&CHUNKS, &chunk_key(&self.document_key, &sid, n(&t, "cleanupCursor")))?;
				put(&mut chunk, "page", Json::Null);
				tx.set(ci, chunk);
				bump(&mut t, "cleanupCursor", 1.0);
			}
			if n(&t, "cleanupCursor") == n(&t, "nextPage") {
				put(&mut t, "phase", "aborted".into());
				let r = n(&ledger, "retainedBytes") - n(&t, "reservedBytes");
				put(&mut ledger, "retainedBytes", num(r));
			}
			obj_mut(&mut ledger, "transfers").insert(sid.clone(), t.clone());
			tx.set(li, ledger);
			self.check("import")?;
			Ok(t)
		})
	}

	// ---- erasure

	/// IDs of every change owned by `principal` (also redacted ones).
	pub fn change_ids_owned_by(&self, store: &Store, principal: &Json) -> ER<Json> {
		let st = self.state(store, "export")?;
		let p = canonical(principal);
		Ok(Json::Array(st.map_or(vec![], |s| list(&s, "events").iter().filter(|e| kind_of(mutation(e)) != "erase" && canonical(mutation(e).get("owner").unwrap_or(&Json::Null)) == p).map(|e| Json::String(entry_change_id(e))).collect())))
	}
	pub fn erase_principal(&self, store: &mut Store, request_id: &Json, principal: &Json, admin: &Json) -> ER<Json> {
		let m = obj! { "kind" => "erase", "principal" => copy(principal)?, "owner" => copy(admin)? };
		self.mutate(store, request_id, &m)
	}
	pub fn erasure_status(&self, store: &Store) -> ER<Json> {
		self.check("read")?;
		let Some(base) = self.snapshot_doc(store, &STATE, &self.document_key)? else {
			self.check("read")?;
			return Ok(obj! { "erases" => 0.0, "overlayPending" => 0.0, "segmentsPending" => 0.0, "transfersPending" => 0.0, "complete" => true });
		};
		self.bind(&base)?;
		let raw = self.materialize(&base, &mut |key| self.snapshot_doc(store, &CHUNKS, key), true)?;
		let mut view = list(&raw, "events").to_vec();
		self.apply_erasures(&mut view)?;
		let target: HashMap<String, String> = view.iter().map(|e| (entry_change_id(e), canonical(e))).collect();
		let overlay_ids: HashSet<String> = list(&base, "events").iter().map(entry_change_id).collect();
		let overlay_pending = list(&base, "events").iter().filter(|e| target.get(&entry_change_id(e)) != Some(&canonical(e))).count();
		let segments_pending = list(&raw, "events").iter().filter(|e| !overlay_ids.contains(&entry_change_id(e)) && target.get(&entry_change_id(e)) != Some(&canonical(e))).count();
		let ledger = self.snapshot_doc(store, &TRANSFERS, &self.document_key)?;
		let erases = view.iter().filter(|e| kind_of(mutation(e)) == "erase").count();
		let transfers_pending = if erases > 0 { ledger.as_ref().and_then(|l| l.get("transfers")).and_then(Json::as_object).map_or(0, |t| t.iter().filter(|(_, t)| matches!(s(t, "phase"), "receiving" | "aborting")).count()) } else { 0 };
		self.check("read")?;
		Ok(obj! { "erases" => erases as f64, "overlayPending" => overlay_pending as f64, "segmentsPending" => segments_pending as f64, "transfersPending" => transfers_pending as f64, "complete" => overlay_pending == 0 && segments_pending == 0 && transfers_pending == 0 })
	}
	/// Brings this replica's storage to the redacted form: overlay, export cache, incoming transfers, snapshot segments.
	pub fn complete_erasure(&self, store: &mut Store, request_id: &Json) -> ER<Json> {
		if !id(Some(request_id)) {
			return conflict("invalid erasure request");
		}
		self.exports.borrow_mut().clear();
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (bi, mut base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let logical = self.materialize_in(tx, &base)?;
			let all = list(&logical, "events").len();
			self.persist_overlay(&mut base, &logical, all);
			tx.set(bi, base);
			Ok(())
		})?;
		let status = self.erasure_status(store)?;
		if n(&status, "transfersPending") > 0.0 {
			let ledger = self.snapshot_doc(store, &TRANSFERS, &self.document_key)?;
			for (sid, t) in ledger.as_ref().and_then(|l| l.get("transfers")).and_then(Json::as_object).map(|o| o.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
				if matches!(s(&t, "phase"), "receiving" | "aborting") {
					for _ in 0..100_000 {
						if s(&self.abort_snapshot_import(store, Some(&Json::String(sid.clone())))?, "phase") == "aborted" {
							break;
						}
					}
				}
			}
		}
		if n(&status, "segmentsPending") > 0.0 {
			let job = self.start_snapshot_maintenance(store, request_id, None)?;
			let mut phase = s(&job, "phase").to_owned();
			for _ in 0..100_000 {
				if phase == "completed" {
					break;
				}
				phase = s(&self.advance_snapshot_maintenance(store, request_id)?, "phase").to_owned();
			}
		}
		self.erasure_status(store)
	}

	// ---- maintenance and compaction

	pub fn start_snapshot_maintenance(&self, store: &mut Store, request_id: &Json, page_bytes: Option<&Json>) -> ER<Json> { self.start_maintenance(store, request_id, page_bytes, false) }
	pub fn start_compaction(&self, store: &mut Store, request_id: &Json, page_bytes: Option<&Json>) -> ER<Json> { self.start_maintenance(store, request_id, page_bytes, true) }
	fn start_maintenance(&self, store: &mut Store, request_id: &Json, page_bytes: Option<&Json>, compact: bool) -> ER<Json> {
		let pb = page_bytes.cloned().unwrap_or(num(self.default_page_bytes()));
		if !id(Some(request_id)) || !number(Some(&pb)) || pb.as_f64().unwrap() < 1024.0 || 2.0 * pb.as_f64().unwrap() + 16384.0 > self.max_batch_bytes {
			return conflict("invalid maintenance request or page budget");
		}
		let (rid, pb) = (request_id.as_str().unwrap().to_owned(), pb.as_f64().unwrap());
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (mi, mut maintenance) = tx.doc(&MAINTENANCE, &self.document_key)?;
			let job = maintenance.get("job").filter(|j| truthy(Some(j))).cloned();
			if let Some(job) = job.as_ref().filter(|j| s(j, "requestId") == rid && j.get("requestId").is_some_and(is_string)) {
				if n(job.get("manifest").unwrap_or(&Json::Null), "pageBytes") != pb {
					return conflict("maintenance request changed page budget");
				}
				self.check("import")?;
				return Ok(job.clone());
			}
			if job.as_ref().is_some_and(|j| s(j, "phase") != "completed") {
				return conflict("another snapshot maintenance request is active");
			}
			let (_, base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let transfers = ledger.get("transfers").and_then(Json::as_object).cloned().unwrap_or_default();
			if transfers.iter().any(|(_, t)| t.get("maintenanceRequestId").and_then(Json::as_str) == Some(rid.as_str())) {
				return conflict("older maintenance receipt cannot be restarted");
			}
			if transfers.iter().any(|(_, t)| !matches!(s(t, "phase"), "completed" | "retired" | "aborted")) {
				return conflict("finish or abort existing snapshot transfers first");
			}
			if transfers.len() >= 17 {
				return exhausted("retire expired snapshot receipts before maintenance");
			}
			let logical = self.materialize_in(tx, &base)?;
			let now = self.now()?;
			self.clock_safe(n(&logical, "lastWallTime"), now)?;
			// the decision is fixed here: stability only grows, so it stays valid while imports continue
			let all = list(&logical, "events");
			let (events, compaction): (Vec<Json>, Option<Json>) = if compact {
				let (_, peers) = tx.doc(&PEERS, &self.document_key)?;
				let plan = self.plan(&logical, Some(&peers), now)?;
				if let Some(why) = plan.blocked {
					return Err(EntryError::Conflict(format!("compaction blocked: {why}")));
				}
				let at = positions_of(all.len(), &runs_of_json(logical.get("dropped")));
				let drop: HashSet<usize> = plan.drop.iter().copied().collect();
				let kept = all.iter().enumerate().filter(|(i, _)| !drop.contains(i)).map(|(_, e)| e.clone()).collect();
				let runs = merge_runs(&[&plan.drop.iter().map(|i| (at[*i], at[*i])).collect::<Vec<_>>()]);
				(kept, Some(obj! { "dropped" => runs_json(&runs), "floor" => Json::Object(plan.floor) }))
			} else {
				(all.to_vec(), None)
			};
			let template = self.template(self.new_snapshot_id(), head_of(&logical), &events, pb, now);
			if !safe(n(&template, "expiresAt")) {
				return conflict("maintenance deadline overflow");
			}
			let (manifest, _) = self.pack_snapshot(&events, &template)?;
			let reserved = n(&manifest, "bytes") + n(&manifest, "pageCount") * 1024.0;
			if n(&ledger, "retainedBytes") + reserved > 3.0 * self.max_history_bytes + 2048.0 * 1024.0 {
				return exhausted("maintenance retained byte bound exceeded");
			}
			let mid = s(&manifest, "id").to_owned();
			obj_mut(&mut ledger, "transfers").insert(mid, obj! { "maintenanceRequestId" => rid.as_str(), "manifest" => manifest.clone(), "phase" => "consolidating", "nextPage" => 0.0, "nextOffset" => 0.0, "chainHash" => manifest.get("seedHash").cloned().unwrap(), "receivedBytes" => 2.0, "reservedBytes" => reserved, "cleanupCursor" => 0.0 });
			let r = n(&ledger, "retainedBytes") + reserved;
			put(&mut ledger, "retainedBytes", num(r));
			tx.set(li, ledger);
			let mut job = obj! { "requestId" => rid.as_str(), "phase" => "copying", "manifest" => manifest, "nextPage" => 0.0, "prefixCount" => all.len() as f64 };
			if let Some(c) = compaction {
				put(&mut job, "compaction", c);
			}
			put(&mut job, "overlayCount", num(list(&base, "events").len() as f64));
			put(&mut job, "previous", Json::Array(list(&base, "segments").iter().map(|sg| obj! { "snapshotId" => sg.get("manifest").and_then(|m| m.get("id")).cloned().unwrap_or(Json::Null), "pageCount" => sg.get("manifest").and_then(|m| m.get("pageCount")).cloned().unwrap_or(Json::Null), "nextPage" => 0.0 }).collect()));
			put(&mut maintenance, "job", job.clone());
			tx.set(mi, maintenance);
			self.check("import")?;
			Ok(job)
		})
	}
	pub fn snapshot_maintenance_status(&self, store: &Store) -> ER<Json> {
		self.check("import")?;
		let st = self.snapshot_doc(store, &MAINTENANCE, &self.document_key)?;
		self.check("import")?;
		Ok(st.and_then(|s| s.get("job").filter(|j| truthy(Some(j))).cloned()).unwrap_or(Json::Null))
	}
	/// One page copy, atomic reference publication, or one obsolete-page retirement per invocation.
	pub fn advance_snapshot_maintenance(&self, store: &mut Store, request_id: &Json) -> ER<Json> {
		if !id(Some(request_id)) {
			return conflict("invalid maintenance request");
		}
		let rid = request_id.as_str().unwrap().to_owned();
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (mi, mut maintenance) = tx.doc(&MAINTENANCE, &self.document_key)?;
			let Some(mut job) = maintenance.get("job").filter(|j| truthy(Some(j)) && s(j, "requestId") == rid && j.get("requestId").is_some_and(is_string)).cloned() else { return conflict("unknown maintenance request") };
			if s(&job, "phase") == "aborting" {
				return conflict("maintenance generation is being aborted");
			}
			let (bi, mut base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let manifest = job.get("manifest").cloned().unwrap_or(Json::Null);
			self.bind_manifest(&manifest)?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let mid = s(&manifest, "id").to_owned();
			let Some(mut replacement) = ledger.get("transfers").and_then(|t| t.get(&mid)).cloned() else { return conflict("maintenance receipt missing") };
			if s(&job, "phase") == "copying" {
				let segment_ids = list(&base, "segments").iter().map(|sg| js_string(sg.get("manifest").and_then(|m| m.get("id")).unwrap_or(&Json::Null))).collect::<Vec<_>>().join(",");
				let previous_ids = list(&job, "previous").iter().map(|p| js_string(p.get("snapshotId").unwrap_or(&Json::Null))).collect::<Vec<_>>().join(",");
				if segment_ids != previous_ids || (list(&base, "events").len() as f64) < n(&job, "overlayCount") {
					return conflict("maintenance source references changed");
				}
				let logical = self.materialize_in(tx, &base)?;
				let all = list(&logical, "events");
				let at = positions_of(all.len(), &runs_of_json(logical.get("dropped")));
				let take = job.get("prefixCount").filter(|x| !x.is_null()).and_then(Json::as_f64).unwrap_or(n(&manifest, "eventCount")).max(0.0) as usize;
				let dropped = job.get("compaction").filter(|c| truthy(Some(c))).map(|c| runs_of_json(c.get("dropped")));
				let prefix: Vec<Json> = all[..take.min(all.len())].iter().enumerate().filter(|(i, _)| dropped.as_ref().is_none_or(|d| !in_runs(at[*i], d))).map(|(_, e)| e.clone()).collect();
				let (packed, pages) = self.pack_snapshot(&prefix, &manifest)?;
				if canonical(&packed) != canonical(&manifest) {
					return conflict("maintenance source prefix changed");
				}
				if n(&job, "nextPage") < n(&manifest, "pageCount") {
					let next = n(&job, "nextPage");
					let page = pages[next as usize].clone();
					let (ci, mut chunk) = tx.doc(&CHUNKS, &chunk_key(&self.document_key, &mid, next))?;
					if !chunk.get("page").is_some_and(Json::is_null) {
						return conflict("maintenance page already occupied");
					}
					put(&mut chunk, "page", page.clone());
					tx.set(ci, chunk);
					put(&mut job, "nextPage", num(next + 1.0));
					put(&mut replacement, "nextPage", num(next + 1.0));
					bump(&mut replacement, "nextOffset", list(&page, "events").len() as f64);
					put(&mut replacement, "chainHash", page.get("sha256").cloned().unwrap());
					let grow = bytes(page.get("events").unwrap()) as f64 - 2.0 + if n(&page, "offset") > 0.0 && !list(&page, "events").is_empty() { 1.0 } else { 0.0 };
					bump(&mut replacement, "receivedBytes", grow);
				} else {
					let staged = self.staged_events(&manifest, &mut |key| tx.doc(&CHUNKS, key).map(|(_, v)| Some(v)), None, None)?;
					if canonical(&Json::Array(staged)) != canonical(&Json::Array(prefix)) {
						return conflict("maintenance publication prefix changed");
					}
					// existing and concurrent overlay writes retain order; the full prefix is now immutable pages
					let overlay = n(&job, "overlayCount") as usize;
					let keep = overlay.min(list(&base, "events").len());
					arr_mut(&mut base, "events").drain(..keep);
					put(&mut base, "segments", Json::Array(vec![obj! { "manifest" => manifest.clone(), "overlayThrough" => 0.0 }]));
					if let Some(c) = job.get("compaction").filter(|c| truthy(Some(c))) {
						let merged = merge_runs(&[&runs_of_json(base.get("dropped")), &runs_of_json(c.get("dropped"))]);
						put(&mut base, "dropped", runs_json(&merged));
						let mut floor = base.get("floor").and_then(Json::as_object).cloned().unwrap_or_default();
						for (k, v) in c.get("floor").and_then(Json::as_object).map(|o| o.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
							let cur = floor.get(&k).and_then(Json::as_f64).unwrap_or(0.0);
							floor.insert(k, num(cur.max(v.as_f64().unwrap_or(0.0))));
						}
						put(&mut base, "floor", Json::Object(floor));
					}
					for previous in list(&job, "previous") {
						let pid = s(previous, "snapshotId").to_owned();
						let transfers = obj_mut(&mut ledger, "transfers");
						match transfers.get_mut(&pid) {
							Some(t) if s(t, "phase") == "completed" => put(t, "phase", "retiring".into()),
							_ => return conflict("maintenance generation receipt changed"),
						}
					}
					put(&mut replacement, "phase", "completed".into());
					put(&mut replacement, "result", obj! { "added" => 0.0, "revision" => manifest.get("revision").cloned().unwrap(), "sourceRevision" => manifest.get("revision").cloned().unwrap() });
					put(&mut job, "phase", "cleaning".into());
					tx.set(bi, base);
				}
				obj_mut(&mut ledger, "transfers").insert(mid.clone(), replacement);
			} else if s(&job, "phase") == "cleaning" {
				let previous = arr_mut(&mut job, "previous");
				if let Some(p) = previous.iter_mut().find(|p| n(p, "nextPage") < n(p, "pageCount")) {
					let (pid, next) = (s(p, "snapshotId").to_owned(), n(p, "nextPage"));
					tx.retire(&CHUNKS, &chunk_key(&self.document_key, &pid, next));
					put(p, "nextPage", num(next + 1.0));
					if next + 1.0 == n(p, "pageCount") {
						let transfers = obj_mut(&mut ledger, "transfers");
						let reserved = match transfers.get_mut(&pid) {
							Some(t) if s(t, "phase") == "retiring" => {
								put(t, "phase", "retired".into());
								let np = t.get("nextPage").cloned().unwrap_or(Json::Null);
								put(t, "cleanupCursor", np);
								n(t, "reservedBytes")
							}
							_ => return conflict("maintenance cleanup receipt changed"),
						};
						let r = n(&ledger, "retainedBytes") - reserved;
						put(&mut ledger, "retainedBytes", num(r));
					}
				} else {
					put(&mut job, "phase", "completed".into());
				}
			}
			put(&mut maintenance, "job", job.clone());
			tx.set(mi, maintenance);
			tx.set(li, ledger);
			self.check("import")?;
			Ok(job)
		})
	}
	/// Aborts a generation that is still copying: one staged page per call, then the receipt and the job.
	pub fn abort_snapshot_maintenance(&self, store: &mut Store, request_id: &Json) -> ER<Json> {
		if !id(Some(request_id)) {
			return conflict("invalid maintenance request");
		}
		let rid = request_id.as_str().unwrap().to_owned();
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (mi, mut maintenance) = tx.doc(&MAINTENANCE, &self.document_key)?;
			let Some(mut job) = maintenance.get("job").filter(|j| truthy(Some(j)) && s(j, "requestId") == rid && j.get("requestId").is_some_and(is_string)).cloned() else {
				self.check("import")?;
				return Ok(Json::Null);
			};
			if !matches!(s(&job, "phase"), "copying" | "aborting") {
				return conflict("a published maintenance generation cannot be aborted");
			}
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let mid = s(job.get("manifest").unwrap_or(&Json::Null), "id").to_owned();
			let Some(mut t) = ledger.get("transfers").and_then(|x| x.get(&mid)).cloned().filter(|t| t.get("maintenanceRequestId").and_then(Json::as_str) == Some(rid.as_str())) else { return conflict("maintenance receipt missing") };
			put(&mut job, "phase", "aborting".into());
			if n(&job, "nextPage") > 0.0 {
				let next = n(&job, "nextPage") - 1.0;
				put(&mut job, "nextPage", num(next));
				tx.retire(&CHUNKS, &chunk_key(&self.document_key, &mid, next));
				put(&mut t, "nextPage", num(next));
				obj_mut(&mut ledger, "transfers").insert(mid, t);
				tx.set(li, ledger);
				put(&mut maintenance, "job", job.clone());
				tx.set(mi, maintenance);
				self.check("import")?;
				return Ok(job);
			}
			put(&mut t, "phase", "aborted".into());
			let r = n(&ledger, "retainedBytes") - n(&t, "reservedBytes");
			put(&mut ledger, "retainedBytes", num(r));
			obj_mut(&mut ledger, "transfers").insert(mid, t);
			tx.set(li, ledger);
			put(&mut maintenance, "job", Json::Null);
			tx.set(mi, maintenance);
			self.check("import")?;
			Ok(Json::Null)
		})
	}
	/// Advances a maintenance generation to its end; one whose source changed under it is aborted (false).
	fn finish_maintenance(&self, store: &mut Store, request_id: &Json) -> ER<bool> {
		let rid = request_id.as_str().unwrap_or("");
		let mut job = self.snapshot_maintenance_status(store)?;
		for _ in 0..100_000 {
			if job.is_null() || s(&job, "requestId") != rid || s(&job, "phase") == "completed" {
				break;
			}
			if s(&job, "phase") == "aborting" {
				job = self.abort_snapshot_maintenance(store, request_id)?;
				continue;
			}
			job = match self.advance_snapshot_maintenance(store, request_id) {
				Ok(j) => j,
				Err(EntryError::Conflict(m)) if m.contains("prefix changed") => self.abort_snapshot_maintenance(store, request_id)?,
				Err(e) => return Err(e),
			};
		}
		Ok(!job.is_null() && s(&job, "requestId") == rid && s(&job, "phase") == "completed")
	}
	/// Drops one expired, unreachable transfer receipt.
	pub fn forget_snapshot_receipt(&self, store: &mut Store, snapshot_id: Option<&Json>) -> ER<Json> {
		let sid = Self::snapshot_id(snapshot_id)?;
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (_, base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let now = self.now()?;
			self.clock_safe(n(&base, "lastWallTime"), now)?;
			let (li, mut ledger) = tx.doc(&TRANSFERS, &self.document_key)?;
			let Some(t) = ledger.get("transfers").and_then(|x| x.get(&sid)).cloned() else {
				self.check("import")?;
				return Ok(Json::Bool(false));
			};
			self.bind_manifest(t.get("manifest").unwrap_or(&Json::Null))?;
			let (_, maintenance) = tx.doc(&MAINTENANCE, &self.document_key)?;
			let job = maintenance.get("job").filter(|j| truthy(Some(j)));
			let live = !matches!(s(&t, "phase"), "retired" | "aborted") || n(t.get("manifest").unwrap_or(&Json::Null), "expiresAt") > now || list(&base, "segments").iter().any(|sg| sg.get("manifest").and_then(|m| m.get("id")).and_then(Json::as_str) == Some(sid.as_str())) || job.is_some_and(|j| s(j, "phase") != "completed" && list(j, "previous").iter().any(|p| p.get("snapshotId").and_then(Json::as_str) == Some(sid.as_str())));
			if live {
				return conflict("snapshot receipt is live or has not expired");
			}
			obj_mut(&mut ledger, "transfers").remove(&sid);
			tx.set(li, ledger);
			self.check("import")?;
			Ok(Json::Bool(true))
		})
	}

	/// Contiguous received sequence per configured origin: the floor, then every present sequence after it.
	fn vector_of(&self, st: Option<&Json>) -> Object {
		let mut seqs: HashMap<String, HashSet<u64>> = HashMap::new();
		for e in st.map_or(&[][..], |s| list(s, "events")) {
			seqs.entry(origin(e)).or_default().insert(n(e, "seq") as u64);
		}
		let mut out = Object::new();
		for m in self.members() {
			let k = member_key(m);
			let mut v = st.and_then(|s| s.get("floor")).and_then(|f| f.get(&k)).and_then(Json::as_f64).unwrap_or(0.0);
			while seqs.get(&k).is_some_and(|set| set.contains(&((v + 1.0) as u64))) {
				v += 1.0;
			}
			out.insert(k, num(v));
		}
		out
	}
	/// Records the vector a peer advertised. A lower value marks the peer regressed.
	pub fn record_peer_vector(&self, store: &mut Store, input: &Json) -> ER<Json> {
		let d = copy(input)?;
		self.validate_stream(d.get("source"))?;
		let source = d.get("source").unwrap();
		let v = d.get("vector").cloned();
		let keys: Vec<String> = self.members().iter().map(member_key).collect();
		if source.get("replicaId").and_then(Json::as_str) == Some(self.replica_id()) {
			return conflict("the own stream is not a peer");
		}
		let vo = v.as_ref().and_then(Json::as_object);
		if vo.is_none_or(|o| o.keys().any(|k| !keys.iter().any(|x| x == k)) || o.iter().any(|(_, x)| !number(Some(x)))) {
			return conflict("invalid peer vector");
		}
		let v = v.unwrap();
		self.check("import")?;
		let now = self.now()?;
		let replica = s(source, "replicaId").to_owned();
		let fresh = |o: Option<&Json>| o.is_some_and(|o| truthy(Some(o)) && !truthy(o.get("regressed")) && o.get("incarnation") == source.get("incarnation") && canonical(o.get("vector").unwrap_or(&Json::Null)) == canonical(&v) && now - n(o, "recordedAt") < 10_000.0);
		// a fresh, unchanged vector needs no commit; recordedAt may lag by that much, which only delays compaction
		if fresh(self.snapshot_doc(store, &PEERS, &self.document_key)?.as_ref().and_then(|p| p.get("peers")).and_then(|p| p.get(&replica))) {
			return Ok(Json::Null);
		}
		self.commit(store, |tx| {
			self.check("import")?;
			let (pi, mut doc) = tx.doc(&PEERS, &self.document_key)?;
			let old = doc.get("peers").and_then(|p| p.get(&replica)).cloned();
			if fresh(old.as_ref()) {
				return Ok(Json::Null);
			}
			let same = old.as_ref().is_some_and(|o| truthy(Some(o)) && o.get("incarnation") == source.get("incarnation"));
			let lower = |o: &Json| keys.iter().any(|k| v.get(k).and_then(Json::as_f64).unwrap_or(0.0) < o.get("vector").and_then(|x| x.get(k)).and_then(Json::as_f64).unwrap_or(0.0));
			let next = match old {
				Some(o) if same && (truthy(o.get("regressed")) || lower(&o)) => {
					let mut x = o.clone();
					put(&mut x, "regressed", Json::Bool(true));
					x
				}
				_ => obj! { "incarnation" => source.get("incarnation").cloned().unwrap(), "vector" => v.clone(), "recordedAt" => now },
			};
			obj_mut(&mut doc, "peers").insert(replica.clone(), next);
			tx.set(pi, doc);
			self.check("import")?;
			Ok(Json::Null)
		})
	}
	/// Which events can go: stable, invisible for a stable reason, never an erase, and not anchoring a retained change.
	fn plan(&self, st: &Json, peers: Option<&Json>, now: f64) -> ER<Plan> {
		let own = self.vector_of(Some(st));
		let mut floor = own.clone();
		let mut recorded = now;
		let blocked = |why: String| Ok(Plan { blocked: Some(why), drop: vec![], floor: Object::new() });
		for m in self.members() {
			if s(m, "replicaId") == self.replica_id() {
				continue;
			}
			let p = peers.and_then(|p| p.get("peers")).and_then(|p| p.get(s(m, "replicaId"))).filter(|p| truthy(Some(p)));
			let k = member_key(m);
			let Some(p) = p.filter(|p| p.get("incarnation") == m.get("incarnation")) else { return blocked(format!("no vector recorded from member {}", s(m, "replicaId"))) };
			if truthy(p.get("regressed")) {
				return blocked(format!("member {} advertised a lower vector; a restored replica needs a new incarnation", s(m, "replicaId")));
			}
			let pv = |o: &str| p.get("vector").and_then(|v| v.get(o)).and_then(Json::as_f64).unwrap_or(0.0);
			if own.get(&k).and_then(Json::as_f64).unwrap_or(0.0) < pv(&k) {
				return blocked(format!("changes of member {} are still missing here", s(m, "replicaId")));
			}
			let ks: Vec<String> = floor.keys().map(str::to_owned).collect();
			for o in ks {
				let cur = floor.get(&o).and_then(Json::as_f64).unwrap_or(0.0);
				floor.insert(o.clone(), num(cur.min(pv(&o))));
			}
			recorded = recorded.min(n(p, "recordedAt"));
		}
		let events = list(st, "events");
		let index: HashMap<String, usize> = events.iter().enumerate().map(|(i, e)| (entry_change_id(e), i)).collect();
		let retain_own = self.retention.unwrap_or(86_400_000.0);
		let fl = |o: &str| floor.get(o).and_then(Json::as_f64).unwrap_or(0.0);
		let stable = |e: &Json| n(e, "seq") <= fl(&origin(e));
		let ok = |e: &Json| stable(e) && !(self.own(e) && n(e.get("clock").unwrap_or(&Json::Null), "physical") + retain_own > now);
		let expired = |m: &Json, at: f64| m.get("expiresAt").is_some_and(|x| !x.is_null()) && n(m, "expiresAt") + ENTRY_EXPIRY_GRACE_MS <= at;
		let variant = |m: &Json| s(self.rule(s(m, "type")).expect("a validated type"), "variant").to_owned();
		let beats = |a: &Json, b: &Json| {
			let c = compare_clock(a.get("clock").unwrap(), b.get("clock").unwrap());
			c == Ordering::Greater || c == Ordering::Equal && lt(s(b, "originReplicaId"), s(a, "originReplicaId"))
		};
		let renewed = |m: &Json| if kind_of(m) == "renew" || kind_of(m) == "redacted" && s(m, "was") == "renew" { Some(s(m, "tag").to_owned()) } else { None };
		let mut groups: Vec<(String, Vec<usize>)> = vec![];
		let mut removed_stably: HashSet<String> = HashSet::new();
		let mut renews_of: HashMap<String, Vec<usize>> = HashMap::new();
		let mut candidates: Vec<usize> = vec![];
		let mut is_candidate: HashSet<usize> = HashSet::new();
		let mut add = |i: usize, c: &mut Vec<usize>| {
			if is_candidate.insert(i) {
				c.push(i);
			}
		};
		for (i, e) in events.iter().enumerate() {
			let m = mutation(e);
			if kind_of(m) == "erase" {
				continue;
			}
			if variant(m) == "lww" {
				let r = self.rule(s(m, "type")).unwrap();
				let k = if kind_of(m) == "redacted" { s(m, "keyHash").to_owned() } else { hash(&Json::String(lww_key(r, m.get("fields").unwrap_or(&Json::Null))?)) };
				match groups.iter_mut().find(|(x, _)| *x == k) {
					Some((_, g)) => g.push(i),
					None => groups.push((k, vec![i])),
				}
				continue;
			}
			let tag = renewed(m);
			if let Some(t) = &tag {
				renews_of.entry(t.clone()).or_default().push(i);
			}
			if stable(e) {
				if kind_of(m) == "remove" {
					for t in list(m, "tags") {
						removed_stably.insert(t.as_str().unwrap_or("").to_owned());
					}
				}
				if let Some(t) = tag {
					removed_stably.insert(t);
				}
			}
		}
		// lww: superseded versions go; the winner (tombstone, redacted or expired) only together with every older version
		for (_, items) in &mut groups {
			items.sort_by(|x, y| if beats(&events[*x], &events[*y]) { Ordering::Less } else { Ordering::Greater });
			let (w, rest) = (items[0], &items[1..]);
			let wm = mutation(&events[w]);
			let going: Vec<usize> = rest.iter().copied().filter(|i| ok(&events[*i])).collect();
			for i in &going {
				add(*i, &mut candidates);
			}
			if going.len() == rest.len() && ok(&events[w]) && (kind_of(wm) == "delete" || kind_of(wm) == "redacted" || kind_of(wm) == "put" && expired(wm, now)) {
				add(w, &mut candidates);
			}
		}
		// set: a tag removed by a stable remove or renew, erased by a stable erase, or expired before every vector was recorded
		for (i, e) in events.iter().enumerate() {
			let m = mutation(e);
			if kind_of(m) == "erase" || variant(m) != "set" || !ok(e) {
				continue;
			}
			if kind_of(m) == "remove" {
				add(i, &mut candidates);
				continue;
			}
			let erase = if kind_of(m) == "redacted" { index.get(s(m, "erase")).map(|j| &events[*j]) } else { None };
			if removed_stably.contains(&entry_change_id(e)) || erase.is_some_and(stable) || kind_of(m) != "redacted" && expired(m, now.min(recorded)) {
				add(i, &mut candidates);
			}
		}
		let mut drop: Vec<usize> = candidates;
		// gone: removed now, or absent below the floor (held here once, so removed earlier)
		let gone = |tag: &str, drop: &[usize]| match index.get(tag) {
			Some(i) => drop.contains(i),
			None => {
				let v = parse(tag).ok();
				let a = v.as_ref().and_then(Json::as_array);
				let (r, inc, seq) = (a.and_then(|a| a.first()).cloned().unwrap_or(Json::Null), a.and_then(|a| a.get(1)).cloned().unwrap_or(Json::Null), a.and_then(|a| a.get(2)).and_then(Json::as_f64).unwrap_or(f64::NAN));
				seq <= fl(&canonical(&Json::Array(vec![r, inc])))
			}
		};
		let mut changed = true;
		while changed {
			changed = false;
			for i in drop.clone() {
				let m = mutation(&events[i]);
				if kind_of(m) == "erase" || variant(m) != "set" {
					continue;
				}
				let tags: Vec<String> = if kind_of(m) == "remove" { list(m, "tags").iter().map(|t| t.as_str().unwrap_or("").to_owned()).collect() } else { renewed(m).into_iter().collect() };
				// a removal stays while its tag does; a renewed tag stays while a renewal that is not yet stable names it
				let keep = tags.iter().any(|t| !gone(t, &drop)) || renews_of.get(&entry_change_id(&events[i])).is_some_and(|rs| rs.iter().any(|r| !drop.contains(r) && !stable(&events[*r])));
				if keep {
					drop.retain(|x| *x != i);
					changed = true;
				}
			}
		}
		drop.sort_unstable();
		Ok(Plan { blocked: None, drop, floor })
	}
	pub fn compaction_status(&self, store: &Store) -> ER<Json> {
		let st = self.state(store, "read")?;
		let peers = self.snapshot_doc(store, &PEERS, &self.document_key)?;
		let Some(st) = st else { return Ok(obj! { "blocked" => Json::Null, "events" => 0.0, "droppable" => 0.0, "floor" => Object::new() }) };
		let p = self.plan(&st, peers.as_ref(), self.now()?)?;
		Ok(obj! { "blocked" => p.blocked.map_or(Json::Null, Json::String), "events" => list(&st, "events").len() as f64, "droppable" => p.drop.len() as f64, "floor" => Json::Object(p.floor) })
	}
	/// One compaction to completion; nothing happens while it is blocked or nothing can go.
	pub fn compact(&self, store: &mut Store, request_id: &Json) -> ER<Json> {
		// each generation leaves a receipt; retired and aborted ones go once expired, so periodic runs never run out
		let ledger = self.snapshot_doc(store, &TRANSFERS, &self.document_key)?;
		let now = self.now()?;
		for (sid, t) in ledger.as_ref().and_then(|l| l.get("transfers")).and_then(Json::as_object).map(|o| o.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
			if matches!(s(&t, "phase"), "retired" | "aborted") && n(t.get("manifest").unwrap_or(&Json::Null), "expiresAt") <= now {
				match self.forget_snapshot_receipt(store, Some(&Json::String(sid))) {
					Ok(_) | Err(EntryError::Conflict(_)) => {}
					Err(e) => return Err(e),
				}
			}
		}
		// a generation left from before (a restart, or an erase changed its source) is finished or aborted first
		let active = self.snapshot_maintenance_status(store)?;
		if !active.is_null() && s(&active, "phase") != "completed" {
			self.finish_maintenance(store, active.get("requestId").unwrap_or(&Json::Null))?;
			return Ok(obj! { "dropped" => 0.0, "status" => self.compaction_status(store)? });
		}
		let before = self.compaction_status(store)?;
		if !before.get("blocked").is_some_and(Json::is_null) || n(&before, "droppable") == 0.0 {
			return Ok(obj! { "dropped" => 0.0, "status" => before });
		}
		let job = self.start_compaction(store, request_id, None)?;
		let done = self.finish_maintenance(store, request_id)?;
		let dropped = if done { dropped_count(&runs_of_json(job.get("compaction").and_then(|c| c.get("dropped")))) } else { 0.0 };
		Ok(obj! { "dropped" => dropped, "status" => self.compaction_status(store)? })
	}

	// ---- the stream

	pub fn stream_identity(&self) -> Json {
		let mut body = obj! { "version" => 1.0, "spaceId" => self.config.get("spaceId").cloned().unwrap(), "authorityId" => self.config.get("authorityId").cloned().unwrap(), "configHash" => self.config_hash.as_str(), "replicaId" => self.replica_id(), "incarnation" => self.incarnation() };
		let h = hash(&body);
		put(&mut body, "streamId", h.into());
		body
	}
	fn validate_stream(&self, source: Option<&Json>) -> ER<()> {
		let Some(src) = source.filter(|x| truthy(Some(x))) else { return conflict("stream identity or binding changed") };
		if !exact(src, &["version", "spaceId", "authorityId", "configHash", "replicaId", "incarnation", "streamId"]) || src.get("version") != Some(&num(1.0)) || src.get("spaceId") != self.config.get("spaceId") || src.get("authorityId") != self.config.get("authorityId") || src.get("configHash") != Some(&Json::String(self.config_hash.clone())) || !self.member(src.get("replicaId"), src.get("incarnation")) || !sha(src.get("streamId")) {
			return conflict("stream identity or binding changed");
		}
		if s(src, "streamId") != hash(&without(src, &["streamId"])) {
			return conflict("stream identity hash changed");
		}
		Ok(())
	}
	fn stream_page_hash(page: &Json) -> String {
		let mut body = obj! { "source" => page.get("source").cloned().unwrap_or(Json::Null), "after" => page.get("after").cloned().unwrap_or(Json::Null), "next" => page.get("next").cloned().unwrap_or(Json::Null), "events" => page.get("events").cloned().unwrap_or(Json::Null) };
		if truthy(page.get("positions")) {
			put(&mut body, "positions", page.get("positions").cloned().unwrap());
		}
		hash(&body)
	}
	pub fn describe_stream(&self, store: &Store) -> ER<Json> {
		let st = self.state(store, "export")?;
		Ok(obj! { "source" => self.stream_identity(), "revision" => st.as_ref().map_or(0.0, head_of), "vector" => Json::Object(self.vector_of(st.as_ref())) })
	}
	pub fn stream_changes(&self, store: &Store, after: Option<&Json>, max_bytes: Option<&Json>) -> ER<Json> {
		let st = self.state(store, "export")?;
		let head = st.as_ref().map_or(0.0, head_of);
		let (after, max_bytes) = (after.cloned().unwrap_or(Json::Null), max_bytes.cloned().unwrap_or(num(self.default_page_bytes())));
		if !number(Some(&after)) || after.as_f64().unwrap() > head || !number(Some(&max_bytes)) || max_bytes.as_f64().unwrap() < 1024.0 || max_bytes.as_f64().unwrap() > 256.0 * 1024.0 {
			return conflict("invalid stream cursor or page budget");
		}
		let a = after.as_f64().unwrap();
		let source = self.stream_identity();
		let frame = |events: &[Json], positions: &[f64], next: f64, more: bool| {
			let mut f = obj! { "source" => source.clone(), "after" => a, "next" => next, "headRevision" => head, "more" => more, "events" => events.to_vec() };
			if !contiguous(a, positions) {
				put(&mut f, "positions", Json::Array(positions.iter().map(|p| num(*p)).collect()));
			}
			put(&mut f, "sha256", ZERO.into());
			f
		};
		let (events, positions, next, more) = self.page_after(st.as_ref(), a, max_bytes.as_f64().unwrap(), &frame, "next change does not fit stream page")?;
		let mut page = frame(&events, &positions, next, more);
		let h = Self::stream_page_hash(&page);
		put(&mut page, "sha256", h.into());
		Ok(page)
	}
	pub fn start_stream_import(&self, store: &mut Store, input: &Json, snapshot_id: Option<&Json>) -> ER<Json> {
		let source = copy(input)?;
		self.validate_stream(Some(&source))?;
		let sid = match snapshot_id {
			Some(v) => Some(Self::snapshot_id(Some(v))?),
			None => None,
		};
		self.check("import")?;
		let stream_id = s(&source, "streamId").to_owned();
		self.commit(store, |tx| {
			self.check("import")?;
			let (_, base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let (li, mut ledger) = tx.doc(&CHECKPOINTS, &self.document_key)?;
			let old = ledger.get("links").and_then(|l| l.get(&stream_id)).cloned();
			if old.as_ref().is_some_and(|o| canonical(o.get("source").unwrap_or(&Json::Null)) != canonical(&source)) {
				return conflict("stored stream source changed");
			}
			let mut seed = 0.0;
			if let Some(sid) = sid.as_ref().filter(|sid| !old.as_ref().is_some_and(|o| o.get("seedSnapshotId").and_then(Json::as_str) == Some(sid.as_str()))) {
				let (_, transfers) = tx.doc(&TRANSFERS, &self.document_key)?;
				let t = transfers.get("transfers").and_then(|t| t.get(sid)).filter(|t| truthy(Some(t)));
				let Some(t) = t.filter(|t| matches!(s(t, "phase"), "completed" | "retiring" | "retired") && truthy(t.get("result")) && t.get("manifest").and_then(|m| m.get("sourceReplicaId")) == source.get("replicaId") && t.get("manifest").and_then(|m| m.get("sourceIncarnation")) == source.get("incarnation")) else {
					return conflict("stream seed requires completed snapshot from this source");
				};
				let m = t.get("manifest").unwrap();
				self.bind_manifest(m)?;
				let published = matches!(s(t, "phase"), "retiring" | "retired") || list(&base, "segments").iter().any(|sg| sg.get("manifest").and_then(|x| x.get("id")).and_then(Json::as_str) == Some(sid.as_str()) && canonical(sg.get("manifest").unwrap()) == canonical(m));
				if t.get("result").and_then(|r| r.get("sourceRevision")) != m.get("revision") || !published {
					return conflict("stream seed snapshot is not published");
				}
				seed = n(t.get("result").unwrap(), "sourceRevision");
			}
			match old {
				None => {
					if ledger.get("links").and_then(Json::as_object).map_or(0, Object::len) >= 32 {
						return exhausted("stream checkpoint capacity exhausted");
					}
					let mut link = obj! { "source" => source.clone(), "cursor" => seed, "last" => Json::Null };
					if let Some(sid) = &sid {
						put(&mut link, "seedSnapshotId", sid.as_str().into());
					}
					obj_mut(&mut ledger, "links").insert(stream_id.clone(), link);
				}
				Some(mut o) if seed > n(&o, "cursor") => {
					put(&mut o, "cursor", num(seed));
					put(&mut o, "seedSnapshotId", sid.clone().map_or(Json::Null, Json::String));
					put(&mut o, "last", Json::Null);
					obj_mut(&mut ledger, "links").insert(stream_id.clone(), o);
				}
				Some(_) => {}
			}
			let out = ledger.get("links").and_then(|l| l.get(&stream_id)).cloned().unwrap();
			tx.set(li, ledger);
			self.check("import")?;
			Ok(out)
		})
	}
	pub fn stream_import_status(&self, store: &Store, input: &Json) -> ER<Json> {
		let source = copy(input)?;
		self.validate_stream(Some(&source))?;
		self.check("import")?;
		let ledger = self.snapshot_doc(store, &CHECKPOINTS, &self.document_key)?;
		let checkpoint = ledger.as_ref().and_then(|l| l.get("links")).and_then(|l| l.get(s(&source, "streamId"))).cloned();
		if checkpoint.as_ref().is_some_and(|c| canonical(c.get("source").unwrap_or(&Json::Null)) != canonical(&source)) {
			return conflict("stored stream source changed");
		}
		self.check("import")?;
		Ok(checkpoint.unwrap_or(Json::Null))
	}
	pub fn import_stream_page(&self, store: &mut Store, input: &Json) -> ER<Json> {
		let page = copy(input)?;
		let has_positions = page.get("positions").is_some();
		let mut keys = vec!["source", "after", "next", "headRevision", "more", "events", "sha256"];
		if has_positions {
			keys.push("positions");
		}
		if !truthy(Some(&page)) || !exact(&page, &keys) {
			return conflict("invalid stream page");
		}
		self.validate_stream(page.get("source"))?;
		// positions are absent while contiguous (after+1 ... next); a compacted source names them, strictly increasing
		let after = page.get("after").and_then(Json::as_f64).unwrap_or(f64::NAN);
		let positions: Option<Vec<Json>> = match page.get("positions").filter(|p| !p.is_null()) {
			Some(p) => p.as_array().cloned(),
			None => Some(page.get("events").and_then(Json::as_array).map_or(vec![], |e| (0..e.len()).map(|i| num(after + i as f64 + 1.0)).collect())),
		};
		let events = page.get("events").and_then(Json::as_array);
		let (next, head) = (n(&page, "next"), n(&page, "headRevision"));
		let more = page.get("more").and_then(Json::as_bool);
		let ok = number(page.get("after"))
			&& number(page.get("next"))
			&& number(page.get("headRevision"))
			&& after <= next
			&& next <= head
			&& more.is_some()
			&& more == Some(next < head)
			&& events.is_some_and(|e| e.len() <= 1024)
			&& positions.as_ref().is_some_and(|p| {
				let e = events.unwrap();
				p.len() == e.len() && p.iter().enumerate().all(|(i, x)| number(Some(x)) && x.as_f64().unwrap() > if i > 0 { p[i - 1].as_f64().unwrap_or(f64::NAN) } else { after }) && match p.last() {
					Some(l) => !(l.as_f64().unwrap() > next || more == Some(true) && l.as_f64().unwrap() != next),
					None => more != Some(true),
				}
			})
			&& sha(page.get("sha256"))
			&& Self::stream_page_hash(&page) == s(&page, "sha256")
			&& bytes(&page) <= 256 * 1024;
		if !ok {
			return conflict("stream page range or hash changed");
		}
		self.budget(page.get("events").unwrap())?;
		let stream_id = s(page.get("source").unwrap(), "streamId").to_owned();
		self.check("import")?;
		self.commit(store, |tx| {
			self.check("import")?;
			let (_, base) = tx.doc(&STATE, &self.document_key)?;
			self.bind(&base)?;
			let (li, mut ledger) = tx.doc(&CHECKPOINTS, &self.document_key)?;
			let Some(mut checkpoint) = ledger.get("links").and_then(|l| l.get(&stream_id)).cloned().filter(|c| canonical(c.get("source").unwrap_or(&Json::Null)) == canonical(page.get("source").unwrap())) else {
				return conflict("stream is not initialized with this source");
			};
			if page.get("after") != checkpoint.get("cursor") {
				let last = checkpoint.get("last").filter(|l| truthy(Some(l)));
				if let Some(last) = last.filter(|l| l.get("after") == page.get("after") && l.get("next") == page.get("next")) {
					if last.get("sha256") != page.get("sha256") {
						return conflict("decided stream page changed content");
					}
					self.check("import")?;
					return Ok(last.get("result").cloned().unwrap_or(Json::Null));
				}
				return Err(EntryError::Cursor(n(&checkpoint, "cursor")));
			}
			let applied = self.import_in(tx, page.get("events").and_then(Json::as_array).unwrap())?;
			let mut result = applied;
			put(&mut result, "cursor", num(next));
			if next > after {
				put(&mut checkpoint, "cursor", num(next));
				put(&mut checkpoint, "last", obj! { "after" => after, "next" => next, "sha256" => page.get("sha256").cloned().unwrap(), "result" => result.clone() });
				obj_mut(&mut ledger, "links").insert(stream_id.clone(), checkpoint);
				tx.set(li, ledger);
			}
			self.check("import")?;
			Ok(result)
		})
	}
}

enum Equivalence {
	Same,
	Replace,
	Conflict,
}
struct Plan {
	blocked: Option<String>,
	drop: Vec<usize>,
	floor: Object,
}

/// `canonical([principal, generation, requestId])` hashed: the request a merge change answers (`changeRequestHash`).
pub fn change_request_hash(principal: &Json, generation: &str, request_id: &str) -> String { hash(&Json::Array(vec![principal.clone(), generation.into(), request_id.into()])) }
