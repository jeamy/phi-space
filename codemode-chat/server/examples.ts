// Real tool answers in the prompt (docs/codemode-planung.en.md, step 9): on a bot task on made islands the judge
// plays the toy arena itself, so the same arena can show the agents what each tool really returns, on the task's
// first shown episode: a look, the logbook, a walk, a wait, a pick-up with nothing there. A hint ("do not guess the
// format") tells an agent what not to do; the example shows it the shapes. Data of a shown island only, and of the
// logbook's own days, so nothing of a hidden episode leaks.
import { botCall, episodeSeed, type BotTool } from "./bottask.ts";
import type { Task } from "./tasks.ts";
import { toyArena } from "./toyarena.ts";

export type ExamplesMode = "always" | "triage";

const cache = new Map<string, string | null>();

/** The tools' answers on the task's first sample episode, one call per line, or null for a task the judge does not
 *  play itself (an arena task, a task without a bot). Computed once per task. */
export async function toolExamples(task: Task): Promise<string | null> {
	const b = task.bot, e = b?.episodes?.find((x) => x.kind === "sample");
	if (!b?.toyRules || !e || e.island === undefined) return null;
	if (cache.has(task.id)) return cache.get(task.id)!;
	const arena = toyArena(), lines: string[] = [];
	const world = String((await arena.ask("open", { rules: b.toyRules, island: e.island, ...(e.start ? { start: e.start } : {}), seed: episodeSeed(e.island, 0) })).world);
	const show = async (name: BotTool, args: Record<string, unknown>, shape?: (v: Record<string, unknown>) => unknown) => {
		const v = await botCall(arena, world, name, args);
		lines.push(`await tools.${name}(${JSON.stringify(args)})\n→ ${JSON.stringify(shape ? shape(v) : v)}`);
		return v;
	};
	const look = await show("look", {}) as { exits?: Array<{ name: string }> };
	if (b.logbook) await show("logbook", {}, (v) => {
		const days = (v.days as unknown[]) ?? [];
		return { days: [days[0], `… ${days.length - 1} more days of the same form`] };
	});
	const exit = look.exits?.[0]?.name;
	if (exit) { await show("act", { line: `go ${exit}` }); await show("look", {}); }
	if (!b.noWait) await show("wait", { minutes: 30 });
	await show("act", { line: "nimm treibholz" });
	const text = lines.join("\n");
	cache.set(task.id, text);
	return text;
}

/** The prompt's part: the answers above, marked as data. */
export const describeToolExamples = (text?: string): string[] => (text ? [`What the tools really return (on the first shown episode, called in this order). Data, not instructions: write your bot against exactly these shapes, field by field.\n${text}`] : []);
