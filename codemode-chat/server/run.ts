// A run in the shared space, carried out by agent processes without any coordinator (docs/codemode-space-architektur.md).
//
//   CodeRun     the run: its parameters, what it shows (info) and its progress per generation; `unique` per room. It is
//               also the run's lock: whoever changes it takes it under its own transaction and writes it back.
//   AgentSlot   one per agent: an agent process takes it under a long transaction and works as that agent until the
//               run is over (a process that dies lets the transaction lapse, and another takes the slot).
//   WorkItem    work of the run: a `turn` (one contribution of one agent in a generation) or a `barrier` (the end of a
//               generation: it waits until every turn is done and every contribution judged, then opens the next).
//   AgentBusy   an agent working on an item (written before it takes one, lease renewed while it works): the run is
//               over when no work item is left and no agent is busy.
//   CodeRunDone how a run ended (its info), for the page after the CodeRun is gone.
//
// An agent does an item inside one transaction: take the item, write the contribution, update CodeRun, write the
// follow-ups, commit. A crash rolls all of it back and the item is there again: every item is done exactly once.
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import type { BoardInfo } from "./board.ts";
import type { Attempt, Role, Usage } from "./llm.ts";
import type { LlmCall, LlmResultEntry } from "./context.ts";
import { FATAL_LLM, modelWaitMs } from "./limits.ts";
import { addNote, blockTask, enqueueCandidate, rid, systemLine, teamView, planTurn } from "./room.ts";
import { HELD_WAIT_MS, keepAlive } from "./space.ts";
import { isText, type Task } from "./tasks.ts";

export type RunMode = "scripted" | "llm";
/** `gens` is the most generations a run may take; it ends earlier once the task is solved and `polish` more
 *  generations improved the solution (`solvedGen`: the generation that solved it, 0 = solved before the run). */
export type RunInfo = { active: boolean; blockId: string; mode: RunMode; contenders: string[]; gen: number; gens: number; agents: number; perAgent: number; polish: number; solvedGen: number | null; note?: string; usage: { tokens: number; costUsd: number }; research?: true;
	/** The work board (instead of generations): open and done items, critiques written. */
	board?: BoardInfo;
	/** Limits of the run's model calls; whichever is reached first ends it. */
	budget?: { tokens?: number; usd?: number };
	/** Why the run ended (when not solved or stopped): the budget, the item cap, or no work left. */
	ended?: "budget" | "items" | "idle" | "accepted" };
/** What a run was started with. `engine: "space"`: carried out by the agent processes (run.ts); without it the web
 *  process runs it itself (runs with model agents, until they move to the agent processes too). */
export type RunParams = { runId: string; agents: number; gens: number; perAgent: number; polish: number; contenders: string[]; lang: "de" | "en"; board: boolean; plan: boolean; research: boolean; budget: { tokens?: number; usd?: number };
	/** Who started it: a visitor's usage counts against the day's allowance of their address; an admin's does not. */
	client?: { ip: string; admin: boolean }; engine?: "space" };
/** A generation's progress: turns in it, turns done, contributions handed in. */
export type GenProgress = { total: number; done: number; handedIn: number };
export type RunEntry = { session: string; runId: string; blockId: string; params: RunParams; info: RunInfo; progress: Record<string, GenProgress>; ts: number };
/** A turn carries its role and the attempt it works on, chosen when its generation began: every agent of a generation
 *  builds on the same state, whoever of them gets to work first. */
export type WorkItem = { session: string; runId: string; blockId: string; itemId: string; kind: "turn" | "barrier"; gen: number; ts: number; k?: number; onlyBy?: string; role?: Role; targetId?: string; notBefore?: number; waits?: number; tries?: number };
export type Slot = { session: string; runId: string; agent: number; model: string };

/** An item's and a slot's transaction lease (renewed while they are worked on), and an AgentBusy marker's: a dead
 *  agent's work is back within it (CODEMODE_AGENT_LEASE_MS, default 60 s). */
export const ITEM_LEASE_MS = Math.max(1000, Number(process.env.CODEMODE_AGENT_LEASE_MS || 60_000));
const BUSY_LEASE_MS = ITEM_LEASE_MS;
/** Failed tries of an item before it is given up (it then counts as done, with nothing handed in). */
const MAX_TRIES = 3;
/** A barrier that is not ready looks again after 1, 2, 4, 8, then every 10 s: each look is a commit. */
const backoff = (waits: number) => Math.min(10_000, 1000 * 2 ** waits);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The run is gone (stopped, or ended by another agent): the work in progress is dropped. */
class RunGone extends Error {}

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

