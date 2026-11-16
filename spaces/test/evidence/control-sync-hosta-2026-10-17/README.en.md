# Control store of host-a on primary/sync — 2026-10-17

First real run of 3.8: The existing main store of `phase1b-host-a` with the control Space
(`sp-75fb6996-…`) and the sibling Space `default` (`sp-a1eadc94-…`) was put onto primary/sync by bootstrap.
Afterwards it went through the cycle `setStandby` → `degradeToSingle` twice with the standby
`control-standby-nano`, a `replica-listen` unit on nanoi. In the end host-a runs `single` again.
The data is in `report.json`.

## Procedure

| Step | Result |
|---|---|
| Backup | Store, configuration, bundle and signer in the container (`/data/phase1b-backup-20261017`), unit file on big |
| `main-sync bootstrap` | Revision 1; the store checksum after the last chunk matches |
| `set-standby` `control-standby-1` | sync, epoch 1, version 2; standby head on nanoi at revision 8 (`0e982e25…`) |
| `degrade` `control-degrade-1` | single, epoch 2, version 3; netcup evidence `SHUTOFF` for server 964249 |
| Release `control-release-1` | Boot record of `control-standby-nano` in `quarantine`, permit `revoked/standby`; nanoi runs again |
| Standby emptied | old replica moved to `replica.after-degrade-1`; listener starts at revision 0 |
| `set-standby` `control-standby-2` | sync, epoch 2, version 4; standby head after the degrade at revision 16 (`50fc0708…`) |
| `degrade` `control-degrade-2` | single, epoch 3, version 5; `SHUTOFF` again |
| Release `control-release-2` | nanoi in quarantine again and started; the unit `phi-spaces-control-standby` stays disabled |

Before and after each transition a baseline check ran: admin reading and a harmless write in the control
Space, plus `info`/`stats` at every member gate.

- All checks passed, with one exception: After a degrade `nano-test` is not reachable as long as
  nanoi is switched off. That is expected.
- Immediately after the second restart of nanoi one check ran into a timeout again,
  because the NetBird relay connection was not yet up. The run a minute later was fully green
  (`baseline-6-final`).

The boot records at the end are in `bootRecordsFinal`:

- host-a is `active/primary/single` for both Spaces with epoch 3 and version 5 (`control-degrade-2`).
- `control-standby-nano` stands in `quarantine`; its permit is revoked.

## Incident: daemon did not end after SIGTERM

When stopping before `control-standby-2`, two `run` processes were running in the container. Cause:

1. The daemon from the first sync operation (restart after `control-standby-1`) had closed its harness on SIGTERM
   and removed `owner.lock`.
2. But it stayed alive because the standby transport, journal and register client of the main store stayed open.
   The `ExecStop` before `control-degrade-1` therefore failed unnoticed; systemd ended only the
   `docker exec` client.
3. `control-degrade-1` and the baseline check after it therefore ran with this orphaned process. It had already closed its
   harness, but journal and transport were still open.
4. The next start got the lock, and `stop` rightly refused to work afterwards ("ownership disagrees").

Fix:

- The hanging process (harness already closed) was ended by the operator; the current process was ended by `stop`
  in the regular way.
- `federation-host` now closes these handles in `cleanup`. Bundle `74f3f071…` is deployed on host-a.
- After `control-standby-2` the daemon in sync operation ended without a remaining process.

## Limits

- The promotion of the control replica and step 6 (transitions once a routing policy exists) are not
  implemented. `main-sync` rejects both.
- The standby on nanoi served only acceptance; host-a stays permanently `single`.
