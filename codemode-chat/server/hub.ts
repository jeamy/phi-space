// Chat sessions on one durable space. Everything that happens is an entry:
//   ChatMessage  people talking          CodeTask       one task block of a room (everything below belongs to a block)
//   CodeCandidate a contribution waiting CodeScore      the sandbox verdict, with the code (the visible contribution)
//   CodeBest     the best correct code so far
// Judges take a candidate under a transaction and write its score atomically, like the evolve example.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { FOREVER, NO_WAIT, PhiSpaces, TransactionError, type SpaceHost, type SpaceLike } from "../../src/index.ts";
import { judge, MAX_SOURCE_CHARS, TIMEOUT_MS, type Codemode } from "./judge.ts";
import { customTask, taskById, taskFromSpec, TASKS, type Task } from "./tasks.ts";
import { llmContribution, llmModels } from "./llm.ts";
import { hostFacts, type HostFacts } from "./shard.ts";
import type { WsConnection } from "./ws.ts";

const DAY = 24 * 3600_000;
const LIMITS = { agents: 8, gens: 6, perAgent: 3, sessions: 50, messages: 500, contributions: 1000, blocks: 60 };
export type RunMode = "scripted" | "llm";
/** The model side of a run; replaceable in tests. */
export type LlmApi = { models: () => Promise<string[]>; contribute: typeof llmContribution };
/** `contenders`: "scripted" and/or model labels (`provider/id`); the agents are assigned to them in turn. */
export type RunInfo = { active: boolean; blockId: string; mode: RunMode; contenders: string[]; gen: number; gens: number; agents: number; perAgent: number; note?: string };
export type Contribution = { candidateId: string; blockId?: string; author: string; via: string; host?: string; gen: number; ok: boolean | null; ms: number | null; error?: string; source: string; ts: number };
type Session = {	id: string; task: Task; blockId: string; clients: Set<WsConnection>; run: RunInfo | null; abort: boolean; draining: number; seq: number;
	best: { candidateId: string; ms: number; source: string } | null; deleted: Set<string>; buckets: Map<string, number[]>; remotePending: Map<string, number>; seen: Set<string>; poller?: ReturnType<typeof setInterval>; pushTimer?: ReturnType<typeof setTimeout>; loaded: boolean;
};

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);
/** The fastest correct contribution (ties: the earlier one). */
const bestOf = (cs: Contribution[]): { candidateId: string; ms: number; source: string } | null => {
	const ok = cs.filter((c) => c.ok && c.ms !== null).sort((a, b) => a.ms! - b.ms! || a.ts - b.ts)[0];
	return ok ? { candidateId: ok.candidateId, ms: ok.ms!, source: ok.source } : null;
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
		try {
			return await Promise.race([fn(this.#remote), new Promise<never>((_, no) => setTimeout(() => no(new Error("shard timeout")), 8_000))]);
		} catch {
			this.#remoteDownUntil = Date.now() + 15_000;
			return null;
		}
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

	async session(id: string): Promise<Session> {
		let s = this.#sessions.get(id);
		if (!s) {
			if (this.#sessions.size >= LIMITS.sessions) throw new Error("Too many sessions");
			s = { id, task: TASKS[0]!, blockId: "", clients: new Set(), run: null, abort: false, draining: 0, seq: 0, best: null, deleted: new Set(), buckets: new Map(), remotePending: new Map(), seen: new Set(), loaded: false };
			this.#sessions.set(id, s);
		}
		if (!s.loaded) {
			s.loaded = true;
			const last = (await this.#taskEntries(id)).at(-1);
			const task = last ? taskFromSpec(last) : null;
			if (last && task) {
				s.task = task; s.blockId = String(last.blockId ?? `t${last.ts}`);
				s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
			} else await this.#openBlock(s, TASKS[0]!, false); // a room starts with the first catalog task
		}
		return s;
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
		s.task = task; s.best = null;
		s.blockId = `b${Date.now().toString(36)}${(s.seq++).toString(36)}`;
		await this.host.write({ type: "CodeTask", fields: { session: s.id, blockId: s.blockId, taskId: task.id, ts: Date.now(), ...(task.id === "custom" ? { custom: { fn: task.fn, prompt: task.prompt.en, cases: task.cases } } : {}) } as never }, null, DAY);
		if (announce) await this.#write(s, "system", `Task: ${task.title.en} (${task.fn})`, s.blockId);
	}

	/** The room as the page shows it: the task blocks (each with its own contributions, best code and log) and free chat. */
	async snapshot(id: string) {
		const s = await this.session(id);
		const cand = { type: "CodeCandidate", fields: { session: id } };
		const [entries, msgs, scores, pendingLocal, pendingRemote] = await Promise.all([
			this.#taskEntries(id),
			this.host.readAll({ type: "ChatMessage", fields: { session: id } }, { limit: LIMITS.messages }),
			this.#scores(s),
			this.host.readAll(cand, { limit: 200 }),
			this.#rcall((r) => r.readAll(cand, { limit: 200 })),
		]);
		const messages = msgs.map((e) => e.fields as { author: string; text: string; ts: number; blockId?: string }).sort((a, b) => a.ts - b.ts);
		const judged = new Set(scores.map((c) => c.candidateId));
		const queued: Contribution[] = [...pendingLocal, ...(pendingRemote ?? [])].map((e) => ({ ...(e.fields as unknown as Contribution), ok: null, ms: null })).filter((c) => !judged.has(c.candidateId));
		const all = [...scores, ...queued];
		const known = new Set<string>();
		const blocks = entries.flatMap((f) => {
			const task = taskFromSpec(f);
			if (!task) return [];
			const blockId = String(f.blockId ?? `t${f.ts}`);
			known.add(blockId);
			const contributions = all.filter((c) => c.blockId === blockId);
			return [{
				blockId, ts: f.ts as number, active: blockId === s.blockId,
				task: { id: task.id, fn: task.fn, title: task.title, prompt: task.prompt, cases: task.id === "custom" ? task.cases.length : undefined },
				contributions, best: bestOf(contributions), messages: messages.filter((m) => m.blockId === blockId),
			}];
		});
		return {
			session: id, current: s.blockId, tasks: TASKS.map((t) => ({ id: t.id, title: t.title, fn: t.fn, prompt: t.prompt })),
			blocks, messages: messages.filter((m) => !m.blockId || !known.has(m.blockId)), run: s.run,
		};
	}

	/** Push a fresh snapshot to every client of the session (debounced, so a burst of writes sends one frame). */
	push(s: Session): void {
		if (this.#closed || s.pushTimer || !s.clients.size) return;
		s.pushTimer = setTimeout(async () => {
			s.pushTimer = undefined;
			if (this.#closed || !s.clients.size) return;
			const frame = { type: "snapshot", ...(await this.snapshot(s.id)) };
			for (const c of s.clients) c.send(frame);
		}, 40);
	}

	async attach(id: string, ws: WsConnection): Promise<void> {
		const s = await this.session(id);
		s.clients.add(ws);
		ws.onClose(() => s.clients.delete(ws));
		ws.send({ type: "snapshot", ...(await this.snapshot(id)) });
	}

	async #write(s: Session, author: string, text: string, blockId?: string): Promise<void> {
		await this.host.write({ type: "ChatMessage", fields: { session: s.id, author, text, ts: Date.now(), ...(blockId ? { blockId } : {}) } }, null, DAY);
		this.push(s);
	}

	/** A person says something (the author name "system" is reserved for the server's own log lines). */
	async message(id: string, author: string, text: string): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "message", 60)) throw new Error("Too many messages, slow down");
		const t = clip(text, 2000).trim(), a = clip(author, 40).trim();
		if (!t || !a || a.toLowerCase() === "system") throw new Error("Invalid message");
		await this.#write(s, a, t);
	}

	/** Every call opens a new task block, also when the same task is chosen again. */
	async setTask(id: string, o: { taskId?: string; custom?: { fn: string; prompt: string; cases: any } }): Promise<void> {
		const s = await this.session(id);
		if (s.run?.active) throw new Error("A run is active; stop it first");
		if (!this.allow(s, "task", 30)) throw new Error("Too many tasks, slow down");
		if ((await this.#taskEntries(id)).length >= LIMITS.blocks) throw new Error("This room holds the maximum number of tasks");
		const task = o.custom ? customTask({ fn: clip(o.custom.fn, 41), prompt: clip(o.custom.prompt, 600), cases: o.custom.cases }) : taskById(String(o.taskId));
		if (!task) throw new Error("Unknown task");
		await this.#openBlock(s, task, true);
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

	async #enqueue(s: Session, author: string, via: string, gen: number, source: string): Promise<string> {
		const candidateId = `${Date.now().toString(36)}-${s.seq++}`;
		const entry = { type: "CodeCandidate", fields: { session: s.id, blockId: s.blockId, taskId: s.task.id, ...(s.task.id === "custom" ? { custom: { fn: s.task.fn, prompt: s.task.prompt.en, cases: s.task.cases } } : {}), candidateId, author, via, gen, source, ts: Date.now() } } as never;
		// every second candidate goes to the nano shard when it is up; if its write fails the candidate is judged here
		if (this.#remote && this.remoteUp && this.#rr++ % 2 === 1) {
			const ok = await this.#rcall(async (r) => { await r.write(entry, null, DAY); return true; });
			if (ok) { s.remotePending.set(candidateId, Date.now()); this.#watchRemote(s); this.push(s); return candidateId; }
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

	/** Judge: take one candidate (transaction), run it in the sandbox, write the score and commit; repeat until none is left. */
	async #drain(s: Session, roleId: number): Promise<void> {
		const r = this.#role(roleId);
		while (!this.#closed) {
			const t = await r.createTransaction(TIMEOUT_MS + 30_000);
			const c = await r.take({ type: "CodeCandidate", fields: { session: s.id } }, NO_WAIT, { txn: t.id });
			if (!c) { await r.abort(t.id); return; }
			const f = c.fields as unknown as Contribution & { taskId?: string; custom?: unknown };
			if (f.blockId && s.deleted.has(f.blockId)) { await r.commit(t.id); continue; } // its block was deleted while it waited: consume it, write nothing
const v = await judge(this.cm, taskFromSpec(f) ?? s.task, f.source); // the candidate names its own task: it may belong to an earlier block
			try {
				await r.write({ type: "CodeScore", fields: { session: s.id, blockId: f.blockId, candidateId: f.candidateId, author: f.author, via: f.via, host: this.facts.name, gen: f.gen, ok: v.ok, ms: v.ms, ...(v.error ? { error: v.error } : {}), source: f.source, ts: f.ts } as never }, t.id, DAY);
				await r.commit(t.id);
			} catch (e) {
				await r.abort(t.id).catch(() => {});
				if (!(e instanceof TransactionError)) throw e;
				continue;
			}
			if (v.ok && f.blockId === s.blockId && (!s.best || v.ms < s.best.ms)) {
				s.best = { candidateId: f.candidateId, ms: v.ms, source: f.source };
				await this.host.write({ type: "CodeBest", fields: { session: s.id, blockId: s.blockId, candidateId: f.candidateId, ms: v.ms, source: f.source } }, null, DAY);
			}
			this.push(s);
		}
	}

	/** Candidates sent to the shard come back as CodeScore entries there: poll until each one has a verdict (or 90 s passed). */
	#watchRemote(s: Session): void {
		if (s.poller) return;
		s.poller = setInterval(async () => {
			const now = Date.now();
			for (const [id, at] of s.remotePending) if (now - at > 90_000) s.remotePending.delete(id);
			if (!s.remotePending.size || this.#closed) { clearInterval(s.poller); s.poller = undefined; return; }
			const rows = await this.#rcall((r) => r.readAll({ type: "CodeScore", fields: { session: s.id } }, { limit: LIMITS.contributions }));
			let changed = false;
			for (const e of rows ?? []) {
				const f = e.fields as unknown as Contribution;
				if (!s.remotePending.delete(f.candidateId)) continue;
				changed = true;
				if (f.ok && f.ms !== null && (!s.best || f.ms < s.best.ms) && f.blockId === s.blockId) {
					s.best = { candidateId: f.candidateId, ms: f.ms, source: f.source };
					await this.host.write({ type: "CodeBest", fields: { session: s.id, blockId: s.blockId, candidateId: f.candidateId, ms: f.ms, source: f.source } }, null, DAY);
				}
			}
			if (changed) this.push(s);
		}, 400);
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
		if (s.run?.active) throw new Error("A run is already active");
		if (!this.allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const agents = Math.min(LIMITS.agents, Math.max(1, Math.floor(Number(o.agents ?? 4)))), gens = Math.min(LIMITS.gens, Math.max(1, Math.floor(Number(o.gens ?? 3)))), perAgent = Math.min(LIMITS.perAgent, Math.max(1, Math.floor(Number(o.perAgent ?? 1))));
		// contenders: "scripted" and/or allowed model labels; the older {mode, models} form still works
		const allowed = await this.#llm.models();
		let contenders = Array.isArray(o.contenders) ? o.contenders.map(String) : o.mode === "llm" ? (Array.isArray(o.models) && o.models.length ? o.models.map(String) : allowed.slice(0, 1)) : ["scripted"];
		contenders = [...new Set(contenders)];
		if (!contenders.length || contenders.length > 4) throw new Error("Choose 1 to 4 contenders");
		for (const c of contenders) if (c !== "scripted" && !allowed.includes(c)) throw new Error(`Model not available: ${c}`);
		if (contenders.includes("scripted") && s.task.variants.length === 0) throw new Error("This task has no scripted agents; use model agents or hand in code yourself");
		const mode: RunMode = contenders.some((c) => c !== "scripted") ? "llm" : "scripted";
		const run: RunInfo = { active: true, blockId: s.blockId, mode, contenders, gen: 0, gens, agents, perAgent };
		s.run = run; s.abort = false;
		const blockId = s.blockId;
		await this.#write(s, "system", `Run started: ${agents} agents x ${gens} generations (${contenders.join(" vs ")})`, blockId);
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
	}	/** Removes a task block with everything that belongs to it (here and on the shard). A running block cannot be deleted. */
	async deleteBlock(id: string, blockId: string): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "delete", 20)) throw new Error("Too many deletions, slow down");
		const entries = await this.#taskEntries(id);
		const target = entries.find((f) => String(f.blockId ?? `t${f.ts}`) === blockId);
		if (!target) throw new Error("Unknown task block");
		if (s.run?.active && s.run.blockId === blockId) throw new Error("This block has a running run; stop it first");
		s.deleted.add(blockId);
		const tmplOf = (type: string) => ({ type, fields: { session: id, blockId } });
		for (const type of ["CodeScore", "CodeCandidate", "CodeBest", "ChatMessage", "CodeTask"]) {
			for (let n = 0; n < 2000 && (await this.host.take(tmplOf(type), NO_WAIT)); n++);
			if (type !== "CodeTask" && type !== "ChatMessage" && this.#remote) await this.#rcall(async (r) => { for (let n = 0; n < 2000 && (await r.take(tmplOf(type), NO_WAIT)); n++); return true; });
		}
		s.remotePending.delete(blockId);
		if (s.blockId === blockId) { // the active block went away: the newest remaining one takes over, or a fresh first task
			const left = (await this.#taskEntries(id)).at(-1);
			const task = left ? taskFromSpec(left) : null;
			if (left && task) {
				s.task = task; s.blockId = String(left.blockId ?? `t${left.ts}`);
				s.best = bestOf((await this.#scores(s)).filter((c) => c.blockId === s.blockId));
			} else await this.#openBlock(s, TASKS[0]!, false);
		}
		await this.#write(s, "system", `Task block deleted: ${taskFromSpec(target)?.title.en ?? blockId}`);
		this.push(s);
	}

	async stopRun(id: string): Promise<void> { const s = await this.session(id); s.abort = true; this.push(s); }
}
