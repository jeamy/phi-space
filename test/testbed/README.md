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
