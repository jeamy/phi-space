// Restricted children (docs/zanzibar-agent-filesystem-plan.en.md, section 4 and section 8, restricted children): an
// owner restricts a node below the workspace root; inheritance stops there except for owner, so the viewers and editors
// of the directories above lose the node and everything below it at once, unless they hold a grant on it. A hidden child
// is left out of `list` and answers like an absent path; a viewer grant on a restricted node is no longer redundant.
import test from "node:test";
import assert from "node:assert/strict";
import { FilesService } from "../server/service.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const bytes = (s: string) => Buffer.from(s);

async function team() {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const by = { actorKind: "user" as const, actorId: "adm" };
	for (const u of ["lea", "max", "bert"]) await s.provisionActor("acme", by, "user", u, u, { issuer: "i", subject: u });
	const h: Record<string, string> = {};
	for (const u of ["adm", "lea", "max", "bert"]) h[u] = (await s.login("acme", "user", { issuer: "i", subject: u })).handle;
	const id = async (who: string) => (await s.issueOperationIds(h[who], 1))[0];
	await s.createWorkspace(h.adm, "team", { kind: "user", id: "lea" }, await id("adm"));
	await s.grant(h.lea, "team", ".", "editor", { kind: "group", id: "north" }, await id("lea"));
	for (const u of ["max", "bert"]) await s.addMember(h.adm, "north", { kind: "user", id: u }, await id("adm"));
	await s.mkdir(h.lea, "team", "secret", await id("lea"));
	await s.write(h.lea, "team", "secret/plan.md", bytes("plan"), 0, await id("lea"));
	await s.write(h.lea, "team", "open.md", bytes("open"), 0, await id("lea"));
	return { s, h, id };
}

test("a restricted directory leaves the view of the editors above, at once and with everything below it", async () => {
	const { s, h, id } = await team();
	try {
		assert.equal((await s.read(h.max, "team", "secret/plan.md")).bytes.toString(), "plan", "before: inherited");
		await assert.rejects(s.restrict(h.max, "team", "secret", await id("max")), code("permissionDenied"), "an editor cannot restrict");
		await assert.rejects(s.restrict(h.lea, "team", ".", await id("lea")), code("invalidInput"), "a root is a boundary already");
		const rid = await id("lea");
		assert.deepEqual(await s.restrict(h.lea, "team", "secret", rid), { status: "restricted" });
		assert.deepEqual(await s.restrict(h.lea, "team", "secret", rid), { status: "restricted" }, "the retry answers from its receipt");
		assert.deepEqual(await s.restrict(h.lea, "team", "secret", await id("lea")), { status: "unchanged" });

		// max: the child is gone from the listing and answers like an absent path, for every operation
		assert.deepEqual(await s.list(h.max, "team", "."), [{ name: "open.md", kind: "file" }]);
		for (const p of [s.read(h.max, "team", "secret/plan.md"), s.list(h.max, "team", "secret"), s.read(h.max, "team", "nothing/x.md"),
			s.write(h.max, "team", "secret/new.md", bytes("x"), 0, await id("max"))])
			await assert.rejects(p, code("notFound"));
		// its name stays taken, and nothing more is said about it (not its kind, not a version)
		await assert.rejects(s.write(h.max, "team", "secret", bytes("x"), 0, await id("max")), (e: Error & { code?: string }) => e.code === "alreadyExists" && /a child of that name/.test(e.message));
		await assert.rejects(s.mkdir(h.max, "team", "secret", await id("max")), code("alreadyExists"));
		// the owner above still reaches it, and the listing marks it
		assert.deepEqual(await s.list(h.lea, "team", "."), [{ name: "open.md", kind: "file" }, { name: "secret", kind: "dir", restricted: true }]);
		assert.equal((await s.read(h.lea, "team", "secret/plan.md")).bytes.toString(), "plan");

		// a grant below a hidden restricted node stays inert
		await s.grant(h.lea, "team", "secret/plan.md", "editor", { kind: "user", id: "max" }, await id("lea"));
		await assert.rejects(s.read(h.max, "team", "secret/plan.md"), code("notFound"));
		// a viewer grant on the restricted node is no longer redundant; below it, it is
		await assert.rejects(s.grant(h.lea, "team", "secret/plan.md", "viewer", { kind: "user", id: "bert" }, await id("lea")), code("invalidInput"));
		await s.grant(h.lea, "team", "secret", "viewer", { kind: "user", id: "bert" }, await id("lea"));
		assert.deepEqual((await s.list(h.bert, "team", ".")).map((e) => e.name), ["open.md", "secret"]);
		assert.equal((await s.read(h.bert, "team", "secret/plan.md")).bytes.toString(), "plan");
		// bert's inherited editor stops at the boundary: viewer there, so no save
		await assert.rejects(s.write(h.bert, "team", "secret/plan.md", bytes("b"), 1, await id("bert")), code("permissionDenied"));
		// the marker is no grant
		assert.deepEqual((await s.listGrants(h.lea, "team", "secret")).map((g) => `${g.relation}@${g.subject.kind}:${g.subject.id}`), ["viewer@user:bert"]);

		// lifting it gives the editors above their rights back
		assert.deepEqual(await s.unrestrict(h.lea, "team", "secret", await id("lea")), { status: "unrestricted" });
		assert.deepEqual((await s.list(h.max, "team", ".")).map((e) => e.name), ["open.md", "secret"]);
		await s.write(h.max, "team", "secret/plan.md", bytes("max"), 1, await id("max"));
		assert.deepEqual(await s.unrestrict(h.lea, "team", "secret", await id("lea")), { status: "unchanged" });
	} finally { await s.close(); }
});

test("a restricted file, and a restricted node inside a restricted one", async () => {
	const { s, h, id } = await team();
	try {
		await s.restrict(h.lea, "team", "open.md", await id("lea"));
		assert.deepEqual((await s.list(h.max, "team", ".")).map((e) => e.name), ["secret"]);
		await assert.rejects(s.write(h.max, "team", "open.md", bytes("x"), 0, await id("max")), code("alreadyExists"), "no version leaks");
		// an owner grant on secret for max, then secret/inner restricted: max owns secret, so he reaches inner too
		await s.mkdir(h.lea, "team", "secret/inner", await id("lea"));
		await s.restrict(h.lea, "team", "secret", await id("lea"));
		await s.restrict(h.lea, "team", "secret/inner", await id("lea"));
		await s.grant(h.lea, "team", "secret/inner", "editor", { kind: "user", id: "bert" }, await id("lea"));
		await assert.rejects(s.list(h.bert, "team", "secret/inner"), code("notFound"), "a grant inside a hidden boundary is inert");
		await s.grant(h.lea, "team", "secret", "viewer", { kind: "user", id: "bert" }, await id("lea"));
		assert.deepEqual(await s.list(h.bert, "team", "secret"), [{ name: "inner", kind: "dir", restricted: true }, { name: "plan.md", kind: "file" }]);
		await s.write(h.bert, "team", "secret/inner/b.md", bytes("b"), 0, await id("bert"));
		await s.grant(h.lea, "team", "secret", "owner", { kind: "user", id: "max" }, await id("lea"));
		assert.deepEqual((await s.list(h.max, "team", "secret/inner")).map((e) => e.name), ["b.md"]);
	} finally { await s.close(); }
});
