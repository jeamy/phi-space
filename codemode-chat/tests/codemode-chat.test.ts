// Flow: task -> contribution -> score entry -> WebSocket frame, plus the sandbox verdicts and limits.
import test from "node:test";
import assert from "node:assert/strict";
import { startServer } from "../server/index.ts";
import { startJudgeHost } from "../server/nano-host.ts";
import { judge, loadCodemode } from "../server/judge.ts";
import { customTask, taskById, TASKS } from "../server/tasks.ts";

const cm = await loadCodemode();
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
		ws.onmessage = (e) => frames.push(JSON.parse(String(e.data)));
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
		assert.equal((await post(srv.url, "/api/sessions/room1/message", { author: "alice", text: "hello" })).status, 200);
		await until(async () => frames.at(-1)?.messages.some((m: any) => m.text === "hello"));
		ws.close();
	} finally { await srv.close(); }
});

t("a scripted run produces graded contributions and a best", async () => {
	const srv = await startServer({ port: 0, bind: "127.0.0.1" });
	try {
		await post(srv.url, "/api/sessions/run1/task", { taskId: "gcd" });
		assert.equal((await post(srv.url, "/api/sessions/run1/run", { agents: 3, gens: 2, perAgent: 1, mode: "scripted" })).status, 200);
		const snap = await until(async () => { const s = await (await fetch(srv.url + "/api/sessions/run1")).json() as any; return s.run && !s.run.active && s.contributions.length === 6 ? s : false; });
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
		const snap = await until(async () => { const s = await (await fetch(srv.url + "/api/sessions/shard1")).json() as any; return s.contributions.length === 4 && s.contributions.every((c: any) => c.ok !== null) ? s : false; });
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
		const snap = await until(async () => { const s = await (await fetch(srv.url + "/api/sessions/dead1")).json() as any; return s.contributions.length === 3 && s.contributions.every((c: any) => c.ok) ? s : false; }, 60_000);
		assert.equal(snap.best.source, good);
		const sys = await (await fetch(srv.url + "/api/system")).json() as any;
		assert.equal(sys.shards[1].up, false);
	} finally { await srv.close(); }
});
