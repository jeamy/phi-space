// Prototypes and the spawner (Evennia's Spawner and Prototypes): a prototype names a parent whose fields it extends;
// spawning resolves the chain and writes an item of the prototype's typeclass. Prototypes live in the world space,
// written by the loader from the world definition.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type ItemFields, type PrototypeFields } from "../model.ts";
import { draftOf } from "./typeclasses.ts";
import type { WorldDef } from "./world.ts";
import { peek } from "../space.ts";

/** The engine's default locks of an item: anyone may pick it up and drop it, only registered players give it away. */
export const DEFAULT_ITEM_LOCKS = "get:all();drop:all();give:not guest()";

/** A prototype chain, root first, folded into one: the child's own values win over its parents'. */
const fold = (chain: PrototypeFields[]): PrototypeFields =>
	chain.reduce((acc, p) => ({ ...acc, ...Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && v !== "")) }), {} as PrototypeFields);
const MAX_DEPTH = 10;

/** A prototype from the space with its parents' fields filled in. Null when it or a parent is missing (or a cycle). */
export async function resolvePrototype(space: SpaceLike, key: string): Promise<PrototypeFields | null> {
	const chain: PrototypeFields[] = [];
	for (let k: string | null = key; k; ) {
		if (chain.some((p) => p.key === k) || chain.length >= MAX_DEPTH) return null;
		const e = await peek(space, { type: "Prototype", fields: { key: k } });
		if (!e) return null;
		const p = fieldsOf<PrototypeFields>(e);
		chain.unshift(p);
		k = p.parent;
	}
	return fold(chain);
}

/** The same from a list (the world definition). */
export function resolveFrom(list: PrototypeFields[], key: string): PrototypeFields | null {
	const chain: PrototypeFields[] = [];
	for (let k: string | null = key; k; ) {
		if (chain.some((p) => p.key === k) || chain.length >= MAX_DEPTH) return null;
		const p = list.find((q) => q.key === k);
		if (!p) return null;
		chain.unshift(p);
		k = p.parent;
	}
	return fold(chain);
}

export const newItemId = () => `i-${randomBytes(6).toString("hex")}`;

/** Writes an item of prototype `p` (under `txn`); `expiresWorldMs`: the sweep takes it away when the world time reaches
 *  that (flotsam), else it stays; `lease` is a real-time lifetime of the entry itself. */
export async function spawn(space: SpaceLike, txn: string | null, w: WorldDef, p: PrototypeFields, at: { itemId?: string; location: string; x: number; y: number; flotsam?: boolean; lease?: number; expiresWorldMs?: number }): Promise<ItemFields> {
	const item: ItemFields = { itemId: at.itemId ?? newItemId(), name: p.name, aliases: p.aliases ?? [], desc: p.desc ?? "", location: at.location, x: at.x, y: at.y, glyph: p.glyph, locks: p.locks || DEFAULT_ITEM_LOCKS, proto: p.key, ...(at.flotsam ? { flotsam: true } : {}), ...(at.expiresWorldMs !== undefined ? { expiresWorldMs: at.expiresWorldMs } : {}), ...(p.wear ? { wear: p.wear } : {}) };
	await space.write(draftOf(p.typeclass || "Item", w.typeclasses, item), txn, at.lease ?? FOREVER);
	return item;
}
