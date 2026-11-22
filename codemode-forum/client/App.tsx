"use client";
// The forum's page. So far a room shows its run and the roll call with which every run opens: the models at the table,
// each under the name it has in this run (M1, M2, …), and what each said. The plan, its sections, the discussion and
// the ballots come with their phases (docs/gemeinsame-planung-plan-2026-11-22.en.md).
import { useEffect, useState } from "react";
import { AdminPanel } from "./AdminPanel.tsx";
import { ThemeControls } from "./ThemeControls.tsx";
import { useTheme } from "./lib/theme.ts";

type RunInfo = { active: boolean; runId: string; models: string[]; perModel: number; aliases: Record<string, string>; items: { open: number; done: number }; usage: { tokens: number; costUsd: number }; budget: { tokens?: number; usd?: number }; note?: string; ended?: "budget" };
type Answer = { runId: string; model: string; alias: string; agent: number; text: string; ts: number };
type Snapshot = { session: string; run: RunInfo | null; rollcall: Answer[]; lines: Array<{ text: string; ts: number }>; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number } };
type Models = { enabled: boolean; on: boolean; models: Array<{ id: string; label: string }> };
type System = { hosts: Array<{ name: string; roles: string[]; host: { cpu: string; cores: number; memGiB: number } }>; today: { calls: number; tokens: number; costUsd: number } };

const T = {
	de: {
		room: "Raum", live: "live", offline: "getrennt", off: "Modelle aus", models: "Modelle",
		run: "Lauf", pick: (min: number, max: number) => `Modelle am Tisch (${min} bis ${max})`, perModel: "Agenten je Modell", tokens: "Budget Tokens", usd: "Budget $",
		start: "Lauf starten", stop: "Stopp", none: "Keine Modelle verfügbar. Ein Admin schaltet sie frei (FORUM_LLM=1 und Zugangsdaten beim Modell-Prozess).",
		need: (n: number) => `Ein Lauf braucht mindestens ${n} verschiedene Modelle.`,
		lead: "Mindestens drei KI-Modelle entwickeln hier gemeinsam einen Plan. Bis die Planarbeit gebaut ist, besteht ein Lauf aus seinem Auftakt: dem Appell, bei dem sich jedes Modell am Tisch meldet.",
		rollcall: "Appell", waiting: "noch keine Antwort", active: "läuft", ended: "beendet", budgetUsed: "Budget verbraucht", items: (d: number, o: number) => `${d} erledigt, ${o} offen`,
		log: "Protokoll", empty: "Noch kein Lauf in diesem Raum.", hosts: "Prozesse", today: (c: number, t: number) => `heute ${c} Modellaufrufe, ${t} Tokens`,
	},
	en: {
		room: "room", live: "live", offline: "offline", off: "models off", models: "models",
		run: "Run", pick: (min: number, max: number) => `Models at the table (${min} to ${max})`, perModel: "Agents per model", tokens: "Budget tokens", usd: "Budget $",
		start: "Start run", stop: "Stop", none: "No models available. An admin allows them (FORUM_LLM=1 and credentials at the model process).",
		need: (n: number) => `A run needs at least ${n} different models.`,
		lead: "At least three AI models develop one plan together here. Until the plan work is built, a run is its opening alone: the roll call, in which every model at the table says that it is there.",
		rollcall: "Roll call", waiting: "no answer yet", active: "running", ended: "ended", budgetUsed: "budget used up", items: (d: number, o: number) => `${d} done, ${o} open`,
		log: "Log", empty: "No run in this room yet.", hosts: "Processes", today: (c: number, t: number) => `today ${c} model calls, ${t} tokens`,
	},
} as const;

async function api<R>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-forum-admin": "1" }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}

