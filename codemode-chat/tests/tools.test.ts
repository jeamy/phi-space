// Tasks with tools (server/tooltask.ts, docs/codemode-anwendungen.en.md A): the judge answers the tools from the task's
// data, counts every call, scores on a hidden holdout and ranks correct verdicts by tool points before time.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./stack.ts";
import { judge, loadCodemode } from "../server/judge.ts";
import { rankCmp } from "../server/results.ts";
import { teamPrompt } from "../server/llm.ts";
import { taskById } from "../server/tasks.ts";
import { classify, FRUSTRATION, idScore, MAX_CALLS, newMeter, PI_WINDOWS, PI_WINDOWS_BUGS, worldTools } from "../server/tooltask.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const task = taskById("frustration")!;
const [naive, perThread, grouped, guessWords, countsMild] = task.variants;

test("the datasets: fixed, the holdout larger and in words the sample does not use", () => {
	const { sample, holdout } = FRUSTRATION;
	assert.equal(sample.issues.length, 16);
	assert.equal(holdout.issues.length, 120);
	const highOf = (w: typeof sample) => FRUSTRATION.answer(w) as string[];
	assert.ok(highOf(sample).length > 0 && highOf(holdout).length > highOf(sample).length);
	// the holdout has frustrated threads whose phrase the sample never shows
	const sampleText = sample.issues.flatMap((i) => i.comments.map((c) => c.text.toLowerCase())).join("\n");
	assert.ok(holdout.issues.some((i) => i.comments.some((c) => classify(c.text) === "high" && !["completely unusable", "still broken", "third time i report", "wasted my whole day"].some((p) => c.text.toLowerCase().includes(p)))));
	assert.ok(!sampleText.includes("fed up with this") && !sampleText.includes("this is ridiculous"));
	// the same on every load
	assert.deepEqual(FRUSTRATION.answer(holdout), FRUSTRATION.answer(holdout));
});

test("ids are scored as a set, in ascending order", () => {
	assert.equal(idScore(["I-2", "I-10"], ["I-2", "I-10"]), 1);
	assert.equal(idScore(["I-10", "I-2"], ["I-2", "I-10"]), 0, "order");
	assert.equal(idScore(["I-2", "I-2"], ["I-2"]), 0, "repeats");
	assert.equal(idScore(["I-2"], ["I-2", "I-10"]), 2 / 3);
	assert.equal(idScore("I-2", ["I-2"]), 0);
	assert.equal(idScore([], []), 1);
});

test("the tools count every call and stop at the cap", () => {
	const m = newMeter(), tools = Object.fromEntries(worldTools(FRUSTRATION, FRUSTRATION.sample, m).map((x) => [x.name, x]));
	const page = tools.list!.execute({ limit: 10 }) as { items: Array<{ id: string }>; next: string };
	assert.equal(page.items.length, 10);
	assert.equal((tools.list!.execute({ after: page.next, limit: 50 }) as { items: unknown[]; next: unknown }).next, null);
	assert.equal((tools.get!.execute({ id: "I-1" }) as { id: string }).id, "I-1");
	assert.equal(tools.get!.execute({ id: "I-9999" }), null);
	assert.throws(() => tools.classify!.execute({ text: 5 }));
	assert.deepEqual([m.calls, m.cost, m.total], [{ list: 2, get: 2, classify: 1 }, 7, 5]);
	m.total = MAX_CALLS;
	assert.throws(() => tools.get!.execute({ id: "I-1" }), /more than/);
});

