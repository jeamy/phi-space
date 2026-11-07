//! Run control (`RunController` of src/run-controller.ts; docs/betrieb-und-mobile-steuerung.en.md §6, §8 B3): a durable
//! journal of start/pause/resume/stop with monotone control revisions. Every Member of a run's manifest applies the command
//! to its RunGate; a transition is complete only when every Member confirmed it with a matching ACK. A crash or a lost reply
//! resends the same command (same revision and command ID), which the gate answers with its stored confirmation.
//! The journal document is written field for field as TypeScript writes it, so either side takes over the other's journal.
use crate::router::{RouterEnv, Tx};
use phi_core::space::{conflict, error, exhausted, illegal, js_string, truthy, CoreError};
use phi_json::{digest_json, num_of, number_text, obj, text, Json, Object};
use phi_wire::Local;

type R<T> = Result<T, CoreError>;
pub const JOURNAL: &str = "phi-spaces.run-controller";
const MAX_RUNS: usize = 1024;
const MAX_MEMBERS: usize = 64;
const MAX_CONFIG_BYTES: usize = 16 * 1024;
const MAX_COMMANDS: usize = 256;
const MAX_ISSUED: usize = 128;
/// The error classes `runCommands` answers as a failed result (`IllegalArgumentError | TransactionError | LimitError` and their subclasses).
const REFUSALS: [&str; 8] = ["IllegalArgumentError", "UniqueConflict", "TransactionError", "CompletionViolation", "RunGateConflict", "RunBusy", "LimitError", "ResourceExhausted"];
/// What `dueSchedules` drops as not applicable (`IllegalArgumentError | TransactionError`).
const DROPPED: [&str; 6] = ["IllegalArgumentError", "UniqueConflict", "TransactionError", "CompletionViolation", "RunGateConflict", "RunBusy"];
/// Names a plain object inherits from `Object.prototype`: `r.commands[id]` finds a function there, never a record of this run.
const INHERITED: [&str; 8] = ["constructor", "toString", "toLocaleString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "__proto__"];

/// The Members of a run and the control identity around the journal.
pub trait RunEnv: RouterEnv {
	/// `member(spaceId).prepare(run, gate)`: the ACK, after the Member wrote the run's tasks.
	fn prepare(&self, space_id: &str, spec: &Json, command: &Json) -> Local<R<Json>>;
	/// `member(spaceId).gate(command)`: the ACK.
	fn gate(&self, space_id: &str, command: &Json) -> Local<R<Json>>;
	/// `member(spaceId).recover(runId, recoveryId)`: the RunRecoveryView.
	fn recover(&self, space_id: &str, run_id: &str, recovery_id: &str) -> Local<R<Json>>;
	/// `identity`: the control authority and incarnation (`{ authorityId, incarnation }`), or none when the host has no identity.
	fn identity(&self) -> Local<R<Option<Json>>>;
}

fn busy(m: impl Into<String>) -> CoreError { error("RunBusy", m) }
fn limit(m: impl Into<String>) -> CoreError { error("LimitError", m) }
fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| illegal("a value that cannot be hashed")) }
/// `/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/`
fn valid_id(s: &str) -> bool {
	let b = s.as_bytes();
	!b.is_empty() && b.len() <= 96 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
}
/// `.slice(0, n)` by UTF-16 units.
fn cut(t: &str, n: usize) -> String { String::from_utf16_lossy(&t.encode_utf16().take(n).collect::<Vec<_>>()) }
fn set(v: &mut Json, k: &str, x: impl Into<Json>) {
	if let Json::Object(o) = v {
		o.insert(k, x.into());
	}
}
fn del(v: &mut Json, k: &str) {
	if let Json::Object(o) = v {
		o.remove(k);
	}
}
fn field<'a>(v: &'a mut Json, k: &str) -> &'a mut Json { v.as_object_mut().and_then(|o| o.get_mut(k)).expect("the journal has the field") }
fn object<'a>(v: &'a mut Json, k: &str) -> &'a mut Object { field(v, k).as_object_mut().expect("the journal field is an object") }
fn array<'a>(v: &'a mut Json, k: &str) -> &'a mut Vec<Json> { field(v, k).as_array_mut().expect("the journal field is an array") }
fn strings(v: &Json, k: &str) -> Vec<String> { v.get(k).and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect()) }
fn members_of(r: &Json) -> Vec<String> { r.get("spec").map_or(vec![], |s| strings(s, "members")) }
fn run_id_of(r: &Json) -> String { r.get("spec").and_then(|s| text(s, "runId")).unwrap_or("").to_owned() }
fn revision(v: &Json) -> f64 { num_of(v, "revision").unwrap_or(0.0) }
fn same_identity(a: &Json, b: &Json) -> bool { a.get("authorityId") == b.get("authorityId") && a.get("incarnation") == b.get("incarnation") }
fn initial() -> Json { obj! { "runs" => Object::new() } }
fn empty() -> Json { Json::Object(Object::new()) }
/// `r.commands[id]`: the record, an inherited function (never the same hash) or nothing.
enum Lookup<'a> {
	Own(&'a Json),
	Inherited,
	None,
}
fn command_of<'a>(r: &'a Json, id: &str) -> Lookup<'a> {
	match r.get("commands").and_then(|c| c.get(id)) {
		Some(c) => Lookup::Own(c),
		None if INHERITED.contains(&id) => Lookup::Inherited,
		None => Lookup::None,
	}
}
fn command_hash<'a>(r: &'a Json, id: &str) -> Option<&'a str> { if let Lookup::Own(c) = command_of(r, id) { text(c, "hash") } else { None } }
fn commands_len(r: &Json) -> usize { r.get("commands").and_then(Json::as_object).map_or(0, Object::len) }
fn put_command(r: &mut Json, id: &str, hash: &str, kind: &str, revision: f64) { object(r, "commands").insert(id, obj! { "hash" => hash, "kind" => kind, "revision" => revision }); }

