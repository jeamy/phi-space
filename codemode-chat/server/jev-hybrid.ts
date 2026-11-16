// Hybrid player: observe and map through game tools, enumerate feasible tide rounds, ask Jev for their value,
// execute the best-scored round and reserve enough time and tool calls to deliver everything already carried.
import { botCall, MAX_BOT_CALLS, type BotEpisode } from "./bottask.ts";
import { toyArena } from "./toyarena.ts";
import type { PlayerAction, PlayerResult, PlayerStep } from "./jev-player.ts";
import { requestJev, type JevQuestion } from "./jev-decisions.ts";

type Cell = { x: number; y: number };
type LogDay = { minutes: number[]; rooms: Array<{ room: string; pieces: Array<Cell & { minute: number }> }> };
export type RoomGraph = Record<string, Record<string, string>>;
export type HybridCandidate = {
	id: string;
	start: string;
	approach: string[];
	walk: string[];
	visits: Array<{ room: string; minute: number }>;
	startMinute: number;
	finishMinute: number;
	returnDirections: string[];
	returnMinute: number;
	toolBound: number;
};
export type HybridContext = { minute: number; tide: number; carried: number; fire: string; days: LogDay[]; candidates: HybridCandidate[]; examples?: string; deadlineMs?: number; remainingCalls?: number };
export type RoundEvaluation = { scores: Record<string, number>; costUsd: number; requests: number; models: string[]; probabilities?: Record<string, number>; excluded?: string[] };
export type RoundEvaluator = (context: HybridContext) => Promise<RoundEvaluation>;
export type HybridSubgoal = "collect" | "deliver" | "finish";
export type HybridGoalContext = HybridContext & { current: string; remainingCalls: number; returnNow: { minute: number; calls: number } };
export type SubgoalDecision = { goal: HybridSubgoal; costUsd: number; requests: number; models: string[] };
export type SubgoalSelector = (context: HybridGoalContext, allowed: HybridSubgoal[]) => Promise<SubgoalDecision>;
export type SubgoalRecord = { minute: number; carried: number; goal: HybridSubgoal; allowed: HybridSubgoal[] };
export type HybridRound = { tide: number; selected: string | null; candidates: HybridCandidate[]; scores: Record<string, number>; probabilities?: Record<string, number>; excluded?: string[] };
export type HybridResult = PlayerResult & { rounds: HybridRound[]; subgoals?: SubgoalRecord[] };
export class HybridEvaluationError extends Error {
	usage: Pick<RoundEvaluation, "costUsd" | "requests" | "models">;
	constructor(error: unknown, usage: Pick<RoundEvaluation, "costUsd" | "requests" | "models">) {
		super(error instanceof Error ? error.message : String(error));
		this.usage = usage;
	}
}
const OPPOSITE: Record<string, string> = { nord: "süd", süd: "nord", ost: "west", west: "ost" };

/** Shortest routes use only connections observed by crossing exits. */
export function hybridRoute(graph: RoomGraph, start: string, goal: string): string[] | null {
	const queue = [{ room: start, directions: [] as string[] }], seen = new Set([start]);
	for (const item of queue) {
		if (item.room === goal) return item.directions;
		for (const [direction, room] of Object.entries(graph[item.room] ?? {})) {
			if (seen.has(room)) continue;
			seen.add(room);
			queue.push({ room, directions: [...item.directions, direction] });
		}
	}
	return null;
}

/** Enumerate walks of at most five exits while all pickup visits precede the tide's expiry.
 * The shortlist rotates across visit counts, ordered by travel cost and room ids, never by estimated yield. */
