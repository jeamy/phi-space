# Phase 2 Gate 4 — 2026-10-15

Two bounded production-mode runs on `big`, in owned rootless Docker containers:
2 CPUs, 1 GiB RAM, read-only root, no capabilities, no published ports and no
external network. Only built JavaScript was shipped. Both containers were removed;
protected container inventories were unchanged. Stores used private temporary
scratch space and were removed with the containers.

`gate4.json` measures the existing default limits on Node 22.23.3: 10,000 SQLite
entries (1 KiB payload each), 47 snapshot pages in 303.1 ms, first page 125.8 ms,
peak RSS 244,903,936 bytes. Snapshot data total 12,026,679 encoded bytes. The
sixth identical snapshot evicted the first at the aggregate 64 MiB cap. The
16-token count cap and exact 60-second expiry were also exercised. Expiry uses
an injected clock. A concurrent write of a different type occurred during traversal;
the existing AP1 five-large-entry regression separately changes the same query's
entries during pagination and checks immutable contents on JSONL and SQLite.

The run checks an exact 256 KiB wire frame, oversized client/server frames,
64 global connections and refusal of the 65th, 32 identified connections per
peer and refusal of the 33rd, and a hung-directory refusal after 5,002 ms.
The generation test uses the real one-hour admission/24-hour result-retention
defaults with an injected clock, including pending continuation and rejected new
IDs. It does not wait 24 hours in wall-clock time.

Review found that silent sockets previously postponed peer identification until
the first frame. The gate now identifies at TCP acceptance; silent sockets consume
peer quotas and a hung lookup expires after five seconds. The short second run
(`followup.json`) tests the changed code without reseeding the inventory: a socket
sending no frame closes after 5,010 ms. This limit bounds peer identification;
application key challenge validity remains 30 seconds. Normal identified idle
connections retain the five-minute idle limit.

Both persistent backends admitted three 60,000-byte transactional payloads,
refused the fourth, and completed the original transaction. The published stream
batch was 180,443 bytes; the second run measured **180,747 bytes** for the complete
JSON-serialized StorageWrite array on both JSONL and SQLite. This is a concrete
boundary case, not a proof that every possible administrative/multi-document
commit is below 192 KiB, nor a measurement of disk pages/fsync amplification.
Resource reservations are not measured physical bytes.

`runtime.json` and `followup-runtime.json` bind the runs to exact library/scenario
hashes. The two build manifests intentionally retain their original dirty-tree
attribution to parent commit `3440300`. The inventory test predates the handshake
fix; the follow-up tests the fixed library. No old workload or Block 4 job was
repeated. Existing full NetBird load/crash runs remain separate evidence.

Gate 4 accepts the documented baseline for the tested workload, not peak
throughput or a new guarantee for every combination of maximum quotas. Phase 2
is closed with the owner's explicitly retained Block 4 exception; unconditional
native production acceptance and Phase 3 replication/promotion are not claimed.
See [acceptance and limits](../../../docs/abnahme/ap2-gate4.md).
