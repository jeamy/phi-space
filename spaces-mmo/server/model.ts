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
export type ItemFields = { itemId: string; name: string; aliases: string[]; desc: string; location: string; x: number; y: number; glyph: Glyph; locks: string; proto: string; flotsam?: boolean };
/** A way out of a room, on a cell of it; stepping on the cell or `go <name>` leads to `destination`, arriving at `arrive`. */
export type ExitFields = { exitId: string; name: string; aliases: string[]; desc: string; location: string; destination: string; x: number; y: number; arrive: { x: number; y: number }; locks: string; fogMax?: number };
/** A label on an object (Tags cannot be array fields: templates match whole values). */
export type TagFields = { target: string; key: string; category: string };
/** A template to spawn items from; `parent` names the prototype whose fields it extends. */
export type PrototypeFields = { key: string; parent: string | null; typeclass: string; name: string; desc: string; aliases: string[]; glyph: Glyph; locks: string };
/** A beacon: where a fire can burn. It is also the lock every change of its fire takes (feeding, the fire tick), so
 *  two players feeding at once cannot light two flames. `lit` is what the fire tick last saw. */
export type BeaconFields = { beaconId: string; name: string; aliases: string[]; room: string; x: number; y: number; covers: string[]; lit: boolean };
/** A burning fire: its lease is the burn time left, so the space puts it out at the computed moment by itself. */
export type FlameFields = { beaconId: string; until: number; litAt: number };
/** What a character has put into a beacon (its reputation there). */
export type ContributionFields = { beaconId: string; charId: string; name: string; pieces: number; ms: number };
/** The fog of a room, 0 (clear) to the world's maximum; the fog tick raises it without fire and lowers it with fire. */
export type FogFields = { room: string; level: number };
/** A recurring job (Evennia's Script/TickerHandler): due at `due`; the world worker that takes it runs it once. */
export type TickerFields = { key: string; due: number };
/** A help topic of the world. */
export type HelpEntryFields = { key: string; category: string; text: string };
/** Which version of a world's definition the space holds (written by the loader). */
export type WorldLoadedFields = { worldId: string; version: number; at: number };
/** A room of the loaded world: its grid of tile keys, one string per row. */
export type RoomFields = { roomId: string; name: string; desc: string; ground: string[]; spawn?: { x: number; y: number } };
/** A character being played right now: held by the web process with a short lease while the WebSocket is open. */
export type SessionFields = { sessionId: string; charId: string; accountId: string };
/** One command line, written by the web process (or later an NPC), taken by a world worker. */
export type IntentFields = { intentId: string; charId: string; line: string; at: number };
/** Output: to one character (`to` = its charId), to everyone in `room` (`to` = "*"), or to everyone on a channel
 *  (`to` = "#hafen"). With `actor` (a charId) the text
 *  holds FuncParser calls ($you(), $conj(a|b)) that the gateway renders for each reader. */
export type MsgFields = { room: string; to: string; kind: MsgKind; text: string; from: string; at: number; actor?: string };
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

export const asFields = <T extends object>(f: T): Fields => f as unknown as Fields;
export const fieldsOf = <T>(e: { fields: Fields }): T => e.fields as unknown as T;
