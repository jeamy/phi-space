---
standard: help_topic
id: help.topic.architecture_layers
title: "Architecture Layers and Module Map"
short: "Mapping of the main source modules in src/ across the 6 architecture layers, from the pure state machine and the own store to federation, RunGate, and replication."
tags: [architecture, layers, modules, core, service, gate, router, replication]
owner: core
related: [help.topic.overview, help.topic.guarantees_and_boundaries, help.topic.space_service_and_remote_space]
since: 0.0.1
---

# Architecture Layers and Module Map

## Overview {#overview}

phi-spaces is built in layers, like a house with several floors. At the bottom sit the rules of the space, which know nothing about networks or disks. Storage, networking, security and operations are added on top. If you only need a space inside one program, you use the lower layers and ignore the rest.

### Technical Details {#technical-details}

The core (`src/core.ts`) is a pure, deterministic state machine with no network, cryptography, or filesystem dependencies. All higher layers (storage, RPC, cryptography, overlay gate, router federation, and operations control) build on top of it without bypassing core invariants. The agent tools are not in `src/` but in the separate `agent/` package.

## Concept And System Model {#concept-model}

### The 6 Layers At A Glance {#six-layers}

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ Layer 6: Operations, Mobile/Web Admin & Phase 3 Replication                │
│  run-controller.ts · workers.ts · space-lifecycle.ts · deployment.ts       │
│  alerts.ts · dashboard.ts · entry-replication.ts · primary-sync.ts         │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 5: Federation, Router & Membership (Phase 2)                         │
│  router.ts · delegation.ts · federation-policy.ts · federated-space.ts     │
│  membership.ts · capability-directory.ts · data-admin.ts · root-erasure.ts │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 4: Overlay Gate, Layer A/B Auth, Grants & Recovery (Phase 1b)        │
│  gate.ts · auth.ts · enroll.ts · grants.ts · rotation.ts · supervisor.ts   │
│  runtime.ts · boot.ts · restore.ts · recovery-register.ts                  │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 3: Local Client & Network Service                                    │
│  client.ts (PhiSpaces) · index.ts (delivery, reaper) · service.ts          │
│  remote.ts (RemoteSpace) · socket.ts · space-client.ts · ws.ts             │
│  standalone.ts · pi-server.ts · meter.ts                                   │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Own Store, Claims, Streams, Snapshots & Mailboxes                 │
│  store/ (host · sqlite · sqlite-writer · disk-map · sync-sqlite)           │
│  claims.ts · stream.ts · snapshot.ts · paging.ts · mailbox.ts              │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 1: Pure Core & Document Model v5                                     │
│  core.ts · doc.ts · spaces.ts · canonical.ts (RFC 8785)                    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Dependency Direction {#dependency-direction}

- `src/core.ts` accepts the mutable document draft `SpaceState` and an explicit timestamp `now: number`. Lease expiration, transaction rollbacks, and clock jumps can therefore be tested deterministically without real wall-clock waits.
- `src/client.ts` and `src/service.ts` invoke pure functions from `core.ts`, `claims.ts`, `stream.ts`, and `mailbox.ts` inside a single `host.commit(tx => ...)`.
- `src/gate.ts`, `src/auth.ts`, and `src/grants.ts` sit in front of `SpaceService` and supply the verified `Connection` context.

### The Own Store {#own-store}

- **One owner**: `openSqliteHost(path)` takes a lock in `path.owner`. A second process gets `StoreUnavailable`, and so does any file that is not a phi-spaces store.
- **One writer thread**: Commits run in order and are bundled into SQLite transactions. Replies wait for the durable write (WAL, default `synchronous=FULL`, `NORMAL` can be chosen). If a write fails, the host locks itself.
- **Large collections kept apart**: Entries and other large parts live in rows of their own. Request claims stay on disk and are read by key (`disk-map.ts`).
- **Memory budget**: With `memoryBudget` (default 40 000 records) the host drops the documents untouched for longest and reads them back when needed. Documents used within `hotMs` (default 250 ms) stay.
- **Compacting the file**: `OwnStoreHost.compact()` gives free pages of the file back. The first call rewrites it once with `VACUUM`; later calls cut off only the free pages. A store in memory answers `null`.
- **Options for sustained load**: `OwnStoreHost.skipUnchangedRecords` skips unchanged records of large collections. It is off by default.
- **Memory only**: `openOwnMemoryHost()` for tests and throwaway spaces.

JSONL is no longer a store of the space. pi-durable stores are not imported (decision D6). Only the agent package uses pi-durable and its own stores; see [agent tools](help.topic.agent_tools_and_replay#two-stores).

### Rust Port {#rust-port}

The running system is TypeScript. The `rust/` folder is growing `phi-json`, `phi-core` and `phi-store` (`docs/rust-portierung.en.md`). R0 (fixing the contracts) is done, and the slices of R1 (core) and slices 0–4 of R2 (store) are finished. The memory budget and several spaces are deferred to R3. There is no Rust server yet: that is R3.

## Technical Reference {#technical-reference}

| Layer | Key Files | Public Types & Exports |
|---|---|---|
| **1. Core & Docs** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts` | `core`, `Space`, `NamedSpace`, `Registry`, `createSpace`, `listSpaces`, `DEFAULT_LIMITS` |
| **2. Store, Claims & Streams** | `src/store/`, `src/claims.ts`, `src/stream.ts`, `src/mailbox.ts` | `openSqliteHost`, `openOwnMemoryHost`, `OwnStoreHost`, `RequestRef`, `ClaimView`, `argHash`, `MailboxPage`, `principalId` |
| **3. Client & RPC** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts`, `src/space-client.ts`, `src/ws.ts` | `PhiSpaces`, `startService`, `SpaceService`, `RemoteSpace`, `serveSpace`, `socketTransport`, `connectSpace`, `upgradeWebSocket` (`phi-spaces/ws`) |
| **4. Gate & Recovery** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts` | `startGate`, `ProvingService`, `EnrollmentService`, `GrantAuthority`, `GrantVerifier`, `startFederationHost`, `installBootGuard`, `RecoveryController` |
| **5. Federation** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts` | `RouterController`, `createFederationController`, `FederatedSpace`, `MembershipController`, `DistributedPrincipalErasure` |
| **6. Operations & Sync** | `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/alerts.ts`, `src/entry-replication.ts` | `RunController`, `WorkerSupervisor`, `SpaceLifecycle`, `DeploymentController`, `collectAlerts`, `EntryReplicationController` |

## See Also {#see-also}

- [phi-spaces System Overview](help.topic.overview#overview)
- [Binding Guarantees and System Boundaries](help.topic.guarantees_and_boundaries#overview)
