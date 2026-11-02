//! The Member side of membership (src/membership.ts): only pinned Control instructions change admission, and an uncertain
//! transition stays frozen. Each step is one commit of the Space and the journal of its proofs, so a repeated instruction
//! gets the proof it got before. The controller's side (R6) is not here.
use phi_json::text;
use phi_core::space::routing;
use crate::auth::{seal, signed_by, verify_value, Signer};
use crate::control::{held_document, take};
use crate::run_member::{AuthorityCheck, Pin};
use phi_core::member::declared_supertypes;
use phi_core::space::{error, CoreError, Space};
use phi_core::state::SpaceState;
use phi_json::{digest_json, obj, Json, Object};
use phi_service::Service;
use phi_store::system_random;
use std::cell::RefCell;
use std::collections::HashSet;

type R<T> = Result<T, CoreError>;
const JOURNAL: &str = "phi-spaces.member-transitions";
fn migration(m: impl Into<String>) -> CoreError { error("MigrationRequired", m) }
fn number(v: &Json, k: &str) -> f64 { v.get(k).and_then(Json::as_f64).unwrap_or(0.0) }
fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| routing("a value that cannot be hashed")) }
fn same(a: Option<&Json>, b: Option<&Json>) -> R<bool> { Ok(hash(a.unwrap_or(&Json::Null))? == hash(b.unwrap_or(&Json::Null))?) }

/// `verifyMembership`.
fn verify_membership(kind: &str, t: &Json, pin: &Pin) -> R<Json> {
	verify_value(t, &format!("membership-{kind}"), &pin.issuer, pin.algorithm, &pin.public_key)
		.cloned().ok_or_else(|| routing("invalid membership signature"))
}

/// `verifyFederationPolicy`: the Control host signed it for this authority.
pub fn verify_federation_policy(t: &Json, authority_id: &str, pin: &Pin) -> R<Json> {
	let bad = || routing("policy signature/authority/version mismatch");
	let Some(policy) = t.get("policy") else { return Err(bad()) };
	if text(policy, "authorityId") != Some(authority_id) || number(policy, "policyVersion") < 1.0 || !signed_by(policy, t, "federation-policy", &pin.issuer, pin.algorithm, &pin.public_key) {
		return Err(bad());
	}
	Ok(policy.clone())
}

fn profiles(p: &Json) -> &[Json] { p.get("completionProfiles").and_then(Json::as_array).map_or(&[], Vec::as_slice) }
fn profile_of<'a>(p: &'a Json, task: Option<&str>) -> Option<&'a Json> { profiles(p).iter().find(|f| text(f, "taskType") == task) }

/// `assertOrdinaryProfiles`: an ordinary policy leaves existing profiles alone.
fn assert_ordinary_profiles(old: &Json, next: &Json) -> R<()> {
	for p in profiles(old) {
		if !same(Some(p), profile_of(next, text(p, "taskType")))? {
			return Err(migration("existing profile requires controlled transition"));
		}
	}
	let rules = old.get("rules").and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
	for p in profiles(next) {
		let task = text(p, "taskType");
		if profile_of(old, task).is_none() && rules.iter().any(|r| text(r, "type") == task) {
			return Err(migration("existing Task requires controlled transition"));
		}
	}
	Ok(())
}

/// `validateProfileOnlyChange`: the task types it touches. A controlled transition changes nothing but the profiles.
pub fn validate_profile_only_change(old: &Json, next: &Json) -> R<Vec<String>> {
	let mut expected = old.as_object().cloned().unwrap_or_default();
	expected.insert("policyVersion", next.get("policyVersion").cloned().unwrap_or(Json::Null));
	expected.insert("completionProfiles", next.get("completionProfiles").cloned().unwrap_or(Json::Null));
	if number(next, "policyVersion") != number(old, "policyVersion") + 1.0 || Json::Object(expected).canonical().ok() != next.canonical().ok() {
		return Err(routing("profile transition may only change profiles and advance one policy version"));
	}
	Space::new(SpaceState::initial(), system_random()).set_completion_profiles(0.0, next.get("completionProfiles"))?;
	let mut types = vec![];
	for p in profiles(old).iter().chain(profiles(next)) {
		if let Some(t) = text(p, "taskType").filter(|t| !types.iter().any(|x: &String| x == t)) {
			types.push(t.to_owned());
		}
	}
	Ok(types)
}