/// `validate`.
fn validate(spec: &Json) -> R<()> {
	let fine = |k: &str| text(spec, k).is_some_and(valid_id);
	if !fine("runId") || !fine("kind") {
		return Err(illegal("a run needs a runId and a kind"));
	}
	let members = spec.get("members").and_then(Json::as_array);
	let distinct = members.is_some_and(|m| {
		let mut seen: Vec<&Json> = vec![];
		m.iter().all(|x| { let new = !seen.contains(&x); seen.push(x); new })
	});
	if !members.is_some_and(|m| !m.is_empty() && m.len() <= MAX_MEMBERS) || !distinct || !members.is_some_and(|m| m.iter().all(|x| x.as_str().is_some_and(valid_id))) {
		return Err(illegal(format!("a run needs 1..{MAX_MEMBERS} distinct Members")));
	}
	let config = spec.get("config").cloned().unwrap_or(Json::Null);
	if config.canonical().map_err(|_| illegal("a value that cannot be hashed"))?.len() > MAX_CONFIG_BYTES {
		return Err(limit("run configuration is too large"));
	}
	Ok(())
}
/// `issue`: the pending command goes on the issued list (bounded) and becomes the run's pending transition.
fn issue(r: &mut Json, p: Json) {
	let issued = array(r, "issued");
	issued.push(p.get("commandId").cloned().unwrap_or(Json::Null));
	if issued.len() > MAX_ISSUED {
		let over = issued.len() - MAX_ISSUED;
		issued.drain(..over);
	}
	set(r, "pending", p);
}
/// `viewHash`: stable control data of all views, without timestamps: what an admin decision is bound to.
fn view_hash(r: &Json, views: &Json) -> R<String> {
	let members = members_of(r);
	hash(&obj! {
		"runId" => run_id_of(r), "members" => phi_json::strings(&members),
		"journal" => obj! { "revision" => r.get("revision").cloned().unwrap_or(Json::Null), "state" => r.get("state").cloned().unwrap_or(Json::Null) },
		"abandoned" => r.get("recovery").and_then(|q| q.get("abandoned")).cloned().unwrap_or(Json::Null),
		"views" => Json::Array(members.iter().map(|m| views.get(m).cloned().unwrap_or(Json::Null)).collect())
	})
}
fn ack_phase<'a>(p: &'a Json, m: &str) -> Option<&'a str> { p.get("acks").and_then(|a| a.get(m)).and_then(|a| text(a, "phase")) }
/// `viewOf`.
pub fn view_of(r: &Json) -> Json {
	let members = members_of(r);
	let spec = r.get("spec").cloned().unwrap_or_else(empty);
	let mut v = obj! { "runId" => spec.get("runId").cloned().unwrap_or(Json::Null), "kind" => spec.get("kind").cloned().unwrap_or(Json::Null), "members" => phi_json::strings(&members), "revision" => r.get("revision").cloned().unwrap_or(Json::Null), "state" => r.get("state").cloned().unwrap_or(Json::Null) };
	let (p, q) = (r.get("pending"), r.get("recovery"));
	if let Some(q) = q {
		let mut rec = obj! { "id" => q.get("id").cloned().unwrap_or(Json::Null), "stage" => q.get("stage").cloned().unwrap_or(Json::Null) };
		for k in ["reason", "viewHash", "abandoned", "decision"] {
			if truthy(q.get(k)) {
				set(&mut rec, k, q.get(k).cloned().unwrap_or(Json::Null));
			}
		}
		set(&mut rec, "errors", q.get("errors").cloned().unwrap_or_else(empty));
		for k in ["changed", "partial"] {
			if truthy(q.get(k)) {
				set(&mut rec, k, q.get(k).cloned().unwrap_or(Json::Null));
			}
		}
		set(&mut rec, "views", q.get("views").cloned().unwrap_or_else(empty));
		set(&mut v, "recovery", rec);
	}
	if let Some(p) = p {
		let errors = p.get("errors").cloned().unwrap_or_else(empty);
		let kind = text(p, "kind").unwrap_or("");
		let state = match kind {
			"prepare" | "release" => "preparing",
			"pause" => if errors.as_object().is_some_and(|e| !e.is_empty()) { "pauseIncomplete" } else { "pausing" },
			"resume" => "resuming",
			_ => "stopping",
		};
		set(&mut v, "state", state);
		let pick = |f: &dyn Fn(&str) -> bool| phi_json::strings(&members.iter().filter(|m| f(m)).cloned().collect::<Vec<_>>());
		set(&mut v, "pending", obj! {
			"commandId" => p.get("commandId").cloned().unwrap_or(Json::Null), "kind" => kind, "revision" => p.get("revision").cloned().unwrap_or(Json::Null), "errors" => errors,
			"applied" => pick(&|m| ack_phase(p, m) == Some("applied")), "fenced" => pick(&|m| ack_phase(p, m) == Some("fenced")), "missing" => pick(&|m| p.get("acks").and_then(|a| a.get(m)).is_none())
		});
	}
	if let Some(q) = q {
		set(&mut v, "state", if matches!(text(q, "stage"), Some("review" | "required")) { "needsReview" } else { "reconciling" });
	}
	v
}
/// The states a transition starts from.
fn from(kind: &str) -> &'static [&'static str] {
	match kind {
		"pause" => &["running"],
		"resume" => &["paused"],
		_ => &["preparing", "running", "paused"],
	}
}
fn pending_object(command_id: &str, kind: &str, revision: f64, identity: Option<&Json>) -> Json {
	let mut p = obj! { "commandId" => command_id, "kind" => kind, "revision" => revision, "acks" => Object::new(), "errors" => Object::new() };
	if let Some(i) = identity {
		set(&mut p, "identity", i.clone());
	}
	p
}
/// `expect`: the gate state every present view showed, by Member.
fn expected(views: &[Json]) -> Json {
	let mut e = Object::new();
	for v in views.iter().filter(|v| v.get("present") == Some(&Json::Bool(true))) {
		let g = v.get("gate").cloned().unwrap_or(Json::Null);
		e.insert(js_string(v.get("spaceId").unwrap_or(&Json::Null)), obj! { "revision" => g.get("revision").cloned().unwrap_or(Json::Null), "state" => g.get("state").cloned().unwrap_or(Json::Null) });
	}
	Json::Object(e)
}
/// `/is under recovery ([a-zA-Z0-9._:-]+);/`: the recovery a Member's refusal names.
fn fenced_in(e: &str) -> Option<String> {
	let mut rest = e;
	while let Some(at) = rest.find("is under recovery ") {
		let after = &rest[at + "is under recovery ".len()..];
		let n = after.bytes().take_while(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c)).count();
		if n > 0 && after.as_bytes().get(n) == Some(&b';') {
			return Some(after[..n].to_owned());
		}
		rest = &rest[at + 1..];
	}
	None
}
/// `/review again|belongs to another command|under recovery/`.
fn changed_after_review(e: &str) -> bool { e.contains("review again") || e.contains("belongs to another command") || e.contains("under recovery") }

