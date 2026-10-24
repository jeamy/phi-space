// Typeclasses (docs/evennia-abbildung.md, "Grundsätze"): a typeclass is an entry type, its parents are the entry's
// supertypes, fixed when the entry is written. Templates match subtypes, so `{ type: "Item" }` finds every coin and
// every piece of driftwood. Behaviour is code in the world worker, keyed by these names; a world may add typeclasses
// below the engine's, never above them.

/** The engine's typeclasses and their parents. */
export const BASE_TYPECLASSES: Record<string, string | null> = { Object: null, Item: "Object", Exit: "Object", Character: "Object", Room: "Object" };

/** The type and its supertypes, nearest first: `Coin` → ["Coin", "Item", "Object"]. Unknown or cyclic: an error. */
export function typeChain(name: string, extra: Record<string, string | null> = {}): string[] {
	const all: Record<string, string | null> = { ...extra, ...BASE_TYPECLASSES };
	const chain: string[] = [];
	for (let t: string | null = name; t !== null; t = all[t] ?? null) {
		// own keys only: a builder names the class, and "constructor" must not reach Object.prototype
		if (!Object.hasOwn(all, t)) throw new Error(`unbekannte Typklasse „${t.slice(0, 30)}“`);
		if (chain.includes(t)) throw new Error(`Typklasse „${name}“ erbt im Kreis`);
		chain.push(t);
	}
	return chain;
}

/** The draft of an entry of typeclass `name`. */
export const draftOf = (name: string, extra: Record<string, string | null>, fields: Record<string, unknown>) => {
	const [type, ...types] = typeChain(name, extra);
	return { type: type!, types, fields: fields as never };
};
