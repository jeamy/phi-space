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

// ---- crashes (plan 9: "Echte Prozessabbrüche", "Commit/Antwort-Lücke"): a child commits until it is killed hard ----

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CHILD = fileURLToPath(new URL("./support/store-crash-child.ts", import.meta.url));

/** Runs the child on `file` until `when()` says kill (SIGKILL), and returns the commits it acknowledged. */
async function crashRun(file: string, when: (acks: number) => Promise<void>, env: Record<string, string> = {}, from = 0): Promise<Set<number>> {
	const child = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", CHILD, file, String(from)], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
	const acks = new Set<number>();
	let out = "", err = "", opened!: () => void;
	const open = new Promise<void>((r) => { opened = r; });
	child.stdout.on("data", (d: Buffer) => {
		out += d.toString();
		const lines = out.split("\n"); out = lines.pop()!;
		for (const l of lines) { if (l === "OPEN") opened(); else if (l.startsWith("ACK ")) acks.add(Number(l.slice(4))); }
	});
	child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
	const exited = new Promise<void>((r) => child.once("exit", () => r()));
	await Promise.race([open, exited]);
	assert.ok(child.exitCode === null, `the child ended early: ${err}`);
	await when(acks.size);
	child.kill("SIGKILL");
	await exited;
	return new Set(acks); // what it printed before it died: acknowledged commits
}

/** The pairs on disk after a crash: every acknowledged commit must be there, and never only half of one. */
async function survivors(file: string): Promise<Set<number>> {
	const h = await openSqliteHost(file); // the dead owner's lock is free again
	const s = await h.snapshot(Space, ctx); // none yet when the child died before its first commit
	await h.close(ctx);
	const halves = new Map<number, number>();
	for (const e of s?.entries ?? []) if (e.type === "Pair") { const i = (e.fields as { i: number }).i; halves.set(i, (halves.get(i) ?? 0) + 1); }
	for (const [i, n] of halves) assert.equal(n, 2, `commit ${i} is there only in part`);
	return new Set(halves.keys());
}

test("killed at any moment, a store keeps every acknowledged commit and no half of one", async () => {
	const file = fresh();
	const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
	for (const [run, delay] of [0, 20, 60, 150, 300, 500].entries()) {
		const acked = await crashRun(file, () => wait(delay), {}, run * 1_000_000); // each run its own numbers, on the same file
		const there = await survivors(file);
		for (const i of acked) assert.ok(there.has(i), `acknowledged commit ${i} is lost (killed after ${delay} ms)`);
	}
});

test("killed right before the disk transaction commits: what was not acknowledged is not there", async () => {
	const file = fresh(), marker = `${file}.paused`;
	// the writer thread stops before the third batch's COMMIT; the main thread is free and prints the acknowledgements of
	// the first two batches (killed at once, some of those would be durable but not yet printed: allowed, not checked here)
	const acked = await crashRun(file, async () => { while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 5)); await new Promise((r) => setTimeout(r, 300)); }, { PHI_SPACES_WRITER_PAUSE: `before-commit:3:${marker}` });
	const there = await survivors(file);
	assert.ok(acked.size > 0);
	assert.deepEqual([...there].sort((a, b) => a - b), [...acked].sort((a, b) => a - b)); // exactly the acknowledged ones
});

test("killed after the disk transaction committed but before the answer: the commits are there, unacknowledged", async () => {
	const file = fresh(), marker = `${file}.paused`;
	const acked = await crashRun(file, async () => { while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 5)); }, { PHI_SPACES_WRITER_PAUSE: `after-commit:3:${marker}` });
	const there = await survivors(file);
	for (const i of acked) assert.ok(there.has(i));
	assert.ok(there.size > acked.size, `${there.size} commits on disk, ${acked.size} acknowledged`); // the third batch is durable without an answer
});