pub struct RunController<E: RunEnv> {
	pub env: E,
}

impl<E: RunEnv> RunController<E> {
	pub fn new(env: E) -> Self { RunController { env } }
	fn now(&self) -> f64 { self.env.now() }
	/// `identity`: written into the journal only when there is one (`identity ? { identity } : {}`).
	async fn identity(&self) -> R<Option<Json>> { Ok(self.env.identity().await?.filter(|i| truthy(Some(i)))) }
	/// `commit`: one commit over the journal's runs.
	fn commit<T>(&self, f: impl FnOnce(&mut Object) -> R<T>) -> R<T> {
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(JOURNAL, "", initial)?;
		let r = f(object(tx.at(at), "runs"))?;
		tx.commit()?;
		Ok(r)
	}
	fn run_of(&self, run_id: &str) -> R<Option<Json>> { self.commit(|runs| Ok(runs.get(run_id).cloned())) }

	/// `start`: journals the run, prepares every Member behind a `preparing` gate and releases the gates once all are prepared.
	pub async fn start(&self, command_id: &str, spec: &Json) -> R<Json> {
		validate(spec)?;
		if !valid_id(command_id) {
			return Err(illegal("invalid command ID"));
		}
		let h = hash(&obj! { "op" => "start", "spec" => spec.clone() })?;
		let identity = self.identity().await?;
		let run_id = text(spec, "runId").unwrap_or("").to_owned();
		let now = self.now();
		self.commit(|runs| {
			if let Some(old) = runs.get(&run_id) {
				if command_hash(old, command_id) == Some(&h) {
					return Ok(());
				}
				return Err(conflict(format!("run {run_id} was already started by another command")));
			}
			if runs.len() >= MAX_RUNS {
				return Err(exhausted("run journal is full"));
			}
			let mut commands = Object::new();
			commands.insert(command_id, obj! { "hash" => h.as_str(), "kind" => "start", "revision" => 1.0 });
			let mut r = obj! { "spec" => spec.clone(), "revision" => 0.0, "state" => "preparing", "at" => now, "tuples" => Object::new(), "issued" => Vec::<Json>::new(), "commands" => commands };
			issue(&mut r, pending_object(command_id, "prepare", 1.0, identity.as_ref()));
			runs.insert(&run_id, r);
			Ok(())
		})?;
		self.advance(&run_id).await
	}
	pub async fn pause(&self, command_id: &str, run_id: &str) -> R<Json> { self.transition(command_id, run_id, "pause").await }
	pub async fn resume(&self, command_id: &str, run_id: &str) -> R<Json> { self.transition(command_id, run_id, "resume").await }
	pub async fn stop(&self, command_id: &str, run_id: &str) -> R<Json> { self.transition(command_id, run_id, "stop").await }

	async fn transition(&self, command_id: &str, run_id: &str, kind: &str) -> R<Json> {
		if !valid_id(command_id) {
			return Err(illegal("invalid command ID"));
		}
		let h = hash(&obj! { "op" => kind, "runId" => run_id })?;
		let identity = self.identity().await?;
		self.commit(|runs| {
			let Some(r) = runs.get_mut(run_id) else { return Err(illegal(format!("unknown run {run_id}"))) };
			match command_of(r, command_id) {
				Lookup::Own(old) if text(old, "hash") == Some(&h) => return Ok(()),
				Lookup::Own(_) | Lookup::Inherited => return Err(illegal("command ID was used for another command")),
				Lookup::None => {}
			}
			if let Some(q) = r.get("recovery") {
				return Err(busy(format!("run {run_id} is under recovery {}; resolve it first", text(q, "id").unwrap_or(""))));
			}
			// A stop may replace an unfinished preparation (no transaction can be bound yet); anything else waits.
			let pending = r.get("pending").cloned();
			let supersede = kind == "stop" && pending.as_ref().is_some_and(|p| matches!(text(p, "kind"), Some("prepare" | "release")));
			if let Some(p) = pending.as_ref().filter(|_| !supersede) {
				return Err(busy(format!("run {run_id} is still applying {} at revision {}", text(p, "kind").unwrap_or(""), number_text(revision(p)))));
			}
			let state = text(r, "state").unwrap_or("").to_owned();
			if !from(kind).contains(&state.as_str()) {
				return Err(conflict(format!("cannot {kind} run {run_id} while it is {state}")));
			}
			if commands_len(r) >= MAX_COMMANDS {
				return Err(exhausted("run command history is full"));
			}
			let next = pending.as_ref().map_or(revision(r), revision) + 1.0;
			issue(r, pending_object(command_id, kind, next, identity.as_ref()));
			put_command(r, command_id, &h, kind, next);
			Ok(())
		})?;
		self.advance(run_id).await
	}

