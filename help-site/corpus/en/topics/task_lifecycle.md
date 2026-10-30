---
standard: help_topic
id: help.topic.task_lifecycle
title: "Task Lifecycle and Safe Retries"
short: "A task is an entry in the space. A worker claims it, does the work, and finishes it together with the result. This guide shows that path and what happens on failure, so nothing gets lost or runs twice."
tags: [task, abort, lease, retry, completion, ThreadSequence, unique, fork]
owner: core
related: [help.topic.overview, help.workflow.overview_v1_to_v6]
since: 0.0.1
---

# Task Lifecycle and Safe Retries

## The Path of a Task {#overview}

A task is an entry in the space. A worker claims it, does the work, and finishes it together with the result. This guide shows that path and what happens on failure, so nothing gets lost or runs twice.

## States and Failure Boundaries {#states}

The task Entry and its transaction reservation have separate leases. A reservation prevents competing claims; the business commit finalizes task removal and its result.

1. Producer writes a task with a sufficient lease and a RequestRef when required.
2. Worker opens a bounded transaction and takes the task.
3. Worker computes outside long storage callbacks and writes a correlated result under the same txn.
4. commit checks the CompletionProfile and budgets; publish feed/cache state only afterward.
5. Before commit, errors lead to abort; after a worker crash, reservation expiry returns the task if it still exists.
6. A lost commit reply leaves the outcome unknown: resolve the same request identity rather than starting a new effect.

## Chat: Sequences, Singletons and Forks {#chat}

ThreadSequence is a Space Entry reserved transactionally for sequence allocation; Msg and the updated counter commit together. Do not rely solely on a process-local increment. write with unique: ["threadId"] checks singleton creation atomically and reports a match as UniqueConflict; read followed by write would race. A fork stores parentThreadId/forkUpToSeq; inherited messages are resolved on read rather than copied. [write API](help.api.phispaces_write#parameters).

## Verification and Boundaries {#failure-test}

Verify competing workers, failure before results, CompletionViolation, task expiry, process reopen, and duplicate request IDs with equal/different arguments. Expect at most one committed take, no phantom cache and no new effect under an old retry. Expiry of the task's own lease may remove it. External email/HTTP/LLM effects need independent idempotency; a CompletionProfile does not judge result quality.
