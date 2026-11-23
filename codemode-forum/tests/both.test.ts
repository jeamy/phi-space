// A run with both tables: table A (the models take turns) and table B (all write at the same time) work on the same
// brief at the same time, each on its share of the budget. Then every model compares the two documents blind, the
// preferred one is the base, and a joint final round works in what the other does better. A final round that does
// not agree leaves the base as the result; a section taken over names where it comes from.
import test from "node:test";
import assert from "node:assert/strict";
import type { PlanView, Snapshot } from "../server/hub.ts";
import { baseOf, parseCompare, pointsFor, sides, type PlanCompare, type PlanStrategyStat } from "../server/compare.ts";
import { takeoverOf } from "../server/talk.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan how the world gets four times the resolution.";
let seq = 0;
const room = (scenario: string) => `${scenario}-x${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const ended = (url: string, id: string) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; });
type Space = { readAll: (t: any, o: any) => Promise<Array<{ fields: any }>>; count: (t: any) => Promise<number> };
type Call = { model: string; kind: string; table: string; runId: string; callId: string; prompt: string; seq: number };
const callsOf = async (space: Space, id: string, kind: string) => (await space.readAll({ type: "FakeCall", fields: { session: id, kind } }, { limit: 200 })).map((e) => e.fields as Call).sort((a, b) => a.seq - b.seq);
const plan = async (url: string, id: string, blockId: string, table: string, version?: number) => (await (await fetch(`${url}/api/rooms/${id}/plan/${blockId}?table=${table}${version ? `&version=${version}` : ""}`)).json()) as PlanView;
const clean = async (space: Space, id: string) => { for (const type of ["WorkItem", "LlmCall", "LlmResult", "AgentSlot", "TableRun", "ForumRun"]) assert.equal(await space.count({ type, fields: { session: id } }), 0, type); };

test("a comparison as a model writes it, the base it names, the points for the final round, and a proposal to take over", () => {
	const docs = { A: [{ sectionId: "s1", title: "Goal" }, { sectionId: "s2", title: "Steps" }], B: [{ sectionId: "s1", title: "Aim" }, { sectionId: "s2", title: "Way" }] };
	// M2 sees table B as X
	assert.deepEqual([sides("M1"), sides("M2"), sides("M3")], [{ X: "A", Y: "B" }, { X: "B", Y: "A" }, { X: "A", Y: "B" }]);
	const text = 'PREFER: Y\nCRITERIA\n1 X: shorter\n2. Y: has a check\n- 3 y: concrete\nBETTER\nbetter X: It names the phase. | from: "way" | into: "Steps"\nbetter Y: a date | into: "Aim" | from: "Goal"\nbetter Y: no such | from: "Costs" | into: "Aim"\nbetter X: nothing named';
	assert.deepEqual(parseCompare(text, sides("M2"), docs), { prefer: "A", criteria: [{ n: 1, prefer: "B", text: "shorter" }, { n: 2, prefer: "A", text: "has a check" }, { n: 3, prefer: "A", text: "concrete" }],
		points: [{ table: "B", from: "s2", fromTitle: "Way", into: "s2", intoTitle: "Steps", text: "It names the phase." }, { table: "A", from: "s1", fromTitle: "Goal", into: "s1", intoTitle: "Aim", text: "a date" }] });
	assert.throws(() => parseCompare("Both are fine.", sides("M1"), docs), /prefers neither/);
	assert.equal(parseCompare(["PREFER: X", ...Array.from({ length: 5 }, (_, i) => `better X: p${i} | from: "Goal" | into: "Aim"`)].join("\n"), sides("M1"), docs).points.length, 3);
	// the only table that agreed is the base whatever the models prefer; else the majority; among equals the cheaper
	const prefer = (...p: Array<"A" | "B">) => p.map((x) => ({ prefer: x }));
	assert.deepEqual(baseOf({ accepted: { A: false, B: true }, compares: prefer("A", "A", "A"), tokens: { A: 1, B: 2 } }), { table: "B", how: "accepted", prefer: { A: 3, B: 0 } });
	assert.equal(baseOf({ accepted: { A: true, B: true }, compares: prefer("A", "B", "B"), tokens: { A: 1, B: 2 } }).table, "B");
	assert.equal(baseOf({ accepted: { A: false, B: false }, compares: prefer("A", "B"), tokens: { A: 5, B: 2 } }).table, "B");
	assert.deepEqual(baseOf({ accepted: { A: false, B: false }, compares: prefer("A", "B"), tokens: { A: 2, B: 2 } }), { table: "A", how: "compared", prefer: { A: 1, B: 1 } });
	// the points of the document that is not the base, one per pair of sections
	const p = (table: "A" | "B", from: string, into: string) => ({ table, from, fromTitle: from, into, intoTitle: into, text: "x" });
	const compares = [{ points: [p("B", "s2", "s2"), p("A", "s1", "s1")] }, { points: [p("B", "s2", "s2"), p("B", "s1", "s3")] }] as PlanCompare[];
	assert.deepEqual(pointsFor(compares, "A").map((x) => [x.from, x.into]), [["s2", "s2"], ["s1", "s3"]]);
	assert.deepEqual(pointsFor(compares, "B").map((x) => [x.from, x.into]), [["s1", "s1"]]);
	assert.deepEqual(takeoverOf('Take over "Steps" into “The way”: it is clearer'), { from: "Steps", into: "The way" });
	assert.equal(takeoverOf("Keep the tile size."), null);
});

test("both tables in one run: each agrees, the models compare blind, the base takes over what the other does better, and the final round agrees", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("both");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	const s = await ended(srv.url, id), run = s.run!;
	// each table agreed on its fourth version in its first round
	assert.deepEqual([run.both, run.phase, run.tables!.A!.accepted, run.tables!.B!.accepted], [true, "done", { version: 4, round: 1, approvals: 3, of: 3 }, { version: 4, round: 1, approvals: 3, of: 3 }]);
	assert.deepEqual([run.tables!.A!.usage.tokens, run.tables!.B!.usage.tokens], [300 + 450 + 400 + 3000 + 1000 + 1800, 300 + 450 + 1200 + 360 + 3000 + 1800]);
	// blind: no table, no model, and the documents as X and Y; M1 and M3 see table A as X and prefer it
	const compares = await callsOf(srv.stack.space, id, "compare");
	assert.equal(compares.length, 3);
	for (const c of compares) assert.ok(c.prompt.includes("You are not told which table wrote which") && c.prompt.includes("Document X:") && c.prompt.includes("Document Y:") && !/table [AB]\b/i.test(c.prompt), c.model);
	assert.deepEqual(run.base, { table: "A", how: "compared", version: 4, prefer: { A: 2, B: 1 } });
	// the final round at table A: two points of table B's document, both agreed, each a revision that names its origin
	assert.deepEqual([run.final, run.result, s.blocks[0]!.result, s.blocks[0]!.table, s.blocks[0]!.accepted?.version], [{ points: 2, agreed: 2, accepted: true }, { table: "A", version: 6 }, { table: "A", version: 6 }, "A", 6]);
	const view = await plan(srv.url, id, blockId, "A");
	assert.deepEqual(view.doc.sections.map((x) => [x.title, x.rev, x.origin]), [["Goal", 3, 'table B, version 4, section "Goal"'], ["Steps", 3, 'table B, version 4, section "Steps"'], ["Risks", 2, undefined]]);
	const revises = await callsOf(srv.stack.space, id, "revise");
	assert.equal(revises.length, 2);
	for (const c of revises) assert.ok(c.runId.endsWith("-F") && c.prompt.includes("of the other document, which the table decided to take over into this one") && c.prompt.includes("- the table: The table decided: Take over from the other document"), c.callId);
	// table B's document is as its table left it
	assert.equal((await plan(srv.url, id, blockId, "B")).doc.version, 4);
	// what the tables, the comparison and the final round used is the run's
	assert.equal(run.usage.tokens, run.tables!.A!.usage.tokens + run.tables!.B!.usage.tokens + 2100 + (750 + 2000 + 1800));
	assert.match(s.lines.at(-1)!.text, /^Run finished: table A agreed on version 4 in round 1, table B agreed on version 4 in round 1; base: table A \(the comparison, preferred by 2 of 3\); final round: 2 of 2 points taken over, accepted; result: table A, version 6 \(/);
	for (const start of ["Table A finished", "Table B finished", "Final round finished", "Both tables are through", "The base is table A's document"]) assert.ok(s.lines.some((l) => l.text.startsWith(start)), start);
	const stats = (await srv.stack.space.readAll({ type: "PlanStrategyStat", fields: { session: id } }, { limit: 5 })).map((e) => e.fields as PlanStrategyStat);
	assert.deepEqual(stats.map((x) => [x.base, x.how, x.prefer, x.final, x.result, x.tables.A?.accepted, x.tables.B?.rounds, x.models.length]), [["A", "compared", { A: 2, B: 1 }, { points: 2, agreed: 2, accepted: true }, { table: "A", version: 6 }, true, 1, 3]]);
	assert.deepEqual([s.standings.runs, s.standings.A, s.standings.B], [1, 1, 0]);
	await clean(srv.stack.space, id);
});

test("a final round that does not agree leaves the base as the result", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("keep");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	const s = await ended(srv.url, id), run = s.run!;
	// the final round revised two sections, then nobody approved, and its one round was used up
	assert.deepEqual([run.base?.table, run.base?.version, run.final, run.result], ["A", 4, { points: 2, agreed: 2, accepted: false }, { table: "A", version: 4 }]);
	assert.deepEqual([s.blocks[0]!.result, s.blocks[0]!.accepted?.version], [{ table: "A", version: 4 }, 4]);
	// the document went on at its table; the result is the version the table had agreed on
	const head = await plan(srv.url, id, blockId, "A"), result = await plan(srv.url, id, blockId, "A", 4);
	assert.ok(head.doc.version > 4);
	assert.deepEqual(result.doc.sections.map((x) => [x.rev, x.origin]), [[2, undefined], [2, undefined], [2, undefined]]);
	assert.match(s.lines.at(-1)!.text, /final round: 2 of 2 points taken over, not accepted, the base stays; result: table A, version 4 \(/);
	await clean(srv.stack.space, id);
});

test("a table proposes to take over a section of the other, which agreed first: the section names its origin, and the table finishes its round and begins no other", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("swap");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	const s = await ended(srv.url, id), run = s.run!;
	// table B agreed while table A still drafted; table A had its round, in which M2 proposed and the table agreed
	assert.deepEqual([run.tables!.B!.accepted?.version, run.tables!.A!.accepted, run.tables!.A!.round, run.tables!.A!.ended], [4, undefined, 1, "other"]);
	const turns = (await callsOf(srv.stack.space, id, "turn")).filter((c) => c.table === "A");
	assert.equal(turns.length, 2);
	for (const c of turns) assert.ok(c.prompt.includes("Another table works on the same brief") && c.prompt.includes('proposal: take over "<heading there>" into "<heading of your document>"'), c.model);
	// (table A's own document is not in that part: its sections are written by one model, table B's by three)
	const taken = (await callsOf(srv.stack.space, id, "revise")).find((c) => c.runId.endsWith("-A"))!;
	assert.ok(taken.prompt.includes('The section "Steps" of the other document, which the table decided to take over into this one'));
	const a = await plan(srv.url, id, blockId, "A", 5);
	assert.deepEqual(a.doc.sections.map((x) => [x.title, x.rev, x.origin]), [["Goal", 2, undefined], ["Steps", 3, 'table B, version 4, section "Steps"'], ["Risks", 2, undefined]]);
	// the only table that agreed is the base, whatever the comparison prefers
	assert.deepEqual([run.base?.table, run.base?.how, run.base?.version, run.result?.table], ["B", "accepted", 4, "B"]);
	assert.ok(s.lines.some((l) => /^Table A finished \(the other table agreed first\)/.test(l.text)));
	await clean(srv.stack.space, id);
});

test("no table uses more than its share of the budget, and a run without a document has no result", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("dear");
	await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF });
	// 45 % of 20 000 tokens a table, 3000 a call: each table's roll call uses its share up
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 20_000, way: "both" })).status, 200);
	const s = await ended(srv.url, id), run = s.run!;
	for (const x of ["A", "B"] as const) assert.deepEqual([run.tables![x]!.ended, run.tables![x]!.usage.tokens], ["budget", 9000], x);
	assert.deepEqual([run.usage.tokens, run.result, run.base, s.blocks[0]!.result], [18_000, undefined, undefined, null]);
	assert.match(s.lines.at(-1)!.text, /^Run finished: table A did not agree \(budget\), table B did not agree \(budget\); no result \(18000 tokens/);
	assert.equal(s.standings.runs, 0);
	await clean(srv.stack.space, id);
});

test("a stopped run with both tables takes its tables with it", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("hold");
	await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF });
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	// both tables are at their roll calls, whose answers wait at the gate (the model process has two calls in flight)
	await until("roll calls to be asked for", async () => (await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "rollcall" } })) >= 2);
	const now = await snapshot(srv.url, id);
	assert.deepEqual([now.run!.phase, now.run!.tables!.A!.phase, now.run!.tables!.B!.phase, now.run!.tables!.A!.active], ["tables", "rollcall", "rollcall", true]);
	assert.equal((await post(srv.url, `/api/rooms/${id}/stop`, {})).status, 200);
	const s = await ended(srv.url, id);
	assert.match(s.lines.at(-1)!.text, /^Run stopped: /);
	// (an agent whose call was cut off takes the call's answer, sees that the run is gone, and removes it with its item:
	// in between the answer is out of sight for a moment, so nothing left counts only when it holds for a while)
	const left = async () => (await Promise.all(["WorkItem", "LlmCall", "LlmResult"].map((type) => srv.stack.space.count({ type, fields: { session: id } })))).reduce((a, b) => a + b, 0);
	await until("the work of the tables to be gone", async () => { if (await left()) return false; await new Promise((r) => setTimeout(r, 1500)); return !(await left()); });
	await clean(srv.stack.space, id);
});
