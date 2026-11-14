// The judge: runs one contribution in a QuickJS sandbox that can reach no tool, checks it against the task's cases and
// times the bench. Whatever the source is (agent, model or human), it is data and only ever runs here.
//
// The contribution never becomes part of the judging program's text: it is a string literal that an indirect eval runs
// as a script of its own (a top-level `return` is a syntax error there, and it cannot see the judge's locals). The
// builtins the judge relies on are captured before it runs, and the bench input is built before it, so a contribution
// that patches globals (JSON.stringify, toJSON, iterators, Date) only fools itself. The bench's results are checked as
// well as the cases (outside the timed part): code that is only right on the small cases does not win.
//
// Every case is run and reported (what came out, what was expected, or the error), so a contribution that passes 3 of 5
// cases is visibly closer than one that passes none; the team builds on that. A task with a check rule (a predicate
// instead of fixed results) has the rule applied in a SECOND, fresh sandbox to the JSON results, out of the
// contribution's reach: patched builtins cannot make the rule pass.
import { pathToFileURL } from "node:url";
import type { Task } from "./tasks.ts";
import { ArenaDown, arenaAddress, arenaClient, botArg, botCall, BOT_COST, botToolNames, botTools, episodeSeed, MAX_BOT_CALLS, seedsOf, type Arena, type BotEpisode, type BotSpec, type BotTool, type EpisodeResult, type PathStep, type RoomMap } from "./bottask.ts";
import { Diverged, LogDown, runDurable, type CallLog, type LoggedCall, type RunHead } from "./durable-run.ts";
import { harnessTools, type HarnessSpec, type Impl } from "./harnesstask.ts";
import { meterText, newMeter, toolProgram, worldCase, worldTools, type Meter, type ToolSpec, type World, type WorldResult } from "./tooltask.ts";

/** One case as the judge saw it: the call, whether it passed, what came out (or the error), what was expected. */
export type CaseResult = { call: string; ok: boolean; got?: string; expect?: string; error?: string };
/** `hardcoded`: the code passed, but only by returning an expected result written into it (not computed). */
/** A tools task (tooltask.ts) adds what the holdout's run cost: `cost` in points, `calls` per tool, `score` 0..1. */
export type Verdict = { ok: boolean; ms: number; error?: string; passed: number; total: number; cases: CaseResult[]; hardcoded?: true; cost?: number; calls?: Record<string, number>; score?: number; /** a planning task's episodes (bottask.ts) */ episodes?: EpisodeResult[]; /** the rooms the sample paths cross, for drawing them (the judge host keeps them as BotRoom entries) */ rooms?: RoomMap[] };
type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
type SandboxTool = { name: string; description?: string; execute(args: unknown): unknown };
export type Codemode = { CodemodeSandbox: new (o: { timeoutMs: number; tools: SandboxTool[]; memoryLimitBytes?: number }) => Sandbox };

/** The default time a contribution has for all its cases and the bench; a custom task may set its own (timeoutMs). */
export const TIMEOUT_MS = 5000;
/** The most a custom task may allow per contribution: CODEMODE_MAX_TIMEOUT_S, default 600 s. */
export const maxTimeoutMs = (): number => { const s = Number(process.env.CODEMODE_MAX_TIMEOUT_S || 600); return Number.isFinite(s) && s >= 1 ? Math.round(s * 1000) : 600_000; };
/** The time limit of a task's contributions. */
export const limitOf = (task: Task): number => task.timeoutMs ?? TIMEOUT_MS;
export const MAX_SOURCE_CHARS = 16_000;
/** The most a source may take as JSON (escapes count six bytes each): a verdict, the best code and the archived result
 *  carry it, and must fit one commit of the space together. */
export const MAX_SOURCE_BYTES = 40_000;
/** Why a source cannot be handed in (too long as text or as JSON), or null. */
export const sourceProblem = (src: string): string | null => (!src.trim() || src.length > MAX_SOURCE_CHARS ? `Code must be 1 to ${MAX_SOURCE_CHARS} characters` : Buffer.byteLength(JSON.stringify(src)) > MAX_SOURCE_BYTES ? `Code takes more than ${MAX_SOURCE_BYTES} bytes once encoded (control characters count six bytes each)` : null);
export const MAX_CHECK_CHARS = 2000;
const MAX_PARALLEL = 2;
/** Shown text of one value in a case result. */
const SHOW_CHARS = 160;

/** Loads pi-codemode (PI_CODEMODE_DIR overrides the location); null when it cannot be loaded. */
export async function loadCodemode(dir = process.env.PI_CODEMODE_DIR): Promise<Codemode | null> {
	try {
		return (dir ? await import(pathToFileURL(`${dir}/dist/index.js`).href) : await import("@earendil-works/pi-codemode")) as Codemode;
	} catch { return null; }
}

/** Process-wide cap on running sandboxes, so a busy public endpoint cannot start unbounded workers. Judges hold a slot
 *  BEFORE they open a transaction: waiting in this queue must not eat the transaction's lease. */
let running = 0;
const waiting: Array<() => void> = [];
export async function sandboxSlot<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= MAX_PARALLEL) await new Promise<void>((r) => waiting.push(r));
	running++;
	try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

