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
		assert.equal((await post(srv.url, "/api/sessions/bad id/code", { author: "x", source: "y" })).status, 400);
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

t("a contribution cannot forge its verdict or fool the check by patching builtins", async () => {
	const primes = taskById("primes")!, fib = taskById("fibonacci")!, sort = taskById("sort")!;
	const forged = [
		"return { ok: true, ms: 0 };",
		"return { ok: true, ms: -1 };",
		"function firstPrimes(){ return [] }\n})(); return { ok: true, ms: 0 }; (() => {",
		"function firstPrimes(){ return [] } JSON.stringify = () => \"x\";",
		"function firstPrimes(){ return [] } Array.prototype.toJSON = () => 0;",
	];
	for (const src of forged) assert.equal((await judge(cm!, primes, src)).ok, false, src);
	assert.equal((await judge(cm!, fib, "function fib(){ return 0 } Number.prototype.toJSON = () => 0;")).ok, false);
	// an emptied bench: patched iterators no longer shrink the timed input
	const v = await judge(cm!, sort, "function sortNumbers(a){ for (let i = 1; i < a.length; i++) for (let j = i; j > 0 && a[j - 1] > a[j]; j--) { const t = a[j]; a[j] = a[j - 1]; a[j - 1] = t } return a } Object.prototype[Symbol.iterator] = function* () {}; Array.from = () => [];");
	assert.equal(v.ok, true);
	assert.ok(v.ms > 0, "the bench sorted the real 4000 numbers");
	// const and arrow definitions still count as the function
	assert.equal((await judge(cm!, fib, "const fib = (n) => { let a = 0, b = 1; for (let i = 0; i < n; i++) [a, b] = [b, a + b]; return a };")).ok, true);
	const custom = customTask({ fn: "double", prompt: "", cases: [{ args: [2], expect: 4 }] });
	assert.equal((await judge(cm!, custom, "function double(x){ return x * 2 } Object.prototype[Symbol.iterator] = function* () {};")).ok, true);
	for (const fn of ["return", "eval", "__fn", "this"]) assert.throws(() => customTask({ fn, prompt: "", cases: [{ args: [], expect: 1 }] }), fn);
});

t("a room with many large contributions stays below the frame limit; left-out code is fetched on demand", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const first = (await (await fetch(srv.url + "/api/sessions/big1")).json()) as any;
		const src = "function firstPrimes(n){return []}\n" + "//".padEnd(15_900, "x");
		for (let i = 0; i < 70; i++) await srv.hub.host.write({ type: "CodeScore", fields: { session: "big1", blockId: first.current, candidateId: `c${i}`, author: "x", via: "human", gen: 0, ok: false, ms: 5000, source: src, ts: Date.now() + i } } as never, null, 3_600_000);
		const raw = await (await fetch(srv.url + "/api/sessions/big1")).text();
		assert.ok(Buffer.byteLength(raw) < 600_000, `snapshot ${Buffer.byteLength(raw)} bytes`);
		const cs = JSON.parse(raw).blocks[0].contributions as any[];
		const omitted = cs.filter((c) => c.sourceOmitted);
		assert.ok(omitted.length > 0 && omitted.length < 70);
		assert.ok(cs.filter((c) => !c.sourceOmitted).every((c) => c.source === src));
		const r = await fetch(`${srv.url}/api/sessions/big1/source/${omitted[0].candidateId}`);
		assert.equal(((await r.json()) as any).source, src);
		assert.equal((await fetch(`${srv.url}/api/sessions/big1/source/nope`)).status, 404);
		// the WebSocket frame arrives (it used to exceed 1 MiB and close the socket)
		const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws/big1");
		const frame = await new Promise<any>((ok, no) => { ws.onmessage = (e) => ok(JSON.parse(String(e.data))); ws.onclose = () => no(new Error("closed")); });
		assert.equal(frame.blocks[0].contributions.length, 70);
		ws.close();
	} finally { await srv.close(); }
});

