# Real fencing run against nanoi via the netcup SCP API — 2026-10-16

First real run of the netcup fencing adapter (`src/netcup-fencing.ts`). The fencing service ran on vpsc
(`phi-spaces-fencing.service`); the run was controlled from lux27 with the operator certificate. The script
is not in the repository; the procedure is given completely in `report.json`.

Procedure and result (`report.json`, times in UTC):

1. `boot:nano-test` version 1, `active`, two active Space authorizations; gate `100.89.28.88:7421` reachable.
2. `fenceHostBoot`: host `fenced`, both authorizations `revoked`.
3. `fence` through the service, 7.2 s: autostart off, hard power-off, afterwards server 964249 `SHUTOFF` with
   `autostart: false`. Evidence `kind: cloud`, `restartLocked: true`.
4. `verify`: `true`. The gate was not reachable during the fencing.
5. `releaseHostToQuarantine` with adapter, 9.9 s: boot state `quarantine` (authorizations stay `revoked`),
   autostart restored, server switched on. `verify` afterwards `false`.
6. The original boot value was restored by operator CAS (version 4, `active`).

Finding: After the hard power-off, the owner lock `/data/nano/owner.lock` of the test daemon remained. As
intended (`test/testbed/federation-host.ts`), the daemon therefore did not start by itself. The operator checked
that the recorded process (PID 8) no longer existed in the container, removed the lock and started
`phi-spaces-nano`. Afterwards the service was `ready`, and an admin read the data Space over the overlay. The gate therefore stayed
unreachable for about six minutes; that is not due to the fencing.

Limits:

- What is checked is the fencing building block (F1): switching off, evidence, verification, release into quarantine.
- No promotion and no degradeToSingle with real primary/standby data.
- The standby slot is not yet determined.
- Phase 3 is thus not accepted.