/** Helpers every sandbox program starts with, captured before any contribution runs. */
export const CAPTURED = `const __eval = eval, __now = Date.now, __str = JSON.stringify, __isArray = Array.isArray, __keys = Object.keys, __hasOwn = Object.hasOwn, __apply = Reflect.apply, __String = String;
const __show = (v) => {
	try {
		if (typeof v === "string") return __str(v).length > ${SHOW_CHARS} ? __str(v).slice(0, ${SHOW_CHARS}) + "…" : __str(v);
		if (typeof v === "function") return "[function]";
		const s = __str(v);
		return s === undefined ? __String(v) : s.length > ${SHOW_CHARS} ? s.slice(0, ${SHOW_CHARS}) + "…" : s;
	} catch { return __String(v); }
};
const __msg = (e) => __String(e && e.message !== undefined ? e.message : e).slice(0, 200);
const __eq = (a, b) => {
	if (a === b) return true;
	if (typeof a === "number" && typeof b === "number") return a !== a && b !== b;
	if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
	const arr = __isArray(a);
	if (arr !== __isArray(b)) return false;
	if (arr) { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (!__eq(a[i], b[i])) return false; return true; }
	const ka = __keys(a), kb = __keys(b);
	if (ka.length !== kb.length) return false;
	for (let i = 0; i < ka.length; i++) if (!__hasOwn(b, ka[i]) || !__eq(a[ka[i]], b[ka[i]])) return false;
	return true;
};
// a case's own expectations only (never through the prototype, which a contribution can patch)
const __match = (v, c) => {
	if (__hasOwn(c, "expectAny")) { const any = c.expectAny; for (let i = 0; i < any.length; i++) if (__eq(v, any[i])) return true; return false; }
	return __eq(v, c.expect);
};
const __expectText = (c) => (__hasOwn(c, "expectAny") ? c.expectAny.map(__show).join(" or ") : __show(c.expect));`;

/** The judging program: captured builtins, cases and bench input first, then the contribution, then cases and bench.
 *  `pick`: the bench round whose results a check rule judges (random, so code cannot be right only there). */
export function judgeProgram(task: Task, source: string, pick = 0): string {
	const script = `${source}\n;typeof ${task.fn} === "function" ? ${task.fn} : undefined`;
	const check = task.check !== undefined;
	return `${CAPTURED}
const __cases = ${JSON.stringify(task.cases)};
const __in = ${task.benchInput ?? "undefined"};
const __expect = ${task.benchExpect === undefined ? "undefined" : JSON.stringify(task.benchExpect)};
const __pick = ${pick};
let __picked = [], __last = [], __rounds;
const __fn = __eval(${JSON.stringify(script)});
if (typeof __fn !== "function") return { phase: "cases", cases: [], error: "no function ${task.fn}" };
const __res = [], __outs = [];
let __passed = 0, __threw = false;
const __tc = __now();
for (let __i = 0; __i < __cases.length; __i++) {
	const __c = __cases[__i], __call = "${task.fn}(" + __c.args.map(__show).join(", ") + ")";
	try {
		let __got = __apply(__fn, undefined, __c.args);
		if (__got && typeof __got.then === "function") __got = await __got;
		__outs[__i] = __got;
		${check
			? `__res.push({ call: __call, ok: false, got: __show(__got) });`
			: `const __ok = __match(__got, __c);
		if (__ok) __passed++;
		__res.push({ call: __call, ok: __ok, got: __show(__got), expect: __expectText(__c) });`}
	} catch (e) { __threw = true; __outs[__i] = null; __res.push({ call: __call, ok: false, error: __msg(e)${check ? "" : ", expect: __expectText(__c)"} }); }
}
${check
	? `if (__threw) return { phase: "cases", cases: __res, outs: __outs };`
	: `if (__passed < __cases.length) return { phase: "cases", cases: __res };`}
const __caseMs = __now() - __tc;
const ${task.fn} = __fn;
let __out, __ms;
// a custom task whose cases already took a third of the time limit is timed by that pass: a second one would not fit
if (${task.id === "custom"} && __caseMs * 3 > ${limitOf(task)}) { __ms = __caseMs;${check ? " __picked = __outs;" : ""} }
else {
	const __t = __now();
	{
${task.bench}
	}
	__ms = (__now() - __t) / (__rounds || 1);
}
if (__expect !== undefined && !__eq(__out, __expect)) return { phase: "bench", cases: __res, error: "wrong on the bench input" };
return { phase: "done", cases: __res, ms: __ms${check ? ", outs: __outs, picked: __picked.length ? __picked : __last" : ""} };`;
}

/** The check rule applied to results in a fresh sandbox: per value true, false or the rule's error. */
export function checkProgram(check: string, args: unknown[][], values: unknown[][]): string {
	return `const __check = (${check}\n);
const __args = ${JSON.stringify(args)};
const __sets = ${JSON.stringify(values)};
return __sets.map((vals) => vals.map((v, i) => { try { return __check(v, __args[i]) === true; } catch (e) { return "rule error: " + String(e && e.message !== undefined ? e.message : e).slice(0, 160); } }));`;
}

/** Values that are wrong answers to almost any task, offered to a rule as counter-examples. */
const JUNK: unknown[] = [null, [], {}, -1, 0, "", true, "wrong"];
/** Near misses of an example result, usually wrong: a changed last element, digit or character, one element dropped,
 *  and inside a list every element moved by ±1 and neighbours swapped. A rule that accepts many of them does not check
 *  what makes the result right (a golomb rule that only looked at length, ends and order accepted [0,7,14,22,…]). */
const nearby = (v: unknown): unknown[] => {
	if (typeof v === "number") return [v + 1];
	if (typeof v === "string") return [v + "x"];
	if (!Array.isArray(v) || !v.length) return [];
	const last = v.at(-1), out: unknown[] = [[...v.slice(0, -1), typeof last === "number" ? last + 1 : "x"], v.slice(0, -1)];
	for (let i = 1; i < v.length - 1 && out.length < 40; i++) {
		if (typeof v[i] === "number") for (const d of [1, -1]) out.push(v.map((x, j) => (j === i ? (x as number) + d : x)));
		if (JSON.stringify(v[i]) !== JSON.stringify(v[i + 1])) out.push(v.map((x, j) => (j === i ? v[i + 1] : j === i + 1 ? v[i] : x)));
	}
	return out;
};

/** Tries a check rule before it may decide anything: it must accept every example result, reject null, and reject most
 *  of the obvious wrong answers (junk values and near misses of the examples). Null when it passes, else the reason in
 *  words for the verifier agent. Runs in a sandbox of its own. */
