// Who may enter a room (docs/forum-seite-plan-2026-11-26.en.md, section 5), with FORUM_LOGIN only: a room belongs to
// the person who made it, who invites members and viewers by their ID. A room nobody was invited to does not exist for
// that person (the answer is "no such room", not "forbidden", so its name does not tell). An administrator is not let
// into a room by being one.
//
//   RoomAccess   one room: its owner, members and viewers by user ID; unique per room, kept for good (an access that
//                lapsed would leave the room's entries to whoever made the room anew)
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { takeExisting } from "./space.ts";

export type Role = "owner" | "member" | "viewer";
export type RoomAccess = { session: string; owner: string; members: string[]; viewers: string[]; ts: number };

/** What a role may: `read` the room, `write` in it (tasks, runs, the table, accepting and objecting), `own` it. */
export const may = (role: Role | null, need: "read" | "write" | "own"): boolean =>
	role !== null && (need === "read" || (need === "write" ? role !== "viewer" : role === "owner"));

const MAX_PEOPLE = 64;
const USER_ID = /^u[A-Za-z0-9_-]{22}$/;

export function roleIn(a: RoomAccess | null, userId: string): Role | null {
	if (!a) return null;
	return a.owner === userId ? "owner" : a.members.includes(userId) ? "member" : a.viewers.includes(userId) ? "viewer" : null;
}

export async function accessOf(space: SpaceLike, room: string): Promise<RoomAccess | null> {
	const e = await space.readIfExists({ type: "RoomAccess", fields: { session: room } }, NO_WAIT);
	return e ? (e.fields as unknown as RoomAccess) : null;
}

/** Makes a room with `owner`; a room that exists already is refused, whoever owns it. */
export async function createRoom(space: SpaceLike, room: string, owner: string): Promise<RoomAccess> {
	const a: RoomAccess = { session: room, owner, members: [], viewers: [], ts: Date.now() };
	try { await space.write({ type: "RoomAccess", fields: a as never }, null, FOREVER, { unique: ["session"] }); }
	catch { throw new Error("This room name is taken; choose another"); }
	return a;
}

/** The rooms a person may enter, with their role there. */
export async function roomsOf(space: SpaceLike, userId: string): Promise<Array<{ room: string; role: Role }>> {
	const out: Array<{ room: string; role: Role }> = [];
	for (const e of await space.readAll({ type: "RoomAccess" }, { limit: 2000 })) {
		const a = e.fields as unknown as RoomAccess, role = roleIn(a, userId);
		if (role) out.push({ room: a.session, role });
	}
	return out.sort((x, y) => x.room.localeCompare(y.room));
}

/** The owner gives `userId` a role in the room, or takes it (`role` null). The owner's own role does not change. */
export async function setRole(space: SpaceLike, room: string, userId: string, role: "member" | "viewer" | null): Promise<RoomAccess> {
	if (!USER_ID.test(userId)) throw new Error("A person is named by their ID (it starts with u, the menu under their name shows it)");
	const t = await space.createTransaction(30_000);
	try {
		const e = await takeExisting(space, { type: "RoomAccess", fields: { session: room } }, { txn: t.id });
		if (!e) throw new Error("No such room");
		const a = e.fields as unknown as RoomAccess;
		if (a.owner === userId) throw new Error("The owner keeps the room");
		const next: RoomAccess = { ...a, members: a.members.filter((u) => u !== userId), viewers: a.viewers.filter((u) => u !== userId) };
		if (role === "member") next.members.push(userId);
		if (role === "viewer") next.viewers.push(userId);
		if (next.members.length + next.viewers.length > MAX_PEOPLE) throw new Error(`A room has at most ${MAX_PEOPLE} people besides its owner`);
		await space.write({ type: "RoomAccess", fields: next as never }, t.id, FOREVER);
		await space.commit(t.id);
		return next;
	} catch (err) { await space.abort(t.id).catch(() => {}); throw err; }
}
