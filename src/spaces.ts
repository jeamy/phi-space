// Named spaces (doc version 5). The session singleton `Space` stays the default space, so existing host code keeps
// working; further spaces are members of a session document family keyed by their immutable spaceId. The registry
// maps aliases to ids and holds this host's identity. Ids are generated here, never taken from callers.
import { randomBytes, randomUUID } from "node:crypto";
import type { Context } from "@earendil-works/chord";
import { defineDoc, defineDocFamily, type Session, type Tx } from "@earendil-works/pi-durable";
import * as core from "./core.ts";
import { Space } from "./doc.ts";

export const DEFAULT_ALIAS = "default";
const ALIAS = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type SpaceInfo = { spaceId: string; alias: string; incarnation: string; createdAt: number };
export type RegistryState = {
	hostId: string | null;
	defaultSpaceId: string | null;
	spaces: Record<string, SpaceInfo>; // by spaceId, including the default space
	aliases: Record<string, string>; // alias -> spaceId
};

export const Registry = defineDoc<RegistryState>({
	kind: "pi-spaces.registry",
	version: 1,
	scope: "session",
	initial: () => ({ hostId: null, defaultSpaceId: null, spaces: {}, aliases: {} }),
});

/** Named spaces other than the default one. The key is the spaceId. */
export const NamedSpace = defineDocFamily<core.SpaceState & Record<string, any>, null>({
	kind: "pi-spaces.named-space",
	version: 5,
	scope: "session",
	family: true,
	initial: () => core.initialState() as core.SpaceState & Record<string, any>,
	migrate: (v, from) => core.migrate(v, from) as core.SpaceState & Record<string, any>,
});

export class UnknownSpaceError extends Error {}

/** A fresh incarnation id: 8 hex digits, random (also part of local ids, which stay plain words for models). */
export const newIncarnation = (): string => randomBytes(4).toString("hex");
const newSpaceId = (): string => `sp-${randomUUID()}`;

/** The registry with this host's id and the default space registered; creates both on first use. */
async function registry(tx: Tx, now: number): Promise<RegistryState> {
	const r = await tx.doc(Registry);
	if (r.hostId === null) r.hostId = `host-${randomUUID()}`;
	if (r.defaultSpaceId === null) {
		const d = await tx.doc(Space);
		const info: SpaceInfo = { spaceId: d.spaceId ?? newSpaceId(), alias: DEFAULT_ALIAS, incarnation: d.incarnation ?? newIncarnation(), createdAt: now };
		d.spaceId = info.spaceId;
		d.incarnation = info.incarnation;
		r.defaultSpaceId = info.spaceId;
		r.spaces[info.spaceId] = info;
		r.aliases[DEFAULT_ALIAS] = info.spaceId;
	}
	return r as RegistryState;
}

/** spaceId for an alias or an id; undefined means the default space. */
export async function resolveSpaceId(tx: Tx, space: string | undefined, now: number): Promise<string> {
	const r = await registry(tx, now);
	if (space === undefined) return r.defaultSpaceId!;
	const id = r.aliases[space] ?? (r.spaces[space] ? space : undefined);
	if (id === undefined) throw new UnknownSpaceError(`unknown space: ${space}`);
	return id;
}

/** The document of a space inside a commit. */
export async function spaceDoc(tx: Tx, space: string | undefined, now: number): Promise<core.SpaceState> {
	const id = await resolveSpaceId(tx, space, now);
	const r = await tx.doc(Registry);
	const d = id === r.defaultSpaceId ? await tx.doc(Space) : await tx.doc(NamedSpace, id, null);
	// A document draft is the same object in every commit, so it cannot tell commits apart: fetching the document is the
	// start of a commit's work on it, and its changes belong to one new revision (stream.ts).
	core.seal(d);
	return d;
}

/**
 * Create a named space, or return the existing one with this alias (idempotent per alias). Its spaceId is generated
 * and stays fixed; the alias is only a name.
 */
export async function createSpace(tx: Tx, alias: string, now: number): Promise<SpaceInfo> {
	if (typeof alias !== "string" || !ALIAS.test(alias)) throw new core.IllegalArgumentError("alias: 1-64 of a-z 0-9 . _ - (starting with a letter or digit)");
	const r = await registry(tx, now);
	const known = r.aliases[alias];
	if (known !== undefined) return core.plain(r.spaces[known]!);
	const info: SpaceInfo = { spaceId: newSpaceId(), alias, incarnation: newIncarnation(), createdAt: now };
	const d = await tx.doc(NamedSpace, info.spaceId, null);
	d.spaceId = info.spaceId;
	d.incarnation = info.incarnation;
	r.spaces[info.spaceId] = info;
	r.aliases[alias] = info.spaceId;
	return { ...info };
}

/** Every registered space (default first). Read-only; an untouched session has none registered yet. */
export async function listSpaces(host: Pick<Session, "snapshot">, ctx: Context): Promise<SpaceInfo[]> {
	const r = await host.snapshot(Registry, ctx);
	if (!r) return [];
	const all = Object.values(r.spaces).map((i) => ({ ...i }));
	return all.sort((a, b) => (a.spaceId === r.defaultSpaceId ? -1 : b.spaceId === r.defaultSpaceId ? 1 : a.createdAt - b.createdAt));
}

/** Read a space's committed state without a commit; undefined if it does not exist (yet). */
export async function snapshotSpace(host: Pick<Session, "snapshot">, spaceId: string, ctx: Context): Promise<Readonly<core.SpaceState> | undefined> {
	const r = await host.snapshot(Registry, ctx);
	if (r && spaceId === r.defaultSpaceId) return host.snapshot(Space, ctx);
	if (r && !r.spaces[spaceId]) return undefined;
	return host.snapshot(NamedSpace, spaceId, ctx);
}
