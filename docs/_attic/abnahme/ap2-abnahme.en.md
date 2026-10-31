# Phase 2: Extensions and Acceptance of 2026-10-11

**Phase 2 is completed with the documented completion decision for block 4.**
[Gate 4 and operating limits](ap2-gate4.en.md) are fixed for the checked profile.
An unrestricted native production release is not declared by this.
The dated evidence below distinguishes component, load and operating checks.
The previous evidence on AP 1b remains in place.

## Currently Remaining Test Blocks (2026-10-15)

The phase 2 acceptances are bundled into eight technical blocks; each block
comprises several individual tests. **All eight test blocks are completed.** Gate 4 is likewise closed;
the phase 2 completion applies with the exception on block 4 recorded below
and the [documented operating limits](ap2-gate4.en.md).
Block 4 was completed on the explicit decision of the client of 2026-10-15
and is not executed again. The historical negative
measurements further below are preserved as such; the decision does not retroactively
declare these measurements to be passed tests.

- [x] 1. Mailbox ACK aborts over NetBird under full job load.
- [x] 2. Individual member process aborts and resumption.
- [x] 3. Targeted interrupted journal commits over NetBird.
- [x] 4. Productive root/directory provisioning including boot/fencing check (completion decision 2026-10-15).
- [x] 5. Evidence across independent physical failure domains (live acceptance 2026-10-15).
- [x] 6. Distributed principal deletion including router/parent histories (live acceptance 2026-10-15).
- [x] 7. Physical deletion or binding deletion rules for archives and backups (live acceptance 2026-10-15).
- [x] 8. Controlled migration of existing completion profiles (live acceptance 2026-10-15).

Dated addenda and status lines below describe the state of the respective
run. For currently open items, only the list above is authoritative.

## AP 2.6

Policy profiles now also apply with active members: every task commit checks
result count, assignment fields, the total result size and additional
unassigned results. Task takes limit the txn runtime; renewal cannot
exceed it. Failed commits remain abortable.
Local transitional profiles remain compatible for unmanaged Spaces.

`DataAdminController` implements `purgeTasks` and `deletePrincipal` with
separate authorization per command/Space, authority check in the commit and
per batch atomic, deduplicated progress and audit recording. `purgeTasks` deletes only
unreserved profiled tasks. In principal deletion, own entries,
claims, generations and mailboxes are removed. Foreign mailboxes with affected
entries receive a new epoch and gap; affected foreign claim results
expire without renewed effect. Stream history is discarded and old
snapshot tokens become invalid. The supervisor binds the handlers only
if an authorized controller is provisioned.

The local principal deletion run processes large inventories in at most 32
mutations per commit and loads the existing commit budget. Command ID,
argument hash, phase, count and target tuple remain durably stored.
Meanwhile the Space is locked for new effects, generations and object queries;
snapshot tokens become invalid at the start and at completion. After a crash
or lost commit reply, the same command continues at the stored
phase. Scope and authority are checked again before and within each batch.
An incarnation/authority change requires review, also on the replay
of an already completed new deletion command.

**Limit:** The deletion initially requires a quiescent local Space.
The lock remains on revocation or unclear restore. A single
metadata tombstone that does not fit the budget is rejected without a partial commit;
the running deletion stays locked. The deletion run across
remote members and router histories is still missing.
F9 is therefore not yet fully met. Profile changes to existing
task types remain `MigrationRequired`; a controlled migration flow
is not replaced by this.

Restore reconciliation marks all matching child requests and parent
operations `needsReview`, including completed results and steps not yet
sent. Parents store the original target tuple.
Thus the check also works after a change of the member target address.
`ControlAckService` refuses the restore confirmation for managed Spaces
if no corresponding reconciliation handler is installed. The handler
must run successfully and repeatably before the receipt.

## AP 2.7

`CapabilityDirectory` publishes host resources, tools, models and
metrics with a 120-second lease. `capabilityHeartbeat` is a separate RPC path:
NetBird identity, current app key, host role and grant are required.
The host role must be contained both in the current app key and in the signed grant;
the check is made again before the commit. The body may not represent a foreign host. Different technical
host IDs and peer IDs require provisioned `hostBindings`.

`startConfiguredFederation` can update the local `dataSpaces`
and the control directory every 60 seconds via `capabilities`. Without this explicit
provisioning no heartbeat is started. Capability publication adds
no routing member. Directory entries can be neither created by ordinary clients
nor manipulated through take, txn locking or lease changes;
supertypes do not bypass the protection.

`MemberStatusDirectory` checks members from the router's point of view. It updates revision,
capacity and lag with a 30-second lease and by default renews every
15 seconds. A stale or failed probe removes the
routing observations. A target change during a probe prevents
adoption. For single members, replication lag is not applicable (`null`).
`createFederationController` binds the directory when `probeStatus` is
provisioned; the operator starts its `start()` loop and ends
it with the returned stopper.

