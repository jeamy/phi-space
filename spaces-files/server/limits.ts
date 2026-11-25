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
	/** Bytes of one reply of the service. */
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
	/** Stored bytes kept back for audit rows and the security pool (section 3, budgets); ordinary writes never use them. */
	auditReserveBytes: number;
	/** Lookups one decision (a resolution plus its rights) may make. */
	maxWorkPerDecision: number;
};

/** Pilot defaults. */
export const DEFAULT_FS_LIMITS: FsLimits = {
	maxNameBytes: 255,
	maxPathDepth: 32,
	maxPathBytes: 4096,
	maxFileBytes: 16 * 1024 * 1024,
	maxDirEntries: 256,
	maxGrantsPerTarget: 64,
	maxReplyBytes: 512 * 1024,
	maxActors: 1000,
	maxGroups: 200,
	maxWorkspaces: 500,
	maxNodes: 20_000,
	maxRelations: 20_000,
	maxContentBytes: 1024 * 1024 * 1024,
	maxTenantBytes: 56 * 1024 * 1024,
	auditReserveBytes: 4 * 1024 * 1024,
	maxWorkPerDecision: 512,
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
	const grants = fs.maxGrantsPerTarget * (2 * worstJsonString(fs.maxNameBytes) + 128);
	if (grants > fs.maxReplyBytes) fail("a full grant listing", grants, fs.maxReplyBytes);
	if (fs.maxPathBytes < fs.maxNameBytes) fail("a path of one segment", fs.maxNameBytes, fs.maxPathBytes);
	const stored = fs.maxTenantBytes + fs.auditReserveBytes;
	if (stored > space.maxSpaceBytes) fail("the tenant's rows with the audit reserve", stored, space.maxSpaceBytes);
	if (fs.maxFileBytes > fs.maxContentBytes) fail("one file inside the content quota", fs.maxFileBytes, fs.maxContentBytes);
}

/** The exact size of a row before it is written: an overrun is `capacityExceeded`, never the Space's own error. */
export function assertRowFits(fields: unknown, space: Pick<Limits, "maxEntryBytes">): void {
	const n = encodedBytes(fields);
	if (n > space.maxEntryBytes) throw new CapacityExceeded(`a row of ${n} bytes exceeds the entry limit of ${space.maxEntryBytes}`);
}
