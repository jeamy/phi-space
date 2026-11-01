# Rust audit fixes — 31 October 2026

This records fixes to the implementation inspected on 31 October, alongside the
[porting plan](rust-portierung.en.md). Existing uncommitted work was preserved.
These changes do not complete the production federation host or R6.

## Correctness

- Raw numeric overflow such as `1e309` no longer reaches a panicking canonical hash.
  Service admission uses the TypeScript client's JSON-copy semantics; stored entry
  fields normalize non-finite numbers to null. Core claim admission and snapshot query
  canonicalization return TypeError on invalid canonical input. Regression tests compare
  raw overflow writes, normalized retries, stored fields and snapshot errors against TS.
- The outbound transport counts both replies and bytes, including what a blocked writer
  already removed from the queue. The caps are 1,024 replies and 8 MiB per connection.
  An exhausted budget closes the connection, clears queued replies and cancels a blocked
  write. A parked task also checks an already-closed connection before its first wait,
  so a disconnect cannot lose cancellation before the task starts. Overload responses cannot grow a full queue. Slow-reader and blocked-writer
  regressions verify that other clients remain usable and cancellation completes.
- Store document and format-metadata reads distinguish an absent row from an SQL failure.
  A read failure is propagated rather than interpreted as a new Space.
- Watches use weak slots; dropped subscriptions free their slots, and registration and
  commit notification prune expired slots. Close still marks live watches closed.
- Memory commits now retain side documents atomically with successful Space operations.
  The unused memory-document setters had hidden a missing call path: registry/epoch/proof
  writes were previously discarded. A regression checks side-document commit and rollback.

## Allocation and code cleanup

- Large ordered JSON objects maintain a key index; small objects retain their compact
  representation. Serialization order, duplicate-key behavior, numeric keys, removal and
  undo positions remain governed by the JavaScript contract. Equality ignores the cache.
- Entry retention compacts the vector once while preserving the undo log and entry order.
- Snapshot records share immutable items; page lookup does not deep-clone the complete
  snapshot. First-page and size checks avoid additional whole-array copies.
- The SQLite writer applies existing operation vectors in one transaction without cloning
  the entire batch; its commit sequence still advances once per writer batch.
- Store/background truthiness uses the core helper. Whole and incremental claim writes
  share the same index-field extraction. RunGate and membership envelope verification use
  one helper while retaining explicit, separate signature domains and error classes.
- Removed the unused `SpaceHost::ords_of` diagnostic and uncalled memory-ledger setters.
  Kept the test drivers, whole-document operations and test hooks that have real consumers.
- Updated stale unsupported-feature comments and the porting plan's opening status.
  Speculative changes to head cloning and Space eviction remain subject to profiling.

## Validation

| Check | Result |
| --- | --- |
| Root `npm run typecheck` | passed |
| Root `npm test`, final run | 622 passed, 3 skipped, no failures |
| TS adapter suites against the rebuilt Rust binary, including TS→Rust→TS handover | 90 passed, 3 documented skips, no failures |
| `cargo clippy --workspace --all-targets --offline -- -D warnings` | passed without warnings |
| Branding | passed (2,072 text files) |
| Full Cargo executable suites | 140 passed, 2 intentional ignored helpers, no failures |
| Rustdoc after rebuilding parallel Boot/Guard changes | passed |

An earlier post-fix binary build and adapter run recorded source hashes: no Rust source
changed during that run. The later current-source check is qualified below. Logs are in
`/tmp/phi-rust-fixes-{cargo-test,npm-final,typecheck-final,adapters-final,clippy-final,branding}.log`.

Cargo artifacts and scratch stores are isolated under `/tmp/phi-rust-fixes-target`; `/tmp` is tmpfs on this machine.
This avoids the kernel disk waits seen in the preceding audit and collisions with other
Cargo runs. It is not a physical-disk durability or power-loss acceptance.

The first full Cargo command exited 1 at its Rustdoc phase: Boot/Guard interfaces
were added in parallel after its dependency artifacts had been built. Its executable
test suites all passed. `cargo test --workspace --doc --offline` then rebuilt the
changed dependencies and passed. This is recorded separately rather than calling the
original command green. The updated transport unit tests also passed independently.
The final current-source check in `/tmp/phi-rust-fixes-current-check.log` passed its
library tests, overflow regression, all ten transport integration tests, binary build,
Clippy with warnings denied and the 90 adapter tests. Its wrapper exited 1 solely because
its source-hash check detected another concurrent edit to `phi-host/src/boot.rs`.
None of the fix-package source files changed during this final check. Boot/Guard production
acceptance belongs to the parallel porting work; the entire moving checkout is not claimed
as an immutable accepted release.
