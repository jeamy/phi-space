//! The control side of worker control (src/workers.ts): the desired worker state per host (`WorkerAssignments`), the signed list a
//! host pulls, the applied state the hosts report in their Capability heartbeats, and the admin commands. The host side
//! (`WorkerSupervisor`, loops of registered code) is not here: a Rust host registers no worker kinds.
use crate::auth::{seal, Signer};
use crate::router::{RouterEnv, Tx};
use phi_core::space::{conflict, error, exhausted, illegal, truthy, CoreError, Space, Template};
use phi_json::{digest_json, number_text, obj, safe_integer, text, Json, Object};
use phi_wire::Local;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
pub const JOURNAL: &str = "phi-spaces.worker-assignments";
const MAX_COUNT: f64 = 64.0;
const MAX_PER_HOST: usize = 32;
const MAX_ASSIGNMENTS: usize = 1024;
const MAX_COMMANDS: usize = 1024;

/// `ID`: `/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/`.
pub(crate) fn valid_id(id: &str) -> bool {
	let mut c = id.chars();
	c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && id.chars().count() <= 96 && c.all(|x| x.is_ascii_alphanumeric() || "._:-".contains(x))
}
/// `String(v)` of JavaScript; `undefined` (a missing value) is the empty string here, as in `String(a.x ?? "")`.
pub(crate) fn js_string(v: Option<&Json>) -> String {
	match v {
		None | Some(Json::Null) => String::new(),
		Some(v) => js_text(v),
	}
}
/// `${v}` of JavaScript for a value that is there.
pub(crate) fn js_text(v: &Json) -> String {
	match v {
		Json::Null => "null".into(),
		Json::Bool(b) => b.to_string(),
		Json::Number(n) => js_number_text(*n),
		Json::String(s) => s.clone(),
		Json::Array(a) => a.iter().map(|x| if matches!(x, Json::Null) { String::new() } else { js_text(x) }).collect::<Vec<_>>().join(","),
		Json::Object(_) => "[object Object]".into(),
	}
}
fn js_number_text(n: f64) -> String {
	if n.is_nan() { "NaN".into() } else if n.is_infinite() { if n > 0.0 { "Infinity".into() } else { "-Infinity".into() } } else { number_text(n) }
}
/// `Number(v)` of JavaScript; a missing value is NaN.
pub(crate) fn js_number(v: Option<&Json>) -> f64 {
	match v {
		None => f64::NAN,
		Some(Json::Null) => 0.0,
		Some(Json::Bool(b)) => if *b { 1.0 } else { 0.0 },
		Some(Json::Number(n)) => *n,
		Some(Json::String(s)) => {
			let t = s.trim_matches(|c: char| (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}');
			if t.is_empty() {
				return 0.0;
			}
			let radix = [("0x", 16), ("0X", 16), ("0o", 8), ("0O", 8), ("0b", 2), ("0B", 2)].iter().find(|(p, _)| t.starts_with(p));
			if let Some((p, radix)) = radix {
				let digits = &t[p.len()..];
				return if !digits.is_empty() && digits.chars().all(|c| c.is_digit(*radix)) { digits.chars().fold(0.0, |n, c| n * f64::from(*radix) + f64::from(c.to_digit(*radix).unwrap_or(0))) } else { f64::NAN };
			}
			match t {
				"Infinity" | "+Infinity" => f64::INFINITY,
				"-Infinity" => f64::NEG_INFINITY,
				_ if t.bytes().any(|b| b.is_ascii_alphabetic() && !matches!(b, b'e' | b'E')) => f64::NAN,
				_ => t.parse().unwrap_or(f64::NAN),
			}
		}
		Some(Json::Array(a)) => js_number(Some(&Json::String(js_text(&Json::Array(a.clone()))))),
		Some(Json::Object(_)) => f64::NAN,
	}
}
/// `slice(0, n)` of a JavaScript string.
pub(crate) fn cut(t: &str, n: usize) -> String { String::from_utf16_lossy(&t.encode_utf16().take(n).collect::<Vec<_>>()) }
/// A refusal the command adapters turn into a failed result: `IllegalArgumentError | TransactionError | LimitError` and their subclasses.
pub(crate) fn failed_result(e: CoreError) -> R<Json> {
	match e.class {
		"IllegalArgumentError" | "UniqueConflict" | "TransactionError" | "CompletionViolation" | "RunGateConflict" | "RunBusy" | "LimitError" | "ResourceExhausted" => Ok(obj! { "phase" => "failed", "error" => e.message }),
		_ => Err(e),
	}
}
fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| error("TypeError", "canonical JSON: non-finite number")) }
fn empty_journal() -> Json { obj! { "generation" => 0.0, "assignments" => Object::new(), "commands" => Object::new() } }
fn part<'a>(d: &'a Json, k: &str) -> Option<&'a Object> { d.get(k).and_then(Json::as_object) }
fn part_mut<'a>(d: &'a mut Json, k: &str) -> &'a mut Object { d.as_object_mut().and_then(|o| o.get_mut(k)).and_then(Json::as_object_mut).expect("the journal has its parts") }

