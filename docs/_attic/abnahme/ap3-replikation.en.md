# Phase 3: Replication and Controlled Takeover

As of 2026-10-17. **Phase 3 has begun but is not accepted.**
Phase 2 and its documented closing decision remain unchanged.
The target contract is in section 7.2 and stage 3 of the
[federation plan](../../federation-plan-v3.en.md).
The comparison with the acceptance criteria is in the [acceptance matrix](ap3-abnahme.en.md).

## Implementation and Remaining Steps

| Part | State | Remaining evidence |
|---|---|---|
| 3.1 Entry replication | Persistent HLC, LWW, versioned tombstones, add-wins tags, deduplication, fixed replica incarnations, byte-limited change retrieval and small atomic snapshot merge implemented | Local and built invariant tests are building-block evidence; no productive NetBird replication yet |
| 3.2 Large snapshots and continuous exchange | [Snapshot part](ap3-snapshot-transfer.en.md) and [pull worker with atomic stream cursor](ap3-stream-transfer.en.md) implemented and checked as administrative building blocks | [Generation maintenance](ap3-snapshot-maintenance.en.md) implemented and checked; real ten-minute NetBird partition between two hosts passed as a component run ([evidence](../../../test/evidence/ap3-overlay-2026-10-15/README.md)); productive integration open |
| 3.3 Integration into Spaces and service | Open | Policy modes, type/owner rights, fresh import grants for exactly source/target, boot role `entryReplica`, clock health, revocation, deletion barriers and distributed principal deletion also of these histories; set renewal is implemented as an atomic version; exclusive txns/takes in the public adapter still to be rejected |
| 3.4 Complete primary/standby history | [Synchronous storage layer](ap3-primary-sync.en.md), signed transport, primary/sync Spaces in the federation daemon, bootstrap of existing stores and controlled transitions implemented; real runs passed | `CommitSealed` public with resolution in the running host; `NotCommitted` with negative claim for primary/sync Spaces and main store |
| 3.5 `setStandby` and single switch | [Implemented](ap3-replica-control.en.md): transition journal, degradeToSingle, setStandby for an empty quarantine target, write lock of all sources including reaper, boot fencing and external permissions; actually run with netcup and container fencing | — |
| 3.6 Promotion and quarantine | [Implemented](ap3-replica-control.en.md): only a fixed synchronous standby with active permission, verified evidence, new epoch, quarantine only via `release`; netcup and container fencing real, boot guard for replica version and durability, promotion of the control replica actually run | Negative claims implemented; root actually run on control promotion |
| 3.7 Overall operation | Real run through the productive service passed ([evidence](../../../test/evidence/phase3-partition-2026-10-17/README.en.md)): ten-minute partition, process aborts of standby and primary, failover with `NotCommitted`, way back; every decided write exactly once | Router delegation instead of admin grants, failure of a NetBird agent, exhausted storage |

## Building Block 3.1

`EntryReplicationController` stores its own persistent session document
`phi-spaces.entry-replica`. Configuration and document address bind Space ID,
authority, replica ID, incarnation, permitted origins and type rules. All replicas
use the same canonically hashed member/rule contract. Changes to
membership or incarnation on an existing document are rejected;
versioning and rebuilding are later explicit transitions.

Each change retains `(originReplicaId, incarnation, seq)`, principal, absolute
lease deadline, request ID and argument hash. Duplicate delivery creates no
new entry. The same change ID with different content or the same local
request ID with different arguments is rejected. Sequence gaps are not marked as
changes already received; swapped delivery remains possible.
Forwarding changes neither origin nor lease and creates no core events.

LWW requires its own key fields. The order is
`(hlc.physical, hlc.logical, replicaId)`. The HLC clock is retained durably together with the
change. Delete has a regular newer version.
If the winning put version has expired, the key remains invisible;
older puts do not become visible again. A new put of the same fields with a
new absolute deadline is the versioned LWW renewal.

For the set, every add is its own tag. Remove names at most 256 previously locally
observed tags of the same type. A concurrent add survives the remove.
Import may receive the remove before its add; the removed tag identity
is retained and prevents later resurrection. Forwarded changes
are treated as trusted replicator inputs; a hash does not replace
a signature or transport authorization.

## API and Limits

The new API is an **administrative building block** that does not yet start a public
replication service and does not automatically take over existing `PhiSpaces` entries.
`mutate(requestId, mutation)` is its own durable write path;
`read()` returns its view. The normal Space txns, `take`, notify, directory,
grants or the reaper do not use it yet.

