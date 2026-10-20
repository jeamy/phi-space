// Optional model agents for the codemode chat. Off unless CODEMODE_CHAT_LLM=1 and credentials exist (same resolution as
// the --live examples: environment keys or ~/.pi/agent/auth.json). Guards: a model whitelist (codestral-latest and the
// newest haiku), at most 2 calls in flight (more wait for a slot), CODEMODE_LLM_PER_MIN (default 20) per minute (a
// full minute waits for the next) and CODEMODE_LLM_PER_DAY (default 500) per day, because any visitor can start a run
// with model agents; beyond the day budget the caller falls back to scripted agents. Several models can take part in
// one run: the caller names the model. Agents are teammates: each sees the cases, the team's attempts with their test
// results, and the notes, and repairs, explores or improves (teamPrompt).
import { liveModels } from "../../examples/live-models.ts";
import type { Task } from "./tasks.ts";

const CALLS_PER_MIN = Number(process.env.CODEMODE_LLM_PER_MIN ?? 20);
const CALLS_PER_DAY = Number(process.env.CODEMODE_LLM_PER_DAY ?? 500);
let dayStart = 0, dayCalls = 0;
type Shared = { models: any; model: any; label: string };
let shared: Promise<Shared | null> | null = null;
let on = true, inFlight = 0, windowStart = 0, calls = 0;
const slotWaiters: Array<() => void> = [];

export type LlmInfo = { enabled: boolean; on: boolean; current: string | null; models: { id: string; label: string }[] };

const whitelist = (avail: readonly any[]): any[] => {
	const codestral = avail.filter((m) => String(m.id).toLowerCase() === "codestral-latest");
	const haiku = avail.filter((m) => String(m.id).toLowerCase().includes("haiku")).sort((a, b) => String(b.id).localeCompare(String(a.id)));
	return [...codestral, ...(haiku.length ? [haiku[0]] : [])];
};

function sharedModel(): Promise<Shared | null> {
	shared ??= (async () => {
		if (!["1", "true", "on"].includes((process.env.CODEMODE_CHAT_LLM ?? "").toLowerCase())) return null;
		try {
			const { models } = await liveModels();
			const list = whitelist(await models.getAvailable());
			const wanted = process.env.CODEMODE_CHAT_MODEL?.toLowerCase();
			const model = (wanted && list.find((m) => String(m.id).toLowerCase().includes(wanted))) || list[0];
			return model ? { models, model, label: `${model.provider}/${model.id}` } : null;
		} catch { return null; }
	})();
	return shared;
}

export async function llmInfo(): Promise<LlmInfo> {
	const s = await sharedModel();
	if (!s) return { enabled: false, on: false, current: null, models: [] };
	return { enabled: true, on, current: s.label, models: whitelist(await s.models.getAvailable()).map((m) => ({ id: String(m.id), label: `${m.provider}/${m.id}` })) };
}

export async function setLlm(o: { on?: boolean; model?: string }): Promise<LlmInfo> {
	const s = await sharedModel();
	if (s) {
		if (typeof o.on === "boolean") on = o.on;
		if (o.model) {
			const m = whitelist(await s.models.getAvailable()).find((x) => `${x.provider}/${x.id}` === o.model || String(x.id) === o.model);
			if (m) { s.model = m; s.label = `${m.provider}/${m.id}`; }
		}
	}
	return llmInfo();
}

export const llmAvailable = async () => (await sharedModel()) !== null && on;

/** Labels (`provider/id`) of the models that may take part in a run. */
export async function llmModels(): Promise<string[]> {
	const s = await sharedModel();
	return s && on ? whitelist(await s.models.getAvailable()).map((m) => `${m.provider}/${m.id}`) : [];
}

const STYLES = [
	"You favour the simplest correct code.",
	"You favour the algorithm with the best asymptotic running time.",
	"You favour tight loops and typed arrays; micro-optimise.",
	"You like unusual ideas, but the result must stay correct.",
];

