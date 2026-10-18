---
standard: help_topic
id: help.topic.architecture_layers
title: "Architecture Layers and Module Map"
short: "Complete mapping of all source modules in src/ across the 6 architecture layers, from the pure state machine to federation, RunGate, and replication."
tags: [architecture, layers, modules, core, service, gate, router, replication]
owner: core
related: [help.topic.overview, help.topic.guarantees_and_boundaries, help.topic.space_service_and_remote_space]
since: 0.0.1
---

# Architecture Layers and Module Map

## Overview {#overview}

The `pi-spaces` codebase is strictly layered. Its core (`src/core.ts`) is a pure, deterministic state machine with no network, cryptography, or filesystem dependencies. All higher layers (persistence, RPC, cryptography, overlay gate, router federation, and operations control) build on top of it without bypassing core invariants.

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
│ Layer 3: Local Client, LLM Agent Tools & Network Service                   │
│  client.ts (PiSpaces) · index.ts (Tools & Reaper) · service.ts             │
│  remote.ts (RemoteSpace) · socket.ts · pi-server.ts · meter.ts             │
├────────────────────────────────────────────────────────────────────────────┤
│ Layer 2: Durable Claims, Streams, Snapshots & Mailboxes (Phase 1)          │
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

## Technical Reference {#technical-reference}

| Layer | Key Files | Public Types & Exports |
|---|---|---|
| **1. Core & Docs** | `src/core.ts`, `src/doc.ts`, `src/spaces.ts` | `core`, `Space`, `NamedSpace`, `Registry`, `createSpace`, `listSpaces`, `DEFAULT_LIMITS` |
| **2. Claims & Streams** | `src/claims.ts`, `src/stream.ts`, `src/mailbox.ts` | `RequestRef`, `ClaimView`, `argHash`, `MailboxPage`, `principalId` |
| **3. Client & RPC** | `src/client.ts`, `src/index.ts`, `src/service.ts`, `src/remote.ts`, `src/socket.ts` | `PiSpaces`, `spaces`, `startService`, `SpaceService`, `RemoteSpace`, `serveSpace`, `socketTransport` |
| **4. Gate & Recovery** | `src/gate.ts`, `src/auth.ts`, `src/enroll.ts`, `src/grants.ts`, `src/runtime.ts`, `src/boot.ts`, `src/restore.ts` | `startGate`, `ProvingService`, `EnrollmentService`, `GrantAuthority`, `GrantVerifier`, `startFederationHost`, `installBootGuard`, `RecoveryController` |
| **5. Federation** | `src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts` | `RouterController`, `createFederationController`, `FederatedSpace`, `MembershipController`, `DistributedPrincipalErasure` |
| **6. Operations & Sync** | `src/run-controller.ts`, `src/workers.ts`, `src/space-lifecycle.ts`, `src/deployment.ts`, `src/alerts.ts`, `src/entry-replication.ts` | `RunController`, `WorkerSupervisor`, `SpaceLifecycle`, `DeploymentController`, `collectAlerts`, `EntryReplicationController` |

## See Also {#see-also}

- [pi-spaces System Overview](help.topic.overview#overview)
- [Binding Guarantees and System Boundaries](help.topic.guarantees_and_boundaries#overview)
