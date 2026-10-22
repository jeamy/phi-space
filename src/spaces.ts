// Named spaces (doc version 5). The session singleton `Space` stays the default space, so existing host code keeps
// working; further spaces are members of a session document family keyed by their immutable spaceId. The registry
// maps aliases to ids and holds this host's identity. Ids are generated here, never taken from callers.
import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "./context.ts";
import type { StoreHost, StoreTx } from "./store/types.ts";
import { defineDoc, defineDocFamily } from "./store/documents.ts";
import * as core from "./core.ts";
import { Space, SPACE_PARTS, checkpointDue } from "./doc.ts";

export const DEFAULT_ALIAS = "default";
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** `deletedAt`: a deleted Space keeps its id reserved (never reused) but is neither resolved nor listed. */
export type SpaceInfo = { spaceId: string; alias: string; incarnation: string; createdAt: number; deletedAt?: number };
export type RegistryState = {
	hostId: string | null;
	hostKey?: string;
	defaultSpaceId: string | null;
	spaces: Record<string, SpaceInfo>; // by spaceId, including the default space
	aliases: Record<string, string>; // alias -> spaceId
};

export const Registry = defineDoc<RegistryState>({
	kind: "phi-spaces.registry",
	version: 1,
	scope: "session",
	initial: () => ({ hostId: null, defaultSpaceId: null, spaces: {}, aliases: {} }),
});

/** Named spaces other than the default one. The key is the spaceId. */
export const NamedSpace = defineDocFamily<core.SpaceState & Record<string, any>, null>({
	kind: "phi-spaces.named-space",
	version: 5,
	scope: "session",
	family: true,
	initial: () => core.initialState() as core.SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as core.SpaceState & Record<string, any>,
	// Same rule as doc.ts Space (every 500 deltas, only while the base fits one commit).
	checkpointWhen: (v, _ops, info) => checkpointDue(v, info),
	parts: SPACE_PARTS,
});

export class UnknownSpaceError extends Error {}

/** A fresh incarnation id: 8 hex digits, random (also part of local ids, which stay plain words for models). */
export const newIncarnation = (): string => randomBytes(4).toString("hex");
const newSpaceId = (): string => `sp-${randomUUID()}`;

/** The registry with this host's id and the default space registered; creates both on first use. */
async function registry(tx: StoreTx, now: number): Promise<RegistryState> {
	const r = await tx.doc(Registry);
	if (r.hostId === null) r.hostId = `host-${randomUUID()}`;
	if (!r.hostKey) r.hostKey = randomBytes(32).toString("hex");
	if (r.defaultSpaceId === null) {
		const d = await tx.doc(Space);
		const info: SpaceInfo = { spaceId: d.spaceId ?? newSpaceId(), alias: DEFAULT_ALIAS, incarnation: d.incarnation ?? newIncarnation(), createdAt: now };
		openDocument(tx, info.spaceId, d); core.touch(d, now);
		d.spaceId = info.spaceId;
		d.incarnation = info.incarnation;
		r.defaultSpaceId = info.spaceId;
		r.spaces[info.spaceId] = info;
		r.aliases[DEFAULT_ALIAS] = info.spaceId;
	}
	return r as RegistryState;
}

/** spaceId for an alias or an id; undefined means the default space. */
export async function resolveSpaceId(tx: StoreTx, space: string | undefined, now: number): Promise<string> {
	const r = await registry(tx, now);
	if (space === undefined) return r.defaultSpaceId!;
	const id = r.aliases[space] ?? (r.spaces[space] && !r.spaces[space]!.deletedAt ? space : undefined);
	if (id === undefined) throw new UnknownSpaceError(`unknown space: ${space}`);
	return id;
}

