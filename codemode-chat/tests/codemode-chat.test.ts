// Flow: task -> contribution -> score entry -> WebSocket frame, plus the sandbox verdicts and limits.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../server/index.ts";
import { startJudgeHost } from "../server/nano-host.ts";
import { judge, loadCodemode } from "../server/judge.ts";
import { customTask, taskById, TASKS } from "../server/tasks.ts";

const cm = await loadCodemode();
/** The room snapshot with the fields of the current task block lifted to the top level. */
const view = (snap: any) => ({ ...snap, ...(snap.blocks.find((b: any) => b.blockId === snap.current) ?? {}), messages: snap.messages });
const t = cm ? test : test.skip;
const post = async (base: string, path: string, body: unknown) => {
	const r = await fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as any };
};
const until = async <T>(fn: () => Promise<T | null | false>, ms = 20_000): Promise<T> => {
	const end = Date.now() + ms;
	for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error("timeout"); await new Promise((r) => setTimeout(r, 50)); }
};

t("every catalog task: its scripted variants are either correct or rejected, and at least one is correct", async () => {
	for (const task of TASKS) {
		const verdicts = await Promise.all(task.variants.map((v) => judge(cm!, task, v)));
		assert.ok(verdicts.some((v) => v.ok), `${task.id}: no correct variant`);
		assert.ok(verdicts.some((v) => !v.ok), `${task.id}: no wrong variant to reject`);
	}
});

t("hostile or broken source is only a failed verdict", async () => {
	const task = taskById("gcd")!;
	assert.equal((await judge(cm!, task, "function gcd(){ throw new Error('x') }")).ok, false);
	assert.equal((await judge(cm!, task, "function gcd(a,b){ return typeof process === 'undefined' ? 0 : 1 }")).ok, false);
	assert.equal((await judge(cm!, task, "function gcd(a,b){ while(true){} }")).ok, false);
	assert.equal((await judge(cm!, task, "x".repeat(20_000))).ok, false);
});

t("a custom task is checked against its cases", async () => {
	const task = customTask({ fn: "double", prompt: "double it", cases: [{ args: [2], expect: 4 }, { args: [5], expect: 10 }] });
	assert.equal((await judge(cm!, task, "function double(x){return x*2}")).ok, true);
	assert.equal((await judge(cm!, task, "function double(x){return x+x+1}")).ok, false);
	assert.throws(() => customTask({ fn: "bad name", prompt: "", cases: [] }));
});

t("contribution -> score entry -> websocket frame, with limits", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const frames: any[] = [];
		const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws/room1");
		ws.onmessage = (e) => frames.push(view(JSON.parse(String(e.data))));
		await until(async () => frames.length > 0);
		assert.equal(frames[0].type, "snapshot");
		assert.equal(frames[0].task.id, "primes");

		const good = taskById("primes")!.variants[2]!, bad = taskById("primes")!.variants[4]!;
		assert.equal((await post(srv.url, "/api/sessions/room1/code", { author: "alice", source: good })).status, 200);
		assert.equal((await post(srv.url, "/api/sessions/room1/code", { author: "bob", source: bad })).status, 200);
		const snap = await until(async () => { const s = frames.at(-1); return s && s.contributions.length === 2 && s.contributions.every((c: any) => c.ok !== null) ? s : false; });
		const by = Object.fromEntries(snap.contributions.map((c: any) => [c.author, c]));
		assert.equal(by.alice.ok, true);
		assert.equal(by.bob.ok, false);
		assert.equal(by.alice.source, good);
		assert.equal(snap.best.source, good);

		assert.equal((await post(srv.url, "/api/sessions/room1/code", { author: "x", source: "" })).status, 400);
		assert.equal((await post(srv.url, "/api/sessions/bad id/message", { author: "x", text: "y" })).status, 400);
		assert.equal((await fetch(srv.url + "/api/sessions/room1/message", { method: "POST", body: "{}" })).status, 404); // there is no chat input any more
		ws.close();
	} finally { await srv.close(); }
});

t("a scripted run produces graded contributions and a best", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		await post(srv.url, "/api/sessions/run1/task", { taskId: "gcd" });
		assert.equal((await post(srv.url, "/api/sessions/run1/run", { agents: 3, gens: 2, perAgent: 1, mode: "scripted" })).status, 200);
		const snap = await until(async () => { const s = await view(await (await fetch(srv.url + "/api/sessions/run1")).json()); return s.run && !s.run.active && s.contributions.length === 6 ? s : false; });
		assert.equal(snap.contributions.filter((c: any) => c.ok !== null).length, 6);
		assert.ok(snap.best);
		assert.equal((await post(srv.url, "/api/sessions/run1/task", { taskId: "nope" })).status, 400);
	} finally { await srv.close(); }
});

