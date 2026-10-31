# Codemode chat: architecture around a shared Space (status 2026-10-21)

## Purpose and status

The shared state of the application lives in a phi-spaces Space. Every process has a role and talks to the
others only through `SpaceLike`, locally over a Unix socket, between hosts over TCP. Process-local resources may be
recreated; whatever must survive a restart is in the Space.

**Implemented up to stage 2d** (commit `4011b0c` and the corrections of 2026-10-21):

- separate processes for space, web, judge, agents and model;
- checking in transactions;
- generations and work board as work in the Space (`server/run.ts`), with research, planning round, text tasks and
  their judges;
- all model calls in the model process (LlmCall/LlmResult), including the creation of a task (TaskRequest/TaskReady to
  an agents process);
- visitors' consumption as Spend entries;
- model choice of the admin through `CodeAdmin`.

The web process no longer calls models and no longer drives runs. `server/board.ts` has been dropped.

**Stage 3, implemented:**
- shared counters for model calls and web searches (`server/quota.ts`);
- admin sessions in the Space;
- ▶ in the judge process (`server/exec.ts`).

The request limits deliberately stay per web process (see "Performance and deployment").

**Stage 4, implemented:** Docker with one container per role, the profiles `nano` and `big` and both together as a local
test environment (see "Operation with Docker"). Open are the decisions on production operation (recovery,
retention, capacity, backup schedule).

The guarantees below separate today's behavior from necessary corrections. Putting data into the Space does not by itself yield
exactly-once execution at an external provider, nor a consistent snapshot, nor an atomic
budget check.

## State and process-local resources

The shared state includes:

- tasks, contributions, verdicts and references to the best result;
- runs, work items and task requests;
- consumption and the admin's choice.

Process-local copies of this must be restorable from the Space and must not release any work themselves.
The session of the web process reads the active block from the Space on every access.

Process-local are:

- open sockets and WebSocket clients;
- timers for snapshots;
- sandbox slots;
- loaded model registers and credentials;

Their loss on restart is expected. Credentials come from the deployment's configuration, never from the Space.

A local limit for concurrency or requests applies **per process**. A limit for the whole installation needs
shared coordination.

## Processes and connections

Paths are relative to `codemode-chat/` unless stated otherwise.

| Process | File | Role |
|---|---|---|
| space | `server/space-host.ts` | Holds the Space on SQLite and offers it through `serveSpace` at `CODEMODE_LISTEN`. |
| web | `server/index.ts`, `server/hub.ts` | Next.js, REST and WebSocket. Reads rooms, creates blocks, starts and stops runs (CodeRun), writes TaskRequests and ExecRequests and streams their events. |
| judge | `server/judge-host.ts`, `server/exec.ts` | Takes `CodeCandidate` in a transaction, writes `CodeScore`, the new best code and the archive in the same one. Executes ▶ (`ExecRequest`). |
| agents | `server/agent-host.ts`, `server/run.ts`, `server/task-agent.ts` | Takes the slots of the runs and works off their work items; handles TaskRequests (check rule, criteria and their verification). |
| model | `server/model-host.ts`, `server/context.ts` | The only process that calls models and needs credentials. Builds the context from the Space, publishes `ModelInfo`, applies `CodeAdmin`, writes `Spend`. |

Clients connect through `CODEMODE_SPACE`, for example `unix:/tmp/codemode-space.sock` or `tcp:host:3800`.

`server/launch.ts` starts all five roles by default; `CODEMODE_ROLES` selects the roles of a host. In
`codemode-chat/`, `npm run dev` starts the development processes, `npm start` the production processes. The launcher
starts the Space first and restarts children that end unexpectedly.

Every process keeps a `Process` entry with role, process identifier and host data (CPU, memory; no load).
The lease is 30 s and is renewed every 10 s; the system bar shows presence from it.

Several model processes are possible:
- Each keeps its own `ModelInfo` entry; web and agents merge them (`modelInfoOf` in `room.ts`).
- Each takes every call. They therefore need the same credentials: more processes distribute the load and step in
  for each other, they do not split up the providers.
- If one dies, a call it held comes back after at most 30 s.

## Patterns for transactions and coordination

