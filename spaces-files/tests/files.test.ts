// The file operations (docs/zanzibar-agent-filesystem-plan.en.md, sections 5 and 6.3; phase 3 exit evidence): the same
// contracts on memory and on disk, the creation branch and its collision errors, versions and conflicts, receipts and
// replays, budgets, races, and a save interrupted at every point: in the process (a failure, an unknown commit
// outcome) and by SIGKILL in a child process, reopened and checked row by row and blob by blob.
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhiSpaces } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import { FilesService, tenantAlias, type FaultPoint, type FilesServiceOptions } from "../server/service.ts";
import { relation, T } from "../server/schema.ts";

type Code = string;
const code = (c: Code) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const bytes = (s: string) => Buffer.from(s);
const raw = (s: FilesService, t = "acme") => new PhiSpaces(s.host, ctx, Date.now, undefined, undefined, { space: tenantAlias(t) });

/** acme with lea (admin, home "lea") and the agent planner (home "planner"), both logged in. */
async function fixture(o: Partial<FilesServiceOptions> = {}, disk?: string) {
	const dirs = disk ? { dataDir: join(disk, "data"), stateDir: join(disk, "state"), blobDir: join(disk, "blobs") } : { dataDir: null, stateDir: null, blobDir: null };
	const s = await FilesService.open({ ...dirs, ...o });
	const t = await s.createTenant("acme", { actorId: "lea", homeName: "lea", issuer: "i", subject: "lea" });
	assert.ok(t.status === "created");
	const p = await s.registerActor("acme", { actorKind: "user", actorId: "lea" }, "agent", "planner", "planner", { enrolledHostPeerId: "host-1", agentId: "planner" });
	const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
	const planner = (await s.login("acme", "agent", { enrolledHostPeerId: "host-1", agentId: "planner" })).handle;
	const id = async (h: string) => (await s.issueOperationIds(h, 1))[0];
	return { s, lea, planner, id, leaHome: t.homeNodeId, plannerHome: p.homeNodeId };
}

const blobFiles = (dir: string, tenant = "acme"): string[] =>
	existsSync(join(dir, tenant)) ? readdirSync(join(dir, tenant)).flatMap((sh) => readdirSync(join(dir, tenant, sh))) : [];

