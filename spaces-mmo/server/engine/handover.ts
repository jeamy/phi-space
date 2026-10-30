// A character crossing to another region (regions.ts, docs/welt-aufteilen.md "Übergabe zwischen Regionen"). phi-spaces
// has no transaction across two spaces, so the crossing goes in steps, each atomic and repeatable:
//   1. in region A, in the command's transaction: the character, its cell and its account are taken and a Handover
//      written (handOff). The character is now in neither region; what it carries stays in A, out of anyone's reach.
//   2. a world worker of A takes the Handover in a transaction of A and carries the pack over, a few things at a time
//      (carryPack, a full pack does not fit one transaction): written in B, then taken in A. A thing already in B means
//      an earlier try got that far: it is not written twice.
//   3. when the pack is over, the character is written into region B, in one transaction of B: account, character on a
//      free cell near the ferry's landing, its token. A character already in B: an earlier try got that far.
//   4. A's transaction is committed: the Handover and the old token are gone.
// A worker that dies in steps 2 or 3 lets A's transaction lapse; the Handover is back and the next try finishes it.
import { FOREVER, NO_WAIT, StillHeld, takeExisting, type BatchOp, type BatchResult, type SpaceLike, type Taken } from "phi-spaces";
import { actorToken, fieldsOf, type AccountFields, type CharacterFields, type RoomFields } from "../model.ts";
import { awaitWork, envMs, peek, readExisting } from "../space.ts";
import { CommandError, type CommandCtx } from "./context.ts";
import { blockedIn, claimSpot, freeCellNear, isPassage, occupiedIn } from "./occupancy.ts";
import type { WorldDef } from "./world.ts";

/** A guest account's lease, as the accounts write it (accounts.ts). */
const GUEST_MS = () => envMs("SPACES_MMO_GUEST_TTL_MS", 7 * 24 * 3600_000);

export type HandoverFields = {
	handoverId: string; charId: string; from: string; to: string;
	/** The character as it arrives: in the room of the other region, at the ferry's landing (moved to a free cell there). */
	character: CharacterFields;
	account: AccountFields | null;
	/** Only in a Handover written before the pack went on its own (carryPack): an old one still arrives with its things. */
	items?: Array<{ type: string; types: string[]; fields: Record<string, unknown> }>;
	at: number;
};

/** Step 1, inside the command's transaction in region `from`: the character leaves this region for `dest` in `to`. */
export async function handOff(c: CommandCtx, from: string, to: string, dest: { room: string; x: number; y: number }): Promise<void> {
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
		handoverId: `h-${c.actor.charId}-${Date.now().toString(36)}`, charId: c.actor.charId, from, to,
		character: { ...ch, ...dest, ...(c.step ? { ack: c.step } : {}) }, account: acc ? fieldsOf<AccountFields>(acc) : null, at: Date.now(),
	};
	await c.space.write({ type: "Handover", fields: handover as never }, c.txn, FOREVER);
}

/** Several steps in one call: both kinds of space have it, `SpaceLike` does not name it. */
const batch = (space: SpaceLike, ops: BatchOp[]) => (space as SpaceLike & { batch(ops: BatchOp[]): Promise<BatchResult[]> }).batch(ops);

/** How many things go over in one step: a commit has a limit, a full pack would not fit. */
const PACK_PER_STEP = 40;

/** Step 2: what `charId` carries goes from `here` to `there`. Written there first, so a worker dying in between finds the
 *  thing there on the next try and only takes it here; nobody touches it, the character is in neither region yet. Each
 *  step is one call to each space: a crossing is a step the player waits for, and a pack has hundreds of things. */
export async function carryPack(here: SpaceLike, there: SpaceLike, charId: string): Promise<void> {
	for (;;) {
		const step = await here.readAll({ type: "Item", fields: { location: charId } }, { limit: PACK_PER_STEP });
		if (!step.length) return;
		const over = new Set((await there.readAll({ type: "Item", fields: { location: charId } })).map((e) => e.fields.itemId));
		const missing = step.filter((e) => !over.has(e.fields.itemId));
		if (missing.length) await batch(there, missing.map((e) => ({ op: "write", entry: { type: e.type, types: e.types.slice(1), fields: e.fields as never }, lease: FOREVER })));
		await batch(here, step.map((e) => ({ op: "take", template: { id: e.id } })));
	}
}

/** Step 3 in region `to`'s space: the character arrives. False when it was there already (an earlier try). */
export async function arrive(space: SpaceLike, w: WorldDef, h: HandoverFields): Promise<boolean> {
	const txn = (await space.createTransaction(30_000)).id;
	try {
		if (await readExisting(space, { type: "Character", fields: { charId: h.charId } }, { txn })) { await space.abort(txn); return false; }
		// a guest's account lapses as before (the lapsed guests' cleanup goes by it); a registered one stays
		if (h.account && !(await readExisting(space, { type: "Account", fields: { accountId: h.account.accountId } }, { txn }))) await space.write({ type: "Account", fields: h.account as never }, txn, h.account.guest ? GUEST_MS() : FOREVER);
		const room = (await peek(space, { type: "Room", fields: { roomId: h.character.room } }))?.fields as unknown as RoomFields | undefined;
		let at = { x: h.character.x, y: h.character.y };
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
		await space.write({ type: "Msg", fields: { room: h.character.room, to: "*", kind: "info", text: `${h.character.name} kommt mit dem Kahn an.`, from: "", at: Date.now() } as never }, txn, 60_000);
		await space.commit(txn);
		return true;
	} catch (e) { await space.abort(txn).catch(() => {}); throw e; }
}

/** Steps 2 to 4 for every Handover in `here` (region `from`), until `halt`: run by the world workers of a region. */
export async function deliver(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, halt: AbortSignal): Promise<void> {
	while (!halt.aborted) {
		try {
			const waiting = await here.readAll({ type: "Handover" }, { limit: 8 });
			if (!waiting.length) { await awaitWork(here, { type: "Handover" }, halt); continue; }
			for (const e of waiting) await deliverOne(here, regions, w, e);
		} catch (err) {
			if (halt.aborted) break;
			console.error("[handover]", (err as Error).message);
			await new Promise((r) => setTimeout(r, 1000));
		}
	}
}

async function deliverOne(here: SpaceLike, regions: ReadonlyMap<string, SpaceLike>, w: WorldDef, e: Taken): Promise<void> {
	const txn = (await here.createTransaction(60_000)).id;
	try {
		const taken = await here.takeIfExists({ id: e.id }, NO_WAIT, { txn });
		if (!taken) { await here.abort(txn); return; } // another worker delivers it
		const h = fieldsOf<HandoverFields>(taken);
		const there = regions.get(h.to);
		if (!there) throw new Error(`no address for the region ${h.to}`);
		await carryPack(here, there, h.charId);
		await arrive(there, w, h);
		// the old token: a command of this character can no longer run here
		await here.takeIfExists(actorToken(h.charId), NO_WAIT, { txn });
		await here.commit(txn);
	} catch (err) { await here.abort(txn).catch(() => {}); throw err; }
}
