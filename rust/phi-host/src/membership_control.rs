//! The controller side of membership (`MembershipController` of src/membership.ts): adding, draining and removing a Member, each a
//! journalled transition whose every instruction is signed and answered by a signed proof, so a retry after a crash goes on where it stood.
use crate::auth::{seal, verify_value, Signer};
use crate::router::{RouterEnv, Tx};
use crate::run_member::Pin;
use phi_core::member::{hrw, rule_for};
use phi_core::policy::validate_federation_policy;
use phi_core::routing::normalize_federated_entry;
use phi_core::space::{error, routing, CoreError};
use phi_json::{digest_json, num_of, obj, text, Json, Object};
use phi_wire::Local;
use std::rc::Rc;

type R<T> = Result<T, CoreError>;
pub const JOURNAL: &str = "phi-spaces.membership-journal";
pub const ROUTING: &str = "phi-spaces.federation-routing";
const PROFILES: &str = "phi-spaces.profile-transitions";
const MAX_HISTORY: usize = 64;

fn hash(v: &Json) -> R<String> { digest_json(v).map_err(|_| routing("a value that cannot be hashed")) }
fn set(v: &mut Json, k: &str, x: impl Into<Json>) {
	if let Json::Object(o) = v {
		o.insert(k, x.into());
	}
}
fn empty_operations() -> Json { obj! { "operations" => Object::new() } }
fn empty_routing() -> Json { obj! { "policy" => Json::Null, "members" => Object::new() } }
fn ops_of(d: &Json) -> Vec<(&str, &Json)> { d.get("operations").and_then(Json::as_object).map_or(vec![], |o| o.iter().collect()) }
fn put_op(d: &mut Json, id: &str, op: &Json) {
	if let Some(Json::Object(o)) = d.as_object_mut().and_then(|o| o.get_mut("operations")) {
		o.insert(id, op.clone());
	}
}
fn valid_id(id: &str) -> bool {
	let mut c = id.chars();
	c.next().is_some_and(|f| f.is_ascii_alphanumeric()) && id.len() <= 128 && c.all(|x| x.is_ascii_alphanumeric() || "._:-".contains(x)) && !["constructor", "prototype", "__proto__"].contains(&id)
}
fn member_state<'a>(state: &'a Json, id: &str) -> Option<&'a Json> { state.get("members").and_then(|m| m.get(id)) }
fn set_member_state(d: &mut Json, id: &str, to: &str) -> R<()> {
	let m = d.as_object_mut().and_then(|o| o.get_mut("members")).and_then(Json::as_object_mut).and_then(|m| m.get_mut(id)).ok_or_else(|| routing("unregistered Member"))?;
	set(m, "state", to);
	Ok(())
}
fn stock_of(op: &Json) -> Vec<Json> { op.get("proof").and_then(|p| p.get("stock")).and_then(Json::as_array).cloned().unwrap_or_default() }
fn policy_push_id(id: &str, version: f64) -> R<String> { Ok(format!("policy.{}", &hash(&Json::Array(vec![id.into(), version.into()]))?[..48])) }

/// What the controller asks of the Members and of the admin around it.
pub trait MembershipEnv: RouterEnv {
	fn apply(&self, member: &Json, signed: Json) -> Local<R<Json>>;
	fn pin(&self, member: &Json) -> Local<R<Pin>>;
	/// Is an administrator behind this command, now.
	fn authorize(&self) -> Local<R<()>>;
	/// `memberReferencesIn`.
	fn has_references(&self, member_id: &str, space_id: &str) -> R<bool>;
}

pub struct MembershipController<E: MembershipEnv> {
	pub env: E,
	pub control_space: String,
	pub authority_id: String,
	pub peer_id: String,
	pub signer: Rc<Signer>,
}

