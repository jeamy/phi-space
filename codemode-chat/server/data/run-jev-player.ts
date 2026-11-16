// Direct and hybrid players on the series' tide-shores islands and seeds.
// Unlike run-series.ts, this evaluates a fixed decision policy, with no code-writing generations or winner selection.
// Live calls require explicit authorization. Direct policies choose actions; the hybrid scores tide rounds.
// Game tools retain the 300-call limit.
// node --experimental-strip-types server/data/run-jev-player.ts --out DIR [--conditions examples,plain]
//   [--policy raw|memory|review|hybrid|hybrid-workflow|hybrid-empirical] [--max-candidates 32] [--runs 1] [--seeds 8] [--budget-usd 5] [--max-ms 600000] [--model typesafe/jev-1.13]
// Results and incremental decision traces are checkpointed. Existing results are resumed only with matching config.
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { loadDotEnv } from "../env.ts";
import { episodeSeed } from "../bottask.ts";
import { shoreTask } from "../tasks.ts";
import { toolExamples } from "../examples.ts";
import { jevDecider, playJevEpisode, type PlayerResult, type PlayerStep } from "../jev-player.ts";
import { jevSubgoalSelector } from "../jev-workflow.ts";
import { empiricalRoundEvaluator, jevRoundEvaluator, playJevHybridEpisode } from "../jev-hybrid.ts";

loadDotEnv();
const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => args.includes(name) ? args[args.indexOf(name) + 1]! : fallback;
const out = opt("--out", "");
if (!out) throw new Error("--out DIR is required");
const config = {
	model: opt("--model", "typesafe/jev-1.13"), conditions: opt("--conditions", "examples,plain").split(","),
	runs: Number(opt("--runs", "1")), seeds: Number(opt("--seeds", "8")), budgetUsd: Number(opt("--budget-usd", "5")),
	maxMs: Number(opt("--max-ms", "600000")), maxCalls: Number(opt("--max-calls", "300")), policy: opt("--policy", "raw"), maxCandidates: Number(opt("--max-candidates", "32")), protocol: 1,
};
if (!["raw", "memory", "review", "hybrid", "hybrid-workflow", "hybrid-empirical"].includes(config.policy)) throw new Error("invalid policy");
if (!config.conditions.length || config.conditions.some((c) => !["examples", "plain"].includes(c)) || new Set(config.conditions).size !== config.conditions.length) throw new Error("invalid conditions");
for (const n of [config.runs, config.seeds, config.maxMs, config.maxCalls, config.maxCandidates]) if (!Number.isInteger(n) || n < 1) throw new Error("positive integer settings required");
if (config.maxCandidates > 128) throw new Error("at most 128 candidates");
if (config.seeds > 8 || config.maxCalls > 300 || !Number.isFinite(config.budgetUsd) || config.budgetUsd <= 0) throw new Error("invalid limits");
const key = process.env.JEV_OPENROUTER_API_KEY;
if (!key && config.policy !== "hybrid-empirical") throw new Error("JEV_OPENROUTER_API_KEY is required");
mkdirSync(out, { recursive: true });
const configFile = join(out, "config.json");
if (existsSync(configFile)) {
	const previous = JSON.parse(readFileSync(configFile, "utf8"));
	previous.policy ??= "raw";
	previous.maxCandidates ??= 32;
	if (Object.entries(config).some(([name, value]) => JSON.stringify(previous[name]) !== JSON.stringify(value))) throw new Error("output configuration differs; use a new directory");
}
writeFileSync(configFile, JSON.stringify(config, null, 2));
const ledger = join(out, "usage.jsonl");
let spent = existsSync(ledger) ? readFileSync(ledger, "utf8").split("\n").filter(Boolean).reduce((n, line) => n + Number(JSON.parse(line).usd), 0) : 0;
const task = shoreTask(), examples = await toolExamples(task);
// Keep the German task description used by the series, replacing only its code-writing instruction.
const prompt = task.prompt.de.replace("Aufgabe: Schreibe async function bot().", "Aufgabe: Steuere die Figur direkt durch Auswahl einzelner Tool-Aufrufe.")
	+ "\nDu erhältst die bisherigen Tool-Aufrufe mit ihren Antworten als Gedächtnis. Wähle den nächsten Aufruf. Beende erst, wenn du kein weiteres Holz liefern kannst. Die Menüeinträge enthalten keine Routenplanung. Du kannst im aktuellen Raum zu beobachteten Holzstellen und neben beobachtete Feuer gehen.";
