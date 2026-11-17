// A fresh final evaluation of "Shores of the tide" (step 9, codemode-chat/docs/codemode-planning-article.en.md): the stored winners
// and the scripted controls on islands that no selection or tuning ever looked at (234 to 433 by the same rule as the
// candidates: two rooms of odds 0.35 or more) and on seeds no run has met (8 to 15; every run and every earlier
// evaluation played 0 to 7), and, as a second set, the 95 earlier additional islands on the fresh seeds. The target of an
// island is the task's: 90 % of the reference plan's mean on the same seeds, rounded down to an eighth. No model call.
// With --series DIR (the sessions of server/data/run-series.ts) every winner of the series is evaluated as well.
//   node --experimental-strip-types server/data/shore-fresh.ts [--from 234] [--to 433] [--seed-from 8] [--series DIR] [--only-series] [--out FILE]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judge, loadCodemode } from "../judge.ts";
import { referenceBot, SHORE_BOTS, SHORE_EPISODES, shoreEpisodes } from "../shores.ts";
import { shoreTask } from "../tasks.ts";
import { shoreCandidates } from "./fetch-shore-jev.ts";

const args = process.argv.slice(2), opt = (k: string, d: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const seedFrom = Number(opt("--seed-from", "8")), out = opt("--out", "");
const fixture = (name: string) => readFileSync(new URL(`../../tests/fixtures/shores/${name}.js`, import.meta.url), "utf8");

/** The bots evaluated: the model winners kept as fixtures, and the scripted controls. */
const BOTS: Array<[string, string]> = [
	["gpt-examples", fixture("gpt-examples")], ["gpt", fixture("gpt")],
	["opus-examples", fixture("opus-examples")], ["opus", fixture("opus")], ["sonnet-examples", fixture("sonnet-examples")],
	["learner", SHORE_BOTS.learnerBot], ["uniform", SHORE_BOTS.uniformBot],
];
// the winners of a series: per run, the passing contribution with the fewest points
const seriesDir = opt("--series", "");
if (seriesDir) {
	if (args.includes("--only-series")) BOTS.length = 0;
	for (const f of readdirSync(seriesDir).filter((x) => x.endsWith(".json") && x !== "summary.json").sort()) {
		const s = JSON.parse(readFileSync(join(seriesDir, f), "utf8")) as { current: string; blocks: Array<{ blockId: string; contributions: Array<{ ok: boolean | null; passed: number; total: number; cost: number; source?: string }> }> };
		const win = (s.blocks.find((b) => b.blockId === s.current)?.contributions ?? []).filter((c) => c.ok !== null && c.passed === c.total && c.source).sort((a, b) => a.cost - b.cost)[0];
		if (win) BOTS.push([f.replace(/\.json$/, ""), win.source!]);
	}
}

const cm = (await loadCodemode())!;
const play = async (islands: number[], src: string): Promise<Array<{ mean: number; cost: number }>> => {
	const res: Array<{ mean: number; cost: number }> = [];
	for (let c = 0; c < islands.length; c += 12) {
		const chunk = islands.slice(c, c + 12), task = shoreTask(shoreEpisodes(chunk.map((k) => [k, 0]), []));
		task.bot!.seedFrom = seedFrom;
		const v = await judge(cm, task, src);
		if (!v.episodes || v.episodes.length !== chunk.length) throw new Error(`judge: ${v.error ?? "no episodes"}`);
		for (const e of v.episodes) res.push({ mean: e.mean ?? 0, cost: e.cost });
	}
	return res;
};

const chosen = new Set(SHORE_EPISODES.map((e) => e.island!));
const sets: Record<string, number[]> = {
	fresh: shoreCandidates(Number(opt("--from", "234")), Number(opt("--to", "433"))),
	earlier: shoreCandidates(34, 233).filter((n) => !chosen.has(n)),
};
const report: Record<string, unknown> = { seedFrom, seeds: 8, recorded: new Date().toISOString().slice(0, 10), sets: {} };
for (const [set, islands] of Object.entries(sets)) {
	const ref: Record<number, { mean: number; cost: number }> = {};
	for (const n of islands) ref[n] = (await play([n], referenceBot(n)))[0]!;
	const target = (n: number) => Math.floor(0.9 * ref[n]!.mean * 8) / 8;
	const bots: Record<string, unknown> = {};
	for (const [name, src] of BOTS) {
		const r = await play(islands, src), ratios = r.map((x, k) => x.mean / ref[islands[k]!]!.mean).sort((a, b) => a - b);
		const below = islands.filter((n, k) => r[k]!.mean < target(n));
		const q = (p: number) => Math.round(ratios[Math.min(ratios.length - 1, Math.floor(p * ratios.length))]! * 100) / 100;
		bots[name] = { below: below.length, belowIslands: below, min: q(0), median: q(0.5), max: q(1), meanCost: Math.round(r.reduce((s, x) => s + x.cost, 0) / r.length) };
		console.log(`${set} (${islands.length} islands) ${name.padEnd(16)} below ${String(below.length).padStart(3)}  ratio min ${q(0)} median ${q(0.5)} max ${q(1)}  mean cost ${(bots[name] as { meanCost: number }).meanCost}`);
	}
	(report.sets as Record<string, unknown>)[set] = { islands, referenceMeanCost: Math.round(islands.reduce((s, n) => s + ref[n]!.cost, 0) / islands.length), bots };
}
if (out) writeFileSync(out, JSON.stringify(report, null, 1));
process.exit(0);
