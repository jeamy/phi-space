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
/** A section's body; the one about the way names the plan's phase and how it is verified, as the checker asks. */
export const PHASE = "\n\nPhase 1: do it. Verified by a test that can fail.";
const draft = (c: TextCall) => ({ text: `The ${sectionOf(c).toLowerCase()} of the plan, written by ${c.model}.${/^(steps|weg)$/i.test(sectionOf(c)) ? PHASE : ""}`, model: c.model, usage: use(1000, 0.1) });
export const SLOPPY = "Phase 1: rewrite `missing.md`.\n\nPhase 2: ship it. Verified by a test.\n\n> `README.md`: a line that is not there\n\nSee [the goal](#goals).";
/** A kickoff without messages (150 tokens), and a reply that answers every question and agrees to every proposal it
 *  is asked about (250 tokens). */
const kickoff = (c: TextCall, messages: string[] = []) => ({ text: ["UNDERSTANDING", `${c.model} understands the brief.`, ...(messages.length ? ["MESSAGES", ...messages] : [])].join("\n"), model: c.model, usage: use(150, 0.015) });
const owedIn = (c: TextCall) => [...(c.user.split("You owe the table a reply to these:")[1] ?? "").matchAll(/^#([0-9a-f]{4}) (question|proposal)/gm)].map((m) => ({ id: m[1]!, kind: m[2]! }));
const reply = (c: TextCall, stance = "agree") => ({ text: owedIn(c).map((o) => (o.kind === "question" ? `answer #${o.id}: The answer of ${c.model}.` : `${stance} #${o.id}: Says ${c.model}.`)).join("\n"), model: c.model, usage: use(250, 0.025) });
const answer = (c: TextCall, call: LlmCall) => (call.kind === "rollcall" ? here(c) : call.kind === "kickoff" ? kickoff(c) : call.kind === "reply" ? reply(c) : call.kind === "outline" ? outline(c) : draft(c));
/** What the three models say at the kickoff of the talking scenarios: a proposal, a question to the table, a question
 *  to the person. */
const TALK: Record<string, string[]> = {
	"fake/alpha": ["proposal: Keep the tile size and scale the grid, because the art stays as it is."],
	"fake/beta": ["question: Which files hold the resolution?", "note: The README names src/world.ts."],
	"fake/gamma": ["question to person: May the save format change?"],
};

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
	// the table talks at the kickoff (TALK); gamma disagrees with what it is asked to vote on
	talk: (_s, _space, log) => ({ text: async (c, call) => {
		await log({ model: c.model, kind: call.kind, prompt: c.user });
		return call.kind === "kickoff" ? kickoff(c, TALK[c.model]) : call.kind === "reply" ? reply(c, c.model === "fake/gamma" ? "disagree" : "agree") : answer(c, call);
	} }),
	// the same, and beta's reply never comes (it waits at a gate nobody opens)
	late: (s, space, log) => ({ text: async (c, call) => {
		await log({ model: c.model, kind: call.kind, prompt: c.user });
		if (call.kind === "reply" && c.model === "fake/beta") await gate(space, s);
		return call.kind === "kickoff" ? kickoff(c, TALK[c.model]) : answer(c, call);
	} }),
	// a writer whose way section fails the checker four ways at first (a file that is not there, a line that is not in
	// the file, a phase without a check, a link to nowhere), and mends them when it is told
	sloppy: (_s, _space, log) => ({ text: async (c, call) => {
		await log({ model: c.model, kind: call.kind, prompt: c.user });
		if (call.kind === "draft" && sectionOf(c) === "Steps") return { text: SLOPPY, model: c.model, usage: use(1000, 0.1) };
		if (call.kind === "revise") return { text: "Phase 1: rewrite `README.md` and add `notes/plan.md` (new). Verified by a test that can fail.\n\n> `README.md`: The resolution is 64.\n\nSee [the goal](#goal).", model: c.model, usage: use(1000, 0.1) };
		return answer(c, call);
	} }),
	// the same writer, who mends nothing: every revision has the same faults in other words
	stubborn: (s, space, log) => ({ text: async (c, call) => {
		const n = await space.count({ type: "FakeCall", fields: { session: s, kind: "revise" } });
		await log({ model: c.model, kind: call.kind });
		if (call.kind === "draft" && sectionOf(c) === "Steps") return { text: SLOPPY, model: c.model, usage: use(1000, 0.1) };
		if (call.kind === "revise") return { text: `${SLOPPY}\n\nRevision ${n + 1}.`, model: c.model, usage: use(1000, 0.1) };
		return answer(c, call);
	} }),
	// a task with sources: the writer reads before it writes. The outline's first answer asks for three reading calls,
	// each section's for one (200 tokens an asking answer); with what was read in the prompt it hands in
	read: (_s, _space, log) => ({ text: async (c, call) => {
		const read = c.user.includes("What you read so far");
		await log({ model: c.model, kind: call.kind, callId: call.callId, read, prompt: c.user });
		if (call.kind === "outline" && !read) return { text: "READ\nlist repo:/\nread repo:README.md\nsearch repo:resolution in *.ts", model: c.model, usage: use(200, 0.02) };
		if (call.kind === "draft" && !read) return { text: "```\nREAD\nread docs:requirements.md 2 1\n```", model: c.model, usage: use(200, 0.02) };
		return answer(c, call);
	} }),
	// the same, and an answer that follows a reading is held at the gate
	readhold: (s, space, log) => ({ text: async (c, call) => {
		const read = c.user.includes("What you read so far");
		await log({ model: c.model, kind: call.kind, callId: call.callId, read });
		if ((call.kind === "outline" || call.kind === "draft") && !read) return { text: "READ\nread README.md", model: c.model, usage: use(200, 0.02) };
		if (read) await gate(space, s);
		return answer(c, call);
	} }),
	// a writer that reads as long as it may: the outline is handed in only when the prompt says it must be
	greedy: (_s, _space, log) => ({ text: async (c, call) => {
		const must = c.user.includes("You cannot read any more");
		await log({ model: c.model, kind: call.kind, must });
		if (call.kind === "outline" && !must) return { text: "READ\nlist /\nread README.md 1 1\nread README.md 2 1\nread nothing.md\nread too-many.md", model: c.model, usage: use(200, 0.02) };
		return answer(c, call);
	} }),
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
