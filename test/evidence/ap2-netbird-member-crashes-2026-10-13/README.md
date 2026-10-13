# Individual NetBird Member crash evidence — 2026-10-13

The full run passed 1,000 jobs and a verified initial inventory of 10,000
Entries with three persistent Members and six Workers. Each Member was killed
before admission and after durable completion, before replying, for task write,
transaction begin, take, result write and transaction commit: 30 real SIGKILLs,
15 on each boundary. Six deaths interrupted task production; all 24 Worker
operation deaths occurred with six Workers active. Each Member started eleven
times on its original SQLite store. The Root started once and exited normally.

Each selected request was read back before killing: no admitted claim at the
before boundary, a completed claim at the after boundary. Reopen preserved
Space ID, incarnation, authority, primary epoch, membership and policy without
reseeding background Entries. The final prime reference and 1,000 unique
results passed, no Tasks remained, and 9,000 background Entries were retained.
The offline audit used private copies of read-only source stores and verified
all 5,000 original Child claims, all completed Parent/Child journals, and the
30 interrupted original requests with their targets, principals and hashes.
No active transaction or unused future reservation remained.

The first real outage smoke exposed transport loss during Child preparation.
The production client now leaves the admitted Parent pending when the typed
transport failure interrupts proof/generation before dispatch. Retry retains
the same Parent plan; existing journaled Children retain their request identity.
Permission, authority and unrelated errors are not converted into pending.
Two storage-backend tests reproduced the problem before the fix; all four
positive/negative recovery cases now pass locally and as a built server test.
All 436 routine tests, 24 Mobile tests and typecheck pass. Built libraries on
server and mobile have identical hashes. No new phone deployment is claimed.

A later 60-job smoke completed its workload and all 30 deaths but failed while
reading incorrectly permissioned report files; this harness issue was fixed
before the successful full run. Failed smokes remain separate evidence. A first full run failed when the
operator SSH observer hung and left a killed Member offline beyond the pending
retry deadline. The driver now bounds SSH calls and batches observation/restart
on the server; the successful full run uses a fresh fixture.
The expanded audit also passed against the completed ACK load fixture.
Owned containers, temporary group and policy were removed; existing production
services stayed active. This is process recovery at unchanged bindings on one
physical server, not promotion, power loss, independent boot/fencing or every
explicit Root journal commit boundary. Six test blocks and overall Phase-2
acceptance remain open.
