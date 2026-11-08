// Model calls of spaces-mmo (docs/modell-npcs.en.md): off unless SPACES_MMO_LLM=1 and credentials exist (the same resolution
// as agent/src/live-models.ts: environment keys or ~/.pi/agent/auth.json). Which model a call uses is the admin's choice
// (server/settings.ts, the window in the game): the allowed models and the one calls use; without a choice the newest
// available model whose id contains SPACES_MMO_LLM_MODEL (default "haiku"). Every call is admitted against counters kept
// in the world space, so all processes share them (the limits per minute and per day, from the settings), and a per-key
// limit the caller names (an account's translations, an NPC's day). Tests swap the model for a scripted one:
// SPACES_MMO_LLM_MODULE names a module whose `complete(system, user)` answers without cost.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { join } from "node:path";
import { ROOT } from "./env.ts";
import { settingsOf, setting, type ModelInfoFields } from "./settings.ts";
import { llmEnabled } from "./llm-switch.ts";

/** Model calls are allowed at all (server/llm-switch.ts). */
export { llmEnabled };

export type Completion = { text: string; model: string };
export type ModelEntry = ModelInfoFields["models"][number];
type Registry = { available(): Promise<ModelEntry[]>; complete(label: string, system: string, user: string, maxTokens: number): Promise<Completion> };


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

const noted = new WeakMap<SpaceLike, Map<string, { text: string; at: number }>>();
/** What the admin's window says about the calls (`LlmStatus`): why the last one was refused or failed ("last") and which model
 *  last answered ("ok"). A text already noted a short while ago is not written again. */
export async function note(space: SpaceLike, key: "last" | "ok", text: string): Promise<void> {
	let m = noted.get(space);
	if (!m) { m = new Map(); noted.set(space, m); }
	const was = m.get(key), now = Date.now();
	if (was && was.text === text && now - was.at < (key === "ok" ? 60_000 : 30_000)) return;
	m.set(key, { text, at: now });
	try {
		while (await space.takeIfExists({ type: "LlmStatus", fields: { key } }, NO_WAIT));
		await space.write({ type: "LlmStatus", fields: { key, text, at: now } }, null, 7 * 24 * 3600_000);
	} catch { /* the window then shows less */ }
}

/** A model call, or null: calls off, no model, or a limit reached (`own`: the caller's key and its limit per day). */
export async function complete(space: SpaceLike, system: string, user: string, o: {
	maxTokens: number; own?: { key: string; perDay: number; day?: string };
	execute?: (model: string, permit: () => Promise<boolean>) => Promise<Completion | null>;
}): Promise<Completion | null> {
	const r = await load();
	if (!r) { await note(space, "last", llmEnabled() ? "Kein Modell geladen: keine Zugangsdaten gefunden oder das Laden schlug fehl." : "Modellaufrufe sind in der Umgebung aus (SPACES_MMO_LLM ist nicht 1)."); return null; }
	const s = await settingsOf(space);
	if (!s.models.on) { await note(space, "last", "Die Modellaufrufe sind im Fenster ausgeschaltet."); return null; }
	const model = chosen(await r.available(), s.models).model;
	if (!model) { await note(space, "last", "Kein erlaubtes Modell: das gewählte oder das Standardmodell ist nicht verfügbar."); return null; }
	const permit = async () => {
		if (o.execute) {
			const current = await settingsOf(space);
			if (!llmEnabled() || !current.models.on || chosen(await r.available(), current.models).model?.label !== model.label) { await note(space, "last", "Die Modellwahl änderte sich während des Aufrufs."); return false; }
		}
		const now = new Date(), day = now.toISOString().slice(0, 10), minute = now.toISOString().slice(0, 16);
		if (o.own && !(await admit(space, `${o.own.key}:${o.own.day ?? day}`, o.own.perDay, 26 * 3600_000))) { await note(space, "last", `Tagesgrenze erreicht: ${o.own.key.split(":")[0] === "translate" ? "Übersetzungen je Konto" : `Aufrufe von ${o.own.key.split(":")[0]}`} (${o.own.perDay} je Tag).`); return false; }
		if (!(await admit(space, `day:${day}`, await setting(space, "llm.perDay"), 26 * 3600_000))) { await note(space, "last", "Tageskontingent aller Modellaufrufe aufgebraucht (llm.perDay)."); return false; }
		if (!(await admit(space, `min:${minute}`, await setting(space, "llm.perMin"), 120_000))) { await note(space, "last", "Minutenkontingent der Modellaufrufe erreicht (llm.perMin)."); return false; }
		return true;
	};
	if (o.execute) return o.execute(model.label, permit);
	if (!(await permit())) return null;
	try {
		const done = await r.complete(model.label, system, user, o.maxTokens);
		await note(space, "ok", done.model);
		return done;
	} catch (e) { await note(space, "last", `Fehler des Anbieters (${model.label}): ${(e as Error).message.slice(0, 200)}`); throw e; }
}
