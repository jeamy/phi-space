// Phase 1 exit evidence, end to end through sessions (docs/zanzibar-agent-filesystem-plan.en.md, section 7). The store
// lock and the crash are in service.test.ts, the parts in tenant, actors and sessions tests; here every claim about
// identity runs the whole chain: registration, login with the verified identity, a request on the handle.
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { FOREVER } from "phi-spaces/core";
import { FilesService, tenantAlias } from "../server/service.ts";
import { AlreadyExists, T, Unauthenticated } from "../server/schema.ts";
import { Unavailable } from "../server/admission.ts";

const ADMIN = { actorId: "lea", homeName: "lea", issuer: "https://id.example", subject: "sub-lea" };
const LEA = { actorKind: "user" as const, actorId: "lea" };
const conv = (peer: string, agentId: string) => ({ enrolledHostPeerId: peer, agentId });
const me = (s: FilesService, h: string) => s.withSession(h, async (who) => ({ tenant: who.tenantId, actor: `${who.actorKind}:${who.actorId}`, home: who.homeNodeId }));

test("phase 1 exit: identities, homes, isolation and fail-closed sessions", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		// an uninitialized named Space admits no session
		await s.reserveTenantSpace("acme");
		await assert.rejects(s.login("acme", "user", { issuer: ADMIN.issuer, subject: ADMIN.subject }), Unavailable);
		await s.createTenant("acme", ADMIN);

		// two conversations of one host and equal agent IDs on two hosts: distinct actors, distinct private homes
		const ids = [conv("host-a", "conversation-1"), conv("host-a", "conversation-2"), conv("host-b", "conversation-1")];
		for (const [i, id] of ids.entries()) await s.provisionActor("acme", LEA, "agent", `agent-${i}`, `home-${i}`, id);
		const seen = await Promise.all(ids.map(async (id) => me(s, (await s.login("acme", "agent", id)).handle)));
		assert.deepEqual(seen.map((x) => x.actor), ["agent:agent-0", "agent:agent-1", "agent:agent-2"]);
		assert.equal(new Set(seen.map((x) => x.home)).size, 3);
		const owners = (await s.store.space(tenantAlias("acme")).readAll({ type: T.relation, fields: { relation: "owner" } }))
			.filter((r) => seen.some((x) => x.home === r.fields.objectId)).map((r) => `${r.fields.objectId}@${r.fields.subjectId}`).sort();
		assert.deepEqual(owners, seen.map((x, i) => `${x.home}@agent-${i}`).sort(), "each home is owned by its own actor only");

		// duplicate identity pairs fail without creating an actor or a home
		const count = async () => (await s.store.space(tenantAlias("acme")).readAll()).length;
		const before = await count();
		await assert.rejects(s.provisionActor("acme", LEA, "agent", "agent-x", "home-x", conv("host-a", "conversation-1")), AlreadyExists);
		await assert.rejects(s.provisionActor("acme", LEA, "user", "lea-x", "home-y", { issuer: ADMIN.issuer, subject: ADMIN.subject }), AlreadyExists);
		assert.equal(await count(), before);

		// two tenants stay isolated: the same user identity is a separate actor whose session sees only its own tenant
		await s.createTenant("globex", { ...ADMIN, actorId: "lea-g" });
		const a = await s.login("acme", "user", { issuer: ADMIN.issuer, subject: ADMIN.subject });
		const g = await s.login("globex", "user", { issuer: ADMIN.issuer, subject: ADMIN.subject });
		await s.withSession(a.handle, (_, sp) => sp.write({ type: "Probe", fields: {} }, null, FOREVER));
		assert.equal(await s.withSession(g.handle, (_, sp) => sp.count({ type: "Probe" })), 0);

		// unknown and disabled actors and old session epochs fail closed
		await assert.rejects(s.login("acme", "agent", conv("host-c", "conversation-1")), Unauthenticated);
		const sp = s.store.space(tenantAlias("acme"));
		const h0 = (await s.login("acme", "agent", ids[0]!)).handle;
		const row = await sp.take({ type: T.actor, fields: { actorKind: "agent", actorId: "agent-0" } }, 0);
		await sp.write({ type: T.actor, fields: { ...row!.fields, state: "disabled" } }, null, FOREVER);
		await assert.rejects(me(s, h0), Unauthenticated);
		s.state.advanceEpoch();
		await assert.rejects(me(s, a.handle), Unauthenticated);
		await assert.rejects(me(s, g.handle), Unauthenticated);
	} finally { await s.close(); }
});
