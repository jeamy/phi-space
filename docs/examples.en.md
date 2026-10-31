# Examples: Implementation and Evidence

As of 2026-10-30. Authoritative entry point for the examples. The examples in `examples/` use **one
local harness per process and store**. Several conversations are not a federation; federated stages
exist only in the help system (v5/v6). The [federation plan v3](federation-plan-v3.en.md) is implemented; status and
evidence are in the [implementation status](implementierungsstand.en.md) and the [acceptance documents](_attic/abnahme/ap3-abnahme.en.md).

| Example | Implementation | Evidence and limit |
|---|---|---|
| Master/worker | [workers.ts](../agent/examples/workers.ts) | scripted write/take demonstration; no image resize, no crash reassignment |
| Blocking take | [blocking-tool.ts](../agent/examples/blocking-tool.ts) | scripted tool call; host later writes a job in the same process |
| Sensor pipeline | [sensor-pipeline.ts](../examples/sensor-pipeline.ts) | real functions, concurrency, lease expiry and rollback tested locally |
| Chat | [chat.ts](../agent/examples/chat.ts) | actual scripted ring tested; live mode (`--live`) present, not accepted |
| arXiv research | [arxiv-research.ts](../agent/examples/arxiv-research.ts) | actual runner tested with scripted model and JSONL; real source/model quality open |
| Dark-energy research | [dark-energy-research.ts](../agent/examples/dark-energy-research.ts) | actual runner including classification and abstract summary tested with scripts |
| Golomb | [golomb.ts](../examples/golomb.ts) | actual order-4 search, result validation and persistent resumption tested |
| Prime sieve | [sieve.ts](../examples/sieve.ts) | independent reference comparison, txn rollback, lease recovery and SQLite reopen |
| Cache | [cache.ts](../examples/cache.ts) | local atomic replacement, CAS, TTL and SQLite reopen; no replication |
| Space chat (v1–v6) | [help-site/examples/](../help-site/examples) | pure tuple-space architecture (`SpaceChatEngine`): presence leases, `ChatTask`+CompletionProfile, `ScheduledJob`/`TimerLock` alarms; stages from local to federated |

## Two Different Chat Architectures

`agent/examples/chat.ts` and `help-site/examples/shared/chat-core.ts` (`SpaceChatEngine`) are **deliberately different
paradigms** and not a duplicate:

- `agent/examples/chat.ts` uses `phi-spaces` as an event bus **between long-lived `pi-durable` conversations**
  (actor model): each character is its own conversation with history; the Space transports only flat `Msg` notifications.
- `chat-core.ts` (stages v1 to v6 in the help system) realizes the chat **entirely in Space primitives**:
  stateless workers pull `ChatTask` tuples transactionally, presence is lease entries, alarms are
  `ScheduledJob`+`TimerLock`. No actor framework, no long-lived conversations.

CLI entry for the pure tuple-space variant without a web server: `npm run example:space-chat` (stage v1).

## Execution

```bash
npm run typecheck
npm test
npm run test:examples
npm run example
npm run example:pipeline
npm run example:chat
npm run example:golomb -- 4 --workers 2
npm run example:sieve -- 1001 4
npm run example:cache
npm run example:codemode-evolve -- --gens 6 --agents 8
npm run example:blocking
npm run example:space-chat
npm run help
```

Sieve and cache run without pi-durable on the phi-spaces store. With `--remote` they work through a standalone
space service (`src/standalone.ts`), over a Unix socket or TCP:

```bash
npm run space-server -- --store /tmp/space.sqlite --listen unix:/tmp/space.sock
npm run example:sieve -- 1001 4 --remote unix:/tmp/space.sock
npm run example:cache -- --remote unix:/tmp/space.sock
```

Through the service, the sieve creates all tasks of a run in one transaction. The cache issues versions from a
counter per namespace. It writes new keys `unique` so that two simultaneous first `set` calls cannot both succeed.

`examples/codemode-evolve.ts` is an experiment in the manner of the Monte Carlo method: many random agent contributions
(`CodeCandidate`, JavaScript source) solve a task (`CodeTask`: the first n primes). Evaluators take
candidates under a transaction, run them in a QuickJS sandbox of `@earendil-works/pi-codemode` without tools,
and write a `CodeScore` (correct? how fast?); the host keeps the best result as `CodeBest`, on which
the agents of the next generation build. Runnable without a model (agents are random generators with a seed); an
LLM agent would write the source itself. `@earendil-works/pi-codemode` is a dependency of the project
(`PI_CODEMODE_DIR` selects another path); if it cannot be loaded, the example is skipped. Measured time is wall time and fluctuates.

