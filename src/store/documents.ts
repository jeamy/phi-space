// Document definitions of phi-spaces (docs/umstellung-ohne-pi-durable.md, U1). A definition carries its kind, version,
// initial value, migration and compaction rule. During the move it also carries the same definition in the shape the
// pi-durable host reads (`definition`, session scope), so a pi-durable session serves these documents unchanged and
// the stored kinds and versions stay as they are.
import type { DocDef, DocFamilyDef } from "./types.ts";

type Common<T> = Omit<DocDef<T>, "family" | "initial" | "definition">;

const check = (kind: string, version: number) => {
	if (!kind) throw new TypeError("a document needs a kind");
	if (!Number.isSafeInteger(version) || version < 1) throw new TypeError(`Document ${kind} version must be a positive integer`);
};

/** One document of this kind per store. `scope` stays "session" (the only one the space host uses). */
export function defineDoc<T>(d: Common<T> & { initial: () => T; scope?: "session" }): DocDef<T> {
	check(d.kind, d.version);
	const { scope: _scope, ...def } = d;
	return Object.freeze({ ...def, definition: { ...def, scope: "session" } }) as DocDef<T>;
}

/** Many documents of this kind, each under its key. */
export function defineDocFamily<T, I>(d: Common<T> & { initial: (seed: I) => T; scope?: "session"; family?: true }): DocFamilyDef<T, I> {
	check(d.kind, d.version);
	const { scope: _scope, family: _family, ...def } = d;
	return Object.freeze({ ...def, family: true as const, definition: { ...def, family: true, scope: "session" } }) as DocFamilyDef<T, I>;
}