Reading is done through `readAll`/`space_list` for `Capability` or `MemberStatus`
within the granted Space scope. Data-only keys thereby get
no general control access. The composite TCP test also checks
the real host RPC path, foreign-host rejection and the control write prohibition.
The existing productive services have not yet been switched to these new
directory/router configurations.

## AP 2.9 and System Acceptance

`test/testbed/scenarios/phase2-load.ts` writes 10,000 entries including claims
and stream history onto three SQLite member stores. Six workers process
1,000 HRW sieve tasks. Task take and result completion lie in separate
durable commits. The result is compared completely against an independently
computed prime list up to 100,000. The report contains complete
document sizes, claim/stream sizes, sampled RSS, task latencies and
batch means per written entry (no individual RPC latencies).

The built load test runs on `big` in its own container with Node 22,
2 CPUs, 1 GiB RAM, read-only file system, without capabilities and without network.
Only built `.mjs` artifacts are transferred. The three stores
are real persistent SQLite stores, but not three NetBird hosts. Therefore
this run replaces neither the virtual router nor the overlay acceptance.
Frame 256 KiB, commit 192 KiB and generation runtime 1 hour remain start values until their
complete evidence.

**Journal partitioning implemented:** The compatible default still keeps
16 parents and one router journal. For new root journals,
`createFederationController({journalPartitions: N, ...})` can provision a fixed split
of 1 to 1024 partitions. A persistent manifest binds
the count and router IDs; SHA-256 durably assigns each parent ID to one partition.
All children and future reservations of a parent stay at the same
router. Per partition, 16 parents of 128 KiB each and the
router budgets of 128 commands, 32 KiB index and 4 MiB journal apply unchanged. No
historical IDs are deleted. A full partition rejects new work before an effect;
independent partitions and known IDs remain usable.

The total capacity is finite and is fixed before operation via N:
at most N × 2 MiB parent reservation and N × 4 MiB router journal, in addition
to the shared control router and manifest. Hash distribution does not guarantee
full utilization of all slots. A changed manifest or the
silent switch of an existing single-journal inventory is rejected; a
migration of existing history is not implemented.

The new load case checks 1000 virtual writes on three persistent members
with 256 partitions, restart and repetition of old IDs. Further cases check
full partitions, cross-partition transaction origins, root
references before remove and lost effect replies. Restore reconciles all
routers and parents and, on a crash between partitions, holds a
durable global lock until the repetition is completed.
The single write load case replaces no job lifecycle or overlay test.
The complete virtual job run is documented separately in the following addendum;
the signed three-member NetBird run on big is demonstrated;
independent physical failure domains and the complete crash matrix
remain open.

| Acceptance item | Evidence / open step |
|---|---|
| Signed lease, delegation, rights/policy/epoch limits | Delegation, routing and TCP tests as well as signed NetBird run with three members; productive provisioning open |
| Stable child IDs, retry, restore | Router/parent tests on JSONL and SQLite; reconciliation hook to be provisioned at an actual root |
| Drain, result commit, remove, notify and EmptyProof | Membership and core tests including global completion budgets |
| Capability and MemberStatus | JSONL/SQLite tests plus composite host TCP RPC test; productive provisioning open |
| Admin purge and F9 | Local batchwise deletion with lock/crash recovery checked; distributed deletion run and router histories open |
| 10,000 entries, three members, 1,000 jobs, six workers | Member load test; final report in the linked evidence |
| Virtual router under this load | Fixed journal partitioning; complete SQLite load run documented separately in the new scenario; signed NetBird run passed; full crash acceptance remains open |
| Crash after every journal/RPC/ACK boundary under full load | Complete load matrix open; existing targeted crash tests remain valid |
| Three-member sieve over real NetBird connections | 1,000 jobs / six workers with signed grants, RouterLease and delegation in four NetBird network namespaces on big passed; fixture provisioning and one physical server |
| Phone with current APK | Installation and object reading over a real NetBird connection demonstrated |
| Overall release of phase 2 / final gate 4 values | Not granted |

Evidence and check numbers: [acceptance directory](../../../test/evidence/ap2-final-2026-10-11).

## Addendum 2026-10-12: Local Batchwise Deletion

The tests delete 240 entries including claims from an inventory above 1 MiB at
`maxCommitBytes = 4096`. The combined size of the actually
persisted change deltas of both affected documents is checked. Storage
checkpoints are complete state snapshots and are considered separately from
mutation deltas. All six phases are checked on JSONL and SQLite
with a crash before the commit and a lost reply after the commit.
Foreign entries are preserved; new effects are locked until completion.
The deletion concerns the currently accessible state; physical cleanup
of backend histories, snapshots and backups is thereby not demonstrated.

Current evidence: [test bench 2026-10-12](../../../test/evidence/ap2-batches-2026-10-12).

## Addendum 2026-10-12: Partitioned Root Journals

[Check reports](../../../test/evidence/ap2-journals-2026-10-12) contain the current
local, mobile and server artifact checks. Production was not switched for this
check. The test transport of the three persistent members is
simulated; no new NetBird or phone acceptance is claimed.

