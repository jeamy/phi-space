# Remote test bed

Verifies the **built, production-like artifact** in docker containers on a server instead of on the developer machine. No
source code goes to the server. `testbed.sh` builds the artifacts locally (the `phi-spaces.mjs` bundle, compiled examples and
scenarios, byte-identical to what the mobile runtime gets), ships only those over ssh, builds an image from them there
(Node, `npm ci --omit=dev`, the artifacts; unprivileged user, `NODE_ENV=production`, read-only root filesystem, no
capabilities) and reconciles/starts the containers (Compose may recreate running containers when their image or configuration changes).

```sh
cp test/testbed/testbed.env.example test/testbed/testbed.env   # server, directory, credentials (git-ignored)
npm run testbed -- check          # read-only: ssh, docker, compose, rsync, directory
npm run testbed -- test           # build + ship + image + start the runner; smoke, examples, scenario
npm run testbed -- scenario sieve-mobile create|run|evaluate|all
npm run testbed -- scenario federation-runtime
npm run testbed -- up federation  # also start host-a, host-b, member-1, member-2
npm run tui                      # spaces, objects, controls, tests and reports
npm run testbed -- inspect runner # read-only JSON snapshot from the shipped inspector
npm run testbed -- start runner   # existing stopped container, without build/ship
npm run testbed -- status | logs <svc> | exec <svc> <cmd> | kill|stop|partition|heal <svc> | down
npm run testbed -- --dry-run up   # show every remote command without running it
```

Scenario: `scenario sieve-mobile` runs a prime sieve driven by a simulated phone (lost calls, retries with the same request id,
app in the background, dying workers, host restart) and evaluates the stored state against trial division. Exit code 0
means passed.

The source tests (`npm run typecheck`, `npm test`, `npm run test:examples`) read TypeScript and therefore stay local.

- `build-artifacts.mjs`: esbuild step; refuses to produce any `.ts` file.
- `docker/`: templates installed on the server (`docker-compose.yml`, `Dockerfile`, `.dockerignore`). Existing files on the
  server are kept; `init --force` overwrites them. The server `.env` is generated once and never overwritten.
- `testbed.env.example`: every setting. Environment variables win over `testbed.env`.
- No ports are published, containers have memory/cpu/pid limits, and the script never deletes the server directory.

Procedure, container roles, limits and troubleshooting: [docs/testumgebung-big.en.md](../../docs/testumgebung-big.en.md) (German).

Terminal controls: [docs/tui.en.md](../../docs/tui.en.md). The inspector opens only a private temporary copy of JSONL state or a consistent SQLite backup, never a second harness on a live directory. Planned controls without a backend are disabled.

`federation-runtime` verifies the built library with two persistent hosts and real TCP gates, on JSONL and SQLite. Its overlay directory and clock are fixtures; it does not certify the live NetBird outage matrix or Android Keystore integration. See [Phase 1b acceptance](../../docs/_attic/abnahme/ap1b-abnahme.en.md).


`tools/federation-host.mjs` provides the provisioned production-mode daemon. On big, host-a and member-1 now run separate SQLite harnesses and real NetBird gates with the independent register on vpsc. Their user services are `phi-spaces-phase1b-host-a.service` and `phi-spaces-phase1b-member-1.service`; state lives in each container's `/data/phase1b`. See [operations](../../docs/_attic/abnahme/ap1b-betrieb.en.md) and [public live evidence](../evidence/ap1b-2026-10-11/README.md). The daemon refuses normal startup while `restart.lock` exists and requires exclusive harness ownership. Recovery mode starts no normal gate or agents; SSH fencing needs an existing SSH-capable administrative runtime.

The SQLite inspector uses read-only online backup into a temporary directory. It never opens a second harness on a live database. Do not use `kill`/container recreation as proof of F15 fencing: the fixed SSH adapter checks the actual process, service and persistent restart lock.

### Phase-2-Member-Lasttest

