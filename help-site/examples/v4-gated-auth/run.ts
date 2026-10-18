// Stage 4 (v4-gated-auth): Overlay Gate (Layer A/B), Token Enrollment, 60s Grants, BootGuard & Key Rotation.
// Runs two independent persistent Harnesses (Control Host + Data Host) behind real TCP Gates.
// Demonstrates:
//   - SqliteRecoveryRegister + HostBootState boot guard
//   - Admin bootstrap pairing + Supervisor `createEnroll` for the Chat Worker
//   - Layer A (PeerDirectory) + Layer B (Ed25519 challenge-response proof)
//   - 60-second short-lived grants (`requestGrant("effect")`) checked before every Chat mutation
//   - Live own-key rotation (`rotateKey`) of the Chat Worker without interrupting the session

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import {
	bootstrapEnroll,
	CONTROL_SPACE,
	createSpace,
	GateIdentity,
	generateKey,
	GrantAuthority,
	GrantVerifier,
	hashToken,
	listSpaces,
	newEnrollToken,
	PhiSpaces,
	RemoteSpace,
	socketTransport,
	spaceDoc,
	SpaceKeyDirectory,
	spaces,
	SqliteRecoveryRegister,
	startFederationHost,
	startService,
	type Signer,
} from "../../../src/index.ts";
import { SpaceChatEngine } from "../shared/chat-core.ts";

const until = async (fn: () => Promise<boolean>, ms = 5_000) => {
	const deadline = Date.now() + ms;
	while (!(await fn())) {
		if (Date.now() > deadline) throw new Error("Timed out waiting for condition");
		await new Promise((r) => setTimeout(r, 15));
	}
};

