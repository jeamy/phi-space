---
standard: help_api
id: help.api.pispaces_completion_profiles
title: "setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts"
short: "Enforces expected result type, correlating fields (equalFields), and count before committing a take transaction; manages byte limits."
tags: [setcompletionprofiles, setlimits, completionprofile, completionviolation]
owner: core
related: [help.topic.completion_profiles_and_limits]
since: 0.0.1
---

# setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts

## Overview {#overview}

Only administrative host code (without `conversationId`) may invoke `setCompletionProfiles(profiles)` and `setLimits(partialLimits)`. Lowering limits below existing completion obligations is rejected by the space core.

## Technical Reference {#technical-reference}

```ts
await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
```

## Profile Fields And Errors {#parameters}

| Field | Meaning |
| --- | --- |
| `taskType` | Entry type taken under the transaction that triggers a result obligation. |
| `resultTypes` | Entry type that must be written within the same transaction. |
| `equalFields` | Fields whose values must match between task and result (correlation). |
| `maxResultCount` | Maximum correlating result count; at least one is required. |
| `maxResultBytes` | Total result bytes assigned to one task; also maxLeaseMs for bounded reservations and optional gateField. |

If a commit violates the profile, `commit` fails with `CompletionViolation` and nothing becomes visible. `setLimits` manages the space's byte/size budgets (e.g. `maxFrameBytes`, `maxEventBytes`, `mailboxTtlMs`).

## Typical Use Cases {#use-cases}

- **Reply guarantee in chat**: The commit fails server-side if the worker takes a `ChatTask` but writes no matching `Msg` with the same `taskId`/`threadId` – abort can return the reservation while the task lease and storage remain available.
- **Subagent contract**: `SearchTask → SearchResult` guarantees that every federated search ends with a correlated result.
