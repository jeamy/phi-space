// The passengers of the large ship (engine/liner.ts): `einschiffen` takes the fare and the figure goes aboard; the ship sails
// on its loop, and the figure lands when it reaches the island, by an intent the tick sends (`ausschiffen`), so it goes
// through the same commands as everything else, across regions with the handover.
import { NO_WAIT, FOREVER, type SpaceLike } from "phi-spaces";
import { fieldsOf, type CharacterFields, type PassageFields, type IntentFields } from "../../model.ts";
import type { Command } from "../cmdsets.ts";
import { CommandError, msg, roomOf, type CommandCtx } from "../context.ts";
import { handOff } from "../handover.ts";
import { regionOfRoom } from "../regions.ts";
import { worldNowOf } from "../clock.ts";
import { releaseSpot } from "../occupancy.ts";
import { dropOffers, placeIn, relocate } from "./default.ts";
import { randomBytes } from "node:crypto";
import { countTrip } from "../travel.ts";

const mins = (ms: number) => Math.max(1, Math.ceil(ms / 60_000));

/** Goes aboard: the figure is hidden from the room and walks no more until the ship has reached `p.to`. */
export async function board(c: CommandCtx, p: { to: string; island: string; spot: { x: number; y: number }; arriveWorldMs: number }): Promise<void> {
	await countTrip(c, "ship");
	const now = await worldNowOf(c.space, c.txn);
	await msg(c, "*", "info", `$you() $conj(gehst|geht) an Bord, nach ${p.island}.`, { templ: true });
	const e = await c.space.take({ type: "Character", fields: { charId: c.actor.charId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Deine Figur ist gerade nicht greifbar; bitte noch einmal.");
	const ch = fieldsOf<CharacterFields>(e);
	await c.space.write({ type: "Character", fields: { ...ch, aboard: { to: p.to, island: p.island, spot: p.spot, arriveWorldMs: p.arriveWorldMs }, ...(c.step ? { ack: c.step } : {}) } as never }, c.txn, FOREVER);
	await releaseSpot(c.space, c.txn, c.actor.charId);
	await c.space.write({ type: "Passage", fields: { charId: c.actor.charId, to: p.to, arriveWorldMs: p.arriveWorldMs } satisfies PassageFields as never }, c.txn, FOREVER);
	await msg(c, c.actor.charId, "info", `Das Schiff legt ab. Du fährst nach ${p.island}, Ankunft in etwa ${mins(p.arriveWorldMs - now)} Weltminuten.`);
}

/** What an aboard figure may do: look around, talk, read; the rest waits for the landing. */
const ABOARD = new Set(["look", "inventory", "who", "time", "reputation", "help", "fahrplan", "ausschiffen", "say", "emote", "epoche", "wetter"]);
export const mayAboard = (key: string) => ABOARD.has(key);

/** The refusal text of a figure aboard. */
export async function aboardText(c: CommandCtx): Promise<string> {
	const a = c.actor.aboard!;
	return `Du bist an Bord und fährst nach ${a.island}, Ankunft in etwa ${mins(a.arriveWorldMs - (await worldNowOf(c.space, c.txn)))} Weltminuten.`;
}

const ausschiffen: Command = {
	key: "ausschiffen", aliases: ["disembark", "landen"],
	help: "ausschiffen – an Bord des großen Schiffs: von Bord gehen, sobald es die Insel erreicht hat (das geschieht von selbst)",
	async func(c) {
		const a = c.actor.aboard;
		if (!a) throw new CommandError("Du bist nicht an Bord eines Schiffs.");
		const now = await worldNowOf(c.space, c.txn);
		if (now < a.arriveWorldMs) throw new CommandError(await aboardText(c));
		// the figure is free again: no longer aboard, the passage entry gone, then to the bay (across regions by the handover)
		const e = await c.space.take({ type: "Character", fields: { charId: c.actor.charId } }, 5_000, { txn: c.txn });
		if (!e) throw new CommandError("Deine Figur ist gerade nicht greifbar; bitte noch einmal.");
		const { aboard: _was, ...ch } = fieldsOf<CharacterFields>(e);
		await c.space.write({ type: "Character", fields: ch as never }, c.txn, FOREVER);
		await c.space.takeIfExists({ type: "Passage", fields: { charId: c.actor.charId } }, NO_WAIT, { txn: c.txn });
		const toRegion = c.world.region && !c.world.rooms.some((r) => r.roomId === a.to) ? regionOfRoom({ ...c.world, rooms: c.world.allRooms ?? c.world.rooms }, a.to) : null;
		if (toRegion) { await dropOffers(c); return handOff(c, c.world.region!, toRegion, { room: a.to, ...a.spot }); }
		const dest = await roomOf(c, a.to), cell = await placeIn(c, dest, a.spot);
		await relocate(c, { room: dest.roomId, x: cell.x, y: cell.y }, { spot: false });
		await msg(c, "*", "info", `$you() $conj(kommst|kommt) in ${a.island} an.`, { templ: true, room: dest.roomId });
	},
};

export const PASSAGE_COMMANDS: Command[] = [ausschiffen];

/** The landings whose time has come, as intents of the figures (in the job of the garden). How many were sent. */
export async function passageTick(space: SpaceLike, _leaseMs: number): Promise<number> {
	const passages = await space.readAll({ type: "Passage" });
	if (!passages.length) return 0;
	const now = await worldNowOf(space);
	let sent = 0;
	for (const e of passages) {
		const p = fieldsOf<PassageFields>(e);
		if (p.arriveWorldMs > now || (await space.count({ type: "Intent", fields: { charId: p.charId } }))) continue;
		await space.write({ type: "Intent", fields: { intentId: randomBytes(8).toString("hex"), charId: p.charId, line: "ausschiffen", at: Date.now() } satisfies IntentFields as never }, null, 30_000);
		sent++;
	}
	return sent;
}