t("two concurrent run starts: exactly one wins", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		await post(srv.url, "/api/sessions/race1/task", { taskId: "gcd" });
		const body = { agents: 1, gens: 1, perAgent: 1, contenders: ["scripted"] };
		const codes = (await Promise.all([post(srv.url, "/api/sessions/race1/run", body), post(srv.url, "/api/sessions/race1/run", body)])).map((r) => r.status).sort();
		assert.deepEqual(codes, [200, 400]);
		await until(async () => { const s = (await (await fetch(srv.url + "/api/sessions/race1")).json()) as any; return s.run && !s.run.active; });
	} finally { await srv.close(); }
});

t("idle rooms make way for new ones; candidates left in the store are judged when their room loads", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		for (let i = 0; i < 52; i++) await srv.hub.session(`idle${i}`);
		// what a restart leaves behind: a block and a candidate of it that nobody judges yet
		await srv.hub.host.write({ type: "CodeTask", fields: { session: "left1", blockId: "bL", taskId: "gcd", ts: Date.now() } } as never, null, 3_600_000);
		await srv.hub.host.write({ type: "CodeCandidate", fields: { session: "left1", blockId: "bL", taskId: "gcd", candidateId: "l1", author: "a", via: "human", gen: 0, source: taskById("gcd")!.variants[2]!, ts: Date.now() } } as never, null, 3_600_000);
		const s = await until(async () => { const v = (await (await fetch(srv.url + "/api/sessions/left1")).json()) as any; const c = v.blocks.flatMap((b: any) => b.contributions).find((x: any) => x.candidateId === "l1"); return c?.ok === true ? c : false; });
		assert.equal(s.ok, true);
	} finally { await srv.close(); }
});

t("switching the model agents needs the admin token; the per-IP quota answers 429", async () => {
	process.env.CODEMODE_REQ_PER_MIN = "5";
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	process.env.CODEMODE_REQ_PER_MIN = "100000";
	try {
		assert.equal((await post(srv.url, "/api/llm", { on: false })).status, 403);
		process.env.CODEMODE_ADMIN_TOKEN = "secret-test";
		const ok = await fetch(srv.url + "/api/llm", { method: "POST", headers: { "x-admin-token": "secret-test" }, body: "{}" });
		assert.equal(ok.status, 200);
		const wrong = await fetch(srv.url + "/api/llm", { method: "POST", headers: { "x-admin-token": "nope" }, body: "{}" });
		assert.equal(wrong.status, 403);
		const statuses: number[] = [];
		for (let i = 0; i < 4; i++) statuses.push((await fetch(srv.url + "/api/sessions/q1")).status);
		assert.equal(statuses.at(-1), 429);
		assert.equal((await fetch(srv.url + "/healthz")).status, 200); // outside the API quota
	} finally { process.env.CODEMODE_ADMIN_TOKEN = ""; await srv.close(); }
});

t("code that is right only on the small cases does not win the bench", async () => {
	const sort = taskById("sort")!, gcdT = taskById("gcd")!, fib = taskById("fibonacci")!;
	// sorts the cases, answers the 4000-number bench with an empty shape
	assert.equal((await judge(cm!, sort, "function sortNumbers(a){ return a.length === 4000 ? { length: 4000 } : [...a].sort((x, y) => x - y) }")).ok, false);
	assert.equal((await judge(cm!, gcdT, "function gcd(a,b){ if (a > 100000) return 1; while (b) [a, b] = [b, a % b]; return a }")).ok, false);
	assert.equal((await judge(cm!, fib, "const t = [0,1,1,2,3,5,8,13,21,34,55]; function fib(n){ if (n === 40) return 102334155; if (n === 70) return 190392490709135; return t[n] ?? 0 }")).ok, false);
	// a call counter: right for the case calls, then 0
	const custom = customTask({ fn: "double", prompt: "", cases: [{ args: [2], expect: 4 }, { args: [3], expect: 6 }] });
	assert.equal((await judge(cm!, custom, "let calls = 0; function double(x){ return ++calls <= 2 ? x * 2 : 0 }")).ok, false);
	// every catalog task still accepts its fastest honest variant
	for (const task of TASKS) assert.ok((await Promise.all(task.variants.map((v) => judge(cm!, task, v)))).some((v) => v.ok), task.id);
});

