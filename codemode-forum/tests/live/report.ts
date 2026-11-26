// The results page of the live runs: one static page (tests/live/report.html) and, beside it, one data file per run,
// made from what tests/live/collect.ts took out of the space. The page shows each run step by step: the task, the
// kickoff, the outlines, the first draft, every round with its objections, revisions and ballots, the blind
// comparison, the final round and the result, and every version of both documents with the difference between any
// two. Not part of `npm test`.
//
//   node --experimental-strip-types tests/live/report.ts --out <dir> [--title "…"] [--notes <notes.json>] <collected.json>...
//
// `--notes`: a JSON file with what the page says around the runs (the concept, the baseline, what was changed after
// which run); see docs/live/notes.json.
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIXED_CRITERIA } from "../../server/plantask.ts";

const args = process.argv.slice(2), flags = new Map<string, string>(), files: string[] = [];
for (let i = 0; i < args.length; i++) { if (args[i]!.startsWith("--")) flags.set(args[i]!.slice(2), args[++i] ?? ""); else files.push(args[i]!); }
const out = flags.get("out");
if (!out || !files.length) throw new Error("--out DIR and at least one collected JSON file are needed");
type Row = Record<string, any>;
/** An entry without the fields that are the same for the whole run or only matter inside the space. */
const lean = (r: Row) => { const { session: _s, blockId: _b, slot: _l, ip: _i, admin: _a, day: _d, ...rest } = r; return rest; };

await mkdir(join(out, "data"), { recursive: true });
const index: Row[] = [];
for (const file of files) {
	const d = JSON.parse(await readFile(file, "utf8")) as Row;
	const task = d.PlanTask[0] ?? {}, done = d.ForumRunDone.at(-1) ?? {}, info = done.info ?? {};
	// every revision of a section once, by its hash; a version names its sections by hash
	const texts: Record<string, Row> = {};
	for (const s of d.PlanSection as Row[]) texts[s.hash] = { text: s.text, model: s.model, sectionId: s.sectionId, rev: s.rev, table: s.table, ...(s.origin ? { origin: s.origin } : {}), ts: s.ts };
	const versions = (d.PlanDoc as Row[]).map((v) => ({ table: v.table, version: v.version, model: v.model, changed: v.changed, bytes: v.bytes, ts: v.ts, sections: v.sections.map((s: Row) => [s.sectionId, s.title, s.hash, s.rev]) })).sort((a, b) => a.table.localeCompare(b.table) || a.version - b.version);
	// what each paid call cost, by model and by kind
	const cost: Record<string, Record<string, { calls: number; tokens: number; usd: number }>> = {};
	for (const s of d.Spend as Row[]) { const m = (cost[s.model] ??= {}), k = (m[s.kind] ??= { calls: 0, tokens: 0, usd: 0 }); k.calls++; k.tokens += s.tokens; k.usd += s.costUsd; }
	const run: Row = {
		name: d.name, room: d.room, runId: info.runId ?? done.runId, collected: d.collected,
		task: { brief: task.brief, lang: task.lang, outline: task.outline, criteria: [...FIXED_CRITERIA, ...(task.criteria ?? [])] },
		sources: (d.PlanSource as Row[]).map(lean), documents: (d.SourceFile as Row[]).sort((a, b) => a.path.localeCompare(b.path) || a.part - b.part),
		info: { models: info.models, aliases: info.aliases, rounds: info.rounds, perModel: info.perModel, budget: info.budget, usage: info.usage, tables: info.tables, startedAt: d.ForumLine[0]?.ts, endedAt: done.ts },
		how: done.how, lines: (d.ForumLine as Row[]).map((l) => ({ text: l.text, ts: l.ts })),
		rollcall: (d.RollCall as Row[]).map(lean), outlines: (d.PlanOutline as Row[]).map(lean), picks: (d.OutlinePick as Row[]).map(lean),
		versions, texts, checks: (d.PlanCheck as Row[]).map((c) => ({ table: c.table, version: c.version, ok: c.ok, failures: c.failures, counted: c.counted })),
		messages: (d.PlanMessage as Row[]).map(lean), decisions: (d.PlanDecision as Row[]).map(lean), objections: (d.PlanObjection as Row[]).map(lean), ballots: (d.PlanBallot as Row[]).map(lean),
		compares: (d.PlanCompare as Row[]).map(lean), result: (d.PlanResult as Row[]).map(lean)[0] ?? null, accepted: (d.PlanAccept as Row[]).map(lean), stat: (d.PlanStrategyStat as Row[]).map(lean)[0] ?? null, cost,
	};
	const name = basename(file).replace(/\.json$/, "");
	await writeFile(join(out, "data", `${name}.json`), JSON.stringify(run));
	index.push({ file: `data/${name}.json`, name: d.name, brief: task.brief?.slice(0, 160), startedAt: run.info.startedAt, endedAt: run.info.endedAt, usage: info.usage, stat: run.stat, result: run.result, tables: info.tables });
}
const notes = flags.get("notes") ? JSON.parse(await readFile(flags.get("notes")!, "utf8")) : {};
await writeFile(join(out, "data", "index.json"), JSON.stringify({ title: flags.get("title") ?? notes.title ?? "codemode-forum", made: new Date().toISOString(), notes, runs: index }));
await copyFile(join(dirname(fileURLToPath(import.meta.url)), "report.html"), join(out, "index.html"));
console.log(`${join(out, "index.html")}: ${index.length} runs`);
