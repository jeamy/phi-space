// The entries of spaces-mmo (docs/evennia-abbildung.md). The world space holds the game; the accounts space only the
// credentials, the web sessions and the lock that keeps names unique. Every entry has its own id field (accountId,
// charId, …): a change is a take and a write, which gives the entry a new space id, so nothing refers to space ids.
import type { Fields } from "phi-spaces";

/** World space. `guest` accounts carry a lease (renewed on activity); registered ones live until deleted. `perms`:
 *  levels granted on top (Builder); an admin has every level. */
export type AccountFields = { accountId: string; name: string; guest: boolean; admin: boolean; createdAt: number; touchedAt: number; perms?: string[]; npc?: boolean };
/** One character per account; `guest` mirrors the account so the cleanup can find orphans. A character's location is
 *  always a room (`room`); items use `location`, which may also be a character. */
export type CharacterFields = { charId: string; accountId: string; name: string; room: string; x: number; y: number; skin: number; guest: boolean };

/** How an object looks on the map until it has a sprite (no item graphics are licensed yet). */
export type Glyph = { shape: "circle" | "square" | "diamond"; color: string };
/** A thing: on the ground of a room (`location` = roomId, at x/y) or carried (`location` = charId, x/y = -1). The entry
 *  type is its typeclass, the supertypes include "Item" and "Object". */
export type ItemFields = { itemId: string; name: string; aliases: string[]; desc: string; location: string; x: number; y: number; glyph: Glyph; locks: string; proto: string; flotsam?: boolean; expiresWorldMs?: number;
	/** A tool: uses left (it breaks at 0). */ wear?: number;
	/** On the market board: `location` is "market", these name the listing and who gets it back. */ listing?: string; seller?: string };
/** A way out of a room, on a cell of it; stepping on the cell or `go <name>` leads to `destination`, arriving at `arrive`. */
export type ExitFields = { exitId: string; name: string; aliases: string[]; desc: string; location: string; destination: string; x: number; y: number; arrive: { x: number; y: number }; locks: string; fogMax?: number };
/** A label on an object (Tags cannot be array fields: templates match whole values). */
export type TagFields = { target: string; key: string; category: string };
/** A template to spawn items from; `parent` names the prototype whose fields it extends. */
export type PrototypeFields = { key: string; parent: string | null; typeclass: string; name: string; desc: string; aliases: string[]; glyph: Glyph; locks: string; wear?: number };
/** A beacon: where a fire can burn. It is also the lock every change of its fire takes (feeding, the fire tick), so
 *  two players feeding at once cannot light two flames. `lit` is what the fire tick last saw. */
export type BeaconFields = { beaconId: string; name: string; aliases: string[]; room: string; x: number; y: number; covers: string[]; lit: boolean };
/** A fire: it burns while the world time is before `until` (world milliseconds, docs/weltzeit.md); it stays as an entry
 *  when it has gone out, and the clock decides. `litAt`: since when it burns, in world time. */
export type FlameFields = { beaconId: string; until: number; litAt: number };
/** What a character has put into a beacon (its reputation there). */
export type ContributionFields = { beaconId: string; charId: string; name: string; pieces: number; ms: number };
/** The fog of a room, 0 (clear) to the world's maximum; the fog tick raises it without fire and lowers it with fire. */
export type FogFields = { room: string; level: number };
/** A recurring job (Evennia's Script/TickerHandler): due at `due`; the world worker that takes it runs it once. */
export type TickerFields = { key: string; due: number };
/** The world's clock (docs/weltzeit.md), one entry per world: the world time is `worldAnchorMs + (now - realAnchorMs) * rate`
 *  (unless `paused`). A change takes the entry and writes it again with both anchors moved to the moment of the change. */
export type WorldClockFields = { worldId: string; epoch: number; realAnchorMs: number; worldAnchorMs: number; rate: number; paused: boolean; version: number };
/** A date in world time (docs/weltzeit.md): fires once when the world time reaches `dueWorldMs`. `kind` names the handler
 *  (server/engine/worldevents.ts); `scheduleId` is the deterministic key (one entry per id). `missed`: what a late one does
 *  (the clock was behind: a restart, a pause): `once` runs it, `coalesce` runs it once and goes on from now; a later
 *  `replay-bounded` is not implemented. */
export type WorldScheduleFields = { scheduleId: string; clockEpoch: number; dueWorldMs: number; kind: string; payload: Record<string, unknown>; missed: "once" | "coalesce" | "replay-bounded" };
/** What a schedule leaves for the processes that watch the world: one entry per `eventId` (`evening:e1:d183`), so a day's
 *  event exists once however many workers run the schedule. It lapses (real time) after a few minutes. */
