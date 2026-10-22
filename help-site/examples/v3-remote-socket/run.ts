// Stage 3 (v3-remote-socket): SpaceService & RemoteSpace over Unix-Socket + Consumer Mailboxes.
// Decouples the Space-Chat host from the gateway, chat worker, and search subagent.
// Demonstrates:
//   - SpaceService + serveSpace over a Unix domain socket
//   - Separate RemoteSpace clients for Gateway, Chat-Worker, and Search-Subagent
//   - Consumer Mailbox subscription (`notify` + `events` + prefix `ack`)
//   - Running the exact same SpaceChatEngine over RemoteSpace without changing application logic

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createSpace, DEFAULT_POLICY, FOREVER, GateIdentity, Meter, PhiSpaces, RemoteSpace, serveSpace, socketTransport, SpaceService, startService } from "../../../src/index.ts";
import { spaces } from "../../../src/agent.ts";
import { SpaceChatEngine } from "../shared/chat-core.ts";

export async function runStageV3() {
	const dir = await mkdtemp(join(tmpdir(), "phi-spaces-chat-v3-"));
	const dbPath = join(dir, "chat-v3.sqlite");
	const socketPath = join(dir, "space.sock");
	const meter = new Meter();

	const registry = createRegistry();
	registry.install(spaces);
	const storage = await openNodeSqliteStorage(dbPath);
	const harness = await Harness.open(storage, { models: createModels(), registry }, ctx);
	await harness.commit(async (tx) => {
		await createSpace(tx, "chat-v3", Date.now());
	}, ctx);
	const stopService = await startService(harness, ctx);

	// Host installs CompletionProfiles before exposing the socket
	const hostAdminSpace = new PhiSpaces(harness, ctx, Date.now, meter, undefined, { space: "chat-v3" });
	await new SpaceChatEngine(hostAdminSpace).installProfilesIfSupported();

	const service = new SpaceService({
		host: harness,
		ctx,
		identity: new GateIdentity(),
		policy: DEFAULT_POLICY,
	});
	const spaceServer = await serveSpace(service, {
		listen: { path: socketPath },
		connection: () => ({
			peerId: "remote-chat-peer",
			credentials: { roles: ["admin", "member"] },
		}),
	});

	// Create 3 separate RemoteSpace clients over Unix socket
	const gwTransport = socketTransport({ path: socketPath });
	const workerTransport = socketTransport({ path: socketPath });
	const searchTransport = socketTransport({ path: socketPath });

	const gatewayRemote = new RemoteSpace(gwTransport, { space: "chat-v3" });
	const workerRemote = new RemoteSpace(workerTransport, { space: "chat-v3" });
	const searchRemote = new RemoteSpace(searchTransport, { space: "chat-v3" });

	try {
		const gatewayEngine = new SpaceChatEngine(gatewayRemote);
		const workerEngine = new SpaceChatEngine(workerRemote);
		const searchEngine = new SpaceChatEngine(searchRemote);

		// Register a durable notify subscription on the worker's consumer mailbox
		const notifySub = await workerRemote.notify(
			{ type: "Msg" },
			{ target: "self", lease: FOREVER, handback: { listener: "chat-ui-broadcaster" } },
		);

		await gatewayEngine.joinOrRefreshPresence({
			participantId: "alice",
			username: "Alice (Remote)",
			activeThreadId: "thread-remote-1",
			requestId: "v3-join-alice",
		});

		await gatewayEngine.createThread({
			threadId: "thread-remote-1",
			title: "Remote Socket Architektur",
			createdBy: "alice",
			requestId: "v3-create-t1",
		});
		await gatewayEngine.submitMessage({
			threadId: "thread-remote-1",
			author: "alice",
			text: "Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen.",
			requestId: "v3-msg-1",
		});
		// Process via the separate worker RemoteSpace!
		await workerEngine.processNextChatTask({ autoRunSubagent: false });

		await gatewayEngine.createThread({
			threadId: "thread-remote-2",
			title: "Remote Subagent Abfrage",
			createdBy: "bob",
			requestId: "v3-create-t2",
		});
		await gatewayEngine.submitMessage({
			threadId: "thread-remote-2",
			author: "bob",
			text: "Was haben wir bezüglich des Event-Stores entschieden?",
			requestId: "v3-msg-2",
		});

		// Run search subagent on its own RemoteSpace when SearchTask appears, then complete chat task
		const chatPromise = workerEngine.processNextChatTask({ autoRunSubagent: false });
		await new Promise((r) => setTimeout(r, 40));
		const subagentRun = await searchEngine.processNextSearchTask(2_000);
		await chatPromise;

		// Drain consumer mailbox and send prefix ACK
		const mailboxPage = await workerRemote.events({ waitMs: 50 });
		let ackedUpTo: number | null = null;
		if (mailboxPage.next !== null) {
			const ackRes = await workerRemote.ack(mailboxPage.mailboxEpoch, mailboxPage.next);
			ackedUpTo = ackRes.acked;
		}
		await workerRemote.cancel(notifySub.lease.id);

		const snapshot = await gatewayEngine.inspectSnapshot();
		return {
			stage: "v3-remote-socket" as const,
			socketPath,
			mailboxEpoch: mailboxPage.mailboxEpoch,
			mailboxEventsReceived: mailboxPage.events.length,
			ackedUpTo,
			subagentRun,
			snapshot,
		};
	} finally {
		gwTransport.close();
		workerTransport.close();
		searchTransport.close();
		await spaceServer.close();
		await stopService();
		await harness.close(ctx);
		await rm(dir, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV3();
	console.log("=== Stage v3 (SpaceService + RemoteSpace + Consumer Mailbox) Completed ===");
	console.log(`Mailbox Epoch: ${result.mailboxEpoch}, Events: ${result.mailboxEventsReceived}, ACKed up to: ${result.ackedUpTo}`);
	for (const m of result.snapshot.messages) {
		console.log(`  [${m.threadId} #${m.seq}] ${m.author} (${m.role}): ${m.text}`);
	}
}
