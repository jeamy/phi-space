# Test environment on the server `big`

Status: 2026-10-08. Describes `test/testbed/` and the procedure. The environment checks the **built production artifact**
under near-production conditions and provides the hosts that stages 1b–3 of the
[implementation plan](_attic/implementierungsplan-v3.en.md) need. It replaces neither NetBird nor a real fencing adapter
(section 8). **No source code lives on the server.**

**First test bench (2026-10-08, run on the server, near-production version):** `purge-sources`, `destroy`, `init --force`,
`test all` (smoke, five examples, prime sieve scenario), the scenario in three phases with `kill runner` in between, and `down`;
the hardening of the container was checked in the running container. **Not run in this first test run:** `up federation`, `stop`,
`partition`/`heal`. The first build uncovered an outdated `package-lock.json` (section 9). The source tests (typecheck,
`npm test`, `npm run test:examples`) deliberately run only locally (section 1).

## 1. Purpose and overview

Tests and, later, the federation hosts run in Docker containers on a server, not on the developer's own machine.
One script handles setup and operation:

```
lokaler Rechner                              Server big (ssh), Verzeichnis /media/docker/phi-spaces
src/, examples/, scenarios/ (TypeScript)
   │  esbuild (build-artifacts.mjs)
   ▼
dist/testbed-artifacts/                      docker-compose.yml  Dockerfile  .dockerignore  .env   (nur angelegt, wenn fehlend)
  phi-spaces.mjs  examples/*.mjs  ── rsync ─► build/   (nur Artefakte + package.json/-lock.json + MANIFEST.json)
  scenarios/*.mjs  MANIFEST.json                │  docker build auf dem Server
                                                ▼
                                          Image: Node + `npm ci --omit=dev` + Artefakte unter /opt/app
                                          Container (rootless Docker, Benutzer node, NODE_ENV=production,
                                          read-only Dateisystem, keine Capabilities, nur /data beschreibbar):
                                            runner      Smoke, Beispiele, Szenarien
                                            host-a      Koordinator   ┐
                                            host-b      Standby       ├ Profil "federation", Volume /data je Host
                                            member-1/2  Data Members  ┘
```

**Production proximity instead of a source copy.** Locally, the same artifacts are built that the mobile project also receives
(`scripts/bundle-mobile.mjs`): the bundle `phi-spaces.mjs` (**byte-identical** to the one in `pi-termux-mobile/runtime`), the
compiled examples and the compiled scenarios (they import the shipped bundle, no second copy). Only these
files, the dependency manifests and a `MANIFEST.json` (commit, time, hashes) go to the server; `ship` aborts
if a TypeScript file were among them. The image contains Node, the production dependencies according to the lock (`npm ci --omit=dev`)
and these artifacts. There is no mounted checkout, no `ts` interpreter mode and no dev dependencies.

**What this checks and what it does not.** The server checks the artifact in a production environment (real Node image, real
file system, unprivileged user, hardened container, persistent volumes, crash and restart). The source tests
(`npm run typecheck`, `npm test`, `npm run test:examples`) access TypeScript sources and therefore continue to run only locally.
Running them on the server would mean copying sources there.

## 2. Findings about the server (checked on 2026-10-08, read-only)

| Item | Finding | Consequence |
|---|---|---|
| Access | `ssh big` logs in as a normal user, not as `root`. | use the SSH alias `big` |
| Docker | **rootless**, one daemon per user (socket under `/run/user/<uid>/`). The system daemon is masked; **`root` reaches no daemon.** | script runs as the daemon user, not as `root` |
| Directory | `/media/docker/phi-spaces` existed, belonged to the daemon user and was empty. | matches the user |
| sudo | `sudo -n` asks this user for a password | no sudo, `TESTBED_SUDO=no` |
| Resources | shared server with several running containers of other projects; the disk was more than 90 % full | tight limits per container, no published ports; `check` shows the free space |
| cgroup | v2, systemd driver; Docker reports `cpuset` and `io.weight` as unsupported | memory, CPU and PID limits are set; whether the CPU quota takes effect shows in the first run |
| Tools | docker 29.8.2, compose 5.6.0, rsync present | nothing to install |

"As root" from the task statement was therefore implemented as the **project root** `/media/docker/phi-spaces` under the user
of the Docker daemon.

## 3. Prerequisites

Locally: `ssh`, `rsync`, `bash`, `node` and the installed development dependencies (`esbuild` builds the artifacts; for a
password instead of a key additionally `sshpass`). On the server: Docker with the
Compose plugin and `rsync`. The server needs access to Docker Hub and the npm registry
(image `node:22-bookworm-slim`, `npm ci` in the build).

## 4. Configuration

All settings come from environment variables or the file `test/testbed/testbed.env` (git-ignored, template
`testbed.env.example`). Environment variables take precedence. The file is only read and never executed.

