// R1, slice 1 (docs/rust-portierung.md): random walks over entries, leases, expiry, the change stream and the commit
// budget, each line run by the Rust core and by the TypeScript one (test/support/core-driver.ts), answer for answer and
// state hash for state hash. Each walk has a seed of its own and small limits drawn from it, so the refusals, the deferred
// expiry and the dropped log batches are reached, not only the paths a default space takes; the test counts which
// outcomes occurred and fails when one never did.
//
// Steps: PHI_CORE_WALK_STEPS (all walks together, default 12 000); one walk: PHI_CORE_WALK_SEED.
// A seeded walk stands in for the proptest run of the acceptance (10⁶ steps) until that is set up.
mod common;
use common::walk::{diff, observe, reply, ts_reply, Walk};
use common::TsDriver;
use phi_core::driver::Driver;
use phi_json::{digest_json, obj, Json};
use std::collections::BTreeMap;

/// Runs one walk; counts what happened into `seen`.
fn walk(seed: u64, steps: usize, seen: &mut BTreeMap<&'static str, usize>) {
	let mut w = Walk::new(seed);
	let mut rust = Driver::new();
	let mut lines = vec![w.init()];
	let mut answers = vec![rust.step(&lines[0])];
	let mut hashes = vec![digest_json(&rust.space.state.to_json()).unwrap()];
	for _ in 0..steps {
		let rev = rust.space.state.stream.as_ref().map_or(0.0, |s| s.rev);
		let line = w.line(rev);
		let r = rust.step(&line);
		observe(&mut w, &line, &r, &rust.space, seen);
		let s = &rust.space.state;
		hashes.push(digest_json(&s.to_json()).unwrap());
		answers.push(r);
		lines.push(line);
	}
	let mut ts = TsDriver::start();
	let ts_answers = ts.run(&lines);
	for (i, (line, t)) in lines.iter().zip(&ts_answers).enumerate() {
		let want = ts_reply(t);
		let got = reply(&answers[i]);
		let state = t.get("state").and_then(Json::as_str).unwrap();
		if want == got && state == hashes[i] {
			continue;
		}
		// post mortem: both states right after the diverging step
		let mut ts = TsDriver::start();
		ts.run(&lines[..=i]);
		let dump = ts.step(&obj! { "op" => "revision", "dump" => true });
		let mut rust = Driver::new();
		for l in &lines[..=i] {
			let _ = rust.step(l);
		}
		let mut paths = vec![];
		diff(&rust.space.state.to_json(), dump.get("dump").unwrap(), "state", &mut paths);
		panic!(
			"seed {seed}, step {i}: {}\n  Rust:       {got:?}\n  TypeScript: {want:?}\n  state differs: {}\n  {}",
			line.to_json_text(),
			state != hashes[i],
			paths.join("\n  ")
		);
	}
}

#[test]
fn random_walks_agree_with_the_typescript_core() {
	let total: usize = std::env::var("PHI_CORE_WALK_STEPS").ok().and_then(|s| s.parse().ok()).unwrap_or(12_000);
	let mut seen = BTreeMap::new();
	if let Some(seed) = std::env::var("PHI_CORE_WALK_SEED").ok().and_then(|s| s.parse().ok()) {
		walk(seed, total, &mut seen);
		return;
	}
	let per_walk = 400;
	let walks = total.div_ceil(per_walk);
	for seed in 0..walks as u64 {
		walk(seed, per_walk, &mut seen);
	}
	eprintln!("{seen:#?}");
	if total < 12_000 {
		return; // too short to reach every outcome
	}
	let missing = [
		"write ResourceExhausted",
		"write LimitError",
		"write IllegalArgumentError",
		"write PermissionError",
		"write TransactionError",
		"write with a lease of 0",
		"expiry deferred",
		"log dropped batches",
		"nextExpiry null",
		"probe took",
		"probe read",
		"probe TransactionError",
		"renew UnknownLeaseError",
		"renew PermissionError",
		"renew IllegalArgumentError",
		"cancel PermissionError",
		"listPage IllegalArgumentError",
		"list IllegalArgumentError",
		"changes RevisionAhead",
		"changes SnapshotExpired",
		"changes IllegalArgumentError",
		"changes ResponseBudgetTooSmall",
		"changes with more",
		"announce LimitError",
		"createTxn LimitError",
		"createTxn IllegalArgumentError",
		"commitTxn TransactionError",
		"commitTxn PermissionError",
		"abortTxn PermissionError",
		"probe locked",
		"probe PermissionError",
		"ok under a transaction",
		"entries returned by an abort",
		"entries written under a transaction",
		"list TransactionError",
		"a snapshot page with a next",
		"a snapshot read to its end",
		"a whole read without a snapshot",
		"snapshotPage SnapshotExpired",
		"snapshotPage PermissionError",
		"snapshotPage IllegalArgumentError",
		"snapshotPage ResourceExhausted",
		"snapshotPage ResponseBudgetTooSmall",
		"notify LimitError",
		"notify IllegalArgumentError",
		"notify ResourceExhausted",
		"events IllegalArgumentError",
		"events ResponseBudgetTooSmall",
		"ack InvalidAck",
		"ack MailboxEpochMismatch",
		"appendMail ResourceExhausted",
		"events in a mailbox",
		"a mailbox with a gap",
		"a mailbox acknowledged",
		"a registration closed in a mailbox",
		"a timeout in a mailbox",
		"a bundled event pending",
		"a bundled event sent",
		"a release queue",
		"a fanout job for a consumer",
		"addWaiter LimitError",
		"addWaiter IllegalArgumentError",
		"addWaiter ResourceExhausted",
		"a waiter waits",
		"a parked request waits",
		"a fanout job waits",
		"events in the outbox",
		"a claim's result expired",
		"a claim decided with a result",
		"admit fresh",
		"admit pending",
		"admit done",
		"admit cancelled",
		"admit RequestConflict",
		"admit RequestExpired",
		"admit ResultExpired",
		"admit LimitError",
		"admit TypeError",
		"issueGeneration TypeError",
		"issueGeneration LimitError",
		"decide LimitError",
		"decide Error",
		"lookup RequestExpired",
		"lookup pending",
		"lookup done",
		"cancelRequest RequestExpired",
		"cancelRequest done",
		"cancelRequest cancelled",
		"released a transaction",
		"releaseTxn found nothing",
		"setLimits IllegalArgumentError",
		"setLimits ok",
		"setCompletionProfiles TransactionError",
		"commitTxn CompletionViolation",
		"renew CompletionViolation",
		"probe CompletionViolation",
		"a task committed",
	]
	.into_iter()
	.filter(|k| !seen.contains_key(k))
	.collect::<Vec<_>>();
	assert!(missing.is_empty(), "no walk reached {missing:?}; seen: {seen:#?}");
}