export function hybridCandidates(graph: RoomGraph, cells: Record<string, Cell>, current: string, fire: string, now: number, tide: number, carried: number, remainingCalls: number, maxCandidates = 32): HybridCandidate[] {
	const unique = new Map<string, HybridCandidate>();
	for (const start of Object.keys(cells).sort()) {
		const approach = hybridRoute(graph, current, start);
		if (!approach) continue;
		const startMinute = Math.max(tide, now + approach.length * 5);
		if (startMinute >= tide + 30) continue;
		const visit = (room: string, walk: string[], visits: HybridCandidate["visits"]) => {
			const minute = startMinute + walk.length * 5;
			if (minute >= tide + 30) return;
			const nextVisits = cells[room] && !visits.some((v) => v.room === room) ? [...visits, { room, minute }] : visits;
			const back = hybridRoute(graph, room, fire);
			if (!back) return;
			const returnMinute = minute + back.length * 5;
			const waits = Math.ceil(Math.max(0, startMinute - now - approach.length * 5) / 120);
			// Each pickup uses at most look + move + take. Reserve the return, fire-adjacent move and one feed per piece.
			const toolBound = approach.length + waits + walk.length + nextVisits.length * 3 + back.length + 1 + carried + nextVisits.length;
			if (nextVisits.length && returnMinute <= 480 && toolBound <= remainingCalls) {
				const candidate: HybridCandidate = { id: "", start, approach, walk, visits: nextVisits, startMinute, finishMinute: minute, returnDirections: back, returnMinute, toolBound };
				const key = nextVisits.map((v) => v.room).join(",") + ":" + room;
				const previous = unique.get(key);
				if (!previous || candidate.toolBound < previous.toolBound) unique.set(key, candidate);
			}
			if (walk.length === 5) return;
			for (const [direction, next] of Object.entries(graph[room] ?? {})) visit(next, [...walk, direction], nextVisits);
		};
		visit(start, [], []);
	}
	const groups = new Map<number, HybridCandidate[]>();
	for (const candidate of unique.values()) {
		const size = candidate.visits.length;
		if (!groups.has(size)) groups.set(size, []);
		groups.get(size)!.push(candidate);
	}
	const ordered = [...groups.entries()].sort(([a], [b]) => a - b).map(([, candidates]) => candidates.sort((a, b) => a.toolBound - b.toolBound || JSON.stringify(a.visits).localeCompare(JSON.stringify(b.visits))));
	const result: HybridCandidate[] = [];
	for (let index = 0; result.length < maxCandidates; index++) {
		let added = false;
		for (const candidates of ordered) {
			if (!candidates[index] || result.length === maxCandidates) continue;
			result.push({ ...candidates[index]!, id: `c${result.length}` });
			added = true;
		}
		if (!added) break;
	}
	return result;
}

/** Empirical-rate control for exactly the same candidate generator and executor. */
export const empiricalRoundEvaluator: RoundEvaluator = async ({ days, candidates }) => {
	const hits: Record<string, number> = {};
	const trials = days.reduce((n, day) => n + day.minutes.length, 0);
	for (const day of days) for (const room of day.rooms) hits[room.room] = (hits[room.room] ?? 0) + room.pieces.length;
	return {
		scores: Object.fromEntries(candidates.map((candidate) => [candidate.id, candidate.visits.reduce((n, visit) => n + (hits[visit.room] ?? 0) / Math.max(1, trials), 0)])),
		costUsd: 0, requests: 0, models: ["empirical"],
	};
};

/** E[N] = sum(k=1..rooms) P(N >= k). Jev evaluates these atomic probability questions in batches of ten.
 * Timing and delivery feasibility are supplied by the planner. Only historical logbook data reach the model. */
export function jevRoundEvaluator(key: string, model: string, onUsage: (usd: number) => void, beforeRequest: () => void = () => {}, deliveryCheck = false): RoundEvaluator {
	return async (context) => {
		const questions: Array<[string, JevQuestion]> = [];
		for (const candidate of context.candidates) {
			if (deliveryCheck) questions.push([`${candidate.id}_delivery`, {
				type: "noul",
				instructions: `Can candidate ${candidate.id} collect its proposed pieces and return to the fire by world minute 480, with enough game-tool calls to deliver all carried and newly collected wood? Check its returnMinute and toolBound against the deadline and remainingCalls. This asks about feasibility, not the probability of finding wood.`,
			}]);
			for (let k = 1; k <= candidate.visits.length; k++) questions.push([`${candidate.id}_ge${k}`, {
				type: "noul",
				instructions: `For candidate ${candidate.id}, is at least ${k} NEW piece(s) of driftwood collected at this tide and deliverable to the fire? Infer the probability from the historical logbook. Every listed room is visited once before its piece expires. Each room gets zero or one piece per tide. Existing carried wood is excluded. Travel and delivery feasibility have already been checked.`,
			}]);
		}
		const scores = Object.fromEntries(context.candidates.map((candidate) => [candidate.id, 0]));
		const probabilities: Record<string, number> = {};
		const { deadlineMs, ...state } = context;
		let costUsd = 0, requests = 0;
		const models = new Set<string>();
		try {
			for (let start = 0; start < questions.length; start += 10) {
				const batch = questions.slice(start, start + 10);
				const ids = new Set(batch.map(([id]) => id.split("_")[0]));
				if (deadlineMs !== undefined && Date.now() >= deadlineMs) throw new Error("wall time limit");
				beforeRequest();
				requests++;
				const reply = await requestJev(key, model, { ...state, candidates: context.candidates.filter((candidate) => ids.has(candidate.id)) }, Object.fromEntries(batch), (usd) => {
					costUsd += usd;
					onUsage(usd);
				});
				models.add(reply.model);
				for (const [id] of batch) {
					const probability = reply.answers[id]?.noul;
					if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error(`Jev returned an invalid probability for ${id}`);
					probabilities[id] = probability;
					if (!id.endsWith("_delivery")) scores[id.split("_")[0]!]! += probability;
				}
			}
		} catch (error) {
			throw new HybridEvaluationError(error, { costUsd, requests, models: [...models] });
		}
		const excluded = deliveryCheck ? context.candidates.filter((candidate) => probabilities[`${candidate.id}_delivery`]! < 0.5).map((candidate) => candidate.id) : [];
		return { scores, costUsd, requests, models: [...models], probabilities, ...(deliveryCheck ? { excluded } : {}) };
	};
}

