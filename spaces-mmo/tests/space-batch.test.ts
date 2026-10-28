// The batching helpers of server/space.ts against stand-in spaces: what a server offers decides what is used, and a
// command's writes respect the service's 64 steps per batch.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { BatchOp, SpaceLike } from "phi-spaces";
import { batching, bufferedTxn, supports } from "../server/space.ts";
import { msgOptions } from "../server/engine/context.ts";

const fake = (features: string[]) => {
	const batches: BatchOp[][] = [];
	const space = { info: async () => ({ features }), batch: async (ops: readonly BatchOp[]) => { batches.push([...ops]); return ops.map(() => null); }, write: async () => ({ id: "w", expires: 0 }) };
	return { space: space as unknown as SpaceLike, batches };
};

test("an older space (no batch, no write.transient in its hello) gets plain calls and kept messages", async () => {
	const old = fake([]).space;
	assert.equal(await batching(old), null);
	assert.deepEqual(await msgOptions(old, { to: "c1", kind: "info" }), {});
	const now = fake(["batch", "write.transient"]).space;
	assert.ok(await batching(now));
	assert.deepEqual(await msgOptions(now, { to: "c1", kind: "info" }), { transient: true });
	assert.deepEqual(await msgOptions(now, { to: "*", kind: "say" }), {}, "speech stays an entry: the NPC scripts listen");
	assert.deepEqual(await msgOptions(now, { to: "npc-kalle", kind: "error" }), {}, "so does anything to an NPC");
	assert.equal(await supports({} as SpaceLike, "batch"), false, "a space without a hello offers nothing new");
});

test("a command that writes a lot sends full batches of at most 64 steps, the commit in the last one", async () => {
	const f = fake(["batch"]);
	const b = bufferedTxn((await batching(f.space))!, "t1");
	for (let i = 0; i < 70; i++) await b.space.write({ type: "Item", fields: { i } }, "t1", 1000);
	await b.commit([{ op: "write", entry: { type: "ActorToken", fields: {} }, txn: "t1", lease: 1000 }]);
	assert.ok(f.batches.every((x) => x.length <= 64), JSON.stringify(f.batches.map((x) => x.length)));
	assert.equal(f.batches.flat().filter((x) => x.op === "write").length, 71);
	assert.deepEqual(f.batches.at(-1)!.at(-1), { op: "commit", txn: "t1" });
	assert.equal(f.batches.flat().filter((x) => x.op === "commit").length, 1);
});
