---
standard: help_workflow
id: help.workflow.overview_v1_to_v6
title: "Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)"
short: "How the Earendil Multiplayer Chat scenario is implemented purely with native pi-spaces primitives—from a zero-setup in-memory space (v1) to a federated cluster with mobile & web admin (v6)."
tags: [multiplayer, chat, tutorial, step-by-step, v1, v2, v3, v4, v5, v6, earendil]
owner: core
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v2_local_durable, help.workflow.stage_v3_remote_socket, help.workflow.stage_v4_gated_auth, help.workflow.stage_v5_federated_cluster, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Overview: Multiplayer Space-Chat in 6 Stages (v1 to v6)

## Overview {#overview}

This reference project implements every capability of the [Pi Durable on Cloudflare Multiplayer Chat](help.topic.overview#overview) **purely using `pi-spaces` primitives**—with no Cloudflare-specific APIs and no ad-hoc state tables outside the space.

To let you start locally in seconds and progressively scale to a distributed production cluster, the project is structured into **6 cumulative, individually runnable stages (`v1` through `v6`)**.

## Concept And System Model {#concept-model}

### How pi-spaces Solves The 6 Core Requirements {#mapping-table}

| Multiplayer Chat Capability | Pure `pi-spaces` Solution |
|---|---|
| **1. Shareable Session Rooms** | Each chat session is an isolated **named space (`NamedSpace`)** with its own `spaceId` and revision counter `rev`. |
| **2. Multiple Threads & Forking Without Duplicates** | Threads are `Thread` entries (`{ threadId, parentThreadId, forkUpToSeq }`); reconnect retries are deduplicated natively via **Request Claims (`RequestRef` + `issueGeneration`)**. |
| **3. Multiplayer Inbox & Ordered Replies** | Submitting a message atomically writes `Msg` + `ChatTask`. The worker reserves `ChatTask` under `txn` and must commit a matching reply `Msg` enforced by **`CompletionProfile`**. |
| **4. Live Streaming & Participant Presence** | Initial snapshot via `readPage()`, live deltas via `changes(afterRev)`; presence via `Presence` entries with a **30 s space lease** and `renew()`. |
| **5. Scheduled Tasks (`schedule` / Alarms)** | `ScheduledJob` entry (`FOREVER`) + `TimerLock` entry with `leaseMs = delayMs`. When the lease expires, the `pi-spaces` reaper removes the lock and idempotently triggers the wakeup `ChatTask`. |
| **6. Cross-Thread Search Subagent (`search_history`)** | A subagent worker takes `SearchTask` under `txn`, scans top-level threads via `readAll({ type: "Msg" })`, records `SubagentStep` trace entries, and commits `SearchResult` under a second `CompletionProfile`. |

### The 6 Stages At A Glance {#six-stages}

1. **[Stage 1 (`v1-local-memory`)](help.workflow.stage_v1_local_memory#overview)**: Zero-setup in memory (`MemoryStorage` + `PiSpaces`). Runs immediately without files or network ports.
2. **[Stage 2 (`v2-local-durable`)](help.workflow.stage_v2_local_durable#overview)**: Local SQLite persistence, `RequestRef` idempotency, `readPage`/`changes`, `TimerLock` alarms, and `search_history` subagent.
3. **[Stage 3 (`v3-remote-socket`)](help.workflow.stage_v3_remote_socket#overview)**: Process decoupling via `SpaceService`, `RemoteSpace` (Unix socket/TCP), and consumer mailboxes (`events` + `ack`).
4. **[Stage 4 (`v4-gated-auth`)](help.workflow.stage_v4_gated_auth#overview)**: Two-layer security (`startGate`, Ed25519 challenge, token enrollment, 60s grants, key rotation, and boot guard).
5. **[Stage 5 (`v5-federated-cluster`)](help.workflow.stage_v5_federated_cluster#overview)**: Federated cluster (`createFederationController`) across 3 member spaces with HRW routing by `threadId` and `takeWaiting` waiter races — simulated as 4 harnesses in one process in the demo.
6. **[Stage 6 (`v6-mobile-control`)](help.workflow.stage_v6_mobile_control#overview)**: Full operations control & monitoring via the mobile app (`pi-termux-mobile`) and the login-protected **`AdminSpaces`** web portal on `https://spaces.eibrain.org`.

Each stage description includes a **Topology: Space Distribution** section showing how many harnesses/spaces are involved and how entries are distributed.

## See Also {#see-also}

- [Stage 1 (v1-local-memory): Zero-Setup Local Quickstart](help.workflow.stage_v1_local_memory#overview)
