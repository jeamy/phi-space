---
standard: help_api
id: help.api.pispaces_lease
title: "Leases – renew & cancel"
short: "Extends or cancels the lifetime of owned entries, transactions, notify subscriptions, and waiters (basis for presence & heartbeats)."
tags: [renew, cancel, lease, ttl, presence, heartbeat]
owner: client
related: [help.topic.leases_and_transactions, help.workflow.stage_v1_local_memory]
since: 0.0.1
---

# Leases – renew & cancel

## Overview {#overview}

`renew(leaseId, ms, options?)` updates the expiration of an owned resource to `now + ms` (or `FOREVER`) and returns the new expiration timestamp. `cancel(leaseId, options?)` terminates the resource immediately (removes the entry, aborts the transaction, or cancels the subscription/waiter).

## Technical Reference {#technical-reference}

```ts
const presence = await space.write({ type: "Presence", fields: { username: "alice" } }, null, 30_000);
const newExpires = await space.renew(presence.id, 30_000);
await space.cancel(presence.id);
```

## Behavior {#parameters}

- **Ownership**: Only the lease owner (principal or ownership claim) may call `renew` and `cancel`; foreign calls are rejected.
- **`renew`**: Sets `expires = now + ms` (or `FOREVER`); works for entry leases, transaction leases, notify subscriptions, and parked waiters.
- **`cancel`**: Terminates the resource immediately – for an entry this equals removal, for a transaction an `abort`.

## Typical Use Cases {#use-cases}

- **Presence heartbeat**: The browser client renews its `Presence` lease every ~15 s; on disconnect the lease expires and the participant automatically leaves the online list.
- **Long-running tasks**: A worker performing expensive processing renews its transaction lease periodically so the reservation does not expire early.
- **Clean sign-out**: `cancel(presence.id)` on an orderly disconnect removes the record immediately instead of waiting for the reaper.
