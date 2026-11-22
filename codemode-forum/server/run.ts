// A run in the shared space, carried out by agent processes without any coordinator. The mechanics are taken over from
// codemode-chat/server/run.ts (slots, work items, the run as its own lock, `pending`, the budget admitted before each
// model call); the kinds of work are the forum's own.
//
//   ForumRun     the run: its parameters, what it shows (info) and the count of its open items; `unique` per room.
//                It is also the run's lock: whoever changes it takes it under its own transaction and writes it back.
//   AgentSlot    one per agent: an agents process takes it under a long transaction and works as that agent until the
//                run is over (a process that dies lets the transaction lapse, and another takes the slot).
//   WorkItem     work of the run. So far: `rollcall`, one per model, in which the model says that it is there (the
//                opening every run has); `kickoff`, one per model at the table, in which it says how it understands
//                the brief and may ask and propose (talk.ts); `reply`, one per model that owes the table an answer or
//                a vote; `person`, which waits for the person's answers until its deadline; `outline`, in which one model proposes the document's sections; `draft`, one
//                per section, in which that model writes it. The kinds of the joint work follow with their phases.
//   ReadStep     a step of an item's reading in the task's sources: the calls its model asked for and what they
//                returned (calls.ts). Kept per item, so an agent that takes the item over does not read again.
//   RollCall     a model's answer to the roll call.
//   ForumRunDone how a run ended (its info), for the page after the ForumRun is gone.
//   ForumLine    a system line of the room (a run started, how it ended).
//
// An agent does an item inside one transaction: take the item, ask the model process (callModel), write the result,
// update the ForumRun, commit. A crash rolls all of it back and the item is there again: every item is done exactly
// once, and a model call that already ran is not paid twice (its answer waits for the retry). A call's usage is booked
// on the run in the commit that takes its LlmResult (success or failure), so exactly once. The ForumRun counts the
// items not done yet (`pending`) in the same commits that write and finish them: the run is over when that count is 0,
// whatever another agent holds right now.
import { randomBytes } from "node:crypto";
import { NO_WAIT, UniqueConflict, type SpaceLike } from "phi-spaces";
import type { Usage } from "./llm.ts";
import { mayRead, parseOutline, parseReads, parseSection, READING, readSteps, ROLLCALL_CHARS, sourcesOf, type CallKind, type LlmCall, type LlmResultEntry, type ReadStep } from "./calls.ts";
import { askSources } from "./source-host.ts";
import { FATAL_LLM, MIN_MODELS, modelWaitMs, personWaitMs, replyWaitMs } from "./limits.ts";
import { decide, decisionsOf, keep, messagesOf, owed, parseKickoff, parseMessages } from "./talk.ts";
import { DocRefused, headOf, writeVersion, type PlanDoc } from "./plandoc.ts";
import type { PlanTask } from "./plantask.ts";
import { keepAlive, readExisting, StillHeld, takeAll, takeExisting } from "./space.ts";

export const rid = () => randomBytes(4).toString("hex");

/** What the page shows of a run. `aliases`: the name each model has at the table (M1, M2, …), drawn per run. */
export type RunInfo = { active: boolean; runId: string; blockId: string; models: string[]; perModel: number; aliases: Record<string, string>;
	/** Where the run is: the roll call, the outline, the drafts of the sections, or through with them. */
	phase: "rollcall" | "kickoff" | "discuss" | "outline" | "draft" | "done";
	/** The models that answered the roll call: the table. And what the table said: messages kept, decisions taken. */
	present?: string[]; talk?: { messages: number; decisions: number };
	/** The model that writes the first draft (the first by its name at the table among those that answered the roll
	 *  call), and how far its document is: the table, the newest version, its sections and how many are written. */
	writer?: string; doc?: { table: string; version: number; sections: number; written: number };
	items: { open: number; done: number }; usage: { tokens: number; costUsd: number };
	/** Limits of the run's model calls; whichever is reached first ends it. */
	budget: { tokens?: number; usd?: number }; note?: string;
	/** Why the run ended, when it was not stopped and did not finish its work: the budget, or fewer than three models
	 *  answered the roll call. */
	ended?: "budget" | "models" };
/** What a run was started with. */
export type RunParams = { runId: string; blockId: string; startedAt: number; models: string[]; perModel: number; aliases: Record<string, string>; lang: "de" | "en"; budget: { tokens?: number; usd?: number };
	/** Who started it: a visitor's usage counts against the day's allowance of their address; an admin's does not. */
	client?: { ip: string; admin: boolean } };
export type RunEntry = { session: string; runId: string; params: RunParams; info: RunInfo;
	/** Work items written and not done yet (a waiting item that goes back stays counted), and how many of them the
	 *  phase still waits for before the next one begins. */
	pending: number; phaseLeft: number;
	/** The budget held by model calls in flight, per item (released when the item books its call), and the calls
	 *  booked so far (their average is what the next call is expected to cost). */
	reserved?: Record<string, { tokens: number; usd: number }>; booked?: number; ts: number };
