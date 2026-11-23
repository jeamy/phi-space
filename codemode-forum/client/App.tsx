"use client";
// The forum's page. A room holds plan tasks; each is a block with its documents (one per table). The page shows the
// run, the discussion with its ballots and objections, each table's document version by version (also as the
// difference between two versions, and both tables side by side), the comparison of the two tables and the standings
// (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 11).
import { useEffect, useMemo, useState } from "react";
import { AdminPanel } from "./AdminPanel.tsx";
import { ThemeControls } from "./ThemeControls.tsx";
import { diffCount, diffText, withContext, type Line } from "./lib/diff.ts";
import { renderSection } from "./lib/safe-markdown.ts";
import { useTheme } from "./lib/theme.ts";

type RunInfo = { active: boolean; runId: string; blockId: string; table: "A" | "B"; round?: number; rounds?: number; objections?: { raised: number; open: number }; models: string[]; perModel: number; aliases: Record<string, string>; phase: "rollcall" | "kickoff" | "discuss" | "outline" | "pick" | "draft" | "check" | "turn" | "review" | "revise" | "stalled" | "accepted" | "done" | "tables" | "compare" | "final"; both?: boolean; tables?: Partial<Record<"A" | "B", TableInfo>>; base?: { table: "A" | "B"; how: "accepted" | "compared" | "only"; version: number; prefer?: { A: number; B: number } }; final?: { points: number; agreed?: number; accepted?: boolean; active?: TableInfo }; result?: { table: "A" | "B"; version: number }; turn?: string; ballots?: { round: number; approve: number; of: number }; accepted?: { version: number; round: number; approvals: number; of: number }; writer?: string; check?: { version: number; ok: boolean; failures: number; round: number }; talk?: { messages: number; decisions: number }; doc?: { table: string; version: number; sections: number; written: number }; items: { open: number; done: number }; usage: { tokens: number; costUsd: number }; budget: { tokens?: number; usd?: number }; note?: string; ended?: "budget" | "models" | "checks" | "rounds" | "stalled" };
type TableInfo = { active: boolean; phase: RunInfo["phase"]; round?: number; rounds?: number; accepted?: { version: number; round: number; approvals: number; of: number }; ended?: string; usage: { tokens: number; costUsd: number }; doc?: { version: number; sections: number; written: number }; turn?: string };
type Answer = { runId: string; model: string; alias: string; agent: number; text: string; ts: number };
type SectionRef = { sectionId: string; rev: number; title: string; hash: string; bytes: number; author: string; model: string; origin?: string };
type Table = "A" | "B";
type Outcome = { chosen: { table: Table; version: number; how: "person" | "result" | "majority" | "draft" } | null; stat: { base: Table; how: "accepted" | "compared" | "only"; prefer?: Record<Table, number>; tables: Partial<Record<Table, { rounds: number; tokens: number; costUsd: number; accepted: boolean; approvals: number }>>; final?: { points: number; agreed: number; accepted: boolean }; result: { table: Table; version: number } } | null; compares: Array<{ model: string; prefer: Table; criteria: Array<{ n: number; prefer: Table; text: string }>; points: Array<{ table: Table; fromTitle: string; intoTitle: string; text: string }> }> };
type Source = { sourceId: string; kind: "docs" | "repo"; name: string; commit?: string; ref?: string; files: number; bytes: number };
type Check = { ok: boolean; failures: Array<{ check: string; sectionId?: string; text: string }> } | null;
type Block = { result: { table: "A" | "B"; version: number } | null; blockId: string; table: "A" | "B"; heads: Partial<Record<Table, number>>; accepted: { version: number; by: "majority" | "person"; who?: string; approvals: string[]; of: number; round?: number } | null; brief: string; lang: "de" | "en"; outline: string[]; criteria: string[]; ts: number; sources: Source[]; talk: { messages: number; decisions: number; forPerson: number }; doc: { table: string; version: number; versions: number; bytes: number; sections: SectionRef[]; check: Check } | null };
type Snapshot = { standings?: { runs: number; A: number; B: number; tokens: Record<Table, number> }; session: string; blocks: Block[]; run: RunInfo | null; rollcall: Answer[]; lines: Array<{ text: string; ts: number }>; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number } };
type PlanView = { blockId: string; check: Check; doc: { version: number; bytes: number; author: string; model: string; changed: string[]; ts: number; sections: Array<SectionRef & { text: string }> }; versions: Array<{ version: number; author: string; model: string; changed: string[]; ts: number }> };
type Message = { msgId: string; thread: string; kind: "understanding" | "question" | "answer" | "proposal" | "vote" | "objection" | "note"; author: string; model: string; to?: string; stance?: "agree" | "disagree"; text: string; ts: number };
type Decision = { thread: string; text: string; agreed: string[]; against: string[]; of: number };
type Objection = { objId: string; sectionId: string; defect: string; fix: string; quote?: string; model: string; round: number; state: "open" | "resolved" | "confirmed" | "declined" | "withdrawn" | "note"; revisedIn?: number };
type Ballot = { round: number; version: number; model: string; vote: "approve" | "reject"; counts: boolean; why?: string; criteria: Array<{ n: number; met: boolean; text: string; backed?: boolean }> };
type Talk = { blockId: string; messages: Message[]; decisions: Decision[]; objections: Objection[]; ballots: Ballot[] };
type Models = { enabled: boolean; on: boolean; models: Array<{ id: string; label: string }> };
type System = { hosts: Array<{ name: string; roles: string[]; host: { cpu: string; cores: number; memGiB: number } }>; today: { calls: number; tokens: number; costUsd: number } };

