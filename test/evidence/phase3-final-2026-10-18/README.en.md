# Last acceptance run of Phase 3 — 2026-10-18

Real run for the open rows of the [acceptance matrix](../../../docs/_attic/abnahme/ap3-abnahme.en.md) on nanoi (`nano-test`),
host 100 (`standby-100`) and host-a (control and native root). Drivers:
`test/testbed/scenarios/phase3-final.ts` (part A) and `phase3-final-root.ts` (part B). The data is in
`report.json`.

## Part A (passed, bundle `3b562462`, state `44a924a`)

| Row | Procedure | Result |
|---|---|---|
| S1 | Merge replication (`Sensor` lww, `Fact` set) in the `default` Space of both hosts, nft partition 656 s | Both views equal. An older put does not revive the tombstone; the renewal survives the expiry of the first version; after the winning version expires the older one stays invisible; remove against renew: add-wins; the shared key converges. Deleting and renewing ran through `lease` (decision of today). |
| B4 | SIGKILL of the daemon on 100, then on nanoi, during writes on `jobs-a` | The restarted daemon cleared the lock itself (`staleOwnerLockCleared`, `processGone`, same boot). 57 writes, all exactly once. |
| B2 | NetBird agent on 100 stopped for 120 s (transient unit, SSH over LAN) | One write stayed open for 141 s (51 `CommitSealed` replies) and was decided afterwards. The daemon on 100 kept running without restart and without errors; its gate answered again afterwards. 102 writes, all exactly once. |
| B3 | `jobs-full` with 1 MiB journal, writes of 8 KB | After 57 writes `ResourceExhausted` before sealing; reading continues, journal heads equal, another Space writable. A full disk (ENOSPC) was not checked. |

Limit of B4: After the SIGKILL the driver waited for the restart before writing on; there was no write in flight
during the abort here (the run of 2026-10-17 covers that).

## Part B (root on host-a, member on primary/sync)

First attempt with `jobs-root`/`final-member`: abandoned. The "fork" was the router's generation assignment, not
the write; its child step, created later, failed on the old policy version. This led to the corrections
below and a rebuild (host-a from the backup, new Space `jobs-root2`, member `final-member-2`).

| Step | Result |
|---|---|
| Routed writes, nft partition 3 min | One write stayed open for 196 s and was decided with the same request ID. |
| Fork | Write of a routed transaction (uses its generation); the sealed candidate on nanoi is demonstrably the write. |
| Promotion of 100 with netcup fencing, degrade, takeover of the notice | passed |
| Resolving the fork at the successor | **Finding:** The member rejected the resolution with `StalePolicyVersion`, because the takeover had raised the policy version; step in review, without effect. Fixed in `91e24c1`, proven locally; not repeated for real (see below). |
| Way back with `set-standby` while the root runs | Writes in the meantime decided without checking; one open for 141 s (transition lock). |
| B5: degrade without fencing adapter (`revokeStandbySpace`) | Candidate completed locally (revision 39), nanoi stayed active, only its authorization for the Space revoked. The root resolved the routed write **at the successor** (same host, epoch 4) with the original result. |
| Way back after B5 | nanoi emptied, started normally, standby again via `set-standby`; 14 decided writes exactly once, none of the rejected ones with effect. |

The driver state was supplemented by hand: `not-committed` as a finding, `release` by the operator before continuing,
`revokeCandidate` from `recoveredCommitted` after the interrupted step. Bundled, `58bd80cd` (`0f7e280`),
`e6b15996` (`91e24c1`), `8469912f` (`6a13da7`) and `ebb87f58` (`275924a`) ran in turn on all three
hosts.

The `ReplicaConfigPending` window did not occur distinguishably in the run: No write reported "not adopted by
the router yet"; three reported "bound child outcome is unresolved", which can also be the window. It counts as proven
locally (`test-delegation`).

**`NotCommitted` through the root (passed, bundle `ebb87f58`, state `275924a`):** For this, host-a was first reset to the
state before the run (comparison of the control entries: only entries of this run). A fresh root with
only `final-member-4` (`jobs-root4`, nanoi primary): fork as a write of a routed transaction, sealed only on
nanoi; promotion of 100 with netcup fencing, degrade, takeover of the notice; the root resolved the fork step at the
promoted primary with the bound epoch as `NotCommitted`; the fork had no effect anywhere.

A previous cycle (`jobs-root3`, `final-member-3`) got stuck:
`addMember` stands in phase `committed` (policy version 6, member `adding`), without a result; neither a new command
nor a restart of host-a resumed it. The trigger was presumably the `policy` instruction to `final-member-2`, which stayed sealed on
100 as long as nanoi (locked, see below) was unreachable. That is a finding of its own.

## Errors found and fixed

| Commit | Error |
|---|---|
| `9a74630` | A full sync journal locked the whole session (every read failed until restart). |
| `f93bd67` | The router could not resolve open steps after promotion/degrade; `ReplicaConfigPending` ended writes for good (decision: resolution at the successor). |
| `91e24c1` | The resolution of an unknown request failed on the policy version raised by the takeover. |
| `6a13da7` | host-a wrote nothing from 11:48 UTC on: A Space above a journal commit forced a base after 500 deltas that did not fit (latent since 3.8). |
| `275924a` | An emptied replica that names the genesis as primary closed its listener without authorization. |

## Incidents

- big restarted at 09:56 UTC; host-a then hung in a stale network namespace of its sidecar
  (a container restart fixed it; member-2 and host-b were affected as well, not touched).
- vpsc restarted around 13:10 UTC; register and fencing were unreachable in between.
- Fail2Ban on big blocked nanoi (IPv6, `ufw-scan`); nanoi did not reach the NetBird management (`DirectoryDown`).
  The rule was removed with consent; Fail2Ban may block again.
- Docker on nanoi was stopped at 11:21 UTC after two `daemon-reload` from a foreign SSH session.
- The notice of the old Space `jobs-part` (run of 2026-10-17) is still on the notice board and is rejected at every
  heartbeat.
- On 100, `iifname "wt0" accept` stands before the rules from `/etc/nftables-pi-host.nft` (not from this run).

## Teardown

- host-a from the backup before part B (harness, `installed.sqlite`, journal of the main store, configuration,
  `private/`, `pki/`), root drop-in removed, boot record written back. The comparison of the control entries before
  each reset showed only entries of this run (enrollments, `addMember`, `auditLog`, router and
  host keys). The control Space again holds 13 keys, there is no root and no policy.
- nanoi released; configurations of both hosts from `federation.json.before-final-20261018`; boot records set to
  the values before the run.
- nft release and partition rules on 100 removed, control certificate on 100 deleted; NetBird group and policy
  `final-20261018` deleted.
- Baseline check afterwards green.
- Kept: the bundle `ebb87f58` on all three hosts, the backups (`/data/phase1b-backup-final` on host-a,
  `*.before-final-20261018` on nanoi and 100) and the sync directories as evidence.
- Open with the operator: withdraw the time-limited rights of the control certificate on vpsc (`tls.json` and
  `fencing.json` from `*.before-final-20261018`).
