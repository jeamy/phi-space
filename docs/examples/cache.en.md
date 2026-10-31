# Local Atomic Cache

As of 2026-10-07. Implementation: [cache.ts](../../examples/cache.ts).
Tests: [cache.test.ts](../../test/examples/cache.test.ts). No model or network required.

```bash
npm run example:cache
```

The demo writes Alice, replaces the value version-bound with Bob and deletes it again.
It uses a phi-spaces store in memory. With an SQLite store, values and the version counter survive
a reopen; this is tested. With `--remote <address>` the same demo runs through `RemoteCache` against a standalone
space service (`npm run space-server`).

## Contract of SpaceCache

`new SpaceCache(host, namespace?, now?)` binds the cache to a local harness.
Every operation is serialized in one host commit. A key is unique within its namespace.
An ordinary Space write remains an additional entry; the cache class implements atomic replacement.

| Operation | Semantics |
|---|---|
| get(key) | `{value, version, expiresAt}` or null on a miss; a stored null value remains a hit |
| set(key, value, ttlMs?, expectedVersion?) | atomic replacement; default TTL 60,000 ms; FOREVER possible |
| expectedVersion omitted | unconditional replacement |
| expectedVersion = null | write only if no live value exists |
| expectedVersion = number | compare-and-set; a stale version causes an error without a state change |
| delete(key, expectedVersion?) | true on deletion, false on a miss; an optional version protects against a stale delete |

The persistent, shared version counter rises on successful writes even after a delete or expiry.
Thus an old version cannot replace a value created later. The TTL is fixed at write time;
get does not extend it. TTL 0 replaces the old value with an immediately expired value.
Renewal creates a new version with a new deadline.

Values are JSON-compatible, are copied and are limited to 60 KiB. Namespace length 1–128,
key length 1–256, TTL a non-negative safe integer. Binary data must be encoded explicitly.
A failed replacement (CAS or Space byte limit) restores the old value.
The host operations use the Space byte limit, not conversation quotas or agent tools.
Write managed keys exclusively through SpaceCache: external reservations, uncommitted
writes and duplicate entries are rejected as conflicts; the class does not repair them automatically.

Tested are namespace isolation, null hits, concurrent replacements and CAS, TTL/renewal,
stale deletes, rollback, external txn conflicts and SQLite reopen.

## Future Distributed Cache

This cache is **not** mapped onto the LWW replication of the federation (HLC, merge types `lww`/`set`, see
[implementation status](../implementierungsstand.en.md) and [v3 plan](../federation-plan-v3.en.md)). The local version counter is not a distributed merge rule.
A bilaterally writable LWW cache can return different reads during a partition;
acceptance requires deterministic convergence after a complete exchange. Versioned tombstones
must use the same merge rule as values so that old replicas do not resurrect deleted values.
Replay must not extend deadlines; time uncertainty, offline rejoin and tombstone GC need their own tests.
LWW counters are not a correct aggregation method for hits/misses.

No measured latency, throughput or availability values.
[Back to the overview](README.en.md).
