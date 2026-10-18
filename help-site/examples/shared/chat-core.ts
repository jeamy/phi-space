// Shared pure phi-spaces Multiplayer Chat core used across stages v1 through v6.
// Implements the Earendil Multiplayer Chat capabilities purely with phi-spaces primitives:
//   1. Session isolation via NamedSpace
//   2. Unique threads & pointer forks with durable application request identities
//   3. Ordered multiplayer inbox & replies via transactional ChatTask + CompletionProfile
//   4. Live state snapshots (readPage), revision deltas (changes), and Presence leases (renew/cancel)
//   5. Scheduled alarms via ScheduledJob (FOREVER) + TimerLock (lease = delayMs) reaped by phi-spaces
//   6. Cross-thread search subagent via SearchTask -> SubagentStep -> SearchResult under CompletionProfile

import {
	core,
	FOREVER,
	NO_WAIT,
	type CompletionProfile,
	type SpaceLike,
} from "../../../src/index.ts";

type EntryView = core.EntryView;

export const CHAT_COMPLETION_PROFILES: Array<
	CompletionProfile & { maxResultBytes: number; maxLeaseMs: number }
> = [
	{
		taskType: "ChatTask",
		resultTypes: ["Msg"],
		equalFields: ["taskId", "threadId"],
		maxResultCount: 1,
		maxResultBytes: 64 * 1024,
		maxLeaseMs: 60_000,
	},
	{
		taskType: "SearchTask",
		resultTypes: ["SearchResult"],
		equalFields: ["searchId", "parentThreadId"],
		maxResultCount: 1,
		maxResultBytes: 64 * 1024,
		maxLeaseMs: 60_000,
	},
];

export interface ThreadRecord {
	threadId: string;
	title: string;
	parentThreadId: string;
	forkUpToSeq: number;
	createdBy: string;
	createdAt: number;
}

export interface MsgRecord {
	projectionOf?: string;
	msgId: string;
	threadId: string;
	seq: number;
	author: string;
	role: "user" | "assistant" | "alarm";
	text: string;
	taskId: string;
	subagentSearchId: string;
	createdAt: number;
	/** Set when a live LLM generated this reply instead of the scripted fallback. */
	llmModel?: string;
	llmTokens?: number;
}

export interface LlmReply {
	text: string;
	model?: string;
	usageIn?: number;
	usageOut?: number;
}

export type ReplyGenerator = (input: {
	signal?: AbortSignal;
	threadId: string;
	author: string;
	prompt: string;
	history: Array<{ author: string; role: string; text: string }>;
}) => Promise<LlmReply | null>;

export interface PresenceRecord {
	leaseId?: string;
	expires?: number;
	participantId: string;
	username: string;
	activeThreadId: string;
	status: "online" | "typing" | "idle";
	updatedAt: number;
}

export interface ScheduledJobRecord {
	jobId: string;
	threadId: string;
	instruction: string;
	requestedBy: string;
	executeAt: number;
	status: "pending" | "triggered";
	lockExpires: number | null;
	createdAt: number;
}

export interface SubagentRunRecord {
	searchId: string;
	parentThreadId: string;
	question: string;
	status: "pending" | "completed";
	answer: string | null;
	citedThreadIds: string[];
	steps: Array<{
		stepIndex: number;
		queryTerm: string;
		matchCount: number;
		matchedSnippets: Array<{ threadId: string; seq: number; author: string; excerpt: string }>;
	}>;
	createdAt: number;
}

export interface SpaceChatSnapshot {
	integrityIssues?: string[];
	rev: number;
	streamId: string;
	threads: ThreadRecord[];
	messages: MsgRecord[];
	pendingTasks: Array<{ taskId: string; threadId: string; author: string; prompt: string; kind: string }>;
	presence: PresenceRecord[];
	scheduledJobs: ScheduledJobRecord[];
	subagentRuns: SubagentRunRecord[];
	rawEntryCount: number;
}

export class SpaceChatEngine {
	readonly space: SpaceLike;
	readonly now: () => number;
	#presenceLeases = new Map<string, string>();
	/** Real lease expiry per participant – renew() extends the lease, not `fields.updatedAt`. */
	#presenceExpires = new Map<string, number>();
	replyGenerator?: ReplyGenerator;

	constructor(space: SpaceLike, now: () => number = Date.now) {
		this.space = space;
		this.now = now;
	}

	setReplyGenerator(fn: ReplyGenerator | undefined): void {
		this.replyGenerator = fn;
	}

