//! A control host change after a control promotion (`src/control-host-change.ts`): the authority keeps its ID, the
//! control host, its supervisor key and its address change. The recovery admin signs the change; the independent
//! register records it in the authority record only once it holds the promoted host as active primary of the control
//! Space and the old host without an active permit; a host follows only a recorded change with the signature it pins.
use crate::auth::{verify_detached, Algorithm};
use crate::register::{Register, RegisterError};
use phi_json::{canonical_key, safe_integer, text, Json, Object};

#[derive(Clone, Debug, PartialEq)]
pub enum ChangeError {
	/// `ControlHostChangeBlocked`
	Blocked(String),
	Register(RegisterError),
}
impl ChangeError {
	pub fn class(&self) -> &'static str {
		match self {
			ChangeError::Blocked(_) => "ControlHostChangeBlocked",
			ChangeError::Register(RegisterError::Conflict(_)) => "RegisterConflict",
			ChangeError::Register(RegisterError::Failed(_)) => "Error",
		}
	}
	pub fn message(&self) -> String {
		match self {
			ChangeError::Blocked(m) => m.clone(),
			ChangeError::Register(e) => e.to_string(),
		}
	}
}
impl From<RegisterError> for ChangeError {
	fn from(e: RegisterError) -> Self { ChangeError::Register(e) }
}
fn blocked<T>(m: &str) -> Result<T, ChangeError> { Err(ChangeError::Blocked(m.into())) }

/// The signed text of a change.
pub fn change_bytes(change: &Json) -> Vec<u8> { format!("phi-spaces/control-host-change/v1\n{}", canonical_key(change).unwrap_or_default()).into_bytes() }

fn id(v: Option<&Json>) -> bool {
	let Some(s) = v.and_then(Json::as_str) else { return false };
	let b = s.as_bytes();
	!b.is_empty() && b.len() <= 128 && b[0].is_ascii_alphanumeric() && b[1..].iter().all(|c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b':' | b'-'))
}

/// `verifyControlHostChange`: the change, if it is well formed and signed by the pinned recovery admin key.
pub fn verify_control_host_change(signed: &Json, pinned: (Algorithm, &str)) -> Result<Json, ChangeError> {
	let Some(c) = signed.get("change").filter(|c| !matches!(c, Json::Null | Json::Bool(false))) else { return blocked("invalid control host change") };
	let epoch = c.get("primaryEpoch").and_then(Json::as_f64);
	let port = c.get("address").and_then(|a| a.get("port")).and_then(Json::as_f64);
	let well_formed = ["recoveryId", "authorityId", "controlSpaceId", "fromHostId", "targetHostId"].iter().all(|k| id(c.get(k)))
		&& c.get("fromHostId") != c.get("targetHostId")
		&& epoch.is_some_and(|e| safe_integer(e) && e >= 2.0)
		&& c.get("supervisorKey").is_some_and(|k| k.as_str().is_some())
		&& matches!(text(c, "algorithm"), Some("ed25519" | "ecdsa-p256"))
		&& c.get("address").and_then(|a| a.get("host")).is_some_and(|h| h.as_str().is_some())
		&& port.is_some_and(|p| safe_integer(p) && (1.0..=65535.0).contains(&p));
	if !well_formed {
		return blocked("invalid control host change");
	}
	let signature = text(signed, "signature").unwrap_or("");
	if text(signed, "algorithm") != Some(pinned.0.name()) || !verify_detached(pinned.0, pinned.1, &change_bytes(c), signature) {
		return blocked("invalid recovery admin signature");
	}
	Ok(c.clone())
}

