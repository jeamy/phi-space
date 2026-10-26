"use client";
// spaces-mmo in the browser: a welcome page (play as a guest, log in, register) and the game: the PixiJS map of the
// room, the text log and the command line. Everything the player does is a text command sent over the WebSocket; a
// tap on the map or an arrow key becomes `move x y` for one step. All text from the world is rendered as React text nodes.
import { useCallback, useEffect, useRef, useState } from "react";
import type { AtlasState, AtlasView, CharView, MsgView, ObjView, ServerFrame, TradeView } from "../server/gateway.ts";
import { Atlas } from "./Atlas.tsx";
import { HelpPanel } from "./HelpPanel.tsx";
import { appendLine } from "./log.ts";
import { WALK_MS, Walker } from "./walk.ts";
import { formatWorldTime, shownWorldMs, type WorldTimeView } from "../server/engine/worldtime.ts";

/** How long a "gone" waits for the "char" that follows it when a character is only being moved (see the handler). */
const GONE_GRACE_MS = 2500;
import { MapRenderer, type MapMode } from "./MapRenderer.tsx";
import { TouchPad } from "./TouchPad.tsx";

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

export function MmoApp() {
	const [account, setAccount] = useState<Account | null | undefined>(undefined);
	useEffect(() => { void fetch("/api/me").then((r) => r.json()).then((d) => { pageBuild ??= d.build ?? null; setAccount(d.account ?? null); }, () => setAccount(null)); }, []);
	if (account === undefined) return <main className="welcome"><p className="muted">Lädt …</p></main>;
	if (!account) return <Welcome onIn={setAccount} />;
	return <Game account={account} onAccount={setAccount} />;
}

