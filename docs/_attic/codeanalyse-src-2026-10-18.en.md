# Code analysis of `src/`: logic errors, duplicates, dead code, optimization

Date: 2026-10-18 (checked and updated the same day)
Scope: the whole `src/` directory (14809 lines in 87 `.ts` files)
Method: three parallel deep analyses (core semantics, service/transport/federation, recovery/membership/control),
followed by a second check of every finding against code, pi-durable and specification (`docs/federation-plan-v3.en.md`).

Every item carries a status:

- **fixed**: confirmed and corrected in the code (with a regression test where stated),
- **weakened**: the finding is correct, but the severity or the mechanism was described wrongly,
- **no error**: the original assumption was wrong or the behavior is intended,
- **open**: confirmed, deliberately not implemented yet (reason in the item).

File:line references relate to the state before the corrections.
After the corrections: `npm run typecheck` clean, `npm test` 754 tests (753 passed, 1 optional case
skipped, no failures), `npm run check:branding` green.

---

## Originally "Critical"

### 1. `migrate` loses `runGates` and `archived` — weakened, fixed

`src/core.ts:157-189`

The fields were indeed missing. What was wrong was the assumption that `migrate` runs on every reopen: pi-durable calls
`migrate` only if the stored version is lower than the definition version
(`materializeDocumentValue` in `pi-durable/dist/documents.js`). `Space` and `NamedSpace` are at version 5,
and `runGates`/`archived` exist only in v5 documents. A normal reopen loses nothing; the gap would
have become data loss only at the next version jump (latent, not acute).

**Fixed:** `migrate` carries over `runGates` and `archived`.
Test: `test-core` "migrate keeps run gates and the archive marker".

### 2. `finish` can throw after `delete s.txns[id]` — weakened, cause fixed

`src/core.ts:827-848`

An "inconsistent intermediate state" does not arise: every operation runs in one `host.commit`, a throw
discards the whole draft. The actual risk is liveness: if the `registrationClosed` event throws on
every attempt, every commit/abort of the transaction fails, and because `settle` runs at the start of almost every operation,
an expired transaction can block the whole Space. The same applies to `registrationClosed`/
`timeout` in `expire` and to the publish events in `finish`.

In normal operation the event cannot be too large: `notify` and `addWaiter` check
`handback + EVENT_OVERHEAD ≤ maxEventBytes` as well as every matching entry. The actual cause was
`setLimits`: a `maxEventBytes` lowered afterwards was not checked against existing registrations and
waits.

**Fixed:** `setLimits` refuses a lowered `maxEventBytes` as long as an existing registration or a
wait could produce an event that is too large with it. Test: `test-core` "a lower event limit is refused …".

---

## Originally "High"

### 3. `expire` sets the watermark too high when the budget is exhausted — weakened, fixed

`src/core.ts:458-476`

The value `at` is above the real minimum of the remaining dead entries. Practically without consequence, because time
is monotonic and at the next `settle` the same transaction (same `expires`) is the minimum again; a
sweep with `at' < at` does not occur. But `nextExpiry` returned `at` instead of the earliest remaining expiry.

**Fixed:** watermark = `min(minimum of the living, expiry of the first dead entry not removed)`.
Test: `test-core` "an expiry sweep cut short by the commit budget …".

### 4. `policy?.completionProfiles.some` — weakened, no fix needed

`src/core.ts:800`

`completionProfiles` is mandatory in the type `FederationPolicy` (`routing-semantics.ts:52`), the crash is only
hypothetical. **The original recommendation to delete the pre-check was wrong:** it prevents exactly
`assertMemberTake` (without try/catch, `core.ts:818`) from throwing out of `serve` for entries without a completion profile.
It stays.

### 5. `refreshReservations` is O(txns × entries × (regs + waiters)) — fixed

`src/core.ts:274-287`