| Variable | Default | Meaning |
|---|---|---|
| `TESTBED_SSH_TARGET` | `big` | ssh alias or `user@host` |
| `TESTBED_SSH_USER`, `_PORT`, `_KEY`, `_OPTS` | – | override the ssh configuration |
| `TESTBED_SSH_PASSWORD` | – | password through `sshpass`; a key is preferable |
| `TESTBED_SSH_BATCH` | `1` | `0` allows passphrase/password prompts in the terminal |
| `TESTBED_REMOTE_DIR` | `/media/docker/phi-spaces` | project directory on the server (absolute, at least two levels) |
| `TESTBED_SUDO` | `no` | `yes`: commands through `sudo -n` |
| `TESTBED_DOCKER_HOST` | automatic | Docker socket, e.g. `unix:///run/user/<uid>/docker.sock`; detected if no system socket exists |
| `TESTBED_PROJECT` | `phi-spaces-test` | Compose project name; prefix for containers, network, volumes, image |
| `TESTBED_NODE_IMAGE` | `node:22-bookworm-slim` | base image |
| `TESTBED_RUNNER_MEM` / `_CPUS` | `2g` / `2.0` | limits of the runner |
| `TESTBED_MEM_LIMIT` / `_CPUS` / `_PIDS_LIMIT` | `512m` / `0.5` / `1024` | limits per host container; `0` switches a limit off |

The limits are written to the `.env` on the server at the first `init`. Edit later changes there
(or delete the `.env` and run `init` again). Credentials never reach the server.
Only `TESTBED_*` keys are read; unrecognized lines are reported and ignored.

## 5. Procedure

All commands: `npm run testbed -- <command>` or `bash test/testbed/testbed.sh <command>`.

1. **Once:** `cp test/testbed/testbed.env.example test/testbed/testbed.env` and adjust (on the default server the default suffices).
2. **Check:** `check`. Read-only: tools, ssh, user, Docker (rootless?), Compose, rsync, directory, free space,
   existing containers of the project. With `--dry-run` every command shows what it would do on the server.
3. **Start:** `up` (or `up federation`). The script
   - creates `/media/docker/phi-spaces` and `build/` if they are missing;
   - writes `docker-compose.yml`, `Dockerfile`, `.dockerignore` and `.env`, **only if they are missing**;
     if an existing file deviates from the template, it warns and overwrites nothing (`init --force` overwrites);
   - builds the artifacts locally (`build`) and transfers only these to `build/` (`ship`);
   - builds the image on the server (the layer with the production dependencies stays cached as long as the
     manifests do not change);
   - reconciles containers with image and configuration (`docker compose up -d`); on changes, running containers may also be recreated and their processes interrupted; persistent volumes are kept;
   - shows the status.
4. **Test:** `test` (default `all`) runs `up core` first, thus delivers the current state, and checks in the runner:
   `smoke` (the bundle loads and exports what the runtime needs; Node version, `NODE_ENV`, user and artifact commit
   are printed; **no TypeScript file** in the image and under `/media/docker/phi-spaces`), `examples` (the compiled
   examples `sensor-pipeline`, `cache`, `sieve 1001 2` with "168 primes" and `golomb 5`) and `scenario` (prime sieve with
   simulated phone `sieve-mobile`, section 10, then `sieve-remote`). Individually: `test smoke|examples|scenario`. All steps also run through
   after a failure; the exit code is then 1.
5. **Observe:** `status`, `logs <service> [lines]`, `exec <service> <command…>` (with a terminal if available).
6. **End:** `down` removes containers and network, keeps volumes and the shipped artifacts. `destroy --yes` additionally removes
   volumes and the image. The script never deletes the directory and `build/`. A source copy from earlier versions
   of the script (`repo/`) is removed by `purge-sources`.

## 6. Containers and their use

All containers run idle (`sleep infinity`, `init: true`, `restart: unless-stopped`) and are hardened:
user `node` (not root), `NODE_ENV=production`, read-only root file system with `tmpfs` on `/tmp`, all
capabilities removed, `no-new-privileges`, no ports. Only `/data` is writable. Processes start scenarios and,
later, the services with `exec`. Every host has its own volume `/data`, so that no storage is shared between hosts
(a database directory is never opened by several processes) and a crash preserves the data.

| Service | Profile | Role (v3) | Use |
|---|---|---|---|
| `runner` | always | runner for artifacts | smoke, compiled examples, scenarios; crash/reopen cases on a real file system (SQLite) |
| `host-a` | `federation` | coordinator | from stage 1b: gate, supervisor, recovery Space, control Space, router |
| `host-b` | `federation` | fixed standby | from stage 3: synchronous standby, promotion |
| `member-1`, `member-2` | `federation` | data members | from stage 2: expand/HRW with several members, workers |

**Nothing of this is implemented today:** the four federation containers are empty and serve to keep the topology ready.
To add further members, extend the file `docker-compose.yml` on the server (and align the template in `test/testbed/docker/compose.yml`,
otherwise `init` warns). Environment variables per container: `TESTBED_ROLE`, `TESTBED_HOST_ID`.

## 7. Fault injection

| Command | Effect | Checks e.g. |
|---|---|---|
| `kill <service>` | SIGKILL, then `start` immediately (crash plus restart); the volume stays | crash and reopening (stage 1, 3) |
| `stop <service>` | clean stop; stays down until `up` | failure of a host, standby failure |
| `partition <service>` | disconnects from the test network, the container keeps running | partition, split-brain cases, grant/lease expiry |
| `heal <service>` | reconnects (with the service name as alias) | rejoin |

