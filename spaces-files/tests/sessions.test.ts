// The session adapter (docs/zanzibar-agent-filesystem-plan.en.md, sections 2 and 5, steps 1 and 2 of the order of
// checks): login resolves a verified identity to an enabled actor of an initialized tenant; a request is authenticated
// by its handle outside every queue, then admitted into that tenant's queue, then the actor's current state is checked.
import test from "node:test";
import assert from "node:assert/strict";
import { PhiSpaces } from "phi-spaces";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import { FilesService, tenantAlias } from "../server/service.ts";
import { T, Unauthenticated } from "../server/schema.ts";
import { Unavailable } from "../server/admission.ts";

const MIN = 60_000;
const ADMIN = { actorId: "lea", homeName: "lea", issuer: "https://id.example", subject: "sub-lea" };
const LEA_ID = { issuer: ADMIN.issuer, subject: ADMIN.subject };
const LEA = { actorKind: "user" as const, actorId: "lea" };
const raw = (s: FilesService, tenantId: string) => new PhiSpaces(s.host, ctx, Date.now, undefined, undefined, { space: tenantAlias(tenantId) });
const whoami = (s: FilesService, handle: unknown) => s.withSession(handle, async (who) => `${who.tenantId}/${who.actorKind}:${who.actorId}`);

/** Sets an actor's state the way the actor transitions of phase 3 will: take the row, write its successor. */
async function setState(s: FilesService, tenantId: string, kind: string, actorId: string, state: string) {
	const sp = raw(s, tenantId);
	const old = await sp.take({ type: T.actor, fields: { actorKind: kind, actorId } }, 0);
	await sp.write({ type: T.actor, fields: { ...old!.fields, state } }, null, FOREVER);
}

test("a login binds the handle to the actor its identity resolves to, and the request reaches that tenant", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		await s.createTenant("acme", ADMIN);
		await s.createTenant("globex", { ...ADMIN, actorId: "lea-g" });
		const acme = await s.login("acme", "user", LEA_ID);
		const globex = await s.login("globex", "user", LEA_ID);
		assert.equal(acme.actor.actorId, "lea");
		assert.notEqual(acme.handle, globex.handle);
		assert.equal(await whoami(s, acme.handle), "acme/user:lea");
		assert.equal(await whoami(s, globex.handle), "globex/user:lea-g");
		// the operation sees its own tenant's Space only
		await s.withSession(acme.handle, (_, sp) => sp.write({ type: "Probe", fields: { n: 1 } }, null, FOREVER));
		assert.equal(await s.withSession(globex.handle, (_, sp) => sp.readIfExists({ type: "Probe" }, 0)), null);

		await s.registerActor("acme", LEA, "agent", "a1", "a1", { enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		const agent = await s.login("acme", "agent", { enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		assert.equal(await whoami(s, agent.handle), "acme/agent:a1");
	} finally { await s.close(); }
});

test("logins fail closed: unknown identities, other tenants, tenants in provisioning", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		await s.createTenant("acme", ADMIN);
		await assert.rejects(s.login("acme", "user", { issuer: ADMIN.issuer, subject: "sub-eve" }), Unauthenticated);
		await assert.rejects(s.login("acme", "user", { issuer: "https://other.example", subject: ADMIN.subject }), Unauthenticated);
		await assert.rejects(s.login("acme", "agent", { enrolledHostPeerId: "host-a", agentId: "lea" }), Unauthenticated);
		await s.reserveTenantSpace("initech");
		await assert.rejects(s.login("initech", "user", LEA_ID), Unavailable);
	} finally { await s.close(); }
});

test("bad, expired, logged-out and old-epoch handles never reach a tenant queue", async () => {
	const c = { t: 1_000_000 };
	const s = await FilesService.open({ dataDir: null, stateDir: null, now: () => c.t, state: { sessionIdleMs: 30 * MIN, sessionAbsoluteMs: 120 * MIN } });
	try {
		await s.createTenant("acme", ADMIN);
		let entered = 0;
		const probe = (h: unknown) => s.withSession(h, async () => { entered++; });
		for (const bad of [undefined, null, 42, "", "nope"]) await assert.rejects(probe(bad), Unauthenticated);

		const idle = await s.login("acme", "user", LEA_ID);
		c.t += 31 * MIN;
		await assert.rejects(probe(idle.handle), Unauthenticated, "idle expiry");

		const out = await s.login("acme", "user", LEA_ID);
		s.logout(out.handle);
		await assert.rejects(probe(out.handle), Unauthenticated, "logout");

		const old = await s.login("acme", "user", LEA_ID);
		await probe(old.handle);
		s.state.advanceEpoch();
		await assert.rejects(probe(old.handle), Unauthenticated, "old epoch");
		assert.equal(entered, 1);
		const fresh = await s.login("acme", "user", LEA_ID);
		await probe(fresh.handle);
		assert.equal(entered, 2);
	} finally { await s.close(); }
});

test("the actor's current state is checked inside the queue on every request", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		await s.createTenant("acme", ADMIN);
		await s.registerActor("acme", LEA, "agent", "a1", "a1", { enrolledHostPeerId: "host-a", agentId: "conversation-1" });
		const id = { enrolledHostPeerId: "host-a", agentId: "conversation-1" };
		const { handle } = await s.login("acme", "agent", id);
		assert.equal(await whoami(s, handle), "acme/agent:a1");
		await setState(s, "acme", "agent", "a1", "disabled");
		await assert.rejects(whoami(s, handle), Unauthenticated, "a disabled actor's open session");
		await assert.rejects(s.login("acme", "agent", id), Unauthenticated, "a disabled actor's login");
		await setState(s, "acme", "agent", "a1", "enabled");
		assert.equal(await whoami(s, handle), "acme/agent:a1", "enabled again, the session works");
		await setState(s, "acme", "agent", "a1", "deleted");
		await assert.rejects(whoami(s, handle), Unauthenticated, "a deleted actor");
	} finally { await s.close(); }
});

test("a suspended tenant admits valid sessions to nothing", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		await s.createTenant("acme", ADMIN);
		await s.createTenant("globex", { ...ADMIN, actorId: "lea-g" });
		const a = await s.login("acme", "user", LEA_ID), g = await s.login("globex", "user", LEA_ID);
		s.admission.suspend("acme", "test");
		await assert.rejects(whoami(s, a.handle), Unavailable);
		assert.equal(await whoami(s, g.handle), "globex/user:lea-g");
		s.admission.resume("acme");
		assert.equal(await whoami(s, a.handle), "acme/user:lea");
	} finally { await s.close(); }
});
