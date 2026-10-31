//! The control space: pairing (src/enroll.ts), the rules of the wire around it and the supervisor (src/supervisor.ts).
//! Every effect is one commit on the control space. The plain token lives in `Enrolling::enroll` only; what is stored is
//! its hash. The commands of a remote effect (`asyncCommands`) come with their handlers.
use crate::auth::{base64, signed_text, to_base64, verify_detached, Algorithm, AuthState, PeerKey, Proving};
use crate::gate::Keys;
use phi_core::space::{error, CoreError, Space, Template};
use phi_json::{hex, obj, parse, Json, Object, FOREVER};
use phi_service::{Identity, Service};
use phi_store::system_random;
use sha2::{Digest, Sha256};
use std::cell::RefCell;
use std::collections::HashMap;

pub const CONTROL_SPACE: &str = "control";
pub const ENROLL_TTL_MS: f64 = 300_000.0;
pub const MAX_FAILED_ATTEMPTS: f64 = 3.0;
pub const ATTEMPT_INTERVAL_MS: f64 = 60_000.0;
pub const UNPAIRED_ROLE: &str = "unpaired";
pub const RESULT_RETENTION_MS: f64 = 7.0 * 24.0 * 3600.0 * 1000.0;
const ENROLLABLE_ROLES: [&str; 4] = ["host", "member", "observer", "router"];
const READABLE: [&str; 3] = ["Command", "Result", "PeerKey"];
const REFUSED: &str = "enrollment refused";

type R<T> = Result<T, CoreError>;

pub fn hash_token(token: &str) -> String { hex(&Sha256::digest(token.as_bytes())) }
pub fn key_fingerprint(public_key: &str) -> String { hex(&Sha256::digest(base64(public_key)))[..32].to_owned() }

pub(crate) fn illegal(m: &str) -> CoreError { error("IllegalArgumentError", m) }

/// The control space's id; made when it does not exist yet.
pub fn control_id(service: &mut Service, now: f64) -> R<String> {
	if let Some(id) = known_id(service) {
		return Ok(id);
	}
	match service.store.create_space(CONTROL_SPACE, now, system_random()) {
		Err(e) => Err(error("Unavailable", e.to_string())),
		Ok(info) => Ok(info?.get("spaceId").and_then(Json::as_str).unwrap_or_default().to_owned()),
	}
}
pub(crate) fn known_id(service: &Service) -> Option<String> {
	service.store.spaces().into_iter().find(|i| i.get("alias").and_then(Json::as_str) == Some(CONTROL_SPACE))?.get("spaceId")?.as_str().map(str::to_owned)
}

pub(crate) fn listed(s: &Space, now: f64, tmpl: &Json) -> R<Vec<Json>> {
	let t = Template::from_json(Some(tmpl))?;
	Ok(s.list(now, &t, None, None, None)?.as_array().cloned().unwrap_or_default())
}
pub(crate) fn fields(e: &Json) -> Json { e.get("fields").cloned().unwrap_or(Json::Null) }
pub(crate) fn text<'a>(v: &'a Json, k: &str) -> &'a str { v.get(k).and_then(Json::as_str).unwrap_or("") }
pub(crate) fn put(s: &mut Space, now: f64, type_name: &str, f: Json, lease: f64) -> R<()> {
	s.write(now, &obj! { "type" => type_name, "fields" => f }, None, Some(&Json::Number(lease)), None).map(|_| ())
}
/// Takes the first entry the template finds; its fields.
pub(crate) fn take(s: &mut Space, now: f64, tmpl: &Json) -> R<Option<Json>> {
	let t = Template::from_json(Some(tmpl))?;
	let p = s.probe(now, &t, None, true, None)?;
	Ok(if p.get("status").and_then(Json::as_str) == Some("found") { p.get("entry").cloned() } else { None })
}
pub(crate) fn with(rec: &Json, changes: &[(&str, Json)]) -> Json {
	let mut o = rec.as_object().cloned().unwrap_or_default();
	for (k, v) in changes {
		o.insert(*k, v.clone());
	}
	Json::Object(o)
}
fn enroll_tmpl(hash: &str) -> Json { obj! { "type" => "Enroll", "fields" => obj! { "tokenHash" => hash } } }
fn strings(list: &[String]) -> Json { Json::Array(list.iter().map(|s| s.as_str().into()).collect()) }

