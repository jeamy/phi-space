// RunGate and RunController (docs/betrieb-und-mobile-steuerung.md §6, §7.4 cases 2, 4, 8, 10; §8 B2/B3).
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "../src/core.ts";
import { PhiSpaces } from "../src/client.ts";
import { createSpace, spaceDoc } from "../src/spaces.ts";
import { RunBusy, RunController, localRunMember, type RunMember, type RunSpec } from "../src/run-controller.ts";
import { SIEVE_GATED_PROFILE, collectSieveResults, configureGatedSieveSpace, prepareSieveRun, processSieveTask, type SieveConfig } from "../examples/sieve.ts";
import { BACKENDS, ctx, PersistentHome } from "./support/persistent.ts";

const T = (type: string, fields: c.Fields = {}): c.Template => ({ type, fields });
const cmd = (kind: c.RunGateKind, revision: number, commandId = `${kind}-${revision}`): c.RunGateCommand => ({ runId: "r1", commandId, kind, revision });
const task = (n: number, runId = "r1") => ({ type: "SieveTask", fields: { runId, taskId: `${runId}:${n}`, rangeStart: n * 10, rangeEnd: n * 10 + 10 } });
const result = (n: number, o: Partial<{ runId: string; rangeEnd: number }> = {}) => ({ type: "SieveResult", fields: { runId: o.runId ?? "r1", taskId: `${o.runId ?? "r1"}:${n}`, rangeStart: n * 10, rangeEnd: o.rangeEnd ?? n * 10 + 10, primes: [] } });
function gated(): c.SpaceState {
	const s = c.initialState(); s.spaceId = "sp";
	c.setCompletionProfiles(s, [SIEVE_GATED_PROFILE], 0);
	return s;
}
function running(): c.SpaceState {
	const s = gated();
	c.applyRunGate(s, 0, cmd("prepare", 1));
	for (let n = 0; n < 3; n++) c.write(s, 0, task(n), null, c.FOREVER);
	c.applyRunGate(s, 0, cmd("release", 2));
	return s;
}

test("gated tasks are written only while preparing and are invisible to takes until released", () => {
	const s = gated();
	assert.throws(() => c.write(s, 0, task(0), null, c.FOREVER), c.RunGateConflict);
	c.applyRunGate(s, 0, cmd("prepare", 1));
	c.write(s, 0, task(0), null, c.FOREVER);
	const t = c.createTxn(s, 0, 60_000);
	assert.equal(c.probe(s, 1, T("SieveTask"), t.id, true).status, "none", "preparing: no take, also not as a conflict");
	assert.equal(c.count(s, 1, T("SieveTask")), 1, "reads still see the task");
	const w = c.addWaiter(s, 1, { template: T("SieveTask"), take: true, target: "worker", timeout: 60_000 });
	assert.equal(s.waiters.length, 1);
	c.applyRunGate(s, 2, cmd("release", 2));
	assert.equal(s.waiters.length, 0, "release serves the waiting take");
	const ev = s.outbox.find(e => e.eventId === w)!;
	assert.deepEqual(s.txns[ev.txn!]!.runs, { r1: 2 }, "a waiter's take binds its transaction too");
	assert.throws(() => c.write(s, 3, task(1), null, c.FOREVER), c.RunGateConflict, "no tasks after preparation");
	assert.throws(() => c.write(s, 3, result(0), null, c.FOREVER), c.CompletionViolation, "results need a bound transaction");
	assert.throws(() => c.write(s, 3, result(0), t.id, c.FOREVER), c.CompletionViolation, "an unbound transaction cannot publish results");
});

