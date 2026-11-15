// Triage between generations (server/triage.ts): Jev's causes, the main cause, the note the next generation gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Attempt } from "../server/llm.ts";
import { failureFacts, jevCauses, mainCause, NOTE_ROOM, TRIAGE_HINTS, triageNote } from "../server/triage.ts";

const attempt = (id: string, ok: boolean, error?: string): Attempt => ({ candidateId: id, author: "a", via: "m", gen: 2, ok, ms: 1, passed: ok ? 9 : 0, total: 9, source: "", ...(error ? { error } : {}) });

/** A stand-in for the decisions endpoint: answers every question with the given choices, records the request. */
type JevRequest = { model: string; state: { contributions: Record<string, unknown> }; questions: Record<string, { type: string }> };
function fakeJev(choices: string[], status = 200): { calls: Array<{ url: string; body: JevRequest }>; restore: () => void } {
	const real = globalThis.fetch, calls: Array<{ url: string; body: JevRequest }> = [];
	globalThis.fetch = (async (url: string, init: { body: string }) => {
		const body = JSON.parse(init.body) as JevRequest;
		calls.push({ url, body });
		const answers = Object.fromEntries(Object.keys(body.questions).map((k, i) => [k, { type: "choice", choice: choices[i % choices.length] }]));
		return new Response(JSON.stringify(status === 200 ? { model: "typesafe/jev-1.13-x", answers } : { error: { message: "no" } }), { status });
	}) as typeof fetch;
	return { calls, restore: () => { globalThis.fetch = real; } };
}

test("the main cause: the one most failures share, interface before rule before strategy on a tie, none for only 'other'", () => {
	assert.equal(mainCause({ a: "rule", b: "strategy", c: "rule" }), "rule");
	assert.equal(mainCause({ a: "strategy", b: "interface" }), "interface");
	assert.equal(mainCause({ a: "other" }), null);
	assert.equal(mainCause({}), null);
});