## Complete Virtual Router Load Case

`test/testbed/scenarios/phase2-router-load.ts` extends the test bench by the
complete job lifecycle via `FederatedSpace` and `RouterController`:
1,000 task writes, 1,000 transaction starts, 1,000 takes, 1,000 result writes
and 1,000 commits. Six workers use the HRW binding of the respective
`taskId`; each transaction stays bound to exactly one member. 9,000
background entries are created beforehand locally in bounded member commits.
Thus before processing there are 10,000 entries in total on three real
SQLite member stores. The root uses a fourth SQLite store and
1,024 predefined journal partitions. The entry quota per owner is
explicitly set to 10,000; frame, commit and generation runtime keep
their default budgets.

The test transport calls the real `SpaceService` within one process
with fixture identities. Grants, signed delegation and NetBird are
not part of this load case. Lost replies are generated after a
durable target effect; repetitions keep parent and child ID.
Afterwards the root harness is reopened from SQLite and historical
writes/commits are queried again. Exactly 1,000 unique results,
no remaining tasks, complete prime comparison and exactly 5,000
completed parents/child commands are mandatory checks.

[Measurements and evidence](../../../test/evidence/ap2-router-load-2026-10-12)
document the concrete server run. It still replaces neither the
three-host NetBird acceptance nor the complete crash-boundary matrix.

The built server run passed on 2026-10-12 with 2 CPUs and 1 GiB RAM in
227.518 seconds. All six workers worked (168/168/168/168/168/160 jobs).
36 replies lost after a durable effect were resolved with 36 parent retries.
After root reopen exactly 1,000 results and zero tasks remained;
9,592 primes with sum 454,396,537 agree with the complete reference.
All 5,000 parents and child commands are completed. The largest
partition contains 13 parents at a limit of 16.

| Measure | p95 | p99 |
|---|---:|---:|
| Virtual task write | 37.361 ms | 46.875 ms |
| Begin transaction | 345.461 ms | 392.522 ms |
| Take task | 361.182 ms | 435.501 ms |
| Write result | 360.337 ms | 418.621 ms |
| Commit | 381.789 ms | 461.725 ms |
| Complete job | 1,309.129 ms | 1,382.079 ms |

These are latencies of the respective virtual API calls including
queue, persistence and, where applicable, retry; not pure network RPC latencies.
The sampled peak RSS is 270,274,560 bytes (about 258 MiB). The three
member documents grow from 7,847,685/7,661,269/7,751,204 to
9,118,310/8,809,195/8,852,772 bytes including claims and stream.
Root parents occupy 3,683,379 bytes, the router indexes 1,478,811 bytes;
130,028,248 bytes are reserved for commands. Reservations are not a
measurement of the actual command document bytes or of physical storage.
The workers receive different task IDs; competition of several workers for
the same task is checked by the separate race/crash tests.
Frame 256 KiB, commit 192 KiB and generation one hour remain start values until the
complete overlay/crash acceptance. An overall release of phase 2
is still not granted.

## NetBird Wire Check and Additional Crash Boundaries

`test/testbed/scenarios/phase2-netbird.ts` adds an isolated wire fixture
with one router and three members in four real NetBird network namespaces on big.
The gate layer queries the NetBird management API, checks the app key and
verifies signed original grants, RouterLease and delegation. Own
SQLite stores and TCP port 7423 separate the run from the existing gates.
A temporary four-peer group and a policy limited to TCP 7423 are
removed again after the run. The state is provisioned with new fixture keys;
enrollment, independent boot register, OS fencing and
productive provisioning are not accepted again in this check.
The four network namespaces share one physical server; this is no evidence of
independent VPS failure domains.

The first large wire run got stuck during a lease renewal:
`lease()` could request another commit on the same control harness
within a journal commit. The root composition now queries/renews
leases outside the journal transactions. Inside, it re-checks the
most recently obtained signed lease as well as current control counters;
expiry or supersession still lead to rejection. The JSONL/SQLite
regression lets the lease callback itself commit on the same host
and requires that it never runs within an open journal commit.

Another 16 cases check candidate admission, winner selection, parent completion
and mailbox ACK, each before commit or on a lost reply, on JSONL
and SQLite. After reopen exactly one winner remains committed; the other
entry is available again, without open transactions. Repetition of an
already completed parent releases unused child future reservations
idempotently. This also closes the gap between parent completion and
release of the reserved child budget.

[Evidence](../../../test/evidence/ap2-netbird-2026-10-12) documents the concrete
wire run and the current artifact checks. The complete crash matrix
under full overlay load remains a separate acceptance step; the additional
targeted cases do not replace it. Phase 2 as a whole is still open.

The corrected NetBird run passed on 2026-10-12 in 395.538 seconds:
1,000 jobs, 1,000 unique results, zero remaining tasks and the
complete prime comparison up to 100,000 (9,592 primes, sum
454,396,537). The six workers processed 167/167/167/167/166/166 jobs.
All three member paths were active NetBird P2P connections. The run
exceeded several lease renewal intervals without the earlier deadlock.
Each test process had its own limit of 2 CPUs/1 GiB RAM; this is
not a shared resource budget for all four processes. The first,
stuck run is documented separately as a failed attempt.