fn check_hash(h: &str) -> R<()> {
	if h.len() == 64 && h.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)) { Ok(()) } else { Err(illegal("tokenHash must be the SHA-256 of the token in hex")) }
}

pub struct CreateEnroll {
	pub token_hash: String,
	pub role: String,
	pub allowed_peer_id: String,
	pub scope: Vec<String>,
	pub ttl_ms: Option<f64>,
}

fn validate(o: &CreateEnroll) -> R<()> {
	check_hash(&o.token_hash)?;
	if !ENROLLABLE_ROLES.contains(&o.role.as_str()) {
		return Err(illegal(&format!("createEnroll hands out {}; an admin is paired through the bootstrap token", ENROLLABLE_ROLES.join(", "))));
	}
	if o.allowed_peer_id.is_empty() {
		return Err(illegal("a token is bound to the peer id of the device (from the management API)"));
	}
	Ok(())
}

fn new_enroll(now: f64, o: &CreateEnroll, bootstrap: bool) -> Json {
	obj! { "tokenHash" => o.token_hash.as_str(), "role" => o.role.as_str(), "scope" => strings(&o.scope), "allowedPeerId" => o.allowed_peer_id.as_str(), "expiresAt" => now + o.ttl_ms.unwrap_or(ENROLL_TTL_MS).min(ENROLL_TTL_MS), "attempts" => 0.0, "bootstrap" => bootstrap, "state" => "open" }
}

/// `createEnrollIn`: inside a commit on the control space; idempotent per hash.
pub fn create_enroll_in(s: &mut Space, now: f64, o: &CreateEnroll) -> R<Json> {
	validate(o)?;
	if let Some(have) = listed(s, now, &enroll_tmpl(&o.token_hash))?.first() {
		return Ok(fields(have));
	}
	let rec = new_enroll(now, o, false);
	put(s, now, "Enroll", rec.clone(), FOREVER)?;
	Ok(rec)
}

pub fn create_enroll(service: &mut Service, now: f64, o: &CreateEnroll) -> R<Json> {
	validate(o)?;
	let id = control_id(service, now)?;
	service.commit_on(Some(&id), |s, _| create_enroll_in(s, now, o))
}

/// The one token for the first admin. While it is unused a new call replaces it; after its use this never works again.
pub fn bootstrap_enroll(service: &mut Service, now: f64, token_hash: &str, allowed_peer_id: &str, ttl_ms: Option<f64>) -> R<Json> {
	check_hash(token_hash)?;
	if allowed_peer_id.is_empty() {
		return Err(illegal("the bootstrap token is bound to the peer id of the first admin's device"));
	}
	let id = control_id(service, now)?;
	service.commit_on(Some(&id), |s, _| {
		let marker = listed(s, now, &obj! { "type" => "Bootstrap" })?;
		if marker.first().is_some_and(|m| text(&fields(m), "state") == "closed") {
			return Err(error("BootstrapClosed", "the first admin is paired already: this host cannot bootstrap again"));
		}
		if marker.is_empty() {
			put(s, now, "Bootstrap", obj! { "state" => "open" }, FOREVER)?;
		}
		for e in listed(s, now, &obj! { "type" => "Enroll", "fields" => obj! { "bootstrap" => true, "state" => "open" } })? {
			if let Some(old) = take(s, now, &enroll_tmpl(text(&fields(&e), "tokenHash")))? {
				put(s, now, "Enroll", with(&fields(&old), &[("state", "invalid".into())]), FOREVER)?;
			}
		}
		if let Some(have) = listed(s, now, &enroll_tmpl(token_hash))?.first() {
			return Ok(fields(have));
		}
		let o = CreateEnroll { token_hash: token_hash.to_owned(), role: "admin".into(), allowed_peer_id: allowed_peer_id.to_owned(), scope: vec!["*".into()], ttl_ms };
		let rec = new_enroll(now, &o, true);
		put(s, now, "Enroll", rec.clone(), FOREVER)?;
		Ok(rec)
	})
}

/// Every active key of a peer becomes revoked; how many.
pub fn revoke_peer_keys_in(s: &mut Space, now: f64, peer_id: &str) -> R<f64> {
	let mut n = 0.0;
	for e in listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer_id } })? {
		if text(&fields(&e), "state") != "active" {
			continue;
		}
		if let Some(taken) = take(s, now, &obj! { "id" => text(&e, "id") })? {
			put(s, now, "PeerKey", with(&fields(&taken), &[("state", "revoked".into())]), FOREVER)?;
			n += 1.0;
		}
	}
	Ok(n)
}

