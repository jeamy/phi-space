# Operation with Docker

Built like `codemode-chat/docker/` (see `docs/codemode-space-architektur.en.md` in the root): one image, one container per
role, all talk only via the Space and TCP. Files: `spaces-mmo/docker/Dockerfile`, `docker-compose.yml`,
`docker-compose.hostnet.yml`; the scripts are in `spaces-mmo/package.json` (`docker:*`).

## Profiles

| Profile | Containers | Where |
| --- | --- | --- |
| `nano` | `space`: the accounts Space (credentials, web sessions) as SQLite in the volume `mmo-space-data` | nano |
| `big` | the world in its four regions ([Regionen](#regions)): per region `space-<region>`, `world-<region>` (executes the commands), `npc-<region>`, `model-<region>` (translates free sentences into commands); plus `web` | big |
| `dev` | `mmo-dev` (all roles in one container, sources mounted) | local |
| `test` | `mmo-test` (the test suite) | anywhere |
| nano + big | both on one machine | local test setup |

Until 2026-10-28 the world ran as one Space (profiles `nano` with `world-nano`, `big` with `world-big`, `npc`, `model`,
plus `single`, `regions` and `accounts` as scripts); these containers no longer exist. `docker:nano:up` and
`docker:big:up` remove left-over containers of the old split (`--remove-orphans`).

**Model access:** Like codemode-chat and the help system, `npc` and `model` read the login of the pi CLI of the host:
`${PI_AUTH_DIR:-$HOME/.pi/agent}` is mounted read-only to `/home/node/.pi/agent` (alternatively API keys such as
`ANTHROPIC_API_KEY` in `.env`). Model calls cost tokens and run only with `SPACES_MMO_LLM=1` in `.env`; without it the
model NPCs stay with their scripts and free sentences with the free rules. The message `[llm] no models` means: neither
key nor pi login in the container.

On big, Docker runs rootless: there the mounted `~/.pi/agent` belongs to root in the container, and the user `node`
cannot read `auth.json` (likewise `[llm] no models`). Like codemode-chat and the help system, spaces-mmo uses a copy there
that the container user `node` owns (on the host uid 100999), and sets `PI_AUTH_DIR=/home/mux/.pi/agent-node` in
`spaces-mmo/.env`. The copy is made (and again after a new pi login) with

```sh
mkdir -p -m 755 ~/.pi/agent-node && cp ~/.pi/agent/auth.json ~/.pi/agent-node/
docker run --rm -v ~/.pi/agent-node:/d node:22-bookworm-slim sh -c 'chown 1000:1000 /d/auth.json && chmod 400 /d/auth.json'
```

Afterwards `npm --prefix spaces-mmo run docker:big:up`; `docker exec phi-spaces-mmo-npc-west-1 cat /home/node/.pi/agent/auth.json
>/dev/null` checks whether `node` can read the file.

## Ports

| Port | Service | Published on |
| --- | --- | --- |
| 3900 | web (browser, WebSocket, `/healthz`) | `HOST_BIND` (default 127.0.0.1), the reverse proxy in front |
| 3950, 3952, 3953, 3954 | the Spaces of the regions West, Nord, Ost, Süd | 127.0.0.1 |
| 3951 | accounts store (credentials, sessions) | `SPACES_MMO_SPACE_BIND` (default 127.0.0.1) |

The Space ports have **no TLS** and treat every connection as a process of the game; the accounts store holds the
credentials. They never belong on a public interface, only on the internal address (LAN/NetBird) or on the loopback
address behind an SSH tunnel. Codemode-chat uses 3700/3800, the help system 3500/3600.

## Testing locally (both roles on this machine)

```
npm --prefix spaces-mmo run docker:local:up     # startet den Konten-Space, die vier Regionen und web (Image vorher: docker:image)
npm --prefix spaces-mmo run docker:local:logs
npm --prefix spaces-mmo run docker:local:down
```

The game is then reachable at <http://127.0.0.1:3910> (web 3910, regions 3960/3962/3963/3964, accounts 3961, so that a
running development instance on 3900 does not interfere; web reaches the Spaces in the Docker network). `NANO_CPUS`
(default 2) limits nano like the smaller machine. The tests in Docker: `npm --prefix spaces-mmo run docker:test`.

The same with the Rust Space server (`phi-space-server --profile mmo`) in the Space containers, as a project of its own
with volumes of its own (`docker/docker-compose.rust.yml`, [rust-portierung.md](../../docs/rust-portierung.en.md)):
`npm --prefix spaces-mmo run docker:image:rust`, then `docker:rust:up|down|logs`. The machines continue to use the
TypeScript server; `docker:nano:up` and `docker:big:up` do not read the file.

## Development (recompiles on every change)

```
npm --prefix spaces-mmo run docker:dev:up       # baut das Dev-Image, startet einen Container mit allen Rollen
npm --prefix spaces-mmo run docker:dev:logs
npm --prefix spaces-mmo run docker:dev:down
```

One container (`mmo-dev`), the sources of the working directory are mounted (`app/`, `client/`, `server/`, `worlds/` and
`src/` of the phi-spaces core). The page is reachable at <http://127.0.0.1:3920> (`SPACES_MMO_DEV_PORT`; 3900 and the 3910
of the local test setup stay free). `app/` and `client/` are recompiled by Next.js in dev mode (Fast Refresh, the page
reloads by itself), and every server process (space, world, npc, web) restarts as soon as `server/`, `worlds/` or the core
changes. The store lies in the volume `mmo-dev-data` and is kept across restarts; `docker volume rm
phi-spaces-mmo_mmo-dev-data` resets the world.

