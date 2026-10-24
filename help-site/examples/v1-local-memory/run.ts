// Stage 1 (v1-local-memory): Zero-Setup In-Memory Multiplayer Space-Chat.
// Runs immediately in RAM with the own store in memory (openOwnMemoryHost) + PhiSpaces + startService.
// Demonstrates:
//   - NamedSpace isolation ("chat-v1")
//   - Presence entries with 30s leases and heartbeat renewal
//   - Thread creation and message submission with RequestRef claims
//   - Transactional ChatTask worker enforced by CompletionProfile
//   - Conversation forking up to a selected message sequence number

import { BACKGROUND_CONTEXT as ctx } from "phi-spaces/context";
import { createSpace, Meter, PhiSpaces, openOwnMemoryHost, startService } from "phi-spaces";
import { SpaceChatEngine } from "../shared/chat-core.ts";
import { pathToFileURL } from "node:url";

export async function runStageV1() {
	const meter = new Meter();
	const host = openOwnMemoryHost();
	await host.commit(async (tx) => {
		await createSpace(tx, "chat-v1", Date.now());
	}, ctx);
	const stopService = await startService(host, ctx);

	try {

		const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" });
		const engine = new SpaceChatEngine(space);
		await engine.installProfilesIfSupported();

		// 1. Alice and Bob join the session with 30s Presence leases
		const aliceLease = await engine.joinOrRefreshPresence({
			participantId: "alice",
			username: "Alice",
			activeThreadId: "thread-main",
			status: "online",
			leaseMs: 30_000,
			requestId: "join-alice-1",
		});
		await engine.joinOrRefreshPresence({
			participantId: "bob",
			username: "Bob",
			activeThreadId: "thread-main",
			status: "online",
			leaseMs: 30_000,
			requestId: "join-bob-1",
		});
		const renewedExpires = await engine.renewPresence("alice", 45_000);

		// 2. Create main thread (and verify RequestRef idempotency on duplicate requestId)
		const mainThread = await engine.createThread({
			threadId: "thread-main",
			title: "Architektur & Event-Store",
			createdBy: "alice",
			requestId: "cmd-create-main",
		});
		const duplicateRetry = await engine.createThread({
			threadId: "thread-main",
			title: "Architektur & Event-Store",
			createdBy: "alice",
			requestId: "cmd-create-main",
		});

		// 3. Alice sends a message and the transactional worker replies under CompletionProfile
		await engine.submitMessage({
			threadId: "thread-main",
			author: "alice",
			text: "Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.",
			requestId: "msg-alice-1",
		});
		await engine.processNextChatTask();

		// 4. Bob forks the thread after message #2 into "thread-fork-1"
		const forkedThread = await engine.forkThread({
			newThreadId: "thread-fork-1",
			parentThreadId: "thread-main",
			forkUpToSeq: 2,
			title: "Fork: Read-Replicas Diskussion",
			createdBy: "bob",
			requestId: "cmd-fork-1",
		});
		await engine.submitMessage({
			threadId: "thread-fork-1",
			author: "bob",
			text: "Im Fork testen wir zusätzlich einen lokalen Read-Cache.",
			requestId: "msg-bob-fork-1",
		});
		await engine.processNextChatTask();

		const snapshot = await engine.inspectSnapshot();
		const physicalMsgCount = (await space.readAll({ type: "Msg" })).length;
		return {
			stage: "v1-local-memory" as const,
			spaceId: "chat-v1",
			idempotentThreadMatch: mainThread.threadId === duplicateRetry.threadId,
			aliceLeaseRenewed: (renewedExpires ?? 0) >= aliceLease.expires,
			forkedThreadId: forkedThread.threadId,
			physicalMsgCount,
			snapshot,
			metrics: meter.snapshot(10),
		};
	} finally {
		await stopService();
		await host.close(ctx);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV1();
	console.log("=== Stage v1 (Local Memory) Completed ===");
	console.log(`Threads: ${result.snapshot.threads.length}, Messages: ${result.snapshot.messages.length}, Presence: ${result.snapshot.presence.length}`);
	for (const m of result.snapshot.messages) {
		console.log(`  [${m.threadId} #${m.seq}] ${m.author} (${m.role}): ${m.text}`);
	}
}