**Take and publish**
- Take a work entry in a transaction, do the work, write result and follow-up entries, commit.
- Long work renews the lease of the transaction.
- If the transaction aborts or expires, everything is rolled back, and the entry is back as long as it
  itself still lives.

**External effect**
- The transaction makes only the changes in the Space atomic. An HTTP request or a paid model call cannot
  be taken back.
- After a crash, work may run again. Fixed call identifiers and retained results reduce
  repetitions, but guarantee no exactly-once execution at the provider.

**Waiting**
- Blocking `take`/`read` or `changes(rev, {waitMs})`.
- Server wait times stay below the client's call timeout (30 s), with margin for the transport.
- A timeout at the client leaves the result open; it does not prove that a change failed.

**Held entries**
- Normal read and count calls do not see entries that another transaction has taken.
- Even a read in a transaction holds the entry until its end: a `take` without waiting passes it by.
  The judge reads the CodeTask of its candidate this way; deleting a block therefore waits for it (`takeExisting`),
  instead of skipping it.
- `readIfExists`/`takeIfExists` with `HELD_WAIT_MS` (10 s) wait for a held hit, but also return `null`
  when the wait expires.
- `readExisting` (`server/space.ts`) distinguishes the two cases: `null` then really means gone, a hold beyond the
  wait time throws `StillHeld`.
- The judge uses this for the CodeTask of its candidate: the candidate goes back instead of disappearing without a verdict.
- `readRun` and `blockTask` use it too.
  - An agent whose run is held for longer keeps waiting instead of giving up its slot.
  - A work item that depends on it goes back without a failed attempt.
- In the hub, `#runNow`, Stop and 👍 use it as well.

**Lock entries**
- A shared lock arises when an entry is taken in a transaction and written back with the protected changes.
  All writers must keep to the same protocol and the same order.
- `CodeRun` is the lock of a run, `CodeBest` that of the best code of a block.
- `RoomLock` (`unique` per room) is the lock of a room's blocks and of the run start.
  - `#exclusive` in the hub takes it in a renewed transaction, performs the operation and writes it back.
  - Another web process waits up to 60 s for it.
  - The operation's writes lie outside the lock's transaction: it serializes, but does not make
    the operation atomic.

**Uniqueness**
- `unique`, for example on `CodeRun.session` or `LlmCall.callId`, prevents contradictory writes, also in open
  transactions.
- It protects entries, not arbitrary multi-step business rules or effects at the provider.

**Consumption**
- Completed calls get their own consumption entries (Spend). A request entry consumed on completion
  is not suitable as a counter.
- Counting first and then starting is not an atomic admission.

**Identifiers:** identifiers are collision-resistant across processes (random part). Logical call identifiers remain stable
across repetitions.

A waiting `take` stays in the Space, even if the client loses the connection or the Space restarts, until its
deadline or its transaction ends. An orderly shutdown aborts open transactions so that orphaned waiters
take no later work. After a hard crash, only the expiry of the lease helps.

## Runs

`server/run.ts` and `server/agent-host.ts` implement both run kinds with these entries:

| Entry | Purpose |
|---|---|
| `CodeRun` | The active run of a room (`unique` per room): parameters, displayed info, progress per generation or state of the board (`board`: phase, open work items of the phase, counters, improvement rounds, merged pairs, limit reached) and the number of open work items (`pending`). At the same time the run's lock. |
| `AgentSlot` | One slot per agent; an agents process holds it in a renewed transaction as long as it works as this agent. |
| `WorkItem` | A work item: turn (`turn`) and barrier (`barrier`) for generations; research, proposal, vote, implementation, critique, revision, merge, check and follow-up item on the board. With due time, attempts and deadline. |
| `AgentBusy` | Only for runs from before `pending`: a separately leased marker, written before an agent takes a work item. |
| `CodeRunDone` | How the last run of a room ended. |

**Flow of a work item.** A transaction takes the work item, asks the model process, writes the result, changes
`CodeRun` and writes the follow-up items. The phase change of the board is made by whoever
completes the last work item of a phase, in the same transaction. Once the run has used up its budget, the board opens no new phase, and the
open work items run out.

**Run end.**
- `pending` counts the written work items that are not yet done. It changes in the same commits that
  write and complete work items; a waiting work item that goes back stays counted.