t("code full of control characters does not blow the frame up (JSON escapes count)", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		const first = (await (await fetch(srv.url + "/api/sessions/esc1")).json()) as any;
		const src = "\u0001".repeat(15_000);
		for (let i = 0; i < 60; i++) await srv.hub.host.write({ type: "CodeScore", fields: { session: "esc1", blockId: first.current, candidateId: `e${i}`, author: "\u0002".repeat(40), via: "human", gen: 0, ok: false, ms: 5000, error: "\u0003".repeat(200), source: src, ts: Date.now() + i } } as never, null, 3_600_000);
		const ws = new WebSocket(srv.url.replace("http", "ws") + "/ws/esc1");
		const frame = await new Promise<any>((ok, no) => { ws.onmessage = (e) => ok(e.data); ws.onclose = () => no(new Error("closed")); });
		assert.ok(Buffer.byteLength(String(frame)) < 1_000_000, `frame ${Buffer.byteLength(String(frame))} bytes`);
		assert.equal(JSON.parse(String(frame)).blocks[0].contributions.length, 60);
		ws.close();
		// what the hub writes itself is plain: a human author loses its control characters
		await post(srv.url, "/api/sessions/esc1/code", { author: "a\u0001b", source: "function firstPrimes(){ return [] }" });
		const mine = await until(async () => { const s = (await (await fetch(srv.url + "/api/sessions/esc1")).json()) as any; return s.blocks[0].contributions.find((c: any) => c.author === "a b") ?? false; });
		assert.equal(mine.author, "a b");
	} finally { await srv.close(); }
});

test("CODEMODE_TTL_HOURS: hours to a lease, 0 = no expiry, garbage refused", async () => {
	const { entryLeaseMs } = await import("../server/shard.ts");
	const { FOREVER } = await import("../../src/index.ts");
	assert.equal(entryLeaseMs(undefined), 24 * 3600_000);
	assert.equal(entryLeaseMs(""), 24 * 3600_000);
	assert.equal(entryLeaseMs("168"), 168 * 3600_000);
	assert.equal(entryLeaseMs("0.5"), 1800_000);
	assert.equal(entryLeaseMs("0"), FOREVER);
	for (const bad of ["-1", "abc", "Infinity"]) assert.throws(() => entryLeaseMs(bad), bad);
});

/** Reads an NDJSON run response line by line until it ends. */
const readRun = async (r: Response) => {
	const out: any[] = [], reader = r.body!.getReader(), dec = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		buf += dec.decode(value, { stream: true });
		for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) { const l = buf.slice(0, i); buf = buf.slice(i + 1); if (l) out.push(JSON.parse(l)); }
	}
	return out;
};

t("▶ runs a contribution: cases, console lines and the own call stream back; nothing is scored", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		await post(srv.url, "/api/sessions/exec1/task", { taskId: "gcd" });
		const { body } = await post(srv.url, "/api/sessions/exec1/code", { author: "a", source: "function gcd(a,b){ console.log('gcd', a, b); while (b) [a, b] = [b, a % b]; return a }" });
		await until(async () => { const s = (await (await fetch(srv.url + "/api/sessions/exec1")).json()) as any; return s.blocks.at(-1).contributions[0]?.ok === true; });
		const judgedBefore = ((await (await fetch(srv.url + "/api/system")).json()) as any).shards[0].judged;
		const r = await fetch(srv.url + "/api/sessions/exec1/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: body.candidateId, call: "gcd(84, 36)" }) });
		assert.equal(r.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
		const ev = await readRun(r);
		assert.deepEqual(ev[0], { t: "start", fn: "gcd", cases: 6 });
		assert.equal(ev.filter((e) => e.t === "case").length, 6);
		assert.ok(ev.filter((e) => e.t === "case").every((e) => e.ok));
		assert.ok(ev.some((e) => e.t === "log" && e.text === "gcd 84 36"));
		assert.deepEqual(ev.find((e) => e.t === "value"), { t: "value", call: "gcd(84, 36)", text: "12" });
		assert.equal(ev.at(-1).t, "end");
		assert.equal(ev.at(-1).status, "ok");
		assert.equal(((await (await fetch(srv.url + "/api/system")).json()) as any).shards[0].judged, judgedBefore); // a run is no verdict
		assert.equal((await post(srv.url, "/api/sessions/exec1/exec", { candidateId: "nope" })).status, 404);
		assert.equal((await post(srv.url, "/api/sessions/exec1/exec", { candidateId: "bad id!" })).status, 400);
	} finally { await srv.close(); }
});

