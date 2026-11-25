// The workload fixture is repeatable (phase 5): the same parameters and seed give the same operation mix, and its
// report carries what the exit evidence asks for: queue wait, operation latency, evaluator work, live and free store
// sizes, tenant count, directory depth, concurrency and hardware.
import test from "node:test";
import assert from "node:assert/strict";
import { runWorkload } from "./workload/workload.ts";

test("the workload fixture: the same seed gives the same mix, and the report holds every measure", async () => {
	const p = { tenants: 2, users: 2, depth: 3, files: 4, concurrency: 3, ops: 120, seed: 7, bytes: 256 };
	const a = await runWorkload(p);
	const b = await runWorkload(p);
	assert.deepEqual(a.mix, b.mix);
	assert.equal(Object.values(a.mix).reduce((x, y) => x + y, 0), 120);
	assert.notDeepEqual((await runWorkload({ ...p, seed: 8 })).mix, a.mix, "another seed, another mix");
	assert.deepEqual([a.params.tenants, a.params.depth, a.params.concurrency], [2, 3, 3]);
	assert.ok(a.queueWait.count > 0 && a.queueRun.count > 0);
	assert.ok(a.latency.read.count > 0 && a.latency.write.count > 0 && a.latency.read.p99Ms !== null);
	assert.ok(a.evaluator.decisions > 0 && a.evaluator.lookups > 0);
	assert.ok(a.store !== null && a.store.fileBytes > 0 && a.store.freeBytes >= 0);
	assert.ok(a.blobBytes > 0);
	assert.ok(a.hardware.cores > 0 && a.hardware.cpu.length > 0);
	assert.equal(Object.keys(a.outcomes).filter((k) => !/:(ok|absent|versionConflict|alreadyExists)$/.test(k)).length, 0, JSON.stringify(a.outcomes));
});
