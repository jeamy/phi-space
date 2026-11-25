// The canonical request digest (docs/zanzibar-agent-filesystem-plan.en.md, sections 3 and 6.2): what a receipt records
// about the arguments of a mutation, so that a retry with the same operation ID and different arguments is
// `requestMismatch`. It is the SHA-256 of the RFC 8785 canonical JSON of the operation name and its arguments after
// canonicalization (NFC names and paths, parsed subjects); file contents enter as the SHA-256 of their exact bytes
// (`contentDigest`), never the bytes. The operation ID itself is not part of it: it is the receipt's key.
import { canonicalJson } from "phi-spaces";
import { createHash } from "node:crypto";
import type { Json } from "phi-spaces/core";

/** Bumped when the encoding changes; it is part of every digest so that old receipts never match new requests. */
export const DIGEST_VERSION = 1;

export function requestDigest(operation: string, args: Record<string, Json>): string {
	return createHash("sha256").update(canonicalJson({ v: DIGEST_VERSION, op: operation, args })).digest("hex");
}

/** The SHA-256 of a file's exact bytes, as it enters a request digest. */
export const contentDigest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
