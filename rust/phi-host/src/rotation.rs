//! App-key rotation and the grants that go with it (src/rotation.ts, the `grant` call of src/runtime.ts): a persisted, one-use
//! challenge and proofs of both keys. Privileges are copied from the old key, never supplied by clients.
use crate::auth::{verify_detached, Algorithm, KeyDirectory, Proof, Signer};
use crate::control::{answered, fields, illegal, known_id, key_fingerprint, listed, put, refuse, take, text, with, CONTROL_SPACE};
use crate::grants::{Decision, GrantAuthority, GrantVerifier, MAX_TTL_MS};
use phi_core::space::{error, CoreError, Space};
use phi_json::{hex, obj, Json, FOREVER};
use phi_service::{Identity, Service};
use phi_store::system_random;
use std::rc::Rc;

pub const METHODS: [&str; 4] = ["rotationChallenge", "rotationGeneration", "rotateKey", "rotationStatus"];
const CHALLENGE_MS: f64 = 30_000.0;
const COMMAND_MS: f64 = 60_000.0;
const DOMAIN: &str = "phi-spaces/rotate/v1\n";

type R<T> = Result<T, CoreError>;
fn denied(m: impl Into<String>) -> CoreError { error("PermissionError", m) }

fn signed(c: &Json) -> R<String> { Ok(format!("{DOMAIN}{}", c.canonical().map_err(|_| denied("unknown, used or changed rotation challenge"))?)) }

fn create_challenge(s: &mut Space, now: f64, peer_id: &str, old_key_id: &str, a: &Json, nonce: &[u8]) -> R<Json> {
	let name = text(a, "algorithm");
	let public_key = text(a, "publicKey");
	if Algorithm::parse(name).is_none() || public_key.len() > 1024 {
		return Err(illegal("invalid replacement key"));
	}
	if listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer_id, "keyId" => old_key_id, "state" => "active" } })?.is_empty() {
		return Err(denied("rotation needs an active old key"));
	}
	if listed(s, now, &obj! { "type" => "Rotation", "fields" => obj! { "peerId" => peer_id } })?.len() >= 3 {
		return Err(error("ResourceExhausted", "too many open rotation challenges"));
	}
	let new_key_id = key_fingerprint(public_key);
	if new_key_id == old_key_id {
		return Err(illegal("replacement key must differ"));
	}
	let challenge = obj! { "nonce" => hex(nonce), "peerId" => peer_id, "oldKeyId" => old_key_id, "newKeyId" => new_key_id, "newAlgorithm" => name, "newPublicKey" => public_key, "issuedAt" => now, "expiresAt" => now + CHALLENGE_MS };
	put(s, now, "Rotation", with(&challenge, &[("state", "open".into())]), CHALLENGE_MS)?;
	Ok(challenge)
}

