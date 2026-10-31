# Implementation plan: federation v3

As of 2026-10-16. Turns [federation-plan-v3.en.md](../federation-plan-v3.en.md) (contract) and
[betrieb-und-mobile-steuerung.en.md](../betrieb-und-mobile-steuerung.en.md) (operations extension) into
work packages. The basis is the [implementation status](../implementierungsstand.en.md): the default Space remains the
session-scoped document `phi-spaces.space` v5; further Spaces live in the family `phi-spaces.named-space`.
`src/spaces.ts` provides the registry/identities, `src/claims.ts` local claims. The scope reached and the
parts still open are in section 7; no single local package replaces a complete stage acceptance.

Note of 30 October 2026: The packages and progress entries below mention pi-durable, JSONL and `Session.commit`;
they date from the time before the [phi-spaces store](../umstellung-ohne-pi-durable.en.md). Today the suite runs on the
SQLite store in `src/store/` (`defineDoc`/`defineDocFamily` from `src/store/documents.ts`); pi-durable only remains
in the `agent/` package. The tables are a chronicle and are not rewritten.

This plan is a sequence, not a time estimate. Sizes (S/M/L) are relative efforts.

## 1. Is the plan ready for implementation?

**Stages 0 to 2 and the operations extension are implemented; stage 3 is implemented and verified in real runs, but not accepted.**
Stage 3 still depends on an open finding in the [acceptance matrix](abnahme/ap3-abnahme.en.md), stage 4 on F12 (section 7 and the
[phase 3 status](abnahme/ap3-replikation.en.md)).

