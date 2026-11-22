// The model process: the only process that calls models (and holds the credentials). It takes an LlmCall from the shared
// space under a transaction, builds the call's prompt from the space (calls.ts), calls the model, and writes the
// LlmResult in the same transaction. A process that dies lets its transaction lapse and the call comes back.
// It publishes what models there are (ModelInfo), follows the admin's choices kept in the space (ForumAdmin), and books
// every paid call in the space (a Spend entry per call; a visitor's count against the day's allowance of the address).
// Taken over from codemode-chat/server/model-host.ts.
//
//   FORUM_SPACE=unix:/tmp/codemode-forum-space.sock   (default) or tcp:host:4180
//   FORUM_MODEL_PARALLEL=2                            model calls this process makes at once
//   FORUM_LLM_MODULE=tests/fakes.ts                   tests only (FORUM_TEST=1): fake models instead of real ones
import { ROOT } from "./env.ts";
import { pathToFileURL } from "node:url";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { adminModels, callLimits, llmInfo, llmModels, llmText, metered, setAllowedModels, setCallGate, setLlmOn, type TextAnswer, type TextCall, type Usage } from "./llm.ts";
import { packModels, spentToday, type ModelInfoView, type Spend } from "./models.ts";
import { callPrompt, type LlmCall } from "./calls.ts";
import { awaitQuota } from "./quota.ts";
import { ipTokensPerDay, today } from "./limits.ts";
import { announce, awaitWork, connectSpace, DEFAULT_SPACE, keepAlive, readExisting } from "./space.ts";

/** What the model process can be asked for; a test module may stand in for the real models. `text` gets the call it
 *  answers beside the prompt. */
export type ModelApi = { models: () => Promise<string[]>; text: (c: TextCall, call: LlmCall) => Promise<TextAnswer> };
/** The fake models of the tests: picked per room, with a log that writes FakeCall entries. */
type FakeModule = { models: () => Promise<string[]>; llmFor: (session: string, o: { space: SpaceLike; log: (e: Record<string, unknown>) => Promise<void> }) => Partial<ModelApi> };

/** A call's transaction lease, renewed while the model answers: a model process that dies holds its call this long. */
const CALL_LEASE_MS = 30_000;
/** How often a call in progress looks whether its run is still there. */
const RUN_WATCH_MS = 2_000;
/** How long an answer waits to be fetched (an agent that died leaves it behind). */
const RESULT_LEASE_MS = 10 * 60_000;
const SPEND_LEASE_MS = 26 * 3600_000;

const real: ModelApi = { models: llmModels, text: (c) => llmText(c) };

async function loadFakes(): Promise<FakeModule | null> {
	const path = process.env.FORUM_LLM_MODULE;
	if (!path) return null;
	if (process.env.FORUM_TEST !== "1") throw new Error("FORUM_LLM_MODULE is for tests only (FORUM_TEST=1)");
	return (await import(pathToFileURL(join(ROOT, path)).href)) as FakeModule;
}

/** The admin's choices kept in the space, applied to the real models: the allowed models, on/off. */
async function applyAdmin(space: SpaceLike): Promise<void> {
	const models = (await space.readIfExists({ type: "ForumAdmin", fields: { key: "models" } }, NO_WAIT))?.fields as { allowed?: unknown } | undefined;
	setAllowedModels(Array.isArray(models?.allowed) ? models!.allowed.map(String) : null);
	const llm = (await space.readIfExists({ type: "ForumAdmin", fields: { key: "llm" } }, NO_WAIT))?.fields as { on?: unknown } | undefined;
	setLlmOn(typeof llm?.on === "boolean" ? llm.on : true);
}

