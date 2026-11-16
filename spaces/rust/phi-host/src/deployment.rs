//! Deployment bootstrap (src/deployment.ts): a declarative config names hosts, Spaces, routing and workers by alias only. The
//! coordinator keeps the alias -> ID mapping, computes a plan against it and applies it idempotently through the Space lifecycle
//! commands and the worker assignments. An alias must be bound to an enrolled host whose Capability heartbeat is fresh; workers
//! are registered with count 0 and `startWorkers` starts them.
use crate::router::{RouterEnv, Tx};
use crate::workers::{cut, failed_result, js_number, js_string, js_text, valid_id, WorkerAssignments};
use phi_core::space::{conflict, error, exhausted, illegal, truthy, CoreError, Space, Template};
use phi_json::{digest_json, obj, safe_integer, text, Json, Object};
use phi_wire::Local;
use std::collections::HashSet;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
pub const JOURNAL: &str = "phi-spaces.deployment";
/// `CAPABILITY_LEASE_MS`.
const LEASE_MS: f64 = 120_000.0;
const MAX_JOBS: usize = 64;
const KNOWN: [&str; 10] = ["schemaVersion", "deployment", "configRevision", "coordinator", "hosts", "spaces", "routing", "workers", "mobile", "credentials"];
const SECRET_WORDS: [&str; 10] = ["token", "secret", "password", "passwd", "private", "apikey", "api_key", "bearer", "seed", "mnemonic"];

fn type_error(m: impl Into<String>) -> CoreError { error("TypeError", m) }
fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| type_error("canonical JSON: non-finite number")) }
/// `ALIAS`: `/^[a-z0-9][a-z0-9._-]{0,63}$/`.
fn valid_alias(a: &str) -> bool {
	let mut c = a.chars();
	c.next().is_some_and(|f| f.is_ascii_lowercase() || f.is_ascii_digit()) && a.chars().count() <= 64 && c.all(|x| x.is_ascii_lowercase() || x.is_ascii_digit() || "._-".contains(x))
}
/// `sub`: a stable sub-request ID of one deployment step (bounded length, valid as command ID).
fn sub(parts: &[&str]) -> R<String> { Ok(format!("dep-{}", &hash(&Json::Array(parts.iter().map(|p| Json::from(*p)).collect()))?[..40])) }
/// `JSON.stringify(v)` inside a template literal: `undefined` for a missing value.
fn stringify(v: Option<&Json>) -> String { v.map_or_else(|| "undefined".into(), Json::to_json_text) }
/// `${v}` with `undefined` for a missing value.
fn shown(v: Option<&Json>) -> String { v.map_or_else(|| "undefined".into(), js_text) }
/// `===` of two values a config may hold: primitives by value, objects never (another identity), both missing alike.
fn same(a: Option<&Json>, b: Option<&Json>) -> bool {
	match (a, b) {
		(None, None) => true,
		(Some(x), Some(y)) => !matches!(x, Json::Object(_) | Json::Array(_)) && !matches!(y, Json::Object(_) | Json::Array(_)) && x == y,
		_ => false,
	}
}
fn is_object(v: &Json) -> bool { matches!(v, Json::Object(_)) }
fn null_read(field: &str) -> CoreError { type_error(format!("Cannot read properties of null (reading '{field}')")) }
/// What V8 says when the worker port is missing.
fn no_workers() -> CoreError { type_error("Cannot read properties of undefined (reading 'set')") }
fn list_of(v: Option<&Json>) -> &[Json] { v.and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn obj_of<'a>(v: &'a Json, k: &str) -> Option<&'a Object> { v.get(k).and_then(Json::as_object) }
fn obj_mut<'a>(v: &'a mut Json, k: &str) -> &'a mut Object { v.as_object_mut().and_then(|o| o.get_mut(k)).and_then(Json::as_object_mut).expect("the document has its parts") }
use phi_json::set;

