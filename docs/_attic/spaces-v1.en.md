# phi-spaces: historical local implementation status

> **Superseded by [implementierungsstand.md](../implementierungsstand.en.md).**
> This snapshot of 2026-10-07 is kept only for the identifiers and decisions
> of that time. In particular L2, L3, L7 and L13 are no longer
> the current status.

As of 2026-10-07; sources src/core.ts, src/client.ts, src/doc.ts, src/index.ts and local tests.
This is the local library; federation is the [v3 target plan](../federation-plan-v3.en.md).
The historical v1/v2 plan versions are not binding.

## Architecture and data model

One harness process owns the storage. The default Space is the session-scoped document phi-spaces.space,
version 5. Further named Spaces live in the session family phi-spaces.named-space, keyed by their
generated `spaceId`; the document phi-spaces.registry maps aliases to IDs and holds the `hostId`.
Mutations read/change/write a Space in one harness commit. Snapshot read operations use no commit.
MemoryStorage is volatile; JSONL allows persistent resumption within the harness contract.
The storage and its error contract determine durability, not the Space API alone.

| Module | Responsibility |
|---|---|
| core.ts | pure semantics with explicit now, entries, txns, waiters, notify, expiry and limits |
| doc.ts | document of the default Space and migration |
| spaces.ts | registry, named Spaces (`createSpace`, `listSpaces`), resolution alias → `spaceId` |
| claims.ts | durable request claims and request generations (v3 6.2) |
| client.ts | local phi-spaces client (API class `PhiSpaces`, interface `SpaceLike`), blocking operations, once hook, snapshot reading |
| index.ts | agent tools, claims, prompt, reaper and delivery |
| meter.ts | process-local counters and rates |
| canonical.ts | canonical JSON encoding for field comparison |

SpaceState contains nextId, entries, txns, regs, waiters, outbox, returned, limits as well as spaceId, incarnation and
rpc (claims/generations). EntryRec stores type/types/fields, expires, writtenUnder, takenBy, readBy, owner and
optional size. Local IDs have the form `<prefix><incarnation>-<counter>` (older `e<n>` remain valid); views
additionally carry the global ID `gid = <spaceId>/<local ID>`. `spaceId` and incarnation arise at
registration, the default Space on first use through `PhiSpaces` or the tools.
Times are absolute milliseconds; FOREVER stays non-expiring.

**Request claims:** `PhiSpaces` mutations and read/take optionally accept `request: {principal, generation,
requestId}`. Claim, effect and result arise in the same commit; only a hash of the business
arguments is stored. A retry with the same identity and the same arguments returns the stored result (also after
restart); an open request continues with its first deadline. Error cases: `RequestConflict`,
`RequestExpired`, `ResultExpired`, `IncarnationChanged`, `OperationCancelled`. Plus `issueGeneration`,
`pollOperation`, `cancelOperation`. Result deadline (`claimResultMs`, default 24 h) and admission deadline
(`generationAdmitMs`, default 1 h) are limits. Generations are not signed yet; that follows with the
`space` service (AP 1.8).

## Operations and guarantees

- write creates a new entry. No unique keys or upserts. Txn writes are invisible until commit.
- read/take wait for a match until timeout; IfExists waits only for matches locked by foreign txns.
- Templates compare field values; a missing/null field is a wildcard. ID templates are implemented.
- Take without a txn removes directly; under a txn it reserves. Abort/expiry returns the reservation.
- Read under a txn locks against foreign takes. Commit makes writes visible and takes durably effective.
- readAll is a local snapshot, oldest first, at most 1000 without a cursor. count/stats are snapshot gauges.
- notify delivers sequence-numbered best-effort events. Explicit cancel suppresses pending bundles;
  natural expiry may still emit a bundle. Existing subscriptions use the current rate limits.
- wait parks a job without a blocked model turn. A served take receives a txn of the recipient.
  A failed delivery releases it; a later lease expiry makes the task available again.

Agent tools: space_write, space_read, space_take, space_list, space_wait, space_notify, space_txn, space_lease.
No space_count tool. Blocking tool timeouts are limited to 60 s; longer waiting goes through space_wait.
Claims are task-scoped in the same commit as the tool mutation/decision. Tool replay returns the
stored result; txn begin/commit/abort and lease actions also have claims. A host call without
a once hook has no automatic replay deduplication. External effects are not generally exactly-once.

## Ownership, limits and services

Conversations may use or change only their own txns/leases. Foreign normal entries can be read/taken.
Owner=null belongs to host code; it grants agents no txn/lease rights. Host code without as may manage everything.
64 KiB entry/handback, 128 characters type name, 16 types, 1000 entries per owner, 10,000 global,
20 subscriptions/waiters/txns per owner. Host code is exempt from these quotas, but not from maxSpaceBytes.
maxSpaceBytes defaults to 64 MiB of the JSON entry fields; there is no overall limit for claims, outbox,
document/storage bytes or Node RAM. Protocol/mailbox quotas from the federation plan are not implemented.

startService starts reaper and delivery. settle accounts for expiries also at a later operation
if no background service ran. Timers are capped at about 24.8 days and set again.
Delivery is serialized per target with bounded parallelism between targets and retry/backoff.
Non-numeric targets are still not delivered as remote mailboxes.
The meter stays process-local, the default meter shared; an explicit meter can be assigned to individual harnesses.

## Historical error/gap identifiers

The identifiers are kept for references from the plan; they are not an unchanged error status.

| Identifier | Current status |
|---|---|
| B1 | fixed: entry ID in template/tools |
| B2 | fixed: cancel sends no remaining notify bundle |
| B3 | fixed: rate-limit change affects existing subscriptions |
| L1 | open: real peer mailbox/remote delivery missing |
| L2 | open: revision/change stream missing |
| L3 | open: global Space/replica identities missing |
| L4 | open: general availability events after return missing |
| L5 | open: general batch API missing |
| L6 | fixed: txn tool claims present |
| L7 | partly fixed: total entry bytes limited; internal documents/storage need further limits |
| L8 | open: no range/in/existence templates |
| L9 | no guaranteed FIFO/priority order |
| L10 | fixed: delivery parallelism between targets |
| L11 | partly: own meter possible; no automatic persistent federation aggregation |
| L12 | byType counts the main type, not every supertype |
| L13 | open: readAll without pagination |
| L14 | external pi-serverd/phone integration not accepted by these example tests |

## Performance and evidence

Document size, linear search and waiter scans influence cost. Measurement with `scripts/spike-durable.ts`
in [VALIDIERUNG.md](VALIDIERUNG.en.md#pi-durable-feasibility-ap-03): a commit with one write costs about
3–6 ms at 1000 entries and grows linearly with the entry count, because `write` goes through the total bytes and `settle` through all entries.
No proven throughput or linear
speedup; snapshot limits and the JSON byte budget are not RAM/VPS minimum requirements.
Optimizations such as indexes, sharding, dirty flags and a remote protocol need their own implementation/tests.

Typecheck, core and example suites are run locally. Examples and the actual scope of evidence:
[examples.md](../examples.en.md), [test overview](../../test/examples/README.en.md).
Federation, NetBird identity, promotion and scientific model quality are not demonstrated by them.
