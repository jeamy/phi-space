// Data tasks (server/datatask.ts, docs/codemode-anwendungen.en.md A step 2): a person uploads a dataset (JSON or CSV)
// with an answer column; the sample travels with the task, the hidden part lies in the block's CodeData and only the
// judge reads it. The dataset here is tests/fake-tickets.ts: made-up support tickets, some about a refund.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./stack.ts";
import { SOLUTIONS, tickets, ticketsCsv } from "./fake-tickets.ts";
import { parseCsv, readUpload, setScore } from "../server/datatask.ts";
import { dataTask, portableTask, restoreTask } from "../server/tasks.ts";
import { judge, loadCodemode } from "../server/judge.ts";
import { teamPrompt } from "../server/llm.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const QUESTION = "Which tickets ask for a refund (money back, in any wording)?";

test("an upload: CSV and JSON read alike, split into a sample with its answer and a hidden part", () => {
	const rows = tickets();
	const fromCsv = readUpload({ question: QUESTION, csv: ticketsCsv(rows), answer: "refund" });
	const fromJson = readUpload({ question: QUESTION, rows, answer: "refund" });
	assert.deepEqual(fromCsv, fromJson);
	const { spec, holdout, holdoutAnswer } = fromCsv;
	assert.equal(spec.sample.length + holdout.length, 500);
	assert.ok(spec.sample.length >= 20 && spec.sample.length <= 40, String(spec.sample.length));
	assert.deepEqual(spec.fields, ["subject", "body", "channel", "priority"]);
	assert.equal(spec.sample.some((i) => "refund" in i), false, "the answer column is not in the items");
	const want = new Set(rows.filter((r) => r.refund === "yes").map((r) => r.id));
	assert.deepEqual([...spec.sampleAnswer, ...holdoutAnswer].sort(), [...want].sort());
	// CSV: semicolons, quotes, a line break inside quotes
	assert.deepEqual(parseCsv('id;text;hit\n1;"a; ""b""\nc";ja\n2;x;nein\n'), [{ id: "1", text: 'a; "b"\nc', hit: "ja" }, { id: "2", text: "x", hit: "nein" }]);
	// what is refused, in words
	assert.throws(() => readUpload({ question: QUESTION, rows, answer: "missing" }), /no answer column "missing"/);
	assert.throws(() => readUpload({ question: QUESTION, rows: rows.map((r) => ({ ...r, refund: "no" })), answer: "refund" }), /No item is marked/);
	assert.throws(() => readUpload({ question: QUESTION, rows: rows.map((r) => ({ ...r, refund: "maybe" })), answer: "refund" }), /yes\/no/);
	assert.throws(() => readUpload({ question: QUESTION, rows: [...rows, rows[0]], answer: "refund" }), /appears twice/);
	assert.throws(() => readUpload({ question: QUESTION, rows: rows.slice(0, 5), answer: "refund" }), /at least 10/);
	assert.throws(() => readUpload({ question: "", rows, answer: "refund" }), /question/);
	// the score: ids as a set, order does not matter, repeats are wrong
	assert.equal(setScore(["b", "a"], ["a", "b"]), 1);
	assert.equal(setScore(["a", "a"], ["a"]), 0);
	// the task leaves the judge without the hidden part, and comes back with the sample only
	const task = dataTask(spec), back = restoreTask(portableTask(task));
	assert.equal(back.tools?.holdoutMissing, true);
	assert.match(teamPrompt({ task, lang: "en", agent: 0, gen: 1 }).user, /Which tickets ask for a refund/);
	assert.doesNotMatch(JSON.stringify(teamPrompt({ task, lang: "en", agent: 0, gen: 1 })), new RegExp(holdout[0]!.id));
});

t("the judge with the hidden part: both correct contributions pass, the cheap one cheaper; the narrow and the hard-coded fail", async () => {
	const up = readUpload({ question: QUESTION, rows: tickets(), answer: "refund" });
	const task = dataTask(up.spec, { items: up.holdout, answer: up.holdoutAnswer });
	const hardcoded = `async function solve(){return ${JSON.stringify(up.spec.sampleAnswer)}}`;
	const [all, search, narrow, hard] = await Promise.all([SOLUTIONS.readAll, SOLUTIONS.searchAll, SOLUTIONS.onlyRefund, hardcoded].map((s) => judge(cm!, task, s)));
	for (const v of [all!, search!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.passed, 2); }
	assert.ok(search!.cost! < all!.cost!, `${search!.cost} < ${all!.cost}`);
	assert.equal(search!.cost, 10);
	assert.equal(narrow!.ok, false);
	assert.equal(hard!.ok, false);
	assert.match(JSON.stringify(hard!.cases), /holdout/);
	// an agent's own check (no hidden part): the sample only
	const own = await judge(cm!, dataTask(up.spec), SOLUTIONS.searchAll);
	assert.deepEqual([own.ok, own.total], [true, 1]);
});

