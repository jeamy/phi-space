// What a model call needs, rebuilt from the shared space by the model process. An agent asks for a call with references
// only (LlmCall: the kind, the model, the agent, the room, block and run, and the ids of what the call works on); the
// model process reads the task, the team's attempts, notes, plans, critiques, findings and earlier results itself. So a
// call entry stays small whatever the room holds (the space caps an entry at 64 KiB, and the context of one call can be
// several times that). Calls about a task that has no block yet (its check rule, its criteria) carry the task's spec.
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { HELD_WAIT_MS } from "./space.ts";
import type { Attempt, CritiqueRef, Earlier, Finding, PlanRef, Role, TeamContext, Usage } from "./llm.ts";
import { blockTask, earlierFor, findingsOf, rankedProposals, teamView } from "./room.ts";
import { isText, taskFromSpec, type Task } from "./tasks.ts";

export type CallKind = "contribute" | "critique" | "propose" | "vote" | "judge" | "research" | "verify" | "criteria" | "reviewCriteria";
/** A request for a model call, as an agent writes it (and the model process takes it). */
export type LlmCall = {
	callId: string; session: string; blockId?: string; runId?: string; kind: CallKind;
	agent: number; gen: number; model?: string; lang: "de" | "en";
	/** contribute: what the agent does, the attempt it works on, a merge partner, the critique and plan it follows. */
	role?: Role; targetId?: string; partnerId?: string; critiqueId?: string; proposalId?: string;
	/** contribute and propose: earlier accepted results as material; research findings of the block as material. */
	withEarlier?: boolean; withFindings?: boolean;
	/** vote: the proposals to rate (by id); judge: the answer. */
	proposalIds?: string[]; answerId?: string;
	/** verify / criteria / reviewCriteria: the task (it has no block yet), and why the last check rule was refused. */
	task?: Record<string, unknown>; feedback?: string;
	/** Who started the run: a visitor's calls count against the day's allowance of their address. */
	client?: { ip: string; admin: boolean };
	ts: number;
};
/** The answer the model process writes for a call. */
/** `usage` on a failed call: what it used before it failed (a success has it in its value). */
export type LlmResultEntry = { callId: string; session: string; ok: boolean; value?: Record<string, unknown>; error?: string; usage?: Usage; ts: number };

/** The block's task and its team: attempts (answers for a text task), notes, and the attempt with a given id. */
async function team(space: SpaceLike, call: LlmCall): Promise<{ task: Task; attempts: Attempt[]; notes: TeamContext["notes"]; find: (id?: string) => Attempt | undefined }> {
	const task = call.task ? taskFromSpec(call.task) : await blockTask(space, call.session, call.blockId ?? "");
	if (!task) throw new Error("the task block is gone");
	if (!call.blockId) return { task, attempts: [], notes: [], find: () => undefined };
	const view = await teamView(space, call.session, call.blockId, isText(task));
	return { task, attempts: view.attempts, notes: view.notes, find: (id) => (id ? view.attempts.find((a) => a.candidateId === id) : undefined) };
}

/** The plan a contribution follows (with the team's average rating). */
async function planOf(space: SpaceLike, call: LlmCall): Promise<PlanRef | undefined> {
	if (!call.proposalId || !call.runId) return undefined;
	const p = (await rankedProposals(space, call.session, call.runId)).find((x) => x.proposalId === call.proposalId);
	return p ? { author: p.author, via: p.via, score: p.score, text: p.text } : undefined;
}
async function critiqueOf(space: SpaceLike, call: LlmCall): Promise<CritiqueRef | undefined> {
	if (!call.critiqueId) return undefined;
	const f = (await space.readAll({ type: "CodeCritique", fields: { session: call.session, critiqueId: call.critiqueId } }, { limit: 1 }))[0]?.fields as { author: string; via: string; text: string } | undefined;
	return f ? { author: f.author, via: f.via, text: f.text } : undefined;
}
const findings = async (space: SpaceLike, call: LlmCall): Promise<Finding[] | undefined> => (call.withFindings && call.blockId ? findingsOf(space, call.session, call.blockId) : undefined);
const earlier = async (space: SpaceLike, call: LlmCall, task: Task): Promise<Earlier[] | undefined> => (call.withEarlier ? earlierFor(space, call.session, call.blockId ?? "", task) : undefined);
const some = <T>(x: T[] | undefined) => (x?.length ? x : undefined);