export type WorkKind = "rollcall" | "kickoff" | "reply" | "person" | "outline" | "draft";
/** `onlyModel`: only an agent of that model may take it, until its `deadline` has passed: then any agent takes it to
 *  close it. `table`, `sectionId`: the document and section it works on. `threads`: what a reply is owed to. */
export type WorkItem = { session: string; runId: string; itemId: string; kind: WorkKind; ts: number; onlyModel?: string; notBefore?: number; tries?: number; table?: string; sectionId?: string; threads?: string[]; deadline?: number };
export type Slot = { session: string; runId: string; agent: number; model: string };
/** A model's answer to the roll call. */
export type RollCall = { session: string; runId: string; model: string; alias: string; agent: number; text: string; usage?: Usage; ts: number };

/** An item's and a slot's transaction lease (renewed while they are worked on): a dead agent's work is back within it
 *  (FORUM_AGENT_LEASE_MS, default 60 s). */
export const ITEM_LEASE_MS = Math.max(1000, Number(process.env.FORUM_AGENT_LEASE_MS || 60_000));
/** Failed tries of an item before it is given up (it then counts as done, with nothing handed in). */
const MAX_TRIES = 3;
/** A failure that trying again will not mend. */
const FINAL = /is not allowed|has no |the run's budget is used up|stopped \d+ times while|is gone$|came too late/i;
/** The table the first draft is written at. */
const TABLE = "A";
/** Hard deaths of an agents process during an item's model call after which the item is given up. */
const MAX_DEATHS = 2;
/** What an item's model call used, for a failure after it (the call's result goes back with the item's aborted
 *  transaction, and the next try asks anew: this usage is booked with the failure). */
const paid = new WeakMap<WorkItem, Usage | undefined>();
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run is gone (stopped, or ended by another agent): the work in progress is dropped. */
class RunGone extends Error {}
/** The run still has work: it is not ended. */
class NotOver extends Error {}
/** A model call that failed: the item is tried again (a new call), given up, or the run ends as over budget. `usage`:
 *  what the call used before it failed, booked with whatever this item does next. */
class ModelFailed extends Error { usage?: Usage; constructor(message: string, usage?: Usage) { super(message); this.usage = usage; } }
/** A call that must wait: the run's budget is taken up by the calls in flight. Not a failed try. */
class Wait extends Error {}

const itemEntry = (it: WorkItem) => ({ type: "WorkItem", fields: it as never });
const newItem = (run: { session: string; runId: string }, kind: WorkKind, more: Partial<WorkItem> = {}): WorkItem =>
	({ session: run.session, runId: run.runId, itemId: `${run.runId}-${Date.now().toString(36)}${rid()}`, kind, ts: Date.now(), ...more });

/** A system line of the room. */
export async function systemLine(space: SpaceLike, txn: string | null, ttl: number, session: string, text: string): Promise<void> {
	await space.write({ type: "ForumLine", fields: { session, text, ts: Date.now() } }, txn, ttl);
}

/** The run's ForumRun as it is now (null: gone). One another agent holds for a moment is waited for; one held for
 *  longer throws StillHeld (it is not gone). */
export async function readRun(space: SpaceLike, session: string, runId: string): Promise<RunEntry | null> {
	return ((await readExisting(space, { type: "ForumRun", fields: { session, runId } }))?.fields as unknown as RunEntry | undefined) ?? null;
}

/** Changes the ForumRun in `txn` (taken and written back: the lock of the run). RunGone when it is not there. */
async function updateRun(space: SpaceLike, txn: string, ttl: number, session: string, runId: string, fn: (r: RunEntry) => void | Promise<void>): Promise<RunEntry> {
	const e = await takeExisting(space, { type: "ForumRun", fields: { session, runId } }, { txn });
	if (!e) throw new RunGone();
	const r = structuredClone(e.fields as unknown as RunEntry);
	await fn(r);
	await space.write({ type: "ForumRun", fields: { ...r, ts: Date.now() } as never }, txn, ttl);
	return r;
}

/** Whether a run's model calls have used up its budget (tokens or dollars, whichever comes first). */
const overBudget = (r: RunEntry) => { const b = r.info.budget, u = r.info.usage; return (b.tokens !== undefined && u.tokens >= b.tokens) || (b.usd !== undefined && u.costUsd >= b.usd); };
/** Books a call's usage on the run and releases the budget the item held for it (`keep`: the item goes on with
 *  another call and holds it still); over the budget the run ends once its open items are done. */
const book = (r: RunEntry, usage: Usage | undefined, itemId: string, keep = false) => {
	if (usage) { r.info.usage = { tokens: r.info.usage.tokens + usage.total, costUsd: r.info.usage.costUsd + usage.costUsd }; r.booked = (r.booked ?? 0) + 1; }
	if (!keep && r.reserved?.[itemId]) { const { [itemId]: _held, ...rest } = r.reserved; r.reserved = rest; }
	if (overBudget(r)) r.info.ended ??= "budget";
};
/** An item is done (in the run's update): it no longer counts as open. */
const done = (r: RunEntry) => { r.pending--; r.info.items = { open: Math.max(0, r.pending), done: r.info.items.done + 1 }; };

