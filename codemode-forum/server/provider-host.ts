// The model process's side of the providers (docs/forum-seite-plan-2026-11-26.en.md, section 8; the entries are in
// providers.ts): it publishes its providers, takes the jobs addressed to it and runs pi-ai's login flows, writing what a
// flow asks or says as prompts and opening the sealed answers with the login's private key, which stays in this
// process's memory. A login whose process dies lapses with it and is never run again. Removing a credential and the
// test call are jobs too. Every write back to the space is scrubbed of what was typed into the login.
import { hostname } from "node:os";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { open, answerAad, loginKeys, type Sealed } from "./seal.ts";
import { AFTER_MS, LOGIN_LEASE_MS, LOGIN_MAX_MS, type EventShape, type LoginState, type ProviderInfo, type ProviderJob, type ProviderPrompt, type ProviderResult, type ProviderView, type PromptShape } from "./providers.ts";
import { awaitWork } from "./space.ts";

/** What this module needs of pi-ai's Models, typed loosely: the web process never loads pi-ai, and tests bring their own. */
export type ModelsLike = {
	getProviders(): readonly any[];
	checkAuth(id: string): Promise<{ type: "api_key" | "oauth"; source?: string } | undefined>;
	login(id: string, type: "api_key" | "oauth", interaction: any, options?: any): Promise<unknown>;
	logout(id: string): Promise<void>;
};

/** Each provider as the page shows it; credentials by kind and source only. */
export async function providerViews(models: ModelsLike): Promise<ProviderView[]> {
	const out: ProviderView[] = [];
	for (const p of models.getProviders()) {
		let state: ProviderView["state"] = null;
		try { const a = await models.checkAuth(p.id); if (a) state = { type: a.type, ...(a.source ? { source: String(a.source) } : {}) }; } catch { /* unconfigured */ }
		let n = 0;
		try { n = p.getModels().length; } catch { /* a provider without a list */ }
		out.push({ id: String(p.id), name: String(p.name ?? p.id), models: n, apiKey: p.auth?.apiKey?.login ? String(p.auth.apiKey.name ?? "API key") : null, oauth: p.auth?.oauth ? String(p.auth.oauth.loginLabel ?? p.auth.oauth.name ?? "Sign in") : null, state, stored: !!state && (state.type === "oauth" || state.source === "stored credential") });
	}
	// those with credentials first, then by name
	return out.sort((a, b) => Number(!!b.state) - Number(!!a.state) || a.name.localeCompare(b.name));
}

/** Replaces every typed-in value (and its first and last part, should a message quote it cut) in a text that goes back
 *  to the space. */
export function scrub(text: string, said: Iterable<string>): string {
	let out = text;
	for (const s of said) {
		if (s.length < 4) continue;
		for (const part of new Set([s, s.slice(0, 12), s.slice(-12)])) if (part.length >= 4) out = out.split(part).join("•••");
	}
	return out.slice(0, 400);
}

const promptShape = (p: any): PromptShape => p.type === "select"
	? { type: "select", message: String(p.message ?? ""), options: (p.options ?? []).map((o: any) => ({ id: String(o.id), label: String(o.label ?? o.id), ...(o.description ? { description: String(o.description) } : {}) })) }
	: { type: p.type === "secret" || p.type === "manual_code" ? p.type : "text", message: String(p.message ?? ""), ...(p.placeholder ? { placeholder: String(p.placeholder) } : {}) };
const eventShape = (e: any): EventShape | null => {
	if (e?.type === "auth_url") return { type: "auth_url", url: String(e.url), ...(e.instructions ? { instructions: String(e.instructions) } : {}) };
	if (e?.type === "device_code") return { type: "device_code", userCode: String(e.userCode), verificationUri: String(e.verificationUri), ...(typeof e.expiresInSeconds === "number" ? { expiresInSeconds: e.expiresInSeconds } : {}) };
	if (e?.type === "info") return { type: "info", message: String(e.message ?? ""), ...(Array.isArray(e.links) ? { links: e.links.map((l: any) => ({ url: String(l.url), ...(l.label ? { label: String(l.label) } : {}) })) } : {}) };
	if (e?.type === "progress") return { type: "progress", message: String(e.message ?? "") };
	return null;
};

export type ProviderHost = { publish: () => Promise<void>; close: () => Promise<void> };

/** `models`: pi-ai's Models with the credential file (null: none could be made); `llmOn`: whether model calls are on
 *  here (the test call needs them); `test`: one call of a few tokens to a model of the provider. */
