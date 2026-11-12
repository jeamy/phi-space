"use client";
// spaces-mmo in the browser: a welcome page (play as a guest, log in, register) and the game: the PixiJS map of the
// room, the text log and the command line. Everything the player does is a text command sent over the WebSocket; a
// tap on the map or an arrow key becomes `move x y` for one step. All text from the world is rendered as React text nodes.
import { cloneElement, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ThemeControls } from "./ThemeControls.tsx";
import { tr } from "./i18n/index.ts";
import { AdminPanel } from "./AdminPanel.tsx";
import { useTheme } from "./lib/theme.ts";
import type { AtlasState, AtlasView, CharView, ClientFrame, ItemUses, MsgView, ObjView, PlanView, ServerFrame, TradeView } from "../shared/frames.ts";
import { Atlas } from "./Atlas.tsx";
import { HelpPanel } from "./HelpPanel.tsx";
import { AvatarPanel } from "./AvatarPanel.tsx";
import { StatsPanel } from "./StatsPanel.tsx";
import { onFps, startFps, type FpsState } from "./fps.ts";
import { CommandHelp } from "./CommandHelp.tsx";
import type { HelpView } from "../shared/model.ts";
import { appendLine, isComing, isForMe, newSince, todosByPlace } from "./log.ts";
import { byArrival, loadArrivals, noteArrivals, saveArrivals, type Arrivals } from "./arrivals.ts";
import { travelText, TRAVEL_GIVE_UP_MS, TRAVEL_NOTE_MS } from "./travel.ts";
import type { ChatState } from "../shared/frames.ts";
import { addMsg, fromLog, keyOf, openTalk, readTalk, type Talks } from "./chat.ts";
import { ChatOverview, TalkView } from "./ChatPanel.tsx";
import { forgetDeviceKeys, useChat } from "./useChat.ts";
import { MAX_AHEAD, nextStep, screenToGrid, WALK_MS, Walker } from "./walk.ts";
import { cellAbout, cellEntries, type CellInput, hereEntries, itemEntries, KEEPERS, tapTarget, wildHere } from "./cellActions.ts";
import { hintsFor, type Hint } from "./hints.ts";
import { canFullscreen, enterFullscreen, homeSteps, isShort, isTouch, useKeyboardInset, useLandscapeFullscreen, usePageHeld } from "./useShell.ts";
import { useBack } from "./useBack.ts";
import { detentPx, Sheet, type Detent } from "./Sheet.tsx";
import { ask, AskHost } from "./Ask.tsx";
import { Rich, setNames } from "./RichText.tsx";
import { language, setLanguage, watchPage } from "./i18n/index.ts";
import { formatWorldTime, seasonIndex, SEASONS, shownWorldMs, type WorldTimeView } from "../shared/worldtime.ts";
import { berth, lane, nextStop, SHIP_LENGTH, shipPlace } from "../shared/liner.ts";
import { railLinks, trackCells, trainIn } from "../shared/rail.ts";
import { chestOrder, fmtLoad } from "../shared/load-format.ts";

/** How long a "gone" waits for the "char" that follows it when a character is only being moved (see the handler). */
const GONE_GRACE_MS = 2500;
import { MapRenderer, type MapMode } from "./MapRenderer.tsx";
import { TouchPad } from "./TouchPad.tsx";
import { readMapMode, resetStartView } from "./viewPreferences.ts";

/** A thing picked up shows in the pack at once; without word from the server for this long it lies there again. */
const PICKUP_MS = 3_000;
/** Two clicks on one cell within this long are a double click (pick up what lies there). */
const DOUBLE_MS = 400;
/** How long a double-clicked thing is walked to before giving up (a long way, someone else took it). */
const FETCH_MS = 15_000;
/** How long after a command what arrives counts as its answer. */
const ANSWER_MS = 4_000;
/** Without a touch for this long the HUD, the chip of actions and the pad fade over the map. */
const CALM_MS = 3_000;
/** The sheet with the log open on a command's answer: two lines of it above the tabs and buttons (a mouse; a finger keeps it closed). */
const logOpenPx = () => Math.min(240, Math.round(window.innerHeight * 0.8));
type Account = { name: string; guest: boolean; admin: boolean; /** The name shown in the game, when it is not the login name. */ alias?: string };
type Hello = Extract<ServerFrame, { t: "hello" }>;
/** The names of what burns in a fire, cheapest first (from the hello): what the space key and the buttons feed. */
let fuels: string[] = ["Treibholz"];
const fuelIn = (objs: Map<string, ObjView>, me: string) => {
	const mine = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
	return fuels.map((n) => mine.find((o) => o.name === n)).find(Boolean);
};
/** The tabs of the events: for the own figure, around it, the hints, the tasks of its own things. */
type LogPart = "mine" | "all" | "tips" | "todo";
type Line = MsgView | { kind: "echo" | "hint"; text: string; from: string; at: number };

/** The build this page was loaded with (from the first /api/me); a hello from another build means a newer version. */
let pageBuild: string | null | undefined;

async function post(path: string, body: unknown = {}): Promise<{ account: Account | null; error?: string }> {
	const r = await fetch(path, { method: "POST", headers: { "content-type": "application/json", "x-mmo": "1" }, body: JSON.stringify(body) });
	const d = await r.json().catch(() => ({ error: `HTTP ${r.status}` }));
	if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
	return d;
}

type SystemHost = { name: string; roles: string[]; host: { name: string; cpu: string; cores: number; memGiB: number } };
const shortCpu = (cpu: string) => cpu.replace(/\((R|TM)\)/g, "").replace(/\b(\d+-Core )?Processor\b/i, "").replace(/\s+/g, " ").trim();

/** The bar below the game, like in the codemode chat and the help system: which hosts the game runs on (roles, CPU,
 *  cores, memory) and how many entries the world space holds. From GET /api/system, every 15 s. */
function SystemBar() {
	const [info, setInfo] = useState<{ hosts: SystemHost[]; entries: number } | null>(null);
	useEffect(() => {
		let dead = false;
		const load = () => void fetch("/api/system").then((r) => (r.ok ? r.json() : null)).then((d) => { if (!dead) setInfo(d); }, () => {});
		load();
		const t = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(t); };
	}, []);
	if (!info?.hosts.length) return null;
	return (
		<div className="system-bar" role="contentinfo">
			<span>Testsystem</span>
			{info.hosts.map((h) => (
				<span key={h.name} className="system-bar__host"><b>{h.name}</b>{h.roles.length ? ` (${h.roles.join(", ")})` : ""} · {shortCpu(h.host.cpu)} · {h.host.cores} vCPU · {h.host.memGiB.toLocaleString("de-DE")} GiB{h.roles.includes("space") ? ` · ${info.entries.toLocaleString("de-DE")} Entries` : ""}</span>
			))}
		</div>
	);
}

export function MmoApp() {
	useEffect(() => watchPage(), []);
	const [account, setAccount] = useState<Account | null | undefined>(undefined);
	const [arrival, setArrival] = useState(0);
	const enter = useCallback((a: Account | null, fresh = false) => { if (fresh) { resetStartView(); setArrival((n) => n + 1); } setAccount(a); }, []);
	const theme = useTheme();
	const controls = <ThemeControls {...theme} />;
	useEffect(() => { void fetch("/api/me").then((r) => r.json()).then((d) => { pageBuild ??= d.build ?? null; setAccount(d.account ?? null); }, () => setAccount(null)); }, []);
	if (account === undefined) return <main className="welcome"><p className="muted">Lädt …</p></main>;
	if (!account) return <Welcome onIn={enter} controls={controls} />;
	return <><Game account={account} onAccount={enter} controls={controls} startView={arrival} /><AskHost /></>;
}

function Welcome({ onIn, controls }: { onIn: (a: Account, fresh?: boolean) => void; controls: ReactNode }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const guest = async () => {
		setBusy(true); setError("");
		try { onIn((await post("/api/guest")).account!, true); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
	};
	return (
		<main className="welcome">
			<div className="welcome-top">{controls}</div>
			<h1>Leuchtfeuer</h1>
			<p className="pitch muted">Ein Archipel im Nebel. Wo ein Leuchtfeuer brennt, wird es licht – und keines brennt lange allein.</p>
			<div className="card">
				<button className="primary" onClick={guest} disabled={busy}>Als Gast spielen</button>
				<p className="muted" style={{ fontSize: "max(13px, var(--min-font))", margin: "10px 0 0" }}>Sofort los, ohne Anmeldung. Wer sich später registriert, behält alles, was er als Gast erreicht hat.</p>
				{error && <p className="error">{error}</p>}
			</div>
			<div className="card"><AccountForm onDone={onIn} /></div>
			<About />
		</main>
	);
}

/** Log in or register. `guest`: shown inside the game of a guest (registering keeps the guest's progress; logging in
 *  to another account does not). */
function AccountForm({ onDone, guest = false }: { onDone: (a: Account, fresh?: boolean) => void; guest?: boolean }) {
	const [mode, setMode] = useState<"login" | "register">(guest ? "register" : "login");
	const [name, setName] = useState(""), [password, setPassword] = useState(""), [token, setToken] = useState("");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true); setError("");
		try { onDone((await post(mode === "login" ? "/api/login" : "/api/register", { name, password, ...(token ? { setupToken: token } : {}) })).account!, mode === "register"); }
		catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	return (
		<form className="form" onSubmit={submit}>
			<div className="tabs" role="tablist">
				<button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>Registrieren</button>
				<button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>Anmelden</button>
			</div>
			{guest && mode === "register" && <p className="muted" style={{ margin: 0, fontSize: "max(13px, var(--min-font))" }}>Deine Figur, ihr Platz und alles Weitere bleiben erhalten.</p>}
			{guest && mode === "login" && <p className="warning" style={{ margin: 0, fontSize: "max(13px, var(--min-font))" }}>Mit einem bestehenden Konto anmelden: Der Fortschritt dieses Gastes wird nicht übernommen und verfällt.</p>}
			<label>Name<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="username" required minLength={3} maxLength={20} /></label>
			<label>Passwort<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={mode === "login" ? "current-password" : "new-password"} required minLength={mode === "register" ? 8 : 1} /></label>
			{!guest && (
				<details><summary>{mode === "login" ? "Einrichtungstoken (macht dieses Konto zum Admin)" : "Einrichtungstoken (nur für den ersten Admin)"}</summary><input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></details>
			)}
			<button className="primary" disabled={busy}>{mode === "login" ? "Anmelden" : "Registrieren"}</button>
			{error && <p className="error" style={{ margin: 0 }}>{error}</p>}
		</form>
	);
}

