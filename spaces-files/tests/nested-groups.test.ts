// Nested groups (docs/zanzibar-agent-filesystem-plan.en.md, section 4 and section 8, nested groups): a group's members
// may be another group's members. Rights flow through every level up to the depth bound; a cycle is refused when it
// would be written and is `inconsistentState` when found in stored rows (checked before the depth bound); removing a
// nested group takes the rights away at once.
import test from "node:test";
import assert from "node:assert/strict";
import { type ActorRow, type NodeRow, type PolicyData, type RelRow, checkMembership, membersOf, resolve } from "../server/policy.ts";
import { CapacityExceeded, DIRECT, InconsistentState, InvalidInput, NotFound, WORKSPACES, type ActorKind } from "../server/schema.ts";
import { FilesService } from "../server/service.ts";

const node = (name: string): NodeRow => ({ nodeId: `id:${name}`, parentId: WORKSPACES, name, kind: "dir" });
const rel = (objectKind: string, objectId: string, relation: string, subjectKind: string, subjectId: string): RelRow =>
	({ objectKind, objectId, relation, subjectKind, subjectId, subjectRelation: subjectKind === "group" ? "member" : DIRECT });
const inGroup = (g: string, sub: string) => sub.startsWith("group:") ? rel("group", g, "member", "group", sub.slice(6)) : rel("group", g, "member", "user", sub);

function data(rels: RelRow[], actors: ActorRow[] = [{ actorKind: "user", actorId: "max", state: "enabled" }, { actorKind: "user", actorId: "off", state: "disabled" }]): PolicyData {
	const nodes = [node("dispatch")];
	return {
		node: async (id) => nodes.find((n) => n.nodeId === id) ?? null,
		children: async (p, name, l) => nodes.filter((n) => n.parentId === p && n.name === name).slice(0, l),
		relationsOn: async (k, id, l) => rels.filter((r) => r.objectKind === k && r.objectId === id).slice(0, l),
		groupsOf: async (k, id, l) => rels.filter((r) => r.objectKind === "group" && r.subjectKind === k && r.subjectId === id).map((r) => r.objectId).slice(0, l),
		actor: async (k, id) => actors.find((a) => a.actorKind === k && a.actorId === id) ?? null,
	};
}
const MAX = { actorKind: "user" as ActorKind, actorId: "max" };
const grant = rel("node", "id:dispatch", "editor", "group", "north");
const chain = (n: number) => Array.from({ length: n - 1 }, (_, i) => inGroup(`g${i + 1}`, `group:g${i}`));

test("rights flow through nested groups up to the depth bound", async () => {
	// max in south, south in north, north editor on dispatch
	const nested = [grant, inGroup("north", "group:south"), inGroup("south", "max")];
	assert.equal((await resolve(data(nested), MAX, "dispatch", [])).role, "editor");
	assert.deepEqual(await membersOf(data(nested), "north"), [{ kind: "group", id: "south", relation: "member" }]);
	// a disabled actor's nested memberships count for nothing
	await assert.rejects(resolve(data([grant, inGroup("north", "group:south"), inGroup("south", "off")]), { actorKind: "user", actorId: "off" }, "dispatch", []), NotFound);
	// a diamond is no cycle: south reaches north twice
	const diamond = [grant, inGroup("north", "group:a"), inGroup("north", "group:b"), inGroup("a", "group:south"), inGroup("b", "group:south"), inGroup("south", "max")];
	assert.equal((await resolve(data(diamond), MAX, "dispatch", [])).role, "editor");
	// g0 ⊂ g1 ⊂ … ⊂ g(n-1); max in g0, g(n-1) editor: four levels resolve, five exceed the default bound
	const deep = (n: number) => [rel("node", "id:dispatch", "editor", "group", `g${n - 1}`), inGroup("g0", "max"), ...chain(n)];
	assert.equal((await resolve(data(deep(4)), MAX, "dispatch", [])).role, "editor");
	await assert.rejects(resolve(data(deep(5)), MAX, "dispatch", []), CapacityExceeded);
	assert.equal((await resolve(data(deep(5)), MAX, "dispatch", [], { limits: { maxGroupDepth: 5 } })).role, "editor");
});

