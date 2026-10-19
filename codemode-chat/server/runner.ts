// Run a contribution on request (the ▶ in the chat): the same QuickJS sandbox as the judge, but nothing is scored. The
// function runs against the task's cases and, optionally, one call the person typed; every case result, console line
// and the call's value stream out as they happen (a host global the sandbox calls, so a busy loop still reports live).
// Stop is an abort signal. Bounded: 60 s, two runs per process, at most 1000 lines / 256 KiB of output.
import type { Codemode } from "./judge.ts";
import type { Task } from "./tasks.ts";

export const EXEC_TIMEOUT_MS = 60_000;
export const MAX_CALL_CHARS = 500;
const EXEC_PARALLEL = 2;
const MAX_LINES = 1000;
const MAX_OUTPUT_BYTES = 256 * 1024;

/** One line of a run, as streamed to the page (NDJSON). */
export type ExecEvent =
	| { t: "start"; fn: string; cases: number }
	| { t: "case"; call: string; ok: boolean; got?: string; error?: string; expect: string }
	| { t: "log"; level: "log" | "info" | "warn" | "error" | "debug"; text: string }
	| { t: "value"; call: string; text: string }
	| { t: "error"; text: string }
	| { t: "end"; status: "ok" | "timeout" | "aborted" | "limit" | "error"; ms: number };

type RunSandbox = { execute(code: string, o?: { signal?: AbortSignal; timeoutMs?: number }): Promise<{ ok: boolean; error?: { kind?: string; message: string }; output?: Array<{ type: string; text?: string }> }>; close(): Promise<void> };
type RunCodemode = { CodemodeSandbox: new (o: { timeoutMs: number; tools: []; memoryLimitBytes?: number; globals?: Array<{ name: string; execute: (args: unknown) => unknown }> }) => RunSandbox };

/** What the sandbox hands `__out`, reduced to a well-formed event (the contribution can call `__out` itself). */
function clean(e: unknown): ExecEvent | null {
	if (!e || typeof e !== "object") return null;
	const x = e as Record<string, unknown>, str = (v: unknown) => (typeof v === "string" ? v.slice(0, 4000) : String(v ?? "").slice(0, 4000));
	if (x.t === "case") return { t: "case", call: str(x.call), ok: x.ok === true, ...(x.error !== undefined ? { error: str(x.error) } : { got: str(x.got) }), expect: str(x.expect) };
	if (x.t === "log") return { t: "log", level: (["log", "info", "warn", "error", "debug"] as const).find((l) => l === x.level) ?? "log", text: str(x.text) };
	if (x.t === "value") return { t: "value", call: str(x.call), text: str(x.text) };
	if (x.t === "error") return { t: "error", text: str(x.text) };
	return null;
}

let running = 0;
/** Runs in flight in this process (shown to tests and the busy check). */
export const execRunning = () => running;

/** The run program: the judge's captured helpers, then the contribution as its own script. The sandbox's console is
 *  frozen, so the script gets a streaming `console` as a parameter of the function it is wrapped in. */