418 local tests, 183 tests on the built server artifact, 24 mobile/remote
tests and the example tests are checked in the isolated, current source state.
The lease regression fails specifically with the old controller on both backends
and passes with the corrected controller. The operator driver
`test/testbed/netbird/run-phase2-sieve.py` performs the setup and its own
cleanup reproducibly. Its cleanup uses container IDs actually
created by this run and the policy/group IDs it created itself. Existing test states
are not overwritten.

## Wire Recovery under Load of 2026-10-13

The NetBird driver supports `--rpc-faults` and
`--rpc-fault-boundary afterReply|beforeSend|both`. For each of the three members,
task write, transaction start, take, result write and commit are hit separately.
The default `afterReply` discards one actually successful
wire reply per combination, 15 replies in total. The parent repeats
its existing ID and resolves the original child request. It creates
no substitute order and does not switch to another member.

`--entries 10000 --jobs 1000` additionally provisions 9,000 unchanged
background entries in bounded local bootstrap commits before activation
of the fixture policy. The 1,000 functional jobs and their five effects run
over the signed root/member wire path. Initial inventory, complete
prime comparison, unique results, empty task set and preserved
background inventory are checked. Background provisioning is no
acceptance of the productive membership admission protocol.

A first `beforeSend` attempt showed an error classification gap:
`RemoteSpace` converts `PermissionDenied`, `RequestExpired`, `ResultExpired`
and `IncarnationChanged` into concrete error classes; the RPC adapter
so far recognized only `RemoteError` with a code. The concrete errors
thereby repeatedly led to `unknown` instead of the durable state `needsReview`.
The adapter now recognizes both forms. The JSONL/SQLite regression checks
all four wire replies, preserved review state after reconstruction,
exactly one send attempt and zero functional effects.

**Remaining recovery limit:** Without an accepted claim, the
delegation check refuses the `targetRequest` of the status query. This yields no
binding negative evidence that the original request can never take
effect. A failure before admission therefore conservatively becomes `needsReview`; the
driver may not force an automatic substitute request or a green load run here. The authoritative negative resolution with all binding/history
checks and the complete process/journal/mailbox ACK matrix under
overlay load remain open. The 15 reply losses do not replace this
matrix. Phase 2 remains without overall release.

The complete reply-loss run passed with 10,000 entries, 1,000 jobs
and six workers in 462.309 seconds. All 15 fault points were hit
and resolved with 15 repetitions of the same parent IDs. The workers
processed 167/167/167/166/167/166 jobs; all 1,000 results were unique,
no tasks remained and the 9,000 background entries were preserved.
The reference comparison yielded 9,592 primes up to 100,000, sum 454,396,537.
422 local tests, 185 tests on the built server artifact and 24 mobile/remote
runtime tests passed. The old adapter fails specifically on both
backends at the new error classification regression.
[Evidence](../../../test/evidence/ap2-wire-recovery-2026-10-13) contains the
reports and the separately labeled failed attempts.

The separate real NetBird attempt with `beforeSend` confirms the safe
abort with the corrected artifact: exactly one rejected status resolution,
then `FederationUnavailable: child needs review`, without the earlier
retry loop. The expected check state is demonstrated; this attempt
is explicitly not a passed functional load run. Both isolated
runs removed their own containers, groups and policies completely.

## Current Admission Resolution of 2026-10-13

`resolveOperation` closes the pre-dispatch case described above
at the unchanged primary. The delegation can check the still missing own
claim only with a valid signed generation, current principal/Space/
authority/incarnation reference as well as issuance and target epoch.
Generation and request ID remain unchanged; the late original call
and the retry hit the same claim. The router checks the complete
reply binding against its stored child and releases no substitute ID
or alternative route. Definitive binding and authorization errors remain
`needsReview`. For older members, only the previous known-claim
resolution continues to be used.

The current JSONL/SQLite tests check a missing claim without state change,
reopen, late original and parallel retry with exactly one effect,
foreign/forged/expired generations, epoch change, restore marking,
method/hash conflicts and pending claims that continue to expire. Signed
TCP tests combine pre-dispatch failure and lost successful reply
with identical generation/request ID. The NetBird smoke test hit all
30 combinations (five effects × three members × two RPC boundaries).

The earlier `beforeSend` check result is historically valid for the then
adapter. The new same-epoch path replaces the blanket review there
for a still valid generation. After promotion, lost history,
restore, expired or older generation without epoch binding,
no such retry evidence remains available. A terminal negative claim together with
promotion/fencing evidence from plan 6.2 is thus not implemented.
The process, journal and mailbox ACK crash matrix as well as production provisioning
remain separate open acceptances.

