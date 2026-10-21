# Codemode Chat: shared-space architecture (2026-10-21)

## Purpose and current status

The target architecture keeps all shared application state in one phi-spaces Space. Each process owns a role and
communicates with the other roles through `SpaceLike`, over a Unix socket locally or TCP between hosts. Process-local
resources may be recreated; decisions that must survive a restart belong in the Space.

**Implemented through stage 2c:** separate space, web, judge, agent and model processes; transactional judging;
Space-backed generation runs with scripted or model agents; model requests and results; visitor usage records for
those model requests; model discovery and admin selection through the Space.

**Still being migrated:** the web process retains its session table, work-board runs, text tasks, research, and task
creation with generated check rules and criteria. Model limits per minute and day remain local to each model process.
Admin sessions, HTTP request limits and interactive execution (▶) are not yet fully moved to the target architecture.
The model process is therefore not yet the exclusive caller of models or the only process needing model credentials.
Docker still describes the earlier server layout and requires stage 4 adaptation.

This status describes the completed stage 2c migration. Stage 2d is being developed concurrently: request/context
support for additional model operations is appearing in the working tree. That support alone does not establish
that the corresponding web workflows have migrated or that the open correctness issues below are resolved.

The guarantees below distinguish current behavior from required corrections. Moving data into the Space alone does
not provide exactly-once external execution, a consistent snapshot, or atomic budget enforcement.

## State and process-local resources

Shared state includes tasks, contributions, verdicts, best-result references, runs, work items, usage, budgets and
admin sessions. Process-local caches of that state must be reconstructible and must not independently authorize work.

Open sockets, WebSocket clients, snapshot debounce timers, local sandbox slots, and loaded model registries and
credentials are process-local resources. Their loss is expected on restart. Credentials are supplied by deployment
configuration; they are not stored as ordinary Space entries.

A local concurrency or request limit applies **per process**. A limit intended to apply across the installation needs
shared coordination. Calling a counter a resource does not change the scope of the limit.

## Processes and connections

Paths in this document are relative to `codemode-chat/` unless stated otherwise.

| Process | File | Current role and target |
|---|---|---|
| space | `server/space-host.ts` | Hosts the SQLite-backed Space and exposes it through `serveSpace` at `CODEMODE_LISTEN`. |
| web | `server/index.ts` | Serves Next.js, REST and WebSocket; reads rooms and submits work. Still owns the unmigrated workflows listed above. |
| judge | `server/judge-host.ts` | Takes `CodeCandidate` transactionally and publishes `CodeScore`, best-result and archive changes in the same transaction. Interactive execution is planned for stage 3. |
| agents | `server/agent-host.ts` | Claims agent slots and processes generation work. Work-board and task-creation workflows are planned next. |
| model | `server/model-host.ts` | Handles generation contribution requests, publishes model information, reads admin choices and records visitor usage. Eventually handles all model calls. |

Clients connect through `CODEMODE_SPACE`, for example `unix:/tmp/codemode-space.sock` or `tcp:host:3800`.
`server/launch.ts` starts all five roles by default; `CODEMODE_ROLES` selects the roles on a host. From `codemode-chat/`,
`npm run dev` starts development processes and `npm start` starts production processes. The launcher starts the Space
first and restarts children that exit unexpectedly.

Each process publishes a `Process` entry with its role, process identity and host facts (CPU and total memory, not
live process utilization). Its 30-second lease is renewed every 10 seconds. The system bar uses these entries for
presence. Placement on big/nano remains a stage 4 deployment decision.

## Transaction and coordination patterns

- **Claim and publish:** take a work entry in a transaction, perform the work, write its result and follow-up entries,
  then commit. Long work renews the transaction lease. If the transaction aborts or expires, its uncommitted changes
  are rolled back and the claimed entry becomes available again, provided its own lifetime has not ended.