/// Recovery admin side: records a signed change in `authority:<controlSpaceId>`. Idempotent per recovery ID; the register
/// must already show the promotion.
pub async fn record_control_host_change(register: &dyn Register, signed: &Json, pinned: (Algorithm, &str)) -> Result<Json, ChangeError> {
	let c = verify_control_host_change(signed, pinned)?;
	let key = format!("authority:{}", text(&c, "controlSpaceId").unwrap_or(""));
	let current = register.get(&key).await?;
	let Some(a) = current.get("value").cloned() else { return blocked("authority register has not been provisioned") };
	let recovery = text(&c, "recoveryId").unwrap_or("").to_owned();
	let recorded = a.get("hostChanges").and_then(|h| h.get(&recovery));
	if a.get("hostChange").and_then(Json::as_str) == Some(recovery.as_str()) && recorded.map(canonical_key) == Some(canonical_key(signed)) {
		return Ok(c);
	}
	if text(&a, "state") != Some("active") || a.get("authorityId") != c.get("authorityId") || a.get("hostId") != c.get("fromHostId") {
		return blocked("the authority is not active on the old control host");
	}
	if recorded.is_some_and(|r| !matches!(r, Json::Null | Json::Bool(false))) {
		return blocked("recovery ID already used for another control host change");
	}
	let space = text(&c, "controlSpaceId").unwrap_or("");
	let target = register.get(&format!("boot:{}", text(&c, "targetHostId").unwrap_or(""))).await?;
	let from = register.get(&format!("boot:{}", text(&c, "fromHostId").unwrap_or(""))).await?;
	let permit = |r: &Json| r.get("value").and_then(|v| v.get("spaces")).and_then(|s| s.get(space)).cloned();
	let (t, f) = (permit(&target), permit(&from));
	let primary = t.as_ref().is_some_and(|t| text(t, "state") == Some("active") && text(t, "role") == Some("primary") && t.get("authorityId") == c.get("authorityId") && t.get("primaryEpoch") == c.get("primaryEpoch"));
	if target.get("value").and_then(|v| text(v, "state")) != Some("active") || !primary {
		return blocked("the target is not the active primary of the control Space at this epoch");
	}
	if f.as_ref().is_some_and(|f| text(f, "state") == Some("active")) {
		return blocked("the old control host still holds an active permit");
	}
	let mut next = a.as_object().cloned().unwrap_or_default();
	next.insert("hostId", c.get("targetHostId").cloned().unwrap());
	next.insert("supervisorKey", c.get("supervisorKey").cloned().unwrap());
	next.insert("hostChange", Json::String(recovery.clone()));
	let mut changes: Object = a.get("hostChanges").and_then(Json::as_object).cloned().unwrap_or_default();
	changes.insert(recovery, signed.clone());
	next.insert("hostChanges", Json::Object(changes));
	register.compare_and_set(&key, current.get("version").and_then(Json::as_f64), &Json::Object(next)).await?;
	Ok(c)
}

/// Host side, before anything else at start and then now and then: when the register names another control host than
/// this host uses, the recorded change (signed with the pinned recovery admin key, same authority) is installed with its
/// address and key. The installed change, or none when there was nothing to follow.
pub async fn follow_control_host_change(external: &dyn Register, installed: &dyn Register, control_space_id: &str, configured: (&str, &str), recovery_admin: (Algorithm, &str)) -> Result<Option<Json>, ChangeError> {
	let authority = external.get(&format!("authority:{control_space_id}")).await?;
	let Some(a) = authority.get("value").cloned() else { return Ok(None) };
	let key = format!("installed-authority:{control_space_id}");
	let local = installed.get(&key).await?;
	let lv = local.get("value");
	let has_address = lv.and_then(|v| v.get("address")).is_some_and(|x| !matches!(x, Json::Null | Json::Bool(false)));
	let using = if has_address { lv.and_then(|v| v.get("targetHostId")).cloned().unwrap_or(Json::Null) } else { Json::String(configured.0.to_owned()) };
	let authority_id = lv.and_then(|v| v.get("authorityId")).filter(|x| !x.is_null()).cloned().unwrap_or_else(|| Json::String(configured.1.to_owned()));
	if a.get("hostId") == Some(&using) {
		return Ok(None);
	}
	let recorded = a.get("hostChange").and_then(Json::as_str).filter(|h| !h.is_empty()).and_then(|h| a.get("hostChanges").and_then(|c| c.get(h)));
	let Some(signed) = recorded.filter(|s| !matches!(s, Json::Null | Json::Bool(false))) else { return Ok(None) };
	let c = verify_control_host_change(signed, recovery_admin)?;
	if text(&c, "controlSpaceId") != Some(control_space_id) || c.get("recoveryId") != a.get("hostChange") || c.get("targetHostId") != a.get("hostId") || c.get("supervisorKey") != a.get("supervisorKey") || c.get("authorityId") != a.get("authorityId") || c.get("authorityId") != Some(&authority_id) {
		return blocked("recorded control host change disagrees with the authority record");
	}
	let mut value = Object::new();
	value.insert("kind", Json::from("hostChange"));
	for k in ["authorityId", "recoveryId", "targetHostId", "supervisorKey", "algorithm", "address"] {
		value.insert(k, c.get(k).cloned().unwrap_or(Json::Null));
	}
	installed.compare_and_set(&key, local.get("version").and_then(Json::as_f64), &Json::Object(value)).await?;
	Ok(Some(c))
}
