// Triage between generations (docs/codemode-planung.en.md, step 9): after a generation's verdicts, the run asks what
// its contributions failed at and hands the next generation a fixed hint for that cause, as a team note. With
// `triage: "jev"` the decisions model Jev (typesafe/jev-1.13 behind OpenRouter's /api/alpha/decisions) sorts each
// failing contribution into a cause; with `triage: "fixed"` the interface hint goes out every generation, without
// Jev (the control: does Jev's choice help, or only the hint?). The judge is untouched: the note goes to the agents.
import type { Attempt } from "./llm.ts";

export type TriageMode = "jev" | "fixed";
export type TriageCause = "interface" | "rule" | "strategy" | "other";

/** What Jev chooses between; the descriptions go to Jev as the choice's criteria. */
export const TRIAGE_CAUSES: Record<TriageCause, string> = {
	interface: "the code never got the game going through the tools: it crashed (crashed is true: not a function, a property of undefined), or it saw and picked up nothing at all (piecesSeen and piecesPickedUp are 0), because it read a tool's answer in a shape the answer does not have",
	rule: "the code broke a rule or limit of the game or task (hitLimit is true): waited too long in all, spent too many points, ran out of time",
	strategy: "the code runs, keeps the rules and gets things through the tools (it saw or picked up pieces), but its plan brings too little to reach the target",
	other: "none of these, or the failure does not say",
};

/** The hint each cause sends to the next generation. */
export const TRIAGE_HINTS: Record<TriageCause, { de: string; en: string }> = {
	interface: {
		de: "Die letzte Generation scheiterte an der Schnittstelle (Format geraten, Aufruf auf undefined, nichts aufgehoben). Lies die Tool-Beschreibung im Auftrag Feld für Feld und nutze genau diese Felder. Rate kein Format.",
		en: "The last generation failed at the interface (a guessed format, a call on undefined, nothing picked up). Read the tools' description in the task field by field and use exactly those fields. Do not guess a format.",
	},
	rule: {
		de: "Die letzte Generation verletzte eine Regel (Wartezeit, Punkte, Zeit). Lies die Grenzen im Auftrag, zähle im Bot mit und höre vor der Grenze auf.",
		en: "The last generation broke a rule (waiting time, points, time). Read the limits in the task, count them in the bot and stop before a limit.",
	},
	strategy: {
		de: "Die Bots laufen und halten die Regeln, bringen aber zu wenig. Behalte den funktionierenden Code und verbessere den Plan: welche Orte, in welcher Reihenfolge, wann.",
		en: "The bots run and keep the rules but bring too little. Keep the working code and improve the plan: which places, in which order, when.",
	},
	other: { de: "", en: "" },
};

/** A team note holds at most 300 characters (room.ts addNote): every hint with Jev's counts must fit. */
export const NOTE_ROOM = 300;

const JEV_MODEL = "typesafe/jev-1.13";

/** What Jev reads of a failure: the judge's text, and the numbers in it as fields of their own (a bot's verdict says
 *  how many pieces its look saw and it picked up, how many world minutes went by, which tools it called, whether it
 *  crashed or hit a limit), so that "nothing seen, nothing picked up" stands out from "too few". */
export function failureFacts(a: Attempt): Record<string, unknown> {
	const e = a.error ?? "", num = (re: RegExp) => { const m = re.exec(e); return m ? Number(m[1]) : undefined; };
	const calls: Record<string, number> = {};
	const c = /calls: ([^)]*?)(?: = \d+ points)?\)/.exec(e);
	if (c) for (const m of c[1]!.matchAll(/([a-z]+) (\d+)/gi)) calls[m[1]!] = Number(m[2]);
	const facts: Record<string, unknown> = {
		failure: e.slice(0, 400), episodesPassed: a.passed ?? 0, episodes: a.total ?? 0,
		crashed: /not a function|of undefined|is not defined|cannot read|SyntaxError|TypeError|ReferenceError/i.test(e),
		hitLimit: /at most|limit|too many|timed out|time limit/i.test(e),
	};
	const seen = num(/(\d+) seen in a look/), picked = num(/(\d+) picked up/), minutes = num(/(\d+) world minutes gone/), reached = num(/first seed: (\d+) of/);
	if (seen !== undefined) facts.piecesSeen = seen;
	if (picked !== undefined) facts.piecesPickedUp = picked;
	if (reached !== undefined) facts.piecesInFireFirstSeed = reached;
	if (minutes !== undefined) facts.worldMinutesGone = minutes;
	if (Object.keys(calls).length) facts.toolCalls = calls;
	return facts;
}

/** Jev's cause for each failing attempt (at most 10, one call); null when Jev cannot be asked or gives no answer. */
export async function jevCauses(task: { title: string }, failing: Attempt[], key = process.env.JEV_OPENROUTER_API_KEY): Promise<{ causes: Record<string, TriageCause>; model: string } | null> {
	if (!key || !failing.length) return null;
	const list = failing.slice(0, 10);
	const state = {
		task: task.title,
		contributions: Object.fromEntries(list.map((a, i) => [`c${i + 1}`, failureFacts(a)])),
	};
	const questions = Object.fromEntries(list.map((_, i) => [`c${i + 1}`, { type: "choice", instructions: `What made contribution c${i + 1} in the state fail?`, criteria: TRIAGE_CAUSES }]));
	try {
		const r = await fetch("https://openrouter.ai/api/alpha/decisions", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": "application/json" }, body: JSON.stringify({ model: JEV_MODEL, state, questions }), signal: AbortSignal.timeout(30_000) });
		const j = await r.json() as { model?: string; answers?: Record<string, { choice: string }> };
		if (!r.ok || !j.answers) return null;
		const causes: Record<string, TriageCause> = {};
		list.forEach((a, i) => { const c = j.answers![`c${i + 1}`]?.choice; if (c && c in TRIAGE_CAUSES) causes[a.candidateId] = c as TriageCause; });
		return { causes, model: j.model ?? JEV_MODEL };
	} catch { return null; }
}

/** The cause most of the failing attempts share (ties: interface before rule before strategy), or null. */
export function mainCause(causes: Record<string, TriageCause>): TriageCause | null {
	const order: TriageCause[] = ["interface", "rule", "strategy"], n = (c: TriageCause) => Object.values(causes).filter((x) => x === c).length;
	const best = order.reduce((a, b) => (n(b) > n(a) ? b : a));
	return n(best) ? best : null;
}

/** The note for the next generation, and what it was decided by; null when no hint goes out. */
export async function triageNote(mode: TriageMode, task: { title: string }, generation: Attempt[], lang: "de" | "en"): Promise<{ text: string; via: string; cause: TriageCause } | null> {
	const failing = generation.filter((a) => !a.ok);
	if (!failing.length) return null;
	if (mode === "fixed") return { text: TRIAGE_HINTS.interface[lang], via: "fixed", cause: "interface" };
	const j = await jevCauses(task, failing);
	const cause = j && mainCause(j.causes);
	if (!j || !cause) return null;
	const counts = (["interface", "rule", "strategy", "other"] as TriageCause[]).map((c) => [c, Object.values(j.causes).filter((x) => x === c).length] as const).filter(([, k]) => k).map(([c, k]) => `${c} ${k}`).join(", ");
	return { text: `${TRIAGE_HINTS[cause][lang]} (${counts})`, via: j.model, cause };
}
