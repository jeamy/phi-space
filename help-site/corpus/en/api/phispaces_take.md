---
standard: help_api
id: help.api.phispaces_take
title: "take & takeIfExists – Exclusively Remove or Reserve an Entry"
short: "Removes a matching entry immediately or reserves it exclusively under a transaction (returning it on abort or lease expiry)."
tags: [take, takeifexists, exclusive, reservation, txn]
owner: client
related: [help.topic.leases_and_transactions, help.api.phispaces_txn]
since: 0.0.1
---

# take & takeIfExists – Exclusively Remove or Reserve an Entry

## Overview {#overview}

`take` fetches a matching entry from the space, and only one caller gets it. This is the basic building block for tasks: several workers wait, one wins. With a transaction the removal is provisional, and the entry comes back if the work fails.

## Technical Reference {#technical-reference}

Without `txn`, removal is immediate. With `{ txn }`, the entry is reserved under that transaction and automatically returns to the space on `abort(txn)` or transaction lease expiry.

```ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
```

- If the entry type is governed by a `RunGate`, entries are takeable only while the run's `RunGate` is in state `running`.
- `takeIfExists` waits only while matches are held. `takeExisting(space, template, waitMs, { txn })` also tells missing from held and then throws `StillHeld`.
- `takeAll(space, template, { txn })` takes every match free right now and returns the count; held ones stay.
- `awaitWork(space, template, waitMs, halt?)` waits for work while holding nothing: one blocking `read` without a transaction.

## Parameters And Return Value {#parameters}

| Parameter | Type | Meaning |
| --- | --- | --- |
| `template` | `Template` | Query pattern as in `read`; at most one consumer wins exclusive access. |
| `timeout` | `number` | Wait time in ms until a matching entry becomes available (`NO_WAIT`/`FOREVER` allowed). |
| `options.txn` | `string` | Optional: reserves the entry under the transaction instead of deleting it immediately. |
| **Return** | `Promise<EntryView | null>` | The removed or reserved entry – or `null` on timeout. |

## Typical Use Cases {#use-cases}

- **Worker reservation**: The chat worker runs `take({ type: "ChatTask" }, FOREVER, { txn })`, writes the reply `Msg` under the same `txn`, and calls `commit(txn)` — task and result appear atomically.
- **Crash safety**: If the worker crashes, the transaction lease expires and the `ChatTask` automatically returns to the space for another worker.
- **Timer disarming**: The reaper removes expired `TimerLock` entries; `tickAlarms()` then turns due `ScheduledJob`s into `ChatTask`s.