/** The closing line of a run (how it ended, how far it got). */
export async function closingLine(space: SpaceLike, r: RunEntry, how: "finished" | "stopped" | "accepted"): Promise<string> {
	const task = await blockTask(space, r.session, r.blockId);
	const best = (await space.readIfExists({ type: "CodeBest", fields: { session: r.session, blockId: r.blockId } }, HELD_WAIT_MS))?.fields as { ms?: number } | undefined;
	const closest = best || !task ? null : (await teamView(space, r.session, r.blockId, isText(task)).catch(() => null))?.attempts[0];
	const info = r.info, board = r.params.board;
	const result = best ? `solved${info.solvedGen && !board ? ` in generation ${info.solvedGen}` : info.solvedGen === 0 ? " before the run" : ""}, best ${best.ms} ms` : `not solved yet${closest ? ` (closest: ${closest.author}, ${closest.passed ?? 0}/${closest.total ?? "?"} cases)` : ""}`;
	const why = info.ended === "budget" ? " (budget used up)" : info.ended === "items" ? " (item limit reached)" : "";
	const span = board ? `${info.board?.done ?? 0} work items, ${info.board?.critiques ?? 0} critiques` : `${info.gen} generation${info.gen === 1 ? "" : "s"}`;
	return `Run ${how === "accepted" ? "ended (an answer was accepted)" : how} after ${span}${why}: ${result}`;
}

/** Ends a run in `txn`: its CodeRun goes (taken: only one ender succeeds), its left-over items go, a CodeRunDone keeps
 *  how it ended, and the closing line is written. False when the run was already gone. */
