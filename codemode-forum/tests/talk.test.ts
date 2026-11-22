// The discussion of the table: what a model's lines mean, what is kept (the limits a round and a thread, one vote a
// model), who owes a reply, when a proposal is decided; and in a run: the kickoff, the replies, the decision in the
// writer's context, the person's answer and note, a question the person does not answer, and a reply that never comes.
import test from "node:test";
import assert from "node:assert/strict";
import type { Snapshot } from "../server/hub.ts";
import { answerer, decide, decisionsOf, discussionText, keep, messagesOf, owed, parseKickoff, parseMessages, TALK_LIMITS, type PlanDecision, type PlanMessage } from "../server/talk.ts";
import { startServer, startStack } from "./stack.ts";

const THREE = ["fake/alpha", "fake/beta", "fake/gamma"];
const ALIASES = { "fake/alpha": "M1", "fake/beta": "M2", "fake/gamma": "M3" };
const BRIEF = "Plan how the world gets four times the resolution.";
let seq = 0;
const room = (scenario: string) => `${scenario}-t${process.pid}-${seq++}`;
const post = async (url: string, path: string, body: unknown) => {
	const r = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
	return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const snapshot = async (url: string, id: string) => (await (await fetch(`${url}/api/rooms/${id}`)).json()) as Snapshot;
const talk = async (url: string, id: string, blockId: string) => (await (await fetch(`${url}/api/rooms/${id}/talk/${blockId}`)).json()) as { messages: PlanMessage[]; decisions: PlanDecision[] };
async function until<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 40_000): Promise<T> {
	for (const end = Date.now() + ms; ; ) {
		const v = await fn();
		if (v) return v;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((r) => setTimeout(r, 100));
	}
}
const ended = (url: string, id: string) => until(`the end of the run in ${id}`, async () => { const s = await snapshot(url, id); return s.run && !s.run.active ? s : null; });
const prompts = async (space: { readAll: (t: any, o: any) => Promise<Array<{ fields: any }>> }, id: string, kind: string) => (await space.readAll({ type: "FakeCall", fields: { session: id, kind } }, { limit: 20 })).map((e) => e.fields as { model: string; prompt: string });

test("a model's lines are read as messages", () => {
	assert.deepEqual(parseMessages("question to m2: Which files?\n- question: Who decides?\nquestion to the person: May the format change?\nproposal: Scale the grid,\nbecause the art stays.\nnote: See README.\nagree #a1b2: Yes.\ndisagree on #C3D4: No, keep it.\nanswer #e5f6: In src.\nagree: without a thread\nsomething else"), [
		{ kind: "question", to: "M2", text: "Which files?" }, { kind: "question", to: "all", text: "Who decides?" }, { kind: "question", to: "person", text: "May the format change?" },
		{ kind: "proposal", text: "Scale the grid,\nbecause the art stays." }, { kind: "note", text: "See README." },
		{ kind: "vote", thread: "a1b2", stance: "agree", text: "Yes." }, { kind: "vote", thread: "c3d4", stance: "disagree", text: "No, keep it." },
		{ kind: "answer", thread: "e5f6", text: "In src.\nsomething else" }]);
	assert.equal(parseMessages(`note: ${"x".repeat(3000)}`)[0]!.text.length, TALK_LIMITS.text);
	const k = parseKickoff("UNDERSTANDING\nThe plan must raise the resolution.\n\nMESSAGES\nproposal: A\nquestion: B\nnote: C\nagree #a1b2: no vote at a kickoff\nquestion to person: D\nnote: E");
	assert.deepEqual([k.understanding, k.messages.map((m) => m.text)], ["The plan must raise the resolution.", ["A", "B", "C", "D"]]); // four, and no vote
	assert.deepEqual(parseKickoff("Just what I understand."), { understanding: "Just what I understand.", messages: [] });
	assert.throws(() => parseKickoff("UNDERSTANDING\n\nMESSAGES\nnote: x"), /says nothing about the brief/);
});

