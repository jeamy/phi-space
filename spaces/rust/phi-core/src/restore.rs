//! Restore of a Space from a snapshot (src/restore.ts): installed in budget-bounded batches under closed admission, so a
//! commit never exceeds its budget and a batch cut short goes on where it stopped. What the snapshot held as pending work is
//! evidence, never executable work: its entries come back `restoredUnverified` (or, for the control Space, revoked or
//! blocked), its claims as history that answers a poll and refuses a replay, its generations as invalid, its run gates as
//! fenced historical evidence. The restore and the authority transition fields are kept as the JSON core.ts writes.
use crate::space::{bytes, error, Result, Space};
use crate::state::{EntryRec, SpaceState};
use phi_json::{digest_json, hex, obj, text, Json, Object, FOREVER};

fn permission(m: &str) -> crate::space::CoreError { error("PermissionError", m) }
fn exhausted(m: &str) -> crate::space::CoreError { error("ResourceExhausted", m) }
use phi_json::num_or_nan as num;

/// `runRecoveryIdOf`: the restore ID itself if it is a valid gate ID, else a stable hash of it.
pub(crate) fn run_recovery_id_of(recovery_id: &str) -> String {
	let b = recovery_id.as_bytes();
	let fine = !b.is_empty() && b.len() <= 96 && b[0].is_ascii_alphanumeric() && b.iter().all(|c| c.is_ascii_alphanumeric() || b"._:-".contains(c));
	if fine { recovery_id.to_owned() } else { format!("restore-{}", &hex(&<sha2::Sha256 as sha2::Digest>::digest(recovery_id.as_bytes()))[..32]) }
}

/// The keys of a claim map in key order after `after`, at most `n`.
pub(crate) fn page(map: Option<&Object>, after: Option<&str>, n: usize) -> Vec<(String, Json)> {
	let Some(map) = map else { return vec![] };
	let mut keys: Vec<&str> = map.keys().filter(|k| after.is_none_or(|a| phi_json::utf16_cmp(k, a).is_gt())).collect();
	keys.sort_unstable_by(|a, b| phi_json::utf16_cmp(a, b));
	keys.into_iter().take(n).map(|k| (k.to_owned(), map.get(k).cloned().expect("listed"))).collect()
}

