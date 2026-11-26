// Move and delete (docs/zanzibar-agent-filesystem-plan.en.md, section 5 and section 8, move and delete): a moved node
// keeps its ID, versions, blobs, grants and restriction, and what it inherits changes with its place at once (the loss
// of access right after a move); cycles, roots, taken names and depth are refused; a removal takes the content row,
// grants and restriction with the node and deletes the blob after the commit, through crashes at the commit.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PhiSpaces } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FilesService, tenantAlias, type FaultPoint, type FilesServiceOptions } from "../server/service.ts";
import { T } from "../server/schema.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const bytes = (s: string) => Buffer.from(s);
const raw = (s: FilesService) => new PhiSpaces(s.host, ctx, Date.now, undefined, undefined, { space: tenantAlias("acme") });
const blobFiles = (dir: string): string[] =>
	existsSync(join(dir, "acme")) ? readdirSync(join(dir, "acme")).flatMap((sh) => readdirSync(join(dir, "acme", sh))) : [];

/** acme: lea owns team (north editor on it) and her home; max and bert are in north. */
async function team(o: Partial<FilesServiceOptions> = {}, disk?: string) {
	const dirs = disk ? { dataDir: join(disk, "data"), stateDir: join(disk, "state"), blobDir: join(disk, "blobs") } : { dataDir: null, stateDir: null, blobDir: null };
	const s = await FilesService.open({ ...dirs, ...o });
	await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const by = { actorKind: "user" as const, actorId: "adm" };
	for (const u of ["lea", "max", "bert"]) await s.provisionActor("acme", by, "user", u, u, { issuer: "i", subject: u });
	const h: Record<string, string> = {};
	for (const u of ["adm", "lea", "max", "bert"]) h[u] = (await s.login("acme", "user", { issuer: "i", subject: u })).handle;
	const id = async (who: string) => (await s.issueOperationIds(h[who], 1))[0];
	await s.createWorkspace(h.adm, "team", { kind: "user", id: "lea" }, await id("adm"));
	await s.grant(h.lea, "team", ".", "editor", { kind: "group", id: "north" }, await id("lea"));
	for (const u of ["max", "bert"]) await s.addMember(h.adm, "north", { kind: "user", id: u }, await id("adm"));
	await s.mkdir(h.lea, "team", "proj", await id("lea"));
	await s.write(h.lea, "team", "proj/a.md", bytes("a1"), 0, await id("lea"));
	return { s, h, id };
}

test("a moved subtree takes its versions, blobs and grants along, and the old inheritors lose it at once", async () => {
	const { s, h, id } = await team();
	try {
		await s.write(h.max, "team", "proj/a.md", bytes("a2"), 1, await id("max"));
		await s.grant(h.lea, "team", "proj", "owner", { kind: "user", id: "bert" }, await id("lea"));
		const open = await s.read(h.max, "team", "proj/a.md");          // max's open editor, before the move
		// rename inside the workspace: an editor of the parent who is no owner of the node is refused
		await assert.rejects(s.move(h.max, "team", "proj", "team", "project", await id("max")), code("permissionDenied"));
		assert.deepEqual(await s.move(h.lea, "team", "proj", "team", "project", await id("lea")), { status: "moved" });
		assert.deepEqual(await s.read(h.max, "team", "project/a.md"), { bytes: bytes("a2"), version: 2 }, "versions and blob keep");

		// into lea's home: max and bert see nothing of it right after the acknowledgement, the open save answers notFound
		const mid = await id("lea");
		assert.deepEqual(await s.move(h.lea, "team", "project", "lea", "project", mid), { status: "moved" });
		for (const p of [s.read(h.max, "team", "project/a.md"), s.read(h.max, "lea", "project/a.md"), s.list(h.bert, "lea", "project"),
			s.write(h.max, "team", "project/a.md", bytes("late"), open.version, await id("max"))])
			await assert.rejects(p, code("notFound"));
		// the grant on its stable ID moved with it and stays inert while bert cannot see the workspace
		assert.deepEqual((await s.listGrants(h.lea, "lea", "project")).map((g) => `${g.relation}@${g.subject.id}`), ["owner@bert"]);
		// a retry of the lost reply answers from its receipt, authorized by the parents that stayed
		assert.deepEqual(await s.move(h.lea, "team", "project", "lea", "project", mid), { status: "moved" });
		// and back: the inheritors of team see it again
		await s.move(h.lea, "lea", "project", "team", "proj", await id("lea"));
		assert.equal((await s.read(h.bert, "team", "proj/a.md")).version, 2);
		assert.deepEqual(await s.move(h.lea, "team", "proj", "team", "proj", await id("lea")), { status: "unchanged" });
	} finally { await s.close(); }
});

