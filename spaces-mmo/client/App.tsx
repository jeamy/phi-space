"use client";
// spaces-mmo in the browser: a welcome page (play as a guest, log in, register) and the game: the PixiJS map of the
// room, the text log and the command line. Everything the player does is a text command sent over the WebSocket; a
// tap on the map or an arrow key becomes `move x y` for one step. All text from the world is rendered as React text nodes.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ThemeControls } from "./ThemeControls.tsx";
import { AdminPanel } from "./AdminPanel.tsx";
import { useTheme } from "./lib/theme.ts";
import type { AtlasState, AtlasView, CharView, MsgView, ObjView, PlanView, ServerFrame, TradeView } from "../server/gateway.ts";
import { Atlas } from "./Atlas.tsx";
import { HelpPanel } from "./HelpPanel.tsx";
import { CommandHelp } from "./CommandHelp.tsx";
import type { HelpView } from "../server/model.ts";
import { appendLine, isComing } from "./log.ts";
import type { ChatState } from "../server/chat.ts";
import { addMsg, fromLog, keyOf, openTalk, readTalk, type Talks } from "./chat.ts";
import { ChatOverview, ChatTabs, TalkView } from "./ChatPanel.tsx";
import { forgetDeviceKeys, useChat } from "./useChat.ts";
import { screenToGrid, WALK_MS, Walker } from "./walk.ts";
import { formatWorldTime, shownWorldMs, type WorldTimeView } from "../server/engine/worldtime.ts";

/** How long a "gone" waits for the "char" that follows it when a character is only being moved (see the handler). */
const GONE_GRACE_MS = 2500;
import { MapRenderer, type MapMode } from "./MapRenderer.tsx";
import { TouchPad } from "./TouchPad.tsx";

/** A thing picked up shows in the pack at once; without word from the server for this long it lies there again. */
const PICKUP_MS = 3_000;
/** Two clicks on one cell within this long are a double click (pick up what lies there). */
const DOUBLE_MS = 400;
/** How long a double-clicked thing is walked to before giving up (a long way, someone else took it). */
const FETCH_MS = 15_000;
type Account = { name: string; guest: boolean; admin: boolean };
type Hello = Extract<ServerFrame, { t: "hello" }>;
/** The names of what burns in a fire, cheapest first (from the hello): what the space key and the buttons feed. */
let fuels: string[] = ["Treibholz"];
const fuelIn = (objs: Map<string, ObjView>, me: string) => {
	const mine = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
	return fuels.map((n) => mine.find((o) => o.name === n)).find(Boolean);
};
type Line = MsgView | { kind: "echo"; text: string; from: string; at: number };

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
	const [account, setAccount] = useState<Account | null | undefined>(undefined);
	const theme = useTheme();
	const controls = <ThemeControls {...theme} />;
	useEffect(() => { void fetch("/api/me").then((r) => r.json()).then((d) => { pageBuild ??= d.build ?? null; setAccount(d.account ?? null); }, () => setAccount(null)); }, []);
	if (account === undefined) return <main className="welcome"><p className="muted">Lädt …</p></main>;
	if (!account) return <Welcome onIn={setAccount} controls={controls} />;
	return <Game account={account} onAccount={setAccount} controls={controls} />;
}