test("Jev is asked once, one question per failing contribution with its failure as the state; no key or a refusal asks nothing", async () => {
	const f = fakeJev(["interface", "strategy"]);
	try {
		const failing = [attempt("x1", false, "S1: cannot read property 'logbook' of undefined"), attempt("x2", false, "goal not reached")];
		const j = await jevCauses({ title: "Shores" }, failing, "key");
		assert.equal(f.calls.length, 1);
		assert.match(f.calls[0]!.url, /openrouter\.ai\/api\/alpha\/decisions/);
		assert.deepEqual(Object.keys(f.calls[0]!.body.questions), ["c1", "c2"]);
		assert.ok(Object.values(f.calls[0]!.body.questions).every((q) => q.type === "choice"));
		assert.match(JSON.stringify(f.calls[0]!.body.state.contributions), /logbook' of undefined/);
		assert.equal((f.calls[0]!.body.state.contributions.c1 as { crashed: boolean }).crashed, true, "the facts, not only the text");
		assert.deepEqual(j, { causes: { x1: "interface", x2: "strategy" }, model: "typesafe/jev-1.13-x" });
		assert.equal(await jevCauses({ title: "Shores" }, failing, ""), null, "no key");
		assert.equal(await jevCauses({ title: "Shores" }, [], "key"), null, "nothing failed");
	} finally { f.restore(); }
	const g = fakeJev([], 500);
	try { assert.equal(await jevCauses({ title: "Shores" }, [attempt("x1", false, "e")], "key"), null); } finally { g.restore(); }
});

test("the note: the cause's hint in the run's language with Jev's counts; the fixed mode always the interface hint; nothing when every contribution passed", async () => {
	const prev = process.env.JEV_OPENROUTER_API_KEY;
	process.env.JEV_OPENROUTER_API_KEY = "key";
	const f = fakeJev(["rule", "rule", "interface"]);
	try {
		const gen = [attempt("x1", false, "wait"), attempt("x2", false, "wait"), attempt("x3", false, "undefined"), attempt("x4", true)];
		const n = await triageNote("jev", { title: "Shores" }, gen, "de");
		assert.equal(n?.cause, "rule");
		assert.ok(n!.text.startsWith(TRIAGE_HINTS.rule.de));
		assert.match(n!.text, /\(interface 1, rule 2\)$/);
		assert.equal(n!.via, "typesafe/jev-1.13-x");
		assert.equal(f.calls[0]!.body.model, "typesafe/jev-1.13");
		assert.equal(Object.keys(f.calls[0]!.body.questions).length, 3, "only the failing ones are asked");
		const fixed = await triageNote("fixed", { title: "Shores" }, gen, "en");
		assert.deepEqual(fixed, { text: TRIAGE_HINTS.interface.en, via: "fixed", cause: "interface" });
		assert.equal(f.calls.length, 1, "the fixed mode asks nobody");
		assert.equal(await triageNote("jev", { title: "Shores" }, [attempt("x4", true)], "en"), null);
	} finally {
		f.restore();
		if (prev === undefined) delete process.env.JEV_OPENROUTER_API_KEY; else process.env.JEV_OPENROUTER_API_KEY = prev;
	}
});

test("every hint fits a team note with Jev's counts after it", () => {
	for (const h of Object.values(TRIAGE_HINTS)) for (const t of [h.de, h.en]) assert.ok(t.length + " (interface 10, rule 10, strategy 10, other 10)".length <= NOTE_ROOM, t);
});

test("the facts of a failure: the numbers of a bot's verdict as fields, a crash and a limit as flags", () => {
	const f = failureFacts(attempt("x", false, "S1: goal not reached; first seed: 0 of 1 pieces in the fire of Neuland 52 (0 seen in a look, 0 picked up), 451 world minutes gone (calls: logbook 24, look 216, wait 192 = 432 points)"));
	assert.deepEqual({ ...f, failure: undefined }, { failure: undefined, episodesPassed: 0, episodes: 9, crashed: false, hitLimit: false, piecesSeen: 0, piecesPickedUp: 0, piecesInFireFirstSeed: 0, worldMinutesGone: 451, toolCalls: { logbook: 24, look: 216, wait: 192 } });
	assert.equal(failureFacts(attempt("x", false, "S1: not a function (calls: logbook 24 = 24 points)")).crashed, true);
	assert.equal(failureFacts(attempt("x", false, "S1: a bot may wait at most 480 world minutes in all (calls: wait 120 = 120 points)")).hitLimit, true);
	assert.deepEqual(Object.keys(failureFacts(attempt("x", false, "add(2, 3): expected 5, got 6"))).sort(), ["crashed", "episodes", "episodesPassed", "failure", "hitLimit"], "a task without a bot: the text and the flags only");
});

test("real tool answers for the prompt: a bot task on made islands shows its first shown episode's answers, the logbook cut to one day; an arena task none", async () => {
	const { toolExamples } = await import("../server/examples.ts");
	const { taskById } = await import("../server/tasks.ts");
	const { teamPrompt } = await import("../server/llm.ts");
	const shores = taskById("tide-shores")!, text = (await toolExamples(shores))!;
	assert.match(text, /^await tools\.look\(\{\}\)\n→ \{"room":\{"id":"n52-/);
	assert.match(text, /await tools\.logbook\(\{\}\)\n→ \{"days":\[\{"island":"n52","day":1,/);
	assert.match(text, /"fromFire":\d+,/, "the shape an agent guessed wrong: a number, not a list");
	assert.match(text, /… 5 more days of the same form/);
	assert.match(text, /await tools\.act\(\{"line":"nimm treibholz"\}\)/);
	assert.equal(await toolExamples(shores), text, "the same answers every time");
	assert.equal(await toolExamples(taskById("tide-law")!).then((t) => /logbook/.test(t!)), false, "no logbook where the task has none");
	assert.equal(await toolExamples(taskById("beacon-neuland")!), null);
	const p = teamPrompt({ task: shores, lang: "en", agent: 0, gen: 1, toolExamples: text });
	assert.ok(p.user.includes("What the tools really return") && p.user.includes(text));
	assert.equal(teamPrompt({ task: shores, lang: "en", agent: 0, gen: 1 }).user.includes("What the tools really return"), false);
});
