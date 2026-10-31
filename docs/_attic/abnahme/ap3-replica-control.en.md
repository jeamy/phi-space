# Phase 3: Replica Control (Promotion, degradeToSingle, setStandby)

As of 2026-10-16. Implemented with a simulator adapter; acceptance is blocked by F1/gate 2 (real
fencing adapter). Basis: [federation-plan-v3.md](../../federation-plan-v3.en.md) §5.3, §5.3.1 and §5.5,
plan packages 3.3–3.6 in [implementierungsplan-v3.md](../implementierungsplan-v3.en.md). Code: `src/replica-control.ts`,
configuration entries in `src/primary-sync.ts`, tests in `test/test-replica-control.test.ts`.

## Configuration Transitions as Entries of the Sync Chain

A change of the replica configuration is its own entry (`version: 2`) of the hash chain of the
`PrimarySyncJournal`. It contains:

- the new configuration and the hash of the previous one;
- a reason ID, namely the transition ID;
- as its only change the data marker.

`validateConfigTransition` enforces:

- same Space and authority ID;
- `replicaConfigVersion` exactly +1;
- the epoch stays the same or rises by 1; a new primary requires +1.

`durability: "single"` requires `standbyReplica: null`.

Every journal state knows the configuration at every revision (`configAt`). Therefore standby,
replay and materialization check each entry against the configuration that applied before it. A
candidate sealed under `single` needs no standby ACK on restart.

## Fencing (v3 §5.5)

`FencingAdapter` offers `fence`, `verify` and `release(host, "quarantine")`. Boot states do not live in the
adapter but in the independent recovery register.

- `SimulatorFencing` reports `kind: "simulator"`. Promotion and degradeToSingle reject it unless a test
  explicitly sets `allowSimulator`. There is a dedicated test for this rejection.
- `unconfiguredFencing(kind, provider)` is the placeholder for providers without access. Every operation
  fails with "not configured".
