"use client";
// Codemode chat UI: the Space-Chat workbench layout of the help system (task and run controls left, the
// conversation in the middle, ranking and best code right), for contributions of code. Every task is its own
// collapsible block in the conversation: its agents are square tiles, their code unfolds on a click, and the
// ranking and best code on the right follow the block that is open or clicked. All text is rendered as React text
// nodes: agent code is untrusted data and never becomes markup.
import { useCallback, useEffect, useRef, useState } from "react";
import { ThemeControls } from "./ThemeControls.tsx";
import { useTheme, type Lang } from "./lib/theme.ts";

type L = { de: string; en: string };
type Contribution = { candidateId: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; source: string; ts: number };
type Message = { author: string; text: string; ts: number; blockId?: string };
type Best = { candidateId: string; ms: number; source: string };
type Block = { blockId: string; ts: number; active: boolean; task: { id: string; fn: string; title: L; prompt: L; cases?: number }; contributions: Contribution[]; best: Best | null; messages: Message[] };
type Snapshot = {
	session: string; current: string; tasks: { id: string; title: L; fn: string; prompt: L }[]; blocks: Block[]; messages: Message[];
	run: { active: boolean; blockId: string; mode: string; contenders?: string[]; gen: number; gens: number; agents: number; perAgent: number; note?: string } | null;
};
type Llm = { enabled: boolean; on: boolean; current: string | null; models: { id: string; label: string }[] };
type Shard = { shard: string; up: boolean; host: { name: string; cpu: string; cores: number; memGiB: number } | null; judged: number | null };

const T = {
	de: { title: "Codemode-Chat", eyebrow: "AGENTEN UND MENSCHEN SCHREIBEN CODE IN EINEN GEMEINSAMEN SPACE", lead: "Jede Aufgabe ist ein Block; jeder Beitrag ein Eintrag im Space, den die Codemode-Sandbox bewertet. Ein Klick auf eine Kachel zeigt den gelieferten Code.", task: "Aufgabe", custom: "Eigene Aufgabe …", fn: "Funktionsname", taskText: "Beschreibung der Aufgabe (was soll die Funktion tun?)", cases: "Testfälle (JSON: [{\"args\":[2],\"expect\":4}])", newTask: "Aufgabe anlegen (ohne Agenten)", agentsZero: "0 Agenten: nur den Aufgabenblock anlegen, Code reichst du selbst ein", run: "Lauf", agents: "Agenten", gens: "Generationen", per: "Beiträge je Agent", contenders: "Teilnehmer (Mehrfachauswahl)", scriptedAgents: "Skript-Agenten", noModels: "Modell-Agenten sind aus (CODEMODE_CHAT_LLM=1)", autoModel: "Eigene Aufgabe: Modell-Agenten automatisch gewählt (Skript-Agenten haben dafür keinen Code).", start: "Lauf starten", stop: "Stoppen", pick: "Mindestens ein Teilnehmer", fillCustom: "Funktionsname, Beschreibung und Testfälle ausfüllen", yours: "Eigener Code", submit: "Code einreichen", board: "Rangliste", best: "Bester Code", standings: "Wertung je Teilnehmer", none: "Noch keine Beiträge.", wait: "wartet", ok: "korrekt", bad: "falsch", code: "Code", gen: "Gen.", live: "live", offline: "getrennt", session: "Raum", off: "Modell-Agenten aus", llm: "Modell", nobest: "keine korrekten Beiträge", test: "Testsystem", judged: "bewertet", down: "nicht erreichbar", versus: "gegeneinander", correctN: "korrekt", helpLink: "Hilfe", contributions: "Beiträge", running: "läuft", block: "Aufgabe", del: "Block löschen", delRunning: "Der Lauf in diesem Block muss zuerst gestoppt werden", delTitle: "Aufgabenblock löschen?", delText: (title: string, n: number) => `Der Block „${title}“ mit ${n} Beiträgen, Rangliste und bestem Code wird dauerhaft gelöscht.`, yes: "Ja, löschen", no: "Nein", forBlock: "für", hide: "Schließen", noBlocks: "Noch keine Aufgabe." },
	en: { title: "Codemode chat", eyebrow: "AGENTS AND PEOPLE WRITE CODE INTO A SHARED SPACE", lead: "Every task is a block; every contribution an entry in the space that the codemode sandbox judges. Click a tile to see the code it delivered.", task: "Task", custom: "Custom task …", fn: "Function name", taskText: "Task description (what should the function do?)", cases: "Test cases (JSON: [{\"args\":[2],\"expect\":4}])", newTask: "Create task (no agents)", agentsZero: "0 agents: only create the task block, you hand in the code yourself", run: "Run", agents: "Agents", gens: "Generations", per: "Contributions per agent", contenders: "Contenders (multi-select)", scriptedAgents: "Scripted agents", noModels: "Model agents are off (CODEMODE_CHAT_LLM=1)", autoModel: "Custom task: model agents selected automatically (scripted agents have no code for it).", start: "Start run", stop: "Stop", pick: "Pick at least one contender", fillCustom: "Fill in function name, description and test cases", yours: "Your code", submit: "Submit code", board: "Leaderboard", best: "Best code", standings: "Standings per contender", none: "No contributions yet.", wait: "waiting", ok: "correct", bad: "wrong", code: "code", gen: "gen", live: "live", offline: "disconnected", session: "Room", off: "model agents off", llm: "model", nobest: "no correct contribution", test: "Test system", judged: "judged", down: "unreachable", versus: "versus", correctN: "correct", helpLink: "Help", contributions: "contributions", running: "running", block: "Task", del: "Delete block", delRunning: "Stop the run in this block first", delTitle: "Delete task block?", delText: (title: string, n: number) => `The block "${title}" with ${n} contributions, its ranking and best code will be deleted permanently.`, yes: "Yes, delete", no: "No", forBlock: "for", hide: "Close", noBlocks: "No task yet." },
} as const;
type Tr = (typeof T)[Lang];

