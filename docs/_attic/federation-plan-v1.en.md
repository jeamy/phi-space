> **Replaced by [federation-plan-v3.md](../federation-plan-v3.en.md).** Kept only as history; do not implement from it.

# Federated Spaces v1: analysis and plan

Goal: Every reachable host (pi-serverd) provides a Space to agents. Several Spaces can be connected
and controlled and observed from arbitrary clients (phone, desktop, CLI, browser). Two federation modes: **expand**
(distribute, similar to RAID 0) and **sync** (mirror, similar to RAID 1). The control is itself a Space (**control
space**), the router a worker in it. The network is a self-hosted **NetBird** overlay (WireGuard).

The basis is the existing implementation, see [spaces-v1.en.md](spaces-v1.en.md); its gaps L1–L3, L7 and B1 are
prerequisites here.

Revised after a consistency check on 2026-10-06. This document describes the target contract, not guarantees
that are already implemented or tested. The acceptance criteria in sections 11 and 12 are still to be met.

## 1. Assessment of the original draft

The draft (four layers, mode per type, primary/replica, directory, star first) is correct at its core.
The following points were incomplete or not implementable as stated; the right column names the solution in this plan:

| Statement in the draft | Assessment → solution |
|---|---|
| "Identity comes from the connection (host:phone)" | Via `ssh -L`, pi-serverd sees only a local Unix socket of the same user; pi-server does not authenticate peers. → NetBird peer identity plus signed challenge in the app (section 4). |
| "requestId like the claim per tool call" | The claim is a task document and exists only within a tool task. → own session store `(peer, requestId) → result` with expiry (6.2). |
| "A blocking take puts a waiter on all members" | Correct, but waiters today deliver only to local conversations; string targets are discarded (L1). → peer mailbox with long poll and receipt (6.1). |
| "Replicas get a numbered change stream" | There is no revision and no stream (L2). → `rev` + delta ring in the core (6.1). |
| "Last-writer-wins for location/weather" | Tuple spaces have no keys. → declared key fields per mirrored type (6.1). |
| "The newer asOf wins" | Clocks of different hosts drift. → leases with bounded time uncertainty; HLC orders versions, guarantees no business-wise newest measurement (7.2). |
| "Limit transactions to one member" | Correct; IDs must carry the member (L3). → global IDs `spaceId/localId`; host, Space and replica identity separate (section 2). |
| "Directory with capability entries" | Correct (Jini lookup service); needs write-protected types. |
| Router on the phone, star via the phone | The phone sleeps or is terminated (MIUI, phantom process killer). → router as a worker in the control space on a host; clients only control (section 5). |
| Connections via SSH, key per host pair | Works, but TOFU, key distribution and NAT are manual work. → NetBird takes over key exchange, encryption, NAT traversal and network ACLs (section 4). SSH CA remains as an alternative (appendix A). |

Added compared to the draft: owner across hosts, quotas per peer, loop avoidance when mirroring,
protocol versioning, backpressure, simulator tests with partitions, migration of the document (version 4 → 5).

## 2. Terms

- **Host**: pi-serverd with a stable, untruncated `hostId`; can hold several Spaces.
- **Space**: logical stock with an immutable `spaceId`. Names are changeable aliases.
- **Member**: a logical data Space in a federation; `memberId = spaceId`. In expand mode solely
  responsible for its entries, txns, waiters and outbox. In primary mode it can own physical replicas.
- **Replica**: physical copy with its own `replicaId`; on promotion takes over the same logical `spaceId`.
- **Control space**: protected control data; primary with an optional, later mandatory synchronous standby.
- **Router**: worker on the coordinator; runs `FederatedSpace`, replicators and commands.
- **Supervisor**: local service per host, independent of the router; handles enrollment and local recovery requests.
- **Recovery space**: local, non-replicated Space per host for authorized recovery requests and results.
- **Client**: phone, desktop, CLI or browser via gateway.
- **Peer**: authenticated counterpart with an immutable `peerId`; display names are not an identity.
- **Owner**: structured principal `{peerId, agentId?}`; representation as a string is only an output format.
- **Federation**: named set of members plus versioned policy.
- **Global ID**: `<spaceId>/<localId>`. Local IDs are not reused even after a restore, for example by
  incarnation ID plus counter; after a restore a new incarnation is assigned before new writes.
  Replication preserves existing logical entry IDs. Restore is not a regular lossless promotion.
- **Mailbox**: durable events for a principal and consumer, identified by `mailboxId`, `epoch`, `seq`.
- **Overlay**: NetBird network; IPs serve as endpoints, not as permanent identities.

### 2.1 Binding guarantees and limits