pub fn revoke_peer_key(service: &mut Service, now: f64, peer_id: &str, key_id: &str) -> R<bool> {
	let id = control_id(service, now)?;
	service.commit_on(Some(&id), |s, _| {
		let Some(taken) = take(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer_id, "keyId" => key_id } })? else { return Ok(false) };
		put(s, now, "PeerKey", with(&fields(&taken), &[("state", "revoked".into())]), FOREVER)?;
		Ok(true)
	})
}

pub fn has_admin_key(s: &Space, now: f64, peer_id: &str) -> R<bool> {
	Ok(listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer_id } })?.iter().map(fields).any(|f| {
		text(&f, "state") == "active" && f.get("roles").and_then(Json::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some("admin")))
	}))
}

/// `PeerKey` entries of the control space as the gate's keys.
pub struct SpaceKeys {
	pub now: crate::gate::Now,
}
impl Keys for SpaceKeys {
	fn find(&self, service: &mut Service, peer_id: &str, key_id: &str) -> Option<PeerKey> {
		let id = known_id(service)?;
		let host = service.store.reader(Some(&id)).ok()?;
		let found = listed(&host.space, (self.now)(), &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer_id, "keyId" => key_id } }).ok()?;
		PeerKey::from_json(&fields(found.first()?))
	}
}

fn valid_key(algorithm: Algorithm, public_key: &str) -> bool {
	let raw = base64(public_key);
	if raw.is_empty() || to_base64(&raw) != public_key {
		return false;
	}
	match algorithm {
		Algorithm::Ed25519 => raw.len() == 32,
		Algorithm::EcdsaP256 => raw.len() > 60 && raw.len() < 200,
	}
}

pub(crate) fn refuse(message: &str) -> Json { obj! { "ok" => false, "error" => obj! { "code" => "PermissionDenied", "message" => message } } }
pub(crate) fn answered(result: Json) -> Json { obj! { "ok" => true, "result" => result } }

/// `enroll` and `enrollStatus`, for peers whose roles contain "unpaired" and for a proven key resolving its own request.
pub struct Enrolling {
	last_attempt: RefCell<HashMap<String, f64>>,
	on_event: Box<dyn Fn(&Json)>,
}

impl Enrolling {
	pub fn new(on_event: Box<dyn Fn(&Json)>) -> Enrolling { Enrolling { last_attempt: RefCell::default(), on_event } }

	fn event(&self, peer_id: &str, outcome: &str, key_id: Option<&str>) {
		let mut e = obj! { "peerId" => peer_id, "outcome" => outcome };
		if let (Json::Object(o), Some(k)) = (&mut e, key_id) {
			o.insert("keyId", k.into());
		}
		(self.on_event)(&e);
	}

	pub fn handle(&self, service: &mut Service, call: &Json, peer_id: &str, (unpaired, proven): (bool, bool), st: &mut AuthState, now: f64) -> Json {
		if !unpaired && !proven {
			return refuse("paired enrollment resolution requires a current app-key proof");
		}
		let enrolling = call.get("method").and_then(Json::as_str) == Some("enroll");
		let done = if enrolling { self.enroll(service, call, peer_id, !unpaired, st, now) } else { status(service, call, peer_id, now) };
		done.unwrap_or_else(|e| refuse(if e.class == "EnrollError" { &e.message } else { REFUSED }))
	}

