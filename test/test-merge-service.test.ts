// lww/set step 1 (docs/ap3-replikation.md): merge types of a Space go to its entry replication controller.
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { SpaceService, StaticIdentity, DEFAULT_POLICY, EntryReplicationController, listSpaces, type Reply, type Call } from "../src/index.ts";
import { ctx } from "./support/persistent.ts";

const ids = new StaticIdentity({ "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] }, "peer-b": { principal: { peerId: "peer-b" }, roles: ["member"] } });
const ok = (r: Reply): any => { assert.ok(r.ok, JSON.stringify(r)); return (r as { ok: true; result: unknown }).result; };
const err = (r: Reply, code: string) => assert.ok(!r.ok && r.error.code === code, JSON.stringify(r));

test("merge types write, read, count, renew and delete through the entry replication controller; exclusive operations are refused", async () => {
	const h = await Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
	const s0 = new SpaceService({ host: h, ctx, identity: ids, policy: DEFAULT_POLICY });
	const g0 = ok(await s0.handle({ method: "generation" }, { peerId: "peer-a" }));void g0;
	const spaceId = (await listSpaces(h, ctx)).find(i => i.alias === "default")!.spaceId;
	const rules = [{ type: "Sensor", variant: "lww" as const, keyFields: ["sensorId"] }, { type: "Fact", variant: "set" as const }];
	const controller = new EntryReplicationController({ host: h, ctx, config: { spaceId, authorityId: "authority", replicaId: "r1", incarnation: "i1", members: [{ replicaId: "r1", incarnation: "i1" }], rules },
		authorize: async () => {}, assertActive: async () => {}, clockUncertaintyMs: () => 0 });
	const s = new SpaceService({ host: h, ctx, identity: ids, policy: DEFAULT_POLICY, merge: () => ({ controller, rules }) });
	const g = ok(await s.handle({ method: "generation" }, { peerId: "peer-a" }));let n = 0;
	const call = (method: Call["method"], args: Record<string, unknown> = {}, requestId = `r${++n}`) => s.handle({ method, request: { generation: g.generation, requestId }, args } as Call, { peerId: "peer-a" });
	// lww: the same key converges to the latest put; a retried request ID is idempotent.
	const w1 = ok(await call("write", { entry: { type: "Sensor", fields: { sensorId: "s1", v: 1 } } }, "put-1"));
	assert.equal(w1.replicated, true);
	assert.deepEqual(ok(await call("write", { entry: { type: "Sensor", fields: { sensorId: "s1", v: 1 } } }, "put-1")), w1, "retry of the same request");
	ok(await call("write", { entry: { type: "Sensor", fields: { sensorId: "s1", v: 2 } } }));
	const read = ok(await call("read", { template: { type: "Sensor", fields: { sensorId: "s1" } } }));
	assert.deepEqual([read.replicated, read.entry.fields.v, read.entry.owner], [true, 2, { peerId: "peer-a", agentId: "w1" }]);
	assert.equal(ok(await call("count", { template: { type: "Sensor" } })).value, 1);
	err(await call("write", { entry: { type: "Sensor", fields: { v: 3 } } }), "BadRequest");
	// set: each add is its own tag (add-wins), even with equal fields.
	ok(await call("write", { entry: { type: "Fact", fields: { seen: "x" } } }));ok(await call("write", { entry: { type: "Fact", fields: { seen: "x" } } }));
	const all = ok(await call("readAll", { template: { type: "Fact" } }));
	assert.deepEqual([all.items.length, all.replicated, all.items.every((i: any) => i.replicated)], [2, true, true]);
	// No exclusive allocation on merge types.
	err(await call("take", { template: { type: "Fact" } }), "MergeTypeNotExclusive");
	err(await call("wait", { template: { type: "Sensor" }, timeoutMs: 1000 }), "MergeTypeNotExclusive");
	err(await call("write", { entry: { type: "Fact", fields: {} }, txn: "t1" }), "MergeTypeNotExclusive");
	// The lease of a merge entry is its visible version: renew writes a new version, cancel deletes it; owner only.
	err(await call("lease", { action: "cancel", id: w1.id }), "TransactionError");// superseded by v: 2
	const s1 = ok(await call("read", { template: { type: "Sensor", fields: { sensorId: "s1" } } })).entry;
	const renewed = ok(await call("lease", { action: "renew", id: s1.id, ms: 60_000 }));
	assert.ok(renewed.expires > Date.now() && renewed.id !== s1.id, "a new version with the new deadline");
	const s1b = ok(await call("read", { template: { type: "Sensor", fields: { sensorId: "s1" } } })).entry;
	assert.deepEqual([s1b.id, s1b.fields.v, s1b.expires], [renewed.id, 2, renewed.expires]);
	err(await s.handle({ method: "lease", request: { generation: ok(await s.handle({ method: "generation" }, { peerId: "peer-b" })).generation, requestId: "steal" }, args: { action: "cancel", id: s1b.id } } as Call, { peerId: "peer-b" }), "PermissionDenied");
	assert.deepEqual(ok(await call("lease", { action: "cancel", id: s1b.id }, "del-1")), { state: "cancelled", replicated: true });
	assert.deepEqual(ok(await call("lease", { action: "cancel", id: s1b.id }, "del-1")), { state: "cancelled", replicated: true }, "a retried delete");
	assert.equal(ok(await call("read", { template: { type: "Sensor", fields: { sensorId: "s1" } } })).entry, null, "the key is deleted (tombstone)");
	ok(await call("write", { entry: { type: "Sensor", fields: { sensorId: "s1", v: 3 } } }));
	assert.equal(ok(await call("read", { template: { type: "Sensor", fields: { sensorId: "s1" } } })).entry.fields.v, 3, "a later put wins over the tombstone");
	// set: cancel removes exactly that tag, renew replaces it by a new one.
	const [f1, f2] = ok(await call("readAll", { template: { type: "Fact" } })).items;
	ok(await call("lease", { action: "cancel", id: f1.id }));
	const f2b = ok(await call("lease", { action: "renew", id: f2.id, ms: 60_000 }));
	assert.deepEqual(ok(await call("readAll", { template: { type: "Fact" } })).items.map((i: any) => i.id), [f2b.id]);
	err(await call("lease", { action: "extend", id: f2b.id }), "BadRequest");
	// The same request ID from another principal (and another generation) is another request, not a conflict.
	const gb = ok(await s.handle({ method: "generation" }, { peerId: "peer-b" }));
	const wb = ok(await s.handle({ method: "write", request: { generation: gb.generation, requestId: "put-1" }, args: { entry: { type: "Sensor", fields: { sensorId: "s9", v: 9 } } } } as Call, { peerId: "peer-b" }));
	assert.notEqual(wb.id, w1.id);
	const g2 = ok(await s.handle({ method: "generation" }, { peerId: "peer-a" }));
	assert.notEqual(ok(await s.handle({ method: "write", request: { generation: g2.generation, requestId: "put-1" }, args: { entry: { type: "Sensor", fields: { sensorId: "s8", v: 8 } } } } as Call, { peerId: "peer-a" })).id, w1.id);
	// Other types stay core entries.
	ok(await call("write", { entry: { type: "Job", fields: { n: 1 } } }));
	assert.equal(ok(await call("count", { template: { type: "Job" } })).value, 1);
	assert.equal(ok(await call("take", { template: { type: "Job" } })).entry.fields.n, 1);
	await h.close(ctx);
});