| API | Meaning |
|---|---|
| `mutate(id, mutation)` | Local put/delete/add/observed-remove; own metadata is assigned by the controller |
| `importChanges(events)` | Atomic bounded import; origins and metadata retained; no new business operation |
| `read()` | LWW winners and still visible set adds with owner and absolute deadline |
| `changes(afterRevision, maxBytes)` | Byte-limited pages of the durable local receive order; also contains tombstones and remove tags |
| `snapshot()` | Immutable copy of the complete small history including deduplication, with binding and SHA-256 |
| `installSnapshot(snapshot)` | Atomic merge with local holdings; local writes made since the export are retained |

The methods `snapshot()` and `installSnapshot()` remain a single small
atomic import. Large holdings use the new [paged transfer](ap3-snapshot-transfer.en.md). The conservative test `2 × encoded change bytes + 16 KiB` must
fit into the default 192 KiB batch budget. Larger snapshots are rejected before
mutation. The maximum batch budget is 192 KiB, at most 1,024
changes per import; change pages are at most 256 KiB.

The entire encoded history including configuration and tombstones has
a default of 16 MiB, configurable from 16 KiB to 64 MiB. On exhaustion,
new changes are rejected. There is no time-based cleanup and no
loss of remove/deduplication information. Such holdings use the implemented
paged part 3.2 and the implemented cursor worker for large snapshots. Entry fields remain limited to 64 KiB,
members to 32 and type rules to 64.

The operator must provide `authorize(action)` and `assertActive()`. Both are
checked freshly before and within changes and before returning reads.
Without productive source/target grants and verified boot/deletion barriers
this is no operational release. The existing Space boot and deletion controllers
do not automatically take over this new document family; the connection is part of
3.3. Therefore the building block is not yet activated for normal production data.

`clockUncertaintyMs()` is mandatory: from 5 seconds of uncertainty, local
new changes and time-dependent reads are blocked. An observed jump back of the
wall clock by more than 5 seconds also blocks. Incoming HLC timestamps more than
60 seconds in the future are rejected atomically. Repeating a
known local request ID returns the already stored result; it creates
no new effect even with an uncertain clock. Clock-health measurement itself remains
a task of the later runtime integration.

## Scope of Checks

`test/test-entry-replication.test.ts` runs eleven checks: one pure HLC case
and five cases each on JSONL and SQLite. They check simulated ten minutes of
partition, swapped/duplicated delivery, durable HLC after restart,
versioned deletion, expiry without fallback to older values, add-wins,
remove-before-add, unchanged owners, sequence-faithful request retries, import without
partial effect, snapshot merge and loss before/after the actual storage commit.
Further checks concern future clocks, revocation within the commit path,
configuration change, plain-JSON validation and backpressure. Encoded actual
storage writes stay under the batch limit in the checked 32 KiB boundary case.

`scenarios/phase3-entry-replication.mjs` compiles the same cases for the
isolated server test with the one shipped library. The clock is
injected, the replicators are called directly. This is no evidence for
a ten-minute real NetBird partition, productive replication, primary/standby,
promotion or physical deletion of the new history.


## Checkpoint of Building Block 3.1 of 2026-10-15

All 505 repository tests and 24 mobile runtime/lifecycle tests passed;
the type check is green. The eleven new replication cases also pass on the
built server artifact. Library and mobile bundle are byte-identical. The
[evidence](../../../test/evidence/ap3-entry-2026-10-15/README.md) records source states,
artifact hashes, isolated container and complete cleanup. This is
the completion of the first building block described here, not an overall Phase 3 release.


## Evidence of Snapshot Part 3.2 of 2026-10-15

Paged snapshots with durable import progress and atomic publication
are implemented and checked in the isolated server building-block test. 517 repository tests
and 24 mobile tests are green; 23 replication cases additionally pass on the built
server artifact. [Details and operational limits](ap3-snapshot-transfer.en.md).
This checkpoint evidences the snapshot part. The current continuous exchange
is described in the [stream addendum](ap3-stream-transfer.en.md); generation maintenance
and the real overlay partition remain open.


Current stream evidence: 530 repository tests and 24 mobile tests green;
36 built server cases passed. Data and cursor survive the checked
commit losses together; TCP restart and concurrent workers are checked.
[Artifact and source binding](../../../test/evidence/ap3-stream-2026-10-15/README.md).
Generation/receipt maintenance, real NetBird partition and productive integration remain open.