`scenarios/phase2-load.ts` prüft 10.000 Entries, drei SQLite-Stores und das
HRW-Sieb mit 1.000 Aufgaben/sechs Workern. Auf dem Server ausschließlich das
gebaute `scenarios/phase2-load.mjs` ausführen. Der Lauf benötigt einen eigenen
Container mit temporärem Schreibspeicher und liefert einen JSON-Bericht.
Er ist ein Member-Lasttest; virtuelle Router- und NetBird-Systemabnahme sowie
die offenen Journal-/Löschgrenzen stehen in [ap2-abnahme.md](../../docs/_attic/abnahme/ap2-abnahme.en.md).


### Phase-2 virtual Router load

`scenarios/phase2-router-load.ts` runs the full inventory/job/worker workload through fixed Root journal partitions on real SQLite stores. It seeds 9,000 background entries in bounded Member commits and routes all 1,000 job writes plus transaction begin, take, result write and commit through `FederatedSpace` and `RouterController`. Six workers use the keyed HRW placement and member-bound transactions.

The default run uses 1,024 fixed journal partitions, 10,000 entries and 1,000 jobs. Each Member uses an explicit per-owner entry quota of 10,000; frame, commit and generation budgets retain their defaults. Parent occupancy is checked before admitting work. A small local check is:

```sh
PI_LOAD_ENTRIES=120 PI_LOAD_JOBS=12 PI_LOAD_PARTITIONS=16   node --experimental-strip-types test/testbed/scenarios/phase2-router-load.ts /tmp/router-load-smoke
```

Build with the existing artifact builder and run only the built `scenarios/phase2-router-load.mjs` on the server. Use an isolated container with a writable scratch directory for SQLite (`TMPDIR`) and reports, 2 CPUs and 1 GiB RAM. The rootless container UID must have write access to that scratch directory. Keep the library and scenario mounts read-only; no network or host-service replacement is needed.

The scenario loses replies after durable effects, repeats the same Parent API request, reopens the Root harness from SQLite and retries historical writes/commits. Its JSON report records worker counts, the independently verified prime list, per-operation and task latencies, full Member document sizes, Root journal sizes and sampled RSS. It asserts exactly 5,000 retained completed Parent/Child commands for the full run.

The transport calls the real `SpaceService` in process with fixture identities. It does not exercise overlay authentication, grants or production delegation, three separate hosts, replication, or every crash boundary. Those acceptance gates remain separate. The workload is a standalone operator scenario, not automatically included in the routine test-bed service suite.


### Phase-2 signed wire fixture over NetBird

`scenarios/phase2-netbird.ts` has `prepare`, `member` and `run` modes. It uses fresh private fixture state, three persistent Data stores and one Control/Router store. Four isolated test containers share the existing four NetBird agents' network namespaces. Members listen only on their overlay addresses at TCP 7423. The original gates and fenced restore sources remain outside this fixture.

Provision only the public Control key and Router key record to the Member services; keep private signing keys in the Root's own data directory. The read-only Management API credential is provided through a private secret file. The orchestrator must create its own four-peer `space-ap2-test` group and a narrowly scoped TCP-7423 policy and remove both in `finally`. Copy only built library/scenario artifacts to the server. Fresh run directories are required; this fixture does not overwrite or migrate an existing Member/Control store.

The wire path exercises real NetBird peer resolution, key challenge proofs, signed grants, signed RouterLease and per-call delegation through `FederationRpc`. The Control signing key, grants and policy are fixture-provisioned locally. This is not production enrollment or a new independent boot/fencing acceptance test. The network namespaces share one physical server. The default workload is 1,000 jobs on six workers, with a full prime-reference comparison. A small run can set `jobs: 12` in its private config.


The local operator driver uses the existing `big` SSH target and NetBird test installation:

```sh
node test/testbed/build-artifacts.mjs /tmp/phase2-wire-artifacts
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-wire-artifacts --jobs 12 --entries 12
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-wire-artifacts --jobs 1000 --entries 10000 --rpc-faults --rpc-fault-boundary both
```

