# Promotion of the control replica on big — 2026-10-17

First real run of the promotion of the control Space in both directions. The authority stayed the same; only the
control host changed from `phase1b-host-a` to the temporary host `phase1b-host-c` and back again. Both
ran as containers on big with their own NetBird agent and were locked by container fencing. The data is in
`report.json`.

## Setup

- **host-c:** own container with NetBird sidecar (group `space-hosts`), own supervisor key,
  `mainSync` with the same genesis as host-a. As a replica, `run` operates only journal and listener.
- **Container fencing:** `ContainerFencing` behind `serveFencing` on big, pinned to the containers and units of
  host-a and host-c. Locking means: container stopped, restart policy `no` and a drop-in that keeps the unit from
  starting. The service listens on the public address of big and discards any other source address before
  the TLS handshake.
- **Rights and network:** control certificates for both hosts with time-limited register rights on vpsc and a dedicated
  NetBird policy for the replica port.
- **Members:** member-1, restore-target, nano-test and standby-100 pin the recovery admin key and run
  with the new bundle.

## Procedure

1. **Way there:**
   - `set-standby` host-a → host-c (sync, epoch 3, version 6). A control write was confirmed by host-c.
   - `promote` on host-c locked host-a by container fencing: container stopped, restart policy `no`,
     unit locked. Then `degrade` to single (epoch 5, version 8).
   - The recovery admin recorded the change; the register now names host-c with its key.
   - host-c started as control host. The four members followed on restart, and the baseline check against host-c
     was green.
2. **Way back:**
   - host-a was released from quarantine and set its history aside with `wipe`; afterwards it ran as an
     empty listener.
   - `set-standby` host-c → host-a (epoch 5, version 9).
   - `promote` on host-a locked host-c by container fencing; then `degrade` (epoch 7, version 11).
   - The second change was recorded, host-a started as control host, and the members followed back.
     The baseline check was green.

**Final state:** host-a is control host again with boot version 26, active, primary, single, epoch 7, version 11.
The authority entry keeps both changes as history.

## Incidents

- **Fencing service not reachable over the overlay:** The host firewall of big blocked the port; without root it
  cannot be changed.
  - The service moved to the public address, with a blocklist for source addresses (`5c6b9a0`).
  - In the meantime host-c was stopped while host-a in sync operation waited for it. Control writes
    therefore stood still from 12:37:51 to 12:47:30 UTC.
- **Missing authorization for the default Space:** The `set-standby` on host-c still ran with the older
  bundle of host-a, that is before the fix `be44076`. host-c got no authorization for the default Space, and
  the promotion stopped after the fencing of host-a.
  - The operator added the standby authorization in the register, exactly as the fixed `set-standby` writes it
    (incarnation `a0281666`).
- **Tool locked its own host:** When resuming the promotion, `main-sync` took the fencing target from the
  current primary of the journal; that was already host-c, so it locked itself.
  - host-c was unlocked by hand, without starting its unit.
  - The tool now locks the respective other replica and refuses its own host (`8a3fbb7`).
- **Members with an old bundle:** On the first restart the members still ran bundles without host change and
  stopped with `BootBlocked`. With the new bundle they followed.
- **Control outage:**
  - Way there: from 12:47:33 UTC (host-a locked) to about 12:51:30 UTC (members ready).
  - Way back: from 12:55:18 to about 12:56:40 UTC.

## Teardown

- **host-c:** Container, volumes, unit and NetBird peer are removed; `boot:phase1b-host-c` is decommissioned
  (`fenced`, without authorizations).
- **Fencing service and network:** The fencing service together with its key and the dedicated NetBird policy are removed; on vpsc
  `tls.json` is reset.
- **host-a:** Control certificate, backup and the history set aside are removed. The unit of host-a now waits
  75 instead of 25 seconds when stopping, longer than the 60 seconds of `stop`.
- **Remains:**
  - The members keep the new bundle and the pinned recovery admin key.
  - The configuration of host-a keeps `mainSync.incarnation`, `recoveryAdmin` and host-c as the last
    replica peer.

## Limits

- Without root: A root does not yet move along with the promotion.
- The members follow only on restart; the restarting was scripted.
- Both hosts ran on big and were thus in the same failure domain.