Model calls (model NPCs, translating sentences into commands) cost tokens and are off in the dev container unless it is
started with `SPACES_MMO_LLM=1` (`SPACES_MMO_LLM=1 npm --prefix spaces-mmo run docker:dev:up`, or in the `.env`). The
credentials come from the pi CLI login of the machine (`~/.pi/agent`, mounted read-only; `PI_AUTH_DIR=` switches that
off). The newest available model whose ID contains `SPACES_MMO_LLM_MODEL` is chosen (default `haiku`); the limits are in
`.env.example`.

## Production: nano and big

One machine runs exactly one profile. On both: `git pull --ff-only`, then the script of the machine.

| Machine | Processes | Script | `.env` |
| --- | --- | --- | --- |
| nano | accounts Space (credentials, web sessions) | `docker:nano:up` | `SPACES_MMO_SPACE_BIND=<internal address of nano>` |
| big | the four regions (Space, world worker, NPCs, model per region) and web | `docker:big:up` | `SPACES_MMO_ACCOUNTS=tcp:127.0.0.1:3951`, `SPACES_MMO_WEB_REGIONS` (below), `PI_AUTH_DIR` |

Every region Space needs a fast core; on nano (small VM) one core computed about three times as long as on big
([lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md)). Therefore the world lies on big and only the accounts Space on nano.
vpsc is similarly slow ([messung-vpsc-2026-10-29.en.md](messung-vpsc-2026-10-29.en.md)).
The web on big reaches it via the user unit `mmo-accounts-tunnel` (`deploy/`, only port 3951); login, registration and the
check of a web session go over the network, every command stays next to the Space of its region.
`web` runs in the host network (`docker-compose.hostnet.yml`, only on the loopback address, nginx in front).
`docker:prod:up` is deliberately blocked.

The image is built on the machine itself (`docker build --network host`: on the rootless Docker of nano a build in the
default network does not reach the npm registry). The store is kept in the volume when the containers restart.

## Settings

The `.env` (template `spaces-mmo/.env.example`) is given to all containers as `env_file`; `environment:` in the compose
overrides it for addresses and ports. The first admin account arises with `SPACES_MMO_SETUP_TOKEN` (on registering under
"Einrichtungstoken"). An already existing account becomes admin when it logs in with the token ("Anmelden",
"Einrichtungstoken (macht dieses Konto zum Admin)"). Whoever wants no further admins removes the token afterwards. The
button "Admin" (at the top next to "Abmelden", on the phone in the menu ⋯) opens the window for models and limits. The
image file contains no `.env` (`.dockerignore`).

## When "the generation exceeds maxClaimBytes" appears

