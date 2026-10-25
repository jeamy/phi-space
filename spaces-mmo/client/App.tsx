"use client";
// spaces-mmo in the browser: a welcome page (play as a guest, log in, register) and the game: the PixiJS map of the
// room, the text log and the command line. Everything the player does is a text command sent over the WebSocket; a
// tap on the map or an arrow key becomes `move x y` for one step. All text from the world is rendered as React text nodes.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CharView, MsgView, ObjView, ServerFrame } from "../server/gateway.ts";
import { MapView } from "./MapView.tsx";
import { HelpPanel } from "./HelpPanel.tsx";

type Account = { name: string; guest: boolean; admin: boolean };
type Hello = Extract<ServerFrame, { t: "hello" }>;
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
function CellMenu({ at, chars, objs, self, room, me, send, close }: { at: { x: number; y: number; left: number; top: number }; chars: Map<string, CharView>; objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void; close: () => void }) {
	useEffect(() => {
		const key = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
		window.addEventListener("keydown", key);
		return () => window.removeEventListener("keydown", key);
	}, [close]);
	const reach = !!self && Math.max(Math.abs(at.x - self.x), Math.abs(at.y - self.y)) <= 1;
	const fuel = [...objs.values()].find((o) => o.kind === "item" && o.location === me && o.name === "Treibholz");
	const entries: Array<{ label: string; line: string }> = [];
	for (const c of chars.values()) if (c.x === at.x && c.y === at.y && c.charId !== me) entries.push({ label: `${c.name} ansehen`, line: `look ${c.name}` });
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
				{entries.map((e) => <li key={e.line} role="menuitem"><button onClick={() => { send(e.line); close(); }}>{e.label}</button></li>)}
			</ul>
		</>
	);
}

/** What the player carries and what lies within reach, as buttons (on a phone there is no keyboard to type with). */
function Things({ objs, self, room, me, send }: { objs: Map<string, ObjView>; self: CharView | undefined; room: string; me: string; send: (line: string) => void }) {
	const all = [...objs.values()].filter((o) => o.kind === "item");
	const carried = all.filter((o) => o.location === me);
	const close = (o: ObjView) => !!self && o.location === room && Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y)) <= 1;
	const near = all.filter(close);
	const fire = [...objs.values()].find((o) => o.kind === "beacon" && close(o));
	const fuel = carried.find((o) => o.name === "Treibholz");
	// the burn time left counts down while a fire is near
	const [, tick] = useState(0);
	useEffect(() => { if (!fire) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [fire?.id]);
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
			{carried.length > 0 && <><h3>Du trägst</h3><ul>{carried.map((o) => row(o, "drop", "Ablegen"))}</ul></>}
		</div>
	);
}

