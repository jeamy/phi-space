# Synchronous Storage Commit Component

As of 2026-10-15. The component captures the complete `StorageWrite` batches
beneath a harness. It is not yet a productive primary/standby release
and activates no sync mode of the FederationPolicy.

## Sealing and Decision

`PrimarySyncJournal` holds a local SQLite journal with `synchronous=FULL`.
It is not an independent recovery register. Its fixed configuration binds
Space, authority, primary/standby replica, epoch and configuration version.
A deviating configuration on reopening is rejected.

`primarySyncStorage(storage, journal, peer, { assertPrimary })` wraps the
storage before the harness is opened. The callback is checked freshly before sealing and
application; it must check boot/role/fencing authorizations and must
not be a repeated business authorization of the already sealed candidate.
The normal session validates business operations before the storage call.

The journal stores immutable intents with revision, predecessor hash,
batch hash, complete deltas and validation time **before** sending. There is
at most one candidate on the primary that is not applied locally. The standby accepts
only the gaplessly next intent of the same configuration. Identical delivery
returns the same ACK; changed content of the same revision or a gap fails.
The ACK follows the durable journal commit. The standby does not yet need to open a
public Space service for this.

Only after the matching ACK does the primary store data and a small
replication marker in a single actual storage commit. The marker
binds configuration, revision, batch hash and predecessor hash. This lets a
restart recognize a batch already durably applied without executing its
create/append effects twice. Afterwards the local
application position is stored in the journal.

No document kinds are filtered out: claims, transactions, locks,
mailboxes, directory/policy/root documents as well as conversation/task/submission
tables belong to the same intercepted storage batch. This distinguishes this
path from the business entry-changes API.

## Restart and Failure Boundaries

`recoverPrimarySync(...)` must run **before** the harness is reopened.
It checks the materialized prefix and clarifies the exactly stored candidate
with the fixed standby. Deadline, cancel or revocation must not change its business deltas
afterwards. A missing standby or wrong ACK still prevents
a confirmation. An error after sealing yields `CommitSealed`
with revision/hash and the original error cause.

The existing persistence library locks the entire session after a failed storage
acceptance. It may then answer neither further mutations nor reads.
The adapter likewise requires reopening and clarification; there is
no silent asynchronous fallback.

`materializeSyncHistory(...)` applies the completely accepted standby prefix
to its stopped data store before a harness is opened. Answers lost before/after
the storage commit are repeatable. This expressly grants
no promotion or boot authorization.

By default the journal has 256 KiB per intent and a 64 MiB total budget;
both are configurable within bounds, for primary/sync Spaces via `syncSpaces[].journal`
(`maxIntentBytes`, `maxHistoryBytes`; all replicas of a Space the same). On exhaustion it rejects; no
confirmation history is removed by time.

- **Before sealing:** The rejection comes as `SyncBudgetExceeded` (a `StorageRejected`). Nothing is
  written, the session remains usable: reading and smaller writes continue. The service answers
  `ResourceExhausted`.
- **Before:** Until 2026-10-18 a full journal locked the whole session, and every further read failed until
  restart (found while preparing the acceptance).
- **Test:** `test/test-primary-sync.test.ts`.
- **Base of a large Space (2026-10-18):** A Space document writes a complete base every 500 deltas. If
  its value is larger than a journal commit, every further commit of the Space was rejected. On host-a this locked the
  control store as soon as 500 deltas since the last base were pending after a restart.
  - `primarySyncStorage` therefore limits process-wide the size of a base to the intent limit minus 64 KiB
    (`limitCheckpointBytes`).
  - A larger Space keeps its delta chain; a new attempt is made every 50 deltas. Without primary/sync in the process
    everything stays as before.
  - The limit applies to all Spaces of the process and follows the smallest journal; a Space with a very small
    journal budget switches off bases in the entire daemon.
  - Tests: `test-primary-sync` (Space over 256 KiB across 500 commits and a reload), `test-persistence`
    (base every 500 deltas). A non-empty, previously untracked
store is not accepted as a starting prefix. Existing stores need a
later explicitly bound snapshot/stream bootstrap.