test("a file of another program (a pi-durable store) is refused, not taken over", async () => {
	const file = fresh();
	const db = new DatabaseSync(file);
	db.exec("CREATE TABLE documents (id INTEGER PRIMARY KEY, kind TEXT, record TEXT)");
	db.close();
	await assert.rejects(openSqliteHost(file), /is not a phi-spaces store/);
});

// ---- the rows of an array part follow every kind of change (store/parts.ts: the side-by-side path and the full one) ----

import { partChanges } from "../src/store/parts.ts";

test("an array part's rows rebuild the array after removals, replacements, appends, inserts and moves", () => {
	let seed = 7;
	const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed % n; };
	const parts = [{ path: ["log"], kind: "array" as const }];
	const rows = new Map<string, { ord: number; value: unknown }>(), ords = new Map<string, Map<string, number>>();
	let next = 0, before: { log: Array<{ id: number; v: number }> } = { log: [] };
	for (let step = 0; step < 3000; step++) {
		const log = [...before.log];
		const kind = rnd(10);
		if (kind < 3 || !log.length) for (let k = rnd(3) + 1; k > 0; k--) log.push({ id: next++, v: 0 }); // append
		else if (kind < 5) log.splice(rnd(log.length), 1); // remove one
		else if (kind < 6) log.splice(0, rnd(Math.min(4, log.length)) + 1); // cut the start
		else if (kind < 8) { const i = rnd(log.length); log[i] = { ...log[i]!, v: log[i]!.v + 1 }; } // replace in place
		else if (kind < 9) log.splice(rnd(log.length + 1), 0, { id: next++, v: 0 }); // insert anywhere
		else if (log.length > 1) { const [m] = log.splice(rnd(log.length), 1); log.splice(rnd(log.length + 1), 0, m!); } // move
		const after = { log };
		const c = partChanges(before, after, parts, new Map(), ords);
		for (const d of c.del) rows.delete(d.id);
		for (const p of c.put) rows.set(p.id, { ord: p.ord, value: p.value });
		const rebuilt = [...rows.values()].sort((x, y) => x.ord - y.ord).map((r) => r.value);
		assert.deepEqual(rebuilt, log, `step ${step} (change ${kind})`);
		before = after;
	}
});

// ---- claims on the disk (store/disk-map.ts): memory holds only what is not yet durable and the open requests ----

import { diskMapOf } from "../src/store/types.ts";

const ref = (gen: string, j: number | string) => ({ generation: gen, requestId: `r${j}`, principal: { peerId: "p" } });
const claimsOf = (s: core.SpaceState | undefined) => diskMapOf<claims.ClaimRec>(s?.rpc?.claims);

test("claims on the disk: overlapping commits see what the ones before wrote and deleted, before it is durable", async () => {
	const file = fresh();
	let h = await openSqliteHost(file, { strictDiskMaps: true });
	let gen = "";
	await h.commit(async (tx) => { const s = await tx.doc(Space) as core.SpaceState; gen = claims.issueGeneration(s, Date.now(), { peerId: "p" }).generation; }, ctx);
	assert.ok(claimsOf(await h.snapshot(Space, ctx)), "a space new in this process moves its claims to the disk with its first commit");
	const N = 300;
	await Promise.all(Array.from({ length: N }, (_, i) => h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState, now = Date.now(), key = (j: number) => claims.keyOf(s, ref(gen, j));
		if (i > 0) assert.equal(s.rpc!.claims[key(i - 1)]?.state, "done", `commit ${i} sees the claim of commit ${i - 1}`);
		if (i > 1) { assert.ok(s.rpc!.claims[key(i - 2)]); delete s.rpc!.claims[key(i - 2)]; }
		if (i > 2) assert.equal(s.rpc!.claims[key(i - 3)], undefined, `commit ${i} does not see what commit ${i - 1} deleted`);
		const a = claims.admit(s, now, ref(gen, i), "write", { i }, now + 60_000);
		claims.decide(s, now, a.key, { state: "done", result: { i } });
	}, ctx)));
	assert.ok(h.stats()!.batches < N, "the commits overlapped (fewer batches than commits)");
	const keys = (s: core.SpaceState | undefined) => claimsOf(s)!.entries().map(([, c]) => c.requestId).sort();
	assert.deepEqual(keys(await h.snapshot(Space, ctx)), [`r${N - 2}`, `r${N - 1}`]);
	await h.close(ctx);
	h = await openSqliteHost(file, { strictDiskMaps: true });
	assert.deepEqual(keys(await h.snapshot(Space, ctx)), [`r${N - 2}`, `r${N - 1}`]);
	await h.close(ctx);
});