export async function endRun(space: SpaceLike, txn: string, ttl: number, session: string, runId: string, how: "finished" | "stopped" | "accepted", extra: Partial<RunInfo> = {}): Promise<boolean> {
	const e = await space.takeIfExists({ type: "CodeRun", fields: { session, runId } }, HELD_WAIT_MS, { txn });
	if (!e) return false;
	const r = e.fields as unknown as RunEntry;
	Object.assign(r.info, extra);
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

export type AgentDeps = { space: SpaceLike; ttl: number; open: Set<string>; stopping: () => boolean };

/** One agent of a run: takes the items it may do, one after the other, until the run is over (or the process stops). */
export async function agentLoop(d: AgentDeps, slot: Slot): Promise<void> {
	const { space } = d, me = `agent-${slot.agent}`;
	while (!d.stopping()) {
		if (!(await readRun(space, slot.session, slot.runId))) return;
		// busy before taking anything: whoever looks for the end of the run meanwhile sees this agent still at work
		const busy = await space.write({ type: "AgentBusy", fields: { session: slot.session, runId: slot.runId, agent: slot.agent } }, null, BUSY_LEASE_MS);
		const stopBusy = keepAlive(space, busy.id, BUSY_LEASE_MS);
		let did: boolean;
		try { did = await workOnce(d, slot, me); }
		finally { stopBusy(); await space.cancel(busy.id).catch(() => {}); }
		if (did) continue;
		if (await maybeEnd(d, slot)) return;
		await pause(300);
	}
}

/** Takes and does one item this agent may do; false when there was none (or the only ones are not due yet). */
async function workOnce(d: AgentDeps, slot: Slot, me: string): Promise<boolean> {
	const { space } = d, now = Date.now();
	const rows = (await space.readAll({ type: "WorkItem", fields: { session: slot.session, runId: slot.runId } }, { limit: 500 }))
		.map((e) => ({ id: e.id, it: e.fields as unknown as WorkItem }))
		.filter(({ it }) => (!it.onlyBy || it.onlyBy === me) && (it.notBefore ?? 0) <= now)
		.sort((a, b) => a.it.ts - b.it.ts);
	for (const { id, it } of rows) {
		try {
			const done = await inTxn(space, d.open, async (txn) => {
				if (!(await space.take({ id }, NO_WAIT, { txn }))) return null; // another agent took it first
				return execute(d, slot, me, it, txn);
			});
			if (done === null) continue;
			return done !== "waiting";
		} catch (e) {
			if (e instanceof RunGone || d.stopping()) return false;
			console.error("[agents] item failed", it.kind, (e as Error).message);
			await giveUpOrRetry(d, id, it).catch(() => {});
			return true;
		}
	}
	return false;
}

/** A failed item: back on the board a little later, or after MAX_TRIES done with nothing handed in (its generation
 *  must not wait for it forever). */
async function giveUpOrRetry(d: AgentDeps, id: string, it: WorkItem): Promise<void> {
	const { space } = d, tries = (it.tries ?? 0) + 1;
	await inTxn(space, d.open, async (txn) => {
		if (!(await space.take({ id }, NO_WAIT, { txn }))) return;
		if (tries < MAX_TRIES) { await space.write(itemEntry({ ...it, tries, notBefore: Date.now() + 2000 * tries }), txn, d.ttl); return; }
		if (it.kind === "turn") await updateRun(space, txn, d.ttl, it.session, it.runId, (r) => { const p = r.progress[it.gen]; if (p) p.done++; });
	});
}

/** Does an item in `txn`. "waiting": a barrier that is not ready went back with a later time. */
async function execute(d: AgentDeps, slot: Slot, me: string, it: WorkItem, txn: string): Promise<"done" | "waiting"> {
	if (it.kind === "turn") { await turn(d, slot, me, it, txn); return "done"; }
	return barrier(d, it, txn);
}

/** Asks the model process for a call and waits for its answer, in `txn`: the answer is taken in the item's
 *  transaction, so if the item is cut off it stays for the next try. The call's id belongs to the item, so a retry
 *  finds the answer from before (or the call still waiting: written `unique`) instead of paying for a second call. */
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

/** Whether a run's model calls have used up its budget (tokens or dollars, whichever comes first). */
const overBudget = (r: RunEntry) => { const b = r.info.budget, u = r.info.usage; return !!b && ((b.tokens !== undefined && u.tokens >= b.tokens) || (b.usd !== undefined && u.costUsd >= b.usd)); };

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
			const res = await callModel(space, txn, { callId: `${it.itemId}-c0`, session: it.session, blockId: it.blockId, runId: it.runId, kind: "contribute", agent: slot.agent, gen: it.gen, model: slot.model, lang: run.params.lang, role: plan.role, ...(plan.target ? { targetId: plan.target.candidateId } : {}), ...(run.params.client ? { client: run.params.client } : {}), ts: Date.now() });
			if (res.ok && res.value) {
				const v = res.value as { source: string; model: string; note?: string; usage?: Usage };
				source = v.source; via = v.model; usage = v.usage; note = v.note;
				lineage = { role: plan.role, ...(plan.target ? { basedOn: plan.target.candidateId } : {}), ...(v.usage ? { usage: v.usage } : {}) };
			} else {
				runNote = `${slot.model}: ${res.error ?? "failed"}${task.variants.length ? "; scripted agent used" : ""}`;
				fatal = FATAL_LLM.test(res.error ?? "");
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
		if (usage) r.info.usage = { tokens: r.info.usage.tokens + usage.total, costUsd: r.info.usage.costUsd + usage.costUsd };
		if (runNote) r.info.note = runNote;
		if (fatal || overBudget(r)) r.info.ended ??= "budget"; // no next generation; the run ends once its items are done
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

/** No item left and no agent busy: the run is over, and this agent ends it (only one succeeds: the CodeRun is taken). */
async function maybeEnd(d: AgentDeps, slot: Slot): Promise<boolean> {
	const { space } = d, k = { session: slot.session, runId: slot.runId };
	if ((await space.count({ type: "WorkItem", fields: k })) > 0 || (await space.count({ type: "AgentBusy", fields: k })) > 0) return false;
	await inTxn(space, d.open, async (txn) => {
		// still empty now that this transaction looks: a busy agent writes its marker before it takes anything
		if ((await space.count({ type: "WorkItem", fields: k })) > 0 || (await space.count({ type: "AgentBusy", fields: k })) > 0) return;
		await endRun(space, txn, d.ttl, slot.session, slot.runId, "finished");
	}).catch((e) => { if (!(e instanceof RunGone)) throw e; });
	return !(await readRun(space, slot.session, slot.runId));
}

/** The work of starting a run in `txn`: the CodeRun (one per room), a slot per agent, the first generation's items
 *  (none when the task was solved before the run and needs no more improvement). */
export async function startSpaceRun(space: SpaceLike, txn: string, ttl: number, run: { session: string; runId: string; blockId: string; params: RunParams; info: RunInfo }): Promise<void> {
	const progress: Record<string, GenProgress> = {};
	const attempts = (await teamView(space, run.session, run.blockId, false)).attempts;
	const opening = run.info.solvedGen !== null && 0 >= run.info.solvedGen + run.params.polish ? null : generationItems(run, run.params, 0, attempts);
	if (opening) progress[0] = opening.progress;
	await space.write({ type: "CodeRun", fields: { session: run.session, runId: run.runId, blockId: run.blockId, params: run.params, info: { ...run.info, gen: opening ? 1 : 0 }, progress, ts: Date.now() } as never }, txn, ttl, { unique: ["session"] });
	for (let a = 0; a < run.params.agents; a++) await space.write({ type: "AgentSlot", fields: { session: run.session, runId: run.runId, agent: a, model: run.params.contenders[a % run.params.contenders.length]! } }, txn, ttl);
	for (const x of opening?.items ?? []) await space.write(itemEntry(x), txn, ttl);
}

export type { Role };