test("case 2: pause fences new bindings and lease renewal; a bound transaction may finish before the gate pauses", () => {
	const s = running();
	const a = c.createTxn(s, 0, 60_000), b = c.createTxn(s, 0, 60_000);
	assert.equal(c.probe(s, 1, T("SieveTask"), a.id, true).status, "found");
	const fenced = c.applyRunGate(s, 2, cmd("pause", 3));
	assert.equal(fenced.phase, "fenced"); assert.equal(fenced.boundTxns, 1); assert.equal(fenced.state, "running");
	assert.equal(c.probe(s, 3, T("SieveTask"), b.id, true).status, "none", "no new take while pausing");
	assert.equal(c.probe(s, 3, T("SieveTask"), null, true).status, "none", "host code is fenced too");
	assert.throws(() => c.renew(s, 3, a.id, 30_000), c.RunGateConflict);
	assert.throws(() => c.applyRunGate(s, 3, cmd("resume", 4)), c.RunGateConflict, "no command overtakes an unfinished pause");
	c.write(s, 4, result(0), a.id, c.FOREVER);
	c.commitTxn(s, 5, a.id);
	assert.equal(c.runGateView(s, "r1")!.state, "paused", "last bound commit completes the barrier");
	assert.deepEqual(c.applyRunGate(s, 6, cmd("pause", 3)).phase, "applied");
	assert.equal(c.probe(s, 6, T("SieveTask"), b.id, true).status, "none", "no run commit after a confirmed pause");
	c.applyRunGate(s, 7, cmd("resume", 4));
	assert.equal(c.probe(s, 8, T("SieveTask"), b.id, true).status, "found");
});

test("case 2: an expiring bound transaction completes the barrier and returns its task", () => {
	const s = running();
	const a = c.createTxn(s, 0, 1000);
	c.probe(s, 1, T("SieveTask"), a.id, true);
	assert.equal(c.applyRunGate(s, 2, cmd("stop", 3)).phase, "fenced");
	assert.equal(c.applyRunGate(s, 5000, cmd("stop", 3)).phase, "applied");
	assert.equal(c.runGateView(s, "r1")!.state, "stopped");
	assert.equal(c.count(s, 5000, T("SieveTask")), 3, "the reserved task is back, but stays untakeable");
	assert.throws(() => c.applyRunGate(s, 5001, cmd("resume", 4)), c.RunGateConflict, "stopped is terminal");
});

test("an unbounded transaction cannot hold a pause open: gated takes cap its lease", () => {
	const s = running();
	const t = c.createTxn(s, 0, c.FOREVER);
	c.probe(s, 1, T("SieveTask"), t.id, true);
	assert.equal(s.txns[t.id]!.expires, 60_001, "maxLeaseMs of the gated profile");
	assert.equal(c.applyRunGate(s, 2, cmd("pause", 3)).phase, "fenced");
	assert.equal(c.applyRunGate(s, 60_001, cmd("pause", 3)).phase, "applied");
});

test("gates need a gated profile, and gated profiles stay while a run is not stopped", () => {
	const plain = c.initialState();
	c.setCompletionProfiles(plain, [{ ...SIEVE_GATED_PROFILE, gateField: undefined }], 0);
	assert.throws(() => c.applyRunGate(plain, 0, cmd("prepare", 1)), c.RunGateConflict, "a gate without gated profile would confirm a pause that stops nothing");
	assert.throws(() => c.setCompletionProfiles(c.initialState(), [{ ...SIEVE_GATED_PROFILE, maxLeaseMs: undefined }], 0), c.IllegalArgumentError);
	const s = running();
	assert.throws(() => c.setCompletionProfiles(s, [], 1), c.RunGateConflict);
	c.applyRunGate(s, 1, cmd("stop", 3));
	c.setCompletionProfiles(s, [], 2);
	const fresh = gated();
	assert.equal(c.applyRunGate(fresh, 0, cmd("stop", 5)).state, "stopped", "stop without a gate leaves a terminal gate");
	assert.throws(() => c.applyRunGate(fresh, 0, cmd("prepare", 1)), c.RunGateConflict, "a late prepare is refused");
});

test("case 8: the same revision with another command conflicts and changes nothing; the same command replays its ack", () => {
	const s = running();
	const first = c.applyRunGate(s, 1, cmd("pause", 3, "pause-a"));
	const before = c.runGateView(s, "r1");
	assert.throws(() => c.applyRunGate(s, 2, cmd("pause", 3, "pause-b")), c.RunGateConflict);
	assert.throws(() => c.applyRunGate(s, 2, cmd("stop", 3, "pause-a")), c.RunGateConflict);
	assert.deepEqual(c.runGateView(s, "r1"), before);
	assert.deepEqual(c.applyRunGate(s, 3, cmd("pause", 3, "pause-a")), first);
	assert.throws(() => c.applyRunGate(s, 3, cmd("resume", 2, "late")), c.RunGateConflict, "older revisions are refused");
	assert.deepEqual(c.applyRunGate(s, 3, cmd("release", 2)).state, "running", "history answers an old replay with its stored state");
	assert.throws(() => c.applyRunGate(s, 3, { runId: "r1", commandId: "x", kind: "resume" as const, revision: 1.5 }), c.IllegalArgumentError);
});