/// `identity`: the incarnation of the control host, for the lists it signs.
pub type Identity = Box<dyn Fn() -> Local<R<Option<String>>>>;

/// Control side: the desired worker state. `setWorkers` admin commands land here; hosts read their signed share.
pub struct WorkerAssignments<E: RouterEnv> {
	pub env: E,
	pub authority_id: String,
	pub peer_id: String,
	pub signer: Rc<Signer>,
	pub identity: Option<Identity>,
}

impl<E: RouterEnv> WorkerAssignments<E> {
	pub fn new(env: E, authority_id: &str, peer_id: &str, signer: Rc<Signer>, identity: Option<Identity>) -> Self {
		WorkerAssignments { env, authority_id: authority_id.to_owned(), peer_id: peer_id.to_owned(), signer, identity }
	}
	fn journal(&self) -> R<Option<Json>> { self.env.read(JOURNAL, "") }

	/// `set`: count 0 stops every worker of the assignment after its current task; the assignment stays as the stop instruction.
	/// `a` is `{ assignmentId, hostId, kind, targetSpace, count, runId? }` as the TypeScript caller builds it.
	pub fn set(&self, command_id: &str, a: &Json) -> R<Json> {
		let id = |k: &str| text(a, k).filter(|v| valid_id(v));
		let count = a.get("count").and_then(Json::as_f64).filter(|c| safe_integer(*c) && *c >= 0.0 && *c <= MAX_COUNT);
		let run_id = a.get("runId");
		if !valid_id(command_id) || a.as_object().is_none() || [id("assignmentId"), id("hostId"), id("kind"), id("targetSpace")].iter().any(Option::is_none) || run_id.is_some_and(|r| !valid_id(&js_text(r))) || count.is_none() {
			return Err(illegal(format!("a worker assignment needs IDs, a kind, a target Space and a count 0..{}", MAX_COUNT as u32)));
		}
		let (assignment, host, count) = (id("assignmentId").unwrap_or(""), id("hostId").unwrap_or(""), count.unwrap_or(0.0));
		let mut input = obj! { "assignmentId" => assignment, "hostId" => host, "kind" => id("kind").unwrap_or(""), "targetSpace" => id("targetSpace").unwrap_or(""), "count" => count };
		if let Some(r) = run_id {
			input.as_object_mut().expect("an object").insert("runId", r.clone());
		}
		let hash = hash(&input)?;
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(JOURNAL, "", empty_journal)?;
		let d = tx.at(at);
		if let Some(old) = part(d, "commands").and_then(|c| c.get(command_id)) {
			if text(old, "hash") != Some(&hash) {
				return Err(illegal("command ID was used for another worker assignment"));
			}
			return Ok(match part(d, "assignments").and_then(|x| x.get(assignment)) {
				Some(spec) => spec.clone(),
				None => {
					let mut spec = input;
					spec.as_object_mut().expect("an object").insert("generation", old.get("generation").cloned().unwrap_or(Json::Null));
					spec
				}
			});
		}
		let assignments = part(d, "assignments").cloned().unwrap_or_default();
		let prior = assignments.get(assignment);
		if prior.is_some_and(|p| text(p, "hostId") != Some(host)) {
			return Err(conflict("an assignment keeps its host; stop it and create another"));
		}
		if prior.is_none() && (assignments.len() >= MAX_ASSIGNMENTS || assignments.iter().filter(|(_, x)| text(x, "hostId") == Some(host)).count() >= MAX_PER_HOST) {
			return Err(exhausted("worker assignment directory is full"));
		}
		if part(d, "commands").is_some_and(|c| c.len() >= MAX_COMMANDS) {
			return Err(exhausted("worker command history is full"));
		}
		let generation = d.get("generation").and_then(Json::as_f64).unwrap_or(0.0) + 1.0;
		d.as_object_mut().expect("an object").insert("generation", generation.into());
		let mut spec = input;
		spec.as_object_mut().expect("an object").insert("generation", generation.into());
		part_mut(d, "assignments").insert(assignment, spec.clone());
		part_mut(d, "commands").insert(command_id, obj! { "hash" => hash, "generation" => generation });
		tx.commit()?;
		Ok(spec)
	}