test("a stored cycle is inconsistentState, before the depth bound", async () => {
	const cycle = [grant, inGroup("north", "group:south"), inGroup("south", "group:north"), inGroup("south", "max")];
	await assert.rejects(resolve(data(cycle), MAX, "dispatch", []), InconsistentState);
	await assert.rejects(resolve(data(cycle), MAX, "dispatch", [], { limits: { maxGroupDepth: 1 } }), InconsistentState);
});

test("writing a membership: cycles refused, the depth bound held across both sides of the new edge", async () => {
	const d = data([inGroup("north", "group:south"), inGroup("south", "max")]);
	await assert.rejects(checkMembership(d, "south", { kind: "group", id: "north", relation: "member" }), InvalidInput, "north already contains south");
	await assert.rejects(checkMembership(d, "north", { kind: "group", id: "north", relation: "member" }), InvalidInput);
	assert.equal((await checkMembership(d, "west", { kind: "group", id: "north", relation: "member" })).subjectId, "north");
	// two levels below and two above make four; one more level on either side is refused
	const two = data([inGroup("a1", "group:a0"), inGroup("b1", "group:b0")]);
	assert.equal((await checkMembership(two, "b0", { kind: "group", id: "a1", relation: "member" })).objectId, "b0");
	const three = data([inGroup("a1", "group:a0"), inGroup("a2", "group:a1"), inGroup("b1", "group:b0")]);
	await assert.rejects(checkMembership(three, "b0", { kind: "group", id: "a2", relation: "member" }), CapacityExceeded);
});

test("the service: a nested membership gives access, its removal takes it away at once", async () => {
	const s = await FilesService.open({ dataDir: null, stateDir: null, blobDir: null });
	try {
		await s.createTenant("acme", { actorId: "adm", homeName: "adm", issuer: "i", subject: "adm" });
		const by = { actorKind: "user" as const, actorId: "adm" };
		await s.provisionActor("acme", by, "user", "lea", "lea", { issuer: "i", subject: "lea" });
		await s.provisionActor("acme", by, "user", "max", "max", { issuer: "i", subject: "max" });
		const adm = (await s.login("acme", "user", { issuer: "i", subject: "adm" })).handle;
		const lea = (await s.login("acme", "user", { issuer: "i", subject: "lea" })).handle;
		const max = (await s.login("acme", "user", { issuer: "i", subject: "max" })).handle;
		const id = async (h: string) => (await s.issueOperationIds(h, 1))[0];
		const SOUTH = { kind: "group", id: "south" }, NORTH = { kind: "group", id: "north" };
		await s.grant(lea, "lea", ".", "editor", NORTH, await id(lea));
		await s.addMember(adm, "south", { kind: "user", id: "max" }, await id(adm));
		assert.deepEqual(await s.addMember(adm, "north", SOUTH, await id(adm)), { status: "added" });
		assert.deepEqual(await s.listGroups(adm), ["north", "south"]);
		assert.deepEqual(await s.listGroupMembers(adm, "north"), [{ kind: "group", id: "south", relation: "member" }]);
		await assert.rejects(s.addMember(adm, "south", NORTH, await id(adm)), (e: Error & { code?: string }) => e.code === "invalidInput");
		await s.write(max, "lea", "from-max.md", Buffer.from("hi"), 0, await id(max));
		assert.deepEqual(await s.workspaces(max), ["lea", "max"]);
		assert.deepEqual(await s.removeMember(adm, "north", SOUTH, await id(adm)), { status: "removed" });
		assert.deepEqual(await s.workspaces(max), ["max"]);
		await assert.rejects(s.read(max, "lea", "from-max.md"), (e: Error & { code?: string }) => e.code === "notFound");
	} finally { await s.close(); }
});
