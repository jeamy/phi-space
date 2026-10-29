"use client";
// The chat between players on the page (docs/siedeln.md, "Chat zwischen Spielern"): a tab per talk beside the log, a
// count of what is unread, and the overview of groups, invitations and whom one ignores. Every button sends the text
// command the help names (chat, gruppe, ignoriere, erlaube, melde); the server answers through the same socket.
import { useState } from "react";
import type { ChatState } from "../server/chat.ts";
import type { Talks } from "./chat.ts";
import { keyOf } from "./chat.ts";
import { MIN_PASSWORD } from "./chatcrypto.ts";
import type { ChatKeys } from "./useChat.ts";

/** The tabs: the log, the overview (with the invitations waiting), one per open talk. */
export function ChatTabs({ talks, hidden, tab, setTab, close, state }: { talks: Talks; hidden: Set<string>; tab: string; setTab: (k: string) => void; close: (k: string) => void; state: ChatState | null }) {
	const shown = [...talks.entries()].filter(([k, t]) => !hidden.has(k) || t.unread || k === tab);
	const unread = shown.reduce((n, [, t]) => n + t.unread, 0);
	return (
		<div className="chat-tabs" role="tablist" aria-label="Log und Gespräche">
			<button role="tab" aria-selected={tab === "log"} onClick={() => setTab("log")}>Log</button>
			<button role="tab" aria-selected={tab === "chats"} onClick={() => setTab("chats")} title="Gruppen, Einladungen, neues Gespräch">
				Chats{state?.invites.length ? <span className="chat-count">{state.invites.length}</span> : null}{!state?.invites.length && unread && tab !== "chats" ? <span className="chat-dot" aria-label={`${unread} ungelesen`} /> : null}
			</button>
			{shown.map(([k, t]) => (
				<span key={k} className={`chat-tab${tab === k ? " on" : ""}`}>
					<button role="tab" aria-selected={tab === k} onClick={() => setTab(k)} title={t.conv.kind === "group" ? `Gruppe ${t.conv.title}` : `Gespräch mit ${t.conv.title}`}>
						{t.conv.kind === "group" ? "# " : ""}{t.conv.title || "…"}{t.unread ? <span className="chat-count">{t.unread}</span> : null}
					</button>
					<button className="chat-close" onClick={() => close(k)} aria-label={`${t.conv.title} schließen`}>×</button>
				</span>
			))}
		</div>
	);
}