| Level | Contract |
|---|---|
| Local commit | Space mutation and RPC result are written durably and atomically. |
| Retry | The same valid request returns the same result without a new mutation; bounded window (6.2). |
| Take under txn | At most one active reservation per entry; abort/expiry allows a new reservation. |
| Successful take | At most one successful destructive commit per entry identity in expand/primary. |
| Business effect | No general exactly-once guarantee for external effects; the target system needs idempotency or a shared transaction. |
| primary with synchronous standby | Confirmed operations are preserved on a permitted promotion (7.2). |
| Asynchronous copy | Backup/read copy; confirmed writes or takes can be missing on loss of the primary. No safe automatic promotion. |
| lww/set | Eventual convergence after complete exchange under the rules from 7.2; no exclusive work assignment. |

Network errors can leave an unknown result. A client asks again with the same request ID and
starts no new mutation when in doubt. Permanently lost storage is data loss in expand mode.

## 3. Target architecture

```
   Handy        Desktop/CLI      Browser
     │              │               │ (WebSocket/TLS)
     │              │          ┌────▼─────┐
     │              │          │ Gateway  │  (auf einem Host)
     │              │          └────┬─────┘
 ════╪══════════════╪═══════════════╪═══════════ NetBird-Overlay (WireGuard, ACL-Gruppen) ═══
     │              │               │
     ▼              ▼               ▼
 ┌──────────────────────────────────────────┐      ┌───────────────────┐
 │ Koordinator-Host                         │      │ Host B            │
 │  space-gate (TCP, nur Overlay-IP)        │      │  space-gate       │
 │  pi-serverd                              │◄────►│  pi-serverd       │
 │   ├ Control Space (primary)              │      │   ├ Control-Replik│
 │   ├ Router-Worker (FederatedSpace,       │      │   ├ Data Space B  │
 │   │   Replikatoren, Kommandos)           │      │   └ Agenten       │
 │   ├ Data Space A                         │      └───────────────────┘
 │   └ Agenten                              │               ▲
 └──────────────────────────────────────────┘               │ … weitere Hosts
                    ▲
          NetBird Management/Signal/Relay (selbst gehostet, öffentliche VM)
```

- Agents use the tools as today. With the parameter `space` (member or federation name), operations go
  through `RemoteSpace` or `FederatedSpace`.
- Clients hold no central operating state. Host workers keep running without a connected dashboard.
  Clients must keep their own request IDs until completion; externally started work needs its own recovery.
- Every host additionally runs the supervisor and a local recovery space. Router journal and RPC claims
  live in internal durable documents; agent payload data is not stored as control entries.

## 4. Network and trust

### 4.1 NetBird as the network layer

A self-hosted deployment on a Linux VM with a domain and Docker Compose is planned. Concrete
resources, ports and user management are verified for the selected version before stage 1b (4.5).

| Task | Who does it |
|---|---|
| Key pairs, exchange of public keys, rotation | NetBird (every peer generates its WireGuard key; management distributes only public keys) |
| Encryption | WireGuard |
| Reachability behind NAT/mobile network | NetBird (ICE/STUN direct, otherwise relay) |
| Joining servers/hosts | Setup key (unattended, during provisioning) |
| Joining phone/desktop | Login via NetBird (local users or SSO) |
| Network ACLs | NetBird policies via groups |
| Rights in the Space | **phi-spaces** (4.3), not NetBird |

Groups and policies (proposal):

| Group | Members | may reach |
|---|---|---|
| `space-hosts` | all hosts | `space-hosts` on the Space port (host to host) |
| `space-admin` | phone, admin desktop | `space-hosts` on the Space port + SSH |
| `space-observer` | dashboards | coordinator on the Space port |

On the phone the NetBird app runs as a system VPN; the embedded Node runtime reaches overlay IPs without its own
installation. Restriction: Android allows only one active VPN.

### 4.2 `space-gate`: entry point per host

- TCP only on the overlay IP; the internal Unix socket stays `0600`.
- The gate authenticates the connection and passes a context that the client cannot overwrite to
  pi-serverd. The server accepts this context exactly once at connection setup. The public `hello`
  negotiates only protocol features; it cannot set an identity or role.
- The integration needs an explicit authentication boundary in pi-serverd. Merely prepending a frame
  with subsequent unchecked pass-through is not sufficient. Frame size, handshake time and connections are limited.
- On this entry only `serviceId: space` is allowed. `sessions`/`chat` stay blocked until their own
  authorization rules are implemented and tested.
- Local processes of the same user stay inside the trust boundary (direct storage access).
- `pi-client` receives a TCP transport factory. Compatibility of the existing byte/CBOR transport is checked before
  implementation; browsers use the gateway from section 10.

### 4.3 Identity, delegation and revocation

| Layer | Contract |
|---|---|
| A: overlay | Source IP is mapped via management to an immutable peer ID and groups; cache at most 60 s. |
| B: app | Ed25519 challenge with a fresh one-time nonce, short validity and binding to gate ID, protocol and connection. |

Layer B is mandatory for control space, admin, router, gateway, replication and delegating hosts. Direct
data-space clients may work with A alone only if an explicit peer/group rule assigns `member` or `observer`.
Without a rule, no access. Group and app rights are intersected, never united.

User roles are `admin`, `member`, `observer`; service roles `host`, `router`, `replicator`, `supervisor`
are assigned explicitly with allowed Spaces and operations. A host is thereby not an admin.

