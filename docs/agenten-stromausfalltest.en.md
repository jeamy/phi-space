# Power-loss tests for agent stores

## Status and limit of the evidence

The integration uses SQLite WAL with `synchronous=FULL` as well as JSONL with synchronized
sidecars, commit markers and directory entries. See [`agent/src/storage.ts`](../agent/src/storage.ts).
This also applies to the mobile harness; the Space keeps its phi-spaces store.

**On 30 and 31.10.2026 experiments ran in a VM, see [result](#result-of-30102026). In the profiles and cuts examined,
no loss was found in the strong profile. Still open are drives, other file systems and everything listed under limits.** FULL/fsync is a write policy,
not a hardware certificate. Disk and file system must implement flushes correctly.
A passed finite test also does not prove all possible write interruptions.

The [local regressions](../agent/test/storage.test.ts) check:

- WAL/FULL on every newly opened SQLite connection, not only on the first start.
- JSONL: sidecars before marker, marker flush and namespace barrier before acknowledgement.
- Restoring a document from exclusively flushed file contents in a simplified
  cache-loss model; this models neither torn sector writes nor a particular file system.
- Refused acknowledgement and a poisoned JSONL store after a failed marker flush.
- The counter-case from pi-durable 1.4.0: `{ fsync: true }` alone does not flush a pure marker commit.

The [probe self-tests](../agent/test/power-loss-probe.test.ts) end their own writer with SIGKILL.
That checks writer, externally observed acknowledgements and verifier, but **no power loss**.

## Result of 30.10.2026

Two series in the guest `linux2020`, raw data and environment in [test/evidence](../test/evidence/power-loss-2026-10-30/README.en.md).

**Replay** ([power-loss-replay.mjs](../agent/test/power-loss-replay.mjs)): `dm-log-writes` logs the flushed
writes in order, and after each acknowledgement a mark goes into the log. The disk is rebuilt at random marks
and then contains only what had been flushed by then. This reproduces the loss of the drive cache.

| Cell | Cuts | passed | Loss |
|---|---|---|---|
| SQLite strong | 38 | 38 | 0 |
| JSONL strong | 37 | 37 | 0 |
| SQLite weak | 115 | 38 | 77, up to 249 commits |
| JSONL weak | 115 | 0 | 115, of which 35 with `main.jsonl` missing entirely |

**Hard power-off** ([power-loss-hard-off.mjs](../agent/test/power-loss-hard-off.mjs)): `virsh destroy` during writing,
acknowledgements stored outside the VM, check after the restart.

| Cell | Runs | passed | Loss |
|---|---|---|---|
| SQLite strong | 3 | 3 | 0 |
| JSONL strong | 3 | 3 | 0 |
| SQLite weak | 9 | 9 | 0 |
| SQLite weak with `strace` | 9 | 5 | 4, up to 233 commits |
| JSONL weak | 9 | 0 | 9 |

The strong profile held every acknowledgement in these experiments, and the weak runs show that the setup detects losses.
That SQLite weak passed the hard power-off without `strace` demonstrates no durability. The writer writes around 250 commits without fsync and
then waits for the checkpoint, which flushes the WAL. The recording streamed out of the VM shows this: in all 5 runs without loss the last
call was an open `fsync`, in all 4 with loss a `pwrite`. For SQLite, the hard power-off is therefore the weaker probe.

The strong profile costs a lot; the rates are in [section 5.3 of the comparison](vergleich-pi-durable.en.md#53-durable-depends-on-the-backend-and-the-failure-model). This applies to this host, not in general.

The same experiment ran for comparison against the phi-spaces store of the Space, with an [identically built probe](../agent/test/power-loss-own-probe.ts).
The results are there as well.

Limits:

- The replay presupposes a drive that keeps flushes. For the software this is the same failure case as a power loss;
  it does not cover drives that do not keep flushes, or torn sectors.
- Cuts are made only at marks, not at every point of the log. The cuts of one cell come from three write runs and are not independent failures.
- What is checked is a small counter or a series of individual entries, not conversations, tasks or document deltas, and not specifically critical write and replace steps.
- This comes from one host and one file system. In the strong profile, because of the low rate, there were only 91 to 341 commits per cell.
- Workflow resumption with agent and Space is not covered by this, see below.

## Why `agent/src/storage.ts` is necessary

The published Node SQLite connection sets `NORMAL` and offers no sync parameter.
`openDurableSqliteDatabase` sets the connection to `FULL` before the schema is opened, checks the value and aborts on
an error. It never silently chooses the weaker profile.

JSONL `{ fsync: true }` synchronizes the sidecars in version 1.4.0. `main.jsonl`, however, is not necessarily
synchronized on a normal commit, but only during certain cleanups. `durableJsonlFileSystem`
secures sidecar names before the marker and flushes the marker before the acknowledgement.
Atomic sidecar renames also get a directory barrier. Manifest and atomic
research exports are written with a file flush and a directory flush.

More flushes can increase the write time. A reliable measurement must be made on the respective
production file system; no performance promise follows from the small temporary-file tests.

## Disposable VM: prepared procedure

The [probe](../agent/test/power-loss-probe.ts) needs only Node and the agent dependencies already
present. It calls no models or paid services.

1. Use a standalone disposable VM and a dedicated test disk image. Do not attach production volumes,
   host block devices or user directories. Network only for the control channel.
2. Prepare the VM with a known file system and a documented QEMU/hypervisor cache configuration.
   Do not download or install root images and dependencies without asking.
3. Start a test run with a fresh ID; `--dir` must be empty. The control instance outside the VM
   stores every received `ack` line. The writer keeps waiting after the last output and does not
   close the store voluntarily.
4. Power the VM off hard at varying times while the writer is working. No guest shutdown,
   no `sync` and no `fsfreeze` immediately before the abort: that would mask the fault.
5. After restart, compare the highest acknowledgement observed outside with the recovered
   document. Commits written further but not yet observed are permitted.
6. Check SQLite integrity, document checksum and run identity; with fewer recovered
   than acknowledged commits, the strong profile has failed. A verifier error is not a PASS.

Example from the **control host** for a local VM access prepared separately beforehand
(`probe-vm` is not a production host):

```sh
ssh probe-vm 'cd /work/phi-spaces && node --experimental-strip-types agent/test/power-loss-probe.ts write --backend sqlite --profile strong --dir /test-disk/run-001 --run-id power-run-001 --commits 100000' > /tmp/out-power-acks.txt 2>&1
```

The control host then reads the complete JSON lines with `kind: "ack"` and the matching ID,
for example up to `n=42`. After the hard VM power-off and restart:

```sh
ssh probe-vm 'cd /work/phi-spaces && node --experimental-strip-types agent/test/power-loss-probe.ts verify --backend sqlite --profile strong --dir /test-disk/run-001 --run-id power-run-001 --ack 42' > /tmp/out-power-verify.txt 2>&1
```

Repeat the same matrix with `--backend jsonl`. `--profile weak` deliberately uses the
upstream defaults NORMAL or JSONL without fsync; these control runs may lose
acknowledgements. They are not an alternative production profile. A loss that did not occur in a
weak control run is no proof of its durability.

The probe refuses a non-empty writer path and in the verifier checks a dedicated guard file
with backend, profile and run ID. It deletes no data. Faulty/interrupted images are kept
for analysis; deleting is a separate explicit operator step.

## What a hard VM power-off does not yet prove

A VM abort discards guest RAM. Writes already handed to the host can, however, survive in the
host cache. Ending QEMU or killing a Docker container therefore does not
automatically mean loss of the volatile drive cache.

A controlled device cache loss additionally needs a simulator that discards acknowledged but not
flushed writes and handles FLUSH/FUA correctly (the replay above), or a separate physical test stand. `cache=unsafe` ignores flushes and is suitable only as a
deliberately broken counter-probe, not for assessing the correct FULL configuration.

The matrix to be recorded comprises at least WAL append and checkpoint as well as JSONL sidecar append,
marker append, sidecar replacement and new directory entries. For reproducible results,
seed, cut, hypervisor, cache mode, file system, mount options, Node/SQLite/Pi version
and acknowledgements observed outside are to be logged.

## Limits between agent and Space

Agent and Space still have no joint atomic commit. The probe tests only one
agent store, not yet a complete resumption of quotas, work items and world actions
under power loss. The existing workflow regressions demonstrate their process-crash behavior.
A corresponding VM end-to-end run with faux models is an additional, still open acceptance.

FULL/fsync also does not undo external effects already executed: a provider may have been paid before an
abort although its answer had not yet been stored. Backup, fencing,
restoration and provider idempotence remain separate requirements.
