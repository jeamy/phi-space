// Chat sessions on one durable space. Everything that happens is an entry:
//   ChatMessage  people talking          CodeTask       the current problem of a session
//   CodeCandidate a contribution waiting CodeScore      the sandbox verdict, with the code (the visible contribution)
//   CodeBest     the best correct code so far
// Judges take a candidate under a transaction and write its score atomically, like the evolve example.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { FOREVER, NO_WAIT, PhiSpaces, TransactionError, type SpaceHost } from "../../src/index.ts";
import { judge, MAX_SOURCE_CHARS, TIMEOUT_MS, type Codemode } from "./judge.ts";
import { customTask, taskById, TASKS, type Task } from "./tasks.ts";
import { llmContribution } from "./llm.ts";
import type { WsConnection } from "./ws.ts";

const DAY = 24 * 3600_000;
const LIMITS = { agents: 8, gens: 6, perAgent: 3, sessions: 50, messages: 500, contributions: 300 };
export type RunMode = "scripted" | "llm";
export type RunInfo = { active: boolean; mode: RunMode; gen: number; gens: number; agents: number; perAgent: number; note?: string };
export type Contribution = { candidateId: string; author: string; via: string; gen: number; ok: boolean | null; ms: number | null; error?: string; source: string; ts: number };
type Session = {
	id: string; task: Task; clients: Set<WsConnection>; run: RunInfo | null; abort: boolean; draining: number; seq: number;
	best: { candidateId: string; ms: number; source: string } | null; buckets: Map<string, number[]>; pushTimer?: ReturnType<typeof setTimeout>; loaded: boolean;
};

const clip = (s: unknown, max: number) => String(s ?? "").slice(0, max);
const rnd = () => Math.random();

export class CodeChatHub {
	readonly host: PhiSpaces;
	readonly h: SpaceHost;
	readonly cm: Codemode;
	#sessions = new Map<string, Session>();
	#closed = false;
	#roles = new Map<number, PhiSpaces>();
	constructor(h: SpaceHost, cm: Codemode) { this.h = h; this.cm = cm; this.host = new PhiSpaces(h, ctx); }

