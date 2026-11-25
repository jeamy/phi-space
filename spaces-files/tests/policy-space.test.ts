// The evaluator and the quotas on real tenant Spaces (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 and 4;
// phase 2 exit evidence): the rows provisioning writes evaluate as the plan says, a same-named group in another
// tenant grants nothing, listings derive groups from relations, and quotas refuse with capacityExceeded.
import test from "node:test";
import assert from "node:assert/strict";
import { FOREVER } from "phi-spaces/core";
import type { PhiSpaces } from "phi-spaces";
import { FilesService } from "../server/service.ts";
import { listGroups, resolve, roleOn, spaceData } from "../server/policy.ts";
import { checkQuotas, sumContentBytes } from "../server/quotas.ts";
import { CapacityExceeded, NotFound, content, node, relation, WORKSPACES } from "../server/schema.ts";

const ADMIN = { actorId: "lea", homeName: "lea", issuer: "https://id.example", subject: "sub-lea" };
const LEA = { actorKind: "user" as const, actorId: "lea" };
const put = (sp: PhiSpaces, ...entries: ReturnType<typeof node>[]) => Promise.all(entries.map((e) => sp.write(e, null, FOREVER)));

test("provisioned rows evaluate as the plan says, and tenants stay apart", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null });
	try {
		const acme = await s.createTenant("acme", ADMIN);
		const globex = await s.createTenant("globex", { ...ADMIN, actorId: "max" });
		assert.ok(acme.status === "created" && globex.status === "created");
		await s.registerActor("acme", LEA, "user", "max", "max", { issuer: "i", subject: "max" });
		await s.inTenant("acme", async (sp) => {
			const d = spaceData(sp);
			assert.equal((await resolve(d, LEA, "lea", [])).role, "owner", "the admin owns its home");
			assert.equal((await roleOn(d, LEA, acme.homeNodeId)).role, "owner");
			await assert.rejects(resolve(d, { actorKind: "user", actorId: "max" }, "lea", []), NotFound, "another actor's home is private");
			// a shared workspace for group north
			await put(sp, node("ws-1", WORKSPACES, "dispatch", "dir"), relation("node", "ws-1", "owner", "user", "lea"), relation("node", "ws-1", "editor", "group", "north", "member"));
		});
		// in globex, max is a member of a group of the same name: it grants nothing in acme
		await s.inTenant("globex", (sp) => put(sp, relation("group", "north", "member", "user", "max")));
		await s.inTenant("acme", async (sp) => {
			await assert.rejects(resolve(spaceData(sp), { actorKind: "user", actorId: "max" }, "dispatch", []), NotFound);
			assert.deepEqual(await listGroups(sp), ["north"]);
			await put(sp, relation("group", "north", "member", "user", "max"));
			assert.equal((await resolve(spaceData(sp), { actorKind: "user", actorId: "max" }, "dispatch", [])).role, "editor");
		});
		await s.inTenant("globex", async (sp) => {
			assert.deepEqual(await listGroups(sp), ["north"]);
			await assert.rejects(resolve(spaceData(sp), { actorKind: "user", actorId: "max" }, "dispatch", []), NotFound, "no dispatch in globex");
		});
	} finally { await s.close(); }
});

test("quotas refuse with capacityExceeded and leave admission open", async () => {
	const limits = { maxActors: 3, maxWorkspaces: 3, maxNodes: 5, maxRelations: 6, maxGroups: 1, maxDirEntries: 2, maxGrantsPerTarget: 2, maxContentBytes: 10, maxTenantBytes: 4000 };
	const s = await FilesService.open({ dataDir: null, stateDir: null, limits });
	try {
		const r = await s.createTenant("acme", ADMIN);
		assert.ok(r.status === "created");
		await s.inTenant("acme", async (sp) => {
			const L = s.limits;
			// one actor, one workspace, one node, two relations so far
			await checkQuotas(sp, L, { actors: 2, workspaces: 2, nodes: 4, relations: 4, groups: ["north"], dirEntries: { parentId: r.homeNodeId, n: 2 }, grantsOn: { nodeId: r.homeNodeId, n: 1 }, contentBytes: 10 }, 0);
			const over: Array<[string, Parameters<typeof checkQuotas>[2], number?]> = [
				["actors", { actors: 3 }], ["workspaces", { workspaces: 3 }], ["nodes", { nodes: 5 }], ["relations", { relations: 5 }],
				["groups", { groups: ["north", "south"] }], ["directory entries", { dirEntries: { parentId: r.homeNodeId, n: 3 } }],
				["grants on one target", { grantsOn: { nodeId: r.homeNodeId, n: 2 } }], ["content bytes", { contentBytes: 1 }, 10],
				["stored bytes", { storedBytes: 4000 }],
			];
			for (const [what, d, bytes] of over) await assert.rejects(checkQuotas(sp, L, d, bytes ?? 0), (e: Error) => e instanceof CapacityExceeded && e.message.startsWith(what), what);
			// a group already in the tenant costs nothing; a shorter save frees bytes
			await put(sp, relation("group", "north", "member", "user", "lea"));
			await checkQuotas(sp, L, { groups: ["north"] }, 0);
			await assert.rejects(checkQuotas(sp, L, { groups: ["south"] }, 0), CapacityExceeded);
			await checkQuotas(sp, L, { contentBytes: -4 }, 10);
			const stored = (await sp.stats()).bytes!.entries;
			assert.ok(stored > 0);
			await checkQuotas(sp, L, { storedBytes: 4000 - stored }, 0);
			await assert.rejects(checkQuotas(sp, L, { storedBytes: 4001 - stored }, 0), CapacityExceeded, "exactly at the stored-byte limit and one past it");
			await put(sp, content("f", 1, "héllo"));
			assert.equal(await sumContentBytes(sp), 6);
		});
		assert.equal(s.admission.open, true);
		assert.equal(await s.inTenant("acme", async () => "still admitted"), "still admitted");
	} finally { await s.close(); }
});
