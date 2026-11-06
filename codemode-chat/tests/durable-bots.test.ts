// Durable runs (server/durable-run.ts, docs/codemode-anwendungen.en.md D): a long bot run survives its judge. Every
// answer of the world is logged before the bot gets it; a judge that takes over replays the log and goes on in the same
// world, and a call that was on its way is not carried out twice. Here the arena is tests/fake-arena.ts.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "./stack.ts";
import { startFakeArena } from "./fake-arena.ts";
import { judge, loadCodemode, memoryLog } from "../server/judge.ts";
import { LogDown, type CallLog } from "../server/durable-run.ts";
import { taskById } from "../server/tasks.ts";

const cm = await loadCodemode();
const t = cm ? test : test.skip;
const task = taskById("beacon-flut")!;
const [gatherer, looker, noWait, quitter] = task.variants;
/** The gatherer with two looks at once in every round: answers come back in another order than they were asked. */
const parallel = gatherer!.replace("s=await tools.look()}return fed}", "const [a]=await Promise.all([tools.look(),tools.look()]);s=a}return fed}");

async function withArena<T>(address: string, fn: () => Promise<T>): Promise<T> {
	const was = process.env.CODEMODE_ARENA;
	process.env.CODEMODE_ARENA = address;
	try { return await fn(); } finally { process.env.CODEMODE_ARENA = was ?? ""; }
}
/** A log that fails its `n`-th append, as a judge dying there would: the answer reached the judge (and the world
 *  carried the call out) but never the log. */
function dyingLog(log: CallLog, n: number): CallLog {
	let k = 0;
	return { ...log, append: async (c) => { if (++k === n) throw new Error("the judge died"); await log.append(c); } };
}

t("the tide bot: the gatherer is cheapest, the one that never waits and the one that gives up miss the goal", async () => {
	const arena = await startFakeArena();
	try {
		const [a, b, c, d] = await withArena(arena.address, () => Promise.all([gatherer, looker, noWait, quitter].map((v) => judge(cm!, task, v!))));
		for (const v of [a!, b!]) assert.equal(v.ok, true, v.error ?? "");
		assert.deepEqual([a!.cost, a!.calls], [48, { look: 13, act: 23, wait: 12 }]);
		assert.ok(b!.cost! > a!.cost!);
		assert.match(c!.error!, /goal not reached: 2 of 6 pieces/);
		assert.match(d!.error!, /goal not reached: 4 of 6 pieces/);
		assert.equal(arena.open(), 0, "every world closed");
	} finally { await arena.close(); }
});

t("a run whose judge died goes on from its log in the same world: same verdict, no command twice", async () => {
	const arena = await startFakeArena();
	try {
		for (const [source, at] of [[gatherer!, 20], [parallel, 17]] as const) {
			const straight = await withArena(arena.address, () => judge(cm!, task, source));
			assert.equal(straight.ok, true, straight.error ?? "");
			const acts0 = arena.acts(), opened0 = arena.opened();
			const log = memoryLog();
			// the log could not be written: no verdict, the candidate would go back
			await withArena(arena.address, () => assert.rejects(judge(cm!, task, source, { log: dyingLog(log, at) }), LogDown));
			assert.equal((await log.calls()).length, at - 1, "the log holds what was logged before the death");
			assert.equal(arena.open(), 1, "the world outlives its judge");
			const resumed = await withArena(arena.address, () => judge(cm!, task, source, { log }));
			assert.equal(resumed.ok, true, resumed.error ?? "");
			assert.deepEqual([resumed.cost, resumed.calls], [straight.cost, straight.calls]);
			assert.match(resumed.cases[0]!.got!, new RegExp(`${at - 1} of them replayed from the log`));
			assert.equal(arena.opened() - opened0, 1, "one world for both judges");
			assert.equal(arena.acts() - acts0, straight.calls!.act, "every command carried out once");
		}
	} finally { await arena.close(); }
});

t("a log that does not fit starts afresh: another script, a world the arena lost", async () => {
	const arena = await startFakeArena();
	try {
		// another script's log: the run diverges at once and starts over in a world of its own
		const log = memoryLog();
		await withArena(arena.address, () => assert.rejects(judge(cm!, task, looker!, { log: dyingLog(log, 10) }), LogDown));
		const opened = arena.opened();
		const v = await withArena(arena.address, () => judge(cm!, task, gatherer!, { log }));
		assert.equal(v.ok, true, v.error ?? "");
		assert.equal(v.cost, 48);
		assert.equal(arena.opened() - opened, 1);
		// the arena lost the world (a restart): the run starts afresh too
		const log2 = memoryLog();
		await withArena(arena.address, () => assert.rejects(judge(cm!, task, gatherer!, { log: dyingLog(log2, 15) }), LogDown));
		arena.drop((await log2.head())!.world);
		const w = await withArena(arena.address, () => judge(cm!, task, gatherer!, { log: log2 }));
		assert.equal(w.ok, true, w.error ?? "");
		assert.doesNotMatch(w.cases[0]!.got!, /replayed/);
	} finally { await arena.close(); }
});

t("a judge process killed in the middle of a long run: another judge finishes it from the log in the space", async () => {
	const arena = await startFakeArena({ opMs: 40 });
	process.env.CODEMODE_ARENA = arena.address;
	const srv = await startServer({ port: 0, bind: "127.0.0.1", judges: [] });
	try {
		const first = await srv.stack.judge({ host: "first", arena: arena.address, workers: 1, leaseMs: 1500 });
		const post = (path: string, body: unknown) => fetch(srv.url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		assert.equal((await post("/api/sessions/flut1/task", { taskId: "beacon-flut" })).status, 200);
		assert.equal((await post("/api/sessions/flut1/code", { author: "sammler", source: gatherer })).status, 200);
		const space = srv.stack.space;
		for (const end = Date.now() + 30_000; (await space.count({ type: "BotCall" })) < 20;) {
			if (Date.now() > end) throw new Error("the run did not get going");
			await new Promise((r) => setTimeout(r, 20));
		}
		await srv.stack.kill(first, "SIGKILL");
		const loggedAtDeath = await space.count({ type: "BotCall" });
		assert.ok(loggedAtDeath >= 20 && loggedAtDeath < 48, String(loggedAtDeath));
		await srv.stack.judge({ host: "second", arena: arena.address, workers: 1 });
		let snap: any;
		for (const end = Date.now() + 60_000; ;) {
			const s = await (await fetch(srv.url + "/api/sessions/flut1")).json() as any;
			snap = { ...s, ...(s.blocks.find((b: any) => b.blockId === s.current) ?? {}) };
			if (snap.contributions?.length === 1 && snap.contributions[0].ok !== null) break;
			if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(snap.contributions)}`);
			await new Promise((r) => setTimeout(r, 100));
		}
		const c = snap.contributions[0];
		assert.equal(c.ok, true, c.error);
		assert.equal(c.host, "second");
		assert.equal(c.cost, 48);
		assert.equal(arena.acts(), 23, "no command twice across the two judges");
		assert.equal(arena.opened(), 1);
		assert.ok(arena.idleMs()! >= 1500 + 60_000, `the world waits longer than the judge's lease: ${arena.idleMs()}`);
		for (const end = Date.now() + 5_000; (await space.count({ type: "BotCall" })) + (await space.count({ type: "BotRun" })) > 0;) {
			if (Date.now() > end) throw new Error("the log was not taken away");
			await new Promise((r) => setTimeout(r, 50));
		}
	} finally { await srv.close(); await arena.close(); process.env.CODEMODE_ARENA = ""; }
});