Each run requires a fresh directory and unique run ID. The driver refuses an existing `space-ap2-test` group rather than adopting another run's objects. Progress and redacted reports go to `--output`; management credentials remain on `big`. The driver cleans up only the container IDs and policy/group IDs it created. A failed policy/group cleanup is reported as an error.

`--entries` defaults to 10,000; background entries are seeded in bounded local bootstrap commits before the fixture policy is activated. `--rpc-faults` defaults to `--rpc-fault-boundary afterReply`: one successful reply is discarded for each of five effect kinds on each of three Members. All 15 slots must be exercised. This tests signed-wire outcome resolution with stable Parent/Child identities, not process crashes or mailbox ACK boundaries. `beforeSend` and `both` also exercise the current-epoch admission proof: the Router retries exactly the journaled identity when a valid, same-epoch generation proves that it is not yet admitted. Expired, restored, legacy or old-epoch generations still require review. This is not terminal NotCommitted or promotion acceptance. Member logs are captured before cleanup, and exited Member containers are retained until the driver removes its own IDs.

The built `scenarios/phase2-admission-audit.mjs <fixtureDir> <reportFile>` checks the closed stores after a `both` run. Mount the fixture read-only and provide a private writable `/tmp` for SQLite copies; the existing rootless Docker image needs `--user 0:0` to read owner-only fixture files. The audit never opens original stores for writing, uses no network, and refuses effects or Router commits. It verifies completed Parent/Child journals, zero unused future reservations and each faulted original Member claim against journaled targets and argument hashes.


### Phase-2 process crash matrix

`scenarios/phase2-process-crashes.ts` runs 20 isolated cases: JSONL and SQLite,
with SIGKILL before/after candidate persistence, winner persistence, Parent
completion, mailbox ACK, and Router RPC dispatch/reply. Each case creates a
Root and three persistent Members, starts a waiting take, makes all three
Members candidates, kills the worker process, and reopens every store in a
fresh process. A second fresh process verifies stable replay, original request
bindings, one consumed winner, two returned losers, empty mailboxes, no active
transactions, and no unused future reservations.

```sh
node --experimental-strip-types test/testbed/scenarios/phase2-process-crashes.ts
# On the server, use only the built artifacts and the existing test image:
node /opt/app/scenarios/phase2-process-crashes.mjs
```

Run the server command in an isolated container with `--network none`, a
writable private `/tmp`, and read-only library/scenario mounts. The orchestrator
checks that every crash child actually exited with SIGKILL; missed boundaries,
timeouts, or other signals fail the run. Temporary stores are deleted in
`finally`. RPC uses fixture identities in process and a fixed clock to isolate
crash ordering from lease timing. The killed process owns all four stores.
This is process-recovery evidence, not a NetBird load/crash combination,
independent host failure, production boot/fencing, or power-loss proof.


### NetBird load with real Root process crashes

The same isolated wire fixture supports an owned Root restart loop:

```sh
node test/testbed/build-artifacts.mjs /tmp/phase2-process-wire-artifacts
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-process-wire-artifacts --jobs 12 --entries 12 --process-crashes
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-process-wire-artifacts --jobs 1000 --entries 10000 --process-crashes --process-crash-effect all
```

`--process-crash-effect` selects `SieveTask`, `SieveResult`, `take`, `txn-begin`,
`txn-commit` (the default), or `all`. `--process-crash-boundary` selects
`beforeSend`, `afterReply`, or `both` (the default). Select Members with
`--process-crash-members a b c`. `all` with all three Members and both boundaries
requires 30 actual Root process deaths. This option cannot be combined with
`--rpc-faults`; exceptions and process death are distinct tests.

The Root runs with Docker init because a container PID 1 ignores this
self-directed SIGKILL. The driver must observe exit 137, reject OOM termination,
verify exactly one newly persisted fault marker, and restart only its owned
container ID. Missing deaths fail the run even if the scenario printed a
successful result. It stores restart observations separately from scenario
reports. The CID file also supports cleanup after a lost start response.