t("▶ Stop aborts a long run; a second run from the same client meanwhile is refused", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		await post(srv.url, "/api/sessions/exec2/task", { taskId: "gcd" });
		const { body } = await post(srv.url, "/api/sessions/exec2/code", { author: "a", source: "function gcd(a){ for (let k = 0; ; k++) { const e = Date.now() + 100; while (Date.now() < e) {} console.log('tick', k) } }" });
		const ac = new AbortController();
		const r = await fetch(srv.url + "/api/sessions/exec2/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: body.candidateId }), signal: ac.signal });
		const reader = r.body!.getReader(), dec = new TextDecoder();
		let seen = "";
		assert.equal(r.status, 200); // also while the judge holds the candidate (it loops there too, for 5 s)
		while (!seen.includes("tick 2")) { const x = await reader.read(); assert.ok(!x.done, seen); seen += dec.decode(x.value, { stream: true }); } // live output while it runs
		assert.equal((await post(srv.url, "/api/sessions/exec2/exec", { candidateId: body.candidateId })).status, 429);
		const t0 = Date.now();
		ac.abort();
		await until(async () => (await import("../server/runner.ts")).execRunning() === 0, 5_000);
		assert.ok(Date.now() - t0 < 5_000);
		// the client's slot is free again
		const again = await fetch(srv.url + "/api/sessions/exec2/exec", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ candidateId: body.candidateId }) });
		assert.equal(again.status, 200);
		await again.body!.cancel();
	} finally { await srv.close(); }
});

// ---- teamwork: partial results, check rules, the team prompt, runs until solved ----

const GOLOMB_RULE = "(r, [n, len]) => Array.isArray(r) && r.length === n && r[0] === 0 && r[n - 1] === len && new Set(r.flatMap((a, i) => r.slice(i + 1).map((b) => b - a))).size === n * (n - 1) / 2";

t("every case is reported: a contribution that passes some cases shows how far it got", async () => {
	const task = customTask({ fn: "inc", prompt: "", cases: [{ args: [1], expect: 2 }, { args: [5], expect: 6 }, { args: [0], expect: 1 }] });
	const v = await judge(cm!, task, "function inc(x){ if (x === 0) throw new Error('zero'); return x === 5 ? 7 : x + 1 }");
	assert.equal(v.ok, false);
	assert.equal(v.passed, 1);
	assert.equal(v.total, 3);
	assert.deepEqual(v.cases.map((c) => [c.call, c.ok]), [["inc(1)", true], ["inc(5)", false], ["inc(0)", false]]);
	assert.equal(v.cases[1]!.got, "7");
	assert.equal(v.cases[1]!.expect, "6");
	assert.equal(v.cases[2]!.error, "zero");
	const good = await judge(cm!, task, "function inc(x){ return x + 1 }");
	assert.deepEqual([good.ok, good.passed, good.total], [true, 3, 3]);
});

t("a check rule accepts every right answer, and patched builtins cannot fool it", async () => {
	const task = customTask({ fn: "golomb", prompt: "Golomb ruler", cases: [{ args: [5, 11] }], check: GOLOMB_RULE });
	assert.equal((await judge(cm!, task, "function golomb(){ return [0, 1, 4, 9, 11] }")).ok, true);
	assert.equal((await judge(cm!, task, "function golomb(){ return [0, 2, 7, 10, 11] }")).ok, true); // the mirror image
	const wrong = await judge(cm!, task, "function golomb(){ return [0, 1, 2, 3, 11] }");
	assert.deepEqual([wrong.ok, wrong.passed], [false, 0]);
	// the rule runs in a fresh sandbox: the contribution's patches do not reach it
	assert.equal((await judge(cm!, task, "function golomb(){ return [0, 1, 2, 3, 11] } globalThis.Set = function () { return { size: 10 } }; Array.prototype.flatMap = () => [1,2,3,4,5,6,7,8,9,10];")).ok, false);
	// a call counter: right on the case call, garbage in the bench rounds
	assert.equal((await judge(cm!, task, "let n = 0; function golomb(){ return ++n === 1 ? [0, 1, 4, 9, 11] : [] }")).ok, false);
	assert.throws(() => customTask({ fn: "f", prompt: "", cases: [{ args: [] }] as never }), /expect/); // no rule: expect needed
});

