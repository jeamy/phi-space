// What the page sets, within what the operator allows (docs/forum-seite-plan-2026-11-26.en.md, sections 8 and 9). The
// environment is the ceiling: a value above it is refused when it is written, and a value that was saved below a ceiling
// the operator lowered later is cut to it when it is used. Kept as ForumSetting entries, one per key, for good:
//
//   key "limits"        an administrator's: calls per minute and per day (all model processes together), the tokens a
//                       person's runs may use per day, the largest budget of a run
//   key "room:<room>"   the room owner's defaults: models (three to five), agents per model, rounds, the way of
//                       working, the run budget (also the most a member's run may ask for), how long the table waits for
//                       the person
//
// Every change writes a line a later reader can follow (an AdminAudit entry, a line in the room).
import { FOREVER, NO_WAIT, type SpaceLike } from "phi-spaces";
import { audit } from "./providers.ts";
import { ipTokensPerDay, MAX_AGENTS_PER_MODEL, MAX_MODELS, MIN_MODELS, personWaitMs, runBudgetTokens } from "./limits.ts";
import { MAX_ROUNDS } from "./run.ts";
import { takeExisting } from "./space.ts";

export type AdminLimits = { perMin?: number; perDay?: number; personTokensPerDay?: number; runBudgetTokens?: number };
export type Way = "both" | "parallel" | "turns";
export type RoomDefaults = { models?: string[]; perModel?: number; rounds?: number; way?: Way; budgetTokens?: number; personWaitS?: number };

const envNum = (name: string, dflt: number) => { const n = Number(process.env[name] ?? dflt); return Number.isFinite(n) && n >= 0 ? n : dflt; };
/** The operator's ceilings; 0 for the token ones means none. */
export const ceilings = () => ({
	perMin: envNum("FORUM_LLM_PER_MIN", 20), perDay: envNum("FORUM_LLM_PER_DAY", 500),
	personTokensPerDay: ipTokensPerDay(), runBudgetTokens: runBudgetTokens(),
	personWaitS: Math.round(personWaitMs() / 1000),
});
export type Ceilings = ReturnType<typeof ceilings>;

const whole = (v: unknown, name: string, min: number): number | undefined => {
	if (v === undefined || v === null || v === "") return undefined;
	const n = Number(v);
	if (!Number.isInteger(n) || n < min) throw new Error(`${name}: a whole number from ${min}`);
	return n;
};
/** `ceiling` 0 means none (the token values); `name` says which field. */
const within = (n: number | undefined, ceiling: number, name: string, noneIsZero: boolean): number | undefined => {
	if (n === undefined) return undefined;
	if ((ceiling > 0 || !noneIsZero) && n > ceiling) throw new Error(`${name} ${n} is above the operator's ceiling ${ceiling}`);
	return n;
};
const cut = (n: number | undefined, ceiling: number, noneIsZero: boolean) => n === undefined ? undefined : (noneIsZero && ceiling === 0 ? n : Math.min(n, ceiling));

/** An administrator's limits checked against the ceilings (refused above them). */
export function checkLimits(b: Record<string, unknown>, c = ceilings()): AdminLimits {
	const l: AdminLimits = {};
	const set = <K extends keyof AdminLimits>(k: K, v: number | undefined) => { if (v !== undefined) l[k] = v; };
	set("perMin", within(whole(b.perMin, "Calls per minute", 1), c.perMin, "Calls per minute", false));
	set("perDay", within(whole(b.perDay, "Calls per day", 1), c.perDay, "Calls per day", false));
	set("personTokensPerDay", within(whole(b.personTokensPerDay, "Tokens per person and day", 1000), c.personTokensPerDay, "Tokens per person and day", true));
	set("runBudgetTokens", within(whole(b.runBudgetTokens, "Largest run budget", 1000), c.runBudgetTokens, "Largest run budget", true));
	return l;
}

