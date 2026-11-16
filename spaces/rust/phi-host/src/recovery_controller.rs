//! The durable state machine of a data restore on its target host (src/recovery-controller.ts): submit checks the
//! independent placement, boot permit and fence of the source, revokes admission and journals the job; advance imports
//! the snapshot in budget-bounded batches, publishes the new tuple, gets the control host's receipt and, after the old
//! grants expired, installs the permit and the placement; release lets restored entries in an explicit scope go back
//! to work. Only the private recovery endpoint holds this capability.
use crate::recovery_rpc::{blocked, conflict, Fut, RecoveryError, RR};
use crate::recovery_store::{core, StoreLine};
use crate::register::Register;
use phi_core::space::bytes;
use phi_core::Space;
use phi_json::{digest_json, obj, text, Json, Object};
use std::rc::Rc;

pub const JOBS: &str = "phi-spaces.recovery-jobs";

use crate::recovery::{value, version};
fn num(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
use phi_json::with;
fn canonical(v: Option<&Json>) -> String { v.unwrap_or(&Json::Null).canonical().unwrap_or_default() }
fn exhausted(m: &str) -> RecoveryError { blocked(m) }
/// `reserve`: one bounded maintenance mutation for the journal record `record`.
fn reserve(s: &mut Space, record: &Json, now: f64) -> RR<()> {
	if s.maintenance_step(bytes(record) + 512.0, now, "recovery-journal") { Ok(()) } else { Err(exhausted("recovery metadata exceeds the commit budget")) }
}
fn space_spaces(boot: &Json) -> Object { value(boot).get("spaces").and_then(Json::as_object).cloned().unwrap_or_default() }
fn safe_epoch(v: Option<&Json>) -> Option<f64> { v.and_then(Json::as_f64).filter(|n| phi_json::safe_integer(*n) && *n >= 0.0) }

pub struct DataRecovery {
	pub store: StoreLine,
	pub host_id: String,
	pub authority_id: String,
	/// The writable operator capability: never handed to the normal space service.
	pub external: Rc<dyn Register>,
	pub installed: Rc<dyn Register>,
	pub load_snapshot: crate::recovery_rpc::LoadSnapshot,
	pub verify_fence: Rc<dyn Fn(String) -> Fut<RR<Json>>>,
	/// Records the new tuple on the control primary; its durable receipt.
	pub acknowledge_control: Rc<dyn Fn(Json) -> Fut<RR<Json>>>,
}

impl DataRecovery {
	fn jobs(&self) -> RR<Json> { Ok(self.store.document(JOBS, None)?.unwrap_or_else(|| obj! { "jobs" => Object::new(), "releases" => Object::new() })) }
	fn job(&self, id: &str) -> RR<Json> { self.jobs()?.get("jobs").and_then(|j| j.get(id)).cloned().ok_or_else(|| blocked("unknown recovery request")) }
	/// The jobs document with `f` applied to it, as a write of the commit.
	fn write_jobs(s: &mut Space, mut doc: Json, f: impl FnOnce(&mut Object)) {
		if let Json::Object(o) = &mut doc {
			f(o);
		}
		s.doc_writes.push((JOBS.to_owned(), String::new(), 1, doc.to_json_text()));
	}
	async fn fenced(&self, host: &str) -> RR<()> {
		let proof = (self.verify_fence)(host.to_owned()).await?;
		if proof.get("restartLocked") == Some(&Json::Bool(true)) && text(&proof, "hostId") == Some(host) { Ok(()) } else { Err(blocked("independent fencing with restart lock required")) }
	}

	/// `submit`: the restore of `request`, journaled once its preconditions hold; the same request again answers its job.
	pub async fn submit(&self, request: &Json) -> RR<Json> {
		let short = |k: &str, max: usize| text(request, k).is_some_and(|v| !v.is_empty() && v.encode_utf16().count() <= max);
		let fine = ["recoveryId", "space", "snapshotRef", "targetHostId", "expectedDataIncarnation"].iter().all(|k| short(k, 512)) && short("recoveryId", 256) && text(request, "targetHostId") == Some(self.host_id.as_str()) && safe_epoch(request.get("expectedPrimaryEpoch")).is_some();
		if !fine {
			return Err(blocked("invalid recovery request or target"));
		}
		let (id, space, inc) = (text(request, "recoveryId").expect("checked"), text(request, "space").expect("checked"), text(request, "expectedDataIncarnation").expect("checked"));
		let epoch = num(request, "expectedPrimaryEpoch").expect("checked");
		let args_hash = digest_json(request).map_err(|_| blocked("invalid recovery request or target"))?;
		if let Some(existing) = self.jobs()?.get("jobs").and_then(|j| j.get(id)) {
			if text(existing, "argsHash") != Some(args_hash.as_str()) {
				return Err(conflict("recovery id has different arguments"));
			}
			return Ok(existing.clone());
		}
		let source = (self.load_snapshot)(text(request, "snapshotRef").expect("checked"))?;
		if text(&source, "spaceId") != Some(space) {
			return Err(blocked("snapshot belongs to another space"));
		}
		let boot = self.external.get(&format!("boot:{}", self.host_id)).await?;
		let permit = space_spaces(&boot).get(space).cloned();
		let p = permit.clone().unwrap_or(Json::Null);
		if boot.is_null() || permit.is_none() || text(&p, "authorityId") != Some(self.authority_id.as_str()) || text(&p, "dataIncarnation") != Some(inc) || num(&p, "primaryEpoch").unwrap_or(1.0) != epoch || text(&p, "durability") == Some("sync") {
			return Err(blocked("restore needs matching single-space boot configuration; sync requires promotion"));
		}
		let placement = self.external.get(&format!("placement:{space}")).await?;
		let pl = value(&placement);
		if placement.is_null() || text(&pl, "authorityId") != Some(self.authority_id.as_str()) || text(&pl, "incarnation") != Some(inc) || num(&pl, "primaryEpoch").unwrap_or(1.0) != epoch || text(&pl, "hostId").is_none() {
			return Err(blocked("independent placement disagrees with expected source"));
		}
		let source_host = text(&pl, "hostId").expect("checked").to_owned();
		self.fenced(&source_host).await?;
		let transition_key = format!("data-transition:{space}");
		let prior = self.external.get(&transition_key).await?;
		let pv = value(&prior);
		if !prior.is_null() && text(&pv, "argsHash") != Some(args_hash.as_str()) && text(&pv, "state") != Some("completed") {
			return Err(conflict("another space transition is active"));
		}
		let snapshot_hash = digest_json(&source).map_err(|e| blocked(e.to_string()))?;
		let job = obj! { "request" => request.clone(), "sourceHostId" => source_host.as_str(), "argsHash" => args_hash.as_str(), "snapshotHash" => snapshot_hash, "state" => "blocked", "priorPermit" => p.clone() };
		let target = self.store.space(space);
		let t = target.clone().unwrap_or(Json::Null);
		if target.is_none() || text(&t, "incarnation") != Some(inc) || num(&t, "primaryEpoch").unwrap_or(1.0) != epoch {
			return Err(blocked("target space is not provisioned with the expected tuple"));
		}
		if bytes(&job) + 1536.0 > self.store.limits(space).map_or(0.0, |l| l.max_commit_bytes) {
			return Err(exhausted("recovery journal cannot fit the current commit budget"));
		}
		if text(&pv, "argsHash") != Some(args_hash.as_str()) {
			let record = obj! { "argsHash" => args_hash.as_str(), "recoveryId" => id, "expectedDataIncarnation" => inc, "targetHostId" => text(request, "targetHostId").unwrap_or(""), "sourceHostId" => source_host.as_str(), "authorityId" => self.authority_id.as_str(), "state" => "restoring" };
			self.external.compare_and_set(&transition_key, version(&prior), &record).await?;
		}
		// admission is revoked before any import: a retry after a lost answer finds the same transition and revoked tuple
		if text(&p, "state") != Some("revoked") {
			let mut spaces = space_spaces(&boot);
			spaces.insert(space, with(&p, &[("state", "revoked".into())]));
			self.external.compare_and_set(&format!("boot:{}", self.host_id), version(&boot), &with(&value(&boot), &[("spaces", Json::Object(spaces))])).await?;
		}
		let doc = self.jobs()?;
		let now = self.store.now();
		self.store
			.commit(Some(space), now, |s| {
				reserve(s, &job, now)?;
				let old = doc.get("jobs").and_then(|j| j.get(id));
				if old.is_some_and(|o| text(o, "argsHash") != Some(args_hash.as_str())) {
					return Err(conflict("recovery id conflict"));
				}
				if old.is_none() {
					Self::write_jobs(s, doc.clone(), |o| {
						let mut jobs = o.get("jobs").and_then(Json::as_object).cloned().unwrap_or_default();
						jobs.insert(id, job.clone());
						o.insert("jobs", Json::Object(jobs));
					});
				}
				Ok(())
			})
			.await?;
		self.job(id)
	}

	/// `advance`: the next step of the restore `id`.
	pub async fn advance(&self, id: &str) -> RR<Json> {
		let job = self.job(id)?;
		let now = self.store.now();
		if text(&job, "state") == Some("completed") {
			return Ok(job);
		}
		let request = job.get("request").cloned().unwrap_or(Json::Null);
		let space = text(&request, "space").unwrap_or("").to_owned();
		let args_hash = text(&job, "argsHash").unwrap_or("").to_owned();
		let transition_key = format!("data-transition:{space}");
		let before = self.external.get(&transition_key).await?;
		if before.is_null() || text(&value(&before), "argsHash") != Some(args_hash.as_str()) {
			return Err(blocked("independent transition changed or is unavailable"));
		}
		let source_host = text(&job, "sourceHostId").unwrap_or("").to_owned();
		let proof = (self.verify_fence)(source_host.clone()).await?;
		if proof.get("restartLocked") != Some(&Json::Bool(true)) || text(&proof, "hostId") != Some(source_host.as_str()) {
			return Err(blocked("source host fencing no longer verified"));
		}
		if matches!(text(&job, "state"), Some("blocked" | "importing")) {
			let source = (self.load_snapshot)(text(&request, "snapshotRef").unwrap_or(""))?;
			if digest_json(&source).ok().as_deref() != text(&job, "snapshotHash") {
				return Err(blocked("snapshot changed during recovery"));
			}
			let doc = self.jobs()?;
			self.store
				.commit(Some(&space), now, |s| {
					let Some(mut current) = doc.get("jobs").and_then(|j| j.get(id)).cloned() else { return Ok(()) };
					if !matches!(text(&current, "state"), Some("blocked" | "importing")) {
						return Ok(());
					}
					reserve(s, &current, now)?;
					if text(&current, "state") == Some("blocked") {
						let args = obj! { "recoveryId" => id, "expectedDataIncarnation" => request.get("expectedDataIncarnation").cloned().unwrap_or(Json::Null), "expectedPrimaryEpoch" => request.get("expectedPrimaryEpoch").cloned().unwrap_or(Json::Null), "snapshotHash" => job.get("snapshotHash").cloned().unwrap_or(Json::Null), "kind" => "data" };
						let restored = s.begin_restore(now, &args).map_err(core)?;
						s.registry_incarnation = text(&restored, "incarnation").map(str::to_owned);
						current = with(&current, &[("incarnation", restored.get("incarnation").cloned().unwrap_or(Json::Null)), ("primaryEpoch", restored.get("primaryEpoch").cloned().unwrap_or(Json::Null)), ("state", "importing".into())]);
					}
					let at = |s: &Space| s.state.rest.get("restore").map(|r| (text(r, "stage").map(str::to_owned), num(r, "cursor")));
					let was = at(s);
					let state = s.restore_batch(now, &source).map_err(core)?;
					if at(s) == was {
						return Err(exhausted("next restore item cannot fit together with the recovery journal; increase the administrative commit budget"));
					}
					if text(&state, "stage") == Some("waiting") {
						current = with(&current, &[("state", "waiting".into())]);
					}
					Self::write_jobs(s, doc.clone(), |o| {
						let mut jobs = o.get("jobs").and_then(Json::as_object).cloned().unwrap_or_default();
						jobs.insert(id, current);
						o.insert("jobs", Json::Object(jobs));
					});
					Ok(())
				})
				.await?;
			return self.job(id);
		}
		let s = self.store.space(&space).unwrap_or(Json::Null);
		let r = s.get("restore").cloned().unwrap_or(Json::Null);
		let (inc, epoch) = (job.get("incarnation").cloned(), job.get("primaryEpoch").cloned());
		if r.is_null() || text(&r, "recoveryId") != Some(id) || s.get("incarnation") != inc.as_ref() || s.get("primaryEpoch") != epoch.as_ref() || inc.as_ref().and_then(Json::as_str).is_none_or(str::is_empty) || epoch.is_none() {
			return Err(blocked("restore state was lost or changed"));
		}
		let (inc, epoch) = (inc.expect("checked"), epoch.expect("checked"));
		let published = self.external.get(&transition_key).await?;
		let pv = value(&published);
		let has_tuple = phi_core::space::truthy(pv.get("incarnation"));
		if published.is_null() || text(&pv, "argsHash") != Some(args_hash.as_str()) || (has_tuple && (pv.get("incarnation") != Some(&inc) || pv.get("primaryEpoch") != Some(&epoch))) {
			return Err(blocked("published recovery tuple changed"));
		}
		if !has_tuple {
			self.external.compare_and_set(&transition_key, version(&published), &with(&pv, &[("incarnation", inc.clone()), ("primaryEpoch", epoch.clone())])).await?;
		}
		let ack = (self.acknowledge_control)(job.clone()).await?;
		if text(&ack, "recoveryId") != Some(id) || text(&ack, "space") != Some(space.as_str()) || ack.get("incarnation") != Some(&inc) || ack.get("primaryEpoch") != Some(&epoch) || text(&ack, "authorityId") != Some(self.authority_id.as_str()) {
			return Err(blocked("control acknowledgement disagrees with restored tuple"));
		}
		if now < num(&r, "waitUntil").unwrap_or(f64::INFINITY) {
			return Ok(job);
		}
		let doc = self.jobs()?;
		self.store
			.commit(Some(&space), now, |s| {
				reserve(s, &job, now)?;
				Self::write_jobs(s, doc.clone(), |o| set_state(o, id, "installing"));
				s.complete_restore(now, id).map_err(core)
			})
			.await?;
		let prior = job.get("priorPermit").cloned().unwrap_or(Json::Null);
		let permit = with(&prior, &[("state", "active".into()), ("dataIncarnation", inc.clone()), ("primaryEpoch", epoch.clone()), ("transitionId", id.into())]);
		let local_key = format!("installed:{}:{space}", self.host_id);
		let local = self.installed.get(&local_key).await?;
		if canonical(local.get("value")) != canonical(Some(&permit)) {
			self.installed.compare_and_set(&local_key, version(&local), &permit).await?;
		}
		let boot = self.external.get(&format!("boot:{}", self.host_id)).await?;
		if boot.is_null() || text(&value(&boot), "state") != Some("active") {
			return Err(blocked("host remains fenced or quarantined"));
		}
		let current = space_spaces(&boot).get(&space).cloned();
		let c = current.clone().unwrap_or(Json::Null);
		let installed_here = text(&c, "transitionId") == Some(id) && text(&c, "state") == Some("active");
		if installed_here && canonical(Some(&c)) != canonical(Some(&permit)) {
			return Err(blocked("external active tuple disagrees with restored tuple"));
		}
		if !installed_here {
			if current.is_none() || c.get("dataIncarnation") != request.get("expectedDataIncarnation") || text(&c, "state") != Some("revoked") {
				return Err(blocked("external space tuple changed during restore"));
			}
			let mut spaces = space_spaces(&boot);
			spaces.insert(&space, permit.clone());
			self.external.compare_and_set(&format!("boot:{}", self.host_id), version(&boot), &with(&value(&boot), &[("spaces", Json::Object(spaces))])).await?;
		}
		let transition = self.external.get(&transition_key).await?;
		let tv = value(&transition);
		if transition.is_null() || text(&tv, "argsHash") != Some(args_hash.as_str()) {
			return Err(blocked("external recovery transition changed"));
		}
		if text(&tv, "state") != Some("completed") {
			self.external.compare_and_set(&transition_key, version(&transition), &with(&tv, &[("state", "completed".into()), ("incarnation", inc.clone()), ("primaryEpoch", epoch.clone())])).await?;
		}
		let placement = self.external.get(&format!("placement:{space}")).await?;
		let pl = value(&placement);
		if placement.is_null() || text(&pl, "authorityId") != Some(self.authority_id.as_str()) || !(pl.get("incarnation") == request.get("expectedDataIncarnation") || pl.get("incarnation") == Some(&inc)) {
			return Err(blocked("independent placement changed during restore"));
		}
		if pl.get("incarnation") != Some(&inc) {
			let next = with(&pl, &[("hostId", self.host_id.as_str().into()), ("incarnation", inc.clone()), ("primaryEpoch", epoch.clone()), ("recoveryId", id.into())]);
			self.external.compare_and_set(&format!("placement:{space}"), version(&placement), &next).await?;
		}
		let doc = self.jobs()?;
		self.store
			.commit(Some(&space), now, |s| {
				reserve(s, &job, now)?;
				Self::write_jobs(s, doc.clone(), |o| set_state(o, id, "completed"));
				Ok(())
			})
			.await?;
		self.job(id)
	}

	pub fn status(&self, id: &str) -> RR<Json> { self.job(id) }

	/// `release`: restored entries in `scope` work again, once the restore completed and both permits name its tuple.
	pub async fn release(&self, request: &Json) -> RR<Json> {
		let scope = request.get("scope").cloned().unwrap_or(Json::Null);
		let nonempty = |k: &str| scope.get(k).is_none_or(|v| v.as_str().is_some_and(|s| !s.is_empty()));
		let ids_fine = scope.get("entryIds").is_none_or(|v| v.as_array().is_some_and(|a| a.len() <= 10_000 && a.iter().all(|i| i.as_str().is_some_and(|s| !s.is_empty() && s.encode_utf16().count() <= 512))));
		if scope.as_object().is_none() || !nonempty("type") || !nonempty("runId") || !ids_fine {
			return Err(blocked("invalid restore release scope"));
		}
		let command = text(request, "commandId").filter(|c| !c.is_empty() && c.encode_utf16().count() <= 256).ok_or_else(|| blocked("invalid release command identity"))?.to_owned();
		let recovery_id = text(request, "recoveryId").unwrap_or("").to_owned();
		let job = self.job(&recovery_id)?;
		if text(&job, "state") != Some("completed") {
			return Err(blocked("restore has not completed"));
		}
		let space = text(job.get("request").unwrap_or(&Json::Null), "space").unwrap_or("").to_owned();
		let (boot_key, local_key) = (format!("boot:{}", self.host_id), format!("installed:{}:{space}", self.host_id));
		let (boot, local) = (self.external.get(&boot_key).await?, self.installed.get(&local_key).await?);
		let permit = space_spaces(&boot).get(&space).cloned().unwrap_or(Json::Null);
		let fine = !local.is_null() && text(&value(&boot), "state") == Some("active") && text(&permit, "state") == Some("active") && text(&permit, "authorityId") == Some(self.authority_id.as_str()) && permit.get("dataIncarnation") == job.get("incarnation") && permit.get("primaryEpoch") == job.get("primaryEpoch") && canonical(Some(&permit)) == canonical(local.get("value"));
		if !fine {
			return Err(blocked("release requires matching current external and local boot authorization"));
		}
		let hash = digest_json(request).map_err(|e| blocked(e.to_string()))?;
		let doc = self.jobs()?;
		let prior = doc.get("releases").and_then(|r| r.get(&command)).cloned();
		if prior.as_ref().is_some_and(|p| text(p, "hash") != Some(hash.as_str())) {
			return Err(conflict("release command has different arguments"));
		}
		if let Some(p) = prior.as_ref().filter(|p| p.get("completed") == Some(&Json::Bool(true))) {
			return Ok(obj! { "count" => num(p, "count").unwrap_or(0.0), "completed" => true });
		}
		// the permits are read again right before the commit, which runs at once: nothing changes between the two
		if version(&self.external.get(&boot_key).await?) != version(&boot) || version(&self.installed.get(&local_key).await?) != version(&local) {
			return Err(blocked("boot authorization changed during release"));
		}
		let before = prior.as_ref().and_then(|p| num(p, "count")).unwrap_or(0.0);
		let now = self.store.now();
		self.store
			.commit(Some(&space), now, |s| {
				reserve(s, &obj! { "commandId" => command.as_str(), "hash" => hash.as_str(), "count" => before, "completed" => false }, now)?;
				let count = s.release_restored(now, &recovery_id, &scope).map_err(core)?;
				let type_ = text(&scope, "type");
				let run = scope.get("runId");
				let ids: Option<Vec<&str>> = scope.get("entryIds").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).collect());
				let remaining = s.state.entries.iter().any(|e| e.restored_unverified && type_.is_none_or(|t| e.types.iter().any(|x| x == t)) && run.is_none_or(|r| e.fields.get("runId") == Some(r)) && ids.as_ref().is_none_or(|ids| ids.contains(&e.id.as_str())));
				let record = obj! { "hash" => hash.as_str(), "count" => before + count, "completed" => !remaining };
				Self::write_jobs(s, doc.clone(), |o| {
					let mut releases = o.get("releases").and_then(Json::as_object).cloned().unwrap_or_default();
					releases.insert(&command, record.clone());
					o.insert("releases", Json::Object(releases));
				});
				Ok(obj! { "count" => before + count, "completed" => !remaining })
			})
			.await
	}
}

fn set_state(o: &mut Object, id: &str, state: &str) {
	let mut jobs = o.get("jobs").and_then(Json::as_object).cloned().unwrap_or_default();
	if let Some(j) = jobs.get(id).cloned() {
		jobs.insert(id, with(&j, &[("state", state.into())]));
	}
	o.insert("jobs", Json::Object(jobs));
}

/// `dataRecoveryHandler`: only the data recovery methods, never arbitrary commits or the normal space methods.
pub async fn data_recovery_call(c: &DataRecovery, call: &Json) -> RR<Json> {
	let args = call.get("args").cloned().unwrap_or(Json::Null);
	if args.as_object().is_none() {
		return Err(blocked("recovery arguments must be an object"));
	}
	match text(call, "method").unwrap_or("") {
		"restoreDataSpace" => c.submit(&args).await,
		m @ ("advanceRestore" | "restoreStatus") => {
			let id = text(&args, "recoveryId").filter(|i| !i.is_empty()).ok_or_else(|| blocked("recovery identity required"))?;
			if m == "advanceRestore" { c.advance(id).await } else { c.status(id) }
		}
		"releaseRestored" => c.release(&args).await,
		_ => Err(blocked("method is not supported by the data recovery endpoint")),
	}
}