for (const medium of ["memory", "disk"] as const) {
	test(`file operations (${medium}): the contracts of section 5`, async () => {
		const root = mkdtempSync(join(tmpdir(), "spaces-files-ops-"));
		const f = await fixture({}, medium === "disk" ? root : undefined);
		const { s, lea, planner, id } = f;
		try {
			assert.deepEqual(await s.workspaces(lea), ["lea"]);
			assert.deepEqual(await s.workspaces(planner), ["planner"]);
			assert.deepEqual(await s.list(lea, "lea", "."), []);

			// creation branch
			assert.deepEqual(await s.mkdir(lea, "lea", "notes", await id(lea)), { status: "created" });
			await assert.rejects(s.mkdir(lea, "lea", "notes", await id(lea)), code("alreadyExists"));
			await assert.rejects(s.mkdir(lea, "lea", "a/b", await id(lea)), code("notFound"), "no implicit parent");
			assert.deepEqual(await s.write(lea, "lea", "notes/brief.md", bytes("v1"), 0, await id(lea)), { version: 1 });
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("x"), 0, await id(lea)), (e: Error & { code?: string; currentVersion?: number }) => e.code === "versionConflict" && e.currentVersion === 1);
			await assert.rejects(s.write(lea, "lea", "notes", bytes("x"), 0, await id(lea)), code("alreadyExists"));
			await assert.rejects(s.mkdir(lea, "lea", "notes/brief.md", await id(lea)), code("alreadyExists"));
			await assert.rejects(s.mkdir(lea, "lea", "notes/brief.md/x", await id(lea)), code("invalidInput"), "a parent of the wrong kind");
			await assert.rejects(s.write(lea, "planner", "x", bytes("x"), 0, await id(lea)), code("notFound"), "an invisible workspace");
			await assert.rejects(s.write(lea, "nowhere", "x", bytes("x"), 0, await id(lea)), code("notFound"), "an absent one answers alike");

			// versions
			assert.deepEqual(await s.write(lea, "lea", "notes/brief.md", bytes("v2"), 1, await id(lea)), { version: 2 });
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("v3"), 1, await id(lea)), (e: Error & { code?: string; currentVersion?: number }) => e.code === "versionConflict" && e.currentVersion === 2);
			await assert.rejects(s.write(lea, "lea", "notes", bytes("x"), 1, await id(lea)), code("invalidInput"));
			await assert.rejects(s.write(lea, "lea", "notes/none.md", bytes("x"), 1, await id(lea)), code("notFound"));
			assert.deepEqual(await s.read(lea, "lea", "notes/brief.md"), { bytes: bytes("v2"), version: 2 });
			await assert.rejects(s.read(lea, "lea", "notes"), code("invalidInput"));
			await assert.rejects(s.list(lea, "lea", "notes/brief.md"), code("invalidInput"));
			await assert.rejects(s.read(lea, "planner", "x"), code("notFound"));
			assert.deepEqual(await s.list(lea, "lea", "notes"), [{ name: "brief.md", kind: "file" }]);

			// binary contents, empty files, NFC names in a deterministic order
			const bin = Buffer.from([0, 255, 0xd8, 0x00, 0x1b, 0x0a]);
			await s.write(lea, "lea", "Café.bin", bin, 0, await id(lea));
			await s.write(lea, "lea", "empty", new Uint8Array(0), 0, await id(lea));
			assert.deepEqual((await s.read(lea, "lea", "Café.bin")).bytes, bin);
			assert.deepEqual((await s.read(lea, "lea", "empty")).bytes, Buffer.alloc(0));
			assert.deepEqual((await s.list(lea, "lea", ".")).map((e) => e.name), ["Café.bin", "empty", "notes"]);

			// receipts: a retry replays, another argument list is requestMismatch, a failure consumes nothing
			const op = await id(lea);
			assert.deepEqual(await s.write(lea, "lea", "notes/brief.md", bytes("v3"), 2, op), { version: 3 });
			assert.deepEqual(await s.write(lea, "lea", "notes/brief.md", bytes("v3"), 2, op), { version: 3 }, "the receipt answers before the version check");
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("other"), 2, op), code("requestMismatch"));
			await assert.rejects(s.mkdir(lea, "lea", "notes/brief.md", op), code("requestMismatch"), "the operation name is part of the digest");
			const create = await id(lea);
			assert.deepEqual(await s.write(lea, "lea", "new.md", bytes("n"), 0, create), { version: 1 });
			assert.deepEqual(await s.write(lea, "lea", "new.md", bytes("n"), 0, create), { version: 1 }, "a lost creation reply replays once");
			assert.equal((await s.list(lea, "lea", ".")).filter((e) => e.name === "new.md").length, 1);
			const failed = await id(lea);
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("v4"), 2, failed), code("versionConflict"));
			assert.deepEqual(await s.write(lea, "lea", "notes/brief.md", bytes("v4"), 3, failed), { version: 4 }, "the failed attempt left the ID unused");
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("v5"), 4, "o1.forged.x"), code("operationIdRejected"));
			await assert.rejects(s.write(lea, "lea", "notes/brief.md", bytes("v5"), 4, await id(planner)), code("operationIdRejected"), "another actor's ID");

			// a viewer may read and list, not write or create
			await raw(s).write(relation("node", f.leaHome, "viewer", "agent", "planner"), null, FOREVER);
			assert.deepEqual(await s.workspaces(planner), ["lea", "planner"]);
			assert.equal((await s.read(planner, "lea", "notes/brief.md")).version, 4);
			await assert.rejects(s.write(planner, "lea", "notes/brief.md", bytes("p"), 4, await id(planner)), code("permissionDenied"));
			await assert.rejects(s.write(planner, "lea", "p.md", bytes("p"), 0, await id(planner)), code("permissionDenied"));
			await assert.rejects(s.mkdir(planner, "lea", "p", await id(planner)), code("permissionDenied"));

			// every mutation wrote one audit row, in sequence, with no names or contents
			const audit = (await raw(s).readAll({ type: T.audit })).map((e) => e.fields).sort((a, b) => (a.seq as number) - (b.seq as number));
			assert.deepEqual(audit.map((a) => a.seq), audit.map((_, i) => i + 1));
			assert.equal(audit.filter((a) => a.operation === "write").length, 7);
			assert.ok(!JSON.stringify(audit).includes("brief"), "the audit holds IDs, not names");
			if (medium === "disk") {
				const live = new Set((await raw(s).readAll({ type: T.content })).map((e) => e.fields.blobId));
				assert.deepEqual(new Set(blobFiles(join(root, "blobs"))), live, "every replaced blob is gone, every live one there");
			}
		} finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
	});
}

