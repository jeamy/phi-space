// codemode-forum with its processes around one space: a plan task, a run on it (the roll call, then the outline and the
// first draft of every section by one model), what a run needs (a task, three models, a budget), how it ends (finished,
// stopped, over budget, too few models), that every paid call is booked, that the document takes a second writer and
// an answer nobody can use, and that a run goes on after its processes and the space were restarted.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "../server/hub.ts";
import type { Spend } from "../server/models.ts";
import type { PlanView } from "../server/hub.ts";
import { DOC_LIMITS, writeVersion } from "../server/plandoc.ts";
import { FIXED_CRITERIA } from "../server/plantask.ts";
import { drawAliases } from "../server/run.ts";
import { PHASE } from "./fakes.ts";
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
const BRIEF = "Plan how the 3D world gets four times the resolution.\nName the files that change.";
/** A plan task in the room; the run that follows works on it. */
const task = async (url: string, id: string, more: Record<string, unknown> = {}) => { const r = await post(url, `/api/rooms/${id}/task`, { brief: BRIEF, ...more }); assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.blockId as string; };
const plan = async (url: string, id: string, blockId: string, version?: number) => (await (await fetch(`${url}/api/rooms/${id}/plan/${blockId}${version ? `?version=${version}` : ""}`)).json()) as PlanView;
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
const ended = (url: string, id: string, ms?: number) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; }, ms);

test("the names at the table are M1, M2, … in a drawn order", () => {
	const order = [0.9, 0.1, 0.5];
	assert.deepEqual(drawAliases(THREE, () => order.shift()!), { "fake/beta": "M1", "fake/gamma": "M2", "fake/alpha": "M3" });
});

