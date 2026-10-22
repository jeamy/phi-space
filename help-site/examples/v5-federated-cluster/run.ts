// Stage 5 (v5-federated-cluster): Federated Spaces with HRW Routing by threadId & Phase 3 LWW Presence.
// Distributes Multiplayer Space-Chat threads across 3 Member Spaces (member-1, member-2, member-3)
// using `FederatedSpace` + `RouterController` + `FederationPolicy` (HRW by `threadId`),
// and demonstrates cross-member search plus Phase 3 `EntryReplicationController` (HLC + LWW) for Presence.

import { pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT as ctx } from "../../../src/context.ts";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { FOREVER, PhiSpaces, Space, startService } from "../../../src/index.ts";
import { spaces } from "../../../src/agent.ts";
import { FederatedSpace, type FederationIO } from "../../../src/federated-space.ts";
import { partitionRouterId } from "../../../src/federation-journals.ts";
import { RouterController } from "../../../src/router.ts";
import type { RoutingState } from "../../../src/routing-semantics.ts";
import { EntryReplicationController } from "../../../src/entry-replication.ts";
import {
	CHAT_COMPLETION_PROFILES,
	type MsgRecord,
	type PresenceRecord,
	type SpaceChatSnapshot,
	type ThreadRecord,
} from "../shared/chat-core.ts";

