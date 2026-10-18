// Optional live LLM backend for the help site demos.
//
// Uses the same credential resolution as the --live examples (env API keys such
// as ANTHROPIC_API_KEY/OPENAI_API_KEY or the pi CLI's ~/.pi/agent/auth.json).
// Enabled explicitly with PI_SPACES_LLM=1 and credentials; set PI_SPACES_LLM=0
// (or "false") to force-disable. Costs: ~0.5-1.5k tokens per chat reply, and the
// swarm is capped (see LLM_PER_MIN in server/social/swarm.ts).

import type { LlmReply, ReplyGenerator } from "../examples/shared/chat-core.ts";
import { liveModels } from "../../examples/live-models.ts";

interface SharedLlm {
	models: any;
	model: any;
	label: string;
}

let llmPromise: Promise<SharedLlm | null> | null = null;

export interface LlmModelInfo {
	id: string;
	provider: string;
	label: string;
}

/** Runtime on/off switch – when false, all generators fall back to deterministic text. */
let llmActive = true;

export function setLlmActive(on: boolean): void {
	llmActive = on;
}

export function isLlmActive(): boolean {
	return llmActive;
}

/** Demo whitelist: the picker only offers these two – codestral-latest + the newest haiku. */
function demoWhitelist(avail: readonly any[]): any[] {
	const codestral = avail.filter((m) => String(m.id).toLowerCase() === "codestral-latest");
	const haikus = avail
		.filter((m) => String(m.id).toLowerCase().includes("haiku"))
		.sort((a, b) => String(b.id).localeCompare(String(a.id)));
	return [...codestral, ...(haikus.length ? [haikus[0]] : [])];
}

/** List the two picker-selectable models plus the currently selected one. */
export async function listLlmModels(): Promise<{ enabled: boolean; on: boolean; current: string | null; models: LlmModelInfo[] }> {
	const llm = await sharedLlm();
	if (!llm) return { enabled: false, on: false, current: null, models: [] };
	const avail: readonly any[] = await llm.models.getAvailable();
	return {
		enabled: true,
		on: llmActive,
		current: llm.label,
		models: demoWhitelist(avail)
			.map((m) => ({ id: String(m.id), provider: String(m.provider), label: `${m.provider}/${m.id}` }))
			.sort((a, b) => a.label.localeCompare(b.label)),
	};
}

/** Switch the shared model at runtime – restricted to the whitelist (exact id, "provider/id", or substring). */
export async function setLlmModel(wanted: string): Promise<string | null> {
	const llm = await sharedLlm();
	if (!llm) return null;
	const avail = demoWhitelist(await llm.models.getAvailable());
	const w = wanted.toLowerCase();
	const full =
		avail.find((m) => `${m.provider}/${m.id}`.toLowerCase() === w) ??
		avail.find((m) => String(m.id).toLowerCase() === w) ??
		avail.find((m) => String(m.id).toLowerCase().includes(w));
	if (!full) return llm.label;
	llm.model = full;
	llm.label = `${full.provider}/${full.id}`;
	return llm.label;
}

export function sharedLlm(): Promise<SharedLlm | null> {
	llmPromise ??= (async () => {
		const flag = (process.env.PI_SPACES_LLM ?? "").toLowerCase();
		if (!["1", "true", "on"].includes(flag)) return null;
		try {
			const { models, model } = await liveModels();
			// completeSimple needs the full catalog Model object, not the {provider, modelId} selector.
			const avail: readonly any[] = await models.getAvailable();
			if (avail.length === 0) return null;
			// Demo cost guard: prefer the smallest available model – haiku tier max.
			// Override with PI_SPACES_LLM_MODEL (substring or exact id) or PI_MODEL.
			const wanted = (process.env.PI_SPACES_LLM_MODEL ?? process.env.PI_MODEL ?? "").toLowerCase();
			let full: any;
			if (wanted) {
				full =
					avail.find((m) => String(m.id).toLowerCase() === wanted) ??
					avail.find((m) => String(m.id).toLowerCase().includes(wanted) && m.provider === (process.env.PI_PROVIDER ?? m.provider)) ??
					avail.find((m) => String(m.id).toLowerCase().includes(wanted));
			}
			if (!full) {
				// newest haiku first (e.g. claude-haiku-4-5, claude-haiku-5-*), then other cheap tiers
				const haikus = avail.filter((m) => String(m.id).toLowerCase().includes("haiku")).sort((a, b) => String(b.id).localeCompare(String(a.id)));
				full = haikus[0];
				for (const token of ["gpt-4o-mini", "mini", "flash", "small"]) {
					if (full) break;
					full = avail.find((m) => String(m.id).toLowerCase().includes(token));
				}
				full ??= avail.find((m) => m.provider === model.provider && m.id === model.modelId) ?? avail[0];
			}
			return { models, model: full, label: `${full.provider}/${full.id}` };
		} catch {
			return null; // no credentials -> deterministic fallback everywhere
		}
	})();
	return llmPromise;
}

