//! Trusted local admin effects on one Space (the Space-level part of src/data-admin.ts): the purge of profiled tasks
//! and the erasure of a principal's data, one bounded batch per commit, phase by phase. The journal of the commands, the
//! fence and the commits around these are phi-host's (`phi_host::data_admin`).
//!
//! Removal ops encode tombstones and paths, not the old payload: each charges its bounded metadata through
//! `maintenance_step`, like ACK maintenance. Claims on the disk are walked in key order from the key handled last
//! (`claimKey`, `restoredKey` of the command) and keep their tally per change; claims in memory are tallied anew.
use crate::mailbox::principal_id;
use crate::space::{bytes, error, exhausted, permission, truthy, Extra, Result, Space, Template};
use phi_json::{hex, num_of, obj, text, Json, Object};

fn truthy_ref(v: &Json) -> bool { truthy(Some(v)) }
use sha2::{Digest, Sha256};
use std::collections::HashSet;

/// Mutations one deletion batch makes at most.
const MAX_MUTATIONS: usize = 32;

/// `affected`: the value names the principal or one of its entries (a string, or an object or array holding one).
fn affected(v: &Json, pid: &str, ids: &HashSet<String>) -> bool {
	match v {
		Json::String(s) => s == pid || ids.contains(s),
		Json::Object(o) => o.iter().any(|(_, x)| affected(x, pid, ids)),
		Json::Array(a) => a.iter().any(|x| affected(x, pid, ids)),
		_ => false,
	}
}
/// `{result: _r, reservedResultBytes: _b, ...rest}` with `resultExpired: true`.
fn expired(claim: &Json) -> Json {
	let mut next = claim.as_object().cloned().unwrap_or_default();
	next.remove("result");
	next.remove("reservedResultBytes");
	next.insert("resultExpired", Json::Bool(true));
	Json::Object(next)
}
fn key_bytes(key: &str) -> f64 { bytes(&Json::String(key.to_owned())) }

/// `spend` of eraseBatch: one bounded mutation, or none when the batch is full.
fn spend(s: &mut Space, mutations: &mut usize, cost: f64, now: f64, cursor: &str) -> Result<bool> {
	if *mutations >= MAX_MUTATIONS {
		return Ok(false);
	}
	if !s.maintenance_step(cost, now, cursor) {
		if *mutations == 0 {
			return Err(exhausted("one deletion tombstone exceeds maxCommitBytes; operator review required"));
		}
		return Ok(false);
	}
	*mutations += 1;
	Ok(true)
}

impl Space {
	/// `assertAdminIdle`: no principal deletion is under way.
	pub fn assert_admin_idle(&self) -> Result<()> {
		if truthy(self.state.rest.get("adminMaintenance")) { Err(permission("Space has a pending administrative deletion")) } else { Ok(()) }
	}

	/// `purgeTasks`: trusted administrative purge of profiled, unreserved tasks; how many went. The caller commits a
	/// separately scoped audit atomically.
	pub fn purge_tasks(&mut self, now: f64, tmpl: &Template) -> Result<f64> {
		self.assert_admin_idle()?;
		self.settle(now)?;
		let tasks: Vec<String> = self.state.entries.iter().filter(|e| tmpl.matches(e)).map(|e| e.id.clone()).collect();
		let profiled: Vec<&str> = self.state.rest.get("completionProfiles").and_then(Json::as_array).map(|p| p.iter().filter_map(|p| text(p, "taskType")).collect()).unwrap_or_default();
		let at = |s: &Space, id: &str| s.state.entries.iter().position(|e| e.id == id).expect("listed");
		if tasks.iter().any(|id| !self.state.entries[at(self, id)].types.iter().any(|t| profiled.contains(&t.as_str()))) {
			return Err(permission("purgeTasks accepts only profiled tasks"));
		}
		if tasks.iter().any(|id| {
			let e = &self.state.entries[at(self, id)];
			e.taken_by.is_some() || e.written_under.is_some() || !e.read_by.is_empty()
		}) {
			return Err(error("TransactionError", "purgeTasks cannot erase reserved work"));
		}
		let cost: f64 = tasks.iter().map(|id| self.publish_cost(&self.state.entries[at(self, id)], Extra::None)).sum();
		self.charge(cost)?;
		for id in &tasks {
			self.log_del(now, id);
			let i = at(self, id);
			self.state.entries.remove(i);
		}
		self.touch(now);
		Ok(tasks.len() as f64)
	}

