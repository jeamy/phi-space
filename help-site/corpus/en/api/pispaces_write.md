---
standard: help_api
id: help.api.pispaces_write
title: "write – Write an Entry"
short: "Always creates a new typed entry with a lease; under a transaction it remains invisible to others until commit."
tags: [write, entry, lease, txn, requestref, mutation]
owner: client
related: [help.topic.entries_and_templates, help.api.pispaces_take]
since: 0.0.1
---

# write – Write an Entry

## Overview {#overview}

`space.write(entry, txn?, lease?, options?)` writes a new entry `{ type, types?, fields }` into the space and returns its `Lease { id, expires }`. It never overwrites existing entries in place.

## Technical Reference {#technical-reference}

```ts
const lease = await space.write(
  { type: "Msg", fields: { threadId: "main", seq: 1, text: "Hello" } },
  txnId ?? null,
  FOREVER,
  { request: { principal, generation, requestId: "msg-1" } }
);
```

- **Under Transaction (`txn`)**: The written entry is visible only to reads/takes carrying the same `txn` until `commit(txn)`.
- **Idempotency**: Passing `options.request` guarantees that retrying with identical arguments returns the original `Lease` without creating a second entry.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| `entry` | `EntryDraft` | Immutable draft: mandatory `type`, optional subtype list `types`, and free-form JSON `fields`. |
| `txn` | `string | null` | ID of an open transaction; `null` = immediate standalone commit. |
| `lease` | `number` | Lifetime in milliseconds or `FOREVER` for unbounded. |
| `options.request` | `RequestRef` | Optional claim `{ principal, generation, requestId }` for restart-safe idempotency. |
| **Return** | `Promise<Lease>` | `{ id, expires }` – the basis for `renew`/`cancel` and presence heartbeats. |

## Typical Use Cases {#use-cases}

- **Chat messages**: `Msg` entries with `FOREVER` leases form the durable, append-only conversation log.
- **Submitting work**: A `ChatTask` entry activates the chat worker — the producer neither knows nor reaches the worker directly.
- **Presence**: `Presence` entries with 30-second leases; when a client disappears, the reaper removes its record automatically.
- **Scheduled jobs**: `ScheduledJob` + `TimerLock` leases implement alarms and maintenance windows without a dedicated scheduler process.
