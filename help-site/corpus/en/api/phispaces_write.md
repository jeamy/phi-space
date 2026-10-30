---
standard: help_api
id: help.api.phispaces_write
title: "write – Write an Entry"
short: "Creates a new typed entry with a lifetime; supports request replay, atomic singleton creation through unique, and transient output."
tags: [write, entry, lease, txn, requestref, mutation]
owner: client
related: [help.topic.entries_and_templates, help.api.phispaces_take]
since: 0.0.1
---

# write – Write an Entry

## Overview {#overview}

`write` puts a new entry into the space, where other programs can find it. Use it for anything to be shared: messages, tasks, state. An existing entry is never overwritten. Each entry expires after a time you choose or stays for good.

## Technical Reference {#technical-reference}

`space.write(entry, txn?, lease?, options?)` writes a new entry `{ type, types?, fields }` into the space and returns its `Lease { id, expires }`. Without `lease`, `ANY` applies: the space picks the duration.

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
- **Several steps**: `batch(ops)` writes several entries and commits in one call (see [Transactions](help.api.phispaces_txn#parameters)).
- **Text**: Over the service, an unpaired surrogate in strings and keys becomes U+FFFD before anything sees the call. `cutText(text, max)` from `phi-spaces` shortens text without half an emoji.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| `entry` | `EntryDraft` | Immutable draft: mandatory `type`, optional subtype list `types`, and free-form JSON `fields`. |
| `txn` | `string | null` | ID of an open transaction; `null` = immediate standalone commit. |
| `lease` | `number` | Lifetime in milliseconds, `FOREVER` for unbounded, or `ANY` (default, the space picks). |
| `options.unique` | `string[]` | Optional atomic creation by key fields, per space and not across shards. An existing match, even reserved or uncommitted, gives `UniqueConflict`. Remote requires `write.unique`. |
| `options.transient` | `boolean` | Creates no entry: the change stream carries a `put` with `transient: true`, and no `read`, `take`, `wait`, `count`, or subscription sees it. Not with `unique`. Remote requires `write.transient`. |
| `options.request` | `RequestRef` | Optional claim `{ principal, generation, requestId }` for restart-safe idempotency. |
| **Return** | `Promise<Lease>` | `{ id, expires }` – the basis for `renew`/`cancel` and presence heartbeats. |

## Typical Use Cases {#use-cases}

- **Chat messages**: `Msg` entries with `FOREVER` leases form the durable, append-only conversation log.
- **Submitting work**: A `ChatTask` entry activates the chat worker — the producer neither knows nor reaches the worker directly.
- **Presence**: `Presence` entries with 30-second leases; when a client disappears, the reaper removes its record automatically.
- **Scheduled jobs**: `ScheduledJob` + `TimerLock` leases implement alarms and maintenance windows without a dedicated scheduler process.