	/** Bootstrap once atomically; reserve and replace in the caller's transaction. */
	private async lockEntry(txn: string, type: string, key: string, initial: Record<string, core.Json> = {}): Promise<core.Fields> {
		if (!await this.space.read({ type, fields: { key } }, NO_WAIT)) {
			try { await this.space.write({ type, fields: { key, ...initial } }, null, FOREVER, { unique: ["key"] }); }
			catch (e) { if (!(e instanceof Error) || !e.message.includes("unique entry already exists")) throw e; }
		}
		const entry = await this.space.take({ type, fields: { key } }, 5_000, { txn });
		if (!entry) throw new Error(`Coordination entry busy: ${type}/${key}`);
		return entry.fields;
	}

	private async allocateSeq(threadId: string, txn: string): Promise<number> {
		const thread = await this.space.read({ type: "Thread", fields: { threadId } }, NO_WAIT);
		if (!thread) throw new Error(`Unknown thread: ${threadId}`);
		let initial = Number(thread.fields.forkUpToSeq ?? 0) + 1;
		if (!await this.space.read({ type: "ThreadSequence", fields: { key: threadId } }, NO_WAIT)) {
			for (const m of await this.space.readAll({ type: "Msg", fields: { threadId } })) initial = Math.max(initial, Number(m.fields.seq) + 1);
		}
		const counter = await this.lockEntry(txn, "ThreadSequence", threadId, { threadId, nextSeq: initial });
		const seq = Number(counter.nextSeq);
		await this.space.write({ type: "ThreadSequence", fields: { ...counter, nextSeq: seq + 1 } }, txn, FOREVER);
		return seq;
	}

	async installProfilesIfSupported(): Promise<void> {
		const maybeAdmin = this.space as SpaceLike & {
			setCompletionProfiles?: (profiles: CompletionProfile[]) => Promise<void>;
		};
		if (typeof maybeAdmin.setCompletionProfiles === "function") {
			await maybeAdmin.setCompletionProfiles(CHAT_COMPLETION_PROFILES);
		}
	}

	/** Write or refresh a participant Presence entry with a bounded space lease (default 30s). */
	async joinOrRefreshPresence(input: {
		participantId: string;
		username: string;
		activeThreadId: string;
		status?: "online" | "typing" | "idle";
		leaseMs?: number;
		requestId?: string;
	}): Promise<{ leaseId: string; expires: number }> {
		const leaseMs = input.leaseMs ?? 30_000;
		if (!Number.isFinite(leaseMs) || leaseMs < 100 || leaseMs > 120_000) throw new Error("Invalid presence lease");
		const fingerprint = JSON.stringify([input.username, input.activeThreadId, input.status ?? "online", leaseMs]);
		const txn = await this.space.createTransaction(10_000);
		try {
		const lock = await this.lockEntry(txn.id, "PresenceMutex", input.participantId);
		const existing = await this.space.read({ type: "Presence", fields: { participantId: input.participantId } }, NO_WAIT);
		if (existing && input.requestId && existing.fields.requestId === input.requestId) {
			if (existing.fields.fingerprint !== fingerprint) throw new Error("Presence request reused with different arguments");
			await this.space.abort(txn.id);
			return { leaseId: existing.id, expires: Number(existing.fields.expires) };
		}
		while (await this.space.takeIfExists({ type: "Presence", fields: { participantId: input.participantId } }, NO_WAIT, { txn: txn.id })) { /* replace atomically */ }
		const lease = await this.space.write(
			{
				type: "Presence",
				fields: {
					participantId: input.participantId,
					username: input.username,
					activeThreadId: input.activeThreadId,
					status: input.status ?? "online",
					updatedAt: this.now(),
					expires: this.now() + leaseMs,
					requestId: input.requestId ?? "",
					fingerprint,
				},
			},
			txn.id,
			leaseMs,
		);
		await this.space.write({ type: "PresenceMutex", fields: lock }, txn.id, FOREVER);
		await this.space.commit(txn.id);
		this.#presenceLeases.set(input.participantId, lease.id);
		this.#presenceExpires.set(input.participantId, lease.expires);
		return { leaseId: lease.id, expires: lease.expires };
		} catch (e) { await this.space.abort(txn.id).catch(() => {}); throw e; }
	}

