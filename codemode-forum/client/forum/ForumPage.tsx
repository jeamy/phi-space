"use client";
// The FORUM page (docs/forum-seite-plan-2026-11-26.en.md, sections 4 and 10): four places, the same on every device:
// the rooms (/), a room (/r/<room>, client/forum/RoomPlace.tsx), the settings (/settings) and the help (/help). The
// present page stays as the expert view (/expert). Every state has a face: loading, empty, failed, waiting for you.
import { useEffect, useState } from "react";
import { HelpTip } from "../HelpTip.tsx";
import { api } from "../lib/api.ts";
import { loadMe, rename, signOut, type Me } from "../lib/me.ts";
import { PALETTES } from "../lib/palettes.ts";
import { T } from "../lib/texts.ts";
import { useTheme, type Lang, type Mode } from "../lib/theme.ts";
import { Act, Choice, Field } from "./controls.tsx";
import { RoomPlace } from "./RoomPlace.tsx";
import { P, type PageText } from "./texts.ts";

export type Place = "rooms" | "room" | "settings";
export type RoomRow = { room: string; role: "owner" | "member" | "viewer"; state?: "new" | "idle" | "running" | "waiting" | "ready"; tasks?: number };
type Access = { owner: { id: string; name: string }; members: Array<{ id: string; name: string }>; viewers: Array<{ id: string; name: string }> };

const helpOf = (lang: Lang, article = "help.topic.forum", anchor = "") => `/help?lang=${lang}&article=${article}${anchor ? `#${anchor}` : ""}`;

export function ForumPage({ place, room }: { place: Place; room?: string }) {
	const theme = useTheme();
	const lang = theme.lang, p = P[lang];
	const [me, setMe] = useState<Me | null>(null);
	const [rooms, setRooms] = useState<RoomRow[] | null>(null);
	const [failed, setFailed] = useState("");
	useEffect(() => { loadMe().then(setMe).catch((e) => { setFailed((e as Error).message); setMe({ login: false }); }); }, []);
	const signedIn = !!(me?.login && me.user);
	const loadRooms = () => api<{ rooms: RoomRow[] }>("/rooms").then((x) => setRooms(x.rooms)).catch((e) => { setFailed((e as Error).message); setRooms([]); });
	// the list is read again now and then: a room's state changes while the page is open
	useEffect(() => {
		if (!signedIn) return;
		void loadRooms();
		const timer = setInterval(() => { if (document.visibilityState === "visible") void loadRooms(); }, 20_000);
		return () => clearInterval(timer);
	}, [signedIn]); // eslint-disable-line react-hooks/exhaustive-deps
	// an old link to a room was the address's hash: /#room becomes /r/room
	useEffect(() => { if (place === "rooms" && location.hash.length > 1) location.replace(`/r/${location.hash.slice(1)}`); }, [place]);
	const waiting = (rooms ?? []).filter((r) => r.state === "waiting").length;
	useEffect(() => { document.title = `${waiting ? `(${waiting}) ` : ""}${place === "room" && room ? `${room} · ` : place === "settings" ? `${p.settings} · ` : ""}FORUM`; }, [waiting, place, room, p]);

	const bar = (
		<header className="fp-bar">
			<a className="fp-brand" href="/">FORUM</a>
			{place === "room" && room ? <span className="fp-crumb" aria-current="page">{room}</span> : null}
			<span className="fp-spacer" />
			<nav className="fp-nav" aria-label="FORUM">
				<a href="/" aria-current={place === "rooms" ? "page" : undefined}>{p.rooms}{waiting ? <span className="fp-dot" aria-label={p.state.waiting}>{waiting}</span> : null}</a>
				<a href="/settings" aria-current={place === "settings" ? "page" : undefined}>{p.settings}</a>
				<a href={helpOf(lang)}>{p.help}</a>
			</nav>
		</header>
	);
	if (me === null) return <>{bar}<main className="fp-main"><Skeleton label={p.loading} /></main></>;
	if (me.login && !me.user) return (
		<>
			{bar}
			<main className="fp-main fp-center">
				<div className="fp-card">
					<h1>{p.signInTitle}</h1>
					<p>{p.signInText}</p>
					<span className="act"><a className="b b--primary" href="/auth/login">{p.signIn}</a><HelpTip id="signin" lang={lang} label={p.signIn} /></span>
				</div>
			</main>
		</>
	);
	const person = me.login && me.user ? me.user : null;
	return (
		<>
			{bar}
			{failed ? <div className="fp-failed" role="alert">{p.failed} {failed} <a href="">{p.retry}</a></div> : null}
			{place === "rooms" ? <RoomsPlace lang={lang} p={p} login={me.login} rooms={rooms} reload={loadRooms} userId={person?.id ?? ""} /> : null}
			{place === "room" && room ? <RoomPlace lang={lang} p={p} t={T[lang]} room={room} login={me.login} row={rooms === null ? undefined : rooms.find((r) => r.room === room) ?? null} /> : null}
			{place === "settings" ? <SettingsPlace lang={lang} p={p} me={me} setMe={setMe} rooms={rooms} theme={theme} /> : null}
		</>
	);
}

