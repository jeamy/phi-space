// The admin operations (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 and 5; phase 3 exit evidence):
// registration through a session with its receipt, the actor lifecycle with replacement owners, the final owner and
// the final administrator, tombstones that keep IDs and identities from reuse, invalid transitions, deletion within one
// transaction's budget or not at all, tenant-administrator grants and the read-only admin listings.
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FilesService, tenantAlias, type FilesServiceOptions } from "../server/service.ts";
import { T } from "../server/schema.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const raw = (s: FilesService) => s.store.space(tenantAlias("acme"));
const LEA = { kind: "user", id: "lea" };
const PLANNER = { kind: "agent", id: "planner-17" };
const ADM = { kind: "user", id: "adm" };

async function tenant(o: Partial<FilesServiceOptions> = {}) {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, ...o });
	await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
	const adm = (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
	const id = async (h = adm) => (await s.issueOperationIds(h, 1))[0];
	await s.registerActor(adm, "user", "lea", "lea", { issuer: "i", subject: "lea" }, await id());
	await s.registerActor(adm, "agent", "planner-17", "planner-17", { enrolledHostPeerId: "host-1", agentId: "planner-17" }, await id());
	const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
	const planner = (await s.login("acme", "agent", { enrolledHostPeerId: "host-1", agentId: "planner-17" })).handle;
	return { s, adm, lea, planner, id };
}

test("registerActor through a session: receipt, duplicates, tenant#admin required", async () => {
	const { s, adm, lea, id } = await tenant();
	try {
		const op = await id();
		const r = await s.registerActor(adm, "user", "max", "max", { issuer: "i", subject: "max" }, op);
		assert.deepEqual(await s.registerActor(adm, "user", "max", "max", { issuer: "i", subject: "max" }, op), r, "a retry answers from its receipt");
		await assert.rejects(s.registerActor(adm, "user", "max", "max-2", { issuer: "i", subject: "max-2" }, op), code("requestMismatch"));
		assert.equal((await s.login("acme", "user", { issuer: "i", subject: "max" })).actor.homeNodeId, r.homeNodeId);
		await assert.rejects(s.registerActor(adm, "user", "max", "other", { issuer: "i", subject: "other" }, await id()), code("alreadyExists"));
		await assert.rejects(s.registerActor(adm, "user", "other", "max", { issuer: "i", subject: "other" }, await id()), code("alreadyExists"), "a home name");
		await assert.rejects(s.registerActor(adm, "user", "other", "other", { issuer: "i", subject: "max" }, await id()), code("alreadyExists"), "an identity");
		await assert.rejects(s.registerActor(adm, "robot", "x", "x", {}, await id()), code("invalidInput"));
		await assert.rejects(s.registerActor(lea, "user", "eve", "eve", { issuer: "i", subject: "eve" }, await id(lea)), code("permissionDenied"));
	} finally { await s.close(); }
});