/** What a team member does this turn: repair a failing attempt, try a new approach, or improve a correct solution. */
export type Role = "repair" | "explore" | "improve" | "revise" | "merge";
/** A teammate's critique of an attempt: who wrote it and what it says. */
export type CritiqueRef = { author: string; via: string; text: string };
/** An earlier contribution as the team sees it: who, how far it got, what went wrong, its code. */
export type Attempt = { candidateId: string; author: string; via: string; gen: number; ok: boolean; ms: number | null; passed?: number; total?: number; error?: string; cases?: Array<{ call: string; ok: boolean; got?: string; expect?: string; error?: string }>; rejected?: string; source: string };
/** `human`: a person's hint, which the agents follow before their own notes. */
export type Note = { author: string; gen: number; text: string; human?: boolean };
/** Everything an agent gets: the task with its cases, its role, the attempt to work on, others for reference, notes. */
export type TeamContext = { task: Task; lang: "de" | "en"; agent: number; gen: number; model?: string; role?: Role; target?: Attempt | null; others?: Attempt[]; rejected?: Attempt[]; notes?: Note[]; best?: { source: string; ms: number } | null;
	/** revise: the critique to work with; merge: the second attempt to combine with `target`. */
	critique?: CritiqueRef; partner?: Attempt };

const clipText = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "\n// … (cut)" : s);
const showValue = (v: unknown) => { const s = JSON.stringify(v); return s === undefined ? "undefined" : s.length > 200 ? s.slice(0, 200) + "…" : s; };

/** The cases as the agents see them: the exact calls and what they must return (or that the rule decides). */
export function describeCases(task: Task): string {
	const want = (c: Task["cases"][number]) => (Object.hasOwn(c, "expectAny") ? ` must return one of ${c.expectAny!.map(showValue).join(", ")}` : Object.hasOwn(c, "expect") ? ` must return ${showValue(c.expect)}` : "");
	// with a check rule the examples stay visible: they show the shape of a right answer
	const lines = task.cases.slice(0, 12).map((c) => `  ${task.fn}(${c.args.map(showValue).join(", ")})${task.check !== undefined && want(c) ? `${want(c).replace(" must return", " may return, for example,")}` : want(c)}`);
	if (task.cases.length > 12) lines.push(`  … and ${task.cases.length - 12} more`);
	return lines.join("\n");
}

const describeAttempt = (a: Attempt, full: boolean) => {
	const head = `${a.author} (${a.via}, generation ${a.gen}): ${a.ok ? `correct, ${a.ms} ms` : `${a.passed ?? 0} of ${a.total ?? "?"} cases passed`}${a.error && !a.ok ? `; first problem: ${a.error}` : ""}`;
	const cases = full && a.cases?.length ? "\nCase results:\n" + a.cases.slice(0, 8).map((c) => `  ${c.ok ? "✓" : "✗"} ${c.call} → ${c.error ? `throws ${c.error}` : c.got}${!c.ok && c.expect !== undefined ? ` (expected ${c.expect})` : ""}`).join("\n") : "";
	return `${head}${cases}\n\`\`\`js\n${clipText(a.source, full ? 4000 : 1500)}\n\`\`\``;
};