t("the scripted variants: correct ones ranked by tool points, the word guesser fails on the holdout", async () => {
	const [a, b, c, d, e] = await Promise.all([naive, perThread, grouped, guessWords, countsMild].map((v) => judge(cm!, task, v!)));
	for (const v of [a, b, c]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.score, 1); assert.equal(v.passed, 2); }
	assert.ok(a.cost! > b.cost! && b.cost! > c.cost!, `${a.cost} > ${b.cost} > ${c.cost}`);
	assert.deepEqual(b.calls, { list: 3, get: 120, classify: 120 });
	assert.equal(b.cost, 3 + 120 + 360);
	// right on the sample, wrong where the words differ
	assert.equal(d.ok, false);
	assert.equal(d.cases.find((x) => x.call.includes("sample"))!.ok, true);
	assert.ok(d.score! < 1 && d.score! > 0);
	assert.match(d.error!, /holdout/);
	assert.equal(e.ok, false);
	// the holdout's items and answer stay out of every verdict
	for (const v of [a, d, e]) {
		const text = JSON.stringify(v);
		assert.ok(!(FRUSTRATION.answer(FRUSTRATION.holdout) as string[]).some((id) => text.includes(`"${id}"`)), "no holdout id");
		assert.ok(!text.includes("fed up with this"));
	}
	// the same contribution, the same verdict
	const again = await judge(cm!, task, perThread!);
	assert.deepEqual([again.cost, again.calls, again.score], [b.cost, b.calls, b.score]);
});

t("the sample's answer written in, a call storm, a throwing script: failed verdicts", async () => {
	const want = JSON.stringify(task.cases[0]!.expect);
	const lit = await judge(cm!, task, `async function solve(){ const ids = ${want}; await tools.list({}); return ids }`);
	assert.equal(lit.ok, false);
	const storm = await judge(cm!, task, `async function solve(){ for(;;) await tools.get({ id: "I-1" }) }`);
	assert.equal(storm.ok, false);
	assert.match(storm.error!, /more than 2000 tool calls/);
	const bad = await judge(cm!, task, `async function solve(){ throw new Error("nope") }`);
	assert.equal(bad.ok, false);
	assert.match(bad.error!, /nope/);
	assert.equal((await judge(cm!, task, `function other(){}`)).ok, false);
});

t("a script that throws the hidden data out in its message sees only that it threw", async () => {
	const hidden = FRUSTRATION.answer(FRUSTRATION.holdout) as string[];
	const leak = await judge(cm!, task, `async function solve(){
		const ids = []; let after; do { const p = await tools.list({ after, limit: 50 }); for (const it of p.items) ids.push(it.id); after = p.next } while (after);
		if (ids.length < 20) return ${JSON.stringify(task.cases[0]!.expect)}.filter(() => true);
		const texts = []; for (const id of ids) texts.push(JSON.stringify(await tools.get({ id })));
		throw new Error(texts.filter((t) => /fed up|ridiculous|switching/.test(t)).join(" ").slice(0, 3000));
	}`);
	assert.equal(leak.ok, false);
	const text = JSON.stringify(leak);
	assert.match(text, /its message stays hidden/);
	for (const id of hidden) assert.ok(!text.includes(`"${id}"`) && !text.includes(`${id} `) && !text.includes(`${id}"`), id);
	for (const p of ["fed up with this", "this is ridiculous", "we are switching away"]) assert.ok(!text.includes(p), p);
	// the judge's own messages stay readable on the holdout
	const storm = await judge(cm!, task, `async function solve(){ const p = await tools.list({ limit: 50 }); if (p.next) for(;;) await tools.get({ id: "I-1" }); return ${JSON.stringify(task.cases[0]!.expect)}.slice() }`);
	assert.match(storm.error!, /more than 2000 tool calls/);
});

test("correct verdicts rank by tool points first, then time", () => {
	assert.ok(rankCmp({ ms: 90, cost: 100 }, { ms: 10, cost: 200 }) < 0);
	assert.ok(rankCmp({ ms: 20, cost: 100 }, { ms: 10, cost: 100 }) > 0);
	assert.ok(rankCmp({ ms: 5 }, { ms: 10 }) < 0, "tasks without tools: time alone");
});

test("the agents read the tools, the points and that a hidden dataset decides", () => {
	const prompt = teamPrompt({ task, lang: "en", agent: 0, gen: 1 }).user;
	assert.match(prompt, /tools\.classify/);
	assert.match(prompt, /fewest points wins/);
	assert.match(prompt, /hidden, larger dataset/);
});

