# phi-spaces files: operator guide

This guide is for the host operator: the person who runs the service process on this machine, holds the backup keys
and the recovery roster, and runs restores. Tenant administrators use the page and do not need this guide. The design
behind each step is in [the plan](../../docs/zanzibar-agent-filesystem-plan.en.md) (sections 2, 6.1, 6.5 and 6.6). The
commands and variables are listed in [the README](../README.md).

The commands in this guide run from `spaces-files/`, with the same `.env` as the service. The operator commands are
`npm run operator -- <command>`. Commands that talk to the running service go through `operator.sock` in the state
directory. The offline commands (`backup-offline`, `restore`, `restore-state`) open the stores themselves and need the
service stopped; the owner locks refuse them otherwise.

## 1. Before the first start

**Three directories.** Each directory is mode 700, owned by the service user, and none lies inside another. The
service refuses to start otherwise.

| Directory | Variable | Holds |
|---|---|---|
| Data | `FILES_DATA_DIR` | The store (`files.sqlite` and its WAL), the state marker |
| Deployment state | `FILES_STATE_DIR` | Sessions, signing keys (`keys.json`), content keys (`content-keys.json`), epoch, roster, restore journal, operator audit, `operator.sock` |
| Blobs | `FILES_BLOB_DIR` | The file contents, each sealed with AES-256-GCM under a content key |

**Manual checks.** The service cannot verify these itself. Check them on every new machine and after every change to
its disks:

- **Encrypted volume.** All three directories lie on an encrypted volume, for example LUKS:
  `lsblk -o NAME,TYPE,FSTYPE,MOUNTPOINT` shows a `crypt` device under their mount point. The content keys sit beside the
  blobs on this machine; disk encryption protects both when the machine is off or a disk leaves it.
- **Swap.** Swap is encrypted or off. `swapon --show` lists every swap device, and each must be `zram` or a
  `crypt` device in `lsblk`. Keys and file contents pass through the process's memory, and the kernel may write that
  memory to swap.
- **Core dumps.** Core dumps of the service user are off (`ulimit -c` is 0, or `coredumpctl` stores none for it).
  A core dump holds the same memory.
- **Backups leave the machine.** Archives are encrypted, but each key file is kept elsewhere: never beside its
  archive and never in the three directories.

**Keys.** Create the two backup keys once and store them apart from each other and from the archives:

```
npm run operator -- new-backup-key /secure/state.key     # FILES_STATE_BACKUP_KEY
npm run operator -- new-backup-key /secure/data.key      # FILES_BACKUP_KEY
```

A key file is mode 600. The commands refuse to overwrite an existing key and refuse to read a key that group or
others can read.

**Limits.** `FILES_LIMITS` names a JSON file that overrides the filesystem limits of `server/limits.ts`, for example
`{"maxFileBytes": 8388608}`. Unknown keys and values that are not positive integers are refused. On start the service
also refuses a set of limits that does not fit the tenant Spaces. Changing the file takes effect at the next start.

**Upkeep.** Every `FILES_UPKEEP_MS` (default ten minutes) the service removes, in bounded batches, expired receipts,
audit rows past their age, and orphaned blobs. `npm run operator -- maintain [tenant]` runs the same upkeep at once.
`compact` gives the store's free pages back to the file system and drains admission while it runs.

## 2. Watching the service

```
npm run operator -- health
npm run operator -- metrics
```

`health` reports one of three states:

| `status` | Meaning | What to do |
|---|---|---|
| `ok` | Normal admission, nothing closed | Nothing |
| `maintenance` | Maintenance mode, or an open restore (`restore.step`) | Finish the work that needed maintenance |
| `degraded` | A tenant is closed (`closedTenants`), a commit outcome is unknown, or admission is closed in normal mode | See below |

`health` also reports:

- `state.stateBackupDue`: a key, epoch or roster change has not yet gone into a state backup. Take one (section 3).
- `store`: the store file's size, its free part, and its WAL.

A tenant closed as `securityReserve` waits for its pending security action (plan section 3). A tenant closed as
`inconsistentState` failed a check of its own rows or blobs, and the service refuses it until it is restored.

`metrics` counts since the last start and reports:

- queue wait and run time per operation, both in milliseconds;
- each adapter operation, by name, with its latency and its error codes;
- the evaluator's lookups.

The counters name no tenant, actor, path or content.

## 3. Backups

**Deployment state** (sessions, keys, epoch, roster), small and frequent:

```
npm run operator -- backup-state /backups/state-$(date +%F-%H%M).bk
```

Take a state backup after every key rotation, epoch change or roster change, and in any case whenever
`stateBackupDue` is true. A new content-key generation (`rotate-content-key`) seals nothing until a state backup holds
it. Without this rule, a lost state could take with it the only key to newer blobs.

**Data** (the store and the blobs):

```
npm run operator -- backup /backups/data-$(date +%F).bk           # online, the service running
npm run operator -- backup-offline /backups/data-$(date +%F).bk   # clean, the service stopped
```

The online backup holds blob deletion and copies the store as one read transaction while saves go on. It then copies
the blobs. Both forms give the same archive.

**What a data archive contains.** The archive holds:

- the store, with names, grants and the audit;
- the sealed blobs.

It holds no content key. Reading it needs the data key, and reading the files in it also needs the state backup's
content keys. A copy of the archive alone reveals no name, identity or content (`tests/phase5-exit.test.ts`).

Check a restore regularly on a second machine (section 4). An archive that has never been restored is not yet a
backup.

## 4. Restoring the data

A restore replaces the store and the blobs with a data backup and closes the service until every tenant has been
reconciled against the current evidence. The restore authority never comes from the backup: the restored
administrator rows prove nothing. Only the operator's roster and the operator's approval do.

1. Stop the service. If its directories are still readable, take a last `backup-offline` of them first.
2. `npm run operator -- restore /backups/data-….bk`. This step:
   - persists the intent and maintenance mode;
   - verifies the whole archive and that it belongs to this deployment;
   - moves the current data and blob directories aside (`….before-restore-<time>`) and installs the backup;
   - advances the session epoch and retires every earlier signing generation, so every session and operation ID
     from before the restore is refused;
   - checks every content row against its blob and closes a tenant whose contents lack a blob
     (`inconsistentState`, that tenant alone).

   The steps are journaled in the deployment state. After a crash, run the same command again: it resumes at its
   step. `restore-status` shows the journal.
3. Start the service. It stays in maintenance mode. `health` shows `restore.step: "checked"`.
4. For each tenant, verify against the tenant's own identity provider, outside this service, who should administer
   it today. Put those people on the recovery roster:

   ```
   npm run operator -- roster-add <tenant> <issuer> <subject>
   ```

   Roster changes are recorded in the operator audit, and the roster stays outside every data backup.
5. If today's administrator (B) is missing from the backup, a rostered recoverer opens
   `https://<origin>/recovery/login?tenant=<tenant>`. The recovery page:
   - lists the tenant's actors and administrators;
   - provisions B with a home;
   - removes the obsolete administrator A. This works only after B exists, because the last administrator always
     stays.

   Each step carries a recovery operation ID; repeating a step is answered by its receipt. The recovery interface
   gives no access to files. Every step is recorded twice: in the tenant's audit and, with the recoverer's identity
   and the restore epoch, in the operator audit.
6. Approve one reconciler per tenant for this restore:

   ```
   npm run operator -- approve-reconciler <tenant> <issuer> <subject>
   ```

   Only this identity, while it is an enabled administrator, passes the maintenance gate during the restore. It signs
   in on the ordinary page and reconciles grants, memberships and actor states against current evidence. It uses the
   admin operations and the maintenance metadata operations (`maintenanceList`, `maintenanceListGrants`,
   `maintenancePutGrant`), which never show a file's content. Grants without current evidence are removed. Check the
   tenant inventory as well: a tenant that should not exist, or one that is missing.
7. When the reconciler reports a tenant done: `npm run operator -- mark-reconciled <tenant>`.
8. `npm run operator -- mode normal` refuses until every tenant is marked. It then drains admission, ends the restore,
   ends every recovery session and opens normal admission.
9. Take a state backup (the epoch and keys changed) and a fresh data backup.