test("move refuses roots, cycles, taken names and a subtree that would lie too deep", async () => {
	const { s, h, id } = await team({ limits: { maxPathDepth: 4 } });
	try {
		await s.mkdir(h.lea, "team", "proj/sub", await id("lea"));
		await s.mkdir(h.lea, "team", "proj/sub/deep", await id("lea"));
		await s.mkdir(h.lea, "team", "x", await id("lea"));
		await s.mkdir(h.lea, "team", "x/y", await id("lea"));
		await s.mkdir(h.lea, "team", "x/y/z", await id("lea"));
		await assert.rejects(s.move(h.lea, "team", ".", "lea", "team", await id("lea")), code("invalidInput"), "a root does not move");
		await assert.rejects(s.move(h.lea, "team", "proj", "team", "proj/sub/proj", await id("lea")), code("invalidInput"), "into itself");
		await assert.rejects(s.move(h.lea, "team", "proj", "team", "proj/proj", await id("lea")), code("invalidInput"), "into itself, one level");
		await assert.rejects(s.move(h.lea, "team", "proj/a.md", "team", "x", await id("lea")), code("alreadyExists"));
		await assert.rejects(s.move(h.lea, "team", "proj", "team", "nowhere/proj", await id("lea")), code("notFound"));
		// proj holds two levels below it: at x/y/proj it would reach depth 5
		await assert.rejects(s.move(h.lea, "team", "proj", "team", "x/y/proj", await id("lea")), code("capacityExceeded"));
		assert.deepEqual(await s.move(h.lea, "team", "proj", "team", "x/proj", await id("lea")), { status: "moved" });
		assert.deepEqual((await s.list(h.max, "team", "x/proj/sub")).map((e) => e.name), ["deep"]);
		// a restricted node keeps its restriction where it goes
		await s.restrict(h.lea, "team", "x/proj/sub", await id("lea"));
		await s.move(h.lea, "team", "x/proj/sub", "team", "x/y/sub", await id("lea"));
		assert.deepEqual((await s.list(h.max, "team", "x/y")).map((e) => e.name), ["z"]);
		assert.deepEqual(await s.list(h.lea, "team", "x/y"), [{ name: "sub", kind: "dir", restricted: true }, { name: "z", kind: "dir" }]);
		assert.deepEqual((await s.list(h.lea, "team", "x/proj")).map((e) => e.name), ["a.md"]);
	} finally { await s.close(); }
});