- **External execution:** the transaction makes Space changes atomic; it cannot roll back an HTTP request, model
  charge or other external side effect. Work may execute again after a crash. Stable request IDs and retained results
  reduce repetition but do not guarantee exactly-once execution at an external provider.
- **Wait:** use blocking `take`/`read` or `changes(rev, {waitMs})`. Server wait periods must remain below the client's
  call timeout, with room for transport overhead. A client timeout may leave the outcome unknown; it is not proof
  that a mutation failed.
- **Held entries:** normal reads and counts cannot see entries taken by another transaction. `readIfExists` and
  `takeIfExists` with `HELD_WAIT_MS` wait for a held match, but also return `null` when the wait expires. A `null`
  result is therefore not sufficient evidence of deletion. Current callers still need correction for this case.
- **Mutex entries:** a shared lock can be implemented by taking an entry transactionally and writing it back with the
  protected updates. All writers must follow the same protocol and lock order. `CodeRun` currently serves this purpose
  for run updates. A shared `CodeRoom` lock is a migration target: the hub's `#exclusive` still uses a local promise
  chain and does not serialize different web processes.
- **Uniqueness:** `unique`, for example on `CodeRun.session`, prevents conflicting writes including those in open
  transactions. It protects entry uniqueness, not arbitrary multi-step business invariants or provider side effects.
- **Usage:** retain separate usage events for completed calls and separate reservations for admitted work. A request
  entry that is consumed on completion cannot also serve as a historical usage counter. Checking a count and then
  starting work is not atomic admission control.
- **Identifiers:** use collision-resistant IDs across processes and stable logical request IDs across retries.

A waiting take can persist in the Space across client disconnection and a Space restart, until its deadline or
transaction lifetime ends. Graceful shutdown aborts outstanding transactions so abandoned waits do not claim later
work. After a hard crash, recovery depends on lease expiry.

## Generation runs

`server/run.ts` and `server/agent-host.ts` implement generation runs using these entries:

| Entry | Purpose |
|---|---|
| `CodeRun` | Unique active run per room, parameters, displayed information and generation progress; also the run-update mutex. |
| `AgentSlot` | One slot per agent, held in a renewable transaction while an agent process serves that run. |
| `WorkItem` | A contribution turn or a generation barrier, including scheduling and retry fields. |
| `AgentBusy` | Separately leased marker published before taking work. Currently also used in completion detection. |
| `CodeRunDone` | Retained information about the last ended run in a room. |

A work transaction consumes its item, publishes a contribution, updates `CodeRun` and writes any follow-up work.
A barrier waits for the generation's turns and required verdicts before opening another generation. In the current
implementation, barrier rechecks are delayed by 2, 4, 8, then 10 seconds repeatedly; each recheck commits a change.

The defaults are 60 seconds for slot and item transaction leases (`CODEMODE_AGENT_LEASE_MS`) and 16 active slots per
agent process (`CODEMODE_AGENT_SLOTS`). These are configurable defaults, not installation-wide concurrency limits.

Caught work failures allow **three total attempts**, not three retries after an initial attempt. After exhaustion,
a turn advances the generation's done count without handing in a contribution. Hard process crashes do not currently
increment this retry count. Exhausted barrier failures also lack an explicit failed-run outcome.

The current idle-completion path checks for visible `WorkItem` and `AgentBusy` entries, then consumes `CodeRun` and
writes `CodeRunDone` and a closing line. Stop also consumes `CodeRun`. This does not cancel an already-started external
model call. Idle completion needs a stronger invariant: a busy marker and its work transaction expire independently,
so an invisible held item may outlive its visible busy marker.

**Required correction:** decide completion from durable progress under the run lock: all scheduled work has reached a
terminal state, required verdicts are accounted for, and no next generation remains. Keep `AgentBusy` for display and
observability. Persist attempt starts and terminal failure reasons so repeated crashes and failed barriers are visible
and bounded. Define cleanup of outstanding model requests and late results when stopping a run.

## Model requests, context and budgets

