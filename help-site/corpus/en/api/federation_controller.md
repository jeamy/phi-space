---
standard: help_api
id: help.api.federation_controller
title: "createFederationController & FederatedSpace – Router, HRW Sharding & Membership"
short: "Connects router journal partitions, signed RouterLease, original-principal delegation, HRW policy, waiter race, and membership lifecycle."
tags: [createfederationcontroller, routercontroller, federatedspace, membershipcontroller, hrw]
owner: federation
related: [help.topic.federation_router_and_membership, help.workflow.stage_v5_federated_cluster]
since: 0.0.1
---

# createFederationController & FederatedSpace – Router, HRW Sharding & Membership

## Overview {#overview}

`createFederationController(options)` initializes and recovers the federated router (supporting up to 1024 journal partitions), `FederatedSpace`, `FederationPolicyAuthority`, and `MembershipController`.

## Technical Reference {#technical-reference}

```ts
const fed = await createFederationController({
  host: coordinatorHarness,
  ctx,
  routerId: "router-main",
  authorityId,
  journalPartitions: 4,
  lease: renewableRouterLease(controlRemote),
  rpcTarget,
  assertAuthority
});
```

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| `RouterController` | Journals routing decisions partitioned (up to 1024) and signs `RouterLease`s for authorized members. |
| `FederatedSpace` | `SpaceLike` facade that routes `write`/`read`/`take` to the responsible member space via HRW hash of the correlation field (e.g. `threadId`). |
| `FederationPolicyAuthority` | Manages the authoritative member set and shard mapping. |
| `MembershipController` | Controlled join/drain/remove of members (`join`, `drain`, `leave`) as journaled commands. |
| `takeWaiting` | Journaled waiter race: exactly one member wins a cluster-wide parked take wish. |

## Typical Use Cases {#use-cases}

- **Chat sharding (v5)**: Threads are distributed across three members via HRW over `threadId` – every transaction stays locally atomic; cross-member `txn`s are rejected with `RoutingConflict`.
- **Cluster-wide search**: The `search_history` subagent writes `SearchTask`s that each member answers locally; the coordinator merges the `SearchResult`s.
- **Maintenance without downtime**: `membership.execute(cmdId, "drain", member)` empties a host in a controlled fashion before servicing it.
