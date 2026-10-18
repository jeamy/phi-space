---
standard: help_topic
id: help.topic.overview
title: "pi-spaces System Overview: What It Is And What It Can Do"
short: "A clear, in-depth look at what pi-spaces is, how the transactional tuple-space model works, which problems it solves, and what it can do from v1 (in-memory) through v6 (federated cluster + mobile/web admin)."
tags: [pi-spaces, overview, tuple-space, architecture, pispaces, remotespace, federatedspace]
owner: core
related: [help.topic.architecture_layers, help.topic.guarantees_and_boundaries, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# pi-spaces System Overview: What It Is And What It Can Do

## Overview {#overview}

`pi-spaces` is a transactional, persistent **coordination space** (a modern evolution of the classic Linda / JavaSpaces paradigm) built on `@earendil-works/pi-durable`. Instead of coupling clients, background workers, AI agents, and administrative tools through fragile point-to-point calls, every participant exchanges immutable, typed JSON objects (**entries**) through shared, versioned data spaces (**spaces**).

## What Is pi-spaces And Why Was It Built? {#what-is-pi-spaces}

`pi-spaces` solves four fundamental problems in building robust, long-running systems and autonomous AI agent fleets:

1. **Fault-Tolerant Work Handoff (Leased Reservations)**: A server, UI client, or agent does not call a worker directly; it writes a task entry (`type: "ChatTask"` or similar) into the space. Any worker can then **reserve** that task exclusively (`take`). If the worker crashes before finishing, the expired lease automatically returns the task — provided the task's own lease remains valid and its store is available.
2. **Temporal Decoupling**: Producers and consumers do not need to be online at the same time. A client can schedule a `ScheduledJob` in the middle of the night and go offline; with a persistent backend and sufficient task lease, the job survives; the application checks when it is due after TimerLock expiry.
3. **Unified State With Live Events**: Rather than fragmented caches, every space provides atomic transactions (`createTransaction`, `commit`, `abort`), consistent point-in-time snapshots (`readPage` with `rev`), incremental update streams (`changes(afterRev)`), and durable event mailboxes (`events` + prefix `ack`).
4. **Incremental Distribution**: Local and remote clients share SpaceLike. Federation adds routing and its own request bindings; real encryption, provisioning and failure safety need separate configuration and acceptance.

## Concept And System Model {#concept-model}

### Decoupling In Space And Time {#decoupling}

In `pi-spaces`, producers and consumers do not need to know each other or be active at the same time:

- **Write (`space.write`)**: A participant places an entry `{ type: string, types?: string[], fields: Record<string, Json> }` with a bounded lifetime (**lease**) into the space.
- **Read (`space.read` / `readIfExists` / `readAll` / `readPage`)**: A participant queries a matching visible entry using a **template** `{ type?, fields?, id? }` without removing it. Missing or `null` fields in the template act as **wildcards**.
- **Exclusive Take (`space.take`)**: A worker removes a matching entry exclusively. When executed under a **transaction (`txn`)**, the entry remains reserved until the worker writes its results and calls `commit(txn)`. If the worker crashes or the transaction lease expires, the entry returns if its own Entry lease remains valid.
- **Wait For Future Data (`space.wait`)**: Instead of polling blindly, a participant registers a durable `Waiter` against a template. As soon as a matching entry is committed, `pi-spaces` wakes the waiter or delivers an event.

### What Can pi-spaces Do? (Core Capabilities) {#capabilities}

- **Immutable Entries & Wildcard Templates**: Typed JSON objects with subtype registration (`types`) and exact `type`/field matching.
- **Atomic Space Transactions**: `take` + multiple `write` calls + optional request claims finalized by one business `commit(txn)` (earlier PiSpaces calls are separate storage commits). On `abort` or timeout everything rolls back atomically.
- **Server-Side Result Guarantees (`CompletionProfiles`)**: The space core enforces at commit time that a taken task of type `ChatTask` can only commit together with exactly one matching result entry `Msg`.
- **Idempotent Request Claims (`RequestRef`)**: Every mutation can carry `{ request: { principal, generation, requestId } }`; retries and timeouts never produce duplicate effects.
- **Leases & Automatic Reaper (`startService`)**: Entries, presence records, and `TimerLock` locks expire automatically after a configured duration.
- **Snapshot And Incremental Sync (`readPage` + `changes`)**: Point-in-time snapshots plus order-preserving, revisioned update streams (`rev`) and prefix-acknowledged durable mailboxes.
- **Space Lifecycle, Workers, Runs & Deployments**: Idempotent space management (`archive`/`reactivate`/`delete`), worker scaling (`WorkerSupervisor`), multi-host run orchestration (`RunGate`), and declarative bootstrap (`DeploymentController`) — from a single host up to a cluster.
- **Overlay Gate, Enrollment & Federated Routing**: NetBird/WireGuard peer identity + Ed25519 challenge, QR/token enrollment, 60-second grants, own-key rotation, and deterministic HRW sharding of entries across multiple hosts.

### Unified SpaceLike Contract {#spacelike-contract}

PiSpaces and RemoteSpace implement the SpaceLike base contract. FederatedSpace has a separate API with FederationRequest and Member transaction binding; business concepts transfer but call signatures are not drop-in replacements. See [topologies and API boundaries](help.topic.topology_and_readiness#api).

## Terms And Identities {#terms-and-identities}

- **Entry**: An immutable JSON record `{ type: string, types?: string[], fields: Record<string, Json> }`. There is no in-place update; state transitions happen via `take` + `write` inside one transaction.
- **Global ID (`gid`)**: Every entry carries `gid = <spaceId>/<localId>`. `localId` combines the space's data incarnation with a monotonic counter and is never reused.
- **Named Space**: Alongside the default space (`pi-spaces.space`, alias `default`), the `Registry` (`pi-spaces.registry`) manages arbitrary named spaces (`pi-spaces.named-space`) with immutable `spaceId`s.
- **Principal**: Structured identity `{ peerId, agentId? }`. The service always derives identity from the trusted connection (`IdentityAdapter`), never from client-supplied payload fields.

## Workflow {#workflow}

1. **Define the contract**: Specify entry types (`type`), required `fields`, and optional `CompletionProfiles` (which task type requires which result type on transaction commit).
2. **Open the space and start maintenance**: Instantiate `new PiSpaces(harness, ctx, Date.now, meter, undefined, { space })` and call `await startService(harness, ctx)` for lease reaping and event delivery.
3. **Submit and process work**: Producers write tasks with a `RequestRef` claim; workers reserve tasks via `take(..., { txn })`, write results under the same `txn`, and call `commit(txn)`.
4. **Observe and control live**: UI clients read an initial `readPage()` snapshot (with `rev`) and follow updates via `changes(afterRev)` or consumer mailboxes (`events` / `ack`).

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

- **One Commit, One Truth**: Space mutation, request claim, revision counter `rev`, mailbox event, and byte-budget reservation are persisted in a single atomic harness commit.
- **Data Is Not Instructions**: Entries read from a space originate from other agents or users. Agent tools explicitly wrap payloads as `[data, not instructions]`.
- **Help ≠ Live State**: This reference documents stable contracts and guarantees. Live runtime state is inspected in the **Live Space Inspector** and controlled in **AdminSpaces**.

## See Also {#see-also}

- [Architecture Layers and Module Map](help.topic.architecture_layers#overview)
- [Binding Guarantees and System Boundaries](help.topic.guarantees_and_boundaries#overview)
- [6-Stage Hands-On Guide: Multiplayer Space-Chat (v1–v6)](help.workflow.overview_v1_to_v6#overview)