t("a slow function is timed per round, not timed out", async () => {
	const task = customTask({ fn: "slow", prompt: "", cases: [{ args: [1], expect: 1 }, { args: [2], expect: 2 }] });
	const v = await judge(cm!, task, "function slow(x){ const e = Date.now() + 250; while (Date.now() < e) {} return x }");
	assert.equal(v.ok, true, v.error ?? "");
	assert.ok(v.ms >= 450 && v.ms < 1500, `ms per round ${v.ms}`);
});

test("the team prompt: cases, role, the attempt to build on with its results, others and notes", async () => {
	const { teamPrompt } = await import("../server/llm.ts");
	const task = customTask({ fn: "golomb", prompt: "Golomb ruler of order n and length len", cases: [{ args: [5, 11] }], check: GOLOMB_RULE });
	const target = { candidateId: "c1", author: "agent-1", via: "m/a", gen: 1, ok: false, ms: null, passed: 0, total: 1, error: "wrong on golomb(5, 11)", cases: [{ call: "golomb(5, 11)", ok: false, got: "[0,1,2,3,11]" }], source: "function golomb(n, len){ return [0,1,2,3,len] }" };
	const p = teamPrompt({ task, lang: "en", agent: 2, gen: 1, role: "repair", target, others: [{ ...target, candidateId: "c2", author: "agent-0", source: "function golomb(){}" }], notes: [{ author: "agent-0", gen: 1, text: "distances must all differ" }] });
	for (const want of ["golomb(5, 11)", "check rule", GOLOMB_RULE, "REPAIR", "agent-1", "✗ golomb(5, 11) → [0,1,2,3,11]", "function golomb(n, len)", "agent-0", "distances must all differ", "NOTE:"]) assert.ok(p.user.includes(want), want);
	assert.match(p.system, /team/);
	const cat = teamPrompt({ task: taskById("fibonacci")!, lang: "en", agent: 0, gen: 0 });
	assert.ok(cat.user.includes("fib(10) must return 55") && cat.user.includes("EXPLORE"));
});

test("roles: repair close attempts, explore every third turn, improve once solved", async () => {
	const { CodeChatHub } = await import("../server/hub.ts");
	const a = (id: string, ok: boolean, passed: number) => ({ candidateId: id, author: id, via: "m", gen: 1, ok, ms: ok ? 5 : null, passed, total: 3, source: "" });
	assert.deepEqual([0, 1, 2].map((k) => CodeChatHub.plan([], k).role), ["explore", "explore", "explore"]);
	const failing = [a("x", false, 2), a("y", false, 1)];
	assert.deepEqual([0, 1, 2, 3].map((k) => [CodeChatHub.plan(failing, k).role, CodeChatHub.plan(failing, k).target?.candidateId ?? null]), [["repair", "x"], ["repair", "y"], ["explore", null], ["repair", "y"]]);
	assert.deepEqual([0, 2].map((k) => CodeChatHub.plan([a("ok", true, 3), ...failing], k).role), ["improve", "explore"]);
});

