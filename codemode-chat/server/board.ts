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
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import type { Attempt, CritiqueRef, Earlier, Finding, Note, PlanRef, Role, Usage } from "./llm.ts";
import { isText, type Task } from "./tasks.ts";

export type ItemKind = "research" | "propose" | "vote" | "implement" | "critique" | "revise" | "merge" | "judge";
/** `improve`: work on a solution (after the task is solved); other items lapse once it is solved. */
export type WorkItem = { session: string; blockId: string; runId: string; itemId: string; kind: ItemKind; depth: number; ts: number; target?: string; partner?: string; critiqueId?: string; notBy?: string; improve?: boolean;
	/** Planning round: the agent that must do it (every agent proposes and votes once); the plan an implement follows. */
	onlyBy?: string; proposalId?: string;
	/** judge: an agent that may not judge this answer (the first judge, for the second judgement); the author's model,
	 *  which the first judge should not run (another model judges first where one is there). */
	notByAlso?: string; crossOf?: string };
/** How a board run ended. */
export type BoardEnd = "solved" | "budget" | "stopped" | "items" | "idle";
/** What the board shows while it runs. */
export type BoardInfo = { open: number; done: number; critiques: number; proposals?: number; votes?: number; findings?: number };

/** What the board needs from the hub; replaceable in tests. */
export type BoardDeps = {
	space: SpaceLike; session: string; blockId: string; runId: string; ttl: number;
	task: () => Task; agents: number; contenders: string[]; lang: "de" | "en";
	/** The model label critiques go to first (when an agent runs it); undefined: anyone. */
	criticModel?: string;
	/** How long a critique waits for the critic model before others may take it (ms). */
	criticWaitMs?: number;
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
	/** Waits for a candidate's verdict (null when none came in time). */
	verdict: (candidateId: string) => Promise<Attempt | null>;
	/** The block's attempts (closest first, with case results) and notes, as the agents see them. */
	board: () => Promise<{ attempts: Attempt[]; notes: Note[] }>;
	/** An agent's note, linked to its contribution. */
	note: (author: string, via: string, gen: number, text: string, candidateId: string) => Promise<void>;
	solved: () => boolean;
	stopped: () => boolean;
	/** Books a call's usage; false once the run's budget is used up. */
	spend: (usage: Usage | undefined) => boolean;
	progress: (info: BoardInfo) => void;
};

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** The case calls an attempt passes. */
const passing = (a: Attempt) => new Set((a.cases ?? []).filter((c) => c.ok).map((c) => c.call));

