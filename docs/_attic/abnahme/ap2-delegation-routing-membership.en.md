# AP 2.2–2.5: Delegation, Routing and Membership

As of 2026-10-11. The server-side building blocks are implemented and checked on JSONL
and SQLite, including real TCP connections with key proof.
The complete phase 2 acceptance with a three-member sieve and load test remains separate.

## Usage

`createFederationController` connects policy, router journal, `FederatedSpace`,
the productive `FederationRpc` and `MembershipController`. Before journal accesses the composition
checks both the external boot/control authorization and
the signed, still current RouterLease. It also checks open references
in the atomic control commit of a removal. A journal has one owner;
concurrent calls of the same `FederatedSpace` are serialized.

The operator provides the actual member transports and key pins,
the control signer, the separate router app key and a provider for
**grants of the original principal**. A grant of the router peer
does not replace a user grant. `renewableRouterLease(controlRemote)` renews
after 20 seconds; after a process restart a new epoch is requested.

This is a server-side API with explicit request IDs and principals.
The existing `RemoteSpace` remains the client of a physical member Space.
A new public virtual Space endpoint or a TUI for the new
admin commands is not introduced with this package.

## 2.2: RouterLease and Delegation

`routerLease` at the control gate requires a proven active router key
and a current control grant. The supervisor signature is produced only after the
durable lease commit. Renewal keeps the epoch; takeover raises it.
`routingPolicy` delivers the signed policy only to proven service peers.

Delegation binds original principal, active original app key, Space ID,
method, functional hash, generation, request ID, policy and target epoch.
Supervisor and router sign separately. Only the renewable frame changes
on repetitions. Follow-up actions name their original claim;
waiter transactions keep the origin reference even after mailbox ACK.

Highest epochs are stored persistently in the member. Alias and stable
Space ID meet the same protection. Epoch notices block old pending effects.
Delegated mailbox polls extend only the referenced waiter.
Quotas count original principal and physical router peer. A proven
host may use only `agentId`s under its own peer ID;
roles and scope are not widened by this.

## 2.3: FederationPolicy

The policy and the control counter `policyVersion` change atomically. Rules name
registered members; default, existing type placements and HRW sets are
immutable. Capacity/capability search sets may be extended and shrunk only after
proven removal. Stale capacity data and missing
capabilities lead to errors; a chosen write is not re-placed.

HRW uses canonical field values and stable member IDs. Known keys
narrow search targets; wildcards and declared supertypes widen them.
`supertypes` form an immutable, acyclic type catalog. The router
completes it on write; managed members also check it locally.

The schema check knows later primary/merge variants and their
incompatibilities. Their activation is blocked until phase 3. Changes to
existing completion profiles need the controlled transition from AP 2.6.

## 2.4: FederatedSpace

Before the first effect, principal, policy, complete target set,
arguments, absolute waiting deadline and future sub-request budgets are in the
journal. Targets, generations and request IDs are preserved on repetition.

- `write(entry, request, leaseMs?)` binds exactly one placement.
- `read(template, request)` and `take(template, request)` search without waiting.
  A take moves to the next member only after a confirmed miss. An unclear
  outcome yields `FederationPending` and remains resolvable via `resume(id)`.
  A read may deliver a reachable hit; a global miss requires
  the results of all search targets.
- `readAll` and `count` require all members by default. `allowPartial`
  delivers `complete`, `missingMembers` and revisions per member.
  `waitForCompleteMs` repeats the complete query for at most 60 seconds.
  The revisions do not claim a globally consistent snapshot.
- `createTransaction(member, leaseMs, request)` delivers member and `originId`
  in addition to the lease. Follow-up operations use this binding under the same
  principal. `finishTransaction(originId, action, request)` journals commit
  or abort. A different route or a foreign principal yields `RoutingConflict`.
- `readWaiting(template, timeoutMs, request)` serves waiting reads without
  reservation or consumption of the delivered entry.
- `takeWaiting(template, timeoutMs, txnLeaseMs, request)` registers bounded
  waiters and journals events before ACK. The first still active reservation
  becomes the winner durably. Its commit and the loser aborts have their own
  stable IDs. Late losers are collected again after cancellation.
  A lost winner response triggers no second winner selection.
  With a user transaction only the bound member is served; its commit
  stays with the user.

Events of other federation operations of the same principal are passed on into
their own journal before the ACK. Unknown foreign mailbox events
block the ACK and require the responsible dispatcher.

The productive RPC path evaluates durable claims. With missing or
expired history it conservatively returns `needsReview`; it does not invent a
`notAdmitted` proof. The simulator can deliver this proof from the real
member document and a still valid generation.

## 2.5: Membership

`MemberLifecycle` accepts only signed instructions of the pinned
control supervisor. In the provisioned start it is activated with
`membership: {memberId, spaceId}`. After managed admission the member
installs current signed policies before normal RPC effects. Direct local
workers use the same core locks.

`MembershipController.execute(commandId, kind, member, newDefault?)` handles
`add`, `drain` and `remove` outside control commits. The supervisor connects
these operations with `addMember`, `drain` and `removeMember` when the
root composition is inserted in `control.membership`. Its own journal
keeps unclear remote outcomes and repeats them after a restart.

Admission locks local admission **before** the inventory check. All physical
entries count; invisible transactions and pending work prevent
admission. Unknown inventory types receive fixed rules for this member.
A wrong inventory is released with a signed rejection before the policy commit.
After an unclear or already completed control commit there is no
local release. Repetition uses the same transition identity.

Drain sets a durable admission boundary. New independent writes and new
tasks are blocked. Transactions opened before the boundary get a
bounded completion window. Profiled tasks taken afterwards may write only their
bound results with matching fields, count, byte and lease limits.
Unbounded lease extension is blocked.

Removal requires zero inventory including invisible entries, transactions,
waiters, fanout jobs and pending claims. Notify registrations are closed with
`registrationClosed(reason: "removing")`. Only then the
signed `EmptyProof` with Space, authority, transition ID, admission version and
revision is created. Root re-checks open sub-requests, federation operations, transactions
and further control references in the removal commit. Policy and membership
change together; a remaining default is mandatory. HRW/type sets
are rejected with `MigrationRequired`. Mailbox ACKs and retained results
remain reachable via the old Space ID.

## Limits and Evidence

The budgets are conservative provisional values: at most eight targets and
16 retained logical federation operations; per operation 128 KiB reserved
metadata/results. The router journal reserves future children before effect
and does not discard historical IDs. Final load values follow in AP 2.9.

The automatic tests cover signature forgery, revocation, epoch change,
policy change, lost responses, real TCP gates, JSONL/SQLite restart,
sequential takes, partial queries, concurrent reservations, txn binding,
drain, wrong inventory, notify closing events and atomic reference races.
The final counts and build evidence are in
[checks.json](../../../test/evidence/ap2-2026-10-11/checks.json).

Still open are AP 2.6 (further admin commands and controlled profile changes),
2.7 (automatic capability/MemberStatus directory), 2.9 (load acceptance) and
the complete phase 2 system acceptance. RunGate and replication follow later.

The final check comprises 345 total tests, 158 example tests, four mobile tests
and [65 compiled tests on big](../../../test/evidence/ap2-2026-10-11/server-built-phase2.json).
The isolated container uses controlled management directories and
real loopback TCP; this is not a complete phase 2 overlay acceptance.
The normal Android APK is built offline. Its final update on the
phone is pending, as Wi-Fi ADB and the NetBird peer are currently unreachable.
