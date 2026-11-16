// JSON copies and sizes. Each helper names its semantics, so a module picks a validation depth on purpose:
// `jsonCopy` is lenient (JSON.stringify rules: undefined dropped, NaN becomes null; works on document drafts),
// `canonicalCopy` rejects non-finite numbers and sorts keys, `strictJsonCopy` accepts only plain finite JSON.
import { canonicalJson } from "./canonical.ts";
import type { Json } from "./core.ts";

export const jsonCopy = <T>(v: T): T => JSON.parse(JSON.stringify(v));
export const canonicalCopy = <T>(v: T): T => JSON.parse(canonicalJson(v as Json));
/** UTF-8 bytes of `JSON.stringify(v)` (0 for undefined). */
export const jsonBytes = (v: unknown): number => Buffer.byteLength(JSON.stringify(v) ?? "");

/** Throws `fail(message)` unless `v` is plain finite JSON: no cycles, classes, symbols, or nesting beyond 64 levels. */
export function assertPlainJson(v: unknown, fail: (message: string) => Error, depth = 0, parents = new Set<object>()): void {
	if (depth > 64) throw fail("JSON nesting exceeds 64 levels");
	if (v === null || typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) return;
	if (typeof v !== "object" || parents.has(v) || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype && Object.getPrototypeOf(v) !== null) || Object.getOwnPropertySymbols(v).length) throw fail("plain finite JSON required");
	parents.add(v);
	if (Array.isArray(v)) { for (let n = 0; n < v.length; n++) assertPlainJson(v[n], fail, depth + 1, parents); }
	else for (const k of Object.keys(v)) assertPlainJson((v as Record<string, unknown>)[k], fail, depth + 1, parents);
	parents.delete(v);
}
export const strictJsonCopy = <T>(v: T, fail: (message: string) => Error): T => { assertPlainJson(v, fail); return jsonCopy(v); };
