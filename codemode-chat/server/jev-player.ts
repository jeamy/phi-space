// A direct Decisions-API player. The adapter offers individual tool calls derived only from prior tool answers.
// It keeps those answers as memory and supplies no probability estimator, route planner or action sequence.
import { BOT_COST, botCall, MAX_BOT_CALLS, type BotTool, type BotEpisode } from "./bottask.ts";
import { toyArena } from "./toyarena.ts";
import { requestJev } from "./jev-decisions.ts";

type Reply = Record<string, any>;
export type PlayerAction = { tool: "look" | "act" | "wait" | "logbook" | "stop"; args: Record<string, unknown> };
export type PlayerStep = { action: PlayerAction; result: Reply; proposal?: string };
export type PlayerState = { task: string; examples?: string; callsRemaining: number; history: PlayerStep[]; memory?: ReturnType<typeof playerMemory> };
export type Decision = { choice: string; costUsd: number; model: string; requests?: number; proposal?: string };
export type Decider = (state: PlayerState, actions: Record<string, PlayerAction>) => Promise<Decision>;

/** Movement destinations come from observed items, fire neighbours and logbook cells in the current room.
 * Directions stay available before a look. Stale observations remain explicitly historical. */
export function playerActions(history: PlayerStep[]): Record<string, PlayerAction> {
	const actions: Record<string, PlayerAction> = {
		look: { tool: "look", args: {} }, logbook: { tool: "logbook", args: {} },
		take: { tool: "act", args: { line: "nimm treibholz" } },
		feed: { tool: "act", args: { line: "lege holz ins feuer" } }, stop: { tool: "stop", args: {} },
	};
	for (const direction of ["nord", "ost", "süd", "west"]) actions[`go_${direction}`] = { tool: "act", args: { line: direction } };
	for (const minutes of [1, 5, 10, 15, 20, 25, 30, 45, 60, 90, 120]) actions[`wait_${minutes}`] = { tool: "wait", args: { minutes } };
	let room: string | undefined;
	for (const { action, result } of history) {
		if (action.tool === "look") room = result.room?.id;
		if (action.tool === "act" && result.at?.room) room = result.at.room;
	}
	const move = (x: number, y: number) => {
		if (Number.isInteger(x) && Number.isInteger(y) && x > 0 && y > 0) actions[`move_${x}_${y}`] = { tool: "act", args: { line: `move ${x} ${y}` } };
	};
	for (const { action, result } of history) {
		if (action.tool === "look" && result.room?.id === room) {
			for (const item of result.things ?? []) move(item.x, item.y);
			for (const fire of result.fires ?? []) {
				move(fire.x - 1, fire.y); move(fire.x + 1, fire.y);
				move(fire.x, fire.y - 1); move(fire.x, fire.y + 1);
			}
		}
		if (action.tool === "logbook") for (const day of result.days ?? []) {
			for (const entry of day.rooms ?? []) if (entry.room === room) for (const piece of entry.pieces ?? []) move(piece.x, piece.y);
		}
	}
	return actions;
}

/** A deterministic summary of observations, with no routes or arrival-rate estimates. */
export function playerMemory(history: PlayerStep[]) {
	let at: { room: string; x: number; y: number } | null = null;
	let minute = 0, carried = 0, delivered = 0;
	const rooms: Record<string, { observedMinute: number; observation: Reply }> = {};
	const connections: Record<string, Record<string, string>> = {};
	const reverse: Record<string, string> = { nord: "süd", ost: "west", süd: "nord", west: "ost" };
	for (const { action, result } of history) {
		if (action.tool === "look" && result.room?.id) {
			at = { room: result.room.id, ...result.at };
			carried = (result.pack ?? []).reduce((n: number, item: Reply) => n + Number(item.count ?? 0), 0);
		}
		if (action.tool === "act" && result.at?.room) {
			const crossed = (result.said ?? []).some((text: string) => text.startsWith("Du gehst nach "));
			const direction = String(action.args.line).replace(/^go /, "");
			if (crossed) {
				minute += 5;
				if (at && reverse[direction]) {
					(connections[at.room] ??= {})[direction] = result.at.room;
					(connections[result.at.room] ??= {})[reverse[direction]!] = at.room;
				}
			}
			at = { ...result.at };
			for (const text of result.said ?? []) {
				if (text === "Du hebst Treibholz auf.") carried++;
				if (text.startsWith("Du legst Treibholz ins ")) {
					carried--;
					delivered++;
				}
			}
		}
		const clock = /(?:Tag 1, )(\d+):(\d+)/.exec(String(result.time ?? ""));
		if (clock) minute = (Number(clock[1]) - 8) * 60 + Number(clock[2]);
		if (action.tool === "look" && result.room?.id) rooms[result.room.id] = { observedMinute: minute, observation: result };
	}
	return { at, minute, minutesRemaining: 480 - minute, carried, delivered, connections, rooms };
}

