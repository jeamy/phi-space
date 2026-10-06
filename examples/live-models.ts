// Real models for the live examples: built-in providers, credentials from environment variables (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, ...) or from the pi CLI's ~/.pi/agent/auth.json (read only; refreshed OAuth tokens are kept in
// memory and not written back). PI_PROVIDER + PI_MODEL pick the model, otherwise the first available one.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

type Store = NonNullable<Parameters<typeof builtinModels>[0]>["credentials"];

function authJsonStore(path = join(homedir(), ".pi", "agent", "auth.json")): Store {
	let data: Record<string, any> = {};
	try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
	return {
		read: async (id) => data[id],
		list: async () => Object.entries(data).map(([providerId, c]) => ({ providerId, type: c?.type })),
		modify: async (id, fn) => { const next = await fn(data[id]); if (next !== undefined) data[id] = next; return data[id]; },
		delete: async (id) => { delete data[id]; },
	} as Store;
}

export async function liveModels() {
	const models = builtinModels({ credentials: authJsonStore() });
	const provider = process.env.PI_PROVIDER, modelId = process.env.PI_MODEL;
	if (provider && modelId) return { models, model: { provider, modelId } };
	const m = (await models.getAvailable())[0];
	if (!m) throw new Error("no model available: set e.g. ANTHROPIC_API_KEY (or log in with the pi CLI), optionally PI_PROVIDER and PI_MODEL");
	return { models, model: { provider: m.provider, modelId: m.id } };
}