An agent writes `LlmCall` outside its work transaction, using a stable `callId` derived from the work item and
`unique` on that ID. It takes the corresponding `LlmResult` inside its work transaction, waiting in chunks of up to
20 seconds, for at most `CODEMODE_MODEL_WAIT_S` (default 600 seconds). Aborting the work transaction makes a taken
result available for another attempt while that result remains retained.

The model process takes `LlmCall` in a transaction, builds context through `server/context.ts`, calls the model and
publishes `LlmResult`. When usage is recorded for a visitor, the corresponding `Spend` entry is in the same commit.
The call transaction lease is 120 seconds and is renewed; results are retained for 10 minutes, and `Spend` entries
for 26 hours with an explicit day key. Request retention is the configured model wait plus 60 seconds.

This prevents many duplicate calls when a request or retained result can be reused. It does **not** guarantee that a
retry costs nothing: a provider may finish and charge for a call before the model process crashes without committing
its result. Provider-supported idempotency or an explicit policy for uncertain outcomes is needed to address that
window. Result expiry also bounds the deduplication period.

Role and target are selected when a generation opens. The rest of the model context (attempts, notes, rejected
contributions and best result) is read when the model process handles the request. Agents in the same generation can
therefore see different context. If identical starting context is required, persist an immutable generation context
or versioned references; fixing role and target alone does not provide it.

`ModelInfo` publishes available models. `CodeAdmin` supplies model selection and on/off settings. The model process
refreshes this information every 10 seconds and applies admin settings before real calls. This is not a hard
10-second propagation guarantee during failures.

**Budget enforcement remains incomplete:** multiple workers can pass the same usage check before any of them records
new usage. Run budgets likewise do not reserve the cost of outstanding calls. Moreover, the current model path
assigns returned usage only after validating the generated source, so a rejected source can leave paid usage
unrecorded. Minute/day model counters are still local to each model process.

**Required correction:** atomically reserve an allowance before an external call, then reconcile it with actual usage,
including failed or rejected outputs. Specify how uncertain charges are handled after a crash. Use separate entries
for requests, reservations and usage; do not count consumed `LlmCall` entries as completed calls. Define whether each
limit is per process or global, whether it is hard or soft, and whether a day means a calendar day (including timezone)
or a rolling 24-hour window.

## Snapshots, retention and recovery

The web process follows `changes` using long polling and pushes debounced snapshots. A snapshot currently uses
multiple typed, bounded reads, not a single untyped `readAll`. It already limits included source code and supports
fetching code separately. These reads do not form one atomic snapshot: a concurrent commit can produce a mixed view.
Reading the run before messages helps the normal end-of-run display, but does not establish general snapshot
consistency, especially when reads time out or retained entries expire.

For the UI, explicitly choose eventual consistency with another refresh, or implement a read protocol that pins a
revision. Measure bytes, query count and latency over TCP before further optimization. Preserve the distinction
between display consistency and the stronger invariants needed for work admission and completion.

Room entries default to a 24-hour lifetime (`CODEMODE_TTL_HOURS`); zero keeps them until deletion. Individual entry
expiry is not the same as room inactivity expiry. Related tasks, scores, best-result references and run work can
have different expiration times. Recovery must account for those dependencies.

| Failure | Current recovery boundary |
|---|---|
| Worker process crash | Uncommitted claims can return after transaction expiry; another worker can continue while the required entries still exist. External work may repeat. |
| Space process restart with intact SQLite store | Persisted state can be reopened; clients reconnect and leases/deadlines still govern what remains available. |
| Space host unavailable | All roles depend on the same Space and cannot continue shared-state operations. Worker replication does not remove this dependency. |
| Store loss or outage beyond retention | Worker transactions alone cannot recover lost or expired application state. Backup/restore and retention policy are required. |

Before production, define the supported interruption duration and retain active-run dependencies and deduplication
records accordingly. Define handling of references whose targets have expired and cleanup of abandoned requests.
High availability of the Space itself is not implemented by this application's multi-process layout.