export async function testRule(cm: Codemode, task: Task, check: string, expected: (c: Task["cases"][number]) => unknown[]): Promise<string | null> {
	if (!check.trim() || check.length > MAX_CHECK_CHARS) return "it is empty or too long";
	const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
	const samples: Array<{ args: unknown[]; value: unknown; want: boolean; strict: boolean }> = [];
	for (const c of task.cases) {
		const right = expected(c);
		for (const v of right) samples.push({ args: c.args, value: v, want: true, strict: true });
		for (const v of [...JUNK, ...right.flatMap(nearby)]) if (!right.some((r) => same(r, v))) samples.push({ args: c.args, value: v, want: false, strict: v === null });
	}
	const sandbox = new cm.CodemodeSandbox({ timeoutMs: TIMEOUT_MS, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
	try {
		const r = await sandbox.execute(checkProgram(check, samples.map((x) => x.args as unknown[]), [samples.map((x) => x.value)]));
		if (!r.ok) return `it does not run: ${plain(r.error?.message ?? "error")}`;
		const got = ((r.value as unknown[][])?.[0] ?? []) as Array<true | false | string>;
		const show = (x: (typeof samples)[number]) => `${JSON.stringify(x.value)} for args ${JSON.stringify(x.args)}`;
		const refused = samples.find((x, i) => x.want && got[i] !== true);
		if (refused) return `it rejects the right result ${show(refused)}${typeof got[samples.indexOf(refused)] === "string" ? ` (${got[samples.indexOf(refused)]})` : ""}`;
		const wrong = samples.filter((x) => !x.want), accepted = wrong.filter((x) => got[samples.indexOf(x)] === true);
		const strict = accepted.find((x) => x.strict);
		if (strict) return `it accepts the wrong result ${show(strict)}`;
		if (accepted.length * 3 > wrong.length) return `it accepts too many wrong results, e.g. ${show(accepted[0]!)}`;
		return null;
	} catch (e) {
		return plain((e as Error).message);
	} finally { await sandbox.close().catch(() => {}); }
}

/** An error text as the page shows it: no control characters (each would cost six bytes of JSON), at most 200 chars. */
export const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);

const cleanCases = (cs: unknown): CaseResult[] => (Array.isArray(cs) ? cs : []).slice(0, 50).map((c) => {
	const x = (c ?? {}) as Record<string, unknown>, s = (v: unknown) => (typeof v === "string" ? plain(v) : undefined);
	return { call: s(x.call) ?? "?", ok: x.ok === true, ...(s(x.got) !== undefined ? { got: s(x.got) } : {}), ...(s(x.expect) !== undefined ? { expect: s(x.expect) } : {}), ...(s(x.error) !== undefined ? { error: s(x.error) } : {}) };
});
const firstWrong = (cases: CaseResult[]): string | undefined => {
	const c = cases.find((x) => !x.ok);
	return c ? plain(c.error ? `${c.call}: ${c.error}` : `wrong on ${c.call}`) : undefined;
};

/** The expected result a source contains as a literal (whitespace and quote style ignored), if any: code that returns
 *  the examples instead of computing them. Only results that cannot appear in honest code by chance count: arrays,
 *  objects and strings of six or more characters as JSON, and numbers with six or more digits. */
export function hardcodedLiteral(task: Task, source: string): string | null {
	const squash = (t: string) => t.replace(/\s+/g, "").replace(/'/g, '"');
	const src = squash(source);
	for (const c of task.cases) {
		const right = Object.hasOwn(c, "expectAny") ? c.expectAny! : Object.hasOwn(c, "expect") ? [c.expect] : [];
		for (const v of right) {
			const lit = squash(JSON.stringify(v) ?? "");
			const substantial = typeof v === "number" ? Math.abs(v) >= 100_000 : typeof v === "boolean" || v === null ? false : lit.length >= 6;
			if (substantial && src.includes(lit)) return lit.length > 60 ? lit.slice(0, 60) + "…" : lit;
		}
	}
	return null;
}

/** A holdout run's error as the page and the agents see it: only what the judge itself says (a script could otherwise
 *  throw the hidden data out in its message). */
const OWN_ERRORS = [/^more than \d+ tool calls$/, /^more than \d+ runs$/, /^run needs \{ args: \[\.\.\.\] \}$/, /^run takes at most \d+ bytes of arguments$/, /^[\w$]+\(\) returned no finite number$/, /^classify needs \{ text: string \}$/, /^classify takes at most \d+ characters$/, /^no function [\w$]+$/, /^Execution timed out after \d+ ms$/, /^out of memory$/];
const hideError = (r: WorldResult, limit: number): WorldResult => (r.error && !OWN_ERRORS.some((x) => x.test(r.error!))
	? { ...r, error: `threw on the holdout; its message stays hidden like its data (limit ${limit / 1000} s)` } : r);

/** Judges a tools task: `solve()` runs once in the sample world and once in the holdout, each with that world's tools.
 *  Solved when both score 100 %; the cost, calls and time are the holdout's (the scale it is meant for). */
async function judgeTools(cm: Codemode, task: Task & { tools: ToolSpec }, source: string): Promise<Verdict> {
	const limit = limitOf(task), spec = task.tools, show = (v: unknown) => plain(JSON.stringify(v) ?? String(v));
	const runWorld = async (w: World): Promise<WorldResult> => {
		const meter: Meter = newMeter();
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: limit, tools: worldTools(spec, w, meter), memoryLimitBytes: 64 * 1024 * 1024 });
		try {
			const r = await sandbox.execute(toolProgram(CAPTURED, task.fn, source));
			if (!r.ok) return { score: 0, meter, ms: limit, error: plain(r.error?.message ?? "failed") };
			const v = (r.value ?? {}) as { ms?: unknown; got?: unknown; error?: unknown };
			if (typeof v.error === "string") return { score: 0, meter, ms: limit, error: plain(v.error) };
			// the answer crossed the sandbox as JSON: a patched toJSON fools only the contribution
			return { score: spec.score(v.got, spec.answer(w)), meter, ms: typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? v.ms : limit, got: v.got };
		} catch (e) {
			return { score: 0, meter, ms: limit, error: plain((e as Error).message) };
		} finally { await sandbox.close().catch(() => {}); }
	};
	const sample = await runWorld(spec.sample);
	// an uploaded dataset whose holdout was not loaded (an agent checking its code): the sample only, and no verdict of
	// a judge comes from it (judge-host.ts loads the holdout)
	const holdout = sample.error || spec.holdoutMissing ? null : hideError(await runWorld(spec.holdout), limit);
	const cases = [worldCase(task.fn, spec.sample, sample, spec.answer(spec.sample), show), ...(holdout ? [worldCase(task.fn, spec.holdout, holdout, null, show)] : [])];
	const passed = cases.filter((c) => c.ok).length, total = spec.holdoutMissing ? 1 : 2;
	const last = holdout ?? sample;
	const metered = { cost: last.meter.cost, calls: { ...last.meter.calls } as Record<string, number>, score: Math.round(last.score * 1000) / 1000 };
	if (passed < total) return { ok: false, ms: limit, error: cases.find((c) => !c.ok)?.error ?? `wrong on ${cases.find((c) => !c.ok)?.call ?? "the holdout"}`, passed, total, cases, ...metered };
	const literal = hardcodedLiteral(task, source);
	if (literal) return { ok: false, ms: limit, error: plain(`hard-coded: the code returns the expected result ${literal} as a literal instead of computing it`), passed, total, cases, hardcoded: true, ...metered };
	return { ok: true, ms: Math.round(last.ms * 100) / 100, passed, total, cases, ...metered };
}

