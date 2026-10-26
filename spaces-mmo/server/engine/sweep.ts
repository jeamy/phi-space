// The sweep (docs/weltzeit.md): what the world gave a world-time life to is taken away when that time is up. A lease of the
// space cannot do this, because a lease runs on real time and does not stand still with the clock. Flotsam of the tide, jobs
// of the order board and listings of the market carry `expiresWorldMs`; the date `tick.sweep` calls this every few world
// seconds. Each thing is taken in a transaction of its own, so what someone picks up or buys at that moment is theirs.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { fieldsOf, type ItemFields, type ListingFields, type OrderFields } from "../model.ts";
import { worldNowOf } from "./clock.ts";

async function takeIfLapsed(space: SpaceLike, id: string, type: string): Promise<void> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		if (!(await space.takeIfExists({ type, id }, NO_WAIT, { txn }))) { await space.abort(txn); return; } // taken right now
		await space.commit(txn);
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** Flotsam, open or taken jobs, listings and awake roles whose world time is up are removed (a listing's item goes back to its seller with
 *  the market tick, as when its lease used to end). A thing picked up is stripped of the date (the `get` command), so what is carried stays. */
export async function sweepTick(space: SpaceLike): Promise<void> {
	const now = await worldNowOf(space);
	for (const e of await space.readAll({ type: "Item", fields: { flotsam: true } })) {
		const f = fieldsOf<ItemFields>(e);
		if (f.expiresWorldMs !== undefined && f.expiresWorldMs <= now) await takeIfLapsed(space, e.id, "Item");
	}
	for (const e of await space.readAll({ type: "NpcAwake" })) if (Number(e.fields.untilWorldMs ?? 0) <= now) await takeIfLapsed(space, e.id, "NpcAwake"); // a role awake until a world time
	for (const e of await space.readAll({ type: "Order" })) if ((fieldsOf<OrderFields>(e).expiresWorldMs ?? Infinity) <= now) await takeIfLapsed(space, e.id, "Order");
	for (const e of await space.readAll({ type: "Listing" })) if ((fieldsOf<ListingFields>(e).expiresWorldMs ?? Infinity) <= now) await takeIfLapsed(space, e.id, "Listing");
}
