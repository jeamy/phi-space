//! Durable principal mailboxes (src/mailbox.ts): an event a consumer subscribed to, or waited for, is appended to its
//! principal's mailbox; the principal pages through it and acknowledges a delivered prefix, which bounded maintenance
//! then drops. Events older than `mailboxTtlMs` expire unacknowledged: the mailbox gets a new epoch and records the gap,
//! and a take transaction whose event expired is released.
use crate::space::{bytes, error, js_string, truthy, CoreError, Result, Space};
use crate::state::Mailbox;
use phi_json::{hex, obj, Json, Object, FOREVER};

fn illegal(m: &str) -> CoreError { error("IllegalArgumentError", m) }
fn exhausted(m: &str) -> CoreError { error("ResourceExhausted", m) }
fn num_of(v: &Json, k: &str) -> Option<f64> { v.get(k).and_then(Json::as_f64) }
/// `Number.isSafeInteger`.
fn safe_integer(v: Option<&Json>) -> Option<f64> {
	match v {
		Some(Json::Number(x)) if x.trunc() == *x && x.abs() <= FOREVER => Some(*x),
		_ => None,
	}
}

/// `principalId`: the canonical `[peerId, agentId or null]`.
pub fn principal_id(p: &Json) -> String {
	Json::Array(vec![p.get("peerId").cloned().unwrap_or(Json::Null), p.get("agentId").cloned().unwrap_or(Json::Null)]).canonical().expect("finite")
}

impl Space {
	fn new_epoch(&mut self) -> String { format!("mb{}", hex(&self.random_bytes(16))) }
	fn box_at(&self, id: &str) -> Option<usize> { self.state.mailboxes.as_ref()?.iter().position(|(k, _)| k == id) }
	pub(crate) fn mailbox(&mut self, i: usize) -> &mut Mailbox { &mut self.state.mailboxes.as_mut().expect("made")[i].1 }

	/// `box`: the principal's mailbox, made when it has none (which touches the stream at the wall clock).
	pub(crate) fn mailbox_of(&mut self, p: &Json) -> Result<usize> {
		let fine = p.get("peerId").and_then(Json::as_str).is_some_and(|s| !s.is_empty()) && p.get("agentId").is_none_or(|a| a.as_str().is_some());
		if !fine {
			return Err(illegal("invalid mailbox principal"));
		}
		self.state.mailboxes.get_or_insert_with(Vec::new);
		let id = principal_id(p);
		if let Some(i) = self.box_at(&id) {
			return Ok(i);
		}
		let epoch = self.new_epoch();
		let b = Mailbox { principal: p.clone(), epoch, next: 1.0, acked: 0.0, delivered: 0.0, bytes: 2.0, events: vec![], gap: None, rest: Object::new() };
		self.state.mailboxes.as_mut().expect("made").push((id, b));
		let clock = self.clock;
		self.touch(clock);
		Ok(self.state.mailboxes.as_ref().expect("made").len() - 1)
	}

	/// Drops what was acknowledged and what outlived the TTL, in bounded steps.
	pub(crate) fn expire_box(&mut self, i: usize, now: f64) {
		loop {
			let b = self.mailbox(i);
			let Some(first) = b.events.first() else { break };
			if num_of(first, "seq").is_none_or(|s| s > b.acked) {
				break;
			}
			let cursor = format!("ack:{}", b.epoch);
			if !self.maintenance_step(128.0, now, &cursor) {
				return;
			}
			let b = self.mailbox(i);
			let item = b.events.remove(0);
			b.bytes -= bytes(&item) + if b.events.is_empty() { 0.0 } else { 1.0 };
			self.touch(now);
		}
		let ttl = self.limits().mailbox_ttl_ms;
		let mut through = self.mailbox(i).acked;
		let mut changed = false;
		loop {
			let b = self.mailbox(i);
			let Some(first) = b.events.first() else { break };
			if num_of(first, "at").is_none_or(|at| at + ttl > now) {
				break;
			}
			let cursor = format!("mailbox:{}", b.epoch);
			if !self.maintenance_step(128.0, now, &cursor) {
				break;
			}
			let b = self.mailbox(i);
			let item = b.events.remove(0);
			through = num_of(&item, "seq").unwrap_or(f64::NAN);
			b.bytes -= bytes(&item) + if b.events.is_empty() { 0.0 } else { 1.0 };
			// a take whose event expired is given back
			if let Some(txn) = item.get("event").and_then(|e| e.get("txn")).filter(|t| truthy(Some(t))) {
				let id = js_string(txn);
				if self.state.txns.iter().any(|t| t.id == id) {
					let q = self.state.rest.get_mut("releaseQueue").and_then(|q| match q { Json::Array(a) => Some(a), _ => None });
					match q {
						Some(a) => {
							if !a.iter().any(|x| x.as_str() == Some(&id)) {
								a.push(id.into());
							}
						}
						None => self.state.rest.insert("releaseQueue", Json::Array(vec![id.into()])),
					}
				}
			}
			changed = true;
		}
		if !changed {
			return;
		}
		// sequence numbers stay on the retained suffix: expiry must not rewrite a large mailbox
		let epoch = self.new_epoch();
		let b = self.mailbox(i);
		b.gap = Some(obj! { "epoch" => b.epoch.as_str(), "from" => b.acked + 1.0, "to" => through });
		b.epoch = epoch;
		b.acked = through;
		b.delivered = through;
		self.touch(now);
	}
	pub(crate) fn sweep_mailboxes(&mut self, now: f64) {
		for i in 0..self.state.mailboxes.as_ref().map_or(0, Vec::len) {
			self.expire_box(i, now);
		}
	}

