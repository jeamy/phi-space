// Tasks with tools (docs/codemode-anwendungen.en.md, A): the contribution is `async function solve()`, and its only
// inputs are the tools of the sandbox (`tools.list`, `tools.get`, …), answered by the judge from a dataset the task
// brings. No network and no model: a "classifier" is a deterministic stand-in of the task. Every call costs points;
// among correct contributions the cheapest wins, the time only breaks ties.
//
// A task has two worlds over the same tools: the SAMPLE, whose items and expected answer the agents see (it is the
// task's one case), and the HOLDOUT, which is scored and never shown. Code that writes the sample's answer in, or
// guesses the classifier's words from the sample, misses on the holdout, whose texts use words the sample does not.
import { readFileSync } from "node:fs";
import type { CaseResult } from "./judge.ts";

/** One thread of an issue tracker; `body` is the opening post (the generated datasets have none). */
export type Issue = { id: string; title: string; body?: string; comments: Array<{ by: string; text: string }> };
export type Level = "none" | "mild" | "high";
export type ToolName = "list" | "get" | "search" | "classify" | "jev";
/** What a tool costs per call (store/load of pi-codemode are free). */
export const TOOL_COST: Record<ToolName, number> = { list: 1, get: 1, search: 2, classify: 3, jev: 3 };
/** The most tool calls one execution may make; a script beyond it fails with this message. */
export const MAX_CALLS = 2000;
/** The most text one classify call may take (a script cannot classify a whole dataset in one call). */
export const MAX_CLASSIFY_CHARS = 20_000;

/** Jev's recorded answer for one issue (server/data/fetch-pi-issues.ts --jev). */
export type JevAnswer = { kind: "bug" | "feature" | "question" | "other"; confidence: number };
/** `jev`: Jev's answers by issue id, kept beside the issues (never in what `get` returns). */
export type World = { name: "sample" | "holdout"; issues: Issue[]; jev?: Record<string, JevAnswer> };
export type ToolSpec = {
	tools: ToolName[];
	sample: World;
	holdout: World;
	/** The right answer of a world, computed here from its data (never sent to a sandbox for the holdout). */
	answer: (w: World) => unknown;
	/** 0..1, how close `got` is to `want`; 1 counts as solved. */
	score: (got: unknown, want: unknown) => number;
};

// ---- the stand-in classifier: the strongest frustration a text shows, by fixed phrases --------------------------
const HIGH_SEEN = ["completely unusable", "still broken", "third time i report", "wasted my whole day"];
const HIGH_HIDDEN = ["this is ridiculous", "we are switching away", "fed up with this"];
const MILD_SEEN = ["a bit annoying", "slightly confusing", "had to retry"];
const MILD_HIDDEN = ["not ideal", "took me a while"];
const HIGH = [...HIGH_SEEN, ...HIGH_HIDDEN], MILD = [...MILD_SEEN, ...MILD_HIDDEN];

export function classify(text: string): Level {
	const t = text.toLowerCase();
	return HIGH.some((p) => t.includes(p)) ? "high" : MILD.some((p) => t.includes(p)) ? "mild" : "none";
}

// ---- the datasets: generated from a fixed seed, the same on every host -------------------------------------------
const lcg = (seed: number) => () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32;
const SUBJECTS = ["login", "export", "sync", "search", "billing", "upload", "dark mode", "notifications", "the API", "the importer"];
const PROBLEMS = ["fails on large files", "times out", "shows the wrong total", "loses the selection", "crashes on start", "ignores the setting"];
const NEUTRAL = ["Thanks for the report, we are looking into it.", "Can you share the version you use?", "I can reproduce this on my machine.", "Attached the logs from yesterday.", "Same here on the latest release.", "Is there a workaround for now?", "Moved to the next milestone.", "This should be fixed in the nightly build."];
const PEOPLE = ["ana", "ben", "chen", "dora", "emil", "fatma", "gus", "hana"];

function issues(seed: number, n: number, firstId: number, high: string[], mild: string[]): Issue[] {
	const r = lcg(seed), pick = <T>(xs: T[]) => xs[Math.floor(r() * xs.length)]!;
	return Array.from({ length: n }, (_, i) => {
		const comments = Array.from({ length: 2 + Math.floor(r() * 4) }, () => ({ by: pick(PEOPLE), text: pick(NEUTRAL) }));
		const mood = r();
		// about one in eight threads is very frustrated, one in four mildly; the phrase sits in one comment, in a sentence
		const phrase = mood < 0.12 ? pick(high) : mood < 0.37 ? pick(mild) : null;
		if (phrase) { const c = comments[Math.floor(r() * comments.length)]!; c.text = `${c.text} Honestly, ${phrase}.`; }
		return { id: `I-${firstId + i}`, title: `${pick(SUBJECTS)} ${pick(PROBLEMS)}`, comments };
	});
}

