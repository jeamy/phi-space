// The sweep (docs/weltzeit.en.md): what the world gave a world-time life to is taken away when that time is up. A lease of the
// space cannot do this, because a lease runs on real time and does not stand still with the clock. Flotsam of the tide, jobs
// of the order board and listings of the market carry `expiresWorldMs`; the date `tick.sweep` calls this every few world
// seconds. Each thing is taken in a transaction of its own, so what someone picks up or buys at that moment is theirs.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type ItemFields, type ListingFields, type OrderFields, type WantedFields } from "../model.ts";
import { decayNowOf, worldNowOf } from "./clock.ts";
import { buildSweep } from "./commands/build.ts";
import { toPlayer } from "./context.ts";
import { timeNow } from "./source.ts";
import type { WorldDef } from "./world.ts";

async function takeIfLapsed(space: SpaceLike, id: string, type: string): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		if (!(await space.takeIfExists({ type, id }, NO_WAIT, { txn }))) { await space.abort(txn); return; } // taken right now
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** A wanted notice whose time is up: taken, and the one who sought it told (its coins go back with the market tick). */
async function wantedLapsed(space: SpaceLike, id: string, w?: WorldDef): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		const e = await space.takeIfExists({ type: "Wanted", id }, NO_WAIT, { txn });
		if (!e) { await space.abort(txn); return; } // delivered or taken back right now
		const f = fieldsOf<WantedFields>(e), lot = (f.count ?? 1) > 1 ? `${f.count}× ${f.protoName}` : f.protoName;
		const board = (w?.allRooms ?? w?.rooms ?? []).find((r) => r.roomId === f.room)?.name ?? f.room;
		await toPlayer(space, { room: f.room, to: f.buyer, kind: "info", text: `Dein Gesuch nach ${lot} am Marktbrett (${board}) ist abgelaufen; niemand hat geliefert. Deine ${f.price} Münze${f.price === 1 ? "" : "n"} bekommst du zurück.`, from: "Marktbrett", fromId: "market", at: timeNow() }, txn);
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** Flotsam, open or taken jobs, listings and awake roles whose world time is up are removed (a listing's item goes back to its seller with
 *  the market tick, as when its lease used to end). A thing picked up is stripped of the date (the `get` command), so what is carried stays. */
export async function sweepTick(space: SpaceLike, w?: WorldDef): Promise<void> {
	const now = await worldNowOf(space), kept = await decayNowOf(space);
	for (const e of await space.readAll({ type: "Item", fields: { flotsam: true } })) {
		const f = fieldsOf<ItemFields>(e);
		if (f.expiresWorldMs !== undefined && f.expiresWorldMs <= now) await takeIfLapsed(space, e.id, "Item");
	}
	for (const e of await space.readAll({ type: "NpcAwake" })) if (Number(e.fields.untilWorldMs ?? 0) <= kept) await takeIfLapsed(space, e.id, "NpcAwake"); // a role awake until a world time
	for (const e of await space.readAll({ type: "Order" })) if ((fieldsOf<OrderFields>(e).expiresWorldMs ?? Infinity) <= now) await takeIfLapsed(space, e.id, "Order");
	for (const e of await space.readAll({ type: "Listing" })) if ((fieldsOf<ListingFields>(e).expiresWorldMs ?? Infinity) <= kept) await takeIfLapsed(space, e.id, "Listing");
	for (const e of await space.readAll({ type: "Wanted" })) if ((fieldsOf<WantedFields>(e).expiresWorldMs ?? Infinity) <= kept) await wantedLapsed(space, e.id, w); // its coins go back with the market tick
	await buildSweep(space, w); // sites without progress, buildings not kept, ruins and estates whose time is up (docs/siedeln.en.md)
}