	pub(crate) fn assert_mailbox_capacity(&mut self, p: &Json, event: &Json, now: f64) -> Result<()> {
		let i = self.mailbox_of(p)?;
		self.expire_box(i, now);
		let lim = self.limits();
		let b = self.mailbox(i);
		let item = obj! { "seq" => b.next, "at" => now, "event" => event.clone() };
		let (have, size) = (b.bytes, bytes(&item));
		if bytes(event) > lim.max_event_bytes {
			return Err(exhausted("the event exceeds maxEventBytes"));
		}
		if have + size + 1.0 > lim.max_mailbox_bytes {
			return Err(exhausted("the principal's mailbox is full"));
		}
		Ok(())
	}
	pub(crate) fn assert_mailbox_batch(&mut self, p: &Json, events: &[Json], now: f64) -> Result<()> {
		let i = self.mailbox_of(p)?;
		self.expire_box(i, now);
		let lim = self.limits();
		let b = self.mailbox(i);
		let (mut size, next) = (b.bytes, b.next);
		for (k, e) in events.iter().enumerate() {
			if bytes(e) > lim.max_event_bytes {
				return Err(exhausted("the event exceeds maxEventBytes"));
			}
			size += bytes(&obj! { "seq" => next + k as f64, "at" => now, "event" => e.clone() }) + 1.0;
		}
		if size > lim.max_mailbox_bytes {
			return Err(exhausted("the principal's mailbox cannot hold this fanout"));
		}
		Ok(())
	}
	pub(crate) fn append_mail(&mut self, p: &Json, event: &Json, now: f64) -> Result<()> {
		self.assert_mailbox_capacity(p, event, now)?;
		let i = self.mailbox_of(p)?;
		let b = self.mailbox(i);
		let item = obj! { "seq" => b.next, "at" => now, "event" => event.clone() };
		b.next += 1.0;
		b.bytes += bytes(&item) + if b.events.is_empty() { 0.0 } else { 1.0 };
		b.events.push(item);
		self.touch(now);
		Ok(())
	}

	/// `appendMail` as a line of the driver.
	pub fn append_mail_line(&mut self, now: f64, principal: Option<&Json>, event: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		self.append_mail(principal.unwrap_or(&Json::Null), event.unwrap_or(&Json::Null), now)?;
		Ok(Json::Null)
	}