test("a run on a plan task: the roll call, then one model writes the outline and every section, and every call is booked", async () => {
	const srv = await startServer();
	try {
		const id = room("roll");
		assert.deepEqual(await snapshot(srv.url, id).then((s) => [s.run, s.blocks]), [null, []]);
		const blockId = await task(srv.url, id, { criteria: "Names the tests of every phase" });
		const started = await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 });
		assert.equal(started.status, 200, JSON.stringify(started.body));
		const s = await ended(srv.url, id);
		assert.deepEqual(s.rollcall.map((a) => a.alias), ["M1", "M2", "M3"]);
		assert.deepEqual(s.rollcall.map((a) => a.model).sort(), THREE);
		for (const a of s.rollcall) assert.equal(a.text, `${a.model} is here.`);
		// three roll call answers of 100 tokens, three kickoff answers of 150, an outline of 400, three sections of 1000
		assert.deepEqual([s.run!.usage.tokens, Math.round(s.run!.usage.costUsd * 1000)], [4150, 415]);
		assert.deepEqual([s.run!.items, s.run!.phase, s.run!.ended, s.run!.blockId], [{ open: 0, done: 11 }, "done", undefined, blockId]); // the eleventh is the check
		assert.deepEqual(s.run!.check, { version: 4, ok: true, failures: 0, round: 1 });
		assert.deepEqual([s.run!.present!.length, s.run!.talk], [3, { messages: 3, decisions: 0 }]);
		const writer = s.rollcall[0]!.model; // M1
		assert.equal(s.run!.writer, writer);
		assert.deepEqual(s.run!.doc, { table: "A", version: 4, sections: 3, written: 3 });
		assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered the roll call; 3 messages, 0 decisions; M1 wrote 3 of 3 sections of the first draft \(version 4, checks passed\) \(4150 tokens, \$0\.4150\)$/);
		// the document: the outline was version 1, every section written since is one more
		const block = s.blocks[0]!;
		assert.deepEqual([block.blockId, block.brief, block.lang, block.criteria], [blockId, BRIEF, "en", ["Names the tests of every phase"]]);
		assert.deepEqual([block.doc!.version, block.doc!.versions, block.doc!.sections.map((x) => [x.title, x.rev, x.model])], [4, 4, [["Goal", 2, writer], ["Steps", 2, writer], ["Risks", 2, writer]]]);
		const view = await plan(srv.url, id, blockId);
		assert.deepEqual(view.doc.sections.map((x) => x.text), ["Goal", "Steps", "Risks"].map((h) => `The ${h.toLowerCase()} of the plan, written by ${writer}.${h === "Steps" ? PHASE : ""}`));
		assert.deepEqual([view.check, block.doc!.check], [{ ok: true, failures: [] }, { ok: true, failures: [] }]);
		assert.deepEqual(view.versions.map((v) => [v.version, v.changed.length]), [[1, 3], [2, 1], [3, 1], [4, 1]]);
		assert.deepEqual((await plan(srv.url, id, blockId, 1)).doc.sections.map((x) => x.text), ["What goal must say.", "What steps must say.", "What risks must say."]);
		assert.equal((await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}?version=9`)).status, 404);
		const md = await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}.md`)).text();
		assert.ok(md.startsWith(`# Plan how the 3D world gets four times the resolution.\n\n## Goal\n\nThe goal of the plan, written by ${writer}.\n\n## Steps\n\n`), md);
		// what the models were told: their own name and the others' names, never which model is behind them; the writer
		// gets the brief, all criteria, and for a section what it is to say
		const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as { model: string; kind: string; prompt: string });
		assert.deepEqual(calls.map((c) => c.kind).sort(), ["draft", "draft", "draft", "kickoff", "kickoff", "kickoff", "outline", "rollcall", "rollcall", "rollcall"]);
		for (const c of calls) { assert.match(c.prompt, new RegExp(`You are ${s.run!.aliases[c.model]}\\.`)); if (c.kind === "rollcall" || c.kind === "kickoff") assert.doesNotMatch(c.prompt, /fake\//); }
		// the writer is told how the others understand the brief, each under its name at the table
		assert.ok(calls.find((c) => c.kind === "outline")!.prompt.includes(`How the others understand the brief:\n- M2: ${s.rollcall[1]!.model} understands the brief.\n- M3: ${s.rollcall[2]!.model} understands the brief.`));
		for (const c of calls.filter((x) => x.kind === "outline" || x.kind === "draft")) { assert.equal(c.model, writer); assert.ok(c.prompt.includes(BRIEF)); for (const k of [...FIXED_CRITERIA, "Names the tests of every phase"]) assert.ok(c.prompt.includes(k), k); }
		assert.ok(calls.some((c) => c.kind === "draft" && c.prompt.includes('Write the section "Steps". What it is to say: What steps must say.')));
		// booked in the space: one Spend per paid call, a visitor's (this request came without an admin login)
		const spends = (await srv.stack.space.readAll({ type: "Spend", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as Spend);
		assert.deepEqual(spends.map((x) => [x.kind, x.tokens, x.admin]).sort(), [["draft", 1000, false], ["draft", 1000, false], ["draft", 1000, false], ["kickoff", 150, false], ["kickoff", 150, false], ["kickoff", 150, false], ["outline", 400, false], ["rollcall", 100, false], ["rollcall", 100, false], ["rollcall", 100, false]]);
		const system = (await (await fetch(`${srv.url}/api/system`)).json()) as { hosts: Array<{ roles: string[] }>; today: { calls: number; tokens: number } };
		assert.deepEqual(system.hosts.flatMap((h) => h.roles).sort(), ["agents", "checker", "model", "space", "web"]);
		assert.deepEqual({ calls: system.today.calls, tokens: system.today.tokens }, { calls: 10, tokens: 4150 });
		// nothing of the run is left behind
		for (const type of ["ForumRun", "WorkItem", "AgentSlot", "LlmCall", "LlmResult", "ItemStart"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
		// a second run on the block finds its document written: the roll call, no kickoff, and nothing more to do
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		const again = await until("the second run to end", async () => { const x = await snapshot(srv.url, id); return x.run && !x.run.active && x.run.runId !== s.run!.runId ? x : null; });
		assert.deepEqual([again.run!.phase, again.run!.doc, again.run!.usage.tokens], ["done", { table: "A", version: 4, sections: 3, written: 3 }, 300]);
	} finally { await srv.close(); }
});

test("a run needs a plan task, three to five different allowed models and a budget", async () => {
	const srv = await startServer({ fakes: [...THREE, "fake/delta", "fake/e", "fake/f"] });
	try {
		const id = room("roll");
		const refused = async (body: Record<string, unknown>, why: RegExp, path = "run") => { const r = await post(srv.url, `/api/rooms/${id}/${path}`, body); assert.equal(r.status, 400); assert.match(r.body.error, why); };
		await refused({ models: THREE, budgetTokens: 1000 }, /No plan task yet/);
		await refused({ brief: "too short" }, /at least 20 characters/, "task");
		await refused({ brief: BRIEF, outline: "Goal\ngoal" }, /names a heading twice/, "task");
		// the person fixes the outline: two headings, in German
		const blockId = await task(srv.url, id, { lang: "de", outline: "Ziel\nWeg" });
		await refused({ models: THREE, budgetTokens: 1000, blockId: "bnone" }, /Unknown plan task/);
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
		// the writer's two agents wrote the two sections side by side: each is one version, none is lost
		assert.deepEqual(s.run!.doc, { table: "A", version: 3, sections: 2, written: 2 });
		const view = await plan(srv.url, id, blockId);
		assert.deepEqual(view.doc.sections.map((x) => [x.title, x.rev, x.text]), [["Ziel", 2, `The ziel of the plan, written by ${s.run!.writer}.`], ["Weg", 2, `The weg of the plan, written by ${s.run!.writer}.${PHASE}`]]);
		const calls = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "outline" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
		assert.match(calls[0]!.prompt, /Keep exactly these headings in this order:\n## Ziel\n## Weg/);
		assert.match(calls[0]!.prompt, /Write in German\./);
	} finally { await srv.close(); }
});

test("a stopped run leaves nothing behind, and the room takes the next run", async () => {
	const srv = await startServer();
	try {
		const id = room("hold");
		await task(srv.url, id);
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
		assert.deepEqual([again.rollcall.length, again.run!.doc?.written], [3, 3]);
	} finally { await srv.close(); }
});

test("a model that does not answer is tried three times, paid each time; with fewer than three at the table the run ends", async () => {
	const srv = await startServer({ fakes: [...THREE, "fake/delta"] });
	try {
		const id = room("mute");
		await task(srv.url, id);
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		const s = await ended(srv.url, id, 40_000);
		assert.deepEqual(s.rollcall.map((a) => a.model).sort(), ["fake/alpha", "fake/gamma"]);
		assert.match(s.run!.note ?? "", new RegExp(`^${s.run!.aliases["fake/beta"]} did not answer the roll call \\(empty answer\\)`));
		assert.equal((await srv.stack.space.count({ type: "FakeCall", fields: { session: id, model: "fake/beta" } })), 3);
		assert.equal(s.run!.usage.tokens, 2 * 100 + 3 * 50);
		assert.deepEqual([s.run!.items, s.run!.ended, s.run!.doc, s.blocks[0]!.doc], [{ open: 0, done: 3 }, "models", undefined, null]);
		assert.match(s.lines.at(-1)!.text, /^Run finished \(fewer than 3 models answered\): 2 of 3 models answered the roll call \(350 tokens/);
		// with a fourth model at the table three are left, and the run goes on to the document
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: [...THREE, "fake/delta"], budgetTokens: 50_000 })).status, 200);
		const four = await until("the second run to end", async () => { const x = await snapshot(srv.url, id); return x.run && !x.run.active && x.run.runId !== s.run!.runId ? x : null; }, 40_000);
		assert.deepEqual([four.rollcall.length, four.run!.ended, four.run!.doc?.written], [3, undefined, 3]);
		assert.notEqual(four.run!.writer, "fake/beta");
	} finally { await srv.close(); }
});

test("a run does not go beyond its budget by more than the calls it had admitted", async () => {
	const srv = await startServer();
	try {
		const id = room("dear");
		await task(srv.url, id);
		// 3000 tokens an answer against 5000: two calls are admitted (4000 expected each before any was booked), the
		// third finds the budget used up
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 5000 })).status, 200);
		const s = await ended(srv.url, id);
		assert.equal(s.run!.ended, "budget");
		assert.equal(s.rollcall.length, 2);
		assert.equal(s.run!.usage.tokens, 6000);
		assert.equal((await srv.stack.space.count({ type: "FakeCall", fields: { session: id } })), 2);
		assert.deepEqual([s.run!.phase, s.run!.doc], ["rollcall", undefined]); // no outline is asked for beyond the budget
		assert.match(s.lines.at(-1)!.text, /^Run finished \(budget used up\): 2 of 3 models answered the roll call \(6000 tokens/);
	} finally { await srv.close(); }
});

