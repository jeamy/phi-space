# Local validation

As of: 2026-10-07. This report describes the checked local working state, no production acceptance.

| Check | Result |
|---|---|
| npm run typecheck | passed |
| npm test | core, integration, persistence, Spaces and claims tests passed (108) |
| npm run test:examples | 158 tests passed, no failures/skips; run with released subprocesses |
| sieve/cache regressions | 7 sieve and 8 cache tests; independent prime reference, concurrency, rollback, lease/TTL and JSONL reopen |
| targeted SIGKILL/JSONL test | reservation present after process loss, uncommitted result invisible; correctly searched again after recovery |
| npm run example | scripted job was written and taken |
| npm run example:pipeline | two windows/reports; missing source, duplicate and invalid value correctly visible |
| npm run example:chat | scripted ring 0–9 finished |
| npm run example:golomb -- 4 --workers 2 | self-found [0,1,4,6], length 6, validator without errors |
| npm run example:sieve -- 1001 4 | 168 primes in [1,1001) |
| npm run example:cache | version-bound replacement by Bob, subsequent deletion and miss |
| local document file references | no missing target paths |
| git diff --check | without whitespace errors |

## Addendum AP 1.1–1.9 (2026-10-09)

Current evidence: [ap1-abnahme.md](abnahme/ap1-abnahme.en.md). Typecheck and TypeScript build passed;
184 core/integration/TUI/AP/pi-server tests and 158 example tests passed without skips.
Real pi-serverd checked with a freshly built bundle, temporary SQLite database and Unix socket;
sessions still usable, Space RPC refused without explicit configuration. Remote sieve in a named
Space after host SIGKILL/reopen: 10 results, 168 independently checked primes, no leftover txns.
The measurements of 2026-10-07 below are historical individual findings; they were not repeated as a
performance acceptance of the new working state.

## pi-durable feasibility (AP 0.3)

Measurement on 2026-10-07 with `node --experimental-strip-types scripts/spike-durable.ts <N>` on the
development machine (Node 22, local SSD). Single runs, no statistics; guide values, no acceptance per gate 4.

**Semantics:**
- A commit over a family document and a singleton is atomic; an error rolls both back.
- A family token with the same `kind` as a persisted singleton returns, **without an error**, a different,
  empty document. The singleton therefore must not simply be carried on as a family.
- Copying into a new `kind` plus `retireDoc` in the same commit works and survives reopen.

**Costs of a Space document** (entries with about 230 bytes of fields; filling in commits of 500 writes):

| Entries | Backend | Filling | 1 write | Take, first match | Take, last match | Storage | Reopen + snapshot |
|---:|---|---:|---:|---:|---:|---:|---:|
| 1000 before correction | JSONL | 20 s | 48 ms | 48 ms | 86 ms | 231 MB | 3.5 s |
| 1000 | JSONL | 0.7 s | 3.3 ms | 2.6 ms | 10 ms | 0.7 MB | 35 ms |
| 1000 | SQLite | 0.6 s | 5.8 ms | 2.6 ms | 10 ms | 0.7 MB | 13 ms |
| 4000 | JSONL | 9.9 s | 8.9 ms | 6.3 ms | 31 ms | 1.8 MB | 56 ms |
| 4000 | SQLite | 10.3 s | 8.5 ms | 7.0 ms | 30 ms | 1.8 MB | 22 ms |
| 10 000 | JSONL | 68 s | 19.8 ms | 12.3 ms | 81 ms | 3.9 MB | 98 ms |
| 10 000 | SQLite | 66 s | 17.6 ms | 12.3 ms | 78 ms | 4.0 MB | 40 ms |

The correction: `settle()` and the txn end replaced whole arrays in the document draft on every commit; pi-durable
thereby stored the complete Space each time. Now only what actually expires is removed.

**Conclusion:** The costs grow linearly with the entry count. At 10 000 entries (the load test target from v3 §12)
a single write costs just under 20 ms and a take with a late match about 80 ms. The drivers are the
total byte sum in `write`, the scan in `settle` and the linear template search over draft proxies. Countermeasures
(running byte limits are implemented by now; expiry index and type index remain optimization options) belong
before the load tests of gate 4.

## Automatic mobile bundle update

In the sibling project pi-termux-mobile the Android debug build with the new preBuild step was
run successfully. Checked were the match of the library bundle in source output, mobile runtime and
APK as well as the contained sieve/cache modules and the checksum of runtime.bin/rootfs.bin.
An unchanged repeated preparation produces the same checksum and keeps the asset timestamps.
The bundled sieve/cache CLI programs run locally; four remote provisioning regressions pass,
including a hash change with changed, added and removed example modules.

This evidences build, packaging and local execution. Installation/re-extraction on a real phone and
transfer to a remote host were not performed in this; the existing update releases stay in place.

The actual research runners were run with faux models, local data and JSONL; real models
and arXiv network requests were not part of this acceptance. Reference values and data contract were compared against
[OEIS A003022](https://oeis.org/A003022) and the
[arXiv API documentation](https://info.arxiv.org/help/api/user-manual.html).

No measured performance/scaling, coverage, multi-host or scientific quality acceptance.
Details: [example contracts](../examples.en.md), [tests](../../test/examples/README.en.md).
