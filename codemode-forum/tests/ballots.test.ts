// When a plan counts as agreed: what a ballot says and when it counts as an approval, the tally (a majority of the
// models, not of the authors alone, nothing of the checker or the person open), when a table is stuck; and in runs at
// table B: everybody approves, approvals without evidence, a declined objection, an objection against a section that
// did not change in the third round, a table that is stuck and asks the person, and the person's own yes and no.
import test from "node:test";
import assert from "node:assert/strict";
import { counts, parseBallot, quoted, stalled, tally, type PlanAccept, type PlanBallot } from "../server/ballots.ts";
import type { Snapshot } from "../server/hub.ts";
import type { PlanObjection } from "../server/review.ts";
import type { PlanMessage } from "../server/talk.ts";
import { startServer, startStack } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const BRIEF = "Plan how the world gets four times the resolution.";
let seq = 0;
const room = (scenario: string) => `${scenario}-v${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 90_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const ended = (url: string, id: string, not?: string) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active && s.run.runId !== not ? s : null; });
type Talk = { messages: PlanMessage[]; objections: PlanObjection[]; ballots: PlanBallot[] };
const talkOf = async (url: string, id: string, blockId: string) => (await (await fetch(`${url}/api/rooms/${id}/talk/${blockId}`)).json()) as Talk;
/** A run at table B in a room of the scenario; returns its end. */
async function runB(url: string, scenario: string, o: Record<string, unknown> = {}) {
	const id = room(scenario), { blockId } = (await post(url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	const r = await post(url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "parallel", ...o });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	return { id, blockId: blockId as string, s: await ended(url, id) };
}
const votes = (t: Talk, round: number) => t.ballots.filter((b) => b.round === round).map((b) => [b.model, b.vote, b.counts]).sort();

test("a ballot is read, and counts as an approval only with evidence and nothing standing", () => {
	const sections = [{ sectionId: "s1", title: "Goal" }];
	const b = parseBallot('**BALLOT: APPROVE**\nCRITERIA\n1 met: "the goal of the plan"\n2. met: “names every file”\n- 3 not met: no phases\nCONFIRM\n#o1a2b3c4d resolved\n#o5e6f7a8b not resolved: still vague\n#o9c0d1e2f withdrawn\nOBJECTIONS\nobjection on "Goal": No date. | fix: Name one.\nMESSAGES\nnote: hello', sections);
	assert.deepEqual(b, { vote: "approve", criteria: [{ n: 1, met: true, text: "the goal of the plan" }, { n: 2, met: true, text: "names every file" }, { n: 3, met: false, text: "no phases" }],
		confirm: [{ objId: "o1a2b3c4d", verdict: "resolved" }, { objId: "o5e6f7a8b", verdict: "open", why: "still vague" }, { objId: "o9c0d1e2f", verdict: "withdrawn" }],
		objections: [{ sectionId: "s1", defect: "No date.", fix: "Name one." }], messages: "\nnote: hello" });
	assert.equal(parseBallot("ballot: reject\n1 not met: x", sections).vote, "reject");
	assert.throws(() => parseBallot("I think it is fine.", sections), /names no vote/);
	// words of the plan: at least three, blanks, case and marks aside
	const plan = "The **goal** of the plan:\nraise `RESOLUTION` to 256.";
	assert.deepEqual(["the goal of the plan", "Raise resolution  to 256", "of the", "the aim of the plan", "goal of the plan: raise"].map((q) => quoted(plan, q)), [true, true, false, false, true]);
	// several quotes in one line, or a quote with the model's own remark: one stretch of at least three words is enough
	assert.deepEqual(['the goal of the plan" and "raise `RESOLUTION` to 256', '“The goal of the plan” says what is wanted.', 'the goal of … to 256', '"of the" and "to 256"', 'It says "the aim of the plan" somewhere.'].map((q) => quoted(plan, q)), [true, true, true, false, false]);
	const met = (n: number, backed = true) => ({ n, met: true, text: "x", backed });
	const o = { criteria: 2, blocking: 0, standing: 0 };
	assert.deepEqual(counts({ vote: "approve", criteria: [met(1), met(2)] }, o), { counts: true });
	assert.deepEqual(counts({ vote: "reject", criteria: [met(1), met(2)] }, o), { counts: false });
	assert.match(counts({ vote: "approve", criteria: [met(1)] }, o).why!, /does not rate criterion 2/);
	assert.match(counts({ vote: "approve", criteria: [met(1), { n: 2, met: false, text: "x" }] }, o).why!, /rates criterion 2 as not met/);
	assert.match(counts({ vote: "approve", criteria: [met(1), met(2, false)] }, o).why!, /words it gives for criterion 2 are not in the plan/);
	assert.match(counts({ vote: "approve", criteria: [met(1), met(2)] }, { ...o, blocking: 1 }).why!, /approves and objects at once/);
	assert.match(counts({ vote: "approve", criteria: [met(1), met(2)] }, { ...o, standing: 1 }).why!, /objection of its own still stands/);
});

test("the tally: a majority of the models, not of the authors alone, and nothing of the checker or the person open", () => {
	const FIVE = ["a", "b", "c", "d", "e"], yes = (...models: string[]) => models.map((model) => ({ model, counts: true }));
	const base = { present: FIVE, owing: [], changed: [], first: false, barred: 0 };
	assert.deepEqual(tally({ ...base, ballots: yes("a", "b", "c") }), { accepted: true, approvals: ["a", "b", "c"] });
	assert.deepEqual(tally({ ...base, ballots: yes("a", "b") }), { accepted: false, approvals: ["a", "b"], why: "2 of 5 approve" });
	// a ballot that does not count, a model that is not at the table, two ballots of one model: none adds a vote
	assert.equal(tally({ ...base, ballots: [...yes("a", "b"), { model: "c", counts: false }, ...yes("x", "a", "a")] }).accepted, false);
	// the three who approve wrote the three sections that changed: approval by authors alone is not enough
	const changed = [{ sectionId: "s1", model: "a" }, { sectionId: "s2", model: "b" }, { sectionId: "s3", model: "c" }];
	assert.deepEqual(tally({ ...base, changed, ballots: yes("a", "b", "c") }), { accepted: false, approvals: ["a", "b", "c"], why: "only authors of the changed sections approve" });
	assert.equal(tally({ ...base, changed, ballots: yes("a", "b", "d") }).accepted, true); // d wrote none of them
	// the first round, where every section is new: each needs an approver who did not write it
	const three = { ...base, present: ["a", "b", "c"], first: true };
	assert.equal(tally({ ...three, changed, ballots: yes("a", "b") }).accepted, true);
	assert.equal(tally({ ...three, changed: [{ sectionId: "s1", model: "a" }], ballots: yes("a", "b") }).accepted, true);
	// a model that owes the table an answer does not count yet; an objection of the checker or the person bars
	assert.deepEqual(tally({ ...three, ballots: yes("a", "b"), owing: ["b"] }).why, "1 of 3 approve");
	assert.deepEqual(tally({ ...three, ballots: yes("a", "b", "c"), barred: 1 }).why, "an objection of the checker or the person is open");
	// stuck: the same objections stand as a round ago and nobody more approves
	assert.equal(stalled([{ round: 1, standing: ["o1", "o2"], approvals: 1 }, { round: 2, standing: ["o1", "o2"], approvals: 1 }]), true);
	assert.equal(stalled([{ round: 1, standing: ["o1", "o2"], approvals: 1 }, { round: 2, standing: ["o1"], approvals: 1 }]), false);
	assert.equal(stalled([{ round: 1, standing: ["o1"], approvals: 1 }, { round: 2, standing: ["o1"], approvals: 2 }]), false);
	assert.equal(stalled([{ round: 1, standing: [], approvals: 1 }, { round: 2, standing: [], approvals: 1 }]), false);
	assert.equal(stalled([{ round: 1, standing: ["o1"], approvals: 0 }]), false);
});

test("everybody approves: accepted in the first round, one vote a model however many agents it has", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const { id, blockId, s } = await runB(srv.url, "agree", { perModel: 3 });
	assert.deepEqual([s.run!.phase, s.run!.accepted, s.run!.ballots, s.run!.ended], ["accepted", { version: 4, round: 1, approvals: 3, of: 3 }, { round: 1, approve: 3, of: 3 }, undefined]);
	const talk = await talkOf(srv.url, id, blockId);
	// nine agents, three ballots
	assert.deepEqual(votes(talk, 1), THREE.map((m) => [m, "approve", true]));
	assert.equal(await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "review" } }), 3);
	for (const b of talk.ballots) assert.deepEqual([b.version, b.criteria.length, b.criteria.every((c) => c.met && c.backed)], [4, 7, true]);
	const accept = (await srv.stack.space.readAll({ type: "PlanAccept", fields: { session: id } }, { limit: 5 })).map((e) => e.fields as unknown as PlanAccept);
	assert.deepEqual(accept.map((a) => [a.version, a.by, [...a.approvals].sort(), a.of, a.round]), [[4, "majority", THREE, 3, 1]]);
	assert.deepEqual(s.blocks[0]!.accepted, { version: 4, by: "majority", approvals: accept[0]!.approvals, of: 3, round: 1 });
	assert.ok(s.lines.some((l) => l.text === "The table accepted version 4 in round 1: M1, M2, M3 approve (3 of 3)"));
	assert.match(s.lines.at(-1)!.text, /the table wrote 3 of 3 sections \(version 4, checks passed\); 1 review round, 0 objections; accepted in round 1 by 3 of 3 models \(/);
});

test("an approval whose words are not in the plan is none; a table with nothing to revise and no majority asks the person", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const { id, blockId, s } = await runB(srv.url, "bare");
	const talk = await talkOf(srv.url, id, blockId);
	assert.deepEqual(votes(talk, 1), [["fake/alpha", "approve", false], ["fake/beta", "approve", false], ["fake/gamma", "approve", true]]);
	assert.match(talk.ballots.find((b) => b.model === "fake/alpha")!.why!, /the words it gives for criterion 1, 2, 3, 4, 5, 6, 7 are not in the plan/);
	// one of three: not accepted, and nothing to revise. The tests' agents do not wait for the person, so the run ends there
	assert.deepEqual([s.run!.accepted, s.run!.ballots, s.run!.ended, s.blocks[0]!.accepted], [undefined, { round: 1, approve: 1, of: 3 }, "stalled", null]);
	const question = talk.messages.find((m) => m.to === "person")!;
	assert.deepEqual([question.model, question.text], ["table", "The table is stuck after round 1: 1 of 3 approve version 4 (1 of 3 approve).\nHow shall the table go on?"]);
	assert.match(s.lines.at(-1)!.text, /^Run finished \(the table is stuck and the person did not answer\)/);
});

test("a declined objection stands for the one who raised it and for nobody else", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const { id, blockId, s } = await runB(srv.url, "declined");
	const talk = await talkOf(srv.url, id, blockId);
	// the reviser left both sections as they were (one model objects to each): both objections declined, no new version
	assert.equal(s.run!.doc!.version, 4);
	assert.deepEqual(talk.objections.map((o) => [o.model, o.state]).sort(), [["fake/beta", "declined"], ["fake/gamma", "withdrawn"]]);
	// round two: gamma withdraws and approves, beta keeps its objection and so cannot approve; two of three is a majority
	assert.deepEqual(votes(talk, 1), [["fake/alpha", "approve", true], ["fake/beta", "reject", false], ["fake/gamma", "reject", false]]);
	assert.deepEqual(votes(talk, 2), [["fake/alpha", "approve", true], ["fake/beta", "reject", false], ["fake/gamma", "approve", true]]);
	assert.deepEqual([s.run!.accepted, s.run!.objections], [{ version: 4, round: 2, approvals: 2, of: 3 }, { raised: 2, open: 1 }]);
	// the raisers were told what the reviser did
	const second = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "review", round: 2, model: "fake/beta" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
	assert.match(second[0]!.prompt, /Your own earlier objections\. Say under CONFIRM what became of each:\n#o[0-9a-f]+ on "Goal": It does not name the target value\. \(the reviser left the section as it was: it found your objection wrong\)/);
});

test("from the third round on an objection against a section that did not change is a note and holds nothing up", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const { id, blockId, s } = await runB(srv.url, "settle", { rounds: 3 });
	const talk = await talkOf(srv.url, id, blockId);
	// rounds one and two: objections to the goal, each taken up; round three: beta objects to the risks, which nobody touched
	const late = talk.objections.find((o) => o.round === 3)!;
	assert.deepEqual([late.model, late.sectionId, late.state, late.defect], ["fake/beta", "s3", "note", "It names no risk of the migration."]);
	assert.deepEqual(talk.objections.filter((o) => o.round < 3).map((o) => o.state), ["confirmed", "confirmed", "confirmed", "confirmed"]);
	// beta rejected, but a note does not block: alpha and gamma are a majority, and they did not both write the change
	assert.deepEqual(votes(talk, 3), [["fake/alpha", "approve", true], ["fake/beta", "reject", false], ["fake/gamma", "approve", true]]);
	assert.deepEqual([s.run!.accepted?.round, s.run!.accepted?.approvals, s.run!.round, s.run!.doc!.version], [3, 2, 3, 6]);
	const third = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "review", round: 3, model: "fake/beta" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
	assert.match(third[0]!.prompt, /From this round on a new objection counts only against a section that changed since your last ballot \("Goal"\)/);
});

test("a table that is stuck asks the person and goes on with their answer", async (t) => {
	const stack = await startStack({ agents: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); });
	await stack.agents({ personWaitS: 60 });
	const id = room("stuck"), { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "parallel", rounds: 4 })).status, 200);
	// round one: two objections, revised; round two: both say "not resolved": the same two stand, nobody more approves
	const stuck = await until("the table to be stuck", async () => { const s = await snapshot(srv.url, id); return s.run!.phase === "stalled" ? s : null; });
	assert.deepEqual([stuck.run!.round, stuck.run!.ballots, stuck.run!.objections, stuck.blocks[0]!.talk.forPerson], [2, { round: 2, approve: 1, of: 3 }, { raised: 2, open: 2 }, 1]);
	const before = await talkOf(srv.url, id, blockId), question = before.messages.find((m) => m.to === "person")!;
	assert.match(question.text, /^The table is stuck after round 2: 1 of 3 approve version 5 \(1 of 3 approve\)\. Still standing:\n- M\d on "Goal": It (does not name the target value|gives no reason)\.\n- M\d on "Goal": /);
	assert.deepEqual(before.objections.map((o) => [o.state, o.reopened]), [["open", 1], ["open", 1]]);
	assert.equal((await post(srv.url, `/api/rooms/${id}/message`, { blockId, thread: question.msgId, text: "Take beta's point: name 256 and say why.", by: "Ada" })).status, 200);
	const s = await ended(srv.url, id);
	// with the person's word the goal is revised once more, and round three agrees
	assert.deepEqual([s.run!.accepted?.round, s.run!.accepted?.approvals, s.run!.doc!.version, s.run!.ended], [3, 3, 6, undefined]);
	assert.deepEqual((await talkOf(srv.url, id, blockId)).objections.map((o) => o.state), ["confirmed", "confirmed"]);
});

test("the person's no is an objection nobody can pass, and their yes accepts a version", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	// a document without ballots first (no rounds), then the person objects to a section of it
	const { id, blockId, s: first } = await runB(srv.url, "agree", { rounds: 0 });
	assert.deepEqual([first.run!.phase, first.run!.accepted, first.blocks[0]!.accepted, first.run!.doc!.version], ["done", undefined, null, 4]);
	const bad = await post(srv.url, `/api/rooms/${id}/objection`, { blockId, section: "Costs", text: "x" });
	assert.deepEqual([bad.status, bad.body.error], [400, "Name the section the objection is about"]);
	assert.equal((await post(srv.url, `/api/rooms/${id}/objection`, { blockId, section: "goal", text: "The goal must name a date.", by: "Ada" })).status, 200);
	// the next run: everybody approves version 4, but the person's objection is open; it is taken up, then accepted
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 400_000, way: "parallel" })).status, 200);
	const s = await ended(srv.url, id, first.run!.runId), talk = await talkOf(srv.url, id, blockId);
	assert.deepEqual(votes(talk, 1), THREE.map((m) => [m, "approve", true]));
	assert.deepEqual(talk.objections.map((o) => [o.model, o.author, o.state, o.revisedIn]), [["human", "Ada", "resolved", 5]]);
	assert.deepEqual([s.run!.accepted, s.run!.doc!.version], [{ version: 5, round: 2, approvals: 3, of: 3 }, 5]);
	const revise = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "revise" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
	assert.match(revise[0]!.prompt, /- the person: The goal must name a date\. What would resolve it: as the person says/);
	// the person's yes: any version, whatever the table said
	const yes = await post(srv.url, `/api/rooms/${id}/accept`, { blockId, version: 4, by: "Ada" });
	assert.deepEqual([yes.status, yes.body.version], [200, 4]);
	assert.deepEqual((await snapshot(srv.url, id)).blocks[0]!.accepted, { version: 4, by: "person", who: "Ada", approvals: [], of: 0 });
	assert.equal((await post(srv.url, `/api/rooms/${id}/accept`, { blockId, version: 99 })).status, 400);
});

test("a reviser cannot leave a section as it is when more than half of the other models object to it", async (t) => {
	const srv = await startServer();
	t.after(() => srv.close());
	const { id, blockId, s } = await runB(srv.url, "overruled", { rounds: 1 });
	const talk = await talkOf(srv.url, id, blockId);
	// three tries, each handed back unchanged and refused: no new version, and the objections stay open, not declined
	assert.equal(await srv.stack.space.count({ type: "FakeCall", fields: { session: id, kind: "revise" } }), 3);
	assert.deepEqual([s.run!.doc!.version, s.run!.ended, s.run!.objections], [4, "rounds", { raised: 2, open: 2 }]);
	assert.deepEqual(talk.objections.map((o) => [o.model, o.state]).sort(), [["fake/beta", "open"], ["fake/gamma", "open"]]);
	const revise = (await srv.stack.space.readAll({ type: "FakeCall", fields: { session: id, kind: "revise" } }, { limit: 5 })).map((e) => e.fields as unknown as { prompt: string });
	assert.match(revise[0]!.prompt, /More than half of the other models object to this section: it must change/);
});
