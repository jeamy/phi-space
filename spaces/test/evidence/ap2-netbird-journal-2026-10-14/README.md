# NetBird journal commit crash evidence — 2026-10-14

Five fresh full runs each verified 10,000 initial Entries and 1,000 jobs.
Thirteen successful-path journal transitions were interrupted immediately
before and after actual atomic Storage.commit: 26 confirmed Root SIGKILLs,
with six job Workers active at every selected boundary. Classification uses
exact document families, owned Parent/Child identities and materialized
before/after state, including first document creation. After-commit markers
read back the actual persisted state and commit sequence before SIGKILL.

Transitions: Parent admission, future reservation, Child acceptance, Parent
Child binding, Parent ready, Child inflight, Child completion, registration,
candidate persistence, winner persistence, Parent completion, future release
and read cursor advance. Waiting-take probes retain one winner and two returned
losers; cursor probes replay a miss. Additional probe Entries are separate
from the verified initial inventory. Each offline audit opens private copies
of closed, read-only mounted stores and checks every retained original Child
claim, stable Parent plans and all selected journal transitions. A Child killed
before durable acceptance never dispatched its abandoned original request;
its generation may change during admission. Accepted Child identities remain
unchanged. No active transaction or future reservation remains.

The first small all-boundary run detected that first Parent/Child creation is
a base document commit rather than a delta. It exercised 22 boundaries and
correctly failed its expected count. The hook was corrected; a separate small
base-creation run and audit passed the four missing boundaries. Full acceptance
uses the five corrected full runs only. Error/review, restore, profile-change
and deletion journals retain their separate acceptance gates. Network namespaces
are still on one server. Production provisioning and independent host domains
are not claimed by this proof. Phase 2 remains open.
