---
standard: help_api
id: help.api.pispaces_completion_profiles
title: "setCompletionProfiles & setLimits – Server-Side Result and Budget Contracts"
short: "Enforces expected result type, correlating fields (matchFields), and count before committing a take transaction; manages byte limits."
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
  { taskType: "ChatTask", resultType: "Msg", matchFields: ["taskId", "threadId"], minResults: 1, maxResults: 1 }
]);
```

## Profile Fields And Errors {#parameters}

| Field | Meaning |
| --- | --- |
| `taskType` | Entry type taken under the transaction that triggers a result obligation. |
| `resultType` | Entry type that must be written within the same transaction. |
| `matchFields` | Fields whose values must match between task and result (correlation). |
| `minResults` / `maxResults` | Expected number of correlating result entries. |
| `maxResultBytes` | Byte cap per result (federated profiles require this field). |

If a commit violates the profile, `commit` fails with `CompletionViolation` and nothing becomes visible. `setLimits` manages the space's byte/size budgets (e.g. `maxFrameBytes`, `maxEventBytes`, `mailboxTtlMs`).

## Typical Use Cases {#use-cases}

- **Reply guarantee in chat**: The commit fails server-side if the worker takes a `ChatTask` but writes no matching `Msg` with the same `taskId`/`threadId` – the task is never lost.
- **Subagent contract**: `SearchTask → SearchResult` guarantees that every federated search ends with a correlated result.