/// `rotateKeyIn`: `o` carries the challenge and both signatures.
pub fn rotate_key_in(s: &mut Space, now: f64, o: &Json, requested_by: &str) -> R<Json> {
	let null = Json::Null;
	let c = o.get("challenge").unwrap_or(&null);
	let number = |k: &str| c.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN);
	if c.as_object().is_none() || text(c, "peerId") != requested_by || number("issuedAt") > now || now >= number("expiresAt") || number("expiresAt").is_nan() {
		return Err(denied("rotation challenge owner or expiry mismatch"));
	}
	let peer = text(c, "peerId");
	let pending = listed(s, now, &obj! { "type" => "Rotation", "fields" => obj! { "nonce" => text(c, "nonce"), "state" => "open" } })?.into_iter().next();
	let same = pending.as_ref().is_some_and(|p| {
		let mut f = fields(p).as_object().cloned().unwrap_or_default();
		f.remove("state");
		Json::Object(f).canonical().ok() == c.canonical().ok()
	});
	let Some(pending) = pending.filter(|_| same) else { return Err(denied("unknown, used or changed rotation challenge")) };
	let old = listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => text(c, "oldKeyId"), "state" => "active" } })?.into_iter().next();
	let message = signed(c)?;
	let good = |algorithm: Option<Algorithm>, key: &str, signature: &str| algorithm.is_some_and(|a| verify_detached(a, key, message.as_bytes(), signature));
	let valid = old.as_ref().map(fields).is_some_and(|f| good(Algorithm::parse(text(&f, "algorithm")), text(&f, "publicKey"), text(o, "oldSignature"))) && good(Algorithm::parse(text(c, "newAlgorithm")), text(c, "newPublicKey"), text(o, "newSignature"));
	let Some(old) = old.filter(|_| valid) else { return Err(denied("rotation requires valid signatures from both keys")) };
	let new_key_id = text(c, "newKeyId");
	if !listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer, "keyId" => new_key_id } })?.is_empty() {
		return Err(denied("replacement key already exists"));
	}
	let old_fields = fields(&old);
	let cost = old_fields.to_json_text().len() * 2 + c.to_json_text().len() + 1024;
	if cost as f64 > s.limits().max_commit_bytes {
		return Err(error("ResourceExhausted", "rotation exceeds the atomic commit budget"));
	}
	// Both were listed as visible in this commit; a take that still misses would leave the old key active beside the new one.
	if take(s, now, &obj! { "id" => text(&pending, "id") })?.is_none() || take(s, now, &obj! { "id" => text(&old, "id") })?.is_none() {
		return Err(denied("rotation entries could not be consumed"));
	}
	put(s, now, "PeerKey", with(&old_fields, &[("state", "revoked".into())]), FOREVER)?;
	put(s, now, "PeerKey", with(&old_fields, &[("keyId", new_key_id.into()), ("algorithm", text(c, "newAlgorithm").into()), ("publicKey", text(c, "newPublicKey").into()), ("state", "active".into())]), FOREVER)?;
	Ok(obj! { "peerId" => peer, "oldKeyId" => text(c, "oldKeyId"), "newKeyId" => new_key_id })
}

/// The grant authority of this host and the rotation of own keys, which is what needs a grant first.
pub struct Rotating {
	authority_id: String,
	host_id: String,
	signer: Rc<Signer>,
	verifier: GrantVerifier,
}

impl Rotating {
	pub fn new(authority_id: &str, host_id: &str, signer: Signer, public_key: &str) -> Rotating {
		let verifier = GrantVerifier { authority_id: authority_id.to_owned(), issuer_host_id: host_id.to_owned(), public_key: public_key.to_owned(), algorithm: signer.algorithm(), uncertainty_ms: 2000.0 };
		Rotating { authority_id: authority_id.to_owned(), host_id: host_id.to_owned(), signer: Rc::new(signer), verifier }
	}

	/// The `grant` call.
	pub fn issue(&self, keys: &dyn KeyDirectory, id: Option<&Identity>, proof: Option<&Proof>, call: &Json, now: f64, id16: [u8; 16]) -> Result<Json, String> {
		let a = call.get("args");
		let purpose = a.and_then(|a| a.get("purpose")).and_then(Json::as_str).unwrap_or("effect");
		let agent = a.and_then(|a| a.get("agentId")).and_then(Json::as_str);
		GrantAuthority { authority_id: self.authority_id.clone(), host_id: self.host_id.clone(), signer: Rc::clone(&self.signer), keys, ttl_ms: MAX_TTL_MS, allow_a_only: None }.issue(id, proof, purpose, agent, now, id16)
	}

	/// `proven`: a proof stands on the connection; `key_id`: its key, while that is active.
	pub fn handle(&self, service: &mut Service, call: &Json, id: &Identity, proven: bool, key_id: Option<&str>, now: f64) -> Json {
		let done = self.rotation(service, call, id, proven, key_id, now);
		done.unwrap_or_else(|e| if e.class == "ResourceExhausted" { obj! { "ok" => false, "error" => obj! { "code" => "ResourceExhausted", "message" => e.message } } } else { refuse(&e.message) })
	}