/// `/-----BEGIN [A-Z ]*PRIVATE KEY-----/`.
fn looks_like_pem(s: &str) -> bool {
	s.match_indices("-----BEGIN ").any(|(i, m)| {
		let mut p = i + m.len();
		loop {
			if s[p..].starts_with("PRIVATE KEY-----") {
				return true;
			}
			match s.as_bytes().get(p) {
				Some(b'A'..=b'Z' | b' ') => p += 1,
				_ => return false,
			}
		}
	})
}
/// `/^(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9]{16,}/`.
fn looks_like_token(s: &str) -> bool {
	["sk", "pk", "ghp", "xoxb", "xoxp"].iter().any(|prefix| {
		let Some(rest) = s.strip_prefix(prefix) else { return false };
		let Some(rest) = rest.strip_prefix(['-', '_']) else { return false };
		rest.bytes().take_while(u8::is_ascii_alphanumeric).count() >= 16
	})
}
/// `SECRET_KEY`.
fn secret_key(k: &str) -> bool {
	let lower = k.to_ascii_lowercase();
	SECRET_WORDS.iter().any(|w| lower.contains(w))
}
fn scan(v: &Json, path: &str, errors: &mut Vec<String>) {
	if let Json::String(s) = v {
		if looks_like_pem(s) || looks_like_token(s) {
			errors.push(format!("{path}: looks like a secret; keep credentials in the host secret store"));
		}
	}
	let entries: Vec<(String, &Json)> = match v {
		Json::Object(o) => o.iter().map(|(k, x)| (k.to_owned(), x)).collect(),
		Json::Array(a) => a.iter().enumerate().map(|(i, x)| (i.to_string(), x)).collect(),
		_ => vec![],
	};
	for (k, x) in entries {
		if secret_key(&k) {
			errors.push(format!("{path}.{k}: secret fields are not allowed in the config"));
		}
		scan(x, &format!("{path}.{k}"), errors);
	}
}

/// What `validateDeployment` returns: the normalized config and its hash, or the errors.
pub(crate) struct Validated {
	pub config: Option<Json>,
	pub config_hash: Option<String>,
	pub errors: Vec<String>,
}

