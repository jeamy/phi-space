// A room in the shared space, as every process reads and writes it: the verdicts and answers of a block, what the team
// knows about it, handing in a contribution, leaving a note. Plain functions over a SpaceLike, so the web process and
// the agent processes share them; a `txn` lets an agent do them inside the transaction of its work item.
import { randomBytes } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import { sourceProblem, type Verdict } from "./judge.ts";
import { clipWords, type Attempt, type Note, type Role, type Usage } from "./llm.ts";
import { validMs } from "./results.ts";
import { HELD_WAIT_MS } from "./space.ts";
import { taskFromSpec, type Task } from "./tasks.ts";

/** What a room may hold at most: every read of it stays complete (a read limit never cuts entries off). */
export const ROOM_LIMITS = { contributions: 1000, notes: 300, blocks: 60, messages: 500 };
/** A random id part: ids are made by several processes at once. */
export const rid = () => randomBytes(4).toString("hex");

/** `source` is left out of a snapshot when its byte budget is spent (`sourceOmitted`); `details()` returns it with the
 *  case results. `passed`/`total`: cases passed; `role`/`basedOn`: what an agent did and whose attempt it built on. */
export type Contribution = { candidateId: string; blockId?: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; passed?: number; total?: number; role?: Role; basedOn?: string; cases?: Verdict["cases"]; hardcoded?: true; note?: string; usage?: Usage; partner?: string; judges?: number; acceptedBy?: "judges" | "human"; critiqueId?: string; critiques?: Array<{ author: string; via: string; text: string }>; critiqueBy?: string; proposalId?: string; planBy?: string; vetoed?: { by: string; reason: string }; source?: string; sourceOmitted?: true; runId?: string; ts: number };

/** Correct and not rejected by a person. */
export const counts = (c: Contribution) => !!c.ok && !c.vetoed;
/** A contribution as the agents see it. */
export const attemptOf = (c: Contribution): Attempt => ({ candidateId: c.candidateId, author: c.author, via: c.via, gen: c.gen, ok: counts(c), ms: c.ms, ...(c.vetoed ? { rejected: `rejected by ${c.vetoed.by}${c.vetoed.reason ? `: ${c.vetoed.reason}` : ""}` } : c.hardcoded ? { rejected: "rejected: it hard-codes the expected result instead of computing it" } : {}), passed: c.passed, total: c.total, error: c.error, cases: c.cases, source: c.source ?? "" });
/** The fastest contribution that counts (ties: the earlier one). */
export const bestOf = (cs: Contribution[]): { candidateId: string; ms: number; source: string } | null => {
	const ok = cs.filter((c) => counts(c) && validMs(c.ms)).sort((a, b) => a.ms! - b.ms! || a.ts - b.ts)[0];
	return ok ? { candidateId: ok.candidateId, ms: ok.ms!, source: ok.source ?? "" } : null;
};
/** How close an attempt got: correct first (fastest), then most cases passed, then the newest. */
const rejectedRank = (c: Contribution) => Number(!!c.vetoed || !!c.hardcoded);
export const closeness = (a: Contribution, b: Contribution) => rejectedRank(a) - rejectedRank(b) || Number(counts(b)) - Number(counts(a)) || (counts(a) && counts(b) ? a.ms! - b.ms! : 0) || (b.passed ?? 0) / (b.total || 1) - (a.passed ?? 0) / (a.total || 1) || b.ts - a.ts;

/** The task blocks of a room (CodeTask entries), oldest first. */
export async function taskEntries(space: SpaceLike, session: string): Promise<Array<Record<string, any>>> {
	return (await space.readAll({ type: "CodeTask", fields: { session } }, { limit: ROOM_LIMITS.blocks + 5 })).map((e) => e.fields as Record<string, any>).sort((a, b) => a.ts - b.ts);
}
/** The task of a block (null when the block is gone; a CodeTask held for a moment is waited for). */
export async function blockTask(space: SpaceLike, session: string, blockId: string): Promise<Task | null> {
	const e = await space.readIfExists({ type: "CodeTask", fields: { session, blockId } }, HELD_WAIT_MS);
	if (e) return taskFromSpec(e.fields as Record<string, unknown>);
	const legacy = (await taskEntries(space, session)).find((f) => f.blockId === undefined && `t${f.ts}` === blockId); // a block from before blockIds
	return legacy ? taskFromSpec(legacy) : null;
}

/** The people's vetoes of a room: candidate → who and why. */
export async function vetoesOf(space: SpaceLike, session: string): Promise<Map<string, { by: string; reason: string }>> {
	const rows = await space.readAll({ type: "CodeVeto", fields: { session } }, { limit: ROOM_LIMITS.contributions });
	return new Map(rows.map((e) => { const f = e.fields as { candidateId: string; by: string; reason: string }; return [f.candidateId, { by: f.by, reason: f.reason }]; }));
}

