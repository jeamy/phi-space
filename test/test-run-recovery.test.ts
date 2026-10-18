// Run recovery after restores (docs/betrieb-und-mobile-steuerung.md §6 Abgleich nach Restore, §7.4 cases 9, 11-13,
// §8 B5): recovery entry fences, RunRecoveryView, reconcile, resolveRunRecovery and the control identity binding.
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.ts";
import { PhiSpaces } from "../src/client.ts";
import { beginRestore, completeRestore, restoreBatch, snapshotHash } from "../src/restore.ts";
import { RunBusy, RunController, localRunMember, type RunIdentity, type RunMember, type RunSpec } from "../src/run-controller.ts";
import { createSpace, snapshotSpace, spaceDoc } from "../src/spaces.ts";
import { BACKENDS, ctx, PersistentHome } from "./support/persistent.ts";

type Host = Awaited<ReturnType<PersistentHome["open"]>>;
const T = (type: string, fields: c.Fields = {}): c.Template => ({ type, fields });
const JOB_PROFILE: c.CompletionProfile = { taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" };
const cmd = (kind: c.RunGateKind, revision: number, extra: Partial<c.RunGateCommand> = {}): c.RunGateCommand => ({ runId: "r1", commandId: `${kind}-${revision}`, kind, revision, ...extra });

function restoreInto(target: c.SpaceState, source: c.SpaceState, recoveryId: string, now: number): void {
	// Each step is its own commit in a real host: seal() closes the running change batch like a commit does.
	c.seal(target); beginRestore(target, now, { recoveryId, expectedDataIncarnation: target.incarnation!, expectedPrimaryEpoch: target.primaryEpoch ?? 1, snapshotHash: snapshotHash(source), kind: "data" });
	for (let i = 0; i < 100 && target.restore!.stage !== "waiting"; i++) { c.seal(target); restoreBatch(target, now, source); }
	c.seal(target); completeRestore(target, now + 62_001, recoveryId);
}

test("case 11: a restored pause fence stays visible; old commands cannot finish it, only the reviewed decision", () => {
	const fresh = (incarnation: string) => { const s = c.initialState(); s.spaceId = "sp"; s.incarnation = incarnation; s.stream = { rev: 0, floor: 0, bytes: 0, log: [] } as any; c.setCompletionProfiles(s, [JOB_PROFILE], 0); return s; };
	const s = fresh("i1");
	c.applyRunGate(s, 0, cmd("prepare", 1));
	c.write(s, 0, { type: "Job", fields: { runId: "r1", n: 1 } }, null, c.FOREVER);
	c.write(s, 0, { type: "Job", fields: { runId: "r1", n: 2 } }, null, c.FOREVER);
	c.applyRunGate(s, 0, cmd("release", 10));
	const t = c.createTxn(s, 0, 30_000);
	c.probe(s, 1, T("Job"), t.id, true);
	assert.equal(c.applyRunGate(s, 2, cmd("pause", 11)).phase, "fenced", "pause 11 installed, gate still running/10");
	const snapshot = c.plain(s);

	const target = fresh("i2");
	restoreInto(target, snapshot, "rec-1", 10);
	const view = c.recoverRunGate(target, 100_000, { runId: "r1", recoveryId: "rec-1" });
	assert.deepEqual([view.gate!.state, view.gate!.revision, view.fence!.revision, view.historical, view.stable], ["running", 10, 11, true, true]);
	assert.equal(view.maxRevision, 11);
	assert.equal(view.incarnation, target.incarnation, "the view names the new data incarnation");
	assert.throws(() => c.applyRunGate(target, 100_001, cmd("pause", 11)), c.RunGateConflict, "the old journal cannot complete the restored barrier");
	assert.throws(() => c.applyRunGate(target, 100_001, cmd("resume", 12)), c.RunGateConflict);
	assert.throws(() => c.applyRunGate(target, 100_001, cmd("resume", 12, { recoveryId: "rec-1" })), c.RunGateConflict, "no resume before the pause barrier");
	assert.throws(() => c.applyRunGate(target, 100_001, cmd("pause", 12, { recoveryId: "rec-1", expect: { revision: 9, state: "running" } })), /review again/);
	const ack = c.applyRunGate(target, 100_002, cmd("pause", 12, { recoveryId: "rec-1", expect: { revision: 10, state: "running" } }));
	assert.deepEqual([ack.state, ack.phase], ["paused", "applied"]);
	assert.equal(c.runGateView(target, "r1")!.recovery, undefined, "the confirmed decision ends the recovery fence");
	c.applyRunGate(target, 100_003, cmd("resume", 13));
	assert.equal(c.count(target, 100_004, T("Job")), 2);
	assert.equal(c.probe(target, 100_004, T("Job"), c.createTxn(target, 100_004, 30_000).id, true).status, "none", "restoredUnverified tasks stay untakeable after resume");
});

test("recovery entry fences block takes, task writes and lease extension; bound transactions may still finish", () => {
	const s = c.initialState(); s.spaceId = "sp";
	c.setCompletionProfiles(s, [JOB_PROFILE], 0);
	c.applyRunGate(s, 0, cmd("prepare", 1));
	for (const n of [1, 2]) c.write(s, 0, { type: "Job", fields: { runId: "r1", n } }, null, c.FOREVER);
	c.applyRunGate(s, 0, cmd("release", 2));
	const t = c.createTxn(s, 0, 30_000), u = c.createTxn(s, 0, 30_000);
	c.probe(s, 1, T("Job"), t.id, true);
	const view = c.recoverRunGate(s, 2, { runId: "r1", recoveryId: "rec" });
	assert.equal(view.stable, false); assert.equal(view.boundTxns, 1);
	assert.equal(c.probe(s, 3, T("Job"), u.id, true).status, "none");
	assert.throws(() => c.renew(s, 3, t.id, 10_000), c.RunGateConflict);
	c.write(s, 4, { type: "Done", fields: { runId: "r1", n: 1 } }, t.id, c.FOREVER);
	c.commitTxn(s, 5, t.id);
	assert.equal(c.recoverRunGate(s, 6, { runId: "r1", recoveryId: "rec" }).stable, true);
	assert.equal(c.recoverRunGate(s, 6, { runId: "missing", recoveryId: "rec" }).present, false, "a missing gate is reported, not invented");
});

// Members are named Spaces of one store; the controller journal lives in its own store, so it can be lost.
async function setup(backend: "jsonl" | "sqlite", aliases: string[]) {
	const data = new PersistentHome(backend), control = [new PersistentHome(backend)];
	const h = await data.open(), ids: string[] = [];
	for (const alias of aliases) {
		const sid = (await h.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId;
		await h.commit(async tx => c.setCompletionProfiles(await spaceDoc(tx, sid, Date.now()), [JOB_PROFILE]), ctx);
		ids.push(sid);
	}
	const faults: { down: Set<string>; lose: Set<string> } = { down: new Set(), lose: new Set() };
	const member = (id: string): RunMember => {
		const m = localRunMember(h, ctx, id, async (run, space) => {
			await h.commit(async tx => { const s = await spaceDoc(tx, space, Date.now()); for (const n of [1, 2]) if (!c.count(s, Date.now(), T("Job", { runId: run.runId, n }))) c.write(s, Date.now(), { type: "Job", fields: { runId: run.runId, n } }, null, c.FOREVER); }, ctx);
		});
		const guard = async <T>(f: () => Promise<T>) => { if (faults.down.has(id)) throw new Error("Member unreachable"); const v = await f(); if (faults.lose.delete(id)) throw new Error("reply lost"); return v; };
		return { spaceId: id, prepare: (r, x) => guard(() => m.prepare(r, x)), gate: x => guard(() => m.gate(x)), recover: (r, q) => guard(() => m.recover(r, q)) };
	};
	let identity: RunIdentity = { authorityId: "authority", incarnation: "control-1" };
	let controlHost = await control[0]!.open();
	const make = () => new RunController({ host: controlHost, ctx, member, identity: async () => identity });
	return {
		h, ids, faults, data, make,
		setIdentity: (i: RunIdentity) => { identity = i; },
		/** The controller host crashes and comes back with its journal. */
		restart: async () => { control[0]!.crash(controlHost); controlHost = await control[0]!.open(); return make(); },
		/** The controller host is replaced by one without the run journal. */
		loseJournal: async () => { const fresh = new PersistentHome(backend); control.push(fresh); controlHost = await fresh.open(); return make(); },
		gate: async (sid: string, runId: string) => c.runGateView((await snapshotSpace(h, sid, ctx))!, runId),
		dispose: async () => { await data.dispose(); for (const x of control) await x.dispose(); },
	};
}
const spec = (runId: string, members: string[]): RunSpec => ({ runId, kind: "jobs", config: null, members });

for (const backend of BACKENDS) test(`${backend}: case 9: an older journal and an older restored Member gate need review; new revisions exceed all evidence`, async () => {
	const o = await setup(backend, ["a", "b"]);
	try {
		const [a, b] = o.ids as [string, string];
		const old = o.make();
		assert.equal((await old.start("start", spec("run9", [a, b]))).state, "running");
		assert.equal((await old.pause("p3", "run9")).state, "paused");
		const snapshotB = (await snapshotSpace(o.h, b, ctx))!; // b's data backup at paused/3
		// Another controller incarnation moves the Members on; the old journal still says paused/3.
		const other = new RunController({ host: await new PersistentHome(backend).open(), ctx, member: id => localRunMember(o.h, ctx, id, async () => {}) });
		await other.reconcile("adopt", "run9", "adopt-1", { kind: "jobs", members: [a, b] });
		const adopted = (await other.status("run9"))!;
		assert.equal(adopted.state, "needsReview", "gates of unknown origin are never confirmed automatically");
		await other.resolve("adopt-resume", "run9", { expectedViewHash: adopted.recovery!.viewHash!, decision: "resume" });
		assert.deepEqual([(await o.gate(a, "run9"))!.state, (await o.gate(a, "run9"))!.revision], ["running", 5]);
		// b is data-restored from its older backup.
		await o.h.commit(async tx => { const s = await spaceDoc(tx, b, Date.now()); restoreInto(s, snapshotB, "data-b", Date.now()); }, ctx);

		const view = await old.reconcile("rec9", "run9", "rec-9");
		assert.equal(view.state, "needsReview");
		const vb = view.recovery!.views[b]!, va = view.recovery!.views[a]!;
		assert.deepEqual([va.gate!.state, va.gate!.revision], ["running", 5]);
		assert.equal(vb.historical, true); assert.equal(vb.restored!.revision, 3, "the restored backup is evidence, not the current gate");
		assert.equal(vb.maxRevision, 5);
		await assert.rejects(old.pause("p-late", "run9"), RunBusy, "no normal command during recovery");
		await assert.rejects(old.resolve("bad", "run9", { expectedViewHash: "0".repeat(64), decision: "pause" }), /review again/);
		const done = await old.resolve("res9", "run9", { expectedViewHash: view.recovery!.viewHash!, decision: "resume" });
		assert.equal(done.state, "running"); assert.equal(done.revision, 7, "pause barrier at 6 above all evidence, resume at 7");
		assert.equal((await o.gate(b, "run9"))!.revision, 7);
		const wb = new PhiSpaces(o.h, ctx, Date.now, undefined, undefined, { space: b });
		const tx = await wb.createTransaction(30_000);
		assert.equal(await wb.take(T("Job"), 0, { txn: tx.id }), null, "restoredUnverified Jobs stay untakeable after the resume");
		assert.ok(await wb.count(T("Job")) > 0);
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: case 12: partial resume, lost journal and stopped history: never resumed, stop is confirmed`, async () => {
	const o = await setup(backend, ["a", "b", "c"]);
	try {
		const [a, b, cc] = o.ids as [string, string, string];
		let controller = o.make();
		await controller.start("start", spec("run12", [a, b, cc]));
		await controller.pause("p3", "run12");
		o.faults.down.add(b); o.faults.down.add(cc);
		assert.equal((await controller.resume("r4", "run12")).state, "resuming");
		assert.equal((await o.gate(a, "run12"))!.state, "running", "resume applied on a only");
		await o.h.commit(async tx => { c.applyRunGate(await spaceDoc(tx, cc, Date.now()), Date.now(), { runId: "run12", commandId: "old-stop", kind: "stop", revision: 9 }); }, ctx);
		o.faults.down.clear();

		controller = await o.loseJournal();
		await assert.rejects(controller.reconcile("rec", "run12", "rec-12"), /name its kind and Members/);
		const view = await controller.reconcile("rec", "run12", "rec-12", { kind: "jobs", members: [a, b, cc] });
		assert.equal(view.state, "needsReview");
		assert.deepEqual([a, b, cc].map(m => view.recovery!.views[m]!.gate!.state), ["running", "paused", "stopped"]);
		const hash = view.recovery!.viewHash!;
		await assert.rejects(controller.resolve("res", "run12", { expectedViewHash: hash, decision: "resume" }), /never resumed/);
		assert.equal((await controller.status("run12"))!.state, "needsReview", "the recovery fence stays");
		const wa = new PhiSpaces(o.h, ctx, Date.now, undefined, undefined, { space: a });
		assert.equal(await wa.take(T("Job"), 0, { txn: (await wa.createTransaction(30_000)).id }), null, "no work while unresolved");
		const stopped = await controller.resolve("res-stop", "run12", { expectedViewHash: hash, decision: "stop" });
		assert.equal(stopped.state, "stopped"); assert.equal(stopped.revision, 10);
		for (const m of [a, b, cc]) assert.equal((await o.gate(m, "run12"))!.state, "stopped");
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: case 13: a decision survives ACK loss and controller restart; a changed Member forces a new review`, async () => {
	const o = await setup(backend, ["a", "b"]);
	try {
		const [a, b] = o.ids as [string, string];
		let controller = o.make();
		await controller.start("start", spec("run13", [a, b]));
		o.faults.down.add(b);
		assert.equal((await controller.pause("p3", "run13")).state, "pauseIncomplete");
		o.faults.down.clear();
		const review = await controller.reconcile("rec", "run13", "rec-13");
		assert.equal(review.state, "needsReview"); assert.deepEqual(review.recovery!.abandoned, { commandId: "p3", kind: "pause", revision: 3 }, "the pending pause is parked, not resent");
		assert.equal((await o.gate(b, "run13"))!.state, "running");

		o.faults.lose.add(b);
		const first = await controller.resolve("decide", "run13", { expectedViewHash: review.recovery!.viewHash!, decision: "pause" });
		assert.equal(first.state, "reconciling"); assert.match(first.pending!.errors[b]!, /reply lost/);
		controller = await o.restart();
		const done = await controller.advance("run13");
		assert.equal(done.state, "paused"); assert.equal(done.revision, 4);
		assert.deepEqual(await controller.resolve("decide", "run13", { expectedViewHash: review.recovery!.viewHash!, decision: "pause" }), done, "same decision, same outcome");

		// A Member changes after the review: the decision stops there and asks for a new review.
		const again = await controller.reconcile("rec2", "run13", "rec-13b");
		assert.equal(again.state, "paused", "identical paused views of known origin are confirmed with fresh ACKs");
		assert.equal(again.revision, 5);
		await controller.resume("r6", "run13");
		const third = await controller.reconcile("rec3", "run13", "rec-13c");
		assert.equal(third.state, "needsReview", "running is never confirmed automatically");
		await o.h.commit(async tx => { c.applyRunGate(await spaceDoc(tx, b, Date.now()), Date.now(), { runId: "run13", commandId: "elsewhere", kind: "pause", revision: 7, recoveryId: "rec-13c" }); }, ctx);
		const changed = await controller.resolve("decide3", "run13", { expectedViewHash: third.recovery!.viewHash!, decision: "stop" });
		assert.equal(changed.state, "needsReview", JSON.stringify(changed.recovery));
		assert.notEqual(changed.recovery!.viewHash, third.recovery!.viewHash);
		assert.match(changed.recovery!.changed![b]!, /another command/, "the unexpected change is reported");
		assert.deepEqual(changed.recovery!.partial, [a], "the already applied step stays visible");
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: a pending transition of another control incarnation is never resent`, async () => {
	const o = await setup(backend, ["a", "b"]);
	try {
		const [a, b] = o.ids as [string, string];
		const controller = o.make();
		await controller.start("start", spec("runI", [a, b]));
		o.faults.down.add(b);
		assert.equal((await controller.pause("p3", "runI")).state, "pauseIncomplete");
		o.faults.down.clear();
		o.setIdentity({ authorityId: "authority", incarnation: "control-2" }); // Control restore
		const view = await controller.advance("runI");
		assert.equal((await o.gate(b, "runI"))!.state, "running", "the old pause was not resent");
		assert.equal(view.state, "needsReview", "reconcile started on its own and found mixed views");
		assert.equal(view.recovery!.id, "control-control-2"); assert.equal(view.recovery!.abandoned!.commandId, "p3");
		assert.deepEqual(await controller.pending(), [], "the server loop has nothing to resend");
		const decided = await controller.resolve("decide", "runI", { expectedViewHash: view.recovery!.viewHash!, decision: "pause" });
		assert.equal(decided.state, "paused"); assert.equal(decided.revision, 4);
	} finally { await o.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: a data restore on a Member makes the next command start reconcile under the restore's recovery`, async () => {
	const o = await setup(backend, ["a", "b"]);
	try {
		const [a, b] = o.ids as [string, string];
		const controller = o.make();
		await controller.start("start", spec("runD", [a, b]));
		const backup = (await snapshotSpace(o.h, b, ctx))!;
		await o.h.commit(async tx => { const s = await spaceDoc(tx, b, Date.now()); restoreInto(s, backup, "Data restore #1 (b)", Date.now()); }, ctx);
		const view = await controller.pause("p3", "runD");
		assert.equal(view.state, "needsReview");
		assert.match(view.recovery!.id, /^restore-[0-9a-f]{32}$/, "a restore ID that is no gate ID is hashed");
		assert.equal(view.recovery!.abandoned!.commandId, "p3");
		assert.equal(view.recovery!.views[b]!.historical, true);
		const done = await controller.resolve("decide", "runD", { expectedViewHash: view.recovery!.viewHash!, decision: "pause" });
		assert.equal(done.state, "paused");
		for (const m of [a, b]) assert.equal((await o.gate(m, "runD"))!.recovery, undefined);
	} finally { await o.dispose(); }
});