/// `validateDeployment`: validates and normalizes a config. Every problem is listed; secrets anywhere in the file are refused.
/// `raw` is `undefined` when `None`.
pub(crate) fn validate_deployment(raw: Option<&Json>) -> R<Validated> {
	let mut errors = vec![];
	if let Some(raw) = raw {
		scan(raw, "$", &mut errors);
	}
	let Some(c) = raw.filter(|r| is_object(r)) else { return Ok(Validated { config: None, config_hash: None, errors: vec!["config must be a JSON object".into()] }) };
	for k in c.as_object().expect("an object").keys() {
		if !KNOWN.contains(&k) {
			errors.push(format!("unknown field {k}"));
		}
	}
	if c.get("schemaVersion") != Some(&Json::Number(1.0)) {
		errors.push("schemaVersion must be 1".into());
	}
	if !text(c, "deployment").is_some_and(valid_alias) {
		errors.push("deployment: lower-case alias required".into());
	}
	if c.get("configRevision").is_some_and(|r| !r.as_f64().is_some_and(|n| safe_integer(n) && n >= 1.0)) {
		errors.push("configRevision must be a positive integer".into());
	}
	let listed = |errors: &mut Vec<String>, k: &str, optional: bool| -> Vec<Json> {
		match c.get(k) {
			Some(Json::Array(a)) => a.clone(),
			None if optional => vec![],
			_ => {
				errors.push(format!("{k} must be a list"));
				vec![]
			}
		}
	};
	let hosts = listed(&mut errors, "hosts", false);
	let spaces = listed(&mut errors, "spaces", false);
	let workers = listed(&mut errors, "workers", true);
	if hosts.len() > 64 || spaces.len() > 128 || workers.len() > 128 {
		errors.push("at most 64 hosts, 128 Spaces and 128 workers".into());
	}
	let unique = |errors: &mut Vec<String>, list: &[Json], what: &str| -> HashSet<String> {
		let mut seen = HashSet::new();
		for x in list {
			let alias = x.as_object().and_then(|o| o.get("alias"));
			match alias.and_then(Json::as_str).filter(|a| truthy(Some(x)) && valid_alias(a)) {
				None => errors.push(format!("{what}: invalid alias {}", stringify(alias))),
				Some(a) if seen.contains(a) => errors.push(format!("{what}: duplicate alias {a}")),
				Some(a) => {
					seen.insert(a.to_owned());
				}
			}
		}
		seen
	};
	let host_aliases = unique(&mut errors, &hosts, "hosts");
	let _space_aliases = unique(&mut errors, &spaces, "spaces");
	unique(&mut errors, &workers, "workers");
	for h in &hosts {
		if truthy(Some(h)) && !matches!(text(h, "role"), Some("coordinator" | "member-host")) {
			errors.push(format!("hosts.{}: role must be coordinator or member-host", shown(h.get("alias"))));
		}
	}
	let coordinator = c.get("coordinator");
	if !coordinator.and_then(Json::as_str).is_some_and(|k| host_aliases.contains(k)) {
		errors.push("coordinator must name a host".into());
	} else {
		let mut found = None;
		for h in &hosts {
			if h.is_null() {
				return Err(null_read("alias"));
			}
			if same(h.get("alias"), coordinator) {
				found = Some(h);
				break;
			}
		}
		let mut odd = found.is_none_or(|h| text(h, "role") != Some("coordinator"));
		if !odd {
			let mut count = 0;
			for h in &hosts {
				if h.is_null() {
					return Err(null_read("role"));
				}
				if text(h, "role") == Some("coordinator") {
					count += 1;
				}
			}
			odd = count != 1;
		}
		if odd {
			errors.push("exactly the coordinator host has role coordinator".into());
		}
	}
	for s in &spaces {
		if !truthy(Some(s)) {
			continue;
		}
		let alias = shown(s.get("alias"));
		if !text(s, "host").is_some_and(|h| host_aliases.contains(h)) {
			errors.push(format!("spaces.{alias}: unknown host {}", shown(s.get("host"))));
		}
		if !matches!(text(s, "purpose"), Some("control" | "data")) {
			errors.push(format!("spaces.{alias}: purpose must be control or data"));
		}
		if text(s, "purpose") == Some("control") && !same(s.get("host"), coordinator) {
			errors.push(format!("spaces.{alias}: the control Space lives on the coordinator"));
		}
		if s.get("maxSpaceBytes").is_some_and(|m| !m.as_f64().is_some_and(|n| safe_integer(n) && n >= 1024.0)) {
			errors.push(format!("spaces.{alias}: maxSpaceBytes must be an integer of at least 1024"));
		}
		if s.get("limits").is_some_and(|l| !matches!(l, Json::Object(_) | Json::Null)) {
			errors.push(format!("spaces.{alias}: limits must be an object"));
		}
	}
	if spaces.iter().filter(|s| text(s, "purpose") == Some("control")).count() != 1 {
		errors.push("exactly one control Space is required".into());
	}
	let data_spaces: Vec<Option<&Json>> = spaces.iter().filter(|s| text(s, "purpose") == Some("data")).map(|s| s.get("alias")).collect();
	let is_data = |m: Option<&Json>| data_spaces.iter().any(|d| m.is_some() && same(*d, m));
	if let Some(r) = c.get("routing") {
		if r.is_null() {
			return Err(null_read("profile"));
		}
		match text(r, "profile") {
			Some("single-member-sieve") => {
				if !truthy(r.get("member")) || !is_data(r.get("member")) {
					errors.push("routing.member must name a data Space".into());
				}
			}
			Some("sieve-hrw-by-taskid") => {
				if !r.get("members").and_then(Json::as_array).is_some_and(|m| m.len() >= 2 && m.iter().all(|x| is_data(Some(x)))) {
					errors.push("routing.members must name at least two data Spaces".into());
				}
			}
			_ => errors.push("routing.profile must be single-member-sieve or sieve-hrw-by-taskid".into()),
		}
	}
	for w in &workers {
		if !truthy(Some(w)) {
			continue;
		}
		let alias = shown(w.get("alias"));
		if !text(w, "host").is_some_and(|h| host_aliases.contains(h)) {
			errors.push(format!("workers.{alias}: unknown host {}", shown(w.get("host"))));
		}
		let target = spaces.iter().find(|s| same(s.get("alias"), w.get("targetSpace")));
		match target {
			Some(t) if text(t, "purpose") == Some("data") => {
				if !same(t.get("host"), w.get("host")) {
					errors.push(format!("workers.{alias}: workers run on the host of their target Space"));
				}
			}
			_ => errors.push(format!("workers.{alias}: targetSpace must name a data Space")),
		}
		if !text(w, "kind").is_some_and(valid_id) {
			errors.push(format!("workers.{alias}: invalid kind"));
		}
		if !w.get("count").and_then(Json::as_f64).is_some_and(|n| safe_integer(n) && (0.0..=64.0).contains(&n)) {
			errors.push(format!("workers.{alias}: count must be 0..64"));
		}
		if w.get("runId").is_some_and(|r| !valid_id(&js_text(r))) {
			errors.push(format!("workers.{alias}: invalid runId"));
		}
	}
	if let Some(cr) = c.get("credentials") {
		if cr.is_null() {
			return Err(null_read("source"));
		}
		if text(cr, "source") != Some("host-secret-store") {
			errors.push("credentials.source must be host-secret-store".into());
		}
	}
	if !errors.is_empty() {
		return Ok(Validated { config: None, config_hash: None, errors });
	}
	let config = c.clone();
	let config_hash = hash(&config)?;
	Ok(Validated { config: Some(config), config_hash: Some(config_hash), errors })
}