export function startProviderHost(o: {
	space: SpaceLike; procId: string; models: () => Promise<ModelsLike | null>; llmOn: () => boolean;
	test: (provider: string) => Promise<{ model: string; tokens: number; costUsd: number }>;
	onTestSpend?: (s: { model: string; tokens: number; costUsd: number; by: string }) => Promise<void>;
}): ProviderHost {
	const { space, procId } = o;
	const halt = new AbortController();
	const running = new Set<Promise<void>>();
	let infoLease: string | null = null, last = "";

	const publish = async () => {
		const models = await o.models();
		const info: ProviderInfo = { procId, host: process.env.FORUM_HOST_NAME || hostname(), llm: o.llmOn(), providers: models ? await providerViews(models) : [], ts: Date.now() };
		const text = JSON.stringify({ ...info, ts: 0 });
		if (text === last && infoLease) { try { await space.renew(infoLease, 30_000); return; } catch { infoLease = null; } }
		if (infoLease) await space.cancel(infoLease).catch(() => {});
		infoLease = (await space.write({ type: "ProviderInfo", fields: info as never }, null, 30_000)).id;
		last = text;
	};

	const result = async (r: Omit<ProviderResult, "procId" | "ts">) => {
		await space.write({ type: "ProviderResult", fields: { ...r, procId, ts: Date.now() } satisfies ProviderResult as never }, null, AFTER_MS);
	};

	const login = async (job: ProviderJob, models: ModelsLike) => {
		const loginId = job.jobId, keys = loginKeys(), said: string[] = [];
		const base: Omit<LoginState, "state" | "ts"> = { loginId, procId, provider: job.provider, auth: job.auth!, by: job.by };
		let lease = (await space.write({ type: "ProviderLogin", fields: { ...base, state: "running", ts: Date.now() } satisfies LoginState as never }, null, LOGIN_LEASE_MS)).id;
		const ctl = new AbortController();
		const cutAt = setTimeout(() => ctl.abort(new Error("The login took longer than ten minutes")), LOGIN_MAX_MS);
		const onHalt = () => ctl.abort(new Error("The model process stopped"));
		halt.signal.addEventListener("abort", onHalt, { once: true });
		// the login's entry renewed while the flow runs; taken by the web process (cancelled) or lost, the flow stops
		const beat = setInterval(() => { void space.renew(lease, LOGIN_LEASE_MS).catch(() => ctl.abort(new Error("The login was cancelled"))); }, LOGIN_LEASE_MS / 4);
		const prompts: string[] = [];
		let seq = 0;
		const writePrompt = async (p: Omit<ProviderPrompt, "loginId" | "procId" | "promptId" | "seq" | "ts">) => {
			const promptId = `p${++seq}`;
			prompts.push((await space.write({ type: "ProviderPrompt", fields: { loginId, procId, promptId, seq, ...p, ts: Date.now() } satisfies ProviderPrompt as never }, null, LOGIN_MAX_MS + AFTER_MS)).id);
			return promptId;
		};
		const interaction = {
			signal: ctl.signal,
			notify: (e: unknown) => { const ev = eventShape(e); if (ev) void writePrompt({ event: ev }).catch(() => {}); },
			prompt: async (p: any) => {
				const promptId = await writePrompt({ prompt: promptShape(p), publicKey: keys.publicKey });
				const aad = answerAad(loginId, promptId, procId);
				for (;;) {
					if (ctl.signal.aborted) throw ctl.signal.reason ?? new Error("cancelled");
					if (p.signal?.aborted) throw new Error("This question is no longer asked");
					const a = await space.take({ type: "ProviderAnswer", fields: { loginId, promptId } }, 2_000);
					if (!a) continue;
					try {
						const value = open(keys.privateKey, (a.fields as { sealed: Sealed }).sealed, aad);
						said.push(value);
						return value;
					} catch { await writePrompt({ event: { type: "info", message: "That answer could not be opened; please answer again." } }); }
				}
			},
		};
		let state: LoginState["state"] = "failed", error: string | undefined;
		try {
			await models.login(job.provider, job.auth!, interaction, { agentName: "FORUM" });
			state = "done";
		} catch (e) {
			error = scrub(String((ctl.signal.aborted ? ctl.signal.reason?.message : undefined) ?? (e as Error)?.message ?? e), said);
		} finally {
			clearInterval(beat); clearTimeout(cutAt); halt.signal.removeEventListener("abort", onHalt);
			await Promise.allSettled(prompts.map((id) => space.cancel(id)));
			await space.cancel(lease).catch(() => {});
			said.length = 0;
		}
		lease = (await space.write({ type: "ProviderLogin", fields: { ...base, state, ...(error ? { error } : {}), ts: Date.now() } satisfies LoginState as never }, null, AFTER_MS)).id;
		await publish().catch(() => {});
	};

	const work = async (job: ProviderJob) => {
		const models = await o.models();
		if (!models) { await result({ jobId: job.jobId, provider: job.provider, kind: job.kind === "login" ? "test" : job.kind, ok: false, error: "No providers in this process" }); return; }
		if (job.kind === "login") return login(job, models);
		if (job.kind === "logout") {
			try { await models.logout(job.provider); await result({ jobId: job.jobId, provider: job.provider, kind: "logout", ok: true }); }
			catch (e) { await result({ jobId: job.jobId, provider: job.provider, kind: "logout", ok: false, error: String((e as Error).message).slice(0, 300) }); }
			await publish().catch(() => {});
			return;
		}
		const t0 = Date.now();
		try {
			const r = await o.test(job.provider);
			await o.onTestSpend?.({ ...r, by: job.by });
			await result({ jobId: job.jobId, provider: job.provider, kind: "test", ok: true, model: r.model, ms: Date.now() - t0 });
		} catch (e) {
			await result({ jobId: job.jobId, provider: job.provider, kind: "test", ok: false, ms: Date.now() - t0, error: String((e as Error).message ?? e).slice(0, 300) });
		}
	};

	const loop = (async () => {
		while (!halt.signal.aborted) {
			try {
				if (!(await awaitWork(space, { type: "ProviderJob", fields: { procId } }, halt.signal))) continue;
				const e = await space.take({ type: "ProviderJob", fields: { procId } }, NO_WAIT);
				if (!e) continue;
				const p = work(e.fields as unknown as ProviderJob).catch((err) => console.error("[model] provider job failed", (err as Error).message));
				running.add(p); void p.finally(() => running.delete(p));
			} catch (err) { if (halt.signal.aborted) return; console.error("[model] provider jobs", (err as Error).message); await new Promise((r) => setTimeout(r, 1000)); }
		}
	})();

	return {
		publish,
		async close() {
			halt.abort();
			await Promise.race([Promise.allSettled([loop, ...running]), new Promise((r) => setTimeout(r, 3000))]);
			if (infoLease) await space.cancel(infoLease).catch(() => {});
		},
	};
}
