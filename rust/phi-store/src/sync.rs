//! The primary/sync journal (src/primary-sync.ts `PrimarySyncJournal`): a hash chain of commit intents in its own SQLite file,
//! in the format TypeScript writes (test/vectors/primary.journal.sql), so that either side takes over the other's journal.
//! Version 1 is a commit, 2 a replica configuration change, 3 a bootstrap chunk; the configuration in force is derived
//! from the chain. The deltas are the own store's row changes as JSON (`{t: "doc"|"part"|…}`), the marker write last.
use phi_json::{digest_json, obj, parse, Json};
use rusqlite::{params, Connection, OptionalExtension};
use std::path::Path;

/// `PrimarySyncBlocked`, or its subclass `SyncJournalFull` (the per-commit or history budget is used up).
#[derive(Debug, Clone, PartialEq)]
pub enum SyncError {
	Blocked(String),
	Full(String),
}
impl SyncError {
	pub fn message(&self) -> &str { match self { SyncError::Blocked(m) | SyncError::Full(m) => m } }
	pub fn name(&self) -> &'static str { match self { SyncError::Blocked(_) => "PrimarySyncBlocked", SyncError::Full(_) => "SyncJournalFull" } }
}
impl std::fmt::Display for SyncError {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { f.write_str(self.message()) }
}
pub type Result<T> = std::result::Result<T, SyncError>;
fn blocked<T>(m: impl Into<String>) -> Result<T> { Err(SyncError::Blocked(m.into())) }
fn sql<T>(r: rusqlite::Result<T>) -> Result<T> { r.map_err(|e| SyncError::Blocked(e.to_string())) }

pub const ZERO: &str = "0000000000000000000000000000000000000000000000000000000000000000";
const MARKER_PREFIX: &str = "sync-marker:";
const PI_DURABLE_JOURNAL: &str = "this journal belongs to a pi-durable store; pi-durable stores are discarded, not taken over (decision D6, docs/umstellung-u0-bestand.en.md): set the Space up anew on the own store";

pub fn hash(v: &Json) -> String { digest_json(v).expect("journal values are parsed JSON, so finite") }
pub fn canonical(v: &Json) -> String { v.canonical().expect("journal values are parsed JSON, so finite") }
/// `canonicalCopy`: the value with its keys in canonical order.
pub fn copy(v: &Json) -> Json { parse(&canonical(v)).expect("canonical JSON parses") }
fn keys_are(v: &Json, keys: &[&str]) -> bool {
	let Some(o) = v.as_object() else { return false };
	let mut have: Vec<&str> = o.keys().collect();
	let mut want = keys.to_vec();
	have.sort_unstable();
	want.sort_unstable();
	have == want
}
fn name(v: Option<&Json>) -> bool {
	v.and_then(Json::as_str).is_some_and(|s| {
		let b = s.as_bytes();
		!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(c))
	})
}
fn reason_like(s: &str) -> bool {
	let b = s.as_bytes();
	!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
}
/// `Number.isSafeInteger(v) && v >= 0`.
fn integer(v: Option<&Json>) -> Option<f64> {
	v.and_then(Json::as_f64).filter(|x| x.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(x))
}
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }
fn text<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap_or("") }

/// `durability` absent means sync.
pub fn durability_of(c: &Json) -> &str { c.get("durability").and_then(Json::as_str).unwrap_or("sync") }

