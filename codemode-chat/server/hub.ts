// Chat sessions on one durable space. Everything that happens is an entry:
//   ChatMessage  people talking          CodeTask       one task block of a room (everything below belongs to a block)
//   CodeCandidate a contribution waiting CodeScore      the sandbox verdict, with the code (the visible contribution)
//   CodeBest     which verdict is a block's best code (one entry per block, replaced when beaten; the code is in the verdict)
//   CodeNote     an insight an agent leaves for the team, or a person's hint (`human`; agents follow it first)
//   CodeVeto     a person's "not like this" on a contribution: it no longer counts as correct, and agents avoid it
//   TextAnswer    an answer to a text task (no code, no sandbox); TextJudgement a judge's verdict per criterion
//   CodeAccept    a person's thumbs-up on an answer: accepted, and the run on its block ends
//   CodeRoom     marks a room that exists: only a new room starts with the first catalog task; one whose blocks were
//                all deleted stays empty
//   CodeEarlier  an accepted result kept as material for later, similar tasks (one per block, CODEMODE_EARLIER_DAYS):
//                the best code of a block, or its accepted answer; a person's acceptance counts in its own room only
// The space is the shared one of all processes (space-host.ts); this hub is the web process's view of it. Judges run in
// their own processes (judge-host.ts): they take a candidate under a transaction and write its score, and the block's
// best code, atomically, like the evolve example. Every score
// carries how many cases passed and what each case returned, so agents can build on attempts that got close: a run is
// teamwork (repair, explore, improve) that goes on until the task is solved, not a fixed number of tries.
import { randomBytes } from "node:crypto";
import { FOREVER, NO_WAIT, type SpaceLike } from "../../src/index.ts";
import { limitOf, maxTimeoutMs, plain, sandboxSlot, sourceProblem, testRule, type Codemode, type Verdict } from "./judge.ts";
import { archive, earlierLeaseMs, EARLIER_CAP, setBest, validMs } from "./results.ts";
import { endRun, readRun, startSpaceRun, type RunEntry, type RunInfo, type RunMode, type RunParams } from "./run.ts";
import { addNote, answersOf, bestOf, enqueueCandidate, isSolved, planTurn, rid, scoresOf, systemLine, taskEntries, vetoesOf, type Contribution } from "./room.ts";
import { customSpec, customTask, expectedOf, isText, taskById, taskFromSpec, TASKS, textSpec, textTask, type Task } from "./tasks.ts";
import { clipWords, NO_USAGE, type Attempt, type Note, type Role, type Usage } from "./llm.ts";
import { taskWaitMs } from "./limits.ts";
import { spentToday } from "./model-host.ts";
import type { TaskReady } from "./task-agent.ts";
import { lineDiff, shareOf, type LineDiff } from "./lineage.ts";
import { entryLeaseMs, HELD_WAIT_MS, readExisting, type ProcessInfo } from "./space.ts";
import type { WsConnection } from "./ws.ts";

const LIMITS = { agents: 8, gens: 10, perAgent: 3, polish: 3, boardDepth: 12, plans: 500, sessions: 50, messages: 500, contributions: 1000, blocks: 60, notes: 300 };
/** Code a snapshot carries at most, counted as encoded JSON (escapes included); the rest is fetched per contribution
 *  (`source()`), so a frame stays far below the 1 MiB WebSocket limit however many contributions a room holds. */
const SNAPSHOT_SOURCE_BYTES = 384 * 1024;
/** A snapshot above this size (counted as sent) goes out without any code at all. */
const SNAPSHOT_MAX_BYTES = 900 * 1024;
import { crossWaitMs, FATAL_LLM, ipTokensPerDay, runBudgetTokens } from "./limits.ts";
export { crossWaitMs, ipTokensPerDay, runBudgetTokens };
export { earlierLeaseMs };
export type { RunInfo, RunMode };
/** One step of a contribution's lineage (see lineage()). */
export type LineageStep = { candidateId: string; author: string; via: string; gen: number; ts: number; role?: Role; ok: boolean | null; ms?: number; passed?: number; total?: number;
	plan?: { author: string; via: string; text: string }; critique?: { author: string; via: string; text: string };
	from?: { candidateId: string; author: string }; diff?: LineDiff; partner?: { candidateId: string; author: string; share: number } };
/** One step in a block's trace: an agent researched, proposed, voted, wrote (a new approach, a revision, a merge, an
 *  improvement), critiqued (`to`: the author it addressed) or judged an answer (`ok`: every criterion met). */
export type TraceEvent = { t: number; agent: string; via: string; kind: "research" | "propose" | "vote" | "implement" | "revise" | "merge" | "improve" | "critique" | "judge"; ref?: string; to?: string; ok?: boolean | null };
export type { Contribution };
type Best = { candidateId: string; ms: number; source?: string; sourceOmitted?: true };
/** A room as this web process serves it. `task` and `blockId` (the active block) are read from the space on every
 *  access (session()), so they are a view of the space, not state of this process; the rest is this process's own:
 *  its WebSocket clients, the push timer, the per-minute request windows. */
type Session = {	id: string; task: Task; blockId: string; clients: Set<WsConnection>; buckets: Map<string, number[]>;
	pushTimer?: ReturnType<typeof setTimeout>; pushing: boolean; pushAgain: boolean; loading: Promise<void>; lastUsed: number;
	/** Serializes the operations that change the room's blocks or run (setTask, startRun, deleteBlock) and CodeBest. */
	tail: Promise<unknown>; bestTail: Promise<unknown>;
};

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);

export class CodeChatHub {
	/** The shared space of all processes (a RemoteSpace on the space host's socket). */
	readonly host: SpaceLike;
	readonly cm: Codemode;
	#sessions = new Map<string, Session>();
	#closed = false;
	/** Lease of every room entry (CODEMODE_TTL_HOURS). */
	readonly #ttl: number;
	constructor(space: SpaceLike, cm: Codemode, o: { ttlMs?: number } = {}) {
		this.#ttl = o.ttlMs ?? entryLeaseMs(); this.cm = cm; this.host = space;
		void this.#watch();
	}