impl Space {
	fn restore_state(&self) -> Option<&Json> { self.state.rest.get("restore").filter(|r| !r.is_null()) }
	fn restored_claims(&self) -> Option<&Object> { self.state.rest.get("restoredClaims").and_then(Json::as_object) }
	/// The historical claims are a map part on the disk (`restored_disk`), as `rpc.claims` are.
	pub fn restored_on_disk(&self) -> bool { self.restored_disk.is_some() }
	/// A historical claim (`restoredClaims[key]`): what memory holds of it, else the disk's row.
	pub(crate) fn restored_claim(&self, key: &str) -> Option<Json> {
		self.restored_claims().and_then(|m| m.get(key)).cloned().or_else(|| self.restored_disk.as_ref().and_then(|d| d.get(key)))
	}
	/// The historical claims in key order after `after`, at most `n` (`claimPage`: the disk's rows, or the map in memory).
	pub(crate) fn restored_page(&self, after: Option<&str>, n: usize) -> Vec<(String, Json)> {
		match &self.restored_disk {
			Some(d) => d.page(after, n),
			None => page(self.restored_claims(), after, n),
		}
	}
	/// Whether this generation belongs to restored data.
	pub(crate) fn invalid_generation(&self, id: &str) -> bool { self.state.rest.get("invalidGenerations").and_then(|g| g.get(id)).is_some_and(|v| !v.is_null() && v != &Json::Bool(false)) }
	/// A restore or an authority transition was installed, or the Member is recovery-blocked: history is not uninterrupted.
	pub(crate) fn interrupted_history(&self) -> bool { self.restore_state().is_some() || self.state.rest.get("authorityTransition").is_some_and(|t| !t.is_null()) || self.member_state() == Some("recoveryBlocked") }
	/// `restoredBytes`: the JSON size of the historical claims in memory; on the disk the tally kept beside them (from
	/// before the tally: counted once).
	pub(crate) fn restored_bytes(&self) -> f64 {
		let Some(m) = self.restored_claims() else { return 0.0 };
		if !self.restored_on_disk() {
			return bytes(&Json::Object(m.clone()));
		}
		self.state.rest.get("restoredBytes").and_then(Json::as_f64).unwrap_or_else(|| m.iter().fold(2.0, |n, (k, c)| n + bytes(c) + bytes(&Json::String(k.into())) + 2.0))
	}
	/// `setRestored`: a historical claim, and the tally kept beside it.
	pub(crate) fn set_restored(&mut self, key: &str, next: Json) {
		if !self.state.rest.contains_key("restoredClaims") {
			self.state.rest.insert("restoredClaims", Json::Object(Object::new()));
		}
		let tally = match self.state.rest.get("restoredBytes").and_then(Json::as_f64) { Some(t) => t, None => self.restored_bytes() };
		let was = self.restored_claim(key);
		let before = was.as_ref().map(|b| bytes(b) + bytes(&Json::String(key.into())) + 2.0).unwrap_or(0.0);
		let after = bytes(&next) + bytes(&Json::String(key.into())) + 2.0;
		self.state.rest.insert("restoredBytes", Json::Number(tally + after - before));
		if let Some(d) = self.restored_disk.as_mut() {
			d.write(key, Some(next.clone()));
		}
		if let Some(Json::Object(m)) = self.state.rest.get_mut("restoredClaims") {
			m.insert(key, next);
		}
		if let Some(t) = self.tracking.as_mut() {
			if !t.restored.iter().any(|(k, _)| k == key) { t.restored.push((key.to_owned(), was)); }
		}
	}
	/// Bytes of every entry, as the restore's document check counts them.
	fn sized_entries(&self) -> f64 { self.state.entries.iter().map(|e| e.size.unwrap_or_else(|| bytes(&Json::Object(e.fields.clone())))).sum() }