## Generation Maintenance and Synchronous Storage Layer (2026-10-15)

The [generation maintenance](ap3-snapshot-maintenance.en.md) removes redundant copies
page by page and retains the complete causal history. The
[synchronous storage building block](ap3-primary-sync.en.md) seals complete batches before
sending and applies them locally only after durable standby acceptance. Both are
implemented and specifically checked. This does not close the open integration,
fencing and transition points of the table above. Phase 3 remains open until these
evidence items exist.


### Set Lease Renewal

`mutate(id, {kind: "renew", type, tag, fields, owner, expiresAt})` replaces a
locally visible, still live set tag with a new origin tag. Fields and
owner must remain unchanged. The new version removes the observed old
tag in the same event/commit. A concurrent remove of the old tag does not remove
the renewal; after its expiry the old tag does not become visible again.
The renewal can arrive before the original add. On later receipt
the causal field/owner binding is rechecked; self-references are invalid.
Eight cases check this including actual commit losses on both
backends. The public SpaceLike/lease adapter remains part of 3.3.


## Real Partition over NetBird (2026-10-15)

`run-phase3-overlay.py` checked entry replication between the operator host and a container on big over
NetBird: 600.4 seconds of partition (only the own replication listeners stopped), during which on
both sides writes, renewals, a delete and winners expiring during the partition. After restart of both
harnesses and exchange both views are equal (revision 90), deleted and expired items stayed invisible, and
maintenance plus renewed exchange produced no echo. Own rules, group, policy and container were removed.
Limits: component fixture with peer IP pin and private token, no snapshot under load, no productive service.
[Evidence](../../../test/evidence/ap3-overlay-2026-10-15/README.md).


## Test Server for Fencing and Promotion (2026-10-16)

