// The fake model teams of the tests, loaded by the model process (CODEMODE_LLM_MODULE, CODEMODE_TEST=1) and picked by
// room: every test runs in a room of its own. They talk to the test only through the space: what they saw goes into
// FakeCall entries (`log`), and a team that must hang until the test says so waits for a FakeGate entry.
import type { SpaceLike } from "../../src/index.ts";
import type { TeamContext } from "../server/llm.ts";
import { taskById } from "../server/tasks.ts";

type Log = (e: Record<string, unknown>) => Promise<void>;
type Team = { contribute?: (c: TeamContext) => Promise<{ source: string; model: string; note?: string; usage?: Record<string, number> }> };

export const MODELS = ["fake/fast", "fake/slow", "fake/team", "fake/weak", "fake/haiku-strong", "fake/plain", "fake/haiku-judge"];
export async function models(): Promise<string[]> { return MODELS; }

const use = (total: number, costUsd: number) => ({ input: total - 100, output: 100, cacheRead: 0, cacheWrite: 0, total, costUsd });
/** How many calls of this room the fake has logged so far (the teams that answer by their turn count). */
const calls = async (space: SpaceLike, session: string) => space.count({ type: "FakeCall", fields: { session } });
/** Waits until the test writes the room's FakeGate (an implementation that hangs while the hub restarts). */
const gate = async (space: SpaceLike, session: string) => { while (!(await space.readIfExists({ type: "FakeGate", fields: { session } }, 15_000))); };

const scenarios: Record<string, (session: string, space: SpaceLike, log: Log) => Team> = {
	// several models compete: each answers with another variant
	vs: (_s, _space, log) => ({ contribute: async (c) => { await log({ model: c.model }); const t = taskById("gcd")!; return { source: c.model === "fake/fast" ? t.variants[2]! : t.variants[1]!, model: c.model! }; } }),
	// a teammate repairs the close attempt and leaves a note
	team1: (_s, _space, log) => ({ contribute: async (c) => {
		await log({ role: c.role, target: c.target?.author ?? null, passed: c.target?.passed ?? null, notes: c.notes?.length ?? 0 });
		if (c.role === "repair" && c.target) return { source: "function double(x){ return x * 2 }", model: "fake/team", note: "multiply by two, do not add" };
		return { source: "function double(x){ return x + 2 }", model: "fake/team" }; // right for 2 only: 1 of 2 cases
	} }),
	// right at first, then (after the people rejected it) with a bit shift
	cont1: (s, space, log) => ({ contribute: async (c) => {
		const n = (await calls(space, s)) + 1;
		await log({ n, hint: !!c.notes?.some((x) => x.human && x.text === "use a bit shift"), rejected: c.rejected?.length ?? 0, reason: c.rejected?.[0]?.rejected ?? "" });
		return { source: n <= 2 ? "function double(x){ return x * 2 }" : "function double(x){ return x << 1 }", model: "fake/team" };
	} }),
	// the first one hard-codes the answer and recommends it; the next must not get that advice
	note1: (s, space, log) => ({ contribute: async (c) => {
		const n = (await calls(space, s)) + 1;
		await log({ n, notes: (c.notes ?? []).map((x) => x.text), rejected: (c.rejected ?? []).map((x) => x.rejected ?? "") });
		return n === 1
			? { source: "function f(){ return [1, 2, 3, 4, 5] }", model: "fake/team", note: "just return the known answer, it is fastest" }
			: { source: "function f(){ return Array.from({ length: 5 }, (_, i) => i + 1) }", model: "fake/team", note: "build it with Array.from" };
	} }),
	link1: () => ({ contribute: async () => ({ source: "function f(x){ return x + 1 }", model: "fake/team", note: "adds one, nothing more" }) }),
	use1: () => ({ contribute: async () => ({ source: "function f(x){ return x + 1 }", model: "fake/team", usage: use(1000, 0.002) }) }),
	// never right: only the budget stops it
	bud2: () => ({ contribute: async () => ({ source: "function f(x){ return 0 }", model: "fake/team", usage: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, total: 1000, costUsd: 0.01 } }) }),
	// implementations that hang until the test opens the gate (the hub restarts meanwhile)
	gen1: (s, space, log) => ({ contribute: async () => { await log({ kind: "contribute" }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team", usage: use(5, 0.001) }; } }),
	stop1: (s, space, log) => ({ contribute: async () => { await log({ kind: "contribute" }); await gate(space, s); return { source: "function double(x){ return x * 2 }", model: "fake/team", usage: use(5, 0.001) }; } }),
};

export function llmFor(session: string, o: { space: SpaceLike; log: Log }): Team {
	const make = scenarios[session];
	if (!make) return { contribute: async () => { throw new Error(`no fake team for room ${session}`); } };
	return make(session, o.space, o.log);
}