/// What the controller asks of the rest of the control host.
pub trait DeploymentPorts {
	/// `hostStatus`: `{ fresh, at? }` of an enrolled host; an error counts as not fresh.
	fn host_status(&self, host_id: &str) -> Local<R<Json>>;
	/// `createSpace`: the admin command of the Space lifecycle (`SpaceCommands::run("create", ..)`).
	fn create_space(&self, command_id: &str, args: Json) -> Local<R<Json>>;
}

fn empty_state() -> Json { obj! { "hosts" => Object::new(), "spaces" => Object::new(), "jobs" => Object::new() } }
fn step(key: String, action: &str, status: &str, detail: String) -> Json { obj! { "key" => key, "action" => action, "status" => status, "detail" => detail } }
fn assignment_of<'a>(assigned: &'a [Json], id: &str) -> Option<&'a Json> { assigned.iter().find(|a| text(a, "assignmentId") == Some(id)) }

/// Coordinator side: alias bindings, plan, idempotent apply, worker start and export.
pub struct DeploymentController<E: RouterEnv, P: DeploymentPorts> {
	pub env: E,
	pub ports: P,
	pub workers: Option<Rc<WorkerAssignments<E>>>,
	pub control_space_id: String,
}

impl<E: RouterEnv, P: DeploymentPorts> DeploymentController<E, P> {
	pub fn new(env: E, ports: P, workers: Option<Rc<WorkerAssignments<E>>>, control_space_id: &str) -> Self {
		DeploymentController { env, ports, workers, control_space_id: control_space_id.to_owned() }
	}
	fn state(&self) -> R<Json> { Ok(self.env.read(JOURNAL, "")?.unwrap_or_else(empty_state)) }
	fn assigned(&self) -> R<Vec<Json>> {
		Ok(match &self.workers {
			Some(w) => list_of(w.list()?.get("assignments")).to_vec(),
			None => vec![],
		})
	}

	/// `bindHost`: binds a host alias to an enrolled hostId. An alias never silently moves to another host.
	pub(crate) fn bind_host(&self, alias: &str, host_id: &str) -> R<Json> {
		if !valid_alias(alias) || !valid_id(host_id) {
			return Err(illegal("bindHost needs an alias and a hostId"));
		}
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(JOURNAL, "", empty_state)?;
		let d = tx.at(at);
		if let Some(old) = obj_of(d, "hosts").and_then(|h| h.get(alias)).filter(|o| truthy(Some(o))) {
			if old.as_str() != Some(host_id) {
				return Err(conflict(format!("host alias {alias} is bound to {}", js_text(old))));
			}
		}
		if obj_of(d, "hosts").is_some_and(|h| h.iter().any(|(a, id)| id.as_str() == Some(host_id) && a != alias)) {
			return Err(conflict(format!("host {host_id} already has another alias")));
		}
		obj_mut(d, "hosts").insert(alias, host_id.into());
		tx.commit()?;
		Ok(obj! { "alias" => alias, "hostId" => host_id })
	}

