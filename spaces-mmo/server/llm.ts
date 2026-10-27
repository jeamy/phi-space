// Model calls of spaces-mmo (docs/modell-npcs.md): off unless SPACES_MMO_LLM=1 and credentials exist (the same resolution
// as agent/src/live-models.ts: environment keys or ~/.pi/agent/auth.json). Which model a call uses is the admin's choice
// (server/settings.ts, the window in the game): the allowed models and the one calls use; without a choice the newest
// available model whose id contains SPACES_MMO_LLM_MODEL (default "haiku"). Every call is admitted against counters kept
// in the world space, so all processes share them (the limits per minute and per day, from the settings), and a per-key
// limit the caller names (an account's translations, an NPC's day). Tests swap the model for a scripted one:
// SPACES_MMO_LLM_MODULE names a module whose `complete(system, user)` answers without cost.
import type { SpaceLike } from "phi-spaces";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { settingsOf, setting, type ModelInfoFields } from "./settings.ts";

export type Completion = { text: string; model: string };
export type ModelEntry = ModelInfoFields["models"][number];
type Registry = { available(): Promise<ModelEntry[]>; complete(label: string, system: string, user: string, maxTokens: number): Promise<Completion> };

/** Model calls are allowed at all (the environment's opt-in; the admin can switch them off on top). */
export const llmEnabled = () => process.env.SPACES_MMO_LLM === "1";

let registry: Promise<Registry | null> | null = null;

/** The models with credentials, or null when calls are off or none is available. */
function load(): Promise<Registry | null> {
	registry ??= (async () => {
		if (!llmEnabled()) return null;
		const scripted = process.env.SPACES_MMO_LLM_MODULE;
		if (scripted) {
			const m = await import(join(ROOT, scripted));
			const one: ModelEntry = { label: "scripted/scripted", provider: "scripted", id: "scripted", name: "Scripted" };
			return { available: async () => [one], complete: async (_l, s, u) => ({ text: await m.complete(s, u), model: "scripted" }) };
		}
		try {
			const { liveModels } = await import("../../agent/src/live-models.ts");
			const { models } = await liveModels();
			let cached: { at: number; list: readonly any[] } | null = null;
			const list = async (): Promise<readonly any[]> => {
				if (!cached || Date.now() - cached.at > 60_000) cached = { at: Date.now(), list: await models.getAvailable() };
				return cached.list;
			};
			return {
				available: async () => (await list()).map((m: any) => ({ label: `${m.provider}/${m.id}`, provider: String(m.provider), id: String(m.id), name: String(m.name ?? "") })),
				async complete(label, system, user, maxTokens) {
					const pick = (await list()).find((m: any) => `${m.provider}/${m.id}` === label);
					if (!pick) throw new Error(`model ${label} is not available`);
					const res: any = await models.completeSimple(pick, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { maxTokens, signal: AbortSignal.timeout(30_000) });
					const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
					if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
					return { text, model: label };
				},
			};
		} catch (e) { console.error("[llm] no models:", (e as Error).message); return null; }
	})();
	return registry;
}

/** Every model with credentials (empty when calls are off). */
export async function availableModels(): Promise<ModelEntry[]> {
	const r = await load();
	return r ? (await r.available()).sort((a, b) => a.label.localeCompare(b.label)) : [];
}

/** The default choice: the newest available model whose id contains SPACES_MMO_LLM_MODEL (default "haiku"); the only one,
 *  if there is just one. */
export function defaultModel(available: ModelEntry[]): ModelEntry | undefined {
	const want = (process.env.SPACES_MMO_LLM_MODEL || "haiku").toLowerCase();
	// nothing matches: only a single model is taken without asking (never a guess among several, which may cost more)
	return available.filter((m) => m.id.toLowerCase().includes(want)).sort((a, b) => b.id.localeCompare(a.id))[0] ?? (available.length === 1 ? available[0] : undefined);
}

/** The allowed models and the one calls use now, from the admin's choice and what is available. */
export function chosen(available: ModelEntry[], choice: { allowed: string[] | null; model: string | null }): { allowed: ModelEntry[]; model: ModelEntry | undefined } {
	const byLabel = new Map(available.map((m) => [m.label, m]));
	const allowed = choice.allowed ? choice.allowed.map((l) => byLabel.get(l)).filter((m): m is ModelEntry => !!m) : [defaultModel(available)].filter((m): m is ModelEntry => !!m);
	return { allowed, model: allowed.find((m) => m.label === choice.model) ?? allowed[0] };
}

/** Counts one use against `limit` for `key` (a counter entry in the space, taken and written back, so processes cannot
 *  both take the last one). False when the limit is reached. */
async function admit(space: SpaceLike, key: string, limit: number, leaseMs: number): Promise<boolean> {
	const txn = (await space.createTransaction(10_000)).id;
	try {
		// takeIfExists: a counter that does not exist yet (a new day or minute) is no wait, only one held by another call is
		const e = await space.takeIfExists({ type: "LlmCount", fields: { key } }, 2_000, { txn });
		const used = e ? Number(e.fields.used) : 0;
		if (used >= limit) { await space.abort(txn); return false; }
		await space.write({ type: "LlmCount", fields: { key, used: used + 1 } }, txn, leaseMs);
		await space.commit(txn);
		return true;
	} catch (err) { await space.abort(txn).catch(() => {}); throw err; }
}

/** A model call, or null: calls off, no model, or a limit reached (`own`: the caller's key and its limit per day). */
export async function complete(space: SpaceLike, system: string, user: string, o: { maxTokens: number; own?: { key: string; perDay: number; day?: string } }): Promise<Completion | null> {
	const r = await load();
	if (!r) return null;
	const s = await settingsOf(space);
	if (!s.models.on) return null; // the admin switched model calls off
	const model = chosen(await r.available(), s.models).model;
	if (!model) return null;
	const now = new Date(), day = now.toISOString().slice(0, 10), minute = now.toISOString().slice(0, 16);
	if (o.own && !(await admit(space, `${o.own.key}:${o.own.day ?? day}`, o.own.perDay, 26 * 3600_000))) return null;
	if (!(await admit(space, `day:${day}`, await setting(space, "llm.perDay"), 26 * 3600_000))) return null;
	if (!(await admit(space, `min:${minute}`, await setting(space, "llm.perMin"), 120_000))) return null;
	return r.complete(model.label, system, user, o.maxTokens);
}

