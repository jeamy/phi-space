---
standard: help_workflow
id: help.workflow.stage_v5_federated_cluster
title: "Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router"
short: "Unites 3 member spaces under createFederationController: HRW placement per threadId, federated subagent search, waiter race (takeWaiting), and Phase 3 LWW presence."
tags: [v5, federation, cluster, router, hrw, federatedspace, takewaiting, lww]
owner: federation
related: [help.workflow.stage_v4_gated_auth, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router

## Overview {#overview}

Stage 5 (`help-site/examples/v5-federated-cluster/run.ts`) scales the Multiplayer Space-Chat horizontally across **three member spaces (`member-1`, `member-2`, `member-3`)** coordinated by `createFederationController` (`RouterController` + `FederatedSpace` + `FederationPolicy`).

## Topology: Space Distribution {#topology}

The cluster is **simulated inside a single process**: **4 harnesses** (all `MemoryStorage`) playing real member hosts with real federation components — no network, but the exact same routing and journal logic as a truly distributed deployment.

- **1 coordinator host**: `RouterController` (`router-root` + 2 partition routers for the routing journals) and `FederatedSpace` (id `fed-v5`). The coordinator owns no chat-data space itself — it only executes the policy.
- **3 member hosts** (`member-1`, `member-2`, `member-3`): each owns its own independent space with its own space doc.
- **HRW sharding**: the federation policy routes `Thread`, `Msg`, and `ChatTask` by rendezvous hashing over `fields.threadId` deterministically onto exactly one member. The runner report field `memberDistribution` shows the actual placement, e.g. `{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }`.
- **`FederationIO`** is an in-process adapter onto the local `PiSpaces` objects in this demo; in a real deployment these would be `RemoteSpace`/RPC calls to remote hosts — the semantics (`step`, `snapshot`, `events`, `ack`, `txnActive`) stay identical.
- **Replication**: 2 `EntryReplicationController` instances (`rep-1` on member-1, `rep-2` on member-2) replicate `Presence` via HLC + Last-Writer-Wins into the shared `presence-global` space.

## Workflow {#workflow}

### Step 1: FederationPolicy With HRW By threadId {#step-1-policy}

All thread-scoped types (`Thread`, `Msg`, `ChatTask`) use `mode: "expand"`, `by: { field: "threadId" }` across `["member-1", "member-2", "member-3"]`:

- Every message and task belonging to the same thread deterministically lands on the same member space.
- Different threads distribute evenly across the 3 member spaces.
- Transactions open on the target member via `federatedSpace.createTransaction(member, leaseMs, request)` and complete via `finishTransaction(originId, "commit", request)`.

### Step 2: Federated Subagent Search Across All 3 Members {#step-2-federated-search}

When `bob` asks in a thread hosted on `member-2` about the `"PostgreSQL"` decision made in a thread hosted on `member-1`, the search subagent executes `federatedSpace.readAll({ type: "Msg" }, request)`. The router queries all 3 member spaces, merges the results, and returns the cited answer!

### Step 3: Waiter Race (takeWaiting) & LWW Presence {#step-3-waiter-and-lww}

Global workers call `federatedSpace.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)` to claim tasks from whichever member receives work first. Stage 5 also previews `EntryReplicationController` (Phase 3) replicating `Presence` state across replicas via HLC and Last-Writer-Wins.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
```

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)
