// The base of codemode-forum: the processes around one space, a run that opens with its roll call, what a run needs
// (three models, a budget), how it ends (finished, stopped, over budget, a model that does not answer), that every
// paid call is booked, and that a run goes on after its processes and the space were restarted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../server/hub.ts";
import type { Spend } from "../server/models.ts";
import { drawAliases } from "../server/run.ts";
import { startServer, startStack } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
let seq = 0;
const room = (scenario: string) => `${scenario}-${process.pid}-${seq++}`;

async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 30_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const post = async (url: string, path: string, body: unknown, headers: Record<string, string> = {}) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any>, cookie: r.headers.get("set-cookie") ?? "" };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
const ended = (url: string, id: string, ms?: number) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; }, ms);

test("the names at the table are M1, M2, … in a drawn order", () => {
	const order = [0.9, 0.1, 0.5];
	assert.deepEqual(drawAliases(THREE, () => order.shift()!), { "fake/beta": "M1", "fake/gamma": "M2", "fake/alpha": "M3" });
});

test("a run opens with the roll call: every model answers once, and every call is booked", async () => {
	const srv = await startServer();
	try {
		const id = room("roll");
		assert.equal((await snapshot(srv.url, id)).run, null);
		const started = await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 });
		assert.equal(started.status, 200, JSON.stringify(started.body));
		const s = await ended(srv.url, id);
		assert.deepEqual(s.rollcall.map((a) => a.alias), ["M1", "M2", "M3"]);
		assert.deepEqual(s.rollcall.map((a) => a.model).sort(), THREE);
		for (const a of s.rollcall) assert.equal(a.text, `${a.model} is here.`);
		assert.deepEqual(s.run!.usage, { tokens: 300, costUsd: 0.03 });
		assert.deepEqual(s.run!.items, { open: 0, done: 3 });
		assert.equal(s.run!.ended, undefined);
		assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered the roll call \(300 tokens, \$0\.0300\)$/);
		// a model learns its own name and the others' names, never which model is behind them
		const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as { model: string; prompt: string });
		assert.equal(calls.length, 3);
		for (const c of calls) { assert.match(c.prompt, new RegExp(`You are ${s.run!.aliases[c.model]}\\.`)); assert.doesNotMatch(c.prompt, /fake\//); }
		// booked in the space: one Spend per paid call, a visitor's (this request came without an admin login)
		const spends = (await srv.stack.space.readAll({ type: "Spend", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as Spend);
		assert.equal(spends.length, 3);
		for (const x of spends) assert.deepEqual({ admin: x.admin, tokens: x.tokens, costUsd: x.costUsd, kind: x.kind }, { admin: false, tokens: 100, costUsd: 0.01, kind: "rollcall" });
		const system = (await (await fetch(`${srv.url}/api/system`)).json()) as { hosts: Array<{ roles: string[] }>; today: { calls: number; tokens: number } };
		assert.deepEqual(system.hosts.flatMap((h) => h.roles).sort(), ["agents", "model", "space", "web"]);
		assert.deepEqual({ calls: system.today.calls, tokens: system.today.tokens }, { calls: 3, tokens: 300 });
		// nothing of the run is left behind
		for (const type of ["ForumRun", "WorkItem", "AgentSlot", "LlmCall", "LlmResult", "ItemStart"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
	} finally { await srv.close(); }
});

test("a run needs three to five different allowed models and a budget", async () => {
	const srv = await startServer({ fakes: [...THREE, "fake/delta", "fake/e", "fake/f"] });
	try {
		const id = room("roll");
		const refused = async (body: Record<string, unknown>, why: RegExp) => { const r = await post(srv.url, `/api/rooms/${id}/run`, body); assert.equal(r.status, 400); assert.match(r.body.error, why); };
		await refused({ models: THREE.slice(0, 2), budgetTokens: 1000 }, /at least 3 different models/);
		await refused({ models: ["fake/alpha", "fake/alpha", "fake/beta"], budgetTokens: 1000 }, /at least 3 different models/);
		await refused({ models: [...THREE, "fake/delta", "fake/e", "fake/f"], budgetTokens: 1000 }, /at most 5 models/);
		await refused({ models: [...THREE.slice(0, 2), "real/unknown"], budgetTokens: 1000 }, /Model not available: real\/unknown/);
		// without a client (in-process) the caller counts as admin: no default budget, so it must name one
		await assert.rejects(srv.hub.startRun(id, { models: THREE }), /needs a budget/);
		assert.equal((await snapshot(srv.url, id)).run, null);
		// a visitor's run gets the default budget, and never more than it
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 10_000_000, perModel: 2 })).status, 200);
		const s = await ended(srv.url, id);
		assert.deepEqual(s.run!.budget, { tokens: 300_000 });
		assert.equal(s.run!.perModel, 2);
		assert.equal(s.rollcall.length, 3); // two agents a model, still one answer a model
	} finally { await srv.close(); }
});

