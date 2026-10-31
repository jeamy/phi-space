//! Layer B of the identity (src/auth.ts): an app key per principal, proven per connection by a signed challenge.
use ed25519_dalek::{Signature as EdSignature, VerifyingKey};
use p256::ecdsa::signature::Verifier as _;
use p256::ecdsa::{DerSignature, VerifyingKey as P256Key};
use p256::pkcs8::DecodePublicKey as _;
use phi_json::{hex, Json, Object};

pub const AUTH_PROTOCOL: f64 = 1.0;
pub const CHALLENGE_TTL_MS: f64 = 30_000.0;
pub const DEFAULT_PRIVILEGED: [&str; 5] = ["admin", "router", "replicator", "supervisor", "host"];
const DOMAIN: &str = "phi-spaces/auth/v1\n";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Algorithm { Ed25519, EcdsaP256 }

impl Algorithm {
	pub fn parse(name: &str) -> Option<Algorithm> {
		match name { "ed25519" => Some(Algorithm::Ed25519), "ecdsa-p256" => Some(Algorithm::EcdsaP256), _ => None }
	}
}

/// One key of one peer in the control space. Written by the supervisor, never by the client.
#[derive(Clone, Debug)]
pub struct PeerKey {
	pub peer_id: String,
	pub key_id: String,
	pub principal: String,
	pub algorithm: Algorithm,
	pub public_key: String,
	pub scope: Option<Vec<String>>,
	pub roles: Vec<String>,
	pub active: bool,
}

pub trait KeyDirectory {
	/// The key if it exists, in any state.
	fn find(&self, peer_id: &str, key_id: &str) -> Option<PeerKey>;
}

/// `Buffer.from(text, "base64")`: both alphabets, anything else is skipped, the first `=` ends the data.
pub fn base64(text: &str) -> Vec<u8> {
	let (mut out, mut bits, mut have) = (Vec::with_capacity(text.len() * 3 / 4), 0u32, 0u32);
	for b in text.bytes() {
		let v = match b {
			b'A'..=b'Z' => b - b'A',
			b'a'..=b'z' => b - b'a' + 26,
			b'0'..=b'9' => b - b'0' + 52,
			b'+' | b'-' => 62,
			b'/' | b'_' => 63,
			b'=' => break,
			_ => continue,
		};
		bits = (bits << 6) | u32::from(v);
		have += 6;
		if have >= 8 {
			have -= 8;
			out.push((bits >> have) as u8);
			bits &= (1 << have) - 1;
		}
	}
	out
}

/// Detached signatures in the formats of app proofs: Ed25519 over raw 32 bytes, P-256 with SHA-256 as SPKI and DER. Strict
/// verification refuses the small-order Ed25519 keys and non-canonical signatures no key of ours can produce.
pub fn verify_detached(algorithm: Algorithm, public_key: &str, message: &[u8], signature: &str) -> bool {
	let (key, sig) = (base64(public_key), base64(signature));
	match algorithm {
		Algorithm::Ed25519 => {
			let (Ok(key), Ok(sig)) = (<[u8; 32]>::try_from(key.as_slice()), <[u8; 64]>::try_from(sig.as_slice())) else { return false };
			VerifyingKey::from_bytes(&key).is_ok_and(|k| k.verify_strict(message, &EdSignature::from_bytes(&sig)).is_ok())
		}
		Algorithm::EcdsaP256 => {
			let (Ok(key), Ok(sig)) = (P256Key::from_public_key_der(&key), DerSignature::try_from(sig.as_slice())) else { return false };
			key.verify(message, &sig).is_ok()
		}
	}
}

/// What is signed: a domain tag plus the canonical encoding of the challenge.
pub fn signed_text(challenge: &Json) -> Option<String> { Some(format!("{DOMAIN}{}", challenge.canonical().ok()?)) }

#[derive(Clone, Debug)]
pub struct Proof {
	pub key_id: String,
	pub principal: String,
	pub roles: Vec<String>,
	pub scope: Option<Vec<String>>,
	pub at: f64,
}

/// Per-connection state; the gate owns it.
#[derive(Clone, Debug, Default)]
pub struct AuthState {
	challenge: Option<(Json, bool)>,
	pub proof: Option<Proof>,
	failures: u32,
}

pub struct Proving {
	pub gate_host_id: String,
	pub max_failures: u32,
	pub privileged: Vec<String>,
}

fn object(pairs: Vec<(&str, Json)>) -> Json {
	let mut o = Object::new();
	for (k, v) in pairs { o.insert(k, v); }
	Json::Object(o)
}
fn strings(list: &[String]) -> Json { Json::Array(list.iter().cloned().map(Json::String).collect()) }
fn bad(code: &str, message: &str) -> Json {
	object(vec![("ok", Json::Bool(false)), ("error", object(vec![("code", code.into()), ("message", message.into())]))])
}
fn good(result: Json) -> Json { object(vec![("ok", Json::Bool(true)), ("result", result)]) }

impl Proving {
	pub fn new(gate_host_id: &str) -> Proving {
		Proving { gate_host_id: gate_host_id.to_string(), max_failures: 5, privileged: DEFAULT_PRIVILEGED.map(String::from).to_vec() }
	}