- An agent that finds nothing more ends the run under its lock if `pending` is 0 and no work item is
  visible. A work item that another agent is holding at the moment thus counts too.
- Busy markers are not needed for this; a waiting agent no longer writes any.
- Runs from before `pending` end as before: no visible work item, no busy marker.
- If a barrier fails three times, the run ends with a note in its info.

**Barrier.** It waits until all turns of its generation are done and all submitted contributions are judged, and then opens
the next generation.
- It looks again after 2 and then every 4 s; each look is a commit.
- Once all turns are done, it waits for the verdicts at most `CODEMODE_VERDICT_WAIT_S`. Without this variable that is
  the maximum time of a judge plus 150 s, for text answers 10 min.
- Afterwards it continues without the missing verdicts and notes this in the run's info, for example if no judge process
  is running or a verdict was lost.
- The follow-up item of a contribution on the board has the same deadline.

**Limit and depth.** The board takes at most `max(12, agents × generations × 4)` work items and follows at most 12
levels deep. Judges and the follow-up item of a submitted contribution are exempt from the limit: they are bounded by the
contribution (two judges, one follow-up item), and without them a paid answer would remain unjudged.

**Judge and sandbox.** The sandbox holds the judge's thread while a case runs; during that time it renews nothing.
Its lease is therefore by default the highest time limit of a task (`CODEMODE_MAX_TIMEOUT_S`) plus 30 s.

**Leases and slots.** The leases of slot and work item are 60 s by default (`CODEMODE_AGENT_LEASE_MS`). An
agents process has up to 16 active slots (`CODEMODE_AGENT_SLOTS`). That is a per-process limit.

Work items with `onlyBy` (turns, the opening work items of the board) wait for the slot of their agent. If the agents
of all runs exceed the slots of all agents processes, such work items stay put. After 15 s the page says in the run's note
how many agents are waiting for a slot.

**Error of a work item.**
- A caught error allows **three attempts in total**, each with a new call identifier.
- Afterwards the work item counts as done without submitting.
- If the models' daily budget is used up, the run ends as "budget used up".
- Hard crashes during a model call count through `ItemStart`: after two, the work item is given up.

## Model calls, context and budgets

**Call by an agent.** An agent writes `LlmCall` outside its transaction, with a fixed `callId` made of
work item and attempt and `unique` on it. It takes the `LlmResult` in its transaction, in steps of at most 20 s,
in total at most `CODEMODE_MODEL_WAIT_S` (default 600 s). If the transaction aborts, the result stays for the
next attempt. If the agent gives up waiting, it takes back its not yet collected `LlmCall`, so that
nobody pays for an answer that nobody collects.

**Execution in the model process.**
- It takes `LlmCall` in a transaction (lease 30 s, renewed every 10 s), builds the context with `server/context.ts`, calls the
  model and writes `LlmResult` (retained 10 min).
- For a visitor it writes in the same commit a `Spend` entry with day identifier (retained 26 h).
- Requests live as long as the wait time plus 60 s.

**Double costs.** This avoids many duplicate calls, but does not guarantee that a repetition costs nothing: a
provider can complete and charge a call before the model process crashes without committing its result.
This needs idempotence at the provider or an explicit rule for uncertain results.

**Context of a generation.** Role and goal of a turn are fixed when the generation is opened. The model process reads the
remaining context (attempts, notes, rejected contributions, best result) only at the call. Agents of the same
generation can therefore see different context. The same starting context for all would need an immutable
generation context or versioned references.

**Model info and admin.** `ModelInfo` publishes the available models, `CodeAdmin` the admin's choice and
switch. The model process reads both every 10 s and before every real call. That is no hard guarantee of 10 s under
disturbances.

**Creating a task.**
- The web process writes a `TaskRequest` with deadline (`CODEMODE_MODEL_WAIT_S`, for all calls together) and the
  caller's data.
- An agents process that handles up to two requests at the same time asks no model after the deadline and
  answers with what it has. Criteria then remain unchecked, a check rule is omitted.
- The web process waits up to the deadline plus 60 s.
- A visitor's calls count against their daily budget. If it is used up, the web process rejects the task before the
  first call.

