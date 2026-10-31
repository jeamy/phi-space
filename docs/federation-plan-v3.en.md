# Federated Spaces v3 - consolidated plan

As of 2026-10-13 (current admission resolution added; fourth consistency check: evidence for `NotCommitted`, historical pending work, run recovery, boot permissions per Space and budgets for pages that are too small made precise). Replaces `_attic/federation-plan-v1.en.md` (revised version) and `_attic/federation-plan-v2.en.md`.

**Status:** Target contract with partly implemented local foundations: doc version 5, named Spaces,
identities, local request claims and persistent test helpers exist. The current scope and the open
parts are in the [implementation status](implementierungsstand.en.md) and in the [implementation progress](_attic/implementierungsplan-v3.en.md#7-progress).
Federation, recovery and the operations extension are not yet accepted. Local network RPC exists,
but replaces none of these guarantees. A guarantee counts as fulfilled only when its acceptance criteria (section 11) and gates (section 13) are met.

**Origin:** The basis is the revised v1, because it contains the more precise contract. From v2 the
usable proposals were adopted and, where necessary, corrected. Proposals that break guarantees of v1 were not
adopted. The assessment of each v2 point is in appendix B, open questions in section 14.

Basis of the implementation: [implementation status](implementierungsstand.en.md). The historical identifiers B/L
are kept in [spaces-v1.md](_attic/spaces-v1.en.md) only for earlier plan references.

**Implementation evidence 2026-10-09:** The local stage 1 protocol (AP 1.1-1.9) is implemented
and verified in [ap1-abnahme.md](_attic/abnahme/ap1-abnahme.en.md). Gate, layer A/B and replication remain further stages.

Note of 30 October 2026: The architecture and the contract below mention pi-durable and its documents; today they
run on the [phi-spaces store](umstellung-ohne-pi-durable.en.md) (`src/store/`, SQLite), and pi-durable only remains in the `agent/` package. The
guarantees of this contract do not depend on that.

## 1. Goal and starting point

Every reachable host (pi-serverd) provides Spaces to agents. Spaces can be joined into federations and
controlled and observed by arbitrary clients (phone, desktop, CLI, browser via gateway). Composition modes:
**expand** (distribute, similar to RAID 0) and **sync** (mirror, similar to RAID 1). The control is itself a Space
(control Space), the router a worker in it. Network: self-hosted NetBird overlay (WireGuard).

Assessment of the original draft (still valid unchanged):

| Statement in the draft | Solution in this plan |
|---|---|
| Identity comes from the connection | Overlay identity plus app challenge bound to the connection (4.3) |
| requestId like tool claim | durable RPC claims per principal/Space/generation (6.2) |
| Take waiter on all members | consumer mailboxes with ACK and journaled waiter race (6.2, 6.4) |
| numbered change stream | revision per commit, batches, snapshot plus stream (6.1) |
| last writer wins | mandatory key fields, HLC versions, versioned tombstones (7.2) |
| newer `asOf` wins | HLC orders versions; `asOf` remains a business date (7.2) |
| txns on one member | global IDs `spaceId/localId`, txn binding, `RoutingConflict` (7.1) |
| capability directory | protected types, only the host itself writes (8) |
| router on the phone | router as worker on the coordinator host (5) |
| SSH key per host pair | NetBird for network and key exchange; SSH CA as alternative (appendix A) |

## 2. Terms

- **Host**: pi-serverd with a stable, untruncated `hostId`; can hold several Spaces.
- **Space**: logical store with immutable `spaceId`; names are changeable aliases.
- **Member**: logical data Space in a federation; `memberId = spaceId`. In expand solely responsible for its
  entries, txns, waiters and outbox; in primary with physical replicas.
- **Replica**: physical copy with its own `replicaId`; takes over the same `spaceId` on promotion.
- **Control Space**: protected control data (members, policy, keys, commands, status).
- **Router**: worker on the coordinator; operates `FederatedSpace`, replicators and commands.
- **Supervisor**: local service per host, independent of the router; enrollment, recovery, promotion.
- **Recovery Space**: local, **non-replicated** Space per host for recovery requests (rationale 5.4).
- **Peer**: authenticated counterpart with immutable `peerId`; display names are not an identity.
- **Owner/principal**: structured `{peerId, agentId?}`; strings are only an output format.
- **Federation**: named set of members plus versioned policy.
- **Global ID**: `<spaceId>/<localId>`. Local IDs consist of incarnation ID plus counter and are never
  reused; after a restore a new incarnation is assigned before new writes. Replication preserves
  existing IDs. Restore is not a lossless promotion.
- **Mailbox**: durable events for principal and consumer, addressed via `mailboxId`, `mailboxEpoch`, `seq`.
- **Overlay**: NetBird network. Overlay IPs are endpoints, not permanent identities.

### 2.1 Binding guarantees and limits

| Level | Contract |
|---|---|
| Local commit | Space mutation and RPC result are written durably and atomically. |
| Retry | The same valid request returns the same result without renewed mutation, within the window from 6.2, **also after a process restart**. |
| Take under txn | At most one active reservation per entry; abort/expiry allows renewed reservation. |
| Successful take | At most one successful destructive commit per entry identity in expand/primary, **as long as the history of the Space is continued without lossy restore** (promotion per 5.3 is lossless). After a restore from an asynchronous copy the guarantee applies only to the restored contents under the quarantine from 5.2.2: restored entries of exclusive types are `restoredUnverified` and can be taken again only after functional release. |
| Functional effect | No general exactly-once for external effects; the target needs idempotency or a shared transaction. |
| primary/sync | Confirmed operations are preserved on permitted promotion (5.3). |
| Asynchronous copy | Backup/read copy. Confirmed writes/takes can be missing when the primary is lost. **Never automatic and never lossless promotion**; only restore with new incarnation. |
| lww/set | Eventual convergence after complete exchange; no exclusive work assignment. |
| Result deadline | After erasure of a completed result (6.2) a retry returns `ResultExpired` without mutation. A taken entry whose result was never fetched until then is lost for the caller. |
| Restore (data, 5.2.2) | New data incarnation of this Space only, with unchanged control authority. Old generations return `IncarnationChanged`; dependent router work and runs become `needsReview`; restored exclusive entries stay locked until `releaseRestored`. |
| Unknown request after promotion | `NotCommitted` only after the complete evidence and durable negative claim from 6.2: retained generation, same authority/data incarnation, lossless history and excluded old replica. Only then may the client begin with a new ID. Expiry or lost history provide no such release. |
| Restore (single) | Old generations permit no new effects (`IncarnationChanged`). Retained member claims remain usable for newly authorized resolution; lost journal/claim state requires functional clarification (`needsReview`, 5.2.1). |

Network failures can leave an unknown outcome. The client asks again with the same request ID and
starts no new mutation when uncertain. Permanently lost storage is data loss in expand.

**Authority incarnation:** `authorityId` is a random, immutable 256-bit ID of the control group.
Only a restore replaces it, via the locally authorized transition from 5.2.1. It is not a sortable counter.
Grants, router leases, delegations, policy versions and epoch notices are bound to it.
A member accepts exactly its locally installed authority; a higher counter does not legitimize a foreign
`authorityId`. Promotion, router change and switch to single keep the authority.

**Epochs** (three separate counters; "epoch" without qualifier is not permitted): Within their respective incarnation
they rise monotonically. After an authorized restore `primaryEpoch` and `routerEpoch` begin at 1 in the new
authority; values of different authorities are never compared numerically. `mailboxEpoch` is never reset within the
same mailbox identity; restore replaces the mailbox identity.

| Name | Applies to | Raised by |
|---|---|---|
| `primaryEpoch` | a logical Space with replica or restore | promotion (5.3), switch to single (5.3.1), data restore (+1, 5.2.2); new namespace on control restore (5.2.1) |
| `routerEpoch` | router leases of a federation | router restart/change and control promotion; new namespace on restore |
| `mailboxEpoch` | a mailbox | mailbox reset |

## 3. Target architecture

Supplementary [architecture diagrams and operating procedures](betrieb-und-mobile-steuerung.en.md) show today's
pi-durable/SSH integration and the mobile target picture using the prime sieve. Space lifecycle and run/worker
commands proposed there are additional open contracts, not already implemented v3 commands.

```
   Handy        Desktop/CLI      Browser
     │              │               │ WebSocket/TLS (Stufe 4)
     │              │          ┌────▼─────┐
     │              │          │ Gateway  │
     │              │          └────┬─────┘
 ════╪══════════════╪═══════════════╪══════════ NetBird-Overlay (WireGuard, ACL-Gruppen) ══════
     ▼              ▼               ▼
 ┌────────────────────────────────────────┐        ┌────────────────────────────┐
 │ Koordinator-Host                       │        │ Host B                     │
 │  space-gate (TCP, nur Overlay-IP)      │        │  space-gate                │
 │  Supervisor + Recovery Space (lokal)   │        │  Supervisor + Recovery     │
 │  pi-serverd                            │◄──────►│  pi-serverd                │
 │   ├ Control Space (primary)            │        │   ├ Control-Standby (St. 3)│
 │                                        │        │   ├ Router-Standby (inakt.)│
 │   ├ Router (Journal, FederatedSpace)   │        │   ├ Data Space B           │
 │   ├ Data Space A                       │        │   └ Agenten                │
 │   └ Agenten                            │        └────────────────────────────┘
 └────────────────────────────────────────┘
            NetBird Management/Signal/Relay (selbst gehostet, eigene VM)
```

The diagram combines standby and data member B on one host in abbreviated form. Per 4.1.1 the synchronous
standby runs on its own VPS with coordinator sizing; data members live on further hosts.

- Agents use the tools as today; with `space`, operations go through `RemoteSpace` or `FederatedSpace`.
- Clients hold no central operating state; host workers keep running without a dashboard. Clients keep
  their own request IDs until completion.
- Router journal and RPC claims live in internal durable documents; agent payload data never in the control Space.
- The router standby runs passively (no lease, no delegations) and is activated only on promotion per 5.3:
  raise `primaryEpoch` and `routerEpoch`, let the old `RouterLease` expire, initially
  `awaitingDurability`. After an authorized switch to single, router recovery begins (5.3.1).

## 4. Network and trust

### 4.1 NetBird as network layer

Planned: self-hosted NetBird on a dedicated Linux VM with domain and Docker Compose. Version, ports, resources,
user management (built-in or external IdP), license and upgrade/backup path are determined for the version
used before stage 1b from the official documentation (gate 5).

| Task | Responsible |
|---|---|
| WireGuard keys, exchange, NAT traversal, relay | NetBird |
| Join of hosts / clients | setup key / login |
| Reachability (network ACL via groups) | NetBird policies |
| Identity, rights, quotas in the Space | phi-spaces (4.3, 9) |

Groups (proposal): `space-hosts`, `space-admin`, `space-observer`; policies allow only the Space port and SSH
for admins. WireGuard cryptographically binds the source IP of a packet to the peer key (cryptokey routing);
IP spoofing by *foreign* peers is therefore excluded in the overlay. Processes *on* a peer share its
overlay identity; hence layer B (4.3).

### 4.1.1 Resource planning with several VPS

Planning values without benchmark acceptance: The following sizes cover the Space service and the named side processes.
Local model inference, large browser fleets and CPU search tasks need an additional budget of their own.
Shared-vCPU offerings can deliver fluctuating performance; the CPU count alone guarantees no throughput.

Sizing applies per VPS and its role, not per federation. `expand` distributes data entries; a
data member therefore does not automatically hold the stock of all other members in RAM. The main costs in v3
are initially persistent commits, snapshots, streams, mailboxes, tombstones and router journal. NVMe/SSD with
reliable IOPS is therefore more important than a high number of CPU cores.

| Role | Starting recommendation | Storage | Rationale |
|---|---:|---:|---|
| Data member, light agent load | 2 vCPU, 4 GB RAM | 30-50 GB NVMe | own data Space, local workers and gate |
| Data member, many workers or browser automation | 4 vCPU, 8 GB RAM | 50-80 GB NVMe | additional processes, waiters and local backlog |
| Coordinator: router and control primary | 4 vCPU, 8-16 GB RAM | 80 GB NVMe | router journal, control Space, long polls and replication |
| Fixed synchronous standby | like coordinator: 4 vCPU, 8-16 GB RAM | 80 GB NVMe | must carry complete commit history and recovery |
| NetBird management/signal/relay, separate | 2 vCPU, 2-4 GB RAM | 20-40 GB SSD | management services; not at the same time the coordinator |

A small federation can thus consist of three data VPS with 2 vCPU, 4 GB RAM and 40 GB NVMe each, a coordinator
and a synchronous standby with 4 vCPU, 8 GB RAM and 80 GB NVMe each, and a separate NetBird VM.
The values are starting sizes; the load tests from section 12 determine the final budgets for
entries, journal, snapshots and replication backlog before stage 2.

Coordinator and standby must separate a failure domain: at least different physical hosts and, where
possible, different availability zones or providers. Two VPS on the same physical host do not protect
against its failure. The fencing adapter from 5.5 must actually be able to control the respective
provider and its management API.

With `primary/sync` every confirmed write carries the additional round trip to the standby. Coordinator and
standby therefore belong in nearby regions with stable, low latency. Geographically distant VPS directly increase
commit latency and timeout risk; they are better suited for asynchronous backups or data members
without synchronous confirmation. Monitoring records CPU, RAM, free storage, IOPS/latency, commit p95/p99,
replication lag and mailbox/journal budgets per VPS.

### 4.2 `space-gate`

- TCP only on the overlay IP; internal Unix socket `0600`.
- The gate authenticates the connection (4.3) and hands pi-serverd a context that the client cannot override
  and that the server accepts exactly once at connection setup. The public `hello` only negotiates
  protocol features and sets neither identity nor role.
- pi-serverd gets an explicit authentication boundary for this; merely prepending a frame with
  unchecked pass-through is not enough.
- Limits (fix start values before 1b, confirm by load test before 2, gate 4): handshake ≤ 5 s; frame ≤ 256 KiB
  (must be larger than `maxEntryBytes` 64 KiB plus protocol overhead); at most 32 concurrent connections
  per peer; rate limit for handshakes.
- **Commit boundary:** A commit batch is indivisible (6.1). Hence `maxCommitBytes` ≤ frame minus
  protocol overhead (start value 192 KiB, F11/gate 4; sum of the canonically encoded deltas of a commit including
  claims and metadata). Before every txn extension the additional state and a conservative upper bound
  for commit **and** abort including result/claims, lock releases and internal follow-up jobs are reserved.
  If that exceeds a batch or the storage budget, this extension fails before its mutation with
  `ResourceExhausted`; previous txn work remains completable. Completion must not fail at the byte limit for the first time.
  Task take and result remain one atomic commit. Only functionally divisible batch writes or
  run preparations are split in advance into idempotent partial commits with a progress manifest.
  Internal follow-up effects follow 6.1; they too must not bypass the frame limit.
- Only `serviceId: space`. `sessions`/`chat` stay blocked on this entry point.
- `pi-client` gets a TCP transport factory; check compatibility of the byte/CBOR transport before implementation.

**No mTLS on the Space port in v3.** Rationale: WireGuard provides encryption and peer binding; the app challenge (4.3)
provides key possession and binding to the connection. mTLS would require a second PKI (X.509, issuance, rotation,
revocation) that Node cannot create without `openssl` or an additional library, without a new guarantee. TLS
is used only at the browser gateway (section 10). Open question F3.

### 4.3 Identity

| Layer | Contract |
|---|---|
| A: overlay | Source IP → management API → immutable peer ID and groups; cache at most 60 s. |
| B: app key | Challenge per connection (below). Permitted keys are `PeerKey` entries in the control Space. |

Layer A depends on the NetBird management API. If it fails for longer than the cache duration, all
gates reject new connections (4.6). The recovery path therefore depends neither on layer A nor on the gate (5.4).

**Challenge (layer B):** The gate sends `{gateHostId, observedPeerId, connNonce (32 bytes), protocol,
issuedAt}`. The client checks that `gateHostId` matches the expected host and `observedPeerId` its own
overlay identity, and signs the canonical encoding (4.4). An attacker who is a peer
himself therefore cannot pass a challenge on to a victim: the victim would recognize a foreign `observedPeerId`.
The nonce is single-use and valid for at most 30 s. Signatures per request are not necessary, because WireGuard binds the
further traffic of the connection to the peer (open question F4).

- Algorithm: Ed25519; where the platform keystore does not support Ed25519, ECDSA P-256 (gate 6).
- Layer B is mandatory for control Space, admin, router, gateway, replication and delegating hosts. The only
  exception is enrollment (4.5): An unpaired peer proves with the challenge only possession of the *new*
  key and receives exclusively the role "unpaired peer" from section 9. Direct
  data Space clients may work with A only if an explicit peer/group rule assigns `member` or `observer`.
  Without a rule no access. Group and app rights are intersected, never united.
- User roles `admin`, `member`, `observer`; service roles `host`, `router`, `replicator`, `supervisor` with
  explicitly allowed Spaces and operations. A host is therefore not an admin.
- Authorization at every request and again before the deciding commit. Grants are valid for at most 60 s;
  invalidations close sessions and end open polls. Without a timely renewed, authoritative grant
  new operations are rejected; still unsealed operations remain `pending` until
  a valid grant or delegation exists or their deadline expires (then definitively unsuccessful). Replicas issue no grants from old state.
  Already sealed commit candidates from 7.2 are not re-authorized or subsequently aborted;
  their effect is fixed for recovery, even if the confirmation is still outstanding. Before sealing, rights,
  deadline and lease must be valid. Confirmed work is not undone by revocation.
- **Resolution after rights withdrawal:** An app key that is still authenticated and not revoked may
  obtain from the control primary a short-lived `resolution` grant for its own already accepted requests.
  It permits only status/result retrieval and cancel/abort, no new functional effect or delegation renewal
  for the commit. Without a valid grant the failure lock applies here too. After key/peer revocation there is no
  self access; a currently authorized admin takes over the resolution as a separately audited service action.
  A-only clients without remaining authenticated authorization likewise need this admin resolution.
- **Revocation takes effect within grant lifetime plus time uncertainty**, not immediately under every partition.
- Grants are issued only by the authoritative control primary. If it is unreachable, after the grant lifetime
  **all** remote operations on **all** members expire, not just enrollment and commands (5.2). Local
  agents, local workers, reaper and lease expiry of a host keep running.
- Recovery uses a separately locally provisioned admin key (5.3); its revocation is confirmed separately on each
  recovery host. Desktop key files `0600`.

### 4.4 Delegation

A host identifies local agents only in its own principal namespace. The router passes this identity on with a
signed delegation proof:

```ts
type RouterLease = {
  id: string;
  routerPeerId: PeerId;
  routerEpoch: number;
  controlSpaceId: SpaceId;
  authorityId: string;          // lokal installierte Control-Autorität
  controlPrimaryEpoch: number;  // primaryEpoch des Control Space beim Ausstellen
  expiresAt: number;
};
type SignedRouterLease = { lease: RouterLease; issuer: PeerId; signature: string }; // Supervisor des Control-Primary

type Delegation = {
  issuer: PeerId;               // Router; muss lease.routerPeerId sein
  routerLease: SignedRouterLease; // nicht vom Router selbst signiert (5.2)
  principal: Principal;         // ursprünglicher Aufrufer
  targetSpace: SpaceId;         // Audience
  targetPrimaryEpoch?: number;  // bei primary-Zielen: erwartete primaryEpoch
  operation: string;            // z.B. "take", "pollOperation", "cancelOperation"
  requestId: string;            // Identität DIESES Aufrufs
  requestGeneration: string;    // Generation dieses Aufrufs am Ziel (6.2)
  argumentHash: string;         // Hash der Argumente DIESES Aufrufs einschließlich targetRequest
  targetRequest?: {            // nur Folgeaufrufe; Principal und Space wie oben
    requestId: string;
    requestGeneration: string;
    method: string;
    argumentHash: string;       // unveränderlicher Hash des Ursprungsrequests
    policyVersion: number;
  };
  policyVersion: number;        // Ursprungs-Policy; bei Folgeaufrufen gleich targetRequest.policyVersion
  expiresAt: number;            // ≤ 60 s, ≤ routerLease.lease.expiresAt
};
```

The delegation contains all components of the RPC claim key from 6.2 (principal, target Space,
request generation, request ID) as well as, for primary targets, the `primaryEpoch`.

- **Canonical encoding** for signature and hashes: JSON per RFC 8785 (sorted keys, fixed number form),
  small implementation of its own without dependency. `JSON.stringify` alone is not deterministic enough.
- Signature with the router key (`node:crypto`); the public key is stored as `PeerKey` with role
  `router` in the control Space. The embedded `RouterLease` carries a **second signature** of the supervisor of the
  control primary (`PeerKey` with role `supervisor`), which it issues only after durable commit of the lease
  (5.2). A router thus cannot extend its own lease.
- The member checks both signatures, `issuer = lease.routerPeerId`, audience, the locally installed
  `authorityId`, expiry with time uncertainty, `routerEpoch` and `controlPrimaryEpoch` against its durably
  stored maxima. For primary targets `targetPrimaryEpoch` must equal its own for **new** requests.
  For retries and follow-up calls to an existing claim a `targetPrimaryEpoch` of the same
  authority that is not greater than its own suffices; the claim is then answered or
  continued independently of the epoch, provided the claim does not originate from a lossy restore (5.2.2).
  An unknown ID with an older epoch is resolved per the check order from 6.2;
  `NotCommitted` is not a blanket answer to a missing claim and produces no functional effect.
  `operation` and `argumentHash` must match the actual call; the scope must permit it.
- **New operations:** generation within the admission deadline; older policy versions are rejected.
  For a newer version the member reloads the policy; without success it rejects.
- **Follow-up calls:** poll, result retrieval, cancel as well as winner commit/abort reference via `targetRequest`
  the already existing claim of the same principal. Method, hash and original policy version are checked
  against this claim. A missing claim legitimizes no new mutation. Every mutating follow-up action
  has its own stable request ID in a generation valid for the first call; its claim is deduplicated separately. Repeated polls use a new ID per call and create no durable mutation claim;
  they read the current state of the target claim. A retry of the original mutation, however, keeps its
  original ID, method and functional arguments; only the renewable frame (6.2) may change.
- **After policy change:** target binding and original policy remain; current rights decide
  the admissibility of the follow-up action. After withdrawal of the effect rights only resolution and cancel/abort per the
  `resolution` grant from 4.3 are permitted. The own follow-up claim does not replace this rights check.
- **Generation expiry:** The admission deadline limits new IDs, not the handling of known claims.
  Existing pending requests remain queryable after generation expiry and decidable with matching current rights.
  The same applies to retries of known mutating follow-up calls. Unknown IDs of an expired
  generation are always rejected, even if they name a known `targetRequest`.
- **Long operations:** A poll with a valid effect grant at the same time renews the authorization of the target claim.
  The signed `targetRequest` reference binds this renewal to method, hash and original generation;
  the delegation is valid for at most 60 s and never longer than router lease or grant. A `resolution` poll renews
  no effect rights. Without a valid effect delegation an unsealed request stays pending until
  renewal or deadline; `FOREVER` remains permitted. Router supervision runs server-side even without UI polls.
- **Replay:** Mutating calls hit their own claim and return its stored result;
  differing method/arguments result in `RequestConflict`. Request IDs are bound to principal/Space/generation
  namespaces; equal ID strings of different principals do not collide. A foreign target reference
  is never accepted on the basis of an equal ID string.

- Gateway users are principals of their own. Quotas count delegated principal and transport peer. Freely passed
  `owner` fields are ignored.

### 4.5 Pairing

1. Device joins the overlay; an admin assigns the group.
2. The admin client creates the token **locally** and sends only its hash in the command `createEnroll`; the
   supervisor creates from it `Enroll {tokenHash (SHA-256), role, scope, allowedPeerId, expiresAt = +5 min,
   attempts: 0}`. The plaintext token appears neither in the command nor in the result nor in the control Space.
   The QR contains endpoint, control Space ID and token with **256 bits** of randomness. The plaintext token is logged nowhere.
3. Unpaired peers may use exclusively the special RPC `enroll` on `serviceId: space` and the
   query of their own enrollment result; no general entry writes, token lists,
   control reads, subscriptions or takes. This is the only exception from the
   layer B obligation for the control Space (4.3). A prerequisite is a NetBird group rule that admits the peer for
   enrollment.
4. Flow: peer connects (layer A), receives the connection challenge from 4.3, signs it with the **new**
   key and sends `enroll {token, publicKey, signature, requestId, requestGeneration}`. The token stays
   exclusively in the volatile input buffer of the enrollment handler; generic request logging and
   persistent request queues are blocked for this entry point. The supervisor checks in this order:
   1. An `Enroll` with `sha256(token) = tokenHash` exists. Otherwise error without counter change; this case
      counts only against the peer limit from step 5.
   2. `observedPeerId = allowedPeerId`. Otherwise error **without** increasing the token counter, so that a foreign peer
      cannot burn a token.
   3. Expiry and attempt counter.
   4. Signature and key format. Only an error here increases `attempts`.

   Only after the check are token consumption, `PeerKey` creation and a sanitized result claim stored atomically at the
   control primary. Persistable are `tokenHash`, peer ID, key fingerprint, method,
   argument hash and result, never the token or raw request payload. This applies equally to journal,
   commit stream, replication, snapshots and audit. Retries with a new connection proof use the same
   request identity; the semantic hash covers tokenHash and the new public key, not the
   connection-specific challenge/signature. An existing own claim is resolved before the check for an already
   consumed token; identity and key possession checks remain mandatory.
5. Rate limits: at most 3 failed attempts of the bound peer per token (then invalid), at most 1 attempt
   per peer and minute.
6. Manual entry uses the same strong token. Short codes need a separate procedure (PAKE,
   attempt limit, admin confirmation) and are not part of v3.

Bootstrap: The first host creates the control Space and, once, a bootstrap token; the supervisor processes it
without a router. The bootstrap token too is bound to an `allowedPeerId`: The first admin device joins the
overlay beforehand, and its peer ID is determined via the management API and entered at creation. Further hosts
receive bound one-time tokens and only the role `host`; they become routing targets only after `addMember`.
The first admin pairing is completed **before** `createEnroll` for further hosts and before membership commands.
The locally provisioned supervisor may create only the first bound admin token, once; this
bootstrap authority is closed permanently with its successful consumption. A script sends later
commands as this paired admin, not on the basis of its SSH connection or host role. The one-time
bootstrap token is displayed only transiently; if lost before consumption it is replaced locally and the old hash
becomes invalid. Repeated bootstrap of an already initialized host does not reopen the authority.
After a restore, exclusively the recovery admin transition from 5.2.1 applies instead.

### 4.6 NetBird operation and failure tests

Local storage is preserved during failures; the availability of remote operations depends on transport and
valid grants. After cache expiry without authoritative renewal, rejection is closed; local maintenance
and lease expiry keep running.

Test matrix before stage 1b. The right column contains **hypotheses** that the test confirms or refutes; the
result is added in this section.

| Failure | Duration | Hypothesis to be checked |
|---|---|---|
| Management | 5 min, 1 h | existing tunnels remain; new peers/policy changes not possible; layer A cache expires → access is rejected |
| Signal | 10 min | existing tunnels remain; reconnections after tunnel loss fail |
| Relay | 30 min | direct connections remain; relayed connections break |
| Management + relay | 1 h | direct tunnels may remain; without authoritative gate renewal Space RPC is blocked after cache expiry |
| Peer removed | – | tunnel ends; gate rejects within cache lifetime |

**Results (as of 2026-10-08, test environment on `big`, details in [testumgebung-big.en.md](testumgebung-big.en.md) section 12).**
Setup (gate 5): NetBird server 0.80.0 (combined container with management, signal, relay and STUN) and dashboard behind nginx with
TLS on `spacebird.eibrain.org`, built-in Dex as identity provider, Linux agent 0.80.0 in rootless Docker with kernel WireGuard,
Android client 0.60.3. Management API: a service user with the role admin suffices for groups, setup keys, policies and the
peer list (`GET /api/users/current` is blocked for it). Measured:

- Group rules (policy "Default" off): between two hosts of the group `space-hosts` only TCP 7421 is open; TCP 8080, TCP 22 and ICMP are
  blocked (hypothesis confirmed, policy acts at port level).
- Peer removed from the group: traffic blocked immediately in both directions, the peer sees no other peers any more, the others no longer list it
  in the peer list. Without restarting the agents. Arrival time not measured; whether the layer A resolution in the gate (cache 60 s) rejects
  in time is therefore open.
- Connection setup is delayed (lazy): a peer first appears as "Idle", the P2P connection arises on the first traffic.

**Addition 2026-10-11:** A separate administrative component proxy limits
faults to the test peers host-b/member-2; the production endpoint and
other VPN users stay active. In the complete 5-minute management case signal,
relay and the direct TCP tunnel were preserved. After cache expiry the
real data gate refused object access; after 305 seconds of fault phase and lifting
of the fault it succeeded again. This confirms the security
hypothesis for the targeted reachability failure of these peers, not a
global management server crash. Measurement points are in
[netbird-management-5m.json](../test/evidence/ap1b-2026-10-11/netbird-management-5m.json).

**Complete acceptance of 2026-10-11:** Management 305.3 s and 3604.3 s,
signal 608.6 s, relay 1807.3 s and management + relay 3604.0 s are complete.
Every case ends with successful object access. Group withdrawal and real
peer DELETE blocked access after 2.895 s and 2.823 s respectively.
Fresh phone initial pairing, key control, background and controlled
Doze were also verified. [Acceptance and limits](_attic/abnahme/ap1b-abnahme.en.md),
[measurements](../test/evidence/ap1b-2026-10-11/acceptance-summary.json).

The limited test proxy interrupted reachability per component for two
own peers. The global combined server and its database were not
stopped in the process. Direct TCP access is no proof of valid Space access:
On management failure the tunnel remained, the gate refused after
cache expiry. Signal reconnect was triggered by restarting only the
test agent itself. All own fault rules and the desktop exception were removed.

## 5. Control Space, router, supervisor, recovery

| Type | Written by | Content |
|---|---|---|
| `Member` | router after command | identities, endpoints, admission state, routing assignment |
| `FederationPolicy` | router after command | validated policy with `policyVersion` |
| `PeerKey` | supervisor | principal, public key, algorithm, roles, scope, state `active \| revoked` |
| `Enroll` | supervisor after command `createEnroll` | 4.5 |
| Enrollment result claim | supervisor after checked `enroll` RPC | sanitized data only per 4.5, no token entry |
| `Command` / `Result` | admin / router or supervisor | `{commandId, state, error?}`; commands see below |
| `RouterLease` | supervisor of the control primary on request of the router | `RouterLease` from 4.4, signed; renewal every 20 s, lifetime 60 s (5.2) |
| `MemberStatus` | router | reachability, revision, lag, capacity; lease 30 s; from the router's point of view |
| `Capability` | host for itself | tools, models, resources, host metrics; lease 2 min |
| `RecoveryRequest` / `RecoveryResult` | recovery admin / supervisor | only in the local recovery Space |

Admins write exclusively `Command` entries; all other control data arises from their processing.

| Command | processed by | Effect |
|---|---|---|
| `createEnroll` | supervisor (control primary) | create `Enroll` (4.5); works without a router |
| `revokePeer` | supervisor (control primary) | `PeerKey` to `revoked`; grants expire per 4.3 |
| `rotateKey` | supervisor (control primary) | admit new key by challenge with old and new key, revoke the old one |
| `setLimits`, `drain`, `addMember`, `removeMember`, `setPolicy` | router | 5.1, 7.1 |
| `restoreDataSpace` | supervisor (control primary) with supervisor of the target host | restore of a single data Space per 5.2.2 |
| `releaseRestored` | supervisor (control primary) with supervisor of the target host | release restored `restoredUnverified` entries in the given scope (5.2.2); works without a router |
| `setStandby` | router with supervisor of both hosts | set up or change the fixed standby of a primary Space, only with paused writes (7.2) |

Supervisor commands are just as idempotent and journaled as router commands (5.1). Further
lifecycle commands (create/delete Space, run and worker control) are proposed as an extension in
[betrieb-und-mobile-steuerung.en.md](betrieb-und-mobile-steuerung.en.md) and are not part of v3.

### 5.1 Commands and router journal

Command processing is a durable state machine
`accepted → applying → completed | failed | needsReview`. `failed` means a proven final error;
`needsReview` means the end of automatic resolution without a secured functional result.

- Before every remote effect the router stores target, argument hash and a stable **sub-request ID**.
- The remote operation is executed with exactly this sub-request ID as RPC `requestId`. The target stores
  effect and deduplication atomically (RPC claim, 6.2). After a crash the router queries the same sub-request
  or repeats it; a second effect is excluded.
- Journal plus deduplication provides resumption and atomicity **per target operation**, not an atomic change
  of several Spaces. An unknown outcome is never booked as `failed`. Partial effects remain visible and
  are handled further on the basis of the journaled steps.
- Operations without an idempotent target protocol are not permitted commands.
- After a restart the router is `recovering`: it reconstructs target bindings, winners, claims and reserved
  budgets and re-establishes the supervision of open work. After that it accepts independent new work;
  it does not wait for the functional completion of all requests. A reconstructed `FOREVER` waiter may be served by
  a new write. Unreachable targets block only the operations that depend on them;
  still unresolved policy/membership changes block their affected routing area.
- After `ResultExpired`, missing history or `IncarnationChanged`, an operation that can no longer be resolved
  automatically becomes durably `needsReview` with target, IDs and available evidence. An admin documents
  the functional decision separately; he does not rewrite the historical outcome into an invented success.
  No automatic substitute request and no second winner. Independent work remains possible;
  necessary dependent resources stay locked until documented clarification.
- A split into fixed journal partitions must durably bind count, router IDs and ID assignment.
  All children of a parent keep their router; known IDs must not become invisible through reconfiguration.
  Individual and total budgets are finite. Restore and remove check all partitions;
  an incomplete cross-partition restore holds a durable lock until resumption.
  A migration or resizing requires a procedure of its own, not an automatic redistribution.
- Journal and deduplication have the same protection and replication class as the control Space; their bytes
  are budgeted separately. Mailbox ACKs only after durable takeover of the event.

### 5.2 Availability of the control Space

| Stage | Operation | Guarantee on failure of the primary |
|---|---|---|
| 1b-2 | **single** plus regular asynchronous snapshot to a second host | After expiry of grants (60 s) and router lease **all remote operations** of the federation stand still, not just enrollment and commands. Local work per host continues. Continuation only after return or **restore** per 5.2.1. No automatic takeover. |
| from 3 | **primary/sync** with fixed standby | manual promotion per 5.3 without loss of confirmed operations. Until promotion, remote operations stand still as above; after promotion until the explicit switch per 5.3.1 likewise. Only then can `setStandby` set up a replacement; without sync commit or authorized switch no new lease. |

A failure of the control primary or its synchronous standby thus halts the whole federation as soon as
grants and router lease expire. This is the price for rights and router fencing coming only from authoritative
state.

**Router lease (software fencing of the router):** The router may issue delegations only within a valid
`RouterLease`. It requests renewal from the supervisor of the control primary; the latter commits the
lease in the control Space and signs it only afterwards (4.4). In mode primary/sync every commit needs the
standby confirmation. A cut-off old primary can therefore no longer obtain a lease, and a self-issued
lease fails at the supervisor signature. Members reject its delegations after expiry.
A new router starts at the earliest after expiry of the old lease plus maximum time uncertainty and receives a
higher `routerEpoch`.

**Epoch notice:** After promotion, switch of the control Space to single, or router change the
supervisor sends a signed `EpochNotice {kind: "promotion" | "degrade" | "routerChange", authorityId,
controlSpaceId, controlPrimaryEpoch, routerEpoch}` to every member. It applies only within the already locally
installed authority. Each member stores the highest counters durably and rejects smaller values.
Without delivery, the expiry of old leases/grants protects. The retained journal is continued with the same sub-requests.
A restore instead needs the separately authorized authority change from 5.2.1;
an ordinary `EpochNotice` must never trigger it.

#### 5.2.1 Restore in single operation (stage 1b-2)

Restore is not a promotion, but needs the same protection steps against a returning old primary:

1. **Lock the old primary:** Fencing per 5.5. Before acceptance of a real adapter (gate 2) a shutdown with restart lock
   through the provider console documented by the recovery admin, with screenshot or API excerpt in the audit (F15),
   exceptionally suffices for a restore in single operation. For promotion this exception never applies. Without lock no restore.
2. **New authority:** A recovery register fixed at bootstrap on the independent recovery admin
   system holds the current authority and the only permitted successor decision per control Space.
   It lies outside the host/Space snapshots and is reachable via the out-of-band path. The recovery admin
   reserves in it atomically by compare-and-set the expected old authority, a unique `recoveryId`, the
   randomly new `authorityId`, the target host and its supervisor key. Only after this durable
   register commit is the transition signed. All authorized recovery admins use the same register;
   if it is lost or unreachable, restore remains locked. A second successor decision for the same
   authority is excluded, even if it would reach other members. Retries use the same
   transition; a register backup must not roll back an already assigned successor. The snapshot receives a new data incarnation;
   control `primaryEpoch`, `routerEpoch` and `policyVersion` begin at 1 in the new authority namespace.
   There is no numeric safety margin and no comparison with old authority counters.
3. **Lock access first:** All restored `PeerKey` permissions, group rules for A-only access,
   grants and unconsumed enrollment tokens are deactivated for the new authority. A lost
   revocation log can therefore not revive rights. The locally provisioned recovery admin confirms
   via the out-of-band access the first new admin and the required service keys; further roles
   are explicitly re-released/paired. Old active entries are audit material only, not a source of release.
4. **Switch members:** The recovery admin installs the same signed
   `AuthorityTransition {recoveryId, expectedAuthorityId, newAuthorityId, controlSpaceId, targetHostId,
   supervisorKey}` via the local recovery socket of every participating member. The member checks the locally
   provisioned recovery key and exchanges the accepted authority atomically by compare-and-set;
   the same transition is idempotent, a competing or rolling-back transition fails. The member
   stores the transition outside restorable Space snapshots and confirms it durably. Before the
   exchange, local mutations are halted and old sealed candidates are resolved per 7.2. For
   replicated data Spaces all admitted replicas confirm the transition, or a missing replica
   is fenced and excluded per 5.3.1; until then no member ACK. Data primary epochs begin at 1 in the
   new namespace; existing data/claims are preserved. Before the member ACK its external
   boot permission per 5.5 is also reconciled with the new authority and the confirmed local configuration.
   The same transition applies to the restored control Space; its old pending requests are never automatically re-sent.
   Offline members stay `recoveryBlocked`, receive no new grants and are not removed from search sets:
   complete queries continue to report unavailability. Only after local transition and ACK are
   they released. A snapshot alone must not reset this lock or the accepted authority.
5. **Journal gap and requests:** On the authority change every member invalidates old generations for new
   IDs (`IncarnationChanged`). Known results remain readable for newly authorized resolution per the deadline.
   Unsealed old router operations are cancelled locally; sealed candidates are resolved per 7.2,
   never aborted wholesale. Decided effects remain and are audited as `orphanedAfterRestore`
   with principal, request ID and available result or `ResultExpired`. Journal references present in the snapshot
   are reconciled against these claims; missing history becomes `needsReview` (5.1).
   A renewed functional order needs deliberate clarification and a new ID, no automatic replay.
6. **Release:** After fencing wait at least the maximum remaining lifetime of old grants/router leases plus
   time uncertainty; then start the router with the new authority in `recovering`. Release only for confirmed
   members and newly authorized principals. The old host returns exclusively after rebuild as snapshot
   receiver. Outstanding members and audit cases remain visible, but do not block independent work.

#### 5.2.2 Restore of a single data Space

If a data member loses its storage while the control Space and other members are healthy, the control authority
does **not** change. Only this Space receives a new data incarnation. The flow is a supervisor command
`restoreDataSpace {space, snapshotRef, recoveryId, targetHostId, expectedDataIncarnation,
expectedPrimaryEpoch, expectedReplicaConfigVersion?}` of the control primary with execution on the target host.
The supervisor journals and serializes the transition per Space against policy/replica changes; the same
recovery ID with the same arguments continues it, other arguments result in `RequestConflict`.

1. **Lock the old host:** Fencing per 5.5 or F15; without lock no restore. The member is `recoveryBlocked` until step 6;
   complete queries report it as missing. For a primary/sync member the fixed standby is to be checked first:
   An intact synchronous history is continued by promotion, not replaced by an
   older snapshot. If all synchronous copies are lost, all previous replicas are fenced
   and excluded; the restore explicitly starts in primary/single. F15 applies only to single restore
   before gate 2, not as a substitute for fencing an existing sync configuration.
2. **New data incarnation:** The snapshot is installed with closed admission under a new incarnation.
   `primaryEpoch` rises above the last confirmed value from control and external boot evidence, not merely
   above the older snapshot value. Missing or contradictory version evidence blocks the transition.
   The restore receives a new, higher local replica configuration version, if the Space has one.
   New local IDs use the new incarnation; restored entries keep their IDs.
3. **Generations and claims:** All request generations of the old incarnation become invalid for new IDs
   (`IncarnationChanged`). Claims contained in the snapshot remain retrievable per the deadline, but are marked as
   `restoredHistory` and can be queried historically only. A result already decided in them remains recognizable as
   the result at snapshot time; a request still open there has an unknown outcome today.
   **No old pending work is continued:** pending claims, waiters, registrations, follow-up jobs,
   txns and sealed candidates of the snapshot are audit material, not executable orders. Open claims
   receive a resolution lock `needsReview`, without rewriting their historical outcome as `cancelled` or `failed`.
   The new active copy releases old reservations/read locks locally, discards invisible
   txn writes and installs no old waiters, registrations or follow-up jobs. This is cleanup of a
   restored copy, not an abort on the lost original. A copied CommitIntent too is never applied again;
   7.2 applies to the intactly continued history, not to a lossy snapshot restore.
   Historical mailbox contents are marked accordingly; their old mailbox identity is not reactivated.
   New mailboxes receive new identities. Cleanup and audit happen crash-safely in budgeted
   steps with admission locked; release only after complete completion. `releaseRestored` releases only
   entries, never old claims or orders. A new functional order needs deliberate clarification
   and a new request ID.
4. **Quarantine of restored entries:** All restored payload entries of types with exclusive assignment
   (local, expand and primary; not lww/set) receive `restoredUnverified`. Internal control data, such as RunGates,
   is reconciled via its protected recovery path, not installed as freely takeable payload stock.
   The payload entries are readable, but neither takeable nor usable in txns.
   Release only by admin command `releaseRestored {space, recoveryId, scope}` with `scope` as
   type, run or entry list. The admin thereby decides functionally that renewed processing is permissible
   (e.g. idempotent sieve tasks); for non-idempotent tasks, deletion or manual clarification remains.
5. **Router and runs** (as soon as a router exists, from stage 2): The router marks all sub-requests to this member
   whose claims are open in the snapshot, lie after the snapshot state or are missing as `needsReview` (5.1).
   Historical results are adopted only as correspondingly marked evidence. Target bindings are preserved; there is no
   re-placement on other members. Run manifests with tasks on this member become `needsReview` until their
   controller has reconciled the complete recovery views ([operations 6](betrieb-und-mobile-steuerung.en.md)).
   Step 5 persists these locks; it does not wait for the later functional decision. Limited
   status/recovery calls remain accessible to the intended service role already during `recoveryBlocked`.
6. **Release:** The supervisors reconcile the new data incarnation, target replica, epoch and durability with
   the control Space and the external boot permission per 5.5. An unclear outcome stays `recoveryBlocked`;
   a snapshot must not reactivate the old routing/replica configuration on its own. Only after
   steps 1-5, this reconciliation and expiry of the remaining lifetime of old grants does the member accept remote work again.
   The old host returns only after rebuild.

A data restore is therefore always lossy; 2.1 limits the take guarantee accordingly.

### 5.3 Manual promotion (from stage 3)

No automatic choice on a mere timeout. One fixed standby per primary Space; supervisor on both hosts.

1. The recovery admin writes a signed request into the recovery Space **of the standby**: `authorityId`,
   expected `primaryEpoch` and `replicaConfigVersion`, target, recovery ID. Repetition is idempotent;
   competing transitions are serialized by local compare-and-set.
2. **Fencing evidence** per 5.5. Network timeout or a mere admin claim does not suffice.
3. Only the fixed synchronous standby takes over; it checks history and replication contract (7.2) as well as its
   host state `active` and its valid boot permission as standby for exactly this Space (5.5).
   Gaps or deviating permission → abort.
4. The supervisor raises the `primaryEpoch` of the Space atomically. Normal mutations stay locked until its external
   boot permission confirms the new epoch and role primary (5.5). If it is the control Space, it waits for
   expiry of the old `RouterLease`, raises `routerEpoch`, sends the `EpochNotice` (5.2) and starts the router
   initially in state `awaitingDurability` without a new lease. This local promotion/recovery commit is
   authorized by fencing and does not need the excluded old primary. Mutating requests carry authority and
   `primaryEpoch`; new requests with old values are rejected, retries of known claims answered per 4.4;
   unknown IDs of an old epoch are resolved exclusively per 6.2. A required
   negative decision stays pending until writable durability is restored.
   Router recovery with a new lease begins only after step 6.
5. The old host stays fenced. `release` lifts the lock only into **quarantine mode** (5.5): The host
   boots, its supervisor starts the affected Spaces exclusively as replica receiver without gate access
   for clients, without agents and without router. Only after complete synchronization via snapshot plus stream
   does it become the new standby after step 6 by `setStandby`. Release into quarantine happens only after completion
   of the switch to single, so that its fencing evidence remains valid. A process restart does not restore
   primary permission.
6. Without a standby able to confirm, sync writes stay locked. For recommissioning of the control
   Space the explicitly authorized switch per 5.3.1 is needed first; only in writable single
   operation can the router process `setStandby`. Whoever does not accept the temporary single guarantee
   stays offline. There is no implicit recovery `setStandby` and no circular command call.

#### 5.3.1 Standby failure and switch to single

If the synchronous standby fails, in normal operation or after a promotion, the primary can no longer
confirm anything. Because commands cannot be committed either, the switch runs over the recovery path **of the
primary**:

1. The recovery admin writes `RecoveryRequest {kind: "degradeToSingle", recoveryId, authorityId, space,
   expectedPrimaryEpoch, expectedReplicaConfigVersion}` into the local recovery Space of the primary. New
   mutations and reaper commits of this Space are halted for the transition.
2. **Fencing evidence for the previous standby** per 5.5. After promotion the excluded old primary is
   the counter-replica to be locked; its already verified, still valid evidence is used.
   Without lock no switch and no replica release.
   Addition 2026-10-17: For a standby without a fencing adapter, the revocation of its boot permission for
   this Space counts as lock ([procedure](_attic/abnahme/ap3-replica-control.en.md#degradetosingle-without-fencing-adapter)); for a
   promotion a real adapter remains mandatory.
3. **Complete the pending prefix:** The primary checks its local ordered history and the at most one
   sealed commit candidate from 7.2. Independent of the lost standby ACK this is applied exactly once with
   its stored deltas and claims and journaled as `recoveredCommitted`. A sealed candidate interrupted before
   sending is also completed this way; it must not be reinterpreted afterwards as a miss,
   cancel or lease expiry. A damaged/missing candidate or a prefix gap blocks
   the switch. Newly accepted work must not overtake it.
4. **Local atomic transition:** The supervisor raises `primaryEpoch` and
   `replicaConfigVersion` in the affected Space, sets its authoritative local replica configuration to `durability: "single"`,
   excludes the counter-replica and stores recovery ID/result in the same local commit. Recovery ID and
   expected versions secure repetition and concurrency. This is an explicitly fencing-authorized
   local recovery commit without standby; no transaction with the control Space.
   Before releasing local work the external boot permission of the primary is reconciled with the new versions
   and durability (5.5); an unclear outcome keeps admission locked.
5. **Reconcile control policy:** The supervisor holds a signed `ReplicaConfigNotice` with Space,
   authority, new versions, durability and recovery ID durably ready for pickup. The router adopts
   it idempotently in a separate control commit and raises `policyVersion`; this adoption may change exclusively
   the evidenced replica configuration. Until then, remote functional calls to this member are blocked with
   `ReplicaConfigPending`; status/recovery reconciliation are possible via the limited service role.
   Local work may continue after step 4 per the single guarantee. Old policy must never reset the local
   durability. If the control Space is unreachable, reconciliation happens later, no foreign policy is written locally.
   Addition 2026-10-18 (router steps across a transition):
   - `ReplicaConfigPending` is not a final error. A step rejected this way was never admitted; the router
     waits for the adoption. Afterwards it prepares it anew with current target, new generation and current
     policy version, but only if all policy versions since that of the step stem from notice adoptions.
     The same holds for a never-admitted step that the member rejects because of an older policy version
     (`StalePolicyVersion`). Any other policy change in between leaves the rejection standing (review).
   - A step that might have been admitted is never re-sent. After an adopted promotion or switch
     the router resolves it at the installed successor of its binding (same Space, same authority and
     data incarnation, installed epoch at least the bound one) with the bound epoch: the stored
     result or `NotCommitted` per 6.2. The binding of the step itself remains unchanged.
6. **Special case control Space:** Its own policy lies in the same local storage and is already adjusted
   atomically in step 4 with raised `policyVersion`. The supervisor can then issue grants and a new
   router lease; router change additionally waits for the old lease expiry and raises `routerEpoch`.
   It sends an `EpochNotice` and adopts further outstanding ReplicaConfigNotices at start.
7. From step 4 primary/single applies; from step 5 or 6 remote use is possible again. Return to sync
   only via `setStandby`: synchronize the target in quarantine mode, briefly lock all write sources including reaper
   and resolve existing sealed candidates, have the history confirmed up to the last decided
   commit, then install the new
   replica configuration with higher version and `primaryEpoch` durably on both replicas.
   The target confirms this configuration before its activation at the primary; an unclear outcome stays locked and
   is resolved via the same command/sub-request ID. After two-sided confirmation the executing
   supervisor sets the external boot permissions of **both** replicas to the new configuration, epoch and
   respective role (5.5). Only then may the target host switch from `quarantine` to `active`. Then reconcile policy
   as above and release writes. The previous primary too needs the updated permission;
   a restart between local commit and external reconciliation continues exclusively this transition.
   A standby change with a still intact sync configuration keeps the old standby bound until the confirmed new
   configuration; afterwards only the new standby may count as promotion target. The old replica
   must durably confirm its exclusion or be fenced before the new configuration is released.
   During the lock only the journaled configuration/recovery steps of this
   transition are allowed, no functional writes or lease renewals. The supervisors involved
   complete the already stored order even without a running router lease; their scope permits no
   other commands. This way the control's own standby change does not depend on a lease renewal during
   the write lock. `completed` only after configuration and policy reconciliation.

### 5.4 Recovery Space stays local

The recovery Space is not replicated. The independent recovery register from 5.2.1 serializes only
authority changes; it contains neither the recovery Space nor Space data and replaces no replication. It is the control path that must work when the control Space or
router have failed, and lies on the host that is to act: for promotion on the standby, for the
switch per 5.3.1 on the primary. If that host itself has failed, there is nothing to promote. A
replication would make the recovery path dependent on exactly the infrastructure whose failure it handles, and
would create split-brain cases of its own.

**Access independent of overlay and gate:** The recovery Space is reachable only via the local Unix socket of the
supervisor, not via `space-gate`. The recovery admin reaches it via an out-of-band access:
the console of the provider or hypervisor, or SSH over the public address with a dedicated key that allows only
the recovery command (`command=` restriction). The request itself is signed with the locally provisioned
recovery admin key (4.3). This way recovery also works with failed NetBird management, with
expired layer A cache and without a control Space. This access is the evidence for gate 1.

### 5.5 Fencing

Fencing has two levels:

1. **Data (always effective in primary/sync):** The old primary can confirm nothing without standby confirmation,
   and the promoted standby no longer confirms an old `primaryEpoch`. Confirmed double effects on replicated
   data are thereby excluded, as long as there is no silent fallback to asynchronous operation.
2. **Processes (mandatory for promotion):** The old primary might continue to deliver stale reads, operate agents
   and trigger external effects. Evidence is therefore needed that it is stopped and locked against
   automatic restart.

```ts
interface FencingAdapter {
  readonly kind: "power" | "hypervisor" | "cloud" | "container";
  fence(hostId: string, reason: string): Promise<FenceProof>;     // stoppen UND Neustart sperren
  verify(proof: FenceProof): Promise<boolean>;                     // vom Supervisor unabhängig nachgeprüft
  release(hostId: string, mode: "quarantine"): Promise<void>;      // nur in den Quarantänemodus (5.3 Schritt 5)
  readBootState(hostId: string): Promise<HostBootState>;
  compareAndSetBootState(hostId: string, expectedVersion: number, next: HostBootState): Promise<HostBootState>;
}
type FenceProof = { hostId: string; kind: string; observedAt: number; evidence: Json; restartLocked: boolean };
type SpaceBootPermit = {
  state: "active" | "revoked";
  authorityId: string; dataIncarnation: string;
  role: "local" | "primary" | "standby" | "entryReplica";
  primaryEpoch?: number; replicaConfigVersion?: number;
  durability?: "single" | "sync";
  transitionId: string;
};
type HostBootState = {
  hostId: string; version: number; state: "active" | "fenced" | "quarantine";
  spaces: Record<string, SpaceBootPermit>; // Schlüssel ist die stabile spaceId
};
```

- Only adapters are permitted whose state the supervisor queries itself via an independent interface:
  switchable socket/PDU, IPMI/BMC, hypervisor or cloud API, container runtime on a *different* host.
- `restartLocked` must be fulfilled (e.g. socket stays off, VM disabled, restart policy removed). "Power
  off" alone does not suffice.
- `release` is not circular: There is no general release, only quarantine mode.
- **Boot attribute:** Every host has a versioned `HostBootState` stored outside the host
  (e.g. cloud metadata or recovery register with independent API). The host lock is global; authority,
  data incarnation, role and replica version are kept **per Space** in `spaces`. `version` protects the
  atomic compare-and-set of this register, it is not a `replicaConfigVersion`. Changes to Space A preserve
  the confirmed permissions of Space B; competing transitions re-read after a CAS conflict.
  The supervisor reads and checks the state at every boot:

  | State | set by | Boot behavior |
  |---|---|---|
  | `active` | provisioning; after confirmed synchronization by `setStandby` | each Space starts only with exactly matching own boot permission and local configuration |
  | `fenced` | `fence` (promotion, 5.2.1, 5.2.2, 5.3.1) | host stays off; if it starts anyway, no Space and no gate; all previous Space permissions are revoked |
  | `quarantine` | `release(…, "quarantine")` | replica receive only, without gate access, agents and router (5.3 step 5) |

  Fencing also sets every previous Space permission to `revoked`; the last version values remain in the
  independent register/audit and must not be rolled back by a snapshot or an older register backup.
  Only a new confirmed transition installs an `active` permission again.
  The global host state `active` alone does not lift a Space revocation.

  If the host state is missing or unreadable, no Space starts writing. With valid `active`
  a missing or deviating Space permission blocks only this Space; other confirmed Spaces stay usable.
  For first start and creation of further Spaces the authorized provisioning installs, before admitting normal
  work, the permission matching the locally prepared configuration. A mere process restart or repeated
  script apply must not restore a revoked permission.

  `release` keeps the host in quarantine; old permissions are not revived. `quarantine → active`
  is permissible only at the end of `setStandby`, after confirmed synchronization and installation of the new
  permissions. Other Spaces of a fenced host each need a confirmed transition of their own;
  the release of a standby does not reactivate other old primaries.

  **All role/version changes** (promotion, switch to single, `setStandby`, control/data restore)
  journal in advance the expected register state, target configuration and stable transition ID. They reconcile the
  external permissions of all further admitted replicas; an excluded replica confirms the
  revocation or stays fenced. Before normal write release, local configuration and external evidence must
  match exactly and the Space permission must be `active`, including authority,
  data incarnation, role and existing version fields. For primary/standby epoch, replica version
  and durability are mandatory fields, not optionally omittable checks.
  There is no atomic transaction with the provider API: After a crash or ACK loss the same transition is
  resolved via local and external evidence. Until then no functional mutations, grants or lease renewals
  of the affected Space. The local recovery access stays open; narrowly limited, already journaled
  configuration/recovery steps may continue the reconciliation, never independent work. A promotion target
  needs a matching standby permission beforehand; before activation it needs the matching primary permission.
- A marker-file adapter is permitted **only in the simulator**; it is a claim, not evidence.
- Which adapter is used depends on the hardware of the hosts (open question F1, gate 2).

## 6. Building blocks

### 6.1 Core extensions (doc version 5)

1. **Revision** per durable commit; a batch contains all deltas of a commit; cursor only between batches.
   Every batch is smaller than a frame due to `maxCommitBytes` (4.2); the byte limit of `changes` ends a
   reply only between batches, at least one batch is always delivered.
   Stream ID = Space + history incarnation (+ `primaryEpoch` for primary); revisions of different streams are not
   comparable.
2. **Two replication purposes:** entry stream (put/delete, lease changes, conflict metadata) for lww/set;
   complete atomic commit history (txns, locks, waiters, mailbox, RPC claims, router documents) for
   primary. Applying on replicas creates no second business operation and no events.
3. **Snapshot:** immutable with token, stream ID, revision R; all pages belong to R and are byte-bounded
   (6.2, page sizes); `changes` begins after R.
   Retained in a bounded way; expiry → `SnapshotExpired`. Replication snapshots contain tombstones and
   deduplication; installation atomic.
4. **Identities:** `hostId`, `spaceId`, `replicaId`, incarnation; `view()` returns `gid`.
5. **Peer targets:** structured principals and consumer mailboxes besides conversations. Events remain until ACK/TTL.
   An expired take txn is released; a later delivered event grants no reservation.
   Receivers check the txn state before processing.
6. **Rights:** central check per operation and type including supertypes, lease intervention, take, snapshot, stream.
   Remote host access is not quota-free.
7. **Keys:** mandatory per lww type, canonical encoding `type + keyFields`; missing fields → error.
   Upsert conflicts with active txns → error.
8. **Internal follow-up effects:** reaper/settle processes expiry events in deterministic order
   with durable progress cursor and batches below `maxCommitBytes`. Overdue work is caught up completely before a
   public operation that depends on it; the latter returns `pending` meanwhile, no
   functionally wrong snapshot. A single txn abort/commit remains indivisible and must already be covered by
   the budget from 4.2. Larger notify/waiter fanouts are processed by a follow-up job stored atomically with the cause
   in bounded, idempotent steps. Its cursor, payload data and
   result/mailbox reservations are budgeted before acceptance. Later conflict operations must not overtake a
   required earlier step; reservation and take result still arise atomically.
   Maintenance has reserved space for completion/abort; normal writes must not consume it.
   When the follow-up work budget is exhausted, new causing operations are rejected before acceptance.
9. **Preconditions:** B1 (ID templates), L7 (total bytes), L13 (cursor), L11 (meter per Space).

### 6.2 Service `space`

Every call names the stable Space ID (resolve aliases beforehand). Arguments are validated. Mutations carry
`requestId`, request generation, `authorityId` and, for primary, the `primaryEpoch`. Relative times are translated
once into a server-side deadline on the first accepted call.

| Method | Essential arguments | Reply |
|---|---|---|
| `hello` | protocol version, features | IDs, `primaryEpoch`, limits, role, features |
| `write` | entry, lease, txn?, request | entry ID, lease |
| `read` / `take` | template, total timeout, `ifExists?`, txn?, request | `pending` or durable `done(entry \| null)` |
| `pollOperation` | own call identity, `targetRequest`, `waitMs ≤ 25000` | current operation state; renewal only per 4.4 |
| `cancelOperation` | `targetRequest`, own mutation request | cancel result or already sealed/decided state |
| `readAll` | template, snapshot token?, cursor?, limit, `maxBytes` | entries, next, token, stream ID, revision |
| `count` / `stats` | template? | value plus revision; federated plus completeness (7.1) |
| `txn` / `lease` | action, ID?, duration?, request | state/lease |
| `wait` / `notify` | template, durations, consumer, handback, request | ID, lease |
| `events` | mailbox, `mailboxEpoch`, cursor, `waitMs ≤ 25000`, `maxBytes` | events, next or explicit gap |
| `ack` | mailbox, `mailboxEpoch`, `upTo` | idempotent |
| `changes` | stream ID, `afterRev`, `waitMs ≤ 25000`, byte limit | commit batches or `resync` |

**Functional arguments and frame:** A request consists of immutable **functional arguments**
(method, template/entry, lease, timeout, txn ID, target reference) and a **renewable frame** of
`authorityId`, `primaryEpoch`, delegation, grant, transport and poll parameters. Only the functional arguments
enter the `argumentHash`. A retry with an updated frame therefore hits the same claim; a
changed functional component results in `RequestConflict`. The frame is checked anew at every call, but a
known claim is answered even after promotion (4.4).

**RPC claims:** Key `(principal, spaceId, requestGeneration, requestId)`; stored are method,
canonical **argument hash** of the functional arguments (no plaintext arguments), one-time deadline, state `pending | done | cancelled`
and the **result durably** in the same commit as the operation. Deviating reuse → `RequestConflict`.
A retry returns the stored result without mutating again. Generations are bound, besides principal/Space,
to authority and data incarnation; the claim namespace thus stays unique after restore.
Historical restore claims are resolvable only per 5.2.2, never continuable as active pending work. Before the actual sync
commit a claim can be marked `pending/commitSealed` (7.2); cancel can then no longer force an unsuccessful
decision. Transport timeout is never such a decision.

The result must be stored durably: A take removes the entry; if the result lay only in memory,
the entry would be lost after a restart (acceptance stage 1). Data protection is
achieved through minimization and deadlines, not by omission:

- Arguments only as hash; results contain only what the caller receives anyway (e.g. the taken entry).
- Completed results at least 24 h, at most 7 days (start value 24 h), then deleted; only the
  hash entry remains at least until the end of admission and result deadline (below). A retry with a known ID after result erasure
  returns `ResultExpired` (outcome was decided, content no longer retrievable), an unknown ID after expiry
  of the generation `RequestExpired`; neither case mutates. The generation lifetime is therefore at most
  so long that its hash entries fit into the claim budget (gate 4).
- Internal claim/journal documents are readable only for narrowly authorized service roles. Principals
  receive through operation and mailbox endpoints only their own permitted status/content; even an observer
  may retrieve own read/notify results, but no internal documents or foreign results.
  After rights withdrawal the `resolution` rules from 4.3 apply.
- An erasure request for the contents of a principal covers entries, claims and mailbox events together (open question F9).

**Poll semantics:** The transport wait time of 25 s ends only the poll, creates no miss and extends no
deadline. `null` is final as soon as the operation ends unsuccessfully by its semantics; a new attempt receives
a new ID. This also preserves the `ifExists` semantics.

**Request generations:** server-side signed, bound to principal/Space, fixed admission deadline. After expiry
IDs unknown within them are rejected with `RequestExpired`, even after claim cleanup. Known claims
remain accessible for retry, poll, cancel and authorized continuation; delegations check this exception
explicitly (4.4). Pending claims are never deleted by generation expiry. Result deadlines begin only at
completion; hash entries are preserved at least until the end of admission deadline and result deadline.
After that `RequestExpired` instead of `ResultExpired` is permissible, never a new effect. New mutating
follow-up calls obtain a current generation of their own; the referenced original generation may have expired.

**Admission resolution at the unchanged primary (`resolveOperation`):** The
router can resolve an own journaled request by generation,
request ID, original method and argument hash. Known claims
are returned only after checking this binding; pending claims keep
their previous deadline/authorization check. A missing claim may return
`notAdmitted` only if the signed generation is still valid, belongs to
principal, Space, authority and data incarnation and was issued for exactly the
current primary epoch. Generations without this historical
epoch binding, restore/authority transition and lost or expired
generations provide no evidence. Rights, current policy and router/
control epochs are re-checked on delegation and in the serialized host access.
The existing boot/fencing contract remains a prerequisite of the host.

The reply binds Space, authority, incarnation, primary epoch, generation,
request ID, method and argument hash. The router checks all fields against
its unchanged child journal entry and may re-send only this request with
**the same ID, generation, arguments and the same target**.
A late original call can still arrive first; both then hit
the same atomic claim. Therefore `notAdmitted` is no terminal
negative claim, no `NotCommitted` and no permission for a new ID or
another member. In particular this reply proves nothing about old
primary epochs. For that, exclusively the promotion evidence below applies.

**Resolution of unknown IDs after promotion:** After authentication, current rights check and check of the
target reference this order applies; an error never alone authorizes an automatic substitute request:

1. Other authority/data incarnation or lossy restore: `IncarnationChanged`; an existing
   historical claim remains readable exclusively as evidence, open/lost outcome becomes `needsReview`.
2. Matching known claim, including claims of a sealed candidate: check method/argument hash,
   then return stored result, `ResultExpired` or pending state. Generation expiry does not delete an
   existing evidence; it does however permit no new functional mutation under an unknown ID.
3. Missing claim and unknown or expired admission generation: `RequestExpired`, not `NotCommitted`.
   A missing hash after permitted cleanup proves no unsuccessful outcome.
4. Missing claim in a retained, still valid generation and older `primaryEpoch`: `NotCommitted` only
   if the history has been continued losslessly since issuing the generation, all accepted claims and
   decided effects of this generation are preserved, all sealed candidates were checked
   and all earlier replicas as possible write sources are excluded. The promotion evidence binds
   this coverage to Space, authority, data incarnation, generation and earlier epochs. Evidence missing or
   incomplete: `OutcomeUnknown`, associated router work `needsReview`, no automatic substitute.

Before returning `NotCommitted` the current primary persists a terminal **negative claim** for the
original claim key, method and argument hash, with result `NotCommitted` and promotion evidence.
It is subject to the same durability, budget and retention rules as other decided claims. Check and
negative claim arise serialized against acceptance/sealing of the same request. A late original
call, even with an updated frame, hits this claim and can no longer produce an effect. Without
durability able to confirm this resolution stays pending; a mere read miss is no negative decision.
Only this durably decided result allows the client a new request. A candidate only locally sealed,
never accepted at the standby may be missing on loss of the primary storage; fencing prevents its
later effect. All effects accepted at the standby and all confirmed effects, on the other hand, are preserved.

**Page sizes:** Snapshot pages, `readAll`, `events` and `changes` are bounded by **encoded bytes**,
not only by count. The limit is `min(maxBytes of the caller, frame minus protocol overhead)` and covers
elements, metadata, cursor and token. A page ends only between whole elements; `next` points behind the
last delivered element. Because `readAll` is bound to a snapshot token (revision R) and `events`/`changes` to
sequence or revision, paging produces neither gaps nor duplicates. Every non-empty
page delivers at least one element. A single element always fits: Entries are bounded by `maxEntryBytes`,
commit batches by `maxCommitBytes` and events by `maxEventBytes` (entry plus event metadata, smaller than
a frame); a write, notify or take whose event would exceed this limit is rejected before acceptance with
`ResourceExhausted`.

`maxBytes` must be a positive integer; without it the frame budget applies. If the effective budget does not
suffice for the next whole element including metadata, cursor and token,
`ResponseBudgetTooSmall {requiredBytes}` is returned instead of an empty progress page. Cursor, ACK state and functional
operation state remain unchanged. The client repeats with a larger budget and the same snapshot token
or cursor; if the snapshot has expired meanwhile, `SnapshotExpired` applies. `requiredBytes` does not exceed
the frame budget: The element limits also reserve the complete reply overhead. Otherwise
there is a protocol/configuration error, which is not circumvented by exceeding the frame limit.

**Mailbox:** ACK only for the authenticated consumer, matching `mailboxEpoch` and already delivered sequences; only
contiguous prefixes. Old ACKs delete no new events after a reset. TTL loss is reported as a gap.
ACK confirms transport takeover, not a take commit.

**Backlog:** separate byte/count limits for entries, claims, journal, mailbox, snapshots, stream; maximum
pending operations per principal and transport peer; reserve space for result/claim before the mutation.
Overload → `ResourceExhausted` before acceptance. Mailbox at most 7 days plus byte limit; on reaching it, new
affected operations are rejected instead of losing active take results. Replication backlog blocks
synchronous writes. Rate limits also for enrollment, reads, polls, txns, ACKs.

**Local implementation and recovery (stage 1):** The claim still stores only the argument hash,
deadline and reserved result space. A separately persisted RPC waiter stores template, take/read,
txn and fixed deadline as execution state. This lets the host decide after reopen without needing a
still-running original caller; this is not a storage of raw arguments in the claim.
Immutable snapshot tokens are host-local in stage 1, bound to stream/query/owner and bounded
(TTL 60 s, 16 snapshots and 64 MiB per Space). Reopen or eviction results in `SnapshotExpired`.
`count`/`stats` and the revision delivered with them come from a shared snapshot.

On mailbox TTL loss a new `mailboxEpoch` arises with a gap to the lost prefix. The retained
suffix keeps its sequence numbers; the server delivers the start cursor of the new epoch. An old
ACK can delete no new events. Unconfirmed lost take events put the take txn into a
durable release queue processed under budget limits; confirmed deliveries remain dependent on their separate
txn decision. Physical deletion of an already ACKed prefix happens in bounded
maintenance commits. ACK confirms receipt, never task completion.

### 6.3 `RemoteSpace`

Common `SpaceLike` interface with capability flags for mode limits. `RemoteSpace` holds request ID and
arguments until completion, repeats transport attempts and polls the same operation.

- **Client wait limit** (`maxClientWaitMs`, optional): ends only the *waiting* of the caller with
  `OutcomeUnknown {requestId}`. The operation continues server-side until its own deadline and remains
  queryable via the request ID or abortable via `cancelOperation`. There is no blanket default, because
  `space_wait`/`FOREVER` are legitimate long operations.
- No automatic extension of deadlines. Browsers use the gateway.

### 6.4 `FederatedSpace`

```ts
type Rule =
  | { type: string; mode: "local"; member: string }
  | { type: string; mode: "expand"; members: string[]; by: "type" | { field: string } | "capacity" | "capability" }
  | { type: string; mode: "sync"; variant: "primary"; member: string; primaryReplica: string; replicaConfigVersion: number;
      durability: "single"; backupReplica?: string }          // optional asynchroner Snapshot, nie Promotion
  | { type: string; mode: "sync"; variant: "primary"; member: string; primaryReplica: string; replicaConfigVersion: number;
      durability: "sync"; standbyReplica: string }            // Standby Pflicht
  | { type: string; mode: "sync"; variant: "lww"; members: string[]; keyFields: string[]; semantics: "state" }
  | { type: string; mode: "sync"; variant: "set"; members: string[]; semantics: "facts" };
type CompletionProfile = {
  taskType: string; resultTypes: string[]; equalFields: string[];
  maxResultBytes: number; maxResultCount: number; maxLeaseMs: number;
};
type Policy = {
  authorityId: string; policyVersion: number; rules: Rule[];
  completionProfiles: CompletionProfile[]; // erzwungene Task-Abschlüsse, immer und auch während drain
  default: { mode: "local"; member: string };
};
```

- **Completion profiles:** In stage 1 (without policy) a `CompletionProfile` is stored as local configuration of the Space;
  from stage 2 the profile from the policy replaces this transitional configuration. If a task type has a `CompletionProfile`, the member checks **every** commit of a txn
  that destructively takes such a task: For each taken task between 1 and `maxResultCount`
  results of the `resultTypes` with equal `equalFields` must be written in the same txn, within
  `maxResultBytes`; profile-related validations (for the sieve exactly one `SieveResult` with `rangeStart`/`rangeEnd`
  of the task) apply as well. Otherwise the commit fails with `CompletionViolation`, and the txn remains
  abortable. A take without result is permissible only via a separate admin command `purgeTasks` (own scope,
  audit). So "atomic task/result completion" is a server property, not only a property of
  correctly written workers.
- `semantics` is a mandatory field for explicit confirmation: lww only for state (sensor values,
  configuration, status), set only for facts/observations. For jobs, one-time actions or payments
  both are impermissible; expand or primary applies there.
- `primaryEpoch` per logical Space. In v3 primary covers the whole member including internal documents;
  all type rules of a member have the same replica configuration. Control data including capability remain
  uniformly primary.
- **Mode limits per member:** A member with primary replication may occur in v3 only in `local` and
  primary rules. If it additionally appears in an expand rule, that would be the RAID-10 case (7.3). If it appears
  in an lww/set rule, the same entries would run over two replication paths. The policy validation rejects both.
  Members of expand and lww/set rules have no primary replicas.
- Exactly one rule per type; supertypes in the template extend the search to all affected rules.
  Managed rules optionally declare `supertypes: string[]` for this; the router forms the acyclic
  transitive closure. Managed entries must not smuggle in undeclared supertypes. Writes carry the
  complete declared closure; members check it as well. The hierarchy of existing types remains
  immutable like their placement, so that searches do not overlook an already existing stock. `local` means
  the explicitly named member, never implicitly the host of the client.
- Direct member accesses check the same mode, rights and routing limits; managed expand types may
  not be written directly outside their member.

**Router journal:** before the first remote call: logical request, principal, policy version, targets,
sub-request IDs, request generations of the targets, deadline. A begun operation changes neither member
nor policy on timeout; its follow-up operations carry the original policy version (4.4). Remote
results are adopted durably before client reply or ACK.

**Waiter race:** all registration IDs and one generation per attempt are journaled. The first still
active reservation becomes the winner atomically; losers are cancelled/aborted, even on late events. Replay
does not change the winner. Without a user txn the router commits the winner txn with a stable sub-request ID.
With a user txn work happens only on its member; a txn returned by `space_wait` explicitly belongs to the
original principal. After a restart, open states are resolved via the same sub-requests; an
unclear commit is resolved, never replaced by a second winner.

## 7. Modes

### 7.1 expand

- **write:** type → fixed member; field → HRW over the fixed member set. The input of the HRW hash is only
  the canonical encoding of the field value, not the type. Rules with the same field and the same member set
  therefore place equal values on the same member (e.g. task and result with the same `taskId`); capacity/capability → selection before
  the first attempt, durably bound in the journal. Outdated capacity data leads to rejection, not to
  silent secondary placement. Re-planning only after a clearly rejected attempt.
- **read:** first hit; miss only after a miss of all relevant members; on failure without hit `Unavailable`.
- **readAll/count:** Default: error if a relevant member is missing. Option `allowPartial`: result with
  `complete: false`, `missingMembers` and revision per member. Option `waitForComplete {timeoutMs}`: repeats
  with bounded backoff until complete or timeout. **There is no federation-wide consistent snapshot**;
  the revisions per member make visible which state was read.
- **take without waiting:** sequential search; resolve an unknown outcome first, only a confirmed miss allows
  the next member. Progress journaled.
- **waiting take:** waiter race (6.4).
- **Transactions:** bound to one member before beginning; deviating rule → `RoutingConflict`.
- **Failure:** stock temporarily unreachable; without backup lost on storage loss.

**Membership:** The HRW set, key field and fixed type assignment of an existing stock are immutable in v3.
`addMember` registers hosts and permits new, empty rules; it changes no existing
assignment, not even "for new data only", because targeted reads by field would otherwise ask the wrong member.
`removeMember` requires proven emptying including open operations.

**Admission of a Space with existing stock:** Before admission `addMember` checks the content of the Space including
invisible txn writes, waiters and claims. If it contains entries of a type that the policy assigns to another member
or to an HRW set without this member, the command is rejected with `RoutingConflict` and the list of
affected types. Allowed are only stocks of unregulated types (which then receive a new rule with exactly
this member) and empty Spaces.

**HRW members:** Since the HRW set is immutable, an HRW member can neither be removed nor replaced by another.
`drain` on an HRW member rejects new placements for its key share with `MemberDrained`
(bound completion writes under the following drain contract remain allowed),
instead of placing them elsewhere; `removeMember` is rejected for it with `MigrationRequired`. In v3 only members with a fixed
type assignment (after emptying) and members of capacity/capability rules are removable.

**capacity/capability sets:** `setPolicy` may **extend** the member list of a capacity/capability rule,
because there selection is journaled and not computed from the key; earlier locations stay in the
search set. Shrinking only via drain plus emptying.

**drain:** The member persists `draining` and an admission boundary. New independent placements are
locked, existing reads and takes remain reachable. Already accepted operations keep their target.
A txn begun before the boundary may execute follow-up writes on the same member within its reserved completion budget.
A take txn begun after the boundary may work off existing tasks; for this the
member grants on a successful take a completion permission bound to principal/txn/task with finite lease,
permitted result types and byte/count limit. These completion profiles are part of the validated type policy, apply
per 6.4 to every completion anyway and must be fixed before drain; for the sieve only `SieveResult` with the same runId/taskId, no new `SieveTask`.
Without a matching profile no new processing take txn may start during drain; pure destructive takes
for authorized emptying remain possible. Free writes or unlimited lease extensions are not
completion work. Direct accesses and local workers are subject to the same admission boundary.

An abort happens via `cancelOperation` **at the member**; the actual result is adopted.
A journal is never unilaterally `cancelled` on an unknown outcome. With capacity/capability earlier
locations stay in the search set until removal.

**Final removal:** After drain `removeMember` first executes `freezeForRemoval` at the member
(internal idempotent step, no general admin shell). `removing` locks all new functional
mutations, take claims, txns and registrations also locally; running work must be decided or
aborted beforehand. Only limited maintenance, status and result retrieval remain allowed. The member confirms
`EmptyProof {spaceId, authorityId, removalId, admissionVersion, revision}` only when there are no entries including
invisible writes, txns/locks, waiters, **active notify registrations**, follow-up jobs and open
operations. `freezeForRemoval` ends existing notify registrations in an orderly way: Each receives as last
event `registrationClosed {reason: "removing"}` in its mailbox and is then considered ended. Pending
mailbox events including this closing event remain retrievable via the stored Space ID until ACK or TTL; they do not count as active registration. Protected completed
claims/audit data may remain per the deadline. The router additionally checks its open sub-requests,
worker/run bindings and routing references and then removes membership and affected empty rules in one
control commit; the default rule needs a valid remaining target for this. Only afterwards does it confirm
`detached` to the member. On a crash the local lock is preserved; retry uses the same removalId.
Withdrawal of the lock is allowed only after authoritative proof that the removal was not committed.
On an unknown outcome no local release. Result retrieval via the stored Space ID remains possible
until the end of the deadline; archiving/deletion must not silently shorten this deadline.
For admission of an existing Space the same local lock applies during stock check and activation;
competing local writes must not overtake the check from 7.1.

**Migration** of existing stocks is a later feature (versioned routing tables, transfer journal,
transitional reading, ownership handover). `take A → write B` is not a safe procedure. Until then changes
requiring migration are rejected.

### 7.2 sync

| Variant | Use | Guarantee |
|---|---|---|
| primary/sync | control Space (from stage 3), jobs with HA | one active primary; without standby no confirmation; promotion per 5.3 |
| primary/single | single host, optional asynchronous snapshot | locally atomic; lossy restore per 5.2.1/5.2.2 instead of failover |
| lww | state with key | deterministic convergence including versioned deletions |
| set | facts/observations | observed-remove set, add-wins; no exclusive assignment |

**primary:** Per Space there is one complete ordered commit history and at most one sealed candidate
not yet applied locally. Before sealing the primary checks rights, deadlines, leases,
conflicts and all completion budgets. It then persists `CommitIntent {authorityId, primaryEpoch,
revision, previousHash, batchHash, deltas, claims, validatedAt}` atomically and durably **before** sending.
Sealing fixes the content irrevocably, but is not yet a visible success confirmation; later
mutations, cancel, revocation or reaper must not change/overtake this candidate. Clients see
`pending/commitSealed` and must continue to query the outcome.

The standby accepts only the gap-free next intent of the same configuration and persists the batch before
the ACK. Batches accepted there count as decided and are applied on promotion. At the primary
a commit becomes visible/answered only when the standby has confirmed and the primary has applied locally.
The history of the standby contains all batches accepted there and thus all confirmed effects.
A candidate only locally sealed, not yet accepted, can be missing on loss of the primary storage.
Unknown IDs of older `primaryEpoch` are answered with `NotCommitted` only after the evidence, the check order and the durable
negative claim from 6.2; claim cleanup or restore do not permit this conclusion.
After a restart the primary asks the standby for revision/hash: present identically → apply locally;
not yet present → send the same candidate; conflict/gap → block. Without standby no normal
confirmation. Only after verified fencing may 5.3.1 complete the stored candidate locally.
This is recovery of the already sealed effect, not a new business operation with a re-checked deadline.
Before sealing, deadline expiry and cancel remain regular possible decisions.

Replicas deliver only reads marked as possibly stale; consistent reads and takes go to the primary. No silent
fallback to asynchronous. Snapshot plus stream and the configuration transition from 5.3.1 set up standbys.
The local versioned replica configuration is authoritative for commit/promotion; the FederationPolicy is
its routing image and must not overwrite it in case of a version lag.

**Entry replication (lww/set):** every change has the immutable ID `(originReplicaId, incarnation, seq)`.
Forwarding preserves ID, owner and metadata and creates no new change. Dedup/causal state is durable
and part of the snapshot. Replicators have a narrowly limited import path; normal writes cannot set this
metadata.

**lww:** per key the lexicographically greatest `(hlc.physical, hlc.logical, replicaId)` wins. HLC state survives
restarts. **Delete is a tombstone with its own, regularly assigned HLC version**; it wins against older puts
and loses against newer ones. A tombstone with a fixed minimal version would be wrong, because every old put would
overwrite it. HLC guarantees order, not the physically newest measurement; `asOf` remains a business date.
Clocks too far in the future are rejected and reported.

**set:** every add creates a unique tag; remove/take removes only observed tags; concurrent adds
remain (add-wins). `SpaceLike` rejects exclusive txns for such rules.

**Leases with lww/set:** Expiry is transferred as the immutable origin deadline of the respective version;
forwarding does not renew, renewal creates a new version. **Natural expiry hides only the
expired version** and creates no tombstone, so that a newer renewal on another replica is not
deleted. With lww only the winning version is ever visible; if it has expired, the key counts as
not present. Older, not yet expired versions **never** become visible again, otherwise outdated
state would revive. Only a newer version (put or renewal) makes the key visible again. Expiry can be visible differently within the time uncertainty; when the
uncertainty is exceeded, time-critical operations are locked. Lease expiry does not stop an externally still running worker.

**Tombstones and offline replicas:** Conflict/remove metadata remains durable in a budget of its own; on
reaching it, new changes are rejected. No time-based cleanup. Compaction only after a confirmed
common causal state of all active replicas. Permanently removed replicas only after rebuild with a new
incarnation; old offline changes are not automatically replayed.

### 7.3 RAID-10 case

expand by field, per partition primary/sync. Not in v3; only after stable 7.1 and 7.2.

### 7.4 Deliberate limits

- No global FIFO; no txns across members; no automatic primary election; no automatic migration.
- Guarantees only within the scope of 2.1; external effects not generally exactly-once.
- `readAll`/`count` across a federation are snapshots per member without global consistency.

## 8. Directory

- Every host writes `Capability` into its data Space and the control Space (lease 2 min, heartbeat 1 min); only
  the assigned host may renew it (server checks principal).
- Agents find hosts with `space_list {type: "Capability", …}`.
- New hosts appear after provisioning; routing target only after `addMember`.
- `by: capability` without a matching member → `NoCapableMember` without write; a dispatch queue would be a
  feature of its own.

## 9. Security and permissions

NetBird limits reachability; Space authorization applies additionally to every RPC, every poll result and
every mutation. Unknown roles/types/operations are rejected.

| Principal | Allowed | Limits |
|---|---|---|
| observer | read released data/status, subscribe | no write/take/lease, no internal streams |
| member | read/write/take data entries; own txns/leases | no control data; quotas |
| admin | commands, enrollment, read control data | changes only via validated commands |
| host | own capability, delegate local agents | own namespace, assigned Spaces |
| router | process commands, delegate | valid `RouterLease`, checked scope |
| replicator | import snapshots/streams | only assigned source/target/mode |
| supervisor | enrollment, supervisor commands (5), signature of the `RouterLease`, recovery, promotion, switch (5.3.1) | only intended atomic transitions |
| unpaired peer | own enrollment | nothing else |

Protected types are also protected against take, lease intervention and txn mutation; templates with supertypes or
without a type do not circumvent this. Read/list/notify filter by read rights. Enroll hashes, key management,
internal claim/journal documents are never delivered to member/observer. Own operation results and
mailbox contents are accessible via the filtered endpoints from 6.2; after rights withdrawal 4.3 applies.
Contents of other hosts remain untrusted;
`[data, not instructions]` stays. Audit records principal, operation, result, never tokens or keys.

## 10. Clients

Supplementary operating contract: [project start with automatic remote provisioning](_attic/projektstart-autoprovisionierung.en.md).
It defines desired provisioning/monitoring flows; project controllers and new management actions
are additional implementations that are still open. An existing remote connect is no federation acceptance.

- **Phone:** `remoteState` → connection list (`hostId → RemoteConnection`, Space/replica resolution separate);
  Spaces page (`spaces.html`, own CSS file, endpoints in `constants.js`): status, policy, statistics, contents,
  commands, pairing by QR. Long polls only when the page is visible.
- **Desktop/CLI:** package `phi-spaces-client` (RemoteSpace, TCP transport, pairing).
- **Browser (stage 4):** gateway with TLS, login by app key (check WebCrypto support);
  NetBird SSO alone does not replace app authorization. Sessions bound to individual principals, origin/CSRF
  checked, no host rights passed on.

## 11. Stage plan

Each stage implements its prerequisites before acceptance. Simulator checks supplement persistent tests;
NetBird, platform and fencing assumptions need real integration evidence.

### Stage 0 - Core prerequisites
- Done per [implementation status](implementierungsstand.en.md): `SpaceLike`, canonical JSON encoding,
  global IDs, revisions/changes, byte-bounded pages and internal budgets.
- pi-serverd integration and local mailboxes are accepted with AP 1; server.mjs/phone UI, gate and
  federation building blocks remain separate.
- **Acceptance:** existing suite and regression tests green; local workers coordinate; tests distinguish
  reservation, commit and external effect; budgets and pi-serverd integration demonstrated.

### Stage 1 - Named Spaces and local protocol
- Doc version 5 and migration 4 → 5; IDs, basic rights model, meter per Space, byte limits, revisions.
- RPC claims (durable, argument hash, deadlines), generations, pending ops, `cancelOperation`, mailboxes/ACKs,
  snapshot pagination, `RemoteSpace` with client wait limit.
- **Acceptance:** two Spaces without ID collision; take commit with lost reply returns after process restart
  the same result without a second take; RPC claims contain no copied plaintext arguments (entry data
  and required pending operation state remain regularly persistent); long polls, claim expiry,
  `RequestExpired`, wrong arguments, old ACKs checked; migration fixtures preserve entries, txns, outbox.

### Stage 1b - Overlay, authorization, enrollment
- Gate with limits, `maxCommitBytes` and service allowlist; layer A/B with connection-bound challenge;
  complete type/operation ACLs.
- Control Space single plus asynchronous snapshot and restore per 5.2.1; data restore per 5.2.2 with
  `restoredUnverified` and `releaseRestored`; supervisor, local recovery Space with
  out-of-band access (5.4); enrollment without router with rate limits; supervisor commands `createEnroll`,
  `revokePeer`, `rotateKey`.
- NetBird test matrix (4.6), key storage on target platforms, revocation and grant expiry.
- **Acceptance:** phone and a test client on the desktop (test driver, not the package from stage 4) paired;
  unpaired peer only enrollment; failed-attempt limit takes effect; a foreign peer cannot burn the token;
  passed-on challenge (foreign `observedPeerId`) fails; forged second hello and foreign services
  rejected; protected types neither takeable nor deletable via lease/txn; `revokePeer` takes effect within the
  limit; restore with new data and authority incarnation, old unknown request IDs result in
  `IncarnationChanged`, known results remain accessible for newly authorized resolution;
  recovery request possible with blocked NetBird management via the out-of-band access; too large a commit is
  rejected.

### Stage 2 - Router and expand
- Journal with sub-request deduplication and recovery; fixed policy versions; rules 7.1; drain;
  `readAll` with `allowPartial`/`waitForComplete`; capability directory.
- Delegation per 4.4: `RouterLease` signed by the supervisor, `routerEpoch`/`EpochNotice`, policy version check
  with follow-up operations, delegation renewal for long operations.
- **Acceptance:** 1000 jobs, 3 members, 6 workers: at most one destructive commit per entry; crash after every
  journal/RPC/ACK boundary on persistent storage without double effect; retries do not change the target binding;
  drain with running takes loses and duplicates nothing.
- Delegations fail on:
  - old policy version for new operations,
  - wrong audience, generation or expired router lease,
  - self-signed lease or lease with old `routerEpoch`,
  - wrong argument hash.
- Also accepted:
  - Poll and cancel of a begun operation work after `setPolicy`.
  - A `space_wait` lasting several minutes is decided correctly.
  - `addMember` with stock of a managed type is rejected.
  - `removeMember` on an HRW member is rejected.
  - Idempotency example and counter-example document the limit of external effects.

### Stage 3 - Replication and controlled takeover

Implementation status (2026-10-18): [phase 3 building blocks and evidence](_attic/abnahme/ap3-replikation.en.md). Entry replication
(lww/set), paged snapshot transfer, continuous cursor worker, generation maintenance, the synchronous
storage foundation, the integration into the service, the fencing adapter (F1/gate 2: netcup and container), `setStandby`, promotion and the
switch to single are implemented and verified in real runs. The acceptance of the stage has not yet been declared: The
[acceptance matrix](_attic/abnahme/ap3-abnahme.en.md) reconciles each of the criteria below with tests and runs and names
one open finding.

- Snapshot/stream import, lww/set with versioned deletes, leases, deduplication, offline rejoin.
- primary/sync with fixed standby and `setStandby`; control Space switches to primary/sync; router lease over
  sync commits; fencing adapter per 5.5 with quarantine mode; promotion per 5.3; switch per 5.3.1;
  policy validation of the mode limits (6.4).
- **Acceptance:** 10-minute partition with concurrent writes/deletes/renewals converges; old put does not revive
  a tombstone; natural expiry does not delete a newer renewal; snapshot under load loses nothing;
  without standby no confirmation; promotion without verified fencing evidence, with marker adapter or on the
  wrong standby refused; old router can delegate nothing after lease expiry; confirmed results
  are preserved after promotion; old primary starts after `release` only in quarantine; older lww version
  does not become visible after expiry of the winner version; standby failure locks confirmations, `degradeToSingle`
  without standby fencing is refused; policy with primary member in expand or lww rule is rejected.

### Stage 4 - Further clients
- Desktop/CLI package, optionally browser gateway.
- **Acceptance:** control without phone; reconnection reconstructs status by snapshot/events; no
  identity mixing between browser sessions; client abort does not affect host workers.

## 12. Test strategy

- **Simulator:** several harnesses, deterministic latency, loss, duplicates, partitions, clock jumps,
  restarts; counter-model for reservations, request states and merge rules.
- **Persistence:** real storage backends, process abort/reopen at commit, replication and reply boundaries.
  MemoryStorage alone is no evidence.
- **Invariants:** one active reservation and one destructive commit per entry (expand/primary); abort allows
  taking again; one result per valid request; no target change on unclear outcome; complete batches;
  no revival by old deletes/puts; lww/set converge.
- **Recovery:** interrupt the router after winner selection/commit/ACK; late losers, expired txns, lost
  replies, duplicate commands, two recovery attempts, standby failure, old primary restarts.
- **Time:** lease expiry effective at the next settle, also with delayed reaper; router lease with clock skew;
  worker effects after lease expiry with idempotency/fencing.
- **Routing:** HRW change rejected; new empty rules work; drain preserves searchability; partial replies
  marked.
- **Security:** role matrix, supertypes, enrollment replay and rate limit, challenge relay, delegation forgery
  (signature, audience, policy version, argument hash, router lease), stream access, revocation under partition,
  gateway principal separation, no secrets in the log.
- **Integration:** two pi-serverd/gates on localhost with test identity adapter; then real NetBird environment,
  target platforms and real fencing adapter. The simulator cannot accept overlay identity and fencing.
- **Load:** 10,000 entries, 3 members, complete document bytes including claims/stream/tombstones; p95/p99,
  memory, journal growth, replication backlog, behavior at every budget limit.

### 12.1 Additional mandatory acceptance cases from the consistency check

The following cases are the basis of acceptance; including them is not an implementation or test acceptance. The status per
stage is shown by the acceptance reports ([phase 1](_attic/abnahme/ap1-abnahme.en.md), [1b](_attic/abnahme/ap1b-abnahme.en.md),
[2](_attic/abnahme/ap2-abnahme.en.md)) and, for the rows "3", by the [acceptance matrix](_attic/abnahme/ap3-abnahme.en.md) (as of 2026-10-18).

| Stage | Failure flow / evidence | Expectation |
|---|---|---|
| 1 | Known pending request survives end of generation; new ID of the same generation | Poll/retry/permitted continuation work; new ID is rejected; result deadline only from completion |
| 1b | Token as marker value in enrollment, reopen and snapshot/stream inspection | no plaintext token in any persistent channel; retry after consumed token returns own result |
| 1b | First installation, abort before/after admin pairing, repeated script apply | no host enrollment/command before admin authorization; bootstrap right permanently closed after consumption |
| 1b | Restore with offline member with arbitrarily high old epochs; competing restore | only locally confirmed new authority is accepted; offline member stays locked; second transition fails |
| 1b | Key revocation after snapshot, then restore | restored key and A-only rule grant no rights without new explicit release |
| 1b | Rights withdrawal versus peer/key revocation | resolution grant permits only own resolution; revoked key no self access; admin resolution audited |
| 1b | Large txn, mass expiry and notify/waiter fanout at budget limits | extension is rejected in time; existing txn remains completable; bounded batches preserve order/atomicity |
| 2 | Router restart with FOREVER waiter and with offline member | independent new write possible; waiter served later; only dependent work blocked |
| 2 | Remote result expired, router journal still open | needsReview without substitute effect; independent work continues; dependent locks visible |
| 2 | Poll, cancel, commit and abort after policy/generation change; hash/method swap | separate follow-up claims and bound target reference; no rights escalation or RequestConflict on correct retry |
| 2 | drain between task take and result write; new worker during drain | permitted result completable atomically; new tasks/foreign results rejected |
| 1b | Data Space restore with entry taken after snapshot; new take request | restored entry is `restoredUnverified`, no second take before `releaseRestored`; old IDs `IncarnationChanged`; control authority unchanged |
| 1 | `readAll`/`events` with five entries near 64 KiB; paging under concurrent writes | every reply fits into a frame; snapshot pages without gap/duplicate; oversized event rejected before acceptance |
| 2 | Commit of a sieve take txn without result, with two results or wrong bounds | `CompletionViolation`; txn remains abortable; only `purgeTasks` empties without result |
| 2 | removeMember with active notify registration and unread events | registration ends with `registrationClosed`; EmptyProof only afterwards; events retrievable until ACK/TTL |
| 2 | Local write between emptiness check and removeMember; crash at every transition | local lock prevents refilling; same removal operation is continued; claims remain retrievable |
| 3 | Standby persists batch, ACK lost; primary dies; then degradeToSingle | candidate and result preserved exactly once, no subsequent miss/abort |
| 3 | Primary **process** dies after sealing before send, reopen of the **original** storage; standby unreachable; fencing and switch to single | the same candidate is completed locally; damaged prefix blocks |
| 3 | Primary **storage** lost after sealing before send; standby lives; fencing and promotion; generation still valid | candidate was never confirmed; per 6.2 durably decided negative claim permits `NotCommitted`; all confirmed operations are preserved |
| 3 | Take confirmed, reply lost, then promotion; retry with updated frame | stored result without second take; changed functional arguments → `RequestConflict` |
| 3 | First start without boot permission, outdated evidence after `setStandby`, promotion in quarantine | first start only with matching provisioning permission; both replicas reconciled after `setStandby`; promotion in quarantine refused |
| 3 | Switch a remote data Space to single, control offline in the process | only local configuration commit; remote use blocked until policy reconciliation; no feigned distributed commit |
| 3 | Control promotion without available standby, then set up replacement | first recovery single, then router/setStandby; rejection of single leaves the system offline |
| 3 | ACK loss and restart during setStandby; old replica returns | no new write release on unclear transition; excluded replica cannot promote |
| 3 | Successful request, claim and generation cleaned up, then promotion and old retry | `RequestExpired`, never `NotCommitted` or automatic substitute effect |
| 3 | Unknown old request against late original call with new frame; crash after negative claim | either original effect with known claim or durable negative claim; never an effect after `NotCommitted` |
| 1b | Snapshot contains waiting take; original then took X; data restore, then new write Y | old claim only historical resolution/needsReview; no old waiter takes Y; even after releaseRestored no continuation of the old request |
| 1 | maxBytes smaller than reply overhead or next element; again with requiredBytes | `ResponseBudgetTooSmall`, unchanged cursor/ACK; complete element fits without gap or frame overrun |
| 3 | Two Spaces on one host with different replica versions; setStandby/degrade of one Space, then reboot of both hosts | matching permission per Space; both further admitted replicas reconciled; other Space unchanged |
| 3 | Abort between local promotion/degrade/setStandby and external boot reconciliation | only the same recovery transition may continue; before confirmed reconciliation no functional writes/grants |

Pause, run and worker guarantees of the extension are additionally checked per
[operations, section 7.4](betrieb-und-mobile-steuerung.en.md#74-acceptance-of-the-operations-extension).

## 13. Fixed decisions and gates

Fixed in v3:

1. The basis is the contract from 2.1; no general exactly-once for external effects.
2. No mTLS on the Space port; WireGuard plus connection-bound app challenge (4.2, 4.3) - subject to F3.
3. Control Space in 1b-2 single with asynchronous snapshot and restore per 5.2.1 (fencing, new authority, renewed rights release, end of generation); primary/sync from stage 3.
4. No automatic promotion; manual promotion only after verified fencing (marker only in the simulator).
   Only exception: restore in single operation (5.2.1, 5.2.2) before gate 2 with documented console lock (F15).
5. Recovery Space local, not replicated.
6. RPC results durable, arguments only as hash, deadlines 24 h to 7 days.
7. Delegation signed, canonically encoded, bound to audience/request/argument hash/policy version/router lease.
8. Pairing: 256-bit token, peer binding, key possession, 3 failed attempts, 1 attempt per peer and minute.
9. No migration of existing HRW stocks; `addMember` changes no assignment; drain aborts only via the member.
10. lww/set only with explicit `semantics`; deletes versioned, natural expiry without tombstone.
11. Mailbox at most 7 days plus byte limit; 24 h minimum retention of completed results.

Gates (to be demonstrated before the respective stage):

1. Coordinator host, independent durable recovery register, external boot register with CAS and
   out-of-band recovery access per 5.4/5.5, tested with blocked NetBird including competing
   authority changes and Space permission updates without overwriting other Spaces (before 1b).
2. Concrete fencing adapter with restart lock, tested for real (before 3).
3. Permissible clock uncertainty, HLC future limit, lock behavior; also apply to grants and router lease (before 1b).
4. Start values for frame, `maxCommitBytes`, connections and handshake fixed (before 1b, F11); concrete
   byte/count limits, snapshot and generation lifetimes confirmed from load tests (before 2).
   Status 2026-10-15: closed for the documented profile; values, evidence and
   exception at the phase 2 conclusion are in [gate 4](_attic/abnahme/ap2-gate4.en.md).
5. NetBird version, deployment, licenses, management API rights, results of the test matrix 4.6 (before 1b).
6. Key storage on target platforms (Android Keystore: Ed25519 or P-256), WebCrypto for browsers (before 1b/4).

## 14. Open questions

Questions that cannot be answered without a decision of the operator. F2-F8, F10-F15 are decided (recommendation adopted; F2-F7 and F11 on 2026-10-08). F11 applies to the start values; the final operating values were confirmed on 2026-10-15 for the documented profile in [gate 4](_attic/abnahme/ap2-gate4.en.md). Recommendations are proposals.

| # | Question | Recommendation | blocks |
|---|---|---|---|
| F1 | On which infrastructure do the hosts run? The fencing adapter depends on it. | For VPS per 4.1.1: cloud adapter via the provider API (stop server, lock restart, set quarantine attribute). Only for home devices: switchable socket/PDU with API | stage 3 |
| F2 | Which host is coordinator, which standby? Does the coordinator run separately from the NetBird VM? | Coordinator and standby as VPS per 4.1.1 on separate physical hosts/zones in a nearby region; NetBird VM separate. For 1b the choice of the coordinator suffices | 1b (standby: 3) |
| F3 | Do WireGuard plus app challenge suffice, or is there a requirement (compliance, audit) for TLS/mTLS on the Space port? | no mTLS | 1b |
| F4 | Challenge per connection (v3) or signature per request (v2)? | per connection; delegation is signed per request anyway | 1b |
| F5 | Is a restore with possible loss of the last minutes acceptable for the control Space in 1b-2? | yes, with new authority and explicit rights release; orphaned effects per 5.2.1 step 5 are checked | 1b |
| F6 | Which clock uncertainty is permissible (NTP on all hosts)? | 2 s, lock from 5 s; HLC future limit 60 s | 1b |
| F7 | Grant lifetime 60 s and router lease 60 s/20 s, each plus time uncertainty: acceptable as maximum revocation delay? | yes | 1b |
| F8 | Are RPC results retained for 24 h or up to 7 days? | 24 h | 1 |
| F9 | Which contents count as personal, and is an erasure function per principal across entries, claims and mailboxes needed? | yes, as admin command in stage 2 | 2 |
| F10 | Is partial-result reading (`allowPartial`) default for dashboards or only explicit? | only explicit; dashboard sets it | 2 |
| F11 | Are the start values for frame (256 KiB), `maxCommitBytes` (192 KiB), connections per peer (32), handshake (5 s) suitable? | confirmed on 2026-10-15 for the verified profile; [limits](_attic/abnahme/ap2-gate4.en.md) | 1 (start values), 2 (final) |
| F12 | Is the browser gateway needed, or do phone app and CLI suffice? | defer | 4 |
| F13 | Is automatic migration (HRW extension) needed? It is not in v3. | only on concrete need | – |
| F14 | Should the v2 documents (`_attic/federation-plan-v2*.md`, `.DOCS-UPDATE.md`) be archived or deleted and `README.en.md` switched to v3? They refer to non-existent files and declare the more thorough v1 obsolete. | switch README to v3, mark v2 as "superseded" | – |
| F15 | May, before acceptance of a real fencing adapter (gate 2), a documented shutdown with restart lock via the provider console count as fencing evidence for a restore in 1b-2? This relaxes "a mere admin claim does not suffice" (5.3, decision 4). | yes, only for restore in single operation, with screenshot/API excerpt in the audit; never for promotion | 1b |

## Appendix A - Alternative without overlay: SSH certificates

If no NetBird is to be operated and all hosts are reachable by SSH:

- A CA signs host and client keys (`ssh-keygen -s`); clients trust the CA (`@cert-authority`).
- Certificates with principals, short lifetime, renewal via the control Space; revocation by KRL or
  non-renewal.
- Identity: per role `cert-authority,principals="…",restrict,command="space-gate --peer …" <CA-pub>` in
  `authorized_keys`; `space-gate` over stdin/stdout. To be verified: selection of the matching line with several
  `cert-authority` lines with different principals.
- Pairing needs an authenticated encrypted channel (PAKE for short codes or SSH with CA fingerprint
  verified by QR plus strong token).
- Authorization, delegation, router lease and recovery apply unchanged. Disadvantage: no NAT traversal,
  key management entirely on the operator.

## Appendix B - Assessment of the v2 proposals

| v2 | Proposal | Decision in v3 | Rationale |
|---|---|---|---|
| 14.1 | Fencing adapter | **adopted with corrections** (5.5) | Interface sensible. Corrected: `fence` must lock restart, the supervisor checks independently; marker file is a claim and permissible only in the simulator. Added: data fencing by sync confirmation, router lease. |
| 14.2 | Pairing with challenge, rate limit | **adopted** (4.5) | 256 bits and rate limits adopted. In the v2 code the comparison of the token hash was missing, and the nonce was undefined; v3 uses the connection challenge. |
| 14.3 | LWW only state, set only facts, tombstones | **partly** (6.4, 7.2) | `semantics` mandatory field adopted. Tombstone with version −1 rejected: every old put would overwrite it. Tombstone on natural lease expiry rejected: it could delete a newer renewal. |
| 14.4 | "2-phase commit" in the router | **replaced** (5.1) | The v2 code executes the remote effect without sub-request ID and marks errors with unknown outcome as `failed`: double effect possible. The v1 mechanism (journal plus deduplication at the target) already solves the problem. |
| 14.5 | Signed delegation | **adopted with corrections** (4.4) | v2 accepted *older* policy versions and rejected newer ones (wrong direction), used non-canonical JSON and a non-existent library (`verify.detached`), replay protection only claimed. v3: canonical encoding, `node:crypto`, argument hash, audience, router lease. |
| 14.6 | Async standby with automatic promotion in 1b | **rejected**, goal achieved differently (5.2) | Contradicts 2.1 (async is never a safe promotion) and 5.3 (no automatic election). The v2 code replicates only enroll writes, not the commit history. v3: single plus asynchronous snapshot and restore in 1b, primary/sync from 3. |
| 14.7 | mTLS + challenge | **rejected** (4.2, F3) | The rationale "IP spoofing" does not apply in the WireGuard overlay. NetBird issues no X.509 certificates; self-signed certificates without CA verify nothing. Second PKI without new guarantee. The challenge in the v2 code was not bound to the connection; v3 binds it to `observedPeerId` and gate. |
| 14.8 | Federation-wide snapshot | **rejected**; `waitForComplete` adopted (7.1) | Member states read one after another are no consistent snapshot; unbounded in-memory cache. |
| 14.9 | Results only in memory, only hashes durable | **rejected**; data minimization adopted (6.2) | After a restart the result of a take would be lost and the entry with it; breaks 2.1 and the acceptance of stage 1. Argument hash and deadlines remain. |
| 14.10 | drain aborts running requests in the journal | **rejected**; abort via `cancelOperation` at the member (7.1) | Unilateral `cancelled` on an unknown outcome can lose or duplicate takes. `$in` queries do not exist in the core. |
| 14.11 | Replicate recovery Space | **rejected** (5.4) | Solves no real problem and makes the recovery path dependent on the failed infrastructure. |
| 14.12 | Client total deadline 60 s | **adopted with corrections** (6.3) | As a pure client wait limit with `OutcomeUnknown`; no default, because `space_wait`/FOREVER legitimately run long. In the v2 code a duration was compared with `Date.now()`. |
| 14.13 | `addMember` redistributes new data, manual migration | **rejected** (7.1) | Targeted reads by field would no longer find old data; `write C, take A` is not atomic. |
| 14.14 | RAID 10 later | **adopted** (7.3) | – |
| 14.15 | NetBird test matrix | **adopted as hypotheses** (4.6) | Expected behavior is to be measured, not presupposed. |
| 4.2 | Frame 64 KB, 100 connections, handshake 5 s | **adjusted** (4.2) | 64 KB frames do not hold an entry at the 64 KiB limit; start value 256 KiB. |
| Docs | References to `federation-limitations.md` etc., team address, effort estimates | **not adopted** | Files do not exist; estimates without basis. |