/** All verdicts of a room, oldest first, with the people's vetoes merged in. */
export async function scoresOf(space: SpaceLike, session: string): Promise<Contribution[]> {
	const [rows, vetoes] = await Promise.all([space.readAll({ type: "CodeScore", fields: { session } }, { limit: ROOM_LIMITS.contributions }), vetoesOf(space, session)]);
	return rows.map((e) => { const c = e.fields as unknown as Contribution, v = vetoes.get(c.candidateId); return v ? { ...c, vetoed: v } : c; }).sort((a, b) => a.ts - b.ts);
}

/** The answers of a text block, as contributions: who, the judges' findings per criterion, accepted or not. An answer
 *  is accepted by a person's thumbs-up, or when two judges or more found every criterion met (and, when the run had
 *  another model than the author's, one of them ran it); a veto undoes both. */
export async function answersOf(space: SpaceLike, session: string, blockId: string): Promise<Contribution[]> {
	const [rows, judgements, vetoes, accepts] = await Promise.all([
		space.readAll({ type: "TextAnswer", fields: { session, blockId } }, { limit: ROOM_LIMITS.contributions }),
		space.readAll({ type: "TextJudgement", fields: { session, blockId } }, { limit: ROOM_LIMITS.contributions * 2 }),
		vetoesOf(space, session),
		space.readAll({ type: "CodeAccept", fields: { session, blockId } }, { limit: ROOM_LIMITS.contributions }),
	]);
	const accepted = new Set(accepts.map((e) => (e.fields as { answerId: string }).answerId));
	const byAnswer = new Map<string, Array<{ judge: string; via: string; results: Array<{ criterion: string; pass: boolean; reason: string }> }>>();
	for (const e of judgements) { const f = e.fields as { answerId: string; judge: string; via: string; results: Array<{ criterion: string; pass: boolean; reason: string }> }; byAnswer.set(f.answerId, [...(byAnswer.get(f.answerId) ?? []), f]); }
	return rows.map((e) => {
		const f = e.fields as Record<string, any>, js = byAnswer.get(f.answerId) ?? [];
		const criteria: string[] = js[0]?.results.map((r) => r.criterion) ?? [];
		const cases = criteria.map((criterion, i) => ({ call: criterion, ok: js.every((j) => j.results[i]?.pass), got: js.map((j) => `${j.judge}: ${j.results[i]?.pass ? "met" : "not met"}${j.results[i]?.reason ? `, ${j.results[i]!.reason}` : ""}`).join("; ").slice(0, 600) }));
		const byJudges = js.length >= 2 && js.every((j) => j.results.length > 0 && j.results.every((r) => r.pass)) && (!f.crossNeeded || js.some((j) => j.via !== f.via));
		const acceptedBy = accepted.has(f.answerId) ? "human" as const : byJudges ? "judges" as const : undefined;
		const v = vetoes.get(f.answerId);
		return {
			candidateId: f.answerId, blockId, author: f.author, via: f.via, gen: f.gen ?? 1, ok: js.length < 2 && !acceptedBy ? null : !!acceptedBy && !v, ms: null,
			passed: cases.filter((c) => c.ok).length, total: criteria.length, cases, judges: js.length, ...(acceptedBy ? { acceptedBy } : {}), ...(v ? { vetoed: v } : {}),
			...(f.role ? { role: f.role } : {}), ...(f.basedOn ? { basedOn: f.basedOn } : {}), ...(f.critiqueId ? { critiqueId: f.critiqueId } : {}), ...(f.proposalId ? { proposalId: f.proposalId } : {}), ...(f.partner ? { partner: f.partner } : {}), ...(f.usage ? { usage: f.usage } : {}),
			source: String(f.text ?? ""), ts: f.ts,
		} as Contribution;
	}).sort((a, b) => a.ts - b.ts);
}

/** What the team knows about a block: every judged attempt (closest first, with its case results) and the newest
 *  notes (the people's hints first). A text block's answers count from their first moment. */
export async function teamView(space: SpaceLike, session: string, blockId: string, text: boolean): Promise<{ attempts: Attempt[]; notes: Note[] }> {
	const scores = (text ? await answersOf(space, session, blockId) : (await scoresOf(space, session)).filter((c) => c.blockId === blockId)).sort(closeness);
	// an agent's note whose contribution was rejected (hard-coded, or a person's veto) is advice not to pass on
	const rejected = new Set(scores.filter((c) => c.vetoed || c.hardcoded).map((c) => c.candidateId));
	const rows = (await space.readAll({ type: "CodeNote", fields: { session, blockId } }, { limit: ROOM_LIMITS.notes + 5 }))
		.map((e) => e.fields as { author: string; gen: number; text: string; ts: number; human?: boolean; candidateId?: string })
		.filter((n) => !n.candidateId || !rejected.has(n.candidateId)).sort((a, b) => a.ts - b.ts);
	const notes = [...rows.filter((n) => n.human).slice(-5), ...rows.filter((n) => !n.human).slice(-8)];
	return { attempts: scores.map(attemptOf), notes: notes.map(({ author, gen, text, human }) => ({ author, gen, text, ...(human ? { human: true } : {}) })) };
}