t("a team run: a teammate repairs a close attempt, leaves a note, and the run ends once solved", async () => {
	const seen: Array<{ role?: string; target?: string | null; passed?: number; notes: number }> = [];
	const llm = {
		models: async () => ["fake/team"],
		contribute: async (c: any) => {
			seen.push({ role: c.role, target: c.target?.author ?? null, passed: c.target?.passed, notes: c.notes?.length ?? 0 });
			if (c.role === "repair" && c.target) return { source: "function double(x){ return x * 2 }", model: "fake/team", note: "multiply by two, do not add" };
			return { source: "function double(x){ return x + 2 }", model: "fake/team" }; // right for 2 only: 1 of 2 cases
		},
	};
	const srv = await startServer({ port: 0, bind: "127.0.0.1", llm: llm as never });
	try {
		await post(srv.url, "/api/sessions/team1/task", { custom: { fn: "double", prompt: "double it", cases: [{ args: [2], expect: 4 }, { args: [5], expect: 10 }] } });
		assert.equal((await post(srv.url, "/api/sessions/team1/run", { agents: 2, gens: 6, perAgent: 1, polish: 0, contenders: ["fake/team"] })).status, 200);
		const snap = await until(async () => { const s = (await (await fetch(srv.url + "/api/sessions/team1")).json()) as any; return s.run && !s.run.active ? s : false; }, 60_000);
		const b = snap.blocks.at(-1);
		assert.equal(snap.run.solvedGen, 2);
		assert.equal(snap.run.gen, 2); // stopped once solved, not after 6 generations
		assert.deepEqual(b.contributions.map((c: any) => [c.gen, c.role, c.ok, c.passed]).sort(), [[1, "explore", false, 1], [1, "explore", false, 1], [2, "repair", true, 2], [2, "repair", true, 2]]);
		const repaired = b.contributions.find((c: any) => c.role === "repair");
		assert.ok(b.contributions.some((c: any) => c.candidateId === repaired.basedOn), "the repair names the attempt it built on");
		assert.deepEqual(seen.slice(2).map((x) => [x.role, x.passed]), [["repair", 1], ["repair", 1]]); // generation 2 saw how far gen 1 got
		assert.equal(b.notes.length, 2);
		assert.equal(b.notes[0].text, "multiply by two, do not add");
		assert.ok(b.messages.some((m: any) => /solved in generation 2/.test(m.text)));
		const d = (await (await fetch(`${srv.url}/api/sessions/team1/source/${b.contributions.find((c: any) => !c.ok).candidateId}`)).json()) as any;
		assert.deepEqual(d.cases.map((c: any) => [c.call, c.ok]), [["double(5)", false], ["double(2)", true]]); // failing first
	} finally { await srv.close(); }
});

// ---- several right results: alternatives in the cases, and the verifier agent's check rule ----

t("a case with several right results accepts any of them, and only its own", async () => {
	const task = customTask({ fn: "root", prompt: "a square root", cases: [{ args: [4], expectAny: [2, -2] }, { args: [9], expect: 3 }] });
	assert.equal((await judge(cm!, task, "function root(x){ return -Math.sqrt(x) === -3 ? 3 : -2 }")).ok, true);
	const wrong = await judge(cm!, task, "function root(x){ return 3 }");
	assert.deepEqual([wrong.ok, wrong.passed], [false, 1]);
	assert.equal(wrong.cases.find((c) => !c.ok)!.expect, "2 or -2");
	// expectations are the case's own: a patched prototype cannot add one
	assert.equal((await judge(cm!, task, "function root(){ const o = {}; Object.prototype.expectAny = [o]; Object.prototype.expect = o; return o }")).ok, false);
});

t("the cross-check of a rule: it must accept the examples and reject obvious wrong results, for any kind of task", async () => {
	const { testRule } = await import("../server/judge.ts");
	const { expectedOf } = await import("../server/tasks.ts");
	const golomb = customTask({ fn: "golomb", prompt: "", cases: [{ args: [5, 11], expect: [0, 1, 4, 9, 11] }] });
	assert.equal(await testRule(cm!, golomb, GOLOMB_RULE, expectedOf), null);
	assert.match((await testRule(cm!, golomb, "() => true", expectedOf))!, /accepts the wrong result null/);
	assert.match((await testRule(cm!, golomb, "(r) => Array.isArray(r) && r.length === 4", expectedOf))!, /rejects the right result/);
	assert.match((await testRule(cm!, golomb, "(r) => r !== null", expectedOf))!, /too many wrong results/);
	assert.match((await testRule(cm!, golomb, "(r) => {", expectedOf))!, /does not run/);
	const root = customTask({ fn: "root", prompt: "", cases: [{ args: [4], expect: 2 }, { args: [9], expect: 3 }] });
	assert.equal(await testRule(cm!, root, "(r, [x]) => typeof r === 'number' && Math.abs(r * r - x) < 1e-9", expectedOf), null);
	const sort = customTask({ fn: "sortDesc", prompt: "", cases: [{ args: [[1, 3, 2]], expect: [3, 2, 1] }] });
	assert.equal(await testRule(cm!, sort, "(r, [a]) => Array.isArray(r) && r.length === a.length && r.every((v, i) => i === 0 || r[i - 1] >= v) && [...a].sort().join() === [...r].sort().join()", expectedOf), null);
});