/** What a call is expected to cost before the run has booked any (tokens; dollars stay unknown until then). */
const FIRST_CALL_TOKENS = 4000;
/** What the next call is expected to cost: the run's average per booked call. */
const estimate = (r: RunEntry) => (r.booked ? { tokens: Math.ceil(r.info.usage.tokens / r.booked), usd: r.info.usage.costUsd / r.booked } : { tokens: FIRST_CALL_TOKENS, usd: 0 });

/** Admits a model call of an item against the run's budget, under the run's lock and committed before the call: the
 *  call may go when what was booked plus what the calls in flight hold stays below the budget, and then holds its
 *  estimate itself. Otherwise it waits (Wait) for those calls to book; once the booked usage alone reaches the budget
 *  the run is over (ModelFailed). An item that comes back after a crash finds its own reservation and goes. So the
 *  run ends at most one call's estimate (plus the estimates' error) beyond its budget. */
async function admit(d: AgentDeps, it: WorkItem): Promise<void> {
	let verdict = "go" as "go" | "wait" | "over";
	await inTxn(d.space, d.open, (t) => updateRun(d.space, t, d.ttl, it.session, it.runId, (r) => {
		const b = r.info.budget;
		if (r.reserved?.[it.itemId]) return;
		if (r.info.ended || overBudget(r)) { verdict = "over"; return; }
		const held = Object.values(r.reserved ?? {});
		const tokens = r.info.usage.tokens + held.reduce((n, x) => n + x.tokens, 0), usd = r.info.usage.costUsd + held.reduce((n, x) => n + x.usd, 0);
		if ((b.tokens !== undefined && tokens >= b.tokens) || (b.usd !== undefined && usd >= b.usd)) { verdict = "wait"; return; }
		r.reserved = { ...r.reserved, [it.itemId]: estimate(r) };
	}));
	if (verdict === "wait") throw new Wait();
	if (verdict === "over") throw new ModelFailed("the run's budget is used up");
}

/** The closing line of a run (how it ended, how far it got). */
async function closingLine(space: SpaceLike, r: RunEntry, how: "finished" | "stopped"): Promise<string> {
	const present = await space.count({ type: "RollCall", fields: { session: r.session, runId: r.runId } });
	const why = r.info.ended === "budget" ? " (budget used up)" : r.info.ended === "models" ? ` (fewer than ${MIN_MODELS} models answered)` : "";
	const cost = `${r.info.usage.tokens} tokens${r.info.usage.costUsd ? `, $${r.info.usage.costUsd.toFixed(4)}` : ""}`;
	const doc = r.info.doc, writer = r.params.aliases[r.info.writer ?? ""];
	const talk = r.info.talk ? `; ${r.info.talk.messages} messages, ${r.info.talk.decisions} decision${r.info.talk.decisions === 1 ? "" : "s"}` : "";
	const draft = doc ? `${talk}; ${writer} wrote ${doc.written} of ${doc.sections} sections of the first draft (version ${doc.version})` : "";
	return `Run ${how}${why}: ${present} of ${r.params.models.length} models answered the roll call${draft || talk} (${cost})`;
}

/** Ends a run in `txn`: its ForumRun goes (taken: only one ender succeeds), its left-over items and slots go, a
 *  ForumRunDone keeps how it ended, and the closing line is written. False when the run was already gone; StillHeld
 *  when another transaction holds it for long; NotOver (abort the transaction) when `over` says it still has work. */
export async function endRun(space: SpaceLike, txn: string, ttl: number, session: string, runId: string, how: "finished" | "stopped", over?: (r: RunEntry) => Promise<boolean>): Promise<boolean> {
	const e = await takeExisting(space, { type: "ForumRun", fields: { session, runId } }, { txn });
	if (!e) return false;
	const r = e.fields as unknown as RunEntry;
	if (over && !(await over(r))) throw new NotOver();
	for (let n = 0; n < 2000 && (await space.take({ type: "WorkItem", fields: { session, runId } }, NO_WAIT, { txn })); n++);
	for (let n = 0; n < 200 && (await space.take({ type: "AgentSlot", fields: { session, runId } }, NO_WAIT, { txn })); n++);
	await takeAll(space, { type: "ForumRunDone", fields: { session } }, { txn });
	await space.write({ type: "ForumRunDone", fields: { session, runId, info: { ...r.info, active: false, items: { ...r.info.items, open: 0 } }, how, ts: Date.now() } as never }, txn, ttl);
	await systemLine(space, txn, ttl, session, await closingLine(space, r, how));
	return true;
}

