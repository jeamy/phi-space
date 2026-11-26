// Collects everything a live run left in the space into one JSON file, for the results page (tests/live/report.ts):
// the task and its sources, the roll call, the outlines and the pick, every version of each table's document with its
// sections (each section revision once), the checks, the discussion, the decisions, the objections, the ballots, the
// blind comparison, the result, the strategy stat, the paid calls and the room's lines. It only reads; run it against
// a stack started with FORUM_LLM=0 on the store of the runs. Not part of `npm test`.
//
//   node --experimental-strip-types tests/live/collect.ts --space tcp:127.0.0.1:4131 --room <room> --out <file.json> [--name <label>]
import { writeFile } from "node:fs/promises";
import { connectSpace } from "../../server/space.ts";

const args = process.argv.slice(2), one = (k: string, dflt = "") => { const i = args.lastIndexOf(`--${k}`); return i >= 0 && args[i + 1] ? args[i + 1]! : dflt; };
const room = one("room"), out = one("out");
if (!room || !out) throw new Error("--room ROOM --out FILE are needed");
const { space, close } = connectSpace(one("space", process.env.FORUM_SPACE));
const all = async (type: string, limit = 5000) => (await space.readAll({ type, fields: { session: room } }, { limit })).map((e) => { const { session: _s, ...f } = e.fields as Record<string, unknown>; return f; }).sort((a, b) => Number(a.ts ?? 0) - Number(b.ts ?? 0));
const TYPES = ["PlanTask", "PlanSource", "RollCall", "PlanOutline", "OutlinePick", "PlanDoc", "PlanSection", "PlanCheck", "PlanMessage", "PlanDecision", "PlanObjection", "PlanBallot", "PlanCompare", "PlanResult", "PlanAccept", "PlanStrategyStat", "ForumRunDone", "ForumLine", "Spend"];
const data: Record<string, unknown> = { name: one("name", room), room, collected: new Date().toISOString() };
for (const t of TYPES) data[t] = await all(t);
// the uploaded documents as the models could read them (a repository is named by its commit only)
data.SourceFile = (await all("SourceFile")).map((f) => ({ path: f.path, part: f.part, text: f.text }));
close();
await writeFile(out, JSON.stringify(data));
console.log(`${out}: ${TYPES.map((t) => `${(data[t] as unknown[]).length} ${t}`).join(", ")}`);
process.exit(0);
