---
standard: help_workflow
id: help.workflow.stage_v1_local_memory
title: "Stage 1 (v1-local-memory): Zero-Setup Local Quickstart"
short: "The simplest runnable version of the chat in memory: threads, forks, presence, and replies inside a transaction."
tags: [v1, memory, quickstart, phispaces, thread, fork, presence, completionprofile]
owner: client
related: [help.workflow.overview_v1_to_v6, help.workflow.stage_v2_local_durable]
since: 0.0.1
---

# Stage 1 (v1-local-memory): Zero-Setup Local Quickstart

## Overview {#overview}

Stage 1 is the simplest start: a program with no database, no network, and no configuration. It shows how two people join a chat, write, get a reply, and branch off a conversation. Everything lives in memory and is gone when the program ends.

## Topology: Space Distribution {#topology}

The program `help-site/examples/v1-local-memory/run.ts` opens a host in memory (`openOwnMemoryHost()`) and creates a named space.

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

When `alice` and `bob` join the session, `engine.joinOrRefreshPresence(...)` writes a `Presence` entry for each with a 30-second lease (`30_000` ms). `engine.renewPresence(participantId, ms)` extends it through `space.renew(leaseId, ms)`; the program extends `alice` to 45 seconds.

### Step 3: Submit Message, Reply Transactionally, And Fork Thread {#step-3-chat-and-fork}

1. `alice` atomically writes her user `Msg` (`seq: 1`) and a matching `ChatTask`.
2. The chat worker reserves `ChatTask` under a transaction (`space.take(..., { txn })`), writes the assistant reply `Msg` (`seq: 2`) carrying the same `taskId`, and calls `space.commit(txn)`.
3. `bob` forks the thread at `seq: 2` (`forkThread` stores the parent pointer and boundary; inherited messages up to `seq <= 2` are resolved on read, not physically copied).

The program also calls `createThread` twice with the same `requestId`: the repeat returns the same thread and creates no second one.

### Run From Terminal {#run-cli}

```bash
node --experimental-strip-types help-site/examples/v1-local-memory/run.ts
```

## See Also {#see-also}

- [Stage 2 (v2-local-durable): SQLite, Alarms & Subagent](help.workflow.stage_v2_local_durable#overview)