	fn enroll(&self, service: &mut Service, call: &Json, peer_id: &str, replay_only: bool, st: &mut AuthState, now: f64) -> R<Json> {
		let empty = Json::Object(Object::new());
		let a = call.get("args").unwrap_or(&empty);
		let arg = |k: &str| a.get(k).and_then(Json::as_str);
		let request = call.get("request");
		let wanted = |k: &str| request.and_then(|r| r.get(k)).filter(|v| v.as_str().is_some()).cloned();
		let (Some(token), Some(public_key), Some(signature), Some(name), Some(generation), Some(request_id)) = (arg("token"), arg("publicKey"), arg("signature"), arg("algorithm"), wanted("generation"), wanted("requestId")) else { return Err(error("EnrollError", REFUSED)) };
		let token_hash = hash_token(token);
		let algorithm = Algorithm::parse(name).ok_or_else(|| error("EnrollError", REFUSED))?;
		let reference = obj! { "principal" => obj! { "peerId" => peer_id }, "generation" => generation, "requestId" => request_id };
		let challenge = Proving::consume_challenge(st, a.get("challenge"), now);
		let id = control_id(service, now)?;
		let claim_args = obj! { "tokenHash" => token_hash.as_str(), "publicKey" => public_key };
		let outcome = service.commit_on(Some(&id), |s, _| {
			let (method, deadline) = (Json::from("enroll"), Json::Number(FOREVER));
			if s.lookup(now, Some(&reference)).is_ok() {
				let ad = s.admit(now, Some(&reference), &method, &claim_args, &deadline, 1024.0).map_err(|_| error("EnrollError", REFUSED))?;
				return match ad.get("kind").and_then(Json::as_str) {
					Some("done") => Ok(obj! { "replay" => ad.get("result").cloned().unwrap_or(Json::Null) }),
					_ => Err(error("EnrollError", REFUSED)),
				};
			}
			if replay_only {
				return Err(error("EnrollError", "paired peers may only resolve existing enrollment requests"));
			}
			let failed = |reason: &str| obj! { "failed" => reason };
			{
				let mut last = self.last_attempt.borrow_mut();
				if last.get(peer_id).is_some_and(|t| now - t < ATTEMPT_INTERVAL_MS) {
					return Ok(failed("rate-limited"));
				}
				last.insert(peer_id.to_owned(), now);
				last.retain(|_, t| now - *t < ATTEMPT_INTERVAL_MS);
			}
			let Some(entry) = take(s, now, &enroll_tmpl(&token_hash))? else { return Ok(failed("unknown-token")) };
			let taken = fields(&entry);
			let attempts = taken.get("attempts").and_then(Json::as_f64).unwrap_or(0.0);
			let restore = |s: &mut Space, rec: Json| put(s, now, "Enroll", rec, FOREVER);
			if text(&taken, "state") != "open" {
				restore(s, taken)?;
				return Ok(failed("too-many-attempts"));
			}
			if text(&taken, "allowedPeerId") != peer_id {
				restore(s, taken)?;
				return Ok(failed("wrong-peer"));
			}
			if now >= taken.get("expiresAt").and_then(Json::as_f64).unwrap_or(0.0) {
				restore(s, with(&taken, &[("state", "invalid".into())]))?;
				return Ok(failed("expired"));
			}
			if attempts >= MAX_FAILED_ATTEMPTS {
				restore(s, with(&taken, &[("state", "invalid".into())]))?;
				return Ok(failed("too-many-attempts"));
			}
			let bad = match &challenge {
				None => Some("bad-challenge"),
				Some(_) if !valid_key(algorithm, public_key) => Some("bad-key"),
				Some(c) if !signed_text(c).is_some_and(|t| verify_detached(algorithm, public_key, t.as_bytes(), signature)) => Some("bad-signature"),
				Some(_) => None,
			};
			if let Some(reason) = bad {
				let n = attempts + 1.0;
				restore(s, with(&taken, &[("attempts", n.into()), ("state", if n >= MAX_FAILED_ATTEMPTS { "invalid" } else { "open" }.into())]))?;
				return Ok(failed(reason));
			}
			let key_id = key_fingerprint(public_key);
			let (role, scope) = (text(&taken, "role").to_owned(), taken.get("scope").cloned().unwrap_or(Json::Array(vec![])));
			let bootstrap = taken.get("bootstrap") == Some(&Json::Bool(true));
			restore(s, with(&taken, &[("state", "consumed".into())]))?;
			put(s, now, "PeerKey", obj! { "peerId" => peer_id, "keyId" => key_id.as_str(), "principal" => format!("enrolled:{peer_id}"), "algorithm" => name, "publicKey" => public_key, "roles" => Json::Array(vec![role.as_str().into()]), "scope" => scope.clone(), "state" => "active" }, FOREVER)?;
			if bootstrap {
				take(s, now, &obj! { "type" => "Bootstrap" })?;
				put(s, now, "Bootstrap", obj! { "state" => "closed" }, FOREVER)?;
			}
			let result = obj! { "keyId" => key_id.as_str(), "role" => role.as_str(), "peerId" => peer_id, "scope" => scope };
			let ad = s.admit(now, Some(&reference), &method, &claim_args, &deadline, 1024.0)?;
			if matches!(ad.get("kind").and_then(Json::as_str), Some("fresh" | "pending")) {
				s.decide_line(now, ad.get("key"), Some(&obj! { "state" => "done", "result" => result.clone() }))?;
			}
			Ok(obj! { "enrolled" => result })
		})?;
		if let Some(replay) = outcome.get("replay") {
			self.event(peer_id, "replayed", None);
			return Ok(answered(replay.clone()));
		}
		if let Some(reason) = outcome.get("failed").and_then(Json::as_str) {
			self.event(peer_id, reason, None);
			return Ok(if reason == "rate-limited" { obj! { "ok" => false, "error" => obj! { "code" => "ResourceExhausted", "message" => "one enrollment attempt per minute" } } } else { refuse(REFUSED) });
		}
		let result = outcome.get("enrolled").cloned().unwrap_or(Json::Null);
		self.event(peer_id, "enrolled", result.get("keyId").and_then(Json::as_str));
		Ok(answered(result))
	}
}