test("budgets: maxFileBytes at its edge, the content quota, directory size", async () => {
	const { s, lea, id } = await fixture({ limits: { maxFileBytes: 8, maxContentBytes: 12, maxDirEntries: 3 } });
	try {
		await s.write(lea, "lea", "a", Buffer.alloc(8), 0, await id(lea));
		await assert.rejects(s.write(lea, "lea", "b", Buffer.alloc(9), 0, await id(lea)), code("capacityExceeded"));
		await s.write(lea, "lea", "b", Buffer.alloc(4), 0, await id(lea));
		await assert.rejects(s.write(lea, "lea", "c", Buffer.alloc(1), 0, await id(lea)), code("capacityExceeded"), "the tenant's content quota");
		assert.deepEqual(await s.write(lea, "lea", "a", Buffer.alloc(2), 1, await id(lea)), { version: 2 }, "a shorter save frees bytes");
		await s.write(lea, "lea", "c", Buffer.alloc(6), 0, await id(lea));
		await assert.rejects(s.mkdir(lea, "lea", "d", await id(lea)), code("capacityExceeded"), "directory size");
		assert.equal(s.admission.open, true, "quota failures leave admission open");
	} finally { await s.close(); }
});

test("races: two creates of one name and two edits of one version", async () => {
	const { s, lea, planner, id, plannerHome } = await fixture();
	try {
		await raw(s).write(relation("node", plannerHome, "editor", "user", "lea"), null, FOREVER);
		const [a, b] = await Promise.allSettled([
			s.write(lea, "planner", "x.md", bytes("lea"), 0, await id(lea)),
			s.write(planner, "planner", "x.md", bytes("planner"), 0, await id(planner)),
		]);
		assert.deepEqual([a.status, b.status].sort(), ["fulfilled", "rejected"]);
		const lost = (a.status === "rejected" ? a.reason : (b as PromiseRejectedResult).reason) as { code: string; currentVersion: number };
		assert.equal(lost.code, "versionConflict");
		assert.equal(lost.currentVersion, 1);
		const [c, d] = await Promise.allSettled([
			s.write(lea, "planner", "x.md", bytes("lea 2"), 1, await id(lea)),
			s.write(planner, "planner", "x.md", bytes("planner 2"), 1, await id(planner)),
		]);
		assert.deepEqual([c.status, d.status].sort(), ["fulfilled", "rejected"]);
		assert.equal((await s.read(planner, "planner", "x.md")).version, 2);
	} finally { await s.close(); }
});

test("a save failing before its commit writes nothing and leaves no blob", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-ops-"));
	let fail: FaultPoint | null = null;
	const f = await fixture({ faultHook: (p) => { if (p === fail) throw new Error(`injected at ${p}`); } }, root);
	try {
		await f.s.write(f.lea, "lea", "f", bytes("one"), 0, await f.id(f.lea));
		for (const p of ["beforeBlob", "afterBlob"] as const) {
			fail = p;
			const op = await f.id(f.lea);
			await assert.rejects(f.s.write(f.lea, "lea", "f", bytes("two"), 1, op), /injected/);
			await assert.rejects(f.s.write(f.lea, "lea", "g", bytes("new"), 0, await f.id(f.lea)), /injected/);
			fail = null;
			assert.equal(blobFiles(join(root, "blobs")).length, 1, `${p}: no new blob`);
			assert.deepEqual(await f.s.read(f.lea, "lea", "f"), { bytes: bytes("one"), version: 1 });
			assert.deepEqual((await f.s.list(f.lea, "lea", ".")).map((e) => e.name), ["f"]);
			assert.equal(await raw(f.s).count({ type: T.receipt }), 1, `${p}: no receipt`);
		}
	} finally { await f.s.close(); rmSync(root, { recursive: true, force: true }); }
});

