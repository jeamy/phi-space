// AP 1.1/1.2: named spaces, registry, identities and global ids (docs/implementierungsplan-v3.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import { PhiSpaces, FOREVER, Space, createSpace, listSpaces, UnknownSpaceError, startService, core, DEFAULT_ALIAS } from "../src/index.ts";
import { forEachBackend, ctx } from "./support/persistent.ts";

const memory = () => Harness.open(new MemoryStorage(), { models: createModels(), registry: createRegistry() }, ctx);
const named = (h: Harness, space: string) => new PhiSpaces(h, ctx, Date.now, undefined, undefined, { space });

test("default space is registered on first use: spaceId, incarnation, gid", async () => {
	const h = await memory();
	try {
		const s = new PhiSpaces(h, ctx);
		const lease = await s.write({ type: "Job", fields: { n: 1 } }, null, FOREVER);
		const [info] = await listSpaces(h, ctx);
		assert.equal(info!.alias, DEFAULT_ALIAS);
		assert.match(info!.spaceId, /^sp-/);
		assert.match(info!.incarnation, /^[0-9a-f]{8}$/);
		assert.equal(lease.id, `e${info!.incarnation}-1`, "local ids carry the incarnation");
		const e = await s.read({ type: "Job" }, 0);
		assert.equal(e?.gid, `${info!.spaceId}/${lease.id}`);
		assert.equal((await s.readAll({ type: "Job" }))[0]!.gid, e?.gid);
		assert.deepEqual(await named(h, DEFAULT_ALIAS).count({ type: "Job" }), 1, "the alias names the same space");
	} finally { await h.close(ctx); }
});

test("named spaces: generated ids, idempotent per alias, isolated, no id collisions", async () => {
	const h = await memory();
	try {
		const a = await h.commit((tx) => createSpace(tx, "sieve-a", Date.now()), ctx);
		const again = await h.commit((tx) => createSpace(tx, "sieve-a", Date.now()), ctx);
		const b = await h.commit((tx) => createSpace(tx, "sieve-b", Date.now()), ctx);
		assert.equal(again.spaceId, a.spaceId);
		assert.notEqual(a.spaceId, b.spaceId);
		assert.notEqual(a.incarnation, b.incarnation);
		const la = await named(h, "sieve-a").write({ type: "Task", fields: { n: 1 } }, null, FOREVER);
		const lb = await named(h, b.spaceId).write({ type: "Task", fields: { n: 1 } }, null, FOREVER);
		assert.notEqual(la.id, lb.id, "local ids differ between spaces");
		assert.equal(await named(h, "sieve-a").count({ type: "Task" }), 1);
		assert.equal(await named(h, "sieve-b").count({ type: "Task" }), 1);
		assert.equal(await new PhiSpaces(h, ctx).count({ type: "Task" }), 0, "the default space is separate");
		const t = await named(h, "sieve-b").take({ type: "Task" }, 0);
		assert.equal(t?.gid, `${b.spaceId}/${lb.id}`);
		assert.equal(await named(h, "sieve-a").count({ type: "Task" }), 1);
		assert.deepEqual((await listSpaces(h, ctx)).map((i) => i.alias), [DEFAULT_ALIAS, "sieve-a", "sieve-b"]);
	} finally { await h.close(ctx); }
});

test("unknown spaces and bad aliases are rejected", async () => {
	const h = await memory();
	try {
		await assert.rejects(named(h, "nope").write({ type: "X", fields: {} }), UnknownSpaceError);
		await assert.rejects(named(h, "nope").count(), UnknownSpaceError);
		await assert.rejects(h.commit((tx) => createSpace(tx, "Bad Alias", Date.now()), ctx), core.IllegalArgumentError);
	} finally { await h.close(ctx); }
});

test("a space written before registration keeps its entries and old ids", async () => {
	const h = await memory();
	try {
		await h.commit(async (tx) => { core.write(await tx.doc(Space), Date.now(), { type: "Old", fields: {} }, null, FOREVER); }, ctx);
		const s = new PhiSpaces(h, ctx);
		const l = await s.write({ type: "New", fields: {} }, null, FOREVER);
		const [info] = await listSpaces(h, ctx);
		const old = await s.read({ type: "Old" }, 0);
		assert.equal(old?.id, "e1");
		assert.equal(l.id, `e${info!.incarnation}-2`, "the counter continues; the incarnation keeps the forms apart");
		assert.equal(await s.count(), 2);
	} finally { await h.close(ctx); }
});

test("named spaces survive close and crash on persistent storage", async () => {
	await forEachBackend(async (home) => {
		let h = await home.open();
		const info = await h.commit((tx) => createSpace(tx, "data", Date.now()), ctx);
		await named(h, "data").write({ type: "T", fields: { n: 1 } }, null, FOREVER);
		home.crash(h);
		h = await home.open();
		await named(h, "data").write({ type: "T", fields: { n: 2 } }, null, FOREVER);
		await home.close(h);
		h = await home.open();
		const [again] = (await listSpaces(h, ctx)).filter((i) => i.alias === "data");
		assert.deepEqual(again, info);
		assert.equal(await named(h, "data").count({ type: "T" }), 2);
		const ids = (await named(h, "data").readAll({ type: "T" })).map((e) => e.id);
		assert.equal(new Set(ids).size, 2);
	});
});

test("startService also maintains named spaces created after it started", async () => {
	const h = await memory();
	const stop = await startService(h, ctx, { onError: () => {} });
	try {
		await h.commit((tx) => createSpace(tx, "later", Date.now()), ctx);
		await named(h, "later").write({ type: "Short", fields: {} }, null, 50);
		await new Promise((r) => setTimeout(r, 400));
		const st = await named(h, "later").stats();
		assert.equal(st.entries, 0);
		assert.equal(st.expired, 0, "the reaper removed the lapsed entry without any further operation");
	} finally { await stop(); await h.close(ctx); }
});