fn is_directory(type_: &str) -> bool { type_ == "Capability" || type_ == "MemberStatus" }
fn jobs(s: &Space, key: &str) -> usize { s.state.rest.get(key).and_then(Json::as_array).map_or(0, Vec::len) }
fn open_work(s: &Space) -> bool { !s.state.txns.is_empty() || !s.state.waiters.is_empty() || !s.pending_claims().is_empty() || jobs(s, "jobs") > 0 }

/// The membership of a commit; written back when the action is done.
struct Step<'a> {
	s: &'a mut Space,
	a: Option<Object>,
}

impl Step<'_> {
	fn state(&self) -> Option<&str> { self.a.as_ref()?.get("state")?.as_str() }
	fn get(&self, k: &str) -> Option<&Json> { self.a.as_ref()?.get(k) }
	fn set(&mut self, k: &str, v: Json) {
		if let Some(a) = &mut self.a {
			a.insert(k, v);
		}
	}
	fn advance(&mut self) { self.set("admissionVersion", Json::Number(self.version() + 1.0)); }
	fn version(&self) -> f64 { self.get("admissionVersion").and_then(Json::as_f64).unwrap_or(0.0) }
	fn policy(&self) -> Option<Json> { self.get("policy").filter(|p| !p.is_null()).cloned() }
	fn transition(&self) -> Option<&str> { self.get("transitionId")?.as_str() }
	fn install(&mut self, policy: &Json) -> R<()> {
		self.s.assert_gated_profiles_kept(profiles(policy))?;
		self.s.state.rest.insert("completionProfiles", policy.get("completionProfiles").cloned().unwrap_or(Json::Array(vec![])));
		Ok(())
	}
}

/// One per Space of a Member.
pub struct MemberLifecycle {
	pub member_id: String,
	pub authority_id: String,
	pub peer_id: String,
	pub signer: Signer,
	pub control: Pin,
	pub assert_authority: AuthorityCheck,
	/// The journal by Space: what the file says, and what this process added since.
	journal: RefCell<Option<Json>>,
	space_id: String,
}

impl MemberLifecycle {
	pub fn new(member_id: &str, space_id: &str, authority_id: &str, peer_id: &str, signer: Signer, control: Pin, assert_authority: AuthorityCheck) -> MemberLifecycle {
		MemberLifecycle { member_id: member_id.to_owned(), authority_id: authority_id.to_owned(), peer_id: peer_id.to_owned(), signer, control, assert_authority, journal: RefCell::new(None), space_id: space_id.to_owned() }
	}

	fn journal(&self, service: &Service) -> R<Json> {
		held_document(&self.journal, &service.store, JOURNAL, Some(&self.space_id), |d| d.unwrap_or_else(|| obj! { "steps" => obj! {} }))
	}

	/// `installPolicy`: a signed policy of the Control host, on a serving Member.
	pub fn install_policy(&self, service: &mut Service, token: &Json) -> R<()> {
		let p = verify_federation_policy(token, &self.authority_id, &self.control)?;
		(self.assert_authority)(service)?;
		let id = self.space_id.clone();
		let installed = service.store.reader(Some(&id))?.space.state.rest.get("membership").cloned();
		let serving = |a: &Json| matches!(text(a, "state"), Some("active" | "draining"));
		if let Some(a) = installed.as_ref().filter(|a| serving(a)) {
			if a.get("policy").and_then(|x| x.get("policyVersion")) == p.get("policyVersion") && same(Some(&p), a.get("policy"))? {
				return (self.assert_authority)(service);
			}
		}
		service.commit_on(Some(&id), |s, now| {
			let Some(a) = s.state.rest.get("membership").and_then(Json::as_object).cloned().filter(|a| matches!(a.get("state").and_then(Json::as_str), Some("active" | "draining"))) else { return Ok(()) };
			let old = a.get("policy").filter(|x| !x.is_null()).cloned();
			let version = old.as_ref().map_or(0.0, |o| number(o, "policyVersion"));
			if number(&p, "policyVersion") < version {
				return Err(routing("installed policy cannot regress"));
			}
			if number(&p, "policyVersion") == version {
				if !same(Some(&p), old.as_ref())? {
					return Err(routing("policy changed within version"));
				}
				return Ok(());
			}
			if let Some(o) = &old {
				assert_ordinary_profiles(o, &p)?;
			}
			let mut step = Step { s, a: Some(a) };
			step.set("policy", p.clone());
			step.install(&p)?;
			let a = step.a.take().expect("set above");
			s.state.rest.insert("membership", Json::Object(a));
			s.touch(now);
			Ok(())
		})
	}