test("a run goes on after the agents were killed and the space and the model process restarted", async () => {
	const dir = mkdtempSync(join(tmpdir(), "forum-test-"));
	const stack = await startStack({ dbPath: join(dir, "space.sqlite"), agents: false, model: false });
	const srv = await startServer({ stack });
	try {
		await stack.checker();
		const agents = await stack.agents({ leaseMs: 2000 }), model = await stack.model({ fakes: true });
		const id = room("hold");
		const blockId = await task(srv.url, id);
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
		assert.equal(s.run!.usage.tokens, 4150); // every answer booked once
		assert.deepEqual(s.run!.doc, { table: "A", version: 4, sections: 3, written: 3 });
		assert.equal((await plan(srv.url, id, blockId)).doc.sections.length, 3);
		assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered the roll call; 3 messages, 0 decisions; M1 wrote 3 of 3 sections/);
	} finally { await srv.close(); await stack.close(); await rm(dir, { recursive: true, force: true }); }
});

test("an outline nobody can use is asked for again, and a section too long is cut at a paragraph", async () => {
	const srv = await startServer();
	try {
		const id = room("odd");
		const blockId = await task(srv.url, id);
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000 })).status, 200);
		const s = await ended(srv.url, id, 40_000);
		assert.equal(await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "outline" } }), 2);
		// the unusable outline was paid: 300 for the roll call, 450 for the kickoff, 300 and 400 for the outlines, 3000 for the sections
		assert.deepEqual([s.run!.usage.tokens, s.run!.doc], [4450, { table: "A", version: 4, sections: 3, written: 3 }]);
		const risks = (await plan(srv.url, id, blockId)).doc.sections.find((x) => x.title === "Risks")!;
		assert.ok(risks.bytes <= DOC_LIMITS.sectionBytes && risks.bytes > DOC_LIMITS.sectionBytes - 200, String(risks.bytes));
		assert.match(risks.text, /^Risk 0: x+\n\nRisk 1: /);
		assert.match(risks.text, /x{90}$/);
	} finally { await srv.close(); }
});