**Pilot decision.** In the pilot, the operator's two steps count as the independent authority check of plan section
6.5: the roster entry, verified against the tenant's identity provider out of band, and the approval of one rostered
identity per tenant and restore epoch. No automated query of the identity provider is made.

## 5. Losing the deployment state

If the state directory is lost, or replaced by an older or a foreign one, the service refuses to start (`StateLost`).
It never creates a fresh state, because that would come with new content keys and leave the blobs unreadable. To
recover:

1. `npm run operator -- restore-state /backups/state-….bk` into an empty state directory, with the service stopped.
   Take the newest state backup: it holds every content key that seals a blob.
2. The command brings the state forward:
   - the time floor to the newest time any tenant recorded;
   - a new epoch and signing generation;
   - a sequence number beyond the data's marker;
   - maintenance mode.

   Every earlier session and operation ID is refused. The content keys are kept.
3. Continue with steps 3 to 9 of section 4. A state restore also opens a restore journal.

## 6. Retiring an actor who owns too much

Without help, a disable or a deletion can be too large for one transaction:

- `disableActor` takes at most 64 replacement owners per call.
- `deleteActor` removes at most `maxDeleteRelations` relations.

The runbook below (`tests/runbook.test.ts`) does the work in bounded batches. No step reads or writes a file.

1. If the actor's workspaces have other owners who cooperate, they grant the replacement owners with ordinary
   `grant` calls. Otherwise run `npm run operator -- mode maintenance`.
2. An administrator installs replacement owners with `maintenancePutGrant` (`grant owner`), one root at a time, in
   batches. Every root keeps an enabled owner throughout.
3. `disableActor` with no replacements left. It needs only the actor row.
4. The administrator removes memberships with `removeMember` in batches and the actor's remaining grants with
   `maintenancePutGrant` (`revoke`) in batches.
5. `deleteActor`. The row stays as a tombstone.
6. `npm run operator -- mode normal`.

## 7. The operator audit

Every operator step that changes authority is recorded in the deployment state's operator audit, outside the data and
outside every data backup:

- roster changes;
- approvals;
- reconciliation marks;
- recovery logins and steps;
- the end of a restore.

The audit travels with the state backup.

## 8. Workload measurements

`node --experimental-strip-types tests/workload/workload.ts [--tenants N] [--users N] [--depth N] [--files N]
[--concurrency N] [--ops N] [--seed N] [--bytes N] [--out report.json]` runs a seeded mix of operations against an
on-disk store on this machine:

- reads 55 %, saves 30 %, listings 12 %, directory creations 3 %;
- several users per tenant, in a shared workspace whose files sit `depth` directories deep.

The same parameters and seed give the same operation mix (`tests/workload.test.ts`). The report records:

- queue wait and run time;
- latency per operation;
- evaluator work;
- the store's live and free sizes and the blob bytes;
- the parameters and the hardware.

Recorded on 2026-11-25 with the default parameters (4 tenants, 4 users each, depth 4, 8 files of 2 KiB, concurrency
8, 2000 operations, seed 1), on an AMD Ryzen 7 3700X (16 threads, 64 GiB RAM), Linux 7.3, Node.js 22.23. Queue wait,
run time and the per-operation latencies are bucket bounds: the true value lies at or below the figure.

| Measure | Value |
|---|---|
| Throughput | 260 operations/s (7.7 s in total) |
| Queue wait, p50 / p99 / max | ≤ 10 / ≤ 100 / 110 ms |
| Queue run time, p50 / p99 / max | ≤ 5 / ≤ 50 / 69 ms |
| Latency `read`, p50 / p99 | ≤ 20 / ≤ 100 ms |
| Latency `write`, p50 / p99 | ≤ 50 / ≤ 100 ms |
| Latency `list`, p50 / p99 | ≤ 20 / 77 ms |
| Evaluator | 1909 decisions, 46777 lookups, at most 25 for one decision |
| Store file / free / WAL | 4.2 MB / 0 / 4.2 MB |
| Blobs | 66560 bytes (the newest versions only) |
| Outcomes | 1022 reads, 546 saves, 62 version conflicts among concurrent saves of one file, 228 listings, 47 directories |

These figures describe this machine and this mix. They are not limits and not a promise.