export async function playJevHybridEpisode(episode: BotEpisode, seed: number, evaluate: RoundEvaluator, options: { maxCalls?: number; maxMs?: number; maxCandidates?: number; examples?: string; subgoal?: SubgoalSelector; onStep?: (step: PlayerStep) => void } = {}): Promise<HybridResult> {
	const arena = toyArena(), started = Date.now();
	const world = String((await arena.ask("open", { rules: "shore", island: episode.island, start: episode.start, seed })).world);
	const history: PlayerStep[] = [], rounds: HybridRound[] = [], graph: RoomGraph = {}, cells: Record<string, Cell> = {};
	const maxCalls = Math.min(options.maxCalls ?? MAX_BOT_CALLS, MAX_BOT_CALLS), maxMs = options.maxMs ?? 600_000;
	let current = "", now = 0, held = 0, decisions = 0, costUsd = 0, end = "complete";
	let fire: (Cell & { room: string }) | null = null;
	const models = new Set<string>();
	const subgoals: SubgoalRecord[] = [];
	const checkTime = () => { if (Date.now() - started >= maxMs) throw new Error("wall time limit"); };
	const call = async (tool: Exclude<PlayerAction["tool"], "stop">, args: Record<string, unknown> = {}) => {
		checkTime();
		if (history.length >= maxCalls) throw new Error("tool limit");
		const step: PlayerStep = { action: { tool, args }, result: {} };
		history.push(step);
		try {
			step.result = await botCall(arena, world, tool, args);
			return step.result;
		} catch (error) {
			step.result = { error: error instanceof Error ? error.message : String(error) };
			throw error;
		} finally {
			options.onStep?.(step);
		}
	};
	const look = async () => {
		const view = await call("look");
		current = (view.room as { id: string }).id;
		graph[current] ??= {};
		const observedFire = (view.fires as Array<Cell>)[0];
		if (observedFire) fire = { room: current, ...observedFire };
		return view;
	};
	const go = async (direction: string) => {
		const from = current;
		const result = await call("act", { line: direction });
		current = (result.at as { room: string }).room;
		if (current === from) throw new Error("observed exit did not cross");
		now += 5;
		graph[current] ??= {};
		graph[from]![direction] = current;
		graph[current]![OPPOSITE[direction]!] = from;
	};
	const explore = async (view: Record<string, unknown>) => {
		for (const exit of view.exits as Array<{ name: string }>) {
			if (graph[current]![exit.name]) continue;
			const seen = new Set(Object.keys(graph));
			await go(exit.name);
			if (!seen.has(current)) await explore(await look());
			await go(OPPOSITE[exit.name]!);
		}
	};
	try {
		const first = await look();
		const book = await call("logbook");
		const days = book.days as LogDay[];
		for (const day of days) for (const room of day.rooms) if (room.pieces[0]) cells[room.room] = { x: room.pieces[0].x, y: room.pieces[0].y };
		await explore(first);
		if (!fire) throw new Error("no fire observed");
		const target = fire as Cell & { room: string };
		const deliver = async () => {
			const route = hybridRoute(graph, current, target.room);
			if (!route) throw new Error("no observed route to fire");
			for (const direction of route) await go(direction);
			await call("act", { line: `move ${target.x - 1} ${target.y}` });
			while (held > 0) { await call("act", { line: "lege holz ins feuer" }); held--; }
		};
		const tides = [30, 90, 150, 210, 270, 330, 390, 450];
		let tideIndex = 0;
		while (tideIndex < tides.length) {
			const tide = tides[tideIndex]!;
			const remainingCalls = maxCalls - history.length;
			const candidates = hybridCandidates(graph, cells, current, target.room, now, tide, held, remainingCalls, options.maxCandidates);
			if (!candidates.length && now >= tide + 30) { tideIndex++; continue; }
			const context: HybridContext = { minute: now, tide, carried: held, fire: target.room, days, candidates, ...(options.subgoal ? { remainingCalls } : {}), deadlineMs: started + maxMs, ...(options.examples ? { examples: options.examples } : {}) };
			if (options.subgoal) {
				const home = hybridRoute(graph, current, target.room);
				if (!home) throw new Error("no observed route to fire");
				const returnNow = { minute: now + home.length * 5, calls: home.length + 1 + held };
				const allowed: HybridSubgoal[] = [];
				if (candidates.length) allowed.push("collect");
				if (held > 0 && returnNow.minute <= 480 && returnNow.calls <= remainingCalls) allowed.push("deliver");
				allowed.push("finish");
				checkTime();
				const decision = await options.subgoal({ ...context, current, remainingCalls, returnNow }, allowed);
				decisions += decision.requests; costUsd += decision.costUsd;
				for (const model of decision.models) models.add(model);
				checkTime();
				if (!allowed.includes(decision.goal)) throw new Error("invalid subgoal");
				subgoals.push({ minute: now, carried: held, goal: decision.goal, allowed });
				if (decision.goal === "finish") break;
				if (decision.goal === "deliver") { await deliver(); continue; }
			}
			tideIndex++;
			if (!candidates.length) continue;
			checkTime();
			const evaluation = await evaluate(context);
			decisions += evaluation.requests; costUsd += evaluation.costUsd;
			for (const model of evaluation.models) models.add(model);
			checkTime();
			for (const candidate of candidates) if (!Number.isFinite(evaluation.scores[candidate.id])) throw new Error(`missing candidate score ${candidate.id}`);
			const ranked = candidates.filter((candidate) => !evaluation.excluded?.includes(candidate.id)).sort((a, b) => {
				const difference = evaluation.scores[b.id]! - evaluation.scores[a.id]!;
				if (Math.abs(difference) > 1e-9) return difference;
				return a.toolBound - b.toolBound || a.id.localeCompare(b.id);
			});
			const chosen = ranked[0];
			rounds.push({ tide, selected: chosen?.id ?? null, candidates, scores: evaluation.scores, ...(evaluation.probabilities ? { probabilities: evaluation.probabilities } : {}), ...(evaluation.excluded ? { excluded: evaluation.excluded } : {}) });
			if (!chosen) continue;
			for (const direction of chosen.approach) await go(direction);
			while (now < chosen.startMinute) {
				const minutes = Math.min(120, chosen.startMinute - now);
				await call("wait", { minutes }); now += minutes;
			}
			const visited = new Set<string>();
			const collect = async () => {
				if (visited.has(current) || !cells[current]) return;
				visited.add(current);
				const view = await look();
				const item = (view.things as Array<Cell & { name: string }>).find((thing) => /treibholz/i.test(thing.name));
				if (!item) return;
				await call("act", { line: `move ${item.x} ${item.y}` });
				const result = await call("act", { line: "nimm treibholz" });
				if ((result.said as string[]).includes("Du hebst Treibholz auf.")) held++;
			};
			await collect();
			for (const direction of chosen.walk) { await go(direction); await collect(); }
		}
		if (held > 0 || !options.subgoal) await deliver();
	} catch (error) {
		if (error instanceof HybridEvaluationError) {
			costUsd += error.usage.costUsd;
			decisions += error.usage.requests;
			for (const model of error.usage.models) models.add(model);
		}
		end = error instanceof Error ? error.message : String(error);
	}
	try {
		const score = await arena.ask("score", { world, goal: "feed:island:1" });
		return { episode: episode.id, island: episode.island!, seed, count: Number(score.count), calls: history.length, cost: history.length, decisions, costUsd, ms: Date.now() - started, end, history, models: [...models], rounds, ...(options.subgoal ? { subgoals } : {}) };
	} finally { arena.close(); }
}
