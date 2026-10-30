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
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { NO_WAIT, TransactionError, type SpaceLike } from "phi-spaces";
import { sourceProblem } from "./judge.ts";
import { adminModels, callLimits, metered, setCallGate, llmContribution, llmCriteria, llmCritique, llmInfo, llmJudge, llmModels, llmPropose, llmResearch, llmReviewCriteria, llmVerifier, llmVote, setAllowedModels, setLlm, type Usage } from "./llm.ts";
import { callArgs, voteScores, type CallKind, type LlmCall } from "./context.ts";
import { searchesPerDay, webSearch } from "./search.ts";
import { awaitQuota, takeQuota } from "./quota.ts";
import { isText, type Task } from "./tasks.ts";
import { ipTokensPerDay, today } from "./limits.ts";
import { announce, awaitWork, connectSpace, keepAlive, readExisting } from "./space.ts";
import { openDurableContributions } from "./durable-agent.ts";
import { admitAgentAttempt } from "./run.ts";

/** What the model process can be asked for; a test module may stand in for the real models. */
export type ModelApi = { models: () => Promise<string[]>; contribute: typeof llmContribution; critique: typeof llmCritique; propose: typeof llmPropose; vote: typeof llmVote; judge: typeof llmJudge; research: typeof llmResearch; verify: typeof llmVerifier; criteria: typeof llmCriteria; reviewCriteria: typeof llmReviewCriteria };
/** A fake model team of the tests: picked per room, with a log that writes FakeCall entries. */
type FakeModule = { models: () => Promise<string[]>; llmFor: (session: string, o: { space: SpaceLike; log: (e: Record<string, unknown>) => Promise<void> }) => Partial<ModelApi> };

/** A call's transaction lease, renewed while the model answers: a model process that dies holds its call this long. */
const CALL_LEASE_MS = 30_000;
/** How often a call in progress looks whether its run is still there. */
const RUN_WATCH_MS = 2_000;
/** How long an answer waits to be fetched (an agent that died leaves it behind). */
const RESULT_LEASE_MS = 10 * 60_000;
const SPEND_LEASE_MS = 26 * 3600_000;

const real: ModelApi = { models: llmModels, contribute: llmContribution, critique: llmCritique, propose: llmPropose, vote: llmVote, judge: llmJudge, research: llmResearch, verify: llmVerifier, criteria: llmCriteria, reviewCriteria: llmReviewCriteria };

