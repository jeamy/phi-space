---
standard: help_topic
id: help.topic.comparison_earendil_vs_phi_spaces
title: "Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)"
short: "Comparison of the Cloudflare Durable Object approach and pi-durable 1.4.0 with the phi-spaces tuple-space model, including pros and cons from In-Memory (v1) to Federated Space (v5/v6)."
tags: [comparison, earendil, cloudflare, durable-objects, pi-durable, pros-cons, v1, v2, v3, v4, v5, v6, federated]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6, help.topic.federation_router_and_membership]
since: 0.0.1
---

# Concept Comparison: Earendil Multiplayer Chat vs. phi-spaces (v1 to v6)

## Overview {#overview}

Earendil builds pi-durable, a runtime for AI agents, and uses it to show a multi-user chat on Cloudflare. This article puts that design next to phi-spaces. In short: pi-durable runs an agent, and phi-spaces coordinates the work of several participants. Neither replaces the other, and together they fit well.

### Technical Details {#technical-details}

Two things have to be kept apart: the [Pi Durable on Cloudflare](https://earendil.com/posts/pi-durable-on-cloudflare/) reference as an architecture, and pi-durable as a package. `phi-spaces` does not build on pi-durable: the space has a store of its own and needs neither pi-durable nor Chord nor pi-ai. Only the optional `agent/` package connects the two (see [two separate stores](help.topic.agent_tools_and_replay#two-stores)). The architectures differ like this:

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
| **6. Subagent Search (`search_history`)** | Child conversation inside the same local DO SQLite database. | Decoupled subagent worker via `SearchTask` / `SubagentStep` / `SearchResult`, searching **cluster-wide across hosts** in `v5`. |

### phi-spaces And pi-durable 1.4.0 {#pi-durable-today}

As of 2026-10-30, compared with the published release 1.4.0 (`docs/vergleich-pi-durable.md`):

| Area | `phi-spaces` | pi-durable 1.4.0 |
|---|---|---|
| **Main purpose** | Coordinate shared data and work between participants | Run persistent agents and their execution |
| **Central abstraction** | Space with entries found by template | Conversation with transcript, submissions and tasks |
| **Work distribution** | Competing consumers take work with `take` | A scheduler runs owner-bound tasks; no equivalent `take` |
| **Model integration** | Not in the space core; applications or `agent/` | Built in through pi-ai |
| **Commit handling** | A writer thread bundles commits; the next commit may build on the prepared state; replies wait for the durable write | One mutation line stays occupied during the storage call |
| **Default sync** | WAL with `synchronous=FULL` | Node SQLite: WAL with `synchronous=NORMAL` |
| **Storage platforms** | Own memory and Node SQLite store | Memory, SQLite, JSONL, IndexedDB and Cloudflare Durable Object SQLite |
| **Network service** | In-process, Unix socket, TCP, adapter for pi-server | Harness/storage library; network hosting is an additional integration |

The table compares defaults, not performance: there is no controlled benchmark against 1.4.0. The store files are not interchangeable. Since 1.4.0, "pi-durable always writes the whole document" is false too: each document definition sets through `checkpointWhen` when a full base is written.

### Newer Earendil Code {#earendil-main}

The unreleased Earendil `main` (checked: commit `50af8c1` of 2026-10-30) is newer than the release and must not be equated with 1.4.0. It brings group commit, a `StoreStorage` on Chord v2, and "deferred commits": progress becomes visible before it is stored, by default up to 1 s earlier. "Only phi-spaces has group commit" is therefore not true in general. phi-spaces still acknowledges its commits only after the write. This code was read, but neither installed nor run.

## Rules, Guarantees And Boundaries {#rules-and-boundaries}

### Pros And Cons Across Stages v1 (In-Memory) To v5/v6 (Federated Space) {#stages-pros-cons}

| Stage | Key Advantages | Trade-Offs / Boundaries |
|---|---|---|
| **`v1` In-Memory Space** (`openOwnMemoryHost()` + `PhiSpaces`) | **0 ms setup**, full space inspection, `SpaceLifecycle`, `WorkerSupervisor`, and `DeploymentController` directly in RAM; ideal for tests & prototyping. | Volatile state (lost when process exits); limited to a single Node.js process; no `RunGate` active in chat. |
| **`v2` Local Durable Space** (`openSqliteHost()` + `PhiSpaces`) | **ACID commits** in one SQLite file (default `synchronous=FULL`); thread forks through a reference to the parent thread; inspectable and controllable via `AdminSpaces`, live Dashboard (`npm run dashboard`), TUI (`npm run tui`), and `npm run bootstrap`. | One owner (only 1 host process on the file, `.owner` lock); no serverless scale-to-zero. |
| **`v3` Remote Socket Space** (`SpaceService` + `RemoteSpace`) | **Process decoupling**: web gateway, chat workers, subagents, and inspectors connect via Unix socket/TCP; event-driven mailboxes (`events` + `ack`). | Additional serialization and socket I/O hop; callers must handle `OutcomeUnknown` via `pollOperation` on transport drop. |
| **`v4` Gated Auth Space** (`startGate` Layer A/B + 60s Grants) | **External control with key proof**: smartphone (`pi-termux-mobile`), CLI, and web admin pair via QR/token (`enrollQr`) and inspect/control spaces with 60s grants. | Higher setup complexity (key provisioning, enrollment, boot register); issuing new remote grants requires a reachable control host. |
| **`v5`/`v6` Federated Space & Cluster Admin** (`FederatedSpace` + HRW + `RunGate` in v6 + AP3 replication building blocks) | **Spread across several hosts**: orchestrates multiple member hosts; `RunGate` in v6 for confirmed barriers; primary/sync replication and promotion are implemented. | Phase 3 is not fully accepted, so no high-availability promise follows. No cross-member transactions (`RoutingConflict`); HRW member set fixed by federation plan v3 (`MigrationRequired` on removal); Stage v5 test runs in-process with in-memory hosts. |

### When To Choose Which Model {#decision-guide}

- **Choose the Cloudflare DO model** when you want to host thousands of small, completely isolated chat sessions on serverless edge infrastructure with *scale-to-zero* and no external worker fleets.
- **Choose pi-durable** when an agent should continue model and tool work after restarts, or when you need conversation forks, prompt building and model context. For a little state stored atomically with it, pi-durable documents are enough.
- **Choose `phi-spaces` (`v1`–`v6`)** when you need **infrastructure independence** (Docker, Linux VPS, on-premise, mobile), **server-enforced result contracts (`CompletionProfiles`)**, **decoupled heterogeneous worker/subagent fleets**, **HRW sharding across hosts**, **self-hosted Primary/Sync replication with fencing (AP3, not fully accepted)**, or **integrated operational control (`RunGate` from v6, `WorkerSupervisor`, Mobile/Web Admin)**. A service with no agents at all fits here too.
- **Use both** when several persistent agents should work together: pi-durable inside each agent, phi-spaces between them.

## See Also {#see-also}

- [Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)](help.workflow.overview_v1_to_v6#overview)
- [Federation, Router, HRW Sharding, and Membership](help.topic.federation_router_and_membership#overview)
