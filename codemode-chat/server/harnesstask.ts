// Harness tasks (docs/codemode-anwendungen.en.md, C): the contribution is not a solution but a judging script,
// `async function rate()`, that rates one implementation of a stated goal with a number. It never sees the
// implementation's code: its one tool, `tools.run({ args })`, calls the implementation under test in a fresh sandbox of
// its own and returns what came out and how long it took. The judge calls rate() once per implementation the task
// brings: good ones (the reference among them) and bad ones (wrong, hard-coded, slow), some of each hidden like the
// holdout of a tools task. A harness counts only when every good implementation scores strictly higher than every bad
// one. The implementations are fixed by the task, before any harness is written, so a team never grades its own work.
// A harness of planners (`world: "island"`) rates bots instead: its `run` plays the bot under test for one episode on the
// toy island (toyisland.ts) and answers whether the goal was reached.
import { toolProgram, type Meter } from "./tooltask.ts";
import { MAX_BOT_CALLS } from "./bottask.ts";
import { MAX_TOY_WAIT, ToyIsland, toyCellError } from "./toyisland.ts";

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
	/** "island": the implementations are bots (`async function bot()`), and `run` plays one in a world of the toy island
	 *  (toyisland.ts) instead of calling a function: { start, wood, seed?, hold? } → { reached, points } (step 5 of
	 *  docs/codemode-planung.en.md, "Rate planners"). */
	world?: "island";
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
const ISLAND_DESCRIPTION = {
	de: (s: HarnessSpec) => `- tools.run(args): spielt den Bot, der gerade bewertet wird, eine Episode lang in einer eigenen Welt der Insel: { start: { room, x, y } (wo die Figur startet), wood: { room, x, y } (wo das einzige Stück Treibholz liegt), seed?: number (der Zufall der Welt, ganzzahlig ≥ 0, Standard 0), hold?: number (so viele Weltminuten muss das Feuer nach dem Bot noch brennen, 0 bis 60, Standard 0) } → { reached: boolean (das Feuer brennt, vom Bot genährt, auch nach hold Minuten), points: number (die Tool-Aufrufe des Bots) } oder { error } (die Episode ist ungültig). Ein Bot, der wirft oder länger als ${s.runMs / 1000} s braucht, hat die Episode nicht erreicht. Räume und Ausgänge wie oben; jede Zelle x 1..22, y 1..14 ist Boden, außer dem Feuer. 1 Punkt; höchstens ${MAX_RUNS} Aufrufe pro Bot.`,
	en: (s: HarnessSpec) => `- tools.run(args): plays the bot being rated for one episode in a world of the island of its own: { start: { room, x, y } (where the figure starts), wood: { room, x, y } (where the one piece of driftwood lies), seed?: number (the world's chance, an integer ≥ 0, default 0), hold?: number (how many world minutes the fire must still burn after the bot, 0 to 60, default 0) } → { reached: boolean (the fire burns, fed by the bot, also after hold minutes), points: number (the bot's tool calls) } or { error } (the episode is not valid). A bot that throws or takes longer than ${s.runMs / 1000} s did not reach the episode. Rooms and exits as above; every cell x 1..22, y 1..14 is ground except the fire. 1 point; at most ${MAX_RUNS} calls per bot.`,
};
export const describeHarnessTools = (s: HarnessSpec, lang: "de" | "en"): string => (s.world === "island" ? ISLAND_DESCRIPTION : DESCRIPTION)[lang](s);

/** The tool of one rate() call: `run` bound to one implementation, every call counted on `m`. */
export function harnessTools(make: SandboxMaker, captured: string, s: HarnessSpec, impl: Impl, m: Meter): CodemodeTool[] {
	if (s.world === "island") return islandTools(make, captured, s, impl, m);
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

/** The bot's own tools in one toy world, counted on `points` (a bot beyond MAX_BOT_CALLS throws, as in the arena). */
function toyTools(w: ToyIsland, points: { n: number }): CodemodeTool[] {
	const count = () => { if (points.n >= MAX_BOT_CALLS) throw new Error(`more than ${MAX_BOT_CALLS} tool calls`); points.n++; };
	const arg = (a: unknown) => (a && typeof a === "object" ? (a as Record<string, unknown>) : {});
	return [
		{ name: "look", execute: () => { count(); return w.look(); } },
		{ name: "act", execute: (a: unknown) => { count(); const line = arg(a).line; if (typeof line !== "string") throw new Error("act needs { line: string }"); return w.act(line); } },
		{ name: "wait", execute: (a: unknown) => { count(); return w.wait(arg(a).minutes); } },
	];
}

/** `run` of a planner harness: one episode of the bot under test in a fresh toy world and a fresh sandbox. */
function islandTools(make: SandboxMaker, captured: string, s: HarnessSpec, impl: Impl, m: Meter): CodemodeTool[] {
	return [{
		name: "run", description: ISLAND_DESCRIPTION.en(s),
		execute: async (raw: unknown) => {
			if (m.total >= MAX_RUNS) throw new Error(`more than ${MAX_RUNS} runs`);
			const a = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
			m.total++; m.calls.run = (m.calls.run ?? 0) + 1; m.cost += RUN_COST;
			const bad = toyCellError(a.start, "start") ?? toyCellError(a.wood, "wood");
			if (bad) return { error: bad };
			const seed = a.seed === undefined ? 0 : Number(a.seed), hold = a.hold === undefined ? 0 : Number(a.hold);
			if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) return { error: "seed: an integer from 0 to 2^32 - 1" };
			if (!Number.isInteger(hold) || hold < 0 || hold > 60 || hold > MAX_TOY_WAIT) return { error: "hold: an integer from 0 to 60" };
			const cell = (c: unknown) => { const o = c as Record<string, unknown>; return { room: String(o.room), x: Number(o.x), y: Number(o.y) }; };
			const w = new ToyIsland(cell(a.start), [cell(a.wood)], seed), points = { n: 0 };
			const sandbox = make({ timeoutMs: s.runMs, tools: toyTools(w, points), memoryLimitBytes: 64 * 1024 * 1024 });
			try {
				const r = await sandbox.execute(toolProgram(captured, "bot", impl.source));
				const failed = !r.ok || typeof (r.value as { error?: unknown } | undefined)?.error === "string";
				return { reached: !failed && w.reached(hold), points: points.n };
			} catch { return { reached: false, points: points.n }; } finally { await sandbox.close().catch(() => {}); }
		},
	}];
}