## Bootstrap of Existing Stores (2026-10-17)

`bootstrapPrimarySync(storage, journal, ctx)` brings an existing store under primary/sync.

**Prerequisites:**

- The store is opened exclusively: service stopped, no harness.
- The journal is empty, with genesis `durability: "single"`.
- The standby joins afterwards via `setStandby`.

**Flow:**

1. `captureStore` captures the entire live content as create writes, in dependency order:
   conversations, entries ascending, tasks, submissions, then documents of the session, conversation and
   task scopes.
2. From this arise pieces under the intent budget. They are sealed in one transaction as a new chain kind
   (`version: 3`) at the start of the chain. Each piece carries, like a commit, the data marker and in addition the
   checksum of the whole store.
3. The primary writes only the markers. Beforehand it checks the checksum again, also when continuing after a
   crash between sealing and marker.
4. A replica applies the pieces as commits. After the last piece its store must have exactly this checksum,
   otherwise the piece does not count as applied.

**Rules:**

- Business writes are blocked until completion.
- A store that changed after sealing is rejected.
- A single record above the budget is rejected.
- An untracked store still does not open without an explicit bootstrap.

**Limits:**

- Only the current document state is transferred; the as-of history of `rewindable` documents does not
  replicate. In the code nothing reads earlier document states or commit sequences.
- The bootstrap remains permanently in the journal history, since there is no compaction yet.

**Checked** with `test/test-bootstrap.test.ts`:

- a phi-spaces store with Spaces, claims, synthetic conversations, entries and conversation document, in
  several pieces;
- continuation after a crash and rejection of a changed store;
- protection rules;
- optionally (`PHI_SPACES_BOOTSTRAP_COPY`) a copy of the control store of host-a pulled read-only: all Spaces
  are identical on the replica.

## Sealed, Unconfirmed Commit in the Service (`CommitSealed`)

If the standby does not confirm a sealed candidate, its outcome is open: it is either applied later
or excluded by fencing and promotion. Since 2026-10-17 the client sees it this way (v3 6.2/7.2):

- **Error code `CommitSealed`:** The service answers the call whose commit was sealed with it, and afterwards every
  further call for this Space, until the host has clarified the candidate. Unclarified means: the
  storage adapter reports that a commit failed after sealing (`onPoisoned`, also with the reaper); without a
  harness a candidate beyond the applied revision suffices. A commit that is just waiting for its ACK does not
  count; parallel reads continue normally.
- **Client:** `RemoteSpace` turns this into `CommitSealedPending`, a subclass of `OutcomeUnknown` with the same
  request identity. A blocking `read`/`take` waits and sends the same call again. The router treats
  the code like any unknown outcome: step `unknown`, resolution of the same request.
- **No abort:** As long as the candidate is open, no harness opens. A `cancelOperation` can therefore not
  decide it negatively.
- **Clarification in the running host:**
  - `sealedResolver` sets the Space to unclarified and closes the harness (bounded, it may be poisoned).
  - Then it calls `SyncSpace.resolve()` with growing spacing (1 to 30 seconds): check authorization, open
    storage, `recoverPrimarySync` with the standby, harness and boot guard.
  - Afterwards the federation host serves the Space with a new service and reaper (`setSyncSpace`), without restart. A
    primary that starts with an open candidate and without a standby behaves the same way.
  - If the host loses its primary authorization (fencing by a promotion), the attempt stops; the candidate
    is never applied here.
- **Response deadline:** The primary waits at most 15 seconds for the standby's answer (`requestTimeoutMs` of the
  replica transport). Afterwards the commit counts as unconfirmed, and the resolver takes over. Without a deadline a
  cut-off TCP connection held every write for minutes in the real run.
- **Deliberate simplification:** `CommitSealed` applies to the whole Space, not to individual claims.
  - Per claim one would have to read claims from the raw storage deltas or extend the intent by claim keys. That
    would be a new intent version with a different hash and risk with mixed bundles.
  - For the client nothing changes: in every case it keeps asking about the same request.