	fn rotation(&self, service: &mut Service, call: &Json, id: &Identity, proven: bool, key_id: Option<&str>, now: f64) -> R<Json> {
		if !proven {
			return Err(denied("rotation requires a proven app key"));
		}
		let key_id = key_id.ok_or_else(|| denied("the app key is no longer active"))?;
		let mut scoped = call.as_object().cloned().unwrap_or_default();
		scoped.insert("space", CONTROL_SPACE.into());
		let decision = self.verifier.check(call.get("frame").and_then(|f| f.get("grant")), id, &Json::Object(scoped), Some(Some(key_id)), now).map_err(denied)?;
		let authorized = |d: &Decision| d.check(now).map_err(denied);
		authorized(&decision)?;
		let empty = obj! {};
		let a = call.get("args").unwrap_or(&empty);
		let peer = text(&id.principal, "peerId").to_owned();
		let control = known_id(service).ok_or_else(|| denied("rotation needs an active old key"))?;
		let method = call.get("method").and_then(Json::as_str).unwrap_or("");
		match method {
			"rotationGeneration" => {
				let (principal, authority, epoch) = (id.principal.clone(), service.options().authority_id.clone(), service.options().primary_epoch);
				let done = service.store.commit_keyed(Some(&control), now, |s, key| authorized(&decision).and_then(|()| s.issue_generation(now, Some(&principal), &obj! { "key" => key, "authorityId" => authority.as_str(), "primaryEpoch" => epoch })));
				Ok(answered(done.map_err(|e| error("Unavailable", e.to_string()))??.value))
			}
			"rotationChallenge" => {
				let mut nonce = [0u8; 32];
				getrandom::getrandom(&mut nonce).expect("the system gives random bytes");
				let challenge = service.commit_on(Some(&control), |s, _| {
					authorized(&decision)?;
					create_challenge(s, now, &peer, key_id, a, &nonce)
				})?;
				Ok(answered(challenge))
			}
			"rotationStatus" => {
				let s = &service.store.reader(Some(&control))?.space;
				let found = listed(s, now, &obj! { "type" => "Result", "fields" => obj! { "commandId" => a.get("commandId").cloned().unwrap_or(Json::Null), "requestedBy" => peer.as_str() } })?;
				Ok(answered(found.first().map_or_else(|| obj! { "state" => "pending" }, fields)))
			}
			_ => {
				let null = Json::Null;
				let c = a.get("challenge").unwrap_or(&null);
				if text(c, "peerId") != peer || text(c, "oldKeyId") != key_id {
					return Err(denied("rotation challenge belongs to another key"));
				}
				let wanted = |k: &str| call.get("request").and_then(|r| r.get(k)).filter(|v| v.as_str().is_some_and(|t| !t.is_empty())).cloned();
				let (Some(generation), Some(request_id)) = (wanted("generation"), wanted("requestId")) else { return Err(illegal("rotateKey requires a request identity")) };
				let reference = obj! { "principal" => id.principal.clone(), "generation" => generation, "requestId" => request_id };
				let args = obj! { "challenge" => c.clone(), "oldSignature" => a.get("oldSignature").cloned().unwrap_or(Json::Null), "newSignature" => a.get("newSignature").cloned().unwrap_or(Json::Null) };
				let result = service.commit_on(Some(&control), |s, _| {
					authorized(&decision)?;
					let ad = s.admit(now, Some(&reference), &"rotateKey".into(), &args, &Json::Number(FOREVER), 1024.0)?;
					match ad.get("kind").and_then(Json::as_str) {
						Some("done") => return Ok(ad.get("result").cloned().unwrap_or(Json::Null)),
						Some("cancelled") => return Err(error("OperationCancelled", "rotation was cancelled")),
						_ => {}
					}
					// Verified on a detached copy before a command exists: invalid requests cannot queue privileged work.
					let mut preview = Space::new(s.state.clone(), system_random());
					preview.begin_commit();
					rotate_key_in(&mut preview, now, &args, &peer)?;
					let command_id = format!("rotate:{peer}:{}", text(c, "nonce"));
					let owner = Json::Array(vec![peer.as_str().into(), Json::Null]).canonical().map_err(|_| denied("no principal"))?;
					s.write(now, &obj! { "type" => "Command", "fields" => obj! { "commandId" => command_id.as_str(), "kind" => "rotateKey", "args" => args.clone() } }, None, Some(&Json::Number(COMMAND_MS)), Some(&owner.as_str().into()))?;
					let out = obj! { "state" => "accepted", "commandId" => command_id.as_str() };
					s.decide_line(now, ad.get("key"), Some(&obj! { "state" => "done", "result" => out.clone() }))?;
					Ok(out)
				})?;
				Ok(answered(result))
			}
		}
	}
}
