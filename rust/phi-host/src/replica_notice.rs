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
		let Some(i) = journal.intent(r as f64)? else { return Err(phi_store::sync::SyncError::Blocked(format!("journal history has no revision {r}"))) };
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
		let Some(i) = journal.intent(r as f64)? else { return Err(phi_store::sync::SyncError::Blocked(format!("journal history has no revision {r}"))) };
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

/// The checks of `adoptReplicaConfigNotice` before anything is read: the notice's shape, and its primary's signature with
/// the key this Root provisioned for that host (`issuer`: its algorithm and public key).
pub fn verify_adoptable(t: &Json, authority_id: &str, issuer: Option<(Algorithm, &str)>) -> Result<Json, CoreError> {
	let conflict = |m: &str| error("RoutingConflict", m);
	let Some(n) = t.get("notice").filter(|n| n.as_object().is_some()) else { return Err(conflict("invalid replica configuration notice")) };
	let int = |k: &str| n.get(k).and_then(Json::as_f64).filter(|v| phi_json::safe_integer(*v) && *v >= 1.0);
	let durability = text(n, "durability");
	let fine = text(n, "authorityId") == Some(authority_id) && int("replicaConfigVersion").is_some() && int("primaryEpoch").is_some() && matches!(durability, Some("single" | "sync")) && (durability == Some("single")) == n.get("standbyReplica").is_some_and(Json::is_null) && text(n, "recoveryId").is_some() && text(n, "dataIncarnation").is_some();
	if !fine {
		return Err(conflict("invalid replica configuration notice"));
	}
	let signed = issuer.is_some_and(|(algorithm, key)| text(t, "issuer") == text(n, "primaryReplica") && Some(algorithm.name()) == text(t, "algorithm") && verify_detached(algorithm, key, format!("{DOMAIN}{}", n.canonical().unwrap_or_default()).as_bytes(), text(t, "signature").unwrap_or("")));
	if !signed {
		return Err(conflict("notice is not signed by its primary"));
	}
	Ok(n.clone())
}

/// `permitFor`: the register admits the notice's primary with exactly this configuration; the record's version.
pub fn permit_for(record: &Json, n: &Json) -> Result<Json, CoreError> {
	let b = record.get("value").filter(|v| !v.is_null());
	let p = b.and_then(|b| b.get("spaces")).and_then(|s| s.get(text(n, "spaceId").unwrap_or("")));
	let durability = text(n, "durability").unwrap_or("");
	let admitted = b.is_some_and(|b| text(b, "state") == Some("active") && b.get("hostId") == n.get("primaryReplica")) && crate::replica_control::permit_matches(p, "primary", n, durability) && p.and_then(|p| p.get("dataIncarnation")) == n.get("dataIncarnation");
	if !admitted {
		return Err(error("RoutingConflict", "the register does not admit the notice's primary with this configuration"));
	}
	Ok(record.get("version").cloned().unwrap_or(Json::Null))
}

