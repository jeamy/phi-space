// Optional model agents for the codemode chat. Off unless CODEMODE_CHAT_LLM=1 and credentials exist (same resolution as
// the --live examples: environment keys or ~/.pi/agent/auth.json). Guards: a model whitelist (codestral-latest and the
// newest haiku), at most 2 calls in flight (more wait for a slot) and CODEMODE_LLM_PER_MIN (default 20) per minute;
// beyond that the caller falls back to scripted agents. Several models can take part in one run: the caller names the model.
import { liveModels } from "../../examples/live-models.ts";
import type { Task } from "./tasks.ts";

const CALLS_PER_MIN = Number(process.env.CODEMODE_LLM_PER_MIN ?? 20);
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

/** Pull the program out of a model answer: the first fenced block, else the whole text. */
export function extractCode(text: string): string {
	const m = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/i.exec(text);
	return (m ? m[1]! : text).trim();
}

/** One model contribution as JavaScript source plus the model label; throws when the guards or the model say no. */
export async function llmContribution(c: { task: Task; lang: "de" | "en"; agent: number; gen: number; best: { source: string; ms: number } | null; model?: string }): Promise<{ source: string; model: string }> {
	const s = await sharedModel();
	if (!s || !on) throw new Error("model agents are off");
	const model = c.model ? whitelist(await s.models.getAvailable()).find((m) => `${m.provider}/${m.id}` === c.model) : s.model;
	if (!model) throw new Error(`model ${c.model} is not allowed`);
	if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); calls = 0; }
	if (calls >= CALLS_PER_MIN) throw new Error("model rate limit");
	calls++;
	if (inFlight >= 2) await new Promise<void>((ok) => slotWaiters.push(ok)); // wait for a free slot instead of failing
	inFlight++;
	try {
		const prompt = `Task: ${c.task.prompt.en}
The function must be named \`${c.task.fn}\`. Rules: plain JavaScript (QuickJS), no imports, no I/O, no timers; output exactly one \`\`\`js block and no explanation.
${c.best ? `The fastest correct solution so far takes ${c.best.ms} ms:\n\`\`\`js\n${c.best.source}\n\`\`\`\nBeat it: make it faster or find a different way. It must stay correct.` : "No solution exists yet: write a first one."}`;
		const res: any = await s.models.completeSimple(model, {
			systemPrompt: `You are contributor ${c.agent} (generation ${c.gen}) in a swarm that evolves an algorithm through a shared space. ${STYLES[c.agent % STYLES.length]}`,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, { maxTokens: 700, signal: AbortSignal.timeout(45_000) });
		const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
		if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
		return { source: extractCode(text), model: `${model.provider}/${model.id}` };
	} finally { inFlight--; slotWaiters.shift()?.(); }
}