function Game({ account, onAccount }: { account: Account; onAccount: (a: Account | null) => void }) {
	const [hello, setHello] = useState<Hello | null>(null);
	const [chars, setChars] = useState<Map<string, CharView>>(new Map());
	const [objs, setObjs] = useState<Map<string, ObjView>>(new Map());
	const [fog, setFog] = useState(0);
	const [log, setLog] = useState<Line[]>([]);
	const [live, setLive] = useState(false);
	const [line, setLine] = useState("");
	const [panel, setPanel] = useState<null | "account" | "leave">(null);
	const [help, setHelp] = useState(false);
	const [stale, setStale] = useState(false);
	// text only: by choice (remembered in this browser) or because the map cannot draw (no WebGL)
	const [textOnly, setTextOnly] = useState(() => { try { return localStorage.getItem("mmo.textOnly") === "1"; } catch { return false; } });
	const [menu, setMenu] = useState<null | { x: number; y: number; left: number; top: number }>(null);
	const toggleText = () => setTextOnly((v) => { try { localStorage.setItem("mmo.textOnly", v ? "0" : "1"); } catch { /* private window */ } return !v; });
	const ws = useRef<WebSocket | null>(null);
	const logEnd = useRef<HTMLDivElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const me = hello?.me.charId ?? "";

	const append = useCallback((l: Line) => setLog((old) => (old.length >= 300 ? [...old.slice(-299), l] : [...old, l])), []);

	// the game socket; it reconnects with a backoff, and a socket refused for a lapsed login logs out
	useEffect(() => {
		let dead = false, retry = 0, timer: ReturnType<typeof setTimeout> | undefined, greeted = false;
		const connect = () => {
			const s = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws");
			ws.current = s;
			s.onopen = () => setLive(true);
			s.onmessage = (e) => {
				const f = JSON.parse(String(e.data)) as ServerFrame;
				if (f.t === "hello") {
					// the server runs a newer build than this page: reload, so the page understands what it is sent
					if (pageBuild && f.build && f.build !== pageBuild) { setStale(true); setTimeout(() => location.reload(), 1500); return; }
					retry = 0; setHello(f);
					setChars(new Map(f.chars.map((c) => [c.charId, c])));
					setObjs(new Map(f.objs.map((o) => [o.id, o])));
					setFog(f.fog);
					// the first hello brings the room's recent talk; a later one (another room, a reconnect) keeps the log
					if (!greeted) setLog(f.log); else append({ kind: "echo", text: `— ${f.room.name} —`, from: "", at: Date.now() });
					greeted = true;
				}
				else if (f.t === "char") setChars((m) => new Map(m).set(f.c.charId, f.c));
				else if (f.t === "gone") setChars((m) => { const n = new Map(m); n.delete(f.charId); return n; });
				else if (f.t === "obj") setObjs((m) => new Map(m).set(f.o.id, f.o));
				else if (f.t === "fog") setFog(f.level);
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
		return () => { dead = true; clearTimeout(timer); ws.current?.close(); };
	}, [append, onAccount]);

	useEffect(() => { logEnd.current?.scrollIntoView({ block: "end" }); }, [log]);

	const send = useCallback((text: string, echo = true) => {
		const s = ws.current;
		if (!s || s.readyState !== WebSocket.OPEN) { append({ kind: "error", text: "Nicht verbunden; ein Moment …", from: "", at: Date.now() }); return; }
		s.send(JSON.stringify({ t: "cmd", line: text }));
		if (echo) append({ kind: "echo", text: `> ${text}`, from: "", at: Date.now() });
	}, [append]);

	/** One step from the own character: by `d`, or toward a tapped cell (the longer axis first; if that cell is not
	 *  walkable, the other axis). A tap walks exactly like an arrow key, one cell per tap. */
	const step = useCallback((d: [number, number] | { x: number; y: number }) => {
		const self = chars.get(me);
		if (!self || !hello) return;
		// walkable and nobody standing there (the server checks again; this only picks the better of two directions)
		const taken = new Set([...[...chars.values()].filter((c) => c.charId !== me), ...[...objs.values()].filter((o) => o.kind === "beacon" && o.location === hello.room.roomId)].map((c) => `${c.x},${c.y}`));
		const free = (x: number, y: number) => !!hello.world.tiles[hello.room.ground[y]?.[x] ?? ""]?.walk && !taken.has(`${x},${y}`);
		let moves: Array<[number, number]>;
		if (Array.isArray(d)) moves = [d];
		else {
			const dx = Math.sign(d.x - self.x), dy = Math.sign(d.y - self.y);
			if (!dx && !dy) return;
			const horizontal = Math.abs(d.x - self.x) >= Math.abs(d.y - self.y);
			moves = (horizontal ? [[dx, 0], [0, dy]] : [[0, dy], [dx, 0]] as Array<[number, number]>).filter(([a, b]) => a || b) as Array<[number, number]>;
		}
		const go = moves.find(([a, b]) => free(self.x + a, self.y + b)) ?? moves[0]!;
		// relative: the server steps from where the character really is, not from where this page last saw it
		send(`step ${go[0]} ${go[1]}`, false);
	}, [chars, objs, me, hello, send]);

	/** Space: pick up what lies nearest (the own cell first); with nothing there, feed a fire within reach. */
	const action = useCallback(() => {
		const self = chars.get(me);
		if (!self || !hello) return;
		const d = (o: ObjView) => Math.max(Math.abs(o.x - self.x), Math.abs(o.y - self.y));
		const near = [...objs.values()].filter((o) => o.location === hello.room.roomId && d(o) <= 1);
		const item = near.filter((o) => o.kind === "item").sort((a, b) => d(a) - d(b))[0];
		if (item) return send(`get ${item.name}`);
		const fire = near.find((o) => o.kind === "beacon");
		const fuel = [...objs.values()].find((o) => o.kind === "item" && o.location === me && o.name === "Treibholz");
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
		step(d);
	};

	// arrow keys walk, space picks up, unless the command line has the focus
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (document.activeElement === input.current || (e.target as HTMLElement)?.tagName === "INPUT") return;
			if (e.key === "Enter") { e.preventDefault(); input.current?.focus(); return; }
			if (e.key === " ") { e.preventDefault(); if (!e.repeat) action(); return; }
			const d = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[e.key];
			if (!d) return;
			e.preventDefault();
			step(d);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [step, action]);

	const logout = async () => { await post("/api/logout").catch(() => {}); onAccount(null); };

	return (
		<div className="game">
			<header className="bar">
				<span className="title">{hello?.world.title ?? "Leuchtfeuer"}</span>
				<button className="help-btn" onClick={() => setHelp((h) => !h)} aria-expanded={help} aria-label="Hilfe / Help" title="Hilfe / Help">?</button>
				<span className={`live${live ? " on" : ""}`} title={live ? "verbunden" : "getrennt"} />
				<span>{hello?.room.name ?? ""}</span>
				<span className="spacer" />
				<span>{account.name}</span>
				{account.guest && <span className="badge">Gast</span>}
				{account.guest && <button onClick={() => setPanel(panel === "account" ? null : "account")}>Registrieren, um den Fortschritt zu behalten</button>}
				<button onClick={toggleText} aria-pressed={textOnly}>{textOnly ? "Karte zeigen" : "Nur Text"}</button>
				<button onClick={() => (account.guest ? setPanel("leave") : void logout())}>Abmelden</button>
			</header>
			{help && <HelpPanel onClose={() => setHelp(false)} />}
			{stale && <div className="stale" role="status">Neue Version des Spiels – die Seite lädt neu …</div>}
			<div className={`main${textOnly ? " text-only" : ""}`}>
				{textOnly ? null : hello ? (
					<MapView world={hello.world} room={hello.room} chars={chars} objs={objs} me={me} fog={fog}
						onCell={(x, y) => { input.current?.blur(); setMenu(null); step({ x, y }); }}
						onMenu={(x, y, left, top) => { input.current?.blur(); setMenu({ x, y, left, top }); }}
						onFail={(why) => { setTextOnly(true); append({ kind: "error", text: why, from: "", at: Date.now() }); }} />
				) : <div className="map"><p className="muted">Verbinde …</p></div>}
				{menu && hello && <CellMenu at={menu} chars={chars} objs={objs} self={chars.get(me)} room={hello.room.roomId} me={me} send={send} close={() => setMenu(null)} />}
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
					{!panel && <Things objs={objs} self={chars.get(me)} room={hello?.room.roomId ?? ""} me={me} send={send} />}
					<div className="log" role="log" aria-live="polite">
						{log.map((l, i) => <div key={i} className={l.kind}>{l.text}</div>)}
						<div ref={logEnd} />
					</div>
					<form className="cmd" onSubmit={(e) => { e.preventDefault(); const t = line.trim(); if (t) { send(t); setLine(""); } }}>
						<input ref={input} value={line} onChange={(e) => setLine(e.target.value)} onKeyDown={onCommandKey} placeholder="Enter: Befehl tippen, z. B. look, say Hallo · Esc oder Pfeiltaste: zurück zur Karte" maxLength={300} aria-label="Befehl" />
						<button className="primary">Senden</button>
					</form>
					<About />
				</aside>
			</div>
		</div>
	);
}
