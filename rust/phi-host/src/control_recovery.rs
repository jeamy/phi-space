//! A restore of the control Space under a new authority, and a Member's installation of it (src/control-recovery.ts,
//! src/member-transition.ts): both run behind the operator's private endpoint while the host's normal runtime is
//! stopped and restart-locked. The target imports the backup (the Space and its routing Members), installs the new
//! authority on its own Spaces, has the first keys authorized, and once every confirmed Member acknowledged and the old
//! grants expired, completes under the new authority; a Member clears each Space's work and history of the old one,
//! then acknowledges outside any snapshot.
use crate::control::{key_fingerprint, listed};
use crate::recovery::{install_authority_transition, reserve, verify_authority_transition};
use crate::recovery_rpc::{blocked, conflict, Fut, KeyPin, Role, RR};
use crate::recovery_store::{core, StoreLine};
use crate::register::Register;
use crate::auth::Signer;
use phi_core::space::bytes;
use phi_core::{Space, Template};
use phi_json::{digest_json, obj, text, Json, Object, FOREVER};
use std::rc::Rc;

pub const JOBS: &str = "phi-spaces.control-recovery-jobs";
const ROUTING: &str = "phi-spaces.federation-routing";

fn version(r: &Json) -> Option<f64> { r.get("version").and_then(Json::as_f64) }
fn value(r: &Json) -> Json { r.get("value").cloned().unwrap_or(Json::Null) }
fn num(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
fn canonical(v: Option<&Json>) -> String { v.unwrap_or(&Json::Null).canonical().unwrap_or_default() }
fn digest(v: &Json) -> String { digest_json(v).unwrap_or_default() }
fn with(rec: &Json, changes: &[(&str, Json)]) -> Json {
	let mut o = rec.as_object().cloned().unwrap_or_default();
	for (k, v) in changes {
		o.insert(*k, v.clone());
	}
	Json::Object(o)
}
fn spaces_of(boot: &Json) -> Object { value(boot).get("spaces").and_then(Json::as_object).cloned().unwrap_or_default() }
fn all_revoked(spaces: &Object) -> Json { Json::Object(spaces.iter().map(|(id, p)| (id, with(p, &[("state", "revoked".into())]))).collect()) }
fn short(v: Option<&Json>, max: usize) -> bool { v.and_then(Json::as_str).is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= max) }

/// What says that this host's normal runtime is stopped and restart-locked (`assertQuiesced`).
pub type Quiesced = Rc<dyn Fn() -> Fut<RR<Json>>>;
async fn assert_quiesced(q: &Quiesced, host_id: &str, message: &str) -> RR<()> {
	let p = q().await?;
	if text(&p, "hostId") == Some(host_id) && p.get("normalStopped") == Some(&Json::Bool(true)) && p.get("restartLocked") == Some(&Json::Bool(true)) { Ok(()) } else { Err(blocked(message)) }
}

/// `MemberTransitionInstaller`: the new authority on every Space of this host, one stage per call.
pub struct MemberInstaller {
	pub store: StoreLine,
	pub host_id: String,
	pub external: Rc<dyn Register>,
	pub installed: Rc<dyn Register>,
	pub pinned: KeyPin,
	pub quiesced: Quiesced,
}

