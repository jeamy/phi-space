import assert from "node:assert/strict";
import { test } from "node:test";
import { episodeSeed } from "../server/bottask.ts";
import { SHORE_EPISODES } from "../server/shores.ts";
import { empiricalRoundEvaluator, HybridEvaluationError, hybridCandidates, jevRoundEvaluator, playJevHybridEpisode, type HybridGoalContext } from "../server/jev-hybrid.ts";
import { jevSubgoalSelector } from "../server/jev-workflow.ts";

const graph = { fire: { ost: "a" }, a: { west: "fire" } };
const candidates = hybridCandidates(graph, { a: { x: 2, y: 2 } }, "fire", "fire", 60, 90, 1, 300);
const context: HybridGoalContext = { minute: 60, tide: 90, carried: 1, fire: "fire", current: "fire", days: [], candidates, remainingCalls: 300, returnNow: { minute: 60, calls: 2 } };

test("workflow subgoal API offers only allowed goals, accounts a paid refusal and enforces the budget guard", async () => {
	const original = globalThis.fetch;
	let requests = 0, spent = 0;
	try {
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.deepEqual(Object.keys(body.questions.subgoal.criteria), ["collect", "finish"]);
			assert.equal(body.state.returnNow.minute, 60);
			assert.equal(body.state.rules.carryingCapacity, "unlimited");
			requests++;
			return Response.json({ model: "fake", answers: { subgoal: { choice: requests === 1 ? "collect" : "deliver" } }, usage: { cost: 0.01 } });
		};
		const select = jevSubgoalSelector("test", "fake", (usd) => spent += usd);
		const result = await select(context, ["collect", "finish"]);
		assert.equal(result.goal, "collect"); assert.equal(result.requests, 1);
		await assert.rejects(select(context, ["collect", "finish"]), (error) => error instanceof HybridEvaluationError && error.usage.costUsd === 0.01);
		assert.equal(spent, 0.02);
		await assert.rejects(jevSubgoalSelector("test", "fake", () => {}, () => { throw new Error("budget"); })(context, ["finish"]), /budget/);
		assert.equal(requests, 2);
	} finally { globalThis.fetch = original; }
});

test("delivery feasibility is a separate probability gate, with raw replies retained", async () => {
	const original = globalThis.fetch;
	try {
		globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(String(init?.body));
			assert.equal(body.state.remainingCalls, 300);
			const answers = Object.fromEntries(Object.keys(body.questions).map((id) => [id, { noul: id.endsWith("_delivery") ? 0.2 : 0.7 }]));
			return Response.json({ answers, usage: { cost: 0 } });
		};
		const result = await jevRoundEvaluator("test", "fake", () => {}, () => {}, true)(context);
		assert.deepEqual(result.excluded, candidates.map((candidate) => candidate.id));
		assert.equal(result.scores[candidates[0]!.id], 0.7);
		assert.equal(result.probabilities![`${candidates[0]!.id}_delivery`], 0.2);
	} finally { globalThis.fetch = original; }
});

test("workflow can deliver an intermediate load and then collect again, without a zero-load delivery loop", async () => {
	let deliveredEarly = false, observedAfterDelivery = false;
	const episode = SHORE_EPISODES[0]!;
	const result = await playJevHybridEpisode(episode, episodeSeed(episode.island!, 0), empiricalRoundEvaluator, {
		subgoal: async (state, allowed) => {
			if (deliveredEarly && state.carried === 0) observedAfterDelivery = true;
			const deliver = state.carried > 0 && !deliveredEarly;
			if (deliver) deliveredEarly = true;
			const goal = deliver ? "deliver" : allowed.includes("collect") ? "collect" : "finish";
			return { goal, requests: 1, costUsd: 0.001, models: ["fake-goal"] };
		},
	});
	assert.equal(result.end, "complete"); assert.ok(result.count > 0);
	assert.ok(deliveredEarly && observedAfterDelivery);
	assert.ok(result.subgoals!.some((goal) => goal.goal === "deliver"));
	assert.ok(result.subgoals!.every((goal) => goal.goal !== "deliver" || goal.carried > 0));
	assert.ok(result.decisions === result.subgoals!.length);
});

test("all model-rejected rounds are skipped visibly and no empirical score replaces them", async () => {
	const result = await playJevHybridEpisode(SHORE_EPISODES[0]!, 0, async ({ candidates }) => ({
		scores: Object.fromEntries(candidates.map((candidate) => [candidate.id, 1])),
		excluded: candidates.map((candidate) => candidate.id), costUsd: 0, requests: 1, models: ["fake"],
	}), {
		subgoal: async (_state, allowed) => ({ goal: allowed.includes("collect") ? "collect" : "finish", costUsd: 0, requests: 1, models: ["fake"] }),
	});
	assert.equal(result.end, "complete"); assert.equal(result.count, 0);
	assert.ok(result.rounds.length > 0);
	assert.ok(result.rounds.every((round) => round.selected === null && round.excluded?.length));
});

test("finishing early delivers the carried load before the episode ends", async () => {
	const episode = SHORE_EPISODES[0]!;
	const result = await playJevHybridEpisode(episode, episodeSeed(episode.island!, 0), empiricalRoundEvaluator, {
		subgoal: async (state) => ({ goal: state.carried > 0 ? "finish" : "collect", requests: 0, costUsd: 0, models: ["fake"] }),
	});
	assert.equal(result.end, "complete"); assert.ok(result.count > 0);
	assert.equal(result.subgoals!.at(-1)!.goal, "finish");
	assert.ok(result.rounds.length < 7);
});