test("what the table keeps, who owes a reply, and when a proposal is decided", async (t) => {
	const stack = await startStack({ agents: false, model: false });
	t.after(() => stack.close());
	const { space } = stack, d = { session: "talk-test", blockId: `b${process.pid}`, table: "A" };
	const say = async (model: string, said: Parameters<typeof keep>[5], round = 0) => {
		const txn = await space.createTransaction(30_000);
		const kept = await keep(space, txn.id, 600_000, d, { author: "agent-0", model, runId: "r1", round, aliases: ALIASES }, said);
		await space.commit(txn.id);
		return kept;
	};
	const [p, q, toPerson] = await say("fake/alpha", [{ kind: "proposal", text: "Scale the grid." }, { kind: "question", to: "M3", text: "Which files?" }, { kind: "question", to: "person", text: "May the format change?" }, { kind: "question", to: "M1", text: "to myself" }, { kind: "question", to: "M9", text: "to nobody" }]);
	assert.deepEqual([p!.kind, q!.to, toPerson!.to, (await messagesOf(space, d)).length], ["proposal", "fake/gamma", "person", 3]);
	const [all] = await say("fake/beta", [{ kind: "question", to: "all", text: "Who decides?" }]);
	// a question to all goes to the next model at the table
	assert.equal(answerer(all!, THREE, ALIASES), "fake/gamma");
	let o = owed(await messagesOf(space, d), THREE, ALIASES);
	assert.deepEqual([[...o.byModel].map(([m, ts]) => [m, ts.length]).sort(), o.person], [[["fake/beta", 1], ["fake/gamma", 3]], [toPerson!.msgId]]);
	// a vote: none on a proposal of one's own, one a model, none on a question, none on a thread there is not
	assert.equal((await say("fake/alpha", [{ kind: "vote", thread: p!.msgId, stance: "agree", text: "mine" }])).length, 0);
	assert.equal((await say("fake/beta", [{ kind: "vote", thread: p!.msgId, stance: "agree", text: "yes" }, { kind: "vote", thread: p!.msgId, stance: "disagree", text: "again" }, { kind: "vote", thread: q!.msgId, stance: "agree", text: "on a question" }, { kind: "answer", thread: "ffff", text: "nowhere" }])).length, 1);
	// not decided by one of three (the proposer alone does not count twice), decided with the second agreement
	const before = (await messagesOf(space, d)).filter((m) => m.model !== "fake/beta" || m.kind !== "vote");
	assert.deepEqual(decide(before, [], THREE, d), []);
	const decided = decide(await messagesOf(space, d), [], THREE, d);
	assert.deepEqual(decided.map((x) => [x.text, x.agreed, x.against, x.of]), [["Scale the grid.", ["fake/alpha", "fake/beta"], [], 3]]);
	assert.deepEqual(decide(await messagesOf(space, d), decided, THREE, d), []); // once
	await say("fake/gamma", [{ kind: "answer", thread: q!.msgId, text: "In src." }, { kind: "answer", thread: all!.msgId, text: "The table." }, { kind: "vote", thread: p!.msgId, stance: "disagree", text: "keep it" }]);
	o = owed(await messagesOf(space, d), THREE, ALIASES);
	assert.deepEqual([o.byModel.size, o.person.length], [0, 1]);
	// at most twelve messages a model and round, and eight a thread
	assert.equal((await say("fake/gamma", Array.from({ length: 20 }, (_, i) => ({ kind: "note" as const, text: `note ${i}` })))).length, TALK_LIMITS.perModelRound - 3);
	assert.equal((await say("fake/gamma", [{ kind: "note", text: "one more" }])).length, 0);
	assert.equal((await say("fake/gamma", [{ kind: "note", text: "a new round" }], 1)).length, 1);
	const thread = (await say("fake/beta", Array.from({ length: 12 }, () => ({ kind: "answer" as const, thread: toPerson!.msgId, text: "more" })), 2));
	assert.equal(thread.length, TALK_LIMITS.thread - 1); // the question itself is the first of eight
	// what a later prompt shows of it
	const text = discussionText(await messagesOf(space, d), decided, ALIASES, "fake/beta").join("\n\n");
	assert.match(text, /Decided by a majority of the table \(binding for your work\):\n- Scale the grid\. \(2 of 3 agreed\)/);
	assert.match(text, /Questions to the person that got no answer\. Make a sensible assumption for each and name it as an assumption in the plan:\n- May the format change\?/);
	assert.match(text, new RegExp(`#${q!.msgId} question to M3 by M1: Which files\\?\\n   answer by M3: In src\\.`));
	assert.doesNotMatch(text, /fake\//);
});

test("the table talks before it writes: a kickoff, replies, a decision the writer is bound by, and the person's word", async (t) => {
	const stack = await startStack({ agents: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); });
	await stack.agents({ personWaitS: 20 });
	const id = room("talk");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	// the person may speak before any run
	assert.equal((await post(srv.url, `/api/rooms/${id}/message`, { blockId, text: "Keep the old saves readable.", by: "Ada" })).status, 200);
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 80_000 })).status, 200);
	// the run waits for the person: gamma asked them something
	const waiting = await until("the question to the person", async () => { const s = await snapshot(srv.url, id); return s.blocks[0]!.talk.forPerson === 1 && s.run!.phase === "discuss" ? s : null; });
	assert.equal(waiting.run!.active, true);
	const question = (await talk(srv.url, id, blockId)).messages.find((m) => m.to === "person")!;
	assert.deepEqual([question.model, question.text], ["fake/gamma", "May the save format change?"]);
	await new Promise((r) => setTimeout(r, 2500));
	assert.equal((await prompts(stack.space, id, "outline")).length, 0); // nothing is written while the table waits
	const bad = await post(srv.url, `/api/rooms/${id}/message`, { blockId, thread: "ffff", text: "x" });
	assert.deepEqual([bad.status, bad.body.error], [400, "Unknown message to answer"]);
	assert.equal((await post(srv.url, `/api/rooms/${id}/message`, { blockId, thread: question.msgId, text: "No, it must stay as it is.", by: "Ada" })).status, 200);
	const s = await ended(srv.url, id);
	const said = await talk(srv.url, id, blockId), aliases = s.run!.aliases;
	// kept: three understandings, a proposal, a question, a note, a question to the person; the replies: two votes on
	// the proposal and an answer to the question; and the person's two messages
	assert.deepEqual(Object.entries(Object.groupBy(said.messages, (m) => m.kind)).map(([k, ms]) => [k, ms!.length]).sort(), [["answer", 2], ["note", 2], ["proposal", 1], ["question", 2], ["understanding", 3], ["vote", 2]]);
	const votes = said.messages.filter((m) => m.kind === "vote");
	assert.deepEqual(votes.map((v) => [v.model, v.stance]).sort(), [["fake/beta", "agree"], ["fake/gamma", "disagree"]]);
	// the question to the table went to the model after beta at the table, and that one answered it
	const tableQuestion = said.messages.find((m) => m.kind === "question" && m.to === "all")!;
	const order = [...THREE].sort((a, b) => aliases[a]!.localeCompare(aliases[b]!)), next = order[(order.indexOf("fake/beta") + 1) % 3]!;
	assert.deepEqual(said.messages.filter((m) => m.thread === tableQuestion.msgId && m.kind === "answer").map((m) => [m.model, m.text]), [[next, `The answer of ${next}.`]]);
	// two of three agreed: decided
	assert.deepEqual(said.decisions.map((x) => [x.text, [...x.agreed].sort(), x.against, x.of]), [["Keep the tile size and scale the grid, because the art stays as it is.", ["fake/alpha", "fake/beta"], ["fake/gamma"], 3]]);
	assert.deepEqual([s.run!.talk, s.blocks[0]!.talk], [{ messages: 10, decisions: 1 }, { messages: 12, decisions: 1, forPerson: 0 }]);
	assert.match(s.lines.at(-1)!.text, /^Run finished: 3 of 3 models answered the roll call; 10 messages, 1 decision; M1 wrote 3 of 3 sections/);
	// what the writer was told: the person's word first, then the decision; and a reply is asked for by thread
	const outline = (await prompts(stack.space, id, "outline"))[0]!.prompt;
	assert.match(outline, /The person said \(this outranks any decision of the table\):\n- Keep the old saves readable\.\n- to "May the save format change\?": No, it must stay as it is\./);
	assert.match(outline, /Decided by a majority of the table \(binding for your work\):\n- Keep the tile size and scale the grid, because the art stays as it is\. \(2 of 3 agreed\)/);
	assert.ok(outline.indexOf("The person said") < outline.indexOf("Decided by a majority"));
	assert.doesNotMatch(outline, /got no answer/);
	for (const c of await prompts(stack.space, id, "draft")) assert.match(c.prompt, /Decided by a majority of the table/);
	const replies = await prompts(stack.space, id, "reply");
	assert.deepEqual(replies.map((c) => c.model).sort(), ["fake/beta", "fake/gamma"].concat(next === "fake/alpha" ? ["fake/alpha"] : []).sort());
	assert.match(replies.find((c) => c.model === "fake/beta")!.prompt, /You owe the table a reply to these:\n#[0-9a-f]{4} proposal by M\d: Keep the tile size/);
	// roll call 300, kickoff 450, the replies 250 each, outline 400, sections 3000
	assert.equal(s.run!.usage.tokens, 300 + 450 + replies.length * 250 + 400 + 3000);
});

