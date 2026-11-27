// The rooms of the forum as the web process serves them. It holds no data of its own: a room's run, its answers and
// its lines live in the shared space, and the agents and model processes do the work. The hub reads a room into a
// snapshot, pushes a fresh one to the room's WebSocket clients when the space changes, creates plan tasks (each a block
// of the room, with its document), and starts and stops runs.
// The pattern (change stream, debounced pushes, the room lock, the admin's choices) is taken over from
// codemode-chat/server/hub.ts.
import { createHash } from "node:crypto";
import { FOREVER, NO_WAIT, UniqueConflict, type SpaceLike } from "phi-spaces";
import type { WsConnection } from "phi-spaces/ws";
import { MAX_AGENTS_PER_MODEL, MAX_MODELS, MIN_MODELS, today } from "./limits.ts";
import { ceilings, checkRoom, effectiveLimits, readLimits, readRoom, saveRoom, type RoomDefaults } from "./settings.ts";
import { modelInfoOf, spentToday, type ModelInfoView, type Spend } from "./models.ts";
import { fullDoc, headOf, versionsOf, type FullDoc, type PlanDoc } from "./plandoc.ts";
import { planTask, type PlanTask } from "./plantask.ts";
import { checkOf } from "./check-host.ts";
import type { Failure } from "./checks.ts";
import { askSources, indexPages, sourceWaitMs } from "./source-host.ts";
import { remoteLimits } from "./remote.ts";
import { checkDocs, docsPack, indexHash, readable, type IndexEntry, type PlanSource } from "./sources.ts";
import { agentOf, askFiles, fileNotes, PICTURE_TYPES, saveFileNote, UPLOAD, uploadName, type UploadAnswer, type UploadDone, checkFolder, filesInfo, filesWaitMs, folderName, readLink, saveLink, type CheckAnswer, type FilesInfo, type RoomLink } from "./files.ts";
import { decisionsOf, messagesOf, newMsgId, owed, PERSON_TABLE, TALK_LIMITS, type PlanDecision, type PlanMessage } from "./talk.ts";
import { objectionsOf, type PlanObjection } from "./review.ts";
import { acceptOf, ballotsOf, type PlanAccept, type PlanBallot } from "./ballots.ts";
import { MAX_ROUNDS, runType, TABLE_SHARE, tableInfo } from "./run.ts";
import { comparesOf, resultOf, standings, type PlanCompare, type PlanStrategyStat } from "./compare.ts";
import { chosenOf, exportPlan, type Chosen } from "./export.ts";
import { drawAliases, endRun, rid, startSpaceRun, systemLine, type RollCall, type RunEntry, type RunInfo, type RunParams } from "./run.ts";
import { addImage, imageData, imagesOf, imageViews, noteImage, removeImage, type ImageView } from "./images.ts";
import { entryLeaseMs, keepAlive, readExisting, StillHeld, takeAll, takeExisting, type ProcessInfo } from "./space.ts";

const LIMITS = { sessions: 50, lines: 200, blocks: 30 };
type Table = "A" | "B";
const asTable = (v: unknown): Table | undefined => (v === "A" || v === "B" ? v : undefined);
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
/** A plan task of the room with the state of its document: the newest version's sections, without their texts. */
export type Block = Omit<PlanTask, "session"> & {
	/** The pictures the task holds for the models (images.ts). */
	images: number;
	/** The table whose document and discussion the block shows: the one of the newest run on it, else one that has a
	 *  document. */
	table: Table;
	/** The newest version of each table's document on this block (a table without a document is missing). */
	heads: Partial<Record<Table, number>>;
	/** The result of the newest run with both tables on this block: a table and a version of its document. */
	result: { table: Table; version: number } | null;
	/** The version the table (or the person) accepted; null: none yet. */
	accepted: Pick<PlanAccept, "version" | "by" | "who" | "approvals" | "of" | "round"> | null; sources: Array<Pick<PlanSource, "sourceId" | "kind" | "name" | "url" | "commit" | "ref" | "files" | "bytes" | "tenant" | "texts">>;
	/** The table's discussion in numbers: messages, decisions, and the questions to the person still open. */
	talk: { messages: number; decisions: number; forPerson: number }; doc: { table: string; version: number; versions: number; bytes: number; sections: PlanDoc["sections"];
		/** The mechanical check of the newest version (checks.ts); null: not checked yet. */
		check: { ok: boolean; failures: Failure[] } | null } | null };
