// The commands of Phase 0 (docs/phasen.md): look, say, who, help, move. A command runs inside the world process's
// transaction for its intent: what it changes (a character's position) and what it says (Msg entries) commit
// together with the intent being taken, or not at all.
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { asFields, fieldsOf, type CharacterFields, type MsgFields, type MsgKind, type RoomFields, type SessionFields } from "../model.ts";
import { findPath, type WorldDef } from "./world.ts";

export type CommandCtx = { space: SpaceLike; txn: string; world: WorldDef; actor: CharacterFields; msgLeaseMs: number };

/** A refusal shown to the actor; the transaction is aborted. */
export class CommandError extends Error {}

const MAX_SAY = 300;

export async function execute(c: CommandCtx, line: string): Promise<void> {
	line = line.trim();
	if (line.startsWith("'")) line = `say ${line.slice(1)}`;
	const [verb = "", ...rest] = line.split(/\s+/);
	const arg = line.slice(verb.length).trim();
	switch (verb.toLowerCase()) {
		case "look": case "l": return look(c);
		case "say": return say(c, arg);
		case "who": return who(c);
		case "help": case "?": return msg(c, c.actor.charId, "help", c.world.help.join("\n"));
		case "move": return move(c, rest);
		case "": return;
		default: throw new CommandError(`Unbekannter Befehl „${verb.slice(0, 20)}“. „help“ zeigt alle Befehle.`);
	}
}

async function look(c: CommandCtx): Promise<void> {
	const room = await roomOf(c);
	const others = (await onlineIn(c.space, c.actor.room)).filter((ch) => ch.charId !== c.actor.charId).map((ch) => ch.name);
	const people = others.length ? `Hier sind: ${others.join(", ")}.` : "Niemand sonst ist hier.";
	await msg(c, c.actor.charId, "look", `${room.name}\n${room.desc}\n${people}`);
}

async function say(c: CommandCtx, text: string): Promise<void> {
	if (!text) throw new CommandError("Was möchtest du sagen? Zum Beispiel: say Hallo");
	await msg(c, "*", "say", `${c.actor.name}: ${text.slice(0, MAX_SAY)}`);
}

async function who(c: CommandCtx): Promise<void> {
	const online = await onlineIn(c.space, null);
	const rooms = new Map(c.world.rooms.map((r) => [r.roomId, r.name]));
	const list = online.map((ch) => `${ch.name} (${rooms.get(ch.room) ?? ch.room})`).sort();
	await msg(c, c.actor.charId, "who", `Gerade spielen ${list.length}: ${list.join(", ")}`);
}

async function move(c: CommandCtx, args: string[]): Promise<void> {
	const [x, y] = args.map(Number);
	if (args.length !== 2 || !Number.isInteger(x) || !Number.isInteger(y)) throw new CommandError("So geht es: move <x> <y>, zum Beispiel move 10 8");
	const room = await roomOf(c);
	const path = findPath(c.world, room.ground, c.actor, { x: x!, y: y! });
	if (!path) throw new CommandError("Dorthin führt kein Weg.");
	if (!path.length) return;
	const e = await c.space.take({ type: "Character", fields: { charId: c.actor.charId } }, 5_000, { txn: c.txn });
	if (!e) throw new CommandError("Deine Figur ist gerade nicht greifbar; bitte noch einmal.");
	await c.space.write({ type: "Character", fields: asFields<CharacterFields>({ ...fieldsOf<CharacterFields>(e), x: x!, y: y! }) }, c.txn, FOREVER);
}

async function roomOf(c: CommandCtx): Promise<RoomFields> {
	const r = await c.space.readIfExists({ type: "Room", fields: { roomId: c.actor.room } }, NO_WAIT);
	if (!r) throw new CommandError("Dieser Ort ist verschwunden.");
	return fieldsOf<RoomFields>(r);
}

/** Characters with a live session (`room` null: all rooms). */
export async function onlineIn(space: SpaceLike, room: string | null): Promise<CharacterFields[]> {
	const live = new Set((await space.readAll({ type: "Session" })).map((s) => fieldsOf<SessionFields>(s).charId));
	const chars = (await space.readAll({ type: "Character", fields: room ? { room } : {} })).map((e) => fieldsOf<CharacterFields>(e));
	return chars.filter((ch) => live.has(ch.charId));
}

/** A message from the actor's room; `txn` null writes it at once (a refusal after the abort). */
export async function msg(c: Pick<CommandCtx, "space" | "actor" | "msgLeaseMs"> & { txn: string | null }, to: string, kind: MsgKind, text: string): Promise<void> {
	const m: MsgFields = { room: c.actor.room, to, kind, text, from: c.actor.name, at: Date.now() };
	await c.space.write({ type: "Msg", fields: asFields(m) }, c.txn, c.msgLeaseMs);
}