	#role(id: number): PhiSpaces {
		let r = this.#roles.get(id);
		if (!r) this.#roles.set(id, (r = new PhiSpaces(this.h, ctx, Date.now, undefined, id)));
		return r;
	}

	async close(): Promise<void> {
		this.#closed = true;
		for (const s of this.#sessions.values()) { s.abort = true; for (const c of s.clients) c.close(); clearTimeout(s.pushTimer); }
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
			s = { id, task: TASKS[0]!, clients: new Set(), run: null, abort: false, draining: 0, seq: 0, best: null, buckets: new Map(), loaded: false };
			this.#sessions.set(id, s);
		}
		if (!s.loaded) {
			s.loaded = true;
			const t = (await this.host.readAll({ type: "CodeTask", fields: { session: id } }, { limit: 50 })).map((e) => e.fields as Record<string, any>).sort((a, b) => a.ts - b.ts).pop();
			if (t) s.task = t.taskId === "custom" ? customTask({ fn: t.fn, prompt: t.prompt, cases: t.cases }) : taskById(t.taskId) ?? s.task;
			s.best = (await this.#scores(s, s.task)).filter((c) => c.ok).sort((a, b) => a.ms! - b.ms!).map((c) => ({ candidateId: c.candidateId, ms: c.ms!, source: c.source }))[0] ?? null;
		}
		return s;
	}

	async #scores(s: Session, task: Task): Promise<Contribution[]> {
		const rows = await this.host.readAll({ type: "CodeScore", fields: { session: s.id, taskKey: this.#taskKey(task) } }, { limit: LIMITS.contributions });
		return rows.map((e) => e.fields as unknown as Contribution).sort((a, b) => a.ts - b.ts);
	}
	#taskKey = (t: Task) => (t.id === "custom" ? `custom:${t.fn}:${t.prompt.en.length}` : t.id);

	async snapshot(id: string) {
		const s = await this.session(id);
		const [msgs, scores, pending] = await Promise.all([
			this.host.readAll({ type: "ChatMessage", fields: { session: id } }, { limit: LIMITS.messages }),
			this.#scores(s, s.task),
			this.host.readAll({ type: "CodeCandidate", fields: { session: id, taskKey: this.#taskKey(s.task) } }, { limit: 100 }),
		]);
		const messages = msgs.map((e) => e.fields as { author: string; text: string; ts: number }).sort((a, b) => a.ts - b.ts);
		const queued: Contribution[] = pending.map((e) => ({ ...(e.fields as unknown as Contribution), ok: null, ms: null }));
		return {
			session: id, task: { id: s.task.id, fn: s.task.fn, title: s.task.title, prompt: s.task.prompt, cases: s.task.id === "custom" ? s.task.cases.length : undefined },
			tasks: TASKS.map((t) => ({ id: t.id, title: t.title })),
			messages, contributions: [...scores, ...queued], best: s.best, run: s.run,
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

	async message(id: string, author: string, text: string): Promise<void> {
		const s = await this.session(id);
		if (!this.allow(s, "message", 60)) throw new Error("Too many messages, slow down");
		const t = clip(text, 2000).trim(), a = clip(author, 40).trim();
		if (!t || !a) throw new Error("Invalid message");
		await this.host.write({ type: "ChatMessage", fields: { session: id, author: a, text: t, ts: Date.now() } }, null, DAY);
		this.push(s);
	}

	async setTask(id: string, o: { taskId?: string; custom?: { fn: string; prompt: string; cases: any } }): Promise<void> {
		const s = await this.session(id);
		if (s.run?.active) throw new Error("A run is active; stop it first");
		const task = o.custom ? customTask({ fn: clip(o.custom.fn, 41), prompt: clip(o.custom.prompt, 600), cases: o.custom.cases }) : taskById(String(o.taskId));
		if (!task) throw new Error("Unknown task");
		s.task = task;
		s.best = (await this.#scores(s, task)).filter((c) => c.ok).sort((a, b) => a.ms! - b.ms!).map((c) => ({ candidateId: c.candidateId, ms: c.ms!, source: c.source }))[0] ?? null;
		await this.host.write({ type: "CodeTask", fields: { session: id, taskId: task.id, ts: Date.now(), ...(task.id === "custom" ? { fn: task.fn, prompt: task.prompt.en, cases: task.cases as never } : {}) } as never }, null, DAY);
		await this.message(id, "system", `Task: ${task.title.en} (${task.fn})`);
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
		await this.#role(100 + (s.seq % 8)).write({ type: "CodeCandidate", fields: { session: s.id, taskKey: this.#taskKey(s.task), candidateId, author, via, gen, source, ts: Date.now() } }, null, DAY);
		this.push(s);
		this.#kick(s);
		return candidateId;
	}

	#kick(s: Session): void {
		while (s.draining < 2 && !this.#closed) { s.draining++; void this.#drain(s, 200 + s.draining).finally(() => { s.draining--; this.push(s); }); }
	}

	/** Judge: take one candidate (transaction), run it in the sandbox, write the score and commit; repeat until none is left. */
	async #drain(s: Session, roleId: number): Promise<void> {
		const r = this.#role(roleId);
		while (!this.#closed) {
			const t = await r.createTransaction(TIMEOUT_MS + 30_000);
			const c = await r.take({ type: "CodeCandidate", fields: { session: s.id, taskKey: this.#taskKey(s.task) } }, NO_WAIT, { txn: t.id });
			if (!c) { await r.abort(t.id); return; }
			const f = c.fields as unknown as Contribution;
			const v = await judge(this.cm, s.task, f.source);
			try {
				await r.write({ type: "CodeScore", fields: { session: s.id, taskKey: this.#taskKey(s.task), candidateId: f.candidateId, author: f.author, via: f.via, gen: f.gen, ok: v.ok, ms: v.ms, ...(v.error ? { error: v.error } : {}), source: f.source, ts: f.ts } as never }, t.id, DAY);
				await r.commit(t.id);
			} catch (e) {
				await r.abort(t.id).catch(() => {});
				if (!(e instanceof TransactionError)) throw e;
				continue;
			}
			if (v.ok && (!s.best || v.ms < s.best.ms)) {
				s.best = { candidateId: f.candidateId, ms: v.ms, source: f.source };
				await this.host.write({ type: "CodeBest", fields: { session: s.id, taskKey: this.#taskKey(s.task), candidateId: f.candidateId, ms: v.ms, source: f.source } }, null, DAY);
			}
			this.push(s);
		}
	}

	async #idle(s: Session): Promise<void> {
		while (!this.#closed && !s.abort && (s.draining > 0 || (await this.host.count({ type: "CodeCandidate", fields: { session: s.id } })) > 0)) await new Promise((r) => setTimeout(r, 60));
	}

	/** Generations of agent contributions; model agents fall back to scripted variants when a guard says no. */
	async startRun(id: string, o: { agents?: number; gens?: number; perAgent?: number; mode?: RunMode; lang?: "de" | "en" }): Promise<void> {
		const s = await this.session(id);
		if (s.run?.active) throw new Error("A run is already active");
		if (!this.allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const agents = Math.min(LIMITS.agents, Math.max(1, Math.floor(Number(o.agents ?? 4)))), gens = Math.min(LIMITS.gens, Math.max(1, Math.floor(Number(o.gens ?? 3)))), perAgent = Math.min(LIMITS.perAgent, Math.max(1, Math.floor(Number(o.perAgent ?? 1))));
		const mode: RunMode = o.mode === "llm" ? "llm" : "scripted";
		if (mode === "scripted" && s.task.variants.length === 0) throw new Error("This task has no scripted agents; use model agents or hand in code yourself");
		const run: RunInfo = { active: true, mode, gen: 0, gens, agents, perAgent };
		s.run = run; s.abort = false;
		await this.message(id, "system", `Run started: ${agents} agents x ${gens} generations (${mode})`);
		void (async () => {
			try {
				for (let gen = 0; gen < gens && !s.abort && !this.#closed; gen++) {
					run.gen = gen + 1; this.push(s);
					const best = s.best ? { source: s.best.source, ms: s.best.ms } : null;
					await Promise.all(Array.from({ length: agents }, async (_, a) => {
						for (let j = 0; j < perAgent; j++) {
							let source: string | undefined, via = "scripted";
							if (mode === "llm") {
								try { const c = await llmContribution({ task: s.task, lang: o.lang ?? "en", agent: a, gen, best }); source = c.source; via = c.model; }
								catch (e) { run.note = `${(e as Error).message}; scripted agent used`; }
							}
							source ??= s.task.variants[Math.floor(rnd() * s.task.variants.length)]!;
							await this.#enqueue(s, `agent-${a}`, via, gen + 1, source);
						}
					}));
					await this.#idle(s);
				}
			} catch (e) {
				run.note = (e as Error).message;
			} finally {
				run.active = false;
				await this.message(id, "system", `Run ${s.abort ? "stopped" : "finished"}${s.best ? `: best ${s.best.ms} ms` : ": no correct code"}`).catch(() => {});
				this.push(s);
			}
		})();
	}

	async stopRun(id: string): Promise<void> { const s = await this.session(id); s.abort = true; this.push(s); }
}