- `NetcupFencing` (`src/netcup-fencing.ts`, `kind: "cloud"`) uses the SCP REST API of netcup; see
  [netcup adapter](#netcup-adapter).
- The boot transitions run per CAS through the register. Retry happens only on `RegisterConflict`; any
  other error aborts the transition.
  - `fenceHostBoot` sets the host to `fenced` and all Space permissions to `revoked`. The values are retained
    for checking.
  - `releaseHostToQuarantine` leads exclusively from `fenced` to `quarantine`. Only after that does the
    adapter lift the restart lock.
  - `active` is set only at the end of `setStandby`.

## degradeToSingle without Fencing Adapter

For standbys without an adapter (for example on a home network), an extension of v3 5.3.1 step 2 has applied since 2026-10-17:

- **Call:** `degradeToSingle({..., revokeStandbySpace: true})` instead of `adapter` and `proof`. Both at once or
  neither is rejected.
- **Effect:** In the register only the standby permission of this Space is revoked (`revokeSpacePermit`). The host
  stays `active`, its other Spaces remain untouched. After that the same steps run as with an adapter:
  complete the sealed candidate locally, `single` with epoch and version + 1, reconcile own permission.
- **Rationale:**
  - A standby serves no domain calls and runs no agents. The process lock from 5.5 aims at
    the promotion of the old primary.
  - With a revoked permission the standby accepts no more intents and cannot be promoted.
  - For a promotion a real adapter remains mandatory.
- **Return:** `setStandby` also accepts as target an active host without an active permission for this Space,
  not only a host in quarantine. The same applies to catch-up (`assertQuarantine(register, host, spaceId)`) and
  to the confirmation of the new configuration.
  - The replica must be empty beforehand; the old journal of the Space is set aside.
- **Tooling:** The `sync` mode of the daemon accepts `{op: "degrade", revokeStandbySpace: true}` without `fencing`. For
  `main-sync` there is no such path, because there the revocation would not affect the standby's sibling Spaces.
- **Test:** `test/test-degrade-revoke.test.ts`:
  - Degrade with a sealed candidate.
  - The host stays active, the other Space too.
  - The excluded standby rejects the never-received candidate and cannot be promoted.
  - The primary continues as `single`.
  - `setStandby` back onto the same active host.

## netcup Adapter

The basis is the OpenAPI specification of the SCP REST API delivered per user
(`https://www.servercontrolpanel.de/scp-core/api/v1`, version 2026.1015, 63 paths). Endpoints:

- `GET /servers/{id}`: state and autostart (`serverLiveInfo.state`, `serverLiveInfo.autostart`);
- `GET /servers/{id}/interfaces`: MACs;
- `PATCH /servers/{id}` with `application/merge-patch+json` and exactly one attribute per call; returns 202
  and a task;
- `GET /tasks/{uuid}`: task status.

Flow:

- **fence:**
  1. Checks the fixed identity: host ID → server ID and MAC, from the local list only.
  2. Remembers the previous autostart value and switches autostart off.
  3. Powers off hard: `state: OFF` with `stateOption=POWEROFF`.
  4. Reads the server again. A proof with `restartLocked: true` arises only at exactly `SHUTOFF` and
     autostart off.
  5. Tasks in `ERROR`, `CANCELED` or `ROLLBACK` as well as 503 (maintenance) count as failure.
- **verify:** on every call queries the live state of the server that the local list names for the host ID.
  The server ID in the proof is never used.
- **release:** only to `quarantine`. Restores the old autostart value and powers on.

With netcup, "restart lock" means: autostart off and `SHUTOFF` observed. Whoever has access to the SCP can still
start the server. The actual lock is the boot state `fenced` with revoked permissions
in the register.

Operation:

- Token and calls stay on vpsc. The service `scripts/fencing-netcup-tls.mjs` (part of
  `npm run build:operations`) offers `fence`, `verify` and `release` via mTLS, for operator
  certificates only.
- Transition hosts use `TlsFencing` as a thin client.
- The service runs as its own process next to the register; the register itself never sees the token.
- Login via device flow with `scripts/netcup-login.py`, as user `mux` on vpsc. The result is an
  offline refresh token in `~/.config/phi-spaces-fencing/netcup.json` (0600).
- Keycloak rotates the refresh token. Service and script therefore renew it only under the same lock file
  `netcup.json.lock`.
- The token expires after about 30 days without use; regular status queries keep it active.
  Revocation in the SCP account under "Account security → Device activity".
- The SCP account is IP-restricted. Released are the addresses of vpsc: `2a02:c207:2252:8263:8000::`
  and `207.180.233.218`.
- Rolled out on 2026-10-16 as user service `phi-spaces-fencing.service` of `mux` on vpsc (linger on).
  It listens on `[::]:17423`, configuration in `~/.local/share/phi-spaces-fencing/fencing.json`.
  - Server certificate `CN=phi-spaces-fencing-server` from the operator CA with SAN `207.180.233.218`,
    `2a02:c207:2252:8263:8000::` and `phi-spaces-fencing`. The key was generated on vpsc; only the request
    was signed locally.
  - Only the operator certificate (`a8baf286…`) is released.
  - ufw allows 17423 only from the operator address `212.186.197.226`.
- Non-modifying check from lux27:
  - `verify` for `nano-test` returns `false` because nanoi is `RUNNING`.
  - `verify` for `big` returns `false` because `big` is not in the list.
  - The reader certificate is rejected.
  - The service rotated the refresh token; the chain stayed valid.
- The fixed target is only nanoi: `nano-test` → server 964249, MAC `2a:38:5f:38:de:22`. Server 730972 is big
  and is never in the list.

## Permission Checks

- `assertSyncPrimary` is `assertPrimary` for `primarySyncStorage`. It requires:
  - host `active`;
  - an active primary permission with exactly the authority, epoch, replica version and durability of the
    current journal configuration.

  As long as external and local state diverge, every write access stays blocked.
- `assertSyncStandby` is the journal's `assertStandby` and requires the same for the role `standby`.
  The only exception: the `setStandby` entry that names this host as standby it confirms even in
  `quarantine`.
- `promote` checks the standby permission without the quarantine exception. A released standby with
  outdated history therefore cannot promote itself.

## Write Lock During a Transition

v3 §5.3.1, steps 1 and 7: As long as a transition in `started` or `locallyCommitted` stands in the journal,
`PrimarySyncJournal.seal` seals no domain decision.

- **Atomic:** The check runs in the same SQLite transaction as the sealing, so without a gap between the
  beginning of a transition and its configuration entry.
- **Still allowed** are only the configuration entries (`version: 2`) of the transition itself.
- **All write sources:** Reaper, agents, clients and lease renewals all commit through the storage
  and are thus locked together.
- **Consequence in pi-durable:** The first rejected commit poisons the running harness session. The transition thus runs
  with the service stopped on the raw storage, and even a restarted service writes nothing until
  completion.
- **After `completed`:** The service is reopened, and the reaper catches up expired leases exactly once.

Further rules:

- `beginTransition` permits exactly one open transition per journal. The same ID continues, a different one is
  rejected.
- A rejected transition stays open and locks the Space. This concerns for example a simulator proof, wrong
  versions or a primary that was fenced during catch-up. `abandonTransition(id)` ends it,
  but only in `started` and only as long as no configuration entry with this ID is sealed. A
  `fenceHostBoot` already executed on the counterpart remains in place. An abandoned ID cannot be reused.

## Boot Guard and Readmission (3.6)

`installBootGuard` has an optional hook `replicaConfig(spaceId)` that returns the current journal configuration.

- For a primary/sync Space the guard requires the role `primary` of this host as well as authority, epoch,
  replica version and durability exactly as in the journal.
- A `standby` permission allows neither commits nor reads.
- If the journal configuration deviates from the external permission after a local transition, only this
  Space is locked.

`fenceHostBoot` revokes all Spaces of the host, but a transition re-admits only its own Space. The
remaining Spaces return one by one:

1. `readmitSpace` runs on the operator or supervisor side. It activates only a revoked permission
   with unchanged role and data incarnation, and only if the host is `active`. Replicated roles return only
   via `promote`, `degradeToSingle` or `setStandby`.
2. With `installAdmittedPermit` the host takes over exactly this external permission into its local installation,
   after it has checked the data incarnation.

Invariant: A host that can be fenced never writes its own boot entry. It only reads it and
installs locally.

## Control Space on primary/sync (3.8)

**Main store as sync store:** A control host can run its entire main store as primary/sync
(`mainSync` in the configuration). The chain thus covers every Space of this store; on host-a these are the
default Space and the control Space.

**Daemon:**

- `run` opens the main harness via `primarySyncStorage`, after resolving an open candidate.
- `main-sync` is the tool with the service stopped: `bootstrap`, `status` with store checksum, `degrade` and
  `set-standby`.
- `replica-listen` runs a control standby with journal and signed listener only; it serves nothing.
- Other modes reject a sync main store because they would bypass the journal.

**Epochs:** Router lease, epoch notice, root check, `hello` and delegation verifier take the
control epoch from the journal (`controlEpoch`, `boot.replicaConfig`). The Space document keeps its
creation epoch; without that the router lease would be invalid after `degradeToSingle`.

**Sibling Spaces:** A transition carries along the permissions of all Spaces of the store (`siblingSpaces`); each
keeps its own data incarnation.

**Step 6, special case control Space (v3 5.3.1):** The transition is a configuration entry in the journal, not a
store commit. Its policy step therefore follows in the first commit after it, before the host serves anything.

- **Reconciliation at start:** `startConfiguredFederation` reads the last transition of the journal
  (`lastConfigTransition`). Before grants, router lease and root, `alignControlReplicaIn` executes it.
  - The reconciliation sets the marker `ControlReplicaMarker` (transition, epoch, version, predecessor epoch, same
    primary) and in the same commit raises `policyVersion` of an installed routing policy.
  - It is idempotent per transition. A crash between transition and reconciliation is
    completed at the next start.
- **Lease across the transition:** A retained or still live router lease renews from an
  older control epoch only if the marker evidences a transition with the same primary (`degradeToSingle`, `setStandby`)
  from exactly this epoch. Router epoch and lease ID stay the same. After a primary change
  no old lease renews.
- **EpochNotice:** The root sends the supervisor's signed `EpochNotice` per transition to every active
  member. After a root restart it sends it again; the member keeps the maximum.
- **Tooling:** `main-sync` permits `degrade` and `set-standby` also with a routing policy. It rejects them beforehand
  if an open profile switch would block the policy step later.
- **Running operations:** Root operations already admitted carry their old `policyVersion` onward. A member
  rejects new requests with an old version, as with any other policy change, for example `addMember`.

**Limits:**

- **Promotion of a control replica** is implemented (see below), without root. A root does not follow yet: it
  lacks lease file and key on the new host, and it rejects a change of the router epoch on
  reopening.
- **Step 6** is implemented, checked locally (`test/test-configured-root.test.ts`) and actually run on host-a
  ([evidence](../../../test/evidence/step6-hosta-2026-10-17/README.en.md)). Whether the mark at the member comes from the `EpochNotice`
  or from the first delegation of the new epoch cannot be distinguished here.
- **Coupling:** With a standby, every control write needs its ACK. If the standby fails, enrollments,
  admin commands and routing changes stand until `degradeToSingle`.
- **No way back:** A bootstrap cannot be undone. Going back is possible only via the copy before the
  migration, with loss of later control writes, or permanently in single operation with a growing journal.

## Promotion of the Control Replica

The promotion keeps the authority. Replica configuration, boot permissions and delegation verifier carry the
`authorityId`, and `validateConfigTransition` rejects a change. The authority change from 5.2.1
(`RecoveryCoordinator`), by contrast, always creates a new authority. It therefore does not fit; the promotion is its
own kind of change: same authority, new control host, new supervisor key, new address.

**Flow:**

1. **Standby:** The future control host runs with its own NetBird identity, its own key and a
   `mainSync` configuration with the same genesis. As long as it is not primary or in quarantine, `run`
   operates only journal and listener (`mainSync.incarnation` names the data incarnation of the control Space).
   `set-standby` on the control host makes it the synchronous standby.
2. **Promotion:** With the standby service stopped, `main-sync promote` executes the promotion.
   - A fencing adapter locks the old control host. For a container this is `ContainerFencing` on the
     docker host behind the mTLS service: container stopped, restart policy `no`, drop-in locks the unit.
   - After that `promote` rebuilds the store from the journal and raises the epoch; the boot entry of the old host
     becomes `fenced`.
3. **Record the change:** The recovery admin signs `ControlHostChange` (authority, old and new host,
   epoch, supervisor key and address of the new host). `recordControlHostChange` writes it into
   `authority:<controlSpaceId>`, but only if the register shows the new host as active primary of the control Space
   in this epoch and the old host has no active permission any more.
4. **New control host starts:** Step 6 reconciles the policy at start; the marker shows a
   primary change, so old router leases do not renew.
5. **Hosts follow:** Every host that pins the recovery admin key (`recoveryAdmin`) follows at start
   (`followControlHostChange`).
   - If the register names a different control host than the one it uses, it checks the recorded change
     against the pinned key and the same authority.
   - Then it installs host, key and address in `installed-authority` and uses them as the control endpoint.
   - A mere register change without a matching signature redirects nobody. A host without a pin stays stuck as before
     with "independent authority … disagrees".
6. **Way back:** The old host is released into quarantine and sets its history aside with `main-sync wipe`.
   Then the same flow runs in the opposite direction: `set-standby` from the new host, `promote` on the old one,
   second `ControlHostChange`.

**Consequences in running operation:** A running host with `recoveryAdmin` checks the register every 15 seconds
(`followIntervalMs`). If a recorded, signed change appears, it installs it immediately and reports it
(`controlChanged`). The test-bed daemon then shuts down in order and ends with code 75, and systemd restarts it
via `Restart=on-failure`. The restart takes the same start path with the installed endpoint.

**Router change (v3 5.2):** A root without its own lease file takes over an existing journal of its ID only with
`takeover` in the root configuration, for example on the new control host after a promotion.

- It waits (bounded by `takeoverWaitMs`) until the lease of the previous router has expired, plus 5 seconds
  of time uncertainty (`ROUTER_CHANGE_SKEW_MS`).
- Then it takes a fresh lease with a higher router epoch. A retained lease of the old router
  no longer renews afterwards.
- The supervisor never issues a fresh lease for a **different** router (peer or key) while
  the previous one is alive. The same router may restart with a higher epoch and thereby locks its own old frames.
- The `EpochNotice` also goes to every active member after a router change, once per combination of
  control transition and router epoch.
- The new router needs its own router and host keys, enrolled for its peer.

Real run with root on a control promotion in both directions: [evidence](../../../test/evidence/root-promotion-2026-10-17/README.en.md).

Real run in both directions on big: [evidence](../../../test/evidence/control-promotion-2026-10-17/README.en.md).

**Measurement on the copy of host-a:** 114 control commits in six days, revisions of 1–3 KB. The journal budget
of 64 MiB thus roughly suffices for years.

**Checked** (`test/test-bootstrap.test.ts`, both backends) with a control-like main store: bootstrap,
`setStandby` to a listener, synchronously confirmed control writes, `degradeToSingle` with sibling Space,
then epoch 2 in permissions, boot guard and router lease.

## ReplicaConfigNotice (v3 §5.3.1 step 5)

After `promote`, `degradeToSingle` or `setStandby`, the primary offers the new replica configuration as a
signed notice. Code: `src/replica-notice.ts`.

**Creating:** `replicaConfigNotice(journal, transitionId, dataIncarnation)` derives the content deterministically from
the configuration entry of the completed transition. A crash between `completed` and pickup
thus loses nothing.

**Signing:** `signReplicaConfigNotice` signs with the host key of the new primary.

**Adoption:** `adoptReplicaConfigNotice` adopts the notice on the router side in its own control commit.

- **Check:** The signature must come from the named primary. Decisive, however, is the independent register:
  The primary must be `active` there and have an active `primary` permission with exactly the epoch, version,
  durability and data incarnation of the notice. Such a permission arises only through a fenced
  transition. A fenced old primary with a still enrolled key therefore does not get through.
- **Effect:** Only the following are changed in one commit:
  - `replication` and `target` (host, epoch, data incarnation) of the one member whose Space the notice names;
  - the replica fields of the sync-primary rules of this member;
  - `policyVersion + 1`.

  The validator requires that primary rule and `member.replication` match. The placement of a
  primary rule is only its member; a new replica configuration therefore does not count as a placement change.
  Members fetch the policy live from the control host on every delegation check and thus see the new version
  immediately.
- **Repetition:** The same version with the same recovery ID is a no-op. Deviating or older notices
  are rejected; an old policy never resets the local durability.
- **Profile transitions:** As long as one is open, nothing is adopted.

**Lock on the member side (`ReplicaConfigPending`):**

- Delegations carry for replicated members `targetReplicaConfigVersion` from the router's member table.
- The `DelegationVerifier` with hook `replicaConfig` rejects new work with `ReplicaConfigPending` as long as this
  version does not match the journal configuration. This also covers `setStandby`, which only raises the version.
- Follow-up calls of operations already admitted continue under their original binding.
- Local work is not affected.
- After adoption the lock releases itself without a separate reply.
- If the router lags behind a transition (older epoch, different configuration version), `ReplicaConfigPending` also
  comes, not the rejection because of the epoch.

**Router across a transition (decision 2026-10-18, v3 §5.3.1 step 5):**

- **Dedicated error codes:** `ReplicaConfigPending` and `StalePolicyVersion` (new operation under an older
  policy version) go over the wire as their own codes. Both mean: never admitted, without effect.
- **Waiting:** `FederatedSpace` reports an operation already rejected at generation assignment as
  `FederationPending`. The router takes a rejected step as `notAdmitted` back to `prepared`.
- **Prepare anew:** `RouterTarget.reprepare` gives the step the current target, a new generation and the current
  policy version, if all policy versions since then stem from notice adoptions. The adoption records its
  version for this in `noticePolicyVersions` of the routing state. Otherwise the step goes to review (`needsReview`); with
  `ReplicaConfigPending` without adoption it waits.
- **Clarifying at the successor:** A step that might have been admitted is at the installed successor of its
  binding only clarified, never resent: same Space, same authority and data incarnation, installed epoch
  at least the bound one. The delegation carries the bound epoch; the member answers with the stored
  result or `NotCommitted`. This applies after a promotion (different host) as after a degrade (same host,
  higher epoch).
- **Tests** (`test/test-delegation.test.ts`): clarification at the successor after degrade and after promotion without sending
  the effect; a routed write in the window waits, runs exactly once after the adoption, also across a degrade;
  another policy change in between leads to review.

**Pickup:** The primary places the notice in the control Space instead of the router querying it.
The router only learns of the new primary after the adoption, after all.

- `latestReplicaConfigNotice(journal, dataIncarnation)` returns the notice of the most recent completed transition.
- The wire method `replicaNotice` (`RemoteSpace.publishReplicaNotice`) is built like `capabilityHeartbeat`: it
  requires a currently proven host key and a grant.
- `ReplicaNoticeBoard` stores at most one notice per Space and host, and only that of the proven host itself.

**Native root (`configured-root.ts`):**

- Replicated members can provision `replicas`, that is further replica hosts with peer ID, key and
  address.
- Before every status round the heartbeat adopts the published notices (`adoptReplicaNotices`). It looks up the
  sender's key in this provisioning.
- The transport resolves the address on every call via the current routing target. After the adoption,
  calls thus go to the new primary.
- A stored target on a provisioned replica host counts as provisioned on restart.
- Tested with two loopback endpoints: before the adoption the status query goes to the old host, afterwards to the
  new one, and also after a restart of the root.

**Open:**


## primary/sync Spaces in the Federation Host

According to v3 §7.2 ("one complete ordered commit history per Space") and `ap3-primary-sync.en.md`, every
primary/sync Space runs in its own store. `openSyncSpace` (`src/sync-spaces.ts`) opens it:

- **Journal:** with `self` and standby check against the register.
- **Listener:** a replica listener with signed transport on the overlay address, only for the
  provisioned peer IPs.
- **On the primary:**
  1. The open candidate is resolved.
  2. A harness over `primarySyncStorage` is opened.
  3. The Space is created with a fixed identity (`createSpace(..., { spaceId, incarnation })`). The standby
     receives the same ID and data incarnation through replication.
  4. The boot guard runs with `replicaConfig`.
- **On the standby:** no harness; it serves no domain calls.
- **Notice:** `notice()` returns the signed notice of the last completed transition.

`configured-runtime` reads these Spaces from `syncSpaces` in the configuration. It opens storage and harness via
factories that the daemon passes.

- `startFederationHost({ syncSpaces })` dispatches calls whose `space` names the ID or alias of such a Space
  to its own `SpaceService` via its harness. This includes its own `DelegationVerifier` with
  `replicaConfig`; `epochNotice` for this Space goes to its verifier.
- The host publishes the notice in the rhythm of the capability heartbeat.
- Transitions (`promote`, `degradeToSingle`, `setStandby`) run with the service of this Space stopped. An active
  host follows the journal at the next start.
- **Quarantine start:** A host in `quarantine` does not start normally. `startQuarantineReplicas` then opens only
  journals and replica listeners of its sync Spaces, without gate, service or harness, so that a primary can run `setStandby`
  against it. If the host becomes `active`, the daemon exits with a note. The operator then re-admits the
  remaining Spaces (`readmitSpace`) and starts normally; the normal start adopts the active external
  permissions locally.
- **Tooling:** The test-bed daemon has the mode `sync` (`status` with materialization, `promote`, `degrade`,
  `set-standby`, `wipe`) for a stopped service as well as `sync-head` for a reading look with the service
  running.
- **Real run in the daemon** passed on 2026-10-16
  ([evidence](../../../test/evidence/phase3-daemon-sync-2026-10-16/README.en.md)). The router adoption of the notice is not
  included, because host-a runs with the old bundle.
- **Automated cycle:** The driver `test/testbed/scenarios/phase3-daemon-cycle.ts` runs all
  operator steps, continues after an abort and waits for journal lines instead of fixed pauses. Real run
  passed on 2026-10-17 ([evidence](../../../test/evidence/phase3-daemon-cycle-2026-10-17/README.en.md)).
- **Orphaned lock:** `owner.lock` contains `boot_id` and start time. A lock from an earlier boot is cleared
  by the daemon itself; within the same boot the operator's check continues to apply.
- **Membership:** Instructions for a sync Space go to a `MemberLifecycle` via its own store.
- **Failure isolation:** If a sync Space cannot open, for example because its standby is unreachable for a sealed candidate,
  only this Space stays unserved and locked. The host and its other Spaces start
  (`openSyncSpaces`).
- **Background services:** For every served sync Space, reaper and delivery run on its own harness.
- **Epoch:** The `DelegationVerifier` takes it for replicated Spaces from the journal configuration
  (`replicaConfig.primaryEpoch`), because the replicated Space document keeps the epoch of its creation. Without that
  every new delegated call would be rejected after a promotion.
- **Data incarnation:** A replicated Space has exactly one, which both replicas share. `promote` and
  `degradeToSingle` require the previous incarnation of the permission; `setStandby` gives the target the same as
  the primary.
- **Notice:** The board accepts a notice if it is signed with exactly the proven key of the connection.
  A mapping of peer ID to host ID is not needed for this; NetBird peer IDs differ from
  host IDs.
- **Dependence on the register:** Every sync write checks the boot permissions in the independent register on vpsc,
  via primary check, standby check and boot guard. If the register fails, sync writes stand. This is
  intended: Without the register there is no proof that this host is still primary.

The policy validator now permits sync-primary rules if the member has a `replication` and rule and
member match. `lww` and `set` remain blocked until their public adapter (3.7) exists.

Checked:

- `openSyncSpace` with two hosts on loopback: replication, no service on the standby, restart,
  boot-guard lock.
- In the runtime test through the real gate with grant, a call to `sync-jobs` lands in its own store.

Not checked is a daemon run with `syncSpaces` on real hosts; the fixture run of 2026-10-16 ran next to
the daemon.

## Transitions

Every transition is stored in the journal under its ID (`started` → `locallyCommitted` → `completed`) and
bound to the arguments. The same ID continues after a crash:

- before sealing: The transition starts anew.
- after sealing but before applying: The sealed entry is applied once.
- between local commit and boot CAS: Only the register steps are caught up.

A reused ID with different arguments is rejected.

- **degradeToSingle** (on the primary):
  1. Checks the fencing proof of the standby host.
  2. Sets its boot state to `fenced`.
  3. Completes the at most one sealed candidate locally and exactly once (`recoveredCommitted`).
  4. Writes the single configuration with epoch and version +1.
  5. Reconciles the primary permission.
- **promote** (on the fixed synchronous standby):
  1. Checks the fencing proof of the old primary and its own active standby permission.
  2. Sets the old primary to `fenced`.
  3. Materializes the accepted history.
  4. Becomes primary with a new epoch; the old primary stays registered as standby.

  Without a reachable standby, sync writes are blocked until `degradeToSingle` follows with the same
  proof. There is no implicit single release. A candidate of the old primary that the standby
  never accepted does not belong to the promoted history.
- **setStandby** (on a single primary):
  - The target must be in `quarantine` and empty; the exception is the continuation of its own interrupted
    catch-up.
  - It replays the entire chain from revision 1 (`catchUp`) and then confirms the new sync entry.
  - Sealing and applying happen only as long as the primary permission of the previous configuration applies.
  - After that the target becomes active standby, then the primary permission follows.
  - An old primary with its own forked candidate is rejected. It must be set up anew
    empty; a snapshot bootstrap is still missing.

## Tests

`test/test-netcup-fencing.test.ts` checks the adapter against a rebuilt SCP state machine:

- the order identity, autostart, power-off;
- repetition without patching again;
- `verify` against a wrong server ID in the proof, autostart switched on, wrong type and hosts that are not
  fixed;
- task errors, maintenance, changed MAC and a server that keeps running;
- token rotation under lock file;
- the mTLS service: reader certificate rejected, operator permitted.

`test/test-replica-control.test.ts` comprises 8 cases on JSONL and SQLite:

- **Rejections:** Simulator and unconfigured adapters are rejected without changing state;
  likewise proofs for the wrong host and reused IDs.
- **degradeToSingle:** A sealed candidate is completed locally. A crash before the boot CAS keeps
  the write lock, and the same ID completes the transition.
- **Released standby:** A standby in quarantine with outdated history is rejected
  at promotion.
- **setStandby:**
  - A crash before the target's boot CAS leaves the target in quarantine.
  - A used target is rejected.
  - After the transition the materialized state of the new standby is identical to that of the primary.
- **promote:**
  - The forked candidate is missing on the new primary, and sync writes stay blocked
    without a standby.
  - After degradeToSingle it continues; the old primary with its fork is rejected as target.
- **Fencing during catch-up:** If the primary is fenced in the process, nothing is sealed and the target
  stays in quarantine.

## Limits

- The netcup adapter actually shut nanoi down on 2026-10-16, checked it and released it via quarantine
  ([evidence](../../../test/evidence/f1-netcup-2026-10-16/README.en.md)).
- On the same day the whole cycle ran with real hosts
  ([evidence](../../../test/evidence/phase3-sync-2026-10-16/README.en.md)):
  - primary nanoi, standby 100, connected via the signed replica transport;
  - fork without ACK;
  - netcup fencing, `promote` and `degradeToSingle` on 100;
  - release into quarantine and `setStandby` back to nanoi;
  - identical states at the end.

  That was a fixture run. The productive service ran afterwards in the daemon run and in the overall run 3.7
  ([evidence](../../../test/evidence/phase3-partition-2026-10-17/README.en.md)).
- For standby 100 there is no fencing adapter. Promotion to 100 runs after fencing of nanoi;
  `degradeToSingle` on nanoi revokes only the standby permission of the Space (see above).
- 3.6 is implemented in its core (guard hook, standby lock, readmission per Space, restart). Whoever operates a
  primary/sync Space must still connect the hook to the journal.
- Still open: snapshot bootstrap of a non-empty target; further points in the [acceptance matrix](ap3-abnahme.en.md).