## Remaining migration map

This table describes targets, not claims that every listed transition is complete.

| Area | Target / remaining work | Stage |
|---|---|---|
| Hub `Session.task`, `blockId` | Read the selected/latest task from Space state; remove authoritative local copies. | 2d |
| Hub `best` | Reconstruct from `CodeBest` and its referenced `CodeScore`; currently still cached locally. | 1–2d |
| Hub `answer` | Derive from `TextAnswer`, `TextJudgement` and `CodeAccept`. | 2d |
| Hub run, abort, parameters, save/queue state | Generation runs migrated; move remaining board/text runs and control into the Space. | 2c–2d |
| Hub local serialization and session table | Shared room mutation protocol; reconstructible room reads instead of authoritative sessions. | 2d |
| Hub generations and idle loop | Work items and barriers implemented; strengthen completion and failure handling as described above. | 2b–2c |
| `board.ts` state, busy/end/cap tracking | Transactional `BoardState` and explicit durable work progress. | 2d |
| Task creation | `TaskRequest` handled by agents, with explicit success/failure results and bounded waits. | 2d |
| Admin model settings | `CodeAdmin` implemented for the model process; migrate remaining direct model paths. | 2c–3 |
| Model minute/day limits and visitor usage | Shared reservations and usage records; generation-path `Spend` exists but is not strict admission control. | 3 |
| Search daily limits | Separate retained search usage and admission state. | 3 |
| Admin sessions | `AdminSession` entries with leases. | 3 |
| HTTP and room request limits | Decide and document local connection protection versus shared quotas. | 3 |
| Interactive execution (▶) | Judge consumes `ExecRequest`, writes ordered `ExecEvent` entries; web follows results, with `ExecRun` tracking. | 3 |
| WebSocket clients and push timers | Remain process-local resources. | — |

The old nano shard, remote import/retrieval state, remote pending/polling state and related hub coordination were
removed in stage 1. Judges take work directly from the shared Space. Random IDs replace process-local sequencing
where cross-process uniqueness is needed.

## Performance and deployment decisions

- Reduce idle writes: agents currently create/cancel busy markers even when no due item is available. Combine change
  notifications with the next due time to avoid repeated scans and commits. Keep any replacement consistent with the
  completion protocol.
- Separate local protection from global quotas. A local HTTP limiter is suitable for protecting one web process;
  adding web processes increases its aggregate allowance. Measure Space commit cost before selecting a global quota
  representation; no universal commit-complexity claim is assumed here.
- All application processes currently connect as the same peer. The host raises per-owner transaction, waiter and
  registration limits accordingly. Define capacity and role isolation for production rather than relying only on
  larger shared limits.
- Retain the entry and commit size constraints: 64 KiB per entry, 192 KiB per commit. Source is also bounded by encoded
  JSON size (40 kB). Budget the complete transaction, including verdict and archive metadata, not source alone.
- Space on nano and most compute on big remains a proposal. Choose judge placement, role-specific services, restart
  policy, persistent storage and recovery procedures in stage 4.

## Delivery stages and implementation history

Each stage should keep the application runnable, be tested and be committed separately. Pushes require confirmation.
The existing Docker path is a known exception during migration and must be repaired before production rollout.

1. **One Space; separate space, judge and web processes — implemented.** Added `space-host.ts`, `judge-host.ts`,
   `launch.ts`, `space.ts` and transactional result/archive handling in `results.ts`. `CodeJudging` keeps a contribution
   visible while its candidate is taken. The web process follows changes from other processes.
2. **Space-backed runs and agents — partially implemented.** Stage 2a moved task data out of candidates and source out
   of `CodeBest`, which now references a verdict; commit-size failures are distinguished from expired transactions.
   Stage 2b added generation work, agent slots and barriers. Stage 2c added generation model calls through the model
   process. Stage 2d still needs board/text/research and task-creation workflows, shared room coordination and removal
   of authoritative hub sessions. The correctness corrections in this document remain open work.
