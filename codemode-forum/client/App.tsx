"use client";
// The forum's page. A room holds plan tasks; each is a block with its document. A run works on one block: the roll
// call (the models at the table, each under the name it has in this run), then the outline and the first draft of
// every section by one of them. The page shows the run and the document, version by version. The discussion, the
// second table and the ballots come with their phases (docs/gemeinsame-planung-plan-2026-11-22.en.md).
import { useEffect, useMemo, useState } from "react";
import { AdminPanel } from "./AdminPanel.tsx";
import { ThemeControls } from "./ThemeControls.tsx";
import { renderSection } from "./lib/safe-markdown.ts";
import { useTheme } from "./lib/theme.ts";

type RunInfo = { active: boolean; runId: string; blockId: string; models: string[]; perModel: number; aliases: Record<string, string>; phase: "rollcall" | "outline" | "draft" | "done"; writer?: string; doc?: { table: string; version: number; sections: number; written: number }; items: { open: number; done: number }; usage: { tokens: number; costUsd: number }; budget: { tokens?: number; usd?: number }; note?: string; ended?: "budget" | "models" };
type Answer = { runId: string; model: string; alias: string; agent: number; text: string; ts: number };
type SectionRef = { sectionId: string; rev: number; title: string; bytes: number; author: string; model: string };
type Block = { blockId: string; brief: string; lang: "de" | "en"; outline: string[]; criteria: string[]; ts: number; doc: { table: string; version: number; versions: number; bytes: number; sections: SectionRef[] } | null };
type Snapshot = { session: string; blocks: Block[]; run: RunInfo | null; rollcall: Answer[]; lines: Array<{ text: string; ts: number }>; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number } };
type PlanView = { blockId: string; doc: { version: number; bytes: number; author: string; model: string; changed: string[]; ts: number; sections: Array<SectionRef & { text: string }> }; versions: Array<{ version: number; author: string; model: string; changed: string[]; ts: number }> };
type Models = { enabled: boolean; on: boolean; models: Array<{ id: string; label: string }> };
type System = { hosts: Array<{ name: string; roles: string[]; host: { cpu: string; cores: number; memGiB: number } }>; today: { calls: number; tokens: number; costUsd: number } };

const T = {
	de: {
		room: "Raum", live: "live", offline: "getrennt", off: "Modelle aus", models: "Modelle",
		task: "Planaufgabe", brief: "Auftrag: wofür ist der Plan, was muss er leisten?", docLang: "Sprache des Dokuments", outline: "Gliederung vorgeben (optional, eine Überschrift je Zeile)", criteria: "Eigene Kriterien (optional, eines je Zeile)", create: "Aufgabe anlegen",
		run: "Lauf", on: "Aufgabe", pick: (min: number, max: number) => `Modelle am Tisch (${min} bis ${max})`, perModel: "Agenten je Modell", tokens: "Budget Tokens", usd: "Budget $",
		start: "Lauf starten", stop: "Stopp", none: "Keine Modelle verfügbar. Ein Admin schaltet sie frei (FORUM_LLM=1 und Zugangsdaten beim Modell-Prozess).",
		need: (n: number) => `Ein Lauf braucht mindestens ${n} verschiedene Modelle.`, noTask: "Lege zuerst eine Planaufgabe an.",
		lead: "Mindestens drei KI-Modelle entwickeln hier gemeinsam einen Plan. Bisher: Nach dem Appell schreibt eines von ihnen die Gliederung und den ersten Entwurf jedes Abschnitts. Die gemeinsame Arbeit daran (Diskussion, Prüfung, Abstimmung) folgt.",
		table: "Am Tisch", waiting: "noch keine Antwort", active: "läuft", ended: "beendet", budgetUsed: "Budget verbraucht", fewModels: "zu wenige Modelle", items: (d: number, o: number) => `${d} erledigt, ${o} offen`,
		phase: { rollcall: "Appell", outline: "Gliederung", draft: "Entwurf", done: "Entwurf fertig" }, written: (w: number, n: number) => `${w} von ${n} Abschnitten geschrieben`, writer: "schreibt",
		doc: "Dokument", noDoc: "Noch kein Dokument. Es beginnt mit dem ersten Lauf auf dieser Aufgabe.", version: "Fassung", newest: "neueste", by: "von", rev: "Rev.", changed: "geändert", markdown: "Markdown", intent: "noch nicht geschrieben; soll sagen:",
		tasks: "Aufgaben", log: "Protokoll", empty: "Noch keine Planaufgabe in diesem Raum.", hosts: "Prozesse", today: (c: number, t: number) => `heute ${c} Modellaufrufe, ${t} Tokens`,
	},
	en: {
		room: "room", live: "live", offline: "offline", off: "models off", models: "models",
		task: "Plan task", brief: "Brief: what is the plan for, what must it achieve?", docLang: "Language of the document", outline: "Fix the outline (optional, one heading a line)", criteria: "Criteria of your own (optional, one a line)", create: "Create task",
		run: "Run", on: "Task", pick: (min: number, max: number) => `Models at the table (${min} to ${max})`, perModel: "Agents per model", tokens: "Budget tokens", usd: "Budget $",
		start: "Start run", stop: "Stop", none: "No models available. An admin allows them (FORUM_LLM=1 and credentials at the model process).",
		need: (n: number) => `A run needs at least ${n} different models.`, noTask: "Create a plan task first.",
		lead: "At least three AI models develop one plan together here. So far: after the roll call one of them writes the outline and the first draft of every section. The joint work on it (discussion, review, ballots) follows.",
		table: "At the table", waiting: "no answer yet", active: "running", ended: "ended", budgetUsed: "budget used up", fewModels: "too few models", items: (d: number, o: number) => `${d} done, ${o} open`,
		phase: { rollcall: "roll call", outline: "outline", draft: "draft", done: "draft written" }, written: (w: number, n: number) => `${w} of ${n} sections written`, writer: "writes",
		doc: "Document", noDoc: "No document yet. It begins with the first run on this task.", version: "Version", newest: "newest", by: "by", rev: "rev.", changed: "changed", markdown: "Markdown", intent: "not written yet; it is to say:",
		tasks: "Tasks", log: "Log", empty: "No plan task in this room yet.", hosts: "Processes", today: (c: number, t: number) => `today ${c} model calls, ${t} tokens`,
	},
} as const;