| Stage | Ready? | What is missing before the start |
|---|---|---|
| 0 - core remainder | **yes** | nothing |
| 1 - named Spaces, local protocol | **implemented and verified locally** | start values from F11 still need a load test |
| 1b - overlay, identity, enrollment, restore | **accepted in the F15 model** ([phase 1b acceptance](abnahme/ap1b-abnahme.en.md)) | no promotion/replication release |
| 2 - router and expand | **complete** with documented exception for block 4 ([phase 2 acceptance](abnahme/ap2-abnahme.en.md)), gate 4 closed | unrestricted native production release not declared |
| 2b - operations extension (runs, workers, Spaces, bootstrap, mobile control) | **implemented** (B2-B10, [operations §8](../betrieb-und-mobile-steuerung.en.md#8-implementation-status-and-order-of-the-operations-extension)) | own contract, no v3 acceptance; cases 1, 5, 6 partly, 7 open (operations §7.6) |
| 3 - replication, promotion | **implemented and verified in real runs, not accepted** ([acceptance matrix](abnahme/ap3-abnahme.en.md)) | open finding of the matrix (member admission after `committed`, fixed locally, not re-verified in a real run); boot and erasure integration of the sync journal is outside the acceptance criteria |
| 4 - further clients | after 2 | F12 remains deferred; admin CLI `npm run bootstrap` exists as part of 2b |

The local stage 1 cases are verified by automated tests; the complete federation contract is still
not accepted. Where the implementation uncovers a contradiction,
`federation-plan-v3.en.md` is corrected first and development continues afterwards, not the other way round.

## 2. Principles for the implementation

1. **Tests first, from the contract.** Every work package begins with the matching cases from v3 §11 and
   §12.1 as failing tests. A package is done when these tests are green on **persistent** storage
   (JSONL or SQLite); MemoryStorage alone is not enough (v3 §12).
2. **The core stays pure.** New semantics (revisions, claims, budgets, completion profiles) come as pure
   functions with an explicit `now` in `src/core.ts` or new pure modules. Transport, cryptography and
   processes live outside.
3. **One commit, one truth.** Space mutation, RPC claim, revision, mailbox event and budget reservation
   arise in the same harness commit. pi-durable allows several documents in one `Session.commit`; this is
   demonstrated first in AP 0.3.
4. **No new dependencies without asking** (AGENTS.md). Ed25519/ECDSA, SHA-256 and randomness come from
   `node:crypto`; RFC 8785 already exists in `src/canonical.ts`.
5. **Vertical slices.** Every stage ends with a runnable example (sieve) on the new path, not
   only with building blocks.
6. **Docs and code together.** `implementierungsstand.en.md` and `api.en.md` are updated with every package; typecheck and `npm test`
   after every change.

## 3. Decisions to be made in advance

| Question | needed before | Recommendation in the plan | Who |
|---|---|---|---|
| F2 coordinator host | 1b | **decided:** VPS per v3 4.1.1, NetBird VM separate | operator |
| F3 no mTLS | 1b | **decided:** no mTLS | operator |
| F4 challenge per connection | 1b | **decided:** per connection | operator |
| F5 lossy control restore | 1b | **decided:** accepted | operator |
| F6 clock uncertainty 2 s / lock 5 s / HLC 60 s | 1b | **decided**, NTP on all hosts | operator |
| F7 grant 60 s, lease 60 s/20 s | 1b | **decided** | operator |
| F11 start values frame/commit/connections | 1 (start values), 2 (final) | **decided:** start values adopted, load test confirms them before stage 2 | implementation |
| F9 erasure per principal | 2 | admin command in stage 2 | operator |
| F1 fencing adapter | 3 | cloud API of the VPS provider | operator |
| New dependency `pi-server` (TCP/Unix transport) for phi-spaces | 1b | **decided:** peer dependency, transport behind an interface; entered only with AP 1.9 | operator |

## 4. Work packages and sequence

### Phase 0 - Foundation (stage 0)

| AP | Content | Size | Result |
|---|---|---|---|
| 0.1 | **Persistent test environment:** helpers for opening, aborting and reopening a harness on JSONL and SQLite in `test/support/`; fault injection points (before/after commit, before reply). | M | Basis for all crash/reopen acceptances |
| 0.2 | **L7 remainder:** byte measurement for internal document parts (outbox, claims, waiters, regs) and total document bytes; separate limits. | M | `stats()` reports bytes per category; limits take effect before mutation |
| 0.3 | **Feasibility proof pi-durable:** (a) Multi-document commits are already demonstrated: tool claims (task-scoped) and Space document are written in the same commit today; re-check only for session families. (b) `defineDocFamily` with `scope: "session"` per Space key and the **transition singleton → family**: `checkRecordScope` rejects accesses whose token does not match the persisted record; v5 therefore probably needs a new `kind` plus a one-time copy-and-retire commit instead of a `migrate` hook. (c) Commit costs with 10,000 entries in one document (delta ops, checkpoints). | M | Measurement report in `docs/_attic/VALIDIERUNG.en.md`; migration path for 1.1 fixed; for (c) possibly a split of the Space document |
| 0.4 | **L14:** pi-serverd of the sibling project demonstrably loads the bundle; smoke test over Unix socket with the existing `sessions` service. | S | Integration accepted |
| 0.5 | **Remote test environment:** Docker containers on the server `big` (runner, coordinator, standby, members), script for setup, start and fault injection; `test/testbed/`, [testumgebung-big.en.md](../testumgebung-big.en.md). | M | Tests and later federation hosts do not run on the developer machine |

Order: 0.1 and 0.3 first and in parallel; 0.3 can change the data model decision in phase 1.

### Phase 1 - Named Spaces and local protocol (stage 1)

Status 2026-10-09: AP 1.1-1.9 implemented locally; evidence in [ap1-abnahme.md](abnahme/ap1-abnahme.en.md).

Order within the phase along the dependencies:

```
1.1 Doc v5/Familie ─► 1.2 Identitäten ─► 1.3 Revision/Changes ─► 1.5 Claims/Generationen ─► 1.8 SpaceService ─► 1.9 RemoteSpace
                                    └──► 1.4 Budgets/Seiten ───────┘            │
                                                                     1.6 Mailboxes ─┤
                                                                     1.7 Folgeaufträge/Abschlussprofile
```

| AP | Content | Modules | Size |
|---|---|---|---|
| 1.1 | **Doc version 5 and named Spaces:** The existing singleton `phi-spaces.space` remains the default Space; further Spaces live in `defineDocFamily` with the dedicated `kind` `phi-spaces.named-space` and key `spaceId`. Registry document `phi-spaces.registry` for `hostId` and alias → `spaceId`. Migration 4 → 5 preserves the default data; at registration its **generated** `spaceId` and alias `default` are created. No reinterpretation of the singleton as a family and no copy migration (decision from AP 0.3). | `doc.ts`, `core.migrate`, `client.ts` | M |
| 1.2 | **Identities:** `hostId`, `spaceId`, data incarnation; local IDs = incarnation + counter; `gid = spaceId/localId`; `view()` returns `gid`. | `core.ts` | S |
| 1.3 | **Revision and change stream:** revision per commit; bounded, persistent batch log per Space; `changes(afterRev, maxBytes)` locally; snapshot token with revision R and bounded retention (`SnapshotExpired`). | new `src/stream.ts` | L |
| 1.4 | **Budgets and pages:** `maxCommitBytes`, `maxEventBytes`; reservation for commit **and** abort before every txn extension (v3 4.2); byte-bounded pages for `readAll`, snapshot, `events`, `changes` with cursor without gaps/duplicates; with a budget that is too small `ResponseBudgetTooSmall {requiredBytes}` without cursor/ACK progress (v3 6.2 "page sizes"). Replaces `MAX_LIST` without cursor (L13). | `core.ts`, `stream.ts` | M |
| 1.5 | **RPC claims and generations:** separation of functional arguments / renewable frame; argument hash over canonical JSON of the functional arguments only; claim `(principal, spaceId, generation, requestId)` in the Space document and in the same commit; states `pending`, `pending/commitSealed`, `done`, `cancelled`; deadlines (24 h, hash until end of admission and result deadline); `RequestConflict`, `RequestExpired`, `ResultExpired`, `IncarnationChanged`; signed generations, bound to principal/Space and data/authority incarnation (HMAC with host key suffices locally); `pollOperation`, `cancelOperation` with `targetRequest`. | new `src/claims.ts` | L |
| 1.6 | **Mailboxes:** structured principals; mailbox with `mailboxEpoch`, `seq`, ACK of contiguous prefixes only, TTL 7 days plus byte limit, gap report; outbox for peer targets becomes mailbox; prepare `registrationClosed` as an event kind. | new `src/mailbox.ts`, `index.ts` delivery | M |
| 1.7 | **Internal follow-up jobs and completion profiles:** reaper/settle with durable cursor and batches below `maxCommitBytes`; fanout follow-up jobs (v3 6.1 point 8). Local `CompletionProfile` check at every commit of a take txn (`CompletionViolation`), in stage 1 as a transitional configuration per Space (v3 6.4); policy replaces it in 2.6. The sieve uses it immediately. | `core.ts` | M |
| 1.8 | **Service `space`, transport-independent:** dispatcher with the methods from v3 6.2, validation, frame check (authority/epoch as placeholders), basic rights model with test identity adapter. The package scope itself contains no transport yet; that follows in 1.9. | new `src/service.ts` | M |
| 1.9 | **`RemoteSpace`:** implements `SpaceLike` over an abstract transport; holds request ID and arguments until completion; polls; `maxClientWaitMs` → `OutcomeUnknown`. First in-process transport, then Unix socket via pi-serverd (dependency see 6). | new `src/remote.ts` | M |

**Acceptance phase 1:** v3 §11 stage 1 and all rows "1" from §12.1, in particular: take commit with lost
reply returns the same result after reopen; a known pending request survives the end of a generation;
five 64 KiB entries page without a gap; migration fixtures v4 → v5. The sieve runs over `RemoteSpace` with
in-process transport against a named Space and with an enforced completion profile.

### Phase 1b - Network, identity, control Space, recovery (stage 1b)

Only after the decisions from section 3. Order: identity before control Space before recovery.

| AP | Content | Size |
|---|---|---|
| 1b.1 | **NetBird test environment and test matrix** v3 4.6 (gate 5); management API rights for peer ID query; add results to v3 4.6. | M |
| 1b.2 | **`space-gate`:** TCP only on overlay IP, Unix socket `0600`, frame/connection/handshake limits, allowlist `serviceId: space`, non-overridable context to pi-serverd (explicit authentication boundary). | L |
| 1b.3 | **Identity layer A/B:** peer resolution with 60 s cache; challenge `{gateHostId, observedPeerId, connNonce, …}`; Ed25519 or P-256; key storage Android Keystore and desktop (`0600`) (gate 6). | L |
| 1b.4 | **Control Space and grants:** protected types (`PeerKey`, `Enroll`, `Command`, `Result`, …), role matrix v3 §9, grants ≤ 60 s with renewed check before the commit, `resolution` grant, authority ID. | L |
| 1b.5 | **Supervisor process:** local service per host; supervisor commands `createEnroll`, `revokePeer`, `rotateKey`; bootstrap authority once; `enroll` RPC with check order and token only in the volatile buffer. | L |
| 1b.6 | **Recovery path:** recovery Space over local socket, out-of-band access (SSH with `command=`), independent recovery register with compare-and-set (gate 1). | M |
| 1b.7 | **Restore:** control restore 5.2.1 (authority change, `AuthorityTransition` per member, re-release rights) and data restore 5.2.2 (serialized transition, historical claims readable only, remove old pending work/reservations from the active copy, `restoredUnverified`/`releaseRestored`, `IncarnationChanged`, control/boot reconciliation); router step 5.2.2/5 follows in 2.1. Fencing initially via F15 exception in single operation only. | L |
| 1b.8 | **Boot attribute (basic form):** versioned `HostBootState` with global host state and own permissions per Space, CAS via independent register; provisioning installs matching authority/data incarnation. Without matching evidence no writing work of the Space; control/data restore update the evidence. States `fenced`/`quarantine` and replica changes follow in 3.6. | M |

**Acceptance phase 1b:** v3 §11 stage 1b and all rows "1b" from §12.1. Integration evidence first with two
pi-serverd plus gates on localhost and test identity adapter, then in the real NetBird environment.

### Phase 2 - Router and expand (stage 2)

| AP | Content | Size |
|---|---|---|
| 2.1 | **Router skeleton:** command state machine `accepted → applying → completed / failed / needsReview`, journal with sub-request IDs, `recovering` after restart. | L |
| 2.2 | **RouterLease and delegation:** lease requested from the supervisor and signed by it; delegation with `targetRequest`; check at the member (signatures, authority, epoch maxima, hash); `EpochNotice`; delegation renewal for long operations. | L |
| 2.3 | **Policy and routing:** `FederationPolicy` with validation (one rule per type, mode limits, default target); `local`, `expand by type`, HRW over the field value only, `capacity`/`capability` with journaled selection. | M |
| 2.4 | **`FederatedSpace`:** read/take sequentially with resolved outcome; `readAll`/`count` with `allowPartial`/`waitForComplete`; txn binding and `RoutingConflict`; waiter race. | L |
| 2.5 | **Membership lifecycle:** `addMember` with inventory check under local lock; `drain` with admission boundary; `freezeForRemoval`, `EmptyProof` including notify registrations and `registrationClosed`; `removeMember`, `MigrationRequired` for HRW. | L |
| 2.6 | **Policy completion profiles and admin commands:** `completionProfiles` from the policy instead of local configuration; `purgeTasks`, erasure per principal (F9); `needsReview` for sub-requests after data restore (5.2.2 step 5). | M |
| 2.7 | **Capability directory and MemberStatus.** | S |
| 2.8 | **Simulator:** several harnesses, deterministic latency, loss, duplicates, partitions, clock jumps; counter-model for reservations and request states. Start in parallel to 2.1, because 2.4/2.5 can hardly be accepted without it. | L |
| 2.9 | **Load test** (gate 4): 10,000 entries, 3 members; final values for frame, `maxCommitBytes`, generation lifetime. | M |

Current evidence and release points still open: [phase 2 acceptance](abnahme/ap2-abnahme.en.md).

**Acceptance phase 2:** v3 §11 stage 2 and all rows "2" from §12.1; sieve over three members with HRW by
`taskId` (operations §6).

### Phase 2b - Operations extension (parallel to phase 3)

Prerequisite is phase 2. Content according to [betrieb-und-mobile-steuerung.en.md](../betrieb-und-mobile-steuerung.en.md):

1. **Run controller:** manifest, idempotent `startRun`, multi-part preparation under commit budget.
2. **RunGate barrier:** entry lock, ACK content, `RunGateConflict`; `RunRecoveryView` with gate, lock,
   control order/phase and stopped history; `reconciling`/`needsReview` after restore, `resolveRunRecovery`
   with complete views and admin decision instead of automatic resume from the highest revision.
3. **Worker management:** `WorkerAssignment` entries, supervisor reconciliation, generations.
4. **Bootstrap script** (`--check`/`--apply`) with alias → ID, NetBird join, admin pairing first.
5. **Mobile Spaces page** in the sibling project: connection list, operations, run details.

**Acceptance:** operations §7.4.

**Status 2026-10-16:** Points 1-3 and 5 are implemented; worker management uses signed assignments fetched per
host instead of entries in the control Space. The bootstrap script plans and applies Spaces and workers;
SSH provisioning, NetBird join and pairing remain prerequisites. Additionally implemented: Space lifecycle,
alerting, audit, preview, result export and schedule. Acceptance status per case: operations §7.6.
**Noted for later, currently not planned:** finer roles (`run-operator`, `worker-operator`) and
two-person approval; they change the access rules of the control Space and need their own review.

### Phase 3 - Replication and takeover (stage 3)

Status of the packages (details: [phase 3 status](abnahme/ap3-replikation.en.md), there with its own sub-numbering):

| AP | Status 2026-10-17 |
|---|---|
| 3.1 Stream import | Building blocks implemented: snapshot transfer, stream cursor worker, generation maintenance; real ten-minute NetBird partition passed as a component run ([evidence](../../test/evidence/ap3-overlay-2026-10-15/README.md)). Not integrated into the Space service |
| 3.2 primary/sync | Storage foundation implemented (sealing, hash chain, standby ACK, restart resolution); a dedicated store per primary/sync Space in the federation host (`openSyncSpace`, distribution in the host, configuration `syncSpaces`), signed replica transport; sync primary rules in the validator released; daemon run on nanoi and 100 passed ([evidence](../../test/evidence/phase3-daemon-sync-2026-10-16/README.en.md)); bootstrap of existing stores implemented (`bootstrapPrimarySync`, ran for real on host-a); public `CommitSealed` with resolution in the running host and `NotCommitted` with negative claim per 6.2 implemented for primary/sync Spaces and the main store |
| 3.3 Fencing adapter | Interface per v3 §5.5 implemented ([replica control](abnahme/ap3-replica-control.en.md)): simulator only with explicit test release, netcup as a "not configured" placeholder. netcup SCP adapter with mTLS service built and verified against a mock API; token and service on vpsc; real run (power off, verify, release into quarantine) against nanoi passed on 2026-10-16 ([evidence](../../test/evidence/f1-netcup-2026-10-16/README.en.md)). Promotion with real data passed in the daemon run and in the root run. For single restore the SSH evidence per F15 remains |
| 3.4 Promotion, degradeToSingle | implemented; real cycle with netcup fencing on nanoi and standby 100 passed as a fixture run ([evidence](../../test/evidence/phase3-sync-2026-10-16/README.en.md)). `ReplicaConfigNotice` with register-backed takeover in the router and `ReplicaConfigPending` at the member implemented. Fetching via the notice board in the control Space, takeover in the root heartbeat, address resolution by current target. Real run with native root on host-a passed ([evidence](../../test/evidence/root-hosta-2026-10-17/README.en.md)). primary/sync Spaces run in the federation daemon; the validator admits sync rules only in the variant `primary` for replicated members. degradeToSingle without a fencing adapter revokes only the standby permission of the Space ([procedure](abnahme/ap3-replica-control.en.md)). Open: `ReplicaConfigPending` and takeover after `setStandby` verified locally only |
| 3.5 setStandby | implemented (empty quarantine target, complete reload); verified back to nanoi in the real cycle; write lock for all sources including reaper during open transitions, abort with `abandonTransition`; reload of a bootstrapped store (bootstrap chunks with checksum) implemented |
| 3.6 Boot attribute complete | implemented: `fenced`/`quarantine` by CAS; boot guard binds primary/sync Spaces via `replicaConfig` to role, epoch, replica version and durability of the journal, `standby` without functional admission; re-admission of the remaining Spaces of a fenced host per Space (`readmitSpace`/`installAdmittedPermit`); several Spaces and restart verified |
| 3.7 lww/set | Building block, public adapter in the `space` service, policy modes with placement in the root, replication between members over proven, pinned connections and erasure of a principal implemented; real run over NetBird passed ([evidence](../../test/evidence/merge-run-2026-10-17/README.en.md)); compaction of the histories implemented and ran for real ([evidence](../../test/evidence/compaction-run-2026-10-17/README.en.md)) |
| 3.8 Control Space on primary/sync | implemented locally: bootstrap of existing stores, main store on primary/sync (`mainSync`, `main-sync`, `replica-listen`), control epoch from the journal, sibling Spaces; real run on host-a passed: bootstrap, setStandby/degradeToSingle twice with standby on nanoi and netcup fencing, ending `single` ([evidence](../../test/evidence/control-sync-hosta-2026-10-17/README.en.md)); step 6 (policy reconciliation, lease across the transition, EpochNotice) implemented and ran for real on host-a with root and policy ([evidence](../../test/evidence/step6-hosta-2026-10-17/README.en.md)); promotion of the control replica with container fencing and host change under the same authority ran for real in both directions ([evidence](../../test/evidence/control-promotion-2026-10-17/README.en.md)); router change with root takeover and members following during operation likewise ran for real ([evidence](../../test/evidence/root-promotion-2026-10-17/README.en.md)) |

| AP | Content | Size |
|---|---|---|
| 3.1 | **Stream import:** snapshot plus `changes` onto a replica; atomic installation; replicators with a narrow import path. | L |
| 3.2 | **primary/sync:** seal `CommitIntent` before sending, at most one candidate, standby ACK only gap-free, restart resolution; check unknown IDs per v3 6.2: valid retained generation, complete lossless history, old write sources excluded, durable negative claim before `NotCommitted`; expiry/restore allow no automatic substitute effect. | L |
| 3.3 | **Fencing adapter** for the chosen provider (gate 2), independent `verify`. | M |
| 3.4 | **Promotion** 5.3, **degradeToSingle** 5.3.1, `ReplicaConfigNotice`, control special case. | L |
| 3.5 | **`setStandby`** with write lock and two-sided confirmation. | M |
| 3.6 | **Boot attribute complete:** global states `fenced`/`quarantine`; permissions per Space for role, authority, data incarnation, epoch, replica version/durability. All role/version changes reconcile all further admitted replicas with CAS and stable transition; local/external partial states block normal writes/grants. `quarantine → active` only after `setStandby`; test several Spaces and reboot of both replicas. | M |
| 3.7 | **lww/set:** HLC with persistence, versioned tombstones, lease versions, causal state and compaction. | L |
| 3.8 | **Switch the control Space to primary/sync.** | M |

Order: 3.1 → 3.2 → (3.3 in parallel) → 3.4 → 3.5/3.6 → 3.8. 3.7 is independent and can run in parallel after 3.1.

**Acceptance phase 3:** v3 §11 stage 3 and all rows "3" from §12.1, real with fencing adapter.
Status 2026-10-17: The overall run over the production service passed. It comprised partition, process aborts,
failover with `NotCommitted` and the return path with netcup fencing
([evidence](../../test/evidence/phase3-partition-2026-10-17/README.en.md)). What is still missing for the acceptance is in the
[acceptance matrix](abnahme/ap3-abnahme.en.md).

### Phase 4 - Further clients (stage 4)

Desktop/CLI package `phi-spaces-client` (RemoteSpace, TCP transport, pairing); browser gateway only after F12.

## 5. Critical path and first steps

Critical path: 0.1/0.3 → 1.1 → 1.3 → 1.5 → 1.8 → 1b.2/1b.3 → 1b.4 → 2.1 → 2.2 → 2.4 → 3.1 → 3.2 → 3.4.

The critical path is complete up to 3.4: 3.1 to 3.8 are implemented, F1 is decided with the netcup fencing adapter (3.3)
and verified in real runs. What remains open is the phase 3 acceptance (section "Offen für die Abnahme" in the
[acceptance matrix](abnahme/ap3-abnahme.en.md)).

Phase 1b is accepted in the verified F15 model (phone-big, NetBird failure matrix and distributed live restores
included, [ap1b-abnahme.md](abnahme/ap1b-abnahme.en.md)). Phase 2 is complete with the exception for block 4
([ap2-abnahme.md](abnahme/ap2-abnahme.en.md)). The operations extension is implemented and verified on device and overlay.

## 6. Risks

| Risk | Effect | Countermeasure |
|---|---|---|
| One large document per Space | Commit costs and memory grow with entries, claims, log | AP 0.3 measures early; if necessary claims/log into separate family documents |
| `pi-server` as a new dependency of phi-spaces | AGENTS.md requires asking first | Transport behind interface; Unix/TCP adapter in the sibling project or as optional peer dependency |
| NetBird behavior deviates from the hypotheses | Grant/cache logic does not fit | 1b.1 before 1b.2-1b.4 |
| Android Keystore without Ed25519 | Layer B on the phone | Implement P-256 from the start |
| Provider fencing API without a real restart lock | Stage 3 not acceptable | Clarify provider choice with F1 before phase 3 begins |
| Contract errors only show up in the code | Rework on several APs | Correct deviations in the contract first; maintain acceptance cases as executable tests |
| Scope | v3 is large; many packages of size L | after phase 1 and after phase 2 each check whether stage 3 is really needed; phase 2b can bring benefit earlier |

## 7. Progress

| AP | Status | Deviation / finding |
|---|---|---|
| 0.1 | implemented: `test/support/persistent.ts` (JSONL/SQLite, crash, fault injection `failBeforeCommit`/`loseAnswer`), `test/test-persistence.test.ts` | The first test found a bug: claim replays returned a draft proxy that is unreadable after the commit ("settled overlay"). Fixed in `client.ts` and the tools (`core.plain`). It also affected the shipped behavior: a tool replay after a crash reported an error to the model instead of the result; regression test with agent on JSONL/SQLite. |
| 0.2 | implemented: separate byte gauges and quotas, reservations for claims and txn completions | New work is rejected before mutation; a slow consumer receives reserved completion events through durable follow-up jobs. More under 1.4/1.7. |
| 0.3 | implemented: `scripts/spike-durable.ts`, result in [VALIDIERUNG.en.md](VALIDIERUNG.en.md#pi-durable-feasibility-ap-03) | Multi-document commits with families are atomic. A family token with the `kind` of the singleton reads **silently another, empty document**; hence no reinterpretation of the singleton. `settle()` replaced the whole entry array at every commit; fixed (in place), commit cost at 1000 entries from about 48 ms to 3-6 ms, storage from 231 MB to 0.7 MB. Remaining costs grow linearly with the entry count (AP 0.2). |
| 0.4 | implemented: structural pi-server adapter and integration in `pi-termux-mobile/runtime/pi-serverd.mjs` | The newly built bundle and the real daemon on isolated SQLite state deliver `space` and the existing `sessions.list` over pi-client/Unix socket. No new dependency installed. |
| 0.5 | implemented: remote test environment `test/testbed/`, [testumgebung-big.en.md](../testumgebung-big.en.md) | Finding: Docker runs rootless on the server under the ssh user, `root` does not reach a daemon; the script therefore runs as this user. Production-like: only built artifacts (the bundle byte-identical to the mobile runtime, compiled examples and scenarios) go to the server, no source code; image with production dependencies, user `node`, read-only. Executed on the server: `check`, `up`, smoke, five examples, `kill`, scenario prime sieve with simulated phone (`test/testbed/scenarios/sieve-mobile.ts`). The source tests run locally. The first build uncovered an outdated `package-lock.json` (esbuild missing in the root); synchronized, only esbuild entries changed. |
| 1.1 | implemented: doc v5, registry and named Spaces | Default remains singleton; persistent v4 fixture on JSONL and SQLite proves preservation of IDs, ownership and uncommitted data on reopen. |
| 1.2 | implemented: host/Space ID, incarnation, `gid` | Registry and IDs survive reopen; old local IDs remain valid. |
| 1.5 | implemented: signed generations and durable pending execution | HMAC with persisted host key, binding to principal, Space, incarnation and local authority. Claims keep argument hash and result reservation; pending waiters keep the necessary functional execution data separately. Reopen, conflict, fixed deadline and `ResultExpired` verified. `commitSealed` is only required for primary/sync (stage 3). |
| 1.6 | implemented: principal mailboxes | Byte pages, ACK of delivered contiguous prefixes only, TTL at most 7 days, byte limit, gap and new epoch; `registrationClosed`. Unconfirmed lost take events are released through bounded maintenance; ACK does not replace a txn commit. |
| 1.7 | implemented: bounded maintenance, follow-up jobs and CompletionProfile | Durable continuation and fanout cursor across crash/reopen; a full consumer does not block a reserved completion. Profiles check result type, assignment fields and count at every commit; sieve uses them in the named Space. |
| 1b.1 (part) | implemented: NetBird server, dashboard, nginx/TLS on `spacebird.eibrain.org`, setup (groups, keys, policies), four agent peers; results in [testumgebung-big.en.md](../testumgebung-big.en.md) section 12 and in v3 4.6 | Finding: kernel WireGuard also runs under rootless Docker. Open: time measurement for group change and peer ID query, phone, the four failure rows of the matrix. |
| 1.4 | implemented: byte pages and shared commit budgets | UTF-8 size including reply envelope, cursor stays put with a budget that is too small; `readAll` without silent 1000-entry cutoff. Txn extensions reserve completion/fanout; later subscriptions update the reservation. Lowering limits below existing obligations is rejected; several operations in one storage txn share one budget. |
| 1.3 | implemented: revisions, persistent changes and immutable snapshot pages | One batch per storage txn and Space, also with multiple `spaceDoc`; internal changes can produce empty entry batches. Tokens are bound to Space/stream, query/txn and owner; TTL 60 s, 16 snapshots and 64 MiB per Space, reopen/eviction → `SnapshotExpired`. The complete primary replication content remains stage 3. |
| 1.8 | implemented: dispatcher with all stage 1 methods | Including `wait`, `notify`, `events`, `ack`; own claims/mailboxes and txn ownership. `count`/`stats` and their revision come from the same snapshot. Rate limit per peer, pending limits per principal and peer; `hello` reports capabilities and limits. Authority/epoch are local frame checks; layer A/B belongs to 1b. |
| 1.9 | implemented: `RemoteSpace`, socket and pi-server transport | Stable IDs/argument copies on retry, polls and a real client deadline even with a hanging transport; `ResultExpired` remains an error. All SpaceLike functions including mailboxes. Native integration demonstrated over existing pi-server/pi-client packages and built daemon. |
| 1.9 (socket) | implemented: `serveSpace`/`socketTransport` | Frame boundary including 8-byte header; multiplexing and reconnection. Regular files, symlinks and live Unix sockets are not removed; only confirmed orphaned sockets, cleanup only of its own inode. TCP remains a test transport with firmly assigned identity; production gate follows in 1b. |
| 1b (pre-test) | implemented: scenario `sieve-remote` (`test/testbed/scenarios/sieve-remote.ts`), host containers in the network namespace of their NetBird agents, `RemoteSpace.counters` | The service `space` over Unix socket and over the overlay (TCP 7421 only on the overlay address) in the production-like test bed on `big`: prime sieve with dying workers, host kill and 10 s network interruption (`partition`/`heal`), all checks ok. See [testumgebung-big.en.md](../testumgebung-big.en.md) section 13. Still without layer A/B, gate and RouterLease. |
| 1b.2/1b.3 | implemented: gate, layer A/B and persistent composition in `src/runtime.ts` | Two TCP gates with separate persistent hosts and current key directory checked over the wire. Android Keystore verified on the real phone; two real NetBird gates durable on big. Phone-big, native Keystore identity and fresh form/QR payload pairing passed. Complete five-part NetBird failure matrix passed, access restored and own fault rules removed. |
| 1b.4 | implemented: protected control Space, enrollment and signed grants in `src/grants.ts` | At most 60 seconds, two seconds of time uncertainty, principal/key/scope binding, check before mutation; resolution executes no pending effects. Current roles also at txn commit/lease renew. Private control signer and configured start implemented. Deployment with separate control/data hosts, grants and rotation verified over a real overlay. Distributed live restores and phone operation passed; complete NetBird failure matrix including resumption passed. |
| 1b.5 | implemented: `createEnroll`, `revokePeer`, `rotateKey` in the supervisor, own rotation with old/new signature | Commands and result atomic, roles/scope of the rotation preserved, data member can rotate its own key material without reading control data. Self-contained service start installed on big; real createEnroll/rotation flow passed. Router journal later in phase 2. |
| 1b.6 | implemented and verified live: independent CAS interface, SQLite register and signed authority change | Competing successors, wrong fencing and rollback verified. Private reader/CAS and signed recovery sockets, forced-command bridges and F15 adapters implemented. Register active on vpsc, reader/operator separation and restart persistence verified live; tightly bounded Docker/systemd F15 and private signed SSH access passed. Distributed control/data live restore with explicit F15 fencing passed. |
| 1b.7 | implemented and verified persistent/live: bounded restore functions, durable cursor, historical claims, quarantine and explicit release | Crash/reopen on JSONL and SQLite; no continuation of old pending work, current quotas and fanout budgets. Data recovery journal, admission lock, registry update, exact ACK/boot reconciliation and private RPC binding implemented. Control import completes bootstrap/policy and sets the epoch to 1. ACK service/SSH channel installed on big. Control controller, exclusive recovery start, member ACK replay and new admin release verified on both backends. Distributed live data/control restore including member ACKs and new admin release passed. |
| 1b.8 | implemented as runtime building block: external and locally installed boot permission per Space | Host/Space state, authority, incarnation, role and epoch; reads also locked, register versions re-checked before commit. Runtime requires the guard. Provisioned start with socket, read-only SSH or register TLS implemented. Two production-like daemons with matching external/local boot evidence on big. Distributed live control restore with locked old source and confirmed member ACKs passed. |

| 2.1 | implemented and verified persistent: `src/router.ts`, command states, stable sub-requests, recovery, budgets, restore review | No automatic target change; unclear outcome stays open or `needsReview`; RouterLease/delegation are implemented separately in 2.2. |
| 2.2 | implemented and verified persistent/TCP | signed lease, original-principal delegation, current rights, durable epoch fencing and bound waiter renewal. |
| 2.3 | implemented and verified persistent | atomic signed policy, immutable HRW/type placement, capacity/capability selection and declared type catalog. |
| 2.4 | implemented and verified persistent/TCP | fixed routing plans and budgets, sequential takes, partial queries, txn binding, journaled waiter winner and loser abort. Server API; a virtual public Space address is not an automatic consequence. |
| 2.5 | implemented and verified persistent/TCP | signed admission/drain/freeze/removal, shared local/remote core locks, EmptyProof and atomic root reference check. |
| 2.8 | implemented and verified: `test/support/federation-simulator.ts`, several harnesses, deterministic latency/loss/duplicates/partitions/clock jumps, reservation/request counter-model | 45 new cases in `test/test-router.test.ts`; no substitute for real overlay, replication or load acceptance. |
| 2.6 | implemented and accepted live: policy completion profiles, `purgeTasks`, `deletePrincipal`, controlled profile transition | [ap2-abnahme.md](abnahme/ap2-abnahme.en.md) blocks 6-8 |
| 2.7 | implemented: capability directory and MemberStatus | Heartbeat only over proven host keys |
| 2.9 | implemented and accepted: load test and NetBird full load, gate 4 closed | [ap2-gate4.md](abnahme/ap2-gate4.en.md); block 4 closed by decision |
| 2b | implemented: RunGate, run controller, remote members, run recovery, workers, Space lifecycle, deployment bootstrap, mobile control, alerting, audit, preview, export, schedule | [Operations §8](../betrieb-und-mobile-steuerung.en.md#8-implementation-status-and-order-of-the-operations-extension) and §7.6; case 3 over NetBird on big, mobile acceptance over WLAN and NetBird. Finer roles noted for later |
| 3.1 | Building blocks implemented and verified: entry replication, paged snapshot, stream cursor, generation maintenance; real ten-minute NetBird partition passed | [ap3-replikation.md](abnahme/ap3-replikation.en.md); not integrated into service, policy, boot and erasure |
| 3.2 | Storage foundation, signed transport, Spaces in the federation daemon and bootstrap of existing stores implemented; real runs passed | [ap3-primary-sync.md](abnahme/ap3-primary-sync.en.md); `CommitSealed` and `NotCommitted` implemented |
| 3.7 | lww/set integrated: adapter, policy, replication, erasure, compaction; real runs passed | — |
| 3.3-3.6 | Replica control implemented; netcup fencing adapter real (F1/gate 2); promotion, degrade, setStandby, notice takeover and boot attribute verified in real runs | [ap3-replica-control.md](abnahme/ap3-replica-control.en.md); degrade without fencing adapter via Space revocation |
| 3.8 | Main store on primary/sync, step 6, promotion of the control replica and router change implemented; real runs on big passed | — |

Evidence, exact limits and next operating steps: [phase 1b acceptance](abnahme/ap1b-abnahme.en.md).