const summaries: unknown[] = [];
let stopped = false;
for (let run = 1; run <= config.runs && !stopped; run++) {
	for (const condition of config.conditions) {
		const results: PlayerResult[] = [];
		let samplePositive = false;
		for (const episode of task.bot!.episodes!) {
			if (episode.kind === "holdout" && !samplePositive) continue;
			for (let index = 0; index < config.seeds; index++) {
				const seed = episodeSeed(episode.island!, index), id = `${condition}-${run}-${episode.id}-${seed}`;
				const file = join(out, `${id}.json`);
				let result: PlayerResult;
				if (existsSync(file)) result = JSON.parse(readFileSync(file, "utf8"));
				else {
					if (spent >= config.budgetUsd) { stopped = true; break; }
					const onUsage = (usd: number) => {
						spent += usd;
						appendFileSync(ledger, JSON.stringify({ id, usd, totalUsd: spent, ts: new Date().toISOString() }) + "\n");
					};
					const beforeRequest = () => { if (spent >= config.budgetUsd) throw new Error("series budget reached"); };
					const options = {
						maxMs: config.maxMs, maxCalls: config.maxCalls,
						...(condition === "examples" && examples ? { examples } : {}),
						onStep: (step: PlayerStep) => appendFileSync(join(out, `${id}.trace.jsonl`), JSON.stringify(step) + "\n"),
					};
					if (config.policy.startsWith("hybrid")) {
						const evaluate = config.policy === "hybrid-empirical" ? empiricalRoundEvaluator : jevRoundEvaluator(key!, config.model, onUsage, beforeRequest, config.policy === "hybrid-workflow");
						result = await playJevHybridEpisode(episode, seed, evaluate, { ...options, maxCandidates: config.maxCandidates, ...(config.policy === "hybrid-workflow" ? { subgoal: jevSubgoalSelector(key!, config.model, onUsage, beforeRequest) } : {}) });
					} else {
						const ask = jevDecider(key!, config.model, onUsage, config.policy === "review");
						result = await playJevEpisode(episode, seed, prompt, async (state, actions) => {
							beforeRequest();
							return ask(state, actions);
						}, { ...options, memory: config.policy !== "raw" });
					}
					writeFileSync(file + ".tmp", JSON.stringify(result)); renameSync(file + ".tmp", file);
					console.log(`${id}: wood=${result.count}, tools=${result.calls}, decisions=${result.decisions}, $${result.costUsd.toFixed(5)}, ${Math.round(result.ms / 1000)}s, end=${result.end}`);
				}
				results.push(result);
				if (episode.kind === "sample" && result.count > 0) samplePositive = true;
				// API failures and budget exhaustion invalidate the series; game/tool limits remain measured outcomes.
				if (!["stop", "complete", "tool limit", "wall time limit"].includes(result.end)) { stopped = true; break; }
			}
			if (stopped) break;
		}
		const episodes = task.bot!.episodes!.map((episode) => {
			const rs = results.filter((r) => r.episode === episode.id), mean = rs.length ? rs.reduce((n, r) => n + r.count, 0) / rs.length : null;
			return { id: episode.id, island: episode.island, seeds: rs.length, mean, target: episode.target, reached: rs.length === 8 && mean !== null && mean >= episode.target!, skipped: !stopped && episode.kind === "holdout" && !samplePositive };
		});
		summaries.push({ condition, run, status: stopped ? "interrupted" : "complete", comparableSeeds: config.seeds === 8, episodes, reached: episodes.filter((e) => e.reached).length, costUsd: results.reduce((n, r) => n + r.costUsd, 0), tools: results.reduce((n, r) => n + r.calls, 0), decisions: results.reduce((n, r) => n + r.decisions, 0), ms: results.reduce((n, r) => n + r.ms, 0) });
		writeFileSync(join(out, "summary.json"), JSON.stringify({ config, spentUsd: spent, runs: summaries, comparison: "Fixed direct player; raw uses history, memory adds a deterministic observation summary, review adds a second API action choice; hybrid ranks feasible tide rounds with Jev, hybrid-workflow adds model subgoals and a delivery-feasibility probability gate at 0.5; hybrid-empirical uses counted rates on the identical candidates and executor; no generated code, agents or generations. Action menu derived from observed cells. 600-second default trajectory wall limit differs from the generated bots' 10-second local execution limit. Dollar budget covers the entire series; a final in-flight request may exceed it." }, null, 2));
		if (stopped) break;
	}
}
console.log(`Series ${stopped ? "interrupted" : "complete"}; ledger cost $${spent.toFixed(5)}; ${out}`);
if (stopped) process.exitCode = 1;