impl MemberInstaller {
	/// `advance`: `{completed, ack?}`.
	pub async fn advance(&self, proof: &Json) -> RR<Json> {
		let t = verify_authority_transition(&*self.external, proof, &self.pinned).await?;
		assert_quiesced(&self.quiesced, &self.host_id, "member normal runtime must be stopped with a persistent restart lock").await?;
		let (rid, new, expected) = (text(&t, "recoveryId").unwrap_or("").to_owned(), text(&t, "newAuthorityId").unwrap_or("").to_owned(), text(&t, "expectedAuthorityId").unwrap_or("").to_owned());
		let key = format!("boot:{}", self.host_id);
		let mut boot = self.external.get(&key).await?;
		if boot.is_null() || text(&value(&boot), "hostId") != Some(self.host_id.as_str()) {
			return Err(blocked("member boot authorization is absent"));
		}
		let infos = self.store.spaces();
		let ids: Vec<String> = infos.iter().filter_map(|i| text(i, "spaceId").map(str::to_owned)).collect();
		let permits = spaces_of(&boot);
		if ids.len() != permits.len() || ids.iter().any(|i| permits.get(i).is_none()) {
			return Err(blocked("member registry and independent boot space set disagree"));
		}
		if permits.iter().any(|(_, p)| text(p, "durability") == Some("sync") || !matches!(text(p, "role"), Some("local" | "primary")) || !(text(p, "authorityId") == Some(expected.as_str()) || text(p, "authorityId") == Some(new.as_str()))) {
			return Err(blocked("single-mode transition cannot reconcile replicas or another authority"));
		}
		let ack_key = format!("member-ack:{rid}:{}", self.host_id);
		let prior = self.installed.get(&ack_key).await?;
		if !prior.is_null() {
			let pv = value(&prior);
			if text(&value(&boot), "state") != Some("active") || text(&pv, "bootDigest") != Some(digest(&value(&boot)).as_str()) {
				return Err(blocked("installed ACK no longer matches the external member boot configuration"));
			}
			for id in &ids {
				let local = self.installed.get(&format!("installed:{}:{id}", self.host_id)).await?;
				let s = self.store.space(id).unwrap_or(Json::Null);
				let permit = permits.get(id).cloned().unwrap_or(Json::Null);
				if canonical(local.get("value")) != canonical(Some(&permit)) || text(&s, "acceptedAuthorityId") != Some(new.as_str()) || num(&s, "primaryEpoch") != Some(1.0) || s.get("incarnation") != permit.get("dataIncarnation") {
					return Err(blocked("member local configuration disagrees with persisted ACK"));
				}
			}
			self.publish_ack(&pv).await?;
			return Ok(obj! { "completed" => true, "ack" => pv });
		}
		if text(&value(&boot), "state") != Some("quarantine") {
			boot = self.external.compare_and_set(&key, version(&boot), &with(&value(&boot), &[("state", "quarantine".into()), ("spaces", all_revoked(&permits))])).await?;
		}
		let permits = spaces_of(&boot);
		for id in &ids {
			let state = self.store.space(id);
			let permit = permits.get(id).cloned().unwrap_or(Json::Null);
			let s = state.clone().unwrap_or(Json::Null);
			let at = s.get("authorityTransition").filter(|a| !a.is_null()).cloned();
			let stage = at.as_ref().and_then(|a| text(a, "stage"));
			let other = at.as_ref().is_some_and(|a| stage != Some("completed") && (text(a, "recoveryId") != Some(rid.as_str()) || text(a, "authorityId") != Some(new.as_str())));
			if state.is_none() || s.get("incarnation") != permit.get("dataIncarnation") || other {
				return Err(blocked("member space state or transition changed"));
			}
			if stage == Some("completed") && at.as_ref().and_then(|a| text(a, "recoveryId")) == Some(rid.as_str()) && text(&s, "acceptedAuthorityId") == Some(new.as_str()) {
				continue;
			}
			let now = self.store.now();
			self.store.commit(Some(id), now, |sp| sp.member_transition_step(now, &rid, &new).map_err(core)).await?;
			return Ok(obj! { "completed" => false });
		}
		install_authority_transition(&*self.installed, &*self.external, proof, &self.pinned).await?;
		let (mut spaces, mut tuples) = (Object::new(), Object::new());
		for id in &ids {
			let s = self.store.space(id).unwrap_or(Json::Null);
			let inc = s.get("incarnation").cloned().unwrap_or(Json::Null);
			let permit = with(permits.get(id).unwrap_or(&Json::Null), &[("state", "active".into()), ("authorityId", new.as_str().into()), ("dataIncarnation", inc.clone()), ("primaryEpoch", 1.0.into()), ("transitionId", rid.as_str().into()), ("authorityMarker", true.into())]);
			tuples.insert(id, obj! { "incarnation" => inc, "primaryEpoch" => 1.0 });
			let k = format!("installed:{}:{id}", self.host_id);
			let local = self.installed.get(&k).await?;
			if canonical(local.get("value")) != canonical(Some(&permit)) {
				self.installed.compare_and_set(&k, version(&local), &permit).await?;
			}
			spaces.insert(id, permit);
		}
		let next = obj! { "hostId" => self.host_id.as_str(), "state" => "active", "spaces" => Json::Object(spaces) };
		if canonical(boot.get("value")) != canonical(Some(&next)) {
			self.external.compare_and_set(&key, version(&boot), &next).await?;
		}
		let ack = obj! { "hostId" => self.host_id.as_str(), "recoveryId" => rid.as_str(), "authorityId" => new.as_str(), "bootDigest" => digest(&next), "spaces" => Json::Object(tuples) };
		let local = self.installed.get(&ack_key).await?;
		if !local.is_null() && canonical(local.get("value")) != canonical(Some(&ack)) {
			return Err(blocked("member ACK conflicts with local installation"));
		}
		if local.is_null() {
			self.installed.compare_and_set(&ack_key, None, &ack).await?;
		}
		self.publish_ack(&ack).await?;
		Ok(obj! { "completed" => true, "ack" => ack })
	}

