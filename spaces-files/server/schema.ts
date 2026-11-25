// The minimal schema of a tenant Space (docs/zanzibar-agent-filesystem-plan.en.md, section 3): the entry types, their
// creation keys, the canonical names and identifiers, and the builders every creation path uses, so that provisioning
// and later registrations declare the same uniqueness key per type.
import { randomBytes } from "node:crypto";
import type { EntryDraft } from "phi-spaces/core";

export const SCHEMA_VERSION = 1;
export const FORMAT_VERSION = 1;

/** Entry types and their creation keys (section 3). Every write of a new row of a type names exactly this key. */
export const T = {
	meta: "FsMeta",
	actor: "FsActor",
	node: "FsNode",
	relation: "FsRelation",
	audit: "FsAudit",
} as const;
export const KEY: Record<(typeof T)[keyof typeof T], string[]> = {
	FsMeta: ["tenantId"],
	FsActor: ["actorKind", "actorId"],
	FsNode: ["parentId", "name"],
	FsRelation: ["objectKind", "objectId", "relation", "subjectKind", "subjectId", "subjectRelation"],
	FsAudit: ["seq"],
};

/** The parent of every workspace root: no node ID has this form, so workspace names are unique per tenant. */
export const WORKSPACES = "#workspaces";
/** The stored subjectRelation of a direct subject. */
export const DIRECT = "";

export type ActorKind = "user" | "agent";
export type UserIdentity = { issuer: string; subject: string };
export type AgentIdentity = { enrolledHostPeerId: string; agentId: string };

export class InvalidInput extends Error {
	readonly code = "invalidInput";
	constructor(message: string) { super(message); this.name = "InvalidInput"; }
}

/** Actor IDs and agent IDs: 1 to 128 of A-Z a-z 0-9 _ . : - (the agent frame's rule, section 2). */
const ACTOR_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export function actorId(id: unknown, what = "actor ID"): string {
	if (typeof id !== "string" || !ACTOR_ID.test(id)) throw new InvalidInput(`invalid ${what} ${JSON.stringify(id)}`);
	return id;
}

const MAX_NAME_BYTES = 255;
/** A workspace, home or path segment name in its canonical form: NFC, no separators, dots, controls or empty names. */
export function canonicalName(name: unknown): string {
	if (typeof name !== "string") throw new InvalidInput("a name must be a string");
	if (!name.isWellFormed()) throw new InvalidInput("a name must be well-formed Unicode");
	const n = name.normalize("NFC");
	if (n === "" || n === "." || n === "..") throw new InvalidInput(`invalid name ${JSON.stringify(name)}`);
	if (/[/\\\p{Cc}]/u.test(n)) throw new InvalidInput(`invalid name ${JSON.stringify(name)}: separators and control characters are not allowed`);
	if (Buffer.byteLength(n, "utf8") > MAX_NAME_BYTES) throw new InvalidInput(`a name has at most ${MAX_NAME_BYTES} bytes`);
	return n;
}

/** A verified identity string (issuer, subject, enrolled host peer): non-empty, bounded, no control characters. */
export function identityPart(v: unknown, what: string): string {
	if (typeof v !== "string" || v === "" || v.length > 512 || /\p{Cc}/u.test(v) || !v.isWellFormed()) throw new InvalidInput(`invalid ${what}`);
	return v;
}

/** A fresh collision-resistant node ID (128 random bits); the caller checks it against the tenant's nodes in the queue. */
export const newNodeId = (): string => randomBytes(16).toString("base64url");

export const meta = (tenantId: string): EntryDraft =>
	({ type: T.meta, fields: { tenantId, schemaVersion: SCHEMA_VERSION, formatVersion: FORMAT_VERSION } });

export function actor(kind: ActorKind, id: string, homeNodeId: string, identity: UserIdentity | AgentIdentity): EntryDraft {
	const ident: Record<string, string> = kind === "user"
		? { issuer: (identity as UserIdentity).issuer, subject: (identity as UserIdentity).subject }
		: { enrolledHostPeerId: (identity as AgentIdentity).enrolledHostPeerId, agentId: (identity as AgentIdentity).agentId };
	return { type: T.actor, fields: { actorKind: kind, actorId: id, state: "enabled", homeNodeId, ...ident } };
}

export const node = (nodeId: string, parentId: string, name: string, kind: "dir" | "file"): EntryDraft =>
	({ type: T.node, fields: { nodeId, parentId, name, kind } });

export const relation = (objectKind: "tenant" | "node", objectId: string, rel: string, subjectKind: string, subjectId: string, subjectRelation = DIRECT): EntryDraft =>
	({ type: T.relation, fields: { objectKind, objectId, relation: rel, subjectKind, subjectId, subjectRelation } });

export type AuditActor = { kind: ActorKind | "operator" | "recoverer"; id: string };
export const audit = (seq: number, time: number, by: AuditActor, operation: string, targets: string[], operationId: string, outcome: string): EntryDraft =>
	({ type: T.audit, fields: { seq, time, actorKind: by.kind, actorId: by.id, operation, targets, operationId, outcome } });
