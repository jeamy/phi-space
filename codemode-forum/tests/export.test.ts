// The result as one document: the export is the plan as its table left it, followed by an appendix a program writes
// from the entries of the run. And what the page shows of two versions: their difference, line by line.
import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { diffCount, diffText, withContext } from "../client/lib/diff.ts";
import { APPENDIX_MARK } from "../server/export.ts";
import type { PlanView, Snapshot } from "../server/hub.ts";
import { startServer } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan how the world gets four times the resolution.";
const ROOT = fileURLToPath(new URL("..", import.meta.url));
let seq = 0;
const room = (scenario: string) => `${scenario}-e${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
const text = async (url: string, path: string) => { const r = await fetch(url + path); return { status: r.status, type: r.headers.get("content-type"), body: await r.text() }; };
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const ended = (url: string, id: string) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; });
const plan = async (url: string, id: string, blockId: string, table: string, version?: number) => (await (await fetch(`${url}/api/rooms/${id}/plan/${blockId}?table=${table}${version ? `&version=${version}` : ""}`)).json()) as PlanView;
/** A version as the export writes its plan: the first line of the brief, then every section under its heading. */
const asMarkdown = (v: PlanView) => `# ${BRIEF}\n\n${v.doc.sections.map((s) => `## ${s.title}\n\n${s.text}`.trimEnd()).join("\n\n")}\n`;

test("the difference between two texts: lines removed and added, the words that changed inside a line, long stretches cut", () => {
	const before = "Goal\n\nThe world has 64 tiles a side.\nIt stays as it is.\na\nb\nc\nd\ne\nf\nLast line.", after = "Goal\n\nThe world has 256 tiles a side.\nIt stays as it is.\na\nb\nc\nd\ne\nf\nLast line.\nOne more.";
	const d = diffText(before, after);
	assert.deepEqual(diffCount(d), { del: 1, add: 2 });
	// the changed line carries its words: only the number differs
	const del = d.find((l) => l.op === "del")!, add = d.find((l) => l.op === "add")!;
	assert.deepEqual([del.text, del.words?.filter((w) => w.op === "del").map((w) => w.text)], ["The world has 64 tiles a side.", ["64"]]);
	assert.deepEqual([add.text, add.words?.filter((w) => w.op === "add").map((w) => w.text)], ["The world has 256 tiles a side.", ["256"]]);
	assert.equal(del.words!.map((w) => w.text).join(""), del.text);
	// two lines that share nothing are one removed and one added, without word marks
	assert.deepEqual(diffText("alpha beta", "gamma delta").map((l) => [l.op, l.words]), [["del", undefined], ["add", undefined]]);
	// the same text has no difference; an empty one against a text is all added
	assert.deepEqual(diffCount(diffText(before, before)), { del: 0, add: 0 });
	assert.deepEqual(diffText("", "x\ny").filter((l) => l.op === "add").map((l) => l.text), ["x", "y"]);
	// the unchanged middle is cut to two lines around each change
	const cut = withContext(d);
	assert.deepEqual(cut.map((l) => (l.op === "gap" ? `gap ${l.count}` : l.op)), ["same", "same", "del", "add", "same", "same", "gap 4", "same", "same", "add"]);
	// putting the lines of the new side together gives the new text back
	assert.equal(d.filter((l) => l.op !== "del").map((l) => l.text).join("\n"), after);
});

