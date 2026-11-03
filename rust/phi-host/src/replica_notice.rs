//! The ReplicaConfigNotice a primary offers its control host after promote, degradeToSingle or setStandby (src/replica-notice.ts,
//! docs/federation-plan-v3.en.md 5.3.1 step 5): derived from the configuration entry of its last completed transition, so a
//! crash between completing it and offering the notice loses nothing, and signed by the primary. The signature only names the
//! sender; the router adopts a notice only if the register admits its primary with exactly this permit.
use crate::auth::{to_base64, verify_detached, Algorithm, Signer};
use phi_core::space::{error, CoreError, Space, Template};
use phi_json::{obj, text, Json, FOREVER};
use phi_service::Service;
use phi_store::sync::{durability_of, SyncJournal};

const DOMAIN: &str = "phi-spaces/replica-config-notice/v1\n";
fn num(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(f64::NAN) }

/// `replicaConfigNotice`: the notice of a completed transition, from its configuration entry in the chain.
pub fn notice_of(journal: &SyncJournal, transition_id: &str, data_incarnation: &str) -> phi_store::sync::Result<Option<Json>> {
	if journal.transition(transition_id)?.as_ref().and_then(|r| text(r, "phase")) != Some("completed") {
		return Ok(None);
	}
	for r in (1..=journal.head_revision()?).rev() {
		let i = journal.intent(r as f64)?.expect("a complete chain");
		if num(&i, "version") == 2.0 && text(&i, "reason") == Some(transition_id) {
			let c = i.get("config").cloned().unwrap_or(Json::Null);
			return Ok(Some(obj! {
				"authorityId" => text(&c, "authorityId").unwrap_or(""), "spaceId" => text(&c, "spaceId").unwrap_or(""), "recoveryId" => transition_id,
				"primaryReplica" => text(&c, "primaryReplica").unwrap_or(""), "standbyReplica" => c.get("standbyReplica").cloned().unwrap_or(Json::Null),
				"primaryEpoch" => num(&c, "primaryEpoch"), "replicaConfigVersion" => num(&c, "replicaConfigVersion"), "durability" => durability_of(&c), "dataIncarnation" => data_incarnation
			}));
		}
	}
	Ok(None)
}

/// `latestReplicaConfigNotice`: the notice of the newest transition in the chain, if it is completed.
pub fn latest_notice(journal: &SyncJournal, data_incarnation: &str) -> phi_store::sync::Result<Option<Json>> {
	for r in (1..=journal.head_revision()?).rev() {
		let i = journal.intent(r as f64)?.expect("a complete chain");
		if num(&i, "version") != 2.0 {
			continue;
		}
		return notice_of(journal, text(&i, "reason").unwrap_or(""), data_incarnation);
	}
	Ok(None)
}

/// `signReplicaConfigNotice`.
pub fn sign_notice(notice: &Json, signer: &Signer) -> Json {
	let text_ = format!("{DOMAIN}{}", notice.canonical().expect("a notice is parsed JSON"));
	obj! { "notice" => notice.clone(), "issuer" => text(notice, "primaryReplica").unwrap_or(""), "algorithm" => signer.algorithm().name(), "signature" => to_base64(&signer.sign(text_.as_bytes())) }
}

/// What the connection proved of a notice's publisher (never the body): whether a host binding names it as the
/// notice's issuer, the roles of its grant, and the key it proved.
pub struct Publisher<'a> {
	pub bound: bool,
	pub roles: &'a [String],
	pub key: Option<(Algorithm, &'a str)>,
}

/// `ReplicaNoticeBoard.publish`: a proven host leaves only its own signed notice in the control Space, at most one per
/// Space and issuer; the router adopts what it finds there. The board stores, the adoption decides. `check` runs before
/// the commit and inside it (the grant still valid, the key still active).
pub fn publish(service: &mut Service, control_space: &str, t: &Json, p: Publisher, check: &dyn Fn(&Space, f64) -> Result<(), CoreError>) -> Result<Json, CoreError> {
	let conflict = |m: &str| error("RoutingConflict", m);
	let n = t.get("notice").filter(|n| n.as_object().is_some());
	let issuer = t.get("issuer").and_then(Json::as_str);
	let space = n.and_then(|n| n.get("spaceId")).and_then(Json::as_str).filter(|s| !s.is_empty() && s.encode_utf16().count() <= 128);
	if n.is_none() || issuer.is_none() || issuer != n.and_then(|n| text(n, "primaryReplica")) || space.is_none() || t.get("signature").and_then(Json::as_str).is_none() || t.to_json_text().len() > 4096 {
		return Err(conflict("invalid replica configuration notice"));
	}
	let (n, issuer, space) = (n.expect("checked"), issuer.expect("checked"), space.expect("checked"));
	let signature = text(t, "signature").unwrap_or("");
	let signed_by_proven = p.key.is_some_and(|(algorithm, key)| Some(algorithm.name()) == text(t, "algorithm") && verify_detached(algorithm, key, format!("{DOMAIN}{}", n.canonical().unwrap_or_default()).as_bytes(), signature));
	if !p.roles.iter().any(|r| r == "host") || !(p.bound || signed_by_proven) {
		return Err(conflict("only the proven primary host publishes its notice"));
	}
	let now = service.now();
	check(&service.store.reader(Some(control_space))?.space, now)?;
	let want = t.canonical().unwrap_or_default();
	service.commit_on(Some(control_space), |s, now| {
		check(s, now)?;
		let fields = obj! { "spaceId" => space, "issuer" => issuer };
		let old = s.list(now, &Template::from_json(Some(&obj! { "type" => "ReplicaConfigNotice", "fields" => fields.clone() }))?, None, None, None)?.as_array().cloned().unwrap_or_default();
		if old.iter().any(|e| e.get("fields").and_then(|f| f.get("signed")).and_then(|v| v.canonical().ok()) == Some(want.clone())) {
			return Ok(obj! { "stored" => false });
		}
		for e in &old {
			s.probe(now, &Template::from_json(Some(&obj! { "type" => "ReplicaConfigNotice", "id" => e.get("id").cloned().unwrap_or(Json::Null) }))?, None, true, None)?;
		}
		let mut stored = fields.as_object().cloned().unwrap_or_default();
		stored.insert("version", n.get("replicaConfigVersion").cloned().unwrap_or(Json::Null));
		stored.insert("signed", t.clone());
		s.write(now, &obj! { "type" => "ReplicaConfigNotice", "fields" => Json::Object(stored) }, None, Some(&Json::Number(FOREVER)), None)?;
		Ok(obj! { "stored" => true })
	})
}
