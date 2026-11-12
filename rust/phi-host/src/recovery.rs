//! Signed authority transitions and the independent fence check (src/recovery.ts, src/fencing.ts): the recovery
//! coordinator reserves the unique successor of an authority behind a verified fence of its control host; a host
//! installs it outside any snapshot only once the register names it as the current successor.
use crate::auth::{to_base64, Signer};
use crate::recovery_rpc::{blocked, conflict, run_ssh, ssh_target, KeyPin, RR};
use crate::register::Register;
use phi_json::{obj, text, Json, Object};

const DOMAIN: &str = "phi-spaces/recovery-authority/v1\n";
const FIELDS: [&str; 6] = ["recoveryId", "expectedAuthorityId", "newAuthorityId", "controlSpaceId", "targetHostId", "supervisorKey"];

/// The bytes the recovery operator signs for an authority transition (test/vectors/replication.json).
pub(crate) fn authority_transition_bytes(t: &Json) -> Vec<u8> { format!("{DOMAIN}{}", t.canonical().expect("a transition is parsed JSON")).into_bytes() }

/// The version of a register record (none: not yet written).
pub(crate) fn version(r: &Json) -> Option<f64> { r.get("version").and_then(Json::as_f64) }
/// The value of a register record.
pub(crate) fn value(r: &Json) -> Json { r.get("value").cloned().unwrap_or(Json::Null) }

/// An authority that never had a successor may carry no lineage yet; anything but an object is refused by name.
fn lineage_of(a: &Json) -> RR<Object> {
	match a.get("lineage") {
		None => Ok(Object::new()),
		Some(Json::Object(o)) => Ok(o.clone()),
		Some(_) => Err(blocked("authority record carries an invalid lineage")),
	}
}

/// `RecoveryCoordinator.reserve`: the successor decision for `o` (its five fields), made once behind a verified fence of
/// the current control host, then signed. `new_id` is a fresh UUID (`randomUUID`).
pub async fn reserve<F, Fu>(register: &dyn Register, signer: &Signer, o: &Json, new_id: impl FnOnce() -> String, verify_fence: F) -> RR<Json>
where
	F: FnOnce(String) -> Fu,
	Fu: std::future::Future<Output = RR<Json>>,
{
	let key = format!("authority:{}", text(o, "controlSpaceId").unwrap_or(""));
	let current = register.get(&key).await?;
	if current.is_null() {
		return Err(blocked("authority register has not been provisioned"));
	}
	let a = value(&current);
	let lineage = lineage_of(&a)?;
	let expected = text(o, "expectedAuthorityId").unwrap_or("");
	let transition = match lineage.get(expected) {
		Some(known) => {
			if o.as_object().is_some_and(|f| f.iter().any(|(k, v)| known.get(k) != Some(v))) {
				return Err(conflict("another successor decision already exists for this authority"));
			}
			known.clone()
		}
		None => {
			if text(&a, "authorityId") != Some(expected) || text(&a, "state") != Some("active") {
				return Err(conflict("expected authority is not active"));
			}
			let host = text(&a, "hostId").unwrap_or("").to_owned();
			let proof = verify_fence(host.clone()).await?;
			if proof.get("restartLocked") != Some(&Json::Bool(true)) || text(&proof, "hostId") != Some(host.as_str()) {
				return Err(blocked("independently verified fencing with restart lock is required"));
			}
			let mut t = o.as_object().cloned().unwrap_or_default();
			t.insert("newAuthorityId", format!("a-{}", new_id()).into());
			let t = Json::Object(t);
			let mut next_lineage = lineage;
			next_lineage.insert(expected, t.clone());
			let record = obj! { "authorityId" => t.get("newAuthorityId").cloned().unwrap_or(Json::Null), "hostId" => text(&t, "targetHostId").unwrap_or(""), "supervisorKey" => text(&t, "supervisorKey").unwrap_or(""), "state" => "transitioning", "lineage" => Json::Object(next_lineage) };
			register.compare_and_set(&key, version(&current), &record).await?;
			t
		}
	};
	Ok(obj! { "transition" => transition.clone(), "algorithm" => signer.algorithm().name(), "signature" => to_base64(&signer.sign(&authority_transition_bytes(&transition))) })
}