test("a stopped run leaves nothing behind, and the room takes the next run", async () => {
	const srv = await startServer();
	try {
		const id = room("hold");
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		await until("the models to be asked", async () => (await srv.stack.space.count({ type: "FakeCall", fields: { session: id } })) >= 2);
		const second = await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 });
		assert.equal(second.status, 400);
		assert.match(second.body.error, /already active/);
		assert.equal((await post(srv.url, `/api/rooms/${id}/stop`, {})).status, 200);
		const s = await snapshot(srv.url, id);
		assert.equal(s.run!.active, false);
		assert.match(s.lines.at(-1)!.text, /^Run stopped: 0 of 3 models answered/);
		// the agents and the model process let go of what they held: nothing of the run stays, also not a moment later
		const left = async () => (await Promise.all(["WorkItem", "AgentSlot", "LlmCall", "LlmResult", "ItemStart"].map((type) => srv.stack.space.count({ type, fields: { session: id } })))).reduce((a, b) => a + b, 0);
		await new Promise((r) => setTimeout(r, 4000));
		assert.equal(await left(), 0);
		// the gate opens: the calls that were held end (their run is gone), and a new run answers
		await srv.stack.space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		const again = await until("the second run to end", async () => { const x = await snapshot(srv.url, id); return x.run && !x.run.active && x.run.runId !== s.run!.runId ? x : null; });
		assert.equal(again.rollcall.length, 3);
	} finally { await srv.close(); }
});

test("a model that does not answer is tried three times, paid each time, and the run ends without it", async () => {
	const srv = await startServer();
	try {
		const id = room("mute");
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		const s = await ended(srv.url, id, 40_000);
		assert.deepEqual(s.rollcall.map((a) => a.model).sort(), ["fake/alpha", "fake/gamma"]);
		assert.match(s.run!.note ?? "", new RegExp(`^${s.run!.aliases["fake/beta"]} did not answer the roll call \\(empty answer\\)`));
		assert.equal((await srv.stack.space.count({ type: "FakeCall", fields: { session: id, model: "fake/beta" } })), 3);
		assert.equal(s.run!.usage.tokens, 2 * 100 + 3 * 50);
		assert.deepEqual(s.run!.items, { open: 0, done: 3 });
	} finally { await srv.close(); }
});

test("a run does not go beyond its budget by more than the calls it had admitted", async () => {
	const srv = await startServer();
	try {
		const id = room("dear");
		// 3000 tokens an answer against 5000: two calls are admitted (4000 expected each before any was booked), the
		// third finds the budget used up
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 5000 })).status, 200);
		const s = await ended(srv.url, id);
		assert.equal(s.run!.ended, "budget");
		assert.equal(s.rollcall.length, 2);
		assert.equal(s.run!.usage.tokens, 6000);
		assert.equal((await srv.stack.space.count({ type: "FakeCall", fields: { session: id } })), 2);
		assert.match(s.lines.at(-1)!.text, /^Run finished \(budget used up\): 2 of 3 models answered/);
	} finally { await srv.close(); }
});

