// The room and island locks (docs/3d-welt-und-raster-plan-2026-11-21.en.md section 3, "Locks"): one entry per room and
// one per island. Whoever changes the static occupancy of a room (builds, digs a bed or a field, plants, moves, clears
// or demolishes, lets a site or ruin lapse) takes the room's lock in its transaction and writes it back with the commit;
// an aborted transaction or a lease that runs out brings it back by the space's rules. A command that meets a taken lock
// is refused (`held`, try again), a job waits. Roads across rooms and growth take the island's lock first. Order:
// WORLD_LOCK (shared through pinTerrain, exclusive for loader and growth), then the island lock, then the room locks in
// the order of their IDs. The decisive overlap check reads after taking, inside the transaction (`authoritative`), not
// from the process's copy of the world. A lock is written with its room (loader, `dig`, an inside) and goes with it.
// The Rust engine has the same (rust/mmo-engine/src/room_lock.rs).
import { NO_WAIT, FOREVER, type SpaceLike, type Template } from "phi-spaces";
import { CommandError } from "./context.ts";

export type RoomLockFields = { room: string };
export type IslandLockFields = { island: string };
export const roomLock = (room: string) => ({ type: "RoomLock", fields: { room } });
export const islandLock = (island: string) => ({ type: "IslandLock", fields: { island } });

/** How long a job waits for a room's or an island's lock before it leaves the change to its next run. */
export const LOCK_WAIT_MS = 5_000;
/** What a command meeting a taken room lock says (as the held case of takeNear). */
export const LOCK_HELD = "Hier wird gerade gebaut oder abgeräumt; bitte gleich noch einmal.";

/** Writes a room's lock (with the room; `unique` on the room: a second one is refused). */
export async function writeRoomLock(space: SpaceLike, txn: string | null, room: string): Promise<void> {
	await space.write({ type: "RoomLock", fields: { room } satisfies RoomLockFields as never }, txn, FOREVER, { unique: ["room"] });
}
/** Writes an island's lock (`unique` on the island). */
export async function writeIslandLock(space: SpaceLike, txn: string | null, island: string): Promise<void> {
	await space.write({ type: "IslandLock", fields: { island } satisfies IslandLockFields as never }, txn, FOREVER, { unique: ["island"] });
}
/** Takes a room's lock away with its room, waiting for a holder up to LOCK_WAIT_MS. */
export async function dropRoomLock(space: SpaceLike, txn: string, room: string): Promise<void> {
	await space.takeIfExists(roomLock(room), LOCK_WAIT_MS, { txn });
}

/** Takes `tmpl` (a lock) in `txn` and writes it back there: held until the commit. False: taken by another
 *  transaction now (or not there), within `waitMs`. */
async function hold(space: SpaceLike, txn: string, tmpl: { type: string; fields: Record<string, string> }, waitMs: number): Promise<boolean> {
	const e = await space.takeIfExists(tmpl as Template, waitMs, { txn });
	if (!e) return false;
	await space.write({ type: e.type, fields: e.fields as never }, txn, FOREVER);
	return true;
}

/** A job (sweep, loader, a tick): the room's lock, waiting up to LOCK_WAIT_MS. False: still taken; leave it to the next run. */
export const holdRoom = (space: SpaceLike, txn: string, room: string, waitMs = LOCK_WAIT_MS) => hold(space, txn, roomLock(room), waitMs);
/** A job: an island's lock, then its rooms' locks in the order of their IDs. */
export async function holdIsland(space: SpaceLike, txn: string, island: string, rooms: readonly string[] = [], waitMs = LOCK_WAIT_MS): Promise<boolean> {
	if (!(await hold(space, txn, islandLock(island), waitMs))) return false;
	for (const room of [...new Set(rooms)].sort()) if (!(await holdRoom(space, txn, room, waitMs))) return false;
	return true;
}

