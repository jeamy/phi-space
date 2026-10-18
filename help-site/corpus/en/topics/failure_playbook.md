---
standard: help_topic
id: help.topic.failure_playbook
title: "Failure Diagnosis and Safe Next Actions"
short: "Transport errors, business rejection and storage failure differ. Before retrying, retain the request ID, generation, arguments, target Space, incarnation and applicable epoch. Unknown does not mean failed."
tags: [OutcomeUnknown, RequestConflict, ResultExpired, SnapshotExpired, ResourceExhausted, NotCommitted, needsReview, poisoned, recovery]
owner: remote
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Failure Diagnosis and Safe Next Actions

## Identify Outcome and Layer First {#overview}

Transport errors, business rejection and storage failure differ. Before retrying, retain the request ID, generation, arguments, target Space, incarnation and applicable epoch. Unknown does not mean failed.

## Decision Table {#decisions}

| Failure | Safe Action | Do Not |
|---|---|---|
| OutcomeUnknown / CommitSealed | Resolve the same request identity with pollOperation or the responsible recovery path. | Send a new ID as a presumed retry. |
| RequestConflict | Compare stored arguments/identity; treat a business change as a new command. | Force new arguments under the old ID. |
| ResultExpired / RequestExpired | Independently inspect the business effect; respect retention/admission deadlines. | Blindly replay the mutation with a new ID. |
| SnapshotExpired / RevisionAhead | Reload a complete baseline. | Append a new first page to old data. |
| ResourceExhausted | Identify the bound, limit/abort the transaction, try smaller batches. | Raise quotas without control. |
| NotCommitted | Check the authoritative negative decision and current context; deliberately issue an allowed new request. | Treat it as OutcomeUnknown. |
| needsReview | Inspect actual effects and journal; document the decision. | Blindly start a second admin command. |
| Session is poisoned | Stop new writes, resolve the sealed candidate and reopen the harness. | Fall back to async or continue unconfirmed writes. |

## What Evidence to Collect? {#evidence}

Record timestamp, method, RequestRef, an argument hash rather than confidential payload, Space ID, incarnation, streamId/rev, primaryEpoch/routerEpoch, limit name, required bytes and queue/mailbox state. Never put passwords, private keys, grants or enrollment tokens in public logs. A log entry alone does not prove an effect.

## Test Deliberately {#test}

Lose a successful commit reply, retry identically and verify exactly one result. Then send different arguments under the same ID: RequestConflict. Storage-rejection tests must block subsequent writes; demonstrate reopen separately. This guide is not an unreviewed production recovery command or fencing acceptance.