t("upload, judge, delete on the server: the page's form as JSON and as CSV, contributions judged against the hidden part", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		const room = async (id: string) => { const s = await (await fetch(srv.url + `/api/sessions/${id}`)).json() as any; return { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) }; };
		// a bad upload is refused with its reason
		const bad = await post("/api/sessions/data1/task", { data: { question: QUESTION, rows: tickets(), answer: "nope" } });
		assert.equal(bad.status, 400);
		assert.match((await bad.json() as any).error, /no answer column/);
		// the CSV (about 90 KB: more than other requests may take)
		const csv = ticketsCsv();
		assert.ok(csv.length > 64_000);
		const r = await post("/api/sessions/data1/task", { data: { question: QUESTION, csv, answer: "refund", tools: ["list", "get", "search"] } });
		assert.equal(r.status, 200, await r.text());
		const space = srv.stack.space;
		let snap = await room("data1");
		assert.equal(snap.task.id, "data");
		assert.match(snap.task.prompt.en, /Which tickets ask for a refund/);
		const pages = await space.readAll({ type: "CodeData", fields: { session: "data1", blockId: snap.current } });
		assert.ok(pages.length >= 2, `the hidden part in pages: ${pages.length}`);
		assert.ok(snap.messages.some((m: any) => /Dataset: 500 items/.test(m.text)));
		for (const [author, source] of [["alles-lesen", SOLUTIONS.readAll], ["suchen", SOLUTIONS.searchAll], ["nur-refund", SOLUTIONS.onlyRefund]] as const)
			assert.equal((await post("/api/sessions/data1/code", { author, source })).status, 200);
		for (const end = Date.now() + 60_000; ;) {
			snap = await room("data1");
			if (snap.contributions?.length === 3 && snap.contributions.every((c: any) => c.ok !== null) && snap.best) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((res) => setTimeout(res, 100));
		}
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.author, c]));
		assert.deepEqual([by["alles-lesen"].ok, by.suchen.ok, by["nur-refund"].ok], [true, true, false]);
		assert.equal(snap.best.candidateId, by.suchen.candidateId);
		// the same rows as JSON open a block of their own
		assert.equal((await post("/api/sessions/data2/task", { data: { question: QUESTION, rows: tickets(), answer: "refund" } })).status, 200);
		assert.equal((await room("data2")).task.id, "data");
		// near the size limit (about 20 pages), and a third data block in the same room: all of them are shown
		const big = tickets(2000).map((x) => ({ ...x, body: `${x.body} ${"Order details follow. ".repeat(9)}` }));
		const size = Buffer.byteLength(JSON.stringify(big));
		assert.ok(size > 700_000 && size < 800_000, String(size));
		const rb = await post("/api/sessions/data2/task", { data: { question: QUESTION, csv: ticketsCsv(big), answer: "refund" } });
		assert.equal(rb.status, 200, await rb.text());
		const s2 = await room("data2");
		assert.equal(s2.blocks.length, 2);
		assert.ok((await space.readAll({ type: "CodeData", fields: { session: "data2", blockId: s2.current } })).length >= 15);
		// search answers at most 200 ids a call: on 2000 tickets the solution asks for each wording on its own
		const fine = `async function solve(){const all=await Promise.all(["i want a refund","please refund","money back","reimburse","credited","reverse the charge"].map(q=>tools.search({q,limit:200})));return [...new Set(all.flat())]}`;
		assert.equal((await post("/api/sessions/data2/code", { author: "suchen", source: fine })).status, 200);
		for (const end = Date.now() + 60_000; ;) {
			const x = await room("data2");
			const c = x.contributions?.[0];
			if (c && c.ok !== null) { assert.equal(c.ok, true, c.error); break; }
			if (Date.now() > end) throw new Error("no verdict on the large dataset");
			await new Promise((res) => setTimeout(res, 100));
		}
		// a dataset beyond the limit is refused with its reason
		const huge = await post("/api/sessions/data2/task", { data: { question: QUESTION, rows: big.map((x) => ({ ...x, body: x.body + x.body })), answer: "refund" } });
		assert.equal(huge.status, 400);
		assert.match((await huge.json() as any).error, /at most 800 KB/);
		// a visitor's uploads per day are counted: three so far, and a limit of three refuses the fourth
		process.env.CODEMODE_DATA_PER_IP_DAY = "3";
		try {
			const over = await post("/api/sessions/data3/task", { data: { question: QUESTION, rows: tickets(), answer: "refund" } });
			assert.equal(over.status, 400);
			assert.match((await over.json() as any).error, /uploads of today for your address are used up/);
		} finally { delete process.env.CODEMODE_DATA_PER_IP_DAY; }
		// deleting the block takes its hidden part along
		assert.equal((await post("/api/sessions/data1/delete", { blockId: snap.current })).status, 200);
		assert.equal((await space.readAll({ type: "CodeData", fields: { session: "data1" } })).length, 0);
	} finally { await srv.close(); }
});