/** A command: the room's lock now, or refused (LOCK_HELD). */
export async function holdRoomOrRefuse(c: { space: SpaceLike; txn: string }, room: string): Promise<void> {
	if (!(await holdRoom(c.space, c.txn, room, NO_WAIT))) throw new CommandError(LOCK_HELD);
}
/** A command: an island's lock and its rooms', or refused. */
export async function holdIslandOrRefuse(c: { space: SpaceLike; txn: string }, island: string, rooms: readonly string[]): Promise<void> {
	if (!(await holdIsland(c.space, c.txn, island, rooms, NO_WAIT))) throw new CommandError(LOCK_HELD);
}

/** `space` read inside `txn`: what readAll, count, readIfExists and peek-like reads see after a lock was taken is the
 *  space's current state, not the process's copy (server/space.ts bufferedTxn reads from the copy without a txn). */
export function authoritative(space: SpaceLike, txn: string): SpaceLike {
	return new Proxy(space, {
		get(target, key, receiver) {
			const v = Reflect.get(target, key, receiver);
			if (typeof v !== "function") return v;
			if (key === "readAll") return (tmpl: Template = null, o: { limit?: number; txn?: string | null } = {}) => v.call(target, tmpl, { ...o, txn: o.txn ?? txn });
			if (key === "count") return (tmpl: Template = null, t: string | null = null) => v.call(target, tmpl, t ?? txn);
			if (key === "readIfExists" || key === "read") return (tmpl: Template, ms: number, o: { txn?: string | null } = {}) => v.call(target, tmpl, ms, { ...o, txn: o.txn ?? txn });
			return v.bind(target);
		},
	});
}

/** What differs from one lock per room and one per island (the start check of plan section 5, made by the tests' stack
 *  and the walks): a room without its lock or with two, a lock without its room, the same for the islands of the rooms
 *  that have one. An inside belongs to the island of its building's room and has none of its own. `skipRoom`: rooms a
 *  test wrote by hand; an island only such rooms are on is left out with them. */
export function lockReport(entries: ReadonlyArray<{ type: string; types?: readonly string[]; fields: Record<string, unknown> }>, skipRoom: (room: string) => boolean = () => false): string[] {
	const is = (e: { type: string; types?: readonly string[] }, t: string) => e.type === t || !!e.types?.includes(t);
	const rooms = new Set<string>(), islands = new Set<string>(), roomLocks = new Map<string, number>(), islandLocks = new Map<string, number>(), skipped = new Set<string>();
	for (const e of entries) {
		if (is(e, "Room") && skipRoom(String(e.fields.roomId))) { if (typeof e.fields.island === "string") skipped.add(e.fields.island); continue; }
		if (is(e, "Room")) { rooms.add(String(e.fields.roomId)); if (typeof e.fields.island === "string") islands.add(e.fields.island); }
		else if (is(e, "RoomLock")) roomLocks.set(String(e.fields.room), (roomLocks.get(String(e.fields.room)) ?? 0) + 1);
		else if (is(e, "IslandLock")) islandLocks.set(String(e.fields.island), (islandLocks.get(String(e.fields.island)) ?? 0) + 1);
	}
	const out: string[] = [];
	const sorted = (s: Iterable<string>) => [...s].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	for (const r of sorted(new Set([...rooms, ...roomLocks.keys()]))) {
		const n = roomLocks.get(r) ?? 0;
		if (skipRoom(r)) continue;
		if (!rooms.has(r)) out.push(`room lock of ${r}, a room that is not there`);
		else if (n !== 1) out.push(`room ${r}: ${n} locks`);
	}
	for (const i of sorted(new Set([...islands, ...islandLocks.keys()]))) {
		const n = islandLocks.get(i) ?? 0;
		if (!islands.has(i) && skipped.has(i)) continue;
		if (!islands.has(i)) out.push(`island lock of ${i}, an island no room is on`);
		else if (n !== 1) out.push(`island ${i}: ${n} locks`);
	}
	return out;
}
