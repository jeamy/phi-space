// test/vectors/canonical.json and the hash parts of crypto.json (docs/rust-portierung.md, R1): what the TypeScript code
// computed, reproduced here. The vector files are read with this crate's own parser.
use hmac::{Hmac, Mac};
use phi_json::{digest_json, hex, number_text, obj, parse, Json, Object, ParseError, parse_repairing};
use sha2::{Digest, Sha256};

fn vector(name: &str) -> Json {
	let path = format!("{}/../../test/vectors/{name}", env!("CARGO_MANIFEST_DIR"));
	// repairing: wire.json holds a call with half an emoji, on purpose
	parse_repairing(&std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("{path}: {e}"))).unwrap()
}
fn s<'a>(v: &'a Json, key: &str) -> &'a str { v.get(key).and_then(Json::as_str).unwrap_or_else(|| panic!("{key} missing")) }

#[test]
fn canonical_json_number_form_key_order_digests_and_sizes() {
	let c = vector("canonical.json");
	let values = c.get("values").and_then(Json::as_array).unwrap();
	assert!(values.len() > 30);
	for v in values {
		let input = s(v, "input");
		let parsed = parse(input).unwrap_or_else(|e| panic!("{input}: {e}"));
		assert_eq!(parsed.canonical().unwrap(), s(v, "canonical"), "canonical of {input}");
		assert_eq!(digest_json(&parsed).unwrap(), s(v, "sha256"), "digest of {input}");
		assert_eq!(parsed.to_json_text(), s(v, "jsonText"), "JSON.stringify of {input}");
		assert_eq!(parsed.json_bytes() as f64, v.get("jsonBytes").and_then(Json::as_f64).unwrap(), "jsonBytes of {input}");
	}
	for n in c.get("numbers").and_then(Json::as_array).unwrap() {
		let bits = u64::from_str_radix(s(n, "bits"), 16).unwrap();
		let x = f64::from_bits(bits);
		match n.get("canonical") {
			Some(Json::String(want)) => {
				assert_eq!(number_text(x), *want, "bits {bits:016x}");
				assert_eq!(Json::Number(x).canonical().unwrap(), *want);
			}
			_ => assert!(Json::Number(x).canonical().is_err(), "bits {bits:016x} must be refused"),
		}
	}
	// an unpaired surrogate: a stored value is refused, the text of a call repaired as the service does (R-D10)
	let lone = c.get("unpairedSurrogate").unwrap();
	assert!(matches!(parse(s(lone, "input")), Err(ParseError::UnpairedSurrogate(_))));
	for case in c.get("wellFormed").unwrap().as_array().unwrap() {
		assert_eq!(parse_repairing(s(case, "input")).unwrap().to_json_text(), s(case, "output"), "{}", s(case, "input"));
	}
}

fn sha256_hex(bytes: &[u8]) -> String { hex(&Sha256::digest(bytes)) }

fn base64(text: &str) -> Vec<u8> {
	let val = |c: u8| match c { b'A'..=b'Z' => c - b'A', b'a'..=b'z' => c - b'a' + 26, b'0'..=b'9' => c - b'0' + 52, b'+' => 62, b'/' => 63, _ => panic!("not base64") };
	let bytes: Vec<u8> = text.bytes().filter(|&c| c != b'=').collect();
	let mut out = Vec::new();
	for chunk in bytes.chunks(4) {
		let n = chunk.iter().enumerate().fold(0u32, |n, (i, &c)| n | (val(c) as u32) << (18 - 6 * i));
		for i in 0..chunk.len() - 1 { out.push((n >> (16 - 8 * i)) as u8); }
	}
	out
}

#[test]
fn generations_and_derived_ids_of_crypto_json() {
	let c = vector("crypto.json");
	for g in c.get("generations").and_then(Json::as_array).unwrap() {
		let nonce = s(g, "nonce");
		let mut bound = Object::new();
		bound.insert("nonce", nonce.into());
		for (k, v) in g.get("rec").and_then(Json::as_object).unwrap().iter() { bound.insert(k, v.clone()); }
		// the signing key is used as UTF-8 text
		let mut mac = Hmac::<Sha256>::new_from_slice(s(g, "signingKey").as_bytes()).unwrap();
		mac.update(Json::Object(bound).canonical().unwrap().as_bytes());
		assert_eq!(format!("{nonce}.{}", hex(&mac.finalize().into_bytes())), s(g, "generation"));
	}
	let d = c.get("derived").unwrap();
	for p in d.get("principalId").and_then(Json::as_array).unwrap() {
		let pr = p.get("principal").unwrap();
		let id = Json::Array(vec![pr.get("peerId").unwrap().clone(), pr.get("agentId").cloned().unwrap_or(Json::Null)]);
		assert_eq!(id.canonical().unwrap(), s(p, "id"));
	}
	for k in d.get("keyFingerprint").and_then(Json::as_array).unwrap() {
		assert_eq!(&sha256_hex(&base64(s(k, "publicKey")))[..32], s(k, "fingerprint"));
	}
	for t in d.get("hashToken").and_then(Json::as_array).unwrap() {
		assert_eq!(sha256_hex(s(t, "token").as_bytes()), s(t, "sha256"));
	}
	for a in d.get("argumentHash").and_then(Json::as_array).unwrap() {
		let domain = a.get("domain").unwrap();
		let hash = digest_json(&obj! { "method" => domain.get("method").unwrap().clone(), "args" => domain.get("args").unwrap().clone() }).unwrap();
		assert_eq!(hash, s(a, "argumentHash"));
	}
	let r = d.get("changeRequestHash").unwrap();
	let triple = Json::Array(vec![r.get("principal").unwrap().clone(), s(r, "generation").into(), s(r, "requestId").into()]);
	assert_eq!(digest_json(&triple).unwrap(), s(r, "sha256"));
	// what proofs and grants sign: a domain tag and the canonical form
	let proof = c.get("proof").unwrap();
	assert_eq!(format!("phi-spaces/auth/v1\n{}", proof.get("challenge").unwrap().canonical().unwrap()), s(proof, "signedText"));
	let grant = c.get("grant").unwrap();
	assert_eq!(format!("phi-spaces/grant/v1\n{}", grant.get("grant").unwrap().canonical().unwrap()), s(grant, "signedText"));
}

#[test]
fn the_wire_session_and_store_answers_survive_a_round_trip() {
	// every reply the TypeScript service wrote parses and writes back to the same text (as JSON.stringify would)
	for name in ["wire.json", "store.expected.json"] {
		let v = vector(name);
		let steps = v.get("steps").and_then(Json::as_array).unwrap();
		for step in steps {
			let reply = step.get("reply").unwrap();
			assert_eq!(parse(&reply.to_json_text()).unwrap(), *reply);
		}
	}
}