**Booking consumption.**
- `metered` (`server/llm.ts`) counts in the model process every paid call, even if the work fails afterwards: an
  empty answer, code that `sourceProblem` rejects, a research without hits after the first query.
- A `LlmResult` carries this consumption even on an error.
- The agent books it to the run in the commit that takes the `LlmResult`, successful or not. This way every call is
  booked exactly once, also across aborts and repetitions.
- For a visitor the model process writes `Spend` as soon as consumption arose; creating a task included.
- A block's cost display includes contributions, research, critiques, proposals, votes, verdicts (active block) and
  the work of the verifier agent.

**Run budget: admission before the call.**
- Before every model call of a work item (`ask` in `run.ts`), a separate, immediately committed transaction under the
  run's lock checks: booked consumption plus the reservations of the running calls must be below the budget (tokens
  and dollars).
- Then the call reserves its estimate in `CodeRun.reserved`, kept per work item. The estimate is the
  average of the run's calls booked so far, before the first 4000 tokens and no dollars.
- Every booking of the work item releases its reservation. A work item that comes back after a crash finds its
  reservation again and goes on without a new one.
- If the budget does not suffice because other calls are running, the work item waits 2 s; that does not count as a failed attempt. If
  the booked consumption alone reaches the budget, the run ends as "budget used up".
- Overshoot: at most the estimate of one call plus its error. Without a budget (admin without limit) the admission is omitted.

**Limits as they apply today (fixed on 2026-10-21):**
- *Run budget:* hard except for the overshoot named, for the whole run across all processes.
- *Daily budget of an address* (`CODEMODE_TOKENS_PER_IP_DAY`):
  - soft. The model process checks the `Spend` sum before the call, without reserving.
  - Overshoot by at most the calls that run at the same time (`CODEMODE_MODEL_PARALLEL` × model processes).
  - A day is the UTC calendar day (`today()`).
- *Calls per minute and day* (`CODEMODE_LLM_PER_MIN`, `CODEMODE_LLM_PER_DAY`): hard and shared for all
  model processes.
  - `takeQuota` (`server/quota.ts`) admits one use after the other per limit, under a `QuotaLock`.
  - Every admitted use is a `QuotaUse` entry, counted per minute and per UTC day in the same transaction.
  - A full minute waits for the next, a full day is an error ("daily model budget used up").
  - Counting happens before the call; a call that then fails counts too.
- *Web searches per day* (`CODEMODE_SEARCH_PER_DAY`): likewise, as a shared counter across all model processes and restarts.
- *Admin sessions:*
  - They are `AdminSession` entries with the session's lifetime (12 h).
  - The entry contains the SHA-256 of the cookie, not the cookie.
  - Every web process recognizes them, a restart keeps them, a logout ends them everywhere.

**Open:**
- Uncertain costs after a crash: if the model process dies after the provider's answer and before its commit,
  the call is repeated and paid twice, but booked only once. This would need idempotence at the provider.

## Durable code agents

Code contributions (`contribute`) use a pi-durable worker by default.
`CODEMODE_DURABLE_AGENT=0` switches back to the previous single model call.
`CODEMODE_CHAT_LLM=1` remains a prerequisite for real models; the durable runtime activates no
paid models. Text answers, votes, critiques and verifier calls remain unchanged.

```sh
CODEMODE_CHAT_LLM=1 npm --prefix codemode-chat run model
```

The default path is `codemode-chat/.local/codemode-agent.sqlite`; if `CODEMODE_SQLITE` is set, instead
`codemode-agent.sqlite` next to this Space file. `CODEMODE_DURABLE_STORE` overrides the path.
The Compose model service keeps `/data/codemode-agent.sqlite` in its own volume `codemode-agent-data`;
the dev container uses its existing `/data` volume.
The agent store runs with WAL/`synchronous=FULL`; directory entries are synchronized as well.
The [power-failure acceptance](agenten-stromausfalltest.en.md) remains separate despite this stronger write policy.

The shared persistent Space has capacity limits independent of this:
`CODEMODE_MAX_CLAIM_MIB` (default 1024 MiB) and `CODEMODE_MAX_DOC_MIB` (default 1280 MiB).
They must be positive integers; the document limit must lie above the claim limit.
The previous 512/640 MiB no longer sufficed on nano for the existing claim history.
The higher limits make room for new requests without deleting existing claims or shortening their
idempotence deadlines. They are set before the socket is opened and apply only to
the SQLite Space, not to memory tests or the separate agent store. Model, visitor
and run budgets do not change as a result. Values can be set in the codemode `.env`;
Compose passes them on to the Space process. This is no unlimited history strategy:
claim occupancy and free disk capacity must still be monitored.