The clock-skew cases (F6) are not covered by this. A data loss (restore) of a single host works only by
hand: stop the container and remove its volume with `docker volume rm`.

## 8. Limits

- No NetBird: overlay identity, test matrix 4.6 and management failures (gate 5) need a real NetBird environment.
  Stage 1b can initially be checked here with the test identity adapter.
- No real fencing adapter (gate 2): the container runtime adapter from v3 5.5 requires an *other* host. `kill`/`stop`
  show the behavior, but do not replace the evidence "stopped and locked against restart" at the provider.
- All containers share kernel, clock and disk of `big`. Statements about latency, clock and IOPS (gates 3, 4) are only
  guide values on the shared server, and the containers of other projects influence the measurement.
- Rootless Docker with `slirp4netns`: network throughput is not representative.
- Two simultaneous runs (two developers) on the same directory are not protected; there is no lock.
- The server has little free space (`check` shows it). Image and volumes are small (the spike with 10 000 entries
  takes 4 MB, the image a few hundred MB), `destroy --yes` cleans up if needed.

## 9. Troubleshooting

| Message / symptom | Cause and remedy |
|---|---|
| `cannot run commands on big (ssh/sudo)` | run `check`. Check key/agent; with a passphrase use `TESTBED_SSH_BATCH=0` |
| `sudo: interactive authentication is required` | `TESTBED_SUDO=yes` is set, but `sudo` asks for a password. On `big` no sudo is needed |
| `docker: NOT REACHABLE` | the user's daemon is not running (`systemctl --user status docker` on the server) or another socket: `TESTBED_DOCKER_HOST` |
| `docker.sock: no such file` as `root` | the daemon belongs to another user; work as that user (the normal ssh alias) |
| `image build failed` | on the server `cd /media/docker/phi-spaces && docker compose build runner` for the full output; usually network access or disk space |
| `TypeScript source found in … refusing to ship` | a build would have put source code into the artifacts; check `build-artifacts.mjs` |
| `smoke` reports TypeScript files on the server | remnant of an earlier version: `purge-sources`; otherwise look at what lies under `/media/docker/phi-spaces` |
| `npm ci` reports `lock file ... does not satisfy` | `package-lock.json` does not match `package.json`. That was the case here (esbuild was missing in the lock). Run `npm install --package-lock-only` locally and check the change |
| `Permission denied (publickey)` with a foreign user name | `test/testbed/testbed.env` contains an active placeholder (`TESTBED_SSH_USER=deploy`). Remove the line or leave it commented out; environment variables take precedence, `TESTBED_SSH_USER=` (empty) takes the user from `~/.ssh/config` |
| `… on the server differs from the template` | server file was changed or the template was updated: check the difference, then `init --force` |
| `Cannot find package` in the container | a new import is not in `package.json`/`package-lock.json` (production dependency): add it, then `up` |
| The scenario starts the sieve example (CLI output, error "Sieve needs a runId") | an embedded example runs its direct-start block; `build-artifacts.mjs` neutralizes `import.meta.url` in examples for scenarios |
| Container restarts again and again | `logs <service>`; `stop` halts it, `down` removes it |

## 10. Scenario: prime sieve with a simulated phone

`test/testbed/scenarios/sieve-mobile.ts` replays the operating flow of [betrieb-und-mobile-steuerung.en.md](betrieb-und-mobile-steuerung.en.md)
section 6 with a simulated mobile device. It uses the named Space `sieve-a` (doc version 5), durable
request claims (stage 1) and the phi-spaces store (SQLite) on the volume `/data`. Three separate invocations, like a phone that starts a run,
returns later and looks at the result:

| Phase | Command | What happens | What is disturbed meanwhile |
|---|---|---|---|
| **Create** | `scenario sieve-mobile create --fresh` | The phone stores generation and run ID (before it sends anything), the host prepares 8 blocks; a second "double tap" follows | requests and answers are lost; the host aborts after 3 blocks; the phone repeats with the same request ID |
| **Run** | `scenario sieve-mobile run [--host-restart]` | Host workers sieve the blocks, the phone polls the progress, goes to the background, comes back and fetches the result | workers die holding a reserved task (it returns after lease expiry); optionally restart of the host at half progress; lost calls |
| **Evaluation** | `scenario sieve-mobile evaluate` | checks the stored state against an independent reference, writes `report.json`, exit code 0 or 1 | – |
| all | `scenario sieve-mobile all` | create, run, evaluate in sequence | as above |

Checked are: exactly one run entry (double tap and repetitions create no second one), no task left, no
open transaction, exactly one result per block, every block equal to the trial division result, overall result equal to the
reference (168 primes below 1001), and for each sent request exactly one decided claim (run plus one claim per block).
A probe with a deliberately falsified state (duplicate, wrong result) makes the evaluation fail.

Options (excerpt): `--end`, `--block`, `--workers`, `--work-ms` (simulated computing time per block), `--drop` (share of disturbed
calls, default 0.3), `--offline-ms`, `--crash-workers`, `--lease-ms`, `--crash-create`, `--host-restart`, `--seed`. All
options: `scenario sieve-mobile help`. The state lives in `/data/sieve-mobile` and survives `kill` and `down`; `--fresh`
discards it.

