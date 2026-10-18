// Stage 6 (v6-mobile-control): Mobile App (pi-termux-mobile) & Web-Admin (AdminSpaces) Control.
// Demonstrates the operational control plane used by both `pi-termux-mobile` (`spaces.html` + `steuerung.html`)
// and the login-protected `AdminSpaces` area on `https://spaces.eibrain.org`:
//   1. Generating QR/token enrollment payloads (`enrollQr`) for pairing a phone or admin client
//   2. Managing space lifecycles (`SpaceLifecycle`: `create`, `archive`, `reactivate`, `delete`)
//   3. Scaling chat & search workers via signed `WorkerAssignments` and `WorkerSupervisor`
//   4. Controlling runs (`RunController` + `RunGate` pause/resume with confirmed ACK barrier)
//   5. Monitoring alerts (`collectAlerts`) and audit logs (`auditLog`)

import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import {
	auditLog,
	collectAlerts,
	CONTROL_SPACE,
	createSpace,
	enrollQr,
	FOREVER,
	generateKey,
	hashToken,
	localRunMember,
	Meter,
	newEnrollToken,
	PhiSpaces,
	RunController,
	SpaceLifecycle,
	spaces,
	startService,
	WorkerAssignments,
	WorkerSupervisor,
	type WorkerKind,
} from "../../../src/index.ts";
import {
	configureGatedSieveSpace,
	normalizeSieveRunConfig,
	prepareSieveRun,
	SIEVE_EXPORTER,
	SIEVE_WORKER_KIND,
} from "../../../examples/sieve.ts";
import { SpaceChatEngine } from "../shared/chat-core.ts";