	/** The revision the space is at now: any read of the change stream that is not refused names it. A revision before
	 *  the kept history is refused as expired, one beyond the stream as ahead, so a binary search finds one in between. */
	async #currentRev(): Promise<number> {
		let lo = 0, hi = 2 ** 48;
		while (lo <= hi && !this.#closed) {
			const at = lo === 0 ? 0 : Math.floor((lo + hi) / 2);
			try { return (await this.host.changes(at)).rev; }
			catch (e) {
				const m = (e as Error).message;
				if (/ahead/i.test(m)) hi = at - 1;
				else if (/no longer kept|expired|read the pages again/i.test(m)) lo = at + 1;
				else throw e;
			}
		}
		throw new Error("no revision of the change stream could be read");
	}

	/** Follows the space's change stream (a long poll): a change to a room's entries, made by any process (a judge's
	 *  verdict, another web process), pushes a fresh snapshot to the room's clients. A removal names no room, so it
	 *  pushes every watched room; the pushes are debounced. */
	async #watch(): Promise<void> {
		let rev = -1;
		while (!this.#closed) {
			try {
				if (rev < 0) { rev = await this.#currentRev(); for (const s of this.#sessions.values()) this.push(s); }
				const ch = await (this.host.changes as (r: number, o: { waitMs: number }) => ReturnType<SpaceLike["changes"]>)(rev, { waitMs: 20_000 });
				const rooms = new Set<string>();
				let removed = false;
				for (const b of ch.batches) for (const op of b.ops) {
					if (op.op === "del") removed = true;
					else if (typeof (op.fields as { session?: unknown }).session === "string") rooms.add((op.fields as { session: string }).session);
				}
				for (const s of this.#sessions.values()) if (s.clients.size && (removed || rooms.has(s.id))) this.push(s);
				rev = ch.next;
			} catch (e) {
				if (this.#closed) return;
				rev = -1; // history dropped, or the space restarted: start again from where it is now
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	/** Closes the hub. A run is not stopped by this: its CodeRun and board stay in the space and go on after the restart. */
	async close(): Promise<void> {
		this.#closed = true;
		for (const s of this.#sessions.values()) { for (const c of s.clients) c.close(); clearTimeout(s.pushTimer); }
		this.#sessions.clear();
	}

	/** Per-session sliding window: at most `max` events of kind `key` per minute. */
	allow(s: Session, key: string, max: number): boolean {
		const now = Date.now(), list = (s.buckets.get(key) ?? []).filter((t) => now - t < 60_000);
		if (list.length >= max) { s.buckets.set(key, list); return false; }
		list.push(now); s.buckets.set(key, list); return true;
	}

	/** Runs `fn` after every earlier exclusive operation of the room: checks and the state they guard cannot interleave. */
	#exclusive<T>(s: Session, fn: () => Promise<T>): Promise<T> {
		const work = s.tail.catch(() => {}).then(fn);
		s.tail = work;
		return work;
	}

	/** Drops the least recently used room that nobody watches and nothing runs in; its entries stay in the space. */
	#evictIdle(): void {
		let victim: Session | null = null;
		for (const s of this.#sessions.values()) {
			const idle = !s.clients.size && !s.pushTimer && !s.pushing;
			if (idle && (!victim || s.lastUsed < victim.lastUsed)) victim = s;
		}
		if (victim) this.#sessions.delete(victim.id);
	}

	async session(id: string): Promise<Session> {
		let s = this.#sessions.get(id);
		if (!s) {
			if (this.#sessions.size >= LIMITS.sessions) this.#evictIdle();
			if (this.#sessions.size >= LIMITS.sessions) throw new Error("Too many sessions");
			s = { id, task: TASKS[0]!, blockId: "", clients: new Set(), buckets: new Map(), pushing: false, pushAgain: false, loading: Promise.resolve(), lastUsed: Date.now(), tail: Promise.resolve(), bestTail: Promise.resolve() };
			this.#sessions.set(id, s);
			// every caller waits for the same load: a second request during the first load never sees a room without a block
			s.loading = this.#load(s);
		}
		s.lastUsed = Date.now();
		const first = s.loading;
		try { await first; } catch (e) { if (this.#sessions.get(id) === s) this.#sessions.delete(id); throw e; }
		// the active block as the space has it now (another web process may have opened or deleted one)
		const last = (await this.#taskEntries(id)).at(-1), task = last ? taskFromSpec(last) : null;
		if (last && task) { s.task = task; s.blockId = String(last.blockId ?? `t${last.ts}`); }
		else if (!last) { s.task = TASKS[0]!; s.blockId = ""; }
		return s;
	}

	async #load(s: Session): Promise<void> {
		const last = (await this.#taskEntries(s.id)).at(-1);
		const task = last ? taskFromSpec(last) : null;
		const known = !!(await this.host.readIfExists({ type: "CodeRoom", fields: { session: s.id } }, NO_WAIT));
		if (!known) await this.host.write({ type: "CodeRoom", fields: { session: s.id, ts: Date.now() } }, null, this.#ttl);
		if (last && task) { s.task = task; s.blockId = String(last.blockId ?? `t${last.ts}`); }
		else if (!known) await this.#openBlock(s, TASKS[0]!, false); // a new room starts with the first catalog task
		// work items of runs that are gone (no CodeRun: an item an agent held while the run was stopped comes back later)
		const runs = new Set((await this.host.readAll({ type: "CodeRun", fields: { session: s.id } }, { limit: 20 })).map((e) => String((e.fields as { runId?: unknown }).runId)));
		const gone = new Map<string, boolean>();
		for (const type of ["WorkItem"]) for (const e of await this.host.readAll({ type, fields: { session: s.id } }, { limit: 2000 })) {
			const runId = String((e.fields as { runId?: unknown }).runId);
			if (runs.has(runId)) continue;
			if (!gone.has(runId)) gone.set(runId, !(await readExisting(this.host, { type: "CodeRun", fields: { session: s.id, runId } }).catch(() => true))); // held for long: not gone
			if (gone.get(runId)) await this.host.take({ id: e.id }, NO_WAIT);
		}
	}

	#taskEntries(id: string): Promise<Array<Record<string, any>>> { return taskEntries(this.host, id); }

	/** All verdicts of a room, oldest first, with the people's vetoes merged in. */
	#scores(s: Session): Promise<Contribution[]> { return scoresOf(this.host, s.id); }

	/** What the model process says about the models (ModelInfo; renewed every 10 s while it runs). */
	async modelInfo(): Promise<{ info: { enabled: boolean; on: boolean; current: string | null; models: Array<{ id: string; label: string }> }; admin: { enabled: boolean; on: boolean; models: Array<{ label: string; provider: string; id: string; name: string }>; allowed: string[]; custom: boolean } }> {
		const f = (await this.host.readIfExists({ type: "ModelInfo" }, NO_WAIT))?.fields as { info?: unknown; admin?: unknown } | undefined;
		return f?.info && f.admin ? (f as never) : { info: { enabled: false, on: false, current: null, models: [] }, admin: { enabled: false, on: false, models: [], allowed: [], custom: false } };
	}

	/** The labels of the models a run may use (from the model process). */
	async #models(): Promise<string[]> {
		const { info } = await this.modelInfo();
		return info.enabled && info.on ? info.models.map((m) => m.label) : [];
	}

	/** The admin's choices as saved in the space (what the model process takes over within 10 s). */
	async adminChoice(): Promise<{ allowed?: string[]; custom?: boolean; on?: boolean }> {
		const m = (await this.host.readIfExists({ type: "CodeAdmin", fields: { key: "models" } }, NO_WAIT))?.fields as { allowed?: unknown } | undefined;
		const l = (await this.host.readIfExists({ type: "CodeAdmin", fields: { key: "llm" } }, NO_WAIT))?.fields as { on?: unknown } | undefined;
		return { ...(Array.isArray(m?.allowed) ? { allowed: m!.allowed.map(String), custom: true } : {}), ...(typeof l?.on === "boolean" ? { on: l.on } : {}) };
	}

	/** The admin's switch and default model, kept in the space for the model process (CodeAdmin "llm"). */
	async saveLlmChoice(o: { on?: unknown; model?: unknown }): Promise<void> {
		const cur = (await this.host.readIfExists({ type: "CodeAdmin", fields: { key: "llm" } }, NO_WAIT))?.fields as Record<string, unknown> | undefined;
		while (await this.host.take({ type: "CodeAdmin", fields: { key: "llm" } }, NO_WAIT));
		await this.host.write({ type: "CodeAdmin", fields: { key: "llm", ...(typeof (o.on ?? cur?.on) === "boolean" ? { on: (o.on ?? cur?.on) as boolean } : {}), ...(typeof (o.model ?? cur?.model) === "string" ? { model: (o.model ?? cur?.model) as string } : {}), ts: Date.now() } }, null, FOREVER);
	}

	/** The room's active run: the CodeRun the agent processes carry out (one an agent holds for a moment is waited for;
	 *  one held for longer throws StillHeld rather than pass for no run). */
	async #runNow(s: Session): Promise<RunInfo | null> {
		const r = (await readExisting(this.host, { type: "CodeRun", fields: { session: s.id } }))?.fields as unknown as RunEntry | undefined;
		return r ? { ...r.info, active: true } : null;
	}

	/** What the page shows as the room's run: the active one, else how the last one ended. */
	async #runShown(s: Session): Promise<RunInfo | null> {
		const now = await this.#runNow(s);
		if (now) return now;
		const done = (await this.host.readAll({ type: "CodeRunDone", fields: { session: s.id } }, { limit: 5 })).map((e) => e.fields as { info: RunInfo; ts: number }).sort((a, b) => b.ts - a.ts)[0];
		return done?.info ?? null;
	}

	#vetoes(s: Session): Promise<Map<string, { by: string; reason: string }>> { return vetoesOf(this.host, s.id); }

	/** A person's "not like this" (or its withdrawal) on a contribution: it no longer counts as correct or as the best
	 *  code, and agents see it as a rejected approach with the reason. */
	async veto(id: string, candidateId: string, o: { by?: unknown; reason?: unknown; undo?: unknown }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "veto", 30)) throw new Error("Too many vetoes, slow down");
		const f = await this.#contribution(s, candidateId);
		if (!f) throw new Error("Unknown contribution");
		const by = plain(clip(o.by, 40)).trim() || "guest", reason = plain(clip(o.reason, 200)).trim();
		const tmpl = { type: "CodeVeto", fields: { session: s.id, candidateId } };
		while (await this.host.take(tmpl, NO_WAIT));
		if (o.undo !== true) await this.host.write({ type: "CodeVeto", fields: { session: s.id, ...(typeof f.blockId === "string" ? { blockId: f.blockId } : {}), candidateId, by, reason, ts: Date.now() } }, null, this.#ttl);
		if (typeof f.blockId === "string") {
			if (typeof f.answerId === "string") await this.#refreshAnswer(s, f.blockId);
			else await this.#resetBest(s, f.blockId);
		}
		await this.#write(s, "system", o.undo === true ? `${by} withdrew the veto on ${String(f.author)}'s contribution` : `${by} rejected ${String(f.author)}'s contribution${reason ? `: ${reason}` : ""}`, typeof f.blockId === "string" ? f.blockId : undefined);
	}

	/** A block's best recomputed from its verdicts (after a veto), CodeBest and the archived result replaced to match. */
	#resetBest(s: Session, blockId = s.blockId): Promise<unknown> {
		const work = s.bestTail.catch(() => {}).then(async () => {
			const task = await this.#taskOf(s, blockId);
			if (!task) return;
			// recomputed and replaced in one transaction, coordinated with the judges through the CodeBest entry
			const t = await this.host.createTransaction(60_000);
			try {
				const best = bestOf((await this.#scores(s)).filter((c) => c.blockId === blockId));
				await setBest(this.host, t.id, s.id, blockId, task, this.#ttl, { replace: best });
				await this.host.commit(t.id);
			} catch (e) { await this.host.abort(t.id).catch(() => {}); throw e; }
		});
		s.bestTail = work;
		return work;
	}

	/** The task of a block of the room (null when the block is gone). */
	async #taskOf(s: Session, blockId: string): Promise<Task | null> {
		if (blockId === s.blockId) return s.task;
		const f = (await this.#taskEntries(s.id)).find((x) => String(x.blockId ?? `t${x.ts}`) === blockId);
		return f ? taskFromSpec(f) : null;
	}

	/** A text block's accepted answer recomputed (after a verdict, a thumbs-up, a veto), the archived result to match. */
	#refreshAnswer(s: Session, blockId: string): Promise<unknown> {
		const work = s.bestTail.catch(() => {}).then(async () => {
			const a = (await this.#answers(s.id, blockId)).find((x) => x.ok);
			const task = await this.#taskOf(s, blockId);
			if (task && isText(task)) await archive(this.host, null, s.id, blockId, task, a ? { result: a.source ?? "", by: a.acceptedBy === "human" ? "accepted by a person" : "accepted by the judges", human: a.acceptedBy === "human" } : null);
		});
		s.bestTail = work;
		return work;
	}

	/** Opens a new task block: from now on candidates, scores and the best code belong to it. */
	async #openBlock(s: Session, task: Task, announce: boolean, extra: Record<string, unknown> = {}): Promise<void> {
		const blockId = `b${Date.now().toString(36)}${rid()}`;
		await this.host.write({ type: "CodeTask", fields: { session: s.id, blockId, taskId: task.id, ts: Date.now(), ...(task.id === "custom" ? { custom: customSpec(task) } : {}), ...(isText(task) ? { text: textSpec(task) } : {}), ...extra } as never }, null, this.#ttl);
		s.task = task; s.blockId = blockId; // only once the block exists
		if (announce) await this.#write(s, "system", `Task: ${task.title.en} (${task.fn})`, s.blockId);
	}

	/** The room as the page shows it: the task blocks (each with its own contributions, best code and log) and free chat. */
	async snapshot(id: string) {
		const s = await this.session(id);
		// the run first: a run shown as ended was ended by a commit that also wrote its closing line, which the reads
		// below then see
		const shownRun = await this.#runShown(s);
		const cand = { type: "CodeCandidate", fields: { session: id } };
		const [entries, msgs, scores, pendingLocal, pendingRemote, noteRows, critiqueRows, proposalRows, voteRows, findingRows, judgementRows] = await Promise.all([
			this.#taskEntries(id),
			this.host.readAll({ type: "ChatMessage", fields: { session: id } }, { limit: LIMITS.messages + 5 }),
			this.#scores(s),
			this.host.readAll(cand, { limit: LIMITS.contributions }),
			this.host.readAll({ type: "CodeJudging", fields: { session: id } }, { limit: LIMITS.contributions }),
			this.host.readAll({ type: "CodeNote", fields: { session: id } }, { limit: LIMITS.notes + 5 }),
			this.host.readAll({ type: "CodeCritique", fields: { session: id } }, { limit: LIMITS.contributions }),
			this.host.readAll({ type: "CodeProposal", fields: { session: id } }, { limit: LIMITS.plans + LIMITS.agents }),
			this.host.readAll({ type: "CodeVote", fields: { session: id } }, { limit: LIMITS.plans + LIMITS.agents }),
			this.host.readAll({ type: "CodeFinding", fields: { session: id } }, { limit: LIMITS.plans + LIMITS.agents }),
			s.blockId ? this.host.readAll({ type: "TextJudgement", fields: { session: id, blockId: s.blockId } }, { limit: LIMITS.contributions * 2 }) : Promise.resolve([]),
		]);
		// the research of the runs: queries, sources and what the agents took from them (the text: active block only)
		const findings = findingRows.map((e) => e.fields as { blockId: string; findingId: string; author: string; via: string; queries: string[]; sources: Array<{ title: string; url: string }>; text: string; ts: number; usage?: Usage }).sort((a, b) => a.ts - b.ts);
		// the planning rounds: every proposal with its average rating; contributions name the plan they followed
		const voteScores = voteRows.map((e) => (e.fields as { scores?: Record<string, number> }).scores ?? {});
		const plans = proposalRows.map((e) => e.fields as { blockId: string; proposalId: string; author: string; via: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts).map((p) => {
			const got = voteScores.map((v) => v[p.proposalId]).filter((x): x is number => typeof x === "number");
			return { ...p, score: got.length ? Math.round((got.reduce((a, b) => a + b, 0) / got.length) * 10) / 10 : null, votes: got.length };
		});
		const planAuthor = new Map(plans.map((p) => [p.proposalId, p.author]));
		// who critiqued an attempt, and whose critique a revision followed (the texts come with details())
		const critiques = critiqueRows.map((e) => e.fields as { blockId: string; target: string; critiqueId: string; author: string; via: string; addressedTo?: string; ts: number });
		const critiquesOf = new Map<string, Array<{ author: string; via: string }>>();
		for (const c of critiques) critiquesOf.set(c.target, [...(critiquesOf.get(c.target) ?? []), { author: c.author, via: c.via }]);
		const critiqueAuthor = new Map(critiques.map((c) => [c.critiqueId, c.author]));
		const rejectedIds = new Set(scores.filter((c) => c.vetoed || c.hardcoded).map((c) => c.candidateId));
		const notes = noteRows.map((e) => e.fields as { blockId?: string; author: string; via: string; gen: number; text: string; ts: number; human?: boolean; candidateId?: string }).sort((a, b) => a.ts - b.ts);
		const messages = msgs.map((e) => e.fields as { author: string; text: string; ts: number; blockId?: string }).sort((a, b) => a.ts - b.ts);
		const judged = new Set(scores.map((c) => c.candidateId));
		// a waiting candidate carries its task spec (a custom task's cases): the page needs none of it
		const queued: Contribution[] = [...pendingLocal, ...pendingRemote].map((e) => { const { custom: _c, taskId: _t, session: _s, ...f } = e.fields as Record<string, unknown>; return { ...(f as unknown as Contribution), ok: null, ms: null }; }).filter((c) => !judged.has(c.candidateId));
		const all = [...scores, ...queued];
		// the code budget: the active block's best code first, then every block's best, then the newest contributions
		let budget = SNAPSHOT_SOURCE_BYTES;
		const keep = new Set<string>();
		const spend = (c: { candidateId: string; source?: string } | null) => {
			if (!c || keep.has(c.candidateId)) return;
			const n = Buffer.byteLength(JSON.stringify(c.source ?? ""));
			if (n <= budget) { budget -= n; keep.add(c.candidateId); }
		};
		// a text block's contributions are its answers (judged by agents, no code)
		const textBlocks = new Map<string, Contribution[]>();
		await Promise.all(entries.filter((f) => f.taskId === "text").map(async (f) => textBlocks.set(String(f.blockId ?? `t${f.ts}`), await this.#answers(id, String(f.blockId ?? `t${f.ts}`)))));
		const known = new Set<string>();
		const raw = entries.flatMap((f) => {
			const task = taskFromSpec(f);
			if (!task) return [];
			const blockId = String(f.blockId ?? `t${f.ts}`);
			known.add(blockId);
			// every agent note belongs to its contribution: linked by id, or (older notes) by agent, generation and model
			// at the nearest time; the contribution carries it as the description of its attempt
			const own = notes.filter((n) => n.blockId === blockId && !n.human);
			for (const n of own) {
				if (n.candidateId) continue;
				const match = all.filter((c) => c.blockId === blockId && c.author === n.author && c.gen === n.gen && c.via === n.via).sort((a, b) => Math.abs(a.ts - n.ts) - Math.abs(b.ts - n.ts))[0];
				if (match && Math.abs(match.ts - n.ts) < 300_000) n.candidateId = match.candidateId;
			}
			const noteOf = new Map(own.filter((n) => n.candidateId).map((n) => [n.candidateId!, n.text]));
			const contributions = (textBlocks.get(blockId) ?? all.filter((c) => c.blockId === blockId)).map((c) => ({
				...c, ...(noteOf.has(c.candidateId) ? { note: noteOf.get(c.candidateId)! } : {}),
				...(critiquesOf.has(c.candidateId) ? { critiques: critiquesOf.get(c.candidateId)!.map((x) => ({ ...x, text: "" })) } : {}),
				...(c.critiqueId && critiqueAuthor.has(c.critiqueId) ? { critiqueBy: critiqueAuthor.get(c.critiqueId)! } : {}),
				...(c.proposalId && planAuthor.has(c.proposalId) ? { planBy: planAuthor.get(c.proposalId)! } : {}),
			}));
			// what the block's model calls cost: every contribution, the research, plus the verifier agent's calls for its task
			const spent = [...contributions.map((c) => c.usage), ...findings.filter((x) => x.blockId === blockId).map((x) => x.usage), f.verifierUsage as Usage | undefined].reduce((a, u) => (u ? { tokens: a.tokens + (u.total ?? 0), costUsd: a.costUsd + (u.costUsd ?? 0) } : a), { tokens: 0, costUsd: 0 });
			return [{ f, task, blockId, contributions, best: isText(task) ? null : bestOf(contributions), spent }];
		});
		spend(raw.find((b) => b.blockId === s.blockId)?.best ?? null);
		for (const b of raw) spend(b.best);
		for (const c of [...all].sort((a, b) => b.ts - a.ts)) spend(c);
		/** The active block's trace: who did what when (research, plan, vote, write, critique, judge), the newest 300. */
		const traceOf = (blockId: string, contributions: Contribution[]): TraceEvent[] => {
			const ev: TraceEvent[] = [
				...findings.filter((x) => x.blockId === blockId).map((x) => ({ t: x.ts, agent: x.author, via: x.via, kind: "research" as const, ref: x.findingId })),
				...plans.filter((x) => x.blockId === blockId).map((x) => ({ t: x.ts, agent: x.author, via: x.via, kind: "propose" as const, ref: x.proposalId })),
				...voteRows.map((e) => e.fields as { blockId: string; voter: string; via: string; ts: number }).filter((x) => x.blockId === blockId).map((x) => ({ t: x.ts, agent: x.voter, via: x.via, kind: "vote" as const })),
				...critiques.filter((x) => x.blockId === blockId).map((x) => ({ t: x.ts, agent: x.author, via: x.via, kind: "critique" as const, ref: x.target, ...(x.addressedTo ? { to: x.addressedTo } : {}) })),
				...judgementRows.map((e) => e.fields as { answerId: string; judge: string; via: string; ts: number; passed: number; total: number }).map((x) => ({ t: x.ts, agent: x.judge, via: x.via, kind: "judge" as const, ref: x.answerId, ok: x.passed === x.total })),
				...contributions.filter((c) => c.author.startsWith("agent-")).map((c) => ({ t: c.ts, agent: c.author, via: c.via, kind: (c.role === "revise" || c.role === "merge" || c.role === "improve" ? c.role : "implement") as TraceEvent["kind"], ref: c.candidateId, ok: c.ok })),
			];
			return ev.filter((x) => Number.isFinite(x.t)).sort((a, b) => a.t - b.t).slice(-300);
		};
		const build = (withCode: boolean) => {
			// case results never ride along (details() has them); code within the budget does
			const slim = <T extends { candidateId: string; source?: string; cases?: unknown }>(c: T): T => { const { cases: _cases, ...rest } = c; return (withCode && keep.has(c.candidateId) ? rest : { ...rest, source: undefined, sourceOmitted: true }) as T; };
			const blocks = raw.map(({ f, task, blockId, contributions, best, spent }) => ({
				blockId, ts: f.ts as number, active: blockId === s.blockId,
				task: { id: task.id, fn: task.fn, title: task.title, prompt: task.prompt, cases: task.id === "custom" ? task.cases.length : undefined, ...(isText(task) ? { kind: "text", criteria: task.criteria, criteriaBy: task.criteriaBy } : {}), ...(task.check !== undefined ? { check: task.check, checkBy: task.checkBy ?? "user" } : {}), ...(task.id === "custom" ? { timeoutS: limitOf(task) / 1000 } : {}) },
				...(spent.tokens > 0 ? { usage: spent } : {}),
				contributions: contributions.map(slim), best: best ? slim<Best>(best) : null, messages: messages.filter((m) => m.blockId === blockId),
				// plan texts ride along for the active block only (and not in the code-less fallback); others come with plan()
				...(plans.some((p) => p.blockId === blockId) ? { plans: plans.filter((p) => p.blockId === blockId).slice(-8).map(({ proposalId, author, via, text, score, votes, ts }) => ({ proposalId, author, via, score, votes, ts, used: contributions.filter((c) => c.proposalId === proposalId).length, ...(withCode && blockId === s.blockId ? { text } : { text: "", textOmitted: true }) })) } : {}),
				...(blockId === s.blockId ? { trace: traceOf(blockId, contributions) } : {}),
				...(findings.some((x) => x.blockId === blockId) ? { findings: findings.filter((x) => x.blockId === blockId).slice(-6).map(({ findingId, author, via, queries, sources, text, ts }) => ({ findingId, author, via, queries, sources, ts, ...(withCode && blockId === s.blockId ? { text } : { text: "", textOmitted: true }) })) } : {}),
				notes: notes.filter((n) => n.blockId === blockId).slice(-20).map(({ author, via, gen, text, ts, human, candidateId }) => ({ author, via, gen, text, ts, ...(human ? { human: true } : {}), ...(candidateId ? { candidateId } : {}), ...(candidateId && rejectedIds.has(candidateId) ? { rejected: true } : {}) })),
			}));
			return {
				session: id, current: s.blockId, tasks: TASKS.map((t) => ({ id: t.id, title: t.title, fn: t.fn, prompt: t.prompt })),
				// what the time-limit field may offer (CODEMODE_MAX_TIMEOUT_S), and a visitor's token budget (default and most)
				limits: { maxTimeoutS: maxTimeoutMs() / 1000, ...(runBudgetTokens() ? { runBudgetTokens: runBudgetTokens() } : {}) },
				// the active custom task in full, so the page can fill its form again (after a reload) and continue it
				...(s.task.id === "custom" ? { currentCustom: { fn: s.task.fn, prompt: s.task.prompt.en, cases: s.task.cases } } : {}),
				blocks, messages: messages.filter((m) => !m.blockId || !known.has(m.blockId)), run: shownRun,
			};
		};
		// the budget bounds the code; the last word is the size of the frame as it is sent
		const full = build(true);
		return Buffer.byteLength(JSON.stringify(full)) <= SNAPSHOT_MAX_BYTES ? full : build(false);
	}

	/** The entry of one contribution (verdict, still waiting, or held by a judge right now); null when it is gone. */
	async #contribution(s: Session, candidateId: string): Promise<Record<string, unknown> | null> {
		const answer = (await this.host.readAll({ type: "TextAnswer", fields: { session: s.id, answerId: candidateId } }, { limit: 1 }))[0];
		if (answer) { const f = answer.fields as Record<string, unknown>; return { ...f, candidateId, source: f.text }; }
		for (const type of ["CodeScore", "CodeCandidate", "CodeJudging"]) {
			const e = (await this.host.readAll({ type, fields: { session: s.id, candidateId } }, { limit: 1 }))[0];
			if (e) return e.fields as Record<string, unknown>;
		}
		return null;
	}

	/** Keeps the room's plans and votes below the cap (the snapshot reads them all): the oldest give way. */
	async #trimPlans(s: Session): Promise<void> {
		for (const type of ["CodeProposal", "CodeVote", "CodeFinding"]) {
			const tmpl = { type, fields: { session: s.id } };
			const n = await this.host.count(tmpl);
			if (n <= LIMITS.plans - LIMITS.agents) continue;
			const rows = (await this.host.readAll(tmpl, { limit: n })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
			for (const e of rows.slice(0, n - (LIMITS.plans - LIMITS.agents))) await this.host.take({ id: e.id }, NO_WAIT);
		}
	}

	/** The text of one plan or research finding (the snapshot carries them for the active block only); null when it is gone. */
	async plan(id: string, proposalId: string): Promise<{ text: string } | null> {
		const s = await this.session(id);
		const e = (await this.host.readAll({ type: "CodeProposal", fields: { session: s.id, proposalId } }, { limit: 1 }))[0]
			?? (await this.host.readAll({ type: "CodeFinding", fields: { session: s.id, findingId: proposalId } }, { limit: 1 }))[0];
		return e ? { text: String((e.fields as { text?: unknown }).text ?? "") } : null;
	}

	/** The code of one contribution; null when it is gone. */
	async source(id: string, candidateId: string): Promise<string | null> {
		return (await this.details(id, candidateId))?.source ?? null;
	}

	/** Code, case results and lineage of one contribution (what the page shows when it is unfolded); null when gone. */
	async details(id: string, candidateId: string): Promise<{ source: string; cases: Verdict["cases"]; passed?: number; total?: number; role?: Role; basedOn?: string; critiques?: Array<{ author: string; via: string; text: string }>; followed?: { author: string; via: string; text: string }; judgements?: Array<{ judge: string; via: string; results: Array<{ criterion: string; pass: boolean; reason: string }> }> } | null> {
		const s = await this.session(id);
		const f = await this.#contribution(s, candidateId);
		if (!f) return null;
		// a text answer: the judges' findings per criterion are its "case results", every judgement comes along
		const view = typeof f.answerId === "string" ? (await this.#answers(s.id, String(f.blockId))).find((a) => a.candidateId === candidateId) : undefined;
		if (view) {
			f.cases = view.cases; f.passed = view.passed; f.total = view.total;
			f.judgements = (await this.host.readAll({ type: "TextJudgement", fields: { session: s.id, answerId: candidateId } }, { limit: 10 })).map((e) => { const j = e.fields as { judge: string; via: string; results: unknown }; return { judge: j.judge, via: j.via, results: j.results }; });
		}
		// the critiques of this attempt, and the one it was revised after
		const crit = (await this.host.readAll({ type: "CodeCritique", fields: { session: s.id, target: candidateId } }, { limit: 50 })).map((e) => e.fields as { author: string; via: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts);
		const followed = typeof f.critiqueId === "string" ? (await this.host.readAll({ type: "CodeCritique", fields: { session: s.id, critiqueId: f.critiqueId } }, { limit: 1 }))[0]?.fields as { author: string; via: string; text: string } | undefined : undefined;
		const num = (v: unknown) => (typeof v === "number" ? v : undefined);
		return {
			source: String(f.source ?? ""), cases: Array.isArray(f.cases) ? (f.cases as Verdict["cases"]) : [],
			...(num(f.passed) !== undefined ? { passed: num(f.passed) } : {}), ...(num(f.total) !== undefined ? { total: num(f.total) } : {}),
			...(typeof f.role === "string" ? { role: f.role as Role } : {}), ...(typeof f.basedOn === "string" ? { basedOn: f.basedOn } : {}),
			...(crit.length ? { critiques: crit.map(({ author, via, text }) => ({ author, via, text })) } : {}),
			...(followed ? { followed: { author: followed.author, via: followed.via, text: followed.text } } : {}),
			...(Array.isArray(f.judgements) ? { judgements: f.judgements as Array<{ judge: string; via: string; results: Array<{ criterion: string; pass: boolean; reason: string }> }> } : {}),
		};
	}

	/** How a contribution came about: it and the attempts it built on (`basedOn`, newest first, at most 8). Each step
	 *  names its author, model, role and verdict, the plan it followed, the critique it worked in, its merge partner, and
	 *  what it took from the step before (a line diff, the share of lines kept; for a merge also the partner's share). */
	async lineage(id: string, candidateId: string): Promise<{ steps: LineageStep[] } | null> {
		const s = await this.session(id);
		const steps: LineageStep[] = [];
		const answers = new Map<string, Contribution>();
		const verdictOf = async (f: Record<string, unknown>) => {
			if (typeof f.answerId !== "string") return f;
			const blockId = String(f.blockId);
			if (!answers.size) for (const a of await this.#answers(s.id, blockId)) answers.set(a.candidateId, a);
			const a = answers.get(String(f.answerId));
			return a ? { ...f, ok: a.ok, passed: a.passed, total: a.total } : f;
		};
		let f = await this.#contribution(s, candidateId);
		if (!f) return null;
		const seen = new Set<string>();
		while (f && steps.length < 8 && !seen.has(String(f.candidateId))) {
			seen.add(String(f.candidateId));
			const v = await verdictOf(f);
			const parent: Record<string, unknown> | null = typeof f.basedOn === "string" ? await this.#contribution(s, f.basedOn) : null;
			const partner = typeof f.partner === "string" ? await this.#contribution(s, f.partner) : null;
			const critique = typeof f.critiqueId === "string" ? (await this.host.readAll({ type: "CodeCritique", fields: { session: s.id, critiqueId: f.critiqueId } }, { limit: 1 }))[0]?.fields as { author: string; via: string; text: string } | undefined : undefined;
			const plan = typeof f.proposalId === "string" ? (await this.host.readAll({ type: "CodeProposal", fields: { session: s.id, proposalId: f.proposalId } }, { limit: 1 }))[0]?.fields as { author: string; via: string; text: string } | undefined : undefined;
			const source = String(f.source ?? "");
			const num = (x: unknown) => (typeof x === "number" ? x : undefined);
			steps.push({
				candidateId: String(f.candidateId), author: String(f.author ?? ""), via: String(f.via ?? ""), gen: num(f.gen) ?? 0, ts: num(f.ts) ?? 0,
				...(typeof f.role === "string" ? { role: f.role as Role } : {}),
				ok: typeof v.ok === "boolean" ? v.ok : null, ...(num(v.ms) !== undefined ? { ms: num(v.ms) } : {}), ...(num(v.passed) !== undefined ? { passed: num(v.passed) } : {}), ...(num(v.total) !== undefined ? { total: num(v.total) } : {}),
				...(plan ? { plan: { author: plan.author, via: plan.via, text: clipWords(plan.text, 600) } } : {}),
				...(critique ? { critique: { author: critique.author, via: critique.via, text: clipWords(critique.text, 900) } } : {}),
				...(parent ? { from: { candidateId: String(parent.candidateId), author: String(parent.author ?? "") }, diff: lineDiff(String(parent.source ?? ""), source) } : {}),
				...(partner ? { partner: { candidateId: String(partner.candidateId), author: String(partner.author ?? ""), share: shareOf(String(partner.source ?? ""), source) } } : {}),
			});
			f = parent;
		}
		return { steps };
	}

	/** What the ▶ of a contribution runs: its code and the task it was written for (the candidate names it, a verdict
	 *  through its block; an entry from before task blocks falls back to the room's task). Null when it is gone. */
	async execTarget(id: string, candidateId: string): Promise<{ source: string; task: Task } | null> {
		const s = await this.session(id);
		// a judge that just took the candidate writes its marker a moment later: look again for a little while
		let f = await this.#contribution(s, candidateId);
		for (let i = 0; !f && i < 10; i++) { await new Promise((r) => setTimeout(r, 150)); f = await this.#contribution(s, candidateId); }
		if (!f) return null;
		const block = f.blockId === undefined ? undefined : (await this.#taskEntries(id)).find((t) => String(t.blockId ?? `t${t.ts}`) === f.blockId);
		const task = (f.taskId !== undefined ? taskFromSpec(f) : null) ?? (block ? taskFromSpec(block) : null) ?? s.task;
		if (isText(task) || typeof f.answerId === "string") throw new Error("A text answer cannot be run");
		return { source: String(f.source ?? ""), task };
	}

	/** Push a fresh snapshot to every client of the session (debounced, so a burst of writes sends one frame). One
	 *  snapshot is built at a time, so frames never overtake each other; a push during a build sends one more after it. */
	push(s: Session): void {
		if (this.#closed || s.pushTimer || !s.clients.size) return;
		s.pushTimer = setTimeout(async () => {
			s.pushTimer = undefined;
			if (s.pushing) { s.pushAgain = true; return; }
			s.pushing = true;
			try {
				if (this.#closed || !s.clients.size) return;
				const frame = { type: "snapshot", ...(await this.snapshot(s.id)) };
				for (const c of s.clients) c.send(frame);
			} catch (e) {
				if (!this.#closed) console.error("[codemode] snapshot push failed", e);
			} finally {
				s.pushing = false;
				if (s.pushAgain) { s.pushAgain = false; this.push(s); }
			}
		}, 40);
	}

	async attach(id: string, ws: WsConnection): Promise<void> {
		const s = await this.session(id);
		s.clients.add(ws);
		ws.onClose(() => s.clients.delete(ws));
		ws.send({ type: "snapshot", ...(await this.snapshot(id)) });
	}

	/** A system line of the room; beyond the message cap the oldest lines give way, so the newest are never lost. */
	async #write(s: Session, author: string, text: string, blockId?: string): Promise<void> {
		const tmpl = { type: "ChatMessage", fields: { session: s.id } };
		if ((await this.host.count(tmpl)) >= LIMITS.messages) {
			const old = (await this.host.readAll(tmpl, { limit: LIMITS.messages + 5 })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
			for (const e of old.slice(0, old.length - LIMITS.messages + 1)) await this.host.take({ id: e.id }, NO_WAIT);
		}
		await this.host.write({ type: "ChatMessage", fields: { session: s.id, author, text, ts: Date.now(), ...(blockId ? { blockId } : {}) } }, null, this.#ttl);
		this.push(s);
	}

	/** Every call opens a new task block, also when the same task is chosen again. A custom task with `verify` (the
	 *  default) gets a check rule from the verifier agent, so other right results than the examples count too. */
	async setTask(id: string, o: { taskId?: string; custom?: { fn: string; prompt: string; cases: any; check?: string; verify?: boolean; timeoutS?: unknown }; text?: { prompt: unknown; criteria?: unknown };
		/** Who asks (set by the server): a visitor's calls for the rule or the criteria count against their address. */
		client?: { ip: string; admin: boolean } }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "task", 30)) throw new Error("Too many tasks, slow down");
		if (o.text) return this.#setTextTask(s, o.text, o.client);
		let task = o.custom ? customTask({ fn: clip(o.custom.fn, 41), prompt: clip(o.custom.prompt, 600), cases: o.custom.cases, timeoutS: o.custom.timeoutS, ...(typeof o.custom.check === "string" ? { check: o.custom.check } : {}) }) : taskById(String(o.taskId));
		if (!task) throw new Error("Unknown task");
		if (await this.#runNow(s)) throw new Error("A run is active; stop it first");
		// the active custom task once more with only another time limit: change it in place, the attempts stay
		const t = task;
		if (o.custom && s.task.id === "custom" && t.fn === s.task.fn && t.prompt.en === s.task.prompt.en && JSON.stringify(t.cases) === JSON.stringify(s.task.cases)) {
			if (limitOf(t) !== limitOf(s.task)) await this.#exclusive(s, () => this.#retime(s, limitOf(t)));
			this.push(s);
			return;
		}
		let verdict: string | null = null, usage = NO_USAGE;
		if (o.custom && task.check === undefined && o.custom.verify !== false && (await this.#models()).length) {
			const r = await this.#taskRequest(s, "verify", { taskId: "custom", custom: customSpec(task) }, o.client);
			task = (r.task ? taskFromSpec(r.task) : null) ?? task; verdict = r.verdict ?? null; usage = r.usage ?? NO_USAGE;
		}
		const verifierUsage = usage.total > 0 ? { verifierUsage: usage } : {};
		const chosen = task;
		await this.#exclusive(s, async () => {
			if (await this.#runNow(s)) throw new Error("A run is active; stop it first");
			if ((await this.#taskEntries(id)).length >= LIMITS.blocks) throw new Error("This room holds the maximum number of tasks");
			await this.#openBlock(s, chosen, true, verifierUsage);
			if (verdict) await this.#write(s, "system", verdict, s.blockId);
		});
		this.push(s);
	}

	/** The active block's time limit changed: its CodeTask is rewritten (same block, same time, same rule); candidates
	 *  from now on carry the new limit. */
	async #retime(s: Session, timeoutMs: number): Promise<void> {
		if (await this.#runNow(s)) throw new Error("A run is active; stop it first");
		const task = customTask({ ...customSpec(s.task), timeoutS: timeoutMs / 1000 });
		// taken and written back in one transaction: a judge that checks the block meanwhile waits instead of finding it gone
		const t = await this.host.createTransaction(30_000);
		try {
			const old = await this.host.takeIfExists({ type: "CodeTask", fields: { session: s.id, blockId: s.blockId } }, HELD_WAIT_MS, { txn: t.id });
			if (!old) throw new Error("Unknown task block");
			await this.host.write({ type: "CodeTask", fields: { ...(old.fields as Record<string, unknown>), custom: customSpec(task) } as never }, t.id, this.#ttl);
			await this.host.commit(t.id);
		} catch (e) { await this.host.abort(t.id).catch(() => {}); throw e; }
		s.task = task;
		await this.#write(s, "system", `Time limit per contribution: ${timeoutMs / 1000} s`, s.blockId);
	}

	/** A text task: the question and the criteria; without criteria the verifier agent writes them and three agents
	 *  review them (an agents process does it; shown in the block). */
	async #setTextTask(s: Session, spec: { prompt: unknown; criteria?: unknown }, client?: { ip: string; admin: boolean }): Promise<void> {
		let task = textTask(spec);
		if (await this.#runNow(s)) throw new Error("A run is active; stop it first");
		if (!(await this.#models()).length) throw new Error("Text tasks need model agents");
		let verdict: string | null = null, extra: Record<string, unknown> = {};
		if (!task.criteria?.length) {
			const r = await this.#taskRequest(s, "criteria", { taskId: "text", text: textSpec(task) }, client);
			const t = r.task ? taskFromSpec(r.task) : null;
			if (!r.ok || !t) throw new Error(r.error ?? "The criteria agent failed");
			task = t; verdict = r.verdict ?? null;
			if (r.usage?.total) extra = { verifierUsage: r.usage };
		}
		await this.#exclusive(s, async () => {
			if (await this.#runNow(s)) throw new Error("A run is active; stop it first");
			if ((await this.#taskEntries(s.id)).length >= LIMITS.blocks) throw new Error("This room holds the maximum number of tasks");
			await this.#openBlock(s, task, true, extra);
			if (verdict) await this.#write(s, "system", verdict, s.blockId);
		});
		this.push(s);
	}

	/** Asks the agents for their work on a new task (a check rule, criteria) and waits for the answer (TaskReady). The
	 *  request carries its deadline: the agent answers with what it has by then, so this wait outlasts its work. A
	 *  visitor whose day allowance is used up is refused before any call; their calls count against their address. */
	async #taskRequest(s: Session, kind: "verify" | "criteria", task: Record<string, unknown>, client?: { ip: string; admin: boolean }): Promise<TaskReady> {
		if (client && !client.admin && ipTokensPerDay() && (await spentToday(this.host, client.ip)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (CODEMODE_TOKENS_PER_IP_DAY); try again tomorrow");
		const requestId = `q${Date.now().toString(36)}${rid()}`, deadline = Date.now() + taskWaitMs();
		await this.host.write({ type: "TaskRequest", fields: { requestId, session: s.id, kind, task, deadline, ...(client ? { client: { ip: client.ip, admin: client.admin } } : {}), ts: Date.now() } as never }, null, taskWaitMs() + 120_000);
		const end = deadline + 60_000;
		for (let r = null as Awaited<ReturnType<SpaceLike["take"]>>; Date.now() < end; ) {
			r = await this.host.take({ type: "TaskReady", fields: { requestId } }, Math.min(20_000, Math.max(1, end - Date.now())));
			if (r) return r.fields as unknown as TaskReady;
		}
		await this.host.take({ type: "TaskRequest", fields: { requestId } }, NO_WAIT); // nobody took it: no agents process runs
		return { requestId, session: s.id, ok: false, error: "No agents process answered; is one running?", ts: Date.now() };
	}

	#answers(sessionId: string, blockId: string): Promise<Contribution[]> { return answersOf(this.host, sessionId, blockId); }

	/** A person's thumbs-up on an answer (or its withdrawal): accepted, the run on its block ends; the reason goes to the
	 *  agents as a hint. */
	async accept(id: string, answerId: string, o: { by?: unknown; reason?: unknown; undo?: unknown }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "accept", 30)) throw new Error("Too many accepts, slow down");
		const f = await this.#contribution(s, answerId);
		if (!f || typeof f.blockId !== "string" || !(await this.host.readIfExists({ type: "TextAnswer", fields: { session: s.id, answerId } }, NO_WAIT))) throw new Error("Unknown answer");
		const by = plain(clip(o.by, 40)).trim() || "guest", reason = plain(clip(o.reason, 300)).trim();
		while (await this.host.take({ type: "CodeAccept", fields: { session: s.id, answerId } }, NO_WAIT));
		if (o.undo !== true) {
			await this.host.write({ type: "CodeAccept", fields: { session: s.id, blockId: f.blockId, answerId, by, reason, ts: Date.now() } }, null, this.#ttl);
			if (reason) await this.#addNote(s, f.blockId, by, "human", 0, `Accepted ${String(f.author)}'s answer: ${reason}`, true);
			const run = (await readExisting(this.host, { type: "CodeRun", fields: { session: s.id } }))?.fields as unknown as RunEntry | undefined;
			if (run && run.blockId === f.blockId) {
				const t = await this.host.createTransaction(30_000);
				try { await endRun(this.host, t.id, this.#ttl, s.id, run.runId, "accepted", { ended: "accepted" }); await this.host.commit(t.id); }
				catch (err) { await this.host.abort(t.id).catch(() => {}); throw err; }
			}
		}
		await this.#refreshAnswer(s, f.blockId);
		await this.#write(s, "system", o.undo === true ? `${by} withdrew the acceptance of ${String(f.author)}'s answer` : `${by} accepted ${String(f.author)}'s answer${reason ? `: ${reason}` : ""}`, f.blockId);
	}

	/** A person hands in code; it is judged by the same sandbox as the agents' code. */
	async submitCode(id: string, author: string, source: string): Promise<string> {
		const s = await this.session(id);
		if (isText(s.task)) throw new Error("This block is a text task: answers come from the agents on the work board");
		if (!this.allow(s, "code", 20)) throw new Error("Too many submissions, slow down");
		const src = String(source ?? ""), problem = sourceProblem(src);
		if (problem) throw new Error(problem);
		return this.#enqueue(s, plain(clip(author, 40)).trim() || "guest", "human", 0, src);
	}

	async #enqueue(s: Session, author: string, via: string, gen: number, source: string, lineage: { role?: Role; basedOn?: string; partner?: string; critiqueId?: string; proposalId?: string; usage?: Usage } = {}): Promise<string> {
		if (!s.blockId) throw new Error("No task yet: create a task block first");
		// into the shared space: a judge process (here, on nano, anywhere) takes it
		const candidateId = await enqueueCandidate(this.host, null, this.#ttl, { session: s.id, blockId: s.blockId, taskId: s.task.id, author, via, gen, source, lineage });
		this.push(s);
		return candidateId;
	}

	/** What the test-system bar shows: every host with a running process of the chat (from their Process entries), the
	 *  roles it runs, its CPU and memory, and how many contributions its judges judged. */
	async systemInfo(): Promise<{ shards: Array<{ shard: string; up: boolean; roles: string[]; host: ProcessInfo; judged: number }> }> {
		const procs = (await this.host.readAll({ type: "Process" }, { limit: 200 })).map((e) => e.fields as unknown as ProcessInfo);
		const hosts = new Map<string, { host: ProcessInfo; roles: Set<string> }>();
		for (const p of procs.sort((a, b) => a.startedAt - b.startedAt)) {
			const h = hosts.get(p.name) ?? { host: p, roles: new Set<string>() };
			h.roles.add(p.role); hosts.set(p.name, h);
		}
		const order = ["space", "web", "judge", "agents", "model"];
		return { shards: await Promise.all([...hosts.values()].map(async ({ host, roles }) => ({ shard: host.name, up: true, roles: order.filter((r) => roles.has(r)), host, judged: await this.host.count({ type: "CodeScore", fields: { host: host.name } }) }))) };
	}

	/** Turn `k` of a generation (see planTurn in room.ts). */
	static plan(all: Attempt[], k: number) { return planTurn(all, k); }

	/** A note for the team of a block (an agent's insight, or a person's hint). */
	#addNote(s: Session, blockId: string, author: string, via: string, gen: number, text: string, human = false, candidateId?: string): Promise<void> {
		return addNote(this.host, null, this.#ttl, { session: s.id, blockId, author, via, gen, text, human, ...(candidateId ? { candidateId } : {}) });
	}

	/** A run on the active block, in one of two modes. Generations: each agent repairs, explores or improves with the
	 *  whole board in view, until the task is solved and `polish` more generations improved it, or `gens` generations
	 *  are used up. Board (`board: true`, model agents only): work items in the space (implement, critique, revise,
	 *  merge) that agents take as they are free; see run.ts. Both stop at the budget (`budgetTokens`, `budgetUsd`),
	 *  whichever is reached first. Model agents fall back to scripted variants when a guard says no (generations only). */
	async startRun(id: string, o: { agents?: number; gens?: number; perAgent?: number; polish?: number; mode?: RunMode; contenders?: string[]; models?: string[]; lang?: "de" | "en"; board?: boolean; plan?: boolean; budgetTokens?: unknown; budgetUsd?: unknown;
		/** Research with web search before the work (work board only); the server lets only an admin ask for it. */
		research?: boolean;
		/** Who asks (set by the server, never from the request body): a visitor's run gets the default budget at most and
		 *  counts against the day's allowance of their address. Without it (tests, scripts in-process) it counts as admin. */
		client?: { ip: string; admin: boolean } }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const int = (v: unknown, dflt: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v ?? dflt)) || (min > 0 ? min : 0)));
		const agents = int(o.agents, 4, 1, LIMITS.agents), gens = int(o.gens, 3, 1, LIMITS.gens), perAgent = int(o.perAgent, 1, 1, LIMITS.perAgent), polish = int(o.polish, 1, 0, LIMITS.polish);
		const positive = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined; };
		const visitor = o.client && !o.client.admin ? o.client : undefined;
		// a visitor's run never goes without a token limit, and never above the default one
		const cap = visitor ? runBudgetTokens() : 0;
		const tokens = positive(o.budgetTokens) ? Math.floor(positive(o.budgetTokens)!) : undefined;
		const budgetTokens = cap ? Math.min(tokens ?? cap, cap) : tokens;
		const budget = { ...(budgetTokens ? { tokens: budgetTokens } : {}), ...(positive(o.budgetUsd) ? { usd: positive(o.budgetUsd)! } : {}) };
		if (visitor && ipTokensPerDay() && (await spentToday(this.host, visitor.ip)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (CODEMODE_TOKENS_PER_IP_DAY); try again tomorrow");
		// contenders: "scripted" and/or allowed model labels; the older {mode, models} form still works
		const allowed = await this.#models();
		let contenders = Array.isArray(o.contenders) ? o.contenders.map(String) : o.mode === "llm" ? (Array.isArray(o.models) && o.models.length ? o.models.map(String) : allowed.slice(0, 1)) : ["scripted"];
		contenders = [...new Set(contenders)];
		if (!contenders.length || contenders.length > 4) throw new Error("Choose 1 to 4 contenders");
		for (const c of contenders) if (c !== "scripted" && !allowed.includes(c)) throw new Error(`Model not available: ${c}`);
		const board = o.board === true || isText(s.task); // a text task runs on the work board only
		if (board && contenders.includes("scripted")) throw new Error("The work board needs model agents (scripted agents cannot critique)");
		const mode: RunMode = contenders.some((c) => c !== "scripted") ? "llm" : "scripted";
		const research = o.research === true;
		if (research && !board) throw new Error("Research runs on the work board with model agents only");
		// checked and written under the room's lock and in one transaction: the CodeRun is unique per room, so of two
		// requests only one starts a run; the agent processes carry it out (model calls by the model process)
		const params: RunParams = { runId: `r${Date.now().toString(36)}${rid()}`, agents, gens, perAgent, polish, contenders, lang: o.lang === "de" ? "de" : "en", board, plan: board && o.plan !== false, research, budget, engine: "space", ...(o.client ? { client: { ip: o.client.ip, admin: o.client.admin } } : {}) };
		if (board) await this.#trimPlans(s); // a planning round adds up to one proposal and one vote per agent
		await this.#exclusive(s, async () => {
			if (await this.#runNow(s)) throw new Error("A run is already active");
			if (!s.blockId) throw new Error("No task yet: create a task block first");
			if (isText(s.task) && agents < 3) throw new Error("A text task needs at least 3 agents: an author and two judges who are not the author");
			if (contenders.includes("scripted") && s.task.variants.length === 0) throw new Error("This task has no scripted agents; use model agents or hand in code yourself");
			const solved = await isSolved(this.host, s.id, s.blockId, isText(s.task));
			const info: RunInfo = { active: true, blockId: s.blockId, mode, contenders, gen: 0, gens, agents, perAgent, polish, solvedGen: solved ? 0 : null, usage: { tokens: 0, costUsd: 0 }, ...(Object.keys(budget).length ? { budget } : {}), ...(research ? { research: true } : {}) };
			const limits = [budget.tokens ? `${budget.tokens} tokens` : "", budget.usd ? `$${budget.usd}` : ""].filter(Boolean).join(" / ");
			const line = board
				? `Run started on the work board${research ? " with web research" : ""}${params.plan ? `${research ? " and" : " with"} a planning round` : ""}: ${agents} agents, ${polish} improvement rounds after the solution${limits ? `, budget ${limits}` : ""} (${contenders.join(" + ")})`
				: `Run started: ${agents} agents, up to ${gens} generations, ${polish} more after the solution${limits ? `, budget ${limits}` : ""} (${contenders.join(" + ")})`;
			const t = await this.host.createTransaction(30_000);
			try {
				await startSpaceRun(this.host, t.id, this.#ttl, { session: s.id, runId: params.runId, blockId: s.blockId, params, info });
				await systemLine(this.host, t.id, this.#ttl, s.id, line, s.blockId);
				await this.host.commit(t.id);
			} catch (e) {
				await this.host.abort(t.id).catch(() => {});
				throw /unique/i.test((e as Error).message) ? new Error("A run is already active") : e;
			}
		});
		this.push(s);
	}

	/** Removes a task block with everything that belongs to it (here and on the shard). A running block cannot be deleted. */
	async deleteBlock(id: string, blockId: string): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "delete", 20)) throw new Error("Too many deletions, slow down");
		await this.#exclusive(s, () => this.#deleteBlock(s, blockId));
		this.push(s);
	}

	async #deleteBlock(s: Session, blockId: string): Promise<void> {
		const id = s.id;
		const entries = await this.#taskEntries(id);
		const target = entries.find((f) => String(f.blockId ?? `t${f.ts}`) === blockId);
		if (!target) throw new Error("Unknown task block");
		if ((await this.#runNow(s))?.blockId === blockId) throw new Error("This block has a running run; stop it first");
		// entries from before task blocks existed have no blockId: the block is then identified by the time of its CodeTask
		const legacy = target.blockId === undefined;
		const tmplOf = (type: string): { type: string; fields: Record<string, string | number> } => (type === "CodeTask" && legacy ? { type, fields: { session: id, ts: target.ts } } : { type, fields: { session: id, blockId } });
		// the task first: a judge checks it before it writes a verdict, so nothing new comes for this block meanwhile
		for (const type of ["CodeTask", "CodeScore", "CodeCandidate", "CodeJudging", "CodeBest", "CodeEarlier", "CodeNote", "CodeVeto", "CodeCritique", "CodeProposal", "CodeVote", "CodeFinding", "TextAnswer", "TextJudgement", "CodeAccept", "WorkItem", "CodeRunDone", "ChatMessage"])
			for (let n = 0; n < 2000 && (await this.host.take(tmplOf(type), NO_WAIT)); n++);
		// the last old-style block is gone: the old entries that never belonged to a block go with it
		if (legacy && !(await this.#taskEntries(id)).some((f) => f.blockId === undefined)) {
			for (const type of ["CodeScore", "CodeCandidate", "CodeBest", "ChatMessage"]) for (const e of await this.host.readAll({ type, fields: { session: id } }, { limit: LIMITS.contributions })) {
				const f = e.fields as Record<string, unknown>;
				if (f.blockId === undefined && (type !== "ChatMessage" || f.author === "system")) await this.host.take({ id: e.id }, NO_WAIT);
			}
		}
		if (s.blockId === blockId) { // the active block went away: the newest remaining one takes over, or the room is empty
			const left = (await this.#taskEntries(id)).at(-1);
			const task = left ? taskFromSpec(left) : null;
			if (left && task) { s.task = task; s.blockId = String(left.blockId ?? `t${left.ts}`); }
			else { s.task = TASKS[0]!; s.blockId = ""; }
		}
		// the block is simply gone (no log line); lines an older version wrote for deletions go too
		for (const e of await this.host.readAll({ type: "ChatMessage", fields: { session: id, author: "system" } }, { limit: LIMITS.messages + 5 })) {
			const f = e.fields as { text?: unknown; blockId?: unknown };
			if (f.blockId === undefined && typeof f.text === "string" && f.text.startsWith("Task block deleted")) await this.host.take({ id: e.id }, NO_WAIT);
		}
	}

	/** A person's hint to the team of a block: the agents of every later turn get it before their own notes. */
	async hint(id: string, o: { blockId?: unknown; text?: unknown; by?: unknown }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "hint", 20)) throw new Error("Too many hints, slow down");
		const text = plain(clip(o.text, 300)).trim(), by = plain(clip(o.by, 40)).trim() || "guest";
		if (!text) throw new Error("A hint needs some text");
		const blockId = typeof o.blockId === "string" && o.blockId ? o.blockId : s.blockId;
		if (!(await this.#taskEntries(id)).some((f) => String(f.blockId ?? `t${f.ts}`) === blockId)) throw new Error("Unknown task block");
		const run = await this.#runNow(s);
		await this.#addNote(s, blockId, by, "human", run?.blockId === blockId ? run.gen : 0, text, true);
		this.push(s);
	}

	/** The admin's choice of models, kept in the space (CodeAdmin) so it outlives a restart; null: the default choice. */
	async saveAllowedModels(labels: string[] | null): Promise<void> {
		while (await this.host.take({ type: "CodeAdmin", fields: { key: "models" } }, NO_WAIT));
		if (labels) await this.host.write({ type: "CodeAdmin", fields: { key: "models", allowed: labels, ts: Date.now() } }, null, FOREVER);
	}

	/** Stops the run; a reason goes to the agents as a person's hint (they learn what was not wanted). */
	async stopRun(id: string, o: { by?: unknown; reason?: unknown } = {}): Promise<void> {
		const s = await this.session(id);
		const reason = plain(clip(o.reason, 300)).trim();
		const run = await this.#runNow(s);
		if (reason && run) await this.#addNote(s, run.blockId, plain(clip(o.by, 40)).trim() || "guest", "human", 0, `Run stopped: ${reason}`, true);
		// whoever takes the run's CodeRun ends it, with its closing line, exactly once
		const e = await readExisting(this.host, { type: "CodeRun", fields: { session: s.id } });
		const runId = (e?.fields as { runId?: string } | undefined)?.runId;
		if (runId) {
			const t = await this.host.createTransaction(30_000);
			try { await endRun(this.host, t.id, this.#ttl, s.id, runId, "stopped"); await this.host.commit(t.id); }
			catch (err) { await this.host.abort(t.id).catch(() => {}); throw err; }
		}
		this.push(s);
	}
}
