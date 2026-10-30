---
standard: help_workflow
id: help.workflow.overview_v1_to_v6
title: "Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)"
short: "How a multiplayer chat is built with phi-spaces: six runnable stages, from a program in memory to operation by phone and web."
tags: [multiplayer, chat, tutorial, step-by-step, v1, v2, v3, v4, v5, v6, earendil]
owner: core
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v2_local_durable, help.workflow.stage_v3_remote_socket, help.workflow.stage_v4_gated_auth, help.workflow.stage_v5_federated_cluster, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)

## Overview {#overview}

This guide builds a multiplayer chat with phi-spaces in six stages. Each stage is a small program of its own that you can run directly. The first runs in memory without any setup, the last shows control by phone and web.

Further examples outside these six stages are under [Examples](help.topic.examples#overview).

## Concept And System Model {#concept-model}

The project implements the capabilities of the [Pi Durable on Cloudflare Multiplayer Chat](help.topic.overview#overview) **purely with `phi-spaces` primitives**: no Cloudflare-specific APIs and no ad-hoc tables outside the space. The stages use phi-spaces' own store (a SQLite file or memory); none of the six programs needs pi-durable. The shared chat logic lives in `help-site/examples/shared/chat-core.ts` (`SpaceChatEngine`), each program in `help-site/examples/v*/run.ts`.

### How phi-spaces Solves The 6 Core Requirements {#mapping-table}

| Multiplayer Chat Capability | Pure `phi-spaces` Solution |
|---|---|
| **1. Shareable Session Rooms** | Each chat session is an isolated **named space (`NamedSpace`)** with its own `spaceId` and revision counter `rev`. |
| **2. Multiple Threads & Forking Without Duplicates** | Threads are `Thread` entries (`{ threadId, parentThreadId, forkUpToSeq }`). The chat engine handles repeats itself: `Thread` through `write` with `unique: ["threadId"]`, `msgId` and `taskId` derived from the `requestId`. From stage 3 on, `RemoteSpace` also gives every mutation a request identity of its own for transport retries. |
| **3. Multiplayer Inbox & Ordered Replies** | Submitting a message atomically writes `Msg` + `ChatTask`. The worker reserves `ChatTask` under `txn` and must commit a matching reply `Msg` enforced by **`CompletionProfile`**. |
| **4. Live Streaming & Participant Presence** | Snapshot via `readPage()` (`inspectSnapshot()` reads every page), live deltas are available via `changes(afterRev)`; presence via `Presence` entries with a **30 s lease** and `renew()`. |
| **5. Scheduled Tasks (`schedule` / Alarms)** | `ScheduledJob` entry (`FOREVER`) + `TimerLock` entry with `leaseMs = delayMs`. When the lease expires, the reaper of `startService` removes the lock; `tickAlarms()` then idempotently creates the wakeup `ChatTask`. |
| **6. Cross-Thread Search Subagent (`search_history`)** | A subagent worker takes `SearchTask` under `txn`, scans top-level threads via `readAll({ type: "Msg" })`, records `SubagentStep` trace entries, and commits `SearchResult` under a second `CompletionProfile`. |

### The 6 Stages At A Glance {#six-stages}

1. **[Stage 1 (`v1-local-memory`)](help.workflow.stage_v1_local_memory#overview)**: Zero-setup in memory (`openOwnMemoryHost()` + `PhiSpaces`). Runs immediately without files or network ports.
2. **[Stage 2 (`v2-local-durable`)](help.workflow.stage_v2_local_durable#overview)**: Own SQLite store (`openSqliteHost`), restart on the same file, `TimerLock` alarms, and `search_history` subagent.
3. **[Stage 3 (`v3-remote-socket`)](help.workflow.stage_v3_remote_socket#overview)**: Process decoupling via `SpaceService`, `RemoteSpace` (Unix socket/TCP), and consumer mailboxes (`events` + `ack`).
4. **[Stage 4 (`v4-gated-auth`)](help.workflow.stage_v4_gated_auth#overview)**: Two-layer security (`startGate`, Ed25519 challenge, token enrollment, 60s grants, key rotation, and boot guard).
5. **[Stage 5 (`v5-federated-cluster`)](help.workflow.stage_v5_federated_cluster#overview)**: Federation across 3 member spaces (`RouterController` + `FederatedSpace`) with HRW routing by `threadId` and cluster-wide `readAll`; simulated as 4 hosts in one process in the demo.
6. **[Stage 6 (`v6-mobile-control`)](help.workflow.stage_v6_mobile_control#overview)**: Operations control via the mobile app (`pi-termux-mobile`) and the login-protected **`AdminSpaces`** web portal on `https://spaces.eibrain.org`.

Each stage description includes a **Topology: Space Distribution** section showing how many hosts/spaces are involved and how entries are distributed.

## See Also {#see-also}

- [Stage 1 (v1-local-memory): Zero-Setup Local Quickstart](help.workflow.stage_v1_local_memory#overview)