Worker assignment is fixed by job number modulo six. Completed job IDs and
the producer cursor are written atomically in the Root's private fixture data;
unconfirmed completions replay their existing Parents. The Root keeps its
original lease ID and epoch, renews only that lease, and checks the existing
policy and Member targets rather than replacing them. An expired or superseded
lease fails the fixture. This is controlled same-authority process restart,
not production boot/fencing or promotion.

Crash points are spaced across production/job progress (reported as
`processCrashGapJobs`) so the test does not substitute a prolonged sequence of
outages for bounded job processing. Small cases have no spacing and must stay
within the original lease limits. The scenario does not renew or extend a job
transaction beyond its completion profile. Task-write crashes occur while
seeding the workload; the processing-stage crashes follow the verified full
initial inventory. Members stay running in their own NetBird namespaces.
Mailbox ACK, Member process death, arbitrary journal commit boundaries,
independent physical hosts, and power loss remain separate acceptance cases.

The closed-store admission audit also accepts process-crash reports. It checks
each interrupted original request individually; before/after slots on one
Member need not refer to the same request when six Workers are concurrent.

The `sameParentRetries` counter covers explicit `FederationPending` retries in
the final Root process. It does not total earlier processes or recovery-time
resolutions; use the separate crash/restart reports for process counts.


### ACK crashes with concurrent job Workers

```sh
node test/testbed/build-artifacts.mjs /tmp/phase2-ack-artifacts
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-ack-artifacts --jobs 12 --entries 12 --ack-crashes
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-ack-artifacts --jobs 1000 --entries 10000 --ack-crashes
```

Run ACK crashes separately from `--process-crashes` and `--rpc-faults`.
Six waiting-take races run alongside the six fixed job Workers. Each race
writes one additional unprofiled `AckProbe` to each Member using pinned HRW
keys. The Root is killed exactly once per race, before or after ACK on the
selected Member. The fault marker includes the candidate read back from the
committed Parent journal, its mailbox epoch/prefix and principal. A replay
must preserve the same winner, return two losers and leave no mailbox gap or
unread event. The full 1,000-job run requires six active Workers at every
selected crash; the small smoke does not claim that load condition.

The 18 probe Entries are additional to the verified initial workload; six
are consumed and twelve remain returned. They do not replace job Entries.
Probe progress is retained across Root restarts without extending its original
60-second wait/transaction deadlines. The closed-store audit checks completed
race Parents/Children, preserved candidates, one winner and two returned
Entries per race, and the original interrupted ACK claims. A before-send ACK
is not admitted; after-reply ACK has a completed claim. Re-ACK can use a fresh
request ID, but it must retain the original Member, principal, mailbox epoch
and delivered prefix. Its purpose is confirming mailbox delivery, not taking
or committing another Entry.

Concurrent RemoteSpace objects sharing one transport now order the full
challenge/sign/prove sequence. The server still keeps one open challenge per
connection, validates pinned host/peer and active key, and does not reuse a
cached successful proof. Failed proofs release the next queued authentication;
other transports remain independent. This protects concurrent snapshot queries
and Worker effects from replacing each other's challenge. The runtime library
must include this correction before running the concurrent ACK scenario.

The remaining seven Phase-2 acceptance blocks and the separate overall release
are tracked in [the current acceptance document](../../docs/_attic/abnahme/ap2-abnahme.en.md).

### NetBird load with individual Member process crashes

```sh
node test/testbed/build-artifacts.mjs /tmp/phase2-member-wire-artifacts
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-member-wire-artifacts --jobs 60 --entries 180 --member-crashes
python3 test/testbed/netbird/run-phase2-sieve.py --artifacts /tmp/phase2-member-wire-artifacts --jobs 1000 --entries 10000 --member-crashes
```

This separate fault mode requires 30 real SIGKILLs: three Members × task write,
transaction begin, take, result write and transaction commit × before admission
and after the durable effect but before its reply. The hook runs inside the
Member service after the Router key proof. It reads the original claim before
recording each boundary: absent before admission, completed after the effect.
Crashes are spread across job progress. The Root remains running.

