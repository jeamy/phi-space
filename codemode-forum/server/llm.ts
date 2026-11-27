// The models of the forum, called by the model process only. Off unless FORUM_LLM=1 and credentials exist (environment
// keys or ~/.pi/agent/auth.json, as the --live examples resolve them). Guards, taken over from codemode-chat: the
// models an admin allowed (before that: those FORUM_MODELS names, else none), at most two calls in flight per process
// (more wait for a slot), FORUM_LLM_PER_MIN (default 20) per minute (a full minute waits for the next) and
// FORUM_LLM_PER_DAY (default 500) per UTC day, shared by every model process through the space (setCallGate,
// quota.ts); an administrator may set lower ones on the page (settings.ts, setCallLimits). Every call names its model:
// a run is made of several, there is no default one.
// The credentials are kept in a file of this process's own (FORUM_AUTH_FILE, default .local/auth/credentials.json;
// fileModels in spaces/agent/src/live-models.ts), filled once from the pi CLI's auth.json (FORUM_AUTH_SEED; empty:
// none) and changed by the logins of the page (provider-host.ts). The providers are there whether FORUM_LLM is on or
// not: logging in calls no model.
import { AsyncLocalStorage } from "node:async_hooks";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT } from "./env.ts";

const CALLS_PER_MIN = Number(process.env.FORUM_LLM_PER_MIN ?? 20);
const CALLS_PER_DAY = Number(process.env.FORUM_LLM_PER_DAY ?? 500);
let setLimits: { perMin?: number; perDay?: number } = {};
/** The administrator's limits (already within the environment's, settings.ts); {} keeps the environment's. */
export const setCallLimits = (l: { perMin?: number; perDay?: number }) => { setLimits = l; };
/** The calls per minute and per day every model process shares (the model process admits them through the space). */
export const callLimits = () => ({ perMin: Math.min(CALLS_PER_MIN, setLimits.perMin ?? Infinity), perDay: Math.min(CALLS_PER_DAY, setLimits.perDay ?? Infinity) });
let dayStart = 0, dayCalls = 0;
/** Admits a call against limits shared with other processes (set by the model process); without one, this process
 *  counts its own calls. */
let callGate: (() => Promise<void>) | null = null;
export const setCallGate = (gate: (() => Promise<void>) | null) => { callGate = gate; };
type Shared = { models: any };
let shared: Promise<Shared | null> | null = null;
let withProviders: Promise<any | null> | null = null;
let on = true, inFlight = 0, windowStart = 0, calls = 0;
const slotWaiters: Array<() => void> = [];

export type LlmInfo = { enabled: boolean; on: boolean; models: { id: string; label: string }[] };
export type AdminModels = { enabled: boolean; on: boolean; models: Array<{ label: string; provider: string; id: string; name: string }>; allowed: string[]; custom: boolean };

/** The models an admin allowed (labels `provider/id`); null: the choice of FORUM_MODELS. */
let allowedLabels: Set<string> | null = null;
const labelOf = (m: any) => `${m.provider}/${m.id}`;
/** FORUM_MODELS: parts of model ids, comma-separated; a model whose id contains one of them may take part. */
const named = () => (process.env.FORUM_MODELS ?? "").split(",").map((p) => p.trim().toLowerCase()).filter(Boolean);

/** The models that may take part: what an admin allowed, else those FORUM_MODELS names, else none. */
const whitelist = (avail: readonly any[]): any[] => {
	if (allowedLabels) return avail.filter((m) => allowedLabels!.has(labelOf(m)));
	const parts = named();
	return parts.length ? avail.filter((m) => parts.some((p) => String(m.id).toLowerCase().includes(p))) : [];
};

/** Sets the allowed models (labels; null: back to the choice of FORUM_MODELS). */
export function setAllowedModels(labels: string[] | null): void { allowedLabels = labels ? new Set(labels) : null; }
/** The admin's switch: off, no model is called. */
export function setLlmOn(value: boolean): void { on = value; }