function Welcome({ onIn, controls }: { onIn: (a: Account) => void; controls: ReactNode }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const guest = async () => {
		setBusy(true); setError("");
		try { onIn((await post("/api/guest")).account!); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
	};
	return (
		<main className="welcome">
			<div className="welcome-top">{controls}</div>
			<h1>Leuchtfeuer</h1>
			<p className="pitch muted">Ein Archipel im Nebel. Wo ein Leuchtfeuer brennt, wird es licht – und keines brennt lange allein.</p>
			<div className="card">
				<button className="primary" onClick={guest} disabled={busy}>Als Gast spielen</button>
				<p className="muted" style={{ fontSize: 13, margin: "10px 0 0" }}>Sofort los, ohne Anmeldung. Wer sich später registriert, behält alles, was er als Gast erreicht hat.</p>
				{error && <p className="error">{error}</p>}
			</div>
			<div className="card"><AccountForm onDone={onIn} /></div>
			<About />
		</main>
	);
}

/** Log in or register. `guest`: shown inside the game of a guest (registering keeps the guest's progress; logging in
 *  to another account does not). */
function AccountForm({ onDone, guest = false }: { onDone: (a: Account) => void; guest?: boolean }) {
	const [mode, setMode] = useState<"login" | "register">(guest ? "register" : "login");
	const [name, setName] = useState(""), [password, setPassword] = useState(""), [token, setToken] = useState("");
	const [busy, setBusy] = useState(false), [error, setError] = useState("");
	const submit = async (e: React.FormEvent) => {
		e.preventDefault();
		setBusy(true); setError("");
		try { onDone((await post(mode === "login" ? "/api/login" : "/api/register", { name, password, ...(token ? { setupToken: token } : {}) })).account!); }
		catch (err) { setError((err as Error).message); } finally { setBusy(false); }
	};
	return (
		<form className="form" onSubmit={submit}>
			<div className="tabs" role="tablist">
				<button type="button" role="tab" aria-selected={mode === "register"} onClick={() => setMode("register")}>Registrieren</button>
				<button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>Anmelden</button>
			</div>
			{guest && mode === "register" && <p className="muted" style={{ margin: 0, fontSize: 13 }}>Deine Figur, ihr Platz und alles Weitere bleiben erhalten.</p>}
			{guest && mode === "login" && <p className="warning" style={{ margin: 0, fontSize: 13 }}>Mit einem bestehenden Konto anmelden: Der Fortschritt dieses Gastes wird nicht übernommen und verfällt.</p>}
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

function About() {
	return (
		<p className="about muted">
			Eine Welt auf <a href="https://spaces.eibrain.org" target="_blank" rel="noreferrer">phi-spaces</a>. Grafiken: Intersect-Assets von
			PixelFox, Zetasis, George und Murdoc, CC BY 4.0; Gegenstände: Shikashi's Fantasy Icons von Matt Firth (shikashipx) nach
			game-icons.net, CC BY 4.0, und 7Soul1, CC0 (<a href="/assets/leuchtfeuer/CREDITS.md" target="_blank" rel="noreferrer">Nachweise</a>).
		</p>
	);
}

/** The menu of a long press or a right click on a cell: what stands, lies or burns there, and what one can do with it.
 *  Every entry is a text command. */
function CellMenu({ at, chars, objs, self, room, me, plans, guest, send, close, offer, chat }: { at: { x: number; y: number; left: number; top: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; plans: PlanView[]; guest: boolean; send: (line: string) => void; close: () => void; offer?: (name: string) => void;
	/** Chat with a player (not an NPC), and invite them into one of `groups` (none for a guest). */ chat?: { talk: (name: string) => void; invite: (name: string, group: string) => void; groups: string[] } }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	// building goes in steps: "Bauen …" → the plans → a plan with what it needs and OK
	const [step, setStep] = useState<"plans" | PlanView | null>(null);
	useEffect(() => setStep(null), [at]);
	const reach = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 1;
	const fuel = fuelIn(objs, me);
	const entries: Array<{ label: string; line: string; run?: () => void }> = [];
	for (const c of chars.values()) if (c.x === at.x && c.y === at.y && c.charId !== me) {
		entries.push({ label: `${c.name} ansehen`, line: `look ${c.name}` });
		if (offer) entries.push({ label: `${c.name} einen Tausch anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
		if (chat && !c.charId.startsWith("npc-")) {
			entries.push({ label: `Chat mit ${c.name}`, line: `#chat ${c.name}`, run: () => chat.talk(c.name) });
			for (const g of chat.groups.slice(0, 4)) entries.push({ label: `${c.name} in „${g}“ einladen`, line: `#invite ${c.name} ${g}`, run: () => chat.invite(c.name, g) });
		}
	}
	// a site or building covers more than one cell: its entries on every one of them
	for (const o of objs.values()) {
		if ((o.kind !== "site" && o.kind !== "building" && o.kind !== "ruin" && o.kind !== "bed" && o.kind !== "field") || o.location !== room || at.x < o.x || at.y < o.y || at.x >= o.x + (o.w ?? 1) || at.y >= o.y + (o.h ?? 1)) continue;
		const dist = self ? Math.max(Math.max(o.x - self.x, 0, self.x - (o.x + (o.w ?? 1) - 1)), Math.max(o.y - self.y, 0, self.y - (o.y + (o.h ?? 1) - 1))) : Infinity;
		// a site is worked on from two cells away (server: build.ts SITE_REACH), a building only from beside it
		const beside = dist <= 1, nearSite = dist <= 2;
		if (o.kind === "bed") {
			// a bed is tended from two cells away too, by its owner and its sponsors, a community bed by everyone; planting
			// there needs an account (server: garden.ts)
			const commons = o.bedKind === "gemein";
			entries.push({ label: commons ? "Gemeinschaftsbeet ansehen" : `${o.name} von ${o.owner ?? ""} ansehen`, line: "beet" });
			const mine = o.owner === self?.name || (commons && !guest), mayTend = commons || mine || (!!self && (o.sponsors ?? []).includes(self.name));
			if (nearSite && mayTend) {
				const carried = [...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name);
				if (carried.includes("Kanne Wasser")) entries.push({ label: "Gießen", line: "gieße" });
				if (o.weedy || (o.plants ?? []).some((pl) => pl.stage === 3)) entries.push({ label: "Jäten", line: "jäte" });
				if ((o.plants ?? []).some((pl) => pl.stage === 2)) entries.push({ label: "Ernten", line: "ernte" });
				if (beside && !o.fenced) entries.push({ label: "Zaun setzen (2 Treibholz, 1 Tangseil)", line: "zäune" });
				if (mine && (o.plants ?? []).length < (o.w ?? 1) * (o.h ?? 1)) for (const n of [...new Set(carried.filter((n) => /samen$/i.test(n)))]) entries.push({ label: `${n} pflanzen`, line: `pflanze ${n}` });
			}
			continue;
		}
		if (o.kind === "field") {
			// a field is sown and harvested from two cells away, by its owner, or by everyone when it is open (server: field.ts)
			const mine = o.owner === self?.name, may = mine || !!o.open;
			entries.push({ label: `Flur von ${o.owner ?? ""} ansehen`, line: "flur" });
			if (nearSite && may) {
				if (o.fieldStage === "brach" && mine) entries.push({ label: "Bestellen …", line: "bestelle" });
				if (o.fieldStage === "saat") entries.push({ label: "Bestellen (Saatgut, Arbeit)", line: "bestelle" });
				if (o.fieldStage === "reif" || o.fieldStage === "spaet") entries.push({ label: "Ernten", line: "ernte flur" });
			}
			if (nearSite && mine) entries.push(o.open ? { label: "Flur für Fremde schließen", line: "flur zu" } : { label: "Flur für alle öffnen", line: "flur offen" });
			continue;
		}
		entries.push({ label: o.kind === "site" ? `Baustelle ${o.name}: was fehlt?` : o.kind === "ruin" ? `Ruine (${o.name} von ${o.owner ?? ""})` : `${o.name} von ${o.owner ?? ""} ansehen`, line: "baustelle" });
		if (o.kind === "building" && beside) {
			if (o.name === "Regentonne") entries.push({ label: "Wasser schöpfen", line: "schöpfe" });
			// anyone grinds at a mill and bakes at a bakery (server: mill.ts, the recipes "at" a plan)
			if (o.plan === "windmuehle") {
				entries.push({ label: "Mühle: wie lange noch?", line: "mahle" });
				const grain = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && ["Weizen", "Gerste", "Hafer"].includes(i.name)).map((i) => i.name))];
				for (const n of grain) entries.push({ label: `${n} mahlen`, line: `mahle alle ${n}` });
			}
			if (o.plan === "backhaus") entries.push({ label: "Brot backen (2 Mehl, 1 Kanne Wasser, 1 Treibholz)", line: "backe brot" });
			if (o.plan === "webstuhl") entries.push({ label: "Tuch weben (3 Wolle, Spindel)", line: "craft tuch" }, { label: "Daunendecke nähen (2 Tuch, 3 Daunen)", line: "craft decke" });
			if (o.plan === "huette") entries.push({ label: "Käse machen (3 Milch, 1 Treibholz)", line: "craft käse" });
			// a coop or pen: anyone feeds, the owner puts in, takes out and collects (server: animals.ts)
			if (o.plan === "huehnerstall" || o.plan === "gehege") {
				entries.push({ label: "Tiere ansehen", line: "stall" }, { label: "Füttern", line: "füttere" });
				if (o.owner === self?.name) {
					const yields: Record<string, string> = { huhn: "Eier", ente: "Eier", schaf: "Wolle", ziege: "Milch", gans: "Daunen" };
					if (o.herd) entries.push({ label: `${yields[o.herd] ?? "Ertrag"} einsammeln`, line: "einsammeln" });
					const fits = o.plan === "huehnerstall" ? ["Huhn"] : ["Schaf", "Ziege", "Ente", "Gans"];
					for (const n of [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me && fits.includes(i.name)).map((i) => i.name))]) entries.push({ label: `${n} einstallen`, line: `einstallen ${n}` });
					entries.push({ label: "Ein Tier herausnehmen", line: "ausstallen" });
				}
			}
			entries.push({ label: "Ausbessern", line: "repariere" });
			if (o.owner === self?.name) entries.push({ label: "Truhe ansehen", line: "truhe" });
		}
		if (o.kind === "ruin" && o.owner === self?.name) entries.push({ label: "Nachlass abholen", line: "nachlass" });
		if ((o.kind === "building" || o.kind === "ruin") && o.plan === "windmuehle" && nearSite) entries.push({ label: "Mehl abholen", line: "abholen" });
		if (o.kind === "site" && nearSite) {
			entries.push({ label: "Mitarbeiten", line: "arbeite" });
			// what one carries that it still needs
			const carried = [...new Set([...objs.values()].filter((i) => i.kind === "item" && i.location === me).map((i) => i.name))];
			// "2 Tangseil, 5 Arbeit" → the names, matched whole: "Tang" is not the "Tangseil" it needs
			const needed = new Set((o.missing ?? "").split(",").map((p) => p.trim().replace(/^\d+\s+/, "")).filter(Boolean));
			for (const n of carried.filter((n) => needed.has(n))) entries.push({ label: `${n} liefern`, line: `liefere ${n}` });
		}
	}
	for (const o of objs.values()) {
		if (o.location !== room || o.x !== at.x || o.y !== at.y || o.kind === "site" || o.kind === "building" || o.kind === "ruin" || o.kind === "bed" || o.kind === "field") continue;
		if (o.kind === "item") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach) entries.push({ label: `${o.name} aufheben`, line: `get ${o.name}` }); }
		if (o.kind === "beacon") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach && fuel) entries.push({ label: "Treibholz nachlegen", line: `put ${fuel.name} in ${o.name}` }); }
		if (o.kind === "exit") entries.push({ label: `Nach ${o.name} gehen`, line: `go ${o.name}` });
		// a hare at a bed: anyone scares it off from three cells (server: wild.ts)
		if (o.kind === "animal") entries.push({ label: `${o.name}n verscheuchen`, line: "scheuche hase" });
	}
	if (!(self && self.x === at.x && self.y === at.y)) entries.push({ label: "Hierhin gehen", line: `move ${at.x} ${at.y}` });
	// a cell nothing covers: build here (the plan's top left corner; the server says why not when it does not fit)
	const covered = [...objs.values()].some((o) => o.location === room && o.kind !== "item" && at.x >= o.x && at.y >= o.y && at.x < o.x + (o.w ?? 1) && at.y < o.y + (o.h ?? 1));
	if (!guest && plans.length && !covered) entries.push({ label: "Bauen …", line: "#bau", run: () => setStep("plans") });
	if (!guest && !covered && [...objs.values()].some((o) => o.kind === "item" && o.location === me && o.name === "Spaten")) { entries.push({ label: "Hier ein Beet umgraben", line: `umgraben ${at.x} ${at.y}` }); entries.push({ label: "Hier eine Flur anlegen (4×4)", line: `flur anlegen ${at.x} ${at.y}` }); }
	// on the own figure: what works without anything more
	if (self && self.x === at.x && self.y === at.y) {
		entries.push({ label: "Umsehen", line: "look" }, { label: "Was trage ich?", line: "inventory" }, { label: "Wer spielt?", line: "who" }, { label: "Uhrzeit", line: "time" }, { label: "Mein Ruf", line: "reputation" });
		if (plans.length) entries.push({ label: "Baupläne", line: "bau" });
		entries.push({ label: "Samen sammeln", line: "sammle samen" });
	}
	if (step === "plans") {
		entries.length = 0;
		for (const p of plans) entries.push({ label: `${p.name} (${p.w}×${p.h})`, line: `#plan ${p.key}`, run: () => setStep(p) });
		entries.push({ label: "Zurück", line: "#zurück", run: () => setStep(null) });
	} else if (step) {
		entries.length = 0;
		entries.push({ label: `OK: ${step.name} hier abstecken`, line: `bau ${step.key} ${at.x} ${at.y}` }, { label: "Zurück", line: "#zurück", run: () => setStep("plans") });
	}
	const left = Math.min(at.left, window.innerWidth - 220), top = Math.min(at.top, window.innerHeight - 40 * (entries.length + 1));
	return (
		<>
			<div className="menu-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
			<ul className="cell-menu" role="menu" style={{ left, top }}>
				{step && typeof step === "object" && <li className="menu-note">{step.name} ({step.w}×{step.h}) ab hier nach rechts unten: {step.needs}, {step.work} Arbeit</li>}
				{entries.map((e) => <li key={e.line} role="menuitem"><button onClick={() => { if (e.run) { e.run(); if (!e.line.startsWith("#bau") && !e.line.startsWith("#plan") && !e.line.startsWith("#zurück")) close(); } else { send(e.line); close(); } }}>{e.label}</button></li>)}
			</ul>
		</>
	);
}

