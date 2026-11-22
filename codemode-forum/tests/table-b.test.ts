// Table B, where the models write at the same time: every model proposes an outline and the table picks one, the
// sections are dealt out and drafted side by side, and in review rounds each model reads the whole document and
// writes its ballot, with its objections. The objections to a section become one revision of it, not by those who
// raised them; and a round goes on after every process was restarted in the middle of it. (When the table has agreed
// is in ballots.test.ts.)
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PlanView, Snapshot } from "../server/hub.ts";
import { deal, parsePick, parseReview, pickedOutline, type OutlinePick, type PlanObjection, type PlanOutline } from "../server/review.ts";
import type { PlanMessage } from "../server/talk.ts";
import { startServer, startStack } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const ALIASES = { "fake/alpha": "M2", "fake/beta": "M1", "fake/gamma": "M3" };
const BRIEF = "Plan how the world gets four times the resolution.";
let seq = 0;
const room = (scenario: string) => `${scenario}-b${process.pid}-${seq++}`;
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
type Call = { model: string; kind: string; callId: string; prompt: string };
const callsOf = async (space: { readAll: (t: any, o: any) => Promise<Array<{ fields: any }>> }, id: string, kind?: string) => (await space.readAll({ type: "FakeCall", fields: { session: id, ...(kind ? { kind } : {}) } }, { limit: 100 })).map((e) => e.fields as Call);
const objections = async (space: { readAll: (t: any, o: any) => Promise<Array<{ fields: any }>> }, id: string) => (await space.readAll({ type: "PlanObjection", fields: { session: id } }, { limit: 50 })).map((e) => e.fields as PlanObjection).sort((a, b) => a.ts - b.ts);

test("a review, a pick, the picked outline and the dealing of sections", () => {
	const sections = [{ sectionId: "s1", title: "Goal" }, { sectionId: "s2", title: "Steps" }];
	assert.deepEqual(parseReview('Some thoughts first.\n- objection on "goal": No target. | fix: Name 256. | quote: "the goal"\nobjection on “Steps”: Too coarse | quote: "Phase 1" | fix: Split it.\nobjection on "Steps": no fix named\nobjection on "Costs": no such section | fix: x\nMESSAGES\nnote: hello', sections), {
		objections: [{ sectionId: "s1", defect: "No target.", fix: "Name 256.", quote: "the goal" }, { sectionId: "s2", defect: "Too coarse", fix: "Split it.", quote: "Phase 1" }], messages: "\nnote: hello" });
	assert.deepEqual(parseReview("NO OBJECTIONS", sections), { objections: [], messages: "" });
	assert.equal(parseReview(Array.from({ length: 9 }, (_, i) => `objection on "Goal": d${i} | fix: f`).join("\n"), sections).objections.length, 6);
	assert.deepEqual(["PICK M2: clearest", "I pick: PICK: m3", "M2 is best", ""].map(parsePick), ["M2", "M3", null, null]);
	const outline = (model: string): PlanOutline => ({ session: "s", blockId: "b", table: "B", runId: "r", model, author: "agent-0", sections: [], ts: 0 });
	const pick = (model: string, choice: string): OutlinePick => ({ session: "s", blockId: "b", table: "B", runId: "r", model, choice, ts: 0 });
	const three = THREE.map(outline);
	assert.equal(pickedOutline(three, [pick("fake/alpha", "fake/gamma"), pick("fake/beta", "fake/gamma"), pick("fake/gamma", "fake/alpha")], ALIASES)!.model, "fake/gamma");
	// a pick of one's own outline does not count; among equals the first at the table (beta is M1)
	assert.equal(pickedOutline(three, [pick("fake/alpha", "fake/alpha"), pick("fake/gamma", "fake/gamma")], ALIASES)!.model, "fake/beta");
	assert.equal(pickedOutline([], [], ALIASES), null);
	// in turn by the names at the table, beginning with the proposer
	assert.deepEqual(deal(["s1", "s2", "s3", "s4"], THREE, ALIASES, "fake/alpha"), { s1: "fake/alpha", s2: "fake/gamma", s3: "fake/beta", s4: "fake/alpha" });
});

