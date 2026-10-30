---
standard: help_topic
id: help.topic.completion_profiles_and_limits
title: "CompletionProfiles and Resource Limits"
short: "Server-side result verification when committing take transactions (CompletionProfile) and fixed byte and owner quotas (DEFAULT_LIMITS)."
tags: [completionprofile, completionviolation, limits, quotas, bytes, budget]
owner: core
related: [help.topic.leases_and_transactions, help.api.phispaces_completion_profiles]
since: 0.0.1
---

# CompletionProfiles and Resource Limits

## Overview {#overview}

A worker takes a job and is meant to deliver a result. Here you decide that it can only finish the job if the result is really there. A faulty program or an AI agent therefore cannot simply make a task disappear. Size limits are added so that no participant can fill up the space.

### Technical Details {#technical-details}

The space enforces this on the server side with **`CompletionProfiles`** and strict **byte and object budgets (`DEFAULT_LIMITS`)**. Both apply even if a worker does not stick to the agreement.

## Concept And System Model {#concept-model}

### Server-Side Result Contracts (CompletionProfile) {#completion-profiles}

A `CompletionProfile` declares which result entries must be written inside the same transaction for every taken task entry before `commit(txn)` succeeds:

```ts
await space.setCompletionProfiles([
  {
    taskType: "ChatTask",
    resultTypes: ["Msg"],
    equalFields: ["taskId", "threadId"],
    maxResultCount: 1
  },
  {
    taskType: "SearchTask",
    resultTypes: ["SearchResult"],
    equalFields: ["searchId", "parentThreadId"],
    maxResultCount: 1
  }
]);
```

If a worker calls `commit(txn)` without having written at least one and at most `maxResultCount` matching results with the same `taskId` and `threadId` for the taken `ChatTask`, the core throws `CompletionViolation`. With `maxResultCount: 1` that means exactly one `Msg`. The transaction remains open so the caller can either write the missing result or roll back via `abort(txn)`.

Further rules of a profile:

- A task with a profile can only be taken under a transaction; without `txn` the result is `CompletionViolation` as well.
- A result entry in the transaction that matches no taken task prevents the commit (`unmatched completion result`).
- `maxResultBytes` limits the total size of a task's results.
- `maxLeaseMs` limits how far the transaction lease may reach.
- `gateField` binds tasks to the RunGate of their run. The field must be listed in `equalFields`, and `maxLeaseMs` is then required.

### Byte Budgets And Owner Quotas (DEFAULT_LIMITS) {#default-limits}

Entry counts have no default cap, either per space or per owner:
`maxEntries` and `maxEntriesPerOwner` use `FOREVER` (a JSON-safe unlimited value).
Explicit count quotas can still be set with `setLimits`. The byte budgets below and quotas
for subscriptions, waiters and transactions still apply; unlimited counts do not mean
unlimited memory or document size.

| Limit | Default | Meaning |
|---|---|---|
| `maxEntryBytes` | `64 KiB` | Maximum size of a single entry or handback |
| `maxCommitBytes` | `192 KiB` | Maximum encoded delta bytes of one commit (including claims & follow-up work) |
| `maxFrameBytes` | `256 KiB` | Maximum RPC wire frame size at the gate/socket |
| `maxEventBytes` | `160 KiB` | Maximum size of a delivered event |
| `maxSpaceBytes` | `64 MiB` | Total entry field bytes in a space |
| `maxClaimBytes` | `32 MiB` | Budget for stored request claims |
| `maxOutboxBytes` | `8 MiB` | Budget for undelivered events; above it new subscriptions and waits are refused, no event is dropped |
| `maxMailboxBytes` | `8 MiB` | Budget of the consumer mailboxes (`mailboxTtlMs` is 7 days by default and at most) |
| `maxLogBytes` | `4 MiB` | Revision log for `changes` |
| `maxSnapshotBytes` | `64 MiB` | Snapshot cache for `readPage` (at most `maxSnapshots` = 16, `snapshotTtlMs` = 60 s) |
| `maxJobBytes` | `16 MiB` | Budget for pending fanout jobs and completion reservations |
| `maxDocBytes` | `128 MiB` | Total document size of a space |

Time settings come on top: `claimResultMs` keeps request-claim results for 24 hours, `generationAdmitMs` lets a generation admit new requests for 1 hour, and `notifyIntervalMs` bundles subscription notices to at most one per second. Per owner the defaults allow at most 20 subscriptions, 20 waiters and 20 transactions.

Before **every** transaction extension, `core.ts` reserves conservative byte budgets for **both commit and abort**. If an operation would exceed the budget, it fails immediately with `ResourceExhausted`, ensuring an open transaction never becomes uncommittable or unabortable due to byte limits.

## See Also {#see-also}

- [Leases, Transactions, and Visibility](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)
