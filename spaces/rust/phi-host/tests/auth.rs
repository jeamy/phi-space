//! test/vectors/crypto.json and the refusals of test/test-auth.test.ts at the level of one connection.
use phi_host::auth::*;
use phi_json::Json;

fn vectors() -> Json { phi_json::parse(&std::fs::read_to_string("../../test/vectors/crypto.json").unwrap()).unwrap() }
fn at<'a>(v: &'a Json, path: &[&str]) -> &'a Json { path.iter().fold(v, |j, k| j.get(k).unwrap()) }
fn text<'a>(v: &'a Json, path: &[&str]) -> &'a str { at(v, path).as_str().unwrap() }

struct Keys(Vec<PeerKey>);
impl KeyDirectory for Keys {
	fn find(&self, peer: &str, key: &str) -> Option<PeerKey> { self.0.iter().find(|k| k.peer_id == peer && k.key_id == key).cloned() }
}
fn key(v: &Json, active: bool) -> PeerKey {
	PeerKey { peer_id: "peer-vector".into(), key_id: "k".into(), principal: "p".into(), algorithm: Algorithm::Ed25519, public_key: text(v, &["keys", "ed25519", "publicKey"]).into(), scope: None, roles: vec!["admin".into()], active }
}

#[test]
fn the_vectors_verify_and_a_changed_byte_does_not() {
	let v = vectors();
	let signed = text(&v, &["proof", "signedText"]);
	assert_eq!(signed_text(at(&v, &["proof", "challenge"])).unwrap(), signed);
	for (alg, name) in [(Algorithm::Ed25519, "ed25519"), (Algorithm::EcdsaP256, "p256")] {
		let public = text(&v, &["keys", name, "publicKey"]);
		assert!(verify_detached(alg, public, signed.as_bytes(), text(&v, &["proof", name])), "proof {name}");
		assert!(verify_detached(alg, public, text(&v, &["grant", "signedText"]).as_bytes(), text(&v, &["grant", name])), "grant {name}");
		assert!(!verify_detached(alg, public, format!("{signed} ").as_bytes(), text(&v, &["proof", name])), "changed text {name}");
		assert!(!verify_detached(alg, public, signed.as_bytes(), "AAAA"), "short signature {name}");
		assert!(!verify_detached(alg, "AAAA", signed.as_bytes(), text(&v, &["proof", name])), "short key {name}");
	}
}

#[test]
fn base64_reads_what_buffer_reads() {
	assert_eq!(base64("aGk="), b"hi");
	assert_eq!(base64("a G\nk"), b"hi");
	assert_eq!(base64("-_-_"), base64("+/+/"));
	assert_eq!(base64("aGk=aGk="), b"hi");
}

fn call(p: &Proving, st: &mut AuthState, keys: &Keys, method: &str, args: Json, now: f64) -> Json {
	p.proof(method, Some(&args), Some("peer-vector"), st, keys, (now, [1; 32]))
}
fn code(r: &Json) -> (&str, &str) { (text(r, &["error", "code"]), text(r, &["error", "message"])) }

#[test]
fn a_proof_holds_once_within_its_time_for_an_active_key() {
	let v = vectors();
	let p = Proving::new("host-vector");
	let keys = Keys(vec![key(&v, true)]);
	let proof = text(&v, &["proof", "ed25519"]);
	let prove = |c: &Json| phi_json::parse(&format!(r#"{{"keyId":"k","signature":"{proof}","challenge":{}}}"#, c.to_json_text())).unwrap();
	let vector_challenge = at(&v, &["proof", "challenge"]).clone();
	let at0 = 1_700_000_000_000.0;
	let open = phi_json::parse(r#"{"protocol":1}"#).unwrap();

	let mut st = AuthState::default();
	let bad_protocol = call(&p, &mut st, &keys, "challenge", phi_json::parse(r#"{"protocol":2}"#).unwrap(), at0);
	assert_eq!(code(&bad_protocol), ("BadRequest", "this host speaks auth protocol 1"));
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0)).1, "no open challenge: call challenge first");

	let mut st = AuthState::default();
	let r = call(&p, &mut st, &keys, "challenge", open.clone(), at0);
	let issued = at(&r, &["result"]).as_object().unwrap().clone();
	assert_eq!(issued.keys().collect::<Vec<_>>(), ["gateHostId", "observedPeerId", "connNonce", "protocol", "issuedAt", "expiresAt"]);
	assert_eq!(text(&r, &["result", "connNonce"]), text(&vector_challenge, &["connNonce"]), "the vector's nonce is 01..");
	let good = call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0 + CHALLENGE_TTL_MS);
	assert_eq!(good.get("ok"), Some(&Json::Bool(true)), "{good:?}");
	assert!(st.proof.is_some());
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0)).1, "no open challenge: call challenge first", "used once");

	let mut st = AuthState::default();
	call(&p, &mut st, &keys, "challenge", open.clone(), at0);
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0 + CHALLENGE_TTL_MS + 1.0)).1, "the challenge has expired");

	let mut st = AuthState::default();
	call(&p, &mut st, &keys, "challenge", open.clone(), at0);
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0 - 1.0)).1, "the challenge has expired");

	let revoked = Keys(vec![key(&v, false)]);
	let mut st = AuthState::default();
	call(&p, &mut st, &revoked, "challenge", open.clone(), at0);
	assert_eq!(code(&call(&p, &mut st, &revoked, "prove", prove(&vector_challenge), at0)).1, "the key is revoked");

	let none = Keys(vec![]);
	let mut st = AuthState::default();
	call(&p, &mut st, &none, "challenge", open.clone(), at0);
	assert_eq!(code(&call(&p, &mut st, &none, "prove", prove(&vector_challenge), at0)).1, "unknown key for this peer");

	let mut st = AuthState::default();
	call(&p, &mut st, &keys, "challenge", open.clone(), at0);
	let other = phi_json::parse(&vector_challenge.to_json_text().replace("host-vector", "host-other")).unwrap();
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&other), at0)).1, "this is not the challenge issued on this connection");

	let mut st = AuthState::default();
	for i in 0..5 {
		let m = code(&call(&p, &mut st, &keys, "prove", open.clone(), at0)).1.to_string();
		assert_eq!(m, "no open challenge: call challenge first", "failure {i}");
	}
	assert_eq!(code(&call(&p, &mut st, &keys, "prove", prove(&vector_challenge), at0)).1, "too many wrong proofs on this connection");
	assert_eq!(p.proof("challenge", None, None, &mut st, &keys, (at0, [1; 32])).get("error").unwrap().get("code").unwrap().as_str(), Some("Unauthenticated"));
}

#[test]
fn a_withheld_role_asks_for_a_proof() {
	let p = Proving::new("h");
	let denied = r#"{"ok":false,"error":{"code":"PermissionDenied","message":"no"}}"#.to_string();
	let admin = vec!["admin".to_string()];
	let turned = p.annotate(denied.clone(), &AuthState::default(), &admin);
	assert_eq!(turned, r#"{"ok":false,"error":{"code":"ProofRequired","message":"a proof of your app key is required for this: call challenge, then prove"}}"#);
	assert_eq!(p.annotate(denied.clone(), &AuthState::default(), &["member".to_string()]), denied);
}