/** Judges a harness task (harnesstask.ts): rate() once per implementation, `run` bound to it. The shown ones first; the
 *  hidden ones only when the shown ones are ordered right. Correct when every good implementation scores strictly
 *  higher than every bad one; the cost is the runs on the shown ones, the time rate()'s own on them. */
async function judgeHarness(cm: Codemode, task: Task & { harness: HarnessSpec }, source: string): Promise<Verdict> {
	const limit = limitOf(task), spec = task.harness;
	const make = (o: { timeoutMs: number; tools: SandboxTool[]; memoryLimitBytes?: number }) => new cm.CodemodeSandbox(o);
	type Rated = { impl: Impl; good: boolean; hidden: boolean; score: number | null; ms: number; meter: Meter; error?: string };
	const rate = async (impl: Impl, good: boolean, hidden: boolean): Promise<Rated> => {
		const meter: Meter = newMeter();
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: limit, tools: harnessTools(make, CAPTURED, spec, impl, meter), memoryLimitBytes: 64 * 1024 * 1024 });
		const out = (score: number | null, ms: number, error?: string): Rated => ({ impl, good, hidden, score, ms, meter, ...(error ? { error: hidden && !OWN_ERRORS.some((x) => x.test(error)) ? `threw on a hidden implementation; its message stays hidden (limit ${limit / 1000} s)` : plain(error) } : {}) });
		try {
			const r = await sandbox.execute(toolProgram(CAPTURED, task.fn, source));
			if (!r.ok) return out(null, limit, r.error?.message ?? "failed");
			const v = (r.value ?? {}) as { ms?: unknown; got?: unknown; error?: unknown };
			if (typeof v.error === "string") return out(null, limit, v.error);
			if (typeof v.got !== "number" || !Number.isFinite(v.got)) return out(null, limit, `${task.fn}() returned no finite number`);
			return out(v.got, typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? v.ms : limit);
		} catch (e) {
			return out(null, limit, (e as Error).message);
		} finally { await sandbox.close().catch(() => {}); }
	};
	const all: Rated[] = [];
	for (const [impls, good, hidden] of [[spec.good, true, false], [spec.bad, false, false], [spec.hiddenGood, true, true], [spec.hiddenBad, false, true]] as const) {
		if (hidden && !all.length) continue;
		if (hidden && !ordered(all)) break;
		for (const impl of impls) all.push(await rate(impl, good, hidden));
	}
	function ordered(xs: Rated[]): boolean {
		if (xs.some((x) => x.score === null)) return false;
		const goods = xs.filter((x) => x.good).map((x) => x.score!), bads = xs.filter((x) => !x.good).map((x) => x.score!);
		return !goods.length || !bads.length || Math.min(...goods) > Math.max(...bads);
	}
	// A hidden implementation shows only whether it was ordered right: its score, its runs and its time would be a
	// channel out of it (a harness can encode what it returned in the number it gives back). The shown ones are measured
	// against the shown ones, with the numbers; points and time count the shown ones only.
	const shown = all.filter((x) => !x.hidden), num = (n: number) => String(Math.round(n * 1000) / 1000);
	const bounds = (xs: Rated[]) => { const s = xs.filter((x) => x.score !== null); return { minGood: Math.min(...s.filter((x) => x.good).map((x) => x.score!)), maxBad: Math.max(...s.filter((x) => !x.good).map((x) => x.score!)) }; };
	const seen = bounds(shown), every = bounds(all);
	const cases: CaseResult[] = all.map((x) => {
		const call = `${task.fn}() on ${x.impl.label}`;
		if (x.hidden) {
			if (x.score === null) return { call, ok: false, error: x.error ?? "failed" };
			const ok = x.good ? x.score > every.maxBad : x.score < every.minGood;
			return { call, ok, got: ok ? "ordered right" : "ordered wrong", ...(ok ? {} : { expect: x.good ? "more than every bad one" : "less than every good one" }) };
		}
		const runs = `runs: ${x.meter.total}`;
		if (x.score === null) return { call, ok: false, error: `${x.error ?? "failed"} (${runs})` };
		const ok = x.good ? x.score > seen.maxBad : x.score < seen.minGood;
		return { call, ok, got: `${num(x.score)} (${runs})`, ...(ok ? {} : { expect: x.good ? `more than every bad one (highest shown bad: ${num(seen.maxBad)})` : `less than every good one (lowest shown good: ${num(seen.minGood)})` }) };
	});
	const passed = cases.filter((c) => c.ok).length, total = spec.good.length + spec.bad.length + spec.hiddenGood.length + spec.hiddenBad.length;
	const runs = shown.reduce((a, x) => a + x.meter.total, 0), cost = shown.reduce((a, x) => a + x.meter.cost, 0);
	const metered = { cost, calls: { run: runs }, score: total ? Math.round((passed / total) * 1000) / 1000 : 0 };
	if (passed < total) {
		const bad = cases.find((c) => !c.ok);
		return { ok: false, ms: limit, error: plain(bad ? (bad.error ? `${bad.call}: ${bad.error}` : `${bad.call}: ${bad.got}, expected ${bad.expect}`) : "not every implementation was rated"), passed, total, cases, ...metered };
	}
	return { ok: true, ms: Math.round(shown.reduce((a, x) => a + x.ms, 0) * 100) / 100, passed, total, cases, ...metered };
}