/** The prompt of one turn: a teammate, not a competitor. */
export function teamPrompt(c: TeamContext): { system: string; user: string } {
	const role = c.role ?? (c.best ? "improve" : "explore");
	const t = c.task;
	const parts = [
		`Task: ${t.prompt.en}`,
		`Write a JavaScript function named \`${t.fn}\`. It is called exactly like in these test cases:\n${describeCases(t)}`,
		...(t.check !== undefined ? [`A result passes when this check rule returns true for it (any result that satisfies the rule is right):\n\`\`\`js\n${t.check}\n\`\`\``] : []),
		`Time limit: all test cases together must finish within ${(t.timeoutMs ?? 5000) / 1000} seconds in a QuickJS interpreter (much slower than V8), so the algorithm must be efficient.`,
		"Rules: plain JavaScript (QuickJS), no imports, no I/O, no timers. Results must be plain JSON values. COMPUTE the result: never write an example result (or any expected answer) into the code as a literal, also when the function takes no arguments. Code that returns hard-coded answers is rejected.",
	];
	if (c.rejected?.length) parts.push("NOT like this. These attempts were rejected; do not repeat their approach:\n" + c.rejected.map((a) => `- ${a.author} (${a.via}, generation ${a.gen}), ${a.rejected}:\n\`\`\`js\n${clipText(a.source, 800)}\n\`\`\``).join("\n"));
	const hints = c.notes?.filter((n) => n.human) ?? [], notes = c.notes?.filter((n) => !n.human) ?? [];
	if (hints.length) parts.push("Guidance from the people you work for. FOLLOW it; it outranks everything else here:\n" + hints.map((n) => `- ${n.author}: ${n.text}`).join("\n"));
	if (notes.length) parts.push("Notes from your team (insights so far):\n" + notes.map((n) => `- ${n.author} (gen ${n.gen}): ${n.text}`).join("\n"));
	if (role === "repair" && c.target) parts.push(`Your job: REPAIR this attempt. Keep what works, fix what fails; the case results show where it goes wrong.\n${describeAttempt(c.target, true)}`);
	else if (role === "improve" && c.target) parts.push(`Your job: IMPROVE this correct solution: make it faster or simpler. It must stay correct on every case.\n${describeAttempt(c.target, true)}`);
	else if (role === "revise" && c.target && c.critique) parts.push(`Your job: REVISE this attempt using the critique a teammate wrote about it. Take the critique seriously, but check it: if a point is wrong, say so in your NOTE.\n${describeAttempt(c.target, true)}\nCritique by ${c.critique.author} (${c.critique.via}):\n${c.critique.text}`);
	else if (role === "merge" && c.target && c.partner) parts.push(`Your job: MERGE these two attempts into one that keeps what each does right; together they pass more cases than either alone.\nAttempt A: ${describeAttempt(c.target, true)}\nAttempt B: ${describeAttempt(c.partner, true)}`);
	else parts.push(`Your job: EXPLORE. Write a solution with an approach of your own${c.others?.length ? ", different from the attempts below where they fail" : ""}.`);
	if (c.others?.length) parts.push("Other attempts of the team (for reference; reuse what helps):\n" + c.others.map((a) => describeAttempt(a, false)).join("\n\n"));
	parts.push("Answer with exactly one ```js block holding the complete function (and its helpers). After the block you may add ONE line `NOTE: …` (at most 300 characters) with an insight the next teammates should know.");
	return {
		system: `You are agent ${c.agent} in a team that solves a programming task together through a shared space (generation ${c.gen + 1}). Everyone sees every attempt, its test results and the team's notes; you build on each other's work. ${STYLES[c.agent % STYLES.length]}`,
		user: parts.join("\n\n"),
	};
}