	/// `plan`: what apply would do, without any effect.
	pub async fn plan(&self, raw: Option<&Json>) -> R<Json> {
		let v = validate_deployment(raw)?;
		let Some(c) = v.config else {
			let deployment = raw.and_then(|r| r.get("deployment")).filter(|d| !d.is_null()).map_or_else(|| "?".into(), js_text);
			let steps: Vec<Json> = v.errors.iter().enumerate().map(|(i, e)| step(format!("config:{i}"), "validate", "conflict", e.clone())).collect();
			return Ok(obj! { "deployment" => deployment, "configHash" => "", "ready" => false, "steps" => steps });
		};
		let st = self.state()?;
		let mut steps = vec![];
		for h in list_of(c.get("hosts")) {
			let alias = text(h, "alias").unwrap_or("");
			let Some(id) = obj_of(&st, "hosts").and_then(|x| x.get(alias)).filter(|i| truthy(Some(i))).map(js_text) else {
				steps.push(step(format!("host:{alias}"), "bind", "blocked", "host alias is not bound to an enrolled host; enroll it, then bindHost".into()));
				continue;
			};
			let s = self.ports.host_status(&id).await.unwrap_or_else(|_| obj! { "fresh" => false });
			let fresh = truthy(s.get("fresh"));
			steps.push(step(format!("host:{alias}"), "check", if fresh { "ok" } else { "blocked" }, if fresh { format!("{id} reports a fresh heartbeat") } else { format!("{id} has no fresh Capability heartbeat") }));
		}
		for s in list_of(c.get("spaces")) {
			let alias = text(s, "alias").unwrap_or("");
			let bound = obj_of(&st, "spaces").and_then(|x| x.get(alias)).filter(|b| truthy(Some(b)));
			if text(s, "purpose") == Some("control") {
				let status = if bound.is_some_and(|b| text(b, "spaceId") != Some(&self.control_space_id)) { "conflict" } else { "reuse" };
				steps.push(step(format!("space:{alias}"), "control", status, "the coordinator's control Space".into()));
				continue;
			}
			match bound {
				Some(b) if !same(b.get("host"), s.get("host")) => steps.push(step(format!("space:{alias}"), "create", "conflict", format!("alias is bound to {} on {}; Spaces do not move hosts", shown(b.get("spaceId")), shown(b.get("host"))))),
				Some(b) => steps.push(step(format!("space:{alias}"), "create", "reuse", format!("existing {}, reused unchanged", shown(b.get("spaceId"))))),
				None => steps.push(step(format!("space:{alias}"), "create", "create", format!("new Space on {}", shown(s.get("host"))))),
			}
		}
		if let Some(r) = c.get("routing").filter(|r| truthy(Some(r))) {
			steps.push(step("routing".into(), "policy", "skip", format!("profile {}: membership and policy are applied with addMember/setPolicy (not part of this bootstrap)", shown(r.get("profile")))));
		}
		let assigned = self.assigned()?;
		let deployment = text(&c, "deployment").unwrap_or("");
		for w in list_of(c.get("workers")) {
			let alias = text(w, "alias").unwrap_or("");
			let key = format!("worker:{alias}");
			if self.workers.is_none() {
				steps.push(step(key, "register", "blocked", "no worker assignment directory configured".into()));
				continue;
			}
			let old = assignment_of(&assigned, &format!("{deployment}.{alias}"));
			let target = obj_of(&st, "spaces").and_then(|x| x.get(text(w, "targetSpace").unwrap_or(""))).and_then(|t| t.get("spaceId"));
			let host = obj_of(&st, "hosts").and_then(|x| x.get(text(w, "host").unwrap_or("")));
			match old {
				None => steps.push(step(key, "register", "create", format!("{} on {}, registered with count 0; startWorkers sets {}", shown(w.get("kind")), shown(w.get("host")), shown(w.get("count"))))),
				Some(o) if same(o.get("hostId"), host) && same(o.get("kind"), w.get("kind")) && same(o.get("targetSpace"), target) && same(o.get("runId"), w.get("runId")) => {
					steps.push(step(key, "register", "reuse", format!("unchanged definition; current count {} is kept", shown(o.get("count")))));
				}
				Some(o) if js_number(o.get("count")) > 0.0 => steps.push(step(key, "register", "conflict", format!("definition changed while {} workers run; stop them (count 0) first", shown(o.get("count"))))),
				Some(_) => steps.push(step(key, "register", "create", "stopped assignment gets the new definition with count 0".into())),
			}
		}
		let ready = !steps.iter().any(|s| matches!(text(s, "status"), Some("blocked" | "conflict")));
		Ok(obj! { "deployment" => deployment, "configHash" => v.config_hash.unwrap_or_default(), "ready" => ready, "steps" => steps })
	}

