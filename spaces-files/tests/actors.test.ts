// Actor registration (docs/zanzibar-agent-filesystem-plan.en.md, sections 2, 3 and 5): the FsActor, its private home
// root and the home's first owner commit in one transaction with the audit row; agent instances are bound to
// (enrolledHostPeerId, agentId) and users to (issuer, subject), each pair at most once per tenant; duplicates create
// nothing; only an enabled tenant administrator registers; lookups fail closed.
import test from "node:test";
import assert from "node:assert/strict";
import { PhiSpaces } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FilesService, tenantAlias } from "../server/service.ts";
import { AlreadyExists, InvalidInput, PermissionDenied, T, Unauthenticated, WORKSPACES } from "../server/schema.ts";

const ADMIN = { actorId: "lea", homeName: "lea", issuer: "https://id.example", subject: "sub-lea" };
const LEA = { actorKind: "user" as const, actorId: "lea" };
const raw = (s: FilesService, tenantId: string) => new PhiSpaces(s.host, ctx, Date.now, undefined, undefined, { space: tenantAlias(tenantId) });

async function tenant(...ids: string[]): Promise<FilesService> {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	for (const id of ids) await s.createTenant(id, ADMIN);
	return s;
}

test("an agent instance gets its actor, private home, owner relation and audit row in one commit", async () => {
	const s = await tenant("acme");
	try {
		const before = (await raw(s, "acme").readAll()).length;
		const r = await s.provisionActor("acme", LEA, "agent", "conv-1", "conv-1 home", { enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		const rows = await raw(s, "acme").readAll();
		assert.equal(rows.length, before + 4);
		const actor = rows.find((e) => e.type === T.actor && e.fields.actorId === "conv-1")!;
		assert.deepEqual(actor.fields, { actorKind: "agent", actorId: "conv-1", state: "enabled", homeNodeId: r.homeNodeId, enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		assert.ok(rows.some((e) => e.type === T.node && e.fields.nodeId === r.homeNodeId && e.fields.parentId === WORKSPACES && e.fields.name === "conv-1 home"));
		assert.ok(rows.some((e) => e.type === T.relation && e.fields.objectId === r.homeNodeId && e.fields.relation === "owner" && e.fields.subjectKind === "agent" && e.fields.subjectId === "conv-1"));
		const audit = rows.filter((e) => e.type === T.audit).map((e) => e.fields).sort((a, b) => (a.seq as number) - (b.seq as number));
		assert.deepEqual(audit.map((a) => [a.seq, a.operation, a.actorKind, a.actorId]), [[1, "createTenant", "operator", ""], [2, "registerActor", "user", "lea"]]);
		assert.deepEqual(await s.findActor("acme", "agent", { enrolledHostPeerId: "host-a", agentId: "conversation-1" }), { actorKind: "agent", actorId: "conv-1", homeNodeId: r.homeNodeId });
	} finally { await s.close(); }
});

test("two conversations of one host and equal agent IDs on two hosts are distinct actors with distinct homes", async () => {
	const s = await tenant("acme");
	try {
		const a1 = await s.provisionActor("acme", LEA, "agent", "a1", "a1", { enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		const a2 = await s.provisionActor("acme", LEA, "agent", "a2", "a2", { enrolledHostPeerId: "host-a", agentId: "conversation-2" });
		const b1 = await s.provisionActor("acme", LEA, "agent", "b1", "b1", { enrolledHostPeerId: "host-b", agentId: "conversation-1" });
		assert.equal(new Set([a1.homeNodeId, a2.homeNodeId, b1.homeNodeId]).size, 3);
		const find = (peer: string, agentId: string) => s.findActor("acme", "agent", { enrolledHostPeerId: peer, agentId }).then((a) => a.actorId);
		assert.deepEqual([await find("host-a", "conversation-1"), await find("host-a", "conversation-2"), await find("host-b", "conversation-1")], ["a1", "a2", "b1"]);
		await assert.rejects(find("host-c", "conversation-1"), Unauthenticated);
	} finally { await s.close(); }
});

test("duplicate actor IDs, home names and identity pairs create nothing", async () => {
	const s = await tenant("acme");
	try {
		await s.provisionActor("acme", LEA, "agent", "a1", "a1", { enrolledHostPeerId: "host-a", agentId: "planner-17" });
		await s.provisionActor("acme", LEA, "user", "max", "max", { issuer: "https://id.example", subject: "sub-max" });
		const before = (await raw(s, "acme").readAll()).length;
		const dupes: Array<Parameters<FilesService["provisionActor"]>> = [
			["acme", LEA, "agent", "a1", "other", { enrolledHostPeerId: "host-a", agentId: "x" }],          // actor ID
			["acme", LEA, "agent", "a2", "a1", { enrolledHostPeerId: "host-a", agentId: "x" }],             // home name (a workspace)
			["acme", LEA, "agent", "a2", "a2", { enrolledHostPeerId: "host-a", agentId: "planner-17" }],    // agent identity
			["acme", LEA, "user", "max2", "max2", { issuer: "https://id.example", subject: "sub-max" }],     // user identity
			["acme", LEA, "user", "lea2", "lea2", { issuer: ADMIN.issuer, subject: ADMIN.subject }],        // the admin's identity
		];
		for (const args of dupes) await assert.rejects(s.provisionActor(...args), AlreadyExists, JSON.stringify(args.slice(2)));
		assert.equal((await raw(s, "acme").readAll()).length, before, "nothing was created");
		// the same user identity and the same agent pair are separate actors in another tenant
		await s.createTenant("globex", ADMIN);
		await s.provisionActor("globex", LEA, "user", "max", "max", { issuer: "https://id.example", subject: "sub-max" });
		await s.provisionActor("globex", LEA, "agent", "a1", "a1", { enrolledHostPeerId: "host-a", agentId: "planner-17" });
		assert.deepEqual(s.state.tenantsFor("https://id.example", "sub-max"), ["acme", "globex"]);
	} finally { await s.close(); }
});

test("only an enabled tenant administrator registers, and input is checked first", async () => {
	const s = await tenant("acme");
	try {
		await s.provisionActor("acme", LEA, "user", "max", "max", { issuer: "https://id.example", subject: "sub-max" });
		await assert.rejects(s.provisionActor("acme", { actorKind: "user", actorId: "max" }, "user", "eve", "eve", { issuer: "i", subject: "eve" }), PermissionDenied);
		await assert.rejects(s.provisionActor("acme", { actorKind: "user", actorId: "ghost" }, "user", "eve", "eve", { issuer: "i", subject: "eve" }), Unauthenticated);
		await assert.rejects(s.provisionActor("acme", LEA, "agent", "a b", "x", { enrolledHostPeerId: "h", agentId: "c" }), InvalidInput);
		await assert.rejects(s.provisionActor("acme", LEA, "agent", "a", "x", { enrolledHostPeerId: "h", agentId: "c/d" }), InvalidInput);
		await assert.rejects(s.provisionActor("acme", LEA, "agent", "a", "x", { issuer: "i", subject: "s" } as never), InvalidInput);
		await assert.rejects(s.provisionActor("acme", LEA, "user", "a", "../x", { issuer: "i", subject: "s" }), InvalidInput);
		// a tenant in provisioning registers nobody
		await s.reserveTenantSpace("initech");
		await assert.rejects(s.provisionActor("initech", LEA, "user", "a", "a", { issuer: "i", subject: "s" }), (e: Error & { code?: string }) => e.code === "unavailable");
	} finally { await s.close(); }
});

test("registration respects the quotas and creates nothing past them", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, limits: { maxActors: 2, maxNameBytes: 8 } });
	try {
		await s.createTenant("acme", ADMIN);
		await assert.rejects(s.provisionActor("acme", LEA, "user", "max", "123456789", { issuer: "i", subject: "max" }), (e: Error & { code?: string }) => e.code === "capacityExceeded", "the configured name limit");
		await s.provisionActor("acme", LEA, "user", "max", "max", { issuer: "i", subject: "max" });
		const before = (await raw(s, "acme").readAll()).length;
		await assert.rejects(s.provisionActor("acme", LEA, "user", "eve", "eve", { issuer: "i", subject: "eve" }), (e: Error & { code?: string }) => e.code === "capacityExceeded");
		assert.equal((await raw(s, "acme").readAll()).length, before);
	} finally { await s.close(); }
});
