# Durable Maintenance of Snapshot Generations

As of 2026-10-15. Maintenance replaces redundant physical copies with a new
paged generation. It does **not** remove origin events, tombstones, remove tags,
HLC information or request deduplication. The condition of a shared
causal state for a later true history truncation remains unchanged.

## Flow and API

`startSnapshotMaintenance(requestId, pageBytes?)` captures the complete
current logical prefix and reserves a durable maintenance job.
`advanceSnapshotMaintenance(requestId)` copies one page per call, publishes
the new head atomically or removes an old page document. The state can be queried via
`snapshotMaintenanceStatus()`. The last job remains repeatable;
a change of its page budget is rejected. An older job that is still held
must not be started again. After the deliberate forgetting of its
expired receipts, the operator must still use new job IDs.

The states are `copying`, `cleaning`, `completed`. While copying, the
old generation remains readable. On publication, all overlay events and generations
captured at that time are replaced by exactly one reference. New local
writes and stream imports continue and are preserved as the following overlay in
the same order. The source cursor counts the same events unchanged.
No new domain event is created.

A further snapshot import remains blocked until maintenance completes. Imports
already running must be completed or aborted beforehand. This prevents
a concurrent change of the captured generations. The reserved new
holdings may temporarily exceed the normal staging budget up to the fixed maintenance limit
`3 × maxHistoryBytes + 2 MiB`. There is at most one job and
at most 17 transfer receipts including the maintenance reserve. Pages remain limited to 2,048,
the existing atomic commit budget applies unchanged.

Old references become inaccessible only after the atomic publication.
After that, one old chunk document per commit is retired via `retireDoc`.
Its transfer becomes `retiring`, after the last page `retired`; only then does
`retainedBytes` drop by its reservation. Aborts before or after each commit resume
from the stored progress. A new harness needs no
volatile export cache: pages are reproduced from the still unchanged prefix
and checked against the durable manifest.

`forgetSnapshotReceipt(snapshotId)` removes exactly one expired receipt in
`retired` or `aborted`. The fresh clock check remains mandatory. Live
generations and running maintenance are excluded. A renewed admission of the
old manifest then fails because of its expiry. Stream checkpoints already initialized
keep their verified seed binding independent of the old
receipt; new seeds need a published snapshot that can still be proven.

The release is a logical storage cleanup. Historical JSONL/SQLite
revisions are not physically deleted from the disk by it; the exclusive backend maintenance and
deletion procedures continue to apply for that. In particular this is
no principal deletion and no release of outdated backups.

## Evidence

Eight additional cases check JSONL and SQLite: actual commit losses before
and after the start, each copy page, publication and each retirement;
restarts, monotonic stream cursors, request replay, tombstones and removed set tags,
revocation within the commit, active import conflicts, expiry and receipt cleanup.

The large case performs three generation changes with 72 events of 4 KiB
payload each. Existing stream order and origin IDs are preserved exactly;
the overlay holdings become empty. Actual StorageWrite arrays stay within the
32 KiB test budget. The measured values and built server cases are in the current
evidence (`test/evidence/ap3-next-2026-10-15`, not kept in the repository).