	/// `apply`: applies a config once per deployment and config hash; a repeated apply resumes the same job. Steps use stable
	/// sub-request IDs, so an unknown outcome is resolved by repeating them. A blocked or conflicting plan changes nothing.
	pub async fn apply(&self, raw: Option<&Json>) -> R<Json> {
		let plan = self.plan(raw).await?;
		let v = validate_deployment(raw)?;
		let Some(c) = v.config else {
			return Ok(obj! { "deployment" => plan.get("deployment").cloned().unwrap_or(Json::Null), "configHash" => "", "state" => "blocked", "steps" => Object::new(), "plan" => plan });
		};
		let config_hash = v.config_hash.unwrap_or_default();
		let key = text(&c, "deployment").unwrap_or("").to_owned();
		let job = {
			let mut tx = Tx::new(&self.env);
			let at = tx.doc(JOURNAL, "", empty_state)?;
			let d = tx.at(at);
			let old = obj_of(d, "jobs").and_then(|j| j.get(&key)).cloned();
			let other = old.as_ref().is_some_and(|o| text(o, "configHash") != Some(&config_hash));
			if other && old.as_ref().is_some_and(|o| text(o, "state") == Some("applying")) {
				return Err(conflict(format!("deployment {key} is still applying another config; repeat it until it completes or blocks")));
			}
			if old.is_none() || other {
				if obj_of(d, "jobs").is_some_and(|j| j.len() >= MAX_JOBS) && old.is_none() {
					return Err(exhausted("deployment journal is full"));
				}
				obj_mut(d, "jobs").insert(key.as_str(), obj! { "deployment" => key.as_str(), "configHash" => config_hash.as_str(), "config" => c.clone(), "state" => "applying", "steps" => Object::new(), "at" => self.env.now() });
			}
			let job = obj_of(d, "jobs").and_then(|j| j.get(&key)).cloned().unwrap_or(Json::Null);
			tx.commit()?;
			job
		};
		let job_hash = text(&job, "configHash").unwrap_or("").to_owned();
		let steps_of = |j: &Json| j.get("steps").cloned().unwrap_or_else(|| Json::Object(Object::new()));
		if text(&job, "state") == Some("completed") {
			return Ok(obj! { "deployment" => key.as_str(), "configHash" => job_hash, "state" => "completed", "steps" => steps_of(&job) });
		}
		if !truthy(plan.get("ready")) {
			self.record(&key, &job_hash, |j, _| {
				set(j, "state", "blocked");
				Ok(())
			})?;
			return Ok(obj! { "deployment" => key.as_str(), "configHash" => job_hash, "state" => "blocked", "steps" => steps_of(&job), "plan" => plan });
		}
		let st = self.state()?;
		let done = |step: &str| job.get("steps").and_then(|s| s.get(step)).and_then(|s| text(s, "status")) == Some("done");
		for s in list_of(c.get("spaces")) {
			let alias = text(s, "alias").unwrap_or("");
			let host = text(s, "host").unwrap_or("");
			let step = format!("space:{alias}");
			if done(&step) {
				continue;
			}
			if text(s, "purpose") == Some("control") {
				self.space(&key, &job_hash, alias, host, &self.control_space_id, &step, None)?;
				continue;
			}
			let mut limits = s.get("limits").and_then(Json::as_object).cloned().unwrap_or_default();
			if let Some(m) = s.get("maxSpaceBytes").filter(|m| truthy(Some(m))) {
				limits.insert("maxSpaceBytes", m.clone());
			}
			let mut args = obj! { "hostId" => obj_of(&st, "hosts").and_then(|h| h.get(host)).cloned().unwrap_or(Json::Null), "alias" => alias };
			if !limits.is_empty() {
				set(&mut args, "limits", limits);
			}
			if let Some(p) = s.get("profiles").filter(|p| truthy(Some(p))) {
				set(&mut args, "profiles", p.clone());
			}
			let r = self.ports.create_space(&sub(&[&key, &job_hash, "space", alias])?, args).await?;
			let space_id = text(&r, "spaceId").map(str::to_owned);
			let Some(space_id) = space_id.filter(|_| text(&r, "phase") != Some("failed")) else {
				let message = r.get("error").filter(|e| !e.is_null()).map_or_else(|| "no spaceId".into(), js_text);
				self.record(&key, &job_hash, |j, _| {
					obj_mut(j, "steps").insert(step.as_str(), obj! { "status" => "failed", "error" => cut(&message, 512) });
					set(j, "state", "blocked");
					Ok(())
				})?;
				return self.view(&key);
			};
			self.space(&key, &job_hash, alias, host, &space_id, &step, Some(r))?;
		}
		let bound = self.state()?.get("spaces").cloned().unwrap_or(Json::Null);
		let assigned = self.assigned()?;
		for w in list_of(c.get("workers")) {
			let alias = text(w, "alias").unwrap_or("");
			let step = format!("worker:{alias}");
			if done(&step) {
				continue;
			}
			let host = obj_of(&st, "hosts").and_then(|h| h.get(text(w, "host").unwrap_or("")));
			let target = bound.get(text(w, "targetSpace").unwrap_or("")).and_then(|t| t.get("spaceId"));
			let old = assignment_of(&assigned, &format!("{key}.{alias}"));
			if let Some(o) = old.filter(|o| same(o.get("hostId"), host) && same(o.get("kind"), w.get("kind")) && same(o.get("targetSpace"), target) && same(o.get("runId"), w.get("runId"))) {
				let o = o.clone();
				self.record(&key, &job_hash, |j, _| {
					obj_mut(j, "steps").insert(step.as_str(), obj! { "status" => "done", "result" => o.clone() });
					Ok(())
				})?; // running workers keep their count
				continue;
			}
			let mut a = obj! { "assignmentId" => format!("{key}.{alias}"), "hostId" => host.cloned().unwrap_or(Json::Null), "kind" => w.get("kind").cloned().unwrap_or(Json::Null), "targetSpace" => target.cloned().unwrap_or(Json::Null), "count" => 0.0 };
			if let Some(r) = w.get("runId").filter(|r| truthy(Some(r))) {
				set(&mut a, "runId", r.clone());
			}
			let workers = self.workers.as_ref().ok_or_else(no_workers)?;
			let spec = workers.set(&sub(&[&key, &job_hash, "worker", alias])?, &a)?;
			self.record(&key, &job_hash, |j, _| {
				obj_mut(j, "steps").insert(step.as_str(), obj! { "status" => "done", "result" => spec.clone() });
				Ok(())
			})?;
		}
		if c.get("routing").is_some_and(|r| truthy(Some(r))) {
			self.record(&key, &job_hash, |j, _| {
				obj_mut(j, "steps").insert("routing", obj! { "status" => "skipped", "error" => "membership and policy are separate admin commands" });
				Ok(())
			})?;
		}
		self.record(&key, &job_hash, |j, _| {
			set(j, "state", "completed");
			Ok(())
		})?;
		self.view(&key)
	}
	/// `space`: binds the alias and marks its step done.
	#[allow(clippy::too_many_arguments)]
	fn space(&self, key: &str, hash: &str, alias: &str, host: &str, space_id: &str, step: &str, result: Option<Json>) -> R<()> {
		self.record(key, hash, |j, all| {
			if let Some(old) = obj_of(all, "spaces").and_then(|s| s.get(alias)).filter(|o| truthy(Some(o))) {
				if text(old, "spaceId") != Some(space_id) || text(old, "host") != Some(host) {
					return Err(conflict(format!("Space alias {alias} is bound to {}", shown(old.get("spaceId")))));
				}
			}
			obj_mut(all, "spaces").insert(alias, obj! { "host" => host, "spaceId" => space_id });
			obj_mut(j, "steps").insert(step, obj! { "status" => "done", "result" => result.unwrap_or_else(|| obj! { "spaceId" => space_id }) });
			Ok(())
		})
	}
	/// `record`: one commit on the job, as long as it is still the one the hash names.
	fn record(&self, key: &str, hash: &str, f: impl FnOnce(&mut Json, &mut Json) -> R<()>) -> R<()> {
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(JOURNAL, "", empty_state)?;
		let d = tx.at(at);
		let mut job = obj_of(d, "jobs").and_then(|j| j.get(key)).cloned().filter(|j| truthy(Some(j)) && text(j, "configHash") == Some(hash)).ok_or_else(|| conflict("deployment job changed"))?;
		f(&mut job, d)?;
		obj_mut(d, "jobs").insert(key, job);
		tx.commit()
	}
	fn view(&self, key: &str) -> R<Json> {
		let st = self.state()?;
		let j = obj_of(&st, "jobs").and_then(|j| j.get(key)).cloned().unwrap_or(Json::Null);
		Ok(obj! { "deployment" => key, "configHash" => j.get("configHash").cloned().unwrap_or(Json::Null), "state" => j.get("state").cloned().unwrap_or(Json::Null), "steps" => j.get("steps").cloned().unwrap_or(Json::Null) })
	}

