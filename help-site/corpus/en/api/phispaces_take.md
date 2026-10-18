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

`take(template, timeout, options?)` removes a matching entry exclusively. Without `txn`, removal is immediate; with `{ txn }`, the entry is reserved under that transaction and automatically returns to the space on `abort(txn)` or transaction lease expiry.

## Technical Reference {#technical-reference}

```ts
const txn = await space.createTransaction(30_000);
const task = await space.take({ type: "ChatTask", fields: { threadId: "main" } }, 5_000, { txn: txn.id });
```

- If the entry type is governed by a `RunGate`, entries are takeable only while the run's `RunGate` is in state `running`.

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
- **Timer disarming**: The reaper takes expired `TimerLock` entries, which triggers due `ScheduledJob` alarms.
