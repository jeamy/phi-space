---
standard: help_workflow
id: help.workflow.stage_v2_local_durable
title: "Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent"
short: "Extends Stage 1 with storage in a SQLite file, safely repeatable calls, scheduled alarms, and a search across all threads."
tags: [v2, sqlite, durable, requestref, alarms, timerlock, subagent, search_history]
owner: client
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent

## Overview {#overview}

Stage 2 makes the chat durable: the data lives in a file and survives a program restart. It also adds two features that only make sense with that. These are scheduled reminders and a search through earlier conversations.

## Topology: Space Distribution {#topology}

The program `help-site/examples/v2-local-durable/run.ts` adds the two capabilities from the Earendil post, **scheduled tasks (`schedule` alarms)** and **cross-conversation search via subagent (`search_history`)**, purely with `phi-spaces` primitives.

- **1 process**, **1 host** on a **SQLite file** (`chat-v2.sqlite`, phi-spaces' own store).
- **1 named space** (`chat-v2`): threads, `Msg`, `ChatTask`, `ScheduledJob`, `TimerLock`, subagent entries — all durable in one space.
- For the crash demo the host is closed and **reopened on the same SQLite file**: the space survives the simulated restart and expired leases are reaped.

## Workflow {#workflow}

### Step 1: SQLite Store And Safely Repeatable Calls {#step-1-sqlite-claims}

Instead of the in-memory store, the program opens `await openSqliteHost(dbPath)`, the own SQLite store: WAL mode, one writer thread, `synchronous=FULL` by default. Exactly one process owns the file through the lock `<path>.owner`; a second one gets `StoreUnavailable`. This is neither a pi-durable store nor a JSONL file.

The chat engine handles repeats itself. `createThread` writes with `unique: ["threadId"]` and keeps the `requestId` in the `Thread` entry; `submitMessage` derives `msgId` and `taskId` from the `requestId` and first checks whether the message exists. So the same `requestId` returns the first result, and the same `requestId` with other arguments is an error. The engine does not use the space's request claims (`RequestRef`, `issueGeneration`); they are in the [claims API](help.api.phispaces_claims#overview).

### Step 2: Scheduled Alarms Via ScheduledJob + TimerLock Lease {#step-2-alarms}

1. `engine.scheduleReminder({ jobId, threadId, instruction, requestedBy, delayMs, requestId })` schedules a reminder; the program uses `delayMs: 60`. It writes:
   - a `ScheduledJob` entry with `status: "pending"` and `FOREVER` lease,
   - a `TimerLock` entry `{ jobId, threadId, executeAt }` with **`lease = delayMs`**.
2. While `TimerLock` exists in the space, the job is not yet due.
3. The program closes the host and waits 90 ms. After the same SQLite file is reopened, the reaper of `startService` removes the expired `TimerLock`.
4. `tickAlarms()` takes the due `ScheduledJob` inside a transaction, removes a lock that is still there, rewrites the job with `status: "triggered"`, and atomically creates the wakeup `ChatTask`.

### Step 3: Cross-Thread Search Via Search Subagent {#step-3-subagent}

1. In Thread 1, `alice` says: *"We decided to use PostgreSQL for the event store."*
2. In Thread 2, `bob` asks: *"What did we decide about the event store?"*
3. The main worker writes a `SearchTask` (`{ searchId, parentThreadId, question }`) into the space.
4. The **Search Subagent Worker** takes `SearchTask` under a transaction, scans all threads via `space.readAll({ type: "Msg" })` (excluding subagent artifacts), writes `SubagentStep` trace entries for sidebar inspection, and commits `SearchResult` under the second `CompletionProfile`.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v2-local-durable/run.ts
```

## See Also {#see-also}

- [Stage 3 (v3-remote-socket): Process Decoupling via SpaceService & RemoteSpace](help.workflow.stage_v3_remote_socket#overview)
