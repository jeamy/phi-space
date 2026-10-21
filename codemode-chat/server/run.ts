// A run in the shared space, carried out by agent processes without any coordinator (docs/codemode-space-architektur.md).
//
//   CodeRun     the run: its parameters, what it shows (info), its progress per generation or the work board's state;
//               `unique` per room. It is also the run's lock: whoever changes it takes it under its own transaction and
//               writes it back.
//   AgentSlot   one per agent: an agent process takes it under a long transaction and works as that agent until the
//               run is over (a process that dies lets the transaction lapse, and another takes the slot).
//   WorkItem    work of the run. Generations: a `turn` (one contribution of one agent) and a `barrier` (the end of a
//               generation: it waits until every turn is done and every contribution judged, then opens the next).
//               Work board: research, propose, vote, implement, critique, revise, merge, judge, and a `followup` that
//               waits for a contribution's verdict and then sets the next work (a critique, a merge).
//   AgentBusy   an agent working on an item (written before it takes one, lease renewed while it works): the run is
//               over when no work item is left and no agent is busy.
//   CodeRunDone how a run ended (its info), for the page after the CodeRun is gone.
//
// An agent does an item inside one transaction: take the item, ask the model process (callModel), write the result,
// update the CodeRun, write the follow-ups, commit. A crash rolls all of it back and the item is there again: every
// item is done exactly once, and a model call that already ran is not paid twice (its answer waits for the retry).
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import { limitOf, maxTimeoutMs } from "./judge.ts";
import { criticModel, type Attempt, type Role, type Usage } from "./llm.ts";
import type { CallKind, LlmCall, LlmResultEntry } from "./context.ts";
import { crossWaitMs, FATAL_LLM, modelWaitMs } from "./limits.ts";
import { addNote, answersOf, attemptOf, blockTask, enqueueAnswer, enqueueCandidate, isSolved, rankedProposals, rid, scoresOf, systemLine, teamView, planTurn } from "./room.ts";
import { archive } from "./results.ts";
import { HELD_WAIT_MS, keepAlive } from "./space.ts";
import { isText, type Task } from "./tasks.ts";

export type RunMode = "scripted" | "llm";
/** What the board shows while it runs. */
export type BoardInfo = { open: number; done: number; critiques: number; proposals?: number; votes?: number; findings?: number; judgements?: number };
/** `gens` is the most generations a run may take; it ends earlier once the task is solved and `polish` more
 *  generations improved the solution (`solvedGen`: the generation that solved it, 0 = solved before the run). */
export type RunInfo = { active: boolean; blockId: string; mode: RunMode; contenders: string[]; gen: number; gens: number; agents: number; perAgent: number; polish: number; solvedGen: number | null; note?: string; usage: { tokens: number; costUsd: number }; research?: true;
	/** The work board (instead of generations): open and done items, critiques written. */
	board?: BoardInfo;
	/** Limits of the run's model calls; whichever is reached first ends it. */
	budget?: { tokens?: number; usd?: number };
	/** Why the run ended (when not solved or stopped): the budget, the item cap, or no work left. */
	ended?: "budget" | "items" | "idle" | "accepted" };
/** What a run was started with. */
export type RunParams = { runId: string; agents: number; gens: number; perAgent: number; polish: number; contenders: string[]; lang: "de" | "en"; board: boolean; plan: boolean; research: boolean; budget: { tokens?: number; usd?: number };
	/** Who started it: a visitor's usage counts against the day's allowance of their address; an admin's does not. */
	client?: { ip: string; admin: boolean }; engine?: "space" };
/** A generation's progress: turns in it, turns done, contributions handed in. */
export type GenProgress = { total: number; done: number; handedIn: number };
/** The work board's state: its phase and how many items of it are left, its counters, the improvement rounds left,
 *  the pairs already merged, and whether the item cap was reached. */
export type BoardState = { phase: "research" | "propose" | "vote" | "work"; phaseLeft: number; created: number; done: number; critiques: number; proposals: number; votes: number; judgements: number; findings: number; improveLeft: number; merged: string[]; capped?: boolean };
export type RunEntry = { session: string; runId: string; blockId: string; params: RunParams; info: RunInfo; progress: Record<string, GenProgress>; board?: BoardState; ts: number };
type BoardKind = "research" | "propose" | "vote" | "implement" | "critique" | "revise" | "merge" | "judge" | "followup";
/** A turn carries its role and the attempt it works on, chosen when its generation began: every agent of a generation
 *  builds on the same state, whoever of them gets to work first. Board items name what they work on (target, partner,
 *  critique, plan), who may not or must do them (notBy, notByAlso, onlyBy) and which model should judge first (crossOf). */
export type WorkItem = { session: string; runId: string; blockId: string; itemId: string; kind: "turn" | "barrier" | BoardKind; gen: number; ts: number;
	k?: number; onlyBy?: string; role?: Role; targetId?: string; notBefore?: number; waits?: number; tries?: number;
	depth?: number; partner?: string; critiqueId?: string; proposalId?: string; notBy?: string; notByAlso?: string; crossOf?: string; improve?: boolean; deadline?: number };
export type Slot = { session: string; runId: string; agent: number; model: string };

/** An item's and a slot's transaction lease (renewed while they are worked on), and an AgentBusy marker's: a dead
 *  agent's work is back within it (CODEMODE_AGENT_LEASE_MS, default 60 s). */