export function jevDecider(key: string, model: string, onUsage: (usd: number) => void = () => {}, review = false): Decider {
	const ask = async (state: unknown, actions: Record<string, PlayerAction>, instructions: string): Promise<Decision> => {
		const data = await requestJev(key, model, state, {
			action: {
				type: "choice", instructions,
				criteria: Object.fromEntries(Object.entries(actions).map(([id, action]) => [id, JSON.stringify(action)])),
			},
		}, onUsage);
		const choice = data.answers.action?.choice;
		if (!choice || !actions[choice]) throw new Error("Jev returned an invalid action");
		return { choice, costUsd: data.costUsd, model: data.model, requests: 1 };
	};
	return async (state, actions) => {
		const proposal = await ask(state, actions, "Wähle genau den nächsten Tool-Aufruf, um bis Tagesende möglichst viel Holz ins Feuer zu liefern. Plane anhand der bisherigen Antworten. stop beendet den Lauf endgültig. Jeder andere Aufruf kostet einen Punkt. Frühere look-Antworten können veraltet sein. Die angebotenen Aktionen sind einzelne Aufrufe, keine fertigen Strategien.");
		if (!review) return proposal;
		const checked = await ask({ ...state, proposedAction: { id: proposal.choice, action: actions[proposal.choice] } }, actions,
			"Prüfe die vorgeschlagene Aktion und wähle die endgültige nächste Aktion aus demselben Menü. Berücksichtige Standort, beobachtete Verbindungen, getragenes Holz, verbleibende Spielzeit und die notwendige Ablieferung am Feuer. Du darfst den Vorschlag beibehalten oder ersetzen. Wähle stop nur, wenn keine weitere Lieferung mehr möglich ist. Es zählt ins Feuer geliefertes Holz.");
		return { ...checked, costUsd: proposal.costUsd + checked.costUsd, requests: 2, proposal: proposal.choice };
	};
}

export type PlayerResult = { episode: string; island: number; seed: number; count: number; calls: number; cost: number; decisions: number; costUsd: number; ms: number; end: string; history: PlayerStep[]; models: string[] };

export async function playJevEpisode(episode: BotEpisode, seed: number, prompt: string, decide: Decider, options: { examples?: string; maxMs?: number; maxCalls?: number; memory?: boolean; onStep?: (step: PlayerStep) => void } = {}): Promise<PlayerResult> {
	const arena = toyArena(), started = Date.now();
	const world = String((await arena.ask("open", { rules: "shore", island: episode.island, start: episode.start, seed })).world);
	const history: PlayerStep[] = [], models = new Set<string>();
	let cost = 0, decisions = 0, costUsd = 0, end = "tool limit";
	const maxCalls = Math.min(options.maxCalls ?? MAX_BOT_CALLS, MAX_BOT_CALLS);
	try {
		while (history.length < maxCalls) {
			if (Date.now() - started >= (options.maxMs ?? 600_000)) { end = "wall time limit"; break; }
			const actions = playerActions(history);
			const decision = await decide({ task: prompt, ...(options.examples ? { examples: options.examples } : {}), callsRemaining: maxCalls - history.length, history, ...(options.memory ? { memory: playerMemory(history) } : {}) }, actions);
			decisions += decision.requests ?? 1; costUsd += decision.costUsd; models.add(decision.model);
			const action = actions[decision.choice];
			if (!action) throw new Error("invalid action");
			if (action.tool === "stop") { end = "stop"; break; }
			cost += BOT_COST[action.tool as BotTool];
			let result: Reply;
			try { result = await botCall(arena, world, action.tool, action.args); }
			catch (error) { result = { error: String(error) }; }
			const step = { action, result, ...(decision.proposal ? { proposal: decision.proposal } : {}) };
			history.push(step); options.onStep?.(step);
		}
	} catch (error) { end = String(error); }
	const score = await arena.ask("score", { world, goal: "feed:island:1" });
	arena.close();
	return { episode: episode.id, island: episode.island!, seed, count: Number(score.count), calls: history.length, cost, decisions, costUsd, ms: Date.now() - started, end, history, models: [...models] };
}