Only the owned Member container IDs are restarted, with Docker init and their
original SQLite stores. Reopen verifies membership, policy, Space ID,
incarnation, authority and primary epoch; it does not seed background Entries
again. Private Root signers stay in the Root directory. Shared injection state
contains only public targets and workload counters. Each observed death must
have exit code 137, no OOM flag and exactly one new durable boundary marker.
The process observations require eleven starts per Member and one Root start.

During recovery, the operator retries only `FederationPending`, with the same
Parent request and a 30-second retry deadline. The production client preserves
an admitted Parent when transport loss interrupts proof/generation preparation
before a Child is dispatched. A new generation may be obtained only while no
Child is journaled; persisted Child request identities remain unchanged.
Authority, permission and other definitive errors are not converted into
pending retries. Original transaction deadlines remain unchanged.

The closed-store audit verifies all original Child claims and the 30 faulted
bindings/hashes on read-only source mounts and private SQLite copies. This
proves process recovery at unchanged bindings, not promotion, independent host
failure, power-loss durability, production boot authorization or every explicit
Root journal boundary. Other fault modes cannot be combined with this run.


The Member observer batches status checks, marker copying and restarts in one
server command, with a 25-second SSH limit and five-second Docker command
limits. Other helper SSH calls have a 60-second limit and connection/keepalive
limits. An observer failure ends the fixture instead of leaving a Member
offline indefinitely. Cleanup recovers lost container-start responses from
CID files only after this invocation successfully created its fresh directory;
a refused existing directory never grants ownership of its containers.

### Exclusive distributed erasure acceptance

`run-distributed-erasure.ts PRIVATE_CONFIG [--checkpoint-root]` runs locally
with Node type stripping. It requires a private pinned fixture manifest, a
separately authorized mTLS register writer and the exact owned `big`/local
homes. `netbird/erasure-driver.py` performs the bounded process/file operations.
Normal daemons are stopped and independently fenced before maintenance.
The checkpoint option exits after all local deletions; a new CLI process
resumes the same command to erase Root histories. All floors and actual
backup/backend checks must complete before boot permission is restored.
Daemons remain stopped until the independent command receipt is completed.

The coordinator currently bounds evidence at 4096 Entry IDs and 32 Space
targets; budget failures keep the fixture fenced. Do not use this CLI on
protected F15 stores or treat its owned fixture manifest as general host access.
The local transport checks run without a server:

```sh
python3 -m unittest discover -s test/testbed/netbird -p test_erasure_driver.py
```

See `docs/_attic/abnahme/ap2-abnahme.en.md` and `test/evidence/ap2-remaining-2026-10-15/` for the
actual multi-host deletion, archive and profile-transition acceptance.


### Phase 2 Gate 4 resource boundaries

`scenarios/phase2-gate4.mjs <report-directory>` measures 10,000 SQLite entries,
snapshot traversal/eviction/TTL, default generation and transaction budgets,
exact frame size, global/per-peer connection caps and directory timeout.
`scenarios/phase2-gate4-followup.mjs <report-directory>` separately checks actual
serialized JSONL/SQLite commit writes and the five-second timeout of a silent
socket. Both are standalone operator scenarios built by the existing builder.
Use an isolated production-mode container with 2 CPUs, 1 GiB RAM and private
writable scratch space; no external network or production-store access is needed.
They do not rerun the accepted job workload or native Block 4. Final limits and
acceptance scope: [Gate 4](../../docs/_attic/abnahme/ap2-gate4.en.md).


### Phase 3 entry-replication invariants

`scenarios/phase3-entry-replication.mjs` runs eleven compiled invariant cases
against the shipped library on JSONL and SQLite. Run the built JavaScript only
in an isolated production-mode container with private scratch storage, 2 CPUs
and 1 GiB RAM. No external network or live store is required. It covers durable
HLC/LWW/Add-Wins metadata, reordered delivery and commit-loss recovery. The
ten-minute partition uses an injected clock; this is not live NetBird replication
or primary/standby acceptance. See [Phase 3](../../docs/_attic/abnahme/ap3-replikation.en.md).