export const ITEM_LEASE_MS = Math.max(1000, Number(process.env.CODEMODE_AGENT_LEASE_MS || 60_000));
const BUSY_LEASE_MS = ITEM_LEASE_MS;
/** Failed tries of an item before it is given up (it then counts as done, with nothing handed in). */
const MAX_TRIES = 3;
/** A failure that trying again will not mend (a model no longer allowed, the day's web searches used up, no results). */
const FINAL = /is not allowed|searches of the day|No search results|Web search refused|has no /i;
/** How long a critique waits for the critic model before others may take it. */
const CRITIC_WAIT_MS = 20_000;
/** The work board's limits: the item cap is max(12, agents × gens × 4), the depth of follow-ups at most 12. */
const MAX_DEPTH = 12;
/** A waiting item (a barrier, a follow-up) looks again after 1, 2, 4, 8, then every 10 s: each look is a commit. */
const backoff = (waits: number) => Math.min(10_000, 1000 * 2 ** waits);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run is gone (stopped, or ended by another agent): the work in progress is dropped. */
class RunGone extends Error {}
/** A model call that failed: the item is tried again (a new call), given up, or the run ends as over budget. */
class ModelFailed extends Error {}

const itemEntry = (it: WorkItem) => ({ type: "WorkItem", fields: it as never });
const newItem = (run: { session: string; runId: string; blockId: string }, kind: WorkItem["kind"], gen: number, more: Partial<WorkItem> = {}): WorkItem =>
	({ session: run.session, runId: run.runId, blockId: run.blockId, itemId: `${run.runId}-${Date.now().toString(36)}${rid()}`, kind, gen, ts: Date.now(), ...more });

/** The items of a generation: a turn per agent and contribution (its role and target from the team's attempts as they
 *  are now), and the barrier that closes it. */
export function generationItems(run: { session: string; runId: string; blockId: string }, params: RunParams, gen: number, attempts: Attempt[]): { items: WorkItem[]; progress: GenProgress } {
	const items: WorkItem[] = [];
	for (let a = 0; a < params.agents; a++) for (let j = 0; j < params.perAgent; j++) {
		const k = a * params.perAgent + j, plan = planTurn(attempts, k);
		items.push(newItem(run, "turn", gen, { k, onlyBy: `agent-${a}`, role: plan.role, ...(plan.target ? { targetId: plan.target.candidateId } : {}) }));
	}
	items.push(newItem(run, "barrier", gen));
	return { items, progress: { total: items.length - 1, done: 0, handedIn: 0 } };
}

/** The run's CodeRun as it is now (null: gone). A CodeRun another agent holds for a moment is waited for. */
export async function readRun(space: SpaceLike, session: string, runId: string): Promise<RunEntry | null> {
	return ((await space.readIfExists({ type: "CodeRun", fields: { session, runId } }, HELD_WAIT_MS))?.fields as unknown as RunEntry | undefined) ?? null;
}

/** Changes the CodeRun in `txn` (taken and written back: the lock of the run). RunGone when it is not there. */
async function updateRun(space: SpaceLike, txn: string, ttl: number, session: string, runId: string, fn: (r: RunEntry) => void | Promise<void>): Promise<RunEntry> {
	const e = await space.takeIfExists({ type: "CodeRun", fields: { session, runId } }, HELD_WAIT_MS, { txn });
	if (!e) throw new RunGone();
	const r = structuredClone(e.fields as unknown as RunEntry);
	await fn(r);
	await space.write({ type: "CodeRun", fields: { ...r, ts: Date.now() } as never }, txn, ttl);
	return r;
}

/** Whether a run's model calls have used up its budget (tokens or dollars, whichever comes first). */
const overBudget = (r: RunEntry) => { const b = r.info.budget, u = r.info.usage; return !!b && ((b.tokens !== undefined && u.tokens >= b.tokens) || (b.usd !== undefined && u.costUsd >= b.usd)); };
/** Books a call's usage on the run; over the budget the run ends once its open items are done. */
const book = (r: RunEntry, usage?: Usage) => {
	if (usage) r.info.usage = { tokens: r.info.usage.tokens + usage.total, costUsd: r.info.usage.costUsd + usage.costUsd };
	if (overBudget(r)) r.info.ended ??= "budget";
};

/** The closing line of a run (how it ended, how far it got). */
export async function closingLine(space: SpaceLike, r: RunEntry, how: "finished" | "stopped" | "accepted"): Promise<string> {
	const task = await blockTask(space, r.session, r.blockId);
	const info = r.info, board = r.params.board;
	const why = info.ended === "budget" ? " (budget used up)" : info.ended === "items" ? " (item limit reached)" : "";
	const span = board ? `${info.board?.done ?? 0} work items, ${info.board?.critiques ?? 0} critiques` : `${info.gen} generation${info.gen === 1 ? "" : "s"}`;
	let result: string;
	if (task && isText(task)) {
		const answers = await answersOf(space, r.session, r.blockId), accepted = answers.find((a) => a.ok);
		const closest = accepted ? null : (await teamView(space, r.session, r.blockId, true).catch(() => null))?.attempts[0];
		result = accepted ? `answered, ${accepted.author}'s answer accepted ${accepted.acceptedBy === "human" ? "by a person" : "by the judges"}` : `no accepted answer yet${closest ? ` (closest: ${closest.author}, ${closest.passed ?? 0}/${closest.total ?? "?"} criteria)` : ""}`;
	} else {
		const best = (await space.readIfExists({ type: "CodeBest", fields: { session: r.session, blockId: r.blockId } }, HELD_WAIT_MS))?.fields as { ms?: number } | undefined;
		const closest = best || !task ? null : (await teamView(space, r.session, r.blockId, false).catch(() => null))?.attempts[0];
		result = best ? `solved${info.solvedGen && !board ? ` in generation ${info.solvedGen}` : info.solvedGen === 0 ? " before the run" : ""}, best ${best.ms} ms` : `not solved yet${closest ? ` (closest: ${closest.author}, ${closest.passed ?? 0}/${closest.total ?? "?"} cases)` : ""}`;
	}
	return `Run ${how === "accepted" ? "ended (an answer was accepted)" : how} after ${span}${why}: ${result}`;
}