	/// `purgeArchived`: trusted purge of an archived Space before its deletion, at most `max` unreserved entries;
	/// (purged, left). Refused while not archived, attached to a federation, with a run not stopped, an open
	/// transaction or a reserved entry.
	pub fn purge_archived(&mut self, now: f64, max: usize) -> Result<(usize, usize)> {
		self.assert_admin_idle()?;
		if self.state.rest.get("archived").filter(|a| !a.is_null()).is_none() {
			return Err(permission("purge needs an archived Space; archive it first"));
		}
		if let Some(state) = self.state.rest.get("membership").and_then(|m| text(m, "state")) {
			if state != "detached" {
				return Err(permission(format!("it is a federation Member ({state}); removeMember first")));
			}
		}
		let live = self.state.rest.get("runGates").and_then(Json::as_object).is_some_and(|g| {
			g.iter().any(|(_, gate)| text(gate, "state") != Some("stopped") || gate.as_object().and_then(|o| o.get("recovery")).is_some_and(truthy_ref))
		});
		if live {
			return Err(error("TransactionError", "a run on it is not stopped"));
		}
		self.settle(now)?;
		if !self.state.txns.is_empty() {
			return Err(error("TransactionError", "it has open transactions"));
		}
		if max < 1 {
			return Err(crate::space::illegal("max must be a positive integer"));
		}
		if self.state.entries.iter().any(|e| e.taken_by.is_some() || e.written_under.is_some() || !e.read_by.is_empty()) {
			return Err(error("TransactionError", "it holds reserved entries"));
		}
		let n = max.min(self.state.entries.len());
		let cost: f64 = self.state.entries[..n].iter().map(|e| self.publish_cost(e, Extra::None)).sum();
		self.charge(cost)?;
		let ids: Vec<String> = self.state.entries[..n].iter().map(|e| e.id.clone()).collect();
		for id in &ids {
			self.log_del(now, id);
			let i = self.state.entries.iter().position(|e| &e.id == id).expect("listed");
			self.state.entries.remove(i);
		}
		self.touch(now);
		Ok((n, self.state.entries.len()))
	}

	/// `quiescent`: no transaction, waiter, fanout job, release or open request is on the Space.
	pub fn assert_quiescent(&self) -> Result<()> {
		let len = |k: &str| self.state.rest.get(k).and_then(Json::as_array).map_or(0, Vec::len);
		if !self.state.txns.is_empty() || !self.state.waiters.is_empty() || len("jobs") > 0 || len("releaseQueue") > 0 || !self.pending_claims().is_empty() {
			return Err(error("TransactionError", "principal deletion requires a quiescent Space"));
		}
		Ok(())
	}

	/// `reserveHeader`: the admin metadata of command `id` in this commit.
	pub fn reserve_admin_header(&mut self, now: f64, id: &str) -> Result<()> {
		if !self.maintenance_step(1024.0, now, &format!("delete-principal:{id}")) {
			return Err(exhausted("admin metadata exceeds maxCommitBytes"));
		}
		Ok(())
	}

	/// `tally`: the claim tally counted anew from the claims in memory (never for claims on the disk: that would read
	/// every one of them).
	pub(crate) fn tally_claims(&mut self) {
		let Some(r) = self.state.rpc.as_mut() else { return };
		let claims = r.claims.entries();
		r.reserved_bytes = Some(claims.iter().map(|(_, c)| num_of(c, "reservedResultBytes").unwrap_or(0.0)).sum());
		r.bytes = Some(bytes(&Json::Object(claims)) + bytes(&Json::Object(r.generations.clone())));
	}

	/// The claims of the Space are a map part on the disk (`diskMapOf(s.rpc?.claims)`).
	fn claims_on_disk(&self) -> bool { self.state.rpc.as_ref().is_some_and(|r| r.claims.on_disk()) }

	/// `setRestored(s, key, undefined)`: a historical claim goes, the tally kept beside it follows.
	fn remove_restored(&mut self, key: &str) {
		if !self.state.rest.contains_key("restoredClaims") {
			self.state.rest.insert("restoredClaims", Json::Object(Object::new()));
		}
		let tally = match self.state.rest.get("restoredBytes").and_then(Json::as_f64) { Some(t) => t, None => self.restored_bytes() };
		let was = self.restored_claim(key);
		let before = was.as_ref().map(|b| bytes(b) + key_bytes(key) + 2.0).unwrap_or(0.0);
		self.state.rest.insert("restoredBytes", Json::Number(tally - before));
		if let Some(d) = self.restored_disk.as_mut() {
			d.write(key, None);
		}
		if let Some(Json::Object(m)) = self.state.rest.get_mut("restoredClaims") {
			m.remove(key);
		}
		if let Some(t) = self.tracking.as_mut() {
			if !t.restored.iter().any(|(k, _)| k == key) { t.restored.push((key.to_owned(), was)); }
		}
	}
	/// `setRestored(s, key, claim)` for host code and tests: a historical claim, with the tally kept beside it.
	pub fn put_restored(&mut self, key: &str, claim: Option<Json>) {
		match claim {
			Some(c) => self.set_restored(key, c),
			None => self.remove_restored(key),
		}
	}