Live examples (`agent/examples/chat.ts --live`, `npm run example:arxiv`, `npm run example:dark-energy`, `npm run example:codemode-evolve:live`) need credentials and incur
model costs; [live-models.ts](../agent/src/live-models.ts) selects provider and model. Under AGENTS.md they are
run only after approval. The arXiv network access and scientific result quality are not validated by
faux tests. API parser and data contract are checked with local fixtures.

## Space Rules for Examples

Entries are `{type, fields}`. Field filters belong under `fields`. There is no update and
no agent tool `space_count`; host code owns `count()`. Uniqueness is checked only by the `write` option `unique`. Null in templates is a wildcard and does not mean
"field missing". `readAll` returns at most 1000 entries; `space_list` by default 100, at most 1000.
An entry lease makes an entry disappear; only a take transaction permits its return after abort.

A take under a transaction is a reservation. Only a successful commit removes the entry
permanently. After abort/expiry it may be taken again. Task claims deduplicate tool replays; they do not make
external effects exactly-once in general. Durability depends on the store: `openOwnMemoryHost` is volatile.

## Atomic Research Outputs

[research-support.ts](../agent/examples/research-support.ts) defines `researchSpaces`. Result entries and
completion markers require the active transaction owned by the agent with the matching reserved task.
Missing/wrong transactions are rejected server-side. All writes of a phase stay
invisible until commit. The simple arXiv pipeline also writes PresentTask under the AnalyzeTask transaction.

A new run requires a fresh, empty state directory. With `--resume --dir <directory>` both research programs
explicitly reopen a compatible existing run. The topic/query configuration
is adopted; explicitly deviating values or a different run kind are rejected.
[research-run.ts](../agent/examples/research-run.ts) stores the run identity in the manifest and team IDs,
model selection and phase in a pi-durable document. Conversation creation and ID entry are one commit;
start messages have stable request IDs.

Phase markers and new tasks are written in the same Space transaction. Thus on resumption no second task arises
even if the first has already been consumed. The exclusive SQLite owner lock also protects
the agent store from a second launcher and is released by the operating system on a process crash.
A finished run can output its report files again without restarting the team.

```sh
node --experimental-strip-types agent/examples/arxiv-research.ts --resume --dir /pfad/zum/lauf
node --experimental-strip-types agent/examples/dark-energy-research.ts --resume --dir /pfad/zum/lauf
```

Resume does not retroactively validate expired Space transactions or request generations.
Incomplete phases remain an error on timeout; they are not skipped by invented
results or blindly recreated tasks. External model/research requests may be executed again after a
crash. Live execution costs tokens and needs its own approval.

## Test Scope

The older suite checks many Space patterns with its own scripts. It is not complete evidence for the
respective CLI programs. [recovery.test.ts](../test/examples/recovery.test.ts) adds calls of the actual
implementations and SQLite reopen; the [agent version](../agent/test/examples/recovery.test.ts) checks JSONL reopen,
resume after SIGKILL during analysis and targeted failures. Scripted model tests filter system messages before checking
the last message (`m.role !== "system"`, see `agent/test/examples/`). [Test overview](../test/examples/README.en.md).

No scaling or production benchmarks exist for the examples themselves. System-wide NetBird,
partition and load evidence is in [test/evidence](../test/evidence/) and the
[acceptance documents](_attic/abnahme/ap3-abnahme.en.md).
[v3 resource values](federation-plan-v3.en.md#411-resource-planning-with-several-vps) are planning figures,
not demonstrated minimum requirements.

Details: [Sieve](examples/sieve.en.md), [IoT](examples/iot.en.md), [Chat](examples/chat.en.md), [Research](examples/arxiv.en.md),
[Golomb](examples/golomb.en.md), [Cache](examples/cache.en.md), [Analysis](_attic/IMPLEMENTIERUNGS-ANALYSE-V2.en.md),
[Historical context](_attic/HISTORISCHE-REFERENZEN.en.md).