/// `verifyAuthorityTransition`: the proof is signed by the pinned recovery key and is the register's current successor.
pub async fn verify_authority_transition(external: &dyn Register, proof: &Json, pinned: &KeyPin) -> RR<Json> {
	let t = proof.get("transition").cloned().unwrap_or(Json::Null);
	let fine = t.as_object().is_some() && FIELDS.iter().all(|k| text(&t, k).is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= 1024)) && text(&t, "expectedAuthorityId") != text(&t, "newAuthorityId");
	if !fine {
		return Err(blocked("invalid authority transition identity"));
	}
	if text(proof, "algorithm") != Some(pinned.algorithm.name()) || !crate::auth::verify_detached(pinned.algorithm, &pinned.public_key, &authority_transition_bytes(&t), text(proof, "signature").unwrap_or("")) {
		return Err(blocked("invalid recovery signature"));
	}
	let authority = external.get(&format!("authority:{}", text(&t, "controlSpaceId").unwrap_or(""))).await?;
	let a = value(&authority);
	let known = if authority.is_null() { None } else { lineage_of(&a)?.get(text(&t, "expectedAuthorityId").unwrap_or("")).cloned() };
	if known.is_none_or(|k| k.canonical().ok() != t.canonical().ok()) {
		return Err(blocked("transition is not the unique external successor decision"));
	}
	if text(&a, "authorityId") != text(&t, "newAuthorityId") {
		return Err(blocked("transition is no longer the current external successor"));
	}
	Ok(t)
}

/// `installAuthorityTransition`: the host's own record of the authority it follows, outside any snapshot.
pub async fn install_authority_transition(local: &dyn Register, external: &dyn Register, proof: &Json, pinned: &KeyPin) -> RR<Json> {
	let t = verify_authority_transition(external, proof, pinned).await?;
	let key = format!("installed-authority:{}", text(&t, "controlSpaceId").unwrap_or(""));
	let prior = local.get(&key).await?;
	let p = value(&prior);
	if !prior.is_null() && text(&p, "authorityId") == text(&t, "newAuthorityId") && text(&p, "recoveryId") == text(&t, "recoveryId") {
		return Ok(t);
	}
	if prior.is_null() || text(&p, "authorityId") != text(&t, "expectedAuthorityId") {
		return Err(conflict("member authority changed or was not provisioned"));
	}
	let record = obj! { "authorityId" => text(&t, "newAuthorityId").unwrap_or(""), "recoveryId" => text(&t, "recoveryId").unwrap_or(""), "supervisorKey" => text(&t, "supervisorKey").unwrap_or(""), "targetHostId" => text(&t, "targetHostId").unwrap_or("") };
	local.compare_and_set(&key, version(&prior), &record).await?;
	Ok(t)
}

/// `verifySshFence` (F15): an independent ssh forced command says that the host's normal service is stopped and
/// restart-locked; only then, and only for a host without replicas, is the host recorded as fenced.
pub async fn verify_ssh_fence(register: &dyn Register, host_id: &str, targets: &Object) -> RR<Json> {
	let target = targets.get(host_id).and_then(Json::as_str).filter(|t| ssh_target(t)).ok_or_else(|| blocked("no independently provisioned fencing endpoint for this host"))?;
	let boot = register.get(&format!("boot:{host_id}")).await?;
	let b = value(&boot);
	// a primary permit without durability is sync (durabilityOf, boot.ts): F15 refuses it like an explicit sync one
	let replicated = b.get("spaces").and_then(Json::as_object).is_none_or(|spaces| {
		spaces.iter().any(|(_, s)| {
			let role = text(s, "role");
			text(s, "durability") == Some("sync") || (role == Some("primary") && s.get("durability").is_none()) || !matches!(role, Some("local" | "primary"))
		})
	});
	if boot.is_null() || replicated {
		return Err(blocked("F15 is restricted to single-space hosting without replicas"));
	}
	let out = run_ssh(target, "phi-spaces-fence-status", vec![], 10_000, 8192).await.map_err(|e| {
		blocked(match e.as_str() {
			"SSH command timed out" => "independent fencing status timed out",
			"response exceeds budget" => "invalid fencing response",
			_ => "fencing SSH command failed",
		})
	})?;
	let status = phi_json::parse(&String::from_utf8_lossy(&out)).map_err(|_| blocked("invalid fencing status"))?;
	if text(&status, "hostId") != Some(host_id) || status.get("restartLocked") != Some(&Json::Bool(true)) || status.get("stopped") != Some(&Json::Bool(true)) {
		return Err(blocked("normal service is not independently stopped and restart-locked"));
	}
	if text(&b, "state") != Some("fenced") {
		let mut next = b.as_object().cloned().unwrap_or_default();
		next.insert("state", "fenced".into());
		register.compare_and_set(&format!("boot:{host_id}"), version(&boot), &Json::Object(next)).await?;
	}
	Ok(obj! { "hostId" => host_id, "restartLocked" => true })
}
