//! A Member's authority transition on one Space (`memberTransitionStep` of src/member-transition.ts): one bounded stage
//! per commit, under closed admission, so that the Space's history carries the new authority without replaying anything
//! of the old one. Its work is cleared, its transactions aborted one by one, its open requests become history, its
//! decided claims (on the disk walked in key order from the last one marked) and historical claims are marked as
//! orphaned by the transition, its generations become invalid; then the Space accepts the new authority at epoch 1.
use crate::space::{bytes, error, Result, Space};
use phi_json::{obj, text, Json};

fn exhausted(m: &str) -> crate::space::CoreError { error("ResourceExhausted", m) }
fn blocked(m: &str) -> crate::space::CoreError { error("RecoveryBlocked", m) }
fn key_bytes(k: &str) -> f64 { bytes(&Json::String(k.into())) }
/// A claim no transition has marked yet, and no open request.
fn unmarked(c: &Json) -> bool { text(c, "state") != Some("pending") && !crate::space::truthy(c.get("orphanedAfterRestore")) }

impl Space {
	fn transition_field(&self, k: &str) -> Option<&Json> { self.state.rest.get("authorityTransition").and_then(|t| t.get(k)) }
	fn transition_stage(&self) -> Option<&str> { self.transition_field("stage").and_then(Json::as_str) }
	fn set_transition_field(&mut self, k: &str, v: Json) {
		if let Some(Json::Object(t)) = self.state.rest.get_mut("authorityTransition") {
			t.insert(k, v);
		}
	}
	/// The entries and the rest of the document must still fit once `cost` more bytes are kept.
	fn fits_document(&self, cost: f64) -> bool { self.overhead_bytes() + cost + self.entry_bytes() <= self.limits().max_doc_bytes }

	/// One stage of the transition to `new_authority` under `recovery_id`.
	pub fn member_transition_step(&mut self, now: f64, recovery_id: &str, new_authority: &str) -> Result<()> {
		if !self.maintenance_step(512.0, now, "member-authority-transition") {
			return Err(exhausted("member transition metadata exceeds commit budget"));
		}
		if self.transition_field("recoveryId").and_then(Json::as_str) != Some(recovery_id) {
			self.save_cleared_work();
			self.state.rest.insert("authorityTransition", obj! { "recoveryId" => recovery_id, "authorityId" => new_authority, "stage" => "clearing" });
			let s = &mut self.state;
			s.waiters.clear();
			s.regs.clear();
			s.rest.insert("outbox", Json::Array(vec![]));
			s.outbox_bytes = None;
			s.rest.insert("jobs", Json::Array(vec![]));
			s.rest.insert("releaseQueue", Json::Array(vec![]));
			s.mailboxes = Some(vec![]);
			self.touch(now);
		}
		if self.transition_stage() == Some("clearing") {
			if let Some(txn) = self.state.txns.first() {
				if crate::space::truthy(txn.rest.get("sealed")) || crate::space::truthy(txn.rest.get("prepared")) {
					return Err(blocked("sealed replica candidates require their separate reconciliation protocol"));
				}
				let (id, owner) = (Json::String(txn.id.clone()), txn.owner.clone());
				self.abort_txn(now, Some(&id), Some(&owner).filter(|o| !o.is_null()))?;
				return Ok(());
			}
			self.set_transition_field("stage", "history".into());
		}
		if self.transition_stage() == Some("history") {
			if self.history_step(now, recovery_id, new_authority)? {
				return Ok(());
			}
			self.set_transition_field("stage", "generations".into());
		}
		if self.transition_stage() == Some("generations") {
			let old = self.state.rpc.as_ref().and_then(|r| r.generations.keys().find(|id| !crate::space::truthy(self.state.rest.get("invalidGenerations").and_then(|g| g.get(id)))).map(str::to_owned));
			if let Some(old) = old {
				let cost = key_bytes(&old) + 64.0;
				if self.claim_bytes() + cost > self.limits().max_claim_bytes || !self.fits_document(cost) || !self.maintenance_step(cost, now, "member-old-generation") {
					return Err(exhausted("old generation cannot fit the transition budget"));
				}
				if !self.state.rest.get("invalidGenerations").is_some_and(|g| !g.is_null()) {
					self.state.rest.insert("invalidGenerations", Json::Object(Default::default()));
				}
				if let Some(Json::Object(g)) = self.state.rest.get_mut("invalidGenerations") {
					g.insert(&old, Json::Bool(true));
				}
				self.touch(now);
				return Ok(());
			}
			if let Some(r) = self.state.rpc.as_mut() {
				r.authority_id = Some(new_authority.to_owned());
			}
			self.state.rest.insert("primaryEpoch", Json::Number(1.0));
			self.state.rest.insert("acceptedAuthorityId", new_authority.into());
			self.set_transition_field("stage", "completed".into());
			self.touch(now);
		}
		Ok(())
	}