/** A pane that is still loading: grey lines in its shape, never an empty pane. */
export function Skeleton({ label, lines = 3 }: { label: string; lines?: number }) {
	return <div className="fp-skeleton" role="status" aria-label={label}>{Array.from({ length: lines }, (_, i) => <span key={i} />)}</div>;
}

function RoomsPlace({ lang, p, login, rooms, reload, userId }: { lang: Lang; p: PageText; login: boolean; rooms: RoomRow[] | null; reload: () => Promise<void>; userId: string }) {
	const [name, setName] = useState("");
	const [err, setErr] = useState("");
	const create = async () => {
		setErr("");
		try { const r = await api<{ room: string }>("/rooms", { room: name.trim() }); await reload(); location.href = `/r/${encodeURIComponent(r.room)}`; } catch (e) { setErr((e as Error).message); }
	};
	const form = login ? (
		<form className="fp-row" onSubmit={(e) => { e.preventDefault(); void create(); }}>
			<Field label={p.roomName} tip="newroom" lang={lang} placeholder={p.roomNamePh} value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
			<Act type="submit" kind="primary" label={p.createRoom} tip="newroom" lang={lang} disabled={!name.trim()} />
		</form>
	) : (
		// without a sign-in every room is open: it is entered by its name
		<form className="fp-row" onSubmit={(e) => { e.preventDefault(); if (name.trim()) location.href = `/r/${encodeURIComponent(name.trim())}`; }}>
			<Field label={p.openRoomName} tip="rooms" lang={lang} placeholder={p.roomNamePh} value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
			<Act type="submit" kind="primary" label={p.openRoom} tip="rooms" lang={lang} disabled={!name.trim()} />
		</form>
	);
	return (
		<main className="fp-main fp-narrow">
			<h1 className="fp-title">{p.rooms} <HelpTip id="rooms" lang={lang} label={p.rooms} /></h1>
			{login && rooms === null ? <Skeleton label={p.loading} lines={4} /> : null}
			{login && rooms && rooms.length === 0 ? <p className="fp-empty">{p.noRooms}</p> : null}
			{login && rooms && rooms.length ? (
				<ul className="fp-rooms">
					{rooms.map((r) => (
						<li key={r.room}>
							<a href={`/r/${encodeURIComponent(r.room)}`} className={"fp-roomcard" + (r.state === "waiting" ? " is-waiting" : "")}>
								<b>{r.room}</b>
								<span className="fp-meta">{p.role[r.role]}{r.tasks !== undefined ? ` · ${p.tasksN(r.tasks)}` : ""}</span>
								{r.state ? <span className={`fp-state fp-state--${r.state}`}>{p.state[r.state]}</span> : null}
							</a>
						</li>
					))}
				</ul>
			) : null}
			{form}
			{err ? <p className="fp-error" role="alert">{err}</p> : null}
			{login && userId ? <p className="fp-meta">{p.yourId}: <code>{userId}</code> <HelpTip id="yourid" lang={lang} label={p.yourId} /></p> : null}
		</main>
	);
}

