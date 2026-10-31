# Native root on host-a with a replicated member — 2026-10-17

Real run of the router path from 5.3.1:

- A native root on the control host `phase1b-host-a` routes writes to the replicated member
  `sync-member`, a primary/sync Space on `nano-test` with standby `standby-100`.
- After promotion and degrade to 100, the root takes over the `ReplicaConfigNotice` from the notice board in the
  control Space.
- Routed writes then go to the new primary.
- Afterwards everything was reset to the state before the run. This reset had been decided beforehand, because a routing policy
  can no longer be removed in the regular way (see below).

The data is in `report.json`.

## Procedure

1. **Keys.** host-a was briefly also in the empty group `space-enroll` (role `unpaired` at the gate) and
   stayed in `space-hosts` at the same time; the members therefore did not lose their connection.
   - Router and host keys were created in the container with the new lock-free mode `enroll-key` and were
     entered with `createEnroll` (scope `*`). The private keys never left host-a.
   - Afterwards `space-enroll` was empty again.
2. **Member.** New sync Space `root-member` (`sp-8a6d5b1d-…`, incarnation `29982a8a`) on nano-test and
   standby-100, with `membership: sync-member`, its own time-limited NetBird policy for port 17432 and boot permits.
   Both replicas stood at revision 1 with the same hash.
3. **Root start.**
   - Configuration `root` in `federation.json`. The acceptance variable came through a systemd drop-in with
     `docker exec -e`, because the unit itself is `docker exec`.
   - The first two starts failed at two spots in 3.8 that had been overlooked (see errors).
   - The third start ran.
4. **`addMember`** as the admin's supervisor command: phase `completed`, policy version 1.
5. **Routed writes.** Three writes through `root.space.write` landed in the member (entries
   `e29982a8a-1…3`). The routed counter returned 3. Both replicas stood at revision 10 with the same hash.
6. **Promotion of standby-100** with netcup fencing (nanoi `SHUTOFF`), then degrade to single: epoch 3,
   version 3.
7. **Takeover.** standby-100 offered its notice. On the next poll the root showed for `sync-member` the target
   `standby-100`, epoch 3, `replication` with version 3 and `recoveryId: root-degrade`.
8. **New direction.** Three more routed writes (`e29982a8a-4…6`). The counter returned 6, so all
   entries before and after the switchover. Since nanoi was switched off, the new entries could only
   land on 100 (head there at revision 20).

## Reset

- **host-a:** The state after 3.8 came back from the backup `/data/phase1b-backup-20261017-post38`: harness,
  `installed.sqlite`, journal of the main store and configuration. Before that the WAL files were removed, afterwards
  the drop-in.
  - The boot record is unchanged (version 10, single, epoch 3, version 5); the root did not trigger any
    replica transitions.
  - The control Space again holds 13 keys, without host-a's router and host keys. There is no
    routing policy.
- **nano-test and standby-100:**
  - nanoi released from quarantine (switched on), daemon stopped immediately.
  - Configurations from `*.before-root-20261017`, sync directories set aside
    (`sync-root.after-root-20261017`).
  - The original boot records written back; nano-test is `active` again with its two local
    Spaces.
- **vpsc:** `tls.json` and `fencing.json` from `*.before-root-20261017`. This removes the time-limited rights of the
  tool certificate on 100 again.
- **NetBird:** The dedicated group and policy `root-hosta-20261017` are deleted.
- **Baseline check afterwards:** fully green.

The reset lost all control writes that host-a received in the time window: the enrollments, the
member entry, the admin commands of the run and the harmless writes of the baseline checks. Whether there were foreign
control writes during that time was not checked.

## Errors found

Both errors concern a control store on primary/sync whose Space document keeps epoch 1 while
the journal stands at 3 after two degrades:

- **Journal guard of the root** (`federation-controller.ts`): It compared the lease with the epoch of the
  Space document and aborted the start with "RouterLease was superseded by Control". Fixed in `2be7885`.
- **Renewal of the kept router lease** (`delegation.ts`): After a restart it likewise checked the signature
  against the Space document and refused ("lease renewal no longer owns current epoch"). Fixed in
  `f0a879a`.

The 3.8 test now covers both paths and fails without the respective fix.

## Outages and operational findings

- **First failed start:** host-a was without control for about four minutes. During the manual reset, `stop` hit a
  process that was still starting and that ended on SIGTERM without cleaning up. The orphaned `owner.lock` from the same boot
  was removed after checking.
- **Second failed start:** The start script reset itself after less than 30 seconds.
- **Slow stopping:** With nanoi switched off, the root daemon needed longer than the 15 seconds of
  `stop`. It then ended by itself and removed its lock. An `ExecStop` failure has no
  effect on the process with `docker exec`; every step afterwards therefore checks the processes.
- **Ownership:** The configuration backups created as root on nanoi and 100 brought root as the owner along when
  copied back. The consequences were EACCES at start and a lock from the same boot.
  Fixed by `chown` and removing the lock after checking that no daemon was running.

Addendum: The slow stopping and the lock after a stop during start are fixed in `4d2eaac`. The
root first closes its member connections and waits at most 5 seconds for the heartbeat. The daemon catches
SIGTERM from the lock on, ends itself explicitly after cleaning up, and `stop` waits 60 seconds. The bundle
`f372966a` runs on host-a, nano-test and standby-100.

## Limits

- The run covers the takeover after promotion and degrade, not after `setStandby`.
- The delegation with `targetReplicaConfigVersion` before the takeover (`ReplicaConfigPending`) was not part of the
  measurement.
- For control transitions with an installed routing policy, step 6 is still missing.
