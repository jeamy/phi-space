---
standard: help_topic
id: help.topic.failure_playbook
title: "Failure Diagnosis and Safe Next Actions"
short: "When a call fails, it is not always clear whether it took effect. This guide shows the safe next step for each failure. The key rule: unknown does not mean failed. So repeat with the same request ID, never with a new one."
tags: [OutcomeUnknown, RequestConflict, ResultExpired, SnapshotExpired, ResourceExhausted, NotCommitted, needsReview, poisoned, recovery]
owner: remote
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Failure Diagnosis and Safe Next Actions

## Identify Outcome and Layer First {#overview}

When a call fails, it is not always clear whether it took effect. This guide shows the safe next step for each failure. The key rule: unknown does not mean failed. So repeat with the same request ID, never with a new one.

## Decision Table {#decisions}

Transport errors, business rejection and storage failure differ. Before retrying, retain the request ID, generation, arguments, target Space, incarnation and applicable epoch.

| Failure | Safe Action | Do Not |
|---|---|---|
| OutcomeUnknown / CommitSealed | Resolve the same request identity with pollOperation or the responsible recovery path. | Send a new ID as a presumed retry. |
| RequestConflict | Compare stored arguments/identity; treat a business change as a new command. | Force new arguments under the old ID. |
| ResultExpired / RequestExpired | Independently inspect the business effect; respect retention/admission deadlines. | Blindly replay the mutation with a new ID. |
| SnapshotExpired / RevisionAhead | Reload a complete baseline. | Append a new first page to old data. |
| ResourceExhausted | Identify the bound, limit/abort the transaction, try smaller batches. | Raise quotas without control. |
| NotCommitted | Check the authoritative negative decision and current context; deliberately issue an allowed new request. | Treat it as OutcomeUnknown. |
| needsReview | Inspect actual effects and journal; document the decision. | Blindly start a second admin command. |
| PrimarySyncBlocked (poisoned by a sealed candidate) | Stop new writes, reopen the host and resolve the sealed candidate. | Continue unconfirmed writes. |
| StillHeld | The entry is not gone, only held; check again later. | Treat it as deleted. |
| UniqueConflict | Read and reuse the existing entry or deliberately refuse. | Create a duplicate under another key. |
| StoreUnavailable | Check for a running owner process or a wrong file; check the format. | Delete the lock file or copy the file while a process runs. |

## What Evidence to Collect? {#evidence}

Record timestamp, method, RequestRef, an argument hash rather than confidential payload, Space ID, incarnation, streamId/rev, primaryEpoch/routerEpoch, limit name, required bytes and queue/mailbox state. Never put passwords, private keys, grants or enrollment tokens in public logs. A log entry alone does not prove an effect.

## Test Deliberately {#test}

Lose a successful commit reply, retry identically and verify exactly one result. Then send different arguments under the same ID: RequestConflict. Storage-rejection tests must block subsequent writes; demonstrate reopen separately. This guide is not an unreviewed production recovery command or fencing acceptance.
