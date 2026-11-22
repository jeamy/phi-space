// The rooms of the forum as the web process serves them. It holds no data of its own: a room's run, its answers and
// its lines live in the shared space, and the agents and model processes do the work. The hub reads a room into a
// snapshot, pushes a fresh one to the room's WebSocket clients when the space changes, and starts and stops runs.
// The pattern (change stream, debounced pushes, the room lock, the admin's choices) is taken over from
// codemode-chat/server/hub.ts.
import { FOREVER, NO_WAIT, UniqueConflict, type SpaceLike } from "phi-spaces";
import type { WsConnection } from "phi-spaces/ws";
import { ipTokensPerDay, MAX_AGENTS_PER_MODEL, MAX_MODELS, MIN_MODELS, runBudgetTokens, today } from "./limits.ts";
import { modelInfoOf, spentToday, type ModelInfoView, type Spend } from "./models.ts";
import { drawAliases, endRun, rid, startSpaceRun, systemLine, type RollCall, type RunEntry, type RunInfo, type RunParams } from "./run.ts";
import { entryLeaseMs, keepAlive, readExisting, StillHeld, takeAll, takeExisting, type ProcessInfo } from "./space.ts";

const LIMITS = { sessions: 50, lines: 200 };
/** How long the slots of a new run may wait for an agents process before the page says so. */
const SLOT_GRACE_MS = 15_000;
/** The room lock's transaction lease (renewed while the operation runs), and how long an operation waits for it. */
const ROOM_LOCK_LEASE_MS = 30_000, ROOM_LOCK_WAIT_MS = 60_000;

/** A room as this web process serves it: its WebSocket clients, the push timer, the per-minute request windows.
 *  Everything else is read from the space. */
type Session = { id: string; clients: Set<WsConnection>; buckets: Map<string, number[]>; pushTimer?: ReturnType<typeof setTimeout>; pushing: boolean; pushAgain: boolean; loading: Promise<void>; lastUsed: number;
	/** Serializes the operations that change the room's run. */
	tail: Promise<unknown> };

export type Line = { text: string; ts: number };
/** What the page shows of a room. */
export type Snapshot = { session: string; run: RunInfo | null; rollcall: Array<Omit<RollCall, "session">>; lines: Line[]; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number } };

export class ForumHub {
	/** The shared space of all processes (a RemoteSpace on the space host's socket). */
	readonly host: SpaceLike;
	#sessions = new Map<string, Session>();
	#closed = false;
	/** Lease of every room entry (FORUM_TTL_HOURS). */
	readonly #ttl: number;
	constructor(space: SpaceLike, o: { ttlMs?: number } = {}) {
		this.#ttl = o.ttlMs ?? entryLeaseMs(); this.host = space;
		void this.#watch();
	}

	/** The revision the space is at now: every page read names the revision of its snapshot (an empty one is enough). */
	async #currentRev(): Promise<number> { return (await this.host.readPage({ type: "-" }, { maxBytes: 1024 })).rev; }