/** Ends a run in `txn`: its CodeRun goes (taken: only one ender succeeds), its left-over items go, a CodeRunDone keeps
 *  how it ended, and the closing line is written. False when the run was already gone. */
export async function endRun(space: SpaceLike, txn: string, ttl: number, session: string, runId: string, how: "finished" | "stopped" | "accepted", extra: Partial<RunInfo> = {}): Promise<boolean> {
	const e = await space.takeIfExists({ type: "CodeRun", fields: { session, runId } }, HELD_WAIT_MS, { txn });
	if (!e) return false;
	const r = e.fields as unknown as RunEntry;
	Object.assign(r.info, extra);
	if (r.board) r.info.board = { ...(r.info.board ?? { open: 0, done: 0, critiques: 0 }), open: 0 };
	for (let n = 0; n < 2000 && (await space.take({ type: "WorkItem", fields: { session, runId } }, NO_WAIT, { txn })); n++);
	for (let n = 0; n < 200 && (await space.take({ type: "AgentSlot", fields: { session, runId } }, NO_WAIT, { txn })); n++);
	while (await space.take({ type: "CodeRunDone", fields: { session } }, NO_WAIT, { txn }));
	await space.write({ type: "CodeRunDone", fields: { session, runId, blockId: r.blockId, info: { ...r.info, active: false }, ts: Date.now() } as never }, txn, ttl);
	await systemLine(space, txn, ttl, session, await closingLine(space, r, how), r.blockId);
	return true;
}

/** Runs `fn` in a fresh transaction (renewed while it runs, aborted on any failure, listed in `open` so a shutdown can
 *  abort it). */
async function inTxn<T>(space: SpaceLike, open: Set<string>, fn: (txn: string) => Promise<T>): Promise<T> {
	const t = await space.createTransaction(ITEM_LEASE_MS);
	open.add(t.id);
	const stop = keepAlive(space, t.id, ITEM_LEASE_MS);
	try { const v = await fn(t.id); await space.commit(t.id); return v; }
	catch (e) { await space.abort(t.id).catch(() => {}); throw e; }
	finally { stop(); open.delete(t.id); }
}

/** Asks the model process for a call and waits for its answer, in `txn`: the answer is taken in the item's
 *  transaction, so if the item is cut off it stays for the next try. The call's id belongs to the item (and its try),
 *  so a repeated item finds the answer from before (or the call still waiting: written `unique`) instead of paying for
 *  a second call. */
export async function callModel(space: SpaceLike, txn: string, call: LlmCall): Promise<LlmResultEntry> {
	const tmpl = { type: "LlmResult", fields: { callId: call.callId } };
	let r = await space.take(tmpl, NO_WAIT, { txn });
	if (!r) {
		try { await space.write({ type: "LlmCall", fields: call as never }, null, modelWaitMs() + 60_000, { unique: ["callId"] }); }
		catch (e) { if (!/unique/i.test((e as Error).message)) throw e; } // asked before, the answer is still coming
		const end = Date.now() + modelWaitMs();
		while (!r && Date.now() < end) r = await space.take(tmpl, Math.min(20_000, Math.max(1, end - Date.now())), { txn });
	}
	return (r?.fields as unknown as LlmResultEntry | undefined) ?? { callId: call.callId, session: call.session, ok: false, error: "the model process did not answer in time", ts: Date.now() };
}

export type AgentDeps = { space: SpaceLike; ttl: number; open: Set<string>; stopping: () => boolean };

/** One agent of a run: takes the items it may do, one after the other, until the run is over (or the process stops). */
export async function agentLoop(d: AgentDeps, slot: Slot): Promise<void> {
	const { space } = d, me = `agent-${slot.agent}`;
	while (!d.stopping()) {
		const run = await readRun(space, slot.session, slot.runId);
		if (!run) return;
		// busy before taking anything: whoever looks for the end of the run meanwhile sees this agent still at work
		const busy = await space.write({ type: "AgentBusy", fields: { session: slot.session, runId: slot.runId, agent: slot.agent } }, null, BUSY_LEASE_MS);
		const stopBusy = keepAlive(space, busy.id, BUSY_LEASE_MS);
		let did: boolean;
		try { did = await workOnce(d, slot, me, run); }
		finally { stopBusy(); await space.cancel(busy.id).catch(() => {}); }
		if (did) continue;
		if (await maybeEnd(d, slot)) return;
		await pause(300);
	}
}

/** May this agent take this item now? Never its own attempt's critique, never a revision of its own critique; a judge
 *  of an answer waits a while for an agent of another model than the author's; a young critique waits for the critic
 *  model; an item for one agent waits for that agent. */
function eligible(it: WorkItem, me: string, model: string, run: RunEntry, now: number): boolean {
	if ((it.notBefore ?? 0) > now) return false;
	if (it.notBy === me || it.notByAlso === me || (it.onlyBy && it.onlyBy !== me)) return false;
	const contenders = run.params.contenders;
	if (it.kind === "judge" && it.crossOf === model && contenders.some((m) => m !== model) && now - it.ts < crossWaitMs()) return false;
	const critic = criticModel(contenders);
	if (it.kind === "critique" && critic && model !== critic && now - it.ts < CRITIC_WAIT_MS) return false;
	return true;
}