test("claims on the disk: a failed commit leaves no claim it wrote and brings back the ones it deleted", async () => {
	const h = await openSqliteHost(fresh(), { strictDiskMaps: true });
	let gen = "", kept = "";
	await h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState, now = Date.now();
		gen = claims.issueGeneration(s, now, { peerId: "p" }).generation;
		kept = claims.admit(s, now, ref(gen, "kept"), "write", {}, now + 60_000).key;
	}, ctx);
	// the next commit runs while the first may still be written: both the write and the deletion are taken back
	await assert.rejects(h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState, now = Date.now();
		claims.admit(s, now, ref(gen, "lost"), "write", {}, now + 60_000);
		delete s.rpc!.claims[kept];
		throw new Error("refused");
	}, ctx), /refused/);
	await h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState;
		assert.equal(s.rpc!.claims[claims.keyOf(s, ref(gen, "lost"))], undefined);
		assert.equal(s.rpc!.claims[kept]?.state, "pending");
		assert.deepEqual(claims.pendingClaims(s).map(([k]) => k), [kept], "the open request is still known as open");
	}, ctx);
	await h.close(ctx);
});

test("claims on the disk: a sweep drops expired results and claims by the index, the same as in memory", async () => {
	const file = fresh();
	let h = await openSqliteHost(file, { strictDiskMaps: true });
	const t0 = Date.now(), day = 24 * 3600_000;
	let gen = "";
	await h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState;
		gen = claims.issueGeneration(s, t0, { peerId: "p" }).generation;
		for (let i = 0; i < 600; i++) { const a = claims.admit(s, t0, ref(gen, i), "write", { i }, t0 + 60_000); claims.decide(s, t0 + i, a.key, { state: "done", result: { i } }); }
		claims.admit(s, t0, ref(gen, "open"), "write", {}, t0 + 60_000);
	}, ctx);
	await h.close(ctx);
	h = await openSqliteHost(file, { strictDiskMaps: true });
	// after a day, sweeps (256 at a time) drop the 600 decided claims; the open one stays, and so does its generation
	for (let round = 0; round < 4; round++) await h.commit(async (tx) => { claims.sweep(await tx.doc(Space) as core.SpaceState, t0 + day + 1000); }, ctx);
	const s = (await h.snapshot(Space, ctx))!;
	assert.deepEqual(claimsOf(s)!.entries().map(([, c]) => c.requestId), ["ropen"]);
	assert.ok(s.rpc!.generations[gen]);
	await h.close(ctx);
});

