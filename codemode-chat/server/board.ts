// The work board: a run without generations. Open work items live in the space; every agent takes the next one it may
// do, does it, writes the result and the follow-up items (the Linda way: coordination only through the shared space).
//
//   implement  write a solution (a new approach, or an improvement once the task is solved)   -> verdict -> critique
//   critique   a teammate reads another's attempt and writes what is wrong and how to fix it  -> revise
//   revise     the attempt rewritten with that critique                                         -> verdict -> critique
//   merge      two failing attempts that pass different cases, combined                        -> verdict -> critique
//
// A critique is never written by the attempt's own author. The run ends when the task is solved and the improvement
// rounds are used, when the budget or the item cap is reached, on Stop, or when no work is left.
import { NO_WAIT, type SpaceLike } from "../../src/index.ts";
import type { Attempt, CritiqueRef, Note, Role, Usage } from "./llm.ts";
import type { Task } from "./tasks.ts";

export type ItemKind = "implement" | "critique" | "revise" | "merge";
/** `improve`: work on a solution (after the task is solved); other items lapse once it is solved. */
export type WorkItem = { session: string; blockId: string; runId: string; itemId: string; kind: ItemKind; depth: number; ts: number; target?: string; partner?: string; critiqueId?: string; notBy?: string; improve?: boolean };
/** How a board run ended. */
export type BoardEnd = "solved" | "budget" | "stopped" | "items" | "idle";
/** What the board shows while it runs. */
export type BoardInfo = { open: number; done: number; critiques: number };

