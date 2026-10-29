// What a command sees (docs/evennia-abbildung.md, "Ablauf eines Befehls"): the space and the transaction its intent
// is taken in, the world, the actor and its account, and helpers every command needs: finding things by name,
// asking locks, writing messages.
import { NO_WAIT, type SpaceLike, type Taken } from "phi-spaces";
import { fieldsOf, type AccountFields, type CharacterFields, type ExitFields, type ItemFields, type MsgFields, type MsgKind, type RoomFields } from "../model.ts";
import { allowed, LEVELS, type Level, type LockCtx } from "./locks.ts";
import type { WorldDef } from "./world.ts";
import { peek, supports } from "../space.ts";

export type CommandCtx = {
	space: SpaceLike;
	txn: string;
	world: WorldDef;
	actor: CharacterFields;
	account: AccountFields | null;
	/** Reads the account when `account` was left out (a step reads it only if a lock asks, e.g. on an exit's cell). */
	loadAccount?: () => Promise<AccountFields | null>;
	msgLeaseMs: number;
	/** The sentence this command was translated from by the model process, if it was. */
	asked?: string;
	/** A numbered step of a page: written on the character with the step, taken or not (CharacterFields.ack). */
	step?: { conn: string; seq: number };
	/** Memo of the actor's inventory for this command (read once, outside the transaction). */
	cache: { inventory?: Array<{ e: Taken; f: ItemFields }> };
};

/** A refusal shown to the actor; the transaction is aborted. */
export class CommandError extends Error {}
/** A refusal that means "not understood" (no thing, person or exit of that name, a command without what it needs), not
 *  "not now": with model calls on, the model process reads the sentence once before the refusal is shown ("holstücke"). */
export class NotUnderstood extends CommandError {}

/** The account's level: an admin has every level; `perms` adds Builder; a guest is a guest. */
export function levelOf(a: AccountFields | null): Level {
	if (!a) return "Guest";
	if (a.admin) return "Admin";
	if (a.perms?.includes("Builder")) return "Builder";
	return a.guest ? "Guest" : "Player";
}

export async function inventory(c: CommandCtx): Promise<Array<{ e: Taken; f: ItemFields }>> {
	c.cache.inventory ??= (await c.space.readAll({ type: "Item", fields: { location: c.actor.charId } })).map((e) => ({ e, f: fieldsOf<ItemFields>(e) }));
	return c.cache.inventory;
}

export async function lockCtx(c: CommandCtx): Promise<LockCtx> {
	if (!c.account && c.loadAccount) { c.account = await c.loadAccount(); delete c.loadAccount; }
	const inv = await inventory(c);
	const level = levelOf(c.account);
	return { level, guest: c.account?.guest ?? true, charId: c.actor.charId, holds: (k) => inv.some((i) => i.f.itemId === k || i.f.proto === k) };
}

/** Whether the actor passes `access` on `locks`; else a CommandError with `refusal`. */
export async function check(c: CommandCtx, locks: string, access: string, refusal: string): Promise<void> {
	if (!allowed(locks, access, await lockCtx(c))) throw new CommandError(refusal);
}

export async function roomOf(c: CommandCtx, roomId = c.actor.room): Promise<RoomFields> {
	const r = await peek(c.space, { type: "Room", fields: { roomId } });
	if (!r) throw new CommandError("Dieser Ort ist verschwunden.");
	return r.fields as unknown as RoomFields;
}

/** Edits between two words (a letter missing, added, changed, or two swapped), counted up to `max` + 1. */
export function typos(a: string, b: string, max: number): number {
	if (Math.abs(a.length - b.length) > max) return max + 1;
	let prev2: number[] = [], prev = Array.from({ length: b.length + 1 }, (_, j) => j);
	for (let i = 1; i <= a.length; i++) {
		const row = [i];
		for (let j = 1; j <= b.length; j++) {
			let d = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d = Math.min(d, prev2[j - 2]! + 1);
			row.push(d);
		}
		prev2 = prev; prev = row;
	}
	return prev[b.length]!;
}
/** How many typos a word of this length may have and still mean a name: none below four letters, one, two from eight. */
const tolerance = (n: string) => (n.length < 4 ? 0 : n.length < 8 ? 1 : 2);

/** A word without its German plural or case ending and with plain vowels: "hölzer" → "holz", "muscheln" → "muschel",
 *  "münzen" → "munz", "münze" → "munz", "holzstücke" → "holz" (both sides of a comparison are stemmed alike). */