/** Whether model calls are on in this process (FORUM_LLM). */
export const llmEnabled = () => ["1", "true", "on"].includes((process.env.FORUM_LLM ?? "").toLowerCase());

/** pi-ai's Models with this process's credential file, whether model calls are on or not (null: they could not be
 *  made). FORUM_PROVIDER_MODULE (tests only, FORUM_TEST=1) adds the providers its `providers()` returns. */
export function providerModels(): Promise<any | null> {
	withProviders ??= (async () => {
		try {
			// loaded only here: a process that calls no real model (the web process) needs no pi-ai
			const { fileModels } = await import("../../spaces/agent/src/live-models.ts");
			const extra = process.env.FORUM_PROVIDER_MODULE;
			if (extra && process.env.FORUM_TEST !== "1") throw new Error("FORUM_PROVIDER_MODULE is for tests only (FORUM_TEST=1)");
			const providers = extra ? await (await import(pathToFileURL(join(ROOT, extra)).href)).providers() : [];
			const seed = process.env.FORUM_AUTH_SEED;
			return fileModels(process.env.FORUM_AUTH_FILE || join(ROOT, ".local", "auth", "credentials.json"), { providers, ...(seed === undefined ? {} : { seedFrom: seed || null }) });
		} catch (e) { console.error("[model] the providers could not be loaded:", (e as Error).message); return null; }
	})();
	return withProviders;
}

function sharedModel(): Promise<Shared | null> {
	shared ??= (async () => {
		if (!llmEnabled()) return null;
		const models = await providerModels();
		return models ? { models } : null;
	})();
	return shared;
}

/** The test call of the page: one model of `provider` (the cheapest it has with these credentials) asked for a word,
 *  within the shared limits; what it used. */
export async function providerTest(provider: string): Promise<{ model: string; tokens: number; costUsd: number }> {
	const s = await sharedModel();
	if (!s) throw new Error("model calls are off (FORUM_LLM)");
	const avail: any[] = [...(await s.models.getAvailable(provider))];
	if (!avail.length) throw new Error("no model of this provider answers with these credentials");
	const price = (m: any) => num(m.cost?.input) + num(m.cost?.output);
	const model = avail.sort((a, b) => price(a) - price(b))[0];
	if (callGate) await callGate();
	const mustThink = model.reasoning === true && model.thinkingLevelMap?.off === null;
	const res: any = await s.models.completeSimple(model, { systemPrompt: "Answer with the single word OK.", messages: [{ role: "user", content: "Are you there?", timestamp: Date.now() }] }, { ...(mustThink ? { reasoning: "low", maxTokens: 16 + THINKING_ROOM } : { maxTokens: 16 }), signal: AbortSignal.timeout(mustThink ? 120_000 : 45_000) });
	const u = usageOf(res);
	const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
	if (!text.trim()) throw new Error(String(res?.errorMessage ?? "empty answer").slice(0, 300));
	return { model: labelOf(model), tokens: u.total, costUsd: u.costUsd };
}

/** Every model with credentials, for the admin's choice: label, provider, id, name; and what is allowed now. */
export async function adminModels(): Promise<AdminModels> {
	const s = await sharedModel();
	if (!s) return { enabled: false, on: false, models: [], allowed: [], custom: false };
	const avail: any[] = await s.models.getAvailable();
	return {
		enabled: true, on, custom: allowedLabels !== null,
		models: avail.map((m) => ({ label: labelOf(m), provider: String(m.provider), id: String(m.id), name: String(m.name ?? m.id) })).sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id)),
		allowed: whitelist(avail).map(labelOf),
	};
}

export async function llmInfo(): Promise<LlmInfo> {
	const s = await sharedModel();
	if (!s) return { enabled: false, on: false, models: [] };
	return { enabled: true, on, models: whitelist(await s.models.getAvailable()).map((m) => ({ id: String(m.id), label: labelOf(m) })) };
}

