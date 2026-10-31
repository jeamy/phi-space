# Continuous Entry Exchange with Durable Cursor

As of 2026-10-15. The administrative replication component has a continuous
pull worker. Data and source cursor are committed together atomically. This complements the [paged
snapshot transfer](ap3-snapshot-transfer.en.md);
a public Space/NetBird replication service is not started by this.

## Source Binding and Commit

`describeStream()` names Space, authority, configuration hash, source replica,
incarnation and the stream ID deterministically derived from them. The revision
counts the immutable local receive order. The worker receives this
identity as an explicit pin; a deviating source ends the exchange.
Each step queries the source again. It holds no rights/grant or
challenge state across this adapter.

`streamChanges(after, maxBytes)` returns a byte-bounded, undivided range.
`after`, `next`, positions and content must match. After a compaction
the positions are no longer gapless; then the page names them in `positions`
(strictly increasing, greater than `after`, at most `next`). The SHA-256 binds the
fixed source identity, the range, the events and possibly the positions. The mutable current
head and `more` are not part of this range identity: a range remains
repeatable if the source has meanwhile appended further changes.
Hash and pin do not replace an authenticated transport connection.

`startStreamImport(source, snapshotId?)` creates a durable source checkpoint
in `phi-spaces.entry-stream-checkpoints`. Without a snapshot it starts at zero. A
snapshot may advance it to R if its completed record and the
actually published generation belong exactly to this source. An
existing further advanced cursor is never reset.

`importStreamPage(page)` accepts only the range from the stored cursor.
The imported events, HLC/sequences and the new cursor are stored in the same
storage commit. A lost reply after the commit therefore causes
no second effect. Even already known forwarded events may advance the
source cursor; they create no new local changes.

Per source the last range receipt is retained. Its identical
repetition returns the stored result; changed content is rejected.
Older or overlapping ranges return `EntryStreamCursorConflict` without applying anything.
The driver then rereads the current checkpoint. No
unbounded second reply history is built up. The actual origin IDs and
deduplication information remain in the entry history.

## API and Worker

| Method / type | Effect |
|---|---|
| `describeStream()` | Bound source identity and current revision |
| `streamChanges(after, maxBytes)` | Byte-bounded, integrity-checked range of the source |
| `startStreamImport(source, snapshotId?)` | Initialize checkpoint at zero or after a checked snapshot; reset no cursor |
| `streamImportStatus(source)` | Read durable cursor and last receipt freshly authorized |
| `importStreamPage(page)` | Take over events and cursor atomically |
| `EntryReplicationSource` | Explicit adapter with read-only `describe` and `changes`, each with an optional AbortSignal |
| `EntryReplicationPump.step(signal?)` | Pull one range; result `applied`, `idle` or on contention `raced` |
| `EntryReplicationPump.run(signal)` | Explicitly started pull loop until abort or permanent error |

With `raced`, `revision` is expressly `null`: from the checkpoint the worker
knows only the new source cursor, no current local entry revision.
`applied` can yield `added: 0` if the range contains exclusively already known
events. With `idle` the last reply receipt is retained.

The loop does not start automatically with a host. By default it polls
every 1,000 ms. Only temporary source errors expressly classified as `EntryReplicationUnavailable`
are retried, with 100 ms up to a maximum of 5,000 ms
backoff. Rights, configuration, quota and local storage errors end the
worker. After a local harness restart a new controller/worker is built with
the same durable source checkpoint.

Source calls are limited to 5,000 ms by default and receive an AbortSignal.
An abort also ends waiting for a non-cooperating read-only
source adapter; its later result is no longer imported. A local commit
already running may finish atomically. Its result remains reconstructible via
the checkpoint. `onProgress` is called only after the step.

## Limits and Trust Boundary

- At most 32 source checkpoints per replica document, only configured origins.
- At most 1,024 changes and 256 KiB per stream response.
- The worker requests 90,112 bytes by default with a 192 KiB commit budget;
  `2 × pageBytes + 16 KiB` must fit into the target budget.
- Poll, retry and timeout values are restricted to 10 to 60,000 ms.
- The existing bounded entry history and snapshot staging quota continue to apply.

The options `authorize` and `assertActive` remain mandatory fresh
operator checks. The source adapter must actually check source and transport
and classify temporary network errors appropriately. The existing
`SpaceService` RPC allowlist is not silently extended by an import path.
Layer B/grant integration, boot role, deletion barriers including these new
checkpoint documents and the productive clock-health connection belong to AP 3.3.

## Evidence and Remaining Work

13 new cases check JSONL and SQLite: snapshot starting point, commit loss before/after
checkpoint start and every stream page, identical repetition, unchanged
last receipt after an empty poll, revocation of rights within the commit path,
changed sources/ranges, competing workers and monotonic cursors.

A real loopback TCP server is closed and reopened on the same port.
The worker continues with the same cursor. Bidirectional workers
converge after a **simulated** ten-minute partition without echo growth;
expired LWW winners do not make old versions visible again. Dedicated
checks bound hanging source calls and end the loop on abort
or permanent error.

A real ten-minute NetBird partition between independent hosts and the
productive service integration remain open. The [generation maintenance](ap3-snapshot-maintenance.en.md) is implemented and checked. Primary/sync, standby,
fencing transitions and promotion are not accepted by this.


## Current Evidence

530 repository tests, 20 mobile runtime tests and four lifecycle tests pass.
Type check and local document links are checked. On big all 36
built cases pass (11 entry, 12 snapshot and 13 stream cases). The separate
32 KiB boundary case measures on both backends at most 7,386 bytes for the joint
StorageWrite array of data and checkpoint. This does not measure disk/fsync amplification.
[Artifacts and evidence](../../../test/evidence/ap3-stream-2026-10-15/README.md).
The dedicated test container is removed; existing containers remained unchanged.
