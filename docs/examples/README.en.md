# Example Documentation

As of 2026-10-07. These documents describe local examples and clearly marked drafts.
The [authoritative overview](../examples.en.md) contains the invocations and the current scope of evidence.

| Learning step | Document | Content |
|---|---|---|
| 1 | [Master/worker](sieve.en.md) | segmented prime sieve, transactional tasks and resumption |
| 2 | [IoT pipeline](iot.en.md) | take under a txn, fork/join, validation, deduplication, atomic report |
| 3 | [Chat](chat.en.md) | notify, addressed ring, stopping the processing |
| 4 | [Golomb](golomb.en.md) | actual DFS, concurrency, task recovery and search-run identity |
| 5 | [arXiv](arxiv.en.md) | model workflow, server-side txn check, limits of the data basis |
| 6 | [Cache](cache.en.md) | local atomic cache with TTL/CAS; not replicated |
| Background | [Historical references](../_attic/HISTORISCHE-REFERENZEN.en.md) | Linda/JavaSpaces and differences from the project |
| Correction log | [Implementation analysis](../_attic/IMPLEMENTIERUNGS-ANALYSE-V2.en.md) | fixed findings and remaining limits |

All runnable examples are in [examples/](../../examples/).
Tests: [test/examples/README.en.md](../../test/examples/README.en.md).
Federation, HRW and LWW replication are implemented ([implementation status](../implementierungsstand.en.md)), but these examples
do not use them. `RemoteSpace` is the RPC layer against a single space service;
the remote sieve scenario lives in the test bed, not in these example pages.

There are no measured speedup or throughput tables. "Scripted tested" means fixed
model answers with a real local Space, not the quality of a real LLM.