/** Runs `fn` in a fresh transaction (renewed while it runs, aborted on any failure, listed in `open` so a shutdown can
 *  abort it). */
async function inTxn<T>(space: SpaceLike, open: Set<string>, fn: (txn: string) => Promise<T>): Promise<T> {
	const t = await space.createTransaction(ITEM_LEASE_MS);
	open.add(t.id);
	const stop = keepAlive(space, t.id, ITEM_LEASE_MS);
	try { const v = await fn(t.id); await space.commit(t.id); return v; }
	// a refused abort (the space's call rate) is tried once more after its window: else the transaction keeps what it took
	// (the run entry, the item) until its lease lapses
	catch (e) { await space.abort(t.id).catch(() => pause(1100).then(() => space.abort(t.id)).catch(() => {})); throw e; }
	finally { stop(); open.delete(t.id); }
}

/** Asks the model process for a call and waits for its answer, in `txn`: the answer is taken in the item's
 *  transaction, so if the item is cut off it stays for the next try. The call's id belongs to the item (and its try),
 *  so a repeated item finds the answer from before (or the call still waiting: written `unique`) instead of paying for
 *  a second call. `until`: a deadline of the caller's own, after which it waits no longer. */
export async function callModel(space: SpaceLike, txn: string, call: LlmCall, until = Infinity): Promise<LlmResultEntry> {
	const tmpl = { type: "LlmResult", fields: { callId: call.callId } };
	let r = await space.take(tmpl, NO_WAIT, { txn });
	if (!r) {
		try { await space.write({ type: "LlmCall", fields: call as never }, null, modelWaitMs() + 60_000, { unique: ["callId"] }); }
		catch (e) { if (!(e instanceof UniqueConflict)) throw e; } // asked before, the answer is still coming
		const end = Math.min(until, Date.now() + modelWaitMs());
		while (!r && Date.now() < end) r = await space.take(tmpl, Math.min(20_000, Math.max(1, end - Date.now())), { txn });
		// given up: a call no model process has taken yet is withdrawn, so nobody pays for an answer nobody fetches
		if (!r) await space.take({ type: "LlmCall", fields: { callId: call.callId } }, NO_WAIT).catch(() => null);
	}
	return (r?.fields as unknown as LlmResultEntry | undefined) ?? { callId: call.callId, session: call.session, ok: false, error: Date.now() >= until ? "the reply came too late" : "the model process did not answer in time", ts: Date.now() };
}

export type AgentDeps = { space: SpaceLike; ttl: number; open: Set<string>; stopping: () => boolean };

/** One agent of a run: takes the items it may do, one after the other, until the run is over (or the process stops). */
export async function agentLoop(d: AgentDeps, slot: Slot): Promise<void> {
	const { space } = d;
	while (!d.stopping()) {
		let run: RunEntry | null;
		try { run = await readRun(space, slot.session, slot.runId); }
		catch (e) { if (e instanceof StillHeld) { await pause(300); continue; } throw e; } // held for long: not gone
		if (!run) return;
		if (await workOnce(d, slot)) continue;
		if (await maybeEnd(d, slot)) return;
		await pause(300);
	}
}

/** May this agent take this item now? An item for one model waits for an agent of that model, until its deadline. */
const eligible = (it: WorkItem, model: string, now: number) => (it.notBefore ?? 0) <= now && (!it.onlyModel || it.onlyModel === model || (!!it.deadline && now > it.deadline));

/** Takes and does one item this agent may do; false when there was none (or the only ones are not due yet). */
async function workOnce(d: AgentDeps, slot: Slot): Promise<boolean> {
	const { space } = d, now = Date.now();
	const rows = (await space.readAll({ type: "WorkItem", fields: { session: slot.session, runId: slot.runId } }, { limit: 500 }))
		.map((e) => ({ id: e.id, it: e.fields as unknown as WorkItem }))
		.filter(({ it }) => eligible(it, slot.model, now))
		.sort((a, b) => a.it.ts - b.it.ts);
	for (const { id, it } of rows) {
		try {
			const did = await inTxn(space, d.open, async (txn) => {
				if (!(await space.take({ id }, NO_WAIT, { txn }))) return null; // another agent took it first
				try { await execute(d, slot, it, txn); return "done" as const; }
				catch (e) {
					// the budget is held by calls in flight: the item goes back for a little while, not as a failed try
					if (e instanceof Wait) { await space.write(itemEntry({ ...it, notBefore: Date.now() + 2000 }), txn, d.ttl); return "waiting" as const; }
					if (!(e instanceof ModelFailed)) throw e;
					// handled in this transaction: the failed answer is used up, the item goes back or counts as done
					await failed(d, it, txn, e.message, e.usage);
					return "done" as const;
				}
			});
			if (did === null) continue;
			return did !== "waiting";
		} catch (e) {
			if (e instanceof StillHeld) return true; // the run stayed held: the item is back, try again
			// the run is gone (stopped, ended): the item it came back with goes too, it would only wait for its TTL
			// (the answer of its call too, which came back with the aborted transaction, and a call nobody took yet)
			if (e instanceof RunGone) {
				await space.take({ id }, NO_WAIT).catch(() => null);
				for (const type of ["LlmResult", "LlmCall"]) await takeAll(space, { type, fields: { session: it.session, itemId: it.itemId } }).catch(() => null);
				return false;
			}
			if (d.stopping()) return false;
			console.error("[agents] item failed", it.kind, (e as Error).message);
			// the answer of the try came back with the aborted transaction; the next try asks anew, so it goes
			await takeAll(space, { type: "LlmResult", fields: { session: it.session, itemId: it.itemId } }).catch(() => null);
			await inTxn(space, d.open, async (txn) => { if (await space.take({ id }, NO_WAIT, { txn })) await failed(d, it, txn, (e as Error).message, paid.get(it)); }).catch(() => {});
			return true;
		}
	}
	return false;
}

