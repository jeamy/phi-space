// The multi-batch owner-replacement and relation-removal runbook (docs/zanzibar-agent-filesystem-plan.en.md, section 3,
// actor lifecycle; phase 5 exit evidence), in ordinary maintenance: an actor owns more workspaces than one transaction
// can hand to replacement owners, and holds more relations than one deletion may remove. Without a cooperating owner,
// the operator enters maintenance mode and an administrator installs replacement owners in bounded maintenancePutGrant
// batches, `lastOwner` holding in every one; the disable then needs only the actor row; memberships go in admin batches
// and the remaining grants in maintenancePutGrant batches; the deletion then fits. No step reads or writes a file.
import test from "node:test";
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { T } from "../server/schema.ts";
import { FilesService, tenantAlias } from "../server/service.ts";

const code = (c: string) => (e: Error & { code?: string }) => { assert.equal(e.code, c, e.message); return true; };
const X = { kind: "user", id: "xena" }, ADM = { kind: "user", id: "adm" };
const N = 80, GROUPS = 6, BATCH = 16;

test("the runbook: replacement owners and relation removal in bounded batches, then disable and delete", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null, limits: { maxDeleteRelations: 8 } });
	try {
		await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
		const adm = (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
		const id = async (h = adm) => (await s.issueOperationIds(h, 1))[0];
		await s.registerActor(adm, "user", "xena", "xena", { issuer: "i", subject: "xena" }, await id());
		const xena = (await s.login("acme", "user", { issuer: "i", subject: "xena" })).handle;
		const names = Array.from({ length: N }, (_, i) => `ws-${String(i).padStart(3, "0")}`);
		for (const n of names) await s.createWorkspace(adm, n, X, await id());
		for (let g = 0; g < GROUPS; g++) await s.addMember(adm, `g${g}`, X, await id());
		await s.write(xena, names[0], "plan.md", Buffer.from("x"), 0, await id(xena));
		const relations = () => s.store.space(tenantAlias("acme"))
			.count({ type: T.relation, fields: { subjectKind: "user", subjectId: "xena" } });
		const before = await relations();
		assert.equal(before, N + 1 + GROUPS, "the owned workspaces, the home and the memberships");

		// every replacement at once exceeds what one transaction takes, and as many as fit leave roots without an owner;
		// nothing changes either way
		const all = [...names, "xena"].map((w) => ({ workspace: w, owner: ADM }));
		await assert.rejects(s.disableActor(adm, X, all, await id()), code("invalidInput"));
		await assert.rejects(s.disableActor(adm, X, all.slice(0, 64), await id()), code("lastOwner"));
		assert.equal(await relations(), before);
		// a disable without them is refused by the final-owner rule
		await assert.rejects(s.disableActor(adm, X, null, await id()), code("lastOwner"));

		// maintenance: the replacement owners in bounded batches; every batch keeps an enabled owner on every root
		await s.setMode("maintenance");
		await assert.rejects(s.read(xena, names[0], "plan.md"), code("unavailable"), "no file access in maintenance");
		const roots = [...names, "xena"];
		for (let i = 0; i < roots.length; i += BATCH) {
			for (const w of roots.slice(i, i + BATCH)) assert.deepEqual(await s.maintenancePutGrant(adm, w, ".", "grant", "owner", ADM, await id()), { status: "granted" });
		}
		// the disable now needs only the actor row, its receipt and audit
		assert.deepEqual(await s.disableActor(adm, X, null, await id()), { status: "disabled" });
		// the deletion still holds too many relations: it changes nothing
		await assert.rejects(s.deleteActor(adm, X, null, await id()), code("capacityExceeded"));
		// memberships in admin batches, owner tuples in maintenancePutGrant batches
		for (let g = 0; g < GROUPS; g++) assert.deepEqual(await s.removeMember(adm, `g${g}`, X, await id()), { status: "removed" });
		const remaining = [...names, "xena"];
		while (remaining.length > 4) {
			for (const w of remaining.splice(0, BATCH)) assert.deepEqual(await s.maintenancePutGrant(adm, w, ".", "revoke", "owner", X, await id()), { status: "revoked" });
		}
		assert.equal(await relations(), remaining.length);
		assert.deepEqual(await s.deleteActor(adm, X, null, await id()), { status: "deleted" });
		assert.equal(await relations(), 0);
		await s.setMode("normal");

		// every workspace kept an owner throughout, and its content
		assert.equal((await s.read(adm, names[0], "plan.md")).bytes.toString(), "x");
		assert.equal((await s.workspaces(adm)).length, N + 2);
		await assert.rejects(s.workspaces(xena), code("unauthenticated"));
	} finally { await s.close(); }
});