export async function runStageV4() {
	const dir = await mkdtemp(join(tmpdir(), "phi-spaces-chat-v4-"));
	const controlDb = join(dir, "control.sqlite");
	const dataDb = join(dir, "data.sqlite");
	const externalReg = new SqliteRecoveryRegister(join(dir, "external-boot.sqlite"));
	const installedReg = new SqliteRecoveryRegister(join(dir, "installed-boot.sqlite"));

	const registry1 = createRegistry();
	registry1.install(spaces);
	const registry2 = createRegistry();
	registry2.install(spaces);

	const controlHarness = await Harness.open(
		await openNodeSqliteStorage(controlDb),
		{ models: createModels(), registry: registry1 },
		ctx,
	);
	const dataHarness = await Harness.open(
		await openNodeSqliteStorage(dataDb),
		{ models: createModels(), registry: registry2 },
		ctx,
	);
	await dataHarness.commit(async (tx) => {
		await createSpace(tx, "chat-v4", Date.now());
	}, ctx);
	const stopControlService = await startService(controlHarness, ctx);
	const stopDataService = await startService(dataHarness, ctx);

	const authorityId = "authority-chat-v4";
	const provisionBoot = async (host: Harness, hostId: string) => {
		await host.commit((tx) => spaceDoc(tx, undefined, Date.now()), ctx);
		const spacesMap: Record<string, any> = {};
		for (const info of await listSpaces(host, ctx)) {
			const permit = {
				state: "active" as const,
				authorityId,
				dataIncarnation: info.incarnation,
				role: "local" as const,
				transitionId: "v4-bootstrap",
			};
			spacesMap[info.spaceId] = permit;
			await installedReg.compareAndSet(`installed:${hostId}:${info.spaceId}`, null, permit);
		}
		await externalReg.compareAndSet(`boot:${hostId}`, null, {
			hostId,
			state: "active",
			spaces: spacesMap,
		});
		return { external: externalReg, installed: installedReg };
	};

	// Simulated NetBird Overlay Directory (Layer A)
	const peers = new Map([
		["127.0.0.1", { id: "chat-worker", name: "chat-worker", ip: "127.0.0.1", connected: true, groups: ["space-enroll"] }],
	]);
	const directory = {
		refresh: async () => {},
		lookup: async (ip: string) => peers.get(ip) ?? peers.get("127.0.0.1") ?? null,
	};
	const groupRoles = {
		"space-admin": ["admin", "member", "host"],
		"space-members": ["member"],
		"space-enroll": ["unpaired"],
	};

	const rootKey = generateKey("ed25519", "control-signer");
	const identity = new GateIdentity();
	const keys = new SpaceKeyDirectory(controlHarness, ctx, Date.now);
	const verifier = () =>
		new GrantVerifier({
			authorityId,
			issuerHostId: "control-host",
			publicKey: rootKey.publicKey,
			algorithm: "ed25519",
		});
	const authority = () =>
		new GrantAuthority({
			authorityId,
			hostId: "control-host",
			signer: rootKey.signer,
			keys,
			identity,
			refreshIdentity: async (conn) => {
				const p = await directory.lookup(conn.overlayIp ?? "127.0.0.1");
				return p
					? identity.authenticate({
							...conn,
							credentials: {
								roles: p.groups.flatMap((g) => groupRoles[g as keyof typeof groupRoles] ?? []),
							},
						})
					: null;
			},
		});

	const sockets: Array<ReturnType<typeof socketTransport>> = [];
	let controlHost: Awaited<ReturnType<typeof startFederationHost>> | undefined;
	let dataHost: Awaited<ReturnType<typeof startFederationHost>> | undefined;

	try {
		// 1. Bootstrap enrollment token for "chat-worker" (acting as admin + worker for the demo)
		const workerInitialKey = generateKey("ed25519", "worker-initial");
		const enrollToken = newEnrollToken();
		await bootstrapEnroll(controlHarness, ctx, {
			tokenHash: hashToken(enrollToken),
			allowedPeerId: "chat-worker",
		});

		controlHost = await startFederationHost(controlHarness, ctx, {
			hostId: "control-host",
			authorityId,
			keys,
			verifier: verifier(),
			boot: await provisionBoot(controlHarness, "control-host"),
			control: { host: controlHarness, authority: authority() },
			directory,
			groupRoles,
			listen: { host: "127.0.0.1", port: 0 },
			revalidateMs: 0,
		});
		const controlPort = (controlHost.address() as any).port as number;

		const makeControlClient = (signer: Signer) => {
			const sock = socketTransport({ host: "127.0.0.1", port: controlPort });
			sockets.push(sock);
			const client: RemoteSpace = new RemoteSpace(sock, {
				space: CONTROL_SPACE,
				signer,
				expectedGateHostId: "control-host",
				ownPeerId: "chat-worker",
				grantProvider: () => client.requestGrant(),
			});
			return client;
		};

		// Pair the worker using the one-time token, then promote its overlay group to space-admin
		let controlClient = makeControlClient(workerInitialKey.signer);
		const enrolled = await controlClient.enroll(enrollToken);
		peers.get("127.0.0.1")!.groups = ["space-admin"];
		await controlHost.revalidate();

		const activeSigner: Signer = { ...workerInitialKey.signer, keyId: enrolled.keyId };
		controlClient = makeControlClient(activeSigner);
		await controlClient.authenticate();

		// 2. Prepare Data Host with "chat-v4" space and CompletionProfiles
		const localDataSpace = new PhiSpaces(dataHarness, ctx, Date.now, undefined, undefined, { space: "chat-v4" });
		await new SpaceChatEngine(localDataSpace).installProfilesIfSupported();

		const networkKeys = {
			find: (peerId: string, keyId: string) => controlClient.lookupPeerKey(peerId, keyId),
		};
		dataHost = await startFederationHost(dataHarness, ctx, {
			hostId: "data-host",
			authorityId,
			keys: networkKeys,
			verifier: verifier(),
			boot: await provisionBoot(dataHarness, "data-host"),
			directory,
			groupRoles,
			listen: { host: "127.0.0.1", port: 0 },
			revalidateMs: 0,
		});
		const dataPort = (dataHost.address() as any).port as number;

		// 3. Connect gated RemoteSpace to Data Host using 60s Grants from Control Host!
		const dataSock = socketTransport({ host: "127.0.0.1", port: dataPort });
		sockets.push(dataSock);
		const gatedChatSpace = new RemoteSpace(dataSock, {
			space: "chat-v4",
			signer: activeSigner,
			expectedGateHostId: "data-host",
			ownPeerId: "chat-worker",
			grantProvider: () => controlClient.requestGrant("effect"),
		});

		const engine = new SpaceChatEngine(gatedChatSpace);
		await engine.createThread({
			threadId: "thread-gated",
			title: "Zero-Trust Gated Chat (Layer A/B + 60s Grants)",
			createdBy: "alice",
			requestId: "v4-create-t1",
		});
		await engine.submitMessage({
			threadId: "thread-gated",
			author: "alice",
			text: "Jeder Schreibvorgang hier ist mit Ed25519-Challenge und 60-Sekunden-Grant gesichert.",
			requestId: "v4-msg-1",
		});
		await engine.processNextChatTask();

		// 4. Perform live own-key rotation (`rotateKey`) and continue chatting with the new key!
		const replacementKey = generateKey("ed25519", "worker-rotated");
		const challenge = await controlClient.rotationChallenge(
			replacementKey.signer.algorithm,
			replacementKey.publicKey,
		);
		const rotation = await controlClient.rotateKey(challenge, replacementKey.signer);
		await until(
			async () =>
				(
					await new PhiSpaces(controlHarness, ctx, Date.now, undefined, undefined, {
						space: CONTROL_SPACE,
					}).readAll({ type: "Result", fields: { commandId: rotation.commandId } })
				).length === 1,
		);

		const oldKeyState = (await keys.find("chat-worker", enrolled.keyId))?.state;
		const newKeyState = (await keys.find("chat-worker", challenge.newKeyId))?.state;
		await controlHost.revalidate();
		await dataHost.revalidate();

		// Reconnect with the newly rotated key to prove zero-downtime continuation!
		const rotatedSigner: Signer = { ...replacementKey.signer, keyId: challenge.newKeyId };
		const rotatedControl = makeControlClient(rotatedSigner);
		await rotatedControl.authenticate();
		controlClient = rotatedControl; // Update the control client used by networkKeys.find!
		const rotatedDataSock = socketTransport({ host: "127.0.0.1", port: dataPort });
		sockets.push(rotatedDataSock);
		const rotatedChatSpace = new RemoteSpace(rotatedDataSock, {
			space: "chat-v4",
			signer: rotatedSigner,
			expectedGateHostId: "data-host",
			ownPeerId: "chat-worker",
			grantProvider: () => rotatedControl.requestGrant("effect"),
		});
		const rotatedEngine = new SpaceChatEngine(rotatedChatSpace);
		await rotatedEngine.submitMessage({
			threadId: "thread-gated",
			author: "bob",
			text: "Nachricht nach Live-Key-Rotation mit neuem Ed25519-Schlüssel erfolgreich gesendet!",
			requestId: "v4-msg-after-rotate",
		});
		await rotatedEngine.processNextChatTask();

		const snapshot = await rotatedEngine.inspectSnapshot();
		return {
			stage: "v4-gated-auth" as const,
			authorityId,
			enrolledKeyId: enrolled.keyId,
			rotatedKeyId: challenge.newKeyId,
			oldKeyState,
			newKeyState,
			snapshot,
		};
	} finally {
		for (const s of sockets) s.close();
		await dataHost?.close();
		await controlHost?.close();
		await stopDataService();
		await stopControlService();
		await dataHarness.close(ctx);
		await controlHarness.close(ctx);
		externalReg.close();
		installedReg.close();
		await rm(dir, { recursive: true, force: true });
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV4();
	console.log("=== Stage v4 (Overlay Gate Layer A/B + 60s Grants + Live Key Rotation) Completed ===");
	console.log(`Initial Key: ${result.enrolledKeyId} (${result.oldKeyState}) -> Rotated Key: ${result.rotatedKeyId} (${result.newKeyState})`);
	for (const m of result.snapshot.messages) {
		console.log(`  [${m.threadId} #${m.seq}] ${m.author} (${m.role}): ${m.text}`);
	}
}
