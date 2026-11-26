// What the adapters share (docs/zanzibar-agent-filesystem-plan.en.md, section 5): the operations they offer, each a
// function of the service, a session handle and the call's JSON arguments, and the one mapping of errors to the public
// codes of section 5. Contents travel as strict base64 in JSON ("Paths and contents"); paths travel in JSON as they
// are, never decoded a second time.
import { VersionConflict } from "./schema.ts";
import type { FilesService } from "./service.ts";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type WireError = { code: string; message: string; currentVersion?: number; retryAfterMs?: number };
export type Reply = { ok: true; value: Json } | { ok: false; error: WireError };

/** A malformed call that never reached the service. */
export class BadCall extends Error {
	readonly code = "invalidInput";
	constructor(message: string) { super(message); this.name = "BadCall"; }
}

const PUBLIC = new Set(["unauthenticated", "notFound", "permissionDenied", "invalidInput", "alreadyExists", "versionConflict",
	"lastOwner", "lastAdmin", "requestMismatch", "operationIdRejected", "capacityExceeded", "inconsistentState", "unavailable"]);

/**
 * The public form of an error. `inconsistentState` reveals nothing about its target (section 5) and an error without a
 * public code is `internal` with no message, so nothing private leaves through an unexpected exception.
 */
export function wireError(e: unknown): WireError {
	const code = (e as { code?: unknown })?.code;
	if (typeof code !== "string" || !PUBLIC.has(code)) return { code: "internal", message: "internal error" };
	if (code === "inconsistentState") return { code, message: "the tenant's state is inconsistent; the operator has been told" };
	const out: WireError = { code, message: (e as Error).message };
	if (e instanceof VersionConflict) out.currentVersion = e.currentVersion;
	const retry = (e as { retryAfterMs?: unknown }).retryAfterMs;
	if (typeof retry === "number") out.retryAfterMs = retry;
	return out;
}

const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Decodes canonical base64 only: no whitespace, no URL alphabet, no missing padding, nothing Buffer would skip. */
export function decodeBase64(s: unknown): Buffer {
	if (typeof s !== "string" || !B64.test(s)) throw new BadCall("contents must be base64");
	return Buffer.from(s, "base64");
}

/** The base64 length of `bytes` bytes. */
export const base64Chars = (bytes: number) => 4 * Math.ceil(bytes / 3);

type Args = Record<string, unknown>;
type Op = (svc: FilesService, handle: string, a: Args) => Promise<Json>;

/** The file operations of section 5: the agent socket and the browser offer them. */
export const FILE_OPS: Record<string, Op> = {
	workspaces: (s, h) => s.workspaces(h),
	issueOperationIds: (s, h, a) => s.issueOperationIds(h, a.count),
	list: (s, h, a) => s.list(h, a.workspace, a.path),
	read: async (s, h, a) => {
		const { bytes, version } = await s.read(h, a.workspace, a.path);
		return { contents: bytes.toString("base64"), version };
	},
	write: (s, h, a) => s.write(h, a.workspace, a.path, decodeBase64(a.contents), a.expectedVersion, a.operationId),
	mkdir: (s, h, a) => s.mkdir(h, a.workspace, a.path, a.operationId),
	listGrants: (s, h, a) => s.listGrants(h, a.workspace, a.path) as Promise<Json>,
	grant: (s, h, a) => s.grant(h, a.workspace, a.path, a.relation, a.subject, a.operationId),
	revoke: (s, h, a) => s.revoke(h, a.workspace, a.path, a.relation, a.subject, a.operationId),
	restrict: (s, h, a) => s.restrict(h, a.workspace, a.path, a.operationId),
	unrestrict: (s, h, a) => s.unrestrict(h, a.workspace, a.path, a.operationId),
};

/** The admin operations of section 5 (an enabled tenant administrator; the service checks it): the browser only. */
export const ADMIN_OPS: Record<string, Op> = {
	createWorkspace: (s, h, a) => s.createWorkspace(h, a.name, a.owner, a.operationId),
	registerActor: (s, h, a) => s.registerActor(h, a.kind, a.actorId, a.homeName, a.identity, a.operationId),
	disableActor: (s, h, a) => s.disableActor(h, a.actor, a.replacementOwners ?? null, a.operationId),
	enableActor: (s, h, a) => s.enableActor(h, a.actor, a.operationId),
	deleteActor: (s, h, a) => s.deleteActor(h, a.actor, a.replacementOwners ?? null, a.operationId),
	grantTenantAdmin: (s, h, a) => s.grantTenantAdmin(h, a.user, a.operationId),
	revokeTenantAdmin: (s, h, a) => s.revokeTenantAdmin(h, a.user, a.operationId),
	addMember: (s, h, a) => s.addMember(h, a.group, a.subject, a.operationId),
	removeMember: (s, h, a) => s.removeMember(h, a.group, a.subject, a.operationId),
	listWorkspaces: (s, h) => s.listWorkspaces(h),
	listActors: (s, h) => s.listActors(h),
	listGroups: (s, h) => s.listGroups(h),
	listGroupMembers: (s, h, a) => s.listGroupMembers(h, a.group) as Promise<Json>,
	// the maintenance metadata operations (section 5): maintenance mode only, an administrator's, no contents
	maintenanceList: (s, h, a) => s.maintenanceList(h, a.workspace, a.path) as Promise<Json>,
	maintenanceListGrants: (s, h, a) => s.maintenanceListGrants(h, a.workspace, a.path) as Promise<Json>,
	maintenancePutGrant: (s, h, a) => s.maintenancePutGrant(h, a.workspace, a.path, a.action, a.relation, a.subject, a.operationId),
};

export const isObj = (v: unknown): v is Args => typeof v === "object" && v !== null && !Array.isArray(v);

/** Runs one operation of `ops` and answers with its reply; never throws. */
export async function runOp(ops: Record<string, Op>, svc: FilesService, handle: string, op: unknown, args: unknown): Promise<Reply> {
	const start = performance.now();
	// the counters name offered operations only, so a caller cannot grow them with names of its own
	const name = typeof op === "string" && Object.hasOwn(ops, op) ? op : "(unknown)";
	let r: Reply;
	try {
		if (name === "(unknown)") throw new BadCall("unknown operation");
		if (args !== undefined && !isObj(args)) throw new BadCall("args must be an object");
		r = { ok: true, value: await ops[name](svc, handle, (args ?? {}) as Args) };
	} catch (e) { r = { ok: false, error: wireError(e) }; }
	svc.metrics.op(name, performance.now() - start, r.ok ? null : r.error.code);
	return r;
}

/** The recovery interface of a restore (section 6.5, step 2): a rostered recoverer's session only, the browser only. */
export const RECOVERY_OPS: Record<string, Op> = {
	issueOperationIds: (s, h, a) => s.recoveryIssueOperationIds(h, a.count),
	inspect: (s, h) => s.recoveryInspect(h) as Promise<Json>,
	provisionAdmin: (s, h, a) => s.recoveryProvisionAdmin(h, a.actorId, a.homeName, a.identity, a.operationId),
	revokeAdmin: (s, h, a) => s.recoveryRevokeAdmin(h, a.user, a.operationId),
};