/** What the board needs from the hub; replaceable in tests. */
export type BoardDeps = {
	space: SpaceLike; session: string; blockId: string; runId: string; ttl: number;
	task: () => Task; agents: number; contenders: string[]; lang: "de" | "en";
	/** Improvement rounds after the first solution, per agent. */
	polish: number; maxItems: number; maxDepth: number;
	contribute: (c: { task: Task; lang: "de" | "en"; agent: number; gen: number; model?: string; role?: Role; target?: Attempt | null; others?: Attempt[]; rejected?: Attempt[]; notes?: Note[]; critique?: CritiqueRef; partner?: Attempt }) => Promise<{ source: string; model: string; note?: string; usage?: Usage }>;
	critique: (c: { task: Task; agent: number; target: Attempt; others?: Attempt[]; notes?: Note[]; model?: string }) => Promise<{ text: string; model: string; usage?: Usage }>;
	/** Hands a contribution to the judges; resolves with its candidate id. */
	enqueue: (author: string, via: string, gen: number, source: string, lineage: { role: Role; basedOn?: string; partner?: string; critiqueId?: string; usage?: Usage }) => Promise<string>;
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
	let created = 0, done = 0, critiques = 0, busy = 0, seq = 0, capped = false, end: BoardEnd | null = null;
	let improveLeft = d.polish * d.agents; // improvement critiques once the task is solved
	const merged = new Set<string>();
	const report = async () => d.progress({ open: await d.space.count(itemsTmpl), done, critiques });

	const spawn = async (kind: ItemKind, depth: number, more: Partial<WorkItem> = {}): Promise<void> => {
		if (created >= d.maxItems) { capped = true; return; } // no new work; what is open still gets done
		if (depth > d.maxDepth) return;
		created++;
		const item: WorkItem = { session: d.session, blockId: d.blockId, runId: d.runId, itemId: `${d.runId}-${(seq++).toString(36)}`, kind, depth, ts: Date.now(), ...more };
		await d.space.write({ type: "WorkItem", fields: item as never }, null, d.ttl);
	};

	/** The next item this agent may do (FIFO; never a critique of its own attempt), taken out of the space. */
	const claim = async (me: string): Promise<WorkItem | null> => {
		const rows = (await d.space.readAll(itemsTmpl, { limit: 500 })).sort((a, b) => Number((a.fields as WorkItem).ts) - Number((b.fields as WorkItem).ts));
		for (const e of rows) {
			const it = e.fields as unknown as WorkItem;
			if (it.notBy === me) continue;
			if (await d.space.take({ id: e.id }, NO_WAIT)) return it;
		}
		return null;
	};

	/** What follows a verdict: a critique of the attempt (by someone else), and a merge when another failing attempt
	 *  passes other cases; once the task is solved, only as many improvement critiques as the rounds allow. */
	const followUp = async (a: Attempt | null, depth: number) => {
		if (!a) return;
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

	const execute = async (it: WorkItem, a: number): Promise<void> => {
		const me = `agent-${a}`, model = d.contenders[a % d.contenders.length]!, task = d.task(), gen = it.depth + 1;
		const { attempts, notes } = await d.board();
		const usable = attempts.filter((x) => !x.rejected), rejected = attempts.filter((x) => x.rejected).slice(0, 3);
		if (it.kind === "critique") {
			const target = find(attempts, it.target);
			if (!target) return;
			const c = await d.critique({ task, agent: a, target, others: usable.filter((x) => x !== target).slice(0, 2), notes, model });
			if (!d.spend(c.usage)) return;
			const critiqueId = `${it.itemId}-c`;
			await d.space.write({ type: "CodeCritique", fields: { session: d.session, blockId: d.blockId, runId: d.runId, critiqueId, target: target.candidateId, addressedTo: target.author, author: me, via: c.model, text: c.text, ts: Date.now(), ...(c.usage ? { usage: c.usage } : {}) } as never }, null, d.ttl);
			critiques++;
			await spawn("revise", it.depth + 1, { target: target.candidateId, critiqueId, ...(it.improve ? { improve: true } : {}) });
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
		const c = await d.contribute({ task, lang: d.lang, agent: a, gen: it.depth, model, role, target, others: usable.filter((x) => x !== target && x !== partner).slice(0, 3), rejected, notes, ...(critique ? { critique } : {}), ...(partner ? { partner } : {}) });
		if (!d.spend(c.usage)) return;
		const candidateId = await d.enqueue(me, c.model, gen, c.source, { role, ...(target ? { basedOn: target.candidateId } : {}), ...(partner ? { partner: partner.candidateId } : {}), ...(it.critiqueId ? { critiqueId: it.critiqueId } : {}), ...(c.usage ? { usage: c.usage } : {}) });
		if (c.note) await d.note(me, c.model, gen, c.note, candidateId);
		await followUp(await d.verdict(candidateId), it.depth);
	};

	// the first items: critiques of the closest attempts the block already has, the rest new approaches
	const { attempts } = await d.board();
	const open = attempts.filter((x) => !x.rejected).slice(0, Math.ceil(d.agents / 2));
	for (const x of d.solved() ? [] : open) await spawn("critique", 0, { target: x.candidateId, notBy: x.author });
	if (d.solved()) for (const x of attempts.filter((y) => y.ok && !y.rejected).slice(0, Math.min(d.agents, improveLeft))) { improveLeft--; await spawn("critique", 0, { target: x.candidateId, notBy: x.author, improve: true }); }
	else for (let i = open.length; i < d.agents; i++) await spawn("implement", 0);
	await report();

	const worker = async (a: number) => {
		const me = `agent-${a}`;
		while (!end) {
			if (d.stopped()) { end = "stopped"; break; }
			const it = await claim(me);
			if (!it) {
				if (busy === 0 && (await d.space.count(itemsTmpl)) === 0) { end ??= d.solved() ? "solved" : capped ? "items" : "idle"; break; }
				await pause(300);
				continue;
			}
			if (d.solved() && !it.improve) { done++; continue; } // work towards a solution lapses once there is one
			busy++;
			try { await execute(it, a); }
			catch (e) { console.error("[board] item failed", it.kind, (e as Error).message); }
			finally { busy--; done++; await report(); }
			if (!d.spend(undefined)) end ??= "budget";
		}
	};
	await Promise.all(Array.from({ length: d.agents }, (_, a) => worker(a)));
	// what is left on the board belongs to no run any more
	while (await d.space.take(itemsTmpl, NO_WAIT));
	await report();
	return end ?? "idle";
}
