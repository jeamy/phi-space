# primary/sync in the federation daemon over real hosts — 2026-10-16

Second real run. Unlike the [fixture run](../phase3-sync-2026-10-16/README.en.md), the sync Space this time ran
in the production federation daemon (`federation-host.mjs`, bundle `1cb5d7f1…`):

- **Hosts:** nanoi (`nano-test`, primary) and host 100 (`standby-100`, standby).
- **Space:** `jobs-sync`, `sp-0bcf8f0d-…`, shared incarnation `67a91007`.
- **Storage:** one phi-spaces store each, provisioned through `syncSpaces`.
- **Access:** Clients wrote through the gate with key proof and admin grant.
- **Transitions:** ran through the tool mode `sync` of the daemon with the service stopped.

## Procedure (`report.json`, passed)

1. New bundle on both hosts, normal restart, admin reading checked. Then `syncSpaces` provisioned. 100
   started first as standby, then nanoi as primary; the creation of the Space was already confirmed synchronously
   (revision 1 on both).
2. Five writes through the gate of nanoi, each confirmed by 100; both journal heads at revision 7.
3. Daemon on 100 stopped. The next write was sealed on nanoi (revision 8, `3d50bed0…`,
   applied up to 7). The client received "commit is durably sealed".
4. On 100 `sync promote`: netcup fencing of nanoi (`SHUTOFF`, autostart off). Afterwards primary `standby-100`,
   epoch 2.
5. `sync degrade` with renewed evidence: single operation with epoch 3. Daemon on 100 started, three writes
   through the gate of 100; `hello` reports epoch 3 from the journal.
6. Operator: `releaseHostToQuarantine` with the netcup adapter. On nanoi:
   - the orphaned `owner.lock` removed after PID check;
   - the old sync history with the fork set aside by `sync wipe`;
   - the daemon started. It ran in the new quarantine mode and kept only the replica listener ready.
7. On 100 `sync set-standby`: nanoi loaded the chain afterwards and confirmed the new sync entry (version 4). The
   quarantine daemon on nanoi recognized `active` and ended itself with a notice. Afterwards:
   - Operator: `readmitSpace` for the two federation Spaces of nanoi;
   - normal start of nanoi: takes over the admitted authorizations and serves the sync Space as standby;
   - start of 100.
8. Three synchronous writes in the new direction, through the gate of 100 to nanoi; both journal heads at
   revision 18.
9. Comparison with the daemons stopped after materialization: both replicas with 11 samples (5 + 3 + 3) and the same
   snapshot checksum `3a1c9678…`. At revision 8 stands `6e109ac6…` on 100; in the set-aside history of
   nanoi the fork `3d50bed0…`.

## Errors found

Both are fixed in the code and covered by tests.

- **Distribution bypassed:** In the real daemon there is an upstream service for notices (delegation, run gates).
  Its `handleText` bypassed the distribution, and calls to `jobs-sync` landed in the main store ("unknown space").
  Fixed in `13039dc`; the runtime test now starts the member with this service.
- **Local authorization missing:** Before the run it was noticed that nobody installed the local boot authorization of the
  sync Space. `openSyncSpace` has taken it over since `70b7bf6`.

## Teardown (`report.json`, `cleanup`)

- Boot entries of both hosts reset to their values before the run; the federation authorizations of nanoi
  are active.
- Configurations restored from `federation.json.before-sync-20261016`, that is without `syncSpaces`.
- NetBird policy and nft runtime rule removed, rights of the control certificate withdrawn in register and fencing service.
- Afterwards admin reading worked on both hosts.

Kept:

- the new daemon bundle; the old ones lie next to it as `federation-host.mjs.before-sync-20261016`;
- the sync stores together with the set-aside history as evidence.

## Limits

- **No router:** host-a on big runs with the old bundle and rejects `replicaNotice`; the router therefore did not
  take over the notice. The takeover is checked only locally.
- **Grants instead of delegations:** The clients wrote with admin grants, not through router delegations.
- **Manual steps:** Operator steps (release, PID check, `wipe`, `readmitSpace`, restarts) ran by
  hand, not automated.