	async fn publish_ack(&self, ack: &Json) -> RR<()> {
		let key = format!("authority-ack:{}:{}", text(ack, "recoveryId").unwrap_or(""), self.host_id);
		let known = self.external.get(&key).await?;
		if !known.is_null() && canonical(known.get("value")) != canonical(Some(ack)) {
			return Err(blocked("member ACK conflicts with independent register"));
		}
		if known.is_null() {
			self.external.compare_and_set(&key, None, ack).await?;
		}
		Ok(())
	}
}

/// `ControlRecoveryController`.
pub struct ControlRecovery {
	pub store: StoreLine,
	pub host_id: String,
	pub external: Rc<dyn Register>,
	pub installed: Rc<dyn Register>,
	pub operator: Rc<Signer>,
	pub operator_key: String,
	pub supervisor_key: String,
	pub load_snapshot: crate::recovery_rpc::LoadSnapshot,
	pub verify_fence: Rc<dyn Fn(String) -> Fut<RR<Json>>>,
	pub quiesced: Quiesced,
	/// A fresh UUID for a successor's id.
	pub new_id: Rc<dyn Fn() -> String>,
}

impl ControlRecovery {
	fn pin(&self) -> KeyPin { KeyPin::of(&self.operator, &self.operator_key) }
	pub fn installer(&self) -> MemberInstaller { MemberInstaller { store: self.store.clone(), host_id: self.host_id.clone(), external: Rc::clone(&self.external), installed: Rc::clone(&self.installed), pinned: self.pin(), quiesced: Rc::clone(&self.quiesced) } }
	async fn quiesced(&self) -> RR<()> { assert_quiesced(&self.quiesced, &self.host_id, "control normal runtime must be stopped with a persistent restart lock").await }
	fn jobs(&self) -> RR<Json> { Ok(self.store.document(JOBS, None)?.unwrap_or_else(|| obj! { "jobs" => Object::new() })) }
	fn job(&self, id: &str) -> RR<Json> { self.jobs()?.get("jobs").and_then(|j| j.get(id)).cloned().ok_or_else(|| blocked("unknown control recovery")) }
	fn write_job(s: &mut Space, doc: &Json, id: &str, job: Json) {
		let mut jobs = doc.get("jobs").and_then(Json::as_object).cloned().unwrap_or_default();
		jobs.insert(id, job);
		s.doc_writes.push((JOBS.to_owned(), String::new(), 1, with(doc, &[("jobs", Json::Object(jobs))]).to_json_text()));
	}
	fn set_state(s: &mut Space, doc: &Json, id: &str, state: &str) {
		let job = doc.get("jobs").and_then(|j| j.get(id)).cloned().unwrap_or(Json::Null);
		Self::write_job(s, doc, id, with(&job, &[("state", state.into())]));
	}
	/// `authority`: the job's successor is still the register's current one, and the old control host still fenced.
	async fn authority(&self, job: &Json) -> RR<Json> {
		let t = verify_authority_transition(&*self.external, job.get("proof").unwrap_or(&Json::Null), &self.pin()).await?;
		let source = text(job, "sourceHostId").unwrap_or("").to_owned();
		let fence = (self.verify_fence)(source.clone()).await?;
		if text(&fence, "hostId") != Some(source.as_str()) || fence.get("restartLocked") != Some(&Json::Bool(true)) {
			return Err(blocked("old control host lost its restart fence"));
		}
		Ok(t)
	}