let activeCalls = 0;
let callWindow = 0;
let calls = 0;
async function complete(systemPrompt: string, userContent: string, maxTokens = 400, signal?: AbortSignal): Promise<LlmReply | null> {
	if (!llmActive) return null;
	const llm = await sharedLlm();
	if (!llm) return null;
	if (Date.now() - callWindow >= 60_000) { callWindow = Date.now(); calls = 0; }
	if (activeCalls >= 2 || calls >= 6) return null;
	activeCalls++; calls++;
	try {
	const res: any = await llm.models.completeSimple(llm.model, {
		systemPrompt,
		messages: [{ role: "user", content: userContent, timestamp: Date.now() }],
	}, { maxTokens, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000) });
	const text = (res?.content ?? [])
		.filter((c: any) => c?.type === "text")
		.map((c: any) => c.text)
		.join("")
		.trim();
	if (!text) return null;
	const u: any = res?.usage ?? {};
	return {
		text,
		model: llm.label,
		usageIn: u.input ?? u.inputTokens ?? 0,
		usageOut: u.output ?? u.outputTokens ?? 0,
	};
	} finally { activeCalls--; }
}

/** Reply generator for the space-chat lobby assistant (pi-space-agent). */
export async function chatReplyGenerator(): Promise<ReplyGenerator | null> {
	if (!(await sharedLlm())) return null;
	return async ({ threadId, author, prompt, history, signal }) =>
		complete(
			`You are "pi-space-agent", the resident assistant inside a durable pi-spaces ` +
				`multiplayer chat. Reply helpfully in 1-3 short sentences. Match the user's ` +
				`language (German or English). Reference earlier messages when useful.`,
			`Thread: ${threadId}\nRecent messages:\n${history.map((m) => `${m.author}: ${m.text}`).join("\n")}\n\n${author}: ${prompt}\n\nYour reply to ${author}:`,
			400, signal,
		);
}

/** Reply generator for swarm agents replying to a real user's post. */
export type SwarmReplyGenerator = (input: {
	handle: string;
	name: string;
	bio: string;
	channel: string;
	targetText: string;
	targetHandle: string;
}) => Promise<LlmReply | null>;

export async function swarmReplyGenerator(): Promise<SwarmReplyGenerator | null> {
	if (!(await sharedLlm())) return null;
	return async ({ handle, name, bio, channel, targetText, targetHandle }) =>
		complete(
			`You are ${name} (@${handle}), ${bio}. You post in the channel #${channel} of a ` +
				`lively social network run by thousands of autonomous agents, all backed by a ` +
				`shared tuple space. Write ONE short casual reply: max 180 chars, no quoting, ` +
				`at most one emoji, stay in character.`,
			`@${targetHandle} posted: "${targetText}"\nYour reply:`,
			180,
		);
}

/** Original-post generator for swarm agents (standalone, no reply target). */
export type SwarmPostGenerator = (input: {
	handle: string;
	name: string;
	bio: string;
	channel: string;
}) => Promise<LlmReply | null>;

export async function swarmPostGenerator(): Promise<SwarmPostGenerator | null> {
	if (!(await sharedLlm())) return null;
	return async ({ handle, name, bio, channel }) =>
		complete(
			`You are ${name} (@${handle}), ${bio}. You post in the channel #${channel} of a ` +
				`lively social network run by thousands of autonomous agents, all backed by a ` +
				`shared tuple space. Write ONE original standalone post for #${channel}: max 200 ` +
				`chars, casual tone, at most one emoji and one #hashtag, stay in character. ` +
				`No quoting, no "@someone" lead-in.`,
			`Write your #${channel} post:`,
			200,
		);
}
