//! test/test-grants.test.ts, as far as it is the grant itself, and the grant of test/vectors/crypto.json.
use phi_host::auth::*;
use phi_host::grants::*;
use phi_json::{parse, Json};
use phi_service::{Identity, RolePolicy};

fn vectors() -> Json { parse(&std::fs::read_to_string("../../test/vectors/crypto.json").unwrap()).unwrap() }
fn identity(peer: &str, roles: &[&str]) -> Identity {
	Identity { principal: parse(&format!(r#"{{"peerId":"{peer}"}}"#)).unwrap(), roles: roles.iter().map(|r| r.to_string()).collect() }
}
fn signer(seed: u8) -> Signer { Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[seed; 32])) }
fn public(seed: u8) -> String { to_base64(ed25519_dalek::SigningKey::from_bytes(&[seed; 32]).verifying_key().as_bytes()) }
struct Keys(Vec<PeerKey>);
impl KeyDirectory for Keys {
	fn find(&self, peer: &str, key: &str) -> Option<PeerKey> { self.0.iter().find(|k| k.peer_id == peer && k.key_id == key).cloned() }
}
fn app_key(active: bool, roles: &[&str], scope: &[&str]) -> PeerKey {
	PeerKey { peer_id: "worker".into(), key_id: "app".into(), principal: "w".into(), algorithm: Algorithm::Ed25519, public_key: public(1), scope: Some(scope.iter().map(|s| s.to_string()).collect()), roles: roles.iter().map(|r| r.to_string()).collect(), active }
}
fn proof() -> Proof { Proof { key_id: "app".into(), principal: "w".into(), roles: vec![], scope: None, at: 0.0 } }
fn authority(keys: &Keys, allow: Option<bool>) -> GrantAuthority<'_> {
	GrantAuthority { authority_id: "authority".into(), host_id: "control".into(), signer: signer(9), keys, ttl_ms: 60_000.0, allow_a_only: allow }
}
fn verifier() -> GrantVerifier {
	GrantVerifier { authority_id: "authority".into(), issuer_host_id: "control".into(), public_key: public(9), algorithm: Algorithm::Ed25519, uncertainty_ms: 2000.0 }
}
fn call(text: &str) -> Json { parse(text).unwrap() }
const NOW: f64 = 10_000.0;
const WRITE: &str = r#"{"method":"write","space":"jobs"}"#;

