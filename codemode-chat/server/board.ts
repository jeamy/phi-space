// The work board: a run without generations. Open work items live in the space; every agent takes the next one it may
// do, does it, writes the result and the follow-up items (the Linda way: coordination only through the shared space).
//
//   implement  write a solution (a new approach, or an improvement once the task is solved)   -> verdict -> critique
//   critique   a teammate reads another's attempt and writes what is wrong and how to fix it  -> revise
//   revise     the attempt rewritten with that critique                                         -> verdict -> critique
//   merge      two failing attempts that pass different cases, combined                        -> verdict -> critique
//
// A text task (no code) runs the same way with answers instead of code: a draft is checked by two judges against the
// task's criteria (the first from another model than the author where possible, the second another agent again),
// and the two verdicts are its "test result".
//
// With `research` (admin only), a fresh task starts with research: some agents write web search queries themselves,
// the hub searches (search.ts) and they write down what helps, with sources (CodeFinding). Every later prompt gets the
// findings as untrusted material. Then the planning round or the implementation begins.
//
// With `plan`, a fresh task starts with a planning round: every agent proposes an approach (CodeProposal), then every
// agent rates the others' proposals 1 to 5 (CodeVote), and the best one or two proposals are implemented first.
//
// A critique is never written by the attempt's own author, and a revision never by the critic: three agents take part.
// Critiques go to the critic model first (`criticModel`, e.g. haiku) when one of the agents runs it; others take them
// only after a short wait. An agent hands in and takes the next item at once: the follow-ups of a contribution come
// when its verdict does, so a slow verdict (a 600 s time limit) blocks nobody. The run ends when the task is solved and the improvement
// rounds are used, when the budget or the item cap is reached, on Stop, or when no work is left.
//
// The board survives a restart of the hub: everything it knows lies in the space. Its state (phase, counters) is one
// BoardState entry, replaced under a transaction together with the items a phase change creates. An agent claims an
// item by taking it and writing it back as claimed, in one transaction; the claimed copy goes when the work is done.
// A contribution's follow-ups are a `followup` item that waits for the verdict. After a restart (`resume`), claimed
// items are open again and the board goes on where it was; only the model calls that were in flight are repeated.
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import type { Attempt, CritiqueRef, Earlier, Finding, Note, PlanRef, Role, Usage } from "./llm.ts";
import { isText, type Task } from "./tasks.ts";

export type ItemKind = "research" | "propose" | "vote" | "implement" | "critique" | "revise" | "merge" | "judge" | "followup";
/** `improve`: work on a solution (after the task is solved); other items lapse once it is solved. */
export type WorkItem = { session: string; blockId: string; runId: string; itemId: string; kind: ItemKind; depth: number; ts: number; target?: string; partner?: string; critiqueId?: string; notBy?: string; improve?: boolean;
	/** Planning round: the agent that must do it (every agent proposes and votes once); the plan an implement follows. */
	onlyBy?: string; proposalId?: string;
	/** judge: an agent that may not judge this answer (the first judge, for the second judgement); the author's model,
	 *  which the first judge should not run (another model judges first where one is there). */
	notByAlso?: string; crossOf?: string;
	/** Who works on it now (the claimed copy); not to be taken before this time (a follow-up waiting for its verdict);
	 *  until when a follow-up waits for the verdict. */
	claimedBy?: string; notBefore?: number; deadline?: number;
	/** How often its work failed (a model call that threw): it is tried again a little later, at most MAX_TRIES times. */
	tries?: number };
/** How a board run ended; `shutdown`: the hub is closing, the board stays in the space to be resumed. */
export type BoardEnd = "solved" | "budget" | "stopped" | "items" | "idle" | "shutdown";
/** What the board shows while it runs. */
export type BoardInfo = { open: number; done: number; critiques: number; proposals?: number; votes?: number; findings?: number; judgements?: number };
/** The board's state in the space (BoardState entry): where the run is and what it has done. */
export type BoardState = { phase: "research" | "propose" | "vote" | "work"; created: number; done: number; critiques: number; proposals: number; votes: number; judgements: number; findings: number; improveLeft: number; merged: string[]; seq: number };