/** Judges one contribution; the caller already holds a sandbox slot. */
/** A bot task (bottask.ts): a world of its own from the arena, opened before the bot's time limit starts; the bot plays
 *  it through look/act/wait, the arena says whether the goal was reached, and the world is closed. One case. */
async function judgeBot(cm: Codemode, task: Task & { bot: BotSpec }, source: string): Promise<Verdict> {
	if (task.bot.episodes?.length) return judgeEpisodes(cm, task, source);
	const limit = limitOf(task), goal = task.bot.goalText.en, call = `${task.fn}() in a world of its own`;
	const fail = (error: string, meter?: Meter): Verdict => ({ ok: false, ms: limit, error: plain(error), passed: 0, total: 1, cases: [{ call, ok: false, error: plain(error), expect: goal }], ...(meter ? { cost: meter.cost, calls: { ...meter.calls } as Record<string, number>, score: 0 } : {}) });
	const address = arenaAddress();
	if (!address) return fail("this judge has no arena (CODEMODE_ARENA)");
	// the arena's own trouble (unreachable, busy, gone) throws ArenaDown: the judge gives the candidate back
	const arena = await arenaClient(address);
	let world: string | null = null;
	try {
		try { world = String((await arena.ask("open")).world); } catch (e) { throw e instanceof ArenaDown ? e : new ArenaDown(`the arena could not open a world: ${(e as Error).message}`); }
		const meter: Meter = newMeter();
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: limit, tools: botTools(arena, world, meter), memoryLimitBytes: 64 * 1024 * 1024 });
		let error: string | null = null, ms = limit;
		try {
			const r = await sandbox.execute(toolProgram(CAPTURED, task.fn, source));
			const v = (r.ok ? r.value ?? {} : {}) as { ms?: unknown; error?: unknown };
			if (!r.ok) error = r.error?.message ?? "failed";
			else if (typeof v.error === "string") error = v.error;
			else if (typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0) ms = v.ms;
		} catch (e) { error = (e as Error).message; } finally { await sandbox.close().catch(() => {}); }
		if (arena.broken()) throw new ArenaDown("the arena went away while the bot played");
		const s = await arena.ask("score", { world, goal: task.bot.goal });
		const done = s.done === true, calls = `calls: ${meterText(meter)}`;
		if (error) return fail(`${error} (${calls})`, meter);
		if (!done) return fail(`goal not reached: ${String(s.detail ?? "")} (${calls})`, meter);
		return { ok: true, ms: Math.round(ms * 100) / 100, passed: 1, total: 1, cases: [{ call, ok: true, got: `reached (${calls})`, expect: goal }], cost: meter.cost, calls: { ...meter.calls } as Record<string, number>, score: 1 };
	} catch (e) {
		if (e instanceof ArenaDown) throw e;
		return fail((e as Error).message);
	} finally {
		if (world && !arena.broken()) await arena.ask("close", { world }).catch(() => {});
		arena.close();
	}
}

/** A planning task (docs/codemode-planung.en.md): every episode in a world of its own per seed, the sample episodes
 *  first; the hidden ones run only when a sample episode was reached. An episode counts when every seed reached it and
 *  the goal held. The verdict is correct when every episode counts; `score` is the share of hidden episodes that count,
 *  `passed` the episodes that count, the points and time are those of all runs. Of a hidden episode it says only
 *  reached or not: no detail, no error text. */