/** The document of a space inside a commit. */
const touched = new WeakMap<StoreTx, Set<string>>();
function openDocument(tx: StoreTx, id: string, d: core.SpaceState): void {
	let seen = touched.get(tx); if (!seen) { seen = new Set(); touched.set(tx, seen); }
	if (!seen.has(id)) { core.beginCommit(d); seen.add(id); }
}
export async function spaceDoc(tx: StoreTx, space: string | undefined, now: number): Promise<core.SpaceState> {
	const id = await resolveSpaceId(tx, space, now);
	const r = await tx.doc(Registry);
	const d = id === r.defaultSpaceId ? await tx.doc(Space) : await tx.doc(NamedSpace, id, null);
	openDocument(tx, id, d);
	return d;
}

/** A persisted host key; never exposed through the space protocol, entry snapshots or change streams. */
export async function hostKey(tx: StoreTx, now: number): Promise<string> { return (await registry(tx, now)).hostKey!; }

/**
 * Create a named space, or return the existing one with this alias (idempotent per alias). Its spaceId is generated
 * and stays fixed; the alias is only a name.
 */
/**
 * `fixed`: a provisioned identity, for a primary/sync Space whose ID and data incarnation are bound in the replica
 * configuration before its first commit (the standby receives the same Space through replication).
 */
export async function createSpace(tx: StoreTx, alias: string, now: number, fixed?: { spaceId: string; incarnation: string }): Promise<SpaceInfo> {
	if (typeof alias !== "string" || !ALIAS.test(alias)) throw new core.IllegalArgumentError("alias: 1-64 of a-z 0-9 . _ - (starting with a letter or digit)");
	if (fixed && (!/^sp-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(fixed.spaceId) || !/^[0-9a-f]{8}$/.test(fixed.incarnation))) throw new core.IllegalArgumentError("a fixed Space identity needs an sp-<uuid> ID and an 8-hex incarnation");
	const r = await registry(tx, now);
	const known = r.aliases[alias];
	if (known !== undefined) {
		if (fixed && (known !== fixed.spaceId || r.spaces[known]!.incarnation !== fixed.incarnation)) throw new core.IllegalArgumentError("alias names another Space identity");
		return core.plain(r.spaces[known]!);
	}
	if (fixed && r.spaces[fixed.spaceId]) throw new core.IllegalArgumentError("Space ID already registered under another alias");
	const info: SpaceInfo = { spaceId: fixed?.spaceId ?? newSpaceId(), alias, incarnation: fixed?.incarnation ?? newIncarnation(), createdAt: now };
	const d = await tx.doc(NamedSpace, info.spaceId, null);
	openDocument(tx, info.spaceId, d); core.touch(d, now);
	d.spaceId = info.spaceId;
	d.incarnation = info.incarnation;
	r.spaces[info.spaceId] = info;
	r.aliases[alias] = info.spaceId;
	return { ...info };
}

/** Every registered space (default first). Read-only; an untouched session has none registered yet. */
export async function listSpaces(host: Pick<StoreHost, "snapshot">, ctx: Context): Promise<SpaceInfo[]> {
	const r = await host.snapshot(Registry, ctx);
	if (!r) return [];
	const all = Object.values(r.spaces).filter((i) => !i.deletedAt).map((i) => ({ ...i }));
	return all.sort((a, b) => (a.spaceId === r.defaultSpaceId ? -1 : b.spaceId === r.defaultSpaceId ? 1 : a.createdAt - b.createdAt));
}

/** Read a space's committed state without a commit; undefined if it does not exist (yet). */
export async function snapshotSpace(host: Pick<StoreHost, "snapshot">, spaceId: string, ctx: Context): Promise<Readonly<core.SpaceState> | undefined> {
	const r = await host.snapshot(Registry, ctx);
	if (r && spaceId === r.defaultSpaceId) return host.snapshot(Space, ctx);
	if (r && (!r.spaces[spaceId] || r.spaces[spaceId]!.deletedAt)) return undefined;
	return host.snapshot(NamedSpace, spaceId, ctx);
}