t("big and nano: candidates are judged on both hosts and come back as one list", async () => {
	const sock = `/tmp/codemode-test-${process.pid}.sock`;
	process.env.CODEMODE_HOST_NAME = "nano";
	const nano = await startJudgeHost({ listen: `unix:${sock}`, dbPath: null, judges: 2 });
	process.env.CODEMODE_HOST_NAME = "big";
	const srv = await startServer({ port: 0, bind: "127.0.0.1", remote: `unix:${sock}` });
	try {
		const good = taskById("primes")!.variants[2]!, bad = taskById("primes")!.variants[4]!;
		for (let i = 0; i < 4; i++) await post(srv.url, "/api/sessions/shard1/code", { author: `p${i}`, source: i % 2 ? bad : good });
		const snap = await until(async () => { const s = await view(await (await fetch(srv.url + "/api/sessions/shard1")).json()); return s.contributions.length === 4 && s.contributions.every((c: any) => c.ok !== null) ? s : false; });
		const hosts = new Set(snap.contributions.map((c: any) => c.host));
		assert.deepEqual([...hosts].sort(), ["big", "nano"]);
		assert.equal(snap.contributions.filter((c: any) => c.ok).length, 2);
		assert.equal(snap.best.source, good);
		const sys = await (await fetch(srv.url + "/api/system")).json() as any;
		assert.deepEqual(sys.shards.map((x: any) => [x.shard, x.up]), [["hub", true], ["nano", true]]);
		assert.equal(sys.shards[1].host.name, "nano");
		assert.ok(sys.shards[1].judged >= 1);
	} finally { await srv.close(); await nano.close(); delete process.env.CODEMODE_HOST_NAME; }
});

t("a dead shard falls back to the local judge", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1", remote: "unix:/tmp/codemode-nonexistent.sock" });
	try {
		const good = taskById("gcd")!.variants[2]!;
		await post(srv.url, "/api/sessions/dead1/task", { taskId: "gcd" });
		for (let i = 0; i < 3; i++) await post(srv.url, "/api/sessions/dead1/code", { author: `p${i}`, source: good });
		const snap = await until(async () => { const s = await view(await (await fetch(srv.url + "/api/sessions/dead1")).json()); return s.contributions.length === 3 && s.contributions.every((c: any) => c.ok) ? s : false; }, 60_000);
		assert.equal(snap.best.source, good);
		const sys = await (await fetch(srv.url + "/api/system")).json() as any;
		assert.equal(sys.shards[1].up, false);
	} finally { await srv.close(); }
});

t("several models compete in one run, assigned to the agents in turn", async () => {
	const seen: string[] = [];
	const task = taskById("gcd")!;
	const llm = {
		models: async () => ["fake/fast", "fake/slow"],
		contribute: async (c: { model?: string }) => { seen.push(c.model!); return { source: c.model === "fake/fast" ? task.variants[2]! : task.variants[1]!, model: c.model! }; },
	};
	const srv = await startServer({ port: 0, bind: "127.0.0.1", llm: llm as never });
	try {
		await post(srv.url, "/api/sessions/vs/task", { taskId: "gcd" });
		assert.equal((await post(srv.url, "/api/sessions/vs/run", { agents: 3, gens: 1, perAgent: 1, contenders: ["fake/fast", "fake/slow", "scripted"] })).status, 200);
		const snap = await until(async () => { const s = await view(await (await fetch(srv.url + "/api/sessions/vs")).json()); return s.run && !s.run.active && s.contributions.length === 3 && s.contributions.every((c: any) => c.ok !== null) ? s : false; });
		assert.deepEqual(snap.run.contenders, ["fake/fast", "fake/slow", "scripted"]);
		assert.deepEqual(snap.contributions.map((c: any) => c.via).sort(), ["fake/fast", "fake/slow", "scripted"]);
		assert.deepEqual(seen.sort(), ["fake/fast", "fake/slow"]);
		// unknown model, too many contenders, nothing chosen
		assert.equal((await post(srv.url, "/api/sessions/vs/run", { contenders: ["nope/model"] })).status, 400);
		assert.equal((await post(srv.url, "/api/sessions/vs/run", { contenders: ["scripted", "fake/fast", "fake/slow", "a", "b"] })).status, 400);
		assert.equal((await post(srv.url, "/api/sessions/vs/run", { contenders: [] })).status, 400);
	} finally { await srv.close(); }
});

