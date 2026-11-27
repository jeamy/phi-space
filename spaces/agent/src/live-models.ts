// Real models for the live examples: built-in providers, credentials from environment variables (ANTHROPIC_API_KEY,
// OPENAI_API_KEY, ...) or from the pi CLI's ~/.pi/agent/auth.json (read only; refreshed OAuth tokens are kept in
// memory and not written back). PI_PROVIDER + PI_MODEL pick the model, otherwise the first available one.
// `fileModels(file)` keeps the credentials in a file of their own instead (fileCredentialStore): logins and refreshed
// tokens are written there, auth.json only fills it once while it does not exist.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

type Store = NonNullable<Parameters<typeof builtinModels>[0]>["credentials"];
type Credential = Awaited<ReturnType<NonNullable<Store>["read"]>>;

const AUTH_JSON = join(homedir(), ".pi", "agent", "auth.json");

function authJsonStore(path = AUTH_JSON): Store {
	let data: Record<string, any> = {};
	try { data = JSON.parse(readFileSync(path, "utf8")); } catch {}
	return {
		read: async (id) => data[id],
		list: async () => Object.entries(data).map(([providerId, c]) => ({ providerId, type: c?.type })),
		modify: async (id, fn) => { const next = await fn(data[id]); if (next !== undefined) data[id] = next; return data[id]; },
		delete: async (id) => { delete data[id]; },
	} as Store;
}

/** pi-ai's CredentialStore on one file, owned by one process: `{ providerId: credential }` as JSON, mode 600, in a
 *  directory this process creates with mode 700. Every write goes to a temporary file that is then renamed over the
 *  old one, so a crash leaves the old file or the new one. Writes of one provider are serialized (two calls may
 *  refresh the same OAuth token at once; the second sees the first's result). `seedFrom` (default the pi CLI's
 *  auth.json) fills the file once while it does not exist; that file is never written. */
export function fileCredentialStore(path: string, o: { seedFrom?: string | null } = {}): NonNullable<Store> {
	const dir = dirname(path);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
	let data: Record<string, Credential> = {};
	const save = () => {
		const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
		writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, path);
	};
	if (existsSync(path)) {
		data = JSON.parse(readFileSync(path, "utf8"));
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
	} else {
		const seed = o.seedFrom === undefined ? AUTH_JSON : o.seedFrom;
		if (seed) try { data = JSON.parse(readFileSync(seed, "utf8")); } catch {}
		save();
	}
	const chains = new Map<string, Promise<unknown>>();
	const serial = <T>(id: string, fn: () => Promise<T>): Promise<T> => {
		const run = (chains.get(id) ?? Promise.resolve()).then(fn, fn);
		chains.set(id, run.catch(() => {}));
		return run;
	};
	return {
		read: async (id) => data[id],
		list: async () => Object.entries(data).map(([providerId, c]) => ({ providerId, type: (c as { type: "api_key" | "oauth" }).type })),
		modify: (id, fn) => serial(id, async () => {
			const next = await fn(data[id]);
			if (next !== undefined) { data = { ...data, [id]: next }; save(); }
			return data[id];
		}),
		delete: (id) => serial(id, async () => { if (id in data) { const { [id]: _gone, ...rest } = data; data = rest; save(); } }),
	} as NonNullable<Store>;
}

export async function liveModels() {
	const models = builtinModels({ credentials: authJsonStore() });
	const provider = process.env.PI_PROVIDER, modelId = process.env.PI_MODEL;
	if (provider && modelId) return { models, model: { provider, modelId } };
	const m = (await models.getAvailable())[0];
	if (!m) throw new Error("no model available: set e.g. ANTHROPIC_API_KEY (or log in with the pi CLI), optionally PI_PROVIDER and PI_MODEL");
	return { models, model: { provider: m.provider, modelId: m.id } };
}

/** The built-in providers with their credentials in a file of their own (fileCredentialStore), for a process that
 *  logs in and keeps refreshed tokens; none needs to be configured. `providers`: further pi-ai `Provider`s beside the
 *  built-in ones (a test's). `seedFrom`: as for fileCredentialStore. */
export function fileModels(credentialsFile: string, o: { providers?: readonly unknown[]; seedFrom?: string | null } = {}) {
	const models = builtinModels({ credentials: fileCredentialStore(credentialsFile, { seedFrom: o.seedFrom }) });
	for (const p of o.providers ?? []) models.setProvider(p as Parameters<typeof models.setProvider>[0]);
	return models;
}

// what a test needs to build a provider of its own (codemode-forum/tests/providers.ts): pi-ai stays imported here
export { createFauxCore, createProvider, fauxAssistantMessage } from "@earendil-works/pi-ai";