**Fixed:** a single pass over the entries distributes the publish costs to the (at most two)
transactions involved; `publishCost` runs once per entry instead of once per transaction. Thus O(entries × (regs +
waiters)) instead of additionally × txns.

**Fixed (incremental, exact):** the proposed pure delta computation on `t.reserved` would not have been equivalent
(`reserved` is a maximum, not a sum). What is exact instead: every cost increase of a transaction
goes through `reserve` (writes, takes) or through `refreshReservations` (subscriptions); `reserved` therefore never
lies below the full recount. A transaction that the new registration or the new wait does not touch
(no matching own entry, no registration under it) keeps exactly `reserved`. Only the
touched transactions and those without a reservation (older documents) are recounted. The limit checks run for all.
Test: `test-core` "subscriptions keep every transaction's completion reservation at the full recount"
(randomized, compares against the old full recount; a mutation that does not recount
touched transactions fails).

### 6. Hot path `write` serializes the entry several times — fixed

`src/core.ts:540-568`

**Fixed:** `write` measures the view once and passes the size to `checkEventSize` and `publishCost`;
`publishCost` runs once instead of twice; `preflightFanout` builds one view for all candidate events (only
measured there, never stored). `notifyWrite` still creates one view per triggered event: these events
are stored durably in outbox/mailbox, a jointly referenced object in a document draft would be risky.

### 7. Identical `changeRequest` hash twice — fixed

`src/service.ts:414` / `435`

**Fixed:** helper `changeRequestHash(principal, request)` in `service.ts`.

### 8. `pageAfter` is O(n²) per page — fixed

`src/entry-replication.ts:319-327`

**Fixed:** cumulative upper bound (every event and every position with a comma, the `positions` key always
counted). The exact frame is serialized only if the bound no longer fits; no array copies per
event. The result is identical to the old version (the bound is never below the exact size).

### 9. `importSnapshotPage` is O(pages × history) — fixed as far as semantically possible

`src/entry-replication.ts:401-418`

**Fixed:** during page import, already staged pages are no longer canonicalized and hashed per import. Their
chain was checked on intake and is bound in the ledger (`chainHash`, `nextOffset`); only
chaining, offsets and agreement with the ledger are rechecked. `finishSnapshotImport` checks the complete
chain as before.

**Deliberately kept:** the check of every new page together with all staged events against the current
logical state (`append`). It is semantics, not overhead: the logical state can change between two pages
through local writes, and conflicts across page boundaries (e.g. a reused request ID) must be rejected already
at page import (`test-entry-snapshot-transfer`). This part remains O(pages × history).

### 10. Order-dependent target comparison — partly no error, fixed

`src/federation-rpc.ts:45`

**Fixed:** comparison via `canonicalJson`. A concrete failure case was not demonstrated, but the
dependence on key order was real.

**No error:** `routing-semantics.ts:186` compares `keyFields`, a string array. `canonicalJson` does not sort
arrays; the proposed change would have changed nothing.

---

## Originally "Medium"

### 11. `intervalOf` ignores `r.minIntervalMs` — no error

Intended, see the comment at `core.ts:579`: "read from the limits when needed, so changing it also affects
existing subscriptions". `minIntervalMs` is a flag (set only for conversations).

### 12. `assertMemberRenew` also blocks lease shortening under "draining" — fixed

`src/member-admission.ts:130-139`

`renew` applies to entries, transactions, registrations and waits. According to the specification, "unbounded
lease extensions are not completion work"; shortening was blocked unnecessarily.

**Fixed:** transactions stay bound to their completion boundary; entry, registration and wait leases
may be shortened but not extended during drain. Test: `test-core` "while draining, entry leases …".

### 13. `claims.sweepCursor` is dead code — weakened, fixed

No forgotten feature: the comment (`claims.ts:185`) explains why no cursor is kept. The
`delete` cleans up a field of earlier versions (now commented). What was real was sorting all claim keys per
`settle`.

**Fixed:** filter first, then sort only the expired keys.