/** A log line with the names of players as buttons (they open the name menu): the speaker of what was said, every player
 *  in the list of who plays; never one's own name. */
function LogText({ l, self, onName }: { l: Line; self: string; onName: (name: string, left: number, top: number) => void }) {
	const names = "players" in l && l.players ? l.players : "player" in l && l.player ? [l.from] : [];
	const wanted = names.filter((n) => n && n !== self);
	if (!wanted.length) return <>{l.text}</>;
	const parts: ReactNode[] = [];
	let rest = l.text, k = 0;
	for (;;) {
		let at = -1, hit = "";
		// a whole name only: "Ina" is not the end of "Kalina"
		const word = /[\p{L}\p{N}_-]/u, whole = (n: string) => { for (let i = rest.indexOf(n); i >= 0; i = rest.indexOf(n, i + 1)) if (!word.test(rest[i - 1] ?? " ") && !word.test(rest[i + n.length] ?? " ")) return i; return -1; };
		for (const n of wanted) { const i = whole(n); if (i >= 0 && (at < 0 || i < at)) { at = i; hit = n; } }
		if (at < 0) break;
		parts.push(rest.slice(0, at));
		const name = hit;
		parts.push(<button key={k++} className="name-link" onClick={(e) => onName(name, e.clientX, e.clientY)} title={`${name}: Chat, Gruppe, ignorieren`}>{name}</button>);
		rest = rest.slice(at + hit.length);
		if (!("players" in l && l.players)) break; // the speaker once
	}
	parts.push(rest);
	return <>{parts}</>;
}

