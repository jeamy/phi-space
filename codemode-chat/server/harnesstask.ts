// Harness tasks (docs/codemode-anwendungen.en.md, C): the contribution is not a solution but a judging script,
// `async function rate()`, that rates one implementation of a stated goal with a number. It never sees the
// implementation's code: its one tool, `tools.run({ args })`, calls the implementation under test in a fresh sandbox of
// its own and returns what came out and how long it took. The judge calls rate() once per implementation the task
// brings: good ones (the reference among them) and bad ones (wrong, hard-coded, slow), some of each hidden like the
// holdout of a tools task. A harness counts only when every good implementation scores strictly higher than every bad
// one. The implementations are fixed by the task, before any harness is written, so a team never grades its own work.
import type { Meter } from "./tooltask.ts";

export type Impl = { label: string; source: string };
export type HarnessSpec = {
	/** The function every implementation defines, e.g. "sortNumbers". */
	target: string;
	/** Shown in the prompt and judged first; good[0] is the reference (▶ runs against it). */
	good: Impl[];
	bad: Impl[];
	/** Judged only after the shown ones pass; never in a prompt, never on the page beyond their label and score. */
	hiddenGood: Impl[];
	hiddenBad: Impl[];
	/** The time one run may take; beyond it `run` answers `{ error }`. */
	runMs: number;
};

export const RUN_COST = 1;
/** The most runs rate() may make for one implementation; beyond it the call throws. */
export const MAX_RUNS = 40;
/** The most the arguments of one run may take as JSON. */
export const MAX_ARGS_BYTES = 1_000_000;

type CodemodeTool = { name: string; description?: string; execute(args: unknown): unknown };
type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
export type SandboxMaker = (o: { timeoutMs: number; tools: CodemodeTool[]; memoryLimitBytes?: number }) => Sandbox;

/** The program of one run: the implementation (trusted, from the task) on the given arguments, timed inside. */
export function runProgram(captured: string, target: string, source: string, args: unknown[]): string {
	const script = `${source}\n;typeof ${target} === "function" ? ${target} : undefined`;
	return `${captured}
const __args = ${JSON.stringify(args)};
const __fn = __eval(${JSON.stringify(script)});
if (typeof __fn !== "function") return { error: "the implementation defines no ${target}" };
const __t = __now();
let __v;
try { __v = __apply(__fn, undefined, __args); if (__v && typeof __v.then === "function") __v = await __v; }
catch (e) { return { error: __msg(e) }; }
return { ms: __now() - __t, value: __v };`;
}

const DESCRIPTION = {
	de: (s: HarnessSpec) => `- tools.run(args): ruft die Implementierung, die gerade bewertet wird, in einer eigenen Sandbox auf: { args: unknown[] } (die Argumente von ${s.target}) → { value, ms } (was herauskam und wie viele Millisekunden der Aufruf dauerte) oder { error } (sie warf, oder brauchte länger als ${s.runMs / 1000} s). 1 Punkt; höchstens ${MAX_RUNS} Aufrufe pro Implementierung.`,
	en: (s: HarnessSpec) => `- tools.run(args): calls the implementation being rated, in a sandbox of its own: { args: unknown[] } (the arguments of ${s.target}) → { value, ms } (what came out and how many milliseconds the call took) or { error } (it threw, or took longer than ${s.runMs / 1000} s). 1 point; at most ${MAX_RUNS} calls per implementation.`,
};
export const describeHarnessTools = (s: HarnessSpec, lang: "de" | "en"): string => DESCRIPTION[lang](s);

/** The tool of one rate() call: `run` bound to one implementation, every call counted on `m`. */
export function harnessTools(make: SandboxMaker, captured: string, s: HarnessSpec, impl: Impl, m: Meter): CodemodeTool[] {
	return [{
		name: "run", description: DESCRIPTION.en(s),
		execute: async (raw: unknown) => {
			if (m.total >= MAX_RUNS) throw new Error(`more than ${MAX_RUNS} runs`);
			const a = raw && typeof raw === "object" ? (raw as Record<string, unknown>).args : undefined;
			if (!Array.isArray(a)) throw new Error("run needs { args: [...] }");
			const json = JSON.stringify(a) ?? "[]";
			if (Buffer.byteLength(json) > MAX_ARGS_BYTES) throw new Error(`run takes at most ${MAX_ARGS_BYTES} bytes of arguments`);
			m.total++; m.calls.run = (m.calls.run ?? 0) + 1; m.cost += RUN_COST;
			const sandbox = make({ timeoutMs: s.runMs, tools: [], memoryLimitBytes: 64 * 1024 * 1024 });
			try {
				const r = await sandbox.execute(runProgram(captured, s.target, impl.source, JSON.parse(json)));
				if (!r.ok) return { error: /timed out/i.test(r.error?.message ?? "") ? `took longer than ${s.runMs / 1000} s` : String(r.error?.message ?? "failed").slice(0, 200) };
				const v = (r.value ?? {}) as { ms?: unknown; value?: unknown; error?: unknown };
				if (typeof v.error === "string") return { error: v.error.slice(0, 200) };
				return { value: v.value ?? null, ms: typeof v.ms === "number" && Number.isFinite(v.ms) ? v.ms : s.runMs };
			} finally { await sandbox.close().catch(() => {}); }
		},
	}];
}
