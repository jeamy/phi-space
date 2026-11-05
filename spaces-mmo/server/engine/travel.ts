// How often a player travelled (the statistics page, server/stats.ts): one Travel entry per character and region, raised
// inside the command's transaction, so a ride that fails counts nothing. A character that crosses into another region
// starts a new entry there; the statistics add up every entry of a character. Only people count: NPCs and settlers
// travel too, but they are not players. A lapsed guest's entries go with it (world-host.ts cleanup).
import { FOREVER, takeExisting } from "phi-spaces";
import { fieldsOf } from "../model.ts";
import type { CommandCtx } from "./context.ts";

export const TRIPS = ["beam", "ship", "sail", "row", "train"] as const;
export type Trip = (typeof TRIPS)[number];
export type TravelFields = { charId: string } & Partial<Record<Trip, number>>;

/** One more `kind` for the actor (nothing for NPCs and settlers). */
export async function countTrip(c: CommandCtx, kind: Trip): Promise<void> {
	if (!c.account && c.loadAccount) { c.account = await c.loadAccount(); delete c.loadAccount; }
	if (!c.account || c.account.npc || c.account.settler || c.actor.charId.startsWith("npc-")) return;
	const had = await takeExisting(c.space, { type: "Travel", fields: { charId: c.actor.charId } }, 2_000, { txn: c.txn });
	const f: TravelFields = had ? fieldsOf<TravelFields>(had) : { charId: c.actor.charId };
	await c.space.write({ type: "Travel", fields: { ...f, [kind]: (f[kind] ?? 0) + 1 } as never }, c.txn, FOREVER);
}
