// The model process: the only process that calls models (and holds the credentials). It takes an LlmCall from the shared
// space under a transaction, builds the call's context from the space (context.ts), calls the model, and writes the
// LlmResult in the same transaction. A process that dies lets its transaction lapse and the call comes back.
// It publishes what models there are (ModelInfo) and follows the admin's choices kept in the space (CodeAdmin), and it
// keeps the per-address allowance of visitors in the space (Spend entries, one per call).
//
//   CODEMODE_SPACE=unix:/tmp/codemode-space.sock   (default) or tcp:nano:3800
//   CODEMODE_MODEL_PARALLEL=2                      model calls this process makes at once
//   CODEMODE_LLM_MODULE=tests/fakes.ts            tests only (CODEMODE_TEST=1): fake model teams instead of real models
import { ROOT } from "./env.ts";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { NO_WAIT, TransactionError, type SpaceLike } from "../../src/index.ts";
import { sourceProblem } from "./judge.ts";
import { adminModels, llmContribution, llmInfo, llmModels, setAllowedModels, setLlm, type Usage } from "./llm.ts";
import { contributeContext, type LlmCall } from "./context.ts";
import { ipTokensPerDay, today } from "./limits.ts";
import { announce, connectSpace, keepAlive } from "./space.ts";

/** What the model process can be asked for; a test module may stand in for the real models. */
export type ModelApi = { models: () => Promise<string[]>; contribute: typeof llmContribution };
/** A fake model team of the tests: picked per room, with a log that writes FakeCall entries. */
type FakeModule = { models: () => Promise<string[]>; llmFor: (session: string, o: { space: SpaceLike; log: (e: Record<string, unknown>) => Promise<void> }) => Partial<ModelApi> };

const CALL_LEASE_MS = 120_000;
/** How long an answer waits to be fetched (an agent that died leaves it behind). */
const RESULT_LEASE_MS = 10 * 60_000;
const SPEND_LEASE_MS = 26 * 3600_000;
const WAIT_MS = 5_000;

const real: ModelApi = { models: llmModels, contribute: llmContribution };

async function loadFakes(): Promise<FakeModule | null> {
	const path = process.env.CODEMODE_LLM_MODULE;
	if (!path) return null;
	if (process.env.CODEMODE_TEST !== "1") throw new Error("CODEMODE_LLM_MODULE is for tests only (CODEMODE_TEST=1)");
	return (await import(pathToFileURL(join(ROOT, path)).href)) as FakeModule;
}

/** The admin's choices kept in the space, applied to the real models: the allowed models, on/off, the default model. */
async function applyAdmin(space: SpaceLike): Promise<void> {
	const models = (await space.readIfExists({ type: "CodeAdmin", fields: { key: "models" } }, NO_WAIT))?.fields as { allowed?: unknown } | undefined;
	await setAllowedModels(Array.isArray(models?.allowed) ? models!.allowed.map(String) : null);
	const llm = (await space.readIfExists({ type: "CodeAdmin", fields: { key: "llm" } }, NO_WAIT))?.fields as { on?: unknown; model?: unknown } | undefined;
	await setLlm({ ...(typeof llm?.on === "boolean" ? { on: llm.on } : {}), ...(typeof llm?.model === "string" ? { model: llm.model } : {}) });
}

/** Tokens the visitor calls of an address used today (its Spend entries). */
export async function spentToday(space: SpaceLike, ip: string): Promise<number> {
	return (await space.readAll({ type: "Spend", fields: { ip, day: today() } }, { limit: 5000 })).reduce((n, e) => n + Number((e.fields as { tokens?: unknown }).tokens ?? 0), 0);
}

export async function startModelHost(o: { space?: string; parallel?: number } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space;
	const presence = announce(space, "model");
	const fakes = await loadFakes();
	const log = (session: string) => async (e: Record<string, unknown>) => { await space.write({ type: "FakeCall", fields: { session, seq: Date.now() + Math.random(), ...e } as never }, null, 600_000); };
	const apiFor = (session: string): ModelApi => (fakes ? { ...real, models: fakes.models, ...fakes.llmFor(session, { space, log: log(session) }) } as ModelApi : real);
	const open = new Set<string>();
	let stopping = false;

	/** ModelInfo: what the page and the web process need to know about the models (renewed every 10 s). */
	let infoLease: string | null = null, lastInfo = "";
	const publish = async () => {
		try {
			if (!fakes) await applyAdmin(space);
			const info = fakes
				? await (async () => { const labels = await fakes.models(); return { info: { enabled: true, on: true, current: labels[0] ?? null, models: labels.map((l) => ({ id: l.split("/")[1] ?? l, label: l })) }, admin: { enabled: true, on: true, models: labels.map((l) => ({ label: l, provider: l.split("/")[0] ?? "", id: l.split("/")[1] ?? l, name: l })), allowed: labels, custom: false } }; })()
				: { info: await llmInfo(), admin: await adminModels() };
			const text = JSON.stringify(info);
			if (text === lastInfo && infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
			while (await space.take({ type: "ModelInfo" }, NO_WAIT));
			infoLease = (await space.write({ type: "ModelInfo", fields: { ...info, ts: Date.now() } as never }, null, 30_000)).id;
			lastInfo = text;
		} catch (e) { if (!stopping) console.error("[model] publishing the models failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();

	/** One call: taken, answered and the answer written in one transaction. */
	const answerOne = async (): Promise<boolean> => {
		const t = await space.createTransaction(CALL_LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, CALL_LEASE_MS);
		try {
			const e = await space.take({ type: "LlmCall" }, WAIT_MS, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const call = e.fields as unknown as LlmCall;
			let result: { ok: boolean; value?: Record<string, unknown>; error?: string }, usage: Usage | undefined;
			try {
				if (!fakes) await applyAdmin(space);
				const visitor = call.client && !call.client.admin ? call.client.ip : null;
				if (visitor && ipTokensPerDay() > 0 && (await spentToday(space, visitor)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (CODEMODE_TOKENS_PER_IP_DAY)");
				const ctx = await contributeContext(space, call);
				if (!ctx) throw new Error("the task block is gone");
				const v = await apiFor(call.session).contribute(ctx);
				const problem = sourceProblem(v.source);
				if (problem) throw new Error(`the model's code cannot be handed in: ${problem}`);
				usage = v.usage;
				result = { ok: true, value: { source: v.source, model: v.model, ...(v.note ? { note: v.note } : {}), ...(v.usage ? { usage: v.usage } : {}) } };
			} catch (err) { result = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			await space.write({ type: "LlmResult", fields: { callId: call.callId, session: call.session, ...result, ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			if (usage && call.client && !call.client.admin) await space.write({ type: "Spend", fields: { ip: call.client.ip, day: today(), tokens: usage.total, ts: Date.now() } }, t.id, SPEND_LEASE_MS);
			await space.commit(t.id);
			return true;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			if (e instanceof TransactionError && !/could write|the limit is/i.test((e as Error).message)) return true;
			throw e;
		} finally { stop(); open.delete(t.id); }
	};
	const worker = async () => {
		while (!stopping) {
			try { await answerOne(); }
			catch (e) { if (stopping) return; console.error("[model] call failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	};
	const loops = Array.from({ length: Math.max(1, o.parallel ?? Number(process.env.CODEMODE_MODEL_PARALLEL ?? 2)) }, () => worker());
	return {
		async close() {
			stopping = true; clearInterval(beat);
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			await presence.stop(); conn.close();
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startModelHost();
	console.log(`[model] answering from ${process.env.CODEMODE_SPACE || "unix:/tmp/codemode-space.sock"}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
