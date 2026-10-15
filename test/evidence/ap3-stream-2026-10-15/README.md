# Durable continuous entry replication — 2026-10-15

All 36 compiled cases passed on `big`: eleven entry invariants, twelve paged
snapshot cases and thirteen stream cases. Both JSONL and SQLite are covered.
Only built JavaScript was shipped. The owned rootless container ran in production
mode with a pinned image, 2 CPUs, 1 GiB RAM, read-only root, no capabilities,
private temporary stores and container loopback only. Cleanup removed the owned
container; protected container inventories match before and after.

Stream cases exercise snapshot seeding, faults before/after the actual storage
commit at checkpoint initialization and each delta page, reopen, identical reply
replay, empty polls, stale/altered ranges, fresh authorization revocation,
concurrent workers and pinned source identity. A real loopback TCP fixture closes
and restarts its listener; the worker resumes from its durable cursor. Separate
cases cover bounded source calls, cancellation and permanent-error termination.
Bidirectional convergence uses an injected ten-minute partition, not ten wall-clock
minutes between independent hosts.

A 32-KiB-budget stream fixture measures the complete actual StorageWrite arrays:
maximum joint data/checkpoint commit **7,386 bytes** on each backend. These are
fixture sizes, not disk/fsync amplification or throughput measurements. The six
metrics also include the independently exercised snapshot fixtures.

All 530 repository tests, 20 mobile runtime tests and four mobile lifecycle tests
passed: **554 local/mobile tests**. The 36 built server cases repeat selected
coverage and are reported separately. Typecheck and changed-document links pass.
The synchronized mobile library is byte-identical to the tested server library.

`server.tap`, `server-tests.json`, `runtime.json` and `cleanup.json` preserve the
server results and cleanup proof. `build.json` deliberately retains parent commit
`f754ca2` and dirty-tree attribution; `validation.json` binds final source hashes.
No production replication was activated. Phase 3 remains unaccepted as a whole.
Generation/receipt maintenance, real NetBird partition acceptance, production
ACL/boot/erasure wiring, primary/sync and promotion remain open.

[Protocol and limits](../../../docs/ap3-stream-transfer.md),
[remaining Phase 3 work](../../../docs/ap3-replikation.md).