/** Takes and does one item this agent may do; false when there was none (or the only ones are not due yet). */
async function workOnce(d: AgentDeps, slot: Slot, me: string, run: RunEntry): Promise<boolean> {
	const { space } = d, now = Date.now();
	const rows = (await space.readAll({ type: "WorkItem", fields: { session: slot.session, runId: slot.runId } }, { limit: 500 }))
		.map((e) => ({ id: e.id, it: e.fields as unknown as WorkItem }))
		.filter(({ it }) => eligible(it, me, slot.model, run, now))
		.sort((a, b) => a.it.ts - b.it.ts);
	for (const { id, it } of rows) {
		try {
			const done = await inTxn(space, d.open, async (txn) => {
				if (!(await space.take({ id }, NO_WAIT, { txn }))) return null; // another agent took it first
				try { return await execute(d, slot, me, it, txn); }
				catch (e) {
					if (!(e instanceof ModelFailed)) throw e;
					// handled in this transaction: the failed answer is used up, the item goes back or counts as done
					await failed(d, it, txn, e.message);
					return "done" as const;
				}
			});
			if (done === null) continue;
			return done !== "waiting";
		} catch (e) {
			if (e instanceof RunGone || d.stopping()) return false;
			console.error("[agents] item failed", it.kind, (e as Error).message);
			await inTxn(space, d.open, async (txn) => { if (await space.take({ id }, NO_WAIT, { txn })) await failed(d, it, txn, (e as Error).message); }).catch(() => {});
			return true;
		}
	}
	return false;
}

/** A failed item, in `txn` (the item is already taken): after a fatal failure (the day's model calls used up) the run
 *  ends as over budget; a passing one is tried again later with a new call, at most MAX_TRIES times; otherwise the
 *  item counts as done with nothing handed in (its generation or phase must not wait for it forever). */
async function failed(d: AgentDeps, it: WorkItem, txn: string, why: string): Promise<void> {
	const { space } = d, tries = (it.tries ?? 0) + 1;
	if (!FATAL_LLM.test(why) && !FINAL.test(why) && tries < MAX_TRIES) { await space.write(itemEntry({ ...it, tries, notBefore: Date.now() + 2000 * tries }), txn, d.ttl); return; }
	await updateRun(space, txn, d.ttl, it.session, it.runId, async (r) => {
		if (FATAL_LLM.test(why)) r.info.ended ??= "budget";
		if (it.kind === "turn") { const p = r.progress[it.gen]; if (p) p.done++; }
		else if (r.board) await boardDone(d, txn, r, it, []);
	});
}

/** Does an item in `txn`. "waiting": an item that is not ready went back with a later time. */
async function execute(d: AgentDeps, slot: Slot, me: string, it: WorkItem, txn: string): Promise<"done" | "waiting"> {
	if (it.kind === "turn") { await turn(d, slot, me, it, txn); return "done"; }
	if (it.kind === "barrier") return barrier(d, it, txn);
	return boardItem(d, slot, me, it, txn);
}

/** A model call of an item; ModelFailed when it does not answer. The call id carries the item's try. */
async function ask(d: AgentDeps, txn: string, it: WorkItem, slot: Slot, run: RunEntry, n: number, kind: CallKind, more: Partial<LlmCall>): Promise<Record<string, unknown>> {
	const res = await callModel(d.space, txn, { callId: `${it.itemId}-t${it.tries ?? 0}-c${n}`, session: it.session, blockId: it.blockId, runId: it.runId, kind, agent: slot.agent, gen: it.depth ?? it.gen, model: slot.model, lang: run.params.lang, ...(run.params.client ? { client: run.params.client } : {}), ts: Date.now(), ...more });
	if (!res.ok || !res.value) throw new ModelFailed(res.error ?? "the model call failed");
	return res.value;
}

// ---- generations ----

/** A turn: one contribution of this agent, built on what the team has (repair, explore, improve). A model agent asks
 *  the model process; when that fails (or the budget is used up) a scripted variant stands in where the task has one. */
async function turn(d: AgentDeps, slot: Slot, me: string, it: WorkItem, txn: string): Promise<void> {
	const { space } = d;
	const run = await readRun(space, it.session, it.runId);
	if (!run) throw new RunGone();
	const task = await blockTask(space, it.session, it.blockId);
	let handedIn = 0, usage: Usage | undefined, note: string | undefined, runNote: string | undefined, fatal = false;
	if (task && !run.info.ended) {
		let source: string | undefined, via = "scripted", lineage: { role?: Role; basedOn?: string; usage?: Usage } = {};
		if (slot.model !== "scripted" && !overBudget(run)) {
			const plan = it.role ? { role: it.role, target: it.targetId ? { candidateId: it.targetId } : null } : planTurn((await teamView(space, it.session, it.blockId, false)).attempts, it.k ?? 0);
			try {
				const v = await ask(d, txn, it, slot, run, 0, "contribute", { role: plan.role, ...(plan.target ? { targetId: plan.target.candidateId } : {}) }) as { source: string; model: string; note?: string; usage?: Usage };
				source = v.source; via = v.model; usage = v.usage; note = v.note;
				lineage = { role: plan.role, ...(plan.target ? { basedOn: plan.target.candidateId } : {}), ...(v.usage ? { usage: v.usage } : {}) };
			} catch (e) {
				if (!(e instanceof ModelFailed)) throw e;
				runNote = `${slot.model}: ${e.message}${task.variants.length ? "; scripted agent used" : ""}`;
				fatal = FATAL_LLM.test(e.message);
			}
		}
		if (source === undefined) source = scriptedSource(task);
		if (source !== undefined) {
			const candidateId = await enqueueCandidate(space, txn, d.ttl, { session: it.session, blockId: it.blockId, taskId: task.id, author: me, via, gen: it.gen + 1, source, runId: it.runId, lineage });
			handedIn = 1;
			// the note belongs to this contribution: if it gets rejected, its advice is dropped too
			if (note) await addNote(space, txn, d.ttl, { session: it.session, blockId: it.blockId, author: me, via, gen: it.gen + 1, text: note, candidateId });
		}
	}
	await updateRun(space, txn, d.ttl, it.session, it.runId, (r) => {
		const p = r.progress[it.gen];
		if (p) { p.done++; p.handedIn += handedIn; }
		book(r, usage);
		if (runNote) r.info.note = runNote;
		if (fatal) r.info.ended ??= "budget"; // no next generation; the run ends once its items are done
	});
}