/** The limits in force: the administrator's, cut to the ceilings of now. */
export function effectiveLimits(l: AdminLimits, c = ceilings()) {
	return {
		perMin: cut(l.perMin, c.perMin, false) ?? c.perMin,
		perDay: cut(l.perDay, c.perDay, false) ?? c.perDay,
		personTokensPerDay: cut(l.personTokensPerDay, c.personTokensPerDay, true) ?? c.personTokensPerDay,
		runBudgetTokens: cut(l.runBudgetTokens, c.runBudgetTokens, true) ?? c.runBudgetTokens,
	};
}

/** A room owner's defaults checked: the models among those allowed now, the budget within the largest a run may have. */
export function checkRoom(b: Record<string, unknown>, o: { allowed: string[]; runCeiling: number; c?: Ceilings }): RoomDefaults {
	const c = o.c ?? ceilings();
	const d: RoomDefaults = {};
	if (b.models !== undefined && b.models !== null) {
		const models = [...new Set(Array.isArray(b.models) ? b.models.map(String) : [])];
		if (models.length && (models.length < MIN_MODELS || models.length > MAX_MODELS)) throw new Error(`The room's models: ${MIN_MODELS} to ${MAX_MODELS}, or none`);
		for (const m of models) if (!o.allowed.includes(m)) throw new Error(`Model not available: ${m}`);
		if (models.length) d.models = models;
	}
	const perModel = whole(b.perModel, "Agents per model", 1);
	if (perModel !== undefined) { if (perModel > MAX_AGENTS_PER_MODEL) throw new Error(`Agents per model: at most ${MAX_AGENTS_PER_MODEL}`); d.perModel = perModel; }
	const rounds = whole(b.rounds, "Rounds", 0);
	if (rounds !== undefined) { if (rounds > MAX_ROUNDS) throw new Error(`Rounds: at most ${MAX_ROUNDS}`); d.rounds = rounds; }
	if (b.way !== undefined && b.way !== null && b.way !== "") { if (b.way !== "both" && b.way !== "parallel" && b.way !== "turns") throw new Error("The way: both, parallel or turns"); d.way = b.way; }
	const budget = within(whole(b.budgetTokens, "Run budget", 1000), o.runCeiling, "Run budget", true);
	if (budget !== undefined) d.budgetTokens = budget;
	const wait = within(whole(b.personWaitS, "Waiting for the person", 0), c.personWaitS, "Waiting for the person (s)", false);
	if (wait !== undefined) d.personWaitS = wait;
	return d;
}

async function readSetting<T>(space: SpaceLike, key: string): Promise<T | null> {
	const e = await space.readIfExists({ type: "ForumSetting", fields: { key } }, NO_WAIT);
	return e ? ((e.fields as { value?: T }).value ?? null) : null;
}
/** Replaces the setting `key` in one transaction (the entry is unique per key). */
async function writeSetting(space: SpaceLike, key: string, value: unknown, by: string): Promise<void> {
	const t = await space.createTransaction(30_000);
	try {
		await takeExisting(space, { type: "ForumSetting", fields: { key } }, { txn: t.id });
		await space.write({ type: "ForumSetting", fields: { key, value, by, ts: Date.now() } as never }, t.id, FOREVER);
		await space.commit(t.id);
	} catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
}

export const readLimits = async (space: SpaceLike): Promise<AdminLimits> => (await readSetting<AdminLimits>(space, "limits")) ?? {};
export async function saveLimits(space: SpaceLike, by: string, l: AdminLimits): Promise<void> {
	await writeSetting(space, "limits", l, by);
	await audit(space, by, "limits", JSON.stringify(l));
}
export const readRoom = async (space: SpaceLike, room: string): Promise<RoomDefaults> => (await readSetting<RoomDefaults>(space, `room:${room}`)) ?? {};
export const saveRoom = (space: SpaceLike, room: string, by: string, d: RoomDefaults) => writeSetting(space, `room:${room}`, d, by);
