# Promotion of the control replica with native root — 2026-10-17

Real run of the router switch (v3 5.2) at a control promotion, in both directions:

- host-a → host-c → host-a, under the same authority, with container fencing on big.
- On host-a ran a native root with routing policy and the replicated member `promo-member`, a
  single sync Space on standby-100.
- The root moved to the new control host each time, the members followed during operation.
- Afterwards host-a was reset as agreed.

The data is in `report.json`.

## Preconditions

- **Bundle:** A single bundle (`0f64da41`) ran on host-a, host-c and all four members; the checksums
  were compared before the first transition.
- **Restart policy:** nano-test and standby-100 had `Restart=no`. A drop-in sets `Restart=on-failure` there;
  it stays, because following during operation depends on it. member-1 and restore-target now wait
  75 seconds when stopping.
- **Fencing service:** Checked from both containers with a no-effect `verify` request.
- **Root keys:** Router and host keys for host-a and host-c, both enrolled at host-a. host-c used
  `enroll-key` with target host-a for this.
- **Root configuration on host-c:** the same root block as on host-a (ID, members), only with its own
  key and lease files and `takeover`.

## Result

1. **Root on host-a:** `addMember` (policy version 1), then three routed writes, the last in
   sync operation with host-c as standby.
2. **Promotion on host-c:** Fencing of host-a, `degrade` to single (epoch 9). Afterwards the change was
   recorded.
3. **Root takeover on host-c:** host-c started at 14:18:12 UTC; the root waited until the lease of host-a
   had expired and was ready at 14:18:34. Its lease: router epoch 2 with its own router key,
   control epoch 9.
4. **Members followed during operation:** All four reported `controlHostChanged`, ended with code 75,
   were restarted by systemd and were ready without outside intervention.
5. **Root on host-c works:**
   - The routed writes continued the entries (`e0687995b-4` …), the count returned 5.
   - The `EpochNotice` arrived at the member (router epoch 2, control epoch 9, policy 3); before that, two
     attempts failed because standby-100 was just restarting.
   - The epoch mark of the member shows the same values.
6. **Way back:**
   - Release of host-a, `wipe`, `set-standby` host-c → host-a, promotion on host-a with fencing of host-c,
     `degrade` (epoch 11).
   - host-a took over its superseded root lease after the lease of host-c expired (14:24:35, ready 14:24:46) with
     router epoch 3.
   - The members again followed by themselves. A routed write through host-a returned entry 7, the
     count 7. The `EpochNotice` arrived with router epoch 3.

## Reset

- **host-a:** The files came back from the backup that was created after distributing the bundle; the
  boot record is written back to epoch 7, version 11. The control Space holds 13 keys, there is
  no root and no policy.
- **standby-100:** Configuration back, member Space removed, boot record restored.
- **host-c:** Container, volumes, unit and NetBird peer are removed; the boot entry is decommissioned.
- **vpsc and NetBird:** Rights and policy reset or removed, respectively.
- Backups and auxiliary files are deleted.
- The authority entry keeps the two host changes of this run as history.

## Limits

- Both control hosts ran on big and were thus in the same failure domain.
- Already admitted root operations that were open across a change did not exist in this run;
  new operations before and after each change are what was checked.
