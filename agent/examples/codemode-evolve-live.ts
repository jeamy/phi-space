// codemode-evolve with real model agents: every contribution is JavaScript written by a model (Mistral by default).
// The evaluators are unchanged: whatever a model writes is data and runs only in the sandbox, which can reach no tool.
// Costs tokens (about 600 per contribution, agents x generations x per-agent calls), so ask before running it.
//
// Run: node --experimental-strip-types agent/examples/codemode-evolve-live.ts [--agents 4] [--gens 3] [--per-agent 1] [--n 100] [--log FILE]
// PI_PROVIDER / PI_MODEL pick another model; the default is the first Mistral model (codestral-latest if present).
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../src/context.ts";
import { evolve, loadCodemode, TIME_N, type Contributor } from "../../examples/codemode-evolve.ts";
import { liveModels } from "../src/live-models.ts";
import { openOwnMemoryHost } from "../../src/index.ts";

/** Different temperaments keep the contributions from collapsing onto one answer. */
const STYLES = [
	"You favour the simplest correct code.",
	"You favour the algorithm with the best asymptotic running time.",
	"You favour tight inner loops and typed arrays; micro-optimise.",
	"You like unusual ideas, but the result must stay correct.",
];

/** Pull the program out of a model answer: the first fenced block, else the whole text. */
export function extractCode(text: string): string {
	const m = /```(?:js|javascript|ts|typescript)?\s*\n([\s\S]*?)```/i.exec(text);
	return (m ? m[1]! : text).trim();
}

export async function mistralContributor(): Promise<{ contributor: Contributor; label: string; usage: () => { calls: number; tokens: number } }> {
	const { models } = await liveModels();
	const avail: readonly any[] = await models.getAvailable();
	const wanted = process.env.PI_MODEL?.toLowerCase();
	const provider = process.env.PI_PROVIDER ?? "mistral";
	const pool = avail.filter((m) => m.provider === provider);
	const model = (wanted && pool.find((m) => String(m.id).toLowerCase() === wanted)) || pool.find((m) => String(m.id).toLowerCase() === "codestral-latest") || pool[0];
	if (!model) throw new Error(`no ${provider} model available (credentials in ~/.pi/agent/auth.json or the environment)`);
	let calls = 0, tokens = 0;
	const contributor: Contributor = async ({ gen, agent, best, n }) => {
		const prompt = `Task: write a JavaScript function \`firstPrimes(n)\` that returns an array of the first n prime numbers (firstPrimes(${n}) is checked, and the speed is timed with n = ${TIME_N}).
Rules: plain JavaScript (QuickJS), no imports, no I/O, no timers. Only the code runs, nothing else; output exactly one \`\`\`js block and no explanation.
${best ? `The fastest correct solution so far takes ${best.ms} ms for n = ${TIME_N}:\n\`\`\`js\n${best.source}\n\`\`\`\nBeat it: make it faster, or find a different way. It must stay correct.` : "No solution exists yet: write a first one."}`;
		const res: any = await models.completeSimple(model, {
			systemPrompt: `You are contributor ${agent} (generation ${gen}) in a swarm that evolves an algorithm through a shared space. ${STYLES[agent % STYLES.length]}`,
			messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
		}, { maxTokens: 900, signal: AbortSignal.timeout(60_000) });
		const text = (res?.content ?? []).filter((c: any) => c?.type === "text").map((c: any) => c.text).join("");
		calls++; tokens += (res?.usage?.input ?? 0) + (res?.usage?.output ?? 0);
		if (!text.trim()) throw new Error(res?.errorMessage ?? "empty answer");
		return { source: extractCode(text) };
	};
	return { contributor, label: `${model.provider}/${model.id}`, usage: () => ({ calls, tokens }) };
}

async function main() {
	const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
	const logAt = process.argv.indexOf("--log");
	const logFile = logAt > 0 ? process.argv[logAt + 1]! : `${tmpdir()}/codemode-evolve-live-${Date.now()}.md`;
	const cm = await loadCodemode();
	if (!cm) { console.log("pi-codemode not found; skipping"); return; }
	const { contributor, label, usage } = await mistralContributor();
	console.log(`agents: ${label}`);
	const h = openOwnMemoryHost();
	const r = await evolve(h, cm, { agents: arg("agents", 4), gens: arg("gens", 3), perAgent: arg("per-agent", 1), n: arg("n", 100), seed: 1, contributor, logFile, log: console.log });
	console.log(`log: ${logFile}`);
	const u = usage();
	console.log(`\n${u.calls} model calls, ${u.tokens} tokens`);
	console.log(r.best ? `best: ${r.best.ms} ms for ${TIME_N} primes\n\n${r.best.source}` : "no correct candidate");
	await h.close(ctx);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
