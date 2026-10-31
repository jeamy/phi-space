# Golomb Ruler: Local Combinatorial Search

As of 2026-10-07. Implementation: [golomb.ts](../../examples/golomb.ts).
One process with several asynchronous worker loops and a Space in the SQLite store (`<dir>/space.sqlite`). No federation and no
parallelization across several CPU cores.

## Mathematical Contract

A normalized ruler has integer marks 0 = a1 < a2 < ... < an; all n(n−1)/2 positive
pairwise differences must be distinct. Its length is the last mark.
Empty/single-mark lists are accepted by the general helper validator as trivial cases; search results
are additionally checked for the requested number of marks and for agreement of length and marks.

Correct optimal lengths, source: [OEIS A003022](https://oeis.org/A003022):

| Order | Length | Order | Length |
|---|---:|---|---:|
| 2 | 1 | 7 | 25 |
| 3 | 3 | 8 | 34 |
| 4 | 6 | 9 | 44 |
| 5 | 11 | 10 | 55 |
| 6 | 17 | 11 | 72 |
| 12 | 85 | 13 | 106 |

The example [0,1,4,9,11] measures ten distances: 1,2,3,4,5,7,8,9,10,11; the distance 6 is missing.
From the number of distinct distances follows L ≥ n(n−1)/2. This counting lower bound is
neither a general upper bound nor a proof of an asymptotically optimal length n²/2.

The CLI uses a known optimal **length as an inclusive search bound** and for early exit.
Reference positions are not fed in as a search result. Summary.bestPositions comes exclusively
from found results, otherwise null. With an explicitly smaller bound, "no ruler found"
is a permissible result. No enumeration of all optimal rulers: strictly improving candidates
are collected; early exit can omit other optimal solutions and still-open tasks.

## Search and States

The master creates an immutable GolombRun configuration. The default runId contains order and
maximum length. Changes to the partitioning parameters for the same runId are rejected.
GolombSearchTask carries runId, taskId, order, bound and a range for the second mark a2.
Mirror symmetry permits restricting first distance ≤ last distance.
The DFS discards repeated distances with a BitSet and candidates that do not improve the best length.

Workers take only tasks of their run under a txn. The lease is 120 s and is renewed as needed during cooperative
DFS interruptions. The search regularly yields the event loop; this permits timers
and concurrent host work, but produces no CPU speedup through several workers.
Results and GolombTaskDone are written under the same txn and committed together.
Errors lead to abort; a process abort leaves the reservation in place until the lease expires.

The master counts only completions of the matching runId. The CLI's monitor/validator are
tied to the current run. completedNodes sums only already committed completed tasks, not running DFS work.
The validator runs after the worker loops and checks the rulers actually produced.
An early optimal find ends the search; remaining tasks can stay in the state and are not reprocessed when
a completion marker exists.

## Restart and Checkpoints

The CLI may own the store alone. When the same directory is opened, abandoned txns are aborted
before the tasks are enumerated; afterwards the master skips tasks already committed as completed.
A general library caller must likewise resolve old active reservations before a master restart
and must not start two masters for the same run.

Partial progress within a DFS is **recomputed** after a crash. Old nextA2 files are
ignored: they contain no atomic evidence of solutions already secured.
`--checkpoint <prefix>` creates separate JSON completion receipts per run and task after the commit, via a
temporary file plus rename. The Space is the authoritative source; these receipts permit no partial
DFS resume. A file error after the commit loses no Space result, but can end the CLI run with an error.

A CLI restart with a changed workers value can change the task configuration and is then rejected.
Other bounds have a different runId. Old, unmarked entries are not counted as new run results.

## Invocation and Limits

```bash
npm run example:golomb -- 4 --workers 2
node --experimental-strip-types examples/golomb.ts 4 --workers 2 --dir /tmp/golomb-state
node --experimental-strip-types examples/golomb.ts 4 --workers 2 --dir /tmp/golomb-state
```

Order 2–25, workers 1–64, positive integer length. High orders are no runtime promise.
The search grows steeply; no production benchmarks exist. Snapshot lists are limited to 1000 entries;
a general pagination is missing for long runs. BitSet clones and recursive search limit performance.

[recovery.test.ts](../../test/examples/recovery.test.ts) runs an actual order-4 search,
validates the result, reopens the SQLite store and checks task rollback, old checkpoints and changed configuration.
The older golomb.test.ts mostly checks helper functions and manually created entries; its test names alone
are no search evidence. No multi-process/GPU/federation or scaling acceptance.
[Back to the overview](README.en.md).
