"use client";
// Codemode chat UI: the Space-Chat workbench layout of the help system (task and run controls left, the
// conversation in the middle, ranking and best code right), for contributions of code. Every task is its own
// collapsible block in the conversation: its agents are square tiles, their code unfolds on a click, and the
// ranking and best code on the right follow the block that is open or clicked. All text is rendered as React text
// nodes: agent code is untrusted data and never becomes markup.
import { useCallback, useEffect, useRef, useState } from "react";
import { HelpTip } from "./HelpTip.tsx";
import { ThemeControls } from "./ThemeControls.tsx";
import { parseCases } from "./lib/cases.ts";
import { useTheme, type Lang } from "./lib/theme.ts";

type L = { de: string; en: string };
type Contribution = { candidateId: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; passed?: number; total?: number; role?: string; basedOn?: string; hardcoded?: true; note?: string; vetoed?: { by: string; reason: string }; source?: string; sourceOmitted?: true; ts: number };
/** Correct and not rejected by a person. */
const counts = (c: Contribution) => !!c.ok && !c.vetoed;
type CaseResult = { call: string; ok: boolean; got?: string; expect?: string; error?: string };
type Details = { source: string; cases: CaseResult[]; passed?: number; total?: number; role?: string; basedOn?: string };
/** `rejected`: the note of a contribution that was rejected; the agents no longer get it. */
type TeamNote = { author: string; via: string; gen: number; text: string; ts: number; human?: boolean; rejected?: boolean; candidateId?: string };
type Message = { author: string; text: string; ts: number; blockId?: string };
type Best = { candidateId: string; ms: number; source?: string; sourceOmitted?: true };
type Block = { blockId: string; ts: number; active: boolean; task: { id: string; fn: string; title: L; prompt: L; cases?: number; check?: string; checkBy?: string; timeoutS?: number }; contributions: Contribution[]; best: Best | null; messages: Message[]; notes?: TeamNote[] };
type Snapshot = {
	session: string; current: string; tasks: { id: string; title: L; fn: string; prompt: L }[]; blocks: Block[]; messages: Message[];
	currentCustom?: { fn: string; prompt: string; cases: unknown[] };
	limits?: { maxTimeoutS: number };
	run: { active: boolean; blockId: string; mode: string; contenders?: string[]; gen: number; gens: number; agents: number; perAgent: number; note?: string } | null;
};
type Llm = { enabled: boolean; on: boolean; current: string | null; models: { id: string; label: string }[] };
type Shard = { shard: string; up: boolean; host: { name: string; cpu: string; cores: number; memGiB: number } | null; judged: number | null };