test("case 10: commits without result, with two results or with wrong bounds fail with CompletionViolation", () => {
	for (const bad of ["missing", "two", "bounds", "foreign"] as const) {
		const s = running();
		const t = c.createTxn(s, 0, 60_000);
		const got = c.probe(s, 1, T("SieveTask", { taskId: "r1:0" }), t.id, true);
		assert.equal(got.status, "found");
		if (bad === "foreign") { assert.throws(() => c.write(s, 2, result(0, { runId: "other" }), t.id, c.FOREVER), c.CompletionViolation); continue; }
		if (bad !== "missing") c.write(s, 2, result(0, bad === "bounds" ? { rangeEnd: 9 } : {}), t.id, c.FOREVER);
		if (bad === "two") c.write(s, 2, result(0), t.id, c.FOREVER);
		assert.throws(() => c.commitTxn(s, 3, t.id), c.CompletionViolation, bad);
		c.abortTxn(s, 4, t.id);
		assert.equal(c.count(s, 5, T("SieveTask")), 3, `${bad}: the task is still there`);
	}
});

const sieve = (runId: string): SieveConfig => ({ runId, start: 1, end: 1001, blockSize: 128 });
function sieveMember(h: Parameters<typeof localRunMember>[0], spaceId: string): RunMember {
	return localRunMember(h, ctx, spaceId, (run, space) => prepareSieveRun(h, run.config as SieveConfig, { space }).then(() => {}));
}