On the server the compiled version runs against the shipped bundle each time. Example with a crash of the container
between the phases:

```sh
npm run testbed -- scenario sieve-mobile create --fresh
npm run testbed -- kill runner                      # Container stirbt, das Volume bleibt
npm run testbed -- scenario sieve-mobile run --host-restart --drop 0.4 --workers 3
npm run testbed -- scenario sieve-mobile evaluate   # Exit-Code 0 = bestanden
```

**What the scenario does not depict:** a real phone, radio network or NetBird (the connection is a random model at call level),
several hosts (everything runs in one container and one process; a host "restart" ends the workers and reopens the
storage, but is no crash in the middle of a commit) and pausing through a RunGate (the scenario does not use it; the RunGate is implemented, see operations section 6). The
preparation of the tasks is not protected against premature processing (operations section 6, `preparing`). As a
regression test a small version of the TypeScript source runs locally in `npm test` (`test/test-scenario.test.ts`); on the server
the compiled version runs (`scenarios/sieve-mobile.mjs`).

## 11. TUI and read-only Space inspection

`npm run tui` offers Space/object view, container actions, test start and evaluations.
`npm run testbed -- inspect runner` reads confirmed data of the phi-spaces stores (SQLite) and scenario reports in the running container;
`start <service>` starts an existing stopped container without build or shipping.
The inspector is delivered as `tools/inspect.mjs`. With an existing old Dockerfile, run `init --force` first,
then `up core`. Operation, approvals, snapshot limits and locked planned functions: [tui.en.md](tui.en.md).

## 12. NetBird (gate 5, work package 1b.1)

The NetBird management server runs on `big` as a Compose project of its own (`spacebird`) in the directory `<dir>/netbird`, separate from the
Spaces test bed: `down` and `destroy` of the test bed do not touch it. Set up following NetBird's own `getting-started.sh`
(v0.80) for an external reverse proxy: one combined server container (management, signal, relay, STUN) and the
dashboard, both published only on `127.0.0.1` (default 18081 and 18080). The built-in Dex serves as identity provider.
Host: `spacebird.eibrain.org` (points to big, `TESTBED_NETBIRD_DOMAIN`).

**Finding (2026-10-08, read-only):** `/dev/net/tun` is readable and writable for everyone; ports from 1024 up can be bound freely
(`ip_unprivileged_port_start = 1024`); nginx occupies 80/443; `mux` has no sudo, nginx and certificate must be set up by
the server administration.

```sh
npm run testbed -- --dry-run netbird up      # zeigt, was geschehen würde
npm run testbed -- netbird up                # schreibt Compose/Konfiguration (Schlüssel neu, Modus 600), zieht Images, startet
npm run testbed -- netbird nginx bootstrap   # nur Port 80, damit certbot das Zertifikat holen kann
npm run testbed -- netbird nginx             # die vollständige Site
npm run testbed -- netbird status            # Container, Image-Stand, Erreichbarkeit über https
```

nginx and certificate (as root on big; the script never does this itself):

1. Output of `netbird nginx bootstrap` to `/etc/nginx/sites-available/spacebird.eibrain.org`, link to `sites-enabled`,
   `nginx -t && systemctl reload nginx`.
2. `certbot certonly --webroot -w /var/www/html -d spacebird.eibrain.org`.
3. Replace the same file by the output of `netbird nginx`, `nginx -t && systemctl reload nginx`.

**STUN (UDP 3478)** is published only on loopback by default: peers on the same host do not need it. For peers outside
(e.g. a real phone) set `TESTBED_NETBIRD_STUN_BIND=0.0.0.0` and open UDP 3478 in the firewall; nginx cannot forward
UDP.

**Pin the version:** `TESTBED_NETBIRD_VERSION` (server) is set to 0.80.0; the dashboard has its own versioning (`TESTBED_NETBIRD_DASHBOARD_VERSION`, default `latest`, the digest is in `netbird status`). For the evidence for gate 5,
enter `netbird status` (image digest) in section 4.6 of the federation plan. The Linux agents (sidecar with `NET_ADMIN` and `/dev/net/tun`,
shared network namespace) and the test matrix 4.6 follow as soon as the server is reachable; the userspace WireGuard mode was not needed under
rootless Docker (kernel WireGuard, see result below).

### Setting up groups, setup keys and policies

Prerequisite: a service user (role Network Admin) in the dashboard and its token in `<dir>/netbird/secrets.env` on the server
(`NB_PAT=<token>`, mode 600). The token never leaves the server and is not printed.

```sh
npm run testbed -- --dry-run netbird setup
npm run testbed -- netbird setup                 # idempotent; --rotate-keys erzeugt neue Setup-Keys
```

