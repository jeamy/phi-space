//! Revisions and the change stream of a space (src/stream.ts): every commit that changes what a plain reader can see
//! gets the next revision and one batch in a bounded log inside the document. The last operation per entry in a batch
//! wins; the oldest batches are dropped beyond `maxLogBytes`, and the byte tally is the running sum stream.ts keeps.
use crate::state::{Batch, StreamState};
use phi_json::{Json, Object};
use std::collections::HashMap;

/// The batch the running commit writes into (stream.ts `open`): its revision and the position of each entry's
/// operation inside it. Lives beside the document, not in it; a new commit starts without one.
#[derive(Clone, Debug, Default)]
pub struct Open {
	rev: f64,
	at: HashMap<String, usize>,
}

fn bytes_of(v: &Json) -> f64 { v.json_bytes() as f64 }
fn batch_bytes(b: &Batch) -> f64 { bytes_of(&b.to_json()) }
/// The tally exactly (each batch and the comma after it).
fn exact(st: &StreamState) -> f64 { st.log.iter().map(|b| batch_bytes(b) + 1.0).sum() }

/// A mutation without a visible entry delta still takes part in its commit's revision.
pub fn touch(stream: &mut Option<StreamState>, open: &mut Option<Open>, now: f64, max_log_bytes: f64) {
	if open.is_some() {
		return;
	}
	let st = stream.get_or_insert_with(|| StreamState { rev: 0.0, floor: 0.0, bytes: 0.0, log: vec![], rest: Object::new() });
	let rev = st.rev + 1.0;
	st.rev = rev;
	let batch = Batch { rev, at: now, ops: vec![], rest: Object::new() };
	st.bytes += batch_bytes(&batch) + 1.0;
	st.log.push(batch);
	*open = Some(Open { rev, at: HashMap::new() });
	while st.bytes > max_log_bytes && st.log.len() > 1 {
		let old = st.log.remove(0);
		st.floor = old.rev;
		st.bytes -= batch_bytes(&old) + 1.0;
	}
	if st.log.len() == 1 && st.bytes > max_log_bytes {
		st.bytes = exact(st);
	}
}

/// Records `op` (about entry `id`) in the batch of the running commit; drops the oldest batches beyond `max_log_bytes`.
pub fn record(stream: &mut Option<StreamState>, open: &mut Option<Open>, now: f64, id: &str, op: Json, max_log_bytes: f64) {
	touch(stream, open, now, max_log_bytes);
	let o = open.as_mut().expect("touch opened a batch");
	let st = stream.as_mut().expect("touch made a stream");
	let at = (o.rev - st.log[0].rev) as usize; // revisions in the log are consecutive
	let batch = &mut st.log[at];
	if let Some(&prev) = o.at.get(id) {
		// the last operation per entry wins; position keeps the order of first touch
		st.bytes += bytes_of(&op) - bytes_of(&batch.ops[prev]);
		batch.ops[prev] = op;
	} else {
		o.at.insert(id.to_owned(), batch.ops.len());
		st.bytes += bytes_of(&op) + if batch.ops.is_empty() { 0.0 } else { 1.0 };
		batch.ops.push(op);
	}
	let mut drop = 0;
	while st.bytes > max_log_bytes && drop < st.log.len() - 1 {
		// the batch being written stays
		let b = &st.log[drop];
		st.bytes -= batch_bytes(b) + 1.0;
		st.floor = b.rev;
		drop += 1;
	}
	if drop > 0 {
		st.log.drain(..drop);
	}
	if st.log.len() == 1 && st.bytes > max_log_bytes {
		st.bytes = exact(st);
	}
}

/// What `collect` found after a revision.
#[derive(Clone, Debug, PartialEq)]
pub enum Collected {
	Batches { batches: Vec<Batch>, next: f64 },
	Expired { floor: f64 },
	TooSmall(f64),
	Ahead { rev: f64 },
}

/// Batches after `after_rev` as long as they fit `cap` bytes with `overhead` for the envelope; at least one when any exist.
pub fn collect(stream: &Option<StreamState>, after_rev: f64, cap: f64, overhead: f64) -> Collected {
	let empty = StreamState { rev: 0.0, floor: 0.0, bytes: 0.0, log: vec![], rest: Object::new() };
	let st = stream.as_ref().unwrap_or(&empty);
	if after_rev > st.rev {
		return Collected::Ahead { rev: st.rev };
	}
	if after_rev < st.floor {
		return Collected::Expired { floor: st.floor };
	}
	let mut batches = vec![];
	let mut used = overhead;
	for b in &st.log {
		if b.rev <= after_rev {
			continue;
		}
		let n = batch_bytes(b) + 1.0;
		if used + n > cap {
			if batches.is_empty() {
				return Collected::TooSmall(overhead + n);
			}
			break;
		}
		batches.push(b.clone());
		used += n;
	}
	let next = batches.last().map_or(after_rev, |b: &Batch| b.rev);
	Collected::Batches { batches, next }
}

pub fn revision_of(stream: &Option<StreamState>) -> f64 { stream.as_ref().map_or(0.0, |s| s.rev) }
