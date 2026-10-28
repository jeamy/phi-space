// The batching helpers of server/space.ts against stand-in spaces: what a server offers decides what is used, and a
// command's writes respect the service's 64 steps per batch.
import "./test-env.ts";
import test from "node:test";
import assert from "node:assert/strict";
import type { BatchOp, SpaceLike, Template } from "phi-spaces";
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

test("the mirror answers a command's snapshot reads as the space would, and fresh() waits for what was just committed", async () => {
	const { FOREVER, NO_WAIT, serveSpace, SpaceService, startService, StaticIdentity } = await import("phi-spaces");
	const { BACKGROUND_CONTEXT: ctx } = await import("phi-spaces/context");
	const { openOwnMemoryHost } = await import("phi-spaces/store/host");
	const { connectSpace, Mirror, parseTarget } = await import("../server/space.ts");
	const host = openOwnMemoryHost(), stop = await startService(host, ctx, { watchDebounceMs: 10 });
	const sock = `unix:/tmp/mmo-mirror-${process.pid}.sock`;
	const server = await serveSpace(new SpaceService({ host, ctx, identity: new StaticIdentity({ p: { principal: { peerId: "p" }, roles: ["member"] } }), wakeOnCommit: true }), { listen: parseTarget(sock), connection: () => ({ peerId: "p" }) });
	const { space, close } = connectSpace(sock);
	try {
		for (const room of ["a", "b", "a"]) await space.write({ type: "Item", fields: { room } }, null, FOREVER);
		const m = new Mirror(space, { waitMs: 200 });
		await m.ready();
		const plain = async (tmpl: Template) => (await space.readAll(tmpl)).map(({ gid: _, ...e }) => e); // the mirror keeps no gid
		assert.deepEqual(m.readAll({ type: "Item", fields: { room: "a" } }), await plain({ type: "Item", fields: { room: "a" } }));
		// written, taken in a transaction (gone from the snapshot), a lease that lapses: fresh() sees each at once
		const w = await space.write({ type: "Item", fields: { room: "c" } }, null, FOREVER);
		await m.fresh();
		assert.equal(m.count({ type: "Item", fields: { room: "c" } }), 1);
		const t = await space.createTransaction(10_000);
		await space.take({ id: w.id }, NO_WAIT, { txn: t.id });
		await m.fresh();
		assert.equal(m.count({ type: "Item", fields: { room: "c" } }), 0, "taken under a transaction: not in the snapshot");
		await space.abort(t.id);
		await m.fresh();
		assert.equal(m.count({ type: "Item", fields: { room: "c" } }), 1, "the abort puts it back");
		await space.write({ type: "Msg", fields: { n: 1 } }, null, 300);
		await m.fresh();
		assert.equal(m.count({ type: "Msg" }), 1);
		await new Promise((r) => setTimeout(r, 400));
		assert.equal(m.count({ type: "Msg" }), 0, "its lease lapsed");
		assert.deepEqual(m.readAll({ type: "Item" }), await plain({ type: "Item" }), "the same entries in the same order");
		m.close();
	} finally { close(); await server.close(); await stop(); }
});