	/// `change` of the claims phase: the claim is replaced or dropped; on the disk the tally follows per change.
	fn change_claim(&mut self, key: &str, before: &Json, next: Option<Json>) {
		if self.claims_on_disk() {
			let r = self.state.rpc.as_mut().expect("on disk");
			let delta = match &next { Some(n) => bytes(n), None => -key_bytes(key) - 2.0 };
			r.bytes = Some(r.bytes.unwrap_or(0.0) - bytes(before) + delta);
			r.reserved_bytes = Some((r.reserved_bytes.unwrap_or(0.0) - num_of(before, "reservedResultBytes").unwrap_or(0.0)).max(0.0));
		}
		self.claim_put(key, next);
	}

	/// `eraseBatch`: one bounded batch of the deletion of principal `p` under command `id`, in the phase `c` names; `c`
	/// is the journal's command (its `phase`, `count`, `claimKey` and `restoredKey` move on).
	pub fn erase_batch(&mut self, c: &mut Object, p: &Json, now: f64, id: &str) -> Result<()> {
		let pid = principal_id(p);
		let same = |q: &Json| principal_id(q) == pid;
		let ids: HashSet<String> = self.state.entries.iter().filter(|e| e.owner.as_str() == Some(&pid)).map(|e| e.id.clone()).collect();
		let names = |e: Option<&Json>| e.filter(|e| truthy(Some(e))).and_then(|e| text(e, "id")).is_some_and(|eid| ids.contains(eid));
		let mut mutations = 0;
		let cursor = format!("delete-principal:{id}");
		match c.get("phase").and_then(Json::as_str) {
			Some("registrations") => {
				let mut i = self.state.regs.len();
				while i > 0 {
					i -= 1;
					let r = &self.state.regs[i];
					if r.target.as_str() == Some(&pid) || r.consumer.as_ref().filter(|q| truthy(Some(q))).is_some_and(same) {
						if !spend(self, &mut mutations, 256.0, now, &cursor)? {
							return Ok(());
						}
						self.state.regs.remove(i);
					} else if names(r.pending_entry.as_ref()) {
						if !spend(self, &mut mutations, 256.0, now, &cursor)? {
							return Ok(());
						}
						let r = &mut self.state.regs[i];
						r.pending_entry = None;
						r.pending = Some(0.0);
					}
				}
				let outbox: Vec<Json> = self.state.rest.get("outbox").and_then(Json::as_array).cloned().unwrap_or_default();
				let mut i = outbox.len();
				while i > 0 {
					i -= 1;
					let e = &outbox[i];
					if e.get("target").and_then(Json::as_str) == Some(&pid) || names(e.get("entry")) {
						if !spend(self, &mut mutations, 256.0, now, &cursor)? {
							return Ok(());
						}
						self.save_rest("outbox");
						if let Some(Json::Array(a)) = self.state.rest.get_mut("outbox") {
							a.remove(i);
						}
						self.state.outbox_bytes = None; // counted anew from the outbox, as after a delivery
					}
				}
				c.insert("phase", "mailboxes".into());
			}
			Some("mailboxes") => {
				let keys: Vec<String> = self.state.mailboxes.iter().flatten().map(|(k, _)| k.clone()).collect();
				for key in keys {
					let Some(i) = self.state.mailboxes.as_ref().and_then(|m| m.iter().position(|(k, _)| *k == key)) else { continue };
					let b = &self.state.mailboxes.as_ref().expect("listed")[i].1;
					if same(&b.principal) {
						if !spend(self, &mut mutations, 256.0 + key_bytes(&key), now, &cursor)? {
							return Ok(());
						}
						self.save_cleared_work();
						self.state.mailboxes.as_mut().expect("listed").remove(i);
					} else if b.events.iter().any(|item| names(item.get("event").and_then(|e| e.get("entry")))) {
						if !spend(self, &mut mutations, 512.0 + key_bytes(&key), now, &cursor)? {
							return Ok(());
						}
						let b = self.mailbox(i);
						b.gap = Some(obj! { "epoch" => b.epoch.as_str(), "from" => b.acked + 1.0, "to" => b.next - 1.0 });
						b.epoch = format!("deleted-{}", hex(&Sha256::digest(format!("{}{id}", b.epoch).as_bytes())));
						b.acked = b.next - 1.0;
						b.delivered = b.acked;
						b.events = vec![];
						b.bytes = 2.0;
					}
				}
				c.insert("phase", "claims".into());
			}
			Some("claims") => {
				let disk = self.claims_on_disk();
				// claims are values (a store may freeze them): a changed one is replaced
				let handle = |s: &mut Space, mutations: &mut usize, key: &str, claim: &Json| -> Result<bool> {
					if claim.get("principal").is_some_and(same) {
						if !spend(s, mutations, 256.0 + key_bytes(key), now, &cursor)? {
							return Ok(false);
						}
						s.change_claim(key, claim, None);
					} else if claim.get("result").is_some_and(|r| affected(r, &pid, &ids)) {
						if !spend(s, mutations, 256.0 + key_bytes(key), now, &cursor)? {
							return Ok(false);
						}
						s.change_claim(key, claim, Some(expired(claim)));
					}
					Ok(true)
				};
				if disk {
					loop {
						let after = c.get("claimKey").and_then(Json::as_str).map(str::to_owned);
						let page = match self.state.rpc.as_ref().map(|r| &r.claims) {
							Some(crate::state::Claims::Disk(d)) => d.page(after.as_deref(), 64),
							_ => vec![],
						};
						if page.is_empty() {
							break;
						}
						for (key, claim) in page {
							if !handle(self, &mut mutations, &key, &claim)? {
								return Ok(());
							}
							c.insert("claimKey", key.into());
						}
					}
				} else {
					let all: Vec<(String, Json)> = self.state.rpc.as_ref().and_then(|r| r.claims.memory()).map(|m| m.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect()).unwrap_or_default();
					for (key, claim) in all {
						if !handle(self, &mut mutations, &key, &claim)? {
							self.tally_claims();
							return Ok(());
						}
					}
				}
				// the historical claims: in key order from the key handled last (restoredKey), with their own tally
				loop {
					let after = c.get("restoredKey").and_then(Json::as_str).map(str::to_owned);
					let page = self.restored_page(after.as_deref(), 64);
					if page.is_empty() {
						break;
					}
					for (key, claim) in page {
						if claim.get("principal").is_some_and(same) {
							if !spend(self, &mut mutations, 256.0 + key_bytes(&key), now, &cursor)? {
								if !disk {
									self.tally_claims();
								}
								return Ok(());
							}
							self.remove_restored(&key);
						} else if claim.get("result").is_some_and(|r| affected(r, &pid, &ids)) {
							if !spend(self, &mut mutations, 256.0 + key_bytes(&key), now, &cursor)? {
								if !disk {
									self.tally_claims();
								}
								return Ok(());
							}
							self.set_restored(&key, expired(&claim));
						}
						c.insert("restoredKey", key.into());
					}
				}
				if !disk {
					self.tally_claims();
				}
				c.insert("phase", "generations".into());
			}
			Some("generations") => {
				// with claims on the disk the tally is kept per change (tally would read every claim)
				let disk = self.claims_on_disk();
				let all: Vec<(String, Json)> = self.state.rpc.as_ref().map(|r| r.generations.iter().map(|(k, v)| (k.to_owned(), v.clone())).collect()).unwrap_or_default();
				for (g, r) in all {
					if !r.get("principal").is_some_and(same) {
						continue;
					}
					if !spend(self, &mut mutations, 256.0 + key_bytes(&g), now, &cursor)? {
						if !disk {
							self.tally_claims();
						}
						return Ok(());
					}
					if disk {
						let st = self.state.rpc.as_mut().expect("on disk");
						st.bytes = Some(st.bytes.unwrap_or(0.0) - bytes(&r) - key_bytes(&g) - 2.0);
					}
					self.generation_put(&g, None);
				}
				if !disk {
					self.tally_claims();
				}
				c.insert("phase", "entries".into());
			}
			Some("entries") => {
				let mut i = self.state.entries.len();
				while i > 0 {
					i -= 1;
					if self.state.entries[i].owner.as_str() != Some(&pid) {
						continue;
					}
					let cost = 256.0 + key_bytes(&self.state.entries[i].id);
					if !spend(self, &mut mutations, cost, now, &cursor)? {
						return Ok(());
					}
					self.state.entries.remove(i);
					c.insert("count", Json::Number(c.get("count").and_then(Json::as_f64).unwrap_or(0.0) + 1.0));
				}
				c.insert("phase", "history".into());
			}
			Some("history") => {
				if !spend(self, &mut mutations, 512.0, now, &cursor)? {
					return Ok(());
				}
				if let Some(st) = self.state.stream.as_mut() {
					st.floor = st.rev;
					let log = std::mem::take(&mut st.log);
					st.bytes = 0.0;
					self.dropped(log);
					self.seal_stream();
				}
				c.insert("phase", "completed".into());
			}
			_ => {}
		}
		Ok(())
	}
}