/** A failed item, in `txn` (the item is already taken): after a fatal failure (the day's model calls used up) the run
 *  ends as over budget; a passing one is tried again later with a new call, at most MAX_TRIES times; otherwise the
 *  item counts as done with nothing handed in. What the failed call used is booked on the run either way. */
async function failed(d: AgentDeps, it: WorkItem, txn: string, why: string, usage?: Usage): Promise<void> {
	const { space } = d, tries = (it.tries ?? 0) + 1;
	if (!FATAL_LLM.test(why) && !FINAL.test(why) && tries < MAX_TRIES) {
		// under the run's lock also without a usage to book: a run that is gone (stopped while the call was out) throws
		// RunGone here, and the item goes with it instead of waiting for a try nobody makes
		await updateRun(space, txn, d.ttl, it.session, it.runId, (r) => book(r, usage, it.itemId));
		await space.write(itemEntry({ ...it, tries, notBefore: Date.now() + 2000 * tries }), txn, d.ttl);
		return;
	}
	await updateRun(space, txn, d.ttl, it.session, it.runId, async (r) => {
		book(r, usage, it.itemId);
		if (FATAL_LLM.test(why)) r.info.ended ??= "budget";
		const who = r.params.aliases[it.onlyModel ?? ""] ?? "a model", reason = why.slice(0, 120);
		r.info.note = it.kind === "rollcall" ? `${who} did not answer the roll call (${reason})` : it.kind === "kickoff" ? `${who} said nothing at the kickoff (${reason})` : it.kind === "reply" ? `${who} did not reply to the table (${reason}); the run goes on without its reply` : it.kind === "outline" ? `${who} wrote no outline (${reason}); the run ends without a document` : `${who} did not write a section (${reason}); it keeps what it is to say`;
		await finish(d, txn, r, it);
	});
}

/** A model call of an item; ModelFailed when it does not answer. The call id carries the item's try. */
async function ask(d: AgentDeps, txn: string, it: WorkItem, slot: Slot, run: RunEntry, n: number, kind: CallKind, more: Partial<LlmCall> = {}, until = Infinity): Promise<Record<string, unknown>> {
	await admit(d, it);
	// an agents process that dies hard during the call leaves its ItemStart behind: an item that took down MAX_DEATHS
	// processes is given up instead of taking down the next one (a graceful stop cancels the marker)
	const k = { session: it.session, runId: it.runId, itemId: it.itemId };
	const deaths = await d.space.count({ type: "ItemStart", fields: k });
	if (deaths >= MAX_DEATHS) throw new ModelFailed(`the agents process stopped ${deaths} times while working on this item`);
	const start = await d.space.write({ type: "ItemStart", fields: k }, null, modelWaitMs() + 120_000);
	let res: LlmResultEntry;
	try { res = await callModel(d.space, txn, { callId: `${it.itemId}-t${it.tries ?? 0}-c${n}`, session: it.session, runId: it.runId, itemId: it.itemId, kind, agent: slot.agent, model: slot.model, lang: run.params.lang, ...(run.params.client ? { client: run.params.client } : {}), ts: Date.now(), ...more }, until); }
	finally { await d.space.cancel(start.id).catch(() => {}); }
	if (!res.ok || !res.value) throw new ModelFailed(res.error ?? "the model call failed", res.usage);
	paid.set(it, res.usage ?? (res.value.usage as Usage | undefined));
	return res.value;
}

/** The work of an item that may read in the task's sources first (calls.ts): model calls in steps, each either a
 *  request for reading calls, which the sources process answers and a ReadStep keeps, or the work itself, which is
 *  returned. A step is kept and its call booked in one commit, so after a crash the next agent goes on behind the
 *  last kept step: nothing is read or booked twice. Without sources it is one call. */
