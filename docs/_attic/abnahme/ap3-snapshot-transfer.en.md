# Paged Replication Snapshots

As of 2026-10-15. The administrative entry replication component can receive large
snapshots in bounded pages and resume progress after a harness restart.
Activation needs only a small atomic commit. This is
not yet a public NetBird replication service and no primary/standby acceptance.

## Flow and Atomic Visibility

`startSnapshot(pageBytes?)` freezes the complete logical entry history at
revision R. The manifest binds Space, authority, configuration, source,
incarnation, R, count/bytes, page budget and expiry time. The hash chain binds
order, offset and content of each page up to the final hash. Owner,
origin ID, tombstones, remove tags, HLC and original lease deadline remain
unchanged. SHA-256 does not replace authentication of the replicator.

`beginSnapshotImport(manifest)` reserves staging capacity and journals
the transfer. `importSnapshotPage(id, page)` stores exactly one page atomically
together with the next page index, offset and chain hash. Repeating an
already stored page returns the same state only for identical content.
A page may not skip a gap. Staging data is invisible to `read()` and
`changes()`. Received HLC values and own sequences are advanced already
on page receipt: a local write arising afterwards is causally newer
than the received change, even if the latter is not yet visible.
An abort does not reset such clocks/counters; sequence gaps are permitted.

`finishSnapshotImport(id)` checks all pages, the hash chain, origin conflicts and the
capacity again. It then publishes only a reference to the immutable
staging pages and the result of the transfer. It does not copy the large history
into one commit. Still incomplete or contradictory transfers change
no visible entries.

Locally created changes remain in the running overlay history. The
reference records up to which overlay offset local changes lie **before** the
new generation. Later writes lie behind it. With several generations
this order is preserved. Duplicate origin IDs are read only once.
Existing `changes()` cursors thus keep their meaning; a late-published
snapshot does not reorder changes that are already visible.

Document version 2 adds the generation references. Existing version-1 histories
are taken over with an empty reference list; entry IDs, HLC, requests and
owners are preserved. The actual migration is checked on both backends.

## Methods

| Method | Effect |
|---|---|
| `startSnapshot(pageBytes?)` | Immutable export manifest with R and expiry time |
| `snapshotPage(id, index)` | Byte-bounded page of the same snapshot, freshly authorized |
| `beginSnapshotImport(manifest)` | Durable transfer start; the same ID may not change its binding |
| `snapshotImportStatus(id)` | Durable cursor, manifest, phase and possibly final result |
| `importSnapshotPage(id, page)` | Store page and progress atomically; permit identical repetition |
| `finishSnapshotImport(id)` | Make all pages visible atomically; unchanged final result on retry |
| `abortSnapshotImport(id)` | Clear at most one stored staging page per call; store progress for resumption |

A driver holds the snapshot ID and reconstructs its next step after a restart
from `snapshotImportStatus(id)`. The complete manifest binding
is additionally in the target journal `EntrySnapshotTransfers`. The final result
contains `sourceRevision`: `source.changes(sourceRevision)` returns the changes
that arose after the export. Their continuous transport and durable stream checkpoint are handled by the
implemented [pull worker](ap3-stream-transfer.en.md).

Snapshots already completely received may also be finished after token expiry and
source restart: the pages are durable and completely
checked. Missing pages of an expired token or one lost on the source
cannot be requested again. Then abort the old import in a resumable way
and use a new manifest. A published snapshot cannot be aborted.

## Fixed Limits and Backpressure

| Resource | Limit |
|---|---|
| Export tokens | At most 16 per host/replica document, together 64 MiB of encoded content |
| Token lifetime | 60 seconds; source harness restart ends the in-memory export |
| Pages | At most 2,048 per snapshot, at most 1,024 changes per page |
| Page bytes | Default 90,112 with a 192 KiB commit budget; `2 × pageBytes + 16 KiB` must fit into the target commit budget; at least 1,024 bytes |
| Active transfers | One per target replica document; including the abort phase |
| Transfer/generation records | At most 16; completed and aborted records are retained |
| Reserved staging | At most twice `maxHistoryBytes`; reservation = content bytes + 1,024 bytes per page |
| Logical history | Still 16 MiB by default, at most 64 MiB, including durable conflict/deduplication data |

The quota also counts already published pages. There is no automatic
cleanup yet of old published generations/records. At the limits
new transfers are rejected; neither tombstones nor replay records
are discarded. On a completed abort the staging reservation is released.
Clearing active staging pages is no physical deletion guarantee for old
backend revisions. Running transfers need unchanged budget settings.

Concurrent local writes can fill the history during the download.
Then the finish may fail with backpressure; local writes are
not lost in the process. After revocation of rights, fencing, a wrong manifest binding or a
changed final hash, activation remains blocked. New snapshot and
staging documents need the same still-open productive boot/deletion integration
as the entry replication itself; they are not automatically activated on production data.

## Tests and Remaining Operation

Twelve new cases check JSONL and SQLite: real version-1 migration, snapshots
above the single commit budget, immutable pages, local writes during
the import, causal HLC, stable complete cursor order over several
generations, invalid pages/bindings, expiry and abort, and backpressure.
Before and after an actual storage commit, begin, each page and finish are
interrupted, the target harness reopened and the same IDs repeated. Real
StorageWrite sizes for pages, publication and subsequent overlays are checked
against the 32 KiB test budget. The publishing commit stays under
12 KiB in the test even though the snapshot is larger than the commit budget.

The built server case runs these twelve and the eleven earlier entry invariants
in the isolated production-mode container. This remains a component evidence;
real NetBird integration with ten minutes of partition, service/grant/
boot/deletion integration and primary/standby have their own open acceptances.
See [Phase 3](ap3-replikation.en.md).


## Current Evidence

517 repository tests, 20 mobile runtime tests and four mobile lifecycle tests are
green; type check and link check passed. The 23 built replication cases
also pass on big. Both backends transfer 353,186 bytes in 20 pages in the large case.
The separate 32 KiB boundary case measures at most 3,743 bytes (JSONL)
or 3,746 bytes (SQLite) per StorageWrite array and 2,433 bytes for
publication. [Artifacts and evidence](../../../test/evidence/ap3-paged-2026-10-15/README.md).
The test container is removed; existing containers remained unchanged.


The [durable generation maintenance](ap3-snapshot-maintenance.en.md) meanwhile replaces
redundant page copies crash-safely. It does not shorten any causal history.
