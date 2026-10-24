// A room in the shared space, as every process reads and writes it: the verdicts and answers of a block, what the team
// knows about it, handing in a contribution, leaving a note. Plain functions over a SpaceLike, so the web process and
// the agent processes share them; a `txn` lets an agent do them inside the transaction of its work item.
import { randomBytes } from "node:crypto";
import { NO_WAIT, type SpaceLike } from "phi-spaces";
import { sourceProblem, type Verdict } from "./judge.ts";
import { clipWords, type Attempt, type Earlier, type Finding, type Note, type Role, type Usage } from "./llm.ts";
import { EARLIER_CAP, validMs } from "./results.ts";
import { HELD_WAIT_MS, readExisting } from "./space.ts";
import { isText, taskFromSpec, type Task } from "./tasks.ts";

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
/** The task of a block (null when the block is gone; a CodeTask held for a moment is waited for, one held for longer
 *  throws StillHeld: it is not gone). */
export async function blockTask(space: SpaceLike, session: string, blockId: string): Promise<Task | null> {
	const e = await readExisting(space, { type: "CodeTask", fields: { session, blockId } });
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

/** Accepted results of earlier tasks like this one (CodeEarlier, kept beyond the rooms' own entries): text answers
 *  for a similar question, the best code for the same function and a similar description; the most similar first,
 *  then the newest. A result a person accepted counts in its own room only: anyone can give a thumbs-up, so it must
 *  not reach the agents of other rooms. Material for the agents, never instructions. */
export async function earlierFor(space: SpaceLike, session: string, blockId: string, task: Task): Promise<Earlier[]> {
	const words = (t: string) => new Set(t.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 4));
	const mine = words(task.prompt.en);
	const similar = (t: string) => { const w = words(t); let n = 0; for (const x of w) if (mine.has(x)) n++; return n / Math.max(1, new Set([...w, ...mine]).size); };
	const text = isText(task);
	type Row = { session: string; blockId: string; taskId: string; question: string; result: string; by: string; human?: boolean; ts: number };
	return (await space.readAll({ type: "CodeEarlier", fields: text ? { kind: "text" } : { kind: "code", fn: task.fn } }, { limit: EARLIER_CAP + 50 }))
		.map((e) => e.fields as unknown as Row)
		.filter((f) => f.blockId !== blockId && (!f.human || f.session === session))
		.map((f) => ({ f, sim: !text && f.taskId === task.id && f.taskId !== "custom" ? 1 : similar(String(f.question)) }))
		.filter((x) => x.sim >= 0.2).sort((a, b) => b.sim - a.sim || b.f.ts - a.f.ts).slice(0, 2)
		.map(({ f }) => ({ question: String(f.question), result: String(f.result), by: String(f.by) }));
}

/** The block's research findings, the newest 20 first (earlier runs' findings on the same block count too). readAll
 *  returns the oldest first, so they are read whole (the room keeps at most a few hundred) and cut after sorting. */
export async function findingsOf(space: SpaceLike, session: string, blockId: string): Promise<Finding[]> {
	return (await space.readAll({ type: "CodeFinding", fields: { session, blockId } }, { limit: 1000 }))
		.map((e) => e.fields as unknown as Finding & { ts: number }).sort((a, b) => b.ts - a.ts).slice(0, 20);
}