The complete current admission run passed with 10,000 entries, 1,000
jobs and six workers in 438.837 seconds. All 30 RPC fault points were
resolved with 30 repetitions of the same parents. 1,000 unique results,
zero tasks, 9,000 preserved background entries and the complete
prime comparison are confirmed. An additional audit on private copies
of the completed stores checked all 5,000 parents/children as well as every
original faulted member claim including argument hash and target.
No unused child future reservation remained.
428 local tests, 199 server artifact tests, an updated 43-case
compatibility check on the server (with 42 overlapping cases and one new
legacy case) and 24 mobile/remote tests passed.
[Evidence](../../../test/evidence/ap2-admission-2026-10-13) distinguishes this
current wire evidence from the still open process/journal/ACK matrix.


## Real Process Aborts at Journal, RPC and ACK Boundaries (2026-10-13)

The new scenario `phase2-process-crashes` passed the same 20 cases locally and as a built
server artifact: JSONL/SQLite × before/after × candidate commit,
winner commit, parent completion, mailbox ACK and router RPC send/reply.
Each abort is a confirmed SIGKILL. Root and three members are then
opened with the same stores in a fresh process; a second fresh
process checks the completed replay.

All cases keep the winner and the original target, principal,
generation, request ID, method, argument and hash bindings. Exactly one
winner is consumed, two losers returned. No transaction,
no mailbox event and no unused future reservation remains open.
Typecheck and 428 regression tests passed. Existing server services remain
active; the production library and the mobile bundle remain unchanged.
[Evidence](../../../test/evidence/ap2-process-crashes-2026-10-13).

**Limit:** The killed process owns all four stores; RPC uses
fixture identities in the same process and the clock is fixed. This supplements the
previous failure/reopen tests with real process loss, but does not yet
meet the complete crash matrix under full NetBird load, independent
host failure or production boot/fencing. Power/disk failure is
not checked. Phase 2 remains open.


## NetBird Full Load with 30 Actual Root Aborts (2026-10-13)

The complete wire run with 10,000 initial entries, 1,000 jobs, six
fixedly assigned workers and three persistent members passed after 30
SIGKILL aborts of the root. Checked, before dispatch and after a successful
reply, were task write, txn begin, take, result write and
txn commit on all three members. Task write aborts occur during
inventory creation; the processing aborts follow the checked overall inventory.
For each abort the driver observed exit 137 and no OOM kill.
All 31 root starts keep the same lease ID and router epoch.
A root initially started as container PID 1 was rejected by the driver because of
missing actual aborts; Docker init fixes this test setup.

The root resumes only its stored operations with fixed principal/job
assignments. Completed job IDs and producer progress are stored atomically
in the private fixture directory. Unconfirmed completions are repeated
with the same parent/child identities. The lease is renewed on the same
epoch; with an expired or superseded lease the test aborts.
Policy and member targets are checked on restart and not reinstalled.

The run took 727.978 seconds including root restarts.
1,000 unique results, zero remaining tasks, 9,000 preserved
background entries and the complete prime comparison are confirmed.
The subsequent audit of private copies checked 5,000 completed parents,
5,000 completed children and all 5,000 original member claims
with target, principal, generation, request ID, method and hash binding.
All 30 interrupted requests are among them; no unused
future reservation and no active member transaction remained.
Typecheck and 428 regression tests passed; the extended audit is also checked
against the previous full-load admission run.
[Evidence](../../../test/evidence/ap2-netbird-process-crashes-2026-10-13).

**Limits of this root RPC evidence:** It concerns root aborts with running
members and does not cover targeted mailbox ACKs, explicit journal commit boundaries
or individual member aborts. Separate ACK and member evidence
is in the following sections; explicit root journal boundaries remain open. The four network namespaces remain on one physical server;
production provisioning, independent boot/fencing authorization and the
further admin/profile gates remain open. Phase 2 is not completely
accepted. Temporary fixture containers and NetBird objects were removed;
existing production services remain active.


## ACK Aborts with Six Running Workers (2026-10-13)

**Test block 1 is accepted.** The corrected NetBird full-load run with 10,000
initial entries and 1,000 jobs passed six confirmed root SIGKILLs:
before dispatch and after a successful ACK reply on each of the three members.
At each abort all six job workers were running. Before the abort the root checks
the candidate already durably stored in the parent journal. The seven
starts keep lease ID and epoch. The run took 512.945 seconds.

Six additional waiting-take races each keep an identical winner
on replay; twelve losers are available again. Their 18 probe entries are
created in addition to the initially checked 10,000 job/background inventory.
All 1,000 sieve results and 9,000 background entries remain correct.
The audit of private store copies checks 5,024 parents, 5,072 children including
original member claims as well as the six ACK candidates and mailbox cursors.
Three ACK IDs interrupted before dispatch remain not accepted; three ACK claims interrupted after
the reply are completed. An ACK replay may use a
new request ID, but receives the same member, principal,
mailbox epoch and confirmed prefix. The parent/child identities of the
data effects remain unchanged. No active transaction, no gap and
no unused future reservation remained.

