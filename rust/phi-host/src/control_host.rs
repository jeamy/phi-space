//! What a control host answers its Members and routers (src/runtime.ts): their keys, the routing policy under its signature, and the
//! capability directory. Grants, pairing and the supervisor have their own modules.
use crate::auth::{to_base64, Signer};
use crate::capability::publish;
use crate::control::{answered, fields, listed, refuse, CONTROL_SPACE};
use crate::gate::Now;
use crate::grants::GrantVerifier;
use crate::run_member::algorithm_name;
use phi_core::space::{error, CoreError};
use phi_json::{obj, Json, Object};
use phi_service::{Identity, Service};
use std::collections::HashMap;

type R<T> = Result<T, CoreError>;
const ROUTING: &str = "phi-spaces.federation-routing";
const MAX_REPORT: usize = 16384;
fn denied(m: impl Into<String>) -> CoreError { error("PermissionError", m) }
fn text<'a>(v: &'a Json, k: &str) -> Option<&'a str> { v.get(k).and_then(Json::as_str) }

pub struct ControlHost {
	pub peer_id: String,
	pub control_space: String,
	pub signer: Signer,
	pub grants: GrantVerifier,
	/// `hostForPeer`: which host a peer publishes for.
	pub hosts: HashMap<String, String>,
	pub now: Now,
}

fn has(id: &Identity, roles: &[&str]) -> bool { id.roles.iter().any(|r| roles.contains(&r.as_str())) }

/// `validate` of a capability report.
fn valid_report(r: &Json) -> bool {
	let host = text(r, "hostId").is_some_and(|h| !h.is_empty() && h.encode_utf16().count() <= 128);
	let objects = ["resources", "metrics"].iter().all(|k| r.get(k).is_some_and(|v| v.as_object().is_some()));
	let names = ["tools", "models"].iter().all(|k| r.get(k).and_then(Json::as_array).is_some_and(|a| a.iter().all(|n| n.as_str().is_some_and(|n| !n.is_empty() && n.encode_utf16().count() <= 128))));
	host && objects && names && r.to_json_text().len() <= MAX_REPORT
}

impl ControlHost {
	/// `key`: the proven key of this connection, while it is active, with its roles.
	pub fn handle(&self, service: &mut Service, method: &str, call: &Json, id: &Identity, key: Option<(&str, &[String])>, proven: bool) -> Json {
		let done = match method {
			"keyLookup" => return self.key_lookup(service, call, id, key, proven),
			"routingPolicy" => self.policy(service, call, id, key),
			_ => self.heartbeat(service, call, id, key),
		};
		// a connection that lost its proof with a restart proves again on this answer
		done.map_or_else(|e| if proven { refuse(&e.message) } else { obj! { "ok" => false, "error" => obj! { "code" => "ProofRequired", "message" => e.message } } }, answered)
	}

	fn key_lookup(&self, service: &mut Service, call: &Json, id: &Identity, key: Option<(&str, &[String])>, proven: bool) -> Json {
		if key.is_none() || !has(id, &["host", "admin", "router"]) {
			let code = if proven { "PermissionDenied" } else { "ProofRequired" };
			return obj! { "ok" => false, "error" => obj! { "code" => code, "message" => "key lookup requires a currently proven service host or admin" } };
		}
		let args = call.get("args");
		let (Some(peer), Some(key_id)) = (args.and_then(|a| text(a, "peerId")), args.and_then(|a| text(a, "keyId"))) else {
			return obj! { "ok" => false, "error" => obj! { "code" => "BadRequest", "message" => "peerId and keyId required" } };
		};
		let now = (self.now)();
		let found = service.store.reader(Some(CONTROL_SPACE)).ok().and_then(|h| listed(&h.space, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => key_id } }).ok());
		answered(found.and_then(|f| f.first().map(fields)).unwrap_or(Json::Null))
	}

	fn checked(&self, call: &Json, id: &Identity, method: &str, proof: Option<&str>) -> R<crate::grants::Decision> {
		let as_call = obj! { "method" => method, "space" => CONTROL_SPACE };
		let now = (self.now)();
		let decision = self.grants.check(call.get("frame").and_then(|f| f.get("grant")), id, &as_call, Some(proof), now).map_err(denied)?;
		decision.check(now).map_err(denied)?;
		Ok(decision)
	}

	/// `routingPolicy`: the installed policy, signed now.
	fn policy(&self, service: &mut Service, call: &Json, id: &Identity, key: Option<(&str, &[String])>) -> R<Json> {
		let Some((key_id, _)) = key.filter(|_| has(id, &["host", "router", "admin"])) else { return Err(denied("policy requires proven service peer")) };
		self.checked(call, id, "hello", Some(key_id))?;
		let state = service.store.stored_document(ROUTING, Some(&self.control_space)).map_err(|e| error("Unavailable", e.to_string()))?;
		let policy = state.as_ref().and_then(|s| s.get("policy")).filter(|p| !p.is_null()).ok_or_else(|| error("RoutingConflict", "no federation policy installed"))?;
		let bytes = format!("phi-spaces/federation-policy/v1\n{}", policy.canonical().map_err(|_| denied("a policy that cannot be signed"))?);
		let mut o = Object::new();
		o.insert("policy", policy.clone());
		o.insert("issuer", self.peer_id.as_str().into());
		o.insert("algorithm", algorithm_name(self.signer.algorithm()).into());
		o.insert("signature", to_base64(&self.signer.sign(bytes.as_bytes())).into());
		Ok(Json::Object(o))
	}

	/// `capabilityHeartbeat`: peer and roles come from the connection, never from the report.
	fn heartbeat(&self, service: &mut Service, call: &Json, id: &Identity, key: Option<(&str, &[String])>) -> R<Json> {
		let Some((key_id, _)) = key.filter(|(_, roles)| roles.iter().any(|r| r == "host") && has(id, &["host"])) else { return Err(denied("capability requires a currently proven host")) };
		let decision = self.checked(call, id, "write", Some(key_id))?;
		if !decision.roles.iter().any(|r| r == "host") {
			return Err(denied("capability grant does not authorize host publication"));
		}
		let report = call.get("args").and_then(|a| a.get("report")).filter(|r| valid_report(r)).ok_or_else(|| error("IllegalArgumentError", "invalid capability report"))?;
		let peer = text(&id.principal, "peerId").unwrap_or("");
		if self.hosts.get(peer).map_or(peer, String::as_str) != text(report, "hostId").unwrap_or("") {
			return Err(denied("only the associated proven host publishes its capability"));
		}
		publish(service, &self.control_space, report)
	}
}
