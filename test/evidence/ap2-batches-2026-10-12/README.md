# AP2 local deletion checkpoint — 2026-10-12

Full Phase 2 acceptance remains open. This checkpoint verifies bounded, resumable deletion in one local Space, including persistent admission fencing, restart/crash recovery, authority binding and repeated scope checks. Remote Members and Router/parent journals require a separate distributed workflow.

- Typecheck passed; 388 repository tests and 158 example tests passed.
- The built artifact passed 153 tests in an isolated container on `big` (network disabled, read-only filesystem, 2 CPUs, 1 GiB RAM). Only built JavaScript was shipped. Production services were not replaced.
- The synchronized mobile bundle passed 24 mobile/remote tests. No phone deployment or live phone retest is claimed for this checkpoint.
- JSONL and SQLite each deleted 240 owned entries plus associated records from a state exceeding 1 MiB in 99 batches at a 4 KiB commit budget. The largest observed combined persisted mutation delta was 1,293 bytes. Snapshot/checkpoint writes are separate from mutation deltas; this is not a bound on physical disk I/O.
- The crash matrix covers six deletion phases, both pre-commit interruption and lost post-commit replies, on both backends. Tests also cover scope withdrawal, authority/incarnation changes, immutable Space IDs and completed-command replay.

See `checks.json` for artifact hashes, counts and remaining gates. TAP reports contain the concrete assertions. Earlier live-phone and member-load evidence remains in `../ap2-final-2026-10-11/`; it does not validate a distributed three-host run of this checkpoint.

Deleting accessible state does not erase historical JSONL/SQLite storage or backups. A retained audit and durable fence are intentional; incomplete deletion after scope withdrawal or restore requires operator review.