	pub async fn submit(&self, r: &Json) -> RR<Json> {
		self.quiesced().await?;
		let members = r.get("confirmedMembers").and_then(Json::as_array);
		let unique = members.is_some_and(|m| m.iter().filter_map(Json::as_str).collect::<std::collections::HashSet<_>>().len() == m.len());
		let fine = r.as_object().is_some()
			&& ["recoveryId", "controlSpaceId", "snapshotRef", "expectedAuthorityId", "expectedDataIncarnation", "targetHostId"].iter().all(|k| short(r.get(k), 256))
			&& text(r, "targetHostId") == Some(self.host_id.as_str())
			&& num(r, "expectedPrimaryEpoch").is_some_and(|e| phi_json::safe_integer(e) && e >= 1.0)
			&& members.is_some_and(|m| m.len() <= 128 && m.iter().all(|v| short(Some(v), 128)) && m.iter().any(|v| v.as_str() == Some(self.host_id.as_str())))
			&& unique;
		if !fine {
			return Err(blocked("invalid control recovery identity or confirmed member set"));
		}
		let (id, cid, epoch) = (text(r, "recoveryId").expect("checked"), text(r, "controlSpaceId").expect("checked"), num(r, "expectedPrimaryEpoch").expect("checked"));
		let args_hash = digest(r);
		if let Some(prior) = self.jobs()?.get("jobs").and_then(|j| j.get(id)) {
			if text(prior, "argsHash") != Some(args_hash.as_str()) {
				return Err(conflict("control recovery id has different arguments"));
			}
			return Ok(prior.clone());
		}
		let state = self.store.space(cid);
		let source = (self.load_snapshot)(text(r, "snapshotRef").expect("checked"))?;
		let boot = self.external.get(&format!("boot:{}", self.host_id)).await?;
		let permit = spaces_of(&boot).get(cid).cloned();
		let (s, p) = (state.clone().unwrap_or(Json::Null), permit.clone().unwrap_or(Json::Null));
		if state.is_none() || s.get("incarnation") != r.get("expectedDataIncarnation") || num(&s, "primaryEpoch").unwrap_or(1.0) != epoch || text(&source, "spaceId") != Some(cid) || permit.is_none() || p.get("authorityId") != r.get("expectedAuthorityId") || p.get("dataIncarnation") != r.get("expectedDataIncarnation") || num(&p, "primaryEpoch").unwrap_or(1.0) != epoch {
			return Err(blocked("control snapshot, registry and target boot tuple must be provisioned consistently"));
		}
		let authority = self.external.get(&format!("authority:{cid}")).await?;
		if authority.is_null() {
			return Err(blocked("independent control authority missing"));
		}
		let transition_key = format!("control-transition:{cid}");
		let known = self.external.get(&transition_key).await?;
		let kv = value(&known);
		if !known.is_null() && text(&kv, "argsHash") != Some(args_hash.as_str()) && text(&kv, "state") != Some("completed") {
			return Err(conflict("another control transition is active"));
		}
		if text(&kv, "argsHash") != Some(args_hash.as_str()) {
			self.external.compare_and_set(&transition_key, version(&known), &obj! { "argsHash" => args_hash.as_str(), "sourceHostId" => value(&authority).get("hostId").cloned().unwrap_or(Json::Null), "state" => "restoring" }).await?;
		}
		let source_host = text(&value(&self.external.get(&transition_key).await?), "sourceHostId").unwrap_or("").to_owned();
		let o = obj! { "recoveryId" => id, "expectedAuthorityId" => r.get("expectedAuthorityId").cloned().unwrap_or(Json::Null), "controlSpaceId" => cid, "targetHostId" => self.host_id.as_str(), "supervisorKey" => self.supervisor_key.as_str() };
		let fence = Rc::clone(&self.verify_fence);
		let new_id = Rc::clone(&self.new_id);
		let proof = reserve(&*self.external, &self.operator, &o, move || new_id(), move |h| fence(h)).await?;
		let new = text(proof.get("transition").unwrap_or(&Json::Null), "newAuthorityId").unwrap_or("").to_owned();
		let access_key = format!("access:{new}");
		let access = self.external.get(&access_key).await?;
		if access.is_null() {
			self.external.compare_and_set(&access_key, None, &obj! { "authorityId" => new.as_str(), "aOnlyAllowed" => false, "routerEpoch" => 1.0, "policyVersion" => 1.0 }).await?;
		} else if value(&access).get("aOnlyAllowed") != Some(&Json::Bool(false)) {
			return Err(blocked("A-only access must be disabled for control recovery"));
		}
		if text(&value(&boot), "state") != Some("quarantine") {
			self.external.compare_and_set(&format!("boot:{}", self.host_id), version(&boot), &with(&value(&boot), &[("state", "quarantine".into()), ("spaces", all_revoked(&spaces_of(&boot)))])).await?;
		}
		let job = obj! { "request" => r.clone(), "argsHash" => args_hash.as_str(), "snapshotHash" => digest(&source), "proof" => proof, "sourceHostId" => source_host.as_str(), "state" => "importing" };
		let doc = self.jobs()?;
		let now = self.store.now();
		self.store
			.commit(Some(cid), now, |s| {
				if !s.maintenance_step(bytes(&job) + 512.0, now, "control-recovery-journal") {
					return Err(blocked("control journal exceeds commit budget"));
				}
				match doc.get("jobs").and_then(|j| j.get(id)) {
					Some(j) if text(j, "argsHash") != Some(args_hash.as_str()) => Err(conflict("control journal identity changed")),
					Some(_) => Ok(()),
					None => {
						Self::write_job(s, &doc, id, job.clone());
						Ok(())
					}
				}
			})
			.await?;
		self.job(id)
	}