const store = (k: string, v?: string): string | null => { try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); return v; } catch { return null; } };
async function api<R = unknown>(path: string, body?: unknown): Promise<R> {
	const r = await fetch("/api" + path, body === undefined ? undefined : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	const data = await r.json().catch(() => ({}));
	if (!r.ok) throw new Error((data as { error?: string }).error || r.statusText);
	return data as R;
}
const shortCpu = (cpu: string) => cpu.replace(/\((R|TM)\)/g, "").replace(/\b(\d+-Core )?Processor\b/i, "").replace(/\s+/g, " ").trim();
const shortVia = (via: string) => via.replace(/^[^/]+\//, "").replace(/-\d{8}$/, "");

function Tile({ c, isBest, open, onClick, t }: { c: Contribution; isBest: boolean; open: boolean; onClick: () => void; t: Tr }) {
	const state = c.ok === null ? "wait" : c.ok ? "ok" : "bad";
	return (
		<button type="button" className={`tile tile--${state}${isBest ? " tile--best" : ""}${open ? " tile--open" : ""}`} aria-expanded={open} onClick={onClick} title={c.error}>
			<span className="tile__who">{c.author}</span>
			<span className="tile__via">{shortVia(c.via)}</span>
			<span className="tile__result">{c.ok === null ? "…" : c.ok ? `${c.ms} ms` : "✗"}</span>
			<span className="tile__meta">{c.gen ? `${t.gen} ${c.gen}` : ""}{c.host ? ` · ${c.host}` : ""}</span>
			{isBest ? <span className="tile__star" aria-label="best">★</span> : null}
		</button>
	);
}

/** Themed yes/no dialog (instead of window.confirm): focus starts on "No", Escape and a click outside answer "No". */
function ConfirmDialog({ title, text, yes, no, onYes, onNo }: { title: string; text: string; yes: string; no: string; onYes: () => void; onNo: () => void }) {
	const noRef = useRef<HTMLButtonElement>(null), yesRef = useRef<HTMLButtonElement>(null);
	useEffect(() => {
		const before = document.activeElement as HTMLElement | null;
		noRef.current?.focus();
		return () => before?.focus?.();
	}, []);
	return (
		<div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onNo(); }}>
			<div className="modal" role="alertdialog" aria-modal="true" aria-labelledby="dlg-title" aria-describedby="dlg-text"
				onKeyDown={(e) => {
					if (e.key === "Escape") { e.preventDefault(); onNo(); }
					if (e.key === "Tab") { e.preventDefault(); (document.activeElement === noRef.current ? yesRef : noRef).current?.focus(); } // two buttons: Tab cycles inside the dialog
				}}>
				<h2 id="dlg-title">{title}</h2>
				<p id="dlg-text">{text}</p>
				<div className="modal__actions">
					<button ref={noRef} type="button" className="btn" onClick={onNo}>{no}</button>
					<button ref={yesRef} type="button" className="btn btn--danger" onClick={onYes}>{yes}</button>
				</div>
			</div>
		</div>
	);
}