/** The critic's prompt: a teammate's attempt, its results, and what to look for. Critique, no code. */
export function critiquePrompt(c: { task: Task; agent: number; target: Attempt; others?: Attempt[]; notes?: Note[] }): { system: string; user: string } {
	const t = c.task;
	const hints = c.notes?.filter((n) => n.human) ?? [];
	return {
		system: `You are agent ${c.agent}, the critic in a team that solves a programming task together through a shared space. You do not write the solution; you tell its author precisely what is wrong and how to fix it, so the next teammate can repair it. ${STYLES[c.agent % STYLES.length]}`,
		user: [
			`Task: ${t.prompt.en}`,
			`The function \`${t.fn}\` is called like in these test cases:\n${describeCases(t)}`,
			...(t.check !== undefined ? [`A result passes when this check rule returns true:\n\`\`\`js\n${t.check}\n\`\`\``] : []),
			`Time limit: ${(t.timeoutMs ?? 5000) / 1000} seconds in a slow QuickJS interpreter.`,
			...(hints.length ? ["Guidance from the people you work for (it outranks everything):\n" + hints.map((n) => `- ${n.author}: ${n.text}`).join("\n")] : []),
			`The attempt to critique, by ${c.target.author}:\n${describeAttempt(c.target, true)}`,
			...(c.others?.length ? ["Other attempts of the team, for comparison:\n" + c.others.map((a) => describeAttempt(a, false)).join("\n\n")] : []),
			`Write your critique to ${c.target.author}: the concrete bugs or wrong ideas (with the line or construct), why the failing cases fail, what is too slow and why, and a precise fix for each point. If it is correct, say what would make it faster or simpler. If the approach cannot work, say so and name a better one. At most 12 short points, no code blocks longer than 5 lines. Plain text.`,
		].join("\n\n"),
	};
}

/** One critique of a teammate's attempt (text) with the model label and the call's usage. */
export async function llmCritique(c: { task: Task; agent: number; target: Attempt; others?: Attempt[]; notes?: Note[]; model?: string }): Promise<{ text: string; model: string; usage?: Usage }> {
	const p = critiquePrompt(c);
	const { text, model, usage } = await guardedCall(c.model, p.system, p.user, 900);
	const clean = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").trim(); // keeps line breaks: a critique is a list of points
	return { text: clean.length > 2500 ? clean.slice(0, 2499) + "…" : clean, model, usage };
}

/** Pull the program out of a model answer: the first fenced block, else the whole text. */
export function extractCode(text: string): string {
	const m = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/i.exec(text);
	return (m ? m[1]! : text).trim();
}

/** A text cut to `max` characters at a word boundary, with "…" when something was cut. */
export const clipWords = (t: string, max: number): string => {
	const s = t.replace(/\s+/g, " ").trim();
	if (s.length <= max) return s;
	const cut = s.slice(0, max - 1), space = cut.lastIndexOf(" ");
	return (space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, "") + "…";
};

/** The `NOTE: …` line after the code block, if any (at most 300 characters, cut at a word). */
export function extractNote(text: string): string | undefined {
	const after = text.slice(text.lastIndexOf("```") + 3);
	const m = /^\s*NOTE:\s*(.+)$/im.exec(after);
	return m ? clipWords(m[1]!, 300) : undefined;
}

/** Tokens and cost of one model call as pi-ai reports them; the cost is the model's catalog (list) price in US
 *  dollars, a guide only when the access is a subscription. */
export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; total: number; costUsd: number };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
/** pi-ai's usage of an answer, reduced to plain numbers (zeros when the provider reported none). */
export function usageOf(res: any): Usage {
	const u = res?.usage ?? {};
	const input = num(u.input), output = num(u.output), cacheRead = num(u.cacheRead), cacheWrite = num(u.cacheWrite);
	return { input, output, cacheRead, cacheWrite, total: num(u.totalTokens) || input + output + cacheRead + cacheWrite, costUsd: num(u.cost?.total) };
}
/** Usages added up. */
export const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, total: a.total + b.total, costUsd: a.costUsd + b.costUsd });
export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, costUsd: 0 };

/** One guarded model call (whitelist, day budget, minute window, two in flight): the answer text and the model label.
 *  A full minute window waits for the next one (a run is teamwork, not a race against the limit). */
