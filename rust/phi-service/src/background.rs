// What runs without a call (R3, slice 3): the reaper and the delivery of src/index.ts. A wake settles what is due, one
// bounded commit at a time, and drops the outbox events nobody can receive. Every commit of TypeScript's watch that finds
// nothing due is left out: operations settle before they mutate, so the state cannot tell, and the next due time is
// asked of the document instead of a timer re-armed per commit.
use crate::{Service, R};
use phi_core::Space;
use phi_json::{Json, FOREVER};

/// Events looked at per run; a run that dropped some is followed by another.
const DELIVERY_BATCH: usize = 64;
/// A poisoned event is given up after this many failed deliveries (a host with conversations counted them).
const MAX_TRIES: f64 = 5.0;
/// How soon a failed round is tried again.
const RETRY_MS: f64 = 1000.0;

impl Service {
	/// One round of the reaper on a Space: a commit of its own, and when something is due next.
	pub fn maintenance_round(&mut self, space: Option<&str>) -> R<f64> {
		self.commit_on(space, |s, now| {
			s.settle(now)?;
			s.next_expiry()
		})
	}

	/// `deliverEvents` on a host without conversations: an event with a numeric target waits for its agent host and
	/// nothing is released; without such a target, or with its transaction gone, it is dropped, and a served take gets
	/// its transaction released in that commit. How many events left the outbox.
	pub fn deliver_events(&mut self, space: Option<&str>) -> R<usize> {
		let now = self.now();
		let dropped = undeliverable(self.snap_of(space)?, now);
		if dropped.is_empty() {
			return Ok(0);
		}
		self.commit_on(space, |s, now| {
			let mut release = vec![];
			let mut lost = 0;
			if let Some(Json::Array(outbox)) = s.state.rest.get_mut("outbox") {
				outbox.retain(|x| {
					let gone = x.get("tries").and_then(Json::as_f64).unwrap_or(0.0) >= MAX_TRIES || dropped.contains(&key_of(x));
					if gone {
						lost += 1;
						if let Some(t) = x.get("txn").filter(|t| truthy(t)) {
							release.push(t.clone());
						}
					}
					!gone
				});
			}
			s.state.outbox_bytes = None;
			for t in &release {
				s.release_txn(now, Some(t))?;
			}
			Ok(lost)
		})
	}

	/// The first run, before the service takes calls: every Space's document exists from here on, and what fell due
	/// while nothing ran is settled.
	pub fn start_background(&mut self) -> R<()> {
		self.maintenance_round(None)?;
		for id in self.store.named_ids() {
			self.maintenance_round(Some(&id))?;
		}
		Ok(())
	}

	/// Everything due on every Space. When to wake next, as a time on the service's clock; at or before now when a
	/// round left work behind. A failure is reported and tried again, it does not end the service.
	pub fn background(&mut self) -> f64 {
		let mut spaces = vec![None];
		spaces.extend(self.store.named_ids().into_iter().map(Some));
		let mut wake = FOREVER;
		for space in spaces {
			let space = space.as_deref();
			match self.background_of(space) {
				Ok(at) => wake = wake.min(at),
				Err(e) => {
					eprintln!("phi-spaces reaper: {}: {}", e.class, e.message);
					wake = wake.min(self.now() + RETRY_MS);
				}
			}
		}
		wake
	}

	fn background_of(&mut self, space: Option<&str>) -> R<f64> {
		let now = self.now();
		let mut wake = if self.snap_of(space)?.needs_maintenance(now)? { self.maintenance_round(space)? } else { self.snap_of(space)?.next_expiry()? };
		if self.deliver_events(space)? > 0 {
			wake = now; // the batch may have been full, and a released take may have served the next waiter
		}
		Ok(wake.min(next_retry(self.snap_of(space)?, now)))
	}
}

fn truthy(v: &Json) -> bool { !matches!(v, Json::Null | Json::Bool(false)) && v.as_str() != Some("") }
fn key_of(e: &Json) -> (String, String) { (e.get("eventId").map_or_else(String::new, Json::to_json_text), e.get("seq").map_or_else(String::new, Json::to_json_text)) }
fn outbox(s: &Space) -> &[Json] { s.state.rest.get("outbox").and_then(Json::as_array).map_or(&[], Vec::as_slice) }

/// The events of this run nobody can receive.
fn undeliverable(s: &Space, now: f64) -> Vec<(String, String)> {
	let due = outbox(s).iter().filter(|e| e.get("retryAt").and_then(Json::as_f64).unwrap_or(0.0) <= now).take(DELIVERY_BATCH);
	due.filter(|e| {
		let numeric = matches!(e.get("target"), Some(Json::Number(_)));
		let gone = e.get("txn").filter(|t| truthy(t)).is_some_and(|t| !t.as_str().is_some_and(|t| s.state.txns.iter().any(|x| x.id == t)));
		!numeric || gone
	})
	.map(key_of)
	.collect()
}

/// The next retry an agent host left in the file, of those still ahead.
fn next_retry(s: &Space, now: f64) -> f64 { outbox(s).iter().filter_map(|e| e.get("retryAt").and_then(Json::as_f64)).filter(|at| *at > now).fold(FOREVER, f64::min) }