The script (`test/testbed/netbird/setup.sh`, runs on the server) creates the groups from federation plan 4.1 (`space-hosts`,
`space-admin`, `space-observer`), two reusable setup keys (`testbed-hosts` joins `space-hosts`, `testbed-admin` joins
`space-admin`; 30 days; the value is shown only at creation and afterwards is in `secrets.env` as `NB_KEY_HOSTS` / `NB_KEY_ADMIN`) and two policies: `space-port` (hosts, admins and observers → hosts, TCP only on `TESTBED_NETBIRD_SPACE_PORT`, a
placeholder 7421 until the space-gate exists) and `space-admin-ssh` (admins → hosts, TCP 22). Finally it lists all policies and
the peers with ID, overlay address and groups (evidence for gate 5).

**The default policy "Default" allows every peer everything.** As long as it is active, the group rules have no effect. The script does not switch
it off on its own (otherwise an error could lock you out); after the first run and the joining of the test peers, switch it off in the dashboard
under Access Control → Policies and run test matrix 4.6 on it. The logic of the script is checked against a mock API,
not against the real server: fields of the NetBird API may deviate.

### Agent peers (profile `overlay`)

Four agent containers (`nb-host-a`, `nb-host-b`, `nb-member-1`, `nb-member-2`, image `netbirdio/netbird:0.80.0`) join the overlay with the
setup key `testbed-hosts` and appear in the dashboard as `host-a`, `host-b`, `member-1`, `member-2` in the group `space-hosts`.
The key is in `<dir>/netbird/peer-hosts.env` (mode 600; only `NB_SETUP_KEY` and `NB_MANAGEMENT_URL`, never the API token); `netbird setup`
writes the file. The agents need `/dev/net/tun` and `NET_ADMIN` and therefore do not run in the hardened profile of the Node containers.
The host containers of the profile `federation` run in the network namespace of their agent (`network_mode: service:nb-<host>`);
`wt0` is their only way to the others.

```sh
npm run testbed -- init --force          # neue Compose-Vorlage auf den Server (ändert nichts an laufenden Containern)
npm run testbed -- netbird setup         # schreibt peer-hosts.env (idempotent)
npm run testbed -- --dry-run up overlay
npm run testbed -- up overlay            # startet nur die vier Agenten
npm run testbed -- logs nb-host-a        # Verbindungsaufbau, WireGuard-Modus
```

## Evidence: TUI on big (2026-10-08)