function SettingsPlace({ lang, p, me, setMe, rooms, theme }: { lang: Lang; p: PageText; me: Me; setMe: (m: Me) => void; rooms: RoomRow[] | null; theme: ReturnType<typeof useTheme> }) {
	const [nameDraft, setNameDraft] = useState("");
	const [err, setErr] = useState("");
	const person = me.login && me.user ? me.user : null;
	const owned = (rooms ?? []).filter((r) => r.role === "owner");
	return (
		<main className="fp-main fp-narrow">
			<h1 className="fp-title">{p.settings}</h1>
			{person ? (
				<section className="fp-card">
					<h2>{p.you}</h2>
					<form className="fp-row" onSubmit={(e) => { e.preventDefault(); rename(nameDraft).then((m) => { setMe(m); setNameDraft(""); }).catch((x) => setErr((x as Error).message)); }}>
						<Field label={p.yourName} tip="name" lang={lang} placeholder={person.name} value={nameDraft} maxLength={40} onChange={(e) => setNameDraft(e.target.value)} />
						<Act type="submit" label={p.saveName} tip="name" lang={lang} disabled={!nameDraft.trim()} />
					</form>
					<p className="fp-meta">{p.yourId}: <code>{person.id}</code> <HelpTip id="yourid" lang={lang} label={p.yourId} /></p>
					<Act label={p.signOut} tip="signout" lang={lang} onClick={() => void signOut()} />
				</section>
			) : null}
			<section className="fp-card">
				<h2>{p.look}</h2>
				<div className="fp-row">
					<Choice label={p.language} tip="language" lang={lang} value={lang} onChange={(e) => theme.setLang(e.target.value as Lang)}><option value="de">Deutsch</option><option value="en">English</option></Choice>
					<Choice label={p.mode} tip="mode" lang={lang} value={theme.mode} onChange={(e) => theme.changeMode(e.target.value as Mode)}><option value="dark">{p.dark}</option><option value="light">{p.light}</option></Choice>
					<Choice label={p.palette} tip="palette" lang={lang} value={theme.palette} onChange={(e) => theme.changePalette(e.target.value)}>{PALETTES.map((x) => <option key={x.id} value={x.id}>{x.label[lang]}</option>)}</Choice>
				</div>
			</section>
			{person ? (
				<section className="fp-card">
					<h2>{p.owned}</h2>
					{rooms === null ? <Skeleton label={p.loading} /> : owned.length ? owned.map((r) => <People key={r.room} lang={lang} p={p} room={r.room} setErr={setErr} />) : <p className="fp-empty">{p.noneOwned}</p>}
				</section>
			) : null}
			{me.login && me.admin ? (
				<section className="fp-card">
					<h2>{p.admin}</h2>
					<p>{p.adminText} <a href="/expert">{p.expert}</a></p>
				</section>
			) : null}
			{err ? <p className="fp-error" role="alert">{err}</p> : null}
		</main>
	);
}

/** The people of one room its owner manages: who is in it, inviting by ID, taking someone out again. */
function People({ lang, p, room, setErr }: { lang: Lang; p: PageText; room: string; setErr: (s: string) => void }) {
	const [access, setAccess] = useState<Access | null>(null);
	const [invitee, setInvitee] = useState("");
	const path = `/rooms/${encodeURIComponent(room)}/access`;
	useEffect(() => { api<Access>(path).then(setAccess).catch((e) => setErr((e as Error).message)); }, [path]); // eslint-disable-line react-hooks/exhaustive-deps
	const give = (id: string, role: "member" | "viewer" | null) => api<Access>(path, { userId: id, role }).then((a) => { setAccess(a); setInvitee(""); setErr(""); }).catch((e) => setErr((e as Error).message));
	return (
		<details className="fp-people">
			<summary><b>{room}</b> <span className="fp-meta">{access ? p.peopleN(1 + access.members.length + access.viewers.length) : p.loading}</span></summary>
			{access ? (
				<ul>
					<li>{access.owner.name} <span className="fp-meta">{p.role.owner}</span></li>
					{[...access.members.map((x) => [x, "member"] as const), ...access.viewers.map((x) => [x, "viewer"] as const)].map(([x, role]) => (
						<li key={x.id}>{x.name} <span className="fp-meta">{p.role[role]}</span> <Act kind="danger" label={`${p.remove}: ${x.name}`} tip="invite" lang={lang} onClick={() => void give(x.id, null)}>{p.remove}</Act></li>
					))}
				</ul>
			) : <Skeleton label={p.loading} lines={2} />}
			<div className="fp-row">
				<Field label={p.invite} tip="invite" lang={lang} placeholder="u…" value={invitee} onChange={(e) => setInvitee(e.target.value.trim())} />
			</div>
			<div className="fp-row">
				<Act label={p.asMember} tip="invite" lang={lang} disabled={!invitee} onClick={() => void give(invitee, "member")} />
				<Act label={p.asViewer} tip="invite" lang={lang} disabled={!invitee} onClick={() => void give(invitee, "viewer")} />
			</div>
		</details>
	);
}
