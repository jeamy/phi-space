# NetBird ACK crash evidence — 2026-10-13

The corrected full fixture passed 1,000 jobs and a verified initial inventory
of 10,000 Entries, with six Workers active at each of six real Root SIGKILLs.
Three Members × before/after ACK were tested using separate waiting-take races.
Every fault marker contains a candidate read back from its already committed
Parent journal before ACK. Seven Root starts kept the same lease ID and epoch.
All six winners replay identically; twelve losing Entries remain available.
The job result/prime comparison passed, no job Tasks remain, and 9,000
background Entries were retained. Eighteen additional probe Entries were
seeded; six were consumed and twelve returned. They are separate from the
initial workload count.

The closed-store audit checks 5,024 Parents, 5,072 Children and their original
Member claims, plus all six ACK boundaries. Before-send ACK identities have no
admitted claim; after-reply identities retain completed claims. ACK replay may
use a fresh request identity, but must preserve the original mailbox epoch,
delivered prefix, principal, Member and durable candidate. The mailbox cursor
advanced without a gap or an extra winner. No transaction or unused future
reservation remained. Original stores were mounted read-only and only copies
were opened.

The first full run failed during a concurrent snapshot after its first ACK
restart. Deterministic TCP tests reproduced overlapping challenge/prove flows
from separate RemoteSpace instances sharing a transport. The production fix
orders complete proof flows per transport, including queue release on failure;
it does not cache successful proofs or weaken host/peer/key validation.
The pre-fix TCP regression had three failures and one passing independence
case. All ten auth tests, 432 routine tests, ten built server auth tests and
24 mobile tests now pass. Source and mobile built libraries have the same hash.
The full run was repeated after the fix. Failed-run evidence remains separate.

The 12-job smoke confirms six ACK deaths but does not keep six job Workers
active through all probes. Only the full run proves the concurrent workload.
The expanded audit also passed on the previous 30-RPC-crash fixture.
Cleanup removed owned fixture containers/group/policy; existing services
remained active. Individual Member loss, all explicit journal boundaries,
production provisioning/fencing, independent physical hosts and remaining
administrative/profile gates are still open. Phase 2 is not fully accepted.
