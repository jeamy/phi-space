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
	content: "FsContent",
	receipt: "FsReceipt",
} as const;
export const KEY: Record<(typeof T)[keyof typeof T], string[]> = {
	FsMeta: ["tenantId"],
	FsActor: ["actorKind", "actorId"],
	FsNode: ["parentId", "name"],
	FsRelation: ["objectKind", "objectId", "relation", "subjectKind", "subjectId", "subjectRelation"],
	FsAudit: ["seq"],
	FsContent: ["nodeId"],
	FsReceipt: ["actorKind", "actorId", "operationId"],
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

/** A configured byte, depth, cardinality, work or quota limit is exceeded; admission stays open (sections 3 and 4). */
export class CapacityExceeded extends Error {
	readonly code = "capacityExceeded";
	constructor(message: string) { super(message); this.name = "CapacityExceeded"; }
}

/** A durable containment or schema invariant does not hold. The message names IDs and kinds, never names or text. */
export class InconsistentState extends Error {
	readonly code = "inconsistentState";
	constructor(message: string) { super(message); this.name = "InconsistentState"; }
}

/** Absent or invisible: the two are indistinguishable for ordinary operations (section 5). */
export class NotFound extends Error {
	readonly code = "notFound";
	constructor() { super("not found"); this.name = "NotFound"; }
}
export class LastOwner extends Error {
	readonly code = "lastOwner";
	constructor(nodeId: string) { super(`workspace root ${nodeId} would have no enabled direct owner`); this.name = "LastOwner"; }
}
export class LastAdmin extends Error {
	readonly code = "lastAdmin";
	constructor() { super("the tenant would have no enabled tenant#admin user"); this.name = "LastAdmin"; }
}

export class AlreadyExists extends Error {
	readonly code = "alreadyExists";
	constructor(message: string) { super(message); this.name = "AlreadyExists"; }
}
export class PermissionDenied extends Error {
	readonly code = "permissionDenied";
	constructor(message: string) { super(message); this.name = "PermissionDenied"; }
}
/** Unknown, disabled or deleted actors fail closed with this (section 2). */
export class Unauthenticated extends Error {
	readonly code = "unauthenticated";
	constructor(message = "unauthenticated") { super(message); this.name = "Unauthenticated"; }
}

/** Actor IDs and agent IDs: 1 to 128 of A-Z a-z 0-9 _ . : - (the agent frame's rule, section 2). */
const ACTOR_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export function actorId(id: unknown, what = "actor ID"): string {
	if (typeof id !== "string" || !ACTOR_ID.test(id)) throw new InvalidInput(`invalid ${what} ${JSON.stringify(id)}`);
	return id;
}

export const MAX_NAME_BYTES = 255;
/** A workspace, home or path segment name in its canonical form: NFC, no separators, dots, controls or empty names. */
export function canonicalName(name: unknown, maxBytes = MAX_NAME_BYTES): string {
	if (typeof name !== "string") throw new InvalidInput("a name must be a string");
	if (!name.isWellFormed()) throw new InvalidInput("a name must be well-formed Unicode");
	const n = name.normalize("NFC");
	if (n === "" || n === "." || n === "..") throw new InvalidInput(`invalid name ${JSON.stringify(name)}`);
	if (/[/\\\p{Cc}]/u.test(n)) throw new InvalidInput(`invalid name ${JSON.stringify(name)}: separators and control characters are not allowed`);
	if (Buffer.byteLength(n, "utf8") > maxBytes) throw new CapacityExceeded(`a name has at most ${maxBytes} bytes`);
	return n;
}

/** A verified identity string (issuer, subject, enrolled host peer): non-empty, bounded, no control characters. */
export function identityPart(v: unknown, what: string): string {
	if (typeof v !== "string" || v === "" || v.length > 512 || /\p{Cc}/u.test(v) || !v.isWellFormed()) throw new InvalidInput(`invalid ${what}`);
	return v;
}

/** The identity a caller supplies for a new actor, checked and in the stored form of its kind. */
export function identityOf(kind: ActorKind, identity: unknown): UserIdentity | AgentIdentity {
	const i = (identity ?? {}) as Record<string, unknown>;
	if (kind === "user") return { issuer: identityPart(i.issuer, "issuer"), subject: identityPart(i.subject, "subject") };
	if (kind === "agent") return { enrolledHostPeerId: identityPart(i.enrolledHostPeerId, "enrolled host peer"), agentId: actorId(i.agentId, "agent ID") };
	throw new InvalidInput(`unknown actor kind ${JSON.stringify(kind)}`);
}

/** The FsActor template that finds the one actor bound to an identity (the pair is unique per tenant and kind). */
export const identityTemplate = (kind: ActorKind, identity: UserIdentity | AgentIdentity) =>
	({ type: T.actor, fields: { actorKind: kind, ...(identity as Record<string, string>) } });

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

/** A group ID: the canonical form of a name (NFC, case-sensitive, the same syntax and byte limit, section 4). */
export const groupId = (id: unknown, maxBytes = MAX_NAME_BYTES): string => canonicalName(id, maxBytes);

export const relation = (objectKind: "tenant" | "group" | "node", objectId: string, rel: string, subjectKind: string, subjectId: string, subjectRelation = DIRECT): EntryDraft =>
	({ type: T.relation, fields: { objectKind, objectId, relation: rel, subjectKind, subjectId, subjectRelation } });

export const content = (nodeId: string, version: number, text: string): EntryDraft =>
	({ type: T.content, fields: { nodeId, version, text } });

export type ReceiptActorKind = ActorKind | "recoverer";
export const receipt = (actorKind: ReceiptActorKind, actorId: string, operationId: string, digest: string, outcome: Record<string, string | number | boolean | null>, expiry: number): EntryDraft =>
	({ type: T.receipt, fields: { actorKind, actorId, operationId, digest, outcome, expiry } });

export type AuditActor = { kind: ActorKind | "operator" | "recoverer"; id: string };
export const audit = (seq: number, time: number, by: AuditActor, operation: string, targets: string[], operationId: string, outcome: string): EntryDraft =>
	({ type: T.audit, fields: { seq, time, actorKind: by.kind, actorId: by.id, operation, targets, operationId, outcome } });
