# Automated primary/sync cycle in the federation daemon — 2026-10-17

Third real run on nanoi (`nano-test`) and host 100 (`standby-100`), this time fully controlled by the
driver `test/testbed/scenarios/phase3-daemon-cycle.ts`. Daemon bundle `b10c160b…`, Space `jobs-cycle`
(`sp-a5274943-…`, incarnation `bfcc180d`).

## Result (`report.json`, passed)

The driver executed all 17 steps without manual intervention:

1. Preliminary check.
2. Five synchronous writes.
3. Standby stopped.
4. Sealed fork on nanoi (revision 8).
5. `promote` with netcup fencing.
6. `degrade`.
7. Start of the new primary.
8. Three writes in single operation.
9. Release of nanoi into quarantine.
10. `wipe` of the old history.
11. Quarantine start.
12. `set-standby`.
13. `readmitSpace` of the remaining Spaces.
14. Start of the old primary as standby.
15. Start of the new primary.
16. Three writes in the new direction.
17. Comparison.

Result of the comparison:

- Both replicas have 11 samples, the same snapshot checksum and the same journal head at revision 18.
- At revision 8 a different entry stands on 100; the fork lies only in the set-aside history of nanoi.

The core phase from switching off to the comparison took about four minutes.

The orphaned `owner.lock` after the hard power-off was removed by the daemon on nanoi itself, because it came from
an earlier boot (`staleOwnerLockCleared`, `boot_id` in the lock). A PID check by the
operator was no longer necessary.

## Interruptions

- **Local NetBird connection:** The first start failed on the connection of lux27. Tailscale had removed the local
  exception in `ts-input`, and the local NetBird client hung. After restarting the client and narrow
  exceptions only for replies of the three gates on 7421, the driver continued.
- **Errors in the driver:** A run uncovered two errors:
  - The heredoc was attached to `grep` instead of the tool.
  - `journalctl --since` was called with UTC against CEST hosts.

  Both were without consequence, since the checks detected the missing transition. Fixed: input directly to
  `docker exec`, timestamps as epoch seconds of the target host, success checks after `promote` and `degrade`. Afterwards
  the driver continued from `promote`.

## Teardown

- Boot entries and configurations reset to the state before the run.
- NetBird policy and nft rule removed, rights of the control certificate withdrawn.
- Afterwards admin reading worked on both hosts.

## Limits

- Writes with admin grants, not through router delegations. host-a has no native root, and the
  router takeover is still checked only locally.
