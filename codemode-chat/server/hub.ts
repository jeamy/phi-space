// Chat sessions on one durable space. Everything that happens is an entry:
//   ChatMessage  people talking          CodeTask       one task block of a room (everything below belongs to a block)
//   CodeCandidate a contribution waiting CodeScore      the sandbox verdict, with the code (the visible contribution)
//   CodeBest     the best correct code of a block (one entry per block, replaced when beaten)
//   CodeNote     an insight an agent leaves for the team, or a person's hint (`human`; agents follow it first)
//   CodeVeto     a person's "not like this" on a contribution: it no longer counts as correct, and agents avoid it
//   CodeRoom     marks a room that exists: only a new room starts with the first catalog task; one whose blocks were
//                all deleted stays empty
// Judges take a candidate under a transaction and write its score atomically, like the evolve example. Every score
// carries how many cases passed and what each case returned, so agents can build on attempts that got close: a run is
// teamwork (repair, explore, improve) that goes on until the task is solved, not a fixed number of tries.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NO_WAIT, PhiSpaces, TransactionError, type SpaceHost, type SpaceLike } from "../../src/index.ts";
import { judgeInSlot, limitOf, MAX_SOURCE_CHARS, maxTimeoutMs, plain, sandboxSlot, testRule, TIMEOUT_MS, verdictFields, type Codemode, type Verdict } from "./judge.ts";
import { customSpec, customTask, expectedOf, taskById, taskFromSpec, TASKS, type Task } from "./tasks.ts";
import { addUsage, clipWords, llmContribution, llmCritique, llmModels, llmVerifier, NO_USAGE, type Attempt, type Note, type Role, type Usage } from "./llm.ts";
import { runBoard, type BoardEnd, type BoardInfo } from "./board.ts";
import { entryLeaseMs, hostFacts, type HostFacts } from "./shard.ts";
import type { WsConnection } from "./ws.ts";

const LIMITS = { agents: 8, gens: 10, perAgent: 3, polish: 3, boardDepth: 12, sessions: 50, messages: 500, contributions: 1000, blocks: 60, notes: 300 };
/** Code a snapshot carries at most, counted as encoded JSON (escapes included); the rest is fetched per contribution
 *  (`source()`), so a frame stays far below the 1 MiB WebSocket limit however many contributions a room holds. */
const SNAPSHOT_SOURCE_BYTES = 384 * 1024;
/** A snapshot above this size (counted as sent) goes out without any code at all. */
const SNAPSHOT_MAX_BYTES = 900 * 1024;
/** A candidate sent to the shard that has no verdict after this long is taken back and judged here. */
const REMOTE_GRACE_MS = 90_000;
export type RunMode = "scripted" | "llm";
/** The model side of a run; replaceable in tests. */
export type LlmApi = { models: () => Promise<string[]>; contribute: typeof llmContribution; verify?: typeof llmVerifier; critique?: typeof llmCritique };
/** `contenders`: "scripted" and/or model labels (`provider/id`); the agents are assigned to them in turn. */
/** `gens` is the most generations a run may take; it ends earlier once the task is solved and `polish` more
 *  generations improved the solution (`solvedGen`: the generation that solved it, 0 = solved before the run). */
export type RunInfo = { active: boolean; blockId: string; mode: RunMode; contenders: string[]; gen: number; gens: number; agents: number; perAgent: number; polish: number; solvedGen: number | null; note?: string; usage: { tokens: number; costUsd: number };
	/** The work board (instead of generations): open and done items, critiques written. */
	board?: BoardInfo;
	/** Limits of the run's model calls; whichever is reached first ends it. */
	budget?: { tokens?: number; usd?: number };
	/** Why the run ended (when not solved or stopped): the budget, the item cap, or no work left. */
	ended?: "budget" | "items" | "idle" };
/** `source` is left out of a snapshot when its byte budget is spent (`sourceOmitted`); `details()` returns it with the
 *  case results. `passed`/`total`: cases passed; `role`/`basedOn`: what an agent did and whose attempt it built on. */
export type Contribution = { candidateId: string; blockId?: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; passed?: number; total?: number; role?: Role; basedOn?: string; cases?: Verdict["cases"]; hardcoded?: true; note?: string; usage?: Usage; partner?: string; critiqueId?: string; critiques?: Array<{ author: string; via: string; text: string }>; critiqueBy?: string; vetoed?: { by: string; reason: string }; source?: string; sourceOmitted?: true; ts: number };
type Best = { candidateId: string; ms: number; source?: string; sourceOmitted?: true };
type Session = {	id: string; task: Task; blockId: string; clients: Set<WsConnection>; run: RunInfo | null; abort: boolean; draining: number; seq: number;
	best: { candidateId: string; ms: number; source: string } | null; deleted: Set<string>; buckets: Map<string, number[]>; remotePending: Map<string, { at: number; blockId?: string }>; poller?: ReturnType<typeof setInterval>; polling: boolean;
	pushTimer?: ReturnType<typeof setTimeout>; pushing: boolean; pushAgain: boolean; loading: Promise<void>; lastUsed: number;
	/** Serializes the operations that change the room's blocks or run (setTask, startRun, deleteBlock) and CodeBest. */
	tail: Promise<unknown>; bestTail: Promise<unknown>;
	/** Candidates this host's judges hold right now: taken under a transaction, so no read sees them until the verdict. */
	judging: Map<string, Record<string, unknown>>;
	/** Set by #kick: work may have arrived while the judges were finishing; they look once more before they stop. */
	rekick?: boolean;
};

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);
/** A verdict time that can stand in a ranking: finite and not negative (scores from the shard are data too). */
const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
/** Correct and not rejected by a person. */
const counts = (c: Contribution) => !!c.ok && !c.vetoed;
/** A contribution as the agents see it. */
const attemptOf = (c: Contribution): Attempt => ({ candidateId: c.candidateId, author: c.author, via: c.via, gen: c.gen, ok: counts(c), ms: c.ms, ...(c.vetoed ? { rejected: `rejected by ${c.vetoed.by}${c.vetoed.reason ? `: ${c.vetoed.reason}` : ""}` } : c.hardcoded ? { rejected: "rejected: it hard-codes the expected result instead of computing it" } : {}), passed: c.passed, total: c.total, error: c.error, cases: c.cases, source: c.source ?? "" });
/** The fastest contribution that counts (ties: the earlier one). */
const bestOf = (cs: Contribution[]): { candidateId: string; ms: number; source: string } | null => {
	const ok = cs.filter((c) => counts(c) && validMs(c.ms)).sort((a, b) => a.ms! - b.ms! || a.ts - b.ts)[0];
	return ok ? { candidateId: ok.candidateId, ms: ok.ms!, source: ok.source ?? "" } : null;
};
const rnd = () => Math.random();
/** How close an attempt got: correct first (fastest), then most cases passed, then the newest. */
const rejectedRank = (c: Contribution) => Number(!!c.vetoed || !!c.hardcoded);
const closeness = (a: Contribution, b: Contribution) => rejectedRank(a) - rejectedRank(b) || Number(counts(b)) - Number(counts(a)) || (counts(a) && counts(b) ? a.ms! - b.ms! : 0) || (b.passed ?? 0) / (b.total || 1) - (a.passed ?? 0) / (a.total || 1) || b.ts - a.ts;

