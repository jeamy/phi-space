// The entries of spaces-mmo (docs/evennia-abbildung.md). The world space holds the game; the accounts space only the
// credentials, the web sessions and the lock that keeps names unique. Every entry has its own id field (accountId,
// charId, …): a change is a take and a write, which gives the entry a new space id, so nothing refers to space ids.
import type { Fields } from "phi-spaces";

/** World space. `guest` accounts carry a lease (renewed on activity); registered ones live until deleted. */
export type AccountFields = { accountId: string; name: string; guest: boolean; admin: boolean; createdAt: number; touchedAt: number };
/** One character per account (Phase 0); `guest` mirrors the account so the cleanup can find orphans. */
export type CharacterFields = { charId: string; accountId: string; name: string; room: string; x: number; y: number; skin: number; guest: boolean };
/** A room of the loaded world: its grid of tile keys, one string per row. */
export type RoomFields = { roomId: string; name: string; desc: string; ground: string[] };
/** A character being played right now: held by the web process with a short lease while the WebSocket is open. */
export type SessionFields = { sessionId: string; charId: string; accountId: string };
/** One command line, written by the web process (or later an NPC), taken by a world process. */
export type IntentFields = { intentId: string; charId: string; line: string; at: number };
/** Output: to one character (`to` = its charId) or to everyone in `room` (`to` = "*"). */
export type MsgFields = { room: string; to: string; kind: MsgKind; text: string; from: string; at: number };
export type MsgKind = "say" | "system" | "look" | "error" | "help" | "who";

/** Accounts space. `key` is the lower-cased name; a `pending` credential belongs to a registration in progress. */
export type CredentialFields = { key: string; name: string; accountId: string; salt: string; hash: string; state: "pending" | "active" };
/** A web login: `key` is the SHA-256 of the cookie value (the cookie itself is never stored). */
export type WebSessionFields = { key: string; accountId: string; at: number };
/** The one lock entry every registration takes (in a transaction) while it checks and claims a name. */
export const NAMES_LOCK = { type: "Lock", fields: { name: "names" } } as const;

export const asFields = <T extends object>(f: T): Fields => f as unknown as Fields;
export const fieldsOf = <T>(e: { fields: Fields }): T => e.fields as unknown as T;