### 14. Dead branch in deadline check — no error

`!Number.isFinite(d) && d !== FOREVER || d < 0` binds as `(!isFinite(d) && d !== FOREVER) || d < 0` and rejects
`NaN` and `Infinity`. Only `d !== FOREVER` is redundant; the branch is not ineffective.

### 15. `mailbox.bytes` serializes the whole mailbox per append — weakened, fixed

Recomputation and subtraction in `expireBox` follow the same formula and were not contradictory. What was real was
O(mailbox) per event (up to 8 MiB).

**Fixed:** `appendMail` carries the balance forward. Test: `test-core` "the mailbox byte tally matches …".

### 16. `queueEvent` backlog check — fixed

**Fixed:** helper `pendingFanout`: `canonicalJson(consumer)` once, no `slice` copies.

### 17. `expire` does `splice(indexOf(e))` — fixed

**Fixed:** one `prune` pass over a set of the removed entries. Registrations and waits stay with
`splice` (bounded per owner).

### 18. Rate limiter iterates the whole map on every call — fixed

**Fixed:** the own expired entry is reset directly; the others are swept when a new peer is created at most
once per window, and always before a full table rejects.
Test: `test-ap1` "AP1 call rate table frees lapsed windows …".

### 19. `checkTypes` checks only `some()` — no error, consequence documented

Intended and tested (`service.ts:43`, `test-service` "types per role including the supertypes"). But the consequence
was written down nowhere: because the writer states the supertypes itself, a role with a grant on `Job` can write
`{type: "X", types: ["Job"]}`. Type grants are not an integrity boundary for subtypes. Federation members,
in contrast, enforce the exactly declared supertypes (`member-admission.ts:57-60`).

**Documented** in `docs/api.en.md` (section service/policy).

### 20. `epochForSpace` before the `space` validation — fixed

Harmless (a throw ends up in `handle` and becomes an error reply), but untidy. **Fixed:** `space` is validated before the
call.

### 21. Internal error messages go to the client unfiltered — fixed, extended

The finding named only `socket.ts:96`. The main path was `SpaceService.error` (`service.ts:545`): every unclassified
error went to the peer with `e.message`.

**Fixed:** both places send `"internal error"` and log the error server-side
(`console.error`). Classified errors keep their messages.

### 22. No replay protection for signed recovery calls — weakened, fixed

The socket is in a private directory (0700); an "intercepted" call presupposes local access.
The proposed `requestId` lock would have been wrong: `requestId` is legitimately reused
(`ack:${recoveryId}` in `configured-recovery.ts`, idempotent retry in `test-operations`).

**Fixed:** a verified, exactly identical signed call (algorithm, signature, call) gets the reply of the first call
within its validity window; the handler runs only once. Only verified calls
are remembered (at most 4096). A freshly signed repetition is executed as before.
Test: `test-operations` "out-of-band recovery answers a replayed signed call …".

### 23. Operator `controlAck` bypasses the host key check — no error

Operator and supervisor keys are the pinned trust anchors of the recovery socket. The repeated
`host-key:` check applies only to the role `host`, because exactly this key carried the signature
(`recovery-service.ts:27-29`). What the finding overlooked is that the supervisor may also call `controlAck`.

### 24. `assertMemberTake` allows txn-less takes in `draining` — no error

Specification (`federation-plan-v3.md`, drain): "Without a matching profile, no new processing take txn may start during drain;
purely destructive takes for authorized emptying remain possible." Profiled tasks without a
transaction are rejected by `core.ts:612` anyway (`CompletionViolation`).

---

## Originally "Low / dead code / redundancy"

### 25. `sha256(canonicalJson(v))` helper duplicated — fixed

**Fixed:** `digestJson(v)` in `canonical.ts`. The form occurred in 23 files, not 9 (the
original list overlooked among others `membership`, `federated-space`, `federation-journals`, `federation-references`,
`routing-semantics`, `data-admin`, `restore`, `claims`, `entry-replication`). All now use the central
helper (together with the new replay protection 24 files); `createHash` stays imported only where other
hashes are formed.

