// A series of model runs on one task, for repeated comparisons (codemode-chat/docs/codemode-planning-summary.en.md, "Next experiments" 1):
// the same run settings, one session per run, with and without real tool answers in the prompt. It talks to a running
// codemode-chat server over its HTTP API as the admin (CODEMODE_ADMIN_TOKEN, sent as x-admin-token), keeps every
// finished session as JSON in --out and skips a run whose file is there already (under any --tag), so a series can be
// resumed. A run in which a scripted agent stood in for the model goes to --out/invalid and runs again once; two such
// runs in a row stop the series. Model runs cost tokens: started only by hand.
//   node --experimental-strip-types server/data/run-series.ts --base http://127.0.0.1:3790 --model openrouter/openai/gpt-6.1-sol \
//     --runs 10 [--from 1] [--conditions examples,plain] [--task tide-shores] [--parallel 2] [--budget-usd 5] --out DIR
//   node --experimental-strip-types server/data/run-series.ts --summary --out DIR
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2), opt = (k: string, d = "") => { const i = args.indexOf(k); return i >= 0 ? args[i + 1]! : d; };
const out = opt("--out");
if (!out) throw new Error("--out DIR is needed");
mkdirSync(out, { recursive: true });

type Contribution = { gen: number; via?: string; ok: boolean | null; passed: number; total: number; cost: number; source?: string; candidateId: string };
type Session = { run?: { active: boolean; solvedGen?: number; gen: number; note?: string; usage?: { tokens: number; costUsd: number } }; current: string; blocks: Array<{ blockId: string; contributions: Contribution[] }> };

/** One run's outcome, from its session. */
export function outcome(s: Session): { solvedGen: number | null; usd: number; tokens: number; contributions: number; fallbacks: number; winner: { gen: number; cost: number; candidateId: string } | null } {
	const b = s.blocks.find((x) => x.blockId === s.current), cs = (b?.contributions ?? []).filter((c) => c.ok !== null);
	const win = cs.filter((c) => c.passed === c.total).sort((x, y) => x.cost - y.cost)[0];
	return {
		solvedGen: s.run?.solvedGen ?? null, usd: s.run?.usage?.costUsd ?? 0, tokens: s.run?.usage?.tokens ?? 0, contributions: cs.length,
		fallbacks: cs.filter((c) => !(c.via ?? "").includes("/")).length,
		winner: win ? { gen: win.gen, cost: win.cost, candidateId: win.candidateId } : null,
	};
}

/** The Wilson score interval (95 %) of k successes in n. */
export function wilson(k: number, n: number, z = 1.96): [number, number] {
	if (!n) return [0, 1];
	const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), r = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
	return [Math.max(0, (c - r) / d), Math.min(1, (c + r) / d)];
}

function summary(): void {
	const files = readdirSync(out).filter((f) => f.endsWith(".json") && f !== "summary.json");
	const by: Record<string, Array<ReturnType<typeof outcome> & { run: string }>> = {};
	for (const f of files) {
		const cond = f.replace(/-\d+\.json$/, "").replace(/^.*?-(examples|plain)$/, "$1");
		(by[cond] ??= []).push({ run: f, ...outcome(JSON.parse(readFileSync(join(out, f), "utf8")) as Session) });
	}
	const rows: Record<string, unknown> = {};
	for (const [cond, rs] of Object.entries(by)) {
		const solved = rs.filter((r) => r.solvedGen !== null), [lo, hi] = wilson(solved.length, rs.length);
		const gens = solved.map((r) => r.solvedGen!).sort((a, b) => a - b), usd = rs.map((r) => r.usd);
		rows[cond] = { runs: rs.length, solved: solved.length, interval95: [Math.round(lo * 100) / 100, Math.round(hi * 100) / 100], solvedGens: gens, usdTotal: Math.round(usd.reduce((a, b) => a + b, 0) * 100) / 100, usdMean: Math.round(usd.reduce((a, b) => a + b, 0) / usd.length * 100) / 100, winnerCosts: solved.map((r) => r.winner?.cost), fallbacks: rs.reduce((a, r) => a + r.fallbacks, 0) };
		console.log(`${cond.padEnd(9)} ${solved.length}/${rs.length} solved (95 %: ${(lo * 100).toFixed(0)}–${(hi * 100).toFixed(0)} %), generations ${gens.join(" ") || "-"}, $${(rows[cond] as { usdTotal: number }).usdTotal} in all, scripted stand-ins ${(rows[cond] as { fallbacks: number }).fallbacks}`);
	}
	writeFileSync(join(out, "summary.json"), JSON.stringify(rows, null, 1));
}

