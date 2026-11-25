// Health reporting, counters and the limits file (docs/zanzibar-agent-filesystem-plan.en.md, phase 5): health moves
// between ok, maintenance and degraded and names the state backup's lag; the counters count offered operations by
// name and error code, never a caller's own names; a limits file accepts known keys with positive integers only.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newBackupKey, readBackupKey } from "../server/archive.ts";
import { backupState } from "../server/backup.ts";
import { parseLimits } from "../server/limits.ts";
import { Histogram } from "../server/metrics.ts";
import { FilesService } from "../server/service.ts";
import { FILE_OPS, runOp } from "../server/wire.ts";

test("health: ok, maintenance, degraded, the state backup's lag and the store sizes", async () => {
	const dir = mkdtempSync(join(tmpdir(), "spaces-files-h-"));
	const svc = await FilesService.open({ dataDir: join(dir, "data"), stateDir: join(dir, "state"), blobDir: join(dir, "blobs") });
	try {
		await svc.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
		let h = await svc.health();
		assert.equal(h.status, "ok");
		assert.equal(h.tenants, 1);
		assert.equal((h.state as { stateBackupDue: boolean }).stateBackupDue, true, "no state backup yet");
		const s = h.store as { fileBytes: number; freeBytes: number; walBytes: number };
		assert.ok(s.fileBytes > 0 && s.freeBytes >= 0 && s.walBytes >= 0);
		newBackupKey(join(dir, "k"));
		backupState(svc, join(dir, "s.bk"), readBackupKey(join(dir, "k")));
		assert.equal(((await svc.health()).state as { stateBackupDue: boolean }).stateBackupDue, false);
		svc.state.rotateKey(svc.limits.retryWindowMs);
		assert.equal(((await svc.health()).state as { stateBackupDue: boolean }).stateBackupDue, true, "a key change waits for the next backup");
		await svc.setMode("maintenance");
		assert.equal((await svc.health()).status, "maintenance");
		await svc.setMode("normal");
		svc.state.closeTenant("acme", "inconsistentState", {});
		h = await svc.health();
		assert.equal(h.status, "degraded");
		assert.deepEqual(h.closedTenants, [{ tenantId: "acme", reason: "inconsistentState" }]);
	} finally { await svc.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("counters: adapter calls by offered name and code, queue wait and run, evaluator work", async () => {
	const svc = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		await svc.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
		const h = (await svc.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		await runOp(FILE_OPS, svc, h, "workspaces", {});
		await runOp(FILE_OPS, svc, h, "read", { workspace: "lea", path: "none.md" });
		await runOp(FILE_OPS, svc, h, "mine-own-name-1", {});
		await runOp(FILE_OPS, svc, h, "mine-own-name-2", {});
		await runOp(FILE_OPS, svc, "no-such-handle", "list", { workspace: "lea", path: "." });
		const m = svc.metrics.snapshot();
		assert.deepEqual(Object.keys(m.ops), ["(unknown)", "list", "read", "workspaces"]);
		assert.equal(m.ops["(unknown)"].latency.count, 2);
		assert.deepEqual(m.ops.read.errors, { notFound: 1 });
		assert.deepEqual(m.ops.list.errors, { unauthenticated: 1 });
		assert.deepEqual(m.ops.workspaces.errors, {});
		assert.ok(m.queueWait.count >= 2 && m.queueRun.count >= 2, "the calls that reached a queue");
		assert.ok(m.evaluator.decisions > 0 && m.evaluator.lookups > 0);
		assert.ok(!JSON.stringify(m).includes("lea"), "no tenant, actor or path in the counters");
	} finally { await svc.close(); }
	const hist = new Histogram();
	for (const v of [0.5, 3, 3, 40, 9000]) hist.add(v);
	const v = hist.view();
	assert.deepEqual([v.count, v.maxMs, v.p50Ms, v.p99Ms], [5, 9000, 5, 9000]);
});

test("the limits file: known keys, positive integers, and the whole set must fit the tenant Spaces", async () => {
	assert.deepEqual(parseLimits('{"maxFileBytes": 1048576, "maxPathDepth": 8}'), { maxFileBytes: 1048576, maxPathDepth: 8 });
	assert.throws(() => parseLimits('{"maxFileByte": 1}'), /unknown limit "maxFileByte"/);
	assert.throws(() => parseLimits('{"maxFileBytes": 0}'), /positive integer/);
	assert.throws(() => parseLimits('{"maxFileBytes": "1"}'), /positive integer/);
	assert.throws(() => parseLimits('[1]'), /one JSON object/);
	assert.throws(() => parseLimits('{'), /no JSON/);
	await assert.rejects(FilesService.open({ dataDir: null, stateDir: null, blobDir: null, limits: parseLimits('{"maxFileBytes": 1099511627776}') }));
});