async function guardedCall(modelLabel: string | undefined, system: string, user: string, maxTokens: number): Promise<{ text: string; model: string; usage: Usage }> {
	const s = await sharedModel();
	if (!s || !on) throw new Error("model agents are off");
	const model = modelLabel ? whitelist(await s.models.getAvailable()).find((m) => `${m.provider}/${m.id}` === modelLabel) : s.model;
	if (!model) throw new Error(`model ${modelLabel} is not allowed`);
	for (;;) {
		if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); calls = 0; }
		if (Date.now() - dayStart >= 86_400_000) { dayStart = Date.now(); dayCalls = 0; }
		if (dayCalls >= CALLS_PER_DAY) throw new Error("daily model budget used up");
		if (calls < CALLS_PER_MIN) break;
		await new Promise((ok) => setTimeout(ok, Math.max(250, windowStart + 60_000 - Date.now())));
	}
	calls++; dayCalls++;
	if (inFlight >= 2) await new Promise<void>((ok) => slotWaiters.push(ok)); // wait for a free slot instead of failing
	inFlight++;
	try {
		const res: any = await s.models.completeSimple(model, {
			systemPrompt: system,
			messages: [{ role: "user", content: user, timestamp: Date.now() }],
		}, { maxTokens, signal: AbortSignal.timeout(60_000) });
		const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
		if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
		return { text, model: `${model.provider}/${model.id}`, usage: usageOf(res) };
	} finally { inFlight--; slotWaiters.shift()?.(); }
}

/** One model contribution: source, the model label and an optional note; throws when the guards or the model say no. */
export async function llmContribution(c: TeamContext): Promise<{ source: string; model: string; note?: string; usage?: Usage }> {
	const p = teamPrompt(c);
	const { text, model, usage } = await guardedCall(c.model, p.system, p.user, 1500);
	const note = extractNote(text);
	return { source: extractCode(text), model, usage, ...(note ? { note } : {}) };
}

/** The verifier agent's prompt: from the description and the example results, a rule that accepts every right answer
 *  (not only the examples). `feedback`: why the previous rule was refused. */
export function verifierPrompt(task: Task, feedback?: string): { system: string; user: string } {
	return {
		system: "You write test oracles: predicates that decide whether a result is a correct answer to a specified programming task.",
		user: [
			`A JavaScript function \`${task.fn}\` is specified as:\n${task.prompt.en}`,
			`Example calls, each with a right result:\n${describeCases(task)}`,
			`Write a JavaScript arrow function \`(result, args) => boolean\` that returns true exactly when \`result\` is a correct answer for the call with these \`args\` (the argument array), according to the specification. The calls may pass no arguments (args is then []): the task's parameters (sizes, limits, counts) are then given in the description, so take them from there and write them into the rule as constants. Several different answers may be right: check the properties the specification demands; do not just compare with the examples. It must accept every example result above, and return false (not throw) for results of a wrong type or shape. Plain JavaScript, no imports, no I/O; result and args are plain JSON values.`,
			...(feedback ? [`Your previous rule was refused: ${feedback}. Write a better one.`] : []),
			"Answer with exactly one ```js block that holds only the arrow function expression.",
		].join("\n\n"),
	};
}

/** The model the verifier agent uses: CODEMODE_VERIFIER_MODEL (part of the id, default "haiku": an oracle must be
 *  exact, and in a live golomb run codestral only wrote rules too lax to pass the cross-check), else the default model. */
export async function verifierModel(): Promise<string | undefined> {
	const s = await sharedModel();
	if (!s) return undefined;
	const wanted = (process.env.CODEMODE_VERIFIER_MODEL || "haiku").toLowerCase();
	const m = whitelist(await s.models.getAvailable()).find((x) => String(x.id).toLowerCase().includes(wanted));
	return m ? `${m.provider}/${m.id}` : undefined;
}

/** The verifier agent: a check rule for a custom task, written by verifierModel() (or `model`). */
export async function llmVerifier(c: { task: Task; feedback?: string; model?: string }): Promise<{ check: string; model: string; usage?: Usage }> {
	const p = verifierPrompt(c.task, c.feedback);
	const { text, model, usage } = await guardedCall(c.model ?? (await verifierModel()), p.system, p.user, 800);
	return { check: extractCode(text).replace(/;\s*$/, ""), model, usage };
}
