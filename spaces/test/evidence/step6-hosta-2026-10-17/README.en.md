# Step 6 for real: control transitions with routing policy on host-a — 2026-10-17

Real run of the control special case from v3 5.3.1 step 6 with the bundle `c04fd5b5` (state `3e817bb`). On
host-a a native root and a routing policy were running. The control store went through `setStandby` and `degradeToSingle`.
Until now `main-sync` rejected that as soon as a policy was installed. Afterwards everything was reset to the state
before the run. The data is in `report.json`.

## Setup

- **Control standby:** new identity `control-standby-nano-2` as `replica-listen` on nanoi, boot entry in
  quarantine.
- **Rights:** control certificate for host-a with time-limited register and fencing rights on vpsc, plus fencing pin,
  ufw rule 17423 and a dedicated NetBird policy for 17433.
- **Root:** Router and host keys via `enroll-key`; host-a was briefly also in `space-enroll` for this.
  Root configuration through the start script with automatic reset.
- **Member:** `step6-member` as a single sync Space on standby-100. It stays reachable when the control degrade
  switches nanoi off.
- **Policy:** `addMember` created it with version 1. A routed write went through.

## Result

1. **`set-standby` with policy:** sync, epoch 3, version 6. After the restart the policy stands at version 2,
   the increase through the reconciliation at start. The routed write went through.
2. **`degrade` with policy:** single, epoch 4, version 7, netcup evidence `SHUTOFF` for nanoi.
3. **Root restart after the lease expired:**
   - The kept lease (epoch 3) expired at 11:37:56 UTC; host-a started at 11:38:23. So only the
     signed renewal path counted.
   - The lease renewed itself with the same ID and router epoch 1 in control epoch 4. That is exactly what prevented the start
     in the previous root run without step 6.
4. **After the degrade:** Policy version 3. A routed write went through, the routed count returned 3.
5. **Member:** Its epoch mark in the store of the member Space rose from epoch 3/policy 1 through policy 2 to
   epoch 4/policy 3. No error was logged on host-a when sending the `EpochNotice`.
   - Whether the mark comes from the notice or from the first delegation of the new epoch cannot be told apart in the
     store.
6. **Stopping:** Every stop of host-a with root ended in about 2 seconds without a remaining process. On stopping,
   "phi-spaces supervisor: Error: database is not open" appears once: The supervisor tick runs against the already
   closed store. This is harmless and not yet fixed.

## Reset

- **host-a:**
  - Files back from the backup before the run: harness, `installed.sqlite`, journal of the main store,
    configuration, `private/` and `pki/` without control certificate. The drop-in is removed.
  - The boot record is written back to epoch 3, version 5 (register version 15).
  - The control Space again holds 13 keys, without root key; there is no policy.
  - The new bundle stays.
- **standby-100:** Configuration back, member Space removed, boot record restored.
- **nanoi:** released (switched on). Unit and directory of the control standby are removed.
  `boot:control-standby-nano-2` is decommissioned (`fenced`, without permits).
- **vpsc and NetBird:** `tls.json` and `fencing.json` back, ufw rule removed, NetBird group and policy
  deleted.
- **Baseline check afterwards:** green. Afterwards the backups were removed.

The reset lost all control writes of host-a in the time window of the run: the enrollments,
the member, the admin commands and the writes of the baseline checks. Whether there were foreign writes was not
checked.