/** One talk: its messages; another's message can be reported. */
export function TalkView({ talk, keys }: { talk: Talks extends Map<string, infer T> ? T : never; keys: ChatKeys }) {
	// the other's key as their messages carry it: compared outside the game, it shows nobody put another key in between
	const theirs = talk.conv.kind === "dm" ? [...talk.msgs].reverse().find((m) => !m.mine && m.box)?.box?.pub : undefined;
	return (
		<div className="log chat-log" role="log" aria-live="polite">
			<div className="echo chat-e2e" title="Nur die Mitglieder des Gesprächs können es lesen; der Server sieht nur, wer wann schreibt.">
				🔒 Ende-zu-Ende verschlüsselt{keys.myPub ? ` · dein Schlüssel ${keys.fp(keys.myPub)}` : ""}{theirs ? ` · ${talk.conv.title}: ${keys.fp(theirs)}` : ""}
			</div>
			{!keys.unlocked && <div className="error">Der Chat ist auf diesem Gerät gesperrt: im Reiter „Chats“ mit deinem Chat-Passwort entsperren.</div>}
			{!talk.msgs.length && <div className="echo">{talk.conv.kind === "group" ? `Gruppe ${talk.conv.title}: noch nichts geschrieben.` : `Gespräch mit ${talk.conv.title}: schreib unten die erste Nachricht.`}</div>}
			{talk.msgs.map((m) => m.note !== undefined || !m.from ? <div key={m.id} className="echo">{m.note ?? ""}</div> : (
				<div key={m.id} className={m.mine ? "chat-mine" : "say"}>
					<span className="chat-time">{new Date(m.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span> {m.from}: {keys.texts.has(m.id) ? keys.texts.get(m.id) ?? <i className="muted">(nicht lesbar: für einen anderen Schlüssel verschlüsselt)</i> : <i className="muted">🔒</i>}
					{!m.mine && keys.texts.get(m.id) && <button className="link chat-report" onClick={() => keys.report(m)} title="Den Text dieser Nachricht den Admins zeigen">Melden</button>}
				</div>
			))}
		</div>
	);
}

/** The chat key: set up with a chat password, unlock on this device, change the password, a new key when it is forgotten,
 *  keep the talks as a file. */
function KeyBox({ keys, talks }: { keys: ChatKeys; talks: Talks }) {
	const [a, setA] = useState(""), [b, setB] = useState(""), [busy, setBusy] = useState(false), [msg, setMsg] = useState(""), [mode, setMode] = useState<"" | "change" | "forgot">("");
	const run = async (f: () => Promise<void>, done: string) => {
		setBusy(true); setMsg("");
		try { await f(); setA(""); setB(""); setMode(""); setMsg(done); } catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
	};
	const warn = <p className="muted chat-warn">Das Chat-Passwort ist nicht dein Login-Passwort und verlässt dein Gerät nie. Vergisst du es, sind deine Chatverläufe verloren: niemand, auch kein Admin, kann sie wiederherstellen. Sichere wichtige Verläufe mit „Verlauf sichern“.</p>;
	if (!keys.me) return null;
	const setupForm = (replace: boolean) => (
		<form className="chat-key" onSubmit={(e) => { e.preventDefault(); if (a !== b) { setMsg("Die beiden Passwörter sind nicht gleich."); return; } void run(() => keys.setup(a, replace), replace ? "Neuer Chat-Schlüssel erzeugt." : "Chat eingerichtet."); }}>
			<input type="password" value={a} onChange={(e) => setA(e.target.value)} placeholder={`Chat-Passwort (mind. ${MIN_PASSWORD} Zeichen)`} autoComplete="new-password" aria-label="Chat-Passwort" />
			<input type="password" value={b} onChange={(e) => setB(e.target.value)} placeholder="noch einmal" autoComplete="new-password" aria-label="Chat-Passwort wiederholen" />
			<button className="primary" disabled={busy || a.length < MIN_PASSWORD}>{busy ? "Einen Moment …" : replace ? "Neuen Schlüssel erzeugen" : "Chat einrichten"}</button>
		</form>
	);
	return (
		<div className="chat-keybox">
			<h3>Verschlüsselung</h3>
			{!keys.me.key ? (<><p>Richte den Chat mit einem Chat-Passwort ein: deine Nachrichten werden in deinem Browser verschlüsselt, nur die Mitglieder eines Gesprächs können sie lesen.</p>{warn}{setupForm(false)}</>)
				: !keys.unlocked ? (mode === "forgot" ? (<><p className="error">Ein neuer Schlüssel macht alles unlesbar, was bisher für dich verschlüsselt wurde.</p>{setupForm(true)}<button className="link" onClick={() => setMode("")}>zurück</button></>) : (
					<>
						<form className="chat-key" onSubmit={(e) => { e.preventDefault(); void run(() => keys.unlockWith(a), "Chat entsperrt."); }}>
							<input type="password" value={a} onChange={(e) => setA(e.target.value)} placeholder="Chat-Passwort" autoComplete="current-password" aria-label="Chat-Passwort" />
							<button className="primary" disabled={busy || !a}>{busy ? "Einen Moment …" : "Entsperren"}</button>
						</form>
						<button className="link" onClick={() => setMode("forgot")}>Chat-Passwort vergessen?</button>
					</>
				))
				: (
					<>
						<p className="muted">Entsperrt auf diesem Gerät · dein Schlüssel {keys.myPub ? keys.fp(keys.myPub) : ""}</p>
						<div className="chat-group">
							<button onClick={() => keys.backup(talks)}>Verlauf sichern</button>
							<button className="link" onClick={() => setMode(mode === "change" ? "" : "change")}>Chat-Passwort ändern</button>
							<button className="link" onClick={() => void keys.lock()}>auf diesem Gerät sperren</button>
						</div>
						{mode === "change" && (
							<form className="chat-key" onSubmit={(e) => { e.preventDefault(); void run(() => keys.changePassword(a, b), "Chat-Passwort geändert."); }}>
								<input type="password" value={a} onChange={(e) => setA(e.target.value)} placeholder="bisheriges Chat-Passwort" autoComplete="current-password" aria-label="Bisheriges Chat-Passwort" />
								<input type="password" value={b} onChange={(e) => setB(e.target.value)} placeholder={`neues (mind. ${MIN_PASSWORD} Zeichen)`} autoComplete="new-password" aria-label="Neues Chat-Passwort" />
								<button className="primary" disabled={busy || !a || b.length < MIN_PASSWORD}>Ändern</button>
							</form>
						)}
						{warn}
					</>
				)}
			{msg && <p className="muted" role="status">{msg}</p>}
		</div>
	);
}

/** The overview: invitations, groups, a new talk or group, whom one ignores. */
export function ChatOverview({ state, guest, talks, open, send, keys }: { state: ChatState | null; guest: boolean; talks: Talks; open: (k: string) => void; send: (line: string, echo?: boolean) => void; keys: ChatKeys }) {
	const [who, setWho] = useState(""), [group, setGroup] = useState("");
	return (
		<div className="log chat-overview">
			<KeyBox keys={keys} talks={talks} />
			{state?.invites.map((i) => (
				<div key={i.groupId} className="chat-invite">
					{i.from} lädt dich in die Gruppe <b>{i.name}</b> ein.
					<button className="primary" onClick={() => send(`gruppe annehmen ${i.name}`)}>Annehmen</button>
					<button onClick={() => send(`gruppe ablehnen ${i.name}`)}>Ablehnen</button>
				</div>
			))}
			<form className="chat-row" onSubmit={(e) => { e.preventDefault(); const n = who.trim(); if (n) { send(`chat ${n}`, false); setWho(""); } }}>
				<input value={who} onChange={(e) => setWho(e.target.value)} placeholder="Name einer Spielerin, eines Spielers" aria-label="Gespräch mit" maxLength={20} />
				<button>Gespräch beginnen</button>
			</form>
			<h3>Gruppen</h3>
			{!state?.groups.length && <p className="muted">Du bist in keiner Gruppe.</p>}
			{state?.groups.map((g) => {
				const k = keyOf({ kind: "group", id: g.groupId, title: g.name });
				return (
					<div key={g.groupId} className="chat-group">
						<button className="link" onClick={() => open(k)}><b># {g.name}</b></button> <span className="muted">{g.members.join(", ")}{g.owner ? " · du verwaltest sie" : ""}{talks.get(k)?.unread ? ` · ${talks.get(k)!.unread} neu` : ""}</span>
						<button className="link" onClick={() => send(`gruppe verlasse ${g.name}`)}>verlassen</button>
					</div>
				);
			})}
			{guest ? <p className="muted">Gruppen gründen und einladen können registrierte Spielerinnen und Spieler.</p> : (
				<form className="chat-row" onSubmit={(e) => { e.preventDefault(); const n = group.trim(); if (n) { send(`gruppe neu ${n}`); setGroup(""); } }}>
					<input value={group} onChange={(e) => setGroup(e.target.value)} placeholder="Name der neuen Gruppe" aria-label="Neue Gruppe" maxLength={20} />
					<button>Gruppe gründen</button>
				</form>
			)}
			<p className="muted">Einladen: rechte Maustaste (oder langes Tippen) auf eine Figur, oder „gruppe lade &lt;name&gt; in &lt;gruppe&gt;“.</p>
			{!!state?.blocked.length && (
				<>
					<h3>Ignoriert</h3>
					{state.blocked.map((n) => <div key={n} className="chat-group">{n} <button className="link" onClick={() => send(`erlaube ${n}`)}>wieder erlauben</button></div>)}
				</>
			)}
		</div>
	);
}
