# Gate 4 and Completion of Phase 2

As of 2026-10-15. **Gate 4 is closed for the demonstrated operating profile.**
Phase 2 is completed with the explicitly documented completion decision on
block 4. This is not an unrestricted native production release:
the historical negative native load measurements remain negative. Block 4 is
not reopened. Replication and promotion still belong to phase 3.

## Binding Operating Values

| Limit | Fixed value | Evidence and meaning |
|---|---|---|
| Frame | 262,144 bytes including the 8-byte header | Exact roundtrip, larger client frame rejected; an oversized announced server frame closes the connection. |
| Commit budget | 196,608 bytes | Three txn payloads of 60,000 bytes each accepted, fourth rejected before mutation; original txn can still be completed. Stream batch 180,443 bytes; complete encoded StorageWrite array 180,747 bytes on JSONL and SQLite. |
| Entry fields | 65,536 bytes | Quota/AP1 tests including five entries near the limit and immutable pages under writes. |
| Connections | 32 per identified peer; 64 in total per listener | The next connection rejected in each case; even silent connections are now identified immediately and count toward the peer limit. |
| New connections | Token bucket 32 per source address/s, burst 32 | Before peer recognition; hence no global rate per peer across several source addresses. The existing gate regression checks the throttling. |
| Peer recognition | 5,000 ms from TCP accept | A silent socket with a hanging directory closed after a measured 5,010 ms; the small scheduling deviation is not an additional configured deadline. |
| Key challenge | 30,000 ms validity | Own layer B contract, not part of the measured directory runtime. |
| Inactivity / parallel calls | 300,000 ms; 32 calls per connection | Socket defaults; idle closing regression-tested. 32 parallel calls were not separately exercised in the new server run. |
| Snapshot | 60,000 ms, at most 16 tokens and together 67,108,864 encoded bytes per Space/host cache | 10,000 entries: 47 pages in 303 ms, first page 126 ms. Byte eviction at the sixth 12 MB copy, token eviction and expiry checked. |
| Request generation | 3,600,000 ms admission of new IDs | Longest of the five full-load journal runs 499,317 ms; the same generation suffices for this load case. Already accepted pending requests may be continued longer. |
| Result retention | 86,400,000 ms from decision | Expiry/replay behavior checked with an injected clock; no 24-hour continuous measurement. |
| Entries | 10,000 per Space; by default 1,000 per owner | The load inventory explicitly uses 10,000 per owner. This is not a silent change of the default. |
| Further byte budgets | Fields 64 MiB; claims 32 MiB; outbox 8 MiB; total document 128 MiB; event 160 KiB; log 4 MiB; follow-up orders 16 MiB | Hard core budgets with rejection/backpressure; no simultaneous full utilization of all budgets measured. Mailbox 8 MiB / at most 7 days. |
| Owner quotas | 20 registrations, waiters and txns each | Kept for the documented worker profile; no global capacity promise. |
| Distributed deletion run | 32 participants, 4,096 collected entry IDs per command, ID at most 256 characters | Exceeding remains fenced. No unlimited principal deletion promised; check the production scope before starting. |

## Basis of the Decision

The existing [router load measurement](../../../test/evidence/ap2-router-load-2026-10-12/README.md)
documents 10,000 entries, 1,000 jobs, three members and six workers with 5,000
completed root operations on SQLite. 36 lost effect replies
were resolved through the same IDs. 227.5 seconds total runtime and about
258 MiB measured RSS apply to the in-process transport described there.
API p95/p99 are not pure network latencies.

The [five NetBird journal runs](../../../test/evidence/ap2-netbird-journal-2026-10-14/README.md)
document the signed overlay path under 1,000 jobs with six workers,
26 targeted journal SIGKILLs, 25,294 checked original claims, no open
transactions and no unused future reservations. Runtimes:
443,914 to 499,317 ms. ACK and member aborts have their separate
completed evidence in the [phase 2 acceptance](ap2-abnahme.en.md).

The [supplementary limit test](../../../test/evidence/ap2-gate4-2026-10-15/README.md)
measures snapshot, frame, commit, connection and runtime limits on built
artifacts in production mode on big with 2 CPUs and 1 GiB RAM. Peak RSS in the
snapshot test: 244,903,936 bytes. The follow-up check measures exclusively
the corrected handshake and real encoded storage writes; it does not repeat
a job load run. All own containers were removed, existing containers
remained unchanged.

## Scope of the Completion

The values are the fixed baseline for this working profile. Snapshot pages
must be read completely within their fixed TTL; load increases,
slow links or more than the checked inventory need new dimensioning.
An expired token requires a new snapshot. The 64 MiB snapshot limit
counts encoded contents, not the complete JavaScript heap. Concurrent
snapshots of several Spaces/hosts additionally raise process consumption.

The commit budget works with conservative functional reservations.
The measured StorageWrite boundary case is not a general formal limit
of all root/admin multi-document transactions to 192 KiB. The complete
physical write amplification was not measured. Historical root reservation bytes
are therefore explicitly not used as actual commit/disk bytes.

Phase 2 is completed **with the existing exception for block 4**. The
demonstrated load paths use fixture provisioning; the additional
physical member/deletion/profile evidence does not replace a passed native
1,000-job production measurement. A public virtual Space address is
not offered automatically. External effects still require idempotence
or a shared transaction. Power loss, host/disk loss, standby,
replication and promotion are not released by this completion.

The next implementation step is phase 3 according to the target contract. Its
fencing, import and takeover checks receive their own evidence.