export function execProgram(task: Task, source: string, call: string): string {
	const script = `(function (console) {\n${source}\n;return typeof ${task.fn} === "function" ? ${task.fn} : undefined;\n})`;
	const callFn = `(function (${task.fn}, console) { return (${call}\n); })`;
	return `const __eval = eval, __str = JSON.stringify, __isArray = Array.isArray, __keys = Object.keys, __hasOwn = Object.hasOwn, __apply = Reflect.apply, __String = String;
const __emit = __out;
const __show = (v) => {
	try {
		if (typeof v === "string") return v.length > 2000 ? v.slice(0, 2000) + "…" : v;
		if (typeof v === "function") return "[function " + (v.name || "anonymous") + "]";
		if (typeof v === "bigint") return __String(v) + "n";
		const s = __str(v);
		return s === undefined ? __String(v) : s.length > 2000 ? s.slice(0, 2000) + "…" : s;
	} catch { return __String(v); }
};
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
const __msg = (e) => __String(e && e.message !== undefined ? e.message : e);
const __console = {};
for (const level of ["log", "info", "warn", "error", "debug"]) __console[level] = (...a) => { __emit({ t: "log", level, text: a.map(__show).join(" ") }); };
const __cases = ${JSON.stringify(task.cases)};
let __fn;
try { __fn = __eval(${JSON.stringify(script)})(__console); } catch (e) { __emit({ t: "error", text: __msg(e) }); return; }
if (typeof __fn !== "function") { __emit({ t: "error", text: "no function ${task.fn}" }); return; }
for (let __i = 0; __i < __cases.length; __i++) {
	const __c = __cases[__i], call = "${task.fn}(" + __c.args.map(__show).join(", ") + ")";
	try {
		let got = __apply(__fn, undefined, __c.args);
		if (got && typeof got.then === "function") got = await got;
		__emit({ t: "case", call, ok: __eq(got, __c.expect), got: __show(got), expect: __show(__c.expect) });
	} catch (e) { __emit({ t: "case", call, ok: false, error: __msg(e), expect: __show(__c.expect) }); }
}
${call ? `try {
	let v = __eval(${JSON.stringify(callFn)})(__fn, __console);
	if (v && typeof v.then === "function") v = await v;
	__emit({ t: "value", call: ${JSON.stringify(call)}, text: __show(v) });
} catch (e) { __emit({ t: "error", text: __msg(e) }); }` : ""}`;
}

/** Runs `source` (a contribution of `task`) and streams its events; resolves with the closing `end` event. */
export async function execute(cm: Codemode, task: Task, source: string, call: string, emit: (e: ExecEvent) => void, signal: AbortSignal): Promise<Extract<ExecEvent, { t: "end" }>> {
	if (running >= EXEC_PARALLEL) throw new Error("All runners are busy; try again in a moment");
	if (call.length > MAX_CALL_CHARS) throw new Error(`A call has at most ${MAX_CALL_CHARS} characters`);
	running++;
	const started = Date.now(), stop = new AbortController();
	let lines = 0, bytes = 0, limited = false;
	const onAbort = () => stop.abort();
	signal.addEventListener("abort", onAbort);
	const sandbox = new (cm as unknown as RunCodemode).CodemodeSandbox({
		timeoutMs: EXEC_TIMEOUT_MS, tools: [], memoryLimitBytes: 64 * 1024 * 1024,
		globals: [{ name: "__out", execute: (raw) => {
			const e = clean(raw);
			if (!e || limited || stop.signal.aborted) return null;
			const n = Buffer.byteLength(JSON.stringify(e));
			if (++lines > MAX_LINES || (bytes += n) > MAX_OUTPUT_BYTES) { limited = true; stop.abort(); return null; }
			emit(e);
			return null;
		} }],
	});
	try {
		emit({ t: "start", fn: task.fn, cases: task.cases.length });
		const r = await sandbox.execute(execProgram(task, source, call), { signal: stop.signal, timeoutMs: EXEC_TIMEOUT_MS });
		const ms = Date.now() - started;
		// what still went to the sandbox's own console (globalThis.console) comes after the run, within the same limits
		for (const o of r.output ?? []) {
			if (limited || o.type !== "text") continue;
			const e: ExecEvent = { t: "log", level: "log", text: String(o.text ?? "").slice(0, 4000) };
			if (++lines > MAX_LINES || (bytes += Buffer.byteLength(JSON.stringify(e))) > MAX_OUTPUT_BYTES) limited = true; else emit(e);
		}
		if (limited) return { t: "end", status: "limit", ms };
		if (r.ok) return { t: "end", status: "ok", ms };
		if (signal.aborted || r.error?.kind === "aborted") return { t: "end", status: "aborted", ms };
		if (r.error?.kind === "timeout") return { t: "end", status: "timeout", ms };
		emit({ t: "error", text: (r.error?.message ?? "failed").slice(0, 2000) });
		return { t: "end", status: "error", ms };
	} finally {
		signal.removeEventListener("abort", onAbort);
		running--;
		await sandbox.close().catch(() => {});
	}
}
