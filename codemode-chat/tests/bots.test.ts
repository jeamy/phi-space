// Bot tasks (server/bottask.ts, docs/codemode-anwendungen.en.md B): the judge opens a world in the arena, the bot plays
// it through look/act/wait, the arena says whether the goal was reached. Here the arena is tests/fake-arena.ts (the
// same JSON lines; spaces-mmo/tests/arena.test.ts holds the real one). Only judges with an arena take bot candidates.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./stack.ts";
import { startFakeArena } from "./fake-arena.ts";
import { judge, loadCodemode } from "../server/judge.ts";
import { teamPrompt } from "../server/llm.ts";
import { laneOf } from "../server/room.ts";
import { offeredTasks, taskById } from "../server/tasks.ts";
import { ArenaDown, MAX_BOT_CALLS } from "../server/bottask.ts";
import { execute } from "../server/runner.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const task = taskById("beacon-bucht")!;
const [direct, looksAlways, noWood, farAway] = task.variants;

/** CODEMODE_ARENA for the length of `fn` (this process: the judge function and the catalog read it). */
async function withArena<T>(address: string, fn: () => Promise<T>): Promise<T> {
	const was = process.env.CODEMODE_ARENA;
	process.env.CODEMODE_ARENA = address;
	try { return await fn(); } finally { process.env.CODEMODE_ARENA = was ?? ""; }
}

t("the bot variants in a world each: the direct bot is cheapest, the wrong ones miss the goal", async () => {
	const arena = await startFakeArena();
	try {
		const [a, b, c, d] = await withArena(arena.address, () => Promise.all([direct, looksAlways, noWood, farAway].map((v) => judge(cm!, task, v!))));
		for (const v of [a!, b!]) { assert.equal(v.ok, true, v.error ?? ""); assert.equal(v.passed, 1); assert.equal(v.score, 1); }
		assert.deepEqual([a!.cost, a!.calls], [5, { look: 1, act: 4 }]);
		assert.deepEqual([b!.cost, b!.calls], [9, { look: 5, act: 4 }]);
		for (const v of [c!, d!]) { assert.equal(v.ok, false); assert.match(v.error!, /goal not reached: feuer-bucht is out/); }
		assert.equal(arena.opened(), 4, "a world per contribution");
		assert.equal(arena.open(), 0, "every world closed again");
	} finally { await arena.close(); }
});

t("a bot that throws, one beyond the call cap, and a judge without an arena", async () => {
	const arena = await startFakeArena();
	try {
		const [boom, storm] = await withArena(arena.address, () => Promise.all([
			judge(cm!, task, `async function bot(){await tools.look();throw new Error("lost my way")}`),
			judge(cm!, task, `async function bot(){for(;;)await tools.look()}`),
		]));
		assert.equal(boom!.ok, false); assert.match(boom!.error!, /lost my way \(calls: look 1 = 1 points\)/);
		assert.equal(storm!.ok, false); assert.match(storm!.error!, new RegExp(`more than ${MAX_BOT_CALLS} tool calls`));
		assert.equal(arena.open(), 0);
		const none = await withArena("", () => judge(cm!, task, direct!));
		assert.equal(none.ok, false); assert.match(none.error!, /no arena/);
	} finally { await arena.close(); }
});

t("▶ does not run a bot: it needs a world of its own", async () => {
	await assert.rejects(execute(cm! as never, task, direct!, "", () => {}, new AbortController().signal), /runs only when it is judged/);
});

t("the arena's own trouble is no verdict: unreachable, or gone in the middle, the judge gives the candidate back", async () => {
	await withArena("unix:/nowhere/arena.sock", () => assert.rejects(judge(cm!, task, direct!), ArenaDown));
	const arena = await startFakeArena({ dropOnAct: true });
	try { await withArena(arena.address, () => assert.rejects(judge(cm!, task, direct!), ArenaDown)); } finally { await arena.close(); }
});

test("bot tasks: their own lane, offered only with an arena, the prompt names the tools and the rule", () => {
	assert.equal(laneOf("beacon-bucht"), "bot");
	assert.equal(laneOf("frustration"), "code");
	assert.equal(laneOf("custom"), "code");
	process.env.CODEMODE_ARENA = "";
	assert.equal(offeredTasks().some((x) => x.kind === "bot"), false, "no arena: no bot task in the catalog");
	process.env.CODEMODE_ARENA = "unix:/nowhere";
	try { assert.equal(offeredTasks().some((x) => x.id === "beacon-bucht"), true); } finally { process.env.CODEMODE_ARENA = ""; }
	const p = teamPrompt({ task, lang: "en", agent: 0, gen: 1 }).user;
	assert.match(p, /tools\.act\(args\)/);
	assert.match(p, /fewest points/);
});

t("only a judge with an arena takes bot candidates; a run ends with the cheapest bot as best", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address; // the web process (in this test process) offers the bot task
	// two judges without an arena come first: neither may take a bot candidate
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "plain-1" }, { host: "plain-2" }, { host: "arena", arena: arena.address, workers: 1 }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/bots1/task", { taskId: "beacon-bucht" })).status, 200);
		for (const [author, source] of [["direkt", direct], ["vorsichtig", looksAlways], ["ohneholz", noWood]] as const) assert.equal((await post("/api/sessions/bots1/code", { author, source })).status, 200);
		let snap: any;
		for (const end = Date.now() + 60_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/bots1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.contributions?.length === 3 && snap.contributions.every((c: any) => c.ok !== null) && snap.best) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.author, c]));
		assert.deepEqual([by.direkt.ok, by.vorsichtig.ok, by.ohneholz.ok], [true, true, false]);
		assert.ok(snap.contributions.every((c: any) => c.host === "arena"), JSON.stringify(snap.contributions.map((c: any) => c.host)));
		assert.equal(snap.best.candidateId, by.direkt.candidateId);
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});

t("a scripted run on the bot task ends with the cheapest bot as best, its summary in tool points", async () => {
	const arena = await startFakeArena();
	process.env.CODEMODE_ARENA = arena.address;
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [{ host: "arena", arena: arena.address }] });
	try {
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/botrun/task", { taskId: "beacon-bucht" })).status, 200);
		assert.equal((await post("/api/sessions/botrun/run", { agents: 3, gens: 2, perAgent: 1, contenders: ["scripted"] })).status, 200);
		let snap: any;
		for (const end = Date.now() + 90_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/botrun")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.run && !snap.run.active && snap.contributions?.length >= 3 && snap.contributions.every((c: any) => c.ok !== null) && snap.best && snap.messages.some((m: any) => /^Run /.test(m.text))) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify([snap.run, snap.contributions?.map((c: any) => [c.author, c.ok, c.cost, c.error]), (await srv.stack.space.readAll({ type: "CodeCandidate" })).map((e: any) => [e.fields.author, e.fields.lane]), (await srv.stack.space.readAll({ type: "CodeJudging" })).map((e: any) => e.fields.author)])}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const correct = snap.contributions.filter((c: any) => c.ok);
		assert.ok(correct.length > 0);
		assert.equal(snap.contributions.find((c: any) => c.candidateId === snap.best.candidateId).cost, Math.min(...correct.map((c: any) => c.cost)));
		assert.ok(snap.messages.some((m: any) => /tool points/.test(m.text)), JSON.stringify(snap.messages.map((m: any) => m.text)));
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});