/** One call of a kind: the llm.ts function with the arguments built from the space, its answer as plain data. */
async function answer(api: ModelApi, kind: CallKind, args: Record<string, unknown>, search: (q: string) => Promise<Array<{ title: string; url: string; snippet: string }>>): Promise<{ value: Record<string, unknown>; usage?: Usage }> {
	const a = args as never;
	switch (kind) {
		case "contribute": {
			const v = await api.contribute(a);
			// code that cannot be handed in was paid all the same: the error carries the usage
			if (!isText((args as { task: Task }).task)) { const problem = sourceProblem(v.source); if (problem) throw Object.assign(new Error(`the model's code cannot be handed in: ${problem}`), { usage: v.usage }); }
			return { value: { source: v.source, model: v.model, ...(v.note ? { note: v.note } : {}), ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) };
		}
		case "critique": case "propose": { const v = await api[kind](a); return { value: { text: v.text, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "vote": { const v = await api.vote(a); return { value: { scores: voteScores(args, v.scores), text: v.text, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "judge": { const v = await api.judge(a); return { value: { results: v.results, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "research": { const v = await api.research({ ...(args as object), search } as never); return { value: { queries: v.queries, sources: v.sources, text: v.text, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "verify": { const v = await api.verify(a); return { value: { check: v.check, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "criteria": { const v = await api.criteria(a); return { value: { criteria: v.criteria, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
		case "reviewCriteria": { const v = await api.reviewCriteria(a); return { value: { votes: v.votes, model: v.model, ...(v.usage ? { usage: v.usage } : {}) }, ...(v.usage ? { usage: v.usage } : {}) }; }
	}
}

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
	// a fake team answers only what it defines: anything else is an error, not a call to the real models
	const missing = (session: string) => Object.fromEntries((Object.keys(real) as Array<keyof ModelApi>).filter((k) => k !== "models").map((k) => [k, async () => { throw new Error(`the fake team of room ${session} has no ${k}`); }]));
	const apiFor = (session: string): ModelApi => (fakes ? { ...missing(session), models: fakes.models, ...fakes.llmFor(session, { space, log: log(session) }) } as ModelApi : real);
	const resolveModel = async (call: LlmCall, requested?: string) => {
		if (!fakes) await applyAdmin(space);
		const labels = await apiFor(call.session).models();
		const model = requested ?? (fakes ? labels[0] : (await llmInfo()).current);
		if (!model || !labels.includes(model)) throw new Error(`model ${model ?? "(none)"} is not allowed`);
		return model;
	};
	const durable = openDurableContributions({
		model: resolveModel,
		permit: async (call, model, usage, signal) => {
			signal.throwIfAborted();
			await resolveModel(call, model);
			await awaitQuota(space, "llm", callLimits(), "daily model budget used up");
			signal.throwIfAborted();
			await resolveModel(call, model); // A full minute's quota may have waited through an admin change.
			if (call.runId && !(await readExisting(space, { type: "CodeRun", fields: { session: call.session, runId: call.runId } }))) throw new Error("the run is over");
			const visitor = call.client && !call.client.admin ? call.client.ip : null;
			if (visitor && ipTokensPerDay() > 0 && (await spentToday(space, visitor)) + usage.total >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up");
			await admitAgentAttempt(space, call, usage);
			signal.throwIfAborted();
		},
	});
	const open = new Set<string>();
	let stopping = false;
	const halt = new AbortController();
	// the limits every model process shares: calls per minute and per UTC day, web searches per day (quota.ts)
	setCallGate(() => awaitQuota(space, "llm", callLimits(), "daily model budget used up"));
	const search = (q: string) => webSearch(q, { allowed: async () => (await takeQuota(space, "search", { perDay: searchesPerDay() })).ok });

	/** ModelInfo: what the page and the web process need to know about this process's models (renewed every 10 s). */
	const procId = randomBytes(6).toString("hex");
	let infoLease: string | null = null, lastInfo = "";
	const publish = async () => {
		try {
			if (!fakes) await applyAdmin(space);
			const info = fakes
				? await (async () => { const labels = await fakes.models(); return { info: { enabled: true, on: true, current: labels[0] ?? null, models: labels.map((l) => ({ id: l.split("/")[1] ?? l, label: l })) }, admin: { enabled: true, on: true, models: labels.map((l) => ({ label: l, provider: l.split("/")[0] ?? "", id: l.split("/")[1] ?? l, name: l })), allowed: labels, custom: false } }; })()
				: { info: await llmInfo(), admin: await adminModels() };
			const text = JSON.stringify(info);
			if (text === lastInfo && infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
			// this process's own entry (the web process merges those of every model process): replaced when it changes
			if (infoLease) await space.cancel(infoLease).catch(() => {});
			infoLease = (await space.write({ type: "ModelInfo", fields: { procId, ...info, ts: Date.now() } as never }, null, 30_000)).id;
			lastInfo = text;
		} catch (e) { if (!stopping) console.error("[model] publishing the models failed", (e as Error).message); }
	};
	await publish();
	const beat = setInterval(() => void publish(), 10_000); beat.unref?.();

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
				if (call.runId && !(await readExisting(space, { type: "CodeRun", fields: { session: call.session, runId: call.runId } }).catch(() => true))) throw new Error("the run is over");
				const visitor = call.client && !call.client.admin ? call.client.ip : null;
				if (visitor && ipTokensPerDay() > 0 && (await spentToday(space, visitor)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (CODEMODE_TOKENS_PER_IP_DAY)");
				const args = await callArgs(space, call);
				// every paid call counts, also when the work fails after it: the meter of the real models, else what the
				// answer (or a fake's error) reports
				// a call of a run is stopped with it: while the model works, the run is looked for every 2 s
				const stop = new AbortController();
				const cancel = () => stop.abort();
				halt.signal.addEventListener("abort", cancel, { once: true });
				const watch = call.runId ? setInterval(() => { void readExisting(space, { type: "CodeRun", fields: { session: call.session, runId: call.runId! } }).then((r) => { if (!r) stop.abort(); }, () => {}); }, RUN_WATCH_MS) : undefined;
				const api = apiFor(call.session);
				const selected = durable && call.kind === "contribute" && !isText((args as { task: Task }).task)
					? { ...api, contribute: () => durable.contribute(call, args as unknown as Parameters<typeof llmContribution>[0], stop.signal) }
					: api;
				const m = await metered(() => answer(selected, call.kind, args, search), stop.signal).finally(() => {
					clearInterval(watch); halt.signal.removeEventListener("abort", cancel);
				});
				const said = m.value?.usage ?? (m.error as { usage?: Usage } | undefined)?.usage;
				usage = m.usage.total > 0 || m.usage.costUsd > 0 ? m.usage : said;
				if (m.error !== undefined) throw stop.signal.aborted ? new Error("the run is over") : m.error;
				result = { ok: true, value: { ...m.value!.value, ...(usage ? { usage } : {}) } };
			} catch (err) { result = { ok: false, error: String((err as Error).message ?? err).slice(0, 300) }; }
			// the usage rides along on a failure too: the agent books it when it takes the result
			await space.write({ type: "LlmResult", fields: { callId: call.callId, session: call.session, ...result, ...(usage && !result.ok ? { usage } : {}), ts: Date.now() } as never }, t.id, RESULT_LEASE_MS);
			if (usage && usage.total > 0 && call.client && !call.client.admin) await space.write({ type: "Spend", fields: { ip: call.client.ip, day: today(), tokens: usage.total, ts: Date.now() } }, t.id, SPEND_LEASE_MS);
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
	const loops = Array.from({ length: Math.max(1, o.parallel ?? Number(process.env.CODEMODE_MODEL_PARALLEL ?? 2)) }, () => worker());
	return {
		async close() {
			stopping = true; halt.abort(); clearInterval(beat);
			await Promise.allSettled([...open].map((id) => space.abort(id)));
			await Promise.race([Promise.allSettled(loops), new Promise((r) => setTimeout(r, 3000))]);
			await durable?.close();
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