The integration lives in [durable-agent.ts](../codemode-chat/server/durable-agent.ts).
The application imports only a [Node IPC client](../agent/src/durable-client.ts);
pi-durable and Chord stay in the [agent process](../agent/src/durable-worker.ts). The import boundary of the
Space core and its tests without Earendil dependencies remain in place.

- `LlmCall`/`LlmResult`, run control and final judging remain in the Space.
- Conversation and input snapshot belong to the stable work item ID. A repetition after a crash uses
  the same submission and the first stored context, not team data that has changed in the meantime.
- With `verify_code` the agent can test and correct its function in the existing isolated sandbox.
  There are no shell, file or general coding tools.
- At most four model attempts per work item, at most 1500 output tokens per attempt. SDK/harness retries and
  automatic compaction are switched off; this creates no unchecked additional model calls.
- Before each attempt the model process checks run, model release, visitor budget and shared call quota again.
  For budgeted runs, the existing work item reservation is extended by the agent consumption not yet booked
  plus one further call estimate. Other running reservations still count.
- The agent store also preserves the consumption before an error/restart; `LlmResult` returns the total.
  Booking still happens once, in the work item's Space transaction.

A store has exactly one worker owner. Several model processes each need their own,
durably mounted store path; the Space queue remains their shared distribution.
A local agent store is no distributed conversation replication.
Aborting stops further attempts, but guarantees no refund of a model request already sent.
The sandbox regression and reopening are tested in [durable.test.ts](../codemode-chat/tests/durable.test.ts).
Test models (`CODEMODE_DURABLE_MODELS_MODULE`) are permitted only with `CODEMODE_TEST=1`.

## Interactive execution (▶)

- **web process:**
  - It writes an `ExecRequest` (room, contribution, optional call).
  - It takes the run's `ExecEvent` entries in the order of their number and streams them as NDJSON.
  - If the page closes the request (Stop), it writes `ExecStop`.
  - It counts one ▶ at a time per address locally.
- **judge process:**
  - It takes requests in a loop of its own when one of its two runners is free; the checks run separately
    from it.
  - It reads code and task itself from the Space (`execTarget` in `room.ts`): source text and large cases do not fit
    together into one entry.
  - It writes the events in batches every 100 ms, or earlier at 32 KiB.
  - `ExecStop` aborts the run. While it runs, it holds an `ExecRun` entry.
- **No judge:** if nobody takes the request within 10 s, the web process withdraws it and answers with 503.
- **Judge goes silent:** if the events fail to appear, the stream ends with an error after the maximum duration of a run plus 30 s.
- **No restart:** a run whose judge dies is not repeated; it is interactive and rates nothing.

## Snapshots, retention and recovery

The web process follows `changes` by long poll and sends debounced snapshots.

- **Reading:** a snapshot consists of several typed, bounded reads. It limits the source text sent along; the rest is
  loaded per contribution.
- **Consistency:** these reads do not form an atomic snapshot, a concurrent commit can yield a mixed
  view. That the run is read before the messages helps the normal display of the run's end, but yields
  no general consistency.
- **Decision open:** either explicitly choose "eventually consistent with renewed fetch" for the interface, or build a
  read protocol that pins a revision. Before further optimization, measure bytes, number of queries and latency over TCP.

Entries of a room live for one year by default (`CODEMODE_TTL_HOURS`, 8760 h); 0 keeps them until deletion. A
human extends a block (⟳, `Hub.extendBlock`: every lease of its entries is renewed, the `CodeTask` carries the
new end `until`) or deletes it. Expiry of individual
entries is not the same as inactivity of the room: tasks, verdicts, references to the best result and the work
of a run can expire at different times.