#[test]
fn the_vector_grant_passes_its_verifier() {
	let v = vectors();
	let k = v.get("keys").unwrap().get("p256").unwrap().get("publicKey").unwrap().as_str().unwrap();
	let grant = v.get("grant").unwrap();
	let mut token = phi_json::Object::new();
	token.insert("grant", grant.get("grant").unwrap().clone());
	token.insert("algorithm", "ecdsa-p256".into());
	token.insert("signature", grant.get("p256").unwrap().clone());
	let g = GrantVerifier { authority_id: "auth-1".into(), issuer_host_id: "host-vector".into(), public_key: k.into(), algorithm: Algorithm::EcdsaP256, uncertainty_ms: 2000.0 };
	let d = g.check(Some(&Json::Object(token)), &identity("peer-vector", &["member", "admin"]), &call(r#"{"method":"write"}"#), Some(Some("key-1")), 1_700_000_000_000.0).unwrap();
	assert_eq!(d.roles, ["member"], "the grant narrows the identity");
	assert_eq!(d.valid_until, 1_700_000_028_000.0);
}

#[test]
fn a_changed_or_foreign_grant_is_refused() {
	let keys = Keys(vec![app_key(true, &["member"], &["jobs"])]);
	let id = identity("worker", &["member"]);
	let a = authority(&keys, None);
	let token = a.issue(Some(&id), Some(&proof()), "effect", None, NOW, [7; 16]).unwrap();
	let v = verifier();
	let ok = Some(Some("app"));
	assert!(v.check(Some(&token), &id, &call(WRITE), ok, NOW).is_ok());
	let widened = parse(&token.to_json_text().replace(r#""scope":["jobs"]"#, r#""scope":["*"]"#)).unwrap();
	assert_eq!(v.check(Some(&widened), &id, &call(WRITE), ok, NOW).unwrap_err(), "invalid grant signature");
	assert_eq!(v.check(Some(&token), &id, &call(r#"{"method":"write","space":"other"}"#), ok, NOW).unwrap_err(), "space outside grant scope");
	assert_eq!(v.check(Some(&token), &id, &call(r#"{"method":"write"}"#), ok, NOW).unwrap_err(), "space outside grant scope", "no space is default");
	assert_eq!(v.check(Some(&token), &id, &call(WRITE), Some(Some("app-2")), NOW).unwrap_err(), "grant belongs to another app key");
	assert_eq!(v.check(Some(&token), &id, &call(WRITE), Some(None), NOW).unwrap_err(), "grant belongs to another app key");
	assert_eq!(v.check(Some(&token), &identity("foreign", &["member"]), &call(WRITE), ok, NOW).unwrap_err(), "grant belongs to another principal");
	assert_eq!(v.check(None, &id, &call(WRITE), ok, NOW).unwrap_err(), "a signed control grant is required");
	let other = GrantVerifier { public_key: public(8), ..verifier() };
	assert_eq!(other.check(Some(&token), &id, &call(WRITE), ok, NOW).unwrap_err(), "invalid grant signature");
	let foreign = GrantVerifier { authority_id: "x".into(), ..verifier() };
	assert_eq!(foreign.check(Some(&token), &id, &call(WRITE), ok, NOW).unwrap_err(), "grant authority or issuer mismatch");
}

#[test]
fn time_counts_with_the_margin_and_again_at_the_commit() {
	let keys = Keys(vec![app_key(true, &["member"], &["jobs"])]);
	let id = identity("worker", &["member"]);
	let token = authority(&keys, None).issue(Some(&id), Some(&proof()), "effect", None, NOW, [7; 16]).unwrap();
	let v = verifier();
	let ok = Some(Some("app"));
	let d = v.check(Some(&token), &id, &call(WRITE), ok, NOW).unwrap();
	assert!(d.check(NOW + 57_999.0).is_ok());
	assert_eq!(d.check(NOW + 58_000.0).unwrap_err(), "grant expired before commit");
	assert!(v.check(Some(&token), &id, &call(WRITE), ok, NOW + 57_999.0).is_ok());
	assert!(v.check(Some(&token), &id, &call(WRITE), ok, NOW + 58_000.0).is_err(), "expiry minus the margin");
	assert!(v.check(Some(&token), &id, &call(WRITE), ok, NOW - 2000.0).is_ok(), "issued within the uncertainty");
	assert!(v.check(Some(&token), &id, &call(WRITE), ok, NOW - 2001.0).is_err(), "from the future");
}

#[test]
fn a_resolution_grant_cannot_create_effects() {
	let keys = Keys(vec![app_key(true, &["member"], &["jobs"])]);
	let id = identity("worker", &["member"]);
	let token = authority(&keys, None).issue(Some(&id), Some(&proof()), "resolution", None, NOW, [7; 16]).unwrap();
	let v = verifier();
	let ok = Some(Some("app"));
	for c in [r#"{"method":"txn","space":"jobs","args":{"action":"commit"}}"#, r#"{"method":"lease","space":"jobs","args":{"action":"renew"}}"#, WRITE] {
		assert_eq!(v.check(Some(&token), &id, &call(c), ok, NOW).unwrap_err(), "resolution grants cannot create effects", "{c}");
	}
	let d = v.check(Some(&token), &id, &call(r#"{"method":"txn","space":"jobs","args":{"action":"abort"}}"#), ok, NOW).unwrap();
	assert_eq!(d.roles, ["resolution"]);
	let mut policy = phi_service::Policy::new();
	policy.insert("member".into(), RolePolicy { methods: None, types: None });
	assert!(!d.can_execute_pending(&policy, "take", None));
	let effect = authority(&keys, None).issue(Some(&id), Some(&proof()), "effect", None, NOW, [7; 16]).unwrap();
	let d = v.check(Some(&effect), &id, &call(WRITE), ok, NOW).unwrap();
	assert!(d.can_execute_pending(&policy, "takeOne", None));
	policy.insert("member".into(), RolePolicy { methods: Some(vec!["read".into()]), types: Some(vec!["Job".into()]) });
	assert!(!d.can_execute_pending(&policy, "take", Some("Job")));
	assert!(d.can_execute_pending(&policy, "readAll", Some("Job")));
	assert!(!d.can_execute_pending(&policy, "read", Some("Other")));
	assert!(!d.can_execute_pending(&policy, "read", None));
}

#[test]
fn issuing_follows_the_current_identity_and_key() {
	let keys = Keys(vec![app_key(true, &["member"], &["jobs"])]);
	let a = authority(&keys, None);
	let id = identity("worker", &["member", "admin"]);
	let t = a.issue(Some(&id), Some(&proof()), "effect", None, NOW, [7; 16]).unwrap();
	assert_eq!(t.get("grant").unwrap().get("roles").unwrap().to_json_text(), r#"["member"]"#, "intersection with the key");
	assert_eq!(a.issue(None, None, "effect", None, NOW, [0; 16]).unwrap_err(), "no current overlay identity");
	assert_eq!(a.issue(Some(&identity("worker", &[])), Some(&proof()), "effect", None, NOW, [0; 16]).unwrap_err(), "no current effect rights");
	assert!(a.issue(Some(&identity("worker", &[])), Some(&proof()), "resolution", None, NOW, [0; 16]).is_ok());
	assert_eq!(a.issue(Some(&id), None, "resolution", None, NOW, [0; 16]).unwrap_err(), "resolution needs a still-active app key");
	assert_eq!(a.issue(Some(&id), None, "other", None, NOW, [0; 16]).unwrap_err(), "invalid grant purpose");
	let revoked = Keys(vec![app_key(false, &["member"], &["jobs"])]);
	assert_eq!(authority(&revoked, None).issue(Some(&id), Some(&proof()), "resolution", None, NOW, [0; 16]).unwrap_err(), "the app key is not active");
	let off = authority(&keys, Some(false));
	assert_eq!(off.issue(Some(&identity("w", &["observer"])), None, "effect", None, NOW, [0; 16]).unwrap_err(), "A-only rights remain disabled after recovery");
	let t = off.issue(Some(&identity("w", &["observer", "admin", "unpaired"])), None, "effect", None, NOW, [0; 16]).unwrap();
	assert_eq!(t.get("grant").unwrap().get("roles").unwrap().to_json_text(), r#"["unpaired"]"#);
	assert_eq!(t.get("grant").unwrap().get("scope").unwrap().to_json_text(), r#"["control"]"#);
}

#[test]
fn only_a_proven_host_names_its_agent() {
	let keys = Keys(vec![app_key(true, &["host", "member"], &["jobs"])]);
	let a = authority(&keys, None);
	let id = identity("worker", &["host", "member"]);
	let t = a.issue(Some(&id), Some(&proof()), "effect", Some("agent-1"), NOW, [7; 16]).unwrap();
	assert_eq!(t.get("grant").unwrap().get("principal").unwrap().to_json_text(), r#"{"peerId":"worker","agentId":"agent-1"}"#);
	let refused = "only a proven host may grant its own local agent namespace";
	assert_eq!(a.issue(Some(&id), None, "effect", Some("agent-1"), NOW, [7; 16]).unwrap_err(), refused);
	assert_eq!(a.issue(Some(&identity("worker", &["member"])), Some(&proof()), "effect", Some("agent-1"), NOW, [7; 16]).unwrap_err(), refused);
	assert_eq!(a.issue(Some(&id), Some(&proof()), "effect", Some("-bad"), NOW, [7; 16]).unwrap_err(), refused);
}

#[test]
fn what_a_host_signs_matches_the_vectors() {
	let v = vectors();
	let bytes = |path: &str, name: &str| -> [u8; 32] {
		let h = v.get("keys").unwrap().get(path).unwrap().get(name).unwrap().as_str().unwrap();
		std::array::from_fn(|i| u8::from_str_radix(&h[i * 2..i * 2 + 2], 16).unwrap())
	};
	let text = v.get("grant").unwrap().get("signedText").unwrap().as_str().unwrap();
	let ed = Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&bytes("ed25519", "seedHex")));
	assert_eq!(to_base64(&ed.sign(text.as_bytes())), v.get("grant").unwrap().get("ed25519").unwrap().as_str().unwrap());
	let p = Signer::EcdsaP256(p256::ecdsa::SigningKey::from_bytes(&bytes("p256", "dHex").into()).unwrap());
	let public = v.get("keys").unwrap().get("p256").unwrap().get("publicKey").unwrap().as_str().unwrap();
	assert!(verify_detached(Algorithm::EcdsaP256, public, text.as_bytes(), &to_base64(&p.sign(text.as_bytes()))));
}