/** A scripted agent's contribution: one of the task's hand-written variants (a custom task has none). */
function scriptedSource(task: Task): string | undefined {
	return task.variants.length ? task.variants[Math.floor(Math.random() * task.variants.length)] : undefined;
}

/** The end of a generation: once every turn is done and every contribution judged, the next generation begins, unless
 *  the task is solved and improved enough, the generations are used up, or the run ended otherwise. */
async function barrier(d: AgentDeps, it: WorkItem, txn: string): Promise<"done" | "waiting"> {
	const { space } = d;
	const r = await readRun(space, it.session, it.runId);
	if (!r) throw new RunGone();
	const p = r.progress[it.gen] ?? { total: 0, done: 0, handedIn: 0 };
	const alive = !!(await blockTask(space, it.session, it.blockId));
	const judged = await space.count({ type: "CodeScore", fields: { session: it.session, runId: it.runId, gen: it.gen + 1 } });
	if (alive && (p.done < p.total || judged < p.handedIn)) {
		const waits = (it.waits ?? 0) + 1;
		await space.write(itemEntry({ ...it, waits, notBefore: Date.now() + backoff(waits) }), txn, d.ttl);
		return "waiting";
	}
	const solved = !!(await space.readIfExists({ type: "CodeBest", fields: { session: it.session, blockId: it.blockId } }, HELD_WAIT_MS));
	const attempts = (await teamView(space, it.session, it.blockId, false)).attempts;
	await updateRun(space, txn, d.ttl, it.session, it.runId, async (run) => {
		const info = run.info, next = it.gen + 1;
		if (info.solvedGen !== null && !solved) info.solvedGen = null; // the solution was rejected by a person: not solved
		if (info.solvedGen === null && solved) info.solvedGen = next;
		const enough = info.solvedGen !== null && next >= info.solvedGen + info.polish;
		if (!alive || info.ended || next >= info.gens || enough) return; // no next generation: the run ends when its agents find nothing left
		const g = generationItems(run, run.params, next, attempts);
		run.progress[next] = g.progress;
		info.gen = next + 1;
		for (const x of g.items) await space.write(itemEntry(x), txn, d.ttl);
	});
	return "done";
}

// ---- the work board ----

/** The case calls an attempt passes. */
const passing = (a: Attempt) => new Set((a.cases ?? []).filter((c) => c.ok).map((c) => c.call));
type Spawn = { kind: BoardKind; depth: number; more?: Partial<WorkItem> };
const isOpening = (k: WorkItem["kind"]) => k === "research" || k === "propose" || k === "vote";
const maxItems = (p: RunParams) => Math.max(12, p.agents * p.gens * 4);
/** How long a follow-up waits for its contribution's verdict: a judge may hold a candidate up to its time limit, and
 *  after a crash its transaction keeps it that long; text answers wait for their two judges. */
const verdictWaitMs = (task: Task) => (isText(task) ? 10 * 60_000 : maxTimeoutMs() + limitOf(task) + 150_000);

/** A board item. Work towards a solution lapses once there is one (an answer in judging still gets its verdict, a
 *  contribution its follow-ups); a run that ended (budget) only drains its items. */