const T = {
	de: {
		room: "Raum", live: "live", offline: "getrennt", off: "Modelle aus", models: "Modelle",
		task: "Planaufgabe", brief: "Auftrag: wofür ist der Plan, was muss er leisten?", docLang: "Sprache des Dokuments", outline: "Gliederung vorgeben (optional, eine Überschrift je Zeile)", criteria: "Eigene Kriterien (optional, eines je Zeile)", create: "Aufgabe anlegen",
		sources: "Quellen (optional, nur lesend)", docs: "Dokumente (.md, .txt, .csv, .json, .yaml; bis 10, zusammen 800 kB)", repo: "Repository", noRepo: "kein Repository", ref: "Branch, Tag oder Commit (leer: HEAD)", sourceNote: "Die Modelle lesen in diesen Quellen. Auszüge daraus gehen an die Anbieter der gewählten Modelle.", drop: "entfernen",
		srcDocs: (n: number) => `${n} Dokument${n === 1 ? "" : "e"}`, srcRepo: (name: string, commit: string, n: number) => `Repository ${name} bei ${commit} (${n} Dateien)`,
		run: "Lauf", on: "Aufgabe", pick: (min: number, max: number) => `Modelle am Tisch (${min} bis ${max})`, perModel: "Agenten je Modell", tokens: "Budget Tokens", usd: "Budget $",
		start: "Lauf starten", stop: "Stopp", none: "Keine Modelle verfügbar. Ein Admin schaltet sie frei (FORUM_LLM=1 und Zugangsdaten beim Modell-Prozess).",
		need: (n: number) => `Ein Lauf braucht mindestens ${n} verschiedene Modelle.`, noTask: "Lege zuerst eine Planaufgabe an.",
		lead: "Mindestens drei KI-Modelle entwickeln hier gemeinsam einen Plan: Sie schreiben, diskutieren, prüfen einander und stimmen ab, bis eine Mehrheit zustimmt. Zwei Arbeitsweisen treten gegeneinander an; die bessere liefert das Ergebnis.",
		helpLink: "Hilfe", theTable: "der Tisch", side: "nebeneinander", compareWith: "vergleichen mit", noCompare: "kein Vergleich", previous: "vorheriger Fassung", unchanged: "unverändert", newSection: "neuer Abschnitt", removedSection: "entfernt", linesChanged: (d: number, a: number) => `−${d} +${a} Zeilen`, gap: (n: number) => `… ${n} unveränderte Zeile${n === 1 ? "" : "n"} …`, origin: "übernommen aus", settled: (n: number) => `${n} erledigte${n === 1 ? "r Einwand" : " Einwände"}`, exportIt: "Ergebnis mit Anhang (.md)", thisVersion: "diese Fassung (.md)", isResult: "Ergebnis",
		outcome: "Vergleich der beiden Tische", prefers: (x: string) => `zieht Tisch ${x} vor`, better: (x: string) => `Tisch ${x} macht besser`, statTable: "Tisch", statRounds: "Runden", statTokens: "Tokens", statCost: "Kosten", statAgreed: "einig", statApprovals: "Zustimmungen", statBase: "Basis", yes: "ja", no: "nein",
		standingsTitle: "Stand der Arbeitsweisen", standingsLead: (r: number) => `${r} ${r === 1 ? "Lauf" : "Läufe"} mit beiden Tischen bisher`, timesBase: "als Basis des Ergebnisses", tokensAll: "Tokens insgesamt", ballotDetails: (n: number) => `Kriterien je Stimme (Runde ${n})`, met: "erfüllt", notMet: "nicht erfüllt", unbacked: "ohne Beleg im Plan",
		chosenHow: { person: "von einer Person angenommen", result: "Ergebnis des Laufs mit beiden Tischen", majority: "von der Mehrheit angenommen", draft: "neuester Entwurf, nicht angenommen" },
		table: "Am Tisch", waiting: "noch keine Antwort", active: "läuft", ended: "beendet", budgetUsed: "Budget verbraucht", fewModels: "zu wenige Modelle", items: (d: number, o: number) => `${d} erledigt, ${o} offen`,
		phase: { rollcall: "Appell", kickoff: "Auftakt", discuss: "Diskussion", outline: "Gliederung", pick: "Gliederung wählen", draft: "Entwurf", check: "Prüfung", turn: "am Zug", review: "Abstimmung", revise: "Überarbeitung", stalled: "festgefahren: Frage an dich", accepted: "angenommen", done: "fertig", tables: "beide Tische arbeiten", compare: "Blindvergleich", final: "gemeinsame Schlussrunde" },
		wayBoth: "Beide Tische im Wettbewerb, dann Vergleich und gemeinsame Schlussrunde", baseIs: (x: string, how: string) => `Basis: Tisch ${x} (${how})`, howAccepted: "als einziger einig", howCompared: (a: number, n: number) => `von ${a} von ${n} Modellen bevorzugt`, howOnly: "einziges Dokument", finalIs: (a: number, n: number, ok?: boolean) => `Schlussrunde: ${a} von ${n} Punkten übernommen${ok === undefined ? "" : ok ? ", angenommen" : ", nicht angenommen: die Basis bleibt"}`, resultIs: (x: string, v: number) => `Ergebnis: Tisch ${x}, Fassung ${v}`, otherFirst: "der andere Tisch war zuerst einig", standings: (r: number, a: number, b: number) => `Bisher ${r} Läufe mit beiden Tischen: Tisch A ${a}-mal Basis, Tisch B ${b}-mal`,
		ballots: "Abstimmungen", roundN: (n: number) => `Runde ${n}`, approve: "stimmt zu", reject: "lehnt ab", notCounted: "zählt nicht", acceptedBy: (v: number, how: string) => `Fassung ${v} angenommen (${how})`, byMajority: (a: number, n: number) => `${a} von ${n} Modellen`, byPerson: (w: string) => `von ${w}`,
		acceptIt: "👍 Diese Fassung annehmen", objectTo: "👎 Einwand gegen einen Abschnitt", objectPh: "Was stimmt nicht? (kann kein Modell ablehnen)", noMajority: "keine Mehrheit in den Runden", failsChecks: "besteht die Prüfung nicht", stuckEnd: "festgefahren",
		objStates: { open: "offen", resolved: "aufgegriffen", confirmed: "bestätigt", declined: "abgelehnt", withdrawn: "zurückgezogen", note: "Notiz" },
		way: "Arbeitsweise", wayB: "Tisch B: alle schreiben gleichzeitig und prüfen einander", wayA: "Tisch A: abwechselnd, ein Modell nach dem anderen ist am Zug", rounds: "Runden", hasTurn: "am Zug", round: (n: number, of: number) => `Runde ${n} von ${of}`, tableName: (x: string) => `Tisch ${x}`,
		objections: "Einwände", objOpen: "offen", objResolved: "aufgegriffen", objDeclined: "abgelehnt", fix: "Abhilfe", inVersion: (v: number) => `in Fassung ${v}`,
		checkOk: "Prüfung bestanden", checkBad: (n: number) => `${n} Befund${n === 1 ? "" : "e"} der Prüfung`, unchecked: "nicht geprüft", found: "Was das Prüfprogramm gefunden hat", whole: "Dokument",
		talk: "Diskussion", noTalk: "Noch nichts gesagt. Die Modelle sprechen beim Auftakt eines Laufs; du kannst jederzeit etwas sagen.", decided: "Entschieden", agreed: (a: number, n: number) => `${a} von ${n} dafür`, understandings: "So verstehen die Modelle den Auftrag", forYou: "Frage an dich", answerPh: "Deine Antwort …", sayPh: "Dem Tisch etwas sagen (gilt vor jeder Entscheidung) …", send: "Senden", you: "Person",
		kind: { understanding: "Verständnis", question: "Frage", answer: "Antwort", proposal: "Vorschlag", vote: "Stimme", objection: "Einwand", note: "Notiz" }, to: "an", all: "alle", person: "die Person", agree: "dafür", disagree: "dagegen", written: (w: number, n: number) => `${w} von ${n} Abschnitten geschrieben`, writer: "schreibt",
		doc: "Dokument", noDoc: "Noch kein Dokument. Es beginnt mit dem ersten Lauf auf dieser Aufgabe.", version: "Fassung", newest: "neueste", by: "von", rev: "Rev.", changed: "geändert", markdown: "Markdown", intent: "noch nicht geschrieben; soll sagen:",
		tasks: "Aufgaben", log: "Protokoll", empty: "Noch keine Planaufgabe in diesem Raum.", hosts: "Prozesse", today: (c: number, t: number) => `heute ${c} Modellaufrufe, ${t} Tokens`,
	},
	en: {
		room: "room", live: "live", offline: "offline", off: "models off", models: "models",
		task: "Plan task", brief: "Brief: what is the plan for, what must it achieve?", docLang: "Language of the document", outline: "Fix the outline (optional, one heading a line)", criteria: "Criteria of your own (optional, one a line)", create: "Create task",
		sources: "Sources (optional, read-only)", docs: "Documents (.md, .txt, .csv, .json, .yaml; up to 10, 800 kB together)", repo: "Repository", noRepo: "no repository", ref: "Branch, tag or commit (empty: HEAD)", sourceNote: "The models read in these sources. Excerpts of them go to the providers of the chosen models.", drop: "remove",
		srcDocs: (n: number) => `${n} document${n === 1 ? "" : "s"}`, srcRepo: (name: string, commit: string, n: number) => `repository ${name} at ${commit} (${n} files)`,
		run: "Run", on: "Task", pick: (min: number, max: number) => `Models at the table (${min} to ${max})`, perModel: "Agents per model", tokens: "Budget tokens", usd: "Budget $",
		start: "Start run", stop: "Stop", none: "No models available. An admin allows them (FORUM_LLM=1 and credentials at the model process).",
		need: (n: number) => `A run needs at least ${n} different models.`, noTask: "Create a plan task first.",
		lead: "At least three AI models develop one plan together here: they write, discuss, review each other and vote until a majority agrees. Two ways of working compete; the better one supplies the result.",
		helpLink: "Help", theTable: "the table", side: "side by side", compareWith: "compare with", noCompare: "no comparison", previous: "the version before", unchanged: "unchanged", newSection: "new section", removedSection: "removed", linesChanged: (d: number, a: number) => `−${d} +${a} lines`, gap: (n: number) => `… ${n} unchanged line${n === 1 ? "" : "s"} …`, origin: "taken over from", settled: (n: number) => `${n} settled objection${n === 1 ? "" : "s"}`, exportIt: "Result with appendix (.md)", thisVersion: "this version (.md)", isResult: "result",
		outcome: "Comparison of the two tables", prefers: (x: string) => `prefers table ${x}`, better: (x: string) => `table ${x} does better`, statTable: "Table", statRounds: "Rounds", statTokens: "Tokens", statCost: "Cost", statAgreed: "agreed", statApprovals: "Approvals", statBase: "Base", yes: "yes", no: "no",
		standingsTitle: "Standings of the ways of working", standingsLead: (r: number) => `${r} run${r === 1 ? "" : "s"} with both tables so far`, timesBase: "times the base of the result", tokensAll: "tokens in all", ballotDetails: (n: number) => `Criteria per ballot (round ${n})`, met: "met", notMet: "not met", unbacked: "no words of the plan",
		chosenHow: { person: "accepted by a person", result: "result of the run with both tables", majority: "accepted by the majority", draft: "newest draft, not accepted" },
		table: "At the table", waiting: "no answer yet", active: "running", ended: "ended", budgetUsed: "budget used up", fewModels: "too few models", items: (d: number, o: number) => `${d} done, ${o} open`,
		phase: { rollcall: "roll call", kickoff: "kickoff", discuss: "discussion", outline: "outline", pick: "picking the outline", draft: "draft", check: "check", turn: "turn", review: "ballots", revise: "revision", stalled: "stuck: a question to you", accepted: "accepted", done: "done", tables: "both tables at work", compare: "blind comparison", final: "joint final round" },
		wayBoth: "Both tables in competition, then the comparison and a joint final round", baseIs: (x: string, how: string) => `base: table ${x} (${how})`, howAccepted: "the only one that agreed", howCompared: (a: number, n: number) => `preferred by ${a} of ${n} models`, howOnly: "the only document", finalIs: (a: number, n: number, ok?: boolean) => `final round: ${a} of ${n} points taken over${ok === undefined ? "" : ok ? ", accepted" : ", not accepted: the base stays"}`, resultIs: (x: string, v: number) => `result: table ${x}, version ${v}`, otherFirst: "the other table agreed first", standings: (r: number, a: number, b: number) => `${r} runs with both tables so far: table A the base ${a} times, table B ${b} times`,
		ballots: "Ballots", roundN: (n: number) => `round ${n}`, approve: "approves", reject: "rejects", notCounted: "does not count", acceptedBy: (v: number, how: string) => `version ${v} accepted (${how})`, byMajority: (a: number, n: number) => `${a} of ${n} models`, byPerson: (w: string) => `by ${w}`,
		acceptIt: "👍 Accept this version", objectTo: "👎 Object to a section", objectPh: "What is wrong? (no model can decline it)", noMajority: "no majority within the rounds", failsChecks: "does not pass the checks", stuckEnd: "stuck",
		objStates: { open: "open", resolved: "taken up", confirmed: "confirmed", declined: "declined", withdrawn: "withdrawn", note: "note" },
		way: "Way of working", wayB: "Table B: all write at the same time and review each other", wayA: "Table A: taking turns, one model after the other", rounds: "Rounds", hasTurn: "has the turn", round: (n: number, of: number) => `round ${n} of ${of}`, tableName: (x: string) => `table ${x}`,
		objections: "Objections", objOpen: "open", objResolved: "taken up", objDeclined: "declined", fix: "fix", inVersion: (v: number) => `in version ${v}`,
		checkOk: "checks passed", checkBad: (n: number) => `${n} finding${n === 1 ? "" : "s"} of the check`, unchecked: "not checked", found: "What the checking program found", whole: "document",
		talk: "Discussion", noTalk: "Nothing said yet. The models speak at the kickoff of a run; you can say something at any time.", decided: "Decided", agreed: (a: number, n: number) => `${a} of ${n} agreed`, understandings: "How the models understand the brief", forYou: "Question to you", answerPh: "Your answer …", sayPh: "Say something to the table (it outranks any decision) …", send: "Send", you: "person",
		kind: { understanding: "understanding", question: "question", answer: "answer", proposal: "proposal", vote: "vote", objection: "objection", note: "note" }, to: "to", all: "all", person: "the person", agree: "agrees", disagree: "disagrees", written: (w: number, n: number) => `${w} of ${n} sections written`, writer: "writes",
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
	const [way, setWay] = useState<"both" | "parallel" | "turns">("both");
	const [rounds, setRounds] = useState(2);
	const [budgetTokens, setBudgetTokens] = useState("100000");
	const [budgetUsd, setBudgetUsd] = useState("");
	const [admin, setAdmin] = useState(false);
	const [msg, setMsg] = useState("");
	const [brief, setBrief] = useState("");
	const [docLang, setDocLang] = useState<"de" | "en" | "">("");
	const [outline, setOutline] = useState("");
	const [criteria, setCriteria] = useState("");
	const [docs, setDocs] = useState<Array<{ name: string; text: string }>>([]);
	const [repos, setRepos] = useState<string[]>([]);
	const [repo, setRepo] = useState("");
	const [ref, setRef] = useState("");
	const [focus, setFocus] = useState<string | null>(null); // the block shown; null: the newest
	const [tableSel, setTableSel] = useState<Table | "side" | null>(null); // the table shown; null: the block's; "side": both
	const [talks, setTalks] = useState<{ blockId: string; by: Partial<Record<Table, Talk>> } | null>(null);
	const [outcome, setOutcome] = useState<(Outcome & { blockId: string }) | null>(null);
	const [say, setSay] = useState("");
	const [answers_, setAnswers_] = useState<Record<string, string>>({}); // drafts of answers, by the question's id
	const rid = encodeURIComponent(room);

	useEffect(() => {
		const fromHash = () => setRoom(decodeURIComponent(location.hash.slice(1)) || "lobby");
		fromHash();
		window.addEventListener("hashchange", fromHash);
		return () => window.removeEventListener("hashchange", fromHash);
	}, []);

	useEffect(() => {
		let dead = false, ws: WebSocket | null = null, retry = 0, timer: ReturnType<typeof setTimeout> | undefined;
		setSnap(null); setFocus(null); setTableSel(null);
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

	// the repositories a task may read in: only an admin is told them
	useEffect(() => {
		if (!admin) { setRepos([]); setRepo(""); return; }
		api<{ repos: string[] }>("/sources").then((x) => setRepos(x.repos)).catch(() => {});
	}, [admin]);
	const addDocs = async (files: FileList | null) => {
		const read = await Promise.all([...(files ?? [])].map(async (f) => ({ name: f.name, text: await f.text() })));
		setDocs((cur) => [...cur.filter((d) => !read.some((r) => r.name === d.name)), ...read]);
	};

	const blocks = snap?.blocks ?? [];
	const block = blocks.find((b) => b.blockId === focus) ?? blocks.at(-1) ?? null;
	// the tables that have a document on this block, and the one shown (both: side by side)
	const docTables = (["A", "B"] as const).filter((x) => block?.heads[x]);
	const sideBySide = tableSel === "side" && docTables.length === 2;
	const shown: Table = tableSel && tableSel !== "side" && block?.heads[tableSel] ? tableSel : block?.table ?? "A";
	// what changes whenever the work on the block goes on: the discussion, the documents and the outcome follow it
	const r_ = snap?.run;
	const bump = block ? `${block.blockId}:${block.table}:${block.talk.messages}:${block.talk.decisions}:${block.heads.A ?? 0}:${block.heads.B ?? 0}:${block.accepted?.version ?? 0}:${block.result?.version ?? 0}:${block.doc?.check?.ok ?? ""}:${r_?.phase ?? ""}:${r_?.active ?? ""}:${r_?.items.done ?? 0}:${r_?.objections?.raised ?? 0}:${r_?.objections?.open ?? 0}:${snap?.lines.at(-1)?.ts ?? 0}` : "";
	// what changes a document as it is shown without a new version: its check, its acceptance, the run's phase
	const docKey = block ? `${block.doc?.check?.ok ?? ""}:${block.doc?.check?.failures.length ?? 0}:${block.accepted?.version ?? 0}:${r_?.phase ?? ""}:${r_?.active ?? ""}` : "";
	// the discussion of each table that is shown (its messages, decisions, objections and ballots)
	const wanted = block ? (sideBySide ? docTables : [shown]).join("") : "";
	useEffect(() => {
		if (!block) { setTalks(null); return; }
		let dead = false;
		Promise.all([...wanted].map(async (x) => [x, { blockId: block.blockId, ...(await api<Omit<Talk, "blockId">>(`/rooms/${rid}/talk/${block.blockId}?table=${x}`)) }] as const))
			.then((got) => { if (!dead) setTalks({ blockId: block.blockId, by: Object.fromEntries(got) }); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, bump, wanted]);
	// how the run with both tables went (the comparison, the numbers of each table), once there is something to show
	const hasOutcome = !!block && (!!block.result || (r_?.blockId === block.blockId && !!r_.base));
	useEffect(() => {
		if (!block || !hasOutcome) { setOutcome(null); return; }
		let dead = false;
		api<Outcome>(`/rooms/${rid}/outcome/${block.blockId}`).then((x) => { if (!dead) setOutcome({ blockId: block.blockId, ...x }); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, bump, hasOutcome]);

	const available = models?.enabled && models.on ? models.models : [];
	const limits = snap?.limits ?? { minModels: 3, maxModels: 5, maxPerModel: 3, visitorTokens: 0 };
	const picked = available.filter((m) => chosen.has(m.label)).map((m) => m.label);
	const run = snap?.run ?? null;
	const act = async (fn: () => Promise<unknown>) => { setMsg(""); try { await fn(); } catch (e) { setMsg((e as Error).message); } };
	const create = () => act(async () => {
		const r = await api<{ blockId: string }>(`/rooms/${rid}/task`, { brief, lang: docLang || lang, outline, criteria, ...(docs.length ? { docs } : {}), ...(repo ? { repo: { name: repo, ref } } : {}) });
		setBrief(""); setOutline(""); setCriteria(""); setDocs([]); setRepo(""); setRef(""); setFocus(r.blockId); setTableSel(null);
	});
	const start = () => act(() => api(`/rooms/${rid}/run`, { blockId: block?.blockId, way, rounds, models: picked, perModel, budgetTokens: budgetTokens || undefined, budgetUsd: budgetUsd || undefined }));
	const toggle = (label: string, add: boolean) => setChosen((cur) => { const n = new Set(cur); if (add) n.add(label); else n.delete(label); return n; });
	const answers = new Map((snap?.rollcall ?? []).map((a) => [a.model, a]));
	const table = run ? [...run.models].sort((a, b) => (run.aliases[a] ?? "").localeCompare(run.aliases[b] ?? "")) : [];
	const runHere = run && block && run.blockId === block.blockId ? run : null;
	const speak = (thread?: string) => act(async () => {
		const text = thread ? answers_[thread] ?? "" : say;
		await api(`/rooms/${rid}/message`, { blockId: block?.blockId, text, ...(thread ? { thread } : {}) });
		if (thread) setAnswers_((cur) => { const { [thread]: _sent, ...rest } = cur; return rest; }); else setSay("");
	});
	const talkOf = (x: Table) => (talks && block && talks.blockId === block.blockId ? talks.by[x] ?? null : null);
	const said = talkOf(shown);
	const result = outcome && block && outcome.blockId === block.blockId ? outcome : null;
	// a run with both tables may end with an older version as its result (a final round that did not agree)
	const resultOf = (x: Table) => (block?.result && block.result.table === x && !snap?.run?.active ? block.result.version : 0);
	const who = (m: { model: string; author: string }) => (m.model === "human" ? `${t.you} (${m.author})` : name(m.model));
	const threads = (said?.messages ?? []).filter((m) => m.thread === m.msgId && m.kind !== "understanding");
	const name = (model: string) => (model === "table" ? t.theTable : model === "human" ? t.you : runHere?.aliases[model] ? `${runHere.aliases[model]} · ${model}` : model);

	return (
		<>
			<header className="top">
				<span className="brand">PHI-SPACES / <b>CODEMODE FORUM</b></span>
				<span className="spacer" />
				<span className="pill">{t.room}: {room}</span>
				<span className={"pill" + (live ? " pill--accent" : "")}>{live ? t.live : t.offline}</span>
				<span className="pill">{available.length ? `${available.length} ${t.models}` : t.off}</span>
				<a className="toplink" href={`/help?lang=${lang}`}>{t.helpLink}</a>
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
						<details open={docs.length > 0 || !!repo}>
							<summary>{t.sources}</summary>
							<label className="fieldlabel" htmlFor="docs">{t.docs}</label>
							<input id="docs" type="file" multiple accept=".md,.markdown,.txt,.csv,.json,.yaml,.yml" onChange={(e) => { void addDocs(e.target.files); e.target.value = ""; }} />
							{docs.map((d) => <div key={d.name} className="row"><span>{d.name}</span><span className="muted">{(new Blob([d.text]).size / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB</span><button type="button" className="btn" onClick={() => setDocs((cur) => cur.filter((x) => x.name !== d.name))}>{t.drop}</button></div>)}
							{admin && repos.length ? (
								<div className="row">
									<label htmlFor="repo">{t.repo}</label>
									<select id="repo" value={repo} onChange={(e) => setRepo(e.target.value)}><option value="">{t.noRepo}</option>{repos.map((r) => <option key={r} value={r}>{r}</option>)}</select>
									{repo ? <input aria-label={t.ref} placeholder={t.ref} value={ref} onChange={(e) => setRef(e.target.value)} /> : null}
								</div>
							) : null}
							{docs.length || repo ? <div className="notice">{t.sourceNote}</div> : null}
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
									<label htmlFor="way">{t.way}</label>
									<select id="way" value={way} onChange={(e) => setWay(e.target.value as "both" | "parallel" | "turns")}><option value="both">{t.wayBoth}</option><option value="parallel">{t.wayB}</option><option value="turns">{t.wayA}</option></select>
								</div>
								<div className="row"><label htmlFor="rounds">{t.rounds}</label><input id="rounds" type="number" min={0} max={8} value={rounds} onChange={(e) => setRounds(Math.min(8, Math.max(0, Number(e.target.value) || 0)))} /></div>
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
							{blocks.map((b) => <button key={b.blockId} type="button" role="tab" aria-selected={b.blockId === block?.blockId} className={"tasks__tab" + (b.blockId === block?.blockId ? " is-active" : "")} onClick={() => { setFocus(b.blockId); setTableSel(null); }}>{firstLine(b.brief, 48)}</button>)}
						</div>
					) : null}
					{block ? (
						<>
							<div className="panel">
								<h2>{t.task}</h2>
								<p className="briefing">{block.brief}</p>
								{block.criteria.length ? <ul className="criteria">{block.criteria.map((c) => <li key={c}>{c}</li>)}</ul> : null}
								{block.sources.length ? <div className="runline sources">{block.sources.map((x) => <span key={x.sourceId} className="pill">{x.kind === "repo" ? t.srcRepo(x.name, (x.commit ?? "").slice(0, 12), x.files) : t.srcDocs(x.files)}</span>)}</div> : null}
							</div>
							{runHere ? (
								<div className="panel">
									<h2>{t.run}</h2>
									<div className="runline">
										<span className={"pill" + (runHere.active ? " pill--accent" : "")}>{runHere.active ? t.active : t.ended}</span>
										{runHere.both ? null : <span className="pill">{t.tableName(runHere.table)}</span>}
										<span className="pill">{t.phase[runHere.phase]}{runHere.round ? ` · ${t.round(runHere.round, runHere.rounds ?? runHere.round)}` : ""}</span>
										{runHere.turn ? <span className="pill">{runHere.aliases[runHere.turn] ?? "?"} {t.hasTurn}</span> : null}
										{runHere.doc ? <span className="pill">{t.written(runHere.doc.written, runHere.doc.sections)}</span> : null}
										<span className="pill">{t.items(runHere.items.done, runHere.items.open)}</span>
										<span className="pill">{runHere.usage.tokens.toLocaleString(locale)}{runHere.budget.tokens ? ` / ${runHere.budget.tokens.toLocaleString(locale)}` : ""} Tokens{runHere.usage.costUsd ? ` · $${runHere.usage.costUsd.toFixed(4)}` : ""}{runHere.budget.usd ? ` / $${runHere.budget.usd}` : ""}</span>
										{runHere.ballots ? <span className="pill">{t.byMajority(runHere.ballots.approve, runHere.ballots.of)} {t.approve}</span> : null}
										{runHere.ended ? <span className="pill">{runHere.ended === "budget" ? t.budgetUsed : runHere.ended === "models" ? t.fewModels : runHere.ended === "rounds" ? t.noMajority : runHere.ended === "checks" ? t.failsChecks : t.stuckEnd}</span> : null}
									</div>
									{runHere.both ? (
										<div className="runline">
											{(["A", "B"] as const).map((x) => { const i = runHere.tables?.[x]; return i ? <span key={x} className={"pill" + (i.active ? " pill--accent" : "")}>{t.tableName(x)}: {i.accepted ? t.acceptedBy(i.accepted.version, t.byMajority(i.accepted.approvals, i.accepted.of)) : i.ended === "other" ? t.otherFirst : t.phase[i.phase]}{i.round && !i.accepted ? ` · ${t.round(i.round, i.rounds ?? i.round)}` : ""}{i.turn ? ` · ${runHere.aliases[i.turn] ?? "?"} ${t.hasTurn}` : ""} · {i.usage.tokens.toLocaleString(locale)} Tokens</span> : null; })}
											{runHere.base ? <span className="pill">{t.baseIs(runHere.base.table, runHere.base.how === "accepted" ? t.howAccepted : runHere.base.how === "only" ? t.howOnly : t.howCompared(runHere.base.prefer?.[runHere.base.table] ?? 0, (runHere.base.prefer?.A ?? 0) + (runHere.base.prefer?.B ?? 0)))}</span> : null}
											{runHere.final ? <span className="pill">{t.finalIs(runHere.final.agreed ?? 0, runHere.final.points, runHere.final.accepted)}</span> : null}
											{runHere.result ? <span className="pill pill--accent">{t.resultIs(runHere.result.table, runHere.result.version)}</span> : null}
										</div>
									) : null}
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
							{docTables.length === 2 ? (
								<div className="tasks" role="tablist" aria-label={t.way}>
									{docTables.map((x) => <button key={x} type="button" role="tab" aria-selected={!sideBySide && shown === x} className={"tasks__tab" + (!sideBySide && shown === x ? " is-active" : "")} onClick={() => setTableSel(x)}>{t.tableName(x)}{block.result?.table === x ? ` · ${t.isResult}` : ""}</button>)}
									<button type="button" role="tab" aria-selected={sideBySide} className={"tasks__tab" + (sideBySide ? " is-active" : "")} onClick={() => setTableSel("side")}>{t.side}</button>
								</div>
							) : null}
							{result && (result.stat || result.compares.length) ? <OutcomePanel t={t} locale={locale} o={result} name={name} /> : null}
							<div className="panel">
								<h2>{t.talk}{docTables.length === 2 ? ` · ${t.tableName(shown)}` : ""}</h2>
								{said && (said.messages.length || said.decisions.length || said.objections.length || said.ballots.length) ? (
									<div className="talk">
										{said.decisions.map((x) => <div key={x.thread} className="talk__decision"><b>{t.decided}</b> {x.text} <span className="muted">({t.agreed(x.agreed.length, x.of)})</span></div>)}
										{said.messages.some((m) => m.kind === "understanding") ? (
											<details>
												<summary>{t.understandings}</summary>
												{said.messages.filter((m) => m.kind === "understanding").map((m) => <div key={m.msgId} className="msg"><b>{who(m)}</b>{m.text}</div>)}
											</details>
										) : null}
										{said.ballots.length ? (
											<details open>
												<summary>{t.ballots}</summary>
												{[...new Set(said.ballots.map((b) => `${b.round}:${b.version}`))].map((rv) => { const n = Number(rv.split(":")[0]), v = Number(rv.split(":")[1]); return (
													<div key={rv} className="msg"><b>{t.roundN(n)} · {t.version} {v}</b>{said.ballots.filter((b) => b.round === n && b.version === v).map((b) => <span key={b.model} className={"chip " + (b.counts ? "chip--ok" : b.vote === "approve" ? "chip--wait" : "chip--bad")} title={b.why ?? ""}>{name(b.model)}: {b.vote === "approve" ? t.approve : t.reject}{b.vote === "approve" && !b.counts ? ` (${t.notCounted}${b.why ? `: ${b.why}` : ""})` : ""}</span>)}</div>
												); })}
												{(() => {
													const last = Math.max(...said.ballots.map((b) => b.round));
													return (
														<details className="ballots">
															<summary>{t.ballotDetails(last)}</summary>
															{said.ballots.filter((b) => b.round === last).map((b) => (
																<div key={b.model} className="msg"><b>{name(b.model)}</b>
																	<ul>{b.criteria.map((c) => <li key={c.n}><span className={"chip " + (c.met ? (c.backed === false ? "chip--wait" : "chip--ok") : "chip--bad")}>{c.n}: {c.met ? t.met : t.notMet}{c.met && c.backed === false ? ` (${t.unbacked})` : ""}</span> <span className="muted">{c.text}</span></li>)}</ul>
																</div>
															))}
														</details>
													);
												})()}
											</details>
										) : null}
										{said.objections.length ? (
											<details open={said.objections.some((o) => o.state === "open")}>
												<summary>{t.objections} ({said.objections.length})</summary>
												{said.objections.map((o) => (
													<div key={o.objId} className="msg">
														<b>{name(o.model)}</b><span className={"chip " + (o.state === "open" ? "chip--wait" : o.state === "declined" ? "chip--bad" : "chip--ok")}>{t.objStates[o.state]}{o.revisedIn ? ` ${t.inVersion(o.revisedIn)}` : ""}</span>
														<i>{block.doc?.sections.find((x) => x.sectionId === o.sectionId)?.title ?? o.sectionId}:</i> {o.defect} <span className="muted">{t.fix}: {o.fix}</span>
													</div>
												))}
											</details>
										) : null}
										{threads.map((root) => {
											const replies = said.messages.filter((m) => m.thread === root.thread && m.msgId !== root.msgId);
											const open = root.kind === "question" && root.to === "person" && !replies.some((m) => m.model === "human");
											return (
												<div key={root.msgId} className={"talk__thread" + (open ? " is-open" : "")}>
													<div className="msg"><b>{who(root)}</b><span className="chip">{open ? t.forYou : t.kind[root.kind]}{root.to && !open ? ` ${t.to} ${root.to === "all" ? t.all : root.to === "person" ? t.person : name(root.to)}` : ""}</span> {root.text}</div>
													{replies.map((m) => <div key={m.msgId} className="msg talk__reply"><b>{who(m)}</b>{m.kind === "vote" ? <span className={"chip " + (m.stance === "agree" ? "chip--ok" : "chip--bad")}>{m.stance === "agree" ? t.agree : t.disagree}</span> : null} {m.text}</div>)}
													{open ? (
														<form className="row" onSubmit={(e) => { e.preventDefault(); void speak(root.msgId); }}>
															<input className="wide" maxLength={2000} placeholder={t.answerPh} aria-label={t.answerPh} value={answers_[root.msgId] ?? ""} onChange={(e) => setAnswers_((cur) => ({ ...cur, [root.msgId]: e.target.value }))} />
															<button type="submit" className="btn btn--primary" disabled={!(answers_[root.msgId] ?? "").trim()}>{t.send}</button>
														</form>
													) : null}
												</div>
											);
										})}
									</div>
								) : <div className="empty">{t.noTalk}</div>}
								<form className="row" onSubmit={(e) => { e.preventDefault(); void speak(); }}>
									<input className="wide" maxLength={2000} placeholder={t.sayPh} aria-label={t.sayPh} value={say} onChange={(e) => setSay(e.target.value)} />
									<button type="submit" className="btn" disabled={!say.trim()}>{t.send}</button>
								</form>
							</div>
							<div className={sideBySide ? "docs docs--side" : "docs"}>
								{(sideBySide ? docTables : [shown]).map((x) => (
									<DocPane key={`${block.blockId}:${x}`} t={t} locale={locale} rid={rid} block={block} table={x} head={block.heads[x] ?? 0} titled={docTables.length === 2} resultVersion={resultOf(x)} objections={talkOf(x)?.objections ?? []} docKey={docKey} name={name} act={act} />
								))}
							</div>
						</>
					) : <div className="empty">{t.empty}</div>}
					{snap?.standings?.runs ? <StandingsPanel t={t} locale={locale} s={snap.standings} /> : null}
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

type Text = (typeof T)[keyof typeof T];
type Named = (model: string) => string;

/** One table's document: a version of it, optionally as the difference to another version, with the objections beside
 *  their sections, the checker's findings, and the person's yes and no. */
function DocPane({ t, locale, rid, block, table, head, titled, resultVersion, objections, docKey, name, act }: { t: Text; locale: string; rid: string; block: Block; table: Table; head: number; titled: boolean; resultVersion: number; objections: Objection[]; docKey: string; name: Named; act: (fn: () => Promise<unknown>) => Promise<void> }) {
	const [version, setVersion] = useState<number | null>(null); // the version shown; null: the result, else the newest
	const [against, setAgainst] = useState<"" | "prev" | number>(""); // the version it is compared with
	const [view, setView] = useState<PlanView | null>(null);
	const [base, setBase] = useState<PlanView | null>(null);
	const [objSection, setObjSection] = useState("");
	const [objText, setObjText] = useState("");
	const want = version || resultVersion || 0;
	// the texts are fetched when the version asked for, the newest version or the state of the work changes
	useEffect(() => {
		if (!head) { setView(null); return; }
		let dead = false;
		api<PlanView>(`/rooms/${rid}/plan/${block.blockId}?table=${table}${want ? `&version=${want}` : ""}`).then((x) => { if (!dead) setView(x); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, block.blockId, table, head, want, docKey]);
	const shownVersion = view?.doc.version ?? 0;
	const baseVersion = !shownVersion || against === "" ? 0 : against === "prev" ? shownVersion - 1 : against === shownVersion ? 0 : against;
	useEffect(() => {
		if (!baseVersion) { setBase(null); return; }
		let dead = false;
		api<PlanView>(`/rooms/${rid}/plan/${block.blockId}?table=${table}&version=${baseVersion}`).then((x) => { if (!dead) setBase(x); }).catch(() => {});
		return () => { dead = true; };
	}, [rid, block.blockId, table, baseVersion]);

	const sections = useMemo(() => (view?.doc.sections ?? []).map((s) => ({ ...s, html: renderSection(s.text) })), [view]);
	// the difference to the other version, section by section: what a section was there, and what is gone
	const delta = useMemo(() => {
		if (!view || !base || base.doc.version !== baseVersion) return null;
		const old = new Map(base.doc.sections.map((s) => [s.sectionId, s]));
		const by = new Map(view.doc.sections.map((s): [string, { kind: "new" | "same" | "changed"; lines: Line[] }] => {
			const was = old.get(s.sectionId);
			if (!was) return [s.sectionId, { kind: "new", lines: diffText("", s.text) }];
			if (was.hash === s.hash) return [s.sectionId, { kind: "same", lines: [] }];
			return [s.sectionId, { kind: "changed", lines: diffText(was.title === s.title ? was.text : `# ${was.title}\n${was.text}`, was.title === s.title ? s.text : `# ${s.title}\n${s.text}`) }];
		}));
		return { by, removed: base.doc.sections.filter((s) => !view.doc.sections.some((x) => x.sectionId === s.sectionId)) };
	}, [view, base, baseVersion]);

	const acceptNow = () => act(() => api(`/rooms/${rid}/accept`, { blockId: block.blockId, version: view?.doc.version, table }));
	const objectNow = () => act(async () => { await api(`/rooms/${rid}/objection`, { blockId: block.blockId, table, section: objSection || view?.doc.sections[0]?.sectionId, text: objText }); setObjText(""); });
	const standing = (o: Objection) => o.state === "open" || o.state === "declined";
	const isResultTable = (block.result?.table ?? block.table) === table;

	return (
		<div className="panel">
			<h2>{t.doc}{titled ? ` · ${t.tableName(table)}` : ""}{block.result?.table === table ? ` · ${t.isResult}` : ""}</h2>
			{head && view && view.blockId === block.blockId ? (
				<>
					<div className="runline">
						<label htmlFor={`version-${table}`} className="muted">{t.version}</label>
						<select id={`version-${table}`} value={version ?? ""} onChange={(e) => setVersion(e.target.value ? Number(e.target.value) : null)}>
							<option value="">{resultVersion ? `${t.isResult} (${resultVersion})` : `${t.newest} (${head})`}</option>
							{[...view.versions].reverse().map((v) => <option key={v.version} value={v.version}>{v.version} · {name(v.model)}</option>)}
						</select>
						{view.versions.length > 1 ? (
							<>
								<label htmlFor={`against-${table}`} className="muted">{t.compareWith}</label>
								<select id={`against-${table}`} value={against} onChange={(e) => setAgainst(e.target.value === "" ? "" : e.target.value === "prev" ? "prev" : Number(e.target.value))}>
									<option value="">{t.noCompare}</option>
									{shownVersion > 1 ? <option value="prev">{t.previous} ({shownVersion - 1})</option> : null}
									{[...view.versions].reverse().filter((v) => v.version !== shownVersion).map((v) => <option key={v.version} value={v.version}>{v.version} · {name(v.model)}</option>)}
								</select>
							</>
						) : null}
						<span className="pill">{(view.doc.bytes / 1000).toLocaleString(locale, { maximumFractionDigits: 1 })} kB</span>
						<span className={"chip " + (view.check ? (view.check.ok ? "chip--ok" : "chip--bad") : "chip--wait")}>{view.check ? (view.check.ok ? t.checkOk : t.checkBad(view.check.failures.length)) : t.unchecked}</span>
						{block.accepted && block.table === table ? <span className="chip chip--best">{t.acceptedBy(block.accepted.version, block.accepted.by === "person" ? t.byPerson(block.accepted.who ?? "") : t.byMajority(block.accepted.approvals.length, block.accepted.of))}</span> : null}
						{isResultTable ? <a className="toplink" href={`/api/plan/${rid}/${block.blockId}.md`} target="_blank" rel="noreferrer">{t.exportIt}</a> : null}
						<a className="toplink" href={`/api/rooms/${rid}/plan/${block.blockId}.md?table=${table}&version=${view.doc.version}&plain=1`} target="_blank" rel="noreferrer">{t.thisVersion}</a>
					</div>
					{view.check && !view.check.ok ? (
						<details className="findings" open>
							<summary>{t.found}</summary>
							<ul>{view.check.failures.map((f, i) => <li key={i}><b>{view.doc.sections.find((x) => x.sectionId === f.sectionId)?.title ?? t.whole}:</b> {f.text}</li>)}</ul>
						</details>
					) : null}
					<div className="row">
						<button type="button" className="btn" onClick={() => void acceptNow()}>{t.acceptIt}</button>
						<select aria-label={t.objectTo} value={objSection} onChange={(e) => setObjSection(e.target.value)}>{view.doc.sections.map((x) => <option key={x.sectionId} value={x.sectionId}>{x.title}</option>)}</select>
						<input className="wide" maxLength={600} placeholder={t.objectPh} aria-label={t.objectPh} value={objText} onChange={(e) => setObjText(e.target.value)} />
						<button type="button" className="btn" disabled={!objText.trim()} onClick={() => void objectNow()}>{t.objectTo}</button>
					</div>
					<article className="doc">
						{sections.map((s) => {
							const d = delta?.by.get(s.sectionId), mine = objections.filter((o) => o.sectionId === s.sectionId), settled = mine.filter((o) => !standing(o) && o.state !== "note").length;
							const marked = d ? d.kind !== "same" : view.doc.changed.includes(s.sectionId), n = d ? diffCount(d.lines) : null;
							return (
								<section key={s.sectionId} className={marked ? "doc__section is-changed" : "doc__section"}>
									<h3>{s.title} <span className="muted">{t.rev} {s.rev} · {name(s.model)}{d ? ` · ${d.kind === "same" ? t.unchanged : d.kind === "new" ? t.newSection : t.linesChanged(n!.del, n!.add)}` : view.doc.changed.includes(s.sectionId) ? ` · ${t.changed}` : ""}</span></h3>
									{s.origin ? <p className="muted doc__origin">{t.origin} {s.origin}</p> : null}
									{mine.filter(standing).map((o) => <div key={o.objId} className="doc__objection"><span className={"chip " + (o.state === "open" ? "chip--wait" : "chip--bad")}>{t.objStates[o.state]}</span> <b>{o.model === "human" ? t.you : name(o.model)}</b> {o.defect} <span className="muted">{t.fix}: {o.fix}</span></div>)}
									{settled ? <div className="muted doc__settled">{t.settled(settled)}</div> : null}
									{d ? (d.kind === "same" ? null : <DiffLines t={t} lines={d.lines} />) : s.rev === 1 ? <p className="muted">{t.intent} {s.text}</p> : <div dangerouslySetInnerHTML={{ __html: s.html }} />}
								</section>
							);
						})}
						{(delta?.removed ?? []).map((s) => (
							<section key={s.sectionId} className="doc__section is-changed">
								<h3>{s.title} <span className="muted">{t.removedSection}</span></h3>
								<DiffLines t={t} lines={diffText(s.text, "")} />
							</section>
						))}
					</article>
				</>
			) : <div className="empty">{t.noDoc}</div>}
		</div>
	);
}

/** The lines of a difference: removed and added lines marked, the words that differ inside a changed line marked
 *  again, long unchanged stretches cut. The text is shown as text, never as HTML. */
function DiffLines({ t, lines }: { t: Text; lines: Line[] }) {
	return (
		<pre className="diff">
			{withContext(lines).map((l, i) => (l.op === "gap" ? <span key={i} className="diff__gap">{t.gap(l.count)}{"\n"}</span> : (
				<span key={i} className={l.op === "same" ? "diff__same" : l.op === "del" ? "diff__del" : "diff__add"}>
					{l.op === "same" ? "  " : l.op === "del" ? "− " : "+ "}
					{l.words ? l.words.map((w, k) => (w.op === "same" ? w.text : <mark key={k}>{w.text}</mark>)) : l.text}{"\n"}
				</span>
			)))}
		</pre>
	);
}

/** How the run with both tables went: the result and why, each table in numbers, and every model's blind comparison. */
function OutcomePanel({ t, locale, o, name }: { t: Text; locale: string; o: Outcome; name: Named }) {
	return (
		<div className="panel">
			<h2>{t.outcome}</h2>
			{o.chosen ? <div className="runline"><span className="pill pill--accent">{t.resultIs(o.chosen.table, o.chosen.version)}</span><span className="pill">{t.chosenHow[o.chosen.how]}</span></div> : null}
			{o.stat ? (
				<table className="stats">
					<thead><tr><th>{t.statTable}</th><th>{t.statRounds}</th><th>{t.statTokens}</th><th>{t.statCost}</th><th>{t.statAgreed}</th><th>{t.statApprovals}</th><th>{t.statBase}</th></tr></thead>
					<tbody>
						{(["A", "B"] as const).map((x) => { const s = o.stat!.tables[x]; return s ? <tr key={x}><td>{x}</td><td>{s.rounds}</td><td>{s.tokens.toLocaleString(locale)}</td><td>{s.costUsd ? `$${s.costUsd.toFixed(4)}` : "–"}</td><td>{s.accepted ? t.yes : t.no}</td><td>{s.approvals}</td><td>{o.stat!.base === x ? `✓${o.stat!.prefer ? ` (${o.stat!.prefer[x]} / ${o.stat!.prefer.A + o.stat!.prefer.B})` : ""}` : ""}</td></tr> : null; })}
					</tbody>
				</table>
			) : null}
			{o.stat?.final ? <div className="fieldlabel">{t.finalIs(o.stat.final.agreed, o.stat.final.points, o.stat.final.accepted)}</div> : null}
			{o.compares.map((c) => (
				<details key={c.model} className="compare">
					<summary><b>{name(c.model)}</b> {t.prefers(c.prefer)}</summary>
					<ul>
						{c.criteria.map((k) => <li key={k.n}><span className="chip">{k.n}: {t.tableName(k.prefer)}</span> {k.text}</li>)}
						{c.points.map((p, i) => <li key={`p${i}`}><span className="chip chip--ok">{t.better(p.table)}</span> {p.text} <span className="muted">„{p.fromTitle}“ → „{p.intoTitle}“</span></li>)}
					</ul>
				</details>
			))}
		</div>
	);
}

/** Over all runs with both tables: how often each way of working supplied the base of the result, and what it used. */
function StandingsPanel({ t, locale, s }: { t: Text; locale: string; s: NonNullable<Snapshot["standings"]> }) {
	return (
		<div className="panel">
			<h2>{t.standingsTitle}</h2>
			<div className="fieldlabel">{t.standingsLead(s.runs)}</div>
			<table className="stats">
				<thead><tr><th>{t.way}</th><th>{t.timesBase}</th><th>{t.tokensAll}</th></tr></thead>
				<tbody>
					<tr><td>{t.wayA}</td><td>{s.A}</td><td>{(s.tokens?.A ?? 0).toLocaleString(locale)}</td></tr>
					<tr><td>{t.wayB}</td><td>{s.B}</td><td>{(s.tokens?.B ?? 0).toLocaleString(locale)}</td></tr>
				</tbody>
			</table>
		</div>
	);
}
