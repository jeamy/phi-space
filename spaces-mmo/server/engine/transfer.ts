// What goes from one region to another (docs/welt-aufteilen.en.md "Übergabe zwischen Regionen", docs/welten-foederation.en.md).
// phi-spaces has no transaction across two spaces, so every such way has the same shape, and this module is it:
//   1. in region A, inside the transaction of the command that starts it, an order of its own type is written (a
//      Handover, a Courier) and what it carries is put out of anyone's reach in A (a location only the order names).
//   2. a world worker of A takes the order in a transaction of A (carryOut) and does the order's steps against region B
//      (`carry`): each step is atomic on its own and can be repeated, so a try that died in between is finished by the
//      next one. Things go over by moveThings: written in B first, then taken in A.
//   3. A's transaction is committed: the order is gone. A worker that dies before lets A's transaction lapse; the order is
//      back and the next try takes it.
// An order type is a Carrier: its entry type, the region it goes to, and its steps. handover.ts (a character crossing)
// and courier.ts (things into a chest of one's own) are the two there are.
import { FOREVER, NO_WAIT, type BatchOp, type BatchResult, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf } from "../model.ts";
import { awaitWork } from "../space.ts";

/** Several steps in one call: both kinds of space have it, `SpaceLike` does not name it. */
export const batch = (space: SpaceLike, ops: BatchOp[]) => (space as SpaceLike & { batch(ops: BatchOp[]): Promise<BatchResult[]> }).batch(ops);

/** How many things go over in one step: a commit has a limit (192 KiB), a full pack would not fit. */
export const THINGS_PER_STEP = 40;

export type MoveOptions = {
	/** Things that hold things of their own (a boat's hatch, a bill's coins: `location` = their itemId) by their proto:
	 *  what they hold goes first, while the holder is still in A to name it. */
	holders?: readonly string[];
	/** Things that may be taken out in B before A has let them go (a chest someone can open): one already anywhere in B
	 *  is not written again. Without it only the destination is looked at (a pack: nobody touches it on the way). */
	anywhere?: boolean;
};

/** Moves every Item at `from` in `here` to `to` in `there`, THINGS_PER_STEP at a time, each step one call to each space:
 *  written there first (one already there is not written twice: an earlier try got that far), then taken here. Nobody
 *  else may touch what lies at `from` (step 1 put it there). Gives how many it wrote. */
export async function moveThings(here: SpaceLike, there: SpaceLike, from: string, to: string, o: MoveOptions = {}): Promise<number> {
	let wrote = 0;
	for (const proto of o.holders ?? []) for (const h of await here.readAll({ type: "Item", fields: { location: from, proto } })) {
		const id = String(h.fields.itemId);
		wrote += await moveThings(here, there, id, id, o);
	}
	for (;;) {
		const step = await here.readAll({ type: "Item", fields: { location: from } }, { limit: THINGS_PER_STEP });
		if (!step.length) return wrote;
		const there_ = o.anywhere
			? new Set((await batch(there, step.map((e) => ({ op: "read", template: { type: "Item", fields: { itemId: e.fields.itemId } } }) as BatchOp))).flatMap((r, i) => (r && "entry" in r && r.entry ? [step[i]!.fields.itemId] : [])))
			: new Set((await there.readAll({ type: "Item", fields: { location: to } })).map((e) => e.fields.itemId));
		const missing = step.filter((e) => !there_.has(e.fields.itemId));
		const moved = (e: Taken) => (from === to ? e.fields : { ...e.fields, location: to, x: -1, y: -1 });
		if (missing.length) await batch(there, missing.map((e) => ({ op: "write", entry: { type: e.type, types: e.types.slice(1), fields: moved(e) as never }, lease: FOREVER })));
		wrote += missing.length;
		await batch(here, step.map((e) => ({ op: "take", template: { id: e.id } })));
	}
}

/** A kind of order that goes out of a region. */
export type Carrier<F> = {
	/** The entry type of its orders in A ("Handover", "Courier"). */
	type: string;
	/** For the log. */
	name: string;
	/** The region the order goes to. */
	to(f: F): string;
	/** Step 2: everything the order does, each part repeatable; `txn` is A's transaction that holds the order (what is
	 *  taken in it goes with the order's end). */
	carry(here: SpaceLike, there: SpaceLike, f: F, txn: string): Promise<void>;
};

/** Steps 2 and 3 for every order of `carrier` in `here`, until `halt`: run by the world workers of a region. */
export async function carryOut<F>(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, carrier: Carrier<F>, halt: AbortSignal): Promise<void> {
	while (!halt.aborted) {
		try {
			const waiting = await here.readAll({ type: carrier.type }, { limit: 8 });
			if (!waiting.length) { await awaitWork(here, { type: carrier.type }, halt); continue; }
			for (const e of waiting) await carryOne(here, regions, carrier, e);
		} catch (err) {
			if (halt.aborted) break;
			console.error(`[${carrier.name}]`, (err as Error).message);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

/** One order: taken in a transaction of A, carried, then A commits. */
export async function carryOne<F>(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, carrier: Carrier<F>, e: Taken): Promise<void> {
	const txn = (await here.createTransaction(60_000)).id;
	try {
		const taken = await here.takeIfExists({ id: e.id }, NO_WAIT, { txn });
		if (!taken) { await here.abort(txn); return; } // another worker carries it
		const f = fieldsOf<F>(taken);
		const there = regions.get(carrier.to(f));
		if (!there) throw new Error(`no address for the region ${carrier.to(f)}`);
		await carrier.carry(here, there, f, txn);
		await here.commit(txn);
	} catch (err) { await here.abort(txn).catch(() => {}); throw err; }
}
