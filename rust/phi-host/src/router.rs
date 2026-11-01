//! Durable command orchestration (src/router.ts). A command is journalled before any effect, each step keeps its request id, and a
//! lost reply is resolved under that id, never sent as new work: transport errors do not prove failure. Everything lives in two
//! document families of the control store, written by TypeScript and Rust alike, so either can take over the other's journal.
//!
//! One controller owns a journal; `&mut self` is what `serial` is there. `reconcileDataRestore` belongs to recovery (R6b).
use phi_core::space::{bytes, error, CoreError};
use phi_json::{digest_json, num_of, obj, safe_integer, text, Json, Object};
use phi_wire::Local;

type R<T> = Result<T, CoreError>;

pub const JOURNAL: &str = "phi-spaces.router-journal";
pub const COMMANDS: &str = "phi-spaces.router-command";
const OPERATIONS: [&str; 8] = ["write", "read", "take", "txn", "lease", "wait", "notify", "cancelOperation"];
const OUTCOMES: [&str; 6] = ["done", "pending", "failed", "cancelled", "notAdmitted", "needsReview"];
const MAX_EVIDENCE: usize = 512;

fn blocked(m: impl Into<String>) -> CoreError { error("RouterBlocked", m) }
fn conflict(m: impl Into<String>) -> CoreError { error("RouterConflict", m) }
fn budget(m: impl Into<String>) -> CoreError { error("RouterBudgetExceeded", m) }
fn type_error(m: impl Into<String>) -> CoreError { error("TypeError", m) }
fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| type_error("a value that cannot be hashed")) }

fn arg_hash(method: &str, args: &Json) -> R<String> { hash(&obj! { "method" => method, "args" => args.clone() }) }