t("every task is its own block with its own contributions and best code", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const get = async () => (await (await fetch(srv.url + "/api/sessions/blocks1")).json()) as any;
		const gcd = taskById("gcd")!, primes = taskById("primes")!;
		await post(srv.url, "/api/sessions/blocks1/task", { taskId: "gcd" });
		await post(srv.url, "/api/sessions/blocks1/code", { author: "a", source: gcd.variants[2]! });
		await until(async () => (await get()).blocks.at(-1).contributions.every((c: any) => c.ok !== null) && (await get()).blocks.at(-1).contributions.length === 1);
		await post(srv.url, "/api/sessions/blocks1/task", { taskId: "primes" });
		await post(srv.url, "/api/sessions/blocks1/code", { author: "b", source: primes.variants[3]! });
		const snap = await until(async () => { const s = await get(); return s.blocks.length === 3 && s.blocks.at(-1).contributions.length === 1 && s.blocks.at(-1).contributions[0].ok !== null ? s : false; });
		// block 0: the default first task (empty), 1: gcd, 2: primes
		assert.deepEqual(snap.blocks.map((b: any) => b.task.id), ["primes", "gcd", "primes"]);
		assert.equal(snap.blocks[1].contributions.length, 1);
		assert.equal(snap.blocks[1].best.source, gcd.variants[2]);
		assert.equal(snap.blocks[2].best.source, primes.variants[3]);
		assert.equal(snap.blocks[0].best, null);
		assert.equal(snap.current, snap.blocks[2].blockId);
		assert.equal(snap.blocks.filter((b: any) => b.active).length, 1);
		// the log lines of a block belong to it,
		assert.ok(snap.blocks[1].messages.some((m: any) => m.text.startsWith("Task: ")));
	} finally { await srv.close(); }
});

t("a custom task without a model has no scripted agents: the run is refused, hand-in code still works", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1", llm: { models: async () => [], contribute: async () => { throw new Error("off"); } } as never });
	try {
		await post(srv.url, "/api/sessions/cust1/task", { custom: { fn: "double", prompt: "double it", cases: [{ args: [2], expect: 4 }] } });
		assert.equal((await post(srv.url, "/api/sessions/cust1/run", { contenders: ["scripted"] })).status, 400);
		await post(srv.url, "/api/sessions/cust1/code", { author: "me", source: "function double(x){return x*2}" });
		const snap = await until(async () => { const s = await (await fetch(srv.url + "/api/sessions/cust1")).json() as any; const b = s.blocks.at(-1); return b.contributions.length === 1 && b.contributions[0].ok !== null ? s : false; });
		assert.equal(snap.blocks.at(-1).task.id, "custom");
		assert.equal(snap.blocks.at(-1).best.ms >= 0, true);
	} finally { await srv.close(); }
});

t("deleting a task block removes its entries; the active block moves on; a running block is protected", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const get = async () => (await (await fetch(srv.url + "/api/sessions/del1")).json()) as any;
		const judged = async () => ((await (await fetch(srv.url + "/api/system")).json()) as any).shards[0].judged as number;
		const gcd = taskById("gcd")!, primes = taskById("primes")!;
		await post(srv.url, "/api/sessions/del1/code", { author: "a", source: primes.variants[3]! }); // default block (primes)
		await until(async () => (await get()).blocks[0].contributions[0]?.ok !== undefined && (await get()).blocks[0].contributions[0]?.ok !== null);
		await post(srv.url, "/api/sessions/del1/task", { taskId: "gcd" });
		await post(srv.url, "/api/sessions/del1/code", { author: "b", source: gcd.variants[2]! });
		const snap = await until(async () => { const s = await get(); return s.blocks.length === 2 && s.blocks[1].contributions[0]?.ok === true ? s : false; });
		const [first, second] = snap.blocks.map((b: any) => b.blockId);
		assert.equal(await judged(), 2);

		// delete the older (not active) block: its score entry is gone, the active block stays
		assert.equal((await post(srv.url, "/api/sessions/del1/delete", { blockId: first })).status, 200);
		const afterFirst = await get();
		assert.deepEqual(afterFirst.blocks.map((b: any) => b.blockId), [second]);
		assert.equal(afterFirst.current, second);
		assert.equal(await judged(), 1);
		assert.ok(afterFirst.messages.some((m: any) => m.text.startsWith("Task block deleted")));

		// unknown block
		assert.equal((await post(srv.url, "/api/sessions/del1/delete", { blockId: "nope" })).status, 400);

		// delete the active block: a fresh first task takes over
		assert.equal((await post(srv.url, "/api/sessions/del1/delete", { blockId: second })).status, 200);
		const afterAll = await get();
		assert.equal(afterAll.blocks.length, 1);
		assert.equal(afterAll.blocks[0].task.id, "primes");
		assert.equal(afterAll.blocks[0].contributions.length, 0);
		assert.notEqual(afterAll.current, second);
		assert.equal(await judged(), 0);

		// a block with a running run cannot be deleted
		await post(srv.url, "/api/sessions/del1/run", { agents: 2, gens: 3, perAgent: 1, contenders: ["scripted"] });
		assert.equal((await post(srv.url, "/api/sessions/del1/delete", { blockId: afterAll.current })).status, 400);
		await post(srv.url, "/api/sessions/del1/stop", {});
		await until(async () => { const s = await get(); return s.run && !s.run.active; });
		assert.equal((await post(srv.url, "/api/sessions/del1/delete", { blockId: afterAll.current })).status, 200);
	} finally { await srv.close(); }
});