3. **Limits, sessions and interactive execution — incomplete.** Finish shared admission and usage accounting, search
   limits, admin sessions and ▶ through the judge process.
4. **Operations — pending.** Adapt Docker images/services, scripts, help and README; settle big/nano placement and
   recovery requirements.

Implementation notes retained from the migration:

- Graceful shutdown must abort open transactions, including waiting takes; disconnecting a socket is insufficient.
- The socket error “ahead of this stream” does not include a revision. Successful change-stream reads supply the
  current revision for resynchronization.
- Tests use `tests/stack.ts` to start worker/Space processes. Fake model teams are supplied through `tests/fakes.ts`
  using `CODEMODE_LLM_MODULE`, permitted only with `CODEMODE_TEST=1`. `FakeCall` records observed context; `FakeGate`
  can hold a fake call. These tests do not establish exactly-once behavior at a real external provider.

## Validation priorities for the remaining corrections

Add focused failure/concurrency coverage as the corresponding fixes are implemented:

- A held `CodeRun` remains held beyond `HELD_WAIT_MS`; an agent must not treat the timeout as confirmed deletion.
- A busy marker expires while its work transaction remains active; the run must not finish prematurely.
- A provider succeeds before the worker dies without committing; retry/uncertain-charge behavior matches the stated policy.
- Concurrent workers approach a shared budget, and rejected model outputs still account for their returned usage.
- Repeated hard crashes and barrier failures produce bounded attempts and an explicit terminal outcome.
- A stopped run has queued or running model requests, and recovery occurs near retention deadlines.
- Multiple web processes mutate the same room; shared locking and task/run selection preserve their invariants.

Standard checks are `npm run typecheck` and `npm test` at the repository root, plus
`npm --prefix codemode-chat run typecheck` and `npm run test:codemode-chat` for the application.

## Stand nach Stufe 2d (2026-10-21)

Der web-Prozess ruft keine Modelle mehr auf und fährt keine Läufe mehr. Das Auftragsbrett läuft in `server/run.ts` als
Aufträge der Agenten (Recherche, Vorschlag, Abstimmung, Umsetzung, Kritik, Überarbeitung, Zusammenführung, Prüfung,
Folgeauftrag); sein Zustand (Phase, offene Aufträge der Phase, Zähler, Verbesserungsrunden, zusammengeführte Paare,
Obergrenze erreicht) steht in `CodeRun.board`. Den Phasenwechsel macht, wer den letzten Auftrag einer Phase erledigt, in
seiner Transaktion. Ein Modellfehler wird in der Transaktion des Auftrags behandelt: neuer Versuch mit neuer
Aufruf-Kennung (höchstens drei), aufgeben, oder bei verbrauchtem Tagesbudget Laufende als „Budget verbraucht“. Jeder
Agent beginnt auf dem Brett mit einer eigenen ersten Umsetzung. Eine von den Prüfern angenommene Antwort archiviert der
Agent, der ihr Urteil sieht; ein 👍 archiviert der web-Prozess.

Das Anlegen einer Aufgabe mit Modellen (Prüfregel, Kriterien und ihre Prüfung durch drei Agenten) schreibt der
web-Prozess als `TaskRequest`; ein Agenten-Prozess erledigt ihn (Modellaufrufe, Gegenprüfung der Regel in seiner
Sandbox) und antwortet mit `TaskReady`, auf das der web-Prozess wartet. Die Sitzung des web-Prozesses liest den aktiven
Block bei jedem Zugriff aus dem Space. `server/board.ts` ist entfallen.

**Bleibt (Stufe 3):** Modellgrenzen je Minute und Tag und der Suchzähler je model-Prozess, Admin-Sitzungen und
Anfragegrenzen im web-Prozess, ▶ im web-Prozess. **Stufe 4:** Docker je Rolle.
