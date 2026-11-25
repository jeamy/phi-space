// Relationship evaluation (docs/zanzibar-agent-filesystem-plan.en.md, section 4): the typed relation validator, the
// evaluator of effective rights with its work budget, the final-owner and final-admin invariants and the derived
// group listings. Everything here reads through `PolicyData` and writes nothing; `spaceData` is the tenant Space's.
//
// Rights: a role comes from a direct grant on a node, a grant to a group the actor belongs to, or either on an
// ancestor up to the workspace root, along the parent recorded on FsNode. Effective rights are the union. Visibility
// is decided per workspace: a node is reachable exactly when the actor holds a role on the workspace root; grants
// below the root only raise viewer to editor or owner and are inert while the root is invisible. Disabled actors hold
// no rights and their memberships count for nothing. `tenant#admin` gives no file rights.
import type { PhiSpaces } from "phi-spaces";
import { DEFAULT_FS_LIMITS, type FsLimits } from "./limits.ts";
import {
	CapacityExceeded, DIRECT, InconsistentState, InvalidInput, LastAdmin, LastOwner, NotFound, T, WORKSPACES,
	type ActorKind, groupId,
} from "./schema.ts";

export type Role = "viewer" | "editor" | "owner";
const RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 };
export const atLeast = (have: Role | null, need: Role): boolean => have !== null && RANK[have] >= RANK[need];
const max = (a: Role | null, b: Role | null): Role | null => a === null ? b : b === null ? a : RANK[a] >= RANK[b] ? a : b;

export type NodeRow = { nodeId: string; parentId: string; name: string; kind: "dir" | "file" };
export type RelRow = { objectKind: string; objectId: string; relation: string; subjectKind: string; subjectId: string; subjectRelation: string };
export type ActorRow = { actorKind: ActorKind; actorId: string; state: "enabled" | "disabled" | "deleted" };
export type ActorRef = { actorKind: ActorKind; actorId: string };
/** A grant or membership subject: a user or agent instance, or the members of a group. */
export type Subject = { kind: ActorKind; id: string } | { kind: "group"; id: string; relation: "member" };

/** What the evaluator reads; each call costs one unit of work plus one per row returned. */
export interface PolicyData {
	node(nodeId: string): Promise<NodeRow | null>;
	/** The nodes named `name` under `parentId`, at most `limit` (2 reveals a duplicate). */
	children(parentId: string, name: string, limit: number): Promise<NodeRow[]>;
	relationsOn(objectKind: string, objectId: string, limit: number): Promise<RelRow[]>;
	/** The groups whose member the subject is, at most `limit`. */
	groupsOf(kind: ActorKind, id: string, limit: number): Promise<string[]>;
	actor(kind: string, id: string): Promise<ActorRow | null>;
}