/// The peer's own enrollment result, by its request identity.
fn status(service: &mut Service, call: &Json, peer_id: &str, now: f64) -> R<Json> {
	let target = call.get("args").and_then(|a| a.get("targetRequest"));
	let wanted = |k: &str| target.and_then(|r| r.get(k)).filter(|v| v.as_str().is_some()).cloned();
	let (Some(generation), Some(request_id)) = (wanted("generation"), wanted("requestId")) else { return Err(error("EnrollError", REFUSED)) };
	let unknown = || answered(obj! { "state" => "unknown" });
	let Some(id) = known_id(service) else { return Ok(unknown()) };
	let s = &service.store.reader(Some(&id))?.space;
	let reference = obj! { "principal" => obj! { "peerId" => peer_id }, "generation" => generation, "requestId" => request_id };
	let Ok(v) = s.lookup(now, Some(&reference)) else { return Ok(unknown()) };
	if text(&v, "method") != "enroll" {
		return Ok(unknown());
	}
	let state = text(&v, "state");
	Ok(answered(if state == "done" { obj! { "state" => state, "result" => v.get("result").cloned().unwrap_or(Json::Object(Object::new())) } } else { obj! { "state" => state } }))
}

/// `ControlAccess`, and the supervisor where this host runs one.
pub struct Control {
	pub supervisor: Option<Supervisor>,
}

impl Control {
	/// The refusal of a call on the control space that the wire may not carry.
	pub fn check(&self, service: &Service, call: &Json, id: &Identity) -> Option<Json> {
		let method = call.get("method")?.as_str()?;
		let space = call.get("space")?.as_str()?;
		if space != CONTROL_SPACE && known_id(service).as_deref() != Some(space) {
			return None;
		}
		if ["hello", "generation", "challenge", "prove", "enroll", "enrollStatus", "pollOperation"].contains(&method) {
			return None;
		}
		let empty = Json::Object(Object::new());
		let a = call.get("args").unwrap_or(&empty);
		let type_of = a.get("template").and_then(|t| t.get("type")).and_then(Json::as_str);
		let reading = ["read", "readAll", "count"].contains(&method);
		let directory = reading && type_of.is_some_and(|t| ["Capability", "MemberStatus"].contains(&t));
		let no_txn = a.get("txn").is_none_or(|t| *t == Json::Null);
		if directory && no_txn && id.roles.iter().any(|r| ["host", "member", "observer", "admin", "router"].contains(&r.as_str())) {
			return None;
		}
		if !id.roles.iter().any(|r| r == "admin") {
			return Some(refuse("the control space is for admins who proved their key"));
		}
		match method {
			"write" if a.get("entry").and_then(|e| e.get("type")).and_then(Json::as_str) == Some("Command") => None,
			"write" => Some(refuse("an admin writes only Command entries into the control space")),
			_ if reading => match type_of {
				Some(t) if READABLE.contains(&t) => None,
				_ => Some(refuse(&format!("the control space can be read for {}", READABLE.join(", ")))),
			},
			"cancelOperation" | "lease" => None,
			other => Some(refuse(&format!("{other} is not available on the control space"))),
		}
	}
}

/// The owner of an entry is its writer's principal id (canonical JSON `[peerId, agentId]`); a plain peer id works too.
fn peer_of(owner: &str) -> String {
	if let Some(peer) = parse(owner).ok().and_then(|v| v.as_array()?.first()?.as_str().map(str::to_owned)) {
		return peer;
	}
	owner.split('/').next().unwrap_or("").to_owned()
}