async function judgeEpisodes(cm: Codemode, task: Task & { bot: BotSpec }, source: string): Promise<Verdict> {
	const b = task.bot, eps = b.episodes!, limit = limitOf(task), seeds = seedsOf(b), names = botToolNames(b);
	const address = arenaAddress();
	if (!address) return { ok: false, ms: limit, error: "this judge has no arena (CODEMODE_ARENA)", passed: 0, total: eps.length, cases: [] };
	const arena = await arenaClient(address);
	const total: Meter = newMeter();
	let msAll = 0;
	try {
		const results: EpisodeResult[] = [], cases: CaseResult[] = [];
		let sampleReached = false, firstError: string | null = null;
		for (const kind of ["sample", "holdout"] as const) {
			for (const [i, e] of eps.entries()) {
				if (e.kind !== kind) continue;
				if (kind === "holdout" && !sampleReached) { results.push({ id: e.id, kind, reached: [], cost: 0, skipped: true }); cases.push({ call: `hidden episode ${e.id}`, ok: false, error: "not run: no sample episode was reached" }); continue; }
				const runs: Array<{ reached: boolean; detail: string; cost: number; path?: { path: PathStep[]; cut: boolean } }> = [];
				for (let s = 0; s < seeds; s++) {
					const r = await playEpisode(cm, arena, task, source, e, seeds > 1 ? episodeSeed(i, s) : undefined, names, kind === "sample" && s === 0);
					runs.push(r); msAll += r.ms;
					total.cost += r.meter.cost; total.total += r.meter.total;
					for (const [k, n] of Object.entries(r.meter.calls)) total.calls[k] = (total.calls[k] ?? 0) + (n ?? 0);
				}
				const reached = runs.map((r) => r.reached), all = reached.every(Boolean), cost = runs.reduce((a, r) => a + r.cost, 0);
				if (kind === "sample" && reached.some(Boolean)) sampleReached = true;
				const seedText = seeds > 1 ? ` (${reached.filter(Boolean).length} of ${seeds} seeds)` : "";
				if (kind === "sample") {
					const detail = plain(runs.find((r) => !r.reached)?.detail ?? runs[0]!.detail);
					const way = runs[0]!.path;
					results.push({ id: e.id, kind, reached, cost, detail, ...(way?.path.length ? { path: way.path, ...(way.cut ? { cut: true as const } : {}) } : {}) });
					cases.push({ call: `${e.id}: ${e.text.en}`, ok: all, ...(all ? { got: `reached${seedText}, ${cost} points` } : { error: `${detail}${seedText}` }), expect: b.goalText.en });
					if (!all && firstError === null) firstError = `${e.id}: ${detail}`;
				} else {
					results.push({ id: e.id, kind, reached, cost });
					cases.push({ call: `hidden episode ${e.id}`, ok: all, ...(all ? { got: `reached${seedText}` } : { error: `not reached${seedText}` }) });
				}
			}
		}
		const counted = results.filter((r) => !r.skipped && r.reached.length && r.reached.every(Boolean));
		const hidden = results.filter((r) => r.kind === "holdout"), score = hidden.length ? hidden.filter((r) => counted.includes(r)).length / hidden.length : counted.length === results.length ? 1 : 0;
		const ok = counted.length === results.length;
		const calls = `calls: ${meterText(total)}`;
		const error = ok ? undefined : plain(firstError ? `${firstError} (${calls})` : `${hidden.length - hidden.filter((r) => counted.includes(r)).length} of ${hidden.length} hidden episodes not reached (${calls})`);
		const rooms = await roomMaps(arena, new Set([...results.flatMap((r) => (r.path ?? []).map((p) => p[0])), ...eps.filter((e) => e.kind === "sample" && e.start).map((e) => e.start!.room)]));
		return { ok, ms: ok ? Math.round(msAll * 100) / 100 : limit, ...(error ? { error } : {}), passed: counted.length, total: results.length, cases, cost: total.cost, calls: { ...total.calls } as Record<string, number>, score: Math.round(score * 1000) / 1000, episodes: results, ...(rooms.length ? { rooms } : {}) };
	} catch (e) {
		if (e instanceof ArenaDown) throw e;
		return { ok: false, ms: limit, error: plain((e as Error).message), passed: 0, total: eps.length, cases: [] };
	} finally { arena.close(); }
}

/** One run of an episode: a world opened with its start, setup and seed, the bot in a fresh sandbox, the goal asked
 *  (held for the task's `hold`), the world closed. The arena's own trouble throws ArenaDown. */
async function playEpisode(cm: Codemode, arena: Arena, task: Task & { bot: BotSpec }, source: string, e: BotEpisode, seed: number | undefined, names: BotTool[], withPath = false): Promise<{ reached: boolean; detail: string; cost: number; ms: number; meter: Meter; path?: { path: PathStep[]; cut: boolean } }> {
	const limit = limitOf(task), meter: Meter = newMeter();
	let world: string | null = null;
	try {
		try { world = String((await arena.ask("open", { ...(e.start ? { start: e.start } : {}), ...(e.setup ? { setup: e.setup } : {}), ...(seed !== undefined ? { seed } : {}) })).world); }
		catch (err) { throw err instanceof ArenaDown ? err : new ArenaDown(`the arena could not open a world: ${(err as Error).message}`); }
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: limit, tools: botTools(arena, world, meter, names), memoryLimitBytes: 64 * 1024 * 1024 });
		let error: string | null = null, ms = limit;
		try {
			const r = await sandbox.execute(toolProgram(CAPTURED, task.fn, source));
			const v = (r.ok ? r.value ?? {} : {}) as { ms?: unknown; error?: unknown };
			if (!r.ok) error = r.error?.message ?? "failed";
			else if (typeof v.error === "string") error = v.error;
			else if (typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0) ms = v.ms;
		} catch (err) { error = (err as Error).message; } finally { await sandbox.close().catch(() => {}); }
		if (arena.broken()) throw new ArenaDown("the arena went away while the bot played");
		// the way it went, before the judge's own wait (a sample episode's first seed; a hidden one keeps none)
		const path = withPath ? pathFrom(await arena.ask("path", { world }).catch(() => null)) : undefined;
		const way = path ? { path } : {};
		if (error) return { reached: false, detail: error, cost: meter.cost, ms: limit, meter, ...way };
		const s = await arena.ask("score", { world, goal: task.bot.goal, ...(task.bot.hold ? { hold: task.bot.hold } : {}) });
		return s.done === true ? { reached: true, detail: String(s.detail ?? ""), cost: meter.cost, ms, meter, ...way } : { reached: false, detail: `goal not reached: ${String(s.detail ?? "")}`, cost: meter.cost, ms: limit, meter, ...way };
	} finally {
		if (world && !arena.broken()) await arena.ask("close", { world }).catch(() => {});
	}
}

/** The arena's `path` answer, checked: at most PATH_MAX steps of [room, x, y]. */
const PATH_MAX = 200;
function pathFrom(a: Record<string, unknown> | null): { path: PathStep[]; cut: boolean } | undefined {
	if (!a || a.ok === false || !Array.isArray(a.path)) return undefined;
	const path = a.path.filter((s): s is PathStep => Array.isArray(s) && s.length === 3 && typeof s[0] === "string" && s[0].length <= 80 && Number.isInteger(s[1]) && Number.isInteger(s[2])).slice(0, PATH_MAX).map((s) => [s[0], s[1], s[2]] as PathStep);
	return { path, cut: a.cut === true };
}

