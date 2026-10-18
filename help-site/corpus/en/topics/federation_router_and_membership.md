---
standard: help_topic
id: help.topic.federation_router_and_membership
title: "Federation, Router, HRW Sharding, and Membership"
short: "How createFederationController unites multiple member spaces into a cluster using HRW routing, signed delegations, and journaled waiter races."
tags: [federation, router, routerlease, delegation, hrw, federatedspace, takewaiting, membership, erasure]
owner: federation
related: [help.workflow.stage_v5_federated_cluster, help.api.federation_controller]
since: 0.0.1
---

# Federation, Router, HRW Sharding, and Membership

## Overview {#overview}

Phase 2 (`src/router.ts`, `src/delegation.ts`, `src/federation-policy.ts`, `src/federated-space.ts`, `src/membership.ts`) unites multiple physical member spaces under a coordinator router into a logical `FederatedSpace`.

## Concept And System Model {#concept-model}

### RouterController And Journal Partitions {#router-and-journals}

Every federated operation transitions through the persistent state machine `accepted → applying → completed | failed | needsReview` in `RouterController`. Before the first RPC is sent to a member, target `spaceId`, `primaryEpoch`, child `requestId`, and argument hash are persisted in the journal (1 to 1024 partitions). After a router restart, `recover()` resolves in-flight child requests via `pollOperation` / `resolveOperation` without blindly triggering a second effect.

### HRW Routing (Highest Random Weight) And Transaction Binding {#hrw-routing}

`FederationPolicy` assigns a placement rule to each entry type:

- **`local`**: Pinned to a single member space.
- **`expand` by type or key field (HRW)**: With `by: { field: "threadId" }`, the router deterministically hashes the canonical field value and member IDs to pick the owning member.
- **Benefit for our Multiplayer Space-Chat**: Because `Thread`, `Msg`, and `ChatTask` all route by `field: "threadId"` across the same member set, every operation for a given thread lands on the exact same member space! Local space transactions and `CompletionProfiles` therefore work at full speed without cross-node two-phase locking.

### Journaled Waiter Race In takeWaiting {#waiter-race}

When a global worker calls `federatedSpace.takeWaiting(template, timeoutMs, txnLeaseMs, request)` with a wildcard key, the router registers bounded take waiters across all candidate members. When mailbox events arrive, they are ingested into the router journal **before** mailbox ACK: the first active reservation is durably elected as the winner, and any competing reservations on other members are automatically aborted and returned.

## See Also {#see-also}

- [Stage 5 (v5-federated-cluster): Federated Multiplayer Space-Chat](help.workflow.stage_v5_federated_cluster#overview)
- [createFederationController & FederatedSpace API](help.api.federation_controller)
