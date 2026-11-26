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
/** The section a revision is asked for, as the prompt shows it: a reviser that hands this back leaves it as it is. */
const asItIs = (c: TextCall) => /The section "[^"]+" as it is now:\n"""\n([\s\S]*?)\n"""/.exec(c.user)?.[1] ?? draft(c).text;
export const SLOPPY = "Phase 1: rewrite `missing.md`.\n\nPhase 2: ship it. Verified by a test.\n\n> `README.md`: a line that is not there\n\nSee [the goal](#goals).";
/** A kickoff without messages (150 tokens), and a reply that answers every question and agrees to every proposal it
 *  is asked about (250 tokens). */
const kickoff = (c: TextCall, messages: string[] = []) => ({ text: ["UNDERSTANDING", `${c.model} understands the brief.`, ...(messages.length ? ["MESSAGES", ...messages] : [])].join("\n"), model: c.model, usage: use(150, 0.015) });
const owedIn = (c: TextCall) => [...(c.user.split("You owe the table a reply to these:")[1] ?? "").matchAll(/^#([0-9a-f]{4}) (question|proposal)/gm)].map((m) => ({ id: m[1]!, kind: m[2]! }));
const reply = (c: TextCall, stance = "agree") => ({ text: owedIn(c).map((o) => (o.kind === "question" ? `answer #${o.id}: The answer of ${c.model}.` : `${stance} #${o.id}: Says ${c.model}.`)).join("\n"), model: c.model, usage: use(250, 0.025) });
/** Table B: a pick of the first outline offered (120 tokens), a review without objections (600), and a revision that
 *  says it is one. */
const pick = (c: TextCall, of = /Outline by (M\d+):/.exec(c.user)?.[1]) => ({ text: `PICK ${of}: It is the clearest.`, model: c.model, usage: use(120, 0.012) });
/** A ballot (600 tokens). It approves with words that are in every fake section ("of the plan, written"), or rejects
 *  with `objections`; `confirm` says what became of the model's own earlier objections (default: resolved, when it
 *  approves; nothing when it rejects). */
export const QUOTE = "of the plan, written";
const roundOf = (c: TextCall) => Number(/This is round (\d+) of the ballots/.exec(c.user)?.[1] ?? 1);
const ownIn = (c: TextCall) => [...(c.user.split("Your own earlier objections.")[1]?.split("\n\n")[0] ?? "").matchAll(/^#(o[0-9a-f]+) on /gm)].map((m) => m[1]!);
const review = (c: TextCall, objections: string[] = [], o: { confirm?: "resolved" | "not resolved: it is still wrong" | "withdrawn"; quote?: string; messages?: string[] } = {}) => {
	const n = (c.user.match(/^\d+ met: "<words of the plan>"/gm) ?? []).length, own = ownIn(c), approve = !objections.length && !(o.confirm ?? "").startsWith("not");
	const confirm = o.confirm ?? (approve ? "resolved" : undefined);
	return { text: [`BALLOT: ${approve ? "APPROVE" : "REJECT"}`, "CRITERIA", ...Array.from({ length: n }, (_, i) => (approve || i > 0 ? `${i + 1} met: "${o.quote ?? QUOTE}"` : `${i + 1} not met: see my objection`)), ...(own.length && confirm ? ["CONFIRM", ...own.map((id) => `#${id} ${confirm}`)] : []), ...(objections.length ? ["OBJECTIONS", ...objections] : []), ...(o.messages ? ["MESSAGES", ...o.messages] : [])].join("\n"), model: c.model, usage: use(600, 0.06) };
};
const revised = (c: TextCall) => { const d = draft(c); return { ...d, text: `${d.text}\n\nRevised by ${c.model}: the target is 256.` }; };
/** Table A: a turn (500 tokens) with these objections, or none. */
const turn = (c: TextCall, objections: string[] = [], messages: string[] = []) => ({ text: [...(objections.length ? objections : ["NO OBJECTIONS"]), ...(messages.length ? ["MESSAGES", ...messages] : [])].join("\n"), model: c.model, usage: use(500, 0.05) });
const turnRound = (c: TextCall) => Number(/It is your turn at the table \(round (\d+)\)/.exec(c.user)?.[1] ?? 1);
/** A run with both tables: a blind comparison (700 tokens) that prefers `prefer` on every criterion and names one
 *  thing each document does better. */
const compare = (c: TextCall, prefer: "X" | "Y" = "X") => {
	const n = (c.user.match(/^\d+ X: <why>/gm) ?? []).length;
	return { text: [`PREFER: ${prefer}`, "CRITERIA", ...Array.from({ length: n }, (_, i) => `${i + 1} ${prefer}: It is the clearer one.`), "BETTER", 'better Y: It names the phase and how it is verified. | from: "Steps" | into: "Steps"', 'better X: It says what is left out. | from: "Goal" | into: "Goal"', 'better X: no such section | from: "Nowhere" | into: "Goal"'].join("\n"), model: c.model, usage: use(700, 0.07) };
};
const answer = (c: TextCall, call: LlmCall) => (call.kind === "rollcall" ? here(c) : call.kind === "compare" ? compare(c) : call.kind === "turn" ? turn(c) : call.kind === "kickoff" ? kickoff(c) : call.kind === "reply" ? reply(c) : call.kind === "outline" ? outline(c) : call.kind === "pick" ? pick(c) : call.kind === "review" ? review(c) : call.kind === "revise" ? revised(c) : draft(c));
/** Table B: the outline each model proposes, and the one all of them prefer (alpha's). */
const OUTLINES: Record<string, string[]> = { "fake/alpha": OUTLINE, "fake/beta": ["Aim", "Way", "Dangers"], "fake/gamma": ["First", "Second", "Third"] };
const proposal = (c: TextCall) => ({ text: (OUTLINES[c.model] ?? OUTLINE).map((h) => `## ${h}\nWhat ${h.toLowerCase()} must say.`).join("\n\n"), model: c.model, usage: use(400, 0.04) });
const pickGoal = (c: TextCall) => pick(c, /Outline by (M\d+):\n## Goal/.exec(c.user)?.[1] ?? /Outline by (M\d+):/.exec(c.user)?.[1]);
const OBJECT_GOAL = 'objection on "Goal": It does not name the target value. | fix: Name 256 as the target. | quote: "The goal of the plan"';
const OBJECT_WHY = 'objection on "goal": It gives no reason. | fix: Say why 256.';
/** The table-B scenarios: outlines of their own, alpha's picked; `ballot` says what a model answers in a round (null:
 *  it approves and confirms what was taken up). `hold`: the revision waits at the gate. */
type BallotOf = (model: string, round: number, c: TextCall) => ReturnType<typeof review> | null;
const tableB = (ballot: BallotOf, o: { hold?: boolean; revise?: (c: TextCall) => ReturnType<typeof draft> } = {}) => (s: string, space: SpaceLike, log: Log): Team => ({ text: async (c, call) => {
	await log({ model: c.model, kind: call.kind, callId: call.callId, prompt: c.user, ...(call.kind === "review" ? { round: roundOf(c) } : {}) });
	if (o.hold && call.kind === "revise") await gate(space, s);
	if (call.kind === "review") return ballot(c.model, roundOf(c), c) ?? review(c);
	return call.kind === "outline" ? proposal(c) : call.kind === "pick" ? pickGoal(c) : call.kind === "revise" && o.revise ? o.revise(c) : answer(c, call);
} });
/** The table-A scenarios, by the models' names at the table (the order of the turns; drawn anew for every run):
 *  `objects` says what a model objects to in its turn of a round (null: nothing), `ballot` what it answers in the
 *  ballots (null: it approves). `hold`: that model's turn waits at the gate; `holdRevise`: the revisions do. */
const seatOf = (c: TextCall) => /^You are (M\d+)\./.exec(c.user)?.[1] ?? "?";
const tableA = (objects: (seat: string, round: number) => string[] | null, o: { ballot?: BallotOf; hold?: string; holdRevise?: boolean } = {}) => (s: string, space: SpaceLike, log: Log): Team => ({ text: async (c, call) => {
	await log({ model: c.model, kind: call.kind, callId: call.callId, prompt: c.user, ...(call.kind === "review" ? { round: roundOf(c) } : call.kind === "turn" ? { round: turnRound(c) } : {}) });
	if ((call.kind === "turn" && o.hold === seatOf(c)) || (call.kind === "revise" && o.holdRevise)) await gate(space, s);
	if (call.kind === "turn") return turn(c, objects(seatOf(c), turnRound(c)) ?? []);
	if (call.kind === "review") return o.ballot?.(seatOf(c), roundOf(c), c) ?? review(c);
	return answer(c, call);
} });
/** The scenarios with both tables: every call is logged with its table. */
type Hook = (c: TextCall, call: LlmCall, space: SpaceLike, s: string) => Promise<ReturnType<typeof review> | null | void>;
const bothTables = (o: { ballot?: Hook; hold?: Hook; turn?: (c: TextCall) => ReturnType<typeof turn> | null } = {}) => (s: string, space: SpaceLike, log: Log): Team => ({ text: async (c, call) => {
	await log({ model: c.model, kind: call.kind, table: call.table ?? "", runId: call.runId ?? "", callId: call.callId, prompt: c.user });
	await o.hold?.(c, call, space, s);
	if (call.kind === "review") return (await o.ballot?.(c, call, space, s)) || review(c);
	if (call.kind === "turn") return o.turn?.(c) ?? turn(c);
	return answer(c, call);
} });
/** In the first round beta and gamma each object to the goal; alpha approves. */
const twoObject: BallotOf = (model, round, c) => (round === 1 && model !== "fake/alpha" ? review(c, [model === "fake/beta" ? OBJECT_GOAL : OBJECT_WHY], model === "fake/beta" ? { messages: ["note: The target value belongs in the goal."] } : {}) : null);

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
	// both tables: everybody approves at both, the comparison prefers X (so two of three models table A), and the final
	// round takes over what the other document does better
	both: bothTables(),
	// the same, and after the final round's revision nobody approves any more
	keep: bothTables({ ballot: async (c) => (c.user.includes("Revised by") ? review(c, ['objection on "Risks": It names no risk of what was taken over. | fix: Name one.']) : null) }),
	// table A's drafts wait until table B has agreed; then M2 proposes in its turn to take over a section of table B
	swap: bothTables({ hold: async (c, call, space, s) => { if (call.kind === "draft" && call.table === "A") while (!(await space.count({ type: "PlanAccept", fields: { session: s, table: "B" } }))) await new Promise((r) => setTimeout(r, 100)); },
		turn: (c) => (seatOf(c) === "M2" ? turn(c, [], ['proposal: take over "Steps" into "Steps": It names the phase and how it is verified.']) : null) }),
	// table A: nobody objects in its turn, everybody approves
	turns: tableA(() => null),
	// table A: M2, the first to have the turn, objects to the goal and revises it itself; M1 and M3 object to the
	// steps in their ballots of the first round, which the first turn of the second round takes up
	around: tableA((seat, round) => (round === 1 && seat === "M2" ? [OBJECT_GOAL] : null), { ballot: (seat, round, c) => (round === 1 && seat !== "M2" ? review(c, ['objection on "Steps": Phase 1 is too coarse. | fix: Split it in two.']) : null) }),
	// table A: M2's turn never comes (it waits at a gate nobody opens)
	absent: tableA(() => null, { hold: "M2" }),
	// table A: M2 objects in its turn, and its revision waits at the gate
	ahold: tableA((seat, round) => (round === 1 && seat === "M2" ? [OBJECT_GOAL] : null), { holdRevise: true }),
	// table B: everybody approves the first version
	agree: tableB(() => null),
	// table B: beta and gamma object to the goal in the first round (beta says something to the table with it); it is
	// revised, they confirm, and everybody approves the second version
	tableb: tableB(twoObject),
	// the same, and the revision waits at the gate
	bhold: tableB(twoObject, { hold: true }),
	// all three object in the first round: two to one section, the third to another (and two lines that are no objection)
	crowd: tableB((model, round, c) => (round !== 1 ? null : review(c, model === "fake/alpha" ? ['objection on "Steps": Phase 1 is too coarse. | fix: Split it in two.', 'objection on "Nowhere": no such section | fix: none', "objection on \"Risks\": could be more detailed"] : [model === "fake/beta" ? OBJECT_GOAL : OBJECT_WHY]))),
	// approvals without evidence: alpha and beta quote words that are not in the plan
	bare: tableB((model, _round, c) => (model === "fake/gamma" ? null : review(c, [], { quote: "this all looks fine to me" }))),
	// the reviser leaves the sections as they are (one model objects to each); in the second round gamma withdraws its
	// objection, beta keeps its own
	declined: tableB((model, round, c) => (round === 1 && model !== "fake/alpha" ? review(c, [model === "fake/beta" ? OBJECT_GOAL : 'objection on "Risks": It gives no reason. | fix: Say why 256.']) : null) ?? (round === 2 && model !== "fake/alpha" ? review(c, [], { confirm: model === "fake/gamma" ? "withdrawn" : "not resolved: it is still wrong" }) : null), { revise: (c) => ({ ...draft(c), text: asItIs(c) }) }),
	// beta and gamma object to the same section, and the reviser hands it back as it was
	overruled: tableB(twoObject, { revise: (c) => ({ ...draft(c), text: asItIs(c) }) }),
	// beta and gamma object to the goal in rounds one and two; in round three beta objects to a section nobody touched
	settle: tableB((model, round, c) => (model === "fake/alpha" ? null : round === 1 ? review(c, [model === "fake/beta" ? OBJECT_GOAL : OBJECT_WHY]) : round === 2 ? review(c, ['objection on "Goal": The revision names the target, not the date. | fix: Name a date.'], { confirm: "resolved" }) : model === "fake/beta" ? review(c, ['objection on "Risks": It names no risk of the migration. | fix: Name one.'], { confirm: "resolved" }) : null),
		{ revise: (c) => { const d = draft(c); return { ...d, text: `${d.text}\n\nRevised by ${c.model} after ${(c.user.match(/^- M\d: /gm) ?? []).length} objections, text ${c.user.length}.` }; } }),
	// beta and gamma say after every revision that their objection is not resolved, until the person has spoken
	stuck: tableB((model, round, c) => (model === "fake/alpha" || c.user.includes("Take beta's point")) ? null : round === 1 ? review(c, [model === "fake/beta" ? OBJECT_GOAL : OBJECT_WHY]) : review(c, [], { confirm: "not resolved: it is still wrong" }),
		{ revise: (c) => { const d = draft(c); return { ...d, text: `${d.text}\n\nRevised by ${c.model}, prompt of ${c.user.length} characters.` }; } }),
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