A registered host may vouch for local agents only within its own principal namespace.
The router may pass this identity on with a signed, short-lived delegation proof: issuer,
original principal, target Space, allowed operation, request ID and expiry are bound. The member checks
issuer and scope. Gateway users remain separate principals. Quotas count the delegated principal and
the transport peer; freely passed `owner` fields are ignored on normal writes.

Authorization is checked on every request and before the deciding commit. Grants are valid for at most 60 s;
invalidations close sessions and end open polls earlier. Without a timely renewed, authoritative
grant, new and not yet decided operations are rejected. Replicas must not issue fresh grants from
arbitrarily old state. Work already confirmed is not undone by revocation.

Thus **revocation within the grant lifetime plus a defined time uncertainty** applies, not immediately under every
partition. Recovery needs a separately locally provisioned admin key (5.2), whose revocation must be confirmed
separately on every recovery host. Key storage and Ed25519 support of the Android keystore
are to be checked in practice before stage 1b; desktop key files receive `0600`.

### 4.4 Pairing a new client

1. The device joins the overlay; an admin assigns the permitted group.
2. Admin creates `Enroll` with token hash, role, allowed peer ID and expiry after 5 min. The QR contains endpoint,
   control space ID and a random token with at least 128 bits of entropy. The plain-text token is not logged.
3. Unpaired peers may exclusively write `EnrollRequest` and read their own enrollment result.
   They may neither list tokens nor read, subscribe to or take control data. This exception is part
   of the authorization, not a general control access.
4. The supervisor, already running in stage 1b, checks token, peer binding and possession of the new key by
   challenge. Token consumption and creation of `PeerKey` happen atomically at the control primary; retry is deduplicated.
5. Manual entry uses the same strong token. A genuinely short code additionally requires a
   separate procedure with an attempt limit and admin confirmation; that is not part of v1 pairing.

Bootstrap: The first host creates the control space and, once, a bootstrap token. The local supervisor
handles it even without a router. Provisioning of further hosts uses bound one-time tokens and assigns
only the service role `host`. New hosts become routing targets only after `addMember`.

### 4.5 Failure and operation of NetBird

Management, signal and relay failures are tested separately before stage 1b: existing direct/relayed
connections, reconnection, peer resolution and revocation. Local storage is preserved, but the availability of
remotely executed operations depends on transport and valid auth grants. After the cache expires,
requests are rejected fail-closed without authoritative renewal; local maintenance and lease expiry continue.

Version, port requirements, user management, license of the components actually used and upgrade/backup path
are checked against the official documentation before deployment. The statements in 4.1 are planning assumptions.

## 5. Control space and router

Normal control uses protected entries. The local recovery space is a separate control path that is reachable
before router start and stays writable even if the control primary has failed.

| Type | Written by | Content / effect |
|---|---|---|
| `Member` | Router after admin command | Identities, endpoints, admission state and fixed routing assignment |
| `FederationPolicy` | Router after admin command | validated policy with `policyVersion` |
| `PeerKey` | Supervisor after enrollment/admin change | Principal, key, roles and scope |
| `Enroll` / `EnrollRequest` | admin / restricted new peer | Pairing according to 4.4 |
| `Command` | admin | `{id, op: setLimits / drain / addMember / removeMember / setPolicy, args}` |
| `Result` | Router | `{commandId, state, error?}` |
| `MemberStatus` | Router | Reachability, revision, lag, free capacity; lease 30 s |
| `Capability` | authenticated host for itself | Tools, models, resources; lease 2 min |
| `RecoveryRequest` / `RecoveryResult` | recovery admin / supervisor | local recovery space only; promotion according to 5.2 |

### 5.1 Commands and durable router state

Command processing is a durable state machine: `accepted → applying → completed/failed`.
Before every remote effect, target, argument hash and a stable sub-request ID are stored. The target
stores effect and deduplication atomically; after a crash the same sub-request is queried/repeated.
A local `Result` alone does not close the window between the remote effect and the result commit.
Operations without an idempotent target protocol are, as such, not permitted commands.

After a restart the router first recovers open commands and requests, then starts new work. Before recovery
is complete its status is `recovering`. Journal and deduplication are subject to the same protection and, for HA,
the same synchronous replication as the control space. The internal journal can contain bounded result data;
its bytes are budgeted separately. Mailbox ACKs happen only after the event has been durably taken over.

### 5.2 Manual, secured promotion in v1

There is **no automatic election on a mere timeout**. For each logical primary Space a concrete standby
is fixed. The supervisor runs on both hosts independently of the router.

1. The recovery admin writes a signed request into the recovery space of the fixed standby, with
   expected epoch, target and a unique recovery ID. A locally provisioned key makes this possible
   independently of the failed control space.
2. The previous primary including the router is verifiably stopped and locked against automatic restart,
   for example by a controlled infrastructure fencing mechanism. A network timeout or a
   mere admin claim is not sufficient. Without verifiable evidence the supervisor refuses the promotion.
