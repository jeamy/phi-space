# Historical Context

As of 2026-10-07. Background, no commitment to implemented federation or JavaSpaces compatibility.

Linda describes coordination over an associative tuple space: out writes, in takes destructively,
rd reads without removing. eval creates active tuples by execution; a write with "agent code" is
**not** an eval equivalent in today's phi-spaces. The operations used are JavaSpaces-inspired
write/read/take with templates. phi-spaces uses JSON entries instead of Java objects and remote RMI.

Primary source: Carriero/Gelernter, [Linda in Context](https://doi.org/10.1145/63334.63337), 1989.
Historical patterns can motivate modern examples; the local code is not a historical
reference implementation and no performance evidence for Linda, Outrigger, Blitz or GigaSpaces.

JavaSpaces adds entries, templates, leases, transactions and notifications.
The current mapping in the project is described in the [implementation status](../implementierungsstand.en.md);
the earlier snapshot remains in [spaces-v1.md](spaces-v1.en.md). JavaSpace05 functions such as
batch operations and availability events are not completely implemented.
A conceptual API proximity is not a certificate of full specification conformance.

| Pattern | Local example | Limit |
|---|---|---|
| Task bag | [Master/worker](../examples/sieve.en.md) | segmented sieve; local transactional tasks |
| Workflow | [IoT](../examples/iot.en.md) | atomic local steps |
| Publish/subscribe | [Chat](../examples/chat.en.md) | best-effort events in one harness |
| Search partitioning | [Golomb](../examples/golomb.en.md) | local workers, no CPU/host scaling acceptance |
| Research team | [arXiv](../examples/arxiv.en.md) | model-driven interpretation with source limits |
| Replicated state | [Cache](../examples/cache.en.md) | local cache implemented; replication missing |

Further historical bibliography is to be kept apart from current implementation evidence.
[Back to the overview](../examples/README.en.md).