t("hand-ins on the tools task: the cheapest correct code becomes the best, not the fastest", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/tools1/task", { taskId: "frustration" })).status, 200);
		for (const [author, source] of [["naiv", naive], ["gruppe", grouped], ["faden", perThread], ["rater", guessWords]] as const) assert.equal((await post("/api/sessions/tools1/code", { author, source })).status, 200);
		const end = Date.now() + 60_000;
		let snap: any;
		for (;;) {
			const s = await (await fetch(srv.url + "/api/sessions/tools1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.contributions?.length === 4 && snap.contributions.every((c: any) => c.ok !== null) && snap.best) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.author, c]));
		assert.deepEqual([by.naiv.ok, by.gruppe.ok, by.faden.ok, by.rater.ok], [true, true, true, false]);
		assert.ok(by.gruppe.cost < by.faden.cost && by.faden.cost < by.naiv.cost);
		assert.equal(snap.best.candidateId, by.gruppe.candidateId, "the cheapest, not the fastest");
	} finally { await srv.close(); }
});

const view = async (url: string, room: string) => { const s = await (await fetch(`${url}/api/sessions/${room}`)).json() as any; return { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) }; };
const until = async <T>(fn: () => Promise<T | false>, ms: number, what: () => Promise<unknown>): Promise<T> => {
	for (const end = Date.now() + ms; ;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(await what())}`); await new Promise((r) => setTimeout(r, 100)); }
};

t("a scripted run on the tools task ends with the cheapest correct contribution as best, its summary in tool points", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/toolrun/task", { taskId: "frustration" })).status, 200);
		assert.equal((await post("/api/sessions/toolrun/run", { agents: 3, gens: 2, perAgent: 1, contenders: ["scripted"] })).status, 200);
		const snap = await until(async () => { const s = await view(srv.url, "toolrun"); return s.run && !s.run.active && s.contributions.length >= 3 && s.contributions.every((c: any) => c.ok !== null) && s.best && s.messages.some((m: any) => /^Run /.test(m.text)) ? s : false; }, 90_000, async () => (await view(srv.url, "toolrun")).contributions?.map((c: any) => [c.author, c.ok, c.cost]));
		const correct = snap.contributions.filter((c: any) => c.ok);
		assert.ok(correct.length > 0 && correct.every((c: any) => typeof c.cost === "number"));
		const cheapest = Math.min(...correct.map((c: any) => c.cost));
		assert.equal(snap.contributions.find((c: any) => c.candidateId === snap.best.candidateId).cost, cheapest);
		assert.ok(snap.messages.some((m: any) => /tool points/.test(m.text)), JSON.stringify(snap.messages.map((m: any) => m.text)));
	} finally { await srv.close(); }
});

t("model contenders on the tools task: their prompt carries no holdout, the cheaper model wins", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1", fakes: true }); // the team of room "tool1" in tests/fakes.ts
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/tool1/task", { taskId: "frustration" })).status, 200);
		assert.equal((await post("/api/sessions/tool1/run", { agents: 2, gens: 1, perAgent: 1, contenders: ["fake/fast", "fake/slow"] })).status, 200);
		const snap = await until(async () => { const s = await view(srv.url, "tool1"); return s.run && !s.run.active && s.contributions.length === 2 && s.contributions.every((c: any) => c.ok !== null) && s.best ? s : false; }, 90_000, async () => (await view(srv.url, "tool1")).contributions?.map((c: any) => [c.via, c.ok, c.cost, c.error]));
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.via, c]));
		assert.deepEqual([by["fake/fast"].ok, by["fake/slow"].ok], [true, true]);
		assert.equal(snap.best.candidateId, by["fake/fast"].candidateId);
		const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: "tool1" } })).map((e: any) => e.fields);
		assert.equal(calls.length, 2);
		assert.ok(calls.every((c: any) => c.kind === "tools" && c.holdout === false), JSON.stringify(calls));
	} finally { await srv.close(); }
});

// ---- real data: issues of earendil-works/pi (server/data/pi-issues.json) ---------------------------------------
const pi = taskById("pi-windows")!;

test("the pi dataset: real issues, shortened, without names, split by number", () => {
	const { sample, holdout } = PI_WINDOWS, all = [...sample.issues, ...holdout.issues];
	assert.ok(all.length >= 200 && sample.issues.length >= 20, `${sample.issues.length} + ${holdout.issues.length}`);
	assert.ok(sample.issues.every((i) => Number(i.id.slice(2)) % 10 === 0) && holdout.issues.every((i) => Number(i.id.slice(2)) % 10 !== 0));
	// only u1, u2, … and "bot" as authors; no @mention keeps its name
	assert.ok(all.every((i) => i.comments.every((c) => /^(u\d+|bot)$/.test(c.by))));
	// (a text cut short may end in "@som…", the start of a replaced name)
	assert.ok(all.every((i) => ![i.body ?? "", ...i.comments.map((c) => c.text)].some((x) => /(^|[^\w/])@(?!someone\b)[\w-]+/.test(x.replace(/@[\w-]*…$/, "")))));
	const want = (w: typeof sample) => PI_WINDOWS.answer(w) as string[];
	assert.ok(want(sample).length >= 1 && want(holdout).length > want(sample).length, `${want(sample)} / ${want(holdout).length}`);
	// the search alone is not enough: some hits are wrong (mentioned only in a comment, or answered only by the bot)
	const m = newMeter(), search = worldTools(PI_WINDOWS, holdout, m).find((x) => x.name === "search")!;
	assert.ok((search.execute({ q: "windows", limit: 200 }) as string[]).length > want(holdout).length);
	assert.equal(teamPrompt({ task: pi, lang: "en", agent: 0, gen: 1 }).user.match(/I-\d+/g)?.some((id) => want(holdout).includes(id)) ?? false, false, "no holdout id in the prompt");
});

t("the pi variants: search then get beats fetching everything; the shortcuts fail", async () => {
	const [all, searched, hitsOnly, botCounts] = await Promise.all(pi.variants.map((v) => judge(cm!, pi, v)));
	for (const v of [all!, searched!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.score, 1); }
	assert.ok(searched!.cost! < all!.cost! / 5, `${searched!.cost} vs ${all!.cost}`);
	assert.equal(all!.calls!.get, PI_WINDOWS.holdout.issues.length);
	assert.equal(hitsOnly!.ok, false);
	assert.equal(botCounts!.ok, false);
});

// ---- the same issues with Jev's recorded answers (fetch-pi-issues.ts --jev) ------------------------------------
const piBugs = taskById("pi-windows-bugs")!;

test("Jev's answers: recorded for every issue, served only by the jev tool", () => {
	const { sample, holdout } = PI_WINDOWS_BUGS;
	for (const w of [sample, holdout]) assert.ok(w.issues.every((i) => ["bug", "feature", "question", "other"].includes(w.jev![i.id]!.kind)));
	const m = newMeter(), tools = Object.fromEntries(worldTools(PI_WINDOWS_BUGS, holdout, m).map((x) => [x.name, x]));
	const id = holdout.issues[0]!.id;
	assert.equal(JSON.stringify(tools.get!.execute({ id })).includes("kind"), false, "get does not carry Jev's answer");
	assert.deepEqual(tools.jev!.execute({ id }), holdout.jev![id]);
	assert.equal(tools.jev!.execute({ id: "I-1" }), null);
	assert.deepEqual([m.calls, m.cost], [{ get: 1, jev: 2 }, 7]);
	// the pi-windows task has no jev tool
	assert.equal(worldTools(PI_WINDOWS, holdout, newMeter()).some((x) => x.name === "jev"), false);
	const want = PI_WINDOWS_BUGS.answer(holdout) as string[];
	assert.ok(want.length > 0 && want.length < (PI_WINDOWS.answer(holdout) as string[]).length, "Jev narrows the answer");
});

t("the Jev variants: asking Jev only where the cheap conditions hold is cheapest; leaving Jev out fails", async () => {
	const [all, rateHits, rateLast, noJev, unread] = await Promise.all(piBugs.variants.map((v) => judge(cm!, piBugs, v)));
	for (const v of [all!, rateHits!, rateLast!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.score, 1); }
	assert.ok(all!.cost! > rateHits!.cost! && rateHits!.cost! > rateLast!.cost!, `${all!.cost} > ${rateHits!.cost} > ${rateLast!.cost}`);
	assert.equal(noJev!.ok, false);
	assert.equal(unread!.ok, false);
});
