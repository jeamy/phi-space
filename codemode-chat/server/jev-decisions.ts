// Shared Decisions API transport. Usage is recorded before answer validation so rejected answers remain billable.
export type JevQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> } | { type: "noul"; instructions: string };
export type JevAnswers = Record<string, { choice?: string; noul?: number }>;

export async function requestJev(key: string, model: string, state: unknown, questions: Record<string, JevQuestion>, onUsage: (usd: number) => void) {
	const response = await fetch("https://openrouter.ai/api/alpha/decisions", {
		method: "POST",
		headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
		body: JSON.stringify({ model, state, questions }),
		signal: AbortSignal.timeout(60_000),
	});
	const data = await response.json() as { model?: string; answers?: JevAnswers; usage?: { cost?: number }; error?: { message?: string } };
	const costUsd = data.usage?.cost;
	if (typeof costUsd !== "number" || !Number.isFinite(costUsd) || costUsd < 0) throw new Error(`Jev returned no valid usage cost (HTTP ${response.status}); stop to preserve budget accounting`);
	onUsage(costUsd);
	if (!response.ok) throw new Error(`Jev HTTP ${response.status}: ${data.error?.message ?? "request failed"}`);
	if (!data.answers) throw new Error("Jev returned no answers");
	return { answers: data.answers, costUsd, model: data.model ?? model };
}
