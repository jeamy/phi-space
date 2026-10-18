---
standard: help_topic
id: help.topic.comparison_earendil_vs_phi_spaces
title: "Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)"
short: "Systematic comparison of the Cloudflare Durable Object approach with the phi-spaces tuple-space model, including pros and cons from In-Memory (v1) to Federated Space (v5/v6)."
tags: [comparison, earendil, cloudflare, durable-objects, pros-cons, v1, v2, v3, v4, v5, v6, federated]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6, help.topic.federation_router_and_membership]
since: 0.0.1
---

# Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)

## Overview {#overview}

Both the [Pi Durable on Cloudflare](help.workflow.overview_v1_to_v6#overview) reference and our `phi-spaces` implementation build on `@earendil-works/pi-durable` for transactional storage, yet they follow two fundamentally different architectural paradigms:

- **Earendil Reference (Stateful Actor / Session Wrapper)**: Each session is a single Cloudflare Durable Object encapsulating WebSockets, an embedded SQLite database, the single DO alarm, and the `pi-durable` harness inside one object instance.
- **`phi-spaces` (Decoupled Coordination Space / Tuple Space)**: All application and coordination state lives as typed JSON entries (`Thread`, `Msg`, `ChatTask`, `Presence`, `ScheduledJob`, `SearchTask`) inside a space. Web gateways, AI workers, subagents, and administrators interact as loosely coupled participants through the unified `SpaceLike` contract.

## Concept And System Model {#concept-model}

### Side-By-Side Comparison Of The 6 Core Mechanisms {#mechanism-comparison}

| Mechanism | Earendil Cloudflare DO | `phi-spaces` (`v1` to `v6`) |
|---|---|---|
| **1. Session Isolation** | 1 Durable Object instance per `sessionId` (strict silo boundary). | 1 named space (`NamedSpace`) or, in `v5`, HRW sharding by `threadId` across multiple member spaces. |
| **2. Reconnect Idempotency** | Custom per-command `ConversationCommandReceipts` document written by hand. | **Built-in `RequestRef` claims (`src/claims.ts`)** with canonical RFC-8785 argument hashing across all space mutations. |
| **3. Ordered Processing & Correctness** | `conversation.submit({ whenBusy: "followUp" })` without formal result verification. | Exclusive `take` under a space transaction (`txn`) + server-enforced **`CompletionProfile`** (`ChatTask → Msg`). |
| **4. Live Stream & Presence** | `watchEvents` + Cloudflare WebSocket attachments (not queryable outside the socket). | `readPage` snapshot + `changes(afterRev)` + consumer mailboxes (`events`/`ack`) + **`Presence` entries with 30s space leases**. |
| **5. Scheduled Tasks (Alarms)** | Only 1 hardware alarm per DO; requires manual `#refreshAlarm()` projection across all tasks. | Arbitrary concurrent `ScheduledJob` + `TimerLock` leases; expired locks are automatically reaped by `phi-spaces`. |
| **6. Subagent Search (`search_history`)** | Child conversation inside the same local DO SQLite database. | Decoupled subagent worker via `SearchTask` / `SubagentStep` / `SearchResult`—searching **cluster-wide across hosts** in `v5`! |

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Pros And Cons Across Stages v1 (In-Memory) To v5/v6 (Federated Space) {#stages-pros-cons}

| Stage | Key Advantages | Trade-Offs / Boundaries |
|---|---|---|
| **`v1` In-Memory Space** (`MemoryStorage` + `PhiSpaces`) | **0 ms setup**, full space inspection, `SpaceLifecycle`, `WorkerSupervisor`, and `DeploymentController` directly in RAM; ideal for tests & prototyping. | Volatile state (lost when process exits); limited to a single Node.js process; no `RunGate` active in chat. |
| **`v2` Local Durable Space** (`SQLite`/`JSONL` + `PhiSpaces`) | **Full ACID durability** in a single file; $O(1)$ pointer-based thread forking; inspectable and controllable via `AdminSpaces`, live Dashboard (`npm run dashboard`), TUI (`npm run tui`), and `npm run bootstrap`. | Single-owner file lock (only 1 writing host process on the SQLite store); no serverless scale-to-zero. |
| **`v3` Remote Socket Space** (`SpaceService` + `RemoteSpace`) | **Process decoupling**: web gateway, chat workers, subagents, and inspectors connect via Unix socket/TCP; event-driven mailboxes (`events` + `ack`). | Additional serialization and socket I/O hop; callers must handle `OutcomeUnknown` via `pollOperation` on transport drop. |
| **`v4` Gated Auth Space** (`startGate` Layer A/B + 60s Grants) | **External zero-trust control**: smartphone (`pi-termux-mobile`), CLI, and web admin pair via QR/token (`enrollQr`) and inspect/control spaces with 60s grants. | Higher setup complexity (key provisioning, enrollment, boot register); issuing new remote grants requires a reachable control host. |
| **`v5`/`v6` Federated Space & Cluster Admin** (`FederatedSpace` + HRW + `RunGate` in v6 + AP3 Replication in Core) | **Horizontal scale & High Availability**: orchestrates multiple member hosts; AP3 Primary/Sync replication in core; `RunGate` in v6 for confirmed barriers. | No cross-member transactions (`RoutingConflict`); fixed HRW member set in v3 (`MigrationRequired` on removal); Stage v5 test runs in-process with MemoryStorage. |

### When To Choose Which Model {#decision-guide}

- **Choose the Cloudflare DO model** when you want to host thousands of small, completely isolated chat sessions on serverless edge infrastructure with *scale-to-zero* and no external worker fleets.
- **Choose `phi-spaces` (`v1`–`v6`)** when you need **full infrastructure sovereignty** (Docker, Linux VPS, on-premise, mobile), **server-enforced result contracts (`CompletionProfiles`)**, **decoupled heterogeneous worker/subagent fleets**, **horizontal HRW sharding across hosts**, **self-hosted Primary/Sync replication with fencing (AP3)**, or **integrated operational control (`RunGate` from v6, `WorkerSupervisor`, Mobile/Web Admin)**.

## See Also {#see-also}

- [Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW Sharding, and Membership](help.topic.federation_router_and_membership#overview)
