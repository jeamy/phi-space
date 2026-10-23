// Document definitions of phi-spaces (docs/umstellung-ohne-pi-durable.md, U1). A definition carries its kind, version,
// initial value, migration and parts. `scope: "session"` is accepted for the older definitions and means nothing: every
// document belongs to the store.
import type { DocDef, DocFamilyDef } from "./types.ts";

type Common<T> = Omit<DocDef<T>, "family" | "initial">;

const check = (kind: string, version: number) => {
	if (!kind) throw new TypeError("a document needs a kind");
	if (!Number.isSafeInteger(version) || version < 1) throw new TypeError(`Document ${kind} version must be a positive integer`);
};

/** One document of this kind per store. */
export function defineDoc<T>(d: Common<T> & { initial: () => T; scope?: "session" }): DocDef<T> {
	check(d.kind, d.version);
	const { scope: _scope, ...def } = d;
	return Object.freeze(def) as DocDef<T>;
}

/** Many documents of this kind, each under its key. */
export function defineDocFamily<T, I>(d: Common<T> & { initial: (seed: I) => T; scope?: "session"; family?: true }): DocFamilyDef<T, I> {
	check(d.kind, d.version);
	const { scope: _scope, family: _family, ...def } = d;
	return Object.freeze({ ...def, family: true as const }) as DocFamilyDef<T, I>;
}