/// `configOf`: a configuration as the journal keeps it, or refused.
pub fn config_of(input: &Json) -> Result<Json> {
	let c = copy(input);
	let base = ["spaceId", "authorityId", "primaryEpoch", "replicaConfigVersion", "primaryReplica", "standbyReplica"];
	let with: Vec<&str> = base.iter().copied().chain(["durability"]).collect();
	let invalid = || blocked("invalid fixed primary/standby configuration");
	if !(keys_are(&c, &base) || keys_are(&c, &with)) || !["spaceId", "authorityId", "primaryReplica"].iter().all(|k| name(c.get(k))) || integer(c.get("primaryEpoch")).is_none_or(|e| e < 1.0) || integer(c.get("replicaConfigVersion")).is_none_or(|v| v < 1.0) {
		return invalid();
	}
	if let Some(d) = c.get("durability") {
		if !matches!(d.as_str(), Some("sync" | "single")) { return invalid(); }
	}
	let standby = c.get("standbyReplica");
	let wrong = if durability_of(&c) == "sync" { !name(standby) || standby.and_then(Json::as_str) == c.get("primaryReplica").and_then(Json::as_str) } else { !standby.is_some_and(Json::is_null) };
	if wrong { return invalid(); }
	Ok(c)
}

/// `validateConfigTransition`: same Space and authority, version +1, epoch unchanged or +1, a new primary only with a new epoch.
pub fn validate_config_transition(previous: &Json, next: &Json) -> Result<Json> {
	let (p, n) = (config_of(previous)?, config_of(next)?);
	if text(&n, "spaceId") != text(&p, "spaceId") || text(&n, "authorityId") != text(&p, "authorityId") { return blocked("a replica transition keeps Space and authority"); }
	if num(&n, "replicaConfigVersion") != num(&p, "replicaConfigVersion") + 1.0 { return blocked("a replica transition raises replicaConfigVersion by exactly one"); }
	let (pe, ne) = (num(&p, "primaryEpoch"), num(&n, "primaryEpoch"));
	if ne != pe && ne != pe + 1.0 { return blocked("a replica transition keeps or raises primaryEpoch by one"); }
	if text(&n, "primaryReplica") != text(&p, "primaryReplica") && ne != pe + 1.0 { return blocked("a new primary requires a new primaryEpoch"); }
	Ok(n)
}

/// What the marker of an entry says: `{configHash, revision, batchHash, previousHash}`.
pub fn marker_of(i: &Json) -> Json {
	obj! { "configHash" => hash(i.get("config").unwrap_or(&Json::Null)), "revision" => num(i, "revision"), "batchHash" => text(i, "batchHash"), "previousHash" => text(i, "previousHash") }
}

/// The own store's codec (src/store/own-sync-codec.ts): the marker is a `store_meta` value.
pub mod own {
	use super::*;
	pub const FORMAT: &str = "own";
	pub fn marker_key(space_id: &str) -> String { format!("{MARKER_PREFIX}{space_id}") }
	pub fn marker_write(space_id: &str, value: &Json) -> Json { obj! { "t" => "meta", "key" => marker_key(space_id), "value" => value.to_json_text() } }
	/// If `w` is the marker write of `space_id`: its value and its ref (the key).
	pub fn marker_of(w: &Json, space_id: &str) -> Option<(Json, String)> {
		if w.get("t").and_then(Json::as_str) != Some("meta") || w.get("key").and_then(Json::as_str) != Some(&marker_key(space_id)) { return None; }
		parse(w.get("value")?.as_str()?).ok().map(|v| (v, marker_key(space_id)))
	}
	pub fn touches(w: &Json) -> bool { w.get("t").and_then(Json::as_str) == Some("meta") && w.get("key").and_then(Json::as_str).is_some_and(|k| k.starts_with(MARKER_PREFIX)) }
	pub fn bootstrap_write(w: &Json) -> bool { matches!(w.get("t").and_then(Json::as_str), Some("doc" | "part")) }
}

#[derive(Default)]
pub struct JournalOptions {
	pub max_intent_bytes: Option<f64>,
	pub max_history_bytes: Option<f64>,
	/// This replica: an entry is accepted only if it names this host as its standby.
	pub self_id: Option<String>,
	pub format: Option<String>,
}

pub struct SyncJournal {
	db: Connection,
	configs: Vec<Json>,
	pub max_intent_bytes: usize,
	pub max_history_bytes: usize,
	self_id: Option<String>,
	/// The store kind, once bound.
	format: Option<String>,
	used_bytes: Option<usize>,
}