export function CodemodeForum() {
	const theme = useTheme();
	const lang = theme.lang, t = T[lang];
	const [room, setRoom] = useState("lobby");
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [live, setLive] = useState(false);
	const [models, setModels] = useState<Models | null>(null);
	const [system, setSystem] = useState<System | null>(null);
	const [chosen, setChosen] = useState<Set<string>>(new Set());
	const [perModel, setPerModel] = useState(1);
	const [budgetTokens, setBudgetTokens] = useState("100000");
	const [budgetUsd, setBudgetUsd] = useState("");
	const [admin, setAdmin] = useState(false);
	const [msg, setMsg] = useState("");
	const rid = encodeURIComponent(room);

	useEffect(() => {
		const fromHash = () => setRoom(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);

	useEffect(() => {
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		setSnap(null);
		const connect = () => {
			ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + rid);
			ws.onopen = () => setLive(true);
			// the backoff resets only once a snapshot arrived: a socket the server drops right after opening backs off too
			ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") { retry = 0; setSnap(d); } };
			ws.onclose = () => { setLive(false); if (!dead) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++)); };
		};
		connect();
		return () => { dead = true; clearTimeout(timer); ws?.close(); };
	}, [rid]);

	const loadModels = () => { api<Models>("/models").then(setModels).catch(() => {}); };
	useEffect(() => {
		let dead = false;
		const load = () => {
			api<Models>("/models").then((x) => { if (!dead) setModels(x); }).catch(() => {});
			api<System>("/system").then((x) => { if (!dead) setSystem(x); }).catch(() => {});
		};
		load();
		const timer = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(timer); };
	}, []);

	const available = models?.enabled && models.on ? models.models : [];
	const limits = snap?.limits ?? { minModels: 3, maxModels: 5, maxPerModel: 3, visitorTokens: 0 };
	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const run = snap?.run ?? null;
	const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };
	const start = () => act(() => api(`/rooms/${rid}/run`, { models: picked, perModel, lang, budgetTokens: budgetTokens || undefined, budgetUsd: budgetUsd || undefined }));
	const toggle = (label: string, add: boolean) => setChosen((cur) => { const n = new Set(cur); if (add) n.add(label); else n.delete(label); return n; });
	const answers = new Map((snap?.rollcall ?? []).map((a) => [a.model, a]));
	const table = run ? [...run.models].sort((a, b) => (run.aliases[a] ?? "").localeCompare(run.aliases[b] ?? "")) : [];

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE FORUM</b></span>
				<span className="spacer" />
				<span className="pill">{t.room}: {room}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				<span className="pill">{available.length ? `${available.length} ${t.models}` : t.off}</span>
				<ThemeControls lang={theme.lang} setLang={theme.setLang} mode={theme.mode} changeMode={theme.changeMode} palette={theme.palette} changePalette={theme.changePalette} />
			</header>
			<main>
				<aside>
					<div className="panel">
						<h2>{t.run}</h2>
						{available.length ? (
							<>
								<fieldset className="models">
									<legend>{t.pick(limits.minModels, limits.maxModels)}</legend>
									{available.map((m) => (
										<label key={m.label} className="check" title={m.label}>
											<input type="checkbox" checked={chosen.has(m.label)} disabled={!chosen.has(m.label) && picked.length >= limits.maxModels} onChange={(e) => toggle(m.label, e.target.checked)} />
											<span>{m.label}</span>
										</label>
									))}
								</fieldset>
								<div className="row">
									<label htmlFor="permodel">{t.perModel}</label>
									<input id="permodel" type="number" min={1} max={limits.maxPerModel} value={perModel} onChange={(e) => setPerModel(Math.min(limits.maxPerModel, Math.max(1, Number(e.target.value) || 1)))} />
								</div>
								<div className="row">
									<label htmlFor="btokens">{t.tokens}</label>
									<input id="btokens" type="number" min={1000} step={1000} style={{ width: 110 }} value={budgetTokens} onChange={(e) => setBudgetTokens(e.target.value)} />
									{admin ? <><label htmlFor="busd">{t.usd}</label><input id="busd" type="number" min={0} step={0.5} value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} /></> : null}
								</div>
								{picked.length < limits.minModels ? <div className="notice">{t.need(limits.minModels)}</div> : null}
								<div className="row">
									<button type="button" className="btn btn--primary" disabled={!!run?.active || picked.length < limits.minModels} onClick={() => void start()}>{t.start}</button>
									<button type="button" className="btn" disabled={!run?.active} onClick={() => void act(() => api(`/rooms/${rid}/stop`, {}))}>{t.stop}</button>
								</div>
							</>
						) : <div className="notice">{t.none}</div>}
						{msg ? <div className="notice">{msg}</div> : null}
					</div>
					<AdminPanel lang={lang} onChanged={loadModels} onSession={setAdmin} />
				</aside>
				<section>
					<div className="eyebrow">CODEMODE FORUM</div>
					<h1>{t.room} {room}</h1>
					<p className="lead">{t.lead}</p>
					{run ? (
						<div className="panel">
							<h2>{t.rollcall}</h2>
							<div className="runline">
								<span className={"pill" + (run.active ? " pill--accent" : "")}>{run.active ? t.active : t.ended}</span>
								<span className="pill">{t.items(run.items.done, run.items.open)}</span>
								<span className="pill">{run.usage.tokens.toLocaleString(lang === "de" ? "de-DE" : "en-US")}{run.budget.tokens ? ` / ${run.budget.tokens.toLocaleString(lang === "de" ? "de-DE" : "en-US")}` : ""} Tokens{run.usage.costUsd ? ` · $${run.usage.costUsd.toFixed(4)}` : ""}{run.budget.usd ? ` / $${run.budget.usd}` : ""}</span>
								{run.ended === "budget" ? <span className="pill">{t.budgetUsed}</span> : null}
							</div>
							{run.note ? <div className="notice">{run.note}</div> : null}
							<div className="answers">
								{table.map((model) => {
									const a = answers.get(model);
									return (
										<div key={model} className={"answer" + (a ? "" : " answer--waiting")}>
											<div className="answer__who"><b>{run.aliases[model]}</b><span>{model}</span></div>
											<div>{a ? a.text : t.waiting}</div>
										</div>
									);
								})}
							</div>
						</div>
					) : <div className="empty">{t.empty}</div>}
					{snap?.lines.length ? (
						<div className="panel">
							<h2>{t.log}</h2>
							<div className="timeline">
								{snap.lines.map((l, i) => <div key={`${l.ts}-${i}`} className="msg msg--system">{l.text}</div>)}
							</div>
						</div>
					) : null}
				</section>
			</main>
			{system?.hosts.length ? (
				<div className="system-bar" role="contentinfo">
					<span>{t.hosts}</span>
					{system.hosts.map((h) => <span key={h.name}><b>{h.name}</b> ({h.roles.join(", ")}) · {h.host.cores} vCPU · {h.host.memGiB} GiB</span>)}
					<span>{t.today(system.today.calls, system.today.tokens)}</span>
				</div>
			) : null}
		</>
	);
}