3. Only the fixed synchronous standby may take over regularly. It checks its persistent history and the
   replication contract from 7.2. Missing or damaged history leads to an abort.
4. The supervisor raises the epoch atomically, activates the Space and, if needed, starts the router in recovery.
   Mutating requests including txn/lease/command carry the epoch; known old epochs are rejected.
5. The old host may start as a replica only after rejoin and complete synchronization. A process restart
   must not restore its old primary entitlement.

Safe shutdown protects during a partition; the epoch protects against old requests after reconnection.
Simultaneous promotions are prevented by exactly one permitted standby and a local atomic check.
A change of standby needs a planned stop of writes and a synchronized handover.
To regain fault tolerance, a new synchronous standby must first be set up after promotion.
Explicit single-host operation can then be activated separately, but has no HA guarantee.

The concrete fencing adapter is a mandatory decision before stage 3. Without it the replica stays a read copy.
Quorum-based automatic HA is a later design and is not replaced by a mere epoch.

## 6. Building blocks

### 6.1 Core extensions (phi-spaces, doc version 5)

1. **Revision**: every durable state change raises `rev` once per commit. A batch contains all deltas
   of this commit atomically; cursors stand only between batches. The stream ID contains Space, history incarnation and,
   for primary, the epoch. Revisions of different streams are not comparable.
2. **Two replication purposes**: the authorized entry stream contains put/delete, lease changes and their
   conflict metadata. Primary replication additionally needs txns, locks, waiters, mailbox, RPC claims and
   internal router documents in one atomic commit history. A stream of visible entries only is not sufficient for this.
   Application on replicas triggers no second local business operation or event generation.
3. **Snapshot**: `readAll` creates an immutable snapshot with token, stream ID and revision R. All
   pages belong to R. After that, `changes` begins strictly after R. Snapshot and required follow-up batches are
   retained for a bounded time; on expiry/gap the client must start over. Replication snapshots comprise the
   complete state belonging to the mode, including tombstones and deduplication. Installation is atomic.
4. **Identities**: `hostId`, `spaceId`, `replicaId`, history incarnation; `view()` returns `gid`.
5. **Peer targets**: structured principals and consumer mailboxes alongside local conversations. Events stay
   durable until ACK/TTL. An expired take txn is released; an event delivered later grants no
   new reservation. Recipients check the txn state before processing.
6. **Rights**: central check for every operation and every affected type including supertypes,
   lease manipulation, take, snapshot and stream (section 9). Host access is not quota-free at the remote entry.
7. **Keys**: mandatory per lww type, canonical encoding of `type + keyFields`; missing fields are
   rejected. Upsert only with explicitly declared semantics. Upsert conflicts with active txns are rejected.
8. **Preconditions**: ID templates (B1), total bytes (L7), cursor (L13), meter per Space (L11).

### 6.2 Service `space` in pi-serverd

Every call names the stable Space ID; alias resolution happens before request creation. JSON arguments are
validated. Mutations carry `requestId`, request generation and, for primary, the epoch. Relative operation times
are translated once into a server-side deadline at the first accepted call.

| Method | Essential arguments | Reply |
|---|---|---|
| `hello` | Protocol version, required features | IDs, epoch, limits, role, supported features |
| `write` | Entry, lease, txn?, request | Entry ID and lease |
| `read` / `take` | Template, overall timeout, `ifExists?`, txn?, request | `pending` or durable `done(entry/null)` |
| `pollOperation` | Request, `waitMs ≤ 25000` | the same operation state |
| `readAll` | Template, snapshot token?, cursor?, limit | Entries, next, token, stream ID, snapshot revision |
| `count` / `stats` | Template? | Value plus revision; federated additionally completeness |
| `txn` / `lease` | Action, ID?, duration?, request | State/lease/result |
| `wait` / `notify` | Template, durations, consumer, handback, request | Wait/registration ID, lease |
| `cancelOperation` | Target request, own request | durable cancel result or already decided state |
| `events` | Mailbox ID, epoch, cursor, `waitMs ≤ 25000` | Events, next or explicit gap |
| `ack` | Mailbox ID, epoch, `upTo` | idempotent result |
| `changes` | Stream ID, `afterRev`, `waitMs ≤ 25000`, byte limit | complete commit batches or `resync` |

**RPC claims:** key `(Principal, spaceId, requestGeneration, requestId)`, plus method, canonical
argument hash, one-time deadline and `pending/done/cancelled`. Deviating reuse is
`RequestConflict`. Registration of a pending request as well as the final decision are durably
serialized; operation and final result are in the same commit. A successful retry may deliver the stored
result again, but does not execute the mutation again.

The transport wait time of 25 s ends only the poll. It creates no business miss and extends no
overall deadline. `null` is final as soon as the operation has ended unsuccessfully according to its semantics. A new
business attempt receives a new ID. This also preserves the special `ifExists` semantics.