/** What the board needs from the hub; replaceable in tests. */
export type BoardDeps = {
	space: SpaceLike; session: string; blockId: string; runId: string; ttl: number;
	task: () => Task; agents: number; contenders: string[]; lang: "de" | "en";
	/** The model label critiques go to first (when an agent runs it); undefined: anyone. */
	criticModel?: string;
	/** How long a critique waits for the critic model before others may take it (ms). */
	criticWaitMs?: number;
	/** How long a text answer's judgement waits for an agent of another model than the author's (ms, default 5 min;
	 *  the hub passes CODEMODE_CROSS_WAIT_S).
	 *  Only then may the author's model judge it; the hub accepts such an answer only with a judge of another model. */
	crossWaitMs?: number;
	/** Improvement rounds after the first solution, per agent. */
	polish: number; maxItems: number; maxDepth: number;
	contribute: (c: { task: Task; lang: "de" | "en"; agent: number; gen: number; model?: string; role?: Role; target?: Attempt | null; others?: Attempt[]; rejected?: Attempt[]; notes?: Note[]; critique?: CritiqueRef; partner?: Attempt; plan?: PlanRef; earlier?: Earlier[]; findings?: Finding[] }) => Promise<{ source: string; model: string; note?: string; usage?: Usage }>;
	/** Text tasks: a judge checks an answer against the criteria. */
	judge?: (c: { task: Task; agent: number; answer: Attempt; model?: string }) => Promise<{ results: Array<{ criterion: string; pass: boolean; reason: string }>; model: string; usage?: Usage }>;
	/** Accepted results of earlier, similar tasks, as material for drafts and plans. */
	earlier?: () => Promise<Earlier[]>;
	/** The planning round (both, or none): propose an approach, rate proposals. */
	plan?: boolean;
	/** Research before the work (admin only): an agent searches the web and writes down what it found. */
	research?: (c: { task: Task; agent: number; model?: string; findings?: Finding[] }) => Promise<{ queries: string[]; sources: Array<{ title: string; url: string }>; text: string; model: string; usage?: Usage }>;
	propose?: (c: { task: Task; agent: number; notes?: Note[]; attempts?: Attempt[]; model?: string; earlier?: Earlier[]; findings?: Finding[] }) => Promise<{ text: string; model: string; usage?: Usage }>;
	vote?: (c: { task: Task; agent: number; proposals: Array<{ key: string; author: string; text: string }>; notes?: Note[]; model?: string }) => Promise<{ scores: Record<string, number>; text: string; model: string; usage?: Usage }>;
	critique: (c: { task: Task; agent: number; target: Attempt; others?: Attempt[]; notes?: Note[]; findings?: Finding[]; model?: string }) => Promise<{ text: string; model: string; usage?: Usage }>;
	/** Hands a contribution to the judges; resolves with its candidate id. */
	enqueue: (author: string, via: string, gen: number, source: string, lineage: { role: Role; basedOn?: string; partner?: string; critiqueId?: string; proposalId?: string; usage?: Usage }) => Promise<string>;
	/** A candidate's verdict if it is there (null while it is not; the hub nudges its judges then). */
	peek: (candidateId: string) => Promise<Attempt | null>;
	/** How long a follow-up waits for its verdict (ms). */
	verdictWaitMs: number;
	/** The block's attempts (closest first, with case results) and notes, as the agents see them. */
	board: () => Promise<{ attempts: Attempt[]; notes: Note[] }>;
	/** An agent's note, linked to its contribution. */
	note: (author: string, via: string, gen: number, text: string, candidateId: string) => Promise<void>;
	solved: () => boolean;
	/** A person stopped the run (the board is cleared). */
	stopped: () => boolean;
	/** The hub is closing (the board stays in the space and is resumed after the restart). */
	shutdown: () => boolean;
	/** Continue a board this run left in the space (after a restart) instead of starting one. */
	resume?: boolean;
	/** Books a call's usage; false once the run's budget is used up. */
	spend: (usage: Usage | undefined) => boolean;
	progress: (info: BoardInfo) => void;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Failed tries of an item before it is given up. */
const MAX_TRIES = 3;
/** A failure after which no model call of the run can succeed: the run ends as over budget. */
const FATAL = /daily model budget used up|model agents are off/i;
/** A failure that trying again will not mend (a model no longer allowed, the day's web searches used up, no results). */
const FINAL = /is not allowed|searches of the day|No search results|Web search refused/i;
/** The case calls an attempt passes. */
const passing = (a: Attempt) => new Set((a.cases ?? []).filter((c) => c.ok).map((c) => c.call));

export async function runBoard(d: BoardDeps): Promise<BoardEnd> {
	const itemsTmpl = { type: "WorkItem", fields: { session: d.session, runId: d.runId } };
	const stateTmpl = { type: "BoardState", fields: { session: d.session, runId: d.runId } };
	let busy = 0, capped = false, end: BoardEnd | null = null;
	const earlier = (await d.earlier?.().catch(() => [])) ?? [];
	const criticAt = d.criticModel && d.contenders.includes(d.criticModel) ? d.criticModel : undefined;
	const saved = d.resume ? ((await d.space.readIfExists(stateTmpl, NO_WAIT))?.fields as unknown as BoardState | undefined) : undefined;
	const st: BoardState = saved ? { ...saved, merged: [...(saved.merged ?? [])] } : { phase: "work", created: 0, done: 0, critiques: 0, proposals: 0, votes: 0, judgements: 0, findings: 0, improveLeft: d.polish * d.agents, merged: [], seq: 0 };
	const report = async () => d.progress({ open: await d.space.count(itemsTmpl), done: st.done, critiques: st.critiques, ...(d.plan ? { proposals: st.proposals, votes: st.votes } : {}), ...(isText(d.task()) ? { judgements: st.judgements } : {}), ...(d.research ? { findings: st.findings } : {}) });

	/** Several writes as one: all of them, or (after a crash in between) none. */
	const atomically = async <T>(fn: (txn: string) => Promise<T>): Promise<T> => {
		const t = await d.space.createTransaction(30_000);
		try { const v = await fn(t.id); await d.space.commit(t.id); return v; }
		catch (e) { await d.space.abort(t.id).catch(() => {}); throw e; }
	};
	/** A new item (not yet written); null at the item cap or below the depth limit. */
	const item = (kind: ItemKind, depth: number, more: Partial<WorkItem> = {}): WorkItem | null => {
		if (st.created >= d.maxItems) { capped = true; return null; } // no new work; what is open still gets done
		if (depth > d.maxDepth) return null;
		st.created++;
		return { session: d.session, blockId: d.blockId, runId: d.runId, itemId: `${d.runId}-${(st.seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`, kind, depth, ts: Date.now(), ...more };
	};
	const entry = (it: WorkItem) => ({ type: "WorkItem", fields: it as never });
	const spawn = async (kind: ItemKind, depth: number, more: Partial<WorkItem> = {}): Promise<void> => {
		const it = item(kind, depth, more);
		if (it) await d.space.write(entry(it), null, d.ttl);
	};

	// the state and the phase changes go one after the other: a change sees the state the one before it left
	let tail: Promise<unknown> = Promise.resolve();
	const serial = <T>(fn: () => Promise<T>): Promise<T> => { const w = tail.catch(() => {}).then(fn); tail = w; return w; };
	/** Replaces the BoardState entry, with the items of a phase change in the same transaction. */
	const save = (items: WorkItem[] = []) => atomically(async (txn) => {
		while (await d.space.take(stateTmpl, NO_WAIT, { txn }));
		await d.space.write({ type: "BoardState", fields: { session: d.session, runId: d.runId, blockId: d.blockId, ...st, ts: Date.now() } as never }, txn, d.ttl);
		for (const it of items) await d.space.write(entry(it), txn, d.ttl);
	});
	/** Items of a kind still to do (open or claimed). */
	const left = async (kind: ItemKind) => (await d.space.readAll(itemsTmpl, { limit: 500 })).filter((e) => (e.fields as unknown as WorkItem).kind === kind).length;

	/** The run's proposals with their average rating (null: no vote), best first. */
	const ranked = async (): Promise<Array<{ proposalId: string; author: string; via: string; text: string; score: number | null }>> => {
		const ps = (await d.space.readAll({ type: "CodeProposal", fields: { session: d.session, runId: d.runId } }, { limit: 50 })).map((e) => e.fields as { proposalId: string; author: string; via: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts);
		const vs = (await d.space.readAll({ type: "CodeVote", fields: { session: d.session, runId: d.runId } }, { limit: 50 })).map((e) => (e.fields as { scores: Record<string, number> }).scores);
		return ps.map((p) => { const got = vs.map((v) => v[p.proposalId]).filter((x): x is number => typeof x === "number"); return { ...p, score: got.length ? got.reduce((a, b) => a + b, 0) / got.length : null }; })
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	};
	/** The items that open a phase: a proposal and a vote per agent, or the implementations (of the best plans). */
	const opening = async (phase: BoardState["phase"]): Promise<WorkItem[]> => {
		if (phase === "propose") return Array.from({ length: d.agents }, (_, a) => item("propose", 0, { onlyBy: `agent-${a}` })).filter((x): x is WorkItem => !!x);
		if (phase === "vote") return Array.from({ length: d.agents }, (_, a) => item("vote", 0, { onlyBy: `agent-${a}` })).filter((x): x is WorkItem => !!x);
		const top = (await ranked()).slice(0, 2);
		return Array.from({ length: d.agents }, (_, a) => item("implement", 0, top.length ? { proposalId: top[a % top.length]!.proposalId } : {})).filter((x): x is WorkItem => !!x);
	};
	/** What comes after a phase: research → planning (or work), proposals → votes (with two proposals or more) → work. */
	const nextOf = async (phase: BoardState["phase"]): Promise<BoardState["phase"]> =>
		phase === "research" ? (d.plan && d.propose && d.vote ? "propose" : "work") : phase === "propose" ? ((await ranked()).length >= 2 ? "vote" : "work") : "work";
	/** When the last item of the current phase is done, the next phase begins: its items and the new state in one
	 *  transaction, so a crash leaves either the old phase or the new one, never half of it. */
	const advance = () => serial(async () => {
		const kind = ({ research: "research", propose: "propose", vote: "vote" } as const)[st.phase as "research" | "propose" | "vote"];
		if (!kind || (await left(kind)) > 0) return;
		const before = { ...st };
		st.phase = await nextOf(st.phase);
		try { await save(await opening(st.phase)); } catch (e) { Object.assign(st, before); throw e; }
	});

	/** The next item this agent may do (FIFO; never a critique of its own attempt, never a revision of its own
	 *  critique; a young critique waits for the critic model), claimed: taken and written back with the agent's name in
	 *  one transaction, so a crash in between cannot lose it. */
	const claim = async (me: string, model: string): Promise<WorkItem | null> => {
		const rows = (await d.space.readAll(itemsTmpl, { limit: 500 })).sort((a, b) => Number((a.fields as WorkItem).ts) - Number((b.fields as WorkItem).ts));
		const now = Date.now();
		for (const e of rows) {
			const it = e.fields as unknown as WorkItem;
			if (it.claimedBy || (it.notBefore ?? 0) > now) continue;
			if (it.notBy === me || it.notByAlso === me || (it.onlyBy && it.onlyBy !== me)) continue;
			if (it.kind === "judge" && it.crossOf === model && d.contenders.some((m) => m !== model) && now - it.ts < (d.crossWaitMs ?? 300_000)) continue;
			if (it.kind === "critique" && criticAt && model !== criticAt && now - it.ts < (d.criticWaitMs ?? 20_000)) continue;
			const got = await atomically(async (txn) => {
				if (!(await d.space.take({ id: e.id }, NO_WAIT, { txn }))) return false;
				await d.space.write(entry({ ...it, claimedBy: me }), txn, d.ttl);
				return true;
			}).catch(() => false);
			if (got) return it;
		}
		return null;
	};
	const claimedTmpl = (it: WorkItem, me: string) => ({ type: "WorkItem", fields: { session: d.session, runId: d.runId, itemId: it.itemId, claimedBy: me } });
	/** The work on an item is done: its claimed copy goes. */
	const release = async (it: WorkItem, me: string) => { await d.space.take(claimedTmpl(it, me), NO_WAIT); };
	/** An item goes back on the board, to be taken again a little later: a follow-up whose verdict is not there yet, or
	 *  work that failed (`more`: its try count and a longer wait). */
	const putBack = (it: WorkItem, me: string, more: Partial<WorkItem> = {}) => atomically(async (txn) => {
		if (!(await d.space.take(claimedTmpl(it, me), NO_WAIT, { txn }))) return;
		const { claimedBy: _c, ...open } = it;
		await d.space.write(entry({ ...open, notBefore: Date.now() + 1000, ...more }), txn, d.ttl);
	});

	/** What follows a verdict: a critique of the attempt (by someone else), and a merge when another failing attempt
	 *  passes other cases; once the task is solved, only as many improvement critiques as the rounds allow. */
	const followUp = async (a: Attempt | null, depth: number) => {
		if (!a || end) return; // no verdict in time, or one after the run ended: it starts nothing
		if (a.ok || d.solved()) { // a correct verdict counts as solved at once (the hub's best may lag a moment)
			if (a.ok && st.improveLeft > 0) { st.improveLeft--; await spawn("critique", depth + 1, { target: a.candidateId, notBy: a.author, improve: true }); }
			return;
		}
		await spawn("critique", depth + 1, { target: a.candidateId, notBy: a.author });
		const mine = passing(a);
		const { attempts } = await d.board();
		const partner = attempts.find((b) => !b.ok && !b.rejected && b.candidateId !== a.candidateId && [...passing(b)].some((call) => !mine.has(call)) && [...mine].some((call) => !passing(b).has(call)));
		const key = partner ? [a.candidateId, partner.candidateId].sort().join("+") : "";
		if (partner && !st.merged.includes(key)) { st.merged.push(key); await spawn("merge", depth + 1, { target: a.candidateId, partner: partner.candidateId }); }
	};

	const find = (attempts: Attempt[], id?: string) => attempts.find((x) => x.candidateId === id) ?? null;
	/** The block's research findings, the newest 20 first (earlier runs' findings on the same block count too). readAll
	 *  returns the oldest first, so the block's findings are read whole (the room keeps at most a few hundred) and cut
	 *  only after sorting. */
	const findings = async (): Promise<Finding[]> => (await d.space.readAll({ type: "CodeFinding", fields: { session: d.session, blockId: d.blockId } }, { limit: 1000 }))
		.map((e) => e.fields as unknown as Finding & { ts: number }).sort((a, b) => b.ts - a.ts).slice(0, 20);
	/** Whether an entry this item writes is there already (its work was done before a restart, the release was not). */
	const already = async (type: string, key: string, id: string) => !!(await d.space.readIfExists({ type, fields: { session: d.session, [key]: id } }, NO_WAIT));

	/** Does one item; "kept": a follow-up whose verdict has not come yet (it goes back on the board). */
	const execute = async (it: WorkItem, a: number): Promise<"kept" | void> => {
		const me = `agent-${a}`, model = d.contenders[a % d.contenders.length]!, task = d.task(), gen = it.depth + 1;
		if (it.kind === "followup") {
			const v = await d.peek(it.target!);
			if (!v && Date.now() < (it.deadline ?? 0)) return "kept";
			await followUp(v, it.depth);
			return;
		}
		const found = d.research ? await findings() : [];
		if (it.kind === "research") {
			if (await already("CodeFinding", "findingId", `${it.itemId}-f`)) return;
			const r = await d.research!({ task, agent: a, model, findings: found });
			if (!d.spend(r.usage)) return;
			await d.space.write({ type: "CodeFinding", fields: { session: d.session, blockId: d.blockId, runId: d.runId, findingId: `${it.itemId}-f`, author: me, via: r.model, queries: r.queries, sources: r.sources, text: r.text, ts: Date.now(), ...(r.usage ? { usage: r.usage } : {}) } as never }, null, d.ttl);
			st.findings++;
			return;
		}
		const { attempts, notes } = await d.board();
		if (it.kind === "judge") {
			const answer = find(attempts, it.target);
			if (!answer || !d.judge) return;
			const j = await d.judge({ task, agent: a, answer, model });
			if (!d.spend(j.usage)) return;
			const passed = j.results.filter((r) => r.pass).length;
			await d.space.write({ type: "TextJudgement", fields: { session: d.session, blockId: d.blockId, runId: d.runId, answerId: answer.candidateId, judge: me, via: j.model, results: j.results, passed, total: j.results.length, ts: Date.now(), ...(j.usage ? { usage: j.usage } : {}) } as never }, null, d.ttl);
			st.judgements++;
			// the second judgement comes from yet another agent (never the author, never this judge); when this judge ran
			// the author's model (none of another model came in time), the second one waits for another model too
			if (!it.notByAlso) await spawn("judge", it.depth, { target: answer.candidateId, notBy: answer.author, notByAlso: me, ...(j.model === answer.via ? { crossOf: answer.via } : {}), ...(it.improve ? { improve: true } : {}) });
			return;
		}
		if (it.kind === "propose") {
			if (await already("CodeProposal", "proposalId", `${it.itemId}-p`)) return;
			const c = await d.propose!({ task, agent: a, notes, attempts: attempts.slice(0, 3), model, earlier, ...(found.length ? { findings: found } : {}) });
			if (!d.spend(c.usage)) return;
			await d.space.write({ type: "CodeProposal", fields: { session: d.session, blockId: d.blockId, runId: d.runId, proposalId: `${it.itemId}-p`, author: me, via: c.model, text: c.text, ts: Date.now(), ...(c.usage ? { usage: c.usage } : {}) } as never }, null, d.ttl);
			st.proposals++;
			return;
		}
		if (it.kind === "vote") {
			if (await already("CodeVote", "voteId", `${it.itemId}-v`)) return;
			const others = (await ranked()).filter((p) => p.author !== me).sort((x, y) => x.proposalId.localeCompare(y.proposalId));
			if (!others.length) return;
			const keys = others.map((p, i) => ({ key: `P${i + 1}`, author: p.author, text: p.text, proposalId: p.proposalId }));
			const v = await d.vote!({ task, agent: a, proposals: keys, notes, model });
			if (!d.spend(v.usage)) return;
			const scores = Object.fromEntries(keys.filter((k) => v.scores[k.key] !== undefined).map((k) => [k.proposalId, v.scores[k.key]!]));
			await d.space.write({ type: "CodeVote", fields: { session: d.session, blockId: d.blockId, runId: d.runId, voteId: `${it.itemId}-v`, voter: me, via: v.model, scores, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, null, d.ttl);
			st.votes++;
			return;
		}
		const usable = attempts.filter((x) => !x.rejected), rejected = attempts.filter((x) => x.rejected).slice(0, 3);
		if (it.kind === "critique") {
			const target = find(attempts, it.target);
			const critiqueId = `${it.itemId}-c`;
			if (!target || (await already("CodeCritique", "critiqueId", critiqueId))) return;
			const c = await d.critique({ task, agent: a, target, others: usable.filter((x) => x !== target).slice(0, 2), notes, model, ...(found.length ? { findings: found } : {}) });
			if (!d.spend(c.usage)) return;
			await d.space.write({ type: "CodeCritique", fields: { session: d.session, blockId: d.blockId, runId: d.runId, critiqueId, target: target.candidateId, addressedTo: target.author, author: me, via: c.model, text: c.text, ts: Date.now(), ...(c.usage ? { usage: c.usage } : {}) } as never }, null, d.ttl);
			st.critiques++;
			await spawn("revise", it.depth + 1, { target: target.candidateId, critiqueId, notBy: me, ...(it.improve ? { improve: true } : {}) });
			return;
		}
		let role: Role = "explore", target: Attempt | null = null, partner: Attempt | undefined, critique: CritiqueRef | undefined;
		if (it.kind === "revise") {
			target = find(attempts, it.target);
			const row = (await d.space.readAll({ type: "CodeCritique", fields: { session: d.session, critiqueId: it.critiqueId ?? "" } }, { limit: 1 }))[0]?.fields as { author: string; via: string; text: string } | undefined;
			if (!target || !row) return;
			role = "revise"; critique = { author: row.author, via: row.via, text: row.text };
		} else if (it.kind === "merge") {
			target = find(attempts, it.target); partner = find(attempts, it.partner) ?? undefined;
			if (!target || !partner) return;
			role = "merge";
		} else if (d.solved()) { role = "improve"; target = usable.find((x) => x.ok) ?? null; }
		const chosen = it.proposalId ? (await ranked()).find((p) => p.proposalId === it.proposalId) : undefined;
		const plan: PlanRef | undefined = chosen ? { author: chosen.author, via: chosen.via, score: chosen.score, text: chosen.text } : undefined;
		const c = await d.contribute({ task, lang: d.lang, agent: a, gen: it.depth, model, role, target, others: usable.filter((x) => x !== target && x !== partner).slice(0, 3), rejected, notes, ...(critique ? { critique } : {}), ...(partner ? { partner } : {}), ...(plan ? { plan } : {}), ...(earlier.length && role === "explore" ? { earlier } : {}), ...(found.length ? { findings: found } : {}) });
		if (!d.spend(c.usage)) return;
		const candidateId = await d.enqueue(me, c.model, gen, c.source, { role, ...(target ? { basedOn: target.candidateId } : {}), ...(partner ? { partner: partner.candidateId } : {}), ...(it.critiqueId ? { critiqueId: it.critiqueId } : {}), ...(it.proposalId ? { proposalId: it.proposalId } : {}), ...(c.usage ? { usage: c.usage } : {}) });
		if (c.note) await d.note(me, c.model, gen, c.note, candidateId);
		// a text answer is judged on the board: the first judge from another model than the author where possible
		if (isText(task)) await spawn("judge", it.depth, { target: candidateId, notBy: me, crossOf: c.model, ...(it.improve ? { improve: true } : {}) });
		// the follow-ups come with the verdict: an item on the board waits for it, this agent goes on meanwhile
		await spawn("followup", it.depth, { target: candidateId, deadline: Date.now() + d.verdictWaitMs, ...(it.improve ? { improve: true } : {}) });
	};

	if (saved) {
		// after a restart: what was claimed is open again (its agent is gone), a follow-up waits anew for its verdict
		for (const e of await d.space.readAll(itemsTmpl, { limit: 500 })) {
			const it = e.fields as unknown as WorkItem;
			if (!it.claimedBy && it.kind !== "followup") continue;
			const { claimedBy: _c, notBefore: _n, ...open } = it;
			await atomically(async (txn) => {
				if (!(await d.space.take({ id: e.id }, NO_WAIT, { txn }))) return;
				await d.space.write(entry(it.kind === "followup" ? { ...open, deadline: Date.now() + d.verdictWaitMs } : open), txn, d.ttl);
			});
		}
		await advance(); // the last item of a phase may have been done just before the restart
	} else {
		// the first items: critiques of the closest attempts the block already has, the rest new approaches; on a fresh
		// task research first, or the planning round
		const { attempts } = await d.board();
		const open = attempts.filter((x) => !x.rejected).slice(0, Math.ceil(d.agents / 2));
		const first: WorkItem[] = [];
		const add = (x: WorkItem | null) => { if (x) first.push(x); };
		if (d.solved()) for (const x of attempts.filter((y) => y.ok && !y.rejected).slice(0, Math.min(d.agents, st.improveLeft))) { st.improveLeft--; add(item("critique", 0, { target: x.candidateId, notBy: x.author, improve: true })); }
		else if (open.length) { for (const x of open) add(item("critique", 0, { target: x.candidateId, notBy: x.author })); for (let i = open.length; i < d.agents; i++) add(item("implement", 0)); }
		else if (d.research) { st.phase = "research"; for (let a = 0; a < Math.max(1, Math.floor(d.agents / 2)); a++) add(item("research", 0, { onlyBy: `agent-${a}` })); }
		else if (d.plan && d.propose && d.vote) { st.phase = "propose"; first.push(...(await opening("propose"))); }
		else first.push(...(await opening("work")));
		await serial(() => save(first));
	}
	await report();

	const worker = async (a: number) => {
		const me = `agent-${a}`;
		while (!end) {
			if (d.shutdown()) { end = "shutdown"; break; }
			if (d.stopped()) { end = "stopped"; break; }
			const it = await claim(me, d.contenders[a % d.contenders.length]!);
			if (!it) {
				if (busy === 0 && (await d.space.count(itemsTmpl)) === 0) { end ??= d.solved() ? "solved" : capped ? "items" : "idle"; break; }
				await pause(300);
				continue;
			}
			// work towards a solution lapses once there is one (an answer in judging still gets its verdict, a contribution its follow-ups)
			if (d.solved() && !it.improve && it.kind !== "judge" && it.kind !== "followup") { await release(it, me).catch(() => {}); st.done++; continue; }
			busy++;
			let kept = false, failed: Error | null = null;
			try { kept = (await execute(it, a)) === "kept"; }
			catch (e) { failed = e as Error; if (!d.shutdown()) console.error("[board] item failed", it.kind, failed.message); }
			finally {
				// the agent counts as busy until the item is handed back and the next phase is on the board: otherwise the
				// others could see an empty board in between and end the run
				if (d.shutdown()) { busy--; break; } // the claimed copy stays: after the restart the item is open again
				const tries = (it.tries ?? 0) + 1;
				// a failed item is not done: after a fatal failure (the day's model calls used up) the run ends as over
				// budget; a passing one (a timeout, a refused call) is tried again later, at most MAX_TRIES times
				if (failed && FATAL.test(failed.message)) end ??= "budget";
				const retry = !!failed && !end && !FINAL.test(failed.message) && tries < MAX_TRIES;
				try {
					if (kept) await putBack(it, me);
					else if (retry) await putBack(it, me, { tries, notBefore: Date.now() + 2000 * tries });
					else {
						await release(it, me);
						if (it.kind !== "followup") st.done++;
						if (it.kind === "research" || it.kind === "propose" || it.kind === "vote") await advance();
						else await serial(() => save());
					}
				} catch (e) { console.error("[board] could not hand back an item", (e as Error).message); }
				busy--;
				await report().catch(() => {});
			}
			if (!d.spend(undefined)) end ??= "budget";
		}
	};
	await Promise.all(Array.from({ length: d.agents }, (_, a) => worker(a)));
	if (end === "shutdown" || d.shutdown()) return "shutdown"; // everything stays in the space for the restart
	// what is left on the board belongs to no run any more
	await tail.catch(() => {});
	while (await d.space.take(itemsTmpl, NO_WAIT));
	while (await d.space.take(stateTmpl, NO_WAIT));
	await report();
	return end ?? "idle";
}
