# Paged entry-replication snapshots — 2026-10-15

All 23 compiled cases passed on `big`: eleven existing entry invariants plus
twelve paged-transfer cases on JSONL and SQLite. Only built JavaScript was shipped.
The owned rootless container used a pinned image, production mode, 2 CPUs,
1 GiB RAM, a read-only root, no capabilities, no external network and private
temporary stores. It was removed after the run. The protected inventories match
exactly before and after (IDs, status, start timestamps and restart counts).

The large fixture transferred **353,186 encoded bytes in 20 pages** on each
backend. Payloads stay hidden until the reference publication, while local writes
remain usable and keep their causal HLC ordering. Old Changes cursors retain their
order across publication and a second duplicate generation. Version-one documents
migrate without changing original change IDs, owner or replay receipts.

A separate 32-KiB-budget fixture measured the complete actual StorageWrite arrays:
largest commit **3,743 bytes on JSONL / 3,746 bytes on SQLite**, publication
**2,433 bytes** on both. Four completed generations exhausted the configured
retained-byte quota, correctly applying backpressure. These are fixture-specific
sizes, not disk/fsync amplification or maximum-throughput measurements.

Before/after actual Storage.commit faults exercise begin, every page and final
publication. Reopen retries keep the original import ID, page cursor and result.
Additional checks cover bad final hashes, altered/out-of-order/duplicate pages,
permission revocation, fencing, token expiry, source-Harness loss after complete
receipt, partial abort recovery and generation backpressure.

`server.tap` is the built run; `metrics.json` extracts only numeric diagnostics.
`runtime.json` binds library/scenario hashes; `cleanup.json` preserves sanitized
inventory equality. `build.json` intentionally retains parent commit `607a543`
and dirty-tree attribution; `validation.json` binds final sources. The tested
library and synchronized mobile bundle are byte-identical.

This is administrative snapshot/persistence acceptance in one isolated container.
Clock/partition cases use injected time and direct calls. It is not live NetBird
replication, primary/sync or promotion. Continuous transport checkpoints,
maintenance of retained generations and production ACL/boot/erasure wiring remain
open. No production replication was activated.

[Protocol and limits](../../../docs/abnahme/ap3-snapshot-transfer.md),
[remaining Phase 3 work](../../../docs/abnahme/ap3-replikation.md).