test("disable and enable: replacement owners, the final owner and administrator, no-ops and invalid transitions", async () => {
	const { s, adm, lea, planner, id } = await tenant();
	try {
		await assert.rejects(s.disableActor(adm, LEA, null, await id()), code("lastOwner"), "lea is the only owner of her home");
		await assert.rejects(s.disableActor(adm, LEA, [{ workspace: "lea", owner: LEA }], await id()), code("invalidInput"), "not herself");
		await assert.rejects(s.disableActor(adm, LEA, [{ workspace: "lea", owner: { kind: "group", id: "north" } }], await id()), code("invalidInput"), "never a group");
		await assert.rejects(s.disableActor(adm, LEA, [{ workspace: "adm", owner: PLANNER }], await id()), code("invalidInput"), "a workspace she does not own");
		const op = await id();
		assert.deepEqual(await s.disableActor(adm, LEA, [{ workspace: "lea", owner: PLANNER }], op), { status: "disabled" });
		assert.deepEqual(await s.disableActor(adm, LEA, [{ workspace: "lea", owner: PLANNER }], op), { status: "disabled" }, "replayed");
		await assert.rejects(s.workspaces(lea), code("unauthenticated"), "a disabled actor fails closed");
		assert.deepEqual(await s.workspaces(planner), ["lea", "planner-17"], "the replacement owns her home now");
		assert.deepEqual(await s.disableActor(adm, LEA, null, await id()), { status: "unchanged" });
		await assert.rejects(s.disableActor(adm, LEA, [{ workspace: "lea", owner: PLANNER }], await id()), code("invalidInput"), "replacements for a disabled actor");
		assert.deepEqual(await s.enableActor(adm, LEA, await id()), { status: "enabled" });
		assert.deepEqual(await s.enableActor(adm, LEA, await id()), { status: "unchanged" });
		assert.deepEqual(await s.workspaces((await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle), ["lea"]);
		await assert.rejects(s.enableActor(adm, { kind: "user", id: "ghost" }, await id()), code("invalidInput"));

		// the final administrator
		await assert.rejects(s.disableActor(adm, ADM, [{ workspace: "adm", owner: LEA }], await id()), code("lastAdmin"));
		await assert.rejects(s.revokeTenantAdmin(adm, "adm", await id()), code("lastAdmin"));
		assert.deepEqual(await s.revokeTenantAdmin(adm, "lea", await id()), { status: "unchanged" });
		assert.deepEqual(await s.grantTenantAdmin(adm, "lea", await id()), { status: "granted" });
		assert.deepEqual(await s.grantTenantAdmin(adm, "lea", await id()), { status: "unchanged" });
		await assert.rejects(s.grantTenantAdmin(adm, "ghost", await id()), code("invalidInput"));
		await assert.rejects(s.grantTenantAdmin(adm, "planner-17", await id()), code("invalidInput"), "agents are never administrators");
		assert.deepEqual(await s.disableActor(adm, ADM, [{ workspace: "adm", owner: LEA }], await id()), { status: "disabled" }, "with another administrator");
		await assert.rejects(s.listActors(adm), code("unauthenticated"));
	} finally { await s.close(); }
});

test("delete: a tombstone, relations gone, IDs and identities never reused, the transaction budget", async () => {
	const { s, adm, lea, planner, id } = await tenant({ limits: { maxDeleteRelations: 3 } });
	try {
		await s.createWorkspace(adm, "dispatch", PLANNER, await id());
		await s.grant(planner, "dispatch", ".", "editor", LEA, await id(planner));
		await s.addMember(adm, "north", PLANNER, await id());
		await s.addMember(adm, "south", PLANNER, await id());
		// planner-17 holds four relations: two owners, two memberships
		const relations = () => raw(s).count({ type: T.relation, fields: { subjectKind: "agent", subjectId: "planner-17" } });
		assert.equal(await relations(), 4);
		const replace = [{ workspace: "dispatch", owner: LEA }, { workspace: "planner-17", owner: LEA }];
		await assert.rejects(s.deleteActor(adm, PLANNER, replace, await id()), code("capacityExceeded"));
		assert.equal(await relations(), 4, "nothing changed");
		assert.equal((await s.listActors(adm)).find((a) => a.id === "planner-17")?.state, "enabled");
		// the runbook: disable first, then remove memberships in batches, then delete
		await s.disableActor(adm, PLANNER, replace, await id());
		await s.removeMember(adm, "north", PLANNER, await id());
		assert.deepEqual(await s.deleteActor(adm, PLANNER, null, await id()), { status: "deleted" });
		assert.equal(await relations(), 0);
		const tomb = (await s.listActors(adm)).find((a) => a.id === "planner-17");
		assert.equal(tomb?.state, "deleted", "the row stays as a tombstone");
		await assert.rejects(s.deleteActor(adm, PLANNER, null, await id()), code("invalidInput"));
		await assert.rejects(s.enableActor(adm, PLANNER, await id()), code("invalidInput"));
		await assert.rejects(s.disableActor(adm, PLANNER, null, await id()), code("invalidInput"));
		await assert.rejects(s.registerActor(adm, "agent", "planner-17", "p2", { enrolledHostPeerId: "host-1", agentId: "p2" }, await id()), code("alreadyExists"), "the ID");
		await assert.rejects(s.registerActor(adm, "agent", "p2", "p2", { enrolledHostPeerId: "host-1", agentId: "planner-17" }, await id()), code("alreadyExists"), "the identity");
		await assert.rejects(s.grant(lea, "dispatch", ".", "editor", PLANNER, await id(lea)), code("invalidInput"), "a deleted subject");
		await assert.rejects(s.workspaces(planner), code("unauthenticated"));
		assert.deepEqual(await s.workspaces(lea), ["dispatch", "lea", "planner-17"]);
	} finally { await s.close(); }
});

test("the admin listings: deterministic, bounded, administrators only", async () => {
	const { s, adm, lea, planner, id } = await tenant();
	try {
		await s.addMember(adm, "south", LEA, await id());
		await s.addMember(adm, "north", PLANNER, await id());
		await s.addMember(adm, "north", LEA, await id());
		await s.grant(planner, "planner-17", ".", "editor", { kind: "group", id: "east" }, await id(planner));
		assert.deepEqual((await s.listWorkspaces(adm)).map((w) => w.name), ["adm", "lea", "planner-17"]);
		assert.deepEqual((await s.listActors(adm)).map((a) => `${a.kind}:${a.id}:${a.state}`), ["agent:planner-17:enabled", "user:adm:enabled", "user:lea:enabled"]);
		assert.deepEqual(await s.listGroups(adm), ["east", "north", "south"], "a group named only by a grant exists too");
		assert.deepEqual(await s.listGroupMembers(adm, "north"), [{ kind: "agent", id: "planner-17" }, { kind: "user", id: "lea" }]);
		assert.deepEqual(await s.listGroupMembers(adm, "east"), []);
		for (const call of [() => s.listActors(lea), () => s.listGroups(lea), () => s.listWorkspaces(lea), () => s.listGroupMembers(lea, "north")])
			await assert.rejects(call(), code("permissionDenied"));
		const denied = (await raw(s).readAll({ type: T.audit })).filter((e) => e.fields.outcome === "denied");
		assert.equal(denied.length, 4, "each refusal is audited");
	} finally { await s.close(); }
});

test("repeated refusals share one audit row per actor, operation and window", async () => {
	const c = { t: Date.now() };
	const { s, lea } = await tenant({ now: () => c.t });
	try {
		const denied = async () => (await raw(s).readAll({ type: T.audit })).filter((e) => e.fields.outcome === "denied");
		for (let i = 0; i < 50; i++) await assert.rejects(s.listActors(lea), code("permissionDenied"));
		await assert.rejects(s.listGroups(lea), code("permissionDenied"));
		let rows = await denied();
		assert.deepEqual(rows.map((r) => [r.fields.operation, r.fields.count]).sort(), [["listActors", 50], ["listGroups", 1]]);
		c.t += 3600_000 + 1; // the next window starts a new row (a fresh session: the old one went idle)
		const lea2 = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		await assert.rejects(s.listActors(lea2), code("permissionDenied"));
		rows = await denied();
		assert.equal(rows.filter((r) => r.fields.operation === "listActors").length, 2);
		assert.equal((await s.sessionInfo(lea2)).admin, false);
	} finally { await s.close(); }
});
