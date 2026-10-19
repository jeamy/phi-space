// Chat sessions on one durable space. Everything that happens is an entry:
//   ChatMessage  people talking          CodeTask       one task block of a room (everything below belongs to a block)
//   CodeCandidate a contribution waiting CodeScore      the sandbox verdict, with the code (the visible contribution)
//   CodeBest     the best correct code of a block (one entry per block, replaced when beaten)
// Judges take a candidate under a transaction and write its score atomically, like the evolve example.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { NO_WAIT, PhiSpaces, TransactionError, type SpaceHost, type SpaceLike } from "../../src/index.ts";
import { judgeInSlot, MAX_SOURCE_CHARS, sandboxSlot, TIMEOUT_MS, type Codemode, type Verdict } from "./judge.ts";
import { customTask, taskById, taskFromSpec, TASKS, type Task } from "./tasks.ts";
import { llmContribution, llmModels } from "./llm.ts";
import { hostFacts, type HostFacts } from "./shard.ts";
import type { WsConnection } from "./ws.ts";

const DAY = 24 * 3600_000;
const LIMITS = { agents: 8, gens: 6, perAgent: 3, sessions: 50, messages: 500, contributions: 1000, blocks: 60 };
/** Code text a snapshot carries at most; the rest is fetched per contribution (`source()`), so a frame stays far below
 *  the 1 MiB WebSocket limit however many contributions a room holds. */