The new inspector Dockerfile has been shipped. `npm run tui -- --action test-all --allow-remote`
passed smoke, five examples and the sieve scenario. The interactive TUI reads Spaces/objects and
reports from the runner. Stop/start has now been checked as well; Space objects and report were preserved.
The hardened runner keeps running. Full scope and log locations: [tui.en.md](tui.en.md#server-evidence-of-2026-10-08).

**Result of the first run (2026-10-08):** All four agents connect to the management, signal and relay of `spacebird.eibrain.org`
and receive overlay addresses from 100.89.0.0/16. The agent also runs under rootless Docker with **kernel WireGuard** (`Interface type:
Kernel`, device `wt0`); the feared userspace mode was not necessary. Connections are established lazily: `Peers count 0/4` until
traffic flows; then P2P over the Docker bridge (ping `nb-host-a` → `nb-host-b`, 0 % loss, 2–22 ms). Open warning in the log:
`src_valid_mark` cannot be set in the container (`/proc/sys` read-only); this affects only routing over foreign networks, not
the overlay. Not yet checked: the effect of the policies as long as the policy "Default" is active, the group assignment of the phone and the
behavior when a peer is removed from the group (test matrix 4.6).

**Effect of the policies (2026-10-08, "Default" switched off):** From `host-a` to `host-b`, both in `space-hosts`: TCP 7421 open; TCP 8080 and
TCP 22 as well as ICMP blocked. This corresponds to the policies `space-port` (only 7421) and `space-admin-ssh` (admin devices only; hosts among each other
may not use SSH). Measured with `nc -w 4` against test listeners in `nb-host-b`. Open from test matrix 4.6: group change and removal of a peer
during operation, behavior of the phone (`space-admin`) and the peer ID query through the management API with the service user.

**Removing a peer from the group (2026-10-08):** `member-2` was removed from `space-hosts` in the dashboard. Afterwards: `host-a` → `member-2`
and `member-2` → `host-a` blocked on TCP 7421 (previously allowed through the group), `member-2` sees no other peer any more (`Peers count 0/0`),
`host-a` no longer lists `member-2` in the peer list; `host-a` → `host-b` stays open. The change arrived without restarting the agents. The
phone `a34xeea` (`space-admin`) appears in the peer list of the hosts (status Idle, connection is established on traffic). Not measured: how quickly
the change arrives (here a few seconds to minutes after removal; time not recorded).

## 16. Pairing (4.5)

`src/enroll.ts` brings a device's app key into the control Space without a plaintext token landing anywhere.

- **Admin side:** `newEnrollToken()` generates 256 bits locally, `hashToken()` forms SHA-256; only the hash goes into `createEnroll` (idempotent, at most 5 min lifetime, roles `host`, `member`, `observer`)
  or `bootstrapEnroll` (the only way to an admin role, bound to the peer ID of the first admin device). The QR content (`enrollQr`) carries endpoint, control Space ID and token and is never logged.
- **Device:** A peer in the group `space-enroll` has only the role `unpaired` at the gate (methods `hello` and `generation`, plus `enroll` and `enrollStatus` in the `EnrollmentService`). With `RemoteSpace.enroll(token)` on the
  control Space (`space: "control"`) it fetches the challenge, signs it with the **new** key and sends `enroll`. The token exists only in the handler's volatile memory and is hashed immediately.
- **Order of checks (as in 4.5):** token with this hash present (otherwise only the per-peer limit) → bound peer ID (a foreign peer does not burn a token) → expiry and attempt counter →
  signature and key format (only an error here increases `attempts`; three errors invalidate the token). On success, token consumption, `PeerKey` and the result claim happen in **one** commit.
  A retry with the same request identity (new challenge, new signature) is answered from the claim, even if the token has long been consumed. At most one attempt per peer and minute.
  Every rejection has the same response; a rejected device learns nothing about tokens.
- **Bootstrap:** The locally provided supervisor creates the first admin's token once; a lost, still unused token is replaced (the old hash becomes invalid); with the first
  consumption the authority is closed forever (`BootstrapClosed`).
- **Keys:** `SpaceKeyDirectory` reads the `PeerKey` entries of the control Space as the directory for layer B; `revokePeerKey` revokes, the gate disconnects the connections with the key at the next tick.

`test/test-enroll.test.ts` (gate, management replica, test host): bootstrap and repetition, replacement of a lost token, host token and role limitation, no plaintext token in the control Space, in claims and events,
the order of checks, rate limiting, expiry, uniform rejection, unpaired peers only, `enrollStatus` only for one's own request, revocation of a paired key.
Not yet: the supervisor as a process that handles `createEnroll` from a command of a paired admin (5.1), key rotation (`rotateKey`) and the run on real devices. Since implemented: the handling of `createEnroll` in the supervisor (section 17), `rotateKey` (`src/rotation.ts`) and pairing on real devices ([implementation status](implementierungsstand.en.md)).

## 17. Supervisor of the control Space (5, 5.1)

`src/supervisor.ts` is the only writer of the control Space apart from the admins' `Command` entries. First part, the commands without router:

- `createEnroll` → an `Enroll` entry (only the hash of the token reaches the supervisor); roles `host`, `member`, `observer`.
- `revokePeer` → all active `PeerKey`s of the peer become `revoked`; the gate disconnects the connections that proved this key at the next tick (15 s).

Each command is **one commit**: the `Command` is taken, the effect applied and the `Result {commandId, kind, state, error?, result?, requestedBy, at}` written (kept for 7 days). A crash
leaves either the command or its result; a repeated `commandId` never takes effect twice (the second command is discarded without a new result). Invalid arguments and unknown commands become
`failed` results, nothing is applied partially. The writer of a command (the owner of the entry) must have an **active admin key** in the control Space at processing time, i.e. a paired admin,
not "whoever is on this host"; an admin who revokes themselves thereby immediately loses their authority.

`ControlAccess` is the network side: on the control Space only admins with a proven key may write `Command`s over the wire and read `Command`, `Result` and `PeerKey`; `Enroll` (token hashes) and
`Bootstrap` never leave the host, `take`, `stats`, `changes` and `txn` do not exist there, everyone else (member, admin group without proof, unpaired peers) is excluded. The pairing paths (`hello`, `generation`,
`challenge`, `prove`, `enroll`, `enrollStatus`) are unaffected. Order of the layers: gate → `EnrollmentService` → `ControlAccess` → `ProvingService` → `SpaceService`.

`test/test-supervisor.test.ts`: flow command → supervisor → result → `enroll` → `revokePeer` through the gate; idempotence; failed commands; only admins with proof; writer without admin key and the self-revocation; an error
before the commit leaves the command, the repetition yields exactly one result and one effect (JSONL and SQLite).
Not yet: `rotateKey` (requires the device's proof of both keys), the router journal and the router commands (`setLimits`, `addMember`, ...), `restoreDataSpace`/`releaseRestored`, execution as a process of its own on big. Since implemented: `rotateKey`, router journal and commands, `restoreDataSpace`/`releaseRestored` and operation on big ([implementation status](implementierungsstand.en.md)).

## 18. Test server nanoi (phase 3, test primary and fencing target)

Status 2026-10-16. `nanoi` is a netcup KVM server of its own (Debian 13, 4 cores, 7.8 GB RAM, 157 GB), reachable
only from big (`ssh nanoi` with a key stored there, user root). It is reserved for tests in which a host may actually be switched off: test primary for primary/sync, `setStandby` and promotion; vpsc is
the backup/register host, big does not become a fencing target because of its other services.

| Area | Setup |
|---|---|
| Network | **IPv6 only** (netcup image without IPv4). `spacebird.eibrain.org` has had the AAAA record `2a0a:4cc0:c0:62f2:8000::1000` since 2026-10-16 (big, nginx on `[::]:443`). nanoi resolves it through the netcup resolver; the temporary `/etc/hosts` entry has been removed. |
| NetBird | client 0.80.0 from the signed repository `pkgs.netbird.io`, pinned to the server version (`apt-mark hold`); peer `nano-test`, 100.89.28.88, group `space-hosts` through the existing setup key `testbed-hosts` (passed on directly from big, never printed). Connections to IPv4 peers run through the relay. |
| Firewall | `pi-nft-host.service` loads `/etc/nftables-pi-host.nft`: inbound only SSH, ICMP/ICMPv6, WireGuard (UDP 51820) and everything over `wt0`; outbound free. Applied with a dead man's switch during setup and checked by a new SSH connection. |
| Runtime | Debian `docker.io`; image `phi-spaces-test-node:local` transferred from big (Node v22.23.3, production dependencies). Directories `/opt/phi-spaces/artifacts` and `/var/lib/phi-spaces` (0700). As on big, only built artifacts are shipped. |
| Time | systemd-timesyncd active, synchronized (prerequisite for the HLC clock check). |

| Federation member | Container `phi-spaces-nano` (user `node`, read-only, no capabilities, 2 CPU/2 GiB, host network) with data in `/var/lib/phi-spaces/nano` (`/data/nano`); separately bundled daemon `federation-host.mjs` from `test/testbed/federation-host.ts`; service `phi-spaces-nano.service`. Host `nano-test`, member of control `phase1b-host-a`, gate `100.89.28.88:7421`, own Ed25519 host key (`keyId b37f6846…`, since 2026-10-18) enrolled at the control supervisor as `host`. |
| Register | own reader certificate `CN=phi-spaces-register-reader-nano` from the operator CA `phi-spaces-recovery-ca` (fingerprint `ce6431f5…`, no operator right), access over IPv6 to `2a02:c207:2252:8263:8000::`:17422 with `serverName: phi-spaces-register`; external `boot:nano-test` (version 1) written by operator CAS |
| NetBird queries | read-only management token as for member-1 (`management-token`, 0600) |

Checked: restart of nanoi, afterwards firewall, Docker, NetBird and `phi-spaces-nano` active and `ready`; an admin
(`lux27`) authenticates over the overlay at nanoi's gate (key looked up through the control host)
and reads its data Space.

Initial setup of the enrollment: nanoi was in `space-hosts` when it joined and therefore counted as paired; the gate
then demands a key proof and rejects the initial pairing. `nano-test` was therefore moved to `space-enroll` only for the enrollment,
with a temporary group of its own (only `host-a`) and policy for TCP 7421; afterwards
back to `space-hosts`, own group/policy deleted. For future hosts this is the procedure as long as no
permanent enrollment policy exists.

Changes on vpsc for IPv6 clients: the register TLS service listens on `::` (dual-stack, IPv4 clients
checked unchanged), `tls.json` releases the fingerprint of nanoi (backup `tls.json.before-nano-20261016`);
ufw additionally allows 17422 only from nanoi. vpsc had no working IPv6 default route: `fe80::1` from the
netplan configuration does not answer, the router identifies itself as `fe80::2dc:ff:fe00:2`. This route is set at
runtime and added to netplan (backup `50-cloud-init.yaml.bak.20261016-ipv6gw`, only `netplan generate`,
no re-apply); from outside only `…8263:8000::` is reachable, not `…8263::1`.

Fencing: the netcup SCP access (offline refresh token) and the fencing service are on vpsc, not on nanoi.
Details in [ap3-replica-control.md](_attic/abnahme/ap3-replica-control.en.md#netcup-adapter). nanoi is server 964249 with
MAC `2a:38:5f:38:de:22`; only this server is in the list of targets. A real shutdown run passed on 2026-10-16
([evidence](../test/evidence/f1-netcup-2026-10-16/README.en.md)).

After a hard power-off, `/var/lib/phi-spaces/nano/owner.lock` remains, and `phi-spaces-nano` does not start
by itself. Procedure:

1. Check that the recorded PID no longer exists in the container.
2. Only then delete the lock.
3. Run `systemctl start phi-spaces-nano`.

## 19. Test standby 100 (phase 3, fixed synchronous standby for nanoi)

Status 2026-10-16. Host `100` is a physical server in the home network: 192.168.1.100, Ubuntu 26.04, 8 cores, 31 GB RAM.
It also serves as an NFS server on the LAN. Access through `ssh 100` (user `virtual`) or `ssh 100i` (root). To the
outside it goes only over IPv4, with the same public address as lux27 (`212.186.197.226`).

| Area | Setup |
|---|---|
| Role | Fixed standby for nanoi as primary. Promotion to 100 after netcup fencing of nanoi is possible. `degradeToSingle` on nanoi remains blocked because there is no fencing adapter for 100 (no power API). |
| NetBird | client 0.80.0 from `pkgs.netbird.io` (key taken over from nanoi), `apt-mark hold`. On 100 there was an older configuration for netbird.io that briefly became active again after the installation. It is kept as the inactive profile `default`; the new profile `spacebird` is active, with peer `standby-100`, 100.89.187.150, group `space-hosts`, peer ID `db96lcflh8lg008bddjg`. Backup of the previous state: `/root/netbird-state.before-spacebird-20261016`. The connection to nanoi (IPv6 only) runs through the relay. |
| Firewall | `pi-nft-host.service` with `/etc/nftables-pi-host.nft`, policy `accept`, so that LAN services (NFS, SSH) stay unchanged. Over `wt0` only new connections on TCP 7421 are accepted; 7421 is blocked outside the overlay. |
| Runtime | Docker, image `phi-spaces-test-node:local` from big; daemon artifact identical to nanoi. Container `phi-spaces-standby` (read-only, no capabilities, 2 CPU/2 GiB, host network), data in `/var/lib/phi-spaces/standby`; service `phi-spaces-standby.service`. |
| Federation member | Host `standby-100`, member of control `phase1b-host-a`, gate `100.89.187.150:7421`, own Ed25519 key (`keyId 29728525…`, since 2026-10-18), enrolled as `host`. Procedure as for nanoi: temporary group `standby-enroll-20261016` with policy, deleted afterwards. |
| Register | Reader certificate `CN=phi-spaces-register-reader-standby-100` (fingerprint `d7f89b33…`, key generated on 100), access over `207.180.233.218:17422`. `tls.json` on vpsc extended (backup `tls.json.before-standby-100-20261016`). `boot:standby-100` (version 1) by operator CAS. No new ufw rule needed: the address is already released for the operator, separation is by the certificate. |
| NetBird queries | read-only management token as for nanoi |

Checked:

- An admin (lux27) reads the data Space of `standby-100` over the overlay.
- nanoi reaches `standby-100:7421` through the relay.
- After a restart of 100, firewall, NetBird (profile `spacebird`), Docker, NFS and `phi-spaces-standby`
  came back by themselves. The service was `ready` afterwards, and the admin read worked again.

## 20. Rebuild under phi-spaces (2026-10-18)

The federation on big, vpsc, nanoi and 100 ran under the old names until 2026-10-18. Its data could not be taken over
by the new version (document type namespace, signature domains, SSH commands; the phase 3 stores were
replicated, see [name changeover](namensumstellung-2026-10-18.en.md)). It was therefore stopped, backed up and
set up fresh under the new names; the old data has been removed.

| Area | Status |
|---|---|
| Artifacts | pinned to commit `0d17ca9` (clean worktree); bundle hash `d20f60d4…`, daemon `federation-host.mjs` in image `8a6e8e73…`, separately bundled daemon for nanoi/100 `dabaaede…` |
| PKI | new CA `CN=phi-spaces-recovery-ca` (EC P-256); register server `CN=phi-spaces-register-server` (SAN `207.180.233.218`, `2a02:c207:2252:8263:8000::`, `phi-spaces-register`), fencing server `CN=phi-spaces-fencing-server`, operator, reader (big), reader nano, reader standby-100 (key on 100). Replica-control certificates were not reissued (not released, unused). CA and operator are stored locally under `~/.local/share/phi-spaces-ops/pki` |
| vpsc | `phi-spaces-recovery-register(-tls).service`, `phi-spaces-fencing.service` under `~/.local/share/phi-spaces-{recovery,fencing}`; fresh register database; netcup token and fence state moved (not copied) to `~/.config/phi-spaces-fencing` and `state/` respectively |
| NetBird | stack `spacebird` unchanged, directory now `/media/docker/phi-spaces/netbird`; test bed peers new (host-a `100.89.103.95`, member-1 `100.89.136.73`, host-b `100.89.90.236`, member-2 `100.89.226.1`), old test bed peers deleted |
| Federation | authority `a-ddb275ab…`, control Space `sp-be8af63f…` on `phase1b-host-a` (with recovery socket and recovery admin pin); members `phase1b-member-1`, `nano-test`, `standby-100` enrolled as `host`; admin `lux27` newly paired (`keyId b3004c21…`). New recovery operator key `de22259f…` |
| big | units `phi-spaces-phase1b-{host-a,member-1}.service` active, the three restore acceptance units renamed and deactivated; forced commands under `~/.local/share/phi-spaces-operations`; local SSH aliases `phi-spaces-*` |
| Phone | `xi` (Xiaomi M2007J17G) with newly built debug APK (bundle `d20f60d4…`); new Keystore key `c5c68f25…` (alias `phi-spaces/…`) paired as `member` with scope `jobs`, data host `phase1b-member-1`; object access over the overlay checked. The old profile is on the device as `space-profile.legacy-20261018.json`, the old Keystore entry remains unused |
| not rebuilt | the main store of host-a as primary/sync (`main-sync`, last `single` with a peer that no longer exists) |

Checked: all four services `ready` and `ready` again after restart; the admin reads over the overlay the data Space
`jobs` of member-1, nano-test and standby-100 and the control Space (four PeerKeys); nanoi reaches
`standby-100:7421`; F15 status through `phi-spaces-fence-host-a`/`-member-1` and the SSH register reader respond;
the fencing service renews the netcup token under the new path.

The backups of the old data (`~/legacy-backup-20261018` on big, vpsc and locally,
`/root/backup/legacy-backup-20261018` on nanoi and 100) were deleted on 2026-10-19 after the acceptance.
The help site runs from the checkout `/media/docker/spaces` (`npm run docker:prod:down` / `docker:prod:up` in the
directory `help-site`); the earlier release directories `/media/docker/phi-spaces-release-*` have been removed.