	/// `beginRestore`: the Space is emptied under a new incarnation and epoch, its run gates fenced; the snapshot's content
	/// follows in `restore_batch`. The same restore again answers its state.
	pub fn begin_restore(&mut self, now: f64, o: &Json) -> Result<Json> {
		let id = o.get("recoveryId").and_then(Json::as_str).unwrap_or("");
		let hash = o.get("snapshotHash").and_then(Json::as_str).unwrap_or("");
		let kind = o.get("kind").and_then(Json::as_str).unwrap_or("");
		let epoch = o.get("expectedPrimaryEpoch").and_then(Json::as_f64);
		let fine_epoch = epoch.is_some_and(|e| e >= 0.0 && phi_json::safe_integer(e) && phi_json::safe_integer(e + 1.0));
		if id.is_empty() || id.encode_utf16().count() > 256 || !phi_json::is_sha256_hex(hash) || !["data", "control"].contains(&kind) || !fine_epoch {
			return Err(error("IllegalArgumentError", "invalid restore identity, snapshot hash or epoch"));
		}
		let mut args = obj! { "recoveryId" => id };
		if let (Json::Object(a), Some(e)) = (&mut args, o.get("expectedDataIncarnation")) { a.insert("expectedDataIncarnation", e.clone()); }
		if let Json::Object(a) = &mut args {
			a.insert("expectedPrimaryEpoch", Json::Number(epoch.expect("checked")));
			a.insert("snapshotHash", hash.into());
			a.insert("kind", kind.into());
		}
		let argument = digest_json(&args).expect("finite");
		if let Some(r) = self.restore_state() {
			if text(r, "recoveryId") == Some(id) && text(r, "argumentHash") == Some(argument.as_str()) {
				return Ok(r.clone());
			}
			if text(r, "stage") != Some("completed") {
				return Err(permission("a different restore is already installed"));
			}
		}
		let current_epoch = self.state.rest.get("primaryEpoch").and_then(Json::as_f64).unwrap_or(1.0);
		if self.state.space_id.as_deref().is_none_or(str::is_empty) || self.state.incarnation.as_deref().map(Json::from).as_ref() != o.get("expectedDataIncarnation") || current_epoch != epoch.expect("checked") {
			return Err(permission("restore incarnation or epoch precondition failed"));
		}
		let incarnation = hex(&self.random_bytes(4));
		let epoch = epoch.expect("checked");
		let primary_epoch = if kind == "control" { 1.0 } else { epoch + 1.0 };
		let restoration = obj! {
			"recoveryId" => id, "argumentHash" => argument.as_str(), "snapshotHash" => hash, "incarnation" => incarnation.as_str(), "primaryEpoch" => primary_epoch,
			"startedAt" => now, "waitUntil" => now + 62_000.0, "stage" => "entries", "cursor" => 0.0, "kind" => kind
		};
		// clearing a collection records one empty assignment, not a rewrite of the old values; a store clears the parts
		// replaced as a whole, and a failed commit gets the claims and the stream back
		if let Some(t) = self.tracking.as_mut() {
			// the maps on the disk are cleared; the generations go key by key, the log batch by batch (as TypeScript's store
			// writes a map in memory and an array replaced as a whole)
			t.cleared.extend(["rpc.claims", "restoredClaims"]);
			t.log_replaced = true;
			for (k, v) in self.state.rpc.as_ref().map(|r| r.generations.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect::<Vec<_>>()).unwrap_or_default() {
				if !t.generations.iter().any(|(g, _)| *g == k) {
					t.generations.push((k, Some(v)));
				}
			}
			if t.replaced.is_none() {
				t.replaced = Some((self.state.rpc.clone(), self.state.stream.clone()));
			}
		}
		self.restored_disk = None; // a new map, in memory until a store takes it (the rows on the disk are cleared with this commit)
		self.save_cleared_work();
		let s = &mut self.state;
		s.entries.retain(|_| false);
		s.txns.clear();
		s.regs.clear();
		s.waiters.clear();
		s.rest.insert("outbox", Json::Array(vec![]));
		s.outbox_bytes = None;
		s.rest.insert("jobs", Json::Array(vec![]));
		s.rest.insert("releaseQueue", Json::Array(vec![]));
		s.mailboxes = Some(vec![]);
		s.rpc = Some(crate::state::RpcState { generations: Object::new(), claims: crate::state::Claims::default(), bytes: Some(0.0), reserved_bytes: Some(0.0), signing_key: None, authority_id: None, sweep_at: None, rest: Object::new() });
		s.rest.insert("restoredClaims", Json::Object(Object::new()));
		s.rest.remove("restoredBytes");
		s.rest.insert("invalidGenerations", Json::Object(Object::new()));
		s.next_id = 1.0;
		s.stream = Some(crate::state::StreamState { rev: 0.0, floor: 0.0, bytes: 0.0, log: vec![], rest: Object::new() });
		s.incarnation = Some(incarnation);
		s.rest.insert("primaryEpoch", Json::Number(primary_epoch));
		s.rest.insert("restore", restoration.clone());
		self.fence_gates_for_restore(now, &run_recovery_id_of(id));
		self.touch(now);
		Ok(restoration)
	}

	fn set_restore(&mut self, r: &Json) { self.state.rest.insert("restore", r.clone()); }
	/// A field of the installed restore, changed in place as core.ts changes `s.restore`.
	fn rset(&mut self, k: &str, v: Json) {
		if let Some(Json::Object(o)) = self.state.rest.get_mut("restore") { o.insert(k, v); }
	}
	fn rdel(&mut self, k: &str) {
		if let Some(Json::Object(o)) = self.state.rest.get_mut("restore") { o.remove(k); }
	}
	fn rnum(&self, k: &str) -> f64 { self.restore_state().map_or(f64::NAN, |r| num(r, k)) }
	fn rtext(&self, k: &str) -> Option<String> { self.restore_state().and_then(|r| text(r, k)).map(str::to_owned) }