	/// `forHost`: the signed list of one host. `host_id` must come from the authenticated connection, never from the request.
	pub async fn for_host(&self, host_id: &str) -> R<Json> {
		let d = self.journal()?;
		let incarnation = match &self.identity {
			Some(identity) => identity().await?,
			None => None,
		};
		let mut mine: Vec<Json> = d.as_ref().and_then(|d| part(d, "assignments")).map(|a| a.iter().filter(|(_, x)| text(x, "hostId") == Some(host_id)).map(|(_, x)| x.clone()).collect()).unwrap_or_default();
		mine.sort_by(|x, y| phi_json::utf16_cmp(text(x, "assignmentId").unwrap_or(""), text(y, "assignmentId").unwrap_or("")));
		let generation = d.as_ref().and_then(|d| d.get("generation")).cloned().unwrap_or(Json::Number(0.0));
		let value = obj! { "authorityId" => self.authority_id.as_str(), "incarnation" => incarnation.map_or(Json::Null, Json::String), "hostId" => host_id, "generation" => generation, "assignments" => mine };
		seal("value", value, "worker-assignments", &self.peer_id, &self.signer).ok_or_else(|| error("TypeError", "canonical JSON: non-finite number"))
	}

	/// `list`: every assignment, and the generation.
	pub fn list(&self) -> R<Json> {
		let d = self.journal()?;
		let all: Vec<Json> = d.as_ref().and_then(|d| part(d, "assignments")).map(|a| a.iter().map(|(_, x)| x.clone()).collect()).unwrap_or_default();
		Ok(obj! { "generation" => d.as_ref().and_then(|d| d.get("generation")).cloned().unwrap_or(Json::Number(0.0)), "assignments" => all })
	}
}

/// `appliedWorkers`: the applied worker state per host, read from the Capability entries of the control Space (may be stale: see `at`).
pub fn applied_workers(control: &Space, now: f64) -> R<Json> {
	let found = control.list(now, &Template::from_json(Some(&obj! { "type" => "Capability" }))?, None, None, None)?;
	let mut out: Vec<(String, f64, Json)> = vec![];
	for e in found.as_array().map(Vec::as_slice).unwrap_or(&[]) {
		let Some(f) = e.get("fields") else { continue };
		let (Some(host), Some(w)) = (text(f, "hostId"), f.get("metrics").and_then(|m| m.get("workers")).filter(|w| truthy(Some(w)) && matches!(w, Json::Object(_) | Json::Array(_)))) else { continue };
		let at = js_number(f.get("at"));
		match out.iter_mut().find(|(h, _, _)| h == host) {
			Some(had) => {
				if had.1 < at {
					*had = (host.to_owned(), at, w.clone());
				}
			}
			None => out.push((host.to_owned(), at, w.clone())),
		}
	}
	let mut o = Object::new();
	for (host, at, w) in out {
		o.insert(host, obj! { "at" => if at.is_finite() { Json::Number(at) } else { Json::Null }, "workers" => w });
	}
	Ok(Json::Object(o))
}

pub const WORKER_COMMANDS: [&str; 2] = ["setWorkers", "listWorkers"];

/// `workerCommands`: the `setWorkers` and `listWorkers` admin commands; refusals become failed results. `applied` is the
/// last applied state per host (`applied_workers` over the control Space), `{}` without one.
pub fn worker_commands<E: RouterEnv>(w: &WorkerAssignments<E>, applied: Option<&dyn Fn() -> R<Json>>, kind: &str, command_id: &str, args: &Json) -> R<Json> {
	match kind {
		"listWorkers" => {
			let mut d = w.list()?;
			let applied = match applied {
				Some(f) => f()?,
				None => Json::Object(Object::new()),
			};
			d.as_object_mut().expect("an object").insert("applied", applied);
			Ok(d)
		}
		"setWorkers" => {
			let s = |k: &str| js_string(args.get(k));
			let mut a = obj! { "assignmentId" => s("assignmentId"), "hostId" => s("hostId"), "kind" => s("kind"), "targetSpace" => s("targetSpace"), "count" => js_number(args.get("count")) };
			if let Some(r) = args.get("runId").filter(|r| !r.is_null()) {
				a.as_object_mut().expect("an object").insert("runId", js_text(r).into());
			}
			w.set(command_id, &a).or_else(failed_result)
		}
		_ => Err(illegal(format!("unknown worker command {kind}"))),
	}
}