async function boardItem(d: AgentDeps, slot: Slot, me: string, it: WorkItem, txn: string): Promise<"done" | "waiting"> {
	const { space } = d;
	const run = await readRun(space, it.session, it.runId);
	if (!run) throw new RunGone();
	const task = await blockTask(space, it.session, it.blockId);
	const text = !!task && isText(task);
	const solved = !!task && (await isSolved(space, it.session, it.blockId, text));
	const spawns: Spawn[] = [];
	let usage: Usage | undefined, counted: Partial<Record<"critiques" | "proposals" | "votes" | "judgements" | "findings", number>> = {};
	const depth = it.depth ?? 0;
	if (!task || run.info.ended || (solved && !it.improve && it.kind !== "judge" && it.kind !== "followup")) {
		// nothing to do any more: the item counts as done
	} else if (it.kind === "followup") {
		const v = await verdictOf(space, it, text);
		if (!v && Date.now() < (it.deadline ?? 0)) {
			const waits = (it.waits ?? 0) + 1;
			await space.write(itemEntry({ ...it, waits, notBefore: Date.now() + backoff(waits) }), txn, d.ttl);
			return "waiting";
		}
		if (v) {
			// an answer the judges accepted is kept as material for later, similar questions (a person's 👍 is archived by the web process)
			if (text && v.ok) await archive(space, txn, it.session, it.blockId, task, { result: v.source, by: "accepted by the judges" });
			await followUp(space, it, v, solved, text, spawns);
		}
	} else if (it.kind === "research") {
		const v = await ask(d, txn, it, slot, run, 0, "research", { withFindings: true }) as { queries: string[]; sources: Array<{ title: string; url: string }>; text: string; model: string; usage?: Usage };
		await space.write({ type: "CodeFinding", fields: { session: it.session, blockId: it.blockId, runId: it.runId, findingId: `${it.itemId}-f`, author: me, via: v.model, queries: v.queries, sources: v.sources, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, txn, d.ttl);
		usage = v.usage; counted = { findings: 1 };
	} else if (it.kind === "propose") {
		const v = await ask(d, txn, it, slot, run, 0, "propose", { withEarlier: true, withFindings: run.params.research }) as { text: string; model: string; usage?: Usage };
		await space.write({ type: "CodeProposal", fields: { session: it.session, blockId: it.blockId, runId: it.runId, proposalId: `${it.itemId}-p`, author: me, via: v.model, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, txn, d.ttl);
		usage = v.usage; counted = { proposals: 1 };
	} else if (it.kind === "vote") {
		const others = (await rankedProposals(space, it.session, it.runId, txn)).filter((p) => p.author !== me).map((p) => p.proposalId);
		if (others.length) {
			const v = await ask(d, txn, it, slot, run, 0, "vote", { proposalIds: others }) as { scores: Record<string, number>; text: string; model: string; usage?: Usage };
			await space.write({ type: "CodeVote", fields: { session: it.session, blockId: it.blockId, runId: it.runId, voteId: `${it.itemId}-v`, voter: me, via: v.model, scores: v.scores, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, txn, d.ttl);
			usage = v.usage; counted = { votes: 1 };
		}
	} else if (it.kind === "judge") {
		const answer = (await answersOf(space, it.session, it.blockId)).find((a) => a.candidateId === it.targetId);
		if (answer) {
			const v = await ask(d, txn, it, slot, run, 0, "judge", { answerId: answer.candidateId }) as { results: Array<{ criterion: string; pass: boolean; reason: string }>; model: string; usage?: Usage };
			const passed = v.results.filter((x) => x.pass).length;
			await space.write({ type: "TextJudgement", fields: { session: it.session, blockId: it.blockId, runId: it.runId, answerId: answer.candidateId, judge: me, via: v.model, results: v.results, passed, total: v.results.length, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, txn, d.ttl);
			usage = v.usage; counted = { judgements: 1 };
			// the second judgement comes from yet another agent (never the author, never this judge); when this judge ran the
			// author's model (none of another model came in time), the second one waits for another model too
			if (!it.notByAlso) spawns.push({ kind: "judge", depth, more: { targetId: answer.candidateId, notBy: answer.author, notByAlso: me, ...(v.model === answer.via ? { crossOf: answer.via } : {}), ...(it.improve ? { improve: true } : {}) } });
		}
	} else if (it.kind === "critique") {
		const view = await teamView(space, it.session, it.blockId, text);
		const target = view.attempts.find((a) => a.candidateId === it.targetId);
		if (target) {
			const v = await ask(d, txn, it, slot, run, 0, "critique", { targetId: target.candidateId, withFindings: run.params.research }) as { text: string; model: string; usage?: Usage };
			const critiqueId = `${it.itemId}-c`;
			await space.write({ type: "CodeCritique", fields: { session: it.session, blockId: it.blockId, runId: it.runId, critiqueId, target: target.candidateId, addressedTo: target.author, author: me, via: v.model, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, txn, d.ttl);
			usage = v.usage; counted = { critiques: 1 };
			spawns.push({ kind: "revise", depth: depth + 1, more: { targetId: target.candidateId, critiqueId, notBy: me, ...(it.improve ? { improve: true } : {}) } });
		}
	} else {
		// implement, revise, merge: a contribution (code, or a text answer)
		const view = await teamView(space, it.session, it.blockId, text);
		const usable = view.attempts.filter((a) => !a.rejected);
		let role: Role = "explore", target: Attempt | undefined, partner: Attempt | undefined, ok = true;
		if (it.kind === "revise") {
			target = view.attempts.find((a) => a.candidateId === it.targetId);
			ok = !!target && !!(await space.readAll({ type: "CodeCritique", fields: { session: it.session, critiqueId: it.critiqueId ?? "" } }, { limit: 1 }))[0];
			role = "revise";
		} else if (it.kind === "merge") {
			target = view.attempts.find((a) => a.candidateId === it.targetId); partner = view.attempts.find((a) => a.candidateId === it.partner);
			ok = !!target && !!partner; role = "merge";
		} else if (solved) { role = "improve"; target = usable.find((a) => a.ok); }
		if (ok) {
			const v = await ask(d, txn, it, slot, run, 0, "contribute", { role, ...(target ? { targetId: target.candidateId } : {}), ...(partner ? { partnerId: partner.candidateId } : {}), ...(it.critiqueId ? { critiqueId: it.critiqueId } : {}), ...(it.proposalId ? { proposalId: it.proposalId } : {}), withEarlier: role === "explore", withFindings: run.params.research }) as { source: string; model: string; note?: string; usage?: Usage };
			usage = v.usage;
			const lineage = { role, ...(target ? { basedOn: target.candidateId } : {}), ...(partner ? { partner: partner.candidateId } : {}), ...(it.critiqueId ? { critiqueId: it.critiqueId } : {}), ...(it.proposalId ? { proposalId: it.proposalId } : {}), ...(v.usage ? { usage: v.usage } : {}) };
			const gen = depth + 1;
			const id = text
				? await enqueueAnswer(space, txn, d.ttl, { session: it.session, blockId: it.blockId, author: me, via: v.model, gen, text: v.source, runId: it.runId, crossNeeded: run.params.contenders.some((c) => c !== "scripted" && c !== v.model), lineage })
				: await enqueueCandidate(space, txn, d.ttl, { session: it.session, blockId: it.blockId, taskId: task.id, author: me, via: v.model, gen, source: v.source, runId: it.runId, lineage });
			if (v.note) await addNote(space, txn, d.ttl, { session: it.session, blockId: it.blockId, author: me, via: v.model, gen, text: v.note, candidateId: id });
			// a text answer is judged on the board: the first judge from another model than the author where possible
			if (text) spawns.push({ kind: "judge", depth, more: { targetId: id, notBy: me, crossOf: v.model, ...(it.improve ? { improve: true } : {}) } });
			// the follow-ups come with the verdict: an item waits for it, this agent goes on meanwhile
			spawns.push({ kind: "followup", depth, more: { targetId: id, deadline: Date.now() + verdictWaitMs(task), ...(it.improve ? { improve: true } : {}) } });
		}
	}
	await updateRun(space, txn, d.ttl, it.session, it.runId, async (r) => {
		book(r, usage);
		const b = r.board!;
		for (const [k, n] of Object.entries(counted)) (b as unknown as Record<string, number>)[k] += n!;
		// a correct verdict (or one on a solved task) starts an improvement critique while improvement rounds are left
		const improve = spawns.find((s) => s.more?.improve && s.kind === "critique" && (s.more as { roundsLeft?: true }).roundsLeft);
		if (improve) { if (b.improveLeft > 0) b.improveLeft--; else spawns.splice(spawns.indexOf(improve), 1); }
		// a merge of a pair that was merged before is not done again
		for (const s of [...spawns]) if (s.kind === "merge") { const key = [s.more!.targetId, s.more!.partner].sort().join("+"); if (b.merged.includes(key)) spawns.splice(spawns.indexOf(s), 1); else b.merged = [...b.merged, key].slice(-200); }
		await boardDone(d, txn, r, it, spawns);
	});
	return "done";
}

/** A contribution's verdict as the team sees it (null while there is none: a code verdict, or a text answer's two
 *  judgements). */
async function verdictOf(space: SpaceLike, it: WorkItem, text: boolean): Promise<Attempt | null> {
	if (text) {
		const a = (await answersOf(space, it.session, it.blockId)).find((x) => x.candidateId === it.targetId);
		return a && (a.judges ?? 0) >= 2 ? attemptOf(a) : null;
	}
	const c = (await scoresOf(space, it.session)).find((x) => x.candidateId === it.targetId);
	return c ? attemptOf(c) : null;
}

/** What follows a verdict: a critique of the attempt (by someone else), and a merge when another failing attempt passes
 *  other cases; once the task is solved, only as many improvement critiques as the rounds allow. */
async function followUp(space: SpaceLike, it: WorkItem, a: Attempt, solved: boolean, text: boolean, spawns: Spawn[]): Promise<void> {
	const depth = it.depth ?? 0;
	if (a.ok || solved) {
		if (a.ok) spawns.push({ kind: "critique", depth: depth + 1, more: { targetId: a.candidateId, notBy: a.author, improve: true, roundsLeft: true } as Partial<WorkItem> });
		return;
	}
	spawns.push({ kind: "critique", depth: depth + 1, more: { targetId: a.candidateId, notBy: a.author } });
	const mine = passing(a);
	const { attempts } = await teamView(space, it.session, it.blockId, text);
	const partner = attempts.find((b) => !b.ok && !b.rejected && b.candidateId !== a.candidateId && [...passing(b)].some((call) => !mine.has(call)) && [...mine].some((call) => !passing(b).has(call)));
	if (partner) spawns.push({ kind: "merge", depth: depth + 1, more: { targetId: a.candidateId, partner: partner.candidateId } });
}

/** An item of the board is done (in the run's update): it counts, its spawns are written (within the item cap and the
 *  depth limit), and when it was the last item of its phase, the next phase begins in this same transaction. */
async function boardDone(d: AgentDeps, txn: string, r: RunEntry, it: WorkItem, spawns: Spawn[]): Promise<void> {
	const b = r.board!;
	b.done++;
	for (const s of spawns) {
		if (s.depth > MAX_DEPTH) continue;
		if (b.created >= maxItems(r.params)) { b.capped = true; continue; } // no new work; what is open still gets done
		b.created++;
		const { roundsLeft: _r, ...more } = (s.more ?? {}) as Partial<WorkItem> & { roundsLeft?: true };
		await d.space.write(itemEntry(newItem(r, s.kind, 0, { depth: s.depth, ...more })), txn, d.ttl);
	}
	if (isOpening(it.kind) && it.kind === b.phase && --b.phaseLeft <= 0) await advance(d, txn, r);
	r.info.board = { open: await d.space.count({ type: "WorkItem", fields: { session: r.session, runId: r.runId } }, txn), done: b.done, critiques: b.critiques, ...(r.params.plan ? { proposals: b.proposals, votes: b.votes } : {}), ...(b.judgements ? { judgements: b.judgements } : {}), ...(r.params.research ? { findings: b.findings } : {}) };
}

/** The next phase of the board: research → planning (or work), proposals → votes (with two proposals or more) → work. */
async function advance(d: AgentDeps, txn: string, r: RunEntry): Promise<void> {
	const b = r.board!, p = r.params;
	const ranked = await rankedProposals(d.space, r.session, r.runId, txn);
	b.phase = b.phase === "research" ? (p.plan ? "propose" : "work") : b.phase === "propose" ? (ranked.length >= 2 ? "vote" : "work") : "work";
	const items = boardOpening(r, b.phase, ranked.slice(0, 2).map((x) => x.proposalId));
	b.created += items.length; b.phaseLeft = b.phase === "work" ? 0 : items.length;
	for (const x of items) await d.space.write(itemEntry(x), txn, d.ttl);
}

/** The items that open a phase: a proposal and a vote per agent, or the implementations (of the best plans). */
function boardOpening(r: { session: string; runId: string; blockId: string; params: RunParams }, phase: BoardState["phase"], top: string[]): WorkItem[] {
	const n = r.params.agents;
	if (phase === "research") return Array.from({ length: Math.max(1, Math.floor(n / 2)) }, (_, a) => newItem(r, "research", 0, { depth: 0, onlyBy: `agent-${a}` }));
	if (phase === "propose" || phase === "vote") return Array.from({ length: n }, (_, a) => newItem(r, phase, 0, { depth: 0, onlyBy: `agent-${a}` }));
	// every agent starts with an approach of its own (one agent must not take all of them)
	return Array.from({ length: n }, (_, a) => newItem(r, "implement", 0, { depth: 0, onlyBy: `agent-${a}`, ...(top.length ? { proposalId: top[a % top.length] } : {}) }));
}

/** No item left and no agent busy: the run is over, and this agent ends it (only one succeeds: the CodeRun is taken). */
async function maybeEnd(d: AgentDeps, slot: Slot): Promise<boolean> {
	const { space } = d, k = { session: slot.session, runId: slot.runId };
	if ((await space.count({ type: "WorkItem", fields: k })) > 0 || (await space.count({ type: "AgentBusy", fields: k })) > 0) return false;
	await inTxn(space, d.open, async (txn) => {
		// still empty now that this transaction looks: a busy agent writes its marker before it takes anything
		if ((await space.count({ type: "WorkItem", fields: k }, txn)) > 0 || (await space.count({ type: "AgentBusy", fields: k }, txn)) > 0) return;
		const r = await readRun(space, slot.session, slot.runId);
		if (!r) return;
		// a board that ran out of work without a solution: the item cap, or simply no work left
		const extra: Partial<RunInfo> = {};
		if (r.board && !r.info.ended) {
			const task = await blockTask(space, r.session, r.blockId);
			if (!task || !(await isSolved(space, r.session, r.blockId, isText(task)))) extra.ended = r.board.capped ? "items" : "idle";
		}
		await endRun(space, txn, d.ttl, slot.session, slot.runId, "finished", extra);
	}).catch((e) => { if (!(e instanceof RunGone)) throw e; });
	return !(await readRun(space, slot.session, slot.runId));
}

/** The work of starting a run in `txn`: the CodeRun (one per room), a slot per agent, and the first items. Generations:
 *  the first generation (none when the task was solved before the run and needs no more improvement). The board: the
 *  critiques of the closest attempts the block already has and new approaches for the rest; on a fresh task research
 *  first, or the planning round. */
export async function startSpaceRun(space: SpaceLike, txn: string, ttl: number, run: { session: string; runId: string; blockId: string; params: RunParams; info: RunInfo }): Promise<void> {
	const progress: Record<string, GenProgress> = {}, task = await blockTask(space, run.session, run.blockId);
	const text = !!task && isText(task);
	const attempts = (await teamView(space, run.session, run.blockId, text)).attempts;
	let items: WorkItem[] = [], board: BoardState | undefined, gen = 0;
	if (!run.params.board) {
		const opening = run.info.solvedGen !== null && 0 >= run.info.solvedGen + run.params.polish ? null : generationItems(run, run.params, 0, attempts);
		if (opening) { progress[0] = opening.progress; items = opening.items; gen = 1; }
	} else {
		board = { phase: "work", phaseLeft: 0, created: 0, done: 0, critiques: 0, proposals: 0, votes: 0, judgements: 0, findings: 0, improveLeft: run.params.polish * run.params.agents, merged: [] };
		const solved = await isSolved(space, run.session, run.blockId, text);
		const usable = attempts.filter((a) => !a.rejected), open = usable.slice(0, Math.ceil(run.params.agents / 2));
		if (solved) for (const x of usable.filter((a) => a.ok).slice(0, Math.min(run.params.agents, board.improveLeft))) { board.improveLeft--; items.push(newItem(run, "critique", 0, { depth: 0, targetId: x.candidateId, notBy: x.author, improve: true })); }
		else if (open.length) { for (const x of open) items.push(newItem(run, "critique", 0, { depth: 0, targetId: x.candidateId, notBy: x.author })); for (let i = open.length; i < run.params.agents; i++) items.push(newItem(run, "implement", 0, { depth: 0, onlyBy: `agent-${i}` })); }
		else if (run.params.research) { board.phase = "research"; items = boardOpening(run, "research", []); board.phaseLeft = items.length; }
		else if (run.params.plan) { board.phase = "propose"; items = boardOpening(run, "propose", []); board.phaseLeft = items.length; }
		else items = boardOpening(run, "work", []);
		board.created = items.length;
	}
	const info: RunInfo = { ...run.info, gen, ...(board ? { board: { open: items.length, done: 0, critiques: 0, ...(run.params.plan ? { proposals: 0, votes: 0 } : {}), ...(run.params.research ? { findings: 0 } : {}) } } : {}) };
	await space.write({ type: "CodeRun", fields: { session: run.session, runId: run.runId, blockId: run.blockId, params: run.params, info, progress, ...(board ? { board } : {}), ts: Date.now() } as never }, txn, ttl, { unique: ["session"] });
	for (let a = 0; a < run.params.agents; a++) await space.write({ type: "AgentSlot", fields: { session: run.session, runId: run.runId, agent: a, model: run.params.contenders[a % run.params.contenders.length]! } }, txn, ttl);
	for (const x of items) await space.write(itemEntry(x), txn, ttl);
}

export type { Role };
