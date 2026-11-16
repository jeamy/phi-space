// Evolving an algorithm from random contributions, judged in a codemode sandbox.
//
//   Host ──write──► CodeTask (goal: the first n primes, contract: `function firstPrimes(n)`)
//   Agents ──write──► CodeCandidate (JavaScript source + genome, random or a mutation of CodeBest)
//   Evaluators ──take under txn──► run the source in a QuickJS sandbox (no tools, nothing but pure computation)
//                  ──write (same txn)──► CodeScore (correct? how fast?)
//   Host ──write──► CodeBest when a correct candidate beats the best so far; agents mutate it next generation
//
// Like a Monte Carlo estimate, no single contribution has to be good: most random programs are slow or wrong, the
// space collects them, the sandbox judges them, and the population drifts toward efficient algorithms. The agents here
// are seeded random generators so the run needs no model; an LLM agent would write `source` instead of a genome.
// Entries are data: the evaluator never trusts a candidate, it only runs it in a sandbox that can reach no tool.
//
// Needs the `@earendil-works/pi-codemode` dependency; PI_CODEMODE_DIR overrides its location.
// Every contribution (agent, verdict, time, code) goes to a markdown log: --log FILE (default: a file in the temp directory).
// Run: node --experimental-strip-types examples/codemode-evolve.ts [--agents 6] [--gens 4] [--per-agent 2] [--n 100] [--seed 1]
import { appendFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../src/context.ts";
import { FOREVER, NO_WAIT, PhiSpaces, TransactionError, type SpaceHost, openOwnMemoryHost } from "../src/index.ts";

export type Genome = { engine: "trial" | "sieve"; cands: "all" | "odd" | "6k"; divisors: "all" | "half" | "sqrt" | "primes"; early: boolean; edge: "ok" | "off" };
export type Score = { candidateId: string; ok: boolean; ms: number; error?: string };
type Scored = Score & { genome?: Genome; source: string };
/** What an agent sees when it contributes, and what it hands in: JavaScript source (a genome only for the random agents). */
export type Best = { genome?: Genome; source: string; ms: number };
export type Contribution = { source: string; genome?: Genome };
export type Contributor = (c: { gen: number; agent: number; j: number; best: Best | null; n: number; rand: Rng }) => Promise<Contribution>;

export const TIME_N = 5000; // the efficiency measurement runs a larger instance than the correctness check
const TIMEOUT_MS = 6000; // too slow counts as failed, like a wrong answer
const HOUR = 3600_000;

/** Reference answer, computed on the host. */
export function firstPrimes(n: number): number[] {
	const p: number[] = [];
	for (let c = 2; p.length < n; c++) if (p.every((d) => d * d > c || c % d !== 0)) p.push(c);
	return p;
}

/** The program a genome stands for. `edge: "off"` plants an off-by-one that only some engines/bounds survive. */
export function genomeToSource(g: Genome): string {
	const off = g.edge === "off";
	if (g.engine === "sieve") {
		const bound = off ? "Math.ceil(n * Math.log(n)) + 10" : "Math.ceil(n * (Math.log(n) + Math.log(Math.log(n)))) + 10";
		return `function firstPrimes(n) {
	if (n < 1) return [];
	const lim = n < 6 ? 15 : ${bound}, s = new Uint8Array(lim + 1), p = [];
	for (let i = 2; i <= lim && p.length < n; i++) {
		if (s[i]) continue;
		p.push(i);
		for (let j = i * i; j <= lim; j += i) s[j] = 1;
	}
	return p;
}`;
	}
	const brk = g.early ? " break;" : "";
	const div = {
		all: `for (let d = 2; d < c; d++) if (c % d === 0) { ok = false;${brk} }`,
		half: `for (let d = 2; d ${off ? "<" : "<="} c / 2; d++) if (c % d === 0) { ok = false;${brk} }`,
		sqrt: `for (let d = 2; d * d ${off ? "<" : "<="} c; d++) if (c % d === 0) { ok = false;${brk} }`,
		primes: `for (const d of p) { if (d * d ${off ? ">=" : ">"} c) break; if (c % d === 0) { ok = false;${brk} } }`,
	}[g.divisors];
	const init = { all: "[]", odd: "[2]", "6k": "[2, 3]" }[g.cands];
	const start = { all: "2", odd: "3", "6k": "5" }[g.cands];
	const next = { all: "c++", odd: "c += 2", "6k": "c += c % 6 === 5 ? 2 : 4" }[g.cands];
	return `function firstPrimes(n) {
	const p = ${init};
	for (let c = ${start}; p.length < n; ${next}) {
		let ok = true;
		${div}
		if (ok) p.push(c);
	}
	return p.slice(0, n);
}`;
}

export type Rng = () => number;
/** Small deterministic generator, so a run is reproducible from its seed. */
export function rng(seed: number): Rng {
	let a = seed >>> 0;
	return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const pick = <T>(r: Rng, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
const GENES: { [K in keyof Genome]: readonly Genome[K][] } = { engine: ["trial", "trial", "trial", "trial", "trial", "trial", "trial", "sieve"], cands: ["all", "odd", "6k"], divisors: ["all", "half", "sqrt", "primes"], early: [true, false], edge: ["ok", "ok", "off"] };

export const randomGenome = (r: Rng): Genome => ({ engine: pick(r, GENES.engine), cands: pick(r, GENES.cands), divisors: pick(r, GENES.divisors), early: pick(r, GENES.early), edge: pick(r, GENES.edge) });
/** A contribution that builds on the best known genome by changing one gene (a random jump with probability 1/4). */
export function mutate(g: Genome, r: Rng): Genome {
	if (r() < 0.25) return randomGenome(r);
	const key = pick(r, Object.keys(GENES) as (keyof Genome)[]);
	return { ...g, [key]: pick(r, GENES[key] as readonly unknown[]) } as Genome;
}

type Sandbox = { execute(code: string): Promise<{ ok: boolean; value?: unknown; error?: { message: string } }>; close(): Promise<void> };
type CodemodeModule = { CodemodeSandbox: new (o: { timeoutMs: number; tools: [] }) => Sandbox };
/** Loads pi-codemode: PI_CODEMODE_DIR if set, else the dependency; null when it cannot be loaded. */
export async function loadCodemode(dir = process.env.PI_CODEMODE_DIR): Promise<CodemodeModule | null> {
	try {
		return (dir ? await import(pathToFileURL(`${dir}/dist/index.js`).href) : await import("@earendil-works/pi-codemode")) as CodemodeModule;
	} catch {
		return null;
	}
}

/**
 * Judge one candidate: the source runs in a fresh QuickJS sandbox without tools. It must return the first `n` primes
 * (checked against the reference) and is then timed on `TIME_N` primes.
 */
export async function evaluate(cm: CodemodeModule, source: string, n: number, candidateId = ""): Promise<Score> {
	const sandbox = new cm.CodemodeSandbox({ timeoutMs: TIMEOUT_MS, tools: [] });
	try {
		const r = await sandbox.execute(`${source}
const small = firstPrimes(${n});
const t = Date.now();
const big = firstPrimes(${TIME_N});
return { small, ms: Date.now() - t, len: big.length, last: big[big.length - 1] };`);
		if (!r.ok) return { candidateId, ok: false, ms: TIMEOUT_MS, error: r.error?.message ?? "failed" };
		const v = r.value as { small: number[]; ms: number; len: number; last: number };
		const ref = firstPrimes(n), refBig = firstPrimes(TIME_N);
		const ok = JSON.stringify(v.small) === JSON.stringify(ref) && v.len === TIME_N && v.last === refBig[TIME_N - 1];
		return { candidateId, ok, ms: v.ms, ...(ok ? {} : { error: "wrong result" }) };
	} catch (error) {
		return { candidateId, ok: false, ms: TIMEOUT_MS, error: (error as Error).message };
	} finally {
		await sandbox.close().catch(() => {});
	}
}

/** A role acting as conversation `id`: it owns what it writes, and only it can commit its transactions. */
export const role = (h: SpaceHost, id: number) => new PhiSpaces(h, ctx, Date.now, undefined, id);

/** Evaluator: take candidates one by one (each under a transaction), judge them, write the score atomically with the take. */
export async function evaluator(s: PhiSpaces, cm: CodemodeModule, runId: string, n: number): Promise<number> {
	let done = 0;
	for (;;) {
		const t = await s.createTransaction(TIMEOUT_MS + 30_000);
		const c = await s.take({ type: "CodeCandidate", fields: { runId } }, NO_WAIT, { txn: t.id });
		if (!c) { await s.abort(t.id); return done; }
		const f = c.fields as { candidateId: string; gen: number; source: string; genome?: Genome };
		const score = await evaluate(cm, f.source, n, f.candidateId);
		try {
			await s.write({ type: "CodeScore", fields: { runId, gen: f.gen, ...score, ...(f.genome ? { genome: f.genome } : {}), source: f.source } as never }, t.id, FOREVER);
			await s.commit(t.id);
			done++;
		} catch (error) {
			await s.abort(t.id).catch(() => {});
			if (!(error instanceof TransactionError)) throw error;
		}
	}
}

export type Generation = { gen: number; candidates: number; correct: number; bestMs: number | null; genome: Genome | null; candidateId: string | null };
export type Result = { best: Best | null; history: Generation[] };

/** One generation as markdown: per contribution the agent, verdict, time and the code the agent wrote. */
export function generationLog(gen: number, scores: Scored[], bestSource?: string): string {
	const rows = [...scores].sort((a, b) => a.candidateId.localeCompare(b.candidateId, undefined, { numeric: true }));
	const out = [`\n## Generation ${gen}: ${scores.filter((s) => s.ok).length}/${scores.length} correct\n`];
	for (const s of rows) {
		const agent = /-a(\d+)-/.exec(s.candidateId)?.[1] ?? "?";
		const verdict = s.ok ? `correct, ${s.ms} ms` : `FAILED (${s.error ?? "unknown"})`;
		out.push(`### ${s.candidateId} (agent ${agent}): ${verdict}${s.source === bestSource ? " [best so far]" : ""}`, s.genome ? `genome: \`${JSON.stringify(s.genome)}\`\n` : "", "```js", s.source, "```\n");
	}
	return out.join("\n");
}

/** The seeded random agents: 70 % mutate the best known genome, the rest start from scratch. */
export const randomContributor: Contributor = async ({ best, rand }) => {
	const genome = best?.genome && rand() < 0.7 ? mutate(best.genome, rand) : randomGenome(rand);
	return { genome, source: genomeToSource(genome) };
};

/** The whole experiment: generations of agent contributions, parallel evaluators, a growing CodeBest. */
export async function evolve(h: SpaceHost, cm: CodemodeModule, o: { agents?: number; gens?: number; perAgent?: number; n?: number; seed?: number; evaluators?: number; contributor?: Contributor; logFile?: string; log?: (m: string) => void } = {}): Promise<Result> {
	const { agents = 6, gens = 4, perAgent = 2, n = 100, seed = 1, evaluators = 3, contributor = randomContributor, logFile, log = () => {} } = o;
	const runId = `primes-${seed}`;
	const host = new PhiSpaces(h, ctx);
	const agentRoles = Array.from({ length: agents }, (_, i) => role(h, 100 + i));
	const judges = Array.from({ length: evaluators }, (_, i) => role(h, 200 + i));
	const rand = rng(seed);
	await host.write({ type: "CodeTask", fields: { runId, goal: `the first ${n} primes`, contract: "function firstPrimes(n): number[]" } }, null, FOREVER);

	if (logFile) writeFileSync(logFile, `# codemode-evolve ${runId}: the first ${n} primes\n\nEvery contribution of every agent, with the sandbox verdict. Time is for ${TIME_N} primes.\n`);
	let best: Result["best"] = null;
	const history: Generation[] = [];
	for (let gen = 0; gen < gens; gen++) {
		const known = best; // what the agents can read from CodeBest at the start of the generation
		let k = 0;
		await Promise.all(agentRoles.map(async (a, i) => {
			for (let j = 0; j < perAgent; j++) {
				const c = await contributor({ gen, agent: i, j, best: known, n, rand }).catch((e) => { log(`agent ${i} failed: ${(e as Error).message}`); return null; });
				if (!c) continue;
				await a.write({ type: "CodeCandidate", fields: { runId, gen, candidateId: `g${gen}-a${i}-${j}`, agent: i, ...(c.genome ? { genome: c.genome as never } : {}), source: c.source } as never }, null, HOUR);
				k++;
			}
		}));
		await Promise.all(judges.map((j) => evaluator(j, cm, runId, n)));
		const scores = (await host.readAll({ type: "CodeScore", fields: { runId, gen } }, { limit: 1000 })).map((e) => e.fields as unknown as Scored);
		const winners = scores.filter((s) => s.ok).sort((a, b) => a.ms - b.ms || a.source.length - b.source.length);
		const top = winners[0];
		if (top && (!best || top.ms < best.ms)) {
			best = { ...(top.genome ? { genome: top.genome } : {}), source: top.source, ms: top.ms };
			await host.write({ type: "CodeBest", fields: { runId, gen, candidateId: top.candidateId, ms: top.ms, ...(top.genome ? { genome: top.genome as never } : {}), source: top.source } as never }, null, FOREVER);
		}
		if (logFile) appendFileSync(logFile, generationLog(gen, scores, best?.source));
		history.push({ gen, candidates: k, correct: winners.length, bestMs: top?.ms ?? null, genome: top?.genome ?? null, candidateId: top?.candidateId ?? null });
		log(`gen ${gen}: ${winners.length}/${k} correct, fastest ${top ? `${top.ms} ms ${top.genome ? JSON.stringify(top.genome) : top.candidateId}` : "none"}`);
	}
	return { best, history };
}

async function main() {
	const arg = (name: string, d: number) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
	const argText = (name: string) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
	const cm = await loadCodemode();
	if (!cm) { console.log("pi-codemode not found (set PI_CODEMODE_DIR); skipping"); return; }
	const h = openOwnMemoryHost();
	const logFile = argText("log") ?? `${tmpdir()}/codemode-evolve-${Date.now()}.md`;
	const r = await evolve(h, cm, { agents: arg("agents", 6), gens: arg("gens", 4), perAgent: arg("per-agent", 2), n: arg("n", 100), seed: arg("seed", 1), logFile, log: console.log });
	console.log(`log: ${logFile}`);
	console.log(r.best ? `\nbest: ${r.best.ms} ms for ${TIME_N} primes${r.best.genome ? `, genome ${JSON.stringify(r.best.genome)}` : ""}\n\n${r.best.source}` : "\nno correct candidate");
	await h.close(ctx);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