export async function startModelHost(o: { space?: string; parallel?: number } = {}) {
	const conn = connectSpace(o.space);
	const space = conn.space;
	const presence = announce(space, "model");
	const fakes = await loadFakes();
	const log = (session: string) => async (e: Record<string, unknown>) => { await space.write({ type: "FakeCall", fields: { session, seq: Date.now() + Math.random(), ...e } as never }, null, 600_000); };
	// a fake answers only what it defines: anything else is an error, not a call to the real models
	const apiFor = (session: string): ModelApi => (fakes ? { models: fakes.models, text: async () => { throw new Error(`the fake models of room ${session} have no text`); }, ...fakes.llmFor(session, { space, log: log(session) }) } : real);
	const open = new Set<string>();
	let stopping = false;
	const halt = new AbortController();
	// the limits every model process shares: calls per minute and per UTC day (quota.ts)
	setCallGate(() => awaitQuota(space, "llm", callLimits(), "daily model budget used up"));

	/** ModelInfo: what the page and the web process need to know about this process's models (renewed every 10 s). */
	const procId = randomBytes(6).toString("hex");
	let infoLease: string | null = null, lastInfo = "";
	const publish = async () => {
		try {
			if (!fakes) await applyAdmin(space);
			const info: ModelInfoView = fakes
				? await (async () => { const labels = await fakes.models(); return { info: { enabled: true, on: true, models: labels.map((l) => ({ id: l.split("/")[1] ?? l, label: l })) }, admin: { enabled: true, on: true, models: labels.map((l) => ({ label: l, provider: l.split("/")[0] ?? "", id: l.split("/")[1] ?? l, name: l })), allowed: labels, custom: false } }; })()
				: { info: await llmInfo(), admin: await adminModels() };
			const text = JSON.stringify(info);
			if (text === lastInfo && infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
			// this process's own entry (the web process merges those of every model process): replaced when it changes
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			const fields = { procId, info: info.info, admin: { ...info.admin, models: packModels(info.admin.models) }, ts: Date.now() };
			infoLease = (await space.write({ type: "ModelInfo", fields: fields as never }, null, 30_000)).id;
			lastInfo = text;
		} catch (e) { if (!stopping) console.error("[model] publishing the models failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();
	const runOf = (call: LlmCall) => ({ type: "ForumRun", fields: { session: call.session, runId: call.runId! } });

	/** One call: taken, answered and the answer written in one transaction. */
	const answerOne = async (): Promise<boolean> => {
		if (!(await awaitWork(space, { type: "LlmCall" }, halt.signal))) return false; // idle: waiting holds nothing
		const t = await space.createTransaction(CALL_LEASE_MS);
		open.add(t.id);
		const stop = keepAlive(space, t.id, CALL_LEASE_MS);
		try {
			const e = await space.take({ type: "LlmCall" }, NO_WAIT, { txn: t.id });
			if (!e) { await space.abort(t.id); return false; }
			const call = e.fields as unknown as LlmCall;
			let result: { ok: boolean; value?: Record<string, unknown>; error?: string }, usage: Usage | undefined;
			try {
				if (!fakes) await applyAdmin(space);
				// a call of a run that is over (stopped, ended) is not made: nobody waits for its answer
				if (call.runId && !(await readExisting(space, runOf(call)).catch(() => true))) throw new Error("the run is over");
				const visitor = call.client && !call.client.admin ? call.client.ip : null;
				if (visitor && ipTokensPerDay() > 0 && (await spentToday(space, visitor)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (FORUM_TOKENS_PER_IP_DAY)");
				const api = apiFor(call.session);
				if (!(await api.models()).includes(call.model)) throw new Error(`model ${call.model} is not allowed`);
				const prompt = await callPrompt(space, call);
				// a call of a run is stopped with it: while the model works, the run is looked for every 2 s
				const cut = new AbortController();
				const cancel = () => cut.abort();
				halt.signal.addEventListener("abort", cancel, { once: true });
				const watch = call.runId ? setInterval(() => { void readExisting(space, runOf(call)).then((r) => { if (!r) cut.abort(); }, () => {}); }, RUN_WATCH_MS) : undefined;
				// every paid call counts, also when the work fails after it: the meter of the real models, else what the
				// answer (or a fake's error) reports
				const m = await metered(() => api.text(prompt, call), cut.signal).finally(() => { clearInterval(watch); halt.signal.removeEventListener("abort", cancel); });
				const said = m.value?.usage ?? (m.error as { usage?: Usage } | undefined)?.usage;
				usage = m.usage.total > 0 || m.usage.costUsd > 0 ? m.usage : said;
				if (m.error !== undefined) throw cut.signal.aborted ? new Error("the run is over") : m.error;
				result = { ok: true, value: { text: m.value!.text, model: m.value!.model, ...(usage ? { usage } : {}) } };
			} catch (err) { result = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			// the usage rides along on a failure too: the agent books it on the run when it takes the result
			await space.write({ type: "LlmResult", fields: { callId: call.callId, session: call.session, ...(call.itemId ? { itemId: call.itemId } : {}), ...result, ...(usage && !result.ok ? { usage } : {}), ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			if (usage && usage.total > 0) {
				const spend: Spend = { ip: call.client?.ip ?? "local", admin: call.client ? call.client.admin : true, day: today(), tokens: usage.total, costUsd: usage.costUsd, model: call.model, kind: call.kind, session: call.session, ts: Date.now() };
				await space.write({ type: "Spend", fields: spend as never }, t.id, SPEND_LEASE_MS);
			}
			await space.commit(t.id);
			return true;
		} catch (e) {
			await space.abort(t.id).catch(() => {});
			if (e instanceof TransactionError) return true; // a limit of the space is ResourceExhausted, not a TransactionError
			throw e;
		} finally { stop(); open.delete(t.id); }
	};
	const worker = async () => {
		while (!stopping) {
			try { await answerOne(); }
			catch (e) { if (stopping) return; console.error("[model] call failed", (e as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	};
	const loops = Array.from({ length: Math.max(1, o.parallel ?? Number(process.env.FORUM_MODEL_PARALLEL ?? 2)) }, () => worker());
	return {
		async close() {
			stopping = true; halt.abort(); clearInterval(beat);
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			await presence.stop(); conn.close();
		},
	};
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const host = await startModelHost();
	console.log(`[model] answering from ${process.env.FORUM_SPACE || DEFAULT_SPACE}`);
	const shutdown = async () => { setTimeout(() => process.exit(0), 4000).unref(); await host.close(); process.exit(0); };
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}
