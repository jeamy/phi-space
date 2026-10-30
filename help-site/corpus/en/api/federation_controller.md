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

`createFederationController` spreads the data of one logical space across several spaces, also on several machines. Use it when a single host is no longer enough. Entries that belong together stay in the same place.

## Technical Reference {#technical-reference}

`createFederationController(options)` initializes and recovers the federated router (`journalPartitions` from 1 to 1024, default 1, fixed afterwards), `FederatedSpace`, `FederationPolicyAuthority`, and `MembershipController`. These APIs belong to the server-side router and do not replace the signatures of `RemoteSpace`.

```ts
const fed = await createFederationController({
  ...federationOptions, // Configured keys, transport, grants, lease and authority/admin guards.
  host,
  ctx,
  id: "router-main",
  journalPartitions: 4
});
```

## Components At A Glance {#parameters}

| Component | Task |
| --- | --- |
| `RouterController` | Journals commands with stable sub-request IDs: `recover`, `submit`, `advance`, `get`, `ingest`, `review`. `renewableRouterLease` looks after the signed lease. |
| `FederatedSpace` | Routes by policy and HRW hash of the routing field (e.g. `threadId`) to the responsible member. Own signatures, not `SpaceLike`: `write(entry, request, leaseMs)`, `read(template, request)`, `take(template, request)`, `readAll(template, principal, options?)` with `{ entries, complete }`. |
| `FederationPolicyAuthority` | Manages the authoritative member set and shard mapping. |
| `MembershipController` | Controlled adding, draining, and removing of members as journaled commands: `execute(id, "add" \| "drain" \| "remove", member, ...)`. |
| `takeWaiting` | Journaled waiter race: exactly one member wins a cluster-wide parked take wish. Bounds: `timeoutMs` up to 3,600,000, `txnLeaseMs` up to 60,000. |
| `EntryReplicationController` | Its own document for replicated entries (HLC, LWW, Add-Wins), no replication of normal entries. `erasePrincipal`, `completeErasure`, `compactionStatus`, and `compact(id)` erase from and compact its history. |

## Typical Use Cases {#use-cases}

- **Chat sharding (v5)**: Threads are distributed across three members via HRW over `threadId` – every transaction stays locally atomic; cross-member `txn`s are rejected with `RoutingConflict`.
- **Cluster-wide reads**: `readAll` queries all matching members; `complete: false` shows that answers are missing.
- **Maintenance without downtime**: `execute` with `"drain"` empties a member in a controlled way before servicing it.