	async renewPresence(participantId: string, leaseMs = 30_000): Promise<number | null> {
		const leaseId = (await this.space.read({ type: "Presence", fields: { participantId } }, NO_WAIT))?.id;
		if (!leaseId) return null;
		const expires = await this.space.renew(leaseId, leaseMs);
		if (expires != null) { this.#presenceLeases.set(participantId, leaseId); this.#presenceExpires.set(participantId, expires); }
		return expires;
	}

	/** Atomic thread identity with durable request replay; transport retries also retain native RPC claims. */
	async createThread(input: {
		threadId: string;
		title: string;
		createdBy: string;
		requestId: string;
		createdAt?: number;
	}): Promise<ThreadRecord> {
		const record: ThreadRecord = {
			threadId: input.threadId,
			title: input.title,
			parentThreadId: "none",
			forkUpToSeq: 0,
			createdBy: input.createdBy,
			createdAt: input.createdAt ?? this.now(),
		};
		return this.storeThread(record, input.requestId);
	}

	private async storeThread(record: ThreadRecord, requestId: string): Promise<ThreadRecord> {
		if (!record.threadId.trim() || record.threadId.length > 128 || !requestId || !record.title.trim()) throw new Error("Invalid thread identity or title");
		try {
			await this.space.write({ type: "Thread", fields: { ...record, requestId } }, null, FOREVER, { unique: ["threadId"] });
			return record;
		} catch (e) {
			if (!(e instanceof Error) || !e.message.includes("unique entry already exists")) throw e;
			const old = await this.space.read({ type: "Thread", fields: { threadId: record.threadId } }, 5_000);
			if (!old || old.fields.requestId !== requestId || old.fields.title !== record.title || old.fields.createdBy !== record.createdBy || old.fields.parentThreadId !== record.parentThreadId || old.fields.forkUpToSeq !== record.forkUpToSeq) throw new Error(`Thread already exists: ${record.threadId}`);
			return old.fields as unknown as ThreadRecord;
		}
	}

	/**
	 * Fork a thread up to a selected message sequence number (`forkUpToSeq`).
	 * Uses O(1) pointer-based Copy-on-Write: only the `Thread` metadata entry
	 * (`parentThreadId`, `forkUpToSeq`) is written to the Space, without physically
	 * duplicating inherited `Msg` entries. Inherited messages up to `forkUpToSeq`
	 * are resolved dynamically across the ancestor chain on read/snapshot.
	 */
	async forkThread(input: {
		newThreadId: string;
		parentThreadId: string;
		forkUpToSeq: number;
		title: string;
		createdBy: string;
		requestId: string;
	}): Promise<ThreadRecord> {
		if (input.newThreadId === input.parentThreadId || !Number.isSafeInteger(input.forkUpToSeq) || input.forkUpToSeq < 0) throw new Error("Invalid fork boundary or self fork");
		if (!await this.space.read({ type: "Thread", fields: { threadId: input.parentThreadId } }, NO_WAIT)) throw new Error("Fork parent missing");
		const history = await this.resolveThreadHistoryFromSpace(input.parentThreadId);
		if (input.forkUpToSeq > history.reduce((n, m) => Math.max(n, m.seq), 0)) throw new Error("Fork boundary exceeds parent history");
		const record: ThreadRecord = {
			threadId: input.newThreadId,
			title: input.title,
			parentThreadId: input.parentThreadId,
			forkUpToSeq: input.forkUpToSeq,
			createdBy: input.createdBy,
			createdAt: this.now(),
		};
		return this.storeThread(record, input.requestId);
	}

	/**
	 * Resolve a thread's full chronological message list (inherited ancestor messages
	 * up to `forkUpToSeq` via pointer chain + own physical `Msg` entries).
	 */
	static resolveMessagesForThread(
		threadId: string,
		threadsById: ReadonlyMap<string, ThreadRecord>,
		ownMsgsByThread: ReadonlyMap<string, MsgRecord[]>,
		visited = new Set<string>(),
	): MsgRecord[] {
		if (visited.has(threadId)) throw new Error(`Thread ancestry cycle: ${threadId}`);
		visited.add(threadId);

		const thread = threadsById.get(threadId);
		const inherited: MsgRecord[] = [];
		if (thread && thread.parentThreadId && thread.parentThreadId !== "none" && thread.forkUpToSeq > 0) {
			const parentResolved = SpaceChatEngine.resolveMessagesForThread(
				thread.parentThreadId,
				threadsById,
				ownMsgsByThread,
				visited,
			);
			for (const m of parentResolved) {
				if (m.seq <= thread.forkUpToSeq) {
					inherited.push({
						...m,
						msgId: `${threadId}:fork:${m.msgId}`,
						projectionOf: m.projectionOf ?? m.msgId,
						threadId,
					});
				}
			}
		}

		const own = [...(ownMsgsByThread.get(threadId) ?? [])].sort((a, b) => a.seq - b.seq);
		const byId = new Map<string, MsgRecord>();
		for (const m of [...inherited, ...own]) byId.set(m.msgId, m);
		return [...byId.values()].sort((a, b) => a.seq - b.seq || a.msgId.localeCompare(b.msgId));
	}

	private async resolveThreadHistoryFromSpace(threadId: string): Promise<MsgRecord[]> {
		const [allThreadViews, allMsgViews] = await Promise.all([
			this.space.readAll({ type: "Thread" }),
			this.space.readAll({ type: "Msg" }),
		]);
		const threadsById = new Map<string, ThreadRecord>();
		for (const tv of allThreadViews) {
			const tr = tv.fields as unknown as ThreadRecord;
			threadsById.set(tr.threadId, tr);
		}
		const ownMsgsByThread = new Map<string, MsgRecord[]>();
		for (const mv of allMsgViews) {
			const mr = mv.fields as unknown as MsgRecord;
			const list = ownMsgsByThread.get(mr.threadId) ?? [];
			list.push(mr);
			ownMsgsByThread.set(mr.threadId, list);
		}
		return SpaceChatEngine.resolveMessagesForThread(threadId, threadsById, ownMsgsByThread);
	}

	/**
	 * Submit a participant message into a thread.
	 * Atomically advances the thread counter, writes the user `Msg` and enqueues a `ChatTask` with durable message-ID replay.
	 */
	async submitMessage(input: {
		threadId: string;
		author: string;
		text: string;
		requestId: string;
	}): Promise<{ msgId: string; taskId: string; seq: number }> {
		const taskId = `task:${input.threadId}:${input.requestId}`;
		const msgId = `msg:${input.threadId}:${input.requestId}`;

		// Check if already committed (idempotent replay)
		const already = await this.space.read(
			{ type: "Msg", fields: { msgId } },
			NO_WAIT,
		);
		if (already) {
			const f = already.fields as unknown as MsgRecord;
			if (f.author !== input.author || f.text !== input.text) throw new Error("Message request reused with different arguments");
			return { msgId: f.msgId, taskId, seq: f.seq };
		}

		const txn = await this.space.createTransaction(30_000);
		try {
			const seq = await this.allocateSeq(input.threadId, txn.id);
			const replay = await this.space.read({ type: "Msg", fields: { msgId } }, NO_WAIT);
			if (replay) {
				if (replay.fields.author !== input.author || replay.fields.text !== input.text) throw new Error("Message request reused with different arguments");
				await this.space.abort(txn.id);
				return { msgId, taskId, seq: Number(replay.fields.seq) };
			}
			await this.space.write(
				{
					type: "Msg",
					fields: {
						msgId,
						threadId: input.threadId,
						seq,
						author: input.author,
						role: "user",
						text: input.text,
						taskId: "user-input",
						subagentSearchId: "none",
						createdAt: this.now(),
					},
				},
				txn.id,
				FOREVER,
			);
			await this.space.write(
				{
					type: "ChatTask",
					fields: {
						taskId,
						threadId: input.threadId,
						triggerSeq: seq,
						author: input.author,
						prompt: `[${input.author}]: ${input.text}`,
						kind: "user_message",
						createdAt: this.now(),
					},
				},
				txn.id,
				FOREVER,
			);
			await this.space.commit(txn.id);
			return { msgId, taskId, seq };
		} catch (err) {
			try {
				await this.space.abort(txn.id);
			} catch {
				// ignore
			}
			throw err;
		}
	}

	/**
	 * Schedule a future instruction using pure phi-spaces primitives:
	 *   - `ScheduledJob` entry with FOREVER lease (`status: "pending"`)
	 *   - `TimerLock` entry with `lease = delayMs`
	 * When `TimerLock` expires (reaped by `startService`), `tickAlarms()` promotes the job into a `ChatTask`.
	 */
	async scheduleReminder(input: {
		jobId: string;
		threadId: string;
		instruction: string;
		requestedBy: string;
		delayMs: number;
		requestId: string;
	}): Promise<{ jobId: string; executeAt: number; lockLeaseId: string }> {
		const executeAt = this.now() + Math.max(10, input.delayMs);
		if (!Number.isFinite(input.delayMs) || input.delayMs < 0 || input.delayMs > 86_400_000) throw new Error("Invalid reminder delay");
		const txn = await this.space.createTransaction(30_000);
		try {
			const lock = await this.lockEntry(txn.id, "ReminderMutex", input.jobId);
			const existing = await this.space.read({ type: "ScheduledJob", fields: { jobId: input.jobId } }, NO_WAIT);
			if (existing) {
				if (existing.fields.threadId !== input.threadId || existing.fields.instruction !== input.instruction || existing.fields.requestedBy !== input.requestedBy || existing.fields.delayMs !== input.delayMs) throw new Error("Reminder identity reused with different arguments");
				const timer = await this.space.read({ type: "TimerLock", fields: { jobId: input.jobId } }, NO_WAIT);
				await this.space.abort(txn.id);
				return { jobId: input.jobId, executeAt: Number(existing.fields.executeAt), lockLeaseId: timer?.id ?? "" };
			}
			await this.space.write(
				{
					type: "ScheduledJob",
					fields: {
						jobId: input.jobId,
						threadId: input.threadId,
						instruction: input.instruction,
						requestedBy: input.requestedBy,
						delayMs: input.delayMs,
						executeAt,
						status: "pending",
						createdAt: this.now(),
					},
				},
				txn.id,
				FOREVER,
			);
			const lockLease = await this.space.write(
				{
					type: "TimerLock",
					fields: {
						jobId: input.jobId,
						threadId: input.threadId,
						executeAt,
					},
				},
				txn.id,
				Math.max(10, input.delayMs),
			);
			await this.space.write({ type: "ReminderMutex", fields: lock }, txn.id, FOREVER);
			await this.space.commit(txn.id);
			return { jobId: input.jobId, executeAt, lockLeaseId: lockLease.id };
		} catch (err) {
			try {
				await this.space.abort(txn.id);
			} catch {
				// ignore
			}
			throw err;
		}
	}

	/**
	 * Promote any pending `ScheduledJob` whose `TimerLock` lease has expired into an executable `ChatTask`.
	 */
	async tickAlarms(): Promise<string[]> {
		const pendingJobs = await this.space.readAll({
			type: "ScheduledJob",
			fields: { status: "pending" },
		});
		const triggeredIds: string[] = [];

		for (const jobView of pendingJobs) {
			const job = jobView.fields as unknown as ScheduledJobRecord;
			const activeLock = await this.space.readIfExists(
				{ type: "TimerLock", fields: { jobId: job.jobId } },
				NO_WAIT,
			);
			if (job.executeAt > this.now() || (activeLock && Number(activeLock.fields.executeAt ?? 0) > this.now())) {
				continue;
			}
			// Lock expired (or ready to expire now): take the pending ScheduledJob transactionally
			const txn = await this.space.createTransaction(30_000);
			try {
				const taken = await this.space.takeIfExists(
					{ type: "ScheduledJob", id: jobView.id, fields: { jobId: job.jobId, status: "pending" } },
					NO_WAIT,
					{ txn: txn.id },
				);
				if (!taken) {
					await this.space.abort(txn.id);
					continue;
				}
				// Also clean up TimerLock if still lingering
				await this.space.takeIfExists(
					{ type: "TimerLock", fields: { jobId: job.jobId } },
					NO_WAIT,
					{ txn: txn.id },
				);
				await this.space.write(
					{
						type: "ScheduledJob",
						fields: {
							...job,
							status: "triggered",
						},
					},
					txn.id,
					FOREVER,
				);
				const taskId = `alarm-task:${job.jobId}`;
				await this.space.write(
					{
						type: "ChatTask",
						fields: {
							taskId,
							threadId: job.threadId,
							triggerSeq: 0,
							author: "scheduler",
							prompt: `[ALARM ${job.jobId}]: ${job.instruction}`,
							kind: "scheduled_wakeup",
							createdAt: this.now(),
						},
					},
					txn.id,
					FOREVER,
				);
				await this.space.commit(txn.id);
				triggeredIds.push(job.jobId);
			} catch {
				try {
					await this.space.abort(txn.id);
				} catch {
					// ignore
				}
			}
		}
		return triggeredIds;
	}

	/**
	 * Search Subagent Worker:
	 * Takes one `SearchTask` under a transaction, searches across all `Msg` entries in all threads
	 * (excluding subagent artifacts), writes `SubagentStep` trace entries, and commits `SearchResult`
	 * enforced by `CompletionProfile`.
	 */
	async processNextSearchTask(timeoutMs = 0): Promise<SubagentRunRecord | null> {
		const txn = await this.space.createTransaction(30_000);
		try {
			const task = await this.space.take(
				{ type: "SearchTask" },
				timeoutMs,
				{ txn: txn.id },
			);
			if (!task) {
				await this.space.abort(txn.id);
				return null;
			}
			const { searchId, parentThreadId, question } = task.fields as {
				searchId: string;
				parentThreadId: string;
				question: string;
			};

			// Extract candidate search terms from the question (splitting hyphens and stripping German genitive -s)
			const stopWords = new Set([
				"what", "did", "we", "decide", "about", "the", "was", "haben", "wir",
				"bezüglich", "des", "entschieden", "wie", "ist", "und", "oder", "for", "use",
				"alice", "bob", "carol"
			]);
			const cleanQuestion = question.replace(/^\[[^\]]+\]:\s*/, "").trim();
			const rawTokens = cleanQuestion
				.toLowerCase()
				.replace(/[^\p{L}\p{N}]+/gu, " ")
				.split(/\s+/)
				.map((w) => (w.length > 4 && w.endsWith("s") ? w.slice(0, -1) : w))
				.filter((w) => w.length >= 3 && !stopWords.has(w));
			const terms = [...new Set(rawTokens.length > 0 ? rawTokens.slice(0, 4) : ["space", "entry", "chat"])];

			const allMsgs = (await this.space.readAll({ type: "Msg" }))
				.map((e) => e.fields as unknown as MsgRecord)
				// Never let previous search results or the triggering question itself become evidence!
				.filter(
					(m) =>
						m.subagentSearchId === "none" &&
						!(m.threadId === parentThreadId && m.text.trim() === cleanQuestion),
				);

			const citedThreads = new Set<string>();
			const allMatchedMsgs = new Map<string, MsgRecord>();
			const steps: SubagentRunRecord["steps"] = [];

			for (let i = 0; i < terms.length; i++) {
				const term = terms[i]!;
				const hits = allMsgs.filter((m) => m.text.toLowerCase().includes(term));
				const snippets = hits.map((h) => {
					citedThreads.add(h.threadId);
					allMatchedMsgs.set(h.msgId, h);
					return {
						threadId: h.threadId,
						seq: h.seq,
						author: h.author,
						excerpt: h.text.slice(0, 140),
					};
				});
				steps.push({
					stepIndex: i + 1,
					queryTerm: term,
					matchCount: snippets.length,
					matchedSnippets: snippets,
				});
				await this.space.write(
					{
						type: "SubagentStep",
						fields: {
							searchId,
							stepIndex: i + 1,
							queryTerm: term,
							matchCount: snippets.length,
							matchedSnippets: snippets,
							createdAt: this.now(),
						},
					},
					txn.id,
					FOREVER,
				);
			}

			const matchedList = [...allMatchedMsgs.values()].sort((a, b) => a.createdAt - b.createdAt);
			const citedThreadIds = [...citedThreads];
			const answer =
				matchedList.length > 0
					? `Gefunden in Thread(s) [${citedThreadIds.join(", ")}]: ` +
					  matchedList.map((m) => `(${m.threadId}#${m.seq} @${m.author}: "${m.text}")`).join(" | ")
					: `Keine passenden Einträge in anderen Threads für "${question}" gefunden.`;

			await this.space.write(
				{
					type: "SearchResult",
					fields: {
						searchId,
						parentThreadId,
						question,
						answer,
						citedThreadIds,
						createdAt: this.now(),
					},
				},
				txn.id,
				FOREVER,
			);
			await this.space.commit(txn.id);

			return {
				searchId,
				parentThreadId,
				question,
				status: "completed",
				answer,
				citedThreadIds,
				steps,
				createdAt: this.now(),
			};
		} catch (err) {
			try {
				await this.space.abort(txn.id);
			} catch {
				// ignore
			}
			throw err;
		}
	}