export async function runStageV6() {
	const meter = new Meter();
	const registry = createRegistry();
	registry.install(spaces);
	const harness = await Harness.open(new MemoryStorage(), { models: createModels(), registry }, ctx);
	const controlSpaceId = (await harness.commit((tx) => createSpace(tx, CONTROL_SPACE, Date.now()), ctx)).spaceId;
	const sieveSpaceId = (await harness.commit((tx) => createSpace(tx, "sieve-ops", Date.now()), ctx)).spaceId;
	const stopService = await startService(harness, ctx);

	const authorityId = "authority-ops-v6";
	const controlKey = generateKey("ed25519", "coordinator-control");
	const controllerPin = {
		issuer: "coordinator-host",
		algorithm: controlKey.signer.algorithm,
		publicKey: controlKey.publicKey,
	};

	try {
		const controlSpace = new PhiSpaces(harness, ctx, Date.now, meter, undefined, { space: controlSpaceId });

		// 1. Generate a Mobile Enrollment QR payload (`enrollQr`) for `pi-termux-mobile` (`spaces.html`)
		const mobileToken = newEnrollToken();
		const mobileQrPayload = enrollQr({
			token: mobileToken,
			endpoint: "tcp://100.64.0.10:9440",
			controlSpaceId,
		});
		await controlSpace.write(
			{
				type: "Enroll",
				fields: {
					tokenHash: hashToken(mobileToken),
					role: "admin",
					allowedPeerId: "mobile-admin-xiaomi",
					scope: ["*"],
				},
			},
			null,
			600_000,
		);

		// 2. Space Lifecycle (`createSpace`, `archiveSpace`, `reactivateSpace`)
		const lifecycle = new SpaceLifecycle({
			host: harness,
			ctx,
			now: Date.now,
		});
		const createdChatSpace = await lifecycle.apply({
			commandId: "m-createSpace-chat-room-1",
			action: "create",
			alias: "chat-ops-room",
		});

		const chatSpace = new PhiSpaces(harness, ctx, Date.now, meter, undefined, {
			space: createdChatSpace.spaceId,
		});
		const chatEngine = new SpaceChatEngine(chatSpace);
		await chatEngine.installProfilesIfSupported();

		await chatEngine.createThread({
			threadId: "ops-thread",
			title: "Mobile & Web Admin gesteuerter Thread",
			createdBy: "admin",
			requestId: "v6-t1",
		});
		await chatEngine.submitMessage({
			threadId: "ops-thread",
			author: "alice",
			text: "Worker für diesen Space wird gleich über WorkerSupervisor skaliert!",
			requestId: "v6-m1",
		});

		// 3. Scale Chat Workers via signed `WorkerAssignments` + `WorkerSupervisor` (like `setWorkers` on phone/web)
		const workerAssignments = new WorkerAssignments({
			host: harness,
			ctx,
			authorityId,
			peerId: "coordinator-host",
			signer: controlKey.signer,
			identity: async () => ({ incarnation: "inc-ops-1" }),
		});

		const chatWorkerKind: WorkerKind = {
			step: async ({ space }) => {
				const eng = new SpaceChatEngine(space);
				const msg = await eng.processNextChatTask({ timeoutMs: 20 });
				return msg !== null;
			},
		};

		const workerSupervisor = new WorkerSupervisor({
			host: harness,
			ctx,
			hostId: "coordinator-host",
			authorityId,
			controllerPin,
			kinds: {
				"chat-worker": chatWorkerKind,
				sieve: SIEVE_WORKER_KIND,
			},
			fetch: () => workerAssignments.forHost("coordinator-host"),
		});

		await workerAssignments.set("m-setWorkers-1", {
			assignmentId: "assign-chat-1",
			hostId: "coordinator-host",
			kind: "chat-worker",
			targetSpace: createdChatSpace.spaceId,
			count: 2,
		});
		const workerSummary = await workerSupervisor.reconcile();
		// Wait briefly for the supervised chat-worker loop to process Alice's message!
		for (let i = 0; i < 30; i++) {
			const snap = await chatEngine.inspectSnapshot();
			if (snap.messages.length >= 2) break;
			await new Promise((r) => setTimeout(r, 15));
		}
		// Scale worker down to 0 cleanly after task completion
		await workerAssignments.set("m-setWorkers-2", {
			assignmentId: "assign-chat-1",
			hostId: "coordinator-host",
			kind: "chat-worker",
			targetSpace: createdChatSpace.spaceId,
			count: 0,
		});
		await workerSupervisor.reconcile();
		await workerSupervisor.stop();

		// 4. RunController + RunGate pause/resume barrier (like `startRun` / `pauseRun` / `resumeRun` on phone/web)
		await configureGatedSieveSpace(harness, sieveSpaceId);
		const runMember = localRunMember(harness, ctx, sieveSpaceId, async (run, space) => {
			await prepareSieveRun(
				harness,
				normalizeSieveRunConfig(run.runId, run.config as Record<string, unknown> | undefined),
				{ space },
			);
		});
		const runController = new RunController({
			host: harness,
			ctx,
			member: () => runMember,
			space: (id: string) => new PhiSpaces(harness, ctx, Date.now, meter, undefined, { space: id }),
			exporters: { sieve: SIEVE_EXPORTER },
		});

		const runStarted = await runController.start("m-startRun-1", {
			runId: "run-sieve-demo",
			kind: "sieve",
			members: [sieveSpaceId],
			config: { start: 1, end: 201, blockSize: 100 },
		});
		const runPaused = await runController.pause("m-pauseRun-1", "run-sieve-demo");
		const runResumed = await runController.resume("m-resumeRun-1", "run-sieve-demo");

		// 5. Archive the chat space (`archiveSpace` locks mutations while keeping history readable!) & reactivate
		const archived = await lifecycle.apply({
			commandId: "m-archiveSpace-1",
			action: "archive",
			spaceId: createdChatSpace.spaceId,
		});
		const reactivated = await lifecycle.apply({
			commandId: "m-reactivateSpace-1",
			action: "reactivate",
			spaceId: createdChatSpace.spaceId,
		});

		// 6. Collect alerts & audit log
		await controlSpace.write(
			{
				type: "Result",
				fields: {
					commandId: "m-setWorkers-1",
					kind: "setWorkers",
					state: "completed",
					requestedBy: "mobile-admin-xiaomi",
					at: Date.now(),
				},
			},
			null,
			FOREVER,
		);
		const alerts = await collectAlerts({
			runs: runController,
			workers: workerAssignments,
			host: harness,
			ctx,
			controlSpaceId,
			now: Date.now,
		});
		const auditEntries = await auditLog(harness, ctx, controlSpaceId);
		const chatSnapshot = await chatEngine.inspectSnapshot();

		return {
			stage: "v6-mobile-control" as const,
			mobileQrPayload,
			createdChatSpace,
			archivedState: archived.state,
			reactivatedState: reactivated.state,
			workerGeneration: workerSummary.generation,
			runStates: {
				started: runStarted.state,
				paused: runPaused.state,
				resumed: runResumed.state,
			},
			alerts,
			auditEntries,
			chatSnapshot,
			snapshot: chatSnapshot,
		};
	} finally {
		await stopService();
		await harness.close(ctx);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV6();
	console.log("=== Stage v6 (Mobile App & Web Admin Control Plane) Completed ===");
	console.log("Mobile Enrollment QR Payload:", result.mobileQrPayload);
	console.log("RunGate transitions:", result.runStates);
	console.log("Space Lifecycle:", result.createdChatSpace.alias, "->", result.archivedState, "->", result.reactivatedState);
	console.log("Supervised Chat Messages:", result.chatSnapshot.messages.length);
}