test("a run goes on after the agents were killed and the space and the model process restarted", async () => {
	const dir = mkdtempSync(join(tmpdir(), "forum-test-"));
	const stack = await startStack({ dbPath: join(dir, "space.sqlite"), agents: false, model: false });
	const srv = await startServer({ stack });
	try {
		const agents = await stack.agents({ leaseMs: 2000 }), model = await stack.model({ fakes: true });
		const id = room("hold");
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		await until("the models to be asked", async () => (await stack.space.count({ type: "FakeCall", fields: { session: id } })) >= 2);
		await stack.kill(agents, "SIGKILL"); // in the middle of its items
		await stack.kill(model);
		await stack.restartSpace();
		await stack.agents({ leaseMs: 2000 });
		await stack.model({ fakes: true });
		assert.equal((await until("the space to answer again", () => snapshot(srv.url, id).catch(() => null))).run!.active, true);
		await stack.space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
		const s = await ended(srv.url, id, 60_000);
		assert.deepEqual(s.rollcall.map((a) => a.model).sort(), THREE);
		assert.deepEqual(s.run!.usage, { tokens: 300, costUsd: 0.03 }); // every answer booked once
		assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered/);
	} finally { await srv.close(); await stack.close(); await rm(dir, { recursive: true, force: true }); }
});

test("the admin logs in with the password, and only then chooses the models", async () => {
	process.env.FORUM_ADMIN_PASSWORD = "open sesame";
	const srv = await startServer();
	try {
		const session = async (cookie = "") => (await (await fetch(`${srv.url}/api/admin/session`, { headers: { cookie } })).json()) as { admin: boolean; available: boolean };
		assert.deepEqual(await session(), { admin: false, available: true });
		assert.equal((await post(srv.url, "/api/admin/models", { allowed: THREE })).status, 403);
		assert.equal((await post(srv.url, "/api/admin/login", { password: "wrong" })).status, 403);
		const login = await post(srv.url, "/api/admin/login", { password: "open sesame" });
		assert.equal(login.status, 200);
		const cookie = login.cookie.split(";")[0]!;
		assert.match(login.cookie, /HttpOnly; SameSite=Strict/);
		assert.deepEqual(await session(cookie), { admin: true, available: true });
		// the cookie alone is not enough for a change: a cross-site form could send it
		assert.equal((await post(srv.url, "/api/admin/models", { allowed: THREE }, { cookie })).status, 403);
		const saved = await post(srv.url, "/api/admin/models", { allowed: THREE, on: true }, { cookie, "x-forum-admin": "1" });
		assert.equal(saved.status, 200);
		assert.deepEqual(saved.body.allowed, THREE);
		assert.deepEqual((await srv.stack.space.readIfExists({ type: "ForumAdmin", fields: { key: "models" } }, 0))?.fields.allowed, THREE);
		assert.equal((await post(srv.url, "/api/admin/models", { allowed: ["real/unknown"] }, { cookie, "x-forum-admin": "1" })).status, 400);
		// an admin's run names its own budget, in dollars too
		const id = room("roll");
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetUsd: 2 }, { cookie, "x-forum-admin": "1" })).status, 200);
		const s = await ended(srv.url, id);
		assert.deepEqual(s.run!.budget, { usd: 2 });
		const spends = (await srv.stack.space.readAll({ type: "Spend", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as Spend);
		assert.deepEqual(spends.map((x) => x.admin), [true, true, true]);
		assert.equal((await post(srv.url, "/api/admin/logout", {}, { cookie })).status, 200);
		assert.deepEqual(await session(cookie), { admin: false, available: true });
	} finally { process.env.FORUM_ADMIN_PASSWORD = ""; await srv.close(); }
});