	/// `reconcile`: starts the reconciliation of a run after a Control or Data restore (§6 Abgleich nach Restore). A pending
	/// transition is parked as evidence and never resent. Every Member installs the recovery entry fence and reports its view.
	/// Identical stable paused/stopped views of known origin are confirmed with fresh ACKs; anything else waits for `resolve`.
	/// `manifest` (`{ kind, members }`) rebuilds a run the restored journal no longer knows.
	pub async fn reconcile(&self, command_id: &str, run_id: &str, recovery_id: &str, manifest: Option<&Json>) -> R<Json> {
		if !valid_id(command_id) || !valid_id(recovery_id) {
			return Err(illegal("invalid command or recovery ID"));
		}
		if let Some(m) = manifest {
			validate(&obj! { "runId" => run_id, "kind" => m.get("kind").cloned().unwrap_or(Json::Null), "config" => Json::Null, "members" => m.get("members").cloned().unwrap_or(Json::Null) })?;
		}
		let h = hash(&obj! { "op" => "reconcile", "runId" => run_id, "recoveryId" => recovery_id, "manifest" => manifest.cloned().unwrap_or(Json::Null) })?;
		let identity = self.identity().await?;
		let now = self.now();
		self.commit(|runs| {
			if let Some(r) = runs.get(run_id) {
				match command_of(r, command_id) {
					Lookup::Own(old) if text(old, "hash") == Some(&h) => return Ok(()),
					Lookup::Own(_) | Lookup::Inherited => return Err(illegal("command ID was used for another command")),
					Lookup::None => {}
				}
			}
			if !runs.contains_key(run_id) {
				let Some(m) = manifest else { return Err(illegal(format!("run {run_id} is not in this journal; name its kind and Members"))) };
				if runs.len() >= MAX_RUNS {
					return Err(exhausted("run journal is full"));
				}
				let spec = obj! { "runId" => run_id, "kind" => m.get("kind").cloned().unwrap_or(Json::Null), "config" => Json::Null, "members" => phi_json::strings(&strings(m, "members")) };
				runs.insert(run_id, obj! { "spec" => spec, "revision" => 0.0, "state" => "preparing", "at" => now, "tuples" => Object::new(), "issued" => Vec::<Json>::new(), "commands" => Object::new() });
			} else if let Some(m) = manifest {
				let r = runs.get(run_id).expect("looked at above");
				let own = r.get("spec").expect("a run has a spec");
				let pair = |kind: Option<&Json>, members: Option<&Json>| Json::Array(vec![kind.cloned().unwrap_or(Json::Null), members.cloned().unwrap_or(Json::Null)]).canonical().unwrap_or_default();
				if pair(m.get("kind"), m.get("members")) != pair(own.get("kind"), own.get("members")) {
					return Err(conflict("the manifest differs from the journal; review the journal first"));
				}
			}
			let r = runs.get_mut(run_id).expect("present now");
			let current = revision(r);
			if r.get("recovery").and_then(|q| text(q, "id")) == Some(recovery_id) {
				put_command(r, command_id, &h, "reconcile", current);
				return Ok(());
			}
			if commands_len(r) >= MAX_COMMANDS {
				return Err(exhausted("run command history is full"));
			}
			let abandoned = match r.get("pending") {
				Some(p) => Some(obj! { "commandId" => p.get("commandId").cloned().unwrap_or(Json::Null), "kind" => p.get("kind").cloned().unwrap_or(Json::Null), "revision" => p.get("revision").cloned().unwrap_or(Json::Null) }),
				None => r.get("recovery").and_then(|q| q.get("abandoned")).cloned(),
			};
			del(r, "pending");
			let mut q = obj! { "id" => recovery_id, "commandId" => command_id, "stage" => "gathering", "views" => Object::new(), "errors" => Object::new() };
			if let Some(i) = &identity {
				set(&mut q, "identity", i.clone());
			}
			if let Some(a) = abandoned {
				set(&mut q, "abandoned", a);
			}
			set(r, "recovery", q);
			put_command(r, command_id, &h, "reconcile", current);
			Ok(())
		})?;
		self.advance(run_id).await
	}

	/// `resolve`: the admin decision after `needsReview` (resolveRunRecovery). It is bound to the reviewed views by their hash;
	/// every Member step compares and sets the reviewed gate state. `resume` first completes a pause barrier and is refused if
	/// any evidence shows the run stopped.
	pub async fn resolve(&self, command_id: &str, run_id: &str, expected_view_hash: &str, decision: &Json) -> R<Json> {
		let Some(decision) = decision.as_str().filter(|d| ["pause", "stop", "resume"].contains(d)).filter(|_| valid_id(command_id)) else { return Err(illegal("invalid recovery decision")) };
		let h = hash(&obj! { "op" => "resolve", "runId" => run_id, "expectedViewHash" => expected_view_hash, "decision" => decision })?;
		let identity = self.identity().await?;
		self.commit(|runs| {
			let Some(r) = runs.get_mut(run_id) else { return Err(illegal(format!("unknown run {run_id}"))) };
			match command_of(r, command_id) {
				Lookup::Own(old) if text(old, "hash") == Some(&h) => return Ok(()),
				Lookup::Own(_) | Lookup::Inherited => return Err(illegal("command ID was used for another command")),
				Lookup::None => {}
			}
			let Some(q) = r.get("recovery").filter(|q| text(q, "stage") == Some("review")).cloned() else { return Err(conflict(format!("run {run_id} has no recovery waiting for a decision"))) };
			if text(&q, "viewHash") != Some(expected_view_hash) {
				return Err(conflict("the recovery views changed; review again"));
			}
			let views: Vec<Json> = members_of(r).iter().map(|m| q.get("views").and_then(|v| v.get(m)).cloned().unwrap_or(Json::Null)).collect();
			let stopped = |v: &Json| v.get("stopped") == Some(&Json::Bool(true));
			if decision == "resume" && (text(r, "state") == Some("stopped") || views.iter().any(stopped)) {
				return Err(conflict("a stopped run is never resumed"));
			}
			if decision != "stop" && views.iter().any(|v| v.get("present") != Some(&Json::Bool(true)) || v.get("gate").and_then(|g| text(g, "state")) == Some("preparing")) {
				return Err(conflict("Members without a prepared gate allow only stop"));
			}
			if commands_len(r) >= MAX_COMMANDS {
				return Err(exhausted("run command history is full"));
			}
			let top = views.iter().map(|v| num_of(v, "maxRevision").unwrap_or(0.0)).fold(revision(r).max(q.get("abandoned").map_or(0.0, revision)), f64::max);
			let next = top + 1.0;
			let mut p = pending_object(command_id, if decision == "stop" { "stop" } else { "pause" }, next, None);
			set(&mut p, "recoveryId", q.get("id").cloned().unwrap_or(Json::Null));
			set(&mut p, "expect", expected(&views));
			if decision == "resume" {
				set(&mut p, "then", "resume");
			}
			if let Some(i) = &identity {
				set(&mut p, "identity", i.clone());
			}
			issue(r, p);
			let rec = field(r, "recovery");
			set(rec, "stage", "deciding");
			set(rec, "decision", obj! { "commandId" => command_id, "decision" => decision, "viewHash" => expected_view_hash, "auto" => false });
			put_command(r, command_id, &h, "resolve", next);
			Ok(())
		})?;
		self.advance(run_id).await
	}

