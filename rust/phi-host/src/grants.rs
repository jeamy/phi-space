//! Short-lived control-primary grants (src/grants.ts). Verification never trusts roles, scope or authority from a client
//! presentation.
use crate::auth::{to_base64, verify_detached, Algorithm, KeyDirectory, Proof, Signer};
use phi_json::{hex, Json, Object};
use phi_service::{Identity, Policy};

const DOMAIN: &str = "phi-spaces/grant/v1\n";
const RESOLUTION: [&str; 7] = ["hello", "pollOperation", "resolveOperation", "cancelOperation", "txn", "lease", "rotationStatus"];
const OWN_KEY: [&str; 4] = ["rotationChallenge", "rotationGeneration", "rotateKey", "rotationStatus"];
const SAFE: f64 = 9_007_199_254_740_991.0;
pub const MAX_TTL_MS: f64 = 60_000.0;

fn strings(list: &[String]) -> Json { Json::Array(list.iter().cloned().map(Json::String).collect()) }
fn safe(v: Option<&Json>) -> Option<f64> { v.and_then(Json::as_f64).filter(|n| n.fract() == 0.0 && n.abs() <= SAFE) }
fn text_list(v: Option<&Json>) -> Option<Vec<&str>> { v?.as_array()?.iter().map(Json::as_str).collect() }

/// `/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/`
fn agent_id_ok(id: &str) -> bool {
	let b = id.as_bytes();
	!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c))
}

/// Only on the authoritative control host, with its durable signing key.
pub struct GrantAuthority<'a> {
	pub authority_id: String,
	pub host_id: String,
	pub signer: Signer,
	pub keys: &'a dyn KeyDirectory,
	pub ttl_ms: f64,
	/// `Some(false)`: A-only rights are off after a recovery.
	pub allow_a_only: Option<bool>,
}

impl GrantAuthority<'_> {
	/// `identity` is the one read fresh for this issue; `id16`: 16 random bytes.
	pub fn issue(&self, identity: Option<&Identity>, proof: Option<&Proof>, purpose: &str, agent_id: Option<&str>, now: f64, id16: [u8; 16]) -> Result<Json, String> {
		if !(self.ttl_ms.fract() == 0.0 && (1.0..=MAX_TTL_MS).contains(&self.ttl_ms)) { return Err("grant TTL must be 1..60000 ms".into()); }
		if purpose != "effect" && purpose != "resolution" { return Err("invalid grant purpose".into()); }
		let id = identity.ok_or("no current overlay identity")?;
		let (mut roles, mut scope) = (id.roles.clone(), vec!["*".to_string()]);
		match proof {
			Some(p) => {
				let peer = id.principal.get("peerId").and_then(Json::as_str).unwrap_or("");
				let key = self.keys.find(peer, &p.key_id).filter(|k| k.active).ok_or("the app key is not active")?;
				roles.retain(|r| key.roles.contains(r));
				scope = key.scope.unwrap_or_default();
			}
			None => {
				if purpose == "resolution" { return Err("resolution needs a still-active app key".into()); }
				if self.allow_a_only == Some(false) {
					if !roles.iter().any(|r| r == "unpaired") { return Err("A-only rights remain disabled after recovery".into()); }
					roles = vec!["unpaired".into()];
					scope = vec!["control".into()];
				}
			}
		}
		if purpose == "effect" && roles.is_empty() { return Err("no current effect rights".into()); }
		if let Some(agent) = agent_id {
			if !agent_id_ok(agent) || proof.is_none() || !roles.iter().any(|r| r == "host") {
				return Err("only a proven host may grant its own local agent namespace".into());
			}
		}
		let principal = match agent_id {
			None => id.principal.clone(),
			Some(agent) => {
				let mut o = Object::new();
				o.insert("peerId", id.principal.get("peerId").cloned().unwrap_or(Json::Null));
				o.insert("agentId", agent.into());
				Json::Object(o)
			}
		};
		let mut g = Object::new();
		g.insert("id", hex(&id16).into());
		g.insert("authorityId", self.authority_id.as_str().into());
		g.insert("issuerHostId", self.host_id.as_str().into());
		g.insert("principal", principal);
		if let Some(p) = proof { g.insert("keyId", p.key_id.as_str().into()); }
		g.insert("scope", strings(&scope));
		g.insert("roles", strings(&roles));
		g.insert("issuedAt", Json::Number(now));
		g.insert("expiresAt", Json::Number(now + self.ttl_ms));
		g.insert("purpose", purpose.into());
		let g = Json::Object(g);
		let text = format!("{DOMAIN}{}", g.canonical().map_err(|_| "grant is not canonical")?);
		let mut out = Object::new();
		out.insert("grant", g);
		out.insert("algorithm", match self.signer.algorithm() { Algorithm::Ed25519 => "ed25519", Algorithm::EcdsaP256 => "ecdsa-p256" }.into());
		out.insert("signature", to_base64(&self.signer.sign(text.as_bytes())).into());
		Ok(Json::Object(out))
	}
}