	pub async fn advance(&self, id: &str) -> RR<Json> {
		self.quiesced().await?;
		let job = self.job(id)?;
		let t = self.authority(&job).await?;
		if text(&job, "state") == Some("completed") {
			return Ok(job);
		}
		let r = job.get("request").cloned().unwrap_or(Json::Null);
		let cid = text(&r, "controlSpaceId").unwrap_or("").to_owned();
		let new = text(&t, "newAuthorityId").unwrap_or("").to_owned();
		let confirmed: Vec<String> = r.get("confirmedMembers").and_then(Json::as_array).map(|m| m.iter().filter_map(Json::as_str).map(str::to_owned).collect()).unwrap_or_default();
		if text(&job, "state") == Some("importing") {
			let source = (self.load_snapshot)(text(&r, "snapshotRef").unwrap_or(""))?;
			if Some(digest(&source).as_str()) != text(&job, "snapshotHash") {
				return Err(blocked("control snapshot changed"));
			}
			let (doc, routing) = (self.jobs()?, self.store.document(ROUTING, Some(&cid))?.unwrap_or_else(|| obj! { "policy" => Json::Null, "members" => Object::new() }));
			let members = restored_members(&source, &new, &confirmed)?;
			let now = self.store.now();
			self.store
				.commit(Some(&cid), now, |s| {
					if s.state.rest.get("restore").and_then(|x| x.get("recoveryId")).and_then(Json::as_str) != Some(id) {
						let args = obj! { "recoveryId" => id, "expectedDataIncarnation" => r.get("expectedDataIncarnation").cloned().unwrap_or(Json::Null), "expectedPrimaryEpoch" => r.get("expectedPrimaryEpoch").cloned().unwrap_or(Json::Null), "snapshotHash" => job.get("snapshotHash").cloned().unwrap_or(Json::Null), "kind" => "control" };
						let restoration = s.begin_restore(now, &args).map_err(core)?;
						s.registry_incarnation = text(&restoration, "incarnation").map(str::to_owned);
					}
					let stage = |s: &Space| s.state.rest.get("restore").and_then(|x| x.get("stage")).and_then(Json::as_str).map(str::to_owned);
					if stage(s).as_deref() != Some("waiting") {
						s.restore_batch(now, &source).map_err(core)?;
					}
					if stage(s).as_deref() == Some("waiting") {
						s.state.rest.insert("authorityCounters", obj! { "routerEpoch" => 1.0, "policyVersion" => 1.0 });
						let mut next = routing.as_object().cloned().unwrap_or_default();
						next.insert("policy", Json::Null);
						next.insert("members", members.clone());
						next.remove("noticePolicyVersions");
						s.doc_writes.push((ROUTING.to_owned(), cid.clone(), 1, Json::Object(next).to_json_text()));
						Self::set_state(s, &doc, id, "members");
					}
					Ok(())
				})
				.await?;
			return self.job(id);
		}
		let control = self.store.space(&cid).unwrap_or(Json::Null);
		// the target's boot tuple follows the freshly installed snapshot, while admission stays quarantined
		let boot = self.external.get(&format!("boot:{}", self.host_id)).await?;
		let permit = spaces_of(&boot).get(&cid).cloned().unwrap_or(Json::Null);
		if text(&job, "state") == Some("members") && permit.get("dataIncarnation") != control.get("incarnation") {
			if text(&value(&boot), "state") != Some("quarantine") || text(&permit, "state") != Some("revoked") {
				return Err(blocked("control target admission unexpectedly reopened"));
			}
			let mut spaces = spaces_of(&boot);
			spaces.insert(&cid, with(&permit, &[("dataIncarnation", control.get("incarnation").cloned().unwrap_or(Json::Null)), ("primaryEpoch", 1.0.into())]));
			self.external.compare_and_set(&format!("boot:{}", self.host_id), version(&boot), &with(&value(&boot), &[("spaces", Json::Object(spaces))])).await?;
		}
		let now = self.store.now();
		if text(&job, "state") == Some("members") {
			if self.installer().advance(job.get("proof").unwrap_or(&Json::Null)).await?.get("completed") != Some(&Json::Bool(true)) {
				return Ok(job);
			}
			let doc = self.jobs()?;
			self.store
				.commit(Some(&cid), now, |s| {
					if !s.maintenance_step(512.0, now, "control-members-installed") {
						return Err(blocked("control completion metadata exceeds budget"));
					}
					Self::set_state(s, &doc, id, "waiting");
					Ok(())
				})
				.await?;
			return self.job(id);
		}
		if now < control.get("restore").and_then(|x| num(x, "waitUntil")).unwrap_or(f64::INFINITY) {
			return Err(blocked("old grant and lease validity has not expired"));
		}
		let mut versions: Vec<(String, Option<f64>)> = vec![];
		for host in &confirmed {
			let ack = self.external.get(&format!("authority-ack:{id}:{host}")).await?;
			let member_boot = self.external.get(&format!("boot:{host}")).await?;
			let av = value(&ack);
			if ack.is_null() || member_boot.is_null() || text(&av, "authorityId") != Some(new.as_str()) || text(&av, "hostId") != Some(host.as_str()) || text(&av, "recoveryId") != Some(id) || text(&value(&member_boot), "state") != Some("active") || Some(digest(&value(&member_boot)).as_str()) != text(&av, "bootDigest") {
				return Err(blocked(format!("member {host} has no matching durable installation ACK")));
			}
			versions.push((format!("boot:{host}"), version(&member_boot)));
			versions.push((format!("authority-ack:{id}:{host}"), version(&ack)));
		}
		let pending_member = self.store.with(|svc| {
			let host = svc.store.reader(Some(&cid)).ok()?;
			listed(&host.space, now, &obj! { "type" => "Member" }).ok()?.into_iter().find(|m| {
				let f = m.get("fields").cloned().unwrap_or(Json::Null);
				confirmed.iter().any(|h| f.get("hostId").and_then(Json::as_str) == Some(h.as_str())) && text(&f, "state") == Some("recoveryBlocked")
			})
		});
		// the records are read again right before the commit, which runs at once: nothing changes between the two
		for (k, v) in &versions {
			if version(&self.external.get(k).await?) != *v {
				return Err(blocked(if pending_member.is_some() { "member installation changed before metadata commit" } else { "member installation changed before control release" }));
			}
		}
		let metadata_pending = self
			.store
			.commit(Some(&cid), now, |s| {
				let admins = listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "state" => "active" } }).map_err(core)?;
				let scoped = |e: &Json| {
					let f = e.get("fields").cloned().unwrap_or(Json::Null);
					f.get("roles").and_then(Json::as_array).is_some_and(|r| r.iter().any(|x| x.as_str() == Some("admin"))) && f.get("scope").and_then(Json::as_array).is_some_and(|sc| sc.iter().any(|v| ["*", "control", cid.as_str()].contains(&js_string(v).as_str())))
				};
				if !admins.iter().any(scoped) {
					return Err(blocked("first new admin must be authorized through the private operator endpoint"));
				}
				for member in listed(s, now, &obj! { "type" => "Member" }).map_err(core)? {
					let f = member.get("fields").cloned().unwrap_or(Json::Null);
					if confirmed.iter().any(|h| js_string(f.get("hostId").unwrap_or(&Json::Null)) == *h) && text(&f, "state") == Some("recoveryBlocked") {
						let tmpl = Template::from_json(Some(&obj! { "id" => member.get("id").cloned().unwrap_or(Json::Null) })).map_err(core)?;
						let p = s.probe(now, &tmpl, None, true, None).map_err(core)?;
						if text(&p, "status") != Some("found") {
							return Err(blocked("member metadata changed"));
						}
						s.write(now, &obj! { "type" => "Member", "fields" => with(&f, &[("state", "active".into()), ("authorityId", new.as_str().into())]) }, None, Some(&Json::Number(FOREVER)), None).map_err(core)?;
						return Ok(true);
					}
				}
				s.complete_restore(now, id).map_err(core)?;
				Ok(false)
			})
			.await?;
		if metadata_pending {
			return Ok(job);
		}
		let a = self.external.get(&format!("authority:{cid}")).await?;
		if text(&value(&a), "authorityId") != Some(new.as_str()) {
			return Err(blocked("control successor changed"));
		}
		if text(&value(&a), "state") != Some("active") {
			self.external.compare_and_set(&format!("authority:{cid}"), version(&a), &with(&value(&a), &[("state", "active".into())])).await?;
		}
		let transition = self.external.get(&format!("control-transition:{cid}")).await?;
		if text(&value(&transition), "argsHash") != text(&job, "argsHash") {
			return Err(blocked("control transition changed"));
		}
		if text(&value(&transition), "state") != Some("completed") {
			self.external.compare_and_set(&format!("control-transition:{cid}"), version(&transition), &with(&value(&transition), &[("state", "completed".into())])).await?;
		}
		let doc = self.jobs()?;
		self.store
			.commit(Some(&cid), now, |s| {
				if !s.maintenance_step(512.0, now, "control-recovery-completed") {
					return Err(blocked("control completion metadata exceeds budget"));
				}
				Self::set_state(s, &doc, id, "completed");
				Ok(())
			})
			.await?;
		self.job(id)
	}

	/// `authorizeKey`: a first key under the new authority, while the restore waits; an old key is never revived.
	pub async fn authorize_key(&self, id: &str, key: &Json) -> RR<Json> {
		self.quiesced().await?;
		let job = self.job(id)?;
		self.authority(&job).await?;
		let strings = |k: &str, max: usize| key.get(k).and_then(Json::as_array).is_some_and(|a| !a.is_empty() && a.iter().all(|v| short(Some(v), max)));
		let roles_fine = strings("roles", usize::MAX) && key.get("roles").and_then(Json::as_array).is_some_and(|a| a.iter().all(|v| matches!(v.as_str(), Some("admin" | "host" | "member" | "observer"))));
		let algorithm = text(key, "algorithm").and_then(crate::auth::Algorithm::parse);
		if text(&job, "state") != Some("waiting") || !short(key.get("peerId"), 4096) || !short(key.get("publicKey"), 4096) || algorithm.is_none() || !roles_fine || !strings("scope", 256) {
			return Err(blocked("invalid explicit key authorization or recovery stage"));
		}
		let public = text(key, "publicKey").expect("checked");
		if !public_key_of(algorithm.expect("checked"), public)? {
			return Err(blocked("wrong authorized key algorithm"));
		}
		let peer = text(key, "peerId").expect("checked").to_owned();
		let key_id = key_fingerprint(public);
		let record = with(key, &[("keyId", key_id.as_str().into()), ("principal", format!("enrolled:{peer}").into()), ("state", "active".into())]);
		let cid = text(job.get("request").unwrap_or(&Json::Null), "controlSpaceId").unwrap_or("").to_owned();
		let now = self.store.now();
		self.store
			.commit(Some(&cid), now, |s| {
				let known = listed(s, now, &obj! { "type" => "PeerKey", "fields" => obj! { "peerId" => peer.as_str(), "keyId" => key_id.as_str() } }).map_err(core)?;
				if let Some(k) = known.first() {
					let f = k.get("fields").cloned().unwrap_or(Json::Null);
					if text(&f, "state") == Some("active") && canonical(Some(&f)) == canonical(Some(&record)) {
						return Ok(());
					}
					return Err(conflict("old or conflicting key cannot be revived through recovery"));
				}
				s.write(now, &obj! { "type" => "PeerKey", "fields" => record.clone() }, None, Some(&Json::Number(FOREVER)), None).map_err(core)?;
				Ok(())
			})
			.await?;
		Ok(obj! { "keyId" => key_id.as_str(), "peerId" => peer.as_str() })
	}

	pub fn status(&self, id: &str) -> RR<Json> { self.job(id) }
}

