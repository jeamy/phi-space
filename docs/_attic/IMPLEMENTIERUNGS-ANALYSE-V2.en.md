# Implementation Analysis: Corrected State

As of 2026-10-07. The file name is kept for existing references.
The earlier collection of inconsistent code copies and performance figures is replaced by the
[authoritative example overview](../examples.en.md) and the individual current documents.

| Finding | Correction | Remaining limit |
|---|---|---|
| Golomb task without txn | task, results and completion under txn; abort on error | recovery after a process abort needs lease expiry or a CLI restart |
| nextA2 without secured solutions | no partial cursors; completion receipts only after commit | search work of an open task is repeated |
| mixed search runs | runId, immutable configuration, filtered completions | one master/storage process; no federation |
| CPU speedup through several async workers claimed | cooperative DFS and corrected description | real CPU parallelism not implemented |
| invalid first sensor duplicate | validate before collision-free deduplication | with a valid conflict the first value wins |
| destructive summary presentation | take/report under a shared txn | external exports separate |
| truncated sensor window | reject more than 1000 readings | no general pagination |
| research outputs without txn | result tools check reserved task/owner/txn | model contents still need review |
| old research markers as new success | only fresh empty directories | automatic research resume missing |
| invented bibliometrics | citation metrics unknown; guards; complete authors/date/abstract | no additional citation data source |
| tests mirror their own workflow | regressions call actual runners/functions | older script suite remains an additional semantics test |
| sieve and cache without code | segmented sieve and atomic cache; own function/recovery tests | local harness; no replication or CPU parallelism |
| inconsistent specs/links | documents consolidated, local references checked | real model/multi-host acceptance still open |

The corrections are checked by typecheck, core and example suites.
[recovery.test.ts](../../test/examples/recovery.test.ts) contains targeted failure cases.
No claim that every hypothetical failure sequence or every scientific statement has been checked.
[Back to the overview](../examples/README.en.md).
