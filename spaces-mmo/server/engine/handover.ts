// A character crossing to another region (regions.ts, docs/welt-aufteilen.en.md "Übergabe zwischen Regionen"): one of the
// orders that go out of a region (transfer.ts), in steps, each atomic and repeatable:
//   1. in region A, in the command's transaction: the character, its cell and its account are taken and a Handover
//      written (handOff). The character is now in neither region; what it carries stays in A, out of anyone's reach.
//   2. a world worker of A takes the Handover in a transaction of A and carries the pack over, a few things at a time
//      (moveThings, a full pack does not fit one transaction; what lies in a boat's hatch or backs a bill first): written
//      in B, then taken in A. A thing already in B means an earlier try got that far: it is not written twice.
//   3. when the pack is over, the character is written into region B, in one transaction of B: account, character on a
//      free cell near the ferry's landing, its token. A character already in B: an earlier try got that far.
//   4. A's transaction is committed: the Handover and the old token are gone.
// A worker that dies in steps 2 or 3 lets A's transaction lapse; the Handover is back and the next try finishes it.
import { grownPoint, pinTerrain } from "./room-growth.ts";
import type { RoomGrowthFields } from "../model.ts";
import { FOREVER, NO_WAIT, StillHeld, takeExisting, type SpaceLike, type Taken } from "phi-spaces";
import { actorToken, fieldsOf, type AccountFields, type CharacterFields, type RoomFields } from "../model.ts";
import { envMs, peek, readExisting } from "../space.ts";
import { carryOut, moveThings, type Carrier } from "./transfer.ts";
import { CommandError, type CommandCtx } from "./context.ts";
import { blockedIn, claimSpot, freeCellNear, isPassage, occupiedIn } from "./occupancy.ts";
import type { WorldDef } from "./world.ts";
import { timeNow } from "./source.ts";

/** A guest account's lease, as the accounts write it (accounts.ts). */
const GUEST_MS = () => envMs("SPACES_MMO_GUEST_TTL_MS", 7 * 24 * 3600_000);

export type HandoverFields = {
	handoverId: string; charId: string; from: string; to: string;
	/** The character as it arrives: in the room of the other region, at the ferry's landing (moved to a free cell there). */
	character: CharacterFields;
	account: AccountFields | null;
	/** Only in a Handover written before the pack went on its own (carryPack): an old one still arrives with its things. */
	items?: Array<{ type: string; types: string[]; fields: Record<string, unknown> }>;
	arrivalGrowthRevision?: number;
	at: number;
};

/** Step 1, inside the command's transaction in region `from`: the character leaves this region for `dest` in `to`. */
export async function handOff(c: CommandCtx, from: string, to: string, dest: { room: string; x: number; y: number }, arrivalGrowthRevision = 0): Promise<void> {
	const e = await c.space.take({ type: "Character", fields: { charId: c.actor.charId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Deine Figur ist gerade nicht greifbar; bitte noch einmal.");
	const { refused: _was, ...ch } = fieldsOf<CharacterFields>(e);
	await c.space.takeIfExists({ type: "Spot", fields: { charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
	// the account goes along; one held by another transaction right now is not left behind: the command fails and the
	// intent is tried again
	let acc: Taken | null;
	try { acc = await takeExisting(c.space, { type: "Account", fields: { accountId: ch.accountId } }, 2_000, { txn: c.txn }); }
	catch (e) { if (e instanceof StillHeld) throw new Error("the account is held; the crossing is tried again"); throw e; }
	const handover: HandoverFields = {
		arrivalGrowthRevision,
		handoverId: `h-${c.actor.charId}-${timeNow().toString(36)}`, charId: c.actor.charId, from, to,
		character: { ...ch, ...dest, ...(c.step ? { ack: c.step } : {}) }, account: acc ? fieldsOf<AccountFields>(acc) : null, at: timeNow(),
	};
	await c.space.write({ type: "Handover", fields: handover as never }, c.txn, FOREVER);
}

/** Step 3 in region `to`'s space: the character arrives. False when it was there already (an earlier try). */
export async function arrive(space: SpaceLike, w: WorldDef, h: HandoverFields): Promise<boolean> {
	const txn = (await space.createTransaction(30_000)).id;
	try {
		await pinTerrain(space, txn);
		if (await readExisting(space, { type: "Character", fields: { charId: h.charId } }, { txn })) { await space.abort(txn); return false; }
		// a guest's account lapses as before (the lapsed guests' cleanup goes by it); a registered one stays
		if (h.account && !(await readExisting(space, { type: "Account", fields: { accountId: h.account.accountId } }, { txn }))) await space.write({ type: "Account", fields: h.account as never }, txn, h.account.guest ? GUEST_MS() : FOREVER);
		const room = (await peek(space, { type: "Room", fields: { roomId: h.character.room } }))?.fields as unknown as RoomFields | undefined;
		const growth = (await space.readAll({ type: "RoomGrowth", fields: { roomId: h.character.room } }, { txn }))[0];
		let at = { x: h.character.x, y: h.character.y };
		if (growth) at = grownPoint(at, fieldsOf<RoomGrowthFields>(growth), h.arrivalGrowthRevision ?? 0);
		// the ferry's landing is a passage (occupancy.ts): the character lands there whoever stands on it
		const landing = room ? isPassage((await space.readAll({ type: "Exit", fields: { location: room.roomId } })).map((e) => e.fields as unknown as { x: number; y: number }), at) : false;
		if (room && !landing) {
			const avoid = new Set([...(await occupiedIn(space, room.roomId, h.charId)).keys(), ...(await blockedIn(space, w, room.roomId))]);
			for (let tries = 0; tries < 4; tries++) {
				const cell = freeCellNear(w, room.ground, at, avoid);
				if (!cell) break;
				if (!(await claimSpot(space, txn, h.character, { room: room.roomId, ...cell }))) { at = cell; break; }
				avoid.add(`${cell.x},${cell.y}`);
			}
		}
		await space.write({ type: "Character", fields: { ...h.character, ...at } as never }, txn, FOREVER);
		for (const it of h.items ?? []) await space.write({ type: it.type, types: it.types.slice(1), fields: it.fields as never }, txn, FOREVER);
		if (!(await readExisting(space, actorToken(h.charId), { txn }).catch(() => true))) await space.write(actorToken(h.charId), txn, FOREVER);
		await space.write({ type: "Msg", fields: { room: h.character.room, to: "*", kind: "info", text: `${h.character.name} kommt mit dem Kahn an.`, from: "", at: timeNow() } as never }, txn, 60_000);
		await space.commit(txn);
		return true;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

/** What lies in a boat's hatch or backs a bill of exchange: it goes before its holder (moveThings). */
export const holdersOf = (w: WorldDef) => [...Object.keys(w.boat?.hatch ?? {}), ...(w.bank?.note ? [w.bank.note.proto] : [])];

/** The Handover as an order out of a region: steps 2 to 4. */
export const handovers = (w: WorldDef): Carrier<HandoverFields> => ({
	type: "Handover", name: "handover", to: (h) => h.to,
	async carry(here, there, h, txn) {
		await moveThings(here, there, h.charId, h.charId, { holders: holdersOf(w) });
		await arrive(there, w, h);
		// the old token: a command of this character can no longer run here
		await here.takeIfExists(actorToken(h.charId), NO_WAIT, { txn });
	},
});

/** Steps 2 to 4 for every Handover in `here` (region `from`), until `halt`: run by the world workers of a region. */
export const deliver = (here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, halt: AbortSignal) => carryOut(here, regions, handovers(w), halt);