**Retention:** completed results remain for at least 24 h; pending operations are not deleted solely
because of this window. Request generations have a server-signed, fixed admission period.
After its expiry, IDs unknown within it are rejected with `RequestExpired`, even after claim cleanup;
results still present remain queryable. Old unknown requests are never treated as new writes.
The generation is bound to principal/Space. An unknown result after expiry requires business clarification.

**Mailbox:** ACK only for the authenticated consumer, matching epoch and already delivered sequences.
A consumer processes in order or acknowledges only the contiguously taken-over prefix. Old ACKs cannot
delete new events after a reset. TTL loss is reported as a gap; the dashboard loads a snapshot, the worker
reconstructs open operations from the journal. ACK confirms transport takeover, not a take commit.

**Backpressure:** separate byte/count limits for entries, claims, journal, mailbox, snapshots and stream; maximum
pending operations per principal and transport peer. Space for result/claim is reserved before mutation.
Overload returns `ResourceExhausted` before acceptance. Unresolved mutations/claims must not be silently discarded.
Stream eviction forces a resync; expired snapshots `SnapshotExpired`. Mailbox by default at most
7 days, plus a byte limit; on reaching it, stop accepting affected new operations instead of losing active
take results. Replication backpressure blocks synchronous writes. Rate limits also apply to
enrollment, reads, polls, txns and ACKs; streams are privileged.

### 6.3 `RemoteSpace` (client)

Common `SpaceLike` interface with explicit capability flags for mode boundaries. `RemoteSpace` keeps request ID
and arguments until completion, repeats transport attempts and polls the same logical operation. It extends
no deadline automatically. Unknown outcome is reported as such. Browsers use the gateway.

### 6.4 `FederatedSpace` (in the router)

Policy is a validated union of permitted rules; unsuitable field combinations are rejected:

```ts
type Rule =
  | { type: string; mode: "local"; member: string }
  | { type: string; mode: "expand"; members: string[];
      by: "type" | { field: string } | "capacity" | "capability" }
  | { type: string; mode: "sync"; variant: "primary"; member: string;
      primaryReplica: string; standbyReplica?: string; durability: "single" | "sync" }
  | { type: string; mode: "sync"; variant: "lww"; members: string[]; keyFields: string[] }
  | { type: string; mode: "sync"; variant: "set"; members: string[] };
type Policy = {
  policyVersion: number;
  rules: Rule[];
  default: { mode: "local"; member: string };
};
```

Primary epochs are kept separately per logical Space. In v1, primary covers the whole member including
its internal documents; all type rules of this member must have the same replica configuration. lww/set
run on other members. Control data including capability thus stay uniformly primary.
Exactly one rule per type; supertypes in search templates extend the search to all affected rules.
`local` means the explicitly named member, never implicitly the host of the client or router.

Agents with `space: fed` talk to the router; direct member accesses must check the same mode, rights and
routing boundaries. Managed expand types must not be written directly outside the responsible member.
Rule changes are subject to 7.1.

**Router journal:** before the first remote call the router persists logical request, principal, policy version,
chosen targets, sub-request IDs and deadline. An operation once begun changes neither member
nor policy on timeout. Remote results are durably taken over before the client reply or event ACK.

In the waiter race, all registration IDs and one generation per attempt are stored. The first still
active reservation is noted atomically as the winner; losers are cancelled/aborted, even if events
arrive later. Replay of the same events does not change the winner. Without a user txn, the router commits the
winner txn with a stable sub-request ID and stores the result. With an explicit user txn, work happens exclusively
on its member; `space_wait` may return a new reserving txn whose owner/proxy rights are
explicitly assigned to the original principal. No foreign agent can commit it.

After a restart the router reconstructs open states via the same sub-requests. If a winner expired
before commit, this attempt is logged as expired; a further attempt is permitted only within the same
still-open logical operation. An unclear commit is resolved first, never replaced by selecting
a second winner. A returned result with a txn contains its current validity status.

## 7. Modes

### 7.1 expand (distribute)

- **write**: type → fixed member; field → HRW over the fixed member set; capacity/capability → selection
  before the first attempt and durable binding in the journal. Stale capacity data can lead to a rejection,
  not to a silent second placement. Re-planning only after a clearly rejected attempt.
- **read**: first hit; miss only after a miss of all relevant members. On failure without a hit `Unavailable`
  instead of `null`. `readAll`/`count` by default return an error for missing members; explicitly permitted partial results
  contain `complete: false`, missing members and revision per member. There is no global snapshot.
- **take without waiting**: sequential member search; on an unknown outcome of a take, resolve it first.
  Only a confirmed miss allows the next member. Result and search progress are journaled.
- **waiting take**: race of reserving txns according to 6.4; released losers may be reserved again.
- **Transactions**: explicitly bound to a member before beginning; all reads/takes/writes stay there. A write
  whose rule demands a different member is rejected with `RoutingConflict`. No silent misplacements.
- **Failure**: stock temporarily unreachable; lost for good if storage is permanently lost without a backup.

