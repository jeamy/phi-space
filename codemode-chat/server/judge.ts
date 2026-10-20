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

/** One case as the judge saw it: the call, whether it passed, what came out (or the error), what was expected. */
export type CaseResult = { call: string; ok: boolean; got?: string; expect?: string; error?: string };
/** `hardcoded`: the code passed, but only by returning an expected result written into it (not computed). */
export type Verdict = { ok: boolean; ms: number; error?: string; passed: number; total: number; cases: CaseResult[]; hardcoded?: true };
type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
export type Codemode = { CodemodeSandbox: new (o: { timeoutMs: number; tools: []; memoryLimitBytes?: number }) => Sandbox };

/** The default time a contribution has for all its cases and the bench; a custom task may set its own (timeoutMs). */
export const TIMEOUT_MS = 5000;
/** The most a custom task may allow per contribution: CODEMODE_MAX_TIMEOUT_S, default 60 s. */
export const maxTimeoutMs = (): number => { const s = Number(process.env.CODEMODE_MAX_TIMEOUT_S ?? 60); return Number.isFinite(s) && s >= 1 ? Math.round(s * 1000) : 60_000; };
/** The time limit of a task's contributions. */
export const limitOf = (task: Task): number => task.timeoutMs ?? TIMEOUT_MS;
export const MAX_SOURCE_CHARS = 16_000;
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

/** Judges one contribution; the caller already holds a sandbox slot. */
export async function judgeInSlot(cm: Codemode, task: Task, source: string): Promise<Verdict> {
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
export const verdictFields = (v: Verdict) => ({ ok: v.ok, ms: v.ms, passed: v.passed, total: v.total, cases: [...v.cases.filter((c) => !c.ok), ...v.cases.filter((c) => c.ok)].slice(0, 10), ...(v.error ? { error: v.error } : {}), ...(v.hardcoded ? { hardcoded: true } : {}) });

export const judge = (cm: Codemode, task: Task, source: string): Promise<Verdict> => sandboxSlot(() => judgeInSlot(cm, task, source));
