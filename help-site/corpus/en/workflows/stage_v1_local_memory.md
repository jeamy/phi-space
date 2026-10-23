---
standard: help_workflow
id: help.workflow.stage_v1_local_memory
title: "Stage 1 (v1-local-memory): Zero-Setup Local Quickstart"
short: "The simplest runnable version of the Multiplayer Space-Chat in memory: threads, forking, presence leases, and transactional reply processing."
tags: [v1, memory, quickstart, phispaces, thread, fork, presence, completionprofile]
owner: client
related: [help.workflow.overview_v1_to_v6, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Stage 1 (v1-local-memory): Zero-Setup Local Quickstart

## Overview {#overview}

Stage 1 (`help-site/examples/v1-local-memory/run.ts`) requires zero setup, database files, or open network ports. It opens a host in memory (`openOwnMemoryHost()`), creates a named space, and demonstrates the complete core model of the Multiplayer Space-Chat in under a second.

## Topology: Space Distribution {#topology}

- **1 process**, **1 host** in memory (`openOwnMemoryHost()`; volatile, no restart scenario).
- **1 named space** (`chat-v1`): every entry (`Presence`, `Thread`, `Msg`, `ChatTask`) lives in that single space.
- Clients (alice/bob) and workers share the same in-process `PhiSpaces` object — no socket, no file, no network.

## Workflow {#workflow}

### Step 1: Initialize Space And CompletionProfile {#step-1-init}

```ts
const host = openOwnMemoryHost();
await host.commit((tx) => createSpace(tx, "chat-v1", Date.now()), ctx);
const space = new PhiSpaces(host, ctx, Date.now, meter, undefined, { space: "chat-v1" });
const stopService = await startService(host, ctx);

await space.setCompletionProfiles([
  { taskType: "ChatTask", resultTypes: ["Msg"], equalFields: ["taskId", "threadId"], maxResultCount: 1 }
]);
```

### Step 2: Register Participant Presence With Space Leases {#step-2-presence}

When `alice` and `bob` join the session, each client writes a `Presence` entry with a 30-second lease (`30_000` ms) and refreshes it via `space.renew(lease.id, 30_000)`.

### Step 3: Submit Message, Reply Transactionally, And Fork Thread {#step-3-chat-and-fork}

1. `alice` atomically writes her user `Msg` (`seq: 1`) and a matching `ChatTask`.
2. The chat worker reserves `ChatTask` under a transaction (`space.take(..., { txn })`), writes the assistant reply `Msg` (`seq: 2`) carrying the same `taskId`, and calls `space.commit(txn)`.
3. `bob` forks the thread at `seq: 2` (`forkThread` stores the parent pointer and boundary; inherited messages up to `seq <= 2` are resolved on read, not physically copied).

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
```

## See Also {#see-also}

- [Stage 2 (v2-local-durable): SQLite, RequestRef Claims, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)
