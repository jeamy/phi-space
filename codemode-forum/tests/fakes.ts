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

const here = (c: TextCall) => ({ text: `${c.model} is here.`, model: c.model, usage: use(100, 0.01) });
/** The outline the fakes propose, and a section's body: it names the section and who wrote it. */
export const OUTLINE = ["Goal", "Steps", "Risks"];
const outline = (c: TextCall) => ({ text: OUTLINE.map((h) => `## ${h}\nWhat ${h.toLowerCase()} must say.`).join("\n\n"), model: c.model, usage: use(400, 0.04) });
const sectionOf = (c: TextCall) => /Write the section "([^"]+)"/.exec(c.user)?.[1] ?? "?";
const draft = (c: TextCall) => ({ text: `The ${sectionOf(c).toLowerCase()} of the plan, written by ${c.model}.`, model: c.model, usage: use(1000, 0.1) });
const answer = (c: TextCall, call: LlmCall) => (call.kind === "rollcall" ? here(c) : call.kind === "outline" ? outline(c) : draft(c));

const scenarios: Record<string, (session: string, space: SpaceLike, log: Log) => Team> = {
	// every model answers the roll call (100 tokens and a cent each); the writer's outline has three sections (400
	// tokens), and each of its drafts costs 1000
	roll: (_s, _space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind, prompt: c.user, ...(call.sectionId ? { sectionId: call.sectionId } : {}) }); return answer(c, call); } }),
	// the models answer only once the test opens the gate (a run that is stopped, or whose processes restart, meanwhile)
	hold: (s, space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind }); await gate(space, s); return answer(c, call); } }),
	// the drafts are held at the gate; roll call and outline go through
	slow: (s, space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind }); if (call.kind === "draft") await gate(space, s); return answer(c, call); } }),
	// one model never answers properly: its call fails every time, and each failure was paid
	mute: (_s, _space, log) => ({ text: async (c, call) => {
		await log({ model: c.model, kind: call.kind });
		if (c.model === "fake/beta") throw Object.assign(new Error("empty answer"), { usage: use(50, 0.005) });
		return answer(c, call);
	} }),
	// dear answers: 3000 tokens each
	dear: (_s, _space, log) => ({ text: async (c, call) => { await log({ model: c.model, kind: call.kind }); return { ...answer(c, call), usage: use(3000, 0.3) }; } }),
	// an outline nobody can use the first time (no headings), then a proper one; and one section far too long
	odd: (s, space, log) => ({ text: async (c, call) => {
		const n = await space.count({ type: "FakeCall", fields: { session: s, kind: call.kind } });
		await log({ model: c.model, kind: call.kind });
		if (call.kind === "outline" && n === 0) return { text: "I would start with the goal and go on from there.", model: c.model, usage: use(300, 0.03) };
		if (call.kind === "draft" && sectionOf(c) === "Risks") return { text: Array.from({ length: 400 }, (_, i) => `Risk ${i}: ${"x".repeat(90)}`).join("\n\n"), model: c.model, usage: use(1000, 0.1) };
		return answer(c, call);
	} }),
};

export function llmFor(session: string, o: { space: SpaceLike; log: Log }): Partial<Team> {
	const make = scenarios[session.split("-")[0] ?? ""];
	return make ? make(session, o.space, o.log) : {};
}
