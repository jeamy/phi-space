// The judge: runs one contribution in a QuickJS sandbox that can reach no tool, checks it against the task's cases and
// times the bench. Whatever the source is (agent, model or human), it is data and only ever runs here.
//
// The contribution never becomes part of the judging program's text: it is a string literal that an indirect eval runs
// as a script of its own (a top-level `return` is a syntax error there, and it cannot see the judge's locals). The
// builtins the judge relies on are captured before it runs, and the bench input is built before it, so a contribution
// that patches globals (JSON.stringify, toJSON, iterators, Date) only fools itself. The bench's results are checked as
// well as the cases (outside the timed part): code that is only right on the small cases does not win.
import { pathToFileURL } from "node:url";
import type { Task } from "./tasks.ts";

export type Verdict = { ok: boolean; ms: number; error?: string };
type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
export type Codemode = { CodemodeSandbox: new (o: { timeoutMs: number; tools: []; memoryLimitBytes?: number }) => Sandbox };

export const TIMEOUT_MS = 5000;
export const MAX_SOURCE_CHARS = 16_000;
const MAX_PARALLEL = 2;

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

/** The judging program: captured builtins, cases and bench input first, then the contribution, then check and bench. */
export function judgeProgram(task: Task, source: string): string {
	const script = `${source}\n;typeof ${task.fn} === "function" ? ${task.fn} : undefined`;
	return `const __eval = eval, __now = Date.now, __str = JSON.stringify, __isArray = Array.isArray, __keys = Object.keys, __hasOwn = Object.hasOwn, __apply = Reflect.apply;
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
const __cases = ${JSON.stringify(task.cases)};
const __in = ${task.benchInput ?? "undefined"};
const __expect = ${task.benchExpect === undefined ? "undefined" : JSON.stringify(task.benchExpect)};
const __fn = __eval(${JSON.stringify(script)});
if (typeof __fn !== "function") return { ok: false, error: "no function ${task.fn}" };
for (let __i = 0; __i < __cases.length; __i++) {
	const __c = __cases[__i];
	if (!__eq(__apply(__fn, undefined, __c.args), __c.expect)) return { ok: false, error: "wrong on " + __str(__c.args).slice(0, 80) };
}
const ${task.fn} = __fn;
let __out;
const __t = __now();
{
${task.bench}
}
const __ms = __now() - __t;
if (__expect !== undefined && !__eq(__out, __expect)) return { ok: false, error: "wrong on the bench input" };
return { ok: true, ms: __ms };`;
}

/** An error text as the page shows it: no control characters (each would cost six bytes of JSON), at most 200 chars. */
export const plain = (s: string): string => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);

/** Judges one contribution; the caller already holds a sandbox slot. */
export async function judgeInSlot(cm: Codemode, task: Task, source: string): Promise<Verdict> {
	if (source.length > MAX_SOURCE_CHARS) return { ok: false, ms: TIMEOUT_MS, error: "source too long" };
	const sandbox = new cm.CodemodeSandbox({ timeoutMs: TIMEOUT_MS, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
	try {
		const r = await sandbox.execute(judgeProgram(task, source));
		if (!r.ok) return { ok: false, ms: TIMEOUT_MS, error: plain(r.error?.message ?? "failed") };
		const v = r.value as { ok?: unknown; ms?: unknown; error?: unknown } | null;
		if (v?.ok === true) return typeof v.ms === "number" && Number.isFinite(v.ms) && v.ms >= 0 ? { ok: true, ms: v.ms } : { ok: false, ms: TIMEOUT_MS, error: "invalid timing" };
		return { ok: false, ms: TIMEOUT_MS, error: typeof v?.error === "string" ? plain(v.error) : "no verdict" };
	} catch (e) {
		return { ok: false, ms: TIMEOUT_MS, error: plain((e as Error).message) };
	} finally {
		await sandbox.close().catch(() => {});
	}
}

export const judge = (cm: Codemode, task: Task, source: string): Promise<Verdict> => sandboxSlot(() => judgeInSlot(cm, task, source));
