//! The ReplicaConfigNotice a primary offers its control host after promote, degradeToSingle or setStandby (src/replica-notice.ts,
//! docs/federation-plan-v3.en.md 5.3.1 step 5): derived from the configuration entry of its last completed transition, so a
//! crash between completing it and offering the notice loses nothing, and signed by the primary. The signature only names the
//! sender; the router adopts a notice only if the register admits its primary with exactly this permit.
use crate::auth::{to_base64, Signer};
use phi_json::{obj, text, Json};
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