test("a section someone else revised while the model wrote is not overwritten: the model writes again, on the newer text", async () => {
	const srv = await startServer();
	try {
		const id = room("slow");
		const blockId = await task(srv.url, id);
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 50_000, perModel: 3 })).status, 200);
		// the drafts are held, each of the writer's three agents at one section (an ItemStart marks a call that is out);
		// the page already shows the outline: every section with what it is to say
		const held = await until("the drafts to be asked for", async () => { const x = await snapshot(srv.url, id); return x.run?.phase === "draft" && (await srv.stack.space.count({ type: "ItemStart", fields: { session: id } })) === 3 ? x : null; });
		assert.deepEqual([held.run!.doc, held.blocks[0]!.doc!.version], [{ table: "A", version: 1, sections: 3, written: 0 }, 1]);
		assert.deepEqual((await plan(srv.url, id, blockId)).doc.sections.map((x) => x.text), ["What goal must say.", "What steps must say.", "What risks must say."]);
		// a second writer revises the first section meanwhile
		const t = await srv.stack.space.createTransaction(30_000);
		await writeVersion(srv.stack.space, t.id, 600_000, { session: id, blockId, table: "A" }, { author: "a person", model: "human" }, { changes: [{ sectionId: "s1", base: 1, text: "The goal as a person wrote it." }] });
		await srv.stack.space.commit(t.id);
		await srv.stack.space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
		const s = await ended(srv.url, id, 40_000);
		// the model's first text for the section was refused and paid; its second one builds on the person's revision
		assert.equal(await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "draft" } }), 4);
		assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 4 * 1000);
		const view = await plan(srv.url, id, blockId);
		assert.deepEqual(view.doc.sections.map((x) => [x.title, x.rev]), [["Goal", 3], ["Steps", 2], ["Risks", 2]]);
		assert.deepEqual(view.versions.map((v) => v.model).filter((m) => m === "human").length, 1);
		assert.equal(view.doc.version, 5);
		assert.deepEqual((await plan(srv.url, id, blockId, 2)).doc.sections[0]!.text, "The goal as a person wrote it.");
		assert.equal(await srv.stack.space.count({ type: "LlmResult", fields: { session: id } }), 0);
	} finally { await srv.close(); }
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
		await task(srv.url, id);
		assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetUsd: 2 }, { cookie, "x-forum-admin": "1" })).status, 200);
		const s = await ended(srv.url, id);
		assert.deepEqual(s.run!.budget, { usd: 2 });
		const spends = (await srv.stack.space.readAll({ type: "Spend", fields: { session: id } }, { limit: 20 })).map((e) => e.fields as unknown as Spend);
		assert.deepEqual([spends.length, spends.every((x) => x.admin)], [10, true]);
		assert.equal((await post(srv.url, "/api/admin/logout", {}, { cookie })).status, 200);
		assert.deepEqual(await session(cookie), { admin: false, available: true });
	} finally { process.env.FORUM_ADMIN_PASSWORD = ""; await srv.close(); }
});