	/** Follows the space's change stream (a long poll): a change to a room's entries, made by any process, pushes a fresh
	 *  snapshot to the room's clients. A removal names no room, so it pushes every watched room; the pushes are debounced. */
	async #watch(): Promise<void> {
		let rev = -1;
		while (!this.#closed) {
			try {
				if (rev < 0) { rev = await this.#currentRev(); for (const s of this.#sessions.values()) this.push(s); }
				const ch = await this.host.changes(rev, { waitMs: 20_000 });
				const rooms = new Set<string>();
				let removed = false;
				for (const b of ch.batches) for (const op of b.ops) {
					if (op.op === "del") removed = true;
					else if (typeof (op.fields as { session?: unknown }).session === "string") rooms.add((op.fields as { session: string }).session);
				}
				for (const s of this.#sessions.values()) if (s.clients.size && (removed || rooms.has(s.id))) this.push(s);
				rev = ch.next;
			} catch {
				if (this.#closed) return;
				rev = -1; // history dropped, or the space restarted: start again from where it is now
				await new Promise((r) => setTimeout(r, 1000));
			}
		}
	}

	/** Closes the hub. A run is not stopped by this: its ForumRun stays in the space and goes on. */
	async close(): Promise<void> {
		this.#closed = true;
		for (const s of this.#sessions.values()) { for (const c of s.clients) c.close(); clearTimeout(s.pushTimer); }
		this.#sessions.clear();
	}

	/** Per-session sliding window: at most `max` events of kind `key` per minute. */
	#allow(s: Session, key: string, max: number): boolean {
		const now = Date.now(), list = (s.buckets.get(key) ?? []).filter((t) => now - t < 60_000);
		if (list.length >= max) { s.buckets.set(key, list); return false; }
		list.push(now); s.buckets.set(key, list); return true;
	}

	/** Runs `fn` after every earlier exclusive operation of the room, in this process and in every other web process. */
	#exclusive<T>(s: Session, fn: () => Promise<T>): Promise<T> {
		const work = s.tail.catch(() => {}).then(() => this.#roomLock(s, fn));
		s.tail = work;
		return work;
	}

	/** The room's lock in the space (RoomLock, `unique` per room): taken under a transaction while `fn` runs and written
	 *  back after it, so another web process waits for it. A process that dies lets the transaction lapse and the lock
	 *  comes back. `fn` writes outside the lock's transaction: the lock serializes, it does not make `fn` atomic. */
	async #roomLock<T>(s: Session, fn: () => Promise<T>): Promise<T> {
		const t = await this.host.createTransaction(ROOM_LOCK_LEASE_MS);
		const stop = keepAlive(this.host, t.id, ROOM_LOCK_LEASE_MS);
		const lock = { type: "RoomLock", fields: { session: s.id } };
		try {
			let took = false;
			for (const end = Date.now() + ROOM_LOCK_WAIT_MS; ; ) {
				try { took = !!(await takeExisting(this.host, lock, { txn: t.id })); }
				catch (e) { if (!(e instanceof StillHeld)) throw e; if (Date.now() > end) throw new Error("The room is busy; try again"); continue; } // another process holds it
				if (took) break;
				// no lock yet: this transaction makes it (a second process that does the same at once is refused, and waits)
				try { await this.host.write({ type: "RoomLock", fields: { session: s.id, ts: Date.now() } }, t.id, this.#ttl, { unique: ["session"] }); break; }
				catch (e) { if (!(e instanceof UniqueConflict)) throw e; }
			}
			const v = await fn();
			if (took) await this.host.write({ type: "RoomLock", fields: { session: s.id, ts: Date.now() } }, t.id, this.#ttl);
			await this.host.commit(t.id);
			return v;
		} catch (e) { await this.host.abort(t.id).catch(() => {}); throw e; }
		finally { stop(); }
	}

	/** Drops the least recently used room that nobody watches; its entries stay in the space. */
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
			if (this.#sessions.size >= LIMITS.sessions) throw new Error("Too many rooms");
			s = { id, clients: new Set(), buckets: new Map(), pushing: false, pushAgain: false, loading: Promise.resolve(), lastUsed: Date.now(), tail: Promise.resolve() };
			this.#sessions.set(id, s);
			s.loading = this.#load(s);
		}
		s.lastUsed = Date.now();
		try { await s.loading; } catch (e) { if (this.#sessions.get(id) === s) this.#sessions.delete(id); throw e; }
		return s;
	}

	async #load(s: Session): Promise<void> {
		if (!(await this.host.readIfExists({ type: "ForumRoom", fields: { session: s.id } }, NO_WAIT))) await this.host.write({ type: "ForumRoom", fields: { session: s.id, ts: Date.now() } }, null, this.#ttl);
		// work items of runs that are gone (an item an agent held while the run was stopped comes back later)
		const gone = new Map<string, boolean>();
		for (const e of await this.host.readAll({ type: "WorkItem", fields: { session: s.id } }, { limit: 2000 })) {
			const runId = String((e.fields as { runId?: unknown }).runId);
			if (!gone.has(runId)) gone.set(runId, !(await readExisting(this.host, { type: "ForumRun", fields: { session: s.id, runId } }).catch(() => true))); // held for long: not gone
			if (gone.get(runId)) await this.host.take({ id: e.id }, NO_WAIT);
		}
	}

	/** What the model processes say about the models (their ModelInfo entries, merged). */
	modelInfo(): Promise<ModelInfoView> { return modelInfoOf(this.host); }

	/** The admin's choices as saved in the space (what the model process takes over within 10 s). */
	async adminChoice(): Promise<{ allowed?: string[]; custom?: boolean; on?: boolean }> {
		const m = (await this.host.readIfExists({ type: "ForumAdmin", fields: { key: "models" } }, NO_WAIT))?.fields as { allowed?: unknown } | undefined;
		const l = (await this.host.readIfExists({ type: "ForumAdmin", fields: { key: "llm" } }, NO_WAIT))?.fields as { on?: unknown } | undefined;
		return { ...(Array.isArray(m?.allowed) ? { allowed: m!.allowed.map(String), custom: true } : {}), ...(typeof l?.on === "boolean" ? { on: l.on } : {}) };
	}

	/** The admin's switch, kept in the space for the model process (ForumAdmin "llm"). */
	async saveLlmOn(on: boolean): Promise<void> {
		await takeAll(this.host, { type: "ForumAdmin", fields: { key: "llm" } });
		await this.host.write({ type: "ForumAdmin", fields: { key: "llm", on, ts: Date.now() } }, null, FOREVER);
	}

	/** The admin's choice of models, kept in the space so it outlives a restart; null: the choice of FORUM_MODELS. */
	async saveAllowedModels(labels: string[] | null): Promise<void> {
		await takeAll(this.host, { type: "ForumAdmin", fields: { key: "models" } });
		if (labels) await this.host.write({ type: "ForumAdmin", fields: { key: "models", allowed: labels, ts: Date.now() } }, null, FOREVER);
	}

	/** The room's active run (one an agent holds for a moment is waited for; one held for longer throws StillHeld rather
	 *  than pass for no run). */
	async #runNow(s: Session): Promise<RunInfo | null> {
		const r = (await readExisting(this.host, { type: "ForumRun", fields: { session: s.id } }))?.fields as unknown as RunEntry | undefined;
		if (!r) return null;
		// slots no agents process took up: those agents' work waits, which the page says
		const waiting = await this.host.count({ type: "AgentSlot", fields: { session: s.id, runId: r.runId } });
		const late = waiting > 0 && Date.now() - r.params.startedAt > SLOT_GRACE_MS;
		return { ...r.info, active: true, ...(late ? { note: `${waiting} of ${r.params.models.length * r.params.perModel} agents wait for a free slot in an agents process (FORUM_AGENT_SLOTS); their work waits meanwhile` } : {}) };
	}

	/** What the page shows as the room's run: the active one, else how the last one ended. */
	async #runShown(s: Session): Promise<RunInfo | null> {
		const now = await this.#runNow(s);
		if (now) return now;
		const last = (await this.host.readAll({ type: "ForumRunDone", fields: { session: s.id } }, { limit: 5 })).map((e) => e.fields as unknown as { info: RunInfo; ts: number }).sort((a, b) => b.ts - a.ts)[0];
		return last?.info ?? null;
	}

	async snapshot(id: string): Promise<Snapshot> {
		const s = await this.session(id);
		// the run first: its end is then never shown without the lines and answers written with it
		const run = await this.#runShown(s);
		const rollcall = run ? (await this.host.readAll({ type: "RollCall", fields: { session: s.id, runId: run.runId } }, { limit: 50 })).map((e) => { const { session: _s, ...rest } = e.fields as unknown as RollCall; return rest; }).sort((a, b) => a.alias.localeCompare(b.alias)) : [];
		const lines = (await this.host.readAll({ type: "ForumLine", fields: { session: s.id } }, { limit: LIMITS.lines + 50 })).map((e) => e.fields as unknown as Line & { session: string }).sort((a, b) => a.ts - b.ts).slice(-LIMITS.lines).map(({ text, ts }) => ({ text, ts }));
		return { session: s.id, run, rollcall, lines, limits: { minModels: MIN_MODELS, maxModels: MAX_MODELS, maxPerModel: MAX_AGENTS_PER_MODEL, visitorTokens: runBudgetTokens() } };
	}

	/** Push a fresh snapshot to every client of the room (debounced, so a burst of writes sends one frame). One snapshot
	 *  is built at a time, so frames never overtake each other; a push during a build sends one more after it. */
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
				if (!this.#closed) console.error("[forum] snapshot push failed", (e as Error).message);
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

	/** Beyond the cap the oldest lines of a room give way. */
	async #trimLines(s: Session): Promise<void> {
		const tmpl = { type: "ForumLine", fields: { session: s.id } };
		if ((await this.host.count(tmpl)) < LIMITS.lines) return;
		const old = (await this.host.readAll(tmpl, { limit: LIMITS.lines + 50 })).sort((a, b) => Number((a.fields as { ts: number }).ts) - Number((b.fields as { ts: number }).ts));
		for (const e of old.slice(0, old.length - LIMITS.lines + 2)) await this.host.take({ id: e.id }, NO_WAIT);
	}

	/** The processes that are there, by host (their Process entries), and what the model calls of today used. */
	async systemInfo(): Promise<{ hosts: Array<{ name: string; roles: string[]; host: ProcessInfo }>; today: { calls: number; tokens: number; costUsd: number } }> {
		const procs = (await this.host.readAll({ type: "Process" }, { limit: 200 })).map((e) => e.fields as unknown as ProcessInfo);
		const hosts = new Map<string, { host: ProcessInfo; roles: Set<string> }>();
		for (const p of procs.sort((a, b) => a.startedAt - b.startedAt)) {
			const h = hosts.get(p.name) ?? { host: p, roles: new Set<string>() };
			h.roles.add(p.role); hosts.set(p.name, h);
		}
		const order = ["space", "web", "agents", "model"];
		const spends = (await this.host.readAll({ type: "Spend", fields: { day: today() } }, { limit: 5000 })).map((e) => e.fields as unknown as Spend);
		return {
			hosts: [...hosts.entries()].map(([name, { host, roles }]) => ({ name, roles: order.filter((r) => roles.has(r)), host })),
			today: { calls: spends.length, tokens: spends.reduce((n, x) => n + x.tokens, 0), costUsd: spends.reduce((n, x) => n + x.costUsd, 0) },
		};
	}

	/** Starts a run in the room: at least three models, the same number of agents for each, a budget. Until the plan
	 *  work exists, a run is its opening alone: the roll call, in which every model says that it is there.
	 *  `client` is set by the server, never from the request body: a visitor's run gets the default budget at most and
	 *  counts against the day's allowance of the address. Without it (tests, scripts in-process) it counts as admin. */
	async startRun(id: string, o: { models?: unknown; perModel?: unknown; lang?: unknown; budgetTokens?: unknown; budgetUsd?: unknown; client?: { ip: string; admin: boolean } }): Promise<{ runId: string }> {
		const s = await this.session(id);
		if (!this.#allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		const models = [...new Set(Array.isArray(o.models) ? o.models.map(String) : [])];
		if (models.length < MIN_MODELS) throw new Error(`A run needs at least ${MIN_MODELS} different models`);
		if (models.length > MAX_MODELS) throw new Error(`A run takes at most ${MAX_MODELS} models`);
		const { info } = await this.modelInfo();
		const allowed = info.enabled && info.on ? info.models.map((m) => m.label) : [];
		for (const m of models) if (!allowed.includes(m)) throw new Error(`Model not available: ${m}`);
		const perModel = Math.min(MAX_AGENTS_PER_MODEL, Math.max(1, Math.floor(Number(o.perModel ?? 1)) || 1));
		const positive = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined; };
		const visitor = o.client && !o.client.admin ? o.client : undefined;
		// a visitor's run never goes without a token limit, and never above the default one
		const cap = visitor ? runBudgetTokens() : 0;
		const tokens = positive(o.budgetTokens) ? Math.floor(positive(o.budgetTokens)!) : undefined;
		const budgetTokens = cap ? Math.min(tokens ?? cap, cap) : tokens;
		const budget = { ...(budgetTokens ? { tokens: budgetTokens } : {}), ...(positive(o.budgetUsd) ? { usd: positive(o.budgetUsd)! } : {}) };
		if (!Object.keys(budget).length) throw new Error("A run needs a budget in tokens or dollars");
		if (visitor && ipTokensPerDay() && (await spentToday(this.host, visitor.ip)) >= ipTokensPerDay()) throw new Error("The model budget of today for your address is used up (FORUM_TOKENS_PER_IP_DAY); try again tomorrow");
		const params: RunParams = { runId: `r${Date.now().toString(36)}${rid()}`, startedAt: Date.now(), models, perModel, aliases: drawAliases(models), lang: o.lang === "de" ? "de" : "en", budget, ...(o.client ? { client: { ip: o.client.ip, admin: o.client.admin } } : {}) };
		await this.#trimLines(s);
		// checked and written under the room's lock and in one transaction: the ForumRun is unique per room, so of two
		// requests only one starts a run; the agent processes carry it out (model calls by the model process)
		await this.#exclusive(s, async () => {
			if (await this.#runNow(s)) throw new Error("A run is already active");
			const limits = [budget.tokens ? `${budget.tokens} tokens` : "", budget.usd ? `$${budget.usd}` : ""].filter(Boolean).join(" / ");
			const t = await this.host.createTransaction(30_000);
			try {
				await startSpaceRun(this.host, t.id, this.#ttl, { session: s.id, params });
				await systemLine(this.host, t.id, this.#ttl, s.id, `Run started with a roll call: ${models.length} models, ${perModel} agent${perModel === 1 ? "" : "s"} each, budget ${limits}`);
				await this.host.commit(t.id);
			} catch (e) {
				await this.host.abort(t.id).catch(() => {});
				throw e instanceof UniqueConflict ? new Error("A run is already active") : e;
			}
		});
		this.push(s);
		return { runId: params.runId };
	}

	/** Stops the room's run: whoever takes its ForumRun ends it, with its closing line, exactly once. */
	async stopRun(id: string): Promise<void> {
		const s = await this.session(id);
		const e = await readExisting(this.host, { type: "ForumRun", fields: { session: s.id } });
		const runId = (e?.fields as { runId?: string } | undefined)?.runId;
		if (runId) {
			const t = await this.host.createTransaction(30_000);
			try { await endRun(this.host, t.id, this.#ttl, s.id, runId, "stopped"); await this.host.commit(t.id); }
			catch (err) { await this.host.abort(t.id).catch(() => {}); throw err; }
		}
		this.push(s);
	}
}
