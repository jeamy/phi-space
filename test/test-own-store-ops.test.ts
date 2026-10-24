// Operating the own SQLite store (docs/umstellung-ohne-pi-durable.md, U7): a full disk, and a backup taken while the
// store writes. Each commit writes a pair of entries, so a torn commit shows as an odd number of them.
import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { BACKGROUND_CONTEXT as ctx, FOREVER, PhiSpaces } from "../src/index.ts";
import { openSqliteHost } from "../src/store/sqlite.ts";

const dirs: string[] = [];
const fresh = () => { const d = mkdtempSync(join(tmpdir(), "phi-own-ops-")); dirs.push(d); return join(d, "space.sqlite"); };
test.after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const pair = (s: PhiSpaces, i: number) => s.write({ type: "Pair", fields: { i, pad: "x".repeat(300) } }, null, FOREVER);
const counts = async (file: string) => {
	const h = await openSqliteHost(file), s = new PhiSpaces(h, ctx);
	const n = await s.count({ type: "Pair" }), all = (await s.readAll({ type: "Pair" })).map((e) => e.fields.i as number);
	await h.close(ctx);
	return { n, all };
};
const integrity = (file: string) => { const db = new DatabaseSync(file, { readOnly: true }); try { return (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check; } finally { db.close(); } };

test("a full disk fails the commit that did not fit, keeps every acknowledged one, and the store reopens and goes on", async () => {
	const file = fresh();
	let h = await openSqliteHost(file);
	for (let i = 0; i < 20; i++) await pair(new PhiSpaces(h, ctx), i);
	await h.close(ctx);
	const pages = (statSync(file).size / 4096) | 0;
	h = await openSqliteHost(file, { maxPages: pages + 40 }); // room for a few more commits only
	const s = new PhiSpaces(h, ctx);
	let acknowledged = 20, failure: Error | null = null;
	for (let i = 20; i < 2000 && !failure; i++) { try { await pair(s, i); acknowledged++; } catch (e) { failure = e as Error; } }
	assert.ok(failure, "the disk filled up");
	assert.match(failure!.message, /full|SQLITE_FULL/i);
	assert.ok(h.failed, "the host takes no more work after a failed write");
	await assert.rejects(pair(s, 9999), /failed|reopen/);
	await h.close(ctx).catch(() => {});
	assert.equal(integrity(file), "ok");
	// every acknowledged commit is there, nothing else, in order
	const { n, all } = await counts(file);
	assert.equal(n, acknowledged);
	assert.deepEqual(all, Array.from({ length: acknowledged }, (_, i) => i));
	// with room again the store goes on from there
	h = await openSqliteHost(file);
	await pair(new PhiSpaces(h, ctx), acknowledged);
	await h.close(ctx);
	assert.equal((await counts(file)).n, acknowledged + 1);
});

test("a backup with VACUUM INTO taken while the store writes is a consistent state that opens, and restores", async () => {
	const file = fresh(), backup = `${file}.backup`, restored = fresh();
	const h = await openSqliteHost(file);
	const s = new PhiSpaces(h, ctx);
	for (let i = 0; i < 30; i++) await pair(s, i);
	let stop = false, written = 30;
	const writer = (async () => { for (let i = 30; !stop; i++) { await pair(s, i); written = i + 1; } })();
	await new Promise((r) => setTimeout(r, 50));
	const db = new DatabaseSync(file, { readOnly: true, timeout: 10_000 });
	try { db.exec(`VACUUM INTO '${backup}'`); } finally { db.close(); }
	await new Promise((r) => setTimeout(r, 50));
	stop = true;
	await writer;
	await h.close(ctx);
	assert.equal(integrity(backup), "ok");
	const { n, all } = await counts(backup);
	assert.ok(n >= 30 && n <= written, `backup holds ${n} of ${written}`);
	assert.deepEqual(all, Array.from({ length: n }, (_, i) => i), "a prefix of the commits, none torn");
	// the restore: the backup is the store of a new place, which goes on writing; the original is untouched
	copyFileSync(backup, restored);
	const r = await openSqliteHost(restored);
	await pair(new PhiSpaces(r, ctx), n);
	await r.close(ctx);
	assert.equal((await counts(restored)).n, n + 1);
	assert.equal((await counts(file)).n, written);
});
