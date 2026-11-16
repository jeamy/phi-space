// Explicit subgoal choice for the workflow policy. The planner supplies arithmetic and legal options.
import { requestJev } from "./jev-decisions.ts";
import { HybridEvaluationError, type SubgoalSelector, type HybridSubgoal } from "./jev-hybrid.ts";

export function jevSubgoalSelector(key: string, model: string, onUsage: (usd: number) => void, beforeRequest: () => void = () => {}): SubgoalSelector {
	return async (context, allowed) => {
		let costUsd = 0, requests = 0;
		const models: string[] = [];
		try {
			if (context.deadlineMs !== undefined && Date.now() >= context.deadlineMs) throw new Error("wall time limit");
			beforeRequest();
			requests++;
			const descriptions: Record<HybridSubgoal, string> = {
				collect: "Collect new wood at the next considered tide using a feasible candidate round, then decide again.",
				deliver: "Return to the fire and deliver all currently carried wood now, then decide again about collecting.",
				finish: "End the day now. The executor delivers any carried wood first. No more tides will be collected.",
			};
			const reply = await requestJev(key, model, {
				minute: context.minute, nextTide: context.tide, carried: context.carried,
				remainingCalls: context.remainingCalls, returnNow: context.returnNow,
				currentRoom: context.current, fireRoom: context.fire,
				feasibleRounds: context.candidates.length,
				rules: { dayEnds: 480, exitMinutes: 5, woodLifetimeMinutes: 30, carryingCapacity: "unlimited", carriedWoodExpires: false, tideMinutes: [30, 90, 150, 210, 270, 330, 390, 450] },
			}, {
				subgoal: {
					type: "choice",
					instructions: "Choose the next subgoal to maximize the total wood delivered into the fire by the end of the day. Only delivered wood earns reward. Time advances when crossing exits or waiting. The code supplies feasible routes and reserves delivery time and calls. Choose among the available subgoals.",
					criteria: Object.fromEntries(allowed.map((goal) => [goal, descriptions[goal]])),
				},
			}, (usd) => { costUsd += usd; onUsage(usd); });
			models.push(reply.model);
			const goal = reply.answers.subgoal?.choice as HybridSubgoal | undefined;
			if (!goal || !allowed.includes(goal)) throw new Error("Jev returned an invalid subgoal");
			return { goal, costUsd, requests, models };
		} catch (error) { throw new HybridEvaluationError(error, { costUsd, requests, models }); }
	};
}