| Failure | Limit of recovery today |
|---|---|
| Crash of a worker process | Uncommitted takes come back after the transaction expires; another process carries on as long as the necessary entries exist. External work may repeat. |
| Restart of the Space with intact SQLite file | The state is reopened; clients reconnect, leases and deadlines determine what stays available. Runs continue (tested). |
| Space host unreachable | All roles depend on the same Space and can do nothing shared. |
| Loss of storage or outage longer than the retention | Transactions alone do not restore lost or expired state; backup, restore and a retention rule are needed. |

Decide before production operation:

- which duration of interruption is supported; it determines how long dependencies of active runs and entries for
  deduplication are retained;
- how references are handled whose target has expired;
- how orphaned requests are cleaned up.

High availability of the Space itself does not result from the split into processes.

## Open corrections

**1. Budgets:** see "Limits as they apply today" and "Open" above.

**2. Running model calls at Stop.** A call that the model process is already executing at Stop runs to completion and is
paid; nobody collects its result. It could be cancelled only with an abort signal to the provider.

**Done on 2026-10-21:**
- Several model processes: one `ModelInfo` per process, merged; a held call comes back after at most 30 s.
- Hard crashes count:
  - A judge dying during the check leaves a `JudgeStart` marker. After two such, the
    candidate gets a failed verdict.
  - An agent leaves `ItemStart` during a model call. After two such, the work item is given up.
  - An orderly end removes the markers.
- The `CodeJudging` marker is renewed as long as the judge checks.
- Agents without a free slot are shown by the page after 15 s in the run's note.
- Consumption of a successful call whose work item then fails at something else is booked with the failure.
- Run end from durable progress (`pending`).
- Expired waiting no longer counts as "gone" (`readExisting`/`takeExisting`).
- Cleanup at Stop:
  - A work item that comes back after the end of its run is removed.
  - The model process no longer executes a call of an ended run.
- No busy markers when idle.
- Waiting without a transaction when idle (`awaitWork` in `server/space.ts`, 2026-10-22):
  - Judge, agents, model and the ▶ execution wait with a `read` without a transaction until work is there (up to
    60 s, `CODEMODE_IDLE_WAIT_MS`). Only then do they begin the transaction and take without waiting; if another
    process was faster, the round starts anew.
  - Before, every round cost three claims every 5 s (transaction, waiting `take`, abort). Measured with the stack
    of the local test environment: 23,800 claims per hour when idle, now 3,480. Of these, about 2,100 are the
    heartbeats of the six processes.
  - An ended process does not wait for its `read`; the Space discards it at its deadline. A `read` holds
    nothing, so it cannot catch work for a process that no longer exists.

## Migration map

| Area | Status / what remains | Stage |
|---|---|---|
| Active block in the hub | Read from the Space on every access. | 2d ✓ |
| Best code | `CodeBest` points to a verdict; recomputation after a veto under the `CodeBest` lock. | 2a ✓ |
| Answer of a text task | Derived from `TextAnswer`, `TextJudgement` and `CodeAccept`. | 2d ✓ |
| Runs, stop, parameters | `CodeRun`; generations and board in the agents process. | 2b–2d ✓ |
| Run end and errors | Deadlines for verdicts; end from `pending` under the run's lock; Stop cleans up. | 2d ✓ |
| Creating a task | `TaskRequest`/`TaskReady` with deadline and the caller's data. | 2d ✓ |
| Room lock | `RoomLock` in the Space; `#exclusive` takes it. | 2d ✓ |
| Admin's model choice | `CodeAdmin`; the model process is the only caller. | 2c ✓ |
| Limits per minute and day | `QuotaLock`/`QuotaUse`, shared for all model processes. | 3 ✓ |
| Visitors' consumption | `Spend`; soft (see "Limits as they apply today"). | 3 ✓ (soft) |
| Daily search counter | Shared counter (`QuotaUse`, key `search`). | 3 ✓ |
| Admin sessions | `AdminSession` entries with lease. | 3 ✓ |
| HTTP and room limits | Deliberately per web process (protection of the connection, no quota). | 3 ✓ |
| Interactive execution (▶) | Judge takes `ExecRequest`, writes ordered `ExecEvent`s; web follows, `ExecRun` tracks. | 3 ✓ |
| WebSocket clients, push timers | Remain process-local. | — |
| Docker | One service per role, scripts, help, README; profiles `nano`/`big`, local test environment. | 4 ✓ |