	/// `restoreBatch`: the next part of the snapshot `source`, stage by stage, as far as the commit's budget goes.
	pub fn restore_batch(&mut self, now: f64, source: &Json) -> Result<Json> {
		if !self.restore_state().is_some_and(|r| text(r, "stage") != Some("completed")) {
			return Err(permission("no active restore"));
		}
		let source_id = source.get("spaceId").and_then(Json::as_str);
		if source_id != self.state.space_id.as_deref() || digest_json(source).ok() != self.rtext("snapshotHash") {
			return Err(permission("snapshot content or space id changed"));
		}
		self.restore_stages(now, source)?;
		Ok(self.restore_state().cloned().expect("installed"))
	}

	fn restore_stages(&mut self, now: f64, source: &Json) -> Result<()> {
		let control = self.rtext("kind").as_deref() == Some("control");
		if self.rtext("stage").as_deref() == Some("entries") {
			if control && !self.state.entries.iter().any(|e| e.type_ == "Bootstrap") {
				let mut marker = SpaceState::initial();
				marker.incarnation = self.rtext("incarnation");
				let mut m = Space::new(marker, Box::new(|n| vec![0; n]));
				m.write(now, &obj! { "type" => "Bootstrap", "fields" => obj! { "state" => "closed" } }, None, Some(&Json::Number(FOREVER)), None)?;
				let e = m.state.entries.iter().next().cloned().expect("written");
				if !self.import_restored_entry(now, &e)? {
					return Ok(());
				}
				self.state.next_id = self.state.next_id.max(m.state.next_id);
			}
			let entries = source.get("entries").and_then(Json::as_array).cloned().unwrap_or_default();
			loop {
				let cursor = self.rnum("cursor") as usize;
				let Some(e) = entries.get(cursor) else { break };
				let mut copy = EntryRec::from_json(e).map_err(|e| error("IllegalArgumentError", e.to_string()))?;
				let skip = copy.written_under.is_some() || copy.expires <= now || (control && ["Enroll", "Bootstrap", "Command", "RouterLease", "FederationPolicy"].contains(&copy.type_.as_str()));
				if !skip {
					copy.taken_by = None;
					copy.read_by = vec![];
					if control && copy.type_ == "PeerKey" {
						copy.fields.insert("state", "revoked".into());
					} else if control && copy.type_ == "Member" {
						copy.fields.insert("state", "recoveryBlocked".into());
					} else if !control {
						copy.restored_unverified = true;
					}
					if !self.import_restored_entry(now, &copy)? {
						return Ok(());
					}
				}
				self.rset("cursor", Json::Number((cursor + 1) as f64));
			}
			self.rset("stage", "claims".into());
			self.rset("cursor", Json::Number(0.0));
		}
		if self.rtext("stage").as_deref() == Some("claims") {
			// the source's historical claims, then its current ones (a key in both counts once, as its current claim),
			// each in key order from the key restored last
			let restored = source.get("restoredClaims").and_then(Json::as_object);
			let current = source.get("rpc").and_then(|x| x.get("claims")).and_then(Json::as_object);
			loop {
				let from = self.rtext("claimSource").unwrap_or_else(|| "restored".into());
				let after = self.rtext("claimKey");
				let found = page(if from == "rpc" { current } else { restored }, after.as_deref(), 64);
				if found.is_empty() {
					if from == "rpc" {
						break;
					}
					self.rset("claimSource", "rpc".into());
					self.rdel("claimKey");
					continue;
				}
				for (key, c) in found {
					if from == "restored" && current.is_some_and(|m| m.get(&key).is_some()) {
						self.rset("claimKey", key.as_str().into());
						continue;
					}
					let cost = bytes(&c) + bytes(&Json::String(key.clone())) + 256.0;
					let lim = self.limits();
					if self.claim_bytes() + cost > lim.max_claim_bytes || self.overhead_bytes() + cost + self.sized_entries() > lim.max_doc_bytes {
						return Err(exhausted("restored history violates current space limits"));
					}
					if cost + 1024.0 > lim.max_commit_bytes {
						return Err(exhausted("historical claim does not fit the restore budget"));
					}
					if !self.maintenance_step(cost, now, &format!("restore-claim:{from}:{key}")) {
						return Ok(());
					}
					let mut copy = c.clone();
					if let Json::Object(o) = &mut copy { o.remove("reservedResultBytes"); }
					self.set_restored(&key, copy);
					self.touch(now);
					self.rset("claimKey", key.as_str().into());
				}
			}
			self.rset("stage", "generations".into());
			self.rset("cursor", Json::Number(0.0));
			self.rdel("claimKey");
			self.rdel("claimSource");
			self.touch(now);
		}
		if self.rtext("stage").as_deref() == Some("generations") {
			let mut generations: Vec<String> = vec![];
			for m in [source.get("invalidGenerations"), source.get("rpc").and_then(|x| x.get("generations"))].into_iter().flatten().filter_map(Json::as_object) {
				for k in m.keys() {
					if !generations.iter().any(|g| g == k) { generations.push(k.to_owned()); }
				}
			}
			loop {
				let cursor = self.rnum("cursor") as usize;
				let Some(id) = generations.get(cursor).cloned() else { break };
				let cost = bytes(&Json::String(id.clone())) + 64.0;
				let lim = self.limits();
				if cost + 1024.0 > lim.max_commit_bytes || self.claim_bytes() + cost > lim.max_claim_bytes || self.overhead_bytes() + cost + self.sized_entries() > lim.max_doc_bytes {
					return Err(exhausted("restored generation violates current space limits"));
				}
				if !self.maintenance_step(cost, now, &format!("restore-generation:{cursor}")) {
					return Ok(());
				}
				if let Some(Json::Object(g)) = self.state.rest.get_mut("invalidGenerations") {
					g.insert(&id, Json::Bool(true));
				}
				self.touch(now);
				self.rset("cursor", Json::Number((cursor + 1) as f64));
			}
			self.rset("stage", "gates".into());
			self.rset("cursor", Json::Number(0.0));
			self.touch(now);
		}
		if self.rtext("stage").as_deref() == Some("gates") {
			// run gates of the snapshot: compact evidence, never an executable transition
			let gates = source.get("runGates").and_then(Json::as_object).cloned().unwrap_or_default();
			let mut runs: Vec<&str> = gates.keys().collect();
			runs.sort_unstable();
			loop {
				let cursor = self.rnum("cursor") as usize;
				let Some(run) = runs.get(cursor) else { break };
				if !self.maintenance_step(1024.0, now, &format!("restore-gate:{cursor}")) {
					return Ok(());
				}
				let recovery = run_recovery_id_of(&self.rtext("recoveryId").unwrap_or_default());
				self.import_restored_gate(now, gates.get(run).expect("listed"), &recovery)?;
				self.rset("cursor", Json::Number((cursor + 1) as f64));
			}
			self.rset("stage", "waiting".into());
			self.rset("cursor", Json::Number(0.0));
			self.touch(now);
		}
		Ok(())
	}

