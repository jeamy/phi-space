// Grants, memberships and revocation (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 to 6.4; phase 3 exit
// evidence): the opening journey with its revoked group membership, the retry after a revocation that discloses
// nothing, grant validation and idempotence, the final owner, denied admin operations audited without a receipt, and
// the security reserve: ordinary receipts full, a removal still admitted and replayed without a new receipt, the
// reserve exhausted closing the tenant durably across a restart until the operator reopens it.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FilesService, tenantAlias, type FaultPoint, type FilesServiceOptions } from "../server/service.ts";
import { T } from "../server/schema.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const bytes = (s: string) => Buffer.from(s);
const raw = (s: FilesService) => s.store.space(tenantAlias("acme"));
const NORTH = { kind: "group", id: "north" };
const LEA = { kind: "user", id: "lea" };
const PLANNER = { kind: "agent", id: "planner-17" };

/** acme: the administrator adm, the user lea and the agent planner-17, each with a home, all logged in. */
async function tenant(o: Partial<FilesServiceOptions> = {}, root?: string) {
	const dirs = root ? { dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs") } : { dataDir: null, stateDir: null, blobDir: null };
	const s = await FilesService.open({ ...dirs, ...o });
	await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const by = { actorKind: "user" as const, actorId: "adm" };
	await s.provisionActor("acme", by, "user", "lea", "lea", { issuer: "i", subject: "lea" });
	await s.provisionActor("acme", by, "agent", "planner-17", "planner-17", { enrolledHostPeerId: "host-1", agentId: "planner-17" });
	return { s, ...(await sessions(s)) };
}
async function sessions(s: FilesService) {
	const adm = (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
	const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
	const planner = (await s.login("acme", "agent", { enrolledHostPeerId: "host-1", agentId: "planner-17" })).handle;
	const id = async (h: string) => (await s.issueOperationIds(h, 1))[0];
	return { adm, lea, planner, id };
}

/** The shared workspace of the journey: dispatch, owned by planner-17, North editor on it, Lea in North. */
async function dispatch(t: Awaited<ReturnType<typeof tenant>>) {
	const { s, adm, planner, id } = t;
	await s.createWorkspace(adm, "dispatch", PLANNER, await id(adm));
	assert.deepEqual(await s.grant(planner, "dispatch", ".", "editor", NORTH, await id(planner)), { status: "granted" });
	assert.deepEqual(await s.addMember(adm, "north", LEA, await id(adm)), { status: "added" });
}

test("the opening journey: a stale save conflicts, the revoked membership hides the whole workspace", async () => {
	const t = await tenant();
	const { s, adm, lea, planner, id } = t;
	try {
		await dispatch(t);
		assert.deepEqual(await s.workspaces(lea), ["dispatch", "lea"]);
		assert.deepEqual(await s.workspaces(adm), ["adm"], "tenant#admin gives no file rights");
		await s.write(planner, "dispatch", "brief.md", bytes("v1"), 0, await id(planner));
		await s.write(lea, "dispatch", "brief.md", bytes("v2"), 1, await id(lea));
		await s.write(planner, "dispatch", "brief.md", bytes("v3"), 2, await id(planner));
		const seen = await s.read(lea, "dispatch", "brief.md");
		assert.equal(seen.version, 3);
		await s.write(lea, "dispatch", "brief.md", bytes("v4 by Lea"), 3, await id(lea));
		// the agent's save over version 3 conflicts and tells it the current version
		await assert.rejects(s.write(planner, "dispatch", "brief.md", bytes("planner over v3"), 3, await id(planner)), (e: Error & { code?: string; currentVersion?: number }) => e.code === "versionConflict" && e.currentVersion === 4);

		// the administrator removes Lea from North, her only access to dispatch
		assert.deepEqual(await s.removeMember(adm, "north", LEA, await id(adm)), { status: "removed" });
		assert.deepEqual(await s.workspaces(lea), ["lea"]);
		// a direct editor grant on the file changes nothing while the workspace is invisible to her
		await s.grant(planner, "dispatch", "brief.md", "editor", LEA, await id(planner));
		await assert.rejects(s.write(lea, "dispatch", "brief.md", bytes("from the open editor"), 4, await id(lea)), code("notFound"));
		await assert.rejects(s.read(lea, "dispatch", "brief.md"), code("notFound"));
		await assert.rejects(s.list(lea, "dispatch", "."), code("notFound"));
		await assert.rejects(s.read(lea, "dispatch", "absent.md"), code("notFound"), "absent and invisible answer alike");
		assert.deepEqual(await s.read(planner, "dispatch", "brief.md"), { bytes: bytes("v4 by Lea"), version: 4 }, "the file stays at version 4");
	} finally { await s.close(); }
});

test("a retry after a revocation discloses nothing: notFound when invisible, permissionDenied when visible", async () => {
	let fail: FaultPoint | null = null;
	const t = await tenant({ faultHook: (p) => { if (p === fail) { fail = null; throw new Error("reply lost"); } } });
	const { s, adm, lea, planner, id } = t;
	try {
		await dispatch(t);
		await s.write(planner, "dispatch", "brief.md", bytes("v1"), 0, await id(planner));
		// Lea's save commits, its reply is lost
		const op = await id(lea);
		fail = "commit:after";
		await assert.rejects(s.write(lea, "dispatch", "brief.md", bytes("v2 by Lea"), 1, op), code("unavailable"));
		await s.resolveOutcomes();
		await s.removeMember(adm, "north", LEA, await id(adm));
		await assert.rejects(s.write(lea, "dispatch", "brief.md", bytes("v2 by Lea"), 1, op), code("notFound"), "the receipt stays undisclosed");
		// visible again as a viewer only: the retry is denied before the receipt answers
		await s.grant(planner, "dispatch", ".", "viewer", LEA, await id(planner));
		await assert.rejects(s.write(lea, "dispatch", "brief.md", bytes("v2 by Lea"), 1, op), code("permissionDenied"));
		assert.equal((await s.read(lea, "dispatch", "brief.md")).version, 2, "she learns the outcome only by reading");
		// with editor rights again, the retry answers from its receipt: one increment in all
		await s.addMember(adm, "north", LEA, await id(adm));
		assert.deepEqual(await s.write(lea, "dispatch", "brief.md", bytes("v2 by Lea"), 1, op), { version: 2 });
	} finally { await s.close(); }
});

test("grants: validation, idempotence, the final owner, listGrants", async () => {
	const t = await tenant();
	const { s, adm, lea, planner, id } = t;
	try {
		await dispatch(t);
		await s.mkdir(planner, "dispatch", "plans", await id(planner));
		await assert.rejects(s.grant(planner, "dispatch", "plans", "viewer", LEA, await id(planner)), code("invalidInput"), "a redundant viewer below the root");
		await assert.rejects(s.grant(planner, "dispatch", ".", "editor", { kind: "user", id: "ghost" }, await id(planner)), code("invalidInput"), "an unknown subject");
		await assert.rejects(s.grant(planner, "dispatch", ".", "admin", LEA, await id(planner)), code("invalidInput"), "an unknown relation");
		await assert.rejects(s.grant(planner, "dispatch", ".", "editor", { kind: "robot", id: "x" }, await id(planner)), code("invalidInput"));
		await assert.rejects(s.grant(lea, "dispatch", ".", "owner", LEA, await id(lea)), code("permissionDenied"), "an editor is not an owner");
		await assert.rejects(s.grant(lea, "planner-17", ".", "owner", LEA, await id(lea)), code("notFound"));
		const op = await id(planner);
		assert.deepEqual(await s.grant(planner, "dispatch", ".", "editor", NORTH, op), { status: "unchanged" }, "an identical grant succeeds");
		assert.deepEqual(await s.grant(planner, "dispatch", ".", "editor", NORTH, op), { status: "unchanged" });
		assert.equal(await raw(s).count({ type: T.receipt, fields: { operationId: op } }), 1, "with its receipt");
		assert.deepEqual(await s.revoke(planner, "dispatch", "plans", "editor", LEA, await id(planner)), { status: "unchanged" }, "an absent tuple");
		// the final owner: a group owner does not count, a second direct owner does
		await s.grant(planner, "dispatch", ".", "owner", NORTH, await id(planner));
		await assert.rejects(s.revoke(planner, "dispatch", ".", "owner", PLANNER, await id(planner)), code("lastOwner"));
		await s.grant(planner, "dispatch", ".", "owner", LEA, await id(planner));
		assert.deepEqual(await s.revoke(lea, "dispatch", ".", "owner", PLANNER, await id(lea)), { status: "revoked" });
		assert.deepEqual(await s.listGrants(lea, "dispatch", "."), [
			{ relation: "editor", subject: { kind: "group", id: "north", relation: "member" } },
			{ relation: "owner", subject: { kind: "group", id: "north", relation: "member" } },
			{ relation: "owner", subject: { kind: "user", id: "lea" } },
		]);
		await assert.rejects(s.listGrants(planner, "dispatch", "."), code("notFound"), "planner-17 lost the workspace");
		await s.grant(lea, "dispatch", ".", "editor", PLANNER, await id(lea));
		await assert.rejects(s.listGrants(planner, "dispatch", "."), code("permissionDenied"));
		await assert.rejects(s.createWorkspace(adm, "dispatch", LEA, await id(adm)), code("alreadyExists"));
		await assert.rejects(s.createWorkspace(adm, "x", { kind: "user", id: "ghost" }, await id(adm)), code("invalidInput"));
		await assert.rejects(s.createWorkspace(adm, "x", NORTH, await id(adm)), code("invalidInput"));
	} finally { await s.close(); }
});

test("a denied admin operation is audited in a transaction of its own, without a receipt", async () => {
	const { s, lea, id } = await tenant();
	try {
		const before = await raw(s).count({ type: T.audit });
		const op = await id(lea);
		await assert.rejects(s.addMember(lea, "north", LEA, op), code("permissionDenied"));
		await assert.rejects(s.createWorkspace(lea, "mine", LEA, await id(lea)), code("permissionDenied"));
		const audit = (await raw(s).readAll({ type: T.audit })).map((e) => e.fields).sort((a, b) => (a.seq as number) - (b.seq as number));
		assert.equal(audit.length, before + 2);
		assert.deepEqual(audit.slice(-2).map((a) => [a.operation, a.outcome, a.actorId]), [["addMember", "denied", "lea"], ["createWorkspace", "denied", "lea"]]);
		assert.equal(await raw(s).count({ type: T.receipt, fields: { operationId: op } }), 0);
		assert.equal(await raw(s).count({ type: T.relation, fields: { objectKind: "group" } }), 0, "no membership");
	} finally { await s.close(); }
});

test("the security reserve: ordinary receipts full, a removal still admitted, the exhausted reserve closes the tenant durably", async () => {
	const root = mkdtempSync(join(tmpdir(), "spaces-files-grants-"));
	const limits = { maxReceipts: 3, securityReceiptReserve: 1 };
	try {
		let t = await tenant({ limits }, root);
		await dispatch(t);                                  // three receipts: the ordinary pool is full
		let { s, adm, lea, planner, id } = t;
		const audit = await raw(s).count({ type: T.audit });
		await assert.rejects(s.grant(planner, "dispatch", ".", "viewer", PLANNER, await id(planner)), code("capacityExceeded"));
		assert.equal(await raw(s).count({ type: T.audit }), audit, "no audit row removed, none added");
		assert.equal(s.admission.open, true);
		// the membership removal draws on the reserve; the open editor is denied; the replay allocates nothing
		const op = await id(adm);
		assert.deepEqual(await s.removeMember(adm, "north", LEA, op), { status: "removed" });
		await assert.rejects(s.write(lea, "dispatch", "x.md", bytes("x"), 0, await id(lea)), code("notFound"));
		assert.deepEqual(await s.removeMember(adm, "north", LEA, op), { status: "removed" });
		assert.equal(await raw(s).count({ type: T.receipt }), 4);
		// the reserve is exhausted: the next security action closes the tenant
		await assert.rejects(s.revoke(planner, "dispatch", ".", "editor", NORTH, await id(planner)), code("unavailable"));
		await assert.rejects(s.read(planner, "dispatch", "."), code("unavailable"));
		await s.close();

		s = await FilesService.open({ dataDir: join(root, "data"), stateDir: join(root, "state"), blobDir: join(root, "blobs"), limits: { maxReceipts: 10, securityReceiptReserve: 2 } });
		await assert.rejects(s.login("acme", "user", { issuer: "i", subject: "lea" }), code("unavailable"));
		assert.equal(s.state.closedTenants()[0]?.tenantId, "acme", "closed across the restart");
		assert.equal(s.state.closedTenants()[0]?.action.operation, "revoke", "with its pending action");
		await assert.rejects(s.inTenant("acme", async () => "ran"), code("unavailable"));
		// the operator made room (larger limits) and reopens; the pending revocation now succeeds
		s.reopenClosedTenant("acme");
		({ adm, lea, planner, id } = await sessions(s));
		assert.deepEqual(await s.revoke(planner, "dispatch", ".", "editor", NORTH, await id(planner)), { status: "revoked" });
		await s.close();
	} finally { rmSync(root, { recursive: true, force: true }); }
});