## Performance and deployment

- **Local and global limits.**
  - The request limits deliberately stay per web process: requests per minute and address (`CODEMODE_REQ_PER_MIN`), the
    login attempts, the limits per room (runs, tasks, notes and the like per minute) and one ▶ at a time per address.
  - They protect the process and its connection, they are no quota. More web processes increase their sum.
  - Whatever costs money is limited jointly: model calls, web searches, run and daily budget.
- **Same peer.** All processes connect as the same peer. The host raises the per-owner limits
  (transactions, waiters, registrations) for this. For production operation, define capacity and separation of the roles.
- **Size limits.** 64 KiB per entry and 192 KiB per commit continue to apply. Source text is additionally limited to 40 kB as JSON.
  Budget the whole transaction, with verdict and archive, not only the source text.
- **Placement.** Space on nano and most of the computing on big is a proposal. Judge placement, services per
  role, restart rules, storage and recovery will be decided in stage 4.

## Operation with Docker

One image (`codemode-chat/docker/Dockerfile`, target `production`) contains all roles; without a command it starts all of them in one
container (`server/launch.ts`). `docker/docker-compose.yml` instead starts one container per role.

| Profile | Containers | Machine |
|---|---|---|
| `nano` | `space` (SQLite in the volume `codemode-space-data`, TCP 3800), `judge-nano` | nano: holds the state |
| `big` | `web` (3700), `judge-big`, `agents`, `model` (the only one with credentials) | big: does most of the work |
| `dev` | `codemode-chat-dev`: all roles in one container, sources mounted, restart on changes | development |
| `test` | `codemode-chat-test`: the test suite | — |

The roles talk to each other only through the Space, over TCP. On two machines big sets `CODEMODE_SPACE=tcp:<nano>:3800`,
and nano publishes the Space on its internal address (`CODEMODE_SPACE_BIND`). The socket has no TLS and treats
every connection as a process of the chat: never on a public interface.

Scripts in `codemode-chat/package.json`: `docker:nano:*` (on nano), `docker:big:*` (on big, with
`docker-compose.hostnet.yml`: host network, web only on `127.0.0.1`, the Space comes through the SSH tunnel), `docker:local:*`
(both on this machine), `docker:rust:*` (the same local test environment with the Rust Space server
(`phi-space-server --profile codemode`) in the Space containers, `docker/docker-compose.rust.yml`, after `docker:image:rust`),
`docker:dev:*`, `docker:test`. `docker:prod:*` is now only a pointer to the other scripts (it ends with an error): both profiles on one
server collide on the tunnel port. On the servers, `git pull` and then `npm --prefix codemode-chat run
docker:nano:up` or `docker:big:up` suffice; the images are built on the host network (rootless Docker on nano cannot reach the npm registry from the
default network).

**Backup and restore of the Space:**
- `server/backup.ts` writes a consistent copy of the SQLite storage during operation (`VACUUM INTO`, one
  read transaction; the storage is in WAL mode, the Space keeps writing).
  - In Docker: `npm --prefix codemode-chat run docker:backup` writes to `/data/backups` in the volume.
  - The newest `CODEMODE_BACKUP_KEEP` are kept (default 7).
  - Fetch from the machine with `docker compose cp space:/data/backups <directory>`.
- `server/restore.ts --from <file> --yes` puts a copy in place of the storage.
  - Only with the Space stopped. It refuses if the Space socket answers or another process has the storage
    open; it detects the latter also across container boundaries, where it cannot see the socket.
  - Without `--yes` it only says what it would do.
  - The previous storage stays with its WAL files as `<storage>.before-restore-<time>`.
  - In Docker: `docker compose … --profile nano stop space`, then
    `docker compose … --profile nano run --rm --no-deps space node --experimental-strip-types server/restore.ts --from /data/backups/<file> --yes`,
    then `start space`.
- Not automatic: when backups are made (cron or timer on nano) and where the copies leave the machine is a
  decision of operations.
- Checked on 2026-10-21 in the local test environment:
  - Backup during operation.
  - Restore with the Space stopped; afterwards all contributions were back.
  - A restore with the Space running was rejected.

**Local test environment big/nano on one machine:**
- `npm --prefix codemode-chat run docker:local:up` starts both profiles under the project name
  `phi-spaces-codemode-local`: web on port 3710, Space only on 127.0.0.1:3810.
