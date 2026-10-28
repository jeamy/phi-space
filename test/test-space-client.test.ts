// The client helpers of src/space-client.ts: the address notation, a missing entry told from a held one (locally and
// over RemoteSpace), takeAll, awaitWork with a halt, keepAlive.
import test from "node:test";
import assert from "node:assert/strict";
import {
	PhiSpaces, SpaceService, StaticIdentity, RemoteSpace, inProcessTransport, FOREVER, NO_WAIT,
	parseTarget, readExisting, takeExisting, StillHeld, takeAll, awaitWork, peek, keepAlive, type SpaceLike,
} from "../src/index.ts";
import { parseListen } from "../src/standalone.ts";
import { ctx } from "./support/persistent.ts";
import { openTestHost } from "./support/host.ts";

const ids = new StaticIdentity({ "peer-a": { principal: { peerId: "peer-a", agentId: "w1" }, roles: ["member"] } });
const local = async () => new PhiSpaces(await openTestHost(ctx), ctx);
const remote = async () => new RemoteSpace(inProcessTransport(new SpaceService({ host: await openTestHost(ctx), ctx, identity: ids }), { peerId: "peer-a" }), { sleep: () => Promise.resolve(), backoffMs: 1 });

test("parseTarget reads unix, tcp and bare paths, and refuses a broken tcp address; parseListen is the same", () => {
	assert.deepEqual(parseTarget("unix:/tmp/a.sock"), { path: "/tmp/a.sock" });
	assert.deepEqual(parseTarget("/tmp/b.sock"), { path: "/tmp/b.sock" });
	assert.deepEqual(parseTarget("tcp:127.0.0.1:3600"), { host: "127.0.0.1", port: 3600 });
	assert.throws(() => parseTarget("tcp:host"), /tcp:host:port/);
	assert.throws(() => parseTarget("unix:"), /unix:\/path/);
	assert.equal(parseListen, parseTarget);
});

for (const [name, make] of [["PhiSpaces", local], ["RemoteSpace", remote]] as const) {
	test(`${name}: readExisting/takeExisting tell gone from held; takeAll and peek`, async () => {
		const s: SpaceLike = await make();
		assert.equal(await readExisting(s, { type: "Job" }, 50), null, "nothing there: null at once");
		await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		const txn = (await s.createTransaction(FOREVER)).id;
		assert.ok(await s.take({ type: "Job" }, NO_WAIT, { txn }), "another transaction holds it");
		await assert.rejects(readExisting(s, { type: "Job" }, 50), StillHeld);
		await assert.rejects(takeExisting(s, { type: "Job" }, 50), StillHeld);
		await s.abort(txn);
		assert.equal((await readExisting(s, { type: "Job" }, 50))?.fields.n, 1, "a read leaves it there");
		assert.equal((await takeExisting(s, { type: "Job" }, 50))?.fields.n, 1);
		assert.equal(await peek(s, { type: "Job" }), null);

		for (let n = 0; n < 4; n++) await s.write({ type: "Old", fields: { n } }, null, FOREVER);
		const hold = (await s.createTransaction(FOREVER)).id;
		await s.take({ type: "Old", fields: { n: 0 } }, NO_WAIT, { txn: hold });
		assert.equal(await takeAll(s, { type: "Old" }), 3, "the held one is left alone");
		await s.abort(hold);
		assert.equal((await peek(s, { type: "Old" }))?.fields.n, 0);
		assert.equal(await takeAll(s, { type: "Old" }), 1);
		assert.equal(await takeAll(s, { type: "Old" }), 0);
	});
}

test("without probe a null after the wait counts as gone", async () => {
	const s = await local();
	const bare: SpaceLike = new Proxy(s, { get: (t, p, r) => (p === "probe" ? undefined : Reflect.get(t, p, r)) });
	assert.equal(await readExisting(bare, { type: "None" }, 10), null);
	await s.write({ type: "One", fields: {} }, null, FOREVER);
	assert.ok(await takeExisting(bare, { type: "One" }, 10));
});

test("awaitWork answers true for work, false after the wait, false at once after a halt", async () => {
	const s = await local();
	assert.equal(await awaitWork(s, { type: "Work" }, 20), false);
	const halt = new AbortController();
	const waiting = awaitWork(s, { type: "Work" }, 60_000, halt.signal);
	halt.abort();
	assert.equal(await waiting, false);
	await s.write({ type: "Work", fields: {} }, null, FOREVER);
	assert.equal(await awaitWork(s, { type: "Work" }, 1000), true);
	assert.ok(await s.read({ type: "Work" }, NO_WAIT), "awaitWork took nothing");
});

test("keepAlive renews a lease every third of its time until stopped", (t) => {
	t.mock.timers.enable({ apis: ["setInterval"] });
	const renewed: Array<[string, number]> = [];
	const fake = { renew: async (id: string, ms: number) => { renewed.push([id, ms]); return ms; } } as unknown as SpaceLike;
	const stop = keepAlive(fake, "txn-1", 3000); // every 1000 ms
	t.mock.timers.tick(999);
	assert.deepEqual(renewed, []);
	t.mock.timers.tick(1);
	t.mock.timers.tick(1000);
	assert.deepEqual(renewed, [["txn-1", 3000], ["txn-1", 3000]]);
	stop();
	t.mock.timers.tick(5000);
	assert.equal(renewed.length, 2);
});