**Membership and policy:** In v1, HRW set, key field and fixed type assignment are immutable for existing stock.
`addMember` registers hosts and permits new, empty partitions/rules; it changes no existing
hash assignment. Removing a member requires proven emptying including open operations.
`drain` stops new placements, existing requests and reads keep their targets. With capacity/capability,
earlier data locations remain part of the search set until emptied.

Automatic migration is a later feature with versioned routing tables, a durable transfer journal,
transitional reading and clear ownership handover. `take A → write B → commit B → commit A` alone is not a safe
migration procedure. Until then, changes that need migration are rejected.

### 7.2 sync (mirror)

| Variant | Use | Partition / guarantee |
|---|---|---|
| primary / sync | Control space, jobs | One active primary; writes block without the fixed standby; manual takeover according to 5.2. |
| primary / single | Single host with optional asynchronous backup | Locally atomic; no lossless failover guarantee. |
| lww | State with key | Both sides writable; deterministic convergence including versioned deletions. |
| set | Facts/observations | Observed-remove set with add-wins on a concurrent add; no exclusive job assignment. |

**primary:** the fixed standby takes over the complete ordered commit history including RPC results,
txns and router journal. In synchronous mode a commit becomes visible and is answered only after the standby
has durably accepted its complete batch and the primary has applied it locally. Before sending,
the primary persists batch and pending state; after a restart it clarifies this with the fixed standby before
further mutations are permitted. A batch durably accepted on the standby
counts as decided on recovery, even if the reply was lost. A primary
with an unclear replication outcome resolves it before further work. Replicas return only complete applied
batches as reads marked possibly stale; consistent reads and takes go to the primary.

No silent fallback to asynchronous operation. The standby is first synchronized via snapshot plus subsequent stream and only then
activated as the fixed partner. Both sides check epoch and replica identity.
Standby changes happen with paused writes and atomic configuration activation on the hosts involved;
with an unclear handover, operation stays locked. After promotion without a new standby, synchronous writes stay
locked. Old requests keep their deduplication key across the promotion.

**Entry replication for lww/set:** every change has an immutable ID
`(originReplicaId, incarnation, sequence)`. Forwarding preserves ID, owner and conflict metadata; it creates
no new change. Dedup/causal state is stored durably and transferred with the snapshot. Replicators
have a tightly limited import path; ordinary host writes cannot forge this metadata.

**lww:** per key, the lexicographic `(hlc.physical, hlc.logical, replicaId)` wins. HLC state is preserved across
restarts and advanced on receipt. Delete is an equal-ranking versioned
tombstone; older puts do not become visible again. A deliberate renewed write needs a new version.
HLC guarantees order, not the physically newest measurement. `asOf` remains separate business data.
Implausibly far-future clocks are rejected with a configured limit and diagnosed.

**set:** every add creates a unique tag. Remove/take removes only the observed tags; concurrent,
still unknown adds remain (add-wins). Take here is an observed removal, not an exclusive
reservation; `SpaceLike` rejects exclusive txns for such rules. Logs preferably use append-only.

**Leases:** for lww/set, expiry is transferred as an immutable origin deadline linked to the version.
Replays/forwarding do not renew the lease; renewal creates a new version. A configured
maximum clock uncertainty applies; expiry can be visible differently within this window. When the
uncertainty is exceeded, new time-critical operations are locked. Natural expiry hides only the affected
version or tag and must not delete a newer renewal. Primary takes over existing deadlines unchanged;
on promotion, time uncertainty and already expired txns are checked before new assignment. Lease expiry does not stop
an externally continuing worker: its effect target needs idempotency or fencing.

**Tombstones and offline replicas:** v1 keeps conflict/remove metadata permanently within a dedicated
budget; on reaching it, new changes are rejected. No time-based, unsafe cleanup.
Later compaction presupposes a confirmed common causal state of all active replicas. Permanently removed
replicas may participate again only after a complete rebuild with a new incarnation; old offline changes
are then not applied automatically. Snapshot/resync follows 6.1 and includes this metadata.

### 7.3 RAID-10 case

expand by field, per partition primary + replica. Only after stable 7.1 and 7.2.

### 7.4 Deliberate limits

- No global FIFO, no global order.
- No transactions across members (no 2PC).
- Guarantees hold only to the extent of 2.1; external effects are not generally exactly-once.
- No automatic primary election and no automatic migration in v1.
- `count`/`readAll` over a federation are snapshots without global consistency.

## 8. Directory and self-extension

- Every host writes `Capability` into its data Space and into the control space (lease 2 min, heartbeat 1 min);
  the control space replicates it with its uniform primary history. Only the assigned host may
  renew its capability; the server checks `memberId` against the principal.
- Agents find hosts with `space_list {type: "Capability", fields: {gpu: true}}` and address them with `space`.
- A new host appears automatically as soon as it is provisioned (4.4) and writes its capability; the admin
  confirms it via `Command addMember`.
- "Work follows capability": `Job {needs: "browser"}` with rule `by: capability` lands on a suitable member;
  if none exists, v1 answers `NoCapableMember` without a write. The caller can start a new attempt later.
  A durably parked dispatch queue with re-planning would be a separate feature.

