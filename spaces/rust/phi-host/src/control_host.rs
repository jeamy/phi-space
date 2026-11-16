//! What a control host answers its Members and routers (src/runtime.ts): their keys, the routing policy under its signature, and the
//! capability directory. Grants, pairing and the supervisor have their own modules.
use phi_json::text;
use phi_core::space::permission as denied;
use crate::auth::{seal, signed_by, PeerKey, Signer};
use crate::capability::publish;
use crate::control::{peer_key, answered, fields, listed, refuse, CONTROL_SPACE};
use crate::gate::Now;
use crate::grants::GrantVerifier;
use phi_core::space::{error, CoreError};
use phi_json::{obj, Json};
use phi_service::{Identity, Service};
use phi_store::{random_uuid, system_random};
use std::collections::HashMap;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
const ROUTING: &str = "phi-spaces.federation-routing";
const MAX_REPORT: usize = 16384;
const LEASE_MS: f64 = 60_000.0;
/// A different router starts only after the previous lease expired plus this clock uncertainty.
const ROUTER_CHANGE_SKEW_MS: f64 = 5_000.0;

pub struct ControlHost {
	pub peer_id: String,
	pub control_space: String,
	pub signer: Signer,
	pub public_key: String,
	pub grants: GrantVerifier,
	/// `hostForPeer`: which host a peer publishes for.
	pub hosts: HashMap<String, String>,
	pub now: Now,
	/// `controlEpoch`: the control epoch of a primary/sync main store's configuration, in place of the Space's.
	pub control_epoch: Option<Rc<dyn Fn() -> f64>>,
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
			"routerLease" => self.lease(service, call, id, key),
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
		answered(peer_key(&mut service.store, (self.now)(), peer, key_id).unwrap_or(Json::Null))
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
		self.signed("federation-policy", policy.clone(), "policy")
	}

	fn signed(&self, kind: &str, value: Json, field: &str) -> R<Json> {
		seal(field, value, kind, &self.peer_id, &self.signer).ok_or_else(|| denied("a value that cannot be signed"))
	}

	/// `RouterLeaseAuthority.issue`: the epoch rises with a new lease, a renewal keeps it. A lease from before a replica transition
	/// does not renew here: replication is R6b.
	fn lease(&self, service: &mut Service, call: &Json, id: &Identity, key: Option<(&str, &[String])>) -> R<Json> {
		let Some((key_id, roles)) = key.filter(|_| has(id, &["router"])) else { return Err(denied("lease requires proven router and configured control authority")) };
		self.checked(call, id, "generation", Some(key_id))?;
		if !roles.iter().any(|r| r == "router") {
			return Err(denied("lease requires an active router key"));
		}
		let peer = text(&id.principal, "peerId").unwrap_or("").to_owned();
		self.issue_lease(service, &peer, key_id, call.get("args").and_then(|a| a.get("renew")).filter(|r| !r.is_null()))
	}

	/// The lease itself, for a router proven here or for the Root on this host.
	pub fn issue_lease(&self, service: &mut Service, peer: &str, key_id: &str, renew: Option<&Json>) -> R<Json> {
		let authority = self.grants.authority_id.clone();
		let epoch_of = self.control_epoch.clone();
		let lease = service.commit_on(Some(&self.control_space), |s, now| {
			let counters = s.state.rest.get("authorityCounters").cloned().unwrap_or(obj! { "routerEpoch" => 0.0, "policyVersion" => 1.0 });
			let live = listed(s, now, &obj! { "type" => "RouterLease" })?.first().cloned();
			let held = live.as_ref().map(fields);
			let current = epoch_of.as_ref().map_or_else(|| s.state.rest.get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0), |f| f());
			let mut epoch = counters.get("routerEpoch").and_then(Json::as_f64).unwrap_or(0.0);
			if let Some(r) = renew {
				let names = |l: &Json| text(l, "id").is_some() && l.get("id") == r.get("id") && text(l, "routerPeerId") == Some(peer) && text(l, "routerKeyId") == Some(key_id) && l.get("routerEpoch") == r.get("routerEpoch") && l.get("controlPrimaryEpoch").and_then(Json::as_f64) == Some(current);
				let retained = r.get("token").filter(|t| t.get("lease").is_some_and(|l| signed_by(l, t, "router-lease", &self.peer_id, self.signer.algorithm(), &self.public_key) && names(l) && text(l, "authorityId") == Some(&authority) && text(l, "controlSpaceId") == Some(&self.control_space)));
				if r.get("routerEpoch").and_then(Json::as_f64) != Some(epoch) || !(retained.is_some() || held.as_ref().is_some_and(names)) {
					return Err(denied("lease renewal no longer owns current epoch"));
				}
			} else {
				if let Some(h) = held.as_ref().filter(|h| text(h, "routerPeerId") != Some(peer) || text(h, "routerKeyId") != Some(key_id)) {
					let until = h.get("expiresAt").and_then(Json::as_f64).unwrap_or(0.0) + ROUTER_CHANGE_SKEW_MS;
					if now < until {
						return Err(denied(format!("previous router lease is live until {until}")));
					}
				}
				if epoch.fract() != 0.0 || !(0.0..phi_json::FOREVER).contains(&epoch) {
					return Err(denied("router epoch overflow/corruption"));
				}
				epoch += 1.0;
			}
			let mut next = counters.as_object().cloned().unwrap_or_default();
			next.insert("routerEpoch", epoch.into());
			s.state.rest.insert("authorityCounters", Json::Object(next));
			let lease_id = match renew.and_then(|r| r.get("id")) {
				Some(i) => i.clone(),
				None => random_uuid(&mut system_random()).into(),
			};
			let result = obj! { "id" => lease_id, "routerPeerId" => peer, "routerKeyId" => key_id, "routerEpoch" => epoch, "controlSpaceId" => self.control_space.as_str(), "authorityId" => authority.as_str(), "controlPrimaryEpoch" => current, "issuedAt" => now, "expiresAt" => now + LEASE_MS };
			if let Some(l) = &live {
				s.probe(now, &phi_core::space::Template::from_json(Some(&obj! { "id" => l.get("id").cloned().unwrap_or(Json::Null) }))?, None, true, None)?;
			}
			s.write(now, &obj! { "type" => "RouterLease", "fields" => result.clone() }, None, Some(&Json::Number(LEASE_MS)), None)?;
			Ok(result)
		})?;
		self.signed("router-lease", lease, "lease")
	}

	/// `notice`: what is current, under the supervisor's signature; only for the policy installed now.
	pub fn epoch_notice(&self, service: &mut Service, policy_version: f64) -> R<Json> {
		let host = service.store.reader(Some(&self.control_space))?;
		let rest = &host.space.state.rest;
		let counters = rest.get("authorityCounters").filter(|c| c.get("policyVersion").and_then(Json::as_f64) == Some(policy_version) && policy_version > 0.0).ok_or_else(|| denied("no authoritative epoch state"))?;
		let now = (self.now)();
		let notice = obj! { "authorityId" => self.grants.authority_id.as_str(), "controlSpaceId" => self.control_space.as_str(), "routerEpoch" => counters.get("routerEpoch").cloned().unwrap_or(Json::Null), "controlPrimaryEpoch" => self.control_epoch.as_ref().map_or_else(|| rest.get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0), |f| f()), "policyVersion" => policy_version, "issuedAt" => now, "expiresAt" => now + LEASE_MS };
		self.signed("epoch-notice", notice, "notice")
	}

	/// `replicaNotice` (v3 5.3.1 step 5): a proven primary host leaves its own signed notice for the router to adopt,
	/// under a host grant, its key active before the commit and in it; every refusal is `PermissionDenied`.
	pub fn replica_notice(&self, service: &mut Service, call: &Json, id: &Identity, key: Option<&PeerKey>) -> Json {
		let done = (|| {
			let Some(key) = key.filter(|k| k.active && k.roles.iter().any(|r| r == "host") && has(id, &["host"])) else { return Err(denied("replica notices require a currently proven host")) };
			let decision = self.checked(call, id, "write", Some(&key.key_id))?;
			if !decision.roles.iter().any(|r| r == "host") {
				return Err(denied("notice grant does not authorize host publication"));
			}
			let peer = text(&id.principal, "peerId").unwrap_or("");
			let notice = call.get("args").and_then(|a| a.get("notice")).cloned().unwrap_or(Json::Null);
			let bound = notice.get("issuer").and_then(Json::as_str) == Some(self.hosts.get(peer).map_or(peer, String::as_str));
			let check = |s: &phi_core::space::Space, now: f64| -> R<()> {
				decision.check(now).map_err(denied)?;
				let current = listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => key.key_id.as_str() } })?;
				let active = current.iter().map(fields).any(|f| text(&f, "state") == Some("active") && f.get("roles").and_then(Json::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some("host"))));
				if active { Ok(()) } else { Err(error("Error", "host key no longer authorized")) }
			};
			crate::replica_notice::publish(service, &self.control_space, &notice, crate::replica_notice::Publisher { bound, roles: &decision.roles, key: Some((key.algorithm, &key.public_key)) }, &check)
		})();
		done.map_or_else(|e| refuse(&e.message), answered)
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
		let check = |s: &phi_core::space::Space, now: f64| -> R<()> {
			decision.check(now).map_err(denied)?;
			let current = listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => key_id } })?;
			let active = current.iter().map(fields).any(|f| text(&f, "state") == Some("active") && f.get("roles").and_then(Json::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some("host"))));
			if active { Ok(()) } else { Err(error("Error", "host key no longer authorized")) }
		};
		publish(service, &self.control_space, report, &check)
	}
}