export class CodeChatHub {
	readonly host: PhiSpaces;
	readonly h: SpaceHost;
	readonly cm: Codemode;
	#sessions = new Map<string, Session>();
	#closed = false;
	#roles = new Map<number, PhiSpaces>();
	readonly facts: HostFacts = hostFacts();
	#remote: SpaceLike | null;
	#remoteLabel: string | null;
	#remoteDownUntil = 0;
	#rr = 0;
	/** `remote`: the nano judge shard (optional); candidates alternate between this host and the shard. */
	readonly #llm: LlmApi;
	/** Lease of every room entry (CODEMODE_TTL_HOURS). */
	readonly #ttl: number;
	constructor(h: SpaceHost, cm: Codemode, o: { remote?: SpaceLike | null; remoteLabel?: string | null; llm?: LlmApi; ttlMs?: number } = {}) { this.#ttl = o.ttlMs ?? entryLeaseMs(); this.h = h; this.cm = cm; this.host = new PhiSpaces(h, ctx); this.#remote = o.remote ?? null; this.#remoteLabel = o.remoteLabel ?? null; this.#llm = o.llm ?? { models: llmModels, contribute: llmContribution, verify: llmVerifier, critique: llmCritique }; }

	/** A call to the shard: bounded in time, and a failure marks it down for 15 s so the UI never waits on it. */
	async #rcall<T>(fn: (r: SpaceLike) => Promise<T>): Promise<T | null> {
		if (!this.#remote || Date.now() < this.#remoteDownUntil) return null;
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			return await Promise.race([fn(this.#remote), new Promise<never>((_, no) => { timer = setTimeout(() => no(new Error("shard timeout")), 8_000); })]);
		} catch {
			this.#remoteDownUntil = Date.now() + 15_000;
			return null;
		} finally { clearTimeout(timer); }
	}
	get remoteUp(): boolean { return this.#remote !== null && Date.now() >= this.#remoteDownUntil; }

	#role(id: number): PhiSpaces {
		let r = this.#roles.get(id);
		if (!r) this.#roles.set(id, (r = new PhiSpaces(this.h, ctx, Date.now, undefined, id)));
		return r;
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const s of this.#sessions.values()) { s.abort = true; for (const c of s.clients) c.close(); clearTimeout(s.pushTimer); clearInterval(s.poller); }
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
			const idle = !s.clients.size && !s.run?.active && s.draining === 0 && !s.remotePending.size && !s.pushTimer && !s.pushing;
			if (idle && (!victim || s.lastUsed < victim.lastUsed)) victim = s;
		}
		if (victim) { clearInterval(victim.poller); this.#sessions.delete(victim.id); }
	}

	async session(id: string): Promise<Session> {
		let s = this.#sessions.get(id);
		if (!s) {
			if (this.#sessions.size >= LIMITS.sessions) this.#evictIdle();
			if (this.#sessions.size >= LIMITS.sessions) throw new Error("Too many sessions");
			s = { id, task: TASKS[0]!, blockId: "", clients: new Set(), run: null, abort: false, draining: 0, seq: 0, best: null, deleted: new Set(), buckets: new Map(), remotePending: new Map(), polling: false, pushing: false, pushAgain: false, loading: Promise.resolve(), lastUsed: Date.now(), tail: Promise.resolve(), bestTail: Promise.resolve(), judging: new Map() };
			this.#sessions.set(id, s);
			// every caller waits for the same load: a second request during the first load never sees a room without a block
			s.loading = this.#load(s);
		}
		s.lastUsed = Date.now();
		try { await s.loading; } catch (e) { if (this.#sessions.get(id) === s) this.#sessions.delete(id); throw e; }
		return s;
	}

	async #load(s: Session): Promise<void> {
		const last = (await this.#taskEntries(s.id)).at(-1);
		const task = last ? taskFromSpec(last) : null;
		const known = !!(await this.host.readIfExists({ type: "CodeRoom", fields: { session: s.id } }, NO_WAIT));
		if (!known) await this.host.write({ type: "CodeRoom", fields: { session: s.id, ts: Date.now() } }, null, this.#ttl);
		if (last && task) {
			s.task = task; s.blockId = String(last.blockId ?? `t${last.ts}`);
			s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
		} else if (!known) await this.#openBlock(s, TASKS[0]!, false); // a new room starts with the first catalog task
		this.#kick(s); // candidates left from before a restart are judged now, not when the next one arrives
		while (await this.host.take({ type: "WorkItem", fields: { session: s.id } }, NO_WAIT)); // a board run did not survive the restart
	}

	async #taskEntries(id: string): Promise<Array<Record<string, any>>> {
		return (await this.host.readAll({ type: "CodeTask", fields: { session: id } }, { limit: LIMITS.blocks + 5 })).map((e) => e.fields as Record<string, any>).sort((a, b) => a.ts - b.ts);
	}

	/** All verdicts of a room (this host and the shard), oldest first, with the people's vetoes merged in. */
	async #scores(s: Session): Promise<Contribution[]> {
		const tmpl = { type: "CodeScore", fields: { session: s.id } };
		const [local, remote, vetoes] = await Promise.all([this.host.readAll(tmpl, { limit: LIMITS.contributions }), this.#rcall((r) => r.readAll(tmpl, { limit: LIMITS.contributions })), this.#vetoes(s)]);
		return [...local, ...(remote ?? [])].map((e) => { const c = e.fields as unknown as Contribution, v = vetoes.get(c.candidateId); return v ? { ...c, vetoed: v } : c; }).sort((a, b) => a.ts - b.ts);
	}

	async #vetoes(s: Session): Promise<Map<string, { by: string; reason: string }>> {
		const rows = await this.host.readAll({ type: "CodeVeto", fields: { session: s.id } }, { limit: LIMITS.contributions });
		return new Map(rows.map((e) => { const f = e.fields as { candidateId: string; by: string; reason: string }; return [f.candidateId, { by: f.by, reason: f.reason }]; }));
	}

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
		if (f.blockId === s.blockId) await this.#resetBest(s);
		await this.#write(s, "system", o.undo === true ? `${by} withdrew the veto on ${String(f.author)}'s contribution` : `${by} rejected ${String(f.author)}'s contribution${reason ? `: ${reason}` : ""}`, typeof f.blockId === "string" ? f.blockId : undefined);
	}

	/** The active block's best recomputed from its verdicts (after a veto), CodeBest replaced to match. */
	#resetBest(s: Session): Promise<unknown> {
		const work = s.bestTail.catch(() => {}).then(async () => {
			const blockId = s.blockId;
			s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === blockId));
			while (await this.host.take({ type: "CodeBest", fields: { session: s.id, blockId } }, NO_WAIT));
			if (s.best) await this.host.write({ type: "CodeBest", fields: { session: s.id, blockId, candidateId: s.best.candidateId, ms: s.best.ms, source: s.best.source } }, null, this.#ttl);
		});
		s.bestTail = work;
		return work;
	}

	/** Opens a new task block: from now on candidates, scores and the best code belong to it. */
	async #openBlock(s: Session, task: Task, announce: boolean, extra: Record<string, unknown> = {}): Promise<void> {
		const blockId = `b${Date.now().toString(36)}${(s.seq++).toString(36)}`;
		await this.host.write({ type: "CodeTask", fields: { session: s.id, blockId, taskId: task.id, ts: Date.now(), ...(task.id === "custom" ? { custom: customSpec(task) } : {}), ...extra } as never }, null, this.#ttl);
		s.task = task; s.best = null; s.blockId = blockId; // only once the block exists
		if (announce) await this.#write(s, "system", `Task: ${task.title.en} (${task.fn})`, s.blockId);
	}

	/** The room as the page shows it: the task blocks (each with its own contributions, best code and log) and free chat. */
	async snapshot(id: string) {
		const s = await this.session(id);
		const cand = { type: "CodeCandidate", fields: { session: id } };
		const [entries, msgs, scores, pendingLocal, pendingRemote, noteRows, critiqueRows] = await Promise.all([
			this.#taskEntries(id),
			this.host.readAll({ type: "ChatMessage", fields: { session: id } }, { limit: LIMITS.messages + 5 }),
			this.#scores(s),
			this.host.readAll(cand, { limit: LIMITS.contributions }),
			this.#rcall((r) => r.readAll(cand, { limit: LIMITS.contributions })),
			this.host.readAll({ type: "CodeNote", fields: { session: id } }, { limit: LIMITS.notes + 5 }),
			this.host.readAll({ type: "CodeCritique", fields: { session: id } }, { limit: LIMITS.contributions }),
		]);
		// who critiqued an attempt, and whose critique a revision followed (the texts come with details())
		const critiques = critiqueRows.map((e) => e.fields as { target: string; critiqueId: string; author: string; via: string });
		const critiquesOf = new Map<string, Array<{ author: string; via: string }>>();
		for (const c of critiques) critiquesOf.set(c.target, [...(critiquesOf.get(c.target) ?? []), { author: c.author, via: c.via }]);
		const critiqueAuthor = new Map(critiques.map((c) => [c.critiqueId, c.author]));
		const rejectedIds = new Set(scores.filter((c) => c.vetoed || c.hardcoded).map((c) => c.candidateId));
		const notes = noteRows.map((e) => e.fields as { blockId?: string; author: string; via: string; gen: number; text: string; ts: number; human?: boolean; candidateId?: string }).sort((a, b) => a.ts - b.ts);
		const messages = msgs.map((e) => e.fields as { author: string; text: string; ts: number; blockId?: string }).sort((a, b) => a.ts - b.ts);
		const judged = new Set(scores.map((c) => c.candidateId));
		// a waiting candidate carries its task spec (a custom task's cases): the page needs none of it
		const queued: Contribution[] = [...pendingLocal, ...(pendingRemote ?? [])].map((e) => { const { custom: _c, taskId: _t, session: _s, ...f } = e.fields as Record<string, unknown>; return { ...(f as unknown as Contribution), ok: null, ms: null }; }).filter((c) => !judged.has(c.candidateId));
		const all = [...scores, ...queued];
		// the code budget: the active block's best code first, then every block's best, then the newest contributions
		let budget = SNAPSHOT_SOURCE_BYTES;
		const keep = new Set<string>();
		const spend = (c: { candidateId: string; source?: string } | null) => {
			if (!c || keep.has(c.candidateId)) return;
			const n = Buffer.byteLength(JSON.stringify(c.source ?? ""));
			if (n <= budget) { budget -= n; keep.add(c.candidateId); }
		};
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
			const contributions = all.filter((c) => c.blockId === blockId).map((c) => ({
				...c, ...(noteOf.has(c.candidateId) ? { note: noteOf.get(c.candidateId)! } : {}),
				...(critiquesOf.has(c.candidateId) ? { critiques: critiquesOf.get(c.candidateId)!.map((x) => ({ ...x, text: "" })) } : {}),
				...(c.critiqueId && critiqueAuthor.has(c.critiqueId) ? { critiqueBy: critiqueAuthor.get(c.critiqueId)! } : {}),
			}));
			// what the block's model calls cost: every contribution plus the verifier agent's calls for its task
			const spent = [...contributions.map((c) => c.usage), f.verifierUsage as Usage | undefined].reduce((a, u) => (u ? { tokens: a.tokens + (u.total ?? 0), costUsd: a.costUsd + (u.costUsd ?? 0) } : a), { tokens: 0, costUsd: 0 });
			return [{ f, task, blockId, contributions, best: bestOf(contributions), spent }];
		});
		spend(raw.find((b) => b.blockId === s.blockId)?.best ?? null);
		for (const b of raw) spend(b.best);
		for (const c of [...all].sort((a, b) => b.ts - a.ts)) spend(c);
		const build = (withCode: boolean) => {
			// case results never ride along (details() has them); code within the budget does
			const slim = <T extends { candidateId: string; source?: string; cases?: unknown }>(c: T): T => { const { cases: _cases, ...rest } = c; return (withCode && keep.has(c.candidateId) ? rest : { ...rest, source: undefined, sourceOmitted: true }) as T; };
			const blocks = raw.map(({ f, task, blockId, contributions, best, spent }) => ({
				blockId, ts: f.ts as number, active: blockId === s.blockId,
				task: { id: task.id, fn: task.fn, title: task.title, prompt: task.prompt, cases: task.id === "custom" ? task.cases.length : undefined, ...(task.check !== undefined ? { check: task.check, checkBy: task.checkBy ?? "user" } : {}), ...(task.id === "custom" ? { timeoutS: limitOf(task) / 1000 } : {}) },
				...(spent.tokens > 0 ? { usage: spent } : {}),
				contributions: contributions.map(slim), best: best ? slim<Best>(best) : null, messages: messages.filter((m) => m.blockId === blockId),
				notes: notes.filter((n) => n.blockId === blockId).slice(-20).map(({ author, via, gen, text, ts, human, candidateId }) => ({ author, via, gen, text, ts, ...(human ? { human: true } : {}), ...(candidateId ? { candidateId } : {}), ...(candidateId && rejectedIds.has(candidateId) ? { rejected: true } : {}) })),
			}));
			return {
				session: id, current: s.blockId, tasks: TASKS.map((t) => ({ id: t.id, title: t.title, fn: t.fn, prompt: t.prompt })),
				limits: { maxTimeoutS: maxTimeoutMs() / 1000 }, // what the time-limit field may offer (CODEMODE_MAX_TIMEOUT_S)
				// the active custom task in full, so the page can fill its form again (after a reload) and continue it
				...(s.task.id === "custom" ? { currentCustom: { fn: s.task.fn, prompt: s.task.prompt.en, cases: s.task.cases } } : {}),
				blocks, messages: messages.filter((m) => !m.blockId || !known.has(m.blockId)), run: s.run,
			};
		};
		// the budget bounds the code; the last word is the size of the frame as it is sent
		const full = build(true);
		return Buffer.byteLength(JSON.stringify(full)) <= SNAPSHOT_MAX_BYTES ? full : build(false);
	}

	/** The entry of one contribution (verdict or still waiting), here or on the shard; null when it is gone. */
	async #contribution(s: Session, candidateId: string): Promise<Record<string, unknown> | null> {
		const held = s.judging.get(candidateId);
		if (held) return held;
		for (const type of ["CodeScore", "CodeCandidate"]) {
			const tmpl = { type, fields: { session: s.id, candidateId } };
			const e = (await this.host.readAll(tmpl, { limit: 1 }))[0] ?? (await this.#rcall((r) => r.readAll(tmpl, { limit: 1 })))?.[0];
			if (e) return e.fields as Record<string, unknown>;
		}
		return null;
	}

	/** The code of one contribution; null when it is gone. */
	async source(id: string, candidateId: string): Promise<string | null> {
		return (await this.details(id, candidateId))?.source ?? null;
	}

	/** Code, case results and lineage of one contribution (what the page shows when it is unfolded); null when gone. */
	async details(id: string, candidateId: string): Promise<{ source: string; cases: Verdict["cases"]; passed?: number; total?: number; role?: Role; basedOn?: string; critiques?: Array<{ author: string; via: string; text: string }>; followed?: { author: string; via: string; text: string } } | null> {
		const s = await this.session(id);
		const f = await this.#contribution(s, candidateId);
		if (!f) return null;
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
		};
	}

	/** What the ▶ of a contribution runs: its code and the task it was written for (the candidate names it, a verdict
	 *  through its block; an entry from before task blocks falls back to the room's task). Null when it is gone. */
	async execTarget(id: string, candidateId: string): Promise<{ source: string; task: Task } | null> {
		const s = await this.session(id);
		const f = await this.#contribution(s, candidateId);
		if (!f) return null;
		const block = f.blockId === undefined ? undefined : (await this.#taskEntries(id)).find((t) => String(t.blockId ?? `t${t.ts}`) === f.blockId);
		const task = (f.taskId !== undefined ? taskFromSpec(f) : null) ?? (block ? taskFromSpec(block) : null) ?? s.task;
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
	async setTask(id: string, o: { taskId?: string; custom?: { fn: string; prompt: string; cases: any; check?: string; verify?: boolean; timeoutS?: unknown } }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "task", 30)) throw new Error("Too many tasks, slow down");
		let task = o.custom ? customTask({ fn: clip(o.custom.fn, 41), prompt: clip(o.custom.prompt, 600), cases: o.custom.cases, timeoutS: o.custom.timeoutS, ...(typeof o.custom.check === "string" ? { check: o.custom.check } : {}) }) : taskById(String(o.taskId));
		if (!task) throw new Error("Unknown task");
		if (s.run?.active) throw new Error("A run is active; stop it first");
		// the active custom task once more with only another time limit: change it in place, the attempts stay
		const t = task;
		if (o.custom && s.task.id === "custom" && t.fn === s.task.fn && t.prompt.en === s.task.prompt.en && JSON.stringify(t.cases) === JSON.stringify(s.task.cases)) {
			if (limitOf(t) !== limitOf(s.task)) await this.#exclusive(s, () => this.#retime(s, limitOf(t)));
			this.push(s);
			return;
		}
		let verdict: string | null = null, usage = NO_USAGE;
		if (o.custom && task.check === undefined && o.custom.verify !== false) ({ task, verdict, usage } = await this.#verify(task));
		const verifierUsage = usage.total > 0 ? { verifierUsage: usage } : {};
		const chosen = task;
		await this.#exclusive(s, async () => {
			if (s.run?.active) throw new Error("A run is active; stop it first");
			if ((await this.#taskEntries(id)).length >= LIMITS.blocks) throw new Error("This room holds the maximum number of tasks");
			await this.#openBlock(s, chosen, true, verifierUsage);
			if (verdict) await this.#write(s, "system", verdict, s.blockId);
		});
		this.push(s);
	}

	/** The active block's time limit changed: its CodeTask is rewritten (same block, same time, same rule); candidates
	 *  from now on carry the new limit. */
	async #retime(s: Session, timeoutMs: number): Promise<void> {
		if (s.run?.active) throw new Error("A run is active; stop it first");
		const old = await this.host.take({ type: "CodeTask", fields: { session: s.id, blockId: s.blockId } }, NO_WAIT);
		if (!old) throw new Error("Unknown task block");
		const task = customTask({ ...customSpec(s.task), timeoutS: timeoutMs / 1000 });
		await this.host.write({ type: "CodeTask", fields: { ...(old.fields as Record<string, unknown>), custom: customSpec(task) } as never }, null, this.#ttl);
		s.task = task;
		await this.#write(s, "system", `Time limit per contribution: ${timeoutMs / 1000} s`, s.blockId);
	}

	/** The verifier agent writes a check rule from the description and the examples; the rule must pass testRule (accept
	 *  every example result, reject obvious wrong ones) before it decides anything, else the agent tries again with the
	 *  reason (three tries). Without models, or when no rule passes, the examples stay the exact oracle. */
	async #verify(task: Task): Promise<{ task: Task; verdict: string | null; usage: Usage }> {
		const verify = this.#llm.verify;
		let usage = NO_USAGE; // what the verifier's calls cost, kept with the block
		if (!verify || !(await this.#llm.models()).length) return { task, verdict: null, usage };
		if (!task.cases.every((c) => expectedOf(c).length)) return { task, verdict: "No check rule: the verifier needs an expected result in every case", usage };
		let feedback: string | undefined;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				const r = await verify({ task, ...(feedback ? { feedback } : {}) });
				if (r.usage) usage = addUsage(usage, r.usage);
				const why = await sandboxSlot(() => testRule(this.cm, task, r.check, expectedOf));
				if (why === null) return { task: customTask({ ...customSpec(task), check: r.check, checkBy: "verifier" }), verdict: `Check rule written by the verifier agent (${r.model}): other right results count too`, usage };
				feedback = why;
			} catch (e) { feedback = plain((e as Error).message); if (/off|budget|not allowed/.test(feedback)) break; }
		}
		return { task, verdict: `No check rule (${feedback ?? "verifier failed"}): results must match the examples`, usage };
	}

	/** A person hands in code; it is judged by the same sandbox as the agents' code. */
	async submitCode(id: string, author: string, source: string): Promise<string> {
		const s = await this.session(id);
		if (!this.allow(s, "code", 20)) throw new Error("Too many submissions, slow down");
		const src = String(source ?? "");
		if (!src.trim() || src.length > MAX_SOURCE_CHARS) throw new Error(`Code must be 1 to ${MAX_SOURCE_CHARS} characters`);
		return this.#enqueue(s, plain(clip(author, 40)).trim() || "guest", "human", 0, src);
	}

	/** Contributions a room holds (verdicts and waiting candidates, here and on the shard). */
	async #contributionCount(s: Session): Promise<number> {
		const n = async (sp: SpaceLike) => (await sp.count({ type: "CodeScore", fields: { session: s.id } })) + (await sp.count({ type: "CodeCandidate", fields: { session: s.id } }));
		return (await n(this.host)) + ((await this.#rcall(n)) ?? 0);
	}

	async #enqueue(s: Session, author: string, via: string, gen: number, source: string, lineage: { role?: Role; basedOn?: string; partner?: string; critiqueId?: string; usage?: Usage } = {}): Promise<string> {
		if (!s.blockId) throw new Error("No task yet: create a task block first");
		// the cap keeps every read of the room (snapshot, ranking) complete: a read limit never cuts contributions off
		if ((await this.#contributionCount(s)) >= LIMITS.contributions) throw new Error("This room holds the maximum number of contributions; delete a task block");
		const candidateId = `${Date.now().toString(36)}-${s.seq++}`;
		const entry = { type: "CodeCandidate", fields: { session: s.id, blockId: s.blockId, taskId: s.task.id, ...(s.task.id === "custom" ? { custom: customSpec(s.task) } : {}), candidateId, author, via, gen, ...(lineage.role ? { role: lineage.role } : {}), ...(lineage.basedOn ? { basedOn: lineage.basedOn } : {}), ...(lineage.partner ? { partner: lineage.partner } : {}), ...(lineage.critiqueId ? { critiqueId: lineage.critiqueId } : {}), ...(lineage.usage ? { usage: lineage.usage } : {}), source, ts: Date.now() } } as never;
		// every second candidate goes to the nano shard when it is up; if its write fails the candidate is judged here
		if (this.#remote && this.remoteUp && this.#rr++ % 2 === 1) {
			const ok = await this.#rcall(async (r) => { await r.write(entry, null, this.#ttl); return true; });
			if (ok) { s.remotePending.set(candidateId, { at: Date.now(), blockId: s.blockId }); this.#watchRemote(s); this.push(s); return candidateId; }
		}
		await this.#role(100 + (s.seq % 8)).write(entry, null, this.#ttl);
		this.push(s);
		this.#kick(s);
		return candidateId;
	}

	/** Starts up to two judge loops; after close() an in-flight verdict may find the space gone, which is not an error. */
	#kick(s: Session): void {
		// a judge that just found nothing may be about to stop: it looks once more before it does (no stranded candidate)
		s.rekick = true;
		while (s.draining < 2 && !this.#closed) { s.draining++; void this.#drain(s, 200 + s.draining).catch((e) => { if (!this.#closed) console.error("[codemode] judge failed", e); }).finally(() => { s.draining--; this.push(s); }); }
	}

	/** Judge: take one candidate (transaction), run it in the sandbox, write the score and commit; repeat until none is
	 *  left. The sandbox slot is taken first, so the transaction's lease only covers the judging itself. */
	async #drain(s: Session, roleId: number): Promise<void> {
		const r = this.#role(roleId);
		while (!this.#closed) {
			const done = await sandboxSlot(async (): Promise<{ f: Contribution; v: Verdict } | null | "retry"> => {
				const t = await r.createTransaction(maxTimeoutMs() + 30_000); // the candidate's own limit is known only once it is taken
				let c;
				try { c = await r.take({ type: "CodeCandidate", fields: { session: s.id } }, NO_WAIT, { txn: t.id }); }
				catch (e) { await r.abort(t.id).catch(() => {}); throw e; }
				if (!c) { await r.abort(t.id); return null; }
				const f = c.fields as unknown as Contribution & { taskId?: string; custom?: unknown };
				s.judging.set(f.candidateId, c.fields as Record<string, unknown>);
				try {
					const gone = () => !!f.blockId && s.deleted.has(f.blockId);
					// the candidate names its own task (it may belong to an earlier block); one that names none cannot be judged
					const task = taskFromSpec(f);
					const v: Verdict | null = gone() ? null : task ? await judgeInSlot(this.cm, task, String(f.source ?? "")) : { ok: false, ms: TIMEOUT_MS, error: "unknown task", passed: 0, total: 0, cases: [] };
					try {
						// its block was deleted while it waited or while it was judged: consume it, write nothing
						if (v && !gone()) await r.write({ type: "CodeScore", fields: { session: s.id, blockId: f.blockId, candidateId: f.candidateId, author: f.author, via: f.via, host: this.facts.name, gen: f.gen, ...(f.role ? { role: f.role } : {}), ...(f.basedOn ? { basedOn: f.basedOn } : {}), ...(f.partner ? { partner: f.partner } : {}), ...(f.critiqueId ? { critiqueId: f.critiqueId } : {}), ...(f.usage ? { usage: f.usage } : {}), ...verdictFields(v), source: f.source, ts: f.ts } as never }, t.id, this.#ttl);
						await r.commit(t.id);
					} catch (e) {
						await r.abort(t.id).catch(() => {});
						if (!(e instanceof TransactionError)) throw e;
						return "retry";
					}
					return v && !gone() ? { f, v } : "retry";
				} finally { s.judging.delete(f.candidateId); }
			});
			if (done === null) { if (!s.rekick) return; s.rekick = false; continue; }
			if (done !== "retry" && done.v.ok) await this.#offerBest(s, done.f.blockId, done.f.candidateId, done.v.ms, String(done.f.source ?? ""));
			this.push(s);
		}
	}

	/** A correct verdict of the active block that beats its best replaces the block's CodeBest entry. */
	#offerBest(s: Session, blockId: string | undefined, candidateId: string, ms: number, source: string): Promise<unknown> {
		const work = s.bestTail.catch(() => {}).then(async () => {
			if (!validMs(ms) || blockId !== s.blockId || (s.best && ms >= s.best.ms)) return;
			if (await this.host.readIfExists({ type: "CodeVeto", fields: { session: s.id, candidateId } }, NO_WAIT)) return; // rejected by a person
			s.best = { candidateId, ms, source };
			while (await this.host.take({ type: "CodeBest", fields: { session: s.id, blockId } }, NO_WAIT));
			await this.host.write({ type: "CodeBest", fields: { session: s.id, blockId, candidateId, ms, source } }, null, this.#ttl);
		});
		s.bestTail = work;
		return work;
	}

	/** Candidates sent to the shard come back as CodeScore entries there: poll until each one has a verdict. One poll at
	 *  a time (a shard call may take seconds); a failing poll is logged, never thrown into the timer. */
	#watchRemote(s: Session): void {
		if (s.poller) return;
		s.poller = setInterval(() => {
			if (s.polling) return;
			if (!s.remotePending.size || this.#closed) { clearInterval(s.poller); s.poller = undefined; return; }
			s.polling = true;
			void this.#pollRemote(s).catch((e) => { if (!this.#closed) console.error("[codemode] shard poll failed", e); }).finally(() => { s.polling = false; });
		}, 400);
	}

	async #pollRemote(s: Session): Promise<void> {
		let changed = false;
		for (const [candidateId, p] of [...s.remotePending]) {
			if (this.#closed) return;
			const tmpl = { session: s.id, candidateId };
			const e = await this.#rcall((r) => r.readIfExists({ type: "CodeScore", fields: tmpl }, NO_WAIT));
			if (e) {
				s.remotePending.delete(candidateId); changed = true;
				const f = e.fields as unknown as Contribution;
				if (f.blockId && s.deleted.has(f.blockId)) { await this.#rcall((r) => r.take({ id: e.id }, NO_WAIT)); continue; } // judged after its block was deleted
				if (f.ok && validMs(f.ms)) await this.#offerBest(s, f.blockId, f.candidateId, f.ms, String(f.source ?? ""));
				continue;
			}
			if (Date.now() - p.at <= REMOTE_GRACE_MS) continue;
			// no verdict in time (the shard's judges may be stuck): take the candidate back and judge it here
			const back = await this.#rcall((r) => r.take({ type: "CodeCandidate", fields: tmpl }, NO_WAIT));
			if (back) await this.#role(100 + (s.seq % 8)).write({ type: "CodeCandidate", fields: back.fields } as never, null, this.#ttl);
			if (back || this.remoteUp) { s.remotePending.delete(candidateId); changed = true; } // shard down: ask again later
			if (back) this.#kick(s);
		}
		if (changed) this.push(s);
	}

	/** What the test-system bar shows: this host and, when configured, the shard (CPU, memory, judged contributions). */
	async systemInfo(): Promise<{ shards: Array<{ shard: string; up: boolean; host: HostFacts | null; judged: number | null }> }> {
		const shards: Array<{ shard: string; up: boolean; host: HostFacts | null; judged: number | null }> = [{ shard: "hub", up: true, host: this.facts, judged: await this.host.count({ type: "CodeScore" }) }];
		if (this.#remote) {
			const r = await this.#rcall(async (sp) => ({ host: (await sp.readAll({ type: "HostInfo" }, { limit: 1 }))[0]?.fields as unknown as HostFacts | undefined, judged: await sp.count({ type: "CodeScore" }) }));
			shards.push({ shard: this.#remoteLabel ?? "nano", up: r !== null, host: r?.host ?? null, judged: r?.judged ?? null });
		}
		return { shards };
	}

	async #idle(s: Session): Promise<void> {
		while (!this.#closed && !s.abort && (s.draining > 0 || s.remotePending.size > 0 || (await this.host.count({ type: "CodeCandidate", fields: { session: s.id } })) > 0)) await new Promise((r) => setTimeout(r, 60));
	}

	/** What the team knows about a block: every judged attempt (with its case results) and the newest notes. */
	async #board(s: Session, blockId: string): Promise<{ attempts: Attempt[]; notes: Note[] }> {
		const scores = (await this.#scores(s)).filter((c) => c.blockId === blockId).sort(closeness);
		// an agent's note whose contribution was rejected (hard-coded, or a person's veto) is advice not to pass on
		const rejected = new Set(scores.filter((c) => c.vetoed || c.hardcoded).map((c) => c.candidateId));
		const rows = (await this.host.readAll({ type: "CodeNote", fields: { session: s.id, blockId } }, { limit: LIMITS.notes + 5 }))
			.map((e) => e.fields as { author: string; gen: number; text: string; ts: number; human?: boolean; candidateId?: string })
			.filter((n) => !n.candidateId || !rejected.has(n.candidateId)).sort((a, b) => a.ts - b.ts);
		// people's hints all count (the newest five), then the agents' newest eight notes
		const notes = [...rows.filter((n) => n.human).slice(-5), ...rows.filter((n) => !n.human).slice(-8)];
		return {
			attempts: scores.map(attemptOf),
			notes: notes.map(({ author, gen, text, human }) => ({ author, gen, text, ...(human ? { human: true } : {}) })),
		};
	}

	/** Turn `k` of a generation: improve a correct solution, repair a close attempt, or explore (every third turn, and
	 *  whenever there is nothing to build on). Targets rotate over the best few, so the team does not pile onto one. */
	static plan(all: Attempt[], k: number): { role: Role; target: Attempt | null; others: Attempt[]; rejected: Attempt[] } {
		// rejected attempts (a person's veto, hard-coded results) are nothing to build on: they are shown as "not like this"
		const rejected = all.filter((a) => a.rejected).slice(0, 3), attempts = all.filter((a) => !a.rejected);
		const correct = attempts.filter((a) => a.ok), failing = attempts.filter((a) => !a.ok);
		let role: Role = "explore", target: Attempt | null = null;
		if (k % 3 !== 2 && correct.length) { role = "improve"; target = correct[k % Math.min(2, correct.length)]!; }
		else if (k % 3 !== 2 && failing.length) { role = "repair"; target = failing[k % Math.min(3, failing.length)]!; }
		return { role, target, others: attempts.filter((a) => a !== target).slice(0, 3), rejected };
	}

	/** A note an agent left for the team; beyond the room's cap the oldest notes give way. */
	async #addNote(s: Session, blockId: string, author: string, via: string, gen: number, text: string, human = false, candidateId?: string): Promise<void> {
		const tmpl = { type: "CodeNote", fields: { session: s.id } };
		if ((await this.host.count(tmpl)) >= LIMITS.notes) {
			const old = (await this.host.readAll(tmpl, { limit: LIMITS.notes + 5 })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
			for (const e of old.slice(0, old.length - LIMITS.notes + 1)) await this.host.take({ id: e.id }, NO_WAIT);
		}
		await this.host.write({ type: "CodeNote", fields: { session: s.id, blockId, author, via, gen, text: clipWords(text.replace(/[\u0000-\u001f\u007f]/g, " "), 300), ts: Date.now(), ...(human ? { human: true } : {}), ...(candidateId ? { candidateId } : {}) } }, null, this.#ttl);
	}

	/** A run on the active block, in one of two modes. Generations: each agent repairs, explores or improves with the
	 *  whole board in view, until the task is solved and `polish` more generations improved it, or `gens` generations
	 *  are used up. Board (`board: true`, model agents only): work items in the space (implement, critique, revise,
	 *  merge) that agents take as they are free; see board.ts. Both stop at the budget (`budgetTokens`, `budgetUsd`),
	 *  whichever is reached first. Model agents fall back to scripted variants when a guard says no (generations only). */
	async startRun(id: string, o: { agents?: number; gens?: number; perAgent?: number; polish?: number; mode?: RunMode; contenders?: string[]; models?: string[]; lang?: "de" | "en"; board?: boolean; budgetTokens?: unknown; budgetUsd?: unknown }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const int = (v: unknown, dflt: number, min: number, max: number) => Math.min(max, Math.max(min, Math.floor(Number(v ?? dflt)) || (min > 0 ? min : 0)));
		const agents = int(o.agents, 4, 1, LIMITS.agents), gens = int(o.gens, 3, 1, LIMITS.gens), perAgent = int(o.perAgent, 1, 1, LIMITS.perAgent), polish = int(o.polish, 1, 0, LIMITS.polish);
		const positive = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined; };
		const budget = { ...(positive(o.budgetTokens) ? { tokens: Math.floor(positive(o.budgetTokens)!) } : {}), ...(positive(o.budgetUsd) ? { usd: positive(o.budgetUsd)! } : {}) };
		// contenders: "scripted" and/or allowed model labels; the older {mode, models} form still works
		const allowed = await this.#llm.models();
		let contenders = Array.isArray(o.contenders) ? o.contenders.map(String) : o.mode === "llm" ? (Array.isArray(o.models) && o.models.length ? o.models.map(String) : allowed.slice(0, 1)) : ["scripted"];
		contenders = [...new Set(contenders)];
		if (!contenders.length || contenders.length > 4) throw new Error("Choose 1 to 4 contenders");
		for (const c of contenders) if (c !== "scripted" && !allowed.includes(c)) throw new Error(`Model not available: ${c}`);
		const board = o.board === true;
		if (board && (contenders.includes("scripted") || !this.#llm.critique)) throw new Error("The work board needs model agents (scripted agents cannot critique)");
		const mode: RunMode = contenders.some((c) => c !== "scripted") ? "llm" : "scripted";
		// check and claim under the room's lock: two requests cannot both start a run, and setTask cannot swap the block
		// in between; the run is claimed only after its announcement is written, so a failing write leaves no stuck run
		const run = await this.#exclusive(s, async () => {
			if (s.run?.active) throw new Error("A run is already active");
			if (!s.blockId) throw new Error("No task yet: create a task block first");
			if (contenders.includes("scripted") && s.task.variants.length === 0) throw new Error("This task has no scripted agents; use model agents or hand in code yourself");
			const claimed: RunInfo = { active: true, blockId: s.blockId, mode, contenders, gen: 0, gens, agents, perAgent, polish, solvedGen: s.best ? 0 : null, usage: { tokens: 0, costUsd: 0 }, ...(Object.keys(budget).length ? { budget } : {}), ...(board ? { board: { open: 0, done: 0, critiques: 0 } } : {}) };
			const limits = [budget.tokens ? `${budget.tokens} tokens` : "", budget.usd ? `$${budget.usd}` : ""].filter(Boolean).join(" / ");
			await this.#write(s, "system", board
				? `Run started on the work board: ${agents} agents, ${polish} improvement rounds after the solution${limits ? `, budget ${limits}` : ""} (${contenders.join(" + ")})`
				: `Run started: ${agents} agents, up to ${gens} generations, ${polish} more after the solution${limits ? `, budget ${limits}` : ""} (${contenders.join(" + ")})`, claimed.blockId);
			s.run = claimed; s.abort = false;
			return claimed;
		});
		const blockId = run.blockId;
		/** Books a call's usage on the run; false once a budget limit is reached. */
		const spend = (u: Usage | undefined): boolean => {
			if (u) run.usage = { tokens: run.usage.tokens + u.total, costUsd: run.usage.costUsd + u.costUsd };
			const over = (budget.tokens !== undefined && run.usage.tokens >= budget.tokens) || (budget.usd !== undefined && run.usage.costUsd >= budget.usd);
			if (over) run.ended ??= "budget";
			return !over;
		};
		void (async () => {
			try {
				if (board) {
					const end: BoardEnd = await runBoard({
						space: this.host, session: s.id, blockId, runId: `r${Date.now().toString(36)}`, ttl: this.#ttl,
						task: () => s.task, agents, contenders, lang: o.lang ?? "en", polish, maxItems: Math.max(12, agents * gens * 4), maxDepth: LIMITS.boardDepth,
						contribute: (c) => this.#llm.contribute(c), critique: (c) => this.#llm.critique!(c),
						enqueue: (author, via, gen, source, lineage) => this.#enqueue(s, author, via, gen, source, lineage),
						verdict: (candidateId) => this.#verdict(s, candidateId),
						board: () => this.#board(s, blockId),
						note: (author, via, gen, text, candidateId) => this.#addNote(s, blockId, author, via, gen, text, false, candidateId),
						solved: () => !!s.best, stopped: () => s.abort || this.#closed, spend,
						progress: (info) => { run.board = info; run.gen = Math.max(run.gen, 1); this.push(s); },
					});
					if (end === "items" || end === "idle") run.ended ??= end;
					if (s.best && run.solvedGen === null) run.solvedGen = 1;
					return;
				}
				for (let gen = 0; gen < gens && !s.abort && !this.#closed && !run.ended; gen++) {
					if (run.solvedGen !== null && !s.best) run.solvedGen = null; // the solution was rejected by a person: not solved
					if (run.solvedGen !== null && gen >= run.solvedGen + polish) break; // solved and improved enough
					run.gen = gen + 1; this.push(s);
					const board = await this.#board(s, blockId);
					await Promise.all(Array.from({ length: agents }, async (_, a) => {
						for (let j = 0; j < perAgent && !s.abort && !run.ended; j++) {
							let source: string | undefined, via = "scripted", lineage: { role?: Role; basedOn?: string; usage?: Usage } = {}, note: string | undefined;
							const contender = contenders[a % contenders.length]!;
							if (contender !== "scripted") {
								const plan = CodeChatHub.plan(board.attempts, a * perAgent + j);
								try {
									const c = await this.#llm.contribute({ task: s.task, lang: o.lang ?? "en", agent: a, gen, model: contender, role: plan.role, target: plan.target, others: plan.others, rejected: plan.rejected, notes: board.notes, best: s.best ? { source: s.best.source, ms: s.best.ms } : null });
									source = c.source; via = c.model; lineage = { role: plan.role, ...(plan.target ? { basedOn: plan.target.candidateId } : {}), ...(c.usage ? { usage: c.usage } : {}) };
									spend(c.usage);
									note = c.note;
								} catch (e) { run.note = `${contender}: ${(e as Error).message}${s.task.variants.length ? "; scripted agent used" : ""}`; }
							}
							if (source === undefined && s.task.variants.length) source = s.task.variants[Math.floor(rnd() * s.task.variants.length)]!;
							if (source === undefined || s.abort) continue; // a custom task has no scripted variants: this agent has nothing to hand in
							const candidateId = await this.#enqueue(s, `agent-${a}`, via, gen + 1, source, lineage);
							// the note belongs to this contribution: if it gets rejected, its advice is dropped too
							if (note) await this.#addNote(s, blockId, `agent-${a}`, via, gen + 1, note, false, candidateId);
						}
					}));
					await this.#idle(s);
					if (run.solvedGen === null && s.best) run.solvedGen = gen + 1;
				}
			} catch (e) {
				run.note = (e as Error).message;
			} finally {
				run.active = false;
				const closest = s.best ? null : (await this.#board(s, blockId).catch(() => null))?.attempts[0];
				const how = s.best ? `solved${run.solvedGen && !board ? ` in generation ${run.solvedGen}` : run.solvedGen === 0 ? " before the run" : ""}, best ${s.best.ms} ms` : `not solved yet${closest ? ` (closest: ${closest.author}, ${closest.passed ?? 0}/${closest.total ?? "?"} cases)` : ""}`;
				const why = run.ended === "budget" ? " (budget used up)" : run.ended === "items" ? " (item limit reached)" : "";
				const span = board ? `${run.board?.done ?? 0} work items, ${run.board?.critiques ?? 0} critiques` : `${run.gen} generation${run.gen === 1 ? "" : "s"}`;
				await this.#write(s, "system", `Run ${s.abort ? "stopped" : "finished"} after ${span}${why}: ${how}`, blockId).catch(() => {});
				this.push(s);
			}
		})();
	}

	/** Waits for a candidate's verdict, here or on the shard, as the agents see it (null when none comes in time). */
	async #verdict(s: Session, candidateId: string): Promise<Attempt | null> {
		const end = Date.now() + limitOf(s.task) + 120_000;
		const tmpl = { type: "CodeScore", fields: { session: s.id, candidateId } };
		while (Date.now() < end && !this.#closed && !s.abort) {
			const e = (await this.host.readAll(tmpl, { limit: 1 }))[0] ?? (await this.#rcall((r) => r.readAll(tmpl, { limit: 1 })))?.[0];
			if (e) {
				const c = e.fields as unknown as Contribution;
				const veto = (await this.#vetoes(s)).get(candidateId);
				return attemptOf(veto ? { ...c, vetoed: veto } : c);
			}
			await new Promise((r) => setTimeout(r, 300));
		}
		return null;
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
		if (s.run?.active && s.run.blockId === blockId) throw new Error("This block has a running run; stop it first");
		s.deleted.add(blockId);
		// entries from before task blocks existed have no blockId: the block is then identified by the time of its CodeTask
		const legacy = target.blockId === undefined;
		const tmplOf = (type: string): { type: string; fields: Record<string, string | number> } => (type === "CodeTask" && legacy ? { type, fields: { session: id, ts: target.ts } } : { type, fields: { session: id, blockId } });
		for (const type of ["CodeScore", "CodeCandidate", "CodeBest", "CodeNote", "CodeVeto", "CodeCritique", "WorkItem", "ChatMessage", "CodeTask"]) {
			for (let n = 0; n < 2000 && (await this.host.take(tmplOf(type), NO_WAIT)); n++);
			if (type !== "CodeTask" && type !== "ChatMessage" && type !== "CodeNote" && type !== "CodeVeto" && type !== "CodeCritique" && type !== "WorkItem" && this.#remote) await this.#rcall(async (r) => { for (let n = 0; n < 2000 && (await r.take(tmplOf(type), NO_WAIT)); n++); return true; });
		}
		// the last old-style block is gone: the old entries that never belonged to a block go with it
		if (legacy && !(await this.#taskEntries(id)).some((f) => f.blockId === undefined)) {
			const orphans = async (sp: SpaceLike, types: string[]) => {
				for (const type of types) for (const e of await sp.readAll({ type, fields: { session: id } }, { limit: LIMITS.contributions })) {
					const f = e.fields as Record<string, unknown>;
					if (f.blockId === undefined && (type !== "ChatMessage" || f.author === "system")) await sp.take({ id: e.id }, NO_WAIT);
				}
			};
			await orphans(this.host, ["CodeScore", "CodeCandidate", "CodeBest", "ChatMessage"]);
			await this.#rcall(async (r) => { await orphans(r, ["CodeScore", "CodeCandidate"]); return true; });
		}
		// the shard's candidates of this block are gone: nothing to wait for (a verdict that still arrives is removed by the poll)
		for (const [candidateId, p] of s.remotePending) if (p.blockId === blockId) s.remotePending.delete(candidateId);
		if (s.blockId === blockId) { // the active block went away: the newest remaining one takes over, or the room is empty
			const left = (await this.#taskEntries(id)).at(-1);
			const task = left ? taskFromSpec(left) : null;
			if (left && task) {
				s.task = task; s.blockId = String(left.blockId ?? `t${left.ts}`);
				s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
			} else { s.task = TASKS[0]!; s.blockId = ""; s.best = null; }
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
		await this.#addNote(s, blockId, by, "human", s.run?.active && s.run.blockId === blockId ? s.run.gen : 0, text, true);
		this.push(s);
	}

	async stopRun(id: string): Promise<void> { const s = await this.session(id); s.abort = true; this.push(s); }
}