export async function runStageV5() {
	const makeHarness = async () => {
		const reg = createRegistry();
		reg.install(spaces);
		return await Harness.open(new MemoryStorage(), { models: createModels(), registry: reg }, ctx);
	};

	const coordinatorHost = await makeHarness();
	const memberHosts = {
		"member-1": await makeHarness(),
		"member-2": await makeHarness(),
		"member-3": await makeHarness(),
	} as const;
	type MemberId = keyof typeof memberHosts;
	const memberIds: MemberId[] = ["member-1", "member-2", "member-3"];

	const stops = [
		await startService(coordinatorHost, ctx),
		await startService(memberHosts["member-1"], ctx),
		await startService(memberHosts["member-2"], ctx),
		await startService(memberHosts["member-3"], ctx),
	];

	try {
		const memberSpaces: Record<MemberId, PhiSpaces> = {
			"member-1": new PhiSpaces(memberHosts["member-1"], ctx),
			"member-2": new PhiSpaces(memberHosts["member-2"], ctx),
			"member-3": new PhiSpaces(memberHosts["member-3"], ctx),
		};
		for (const m of memberIds) {
			await memberSpaces[m].setCompletionProfiles(CHAT_COMPLETION_PROFILES);
		}

		// HRW Federation Policy: Thread, Msg, and ChatTask route by `field: "threadId"` across all 3 members!
		const authorityId = "authority-fed-v5";
		const routingState: RoutingState = {
			policy: {
				authorityId,
				policyVersion: 1,
				default: { mode: "local", member: "member-1" },
				completionProfiles: CHAT_COMPLETION_PROFILES,
				rules: [
					{ type: "Thread", mode: "expand", by: { field: "threadId" }, members: [...memberIds] },
					{ type: "Msg", mode: "expand", by: { field: "threadId" }, members: [...memberIds] },
					{ type: "ChatTask", mode: "expand", by: { field: "threadId" }, members: [...memberIds] },
				],
			},
			members: Object.fromEntries(
				memberIds.map((id) => [
					id,
					{
						id,
						target: {
							hostId: `host-${id}`,
							spaceId: id,
							authorityId,
							dataIncarnation: "inc-1",
							primaryEpoch: 1,
						},
						state: "active" as const,
						capacity: { free: 100, at: Date.now() },
					},
				]),
			),
		};

		const principal = { peerId: "federated-chat-gateway" };
		const generations = new Map<string, string>();
		for (const id of memberIds) {
			const g = await memberSpaces[id].issueGeneration(principal);
			generations.set(id, g.generation);
		}

		const targetAdapter = {
			protocol: "phi-spaces-rpc-v1" as const,
			invoke: async (step: any) => {
				const m = step.target.spaceId as MemberId;
				const sp = memberSpaces[m];
				const req = {
					principal: step.principal,
					generation: step.generation,
					requestId: step.requestId,
				};
				const base = {
					target: step.target,
					principal: step.principal,
					method: step.method,
					generation: step.generation,
					requestId: step.requestId,
					argHash: step.argHash,
				};
				if (step.method === "write") {
					const lease = await sp.write(step.args.entry, step.args.txn ?? null, step.args.lease ?? FOREVER, {
						request: req,
					});
					return { ...base, outcome: "done" as const, result: lease as any };
				}
				if (step.method === "read") {
					const val = await sp.read(step.args.template ?? null, 0, {
						txn: step.args.txn ?? null,
						request: req,
					});
					return { ...base, outcome: "done" as const, result: val as any };
				}
				if (step.method === "take") {
					const val = await sp.take(step.args.template ?? null, 0, {
						txn: step.args.txn ?? null,
						request: req,
					});
					return { ...base, outcome: "done" as const, result: val as any };
				}
				if (step.method === "txn") {
					if (step.args.action === "begin") {
						const l = await sp.createTransaction(step.args.leaseMs ?? 30_000, { request: req });
						return { ...base, outcome: "done" as const, result: l as any };
					}
					if (step.args.action === "commit") {
						await sp.commit(step.args.txn, { request: req });
						return { ...base, outcome: "done" as const, result: "ok" as any };
					}
					await sp.abort(step.args.txn, { request: req });
					return { ...base, outcome: "done" as const, result: "ok" as any };
				}
				return { ...base, outcome: "done" as const, result: null };
			},
			resolve: async (step: any) => ({
				target: step.target,
				principal: step.principal,
				method: step.method,
				generation: step.generation,
				requestId: step.requestId,
				argHash: step.argHash,
				outcome: "notAdmitted" as const,
			}),
		};

		const makeRouter = (routerId: string) =>
			new RouterController({
				host: coordinatorHost,
				ctx,
				routerId,
				authorityId,
				target: targetAdapter as any,
				assertAuthority: async () => {},
			});

		const router = makeRouter("router-root");
		const partitionRouters = [0, 1].map((n) => makeRouter(partitionRouterId("fed-v5", n)));
		for (const r of [router, ...partitionRouters]) await r.recover();

		const io: FederationIO = {
			step: async (id, _p, method, args, policyVersion) => ({
				target: routingState.members[id]!.target,
				principal,
				generation: generations.get(id)!,
				method: method as any,
				args: args as any,
				policyVersion,
			}),
			snapshot: async (id, _p, template, txn) => {
				const m = id as MemberId;
				const entries = await memberSpaces[m].readAll(template, { txn });
				const doc = await memberHosts[m].snapshot(Space, ctx);
				return { entries, revision: doc?.rev ?? 0 };
			},
			events: async (id, p) => {
				const m = id as MemberId;
				const page = await memberSpaces[m].events(p);
				return {
					epoch: page.mailboxEpoch,
					events: page.events.map((e) => ({ seq: e.seq, event: e.event })),
					...(page.gap ? { gap: true } : {}),
				};
			},
			ack: async (id, p, epoch, upTo) => {
				const m = id as MemberId;
				await memberSpaces[m].ack(p, epoch, upTo);
			},
			txnActive: async (id, _p, txnId) => {
				const m = id as MemberId;
				const doc = await memberHosts[m].snapshot(Space, ctx);
				return Boolean(doc?.txns[txnId]);
			},
		};

		const federated = new FederatedSpace({
			host: coordinatorHost,
			ctx,
			id: "fed-v5",
			router,
			journalPartitions: 2,
			partitionRouters,
			state: async () => routingState,
			io,
			assertAuthority: async () => {},
			now: Date.now,
		});
		await federated.initializeJournals();

		// 1. Write 4 threads and messages via FederatedSpace -> HRW automatically shards them across member-1..3!
		const threadNames = ["thread-alpha", "thread-beta", "thread-gamma", "thread-delta"];
		for (let i = 0; i < threadNames.length; i++) {
			const tid = threadNames[i]!;
			await federated.write(
				{
					type: "Thread",
					fields: {
						threadId: tid,
						title: `HRW Thread ${tid}`,
						parentThreadId: "none",
						forkUpToSeq: 0,
						createdBy: "alice",
						createdAt: Date.now(),
					},
				},
				{ id: `fed-write-thread-${tid}`, principal },
				FOREVER,
			);
			await federated.write(
				{
					type: "Msg",
					fields: {
						msgId: `msg-${tid}-1`,
						threadId: tid,
						seq: 1,
						author: i === 0 ? "alice" : "bob",
						role: "user",
						text:
							i === 0
								? "Wir haben entschieden, PostgreSQL für den Event-Store zu nutzen."
								: `Diskussion in ${tid} auf eigenem HRW-Shard.`,
						taskId: "user-input",
						subagentSearchId: "none",
						createdAt: Date.now(),
					},
				},
				{ id: `fed-write-msg-${tid}`, principal },
				FOREVER,
			);
		}

		// 2. Federated cross-member search (`federated.readAll` queries all 3 members!)
		const allMessagesAcrossCluster = await federated.readAll({ type: "Msg" }, principal);

		const memberDistribution: Record<MemberId, string[]> = {
			"member-1": (await memberSpaces["member-1"].readAll({ type: "Thread" })).map(
				(e) => String(e.fields.threadId),
			),
			"member-2": (await memberSpaces["member-2"].readAll({ type: "Thread" })).map(
				(e) => String(e.fields.threadId),
			),
			"member-3": (await memberSpaces["member-3"].readAll({ type: "Thread" })).map(
				(e) => String(e.fields.threadId),
			),
		};

		// 3. Phase 3 Preview: EntryReplicationController (HLC + LWW) replicating Presence between member-1 and member-2
		const repMembers = [
			{ replicaId: "rep-1", incarnation: "rep-inc-1" },
			{ replicaId: "rep-2", incarnation: "rep-inc-1" },
		];
		const repRules = [{ type: "Presence", variant: "lww" as const, keyFields: ["participantId"] }];
		const rep1 = new EntryReplicationController({
			host: memberHosts["member-1"],
			ctx,
			config: {
				spaceId: "presence-global",
				authorityId,
				replicaId: "rep-1",
				incarnation: "rep-inc-1",
				members: repMembers,
				rules: repRules,
			},
			now: Date.now,
			clockUncertaintyMs: () => 10,
			authorize: async () => {},
			assertActive: async () => {},
		});
		const rep2 = new EntryReplicationController({
			host: memberHosts["member-2"],
			ctx,
			config: {
				spaceId: "presence-global",
				authorityId,
				replicaId: "rep-2",
				incarnation: "rep-inc-1",
				members: repMembers,
				rules: repRules,
			},
			now: Date.now,
			clockUncertaintyMs: () => 10,
			authorize: async () => {},
			assertActive: async () => {},
		});

		await rep1.mutate("put-alice-online", {
			kind: "put",
			type: "Presence",
			fields: { participantId: "alice", username: "Alice", status: "online", activeThreadId: "thread-alpha" },
			owner: principal,
			expiresAt: Date.now() + 60_000,
		});
		const changesFrom1 = await rep1.changes(0, 65_536);
		await rep2.importChanges(changesFrom1.events);
		const replicatedPresenceOn2 = await rep2.read();

		const allThreadsAcrossCluster = await federated.readAll({ type: "Thread" }, principal);
		const threads = allThreadsAcrossCluster.entries
			.map((e) => e.fields as unknown as ThreadRecord)
			.sort((a, b) => a.createdAt - b.createdAt);
		const messages = allMessagesAcrossCluster.entries
			.map((e) => e.fields as unknown as MsgRecord)
			.sort((a, b) => a.threadId.localeCompare(b.threadId) || a.seq - b.seq);
		const presence: PresenceRecord[] = replicatedPresenceOn2.map((e) => ({
			participantId: String(e.fields.participantId),
			username: String(e.fields.username),
			activeThreadId: String(e.fields.activeThreadId),
			status: (e.fields.status as PresenceRecord["status"]) ?? "online",
			updatedAt: Date.now(),
			leaseId: `lww:${e.fields.participantId}`,
			expires: Date.now() + 60_000,
		}));
		const snapshot: SpaceChatSnapshot = {
			rev: threads.length + messages.length + presence.length,
			streamId: "federated-v5",
			threads,
			messages,
			pendingTasks: [],
			presence,
			scheduledJobs: [],
			subagentRuns: [],
			rawEntryCount: threads.length + messages.length + presence.length,
		};

		return {
			stage: "v5-federated-cluster" as const,
			memberDistribution,
			totalClusterMessages: allMessagesAcrossCluster.entries.length,
			completeClusterRead: allMessagesAcrossCluster.complete,
			replicatedPresenceCount: replicatedPresenceOn2.length,
			replicatedPresence: replicatedPresenceOn2.map((e) => e.fields),
			snapshot,
		};
	} finally {
		for (const stop of stops) await stop();
		await coordinatorHost.close(ctx);
		for (const id of memberIds) await memberHosts[id].close(ctx);
	}
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await runStageV5();
	console.log("=== Stage v5 (Federated Cluster + HRW Sharding + Phase 3 LWW Presence) Completed ===");
	console.log("HRW Thread distribution across members:", result.memberDistribution);
	console.log(`Federated readAll messages: ${result.totalClusterMessages} (complete=${result.completeClusterRead})`);
	console.log(`Phase 3 LWW Replicated Presence on rep-2:`, result.replicatedPresence);
}