impl SyncJournal {
	/// `genesis` is fixed for the journal's lifetime; the stored chain is checked entry by entry.
	pub fn open(path: &Path, genesis: &Json, o: JournalOptions) -> Result<SyncJournal> {
		let genesis = config_of(genesis)?;
		let (mi, mh) = (o.max_intent_bytes.unwrap_or(256.0 * 1024.0), o.max_history_bytes.unwrap_or(64.0 * 1024.0 * 1024.0));
		let bounded = |x: f64| x.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(&x);
		if !bounded(mi) || mi < 32768.0 || mi > 1048576.0 || !bounded(mh) || mh < mi || mh > 1073741824.0 { return blocked("invalid journal bounds"); }
		if let Some(dir) = path.parent() {
			use std::os::unix::fs::DirBuilderExt;
			let _ = std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir);
		}
		if std::fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) { return blocked("journal must not be a symlink"); }
		let db = sql(Connection::open(path))?;
		{
			use std::os::unix::fs::PermissionsExt;
			let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
		}
		sql(db.execute_batch("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sync_intents (revision INTEGER PRIMARY KEY, hash TEXT NOT NULL, intent TEXT NOT NULL)"))?;
		let mut j = SyncJournal { db, configs: vec![genesis.clone()], max_intent_bytes: mi as usize, max_history_bytes: mh as usize, self_id: o.self_id, format: None, used_bytes: None };
		j.transaction(|j| {
			match j.meta("config")? {
				Some(prior) if prior != canonical(&genesis) => blocked("stored replica configuration changed"),
				Some(_) => Ok(()),
				None => j.set_meta("config", &canonical(&genesis)),
			}
		})?;
		let any = sql(j.db.query_row("SELECT 1 FROM sync_intents LIMIT 1", [], |_| Ok(())).optional())?.is_some();
		let stored = j.meta("format")?.or_else(|| any.then(|| "pi-durable".to_string()));
		match stored.as_deref() {
			Some("pi-durable") => return blocked(PI_DURABLE_JOURNAL),
			Some(own::FORMAT) => j.format = Some(own::FORMAT.into()),
			Some(other) => return blocked(format!("unknown store kind {other}")),
			None => {}
		}
		if let Some(f) = o.format.as_deref() { j.bind_format(f)?; }
		let rows: Vec<(f64, String, String)> = {
			let mut st = sql(j.db.prepare("SELECT revision,hash,intent FROM sync_intents ORDER BY revision"))?;
			let it = sql(st.query_map([], |r| Ok((r.get::<_, i64>(0)? as f64, r.get(1)?, r.get(2)?))))?;
			sql(it.collect())?
		};
		let (mut previous, mut revision) = (ZERO.to_string(), 0.0);
		for (rev, h, text_) in rows {
			let i = parse(&text_).map_err(|e| SyncError::Blocked(e.to_string()))?;
			let current = j.configs.last().expect("the genesis").clone();
			j.validate(&i, &current)?;
			if rev != num(&i, "revision") || h != text(&i, "hash") { return blocked("journal index disagrees with immutable intent"); }
			revision += 1.0;
			if num(&i, "revision") != revision || text(&i, "previousHash") != previous { return blocked("journal history is not a complete prefix"); }
			previous = text(&i, "hash").to_string();
			j.configs.push(copy(i.get("config").expect("validated")));
		}
		if j.applied_revision()? as f64 > revision { return blocked("journal applied position exceeds history"); }
		Ok(j)
	}

	fn transaction<T>(&mut self, f: impl FnOnce(&mut SyncJournal) -> Result<T>) -> Result<T> {
		sql(self.db.execute_batch("BEGIN IMMEDIATE"))?;
		match f(self) {
			Ok(v) => { sql(self.db.execute_batch("COMMIT"))?; Ok(v) }
			Err(e) => { let _ = self.db.execute_batch("ROLLBACK"); Err(e) }
		}
	}
	fn meta(&self, key: &str) -> Result<Option<String>> { sql(self.db.query_row("SELECT value FROM sync_meta WHERE key=?", [key], |r| r.get(0)).optional()) }
	fn set_meta(&self, key: &str, value: &str) -> Result<()> {
		sql(self.db.execute("INSERT INTO sync_meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, value])).map(|_| ())
	}

	pub fn format(&self) -> Option<&str> { self.format.as_deref() }
	/// The codec checks an entry: bound, or tentative while an entry of an unbound journal is stored.
	fn codec(&self) -> Result<()> { if self.format.is_some() { Ok(()) } else { blocked("this journal is not bound to a store kind yet") } }
	/// Binds an empty journal to a store kind; a bound one refuses another.
	pub fn bind_format(&mut self, format: &str) -> Result<()> {
		if let Some(f) = &self.format { return if f != format { blocked(format!("this journal belongs to a {f} store, not {format}")) } else { Ok(()) }; }
		if format == "pi-durable" { return blocked(PI_DURABLE_JOURNAL); }
		if format != own::FORMAT { return blocked(format!("unknown store kind {format}")); }
		self.transaction(|j| j.set_meta("format", format))?;
		self.format = Some(format.into());
		Ok(())
	}

	/// The configuration after the newest entry, an unresolved candidate included.
	pub fn config(&self) -> Json { copy(self.configs.last().expect("the genesis")) }
	pub fn config_hash(&self) -> String { hash(self.configs.last().expect("the genesis")) }
	/// The configuration in force after `revision` (0: the genesis).
	pub fn config_at(&self, revision: usize) -> Result<Json> { self.configs.get(revision).map(copy).map_or_else(|| blocked("unknown journal revision"), Ok) }
	pub fn config_hash_at(&self, revision: usize) -> Result<String> { Ok(hash(&self.config_at(revision)?)) }
	pub fn applied_revision(&self) -> Result<u64> { Ok(self.meta("applied")?.map_or(0.0, |v| v.parse::<f64>().unwrap_or(f64::NAN)) as u64) }
	/// Bytes the sealed history takes.
	pub fn history_bytes(&mut self) -> Result<usize> {
		if let Some(n) = self.used_bytes { return Ok(n); }
		let n: i64 = sql(self.db.query_row("SELECT COALESCE(SUM(length(CAST(intent AS BLOB))),0) AS n FROM sync_intents", [], |r| r.get(0)))?;
		self.used_bytes = Some(n as usize);
		Ok(n as usize)
	}
	/// Revisions completed locally without a standby ACK under a verified fencing proof.
	pub fn recovered_committed(&self) -> Result<Json> { Ok(self.meta("recoveredCommitted")?.map_or(Json::Array(vec![]), |v| parse(&v).unwrap_or(Json::Array(vec![])))) }
	/// `{revision, hash, configHash}` of the newest entry.
	pub fn head(&self) -> Result<Json> {
		let row: Option<(i64, String)> = sql(self.db.query_row("SELECT revision,hash FROM sync_intents ORDER BY revision DESC LIMIT 1", [], |r| Ok((r.get(0)?, r.get(1)?))).optional())?;
		let (revision, h) = row.map_or((0.0, ZERO.to_string()), |(r, h)| (r as f64, h));
		Ok(obj! { "revision" => revision, "hash" => h, "configHash" => self.config_hash() })
	}
	pub fn head_revision(&self) -> Result<u64> { Ok(num(&self.head()?, "revision") as u64) }
	pub fn intent(&self, revision: f64) -> Result<Option<Json>> {
		if integer(Some(&Json::Number(revision))).is_none_or(|r| r < 1.0) { return blocked("invalid commit revision"); }
		let row: Option<String> = sql(self.db.query_row("SELECT intent FROM sync_intents WHERE revision=?", [revision as i64], |r| r.get(0)).optional())?;
		Ok(row.map(|t| parse(&t).expect("a stored intent parses")))
	}

	/// Checks an entry against the configuration in force before it.
	fn validate(&self, i: &Json, current: &Json) -> Result<()> {
		let keys1 = ["version", "config", "revision", "previousHash", "batchHash", "deltas", "validatedAt", "hash"];
		let keys2: Vec<&str> = keys1.iter().copied().chain(["previousConfigHash", "reason"]).collect();
		let keys3: Vec<&str> = keys1.iter().copied().chain(["bootstrap"]).collect();
		let version = i.get("version").and_then(Json::as_f64);
		let shaped = match version { Some(1.0) => keys_are(i, &keys1), Some(2.0) => keys_are(i, &keys2), Some(3.0) => keys_are(i, &keys3), _ => false };
		let deltas = i.get("deltas").and_then(Json::as_array);
		if !shaped || integer(i.get("revision")).is_none_or(|r| r < 1.0) || integer(i.get("validatedAt")).is_none() || deltas.is_none() { return blocked("invalid or oversized commit intent"); }
		let deltas = deltas.expect("checked");
		if canonical(i).len() > self.max_intent_bytes { return Err(SyncError::Full(format!("oversized commit intent (at most {} bytes)", self.max_intent_bytes))); }
		let config = i.get("config").unwrap_or(&Json::Null);
		match version {
			Some(1.0) => {
				if canonical(config) != canonical(current) || deltas.len() < 2 { return blocked("invalid or oversized commit intent"); }
			}
			Some(3.0) => {
				let b = i.get("bootstrap").unwrap_or(&Json::Null);
				let (index, total) = (integer(b.get("index")), integer(b.get("total")));
				let store_hash = b.get("storeHash").map(|v| match v { Json::String(s) => s.clone(), other => other.to_json_text() }).unwrap_or_default();
				let hex64 = store_hash.len() == 64 && store_hash.bytes().all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c));
				if canonical(config) != canonical(current) || b.as_object().is_none() || !keys_are(b, &["index", "total", "storeHash"]) || index.is_none() || total.is_none_or(|t| t < 1.0) || index >= total || num(i, "revision") != index.unwrap_or(f64::NAN) + 1.0 || !hex64 || deltas.is_empty() {
					return blocked("invalid bootstrap chunk");
				}
				self.codec()?;
				if deltas[..deltas.len() - 1].iter().any(|w| !own::bootstrap_write(w)) { return blocked("a bootstrap chunk only creates records"); }
			}
			_ => {
				let reason = i.get("reason").and_then(Json::as_str);
				if text(i, "previousConfigHash") != hash(current) || i.get("previousConfigHash").and_then(Json::as_str).is_none() || !reason.is_some_and(reason_like) || deltas.len() != 1 { return blocked("invalid replica configuration entry"); }
				validate_config_transition(current, config)?;
			}
		}
		let mut body = i.as_object().expect("shaped").clone();
		body.remove("hash");
		let batch = Json::Array(deltas[..deltas.len().saturating_sub(1)].to_vec());
		if i.get("hash").and_then(Json::as_str) != Some(&hash(&Json::Object(body))) || i.get("batchHash").and_then(Json::as_str) != Some(&hash(&batch)) { return blocked("commit intent hash changed"); }
		self.codec()?;
		let space_id = text(current, "spaceId");
		let Some((value, _)) = deltas.last().and_then(|w| own::marker_of(w, space_id)) else { return blocked("commit marker does not bind the batch") };
		if canonical(&value) != canonical(&marker_of(i)) { return blocked("commit marker does not bind the batch"); }
		if deltas[..deltas.len() - 1].iter().any(own::touches) { return blocked("business batch touches replication marker"); }
		Ok(())
	}

	fn insert(&mut self, i: &Json) -> Result<()> {
		let head = self.head()?;
		let head_revision = num(&head, "revision");
		let revision = integer(i.get("revision"));
		let current = match revision { Some(r) if r >= 1.0 && r - 1.0 <= head_revision => self.configs[(r - 1.0) as usize].clone(), _ => self.configs.last().expect("the genesis").clone() };
		self.validate(i, &current)?;
		let revision = revision.expect("validated");
		if let Some(old) = self.intent(revision)? {
			return if canonical(&old) != canonical(i) { blocked("immutable commit revision changed") } else { Ok(()) };
		}
		if revision != head_revision + 1.0 || text(i, "previousHash") != text(&head, "hash") { return blocked("commit history gap or fork"); }
		let before = if revision > 1.0 { self.intent(revision - 1.0)? } else { None };
		let v = |x: &Json| num(x, "version");
		let boot = |x: &Json, k: &str| x.get("bootstrap").and_then(|b| b.get(k)).cloned().unwrap_or(Json::Null);
		if v(i) == 3.0 && before.as_ref().is_some_and(|b| v(b) != 3.0 || boot(b, "total") != boot(i, "total") || boot(b, "storeHash") != boot(i, "storeHash")) { return blocked("bootstrap chunks must start the chain without gaps"); }
		if v(i) != 3.0 && before.as_ref().is_some_and(|b| v(b) == 3.0 && boot(b, "index").as_f64() != boot(b, "total").as_f64().map(|t| t - 1.0)) { return blocked("the bootstrap is not complete"); }
		let encoded = canonical(i);
		let used: i64 = sql(self.db.query_row("SELECT COALESCE(SUM(length(CAST(intent AS BLOB))),0) AS n FROM sync_intents", [], |r| r.get(0)))?;
		if used as usize + encoded.len() > self.max_history_bytes { return Err(SyncError::Full("sync history is full; no committed result was discarded".into())); }
		sql(self.db.execute("INSERT INTO sync_intents(revision,hash,intent) VALUES(?,?,?)", params![revision as i64, text(i, "hash"), encoded]))?;
		self.configs.push(copy(i.get("config").expect("validated")));
		self.used_bytes = None;
		Ok(())
	}

	fn seal_entry(&mut self, build: impl FnOnce(&SyncJournal, &Json) -> Result<Json>) -> Result<Json> {
		self.transaction(|j| {
			let head = j.head()?;
			if num(&head, "revision") as u64 != j.applied_revision()? { return blocked("a sealed candidate is already unresolved"); }
			let mut body = build(j, &head)?;
			let h = hash(&body);
			body.as_object_mut().expect("an intent is an object").insert("hash", Json::String(h));
			j.insert(&body)?;
			Ok(copy(&body))
		})
	}

	/// Seals a business batch (`deltas`: its rows, the marker write last). Waits while a replica transition is open.
	pub fn seal(&mut self, deltas: &[Json], validated_at: f64) -> Result<Json> {
		let deltas = deltas.to_vec();
		self.seal_entry(|j, head| {
			let open = j.open_transition_ids()?;
			let revision = num(head, "revision");
			let last = if revision > 0.0 { j.intent(revision)? } else { None };
			if let Some(l) = &last {
				if num(l, "version") == 3.0 && l.get("bootstrap").is_some_and(|b| num(b, "index") != num(b, "total") - 1.0) { return blocked("the store bootstrap is not complete; finish it before new work"); }
			}
			if let Some(first) = open.first() { return blocked(format!("replica transition {first} in progress; writes are paused")); }
			let batch = Json::Array(deltas[..deltas.len().saturating_sub(1)].to_vec());
			Ok(obj! { "version" => 1.0, "config" => j.config(), "revision" => revision + 1.0, "previousHash" => text(head, "hash"), "batchHash" => hash(&batch), "deltas" => copy(&Json::Array(deltas)), "validatedAt" => validated_at })
		})
	}

	/// Seals all bootstrap chunks in one transaction; each chunk gets its marker write.
	pub fn seal_bootstrap(&mut self, chunks: &[Vec<Json>], store_hash: &str, validated_at: f64) -> Result<Vec<Json>> {
		let chunks = chunks.to_vec();
		let store_hash = store_hash.to_string();
		self.transaction(|j| {
			if j.head_revision()? != 0 { return blocked("a bootstrap starts an empty journal"); }
			let mut out = vec![];
			let total = chunks.len() as f64;
			for (index, writes) in chunks.iter().enumerate() {
				let head = j.head()?;
				let mut body = obj! { "version" => 3.0, "config" => j.config(), "bootstrap" => obj! { "index" => index as f64, "total" => total, "storeHash" => store_hash.as_str() }, "revision" => num(&head, "revision") + 1.0, "previousHash" => text(&head, "hash"), "batchHash" => hash(&Json::Array(writes.clone())), "validatedAt" => validated_at };
				let mark = own::marker_write(text(&j.config(), "spaceId"), &marker_of(&body));
				let mut deltas = copy(&Json::Array(writes.clone())).as_array().expect("an array").clone();
				deltas.push(mark);
				body.as_object_mut().expect("an object").insert("deltas", Json::Array(deltas));
				let h = hash(&body);
				body.as_object_mut().expect("an object").insert("hash", Json::String(h));
				j.insert(&body)?;
				out.push(copy(&body));
			}
			Ok(out)
		})
	}

	/// Seals a configuration change; `mark` is the marker write for the new configuration's hash.
	pub fn seal_transition(&mut self, next: &Json, reason: &str, mark: &Json, validated_at: f64) -> Result<Json> {
		let next = config_of(next)?;
		let (reason, mark) = (reason.to_string(), mark.clone());
		self.seal_entry(|j, head| Ok(obj! { "version" => 2.0, "config" => next, "previousConfigHash" => j.config_hash(), "reason" => reason, "revision" => num(head, "revision") + 1.0, "previousHash" => text(head, "hash"), "batchHash" => hash(&Json::Array(vec![])), "deltas" => Json::Array(vec![copy(&mark)]), "validatedAt" => validated_at }))
	}

	/// The store kind of an entry: the bound one, or the one whose codec recognises its marker write.
	fn codec_for(&self, i: &Json) -> Result<String> {
		if let Some(f) = &self.format { return Ok(f.clone()); }
		let last = i.get("deltas").and_then(Json::as_array).and_then(|d| d.last());
		let space_id = i.get("config").and_then(|c| c.get("spaceId")).and_then(Json::as_str);
		match (last, space_id) { (Some(w), Some(s)) if own::marker_of(w, s).is_some() => Ok(own::FORMAT.into()), _ => blocked("commit marker does not bind the batch") }
	}
	fn store(&mut self, i: &Json, format: &str) -> Result<()> {
		let unbound = self.format.is_none();
		let format_ = format.to_string();
		let saved = self.format.clone();
		self.format = Some(format_.clone()); // the tentative codec checks the entry
		let r = self.transaction(|j| { j.insert(i)?; if unbound { j.set_meta("format", &format_)?; } Ok(()) });
		if r.is_err() { self.format = saved; }
		r
	}
	fn ack(i: &Json) -> Json { obj! { "revision" => num(i, "revision"), "hash" => text(i, "hash"), "configHash" => hash(i.get("config").unwrap_or(&Json::Null)) } }
	/// Accepts an entry as the standby; `assert_standby` checks the permit for the configuration it leads to.
	pub fn accept(&mut self, input: &Json, assert_standby: impl FnOnce(&Json, f64) -> Result<()>) -> Result<Json> {
		let i = copy(input);
		let format = self.codec_for(&i)?;
		let config = i.get("config").cloned().unwrap_or(Json::Null);
		if let Some(me) = &self.self_id {
			if config.get("standbyReplica").and_then(Json::as_str) != Some(me.as_str()) { return blocked("this replica is not the standby of the entry"); }
		}
		assert_standby(&copy(&config), num(&i, "version"))?;
		self.store(&i, &format)?;
		Ok(SyncJournal::ack(&i))
	}
	/// Catch-up of a quarantined replica before setStandby: the history in order, while `assert_quarantine` confirms it.
	pub fn catch_up(&mut self, input: &Json, assert_quarantine: impl FnOnce() -> Result<()>) -> Result<Json> {
		let i = copy(input);
		assert_quarantine()?;
		let format = self.codec_for(&i)?;
		self.store(&i, &format)?;
		Ok(SyncJournal::ack(&i))
	}

	/// Transitions in phase started or locallyCommitted; while any exists, business writes are paused.
	pub fn open_transition_ids(&self) -> Result<Vec<String>> {
		let mut st = sql(self.db.prepare("SELECT key,value FROM sync_meta WHERE key LIKE 'transition:%'"))?;
		let rows: Vec<(String, String)> = sql(sql(st.query_map([], |r| Ok((r.get(0)?, r.get(1)?))))?.collect())?;
		Ok(rows.into_iter().filter(|(_, v)| parse(v).ok().and_then(|r| r.get("phase").and_then(Json::as_str).map(|p| p == "started" || p == "locallyCommitted")).unwrap_or(false)).map(|(k, _)| k["transition:".len()..].to_string()).collect())
	}
	/// Starts or resumes a transition atomically: at most one open per journal; the stored record.
	pub fn begin_transition(&mut self, id: &str, record: &Json) -> Result<Json> {
		if !reason_like(id) { return blocked("invalid transition ID"); }
		let record = record.clone();
		self.transaction(|j| {
			if let Some(old) = j.meta(&format!("transition:{id}"))? { return Ok(parse(&old).expect("a stored record parses")); }
			if let Some(first) = j.open_transition_ids()?.first() { return blocked(format!("replica transition {first} is still open; resume or abandon it first")); }
			j.set_meta(&format!("transition:{id}"), &canonical(&record))?;
			Ok(record)
		})
	}
	/// Ends a started transition that sealed nothing.
	pub fn abandon_transition(&mut self, id: &str) -> Result<()> {
		self.transaction(|j| {
			let rec = j.meta(&format!("transition:{id}"))?.and_then(|v| parse(&v).ok());
			let Some(rec) = rec.filter(|r| r.get("phase").and_then(Json::as_str) == Some("started")) else { return blocked("only a started transition can be abandoned") };
			for r in 1..=j.head_revision()? {
				let i = j.intent(r as f64)?.expect("a complete chain");
				if num(&i, "version") == 2.0 && text(&i, "reason") == id { return blocked("the transition already sealed a configuration entry; resume it"); }
			}
			let mut next = rec.as_object().expect("a record").clone();
			next.insert("phase", Json::String("abandoned".into()));
			j.set_meta(&format!("transition:{id}"), &canonical(&Json::Object(next)))
		})
	}
	pub fn transition(&self, id: &str) -> Result<Option<Json>> { Ok(self.meta(&format!("transition:{id}"))?.and_then(|v| parse(&v).ok())) }
	pub fn save_transition(&mut self, id: &str, value: &Json) -> Result<()> {
		if !reason_like(id) { return blocked("invalid transition ID"); }
		let value = canonical(value);
		self.transaction(|j| j.set_meta(&format!("transition:{id}"), &value))
	}
	pub fn mark_applied(&mut self, i: &Json, recovered: bool) -> Result<()> {
		let i = i.clone();
		self.transaction(|j| {
			let revision = num(&i, "revision");
			let stored = j.intent(revision)?;
			if stored.as_ref().is_none_or(|s| text(s, "hash") != text(&i, "hash")) { return blocked("cannot apply an unknown intent"); }
			let applied = j.applied_revision()? as f64;
			if applied == revision { return Ok(()); }
			if applied != revision - 1.0 { return blocked("applied history gap"); }
			j.set_meta("applied", &phi_json::number_text(revision))?;
			if recovered {
				let mut list = j.recovered_committed()?.as_array().cloned().unwrap_or_default();
				list.push(Json::Number(revision));
				j.set_meta("recoveredCommitted", &canonical(&Json::Array(list)))?;
			}
			Ok(())
		})
	}
}