	fn action(&self, q: &Json, step: &mut Step, floor: f64, now: f64) -> R<()> {
		let action = text(q, "action").unwrap_or("");
		let id = text(q, "id").unwrap_or("");
		let policy = q.get("policy").filter(|p| !p.is_null());
		match action {
			"prepareAdd" => {
				if step.a.is_some() && step.state() != Some("detached") {
					return Err(routing("Member is already managed or frozen"));
				}
				if open_work(step.s) {
					return Err(routing("local work must settle before adding"));
				}
				let version = floor.max(step.version()) + 1.0;
				let mut a = Object::new();
				a.insert("memberId", q.get("memberId").cloned().unwrap_or(Json::Null));
				a.insert("authorityId", q.get("authorityId").cloned().unwrap_or(Json::Null));
				a.insert("policy", Json::Null);
				a.insert("state", "adding".into());
				a.insert("admissionVersion", Json::Number(version));
				a.insert("transitionId", id.into());
				step.a = Some(a);
			}
			"rejectAdd" => {
				if step.state() != Some("adding") || step.transition() != Some(id) {
					return Err(routing("only matching uncommitted add may be rejected"));
				}
				step.a = None;
			}
			"activate" => {
				let policy = policy.filter(|p| step.state() == Some("adding") && step.transition() == Some(id) && p.get("authorityId") == q.get("authorityId")).ok_or_else(|| routing("activation needs matching frozen add"))?;
				step.set("policy", policy.clone());
				step.set("state", "active".into());
				let entries: Vec<_> = step.s.state.entries.iter().filter(|e| !is_directory(&e.type_)).cloned().collect();
				// every stock entry must lie where the policy places it, as if it were written now
				let mut a = step.a.clone().map(Json::Object).unwrap_or(Json::Null);
				std::mem::swap(step.s.state.rest.get_mut("membership").expect("adding"), &mut a);
				let checked = entries.iter().try_for_each(|e| {
					let parents = declared_supertypes(policy, &e.type_, &[])?;
					if e.types.iter().any(|t| *t != e.type_ && !parents.contains(t)) {
						return Err(routing("entry supertypes must be declared by its rule"));
					}
					let draft = obj! { "type" => e.type_.as_str(), "types" => Json::Array(parents.iter().map(|t| t.as_str().into()).collect()), "fields" => Json::Object(e.fields.clone()) };
					step.s.assert_member_write(&draft, &e.type_, &parents, &e.fields, e.written_under.as_deref(), now)
				});
				std::mem::swap(step.s.state.rest.get_mut("membership").expect("adding"), &mut a);
				checked?;
				step.install(policy)?;
				step.advance();
			}
			"profileFreeze" => {
				let (Some(current), Some(next), Some("active")) = (step.policy(), policy, step.state()) else { return Err(routing("profile freeze requires active policy")) };
				let base = q.get("previousPolicy").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| current.clone());
				if base.get("authorityId") != step.get("authorityId") || number(&base, "policyVersion") < number(&current, "policyVersion") || (number(&base, "policyVersion") == number(&current, "policyVersion") && !same(Some(&base), Some(&current))?) {
					return Err(routing("profile predecessor disagrees with installed policy"));
				}
				assert_ordinary_profiles(&current, &base)?;
				let affected = validate_profile_only_change(&base, next)?;
				let s = &step.s;
				let touched = s.state.entries.iter().any(|e| affected.iter().any(|t| e.types.contains(t)));
				if open_work(s) || !s.state.regs.is_empty() || jobs(s, "releaseQueue") > 0 || touched {
					return Err(routing("profile transition requires no affected Tasks or open work"));
				}
				step.set("policy", base);
				step.set("state", "profileFrozen".into());
				step.set("profileTransition", obj! { "id" => id, "hash" => hash(next)? });
				step.advance();
			}
			"profileInstall" => {
				let frozen = step.get("profileTransition").cloned();
				let (Some(current), Some(next), Some("profileFrozen")) = (step.policy(), policy, step.state()) else { return Err(routing("profile install requires matching frozen transition")) };
				if frozen.as_ref().and_then(|t| text(t, "id")) != Some(id) || frozen.as_ref().and_then(|t| text(t, "hash")) != Some(&hash(next)?) {
					return Err(routing("profile install requires matching frozen transition"));
				}
				validate_profile_only_change(&current, next)?;
				step.set("policy", next.clone());
				step.install(next)?;
				step.advance();
			}
			"profileResume" => {
				let frozen = step.get("profileTransition").cloned();
				let Some(next) = policy.filter(|_| step.state() == Some("profileFrozen")) else { return Err(routing("profile resume requires installed transition")) };
				if frozen.as_ref().and_then(|t| text(t, "id")) != Some(id) || !same(step.get("policy"), Some(next))? || frozen.as_ref().and_then(|t| text(t, "hash")) != Some(&hash(next)?) {
					return Err(routing("profile resume requires installed transition"));
				}
				step.set("state", "active".into());
				if let Some(a) = &mut step.a {
					a.remove("profileTransition");
				}
				step.advance();
			}
			"policy" => {
				let held = step.policy();
				let version = held.as_ref().map_or(0.0, |p| number(p, "policyVersion"));
				let next = policy.filter(|p| matches!(step.state(), Some("active" | "draining")) && p.get("authorityId") == step.get("authorityId") && number(p, "policyVersion") >= version).ok_or_else(|| routing("invalid installed policy transition"))?;
				if number(next, "policyVersion") == version && !same(Some(next), held.as_ref())? {
					return Err(routing("policy version changed content"));
				}
				if let Some(p) = &held {
					assert_ordinary_profiles(p, next)?;
				}
				step.set("policy", next.clone());
				step.install(next)?;
			}
			"drain" => {
				if step.state() != Some("active") {
					return Err(routing("drain requires active Member"));
				}
				step.set("state", "draining".into());
				step.advance();
				let version = step.version();
				step.set("transitionId", id.into());
				step.set("drainAt", Json::Number(now));
				let rev = step.s.state.stream.as_ref().map_or(0.0, |s| s.rev);
				step.set("cutRevision", Json::Number(rev));
				for t in &mut step.s.state.txns {
					let until = t.expires.min(now + 60_000.0);
					let held = t.rest.get("completion").and_then(Json::as_object).cloned();
					let mut c = held.unwrap_or_else(|| {
						let mut c = Object::new();
						c.insert("admissionVersion", Json::Number(version - 1.0));
						c.insert("until", Json::Number(until));
						c.insert("remainingBytes", Json::Number(65536.0));
						c.insert("remainingCount", Json::Number(8.0));
						c.insert("preBoundary", Json::Bool(true));
						c
					});
					c.insert("until", Json::Number(until));
					c.insert("preBoundary", Json::Bool(true));
					t.rest.insert("completion", Json::Object(c));
					t.expires = t.expires.min(until);
				}
			}
			"freeze" => {
				if step.state() != Some("draining") {
					return Err(routing("freeze requires drained Member"));
				}
				let capabilities: Vec<(String, String)> = step.s.state.entries.iter().filter(|e| e.type_ == "Capability").map(|e| (e.id.clone(), e.type_.clone())).collect();
				for (id, type_) in capabilities {
					take(step.s, now, &obj! { "id" => id, "type" => type_ })?;
				}
				if !step.s.state.entries.is_empty() || open_work(step.s) || jobs(step.s, "releaseQueue") > 0 {
					return Err(routing("Member still has physical entries or open work"));
				}
				step.s.close_registrations_for_removal(now)?;
				step.s.settle(now)?;
				if jobs(step.s, "jobs") > 0 {
					return Err(routing("closing registrations has pending delivery work"));
				}
				step.set("state", "removing".into());
				step.advance();
				step.set("transitionId", id.into());
			}
			"detach" => {
				if step.state() != Some("removing") || step.transition() != Some(id) {
					return Err(routing("detach requires matching removal"));
				}
				if !step.s.state.entries.is_empty() || open_work(step.s) || !step.s.state.regs.is_empty() {
					return Err(routing("EmptyProof no longer holds"));
				}
				step.set("state", "detached".into());
				step.advance();
			}
			_ => return Err(routing("unknown membership action")),
		}
		Ok(())
	}

	fn proof(&self, q: &Json, s: &Space, admission: f64) -> Json {
		let kept = || s.state.entries.iter().filter(|e| !is_directory(&e.type_));
		let mut types: Vec<String> = kept().flat_map(|e| e.types.iter().cloned()).collect::<HashSet<_>>().into_iter().collect();
		types.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
		let stock = if text(q, "action") == Some("prepareAdd") {
			kept().map(|e| obj! { "type" => e.type_.as_str(), "types" => Json::Array(e.types.iter().map(|t| t.as_str().into()).collect()), "fields" => Json::Object(e.fields.clone()) }).collect()
		} else {
			vec![]
		};
		let or_null = |k: &str| q.get(k).cloned().unwrap_or(Json::Null);
		let empty = s.state.entries.is_empty() && !open_work(s) && s.state.regs.is_empty();
		obj! {
			"id" => or_null("id"), "authorityId" => or_null("authorityId"), "memberId" => or_null("memberId"), "spaceId" => or_null("spaceId"), "action" => or_null("action"),
			"admissionVersion" => admission, "revision" => s.state.stream.as_ref().map_or(0.0, |r| r.rev), "entryTypes" => Json::Array(types.iter().map(|t| t.as_str().into()).collect()),
			"stock" => Json::Array(stock), "empty" => empty, "state" => s.member_state_or_local()
		}
	}

	/// `apply`: a signed instruction, and the signed proof of what it did.
	pub fn apply(&self, service: &mut Service, t: &Json) -> R<Json> {
		let q = verify_membership("instruction", t, &self.control)?;
		let id = text(&q, "id").unwrap_or("");
		if text(&q, "authorityId") != Some(&self.authority_id) || text(&q, "memberId") != Some(&self.member_id) || text(&q, "spaceId") != Some(&self.space_id) || id.is_empty() || id.encode_utf16().count() > 128 {
			return Err(routing("membership instruction binding mismatch"));
		}
		let key = hash(&Json::Array(vec![id.into(), q.get("action").cloned().unwrap_or(Json::Null)]))?;
		let instruction = hash(&q)?;
		(self.assert_authority)(service)?;
		let journal = self.journal(service)?;
		let steps = journal.get("steps").and_then(Json::as_object).cloned().unwrap_or_default();
		let proof = if let Some(step) = steps.get(&key) {
			if text(step, "hash") != Some(&instruction) {
				return Err(routing("transition ID changed instruction"));
			}
			step.get("proof").cloned().unwrap_or(Json::Null)
		} else {
			if steps.len() >= 128 {
				return Err(routing("transition history full"));
			}
			let floor = journal.get("admissionVersion").and_then(Json::as_f64).unwrap_or(0.0);
			let space = self.space_id.clone();
			let (proof, next) = service.commit_on(Some(&space), |s, now| {
				s.settle(now)?;
				let a = s.state.rest.get("membership").and_then(Json::as_object).cloned();
				let before = a.as_ref().and_then(|a| a.get("admissionVersion")).and_then(Json::as_f64).unwrap_or(0.0);
				if let Some(expected) = q.get("expectedAdmissionVersion").and_then(Json::as_f64) {
					if before != expected {
						return Err(routing("admission version mismatch"));
					}
				}
				let mut step = Step { s, a };
				self.action(&q, &mut step, floor, now)?;
				let a = step.a.take();
				let after = a.as_ref().and_then(|a| a.get("admissionVersion")).and_then(Json::as_f64).unwrap_or(before + 1.0);
				match a {
					Some(a) => s.state.rest.insert("membership", Json::Object(a)),
					None => {
						s.state.rest.remove("membership");
					}
				}
				let admission = floor.max(after);
				s.touch(now);
				let proof = self.proof(&q, s, admission);
				if proof.get("stock").map_or(0, |v| v.to_json_text().len()) > 65536 {
					return Err(routing("stock proof exceeds inspection budget"));
				}
				let mut steps = steps.clone();
				steps.insert(key.as_str(), obj! { "hash" => instruction.as_str(), "proof" => proof.clone() });
				let mut next = Object::new();
				next.insert("steps", Json::Object(steps));
				next.insert("admissionVersion", Json::Number(admission));
				let next = Json::Object(next);
				s.doc_writes.push((JOURNAL.to_owned(), self.space_id.clone(), 1, next.to_json_text()));
				Ok((proof, next))
			})?;
			*self.journal.borrow_mut() = Some(next);
			proof
		};
		(self.assert_authority)(service)?;
		seal("value", proof, "membership-proof", &self.peer_id, &self.signer).ok_or_else(|| routing("invalid membership signature"))
	}

}