pub struct GrantVerifier {
	pub authority_id: String,
	pub issuer_host_id: String,
	pub public_key: String,
	pub algorithm: Algorithm,
	pub uncertainty_ms: f64,
}

/// What a verified grant allows one call (DecisionAuthorization of src/service.ts).
#[derive(Clone, Debug)]
pub struct Decision {
	pub valid_until: f64,
	pub roles: Vec<String>,
	effect_roles: Vec<String>,
	effect: bool,
	expires_at: f64,
	margin: f64,
}

impl Decision {
	pub fn can_execute_pending(&self, policy: &Policy, method: &str, type_name: Option<&str>) -> bool {
		let m = if method.starts_with("take") { "take" } else if method.starts_with("read") { "read" } else { method };
		self.effect && self.effect_roles.iter().any(|role| {
			policy.get(role).is_some_and(|r| r.methods.as_ref().is_none_or(|l| l.iter().any(|x| x == m)) && r.types.as_ref().is_none_or(|t| type_name.is_some_and(|n| t.iter().any(|x| x == n))))
		})
	}
	/// Again at the commit: the grant may have run out since the call came in.
	pub fn check(&self, now: f64) -> Result<(), String> {
		if now + self.margin >= self.expires_at { Err("grant expired before commit".into()) } else { Ok(()) }
	}
}

impl GrantVerifier {
	/// `conn_key`: `None` without a connection, else the key its proof named.
	pub fn check(&self, token: Option<&Json>, id: &Identity, call: &Json, conn_key: Option<Option<&str>>, now: f64) -> Result<Decision, String> {
		const NEEDED: &str = "a signed control grant is required";
		let g = token.and_then(|t| t.get("grant")).filter(|g| !g.is_null()).ok_or(NEEDED)?;
		let token = token.ok_or(NEEDED)?;
		let name = match self.algorithm { Algorithm::Ed25519 => "ed25519", Algorithm::EcdsaP256 => "ecdsa-p256" };
		if token.get("algorithm").and_then(Json::as_str) != Some(name) { return Err(NEEDED.into()); }
		let signature = token.get("signature").and_then(Json::as_str).ok_or(NEEDED)?;
		let text = g.canonical().map(|c| format!("{DOMAIN}{c}")).map_err(|_| "invalid grant signature")?;
		if !verify_detached(self.algorithm, &self.public_key, text.as_bytes(), signature) { return Err("invalid grant signature".into()); }
		let margin = self.uncertainty_ms;
		if g.get("authorityId").and_then(Json::as_str) != Some(&self.authority_id) || g.get("issuerHostId").and_then(Json::as_str) != Some(&self.issuer_host_id) {
			return Err("grant authority or issuer mismatch".into());
		}
		if g.get("principal").and_then(|p| p.canonical().ok()) != id.principal.canonical().ok() { return Err("grant belongs to another principal".into()); }
		let key = g.get("keyId");
		if let Some(conn_key) = conn_key {
			if key.map(|k| k.as_str()) != conn_key.map(Some) { return Err("grant belongs to another app key".into()); }
		}
		let (Some(issued), Some(expires)) = (safe(g.get("issuedAt")), safe(g.get("expiresAt"))) else { return Err("grant expired or has invalid timestamps".into()) };
		if expires <= issued || expires - issued > MAX_TTL_MS || issued > now + margin || now + margin >= expires {
			return Err("grant expired or has invalid timestamps".into());
		}
		let (Some(roles), Some(scope)) = (text_list(g.get("roles")), text_list(g.get("scope"))) else { return Err("invalid grant roles or scope".into()) };
		let method = call.get("method").and_then(Json::as_str).unwrap_or("");
		let space = call.get("space").and_then(Json::as_str).unwrap_or("default");
		let keyed = key.and_then(Json::as_str).is_some_and(|k| !k.is_empty());
		let own_key = conn_key.is_some() && keyed && OWN_KEY.contains(&method);
		if !own_key && !scope.contains(&"*") && !scope.contains(&space) { return Err("space outside grant scope".into()); }
		let purpose = g.get("purpose").and_then(Json::as_str);
		let action = call.get("args").and_then(|a| a.get("action")).and_then(Json::as_str);
		if purpose == Some("resolution") && (!RESOLUTION.contains(&method) || (method == "txn" && action != Some("abort")) || (method == "lease" && action != Some("cancel"))) {
			return Err("resolution grants cannot create effects".into());
		}
		if purpose != Some("effect") && purpose != Some("resolution") { return Err("invalid grant purpose".into()); }
		let effect = purpose == Some("effect");
		let effect_roles: Vec<String> = id.roles.iter().filter(|r| roles.contains(&r.as_str())).cloned().collect();
		Ok(Decision { valid_until: expires - margin, roles: if effect { effect_roles.clone() } else { vec!["resolution".into()] }, effect_roles, effect, expires_at: expires, margin })
	}
}