test("a format 1 store is migrated when opened: its claims get their index and go on the disk", async () => {
	const file = fresh();
	let h = await openSqliteHost(file);
	const t0 = Date.now();
	let gen = "";
	await h.commit(async (tx) => {
		const s = await tx.doc(Space) as core.SpaceState;
		gen = claims.issueGeneration(s, t0, { peerId: "p" }).generation;
		for (let i = 0; i < 10; i++) { const a = claims.admit(s, t0, ref(gen, i), "write", { i }, t0 + 60_000); claims.decide(s, t0, a.key, { state: "done", result: { i } }); }
	}, ctx);
	await h.close(ctx);
	// make it a format 1 file: no index columns, no marks
	const db = new DatabaseSync(file);
	db.exec("DROP INDEX parts_at; DROP INDEX parts_grp; DROP INDEX parts_open; ALTER TABLE parts DROP COLUMN at; ALTER TABLE parts DROP COLUMN grp; ALTER TABLE parts DROP COLUMN flag;");
	db.exec("UPDATE store_meta SET value = '1' WHERE key = 'format_version'; DELETE FROM store_meta WHERE key LIKE 'indexed%';");
	db.close();
	h = await openSqliteHost(file, { strictDiskMaps: true });
	const s = (await h.snapshot(Space, ctx))!;
	assert.equal(s.rpc!.claims[claims.keyOf(s, ref(gen, 3))]?.result && (s.rpc!.claims[claims.keyOf(s, ref(gen, 3))]!.result as { i: number }).i, 3);
	await h.commit(async (tx) => { claims.sweep(await tx.doc(Space) as core.SpaceState, t0 + 24 * 3600_000 + 1); }, ctx);
	assert.equal(claimsOf((await h.snapshot(Space, ctx))!)!.entries().length, 0, "the index found every expired claim");
	await h.close(ctx);
	const check = new DatabaseSync(file, { readOnly: true });
	assert.equal((check.prepare("SELECT value FROM store_meta WHERE key = 'format_version'").get() as { value: string }).value, "2");
	check.close();
});

import { plainDoc } from "./support/host.ts";

// ---- a commit the store refuses before publishing it (Ledger.prepare: a replicated store's full journal) ----

test("a commit the store refuses before publishing leaves no trace: entries, claims, log and orders are as before, and the store goes on", async () => {
	const file = fresh();
	let refuse = false;
	let h = await openSqliteHost(file, { strictDiskMaps: true, gate: () => { if (refuse) throw new Error("journal full"); } });
	const s = new PhiSpaces(h, ctx);
	for (let i = 0; i < 5; i++) await s.write({ type: "Job", fields: { i } }, null, FOREVER);
	let gen = "";
	await h.commit(async (tx) => { const st = await tx.doc(Space) as core.SpaceState; gen = claims.issueGeneration(st, Date.now(), { peerId: "p" }).generation; }, ctx);
	const before = (plainDoc(await h.snapshot(Space, ctx)) as any);
	// refused while an earlier commit may still be written: a take from the middle, a new claim, an appended entry
	const earlier = s.write({ type: "Job", fields: { i: 5 } }, null, FOREVER);
	refuse = true;
	const refused = h.commit(async (tx) => {
		const st = await tx.doc(Space) as core.SpaceState, now = Date.now();
		core.probe(st, now, { type: "Job", fields: { i: 2 } }, null, true);
		claims.admit(st, now, ref(gen, "refused"), "write", {}, now + 60_000);
		core.write(st, now, { type: "Job", fields: { i: 99 } }, null, FOREVER);
	}, ctx);
	await assert.rejects(refused, /journal full/);
	refuse = false;
	await earlier;
	const after = (plainDoc(await h.snapshot(Space, ctx)) as any);
	assert.deepEqual(after.entries.map((e: { fields: { i: number } }) => e.fields.i), [0, 1, 2, 3, 4, 5], "nothing of the refused commit, the earlier one is there");
	assert.equal(after.rpc.claims[claims.keyOf(after, ref(gen, "refused"))], undefined);
	assert.equal(claimsOf(await h.snapshot(Space, ctx))!.entries().length, 0);
	assert.equal(after.stream.log.length, before.stream.log.length + 1, "one batch more: the earlier write's");
	// the store goes on, and the rows on the disk give the same state (orders kept right)
	assert.ok(await s.take({ type: "Job", fields: { i: 3 } }, 0));
	await s.write({ type: "Job", fields: { i: 6 } }, null, FOREVER);
	const live = (plainDoc(await h.snapshot(Space, ctx)) as any);
	await h.close(ctx);
	h = await openSqliteHost(file, { strictDiskMaps: true });
	assert.deepEqual((plainDoc(await h.snapshot(Space, ctx)) as any), live);
	assert.deepEqual(live.entries.map((e: { fields: { i: number } }) => e.fields.i), [0, 1, 2, 4, 5, 6]);
	await h.close(ctx);
});
