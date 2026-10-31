# Example and acceptance plan

As of 2026-10-07. Current implementations: [examples.md](../examples.en.md).
Future infrastructure: [Federation plan v3](../federation-plan-v3.en.md).

| Area | Evidence today | Additional future acceptance |
|---|---|---|
| Master/worker | real sieve, independent reference, lease recovery and JSONL | multi-member routing, CPU scaling |
| Sensor pipeline | local atomic analyst/presenter steps and rollback | persistent collector recovery, window planning |
| Chat | actual faux ring, notify semantics | real model, separate hosts and reconnect |
| Golomb | actual small search, JSONL reopen, task rollback | higher orders, CPU parallelism, measured scaling |
| arXiv | parser fixtures, actual scripted runners | real API/model runs, independent source verification |
| Cache | local replacement/CAS, TTL, rollback and JSONL reopen | merge, tombstones, partition/resync and replicated leases |

## Rules for statements and metrics

"Implemented" means existing code, "tested locally" means a matching test that was run,
"planned" means a target contract. Faux-model tests show orchestration and Space states, not research quality.
No measured throughput, speedup, coverage or availability figures exist.
Performance goals are documented as results only after measurement, with hardware, data volume, configuration and
version. VPS sizes in the plan are estimates, not benchmarks.

Take reservations may return after abort/expiry. External work that must be done exactly once in the business sense
needs an idempotency/effect-target contract. Transactions are local and limited to one member.
An entry TTL is not a retry mechanism; write is not a mutation without declared future upsert semantics.

## Tests

```bash
npm run typecheck
npm test
npm run test:examples
```

Details: [test overview](../../test/examples/README.en.md),
[example index](../examples/README.en.md), [history](HISTORISCHE-REFERENZEN.en.md).
Federation tests are prerequisites of later plan stages, not example tests that have already passed.