/** The name others see; the login stays the same. */
function AliasForm({ account, onDone }: { account: Account; onDone: (a: Account) => void }) {
	const [alias, setAlias] = useState(account.alias ?? "");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const save = async (value: string) => {
		setBusy(true); setError("");
		try { onDone((await post("/api/alias", { alias: value })).account!); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
	};
	return (
		<form className="form" onSubmit={(e) => { e.preventDefault(); void save(alias); }}>
			<p className="muted" style={{ margin: 0, fontSize: "max(13px, var(--min-font))" }}>So sehen dich alle im Spiel. Anmelden tust du dich weiter als <b>{account.name}</b>.</p>
			<label>Alias<input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder={account.name} autoComplete="off" maxLength={20} /></label>
			<div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
				<button className="primary" disabled={busy}>Speichern</button>
				{account.alias && <button type="button" disabled={busy} onClick={() => void save("")}>Alias entfernen</button>}
			</div>
			{error && <p className="error" style={{ margin: 0 }}>{error}</p>}
		</form>
	);
}

function About() {
	return (
		<p className="about muted">
			Eine Welt auf <a href="https://spaces.eibrain.org" target="_blank" rel="noreferrer">phi-spaces</a>. Grafiken: Intersect-Assets von
			PixelFox, Zetasis, George und Murdoc, CC BY 4.0; Gegenstände: Shikashi's Fantasy Icons von Matt Firth (shikashipx) nach
			game-icons.net, CC BY 4.0, und 7Soul1, CC0 (<a href="/assets/leuchtfeuer/CREDITS.md" target="_blank" rel="noreferrer">Nachweise</a>).
		</p>
	);
}

/** Closes a menu, but not at what opened it: a long press ends in a context menu or a click on the backdrop that just came up
 *  under the finger. */
function useDismiss(close: () => void): () => void {
	const opened = useRef(Date.now());
	return () => { if (Date.now() - opened.current > 500) close(); };
}

/** The menu of a long press or a right click on a cell: what stands, lies or burns there, and what one can do with it.
 *  Every entry is a text command. */
function CellMenu({ at, beachAt, admin, todos, feed, chars, objs, self, room, me, plans, guest, wild, beds, recipes, grinds, sail, travel, send, close, offer, offersIn, chat, sheet = false, onHelp, onWalk, onOrders }: { beachAt?: CellInput["beachAt"]; admin?: boolean; todos?: CellInput["todos"]; feed?: CellInput["feed"]; offersIn?: CellInput["offersIn"]; recipes?: CellInput["recipes"]; grinds?: string[]; wild?: boolean; beds?: CellInput["beds"]; sail?: string[]; travel?: CellInput["travel"]; at: { x: number; y: number; left: number; top: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; plans: PlanView[]; guest: boolean; send: (line: string) => void; close: () => void; offer?: (name: string) => void; sheet?: boolean; onHelp?: (article: string) => void; /** A phone walks there step by step, to the free cell nearest it. */ onWalk?: (at: { x: number; y: number }) => void; onOrders?: () => void;
	/** Chat with a player (not an NPC), and invite them into one of `groups` (none for a guest). */ chat?: { talk: (name: string) => void; invite: (name: string, group: string) => void; groups: string[] } }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	// building goes in steps: "Bauen …" → the plans → a plan with what it needs and OK
	// taking from a chest asks how many: "<ding> entnehmen …" → x of y
	const [step, setStep] = useState<"plans" | PlanView | { take: string; count: number } | null>(null);
	const [takeN, setTakeN] = useState("");
	useEffect(() => setStep(null), [at]);
	const fuel = fuelIn(objs, me);
	const entries = cellEntries({ at, chars, objs, self, room, me, plans, guest, fuel, offer, offersIn, chat, wild, beds, sail, travel, recipes, grinds, beachAt, admin, todos, feed, onPlans: () => setStep("plans"), onOrders, onTake: (take, count) => { setTakeN(""); setStep({ take, count }); } });
	const taking = step && typeof step === "object" && "take" in step ? step : null;
	if (taking) {
		entries.length = 0;
		if (taking.count > 1) entries.push({ label: `Alle ${taking.count} entnehmen`, line: `entnimm alle ${taking.take}` });
		entries.push({ label: "Zurück", line: "#zurück", run: () => setStep(null) });
	} else if (step === "plans") {
		entries.length = 0;
		// alphabetical, as one looks for a name
		for (const p of [...plans].sort((a, b) => a.name.localeCompare(b.name, "de"))) entries.push({ label: `${p.name} (${p.w}×${p.h}${p.epoch ? `, ab ${p.epoch}` : ""})`, line: `#plan ${p.key}`, run: () => setStep(p) });
		entries.push({ label: "Zurück", line: "#zurück", run: () => setStep(null) });
	} else if (step && "w" in step) {
		entries.length = 0;
		entries.push({ label: `OK: ${step.name} hier abstecken`, line: `bau ${step.key} ${at.x} ${at.y}` }, { label: "Zurück", line: "#zurück", run: () => setStep("plans") });
	}
	useBack(sheet, close);
	const dismiss = useDismiss(close);
	// on the desktop the list stays on the screen and scrolls when it is taller than the room there is
	const left = Math.min(at.left, window.innerWidth - 220), top = Math.max(8, Math.min(at.top, window.innerHeight - 40 * (entries.length + 1)));
	const about = sheet ? cellAbout(at, chars, objs, room) : {};
	const [told, setTold] = useState(false);
	// the tap that opened it ends with a click on what now lies under the finger: a button counts only after a press inside
	// the menu (a key's click has detail 0)
	const pressed = useRef(false);
	const mayClick = (e: React.MouseEvent) => e.detail === 0 || pressed.current;
	// on a phone on its side the card stands on the half of the screen away from the finger, so the tapped thing stays in view
	const side = sheet && at.left > window.innerWidth / 2 ? " on-left" : "";
	return (
		<>
			<div className={`menu-backdrop${sheet ? " dim" : ""}`} onClick={dismiss} onContextMenu={(e) => { e.preventDefault(); dismiss(); }} />
			<ul className={sheet ? `cell-menu action-sheet${side}` : "cell-menu"} role="menu" style={sheet ? undefined : { left, top }} onPointerDown={() => { pressed.current = true; }} onClickCapture={(e) => { if (!mayClick(e)) { e.preventDefault(); e.stopPropagation(); } }}>
				{sheet && about.title && <li className="action-title">{about.title}</li>}
				{step && typeof step === "object" && !taking && "w" in step && <li className="menu-note">{step.name} ({step.w}×{step.h}) ab hier nach rechts unten: {step.needs}, {step.work} Arbeit</li>}
				{taking && <li className="menu-take">
					{/* how many: a number, at most what lies there; empty: one */}
					<form onSubmit={(e) => { e.preventDefault(); const n = Math.min(taking.count, Math.max(1, Math.floor(Number(takeN) || 1))); send(`entnimm ${n} ${taking.take}`); close(); }}>
						<span>{taking.take}:</span>
						<input type="number" min={1} max={taking.count} inputMode="numeric" placeholder="1" value={takeN} autoFocus onChange={(e) => setTakeN(e.target.value)} aria-label={`Wie viele ${taking.take} entnehmen, von ${taking.count}`} />
						<span>{`von ${taking.count} in der Truhe`}</span>
						<button type="submit">Entnehmen</button>
					</form>
				</li>}
				{entries.map((e) => <li key={e.line} role="menuitem"><button onClick={() => { if (onWalk && e.line.startsWith("move ")) { onWalk(at); close(); } else if (e.run) { e.run(); if (!e.line.startsWith("#bau") && !e.line.startsWith("#plan") && !e.line.startsWith("#zurück") && !e.line.startsWith("#entnimm")) close(); } else if (e.confirm) { const line = e.line; close(); void ask(e.confirm).then((ok) => { if (ok) send(line); }); } else { send(e.line); close(); } }}>{e.label}</button></li>)}
				{sheet && about.desc && (told ? <li className="menu-note">{about.desc}</li> : <li role="menuitem"><button className="action-help" onClick={() => setTold(true)}>Was ist das?</button></li>)}
				{sheet && about.article && onHelp && <li role="menuitem"><button className="action-help" onClick={() => { close(); onHelp(about.article!); }}>Was ist das?</button></li>}
			</ul>
		</>
	);
}

/** A log line with the names of players as buttons (they open the name menu): the speaker of what was said, every player
 *  in the list of who plays; never one's own name. */
function LogText({ l, self, onName, onCommand }: { l: Line; self: string; onName: (name: string, left: number, top: number) => void; onCommand: (command: string) => void }) {
	const names = "players" in l && l.players ? l.players : "player" in l && l.player ? [l.from] : [];
	const wanted = names.filter((n) => n && n !== self);
	if (!wanted.length) return <Rich text={l.text} onCommand={onCommand} />;
	const parts: ReactNode[] = [];
	let rest = l.text, k = 0;
	for (;;) {
		let at = -1, hit = "";
		// a whole name only: "Ina" is not the end of "Kalina"
		const word = /[\p{L}\p{N}_-]/u, whole = (n: string) => { for (let i = rest.indexOf(n); i >= 0; i = rest.indexOf(n, i + 1)) if (!word.test(rest[i - 1] ?? " ") && !word.test(rest[i + n.length] ?? " ")) return i; return -1; };
		for (const n of wanted) { const i = whole(n); if (i >= 0 && (at < 0 || i < at)) { at = i; hit = n; } }
		if (at < 0) break;
		parts.push(<Rich key={k++} text={rest.slice(0, at)} onCommand={onCommand} />);
		const name = hit;
		parts.push(<button key={k++} className="name-link" onClick={(e) => onName(name, e.clientX, e.clientY)} title={`${name}: Chat, Gruppe, ignorieren`}>{name}</button>);
		rest = rest.slice(at + hit.length);
		if (!("players" in l && l.players)) break; // the speaker once
	}
	parts.push(<Rich key={k++} text={rest} onCommand={onCommand} />);
	return <>{parts}</>;
}

/** The menu of a player's name in the log: chat, invite into one's groups, ignore. */
function NameMenu({ at, name, groups, talk, invite, ignore, close, sheet = false }: { at: { left: number; top: number }; name: string; groups: string[]; talk: () => void; invite: (group: string) => void; ignore: () => void; close: () => void; sheet?: boolean }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	const entries = [{ label: `Chat mit ${name}`, run: talk }, ...groups.slice(0, 4).map((g) => ({ label: `${name} in „${g}“ einladen`, run: () => invite(g) })), { label: `${name} ignorieren`, run: ignore }];
	useBack(sheet, close);
	const dismiss = useDismiss(close);
	const left = Math.min(at.left, window.innerWidth - 220), top = Math.max(8, Math.min(at.top, window.innerHeight - 40 * (entries.length + 1)));
	return (
		<>
			<div className={`menu-backdrop${sheet ? " dim" : ""}`} onClick={dismiss} onContextMenu={(e) => { e.preventDefault(); dismiss(); }} />
			<ul className={sheet ? "cell-menu action-sheet" : "cell-menu"} role="menu" style={sheet ? undefined : { left, top }}>
				{sheet && <li className="action-title">{name}</li>}
				{entries.map((e) => <li key={e.label} role="menuitem"><button onClick={() => { e.run(); close(); }}>{e.label}</button></li>)}
			</ul>
		</>
	);
}

/** Trade as buttons: offers to and from the player, a form for a new offer, the order board and the market board when
 *  standing at them. Every button sends the text command the help names. */
function TradePanel({ trade, chars, objs, me, guest, offerTo, setOfferTo, item, send }: { /** the thing a tap in the pack brought here */ item: { name: string } | null; trade: TradeView; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; guest: boolean; offerTo: string | null; setOfferTo: (n: string | null) => void; send: (line: string, echo?: boolean, opensLog?: boolean) => void }) {
	// the market board's and the order board's own lines keep them in front (a taken order is delivered from here): their lists change in place, the answer shows as the notice and in the log
	const board = (line: string) => send(line, true, false);
	const carried = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
	const others = [...chars.values()].filter((c) => c.charId !== me);
	const [give, setGive] = useState("");
	useEffect(() => { if (item) { setGive(item.name.toLowerCase()); setSell(item.name); } }, [item]);
	// what one carries, one line per kind with its count
	const kinds = [...carried.reduce((m, o) => m.set(o.name, (m.get(o.name) ?? 0) + 1), new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b));
	// a click on a kind adds one of it to "Du gibst" ("muschel" → "2 muschel"), up to what one carries
	const addGive = (name: string, max: number) => setGive((g) => {
		const parts = g.split(",").map((p) => p.trim()).filter(Boolean);
		const key = name.toLowerCase();
		const i = parts.findIndex((p) => (/^(\d+)\s*x?\s+(.+)$/i.exec(p)?.[2] ?? p).toLowerCase() === key);
		if (i < 0) return [...parts, `1 ${key}`].join(", ");
		const n = Number(/^(\d+)/.exec(parts[i]!)?.[1] ?? 1);
		parts[i] = `${Math.min(max, n + 1)} ${key}`;
		return parts.join(", ");
	});
	const [want, setWant] = useState("");
	const [sell, setSell] = useState(""), [price, setPrice] = useState("2"), [many, setMany] = useState("1");
	const [seek, setSeek] = useState(""), [bid, setBid] = useState("2");
	// things by kind with their count ("4× Münze für Perle"), as the server's messages say it
	const counted = (xs: string[] | Array<{ name: string; count: number }>) => {
		const m = new Map<string, number>();
		for (const x of xs) { const [n, k] = typeof x === "string" ? [x, 1] : [x.name.charAt(0).toUpperCase() + x.name.slice(1), x.count]; m.set(n, (m.get(n) ?? 0) + k); }
		return [...m].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n)).join(", ");
	};
	const wants = (w: Array<{ name: string; count: number }>) => (w.length ? ` für ${counted(w)}` : " als Geschenk");
	// a trade can be offered to anyone in the room, with or without a market here
	const has = trade.offersIn.length || trade.offersOut.length || trade.orders || trade.myOrder || trade.listings || trade.wanted || offerTo !== null || (!guest && others.length > 0 && carried.length > 0);
	if (!has) return null;
	return (
		<div className="things trade">
			{trade.offersIn.length > 0 && <><h3>Angebote an dich</h3><ul>{trade.offersIn.map((o) => (
				<li key={o.offerId}><span>{o.fromName}: {counted(o.giveNames)}{wants(o.want)}</span><button onClick={() => board(`accept ${o.fromName}`)}>Annehmen</button><button onClick={() => board(`decline ${o.fromName}`)}>Ablehnen</button></li>
			))}</ul></>}
			{trade.offersOut.length > 0 && <><h3>Deine Angebote</h3><ul>{trade.offersOut.map((o) => (
				<li key={o.offerId}><span>an {o.toName}: {counted(o.giveNames)}{wants(o.want)}</span><button onClick={() => board("offer zurück")}>Zurücknehmen</button></li>
			))}</ul></>}
			{offerTo !== null && !guest && (
				<form className="trade-form" onSubmit={(e) => { e.preventDefault(); if (!offerTo || !give.trim()) return; send(`offer ${give.trim()} an ${offerTo}${want.trim() ? ` für ${want.trim()}` : ""}`); setGive(""); setWant(""); setOfferTo(null); }}>
					<h3>Tausch anbieten</h3>
					<div className="trade-who"><span>Anbieten an</span>{others.length ? <ul className="carried" aria-label="An wen">{[...others].sort((a, b) => Number(!!a.ai || !!a.settler) - Number(!!b.ai || !!b.settler)).map((c) => (
						<li key={c.charId}><button type="button" className={offerTo === c.name ? "on" : ""} aria-pressed={offerTo === c.name} onClick={() => setOfferTo(c.name)}><span>{c.name}</span></button></li>
					))}</ul> : <span className="muted">Hier ist niemand.</span>}</div>
					{kinds.length ? <ul className="carried" aria-label="Was du trägst">{kinds.map(([name, n]) => (
						<li key={name}><button type="button" onClick={() => addGive(name, n)} title={`1 ${name} dazugeben`}><span>{name}</span><span className="count">{n}×</span></button></li>
					))}</ul> : <span className="muted">Du trägst nichts.</span>}
					<label>Du gibst <input value={give} onChange={(e) => setGive(e.target.value)} placeholder="z. B. 2 muschel, tang" /></label>
					<label>Dafür (leer: Geschenk) <input value={want} onChange={(e) => setWant(e.target.value)} placeholder="z. B. 2 münze" /></label>
					<div className="row"><button className="primary" disabled={!offerTo || !give.trim()}>Anbieten</button><button type="button" onClick={() => setOfferTo(null)}>Abbrechen</button></div>
					{(!offerTo || !give.trim()) && <p className="muted trade-hint">{!offerTo ? "Tippe oben auf die Person, der du es anbietest." : "Tippe auf etwas, das du gibst."}</p>}
				</form>
			)}
			{offerTo === null && !guest && others.length > 0 && carried.length > 0 && <button className="link" onClick={() => setOfferTo("")}>Tausch anbieten …</button>}
			{trade.myOrder && <><h3>Dein Auftrag</h3><ul><li><span>{trade.myOrder.text}</span>{trade.myOrder.here && <><button onClick={() => board("auftrag liefere")}>Liefern</button><button onClick={() => board("auftrag aufgeben")}>Aufgeben</button></>}</li></ul>
				{!trade.myOrder.here && <p className="muted" style={{ margin: "0 0 4px" }}>Abliefern an einer Auftragstafel: {trade.myOrder.boards.join(", ")}.</p>}</>}
			{trade.orders && <><h3>Auftragstafel</h3>{trade.orders.length ? <ul>{trade.orders.map((o) => (
				<li key={o.nr}><span>{o.text} ({o.reward} {o.reward === 1 ? "Münze" : "Münzen"})</span>{!guest && !trade.myOrder && <button onClick={() => board(`auftrag nimm ${o.nr}`)}>Nehmen</button>}</li>
			))}</ul> : <p className="muted">Gerade keine Aufträge.</p>}</>}
			{trade.listings && <><h3>Marktbrett</h3>{trade.listings.length ? <ul>{trade.listings.map((l) => (
				<li key={l.nr}><span>{l.count > 1 ? `${l.count}× ` : ""}{l.itemName} – {l.price} {l.price === 1 ? "Münze" : "Münzen"} ({l.mine ? "deins" : l.sellerName})</span>{!guest && (l.mine ? <button onClick={() => board(`markt zurück ${l.nr}`)}>Zurückholen</button> : <button onClick={() => board(`markt kaufe ${l.count > 1 ? `${l.count} ` : ""}${l.itemName.toLowerCase()} für ${l.price}`)}>Kaufen</button>)}</li>
			))}</ul> : <p className="muted">Das Brett ist leer.</p>}
			{!guest && carried.length > 0 && (
				<form className="row" onSubmit={(e) => { e.preventDefault(); if (sell) board(`markt biete ${Math.max(1, Number(many) || 1)} ${sell} für ${price}`); setSell(""); setMany("1"); }}>
					<input type="number" min={1} max={Math.max(1, carried.filter((o) => o.name === sell).length)} value={many} onChange={(e) => setMany(e.target.value)} aria-label="Wie viele" title="Wie viele (der Preis gilt für alle zusammen)" style={{ width: 56 }} />
					<select value={sell} onChange={(e) => { setSell(e.target.value); setMany("1"); }} aria-label="Was verkaufen"><option value="">verkaufen …</option>{[...new Set(carried.map((o) => o.name))].filter((n) => n !== "Münze").sort((a, b) => a.localeCompare(b, "de")).map((n) => <option key={n} value={n}>{n}</option>)}</select>
					<input type="number" min={1} max={1000} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Preis in Münzen" title="Preis in Münzen, für alle zusammen" style={{ width: 70 }} />
					<button disabled={!sell}>Einstellen</button>
				</form>
			)}</>}
			{trade.wanted && <><h3>Gesuche</h3>{trade.wanted.length ? <ul>{trade.wanted.map((w) => {
				const have = carried.filter((o) => o.name === w.protoName).length >= w.count;
				// what the traders said, or that none deals in it; how long it still hangs
				const left = w.until === null ? null : Math.max(0, w.until - Date.now()), hours = left === null ? null : Math.ceil(left / 3_600_000);
				const notes = [...w.replies.map((r) => `${r.name}: ${r.ask ? `ab ${r.ask}` : "gerade keins"}`), ...(!w.traded && !w.replies.length ? ["kein Händler führt es"] : []), ...(hours === null ? [] : [hours > 1 ? `noch ${hours} h` : "läuft bald ab"])];
				return <li key={w.nr}><span>{w.mine ? "Du suchst" : `${w.buyerName} sucht`} {w.count > 1 ? `${w.count}× ` : ""}{w.protoName} – {w.price} {w.price === 1 ? "Münze" : "Münzen"}{notes.length > 0 && <small className="wanted-note">{notes.join(" · ")}</small>}</span>{!guest && (w.mine ? <button onClick={() => board(`markt suche zurück ${w.nr}`)}>Zurücknehmen</button> : <button disabled={!have} title={have ? "" : `Du trägst nicht genug ${w.protoName}`} onClick={() => board(`markt liefere ${w.nr}`)}>Liefern</button>)}</li>;
			})}</ul> : <p className="muted">Niemand sucht gerade etwas.</p>}
			{!guest && (
				<form className="row" onSubmit={(e) => { e.preventDefault(); if (seek.trim()) board(`markt suche ${seek.trim()} für ${bid}`); setSeek(""); }}>
					<input value={seek} onChange={(e) => setSeek(e.target.value)} placeholder="suchen, z. B. Ziege" aria-label="Was suchen" />
					<input type="number" min={1} max={1000} value={bid} onChange={(e) => setBid(e.target.value)} aria-label="Gebot in Münzen" style={{ width: 70 }} />
					<button disabled={!seek.trim()}>Suchen</button>
				</form>
			)}
			{!guest && <p className="muted" style={{ margin: "0 0 4px" }}>Deine Münzen liegen am Brett, bis jemand liefert; zurückgenommen oder abgelaufen bekommst du sie wieder.</p>}</>}
		</div>
	);
}