/** Labels (`provider/id`) of the models that may take part in a run. */
export async function llmModels(): Promise<string[]> {
	const s = await sharedModel();
	return s && on ? whitelist(await s.models.getAvailable()).map(labelOf) : [];
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

/** The stop signal of the work in progress (`metered`), for a model team that is not the real models (tests). */
export const callSignal = (): AbortSignal | undefined => meter.getStore()?.signal;

/** What the model calls inside `metered` used, added up as they are answered: also the calls of work that fails
 *  afterwards (an empty answer), which are paid all the same. */
const meter = new AsyncLocalStorage<{ usage: Usage; signal?: AbortSignal }>();
/** `signal`: the work is no longer wanted (its run was stopped): a call waiting to start does not start, a call in
 *  progress is aborted at the provider. */
export async function metered<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<{ value?: T; error?: unknown; usage: Usage }> {
	const m = { usage: NO_USAGE, ...(signal ? { signal } : {}) };
	try { return { value: await meter.run(m, fn), usage: m.usage }; }
	catch (error) { return { error, usage: m.usage }; }
}

/** Output tokens a model that must think gets on top of its answer's budget. */
const THINKING_ROOM = 4_000;

/** What one call asks of a model. */
export type TextCall = { model: string; system: string; user: string; maxTokens: number };
export type TextAnswer = { text: string; model: string; usage?: Usage };

/** One guarded model call (allowed models, day budget, minute window, two in flight): the answer text and the model
 *  label. A full minute window waits for the next one. */
export async function llmText(c: TextCall): Promise<TextAnswer> {
	const s = await sharedModel();
	if (!s || !on) throw new Error("model agents are off");
	const model = whitelist(await s.models.getAvailable()).find((m) => labelOf(m) === c.model);
	if (!model) throw new Error(`model ${c.model} is not allowed`);
	const stopSignal = meter.getStore()?.signal;
	if (callGate) await callGate();
	else for (;;) {
		if (Date.now() - windowStart >= 60_000) { windowStart = Date.now(); calls = 0; }
		if (Date.now() - dayStart >= 86_400_000) { dayStart = Date.now(); dayCalls = 0; }
		if (dayCalls >= CALLS_PER_DAY) throw new Error("daily model budget used up");
		if (calls < CALLS_PER_MIN) break;
		await new Promise((ok) => setTimeout(ok, Math.max(250, windowStart + 60_000 - Date.now())));
	}
	calls++; dayCalls++;
	if (inFlight >= 2) await new Promise<void>((ok) => slotWaiters.push(ok)); // wait for a free slot instead of failing
	if (stopSignal?.aborted) { slotWaiters.shift()?.(); throw new Error("the run is over"); } // not started: nothing paid
	inFlight++;
	// A model that cannot turn its thinking off spends output tokens on it first: within `maxTokens` alone it may think
	// to the limit and give no text. Such a model thinks at effort "low" and gets room for it on top, and more time.
	const mustThink = model.reasoning === true && model.thinkingLevelMap?.off === null;
	const timeout = AbortSignal.timeout(mustThink ? 180_000 : 60_000);
	try {
		const res: any = await s.models.completeSimple(model, {
			systemPrompt: c.system,
			messages: [{ role: "user", content: c.user, timestamp: Date.now() }],
		}, { ...(mustThink ? { reasoning: "low", maxTokens: c.maxTokens + THINKING_ROOM } : { maxTokens: c.maxTokens }), signal: stopSignal ? AbortSignal.any([timeout, stopSignal]) : timeout });
		const m = meter.getStore();
		if (m) m.usage = addUsage(m.usage, usageOf(res)); // paid, whatever happens with the answer
		const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
		if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
		return { text, model: labelOf(model), usage: usageOf(res) };
	} finally { inFlight--; slotWaiters.shift()?.(); }
}
