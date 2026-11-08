// A courier (docs/siedeln.en.md "Load"): what a player puts into a chest of its own in another region. One of the orders
// that go out of a region (transfer.ts), in steps that can be repeated:
//   1. in region A, in the command's transaction (verstaue): the things move to the courier's id and a Courier is written.
//      They are now out of anyone's reach.
//   2. a world worker of A takes the Courier in a transaction of A, writes the things into region B, in the chest (one
//      already anywhere in B is not written twice: an earlier try got that far, and someone may have taken it out of the
//      chest since), then takes them in A. What a boat's hatch or a bill holds goes with it (moveThings).
//   3. A's transaction is committed: the Courier is gone.
// A chest that has meanwhile become a ruin gets them in its estate (nachlass); a building gone without one in a new
// estate where it stood. A chest that has filled up meanwhile takes them anyway (the command counted what was on its way).
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import type { EstateFields } from "../model.ts";
import { holdersOf } from "./handover.ts";
import { carryOut, moveThings, type Carrier } from "./transfer.ts";
import { worldNowOf } from "./clock.ts";
import type { WorldDef } from "./world.ts";

export type CourierFields = {
	courierId: string; /** the region of the chest */ to: string; buildId: string;
	/** the chest's owner and building, for an estate should it be gone */ accountId: string; ownerName: string; room: string; name: string;
	/** what it carries: `count` things of `proto` */ proto: string; count: number; at: number;
};

/** The Courier as an order out of a region: step 2. */
export const couriers = (w: WorldDef): Carrier<CourierFields> => ({
	type: "Courier", name: "courier", to: (f) => f.to,
	async carry(here, there, f) {
		// where they go: the chest, else the estate of its ruin, else a new estate where it stood
		let to = f.buildId;
		if (!(await there.readIfExists({ type: "Building", fields: { buildId: f.buildId } }, NO_WAIT))) {
			to = `est-${f.buildId}`;
			if (!(await there.readIfExists({ type: "Estate", fields: { estateId: to } }, NO_WAIT))) {
				const est: EstateFields = { estateId: to, accountId: f.accountId, ownerName: f.ownerName, room: f.room, name: f.name, untilWorldMs: (await worldNowOf(there)) + (w.building?.estateWorldMs ?? 30 * 24 * 3600_000) };
				await there.write({ type: "Estate", fields: est as never }, null, FOREVER);
			}
		}
		await moveThings(here, there, f.courierId, to, { holders: holdersOf(w), anywhere: true });
	},
});

/** Steps 2 and 3 for every Courier in `here`, until `halt`: run by the world workers of a region. */
export const carryCouriers = (here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, halt: AbortSignal) => carryOut(here, regions, couriers(w), halt);