	/// The history stage: one open request, decided claim or historical claim; false once none is left.
	fn history_step(&mut self, now: f64, recovery_id: &str, new_authority: &str) -> Result<bool> {
		if let Some((id, c)) = self.pending_claims().into_iter().next() {
			let mut copy = c.clone();
			if let Json::Object(o) = &mut copy {
				o.remove("reservedResultBytes");
			}
			let cost = bytes(&copy) + key_bytes(&id) + 256.0;
			if !self.fits_document(cost) || !self.maintenance_step(cost, now, "member-pending-history") {
				return Err(exhausted("pending history cannot fit the transition budget"));
			}
			self.set_restored(&id, copy);
			self.claim_put(&id, None);
			let r = self.state.rpc.as_mut().expect("a pending claim has its rpc");
			r.bytes = Some((r.bytes.unwrap_or(0.0) - bytes(&c) - key_bytes(&id) - 2.0).max(0.0));
			r.reserved_bytes = Some((r.reserved_bytes.unwrap_or(0.0) - c.get("reservedResultBytes").and_then(Json::as_f64).unwrap_or(0.0)).max(0.0));
			self.touch(now);
			return Ok(true);
		}
		let mark = obj! { "recoveryId" => recovery_id, "authorityId" => new_authority };
		let cost = bytes(&mark) + 128.0;
		// claims on the disk are walked in key order from the last one marked (each step marks one; no scan from the start)
		let decided = match self.state.rpc.as_ref().map(|r| &r.claims) {
			Some(crate::state::Claims::Disk(d)) => {
				let mut after = self.transition_field("claimCursor").and_then(Json::as_str).map(str::to_owned);
				let found = loop {
					let page = d.page(after.as_deref(), 64);
					let found = page.iter().find(|(_, c)| unmarked(c)).cloned();
					if found.is_some() || page.len() < 64 {
						break found;
					}
					after = page.last().map(|(k, _)| k.clone());
				};
				if let Some((k, _)) = &found {
					self.set_transition_field("claimCursor", k.as_str().into());
				}
				found
			}
			Some(crate::state::Claims::Memory(m)) => m.iter().find(|(_, c)| unmarked(c)).map(|(k, c)| (k.to_owned(), c.clone())),
			None => None,
		};
		if let Some((k, c)) = decided {
			if self.claim_bytes() + cost > self.limits().max_claim_bytes || !self.fits_document(cost) || !self.maintenance_step(cost, now, "member-orphaned-claim") {
				return Err(exhausted("orphan audit exceeds current limits"));
			}
			let before = bytes(&c);
			let mut marked = c;
			if let Json::Object(o) = &mut marked {
				o.insert("orphanedAfterRestore", mark);
			}
			let after = bytes(&marked);
			self.claim_put(&k, Some(marked));
			let r = self.state.rpc.as_mut().expect("a claim has its rpc");
			r.bytes = Some(r.bytes.unwrap_or(0.0) + after - before);
			self.touch(now);
			return Ok(true);
		}
		// the historical claims likewise, in key order from the one marked last (historyCursor)
		let mut after = self.transition_field("historyCursor").and_then(Json::as_str).map(str::to_owned);
		let historical = loop {
			let page = crate::restore::page(self.state.rest.get("restoredClaims").and_then(Json::as_object), after.as_deref(), 64);
			let found = page.iter().find(|(_, c)| unmarked(c)).cloned();
			if found.is_some() || page.len() < 64 {
				break found;
			}
			after = page.last().map(|(k, _)| k.clone());
		};
		if let Some((k, c)) = historical {
			if self.claim_bytes() + cost > self.limits().max_claim_bytes || !self.fits_document(cost) || !self.maintenance_step(cost, now, "member-historical-orphan") {
				return Err(exhausted("historical orphan audit exceeds current limits"));
			}
			let mut marked = c;
			if let Json::Object(o) = &mut marked {
				o.insert("orphanedAfterRestore", mark);
			}
			self.set_restored(&k, marked);
			self.set_transition_field("historyCursor", k.as_str().into());
			self.touch(now);
			return Ok(true);
		}
		Ok(false)
	}
}