test("table B: outlines of all, one picked, sections dealt out, two rounds, two objections taken up by the third model, then agreed", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("tableb");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "parallel" })).status, 200);
	const s = await ended(srv.url, id), aliases = s.run!.aliases;
	assert.deepEqual([s.run!.table, s.run!.phase, s.run!.round, s.run!.rounds, s.run!.objections, s.run!.check?.ok, s.blocks[0]!.table], ["B", "accepted", 2, 2, { raised: 2, open: 0 }, true, "B"]);
	assert.deepEqual([s.run!.accepted, s.blocks[0]!.accepted?.version], [{ version: 5, round: 2, approvals: 3, of: 3 }, 5]);
	// every model proposed and picked; alpha's outline has the two picks of the others
	assert.ok(s.lines.some((l) => l.text === `The table writes along the outline of ${aliases["fake/alpha"]} (2 of 3 picks, 3 outlines)`), JSON.stringify(s.lines.map((l) => l.text)));
	const calls = await callsOf(srv.stack.space, id), count = (kind: string) => calls.filter((c) => c.kind === kind).length;
	assert.deepEqual(["outline", "pick", "draft", "review", "revise"].map(count), [3, 3, 3, 6, 1]);
	// the sections were dealt out in turn, beginning with alpha, and each was written by its model
	const order = [...THREE].sort((a, b) => aliases[a]!.localeCompare(aliases[b]!)), at = order.indexOf("fake/alpha"), owners = [0, 1, 2].map((i) => order[(at + i) % 3]!);
	const view = (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}`)).json()) as PlanView;
	assert.deepEqual(view.doc.sections.map((x) => x.title), ["Goal", "Steps", "Risks"]);
	assert.deepEqual(calls.filter((c) => c.kind === "draft").map((c) => [/Write the section "([^"]+)"/.exec(c.prompt)![1], c.model]).sort(), [["Goal", owners[0]], ["Risks", owners[2]], ["Steps", owners[1]]]);
	// beta's and gamma's objections to the goal: one revision of it, by the one that raised neither, with both in its
	// prompt; in the second round each confirmed that its objection is resolved
	const all = await objections(srv.stack.space, id), o = all.find((x) => x.model === "fake/beta");
	assert.deepEqual([o!.sectionId, o!.defect, o!.fix, o!.quote, o!.state, o!.revisedIn, o!.round], ["s1", "It does not name the target value.", "Name 256 as the target.", "The goal of the plan", "confirmed", 5, 1]);
	assert.deepEqual(all.map((x) => [x.model, x.state]).sort(), [["fake/beta", "confirmed"], ["fake/gamma", "confirmed"]]);
	const revise = calls.find((c) => c.kind === "revise")!;
	assert.equal(revise.model, "fake/alpha");
	assert.ok(revise.prompt.includes(`- ${aliases["fake/gamma"]}: It gives no reason. What would resolve it: Say why 256.`));
	// (the two objections in the order they were raised, whichever came first)
	assert.ok(revise.prompt.includes("The table objects to this section. Take up each objection: mend what it names, or leave the text where the objection is wrong.\n- M"));
	assert.ok(revise.prompt.includes(`- ${aliases["fake/beta"]}: It does not name the target value. What would resolve it: Name 256 as the target. (about: "The goal of the plan")`));
	assert.doesNotMatch(revise.prompt, /A program checked the document/);
	assert.deepEqual([view.doc.version, view.doc.sections[0]!.rev, view.doc.sections[0]!.model, view.check?.ok], [5, 3, revise.model, true]);
	assert.match(view.doc.sections[0]!.text, new RegExp(`Revised by ${revise.model}: the target is 256\\.$`));
	// in the second round everybody saw the revised text, and nobody objected again
	const second = calls.filter((c) => c.kind === "review").filter((c) => c.prompt.includes("(version 5)"));
	assert.equal(second.length, 3);
	for (const c of second) assert.ok(c.prompt.includes("the target is 256."));
	// what beta said to the table with its review is kept, in its round
	const talk = (await (await fetch(`${srv.url}/api/rooms/${id}/talk/${blockId}`)).json()) as { table: string; messages: PlanMessage[]; objections: PlanObjection[] };
	assert.deepEqual([talk.table, talk.objections.length], ["B", 2]);
	assert.deepEqual(talk.messages.filter((m) => m.kind === "note").map((m) => [m.model, m.round, m.text]), [["fake/beta", 1, "The target value belongs in the goal."]]);
	assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered the roll call; 4 messages, 0 decisions; the table wrote 3 of 3 sections \(version 5, checks passed\); 2 review rounds, 2 objections; accepted in round 2 by 3 of 3 models \(/);
	// roll call 300, kickoff 450, outlines 1200, picks 360, drafts 3000, reviews 3600, the revision 1000
	assert.equal(s.run!.usage.tokens, 300 + 450 + 1200 + 360 + 3000 + 3600 + 1000);
	for (const type of ["WorkItem", "LlmCall", "LlmResult", "AgentSlot"]) assert.equal(await srv.stack.space.count({ type, fields: { session: id } }), 0, type);
	// table A of the same block is another document: none yet
	assert.equal((await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}?table=A`)).status, 404);
});