async function api<R>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json", "x-forum-admin": "1" }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}
const firstLine = (s: string, max = 90) => { const l = s.split("\n")[0]!; return l.length > max ? l.slice(0, max) + "…" : l; };

export function CodemodeForum() {
	const theme = useTheme();
	const lang = theme.lang, t = T[lang], locale = lang === "de" ? "de-DE" : "en-US";
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
	const [brief, setBrief] = useState("");
	const [docLang, setDocLang] = useState<"de" | "en" | "">("");
	const [outline, setOutline] = useState("");
	const [criteria, setCriteria] = useState("");
	const [focus, setFocus] = useState<string | null>(null); // the block shown; null: the newest
	const [version, setVersion] = useState<number | null>(null); // the version shown; null: the newest
	const [view, setView] = useState<PlanView | null>(null);
	const rid = encodeURIComponent(room);

	useEffect(() => {
		const fromHash = () => setRoom(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);

	useEffect(() => {
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		setSnap(null); setFocus(null); setVersion(null); setView(null);
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

	const blocks = snap?.blocks ?? [];
	const block = blocks.find((b) => b.blockId === focus) ?? blocks.at(-1) ?? null;
	const headVersion = block?.doc?.version ?? 0;
	// the document's texts are fetched when the block, the chosen version or the newest version changes
	useEffect(() => {
		if (!block || !headVersion) { setView(null); return; }
		let dead = false;
		api<PlanView>(`/rooms/${rid}/plan/${block.blockId}${version ? `?version=${version}` : ""}`).then((x) => { if (!dead) setView(x); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, block?.blockId, headVersion, version]);

	const available = models?.enabled && models.on ? models.models : [];
	const limits = snap?.limits ?? { minModels: 3, maxModels: 5, maxPerModel: 3, visitorTokens: 0 };
	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const run = snap?.run ?? null;
	const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };
	const create = () => act(async () => {
		const r = await api<{ blockId: string }>(`/rooms/${rid}/task`, { brief, lang: docLang || lang, outline, criteria });
		setBrief(""); setOutline(""); setCriteria(""); setFocus(r.blockId); setVersion(null);
	});
	const start = () => act(() => api(`/rooms/${rid}/run`, { blockId: block?.blockId, models: picked, perModel, budgetTokens: budgetTokens || undefined, budgetUsd: budgetUsd || undefined }));
	const toggle = (label: string, add: boolean) => setChosen((cur) => { const n = new Set(cur); if (add) n.add(label); else n.delete(label); return n; });
	const answers = new Map((snap?.rollcall ?? []).map((a) => [a.model, a]));
	const table = run ? [...run.models].sort((a, b) => (run.aliases[a] ?? "").localeCompare(run.aliases[b] ?? "")) : [];
	const runHere = run && block && run.blockId === block.blockId ? run : null;
	const html = useMemo(() => (view?.doc.sections ?? []).map((s) => ({ ...s, html: renderSection(s.text) })), [view]);
	const name = (model: string) => (runHere?.aliases[model] ? `${runHere.aliases[model]} · ${model}` : model);

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
						<h2>{t.task}</h2>
						<textarea className="task-field" rows={5} maxLength={8000} placeholder={t.brief} aria-label={t.brief} value={brief} onChange={(e) => setBrief(e.target.value)} />
						<div className="row">
							<label htmlFor="doclang">{t.docLang}</label>
							<select id="doclang" value={docLang || lang} onChange={(e) => setDocLang(e.target.value as "de" | "en")}><option value="de">Deutsch</option><option value="en">English</option></select>
						</div>
						<details>
							<summary>{t.outline}</summary>
							<textarea rows={4} aria-label={t.outline} value={outline} onChange={(e) => setOutline(e.target.value)} />
						</details>
						<details>
							<summary>{t.criteria}</summary>
							<textarea rows={3} aria-label={t.criteria} value={criteria} onChange={(e) => setCriteria(e.target.value)} />
						</details>
						<div className="row"><button type="button" className="btn btn--primary" disabled={brief.trim().length < 20} onClick={() => void create()}>{t.create}</button></div>
					</div>
					<div className="panel">
						<h2>{t.run}</h2>
						{!block ? <div className="notice">{t.noTask}</div> : available.length ? (
							<>
								<div className="fieldlabel"><span>{t.on}:</span> <span className="muted">{firstLine(block.brief, 60)}</span></div>
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
					{blocks.length > 1 ? (
						<div className="tasks" role="tablist" aria-label={t.tasks}>
							{blocks.map((b) => <button key={b.blockId} type="button" role="tab" aria-selected={b.blockId === block?.blockId} className={"tasks__tab" + (b.blockId === block?.blockId ? " is-active" : "")} onClick={() => { setFocus(b.blockId); setVersion(null); }}>{firstLine(b.brief, 48)}</button>)}
						</div>
					) : null}
					{block ? (
						<>
							<div className="panel">
								<h2>{t.task}</h2>
								<p className="briefing">{block.brief}</p>
								{block.criteria.length ? <ul className="criteria">{block.criteria.map((c) => <li key={c}>{c}</li>)}</ul> : null}
							</div>
							{runHere ? (
								<div className="panel">
									<h2>{t.run}</h2>
									<div className="runline">
										<span className={"pill" + (runHere.active ? " pill--accent" : "")}>{runHere.active ? t.active : t.ended}</span>
										<span className="pill">{t.phase[runHere.phase]}</span>
										{runHere.doc ? <span className="pill">{t.written(runHere.doc.written, runHere.doc.sections)}</span> : null}
										<span className="pill">{t.items(runHere.items.done, runHere.items.open)}</span>
										<span className="pill">{runHere.usage.tokens.toLocaleString(locale)}{runHere.budget.tokens ? ` / ${runHere.budget.tokens.toLocaleString(locale)}` : ""} Tokens{runHere.usage.costUsd ? ` · $${runHere.usage.costUsd.toFixed(4)}` : ""}{runHere.budget.usd ? ` / $${runHere.budget.usd}` : ""}</span>
										{runHere.ended ? <span className="pill">{runHere.ended === "budget" ? t.budgetUsed : t.fewModels}</span> : null}
									</div>
									{runHere.note ? <div className="notice">{runHere.note}</div> : null}
									<div className="fieldlabel">{t.table}</div>
									<div className="answers">
										{table.map((model) => {
											const a = answers.get(model);
											return (
												<div key={model} className={"answer" + (a ? "" : " answer--waiting")}>
													<div className="answer__who"><b>{runHere.aliases[model]}</b><span>{model}{runHere.writer === model ? ` · ${t.writer}` : ""}</span></div>
													<div>{a ? a.text : t.waiting}</div>
												</div>
											);
										})}
									</div>
								</div>
							) : null}
							<div className="panel">
								<h2>{t.doc}</h2>
								{block.doc && view && view.blockId === block.blockId ? (
									<>
										<div className="runline">
											<label htmlFor="version" className="muted">{t.version}</label>
											<select id="version" value={version ?? ""} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)}>
												<option value="">{t.newest} ({block.doc.version})</option>
												{[...view.versions].reverse().map((v) => <option key={v.version} value={v.version}>{v.version} · {name(v.model)}</option>)}
											</select>
											<span className="pill">{(view.doc.bytes / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB</span>
											<a className="toplink" href={`/api/rooms/${rid}/plan/${block.blockId}.md`} target="_blank" rel="noreferrer">{t.markdown}</a>
										</div>
										<article className="doc">
											{html.map((s) => (
												<section key={s.sectionId} className={view.doc.changed.includes(s.sectionId) ? "doc__section is-changed" : "doc__section"}>
													<h3>{s.title} <span className="muted">{t.rev} {s.rev} · {name(s.model)}{view.doc.changed.includes(s.sectionId) ? ` · ${t.changed}` : ""}</span></h3>
													{s.rev === 1 ? <p className="muted">{t.intent} {s.text}</p> : <div dangerouslySetInnerHTML={{ __html: s.html }} />}
												</section>
											))}
										</article>
									</>
								) : <div className="empty">{t.noDoc}</div>}
							</div>
						</>
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
