---
standard: help_api
id: help.api.phispaces_lease
title: "Leases – renew & cancel"
short: "Extends or cancels the lifetime of owned entries, transactions, notify subscriptions, and waiters (basis for presence & heartbeats)."
tags: [renew, cancel, lease, ttl, presence, heartbeat]
owner: client
related: [help.topic.leases_and_transactions, help.workflow.stage_v1_local_memory]
since: 0.0.1
---

# Leases – renew & cancel

## Overview {#overview}

Everything in the space has a lifetime. `renew` extends it, `cancel` ends it at once. Presence is a typical use: as long as a program keeps renewing, it counts as online. When the renewals stop, the space removes the entry by itself.

## Technical Reference {#technical-reference}

`renew(leaseId, ms, options?)` updates the expiration of an owned resource to `now + ms` (or `FOREVER`) and returns the new expiration timestamp. `cancel(leaseId, options?)` terminates the resource immediately (removes the entry, aborts the transaction, or cancels the subscription/waiter).

```ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
```

## Behavior {#parameters}

- **Ownership**: A conversation may only change its own leases; foreign calls are rejected. Host code (without `conversationId`) is unrestricted; remotely the connection's identity applies.
- **`renew`**: Sets `expires = now + ms` (or `FOREVER`); works for entry leases, transaction leases, notify subscriptions, and parked waiters.
- **`cancel`**: Terminates the resource immediately – for an entry this equals removal, for a transaction an `abort`.
- **`keepAlive(space, lease, leaseMs)`** from `phi-spaces`: Renews a lease every `leaseMs / 3` while long work runs and returns the stop function. If the process dies, the lease lapses within `leaseMs`.

## Typical Use Cases {#use-cases}

- **Presence heartbeat**: A client renews its `Presence` lease regularly before it expires; on disconnect the lease expires and the participant automatically leaves the online list.
- **Long-running tasks**: A worker performing expensive processing keeps its transaction alive with `keepAlive` so the reservation does not expire early.
- **Clean sign-out**: `cancel(presence.id)` on an orderly disconnect removes the record immediately instead of waiting for the reaper.