for (const backend of BACKENDS) test(`${backend}: case 2 and 4: a controlled sieve run prepares behind its gate, pauses with ACKs and resumes`, async () => {
	const home = new PersistentHome(backend);
	try {
		let h = await home.open();
		const sid = (await h.commit(tx => createSpace(tx, "sieve-run", Date.now()), ctx)).spaceId;
		await configureGatedSieveSpace(h, sid);
		let controller = new RunController({ host: h, ctx, member: id => sieveMember(h, id) });
		const spec: RunSpec = { runId: "run-1", kind: "sieve", config: sieve("run-1"), members: [sid] };

		// Case 4: preparation fails after some seeds; an already running worker must not take anything.
		let commits = 0;
		home.faults.arm("failBeforeCommit", () => ++commits === 5);
		// The fault hits a Member or a journal commit: either the run shows the error or the controller "crashes".
		const partial = await controller.start("start-1", spec).catch(e => e);
		if (!(partial instanceof Error)) { assert.equal(partial.state, "preparing"); assert.ok(partial.pending!.errors[sid], "the failed preparation is visible"); }
		assert.equal(home.faults.fired, 1);
		home.crash(h);
		h = await home.open();
		controller = new RunController({ host: h, ctx, member: id => sieveMember(h, id) });
		assert.equal((await controller.status("run-1"))!.state, "preparing");
		const worker = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: sid });
		assert.ok(await worker.count(T("SieveTask")) > 0, "partially prepared");
		assert.equal(await processSieveTask(worker, "run-1"), false, "an existing worker takes nothing before release");
		const started = await controller.start("start-1", spec); // same command: resumes, no second run
		assert.equal(started.state, "running"); assert.equal(started.revision, 2);
		await assert.rejects(controller.start("start-2", spec), c.RunGateConflict);
		const local = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: sid });
		const ids = (await local.readAll(T("SieveTask"))).map(e => e.fields.taskId);
		assert.equal(ids.length, 8); assert.equal(new Set(ids).size, 8, "no duplicate tasks after retry");

		// Case 2: pause while a worker holds a task; it may commit before the pause is confirmed.
		let view: Awaited<ReturnType<RunController["pause"]>> | undefined;
		await processSieveTask(local, "run-1", { beforeCommit: async () => { view = await controller.pause("pause-1", "run-1"); } });
		assert.equal(view!.state, "pausing"); assert.deepEqual(view!.pending!.fenced, [sid]);
		await assert.rejects(controller.resume("resume-early", "run-1"), RunBusy);
		const paused = await controller.advance("run-1");
		assert.equal(paused.state, "paused"); assert.equal(paused.revision, 3);
		assert.equal(await processSieveTask(local, "run-1"), false, "no run commit after confirmed pause");
		assert.deepEqual(await controller.pause("pause-1", "run-1"), paused, "replay of the same command");
		await assert.rejects(controller.stop("pause-1", "run-1"), c.IllegalArgumentError);

		home.crash(h);
		h = await home.open();
		controller = new RunController({ host: h, ctx, member: id => sieveMember(h, id) });
		assert.equal((await controller.status("run-1"))!.revision, 3, "revisions survive a restart");
		assert.equal((await controller.resume("resume-1", "run-1")).state, "running");
		const w2 = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: sid });
		while (await processSieveTask(w2, "run-1")) { /* finish */ }
		const primes = await collectSieveResults(w2, sieve("run-1"));
		assert.equal(primes.length, 168);
		assert.equal((await controller.stop("stop-1", "run-1")).state, "stopped");
		await assert.rejects(controller.resume("resume-2", "run-1"), c.RunGateConflict);
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: an unreachable Member keeps the pause incomplete until it confirms`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open();
		const ids: string[] = [];
		for (const alias of ["jobs-a", "jobs-b"]) {
			const sid = (await h.commit(tx => createSpace(tx, alias, Date.now()), ctx)).spaceId;
			await h.commit(async tx => c.setCompletionProfiles(await spaceDoc(tx, sid, Date.now()), [{ taskType: "Job", resultTypes: ["Done"], equalFields: ["runId", "n"], maxResultCount: 1, maxLeaseMs: 60_000, gateField: "runId" }]), ctx);
			ids.push(sid);
		}
		let reachable = true;
		const member = (id: string): RunMember => {
			const m = localRunMember(h, ctx, id, async (run, space) => {
				await h.commit(async tx => { const s = await spaceDoc(tx, space, Date.now()); if (!c.count(s, Date.now(), T("Job", { runId: run.runId }))) c.write(s, Date.now(), { type: "Job", fields: { runId: run.runId, n: 1 } }, null, c.FOREVER); }, ctx);
			});
			return id === ids[1] ? { ...m, gate: cmd => reachable ? m.gate(cmd) : Promise.reject(new Error("unreachable")) } : m;
		};
		const controller = new RunController({ host: h, ctx, member });
		const go = await controller.start("go", { runId: "jobs", kind: "jobs", config: null, members: ids });
		assert.equal(go.state, "running", JSON.stringify(go));
		reachable = false;
		const incomplete = await controller.pause("halt", "jobs");
		assert.equal(incomplete.state, "pauseIncomplete");
		assert.deepEqual(incomplete.pending!.applied, [ids[0]]); assert.match(incomplete.pending!.errors[ids[1]!]!, /unreachable/);
		assert.deepEqual(await controller.pending(), ["jobs"]);
		const b = new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space: ids[1] });
		const tx = await b.createTransaction(60_000);
		assert.ok(await b.take(T("Job"), 0, { txn: tx.id }), "until its local fence, the unreachable Member keeps working");
		await b.abort(tx.id);
		reachable = true;
		const done = await controller.advance("jobs");
		assert.equal(done.state, "paused"); assert.equal(done.revision, 3);
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: a run whose preparation keeps failing can still be stopped`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open();
		const sid = (await h.commit(tx => createSpace(tx, "broken", Date.now()), ctx)).spaceId;
		await configureGatedSieveSpace(h, sid);
		const controller = new RunController({ host: h, ctx, member: id => localRunMember(h, ctx, id, async () => { throw new Error("preparation failed"); }) });
		const spec: RunSpec = { runId: "doomed", kind: "sieve", config: sieve("doomed"), members: [sid] };
		const view = await controller.start("start", spec);
		assert.equal(view.state, "preparing"); assert.match(view.pending!.errors[sid]!, /preparation failed/);
		await assert.rejects(controller.pause("pause", "doomed"), RunBusy, "only a stop may replace an unfinished preparation");
		const stopped = await controller.stop("stop", "doomed");
		assert.equal(stopped.state, "stopped"); assert.equal(stopped.revision, 2);
		assert.equal((await controller.start("start", spec)).state, "stopped", "replaying the start does not revive the run");
	} finally { await home.dispose(); }
});