The first full run found a challenge collision on parallel query and
worker effect. Several `RemoteSpace` instances on the same transport must
not perform challenge/sign/prove simultaneously: the server holds one
open challenge per connection. The client library now orders complete
proof flows per transport; other connections remain independent.
Failed proofs release the queue; host/peer pinning,
key check and fresh proofs remain in place. The collision was reproduced with
Ed25519 and P-256 over real TCP connections and is regression-protected.
432 local tests, ten built server authentication cases, 24 mobile tests
and typecheck passed. The mobile bundle is synchronized; a new
phone deployment evidence is not claimed by this.
[Evidence](../../../test/evidence/ap2-netbird-ack-2026-10-13).

This ACK evidence includes no member aborts or all explicit
journal boundaries over NetBird. The subsequent member evidence follows below. All fixture containers and temporary NetBird objects
are removed; existing services remain active. The overall release remains open.


## Individual Member Aborts under NetBird Full Load (2026-10-13)

**Test block 2 is accepted.** The full run with 10,000 initial entries,
1,000 jobs, three members and six workers passed 30 actual member
SIGKILLs: five effect kinds × three members × before admission/after durable
completion before reply. Six aborts concern task production; for all
24 aborts at worker effects six workers are running. The root starts once
and ends regularly; each member starts eleven times on its original store.
Space ID, incarnation, authority, primary epoch, membership and policy remain
unchanged. Background entries are not created again on reopen.
The run took 435.357 seconds including member restarts.

Before each abort the test checks the original claim: 15 requests are
not yet accepted, 15 already completed. After resumption, private copies
of the read-only mounted stores check all 5,000 original
child claims including principal, generation, request ID, target and argument hash.
All 5,000 parents/children are completed; no active transaction or
unused future reservation remains. 1,000 unique results,
zero tasks, 9,000 background entries and the complete prime comparison
are confirmed.

The trial run found an admission gap: A transport loss during proof or
generation before child dispatch made the already stored parent call
abort. This typed transport error now reports `FederationPending`
with the same parent ID; routing plan and reservation remain.
Only as long as no child is journaled may a new generation be obtained.
Journaled child IDs are repeated unchanged. Functional,
authorization and authority errors are not reinterpreted as pending.
The test driver repeats pending with a 30-second retry deadline, without extending existing
transaction deadlines. Two positive and two negative cases
for JSONL/SQLite, 436 local tests, four built server recovery tests,
24 mobile tests and typecheck pass. A report file permission error
in the 60-job trial run was fixed before the successful full-load run; failed
runs are documented separately.
A first full-load run failed due to a hanging SSH observer in the
test driver: An aborted member remained unreachable; the root ended
its pending retry after the set deadline. SSH calls are now bounded;
the member observer checks and starts its own containers bundled on
the server. The successful acceptance uses a fresh fixture. A refused
existing test directory does not entitle adopting its CID files;
this cleanup boundary is checked separately with the running own fixture.

[Evidence](../../../test/evidence/ap2-netbird-member-crashes-2026-10-13).

All own fixture containers and temporary NetBird objects are removed;
existing production services remain active. The evidence replaces neither
promotion/boot/fencing nor independent physical failure domains or power-loss
checks. **Six test blocks as well as the overall release remain open.** Next
follows test block 3 with targeted interrupted explicit root journal commits.


## Journal Commit Aborts over NetBird (2026-10-14)

**Test block 3 is accepted.** Five fresh full-load runs, each with
10,000 initial entries and 1,000 jobs, cover 13 successful journal
state transitions immediately before and after the actual atomic
`Storage.commit`. All 26 root aborts are confirmed SIGKILLs;
at each, six job workers were running. Checked are parent admission, future
reservation, child admission, child binding, parent ready, child inflight,
child completion, registration, candidate, winner, parent completion,
reservation release and cursor progress on a read miss.

The classification checks document family, concrete parent/child ID and
materialized before/after states. After the commit, state and
commit sequence are read again from the backend. Each subsequent audit works
on private copies of closed, read-only mounted stores and checks all
originally journaled child claims and the 26 abort points. Identities discarded before the
durable child admission remain not accepted;
afterwards generation, request ID, principal, target and arguments are preserved.
Waiting-take probes keep one winner and return the losers.
No active transaction or unused reservation remains open.

The first small run detected the initially uncaptured document first creation
and failed correctly at 22 instead of 26 aborts. After the correction, the
four first-creation probes including audit and all five complete runs pass.
Additional probe entries do not count toward the initially checked 10,000 inventory.
[Evidence](../../../test/evidence/ap2-netbird-journal-2026-10-14).

The acceptance covers successful data/race journals. Failure/review,
restore, deletion and profile migration flows have their own acceptances.
The five remaining test blocks and the overall release remain open.

## Continuation of Blocks 4–8 on 2026-10-14

