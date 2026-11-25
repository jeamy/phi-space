// Byte and cardinality limits of the filesystem (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 to 5), checked
// against the Space's own limits when the service starts, and the exact encoded sizes checked before each write.
//
// The Space measures an entry as the UTF-8 bytes of its fields' JSON (`jsonBytes`): a name is not normalized beyond
// NFC, so a quote or backslash costs two bytes, everything else its UTF-8 bytes. The configured limits therefore have
// to fit in their worst case, and the exact size of each row is checked before it is written, so that an overrun is
// `capacityExceeded` and the Space's own size error never reaches a caller. File contents are not rows: they are
// sealed blobs (blobs.ts), bounded by `maxFileBytes` and the tenant's content quota, not by the Space's limits.
import type { Limits } from "phi-spaces/core";
import { CapacityExceeded } from "./schema.ts";

export type FsLimits = {
	/** A name (workspace, home, path segment, group ID), in UTF-8 bytes of its NFC form. */
	maxNameBytes: number;
	/** Segments of a path below its workspace root. */
	maxPathDepth: number;
	/** A path, in UTF-8 bytes. */
	maxPathBytes: number;
	/** One file's contents, in bytes. A read holds them in memory inside the tenant queue (section 6.1). */
	maxFileBytes: number;
	/** Children of one directory, and so entries of one `list` reply. */
	maxDirEntries: number;
	/** Direct grants on one target, and so tuples of one `listGrants` reply. */
	maxGrantsPerTarget: number;
	/** Bytes of one listing reply (`list`, `listGrants`, the admin lists); a read's contents are bounded by maxFileBytes. */
	maxReplyBytes: number;
	/** Per tenant. */
	maxActors: number;
	maxGroups: number;
	maxWorkspaces: number;
	maxNodes: number;
	maxRelations: number;
	/** The bytes of all files' current versions (the sum of the content rows' `size`). */
	maxContentBytes: number;
	/**
	 * The stored bytes of all rows (the Space's own measure: the JSON of each entry's fields), checked exactly before each
	 * write. With the audit reserve it must stay within the tenant Space's `maxSpaceBytes`, so that the filesystem
	 * answers `capacityExceeded` before the Space refuses on its own.
	 */
	maxTenantBytes: number;
	/** Stored bytes above `maxTenantBytes` kept for audit rows (section 3, budgets): a mutation's own rows must fit
	 *  `maxTenantBytes`, its audit row the reserve. */
	auditReserveBytes: number;
	/** The part of the audit reserve only security actions (revocations, membership removal, actor disablement) may use,
	 *  for their receipts and audit rows. */
	securityReserveBytes: number;
	/** Lookups one decision (a resolution plus its rights) may make. */
	maxWorkPerDecision: number;
	/** Operation IDs (section 6.2): the published retry window, the allowed clock skew, IDs per `issueOperationIds` call. */
	retryWindowMs: number;
	clockSkewMs: number;
	maxOperationIdsPerCall: number;
	/** The audit retention age set by the host operator: no row is removed before it (section 3, budgets). */
	maxAuditAgeMs: number;
	/** Refused admin calls of one actor and operation within this window share one audit row with a count, so a caller
	 *  cannot fill the audit by asking again and again. */
	deniedAuditWindowMs: number;
	/** Relations `deleteActor` removes in its one transaction; an actor with more is disabled and pruned in batches. */
	maxDeleteRelations: number;
	/** Receipts per tenant for ordinary mutations, and the extra ones only security actions may use (section 3). */
	maxReceipts: number;
	securityReceiptReserve: number;
};

/**
 * The limits a deployment overrides (phase 5, live-data limit configuration): a JSON object of known keys, each a
 * positive safe integer. Unknown keys and other values are refused, so a typo never silently keeps a default. Whether
 * the whole set fits the tenant Spaces is checked when the service opens (`assertLimitsFit`).
 */