const T = {
	de: { title: "Codemode-Chat", eyebrow: "AGENTEN UND MENSCHEN SCHREIBEN CODE IN EINEN GEMEINSAMEN SPACE", lead: "Jede Aufgabe ist ein Block; jeder Beitrag ein Eintrag im Space, den die Codemode-Sandbox bewertet. Ein Klick auf eine Kachel zeigt den gelieferten Code.", task: "Aufgabe", custom: "Eigene Aufgabe …", fn: "Funktionsname", taskText: "Beschreibung der Aufgabe (was soll die Funktion tun?)", cases: "Testfälle: JSON [{\"args\":[2],\"expect\":4}] oder einfacher Text, z. B. „5 -> 120“ oder „Ergebnis: 0 1 4 9 11“; mehrere richtige Ergebnisse mit „oder“: „4 -> 2 oder -2“", casesError: "Die Testfälle konnten nicht gelesen werden. Erlaubt: JSON oder einfacher Text wie „5 -> 120“ oder „Ergebnis: 0 1 4 9 11“.", newTask: "Aufgabe anlegen (ohne Agenten)", agentsZero: "0 Agenten: nur den Aufgabenblock anlegen, Code reichst du selbst ein", run: "Lauf", agents: "Agenten", gens: "Generationen (max)", per: "Beiträge je Agent", contenders: "Teilnehmer (Mehrfachauswahl)", scriptedAgents: "Skript-Agenten", noModels: "Modell-Agenten sind aus (CODEMODE_CHAT_LLM=1)", autoModel: "Eigene Aufgabe: Modell-Agenten automatisch gewählt (Skript-Agenten haben dafür keinen Code).", start: "Lauf starten", stop: "Stoppen", pick: "Mindestens ein Teilnehmer", fillCustom: "Funktionsname, Beschreibung und Testfälle ausfüllen", yours: "Eigener Code", submit: "Code einreichen", board: "Rangliste", best: "Bester Code", standings: "Beiträge je Teilnehmer", none: "Noch keine Beiträge.", wait: "wartet", ok: "korrekt", bad: "falsch", code: "Code", gen: "Gen.", live: "live", offline: "getrennt", session: "Raum", off: "Modell-Agenten aus", llm: "Modell", nobest: "keine korrekten Beiträge", test: "Testsystem", judged: "bewertet", down: "nicht erreichbar", versus: "mit", correctN: "korrekt", helpLink: "Hilfe", contributions: "Beiträge", running: "läuft", block: "Aufgabe", del: "Block löschen", delRunning: "Der Lauf in diesem Block muss zuerst gestoppt werden", delTitle: "Aufgabenblock löschen?", delText: (title: string, n: number) => `Der Block „${title}“ mit ${n} Beiträgen, Rangliste und bestem Code wird dauerhaft gelöscht.`, yes: "Ja, löschen", no: "Nein", forBlock: "für", hide: "Schließen", noBlocks: "Noch keine Aufgabe.", fnLabel: "Funktionsname", promptLabel: "Beschreibung", casesLabel: "Testfälle", startLabel: "Lauf starten / stoppen", runCode: "▶ Ausführen", runClose: "Konsole schließen", runAgain: "▶ Erneut", runStop: "■ Stop", callLabel: "Eigener Aufruf (optional)", callPh: (fn: string) => `z. B. ${fn}(10)`, expected: "erwartet", runOk: (ms: number) => `fertig in ${ms} ms`, runTimeout: "Zeitlimit erreicht (60 s)", runAborted: "gestoppt", runLimit: "Ausgabelimit erreicht, Lauf beendet", runError: "mit Fehler beendet", consoleLabel: "Konsole", runHint: "Läuft die Funktion gegen die Testfälle der Aufgabe und danach den eigenen Aufruf; nichts wird bewertet.", polish: "Verbesserungsrunden", roles: { repair: "🔧 repariert", explore: "🧭 neuer Ansatz", improve: "⚡ verbessert" } as Record<string, string>, basedOn: "baut auf", notes: "Notizen des Teams", cont: "▶ Weiterarbeiten", contHint: "Neuer Lauf in diesem Block: die Agenten sehen alle bisherigen Versuche, Abwertungen und Hinweise und arbeiten daran weiter.", hintPh: "Hinweis ans Team, z. B. „mit Backtracking, keine feste Tabelle“", hintSend: "Senden", hintBy: "Hinweis", hints: "Hinweise ans Team", noTaskYet: "Erst eine Aufgabe anlegen (links „Lauf starten“ oder „Aufgabe anlegen“ mit 0 Agenten)", stopRun: "Lauf abbrechen", stopTitle: "Lauf abbrechen?", stopText: (title: string, gen: number, gens: number) => `Der Lauf in „${title}“ (Generation ${gen} von höchstens ${gens}) wird abgebrochen. Beiträge, die schon eingereicht sind, werden noch bewertet; alles Bisherige bleibt erhalten.`, stopYes: "Ja, abbrechen", timeLimit: "Zeitlimit je Beitrag (s)", timeLimitShort: (s: number) => `Zeitlimit ${s} s`, timeLimitMax: (s: number) => `1 bis ${s} s`, noteRejected: "Der Beitrag zu dieser Notiz wurde abgelehnt; die Agenten bekommen sie nicht mehr.", veto: "👎 So nicht", vetoReason: "Warum? (optional, die Agenten lesen es)", vetoDo: "Abwerten", vetoCancel: "Abbrechen", vetoUndo: "Zurücknehmen", vetoed: (by: string) => `👎 abgewertet von ${by}`, vetoedShort: "abgewertet", hardcoded: "✗ Ergebnis fest eingetragen", hardcodedShort: "fest eingetragen", verifyLabel: "Auch andere richtige Ergebnisse zulassen", verifyHint: "Ein Prüfer-Agent schreibt aus Beschreibung und Beispielen eine Prüfregel; ohne Haken zählen nur die angegebenen Ergebnisse.", verifyOff: "braucht Modell-Agenten", verifying: "Der Prüfer-Agent schreibt die Prüfregel …", rule: "Prüfregel", ruleBy: { verifier: "Prüfregel (vom Prüfer-Agenten)", user: "Prüfregel" } as Record<string, string>, passedN: "Fälle bestanden", caseRule: "von der Prüfregel geprüft" },
	en: { title: "Codemode chat", eyebrow: "AGENTS AND PEOPLE WRITE CODE INTO A SHARED SPACE", lead: "Every task is a block; every contribution an entry in the space that the codemode sandbox judges. Click a tile to see the code it delivered.", task: "Task", custom: "Custom task …", fn: "Function name", taskText: "Task description (what should the function do?)", cases: "Test cases: JSON [{\"args\":[2],\"expect\":4}] or plain text, e.g. \"5 -> 120\" or \"Result: 0 1 4 9 11\"; several right results with \"or\": \"4 -> 2 or -2\"", casesError: "The test cases could not be read. Allowed: JSON or plain text like \"5 -> 120\" or \"Result: 0 1 4 9 11\".", newTask: "Create task (no agents)", agentsZero: "0 agents: only create the task block, you hand in the code yourself", run: "Run", agents: "Agents", gens: "Generations (max)", per: "Contributions per agent", contenders: "Contenders (multi-select)", scriptedAgents: "Scripted agents", noModels: "Model agents are off (CODEMODE_CHAT_LLM=1)", autoModel: "Custom task: model agents selected automatically (scripted agents have no code for it).", start: "Start run", stop: "Stop", pick: "Pick at least one contender", fillCustom: "Fill in function name, description and test cases", yours: "Your code", submit: "Submit code", board: "Leaderboard", best: "Best code", standings: "Contributions per contender", none: "No contributions yet.", wait: "waiting", ok: "correct", bad: "wrong", code: "code", gen: "gen", live: "live", offline: "disconnected", session: "Room", off: "model agents off", llm: "model", nobest: "no correct contribution", test: "Test system", judged: "judged", down: "unreachable", versus: "with", correctN: "correct", helpLink: "Help", contributions: "contributions", running: "running", block: "Task", del: "Delete block", delRunning: "Stop the run in this block first", delTitle: "Delete task block?", delText: (title: string, n: number) => `The block "${title}" with ${n} contributions, its ranking and best code will be deleted permanently.`, yes: "Yes, delete", no: "No", forBlock: "for", hide: "Close", noBlocks: "No task yet.", fnLabel: "Function name", promptLabel: "Description", casesLabel: "Test cases", startLabel: "Start / stop the run", runCode: "▶ Run", runClose: "Close console", runAgain: "▶ Again", runStop: "■ Stop", callLabel: "Own call (optional)", callPh: (fn: string) => `e.g. ${fn}(10)`, expected: "expected", runOk: (ms: number) => `done in ${ms} ms`, runTimeout: "time limit reached (60 s)", runAborted: "stopped", runLimit: "output limit reached, run ended", runError: "ended with an error", consoleLabel: "Console", runHint: "Runs the function against the task's test cases, then the own call; nothing is scored.", polish: "Improvement rounds", roles: { repair: "🔧 repaired", explore: "🧭 new approach", improve: "⚡ improved" } as Record<string, string>, basedOn: "builds on", notes: "Team notes", cont: "▶ Keep working", contHint: "A new run in this block: the agents see every attempt so far, the rejections and the hints, and work on from there.", hintPh: "Hint to the team, e.g. \"use backtracking, no fixed table\"", hintSend: "Send", hintBy: "hint", hints: "Hints to the team", noTaskYet: "Create a task first (\"Start run\" on the left, or \"Create task\" with 0 agents)", stopRun: "Stop the run", stopTitle: "Stop the run?", stopText: (title: string, gen: number, gens: number) => `The run in "${title}" (generation ${gen} of at most ${gens}) will be stopped. Contributions already handed in are still judged; everything so far is kept.`, stopYes: "Yes, stop", timeLimit: "Time limit per contribution (s)", timeLimitShort: (s: number) => `time limit ${s} s`, timeLimitMax: (s: number) => `1 to ${s} s`, noteRejected: "The contribution of this note was rejected; the agents no longer get it.", veto: "👎 Not like this", vetoReason: "Why? (optional, the agents read it)", vetoDo: "Reject", vetoCancel: "Cancel", vetoUndo: "Withdraw", vetoed: (by: string) => `👎 rejected by ${by}`, vetoedShort: "rejected", hardcoded: "✗ result hard-coded", hardcodedShort: "hard-coded", verifyLabel: "Accept other right results too", verifyHint: "A verifier agent writes a check rule from the description and the examples; without the tick only the given results count.", verifyOff: "needs model agents", verifying: "The verifier agent is writing the check rule …", rule: "Check rule", ruleBy: { verifier: "Check rule (by the verifier agent)", user: "Check rule" } as Record<string, string>, passedN: "cases passed", caseRule: "checked by the rule" },
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
/** A judged time: whole ms from 10 on, two decimals below, and "<0.01 ms" for what the clock cannot resolve. */
const fmtMs = (ms: number | null | undefined) => (ms == null ? "–" : ms === 0 ? "<0.01 ms" : ms >= 10 ? `${Math.round(ms)} ms` : `${ms.toFixed(2)} ms`);
const shortVia = (via: string) => via.replace(/^[^/]+\//, "").replace(/-\d{8}$/, "");

/** Code, case results and lineage of an unfolded contribution, fetched when it is shown and again once its verdict
 *  arrives (the snapshot carries no case results, and in a large room not every code). */
function useDetails(sid: string, candidateId: string, verdict: boolean | null | undefined): Details | null {
	const [d, setD] = useState<Details | null>(null);
	useEffect(() => {
		let dead = false;
		api<Details>(`/sessions/${sid}/source/${encodeURIComponent(candidateId)}`).then((x) => { if (!dead) setD(x); }).catch(() => {});
		return () => { dead = true; };
	}, [sid, candidateId, verdict]);
	return d;
}

/** What each case returned: ✓/✗, the call, the result or error, and on ✗ what was expected. */
function CaseList({ cases, t }: { cases: CaseResult[]; t: Tr }) {
	return (
		<div className="cases">
			{cases.map((c, i) => (
				<div key={i} className={c.ok ? "ok" : "bad"}>
					{c.ok ? "✓" : "✗"} {c.call} → {c.error ?? c.got}{!c.ok && !c.error ? `   (${c.expect !== undefined ? `${t.expected} ${c.expect}` : t.caseRule})` : ""}
				</div>
			))}
		</div>
	);
}

type ExecEvent =
	| { t: "start"; fn: string; cases: number }
	| { t: "case"; call: string; ok: boolean; got?: string; error?: string; expect: string }
	| { t: "log"; level: string; text: string }
	| { t: "value"; call: string; text: string }
	| { t: "error"; text: string }
	| { t: "end"; status: "ok" | "timeout" | "aborted" | "limit" | "error"; ms: number }
	| { t: "stopped" };

/** The ▶ console of one contribution: runs it in the server sandbox and shows what streams back; Stop ends the
 *  request, which aborts the run. Output is text only (React text nodes), like the code itself. */
function RunConsole({ sid, candidateId, fn, t }: { sid: string; candidateId: string; fn: string; t: Tr }) {
	const [call, setCall] = useState("");
	const [lines, setLines] = useState<ExecEvent[]>([]);
	const [running, setRunning] = useState(false);
	const ctl = useRef<AbortController | null>(null);
	const box = useRef<HTMLDivElement>(null);
	useEffect(() => () => ctl.current?.abort(), []);
	useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [lines]);
	const push = (e: ExecEvent) => setLines((cur) => (cur.length >= 2000 ? cur : [...cur, e]));
	const run = async () => {
		ctl.current?.abort();
		const ac = new AbortController();
		ctl.current = ac;
		setLines([]); setRunning(true);
		try {
			const r = await fetch(`/api/sessions/${sid}/exec`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId, call }), signal: ac.signal });
			if (!r.ok || !r.body) { const d = (await r.json().catch(() => ({}))) as { error?: string }; push({ t: "error", text: d.error || r.statusText }); return; }
			const reader = r.body.getReader(), dec = new TextDecoder();
			let buf = "";
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				buf += dec.decode(value, { stream: true });
				for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) push(JSON.parse(l) as ExecEvent); }
			}
		} catch (e) {
			push(ac.signal.aborted ? { t: "stopped" } : { t: "error", text: (e as Error).message });
		} finally {
			if (ctl.current === ac) { ctl.current = null; setRunning(false); }
		}
	};
	const endText = (e: Extract<ExecEvent, { t: "end" }>) => e.status === "ok" ? t.runOk(e.ms) : e.status === "timeout" ? t.runTimeout : e.status === "aborted" ? t.runAborted : e.status === "limit" ? t.runLimit : t.runError;
	return (
		<div className="console">
			<div className="console__bar">
				<label className="sr-only" htmlFor={`call-${candidateId}`}>{t.callLabel}</label>
				<input id={`call-${candidateId}`} className="console__call" placeholder={`${t.callLabel}: ${t.callPh(fn)}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} maxLength={500} value={call}
					onChange={(e) => setCall(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !running) void run(); }} />
				{running
					? <button type="button" className="btn btn--danger" onClick={() => ctl.current?.abort()}>{t.runStop}</button>
					: <button type="button" className="btn btn--primary" onClick={() => void run()} title={t.runHint}>{lines.length ? t.runAgain : t.runCode}</button>}
			</div>
			<div className="console__out" ref={box} role="log" aria-live="polite" aria-label={t.consoleLabel}>
				{lines.map((e, i) =>
					e.t === "start" ? null
					: e.t === "case" ? <div key={i} className={e.ok ? "ok" : "bad"}>{e.ok ? "✓" : "✗"} {e.call} → {e.error ?? e.got}{e.ok ? "" : `   (${t.expected} ${e.expect})`}</div>
					: e.t === "log" ? <div key={i} className={`log log--${e.level}`}>{e.text}</div>
					: e.t === "value" ? <div key={i} className="value">{e.call} = {e.text}</div>
					: e.t === "error" ? <div key={i} className="bad">{e.text}</div>
					: e.t === "end" ? <div key={i} className="end">— {endText(e)}</div>
					: <div key={i} className="end">— {t.runAborted}</div>)}
				{running ? <div className="end">…</div> : null}
			</div>
		</div>
	);
}

/** Code of a contribution with its case results and its ▶: the console opens below the code. */
function CodeBlock({ sid, c, fn, t }: { sid: string; c: { candidateId: string; source?: string; sourceOmitted?: true; ok?: boolean | null }; fn: string; t: Tr }) {
	const [open, setOpen] = useState(false);
	const d = useDetails(sid, c.candidateId, c.ok);
	return (
		<>
			{d?.cases.length && c.ok !== null ? <CaseList cases={d.cases} t={t} /> : null}
			<pre className="code">{c.sourceOmitted ? (d?.source ?? "…") : c.source}</pre>
			<div className="runrow"><button type="button" className="btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? t.runClose : t.runCode}</button></div>
			{open ? <RunConsole sid={sid} candidateId={c.candidateId} fn={fn} t={t} /> : null}
		</>
	);
}

function Tile({ c, isBest, open, onClick, t, basedOn }: { c: Contribution; isBest: boolean; open: boolean; onClick: () => void; t: Tr; basedOn?: string }) {
	const state = c.ok === null ? "wait" : counts(c) ? "ok" : c.vetoed || c.hardcoded ? "bad" : (c.passed ?? 0) > 0 ? "part" : "bad";
	return (
		<button type="button" className={`tile tile--${state}${isBest ? " tile--best" : ""}${open ? " tile--open" : ""}`} aria-expanded={open} onClick={onClick} title={c.note ?? c.error}>
			<span className="tile__who">{c.author}</span>
			<span className="tile__via">{shortVia(c.via)}</span>
			<span className="tile__result" title={c.total ? `${c.passed ?? 0}/${c.total} ${t.passedN}` : undefined}>{c.ok === null ? "…" : c.vetoed ? "👎" : c.hardcoded ? "✗" : c.ok ? fmtMs(c.ms) : c.total ? `${c.passed ?? 0}/${c.total}` : "✗"}</span>
			{c.vetoed || c.hardcoded ? <span className="tile__flag">{c.vetoed ? t.vetoedShort : t.hardcodedShort}</span> : null}
			{c.role ? <span className="tile__lineage" title={`${t.roles[c.role] ?? c.role}${basedOn ? ` ↳ ${basedOn}` : ""}`}>{t.roles[c.role] ?? c.role}{basedOn ? ` ↳ ${basedOn}` : ""}</span> : null}
			<span className="tile__meta">{[c.gen ? `${t.gen} ${c.gen}` : "", c.host ?? ""].filter(Boolean).join(" · ")}</span>
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

function BlockView({ sid, b, open, focused, run, openCode, onToggle, onFocus, onCode, onDelete, onStop, onVeto, onHint, onContinue, t, lang }: { sid: string; onStop: () => void; onVeto: (candidateId: string, reason: string, undo: boolean) => void; onHint: (blockId: string, text: string) => void; onContinue: () => void; b: Block; open: boolean; focused: boolean; run: Snapshot["run"]; openCode: Set<string>; onToggle: () => void; onFocus: () => void; onCode: (id: string) => void; onDelete: () => void; t: Tr; lang: Lang }) {
	const done = b.contributions.filter((c) => c.ok !== null).length, ok = b.contributions.filter(counts).length;
	const running = run?.active && run.blockId === b.blockId;
	const opened = b.contributions.filter((c) => openCode.has(c.candidateId));
	const [vetoing, setVetoing] = useState<{ id: string; reason: string } | null>(null);
	const [hint, setHint] = useState("");
	const sendHint = () => { if (hint.trim()) { onHint(b.blockId, hint.trim()); setHint(""); } };
	const byId = new Map(b.contributions.map((c) => [c.candidateId, c]));
	const origin = (c: Contribution) => { const o = c.basedOn ? byId.get(c.basedOn) : undefined; return o ? `${o.author} (${t.gen} ${o.gen})` : undefined; };
	return (
		<section className={`block${focused ? " block--focus" : ""}${b.active ? " block--active" : ""}`}>
			<div className="block__bar">
			<button type="button" className="block__head" aria-expanded={open} onClick={() => { onToggle(); onFocus(); }}>
				<span className="block__caret">{open ? "▾" : "▸"}</span>
				<span className="block__title">{b.task.title[lang]} <code>{b.task.fn}</code></span>
				<span className="chip">{b.contributions.length} {t.contributions}</span>
				<span className="chip chip--ok">{ok}/{done} {t.correctN}</span>
				{b.best ? <span className="chip chip--best">★ {fmtMs(b.best.ms)}</span> : null}
				{running ? <span className="chip chip--wait">{t.running} · {run!.gen}/{run!.gens}</span> : null}
			</button>
			{running ? <button type="button" className="block__stop" title={t.stopRun} aria-label={t.stopRun} onClick={onStop}>■</button> : null}
			<button type="button" className="block__del" disabled={!!running} title={running ? t.delRunning : t.del} aria-label={t.del} onClick={onDelete}>🗑</button>
			</div>
			{open ? (
				<div className="block__body" onClick={onFocus}>
					<p className="lead">{b.task.prompt[lang]}{b.task.timeoutS ? <span className="chip chip--time">{t.timeLimitShort(b.task.timeoutS)}</span> : null}</p>
					{b.task.check ? <div className="rule"><span>{t.ruleBy[b.task.checkBy ?? "user"] ?? t.rule}:</span> <code>{b.task.check}</code></div> : null}
					{b.messages.length ? <div className="block__log">{b.messages.map((m, i) => <div key={i}>{m.text}</div>)}</div> : null}
					{/* agent notes stand with their attempts (below); up here only people's hints and notes without an attempt */}
					{(() => {
						const listed = (b.notes ?? []).filter((n) => n.human || !n.candidateId);
						return listed.length ? (
							<div className="notes">
								<div className="notes__title">{listed.every((n) => n.human) ? t.hints : t.notes}</div>
								{listed.map((n, i) => n.human
									? <div key={i} className="note--human">🧑 <b>{n.author}</b> <span className="muted">({t.hintBy})</span> {n.text}</div>
									: <div key={i}>💡 <b>{n.author}</b> <span className="muted">({shortVia(n.via)}, {t.gen} {n.gen})</span> {n.text}</div>)}
							</div>
						) : null;
					})()}
					{b.active ? (
						<div className="teambar">
							<input className="wide" maxLength={300} placeholder={t.hintPh} value={hint} onChange={(e) => setHint(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") sendHint(); }} />
							<button type="button" className="btn" disabled={!hint.trim()} onClick={sendHint}>{t.hintSend}</button>
							<button type="button" className="btn btn--primary" disabled={!!run?.active} title={t.contHint} onClick={onContinue}>{t.cont}</button>
						</div>
					) : null}
					{b.contributions.length ? (
						<div className="tiles">
							{b.contributions.map((c) => <Tile key={c.candidateId} c={c} t={t} basedOn={origin(c)?.split(" (")[0]} isBest={b.best?.candidateId === c.candidateId} open={openCode.has(c.candidateId)} onClick={() => onCode(c.candidateId)} />)}
						</div>
					) : <div className="empty">{t.none}</div>}
					{opened.map((c) => (
						<div key={c.candidateId} className="codecard">
							<div className="codecard__head">
								<b>{c.author}</b> <span className="chip">{c.via}</span>
								{c.ok === null ? <span className="chip chip--wait">{t.wait}</span> : c.vetoed ? <span className="chip chip--bad">{t.vetoed(c.vetoed.by)}</span> : c.hardcoded ? <span className="chip chip--bad">{t.hardcoded}</span> : c.ok ? <span className="chip chip--ok">{t.ok} · {fmtMs(c.ms)}</span> : <span className="chip chip--bad">{t.bad}{c.total ? ` · ${c.passed ?? 0}/${c.total}` : ""}</span>}
								{c.role ? <span className="chip">{t.roles[c.role] ?? c.role}</span> : null}
								{origin(c) ? <span className="lineage">{t.basedOn} {origin(c)}</span> : null}
								<span className="spacer" />
								{c.ok === null ? null : c.vetoed
									? <button type="button" className="btn" onClick={() => onVeto(c.candidateId, "", true)}>{t.vetoUndo}</button>
									: <button type="button" className="btn" onClick={() => setVetoing({ id: c.candidateId, reason: "" })}>{t.veto}</button>}
								<button type="button" className="btn" onClick={() => onCode(c.candidateId)}>{t.hide}</button>
							</div>
							{vetoing?.id === c.candidateId ? (
								<div className="vetobar">
									<input className="wide" autoFocus maxLength={200} placeholder={t.vetoReason} value={vetoing.reason} onChange={(e) => setVetoing({ ...vetoing, reason: e.target.value })}
										onKeyDown={(e) => { if (e.key === "Enter") { onVeto(c.candidateId, vetoing.reason, false); setVetoing(null); } if (e.key === "Escape") setVetoing(null); }} />
									<button type="button" className="btn btn--danger" onClick={() => { onVeto(c.candidateId, vetoing.reason, false); setVetoing(null); }}>{t.vetoDo}</button>
									<button type="button" className="btn" onClick={() => setVetoing(null)}>{t.vetoCancel}</button>
								</div>
							) : null}
							{c.note ? <div className={`attempt-note${c.vetoed || c.hardcoded ? " note--rejected" : ""}`} title={c.vetoed || c.hardcoded ? t.noteRejected : undefined}>💡 {c.note}</div> : null}
							{c.vetoed?.reason ? <div className="err">👎 {c.vetoed.reason}</div> : null}
							{c.error ? <div className="err">{c.error}</div> : null}
							<CodeBlock key={c.candidateId} sid={sid} c={c} fn={b.task.fn} t={t} />
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
	const [custom, setCustom] = useState({ fn: "", prompt: "", cases: "", verify: true, timeoutS: 5 });
	const [busy, setBusy] = useState("");
	const [params, setParams] = useState({ agents: 4, gens: 6, per: 1, polish: 1 });
	const [contenders, setContenders] = useState<string[]>(["scripted"]);
	const [choice, setChoice] = useState("primes"); // what the task dropdown shows; "custom" opens the extra fields
	const [open, setOpen] = useState<Set<string>>(new Set());
	const [focus, setFocus] = useState<string | null>(null);
	const [openCode, setOpenCode] = useState<Set<string>>(new Set());
	const [confirmDel, setConfirmDel] = useState<Block | null>(null);
	const [confirmStop, setConfirmStop] = useState<Block | null>(null);
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
			ws.onopen = () => setLive(true);
			// the backoff resets only once a snapshot arrived: a socket the server drops right after opening backs off too
			ws.onmessage = (e) => { const d = JSON.parse(e.data); if (d.type === "snapshot") { retry = 0; setSnap(d); } };
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
		// an active custom task fills an empty form (e.g. after a reload), so it can be continued or changed
		const cc = snap.currentCustom;
		if (current.task.id === "custom" && cc) setCustom((c) => (c.fn || c.prompt || c.cases ? c : { ...c, fn: cc.fn, prompt: cc.prompt, cases: JSON.stringify(cc.cases), timeoutS: current.task.timeoutS ?? 5 }));
	}, [snap, current]);

	const customChosen = choice === "custom";
	const maxTimeoutS = snap?.limits?.maxTimeoutS ?? 60; // the server's upper bound (CODEMODE_MAX_TIMEOUT_S)
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
			// the same function and description continue the active block (with its attempts) instead of starting afresh
			const sameCustom = current?.task.id === "custom" && current.task.fn === custom.fn.trim().slice(0, 41) && current.task.prompt.en === custom.prompt.slice(0, 600);
			const retimed = sameCustom && (current!.task.timeoutS ?? 5) !== custom.timeoutS; // the server changes the limit in place
			if (customChosen ? !sameCustom || retimed : !(current && choice === current.task.id)) {
				let body: unknown = { taskId: choice };
				if (customChosen) {
					const cases = parseCases(custom.cases); // JSON as it is, or plain text turned into JSON
					if (!cases) { setError(t.casesError); return; }
					setCustom((c) => ({ ...c, cases: JSON.stringify(cases) })); // show what was understood
					body = { custom: { fn: custom.fn, prompt: custom.prompt, cases, verify: custom.verify, timeoutS: custom.timeoutS } };
				}
				if (customChosen && !retimed && custom.verify && llm?.enabled && llm.on) setBusy(t.verifying); // the verifier takes a few seconds
				try { await api(`/sessions/${sid}/task`, body); } finally { setBusy(""); }
			}
			if (params.agents > 0) await api(`/sessions/${sid}/run`, { agents: params.agents, gens: params.gens, perAgent: params.per, polish: params.polish, contenders: contenders.filter((c) => !customChosen || c !== "scripted"), lang });
		} catch (e) { setError((e as Error).message); }
	};
	// "Keep working": a new run in the active block as it is (no new block, the attempts stay)
	const continueRun = async () => {
		setError("");
		const isCustom = current?.task.id === "custom";
		try { await api(`/sessions/${sid}/run`, { agents: Math.max(1, params.agents), gens: params.gens, perAgent: params.per, polish: params.polish, contenders: contenders.filter((c) => !isCustom || c !== "scripted"), lang }); }
		catch (e) { setError((e as Error).message); }
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
	const board = (focusBlock?.contributions ?? []).filter(counts).sort((a, b) => a.ms! - b.ms!).slice(0, 8);
	const standings = Object.values((focusBlock?.contributions ?? []).filter((c) => c.via !== "human").reduce<Record<string, { via: string; n: number; ok: number; best: number | null }>>((acc, c) => { const e = (acc[c.via] ??= { via: c.via, n: 0, ok: 0, best: null }); if (c.ok !== null) { e.n++; if (counts(c)) { e.ok++; e.best = e.best === null ? c.ms : Math.min(e.best, c.ms!); } } return acc; }, {})).sort((a, b) => (a.best ?? Infinity) - (b.best ?? Infinity));
	const blockLabel = focusBlock ? `${focusBlock.task.title[lang]} (${focusBlock.task.fn})` : "";

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE CHAT</b></span>
				<span className="spacer" />
				<span className="pill">{t.session}: {session}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				<span className="pill">{llm?.enabled ? `${llm.models.length} ${t.llm}` : t.off}</span>
				<ThemeControls lang={theme.lang} setLang={theme.setLang} mode={theme.mode} changeMode={theme.changeMode} palette={theme.palette} changePalette={theme.changePalette} />
				<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
			</header>
			<main>
				<aside>
					<div className="panel">
						<h2>{t.task} <HelpTip id="task" lang={lang} label={t.task} /></h2>
						<div className="row">
							<select value={choice} onChange={(e) => setChoice(e.target.value)} aria-label={t.task}>
								{(snap?.tasks ?? []).map((x) => <option key={x.id} value={x.id}>{x.title[lang]}</option>)}
								<option value="custom">{t.custom}</option>
							</select>
						</div>
						{!customChosen && catalog ? <p className="lead">{catalog.prompt[lang]} <code>{catalog.fn}</code></p> : null}
						{customChosen ? (
							<div className="customtask">
								<div className="fieldlabel"><label htmlFor="cfn">{t.fnLabel}</label><HelpTip id="fn" lang={lang} label={t.fnLabel} /></div>
								<input id="cfn" className="wide" placeholder={t.fn} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={custom.fn} onChange={(e) => setCustom({ ...custom, fn: e.target.value })} />
								<div className="fieldlabel"><label htmlFor="cprompt">{t.promptLabel}</label><HelpTip id="prompt" lang={lang} label={t.promptLabel} /></div>
								<textarea id="cprompt" className="task-field" rows={6} placeholder={t.taskText} value={custom.prompt} onChange={(e) => setCustom({ ...custom, prompt: e.target.value })} />
								<div className="fieldlabel"><label htmlFor="ccases">{t.casesLabel}</label><HelpTip id="cases" lang={lang} label={t.casesLabel} /></div>
								<textarea id="ccases" className="task-field" rows={8} placeholder={t.cases} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={custom.cases} onChange={(e) => setCustom({ ...custom, cases: e.target.value })} />
								<div className="fieldlabel">
									<label className="check" title={t.verifyHint}>
										<input type="checkbox" checked={custom.verify && !!llm?.enabled && !!llm.on} disabled={!llm?.enabled || !llm.on} onChange={(e) => setCustom({ ...custom, verify: e.target.checked })} />
										{t.verifyLabel}{!llm?.enabled || !llm.on ? ` (${t.verifyOff})` : ""}
									</label>
									<HelpTip id="verify" lang={lang} label={t.verifyLabel} />
								</div>
								<div className="row">
									<label htmlFor="ctimeout">{t.timeLimit}</label>
									<HelpTip id="timeout" lang={lang} label={t.timeLimit} />
									<input id="ctimeout" type="number" min={1} max={maxTimeoutS} title={t.timeLimitMax(maxTimeoutS)} value={custom.timeoutS} onChange={(e) => setCustom({ ...custom, timeoutS: Math.max(1, Math.min(maxTimeoutS, Number(e.target.value) || 5)) })} />
									<span className="muted">{t.timeLimitMax(maxTimeoutS)}</span>
								</div>
							</div>
						) : null}
					</div>
					<div className="panel">
						<h2>{t.run}</h2>
						{(["agents", "gens", "per", "polish"] as const).map((k) => (
							<div className="row" key={k}>
								<label htmlFor={"r" + k}>{t[k]}</label>
								<HelpTip id={k} lang={lang} label={t[k]} />
								<input id={"r" + k} type="number" min={k === "agents" || k === "polish" ? 0 : 1} max={k === "agents" ? 8 : k === "gens" ? 10 : 3} value={params[k]} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} />
							</div>
						))}
						<fieldset className="contenders">
							<legend>{t.contenders} <HelpTip id="contenders" lang={lang} label={t.contenders} /></legend>
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
								<HelpTip id="start" lang={lang} label={t.startLabel} />
						</div>
						{run ? <div className={"pill" + (run.active ? " pill--accent" : "")}>{(run.contenders ?? [run.mode]).join(` ${t.versus} `)} · {run.gen}/{run.gens}</div> : null}
						{run?.note ? <div className="notice">{run.note}</div> : null}
					</div>
					<div className="panel">
						<h2>{t.yours} <HelpTip id="code" lang={lang} label={t.yours} /></h2>
						<textarea rows={7} spellCheck={false} placeholder={current ? `function ${current.task.fn}(...) { ... }` : ""} value={code} onChange={(e) => setCode(e.target.value)} />
						<div className="row"><button className="btn btn--primary" disabled={!current} title={current ? undefined : t.noTaskYet} onClick={() => { const source = code; setCode(""); void act("/code", { author: name, source }); }}>{t.submit}</button></div>
					</div>
				</aside>
				<section>
					<span className="eyebrow">{t.eyebrow}</span>
					<h1>{t.title}</h1>
					<p className="lead">{t.lead}</p>
					{busy ? <div className="notice">{busy}</div> : null}
					{error ? <div className="notice">{error}</div> : null}
					{timeline.length ? (
						<div className="timeline">
							{timeline.map((i) => i.b
								? <BlockView key={i.key} sid={sid} b={i.b} t={t} lang={lang} run={run ?? null} open={open.has(i.b.blockId)} focused={focusBlock?.blockId === i.b.blockId} openCode={openCode} onToggle={() => setOpen((cur) => toggleSet(cur, i.b!.blockId))} onFocus={() => setFocus(i.b!.blockId)} onCode={(id) => setOpenCode((cur) => toggleSet(cur, id))} onDelete={() => setConfirmDel(i.b!)} onStop={() => setConfirmStop(i.b!)} onVeto={(candidateId, reason, undo) => void act("/veto", { candidateId, by: name, reason, undo })} onHint={(blockId, text) => void act("/hint", { blockId, text, by: name })} onContinue={() => void continueRun()} />
								: <div key={i.key} className={"msg" + (i.m!.author === "system" ? " msg--system" : "")}><b>{i.m!.author}</b>{i.m!.text}</div>)}
						</div>
					) : <div className="empty">{t.noBlocks}</div>}
				</section>
				<aside>
					<div className="panel">
						<h2>{t.board} <HelpTip id="board" lang={lang} label={t.board} /></h2>
						{blockLabel ? <div className="forblock">{t.forBlock} {blockLabel}</div> : null}
						{board.length ? <table className="board"><tbody>{board.map((c, i) => <tr key={c.candidateId}><td>{i + 1}. {c.author}</td><td>{fmtMs(c.ms)}</td></tr>)}</tbody></table> : <div className="empty">{t.nobest}</div>}
					</div>
					{standings.length > 1 || (standings.length === 1 && standings[0]!.via !== "scripted") ? (
						<div className="panel">
							<h2>{t.standings} <HelpTip id="standings" lang={lang} label={t.standings} /></h2>
							<table className="board"><tbody>{standings.map((e, i) => <tr key={e.via}><td>{i + 1}. {e.via}</td><td>{e.ok}/{e.n} {t.correctN} · {fmtMs(e.best)}</td></tr>)}</tbody></table>
						</div>
					) : null}
					<div className="panel">
						<h2>{t.best} <HelpTip id="best" lang={lang} label={t.best} /></h2>
						{blockLabel ? <div className="forblock">{t.forBlock} {blockLabel}</div> : null}
						{focusBlock?.best ? <CodeBlock key={focusBlock.best.candidateId} sid={sid} c={focusBlock.best} fn={focusBlock.task.fn} t={t} /> : <div className="empty">{t.nobest}</div>}
					</div>
				</aside>
			</main>
			{confirmStop ? (
				<ConfirmDialog title={t.stopTitle} text={t.stopText(`${confirmStop.task.title[lang]} (${confirmStop.task.fn})`, run?.gen ?? 0, run?.gens ?? 0)} yes={t.stopYes} no={t.no}
					onNo={() => setConfirmStop(null)}
					onYes={() => { setConfirmStop(null); void act("/stop", {}); }} />
			) : null}
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