Every call of every process leaves a request claim whose result the Space keeps for `claimResultMs` (default of the core:
24 hours). The processes ask several times per second; after about a day `maxClaimBytes` is full, and the Space refuses
new requests (web and model process report the error, the world stands). `server/space-host.ts` therefore sets
`claimResultMs` to **10 minutes** (`SPACES_MMO_CLAIM_RESULT_MS`); a repeated call comes within its retry window (30 s
time limit, three attempts), the exactly-once guarantee stays. An already full volume cleans itself up after the restart
of the Space (about 250 claims per second); the file `world.sqlite` does not shrink in the process. The help system has
the same value (`claimResultMs` 15 minutes).

Related is `generationAdmitMs` (core default 1 hour): The Space keeps the hash of a claim until its generation accepts no
new requests. With results kept for only ten minutes, thousands of expired but still held claims would sit in the Space,
and the sweep of every commit would read them again (measured: 53 % of the CPU of the Space process in the database query
`due`). Both values are therefore equal; the help system also sets them equal.

## Load and latency

Measured with `tests/perf/load.test.ts` (`npm run test:perf`): the Space on SQLite, all NPC roles, several players who run
at the pace of the page (one step per 150 ms, at most eight ahead of the answer), and a proxy that delays the connection
between big and nano (`LOAD_PLAYERS`, `LOAD_SECONDS`, `LOAD_DELAY_MS` per direction, `LOAD_WORLDS=near|far|both` for the
place of the world workers). Measured is the time from the step to its confirmation at the own figure.

Status 2026-10-27, on the development machine (Docker, all players in the same room):

| Case | before | after |
| --- | --- | --- |
| 5 players, no NPCs | median 65 ms, p99 110 ms | median 21 ms, p99 52 ms (3 players) |
| 10 players, all NPCs | 0.3 steps/s answered, median 5–10 s | median 19 ms, p99 206 ms |
| 20 players, all NPCs, ping 10 ms | – | median 38 ms, p99 112 ms |
| 20 players, all NPCs, ping 20 ms | – | median 55 ms, p99 119 ms |
| 20 players, ping 20 ms, world workers on big | – | median 3.2 s |
| 30 players, all NPCs | – | saturated at about 135 steps/s (median 1.8 s) |

What made it slow, and what has changed:

- **Lost room tokens.** A step against an occupied tile was rejected but still confirmed; the token of the room stayed
  taken in the process and was lost with the commit. Every further movement in the room then waited 5 s for it. Occupancy
  now runs via `Spot` entries with `unique` ([evennia-abbildung.en.md](evennia-abbildung.en.md#collision)), without a lock per
  room.
- **Queries every 50 ms.** The Space service looked only every 50 ms at waiting calls (blocking read, `changes`); this
  cost every step twice up to 50 ms. It is now woken at commit (`src/service.ts`, `commitSignal`).
- **One command after the other.** The world worker now serves up to `SPACES_MMO_WORLD_LANES` (16) figures at the same
  time, each in turn, and takes the figures in the order of their oldest command: Whoever types a lot holds one lane.
- **Reading with commit.** `readIfExists(…, NO_WAIT)` is a call with a claim that the Space commits; checks without
  waiting now read as a snapshot (`peek`, `readAll`). A step reads neither account nor command sets nor (for the rooms of
  the world) the room.
- **The change history.** The Space copied and walked the whole history of the change stream at every commit (4 MiB,
  thousands of batches). The core no longer walks it (`src/store/draft.ts`), and spaces-mmo keeps 512 KiB
  (`SPACES_MMO_LOG_BYTES`): at full load a few seconds; a web process that falls further behind reads the world again
  (`[gateway] change stream: …; reading the world again`).
- **The counting of the history.** The core counted one byte too many per operation (the comma before the first of a
  batch); the excess stayed in the counter, after 2.6 million revisions about 2.6 MB. With 512 KiB the counter of the
  production Space lay permanently above the limit, and every commit discarded the whole history; the gateway then read
  the world again in a loop. The counting is now exact, and a counter that has run ahead is recalculated as soon as only
  one batch would be left.
- **Limits of the service.** All processes are one participant towards the Space; its limits (1024 calls per second, 128
  waiting calls, 32 calls per connection) were sized for the whole game.

**Where the world workers run:** One command makes about a dozen calls in a row to the Space. Next to the Space that costs
milliseconds, over the connection between two machines a multiple of the ping per call. Therefore every world worker runs
on the machine of its region Space.

**Limit:** The Space process is one thread. At about 135 steps per second (about 20 players who run without pause) it is
full on the development machine; above that it jams. Further steps would be in the core: an index of entries by type
(every `readAll` walks all entries today) and several operations in one call.

**Status 2026-10-28 (after the load test).** Measured with `tests/perf/space-cost.ts`: the CPU time of the Space process
per player command (50 figures from `live-load.ts`, 45 s, SQLite, all NPCs, development machine). It says how many commands
one core carries; the response time on a fast, non-saturated machine does not say that.

| State | CPU per command | Median |
| --- | --- | --- |
| before | 26.2 ms | 31 ms |
| index by type in the core | 24.3 ms | 31 ms |
| plus `batch` in the world worker | 18.7 ms | 21 ms |
| plus transient messages | 16.0 ms | 21 ms |
| plus less work per commit | 15.0 ms | 20 ms |

- **Index by type.** A read with a type (`readAll`, `count`, pages) goes over the entries of this type, not over all; the
  core holds the list per type for a committed state until a commit changes it.
- **One command, two calls.** The world worker opens the transaction and takes token and command in one `batch`, and at the
  end sends all writes of the command with the commit in a second one (`bufferedTxn` in `server/space.ts`). Only a `write`
  with `unique` (occupying a cell) goes immediately, so that "occupied" comes back right away. `SPACES_MMO_BATCH=0`
  switches it off.
- **Reading from the mirror.** The command worker holds a copy of the world (`Mirror` in `server/space.ts`, from the change
  stream like the web process) and answers the reads of a command without a transaction itself, on its own core; per
  command it asks the Space only for the revision. With 200 figures locally: 1,043 instead of 1,818 calls per second,
  median 125 instead of 445 ms ([lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md), third run). `SPACES_MMO_MIRROR=0`
  switches it off.
- **Messages without an entry.** What appears only on screens goes as a transient write into the change stream and is
  never stored (`msgOptions` in `engine/context.ts`). Entries remain what someone reads later: speech in the room (the NPC
  scripts listen), channels, everything to an NPC. A newly started web process has no look back at other messages for
  that. `SPACES_MMO_MSG_TRANSIENT=0` keeps every one.
- **Less work per commit.** An answer is converted to JSON once (before twice), the size of all entries is counted once per
  committed state (before at every write), the end of a transaction goes over a copy of the list instead of over the draft.
  Waiting commits were already bundled by the store before.

**Keeping the file small.** The Space process gives back the free pages of its files (`OwnStoreHost.compact`): once at the
start before it serves (the first time a `VACUUM` rewrites the file once and switches it to incremental auto-vacuum, at 350
MB a few seconds), afterwards every `SPACES_MMO_COMPACT_MS` (10 minutes, 0 off) between two write batches. Commits in this
time wait briefly. The log says how many pages went back.

**Against floods:** The gateway limits per account (across all open pages together) steps to 8 at once and 10 per second
and typed commands to `SPACES_MMO_CMD_BURST` (20) at once and `SPACES_MMO_CMD_PER_SEC` (5) per second; an account has at
most four pages open, a fifth closes the oldest.

**Diagnosis:** `SPACES_MMO_TRACE=1` (calls per process and method every 10 s), `SPACES_MMO_SLOW_MS=200` (the world worker
reports every command that was answered later than that after typing, with its own run time).

The NPC scripts look at their own pace: merchants and workers every 8 s, a wanderer in absence every 10 s, Ines and awake
wanderers every 3 s. In the dev container NPCs can be selected: `SPACES_MMO_DEV_NPCS=ines,bo npm --prefix spaces-mmo run
docker:dev:up`.

## Regions

The world runs as four Spaces, one per region ([welt-aufteilen.en.md](welt-aufteilen.en.md)): compose profile `big`. Per region
a Space process (`world-<region>.sqlite` in the volume `mmo-space-data`, port on the loopback: West 3950, Nord 3952, Ost
3953, Süd 3954), a world worker, an NPC and a model process; plus the web process in the host network. The accounts Space
stays where it is (nano, via the tunnel on 3951).

`.env` on big for this:

```sh
SPACES_MMO_WEB_REGIONS=west=tcp:127.0.0.1:3950,nord=tcp:127.0.0.1:3952,ost=tcp:127.0.0.1:3953,sued=tcp:127.0.0.1:3954
```

Moving a world that ran as one Space (once, done on big on 2026-10-28; the old file stays). Stop the old world beforehand
(the containers of the old split):

```sh
cp …/world.sqlite …/world.sqlite.before-regions                     # Sicherung im Volume
docker compose … --profile big up -d space-west space-nord space-ost space-sued
# das Volume mit world.sqlite einhängen: ohne verweigert das Skript (die Datei fehlt), statt nichts zu verschieben
docker compose … --profile big run --rm --no-deps -v mmo-space-data:/data -e SPACES_MMO_DATA=/data \
  -e SPACES_MMO_REGIONS=west=tcp:space-west:3950,nord=tcp:space-nord:3950,ost=tcp:space-ost:3950,sued=tcp:space-sued:3950 \
  world-west node --experimental-strip-types server/migrate-regions.ts
npm --prefix spaces-mmo run docker:big:up                          # Welt-Worker, NPCs, Modelle, Web
```

The script names beforehand what the old world holds, and afterwards per region what it has written. Afterwards count
again across all four regions together: figures and coins as before plus those of the NPCs that the new world version
brings along; any other number means that something is missing or doubled.

`world.sqlite.before-regions` stays in the volume as the state before the move; a way back to one Space no longer exists
in the scripts.

## Load test against the running world

`tests/perf/live-load.ts` lets `LOAD_BOTS` guest figures (default 100) play for `LOAD_SECONDS` (default 600) through the
web process, as pages do: guest login via HTTP, commands via the game socket. They pick up driftwood and shells, carry the
wood to the fire and add wood, sell shells to Kalle, look at the market and go through the exits, with 1 to 3 s pause
between two commands. Each command is measured from sending to the first answer for the figure (own position, own
output, error, next room), in `LOAD_OUT/commands.jsonl`. The figures never speak freely (no sentence for the model); model
NPCs can however wake up when they enter a room (daily budget). Every figure sends its own `x-forwarded-for` from
198.18.0.0/15, otherwise the guest quota per address stops it; this works only via the loopback port (peer 127.0.0.1), not
from outside.

```sh
# auf big, neben dem Web-Prozess (Node ohne node_modules genügt)
cd /media/docker/spaces/spaces-mmo && LOAD_OUT=/tmp/mmo-load node tests/perf/live-load.ts
# danach: die Figuren entfernen (Münzen zurück an Kalle, Gastkonten weg, den Rest räumt die Welt selbst)
docker cp tests/perf/live-load-cleanup.ts phi-spaces-mmo-web-1:/opt/phi-spaces/spaces-mmo/live-load-cleanup.ts
# (nicht nach /tmp im Container: das ist ein tmpfs, docker cp landet darunter)
docker cp /tmp/mmo-load/bots.json phi-spaces-mmo-web-1:/opt/phi-spaces/spaces-mmo/load-bots.json
docker exec -w /opt/phi-spaces/spaces-mmo phi-spaces-mmo-web-1 node --experimental-strip-types live-load-cleanup.ts load-bots.json
docker exec phi-spaces-mmo-web-1 rm -f /opt/phi-spaces/spaces-mmo/live-load-cleanup.ts /opt/phi-spaces/spaces-mmo/load-bots.json
```

Result of a run with 100 figures: [lasttest-2026-10-28.en.md](lasttest-2026-10-28.en.md). The cost per command without a server:
`LOAD_BOTS=50 LOAD_SECONDS=60 node --no-warnings --experimental-strip-types --import ./tests/test-env.ts
tests/perf/space-cost.ts` (a stack as on the servers, one JSON line with CPU ms of the Space process per command).

## Not included

- No backup script like `docker:backup` in the chat; the store lies in the volume, the backup of the directory is taken
  over by the operator until a backup command is planned.