## 9. Security and permissions

NetBird limits reachability; Space authorization applies additionally to every RPC, every poll result and
every mutation. Unknown roles/types/operations are rejected fail-closed.

| Principal | Allowed | Additional limits |
|---|---|---|
| observer | read/subscribe to released data and status | no take, write, lease intervention or internal stream |
| member | read/write/take normal data entries; own txns/leases | no control-data mutation; peer/agent quotas |
| admin | commands, enrollment, read released control data | changes via validated commands; no free overwriting of internal claims |
| host | report own capability, delegate local agents | only own namespace and assigned Spaces |
| router | process commands and delegate bound requests | checked scope, protected journal |
| replicator | import authorized replication snapshots/streams | only assigned source/target/mode; no arbitrary host writes |
| supervisor | process enrollment/recovery | only intended atomic state transitions |
| unpaired peer | own enrollment according to 4.4 | no general read/list/take/notify |

Protected types are also protected against take, lease cancel/renew and mutation via txns. Templates with
supertypes or without a type do not bypass the check. Read/list/notify filter by explicit read rights;
replication streams remain reserved for service roles. Enroll hashes, key management, claims and journals
are not delivered to ordinary members/observers. Foreign normal data entries remain readable/takeable
according to Space semantics, as far as the type ACL permits.

Content from other hosts remains untrusted; verified origin is no assurance about the content.
`[data, not instructions]` stays. Revocation follows the bounded grant lifetime from 4.3. Rate/byte limits apply
also to privileged remote services, with separate budgets. Audit logs principal, operation and result,
but no tokens or private keys.

## 10. Clients

All clients speak the same Space protocol; there is no client-specific API.

- **Phone (pi-termux-mobile)**:
  - `remoteState` becomes a connection list (map `hostId → RemoteConnection`, with separate Space/replica resolution); chat stays bound to a
    session.
  - **Spaces** page (`spaces.html`, own CSS file, endpoints in `constants.js`): members and status, policy editor,
    statistics per member and summed, contents (`readAll`), commands with result, pairing (show/scan QR).
  - Endpoints (proposal): `/api/spaces/{members,status,policy,command,result,list,entry,enroll,pair}`.
  - Long polls only while the page is visible; the system does not need the phone.
- **Desktop / CLI**: Node package `phi-spaces-client` (RemoteSpace + TCP transport + pairing), e.g. `phi-spaces status`,
  `phi-spaces policy set …`, `phi-spaces pair`.
- **Browser**: gateway on a host translates WebSocket/TLS to the Space protocol; login via app key
  (check WebCrypto support beforehand). NetBird SSO alone does not replace app authorization. The gateway
  binds browser sessions to individual principals, checks origin/CSRF and must not pass on general host rights.
  Implementation in stage 4.

## 11. Stage plan

Each stage implements its prerequisites before acceptance. Simulator checks complement persistent tests;
NetBird, platform and fencing assumptions additionally need real integration evidence.

### Stage 0: existing core

- B1–B3, L6, L7, L10; interface `SpaceLike`; integration into pi-serverd and server.mjs (L14).
- **Acceptance:** existing suite and targeted regression tests green; local workers coordinate; tests
  distinguish reservation, commit and external effect.

### Stage 1: named Spaces and local protocol

- Doc version 5 and migration 4 → 5; IDs, basic rights model, meter per Space, byte limits and revisions.
- RPC claims with generations, durable pending ops, mailboxes/ACKs, snapshot pagination and `RemoteSpace`.
- **Acceptance:** two Spaces on a host without ID collision; take commit with a lost reply returns the same result after
  a process restart without a second take. Long polls, claim expiry, wrong arguments and old ACKs
  are checked. Migration fixtures preserve entries, txns and outbox. Local Unix access remains a
  local trust boundary; SSH tunnels alone provide no differentiated peer identity.

### Stage 1b: overlay, authorization and enrollment

- Gate, service allowlist, A/B authentication, delegation and complete type/operation ACLs.
- Control space initially single; supervisor and recovery space; enrollment without router; strong tokens.
- NetBird failure tests, key storage on target platforms, bounded revocation and grant expiry.
- **Acceptance:** phone/desktop paired; unpaired peer only enrollment; forged second hello and foreign services
  rejected. Protected types neither takeable nor deletable via lease/txn. Revocation closes access within
  the specified boundary; after authority failure, grants are not extended indefinitely.

### Stage 2: router and expand

- Durable request/command journal and recovery; fixed policy versions; rules and search semantics from 7.1.
- Capability directory at the control primary; missing capability gives `NoCapableMember`.
- Phone page with status, policy and traceable error/partial results.
- **Acceptance:** 1000 jobs, 3 members, 6 workers: at most one successful destructive commit per entry, retries
  do not change the target binding. Test crashes after every journal/RPC/ACK boundary on persistent storage.
  Abort/expiry allows reassignment. A test effect target with an idempotency key shows one business effect;
  a counterexample without this protection documents the guarantee boundary. Impermissible routing changes fail.

