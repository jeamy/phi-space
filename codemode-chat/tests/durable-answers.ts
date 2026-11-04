// `npm run test:durable`: the fake team of a room answers inside the agent worker (agent/test/durable-fake-models.ts).
// The worker sees only the prompt, so the call comes along as the [fake-call] line of server/durable-agent.ts; the team
// reaches the Space and its gates over a connection of the worker, and runs under `metered` with the worker's abort
// signal so that callSignal() means what it means in the model process.
import { metered } from "../server/llm.ts";
import { connectSpace } from "../server/space.ts";
import { FAKE_CALL } from "../server/durable-agent.ts";
import { MODELS, llmFor } from "./fakes.ts";

let conn: ReturnType<typeof connectSpace> | null = null;

export const modelLabels = () => [...MODELS, ...(process.env.CODEMODE_FAKE_MODELS ?? "").split(",").filter(Boolean)];

export async function answer(request: { system: string; signal?: AbortSignal }) {
	const line = request.system.split("\n").find((l) => l.startsWith(FAKE_CALL));
	if (!line) throw new Error("no fake call in the prompt");
	const { session, args } = JSON.parse(line.slice(FAKE_CALL.length)) as { session: string; args: unknown };
	conn ??= connectSpace(process.env.CODEMODE_SPACE);
	const space = conn.space;
	const log = async (e: Record<string, unknown>) => { await space.write({ type: "FakeCall", fields: { session, seq: Date.now() + Math.random(), ...e } as never }, null, 600_000); };
	const team = llmFor(session, { space, log });
	if (!team.contribute) throw new Error(`the fake team of room ${session} has no contribute`);
	const contribute = team.contribute;
	const m = await metered(() => contribute(args), request.signal);
	if (m.error !== undefined) throw m.error;
	const v = m.value as { source: string; note?: string; usage?: Record<string, number> };
	// always fenced: a blank source must reach the same check as in the model process
	return { text: `\`\`\`js\n${v.source}\n\`\`\`${v.note ? `\nNOTE: ${v.note}` : ""}`, ...(v.usage ? { usage: v.usage } : {}) };
}
