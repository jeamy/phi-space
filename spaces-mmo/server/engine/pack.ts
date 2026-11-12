// What a figure can carry (docs/siedeln.en.md "Load"): every thing has a load by its kind (world.pack.load, 1 where it
// names none; coins weigh nothing), a figure carries up to the setting `pack.max` (1500); a chest takes everything, the
// player spreads its things over its chests. The limit is checked once around every command (commands.ts, `guardPack`): a command that leaves the actor's
// pack heavier than before and over the limit is refused, whatever it did (took, gathered, bought, crafted). What others
// bring (a delivery, a gift, a purchase from one's listing) arrives anyway: only the actor's own pack is checked, so a
// figure can be over the limit, and then takes nothing more until it has laid something down.
import type { SpaceLike } from "phi-spaces";
import { setting } from "../settings.ts";
import type { ItemFields } from "../model.ts";
import type { WorldDef } from "./world.ts";
import { fmtLoad } from "./load-format.ts";
export { chestOrder, fmtLoad } from "./load-format.ts";

/** The load of one thing of kind `proto`. */
export const loadOf = (w: WorldDef, proto: string | undefined): number => !proto || proto === w.currency ? 0 : w.pack?.load[proto] ?? 1;
/** The load of some things. */
export const loadOfAll = (w: WorldDef, items: Iterable<Pick<ItemFields, "proto">>): number => { let n = 0; for (const i of items) n += loadOf(w, i.proto); return n; };
/** What `location` (a figure, a building's chest) holds, in load. */
export async function loadAt(space: SpaceLike, w: WorldDef, location: string, txn: string | null): Promise<number> {
	return loadOfAll(w, (await space.readAll({ type: "Item", fields: { location } }, txn ? { txn } : {})).map((e) => e.fields as unknown as ItemFields));
}
/** The most a figure carries; Infinity in a world without loads. With `charId`, a bag it carries (world.pack.bags, a
 *  leather bag) adds its part, each kind once however many one carries. */
export async function packMax(space: SpaceLike, w: WorldDef, charId?: string, txn: string | null = null): Promise<number> {
	if (!w.pack) return Infinity;
	const base: number = (await setting(space, "pack.max").catch(() => undefined)) ?? w.pack.max;
	const bags = w.pack.bags;
	if (!charId || !bags) return base;
	let more = 0;
	for (const [proto, n] of Object.entries(bags)) if (await space.count({ type: "Item", fields: { location: charId, proto } }, txn)) more += n;
	return base + more;
}

/** The commands that never add to the pack: no reads around them (walking is the path played most). */
const LIGHT = new Set(["look", "say", "emote", "who", "help", "time", "inventory", "truhe", "lager", "reputation", "epoche", "wetter", "fahrplan", "wache", "baustelle", "tell", "whisper", "page"]);
/** Before a command: the actor's load, or null when the command is not checked (an NPC's, a light one). */
export async function packBefore(space: SpaceLike, w: WorldDef, charId: string, key: string, npc: boolean, txn: string): Promise<number | null> {
	if (!w.pack || npc || LIGHT.has(key)) return null;
	return loadAt(space, w, charId, txn);
}
/** After it, in the same transaction: the refusal when it left the pack heavier than before and over the limit. */
export async function packAfter(space: SpaceLike, w: WorldDef, charId: string, before: number | null, txn: string): Promise<string | null> {
	if (before === null) return null;
	const after = await loadAt(space, w, charId, txn);
	if (after <= before) return null;
	const max = await packMax(space, w, charId, txn);
	if (after <= max) return null;
	return `Das trägst du nicht mehr: dein Gepäck wöge ${fmtLoad(after)} von ${fmtLoad(max)}. Leg etwas in eine Truhe („verstaue <ding>“) oder lass es hier.`;
}