impl<E: MembershipEnv> MembershipController<E> {
	fn no_open_profile(&self, tx: &mut Tx<'_>, message: &str) -> R<()> {
		let at = tx.doc(PROFILES, &self.control_space, empty_operations)?;
		if ops_of(tx.at(at)).iter().any(|(_, o)| text(o, "phase") != Some("completed")) {
			return Err(routing(message));
		}
		Ok(())
	}
	async fn change<T>(&self, f: impl FnOnce(&mut Json) -> R<T>) -> R<T> {
		self.env.assert_authority().await?;
		self.env.authorize().await?;
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		self.no_open_profile(&mut tx, "profile transition blocks membership changes")?;
		let at = tx.doc(JOURNAL, &self.control_space, empty_operations)?;
		let r = f(tx.at(at))?;
		tx.commit()?;
		Ok(r)
	}
	/// A commit of the routing and the journal.
	async fn transition(&self, f: impl FnOnce(&mut Tx<'_>, &mut Json) -> R<()>, id: &str, op: &Json) -> R<()> {
		self.env.assert_authority().await?;
		let mut tx = Tx::new(&self.env);
		let at = tx.doc(ROUTING, &self.control_space, empty_routing)?;
		let mut d = std::mem::replace(tx.at(at), Json::Null);
		f(&mut tx, &mut d)?;
		*tx.at(at) = d;
		let j = tx.doc(JOURNAL, &self.control_space, empty_operations)?;
		put_op(tx.at(j), id, op);
		tx.commit()
	}
	/// `applyFederationPolicyIn`.
	fn apply_policy_in(&self, tx: &mut Tx<'_>, d: &mut Json, p: &Json, expected: f64, allowed: &[String]) -> R<()> {
		self.no_open_profile(tx, "profile transition blocks ordinary policy changes")?;
		let installed = d.get("policy").filter(|x| !x.is_null());
		if installed.and_then(|x| num_of(x, "policyVersion")).unwrap_or(0.0) != expected || text(p, "authorityId") != Some(&self.authority_id) {
			return Err(routing("stale policy command"));
		}
		let empty = Json::Object(Object::new());
		validate_federation_policy(p, d.get("members").unwrap_or(&empty), installed, allowed, false)?;
		set(d, "policy", p.clone());
		tx.policy_version = num_of(p, "policyVersion");
		Ok(())
	}
	async fn call(&self, id: &str, op: &Json, action: &str, policy: Option<&Json>) -> R<Json> {
		let null = Json::Null;
		let member = op.get("member").unwrap_or(&null);
		let mut q = obj! { "id" => id, "authorityId" => self.authority_id.as_str(), "memberId" => member.get("id").cloned().unwrap_or(Json::Null), "spaceId" => member.get("target").and_then(|t| t.get("spaceId")).cloned().unwrap_or(Json::Null), "action" => action };
		if let Some(p) = policy {
			set(&mut q, "policy", p.clone());
		}
		self.env.assert_authority().await?;
		let signed = seal("value", q.clone(), "membership-instruction", &self.peer_id, &self.signer).ok_or_else(|| routing("invalid membership signature"))?;
		let reply = self.env.apply(member, signed).await?;
		let pin = self.env.pin(member).await?;
		let p = verify_value(&reply, "membership-proof", &pin.issuer, pin.algorithm, &pin.public_key).cloned().ok_or_else(|| routing("invalid membership signature"))?;
		if text(&p, "id") != Some(id) || ["authorityId", "memberId", "spaceId"].iter().any(|k| p.get(k) != q.get(k)) || text(&p, "action") != Some(action) {
			return Err(routing("Member proof binding mismatch"));
		}
		Ok(p)
	}
	fn routing_state(&self) -> R<Json> { Ok(self.env.read(ROUTING, &self.control_space)?.unwrap_or_else(empty_routing)) }
	fn current_policy(&self, op: &Json) -> R<(Json, Json)> {
		let current = self.routing_state()?;
		let latest = current.get("policy").filter(|p| !p.is_null()).cloned();
		let wanted = op.get("policy").and_then(|p| num_of(p, "policyVersion")).unwrap_or(0.0);
		let Some(latest) = latest.filter(|l| text(l, "authorityId") == Some(&self.authority_id) && num_of(l, "policyVersion").unwrap_or(0.0) >= wanted) else {
			return Err(routing("installed policy is older than the committed membership policy"));
		};
		Ok((current, latest))
	}
	fn base_policy(&self, state: &Json, member_id: &str) -> Json {
		let mut p = state.get("policy").filter(|p| !p.is_null()).cloned().unwrap_or_else(|| obj! { "authorityId" => self.authority_id.as_str(), "policyVersion" => 0.0, "rules" => Vec::<Json>::new(), "completionProfiles" => Vec::<Json>::new(), "default" => obj! { "mode" => "local", "member" => member_id } });
		let version = num_of(&p, "policyVersion").unwrap_or(0.0) + 1.0;
		set(&mut p, "policyVersion", version);
		p
	}
	fn add_stock_rule(p: &mut Json, e: &Json, member_id: &str) {
		let type_ = e.get("type").cloned().unwrap_or(Json::Null);
		let rules = p.as_object_mut().and_then(|o| o.get_mut("rules")).and_then(Json::as_array_mut).expect("a policy has rules");
		if rules.iter().any(|r| r.get("type") == Some(&type_)) {
			return;
		}
		let mut rule = obj! { "type" => type_.clone() };
		if let Some(t) = e.get("types").and_then(Json::as_array) {
			set(&mut rule, "supertypes", Json::Array(t.iter().filter(|x| **x != type_).cloned().collect()));
		}
		set(&mut rule, "mode", "local");
		set(&mut rule, "member", member_id);
		rules.push(rule);
	}
	fn check_stock(&self, state: &Json, op: &Json, member_id: &str) -> R<()> {
		let mut policy = self.base_policy(state, member_id);
		let null = Json::Null;
		for e in stock_of(op) {
			Self::add_stock_rule(&mut policy, &e, member_id);
			let normalized = normalize_federated_entry(&policy, &e)?;
			let r = rule_for(&policy, text(&e, "type").unwrap_or(""));
			let members: Vec<String> = r.get("members").and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).map(str::to_owned).collect());
			let by = r.get("by");
			let target = if let Some(m) = r.get("member") {
				m.as_str().map(str::to_owned)
			} else if text(&r, "mode") == Some("expand") && by.and_then(Json::as_str) == Some("type") {
				Some(hrw(r.get("type").unwrap_or(&null), &members)?)
			} else if text(&r, "mode") == Some("expand") && by.is_some_and(|b| matches!(b, Json::Object(_))) {
				let field = by.and_then(|b| text(b, "field")).unwrap_or("");
				let v = e.get("fields").and_then(|f| f.get(field)).ok_or_else(|| routing("stock lacks placement key"))?;
				Some(hrw(v, &members)?)
			} else if !members.iter().any(|m| m == member_id) {
				return Err(routing("stock not in selection search set"));
			} else {
				None
			};
			if target.is_some_and(|t| t != member_id) {
				return Err(routing("existing stock belongs to another Member"));
			}
			let mut own: Vec<String> = e.get("types").and_then(Json::as_array).map_or(vec![], |a| a.iter().filter_map(Json::as_str).filter(|t| Some(*t) != text(&e, "type")).map(str::to_owned).collect());
			own.sort_by(|a, b| phi_json::utf16_cmp(a, b));
			if hash(&phi_json::strings(&own))? != hash(normalized.get("types").unwrap_or(&null))? {
				return Err(routing("stock has incomplete declared type hierarchy"));
			}
		}
		Ok(())
	}

	/// `execute`.
	pub async fn execute(&self, id: &str, kind: &str, member: &Json, new_default: Option<&str>) -> R<Json> {
		if !valid_id(id) {
			return Err(routing("invalid membership command ID"));
		}
		let member_id = text(member, "id").unwrap_or("").to_owned();
		if !valid_id(&member_id) || member.get("target").and_then(|t| text(t, "authorityId")) != Some(&self.authority_id) {
			return Err(routing("invalid Member identity/authority"));
		}
		let h = hash(&Json::Array(vec![kind.into(), member.clone(), new_default.map_or(Json::Null, Json::from)]))?;
		let mut op = self.change(|d| {
			if let Some((_, existing)) = ops_of(d).into_iter().find(|(k, _)| *k == id) {
				if text(existing, "hash") != Some(&h) {
					return Err(routing("command ID changed arguments"));
				}
				return Ok(existing.clone());
			}
			if ops_of(d).iter().any(|(_, o)| !matches!(text(o, "phase"), Some("completed" | "failed"))) {
				return Err(routing("unresolved membership transition"));
			}
			if ops_of(d).len() >= MAX_HISTORY {
				return Err(routing("membership history full"));
			}
			let mut o = obj! { "hash" => h.as_str(), "kind" => kind, "member" => member.clone(), "phase" => "accepted" };
			if let Some(n) = new_default.filter(|n| !n.is_empty()) {
				set(&mut o, "newDefault", n);
			}
			put_op(d, id, &o);
			Ok(o)
		}).await?;
		match text(&op, "phase") {
			Some("completed") => return Ok(op),
			Some("failed") => {
				if text(&op, "kind") == Some("add") && op.get("error").is_some() {
					self.call(id, &op, "rejectAdd", None).await?;
				}
				return Ok(op);
			}
			_ => {}
		}
		let state = self.routing_state()?;
		match kind {
			"add" => self.add(id, &mut op, member, &member_id, &state).await?,
			"drain" => {
				self.call(id, &op, "drain", None).await?;
				set(&mut op, "phase", "completed");
				self.transition(|_, d| set_member_state(d, &member_id, "draining"), id, &op).await?;
			}
			_ => self.remove(id, &mut op, member, &member_id, &state, new_default).await?,
		}
		Ok(op)
	}

	async fn save(&self, id: &str, op: &Json) -> R<()> { self.change(|d| { put_op(d, id, op); Ok(()) }).await }
	async fn push_policy(&self, id: &str, op: &Json, member_id: &str, current: &Json, latest: &Json) -> R<String> {
		let push = policy_push_id(id, num_of(latest, "policyVersion").unwrap_or(0.0))?;
		let table: Vec<Json> = current.get("members").and_then(Json::as_object).map_or(vec![], |m| m.iter().map(|(_, v)| v.clone()).collect());
		for existing in table.iter().filter(|e| text(e, "id") != Some(member_id) && matches!(text(e, "state"), Some("active" | "draining"))) {
			let mut other = op.clone();
			set(&mut other, "member", existing.clone());
			self.call(&push, &other, "policy", Some(latest)).await?;
		}
		Ok(push)
	}

	async fn add(&self, id: &str, op: &mut Json, member: &Json, member_id: &str, state: &Json) -> R<()> {
		if text(op, "phase") == Some("accepted") {
			if member_state(state, member_id).is_some() {
				return Err(routing("Member ID already registered"));
			}
			let proof = self.call(id, op, "prepareAdd", None).await?;
			set(op, "proof", proof);
			set(op, "phase", "prepared");
			self.save(id, op).await?;
		}
		if text(op, "phase") == Some("prepared") {
			if let Err(e) = self.check_stock(state, op, member_id) {
				set(op, "phase", "failed");
				set(op, "error", e.message);
				self.save(id, op).await?;
				self.call(id, op, "rejectAdd", None).await?;
				return Ok(());
			}
			let mut policy = self.base_policy(state, member_id);
			for e in stock_of(op) {
				Self::add_stock_rule(&mut policy, &e, member_id);
			}
			let expected = state.get("policy").filter(|p| !p.is_null()).and_then(|p| num_of(p, "policyVersion")).unwrap_or(0.0);
			set(op, "phase", "committed");
			set(op, "policy", policy.clone());
			let mut row = member.clone();
			set(&mut row, "state", "adding");
			self.transition(|tx, d| {
				let table = d.as_object_mut().and_then(|o| o.get_mut("members")).and_then(Json::as_object_mut).expect("a routing has members");
				if table.contains_key(member_id) {
					return Err(routing("member concurrently added"));
				}
				table.insert(member_id, row);
				self.apply_policy_in(tx, d, &policy, expected, &[])
			}, id, op).await?;
		}
		let (current, latest) = self.current_policy(op)?;
		let installed = op.get("policy").cloned();
		self.call(id, op, "activate", installed.as_ref()).await?;
		let push = self.push_policy(id, op, member_id, &current, &latest).await?;
		if num_of(&latest, "policyVersion") > installed.as_ref().and_then(|p| num_of(p, "policyVersion")) {
			self.call(&push, op, "policy", Some(&latest)).await?;
		}
		set(op, "phase", "completed");
		self.transition(|_, d| set_member_state(d, member_id, "active"), id, op).await
	}

	async fn remove(&self, id: &str, op: &mut Json, member: &Json, member_id: &str, state: &Json, new_default: Option<&str>) -> R<()> {
		let space = member.get("target").and_then(|t| text(t, "spaceId")).unwrap_or("").to_owned();
		if text(op, "phase") == Some("accepted") {
			if member_state(state, member_id).and_then(|m| text(m, "state")) != Some("draining") {
				return Err(routing("remove requires draining Member"));
			}
			let rules = state.get("policy").and_then(|p| p.get("rules")).and_then(Json::as_array).map_or(&[][..], Vec::as_slice);
			if rules.iter().any(|r| text(r, "mode") == Some("expand") && r.get("by").is_some_and(|b| b.as_str() == Some("type") || matches!(b, Json::Object(_))) && r.get("members").and_then(Json::as_array).is_some_and(|m| m.iter().any(|x| x.as_str() == Some(member_id)))) {
				return Err(error("MigrationRequired", "HRW/fixed-type sets cannot shrink"));
			}
			if self.env.has_references(member_id, &space)? {
				return Err(routing("Root still references Member"));
			}
			let proof = self.call(id, op, "freeze", None).await?;
			if proof.get("empty") != Some(&Json::Bool(true)) || text(&proof, "state") != Some("removing") {
				return Err(routing("no valid EmptyProof"));
			}
			set(op, "proof", proof);
			set(op, "phase", "prepared");
			self.save(id, op).await?;
		}
		if text(op, "phase") == Some("prepared") {
			if self.env.has_references(member_id, &space)? {
				return Err(routing("Root references appeared before removal commit"));
			}
			let mut p = state.get("policy").cloned().unwrap_or(Json::Null);
			let version = num_of(&p, "policyVersion").unwrap_or(0.0);
			set(&mut p, "policyVersion", version + 1.0);
			let kept: Vec<Json> = p.get("rules").and_then(Json::as_array).map_or(vec![], |rules| rules.iter().filter_map(|r| {
				if r.get("member").is_some() {
					return (text(r, "member") != Some(member_id)).then(|| r.clone());
				}
				let remaining: Vec<Json> = r.get("members").and_then(Json::as_array).map_or(vec![], |m| m.iter().filter(|x| x.as_str() != Some(member_id)).cloned().collect());
				if remaining.is_empty() {
					return None;
				}
				let mut next = r.clone();
				set(&mut next, "members", remaining);
				Some(next)
			}).collect());
			set(&mut p, "rules", kept);
			if p.get("default").and_then(|d| text(d, "member")) == Some(member_id) {
				let Some(n) = new_default.filter(|n| !n.is_empty() && member_state(state, n).and_then(|m| text(m, "state")) == Some("active")) else {
					return Err(routing("removal needs registered active default"));
				};
				if let Some(d) = p.as_object_mut().and_then(|o| o.get_mut("default")) {
					set(d, "member", n);
				}
			}
			set(op, "phase", "committed");
			set(op, "policy", p.clone());
			let allowed = [member_id.to_owned()];
			self.transition(|tx, d| {
				if self.env.has_references(member_id, &space)? {
					return Err(routing("Root still references Member at removal commit"));
				}
				self.apply_policy_in(tx, d, &p, version, &allowed)?;
				set_member_state(d, member_id, "detached")
			}, id, op).await?;
		}
		let (current, latest) = self.current_policy(op)?;
		self.push_policy(id, op, member_id, &current, &latest).await?;
		self.call(id, op, "detach", None).await?;
		set(op, "phase", "completed");
		self.save(id, op).await
	}
}