/** Counts the lookups of one decision against `maxWorkPerDecision` (`capacityExceeded` beyond it). */
export class Work {
	#used = 0;
	readonly max: number;
	constructor(max: number) { this.max = max; }
	spend(n: number): void { this.#used += n; if (this.#used > this.max) throw new CapacityExceeded(`a decision needs more than ${this.max} lookups`); }
	get used(): number { return this.#used; }
	/** How many rows one more lookup may still return before the budget is gone. */
	get left(): number { return Math.max(0, this.max - this.#used); }
}

/** Wraps data so that every lookup is charged; a lookup that would return more than the budget allows fails. */
function charged(d: PolicyData, w: Work): PolicyData {
	const rows = <R>(r: R[]): R[] => { w.spend(r.length); return r; };
	return {
		node: async (id) => { w.spend(1); return d.node(id); },
		children: async (p, n, l) => { w.spend(1); return rows(await d.children(p, n, l)); },
		relationsOn: async (k, id, l) => { w.spend(1); return rows(await d.relationsOn(k, id, Math.min(l, w.left + 1))); },
		groupsOf: async (k, id, l) => { w.spend(1); return rows(await d.groupsOf(k, id, Math.min(l, w.left + 1))); },
		actor: async (k, id) => { w.spend(1); return d.actor(k, id); },
	};
}

export type Options = { limits?: Pick<FsLimits, "maxWorkPerDecision" | "maxPathDepth" | "maxGrantsPerTarget" | "maxGroups">; work?: Work };
const lim = (o: Options) => ({ ...DEFAULT_FS_LIMITS, ...o.limits });
const workOf = (o: Options) => o.work ?? new Work(lim(o).maxWorkPerDecision);

/** The subject keys an actor acts as: itself and, while enabled, each group it belongs to. Empty when not enabled. */
async function subjectsOf(d: PolicyData, a: ActorRef, o: Options): Promise<Set<string>> {
	const row = await d.actor(a.actorKind, a.actorId);
	if (row === null || row.state !== "enabled") return new Set();
	const keys = new Set([`${a.actorKind}:${a.actorId}`]);
	for (const g of await d.groupsOf(a.actorKind, a.actorId, lim(o).maxGroups + 1)) keys.add(`group:${g}#member`);
	return keys;
}

const subjectKey = (r: RelRow): string => r.subjectKind === "group" ? `group:${r.subjectId}#${r.subjectRelation}` : `${r.subjectKind}:${r.subjectId}`;

/** The highest role the subjects hold by grants directly on one node. */
async function directRole(d: PolicyData, nodeId: string, subjects: Set<string>, o: Options): Promise<Role | null> {
	let role: Role | null = null;
	for (const r of await d.relationsOn("node", nodeId, lim(o).maxGrantsPerTarget + 1))
		if (r.relation in RANK && subjects.has(subjectKey(r))) role = max(role, r.relation as Role);
	return role;
}

export type Resolved = { root: NodeRow; node: NodeRow; parent: NodeRow | null; role: Role };

async function only(d: PolicyData, parentId: string, name: string): Promise<NodeRow | null> {
	const found = await d.children(parentId, name, 2);
	if (found.length > 1) throw new InconsistentState(`two nodes share one name under ${parentId}`);
	const n = found[0] ?? null;
	if (n !== null && n.parentId !== parentId) throw new InconsistentState(`node ${n.nodeId} is not under ${parentId}`);
	return n;
}

/**
 * Resolves a workspace and canonical path segments for an actor (section 5, order of checks step 6): an absent or
 * invisible workspace or node is `notFound`; walking through a file is `invalidInput` (the file is visible); the result
 * carries the effective role on the target. `[]` resolves the root.
 */
export async function resolve(data: PolicyData, actor: ActorRef, workspace: string, segments: readonly string[], o: Options = {}): Promise<Resolved> {
	const d = charged(data, workOf(o));
	const subjects = await subjectsOf(d, actor, o);
	if (subjects.size === 0) throw new NotFound();
	const root = await only(d, WORKSPACES, workspace);
	if (root === null) throw new NotFound();
	if (root.kind !== "dir") throw new InconsistentState(`workspace root ${root.nodeId} is not a directory`);
	let role = await directRole(d, root.nodeId, subjects, o);
	if (role === null) throw new NotFound();          // the workspace is invisible
	let node = root, parent: NodeRow | null = null;
	for (const seg of segments) {
		if (node.kind !== "dir") throw new InvalidInput("a path goes through a file");
		const next = await only(d, node.nodeId, seg);
		if (next === null) throw new NotFound();
		parent = node; node = next;
		role = max(role, await directRole(d, node.nodeId, subjects, o))!;
	}
	return { root, node, parent, role };
}

/**
 * The effective role of an actor on a node named by its ID, walking the parent recorded on FsNode up to the workspace
 * root: a repeated parent or a missing one is `inconsistentState` (checked before the depth bound, so a short cycle
 * never reads as a capacity problem); more levels than a path may have is `capacityExceeded`. `null` when the
 * workspace is invisible to the actor.
 */
export async function roleOn(data: PolicyData, actor: ActorRef, nodeId: string, o: Options = {}): Promise<{ role: Role | null; chain: NodeRow[] }> {
	const d = charged(data, workOf(o));
	const chain: NodeRow[] = [];
	const seen = new Set<string>();
	let id = nodeId;
	for (;;) {
		if (seen.has(id)) throw new InconsistentState(`node ${id} is its own ancestor`);
		seen.add(id);
		const n = await d.node(id);
		if (n === null) throw new InconsistentState(chain.length === 0 ? `node ${id} is missing` : `the parent ${id} of node ${chain.at(-1)!.nodeId} is missing`);
		if (chain.length > 0 && n.kind !== "dir") throw new InconsistentState(`the parent ${id} is not a directory`);
		chain.push(n);
		if (n.parentId === WORKSPACES) break;
		if (chain.length > lim(o).maxPathDepth) throw new CapacityExceeded(`node ${nodeId} lies deeper than ${lim(o).maxPathDepth} levels`);
		id = n.parentId;
	}
	const subjects = await subjectsOf(d, actor, o);
	if (subjects.size === 0) return { role: null, chain };
	const root = chain.at(-1)!;
	let role = await directRole(d, root.nodeId, subjects, o);
	if (role === null) return { role: null, chain };
	for (const n of chain.slice(0, -1)) role = max(role, await directRole(d, n.nodeId, subjects, o));
	return { role, chain };
}

// --- validation -------------------------------------------------------------------------------------------------

/** The relation's shape against the table of section 4; IDs are taken canonical. */
export function checkShape(r: RelRow): void {
	const direct = (r.subjectKind === "user" || r.subjectKind === "agent") && r.subjectRelation === DIRECT;
	const groupMembers = r.subjectKind === "group" && r.subjectRelation === "member";
	if (r.objectKind === "tenant") { if (r.relation === "admin" && r.subjectKind === "user" && r.subjectRelation === DIRECT) return; }
	else if (r.objectKind === "group") { if (r.relation === "member" && direct) { groupId(r.objectId); return; } }
	else if (r.objectKind === "node") { if (r.relation in RANK && (direct || groupMembers)) { if (groupMembers) groupId(r.subjectId); return; } }
	throw new InvalidInput(`invalid relation ${r.objectKind}#${r.relation}@${r.subjectKind}${r.subjectRelation ? "#" + r.subjectRelation : ""}`);
}

export const subjectRow = (s: Subject): Pick<RelRow, "subjectKind" | "subjectId" | "subjectRelation"> =>
	s.kind === "group" ? { subjectKind: "group", subjectId: groupId(s.id), subjectRelation: "member" } : { subjectKind: s.kind, subjectId: s.id, subjectRelation: DIRECT };

/** A user or agent subject must exist and not be deleted; disabled is allowed (its grants stay inert). */
async function checkSubject(d: PolicyData, r: Pick<RelRow, "subjectKind" | "subjectId">): Promise<void> {
	if (r.subjectKind === "group") return;
	const a = await d.actor(r.subjectKind, r.subjectId);
	if (a === null || a.state === "deleted") throw new InvalidInput(`unknown or deleted subject ${r.subjectKind}:${r.subjectId}`);
}

/** A grant on a node: its shape, no viewer below the workspace root (redundant by structure), a live subject. */
export async function checkGrant(data: PolicyData, target: NodeRow, relation: string, subject: Subject): Promise<RelRow> {
	const r: RelRow = { objectKind: "node", objectId: target.nodeId, relation, ...subjectRow(subject) };
	checkShape(r);
	if (relation === "viewer" && target.parentId !== WORKSPACES) throw new InvalidInput("a viewer grant below the workspace root is redundant");
	await checkSubject(data, r);
	return r;
}

/** A group membership: a user or agent instance (no nested groups), existing and not deleted. */
export async function checkMembership(data: PolicyData, group: string, subject: Subject): Promise<RelRow> {
	const r: RelRow = { objectKind: "group", objectId: groupId(group), relation: "member", ...subjectRow(subject) };
	checkShape(r);
	await checkSubject(data, r);
	return r;
}

/** A tenant-administrator grant: an existing, not deleted user. */
export async function checkTenantAdmin(data: PolicyData, tenantId: string, userId: string): Promise<RelRow> {
	const r: RelRow = { objectKind: "tenant", objectId: tenantId, relation: "admin", subjectKind: "user", subjectId: userId, subjectRelation: DIRECT };
	checkShape(r);
	await checkSubject(data, r);
	return r;
}

// --- invariants -------------------------------------------------------------------------------------------------

/** A change the invariants are checked against: relations that go, relations that come, actors that stop being enabled. */
export type Change = { remove?: RelRow[]; add?: RelRow[]; disable?: ActorRef[] };
const same = (a: RelRow, b: RelRow) => a.objectKind === b.objectKind && a.objectId === b.objectId && a.relation === b.relation && a.subjectKind === b.subjectKind && a.subjectId === b.subjectId && a.subjectRelation === b.subjectRelation;

async function enabledAfter(d: PolicyData, kind: string, id: string, c: Change): Promise<boolean> {
	if (c.disable?.some((a) => a.actorKind === kind && a.actorId === id)) return false;
	return (await d.actor(kind, id))?.state === "enabled";
}

/** Every workspace root keeps a direct owner tuple whose subject is an enabled user or agent; group owners do not count. */
export async function checkLastOwner(data: PolicyData, rootNodeId: string, c: Change, o: Options = {}): Promise<void> {
	const d = charged(data, workOf(o));
	const after = [...(await d.relationsOn("node", rootNodeId, lim(o).maxGrantsPerTarget + 1)).filter((r) => !c.remove?.some((x) => same(x, r))),
		...(c.add ?? []).filter((r) => r.objectKind === "node" && r.objectId === rootNodeId)];
	for (const r of after)
		if (r.relation === "owner" && r.subjectRelation === DIRECT && r.subjectKind !== "group" && (await enabledAfter(d, r.subjectKind, r.subjectId, c))) return;
	throw new LastOwner(rootNodeId);
}

/** Every tenant keeps an enabled `tenant#admin` user. */
export async function checkLastAdmin(data: PolicyData, tenantId: string, c: Change, o: Options = {}): Promise<void> {
	const d = charged(data, workOf(o));
	const after = [...(await d.relationsOn("tenant", tenantId, lim(o).maxGrantsPerTarget + 1)).filter((r) => !c.remove?.some((x) => same(x, r))), ...(c.add ?? [])];
	for (const r of after)
		if (r.objectKind === "tenant" && r.relation === "admin" && r.subjectKind === "user" && (await enabledAfter(d, "user", r.subjectId, c))) return;
	throw new LastAdmin();
}

// --- groups -----------------------------------------------------------------------------------------------------

/** The groups of a tenant: every group named as a membership object or as a grant subject (no FsGroup rows). */
export function groupsIn(relations: Iterable<RelRow>): string[] {
	const g = new Set<string>();
	for (const r of relations) {
		if (r.objectKind === "group") g.add(r.objectId);
		if (r.subjectKind === "group") g.add(r.subjectId);
	}
	return [...g].sort();
}

export async function membersOf(data: PolicyData, group: string, o: Options = {}): Promise<Subject[]> {
	const rows = await charged(data, workOf(o)).relationsOn("group", groupId(group), lim(o).maxGrantsPerTarget + 1);
	return rows.map((r) => ({ kind: r.subjectKind as ActorKind, id: r.subjectId }))
		.sort((a, b) => a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// --- the tenant Space as policy data ----------------------------------------------------------------------------

const asNode = (f: Record<string, unknown>): NodeRow => ({ nodeId: f.nodeId as string, parentId: f.parentId as string, name: f.name as string, kind: f.kind as NodeRow["kind"] });
const asRel = (f: Record<string, unknown>): RelRow => ({ objectKind: f.objectKind as string, objectId: f.objectId as string, relation: f.relation as string, subjectKind: f.subjectKind as string, subjectId: f.subjectId as string, subjectRelation: f.subjectRelation as string });

/** Reads a tenant Space as policy data. Use it only inside the tenant's queue. */
export function spaceData(space: PhiSpaces): PolicyData {
	return {
		node: async (nodeId) => { const e = await space.readIfExists({ type: T.node, fields: { nodeId } }, 0); return e && asNode(e.fields); },
		children: async (parentId, name, limit) => (await space.readAll({ type: T.node, fields: { parentId, name } }, { limit })).map((e) => asNode(e.fields)),
		relationsOn: async (objectKind, objectId, limit) => (await space.readAll({ type: T.relation, fields: { objectKind, objectId } }, { limit })).map((e) => asRel(e.fields)),
		groupsOf: async (kind, id, limit) => (await space.readAll({ type: T.relation, fields: { objectKind: "group", relation: "member", subjectKind: kind, subjectId: id } }, { limit })).map((e) => e.fields.objectId as string),
		actor: async (kind, id) => { const e = await space.readIfExists({ type: T.actor, fields: { actorKind: kind, actorId: id } }, 0); return e && { actorKind: e.fields.actorKind as ActorKind, actorId: e.fields.actorId as string, state: e.fields.state as ActorRow["state"] }; },
	};
}

/** All groups of a tenant, bounded by `maxGroups`. */
export async function listGroups(space: PhiSpaces, o: Options = {}): Promise<string[]> {
	const rows = [...await space.readAll({ type: T.relation, fields: { objectKind: "group" } }), ...await space.readAll({ type: T.relation, fields: { subjectKind: "group" } })];
	const groups = groupsIn(rows.map((e) => asRel(e.fields)));
	if (groups.length > lim(o).maxGroups) throw new CapacityExceeded(`more than ${lim(o).maxGroups} groups`);
	return groups;
}