/// `String(v)` of a scope or host value.
fn js_string(v: &Json) -> String { v.as_str().map_or_else(|| v.to_json_text(), str::to_owned) }

/// `publicKeyObject`: an Ed25519 key is 32 bytes; a P-256 key a SubjectPublicKeyInfo of that curve.
fn public_key_of(algorithm: crate::auth::Algorithm, public: &str) -> RR<bool> {
	use p256::pkcs8::DecodePublicKey as _;
	let raw = crate::auth::base64(public);
	Ok(match algorithm {
		crate::auth::Algorithm::Ed25519 => {
			if raw.len() != 32 {
				return Err(blocked("an Ed25519 public key is 32 bytes"));
			}
			ed25519_dalek::VerifyingKey::from_bytes(&raw.try_into().expect("32 bytes")).is_ok()
		}
		crate::auth::Algorithm::EcdsaP256 => p256::PublicKey::from_public_key_der(&raw).is_ok(),
	})
}

/// `restoredMembers`: the backup's Members under the new authority; confirmed hosts installed it at epoch 1, the others
/// wait as recoveryBlocked. Capacity and capabilities are status, refreshed by the heartbeat, never restored.
fn restored_members(source: &Json, authority: &str, confirmed: &[String]) -> RR<Json> {
	let members = source.get("routing").and_then(|r| r.get("members")).cloned().unwrap_or_else(|| Json::Object(Object::new()));
	let invalid = || blocked("invalid routing table in the control backup");
	let m = members.as_object().filter(|m| m.len() <= 1024).ok_or_else(invalid)?;
	let mut out = Object::new();
	for (id, member) in m.iter() {
		let target = member.get("target").cloned().unwrap_or(Json::Null);
		if text(member, "id") != Some(id) || !short(Some(&Json::String(id.into())), 256) || !["hostId", "spaceId", "dataIncarnation"].iter().all(|k| short(target.get(k), 256)) {
			return Err(invalid());
		}
		let mut copy = member.as_object().cloned().unwrap_or_default();
		copy.remove("capacity");
		copy.remove("capabilities");
		let copy = Json::Object(copy);
		out.insert(id, if confirmed.iter().any(|h| Some(h.as_str()) == text(&target, "hostId")) { with(&copy, &[("target", with(&target, &[("authorityId", authority.into()), ("primaryEpoch", 1.0.into())]))]) } else { with(&copy, &[("state", "recoveryBlocked".into())]) });
	}
	Ok(Json::Object(out))
}