export function stem(word: string): string {
	let w = word.toLowerCase().replace(/ä/g, "a").replace(/ö/g, "o").replace(/ü/g, "u").replace(/ß/g, "ss");
	// a measure run into the name: "holzstücke", "holzscheite" are the "holz"
	w = w.replace(/^(.{3,}?)(?:stuckchen|stucke?n?|scheite?n?)$/, "$1");
	for (const end of ["ern", "er", "en", "e", "n", "s"]) if (w.length - end.length >= 3 && w.endsWith(end)) { w = w.slice(0, -end.length); break; }
	return w;
}

/** Things named `name` (name or alias, case-insensitive; exact matches first, then prefixes, then the same word in
 *  another form ("hölzer" is the "holz"), then names with a typo or two: "feur" is the fire), nearest first. */
export function byName<T extends { name: string; aliases: string[] }>(list: Array<{ e: Taken; f: T }>, name: string, near?: { x: number; y: number }): Array<{ e: Taken; f: T }> {
	const n = name.trim().toLowerCase();
	if (!n) return [];
	const names = (f: T) => [f.name, ...f.aliases].map((s) => s.toLowerCase());
	const exact = list.filter((i) => names(i.f).includes(n));
	const prefix = exact.length ? exact : list.filter((i) => names(i.f).some((s) => s.startsWith(n)));
	const forms = prefix.length ? prefix : list.filter((i) => names(i.f).some((s) => stem(s) === stem(n)));
	// a typo in the word or in its stem: "feur" is the "feuer", "holstücke" the "holz"
	// (a stem keeps one typo from three letters: "holstücke" → "hol", the "s" taken for the measure's)
	const sn = stem(n), st = sn.length < 3 ? 0 : Math.max(1, tolerance(sn));
	const near1 = (s: string) => typos(n, s, tolerance(n)) <= tolerance(n) || (st > 0 && typos(sn, stem(s), st) <= st);
	const hits = forms.length || !tolerance(n) ? forms : list.filter((i) => names(i.f).some(near1));
	const d = (f: T) => (near && "x" in f ? Math.max(Math.abs((f as unknown as { x: number }).x - near.x), Math.abs((f as unknown as { y: number }).y - near.y)) : 0);
	return hits.sort((a, b) => d(a.f) - d(b.f));
}

export async function itemsHere(c: CommandCtx): Promise<Array<{ e: Taken; f: ItemFields }>> {
	return (await c.space.readAll({ type: "Item", fields: { location: c.actor.room } })).map((e) => ({ e, f: fieldsOf<ItemFields>(e) }));
}
export async function exitsHere(c: CommandCtx, roomId = c.actor.room): Promise<Array<{ e: Taken; f: ExitFields }>> {
	return (await c.space.readAll({ type: "Exit", fields: { location: roomId } })).map((e) => ({ e, f: fieldsOf<ExitFields>(e) }));
}

/** Chebyshev distance: 1 means on a neighbouring cell (diagonals count). */
export const reach = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** Whether a message is kept as an entry. Only what someone reads later is: speech in a room (the NPC scripts listen to
 *  it), a channel, and anything said to an NPC (its script counts its refusals). The rest goes to the screens through
 *  the change stream alone (a transient write, core.announce): no entry, no expiry and no removal afterwards; a web
 *  process that starts anew has no backlog of it. SPACES_MMO_MSG_TRANSIENT=0 keeps every message. */
export async function msgOptions(space: SpaceLike, m: Pick<MsgFields, "to" | "kind">): Promise<{ transient?: true }> {
	if (process.env.SPACES_MMO_MSG_TRANSIENT === "0" || m.kind === "say" || m.to.startsWith("#") || m.to.startsWith("npc-")) return {};
	return (await supports(space, "write.transient")) ? { transient: true } : {};
}

/** A message from the actor in `room` (default its room). `templ`: the text holds $you()/$conj() and is rendered per
 *  reader. `txn` null writes it at once (a refusal after the abort). */
export async function msg(c: Pick<CommandCtx, "space" | "actor" | "msgLeaseMs"> & { txn: string | null }, to: string, kind: MsgKind, text: string, o: { templ?: boolean; room?: string; help?: MsgFields["help"] } = {}): Promise<void> {
	const m: MsgFields = { room: o.room ?? c.actor.room, to, kind, text, from: c.actor.name, fromId: c.actor.charId, at: Date.now(), ...(o.templ ? { actor: c.actor.charId } : {}), ...(o.help ? { help: o.help } : {}) };
	await c.space.write({ type: "Msg", fields: m as never }, c.txn, c.msgLeaseMs, await msgOptions(c.space, m));
}

export { LEVELS };