For 3.3–3.6 the netcup server `nanoi` is available as a test primary that may actually be shut down;
vpsc serves as backup/register host. Setup and limits: [test environment §18](../../testumgebung-big.en.md#18-test-server-nanoi-phase-3-test-primary-and-fencing-target).
For the fencing adapter, the netcup REST API access and decision F1 are still missing.

## Integration of lww/set into Service and Router (Draft, 2026-10-17)

The building blocks from 3.1/3.2 hold replicated entries in their own document (`EntryReplicas`), not as normal
Space entries. The integration maps the public Space operations onto this building block. It proceeds in five
steps; each step has its own tests on both backends.

**1. Policy mode and public adapter**

- **Fixed configuration:** The replication configuration of a merge member is provisioned and fixed, as with
  primary/sync. It comprises Space, replica ID, incarnation, the members with their incarnations and the
  rules (type, variant, for `lww` the key fields). A change requires an explicit rebuild because
  the controller binds its configuration.
- **Policy:** A `sync` rule with `variant: lww|set` is valid only if each of its members carries an
  `entryReplication` of equal rules and has no primary replication. The variant and for `lww` the
  key fields must match. With that, the lock "sync activation requires phase 3 implementation"
  falls for these variants.
- **Member service:** The `space` service routes operations on merge types to the controller.
  - `write`: for `lww` a `put`; the key comes from the key fields, missing fields are an error.
    For `set` an `add` with a unique tag. The request ID becomes the request ID of the change, repetitions are
    idempotent.
  - `read`, `readAll` and `count` use the converging view (winning `lww` version, non-removed
    `set` tags, expired versions invisible). Replies carry `replicated: true`, because they may be
    stale.
  - The lease of a merge entry is its visible version (ID from `write`/`read`); only its owner changes it
    (decision 2026-10-18):
    - `lease cancel` deletes: for `lww` a tombstone with its own HLC version, for `set` a remove of this tag.
    - `lease renew` writes a new version with the new deadline: for `lww` a put of the same fields, for `set` a
      `renew`. The reply names the new ID.
    - A retry of the same request ID returns the stored result, even if the entry is no longer visible.
  - `take`, txns and `wait` on merge types are rejected with `MergeTypeNotExclusive`
    (v3 7.2: no exclusive assignment).
- **Root:** For a merge rule the root chooses the target member deterministically by HRW.
  - Writing: for `lww` via the canonical key (missing key fields are an error), for `set` via
    the canonical fields.
  - Reading: for `lww` with a complete key in the template at the key member, otherwise at exactly one member by
    HRW over the type. Asking several members would count entries twice after replication.
  - Exclusive operations (`take`, races, txns) it rejects before a member is contacted
    (`MergeTypeNotExclusive`).
  - Before step 2 a read sees only what lies at the member read.

**State:** Step 1 is implemented (service adapter, policy validation, placement, rejection in the root, provisioned
`entryReplication` in the runtime).

**2. Import through the service:** The members pull the changes of the others with the existing stream worker.

- **Configuration:** `entryReplication` names the shared logical `spaceId` (part of the contract hash, equal on all
  members) and `peers`, that is the other members with replica ID, host, NetBird peer and address.
- **Export:** `entryDescribe` and `entryChanges` are answered by the ingress service only for a proven service peer
  (key proof against the key directory, role `host`, `router` or `admin`) that is pinned as a peer of this
  replication. A revoked key thus ends access immediately.
- **Import:** For each peer an `EntryReplicationPump` pulls the stream. Network errors count as transient and are
  retried; every other error stops the worker, is logged and retried after a pause. The
  identity of the source must correspond to the pinned replica ID.
- **Deviation from the first draft:** Instead of own import grants of the control instance, the pinned
  peer list and the key proof apply; revocation runs through the key directory. There is no own boot role
  `entryReplica`; "active" means an active boot permission for the Space. The clock uncertainty is
  a configuration value (default 1 s); a measured clock health is still missing.
- **Checked:** two fully configured hosts with gates replicate `lww` in both directions and
  converge; a proven but not pinned host gets nothing (`test/test-operations.test.ts`).

**3. Deletion of a principal (draft):** The deletion is itself a replicated change with its own HLC version,
`erase {principal}`. It converges like any other change.

- **Coverage:** all changes with `owner` equal to the principal and a clock before the deletion. A concurrent
  write with a later HLC remains; the procedure therefore first revokes the principal's key.
- **Redacting:** A covered change (`put`, `add`, `delete`, `renew`) is replaced by a redacted form.
  - Retained are ID, clock, type, owner, the original argument checksum and the ID of the deletion.
  - Instead of the key fields it carries, for `lww`, only a hash of the canonical key.
  - `remove` contains no content and remains.
- **Convergence:**
  - A redacted `lww` put continues to compete for its key via the key hash and hides it if
    it wins (like a tombstone). Thus no older version of another owner revives.
  - A redacted `set` add and every `renew` on a redacted add are invisible.
  - If several deletions cover a change, the one with the smallest ID applies.
- **Import:** A redacted form is valid without the deletion; the pages may arrive in any order.
  - A redacted form replaces a local original with the same ID and the same argument checksum.
  - An original arriving after its redaction is recognized by `hash(mutation) === argumentHash` and
    discarded.
  - Only a pinned, proven peer can deliver something like this; it could send tombstones anyway.
- **Physically:**
  - The overlay is rewritten when the deletion is applied.
  - The logical view and every export are always redacted.
  - Snapshot segments are rebuilt by the existing maintenance from the redacted view; the old chunks are
    removed.
  - A running incoming transfer is aborted and the export cache discarded.
  - The deletion is locally complete only after these steps (`erasureStatus`).
- **Distributed:** Deleted everywhere means: every pinned member reports the deletion as locally complete. A
  failed member keeps the deletion open; this is reported honestly.
- **Root:** A merge entry written through the root also lies in its journal. The root history deletion
  must collect the principal's merge change IDs as well.

**State of step 3:**

- **Building block** (`erasePrincipal`, `erasureStatus`, `completeErasure`, `changeIdsOwnedBy`): implemented and checked
  (`test/test-entry-erasure.test.ts`).
  - Three replicas, one lags behind; redacted forms arrive before the deletion; originals arrive after
    their redaction.
  - No older value revives.
  - Renewals of redacted tags are redacted too, independent of their clock, because they copy the same fields.
  - Snapshot segments are cleaned via the maintenance.
  - After `compactErasedSqlite` the SQLite file no longer contains the deleted content.
- **Offline flow of the test-bed daemon:**
  - `erase-evidence` additionally delivers the principal's merge change IDs for the root journals.
  - `erase-local` deletes in the building block and completes the deletion locally; the status is in the result (`merge`).
  - After that the existing step `erase-compact` removes the old revisions.
  - Every merge member runs through this flow; "deleted everywhere" means each reports `complete`.
- **Real run** with two merge members over NetBird, partition and deletion passed
  ([evidence](../../../test/evidence/merge-run-2026-10-17/README.en.md)).

**4. Compaction (implemented):** Events that no longer influence the view are removed once they are
causally stable. A random test compares every compacting replica after each step with a non-compacting
shadow that receives exactly the same inputs.

- **Stable positions:**
  - Each event has a fixed stream position in the logical order. Removed positions are recorded as
    ranges in `dropped` and are never assigned again; without ranges position = index + 1 applies.
  - `describeStream().revision` is the head position. `streamChanges(after)` returns events with positions
    greater than `after`.
  - Pages name their positions in `positions` only if they are not gapless; otherwise the old format remains.
  - If only removed items lie behind the last event, the page is empty and `next` is the head position.
  - Snapshot manifests separate `revision` (head position of the source, starting point of the stream) from `eventCount`.
- **Version vectors:**
  - `describeStream()` reports per origin the gaplessly received sequence (`vector`).
  - The pump stores the vector of every peer with a timestamp (`recordPeerVector`, document
    `phi-spaces.entry-replica-peers`).
  - If a peer reports less than before, it counts as fallen back and compaction stays off. A replica restored
    from a backup therefore needs a new incarnation.
- **Stability:**
  - A needs a vector from every configured member and itself retains its own changes up to there.
    Otherwise `compactionStatus()` reports the reason in `blocked`.
  - The lower bound per origin is the minimum of all vectors; what lies below is stable.
- **Rules:** A candidate is a stable event that is invisible for a stable reason; `erase` is never a
  candidate.
  - **lww:** Superseded versions are candidates. The winner (tombstone, redacted or expired for more than 60 seconds)
    is one only together with all older versions of its key.
  - **set:** A candidate is a tag that a stable remove or a stable renewal has removed or that a
    stable `erase` has redacted.
  - An expired tag is a candidate if its expiry time plus 60 seconds lies before every vector timestamp. Thus
    renewals from before the expiry are already there.
  - A remove and a renewal remain as long as one of their tags remains.
  - A tag remains as long as a not yet stable renewal names it. Otherwise an `erase` arriving later could
    no longer redact the renewal. Every `erase` older than a stable renewal is already here;
    regularly renewed entries therefore keep only their last renewal.
  - Own changes remain at least `requestRetentionMs` (default 24 hours) so that a retry
    finds its change. After that a retry creates a new change.
- **Lower bound:** On publication the lower bound is stored. An unknown change below it
  was removed and is discarded, whether it arrives via the stream, `importChanges` or a snapshot.
- **Flow:**
  - `compact(id)` starts a maintenance generation with `startCompaction`. It records the decision in the job and
    copies only the remaining events.
  - Publication sets segment, `dropped` and lower bound atomically; afterwards the old chunks are retired.
  - If an arriving `erase` changes the copied source, `compact` aborts the generation
    (`abortSnapshotMaintenance`) and the next run starts anew. Expired receipts of earlier generations are removed by
    `compact` beforehand so that periodic runs do not get stuck at the limit of 17 receipts.
  - Only the offline compaction frees the storage space (as with deletion).
  - In the daemon this runs periodically with `entryReplication.compactEveryMs` (at least 1000; minutes make sense
    because a receipt can only be removed after 60 seconds).
- **Deletion evidence for the root:** Compacted changes of a principal are missing in `changeIdsOwnedBy`. The root
  therefore also recognizes replicated views in its journals by their `owner` and deletes them without an evidence ID.
- **Tests** (`test/test-entry-compaction.test.ts`):
  - Positions and old cursor after removal.
  - Random test with eight seeds, partly with a never-compacting replica.
  - Targeted cases: missing, lagging and fallen-back vector; remove with unstable tag;
    tombstone with older concurrent put; renewal with later `erase`; expiry with renewal; retry within
    retention; snapshot after compaction; 20 runs in succession; `erase` during copying;
    renewal chain.
  - Every rule is evidenced by mutation probes: without it at least one test fails.
  - The runtime test compacts periodically between two hosts over proven connections.
- **Real run** with nano-test and standby-100: periodic compaction on both hosts, views unchanged,
  streams continuing afterwards ([evidence](../../../test/evidence/compaction-run-2026-10-17/README.en.md)).

**5. Real run:** passed with nano-test and standby-100: replication, partition with concurrent writes
and convergence, distributed deletion with physical compaction on both hosts
([evidence](../../../test/evidence/merge-run-2026-10-17/README.en.md)).
