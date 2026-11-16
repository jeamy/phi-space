# Overall operation 3.7: partition, process aborts and failover through the production service — 2026-10-17

Real run on nanoi (`nano-test`, primary) and host 100 (`standby-100`, standby) with the driver
`test/testbed/scenarios/phase3-partition.ts`. The data is in `report.json`.

- **Space:** `jobs-part` (`sp-233186d7-…`), primary/sync, one phi-spaces store each.
- **Clients:** wrote through the gate with key proof and admin grant from host-a.
- **Writes:** one every 2 seconds, each with its own number and request ID. An unclear outcome
  (`CommitSealed`, timeout, connection abort) was repeated with the same ID until it was decided.
- **Bundle:** first `ef99a5fb` (state `523831b`), from `partition-bounded` on `88842c99` (state `f96a7f7`).

## Result (passed)

| Phase | Writes | confirmed immediately | after resolution | `CommitSealed` replies | longest open time |
|---|---|---|---|---|---|
| Partition 60 s | 11 | 10 | 1 | 1 | 77 s |
| Partition 10 min | 30 | 29 | 1 | 122 | 602 s |
| Partition 3 min, bounded wait time | 10 | 9 | 1 | 73 | 205 s |
| Standby ended by SIGKILL | 36 | 35 | 1 | 2 | 11 s |
| Primary ended by SIGKILL | 29 | 28 | 1 | 0 | 13 s |

- **Without loss:** After each phase every decided write stood exactly once in the Space, 116 in total,
  and the journal heads of both replicas were equal.
- **Partition:** An nft rule on 100 discarded everything from nano's overlay address. Other Spaces of nanoi stayed
  usable, read and count calls on `jobs-part` answered `CommitSealed`. After healing, nanoi resolved the
  sealed candidate itself and served the Space again without restart.
- **Process aborts:**
  - The daemon was ended by SIGKILL; the operator step removed the lock `owner.lock` after the process
    was gone; systemd restarted.
  - With the standby, the open write was confirmed after its restart.
  - With the primary, the client got `ECONNREFUSED` in the meantime and received the one result after the restart.
- **Failover with `NotCommitted`:**
  1. Fresh generation, then standby stopped.
  2. One write was sealed only on nanoi (revision 120).
  3. `promote` with netcup fencing (`SHUTOFF`), then `degrade` (epoch 3).
  4. On 100 `resolveOperation` answered the request with `NotCommitted`; the late original call got
     `NotCommitted` as well. The entry appeared on no replica.
- **Way back:** release into quarantine, `wipe`, `set-standby`, `readmitSpace`, restarts.
  - Afterwards both materialized replicas are equal: 116 entries, same snapshot checksum, head 123.
  - The fork stands only in the set-aside history of nanoi.

## Error found

- **Unbounded waiting for the standby:** In the first two partitions the primary waited for the standby's reply as
  long as the cut-off TCP connection existed.
  - Reading continued, but writes hung for minutes before `CommitSealed` came.
  - Fixed in `f96a7f7`: `socketTransport` now has a reply deadline (`requestTimeoutMs`), the replica peer
    waits 15 seconds.
  - The third partition shows the result: About 19 seconds after the cut, reads already answered
    `CommitSealed`; 30 seconds after healing the write was resolved.

## Incidents

- **`kill` in the driver:** The first attempt at the standby abort called `docker exec … kill`; in the image, however, `kill`
  is only a shell command. Fixed through `sh -c`, step repeated.
- **Crash of `set-standby`:** The first attempt aborted in the sync tool with an unhandled exception. The
  cause was lost because the driver kept only the last output line.
  - Continuing by hand with the same transition ID succeeded; nanoi left quarantine.
  - The driver now keeps the tool's output in full.

## Teardown

- Boot entries reset to the state before the run.
- Configurations without `syncSpaces` restored.
- nft rules and NetBird policy removed.
- Rights of the control certificate on vpsc withdrawn and the certificate on 100 deleted.
- The baseline check afterwards was green.
- **Kept:** the bundle `88842c99` (backups `*.before-part-20261017`) and the sync stores as evidence.

## Limits

- **No router delegation:** The writes ran with admin grants.
- **Degrade with fencing adapter:** `degrade` ran with netcup fencing; the path without adapter (`revokeStandbySpace`) is
  not yet supported by the sync tool.
- **Process abort with operator step:** The lock `owner.lock` of the same boot was removed by the driver after the
  PID check, not by the daemon.
- **Not checked:** Failure of a NetBird agent and exhausted storage.
