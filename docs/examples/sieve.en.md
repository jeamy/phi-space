# Local Segmented Prime Sieve

As of 2026-10-16. Implementation: [sieve.ts](../../examples/sieve.ts).
Tests: [sieve.test.ts](../../test/examples/sieve.test.ts). No model or network required.

```bash
npm run example:sieve -- 1001 4
```

Computes 168 primes in the half-open interval [1,1001). First argument: exclusive upper bound;
second argument: number of workers (1–32). The CLI uses a fresh phi-spaces store in memory; with `--remote <address>` the workers operate through a standalone
space service (`npm run space-server`), each with its own client.
Several async workers coordinate in one harness; they provide no CPU parallelism.

## Tasks and Resumption

`prepareSieveRun(host, config, { space? })` stores an immutable configuration and a
durable seed cursor. Each disjoint SieveTask with runId/taskId and the cursor progress
arise in one budget-limited commit; partial progress remains resumable after overload or a crash. Repeated or concurrent preparation of the same
run creates no additional tasks; a changed configuration is rejected. Before the first task
the host installs the completion profile: a task take can only be committed with exactly one assigned
SieveResult whose `runId`, `taskId`, `rangeStart` and `rangeEnd` match the task.
This also holds through `RemoteSpace`.
`processSieveTask(space, runId)` takes a task under a txn, computes its segment and writes
SieveResult under the same txn. The commit removes the task and publishes the result together.
An error leads to abort; an abandoned reservation becomes available again after the txn lease expires.
The tasks themselves have FOREVER leases: entry TTL is not a retry mechanism.

`collectSieveResults(space, config)` requires exactly one result per expected taskId and checks
range and a sorted, unique sequence of numbers. A total count would not reliably detect missing or duplicate
segments. The collector does not validate against deliberately wrong primes.
Base primes extend up to sqrt(end−1); the tests compare independently with trial division.

The exported functions allow an SQLite store and resumption under an identical runId.
Tested are lease expiry of an abandoned reservation, then reopen of the SQLite store and complete
aggregation without re-seeding. In addition, `sieve-remote` checks the named Space over Unix sockets with dying workers
and SIGKILL/restart of the host process; [AP-1 acceptance](../_attic/abnahme/ap1-abnahme.en.md).

## Limits

- 0 ≤ start < end ≤ 10,000,000, block size 1–4096, at most 1000 blocks per run;
- at most 128 runs per store; no automatic cleanup of completed runs;
- the store belongs to one harness; independent processes share it only through the space service (`--remote`);
- local tests for reference results, concurrency, rollback, missing/duplicate results and byte limits;
- no performance, multi-host or federation acceptance.

In a later federation, task and result must lie in the same member txn.
See [v3 plan](../federation-plan-v3.en.md). Further minimal patterns:
[workers.ts](../../agent/examples/workers.ts), [blocking-tool.ts](../../agent/examples/blocking-tool.ts).
[Back to the overview](README.en.md).


## Gated Runs (Operations Extension)

With `configureGatedSieveSpace(host, space)` the Space receives the gated profile `SIEVE_GATED_PROFILE`
(`gateField: "runId"`, lease at most 60 s). Tasks can then only be taken while the RunGate of their run is
`running`; `RunController` starts, pauses, resumes and stops runs across all members, even after
restores. `SIEVE_WORKER_KIND` is the registered worker kind for the `WorkerSupervisor`, `SIEVE_EXPORTER` provides
the result export with completeness and hash. Contract and evidence:
[Operations and mobile control](../betrieb-und-mobile-steuerung.en.md) §6 and §8.
