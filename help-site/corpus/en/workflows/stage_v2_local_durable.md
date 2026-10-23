---
standard: help_workflow
id: help.workflow.stage_v2_local_durable
title: "Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent"
short: "Extends Stage 1 with SQLite storage, restart-safe RequestRef claims, TimerLock leases for scheduled alarms, and the search_history subagent."
tags: [v2, sqlite, durable, requestref, alarms, timerlock, subagent, search_history]
owner: client
related: [help.workflow.stage_v1_local_memory, help.workflow.stage_v3_remote_socket]
since: 0.0.1
---

# Stage 2 (v2-local-durable): SQLite Persistence, Alarms & Subagent

## Overview {#overview}

Stage 2 (`help-site/examples/v2-local-durable/run.ts`) makes the Multiplayer Space-Chat durable across process restarts and adds the two advanced capabilities from the Earendil post: **scheduled tasks (`schedule` alarms)** and **cross-conversation search via subagent (`search_history`)**—both built purely on `phi-spaces` primitives.

## Topology: Space Distribution {#topology}

- **1 process**, **1 host** on a **SQLite file** (`chat-v2.sqlite`).
- **1 named space** (`chat-v2`): threads, `Msg`, `ChatTask`, `ScheduledJob`, `TimerLock`, subagent entries — all durable in one space.
- For the crash demo the host is closed and **reopened on the same SQLite file**: the space survives the simulated restart and expired leases are reaped.

## Workflow {#workflow}

### Step 1: SQLite Storage And RequestRef Claims {#step-1-sqlite-claims}

Instead of the in-memory store, the host opens `await openSqliteHost(dbPath)` (the own SQLite store). Each participant obtains a generation via `const { generation } = await space.issueGeneration(principal)`. Re-sending `createThread` or `submitMessage` with the same `requestId` after a connection drop returns the original result without duplicating entries.

### Step 2: Scheduled Alarms Via ScheduledJob + TimerLock Lease {#step-2-alarms}

1. Scheduling a reminder (`scheduleReminder(threadId, "Check backup window", 200)`) writes:
   - a `ScheduledJob` entry with `status: "pending"` and `FOREVER` lease,
   - a `TimerLock` entry `{ jobId, threadId, executeAt }` with **`lease = delayMs`**.
2. While `TimerLock` exists in the space, the job is not yet due.
3. Once `delayMs` elapses—even if the server process was stopped and reopened on the same SQLite file!—the `phi-spaces` reaper expires `TimerLock`.
4. `tickAlarms()` takes the unlocked `ScheduledJob` inside a transaction, rewrites it with `status: "triggered"`, and atomically enqueues the wakeup `ChatTask`.

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