/** The arguments of the llm.ts function for a call's kind. */
export async function callArgs(space: SpaceLike, call: LlmCall): Promise<Record<string, unknown>> {
	const base = { agent: call.agent, ...(call.model ? { model: call.model } : {}) };
	if (call.kind === "verify") return { task: taskFromSpec(call.task ?? {}), ...(call.feedback ? { feedback: call.feedback } : {}), ...(call.model ? { model: call.model } : {}) };
	if (call.kind === "criteria") return { task: taskFromSpec(call.task ?? {}), ...(call.model ? { model: call.model } : {}) };
	if (call.kind === "reviewCriteria") return { task: taskFromSpec(call.task ?? {}), ...base };
	const t = await team(space, call);
	const usable = t.attempts.filter((a) => !a.rejected), fs = await findings(space, call);
	if (call.kind === "research") return { task: t.task, ...base, ...(fs ? { findings: fs } : {}) };
	if (call.kind === "propose") return { task: t.task, ...base, notes: t.notes, attempts: t.attempts.slice(0, 3), ...(some(await earlier(space, call, t.task)) ? { earlier: await earlier(space, call, t.task) } : {}), ...(some(fs) ? { findings: fs } : {}) };
	if (call.kind === "vote") {
		const ps = (await rankedProposals(space, call.session, call.runId ?? "")).filter((p) => call.proposalIds?.includes(p.proposalId)).sort((a, b) => a.proposalId.localeCompare(b.proposalId));
		return { task: t.task, ...base, notes: t.notes, proposals: ps.map((p, i) => ({ key: `P${i + 1}`, author: p.author, text: p.text, proposalId: p.proposalId })) };
	}
	if (call.kind === "judge") {
		const answer = t.find(call.answerId);
		if (!answer) throw new Error("the answer is gone");
		return { task: t.task, ...base, answer };
	}
	if (call.kind === "critique") {
		const target = t.find(call.targetId);
		if (!target) throw new Error("the attempt is gone");
		return { task: t.task, ...base, target, others: usable.filter((x) => x !== target).slice(0, 2), notes: t.notes, ...(some(fs) ? { findings: fs } : {}) };
	}
	// contribute: a generation's turn, or an implement / revise / merge / improve item of the work board
	const target = t.find(call.targetId), partner = t.find(call.partnerId);
	const best = call.blockId && !isText(t.task) ? (await space.readIfExists({ type: "CodeBest", fields: { session: call.session, blockId: call.blockId } }, HELD_WAIT_MS))?.fields as { candidateId: string; ms: number } | undefined : undefined;
	const bestSource = best ? usable.find((a) => a.candidateId === best.candidateId)?.source : undefined;
	const plan = await planOf(space, call), critique = await critiqueOf(space, call), ea = await earlier(space, call, t.task);
	const ctx: TeamContext = {
		task: t.task, lang: call.lang, agent: call.agent, gen: call.gen, ...(call.model ? { model: call.model } : {}),
		role: call.role ?? "explore", target: target && !target.rejected ? target : null,
		others: usable.filter((a) => a.candidateId !== call.targetId && a.candidateId !== call.partnerId).slice(0, 3), rejected: t.attempts.filter((a) => a.rejected).slice(0, 3), notes: t.notes,
		best: best && bestSource !== undefined ? { source: bestSource, ms: best.ms } : null,
		...(critique ? { critique } : {}), ...(partner ? { partner } : {}), ...(plan ? { plan } : {}), ...(some(ea) ? { earlier: ea } : {}), ...(some(fs) ? { findings: fs } : {}),
	};
	return ctx as unknown as Record<string, unknown>;
}

/** A vote's scores come back keyed P1, P2 …; they are stored per proposal id. */
export function voteScores(args: Record<string, unknown>, scores: Record<string, number>): Record<string, number> {
	const keys = (args.proposals as Array<{ key: string; proposalId: string }> | undefined) ?? [];
	return Object.fromEntries(keys.filter((k) => scores[k.key] !== undefined).map((k) => [k.proposalId, scores[k.key]!]));
}

export { NO_WAIT };