### 26. Serialization helper three times — fixed

**Fixed:** `src/json.ts` bundles the variants, each under a name that states its validation:
`jsonCopy` (lenient, `JSON.stringify` rules, works on document drafts), `canonicalCopy` (rejects non-finite
numbers), `strictJsonCopy`/`assertPlainJson` (only plain, finite JSON) and `jsonBytes`. `core`,
`claims`, `stream`, `router`, `routing-semantics`, `federation-policy`, `profile-transition`, `root-erasure`,
`data-admin`, `primary-sync` and `entry-replication` use them; every place keeps its previous semantics
(only deviation: `router`/`data-admin` now measure `undefined` as 0 bytes instead of throwing).
`structuredClone` in `federated-space`/`distributed-erasure` stays: it preserves `undefined`, which is intended there.

### 27. Fence state persistence duplicated — fixed

**Fixed:** `atomicJsonFile` in `src/json-file.ts`, used by `fileFenceState` and `ContainerFencing`. A
corrupt file gives a clear error message instead of a `SyntaxError`. Locking is not needed: one
fencing service runs per host.

### 28. Duplicate frame length measurement — fixed (`service.ts` only)

**Fixed** in `handleText`. `remote.ts:152` measures only once; nothing was duplicated there.

### 29. `default:` in the dispatch switch unreachable — no fix

Defensive default against a future deviation between `METHODS` and the switch; stays.

### 30. Redundant partition check — no error

`partitions > 1 && routers.some(r => r.journalId === o.router.journalId)` is a real validation: with
`partitionRouters` the main router must not also be a partition router. The finding presupposed what
the check first ensures.

### 31. Release defaults can restore wrong state — fixed (fail-closed)

**Fixed:** `NetcupFencing.release` and `ContainerFencing.release` abort without a stored fence state,
instead of guessing `autostart=true` or `unless-stopped`; nothing is started then, the lock stays. In production
both use state files, `fence` always stores the prior state before the change; the abort concerns only
a lost or deleted state file. The operator then restores the entry or sets the value
deliberately by hand. Tests in `test-netcup-fencing` and `test-container-fencing`.

---

## Additions of the second check

- `setLimits` did not check a lowered `maxEventBytes` (cause of item 2) — fixed.
- `SpaceService.error` passed on unclassified error texts (extension of item 21) — fixed.
- The mailbox balance (item 15) needs no fallback to a recomputation: `bytes` has belonged to every mailbox since the
  first mailbox version (commit `f7bcfd5`).

---

## Findings found later (A–O)

These 15 items were in the three subagent reports but were not included in the first consolidation
into the 31-item list. Each was checked against the current code; five were justified, several of the
proposed fixes would have weakened checks.

### Fixed

#### A. `rotation.ts:39-40` — return values of `core.probe` ignored — fixed (hardening)

A failure is not reachable today: both entries were listed as visible in the same commit, and
control-space entries are not marked `restoredUnverified` on a restore. If a take were to miss anyway,
old and new key would remain active at the same time. **Fixed:** both takes must return `found`,
otherwise `PermissionError`. Test: `test-auth` "key rotation refuses when an entry it listed cannot be consumed …".

#### B. `fencing.ts:11` — missing `durability` — fixed

Project-wide, a missing `durability` counts as `sync` (`durabilityOf`, `boot.ts:24`); F15 treated it as
"not sync". All permit producers (`permitFor`) set the value, only hand-built permits would be affected.
**Fixed:** a `primary` permit without `durability` is rejected like `sync` (fail-closed). For `local` the value
is meaningless. Test: `test-auth` "F15 fencing treats a primary permit without durability as sync …".

#### G. `entry-replication.ts` `applyErasures` — finding outdated, real remainder fixed

