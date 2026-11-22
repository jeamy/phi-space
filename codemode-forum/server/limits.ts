// Limits every process reads from the environment (the same .env everywhere). Taken over from codemode-chat, cut down
// to what the forum has.
const envNumber = (name: string, dflt: number) => { const raw = process.env[name]; const n = raw === undefined || raw.trim() === "" ? dflt : Number(raw); return Number.isFinite(n) && n >= 0 ? n : dflt; };
/** A run names at least three models and at most five (docs/gemeinsame-planung-plan-2026-11-22.en.md, section 5). */
export const MIN_MODELS = 3, MAX_MODELS = 5;
/** Agents per model in a run: more of them make a model faster, not stronger. */
export const MAX_AGENTS_PER_MODEL = 3;
/** A visitor's run budget in tokens (FORUM_RUN_BUDGET_TOKENS, default 300 000; 0 = none): the default when the run
 *  names none, and the most a visitor may ask for. An admin's run names its own budget. */
export const runBudgetTokens = () => Math.floor(envNumber("FORUM_RUN_BUDGET_TOKENS", 300_000));
/** Tokens the runs one client (IP) starts may use per day together (FORUM_TOKENS_PER_IP_DAY, default 1 000 000;
 *  0 = no limit), so one visitor cannot use up the day's model calls of everyone. Admin runs do not count. */
export const ipTokensPerDay = () => Math.floor(envNumber("FORUM_TOKENS_PER_IP_DAY", 1_000_000));
/** How long an agent waits for the answer of a model call (FORUM_MODEL_WAIT_S, default 600 s): longer than the
 *  model process's worst case (a full minute window, the queue of calls, the call itself). */
export const modelWaitMs = () => Math.round(envNumber("FORUM_MODEL_WAIT_S", 600) * 1000);
/** Errors of a model call after which no call of the run can succeed: the run ends as over budget. */
export const FATAL_LLM = /daily model budget used up|model agents are off|model budget of today for your address/i;
/** Today (UTC), as the key of the per-address allowance. */
export const today = () => new Date().toISOString().slice(0, 10);