async function work(d: AgentDeps, txn: string, it: WorkItem, slot: Slot, run: RunEntry, kind: CallKind, more: Partial<LlmCall>): Promise<{ text: string; usage?: Usage }> {
	const { space } = d, sources = await sourcesOf(space, it.session, run.params.blockId);
	for (;;) {
		const steps = sources.length ? await readSteps(space, it.session, it.itemId) : [];
		// the steps before were booked as they were kept: the budget may be gone by now
		if (steps.length) { const now = await readRun(space, it.session, it.runId); if (!now) throw new RunGone(); if (now.info.ended || overBudget(now)) throw new ModelFailed("the run's budget is used up"); }
		const v = await ask(d, txn, it, slot, run, steps.length, kind, more) as { text: string; usage?: Usage };
		const reads = sources.length ? parseReads(String(v.text), sources.map((x) => x.sourceId)) : null;
		if (!reads) return v;
		if (!mayRead(steps)) throw new ModelFailed("the model asked to read when it had to hand in its work", v.usage);
		const texts: string[] = [];
		for (const r of reads) {
			let text: string;
			try { text = (await askSources(space, { requestId: `${it.itemId}-s${steps.length}-${texts.length}-${rid()}`, session: it.session, blockId: run.params.blockId, op: "call", sourceId: r.sourceId as "docs" | "repo", call: r.call, ts: Date.now() })).text ?? ""; }
			catch (e) { throw new ModelFailed(`the sources did not answer: ${(e as Error).message}`, v.usage); }
			texts.push(`> ${r.line}\n${text.length > READING.resultBytes ? text.slice(0, READING.resultBytes) + "\n…" : text}`);
		}
		if (!reads.length) texts.push("(none of your lines was a reading call: use list, read or search)");
		const step: ReadStep = { session: it.session, runId: it.runId, itemId: it.itemId, step: steps.length, slot: `${it.itemId}:${steps.length}`, requests: reads.map((r) => r.line), text: texts.join("\n\n"), ...(v.usage ? { usage: v.usage } : {}), ts: Date.now() };
		await inTxn(space, d.open, async (t) => {
			try { await space.write({ type: "ReadStep", fields: step as never }, t, d.ttl, { unique: ["slot"] }); }
			catch (e) { if (e instanceof UniqueConflict) return; throw e; } // kept before (and booked with it)
			await updateRun(space, t, d.ttl, it.session, it.runId, (r) => book(r, v.usage, it.itemId, true));
		});
		paid.set(it, undefined); // booked with the step: a failure after it has nothing of this call to book
	}
}

/** The items that begin the writing, in the run's update: the outline, or on a block that has a document from an
 *  earlier run the sections that still only say what they are to say (their first revision). */
async function writing(d: AgentDeps, r: RunEntry): Promise<WorkItem[]> {
	const writer = r.info.writer!, head = await headOf(d.space, { session: r.session, blockId: r.params.blockId, table: TABLE });
	if (!head) { r.info.phase = "outline"; return [newItem(r, "outline", { onlyModel: writer, table: TABLE })]; }
	const open = head.sections.filter((x) => x.rev === 1);
	r.info.doc = { table: TABLE, version: head.version, sections: head.sections.length, written: head.sections.length - open.length };
	r.info.phase = open.length ? "draft" : "done";
	return open.map((x) => newItem(r, "draft", { onlyModel: writer, table: TABLE, sectionId: x.sectionId }));
}

/** The table has talked, in the run's update: the proposals with a majority become decisions, and the writing begins. */
async function afterTalk(d: AgentDeps, txn: string, r: RunEntry): Promise<WorkItem[]> {
	const doc = { session: r.session, blockId: r.params.blockId, table: TABLE }, messages = await messagesOf(d.space, doc, txn);
	const decisions = decide(messages, await decisionsOf(d.space, doc, txn), r.info.present ?? [], doc);
	for (const x of decisions) await d.space.write({ type: "PlanDecision", fields: x as never }, txn, d.ttl);
	r.info.talk = { messages: messages.filter((m) => m.runId === r.runId).length, decisions: decisions.length };
	return writing(d, r);
}

/** An item is done, in the run's update (`r`): it no longer counts as open, and when it was the last one its phase
 *  waited for, the next phase begins in this same transaction. `spawn`: items the item itself sets off. */
