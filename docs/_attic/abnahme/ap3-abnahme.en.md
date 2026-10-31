# Phase 3: Acceptance Matrix

As of 2026-10-18. **Phase 3 is not accepted.** This matrix matches every acceptance criterion against the
existing tests and real runs. The yardstick is the [implementation plan](../implementierungsplan-v3.en.md):
v3 §11 stage 3 and all rows "3" from §12.1, real with a fencing adapter.

**Classification** according to v3 §11 and §12:

- NetBird, platform and fencing assumptions need a real run. Everything else counts as met with persistent local
  tests on JSONL and SQLite. MemoryStorage alone is no evidence.
- **met:** evidence present, locally and, where necessary, real.
- **partial:** part of the expectation is not checked; the missing part is named.
- **open:** no evidence.

Evidence is under `test/evidence/`, tests under `test/`.

## v3 §11 Stage 3

| # | Criterion | Local | Real | Status |
|---|---|---|---|---|
| S1 | 10-minute partition with concurrent writes, deletes and renewals converges | `test-entry-replication`, `test-entry-replication-stream`, `test-merge-service` (delete and renew via `lease`) | through the service 656 s with writes, deletes, renewals and expiry (`phase3-final-2026-10-18`); primary/sync 10 min (`phase3-partition-2026-10-17`) | met |
| S2 | An old put does not revive a tombstone | `test-entry-replication`, `test-entry-compaction` (tombstone with older put) | `ap3-overlay-2026-10-15`, `merge-run-2026-10-17` | met |
| S3 | Natural expiry does not delete a newer renewal | `test-entry-renewal`, `test-entry-compaction` (expiry with renewal) | `ap3-overlay-2026-10-15` (renewals during the partition) | met |
| S4 | Snapshot under load loses nothing | `test-entry-snapshot-transfer` (concurrent writes until publication), `test-bootstrap` (changed store is rejected) | — (no overlay assumption) | met |
| S5 | Without a standby no confirmation | `test-primary-sync`, `test-commit-sealed`, `test-replica-control` | `phase3-sync-2026-10-16`, `phase3-daemon-sync-2026-10-16`, `phase3-partition-2026-10-17` | met |
| S6 | Promotion refused without verified fencing evidence, with a marker adapter or on the wrong standby | `test-replica-control` (simulator, unconfigured adapter, wrong host, standby in quarantine), `test-degrade-revoke` (excluded standby), `test-netcup-fencing` | netcup `verify` (`f1-netcup-2026-10-16`) | met |
| S7 | Old router can delegate nothing after lease expiry | `test-delegation` (expired lease, higher epoch), `test-configured-root` (takeover only after expiry) | `root-promotion-2026-10-17` | met |
| S8 | Confirmed results are preserved after promotion | `test-not-committed` (confirmed request keeps its result) | `phase3-partition-2026-10-17` (every decided write exactly once), `phase3-daemon-sync-2026-10-16` | met |
| S9 | Old primary starts after `release` only in quarantine | `test-replica-control` (quarantine opens only the replica listener) | `phase3-daemon-sync-2026-10-16`, `phase3-partition-2026-10-17` | met |
| S10 | Older lww version does not become visible after the winning version expires | `test-entry-replication`, `test-entry-replication-stream` | `ap3-overlay-2026-10-15` | met |
| S11 | Standby failure blocks confirmations; `degradeToSingle` without standby fencing is refused | `test-replica-control`, `test-degrade-revoke` (rejected without evidence and without `revokeStandbySpace`) | `degrade` with netcup fencing in all sync runs | met; since 2026-10-17 revoking the Space authorization counts as a standby block (v3 §5.3.1 step 2) |
| S12 | Policy with a primary member in an expand or lww rule is rejected | `test-replica-control` (policy validator) | — | met |

Further contents of the stage:

- Control Space on primary/sync: `control-sync-hosta-2026-10-17`, `control-promotion-2026-10-17`.
- Router lease over sync commits: `step6-hosta-2026-10-17`.

## v3 §12.1, Rows "3"