/** A thing's icon: its picture (worlds/<id>/assets/items), or its glyph (shape and colour) where it has none. */
function Glyph({ o, size = 16 }: { o: ObjView; size?: number }) {
	if (o.icon) return <img className="icon" src={o.icon} width={size} height={size} alt="" aria-hidden="true" />;
	const c = o.glyph?.color ?? "#9aa3ad", shape = o.glyph?.shape ?? "square";
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			{shape === "circle" ? <circle cx="8" cy="8" r="6" fill={c} stroke="#0008" /> : shape === "diamond" ? <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill={c} stroke="#0008" /> : <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill={c} stroke="#0008" />}
		</svg>
	);
}

/** What the player carries and what lies within reach, as buttons (on a phone there is no keyboard to type with). */
/** What the pack weighs against the most a figure carries, and one's chests (numbered as `verstaue … in <nr>` takes them). */
type PackInfo = { max: number | null; chests: Array<{ nr: number; label: string }> };
function Things({ part = "mine", objs, chars, self, room, me, plans, guest, wild, uses, hints = [], market, offer, send: sendLine, pick, pack, arrived }: { pack?: PackInfo; /** when each kind came into the pack: newest first (client/arrivals.ts) */ arrived?: ReadonlyMap<string, number>; /** "mine": what lies beside the figure and what it carries; "here": the fire within reach and what can be done here */ part?: "mine" | "here"; uses: ItemUses | undefined; /** the hints of the pack (client/hints.ts): a chosen thing shows its own */ hints?: Hint[]; /** a market board stands here: sell the thing there */ market?: (name: string) => void; offer?: (to: string, name: string) => void; objs: Map<string, ObjView>; chars: Map<string, CharView>; self: CharView | undefined; room: string; me: string; plans: PlanView[]; guest: boolean; wild: boolean; send: (line: string, echo?: boolean, opensLog?: boolean) => void; pick: (o: ObjView) => void }) {
	// in the pack one stays where one is: what a thing does (make, store, name, lay down) answers as the notice and in the
	// log without leaving the pack; only looking at a thing opens the log, where its description stands
	const send = (line: string) => (part === "mine" && !line.startsWith("look ") ? sendLine(line, true, false) : sendLine(line));
	const all = [...objs.values()].filter((o) => o.kind === "item");
	const carried = all.filter((o) => o.location === me);
	const close = (o: ObjView) => !!self && o.location === room && Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1;
	const near = all.filter(close);
	const fire = [...objs.values()].find((o) => o.kind === "beacon" && close(o));
	const fuel = fuelIn(objs, me);
	// the burn time left counts down while a fire is near
	const [, tick] = useState(0);
	useEffect(() => { if (!fire) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [fire?.id]);
	// the pack in short: one icon per kind of thing with how many; a tap shows what can be done with it
	const [picked, setPicked] = useState<string | null>(null);
	// by arrival, the newest first (D), or by name (A); the choice is kept for the next visit
	const [sortBy, setSortBy] = useState<"A" | "D">(() => { try { return localStorage.getItem("mmo.packSort") === "A" ? "A" : "D"; } catch { return "D"; } });
	const sortTo = (v: "A" | "D") => { setSortBy(v); try { localStorage.setItem("mmo.packSort", v); } catch { /* private window: for this page */ } };
	const arrival = byArrival(arrived ?? new Map(), uses?.seeds);
	const order = sortBy === "A" ? (a: string, b: string) => a.localeCompare(b, "de") : arrival;
	const kinds = [...carried.reduce((m, o) => m.set(o.name, [...(m.get(o.name) ?? []), o]), new Map<string, ObjView[]>())].sort(([a], [b]) => order(a, b));
	const chosen = kinds.find(([name]) => name === picked);
	/** The hints about the chosen thing (what it makes, with „Herstellen“), shown under its buttons. */
	const shownHints = chosen ? hints.filter((h) => h.about.includes(chosen[0])).slice(0, 3) : [];
	// a bag adds to the most one carries, each kind once (engine/pack.ts packMax)
	const load = carried.reduce((n, o) => n + (o.load ?? 0), 0), bags = new Map(carried.filter((o) => o.bag).map((o) => [o.name, o.bag!])), max = pack?.max == null ? null : pack.max + [...bags.values()].reduce((n, b) => n + b, 0);
	const [chestNr, setChestNr] = useState(1);
	const [storeN, setStoreN] = useState(""), [sortName, setSortName] = useState("");
	const [crossId, setCrossId] = useState<string | null>(null);
	const chests = pack?.chests ?? [], chestAt = chests.find((x) => x.nr === chestNr) ?? chests[0];
	const chosenBox = useRef<HTMLDivElement>(null);
	// one's own chest beside one (the server sends what lies in it): its things to take out, as many as one likes
	const chestHereB = !guest && self ? [...objs.values()].find((b) => b.kind === "building" && b.ownerId === me && b.location === room && plans.some((p) => p.key === b.plan && p.chest) && self.x >= b.x - 1 && self.y >= b.y - 1 && self.x <= b.x + (b.w ?? 1) && self.y <= b.y + (b.h ?? 1)) : undefined;
	const inChest = chestHereB ? [...all.filter((o) => o.location === chestHereB.id).reduce((m, o) => m.set(o.name, [...(m.get(o.name) ?? []), o]), new Map<string, ObjView[]>())].sort(([a], [b]) => a.localeCompare(b, "de")) : [];
	const [takePicked, setTakePicked] = useState<string | null>(null);
	const [takeN, setTakeN] = useState("");
	const taking = inChest.find(([n]) => n === takePicked);
	useEffect(() => { if (picked) chosenBox.current?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" }); }, [picked]);
	const here = hereEntries({ chars, objs, self, room, me, plans, guest, fuel, wild, beds: uses?.beds });
	if (part === "here") {
		if (!fire && !here.length) return <p className="muted bag-note">Hier gibt es gerade nichts zu tun. Geh zu einem Feuer, einem Bau, einem Beet oder zu jemandem, dann steht hier, was geht.</p>;
		return (
			<div className="things">
				{fire && (
					<><h3>{fire.name}</h3><ul><li>
						<span>{(fire.until ?? 0) > Date.now() ? `brennt noch ${Math.max(1, Math.round(((fire.until ?? 0) - Date.now()) / 1000))} s` : "ist erloschen"}</span>
						<button disabled={!fuel} onClick={() => fuel && send(`put ${fuel.name} in ${fire.name}`)} title={fuel ? "" : "Du trägst kein Brennholz"}>Nachlegen</button>
					</li></ul></>
				)}
				{here.length > 0 && <><h3>Hier möglich</h3><div className="here open">{here.map((e) => <button key={e.line} onClick={() => { if (e.confirm) void ask(e.confirm).then((ok) => { if (ok) send(e.line); }); else send(e.line); }}>{e.label}</button>)}</div></>}
			</div>
		);
	}
	if (!carried.length && !near.length && !inChest.length) return <p className="muted bag-note">Du trägst nichts, und neben dir liegt nichts.</p>;
	const row = (o: ObjView, verb: string, label: string) => (
		<li key={o.id}><Glyph o={o} size={20} /><span>{o.name}</span><button onClick={() => (verb === "get" ? pick(o) : send(`${verb} ${o.name}`))}>{label}</button><button onClick={() => send(`look ${o.name}`)}>Ansehen</button></li>
	);
	return (
		<div className="things">
			{near.length > 0 && <><h3>Neben dir</h3><ul>{near.map((o) => row(o, "get", "Aufheben"))}</ul></>}
			{chestHereB && inChest.length > 0 && <>
				<h3>{`In der Truhe: ${chestHereB.name}`}</h3>
				{taking && <div className="pack-chosen">
					<div className="pack-do"><b>{taking[0]}{taking[1].length > 1 ? ` ×${taking[1].length}` : ""}</b></div>
					<div className="pack-store">
						{/* how many: a number (at most what lies there), empty: one */}
						<form className="pack-store-n" onSubmit={(e) => { e.preventDefault(); const n = Math.min(taking[1].length, Math.max(1, Math.floor(Number(takeN) || 1))); send(`entnimm ${n} ${taking[0]}`); setTakeN(""); }}>
							<input type="number" min={1} max={taking[1].length} inputMode="numeric" placeholder="1" value={takeN} onChange={(e) => setTakeN(e.target.value)} aria-label="Wie viele entnehmen" />
							<button type="submit">Stück entnehmen</button>
						</form>
						{taking[1].length > 1 && <button onClick={() => send(`entnimm alle ${taking[0]}`)}>{`Alle ${taking[1].length} entnehmen`}</button>}
					</div>
				</div>}
				<div className="pack">{inChest.map(([name, os]) => (
					<button key={name} className={`chip pack-chip${takePicked === name ? " on" : ""}`} onClick={() => setTakePicked(takePicked === name ? null : name)} title={name} aria-label={`${name}: ${os.length}`} aria-pressed={takePicked === name}>
						<span className="pack-top"><Glyph o={os[0]!} size={24} /><span className="n">{os.length}</span></span>
						<span className="pack-name">{name}</span>
					</button>
				))}</div>
			</>}
			{carried.length > 0 && <>
				<h3>Du trägst{max !== null && <span className={`pack-load${load > max ? " over" : ""}`} title={load > max ? "Mehr trägst du nicht: leg etwas in eine Truhe." : ""}>{` · Last ${fmtLoad(load)} von ${fmtLoad(max)}`}</span>}</h3>
				{/* a tap on a thing: its name and what it can do come first, above the pack, scrolled into view */}
				{chosen && <div className="pack-chosen" ref={chosenBox}>
					<div className="pack-do"><b>{chosen[0]}{chosen[1].length > 1 ? ` ×${chosen[1].length}` : ""}</b>
						<button onClick={() => send(`drop ${chosen[0]}`)}>Ablegen</button>
						<button onClick={() => send(`look ${chosen[0]}`)}>Ansehen</button>
					</div>
					{/* into a chest of one's own, from anywhere (verstaue … in <nr>) */}
					{/* a dog or cat goes to no chest: it guards a building (einstallen) */}
					{!guest && chestAt && !KEEPERS.includes(chosen[0]) && <div className="pack-store">
						{chests.length > 1 ? <select aria-label="Truhe" value={chestAt.nr} onChange={(e) => setChestNr(Number(e.target.value))}>{chests.map((x) => <option key={x.nr} value={x.nr}>{x.label}</option>)}</select> : <span>{`Truhe: ${chestAt.label}`}</span>}
						{/* how many: a number (at most what is carried), empty: one */}
						<form className="pack-store-n" onSubmit={(e) => { e.preventDefault(); const n = Math.min(chosen[1].length, Math.max(1, Math.floor(Number(storeN) || 1))); send(`verstaue ${n} ${chosen[0]} in ${chestAt.nr}`); setStoreN(""); }}>
							<input type="number" inputMode="numeric" min={1} max={chosen[1].length} value={storeN} placeholder="1" aria-label="Wie viele" onChange={(e) => setStoreN(e.target.value)} />
							<button type="submit">Stück verstauen</button>
						</form>
						{chosen[1].length > 1 && <button onClick={() => send(`verstaue alle ${chosen[0]} in ${chestAt.nr}`)}>{`Alle ${chosen[1].length} verstauen`}</button>}
					</div>}
					{/* a cross not named yet: its breeder names it here (server: garden.ts benenne; it says when one may not) */}
					{!guest && chosen[0] === "Kreuzungssamen" && (() => {
						// several crosses of one's own carried: which one is named, by its colour and the sort it came from
						const mine = [...new Map(chosen[1].flatMap((o) => (o.cross && o.cross.breeder === me ? [[o.cross.id, { ...o.cross, color: o.glyph?.color, n: chosen[1].filter((x) => x.cross?.id === o.cross!.id).length }] as const] : []))).values()];
						const pick = mine.find((x) => x.id === crossId) ?? mine[0];
						return <form className="pack-store-n pack-name-sort" onSubmit={(e) => { e.preventDefault(); const n = sortName.trim(); if (!n) return; send(pick && mine.length > 1 ? `benenne #${pick.id} ${n}` : `benenne ${n}`); setSortName(""); }}>
							{mine.length > 1 && <div className="pack-crosses" role="radiogroup" aria-label="Welche Kreuzung">{mine.map((x) => (
								<button type="button" key={x.id} role="radio" aria-checked={x === pick} className={`chip${x === pick ? " on" : ""}`} onClick={() => setCrossId(x.id)}>
									<span className="cross-dot" style={{ background: x.color ?? "#7fae6a" }} />{`aus ${x.from || "?"} ×${x.n}`}
								</button>))}</div>}
							<input type="text" value={sortName} placeholder="Name der Sorte" aria-label="Name der Sorte" maxLength={24} onChange={(e) => setSortName(e.target.value)} />
							<button type="submit">Benennen</button>
						</form>;
					})()}
					{uses && (() => {
						// what it can do here and now; the rest of the world's uses stay in the help
						// a recipe its hint below offers (the line that says what it takes, with „Herstellen“) is not a button here too
						const hinted = new Set(shownHints.flatMap((h) => (h.line ? [h.line] : [])));
						const can = itemEntries(chosen[0], { chars, objs, self, room, me, plans, guest, fuel, wild, beds: uses.beds, ...(offer ? { offer: (to: string) => offer(to, chosen[0]) } : {}) }, uses, { fuels, ...(market ? { market: () => market(chosen[0]) } : {}) }).filter((e) => !hinted.has(e.line));
						return can.length > 0 && <div className="pack-can">{can.map((e) => <button key={e.line} onClick={() => { const go = () => { if (e.run) e.run(); else send(e.line); }; if (e.confirm) void ask(e.confirm).then((ok) => { if (ok) go(); }); else go(); }}>{e.label}</button>)}</div>;
					})()}
					{shownHints.map((h) => <p key={h.id} className="pack-hint">{h.text}{h.line && <button onClick={() => send(h.line!)}>Herstellen</button>}</p>)}
				</div>}
				{kinds.length > 1 && <div className="pack-sort" role="radiogroup" aria-label="Sortieren">
					<button type="button" role="radio" aria-checked={sortBy === "A"} className={`chip${sortBy === "A" ? " on" : ""}`} title="Alphabetisch" onClick={() => sortTo("A")}>A</button>
					<button type="button" role="radio" aria-checked={sortBy === "D"} className={`chip${sortBy === "D" ? " on" : ""}`} title="Nach Eingang, das Neueste zuerst" onClick={() => sortTo("D")}>D</button>
				</div>}
				<div className="pack">{kinds.map(([name, os]) => (
					<button key={name} className={`chip pack-chip${picked === name ? " on" : ""}`} onClick={() => setPicked(picked === name ? null : name)} title={name} aria-label={`${name}: ${os.length}`} aria-pressed={picked === name}>
						<span className="pack-top"><Glyph o={os[0]!} size={24} /><span className="n">{os.length}</span></span>
						{/* what it is, under its picture: many things look alike (sacks of seed, a shell and a pebble) */}
						<span className="pack-name">{name}</span>
					</button>
				))}</div>
			</>}
		</div>
	);
}

/** What the sites of this room have hung out, and what one can do about it: go there, deliver, work; one's own site hangs
 *  out what it lacks or takes it down. Every button sends the command the help names. A site is worked on from two cells. */
function SiteOrders({ objs, self, room, me, send, walk }: { objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void; walk: (at: { x: number; y: number }) => void }) {
	const [form, setForm] = useState<{ site: string; name: string; n: string; pay: string } | null>(null);
	const sites = [...objs.values()].filter((o) => o.kind === "site" && o.location === room);
	const carried = new Set([...objs.values()].filter((o) => o.kind === "item" && o.location === me).map((o) => o.name));
	const shown = sites.filter((s) => s.orders?.length || s.ownerId === me);
	if (!shown.length) return <p className="muted bag-note">In diesem Raum hängt nichts aus. Ein Aushang gehört zu einer Baustelle: Ihr Besitzer bietet dort Lohn für das, was fehlt. Wer liefert oder mitarbeitet, wird sofort bezahlt. Der Lohn liegt schon beim Aushang.</p>;
	return (
		<div className="things orders">
			{shown.map((s) => {
				const near = !!self && Math.max(Math.max(s.x - self.x, 0, self.x - (s.x + (s.w ?? 1) - 1)), Math.max(s.y - self.y, 0, self.y - (s.y + (s.h ?? 1) - 1))) <= 2;
				const mine = s.ownerId === me, orders = s.orders ?? [];
				const open = (s.missing ?? "").split(",").map((p) => /^(\d+)\s+(.+)$/.exec(p.trim())).filter((m) => !!m).map((m) => ({ n: m![1]!, name: m![2]! })).filter((m) => !orders.some((o) => o.name === m.name));
				return (
					<section key={s.id}>
						<h3>{mine ? `Deine Baustelle ${s.name}` : `${s.name} von ${s.owner ?? ""}`}</h3>
						<ul>
							{orders.map((o) => (
								<li key={o.name}><span>{o.left} {o.name}, je {o.pay} {o.pay === 1 ? "Münze" : "Münzen"}</span>
									{!near ? <button onClick={() => walk({ x: s.x, y: s.y })}>Hingehen</button>
										: !o.proto ? <button onClick={() => send("arbeite")}>Mitarbeiten</button>
										: carried.has(o.name) ? <button onClick={() => send(`liefere ${o.name}`)}>Liefern</button>
										: <span className="muted order-need" title={mine ? "Wer welche hat, liefert sie hier und bekommt den Lohn; du kannst auch selbst liefern" : "Trägst du welche, steht hier „Liefern“"}>{`keine ${o.name} im Rucksack`}</span>}
								</li>
							))}
							{mine && open.map((m) => (
								<li key={m.name}><span>{m.n} {m.name} fehlen</span>{near ? <button onClick={() => setForm({ site: s.id, name: m.name, n: m.n, pay: "1" })}>Aushängen …</button> : <button onClick={() => walk({ x: s.x, y: s.y })}>Hingehen</button>}</li>
							))}
						</ul>
						{form?.site === s.id && (
							<form className="order-form" onSubmit={(e) => { e.preventDefault(); send(`aushang ${form.n} ${form.name.toLowerCase()} je ${form.pay}`); setForm(null); }}>
								<b>{form.name}</b>
								<label>Menge <input type="number" min={1} max={999} value={form.n} onChange={(e) => setForm({ ...form, n: e.target.value })} /></label>
								<label>Münzen je Stück <input type="number" min={1} max={999} value={form.pay} onChange={(e) => setForm({ ...form, pay: e.target.value })} /></label>
								<div className="row"><button className="primary">Aushängen</button><button type="button" onClick={() => setForm(null)}>Abbrechen</button></div>
							</form>
						)}
						{mine && near && orders.length > 0 && <button className="link" onClick={() => send("aushang ab")}>Aushang abnehmen, Lohn zurück</button>}
					</section>
				);
			})}
		</div>
	);
}

function Game({ account, onAccount, controls, startView }: { account: Account; onAccount: (a: Account | null, fresh?: boolean) => void; controls: ReactNode; startView: number }) {
	const [hello, setHello] = useState<Hello | null>(null);
	const [chars, setChars] = useState<Map<string, CharView>>(new Map());
	const [objs, setObjs] = useState<Map<string, ObjView>>(new Map());
	const [fog, setFog] = useState(0);
	const [trade, setTrade] = useState<TradeView | null>(null);
	const [atlas, setAtlas] = useState<AtlasView | null>(null);
	const [atlasState, setAtlasState] = useState<AtlasState | null>(null);
	const [offerTo, setOfferTo] = useState<string | null>(null);
	const [log, setLog] = useState<Line[]>([]);
	// the chat between players (server/chat.ts): the talks, which tab shows (the log, the overview or a talk), the talks
	// closed by the player (they come back with a new message), the groups and invitations, the last answer of the server
	const [talks, setTalks] = useState<Talks>(new Map());
	const [tab, setTabState] = useState("log");
	const tabRef = useRef("log");
	const [chatState, setChatState] = useState<ChatState | null>(null);
	const [notice, setNotice] = useState<{ text: string; error: boolean; at: number } | null>(null);
	const setTab = useCallback((k: string) => { tabRef.current = k; setTabState(k); if (k !== "log" && k !== "chats") setTalks((t) => readTalk(t, k)); }, []);
	const [live, setLive] = useState(false);
	const [line, setLine] = useState("");
	const [panel, setPanel] = useState<null | "account" | "leave" | "admin" | "alias" | "look" | "stats">(null);
	const [help, setHelp] = useState(false);
	// the answer of `help` laid out in a window like the help (CommandHelp); a topic keeps the list it came from
	const [cmdHelp, setCmdHelp] = useState<HelpView | null>(null);
	// on a phone the map modes and logging out sit behind "⋯"
	const [more, setMore] = useState(false);
	const [stale, setStale] = useState(false);
	// how far the sheet is open, the bag beside log and chats with its part, the world map as a page, the article the help opens
	// on, the steering cross (off, left, right; a mouse has no need of it), the word of a new message over the map
	useKeyboardInset();
	const [fullscreen, setFullscreenState] = useState(() => { try { return localStorage.getItem("mmo.fullscreen") !== "0"; } catch { return true; } });
	const setFullscreen = (on: boolean) => { setFullscreenState(on); try { localStorage.setItem("mmo.fullscreen", on ? "1" : "0"); } catch { /* private window */ } if (on) enterFullscreen(); else if (document.fullscreenElement) void document.exitFullscreen().catch(() => {}); };
	useLandscapeFullscreen(fullscreen);
	usePageHeld(true);
	// the game from the home screen has no browser bars at all (an iPhone has no other full screen): once, how to get there;
	// where the browser offers to install it, a button does it
	const steps = homeSteps();
	const [homeHint, setHomeHint] = useState(() => { try { return !!steps && localStorage.getItem("mmo.homeHint") !== "1"; } catch { return !!steps; } });
	const [install, setInstall] = useState<(Event & { prompt: () => Promise<void> }) | null>(null);
	useEffect(() => { const on = (e: Event) => { e.preventDefault(); setInstall(e as Event & { prompt: () => Promise<void> }); }; window.addEventListener("beforeinstallprompt", on); return () => window.removeEventListener("beforeinstallprompt", on); }, []);
	const hideHomeHint = () => { setHomeHint(false); try { localStorage.setItem("mmo.homeHint", "1"); } catch { /* private window */ } };
	const [detent, setDetent] = useState<Detent>("peek");
	// what can be done here lies folded in one chip; a tap opens the list, the next tap on the map or an action closes it
	const [hereOpen, setHereOpen] = useState(false);
	/** Where the last finger or mouse went down: a tap's action card opens on the other side of the screen. */
	const lastPress = useRef({ x: 0, y: 0 });
	// the HUD, the chip and the pad fade after a few seconds without a touch; any touch brings them back (other games call it immersive)
	const [calm, setCalm] = useState(false);
	const calmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const wake = useCallback(() => {
		setCalm(false);
		if (calmTimer.current) clearTimeout(calmTimer.current);
		calmTimer.current = setTimeout(() => setCalm(true), CALM_MS);
	}, []);
	useEffect(() => { wake(); return () => { if (calmTimer.current) clearTimeout(calmTimer.current); }; }, [wake]);
	// the height the sheet was pulled to, remembered per browser
	const [sheetPx, setSheetPxState] = useState<number | null>(() => { try { const v = Number(localStorage.getItem("mmo.sheet")); return v > 0 ? v : null; } catch { return null; } });
	const [sheetAt, setSheetAtState] = useState<number | null>(() => { try { const v = localStorage.getItem("mmo.sheet.x"); return v === null ? null : Number(v); } catch { return null; } });
	const setSheetAt = (x: number) => { setSheetAtState(x); try { localStorage.setItem("mmo.sheet.x", x.toFixed(4)); } catch { /* private window */ } };
	const setSheetPx = (h: number) => { setSheetPxState(h); try { localStorage.setItem("mmo.sheet", String(Math.round(h))); } catch { /* private window */ } };
	const [bag, setBag] = useState(false);
	const [bagPart, setBagPart] = useState<"mine" | "here" | "market" | "orders">("mine");
	const [tradeItem, setTradeItem] = useState<{ name: string } | null>(null);
	const tapFrom = useRef<{ id: number; x: number; y: number; at: number } | null>(null);
	const [atlasPage, setAtlasPage] = useState(false);
	const [helpArticle, setHelpArticle] = useState<string | null>(null);
	const [pad, setPadState] = useState<"off" | "left" | "right">(() => { try { const v = localStorage.getItem("mmo.pad"); return v === "off" || v === "left" || v === "right" ? v : isTouch() ? "right" : "off"; } catch { return "right"; } });
	const setPad = (v: "off" | "left" | "right") => { setPadState(v); try { localStorage.setItem("mmo.pad", v); } catch { /* private window */ } };
	const [toast, setToast] = useState<{ key: string; from: string } | null>(null);
	useEffect(() => { if (!toast) return; const t = setTimeout(() => setToast(null), 6000); return () => clearTimeout(t); }, [toast]);
	// Text, established 2D or optional 3D: remembered per browser. The old text-only preference migrates forward.
	// coming and going in the log ("… geht nach ost.", "… kommt an."): hidden unless asked for, remembered in the browser
	const [comings, setComingsState] = useState(() => { try { return localStorage.getItem("mmo.comings") === "1"; } catch { return false; } });
	const setComings = (on: boolean) => { setComingsState(on); try { localStorage.setItem("mmo.comings", on ? "1" : "0"); } catch { /* private window */ } };
	// the events in two parts: what is for the own figure (its answers, whispers, offers, hints) and what happens around it;
	// `seen`: the last line of each part when it was last in front (or at the start), for the count of new lines on the other
	const [logPart, setLogPartState] = useState<LogPart>(() => { try { const v = localStorage.getItem("mmo.logPart"); return v === "all" || v === "tips" || v === "todo" ? v : "mine"; } catch { return "mine"; } });
	const [seenLine, setSeenLine] = useState<{ mine?: Line | null; all?: Line | null }>({});
	// on the way to another place (travel.ts): what the page says when the new place takes longer than a second
	const [travelNote, setTravelNote] = useState<string | null>(null);
	const travel = useRef<{ timer?: ReturnType<typeof setTimeout>; giveUp?: ReturnType<typeof setTimeout> }>({});
	const endTravel = useCallback(() => { clearTimeout(travel.current.timer); clearTimeout(travel.current.giveUp); travel.current = {}; setTravelNote(null); }, []);
	const startTravel = useCallback((text: string) => {
		endTravel();
		travel.current.timer = setTimeout(() => setTravelNote(text), TRAVEL_NOTE_MS);
		travel.current.giveUp = setTimeout(endTravel, TRAVEL_GIVE_UP_MS);
	}, [endTravel]);
	const setLogPart = useCallback((k: LogPart) => { setLogPartState(k); try { localStorage.setItem("mmo.logPart", k); } catch { /* private window */ } }, []);
	const [mapMode, setMapModeState] = useState<MapMode>(() => readMapMode());
	const previousStart = useRef(startView);
	useEffect(() => { if (previousStart.current !== startView) { previousStart.current = startView; setMapModeState("3d"); } }, [startView]);
	const [menu, setMenu] = useState<null | { x: number; y: number; left: number; top: number }>(null);
	const [nameMenu, setNameMenu] = useState<null | { name: string; left: number; top: number }>(null);
	const setMapMode = (mode: MapMode) => { setMenu(null); setMapModeState(mode); try { localStorage.setItem("mmo.renderer", mode); localStorage.setItem("mmo.textOnly", mode === "text" ? "1" : "0"); } catch { /* private window */ } };
	const ws = useRef<WebSocket | null>(null);
	const stopWalk = useRef(() => {});
	const openLineRef = useRef(() => {});
	// the end-to-end keys of the chat (client/useChat.ts): its frames go through the same socket
	const sendFrame = useCallback((f: unknown) => { const s = ws.current; if (!s || s.readyState !== WebSocket.OPEN) return false; s.send(JSON.stringify(f)); return true; }, []);
	const keys = useChat(sendFrame);
	const keysRef = useRef(keys);
	keysRef.current = keys;
	/** A message typed as "chat <name> <text>" waits for its talk to open, then is sealed and sent. */
	const pendingChat = useRef<{ name: string; text: string } | null>(null);
	/** A message of a talk: sealed for its readers on this page, then sent; what goes wrong shows under the talk. */
	const sealAndSend = useCallback(async (conv: { kind: "dm" | "group"; id: string; title: string }, text: string) => {
		try {
			const missing = await keysRef.current.sendText(conv, text);
			if (missing.length) setNotice({ text: `${missing.join(", ")} hat den Chat noch nicht eingerichtet. Die Nachricht kommt an, sobald das geschehen ist.`, error: false, at: Date.now() });
		} catch (e) { setNotice({ text: (e as Error).message, error: true, at: Date.now() }); }
	}, []);
	const logBox = useRef<HTMLDivElement>(null);
	// the log follows while one stands at its end; who reads further up stays there and is told of what is new
	const atEnd = useRef(true);
	const [behind, setBehind] = useState(false);
	const input = useRef<HTMLInputElement>(null);
	const me = hello?.me.charId ?? "";
	// the pack newest first (client/arrivals.ts): what came into it when, per kind
	const arrivalsSeen = useRef<Set<string> | null>(null), arrivals = useRef<{ me: string; at: Arrivals }>({ me: "", at: new Map() });
	const [arrived, setArrived] = useState<ReadonlyMap<string, number>>(new Map());
	useEffect(() => {
		if (!me) return;
		if (arrivals.current.me !== me) { arrivals.current = { me, at: loadArrivals(me) }; setArrived(new Map(arrivals.current.at)); }
		const carried = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
		const r = noteArrivals(arrivalsSeen.current, carried, arrivals.current.at, Date.now());
		arrivalsSeen.current = r.seen;
		if (r.changed) { saveArrivals(me, arrivals.current.at); setArrived(new Map(arrivals.current.at)); }
	}, [objs, me]);
	// the 3D map's frame rate (client/fps.ts): the bar's button starts a measurement and shows its result
	const [fps, setFps] = useState<FpsState>({ running: false, fps: null });
	useEffect(() => onFps(setFps), []);
	// the own figure's walk: drawn ahead of the server, matched by step numbers (client/walk.ts)
	const walker = useRef(new Walker());
	// the world's clock as the server last told it; shown by interpolation, nothing is decided by it
	const [wind, setWind] = useState("");
	const [worldTime, setWorldTime] = useState<{ v: WorldTimeView; at: number } | null>(null);
	const [, setTick] = useState(0);
	useEffect(() => { if (!worldTime || worldTime.v.paused) return; const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, [worldTime]);
	const meRef = useRef("");
	meRef.current = me;
	const nameRef = useRef(account.name), detentRef = useRef(detent), bagRef = useRef(bag);
	nameRef.current = account.name; detentRef.current = detent; bagRef.current = bag;
	// a command's answer lands in the log: the log opens on it, unless a talk or the chats are in front
	const awaited = useRef(0);
	const [logFit, setLogFit] = useState<number | null>(null);
	const showAnswer = useCallback(() => {
		if (Date.now() - awaited.current > ANSWER_MS) return;
		awaited.current = 0;
		if (!bagRef.current && tabRef.current !== "log") return;
		// a phone keeps the sheet closed: the answer stands in its strip, a tap on it opens the log
		if (detentRef.current === "peek" && isTouch()) return;
		if (tabRef.current !== "log") setTab("log");
		setLogPart("mine");
		atEnd.current = true;
		setBehind(false);
		setBag(false);
		if (detentRef.current === "peek") { setLogFit(logOpenPx()); setDetent("half"); }
	}, [setTab, setLogPart]);
	/** Draws the own figure at `at` (where the walk puts it). */
	const showOwn = useCallback((at: { x: number; y: number } | null) => {
		if (!at) return;
		setChars((m) => { const c = m.get(meRef.current); return c && (c.x !== at.x || c.y !== at.y) ? new Map(m).set(c.charId, { ...c, x: at.x, y: at.y }) : m; });
	}, []);

	const append = useCallback((l: Line) => setLog((old) => appendLine(old, l)), []);

	// the game socket; it reconnects with a backoff, and a socket refused for a lapsed login logs out
	useEffect(() => {
		let dead = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined, greeted = false;
		const goneTimers = new Map<string, ReturnType<typeof setTimeout>>();
		const connect = () => {
			const s = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
			ws.current = s;
			s.onopen = () => setLive(true);
			s.onmessage = (e) => {
				const f = JSON.parse(String(e.data)) as ServerFrame;
				if (f.t === "hello") {
					// the server runs a newer build than this page: reload, so the page understands what it is sent
					if (pageBuild && f.build && f.build !== pageBuild) { setStale(true); setTimeout(() => location.reload(), 1500); return; }
					stopWalk.current(); endTravel(); retry = 0; setHello(f); setWind(f.wind); setWorldTime(f.worldTime ? { v: f.worldTime, at: Date.now() } : null);
					for (const t of goneTimers.values()) clearTimeout(t); goneTimers.clear();
					meRef.current = f.me.charId;
					{ const mine = f.chars.find((c) => c.charId === f.me.charId); if (mine) walker.current.reset(mine); } fuels = f.world.fuels;
					setChars(new Map(f.chars.map((c) => [c.charId, c])));
					setObjs(new Map(f.objs.map((o) => [o.id, o])));
					arrivalsSeen.current = null; // a full picture: nothing in it came just now
					setFog(f.fog);
					// the first hello brings the room's recent talk; a later one (another room, a reconnect) keeps the log
					if (!greeted) setLog(f.log); else append({ kind: "echo", text: `— ${f.room.name} —`, from: "", at: Date.now() });
					greeted = true;
				}
				else if (f.t === "char") {
					clearTimeout(goneTimers.get(f.c.charId)); goneTimers.delete(f.c.charId);
					// the own figure: drawn where the walk puts it (the server's place plus the steps still on their way)
					if (f.c.charId === meRef.current) {
							endTravel();
						const at = walker.current.report(f.c, f.ack, Date.now());
						setChars((m) => { const old = m.get(f.c.charId); return new Map(m).set(f.c.charId, { ...f.c, ...(at ?? (old ? { x: old.x, y: old.y } : {})) }); });
						return;
					}
					setChars((m) => new Map(m).set(f.c.charId, f.c));
				}
				else if (f.t === "gone") {
					// A character that takes a step is gone from the space for the moment its move is committed (the server takes
					// its entry and writes it back): when that moment is long, a figure that vanishes and comes back is a
					// flicker. So a "gone" counts only if no "char" for it follows within a moment; the own figure never goes
					// this way (leaving a room comes as a new hello).
					if (f.charId === meRef.current) return;
					clearTimeout(goneTimers.get(f.charId));
					goneTimers.set(f.charId, setTimeout(() => { goneTimers.delete(f.charId); setChars((m) => { if (!m.has(f.charId)) return m; const n = new Map(m); n.delete(f.charId); return n; }); }, GONE_GRACE_MS));
				}
				else if (f.t === "obj") { pickups.current.delete(f.o.id); setObjs((m) => new Map(m).set(f.o.id, f.o)); }
				else if (f.t === "fog") setFog(f.level);
				else if (f.t === "wind") setWind(f.wind);
				else if (f.t === "time") setWorldTime({ v: f.time, at: Date.now() });
				else if (f.t === "trade") setTrade(f.trade);
				else if (f.t === "atlas") setAtlas(f.atlas);
				else if (f.t === "atlasState") setAtlasState(f.state);
				else if (f.t === "objgone") { pickups.current.delete(f.id); setObjs((m) => { const n = new Map(m); n.delete(f.id); return n; }); }
				else if (f.t === "msg" && f.m.kind === "help" && f.m.help) {
					const h = f.m.help;
					setCmdHelp((old) => (h.topic ? { intro: old?.intro, commands: old?.commands, topics: old?.topics, topic: h.topic } : h));
					setHelp(false);
					append({ ...f.m, text: h.topic ? `Hilfe zu „${h.topic.key}“ ist geöffnet.` : "Die Befehle sind geöffnet (help)." });
				}
				else if (f.t === "msg") { if (f.m.kind === "error") { putBack(); endTravel(); } showAnswer(); append(f.m); if (tabRef.current !== "log" && (f.m.kind === "error" || f.m.kind === "info")) setNotice({ text: f.m.text, error: f.m.kind === "error", at: Date.now() }); }
				else if (f.t === "chatme" || f.t === "chatkeys") keysRef.current.onFrame(f);
				else if (f.t === "chatlog") { keysRef.current.onFrame(f); setTalks(fromLog(f.msgs, tabRef.current)); }
				else if (f.t === "chat") {
					keysRef.current.onFrame(f);
					setTalks((t) => { const n = addMsg(t, f.m, tabRef.current); return tabRef.current === keyOf(f.m.conv) ? readTalk(n, tabRef.current) : n; });
					if (f.m.from && f.m.from !== nameRef.current && (tabRef.current !== keyOf(f.m.conv) || detentRef.current === "peek")) setToast({ key: keyOf(f.m.conv), from: f.m.conv.kind === "group" ? `# ${f.m.conv.title}` : f.m.from });
				}
				else if (f.t === "chats") setChatState(f.state);
				else if (f.t === "chatopen") {
					setTalks((t) => openTalk(t, f.conv)); setTab(keyOf(f.conv));
					const p = pendingChat.current;
					if (p && p.name.toLowerCase() === f.conv.title.toLowerCase()) { pendingChat.current = null; void sealAndSend(f.conv, p.text); }
				}
			};
			s.onclose = () => {
				setLive(false);
				if (dead) return;
				void fetch("/api/me").then((r) => r.json()).then((d) => { if (!d.account) onAccount(null); }, () => {});
				timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++));
			};
		};
		connect();
		return () => { dead = true; clearTimeout(timer); for (const t of goneTimers.values()) clearTimeout(t); ws.current?.close(); };
	}, [append, onAccount, setTab, endTravel]);

	useEffect(() => { const b = logBox.current; if (!b) return; if (atEnd.current) b.scrollTop = b.scrollHeight; else setBehind(true); }, [log, bag, tab, detent, logPart]);
	const toLogEnd = () => { const b = logBox.current; if (b) b.scrollTop = b.scrollHeight; atEnd.current = true; setBehind(false); };

	const send = useCallback((text: string, echo = true, opensLog = echo) => {
		const s = ws.current;
		if (!s || s.readyState !== WebSocket.OPEN) { append({ kind: "error", text: "Nicht verbunden; ein Moment …", from: "", at: Date.now() }); return; }
		s.send(JSON.stringify({ t: "cmd", line: text, ...(language() === "en" ? { lang: "en" } : {}) } satisfies ClientFrame));
		{ const t = travelText(text, travelExits.current); if (t) startTravel(t); }
		if (echo) append({ kind: "echo", text: `> ${text}`, from: "", at: Date.now() });
		awaited.current = opensLog ? Date.now() : 0;
	}, [append, startTravel]);

	// what the walk looks at between renders (the hold timer runs outside React's render)
	const seen = useRef({ chars, objs, hello });
	seen.current = { chars, objs, hello };
	// the room's exits for the travel note: an exit to a room of another island is a ferry
	const travelExits = useRef<Array<{ name: string; to?: string; ferry?: boolean }>>([]);
	{ const island = (id?: string) => atlas?.rooms.find((r) => r.roomId === id)?.island;
		travelExits.current = [...objs.values()].filter((o) => o.kind === "exit").map((o) => ({ name: o.name, to: o.to, ferry: !!o.toRoom && !!island(hello?.room.roomId) && island(o.toRoom) !== island(hello?.room.roomId) })); }

	/** One step of the own figure: by `d`, or toward a tapped cell (the longer axis first; if that cell is not free, the
	 *  other axis). It is drawn at once and sent with its number; a cell that is not free is not walked into. */
	const freeCells = useCallback(() => {
		const { chars, objs, hello } = seen.current;
		if (!hello) return () => false;
		// a bed or field under one's feet: one walks off over it, as the server lets one
		const from = walker.current.shown;
		// walkable and nobody standing there (the server checks again and answers either way); at a door (an exit's cell or
		// one next to it) others do not block: one walks through them, as the server lets one (engine/occupancy.ts)
		const exits = [...objs.values()].filter((o) => o.kind === "exit" && o.location === hello.room.roomId);
		const passage = (c: { x: number; y: number }) => exits.some((e) => Math.max(Math.abs(e.x - c.x), Math.abs(e.y - c.y)) <= 1);
		const taken = new Set([...[...chars.values()].filter((c) => c.charId !== meRef.current && !passage(c)), ...[...objs.values()].filter((o) => o.kind === "beacon" && o.location === hello.room.roomId)].map((c) => `${c.x},${c.y}`));
		// sites and buildings cover their cells: nobody walks into them (server: occupancy.ts blockedIn)
		for (const o of objs.values()) if ((o.kind === "site" || o.kind === "building" || o.kind === "ruin" || o.kind === "bed" || o.kind === "field" || o.kind === "tree" || (o.kind === "scenery" && !o.through)) && !(from && (o.kind === "bed" || o.kind === "field") && from.x >= o.x && from.y >= o.y && from.x < o.x + (o.w ?? 1) && from.y < o.y + (o.h ?? 1)) && o.location === hello.room.roomId) for (let dy = 0; dy < (o.h ?? 1); dy++) for (let dx = 0; dx < (o.w ?? 1); dx++) taken.add(`${o.x + dx},${o.y + dy}`);
		return (x: number, y: number) => !!hello.world.tiles[hello.room.ground[y]?.[x] ?? ""]?.walk && !taken.has(`${x},${y}`);
	}, []);
	const step = useCallback((d: [number, number] | { x: number; y: number }) => {
		const from = walker.current.shown;
		if (!from || !seen.current.hello) return;
		const s = ws.current;
		if (!s || s.readyState !== WebSocket.OPEN) return;
		const free = freeCells();
		let moves: Array<[number, number]>;
		if (Array.isArray(d)) moves = [d];
		else {
			const dx = Math.sign(d.x - from.x), dy = Math.sign(d.y - from.y);
			if (!dx && !dy) return;
			const horizontal = Math.abs(d.x - from.x) >= Math.abs(d.y - from.y);
			moves = (horizontal ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]] as Array<[number, number]>).filter(([a, b]) => a || b) as Array<[number, number]>;
		}
		const go = moves.find(([a, b]) => free(from.x + a, from.y + b));
		if (!go) return;
		const st = walker.current.step(go[0], go[1], Date.now());
		if (!st) return;
		s.send(JSON.stringify({ t: "step", seq: st.seq, dx: st.dx, dy: st.dy }));
		showOwn(walker.current.shown);
	}, [showOwn, freeCells]);

	// a tap on a touch screen walks the whole way: steps like a held key's, so the figure is seen walking and a new tap or the
	// cross ends it at once. (`move` would set it down at the end in one go.) The way is searched anew at every step.
	const [walkGoal, setWalkGoal] = useState<{ x: number; y: number } | null>(null);
	const walkTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	stopWalk.current = () => { if (walkTimer.current) clearInterval(walkTimer.current); walkTimer.current = null; setWalkGoal(null); };
	const walkTo = useCallback((goal: { x: number; y: number }) => {
		stopWalk.current();
		const start = walker.current.shown;
		if (!start) return;
		// on something that stands there one cannot stand: the nearest cell a way leads to, the one beside it
		const free = freeCells(), cells: Array<{ x: number; y: number }> = [goal];
		for (let r = 1; r <= 6; r++) for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (Math.max(Math.abs(dx), Math.abs(dy)) === r) cells.push({ x: goal.x + dx, y: goal.y + dy });
		const here = (c: { x: number; y: number }) => c.x === start.x && c.y === start.y;
		const end = free(goal.x, goal.y) ? goal : cells.find((c) => (free(c.x, c.y) || here(c)) && (here(c) || nextStep(free, start, c)));
		const way = () => { const from = walker.current.shown; return from && end ? nextStep(freeCells(), from, end) : null; };
		if (end && here(end)) return;
		if (!way()) { if (!here(goal)) append({ kind: "error", text: "Dorthin führt kein Weg.", from: "", at: Date.now() }); return; }
		setWalkGoal(end!);
		const tick = () => {
			const go = way();
			if (!go) return stopWalk.current();
			if (walker.current.ahead >= MAX_AHEAD) return; // the answers come first
			step(go);
		};
		tick();
		walkTimer.current = setInterval(tick, WALK_MS);
	}, [freeCells, step, append]);
	useEffect(() => () => stopWalk.current(), []);

	// steps without any answer for a while are given up: the figure goes to the server's place
	useEffect(() => { const t = setInterval(() => showOwn(walker.current.tick(Date.now())), 500); return () => clearInterval(t); }, [showOwn]);

	// a held arrow key walks at an even pace (its own timer, not the keyboard's repeat, which starts late and unevenly);
	// the last key pressed leads; letting go of all of them stops at once
	const held = useRef<Array<[number, number]>>([]);
	const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
	// in the 3D view an arrow means a direction on the screen: it walks the way the view is turned (screenToGrid)
	const viewAngle = useRef<number | null>(null);
	const modeRef = useRef(mapMode);
	modeRef.current = mapMode;
	const onTurn = useCallback((a: number) => { viewAngle.current = a; }, []);
	const onGrid = useCallback((d: [number, number]): [number, number] => (modeRef.current === "3d" && viewAngle.current !== null ? screenToGrid(d, viewAngle.current) : d), []);
	const hold = useCallback((d: [number, number]) => {
		held.current = [...held.current.filter(([a, b]) => a !== d[0] || b !== d[1]), d];
		step(onGrid(d));
		holdTimer.current ??= setInterval(() => { const last = held.current.at(-1); if (last) step(onGrid(last)); }, WALK_MS);
	}, [step, onGrid]);
	const release = useCallback((d?: [number, number]) => {
		held.current = d ? held.current.filter(([a, b]) => a !== d[0] || b !== d[1]) : [];
		if (!held.current.length && holdTimer.current) { clearInterval(holdTimer.current); holdTimer.current = null; }
	}, []);
	useEffect(() => {
		const stop = () => release();
		window.addEventListener("blur", stop);
		document.addEventListener("visibilitychange", stop);
		return () => { window.removeEventListener("blur", stop); document.removeEventListener("visibilitychange", stop); stop(); };
	}, [release]);

	// picking up: the thing goes into the pack at once, as the figure walks ahead of the server (the server takes it after
	// the steps still on their way); a refusal, or no word from the server within PICKUP_MS, puts it back where it lay
	const pickups = useRef(new Map<string, { o: ObjView; at: number }>());
	const pickUp = useCallback((o: ObjView) => {
		pickups.current.set(o.id, { o, at: Date.now() });
		setObjs((m) => new Map(m).set(o.id, { ...o, location: meRef.current, x: -1, y: -1 }));
		send(`get ${o.name}`, true, false); // picking up goes on while walking: the sheet stays as it is
	}, [send]);
	const putBack = useCallback((older = 0) => {
		const back = [...pickups.current.values()].filter((p) => Date.now() - p.at >= older);
		if (!back.length) return;
		for (const p of back) pickups.current.delete(p.o.id);
		setObjs((m) => { const n = new Map(m); for (const p of back) n.set(p.o.id, p.o); return n; });
	}, []);
	useEffect(() => { const t = setInterval(() => putBack(PICKUP_MS), 500); return () => clearInterval(t); }, [putBack]);

	/** Space: pick up what lies nearest (the own cell first); with nothing there, feed a fire within reach. */
	const action = useCallback(() => {
		const self = chars.get(me);
		if (!self || !hello) return;
		const d = (o: ObjView) => Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y));
		const near = [...objs.values()].filter((o) => o.location === hello.room.roomId && d(o) <= 1);
		const item = near.filter((o) => o.kind === "item").sort((a, b) => d(a) - d(b))[0];
		if (item) return pickUp(item);
		const fire = near.find((o) => o.kind === "beacon");
		const fuel = fuelIn(objs, me);
		if (fire && fuel) return send(`put ${fuel.name} in ${fire.name}`);
		append({ kind: "error", text: "Hier liegt nichts zum Aufheben.", from: "", at: Date.now() });
	}, [chars, me, hello, objs, send, append, pickUp]);

	// a double click (or double tap) on a thing on the map: walk there (the first click already does) and pick it up as
	// Space does, once the figure stands next to it
	const fetching = useRef<{ id: string; until: number } | null>(null);
	const lastTap = useRef<{ x: number; y: number; at: number } | null>(null);
	const onCell = useCallback((x: number, y: number) => {
		const now = Date.now(), prev = lastTap.current;
		lastTap.current = { x, y, at: now };
		step({ x, y });
		if (!prev || prev.x !== x || prev.y !== y || now - prev.at > DOUBLE_MS || !hello) return;
		lastTap.current = null;
		const item = [...objs.values()].find((o) => o.kind === "item" && o.location === hello.room.roomId && o.x === x && o.y === y);
		if (item) fetching.current = { id: item.id, until: now + FETCH_MS };
	}, [step, objs, hello]);
	// the large ship lies in this bay by the timetable (the world time the page shows): a thing on the water, for the eye
	const liner = hello?.world.liner, stopAt = liner && hello ? liner.stops.findIndex((x) => x.room === hello.room.roomId) : -1, bay = stopAt >= 0;
	const berthAt = useMemo(() => (bay && hello?.room.spawn ? berth(hello.room.ground, hello.room.spawn) : null), [bay, hello?.room]);
	// it runs into the bay and out of it over a few world minutes (shipPlace), so it is redrawn every second while it moves
	const [, setShipTick] = useState(0);
	const place = berthAt && worldTime ? shipPlace(liner!, shownWorldMs(worldTime.v, worldTime.at, Date.now()), stopAt) : null;
	const moving = place?.phase === "arriving" || place?.phase === "leaving";
	useEffect(() => { if (!moving) return; const id = setInterval(() => setShipTick((n) => n + 1), 1000); return () => clearInterval(id); }, [moving]);
	const shipWay = useMemo(() => (berthAt && hello ? lane(hello.room.ground, berthAt) : null), [berthAt, hello?.room]);
	const shipShown = !!place && place.phase !== "away" && (place.away < 0.98 || !!shipWay);
	const shipLies = shipShown;
	// a passenger of the large ship is hidden from the map (and from the others): its page says where it sails
	const aboard = chars.get(me)?.aboard ?? null;
	// what was said lately, for the speech bubbles of the 3D view's close level (the log stays the record)
	const said = useMemo(() => log.filter((l): l is MsgView => l.kind === "say" && !!l.from).slice(-8).map((l) => ({ from: l.from, text: l.text, at: l.at })), [log]);
	const mapChars = useMemo(() => (aboard ? new Map([...chars].filter(([id]) => id !== me)) : chars), [chars, me, aboard]);
	useEffect(() => { if (!aboard) return; const id = setInterval(() => setShipTick((n) => n + 1), 5000); return () => clearInterval(id); }, [aboard]);
	// the island railway's tracks through this room (engine/rail.ts): from the stations of the region and this room's exits,
	// first in the map so everything stands on them; they block nothing
	const railPlan = hello?.world.rail?.plan, stations = atlasState?.stops.stations.join(",") ?? "";
	const track = useMemo(() => {
		if (!hello || !atlas || !railPlan || !stations) return null;
		const room = hello.room.roomId, net = railLinks(atlas.rooms, atlas.links, stations.split(","));
		const here = [...objs.values()].filter((o) => o.location === room);
		const exits = here.filter((o) => o.kind === "exit" && !!o.toRoom && net.has(`${room}|${o.toRoom}`)).sort((a, b) => a.id.localeCompare(b.id));
		const station = here.find((o) => o.kind === "building" && o.plan === railPlan);
		if (!exits.length || (!station && exits.length < 2)) return null;
		const blocked = new Set<string>();
		for (const o of here) if (["building", "site", "ruin", "bed", "field", "tree"].includes(o.kind) || (o.kind === "scenery" && !o.through)) for (let y = o.y; y < o.y + (o.h ?? 1); y++) for (let x = o.x; x < o.x + (o.w ?? 1); x++) blocked.add(`${x},${y}`);
		const runs = trackCells(hello.room.ground, station ? { x: station.x, y: station.y, w: station.w ?? 1, h: station.h ?? 1 } : null, exits, blocked);
		return runs.length ? ({ id: "track", kind: "track", name: "Gleis", location: room, x: -1, y: -1, through: true, runs, fromStation: !!station } as ObjView) : null; // off the grid: no menu, no "Was ist das?" lands on it
	}, [hello, atlas, railPlan, stations, objs]);
	// the train at this room's station while the timetable has it there (engine/rail.ts trainIn), on the station's own track
	const stationHere = track?.fromStation ? [...objs.values()].find((o) => o.location === track.location && o.kind === "building" && o.plan === railPlan) : undefined;
	const trainStands = !!stationHere && !!worldTime && trainIn(shownWorldMs(worldTime.v, worldTime.at, Date.now()), hello?.world.rail?.everyWorldMs) === 0;
	const shownObjs = useMemo(() => {
		const base = track ? new Map([["track", track], ...objs]) : objs;
		const all = trainStands && stationHere ? new Map(base).set("train", { id: "train", kind: "train", name: "Zug", location: stationHere.location, x: stationHere.x, y: stationHere.y, w: stationHere.w ?? 1, h: stationHere.h ?? 1, through: true } as ObjView) : base;
		return shipLies && berthAt && hello ? new Map(all).set("liner", { id: "liner", kind: "liner", name: "Großes Schiff", location: hello.room.roomId, fare: liner!.fare, routes: liner!.routes.filter((r) => r.room !== hello.room.roomId), x: berthAt.x + (shipWay?.sx ?? 0) * (place?.away ?? 0) * (shipWay?.dist ?? 0), y: berthAt.y + (shipWay?.sy ?? 0) * (place?.away ?? 0) * (shipWay?.dist ?? 0), gliding: place?.phase !== "lies", w: berthAt.along === "x" ? SHIP_LENGTH : 1, h: berthAt.along === "y" ? SHIP_LENGTH : 1 } as ObjView) : all;
	}, [objs, track, trainStands, stationHere, shipLies, berthAt, hello, place?.phase, place?.away, shipWay]);

	/** A tap of a finger: on a thing lying there, go and pick it up; on what stands there, its actions (a phone); else walk. */
	const onTap = useCallback((x: number, y: number) => {
		if (!isTouch() || !hello) return onCell(x, y);
		const room = hello.room.roomId, hit = tapTarget({ x, y }, chars, shownObjs, room, me), at = hit ?? { x, y };
		const item = [...objs.values()].find((o) => o.kind === "item" && o.location === room && o.x === at.x && o.y === at.y);
		if (item) { fetching.current = { id: item.id, until: Date.now() + FETCH_MS }; walkTo(at); return; }
		// a fire out of reach: to it, "Hier möglich" then offers to feed it
		const fire = [...objs.values()].find((o) => o.kind === "beacon" && o.location === room && o.x === at.x && o.y === at.y), own = chars.get(me);
		if (fire && own && Math.max(Math.abs(fire.x - own.x), Math.abs(fire.y - own.y)) > 1) { walkTo(at); return; }
		if (hit) { stopWalk.current(); setMenu({ x: at.x, y: at.y, left: lastPress.current.x, top: lastPress.current.y }); return; }
		walkTo({ x, y });
	}, [hello, chars, objs, shownObjs, me, onCell, walkTo]);
	useEffect(() => {
		const f = fetching.current, self = chars.get(me);
		if (!f || !self || !hello) return;
		const o = objs.get(f.id);
		if (!o || o.location !== hello.room.roomId || Date.now() > f.until) { fetching.current = null; return; }
		if (Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1) { fetching.current = null; stopWalk.current(); pickUp(o); }
	}, [chars, objs, me, hello, pickUp]);

	// an arrow key in the command line goes back to the map and walks: up and down always, left and right while the line is
	// empty (with text in it they move the cursor)
	const onCommandKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (e.key === "Escape") { input.current?.blur(); return; }
		const d = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
		if (!d || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
		if (d[1] === 0 && line !== "") return;
		e.preventDefault();
		input.current?.blur();
		if (!e.repeat) hold(d);
	};

	// arrow keys walk while held, space picks up, unless the command line has the focus
	useEffect(() => {
		const dirOf = (k: string) => ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[k];
		const onKey = (e: KeyboardEvent) => {
			if (document.activeElement === input.current || ["INPUT", "TEXTAREA", "SELECT"].includes((e.target as HTMLElement)?.tagName)) return;
			if (e.key === "Enter") { e.preventDefault(); release(); openLineRef.current(); return; }
			if (e.key === " ") { e.preventDefault(); if (!e.repeat) action(); return; }
			// typing text: the first letter goes to the command line, which takes the rest (a shortcut with Ctrl, Alt or
			// Cmd stays the browser's)
			if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
				e.preventDefault();
				release();
				setLine((l) => l + e.key);
				openLineRef.current();
				requestAnimationFrame(() => { const el = input.current; if (el) { const n = el.value.length; el.setSelectionRange(n, n); } });
				return;
			}
			const d = dirOf(e.key);
			if (!d) return;
			e.preventDefault();
			if (!e.repeat) hold(d); // the keyboard's repeat is not used: the hold timer paces the walk
		};
		const onUp = (e: KeyboardEvent) => { const d = dirOf(e.key); if (d) release(d); };
		window.addEventListener("keydown", onKey);
		window.addEventListener("keyup", onUp);
		return () => { window.removeEventListener("keydown", onKey); window.removeEventListener("keyup", onUp); };
	}, [hold, release, action]);

	const logout = async () => { await post("/api/logout").catch(() => {}); await forgetDeviceKeys(); onAccount(null); };

	// a phone's layers: the back gesture closes them, the topmost first
	useBack(help, () => setHelp(false));
	useBack(!!cmdHelp && !help, () => setCmdHelp(null));
	useBack(more, () => setMore(false));
	useBack(atlasPage, () => setAtlasPage(false));
	useBack(!!panel, () => setPanel(null));

	// hints from what one carries (client/hints.ts): each new one once as a line of the log, all of a thing beside it in
	// the pack; off under "⋯"
	const [hintsOn, setHintsOnState] = useState(() => { try { return localStorage.getItem("mmo.hints") !== "0"; } catch { return true; } });
	const setHintsOn = (on: boolean) => { setHintsOnState(on); try { localStorage.setItem("mmo.hints", on ? "1" : "0"); } catch { /* private window */ } };
	const hints = useMemo(() => {
		const uses = hello?.world.uses;
		if (!uses || !me || !hintsOn) return [];
		const carried = new Map<string, number>(), owned = new Set<string>();
		for (const o of objs.values()) {
			if (o.kind === "item" && o.location === me) carried.set(o.name, (carried.get(o.name) ?? 0) + 1);
			else if (o.kind === "building" && o.ownerId === me && o.plan) owned.add(o.plan);
		}
		return hintsFor(carried, uses, hello.world.plans, owned);
	}, [objs, hello, me, hintsOn]);
	// the hints stay in their tab: the ones not looked at yet are counted on it and marked in it (remembered in the browser)
	const [hintsSeen, setHintsSeen] = useState<ReadonlySet<string>>(() => { try { return new Set(JSON.parse(localStorage.getItem("mmo.hints.seen") ?? "[]") as string[]); } catch { return new Set(); } });
	const newHints = hints.filter((h) => !hintsSeen.has(h.id)).length;

	/** The sheet's tabs: Aktionen (`bag`: what one has and can do, with the command line), the log, the chats. */
	const pane: "bag" | "log" | "chats" = bag ? "bag" : tab === "log" ? "log" : "chats";
	const openPane = (k: "bag" | "log" | "chats") => {
		setBag(k === "bag");
		if (k !== "bag") setTab(k);
		if (detent === "peek") setDetent("half");
	};
	const talkTab = !bag && tab !== "log" && tab !== "chats" && !!talks.get(tab);
	// a talk opens over the whole height: there is a keyboard to make room for
	useEffect(() => { if (tab !== "log" && tab !== "chats") { setBag(false); setDetent("full"); } }, [tab]);
	const unreadAll = [...talks.values()].reduce((n, t) => n + t.unread, 0) + (chatState?.invites.length ?? 0) + (chatState?.waiting.reduce((n, w) => n + w.count, 0) ?? 0);
	const visible = comings ? log : log.filter((l) => !isComing(l));
	const mineLog = visible.filter(isForMe), aroundLog = visible.filter((l) => !isForMe(l));
	// every figure's name stands out in the texts: the ones in sight, one's own, the islands' people
	setNames([...[...chars.values()].map((c) => c.name), account.name, ...(hello?.world.uses.npcs ?? [])]);
	const shownLog = logPart === "mine" ? mineLog : aroundLog;
	const lastLine = visible.at(-1), lastMine = mineLog.at(-1);
	const logShown = pane === "log" && detent !== "peek";
	// the part in front counts as seen up to now; the other shows how many lines came since it was
	const lastOf = { mine: lastMine ?? null, all: aroundLog.at(-1) ?? null };
	useEffect(() => {
		setSeenLine((s) => {
			const n = { ...s };
			if (s.mine === undefined) n.mine = lastOf.mine;
			if (s.all === undefined) n.all = lastOf.all;
			if (logShown && (logPart === "mine" || logPart === "all")) n[logPart] = lastOf[logPart];
			return n.mine === s.mine && n.all === s.all ? s : n;
		});
	});
	const todos = atlasState?.todos ?? [];
	// looked at: the hints in the tab count as seen (marked as new until the tab is left)
	const hintsShown = logShown && logPart === "tips";
	useEffect(() => {
		if (hintsShown) return () => setHintsSeen((old) => { const n = new Set([...old, ...hintsRef.current.map((h) => h.id)]); try { localStorage.setItem("mmo.hints.seen", JSON.stringify([...n].slice(-400))); } catch { /* private window */ } return n; });
	}, [hintsShown]);
	const hintsRef = useRef(hints); hintsRef.current = hints;
	const newIn = (k: LogPart) => {
		// the tasks show how many want doing now; the hints none
		if (k === "todo") return todos.filter((t) => t.rank === 0).length;
		if (k === "tips") return k === logPart && logShown ? 0 : newHints;
		if (k === logPart && logShown) return 0;
		// "An dich" counts what others said or offered to the figure, not the answers to its own commands
		return newSince<Line>(k === "mine" ? mineLog : aroundLog, seenLine[k], { toMe: k === "mine" });
	};
	const newToMe = newIn("mine");

	const self = chars.get(me);
	const openLine = () => { if (input.current) return input.current.focus(); setBag(true); setBagPart("mine"); setDetent("half"); requestAnimationFrame(() => input.current?.focus()); };
	openLineRef.current = openLine;

	const mapView = mapMode === "text" ? null : hello ? (
		<>
		{aboard && worldTime && <div className="aboard" role="status"><span>{tr("An Bord des Großen Schiffs")} → {tr(aboard.island)} · {tr(`Ankunft in etwa ${Math.max(1, Math.ceil((aboard.arriveWorldMs - shownWorldMs(worldTime.v, worldTime.at, Date.now())) / 60_000))} Weltminuten`)}</span>
			{/* a passenger need not sail to the end: the next stop on the way, with when the ship lies there */}
			{(() => { const now = shownWorldMs(worldTime.v, worldTime.at, Date.now()), next = liner && aboard.to ? nextStop(liner, now, aboard.from, aboard.to) : null;
				return next && <button className="aboard-leave" onClick={() => send("ausschiffen nächster")}>{next.inMs > 0 ? `${tr("Beim nächsten Halt aussteigen")}: ${tr(next.stop.island)} · ${tr(`in etwa ${Math.max(1, Math.ceil(next.inMs / 60_000))} Weltminuten`)}` : `${tr("Hier aussteigen")}: ${tr(next.stop.island)}`}</button>; })()}
		</div>}
		<MapRenderer key={`${hello.room.ground[0]?.length}x${hello.room.ground.length}`} mode={mapMode} viewReset={startView} world={hello.world} room={hello.room} chars={mapChars} objs={shownObjs} me={me} fog={fog} atlas={atlas} atlasState={atlasState} said={said} worldTime={worldTime} onTurn={onTurn}
			fill goal={walkGoal} insetBottom={isShort() ? 0 : detent === "peek" ? detentPx("peek", window.innerHeight) : Math.min(sheetPx ?? detentPx("half", window.innerHeight), window.innerHeight * 0.7)}
			controls={pad !== "off" ? <TouchPad hold={(d) => { input.current?.blur(); stopWalk.current(); setMenu(null); hold(d); }} release={release} action={action} noAction /> : undefined}
			onCell={(x, y) => { input.current?.blur(); setMenu(null); if (hereOpen) setHereOpen(false); if (detent !== "peek") setDetent("peek"); else onTap(x, y); }}
			onMenu={(x, y, left, top) => { input.current?.blur(); stopWalk.current(); setMenu({ x, y, left, top }); }}
			onFail={(why) => { setMapMode(mapMode === "3d" ? "2d" : "text"); append({ kind: "error", text: `${why} ${mapMode === "3d" ? "Die 2D-Karte bleibt aktiv." : "Das Spiel läuft als Text weiter."}`, from: "", at: Date.now() }); }} />
		</>
	) : <div className="map"><p className="muted">Verbinde …</p></div>;
	// the search for seeds rests a while in the room it was made (server: garden.ts): the page does not offer it then
	const searching = trade?.seedRestUntilWorldMs ?? 0, resting = !!worldTime && searching > shownWorldMs(worldTime.v, worldTime.at, Date.now());
	const wildNow = (decor: Parameters<typeof wildHere>[0], roomDecor: Parameters<typeof wildHere>[1]) => (resting ? false : wildHere(decor, roomDecor));
	// the epoch of the island the player stands on (the world map's state names each island's), for the header
	const islandHere = atlas?.rooms.find((r) => r.roomId === hello?.room.roomId)?.island;
	const epochHere = islandHere && atlasState?.epochs ? atlasState.epochs[islandHere] ?? 1 : null;
	const seasonWind = (() => { const i = worldTime ? seasonIndex(shownWorldMs(worldTime.v, worldTime.at, Date.now()), worldTime.v.yearDays ?? 0) : null; return [i === null ? "" : tr(SEASONS[i]!), wind ? tr(wind) : ""].filter(Boolean).join(" · "); })();
	const menus = <>
		{menu && hello && <CellMenu at={menu} admin={!!account.admin} todos={atlasState?.todos} feed={hello.world.uses.feed} beachAt={hello.world.uses.sandTile ? (x: number, y: number) => hello.room.ground[y]?.[x] === hello.world.uses.sandTile : undefined} recipes={hello.world.uses.recipes} grinds={hello.world.uses.grinds} beds={hello.world.uses.beds} wild={wildNow(hello.world.decor, hello.room.decor)} travel={atlas && atlasState ? { rooms: atlas.rooms, stops: atlasState.stops, epochs: atlasState.epochs, ...(hello.world.uses.roadEpoch ? { roadEpoch: hello.world.uses.roadEpoch } : {}) } : undefined} sail={[...new Set((hello.world.liner?.routes ?? []).map((r) => r.island))].filter((i) => i !== hello.world.liner?.island)} sheet onWalk={walkTo} onOrders={() => { setBag(true); setBagPart("orders"); setDetent("half"); }} onHelp={(a) => { setCmdHelp(null); setHelpArticle(a); setHelp(true); }} chars={chars} objs={shownObjs} self={chars.get(me)} room={hello.room.roomId} me={me} plans={hello.world.plans ?? []} guest={account.guest} send={send} close={() => setMenu(null)} offersIn={trade?.offersIn} offer={account.guest ? undefined : (name) => { setPanel(null); setBag(true); setBagPart("market"); setDetent("half"); setOfferTo(name); }}
			chat={{ talk: (name) => send(`chat ${name}`, false), invite: (name, g) => send(`gruppe lade ${name} in ${g}`), groups: account.guest ? [] : (chatState?.groups.map((g) => g.name) ?? []) }} />}
		{nameMenu && <NameMenu at={nameMenu} sheet name={nameMenu.name} groups={account.guest ? [] : (chatState?.groups.map((g) => g.name) ?? [])} close={() => setNameMenu(null)}
			talk={() => send(`chat ${nameMenu.name}`, false)} invite={(g) => send(`gruppe lade ${nameMenu.name} in ${g}`)} ignore={() => send(`ignoriere ${nameMenu.name}`)} />}
	</>;
	const panels = <>
		{panel === "account" && (
			<div className="panel"><h2>Konto anlegen</h2><AccountForm guest onDone={(a, fresh) => { setPanel(null); onAccount(a, fresh); }} /></div>
		)}
		{panel === "admin" && <AdminPanel onClose={() => setPanel(null)} />}
		{panel === "stats" && <StatsPanel me={me} />}
		{panel === "look" && <AvatarPanel charId={me} look={chars.get(me)?.look} send={send} onDone={() => setPanel(null)} />}
		{panel === "alias" && <div className="panel"><h2>Name im Spiel</h2><AliasForm account={account} onDone={(a) => { setPanel(null); onAccount(a); }} /></div>}
		{panel === "leave" && (
			<div className="panel">
				<h2>Als Gast abmelden?</h2>
				<p style={{ margin: "0 0 10px", fontSize: "max(13px, var(--min-font))" }}>Ohne Registrierung kommst du nicht zu dieser Figur zurück; sie verfällt nach einigen Tagen.</p>
				<div style={{ display: "flex", gap: 8 }}><button onClick={() => setPanel("account")}>Erst registrieren</button><button onClick={() => void logout()}>Trotzdem abmelden</button></div>
			</div>
		)}
	</>;
	const hereBar = hereEntries({ chars, objs, self: chars.get(me), room: hello?.room.roomId ?? "", me, plans: hello?.world.plans ?? [], guest: account.guest, fuel: fuelIn(objs, me), wild: hello ? wildNow(hello.world.decor, hello.room.decor) : false, beds: hello?.world.uses.beds });
	// one's chests, in every region, numbered as the server numbers them (ownChests in engine/commands/build.ts)
	const packInfo: PackInfo = { max: atlasState?.packMax ?? null, chests: (atlasState?.mine ?? []).filter((o) => o.kind === "building" && !!o.plan && !!hello?.world.uses.chests.includes(o.plan)).map((o) => ({ o, roomName: atlas?.rooms.find((r) => r.roomId === o.room)?.name ?? o.room })).sort((a, b) => chestOrder({ roomName: a.roomName, buildId: a.o.id }, { roomName: b.roomName, buildId: b.o.id })).map((x, i) => ({ nr: i + 1, label: `${x.o.name} (${x.roomName})` })) };
	const mineView = <Things arrived={arrived} pack={packInfo} objs={objs} chars={chars} self={chars.get(me)} room={hello?.room.roomId ?? ""} me={me} plans={hello?.world.plans ?? []} guest={account.guest} wild={wildNow(hello?.world.decor, hello?.room.decor)} uses={hello?.world.uses} hints={hints} send={send} pick={pickUp}
		{...(trade?.listings && !account.guest ? { market: (name: string) => { setTradeItem({ name }); setBagPart("market"); } } : {})}
		{...(account.guest ? {} : { offer: (to: string, name: string) => { setTradeItem({ name }); setOfferTo(to); setBagPart("market"); } })} />;
	const marketView = <>
		{trade && hello && <TradePanel trade={trade} chars={chars} objs={objs} me={me} guest={account.guest} offerTo={offerTo} setOfferTo={setOfferTo} item={tradeItem} send={send} />}
		{!!trade && !trade.orders && !trade.listings && <p className="muted bag-note">Das Marktbrett und die Auftragstafel stehen in den Häfen und Dörfern. Stell dich daneben, dann erscheinen sie hier. Tauschen geht mit jedem, der am selben Ort ist.</p>}
	</>;
	const ordersHere = [...objs.values()].filter((o) => o.kind === "site" && o.location === hello?.room.roomId).reduce((n, o) => n + (o.orders?.length ?? 0), 0);
	const insertCommand = (c: string) => { setCmdHelp(null); setLine(`${c} `); setBag(true); setBagPart("mine"); if (detent === "peek") setDetent("half"); requestAnimationFrame(() => input.current?.focus()); };
	const logFilter = <label className="log-filter"><input type="checkbox" checked={comings} onChange={(e) => setComings(e.target.checked)} /> Kommen und Gehen</label>;
	const logParts = (
		<div className="bag-parts" role="tablist" aria-label="Ereignisse">
			{([["mine", "An dich"], ["all", "Allgemein"], ["tips", "Tipps"], ["todo", "Aufgaben"]] as const).map(([k, l]) => { const n = newIn(k); return <button key={k} role="tab" aria-selected={logPart === k} onClick={() => { setLogPart(k); atEnd.current = true; setBehind(false); }}>{l}{n ? <span className="chat-count">{n > 99 ? "99+" : n}</span> : null}</button>; })}
		</div>
	);
	const logView = (
		<div className="log" role="log" aria-live="polite" ref={logBox} onScroll={(e) => { const b = e.currentTarget; atEnd.current = b.scrollHeight - b.scrollTop - b.clientHeight < 24; if (atEnd.current) setBehind(false); }}>
			{shownLog.map((l, i) => <div key={i} className={`${l.kind}${"toMe" in l && l.toMe ? " to-me" : ""}`}><LogText l={l} self={chars.get(me)?.name ?? account.name} onName={(name, left, top) => setNameMenu({ name, left, top })} onCommand={insertCommand} />{"ai" in l && l.ai ? <span className="ai-badge" title="Diese Figur spielt ein Sprachmodell">KI</span> : null}</div>)}
		</div>
	);
	const chatView = tab === "chats" || !talks.get(tab) ? (
		<ChatOverview state={chatState} guest={account.guest} talks={talks} open={setTab} send={send} keys={keys} />
	) : <TalkView talk={talks.get(tab)!} keys={keys} />;
	const noticeView = tab !== "log" && notice && Date.now() - notice.at < 10_000 && <p className={`chat-notice${notice.error ? " error" : ""}`} role="status">{notice.text}</p>;
	// the bag's line is for commands, whichever talk stays open behind it
	const talkHere = bag ? undefined : talks.get(tab);
	const commandForm = (
		<form className="cmd" onSubmit={(e) => {
			e.preventDefault(); const t = line.trim(); if (!t) return;
			const talk = talkHere;
			// in a talk, what is typed is a message of the talk (sealed here); elsewhere a command or a sentence, but
			// "chat <name> <text>" and "gruppe <name> <text>" are sealed here too: no chat text reaches the server plain
			const dm = /^(?:chat|tell|whisper|flüstere|fluestere|flüster)\s+(\S+)\s+([\s\S]+)$/i.exec(t);
			const grp = /^(?:gruppe|group)\s+(\S+)\s+([\s\S]+)$/i.exec(t);
			const g = grp && chatState?.groups.find((x) => x.name.toLowerCase() === grp[1]!.toLowerCase());
			if (talk) void sealAndSend(talk.conv, t);
			else if (dm) { pendingChat.current = { name: dm[1]!, text: dm[2]! }; send(`chat ${dm[1]}`, false); }
			else if (g) { const conv = { kind: "group" as const, id: g.groupId, title: g.name }; setTalks((x) => openTalk(x, conv)); setTab(keyOf(conv)); void sealAndSend(conv, grp![2]!); }
			else send(t);
			setLine("");
		}}>
			<input ref={input} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onCommandKey} onFocus={() => release()} placeholder={talkHere ? `Nachricht an ${talkHere.conv.kind === "group" ? `die Gruppe ${talkHere.conv.title}` : talkHere.conv.title} …` : "Befehl oder Satz …"} maxLength={300} aria-label={talkHere ? "Nachricht" : "Befehl"} />
			<button className="primary">Senden</button>
		</form>
	);
	const helpView = <>
		{help && <HelpPanel onClose={() => { setHelp(false); setHelpArticle(null); }} article={helpArticle} onCommands={() => send("help", false)} />}
		{cmdHelp && !help && <CommandHelp view={cmdHelp} onTopic={(key) => (key ? send(`help ${key}`, false) : setCmdHelp((old) => (old ? { ...old, topic: undefined } : old)))} onArticles={() => { setCmdHelp(null); setHelp(true); }} onClose={() => setCmdHelp(null)}
			onInsert={insertCommand} />}
	</>;
	const rendererTabs = (
		<div className="renderer-tabs" role="group" aria-label="Kartendarstellung">
			{(["text", "2d", "3d"] as const).map((mode) => <button key={mode} onClick={() => { setMore(false); setMapMode(mode); }} aria-pressed={mapMode === mode}>{mode === "text" ? "Text" : mode.toUpperCase()}</button>)}
		</div>
	);

	// a tap beside the open sheet closes it, also where the map has no cell; pulling and turning the map leave it open
	const tapStart = (e: React.PointerEvent) => { tapFrom.current = e.isPrimary ? { id: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now() } : null; };
	const tapBeside = (e: React.PointerEvent) => {
		const from = tapFrom.current, t = e.target as Element;
		tapFrom.current = null;
		if (!from || from.id !== e.pointerId || detent === "peek" || mapMode === "text" || Date.now() - from.at > 500 || Math.hypot(e.clientX - from.x, e.clientY - from.y) > 10) return;
		if (t.tagName === "CANVAS" || t.classList.contains("stage") || t.classList.contains("map")) setDetent("peek");
	};
	/** A height for the log the sheet opened by itself, null: the one it was pulled to. */
	const setPulled = (h: number) => { setLogFit(null); setSheetPx(h); };
	useEffect(() => { if (detent === "peek") setLogFit(null); }, [detent]);
	const sheetBody = (
		<>
			{/* closed, the sheet is its handle and the last line alone: the tabs come with the opening */}
			{talkTab && detent !== "peek" ? (
				<div className="talk-head"><button className="talk-back" onClick={() => setTab("chats")} aria-label="Zurück zu den Chats">←</button><strong>{talkHere!.conv.kind === "group" ? `# ${talkHere!.conv.title}` : talkHere!.conv.title}</strong></div>
			) : detent === "peek" && mapMode !== "text" ? null : (
				<div className="sheet-tabs" role="tablist" aria-label="Aktionen, Ereignisse und Chats">
					<button role="tab" aria-selected={pane === "bag"} onClick={() => openPane("bag")}>Aktionen</button>
					<button role="tab" aria-selected={pane === "log"} onClick={() => { if (newToMe) setLogPart("mine"); openPane("log"); }}>Ereignisse{newToMe ? <span className="chat-count" title="Neu an dich">{newToMe > 99 ? "99+" : newToMe}</span> : null}</button>
					<button role="tab" aria-selected={pane === "chats"} onClick={() => openPane("chats")}>Chats{unreadAll ? <span className="chat-count">{unreadAll}</span> : null}</button>
				</div>
			)}
			{detent === "peek" && mapMode !== "text" ? <button className="sheet-peek" onClick={() => { if (newToMe) setLogPart("mine"); openPane("log"); }}>{unreadAll + newToMe ? <span className="chat-count">{unreadAll + newToMe}</span> : null}{lastLine?.text ?? ""}</button> : (
				<div className="sheet-body">
					{pane === "bag" ? (
						<>
							<div className="bag-parts" role="tablist" aria-label="Aktionen">
								{([["mine", "Bei dir"], ["here", "Hier"], ["market", "Markt"], ["orders", "Aushang"]] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={bagPart === k} onClick={() => setBagPart(k)}>{l}{k === "here" && hereBar.length ? <span className="chat-count">{hereBar.length}</span> : k === "market" && trade?.offersIn.length ? <span className="chat-count">{trade.offersIn.length}</span> : k === "orders" && ordersHere ? <span className="chat-count">{ordersHere}</span> : null}</button>)}
							</div>
							<div className="sheet-scroll">{bagPart === "mine" ? mineView : bagPart === "here" ? cloneElement(mineView, { part: "here" }) : bagPart === "market" ? marketView : <SiteOrders objs={objs} self={self} room={hello?.room.roomId ?? ""} me={me} send={send} walk={walkTo} />}</div>
							{/* the market board's answer stays under its lists, the market in front */}
							{bagPart === "market" && lastMine && <button className="last-line" onClick={() => { setLogPart("mine"); openPane("log"); }}>{lastMine.text}</button>}
							{bagPart === "mine" && <>
								{/* the answers go to the log: the last one shows here, a tap opens the rest */}
								{lastMine && <button className="last-line" onClick={() => { setLogPart("mine"); openPane("log"); }}>{lastMine.text}</button>}
								{commandForm}
							</>}
						</>
					) : pane === "log" ? (
						<>
							{logParts}
							{logPart === "all" && logFilter}
							{logPart === "tips" ? (
								<div className="log task-list">{hints.length ? hints.map((h) => <p key={h.id} className={`pack-hint${hintsSeen.has(h.id) ? "" : " new"}`}>{h.text}{h.line && <button onClick={() => send(h.line!)}>Herstellen</button>}</p>) : <p className="muted">Gerade kein Tipp: sammle etwas, dann steht hier, was daraus werden kann.</p>}</div>
							) : logPart === "todo" ? (
								<div className="log task-list">{todos.length ? todosByPlace(todos, (r) => atlas?.rooms.find((x) => x.roomId === r)?.name ?? r).map((g) => g.todos.length === 1 ? <p key={g.room} className={`task rank-${g.rank}`}>{todos.find((t) => t.id === g.todos[0]!.id)!.text}</p> : (
									<details key={g.room} className={`task-place rank-${g.rank}`}><summary>{g.name}: {g.todos.length} Aufgaben{g.todos.some((t) => t.rank === 0) ? `, ${g.todos.filter((t) => t.rank === 0).length} jetzt` : ""}</summary>{g.todos.map((t) => <p key={t.id} className={`task rank-${t.rank}`}>{t.text}</p>)}</details>
								)) : <p className="muted">Nichts zu tun: deine Äcker, Beete, Baustellen und Tiere warten auf nichts.</p>}</div>
							) : logView}
							{behind && logPart !== "tips" && logPart !== "todo" && <button className="log-new" onClick={toLogEnd}>Neue Meldungen</button>}
							<div className="quick">{["look", "who", "inventory", "time", "reputation"].map((c) => <button key={c} onClick={() => send(c)}>{c}</button>)}</div>
						</>
					) : (
						<>
							{chatView}
							{noticeView}
							{talkTab && commandForm}
						</>
					)}
				</div>
			)}
		</>
	);
	return (
		<div className="game-touch sheet" onPointerDownCapture={(e) => { wake(); lastPress.current = { x: e.clientX, y: e.clientY }; tapStart(e); }} onPointerMoveCapture={wake} onKeyDownCapture={wake} onPointerUpCapture={tapBeside}>
			{stale && <div className="stale" role="status">Neue Version des Spiels – die Seite lädt neu …</div>}
			<div className={`stage${pad === "left" ? " pad-left" : ""}${pad === "off" ? " pad-off" : ""}${detent !== "peek" ? " open" : ""}${calm && detent === "peek" && !menu && !nameMenu && !hereOpen && !more ? " calm" : ""}`}>
				{mapView}
				{atlas && atlas.rooms.length > 1 && !isTouch() && mapMode !== "text" && <Atlas atlas={atlas} state={atlasState} ship={liner && worldTime ? { t: liner, now: () => shownWorldMs(worldTime.v, worldTime.at, Date.now()) } : null} me={chars.get(me) ?? null} onBeam={(room) => send(`beam ${room}`)} />}
				<div className="hud">
					<button className="hud-pill" onClick={() => setAtlasPage(true)} disabled={!atlas || atlas.rooms.length < 2} aria-label="Weltkarte öffnen">
						<span className={`live${live ? " on" : ""}`} /><b>{hello?.room.name ?? ""}</b>
						{/* on a phone only the name and the time stay; epoch, season and wind show on the world map's page */}
						{epochHere !== null && <small className="epoch hud-detail">Epoche: {epochHere}</small>}
						{worldTime && <small>{formatWorldTime(shownWorldMs(worldTime.v, worldTime.at, Date.now()))}{worldTime.v.paused ? " ⏸" : ""}{seasonWind && <span className="hud-detail"> · {seasonWind}</span>}</small>}
					</button>
					<span className="spacer" />
					{mapMode === "3d" && <button className="hud-btn hud-fps" disabled={fps.running} onClick={startFps} title={!fps.running && fps.note ? fps.note : "Bildrate der 3D-Karte messen (2 s Anlauf, 30 s Messung)"} aria-label="FPS messen">{fps.running ? `${fps.remaining} s` : fps.fps !== null ? `${Math.round(fps.fps)} FPS` : "FPS"}</button>}
					<button className="hud-btn" onClick={() => setPanel("stats")} aria-label="Statistik"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><rect x="2" y="8" width="3" height="6" rx="1" /><rect x="6.5" y="4" width="3" height="10" rx="1" /><rect x="11" y="1" width="3" height="13" rx="1" /></svg></button>
					<button className="hud-btn" onClick={() => { setCmdHelp(null); setHelp(true); }} aria-label="Hilfe / Help">?</button>
					<button className="hud-btn" onClick={() => setMore(true)} aria-label="Darstellung und Abmelden">⋯</button>
				</div>
				{/* one chip: a single action runs on a tap, several open as a list; a tap on the map or an action folds it again */}
				{hereBar.length > 0 && mapMode !== "text" && (hereOpen && hereBar.length > 1
					? <div className="here-bar open" role="group" aria-label="Hier möglich">{hereBar.map((e) => <button key={e.line} onClick={() => { setHereOpen(false); if (e.confirm) void ask(e.confirm).then((ok) => { if (ok) send(e.line); }); else send(e.line); }}>{e.label}</button>)}</div>
					: <div className="here-bar" role="group" aria-label="Hier möglich"><button className="here-chip" aria-expanded={hereBar.length > 1 ? false : undefined} onClick={() => (hereBar.length > 1 ? setHereOpen(true) : send(hereBar[0]!.line))}><span>{hereBar[0]!.label}</span>{hereBar.length > 1 && <b>+{hereBar.length - 1}</b>}</button></div>)}
				{homeHint && steps && <div className="home-hint"><span>Ohne Adressleiste spielen: <b>{steps.first}</b>, dann <b>{steps.then}</b>, und das Spiel von dort öffnen.</span>{install && <button className="primary home-install" onClick={() => { void install.prompt(); hideHomeHint(); }}>Installieren</button>}<button onClick={hideHomeHint} aria-label="Hinweis schließen">×</button></div>}
				{travelNote && <div className="travel-note" role="status"><span className="travel-spin" aria-hidden="true" />{travelNote}</div>}
				{toast && <button className="chat-toast" onClick={() => { setToast(null); setTab(toast.key); }}><b>{toast.from}</b><small>Neue Nachricht</small></button>}
			</div>
			{mapMode === "text" ? <section className="sheet text-page">{sheetBody}</section>
				: <Sheet detent={detent} setDetent={setDetent} height={logFit ?? sheetPx} setHeight={setPulled} place={sheetAt} setPlace={setSheetAt}>{sheetBody}</Sheet>}
			{menus}
			{more && <>
				<div className="menu-backdrop dim" onClick={() => setMore(false)} />
				<div className="cell-menu action-sheet more-sheet" role="dialog" aria-label="Darstellung und Konto">
					<div className="more-row"><span>Darstellung</span>{rendererTabs}</div>
					<div className="more-row"><span>Sprache</span><div className="renderer-tabs" role="group" aria-label="Sprache" data-no-tr>{(["de", "en"] as const).map((l) => <button key={l} aria-pressed={language() === l} onClick={() => setLanguage(l)}>{l.toUpperCase()}</button>)}</div></div>
						<div className="more-row"><span>Aussehen</span>{controls}</div>
					{mapMode !== "text" && <div className="more-row"><span>Steuerung</span><div className="renderer-tabs" role="group" aria-label="Steuerkreuz, Zoom und Drehen">{(["off", "left", "right"] as const).map((v) => <button key={v} aria-pressed={pad === v} onClick={() => setPad(v)}>{v === "off" ? "Aus" : v === "left" ? "Links" : "Rechts"}</button>)}</div></div>}
					<div className="more-row"><span>Tipps</span><div className="renderer-tabs" role="group" aria-label="Tipps">{([true, false] as const).map((v) => <button key={String(v)} aria-pressed={hintsOn === v} onClick={() => setHintsOn(v)}>{v ? "An" : "Aus"}</button>)}</div></div>
					{canFullscreen() && <div className="more-row"><span>Vollbild im Querformat</span><div className="renderer-tabs" role="group" aria-label="Vollbild">{([true, false] as const).map((v) => <button key={String(v)} aria-pressed={fullscreen === v} onClick={() => setFullscreen(v)}>{v ? "An" : "Aus"}</button>)}</div></div>}
					{steps && <div className="more-row"><span>Ohne Adressleiste: <b>{steps.first}</b>, dann <b>{steps.then}</b></span>{install && <button onClick={() => void install.prompt()}>Installieren</button>}</div>}
					<div className="more-row"><span>{account.alias ?? account.name}{account.guest ? " · Gast" : ""}</span><span className="more-acts">
						<button onClick={() => { setMore(false); setPanel("look"); }}>Figur</button>
						{!account.guest && <button onClick={() => { setMore(false); setPanel("alias"); }}>Alias</button>}
						{account.guest && <button onClick={() => { setMore(false); setPanel("account"); }}>Registrieren</button>}
						{account.admin && <button onClick={() => { setMore(false); setPanel("admin"); }}>Systemeinstellungen</button>}
						<button onClick={() => { setMore(false); if (account.guest) setPanel("leave"); else void logout(); }}>Abmelden</button>
					</span></div>
					<SystemBar />
					<About />
				</div>
			</>}
			{panel && <div className="touch-page"><div className="touch-page-head"><button className="hud-btn" onClick={() => setPanel(null)} aria-label="Schließen">×</button></div>{panels}</div>}
			{atlasPage && atlas && <div className="touch-page"><div className="touch-page-head"><strong>Weltkarte</strong>{(epochHere !== null || seasonWind) && <small className="atlas-now">{[epochHere !== null ? `Epoche ${epochHere}` : "", seasonWind].filter(Boolean).join(" · ")}</small>}<span className="spacer" /><button className="hud-btn" onClick={() => setAtlasPage(false)} aria-label="Schließen">×</button></div><Atlas atlas={atlas} state={atlasState} page ship={liner && worldTime ? { t: liner, now: () => shownWorldMs(worldTime.v, worldTime.at, Date.now()) } : null} me={chars.get(me) ?? null} onBeam={(room) => { send(`beam ${room}`); setAtlasPage(false); }} /></div>}
			{helpView}
		</div>
	);
}
