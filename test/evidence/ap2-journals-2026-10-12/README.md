# AP2 fixed journal partitions — 2026-10-12

Full Phase 2 acceptance remains open. This checkpoint provides fixed, budgeted Parent/Router journal partitions while retaining every historical ID. It does not migrate existing history or claim indefinite journal capacity.

The local suite passed 402 tests, with 158 example and 24 mobile/remote tests passing. The built artifact passed 167 tests in an isolated container on `big` (network disabled, read-only filesystem, 2 CPUs, 1 GiB RAM). Only built JavaScript was shipped; production services were not replaced.

After the full suites, the existing signed TCP Root-composition test was switched from one journal to eight partitions and passed separately on JSONL and SQLite both locally and against the same built server artifact (two cases each). These follow-up reports cover the final test configuration; there was no library change after the full suites.

The load case performs 1,000 virtual writes across three persistent Members on each backend, then reopens the Root and retries historical IDs without additional writes. It uses 256 fixed partitions, of which 252 are occupied, with at most ten Parents in one partition against a limit of 16. The Member transport is simulated. This is not the full 10,000-entry / 1,000-job / six-worker scenario or a three-host NetBird acceptance test.

Other cases cover a full partition without blocking independent partitions, immutable topology, legacy migration rejection, a transaction whose finish ID belongs to a different partition, removal references across all partitions, lost effect replies, and pre-/post-commit interruptions during multi-partition restore. A persistent global restore barrier remains until the same reconciliation completes.

`checks.json` records artifact hashes, counts and remaining gates. TAP files preserve concrete assertions. Earlier mobile/NetBird and member-load evidence remains historical and does not imply a new phone deployment or production rollout.