/** Turn `k` of a generation: improve a correct solution, repair a close attempt, or explore (every third turn, and
 *  whenever there is nothing to build on). Targets rotate over the best few, so the team does not pile onto one. */
export function planTurn(all: Attempt[], k: number): { role: Role; target: Attempt | null; others: Attempt[]; rejected: Attempt[] } {
	// rejected attempts (a person's veto, hard-coded results) are nothing to build on: they are shown as "not like this"
	const rejected = all.filter((a) => a.rejected).slice(0, 3), attempts = all.filter((a) => !a.rejected);
	const correct = attempts.filter((a) => a.ok), failing = attempts.filter((a) => !a.ok);
	let role: Role = "explore", target: Attempt | null = null;
	if (k % 3 !== 2 && correct.length) { role = "improve"; target = correct[k % Math.min(2, correct.length)]!; }
	else if (k % 3 !== 2 && failing.length) { role = "repair"; target = failing[k % Math.min(3, failing.length)]!; }
	return { role, target, others: attempts.filter((a) => a !== target).slice(0, 3), rejected };
}

/** A note for the team of a block (an agent's insight, or a person's hint); beyond the room's cap the oldest give way. */
export async function addNote(space: SpaceLike, txn: string | null, ttl: number, n: { session: string; blockId: string; author: string; via: string; gen: number; text: string; human?: boolean; candidateId?: string }): Promise<void> {
	const tmpl = { type: "CodeNote", fields: { session: n.session } };
	if ((await space.count(tmpl)) >= ROOM_LIMITS.notes) {
		const old = (await space.readAll(tmpl, { limit: ROOM_LIMITS.notes + 5 })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
		for (const e of old.slice(0, old.length - ROOM_LIMITS.notes + 1)) await space.take({ id: e.id }, NO_WAIT);
	}
	await space.write({ type: "CodeNote", fields: { session: n.session, blockId: n.blockId, author: n.author, via: n.via, gen: n.gen, text: clipWords(n.text.replace(/[\u0000-\u001f\u007f]/g, " "), 300), ts: Date.now(), ...(n.human ? { human: true } : {}), ...(n.candidateId ? { candidateId: n.candidateId } : {}) } }, txn, ttl);
}

/** Contributions a room holds (verdicts, waiting candidates, and those a judge holds right now). */
export async function contributionCount(space: SpaceLike, session: string): Promise<number> {
	const n = (type: string) => space.count({ type, fields: { session } });
	return (await n("CodeScore")) + (await n("CodeCandidate")) + (await n("CodeJudging"));
}

/** Hands a contribution to the judges: a CodeCandidate in the space (in `txn`, it becomes visible with its commit).
 *  The candidate names its task by the block (judges read the CodeTask): a custom task's cases next to the source
 *  would push the entry past the space's limit. Returns its id. */
export async function enqueueCandidate(space: SpaceLike, txn: string | null, ttl: number, c: { session: string; blockId: string; taskId: string; author: string; via: string; gen: number; source: string; runId?: string; lineage?: { role?: Role; basedOn?: string; partner?: string; critiqueId?: string; proposalId?: string; usage?: Usage } }): Promise<string> {
	const problem = sourceProblem(c.source); // an agent's code too: it must fit the space's commits
	if (problem) throw new Error(problem);
	// the cap keeps every read of the room (snapshot, ranking) complete
	if ((await contributionCount(space, c.session)) >= ROOM_LIMITS.contributions) throw new Error("This room holds the maximum number of contributions; delete a task block");
	const candidateId = `${Date.now().toString(36)}-${rid()}`;
	const l = c.lineage ?? {};
	await space.write({ type: "CodeCandidate", fields: { session: c.session, blockId: c.blockId, taskId: c.taskId, candidateId, author: c.author, via: c.via, gen: c.gen, ...(c.runId ? { runId: c.runId } : {}), ...(l.role ? { role: l.role } : {}), ...(l.basedOn ? { basedOn: l.basedOn } : {}), ...(l.partner ? { partner: l.partner } : {}), ...(l.critiqueId ? { critiqueId: l.critiqueId } : {}), ...(l.proposalId ? { proposalId: l.proposalId } : {}), ...(l.usage ? { usage: l.usage } : {}), source: c.source, ts: Date.now() } as never }, txn, ttl);
	return candidateId;
}

/** A system line of a room (or of a block); beyond the message cap the oldest lines give way. */
export async function systemLine(space: SpaceLike, txn: string | null, ttl: number, session: string, text: string, blockId?: string): Promise<void> {
	const tmpl = { type: "ChatMessage", fields: { session } };
	if ((await space.count(tmpl)) >= ROOM_LIMITS.messages) {
		const old = (await space.readAll(tmpl, { limit: ROOM_LIMITS.messages + 5 })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
		for (const e of old.slice(0, old.length - ROOM_LIMITS.messages + 1)) await space.take({ id: e.id }, NO_WAIT);
	}
	await space.write({ type: "ChatMessage", fields: { session, author: "system", text, ts: Date.now(), ...(blockId ? { blockId } : {}) } }, txn, ttl);
}