	/**
	 * Main Chat Worker:
	 * Takes one `ChatTask` under a space transaction, optionally delegates cross-thread questions
	 * to `SearchTask` (and runs the subagent if in-process or waits for `SearchResult`), or schedules
	 * a `TimerLock` alarm if requested, and commits the assistant `Msg` under `CompletionProfile`.
	 */
	async processNextChatTask(options: {
		timeoutMs?: number;
		replyTimeoutMs?: number;
		autoRunSubagent?: boolean;
	} = {}): Promise<MsgRecord | null> {
		const timeoutMs = options.timeoutMs ?? 0;
		const autoRunSubagent = options.autoRunSubagent ?? true;

		const txn = await this.space.createTransaction(60_000);
		try {
			const taskView = await this.space.take(
				{ type: "ChatTask" },
				timeoutMs,
				{ txn: txn.id },
			);
			if (!taskView) {
				await this.space.abort(txn.id);
				return null;
			}
			const task = taskView.fields as {
				taskId: string;
				threadId: string;
				triggerSeq: number;
				author: string;
				prompt: string;
				kind: "user_message" | "scheduled_wakeup";
			};

			const lower = task.prompt.toLowerCase();
			let replyText = "";
			let subagentSearchId = "none";
			let llmMeta: { llmModel?: string; llmTokens?: number } = {};

			if (task.kind === "scheduled_wakeup") {
				replyText = `⏰ Geplanter Space-Alarm ausgelöst: ${task.prompt.replace(/^\[ALARM [^\]]+\]:\s*/, "")}`;
			} else if (
				lower.includes("was haben wir") ||
				lower.includes("what did we decide") ||
				lower.includes("search_history") ||
				lower.includes("suche:")
			) {
				// Delegate cross-thread question to SearchTask in the space!
				subagentSearchId = `search:${task.taskId}`;
				const existingResult = await this.space.read(
					{ type: "SearchResult", fields: { searchId: subagentSearchId } },
					NO_WAIT,
				);
				if (!existingResult) {
					await this.space.write(
						{
							type: "SearchTask",
							fields: {
								searchId: subagentSearchId,
								parentThreadId: task.threadId,
								parentTaskId: task.taskId,
								question: task.prompt,
								createdAt: this.now(),
							},
						},
						null, // Write immediately so the subagent worker can take it!
						FOREVER,
					);
					if (autoRunSubagent) {
						await this.processNextSearchTask(1_000);
					}
				}
				const searchRes = await this.space.read(
					{ type: "SearchResult", fields: { searchId: subagentSearchId } },
					5_000,
				);
				const answerText = (searchRes?.fields as any)?.answer ?? "Keine Antwort vom Search-Subagenten.";
				replyText = `🔍 [Subagent ${subagentSearchId}] ${answerText}`;
			} else if (
				lower.includes("erinnere") ||
				lower.includes("schedule") ||
				lower.includes("in 2 sek") ||
				lower.includes("in 5 sek") ||
				lower.includes("alarm:")
			) {
				const delayMatch = /(\d+)\s*(ms|sek|s|min)/i.exec(task.prompt);
				const amount = delayMatch ? Number(delayMatch[1]) : 2;
				const unit = delayMatch?.[2]?.toLowerCase() ?? "s";
				const delayMs = unit === "ms" ? amount : unit === "min" ? amount * 60_000 : amount * 1_000;
				const jobId = `job:${task.taskId}`;
				await this.scheduleReminder({
					jobId,
					threadId: task.threadId,
					instruction: `Erinnerung für @${task.author}: ${task.prompt}`,
					requestedBy: task.author,
					delayMs,
					requestId: `sched:${task.taskId}`,
				});
				replyText = `⏱️ Geplante Aufgabe (${jobId}) mit TimerLock-Lease (${delayMs} ms) im Space angelegt.`;
			} else {
				let llmReply: LlmReply | null = null;
				if (this.replyGenerator) {
					try {
						const resolvedHistory = await this.resolveThreadHistoryFromSpace(task.threadId);
						const history = resolvedHistory
							.slice(-12)
							.map((m) => ({ author: m.author, role: m.role, text: m.text }));
						const controller = new AbortController();
						let timer: ReturnType<typeof setTimeout> | undefined;
						try { llmReply = await Promise.race([this.replyGenerator({
							signal: controller.signal,
							threadId: task.threadId,
							author: task.author,
							prompt: task.prompt,
							history,
						}), new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("Chat reply deadline exceeded")); }, Math.min(20_000, Math.max(1, options.replyTimeoutMs ?? 20_000))); })]); }
						finally { clearTimeout(timer); }
					} catch {
						llmReply = null; // model errors degrade to the scripted reply
					}
				}
				if (llmReply) {
					replyText = llmReply.text;
					llmMeta = {
						llmModel: llmReply.model,
						llmTokens: (llmReply.usageIn ?? 0) + (llmReply.usageOut ?? 0),
					};
				} else {
					replyText = `Verstanden (@${task.author} in Thread "${task.threadId}"): ${task.prompt.replace(/^\[[^\]]+\]:\s*/, "")} — im Space dauerhaft protokolliert.`;
				}
			}

			const nextSeq = await this.allocateSeq(task.threadId, txn.id);
			const msgRecord: MsgRecord = {
				msgId: `reply:${task.taskId}`,
				threadId: task.threadId,
				seq: nextSeq,
				author: "phi-space-agent",
				role: task.kind === "scheduled_wakeup" ? "alarm" : "assistant",
				text: replyText,
				taskId: task.taskId,
				subagentSearchId,
				createdAt: this.now(),
				...llmMeta,
			};

			await this.space.write(
				{
					type: "Msg",
					fields: { ...msgRecord },
				},
				txn.id,
				FOREVER,
			);
			// Commit verifies CompletionProfile: 1 ChatTask -> 1 Msg with matching [taskId, threadId]
			await this.space.commit(txn.id);
			return msgRecord;
		} catch (err) {
			try {
				await this.space.abort(txn.id);
			} catch {
				// ignore
			}
			throw err;
		}
	}

	/** Read a full consistent snapshot of the Space-Chat state using `readPage`. */
	async inspectSnapshot(): Promise<SpaceChatSnapshot> {
		const page = await this.space.readPage(null, { maxBytes: 160_000 });
		const items: EntryView[] = [...page.items];
		let cursor = page.next;
		const token = page.token;
		while (cursor !== null) {
			const next = await this.space.readPage(null, { after: cursor, token, maxBytes: 160_000 });
			items.push(...next.items);
			cursor = next.next;
		}

		const threads: ThreadRecord[] = [];
		const rawMessages: MsgRecord[] = [];
		const pendingTasks: SpaceChatSnapshot["pendingTasks"] = [];
		const presence: PresenceRecord[] = [];
		const jobsRaw: ScheduledJobRecord[] = [];
		const locksByJob = new Map<string, number>();
		const searchTasks = new Map<string, { searchId: string; parentThreadId: string; question: string; createdAt: number }>();
		const searchResults = new Map<string, { parentThreadId: string; question: string; answer: string; citedThreadIds: string[]; createdAt: number }>();
		const stepsBySearch = new Map<string, SubagentRunRecord["steps"]>();

		const report = items.find(e => e.type === "ChatReport");
		if (report) return { ...JSON.parse(String(report.fields.snapshot)), rev: page.rev, streamId: page.streamId, rawEntryCount: items.length } as SpaceChatSnapshot;
		for (const item of items) {
			const f = item.fields as any;
			switch (item.type) {
				case "Thread":
					threads.push(f as ThreadRecord);
					break;
				case "Msg":
					rawMessages.push(f as MsgRecord);
					break;
				case "ChatTask":
					pendingTasks.push({
						taskId: f.taskId,
						threadId: f.threadId,
						author: f.author,
						prompt: f.prompt,
						kind: f.kind,
					});
					break;
				case "Presence":
					presence.push({
						...(f as PresenceRecord),
						leaseId: item.id,
						// EntryView exposes no lease expiry – use the expiry tracked at
						// write/renew time; the updatedAt guess is only a cold-start fallback.
						expires:
							(this.#presenceLeases.get(String(f.participantId)) === item.id ? this.#presenceExpires.get(String(f.participantId)) : undefined) ??
							Number(f.expires ?? Number(f.updatedAt ?? 0) + 30_000),
					});
					break;
				case "ScheduledJob":
					jobsRaw.push({ ...(f as ScheduledJobRecord), lockExpires: null });
					break;
				case "TimerLock":
					locksByJob.set(String(f.jobId), Number(f.executeAt ?? 0));
					break;
				case "SearchTask":
					searchTasks.set(String(f.searchId), {
						searchId: f.searchId,
						parentThreadId: f.parentThreadId,
						question: f.question,
						createdAt: f.createdAt,
					});
					break;
				case "SubagentStep": {
					const sid = String(f.searchId);
					const list = stepsBySearch.get(sid) ?? [];
					list.push({
						stepIndex: f.stepIndex,
						queryTerm: f.queryTerm,
						matchCount: f.matchCount,
						matchedSnippets: f.matchedSnippets ?? [],
					});
					stepsBySearch.set(sid, list);
					break;
				}
				case "SearchResult":
					searchResults.set(String(f.searchId), {
						parentThreadId: f.parentThreadId,
						question: f.question,
						answer: f.answer,
						citedThreadIds: f.citedThreadIds ?? [],
						createdAt: f.createdAt,
					});
					break;
			}
		}

		threads.sort((a, b) => a.createdAt - b.createdAt);

		// Resolve inherited history by traversing the immutable parent pointers.
		const threadsById = new Map<string, ThreadRecord>();
		for (const t of threads) threadsById.set(t.threadId, t);
		const ownMsgsByThread = new Map<string, MsgRecord[]>();
		for (const m of rawMessages) {
			const list = ownMsgsByThread.get(m.threadId) ?? [];
			list.push(m);
			ownMsgsByThread.set(m.threadId, list);
		}
		const allThreadIds = new Set<string>([
			...threadsById.keys(),
			...ownMsgsByThread.keys(),
		]);
		const messages: MsgRecord[] = [];
		for (const tid of allThreadIds) {
			messages.push(...SpaceChatEngine.resolveMessagesForThread(tid, threadsById, ownMsgsByThread));
		}
		messages.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.seq - b.seq);
		const integrityIssues: string[] = [];
		const seenSequences = new Set<string>();
		for (const m of messages) {
			const key = JSON.stringify([m.threadId, m.seq]);
			if (seenSequences.has(key)) integrityIssues.push(`Duplicate message sequence in thread ${m.threadId}: ${m.seq}`);
			seenSequences.add(key);
		}

		const scheduledJobs = jobsRaw.map((j) => ({
			...j,
			lockExpires: locksByJob.get(j.jobId) ?? null,
		}));

		const allSearchIds = new Set<string>([
			...searchTasks.keys(),
			...searchResults.keys(),
			...stepsBySearch.keys(),
		]);
		const subagentRuns: SubagentRunRecord[] = [...allSearchIds].map((searchId) => {
			const t = searchTasks.get(searchId);
			const r = searchResults.get(searchId);
			const steps = (stepsBySearch.get(searchId) ?? []).sort((a, b) => a.stepIndex - b.stepIndex);
			return {
				searchId,
				parentThreadId: t?.parentThreadId ?? r?.parentThreadId ?? "unknown",
				question: t?.question ?? r?.question ?? searchId,
				status: r ? "completed" : "pending",
				answer: r?.answer ?? null,
				citedThreadIds: r?.citedThreadIds ?? [],
				steps,
				createdAt: t?.createdAt ?? r?.createdAt ?? 0,
			};
		});

		return {
			integrityIssues,
			rev: page.rev,
			streamId: page.streamId,
			threads,
			messages,
			pendingTasks,
			presence,
			scheduledJobs,
			subagentRuns,
			rawEntryCount: items.length,
		};
	}
}