- **Tests:** `test/test-commit-sealed.test.ts` (sealed write, poll/retry/cancel, waiting take,
  automatic clarification, fenced host, start without standby, reading during a running commit);
  `test/test-membership.test.ts` checks `setSyncSpace` over gate and socket. The wiring in
  `startConfiguredFederation` itself has no test of its own.

## `NotCommitted` after a Promotion

A request whose outcome is unknown after a promotion receives, according to v3 6.2, either its result or a
durable `NotCommitted`; only then may the client start with a new ID.

- **Flow:** `resolveOperation` with an older `primaryEpoch` for an unknown claim. The service asks
  `promotionEvidence` of the journal and then writes with `claims.decideNotCommitted` a negative claim under the
  original key, with method and argument hash.
- **Evidence** (`promotionEvidence`):
  - This host is primary of the current configuration and has no open candidate.
  - Its gapless chain reaches back to the epoch of the request and contains every configuration change since.
  - A primary change is possible only as a promotion with checked fencing; no earlier replica can thus still
    write. A candidate merely sealed there is never applied.
- **Conditions in the claim:**
  - The generation is retained and still permits (otherwise `RequestExpired`).
  - It stems from this incarnation and authority and is not younger than the epoch of the request.
  - The epoch of the request is older than the current one.
  - No restore, no authority change, no `recoveryBlocked` (otherwise `IncarnationChanged`).
- **Without evidence** it remains `IncarnationChanged`; the router submits the work for review (`needsReview`).
- **Effect:** Negative claim and acceptance run in the same commit scope. A delayed original call hits the
  claim and gets `NotCommitted`, without effect. Poll and `resolveOperation` return `done` with error
  `NotCommitted`. For retention the periods of the other decided claims apply.
- **Router:** `NotCommitted` yields a failed step without effect.
  - Delegation check and epoch check of the frame let `resolveOperation` of an unknown request of an older
    epoch through; the decision is made in the service. Otherwise the step would remain `unknown` forever with `StaleEpoch`.
  - If the router has not yet taken over the new replica configuration, the member answers `ReplicaConfigPending`.
    The router asks again later.
- **Tests:** `test/test-not-committed.test.ts`, with a real promotion (simulator fencing) and `degradeToSingle`:
  - a confirmed request keeps its result;
  - the request sealed only on the old primary becomes `NotCommitted`;
  - the delayed original call remains without effect;
  - without evidence it remains `IncarnationChanged`;
  - the rejection cases are checked.
  - `test/test-delegation.test.ts` checks the same case via a signed router delegation after an
    epoch change: without evidence `IncarnationChanged`, with evidence `NotCommitted`; the delayed original call
    remains without effect, the router record is `failed`.
- **Main store with `mainSync`** (control Space): The daemon passes the evidence of its journal via the factory
  `mainPromotionProof` to the main service (`startFederationHost({ promotionProof })`). This wiring has no
  test of its own; the decision itself is checked by the tests above.

## Integration and Still-Open Overall Guarantees

The adapter applies to a dedicated complete storage area with one
replica configuration. Several Spaces of one harness with independently changing
replica versions still need a suitable separation or a
complete atomic domain contract. The existing productive stores are
not wrapped afterwards without checking.

Boot/deletion integration including the new journal remains open. Service transport, bootstrap of existing stores, real fencing and control/router switchover
have meanwhile been implemented and run for real. Configuration transitions, `setStandby`,
degradeToSingle and promotion have existed since 2026-10-16 with a simulator adapter
([replica control](ap3-replica-control.en.md)). Therefore productive sync rules remain blocked by the existing
policy validator. An ACK of the journal component is no promotion evidence.

16 new cases on JSONL and SQLite check lost ACKs, failure before acceptance,
commit losses before/after primary and standby application, unchanged candidates,
claim replay, transactions, configuration conflicts, wrong ACKs, gaps/forks,
untracked data and damaged markers. The complete current
evidence (`test/evidence/ap3-next-2026-10-15`, not kept in the repository) contains the built
server run. Physical storage/host loss and power loss thereby still have
no new overall release.
