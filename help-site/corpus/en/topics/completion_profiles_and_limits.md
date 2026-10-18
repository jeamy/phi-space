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

To ensure a buggy worker or hallucinating AI agent can never take a task from the space and commit the transaction without producing a valid result, `phi-spaces` enforces server-side **`CompletionProfiles`** and strict **byte and object budgets (`DEFAULT_LIMITS`)**.

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

If a worker calls `commit(txn)` without having written exactly one `Msg` with matching `taskId` and `threadId` for the taken `ChatTask`, the core throws `CompletionViolation`. The transaction remains open so the caller can either write the missing result or roll back via `abort(txn)`.

### Byte Budgets And Owner Quotas (DEFAULT_LIMITS) {#default-limits}

| Limit | Default | Meaning |
|---|---|---|
| `maxEntryBytes` | `64 KiB` | Maximum size of a single entry or handback |
| `maxCommitBytes` | `192 KiB` | Maximum encoded delta bytes of one commit (including claims & follow-up work) |
| `maxFrameBytes` | `256 KiB` | Maximum RPC wire frame size at the gate/socket |
| `maxEventBytes` | `160 KiB` | Maximum size of a delivered event |
| `maxSpaceBytes` | `64 MiB` | Total entry field bytes in a space |
| `maxClaimBytes` | `32 MiB` | Budget for stored request claims |
| `maxOutboxBytes` | `8 MiB` | Budget for outbox / mailboxes (max 7 days TTL) |
| `maxDocBytes` | `128 MiB` | Total document size of a space |

Before **every** transaction extension, `core.ts` reserves conservative byte budgets for **both commit and abort**. If an operation would exceed the budget, it fails immediately with `ResourceExhausted`, ensuring an open transaction never becomes uncommittable or unabortable due to byte limits.

## See Also {#see-also}

- [Leases, Transactions, and Visibility](help.topic.leases_and_transactions#overview)
- [setCompletionProfiles & setLimits](help.api.phispaces_completion_profiles)