/** The menu of a player's name in the log: chat, invite into one's groups, ignore. */
function NameMenu({ at, name, groups, talk, invite, ignore, close }: { at: { left: number; top: number }; name: string; groups: string[]; talk: () => void; invite: (group: string) => void; ignore: () => void; close: () => void }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	const entries = [{ label: `Chat mit ${name}`, run: talk }, ...groups.slice(0, 4).map((g) => ({ label: `${name} in „${g}“ einladen`, run: () => invite(g) })), { label: `${name} ignorieren`, run: ignore }];
	const left = Math.min(at.left, window.innerWidth - 220), top = Math.min(at.top, window.innerHeight - 40 * (entries.length + 1));
	return (
		<>
			<div className="menu-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
			<ul className="cell-menu" role="menu" style={{ left, top }}>
				{entries.map((e) => <li key={e.label} role="menuitem"><button onClick={() => { e.run(); close(); }}>{e.label}</button></li>)}
			</ul>
		</>
	);
}

/** Trade as buttons: offers to and from the player, a form for a new offer, the order board and the market board when
 *  standing at them. Every button sends the text command the help names. */
function TradePanel({ trade, chars, objs, me, guest, offerTo, setOfferTo, send }: { trade: TradeView; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; guest: boolean; offerTo: string | null; setOfferTo: (n: string | null) => void; send: (line: string) => void }) {
	const carried = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
	const others = [...chars.values()].filter((c) => c.charId !== me);
	const [give, setGive] = useState("");
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
	const [sell, setSell] = useState(""), [price, setPrice] = useState("2");
	// things by kind with their count ("4× Münze für Perle"), as the server's messages say it
	const counted = (xs: string[] | Array<{ name: string; count: number }>) => {
		const m = new Map<string, number>();
		for (const x of xs) { const [n, k] = typeof x === "string" ? [x, 1] : [x.name.charAt(0).toUpperCase() + x.name.slice(1), x.count]; m.set(n, (m.get(n) ?? 0) + k); }
		return [...m].map(([n, k]) => (k > 1 ? `${k}× ${n}` : n)).join(", ");
	};
	const wants = (w: Array<{ name: string; count: number }>) => (w.length ? ` für ${counted(w)}` : " als Geschenk");
	const has = trade.offersIn.length || trade.offersOut.length || trade.orders || trade.myOrder || trade.listings || offerTo;
	if (!has) return null;
	return (
		<div className="things trade">
			{trade.offersIn.length > 0 && <><h3>Angebote an dich</h3><ul>{trade.offersIn.map((o) => (
				<li key={o.offerId}><span>{o.fromName}: {counted(o.giveNames)}{wants(o.want)}</span><button onClick={() => send(`accept ${o.fromName}`)}>Annehmen</button><button onClick={() => send(`decline ${o.fromName}`)}>Ablehnen</button></li>
			))}</ul></>}
			{trade.offersOut.length > 0 && <><h3>Deine Angebote</h3><ul>{trade.offersOut.map((o) => (
				<li key={o.offerId}><span>an {o.toName}: {counted(o.giveNames)}{wants(o.want)}</span><button onClick={() => send("offer zurück")}>Zurücknehmen</button></li>
			))}</ul></>}
			{offerTo !== null && !guest && (
				<form className="trade-form" onSubmit={(e) => { e.preventDefault(); if (!offerTo || !give.trim()) return; send(`offer ${give.trim()} an ${offerTo}${want.trim() ? ` für ${want.trim()}` : ""}`); setGive(""); setWant(""); setOfferTo(null); }}>
					<h3>Tausch anbieten</h3>
					<label>An <select value={offerTo} onChange={(e) => setOfferTo(e.target.value)}><option value="">wählen …</option>{others.map((c) => <option key={c.charId} value={c.name}>{c.name}</option>)}</select></label>
					{kinds.length ? <ul className="carried" aria-label="Was du trägst">{kinds.map(([name, n]) => (
						<li key={name}><button type="button" onClick={() => addGive(name, n)} title={`1 ${name} dazugeben`}><span>{name}</span><span className="count">{n}×</span></button></li>
					))}</ul> : <span className="muted">Du trägst nichts.</span>}
					<label>Du gibst <input value={give} onChange={(e) => setGive(e.target.value)} placeholder="z. B. 2 muschel, tang" /></label>
					<label>Dafür (leer: Geschenk) <input value={want} onChange={(e) => setWant(e.target.value)} placeholder="z. B. 2 münze" /></label>
					<div className="row"><button className="primary" disabled={!offerTo || !give.trim()}>Anbieten</button><button type="button" onClick={() => setOfferTo(null)}>Abbrechen</button></div>
				</form>
			)}
			{offerTo === null && !guest && others.length > 0 && carried.length > 0 && <button className="link" onClick={() => setOfferTo("")}>Tausch anbieten …</button>}
			{trade.myOrder && <><h3>Dein Auftrag</h3><ul><li><span>{trade.myOrder.text}</span>{trade.myOrder.here && <><button onClick={() => send("auftrag liefere")}>Liefern</button><button onClick={() => send("auftrag aufgeben")}>Aufgeben</button></>}</li></ul>
				{!trade.myOrder.here && <p className="muted" style={{ margin: "0 0 4px" }}>Abliefern an einer Auftragstafel: {trade.myOrder.boards.join(", ")}.</p>}</>}
			{trade.orders && <><h3>Auftragstafel</h3>{trade.orders.length ? <ul>{trade.orders.map((o) => (
				<li key={o.nr}><span>{o.text} ({o.reward} Münze{o.reward === 1 ? "" : "n"})</span>{!guest && !trade.myOrder && <button onClick={() => send(`auftrag nimm ${o.nr}`)}>Nehmen</button>}</li>
			))}</ul> : <p className="muted">Gerade keine Aufträge.</p>}</>}
			{trade.listings && <><h3>Marktbrett</h3>{trade.listings.length ? <ul>{trade.listings.map((l) => (
				<li key={l.nr}><span>{l.itemName} – {l.price} Münze{l.price === 1 ? "" : "n"} ({l.mine ? "deins" : l.sellerName})</span>{!guest && (l.mine ? <button onClick={() => send(`markt zurück ${l.nr}`)}>Zurückholen</button> : <button onClick={() => send(`markt kaufe ${l.nr}`)}>Kaufen</button>)}</li>
			))}</ul> : <p className="muted">Das Brett ist leer.</p>}
			{!guest && carried.length > 0 && (
				<form className="row" onSubmit={(e) => { e.preventDefault(); if (sell) send(`markt biete ${sell} für ${price}`); setSell(""); }}>
					<select value={sell} onChange={(e) => setSell(e.target.value)} aria-label="Was verkaufen"><option value="">verkaufen …</option>{[...new Set(carried.map((o) => o.name))].map((n) => <option key={n} value={n}>{n}</option>)}</select>
					<input type="number" min={1} max={1000} value={price} onChange={(e) => setPrice(e.target.value)} aria-label="Preis in Münzen" style={{ width: 70 }} />
					<button disabled={!sell}>Einstellen</button>
				</form>
			)}</>}
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
function Things({ objs, self, room, me, send, pick }: { objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void; pick: (o: ObjView) => void }) {
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
	const kinds = [...carried.reduce((m, o) => m.set(o.name, [...(m.get(o.name) ?? []), o]), new Map<string, ObjView[]>())].sort(([a], [b]) => a.localeCompare(b));
	const chosen = kinds.find(([name]) => name === picked);
	if (!carried.length && !near.length && !fire) return <div />;
	const row = (o: ObjView, verb: string, label: string) => (
		<li key={o.id}><Glyph o={o} size={20} /><span>{o.name}</span><button onClick={() => (verb === "get" ? pick(o) : send(`${verb} ${o.name}`))}>{label}</button><button onClick={() => send(`look ${o.name}`)}>Ansehen</button></li>
	);
	return (
		<div className="things">
			{fire && (
				<><h3>{fire.name}</h3><ul><li>
					<span>{(fire.until ?? 0) > Date.now() ? `brennt noch ${Math.max(1, Math.round(((fire.until ?? 0) - Date.now()) / 1000))} s` : "ist erloschen"}</span>
					<button disabled={!fuel} onClick={() => fuel && send(`put ${fuel.name} in ${fire.name}`)} title={fuel ? "" : "Du trägst kein Brennholz"}>Nachlegen</button>
				</li></ul></>
			)}
			{near.length > 0 && <><h3>Neben dir</h3><ul>{near.map((o) => row(o, "get", "Aufheben"))}</ul></>}
			{carried.length > 0 && <>
				<h3>Du trägst</h3>
				<div className="pack">{kinds.map(([name, os]) => (
					<button key={name} className={`chip${picked === name ? " on" : ""}`} onClick={() => setPicked(picked === name ? null : name)} title={name} aria-label={`${name}: ${os.length}`} aria-pressed={picked === name}>
						<Glyph o={os[0]!} size={24} /><span className="n">{os.length}</span>
					</button>
				))}</div>
				{chosen && <div className="pack-do"><span>{chosen[0]}{chosen[1].length > 1 ? ` ×${chosen[1].length}` : ""}</span>
					<button onClick={() => send(`drop ${chosen[0]}`)}>Ablegen</button>
					{fire && fuels.includes(chosen[0]) && <button onClick={() => send(`put ${chosen[0]} in ${fire.name}`)}>Nachlegen</button>}
					<button onClick={() => send(`look ${chosen[0]}`)}>Ansehen</button>
				</div>}
			</>}
		</div>
	);
}

function Game({ account, onAccount, controls }: { account: Account; onAccount: (a: Account | null) => void; controls: ReactNode }) {
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
	const [hiddenTalks, setHiddenTalks] = useState<Set<string>>(new Set());
	const [chatState, setChatState] = useState<ChatState | null>(null);
	const [notice, setNotice] = useState<{ text: string; error: boolean; at: number } | null>(null);
	const setTab = useCallback((k: string) => { tabRef.current = k; setTabState(k); if (k !== "log" && k !== "chats") setTalks((t) => readTalk(t, k)); }, []);
	const [live, setLive] = useState(false);
	const [line, setLine] = useState("");
	const [panel, setPanel] = useState<null | "account" | "leave" | "admin">(null);
	const [help, setHelp] = useState(false);
	// the answer of `help` laid out in a window like the help (CommandHelp); a topic keeps the list it came from
	const [cmdHelp, setCmdHelp] = useState<HelpView | null>(null);
	// on a phone the map modes and logging out sit behind "⋯" in the header bar (styles.css, `.bar-tools`)
	const [more, setMore] = useState(false);
	const [stale, setStale] = useState(false);
	// Text, established 2D or optional 3D: remembered per browser. The old text-only preference migrates forward.
	// coming and going in the log ("… geht nach ost.", "… kommt an."): hidden unless asked for, remembered in the browser
	const [comings, setComingsState] = useState(() => { try { return localStorage.getItem("mmo.comings") === "1"; } catch { return false; } });
	const setComings = (on: boolean) => { setComingsState(on); try { localStorage.setItem("mmo.comings", on ? "1" : "0"); } catch { /* private window */ } };
	const [mapMode, setMapModeState] = useState<MapMode>(() => {
		try { const saved = localStorage.getItem("mmo.renderer"); return saved === "text" || saved === "2d" || saved === "3d" ? saved : localStorage.getItem("mmo.textOnly") === "1" ? "text" : "2d"; }
		catch { return "2d"; }
	});
	const [menu, setMenu] = useState<null | { x: number; y: number; left: number; top: number }>(null);
	const [nameMenu, setNameMenu] = useState<null | { name: string; left: number; top: number }>(null);
	const setMapMode = (mode: MapMode) => { setMenu(null); setMapModeState(mode); try { localStorage.setItem("mmo.renderer", mode); localStorage.setItem("mmo.textOnly", mode === "text" ? "1" : "0"); } catch { /* private window */ } };
	const ws = useRef<WebSocket | null>(null);
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
			if (missing.length) setNotice({ text: `Ohne eingerichteten Chat lesen nicht mit: ${missing.join(", ")}.`, error: false, at: Date.now() });
		} catch (e) { setNotice({ text: (e as Error).message, error: true, at: Date.now() }); }
	}, []);
	const logEnd = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const me = hello?.me.charId ?? "";
	// the own figure's walk: drawn ahead of the server, matched by step numbers (client/walk.ts)
	const walker = useRef(new Walker());
	// the world's clock as the server last told it; shown by interpolation, nothing is decided by it
	const [worldTime, setWorldTime] = useState<{ v: WorldTimeView; at: number } | null>(null);
	const [, setTick] = useState(0);
	useEffect(() => { if (!worldTime || worldTime.v.paused) return; const t = setInterval(() => setTick((n) => n + 1), 1000); return () => clearInterval(t); }, [worldTime]);
	const meRef = useRef("");
	meRef.current = me;
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
					retry = 0; setHello(f); setWorldTime(f.worldTime ? { v: f.worldTime, at: Date.now() } : null);
					for (const t of goneTimers.values()) clearTimeout(t); goneTimers.clear();
					meRef.current = f.me.charId;
					{ const mine = f.chars.find((c) => c.charId === f.me.charId); if (mine) walker.current.reset(mine); } fuels = f.world.fuels;
					setChars(new Map(f.chars.map((c) => [c.charId, c])));
					setObjs(new Map(f.objs.map((o) => [o.id, o])));
					setFog(f.fog);
					// the first hello brings the room's recent talk; a later one (another room, a reconnect) keeps the log
					if (!greeted) setLog(f.log); else append({ kind: "echo", text: `— ${f.room.name} —`, from: "", at: Date.now() });
					greeted = true;
				}
				else if (f.t === "char") {
					clearTimeout(goneTimers.get(f.c.charId)); goneTimers.delete(f.c.charId);
					// the own figure: drawn where the walk puts it (the server's place plus the steps still on their way)
					if (f.c.charId === meRef.current) {
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
				else if (f.t === "time") setWorldTime({ v: f.time, at: Date.now() });
				else if (f.t === "trade") setTrade(f.trade);
				else if (f.t === "atlas") setAtlas(f.atlas);
				else if (f.t === "atlasState") setAtlasState(f.state);
				else if (f.t === "objgone") { pickups.current.delete(f.id); setObjs((m) => { const n = new Map(m); n.delete(f.id); return n; }); }
				else if (f.t === "msg" && f.m.kind === "help" && f.m.help) {
					const h = f.m.help;
					setCmdHelp((old) => (h.topic ? { intro: old?.intro, commands: old?.commands, topics: old?.topics, topic: h.topic } : h));
					setHelp(false);
					append({ ...f.m, text: h.topic ? `Hilfe zu „${h.topic.key}“ im Fenster links.` : "Die Befehle stehen im Fenster links (help)." });
				}
				else if (f.t === "msg") { if (f.m.kind === "error") putBack(); append(f.m); if (tabRef.current !== "log" && (f.m.kind === "error" || f.m.kind === "info")) setNotice({ text: f.m.text, error: f.m.kind === "error", at: Date.now() }); }
				else if (f.t === "chatme" || f.t === "chatkeys") keysRef.current.onFrame(f);
				else if (f.t === "chatlog") { keysRef.current.onFrame(f); setTalks(fromLog(f.msgs, tabRef.current)); }
				else if (f.t === "chat") {
					keysRef.current.onFrame(f);
					setTalks((t) => { const n = addMsg(t, f.m, tabRef.current); return tabRef.current === keyOf(f.m.conv) ? readTalk(n, tabRef.current) : n; });
					setHiddenTalks((h) => { const k = keyOf(f.m.conv); if (!h.has(k)) return h; const n = new Set(h); n.delete(k); return n; });
				}
				else if (f.t === "chats") setChatState(f.state);
				else if (f.t === "chatopen") {
					setTalks((t) => openTalk(t, f.conv)); setHiddenTalks((h) => { const n = new Set(h); n.delete(keyOf(f.conv)); return n; }); setTab(keyOf(f.conv));
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
	}, [append, onAccount, setTab]);

	useEffect(() => { logEnd.current?.scrollIntoView({ block: "end" }); }, [log]);

	const send = useCallback((text: string, echo = true) => {
		const s = ws.current;
		if (!s || s.readyState !== WebSocket.OPEN) { append({ kind: "error", text: "Nicht verbunden; ein Moment …", from: "", at: Date.now() }); return; }
		s.send(JSON.stringify({ t: "cmd", line: text }));
		if (echo) append({ kind: "echo", text: `> ${text}`, from: "", at: Date.now() });
	}, [append]);

	// what the walk looks at between renders (the hold timer runs outside React's render)
	const seen = useRef({ chars, objs, hello });
	seen.current = { chars, objs, hello };

	/** One step of the own figure: by `d`, or toward a tapped cell (the longer axis first; if that cell is not free, the
	 *  other axis). It is drawn at once and sent with its number; a cell that is not free is not walked into. */
	const step = useCallback((d: [number, number] | { x: number; y: number }) => {
		const { chars, objs, hello } = seen.current;
		const from = walker.current.shown;
		if (!from || !hello) return;
		const s = ws.current;
		if (!s || s.readyState !== WebSocket.OPEN) return;
		// walkable and nobody standing there (the server checks again and answers either way); at a door (an exit's cell or
		// one next to it) others do not block: one walks through them, as the server lets one (engine/occupancy.ts)
		const exits = [...objs.values()].filter((o) => o.kind === "exit" && o.location === hello.room.roomId);
		const passage = (c: { x: number; y: number }) => exits.some((e) => Math.max(Math.abs(e.x - c.x), Math.abs(e.y - c.y)) <= 1);
		const taken = new Set([...[...chars.values()].filter((c) => c.charId !== meRef.current && !passage(c)), ...[...objs.values()].filter((o) => o.kind === "beacon" && o.location === hello.room.roomId)].map((c) => `${c.x},${c.y}`));
		// sites and buildings cover their cells: nobody walks into them (server: occupancy.ts blockedIn)
		for (const o of objs.values()) if ((o.kind === "site" || o.kind === "building" || o.kind === "ruin" || o.kind === "bed" || o.kind === "field") && o.location === hello.room.roomId) for (let dy = 0; dy < (o.h ?? 1); dy++) for (let dx = 0; dx < (o.w ?? 1); dx++) taken.add(`${o.x + dx},${o.y + dy}`);
		const free = (x: number, y: number) => !!hello.world.tiles[hello.room.ground[y]?.[x] ?? ""]?.walk && !taken.has(`${x},${y}`);
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
	}, [showOwn]);

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
		send(`get ${o.name}`);
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
	useEffect(() => {
		const f = fetching.current, self = chars.get(me);
		if (!f || !self || !hello) return;
		const o = objs.get(f.id);
		if (!o || o.location !== hello.room.roomId || Date.now() > f.until) { fetching.current = null; return; }
		if (Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1) { fetching.current = null; pickUp(o); }
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
			if (e.key === "Enter") { e.preventDefault(); release(); input.current?.focus(); return; }
			if (e.key === " ") { e.preventDefault(); if (!e.repeat) action(); return; }
			// typing text: the first letter goes to the command line, which takes the rest (a shortcut with Ctrl, Alt or
			// Cmd stays the browser's)
			if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
				e.preventDefault();
				release();
				const el = input.current;
				if (!el) return;
				setLine((l) => l + e.key);
				el.focus();
				requestAnimationFrame(() => { const n = el.value.length; el.setSelectionRange(n, n); });
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

	return (
		<div className="game">
			<header className="bar">
				<span className="title">{hello?.world.title ?? "Leuchtfeuer"}</span>
				<button className="help-btn" onClick={() => { setCmdHelp(null); setHelp((h) => !h); }} aria-expanded={help} aria-label="Hilfe / Help" title="Hilfe / Help">?</button>
				<span className={`live${live ? " on" : ""}`} title={live ? "verbunden" : "getrennt"} />
				<span>{hello?.room.name ?? ""}</span>
				{worldTime && <span className="worldtime" title="Weltzeit (Tag und Uhrzeit in der Welt)">{formatWorldTime(shownWorldMs(worldTime.v, worldTime.at, Date.now()))}{worldTime.v.paused ? " ⏸" : ""}</span>}
				<span className="spacer" />
				<span>{account.name}</span>
				{account.guest && <span className="badge">Gast</span>}
				{account.guest && <button onClick={() => setPanel(panel === "account" ? null : "account")} title="Registrieren, um den Fortschritt zu behalten"><span className="long">Registrieren, um den Fortschritt zu behalten</span><span className="short">Registrieren</span></button>}
				<button className="bar-more" onClick={() => setMore((m) => !m)} aria-expanded={more} aria-label="Darstellung und Abmelden">⋯</button>
				{more && <div className="menu-backdrop bar-backdrop" onClick={() => setMore(false)} />}
				<div className={`bar-tools${more ? " open" : ""}`}>
					<div className="renderer-tabs" role="group" aria-label="Kartendarstellung">
						{(["text", "2d", "3d"] as const).map((mode) => <button key={mode} onClick={() => { setMore(false); setMapMode(mode); }} aria-pressed={mapMode === mode}>{mode === "text" ? "Text" : mode.toUpperCase()}</button>)}
					</div>
					{controls}
					{account.admin && <button onClick={() => { setMore(false); setPanel(panel === "admin" ? null : "admin"); }} aria-pressed={panel === "admin"}>Admin</button>}
					<button onClick={() => { setMore(false); if (account.guest) setPanel("leave"); else void logout(); }}>Abmelden</button>
				</div>
			</header>
			{help && <HelpPanel onClose={() => setHelp(false)} />}
			{cmdHelp && !help && <CommandHelp view={cmdHelp} onTopic={(key) => (key ? send(`help ${key}`, false) : setCmdHelp((old) => (old ? { ...old, topic: undefined } : old)))} onArticles={() => { setCmdHelp(null); setHelp(true); }} onClose={() => setCmdHelp(null)} />}
			{stale && <div className="stale" role="status">Neue Version des Spiels – die Seite lädt neu …</div>}
			<div className={`main${mapMode === "text" ? " text-only" : ""}`}>
				{atlas && atlas.rooms.length > 1 && <Atlas atlas={atlas} state={atlasState} />}
				{mapMode === "text" ? null : hello ? (
					<MapRenderer mode={mapMode} world={hello.world} room={hello.room} chars={chars} objs={objs} me={me} fog={fog} onTurn={onTurn}
						controls={<TouchPad hold={(d) => { input.current?.blur(); setMenu(null); hold(d); }} release={release} action={action} />}
						onCell={(x, y) => { input.current?.blur(); setMenu(null); onCell(x, y); }}
						onMenu={(x, y, left, top) => { input.current?.blur(); setMenu({ x, y, left, top }); }}
						onFail={(why) => { setMapMode(mapMode === "3d" ? "2d" : "text"); append({ kind: "error", text: `${why} ${mapMode === "3d" ? "Die 2D-Karte bleibt aktiv." : "Das Spiel läuft als Text weiter."}`, from: "", at: Date.now() }); }} />
				) : <div className="map"><p className="muted">Verbinde …</p></div>}
				{menu && hello && <CellMenu at={menu} chars={chars} objs={objs} self={chars.get(me)} room={hello.room.roomId} me={me} plans={hello.world.plans ?? []} guest={account.guest} send={send} close={() => setMenu(null)} offer={account.guest ? undefined : (name) => { setPanel(null); setOfferTo(name); }}
					chat={{ talk: (name) => send(`chat ${name}`, false), invite: (name, g) => send(`gruppe lade ${name} in ${g}`), groups: account.guest ? [] : (chatState?.groups.map((g) => g.name) ?? []) }} />}
				{nameMenu && <NameMenu at={nameMenu} name={nameMenu.name} groups={account.guest ? [] : (chatState?.groups.map((g) => g.name) ?? [])} close={() => setNameMenu(null)}
					talk={() => send(`chat ${nameMenu.name}`, false)} invite={(g) => send(`gruppe lade ${nameMenu.name} in ${g}`)} ignore={() => send(`ignoriere ${nameMenu.name}`)} />}
				<aside className="side">
					{panel === "account" && (
						<div className="panel"><h2>Konto anlegen</h2><AccountForm guest onDone={(a) => { setPanel(null); onAccount(a); }} /></div>
					)}
					{panel === "admin" && <AdminPanel onClose={() => setPanel(null)} />}
					{panel === "leave" && (
						<div className="panel">
							<h2>Als Gast abmelden?</h2>
							<p style={{ margin: "0 0 10px", fontSize: 13 }}>Ohne Registrierung kommst du nicht zu dieser Figur zurück; sie verfällt nach einigen Tagen.</p>
							<div style={{ display: "flex", gap: 8 }}><button onClick={() => setPanel("account")}>Erst registrieren</button><button onClick={() => void logout()}>Trotzdem abmelden</button></div>
						</div>
					)}
					{!panel && (
						<div className="side-top">
							<Things objs={objs} self={chars.get(me)} room={hello?.room.roomId ?? ""} me={me} send={send} pick={pickUp} />
							{trade && hello && <TradePanel trade={trade} chars={chars} objs={objs} me={me} guest={account.guest} offerTo={offerTo} setOfferTo={setOfferTo} send={send} />}
						</div>
					)}
					<div className="log-head">
						<ChatTabs talks={talks} hidden={hiddenTalks} tab={tab} setTab={setTab} state={chatState} close={(k) => { setHiddenTalks((h) => new Set(h).add(k)); if (tab === k) setTab("log"); }} />
						{tab === "log" && <label className="log-filter"><input type="checkbox" checked={comings} onChange={(e) => setComings(e.target.checked)} /> Kommen und Gehen</label>}
					</div>
					{tab === "log" ? (
						<div className="log" role="log" aria-live="polite">
							{(comings ? log : log.filter((l) => !isComing(l))).map((l, i) => <div key={i} className={`${l.kind}${"toMe" in l && l.toMe ? " to-me" : ""}`}><LogText l={l} self={chars.get(me)?.name ?? account.name} onName={(name, left, top) => setNameMenu({ name, left, top })} />{"ai" in l && l.ai ? <span className="ai-badge" title="Diese Figur spielt ein Sprachmodell">KI</span> : null}</div>)}
							<div ref={logEnd} />
						</div>
					) : tab === "chats" || !talks.get(tab) ? (
						<ChatOverview state={chatState} guest={account.guest} talks={talks} open={setTab} send={send} keys={keys} />
					) : <TalkView talk={talks.get(tab)!} keys={keys} />}
					{tab !== "log" && notice && Date.now() - notice.at < 10_000 && <p className={`chat-notice${notice.error ? " error" : ""}`} role="status">{notice.text}</p>}
					<form className="cmd" onSubmit={(e) => {
						e.preventDefault(); const t = line.trim(); if (!t) return;
						const talk = talks.get(tab);
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
						<input ref={input} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onCommandKey} onFocus={() => release()} placeholder={talks.get(tab) ? `Nachricht an ${talks.get(tab)!.conv.kind === "group" ? `die Gruppe ${talks.get(tab)!.conv.title}` : talks.get(tab)!.conv.title} …` : "Einfach lostippen: Befehl oder Satz, z. B. look, say Hallo · Esc oder Pfeiltaste: zurück zur Karte"} maxLength={300} aria-label={talks.get(tab) ? "Nachricht" : "Befehl"} />
						<button className="primary">Senden</button>
					</form>
					<About />
				</aside>
			</div>
			<SystemBar />
		</div>
	);
}