### Paged entry snapshots

`scenarios/phase3-snapshot-transfer.mjs` runs the eleven base entry invariants
and twelve paged-transfer cases against the shipped library, including both
persistent backends, schema migration, immutable pages, durable transfer cursors,
atomic publication, concurrent writes and actual commit-loss/reopen boundaries.
Use an isolated production-mode container with private scratch storage, 2 CPUs
and 1 GiB RAM; no live store or external network is required. This is not a live
NetBird replication acceptance. See [snapshot transfer](../../docs/_attic/abnahme/ap3-snapshot-transfer.en.md).


### Continuous entry-stream progress

`scenarios/phase3-stream-transfer.mjs` runs 36 compiled cases: base replication,
paged bootstrap and thirteen continuous-stream cases on both persistent backends.
It verifies atomic event/checkpoint commits, real loopback TCP disconnect/reconnect,
competing workers, cancellation and bounded source retries. Run only built
JavaScript in an isolated production-mode container with private scratch, 2 CPUs
and 1 GiB RAM. This is not a production NetBird deployment or primary/sync
acceptance. See [stream protocol](../../docs/_attic/abnahme/ap3-stream-transfer.en.md).


### Phase-3 generation maintenance and synchronous storage

`scenarios/phase3-maintenance.mjs` runs 68 built component cases: the existing
36 entry/snapshot/stream cases plus eight generation-maintenance and sixteen
full-batch synchronous-storage cases, plus eight atomic set-renewal cases. Run in the same isolated production-mode
container as the preceding components. It covers real Storage.commit faults,
claim/transaction replay and journal/data marker recovery. It does not activate
production sync policies or prove promotion.

`scenarios/phase3-overlay-node.mjs` is an isolated, operator-controlled two-host
fixture. Stdin owns commands; its private namespace exchanges over TCP 17431 bound
to provisioned NetBird addresses. It requires both a fixed peer IP and a private
test token, plus temporary two-peer Management policy and matching host-firewall
rules. Stop only its listeners to create the partition. Use a fresh private home
and clean up owned processes, containers and exact policy/group/firewall rules. Existing Tailscale antispoofing can also drop
NetBird CGNAT addresses before UFW; the operator must account for both endpoints
without disabling either VPN.
This is a component fixture, not the production key-proof/grant/boot protocol.


The existing `big`/`bigi` installation can run the two-host component check with:

```sh
python3 test/testbed/netbird/run-phase3-overlay.py --artifacts /tmp/phase3-artifacts --output /tmp/phase3-overlay-new-run
```

Use `--local-ip` / `--remote-ip` when provisioned peer addresses differ. This needs
the existing Management secret on big, root SSH via bigi and local passwordless
iptables access for the narrowly scoped temporary rules. It requires a fresh
output directory and records owned IDs before running. The partition lasts at
least 600 real seconds; it uses 21 samples and continues local mutations throughout.
SIGINT/SIGTERM run cleanup. After a forced kill, inspect the private `owned.json`
and remove only its exact tagged rules, group, policy and container; never adopt
or restart old acceptance stores.


### Run gate case 3 over NetBird

`netbird/run-run-gate-overlay.py` drives `scenarios/run-gate-overlay-node.ts` (compiled) for acceptance case 3 of
`docs/betrieb-und-mobile-steuerung.en.md` §7.4: controller and one Member on the operator host, one Member in an owned
container on big behind the composed Gate on TCP 17432 of its NetBird address. The Member container is killed during
a pause and restarted on the same store. The driver owns and removes its firewall rules, NetBird group/policy and
containers and checks the protected container inventory. `--local-smoke` runs the same sequence on loopback without
ssh. Build first with `node test/testbed/build-artifacts.mjs <dir>`; evidence: `test/evidence/run-gate-overlay-2026-10-15/`.
