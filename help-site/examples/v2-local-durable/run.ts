// Stage 2 (v2-local-durable): Local SQLite Persistence, Crash/Reopen Recovery, Alarms & Search Subagent.
// Demonstrates the full Earendil sequence on persistent SQLite storage using pure pi-spaces primitives:
//   1. Thread 1: Alice states "We decided to use PostgreSQL for the event store."
//   2. Thread 2: Bob asks "Was haben wir bezüglich des Event-Stores entschieden?" -> Search Subagent runs
//   3. Alice schedules an alarm ("Erinnere uns in 50 ms daran, das Backup-Fenster zu prüfen")
//   4. Simulated process restart: Harness is closed and reopened on the same SQLite file;
//      the expired TimerLock lease is reaped and the wakeup ChatTask produces the alarm Msg!

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSpace, Meter, PiSpaces, spaces, startService } from "../../../src/index.ts";
import { SpaceChatEngine } from "../shared/chat-core.ts";

export async function runStageV2(options: { dbDir?: string; keepDir?: boolean } = {}) {
	const dir = options.dbDir ?? (await mkdtemp(join(tmpdir(), "pi-spaces-chat-v2-")));
	const dbPath = join(dir, "chat-v2.sqlite");
	const meter = new Meter();

	try {
		// ---- Phase A: Initial run before simulated restart ----
		{
			const registry = createRegistry();
			registry.install(spaces);
			const storage = await openNodeSqliteStorage(dbPath);
			const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
			await harness.commit(async (tx) => {
				await createSpace(tx, "chat-v2", Date.now());
			}, ctx);
			const stopService = await startService(harness, ctx);

			try {

				const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v2" });
				const engine = new SpaceChatEngine(space);
				await engine.installProfilesIfSupported();

				await engine.createThread({
					threadId: "thread-1",
					title: "1. Architektur-Entscheidungen",
					createdBy: "alice",
					requestId: "v2-create-t1",
				});
				await engine.submitMessage({
					threadId: "thread-1",
					author: "alice",
					text: "Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.",
					requestId: "v2-msg-1",
				});
				await engine.processNextChatTask();

				// Create second thread and ask about the event store decision -> triggers SearchTask subagent
				await engine.createThread({
					threadId: "thread-2",
					title: "2. Rückfragen & Subagent-Suche",
					createdBy: "bob",
					requestId: "v2-create-t2",
				});
				await engine.submitMessage({
					threadId: "thread-2",
					author: "bob",
					text: "Was haben wir bezüglich des Event-Stores entschieden?",
					requestId: "v2-msg-2",
				});
				await engine.processNextChatTask({ autoRunSubagent: true });

				// Schedule a reminder with a short 60ms TimerLock lease, then close the server!
				await engine.scheduleReminder({
					jobId: "alarm-backup-check",
					threadId: "thread-2",
					instruction: "Wetter- und Backup-Status nach Neustart prüfen",
					requestedBy: "alice",
					delayMs: 60,
					requestId: "v2-alarm-1",
				});
			} finally {
				await stopService();
				await harness.close(ctx);
			}
		}

		// Wait for the TimerLock lease (60ms) to elapse while the server is "hibernating / stopped"
		await new Promise((r) => setTimeout(r, 90));

		// ---- Phase B: Reopen the same SQLite store, reap expired TimerLock & process alarm ----
		{
			const registry = createRegistry();
			registry.install(spaces);
			const storage = await openNodeSqliteStorage(dbPath);
			const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
			const stopService = await startService(harness, ctx);

			try {
				const space = new PiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v2" });
				const engine = new SpaceChatEngine(space);

				const triggeredJobs = await engine.tickAlarms();
				const alarmReply = await engine.processNextChatTask();
				const snapshot = await engine.inspectSnapshot();

				return {
					stage: "v2-local-durable" as const,
					dbPath,
					triggeredJobs,
					alarmReplyText: alarmReply?.text ?? null,
					subagentRuns: snapshot.subagentRuns,
					snapshot,
				};
			} finally {
				await stopService();
				await harness.close(ctx);
			}
		}
	} finally {
		if (!options.keepDir && !options.dbDir) {
			await rm(dir, { recursive: true, force: true });
		}
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV2();
	console.log("=== Stage v2 (Local Durable SQLite + Alarms + Subagent) Completed ===");
	console.log(`Triggered alarms after reopen: ${result.triggeredJobs.join(", ")}`);
	console.log(`Subagent runs: ${result.subagentRuns.length}`);
	for (const m of result.snapshot.messages) {
		console.log(`  [${m.threadId} #${m.seq}] ${m.author} (${m.role}): ${m.text}`);
	}
}