const SNAPSHOT_SOURCE_BYTES = 384 * 1024;
/** A candidate sent to the shard that has no verdict after this long is taken back and judged here. */
const REMOTE_GRACE_MS = 90_000;
export type RunMode = "scripted" | "llm";
/** The model side of a run; replaceable in tests. */
export type LlmApi = { models: () => Promise<string[]>; contribute: typeof llmContribution };
/** `contenders`: "scripted" and/or model labels (`provider/id`); the agents are assigned to them in turn. */
export type RunInfo = { active: boolean; blockId: string; mode: RunMode; contenders: string[]; gen: number; gens: number; agents: number; perAgent: number; note?: string };
/** `source` is left out of a snapshot when its byte budget is spent (`sourceOmitted`); `source()` returns it. */
export type Contribution = { candidateId: string; blockId?: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; source?: string; sourceOmitted?: true; ts: number };
type Best = { candidateId: string; ms: number; source?: string; sourceOmitted?: true };
type Session = {	id: string; task: Task; blockId: string; clients: Set<WsConnection>; run: RunInfo | null; abort: boolean; draining: number; seq: number;
	best: { candidateId: string; ms: number; source: string } | null; deleted: Set<string>; buckets: Map<string, number[]>; remotePending: Map<string, { at: number; blockId?: string }>; poller?: ReturnType<typeof setInterval>; polling: boolean;
	pushTimer?: ReturnType<typeof setTimeout>; pushing: boolean; pushAgain: boolean; loading: Promise<void>; lastUsed: number;
	/** Serializes the operations that change the room's blocks or run (setTask, startRun, deleteBlock) and CodeBest. */
	tail: Promise<unknown>; bestTail: Promise<unknown>;
};

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);
/** A verdict time that can stand in a ranking: finite and not negative (scores from the shard are data too). */
const validMs = (ms: unknown): ms is number => typeof ms === "number" && Number.isFinite(ms) && ms >= 0;
/** The fastest correct contribution (ties: the earlier one). */
const bestOf = (cs: Contribution[]): { candidateId: string; ms: number; source: string } | null => {
	const ok = cs.filter((c) => c.ok && validMs(c.ms)).sort((a, b) => a.ms! - b.ms! || a.ts - b.ts)[0];
	return ok ? { candidateId: ok.candidateId, ms: ok.ms!, source: ok.source ?? "" } : null;
};
const rnd = () => Math.random();

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
	constructor(h: SpaceHost, cm: Codemode, o: { remote?: SpaceLike | null; remoteLabel?: string | null; llm?: LlmApi } = {}) { this.h = h; this.cm = cm; this.host = new PhiSpaces(h, ctx); this.#remote = o.remote ?? null; this.#remoteLabel = o.remoteLabel ?? null; this.#llm = o.llm ?? { models: llmModels, contribute: llmContribution }; }

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
			s = { id, task: TASKS[0]!, blockId: "", clients: new Set(), run: null, abort: false, draining: 0, seq: 0, best: null, deleted: new Set(), buckets: new Map(), remotePending: new Map(), polling: false, pushing: false, pushAgain: false, loading: Promise.resolve(), lastUsed: Date.now(), tail: Promise.resolve(), bestTail: Promise.resolve() };
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
		if (last && task) {
			s.task = task; s.blockId = String(last.blockId ?? `t${last.ts}`);
			s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
		} else await this.#openBlock(s, TASKS[0]!, false); // a room starts with the first catalog task
		this.#kick(s); // candidates left from before a restart are judged now, not when the next one arrives
	}

	async #taskEntries(id: string): Promise<Array<Record<string, any>>> {
		return (await this.host.readAll({ type: "CodeTask", fields: { session: id } }, { limit: LIMITS.blocks + 5 })).map((e) => e.fields as Record<string, any>).sort((a, b) => a.ts - b.ts);
	}

	/** All verdicts of a room (this host and the shard), oldest first. */
	async #scores(s: Session): Promise<Contribution[]> {
		const tmpl = { type: "CodeScore", fields: { session: s.id } };
		const [local, remote] = await Promise.all([this.host.readAll(tmpl, { limit: LIMITS.contributions }), this.#rcall((r) => r.readAll(tmpl, { limit: LIMITS.contributions }))]);
		return [...local, ...(remote ?? [])].map((e) => e.fields as unknown as Contribution).sort((a, b) => a.ts - b.ts);
	}

	/** Opens a new task block: from now on candidates, scores and the best code belong to it. */
	async #openBlock(s: Session, task: Task, announce: boolean): Promise<void> {
		const blockId = `b${Date.now().toString(36)}${(s.seq++).toString(36)}`;
		await this.host.write({ type: "CodeTask", fields: { session: s.id, blockId, taskId: task.id, ts: Date.now(), ...(task.id === "custom" ? { custom: { fn: task.fn, prompt: task.prompt.en, cases: task.cases } } : {}) } as never }, null, DAY);
		s.task = task; s.best = null; s.blockId = blockId; // only once the block exists
		if (announce) await this.#write(s, "system", `Task: ${task.title.en} (${task.fn})`, s.blockId);
	}

	/** The room as the page shows it: the task blocks (each with its own contributions, best code and log) and free chat. */
	async snapshot(id: string) {
		const s = await this.session(id);
		const cand = { type: "CodeCandidate", fields: { session: id } };
		const [entries, msgs, scores, pendingLocal, pendingRemote] = await Promise.all([
			this.#taskEntries(id),
			this.host.readAll({ type: "ChatMessage", fields: { session: id } }, { limit: LIMITS.messages + 5 }),
			this.#scores(s),
			this.host.readAll(cand, { limit: LIMITS.contributions }),
			this.#rcall((r) => r.readAll(cand, { limit: LIMITS.contributions })),
		]);
		const messages = msgs.map((e) => e.fields as { author: string; text: string; ts: number; blockId?: string }).sort((a, b) => a.ts - b.ts);
		const judged = new Set(scores.map((c) => c.candidateId));
		const queued: Contribution[] = [...pendingLocal, ...(pendingRemote ?? [])].map((e) => ({ ...(e.fields as unknown as Contribution), ok: null, ms: null })).filter((c) => !judged.has(c.candidateId));
		const all = [...scores, ...queued];
		// the code budget: the active block's best code first, then every block's best, then the newest contributions
		let budget = SNAPSHOT_SOURCE_BYTES;
		const keep = new Set<string>();
		const spend = (c: { candidateId: string; source?: string } | null) => {
			if (!c || keep.has(c.candidateId)) return;
			const n = Buffer.byteLength(c.source ?? "");
			if (n <= budget) { budget -= n; keep.add(c.candidateId); }
		};
		const known = new Set<string>();
		const raw = entries.flatMap((f) => {
			const task = taskFromSpec(f);
			if (!task) return [];
			const blockId = String(f.blockId ?? `t${f.ts}`);
			known.add(blockId);
			const contributions = all.filter((c) => c.blockId === blockId);
			return [{ f, task, blockId, contributions, best: bestOf(contributions) }];
		});
		spend(raw.find((b) => b.blockId === s.blockId)?.best ?? null);
		for (const b of raw) spend(b.best);
		for (const c of [...all].sort((a, b) => b.ts - a.ts)) spend(c);
		const slim = <T extends { candidateId: string; source?: string }>(c: T): T => (keep.has(c.candidateId) ? c : { ...c, source: undefined, sourceOmitted: true });
		const blocks = raw.map(({ f, task, blockId, contributions, best }) => ({
			blockId, ts: f.ts as number, active: blockId === s.blockId,
			task: { id: task.id, fn: task.fn, title: task.title, prompt: task.prompt, cases: task.id === "custom" ? task.cases.length : undefined },
			contributions: contributions.map(slim), best: best ? slim<Best>(best) : null, messages: messages.filter((m) => m.blockId === blockId),
		}));
		return {
			session: id, current: s.blockId, tasks: TASKS.map((t) => ({ id: t.id, title: t.title, fn: t.fn, prompt: t.prompt })),
			blocks, messages: messages.filter((m) => !m.blockId || !known.has(m.blockId)), run: s.run,
		};
	}

	/** The code of one contribution (verdict or still waiting), here or on the shard; null when it is gone. */
	async source(id: string, candidateId: string): Promise<string | null> {
		const s = await this.session(id);
		for (const type of ["CodeScore", "CodeCandidate"]) {
			const tmpl = { type, fields: { session: s.id, candidateId } };
			const e = (await this.host.readAll(tmpl, { limit: 1 }))[0] ?? (await this.#rcall((r) => r.readAll(tmpl, { limit: 1 })))?.[0];
			if (e) return String((e.fields as Record<string, unknown>).source ?? "");
		}
		return null;
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
		await this.host.write({ type: "ChatMessage", fields: { session: s.id, author, text, ts: Date.now(), ...(blockId ? { blockId } : {}) } }, null, DAY);
		this.push(s);
	}

	/** Every call opens a new task block, also when the same task is chosen again. */
	async setTask(id: string, o: { taskId?: string; custom?: { fn: string; prompt: string; cases: any } }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "task", 30)) throw new Error("Too many tasks, slow down");
		const task = o.custom ? customTask({ fn: clip(o.custom.fn, 41), prompt: clip(o.custom.prompt, 600), cases: o.custom.cases }) : taskById(String(o.taskId));
		if (!task) throw new Error("Unknown task");
		await this.#exclusive(s, async () => {
			if (s.run?.active) throw new Error("A run is active; stop it first");
			if ((await this.#taskEntries(id)).length >= LIMITS.blocks) throw new Error("This room holds the maximum number of tasks");
			await this.#openBlock(s, task, true);
		});
		this.push(s);
	}

	/** A person hands in code; it is judged by the same sandbox as the agents' code. */
	async submitCode(id: string, author: string, source: string): Promise<string> {
		const s = await this.session(id);
		if (!this.allow(s, "code", 20)) throw new Error("Too many submissions, slow down");
		const src = String(source ?? "");
		if (!src.trim() || src.length > MAX_SOURCE_CHARS) throw new Error(`Code must be 1 to ${MAX_SOURCE_CHARS} characters`);
		return this.#enqueue(s, clip(author, 40).trim() || "guest", "human", 0, src);
	}

	/** Contributions a room holds (verdicts and waiting candidates, here and on the shard). */
	async #contributionCount(s: Session): Promise<number> {
		const n = async (sp: SpaceLike) => (await sp.count({ type: "CodeScore", fields: { session: s.id } })) + (await sp.count({ type: "CodeCandidate", fields: { session: s.id } }));
		return (await n(this.host)) + ((await this.#rcall(n)) ?? 0);
	}

	async #enqueue(s: Session, author: string, via: string, gen: number, source: string): Promise<string> {
		// the cap keeps every read of the room (snapshot, ranking) complete: a read limit never cuts contributions off
		if ((await this.#contributionCount(s)) >= LIMITS.contributions) throw new Error("This room holds the maximum number of contributions; delete a task block");
		const candidateId = `${Date.now().toString(36)}-${s.seq++}`;
		const entry = { type: "CodeCandidate", fields: { session: s.id, blockId: s.blockId, taskId: s.task.id, ...(s.task.id === "custom" ? { custom: { fn: s.task.fn, prompt: s.task.prompt.en, cases: s.task.cases } } : {}), candidateId, author, via, gen, source, ts: Date.now() } } as never;
		// every second candidate goes to the nano shard when it is up; if its write fails the candidate is judged here
		if (this.#remote && this.remoteUp && this.#rr++ % 2 === 1) {
			const ok = await this.#rcall(async (r) => { await r.write(entry, null, DAY); return true; });
			if (ok) { s.remotePending.set(candidateId, { at: Date.now(), blockId: s.blockId }); this.#watchRemote(s); this.push(s); return candidateId; }
		}
		await this.#role(100 + (s.seq % 8)).write(entry, null, DAY);
		this.push(s);
		this.#kick(s);
		return candidateId;
	}

	/** Starts up to two judge loops; after close() an in-flight verdict may find the space gone, which is not an error. */
	#kick(s: Session): void {
		while (s.draining < 2 && !this.#closed) { s.draining++; void this.#drain(s, 200 + s.draining).catch((e) => { if (!this.#closed) console.error("[codemode] judge failed", e); }).finally(() => { s.draining--; this.push(s); }); }
	}

	/** Judge: take one candidate (transaction), run it in the sandbox, write the score and commit; repeat until none is
	 *  left. The sandbox slot is taken first, so the transaction's lease only covers the judging itself. */
	async #drain(s: Session, roleId: number): Promise<void> {
		const r = this.#role(roleId);
		while (!this.#closed) {
			const done = await sandboxSlot(async (): Promise<{ f: Contribution; v: Verdict } | null | "retry"> => {
				const t = await r.createTransaction(TIMEOUT_MS + 30_000);
				let c;
				try { c = await r.take({ type: "CodeCandidate", fields: { session: s.id } }, NO_WAIT, { txn: t.id }); }
				catch (e) { await r.abort(t.id).catch(() => {}); throw e; }
				if (!c) { await r.abort(t.id); return null; }
				const f = c.fields as unknown as Contribution & { taskId?: string; custom?: unknown };
				const gone = () => !!f.blockId && s.deleted.has(f.blockId);
				// the candidate names its own task (it may belong to an earlier block); one that names none cannot be judged
				const task = taskFromSpec(f);
				const v: Verdict | null = gone() ? null : task ? await judgeInSlot(this.cm, task, String(f.source ?? "")) : { ok: false, ms: TIMEOUT_MS, error: "unknown task" };
				try {
					// its block was deleted while it waited or while it was judged: consume it, write nothing
					if (v && !gone()) await r.write({ type: "CodeScore", fields: { session: s.id, blockId: f.blockId, candidateId: f.candidateId, author: f.author, via: f.via, host: this.facts.name, gen: f.gen, ok: v.ok, ms: v.ms, ...(v.error ? { error: v.error } : {}), source: f.source, ts: f.ts } as never }, t.id, DAY);
					await r.commit(t.id);
				} catch (e) {
					await r.abort(t.id).catch(() => {});
					if (!(e instanceof TransactionError)) throw e;
					return "retry";
				}
				return v && !gone() ? { f, v } : "retry";
			});
			if (done === null) return;
			if (done !== "retry" && done.v.ok) await this.#offerBest(s, done.f.blockId, done.f.candidateId, done.v.ms, String(done.f.source ?? ""));
			this.push(s);
		}
	}

	/** A correct verdict of the active block that beats its best replaces the block's CodeBest entry. */
	#offerBest(s: Session, blockId: string | undefined, candidateId: string, ms: number, source: string): Promise<unknown> {
		const work = s.bestTail.catch(() => {}).then(async () => {
			if (!validMs(ms) || blockId !== s.blockId || (s.best && ms >= s.best.ms)) return;
			s.best = { candidateId, ms, source };
			while (await this.host.take({ type: "CodeBest", fields: { session: s.id, blockId } }, NO_WAIT));
			await this.host.write({ type: "CodeBest", fields: { session: s.id, blockId, candidateId, ms, source } }, null, DAY);
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
			if (back) await this.#role(100 + (s.seq % 8)).write({ type: "CodeCandidate", fields: back.fields } as never, null, DAY);
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

	/** Generations of agent contributions; model agents fall back to scripted variants when a guard says no. */
	async startRun(id: string, o: { agents?: number; gens?: number; perAgent?: number; mode?: RunMode; contenders?: string[]; models?: string[]; lang?: "de" | "en" }): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const agents = Math.min(LIMITS.agents, Math.max(1, Math.floor(Number(o.agents ?? 4)))), gens = Math.min(LIMITS.gens, Math.max(1, Math.floor(Number(o.gens ?? 3)))), perAgent = Math.min(LIMITS.perAgent, Math.max(1, Math.floor(Number(o.perAgent ?? 1))));
		// contenders: "scripted" and/or allowed model labels; the older {mode, models} form still works
		const allowed = await this.#llm.models();
		let contenders = Array.isArray(o.contenders) ? o.contenders.map(String) : o.mode === "llm" ? (Array.isArray(o.models) && o.models.length ? o.models.map(String) : allowed.slice(0, 1)) : ["scripted"];
		contenders = [...new Set(contenders)];
		if (!contenders.length || contenders.length > 4) throw new Error("Choose 1 to 4 contenders");
		for (const c of contenders) if (c !== "scripted" && !allowed.includes(c)) throw new Error(`Model not available: ${c}`);
		const mode: RunMode = contenders.some((c) => c !== "scripted") ? "llm" : "scripted";
		// check and claim under the room's lock: two requests cannot both start a run, and setTask cannot swap the block
		// in between; the run is claimed only after its announcement is written, so a failing write leaves no stuck run
		const run = await this.#exclusive(s, async () => {
			if (s.run?.active) throw new Error("A run is already active");
			if (contenders.includes("scripted") && s.task.variants.length === 0) throw new Error("This task has no scripted agents; use model agents or hand in code yourself");
			const claimed: RunInfo = { active: true, blockId: s.blockId, mode, contenders, gen: 0, gens, agents, perAgent };
			await this.#write(s, "system", `Run started: ${agents} agents x ${gens} generations (${contenders.join(" vs ")})`, claimed.blockId);
			s.run = claimed; s.abort = false;
			return claimed;
		});
		const blockId = run.blockId;
		void (async () => {
			try {
				for (let gen = 0; gen < gens && !s.abort && !this.#closed; gen++) {
					run.gen = gen + 1; this.push(s);
					const best = s.best ? { source: s.best.source, ms: s.best.ms } : null;
					await Promise.all(Array.from({ length: agents }, async (_, a) => {
						for (let j = 0; j < perAgent; j++) {
							let source: string | undefined, via = "scripted";
							const contender = contenders[a % contenders.length]!;
							if (contender !== "scripted") {
								try { const c = await this.#llm.contribute({ task: s.task, lang: o.lang ?? "en", agent: a, gen, best, model: contender }); source = c.source; via = c.model; }
								catch (e) { run.note = `${contender}: ${(e as Error).message}; scripted agent used`; }
							}
							if (source === undefined && s.task.variants.length) source = s.task.variants[Math.floor(rnd() * s.task.variants.length)]!;
							if (source === undefined) continue; // a custom task has no scripted variants: this agent has nothing to hand in
							await this.#enqueue(s, `agent-${a}`, via, gen + 1, source);
						}
					}));
					await this.#idle(s);
				}
			} catch (e) {
				run.note = (e as Error).message;
			} finally {
				run.active = false;
				await this.#write(s, "system", `Run ${s.abort ? "stopped" : "finished"}${s.best ? `: best ${s.best.ms} ms` : ": no correct code"}`, blockId).catch(() => {});
				this.push(s);
			}
		})();
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
		for (const type of ["CodeScore", "CodeCandidate", "CodeBest", "ChatMessage", "CodeTask"]) {
			for (let n = 0; n < 2000 && (await this.host.take(tmplOf(type), NO_WAIT)); n++);
			if (type !== "CodeTask" && type !== "ChatMessage" && this.#remote) await this.#rcall(async (r) => { for (let n = 0; n < 2000 && (await r.take(tmplOf(type), NO_WAIT)); n++); return true; });
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
		if (s.blockId === blockId) { // the active block went away: the newest remaining one takes over, or a fresh first task
			const left = (await this.#taskEntries(id)).at(-1);
			const task = left ? taskFromSpec(left) : null;
			if (left && task) {
				s.task = task; s.blockId = String(left.blockId ?? `t${left.ts}`);
				s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
			} else await this.#openBlock(s, TASKS[0]!, false);
		}
		await this.#write(s, "system", `Task block deleted: ${taskFromSpec(target)?.title.en ?? blockId}`);
	}

	async stopRun(id: string): Promise<void> { const s = await this.session(id); s.abort = true; this.push(s); }
}