test("a reply that never comes and a question the person does not answer hold the table only until their deadlines", async (t) => {
	const stack = await startStack({ agents: false });
	const srv = await startServer({ stack });
	t.after(async () => { await srv.close(); await stack.close(); });
	await stack.agents({ replyWaitS: 4, personWaitS: 3 });
	const id = room("late");
	const { blockId } = (await post(srv.url, `/api/rooms/${id}/task`, { brief: BRIEF })).body;
	assert.equal((await post(srv.url, `/api/rooms/${id}/run`, { models: THREE, budgetTokens: 80_000 })).status, 200);
	await until("beta to be asked for its reply", async () => (await stack.space.count({ type: "FakeCall", fields: { session: id, kind: "reply", model: "fake/beta" } })) === 1);
	const started = Date.now();
	assert.equal((await snapshot(srv.url, id)).run!.phase, "discuss");
	const s = await ended(srv.url, id);
	assert.ok(Date.now() - started >= 2500, "the table waited for the deadline");
	assert.match(s.run!.note ?? "", new RegExp(`^${s.run!.aliases["fake/beta"]} did not reply to the table \\(the reply came too late\\)`));
	assert.equal(await stack.space.count({ type: "FakeCall", fields: { session: id, kind: "reply", model: "fake/beta" } }), 1); // not asked again
	const said = await talk(srv.url, id, blockId);
	// without beta's vote the proposal has the proposer and gamma: two of three, decided all the same
	assert.deepEqual(said.decisions.map((x) => [...x.agreed].sort()), [["fake/alpha", "fake/gamma"]]);
	assert.equal(s.run!.doc!.written, 3);
	// the writer makes an assumption where the person said nothing
	const outline = (await prompts(stack.space, id, "outline"))[0]!.prompt;
	assert.match(outline, /Questions to the person that got no answer\. Make a sensible assumption for each and name it as an assumption in the plan:\n- May the save format change\?/);
	assert.equal(s.blocks[0]!.talk.forPerson, 1);
	assert.equal((await decisionsOf(stack.space, { session: id, blockId, table: "A" })).length, 1);
});