### Stage 3: replication and controlled takeover

- First snapshot/stream import and lww/set merge including deletes, leases, deduplication and offline rejoin.
- Then complete primary commit history, fixed synchronous standby and supervisor recovery according to 5.2.
- Fencing adapter with verifiable stop/restart protection; secure control space and router journal together.
- **Acceptance:** 10-min partition with concurrent writes/deletes/renewals converges after exchange;
  snapshot under parallel writes loses no change. Without a standby, synchronous mutations are not
  confirmed. Promotion without fencing evidence or on the wrong standby is refused. After a permitted promotion,
  confirmed results are preserved; lost replies can be resolved with deduplication. The old primary
  does not start writing on its own, old epochs are rejected after rejoin. Without a new standby, sync write operation
  stays locked.

### Stage 4: further clients

- Desktop/CLI package and optionally a browser gateway with separate user identities.
- **Acceptance:** control without the phone; reconnection reconstructs status via snapshot/events; no
  identity mixing between browser sessions; poll interruption does not affect running host workers.

## 12. Test strategy

- **Simulator:** several harnesses, deterministic latency, loss, duplicates, partitions, clock jumps and
  restarts. Reference model for reservations, request states and merge rules.
- **Persistence:** real harness storage backends, process abort/reopen at commit, replication and reply boundaries.
  MemoryStorage alone is no evidence of durability.
- **Invariants:** at most one active reservation and one successful destructive commit per entry in
  expand/primary; abort allows taking again; one result per valid request; no target change on an unclear
  outcome; complete batches; no resurrection by old deletes/puts; lww/set converge after exchange.
- **Recovery:** interrupt the router after winner selection/commit/ACK; check late losers, expired txns, lost
  replies, duplicate commands, two recovery attempts, standby failure and old primary restarts.
- **Time:** lease expiry makes reservations unusable at the next settle, even if the reaper is delayed.
  A stopped process guarantees no active cleanup; settle happens before resumption. Worker effects
  after lease expiry are tested separately with idempotency/fencing.
- **Routing:** HRW set change is rejected; new empty rules work; drain preserves searchability;
  txn target conflicts and impermissible direct writes fail. Partial replies are explicitly marked.
- **Security:** role/operation matrix, supertypes, enrollment replay, delegation forgery, token limits,
  stream access, revocation under partition, old grants and gateway principal separation.
- **Integration:** two pi-serverd/gates on localhost with a test identity adapter; then a real NetBird environment
  and target platforms. A simulator cannot accept overlay identity and infrastructure fencing.
- **Load:** 10,000 entries, 3 members, complete document bytes including claims/stream/tombstones; p95/p99
  commit/poll latency, memory, journal growth, replication lag and behavior at every budget limit.

## 13. Decisions made and remaining gates

Decided for v1: explicit local default member; manual promotion only after verified fencing; exactly one
fixed synchronous standby per HA Space; no migration of existing HRW stock; strong enrollment tokens;
no general exactly-once for external effects; 24 h minimum retention of completed RPC results;
mailbox at most 7 days plus byte limit; service delegation and admin access always with an app key.

Still to be decided or demonstrated before the respective stages:

1. Always-running coordinator host and independently reachable recovery access.
2. Concrete fencing adapter, verifiable confirmation and durable restart protection (gate for stage 3).
3. Permissible clock uncertainty, HLC future limit and measurement/locking behavior; these values also apply to grants.
4. Concrete byte/count limits and snapshot/request-generation lifetimes based on the load tests.
5. NetBird version, deployment, component licenses, transport during failures and management API rights.
6. Target platform key storage as well as need and scope of the browser gateway.

Without meeting a gate, the guarantee that depends on it is not described as implemented or accepted.

## Appendix A: alternative without overlay: SSH certificates

If no NetBird is to be operated and all hosts are reachable via SSH:

- A CA (on the phone or coordinator) signs host and client keys (`ssh-keygen -s`). Clients trust
  the CA (`@cert-authority` in `known_hosts`) instead of individual host keys (no TOFU).
- Certificates carry principals (`peer:hostB`, `admin:handy`), are valid briefly (e.g. 7 days) and are renewed via the
  control space; revocation via KRL or non-renewal.
- Identity in the Space: one line per role `cert-authority,principals="peer:hostB",restrict,command="space-gate --peer
  hostB" <CA-pub>` in `authorized_keys`; `space-gate` then speaks over stdin/stdout. To verify: whether sshd, with
  several `cert-authority` lines with different `principals`, selects the matching line.
- Pairing requires an authenticated encrypted channel: for example PAKE for a short code or SSH with a
  CA fingerprint checked via QR and a strong one-time token. A plain-text channel with a token alone is not sufficient.
- The authorization, delegation and recovery rules of this plan apply here as well. KRL/short certificates
  alone do not replace the grant check for running Space sessions.
- Disadvantage compared to NetBird: no NAT traversal, key and certificate management falls entirely on the operator.