async function series(): Promise<void> {
	const base = opt("--base", "http://127.0.0.1:3790"), model = opt("--model"), task = opt("--task", "tide-shores");
	const runs = Number(opt("--runs", "10")), from = Number(opt("--from", "1")), parallel = Number(opt("--parallel", "2")), budgetUsd = Number(opt("--budget-usd", "5"));
	const conditions = opt("--conditions", "examples,plain").split(","), token = process.env.CODEMODE_ADMIN_TOKEN;
	if (!model || !token) throw new Error("--model and CODEMODE_ADMIN_TOKEN are needed");
	const tag = opt("--tag") || model.split("/").pop()!.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
	const call = async (path: string, body?: unknown) => {
		const r = await fetch(base + path, body === undefined ? { headers: { "x-admin-token": token } } : { method: "POST", headers: { "x-admin-token": token, "content-type": "application/json" }, body: JSON.stringify(body) });
		const j = await r.json().catch(() => ({})) as Record<string, unknown>;
		if (!r.ok) throw new Error(`${path}: ${r.status} ${String(j.error ?? "")}`);
		return j;
	};
	// interleaved: run 1 of every condition, then run 2, … so a stopped series stays balanced
	const queue = Array.from({ length: runs - from + 1 }, (_, i) => conditions.map((c) => ({ c, i: from + i }))).flat();
	const one = async ({ c, i }: { c: string; i: number }) => {
		const sid = `${tag}-${c}-${i}`, file = join(out, `${sid}.json`);
		// done already, under this tag or another one (a series resumed under a new tag after its sessions were cut off)
		if (existsSync(file) || readdirSync(out).some((f) => f.endsWith(`-${c}-${i}.json`))) return;
		await call(`/api/sessions/${sid}/task`, { taskId: task });
		// the model list comes from the model process: right after it starts, a model may not be listed yet
		for (let attempt = 1; ; attempt++) {
			try { await call(`/api/sessions/${sid}/run`, { agents: 3, gens: 5, perAgent: 1, polish: 2, lang: "de", contenders: [model], budgetUsd, ...(c === "examples" ? { examples: "always" } : {}) }); break; }
			catch (e) { if (attempt >= 10 || !/Model not available/.test(String(e))) throw e; await new Promise((r) => setTimeout(r, 15_000)); }
		}
		for (;;) {
			await new Promise((r) => setTimeout(r, 30_000));
			const s = await call(`/api/sessions/${sid}`) as unknown as Session;
			if (s.run && !s.run.active) {
				const o = outcome(s);
				// a scripted stand-in means the model did not answer (an exhausted key, a limit): the run does not count,
				// is kept apart and runs again at the end of the queue; one such run can be a passing fault (an empty answer),
				// two in a row stop the series so that no more runs go the same way (an exhausted key, a limit)
				if (o.fallbacks) {
					mkdirSync(join(out, "invalid"), { recursive: true });
					writeFileSync(join(out, "invalid", `${sid}-${Date.now()}.json`), JSON.stringify(s));
					const why = `${sid}: ${o.fallbacks} scripted stand-ins (the model did not answer: ${s.run?.note ?? "see the session"}); kept apart in invalid/`;
					if (++invalidInRow >= 2) stopped = `${why}; the second in a row: series stopped`;
					else queue.push({ c, i });
					console.log(stopped || `${why}; runs again`);
					return;
				}
				invalidInRow = 0;
				writeFileSync(file, JSON.stringify(s));
				console.log(`${sid}: ${o.solvedGen ? `solved in generation ${o.solvedGen}` : "not solved"}, $${o.usd.toFixed(2)}, ${o.contributions} contributions${o.fallbacks ? `, ${o.fallbacks} scripted stand-ins` : ""}`);
				return;
			}
		}
	};
	let stopped = "", invalidInRow = 0;
	const workers = Array.from({ length: Math.max(1, parallel) }, async () => { for (let job = queue.shift(); job && !stopped; job = queue.shift()) await one(job); });
	await Promise.all(workers);
	summary();
}

if (args.includes("--summary")) summary(); else await series();
