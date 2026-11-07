// A courier (docs/siedeln.en.md "Load"): what a player puts into a chest of its own in another region. phi-spaces has no
// transaction across two spaces, so it goes like a crossing's pack (handover.ts), in steps that can be repeated:
//   1. in region A, in the command's transaction (verstaue): the things move to the courier's id and a Courier is written.
//      They are now out of anyone's reach.
//   2. a world worker of A takes the Courier in a transaction of A, writes the things into region B, in the chest (one
//      already there is not written twice: an earlier try got that far), then takes them in A.
//   3. A's transaction is committed: the Courier is gone.
// A chest that has meanwhile become a ruin gets them in its estate (nachlass); a building gone without one in a new
// estate where it stood. A chest that has filled up meanwhile takes them anyway (the command counted what was on its way).
import { FOREVER, NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type EstateFields } from "../model.ts";
import { awaitWork } from "../space.ts";
import { worldNowOf } from "./clock.ts";
import type { WorldDef } from "./world.ts";

export type CourierFields = {
	courierId: string; /** the region of the chest */ to: string; buildId: string;
	/** the chest's owner and building, for an estate should it be gone */ accountId: string; ownerName: string; room: string; name: string;
	/** what it carries: `count` things of `proto` */ proto: string; count: number; at: number;
};

/** Steps 2 and 3 for every Courier in `here`, until `halt`: run by the world workers of a region. */
export async function carryCouriers(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, halt: AbortSignal): Promise<void> {
	while (!halt.aborted) {
		try {
			const waiting = await here.readAll({ type: "Courier" }, { limit: 8 });
			if (!waiting.length) { await awaitWork(here, { type: "Courier" }, halt); continue; }
			for (const e of waiting) await carryOne(here, regions, w, e);
		} catch (err) {
			if (halt.aborted) break;
			console.error("[courier]", (err as Error).message);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

async function carryOne(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, e: Taken): Promise<void> {
	const txn = (await here.createTransaction(60_000)).id;
	try {
		const taken = await here.takeIfExists({ id: e.id }, NO_WAIT, { txn });
		if (!taken) { await here.abort(txn); return; } // another worker carries it
		const f = fieldsOf<CourierFields>(taken);
		const there = regions.get(f.to);
		if (!there) throw new Error(`no address for the region ${f.to}`);
		// where they go: the chest, else the estate of its ruin, else a new estate where it stood
		let to = f.buildId;
		if (!(await there.readIfExists({ type: "Building", fields: { buildId: f.buildId } }, NO_WAIT))) {
			to = `est-${f.buildId}`;
			if (!(await there.readIfExists({ type: "Estate", fields: { estateId: to } }, NO_WAIT))) {
				const est: EstateFields = { estateId: to, accountId: f.accountId, ownerName: f.ownerName, room: f.room, name: f.name, untilWorldMs: (await worldNowOf(there)) + (w.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
				await there.write({ type: "Estate", fields: est as never }, null, FOREVER);
			}
		}
		const things = await here.readAll({ type: "Item", fields: { location: f.courierId } }, { txn });
		// one already there, wherever it lies by now (an earlier try got that far and someone took it out): not again
		for (const t of things) if (!(await there.readAll({ type: "Item", fields: { itemId: t.fields.itemId } }, { limit: 1 })).length) await there.write({ type: t.type, types: t.types.slice(1), fields: { ...t.fields, location: to, x: -1, y: -1 } as never }, null, FOREVER);
		for (const t of things) await here.takeIfExists({ id: t.id }, NO_WAIT, { txn });
		await here.commit(txn);
	} catch (err) { await here.abort(txn).catch(() => {}); throw err; }
}