/** A version of a block's document with its texts, and the versions there are. */
export type PlanView = { blockId: string; doc: Omit<FullDoc, "session" | "slot">; check: { ok: boolean; failures: Failure[] } | null; versions: Array<Pick<PlanDoc, "version" | "author" | "model" | "changed" | "ts">> };
/** What the page shows of a room. `blocks`: oldest first; a run works on the block it names. */
export type Snapshot = { /** Over all runs with both tables: how often each table's document was the base of the result. */
	standings: { runs: number; A: number; B: number; tokens: Record<Table, number> }; session: string; blocks: Block[]; run: RunInfo | null; rollcall: Array<Omit<RollCall, "session">>; lines: Line[]; limits: { minModels: number; maxModels: number; maxPerModel: number; visitorTokens: number };
	/** The room owner's defaults for a run (settings.ts). */
	defaults?: RoomDefaults;
	/** The room's link to a spaces-files workspace (files.ts), if it has one. */
	link?: Pick<RoomLink, "tenant" | "read" | "project"> | null };

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
			if (!gone.has(runId)) gone.set(runId, !(await readExisting(this.host, { type: runType(runId), fields: { session: s.id, runId } }).catch(() => true))); // held for long: not gone
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
		const waiting = await this.host.count({ type: "AgentSlot", fields: { session: s.id, ...(r.params.both ? {} : { runId: r.runId }) } });
		const late = waiting > 0 && Date.now() - r.params.startedAt > SLOT_GRACE_MS;
		// a run with both tables: the tables that still work are shown as they are now, and what they used so far counts
		// (read one by one: a table's entry an agent holds for a moment is waited for, not taken for gone)
		if (r.params.both) for (const t of ["A", "B", "F"]) {
			const k = (await readExisting(this.host, { type: "TableRun", fields: { session: s.id, runId: `${r.runId}-${t}` } }).catch(() => null))?.fields as unknown as RunEntry | undefined;
			if (!k) continue;
			if (k.params.final) r.info.final = { ...(r.info.final ?? { points: 0 }), active: tableInfo(k.info, true) };
			else r.info.tables = { ...r.info.tables, [k.params.table]: tableInfo(k.info, true) };
			r.info.usage = { tokens: r.info.usage.tokens + k.info.usage.tokens, costUsd: r.info.usage.costUsd + k.info.usage.costUsd };
		}
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
		// (a run with both tables has a roll call at each: the one of table A is shown, else B's)
		const calls = run ? await this.host.readAll({ type: "RollCall", fields: { session: s.id } }, { limit: 200 }) : [];
		const rollcall = run ? (run.both ? ["A", "B"].map((t) => calls.filter((e) => (e.fields as { runId?: string }).runId === `${run.runId}-${t}`)).find((x) => x.length) ?? [] : calls.filter((e) => (e.fields as { runId?: string }).runId === run.runId)).map((e) => { const { session: _s, ...rest } = e.fields as unknown as RollCall; return rest; }).sort((a, b) => a.alias.localeCompare(b.alias)) : [];
		const lines = (await this.host.readAll({ type: "ForumLine", fields: { session: s.id } }, { limit: LIMITS.lines + 50 })).map((e) => e.fields as unknown as Line & { session: string }).sort((a, b) => a.ts - b.ts).slice(-LIMITS.lines).map(({ text, ts }) => ({ text, ts }));
		const tasks = (await this.#tasks(s.id));
		const blocks = await Promise.all(tasks.map(async ({ session: _s, ...t }): Promise<Block> => {
			const TABLE = await this.#tableOf(s.id, t.blockId, run);
			const versions = await versionsOf(this.host, { session: s.id, blockId: t.blockId, table: TABLE }), head = versions.at(-1);
			const sources = (await this.host.readAll({ type: "PlanSource", fields: { session: s.id, blockId: t.blockId } }, { limit: 4 })).map((e) => e.fields as unknown as PlanSource).sort((a, b) => a.sourceId.localeCompare(b.sourceId))
				.map(({ sourceId, kind, name, url, commit, ref, files, bytes, tenant, texts }) => ({ sourceId, kind, name, ...(url ? { url } : {}), ...(commit ? { commit } : {}), ...(ref ? { ref } : {}), ...(tenant ? { tenant } : {}), ...(texts !== undefined ? { texts } : {}), files, bytes }));
			const d = { session: s.id, blockId: t.blockId, table: TABLE }, messages = await messagesOf(this.host, d);
			const talk = { messages: messages.length, decisions: (await decisionsOf(this.host, d)).length, forPerson: owed(messages, [], {}).person.length };
			const check = head ? await checkOf(this.host, d, head.version) : null;
			const acc = await acceptOf(this.host, d);
			const res = await resultOf(this.host, s.id, t.blockId);
			const heads: Block["heads"] = {};
			for (const x of ["A", "B"] as const) { const h = x === TABLE ? head : await headOf(this.host, { ...d, table: x }); if (h) heads[x] = h.version; }
			return { ...t, images: await this.host.count({ type: "TaskImage", fields: { session: s.id, blockId: t.blockId } }), table: TABLE, heads, result: res ? { table: res.table, version: res.version } : null, accepted: acc ? { version: acc.version, by: acc.by, ...(acc.who ? { who: acc.who } : {}), approvals: acc.approvals, of: acc.of, ...(acc.round ? { round: acc.round } : {}) } : null, sources, talk, doc: head ? { table: TABLE, version: head.version, versions: versions.length, bytes: head.bytes, sections: head.sections, check: check ? { ok: check.ok, failures: check.failures } : null } : null };
		}));
		return { standings: await standings(this.host), session: s.id, blocks, run, rollcall, lines, limits: { minModels: MIN_MODELS, maxModels: MAX_MODELS, maxPerModel: MAX_AGENTS_PER_MODEL, visitorTokens: effectiveLimits(await readLimits(this.host)).runBudgetTokens }, defaults: await readRoom(this.host, s.id), link: await readLink(this.host, s.id).then((l) => (l ? { tenant: l.tenant, read: l.read, project: l.project } : null)) };
	}

	/** A room's state for a list of rooms, read without opening the room (no session, no ForumRoom entry): "waiting" while
	 *  a run waits for the person (a question to them, or stuck) or a question to them is open at a task's table, "running" while a run works, "ready" when a plan task has
	 *  an accepted version or a result, "idle" when it has tasks and none of these, "new" without a task. */
	async summary(id: string): Promise<{ state: "new" | "idle" | "running" | "waiting" | "ready"; tasks: number }> {
		const tasks = await this.#tasks(id);
		const r = await readExisting(this.host, { type: "ForumRun", fields: { session: id } }).catch(() => "held" as const);
		if (r) {
			if (r === "held") return { state: "running", tasks: tasks.length };
			const info = (r.fields as unknown as RunEntry).info;
			const owes = info.phase === "stalled" || owed(await messagesOf(this.host, { session: id, blockId: info.blockId, table: info.table }), [], {}).person.length > 0;
			return { state: owes ? "waiting" : "running", tasks: tasks.length };
		}
		// a question to the person stays open after a run ends: the room's page counts it (talk.forPerson), so does the list
		const last = (await this.host.readAll({ type: "ForumRunDone", fields: { session: id } }, { limit: 5 })).map((e) => e.fields as unknown as { info: RunInfo; ts: number }).sort((a, b) => b.ts - a.ts)[0]?.info ?? null;
		for (const t of tasks) if (owed(await messagesOf(this.host, { session: id, blockId: t.blockId, table: await this.#tableOf(id, t.blockId, last) }), [], {}).person.length) return { state: "waiting", tasks: tasks.length };
		for (const t of tasks) if ((await acceptOf(this.host, { session: id, blockId: t.blockId, table: "A" })) || (await acceptOf(this.host, { session: id, blockId: t.blockId, table: "B" })) || (await resultOf(this.host, id, t.blockId))) return { state: "ready", tasks: tasks.length };
		return { state: tasks.length ? "idle" : "new", tasks: tasks.length };
	}

	/** The table of a block that is shown when none is asked for: the one the room's run (active or last) works at on
	 *  this block, else table B if it has a document, else A. */
	async #tableOf(session: string, blockId: string, run?: RunInfo | null): Promise<Table> {
		if (run === undefined) run = await this.#runShown(await this.session(session));
		if (run?.blockId === blockId) return run.table;
		return (await headOf(this.host, { session, blockId, table: "B" })) ? "B" : "A";
	}

	/** The room's plan tasks, oldest first. */
	async #tasks(session: string): Promise<PlanTask[]> {
		return (await this.host.readAll({ type: "PlanTask", fields: { session } }, { limit: LIMITS.blocks + 10 })).map((e) => e.fields as unknown as PlanTask).sort((a, b) => a.ts - b.ts);
	}

	/** The repositories the sources processes offer, by name (their SourceInfo entries). */
	async repos(): Promise<string[]> {
		return [...new Set((await this.host.readAll({ type: "SourceInfo" }, { limit: 20 })).flatMap((e) => (e.fields as { repos?: unknown }).repos as string[] ?? []))].sort();
	}

	/** The hosts a remote repository may be fetched from, as the sources processes say (FORUM_GIT_HOSTS there). */
	async gitHosts(): Promise<string[]> {
		return [...new Set((await this.host.readAll({ type: "SourceInfo" }, { limit: 20 })).flatMap((e) => (e.fields as { hosts?: unknown }).hosts as string[] ?? []))].sort();
	}

	/** A new plan task: a block of the room, with its sources fixed now: uploaded documents (`docs`: name and text
	 *  each), kept in the space, and a repository at a branch, tag or commit (`repo`: one of the sources process by its
	 *  `name`, or a remote one by its https `url`, which the sources process fetches now if its host is allowed; the
	 *  server lets only an admin name one: `admin`). Its document begins with the first run on it. */
	async createTask(id: string, o: { brief?: unknown; lang?: unknown; outline?: unknown; criteria?: unknown; docs?: unknown; repo?: unknown; files?: unknown; admin?: boolean }): Promise<{ blockId: string }> {
		const s = await this.session(id);
		const task = planTask(o), docs = checkDocs(o.docs), blockId = `b${Date.now().toString(36)}${rid()}`;
		const repo = o.repo && typeof o.repo === "object" ? { name: String((o.repo as { name?: unknown }).name ?? ""), url: String((o.repo as { url?: unknown }).url ?? "").trim(), ref: String((o.repo as { ref?: unknown }).ref ?? "").trim() || "HEAD" } : null;
		if (repo && o.admin === false) throw new Error("A repository as a source needs the admin login");
		if (repo?.url && repo.name) throw new Error("Name a repository of the sources process or a remote one, not both");
		if (repo?.url && !/^https?:\/\//i.test(repo.url)) throw new Error("A remote repository is named by its https address");
		if (repo && !repo.url && !(await this.repos()).includes(repo.name)) throw new Error(`No such repository: ${repo.name.slice(0, 60)}`);
		const files = o.files === true;
		if (files && !(await readLink(this.host, s.id))) throw new Error("The room is not linked to a workspace");
		if (!this.#allow(s, "task", 6)) throw new Error("Too many tasks, slow down");
		await this.#trimLines(s);
		await this.#exclusive(s, async () => {
			if ((await this.#tasks(s.id)).length >= LIMITS.blocks) throw new Error(`A room holds at most ${LIMITS.blocks} plan tasks`);
			const sources: PlanSource[] = [], key = { session: s.id, blockId };
			// the repository first: its sources process resolves the commit and writes the pack's index, or says why not
			if (repo) {
				// a remote repository is fetched while this waits: as long as a fetch may take, and the usual wait on top
				const { opened } = repo.url
					? await askSources(this.host, { requestId: `open-${blockId}`, ...key, op: "open", url: repo.url, ref: repo.ref, ttl: this.#ttl, ts: Date.now() }, sourceWaitMs() + remoteLimits().ms)
					: await askSources(this.host, { requestId: `open-${blockId}`, ...key, op: "open", repo: repo.name, ref: repo.ref, ttl: this.#ttl, ts: Date.now() });
				sources.push({ ...key, sourceId: "repo", kind: "repo", ...opened!, ts: Date.now() });
			}
			// the room's workspace folders: the sources process copies them now, as they are (files.ts)
			if (files) {
				const { snapshot: c } = await askFiles(this.host, { requestId: `copy-${blockId}`, session: s.id, op: "snapshot", blockId, ttl: this.#ttl, ts: Date.now() }, sourceWaitMs() + filesWaitMs());
				sources.push({ ...key, sourceId: "files", kind: "files", name: "workspace", copy: c!.copy, tenant: c!.tenant, files: c!.files, texts: c!.texts, bytes: c!.bytes, indexHash: c!.indexHash, ts: Date.now() });
			}
			if (docs.length) {
				const pack = docsPack(docs);
				// a document in parts of 12 000 characters: an entry stays under the space's 64 KiB whatever the letters
				for (const d of docs) for (let part = 0; part * 12_000 < d.text.length; part++) await this.host.write({ type: "SourceFile", fields: { ...key, path: d.path, part, text: d.text.slice(part * 12_000, (part + 1) * 12_000) } }, null, this.#ttl);
				for (const [part, paths] of indexPages(pack.index).entries()) await this.host.write({ type: "SourceIndex", fields: { ...key, sourceId: "docs", part, parts: 1, paths } as never }, null, this.#ttl);
				sources.push({ ...key, sourceId: "docs", kind: "docs", name: "documents", files: pack.index.length, bytes: pack.index.reduce((n, [, size]) => n + size, 0), indexHash: indexHash(pack.index), ts: Date.now() });
			}
			for (const src of sources) await this.host.write({ type: "PlanSource", fields: src as never }, null, this.#ttl);
			const entry: PlanTask = { ...key, ...task, ts: Date.now() };
			await this.host.write({ type: "PlanTask", fields: entry as never }, null, this.#ttl);
			const with_ = sources.map((x) => (x.kind === "repo" ? `${x.name} at ${x.commit!.slice(0, 12)} (${x.files} files)` : x.kind === "files" ? `the workspace's ${x.files} file${x.files === 1 ? "" : "s"} (${x.texts} as text)` : `${x.files} document${x.files === 1 ? "" : "s"}`)).join(" and ");
			await systemLine(this.host, null, this.#ttl, s.id, `Plan task created${with_ ? ` with ${with_}` : ""}: ${task.brief.replace(/\s+/g, " ").slice(0, 100)}${task.brief.length > 100 ? "…" : ""}`);
		});
		this.push(s);
		return { blockId };
	}

	/** A version of a block's document with its texts (the newest unless `version` names one); null: no such block or
	 *  version. A block without a document yet has none. */
	async plan(id: string, blockId: string, version?: number, table?: unknown): Promise<PlanView | null> {
		const d = { session: id, blockId, table: asTable(table) ?? (await this.#tableOf(id, blockId)) };
		const versions = await versionsOf(this.host, d), doc = version === undefined ? versions.at(-1) : versions.find((v) => v.version === version);
		if (!doc) return null;
		const { session: _s, slot: _k, ...full } = await fullDoc(this.host, doc);
		const check = await checkOf(this.host, d, doc.version);
		return { blockId, doc: full, check: check ? { ok: check.ok, failures: check.failures } : null, versions: versions.map(({ version, author, model, changed, ts }) => ({ version, author, model, changed, ts })) };
	}

	/** The discussion of a block: its messages, oldest first, and the decisions. */
	async talk(id: string, blockId: string, table?: unknown): Promise<{ table: Table; messages: Array<Omit<PlanMessage, "session">>; decisions: Array<Omit<PlanDecision, "session">>; objections: Array<Omit<PlanObjection, "session">>; ballots: Array<Omit<PlanBallot, "session" | "slot">> }> {
		const d = { session: id, blockId, table: asTable(table) ?? (await this.#tableOf(id, blockId)) };
		return { table: d.table, ballots: (await ballotsOf(this.host, d)).map(({ session: _s, slot: _k, ...b }) => b), objections: (await objectionsOf(this.host, d)).map(({ session: _s, ...o }) => o), messages: (await messagesOf(this.host, d)).map(({ session: _s, ...m }) => m), decisions: (await decisionsOf(this.host, d)).map(({ session: _s, ...x }) => x) };
	}

	/** What a person says to the table: an answer in a thread (`thread`: the id of the message it answers), or a note of
	 *  its own. Every model call after it has it in its context, before the table's decisions. */
	async say(id: string, o: { blockId?: unknown; thread?: unknown; text?: unknown; by?: unknown }): Promise<{ msgId: string }> {
		const s = await this.session(id);
		const text = String(o.text ?? "").replace(/\r\n/g, "\n").trim();
		if (!text) throw new Error("Say something");
		if (text.length > TALK_LIMITS.text) throw new Error(`A message has at most ${TALK_LIMITS.text} characters`);
		const task = (await this.#tasks(s.id)).find((t) => t.blockId === String(o.blockId ?? ""));
		if (!task) throw new Error("Unknown plan task");
		if (!this.#allow(s, "message", 20)) throw new Error("Too many messages, slow down");
		// said to the block: every table reads it (a thread may be of either table)
		const d = { session: s.id, blockId: task.blockId, table: PERSON_TABLE };
		const root = o.thread ? (await Promise.all((["A", "B"] as const).map((table) => messagesOf(this.host, { ...d, table })))).flat().find((m) => m.msgId === String(o.thread)) : undefined;
		if (o.thread && !root) throw new Error("Unknown message to answer");
		const msgId = newMsgId();
		const m: PlanMessage = { ...d, msgId, thread: root?.thread ?? msgId, kind: root?.kind === "question" ? "answer" : "note", author: String(o.by ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "guest", model: "human", text, round: 0, ts: Date.now() };
		await this.host.write({ type: "PlanMessage", fields: m as never }, null, this.#ttl);
		this.push(s);
		return { msgId };
	}

	/** A person accepts a version of a block's document (the newest unless `version` names one): their word is final.
	 *  A run on the block ends with it. */
	async accept(id: string, o: { blockId?: unknown; version?: unknown; by?: unknown; table?: unknown }): Promise<{ version: number }> {
		const s = await this.session(id), blockId = String(o.blockId ?? "");
		if (!(await this.#tasks(s.id)).some((t) => t.blockId === blockId)) throw new Error("Unknown plan task");
		const d = { session: s.id, blockId, table: asTable(o.table) ?? (await this.#tableOf(s.id, blockId)) };
		const doc = await headOf(this.host, d, o.version === undefined || o.version === null || o.version === "" ? undefined : Number(o.version));
		if (!doc) throw new Error("No such version to accept");
		const who = String(o.by ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "guest";
		const accept: PlanAccept = { ...d, version: doc.version, by: "person", who, approvals: [], of: 0, ts: Date.now() };
		await this.host.write({ type: "PlanAccept", fields: accept as never }, null, this.#ttl);
		await systemLine(this.host, null, this.#ttl, s.id, `${who} accepted version ${doc.version} of table ${d.table}`);
		const run = await this.#runNow(s);
		if (run?.blockId === blockId) await this.stopRun(id);
		this.push(s);
		return { version: doc.version };
	}

	/** A person objects to a section of a block's document (`section`: its heading or id): an objection no reviser can
	 *  decline, and no version is accepted by the table while it is open. The next round of a run takes it up. */
	async object(id: string, o: { blockId?: unknown; section?: unknown; text?: unknown; fix?: unknown; by?: unknown; table?: unknown }): Promise<{ objId: string }> {
		const s = await this.session(id), blockId = String(o.blockId ?? ""), text = String(o.text ?? "").replace(/\s+/g, " ").trim();
		if (!text) throw new Error("Say what is wrong");
		if (text.length > 600) throw new Error("An objection has at most 600 characters");
		if (!this.#allow(s, "message", 20)) throw new Error("Too many messages, slow down");
		const d = { session: s.id, blockId, table: asTable(o.table) ?? (await this.#tableOf(s.id, blockId)) }, head = await headOf(this.host, d);
		const section = head?.sections.find((x) => x.sectionId === o.section || x.title.toLowerCase() === String(o.section ?? "").trim().toLowerCase());
		if (!section) throw new Error("Name the section the objection is about");
		const run = await this.#runNow(s);
		const objection: PlanObjection = { ...d, runId: run?.blockId === blockId ? run.runId : "", objId: `o${rid()}`, sectionId: section.sectionId, defect: text, fix: String(o.fix ?? "").replace(/\s+/g, " ").trim().slice(0, 600) || "as the person says", author: String(o.by ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "guest", model: "human", round: run?.round ?? 0, state: "open", ts: Date.now() };
		await this.host.write({ type: "PlanObjection", fields: objection as never }, null, this.#ttl);
		await systemLine(this.host, null, this.#ttl, s.id, `${objection.author} objects to "${section.title}": ${text.slice(0, 120)}`);
		this.push(s);
		return { objId: objection.objId };
	}

	/** A block's result as Markdown (export.ts): the plan and, unless `plain`, the generated appendix. Without `table`
	 *  and `version` the result: what a person accepted, else what the run with both tables ended with, else what a
	 *  table accepted, else the newest draft of the table shown. null: no document. */
	async planMarkdown(id: string, blockId: string, o: { table?: unknown; version?: number; plain?: boolean } = {}): Promise<string | null> {
		const table = asTable(o.table);
		const x = await exportPlan(this.host, id, blockId, { ...(table ? { table } : {}), ...(o.version !== undefined ? { version: o.version } : {}), shown: await this.#tableOf(id, blockId) });
		return x ? (o.plain ? x.plan : x.markdown) : null;
	}

	/** How the newest run with both tables on a block went: which version is the block's result and why, the run's
	 *  numbers, and every model's blind comparison (which document it preferred, why per criterion, what each does
	 *  better). `stat` is missing for a block no such run finished on; the comparisons of a run still at its final
	 *  round are there already. */
	async outcome(id: string, blockId: string): Promise<{ chosen: Chosen | null; stat: Omit<PlanStrategyStat, "session"> | null; compares: Array<Omit<PlanCompare, "session">> }> {
		const stat = (await this.host.readAll({ type: "PlanStrategyStat", fields: { session: id, blockId } }, { limit: 50 })).map((e) => e.fields as unknown as PlanStrategyStat).sort((a, b) => b.ts - a.ts)[0];
		const newest = (await this.host.readAll({ type: "PlanCompare", fields: { session: id, blockId } }, { limit: 200 })).map((e) => e.fields as unknown as PlanCompare).sort((a, b) => b.ts - a.ts)[0];
		const compares = newest ? await comparesOf(this.host, id, newest.runId) : [];
		const chosen = await chosenOf(this.host, id, blockId, await this.#tableOf(id, blockId));
		const strip = <T extends { session: string }>({ session: _s, ...rest }: T) => rest;
		return { chosen, stat: stat ? strip(stat) : null, compares: compares.map(strip) };
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
		const order = ["space", "web", "agents", "model", "sources", "checker"];
		const spends = (await this.host.readAll({ type: "Spend", fields: { day: today() } }, { limit: 5000 })).map((e) => e.fields as unknown as Spend);
		return {
			hosts: [...hosts.entries()].map(([name, { host, roles }]) => ({ name, roles: order.filter((r) => roles.has(r)), host })),
			today: { calls: spends.length, tokens: spends.reduce((n, x) => n + x.tokens, 0), costUsd: spends.reduce((n, x) => n + x.costUsd, 0) },
		};
	}

	/** Starts a run on a plan task of the room (`blockId`; else the newest): at least three models, the same number of
	 *  agents for each, a budget. A run so far: the roll call, in which every model says that it is there, then the
	 *  outline and the first draft of every section by one of them. The joint work follows with its phases.
	 *  The models write in the task's language. `way`: "parallel" for table B, where every model proposes an outline,
	 *  the sections are dealt out and the models review each other in `rounds` rounds; "turns" for table A, where one
	 *  model writes the first draft and the turn then goes round the table, `rounds` times at most, with ballots after
	 *  each round; "both" for a run with both tables at the same time, each on 45 % of the budget, after which the
	 *  models compare the two documents blind and a joint final round works what the other does better into the base
	 *  (compare.ts); without a way table A writes a first draft only (`rounds` 0 unless named).
	 *  `client` is set by the server, never from the request body: a visitor's run gets the default budget at most and
	 *  counts against the day's allowance of the address. Without it (tests, scripts in-process) it counts as admin. */
	async startRun(id: string, o: { blockId?: unknown; way?: unknown; rounds?: unknown; models?: unknown; perModel?: unknown; budgetTokens?: unknown; budgetUsd?: unknown; client?: { ip: string; admin: boolean } }): Promise<{ runId: string }> {
		const s = await this.session(id);
		// what the request leaves open comes from the room's defaults (settings.ts)
		const room = await readRoom(this.host, s.id), limitsNow = effectiveLimits(await readLimits(this.host));
		const given = Array.isArray(o.models) && o.models.length ? o.models : room.models ?? [];
		o = { ...o, way: o.way ?? room.way, rounds: o.rounds ?? room.rounds, perModel: o.perModel ?? room.perModel };
		const models = [...new Set(given.map(String))];
		if (models.length < MIN_MODELS) throw new Error(`A run needs at least ${MIN_MODELS} different models`);
		if (models.length > MAX_MODELS) throw new Error(`A run takes at most ${MAX_MODELS} models`);
		const { info } = await this.modelInfo();
		const allowed = info.enabled && info.on ? info.models.map((m) => m.label) : [];
		for (const m of models) if (!allowed.includes(m)) throw new Error(`Model not available: ${m}`);
		const perModel = Math.min(MAX_AGENTS_PER_MODEL, Math.max(1, Math.floor(Number(o.perModel ?? 1)) || 1));
		const positive = (v: unknown) => { const n = Number(v); return v !== undefined && v !== null && v !== "" && Number.isFinite(n) && n > 0 ? n : undefined; };
		const visitor = o.client && !o.client.admin ? o.client : undefined;
		// a visitor's (a member's) run never goes without a token limit, and never above the largest one: the
		// administrator's within FORUM_RUN_BUDGET_TOKENS, and the room's when its owner set one
		const caps = [limitsNow.runBudgetTokens, room.budgetTokens ?? 0].filter((x) => x > 0);
		const cap = visitor && caps.length ? Math.min(...caps) : 0;
		const tokens = positive(o.budgetTokens) ? Math.floor(positive(o.budgetTokens)!) : room.budgetTokens;
		const budgetTokens = cap ? Math.min(tokens ?? cap, cap) : tokens;
		const budget = { ...(budgetTokens ? { tokens: budgetTokens } : {}), ...(positive(o.budgetUsd) ? { usd: positive(o.budgetUsd)! } : {}) };
		if (!Object.keys(budget).length) throw new Error("A run needs a budget in tokens or dollars");
		if (visitor && limitsNow.personTokensPerDay && (await spentToday(this.host, visitor.ip)) >= limitsNow.personTokensPerDay) throw new Error("The model budget of today for your address is used up (FORUM_TOKENS_PER_IP_DAY); try again tomorrow");
		// the way of working: the models take turns (table A), or all write at the same time and review each other
		// (table B), in at most `rounds` rounds
		const table: Table = o.way === "parallel" ? "B" : "A", rounds = Math.min(MAX_ROUNDS, Math.max(0, Math.floor(Number(o.rounds ?? (o.way === "parallel" || o.way === "turns" || o.way === "both" ? 2 : 0))) || 0)), both = o.way === "both";
		const tasks = await this.#tasks(s.id), task = o.blockId ? tasks.find((t) => t.blockId === String(o.blockId)) : tasks.at(-1);
		if (!task) throw new Error(o.blockId ? "Unknown plan task" : "No plan task yet: create one first");
		// a task with pictures: one model at the table describes them for the others, so one must take pictures
		if ((await imagesOf(this.host, s.id, task.blockId)).length && !models.some((m) => info.models.find((x) => x.label === m)?.images)) throw new Error("The task has pictures: at least one model at the table must take pictures");
		const params: RunParams = { runId: `r${Date.now().toString(36)}${rid()}`, blockId: task.blockId, table, rounds, startedAt: Date.now(), models, perModel, aliases: drawAliases(models), lang: task.lang, budget, ...(both ? { both } : {}), ...(o.client ? { client: { ip: o.client.ip, admin: o.client.admin } } : {}), ...(room.personWaitS !== undefined ? { personWaitMs: room.personWaitS * 1000 } : {}) };
		// a request that was refused above started nothing and does not count
		if (!this.#allow(s, "run", 6)) throw new Error("Too many runs, slow down");
		await this.#trimLines(s);
		// checked and written under the room's lock and in one transaction: the ForumRun is unique per room, so of two
		// requests only one starts a run; the agent processes carry it out (model calls by the model process)
		await this.#exclusive(s, async () => {
			if (await this.#runNow(s)) throw new Error("A run is already active");
			const limits = [budget.tokens ? `${budget.tokens} tokens` : "", budget.usd ? `$${budget.usd}` : ""].filter(Boolean).join(" / ");
			const t = await this.host.createTransaction(30_000);
			try {
				await startSpaceRun(this.host, t.id, this.#ttl, { session: s.id, params });
				await systemLine(this.host, t.id, this.#ttl, s.id, both ? `Run started at both tables (A: the models take turns, B: all write; ${rounds} round${rounds === 1 ? "" : "s"} each, ${Math.round(TABLE_SHARE * 100)} % of the budget each, then the comparison and the final round): ${models.length} models, ${perModel} agent${perModel === 1 ? "" : "s"} each, budget ${limits}` : `Run started at table ${table} (${table === "B" ? `all write, ${rounds} review round${rounds === 1 ? "" : "s"}` : rounds ? `the models take turns, ${rounds} round${rounds === 1 ? "" : "s"}` : "one model writes"}): ${models.length} models, ${perModel} agent${perModel === 1 ? "" : "s"} each, budget ${limits}`);
				await this.host.commit(t.id);
			} catch (e) {
				await this.host.abort(t.id).catch(() => {});
				throw e instanceof UniqueConflict ? new Error("A run is already active") : e;
			}
		});
		this.push(s);
		return { runId: params.runId };
	}

	/** The room's defaults for a run, with the limits a member's run is held to now. */
	async roomSettings(id: string): Promise<{ defaults: RoomDefaults; ceilings: { runBudgetTokens: number; personWaitS: number }; allowed: string[] }> {
		const s = await this.session(id);
		const { info } = await this.modelInfo();
		return { defaults: await readRoom(this.host, s.id), ceilings: { runBudgetTokens: effectiveLimits(await readLimits(this.host)).runBudgetTokens, personWaitS: ceilings().personWaitS }, allowed: info.enabled && info.on ? info.models.map((m) => m.label) : [] };
	}

	/** The owner sets the room's defaults (checked against the ceilings of now); a line in the room says who and what. */
	async saveRoomSettings(id: string, by: string, b: Record<string, unknown>): Promise<RoomDefaults> {
		const s = await this.session(id);
		const now = await this.roomSettings(s.id);
		const d = checkRoom(b, { allowed: now.allowed, runCeiling: now.ceilings.runBudgetTokens });
		await saveRoom(this.host, s.id, by, d);
		const said = [d.models ? `models ${d.models.join(", ")}` : "", d.way ? `way ${d.way}` : "", d.rounds !== undefined ? `${d.rounds} rounds` : "", d.perModel ? `${d.perModel} agents per model` : "", d.budgetTokens ? `budget ${d.budgetTokens} tokens` : "", d.personWaitS !== undefined ? `waits ${d.personWaitS} s for the person` : ""].filter(Boolean).join("; ");
		await systemLine(this.host, null, this.#ttl, s.id, `${by} set the room's defaults: ${said || "none"}`);
		this.push(s);
		return d;
	}

	/** The room's link to spaces-files: the agent that stands for it there, what the sources process is connected to,
	 *  and the link itself. */
	async roomLink(id: string): Promise<{ agent: string; files: FilesInfo; link: RoomLink | null }> {
		const s = await this.session(id);
		return { agent: agentOf(s.id), files: await filesInfo(this.host), link: await readLink(this.host, s.id) };
	}

	/** A task's pictures with the description that counts (images.ts). */
	async images(id: string, blockId: string): Promise<{ images: ImageView[] }> {
		const s = await this.session(id);
		return { images: await imageViews(this.host, s.id, blockId) };
	}
	/** A picture's bytes, for the page; null: no such picture. */
	async imageBytes(id: string, blockId: string, imageId: string): Promise<Buffer | null> {
		const s = await this.session(id);
		const img = (await imagesOf(this.host, s.id, blockId)).find((x) => x.imageId === imageId);
		const data = img ? await imageData(this.host, img) : null;
		return data ? Buffer.from(data, "base64") : null;
	}
	/** A member adds a picture (the reduced copy the page made) to a task; sent again under the same ID it is one. */
	async addImage(id: string, blockId: string, o: { imageId: string; name: unknown; bytes: Buffer; by: string }): Promise<{ image: ImageView; again: boolean }> {
		const s = await this.session(id);
		if (!(await this.#tasks(s.id)).some((t) => t.blockId === blockId)) throw new Error("Unknown plan task");
		if (!this.#allow(s, "image", 30)) throw new Error("Too many pictures, slow down");
		const { image: { session: _s, parts: _p, ...img }, again } = await addImage(this.host, this.#ttl, { session: s.id, blockId, ...o });
		if (!again) await systemLine(this.host, null, this.#ttl, s.id, `${o.by} added the picture ${img.name} (${img.width} × ${img.height}, ${Math.ceil(img.bytes / 1000)} kB) to a task`);
		this.push(s);
		return { image: { ...img, note: null }, again };
	}
	/** A person writes or corrects a picture's description. */
	async noteImage(id: string, blockId: string, imageId: string, text: unknown, by: string): Promise<{ ok: true }> {
		const s = await this.session(id);
		if (!this.#allow(s, "image", 30)) throw new Error("Too many changes, slow down");
		await noteImage(this.host, this.#ttl, { session: s.id, blockId, imageId, text, by });
		this.push(s);
		return { ok: true };
	}
	/** A member removes a picture with its descriptions. */
	async removeImage(id: string, blockId: string, imageId: string, by: string): Promise<{ ok: true }> {
		const s = await this.session(id);
		const img = (await imagesOf(this.host, s.id, blockId)).find((x) => x.imageId === imageId);
		if (!img || !(await removeImage(this.host, s.id, blockId, imageId))) throw new Error("No such picture");
		await systemLine(this.host, null, this.#ttl, s.id, `${by} removed the picture ${img.name}`);
		this.push(s);
		return { ok: true };
	}

	/** The files of a task's workspace copy, for the Files pane: path, size, and for a file not copied as text its kind. */
	async filesIndex(id: string, blockId: string): Promise<{ files: Array<{ path: string; size: number; kind: string; readable: boolean; note?: string }> }> {
		const s = await this.session(id);
		const notes = await fileNotes(this.host, s.id);
		const src = (await this.host.readIfExists({ type: "PlanSource", fields: { session: s.id, blockId, sourceId: "files" } }, NO_WAIT))?.fields as unknown as PlanSource | undefined;
		if (!src?.copy) return { files: [] };
		const pages = await this.host.readAll({ type: "SourceIndex", fields: { session: s.id, blockId, sourceId: "files", copy: src.copy } }, { limit: 2000 });
		const index = pages.sort((a, b) => Number(a.fields.part) - Number(b.fields.part)).flatMap((e) => (e.fields as unknown as { paths: IndexEntry[] }).paths);
		return { files: index.map((e) => ({ path: e[0], size: e[1], kind: e[2] ?? "text", readable: readable(e), ...(notes.get(e[0]) ? { note: notes.get(e[0])! } : {}) })) };
	}
	/** A picture of the linked folders as it is now, for the page: its bytes and media type (files.ts PICTURE_TYPES). */
	async preview(id: string, path: string): Promise<{ type: string; bytes: Buffer }> {
		const s = await this.session(id);
		if (!(await readLink(this.host, s.id))) throw new Error("The room is not linked to a workspace");
		const previewId = `pv${rid()}${rid()}`;
		const { preview } = await askFiles(this.host, { requestId: `pv-${previewId}`, session: s.id, op: "preview", path, previewId, ts: Date.now() }, sourceWaitMs());
		const parts = (await this.host.readAll({ type: "PreviewPart", fields: { session: s.id, previewId } }, { limit: preview!.parts + 2 })).map((e) => e.fields as { part: number; data: string }).sort((a, b) => a.part - b.part);
		for (let n = 0; n <= parts.length && (await this.host.take({ type: "PreviewPart", fields: { session: s.id, previewId } }, NO_WAIT)); n++) { /* read: gone */ }
		const bytes = Buffer.from(parts.map((p) => p.data).join(""), "base64");
		if (parts.length !== preview!.parts || bytes.length !== preview!.bytes) throw new Error("The picture arrived incomplete");
		return { type: PICTURE_TYPES[preview!.kind]!, bytes };
	}

	/** A member's file into `material/` of the room's project folder, through the sources process (files.ts). Sent
	 *  again under the same upload ID (a lost reply), it is answered with the file already written. */
	async upload(id: string, o: { uploadId: string; name: unknown; bytes: Buffer; by: string }): Promise<{ upload: UploadAnswer; again: boolean }> {
		const s = await this.session(id);
		if (!/^[a-zA-Z0-9_-]{8,40}$/.test(o.uploadId)) throw new Error("An upload needs an ID of 8 to 40 letters and digits");
		const had = (await this.host.readIfExists({ type: "UploadDone", fields: { session: s.id, uploadId: o.uploadId } }, NO_WAIT))?.fields as unknown as UploadDone | undefined;
		if (had) return { upload: { workspace: had.workspace, path: had.path, version: had.version, kind: had.kind, bytes: had.bytes }, again: true };
		if (!(await readLink(this.host, s.id))) throw new Error("The room is not linked to a workspace");
		const name = uploadName(o.name);
		if (!o.bytes.length) throw new Error("The file is empty");
		if (o.bytes.length > UPLOAD.bytes) throw new Error(`A file has at most ${UPLOAD.bytes / 1024 / 1024} MB`);
		if (!this.#allow(s, "upload", 20)) throw new Error("Too many uploads, slow down");
		const key = { session: s.id, uploadId: o.uploadId }, data = o.bytes.toString("base64"), parts = Math.ceil(data.length / UPLOAD.part), ttl = 3600_000;
		while (await this.host.take({ type: "UploadPart", fields: key }, NO_WAIT)) { /* an attempt cut off */ }
		for (let part = 0; part < parts; part++) await this.host.write({ type: "UploadPart", fields: { ...key, part, data: data.slice(part * UPLOAD.part, (part + 1) * UPLOAD.part) } }, null, ttl);
		const { upload } = await askFiles(this.host, { requestId: `up-${o.uploadId}-${rid()}`, session: s.id, op: "upload", uploadId: o.uploadId, name, parts, hash: createHash("sha256").update(o.bytes).digest("hex"), bytes: o.bytes.length, by: o.by, ttl, ts: Date.now() }, filesWaitMs());
		this.push(s);
		return { upload: upload!, again: false };
	}

	/** A person's note on a file of the room's workspace that has no text to read; the models get it with the file. */
	async noteFile(id: string, o: { path?: unknown; text?: unknown; by: string }): Promise<{ ok: true }> {
		const s = await this.session(id);
		if (!this.#allow(s, "note", 30)) throw new Error("Too many notes, slow down");
		await saveFileNote(this.host, this.#ttl, { session: s.id, path: String(o.path ?? ""), text: String(o.text ?? ""), by: o.by });
		this.push(s);
		return { ok: true };
	}

	/** The owner's work on the link: `check` (what the agent sees, and the folders named, if any), `link` (checked again,
	 *  then kept) and `unlink`. A line in the room says who linked or unlinked what. */
	async linkRoom(id: string, by: string, b: Record<string, unknown>): Promise<{ check?: CheckAnswer; link: RoomLink | null }> {
		const s = await this.session(id);
		if (b.action === "unlink") {
			const was = await readLink(this.host, s.id);
			await saveLink(this.host, s.id, null);
			if (was) { await systemLine(this.host, null, this.#ttl, s.id, `${by} unlinked the room from the workspace; tasks keep the copies they took`); this.push(s); }
			return { link: null };
		}
		if (b.action !== "check" && b.action !== "link") throw new Error("action: check, link or unlink");
		const info = await filesInfo(this.host);
		if (!info) throw new Error("No sources process is connected to spaces-files (FORUM_FILES_SOCKET)");
		const project = b.project ? checkFolder(b.project, "The project folder") : null;
		const read = b.read ? checkFolder(b.read, "The folder to read") : null;
		if (b.action === "link" && !project) throw new Error("Name the project folder");
		if (!this.#allow(s, "link", 10)) throw new Error("Too many checks, slow down");
		const { check } = await askFiles(this.host, { requestId: `check-${s.id}-${rid()}`, session: s.id, op: "check", read, project, ts: Date.now() }, sourceWaitMs());
		if (b.action === "check") return { check, link: await readLink(this.host, s.id) };
		const link: RoomLink = { session: s.id, tenant: info.tenant, agent: agentOf(s.id), read, project: project!, by, ts: Date.now() };
		await saveLink(this.host, s.id, link, this.#ttl);
		await systemLine(this.host, null, this.#ttl, s.id, `${by} linked the room to the workspace: ${read ? `reading ${folderName(read)}, ` : ""}project folder ${folderName(project!)}`);
		this.push(s);
		return { check, link };
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
