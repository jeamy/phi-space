# phi-spaces: current implementation status

As of 2026-10-16. This page is the reference for the current state of the code and its automated evidence. The
[federation plan v3](federation-plan-v3.en.md) remains the target contract: its guarantees do not hold merely because
individual building blocks listed below already exist.

Note of 30 October 2026: Evidence below that mentions "JSONL and SQLite" or harnesses dates from the time before the
[phi-spaces store](umstellung-ohne-pi-durable.en.md). The suite now runs on the SQLite phi-spaces store;
JSONL remains only for agent research runs.

Addition of 18 October 2026: The help system/demo findings F01-F23 were addressed
with targeted local regression tests. Changes, evidence and deliberate limits are recorded in the
[implementation table of the analysis](_attic/analyse-hilfesystem-demo-apps-2026-10-18.en.md#7-step-by-step-implementation-of-18-october-2026)
and in the [runtime contract of the help system](../help-site/README.md#runtime-contract-and-restart).
`PhiSpaces.write` and `RemoteSpace.write` support an optional atomic
singleton creation through `unique` key fields; older remote servers without
`write.unique` are rejected for this. This is a local/RPC extension, not a new promise of
global uniqueness or of accepted replication.

The [corpus consistency check of 18 October](_attic/analyse-hilfecorpus-konsistenz-2026-10-18.en.md)
adds eight bilingual practice guides, API signatures derived from TypeScript,
60 compiled documentation examples, and verified navigation, live mirror and shutdown.
The standalone client and a fresh Next production build were checked locally. The report separates
completed local corrections from deployment, load and failure acceptances that are still open.

## Scope and limits

The [complete renaming](namensumstellung-2026-10-18.en.md) now also covers all
persistent `phi-spaces.*` document types and the `phi-spaces.mjs` bundle. This is an
incompatible namespace/integration change, not an automatic migration of existing stores.
Production legacy data and external mobile consumers were not converted in this repository run.

A Space is a persistent document in the phi-spaces store (`src/store/`, SQLite; pi-durable only remains in the
`agent/` package).
The default Space (`phi-spaces.space`) and named Spaces
(`phi-spaces.named-space`) have document version 5. A registry maps aliases to
immutable `spaceId`s; entry views additionally carry
`gid = <spaceId>/<localId>`.

The local client `PhiSpaces` and the service `SpaceService` use the same
core semantics. The service can be used over in-process, Unix-socket and TCP transport;
`RemoteSpace` implements the common base contract
`SpaceLike` for this. Gate, overlay identity, key challenge, enrollment, grants and
supervisor are combined into a persistent host runtime. There is
a persistent router skeleton (AP 2.1) and a simulator (AP 2.8);
phase 2 is complete with a documented exception for block 4; the operations extension (runs, workers, Spaces, bootstrap, mobile control) is implemented; replication and promotion have begun but are not accepted. The [phase 1b acceptance](_attic/abnahme/ap1b-abnahme.en.md) separates local evidence from the
completed operations and device acceptances in the verified F15 model.

| Building block | Present | Not derivable from it |
|---|---|---|
| Core | Entries, templates, leases, txns, notify, waiters, limits, revision log and completion profiles | global ordering or external exactly-once effect |
| Local client | `PhiSpaces`, named Spaces, claims, pages, changes | access to a foreign host without a service |
| Service | Role/type checks, signed generations, durable pending/poll, mailbox ACK, token pages and quotas | replication or accepted recovery operation |
| Remote | `RemoteSpace`, stable retries, notify/wait/events/ACK, Unix/TCP, pi-server adapter, key proof, enrollment, grant provider and rotation | automatic federation provisioning |
| Phase 1b | two durable real NetBird gates on big, independent register on vpsc, private SSH/TLS access paths, control ACK, control/data restore controllers, member installation, native Android Keystore acceptance, real phone-big pairing/object access/rotation as well as distributed live data/control restores with confirmed member ACKs, visible phone key control, ten minutes of screen-off/background and a controlled deep Doze test | F15 model and controlled component-level failures accepted; no phase 2/replication/promotion release |
| Router AP 2.1 | Command state machine, durably bound sub-requests, reconstruction, separate budgets, fixed optional journal partitions, independent admission, restore review and mailbox takeover | complete phase 2 system and load acceptance |
| AP 2.2-2.5 | signed RouterLease/delegation, policy, HRW, FederatedSpace, txn binding, waiter race, membership and local admission; real TCP gates and persistent restart checks | AP 2.6/2.7/2.9, automatic provisioning of the root composition and a public virtual Space address |
| Router load case AP 2.9 | 10,000 entries, 1,000 jobs, six workers, 5,000 router operations on four SQLite stores; 36 lost replies, root reopen, result and journal check on the built server artifact | transport of this evidence with fixture identities in the same process; separate overlay abort blocks 1-3 completed; historical native negative measurements documented separately; block 4 closed by decision |
| NetBird wire check phase 2 | 1,000 sieve jobs, three members, six workers with real peer gates, app key proof, signed grants/RouterLease/delegation; additionally 10,000 entries and 15 lost successful replies checked; lease deadlock, parent reservation release and typed resolution errors secured by regression tests | fixture provisioning in four network spaces on one server; overlay abort blocks 1-3 completed; complete native production acceptance remains open |
| NetBird member process aborts phase 2 | 30 actual member SIGKILLs before admission/after durable completion; eleven starts each with the same target binding, one root start; 1,000 jobs/10,000 entries; all 24 worker effect aborts with six running workers; audit of all 5,000 original claims | Phase 2 complete except block 4; no promotion/boot/power-loss release |
| NetBird ACK aborts phase 2 | Six actual root SIGKILLs before/after ACK on three members with six active workers and 1,000 jobs; stable winners, twelve returned losers; audit of all candidates, cursors and 5,072 original child claims; shared transport proofs secured by regression tests | Phase 2 complete except block 4; list in the phase 2 acceptance |
| NetBird root process aborts phase 2 | 10,000 initial entries, 1,000 jobs, six fixed workers, three members; 30 actual root SIGKILLs at five RPC effect kinds before/after send or reply; 31 starts with the same lease/epoch; audit of all 5,000 original member claims | Targeted root journal boundaries are accepted in block 3; block 4 closed by decision; historical native negative measurements are preserved; ACK and member evidence are listed separately |
| Process crash matrix phase 2 | 20 confirmed SIGKILL cases on JSONL/SQLite locally and on the built server artifact: journal, RPC and ACK boundaries; stable original requests, winners and replay; no open reservations | Fixture RPC and fixed clock, four stores in the same process; separate NetBird full load shown in blocks 1-3; physical failure domains shown separately in block 5 |
| Simulator AP 2.8 | several real JSONL/SQLite harnesses, deterministic transport faults, clock jumps, crash/reopen and an independent reservation/request counter-model | real overlay/replication/fencing evidence |
| Operations | Test bed and scenario `sieve-remote` | production release of the federation or of mobile operating procedures |
| Run, worker, Space and deployment control (operations extension B2-B10) | RunGate in the core, `RunController` with journal, signed gate instructions to remote members, admin commands, recovery reconciliation after restore, worker assignments with local supervisor, Space lifecycle, deployment plan/apply with CLI; acceptance cases 2, 3, 4, 8-13 locally, case 3 additionally over real NetBird | SSH/NetBird provisioning and pairing in the bootstrap, mobile control against a coordinator on big; workers only as loops in the daemon process |

## Data and consistency model

- Entries have `{ type, types?, fields }`; `types` holds the main type and
  optional supertypes. A template can contain `type`, `fields` and `id`;
  `null` or missing template fields are wildcards. Field comparison is deep
  JSON equality.
- `write` always creates a new entry. A `take` is either directly destructive or
  reserves under a transaction; abort or lease expiry makes the entry available
  again. Writes of a transaction stay invisible until commit.
- `read` and `take` wait until the timeout. The `IfExists` variants wait only
  while matching entries are locked by foreign transactions.
- Claims bind a mutation or a blocking read/take and its result atomically to
  `{ principal, generation, requestId }`. A retry with the same arguments
  receives the stored result; it does not repeat the mutation. This
  does not cover external side effects.
- Every functional or internal state change receives one revision per storage txn and Space.
  `readPage` returns `token`, `rev` and `streamId`; `changes` returns bounded entry batches,
  and for pure state changes also empty batches. This is not a complete primary replication stream. After an
  expired log history a new page snapshot is required.

## Resource and access limits

Default values are defined in `DEFAULT_LIMITS` and are stored per Space
in the document. They include 64 KiB per entry/handback, 64 MiB
entry fields in total, 32 MiB claims, 8 MiB outbox, 128 MiB total document,
192 KiB commit, 256 KiB frame, 160 KiB event and 4 MiB revision log. Further
owner quotas limit entries, registrations, waiters and transactions. Mailboxes are limited to
8 MiB and at most 7 days, snapshot caches per Space to 64 MiB/16 tokens/60 s;
durable follow-up jobs to 16 MiB. Later subscriptions update txn reservations;
limits must not fall below existing completion obligations.

Conversation clients own the transactions, leases,
registrations and waiters they created. Host code without `as` is administrative; only it can
change limits. The service derives identity exclusively from its
`IdentityAdapter` and checks methods and allowed entry types by policy.

## Evidence

The [AP 1 acceptance](_attic/abnahme/ap1-abnahme.en.md) describes the new regressions, the persistent v4 fixture,
mailbox TTL/ACK, profiles, bounded maintenance and the real pi-serverd with the built bundle.

`npm test` covers core, persistence, claims, budgets, stream, service,
`RemoteSpace`, socket, scenario and TUI. The socket test includes parallel
calls, lost replies, host restart and TCP on loopback. The test bed
additionally runs the production-like scenario `sieve-remote` over the
NetBird overlay. Details and the security and federation gates that remain open are in the
[implementation plan](_attic/implementierungsplan-v3.en.md)
and in [testumgebung-big.en.md](testumgebung-big.en.md).

## Distinction from older documents

[spaces-v1.md](_attic/spaces-v1.en.md) describes the local state of 2026-10-07 and
is kept as a historical snapshot. Its open points L2, L3,
L7 and L13 are superseded by revisions/changes, global IDs, byte budgets and
byte-bounded pages. Historical v1/v2 federation plans are not an
implementation specification.

The usable API is in [api.en.md](api.en.md).

## Mailboxes and task completion

Remote events address structured principals. ACK confirms only an already
delivered contiguous prefix of the matching epoch, not task completion. After TTL loss
the server reports a gap and a new epoch; unconfirmed take events lead to the durable release
of the associated transaction. ACKed takes keep their separate txn decision. Completion profiles
check result type, assignment fields and count before commit; the sieve uses them in the named Space.

Pending RPCs need no old caller after reopen: separate persistent waiters hold the
execution data, claims keep hash/deadline/result reservation. `ResultExpired` does not repeat any effect.
`count`/`stats` and the revision delivered with them come from the same snapshot in the service.

## Phase 2

[Router and simulator](_attic/abnahme/ap2-router-und-simulator.en.md) as well as
[AP 2.2-2.5](_attic/abnahme/ap2-delegation-routing-membership.en.md) are implemented:
RouterLease, original-principal delegation, persistent policy, HRW/search rules,
journaled federation operations and membership with core admission.
The new APIs are server-side building blocks with a real member RPC adapter;
they do not automatically start a virtual public Space address.
Check numbers and built artifacts are in
[checks.json](../test/evidence/ap2-2026-10-11/checks.json).

AP 2.6/2.7 are extended by completion budgets, audited local admin building blocks,
restore reconciliation and the protected directory. The member load test
for AP 2.9 and the [phase 2 acceptance](_attic/abnahme/ap2-abnahme.en.md) document the evidence
and its limits. Phase 2 is complete with the explicit exception for block 4:
The fixed journal partitioning and the signed three-member sieve over NetBird
are shown. The overlay abort blocks 1-3 are now complete,
including 26 targeted journal aborts under full job load. All eight technical acceptance blocks are now complete;
[gate 4 and final operating values](_attic/abnahme/ap2-gate4.en.md) are closed for the demonstrated profile; an unrestricted native production release is not declared.
Block 5 has live evidence between a physical local machine and a
server, including an isolated member SIGKILL and a bound read replay. Block 4 was closed by explicit decision of 2026-10-15;
block 8 has live evidence with root abort and replay. The four network spaces on big
do not replace independent physical failure domains.

`createConfiguredRoot` provisions a native hosted-agent root together
with control: separate active router/host keys, fixed member target tuples,
independent boot/authority checks, persisted RouterLease and
MemberStatus probes. Administrative membership and profile commands require the
configured, currently authorized supervisor administrator. A public
virtual root Space endpoint is not implemented by this. The dedicated
live setup and a fencing rejection are verified. Block 4 will not be reopened, in accordance with the
decision of the principal on 2026-10-15; historical
native negative measurements are not reinterpreted as passed tests.

The local batchwise principal erasure and `RootHistoryErasure` have
durable progress and crash recovery. The latter erases its own and
affected foreign cached parent/child content, preserves bound IDs and
refuses their effect replay with `ResultExpired`. This is tested on both
storage backends. `DistributedPrincipalErasure` now coordinates
fixed-bound participants with independently stored progress: it locks all
writers, collects all entry evidence, erases locally and in root histories,
installs epochs, cleans up archives, seals all floors
and only then releases boot permissions. Restart tests interrupt every
coordinator progress boundary before and after the durable CAS. The live run
with five participants passes, including a process change before the root
erasure and the original `ResultExpired` replay after restart.

Independent erasure epochs block stale restores and normal services on
incomplete erasure. `ErasureArchiveController` manages registered
archives, quarantine, verified erasure receipts and a bounded erasure deadline.
The SQLite register enforces monotonic erasure epochs and immutable
archive bindings within its CAS commit. Late archive registration,
resetting quarantine and deleting catalog receipts are rejected;
the seal check reads the archive catalog in the same transaction.
The tests check real backup files and restart. `compactErasedSqlite`
consolidates exclusively session-wide phi-spaces documents of an exclusively
locked SQLite store (pi-durable schema 1), preserves current values, IDs,
revisions and replay receipts and removes old revisions and free pages
by means of secure delete, checkpoint and VACUUM. The new test checks the
actual disappearance of old payload bytes and the subsequent reopen.
The passed operator run binds its own backups to hash and Space epoch,
checks actual DB/WAL/SHM files and empty archive directories and
refuses the restore of all five old backups. External
volume/provider snapshots still need their own registered
erasure rules; SQLite cleanup is no evidence of secure media overwriting.

`ProfileTransitionController` freezes idle members, installs a
pure profile change, publishes the next policy and reactivates members.
Unclear replies keep the frozen state and resume with
the same IDs. Crash/restart tests pass on both backends;
the distributed live evidence has existed since 2026-10-15: the same supervisor
command completed after a root SIGKILL in `freezing` with policy version 5,
and all three members were active afterwards. In the process, the start of the
protected control listener before resumed remote jobs was corrected
and secured by two persistent TCP tests. RunGate and replication
follow later.

The wire recovery check of 2026-10-13 adds targeted lost successful
RPC replies. Typed definitive errors during claim resolution
now durably lead to `needsReview` instead of an endless loop of transport
retries. Requests that failed before acceptance still need
a safe authoritative negative resolution; existing status delegations require an
already bound claim. Details are in the [phase 2 acceptance](_attic/abnahme/ap2-abnahme.en.md).

`resolveOperation` now adds admission resolution for a missing
own claim in a valid generation bound to the same primary epoch. The router checks all target/request/hash bindings and repeats
exclusively the same child. This makes the pre-send RPC case closable with an
unchanged primary. Known pending claims keep their
deadline and authorization check. After promotion, restore or expiry
`needsReview` remains; terminal `NotCommitted` negative claims with complete
promotion evidence remain a separate step that is not accepted.


The NetBird full-load evidence of individual member process aborts of
2026-10-13 completes test block 2. After completion of block 3 the current list comprises five open
test blocks plus the overall release. When transport is lost during child
preparation, an already stored parent now remains resumable as pending with an
unchanged routing plan. The error classification is checked on
JSONL and SQLite; functional and permission errors remain definitive
errors. Details and limits are in the [phase 2 acceptance](_attic/abnahme/ap2-abnahme.en.md).


Test block 3 has been accepted since 2026-10-14: 26 actual root SIGKILLs
before/after 13 successful journal transitions over NetBird in five complete
1,000-job/10,000-entry runs with six active workers, each with offline
audit. The current list contains five remaining test blocks. The native
root configuration is wired and checked separately; its production
live acceptance has therefore not been granted.


Error handling also distinguishes provisionally unknown effects from
explicit transaction/completion violations on the wire. The latter lock
child and parent durably for review; restart does not trigger an additional
effect. Identical signed member policies are confirmed after a protected query
and renewed authority check without a mutation commit. The complete
suite comprises **462 passing tests** on 2026-10-14; the live
acceptances still missing remain separate from this.


## Gate 4 (2026-10-15)

The [final operating values](_attic/abnahme/ap2-gate4.en.md) are fixed by existing full-load evidence
and a supplementary built-server limit test: frame 256 KiB, commit
192 KiB, 32 connections per peer / 64 per listener, peer detection 5 seconds,
snapshot 60 seconds / 16 tokens / 64 MiB and generation one hour. The gate
now starts detection at TCP accept; silent connections bypass neither
timeout nor peer quota. Two new gate regression cases and a built
5-second check secure this. The layer B challenge is valid separately for 30 seconds.
The phase 2 closing decision remains explicitly limited to its documented
scope with the exception for block 4; phase 3 is not yet accepted.


## Phase 3: first replication building block (2026-10-15)

[Entry replication and further steps](_attic/abnahme/ap3-replikation.en.md):
`EntryReplicationController` implements persistent change IDs/HLC, LWW
with versioned tombstones, add-wins tags, byte-bounded change pages and
a small atomic snapshot merge on its own documents. Eleven targeted
checks cover JSONL and SQLite including actual commit losses.
The building block is not yet integrated into the public Space service, policy, boot
and erasure barriers; primary/standby and promotion remain open.
The existing entry changes API is not used as a complete primary commit
history. Phase 3 has no overall release yet.

The final check of this building block consists of 505 green repository tests,
24 mobile tests and eleven cases on the built isolated server artifact.
[Evidence](../test/evidence/ap3-entry-2026-10-15/README.md); no production
replication was activated.


## Paged entry snapshots (2026-10-15)

The [snapshot transfer](_attic/abnahme/ap3-snapshot-transfer.en.md) extends AP 3.2 with durable
staging, hash chains, stored page/source cursors and atomic visibility
through generation references. Local overlay writes and existing changes cursors
are preserved; document version 1 migrates to version 2. Twelve new cases
check both backends including commit loss at the start, every page
and completion. Public replication transport, generation maintenance and the
production rights/boot/erasure integration remain open.

Current snapshot evidence: 517 repository tests and 24 mobile tests green;
23 built server cases passed.
[Artifact and source binding](../test/evidence/ap3-paged-2026-10-15/README.md).


## Continuous entry stream (2026-10-15)

[Source-bound stream cursors and pull workers](_attic/abnahme/ap3-stream-transfer.en.md) are
implemented. Data and progress are stored in the same commit;
snapshot R can be taken over from a verified published receipt.
Concurrency, resumption, TCP failure and abort have targeted tests on
JSONL and SQLite. The worker starts only explicitly and is not yet provisioned as
a public NetBird/Space service. Generation maintenance and the
production rights/boot/erasure integration remain open.


Current stream evidence: 530 repository tests and 24 mobile tests green;
36 built server cases passed. Data and cursors survive the verified
commit losses together; TCP resumption and competing workers are verified.
[Artifact and source binding](../test/evidence/ap3-stream-2026-10-15/README.md).
Generation/receipt maintenance, real NetBird partition and production integration remain open.


## Snapshot maintenance and synchronous storage building block (2026-10-15)

[Durable generation maintenance](_attic/abnahme/ap3-snapshot-maintenance.en.md) and the
[complete synchronous storage path](_attic/abnahme/ap3-primary-sync.en.md) are implemented.
Eight maintenance cases and 16 sync cases check actual commit losses on
JSONL and SQLite. The sync building block initially applies to a dedicated store and
is not yet integrated into policy, public claim status, boot, erasures and
primary/standby transitions. Phase 3 explicitly remains open.

## Replica control (2026-10-16)

[Promotion, degradeToSingle and setStandby](_attic/abnahme/ap3-replica-control.en.md) are implemented with a
simulator adapter. Configuration changes are entries of the sync chain,
transitions are journaled by ID and resumable after crashes, boot states
`fenced`/`quarantine` run via CAS over the independent register. Eight cases on
JSONL and SQLite check, among other things, crashes before the boot CAS, forks of the old primary
and the rejection of simulator evidence. Acceptance remains blocked by F1/gate 2
(real fencing adapter); 3.6 is only partially implemented.

Addendum 2026-10-16: The netcup fencing adapter with mTLS service on vpsc and a signed replica transport
are implemented. A fixture run over real hosts passed, with nanoi as primary and 100 as standby
([evidence](../test/evidence/phase3-sync-2026-10-16/README.en.md)). The run comprised:

- fork without ACK;
- netcup power-off;
- promotion, degradeToSingle and setStandby;
- identical states at the end.

Still open are the integration into the production Space service, `ReplicaConfigNotice`, pausing all
write sources and 3.8.

Addendum later on 2026-10-16:

- Write lock during transitions, complete boot guard and `ReplicaConfigNotice` with takeover in the router
  are implemented.
- primary/sync Spaces run with their own store in the federation daemon, including quarantine start.
- A real daemon run on nanoi and 100 passed
  ([evidence](../test/evidence/phase3-daemon-sync-2026-10-16/README.en.md)): fork without ACK, netcup fencing,
  promote, degrade, quarantine, setStandby, writes in both directions, identical states.
- Open: router takeover on real hosts (host-a needs the new bundle) and 3.8.

Addendum 2026-10-17 (3.8):

- The control store of host-a was moved to primary/sync by bootstrap.
- It went through setStandby → degradeToSingle twice with the standby `control-standby-nano` on nanoi and
  netcup fencing and ends `single` again ([evidence](../test/evidence/control-sync-hosta-2026-10-17/README.en.md)).
- A bug was found and fixed in the process: The daemon did not exit after SIGTERM when the main store was running in
  sync operation.
- Open: promotion of the control replica and step 6.

Addendum 2026-10-17 (real router path):

- A native root on host-a admitted a replicated member on nano-test and standby-100 by `addMember`
  and routed writes to it.
- After promotion with netcup fencing and degrade to 100 it took over the `ReplicaConfigNotice` and continued
  routing; afterwards everything was reset ([evidence](../test/evidence/root-hosta-2026-10-17/README.en.md)).
- Two overlooked places from 3.8 were found and fixed: the root's journal guard and the
  renewal of the retained router lease still compared the epoch of the Space document.
- For this the test bed daemon has the lock-free mode `enroll-key` for additional keys of a running host.

Addendum 2026-10-17 (step 6):

- Control transitions are now also possible with an installed routing policy. The first start after a transition
  reconciles the policy (marker, `policyVersion`) before grants, router lease or root exist.
- The router lease renews itself across a transition with the same primary; the root distributes the `EpochNotice`.
- Real run on host-a with root, member and policy: `setStandby`, `degrade` with netcup fencing, root restart
  after lease expiry, routed writes afterwards; everything reset
  ([evidence](../test/evidence/step6-hosta-2026-10-17/README.en.md)).

Addendum 2026-10-17 (promotion of the control replica):

- Container fencing (`ContainerFencing` behind the mTLS fencing service) and the change of the control host under
  the same authority (`ControlHostChange`, signed by the recovery admin, recorded by the register only after the
  promotion, taken over by the hosts at start) are implemented.
- Real run on big in both directions: host-a → host-c → host-a, the members followed each time
  ([evidence](../test/evidence/control-promotion-2026-10-17/README.en.md)).
- Fixed in the process: permissions of the sibling Spaces for the `setStandby` target, the fencing target when
  resuming a promotion and a blocklist for source addresses in the fencing service.

Addendum 2026-10-17 (router change, 3.8 complete):

- A new router takes over the root journal with `takeover` only after the previous lease has expired, with a higher
  router epoch; the supervisor issues no lease to another router while the previous one is alive.
- Hosts follow a control change during operation (check every 15 seconds, restart via code 75).
- Real run with root and replicated member in both directions
  ([evidence](../test/evidence/root-promotion-2026-10-17/README.en.md)); host-a reset afterwards.

Addendum 2026-10-17 (lww/set integrated):

- Merge types run in the `space` service over the replication building block; the root places them by key or
  fields and rejects exclusive operations.
- Members replicate their change streams over proven, pinned connections.
- The erasure of a principal is a replicated change with redaction; the existing offline compaction physically
  removes the old revisions.
- Real run with nano-test and standby-100: partition, convergence, distributed erasure
  ([evidence](../test/evidence/merge-run-2026-10-17/README.en.md)).
- Compaction (step 4): stable stream positions, version vectors of the members, floor per origin;
  only stable, invisible events are removed ([rules](_attic/abnahme/ap3-replikation.en.md)). Periodically in the daemon via
  `entryReplication.compactEveryMs`. Real run with nano-test and standby-100
  ([evidence](../test/evidence/compaction-run-2026-10-17/README.en.md)).

Addendum 2026-10-17 (sealed commits): A sealed, unconfirmed primary/sync commit is publicly
`CommitSealed`; the host resolves it with the standby and serves the Space again without restart
([procedure](_attic/abnahme/ap3-primary-sync.en.md)). After a promotion the primary answers an unknown request of an older
epoch with evidence by negative claim with `NotCommitted`.
Overall operation 3.7 ran for real: ten-minute partition, process aborts, failover with `NotCommitted` and return path
over the production service, every decided write exactly once
([evidence](../test/evidence/phase3-partition-2026-10-17/README.en.md)). Found and fixed: unbounded waiting of the
primary for the standby (`requestTimeoutMs`).
`degradeToSingle` also works without a fencing adapter: Then only the standby permission of this Space is revoked,
the host stays active ([procedure](_attic/abnahme/ap3-replica-control.en.md)).

Set lease renewals now atomically create new tags; owner and fields remain
bound, and old tags do not become visible again after the renewal has expired.
Eight additional persistent cases check replay, concurrency and lease expiry.


## Run control: RunGate, RunController and run recovery (2026-10-16)

Steps B2-B5 of the [operations extension](betrieb-und-mobile-steuerung.en.md#8-implementation-status-and-order-of-the-operations-extension) are implemented:

- **RunGate in the core:** protected control state per run in the Space document (not an entry). A
  `CompletionProfile` with `gateField` (mandatory: finite `maxLeaseMs`) makes tasks takeable only when `running` without fence,
  also for waiting takes and host code; the take binds the txn to the revision. Pause/stop install
  a fence first and switch only without a bound txn. The same revision with a different command results in
  `RunGateConflict`. Locked profiles cannot be removed under an active run, neither locally nor by federation policy.
- **RunController** (`src/run-controller.ts`): journal `phi-spaces.run-controller`, start with preparation behind
  `preparing`, pause/resume/stop with ACK barrier, `pauseIncomplete` for missing ACKs, `advance` after restart.
  Open transitions carry control authority and incarnation and are never sent again after a change.
- **Remote members** (`src/run-member.ts`): signed instructions and ACKs, method `runGateInstruction` in the gate,
  only registered preparers per run kind; admin commands `startRun`, `pauseRun`, `resumeRun`, `stopRun`,
  `reconcileRun`, `resolveRunRecovery`; server-side continuation via `control.runs` in `startFederationHost`.
- **Run recovery:** recovery entry lock per gate, `RunRecoveryView`, data restore imports gates of the
  snapshot as evidence (restore stage `gates`); `reconcile` confirms only unambiguous paused/stopped situations
  automatically, otherwise `needsReview`; `resolve` is bound to the view hash and checks each member by
  compare-and-set.

Evidence: `test/test-run-gate.test.ts`, `test/test-run-member.test.ts`, `test/test-run-recovery.test.ts` (31 cases, JSONL and
SQLite, commit errors, controller restart, lost ACKs, TCP over the composed gate) and a run over
the real NetBird overlay between operator host and a container on big
([evidence](../test/evidence/run-gate-overlay-2026-10-15/README.md); layer A there as fixture pin).

Limits: Gate changes are charged against the budgets at a fixed 1 KiB, the history holds 32 revisions per
run, `stopped` gates are not yet moved into run history (at most 256 gates per Space). A
control restore (change of the control incarnation) and a member under restore lock start `reconcile` at the
next `advance` or command themselves; without a command or open transition the controller notices a data restore
only at the next action. The server-side continuation loop has no automatic test of its own.


## Worker control (2026-10-16)

Step B6 of the operations extension: The control host holds the desired state per host in the journal
`phi-spaces.worker-assignments` (admin command `setWorkers`, idempotent, monotonic generation). A host fetches only its
own signed share via the gate method `workerAssignments`; the proven active
host key of the connection is authoritative. The host's `WorkerSupervisor` accepts only validly signed, newer lists of the same
control identity, stores them and reconciles registered worker kinds: scaling, stop after the running task,
restart on a new target, rejection of unknown kinds or foreign Spaces, backoff up to 5 s when no work can be taken.
After a restart the stored workers keep running even without a reachable coordinator. The applied
state returns as `metrics.workers` via the existing capability heartbeat (`appliedWorkers`).

Evidence: `test/test-workers.test.ts` (11 cases, JSONL/SQLite), including a locked sieve run that two workers
compute completely after pause and resume, and the gate method over TCP. Limits: Workers run as asynchronous loops
in the daemon process and bring no CPU parallelism; the periodic heartbeat of the host is not yet sent by
`startFederationHost` itself.


## Space lifecycle (2026-10-16)

Step B7: `SpaceLifecycle` creates named Spaces idempotently (an existing alias is reused
unchanged), archives them (readable, no new work), reactivates them and deletes only archived, empty
Spaces without federation membership, open work, retained claims, mailbox results or unstopped runs.
The spaceId stays reserved in the registry as a tombstone; `listSpaces`, `resolveSpaceId` and `snapshotSpace`
no longer know deleted Spaces. The control host sends signed instructions to the target host
(`spaceLifecycleInstruction`); admin commands `createSpace`, `archiveSpace`, `reactivateSpace`, `deleteSpace`.
Evidence: `test/test-space-lifecycle.test.ts` (JSONL/SQLite, restart, TCP over the gate, supervisor command).


## Deployment bootstrap (2026-10-16)

Step B8: `validateDeployment` checks a declarative config (`schemaVersion: 1`, aliases only, no secrets)
and returns all errors. The coordinator's `DeploymentController` holds the alias→ID mapping, plans without
effect and applies idempotently: Spaces via the lifecycle (B7), workers as an assignment with count 0 (B6), start
separately via `startWorkers`. A new config revision reuses existing Spaces and running workers unchanged;
conflicts (host change of a Space, changed definition of running workers, Space with different limits) are
reported instead of applied. The CLI `npm run bootstrap` checks offline (`--check`) and otherwise sends admin commands
over the gate. Not included: SSH provisioning, NetBird join, initial setup and pairing; they remain
prerequisites that the plan makes visible as `blocked`. Evidence: `test/test-deployment.test.ts` (JSONL/SQLite, two
stores, crash and resumption, CLI as paired admin over the real gate).


## Mobile control (2026-10-16)

Step B9 in the sibling project `pi-termux-mobile`: The page **Spaces-Steuerung** shows operations, runs and workers
and sends admin commands over the paired control connection. The command ID is stored in the private
profile before sending; retries, timeouts and restarts reuse it, and an unclear outcome is displayed as
"Ausgang wird geprüft" (outcome being checked). New read-only admin commands on the coordinator: `listRuns`, `runStatus`,
`listWorkers` (desired assignments and last reported state per host). Evidence: mobile test of the bridge and
device acceptance on the Xiaomi against a coordinator in production composition over WLAN, including coordinator crash and resending of the same ID, and over NetBird with peer identity from the management API ([evidence](../test/evidence/b9-device-2026-10-16/README.md)); a coordinator on big is still outstanding.


## Alerting, audit and plan preview (2026-10-16)

Step B10 (part): `collectAlerts` derives notices from runs, worker assignments and host reports; a
notice is not proof of state. `startAlertMonitor` reports only changes, `webhookPublisher` delivers them as text
(e.g. ntfy). `auditLog` lists admin results without payloads. Run commands with `dryRun: true` return a preview
(permissible, reason, revision) without journaling anything. Admin commands `listAlerts`/`auditLog`; the mobile
control page shows notices and audit and stops only after a preview. Evidence: `test/test-alerts.test.ts`,
device check. Open: finer roles and two-person approval as well as the remaining proposals from §7.5.


## Result export and schedule for runs (2026-10-16)

`RunController.export(runId)` reads the results of all members with a registered exporter per run kind (e.g. `SIEVE_EXPORTER`)
and reports completeness, missing parts, manifest and result hash; a partial result
is marked as such. `RunController.schedule` schedules pause or resume; the server-side loop issues
it at the due time as a normal journaled command. Admin commands `exportRun`, `scheduleRun`; the mobile
control page has controls for this as well as forms for Space lifecycle and deployment plan/export.
Evidence: `test/test-run-export.test.ts`. The mobile dialogs (`confirm`/`prompt`) use the standard dialogs of the
Android WebView; they are not specifically verified on the device.