async function finish(d: AgentDeps, txn: string, r: RunEntry, it: WorkItem, spawn: WorkItem[] = []): Promise<void> {
	done(r);
	const items = [...spawn];
	if (--r.phaseLeft <= 0 && !r.info.ended) {
		if (it.kind === "rollcall") {
			// whoever answered is at the table; the first of them by its name writes the outline and the first draft
			const present = (await d.space.readAll({ type: "RollCall", fields: { session: r.session, runId: r.runId } }, { limit: 50, txn })).map((e) => e.fields as unknown as RollCall).sort((a, b) => a.alias.localeCompare(b.alias)).map((x) => x.model);
			if (present.length < MIN_MODELS) r.info.ended = "models";
			else {
				r.info.present = present; r.info.writer = present[0]!;
				// a block without a document begins with the kickoff: every model at the table says how it understands the
				// brief; a block that has one goes on writing it
				if (await headOf(d.space, { session: r.session, blockId: r.params.blockId, table: TABLE })) items.push(...(await writing(d, r)));
				else { r.info.phase = "kickoff"; items.push(...present.map((model) => newItem(r, "kickoff", { onlyModel: model, table: TABLE }))); }
			}
		} else if (it.kind === "kickoff") {
			// what the table owes itself now: answers to the questions, a vote of every other model on each proposal, and
			// the person's answers, each with its deadline
			const messages = (await messagesOf(d.space, { session: r.session, blockId: r.params.blockId, table: TABLE }, txn)).filter((m) => m.runId === r.runId);
			const o = owed(messages, r.info.present ?? [], r.params.aliases), now = Date.now();
			for (const [model, threads] of o.byModel) items.push(newItem(r, "reply", { onlyModel: model, table: TABLE, threads, deadline: now + replyWaitMs() }));
			if (o.person.length && personWaitMs() > 0) items.push(newItem(r, "person", { table: TABLE, deadline: now + personWaitMs() }));
			if (items.length) r.info.phase = "discuss"; else items.push(...(await afterTalk(d, txn, r)));
		} else if (it.kind === "reply" || it.kind === "person") items.push(...(await afterTalk(d, txn, r)));
		else if (it.kind === "draft") r.info.phase = "done";
		// an outline that failed leaves no document: the run has nothing more to do
	}
	if (items.length) {
		r.phaseLeft = items.length; r.pending += items.length;
		r.info.items = { ...r.info.items, open: r.pending };
		for (const x of items) await d.space.write(itemEntry(x), txn, d.ttl);
	}
}

/** Does an item in `txn`. A run that ended (budget, too few models) only drains its items. */
async function execute(d: AgentDeps, slot: Slot, it: WorkItem, txn: string): Promise<void> {
	const { space } = d;
	const run = await readRun(space, it.session, it.runId);
	if (!run) throw new RunGone();
	const who = { author: `agent-${slot.agent}`, model: slot.model }, doc = { session: it.session, blockId: run.params.blockId, table: it.table ?? TABLE };
	let usage: Usage | undefined, spawn: WorkItem[] = [], version: PlanDoc | undefined, note: string | undefined;
	/** A model's text that cannot be used was paid all the same: the failure carries the usage. */
	const usable = <T>(fn: () => T): T => { try { return fn(); } catch (e) { throw new ModelFailed((e as Error).message, usage); } };
	if (run.info.ended) { /* nothing more is asked of the models */ }
	else if (it.kind === "rollcall") {
		const v = await ask(d, txn, it, slot, run, 0, "rollcall") as { text: string; usage?: Usage };
		usage = v.usage;
		const answer: RollCall = { session: it.session, runId: it.runId, model: slot.model, alias: run.params.aliases[slot.model] ?? "?", agent: slot.agent, text: String(v.text).trim().slice(0, ROLLCALL_CHARS), ...(usage ? { usage } : {}), ts: Date.now() };
		await space.write({ type: "RollCall", fields: answer as never }, txn, d.ttl);
	} else if (it.kind === "kickoff") {
		const v = await work(d, txn, it, slot, run, "kickoff", { table: doc.table });
		usage = v.usage;
		const k = usable(() => parseKickoff(String(v.text)));
		await keep(space, txn, d.ttl, doc, { ...who, runId: it.runId, round: 0, aliases: run.params.aliases }, [{ kind: "understanding", text: k.understanding }, ...k.messages]);
	} else if (it.kind === "reply") {
		// past its deadline another model's agent closes it: the table does not wait for this reply any longer
		if (slot.model !== it.onlyModel) note = `${run.params.aliases[it.onlyModel ?? ""] ?? "a model"} did not reply to the table in time; the run goes on without its reply`;
		else {
			const v = await ask(d, txn, it, slot, run, 0, "reply", { table: doc.table, threads: it.threads ?? [] }, it.deadline) as { text: string; usage?: Usage };
			usage = v.usage;
			// only answers and votes, and only on what was asked of it
			await keep(space, txn, d.ttl, doc, { ...who, runId: it.runId, round: 0, aliases: run.params.aliases }, parseMessages(String(v.text)).filter((m) => (m.kind === "answer" || m.kind === "vote") && (it.threads ?? []).includes(m.thread ?? "")));
		}
	} else if (it.kind === "person") {
		// waits for the person's answers; what is not answered at the deadline becomes an assumption (talk.ts)
		const messages = (await messagesOf(space, doc)).filter((m) => m.runId === it.runId || m.model === "human");
		if (owed(messages, run.info.present ?? [], run.params.aliases).person.length && Date.now() < (it.deadline ?? 0)) throw new Wait();
	} else if (it.kind === "outline") {
		const task = (await readExisting(space, { type: "PlanTask", fields: { session: it.session, blockId: run.params.blockId } }))?.fields as unknown as PlanTask | undefined;
		if (!task) throw new ModelFailed("the task is gone");
		const v = await work(d, txn, it, slot, run, "outline", { table: doc.table });
		usage = v.usage;
		const sections = usable(() => parseOutline(String(v.text), task.outline));
		// the first version: every section with what it is to say, until its draft replaces that
		try { version = await writeVersion(space, txn, d.ttl, doc, who, { changes: sections.map((s) => ({ title: s.title, text: s.intent })) }); }
		catch (e) { if (e instanceof DocRefused) throw new ModelFailed(e.message, usage); throw e; }
		spawn = version.sections.map((s) => newItem(run, "draft", { onlyModel: slot.model, table: doc.table, sectionId: s.sectionId }));
	} else {
		const ref = (await headOf(space, doc))?.sections.find((s) => s.sectionId === it.sectionId);
		if (!ref) throw new ModelFailed("the section is gone");
		const v = await work(d, txn, it, slot, run, "draft", { table: doc.table, sectionId: ref.sectionId });
		usage = v.usage;
		const text = usable(() => parseSection(String(v.text), ref.title));
		// against the revision the model saw: a section revised meanwhile throws StaleSection, and the item is tried anew
		try { version = await writeVersion(space, txn, d.ttl, doc, who, { changes: [{ sectionId: ref.sectionId, base: ref.rev, text }] }); }
		catch (e) { if (e instanceof DocRefused) throw new ModelFailed(e.message, usage); throw e; }
	}
	// answers of tries that were cut off (they came back with their transactions) go with the item
	await takeAll(space, { type: "LlmResult", fields: { session: it.session, itemId: it.itemId } }, { txn });
	await updateRun(space, txn, d.ttl, it.session, it.runId, async (r) => {
		book(r, usage, it.itemId);
		if (note) r.info.note = note;
		if (version) r.info.doc = { table: doc.table, version: Math.max(version.version, r.info.doc?.version ?? 0), sections: version.sections.length, written: (r.info.doc?.written ?? 0) + (it.kind === "draft" ? 1 : 0) };
		if (it.kind === "outline" && version) r.info.phase = "draft";
		await finish(d, txn, r, it, spawn);
	});
}

