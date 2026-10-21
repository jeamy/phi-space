// Limits every process reads from the environment (the same .env everywhere).
const envNumber = (name: string, dflt: number) => { const raw = process.env[name]; const n = raw === undefined || raw.trim() === "" ? dflt : Number(raw); return Number.isFinite(n) && n >= 0 ? n : dflt; };
/** A visitor's run budget in tokens (CODEMODE_RUN_BUDGET_TOKENS, default 300 000; 0 = none): the default when the run
 *  names none, and the most a visitor may ask for. An admin's run has no default and no cap. */
export const runBudgetTokens = () => Math.floor(envNumber("CODEMODE_RUN_BUDGET_TOKENS", 300_000));
/** Tokens the runs one client (IP) starts may use per day together (CODEMODE_TOKENS_PER_IP_DAY, default 1 000 000;
 *  0 = no limit), so one visitor cannot use up the day's model calls of everyone. Admin runs do not count. */
export const ipTokensPerDay = () => Math.floor(envNumber("CODEMODE_TOKENS_PER_IP_DAY", 1_000_000));
/** How long a text answer's judgement waits for an agent of another model than the author's before the author's model
 *  may judge it (CODEMODE_CROSS_WAIT_S, default 300 s; 0 = no wait). */
export const crossWaitMs = () => Math.round(envNumber("CODEMODE_CROSS_WAIT_S", 300) * 1000);
/** How long an agent waits for the answer of a model call (CODEMODE_MODEL_WAIT_S, default 600 s): longer than the
 *  model process's worst case (a full minute window, the queue of calls, the 60 s call itself). */
export const modelWaitMs = () => Math.round(envNumber("CODEMODE_MODEL_WAIT_S", 600) * 1000);
/** Errors of a model call after which no call of the run can succeed: the run ends as over budget. */
export const FATAL_LLM = /daily model budget used up|model agents are off|model budget of today for your address/i;
/** Today, as the key of the per-address allowance. */
export const today = () => new Date().toISOString().slice(0, 10);
