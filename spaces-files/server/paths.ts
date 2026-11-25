// Canonical paths (docs/zanzibar-agent-filesystem-plan.en.md, section 5, paths and contents): one parser for every
// adapter. A path is relative to its workspace; each segment is a canonical name (NFC, case-sensitive); a lone dot
// means the workspace root, and only the operations that may address the root accept it. File contents are bytes
// kept exactly as given and are checked by `checkContents`.
import { DEFAULT_FS_LIMITS, type FsLimits } from "./limits.ts";
import { CapacityExceeded, InvalidInput, canonicalName } from "./schema.ts";

/** The operations that may name the workspace root with a lone dot. */
const ROOT_OPERATIONS = new Set(["list", "grant", "revoke", "listGrants", "maintenanceList", "maintenanceListGrants", "maintenancePutGrant"]);

/** The canonical segments of a path below its workspace root; `[]` is the root itself. */
export function parsePath(path: unknown, operation: string, limits: Pick<FsLimits, "maxNameBytes" | "maxPathDepth" | "maxPathBytes"> = DEFAULT_FS_LIMITS): string[] {
	if (typeof path !== "string") throw new InvalidInput("a path must be a string");
	if (!path.isWellFormed()) throw new InvalidInput("a path must be well-formed Unicode");
	if (path === ".") {
		if (!ROOT_OPERATIONS.has(operation)) throw new InvalidInput(`${operation} cannot address the workspace root`);
		return [];
	}
	if (path === "") throw new InvalidInput("an empty path");
	if (path.startsWith("/")) throw new InvalidInput("a path is relative to its workspace");
	if (path.includes("\\")) throw new InvalidInput("a path has no backslashes");
	if (/\p{Cc}/u.test(path)) throw new InvalidInput("a path has no control characters");
	if (Buffer.byteLength(path, "utf8") > limits.maxPathBytes) throw new CapacityExceeded(`a path has at most ${limits.maxPathBytes} bytes`);
	const raw = path.split("/");
	if (raw.length > limits.maxPathDepth) throw new CapacityExceeded(`a path has at most ${limits.maxPathDepth} segments`);
	return raw.map((seg) => {
		if (seg === "") throw new InvalidInput("a path has no empty segments");
		if (seg === "." || seg === "..") throw new InvalidInput("a path has no dot segments");
		return canonicalName(seg, limits.maxNameBytes);
	});
}

/** The canonical spelling of parsed segments: what request digests and audit refer to. */
export const pathString = (segments: readonly string[]): string => segments.length === 0 ? "." : segments.join("/");


/** File contents as stored: the exact bytes, never decoded or normalized; bounded by `maxFileBytes`. */
export function checkContents(bytes: unknown, limits: Pick<FsLimits, "maxFileBytes"> = DEFAULT_FS_LIMITS): Uint8Array {
	if (!(bytes instanceof Uint8Array)) throw new InvalidInput("file contents must be bytes");
	if (bytes.length > limits.maxFileBytes) throw new CapacityExceeded(`a file of ${bytes.length} bytes exceeds ${limits.maxFileBytes}`);
	return bytes;
}