- All roles talk to the Space over TCP in the Docker network, just like between the real machines.
- The system bar shows the machines "big" and "nano"; nano's containers get 2 CPUs (`NANO_CPUS`).
- This allows playing through failures: `docker restart` of the Space (nano's state), `docker kill` of a judge or
  the agents process.
- It does not simulate network latency between the two.
- Checked on 2026-10-21:
  - A script run with 3 agents was judged by judges on both sides (4 verdicts from big, 2 from nano).
  - After a restart of the Space container all contributions were still there, the processes reconnected by themselves, and
    a new contribution was judged.

## Stages and history

Each stage should keep the application runnable, tested and committed individually. Pushes only after asking.

1. **One Space, separate processes for space, judge and web: implemented.**
   - `space-host.ts`, `judge-host.ts`, `launch.ts`, `space.ts` and the transactional result/archive in `results.ts`.
   - `CodeJudging` keeps a contribution visible as long as its candidate is taken.
2. **Runs and agents in the Space: implemented.**
   - 2a: task data out of the candidates, source text out of `CodeBest`.
   - 2b: generations, slots and barriers.
   - 2c: the model process.
   - 2d: board, text, research and the creation of tasks in the agents and model process.
   - Corrections of 2026-10-21: barrier deadline, verdicts without a stored result count for the run, held
     CodeTask at the judge, judges beyond the limit, budget and deadline when creating a task, taking back
     abandoned calls.
   - Further corrections of 2026-10-21:
     - Run end from `pending`;
     - holds beyond the wait time do not count as deletion;
     - Stop cleans up work items and waiting calls.
   - Room lock through the Space (`RoomLock`).
   - The corrections above remain open.
3. **Limits, sessions and interactive execution: implemented.** Shared counters, admin sessions and ▶ in the
   judge process.
4. **Operation: partly implemented.** Docker per role, profiles `nano`/`big`, local test environment, systemd example with
   `launch.ts`, backup and restore of the Space. Open: schedule and target of the backups, retention periods, capacity per
   role.

Notes from the migration:

- An orderly shutdown must abort open transactions, including waiting `take`s; disconnecting is not
  enough.
- The socket error "ahead of this stream" contains no revision; successful reads of the change stream deliver
  the current one.
- Tests start the Space and worker processes with `tests/stack.ts`. Fake model teams come from `tests/fakes.ts` through
  `CODEMODE_LLM_MODULE`, only with `CODEMODE_TEST=1`. `FakeCall` records the context seen, `FakeGate` can hold a
  call.
- These tests prove no exactly-once execution at a real provider.

## Test priorities

Tested are:

- restart of all processes during a run (board and generations);
- a stopped run across a restart;
- death of a judge or agents process;
- failed attempts and used-up daily budget;
- barrier without verdicts;
- limit of the board;
- budget and deadline when creating a task;
- a `CodeRun` that stays held longer than `HELD_WAIT_MS`: all agents stay, the run ends once;
- Stop while calls are running and waiting: no work items are left, the waiting call is not made;
- rejected outputs book their consumption to the run and to the address;
- overlapping agents do not exceed the run budget;
- an operation waits as long as another process holds the room's lock;
- a candidate after two dead judges, a work item after two dead agents processes (marker given);
- the check marker outlasts its first lease;
- agents without a slot are displayed;
- two model processes: the page sees their models once, if one dies, the other answers the calls;
- a shared counter admits, for concurrent requests from three clients, exactly its number of uses;
- an admin session is valid in a second web process and ends there with the logout;
- ▶ runs in the judge process, Stop ends it there, without a judge 503 comes.

The earlier case "busy marker expires while its transaction lives" is dropped with `pending`.

Still without a test, each to be introduced with the corresponding correction:

- A provider answers before the process dies without a commit; repetition and uncertain costs follow the rule
  that has been fixed.
- Recovery close to the retention periods.
- Several web processes change the same room concurrently with real operations (the test holds the lock only from outside).

Standard checks: in the root directory `npm run typecheck` and `npm test`, for the application additionally
`npm --prefix codemode-chat run typecheck` and `npm run test:codemode-chat`.