test("objections of two models to one section are one revision by the third; a section named by nobody at the table is none", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const id = room("crowd");
	await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF });
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "parallel", rounds: 1 })).status, 200);
	const s = await ended(srv.url, id), aliases = s.run!.aliases;
	// of alpha's three lines only the one that names a section and a fix is an objection
	const all = await objections(srv.stack.space, id);
	assert.deepEqual(all.map((o) => [o.model, o.sectionId, o.state]).sort(), [["fake/alpha", "s2", "resolved"], ["fake/beta", "s1", "resolved"], ["fake/gamma", "s1", "resolved"]]); // one round: nobody confirmed yet
	const revises = await callsOf(srv.stack.space, id, "revise");
	assert.equal(revises.length, 2);
	const goal = revises.find((c) => c.prompt.includes('Write the section "Goal" anew'))!, steps = revises.find((c) => c.prompt.includes('Write the section "Steps" anew'))!;
	assert.equal(goal.model, "fake/alpha"); // the only one that did not object to it
	assert.ok(["fake/beta", "fake/gamma"].includes(steps.model));
	for (const who of ["fake/beta", "fake/gamma"]) assert.ok(goal.prompt.includes(`- ${aliases[who]}: `), who);
	// one round was asked for: no majority within it
	assert.deepEqual([s.run!.round, s.run!.objections, s.run!.doc!.version, s.run!.ended, s.run!.ballots], [1, { raised: 3, open: 0 }, 6, "rounds", { round: 1, approve: 0, of: 3 }]);
	assert.equal((await callsOf(srv.stack.space, id, "review")).length, 3);
	assert.match(s.lines.at(-1)!.text, /^Run finished \(no majority within 1 round\)/);
});

test("a round goes on after every process was restarted in the middle of it: the objections are still one revision, and the table agrees", async (t) => {
	const dir = mkdtempSync(join(tmpdir(), "forum-test-"));
	const stack = await startStack({ dbPath: join(dir, "space.sqlite"), agents: false, model: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); await rm(dir, { recursive: true, force: true }); });
	const checker = await stack.checker(), agents = await stack.agents({ leaseMs: 2000 }), model = await stack.model({ fakes: true });
	const id = room("bhold");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 200_000, way: "parallel" })).status, 200);
	// the round's ballots are in, the one revision is out and waits at the gate
	await until("the revision to be asked for", async () => (await stack.space.count({ type: "FakeCall", fields: { session: id, kind: "revise" } })) >= 1);
	const before = await snapshot(srv.url, id);
	assert.deepEqual([before.run!.phase, before.run!.round, before.run!.objections], ["revise", 1, { raised: 2, open: 2 }]);
	await stack.kill(agents, "SIGKILL");
	await stack.kill(model);
	await stack.kill(checker);
	await stack.restartSpace();
	await stack.checker(); await stack.agents({ leaseMs: 2000 }); await stack.model({ fakes: true });
	await until("the space to answer again", () => snapshot(srv.url, id).catch(() => null));
	await stack.space.write({ type: "FakeGate", fields: { session: id } }, null, 60_000);
	const s = await ended(srv.url, id);
	// two objections, one revision of the section (one call, whoever answered it in the end), one new version; the
	// second round's ballots confirmed them and accepted it
	const all = await objections(stack.space, id);
	assert.deepEqual(all.map((o) => [o.state, o.revisedIn]), [["confirmed", 5], ["confirmed", 5]]);
	assert.equal(new Set((await callsOf(stack.space, id, "revise")).map((c) => c.callId)).size, 1);
	const view = (await (await fetch(`${srv.url}/api/rooms/${id}/plan/${blockId}`)).json()) as PlanView;
	assert.deepEqual([view.doc.version, view.doc.sections.map((x) => x.rev), view.versions.length], [5, [3, 2, 2], 5]);
	assert.deepEqual([s.run!.phase, s.run!.round, s.run!.objections, s.run!.check?.ok, s.run!.accepted?.version], ["accepted", 2, { raised: 2, open: 0 }, true, 5]);
	// one ballot a model and round, across the restart
	assert.equal(await stack.space.count({ type: "PlanBallot", fields: { session: id } }), 6);
	assert.equal(await stack.space.count({ type: "WorkItem", fields: { session: id } }), 0);
});
