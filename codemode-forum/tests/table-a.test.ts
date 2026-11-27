// Table A, where the models take turns: one model writes the outline and the first draft, then the turn goes round
// the table. Whoever has it reads the whole document, objects, and revises the sections concerned itself, with what
// the others objected to; after the turns of a round every model writes its ballot. A turn nobody takes in time
// passes on, and a turn goes on when the agents process is killed in the middle of it.
import test from "node:test";
import assert from "node:assert/strict";
import type { PlanView, Snapshot } from "../server/hub.ts";
import type { PlanObjection } from "../server/review.ts";
import { startServer, startStack } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan how the world gets four times the resolution.";
let seq = 0;
const room = (scenario: string) => `${scenario}-a${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 60_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const ended = (url: string, id: string) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; });
type Space = { readAll: (t: any, o: any) => Promise<Array<{ fields: any }>> };
type Call = { model: string; kind: string; callId: string; prompt: string; round?: number; seq: number };
const callsOf = async (space: Space, id: string, kind: string) => (await space.readAll({ type: "FakeCall", fields: { session: id, kind } }, { limit: 100 })).map((e) => e.fields as Call).sort((a, b) => a.seq - b.seq);
const objections = async (space: Space, id: string) => (await space.readAll({ type: "PlanObjection", fields: { session: id } }, { limit: 50 })).map((e) => e.fields as PlanObjection).sort((a, b) => a.ts - b.ts);
/** The models in their order at the table. */
const seats = (s: Snapshot) => [...s.run!.models].sort((a, b) => s.run!.aliases[a]!.localeCompare(s.run!.aliases[b]!));

test("table A: the first at the table writes the draft, the turn goes to the others one after the other, then everybody votes", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("turns");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "turns" })).status, 200);
	const s = await ended(srv.url, id), [writer, second, third] = seats(s);
	assert.deepEqual([s.run!.table, s.run!.phase, s.run!.round, s.run!.rounds, s.run!.turn, s.run!.writer, s.run!.accepted], ["A", "accepted", 1, 2, undefined, writer, { version: 4, round: 1, approvals: 3, of: 3 }]);
	// the writer's turn was the draft: the others have the turn, in their order at the table, one at a time
	const turns = await callsOf(srv.stack.space, id, "turn");
	assert.deepEqual(turns.map((c) => [c.model, c.round]), [[second, 1], [third, 1]]);
	assert.ok(turns[0]!.prompt.includes("It is your turn at the table (round 1): only you change the document now"));
	assert.equal((await callsOf(srv.stack.space, id, "draft")).every((c) => c.model === writer), true);
	assert.equal((await callsOf(srv.stack.space, id, "review")).length, 3);
	assert.equal((await callsOf(srv.stack.space, id, "revise")).length, 0);
	// roll call, kickoff, outline, three drafts, two turns, three ballots
	assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 3000 + 1000 + 1800);
	assert.match(s.lines.find((l) => l.text.startsWith("Run started"))!.text, /^Run started at table A \(the models take turns, 2 rounds\)/);
	assert.match(s.lines.at(-1)!.text, /sections of the first draft \(version 4, checks passed\); 1 round of turns, 0 objections; accepted in round 1 by 3 of 3 models \(/);
	const view = (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}`)).json()) as PlanView;
	assert.equal(view.doc.table, "A");
	for (const type of ["WorkItem", "LlmCall", "LlmResult", "AgentSlot"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
});