/** Rooms' geometry from the arena (`map`), remembered by this judge for ROOM_CACHE_MS. A room the arena does not know
 *  is left out. */
const ROOM_CACHE_MS = 10 * 60_000, roomCache = new Map<string, { at: number; map: RoomMap }>();
async function roomMaps(arena: Arena, rooms: Set<string>): Promise<RoomMap[]> {
	const out: RoomMap[] = [];
	for (const room of [...rooms].sort().slice(0, 30)) {
		const had = roomCache.get(room);
		if (had && Date.now() - had.at < ROOM_CACHE_MS) { out.push(had.map); continue; }
		const m = await arena.ask("map", { room }).catch(() => null);
		if (!m || m.ok === false || !Array.isArray(m.ground)) continue;
		const { id: _id, ok: _ok, ...map } = m as Record<string, unknown>;
		roomCache.set(room, { at: Date.now(), map: map as RoomMap });
		out.push(map as RoomMap);
	}
	return out;
}

/** The BotEpisode entries of a verdict: one per sample episode that has a path (judge-host.ts writes them with the
 *  verdict). */
export const episodeEntries = (v: Verdict) => (v.episodes ?? []).filter((e) => e.kind === "sample" && e.path?.length).map((e) => ({ episode: e.id, kind: e.kind, reached: e.reached, cost: e.cost, path: e.path!, ...(e.cut ? { cut: true } : {}) }));

/** What a judge hands along for a durable task: the candidate's call log in the space (judge-host.ts). Without it a
 *  durable task keeps its log in memory (it then survives nothing, but runs the same way). */
export type JudgeContext = { log?: CallLog; /** the judge's transaction lease: a dead judge's candidate is back within it, and its world must wait that long */ leaseMs?: number };

/** An in-memory call log. */
export function memoryLog(): CallLog {
	let head: RunHead | null = null, calls: LoggedCall[] = [];
	return { head: async () => head, calls: async () => [...calls], begin: async (h) => { head = h; }, append: async (c) => { calls.push(c); }, clear: async () => { head = null; calls = []; } };
}

/** A durable bot task (durable-run.ts): the world is opened to outlive this judge (`keep`), every answer is logged
 *  before the bot gets it, and a judge that finds a log replays it and goes on in the same world. A world that is gone
 *  (the arena restarted) or a run that does not match its log starts afresh, once. */
async function judgeDurableBot(cm: Codemode, task: Task & { bot: BotSpec }, source: string, given: CallLog, leaseMs?: number): Promise<Verdict> {
	// the space's trouble with the log is no verdict: the candidate goes back (judge-host.ts)
	const down = (e: unknown) => new LogDown(`the run's log: ${(e as Error).message}`);
	const log: CallLog = { head: () => given.head().catch((e) => { throw down(e); }), calls: () => given.calls().catch((e) => { throw down(e); }), begin: (h) => given.begin(h), append: (c) => given.append(c), clear: () => given.clear().catch((e) => { throw down(e); }) };
	const limit = limitOf(task), goal = task.bot.goalText.en, call = `${task.fn}() in a world of its own`;
	const fail = (error: string, meter?: Meter): Verdict => ({ ok: false, ms: limit, error: plain(error), passed: 0, total: 1, cases: [{ call, ok: false, error: plain(error), expect: goal }], ...(meter ? { cost: meter.cost, calls: { ...meter.calls } as Record<string, number>, score: 0 } : {}) });
	const address = arenaAddress();
	if (!address) return fail("this judge has no arena (CODEMODE_ARENA)");
	const arena = await arenaClient(address);
	try {
		for (let attempt = 0; ; attempt++) {
			let head = await log.head(), logged = head ? await log.calls() : [];
			// a world left by a judge before: still there?
			if (head) {
				try { await arena.ask("look", { world: head.world }); }
				catch (e) { if (e instanceof ArenaDown) throw e; await log.clear(); head = null; logged = []; }
			}
			let world = head?.world;
			if (!world) {
				// the world waits for the judge that takes over: as long as a dead judge's candidate takes to come back
				try { world = String((await arena.ask("open", { keep: true, ...(leaseMs ? { idleMs: leaseMs + 60_000 } : {}) })).world); }
				catch (e) { throw e instanceof ArenaDown ? e : new ArenaDown(`the arena could not open a world: ${(e as Error).message}`); }
			}
			const meter: Meter = newMeter();
			const seen = (name: string) => { meter.total++; meter.calls[name] = (meter.calls[name] ?? 0) + 1; meter.cost += BOT_COST[name as BotTool] ?? 1; };
			try {
				const r = await runDurable(cm, {
					code: toolProgram(CAPTURED, task.fn, source), limitMs: limit, log, head, logged, world, seen,
					tools: (["look", "act", "wait"] as const).map((name) => ({ name })),
					call: async (name, args, key) => {
						if (meter.total > MAX_BOT_CALLS) return { ok: false, message: `more than ${MAX_BOT_CALLS} tool calls` };
						if (!["look", "act", "wait"].includes(name)) return { ok: false, message: `no tool ${name}` };
						try { return { ok: true, value: await botCall(arena, world!, name as BotTool, botArg(args), key) }; }
						catch (e) { if (e instanceof ArenaDown) throw e; return { ok: false, message: plain((e as Error).message) }; }
					},
				});
				if (arena.broken()) throw new ArenaDown("the arena went away while the bot played");
				const v = (r.ok ? r.value ?? {} : {}) as { ms?: unknown; error?: unknown };
				const error = !r.ok ? r.error ?? "failed" : typeof v.error === "string" ? v.error : null;
				const ms = typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? v.ms : limit;
				const s = await arena.ask("score", { world, goal: task.bot.goal });
				await arena.ask("close", { world }).catch(() => {});
				const calls = `calls: ${meterText(meter)}${r.replayed ? `, ${r.replayed} of them replayed from the log` : ""}`;
				if (error) return fail(`${error} (${calls})`, meter);
				if (s.done !== true) return fail(`goal not reached: ${String(s.detail ?? "")} (${calls})`, meter);
				return { ok: true, ms: Math.round(ms * 100) / 100, passed: 1, total: 1, cases: [{ call, ok: true, got: `reached (${calls})`, expect: goal }], cost: meter.cost, calls: { ...meter.calls } as Record<string, number>, score: 1 };
			} catch (e) {
				if (!(e instanceof Diverged)) throw e;
				// another script, VM or order than the log: start afresh in a new world, once
				await arena.ask("close", { world }).catch(() => {});
				await log.clear();
				if (attempt >= 1) return fail(`the run does not match its log: ${e.message}`);
			}
		}
	} catch (e) {
		if (e instanceof ArenaDown || e instanceof LogDown) throw e;
		return fail((e as Error).message);
	} finally { arena.close(); }
}

