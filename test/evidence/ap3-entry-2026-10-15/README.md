# Phase 3 entry-replication substrate — 2026-10-15

The built invariant scenario passed all eleven cases on `big`, with JSONL and
SQLite persistence, inside one owned rootless production-mode container limited
to 2 CPUs and 1 GiB RAM. The image was pinned by SHA-256, the root filesystem was
read-only, all capabilities dropped and external networking disabled. Only
compiled JavaScript was copied; no TypeScript or checkout was mounted. The
container and its private temporary stores were removed. Protected container
IDs, status, start times and restart counters were unchanged.

`server.tap` records the actual built run; `server-tests.json` summarizes it.
`runtime.json` binds library/scenario hashes and execution settings; `cleanup.json`
records equal before/after inventory hashes without unrelated service names.
`build.json` intentionally retains parent commit `2885544` and dirty-tree
attribution. `validation.json` binds the final sources and local check results.
The mobile bundle is byte-identical to the tested library.

Cases cover persisted HLC/LWW/Add-Wins metadata, reverse/duplicate delivery,
remove-before-add, durable owner/deadline preservation, no fallback to older
values after winning-version expiry, request retries after actual lost commits,
atomic snapshot merge with local writes, origin/incarnation validation, future
clock refusal, authorization revocation, immutable-ID conflicts and bounded
history/commit backpressure. No tombstone or dedup record is discarded.

Partition time and clock faults use an injected clock. This is a compiled
semantic/persistence invariant run in one container, not a real ten-minute
NetBird partition or multi-process replication transport test. The new API uses
its own administrative documents; it is not activated for normal production
Spaces. Large paged snapshots, service/ACL/boot/erasure integration and the full
primary/sync and promotion protocols remain open.

[Implementation and remaining Phase 3 work](../../../docs/abnahme/ap3-replikation.md).