const highIds = (w: World) => w.issues.filter((i) => i.comments.some((c) => classify(c.text) === "high")).map((i) => i.id).sort(byId);
const byId = (a: string, b: string) => Number(a.slice(2)) - Number(b.slice(2));

/** F1 of two id lists as sets, 0 when `got` is not a list of strings in ascending order without repeats. */
export function idScore(got: unknown, want: unknown): number {
	if (!Array.isArray(got) || !got.every((x) => typeof x === "string") || !Array.isArray(want)) return 0;
	for (let i = 1; i < got.length; i++) if (byId(got[i - 1]!, got[i]!) >= 0) return 0;
	const w = new Set(want as string[]), hit = got.filter((x) => w.has(x)).length;
	if (!got.length && !w.size) return 1;
	return hit === 0 ? 0 : (2 * hit) / (got.length + w.size);
}

export const FRUSTRATION: ToolSpec = {
	tools: ["list", "get", "search", "classify"],
	sample: { name: "sample", issues: issues(101, 16, 1, HIGH_SEEN, MILD_SEEN) },
	holdout: { name: "holdout", issues: issues(907, 120, 1001, HIGH, MILD) },
	answer: highIds,
	score: idScore,
};

// ---- real data: issues of github.com/earendil-works/pi (server/data/fetch-pi-issues.ts) ------------------------
// Shortened and without names; a comment by the tracker's bot (it auto-closes issues of new contributors) is "bot".
// Every tenth issue (by number) is the sample, the rest the holdout.
type PiData = { source: string; fetched: string; issues: Issue[]; jev?: { model: string; labelled: string; answers: Record<string, JevAnswer> } };
const PI: PiData = JSON.parse(readFileSync(new URL("./data/pi-issues.json", import.meta.url), "utf8"));
const piSplit = (name: World["name"]): World => {
	const issues = PI.issues.filter((i) => (Number(i.id.slice(2)) % 10 === 0) === (name === "sample"));
	return { name, issues, jev: Object.fromEntries(issues.map((i) => [i.id, PI.jev!.answers[i.id]!])) };
};
/** The issues whose title or body mentions Windows and that a person (not the bot) commented on. */
const windowsAnswered = (w: World) => w.issues
	.filter((i) => `${i.title}\n${i.body ?? ""}`.toLowerCase().includes("windows") && i.comments.some((c) => c.by !== "bot"))
	.map((i) => i.id).sort(byId);

export const PI_SOURCE = { url: PI.source, fetched: PI.fetched, jevModel: PI.jev!.model, jevLabelled: PI.jev!.labelled };
const PI_SAMPLE = piSplit("sample"), PI_HOLDOUT = piSplit("holdout");
export const PI_WINDOWS: ToolSpec = {
	tools: ["list", "get", "search"],
	sample: { name: "sample", issues: PI_SAMPLE.issues },
	holdout: { name: "holdout", issues: PI_HOLDOUT.issues },
	answer: windowsAnswered,
	score: idScore,
};
/** As PI_WINDOWS, and only the issues Jev calls a bug report. */
export const PI_WINDOWS_BUGS: ToolSpec = {
	tools: ["list", "get", "search", "jev"],
	sample: PI_SAMPLE,
	holdout: PI_HOLDOUT,
	answer: (w) => (windowsAnswered(w) as string[]).filter((id) => w.jev?.[id]?.kind === "bug"),
	score: idScore,
};

// ---- the tools of one world, metered --------------------------------------------------------------------------
type CodemodeTool = { name: string; description?: string; inputSchema?: unknown; execute(args: unknown): unknown };
export type Meter = { calls: Partial<Record<ToolName, number>>; cost: number; total: number };
export const newMeter = (): Meter => ({ calls: {}, cost: 0, total: 0 });

const DESCRIPTIONS: Record<ToolName, string> = {
	list: "Lists issues, a page at a time: { after?: string (an id), limit?: number (1..50, default 20) } → { items: Array<{ id, title, comments: number }>, next: string | null }. 1 point per call.",
	get: "One issue with its comments: { id: string } → { id, title, body?, comments: Array<{ by, text }> }, or null. 1 point.",
	search: "Ids of issues whose title, body or comments contain the text (case-insensitive): { q: string, limit?: number (default 50) } → string[]. 2 points.",
	jev: `What Jev (typesafe/jev-1.13, a decisions model) answered when asked what kind of issue this is, recorded once and replayed: { id: string } → { kind: "bug" | "feature" | "question" | "other", confidence: number (0..1) }, or null. 3 points.`,
	classify: `The strongest frustration a text shows: { text: string (at most ${MAX_CLASSIFY_CHARS} characters) } → "none" | "mild" | "high". 3 points.`,
};