export async function runBoard(d: BoardDeps): Promise<BoardEnd> {
	const itemsTmpl = { type: "WorkItem", fields: { session: d.session, runId: d.runId } };
	let created = 0, done = 0, critiques = 0, busy = 0, pending = 0, seq = 0, capped = false, end: BoardEnd | null = null;
	let proposals = 0, votes = 0, proposeLeft = 0, voteLeft = 0, judgements = 0, researchLeft = 0, findingsN = 0;
	const earlier = (await d.earlier?.().catch(() => [])) ?? [];
	const criticAt = d.criticModel && d.contenders.includes(d.criticModel) ? d.criticModel : undefined;
	let improveLeft = d.polish * d.agents; // improvement critiques once the task is solved
	const merged = new Set<string>();
	const report = async () => d.progress({ open: await d.space.count(itemsTmpl), done, critiques, ...(d.plan ? { proposals, votes } : {}), ...(isText(d.task()) ? { judgements } : {}), ...(d.research ? { findings: findingsN } : {}) });

	const spawn = async (kind: ItemKind, depth: number, more: Partial<WorkItem> = {}): Promise<void> => {
		if (created >= d.maxItems) { capped = true; return; } // no new work; what is open still gets done
		if (depth > d.maxDepth) return;
		created++;
		const item: WorkItem = { session: d.session, blockId: d.blockId, runId: d.runId, itemId: `${d.runId}-${(seq++).toString(36)}`, kind, depth, ts: Date.now(), ...more };
		await d.space.write({ type: "WorkItem", fields: item as never }, null, d.ttl);
	};

	/** The next item this agent may do (FIFO; never a critique of its own attempt, never a revision of its own
	 *  critique; a young critique waits for the critic model), taken out of the space. */
	const claim = async (me: string, model: string): Promise<WorkItem | null> => {
		const rows = (await d.space.readAll(itemsTmpl, { limit: 500 })).sort((a, b) => Number((a.fields as WorkItem).ts) - Number((b.fields as WorkItem).ts));
		for (const e of rows) {
			const it = e.fields as unknown as WorkItem;
			if (it.notBy === me || it.notByAlso === me || (it.onlyBy && it.onlyBy !== me)) continue;
			if (it.kind === "judge" && it.crossOf === model && d.contenders.some((m) => m !== model) && Date.now() - it.ts < (d.criticWaitMs ?? 20_000)) continue;
			if (it.kind === "critique" && criticAt && model !== criticAt && Date.now() - it.ts < (d.criticWaitMs ?? 20_000)) continue;
			if (await d.space.take({ id: e.id }, NO_WAIT)) return it;
		}
		return null;
	};

	/** What follows a verdict: a critique of the attempt (by someone else), and a merge when another failing attempt
	 *  passes other cases; once the task is solved, only as many improvement critiques as the rounds allow. */
	const followUp = async (a: Attempt | null, depth: number) => {
		if (!a || end) return; // a verdict after the run ended starts nothing
		if (a.ok || d.solved()) { // a correct verdict counts as solved at once (the hub's best may lag a moment)
			if (a.ok && improveLeft > 0) { improveLeft--; await spawn("critique", depth + 1, { target: a.candidateId, notBy: a.author, improve: true }); }
			return;
		}
		await spawn("critique", depth + 1, { target: a.candidateId, notBy: a.author });
		if (a.ok) return;
		const mine = passing(a);
		const { attempts } = await d.board();
		const partner = attempts.find((b) => !b.ok && !b.rejected && b.candidateId !== a.candidateId && [...passing(b)].some((call) => !mine.has(call)) && [...mine].some((call) => !passing(b).has(call)));
		const key = partner ? [a.candidateId, partner.candidateId].sort().join("+") : "";
		if (partner && !merged.has(key)) { merged.add(key); await spawn("merge", depth + 1, { target: a.candidateId, partner: partner.candidateId }); }
	};

	const find = (attempts: Attempt[], id?: string) => attempts.find((x) => x.candidateId === id) ?? null;
	/** The block's research findings, newest first (earlier runs' findings on the same block count too). */
	const findings = async (): Promise<Finding[]> => (await d.space.readAll({ type: "CodeFinding", fields: { session: d.session, blockId: d.blockId } }, { limit: 20 }))
		.map((e) => e.fields as unknown as Finding & { ts: number }).sort((a, b) => b.ts - a.ts);

	/** The run's proposals with their average rating (null: no vote), best first. */
	const ranked = async (): Promise<Array<{ proposalId: string; author: string; via: string; text: string; score: number | null }>> => {
		const ps = (await d.space.readAll({ type: "CodeProposal", fields: { session: d.session, runId: d.runId } }, { limit: 50 })).map((e) => e.fields as { proposalId: string; author: string; via: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts);
		const vs = (await d.space.readAll({ type: "CodeVote", fields: { session: d.session, runId: d.runId } }, { limit: 50 })).map((e) => (e.fields as { scores: Record<string, number> }).scores);
		return ps.map((p) => { const got = vs.map((v) => v[p.proposalId]).filter((x): x is number => typeof x === "number"); return { ...p, score: got.length ? got.reduce((a, b) => a + b, 0) / got.length : null }; })
			.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
	};
	/** After the last proposal: every agent rates the others' (no vote with fewer than two). */
	const startVoting = async () => {
		const ps = await ranked();
		if (ps.length < 2) return startBuilding();
		voteLeft = d.agents;
		for (let a = 0; a < d.agents; a++) await spawn("vote", 0, { onlyBy: `agent-${a}` });
	};
	/** After the last vote: the agents implement the best one or two plans (in turn), or their own ideas without plans. */
	const startBuilding = async () => {
		const top = (await ranked()).slice(0, 2);
		for (let a = 0; a < d.agents; a++) await spawn("implement", 0, top.length ? { proposalId: top[a % top.length]!.proposalId } : {});
	};

	/** The work after research: the planning round when wanted, else the implementation. */
	const startWork = async () => {
		if (d.plan && d.propose && d.vote) { proposeLeft = d.agents; for (let a = 0; a < d.agents; a++) await spawn("propose", 0, { onlyBy: `agent-${a}` }); }
		else for (let i = 0; i < d.agents; i++) await spawn("implement", 0);
	};

	const execute = async (it: WorkItem, a: number): Promise<void> => {
		const me = `agent-${a}`, model = d.contenders[a % d.contenders.length]!, task = d.task(), gen = it.depth + 1;
		const found = d.research ? await findings() : [];
		if (it.kind === "research") {
			try {
				const r = await d.research!({ task, agent: a, model, findings: found });
				if (!d.spend(r.usage)) return;
				await d.space.write({ type: "CodeFinding", fields: { session: d.session, blockId: d.blockId, runId: d.runId, findingId: `${it.itemId}-f`, author: me, via: r.model, queries: r.queries, sources: r.sources, text: r.text, ts: Date.now(), ...(r.usage ? { usage: r.usage } : {}) } as never }, null, d.ttl);
				findingsN++;
			} finally { if (--researchLeft === 0) await startWork(); }
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
			judgements++;
			// the second judgement comes from yet another agent (never the author, never this judge)
			if (!it.notByAlso) await spawn("judge", it.depth, { target: answer.candidateId, notBy: answer.author, notByAlso: me, ...(it.improve ? { improve: true } : {}) });
			return;
		}
		if (it.kind === "propose") {
			try {
				const c = await d.propose!({ task, agent: a, notes, attempts: attempts.slice(0, 3), model, earlier, ...(found.length ? { findings: found } : {}) });
				if (!d.spend(c.usage)) return;
				await d.space.write({ type: "CodeProposal", fields: { session: d.session, blockId: d.blockId, runId: d.runId, proposalId: `${it.itemId}-p`, author: me, via: c.model, text: c.text, ts: Date.now(), ...(c.usage ? { usage: c.usage } : {}) } as never }, null, d.ttl);
				proposals++;
			} finally { if (--proposeLeft === 0) await startVoting(); }
			return;
		}
		if (it.kind === "vote") {
			try {
				const others = (await ranked()).filter((p) => p.author !== me).sort((x, y) => x.proposalId.localeCompare(y.proposalId));
				if (!others.length) return;
				const keys = others.map((p, i) => ({ key: `P${i + 1}`, author: p.author, text: p.text, proposalId: p.proposalId }));
				const v = await d.vote!({ task, agent: a, proposals: keys, notes, model });
				if (!d.spend(v.usage)) return;
				const scores = Object.fromEntries(keys.filter((k) => v.scores[k.key] !== undefined).map((k) => [k.proposalId, v.scores[k.key]!]));
				await d.space.write({ type: "CodeVote", fields: { session: d.session, blockId: d.blockId, runId: d.runId, voter: me, via: v.model, scores, text: v.text, ts: Date.now(), ...(v.usage ? { usage: v.usage } : {}) } as never }, null, d.ttl);
				votes++;
			} finally { if (--voteLeft === 0) await startBuilding(); }
			return;
		}
		const usable = attempts.filter((x) => !x.rejected), rejected = attempts.filter((x) => x.rejected).slice(0, 3);
		if (it.kind === "critique") {
			const target = find(attempts, it.target);
			if (!target) return;
			const c = await d.critique({ task, agent: a, target, others: usable.filter((x) => x !== target).slice(0, 2), notes, model, ...(found.length ? { findings: found } : {}) });
			if (!d.spend(c.usage)) return;
			const critiqueId = `${it.itemId}-c`;
			await d.space.write({ type: "CodeCritique", fields: { session: d.session, blockId: d.blockId, runId: d.runId, critiqueId, target: target.candidateId, addressedTo: target.author, author: me, via: c.model, text: c.text, ts: Date.now(), ...(c.usage ? { usage: c.usage } : {}) } as never }, null, d.ttl);
			critiques++;
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
		// the follow-ups come with the verdict; this agent goes on to the next item meanwhile
		pending++;
		void d.verdict(candidateId).then((v) => followUp(v, it.depth)).catch((e) => console.error("[board] follow-up failed", (e as Error).message)).finally(() => { pending--; void report(); });
	};

	// the first items: critiques of the closest attempts the block already has, the rest new approaches
	const { attempts } = await d.board();
	const open = attempts.filter((x) => !x.rejected).slice(0, Math.ceil(d.agents / 2));
	for (const x of d.solved() ? [] : open) await spawn("critique", 0, { target: x.candidateId, notBy: x.author });
	if (d.solved()) for (const x of attempts.filter((y) => y.ok && !y.rejected).slice(0, Math.min(d.agents, improveLeft))) { improveLeft--; await spawn("critique", 0, { target: x.candidateId, notBy: x.author, improve: true }); }
	else if (d.research && !open.length) { researchLeft = Math.max(1, Math.floor(d.agents / 2)); for (let a = 0; a < researchLeft; a++) await spawn("research", 0, { onlyBy: `agent-${a}` }); } // research first
	else if (d.plan && d.propose && d.vote && !open.length) await startWork(); // plan first
	else for (let i = open.length; i < d.agents; i++) await spawn("implement", 0);
	await report();

	const worker = async (a: number) => {
		const me = `agent-${a}`;
		while (!end) {
			if (d.stopped()) { end = "stopped"; break; }
			const it = await claim(me, d.contenders[a % d.contenders.length]!);
			if (!it) {
				if (busy === 0 && pending === 0 && (await d.space.count(itemsTmpl)) === 0) { end ??= d.solved() ? "solved" : capped ? "items" : "idle"; break; }
				await pause(300);
				continue;
			}
			if (d.solved() && !it.improve && it.kind !== "judge") { done++; continue; } // work towards a solution lapses once there is one (an answer in judging still gets its verdict)
			busy++;
			try { await execute(it, a); }
			catch (e) { console.error("[board] item failed", it.kind, (e as Error).message); }
			finally { busy--; done++; await report(); }
			if (!d.spend(undefined)) end ??= "budget";
		}
	};
	await Promise.all(Array.from({ length: d.agents }, (_, a) => worker(a)));
	// verdicts still on their way (after a stop or at the budget): their follow-ups are not wanted any more
	for (let i = 0; pending > 0 && i < 50; i++) await pause(100);
	// what is left on the board belongs to no run any more
	while (await d.space.take(itemsTmpl, NO_WAIT));
	await report();
	return end ?? "idle";
}
