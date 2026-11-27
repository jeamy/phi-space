// Models and their providers from the page (docs/forum-seite-plan-2026-11-26.en.md, section 8): the entries the web
// process and the model processes exchange, and the web process's side of them. No pi-ai here (the web process loads
// this module); the model process's side is provider-host.ts.
//
//   ProviderInfo      per model process, leased and renewed: each provider, the logins it offers, whether credentials
//                     are there and of which kind (never the credential), whether model calls are on
//   ProviderJob       one thing an administrator asked a model process to do: a login (api_key or oauth), removing a
//                     credential, a test call; taken by that process
//   ProviderLogin     a login in progress (its state: running, done, failed), leased by the model process and renewed
//                     while the flow runs: a process that dies lets it lapse and the login is over, never run again;
//                     the web process ends it early by taking it
//   ProviderPrompt    what the flow asks or says (a link, a device code, a field for a key or a code), in order; a
//                     prompt that expects an answer carries the public key of this login (seal.ts)
//   ProviderAnswer    the administrator's answer to one prompt, sealed in the web process, leased for one minute
//   ProviderResult    what a removal or a test call came to
//   AdminAudit        who did what, when: every login, removal, test and setting (never a secret)
import { randomBytes } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { answerAad, seal } from "./seal.ts";

export type AuthKind = "api_key" | "oauth";
export type ProviderView = {
	id: string; name: string; models: number;
	/** the name of its key login, null: no key can be entered (ambient credentials only, or none) */
	apiKey: string | null;
	/** the label of its sign-in, null: none */
	oauth: string | null;
	/** credentials there: of which kind, and where from (a variable's name, "stored credential", "OAuth") */
	state: { type: AuthKind; source?: string } | null;
	/** the credentials are in the process's file (a login made them), so the page may remove them */
	stored: boolean;
};
export type ProviderInfo = { procId: string; host: string; llm: boolean; providers: ProviderView[]; ts: number };
export type ProviderJob = { jobId: string; procId: string; kind: "login" | "logout" | "test"; provider: string; auth?: AuthKind; by: string; ts: number };
export type LoginState = { loginId: string; procId: string; provider: string; auth: AuthKind; state: "running" | "done" | "failed"; error?: string; by: string; ts: number };
export type PromptShape =
	| { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
	| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> };
