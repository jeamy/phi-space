---
standard: help_workflow
id: help.workflow.stage_v5_federated_cluster
title: "Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router"
short: "Distributes threads across 3 member spaces through a router: HRW placement per threadId, cluster-wide reads, and LWW presence, simulated in one process."
tags: [v5, federation, cluster, router, hrw, federatedspace, takewaiting, lww]
owner: federation
related: [help.workflow.stage_v4_gated_auth, help.workflow.stage_v6_mobile_control]
since: 0.0.1
---

# Stage 5 (v5-federated-cluster): Federated Spaces, HRW Sharding & Router

## Overview {#overview}

Stage 5 spreads the chat across several spaces so it can grow beyond one machine. All messages of a thread always land in the same place, while different threads land in different places. A search can still read all places together. The demo simulates this in a single process.

## Topology: Space Distribution {#topology}

`help-site/examples/v5-federated-cluster/run.ts` distributes threads and messages across **three member spaces (`member-1`, `member-2`, `member-3`)**. The program composes `RouterController` and `FederatedSpace` directly; for operation, [`createFederationController`](help.api.federation_controller#overview) combines both with policy and membership.

The cluster is **simulated inside a single process**: **4 hosts** in memory (`openOwnMemoryHost()`) play member hosts with real federation components. There is no network, but the same routing and journal logic as in a truly distributed deployment.

- **1 coordinator host**: `RouterController` (`router-root` + 2 partition routers for the routing journals) and `FederatedSpace` (id `fed-v5`). The coordinator owns no chat-data space itself — it only executes the policy.
- **3 member hosts** (`member-1`, `member-2`, `member-3`): each owns its own independent space with its own space doc.
- **HRW sharding**: the federation policy routes `Thread`, `Msg`, and `ChatTask` by rendezvous hashing over `fields.threadId` deterministically onto exactly one member. The runner report field `memberDistribution` shows the actual placement, e.g. `{ member-1: [alpha, gamma], member-2: [beta], member-3: [delta] }`.
- **`FederationIO`** is an in-process adapter onto the local `PhiSpaces` objects in this demo, and so is the router's target adapter. In real distribution these would be RPC calls to remote hosts; the contract (`step`, `snapshot`, `events`, `ack`, `txnActive`) stays the same.
- **Replication**: 2 `EntryReplicationController` instances (`rep-1` on member-1, `rep-2` on member-2) replicate `Presence` via HLC + Last-Writer-Wins under the space ID `presence-global`. The program carries the changes once from `rep-1` to `rep-2` (`changes`, `importChanges`).

## Workflow {#workflow}

### Step 1: FederationPolicy With HRW By threadId {#step-1-policy}

All thread-scoped types (`Thread`, `Msg`, `ChatTask`) use `mode: "expand"`, `by: { field: "threadId" }` across `["member-1", "member-2", "member-3"]`:

- Every message and task belonging to the same thread deterministically lands on the same member space.
- Different threads distribute evenly across the 3 member spaces.
- Writes use `federated.write(entry, { id, principal }, FOREVER)`. The program writes four threads with one message each. `FederatedSpace` also offers member transactions (`createTransaction(member, leaseMs, request)`, `finishTransaction(originId, "commit", request)`); the program does not use them.

### Step 2: Federated Subagent Search Across All 3 Members {#step-2-federated-search}

`federated.readAll({ type: "Msg" }, principal)` queries every member space the template can match and returns `{ entries, complete }`. `complete` says whether all members answered. The program counts all messages of the cluster this way. This stage runs no search subagent; reading across all members is the basis for one.

### Step 3: LWW Presence, Waiter Race As API Only {#step-3-waiter-and-lww}

The program writes a `Presence` entry with `rep1.mutate(...)`, carries the change over, and reads it on `rep-2`. A conflict between two writers is decided by HLC and Last-Writer-Wins.

The program does not run `takeWaiting`. The method takes a task from whichever member has one first: `federated.takeWaiting({ type: "ChatTask" }, timeoutMs, txnLeaseMs, request)`. Without a transaction it requires `timeoutMs` from 1 to 3,600,000 and `txnLeaseMs` from 1 to 60,000, otherwise it raises `RoutingConflict`.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v5-federated-cluster/run.ts
```

## See Also {#see-also}

- [Stage 6 (v6-mobile-control): Mobile App & Web Admin Control](help.workflow.stage_v6_mobile_control#overview)