The native root provisioning, root/child history deletion, independent
deletion barriers, the archive catalog and the controlled profile migration are
implemented building blocks. Their limits and still missing operating bindings
are in the [implementation status](../../implementierungsstand.en.md#phase-2).
They do not replace the open live acceptances.

A definitive child error so far led to repeated `FederationPending` in composite write/take
operations; in a search operation it could furthermore
be skipped. Definitive errors and `needsReview` now mark
the parent durably `needsReview`. Waiting race operations also keep
this lock on replay. Eight new tests check write, read, take and race on
JSONL and SQLite after restart without an additional effect. Typecheck and
the complete suite pass with **462/462 tests**.

The own native live environment comprises the root and three members on big, the
local machine and vpsc. It uses exclusively its own new
stores and a separate NetBird test scope. An independent root fencing
refuses normal journal operations. After a connection abort to the local
member, the original second write order was completed with the same parent,
child and member request ID. This single resumption evidence
is not yet a successful native sieve/job acceptance. Blocks 4–8 remain open.


In addition, under running job production and after independent boot fencing, the own root refuses
further operations. The subsequently restarted
root keeps its original lease ID and router epoch; the three member
runtimes remain unchanged. The data reader certificate used can
read at the independent register, but receives the expected
authorization rejection on the CAS attempt.

The measured register read times average about
450 ms at the local member and about 58 ms at the root (ten queries each, no gate 4 percentiles).
The native smoke driver uses six agents with explicitly **at most
one transaction open at a time**. Thus no acceptance is claimed for six
simultaneously open native root transactions. The previous
load evidence of blocks 1–3 keeps its own documented concurrency.


The continuation adds two further security-relevant corrections:
Identical signed member policies need no renewed mutation commit;
the normal protected snapshot and a renewed authority check remain
mandatory. Actual profile/policy changes still run via
fully checked commits. Two new backend tests check in particular
revocation during the query and invalid signatures.

Explicit wire replies `TransactionError` and `CompletionViolation` are
conservatively recorded as `needsReview` in effect dispatch and claim resolution.
They are neither a transport failure nor evidence of a successful
effect. Two new TCP/backend tests check that after the reply and after
restart no further effect is sent. In the own native run,
all twelve write parents are completed; the first two transactions
expired before take admission. This run therefore remains a negative
operating evidence and does not release phase 2. The original IDs and their
histories are not obscured by substitute IDs or deleted journals.


The [evidence of the native continuation](../../../test/evidence/ap2-native-root-2026-10-14/README.md)
contains tests, artifact checksums, fencing, the CAS rejection and the durably
review-required original request. The own test environment was subsequently
ended: six containers, six precisely assigned firewall exceptions and the
temporary NetBird objects are removed. The own four boot entries and the
own authority are fenced; the stores are preserved as evidence. All
three protected existing services are still active, as are the existing
Tailscale on vpsc and NetBird on the local machine.


On 2026-10-14 the register rules for block 7 were additionally secured:
Deletion epochs cannot be reset even by an authenticated operator CAS.
Command hash and deadline remain bound; a further
epoch begins only after a completed deletion run and archive deletion.
Archive bindings and deletion receipts are preserved, quarantine and destruction
are irreversible. The archive and floor checks run within the same
SQLite write transaction: A late registration of a backup from an
older epoch fails even after sealing has already taken place.

The [register evidence](../../../test/evidence/ap2-erasure-register-2026-10-14/README.md)
contains two-connection/restart and mTLS checks, **463/463** tests,
**24/24** mobile tests, typecheck and 29 built artifacts. The shared
live register service was not updated or restarted. Backup/restore
integration and active backend histories remain open; block 7 and
blocks 4–8 as a whole thereby receive no release.


## Native Root Latency: Bundling Fresh Checks

The [latency evidence](../../../test/evidence/ap2-native-performance-2026-10-14/README.md)
separates the negative take, reading measurements and the still separate live acceptance.
A single reading root call initially needed 19.4 seconds and 141
register queries. Root state and keys are now checked from a shared control snapshot,
normally protected by BootGuard; authority, erasure and
boot come from one freshly authenticated register batch. Journal commits
keep their fresh authority checks. There is no authentication or
TLS session cache.

Transaction sequences can use the still open, original request generation with
identical target, principal and policy binding. Each effect keeps its own durable request ID, a fresh app-key proof as well as grant and delegation;
the member checks the admission again. An inline reply counts as completed only with fully
checked binding and resolution of the actually stored claim.
Legacy replies still need the separate resolution.

Typecheck, **151** targeted checks and **473/473** complete tests pass.
New native test runs receive their own object/request namespace and measure
begin, take, result and commit separately. Earlier negative claims are preserved.
This implementation and test evidence does not yet close block 4.

## Block 8: Live Profile Migration after Root Abort (2026-10-15)

In the new, separate scope `ap2-remaining-20261015` the authorized
supervisor command `ap2-remaining-20261015-profiles` was interrupted by a targeted root SIGKILL after durable entry
into `freezing`. The original
command ID and the stored progress remained. This revealed a resumption error: Remote supervisor jobs ran before the control
listener that members need for fresh key queries.

`startFederationHost` now opens the listener, fully protected by boot, proof, grant
and control rules, before the first supervisor pass.
Two additional persistent TCP tests check this order for JSONL
and SQLite. After deployment of the built fix, the same live command
completed: policy version 5, `maxResultCount=2`, all three members `active` again
and with exactly the new completion profile. The existing migration tests
continue to check reply loss, commit aborts and rights/target bindings.

Evidence: [profile-transition.json](../../../test/evidence/ap2-remaining-2026-10-15/profile-transition.json).
Block 4 is thereby neither executed again nor assessed.

## Block 5: Two Physical Hosts and Isolated Member Failure (2026-10-15)

The existing NetBird peer of the local physical machine was added as fourth
member `d` to the own scope. Root and three further members
stayed on `big`; the local machine uses its existing NetBird,
no second VPN tunnel. The additional SSH Unix socket serves exclusively
the independent recovery register and still carries fresh mTLS.
DMI probes distinguish the local MSI machine from the netcup KVM server.
The evidence concerns two physical operating environments, no standby
promotion and no simulated power failure.

A signed root write call stored a `DomainProbe` exclusively on
member `d`. After SIGKILL of exactly this member, its query reported a
failure while root and the other members continued to answer. The
original read parent `domain-probe-read` was continued after reopening with
unchanged target binding and read exactly the persisted nonce.
A child initially still unresolved was continued with the same parent ID;
no new data run was created. Both parents are durably `done`.

The local inbound firewall received exclusively two documented rules
for root peer, local NetBird address and test port 7432.
Evidence: [physical-domains.json](../../../test/evidence/ap2-remaining-2026-10-15/physical-domains.json).

## Blocks 6 and 7: Distributed Deletion with Backend and Archive Evidence (2026-10-15)

The real cluster comprised root/control and four data members on two Space
hosts; its recovery register ran independently on `vpsc`. Nine personal
check entries were created on three members. An additional reading
check of the unchanged root backup confirms before deletion the
payload data in both the own and the foreign cached parent result.

`DistributedPrincipalErasure` bound all five target tuples and the same
command `erase-20261015-remaining` to an independent CAS progress.
All writers were independently locked and actually stopped. Only after
creation of all deletion floors and collection of all entry IDs did local
deletions begin. After their completion the first coordinator process ended at the
durable checkpoint `root`; a new process continued the same command
and cleaned own and affected foreign parent/child histories.

Afterwards all five local epochs and installed authorizations were
updated, the active SQLite histories consolidated and the previously
registered backups, bound by SHA-256, quarantined and deleted.
The individual receipts check actual database, WAL and SHM files for
remaining check payload data and require empty own archive directories.
All five floors are `sealed`, all archives `destroyed`, `archivesPending`
is `false` everywhere. A restore of each old archive was explicitly
rejected with the deletion policy rejection; transport errors do not count
as a passed restore negative test.

After renewed boot release and restart of root and all four members,
original write parent, own read parent and foreign
read parent each returned `ResultExpired`; no check entries were visible any more.
No earlier root operation was repeated with a new request ID.

Evidence: [deletion run](../../../test/evidence/ap2-remaining-2026-10-15/distributed-erasure.json),
[file checks](../../../test/evidence/ap2-remaining-2026-10-15/file-verification.json),
[progress sequence](../../../test/evidence/ap2-remaining-2026-10-15/erasure-progress.jsonl),
[old cache contents present](../../../test/evidence/ap2-remaining-2026-10-15/privacy-before-erasure.json),
[test bench](../../../test/evidence/ap2-remaining-2026-10-15/validation.json).

The final source state passes typecheck, 492 phi-spaces tests,
20 mobile runtime tests, four mobile lifecycle tests and two additional
Python checks with real SQLite WAL data. The latter confirm consistent
backups, unchanged binding on replay and deletion refusal on a wrong
hash. The SQLite cleanup claims no secure overwriting of storage
media; additional external copies remain subject to the
binding registration and deletion policy. The overall release/gate 4 remains
separate from these completed test blocks.

After securing the evidence, only the own acceptance
fixtures were independently locked and ended. Two own local firewall rules,
three own NetBird policies and groups, both SSH forwardings and the
exactly added restricted SSH authorization line were removed.
The own register container was ended and removed; its database,
the sealed deletion receipts and the stores are preserved. The checked
existing services on `big` and `vpsc` kept container ID, start time and
restart counter: [cleanup evidence](../../../test/evidence/ap2-remaining-2026-10-15/cleanup.json).


## Gate 4 and Completion Decision (2026-10-15)

The supplementary built server limit test and the targeted handshake follow-up check
passed. The [operating limits and scope](ap2-gate4.en.md) are documented as binding.
All eight blocks and gate 4 are closed; no
phase 2 test block remains open. The explicit completion decision on block 4 is
continued as an exception and does not declare the negative native measurements there
to be passed tests. The next plan section is phase 3.