test("table A: whoever has the turn revises what it objects to itself, and takes up what the others objected to in their ballots", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("around");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "turns" })).status, 200);
	const s = await ended(srv.url, id), aliases = s.run!.aliases, [m1, m2, m3] = seats(s) as [string, string, string];
	// round 1: M2 objects to the goal in its turn and revises it, M3 has nothing; M1 and M3 reject with an objection
	// to the steps. Round 2: M1, the first at the table, takes both up in its turn; M2, which approved and has nothing
	// open before it, is passed over; M3 has its turn; everybody approves
	assert.deepEqual((await callsOf(srv.stack.space, id, "turn")).map((c) => [c.model, c.round]), [[m2, 1], [m3, 1], [m1, 2], [m3, 2]]);
	const revises = await callsOf(srv.stack.space, id, "revise");
	assert.deepEqual(revises.map((c) => [c.model, /Write the section "([^"]+)" anew/.exec(c.prompt)?.[1]]), [[m2, "Goal"], [m1, "Steps"]]);
	assert.ok(revises[0]!.prompt.includes("- M2: It does not name the target value."));
	for (const who of ["M1", "M3"]) assert.ok(revises[1]!.prompt.includes(`- ${who}: Phase 1 is too coarse.`), who);
	// M1's turn of round 2 is told what is open, its own objection among it
	const first = (await callsOf(srv.stack.space, id, "turn")).find((c) => c.model === m1)!;
	assert.ok(first.prompt.includes('- on "Steps" by you: Phase 1 is too coarse.') && first.prompt.includes('- on "Steps" by M3: Phase 1 is too coarse.'));
	assert.deepEqual((await objections(srv.stack.space, id)).map((o) => [aliases[o.model], o.sectionId, o.round, o.state, o.revisedIn]).sort(), [["M1", "s2", 1, "confirmed", 6], ["M2", "s1", 1, "confirmed", 5], ["M3", "s2", 1, "confirmed", 6]]);
	const view = (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}`)).json()) as PlanView;
	assert.deepEqual([view.doc.version, view.doc.sections.map((x) => [x.rev, x.model])], [6, [[3, m2], [3, m1], [2, m1]]]);
	assert.deepEqual([s.run!.phase, s.run!.round, s.run!.objections, s.run!.accepted, s.run!.ballots], ["accepted", 2, { raised: 3, open: 0 }, { version: 6, round: 2, approvals: 3, of: 3 }, { round: 2, approve: 3, of: 3 }]);
	assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 3000 + (500 + 1000 + 500 + 1800) + (500 + 1000 + 500 + 1800));
});

test("table A: a turn nobody takes in time passes on to the next model", async (t) => {
	const stack = await startStack({ agents: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); });
	await stack.agents({ turnWaitS: 2 });
	const id = room("absent");
	await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF });
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "turns", rounds: 1 })).status, 200);
	const s = await ended(srv.url, id), [, m2, m3] = seats(s);
	// M2's turn was asked for and never answered: M3 had its turn all the same, and the table voted
	assert.deepEqual((await callsOf(stack.space, id, "turn")).map((c) => c.model), [m2, m3]);
	assert.equal(s.run!.note, `M2 did not take its turn (the reply came too late); the turn passes on`);
	assert.deepEqual([s.run!.phase, s.run!.accepted?.version, s.run!.ballots], ["accepted", 4, { round: 1, approve: 3, of: 3 }]);
	assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 3000 + 500 + 1800); // the turn that never came was not paid
	// the call held at the gate ends once the model process sees the run gone (within 2 s): its answer, "the run is
	// over", is the one thing left, and it carries no cost
	await new Promise((r) => setTimeout(r, 3000));
	for (const type of ["WorkItem", "LlmCall"]) assert.equal(await stack.space.count({ type, fields: { session: id } }), 0, type);
	const late = (await stack.space.readAll({ type: "LlmResult", fields: { session: id } }, { limit: 5 })).map((e) => e.fields as { ok: boolean; error?: string; usage?: unknown });
	assert.deepEqual(late, late.length ? [{ ...late[0], ok: false, error: "the run is over" }] : []);
	assert.ok(late.every((x) => !x.usage));
});

test("table A: the agents process is killed in the middle of a turn, and another goes on with it: one revision, paid once", async (t) => {
	const stack = await startStack({ agents: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); });
	const agents = await stack.agents({ leaseMs: 2000 });
	const id = room("ahold");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "turns", rounds: 1 })).status, 200);
	// M2 has the turn, has objected, and its revision of the goal waits at the gate
	await until("the revision to be asked for", async () => (await stack.space.count({ type: "FakeCall", fields: { session: id, kind: "revise" } })) >= 1);
	const before = await snapshot(srv.url, id);
	assert.deepEqual([before.run!.phase, before.run!.round, before.run!.aliases[before.run!.turn ?? ""]], ["revise", 1, "M2"]);
	await stack.kill(agents, "SIGKILL");
	await stack.agents({ leaseMs: 2000 });
	await stack.space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
	const s = await ended(srv.url, id);
	assert.equal(new Set((await callsOf(stack.space, id, "revise")).map((c) => c.callId)).size, 1);
	assert.deepEqual((await callsOf(stack.space, id, "turn")).map((c) => s.run!.aliases[c.model]), ["M2", "M3"]);
	assert.deepEqual((await objections(stack.space, id)).map((o) => [s.run!.aliases[o.model], o.state, o.revisedIn]), [["M2", "confirmed", 5]]);
	const view = (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}`)).json()) as PlanView;
	assert.deepEqual([view.doc.version, view.doc.sections.map((x) => x.rev)], [5, [3, 2, 2]]);
	assert.deepEqual([s.run!.phase, s.run!.accepted?.version, s.run!.turn], ["accepted", 5, undefined]);
	assert.equal(s.run!.usage.tokens, 300 + 450 + 400 + 3000 + 500 + 1000 + 500 + 1800);
	assert.equal(await stack.space.count({ type: "WorkItem", fields: { session: id } }), 0);
});
