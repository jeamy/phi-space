import assert from "node:assert/strict";
import { test } from "node:test";
import { episodeSeed } from "../server/bottask.ts";
import { SHORE_EPISODES } from "../server/shores.ts";
import { empiricalRoundEvaluator, hybridCandidates, hybridRoute, jevRoundEvaluator, playJevHybridEpisode, type HybridContext, type RoomGraph } from "../server/jev-hybrid.ts";

const graph: RoomGraph = { fire: { ost: "a" }, a: { west: "fire", ost: "b" }, b: { west: "a", nord: "c" }, c: { süd: "b" } };
const cells = { a: { x: 2, y: 2 }, b: { x: 3, y: 3 }, c: { x: 4, y: 4 } };

test("hybrid candidates reserve delivery time and calls, visit before expiry, and preserve legal routes", () => {
	assert.deepEqual(hybridRoute(graph, "c", "fire"), ["süd", "west", "west"]);
	assert.equal(hybridRoute(graph, "a", "missing"), null);
	const candidates = hybridCandidates(graph, cells, "fire", "fire", 440, 450, 4, 30);
	assert.ok(candidates.length > 0);
	assert.ok(candidates.some((candidate) => candidate.visits.length === 3));
	for (const candidate of candidates) {
		assert.ok(candidate.returnMinute <= 480);
		assert.ok(candidate.toolBound <= 30);
		assert.ok(candidate.visits.every((visit) => visit.minute >= 450 && visit.minute < 480));
		let room = "fire";
		for (const direction of [...candidate.approach, ...candidate.walk, ...candidate.returnDirections]) {
			assert.ok(graph[room]?.[direction]);
			room = graph[room]![direction]!;
		}
		assert.equal(room, "fire");
	}
	assert.deepEqual(hybridCandidates(graph, cells, "fire", "fire", 480, 450, 4, 30), []);
	assert.deepEqual(hybridCandidates(graph, cells, "fire", "fire", 440, 450, 4, 2), []);
});

test("empirical hybrid completes the task on the exact nine episodes and eight seeds, within game limits", async () => {
	for (const episode of SHORE_EPISODES) {
		let total = 0;
		for (let index = 0; index < 8; index++) {
			const result = await playJevHybridEpisode(episode, episodeSeed(episode.island!, index), empiricalRoundEvaluator);
			assert.equal(result.end, "complete", `${episode.id}: ${result.end}`);
			assert.ok(result.calls <= 300);
			assert.equal(result.decisions, 0);
			assert.equal(result.costUsd, 0);
			assert.ok(result.rounds.every((round) => round.candidates.every((candidate) => candidate.returnMinute <= 480)));
			total += result.count;
		}
		assert.ok(total / 8 >= episode.target!, `${episode.id}: ${total / 8} < ${episode.target}`);
	}
});

test("Jev scores tail probabilities in batches of ten, accounts each batch and records the raw answers", async () => {
	const original = globalThis.fetch;
	let requests = 0, spent = 0, guards = 0;
	const candidates = hybridCandidates(graph, cells, "fire", "fire", 60, 90, 0, 300);
	try {
		globalThis.fetch = async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			assert.ok(Object.keys(request.questions).length <= 10);
			assert.equal(request.state.seed, undefined);
			assert.equal(request.state.deadlineMs, undefined);
			requests++;
			const answers = Object.fromEntries(Object.keys(request.questions).map((id) => [id, { noul: 1 / Number(id.split("_ge")[1]) }]));
			return Response.json({ model: "fake-jev", answers, usage: { cost: 0.01 } });
		};
		const evaluate = jevRoundEvaluator("test", "fake", (usd) => spent += usd, () => guards++);
		const result = await evaluate({ minute: 60, tide: 90, carried: 0, fire: "fire", days: [], candidates, deadlineMs: Date.now() + 60_000 });
		assert.ok(requests >= 2);
		assert.equal(result.requests, requests); assert.equal(guards, requests);
		assert.equal(result.costUsd, spent);
		for (const candidate of candidates) {
			const expected = candidate.visits.reduce((n, _, index) => n + 1 / (index + 1), 0);
			assert.ok(Math.abs(result.scores[candidate.id]! - expected) < 1e-9);
		}
		assert.ok(Object.keys(result.probabilities!).length > candidates.length);
	} finally { globalThis.fetch = original; }
});

test("an invalid paid Jev answer fails visibly, while the budget guard prevents a request", async () => {
	const original = globalThis.fetch;
	let spent = 0, requests = 0;
	const context: HybridContext = { minute: 60, tide: 90, carried: 0, fire: "fire", days: [], candidates: hybridCandidates(graph, cells, "fire", "fire", 60, 90, 0, 300, 1) };
	try {
		globalThis.fetch = async () => {
			requests++;
			return Response.json({ answers: {}, usage: { cost: 0.01 } });
		};
		await assert.rejects(jevRoundEvaluator("test", "fake", (usd) => spent += usd)(context), /invalid probability/);
		assert.equal(spent, 0.01);
		await assert.rejects(jevRoundEvaluator("test", "fake", () => {}, () => { throw new Error("budget exhausted"); })(context), /budget exhausted/);
		assert.equal(requests, 1);
		const result = await playJevHybridEpisode(SHORE_EPISODES[0]!, 0, async () => { throw new Error("provider unavailable"); });
		assert.equal(result.end, "provider unavailable");
		assert.equal(result.rounds.length, 0);
	} finally { globalThis.fetch = original; }
});

test("mocked Jev probability batches drive a complete hybrid trajectory and preserve paid errors", async () => {
	const original = globalThis.fetch;
	let spent = 0;
	try {
		globalThis.fetch = async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			const days = request.state.days;
			const trials = days.reduce((n: number, day: any) => n + day.minutes.length, 0);
			const answers: Record<string, { noul: number }> = {};
			for (const id of Object.keys(request.questions)) {
				const [candidateId, threshold] = id.split("_ge");
				const candidate = request.state.candidates.find((c: any) => c.id === candidateId);
				let distribution = [1];
				for (const visit of candidate.visits) {
					const hits = days.reduce((n: number, day: any) => n + day.rooms.find((r: any) => r.room === visit.room).pieces.length, 0);
					const probability = hits / trials;
					const next = Array(distribution.length + 1).fill(0);
					for (let k = 0; k < distribution.length; k++) {
						next[k] += distribution[k]! * (1 - probability);
						next[k + 1] += distribution[k]! * probability;
					}
					distribution = next;
				}
				answers[id] = { noul: distribution.slice(Number(threshold)).reduce((a, b) => a + b, 0) };
			}
			return Response.json({ model: "mock-jev", answers, usage: { cost: 0.001 } });
		};
		const episode = SHORE_EPISODES[0]!, seed = episodeSeed(episode.island!, 0);
		const control = await playJevHybridEpisode(episode, seed, empiricalRoundEvaluator);
		const result = await playJevHybridEpisode(episode, seed, jevRoundEvaluator("test", "fake", (usd) => spent += usd));
		assert.equal(result.end, "complete"); assert.equal(result.count, control.count);
		assert.ok(result.decisions > result.rounds.length);
		assert.ok(Math.abs(spent - result.costUsd) < 1e-9);
		globalThis.fetch = async () => Response.json({ answers: {}, usage: { cost: 0.02 } });
		const broken = await playJevHybridEpisode(episode, seed, jevRoundEvaluator("test", "fake", () => {}));
		assert.match(broken.end, /invalid probability/);
		assert.equal(broken.costUsd, 0.02); assert.equal(broken.decisions, 1);
	} finally { globalThis.fetch = original; }
});