export type WorldEventFields = { eventId: string; kind: string; worldMs: number; epoch: number; day: number };
/** A direct trade: `from` offers the items `give` (still in its pack until accepted) to `to`, for `want` (names and
 *  counts, taken from `to`'s pack on accept). Accepting moves all of it in one transaction or nothing. */
export type OfferFields = { offerId: string; from: string; fromName: string; to: string; toName: string; give: string[]; giveNames: string[]; want: Array<{ name: string; count: number }>; room: string; at: number };
/** A listing on the market board: the item waits in escrow (location "market") until bought, withdrawn or the lease
 *  ends (then the market ticker gives it back). Prices are counted in coins (prototype `currency` of the world). */
export type ListingFields = { listingId: string; seller: string; sellerName: string; itemId: string; itemName: string; price: number; room: string; at: number; expiresWorldMs?: number };
/** A job on the order board (master–worker): posted by the world, taken by one player, delivered for a reward. */
export type OrderFields = { orderId: string; kind: string; text: string; needs: Array<{ proto: string; count: number }>; reward: { proto: string; count: number }; takenBy: string; room: string; expiresWorldMs?: number };
/** A help topic of the world. */
export type HelpEntryFields = { key: string; category: string; text: string };
/** Which version of a world's definition the space holds (written by the loader). */
export type WorldLoadedFields = { worldId: string; version: number; at: number };
/** A room of the loaded world: its grid of tile keys, one string per row. */
export type RoomFields = { roomId: string; name: string; desc: string; ground: string[]; spawn?: { x: number; y: number }; map?: { x: number; y: number }; island?: string };
/** A character being played right now: held by the web process with a short lease while the WebSocket is open. */
export type SessionFields = { sessionId: string; charId: string; accountId: string };
/** One command line, written by the web process (or later an NPC), taken by a world worker. */
export type IntentFields = { intentId: string; charId: string; line: string; at: number; asked?: string };
/** A sentence no rule understood, for the model process to turn into a command (an Intent with `asked`). */
export type TranslateFields = { reqId: string; charId: string; accountId: string; guest: boolean; line: string; room: string; at: number };
/** Output: to one character (`to` = its charId), to everyone in `room` (`to` = "*"), or to everyone on a channel
 *  (`to` = "#hafen"). With `actor` (a charId) the text
 *  holds FuncParser calls ($you(), $conj(a|b)) that the gateway renders for each reader. */
/** `fromId`: the speaker's charId (NPCs start with "npc-"), so model NPCs answer people, not each other. */
export type MsgFields = { room: string; to: string; kind: MsgKind; text: string; from: string; at: number; actor?: string; fromId?: string };
export type MsgKind = "say" | "emote" | "system" | "look" | "error" | "help" | "who" | "info" | "channel" | "world";

/** Accounts space. `key` is the lower-cased name; a `pending` credential belongs to a registration in progress. */
export type CredentialFields = { key: string; name: string; accountId: string; salt: string; hash: string; state: "pending" | "active" };
/** A web login: `key` is the SHA-256 of the cookie value (the cookie itself is never stored). */
export type WebSessionFields = { key: string; accountId: string; at: number };
/** The one lock entry every registration takes (in a transaction) while it checks and claims a name. */
export const NAMES_LOCK = { type: "Lock", fields: { name: "names" } } as const;
/** World space: one token per character. A world worker takes it (in the command's transaction) before it takes the
 *  character's oldest intent and writes it back on commit, so one character's commands run one after another, in
 *  order, while other characters' commands run in parallel on other workers. */
export const actorToken = (charId: string) => ({ type: "ActorToken", fields: { charId } });
/** World space: one token per room. Whoever moves in a room or arrives in it takes it (in the command's transaction),
 *  so checking that a cell is free and stepping onto it is one step: two characters never stand on one cell. */
export const roomToken = (room: string) => ({ type: "RoomToken", fields: { room } });
/** World space: the lock a world worker takes while it loads the world definition, so two loading at once cannot
 *  both spawn the placed items. */
export const WORLD_LOCK = { type: "Lock", fields: { name: "world" } } as const;
/** World space: the lock under which an npc process claims a role (so two processes never play one) and under which
 *  an NPC is woken (so no more than SPACES_MMO_NPC_MAX are awake). */
export const NPC_LOCK = { type: "Lock", fields: { name: "npc" } } as const;
/** An npc process plays this role while the lease lives. */
export type NpcOwnerFields = { npcId: string; owner: string };
/** A model NPC is awake (answers with the model) while this lives; its lease is renewed whenever it is spoken to. */
export type NpcAwakeFields = { npcId: string; since: number };
/** What a model NPC remembers (≤ 4 KiB), written by itself with NOTE lines. */
export type NpcMemoryFields = { npcId: string; text: string };

export const asFields = <T extends object>(f: T): Fields => f as unknown as Fields;
export const fieldsOf = <T>(e: { fields: Fields }): T => e.fields as unknown as T;