	/// `gather`: every Member's view under the recovery; `true` means the loop goes again, `false` that it waits.
	async fn gather(&self, r: &Json) -> R<bool> {
		let q = r.get("recovery").cloned().unwrap_or_else(empty);
		let (run_id, recovery_id) = (run_id_of(r), text(&q, "id").unwrap_or("").to_owned());
		for space_id in members_of(r) {
			if q.get("views").and_then(|v| v.get(&space_id)).is_some_and(|v| v.get("stable") == Some(&Json::Bool(true))) {
				continue;
			}
			let got = match self.env.recover(&space_id, &run_id, &recovery_id).await {
				Ok(view) => {
					if text(&view, "runId") != Some(&run_id) || text(&view, "recoveryId") != Some(&recovery_id) || (!view.get("spaceId").is_none_or(Json::is_null) && text(&view, "spaceId") != Some(&space_id)) {
						Err("recovery view does not match the request".to_owned())
					} else {
						Ok(view)
					}
				}
				Err(e) => Err(cut(&e.message, 256)),
			};
			self.commit(|runs| {
				let Some(cur) = runs.get_mut(&run_id).and_then(|r| r.as_object_mut()).and_then(|r| r.get_mut("recovery")) else { return Ok(()) };
				if text(cur, "id") != Some(&recovery_id) || text(cur, "stage") != Some("gathering") {
					return Ok(());
				}
				match &got {
					Ok(view) => {
						object(cur, "views").insert(&space_id, view.clone());
						object(cur, "errors").remove(&space_id);
					}
					Err(e) => object(cur, "errors").insert(&space_id, e.as_str().into()),
				}
				Ok(())
			})?;
		}
		self.commit(|runs| {
			let cur = runs.get_mut(&run_id).expect("the run stays");
			let Some(q) = cur.get("recovery").filter(|q| text(q, "stage") == Some("gathering")).cloned() else { return Ok(true) };
			let members = members_of(cur);
			let view = |m: &str| q.get("views").and_then(|v| v.get(m)).cloned();
			if !members.iter().all(|m| view(m).is_some_and(|v| v.get("stable") == Some(&Json::Bool(true)))) {
				return Ok(false);
			}
			let views: Vec<Json> = members.iter().map(|m| view(m).unwrap_or(Json::Null)).collect();
			// ACKs from now on must come from the incarnations that reported these views.
			let mut tuples = Object::new();
			for v in &views {
				tuples.insert(text(v, "spaceId").unwrap_or(""), obj! { "incarnation" => v.get("incarnation").cloned().unwrap_or(Json::Null), "authorityId" => v.get("authorityId").cloned().unwrap_or(Json::Null) });
			}
			set(cur, "tuples", tuples);
			let mut states: Vec<String> = vec![];
			for v in &views {
				let s = v.get("gate").and_then(|g| text(g, "state")).unwrap_or("missing").to_owned();
				if !states.contains(&s) {
					states.push(s);
				}
			}
			let state = states[0].clone();
			let clean = views.iter().all(|v| {
				let gate = v.get("gate");
				v.get("present") == Some(&Json::Bool(true)) && !truthy(v.get("fence")) && !v.get("restored").is_some_and(|x| truthy(Some(x)) && (truthy(x.get("fence")) || x.get("state") != gate.and_then(|g| g.get("state")) || x.get("revision") != gate.and_then(|g| g.get("revision"))))
			});
			let issued = strings(cur, "issued");
			let resolved: Vec<Json> = cur.get("resolved").and_then(Json::as_array).cloned().unwrap_or_default();
			let known = views.iter().all(|v| {
				let id = v.get("gate").and_then(|g| g.get("commandId")).filter(|x| !x.is_null());
				issued.iter().any(|i| i.as_str() == id.and_then(Json::as_str).unwrap_or("")) || resolved.iter().any(|x| id.is_some() && x.get("id") == id)
			});
			let stopped = text(cur, "state") == Some("stopped") || views.iter().any(|v| v.get("stopped") == Some(&Json::Bool(true)));
			if clean && known && !truthy(q.get("abandoned")) && states.len() == 1 && (state == "stopped" || (state == "paused" && !stopped)) {
				let next = views.iter().map(|v| num_of(v, "maxRevision").unwrap_or(0.0)).fold(revision(cur), f64::max) + 1.0;
				let command_id = format!("{recovery_id}:confirm");
				let decision = if state == "paused" { "pause" } else { "stop" };
				let mut p = pending_object(&command_id, decision, next, None);
				set(&mut p, "recoveryId", recovery_id.as_str());
				set(&mut p, "expect", expected(&views));
				if let Some(i) = q.get("identity") {
					set(&mut p, "identity", i.clone());
				}
				issue(cur, p);
				let rec = field(cur, "recovery");
				set(rec, "stage", "deciding");
				set(rec, "decision", obj! { "commandId" => command_id.as_str(), "decision" => decision, "viewHash" => Json::Null, "auto" => true });
				return Ok(true);
			}
			let h = view_hash(cur, q.get("views").unwrap_or(&Json::Null))?;
			let rec = field(cur, "recovery");
			set(rec, "stage", "review");
			set(rec, "viewHash", h);
			Ok(false)
		})
	}

