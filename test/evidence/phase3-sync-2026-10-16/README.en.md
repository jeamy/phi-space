# Primary/sync over real hosts: fencing, promotion, degradeToSingle, setStandby — 2026-10-16

Run of `test/testbed/scenarios/phase3-sync-run.ts --remote`, controlled from lux27:

- **Primary:** nanoi (netcup, IPv6 only), host `nano-test`.
- **Standby:** host 100 (home network, IPv4 only), host `standby-100`.
- **Connection:** over NetBird with relay.

On each host a bundled fixture node `phase3-sync-node.mjs` ran in the existing container, with its own journal
and storage; the federation daemon stayed untouched. The replicas spoke over the signed transport
(`src/replica-transport.ts`, host key, fixed counterpart, nonce and time window) on TCP 17432.

- **Boot authorizations:** in the independent register on vpsc.
- **Fencing:** real netcup power-off through the fencing service on vpsc.
- **Rights:** Only 100 had a certificate of its own for the run. It was allowed to write `boot:nano-test` and
  `boot:standby-100` in the register and to switch off at the fencing service. nanoi had only its reader certificate. A host
  that can be fenced never writes its own boot entry.

## Result (`report.json`, passed)

1. Five synchronous writes from nanoi, each confirmed by 100; both journal heads equal.
2. Listener on 100 stopped: The sixth write is sealed on nanoi (`CommitSealed`), not
   confirmed (fork, revision 6, `61712a21…`).
3. nanoi node stopped; 100 fences nanoi via netcup. The evidence reads `SHUTOFF`, autostart off,
   `restartLocked`; `verify` is `true`.
4. `promote` on 100: primary `standby-100`, epoch 2, nanoi entered as standby. At revision 6 stands on 100
   the configuration entry (`9de2c771…`), not the fork.
5. A write on 100 without a reachable standby stays sealed (revision 7).
6. `degradeToSingle` with the same evidence: The candidate from revision 7 is completed exactly once
   (`recoveredCommitted: [7]`), then single operation with epoch 3. Three writes in single operation.
7. Operator: `releaseHostToQuarantine` with netcup adapter. nanoi is switched on, its boot state is
   `quarantine`.
8. On nanoi the old sync history with the fork is set aside (`aside-…`); the node starts empty. Then
   `setStandby` from 100: full reload from revision 1 and confirmation of the new sync entry. Afterwards
   nanoi is active standby (version 4).
9. Three synchronous writes in the new direction, from 100 to nanoi.
10. Both materialized states are identical: 12 entries, same snapshot checksum and same
    journal head at revision 15. The fork is not included.

Total duration about one minute; nanoi was running again 16 s after switching on.

## Teardown (`cleanup.json`)

- Both boot entries are reset to their values before the run (`fenceHostBoot` had also revoked
  nanoi's federation authorizations).
- On nanoi the orphaned `owner.lock` was removed after PID check and `phi-spaces-nano` started.
- NetBird group and policy for 17432 are deleted, the nft runtime rule on 100 is removed.
- The rights of the control certificate in register and fencing service are withdrawn.
- Afterwards admin reading worked again on both hosts.

## Limits

- This run still used its own data incarnations per replica (`sync-nano-1`, `sync-100-1`, `sync-nano-2`).
  Since the following state, both replicas of a Space share exactly one incarnation, and the transitions enforce
  this.

- Fixture level: a sync Space of its own next to the federation daemon, not the production Space service.
- The transport authenticates through fixed host keys, not through gate and grants.
- There is no fencing adapter for 100. `degradeToSingle` on nanoi with 100 as the failed standby is
  therefore not acceptable.
- Pausing all write sources including the reaper is not checked, nor is the control Space on
  primary/sync (3.8).
