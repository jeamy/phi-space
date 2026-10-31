# AP 1.1–1.9: Local Implementation and Acceptance

As of 2026-10-09. References: [implementation plan](../implementierungsplan-v3.en.md),
[federation contract](../../federation-plan-v3.en.md), [API](../../api.en.md),
[implementation status](../../implementierungsstand.en.md). Evidence refers to the local working state.

| AP | Closed items | Evidence |
|---|---|---|
| 1.1 | v4→v5 preserves the default singleton, local IDs, ownership and uncommitted data; named Spaces separately | persistent fixture `test/fixtures/space-v4.json`, JSONL and SQLite with reopen |
| 1.2 | stable registry/Space identities, incarnation and global entry ID | existing spaces tests and migration reopen |
| 1.3 | one revision batch per Space/storage txn, also with multiple document access; immutable snapshot tokens | concurrent changes and expiry during five large entry pages, query/owner binding; bounded changes |
| 1.4 | shared commit accounting, completion reservations including later subscriptions; real UTF-8 pages with response envelope; no silent 1000 cutoff | atomic rollback on accumulated writes, rejected unsafe limit reduction, page/frame limits |
| 1.5 | HMAC generations with persistent host key; hash/Space check also on pending retry; separate durable execution and result reservation | reopen without the old caller, fixed deadline, tampering, result expiry and known repetition under pending quota |
| 1.6 | principal mailboxes, prefix ACK of delivered sequences only, TTL/byte limit, gap/epoch change and registrationClosed | cursor must not skip unread events; old ACKs isolated; lost unacknowledged FOREVER take is released, ACKed take stays separately reserved |
| 1.7 | durable maintenance/fanout continuation under byte budget; CompletionProfile at every task-take commit | bounded cleanup batches and crash/reopen; full consumer delays events, not reserved completion; sieve commit without result rejected |
| 1.8 | all local Space methods, own claims/mailboxes/txns, rate and pending quotas; count/stats plus revision from one snapshot | service/AP tests, peer quota across agents, time window for rate limit |
| 1.9 | complete RemoteSpace, bounded client wait even with a hanging transport, stable retry identity; socket and pi-server adapters | lost responses, deadlines, safe socket file handling, real pi-server/pi-client packages and built bundle in the real pi-serverd |

## Reproducible Checks

```bash
npm run typecheck
npm run build
npm test
npm run test:examples
npm run test:pi-server
npm run bundle
```

The core/integration suite comprises 184 passed tests, the example suite 158;
no failures or skips in the local acceptance. `test/test-pi-server.test.ts` uses existing
packages of the neighboring mobile runtime. Without these packages the two native tests are
explicitly skipped; thus no pi-serverd acceptance is demonstrated. Alternative path:
`PI_SERVER_RUNTIME_DIR=/pfad/zur/runtime npm run test:pi-server`. Nothing is installed.

The native test builds the current library, copies the runtime into a temporary directory
and starts the real `pi-serverd.mjs` with an isolated SQLite database, private socket and
empty credential file. `sessions.list` remains usable; `RemoteSpace` writes/takes entries.
A second start without a configured Space identity refuses Space RPC, even with a forged
principal in the JSON. There is no model request and no access to the production database.

The additional local scenario:

```bash
node --experimental-strip-types test/testbed/scenarios/sieve-remote.ts all \
  --dir /tmp/phi-spaces-ap1-sieve-run --fresh --end 1001 --block 100 \
  --workers 3 --crash-workers 2 --work-ms 60 --lease-ms 600 \
  --kill-host --timeout-s 25
```

Result: named Space `sieve-remote`, 10/10 result blocks without duplicates, 168 primes
as with independent trial division; after host SIGKILL/reopen and two dying workers no
tasks, locks, uncommitted entries or open txns remain. This scenario uses
Unix sockets on the local machine; it does not demonstrate overlay authentication.

## Integration and Remaining Stages

`withSpaceService` extends the existing pi-server server route; session/chat calls remain
on their route. `piServerTransport` uses the existing pi-client. In the neighboring mobile project
the Space access is opt-in via `PI_SERVERD_SPACE_PRINCIPAL` and `PI_SERVERD_SPACE_ROLES`.
SSH/socket access creates no implicit role. The socket represents an explicitly
configured local identity; separate remote principals need the gate from phase 1b.

Snapshot tokens are a bounded host-local read cache and invalid after host reopen.
Changes map visible entry deltas; internal state commits can produce empty batches.
The complete primary stream, `pending/commitSealed`, sync replication, fencing, promotion,
gate/layer A/B, router and mobile administration interface belong to the further stages.
No running daemon or container on `big` was updated.

Sieve preparation is now resumable under a budget: seed and cursor are persisted
per commit. On overload an accepted prefix can remain; repetition after remediation
resumes there and duplicates no tasks. The entire seed run is not a single transaction.