	/// `challenge` or `prove`; `nonce` is the 32 random bytes a challenge would use.
	pub fn proof(&self, method: &str, args: Option<&Json>, peer_id: Option<&str>, st: &mut AuthState, keys: &dyn KeyDirectory, (now, nonce): (f64, [u8; 32])) -> Json {
		let Some(peer_id) = peer_id else { return bad("Unauthenticated", "the connection has no known peer") };
		let empty = Object::new();
		let args = args.and_then(Json::as_object).unwrap_or(&empty);
		if method == "challenge" {
			if args.get("protocol").and_then(Json::as_f64) != Some(AUTH_PROTOCOL) {
				return bad("BadRequest", &format!("this host speaks auth protocol {AUTH_PROTOCOL}"));
			}
			let value = object(vec![
				("gateHostId", self.gate_host_id.as_str().into()),
				("observedPeerId", peer_id.into()),
				("connNonce", hex(&nonce).into()),
				("protocol", Json::Number(AUTH_PROTOCOL)),
				("issuedAt", Json::Number(now)),
			]);
			st.challenge = Some((value.clone(), false));
			let Json::Object(mut result) = value else { unreachable!() };
			result.insert("expiresAt", Json::Number(now + CHALLENGE_TTL_MS));
			return good(Json::Object(result));
		}
		if st.failures >= self.max_failures { return bad("PermissionDenied", "too many wrong proofs on this connection"); }
		match self.check(args, peer_id, st, keys, now) {
			Ok(proof) => {
				let reply = object(vec![("keyId", proof.key_id.as_str().into()), ("principal", proof.principal.as_str().into()), ("roles", strings(&proof.roles))]);
				st.proof = Some(proof);
				good(reply)
			}
			Err(message) => {
				st.failures += 1;
				if let Some(c) = &mut st.challenge { c.1 = true; } // a challenge is good for one attempt
				bad("PermissionDenied", message)
			}
		}
	}

	fn check(&self, args: &Object, peer_id: &str, st: &mut AuthState, keys: &dyn KeyDirectory, now: f64) -> Result<Proof, &'static str> {
		let Some((value, false)) = &st.challenge else { return Err("no open challenge: call challenge first") };
		let (Some(key_id), Some(signature), Some(presented)) = (args.get("keyId").and_then(Json::as_str), args.get("signature").and_then(Json::as_str), args.get("challenge")) else {
			return Err("prove needs keyId, signature and the challenge");
		};
		if presented.canonical().ok() != value.canonical().ok() { return Err("this is not the challenge issued on this connection"); }
		let issued = value.get("issuedAt").and_then(Json::as_f64).unwrap_or(f64::NAN);
		if now - issued > CHALLENGE_TTL_MS || now < issued { return Err("the challenge has expired"); }
		let key = keys.find(peer_id, key_id).filter(|k| k.peer_id == peer_id).ok_or("unknown key for this peer")?;
		if !key.active { return Err("the key is revoked"); }
		let text = signed_text(value).ok_or("the signature does not match")?;
		if !verify_detached(key.algorithm, &key.public_key, text.as_bytes(), signature) { return Err("the signature does not match"); }
		if let Some(c) = &mut st.challenge { c.1 = true; }
		Ok(Proof { key_id: key.key_id, principal: key.principal, roles: key.roles, scope: key.scope, at: now })
	}

	/// A refusal because roles are withheld is `ProofRequired`: the client can fix it by proving.
	pub fn annotate(&self, reply: String, st: &AuthState, group_roles: &[String]) -> String {
		if st.proof.is_some() || !group_roles.iter().any(|r| self.privileged.contains(r)) { return reply; }
		let Ok(parsed) = phi_json::parse(&reply) else { return reply };
		if parsed.get("ok").and_then(Json::as_bool) != Some(false) { return reply; }
		let Some(error) = parsed.get("error").and_then(Json::as_object) else { return reply };
		if error.get("code").and_then(Json::as_str) != Some("PermissionDenied") { return reply; }
		let mut error = error.clone();
		error.insert("code", "ProofRequired".into());
		error.insert("message", "a proof of your app key is required for this: call challenge, then prove".into());
		object(vec![("ok", Json::Bool(false)), ("error", Json::Object(error))]).to_json_text()
	}
}

/// What a host holds to sign with; the public half goes to the control space.
pub enum Signer {
	Ed25519(ed25519_dalek::SigningKey),
	EcdsaP256(p256::ecdsa::SigningKey),
}

impl Signer {
	pub fn algorithm(&self) -> Algorithm {
		match self { Signer::Ed25519(_) => Algorithm::Ed25519, Signer::EcdsaP256(_) => Algorithm::EcdsaP256 }
	}
	pub fn sign(&self, data: &[u8]) -> Vec<u8> {
		use ed25519_dalek::Signer as _;
		match self {
			Signer::Ed25519(k) => k.sign(data).to_bytes().to_vec(),
			Signer::EcdsaP256(k) => { let s: DerSignature = p256::ecdsa::signature::Signer::sign(k, data); s.as_bytes().to_vec() }
		}
	}
}

pub fn to_base64(bytes: &[u8]) -> String {
	const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
	for c in bytes.chunks(3) {
		let n = (u32::from(c[0]) << 16) | (u32::from(*c.get(1).unwrap_or(&0)) << 8) | u32::from(*c.get(2).unwrap_or(&0));
		for i in 0..4 {
			if i <= c.len() { out.push(ABC[(n >> (18 - 6 * i)) as usize & 63] as char); } else { out.push('='); }
		}
	}
	out
}