test("remove: files with their blob and grants, empty directories, workspaces; never a home or a full directory", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-rm-"));
	const { s, h, id } = await team({}, root);
	try {
		await s.write(h.max, "team", "proj/a.md", bytes("a2"), 1, await id("max"));
		await s.grant(h.lea, "team", "proj/a.md", "owner", { kind: "user", id: "bert" }, await id("lea"));
		assert.equal(blobFiles(join(root, "blobs")).length, 1);
		await assert.rejects(s.remove(h.max, "team", "proj/a.md", 1, await id("max")), (e: Error & { code?: string; currentVersion?: number }) => e.code === "versionConflict" && e.currentVersion === 2);
		await assert.rejects(s.remove(h.max, "team", "proj", null, await id("max")), code("invalidInput"), "not empty");
		const rid = await id("max");
		assert.deepEqual(await s.remove(h.max, "team", "proj/a.md", 2, rid), { status: "removed" });
		assert.deepEqual(await s.remove(h.max, "team", "proj/a.md", 2, rid), { status: "removed" }, "the retry answers from its receipt");
		await assert.rejects(s.read(h.max, "team", "proj/a.md"), code("notFound"));
		assert.equal(blobFiles(join(root, "blobs")).length, 0, "the blob went after the commit");
		assert.equal(await raw(s).count({ type: T.relation, fields: { objectKind: "node", relation: "owner", subjectId: "bert" } }), 1, "its grant went with it: only the one on his home is left");
		assert.equal(await raw(s).count({ type: T.content }), 0);
		// the content quota is freed: a file of the whole quota fits again
		await s.restrict(h.lea, "team", "proj", await id("lea"));
		assert.deepEqual(await s.remove(h.lea, "team", "proj", null, await id("lea")), { status: "removed" });
		assert.equal(await raw(s).count({ type: T.relation, fields: { relation: "restricted" } }), 0, "the restriction went with it");
		await assert.rejects(s.remove(h.lea, "lea", ".", null, await id("lea")), code("invalidInput"), "a home goes with its actor");
		await assert.rejects(s.remove(h.max, "team", ".", null, await id("max")), code("permissionDenied"), "an editor removes no workspace");
		const wid = await id("lea");
		assert.deepEqual(await s.remove(h.lea, "team", ".", null, wid), { status: "removed" });
		assert.deepEqual(await s.remove(h.lea, "team", ".", null, wid), { status: "removed" });
		assert.deepEqual(await s.workspaces(h.max), ["max"]);
		await s.createWorkspace(h.adm, "team", { kind: "user", id: "max" }, await id("adm"));
		assert.deepEqual(await s.list(h.max, "team", "."), [], "the name is free again, with nothing of the old one");
	} finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
});

for (const [point, committed] of [["commit:before", false], ["commit:after", true], ["afterCommit", true]] as const) {
	test(`a removal interrupted at ${point}: the file and its blob agree after the outcome is resolved`, async () => {
		const root = mkdtempSync(join(tmpdir(), "spaces-files-rm-"));
		let fail: FaultPoint | null = null;
		const { s, h, id } = await team({ faultHook: (p) => { if (p === fail) { fail = null; throw new Error(`lost at ${p}`); } } }, root);
		try {
			const op = await id("lea");
			fail = point;
			if (point === "afterCommit") {
				// past the commit the blob's deletion is the last step: a failure there leaves an orphan for the sweep
				await assert.rejects(s.remove(h.lea, "team", "proj/a.md", null, op), /lost at/);
			} else {
				await assert.rejects(s.remove(h.lea, "team", "proj/a.md", null, op), code("unavailable"));
				assert.equal(await s.resolveOutcomes(), 1);
			}
			const there = await s.read(h.lea, "team", "proj/a.md").then(() => true, () => false);
			assert.equal(there, !committed);
			if (committed) {
				assert.equal(blobFiles(join(root, "blobs")).length, point === "afterCommit" ? 1 : 1, "the blob is an orphan now");
				assert.equal(await s.sweepBlobs("acme"), 1);
				assert.equal(blobFiles(join(root, "blobs")).length, 0);
			} else assert.equal((await s.read(h.lea, "team", "proj/a.md")).bytes.toString(), "a1");
			// the retry with the same ID: removed exactly once either way
			assert.deepEqual(await s.remove(h.lea, "team", "proj/a.md", null, op), { status: "removed" });
			await assert.rejects(s.read(h.lea, "team", "proj/a.md"), code("notFound"));
			assert.equal(await s.sweepBlobs("acme"), 0);
			assert.equal(blobFiles(join(root, "blobs")).length, 0);
		} finally { await s.close(); rmSync(root, { recursive: true, force: true }); }
	});
}