/** A run's proposals with their average rating (null: no vote), best first. */
export async function rankedProposals(space: SpaceLike, session: string, runId: string, txn: string | null = null): Promise<Array<{ proposalId: string; author: string; via: string; text: string; score: number | null; ts: number }>> {
	const ps = (await space.readAll({ type: "CodeProposal", fields: { session, runId } }, { limit: 50, txn })).map((e) => e.fields as { proposalId: string; author: string; via: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts);
	const vs = (await space.readAll({ type: "CodeVote", fields: { session, runId } }, { limit: 50, txn })).map((e) => (e.fields as { scores: Record<string, number> }).scores);
	return ps.map((p) => { const got = vs.map((v) => v[p.proposalId]).filter((x): x is number => typeof x === "number"); return { ...p, score: got.length ? got.reduce((a, b) => a + b, 0) / got.length : null }; })
		.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

/** Writes a text answer (the board's judges check it); its id. `crossNeeded`: the run has another model than the
 *  author's, so one of the judges who accept the answer must run another model. */
export async function enqueueAnswer(space: SpaceLike, txn: string | null, ttl: number, a: { session: string; blockId: string; author: string; via: string; gen: number; text: string; runId?: string; crossNeeded?: boolean; lineage?: { role?: Role; basedOn?: string; partner?: string; critiqueId?: string; proposalId?: string; usage?: Usage } }): Promise<string> {
	const answerId = `a${Date.now().toString(36)}-${rid()}`;
	await space.write({ type: "TextAnswer", fields: { session: a.session, blockId: a.blockId, answerId, author: a.author, via: a.via, gen: a.gen, text: a.text, ts: Date.now(), ...(a.runId ? { runId: a.runId } : {}), ...(a.crossNeeded ? { crossNeeded: true } : {}), ...Object.fromEntries(Object.entries(a.lineage ?? {}).filter(([, v]) => v !== undefined)) } as never }, txn, ttl);
	return answerId;
}

/** What the ▶ of a contribution runs: its code and the task it was written for (the candidate names it, a verdict
 *  through its block; an entry from before task blocks falls back to the room's newest task). Null when it is gone;
 *  throws for a text answer. Read by the web process (to answer at once) and by the judge that runs it. */
export async function execTarget(space: SpaceLike, session: string, candidateId: string): Promise<{ source: string; task: Task } | null> {
	const find = async (): Promise<Record<string, unknown> | null> => {
		if ((await space.readAll({ type: "TextAnswer", fields: { session, answerId: candidateId } }, { limit: 1 }))[0]) throw new Error("A text answer cannot be run");
		for (const type of ["CodeScore", "CodeCandidate", "CodeJudging"]) {
			const e = (await space.readAll({ type, fields: { session, candidateId } }, { limit: 1 }))[0];
			if (e) return e.fields as Record<string, unknown>;
		}
		return null;
	};
	// a judge that just took the candidate writes its marker a moment later: look again for a little while
	let f = await find();
	for (let i = 0; !f && i < 10; i++) { await new Promise((r) => setTimeout(r, 150)); f = await find(); }
	if (!f) return null;
	const blocks = await taskEntries(space, session);
	const block = f.blockId === undefined ? undefined : blocks.find((t) => String(t.blockId ?? `t${t.ts}`) === f.blockId);
	const task = (f.taskId !== undefined ? taskFromSpec(f) : null) ?? (block ? taskFromSpec(block) : null) ?? (blocks.at(-1) ? taskFromSpec(blocks.at(-1)!) : null);
	if (!task || isText(task)) throw new Error(task ? "A text answer cannot be run" : "Unknown task");
	return { source: String(f.source ?? ""), task };
}

/** What the model processes say about the models: each keeps its own ModelInfo (renewed every 10 s), and they are
 *  merged here (the models of all of them, the newest one's current model and admin view). Model processes take any
 *  call, so they are meant to have the same credentials: more of them share the load and stand in for each other. */
export type ModelInfoView = { info: { enabled: boolean; on: boolean; current: string | null; models: Array<{ id: string; label: string }> }; admin: { enabled: boolean; on: boolean; models: Array<{ label: string; provider: string; id: string; name: string }>; allowed: string[]; custom: boolean } };
export async function modelInfoOf(space: SpaceLike): Promise<ModelInfoView> {
	const rows = (await space.readAll({ type: "ModelInfo" }, { limit: 50 })).map((e) => e.fields as Partial<ModelInfoView> & { ts?: number }).filter((f) => f.info && f.admin).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0));
	if (!rows.length) return { info: { enabled: false, on: false, current: null, models: [] }, admin: { enabled: false, on: false, models: [], allowed: [], custom: false } };
	const union = <T>(lists: T[][], key: (x: T) => string) => { const seen = new Set<string>(); return lists.flat().filter((x) => !seen.has(key(x)) && !!seen.add(key(x))); };
	const [newest] = rows as Array<ModelInfoView>;
	return {
		info: { enabled: rows.some((r) => r.info!.enabled), on: rows.some((r) => r.info!.on), current: newest!.info.current, models: union(rows.map((r) => r.info!.models), (m) => m.label) },
		admin: { ...newest!.admin, enabled: rows.some((r) => r.admin!.enabled), on: rows.some((r) => r.admin!.on), models: union(rows.map((r) => r.admin!.models), (m) => m.label), allowed: union(rows.map((r) => r.admin!.allowed), (l) => l) },
	};
}

/** Whether a block's task is solved: code has a best (CodeBest), a text task an accepted answer. */
export async function isSolved(space: SpaceLike, session: string, blockId: string, text: boolean): Promise<boolean> {
	if (text) return (await answersOf(space, session, blockId)).some((a) => a.ok);
	return !!(await space.readIfExists({ type: "CodeBest", fields: { session, blockId } }, HELD_WAIT_MS));
}
