# Phase-2 process crash evidence — 2026-10-13

Both local source execution and the built artifact on `big` passed the same
20 cases (not 40 distinct boundaries): five boundaries, before/after, JSONL
and SQLite. Every crash child exited with SIGKILL. Recovery and verification
ran in separate new processes using the original four stores.

The isolated server container had no network, a read-only filesystem with
private tmpfs for stores, and limits of two CPUs and 1 GiB. It was removed on
exit. The three existing services remained active. No mobile or production
library change was needed; the library hash matches the admission checkpoint.

This uses in-process fixture RPC and a fixed clock. It proves selected
process-recovery boundaries, not full NetBird load/crash acceptance,
independent hosts, production boot/fencing, or power-loss durability.
`checks.json` records hashes and limits; JSONL logs contain every case and the
complete final report. The routine suite passed 428 tests. No server source
files were shipped.