export function parseLimits(text: string, source = "the limits file"): Partial<FsLimits> {
	let v: unknown;
	try { v = JSON.parse(text); } catch (e) { throw new Error(`${source} is no JSON: ${(e as Error).message}`); }
	if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${source} must hold one JSON object`);
	const out: Record<string, number> = {};
	for (const [k, x] of Object.entries(v)) {
		if (!Object.hasOwn(DEFAULT_FS_LIMITS, k)) throw new Error(`${source}: unknown limit ${JSON.stringify(k)}`);
		if (!Number.isSafeInteger(x) || (x as number) < 1) throw new Error(`${source}: ${k} must be a positive integer`);
		out[k] = x as number;
	}
	return out as Partial<FsLimits>;
}

/** Pilot defaults. */
export const DEFAULT_FS_LIMITS: FsLimits = {
	maxNameBytes: 255,
	maxPathDepth: 32,
	maxPathBytes: 4096,
	maxFileBytes: 16 * 1024 * 1024,
	maxDirEntries: 256,
	maxGrantsPerTarget: 64,
	maxReplyBytes: 1024 * 1024,
	maxActors: 1000,
	maxGroups: 200,
	maxWorkspaces: 500,
	maxNodes: 20_000,
	maxRelations: 20_000,
	maxContentBytes: 1024 * 1024 * 1024,
	maxTenantBytes: 56 * 1024 * 1024,
	auditReserveBytes: 4 * 1024 * 1024,
	securityReserveBytes: 256 * 1024,
	maxWorkPerDecision: 512,
	maxAuditAgeMs: 90 * 24 * 3600_000,
	deniedAuditWindowMs: 3600_000,
	maxDeleteRelations: 256,
	retryWindowMs: 3600_000,
	clockSkewMs: 120_000,
	maxOperationIdsPerCall: 64,
	maxReceipts: 20_000,
	securityReceiptReserve: 1000,
};

/** The worst-case JSON size of a string of `bytes` UTF-8 bytes, quotes included. */
export const worstJsonString = (bytes: number): number => 6 * bytes + 2;
/** Room for the other fields of a row (IDs, kinds, numbers, keys). */
const ROW_OVERHEAD = 512;
/** A node ID (22 base64url characters) as the worst JSON string. */
const ID_JSON = 24;

export const encodedBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "");

/** Refuses a configuration whose worst case does not fit the Space's limits (plan section 5, paths and text). */
export function assertLimitsFit(fs: FsLimits, space: Pick<Limits, "maxEntryBytes" | "maxCommitBytes" | "maxSpaceBytes">): void {
	const fail = (what: string, need: number, have: number) => { throw new Error(`limits: ${what} needs ${need} bytes in the worst case, the limit is ${have}`); };
	const node = worstJsonString(fs.maxNameBytes) + ROW_OVERHEAD;
	if (node > space.maxEntryBytes) fail("an FsNode row", node, space.maxEntryBytes);
	// a creating save adds a node, a content row, a receipt and an audit row in one commit (an audit row names IDs only)
	const save = node + 4 * ROW_OVERHEAD;
	if (save > space.maxCommitBytes) fail("a save", save, space.maxCommitBytes);
	const list = fs.maxDirEntries * (worstJsonString(fs.maxNameBytes) + ID_JSON + 64);
	if (list > fs.maxReplyBytes) fail("a full directory listing", list, fs.maxReplyBytes);
	const workspaces = fs.maxWorkspaces * (worstJsonString(fs.maxNameBytes) + 8);
	if (workspaces > fs.maxReplyBytes) fail("a full workspace listing", workspaces, fs.maxReplyBytes);
	// the admin listings: an actor row as listed is at most its kind, a 128-character ID, its state and a node ID
	const actors = fs.maxActors * (130 + 24 + 64);
	if (actors > fs.maxReplyBytes) fail("a full actor or group-member listing", actors, fs.maxReplyBytes);
	const groups = fs.maxGroups * (worstJsonString(fs.maxNameBytes) + 4);
	if (groups > fs.maxReplyBytes) fail("a full group listing", groups, fs.maxReplyBytes);
	const grants = fs.maxGrantsPerTarget * (2 * worstJsonString(fs.maxNameBytes) + 128);
	if (grants > fs.maxReplyBytes) fail("a full grant listing", grants, fs.maxReplyBytes);
	if (fs.maxPathBytes < fs.maxNameBytes) fail("a path of one segment", fs.maxNameBytes, fs.maxPathBytes);
	const stored = fs.maxTenantBytes + fs.auditReserveBytes;
	if (stored > space.maxSpaceBytes) fail("the tenant's rows with the audit reserve", stored, space.maxSpaceBytes);
	if (fs.securityReserveBytes > fs.auditReserveBytes) fail("the security reserve inside the audit reserve", fs.securityReserveBytes, fs.auditReserveBytes);
	if (!(fs.retryWindowMs > 0) || !(fs.clockSkewMs >= 0) || fs.clockSkewMs >= fs.retryWindowMs) throw new Error("limits: the retry window must be positive and longer than the clock skew");
	if (!(fs.maxOperationIdsPerCall >= 1)) throw new Error("limits: maxOperationIdsPerCall must be at least 1");
	if (fs.maxFileBytes > fs.maxContentBytes) fail("one file inside the content quota", fs.maxFileBytes, fs.maxContentBytes);
}

/** The exact size of a row before it is written: an overrun is `capacityExceeded`, never the Space's own error. */
export function assertRowFits(fields: unknown, space: Pick<Limits, "maxEntryBytes">): void {
	const n = encodedBytes(fields);
	if (n > space.maxEntryBytes) throw new CapacityExceeded(`a row of ${n} bytes exceeds the entry limit of ${space.maxEntryBytes}`);
}
