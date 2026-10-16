// Run result export with manifest hash and scheduled pause/resume (docs/betrieb-und-mobile-steuerung.md §7.2, §7.5).
import test from "node:test";
import assert from "node:assert/strict";
import * as c from "./src/core.ts";
import { PiSpaces } from "./src/client.ts";
import { RunController, localRunMember, runCommands } from "./src/run-controller.ts";
import { createSpace } from "./src/spaces.ts";
import { SIEVE_EXPORTER, configureGatedSieveSpace, prepareSieveRun, processSieveTask, type SieveConfig } from "./examples/sieve.ts";
import { BACKENDS, ctx, PersistentHome } from "./test/support/persistent.ts";

async function fixture(h: Awaited<ReturnType<PersistentHome["open"]>>, now: () => number) {
	const sid = (await h.commit(tx => createSpace(tx, "sieve", Date.now()), ctx)).spaceId;
	await configureGatedSieveSpace(h, sid);
	const space = (id: string) => new PiSpaces(h, ctx, Date.now, undefined, undefined, { space: id });
	const runs = new RunController({ host: h, ctx, now, member: id => localRunMember(h, ctx, id, (run, s) => prepareSieveRun(h, run.config as SieveConfig, { space: s }).then(() => {})), exporters: { sieve: SIEVE_EXPORTER }, space });
	return { sid, runs, space };
}

for (const backend of BACKENDS) test(`${backend}: the export reports a partial result as partial and a complete one with stable hashes`, async () => {
	const home = new PersistentHome(backend);
	try {
		const h = await home.open(), o = await fixture(h, Date.now);
		const config: SieveConfig = { runId: "ex", start: 1, end: 1001, blockSize: 128 };
		await o.runs.start("s", { runId: "ex", kind: "sieve", config, members: [o.sid] });
		for (let i = 0; i < 3; i++) assert.ok(await processSieveTask(o.space(o.sid), "ex"));
		const partial = await o.runs.export("ex");
		assert.deepEqual([partial.complete, partial.expected, partial.found, partial.missing.length], [false, 8, 3, 5]);
		while (await processSieveTask(o.space(o.sid), "ex")) { /* finish */ }
		const full = await o.runs.export("ex"), again = await o.runs.export("ex");
		assert.equal(full.complete, true); assert.deepEqual(full.summary, { primes: 168, first: 2, last: 997, range: [1, 1001] });
		assert.equal(full.resultHash, again.resultHash); assert.equal(full.manifestHash, partial.manifestHash, "the manifest does not depend on progress");
		assert.notEqual(full.resultHash, partial.resultHash);
		assert.equal((await runCommands(o.runs).exportRun!("e", { runId: "missing" }) as any).phase, "failed");
	} finally { await home.dispose(); }
});

for (const backend of BACKENDS) test(`${backend}: a scheduled pause runs at its time as a journaled command; inapplicable schedules are dropped`, async () => {
	const home = new PersistentHome(backend);
	try {
		let t = 1_000_000; const now = () => t;
		const h = await home.open(), o = await fixture(h, now);
		await o.runs.start("s", { runId: "win", kind: "sieve", config: { runId: "win", start: 1, end: 1001, blockSize: 128 }, members: [o.sid] });
		await o.runs.schedule("maint-pause", "win", { kind: "pause", at: t + 60_000 });
		await o.runs.schedule("maint-resume", "win", { kind: "resume", at: t + 120_000 });
		await o.runs.schedule("bad-resume", "win", { kind: "resume", at: t + 30_000 });
		assert.deepEqual(await o.runs.pending(), [], "nothing is due yet");
		t += 30_000;
		assert.deepEqual(await o.runs.pending(), ["win"]);
		assert.equal((await o.runs.advance("win")).state, "running", "a resume of a running run is dropped");
		t += 30_000;
		const paused = await o.runs.advance("win");
		assert.equal(paused.state, "paused"); assert.equal(paused.revision, 3);
		assert.equal(await processSieveTask(o.space(o.sid), "win"), false, "the window is closed");
		await o.runs.schedule("maint-resume", "win", { kind: "resume", at: 0, cancel: true });
		t += 120_000;
		assert.deepEqual(await o.runs.pending(), [], "a cancelled schedule does nothing");
		assert.equal((await o.runs.status("win"))!.state, "paused");
		const cmds = runCommands(o.runs);
		assert.deepEqual((await cmds.scheduleRun!("x", { runId: "win", kind: "resume", at: t - 1 }) as any).schedules.map((s: any) => s.id), ["x"]);
		assert.equal((await o.runs.advance("win")).state, "running");
		assert.ok((await o.runs.status("win"))!.revision === 4);
		assert.equal((await cmds.scheduleRun!("y", { runId: "win", kind: "stop", at: t }) as any).phase, "failed", "only pause and resume are scheduled");
		void c;
	} finally { await home.dispose(); }
});
