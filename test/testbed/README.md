# Remote test bed

Verifies the **built, production-like artifact** in docker containers on a server instead of on the developer machine. No
source code goes to the server. `testbed.sh` builds the artifacts locally (the `pi-spaces.mjs` bundle, compiled examples and
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

Procedure, container roles, limits and troubleshooting: [docs/testumgebung-big.md](../../docs/testumgebung-big.md) (German).

Terminal controls: [docs/tui.md](../../docs/tui.md). The inspector opens only a private temporary copy of JSONL state or a consistent SQLite backup, never a second harness on a live directory. Planned controls without a backend are disabled.

`federation-runtime` verifies the built library with two persistent hosts and real TCP gates, on JSONL and SQLite. Its overlay directory and clock are fixtures; it does not certify the live NetBird outage matrix or Android Keystore integration. See [Phase 1b acceptance](../../docs/ap1b-abnahme.md).


`tools/federation-host.mjs` provides the provisioned production-mode daemon. On big, host-a and member-1 now run separate SQLite harnesses and real NetBird gates with the independent register on vpsc. Their user services are `pi-spaces-phase1b-host-a.service` and `pi-spaces-phase1b-member-1.service`; state lives in each container's `/data/phase1b`. See [operations](../../docs/ap1b-betrieb.md) and [public live evidence](../evidence/ap1b-2026-10-11/README.md). The daemon refuses normal startup while `restart.lock` exists and requires exclusive harness ownership. Recovery mode starts no normal gate or agents; SSH fencing needs an existing SSH-capable administrative runtime.

The SQLite inspector uses read-only online backup into a temporary directory. It never opens a second harness on a live database. Do not use `kill`/container recreation as proof of F15 fencing: the fixed SSH adapter checks the actual process, service and persistent restart lock.

### Phase-2-Member-Lasttest

`scenarios/phase2-load.ts` prüft 10.000 Entries, drei SQLite-Stores und das
HRW-Sieb mit 1.000 Aufgaben/sechs Workern. Auf dem Server ausschließlich das
gebaute `scenarios/phase2-load.mjs` ausführen. Der Lauf benötigt einen eigenen
Container mit temporärem Schreibspeicher und liefert einen JSON-Bericht.
Er ist ein Member-Lasttest; virtuelle Router- und NetBird-Systemabnahme sowie
die offenen Journal-/Löschgrenzen stehen in [ap2-abnahme.md](../../docs/ap2-abnahme.md).


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
are tracked in [the current acceptance document](../../docs/ap2-abnahme.md).