	/// `completeRestore`: only after fencing, control acknowledgement and the boot installation, which the caller checked.
	pub fn complete_restore(&mut self, now: f64, recovery_id: &str) -> Result<()> {
		let r = self.restore_state().cloned();
		if r.as_ref().is_some_and(|r| text(r, "recoveryId") == Some(recovery_id) && text(r, "stage") == Some("completed")) {
			return Ok(());
		}
		let Some(mut r) = r.filter(|r| text(r, "recoveryId") == Some(recovery_id) && text(r, "stage") == Some("waiting") && now >= num(r, "waitUntil")) else {
			return Err(permission("restore cannot be released before acknowledgement and old grant expiry"));
		};
		if let Json::Object(o) = &mut r { o.insert("stage", "completed".into()); }
		self.set_restore(&r);
		self.touch(now);
		Ok(())
	}

	/// `releaseRestored`: restored entries in an explicit scope become ordinary entries again; how many.
	pub fn release_restored(&mut self, now: f64, recovery_id: &str, scope: &Json) -> Result<f64> {
		if !self.restore_state().is_some_and(|r| text(r, "recoveryId") == Some(recovery_id) && text(r, "stage") == Some("completed")) {
			return Err(permission("restored data is not active"));
		}
		let type_ = scope.get("type").and_then(Json::as_str).filter(|t| !t.is_empty());
		let run = scope.get("runId").filter(|r| crate::space::truthy(Some(r)));
		let ids: Option<Vec<&str>> = scope.get("entryIds").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_str).collect());
		if type_.is_none() && run.is_none() && ids.as_ref().is_none_or(Vec::is_empty) {
			return Err(error("IllegalArgumentError", "explicit restore release scope required"));
		}
		let chosen: Vec<String> = self
			.state
			.entries
			.iter()
			.filter(|e| e.restored_unverified && type_.is_none_or(|t| e.types.iter().any(|x| x == t)) && run.is_none_or(|r| e.fields.get("runId") == Some(r)) && ids.as_ref().is_none_or(|ids| ids.contains(&e.id.as_str())))
			.map(|e| e.id.clone())
			.collect();
		let mut count = 0.0;
		for id in chosen {
			if !self.release_restored_entry(now, &id)? {
				break;
			}
			count += 1.0;
		}
		Ok(count)
	}

	/// `importRestoredEntry`: one entry of the snapshot, within the current limits; false when the commit is full.
	pub(crate) fn import_restored_entry(&mut self, now: f64, e: &EntryRec) -> Result<bool> {
		let cost = bytes(&e.to_json()) + bytes(&crate::space::put_op(e)) + 256.0;
		let lim = self.limits();
		let fields = bytes(&Json::Object(e.fields.clone()));
		let used = self.entry_bytes() + fields;
		let duplicate = self.state.entries.iter().any(|x| x.id == e.id);
		if duplicate || self.state.entries.len() as f64 >= lim.max_entries || fields > lim.max_entry_bytes || used > lim.max_space_bytes || used + self.overhead_bytes() + cost > lim.max_doc_bytes {
			return Err(exhausted("restored entry violates current space limits or has a duplicate id"));
		}
		if cost + 1024.0 > lim.max_commit_bytes {
			return Err(exhausted("restored entry cannot fit the commit budget"));
		}
		if !self.maintenance_step(cost, now, &format!("restore-entry:{}", e.id)) {
			return Ok(false);
		}
		self.state.entries.push(e.clone());
		self.note_expiry(e.expires);
		self.log_put_rec(now, e);
		Ok(true)
	}

	/// `releaseRestoredEntry`: a restored entry becomes an ordinary one, published as a write; false when the commit is full.
	fn release_restored_entry(&mut self, now: f64, id: &str) -> Result<bool> {
		let lim = self.limits();
		let Some(i) = self.state.entries.iter().position(|e| e.id == id) else { return Ok(false) };
		let mut preview = self.state.entries[i].clone();
		preview.restored_unverified = false;
		self.check_event_size(bytes(&crate::space::view(&preview, self.state.space_id.as_deref())), &lim)?;
		let publication = self.publish_cost(&preview, crate::space::Extra::None);
		let update = bytes(&preview.to_json()) + 256.0;
		if publication + update + 1024.0 > lim.max_commit_bytes {
			return Err(exhausted("restored release and fanout cannot fit the commit budget"));
		}
		if !self.can_charge(publication + update) {
			self.defer_maintenance(now, &format!("release:{id}"));
			return Ok(false);
		}
		self.reserve(None, publication, &lim)?;
		self.charge(update)?;
		self.state.entries.get_mut(i).restored_unverified = false;
		let released = self.state.entries[i].clone();
		self.log_put_rec(now, &released);
		self.notify_write(&released, None, now, true)?;
		Ok(true)
	}
}