test("an unknown commit outcome closes admission for every tenant until it is resolved", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-ops-"));
	let fail: FaultPoint | null = null;
	const f = await fixture({ faultHook: (p) => { if (p === fail) { fail = null; throw new Error(`lost at ${p}`); } } }, root);
	try {
		await f.s.createTenant("globex", { actorId: "max", homeName: "max", issuer: "i", subject: "max" });
		await f.s.write(f.lea, "lea", "f", bytes("v1"), 0, await f.id(f.lea));
		for (const [p, committed] of [["commit:before", false], ["commit:after", true]] as const) {
			const before = (await f.s.read(f.lea, "lea", "f")).version;
			const op = await f.id(f.lea);
			fail = p;
			await assert.rejects(f.s.write(f.lea, "lea", "f", bytes(`after ${p}`), before, op), code("unavailable"));
			assert.equal(f.s.admission.open, false);
			await assert.rejects(f.s.inTenant("globex", async () => "ran"), code("unavailable"), "store-wide");
			await assert.rejects(f.s.read(f.lea, "lea", "f"), code("unavailable"));
			assert.equal(await f.s.resolveOutcomes(), 1);
			assert.equal(f.s.admission.open, true);
			const now = await f.s.read(f.lea, "lea", "f");
			assert.equal(now.version, committed ? before + 1 : before, p);
			assert.equal(blobFiles(join(root, "blobs")).length, 1, `${p}: exactly the live blob remains`);
			// the retry produces exactly one increment either way
			assert.deepEqual(await f.s.write(f.lea, "lea", "f", bytes(`after ${p}`), before, op), { version: before + 1 });
			assert.equal((await f.s.read(f.lea, "lea", "f")).version, before + 1);

			// a mutation without a blob: its transaction is aborted too, so the retry does not meet its own reserved keys
			const mk = await f.id(f.lea);
			fail = p;
			await assert.rejects(f.s.mkdir(f.lea, "lea", `dir-${p}`, mk), code("unavailable"));
			assert.equal(await f.s.resolveOutcomes(), 1);
			assert.deepEqual(await f.s.mkdir(f.lea, "lea", `dir-${p}`, mk), { status: "created" });
			assert.equal((await f.s.list(f.lea, "lea", ".")).filter((e) => e.name === `dir-${p}`).length, 1);
			assert.equal(f.s.admission.suspended("acme"), undefined);
			assert.equal(await raw(f.s).count({ type: T.receipt, fields: { operationId: mk } }), 1);
		}
	} finally { await f.s.close(); rmSync(root, { recursive: true, force: true }); }
});

const DRIVER = join(import.meta.dirname, "support", "crash-driver.ts");
const runDriver = (dirs: string[], point: FaultPoint) => new Promise<{ line: { handle: string; opId: string }; signal: string | null }>((resolve, reject) => {
	const child = spawn(process.execPath, ["--no-warnings", "--experimental-strip-types", DRIVER, ...dirs, point], { env: { ...process.env, NODE_TEST_CONTEXT: "" }, stdio: ["ignore", "pipe", "inherit"] });
	let out = "";
	child.stdout.on("data", (d) => { out += d; });
	child.on("error", reject);
	child.on("exit", (_code, signal) => {
		const first = out.split("\n")[0];
		try { resolve({ line: JSON.parse(first), signal }); } catch { reject(new Error(`driver printed ${JSON.stringify(out)}`)); }
	});
});

for (const [point, committed] of [["beforeBlob", false], ["afterBlob", false], ["commit:before", false], ["commit:after", true], ["afterCommit", true]] as const) {
	test(`a crash at ${point}: the reopened store has every committed row with its blob, the orphan is swept, the retry increments once`, async () => {
		const root = mkdtempSync(join(tmpdir(), "spaces-files-crash-"));
		const dirs = [join(root, "data"), join(root, "state"), join(root, "blobs")];
		try {
			const { line, signal } = await runDriver(dirs, point);
			assert.equal(signal, "SIGKILL");
			const s = await FilesService.open({ dataDir: dirs[0], stateDir: dirs[1], blobDir: dirs[2], saveTxnLeaseMs: 300 });
			try {
				// a transaction of the dead process may still hold the content row: the tenant waits for it to lapse
				let r: { bytes: Buffer; version: number } | undefined;
				for (let i = 0; i < 100 && !r; i++) {
					try { r = await s.read(line.handle, "lea", "f.txt"); }
					catch (e) { if ((e as { code?: string }).code !== "unavailable") throw e; await new Promise((res) => setTimeout(res, 50)); }
				}
				assert.deepEqual(r, committed ? { bytes: bytes("two"), version: 2 } : { bytes: bytes("one"), version: 1 });
				const orphans = point === "beforeBlob" ? 0 : 1;
				assert.equal(blobFiles(dirs[2]).length, 1 + orphans);
				assert.equal(await s.sweepBlobs("acme"), orphans);
				const rows = await raw(s).readAll({ type: T.content });
				assert.deepEqual(blobFiles(dirs[2]), rows.map((e) => e.fields.blobId), "no committed row lacks its blob, no blob lacks a row");
				assert.equal(await raw(s).count({ type: T.receipt }), committed ? 2 : 1);
				assert.equal(await raw(s).count({ type: T.audit }), committed ? 3 : 2);
				// the retry with the same ID: a receipt answers a committed save, otherwise it saves now
				assert.deepEqual(await s.write(line.handle, "lea", "f.txt", bytes("two"), 1, line.opId), { version: 2 });
				assert.deepEqual(await s.read(line.handle, "lea", "f.txt"), { bytes: bytes("two"), version: 2 });
				assert.equal(await s.sweepBlobs("acme"), 0);
				assert.equal(blobFiles(dirs[2]).length, 1);
			} finally { await s.close(); }
		} finally { rmSync(root, { recursive: true, force: true }); }
	});
}