	/// `mailboxPage`: the events after a cursor, as many as fit the budget; marks them delivered.
	pub fn mailbox_page(&mut self, now: f64, principal: Option<&Json>, o: &Json) -> Result<Json> {
		self.assert_ported()?;
		let i = self.mailbox_of(principal.unwrap_or(&Json::Null))?;
		self.expire_box(i, now);
		let frame = self.limits().max_frame_bytes;
		let b = self.mailbox(i).clone();
		let after = match o.get("after") {
			None | Some(Json::Null) => b.acked,
			a => safe_integer(a).filter(|&a| a >= 0.0).ok_or_else(|| illegal("invalid mailbox cursor"))?,
		};
		let max_bytes = match o.get("maxBytes") {
			None | Some(Json::Null) => frame,
			m => safe_integer(m).filter(|&m| m >= 1.0).ok_or_else(|| illegal("maxBytes must be positive"))?,
		};
		let cap = max_bytes.min(frame);
		let asked = o.get("mailboxEpoch"); // `null` is given (`!== undefined`): it is another epoch
		if let Some(asked) = asked {
			if asked.as_str() != Some(&b.epoch) {
				let gap = b.gap.clone().unwrap_or_else(|| obj! { "epoch" => asked.clone(), "from" => after + 1.0, "to" => after.max(b.next - 1.0) });
				let result = obj! { "mailboxEpoch" => b.epoch.as_str(), "events" => Json::Array(vec![]), "next" => b.acked, "more" => !b.events.is_empty(), "gap" => gap };
				if bytes(&result) > cap {
					return Err(error("ResponseBudgetTooSmall", format!("the next element needs {} bytes of budget", phi_json::number_text(bytes(&result)))));
				}
				return Ok(result);
			}
		}
		if after >= b.next || after < b.acked || after > b.delivered {
			return Err(illegal("mailbox cursor is ahead, undelivered or already acknowledged"));
		}
		let pending: Vec<Json> = b.events.iter().filter(|e| num_of(e, "seq").is_some_and(|s| s > after)).cloned().collect();
		let gap = if asked.is_none() { b.gap.clone() } else { None };
		let result = crate::space::byte_page(&pending, cap, |events, next| {
			let last = events.last().and_then(|e| num_of(e, "seq")).unwrap_or(after);
			let mut r = obj! { "mailboxEpoch" => b.epoch.as_str(), "events" => events, "next" => last, "more" => next.is_some() };
			if let (Some(g), Json::Object(o)) = (&gap, &mut r) {
				o.insert("gap", g.clone());
			}
			r
		})?;
		let next = num_of(&result, "next").unwrap_or(after);
		if next > b.delivered {
			self.mailbox(i).delivered = next;
			self.touch(now);
		}
		Ok(result)
	}

	/// `ackMailbox`: acknowledges a delivered prefix; physical deletion follows in maintenance.
	pub fn ack_mailbox(&mut self, principal: Option<&Json>, epoch: Option<&Json>, up_to: Option<&Json>) -> Result<Json> {
		self.assert_ported()?;
		let p = principal.cloned().unwrap_or(Json::Null);
		let i = self.mailbox_of(&p)?;
		let b = self.mailbox(i).clone();
		if epoch.and_then(Json::as_str) != Some(&b.epoch) {
			return Err(error("MailboxEpochMismatch", "ACK refers to another mailbox epoch"));
		}
		let Some(up_to) = safe_integer(up_to).filter(|&u| u >= 0.0 && u <= b.delivered) else { return Err(error("InvalidAck", "ACK exceeds the delivered prefix")) };
		if up_to > b.acked {
			let covered = b.events.iter().filter(|e| num_of(e, "seq").is_some_and(|s| s > b.acked && s <= up_to)).count() as f64;
			if covered != up_to - b.acked {
				return Err(error("InvalidAck", "ACK is not a contiguous prefix"));
			}
			self.mailbox(i).acked = up_to;
			let clock = self.clock;
			self.touch(clock);
			let id = principal_id(&p);
			if let Some(Json::Array(jobs)) = self.state.rest.get_mut("jobs") {
				for job in jobs.iter_mut() {
					let cursor = num_of(job, "cursor").unwrap_or(0.0) as usize;
					let mine = job.get("events").and_then(Json::as_array).is_some_and(|ev| ev.iter().skip(cursor).any(|e| e.get("consumer").is_some_and(|c| principal_id(c) == id)));
					if let (true, Json::Object(o)) = (mine, job) {
						o.insert("retryAt", Json::Number(0.0));
					}
				}
			}
		}
		let b = self.mailbox(i);
		Ok(obj! { "mailboxEpoch" => b.epoch.as_str(), "acked" => b.acked })
	}

	/// `mailboxesBytes`: the mailboxes' JSON bytes with each box's events by its tally.
	pub(crate) fn mailboxes_bytes(&self) -> f64 {
		let Some(m) = &self.state.mailboxes else { return 2.0 };
		let mut tally = 0.0;
		let empty: Vec<(String, Mailbox)> = m
			.iter()
			.map(|(k, b)| {
				let safe = b.bytes.trunc() == b.bytes && b.bytes.abs() <= FOREVER;
				tally += if safe { b.bytes } else { bytes(&Json::Array(b.events.clone())) } - 2.0;
				(k.clone(), Mailbox { events: vec![], ..b.clone() })
			})
			.collect();
		bytes(&crate::state::obj_boxes(&empty)) + tally
	}

	/// When the next mailbox event is due for maintenance (0: an acknowledged one waits).
	pub(crate) fn mailboxes_due(&self) -> f64 {
		let ttl = self.limits().mailbox_ttl_ms;
		let mut min = f64::INFINITY;
		for (_, b) in self.state.mailboxes.iter().flatten() {
			if let Some(first) = b.events.first() {
				min = min.min(if num_of(first, "seq").is_some_and(|s| s <= b.acked) { 0.0 } else { num_of(first, "at").unwrap_or(f64::NAN) + ttl });
			}
		}
		min
	}
}