	/// `advance`: sends the pending command to every Member that has not applied it and records the answers. Safe to repeat
	/// at any time, also after a restart. Fenced Members finish their bound transactions first; call again later.
	/// A transition issued under another control authority or incarnation is never resent, and a Member under a restore
	/// recovery takes no ordinary command: both start `reconcile` automatically.
	pub async fn advance(&self, run_id: &str) -> R<Json> {
		loop {
			let Some(r) = self.run_of(run_id)? else { return Err(illegal(format!("unknown run {run_id}"))) };
			let identity = self.identity().await?;
			let issued_under = r.get("pending").and_then(|p| p.get("identity")).or_else(|| r.get("recovery").and_then(|q| q.get("identity")));
			if let (Some(i), Some(u)) = (&identity, issued_under) {
				if !same_identity(i, u) {
					// Control restore: never resend; reconcile under a recovery named after the new incarnation.
					let incarnation = i.get("incarnation").filter(|x| !x.is_null()).map_or("unknown".to_owned(), js_string);
					let keep = |u: u16| u < 128 && { let c = u as u8; c.is_ascii_alphanumeric() || b"._:-".contains(&c) };
					let units: Vec<u16> = format!("control-{incarnation}").encode_utf16().map(|u| if keep(u) { u } else { u16::from(b'-') }).take(90).collect();
					let id = String::from_utf16_lossy(&units);
					return Box::pin(self.reconcile(&format!("auto-{id}"), run_id, &id, None)).await;
				}
			}
			let stage = r.get("recovery").and_then(|q| text(q, "stage"));
			if matches!(stage, Some("required" | "review")) {
				return Ok(view_of(&r));
			}
			if stage == Some("gathering") {
				if self.gather(&r).await? {
					continue;
				}
				return self.status(run_id)?.ok_or_else(|| illegal(format!("unknown run {run_id}")));
			}
			let Some(p) = r.get("pending").cloned() else {
				let now = self.now();
				if r.get("schedules").and_then(Json::as_array).is_some_and(|s| s.iter().any(|x| num_of(x, "at").unwrap_or(f64::NAN) <= now)) {
					Box::pin(self.due_schedules(run_id)).await?;
					return self.status(run_id)?.ok_or_else(|| illegal(format!("unknown run {run_id}")));
				}
				return Ok(view_of(&r));
			};
			let p_id = text(&p, "commandId").unwrap_or("").to_owned();
			let p_kind = text(&p, "kind").unwrap_or("").to_owned();
			let p_revision = p.get("revision").cloned().unwrap_or(Json::Null);
			let recovery_id = p.get("recoveryId").filter(|x| truthy(Some(x))).cloned();
			for space_id in members_of(&r) {
				if ack_phase(&p, &space_id) == Some("applied") {
					continue;
				}
				let mut command = obj! { "runId" => run_id, "commandId" => p_id.as_str(), "kind" => p_kind.as_str(), "revision" => p_revision.clone() };
				if let Some(x) = &recovery_id {
					set(&mut command, "recoveryId", x.clone());
				}
				if let Some(e) = p.get("expect").and_then(|e| e.get(&space_id)).filter(|e| truthy(Some(e))) {
					set(&mut command, "expect", e.clone());
				}
				let sent = if p_kind == "prepare" { self.env.prepare(&space_id, r.get("spec").unwrap_or(&Json::Null), &command).await } else { self.env.gate(&space_id, &command).await };
				let got = match sent {
					Ok(ack) => {
						if text(&ack, "spaceId") != Some(&space_id) || text(&ack, "runId") != Some(run_id) || ack.get("revision") != Some(&p_revision) || text(&ack, "commandId") != Some(&p_id) || text(&ack, "kind") != Some(&p_kind) {
							Err(cut("ACK does not match the command", 256))
						} else {
							Ok(ack)
						}
					}
					Err(e) => Err(cut(&e.message, 256)),
				};
				self.commit(|runs| {
					let cur = runs.get_mut(run_id).expect("the run stays");
					if cur.get("pending").and_then(|q| text(q, "commandId")) != Some(&p_id) {
						return Ok(()); // another advance finished it
					}
					match &got {
						Ok(ack) => {
							let tuple = cur.get("tuples").and_then(|t| t.get(&space_id)).cloned();
							if tuple.as_ref().is_some_and(|t| t.get("incarnation") != ack.get("incarnation") || t.get("authorityId") != ack.get("authorityId")) {
								object(field(cur, "pending"), "errors").insert(&space_id, "Member incarnation or authority changed; recovery review required".into());
								return Ok(());
							}
							if tuple.is_none_or(|t| t.is_null()) {
								object(cur, "tuples").insert(&space_id, obj! { "incarnation" => ack.get("incarnation").cloned().unwrap_or(Json::Null), "authorityId" => ack.get("authorityId").cloned().unwrap_or(Json::Null) });
							}
							let q = field(cur, "pending");
							object(q, "acks").insert(&space_id, ack.clone());
							object(q, "errors").remove(&space_id);
						}
						Err(e) => {
							let under = recovery_id.as_ref().and_then(Json::as_str);
							if under.is_some() && changed_after_review(e) && cur.get("recovery").and_then(|q| text(q, "id")) == under {
								// The Member changed after the review (another state, command or recovery): gather fresh views; already applied steps stay visible.
								let members = members_of(cur);
								let q = cur.get("pending").cloned().unwrap_or_else(empty);
								let partial = phi_json::strings(&members.into_iter().filter(|m| ack_phase(&q, m) == Some("applied")).collect::<Vec<_>>());
								let rec = field(cur, "recovery");
								set(rec, "partial", partial);
								let mut changed = rec.get("changed").cloned().unwrap_or_else(empty);
								set(&mut changed, &space_id, e.as_str());
								set(rec, "changed", changed);
								set(rec, "stage", "gathering");
								set(rec, "views", Object::new());
								del(rec, "viewHash");
								del(rec, "decision");
								del(cur, "pending");
							} else {
								object(field(cur, "pending"), "errors").insert(&space_id, e.as_str().into());
							}
						}
					}
					Ok(())
				})?;
				if !self.commit(|runs| Ok(runs.get(run_id).and_then(|r| r.get("pending")).and_then(|q| text(q, "commandId")) == Some(&p_id)))? {
					break;
				}
			}
			// Data restore on a Member: its gate carries the restore's recovery; reconcile under that recovery.
			let fenced = if recovery_id.is_some() {
				None
			} else {
				self.commit(|runs| Ok(runs.get(run_id).and_then(|r| r.get("pending")).and_then(|q| q.get("errors")).and_then(Json::as_object).and_then(|e| e.iter().filter_map(|(_, m)| m.as_str().and_then(fenced_in)).next())))?
			};
			if let Some(f) = fenced {
				return Box::pin(self.reconcile(&cut(&format!("auto-{f}"), 96), run_id, &f, None)).await;
			}
			let again = self.commit(|runs| {
				let cur = runs.get_mut(run_id).expect("the run stays");
				let Some(q) = cur.get("pending").filter(|q| text(q, "commandId") == Some(&p_id)).cloned() else { return Ok(true) };
				let members = members_of(cur);
				if !members.iter().all(|m| ack_phase(&q, m) == Some("applied")) {
					return Ok(false);
				}
				let mut states: Vec<Json> = vec![];
				for m in &members {
					let s = q.get("acks").and_then(|a| a.get(m)).and_then(|a| a.get("state")).cloned().unwrap_or(Json::Null);
					if !states.contains(&s) {
						states.push(s);
					}
				}
				if states.len() != 1 {
					let names: Vec<String> = states.iter().map(js_string).collect();
					object(field(cur, "pending"), "errors").insert("*", format!("Members confirmed different states: {}", names.join(", ")).into());
					return Ok(false);
				}
				set(cur, "revision", q.get("revision").cloned().unwrap_or(Json::Null));
				set(cur, "state", states[0].clone());
				del(cur, "pending");
				let under = q.get("recoveryId").filter(|x| truthy(Some(x)));
				if under.is_some() && cur.get("recovery").and_then(|r| r.get("id")) == under {
					let rec = cur.get("recovery").cloned().unwrap_or_else(empty);
					let decision = rec.get("decision").and_then(|d| d.get("decision")).filter(|d| !d.is_null()).cloned().unwrap_or_else(|| if text(&q, "kind") == Some("stop") { "stop".into() } else { "pause".into() });
					let auto = rec.get("decision").map(|d| truthy(d.get("auto"))).unwrap_or(false);
					if cur.get("resolved").is_none_or(Json::is_null) {
						set(cur, "resolved", Vec::<Json>::new());
					}
					let resolved = array(cur, "resolved");
					resolved.push(obj! { "id" => q.get("commandId").cloned().unwrap_or(Json::Null), "decision" => decision, "auto" => auto });
					if resolved.len() > 32 {
						let over = resolved.len() - 32;
						resolved.drain(..over);
					}
					del(cur, "recovery");
				}
				let q_revision = revision(&q);
				if text(&q, "kind") == Some("prepare") {
					issue(cur, pending_object(&format!("{p_id}:release"), "release", q_revision + 1.0, q.get("identity")));
				}
				if text(&q, "then") == Some("resume") {
					issue(cur, pending_object(&format!("{p_id}:resume"), "resume", q_revision + 1.0, q.get("identity")));
				}
				Ok(cur.get("pending").is_some())
			})?;
			if !again {
				return self.status(run_id)?.ok_or_else(|| illegal(format!("unknown run {run_id}")));
			}
		}
	}
	/// `status`: the view of a run, or none.
	pub fn status(&self, run_id: &str) -> R<Option<Json>> { Ok(self.run_of(run_id)?.as_ref().map(view_of)) }
	/// `preview`: plan preview (dry run) of a start or transition: whether it would be accepted now and with which revision.
	pub fn preview(&self, kind: &str, run_id: &str, spec: Option<&Json>) -> R<Json> {
		if kind == "start" {
			if let Err(e) = validate(spec.unwrap_or(&Json::Null)) {
				return Ok(obj! { "allowed" => false, "reason" => e.message });
			}
		}
		let view = self.status(run_id)?;
		if kind == "start" {
			return Ok(match view {
				Some(v) => obj! { "allowed" => false, "reason" => format!("run {run_id} exists ({})", text(&v, "state").unwrap_or("")), "state" => v.get("state").cloned().unwrap_or(Json::Null) },
				None => obj! { "allowed" => true, "revision" => 1.0 },
			});
		}
		let Some(view) = view else { return Ok(obj! { "allowed" => false, "reason" => format!("unknown run {run_id}") }) };
		let state = view.get("state").cloned().unwrap_or(Json::Null);
		if let Some(q) = view.get("recovery") {
			return Ok(obj! { "allowed" => false, "reason" => format!("run is under recovery {}", text(q, "id").unwrap_or("")), "state" => state });
		}
		let pending = view.get("pending");
		let supersede = kind == "stop" && pending.is_some_and(|p| matches!(text(p, "kind"), Some("prepare" | "release")));
		if let Some(p) = pending.filter(|_| !supersede) {
			return Ok(obj! { "allowed" => false, "reason" => format!("still applying {} at revision {}", text(p, "kind").unwrap_or(""), number_text(revision(p))), "state" => state });
		}
		let confirmed = if pending.is_some() { "preparing".to_owned() } else { js_string(&state) };
		if !from(kind).contains(&confirmed.as_str()) {
			return Ok(obj! { "allowed" => false, "reason" => format!("cannot {kind} while {}", js_string(&state)), "state" => state });
		}
		Ok(obj! { "allowed" => true, "revision" => pending.map_or(revision(&view), revision) + 1.0, "state" => state })
	}
	/// `list`: the newest runs (at most `limit`), for overviews such as the mobile Spaces page.
	pub fn list(&self, limit: f64) -> R<Json> {
		self.commit(|runs| {
			let mut all: Vec<&Json> = runs.iter().map(|(_, r)| r).collect();
			all.sort_by(|a, b| num_of(b, "at").unwrap_or(0.0).partial_cmp(&num_of(a, "at").unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
			let n = if limit.is_nan() { 0 } else { limit.clamp(1.0, 200.0).trunc() as usize };
			Ok(Json::Array(all.into_iter().take(n).map(view_of).collect()))
		})
	}
	/// `pending`: runs with work left for the server-side loop: a transition waiting for ACKs, a recovery gathering views or a due schedule.
	pub fn pending(&self) -> R<Json> {
		let now = self.now();
		self.commit(|runs| {
			Ok(Json::Array(runs.iter().filter(|(_, r)| r.get("pending").is_some() || r.get("recovery").and_then(|q| text(q, "stage")) == Some("gathering") || r.get("schedules").and_then(Json::as_array).is_some_and(|s| s.iter().any(|x| num_of(x, "at").unwrap_or(f64::NAN) <= now))).map(|(_, r)| Json::from(run_id_of(r))).collect()))
		})
	}

	/// `schedule`: a pause or resume at a time (e.g. a maintenance window); `cancel` removes it.
	pub fn schedule(&self, command_id: &str, run_id: &str, kind: &Json, at: f64, cancel: bool) -> R<Json> {
		let Some(kind) = kind.as_str().filter(|k| ["pause", "resume"].contains(k)).filter(|_| valid_id(command_id) && phi_json::safe_integer(at)) else { return Err(illegal("a schedule needs a command ID, pause or resume and a time")) };
		self.commit(|runs| {
			let Some(r) = runs.get_mut(run_id) else { return Err(illegal(format!("unknown run {run_id}"))) };
			if r.get("schedules").is_none_or(Json::is_null) {
				set(r, "schedules", Vec::<Json>::new());
			}
			let schedules = array(r, "schedules");
			if cancel {
				schedules.retain(|x| text(x, "id") != Some(command_id));
			} else if !schedules.iter().any(|x| text(x, "id") == Some(command_id)) {
				if schedules.len() >= 16 {
					return Err(exhausted("at most 16 schedules per run"));
				}
				schedules.push(obj! { "id" => command_id, "kind" => kind, "at" => at });
				schedules.sort_by(|a, b| num_of(a, "at").unwrap_or(0.0).partial_cmp(&num_of(b, "at").unwrap_or(0.0)).unwrap_or(std::cmp::Ordering::Equal));
			}
			Ok(obj! { "runId" => run_id, "schedules" => Json::Array(schedules.clone()) })
		})
	}
	/// `dueSchedules`: issues the first due schedule (called by the server loop through `advance`).
	async fn due_schedules(&self, run_id: &str) -> R<()> {
		let now = self.now();
		let due: Vec<Json> = self.commit(|runs| {
			Ok(match runs.get(run_id) {
				Some(r) if r.get("pending").is_none() && r.get("recovery").is_none() => r.get("schedules").and_then(Json::as_array).map_or(vec![], |s| s.iter().filter(|x| num_of(x, "at").unwrap_or(f64::NAN) <= now).cloned().collect()),
				_ => vec![],
			})
		})?;
		if let Some(s) = due.first() {
			let id = text(s, "id").unwrap_or("").to_owned();
			self.commit(|runs| {
				let r = runs.get_mut(run_id).expect("the run stays");
				if r.get("schedules").is_none_or(Json::is_null) {
					set(r, "schedules", Vec::<Json>::new());
				}
				array(r, "schedules").retain(|x| text(x, "id") != Some(&id));
				Ok(())
			})?;
			if let Err(e) = Box::pin(self.transition(&id, run_id, text(s, "kind").unwrap_or(""))).await {
				if !DROPPED.contains(&e.class) {
					return Err(e);
				}
			}
		}
		Ok(())
	}
	/// `export`: no exporter is registered on a configured host, so every export is refused as TypeScript refuses it.
	pub fn export(&self, run_id: &str) -> R<Json> {
		let Some(r) = self.run_of(run_id)? else { return Err(illegal(format!("unknown run {run_id}"))) };
		Err(illegal(format!("no exporter for run kind {}", r.get("spec").and_then(|s| text(s, "kind")).unwrap_or(""))))
	}

	/// `runCommands`: the admin commands of the control-space supervisor. A refusal becomes a failed result; only unexpected
	/// errors propagate, and the supervisor retries the same job.
	pub async fn run_command(&self, op: &str, id: &str, args: &Json) -> R<Json> {
		let null = Json::Null;
		let a = |k: &str| args.get(k).filter(|v| !v.is_null());
		let string = |k: &str| a(k).map_or(String::new(), js_string);
		let run = string("runId");
		let spec = || obj! { "runId" => run.as_str(), "kind" => string("kind"), "config" => a("config").cloned().unwrap_or(Json::Null), "members" => args.get("members").cloned().unwrap_or(Json::Null) };
		let wrap = |r: R<Json>| match r {
			Err(e) if REFUSALS.contains(&e.class) => Ok(obj! { "phase" => "failed", "error" => e.message }),
			other => other,
		};
		let dry = args.get("dryRun") == Some(&Json::Bool(true));
		let or = |kind: &str| -> R<Option<Json>> {
			if !dry {
				return Ok(None);
			}
			let mut v = obj! { "dryRun" => true };
			let s = spec();
			if let Json::Object(p) = self.preview(kind, &run, if kind == "start" { Some(&s) } else { None })? {
				for (k, x) in p.iter() {
					set(&mut v, k, x.clone());
				}
			}
			Ok(Some(v))
		};
		match op {
			"startRun" => if let Some(v) = or("start")? { Ok(v) } else { wrap(self.start(id, &spec()).await) },
			"pauseRun" => if let Some(v) = or("pause")? { Ok(v) } else { wrap(self.pause(id, &run).await) },
			"resumeRun" => if let Some(v) = or("resume")? { Ok(v) } else { wrap(self.resume(id, &run).await) },
			"stopRun" => if let Some(v) = or("stop")? { Ok(v) } else { wrap(self.stop(id, &run).await) },
			"reconcileRun" => {
				let manifest = truthy(args.get("members")).then(|| obj! { "kind" => string("kind"), "members" => args.get("members").cloned().unwrap_or(Json::Null) });
				wrap(self.reconcile(id, &run, &string("recoveryId"), manifest.as_ref()).await)
			}
			"resolveRunRecovery" => wrap(self.resolve(id, &run, &string("expectedViewHash"), args.get("decision").unwrap_or(&null)).await),
			// Read-only views for admins; they change nothing.
			"listRuns" => self.list(a("limit").map_or(50.0, |l| js_number(Some(l)))),
			"runStatus" => Ok(self.status(&run)?.unwrap_or_else(|| obj! { "phase" => "failed", "error" => format!("unknown run {run}") })),
			"scheduleRun" => wrap(self.schedule(&a("scheduleId").map_or(id.to_owned(), js_string), &run, args.get("kind").unwrap_or(&null), js_number(args.get("at")), args.get("cancel") == Some(&Json::Bool(true)))),
			"exportRun" => wrap(self.export(&run)),
			_ => Err(error("TypeError", format!("runs[{op}] is not a function"))),
		}
	}
}

/// `Number(x)` of a JSON value (`undefined` is NaN).
pub fn js_number(v: Option<&Json>) -> f64 {
	match v {
		None => f64::NAN,
		Some(Json::Null) => 0.0,
		Some(Json::Bool(b)) => f64::from(u8::from(*b)),
		Some(Json::Number(n)) => *n,
		Some(Json::String(s)) => string_number(s),
		Some(a @ Json::Array(_)) => string_number(&js_string(a)),
		Some(Json::Object(_)) => f64::NAN,
	}
}
/// `Number(string)`: StringToNumber of JavaScript.
fn string_number(s: &str) -> f64 {
	let t = s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}');
	if t.is_empty() {
		return 0.0;
	}
	match t {
		"Infinity" | "+Infinity" => return f64::INFINITY,
		"-Infinity" => return f64::NEG_INFINITY,
		_ => {}
	}
	for (prefix, radix) in [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)] {
		if let Some(digits) = t.strip_prefix(prefix) {
			if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
				return f64::NAN;
			}
			return digits.chars().fold(0.0, |n, c| n * f64::from(radix) + f64::from(c.to_digit(radix).unwrap_or(0)));
		}
	}
	// a decimal literal: sign, digits with an optional point, an optional exponent (Rust's parser also takes inf and nan)
	if t.bytes().any(|c| !(c.is_ascii_digit() || b"+-.eE".contains(&c))) {
		return f64::NAN;
	}
	t.parse().unwrap_or(f64::NAN)
}
