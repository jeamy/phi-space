// Canonical JSON (RFC 8785 / JCS): sorted keys (UTF-16 code units), no whitespace, ECMAScript number form. For hashes
// and signatures; JSON.stringify alone is not deterministic across key orders.
import { createHash } from "node:crypto";
import type { Json } from "./core.ts";

export function canonicalJson(v: Json): string {
	if (v === null || typeof v === "boolean" || typeof v === "string") return JSON.stringify(v);
	if (typeof v === "number") {
		if (!Number.isFinite(v)) throw new TypeError("canonical JSON: non-finite number");
		return JSON.stringify(Object.is(v, -0) ? 0 : v);
	}
	if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
	if (typeof v === "object") {
		const keys = Object.keys(v).filter((k) => (v as Record<string, Json | undefined>)[k] !== undefined).sort();
		return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, Json>)[k]!)}`).join(",")}}`;
	}
	throw new TypeError(`canonical JSON: unsupported ${typeof v}`);
}

/** The hex SHA-256 of a value's canonical JSON: the one digest behind argument, command and binding hashes. */
export const digestJson = (v: unknown): string => createHash("sha256").update(canonicalJson(v as Json)).digest("hex");