/// `controlRecoveryHandler`: the pinned operator only.
pub async fn control_recovery_call(c: &ControlRecovery, member: &MemberInstaller, call: &Json, role: Role) -> RR<Json> {
	if role != Role::Operator {
		return Err(blocked("control authority recovery requires the pinned operator"));
	}
	let a = call.get("args").cloned().unwrap_or(Json::Null);
	if a.as_object().is_none() {
		return Err(blocked("control recovery arguments must be an object"));
	}
	let id = text(&a, "recoveryId").unwrap_or("");
	match text(call, "method").unwrap_or("") {
		"restoreControlSpace" => c.submit(&a).await,
		"advanceControlRestore" => c.advance(id).await,
		"controlRestoreStatus" => c.status(id),
		"authorizeRecoveryKey" => c.authorize_key(id, a.get("key").unwrap_or(&Json::Null)).await,
		"installAuthority" => member.advance(a.get("proof").unwrap_or(&Json::Null)).await,
		_ => Err(blocked("unsupported control recovery method")),
	}
}

/// The Member recovery-only endpoint: a signed authority installation, nothing else.
pub async fn member_recovery_call(member: &MemberInstaller, call: &Json, role: Role) -> RR<Json> {
	let a = call.get("args").cloned().unwrap_or(Json::Null);
	if role != Role::Operator || text(call, "method") != Some("installAuthority") || a.as_object().is_none() {
		return Err(blocked("member recovery permits only signed authority installation"));
	}
	member.advance(a.get("proof").unwrap_or(&Json::Null)).await
}
