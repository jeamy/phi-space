//! The controlled replacement of completion profiles (src/profile-transition.ts): every Member freezes, installs and resumes under a
//! signed instruction, the policy goes up in between. A journalled operation, so a retry goes on where it stood; nothing remote runs
//! inside a commit.
use crate::auth::{seal, verify_value, Signer};
use crate::federated_space::OPERATIONS;
use crate::membership::validate_profile_only_change;
use crate::membership_control::{MembershipEnv, JOURNAL, ROUTING};
use crate::router::Tx;
use phi_core::policy::validate_federation_policy;
use phi_core::routing::parent_journal_key;
use phi_core::space::{routing, CoreError};
use phi_json::{digest_json, num_of, obj, text, Json, Object};
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
pub const PROFILES: &str = "phi-spaces.profile-transitions";
const MAX_HISTORY: usize = 32;

fn hash(v: Option<&Json>) -> R<String> { digest_json(v.unwrap_or(&Json::Null)).map_err(|_| routing("a value that cannot be hashed")) }
use crate::federated_space::{empty_operations_only as empty_operations, empty_routing};
fn ops(d: &Json) -> Vec<(&str, &Json)> { d.get("operations").and_then(Json::as_object).map_or(vec![], |o| o.iter().collect()) }
fn op_of(d: &Json, id: &str) -> Option<Json> { d.get("operations").and_then(|o| o.get(id)).cloned() }
fn put(d: &mut Json, id: &str, op: Json) {
	if let Some(Json::Object(o)) = d.as_object_mut().and_then(|o| o.get_mut("operations")) {
		o.insert(id, op);
	}
}
use phi_json::set;
fn with(p: &Json, k: &str, x: Json) -> Json {
	let mut c = p.clone();
	set(&mut c, k, x);
	c
}
fn valid_id(id: &str) -> bool { phi_json::SLUG_64_KEY.accepts(id) }
fn members_of(op: &Json) -> &[Json] { op.get("members").and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn targets_moved(op: &Json, state: &Json) -> R<bool> {
	for m in members_of(op) {
		let held = state.get("members").and_then(|t| t.get(text(m, "id").unwrap_or(""))).and_then(|x| x.get("target"));
		if hash(held)? != hash(m.get("target"))? {
			return Ok(true);
		}
	}
	Ok(false)
}
/// `Root work must settle`: no parent open, no transaction left without its end.
fn unsettled(parents: &[Json]) -> bool {
	let closes = |p: &Json, d: &Json| text(d, "kind") == Some("txn") && d.get("args").is_some_and(|a| a.get("originId") == p.get("id") && matches!(text(a, "action"), Some("commit" | "abort")));
	parents.iter().any(|p| text(p, "phase") != Some("done")) || parents.iter().any(|p| text(p, "kind") == Some("txn") && p.get("args").and_then(|a| text(a, "action")) == Some("begin") && !parents.iter().any(|d| closes(p, d)))
}

pub struct ProfileTransitionController<E: MembershipEnv> {
	pub env: E,
	pub control_space: String,
	pub authority_id: String,
	pub federation_id: String,
	pub partitions: f64,
	pub peer_id: String,
	pub signer: Rc<Signer>,
}

impl<E: MembershipEnv> ProfileTransitionController<E> {
	async fn check(&self) -> R<()> {
		self.env.authorize().await?;
		self.env.assert_authority().await
	}

	pub async fn start(&self, id: &str, next: &Json) -> R<Json> {
		if !valid_id(id) {
			return Err(routing("invalid profile transition ID"));
		}
		self.check().await?;
		self.check().await?;
		let space = &self.control_space;
		let mut tx = Tx::new(&self.env);
		let ledger = tx.doc(PROFILES, space, empty_operations)?;
		let h = hash(Some(next))?;
		if let Some(old) = op_of(tx.at(ledger), id) {
			if text(&old, "hash") != Some(&h) {
				return Err(routing("profile transition ID changed policy"));
			}
			return Ok(old);
		}
		let open = ops(tx.at(ledger));
		if open.iter().any(|(_, o)| text(o, "phase") != Some("completed")) || open.len() >= MAX_HISTORY {
			return Err(routing("profile transition already active or history full"));
		}
		let at = tx.doc(ROUTING, space, empty_routing)?;
		let state = tx.at(at).clone();
		let policy = state.get("policy").filter(|p| !p.is_null() && text(p, "authorityId") == Some(&self.authority_id)).ok_or_else(|| routing("profile transition authority missing"))?;
		validate_profile_only_change(policy, next)?;
		let empty = Json::Object(Object::new());
		let table = state.get("members").unwrap_or(&empty);
		validate_federation_policy(&with(next, "policyVersion", 1.0.into()), table, None, &[], false)?;
		validate_federation_policy(&with(next, "completionProfiles", policy.get("completionProfiles").cloned().unwrap_or(Json::Null)), table, Some(policy), &[], false)?;
		let members: Vec<Json> = table.as_object().map_or(vec![], |t| t.iter().map(|(_, m)| m.clone()).collect());
		if members.is_empty() || members.iter().any(|m| text(m, "state") != Some("active")) {
			return Err(routing("all Members must be active before profile transition"));
		}
		let journal = tx.doc(JOURNAL, space, empty_operations)?;
		if ops(tx.at(journal)).iter().any(|(_, o)| !matches!(text(o, "phase"), Some("completed" | "failed"))) {
			return Err(routing("membership transition is pending"));
		}
		let mut parents = vec![];
		for n in 0..self.partitions as u64 {
			let key = parent_journal_key(&self.federation_id, self.partitions, n as f64)?;
			let d = tx.doc(OPERATIONS, &key, empty_operations)?;
			parents.extend(ops(tx.at(d)).into_iter().map(|(_, o)| o.clone()));
		}
		if unsettled(&parents) {
			return Err(routing("Root work must settle before profile transition"));
		}
		let op = obj! { "hash" => h, "oldPolicy" => policy.clone(), "nextPolicy" => next.clone(), "members" => Json::Array(members), "phase" => "freezing", "cursor" => 0.0 };
		put(tx.at(ledger), id, op.clone());
		tx.commit()?;
		Ok(op)
	}

	/// The policy goes up: from here on the Members are told to resume.
	fn publish(&self, id: &str) -> R<Json> {
		let space = &self.control_space;
		let mut tx = Tx::new(&self.env);
		let d = tx.doc(PROFILES, space, empty_operations)?;
		let mut op = op_of(tx.at(d), id).ok_or_else(|| routing("unknown profile transition"))?;
		let at = tx.doc(ROUTING, space, empty_routing)?;
		let state = tx.at(at).clone();
		if hash(state.get("policy"))? != hash(op.get("oldPolicy"))? || targets_moved(&op, &state)? {
			return Err(routing("profile transition policy or targets changed; remain frozen"));
		}
		let next = op.get("nextPolicy").cloned().unwrap_or(Json::Null);
		tx.policy_version = num_of(&next, "policyVersion");
		set(tx.at(at), "policy", next);
		set(&mut op, "phase", "resuming");
		set(&mut op, "cursor", 0.0);
		put(tx.at(d), id, op.clone());
		tx.commit()?;
		Ok(op)
	}

	pub async fn advance(&self, id: &str) -> R<Json> {
		self.check().await?;
		let space = &self.control_space;
		let ledger = self.env.read(PROFILES, space)?.unwrap_or_else(empty_operations);
		let current = op_of(&ledger, id).ok_or_else(|| routing("unknown profile transition"))?;
		let phase = text(&current, "phase").unwrap_or("").to_owned();
		match phase.as_str() {
			"completed" => return Ok(current),
			"publishing" => {
				self.check().await?;
				return self.publish(id);
			}
			_ => {}
		}
		let action = match phase.as_str() { "freezing" => "profileFreeze", "installing" => "profileInstall", _ => "profileResume" };
		let null = Json::Null;
		let cursor = num_of(&current, "cursor").unwrap_or(0.0);
		let member = members_of(&current).get(cursor as usize).unwrap_or(&null);
		let target = member.get("target").unwrap_or(&null);
		let instruction = obj! { "id" => id, "authorityId" => self.authority_id.as_str(), "memberId" => member.get("id").cloned().unwrap_or(Json::Null), "spaceId" => target.get("spaceId").cloned().unwrap_or(Json::Null), "action" => action, "policy" => current.get("nextPolicy").cloned().unwrap_or(Json::Null), "previousPolicy" => current.get("oldPolicy").cloned().unwrap_or(Json::Null) };
		let pin = self.env.pin(member).await?;
		let signed = seal("value", instruction.clone(), "membership-instruction", &self.peer_id, &self.signer).ok_or_else(|| routing("invalid membership signature"))?;
		let reply = self.env.apply(member, signed).await?;
		let proof = verify_value(&reply, "membership-proof", &pin.issuer, pin.algorithm, &pin.public_key).cloned().ok_or_else(|| routing("invalid membership signature"))?;
		let state = if action == "profileResume" { "active" } else { "profileFrozen" };
		if text(&proof, "id") != Some(id) || ["authorityId", "memberId", "spaceId"].iter().any(|k| proof.get(k) != instruction.get(k)) || text(&proof, "action") != Some(action) || text(&proof, "state") != Some(state) {
			return Err(routing("profile transition proof binding mismatch"));
		}
		self.check().await?;
		let mut tx = Tx::new(&self.env);
		let d = tx.doc(PROFILES, space, empty_operations)?;
		let mut op = op_of(tx.at(d), id).ok_or_else(|| routing("profile transition changed"))?;
		if op.get("hash") != current.get("hash") {
			return Err(routing("profile transition changed"));
		}
		if op.get("phase") != current.get("phase") || op.get("cursor") != current.get("cursor") {
			return Ok(op);
		}
		let at = tx.doc(ROUTING, space, empty_routing)?;
		if targets_moved(&op, tx.at(at))? {
			return Err(routing("profile transition target changed; remain frozen"));
		}
		if (cursor + 1.0) as usize == members_of(&op).len() {
			let after = match phase.as_str() { "freezing" => "installing", "installing" => "publishing", _ => "completed" };
			set(&mut op, "cursor", 0.0);
			set(&mut op, "phase", after);
		} else {
			set(&mut op, "cursor", cursor + 1.0);
		}
		put(tx.at(d), id, op.clone());
		tx.commit()?;
		Ok(op)
	}

	pub async fn execute(&self, id: &str, next: &Json) -> R<Json> {
		self.start(id, next).await?;
		loop {
			let op = self.advance(id).await?;
			if text(&op, "phase") == Some("completed") {
				return Ok(op);
			}
		}
	}
}
