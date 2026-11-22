// The fake models of the tests, loaded by the model process (FORUM_LLM_MODULE, FORUM_TEST=1) and picked by room: every
// test runs in a room of its own, and the room's name up to the first "-" names the scenario. They talk to the test
// only through the space: what they saw goes into FakeCall entries (`log`), and a model that must hang until the test
// says so waits for a FakeGate entry.
import type { SpaceLike } from "phi-spaces";
import type { LlmCall } from "../server/calls.ts";
import { callSignal, type TextAnswer, type TextCall } from "../server/llm.ts";

type Log = (e: Record<string, unknown>) => Promise<void>;
type Team = { text: (c: TextCall, call: LlmCall) => Promise<TextAnswer> };

export const MODELS = ["fake/alpha", "fake/beta", "fake/gamma", "fake/delta"];
/** The models of the stack (a test may name its own: FORUM_FAKE_MODELS), else all of the fake ones. */
export async function models(): Promise<string[]> { const own = (process.env.FORUM_FAKE_MODELS ?? "").split(",").filter(Boolean); return own.length ? own : MODELS; }

export const use = (total: number, costUsd: number) => ({ input: total - 20, output: 20, cacheRead: 0, cacheWrite: 0, total, costUsd });
/** Waits until the test writes the room's FakeGate; like a real call it ends when its run is stopped (callSignal). */
const gate = async (space: SpaceLike, session: string) => {
	const signal = callSignal();
	while (!(await space.readIfExists({ type: "FakeGate", fields: { session } }, 500))) signal?.throwIfAborted();
};

const scenarios: Record<string, (session: string, space: SpaceLike, log: Log) => Team> = {
	// every model answers the roll call: 100 tokens and a cent each
	roll: (_s, _space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind, prompt: c.user }); return { text: `${c.model} is here.`, model: c.model, usage: use(100, 0.01) }; } }),
	// the models answer only once the test opens the gate (a run that is stopped, or whose processes restart, meanwhile)
	hold: (s, space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind }); await gate(space, s); return { text: `${c.model} is here.`, model: c.model, usage: use(100, 0.01) }; } }),
	// one model never answers properly: its call fails every time, and each failure was paid
	mute: (_s, _space, log) => ({ text: async (c, call) => {
		await log({ model: c.model, kind: call.kind });
		if (c.model === "fake/beta") throw Object.assign(new Error("empty answer"), { usage: use(50, 0.005) });
		return { text: `${c.model} is here.`, model: c.model, usage: use(100, 0.01) };
	} }),
	// dear answers: 3000 tokens each
	dear: (_s, _space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind }); return { text: `${c.model} is here.`, model: c.model, usage: use(3000, 0.3) }; } }),
};

export function llmFor(session: string, o: { space: SpaceLike; log: Log }): Partial<Team> {
	const make = scenarios[session.split("-")[0] ?? ""];
	return make ? make(session, o.space, o.log) : {};
}