| # | Failure sequence | Local | Real | Status |
|---|---|---|---|---|
| K1 | Standby persists batch, ACK lost; primary dies; then `degradeToSingle` | `test-replica-control` (ACK lost, primary gone, degrade: candidate exactly once, retry receives the stored result); `test-primary-sync` (`lostAck`) | — | met |
| K2 | Primary process dies after sealing before send, reopen of the original storage; standby unreachable; fencing and single | `test-replica-control` (candidate completed locally, visible exactly once), `test-primary-sync` (damaged marker or hash blocks) | `phase3-sync-2026-10-16` (`recoveredCommitted: [7]`) | met |
| K3 | Primary storage is lost after sealing; standby lives; fencing and promotion | `test-not-committed` (negative claim, `NotCommitted`, confirmed ones remain) | `phase3-partition-2026-10-17` (failover with `NotCommitted`) | met |
| K4 | Take confirmed, answer lost, then promotion; retry with updated frame | `test-not-committed` (old frame `StaleEpoch`, new frame returns the stored take without a second one, different arguments `RequestConflict`) | — | met |
| K5 | First start without boot authorization, stale evidence after `setStandby`, promotion in quarantine | `test-recovery` (boot check per Space), `test-replica-control` (promotion in quarantine rejected, replicas equal after `setStandby`, evidence from before the release authorizes no `degrade`) | `phase3-daemon-cycle-2026-10-17` | met |
| K6 | Switch a remote data Space to single while control is offline | `test-delegation` (`ReplicaConfigPending` until takeover), `test-replica-control` (takeover only after register) | `root-hosta-2026-10-17` (takeover of the notice) | met; control was reachable in the real run |
| K7 | Control promotion without an available standby, then set up a replacement | `test-replica-control` (after promotion without standby writes stay blocked), `test-control-host-change` | `control-promotion-2026-10-17`, `root-promotion-2026-10-17` | met |
| K8 | ACK loss and restart during `setStandby`; old replica returns | `test-replica-control` (lost confirmation of the target: no write and no second transition, the same ID completes; old replica cannot promote), `test-degrade-revoke` | `phase3-partition-2026-10-17` (aborted `set-standby` continued with the same ID) | met |
| K9 | Successful request, claim and generation cleaned up, then promotion and old retry | `test-not-committed` (after expiry of result period and admission: clarification and retry `RequestExpired`, no new effect) | — | met |
| K10 | Unknown old request against a delayed original call; crash after negative claim | `test-not-committed` (negative claim first: original without effect, also after restart; original first: effect with its own claim, the clarification finds it) | `phase3-partition-2026-10-17` | met |
| K11 | Two Spaces on one host with different replica versions; transition of one Space, then reboot of both hosts | `test-replica-control` (boot guard, readmission per Space), `test-degrade-revoke` (other Space remains) | `phase3-partition-2026-10-17` (main store single next to `jobs-part` sync, restart of both hosts) | met |
| K12 | Abort between local promotion/degrade/`setStandby` and external boot reconciliation | `test-replica-control` (all three: crash before the boot CAS, the same ID continues, `assertSyncPrimary` blocks every commit including grants) | — | met |

## Operations (v3 §12 Integration, Recovery, Load)

| # | Item | Status |
|---|---|---|
| B1 | Router delegation to a sync Space during operation | real (`phase3-final-2026-10-18`): routed writes through partition, promotion, degrade with and without adapter, return paths with `set-standby` while the root runs; clarification at the successor after degrade (original result) and after promotion (`NotCommitted`, fork without effect); the `ReplicaConfigPending` window only locally (`test-delegation`) | met |
| B2 | Failure of a NetBird agent | real (`phase3-final-2026-10-18`): 120 s agent off on the standby, write sealed and decided afterwards, daemon without restart | met |
| B3 | Exhausted storage | real (`phase3-final-2026-10-18`): full journal rejects with `ResourceExhausted`, reading and another Space continue; locally `test-primary-sync`, `test-entry-replication`; ENOSPC not checked | met (journal budget) |
| B4 | Process abort without operator step | real (`phase3-final-2026-10-18`): SIGKILL on both hosts, lock cleared by the daemon itself (`processGone`); locally `test-replica-control` | met |
| B5 | `degrade` without fencing adapter in the sync tool | real (`phase3-final-2026-10-18`): candidate completed locally, host active with revoked authorization, return path via `wipe` and `set-standby`; locally `test-degrade-revoke` | met |

## Open for Acceptance

- Finding from the run of 2026-10-18: A member admission (`addMember`) interrupted after phase `committed`
  does not continue and blocks further membership commands. **Fixed locally, not rechecked in a real run.**
  - Continuation already happened before: the supervisor calls open commands every second and again after a restart.
    The block on further membership commands until completion is intended.
  - The continuation could fail permanently: it distributed the policy frozen at commit. If the policy had risen
    in the meantime (for example by taking over a ReplicaConfigNotice), a member with a newer policy rejected the older one
    (`invalid installed policy transition`), on every attempt.
  - Now the continuation of `add` and `remove` distributes the current policy to the current members, per
    policy version under its own instruction ID; `activate` remains repeatable unchanged. If the policy is newer than
    at commit, the new member receives it too.
  - Tests: `test-membership` (interruption after `committed` and release of the block; `add` and `remove` after a newer
    policy). The test for `add` fails with the old code exactly on this error.
  - That this was the trigger in the real run is not proven. A permanently unreachable existing member still holds
    the admission; this is intended, but recognizable only by missing results.
- Outside the acceptance criteria: boot and deletion integration of the sync journal
  ([ap3-primary-sync](ap3-primary-sync.en.md)).