function Welcome({ onIn }: { onIn: (a: Account) => void }) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const guest = async () => {
		setBusy(true); setError("");
		try { onIn((await post("/api/guest")).account!); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
	};
	return (
		<main className="welcome">
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
		try { onDone((await post(mode === "login" ? "/api/login" : "/api/register", { name, password, ...(mode === "register" && token ? { setupToken: token } : {}) })).account!); }
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
			{mode === "register" && !guest && (
				<details><summary>Einrichtungstoken (nur für den ersten Admin)</summary><input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" /></details>
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
			PixelFox, Zetasis, George und Murdoc, CC BY 4.0 (<a href="/assets/leuchtfeuer/CREDITS.md" target="_blank" rel="noreferrer">Nachweise</a>).
		</p>
	);
}

/** The menu of a long press or a right click on a cell: what stands, lies or burns there, and what one can do with it.
 *  Every entry is a text command. */
function CellMenu({ at, chars, objs, self, room, me, send, close, offer }: { at: { x: number; y: number; left: number; top: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void; close: () => void; offer?: (name: string) => void }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	const reach = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 1;
	const fuel = fuelIn(objs, me);
	const entries: Array<{ label: string; line: string; run?: () => void }> = [];
	for (const c of chars.values()) if (c.x === at.x && c.y === at.y && c.charId !== me) {
		entries.push({ label: `${c.name} ansehen`, line: `look ${c.name}` });
		if (offer) entries.push({ label: `${c.name} einen Tausch anbieten …`, line: `#offer ${c.name}`, run: () => offer(c.name) });
	}
	for (const o of objs.values()) {
		if (o.location !== room || o.x !== at.x || o.y !== at.y) continue;
		if (o.kind === "item") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach) entries.push({ label: `${o.name} aufheben`, line: `get ${o.name}` }); }
		if (o.kind === "beacon") { entries.push({ label: `${o.name} ansehen`, line: `look ${o.name}` }); if (reach && fuel) entries.push({ label: "Treibholz nachlegen", line: `put ${fuel.name} in ${o.name}` }); }
		if (o.kind === "exit") entries.push({ label: `Nach ${o.name} gehen`, line: `go ${o.name}` });
	}
	if (!(self && self.x === at.x && self.y === at.y)) entries.push({ label: "Hierhin gehen", line: `move ${at.x} ${at.y}` });
	const left = Math.min(at.left, window.innerWidth - 220), top = Math.min(at.top, window.innerHeight - 40 * (entries.length + 1));
	return (
		<>
			<div className="menu-backdrop" onClick={close} onContextMenu={(e) => { e.preventDefault(); close(); }} />
			<ul className="cell-menu" role="menu" style={{ left, top }}>
				{entries.map((e) => <li key={e.line} role="menuitem"><button onClick={() => { if (e.run) e.run(); else send(e.line); close(); }}>{e.label}</button></li>)}
			</ul>
		</>
	);
}

/** Trade as buttons: offers to and from the player, a form for a new offer, the order board and the market board when
 *  standing at them. Every button sends the text command the help names. */
function TradePanel({ trade, chars, objs, me, guest, offerTo, setOfferTo, send }: { trade: TradeView; chars: Map<string, CharView>; objs: Map<string, ObjView>; me: string; guest: boolean; offerTo: string | null; setOfferTo: (n: string | null) => void; send: (line: string) => void }) {
	const carried = [...objs.values()].filter((o) => o.kind === "item" && o.location === me);
	const others = [...chars.values()].filter((c) => c.charId !== me);
	const [give, setGive] = useState<string[]>([]);
	const [want, setWant] = useState("");
	const [sell, setSell] = useState(""), [price, setPrice] = useState("2");
	const wants = (w: Array<{ name: string; count: number }>) => (w.length ? ` für ${w.map((x) => `${x.count}× ${x.name}`).join(", ")}` : " als Geschenk");
	const has = trade.offersIn.length || trade.offersOut.length || trade.orders || trade.myOrder || trade.listings || offerTo;
	if (!has) return null;
	return (
		<div className="things trade">
			{trade.offersIn.length > 0 && <><h3>Angebote an dich</h3><ul>{trade.offersIn.map((o) => (
				<li key={o.offerId}><span>{o.fromName}: {o.giveNames.join(", ")}{wants(o.want)}</span><button onClick={() => send(`accept ${o.fromName}`)}>Annehmen</button><button onClick={() => send(`decline ${o.fromName}`)}>Ablehnen</button></li>
			))}</ul></>}
			{trade.offersOut.length > 0 && <><h3>Deine Angebote</h3><ul>{trade.offersOut.map((o) => (
				<li key={o.offerId}><span>an {o.toName}: {o.giveNames.join(", ")}{wants(o.want)}</span><button onClick={() => send("offer zurück")}>Zurücknehmen</button></li>
			))}</ul></>}
			{offerTo !== null && !guest && (
				<form className="trade-form" onSubmit={(e) => { e.preventDefault(); if (!offerTo || !give.length) return; send(`offer ${give.map((g) => g.replace(/#\d+$/, "")).join(", ")} an ${offerTo}${want.trim() ? ` für ${want.trim()}` : ""}`); setGive([]); setWant(""); setOfferTo(null); }}>
					<h3>Tausch anbieten</h3>
					<label>An <select value={offerTo} onChange={(e) => setOfferTo(e.target.value)}><option value="">wählen …</option>{others.map((c) => <option key={c.charId} value={c.name}>{c.name}</option>)}</select></label>
					<div className="checks">{carried.length ? carried.map((o, i) => (
						<label key={o.id}><input type="checkbox" checked={give.includes(`${o.name}#${i}`)} onChange={(e) => setGive((g) => (e.target.checked ? [...g, `${o.name}#${i}`] : g.filter((x) => x !== `${o.name}#${i}`)))} />{o.name}</label>
					)) : <span className="muted">Du trägst nichts.</span>}</div>
					<label>Dafür (leer: Geschenk) <input value={want} onChange={(e) => setWant(e.target.value)} placeholder="z. B. 2 münze" /></label>
					<div className="row"><button className="primary" disabled={!offerTo || !give.length}>Anbieten</button><button type="button" onClick={() => setOfferTo(null)}>Abbrechen</button></div>
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

/** A thing's icon: its glyph (shape and colour) until licensed item graphics exist. */
function Glyph({ o }: { o: ObjView }) {
	const c = o.glyph?.color ?? "#9aa3ad", shape = o.glyph?.shape ?? "square";
	return (
		<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
			{shape === "circle" ? <circle cx="8" cy="8" r="6" fill={c} stroke="#0008" /> : shape === "diamond" ? <path d="M8 1.5 14.5 8 8 14.5 1.5 8Z" fill={c} stroke="#0008" /> : <rect x="2.5" y="2.5" width="11" height="11" rx="2" fill={c} stroke="#0008" />}
		</svg>
	);
}

/** What the player carries and what lies within reach, as buttons (on a phone there is no keyboard to type with). */
function Things({ objs, self, room, me, send }: { objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void }) {
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
		<li key={o.id}><span>{o.name}</span><button onClick={() => send(`${verb} ${o.name}`)}>{label}</button><button onClick={() => send(`look ${o.name}`)}>Ansehen</button></li>
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
						<Glyph o={os[0]!} /><span className="n">{os.length}</span>
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

function Game({ account, onAccount }: { account: Account; onAccount: (a: Account | null) => void }) {
	const [hello, setHello] = useState<Hello | null>(null);
	const [chars, setChars] = useState<Map<string, CharView>>(new Map());
	const [objs, setObjs] = useState<Map<string, ObjView>>(new Map());
	const [fog, setFog] = useState(0);
	const [trade, setTrade] = useState<TradeView | null>(null);
	const [atlas, setAtlas] = useState<AtlasView | null>(null);
	const [atlasState, setAtlasState] = useState<AtlasState | null>(null);
	const [offerTo, setOfferTo] = useState<string | null>(null);
	const [log, setLog] = useState<Line[]>([]);
	const [live, setLive] = useState(false);
	const [line, setLine] = useState("");
	const [panel, setPanel] = useState<null | "account" | "leave">(null);
	const [help, setHelp] = useState(false);
	// on a phone the map modes and logging out sit behind "⋯" in the header bar (styles.css, `.bar-tools`)
	const [more, setMore] = useState(false);
	const [stale, setStale] = useState(false);
	// Text, established 2D or optional 3D: remembered per browser. The old text-only preference migrates forward.
	const [mapMode, setMapModeState] = useState<MapMode>(() => {
		try { const saved = localStorage.getItem("mmo.renderer"); return saved === "text" || saved === "2d" || saved === "3d" ? saved : localStorage.getItem("mmo.textOnly") === "1" ? "text" : "2d"; }
		catch { return "2d"; }
	});
	const [menu, setMenu] = useState<null | { x: number; y: number; left: number; top: number }>(null);
	const setMapMode = (mode: MapMode) => { setMenu(null); setMapModeState(mode); try { localStorage.setItem("mmo.renderer", mode); localStorage.setItem("mmo.textOnly", mode === "text" ? "1" : "0"); } catch { /* private window */ } };
	const ws = useRef<WebSocket | null>(null);
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
				else if (f.t === "obj") setObjs((m) => new Map(m).set(f.o.id, f.o));
				else if (f.t === "fog") setFog(f.level);
				else if (f.t === "time") setWorldTime({ v: f.time, at: Date.now() });
				else if (f.t === "trade") setTrade(f.trade);
				else if (f.t === "atlas") setAtlas(f.atlas);
				else if (f.t === "atlasState") setAtlasState(f.state);
				else if (f.t === "objgone") setObjs((m) => { const n = new Map(m); n.delete(f.id); return n; });
				else if (f.t === "msg") append(f.m);
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
	}, [append, onAccount]);

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
		// walkable and nobody standing there (the server checks again and answers either way)
		const taken = new Set([...[...chars.values()].filter((c) => c.charId !== meRef.current), ...[...objs.values()].filter((o) => o.kind === "beacon" && o.location === hello.room.roomId)].map((c) => `${c.x},${c.y}`));
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
	const hold = useCallback((d: [number, number]) => {
		held.current = [...held.current.filter(([a, b]) => a !== d[0] || b !== d[1]), d];
		step(d);
		holdTimer.current ??= setInterval(() => { const last = held.current.at(-1); if (last) step(last); }, WALK_MS);
	}, [step]);
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

	/** Space: pick up what lies nearest (the own cell first); with nothing there, feed a fire within reach. */
	const action = useCallback(() => {
		const self = chars.get(me);
		if (!self || !hello) return;
		const d = (o: ObjView) => Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y));
		const near = [...objs.values()].filter((o) => o.location === hello.room.roomId && d(o) <= 1);
		const item = near.filter((o) => o.kind === "item").sort((a, b) => d(a) - d(b))[0];
		if (item) return send(`get ${item.name}`);
		const fire = near.find((o) => o.kind === "beacon");
		const fuel = fuelIn(objs, me);
		if (fire && fuel) return send(`put ${fuel.name} in ${fire.name}`);
		append({ kind: "error", text: "Hier liegt nichts zum Aufheben.", from: "", at: Date.now() });
	}, [chars, me, hello, objs, send, append]);

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

	const logout = async () => { await post("/api/logout").catch(() => {}); onAccount(null); };

	return (
		<div className="game">
			<header className="bar">
				<span className="title">{hello?.world.title ?? "Leuchtfeuer"}</span>
				<button className="help-btn" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-label="Hilfe / Help" title="Hilfe / Help">?</button>
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
					<button onClick={() => { setMore(false); if (account.guest) setPanel("leave"); else void logout(); }}>Abmelden</button>
				</div>
			</header>
			{help && <HelpPanel onClose={() => setHelp(false)} />}
			{stale && <div className="stale" role="status">Neue Version des Spiels – die Seite lädt neu …</div>}
			<div className={`main${mapMode === "text" ? " text-only" : ""}`}>
				{atlas && atlas.rooms.length > 1 && <Atlas atlas={atlas} state={atlasState} />}
				{mapMode === "text" ? null : hello ? (
					<MapRenderer mode={mapMode} world={hello.world} room={hello.room} chars={chars} objs={objs} me={me} fog={fog}
						controls={<TouchPad hold={(d) => { input.current?.blur(); setMenu(null); hold(d); }} release={release} action={action} />}
						onCell={(x, y) => { input.current?.blur(); setMenu(null); step({ x, y }); }}
						onMenu={(x, y, left, top) => { input.current?.blur(); setMenu({ x, y, left, top }); }}
						onFail={(why) => { setMapMode(mapMode === "3d" ? "2d" : "text"); append({ kind: "error", text: `${why} ${mapMode === "3d" ? "Die 2D-Karte bleibt aktiv." : "Das Spiel läuft als Text weiter."}`, from: "", at: Date.now() }); }} />
				) : <div className="map"><p className="muted">Verbinde …</p></div>}
				{menu && hello && <CellMenu at={menu} chars={chars} objs={objs} self={chars.get(me)} room={hello.room.roomId} me={me} send={send} close={() => setMenu(null)} offer={account.guest ? undefined : (name) => { setPanel(null); setOfferTo(name); }} />}
				<aside className="side">
					{panel === "account" && (
						<div className="panel"><h2>Konto anlegen</h2><AccountForm guest onDone={(a) => { setPanel(null); onAccount(a); }} /></div>
					)}
					{panel === "leave" && (
						<div className="panel">
							<h2>Als Gast abmelden?</h2>
							<p style={{ margin: "0 0 10px", fontSize: 13 }}>Ohne Registrierung kommst du nicht zu dieser Figur zurück; sie verfällt nach einigen Tagen.</p>
							<div style={{ display: "flex", gap: 8 }}><button onClick={() => setPanel("account")}>Erst registrieren</button><button onClick={() => void logout()}>Trotzdem abmelden</button></div>
						</div>
					)}
					{!panel && (
						<div className="side-top">
							<Things objs={objs} self={chars.get(me)} room={hello?.room.roomId ?? ""} me={me} send={send} />
							{trade && hello && <TradePanel trade={trade} chars={chars} objs={objs} me={me} guest={account.guest} offerTo={offerTo} setOfferTo={setOfferTo} send={send} />}
						</div>
					)}
					<div className="log" role="log" aria-live="polite">
						{log.map((l, i) => <div key={i} className={`${l.kind}${"toMe" in l && l.toMe ? " to-me" : ""}`}>{l.text}{"ai" in l && l.ai ? <span className="ai-badge" title="Diese Figur spielt ein Sprachmodell">KI</span> : null}</div>)}
						<div ref={logEnd} />
					</div>
					<form className="cmd" onSubmit={(e) => { e.preventDefault(); const t = line.trim(); if (t) { send(t); setLine(""); } }}>
						<input ref={input} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onCommandKey} onFocus={() => release()} placeholder="Einfach lostippen: Befehl oder Satz, z. B. look, say Hallo · Esc oder Pfeiltaste: zurück zur Karte" maxLength={300} aria-label="Befehl" />
						<button className="primary">Senden</button>
					</form>
					<About />
				</aside>
			</div>
		</div>
	);
}