test("the export of a run with both tables equals the result, and its appendix says how the plan came about", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("both");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	const s = await ended(srv.url, id);
	assert.deepEqual([s.run!.result, s.blocks[0]!.heads], [{ table: "A", version: 6 }, { A: 6, B: 4 }]);
	// the export begins with the result, text for text; both addresses give the same
	const result = await plan(srv.url, id, blockId, "A", 6);
	const md = await text(srv.url, `/api/plan/${id}/${blockId}.md`);
	assert.deepEqual([md.status, md.type], [200, "text/markdown; charset=utf-8"]);
	assert.equal(md.body, (await text(srv.url, `/api/rooms/${id}/plan/${blockId}.md`)).body);
	const [body, appendix] = md.body.split(`\n---\n\n${APPENDIX_MARK}\n`);
	assert.equal(body, asMarkdown(result));
	assert.equal((await text(srv.url, `/api/plan/${id}/${blockId}.md?plain=1`)).body, asMarkdown(result));
	// the appendix: brief, models under their names at the table, the way that won and why, what was taken over
	const aliases = s.run!.aliases, a = appendix!;
	assert.match(a, /^\n## Appendix: how this plan came about\n\nGenerated by codemode-forum on \d{4}-\d\d-\d\d from the entries of the run\. No model wrote this appendix\.\n/);
	assert.ok(a.includes(`### Brief\n\n> ${BRIEF}\n\nCriteria the plan was held against:\n\n1. The plan answers the brief and names what it leaves out.`));
	assert.ok(a.includes("### Sources\n\nNone: the models had the brief only."));
	for (const m of THREE) assert.ok(a.includes(`- ${aliases[m]}: ${m}\n`), m);
	assert.match(a, /### Result\n\nTable A, version 6: accepted by a majority of the models: M1, M2, M3 \(3 of 3\) in round 1\.\n\nWay of working: table A: the models take turns\.\n\nBoth tables worked on the brief at the same time\.\nThe base of the result is the document of table A: 2 of 3 models preferred it in the blind comparison\.\nJoint final round: 2 of 2 points of the other document taken over; its ballot passed, so its version is the result\.\n\n- Table A: 1 round, 6950 tokens, \$0\.6950, agreed \(3 approvals\)\n- Table B: 1 round, 7110 tokens, \$0\.7110, agreed \(3 approvals\)\n\n- M[13] \(fake\/\w+\), 1: It is the clearer one\.\n/);
	assert.ok(a.includes('### Sections taken over from the other table\n\n- "Goal": from table B, version 4, section "Goal"\n- "Steps": from table B, version 4, section "Steps"\n'));
	assert.match(a, /### Decisions of the table\n\n- Take over from the other document/);
	// every ballot of the table whose document it is: its own round and the final round
	const rows = a.split("\n").filter((l) => /^\| \d+ \| \d+ \| M\d \(fake\//.test(l));
	assert.equal(rows.length, 6);
	for (const row of rows) assert.match(row, /\| approve \| yes \|$/);
	assert.ok(a.includes("### Objections still standing\n\nNone.\n"));
	assert.ok(a.includes(`### Cost\n\nThe two tables together: ${6950 + 7110} tokens, $1.4060 (the comparison and the final round come on top).\nThe last run on this task used ${s.run!.usage.tokens} tokens, $${s.run!.usage.costUsd.toFixed(4)} in all.\n`));
	// another version is exported as what it is: table B's document, which nobody made the result
	const other = await text(srv.url, `/api/plan/${id}/${blockId}.md?table=B`);
	assert.ok(other.body.startsWith(asMarkdown(await plan(srv.url, id, blockId, "B", 4))));
	assert.match(other.body, /Table B, version 4: accepted by a majority of the models: M1, M2, M3 \(3 of 3\) in round 1\.\n\nWay of working: table B: all models write at the same time and review each other\./);
	assert.ok(!other.body.includes("The base of the result"));
	assert.equal((await text(srv.url, `/api/plan/${id}/${blockId}.md?table=B&version=2&plain=1`)).body, asMarkdown(await plan(srv.url, id, blockId, "B", 2)));
	assert.match((await text(srv.url, `/api/plan/${id}/${blockId}.md?table=B&version=2`)).body, /Table B, version 2: not accepted by anybody: this is the newest draft\./);
	assert.equal((await text(srv.url, `/api/plan/${id}/${blockId}.md?version=99`)).status, 404);
	assert.equal((await text(srv.url, `/api/plan/${id}/nosuchblock.md`)).status, 404);
	// what the page shows of the comparison: the result and why, each table's numbers, every model's comparison
	const o = (await (await fetch(`${srv.url}/api/rooms/${id}/outcome/${blockId}`)).json()) as { chosen: unknown; stat: { base: string; tables: Record<string, { tokens: number }> }; compares: Array<{ model: string; prefer: string; criteria: unknown[]; points: unknown[]; session?: string }> };
	assert.deepEqual(o.chosen && { ...(o.chosen as object), accept: undefined }, { table: "A", version: 6, how: "result", accept: undefined });
	assert.deepEqual([o.stat.base, o.stat.tables.A!.tokens, o.compares.length, o.compares.filter((c) => c.prefer === "A").length, o.compares.every((c) => c.session === undefined && c.criteria.length > 0)], ["A", 6950, 3, 2, true]);
	// the script writes the same document to a file
	const dir = await mkdtemp(join(tmpdir(), "forum-export-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const out = join(dir, "docs", "plan.md");
	const run = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-strip-types", "server/export-plan.ts", "--room", id, "--block", blockId, "--out", out, "--space", srv.stack.spec], { cwd: ROOT });
	assert.match(run.stdout, /^\[export\] .*plan\.md \(\d+ bytes\): table A, version 6 \(result\)\n$/);
	assert.equal(await readFile(out, "utf8"), md.body);
	const bad = await promisify(execFile)(process.execPath, ["--no-warnings", "--experimental-strip-types", "server/export-plan.ts", "--room", id, "--block", "nosuchblock", "--out", join(dir, "none.md"), "--space", srv.stack.spec], { cwd: ROOT }).then(() => null, (e: { code: number; stderr: string }) => e);
	assert.deepEqual([bad?.code, bad?.stderr], [1, `[export] no document for block nosuchblock in room ${id}\n`]);
});

test("a final round that failed exports the base; a German task gets a German appendix; the person's word is the result", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	// the final round did not agree: the result is the version the base's table had agreed on, not the newest
	const keep = room("keep");
	const { blockId: kept } = (await post(srv.url, `/api/rooms/${keep}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${keep}/run`, { models: THREE, budgetTokens: 400_000, way: "both" })).status, 200);
	const k = await ended(srv.url, keep);
	assert.ok(k.blocks[0]!.heads.A! > 4);
	const md = (await text(srv.url, `/api/plan/${keep}/${kept}.md`)).body;
	assert.ok(md.startsWith(asMarkdown(await plan(srv.url, keep, kept, "A", 4))));
	assert.match(md, /Joint final round: 2 of 2 points of the other document taken over; its ballot failed, so the base stays the result\./);
	assert.ok(md.includes("### Sections taken over from the other table\n\nNone.\n"));

	// table B alone, in German: a declined objection still stands for its raiser, and the appendix names who holds it
	const id = room("declined"), { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF, lang: "de", criteria: "Der Plan nennt einen Termin." })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "parallel" })).status, 200);
	const s = await ended(srv.url, id), aliases = s.run!.aliases;
	assert.deepEqual([s.run!.accepted?.version, s.blocks[0]!.heads], [4, { B: 4 }]);
	const de = (await text(srv.url, `/api/plan/${id}/${blockId}.md`)).body;
	assert.ok(de.startsWith(asMarkdown(await plan(srv.url, id, blockId, "B", 4))));
	assert.match(de, /\n## Anhang: Wie dieser Plan entstand\n\nErzeugt von codemode-forum am /);
	assert.ok(de.includes("8. Der Plan nennt einen Termin.\n"));
	const approvers = ["fake/alpha", "fake/gamma"].map((m) => aliases[m]!).sort();
	assert.ok(de.includes(`### Ergebnis\n\nTisch B, Fassung 4: angenommen von einer Mehrheit der Modelle: ${approvers.join(", ")} (2 von 3) in Runde 2.\n\nArbeitsweise: Tisch B: Alle Modelle schreiben gleichzeitig und prüfen einander.\n`));
	assert.ok(de.includes(`### Einwände, die noch stehen\n\n- ${aliases["fake/beta"]} (fake/beta) zu „Goal“ (vom Überarbeiter abgelehnt, steht für den Einwender): It does not name the target value.`));
	assert.equal(de.split("\n").filter((l) => /^\| [12] \| 4 \| M\d \(fake\//.test(l)).length, 6);
	assert.ok(de.includes(`### Kosten\n\nDer letzte Lauf auf dieser Aufgabe hat insgesamt ${s.run!.usage.tokens} Tokens, $${s.run!.usage.costUsd.toFixed(4)} verbraucht.\n`));
	assert.ok(!de.includes("Beide Tische"));
	// the person accepts an earlier version: their word is the result from now on
	assert.equal((await post(srv.url, `/api/rooms/${id}/accept`, { blockId, version: 3, by: "Ada" })).status, 200);
	const yes = (await text(srv.url, `/api/plan/${id}/${blockId}.md`)).body;
	assert.ok(yes.startsWith(asMarkdown(await plan(srv.url, id, blockId, "B", 3))));
	assert.ok(yes.includes("Tisch B, Fassung 3: angenommen von Ada (das Wort einer Person gilt)."));
});