export type EventShape =
	| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
	| { type: "auth_url"; url: string; instructions?: string }
	| { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
	| { type: "progress"; message: string };
export type ProviderPrompt = { loginId: string; procId: string; promptId: string; seq: number; prompt?: PromptShape; event?: EventShape; publicKey?: string; ts: number };
export type ProviderResult = { jobId: string; procId: string; provider: string; kind: "logout" | "test"; ok: boolean; model?: string; ms?: number; error?: string; ts: number };
export type AdminAudit = { by: string; what: string; detail: string; ts: number };

/** A login in progress is renewed this often by the model process; it lapses after the lease. */
export const LOGIN_LEASE_MS = Number(process.env.FORUM_LOGIN_LEASE_MS || 20_000);
/** The longest a login may take, from the job to the credential. */
export const LOGIN_MAX_MS = 10 * 60_000;
/** An answer waits this long for its model process. */
export const ANSWER_LEASE_MS = 60_000;
/** What is left of a finished login, a result and a job nobody took. */
export const AFTER_MS = 10 * 60_000;
const AUDIT_MS = 400 * 86_400_000;

const PROVIDER = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const newId = (p: string) => p + randomBytes(9).toString("base64url");

export async function audit(space: SpaceLike, by: string, what: string, detail: string): Promise<void> {
	await space.write({ type: "AdminAudit", fields: { by, what, detail, ts: Date.now() } satisfies AdminAudit as never }, null, AUDIT_MS);
}

/** Everything the page's administration shows: each model process with its providers, the logins of the last minutes
 *  with their prompts, the latest results. */
export async function providerState(space: SpaceLike) {
	const procs = (await space.readAll({ type: "ProviderInfo" }, { limit: 50 })).map((e) => e.fields as unknown as ProviderInfo).sort((a, b) => a.host.localeCompare(b.host) || a.procId.localeCompare(b.procId));
	const logins = (await space.readAll({ type: "ProviderLogin" }, { limit: 50 })).map((e) => e.fields as unknown as LoginState);
	const prompts = (await space.readAll({ type: "ProviderPrompt" }, { limit: 500 })).map((e) => e.fields as unknown as ProviderPrompt);
	const results = (await space.readAll({ type: "ProviderResult" }, { limit: 100 })).map((e) => e.fields as unknown as ProviderResult).sort((a, b) => b.ts - a.ts);
	const jobs = (await space.readAll({ type: "ProviderJob" }, { limit: 100 })).map((e) => e.fields as unknown as ProviderJob);
	return {
		procs,
		logins: logins.sort((a, b) => b.ts - a.ts).map((l) => ({ ...l, prompts: l.state === "running" ? prompts.filter((p) => p.loginId === l.loginId).sort((a, b) => a.seq - b.seq) : [] })),
		results: results.slice(0, 20),
		pending: jobs.map((j) => ({ jobId: j.jobId, procId: j.procId, kind: j.kind, provider: j.provider, ts: j.ts })),
	};
}

/** An administrator's request to a model process; the job's ID (also the login's). */
export async function askProvider(space: SpaceLike, by: string, b: { procId?: unknown; provider?: unknown; kind?: unknown; auth?: unknown }): Promise<string> {
	const procId = String(b.procId ?? ""), provider = String(b.provider ?? "");
	const kind = b.kind === "login" || b.kind === "logout" || b.kind === "test" ? b.kind : null;
	if (!kind) throw new Error("login, logout or test");
	if (!PROVIDER.test(provider)) throw new Error("No such provider");
	const info = (await space.readIfExists({ type: "ProviderInfo", fields: { procId } }, NO_WAIT))?.fields as unknown as ProviderInfo | undefined;
	if (!info) throw new Error("No such model process (it may have stopped)");
	const p = info.providers.find((x) => x.id === provider);
	if (!p) throw new Error("No such provider");
	const auth: AuthKind | undefined = kind === "login" ? (b.auth === "oauth" ? "oauth" : b.auth === "api_key" ? "api_key" : undefined) : undefined;
	if (kind === "login" && (!auth || (auth === "oauth" ? !p.oauth : !p.apiKey))) throw new Error("This provider has no such login");
	if (kind === "test" && !info.llm) throw new Error("Model calls are off in this process (FORUM_LLM), so it cannot test");
	if (kind === "logout" && !p.stored) throw new Error(p.state ? `These credentials come from ${p.state.source ?? "the environment"}, which only the operator changes` : "There are no credentials to remove");
	const jobId = newId(kind === "login" ? "l" : "j");
	const job: ProviderJob = { jobId, procId, kind, provider, ...(auth ? { auth } : {}), by, ts: Date.now() };
	await space.write({ type: "ProviderJob", fields: job as never }, null, AFTER_MS);
	await audit(space, by, `provider ${kind}`, `${provider}${auth ? ` (${auth})` : ""} on ${info.host}`);
	return jobId;
}

/** The administrator's answer to one prompt: sealed here to the login's key, then gone from this process. */
export async function answerPrompt(space: SpaceLike, b: { loginId?: unknown; promptId?: unknown; value?: unknown }): Promise<void> {
	const loginId = String(b.loginId ?? ""), promptId = String(b.promptId ?? "");
	const value = typeof b.value === "string" ? b.value : "";
	if (!value || value.length > 8000) throw new Error("An answer of 1 to 8000 characters");
	const p = (await space.readIfExists({ type: "ProviderPrompt", fields: { loginId, promptId } }, NO_WAIT))?.fields as unknown as ProviderPrompt | undefined;
	if (!p?.prompt || !p.publicKey) throw new Error("This question is no longer open");
	if (!(await space.readIfExists({ type: "ProviderLogin", fields: { loginId, state: "running" } }, NO_WAIT))) throw new Error("This login is over");
	const sealed = seal(p.publicKey, value, answerAad(loginId, promptId, p.procId));
	await space.write({ type: "ProviderAnswer", fields: { loginId, promptId, procId: p.procId, sealed } as never }, null, ANSWER_LEASE_MS);
}

/** Ends a login early: its entry is taken, the model process sees it gone and stops the flow. */
export async function cancelLogin(space: SpaceLike, loginId: string): Promise<void> {
	await space.take({ type: "ProviderLogin", fields: { loginId: String(loginId), state: "running" } }, NO_WAIT);
	await space.take({ type: "ProviderJob", fields: { jobId: String(loginId) } }, NO_WAIT);
}