/** The tools of `w` for one execution; every call is counted on `m`, and a call beyond MAX_CALLS throws. */
export function worldTools(spec: ToolSpec, w: World, m: Meter): CodemodeTool[] {
	const byIdMap = new Map(w.issues.map((i) => [i.id, i]));
	const text = (i: Issue) => `${i.title}\n${i.body ?? ""}\n${i.comments.map((c) => c.text).join("\n")}`.toLowerCase();
	const arg = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
	const impl: Record<ToolName, (a: Record<string, unknown>) => unknown> = {
		list: (a) => {
			const limit = Math.max(1, Math.min(50, Math.floor(Number(a.limit ?? 20)) || 20));
			const from = typeof a.after === "string" ? w.issues.findIndex((i) => i.id === a.after) + 1 : 0;
			const page = w.issues.slice(from, from + limit);
			return { items: page.map((i) => ({ id: i.id, title: i.title, comments: i.comments.length })), next: from + limit < w.issues.length ? page.at(-1)!.id : null };
		},
		get: (a) => { const i = byIdMap.get(String(a.id)); return i ? structuredClone(i) : null; },
		search: (a) => {
			const q = String(a.q ?? "").toLowerCase(), limit = Math.max(1, Math.min(200, Math.floor(Number(a.limit ?? 50)) || 50));
			return q ? w.issues.filter((i) => text(i).includes(q)).slice(0, limit).map((i) => i.id) : [];
		},
		jev: (a) => { const j = w.jev?.[String(a.id)]; return j ? { ...j } : null; },
		classify: (a) => {
			if (typeof a.text !== "string") throw new Error("classify needs { text: string }");
			if (a.text.length > MAX_CLASSIFY_CHARS) throw new Error(`classify takes at most ${MAX_CLASSIFY_CHARS} characters`);
			return classify(a.text);
		},
	};
	return spec.tools.map((name) => ({
		name, description: DESCRIPTIONS[name],
		execute: (a: unknown) => {
			if (m.total >= MAX_CALLS) throw new Error(`more than ${MAX_CALLS} tool calls`);
			m.total++; m.calls[name] = (m.calls[name] ?? 0) + 1; m.cost += TOOL_COST[name];
			return impl[name](arg(a));
		},
	}));
}

/** The tools as the agents read them in the task text. */
export const describeTools = (spec: ToolSpec): string => spec.tools.map((n) => `- tools.${n}(args): ${DESCRIPTIONS[n]}`).join("\n");

/** The calls of a meter in words: "list 3, get 120, classify 120 = 483 points". */
export const meterText = (m: Meter): string => `${Object.entries(m.calls).map(([k, n]) => `${k} ${n}`).join(", ") || "no calls"} = ${m.cost} points`;

/** The program one world runs: the contribution as its own script, `solve()` awaited and timed. */
export function toolProgram(captured: string, fn: string, source: string): string {
	const script = `${source}\n;typeof ${fn} === "function" ? ${fn} : undefined`;
	return `${captured}
const __fn = __eval(${JSON.stringify(script)});
if (typeof __fn !== "function") return { error: "no function ${fn}" };
const __t = __now();
let __got = __apply(__fn, undefined, []);
if (__got && typeof __got.then === "function") __got = await __got;
return { ms: __now() - __t, got: __got };`;
}

export type WorldResult = { score: number; meter: Meter; ms: number; got?: unknown; error?: string };
/** A world's result as a case line; the holdout shows only its score and calls, never its items or answer. */
export function worldCase(fn: string, w: World, r: WorldResult, want: unknown, show: (v: unknown) => string): CaseResult {
	// the call stays the same for every contribution (the runs compare cases by it); what it cost goes with the result
	const call = `${fn}() on the ${w.name} (${w.issues.length} issues)`, cost = `calls: ${meterText(r.meter)}`;
	if (r.error) return { call, ok: false, error: `${r.error} (${cost})`, ...(w.name === "sample" ? { expect: show(want) } : {}) };
	const ok = r.score >= 1;
	return w.name === "sample"
		? { call, ok, got: `${show(r.got)} (${cost})`, expect: show(want) }
		: { call, ok, got: `score ${Math.round(r.score * 100)} % (${cost})`, ...(ok ? {} : { expect: "score 100 % (the holdout's items and answer stay hidden)" }) };
}