fn ident(id: &str) -> R<()> {
	let mut c = id.chars();
	let fine = c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && id.len() <= 128 && c.all(|x| x.is_ascii_alphanumeric() || "._:-".contains(x));
	if fine && !["constructor", "prototype", "__proto__"].contains(&id) { Ok(()) } else { Err(type_error("invalid router identifier")) }
}
fn bounded_evidence(t: &str) -> String {
	let mut end = 0;
	for (i, c) in t.char_indices() {
		if i + c.len_utf8() > MAX_EVIDENCE {
			break;
		}
		end = i + c.len_utf8();
	}
	t[..end].to_owned()
}
fn terminal(state: Option<&str>) -> bool { matches!(state, Some("completed" | "failed" | "needsReview")) }
fn command_key(router: &str, id: &str) -> R<String> { hash(&Json::Array(vec![router.into(), id.into()])) }
fn set(v: &mut Json, k: &str, x: impl Into<Json>) {
	if let Json::Object(o) = v {
		o.insert(k, x.into());
	}
}
fn steps(c: &Json) -> &[Json] { c.get("steps").and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn step_mut(c: &mut Json, n: usize) -> &mut Json { &mut c.as_object_mut().and_then(|o| o.get_mut("steps")).and_then(Json::as_array_mut).expect("a command has steps")[n] }
fn step_state(c: &Json, n: usize) -> Option<&str> { steps(c).get(n).and_then(|s| text(s, "state")) }
fn first_open(c: &Json) -> Option<usize> { steps(c).iter().position(|s| text(s, "state") != Some("done")) }
fn refused_before_admission(s: &Json) -> bool { matches!(text(s, "evidence"), Some("ReplicaConfigPending" | "StalePolicyVersion")) }

/// `specOf`: what the hash of a command binds.
fn spec_of(c: &Json) -> Json {
	let picked: Vec<Json> = steps(c).iter().map(|s| {
		let mut o = Object::new();
		for k in ["target", "principal", "generation", "method", "args", "resultBudgetBytes", "policyVersion", "targetRequest", "generationAdmitUntil"] {
			if let Some(v) = s.get(k) {
				o.insert(k, v.clone());
			}
		}
		Json::Object(o)
	}).collect();
	obj! { "id" => c.get("id").cloned().unwrap_or(Json::Null), "area" => c.get("area").cloned().unwrap_or(Json::Null), "blocksArea" => c.get("blocksArea").cloned().unwrap_or(Json::Null), "steps" => picked }
}

fn slots(index: &Json) -> f64 { index.get("future").and_then(Json::as_object).map_or(0.0, |f| f.iter().map(|(_, r)| num_of(r, "slots").unwrap_or(0.0)).sum()) }
fn refs(index: &Json) -> &Object { static EMPTY: std::sync::OnceLock<Object> = std::sync::OnceLock::new(); index.get("refs").and_then(Json::as_object).unwrap_or_else(|| EMPTY.get_or_init(Object::new)) }
fn refs_mut(index: &mut Json) -> &mut Object { index.as_object_mut().and_then(|o| o.get_mut("refs")).and_then(Json::as_object_mut).expect("an index has refs") }
fn add_reserved(index: &mut Json, by: f64) { let now = num_of(index, "reservedBytes").unwrap_or(0.0); set(index, "reservedBytes", now + by); }

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limits {
	pub max_commands: f64,
	pub max_steps: f64,
	pub max_command_bytes: f64,
	pub max_index_bytes: f64,
	pub max_commit_bytes: f64,
	pub max_journal_bytes: f64,
	pub default_result_bytes: f64,
}
pub const DEFAULT_LIMITS: Limits = Limits { max_commands: 128.0, max_steps: 16.0, max_command_bytes: 131_072.0, max_index_bytes: 32_768.0, max_commit_bytes: 196_608.0, max_journal_bytes: 4_194_304.0, default_result_bytes: 16_384.0 };
impl Limits {
	fn to_json(self) -> Json {
		obj! { "maxCommands" => self.max_commands, "maxSteps" => self.max_steps, "maxCommandBytes" => self.max_command_bytes, "maxIndexBytes" => self.max_index_bytes, "maxCommitBytes" => self.max_commit_bytes, "maxJournalBytes" => self.max_journal_bytes, "defaultResultBytes" => self.default_result_bytes }
	}
}

/// What a step refused before admission gets (`reprepare`).
pub enum Reprepared {
	Spec(Json),
	Wait,
	Refuse,
}

/// The store, the authority and the Members around one journal.
pub trait RouterEnv {
	/// A document as committed, this journal's own writes included.
	fn read(&self, kind: &str, key: &str) -> R<Option<Json>>;
	/// Writes `(kind, key, value)` as one commit.
	fn commit(&self, writes: Vec<(String, String, Json)>) -> R<()>;
	/// `commit`, and the Space's counters take this policy version in the same commit.
	fn commit_policy(&self, writes: Vec<(String, String, Json)>, _version: f64) -> R<()> { self.commit(writes) }
	fn assert_authority(&self) -> Local<R<()>>;
	/// A receipt, or `Err` when the transport says nothing about the outcome.
	fn invoke(&self, step: Json) -> Local<Result<Json, ()>>;
	fn resolve(&self, step: Json) -> Local<Result<Json, ()>>;
	fn reprepare(&self, _step: Json) -> Local<Result<Reprepared, ()>> { Box::pin(async { Ok(Reprepared::Refuse) }) }
	fn checkpoint(&self, _point: &'static str, _command: &Json) -> Local<R<()>> { Box::pin(async { Ok(()) }) }
	fn now(&self) -> f64;
}

/// One commit: the documents it read, as they will be written.
pub struct Tx<'a> {
	env: &'a dyn RouterEnv,
	docs: Vec<(String, String, Json, Option<Json>)>,
	/// The policy version this commit installs.
	pub policy_version: Option<f64>,
}
impl<'a> Tx<'a> {
	pub fn new(env: &'a dyn RouterEnv) -> Self { Tx { env, docs: vec![], policy_version: None } }
	/// The place of a document in this commit, read the first time.
	pub fn doc(&mut self, kind: &str, key: &str, initial: fn() -> Json) -> R<usize> {
		if let Some(at) = self.docs.iter().position(|(k, x, _, _)| k == kind && x == key) {
			return Ok(at);
		}
		let was = self.env.read(kind, key)?;
		self.docs.push((kind.to_owned(), key.to_owned(), was.clone().unwrap_or_else(initial), was));
		Ok(self.docs.len() - 1)
	}
	pub fn at(&mut self, at: usize) -> &mut Json { &mut self.docs[at].2 }
	/// Writes what changed, as one commit.
	pub fn commit(self) -> R<()> {
		let writes: Vec<_> = self.docs.into_iter().filter(|(_, _, value, was)| was.as_ref() != Some(value)).map(|(kind, key, value, _)| (kind, key, value)).collect();
		match self.policy_version {
			Some(v) => self.env.commit_policy(writes, v),
			None if writes.is_empty() => Ok(()),
			None => self.env.commit(writes),
		}
	}
}
/// A hook inside the commit that admits or completes a command: the command, the commit, the journal index and the bytes left.
pub type CommitHook<'h, 'd> = &'h mut (dyn FnMut(&Json, &mut Tx<'_>, &mut Json, f64) -> R<()> + 'd);
/// `context.releaseFuture`: inside a commit hook.
pub fn release_future_in(i: &mut Json, id: &str) -> R<()> {
	ident(id)?;
	let held = i.as_object_mut().and_then(|o| o.get_mut("future")).and_then(Json::as_object_mut).and_then(|f| f.remove(id));
	if let Some(r) = held {
		add_reserved(i, -(num_of(&r, "slots").unwrap_or(0.0) * num_of(&r, "bytesPerSlot").unwrap_or(0.0)));
	}
	Ok(())
}
fn empty_index() -> Json { obj! { "authorityId" => Json::Null, "mode" => "recovering", "limits" => Json::Null, "refs" => Object::new(), "reservedBytes" => 0.0 } }
fn empty_command() -> Json { obj! { "command" => Json::Null } }

pub struct RouterController<E: RouterEnv> {
	env: E,
	router_id: String,
	authority_id: String,
	limits: Limits,
	ready: bool,
}

impl<E: RouterEnv> RouterController<E> {
	pub fn new(env: E, router_id: &str, authority_id: &str, limits: Limits) -> R<Self> {
		ident(router_id)?;
		ident(authority_id)?;
		let all = [limits.max_commands, limits.max_steps, limits.max_command_bytes, limits.max_index_bytes, limits.max_commit_bytes, limits.max_journal_bytes, limits.default_result_bytes];
		if all.iter().any(|v| !safe_integer(*v) || *v <= 0.0) {
			return Err(type_error("invalid router budget"));
		}
		Ok(RouterController { env, router_id: router_id.to_owned(), authority_id: authority_id.to_owned(), limits, ready: false })
	}
	pub fn journal_id(&self) -> &str { &self.router_id }
	fn key(&self, id: &str) -> R<String> { command_key(&self.router_id, id) }
	fn must_be_ready(&self) -> R<()> { if self.ready { Ok(()) } else { Err(blocked("router is recovering")) } }

	/// `change`: one commit over the index and what `f` asks for; the authority is asked before and at its end.
	async fn change<T>(&mut self, f: impl FnOnce(&mut Json, &mut Tx<'_>) -> R<T>) -> R<T> {
		self.env.assert_authority().await?;
		let result = self.change_inner(f).await;
		if let Err(e) = &result {
			if e.class != "RouterConflict" && e.class != "RouterBudgetExceeded" {
				self.ready = false;
			}
		}
		result
	}
	async fn change_inner<T>(&mut self, f: impl FnOnce(&mut Json, &mut Tx<'_>) -> R<T>) -> R<T> {
		let limits = self.limits.to_json();
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(JOURNAL, &self.router_id, empty_index)?;
		let mut index = std::mem::replace(tx.at(at), Json::Null);
		if text(&index, "authorityId").is_some_and(|a| a != self.authority_id) {
			return Err(blocked("journal authority changed; explicit restore reconciliation required"));
		}
		set(&mut index, "authorityId", self.authority_id.as_str());
		if index.get("limits").is_some_and(|l| !l.is_null()) && hash(index.get("limits").unwrap_or(&Json::Null))? != hash(&limits)? {
			return Err(blocked("persisted budget configuration differs"));
		}
		set(&mut index, "limits", limits);
		let result = f(&mut index, &mut tx)?;
		if bytes(&index) > self.limits.max_index_bytes {
			return Err(budget("router index exceeds budget"));
		}
		*tx.at(at) = index;
		self.env.assert_authority().await?;
		tx.commit()?;
		Ok(result)
	}

	fn command_now(&self, id: &str) -> R<Option<Json>> {
		let doc = self.env.read(COMMANDS, &self.key(id)?)?;
		Ok(doc.and_then(|d| d.get("command").filter(|c| !c.is_null()).cloned()))
	}
	/// `get`.
	pub async fn get(&self, id: &str) -> R<Option<Json>> {
		ident(id)?;
		self.env.assert_authority().await?;
		self.command_now(id)
	}
	/// The journal index as committed.
	pub fn index(&self) -> R<Option<Json>> { self.env.read(JOURNAL, &self.router_id) }

	fn normalize(&self, spec: &Json) -> R<Json> {
		let (id, area) = (text(spec, "id").unwrap_or(""), text(spec, "area").unwrap_or(""));
		ident(id)?;
		ident(area)?;
		let given = spec.get("steps").and_then(Json::as_array).filter(|s| !s.is_empty() && s.len() as f64 <= self.limits.max_steps).ok_or_else(|| type_error("invalid command steps"))?;
		let mut out = vec![];
		let null = Json::Null;
		for (n, x) in given.iter().enumerate() {
			let (target, principal) = (x.get("target").unwrap_or(&null), x.get("principal").unwrap_or(&null));
			let bound = [text(target, "hostId"), text(target, "spaceId"), text(target, "authorityId"), text(target, "dataIncarnation"), text(principal, "peerId"), text(x, "generation")];
			if bound.iter().any(|k| k.is_none_or(|k| k.is_empty() || k.encode_utf16().count() > 256)) {
				return Err(type_error("incomplete target/request binding"));
			}
			if principal.get("agentId").is_some() && text(principal, "agentId").is_none_or(|a| a.is_empty() || a.encode_utf16().count() > 128) {
				return Err(type_error("invalid agent binding"));
			}
			let epoch = num_of(target, "primaryEpoch").unwrap_or(f64::NAN);
			if !safe_integer(epoch) || epoch < 1.0 || text(target, "authorityId") != Some(&self.authority_id) {
				return Err(blocked("target authority/epoch mismatch"));
			}
			let method = text(x, "method").unwrap_or("");
			if !OPERATIONS.contains(&method) {
				return Err(type_error("non-idempotent command operation"));
			}
			if x.get("generationAdmitUntil").is_some_and(|u| !u.as_f64().is_some_and(|u| safe_integer(u) && u >= 0.0)) {
				return Err(type_error("invalid generation admission deadline"));
			}
			let args = x.get("args").ok_or_else(|| type_error("a value that cannot be hashed"))?;
			args.canonical().map_err(|_| type_error("a value that cannot be hashed"))?;
			let result = match x.get("resultBudgetBytes") {
				None => self.limits.default_result_bytes,
				Some(v) => v.as_f64().unwrap_or(f64::NAN),
			};
			if !safe_integer(result) || result < 64.0 {
				return Err(type_error("invalid result reservation"));
			}
			let mut s = x.json_copy();
			set(&mut s, "resultBudgetBytes", result);
			set(&mut s, "requestId", format!("router-{}", hash(&Json::Array(vec![self.router_id.as_str().into(), id.into(), Json::Number(n as f64)]))?));
			set(&mut s, "argHash", arg_hash(method, args)?);
			set(&mut s, "state", "prepared");
			out.push(s);
		}
		let room: f64 = out.iter().map(|s| num_of(s, "resultBudgetBytes").unwrap_or(0.0) + 512.0).sum();
		let blocks = spec.get("blocksArea").is_some_and(|b| phi_core::space::truthy(Some(b)));
		let mut c = obj! { "id" => id, "area" => area, "blocksArea" => blocks, "hash" => "", "state" => "accepted", "steps" => out, "reservedBytes" => 0.0, "reviews" => Vec::<Json>::new() };
		let bound = hash(&spec_of(&c))?;
		set(&mut c, "hash", bound);
		let reserved = bytes(&c) + room + 8192.0;
		set(&mut c, "reservedBytes", reserved);
		if reserved > self.limits.max_command_bytes || reserved + self.limits.max_index_bytes + 4096.0 > self.limits.max_commit_bytes {
			return Err(budget("command cannot reserve bounded results and commit overhead"));
		}
		Ok(c)
	}

	fn reserve_future_value(limits: &Limits, i: &mut Json, id: &str, slots_wanted: f64, per_slot: f64) -> R<()> {
		ident(id)?;
		if !safe_integer(slots_wanted) || slots_wanted < 1.0 || !safe_integer(per_slot) || per_slot < 1024.0 || per_slot > limits.max_command_bytes {
			return Err(budget("invalid future reservation"));
		}
		if i.get("future").is_none() {
			set(i, "future", Object::new());
		}
		if i.get("future").and_then(|f| f.get(id)).is_some() {
			return Ok(());
		}
		let reserved = num_of(i, "reservedBytes").unwrap_or(0.0);
		if refs(i).len() as f64 + slots(i) + slots_wanted > limits.max_commands || reserved + slots_wanted * per_slot + limits.max_index_bytes > limits.max_journal_bytes {
			return Err(budget("future child budget unavailable"));
		}
		if let Some(Json::Object(f)) = i.as_object_mut().and_then(|o| o.get_mut("future")) {
			f.insert(id, obj! { "slots" => slots_wanted, "bytesPerSlot" => per_slot });
		}
		add_reserved(i, slots_wanted * per_slot);
		if bytes(i) > limits.max_index_bytes {
			return Err(budget("router index exceeds budget"));
		}
		Ok(())
	}
	/// `reserveFuture`: room for child effects before a composite operation is admitted. Ids are never recycled.
	pub async fn reserve_future(&mut self, id: &str, count: f64, per_slot: Option<f64>) -> R<()> {
		self.must_be_ready()?;
		let (limits, per_slot) = (self.limits, per_slot.unwrap_or(self.limits.max_command_bytes));
		self.change(|i, _| Self::reserve_future_value(&limits, i, id, count, per_slot)).await
	}
	/// `reserveFutureIn`: inside a commit of the caller, who asks the authority around it.
	pub fn reserve_future_in(&self, tx: &mut Tx<'_>, id: &str, count: f64, per_slot: f64) -> R<()> {
		self.must_be_ready()?;
		let at = tx.doc(JOURNAL, &self.router_id, empty_index)?;
		let i = tx.at(at);
		if text(i, "mode") != Some("ready") || text(i, "authorityId") != Some(&self.authority_id) || hash(i.get("limits").unwrap_or(&Json::Null))? != hash(&self.limits.to_json())? {
			return Err(blocked("reservation owner or budget changed"));
		}
		Self::reserve_future_value(&self.limits, i, id, count, per_slot)
	}
	/// `releaseFuture`: gives back what was reserved and not used.
	pub async fn release_future(&mut self, id: &str) -> R<()> {
		ident(id)?;
		self.env.assert_authority().await?;
		let current = self.index()?;
		if current.as_ref().and_then(|i| text(i, "authorityId")) != Some(&self.authority_id) {
			return Err(blocked("reservation owner changed"));
		}
		if current.as_ref().and_then(|i| i.get("future")?.get(id)).is_none() {
			return Ok(());
		}
		self.change(|i, _| release_future_in(i, id)).await
	}
	/// `submit`: a command in the journal, or the one already there under this id.
	pub async fn submit(&mut self, spec: &Json, future_id: Option<&str>, admitted: Option<CommitHook<'_, '_>>) -> R<Json> {
		let c = self.normalize(spec)?;
		self.must_be_ready()?;
		let (key, limits) = (self.key(text(&c, "id").unwrap_or(""))?, self.limits);
		self.change(|i, tx| {
			let at = tx.doc(COMMANDS, &key, empty_command)?;
			if let Some(old) = tx.at(at).get("command").filter(|o| !o.is_null()) {
				if old.get("hash") != c.get("hash") {
					return Err(conflict("command ID already binds different arguments"));
				}
				if old.get("erased").is_some() {
					return Err(error("ResultExpired", "Child command content was erased"));
				}
				return Ok(old.clone());
			}
			let area = c.get("area");
			if refs(i).iter().any(|(_, r)| r.get("area") == area && r.get("blocksArea") == Some(&Json::Bool(true)) && r.get("released") != Some(&Json::Bool(true)) && !matches!(text(r, "state"), Some("completed" | "failed"))) {
				return Err(blocked("routing area has unresolved policy/membership work"));
			}
			let reserved = num_of(&c, "reservedBytes").unwrap_or(0.0);
			if let Some(id) = future_id {
				let held = i.get("future").and_then(|f| f.get(id)).cloned();
				let Some(r) = held.filter(|r| num_of(r, "slots").unwrap_or(0.0) >= 1.0 && reserved <= num_of(r, "bytesPerSlot").unwrap_or(0.0)) else {
					return Err(budget("missing or insufficient child reservation"));
				};
				if let Some(Json::Object(f)) = i.as_object_mut().and_then(|o| o.get_mut("future")) {
					f.insert(id, obj! { "slots" => num_of(&r, "slots").unwrap_or(0.0) - 1.0, "bytesPerSlot" => r.get("bytesPerSlot").cloned().unwrap_or(Json::Null) });
				}
				add_reserved(i, -num_of(&r, "bytesPerSlot").unwrap_or(0.0));
			}
			if refs(i).len() as f64 + slots(i) >= limits.max_commands || num_of(i, "reservedBytes").unwrap_or(0.0) + reserved + limits.max_index_bytes > limits.max_journal_bytes {
				return Err(budget("journal full; historical IDs must not be evicted for reuse"));
			}
			set(tx.at(at), "command", c.clone());
			let id = text(&c, "id").unwrap_or("");
			refs_mut(i).insert(id, obj! { "hash" => c.get("hash").cloned().unwrap_or(Json::Null), "state" => c.get("state").cloned().unwrap_or(Json::Null), "area" => area.cloned().unwrap_or(Json::Null), "blocksArea" => c.get("blocksArea").cloned().unwrap_or(Json::Null), "released" => false, "reservedBytes" => reserved });
			add_reserved(i, reserved);
			if let Some(hook) = admitted {
				let room = limits.max_commit_bytes - bytes(i) - bytes(&c) - 8192.0;
				hook(&c, tx, i, room)?;
			}
			Ok(c.clone())
		}).await
	}

	/// `update`: a change of a command, within what it reserved.
	async fn update(&mut self, id: &str, f: impl FnOnce(&mut Json, &mut Tx<'_>, &mut Json) -> R<()>) -> R<Json> {
		let key = self.key(id)?;
		self.change(|i, tx| {
			let at = tx.doc(COMMANDS, &key, empty_command)?;
			let doc = tx.at(at).get("command").filter(|c| !c.is_null()).filter(|_| refs(i).contains_key(id)).cloned();
			let Some(mut c) = doc else { return Err(blocked("missing command history")) };
			f(&mut c, tx, i)?;
			if bytes(&c) > num_of(&c, "reservedBytes").unwrap_or(0.0) {
				return Err(budget("reserved command bytes exceeded"));
			}
			let (state, out) = (c.get("state").cloned().unwrap_or(Json::Null), c.clone());
			set(tx.at(at), "command", c);
			if let Some(r) = refs_mut(i).get_mut(id) {
				set(r, "state", state);
			}
			Ok(out)
		}).await
	}

	fn verify(&self, c: &Json) -> R<()> {
		if let Some(e) = c.get("erased") {
			if c.get("hash") != e.get("originalHash") || text(c, "state") != Some("completed") || !steps(c).is_empty() || !c.get("reviews").and_then(Json::as_array).is_some_and(Vec::is_empty) {
				return Err(blocked("invalid erased Child tombstone"));
			}
			return Ok(());
		}
		if text(c, "hash") != Some(&hash(&spec_of(c))?) {
			return Err(blocked("command binding hash corrupted"));
		}
		for (n, s) in steps(c).iter().enumerate() {
			let args = arg_hash(text(s, "method").unwrap_or(""), s.get("args").unwrap_or(&Json::Null)).map_err(|_| blocked("subrequest binding corrupted"))?;
			let request = format!("router-{}", hash(&Json::Array(vec![self.router_id.as_str().into(), c.get("id").cloned().unwrap_or(Json::Null), Json::Number(n as f64)]))?);
			if text(s, "argHash") != Some(&args) || text(s, "requestId") != Some(&request) {
				return Err(blocked("subrequest binding corrupted"));
			}
		}
		Ok(())
	}

	async fn apply_receipt(&mut self, id: &str, n: usize, r: Json, completed: Option<CommitHook<'_, '_>>) -> R<Json> {
		let limits = self.limits;
		self.update(id, |c, tx, i| {
			let review = |c: &mut Json, why: String| {
				let s = step_mut(c, n);
				set(s, "state", "needsReview");
				set(s, "evidence", why);
				set(c, "state", "needsReview");
			};
			let s = steps(c)[n].clone();
			let same = |k: &str| -> R<bool> { Ok(hash(r.get(k).unwrap_or(&Json::Null))? == hash(s.get(k).unwrap_or(&Json::Null))?) };
			if !same("target")? || !same("principal")? || ["method", "generation", "requestId", "argHash"].iter().any(|k| r.get(k) != s.get(k)) {
				review(c, "receipt binding mismatch".into());
				return Ok(());
			}
			let outcome = text(&r, "outcome").unwrap_or("");
			if !OUTCOMES.contains(&outcome) {
				review(c, "invalid claim outcome".into());
				return Ok(());
			}
			let null = Json::Null;
			if bytes(r.get("result").unwrap_or(&null)) > num_of(&s, "resultBudgetBytes").unwrap_or(0.0) {
				review(c, format!("result exceeds reservation; receipt hash {}", hash(&r)?));
				return Ok(());
			}
			let evidence = bounded_evidence(r.get("evidence").filter(|e| !e.is_null()).and_then(Json::as_str).unwrap_or(outcome));
			let step = step_mut(c, n);
			set(step, "evidence", evidence);
			match outcome {
				"done" => {
					set(step, "state", "done");
					set(step, "result", r.get("result").cloned().unwrap_or(Json::Null));
				}
				"failed" | "cancelled" => {
					set(step, "state", "failed");
					set(c, "state", "failed");
				}
				"needsReview" => {
					set(step, "state", "needsReview");
					set(c, "state", "needsReview");
				}
				"notAdmitted" => set(step, "state", "prepared"),
				_ => set(step, "state", "pending"),
			}
			if steps(c).iter().all(|x| text(x, "state") == Some("done")) {
				set(c, "state", "completed");
			}
			if let (Some(hook), Some("completed")) = (completed, text(c, "state")) {
				let room = limits.max_commit_bytes - bytes(i) - bytes(c) - 8192.0;
				hook(c, tx, i, room)?;
			}
			Ok(())
		}).await
	}

	async fn resolve(&mut self, c: &Json, n: usize, completed: Option<CommitHook<'_, '_>>) -> R<Json> {
		self.env.assert_authority().await?;
		let id = text(c, "id").unwrap_or("").to_owned();
		match self.env.resolve(steps(c)[n].clone()).await {
			Ok(receipt) => self.apply_receipt(&id, n, receipt, completed).await,
			Err(()) => self.update(&id, |d, _, _| {
				let s = step_mut(d, n);
				set(s, "state", "unknown");
				set(s, "evidence", "resolution transport unavailable");
				Ok(())
			}).await,
		}
	}

	/// `recover`: rebuilds and checks the journal, and resolves what was in flight, before new work is taken.
	pub async fn recover(&mut self) -> R<()> {
		self.ready = false;
		let held = self.change(|i, _| {
			set(i, "mode", "recovering");
			Ok(refs(i).clone())
		}).await?;
		let mut sum = 0.0;
		for (id, r) in held.iter() {
			let found = self.get(id).await?;
			let c = found.filter(|c| ["hash", "reservedBytes", "area", "blocksArea", "state"].iter().all(|k| c.get(k) == r.get(k))).ok_or_else(|| blocked("incomplete journal reconstruction"))?;
			self.verify(&c)?;
			sum += num_of(&c, "reservedBytes").unwrap_or(0.0);
			if !terminal(text(&c, "state")) {
				if let Some(n) = first_open(&c).filter(|n| step_state(&c, *n) != Some("prepared")) {
					self.resolve(&c, n, None).await?;
				}
			}
		}
		let limits = self.limits;
		self.change(|i, _| {
			let mut future = 0.0;
			if let Some(f) = i.get("future").and_then(Json::as_object) {
				for (_, r) in f.iter() {
					let (count, per_slot) = (num_of(r, "slots").unwrap_or(f64::NAN), num_of(r, "bytesPerSlot").unwrap_or(f64::NAN));
					if !safe_integer(count) || count < 0.0 || !safe_integer(per_slot) || per_slot < 1024.0 || per_slot > limits.max_command_bytes {
						return Err(blocked("reservation reconstruction mismatch"));
					}
					future += count * per_slot;
				}
			}
			let total = sum + future;
			if Some(total) != num_of(i, "reservedBytes") || total + limits.max_index_bytes > limits.max_journal_bytes {
				return Err(blocked("reservation reconstruction mismatch"));
			}
			set(i, "mode", "ready");
			Ok(())
		}).await?;
		self.ready = true;
		Ok(())
	}

	/// `recoverMany`: empty journals start in one bounded commit per 16, what holds work recovers on its own.
	pub async fn recover_many(all: &mut [&mut Self]) -> R<()> {
		if all.iter().any(|r| r.ready) {
			return Err(blocked("batched recovery requires one inactive, fenced owner"));
		}
		let mut retained = vec![];
		for (n, batch) in all.chunks_mut(16).enumerate() {
			let env = &batch[0].env;
			env.assert_authority().await?;
			let mut tx = Tx::new(env);
			let mut empty = vec![];
			for (m, r) in batch.iter().enumerate() {
				let limits = r.limits.to_json();
				let at = tx.doc(JOURNAL, &r.router_id, empty_index)?;
				let i = tx.at(at);
				if text(i, "authorityId").is_some_and(|a| a != r.authority_id) || (i.get("limits").is_some_and(|l| !l.is_null()) && hash(i.get("limits").unwrap_or(&Json::Null))? != hash(&limits)?) {
					return Err(blocked("journal authority or budget changed"));
				}
				if !refs(i).is_empty() || i.get("future").and_then(Json::as_object).is_some_and(|f| !f.is_empty()) {
					retained.push(n * 16 + m);
					continue;
				}
				if num_of(i, "reservedBytes") != Some(0.0) {
					return Err(blocked("empty journal reservation mismatch"));
				}
				set(i, "authorityId", r.authority_id.as_str());
				set(i, "limits", limits);
				set(i, "mode", "ready");
				if bytes(i) > r.limits.max_index_bytes {
					return Err(budget("router index exceeds budget"));
				}
				empty.push(m);
			}
			env.assert_authority().await?;
			tx.commit()?;
			for m in empty {
				batch[m].ready = true;
			}
		}
		for at in retained {
			all[at].recover().await?;
		}
		Ok(())
	}

	async fn checkpoint(&mut self, point: &'static str, c: &Json) -> R<()> {
		let done = self.env.checkpoint(point, c).await;
		if done.is_err() {
			self.ready = false;
		}
		done
	}

	/// `advance`: runs a command as far as it goes now.
	pub async fn advance(&mut self, id: &str, mut completed: Option<CommitHook<'_, '_>>) -> R<Json> {
		ident(id)?;
		self.must_be_ready()?;
		let mut c = self.get(id).await?.ok_or_else(|| blocked("unknown command"))?;
		self.verify(&c)?;
		if c.get("erased").is_some() {
			return Err(error("ResultExpired", "Child command content was erased"));
		}
		let mut reprepared: Vec<usize> = vec![];
		while !terminal(text(&c, "state")) {
			let n = first_open(&c).ok_or_else(|| blocked("inconsistent command state"))?;
			if step_state(&c, n) != Some("prepared") {
				c = self.resolve(&c, n, completed.as_deref_mut()).await?;
				if terminal(text(&c, "state")) {
					break;
				}
				if step_state(&c, n) != Some("prepared") {
					return Ok(c);
				}
			}
			// Refused before admission: prepare again under the current binding where that is allowed (v3 5.3.1).
			if refused_before_admission(&steps(&c)[n]) {
				match self.env.reprepare(steps(&c)[n].clone()).await {
					Err(()) | Ok(Reprepared::Wait) => return Ok(c),
					Ok(Reprepared::Refuse) => return self.update(id, |d, _, _| {
						set(step_mut(d, n), "state", "needsReview");
						set(d, "state", "needsReview");
						Ok(())
					}).await,
					Ok(Reprepared::Spec(spec)) => {
						self.update(id, |d, _, i| {
							let s = step_mut(d, n);
							let Json::Object(o) = s else { unreachable!("a step is an object") };
							o.insert("target", spec.get("target").cloned().unwrap_or(Json::Null));
							o.insert("generation", spec.get("generation").cloned().unwrap_or(Json::Null));
							match spec.get("policyVersion") {
								Some(v) => o.insert("policyVersion", v.clone()),
								None => { o.remove("policyVersion"); }
							}
							match spec.get("generationAdmitUntil") {
								Some(v) => o.insert("generationAdmitUntil", v.clone()),
								None => { o.remove("generationAdmitUntil"); }
							}
							let version = spec.get("policyVersion").map_or_else(|| "undefined".to_owned(), Json::to_json_text);
							o.insert("evidence", format!("prepared again under policy {version}").into());
							let h = hash(&spec_of(d))?;
							set(d, "hash", h.as_str());
							if let Some(r) = refs_mut(i).get_mut(id) {
								set(r, "hash", h);
							}
							Ok(())
						}).await?;
					}
				}
			}
			c = self.update(id, |d, _, _| {
				set(d, "state", "applying");
				set(step_mut(d, n), "state", "inflight");
				Ok(())
			}).await?;
			self.checkpoint("beforeSend", &c).await?;
			self.env.assert_authority().await?;
			let receipt = match self.env.invoke(steps(&c)[n].clone()).await {
				Ok(r) => r,
				Err(()) => return self.update(id, |d, _, _| {
					let s = step_mut(d, n);
					set(s, "state", "unknown");
					set(s, "evidence", "effect outcome unknown; resolve same request");
					Ok(())
				}).await,
			};
			self.checkpoint("afterReply", &c).await?;
			c = self.apply_receipt(id, n, receipt, completed.as_deref_mut()).await?;
			// Refused before admission: prepare it again at once (once per call), see above.
			if step_state(&c, n) == Some("prepared") && refused_before_admission(&steps(&c)[n]) && !reprepared.contains(&n) {
				reprepared.push(n);
				continue;
			}
			if step_state(&c, n) != Some("done") {
				return Ok(c);
			}
		}
		Ok(c)
	}

	/// `review`: an admin's note on a command that needs one, which may release its area.
	pub async fn review(&mut self, id: &str, admin: &str, note: &str, release_area: bool) -> R<Json> {
		ident(id)?;
		ident(admin)?;
		if note.is_empty() || note.len() > 1024 {
			return Err(type_error("bounded review note required"));
		}
		self.must_be_ready()?;
		let (key, at) = (self.key(id)?, self.env.now());
		self.change(|i, tx| {
			let doc = tx.doc(COMMANDS, &key, empty_command)?;
			let command = tx.at(doc).as_object_mut().and_then(|o| o.get_mut("command")).filter(|c| text(c, "state") == Some("needsReview"));
			let Some(c) = command.filter(|c| refs(i).contains_key(id) && c.get("reviews").and_then(Json::as_array).is_some_and(|r| r.len() < 4)) else {
				return Err(blocked("review requires retained needsReview history"));
			};
			if let Some(Json::Array(r)) = c.as_object_mut().and_then(|o| o.get_mut("reviews")) {
				r.push(obj! { "at" => at, "admin" => admin, "note" => note, "releaseArea" => release_area });
			}
			if bytes(c) > num_of(c, "reservedBytes").unwrap_or(0.0) {
				return Err(budget("review exceeds reservation"));
			}
			let out = c.clone();
			if release_area {
				if let Some(r) = refs_mut(i).get_mut(id) {
					set(r, "released", true);
				}
			}
			Ok(out)
		}).await
	}
}