The described fixed-point loop with an `at` map no longer exists. What was real: for every event, the principal
and change ID of every erase event were canonicalized again. **Fixed:** precomputed once per erase event.

#### L. `core.ts` `overheadBytes` — fixed (most important item)

The big item was `jsonBytes(s.mailboxes)`: on every write, all mailboxes (each up to 8 MiB) were serialized.
**Fixed:** `mailboxesBytes` computes per box the metadata with an empty event array plus the exact balance `bytes`
(item 15), the same result, O(boxes) instead of O(mailbox bytes). The remaining items (outbox, regs, waiters, txns)
are bounded by owner quotas or `maxOutboxBytes` and stay. Test: `test-core` "the document overhead
counts mailboxes exactly …".

#### O. `core.ts` `MAX_LIST` — fixed (documentation)

It is the schema limit of the agent tool `space_list` (`index.ts`), not a host limit. A rename would break the
public API (`core.MAX_LIST`). **Fixed:** comment on the export.

### Justified, deliberately not changed

- **E.** `member-transition.ts` scans claims/generations from the start at every step (O(n²) over the transition). But every
  step sums all entries anyway (`s.entries.reduce`) for the budget check; a cursor alone brings
  little. Rare (only at an authority transition).
- **H.** `append` builds `known`/`requests` over the whole history: the same boundary as item 9. A persistent
  index would enlarge the document considerably; a memory cache does not help because the draft state is new per commit.
- **J.** `timedOut` in `federated-space.ts`: O(members × candidates) with few members, without measurable benefit.

### No error (proposed fix would be wrong or harmful)

- **C.** `run-controller.start`: idempotency is bound to the commandId, a different command is a conflict —
  the same pattern as with RunGates (`core.ts:1213`, test "case 8"). The fix would soften the command assignment.
- **D.** `member-transition.ts`: the pre-check (line 35) throws for the same `recoveryId` and a differing
  `authorityId`. Optionally the same check could also be in the commit, as protection between snapshot and commit.
- **F.** `boot.ts`: the second register read is the "unchanged while reading" version check; without it
  no change can be detected. Both reads are already bundled (`readRegisterRecords`).
- **I.** `federated-space.ts:340`: deliberate re-reading of the routing state after the `await` of the step; the state
  also changes outside `serial` (replica notices, membership). Reading once would weaken the binding check.
- **K.** `replica-control.ts:270`: if `head` grows during catch-up, the new revisions should be transferred too;
  a fixed end value would leave the target behind.
- **M.** `stats().returned`: `stats` is documented as the state "after the settle"; `settle` would return exactly these entries.
  No mixing of two meanings.
- **N.** `remote.ts` `sealedWait`: commented and intended — the request may not be admitted yet, a
  poll would not find it; only the repeated call with the same request identity hits the claim.

### Low / deliberate (not listed individually)

- `core.ts` `leased` — three linear `find` scans per `renew`/`cancel`; lease operations are rare. (The earlier
  statement `maxEntries=10000` is outdated: the default is meanwhile unbounded, `FOREVER`.)
- `core.ts` circular import core ↔ paging ↔ claims — works under ESM, structurally unattractive.
- `netcup-fencing.ts` lock spinning with TOCTOU — only with a stale lock (mtime > 60 s), low.
- Sync I/O in fence paths — rare, low.

## Priority overview (after the check)

| Status | Items |
|---|---|
| fixed | 1, 2 (cause), 3, 5, 6, 7, 8, 9 (as far as semantically possible), 10, 12, 13, 15, 16, 17, 18, 20, 21, 22, 25, 26, 27, 28, 31, A, B, G (real remainder), L, O |
| no error / intended | 4, 11, 14, 19 (documented), 23, 24, 29, 30, C, D, F, I, K, M, N |
| justified, deliberately not changed | E, H, J |

After the check, no item reaches the level "critical". None is open; E, H, J and the page-by-page
conflict check in item 9 stay as they are, with reasons.
