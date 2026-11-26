// Relationship evaluation, table-driven (docs/zanzibar-agent-filesystem-plan.en.md, section 4; phase 2 exit evidence):
// direct, group, inherited and overlapping grants, visibility per workspace, the validator, the final owner and final
// administrator, derived groups, corrupt graphs and work limits. The fixtures are written in the plan's own notation:
// nodes as paths (a trailing slash is a directory), tuples as `object#relation@subject`.
import test from "node:test";
import assert from "node:assert/strict";
import {
	type ActorRow, type NodeRow, type PolicyData, type RelRow, type Role, checkGrant, checkLastAdmin, checkLastOwner,
	checkMembership, checkShape, checkTenantAdmin, groupsIn, membersOf, resolve, roleOn,
} from "../server/policy.ts";
import { CapacityExceeded, DIRECT, InconsistentState, InvalidInput, LastAdmin, LastOwner, NotFound, WORKSPACES, type ActorKind } from "../server/schema.ts";

type World = { nodes: NodeRow[]; rels: RelRow[]; actors: ActorRow[] };
const idOf = (path: string) => `id:${path.replace(/\/$/, "")}`;

/** `nodes`: "dispatch/", "dispatch/brief.md"; `tuples`: "node:dispatch#editor@group:north#member"; `actors`: "user:max=disabled". */
function world(nodes: string[], tuples: string[], actors: string[]): World {
	const w: World = { nodes: [], rels: [], actors: [] };
	for (const p of nodes) {
		const clean = p.replace(/\/$/, ""), i = clean.lastIndexOf("/");
		w.nodes.push({ nodeId: idOf(clean), parentId: i < 0 ? WORKSPACES : idOf(clean.slice(0, i)), name: clean.slice(i + 1), kind: p.endsWith("/") ? "dir" : "file" });
	}
	for (const t of tuples) w.rels.push(tuple(t));
	for (const a of actors) {
		const [ref, state = "enabled"] = a.split("="), [kind, id] = ref!.split(":");
		w.actors.push({ actorKind: kind as ActorKind, actorId: id!, state: state as ActorRow["state"] });
	}
	return w;
}
function tuple(t: string): RelRow {
	const m = /^(\w+):([^#]+)#(\w+)@(\w+):([^#]+)(?:#(\w+))?$/.exec(t);
	if (!m) throw new Error(`bad tuple ${t}`);
	const [, ok, oid, relation, sk, sid, srel] = m;
	return { objectKind: ok!, objectId: ok === "node" ? idOf(oid!) : oid!, relation: relation!, subjectKind: sk!, subjectId: sid!, subjectRelation: srel ?? DIRECT };
}
function data(w: World): PolicyData & { calls: number } {
	const d = {
		calls: 0,
		node: async (id: string) => (d.calls++, w.nodes.find((n) => n.nodeId === id) ?? null),
		children: async (p: string, name: string, l: number) => (d.calls++, w.nodes.filter((n) => n.parentId === p && n.name === name).slice(0, l)),
		relationsOn: async (k: string, id: string, l: number) => (d.calls++, w.rels.filter((r) => r.objectKind === k && r.objectId === id).slice(0, l)),
		groupsOf: async (k: ActorKind, id: string, l: number) => (d.calls++, w.rels.filter((r) => r.objectKind === "group" && r.relation === "member" && r.subjectKind === k && r.subjectId === id).map((r) => r.objectId).slice(0, l)),
		actor: async (k: string, id: string) => (d.calls++, w.actors.find((a) => a.actorKind === k && a.actorId === id) ?? null),
	};
	return d;
}
const ref = (s: string) => { const [k, id] = s.split(":"); return { actorKind: k as ActorKind, actorId: id! }; };

// the journey of section 4: Lea in North, North editor on dispatch, planner-17 owns dispatch and its home
const NODES = ["dispatch/", "dispatch/brief.md", "dispatch/inbox/", "dispatch/inbox/a.md", "lea/", "lea/notes.md", "planner/"];
const BASE = [
	"group:north#member@user:lea",
	"node:dispatch#editor@group:north#member",
	"node:dispatch#owner@agent:planner-17",
	"node:lea#owner@user:lea",
	"node:planner#owner@agent:planner-17",
	"tenant:acme#admin@user:root",
];
const ACTORS = ["user:lea", "agent:planner-17", "user:max", "user:root", "user:off=disabled", "user:gone=deleted"];

type Want = Role | "notFound" | "invalidInput";
const CASES: Array<{ name: string; extra?: string[]; drop?: string[]; actors?: string[]; who: string; at: string; want: Want }> = [
	{ name: "direct owner on the root", who: "agent:planner-17", at: "dispatch/.", want: "owner" },
	{ name: "inherited to a file", who: "agent:planner-17", at: "dispatch/brief.md", want: "owner" },
	{ name: "inherited two levels down", who: "agent:planner-17", at: "dispatch/inbox/a.md", want: "owner" },
	{ name: "group grant on the root", who: "user:lea", at: "dispatch/.", want: "editor" },
	{ name: "group grant inherited", who: "user:lea", at: "dispatch/inbox/a.md", want: "editor" },
	{ name: "overlapping grants: the union", extra: ["node:dispatch/inbox#owner@user:lea"], who: "user:lea", at: "dispatch/inbox/a.md", want: "owner" },
	{ name: "overlap does not lower", extra: ["node:dispatch#viewer@user:lea"], who: "user:lea", at: "dispatch/brief.md", want: "editor" },
	{ name: "a grant below does not reach above", extra: ["node:dispatch/inbox#owner@user:lea"], who: "user:lea", at: "dispatch/brief.md", want: "editor" },
	{ name: "the own home", who: "user:lea", at: "lea/notes.md", want: "owner" },
	{ name: "someone else's home is invisible", who: "user:lea", at: "planner/.", want: "notFound" },
	{ name: "absent and invisible answer alike", who: "user:lea", at: "planner/nope.md", want: "notFound" },
	{ name: "an absent workspace", who: "user:lea", at: "nowhere/.", want: "notFound" },
	{ name: "an absent child of a visible directory", who: "user:lea", at: "dispatch/nope.md", want: "notFound" },
	{ name: "no rights at all", who: "user:max", at: "dispatch/brief.md", want: "notFound" },
	{ name: "a grant below an invisible root is inert", extra: ["node:dispatch/brief.md#editor@user:max"], who: "user:max", at: "dispatch/brief.md", want: "notFound" },
	{ name: "it takes effect once the root is visible", extra: ["node:dispatch/brief.md#editor@user:max", "node:dispatch#viewer@user:max"], who: "user:max", at: "dispatch/brief.md", want: "editor" },
	{ name: "removing Lea from North ends her rights on dispatch", drop: ["group:north#member@user:lea"], who: "user:lea", at: "dispatch/brief.md", want: "notFound" },
	{ name: "her direct editor grant below the root does not help", drop: ["group:north#member@user:lea"], extra: ["node:dispatch/brief.md#editor@user:lea"], who: "user:lea", at: "dispatch/brief.md", want: "notFound" },
	{ name: "tenant#admin gives no file rights", who: "user:root", at: "dispatch/brief.md", want: "notFound" },
	{ name: "a disabled actor holds nothing", extra: ["node:dispatch#owner@user:off"], who: "user:off", at: "dispatch/.", want: "notFound" },
	{ name: "a disabled member's group counts for nothing", extra: ["group:north#member@user:off"], who: "user:off", at: "dispatch/.", want: "notFound" },
	{ name: "membership in another group does not grant", extra: ["group:south#member@user:max"], who: "user:max", at: "dispatch/.", want: "notFound" },
	{ name: "a path through a file", who: "agent:planner-17", at: "dispatch/brief.md/x", want: "invalidInput" },
];

test("effective rights: direct, group, inherited and overlapping grants, visibility per workspace", async () => {
	for (const c of CASES) {
		const drop = new Set(c.drop ?? []);
		const w = world(NODES, [...BASE.filter((t) => !drop.has(t)), ...(c.extra ?? [])], c.actors ?? ACTORS);
		const [ws, ...rest] = c.at.split("/");
		const segs = rest.filter((s) => s !== ".");
		const got = await resolve(data(w), ref(c.who), ws!, segs).then((r) => r.role, (e) => e instanceof NotFound ? "notFound" : e instanceof InvalidInput ? "invalidInput" : Promise.reject(e));
		assert.equal(got, c.want, c.name);
		// the walk by node ID agrees wherever the target exists and is visible
		if (got !== "invalidInput") {
			const node = w.nodes.find((n) => n.nodeId === idOf(c.at.replace(/\/\.$/, "")));
			if (node) assert.equal((await roleOn(data(w), ref(c.who), node.nodeId)).role ?? "notFound", got, `${c.name} (by ID)`);
		}
	}
});

test("the validator: relation shapes, redundant viewers, unknown and deleted subjects", async () => {
	const w = world(NODES, BASE, ACTORS);
	const d = data(w);
	const root = w.nodes.find((n) => n.nodeId === idOf("dispatch"))!, file = w.nodes.find((n) => n.nodeId === idOf("dispatch/brief.md"))!;
	// accepted
	assert.equal((await checkGrant(d, root, "viewer", { kind: "user", id: "max" })).relation, "viewer");
	assert.equal((await checkGrant(d, file, "editor", { kind: "group", id: "north", relation: "member" })).subjectRelation, "member");
	assert.equal((await checkGrant(d, file, "owner", { kind: "user", id: "off" })).subjectId, "off", "a disabled subject may be granted (inert)");
	assert.equal((await checkGrant(d, root, "editor", { kind: "group", id: "Café", relation: "member" })).subjectId, "Café", "group IDs are canonical");
	await checkMembership(d, "north", { kind: "agent", id: "planner-17" });
	await checkTenantAdmin(d, "acme", "max");
	// refused
	const refused: Array<[string, Promise<unknown>]> = [
		["viewer below the root, whatever the subject already has", checkGrant(d, file, "viewer", { kind: "user", id: "max" })],
		["viewer below the root for one who already sees it", checkGrant(d, file, "viewer", { kind: "user", id: "lea" })],
		["an unknown relation", checkGrant(d, root, "reader", { kind: "user", id: "max" })],
		["an unknown subject", checkGrant(d, root, "editor", { kind: "user", id: "nobody" })],
		["a deleted subject", checkGrant(d, root, "editor", { kind: "user", id: "gone" })],
		["an agent that is a user", checkGrant(d, root, "editor", { kind: "agent", id: "lea" })],
		["a group as its own member", checkMembership(d, "north", { kind: "group", id: "north", relation: "member" })],
		["a deleted member", checkMembership(d, "north", { kind: "user", id: "gone" })],
		["a malformed group ID", checkMembership(d, "a/b", { kind: "user", id: "max" })],
		["an agent as tenant admin", Promise.resolve().then(() => checkShape(tuple("tenant:acme#admin@agent:planner-17")))],
		["a deleted tenant admin", checkTenantAdmin(d, "acme", "gone")],
	];
	for (const [name, p] of refused) await assert.rejects(p, InvalidInput, name);
	for (const t of ["group:north#owner@user:lea", "node:dispatch#editor@group:north", "node:dispatch#member@user:lea", "tenant:acme#owner@user:lea", "other:x#viewer@user:lea"])
		assert.throws(() => checkShape(tuple(t)), InvalidInput, t);
});

test("the final owner and the final administrator", async () => {
	const w = world(NODES, [...BASE, "node:dispatch#owner@group:north#member", "node:lea#owner@user:off"], ACTORS);
	const d = data(w), root = idOf("dispatch");
	const planner = tuple("node:dispatch#owner@agent:planner-17");
	// a group owner does not count: revoking the one enabled direct owner breaks the rule
	await assert.rejects(checkLastOwner(d, root, { remove: [planner] }), LastOwner);
	await assert.rejects(checkLastOwner(d, root, { disable: [ref("agent:planner-17")] }), LastOwner);
	// a replacement in the same change keeps it
	await checkLastOwner(d, root, { remove: [planner], add: [tuple("node:dispatch#owner@user:max")] });
	// a disabled direct owner does not count either; a replacement that is being disabled neither
	await assert.rejects(checkLastOwner(d, idOf("lea"), { remove: [tuple("node:lea#owner@user:lea")] }), LastOwner);
	await assert.rejects(checkLastOwner(d, root, { remove: [planner], add: [tuple("node:dispatch#owner@user:max")], disable: [ref("user:max")] }), LastOwner);
	await checkLastOwner(d, root, {});

	await assert.rejects(checkLastAdmin(d, "acme", { remove: [tuple("tenant:acme#admin@user:root")] }), LastAdmin);
	await assert.rejects(checkLastAdmin(d, "acme", { disable: [ref("user:root")] }), LastAdmin);
	await checkLastAdmin(d, "acme", { remove: [tuple("tenant:acme#admin@user:root")], add: [tuple("tenant:acme#admin@user:max")] });
	const w2 = world(NODES, [...BASE, "tenant:acme#admin@user:off"], ACTORS);
	await assert.rejects(checkLastAdmin(data(w2), "acme", { remove: [tuple("tenant:acme#admin@user:root")] }), LastAdmin, "a disabled admin does not count");
});

test("groups exist while a relation names them, also after the last member is removed", async () => {
	const w = world(NODES, BASE, ACTORS);
	assert.deepEqual(groupsIn(w.rels), ["north"]);
	assert.deepEqual(await membersOf(data(w), "north"), [{ kind: "user", id: "lea" }]);
	const noMembers = w.rels.filter((r) => !(r.objectKind === "group" && r.subjectId === "lea"));
	assert.deepEqual(groupsIn(noMembers), ["north"], "the grant still names north");
	assert.deepEqual(await membersOf(data({ ...w, rels: noMembers }), "north"), []);
	assert.deepEqual(groupsIn(noMembers.filter((r) => r.subjectKind !== "group")), [], "with no relation left the group is gone");
	assert.deepEqual(groupsIn([tuple("group:south#member@user:max"), tuple("node:lea#editor@group:east#member")]), ["east", "south"]);
});

test("corrupt graphs are inconsistentState, deep and costly ones capacityExceeded", async () => {
	const base = world(NODES, BASE, ACTORS);
	const planner = ref("agent:planner-17");
	const withNodes = (f: (n: NodeRow[]) => NodeRow[]) => data({ ...base, nodes: f(base.nodes.map((n) => ({ ...n }))) });
	// a cycle: inbox's parent is a.md's ... made a two-node loop
	const loop = withNodes((ns) => { ns.find((n) => n.nodeId === idOf("dispatch/inbox"))!.parentId = idOf("dispatch/inbox/a.md"); ns.find((n) => n.nodeId === idOf("dispatch/inbox/a.md"))!.kind = "dir"; return ns; });
	await assert.rejects(roleOn(loop, planner, idOf("dispatch/inbox/a.md")), InconsistentState, "a cycle");
	const self = withNodes((ns) => { ns.find((n) => n.nodeId === idOf("dispatch/inbox"))!.parentId = idOf("dispatch/inbox"); return ns; });
	await assert.rejects(roleOn(self, planner, idOf("dispatch/inbox")), InconsistentState, "its own parent");
	const orphan = withNodes((ns) => ns.filter((n) => n.nodeId !== idOf("dispatch/inbox")));
	await assert.rejects(roleOn(orphan, planner, idOf("dispatch/inbox/a.md")), InconsistentState, "a missing parent");
	await assert.rejects(roleOn(orphan, planner, "id:nothing"), InconsistentState, "a missing node");
	const fileParent = withNodes((ns) => { ns.find((n) => n.nodeId === idOf("dispatch/inbox/a.md"))!.parentId = idOf("dispatch/brief.md"); return ns; });
	await assert.rejects(roleOn(fileParent, planner, idOf("dispatch/inbox/a.md")), InconsistentState, "a file as parent");
	const dup = withNodes((ns) => [...ns, { nodeId: "id:other", parentId: idOf("dispatch"), name: "brief.md", kind: "file" }]);
	await assert.rejects(resolve(dup, planner, "dispatch", ["brief.md"]), InconsistentState, "two children of one name");
	const fileRoot = withNodes((ns) => { ns.find((n) => n.nodeId === idOf("dispatch"))!.kind = "file"; return ns; });
	await assert.rejects(resolve(fileRoot, planner, "dispatch", []), InconsistentState, "a root that is a file");
	// the diagnostics carry IDs, never names
	await resolve(dup, planner, "dispatch", ["brief.md"]).catch((e: Error) => assert.ok(!e.message.includes("brief"), e.message));

	// deep: a chain longer than a path may be; a short cycle still reads as a cycle at a tiny depth bound
	const deep = Array.from({ length: 40 }, (_, i) => "dispatch/" + Array.from({ length: i + 1 }, () => "d").join("/") + "/");
	const dw = world(["dispatch/", ...deep], BASE, ACTORS);
	await assert.rejects(roleOn(data(dw), planner, idOf(deep.at(-1)!)), CapacityExceeded);
	await assert.rejects(roleOn(self, planner, idOf("dispatch/inbox"), { limits: { maxPathDepth: 1, maxWorkPerDecision: 512, maxGrantsPerTarget: 64, maxGroups: 200 } }), InconsistentState);
	// costly: more lookups than one decision may make
	const many = world(NODES, [...BASE, ...Array.from({ length: 300 }, (_, i) => `node:dispatch#editor@user:u${i}`)], ACTORS);
	await assert.rejects(resolve(data(many), planner, "dispatch", ["inbox", "a.md"], { limits: { maxWorkPerDecision: 100, maxPathDepth: 32, maxGrantsPerTarget: 1000, maxGroups: 200 } }), CapacityExceeded);
	assert.equal((await resolve(data(many), planner, "dispatch", ["inbox", "a.md"], { limits: { maxWorkPerDecision: 1000, maxPathDepth: 32, maxGrantsPerTarget: 1000, maxGroups: 200 } })).role, "owner");
});

test("a bounded read never decides on a partial list", async () => {
	const L = { maxGrantsPerTarget: 4, maxActors: 70, maxWorkPerDecision: 10_000 };
	// the actor's own grant comes last, after more grants than a target may hold
	const crowded = world(NODES, [...BASE, ...Array.from({ length: 4 }, (_, i) => `node:lea#editor@user:u${i}`), "node:lea#viewer@user:max"], ACTORS);
	await assert.rejects(resolve(data(crowded), ref("user:max"), "lea", [], { limits: L }), CapacityExceeded);
	await assert.rejects(roleOn(data(crowded), ref("user:max"), idOf("lea"), { limits: L }), CapacityExceeded);
	await assert.rejects(checkLastOwner(data(crowded), idOf("lea"), {}, { limits: L }), CapacityExceeded);
	// a group may have more members than a target has grants, up to the actor bound
	const members = Array.from({ length: 70 }, (_, i) => `group:big#member@user:m${i}`);
	assert.equal((await membersOf(data(world(NODES, members, ACTORS)), "big", { limits: L })).length, 70);
	await assert.rejects(membersOf(data(world(NODES, [...members, "group:big#member@user:one-more"], ACTORS)), "big", { limits: L }), CapacityExceeded);
	// an actor in more groups than the tenant may have
	const groups = world(NODES, [...BASE, ...Array.from({ length: 3 }, (_, i) => `group:g${i}#member@user:lea`)], ACTORS);
	await assert.rejects(resolve(data(groups), ref("user:lea"), "lea", [], { limits: { maxGroups: 3 } }), CapacityExceeded);
	// a root that is a file, reached by ID
	const fileRoot = world(["dispatch", ...NODES.slice(1)], BASE, ACTORS);
	await assert.rejects(roleOn(data(fileRoot), ref("agent:planner-17"), idOf("dispatch")), InconsistentState);
});