export async function judgeInSlot(cm: Codemode, task: Task, source: string, ctx: JudgeContext = {}): Promise<Verdict> {
	if (task.kind === "bot" && task.bot && task.durable) return source.length > MAX_SOURCE_CHARS ? { ok: false, ms: limitOf(task), error: "source too long", passed: 0, total: 1, cases: [] } : judgeDurableBot(cm, task as Task & { bot: BotSpec }, source, ctx.log ?? memoryLog(), ctx.leaseMs);
	if (task.kind === "bot" && task.bot) return source.length > MAX_SOURCE_CHARS ? { ok: false, ms: limitOf(task), error: "source too long", passed: 0, total: 1, cases: [] } : judgeBot(cm, task as Task & { bot: BotSpec }, source);
	if (task.kind === "harness" && task.harness) return source.length > MAX_SOURCE_CHARS ? { ok: false, ms: limitOf(task), error: "source too long", passed: 0, total: 1, cases: [] } : judgeHarness(cm, task as Task & { harness: HarnessSpec }, source);
	if (task.kind === "tools" && task.tools) return source.length > MAX_SOURCE_CHARS ? { ok: false, ms: limitOf(task), error: "source too long", passed: 0, total: 2, cases: [] } : judgeTools(cm, task as Task & { tools: ToolSpec }, source);
	const total = task.cases.length;
	const limit = limitOf(task);
	const fail = (error: string, cases: CaseResult[] = [], passed = 0): Verdict => ({ ok: false, ms: limit, error: plain(error), passed, total, cases });
	if (source.length > MAX_SOURCE_CHARS) return fail("source too long");
	const run = async (program: string) => {
		const sandbox = new cm.CodemodeSandbox({ timeoutMs: limit, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
		try { return await sandbox.execute(program); } finally { await sandbox.close().catch(() => {}); }
	};
	try {
		const r = await run(judgeProgram(task, source, Math.floor(Math.random() * 300)));
		if (!r.ok) return fail(r.error?.message ?? "failed");
		const v = (r.value ?? {}) as { phase?: unknown; cases?: unknown; error?: unknown; ms?: unknown; outs?: unknown; picked?: unknown };
		const cases = cleanCases(v.cases);
		if (task.check !== undefined) {
			// the rule decides, outside the contribution's sandbox; cases that threw stay failed
			const outs = Array.isArray(v.outs) ? v.outs : [], picked = Array.isArray(v.picked) ? v.picked : [];
			const sets = v.phase === "done" ? [outs, picked] : [outs];
			const c = await run(checkProgram(task.check, task.cases.map((x) => x.args), sets));
			if (!c.ok) return fail(`check rule failed: ${c.error?.message ?? "error"}`, cases);
			const [onCases, onBench] = c.value as Array<Array<true | false | string>>;
			cases.forEach((x, i) => { if (x.error) return; const res = onCases?.[i]; x.ok = res === true; if (typeof res === "string") x.error = plain(res); });
			const passed = cases.filter((x) => x.ok).length;
			if (v.phase !== "done") return fail(typeof v.error === "string" ? v.error : firstWrong(cases) ?? "failed", cases, passed);
			if (passed < total) return fail(firstWrong(cases) ?? "failed", cases, passed);
			if (!onBench || onBench.length < total || onBench.some((x) => x !== true)) return fail("wrong on repeated calls", cases, passed);
		} else {
			const passed = cases.filter((x) => x.ok).length;
			if (v.phase !== "done") return fail(typeof v.error === "string" ? v.error : firstWrong(cases) ?? "failed", cases, passed);
		}
		if (typeof v.ms !== "number" || !Number.isFinite(v.ms) || v.ms < 0) return fail("invalid timing", cases, total);
		const literal = hardcodedLiteral(task, source);
		if (literal) return { ...fail(`hard-coded: the code returns the expected result ${literal} as a literal instead of computing it`, cases, total), hardcoded: true };
		return { ok: true, ms: Math.round(v.ms * 100) / 100, passed: total, total, cases };
	} catch (e) {
		return fail((e as Error).message);
	}
}

/** The score fields of a verdict, as hub and shard write them: the case results failing ones first, at most 10. */
export const verdictFields = (v: Verdict) => ({ ok: v.ok, ms: v.ms, passed: v.passed, total: v.total, cases: [...v.cases.filter((c) => !c.ok), ...v.cases.filter((c) => c.ok)].slice(0, 10), ...(v.error ? { error: v.error } : {}), ...(v.hardcoded ? { hardcoded: true } : {}), ...(v.cost !== undefined ? { cost: v.cost, calls: v.calls ?? {}, score: v.score ?? 0 } : {}), ...(v.episodes ? { episodes: v.episodes.map(({ path: _p, cut: _c, ...e }) => e) } : {}) });

export const judge = (cm: Codemode, task: Task, source: string, ctx: JudgeContext = {}): Promise<Verdict> => sandboxSlot(() => judgeInSlot(cm, task, source, ctx));
