"use client";
// The rooms of a signed-in person (docs/forum-seite-plan-2026-11-26.en.md, section 5): the rooms they may enter with
// their role, a new room, and for the room's owner the people in it, invited by their ID.
import { useEffect, useState } from "react";
import { authHeaders } from "./lib/me.ts";
import type { Lang } from "./lib/theme.ts";

export type RoomRole = "owner" | "member" | "viewer";
type Person = { id: string; name: string };
type Access = { owner: Person; members: Person[]; viewers: Person[] };

const T = {
	de: {
		rooms: "Räume", none: "Du bist noch in keinem Raum. Lege einen an, oder lass dich einladen.", newRoom: "Neuer Raum", namePh: "name-des-raums", create: "Anlegen",
		role: { owner: "Besitz", member: "Mitglied", viewer: "liest mit" }, people: "Personen im Raum", invite: "Einladen", idPh: "ID der Person (u…)", asMember: "als Mitglied", asViewer: "zum Mitlesen", remove: "entfernen",
		yourId: "Deine ID zum Einladen", notHere: "Diesen Raum gibt es für dich nicht. Wähle einen deiner Räume.",
	},
	en: {
		rooms: "Rooms", none: "You are in no room yet. Make one, or have someone invite you.", newRoom: "New room", namePh: "room-name", create: "Create",
		role: { owner: "owner", member: "member", viewer: "reads along" }, people: "People in this room", invite: "Invite", idPh: "the person's ID (u…)", asMember: "as a member", asViewer: "to read along", remove: "remove",
		yourId: "Your ID for invitations", notHere: "This room does not exist for you. Choose one of your rooms.",
	},
} as const;

async function call<R>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? { cache: "no-store" } : { method: "POST", headers: { "content-type": "application/json", ...authHeaders() }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((d as { error?: string }).error || r.statusText);
	return d as R;
}

/** `rooms`: the list the page holds (null while it loads); `reload` fetches it again. */
export function RoomsPanel({ lang, room, rooms, reload, userId }: { lang: Lang; room: string; rooms: Array<{ room: string; role: RoomRole }> | null; reload: () => void; userId: string }) {
	const t = T[lang];
	const [name, setName] = useState("");
	const [err, setErr] = useState("");
	const [access, setAccess] = useState<Access | null>(null);
	const [invitee, setInvitee] = useState("");
	const mine = rooms?.find((r) => r.room === room) ?? null;
	const owner = mine?.role === "owner";

	useEffect(() => {
		setAccess(null);
		if (!owner) return;
		call<Access>(`/rooms/${encodeURIComponent(room)}/access`).then(setAccess).catch(() => {});
	}, [room, owner]);

	const create = () => call<{ room: string }>("/rooms", { room: name.trim() }).then((r) => { setName(""); setErr(""); reload(); location.hash = r.room; }).catch((e) => setErr((e as Error).message));
	const give = (id: string, role: "member" | "viewer" | null) => call<Access>(`/rooms/${encodeURIComponent(room)}/access`, { userId: id, role }).then((a) => { setAccess(a); setInvitee(""); setErr(""); }).catch((e) => setErr((e as Error).message));

	return (
		<div className="panel rooms">
			<h2>{t.rooms}</h2>
			{rooms && !mine && <p className="hint">{t.notHere}</p>}
			{rooms && rooms.length === 0 && <p className="hint">{t.none}</p>}
			<ul className="roomlist">
				{(rooms ?? []).map((r) => (
					<li key={r.room} className={r.room === room ? "on" : ""}><a href={`#${encodeURIComponent(r.room)}`}>{r.room}</a> <span className="muted">{t.role[r.role]}</span></li>
				))}
			</ul>
			<form className="row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
				<input aria-label={t.newRoom} placeholder={t.namePh} value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
				<button className="btn" type="submit" disabled={!name.trim()}>{t.create}</button>
			</form>
			{owner && access && (
				<details>
					<summary>{t.people} ({1 + access.members.length + access.viewers.length})</summary>
					<ul className="people">
						<li>{access.owner.name} <span className="muted">{t.role.owner}</span></li>
						{access.members.map((p) => <li key={p.id}>{p.name} <span className="muted">{t.role.member}</span> <button className="link" type="button" onClick={() => void give(p.id, null)}>{t.remove}</button></li>)}
						{access.viewers.map((p) => <li key={p.id}>{p.name} <span className="muted">{t.role.viewer}</span> <button className="link" type="button" onClick={() => void give(p.id, null)}>{t.remove}</button></li>)}
					</ul>
					<div className="row">
						<input aria-label={t.invite} placeholder={t.idPh} value={invitee} onChange={(e) => setInvitee(e.target.value.trim())} />
					</div>
					<div className="row">
						<button className="btn" type="button" disabled={!invitee} onClick={() => void give(invitee, "member")}>{t.invite} {t.asMember}</button>
						<button className="btn" type="button" disabled={!invitee} onClick={() => void give(invitee, "viewer")}>{t.asViewer}</button>
					</div>
				</details>
			)}
			{err && <p className="error">{err}</p>}
			<p className="muted small">{t.yourId}: <code>{userId}</code></p>
		</div>
	);
}