function BlockView({ b, open, focused, run, openCode, onToggle, onFocus, onCode, onDelete, t, lang }: { b: Block; open: boolean; focused: boolean; run: Snapshot["run"]; openCode: Set<string>; onToggle: () => void; onFocus: () => void; onCode: (id: string) => void; onDelete: () => void; t: Tr; lang: Lang }) {
	const done = b.contributions.filter((c) => c.ok !== null).length, ok = b.contributions.filter((c) => c.ok).length;
	const running = run?.active && run.blockId === b.blockId;
	const opened = b.contributions.filter((c) => openCode.has(c.candidateId));
	return (
		<section className={`block${focused ? " block--focus" : ""}${b.active ? " block--active" : ""}`}>
			<div className="block__bar">
			<button type="button" className="block__head" aria-expanded={open} onClick={() => { onToggle(); onFocus(); }}>
				<span className="block__caret">{open ? "▾" : "▸"}</span>
				<span className="block__title">{b.task.title[lang]} <code>{b.task.fn}</code></span>
				<span className="chip">{b.contributions.length} {t.contributions}</span>
				<span className="chip chip--ok">{ok}/{done} {t.correctN}</span>
				{b.best ? <span className="chip chip--best">★ {b.best.ms} ms</span> : null}
				{running ? <span className="chip chip--wait">{t.running} · {run!.gen}/{run!.gens}</span> : null}
			</button>
			<button type="button" className="block__del" disabled={!!running} title={running ? t.delRunning : t.del} aria-label={t.del} onClick={onDelete}>🗑</button>
			</div>
			{open ? (
				<div className="block__body" onClick={onFocus}>
					<p className="lead">{b.task.prompt[lang]}</p>
					{b.messages.length ? <div className="block__log">{b.messages.map((m, i) => <div key={i}>{m.text}</div>)}</div> : null}
					{b.contributions.length ? (
						<div className="tiles">
							{b.contributions.map((c) => <Tile key={c.candidateId} c={c} t={t} isBest={b.best?.candidateId === c.candidateId} open={openCode.has(c.candidateId)} onClick={() => onCode(c.candidateId)} />)}
						</div>
					) : <div className="empty">{t.none}</div>}
					{opened.map((c) => (
						<div key={c.candidateId} className="codecard">
							<div className="codecard__head">
								<b>{c.author}</b> <span className="chip">{c.via}</span>
								{c.ok === null ? <span className="chip chip--wait">{t.wait}</span> : c.ok ? <span className="chip chip--ok">{t.ok} · {c.ms} ms</span> : <span className="chip chip--bad">{t.bad}</span>}
								<span className="spacer" />
								<button type="button" className="btn" onClick={() => onCode(c.candidateId)}>{t.hide}</button>
							</div>
							{c.error ? <div className="err">{c.error}</div> : null}
							<pre className="code">{c.source}</pre>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}

export function CodemodeChat() {
	const theme = useTheme();
	const { lang } = theme;
	const [name, setName] = useState("guest");
	const [session, setSession] = useState("lobby");
	const [snap, setSnap] = useState<Snapshot | null>(null);
	const [live, setLive] = useState(false);
	const [llm, setLlm] = useState<Llm | null>(null);
	const [shards, setShards] = useState<Shard[]>([]);
	const [error, setError] = useState("");
	const [code, setCode] = useState("");
	const [custom, setCustom] = useState({ fn: "", prompt: "", cases: "" });
	const [params, setParams] = useState({ agents: 4, gens: 3, per: 1 });
	const [contenders, setContenders] = useState<string[]>(["scripted"]);
	const [choice, setChoice] = useState("primes"); // what the task dropdown shows; "custom" opens the extra fields
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [focus, setFocus] = useState<string | null>(null);
	const [openCode, setOpenCode] = useState<Set<string>>(new Set());
	const [confirmDel, setConfirmDel] = useState<Block | null>(null);
	const lastCurrent = useRef("");
	const t = T[lang];
	const sid = encodeURIComponent(session);

	useEffect(() => {
		// no name field: code handed in is signed with a guest name that stays the same in this browser
		const saved = store("cm.name"), guest = saved || "guest-" + Math.random().toString(36).slice(2, 5);
		if (!saved) store("cm.name", guest);
		setName(guest);
		const fromHash = () => setSession(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);

	useEffect(() => {
		lastCurrent.current = "";
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		const connect = () => {
			ws = new WebSocket((location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/ws/" + sid);
			ws.onopen = () => { setLive(true); retry = 0; };
			ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") setSnap(d); };
			ws.onclose = () => { setLive(false); if (!dead) timer = setTimeout(connect, Math.min(10_000, 500 * 2 ** retry++)); };
		};
		connect();
		return () => { dead = true; clearTimeout(timer); ws?.close(); };
	}, [sid]);

	useEffect(() => {
		let dead = false;
		const load = () => {
			api<Llm>("/llm").then((x) => { if (!dead) setLlm(x); }).catch(() => {});
			api<{ shards: Shard[] }>("/system").then((x) => { if (!dead) setShards(x.shards); }).catch(() => {});
		};
		load();
		const timer = setInterval(load, 15_000);
		return () => { dead = true; clearInterval(timer); };
	}, []);

	// A new task block opens and takes the focus; the dropdown follows the active task.
	const current = snap?.blocks.find((b) => b.blockId === snap.current);
	useEffect(() => {
		if (!snap || !current || lastCurrent.current === snap.current) return;
		lastCurrent.current = snap.current;
		setOpen((cur) => new Set(cur).add(snap.current));
		setFocus(snap.current);
		setChoice(current.task.id);
	}, [snap, current]);

	const customChosen = choice === "custom";
	const modelLabels = (llm?.enabled && llm.on ? llm.models.map((m) => m.label) : []).join("|");
	// A custom task has no scripted variants: as soon as it is chosen, switch the contenders to the available model(s).
	useEffect(() => {
		if (!customChosen) return;
		const models = modelLabels ? modelLabels.split("|") : [];
		if (!models.length) return;
		setContenders((cur) => { const keep = cur.filter((c) => c !== "scripted" && models.includes(c)); return keep.length ? keep : [models[0]!]; });
	}, [customChosen, modelLabels]);

	const act = useCallback(async (path: string, body: unknown) => {
		setError("");
		try { await api(`/sessions/${sid}${path}`, body); } catch (e) { setError((e as Error).message); }
	}, [sid]);

	// "Start run" does everything: when the chosen task is not the active block yet, it opens a new task block first.
	const startRun = async () => {
		setError("");
		try {
			const sameCustom = current?.task.id === "custom" && current.task.fn === custom.fn.slice(0, 41) && current.task.prompt.en === custom.prompt.slice(0, 600);
			if (customChosen ? !sameCustom : !(current && choice === current.task.id)) {
				let body: unknown = { taskId: choice };
				if (customChosen) {
					let cases: unknown;
					try { cases = JSON.parse(custom.cases); } catch { setError("JSON?"); return; }
					body = { custom: { fn: custom.fn, prompt: custom.prompt, cases } };
				}
				await api(`/sessions/${sid}/task`, body);
			}
			if (params.agents > 0) await api(`/sessions/${sid}/run`, { agents: params.agents, gens: params.gens, perAgent: params.per, contenders: contenders.filter((c) => !customChosen || c !== "scripted"), lang });
		} catch (e) { setError((e as Error).message); }
	};
	const toggleSet = (set: Set<string>, id: string) => { const n = new Set(set); if (n.has(id)) n.delete(id); else n.add(id); return n; };

	const catalog = snap?.tasks.find((x) => x.id === choice);
	const run = snap?.run;
	const customIncomplete = customChosen && (!custom.fn.trim() || !custom.prompt.trim() || !custom.cases.trim());
	const needsContender = params.agents > 0 && contenders.filter((c) => !customChosen || c !== "scripted").length === 0;
	type Item = { ts: number; key: string; m?: Message; b?: Block };
	const timeline: Item[] = [
		...(snap?.messages ?? []).map((m): Item => ({ ts: m.ts, key: `m${m.ts}${m.author}${m.text.length}`, m })),
		...(snap?.blocks ?? []).map((b): Item => ({ ts: b.ts, key: b.blockId, b })),
	].sort((a, b) => a.ts - b.ts);
	const focusBlock = snap?.blocks.find((b) => b.blockId === focus) ?? current;
	const board = (focusBlock?.contributions ?? []).filter((c) => c.ok).sort((a, b) => a.ms! - b.ms!).slice(0, 8);
	const standings = Object.values((focusBlock?.contributions ?? []).filter((c) => c.via !== "human").reduce<Record<string, { via: string; n: number; ok: number; best: number | null }>>((acc, c) => { const e = (acc[c.via] ??= { via: c.via, n: 0, ok: 0, best: null }); if (c.ok !== null) { e.n++; if (c.ok) { e.ok++; e.best = e.best === null ? c.ms : Math.min(e.best, c.ms!); } } return acc; }, {})).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
	const blockLabel = focusBlock ? `${focusBlock.task.title[lang]} (${focusBlock.task.fn})` : "";

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE CHAT</b></span>
				<span className="spacer" />
				<span className="pill">{t.session}: {session}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				<span className="pill">{llm?.enabled ? `${llm.models.length} ${t.llm}` : t.off}</span>
				<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
				<ThemeControls lang={theme.lang} setLang={theme.setLang} mode={theme.mode} changeMode={theme.changeMode} palette={theme.palette} changePalette={theme.changePalette} />
			</header>
			<main>
				<aside>
					<div className="panel">
						<h2>{t.task}</h2>
						<div className="row">
							<select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t.task}>
								{(snap?.tasks ?? []).map((x) => <option key={x.id} value={x.id}>{x.title[lang]}</option>)}
								<option value="custom">{t.custom}</option>
							</select>
						</div>
						{!customChosen && catalog ? <p className="lead">{catalog.prompt[lang]} <code>{catalog.fn}</code></p> : null}
						{customChosen ? (
							<div className="customtask">
								<div className="row"><input placeholder={t.fn} value={custom.fn} onChange={(e) => setCustom({ ...custom, fn: e.target.value })} /></div>
								<textarea className="task-field" rows={6} placeholder={t.taskText} value={custom.prompt} onChange={(e) => setCustom({ ...custom, prompt: e.target.value })} />
								<textarea className="task-field" rows={8} placeholder={t.cases} value={custom.cases} onChange={(e) => setCustom({ ...custom, cases: e.target.value })} />
							</div>
						) : null}
					</div>
					<div className="panel">
						<h2>{t.run}</h2>
						{(["agents", "gens", "per"] as const).map((k) => (
							<div className="row" key={k}>
								<label htmlFor={"r" + k}>{t[k]}</label>
								<input id={"r" + k} type="number" min={k === "agents" ? 0 : 1} max={k === "agents" ? 8 : k === "gens" ? 6 : 3} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />
							</div>
						))}
						<fieldset className="contenders">
							<legend>{t.contenders}</legend>
							{[...(customChosen ? [] : [{ id: "scripted", label: t.scriptedAgents, off: false }]), ...(llm?.models ?? []).map((m) => ({ id: m.label, label: m.label, off: !llm?.enabled || !llm.on }))].map((c) => (
								<label key={c.id} className="check">
									<input type="checkbox" disabled={c.off || !!run?.active} checked={contenders.includes(c.id)} onChange={(e) => setContenders((cur) => e.target.checked ? [...cur, c.id].slice(-4) : cur.filter((x) => x !== c.id))} />
									{c.label}
								</label>
							))}
							{!llm?.enabled ? <div className="notice">{t.noModels}</div> : null}
							{customChosen && llm?.enabled ? <div className="notice">{t.autoModel}</div> : null}
						</fieldset>
						<div className="row">
							<button className="btn btn--primary" disabled={!!run?.active || customIncomplete || needsContender} title={customIncomplete ? t.fillCustom : needsContender ? t.pick : params.agents === 0 ? t.agentsZero : undefined} onClick={() => void startRun()}>{params.agents > 0 ? t.start : t.newTask}</button>
							<button className="btn" disabled={!run?.active} onClick={() => void act("/stop", {})}>{t.stop}</button>
						</div>
						{run ? <div className={"pill" + (run.active ? " pill--accent" : "")}>{(run.contenders ?? [run.mode]).join(` ${t.versus} `)} · {run.gen}/{run.gens}</div> : null}
						{run?.note ? <div className="notice">{run.note}</div> : null}
					</div>
					<div className="panel">
						<h2>{t.yours}</h2>
						<textarea rows={7} spellCheck={false} placeholder={current ? `function ${current.task.fn}(...) { ... }` : ""} value={code} onChange={(e) => setCode(e.target.value)} />
						<div className="row"><button className="btn btn--primary" onClick={() => { const source = code; setCode(""); void act("/code", { author: name, source }); }}>{t.submit}</button></div>
					</div>
				</aside>
				<section>
					<span className="eyebrow">{t.eyebrow}</span>
					<h1>{t.title}</h1>
					<p className="lead">{t.lead}</p>
					{error ? <div className="notice">{error}</div> : null}
					{timeline.length ? (
						<div className="timeline">
							{timeline.map((i) => i.b
								? <BlockView key={i.key} b={i.b} t={t} lang={lang} run={run ?? null} open={open.has(i.b.blockId)} focused={focusBlock?.blockId === i.b.blockId} openCode={openCode} onToggle={() => setOpen((cur) => toggleSet(cur, i.b!.blockId))} onFocus={() => setFocus(i.b!.blockId)} onCode={(id) => setOpenCode((cur) => toggleSet(cur, id))} onDelete={() => setConfirmDel(i.b!)} />
								: <div key={i.key} className={"msg" + (i.m!.author === "system" ? " msg--system" : "")}><b>{i.m!.author}</b>{i.m!.text}</div>)}
						</div>
					) : <div className="empty">{t.noBlocks}</div>}
				</section>
				<aside>
					<div className="panel">
						<h2>{t.board}</h2>
						{blockLabel ? <div className="forblock">{t.forBlock} {blockLabel}</div> : null}
						{board.length ? <table className="board"><tbody>{board.map((c, i) => <tr key={c.candidateId}><td>{i + 1}. {c.author}</td><td>{c.ms} ms</td></tr>)}</tbody></table> : <div className="empty">{t.nobest}</div>}
					</div>
					{standings.length > 1 || (standings.length === 1 && standings[0]!.via !== "scripted") ? (
						<div className="panel">
							<h2>{t.standings}</h2>
							<table className="board"><tbody>{standings.map((e, i) => <tr key={e.via}><td>{i + 1}. {e.via}</td><td>{e.ok}/{e.n} {t.correctN} · {e.best === null ? "–" : `${e.best} ms`}</td></tr>)}</tbody></table>
						</div>
					) : null}
					<div className="panel">
						<h2>{t.best}</h2>
						{blockLabel ? <div className="forblock">{t.forBlock} {blockLabel}</div> : null}
						{focusBlock?.best ? <pre className="code">{focusBlock.best.source}</pre> : <div className="empty">{t.nobest}</div>}
					</div>
				</aside>
			</main>
			{confirmDel ? (
				<ConfirmDialog title={t.delTitle} text={t.delText(`${confirmDel.task.title[lang]} (${confirmDel.task.fn})`, confirmDel.contributions.length)} yes={t.yes} no={t.no}
					onNo={() => setConfirmDel(null)}
					onYes={() => { const id = confirmDel.blockId; setConfirmDel(null); setOpen((cur) => { const n = new Set(cur); n.delete(id); return n; }); setFocus((cur) => (cur === id ? null : cur)); void act("/delete", { blockId: id }); }} />
			) : null}
			{shards.length ? (
				<div className="system-bar" role="contentinfo">
					<span>{t.test}</span>
					{shards.map((s) => s.up ? (
						<span key={s.shard}><b>{s.host?.name ?? s.shard}</b>{s.host ? ` · ${shortCpu(s.host.cpu)} · ${s.host.cores} vCPU · ${s.host.memGiB} GiB` : ""}{s.judged !== null ? ` · ${s.judged.toLocaleString(lang === "de" ? "de-DE" : "en-US")} ${t.judged}` : ""}</span>
					) : <span key={s.shard} className="system-bar__host--down"><b>{s.shard}</b>: {t.down}</span>)}
				</div>
			) : null}
		</>
	);
}