/** No work left: the run is over, and this agent ends it (only one succeeds: the ForumRun is taken). Whether it is
 *  over is decided under its lock from what was committed: an item another agent holds right now is still counted.
 *  True when the run is gone. */
async function maybeEnd(d: AgentDeps, slot: Slot): Promise<boolean> {
	const { space } = d, k = { session: slot.session, runId: slot.runId };
	const r = await readRun(space, slot.session, slot.runId);
	if (!r) return true;
	const empty = async (txn: string | null) => (await space.count({ type: "WorkItem", fields: k }, txn)) === 0;
	if (r.pending > 0 || !(await empty(null))) return false;
	// still nothing to do under the lock: the counter as committed, and no item in sight
	await inTxn(space, d.open, (txn) => endRun(space, txn, d.ttl, slot.session, slot.runId, "finished", async (now) => now.pending <= 0 && (await empty(txn))))
		.catch((e) => { if (!(e instanceof RunGone || e instanceof NotOver || e instanceof StillHeld)) throw e; });
	try { return !(await readRun(space, slot.session, slot.runId)); }
	catch (e) { if (e instanceof StillHeld) return false; throw e; }
}

/** The names the models have at the table: M1, M2, … in an order drawn for this run, so no model is treated by its
 *  reputation. */
export function drawAliases(models: string[], random: () => number = Math.random): Record<string, string> {
	const order = models.map((m) => ({ m, r: random() })).sort((a, b) => a.r - b.r);
	return Object.fromEntries(order.map(({ m }, i) => [m, `M${i + 1}`]));
}

/** The work of starting a run in `txn`: the ForumRun (one per room), `perModel` slots per model, and the first items:
 *  the roll call, one per model. What follows it begins when its last item is done (finish). */
export async function startSpaceRun(space: SpaceLike, txn: string, ttl: number, run: { session: string; params: RunParams }): Promise<RunInfo> {
	const p = run.params, key = { session: run.session, runId: p.runId };
	const items = p.models.map((model) => newItem(key, "rollcall", { onlyModel: model }));
	const info: RunInfo = { active: true, runId: p.runId, blockId: p.blockId, models: p.models, perModel: p.perModel, aliases: p.aliases, phase: "rollcall", items: { open: items.length, done: 0 }, usage: { tokens: 0, costUsd: 0 }, budget: p.budget };
	await space.write({ type: "ForumRun", fields: { ...key, params: p, info, pending: items.length, phaseLeft: items.length, ts: Date.now() } as never }, txn, ttl, { unique: ["session"] });
	let agent = 0;
	for (const model of p.models) for (let i = 0; i < p.perModel; i++) await space.write({ type: "AgentSlot", fields: { ...key, agent: agent++, model } }, txn, ttl);
	for (const x of items) await space.write(itemEntry(x), txn, ttl);
	return info;
}
