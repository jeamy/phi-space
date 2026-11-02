//! R6b step 0 of docs/rust-portierung.en.md: the signed texts of test/vectors/replication.json. Each text is rebuilt here from its
//! value (domain tag + canonical JSON), signed with the same ed25519 key, and must come out as TypeScript wrote it.
use phi_host::auth::*;
use phi_json::{digest_json, parse, Json};

fn vectors() -> Json { parse(&std::fs::read_to_string("../../test/vectors/replication.json").unwrap()).unwrap() }
fn signer() -> Signer { Signer::Ed25519(ed25519_dalek::SigningKey::from_bytes(&[7; 32])) }
fn text(v: &Json, key: &str) -> String { v.get(key).and_then(Json::as_str).unwrap().to_string() }

/// The text is the domain tag and the value's canonical form; Rust signs it to the same signature, which verifies.
fn holds(name: &str, domain: &str, value: &Json, written: &str, signature: &str) {
	let rebuilt = format!("{domain}{}", value.canonical().unwrap());
	assert_eq!(rebuilt, written, "{name}: text");
	assert_eq!(to_base64(&signer().sign(rebuilt.as_bytes())), signature, "{name}: signature");
	let public = text(&vectors(), "publicKey");
	assert!(verify_detached(Algorithm::Ed25519, &public, rebuilt.as_bytes(), signature), "{name}: verifies");
	assert!(!verify_detached(Algorithm::Ed25519, &public, format!("{rebuilt} ").as_bytes(), signature), "{name}: another text does not");
}

#[test]
fn the_public_key_is_the_one_of_crypto_json() {
	assert_eq!(to_base64(ed25519_dalek::SigningKey::from_bytes(&[7; 32]).verifying_key().as_bytes()), text(&vectors(), "publicKey"));
}

#[test]
fn replica_transport_requests_and_answers() {
	let v = vectors();
	let t = v.get("replicaTransport").unwrap();
	for (name, domain) in [("request", "phi-spaces/replica-sync/v1/request\n"), ("response", "phi-spaces/replica-sync/v1/response\n"), ("refusal", "phi-spaces/replica-sync/v1/response\n")] {
		let s = t.get(name).unwrap();
		holds(name, domain, s.get("value").unwrap(), &text(s, "text"), &text(s, "signature"));
	}
	// a request names the hash of its body
	let request = t.get("request").unwrap().get("value").unwrap();
	assert_eq!(digest_json(t.get("body").unwrap()).unwrap(), text(request, "bodyHash"));
}

#[test]
fn notices_changes_transitions_and_recovery_calls() {
	let v = vectors();
	let notice = v.get("replicaConfigNotice").unwrap();
	assert_eq!(text(notice, "issuer"), text(notice.get("notice").unwrap(), "primaryReplica"), "the issuer is the notice's primary");
	holds("notice", "phi-spaces/replica-config-notice/v1\n", notice.get("notice").unwrap(), &text(&v, "replicaConfigNoticeText"), &text(notice, "signature"));
	let change = v.get("controlHostChange").unwrap();
	holds("control host change", "phi-spaces/control-host-change/v1\n", change.get("change").unwrap(), &text(&v, "controlHostChangeText"), &text(change, "signature"));
	let transition = v.get("authorityTransition").unwrap();
	holds("authority transition", "phi-spaces/recovery-authority/v1\n", transition.get("transition").unwrap(), &text(transition, "text"), &text(transition, "signature"));
	let call = v.get("recoveryCall").unwrap();
	holds("recovery call", "phi-spaces/recovery-rpc/v1\n", call.get("call").unwrap(), &text(call, "text"), &text(call, "signature"));
}

#[test]
fn a_notice_is_signed_as_typescript_signs_it() {
	let v = vectors();
	let signed = v.get("replicaConfigNotice").unwrap();
	let ours = phi_host::replica_notice::sign_notice(signed.get("notice").unwrap(), &signer());
	assert_eq!(ours.canonical().unwrap(), signed.canonical().unwrap());
}
