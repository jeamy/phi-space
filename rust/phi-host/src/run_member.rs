//! The Member side of remote runs (src/run-member.ts): the controller signs every RunGate command, this host checks it against
//! the pinned controller key, applies it to its own Space and signs the ACK. A replayed instruction changes nothing new,
//! because the gate answers a repeated command with its stored confirmation.
use crate::auth::{to_base64, verify_detached, Algorithm, Signer};
use phi_core::space::{error, CoreError};
use phi_json::{Json, Object};
use phi_service::Service;
use std::collections::HashMap;

type R<T> = Result<T, CoreError>;
fn denied(m: impl Into<String>) -> CoreError { error("PermissionError", m) }
fn illegal(m: impl Into<String>) -> CoreError { error("IllegalArgumentError", m) }
fn text<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }

/// A key this host trusts for one issuer.
#[derive(Clone, Debug)]
pub struct Pin {
	pub issuer: String,
	pub algorithm: Algorithm,
	pub public_key: String,
}

pub fn algorithm_name(a: Algorithm) -> &'static str {
	match a {
		Algorithm::Ed25519 => "ed25519",
		Algorithm::EcdsaP256 => "ecdsa-p256",
	}
}

fn signed_text(kind: &str, v: &Json) -> R<String> { Ok(format!("phi-spaces/run-gate-{kind}/v1\n{}", v.canonical().map_err(|_| denied(format!("invalid run gate {kind} signature")))?)) }

/// `verifyRun`.
pub fn verify_run(kind: &str, t: &Json, pin: &Pin) -> R<Json> {
	let bad = || denied(format!("invalid run gate {kind} signature"));
	let (Some(value), Some(signature)) = (t.get("value"), text(t, "signature")) else { return Err(bad()) };
	if text(t, "issuer") != Some(&pin.issuer) || text(t, "algorithm") != Some(algorithm_name(pin.algorithm)) || !verify_detached(pin.algorithm, &pin.public_key, signed_text(kind, value)?.as_bytes(), signature) {
		return Err(bad());
	}
	Ok(value.clone())
}

/// `signRun`.
pub fn sign_run(kind: &str, value: Json, issuer: &str, signer: &Signer) -> R<Json> {
	let signature = to_base64(&signer.sign(signed_text(kind, &value)?.as_bytes()));
	let mut o = Object::new();
	o.insert("value", value);
	o.insert("issuer", issuer.into());
	o.insert("algorithm", algorithm_name(signer.algorithm()).into());
	o.insert("signature", signature.into());
	Ok(Json::Object(o))
}

/// Registered host code that writes a run's tasks while its gate is preparing. Never a shell command.
pub type RunPreparer = Box<dyn Fn(&mut Service, &Json, &str) -> R<()>>;

/// `tasksPreparer`: the preparer of a configured host, the tasks a run's own manifest names, each bound to the run. Idempotent.
pub fn tasks_preparer(service: &mut Service, run: &Json, space: &str) -> R<()> {
	let tasks = run.get("config").and_then(|c| c.get("tasks")).and_then(Json::as_array).filter(|t| t.len() <= 64).ok_or_else(|| illegal("a tasks run names at most 64 tasks"))?;
	let id = run.get("runId").cloned().unwrap_or(Json::Null);
	service.commit_on(Some(space), |s, now| {
		for t in tasks {
			let mut fields = t.get("fields").and_then(Json::as_object).cloned().unwrap_or_default();
			fields.insert("runId", id.clone());
			let entry = phi_json::obj! { "type" => t.get("type").cloned().unwrap_or(Json::Null), "fields" => Json::Object(fields) };
			if s.list(now, &phi_core::space::Template::from_json(Some(&entry))?, None, None, None)?.as_array().is_some_and(Vec::is_empty) {
				s.write(now, &entry, None, Some(&Json::Number(phi_json::FOREVER)), None)?;
			}
		}
		Ok(())
	})
}

/// Whether this host still holds the authority.
pub type AuthorityCheck = Box<dyn Fn(&mut Service) -> R<()>>;

/// One per host, for every local Space that takes part in controlled runs.
pub struct RunGates {
	pub authority_id: String,
	pub peer_id: String,
	pub signer: Signer,
	pub controller: Pin,
	pub preparers: HashMap<String, RunPreparer>,
	/// Before and after each effect: this host still holds the authority.
	pub assert_authority: AuthorityCheck,
}

impl RunGates {
	pub fn apply(&self, service: &mut Service, t: &Json) -> R<Json> {
		let q = verify_run("instruction", t, &self.controller)?;
		if text(&q, "authorityId") != Some(&self.authority_id) {
			return Err(denied("run gate instruction belongs to another authority"));
		}
		let space = text(&q, "spaceId").filter(|s| service.store.spaces().iter().any(|i| text(i, "spaceId") == Some(s))).ok_or_else(|| illegal("run gate instruction names no local Space"))?.to_owned();
		let kind = text(&q, "kind").unwrap_or("");
		if kind == "recover" {
			let Some(recovery) = text(&q, "recoveryId") else { return Err(illegal("recover needs a recovery ID")) };
			(self.assert_authority)(service)?;
			let o = phi_json::obj! { "runId" => q.get("runId").cloned().unwrap_or(Json::Null), "recoveryId" => recovery };
			let view = service.commit_on(Some(&space), |s, now_| s.recover_run_gate(now_, &o))?;
			(self.assert_authority)(service)?;
			return sign_run("ack", view, &self.peer_id, &self.signer);
		}
		let mut command = Object::new();
		for k in ["runId", "commandId", "kind", "revision", "recoveryId", "expect"] {
			if let Some(v) = q.get(k) {
				command.insert(k, v.clone());
			}
		}
		let command = Json::Object(command);
		let mut prepare = None;
		if kind == "prepare" {
			let spec = q.get("spec").filter(|s| s.get("runId") == q.get("runId") && s.get("members").and_then(Json::as_array).is_some_and(|m| m.iter().any(|x| x.as_str() == Some(&space)))).ok_or_else(|| illegal("prepare needs the run's manifest including this Space"))?;
			let name = text(spec, "kind").unwrap_or("");
			prepare = Some((self.preparers.get(name).ok_or_else(|| illegal(format!("no registered preparer for run kind {name}")))?, spec));
		}
		(self.assert_authority)(service)?;
		let run = text(&q, "runId").unwrap_or("").to_owned();
		let (ack, open) = service.commit_on(Some(&space), |s, now_| {
			let ack = s.apply_run_gate(now_, &command)?;
			Ok((ack, s.run_preparing(&run)))
		})?;
		if let (Some((preparer, spec)), true) = (prepare, open) {
			preparer(service, spec, &space)?; // a replay after release has nothing left to write
		}
		(self.assert_authority)(service)?;
		sign_run("ack", ack, &self.peer_id, &self.signer)
	}
}
