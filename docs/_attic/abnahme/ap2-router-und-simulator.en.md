# AP 2.1 and 2.8: Router Skeleton and Simulator

As of 2026-10-11. These two work packages are implemented and checked on JSONL
and SQLite. Delegation, routing and membership have meanwhile been implemented separately
as [AP 2.2–2.5](ap2-delegation-routing-membership.en.md); the complete system and load acceptance remains open.

## Router

`src/router.ts` implements `RouterController` over separate, session-scoped
document families `phi-spaces.router-journal` and `phi-spaces.router-command`.
Journal and commands thus lie in the same persistent harness; index,
state and reservation are changed atomically. These documents are not entries
that can be read or taken through the normal Space API.

A command binds ID, routing area, immutable targets, principal,
generation, method, argument hash and, per step, a stable sub-request ID.
A retry with the same command ID and different arguments is
refused. Target, incarnation or sub-request are never replaced on transport errors.
Before the first remote call the step is durably set to
`inflight`. A restart reconstructs the index, reservations and
bindings and first queries such steps at the original target.

The target adapter must implement the idempotent RPC claim protocol.
`done`, `pending`, final error and `notAdmitted` require bound
evidence with target, principal, method, generation, sub-request and hash.
Only the evidence of a still valid generation without a claim ever accepted
permits resubmitting the same sub-request ID. Missing or
expired history as well as a new incarnation result in `needsReview`.
Transport failures leave the command `applying`; they prove no error.

`recover()` sends no new effects. After reconstruction the
router accepts independent work although FOREVER waiters or unreachable targets
remain open. `blocksArea` reserves an area for unresolved policy or
membership changes. A normal pending data operation does not block the
area. `advance()` tends the steps; a later poll decides a waiter that has
been satisfied in the meantime. Several steps are sequential and can
have partial effects; they do not form a distributed transaction.

`reconcileDataRestore()` persists `needsReview` for sub-requests of the restored old
incarnation, including steps not yet sent.
Existing results remain historical evidence; there is no re-placement
and no automatic substitute request. `review()` requires a separate
admin authorization, stores bounded notes and can lift an area lock.
The historical command is not rewritten as successful by this.

`ingest()` confirms a mailbox only after durable, deduplicated acceptance
of the command. On an unknown storage commit the instance is locked and the
caller must reopen the harness and reconstruct. A lost
ACK may also be repeated with the same command ID.

The start budgets are 128 commands, 16 steps, 128 KiB per command including
reserved results/reviews, 32 KiB index, 192 KiB commit and 4 MiB journal
including index reservation. Per step, 16 KiB are reserved for the
result by default. Therefore 16 steps may need smaller explicit result budgets.
Admission fails before an effect if a limit is exceeded. Old IDs are not deleted in favor of new work.
These values do not replace the load test from AP 2.9.

The mandatory `assertAuthority` adapter must fence competing journal owners.
It is checked before accesses, before commits, within the commit and immediately
before sending. The tests use an explicit fixture guard.
The productive connection to the signed RouterLease, delegation, policy versions
and protected router RPCs is implemented in AP 2.2 and checked separately.

## Simulator

`test/support/federation-simulator.ts` runs several real persistent harnesses
with `PhiSpaces`, `SpaceService` and RPC claims. The transport is simulated;
overlay identity, TLS, fencing hardware and Android are not accepted with it.

A virtual event clock orders equal points in time by a sequence number.
Host clocks can jump forward and backward separately; the event order
continues monotonically. A set seed reproduces the latency and failure sequence.
Valid generations still use real cryptography; public
traces replace their random values with stable labels.

Failures include delayed delivery, loss before delivery, lost reply
after the actual target commit, duplicates, partitions and crash/reopen.
A separate counter-model tracks inventory, reservations, request hashes,
decisions and winners. It prevents a second destructive winner,
competing reservations and changes to already decided results.
Comparisons use actual entries and claims from the target harnesses.

## Evidence

`test/test-router.test.ts` contains 45 cases and runs regularly in `npm test`.
The final overall check run passed 345 tests; type check, 158 example tests and
four mobile tests are also green. In addition the built
production bundle is checked on both backends with a duplicate, lost take reply and
router crash/reopen. [Evidence](../../../test/evidence/ap2-2026-10-11/checks.json). The cases comprise:

- duplicate plus lost take reply and restart of router and target;
- crash before sending, after reply and before/after the result journal commit;
- FOREVER waiter with an independent new write after reconstruction;
- partition of a member and independent routing areas that remain usable;
- result expiry, missing history, incarnation change and forged bindings;
- rejection before effect on budget excess, unconsumed mailbox on commit error;
- three members with sequential partial effects and deterministic failure sequences;
- real transaction reservation, restart, competing take and abort;
- data-restore lock for already decided and not yet sent steps;
- loss of authority and corrupt reservation balance.

Take winner selection, drain, HRW and delegation forgery have meanwhile been checked in AP 2.2–2.5. Further admin commands, MemberStatus, three-member sieve and load acceptance follow separately.
