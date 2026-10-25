// Model calls of spaces-mmo (docs/modell-npcs.md): off unless SPACES_MMO_LLM=1 and credentials exist (the same resolution
// as agent/src/live-models.ts: environment keys or ~/.pi/agent/auth.json). A cheap model by default: the first available
// whose id contains SPACES_MMO_LLM_MODEL (default "haiku", the newest one). Every call is admitted against counters kept
// in the world space, so all processes share them: SPACES_MMO_LLM_PER_MIN (default 20), SPACES_MMO_LLM_PER_DAY (default
// 500), and a per-key limit the caller names (an account's translations, an NPC's day). Tests swap the model for a
// scripted one: SPACES_MMO_LLM_MODULE names a module whose `complete(system, user)` answers without cost.
import type { SpaceLike } from "phi-spaces";
import { join } from "node:path";
import { ROOT } from "./env.ts";

export type Completion = { text: string; model: string };
type Model = { complete(system: string, user: string, maxTokens: number): Promise<Completion> };

export const llmEnabled = () => process.env.SPACES_MMO_LLM === "1";
const perMin = () => Number(process.env.SPACES_MMO_LLM_PER_MIN ?? 20);
const perDay = () => Number(process.env.SPACES_MMO_LLM_PER_DAY ?? 500);

let model: Promise<Model | null> | null = null;

/** The model, or null when calls are off or no model is available. */
function load(): Promise<Model | null> {
	model ??= (async () => {
		if (!llmEnabled()) return null;
		const scripted = process.env.SPACES_MMO_LLM_MODULE;
		if (scripted) {
			const m = await import(join(ROOT, scripted));
			return { complete: async (s, u) => ({ text: await m.complete(s, u), model: "scripted" }) };
		}
		try {
			const { liveModels } = await import("../../agent/src/live-models.ts");
			const { models } = await liveModels();
			const want = (process.env.SPACES_MMO_LLM_MODEL || "haiku").toLowerCase();
			const pick = (await models.getAvailable()).filter((m: any) => String(m.id).toLowerCase().includes(want)).sort((a: any, b: any) => String(b.id).localeCompare(String(a.id)))[0];
			if (!pick) { console.error(`[llm] no available model matches "${want}"`); return null; }
			return {
				async complete(system, user, maxTokens) {
					const res: any = await models.completeSimple(pick, { systemPrompt: system, messages: [{ role: "user", content: user, timestamp: Date.now() }] }, { maxTokens, signal: AbortSignal.timeout(30_000) });
					const text = (res?.content ?? []).filter((x: any) => x?.type === "text").map((x: any) => x.text).join("");
					if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
					return { text, model: `${pick.provider}/${pick.id}` };
				},
			};
		} catch (e) { console.error("[llm] no models:", (e as Error).message); return null; }
	})();
	return model;
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
export async function complete(space: SpaceLike, system: string, user: string, o: { maxTokens: number; own?: { key: string; perDay: number } }): Promise<Completion | null> {
	const m = await load();
	if (!m) return null;
	const now = new Date(), day = now.toISOString().slice(0, 10), minute = now.toISOString().slice(0, 16);
	if (o.own && !(await admit(space, `${o.own.key}:${day}`, o.own.perDay, 26 * 3600_000))) return null;
	if (!(await admit(space, `day:${day}`, perDay(), 26 * 3600_000))) return null;
	if (!(await admit(space, `min:${minute}`, perMin(), 120_000))) return null;
	return m.complete(system, user, o.maxTokens);
}

