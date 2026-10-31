// `npm run test:durable`: the scripted model of the test (SPACES_MMO_LLM_MODULE) answers inside the agent worker
// (agent/test/durable-fake-models.ts).
import { join } from "node:path";
import { ROOT } from "../server/env.ts";

export const modelLabels = () => ["scripted/scripted"];

export async function answer(request: { system: string; user: string }) {
	const module = process.env.SPACES_MMO_LLM_MODULE;
	if (!module) throw new Error("no scripted model named");
	const { complete } = await import(join(ROOT, module)) as { complete: (system: string, user: string) => Promise<string> };
	return { text: await complete(request.system, request.user) };
}