	/// `startWorkers`: starts (or rescales) the registered workers of a completed deployment to their configured counts.
	pub(crate) fn start_workers(&self, command_id: &str, deployment: &str) -> R<Json> {
		if !valid_id(command_id) {
			return Err(illegal("invalid command ID"));
		}
		let st = self.state()?;
		let job = obj_of(&st, "jobs").and_then(|j| j.get(deployment)).filter(|j| truthy(Some(j)) && text(j, "state") == Some("completed")).ok_or_else(|| conflict(format!("deployment {deployment} is not completed")))?;
		let mut out = vec![];
		for w in list_of(job.get("config").and_then(|c| c.get("workers"))) {
			let alias = text(w, "alias").unwrap_or("");
			let host = obj_of(&st, "hosts").and_then(|h| h.get(text(w, "host").unwrap_or(""))).cloned().unwrap_or(Json::Null);
			let target = obj_of(&st, "spaces").and_then(|s| s.get(text(w, "targetSpace").unwrap_or(""))).and_then(|t| t.get("spaceId")).cloned().unwrap_or(Json::Null);
			let mut a = obj! { "assignmentId" => format!("{deployment}.{alias}"), "hostId" => host, "kind" => w.get("kind").cloned().unwrap_or(Json::Null), "targetSpace" => target, "count" => w.get("count").cloned().unwrap_or(Json::Null) };
			if let Some(r) = w.get("runId").filter(|r| truthy(Some(r))) {
				set(&mut a, "runId", r.clone());
			}
			let workers = self.workers.as_ref().ok_or_else(no_workers)?;
			let spec = workers.set(&sub(&[command_id, alias])?, &a)?;
			out.push(obj! { "alias" => alias, "count" => spec.get("count").cloned().unwrap_or(Json::Null), "generation" => spec.get("generation").cloned().unwrap_or(Json::Null) });
		}
		Ok(Json::Array(out))
	}