t("deleting a block also removes its verdicts on the nano shard", async () => {
	const sock = `/tmp/codemode-del-${process.pid}.sock`;
	process.env.CODEMODE_HOST_NAME = "nano";
	const nano = await startJudgeHost({ listen: `unix:${sock}`, dbPath: null, judges: 2 });
	process.env.CODEMODE_HOST_NAME = "big";
	const srv = await startServer({ port: 0, bind: "127.0.0.1", remote: `unix:${sock}` });
	try {
		const get = async () => (await (await fetch(srv.url + "/api/sessions/del2")).json()) as any;
		const sys = async () => (await (await fetch(srv.url + "/api/system")).json()) as any;
		const good = taskById("primes")!.variants[2]!;
		for (let i = 0; i < 4; i++) await post(srv.url, "/api/sessions/del2/code", { author: `p${i}`, source: good });
		const snap = await until(async () => { const s = await get(); const b = s.blocks[0]; return b.contributions.length === 4 && b.contributions.every((c: any) => c.ok !== null) ? s : false; });
		const before = await sys();
		assert.equal(before.shards[0].judged + before.shards[1].judged, 4);
		assert.ok(before.shards[1].judged >= 1);
		assert.equal((await post(srv.url, "/api/sessions/del2/delete", { blockId: snap.blocks[0].blockId })).status, 200);
		const after = await sys();
		assert.equal(after.shards[0].judged + after.shards[1].judged, 0);
	} finally { await srv.close(); await nano.close(); delete process.env.CODEMODE_HOST_NAME; }
});

t("a task block from before blockIds existed can be deleted, with its orphaned entries", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const at = Date.now() - 60_000;
		// what an older version wrote: no blockId on any of them
		await srv.hub.host.write({ type: "CodeTask", fields: { session: "old1", taskId: "gcd", ts: at } } as never, null, 3_600_000);
		await srv.hub.host.write({ type: "CodeScore", fields: { session: "old1", candidateId: "x1", author: "a", via: "scripted", gen: 1, ok: true, ms: 5, source: "function gcd(){}", ts: at + 1 } } as never, null, 3_600_000);
		await srv.hub.host.write({ type: "ChatMessage", fields: { session: "old1", author: "system", text: "Task: Greatest common divisor (gcd)", ts: at } } as never, null, 3_600_000);
		const get = async () => (await (await fetch(srv.url + "/api/sessions/old1")).json()) as any;
		const snap = await get();
		assert.equal(snap.blocks.length, 1);
		assert.equal(snap.blocks[0].task.id, "gcd");
		assert.equal((await post(srv.url, "/api/sessions/old1/delete", { blockId: snap.blocks[0].blockId })).status, 200);
		const after = await get();
		assert.equal(after.blocks.length, 1); // a fresh first task took its place
		assert.notEqual(after.blocks[0].blockId, snap.blocks[0].blockId);
		assert.equal(after.blocks[0].task.id, "primes");
		const sys = (await (await fetch(srv.url + "/api/system")).json()) as any;
		assert.equal(sys.shards[0].judged, 0); // the orphaned score is gone too
		assert.ok(!after.messages.some((m: any) => m.text.startsWith("Task: Greatest")));
	} finally { await srv.close(); }
});