/// The only writer of the control space apart from admins' `Command`s. Each command is one commit: it is taken, its effect
/// applied and its `Result` written together.
pub struct Supervisor {
	pub on_event: Box<dyn Fn(&Json)>,
}

impl Supervisor {
	/// Processes every waiting command, oldest first; how many.
	pub fn tick(&self, service: &mut Service, now: f64) -> R<usize> {
		let id = control_id(service, now)?;
		let mut n = 0;
		loop {
			let done = service.commit_on(Some(&id), |s, _| self.next(s, now))?;
			let Some(done) = done else { return Ok(n) };
			n += 1;
			(self.on_event)(&done);
		}
	}

	fn next(&self, s: &mut Space, now: f64) -> R<Option<Json>> {
		let Some(first) = listed(s, now, &obj! { "type" => "Command" })?.into_iter().next() else { return Ok(None) };
		let Some(taken) = take(s, now, &obj! { "id" => text(&first, "id") })? else { return Ok(None) };
		let f = fields(&taken);
		let owner = taken.get("owner").and_then(Json::as_str).unwrap_or("");
		let requested_by = peer_of(owner);
		let non_empty = |k: &str| f.get(k).and_then(Json::as_str).filter(|v| !v.is_empty()).map(str::to_owned);
		let command_id = non_empty("commandId").unwrap_or_else(|| text(&taken, "id").to_owned());
		let kind = non_empty("kind").unwrap_or_else(|| "?".to_owned());
		let event = |state: &str, error: Option<&str>| {
			let e = obj! { "commandId" => command_id.as_str(), "kind" => kind.as_str(), "state" => state, "requestedBy" => requested_by.as_str() };
			match error {
				Some(m) => with(&e, &[("error", m.into())]),
				None => e,
			}
		};
		if !listed(s, now, &obj! { "type" => "Result", "fields" => obj! { "commandId" => command_id.as_str() } })?.is_empty() {
			return Ok(Some(event("duplicate", None)));
		}
		let finish = |s: &mut Space, outcome: Result<Json, String>| -> R<Option<Json>> {
			let mut res = obj! { "commandId" => command_id.as_str(), "kind" => kind.as_str(), "state" => if outcome.is_ok() { "completed" } else { "failed" } };
			let (extra, message) = match outcome {
				Ok(v) => (("result", v), None),
				Err(m) => (("error", Json::from(m.as_str())), Some(m)),
			};
			res = with(&res, &[extra, ("requestedBy", requested_by.as_str().into()), ("at", now.into())]);
			put(s, now, "Result", res, RESULT_RETENTION_MS)?;
			Ok(Some(event(if message.is_some() { "failed" } else { "completed" }, message.as_deref())))
		};
		if requested_by.is_empty() || (kind != "rotateKey" && !has_admin_key(s, now, &requested_by)?) {
			return finish(s, Err("the writer of this command holds no active admin key".to_owned()));
		}
		let empty = Json::Object(Object::new());
		let args = f.get("args").filter(|a| a.as_object().is_some()).unwrap_or(&empty);
		let effect = match kind.as_str() {
			"createEnroll" => {
				let scope = args.get("scope").and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect());
				let o = CreateEnroll { token_hash: text(args, "tokenHash").to_owned(), role: text(args, "role").to_owned(), allowed_peer_id: text(args, "allowedPeerId").to_owned(), scope, ttl_ms: args.get("ttlMs").and_then(Json::as_f64) };
				create_enroll_in(s, now, &o).map(|rec| obj! { "tokenHash" => text(&rec, "tokenHash"), "role" => text(&rec, "role"), "allowedPeerId" => text(&rec, "allowedPeerId"), "expiresAt" => rec.get("expiresAt").cloned().unwrap_or(Json::Null) })
			}
			"revokePeer" => match args.get("peerId").and_then(Json::as_str).filter(|p| !p.is_empty()) {
				None => Err(illegal("revokePeer needs a peerId")),
				Some(peer) => revoke_peer_keys_in(s, now, peer).map(|n| obj! { "peerId" => peer, "revoked" => n }),
			},
			"rotateKey" => crate::rotation::rotate_key_in(s, now, args, &requested_by),
			other => return finish(s, Err(format!("unknown command {other}"))),
		};
		match effect {
			Err(e) if e.class == "ResourceExhausted" || e.class == "LimitError" => Err(e),
			Err(e) => finish(s, Err(e.message)),
			Ok(v) => finish(s, Ok(v)),
		}
	}
}