t("the verifier agent writes the rule when the task is created; a refused rule is rewritten with the reason", async () => {
	const feedback: Array<string | undefined> = [];
	const llm = {
		models: async () => ["fake/verifier"],
		contribute: async () => { throw new Error("not used"); },
		verify: async (c: { feedback?: string }) => { feedback.push(c.feedback); return { check: feedback.length === 1 ? "() => true" : GOLOMB_RULE, model: "fake/verifier" }; },
	};
	const srv = await startServer({ port: 0, bind: "127.0.0.1", llm: llm as never });
	try {
		await post(srv.url, "/api/sessions/ver1/task", { custom: { fn: "golomb", prompt: "Golomb ruler: n marks from 0 to len, all distances different", cases: [{ args: [5, 11], expect: [0, 1, 4, 9, 11] }] } });
		const snap = (await (await fetch(srv.url + "/api/sessions/ver1")).json()) as any;
		const b = snap.blocks.at(-1);
		assert.equal(b.task.check, GOLOMB_RULE);
		assert.equal(b.task.checkBy, "verifier");
		assert.equal(feedback.length, 2);
		assert.match(feedback[1]!, /accepts the wrong result null/); // the second try knew why the first was refused
		assert.ok(b.messages.some((m: any) => /Check rule written by the verifier agent \(fake\/verifier\)/.test(m.text)));
		// another right answer than the example now counts
		await post(srv.url, "/api/sessions/ver1/code", { author: "me", source: "function golomb(){ return [0, 2, 7, 10, 11] }" });
		await until(async () => { const s = (await (await fetch(srv.url + "/api/sessions/ver1")).json()) as any; return s.blocks.at(-1).contributions[0]?.ok === true; });
		// without the tick: no verifier, the example is exact
		await post(srv.url, "/api/sessions/ver2/task", { custom: { fn: "golomb", prompt: "x", cases: [{ args: [5, 11], expect: [0, 1, 4, 9, 11] }], verify: false } });
		assert.equal(((await (await fetch(srv.url + "/api/sessions/ver2")).json()) as any).blocks.at(-1).task.check, undefined);
		assert.equal(feedback.length, 2);
	} finally { await srv.close(); }
});

t("no rule passes the cross-check: the examples stay exact, and the block says why", async () => {
	const llm = { models: async () => ["fake/verifier"], contribute: async () => { throw new Error("not used"); }, verify: async () => ({ check: "() => true", model: "fake/verifier" }) };
	const srv = await startServer({ port: 0, bind: "127.0.0.1", llm: llm as never });
	try {
		await post(srv.url, "/api/sessions/ver3/task", { custom: { fn: "f", prompt: "x", cases: [{ args: [1], expect: 2 }] } });
		const b = ((await (await fetch(srv.url + "/api/sessions/ver3")).json()) as any).blocks.at(-1);
		assert.equal(b.task.check, undefined);
		assert.ok(b.messages.some((m: any) => /No check rule \(it accepts the wrong result null.*\): results must match the examples/.test(m.text)));
	} finally { await srv.close(); }
});

test("the verifier prompt is generic: the description, the examples (with alternatives) and the reason of a refusal", async () => {
	const { verifierPrompt } = await import("../server/llm.ts");
	const task = customTask({ fn: "route", prompt: "Shortest route through the grid from S to E", cases: [{ args: [["S.", ".E"]], expectAny: [["R", "D"], ["D", "R"]] }] });
	const p = verifierPrompt(task, "it accepts the wrong result null");
	for (const want of ["route", "Shortest route through the grid", 'route(["S.",".E"]) must return one of ["R","D"], ["D","R"]', "(result, args) => boolean", "Several different answers may be right", "it accepts the wrong result null"]) assert.ok(p.user.includes(want), want);
});
