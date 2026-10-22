// phi-spaces' own SQLite store (docs/umstellung-ohne-pi-durable.md, U2): what survives a reopen, one owner per store,
// format checks, and commits that arrive together being written together.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx, PhiSpaces, FOREVER, Space, core, claims } from "../src/index.ts";
import { openSqliteHost, StoreUnavailable } from "../src/store/sqlite.ts";

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "phi-own-store-")); dirs.push(d); return join(d, "space.sqlite"); };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

test("a reopened store gives back the space as it was: entries in their order, claims, generations, its log", async () => {
	const file = fresh();
	let h = await openSqliteHost(file);
	const s = new PhiSpaces(h, ctx);
	for (let i = 0; i < 20; i++) await s.write({ type: "Job", fields: { i } }, null, FOREVER);
	// take some from the middle and write more: the order of what is left has to survive
	for (const i of [3, 7, 11]) assert.ok(await s.take({ type: "Job", fields: { i } }, 0));
	for (let i = 20; i < 25; i++) await s.write({ type: "Job", fields: { i } }, null, FOREVER);
	await h.commit(async (tx) => { const st = await tx.doc(Space) as core.SpaceState; const g = claims.issueGeneration(st, Date.now(), { peerId: "p" }); const a = claims.admit(st, Date.now(), { generation: g.generation, requestId: "r1", principal: { peerId: "p" } }, "write", {}, Date.now() + 60_000); claims.decide(st, Date.now(), a.key, { state: "done", result: { ok: 1 } }); }, ctx);
	const before = plain(await h.snapshot(Space, ctx));
	await h.close(ctx);
	h = await openSqliteHost(file);
	const after = plain(await h.snapshot(Space, ctx));
	assert.deepEqual(after, before);
	assert.deepEqual((after.entries as Array<{ fields: { i: number } }>).map((e) => e.fields.i), [0, 1, 2, 4, 5, 6, 8, 9, 10, ...Array.from({ length: 8 }, (_, k) => 12 + k), 20, 21, 22, 23, 24]);
	assert.equal(Object.keys(after.rpc.claims).length, 1);
	// and it goes on from there
	await new PhiSpaces(h, ctx).write({ type: "Job", fields: { i: 25 } }, null, FOREVER);
	assert.equal((await h.snapshot(Space, ctx))!.entries.length, 23);
	await h.close(ctx);
});

test("a store has one owner: a second opener is refused while the first holds it", async () => {
	const file = fresh();
	const h = await openSqliteHost(file);
	await assert.rejects(openSqliteHost(file), StoreUnavailable);
	await h.close(ctx);
	const again = await openSqliteHost(file); // free once the owner closed it
	await again.close(ctx);
});

test("a store of a newer format is refused, not opened as an empty one", async () => {
	const file = fresh();
	await (await openSqliteHost(file)).close(ctx);
	const db = new DatabaseSync(file);
	db.prepare("UPDATE store_meta SET value = '99' WHERE key = 'format_version'").run();
	db.close();
	await assert.rejects(openSqliteHost(file), /format 99/);
});

test("commits that arrive while one is written go to the disk together, and each is acknowledged once it is there", async () => {
	const file = fresh();
	const h = await openSqliteHost(file);
	const s = new PhiSpaces(h, ctx);
	await Promise.all(Array.from({ length: 60 }, (_, i) => s.write({ type: "Job", fields: { i } }, null, FOREVER)));
	assert.equal((await h.snapshot(Space, ctx))!.entries.length, 60);
	await h.close(ctx);
	const db = new DatabaseSync(file, { readOnly: true });
	const seq = Number((db.prepare("SELECT value FROM store_meta WHERE key = 'commit_seq'").get() as { value: string }).value);
	const rows = (db.prepare("SELECT count(*) AS n FROM parts WHERE part = 'entries'").get() as { n: number }).n;
	db.close();
	assert.equal(rows, 60);
	assert.ok(seq < 60, `${seq} transactions for 60 commits`); // batched: fewer disk transactions than commits
});