/// What adopting a notice makes of the routing document (`adoptReplicaConfigNotice` inside its commit): `None` for
/// the same adopted configuration (nothing to write), else the next document with its raised policy version.
pub fn adopted_routing(routing: &Json, profiles_open: bool, authority_id: &str, n: &Json) -> Result<(String, Option<Json>, f64), CoreError> {
	let conflict = |m: &str| error("RoutingConflict", m);
	if profiles_open {
		return Err(conflict("profile transition blocks replica configuration adoption"));
	}
	let policy = routing.get("policy").filter(|p| p.as_object().is_some() && text(p, "authorityId") == Some(authority_id)).ok_or_else(|| conflict("no federation policy installed"))?;
	let version = policy.get("policyVersion").and_then(Json::as_f64).unwrap_or(0.0);
	let members = routing.get("members").and_then(Json::as_object).cloned().unwrap_or_default();
	let named: Vec<(&str, &Json)> = members.iter().filter(|(_, m)| m.get("target").is_some_and(|t| t.get("spaceId") == n.get("spaceId") && t.get("authorityId") == n.get("authorityId"))).collect();
	let [(_, m)] = named.as_slice() else { return Err(conflict("the notice names no single Member Space")) };
	let id = text(m, "id").unwrap_or("").to_owned();
	let r = m.get("replication").filter(|r| r.as_object().is_some()).ok_or_else(|| conflict("the Member is not replicated"))?;
	let (have, got) = (r.get("replicaConfigVersion").and_then(Json::as_f64).unwrap_or(0.0), n.get("replicaConfigVersion").and_then(Json::as_f64).unwrap_or(0.0));
	if have > got {
		return Err(conflict("stale replica configuration notice"));
	}
	let t = m.get("target").cloned().unwrap_or(Json::Null);
	if have == got {
		let same = r.get("recoveryId") == n.get("recoveryId") && r.get("primaryReplica") == n.get("primaryReplica") && r.get("standbyReplica").cloned().unwrap_or(Json::Null) == n.get("standbyReplica").cloned().unwrap_or(Json::Null) && r.get("durability") == n.get("durability") && t.get("hostId") == n.get("primaryReplica") && t.get("primaryEpoch") == n.get("primaryEpoch") && t.get("dataIncarnation") == n.get("dataIncarnation");
		return if same { Ok((id, None, version)) } else { Err(conflict("conflicting notice for an adopted replica configuration version")) };
	}
	let field = |k: &str| n.get(k).cloned().unwrap_or(Json::Null);
	let standby = n.get("standbyReplica").filter(|s| phi_core::space::truthy(Some(s))).cloned();
	let mut replication = obj! { "primaryReplica" => field("primaryReplica"), "replicaConfigVersion" => field("replicaConfigVersion"), "durability" => field("durability") };
	let ro = replication.as_object_mut().expect("an object");
	if let Some(s) = &standby {
		ro.insert("standbyReplica", s.clone());
	}
	if let Some(b) = r.get("backupReplica").filter(|b| phi_core::space::truthy(Some(b))) {
		ro.insert("backupReplica", b.clone());
	}
	ro.insert("recoveryId", field("recoveryId"));
	let mut target = t.as_object().cloned().unwrap_or_default();
	target.insert("hostId", field("primaryReplica"));
	target.insert("primaryEpoch", field("primaryEpoch"));
	target.insert("dataIncarnation", field("dataIncarnation"));
	let mut member = m.as_object().cloned().unwrap_or_default();
	member.insert("replication", replication);
	member.insert("target", Json::Object(target));
	// primary rules of this Member carry the same replica configuration and follow it in the same commit
	let rules: Vec<Json> = policy.get("rules").and_then(Json::as_array).cloned().unwrap_or_default().into_iter().map(|rule| {
		if text(&rule, "mode") != Some("sync") || text(&rule, "variant") != Some("primary") || text(&rule, "member") != Some(id.as_str()) {
			return rule;
		}
		let mut o = rule.as_object().cloned().unwrap_or_default();
		o.remove("standbyReplica");
		o.insert("primaryReplica", field("primaryReplica"));
		o.insert("replicaConfigVersion", field("replicaConfigVersion"));
		o.insert("durability", field("durability"));
		if let Some(s) = &standby {
			o.insert("standbyReplica", s.clone());
		}
		Json::Object(o)
	}).collect();
	let next_version = version + 1.0;
	let mut p = policy.as_object().cloned().unwrap_or_default();
	p.insert("rules", Json::Array(rules));
	p.insert("policyVersion", Json::Number(next_version));
	let mut doc = routing.as_object().cloned().unwrap_or_default();
	let mut all = members.clone();
	all.insert(id.as_str(), Json::Object(member));
	doc.insert("members", Json::Object(all));
	doc.insert("policy", Json::Object(p));
	let mut notices: Vec<Json> = routing.get("noticePolicyVersions").and_then(Json::as_array).cloned().unwrap_or_default();
	notices.push(Json::Number(next_version));
	let keep = notices.len().saturating_sub(256);
	doc.insert("noticePolicyVersions", Json::Array(notices.split_off(keep)));
	Ok((id, Some(Json::Object(doc)), next_version))
}