	/// `export`: the applied state for export and diff: bindings, last config per deployment and current worker counts.
	pub fn export(&self, deployment: &str) -> R<Json> {
		let st = self.state()?;
		let job = obj_of(&st, "jobs").and_then(|j| j.get(deployment)).filter(|j| truthy(Some(j)));
		let assigned = self.assigned()?;
		let workers: Vec<Json> = list_of(job.and_then(|j| j.get("config")).and_then(|c| c.get("workers"))).iter().map(|w| {
			let alias = text(w, "alias").unwrap_or("");
			let count = assignment_of(&assigned, &format!("{deployment}.{alias}")).and_then(|a| a.get("count")).filter(|c| !c.is_null()).cloned().unwrap_or(Json::Number(0.0));
			obj! { "alias" => alias, "count" => count }
		}).collect();
		let of = |k: &str| job.and_then(|j| j.get(k)).cloned().unwrap_or(Json::Null);
		Ok(obj! { "deployment" => deployment, "configHash" => of("configHash"), "state" => of("state"), "hosts" => st.get("hosts").cloned().unwrap_or(Json::Null), "spaces" => st.get("spaces").cloned().unwrap_or(Json::Null), "workers" => workers, "config" => of("config") })
	}
}

pub const DEPLOYMENT_COMMANDS: [&str; 5] = ["planDeployment", "applyDeployment", "bindHostAlias", "startWorkers", "exportDeployment"];

/// `deploymentCommands`: the admin commands for the control-space supervisor. Refusals become failed results; plans are read-only.
pub async fn deployment_commands<E: RouterEnv, P: DeploymentPorts>(d: &DeploymentController<E, P>, kind: &str, command_id: &str, args: &Json) -> R<Json> {
	let s = |k: &str| js_string(args.get(k));
	let r = match kind {
		"planDeployment" => d.plan(args.get("config")).await,
		"applyDeployment" => d.apply(args.get("config")).await,
		"bindHostAlias" => d.bind_host(&s("alias"), &s("hostId")),
		"startWorkers" => d.start_workers(command_id, &s("deployment")),
		"exportDeployment" => d.export(&s("deployment")),
		_ => return Err(illegal(format!("unknown deployment command {kind}"))),
	};
	r.or_else(failed_result)
}

/// `capabilityHostStatus`: fresh while the host's newest Capability heartbeat in the control Space is within its lease.
pub fn capability_host_status(control: &Space, now: f64, host_id: &str) -> R<Json> {
	let found = control.list(now, &Template::from_json(Some(&obj! { "type" => "Capability", "fields" => obj! { "hostId" => host_id } }))?, None, None, None)?;
	let mut at = f64::NEG_INFINITY;
	for e in list_of(Some(&found)) {
		let n = js_number(e.get("fields").and_then(|f| f.get("at")));
		at = if n.is_nan() || at.is_nan() { f64::NAN } else { at.max(n) };
	}
	Ok(if at.is_finite() { obj! { "fresh" => now - at < LEASE_MS, "at" => at } } else { obj! { "fresh" => false } })
}
